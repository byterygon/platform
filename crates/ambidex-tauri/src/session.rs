//! Desktop session and local human principal (Ambidex spec §8, "Desktop").
//!
//! Standalone desktop needs no login: the local OS user is the human principal
//! (`human:local:<os-user>`). The principal is built here from [`LocalIdentity`], which the app
//! supplies at startup; nothing the webview sends (in particular `Hello.auth`) is ever used. Each
//! session is bound to one webview label, and the same Authorizer and audit path run on it as on
//! web, so desktop is not a trusted shortcut.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::{Authenticate, CancellationToken, Hello, Session};
use security_types::{Principal, PrincipalKind, RoleId, SessionId, TenantId};

/// Longest OS user name accepted.
const MAX_OS_USER_LEN: usize = 256;

/// Who the local human is: OS user, tenant and roles, chosen by the app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalIdentity {
    os_user: String,
    tenant: TenantId,
    roles: Vec<RoleId>,
}

/// The OS user name is missing, empty, too long or contains `:` or control characters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidOsUser;

impl fmt::Display for InvalidOsUser {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("invalid or missing OS user name")
    }
}

impl std::error::Error for InvalidOsUser {}

impl LocalIdentity {
    /// `os_user` must be non-empty and free of `:` and control characters, so the principal id
    /// `human:local:<os-user>` stays unambiguous.
    pub fn new(
        os_user: impl Into<String>,
        tenant: TenantId,
        roles: Vec<RoleId>,
    ) -> Result<LocalIdentity, InvalidOsUser> {
        let os_user = os_user.into();
        let valid = !os_user.is_empty()
            && os_user.len() <= MAX_OS_USER_LEN
            && !os_user.chars().any(|c| c == ':' || c.is_control());
        if !valid {
            return Err(InvalidOsUser);
        }
        Ok(LocalIdentity {
            os_user,
            tenant,
            roles,
        })
    }

    /// Reads the OS user from the process environment (`USER`, `LOGNAME`, then `USERNAME`).
    ///
    /// This names the user; it is not an authentication factor. The process already runs with
    /// that user's rights, and the optional app lock (spec §8) is what gates access.
    pub fn from_env(tenant: TenantId, roles: Vec<RoleId>) -> Result<LocalIdentity, InvalidOsUser> {
        let os_user = ["USER", "LOGNAME", "USERNAME"]
            .into_iter()
            .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
            .ok_or(InvalidOsUser)?;
        LocalIdentity::new(os_user, tenant, roles)
    }

    pub fn os_user(&self) -> &str {
        &self.os_user
    }

    /// `human:local:<os-user>`.
    pub fn principal_id(&self) -> String {
        format!("human:local:{}", self.os_user)
    }
}

/// A session bound to one webview label.
///
/// Created when that webview opens its first connection without a live session; every connection
/// of the webview shares it until it ends. When it ends is decided by the [`SessionPolicy`]
/// (default: on the next page load) and always when the webview's window is destroyed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopSession {
    pub id: SessionId,
    pub webview_label: String,
    pub principal: Principal,
}

impl DesktopSession {
    /// Builds the session and its human principal. Fails only if the OS has no randomness for
    /// the session id.
    pub fn new(
        identity: &LocalIdentity,
        webview_label: impl Into<String>,
    ) -> Result<DesktopSession, getrandom::Error> {
        let id = SessionId::new(format!(
            "{:016x}{:016x}",
            getrandom::u64()?,
            getrandom::u64()?
        ));
        Ok(DesktopSession {
            principal: Principal {
                kind: PrincipalKind::Human,
                id: identity.principal_id(),
                tenant: identity.tenant.clone(),
                on_behalf_of: None,
                roles: identity.roles.clone(),
                session: id.clone(),
            },
            id,
            webview_label: webview_label.into(),
        })
    }
}

