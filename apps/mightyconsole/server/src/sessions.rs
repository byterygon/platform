//! Browser sessions (DOC-25 §3.2): every browser signs in. There is no mode without login
//! (DOC-25 §3.1; v0.1's local browser session is gone, TSK-142).
//!
//! - Built-in accounts ([`ambidex_axum::accounts`], on [`crate::store`]): sign-up, a password and
//!   an optional TOTP code, setup links; always on unless `auth.accounts = false`. The default
//!   administrator is one of them ([`crate::admin`]).
//! - OIDC ([`ambidex_axum::oidc`]) when `[auth.oidc]` is configured.
//!
//! Both end in the same kind of session in one [`LoginSessions`] store: a `__Host-` cookie, idle
//! and absolute expiry, revocation. [`McSignIn`] is Mightyconsole's side of both: it builds the
//! principal (`human:account:<id>` or `human:oidc:<sub>` in the server's tenant) and records the
//! events in the audit log.

use std::path::PathBuf;
use std::sync::Arc;

use ambidex::engine::BoxFuture;
use ambidex::{CancellationToken, Session};
use ambidex_axum::accounts::{Account, AccountHooks, Accounts};
use ambidex_axum::oidc::{
    AuthEvent, OidcIdentity, OidcLogin, SignInHooks, SignInRefusal, SignedIn,
};
use ambidex_axum::{
    EndReason, EndedSession, LoginSessions, SessionEvents, WebSession, WebSessions,
};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};

use crate::admin;
use crate::audit::{Event, EventLog, LineWriter};
use crate::store::McAccountStore;

/// The built-in accounts as the server runs them.
pub type McAccounts = Accounts<McAccountStore, Arc<McSignIn>>;

/// The sessions the server runs, and the ways into them.
#[derive(Clone)]
pub struct ServerSessions {
    pub sessions: Arc<LoginSessions>,
    /// Always mounted: with `auth.accounts = false` only the default administrator signs in with
    /// a password and sign-up is off ([`McSignIn::accounts_enabled`]). `None` only in the codegen
    /// router.
    pub accounts: Option<McAccounts>,
    /// With `[auth.oidc]`.
    pub oidc: Option<OidcLogin<Arc<McSignIn>>>,
}

impl WebSessions for ServerSessions {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        self.sessions.lookup(cookie)
    }

    fn revocation(&self, session: &Session) -> Option<CancellationToken> {
        self.sessions.revocation(session)
    }

    fn touch(&self, session: &Session) {
        self.sessions.touch(session);
    }
}

/// Mightyconsole's side of both sign-ins (DOC-25 §3.2.3): the principal is `human:oidc:<sub>`
/// or `human:account:<id>` in the server's tenant. Roles come with TSK-138 (until then every
/// signed-in person may do everything, as v0.1's one user could; the server warns at start).
/// Sign-ins, sign-outs, failed sign-ins, sign-ups and lockouts go to the audit log (DOC-25
/// §3.5.1) as [`Event`]s: names, addresses, counts and reasons, never a password, token, code or
/// secret. The operational warnings (groups not kept, the IdP unreachable, a rate limit) are not
/// audit events and stay on the server log.
pub struct McSignIn {
    tenant: TenantId,
    out: Arc<dyn LineWriter>,
    events: EventLog,
    /// The data directory, whose `admin-password` goes once the administrator changes it.
    data: Option<PathBuf>,
    /// `auth.accounts`: off, only the default administrator signs in with a password.
    accounts: bool,
}

impl McSignIn {
    pub fn new(tenant: &str, out: Arc<dyn LineWriter>, events: EventLog) -> McSignIn {
        McSignIn {
            tenant: TenantId::new(tenant),
            out,
            events,
            data: None,
            accounts: true,
        }
    }

    /// `auth.accounts = false`: only the default administrator signs in with a password.
    pub fn accounts_enabled(mut self, enabled: bool) -> McSignIn {
        self.accounts = enabled;
        self
    }

    /// Deletes `DATA/admin-password` when the default administrator changes its password.
    pub fn with_data(mut self, data: PathBuf) -> McSignIn {
        self.data = Some(data);
        self
    }

    fn principal(&self, user: &str) -> Principal {
        Principal {
            kind: PrincipalKind::Human,
            id: user.to_owned(),
            tenant: self.tenant.clone(),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("set per connection"),
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
            AuthEvent::SignedUp { user, client } => Event::Signup {
                user: user.clone(),
                ip: *client,
            },
            AuthEvent::Lockout {
                user,
                client,
                until_ms,
            } => Event::Lockout {
                user: user.clone(),
                ip: *client,
                until_ms: *until_ms,
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

    fn record_event(&self, event: AuthEvent) {
        if let Some(audit) = McSignIn::event(&event) {
            self.events.record(&audit);
        }
        if let Some(line) = McSignIn::warning(&event) {
            self.out.line(&line);
        }
    }
}

impl SignInHooks for McSignIn {
    fn sign_in<'a>(
        &'a self,
        identity: &'a OidcIdentity,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        let user = identity.principal_id();
        let principal = self.principal(&user);
        Box::pin(async move { Ok(SignedIn { user, principal }) })
    }

    fn record(&self, event: AuthEvent) {
        self.record_event(event);
    }
}

impl AccountHooks for McSignIn {
    fn sign_in<'a>(
        &'a self,
        account: &'a Account,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        let off = !self.accounts && account.username != admin::ADMIN_USERNAME;
        let result = if account.disabled || off {
            Err(SignInRefusal::Disabled)
        } else {
            let user = account.principal_id();
            let principal = self.principal(&user);
            Ok(SignedIn { user, principal })
        };
        Box::pin(async move { result })
    }

    fn record(&self, event: AuthEvent) {
        self.record_event(event);
    }

    fn password_changed(&self, account: &Account) {
        if account.username == admin::ADMIN_USERNAME
            && let Some(data) = &self.data
        {
            admin::forget_password_file(data);
        }
    }

    /// Until roles (TSK-138), the default administrator is the one administrator.
    fn is_administrator(&self, account: &Account) -> bool {
        account.username == admin::ADMIN_USERNAME
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
