//! Discovery and the JWKS (DOC-25 §3.2.1): fetched at start and kept; the JWKS is fetched again
//! every hour, and at once when a token names an unknown `kid` (at most once a minute). While
//! the IdP cannot be reached, sign-in answers `unreachable` and the fetch is retried with
//! backoff.

use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use security_types::Clock;
use serde_json::Value;
use url::Url;

use super::http::{HttpError, IdpHttp};
use super::token::Keys;

/// How often the JWKS is fetched again while sign-in works.
pub const JWKS_REFRESH: Duration = Duration::from_secs(60 * 60);
/// The shortest time between two fetches caused by an unknown `kid`.
pub const UNKNOWN_KID_REFRESH: Duration = Duration::from_secs(60);
/// The shortest time between two attempts to reach an IdP that was unreachable, when a sign-in
/// asks for it (the background retry has its own backoff).
pub const RETRY_ON_DEMAND: Duration = Duration::from_secs(5);
/// Backoff of the background retry: from the first to the last value, doubling.
pub const RETRY_BACKOFF: (Duration, Duration) = (Duration::from_secs(1), Duration::from_secs(300));

/// The endpoints discovery named, all `https://`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Discovery {
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub jwks_uri: Url,
    pub userinfo_endpoint: Option<Url>,
    pub end_session_endpoint: Option<Url>,
}

impl Discovery {
    /// Checks a discovery document: its `issuer` equals the configured one exactly, and every
    /// endpoint it names is an `https://` URL.
    pub fn parse(doc: &Value, issuer: &str, needs_userinfo: bool) -> Result<Discovery, String> {
        if doc.get("issuer").and_then(Value::as_str) != Some(issuer) {
            return Err("discovery: issuer differs from the configured one".into());
        }
        let endpoint = |name: &str| -> Result<Option<Url>, String> {
            match doc.get(name) {
                None | Some(Value::Null) => Ok(None),
                Some(Value::String(text)) => {
                    let url = Url::parse(text).map_err(|e| format!("discovery: {name}: {e}"))?;
                    if url.scheme() != "https" || url.host().is_none() {
                        return Err(format!("discovery: {name} is not an https:// URL"));
                    }
                    Ok(Some(url))
                }
                Some(_) => Err(format!("discovery: {name} is not a string")),
            }
        };
        let required = |name: &str| -> Result<Url, String> {
            endpoint(name)?.ok_or_else(|| format!("discovery: no {name}"))
        };
        let userinfo_endpoint = endpoint("userinfo_endpoint")?;
        if needs_userinfo && userinfo_endpoint.is_none() {
            return Err("discovery: no userinfo_endpoint (claims_source = userinfo)".into());
        }
        Ok(Discovery {
            authorization_endpoint: required("authorization_endpoint")?,
            token_endpoint: required("token_endpoint")?,
            jwks_uri: required("jwks_uri")?,
            userinfo_endpoint,
            end_session_endpoint: endpoint("end_session_endpoint")?,
        })
    }
}

/// What a working IdP gave us.
pub(crate) struct Loaded {
    pub discovery: Discovery,
    pub keys: Arc<Keys>,
    pub keys_fetched_ms: u64,
}

#[derive(Default)]
struct Attempts {
    last_load_ms: Option<u64>,
    last_kid_refresh_ms: Option<u64>,
}

pub(crate) struct Provider {
    issuer: String,
    needs_userinfo: bool,
    pub http: IdpHttp,
    clock: Arc<dyn Clock>,
    loaded: RwLock<Option<Arc<Loaded>>>,
    attempts: Mutex<Attempts>,
    /// Serializes fetches, so a burst of sign-ins causes one.
    fetching: tokio::sync::Mutex<()>,
}

impl Provider {
    pub fn new(
        issuer: String,
        needs_userinfo: bool,
        http: IdpHttp,
        clock: Arc<dyn Clock>,
    ) -> Provider {
        Provider {
            issuer,
            needs_userinfo,
            http,
            clock,
            loaded: RwLock::new(None),
            attempts: Mutex::default(),
            fetching: tokio::sync::Mutex::new(()),
        }
    }

