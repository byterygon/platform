//! Browser sessions: signed in through OIDC ([`SignInSessions`], DOC-25 §3.2) when `[auth.oidc]`
//! is configured, else the local browser session of v0.1 ([`LocalSessions`]), until built-in
//! accounts replace it (TSK-142). [`ServerSessions`] is whichever the server runs.
//!
//! # The local browser session (Mightyconsole spec §2.3, "Session"; Open question 1)
//!
//! v0.1 has no login (DOC-20 decision 5). `ambidex-axum` is unchanged: it still checks the Host
//! allowlist on every request, the exact Origin on the upgrade, a `__Host-` session cookie that
//! this store resolves, and the anti-CSRF token in Hello. This store stands in for login:
//!
//! - `GET /` through an allowed Host gives the browser a session: a random cookie (`Secure`,
//!   `HttpOnly`, `SameSite=Strict`, `Path=/`) and a random anti-CSRF token, which the page
//!   receives in a `<meta>` and echoes in Hello. A browser that already holds a live cookie
//!   keeps it, so every tab of the browser reads the same token and a tab that reconnects after
//!   another tab loaded still passes the CSRF check.
//! - Every upgrade ([`WebSessions::lookup`]) gets an Ambidex session of its own: the browser
//!   session's id plus a random suffix. Live handles belong to that session (spec §2.2), so a
//!   second tab, or a tab after a reconnect, cannot use another connection's `connId`.
//! - The principal is always [`local_principal`], built here, never from client input.
//!
//! Sessions live in memory: a server restart means a reload. At most [`MAX_BROWSER_SESSIONS`]
//! browser sessions are kept; the oldest is forgotten first. A cross-site page cannot use a
//! session: the upgrade needs the exact Origin, and the cookie is `SameSite=Strict`.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Mutex, MutexGuard};

use std::sync::Arc;

use ambidex::engine::BoxFuture;
use ambidex::{CancellationToken, Session};
use ambidex_axum::oidc::{
    AuthEvent, OidcIdentity, OidcLogin, SignInHooks, SignInRefusal, SignedIn,
};
use ambidex_axum::{
    EndReason, EndedSession, LoginSessions, SessionEvents, WebSession, WebSessions,
};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};

use crate::audit::{Event, EventLog, LineWriter};

use crate::authz::LOCAL_TENANT;
use crate::core::random_id;

/// Browser sessions kept in memory.
pub const MAX_BROWSER_SESSIONS: usize = 64;

/// The one principal of v0.1: `human:local:<os-user>`.
pub fn local_principal() -> Principal {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .ok()
        .filter(|u| !u.is_empty() && u.bytes().all(|b| b.is_ascii_graphic() && b != b':'))
        .unwrap_or_else(|| "user".to_owned());
    Principal {
        kind: PrincipalKind::Human,
        id: format!("human:local:{user}"),
        tenant: TenantId::new(LOCAL_TENANT),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("set per connection"),
    }
}

struct BrowserSession {
    id: String,
    csrf_token: String,
    /// Order of creation, for eviction.
    serial: u64,
}

#[derive(Default)]
struct Inner {
    by_cookie: HashMap<String, BrowserSession>,
    next_serial: u64,
}

/// See the [module docs](self).
pub struct LocalSessions {
    principal: Principal,
    inner: Mutex<Inner>,
}

/// A browser session as `GET /` hands it out.
#[derive(Clone, PartialEq, Eq)]
pub struct BrowserCredentials {
    pub cookie: String,
    pub csrf_token: String,
    /// `false` when the request's cookie was reused.
    pub new: bool,
}

impl fmt::Debug for BrowserCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BrowserCredentials")
            .field("new", &self.new)
            .finish_non_exhaustive()
    }
}

