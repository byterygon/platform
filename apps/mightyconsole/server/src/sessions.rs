//! The local browser session (Mightyconsole spec §2.3, "Session"; Open question 1).
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

use ambidex::Session;
use ambidex::engine::BoxFuture;
use ambidex_axum::{WebSession, WebSessions};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};

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
