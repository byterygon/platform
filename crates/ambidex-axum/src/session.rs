//! Web sessions behind the WebSocket upgrade (Ambidex spec §8, "Web").
//!
//! The upgrade request must carry a session cookie that a [`WebSessions`] store resolves to a
//! server-side [`WebSession`]. The [`Principal`] comes from that record, never from the client.
//! The Hello frame must then carry the session's anti-CSRF token as `auth: {"csrf": "<token>"}`.
//!
//! OIDC login, session expiry and revocation are M3. Until then the only store is
//! [`PlaceholderSessions`], which has no login at all.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use ambidex::engine::BoxFuture;
use ambidex::{Authenticate, Hello, Session};
use security_types::{Principal, SessionId};

/// A server-side web session.
#[derive(Clone)]
pub struct WebSession {
    /// Engine session, including the principal every call is authorized against.
    pub session: Session,
    /// Anti-CSRF token the client must echo in Hello. An empty token never matches.
    pub csrf_token: String,
}

impl fmt::Debug for WebSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("WebSession")
            .field("session", &self.session)
            .field("csrf_token", &"<redacted>")
            .finish()
    }
}

/// Resolves session cookies to server-side sessions.
pub trait WebSessions: Send + Sync + 'static {
    /// `None` rejects the upgrade with 401.
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>>;
}

impl<S: WebSessions> WebSessions for Arc<S> {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        (**self).lookup(cookie)
    }
}

/// **PLACEHOLDER, not for production.** In-memory sessions issued by server-side code, standing
/// in for OIDC login (M3).
///
/// There is no login endpoint, no expiry and no revocation. It starts empty, so every upgrade is
/// rejected until the embedding server calls [`PlaceholderSessions::issue`] with a principal it
/// built itself (fail closed).
#[derive(Default)]
pub struct PlaceholderSessions {
    sessions: Mutex<HashMap<String, WebSession>>,
}

/// Credentials of a session issued by [`PlaceholderSessions::issue`].
pub struct IssuedSession {
    /// Value of the session cookie.
    pub cookie: String,
    /// Anti-CSRF token for Hello.
    pub csrf_token: String,
    pub session_id: String,
}

impl fmt::Debug for IssuedSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IssuedSession")
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

impl PlaceholderSessions {
    pub fn new() -> PlaceholderSessions {
        PlaceholderSessions::default()
    }

    /// Creates a session for `principal` with random cookie, CSRF token and session id. The
    /// principal's `session` field is overwritten with the new id.
    pub fn issue(&self, mut principal: Principal) -> Result<IssuedSession, getrandom::Error> {
        let cookie = random_token()?;
        let csrf_token = random_token()?;
        let session_id = random_token()?;
        principal.session = SessionId::new(session_id.clone());
        let web = WebSession {
            session: Session {
                id: session_id.clone(),
                principal,
            },
            csrf_token: csrf_token.clone(),
        };
        self.lock().insert(cookie.clone(), web);
        Ok(IssuedSession {
            cookie,
            csrf_token,
            session_id,
        })
    }

    /// Removes the session with this cookie. Open connections are not closed (revocation is M3).
    pub fn remove(&self, cookie: &str) {
        self.lock().remove(cookie);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, WebSession>> {
        // The map holds no invariants a panicking writer could break.
        self.sessions.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl WebSessions for PlaceholderSessions {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        let found = self.lock().get(cookie).cloned();
        Box::pin(async move { found })
    }
}

/// 256 random bits, hex encoded.
fn random_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Per-connection [`Authenticate`]: accepts a Hello only if it carries the CSRF token of the
/// session resolved at upgrade time, and returns that session.
pub(crate) struct CsrfAuth(pub(crate) WebSession);

impl Authenticate for CsrfAuth {
    fn authenticate<'a>(&'a self, hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        let expected = self.0.csrf_token.as_bytes();
        let ok = hello
            .auth
            .as_ref()
            .and_then(|auth| auth.get("csrf"))
            .and_then(|csrf| csrf.as_str())
            .is_some_and(|got| !expected.is_empty() && constant_time_eq(got.as_bytes(), expected));
        let session = ok.then(|| self.0.session.clone());
        Box::pin(async move { session })
    }
}

/// Compares without an early exit on the first differing byte. Length is not secret.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{PrincipalKind, TenantId};
    use serde_json::json;

    fn principal() -> Principal {
        Principal {
            kind: PrincipalKind::Human,
            id: "human:placeholder:alice".into(),
            tenant: TenantId::new("t-1"),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("ignored"),
        }
    }

    fn hello(auth: Option<serde_json::Value>) -> Hello {
        Hello {
            protocol: 1,
            api: "dbee".into(),
            schema_hash: "h".into(),
            client_version: "1".into(),
            auth,
        }
    }

    #[tokio::test]
    async fn empty_store_rejects_everything() {
        let store = PlaceholderSessions::new();
        assert!(store.lookup("").await.is_none());
        assert!(store.lookup("anything").await.is_none());
    }

    #[tokio::test]
    async fn issued_session_resolves_with_server_side_principal() {
        let store = PlaceholderSessions::new();
        let issued = store.issue(principal()).unwrap();
        let web = store.lookup(&issued.cookie).await.unwrap();
        assert_eq!(web.session.id, issued.session_id);
        assert_eq!(web.session.principal.id, "human:placeholder:alice");
        assert_eq!(web.session.principal.session.as_str(), issued.session_id);
        store.remove(&issued.cookie);
        assert!(store.lookup(&issued.cookie).await.is_none());
    }

    #[tokio::test]
    async fn csrf_must_match_exactly() {
        let store = PlaceholderSessions::new();
        let issued = store.issue(principal()).unwrap();
        let auth = CsrfAuth(store.lookup(&issued.cookie).await.unwrap());
        let good = hello(Some(json!({ "csrf": issued.csrf_token })));
        assert!(auth.authenticate(&good).await.is_some());
        for bad in [
            None,
            Some(json!(issued.csrf_token)),
            Some(json!({ "csrf": "" })),
            Some(json!({ "csrf": format!("{}0", issued.csrf_token) })),
            Some(json!({ "csrf": issued.cookie })),
        ] {
            assert!(auth.authenticate(&hello(bad)).await.is_none());
        }
    }

    #[tokio::test]
    async fn empty_csrf_token_never_matches() {
        let mut web = WebSession {
            session: Session {
                id: "s".into(),
                principal: principal(),
            },
            csrf_token: String::new(),
        };
        let auth = CsrfAuth(web.clone());
        assert!(
            auth.authenticate(&hello(Some(json!({ "csrf": "" }))))
                .await
                .is_none()
        );
        web.csrf_token = "x".into();
        assert!(!format!("{web:?}").contains("\"x\""));
    }
}