impl LocalSessions {
    pub fn new(principal: Principal) -> LocalSessions {
        LocalSessions {
            principal,
            inner: Mutex::default(),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The session for a page load: the one `cookie` names if it is live, otherwise a new one.
    pub fn for_page(&self, cookie: Option<&str>) -> BrowserCredentials {
        let mut inner = self.lock();
        if let Some(cookie) = cookie
            && let Some(existing) = inner.by_cookie.get(cookie)
        {
            return BrowserCredentials {
                cookie: cookie.to_owned(),
                csrf_token: existing.csrf_token.clone(),
                new: false,
            };
        }
        if inner.by_cookie.len() >= MAX_BROWSER_SESSIONS
            && let Some(oldest) = inner
                .by_cookie
                .iter()
                .min_by_key(|(_, s)| s.serial)
                .map(|(c, _)| c.clone())
        {
            inner.by_cookie.remove(&oldest);
        }
        let cookie = token();
        let csrf_token = token();
        let serial = inner.next_serial;
        inner.next_serial += 1;
        inner.by_cookie.insert(
            cookie.clone(),
            BrowserSession {
                id: random_id(),
                csrf_token: csrf_token.clone(),
                serial,
            },
        );
        BrowserCredentials {
            cookie,
            csrf_token,
            new: true,
        }
    }

    /// How many browser sessions are live.
    pub fn len(&self) -> usize {
        self.lock().by_cookie.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl WebSessions for LocalSessions {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        let found = self.lock().by_cookie.get(cookie).map(|browser| {
            let id = format!("{}.{}", browser.id, random_id());
            let mut principal = self.principal.clone();
            principal.session = SessionId::new(id.clone());
            WebSession {
                session: Session { id, principal },
                csrf_token: browser.csrf_token.clone(),
            }
        });
        Box::pin(async move { found })
    }
}

/// The sessions the server runs.
#[derive(Clone)]
pub enum ServerSessions {
    /// No login configured: v0.1's one local user.
    Local(Arc<LocalSessions>),
    /// Signed in through OIDC.
    SignIn(SignInSessions),
}

/// The OIDC sign-in and the sessions it makes.
#[derive(Clone)]
pub struct SignInSessions {
    pub sessions: Arc<LoginSessions>,
    pub login: OidcLogin<Arc<McSignIn>>,
}

impl WebSessions for ServerSessions {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        match self {
            ServerSessions::Local(local) => local.lookup(cookie),
            ServerSessions::SignIn(signed) => signed.sessions.lookup(cookie),
        }
    }

    fn revocation(&self, session: &Session) -> Option<CancellationToken> {
        match self {
            ServerSessions::Local(local) => local.revocation(session),
            ServerSessions::SignIn(signed) => signed.sessions.revocation(session),
        }
    }

    fn touch(&self, session: &Session) {
        match self {
            ServerSessions::Local(local) => local.touch(session),
            ServerSessions::SignIn(signed) => signed.sessions.touch(session),
        }
    }
}

/// Mightyconsole's side of the OIDC sign-in (DOC-25 §3.2.3): the principal is
/// `human:oidc:<sub>` in the server's tenant. Roles come with TSK-138 (until then every
/// signed-in person may do everything, as v0.1's one user could); the user records with the
/// store (TSK-142). Sign-in, sign-out and failed sign-ins go to the audit log (DOC-25 §3.5.1,
/// TSK-137) as [`Event`]s: names, addresses, counts and reasons, never a token, code or secret.
/// The operational warnings (groups not kept, the IdP unreachable, a rate limit) are not audit
/// events and stay on the server log.
pub struct McSignIn {
    tenant: TenantId,
    out: Arc<dyn LineWriter>,
    events: EventLog,
}

impl McSignIn {
    pub fn new(tenant: &str, out: Arc<dyn LineWriter>, events: EventLog) -> McSignIn {
        McSignIn {
            tenant: TenantId::new(tenant),
            out,
            events,
        }
    }

    /// The audit event for a sign-in event, or `None` for an operational warning.
    pub fn event(event: &AuthEvent) -> Option<Event> {
        Some(match event {
            AuthEvent::SignedIn {
                user,
                session,
                method,
                client,
                groups,
                roles,
            } => Event::Login {
                user: user.clone(),
                session: session.clone(),
                method: method.as_str().to_owned(),
                ip: *client,
                groups: *groups,
                roles: roles.clone(),
            },
            AuthEvent::SignInFailed {
                error,
                reason,
                client,
            } => Event::LoginFailed {
                error: error.as_str().to_owned(),
                reason: reason.clone(),
                ip: *client,
            },
            AuthEvent::SignedOut {
                user,
                session,
                client,
            } => Event::Logout {
                user: user.clone(),
                session: session.clone(),
                ip: *client,
            },
            _ => return None,
        })
    }

    /// The server-log line for an operational warning.
    pub fn warning(event: &AuthEvent) -> Option<String> {
        let line = match event {
            AuthEvent::GroupsDropped { user, dropped } => {
                format!(
                    "WARNING: {dropped} groups of {user} were not kept (at most 256 of 256 bytes)"
                )
            }
            AuthEvent::IdpUnreachable { reason } => {
                format!("identity provider unreachable: {reason}")
            }
            AuthEvent::RateLimited { route, client } => {
                format!("{route}: too many requests from {client}")
            }
            _ => return None,
        };
        Some(format!("mightyconsole-server: {line}"))
    }
}

impl SignInHooks for McSignIn {
    fn sign_in<'a>(
        &'a self,
        identity: &'a OidcIdentity,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        let user = identity.principal_id();
        let principal = Principal {
            kind: PrincipalKind::Human,
            id: user.clone(),
            tenant: self.tenant.clone(),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("set per connection"),
        };
        Box::pin(async move { Ok(SignedIn { user, principal }) })
    }

    fn record(&self, event: AuthEvent) {
        if let Some(audit) = McSignIn::event(&event) {
            self.events.record(&audit);
        }
        if let Some(line) = McSignIn::warning(&event) {
            self.out.line(&line);
        }
    }
}

/// Records `auth.session.end` (DOC-25 §3.5.1) for a session that ends without sign-out; a
/// sign-out is `auth.logout`.
pub struct SessionLog(pub EventLog);

impl SessionEvents for SessionLog {
    fn session_ended(&self, ended: &EndedSession, by: Option<&str>) {
        if ended.reason == EndReason::Logout {
            return;
        }
        self.0.record(&Event::SessionEnd {
            user: ended.user.clone(),
            session: ended.id.clone(),
            reason: ended.reason.as_str().to_owned(),
            by: by.map(str::to_owned),
        });
    }
}

/// 256 random bits, hex.
fn token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS randomness");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_page_load_gets_a_session_and_every_upgrade_its_own_id() {
        let store = LocalSessions::new(local_principal());
        assert!(store.lookup("nothing").await.is_none());
        let page = store.for_page(None);
        assert!(page.new);
        assert_eq!(page.cookie.len(), 64);
        let a = store.lookup(&page.cookie).await.unwrap();
        let b = store.lookup(&page.cookie).await.unwrap();
        assert_ne!(a.session.id, b.session.id);
        assert_eq!(a.csrf_token, page.csrf_token);
        assert_eq!(a.session.principal.session.as_str(), a.session.id);
        assert!(a.session.principal.id.starts_with("human:local:"));
        // A second tab of the same browser keeps the cookie and the token.
        let again = store.for_page(Some(&page.cookie));
        assert!(!again.new);
        assert_eq!(again.csrf_token, page.csrf_token);
        // An unknown cookie gets a new session.
        let other = store.for_page(Some("stale"));
        assert!(other.new);
        assert_ne!(other.csrf_token, page.csrf_token);
        assert!(!format!("{page:?}").contains(&page.cookie));
    }

    #[test]
    fn the_oldest_browser_session_is_forgotten_first() {
        let store = LocalSessions::new(local_principal());
        let first = store.for_page(None);
        for _ in 1..MAX_BROWSER_SESSIONS {
            store.for_page(None);
        }
        assert_eq!(store.len(), MAX_BROWSER_SESSIONS);
        store.for_page(None);
        assert_eq!(store.len(), MAX_BROWSER_SESSIONS);
        assert!(store.for_page(Some(&first.cookie)).new);
    }
}