/// Decides when desktop sessions start and end, so a deployment can change the default lifetime
/// (one session per page load of a webview) without changing the transport.
///
/// Every method has a default; implement only what you need. Examples: refuse sessions while an
/// app lock is engaged, keep a session across reloads, or cap its age. To end sessions from app
/// code (lock, logout), call [`Hub::end_session`](crate::Hub::end_session) or
/// [`Hub::end_all_sessions`](crate::Hub::end_all_sessions).
pub trait SessionPolicy: Send + Sync + 'static {
    /// Whether `webview_label` may start a session now. Refusing makes `connect` fail with
    /// [`IpcError::SessionRefused`](crate::IpcError::SessionRefused). Default: allow.
    fn allow_session(&self, webview_label: &str) -> bool {
        let _ = webview_label;
        true
    }

    /// Whether a page load (navigation or reload) in the webview also ends its session. The
    /// webview's connections are closed on every page load regardless, because the old page can
    /// no longer use them. Default: `true`, so each page gets a new session.
    fn end_on_page_load(&self, webview_label: &str) -> bool {
        let _ = webview_label;
        true
    }

    /// Longest a session lives. An older session is ended on the webview's next `connect` or
    /// `send` (which then fails with [`IpcError::SessionExpired`](crate::IpcError::SessionExpired)).
    /// Default: no limit.
    fn max_age(&self, webview_label: &str) -> Option<Duration> {
        let _ = webview_label;
        None
    }
}

/// The default lifetime: one session per page load, no age limit, never refused.
#[derive(Debug, Clone, Copy, Default)]
pub struct DefaultSessionPolicy;

impl SessionPolicy for DefaultSessionPolicy {}

/// [`Authenticate`] for one desktop connection: always yields the connection's
/// [`DesktopSession`], whatever the Hello carries.
///
/// The webview is trusted only as far as the Tauri capability lets it reach the plugin; the
/// session it gets is decided by the label it was bound to when the connection opened.
pub struct DesktopAuth {
    session: Arc<DesktopSession>,
    revoked: CancellationToken,
}

impl DesktopAuth {
    /// `revoked` fires when the session ends; the engine then cancels the connection's calls,
    /// sends Goaway `Unauthenticated` and closes.
    pub fn new(session: Arc<DesktopSession>, revoked: CancellationToken) -> DesktopAuth {
        DesktopAuth { session, revoked }
    }
}

impl Authenticate for DesktopAuth {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async move {
            Some(Session {
                id: self.session.id.as_str().to_owned(),
                principal: self.session.principal.clone(),
            })
        })
    }

    fn revocation(&self, _session: &Session) -> Option<CancellationToken> {
        Some(self.revoked.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(user: &str) -> Result<LocalIdentity, InvalidOsUser> {
        LocalIdentity::new(user, TenantId::new("local"), vec![RoleId::new("owner")])
    }

    #[test]
    fn rejects_ambiguous_os_users() {
        for bad in ["", "a:b", "a\nb", "a\0b", &"x".repeat(MAX_OS_USER_LEN + 1)] {
            assert_eq!(identity(bad), Err(InvalidOsUser), "{bad:?}");
        }
        assert!(identity("alice").is_ok());
        assert!(identity("DOMAIN\\alice").is_ok());
    }

    #[test]
    fn session_carries_local_human_principal() {
        let session = DesktopSession::new(&identity("alice").unwrap(), "main").unwrap();
        assert_eq!(session.webview_label, "main");
        assert_eq!(session.id.as_str().len(), 32);
        let p = &session.principal;
        assert_eq!(p.kind, PrincipalKind::Human);
        assert_eq!(p.id, "human:local:alice");
        assert_eq!(p.tenant, TenantId::new("local"));
        assert_eq!(p.roles, vec![RoleId::new("owner")]);
        assert_eq!(p.session, session.id);
        assert!(p.on_behalf_of.is_none());

        let other = DesktopSession::new(&identity("alice").unwrap(), "main").unwrap();
        assert_ne!(other.id, session.id);
    }

    #[tokio::test]
    async fn authenticate_ignores_client_auth() {
        let session = Arc::new(DesktopSession::new(&identity("alice").unwrap(), "main").unwrap());
        let revoked = CancellationToken::new();
        let auth = DesktopAuth::new(Arc::clone(&session), revoked.clone());
        let hello = Hello {
            protocol: 1,
            api: "dbee".into(),
            schema_hash: "h".into(),
            client_version: "1".into(),
            auth: Some(serde_json::json!({ "principal": "human:local:root", "roles": ["admin"] })),
        };
        let got = auth.authenticate(&hello).await.unwrap();
        assert_eq!(got.id, session.id.as_str());
        assert_eq!(got.principal, session.principal);

        let token = auth
            .revocation(&got)
            .expect("desktop sessions can be revoked");
        assert!(!token.is_cancelled());
        revoked.cancel();
        assert!(token.is_cancelled());
    }
}