    fn attempts(&self) -> std::sync::MutexGuard<'_, Attempts> {
        self.attempts.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn current(&self) -> Option<Arc<Loaded>> {
        self.loaded
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    fn set(&self, loaded: Loaded) -> Arc<Loaded> {
        let loaded = Arc::new(loaded);
        *self.loaded.write().unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&loaded));
        loaded
    }

    async fn json(&self, url: &Url) -> Result<Value, String> {
        let answer = self.http.get(url, None).await.map_err(|e| e.to_string())?;
        if answer.status != 200 {
            return Err(format!("{url}: HTTP {}", answer.status));
        }
        serde_json::from_slice(&answer.body).map_err(|e| format!("{url}: not JSON: {e}"))
    }

    async fn fetch_keys(&self, jwks_uri: &Url) -> Result<Keys, String> {
        let keys = Keys::from_jwks(&self.json(jwks_uri).await?)?;
        if keys.len() == 0 {
            return Err("the JWKS has no usable signature key".into());
        }
        Ok(keys)
    }

    /// Fetches discovery and the JWKS.
    pub async fn load(&self) -> Result<Arc<Loaded>, String> {
        let _one = self.fetching.lock().await;
        self.load_locked().await
    }

    /// [`Provider::load`] with the fetch lock held.
    async fn load_locked(&self) -> Result<Arc<Loaded>, String> {
        self.attempts().last_load_ms = Some(self.clock.now_unix_ms());
        let base = self.issuer.trim_end_matches('/');
        let url = Url::parse(&format!("{base}/.well-known/openid-configuration"))
            .map_err(|e| format!("issuer: {e}"))?;
        let discovery =
            Discovery::parse(&self.json(&url).await?, &self.issuer, self.needs_userinfo)?;
        let keys = self.fetch_keys(&discovery.jwks_uri).await?;
        Ok(self.set(Loaded {
            discovery,
            keys: Arc::new(keys),
            keys_fetched_ms: self.clock.now_unix_ms(),
        }))
    }

    /// The loaded IdP. When there is none: waits for a fetch in flight (the start's, or the
    /// background retry's), then makes one attempt unless one ended in the last
    /// [`RETRY_ON_DEMAND`].
    pub async fn ensure(&self) -> Result<Arc<Loaded>, String> {
        if let Some(loaded) = self.current() {
            return Ok(loaded);
        }
        let _one = self.fetching.lock().await;
        if let Some(loaded) = self.current() {
            return Ok(loaded);
        }
        let now = self.clock.now_unix_ms();
        let recent = self
            .attempts()
            .last_load_ms
            .is_some_and(|at| now.saturating_sub(at) < millis(RETRY_ON_DEMAND));
        if recent {
            return Err("the identity provider was unreachable moments ago".into());
        }
        self.load_locked().await
    }

    /// Fetches the JWKS again, keeping the old keys when that fails.
    pub async fn refresh_keys(&self) -> Result<Arc<Loaded>, String> {
        let current = self.current().ok_or("not loaded")?;
        let _one = self.fetching.lock().await;
        let keys = self.fetch_keys(&current.discovery.jwks_uri).await?;
        Ok(self.set(Loaded {
            discovery: current.discovery.clone(),
            keys: Arc::new(keys),
            keys_fetched_ms: self.clock.now_unix_ms(),
        }))
    }

    /// A token named a `kid` the JWKS lacks: fetch it again, at most once per
    /// [`UNKNOWN_KID_REFRESH`]. `None` when that was too recent or failed.
    pub async fn refresh_for_unknown_kid(&self) -> Option<Arc<Loaded>> {
        let now = self.clock.now_unix_ms();
        {
            let mut attempts = self.attempts();
            if attempts
                .last_kid_refresh_ms
                .is_some_and(|at| now.saturating_sub(at) < millis(UNKNOWN_KID_REFRESH))
            {
                return None;
            }
            attempts.last_kid_refresh_ms = Some(now);
        }
        self.refresh_keys().await.ok()
    }

    /// The background task: retries discovery with backoff until it works, then fetches the
    /// JWKS every [`JWKS_REFRESH`]. `report` is told each failure.
    pub async fn run(self: Arc<Self>, report: impl Fn(&str) + Send + 'static) {
        let mut backoff = RETRY_BACKOFF.0;
        loop {
            let result = match self.current() {
                None => self.load().await.map(|_| ()),
                Some(loaded) => {
                    let due = loaded.keys_fetched_ms.saturating_add(millis(JWKS_REFRESH));
                    let now = self.clock.now_unix_ms();
                    if now < due {
                        tokio::time::sleep(Duration::from_millis(due - now).min(JWKS_REFRESH))
                            .await;
                        continue;
                    }
                    self.refresh_keys().await.map(|_| ())
                }
            };
            match result {
                Ok(()) => backoff = RETRY_BACKOFF.0,
                Err(error) => {
                    report(&error);
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(RETRY_BACKOFF.1);
                }
            }
        }
    }
}

/// Whether an IdP error means "no answer" rather than "a wrong answer".
pub(crate) fn is_unreachable(error: &HttpError) -> bool {
    matches!(error, HttpError::Unreachable(_))
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn discovery_must_name_our_issuer_and_https_endpoints() {
        let doc = json!({
            "issuer": "https://idp.test/dex",
            "authorization_endpoint": "https://idp.test/dex/auth",
            "token_endpoint": "https://idp.test/dex/token",
            "jwks_uri": "https://idp.test/dex/keys",
            "userinfo_endpoint": "https://idp.test/dex/userinfo",
        });
        let ok = Discovery::parse(&doc, "https://idp.test/dex", true).unwrap();
        assert_eq!(ok.token_endpoint.as_str(), "https://idp.test/dex/token");
        assert!(ok.end_session_endpoint.is_none());
        assert!(Discovery::parse(&doc, "https://idp.test/dex/", false).is_err());
        let mut plain = doc.clone();
        plain["token_endpoint"] = json!("http://idp.test/dex/token");
        assert!(Discovery::parse(&plain, "https://idp.test/dex", false).is_err());
        let mut no_jwks = doc.clone();
        no_jwks.as_object_mut().unwrap().remove("jwks_uri");
        assert!(Discovery::parse(&no_jwks, "https://idp.test/dex", false).is_err());
        let mut no_userinfo = doc;
        no_userinfo
            .as_object_mut()
            .unwrap()
            .remove("userinfo_endpoint");
        assert!(Discovery::parse(&no_userinfo, "https://idp.test/dex", false).is_ok());
        assert!(Discovery::parse(&no_userinfo, "https://idp.test/dex", true).is_err());
    }
}
