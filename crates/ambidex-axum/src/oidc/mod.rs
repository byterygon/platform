//! OIDC sign-in (DOC-25 §3.2.1 to §3.2.5): authorization code with PKCE (S256), a state bound to
//! the browser by a cookie, a nonce, strict ID token checks, and a server-side session with a
//! new cookie at the end.
//!
//! The library offers the flow; the product supplies the configuration, maps the identity to a
//! principal and records the events ([`SignInHooks`]), and keeps the sessions in a
//! [`LoginSessions`]. Routes, under the product's base path:
//!
//! - `GET /auth/login?next=<path>`: a pending login (state, nonce, PKCE verifier, all 32 random
//!   bytes) kept in memory for 10 minutes (at most [`MAX_PENDING`], the oldest dropped first),
//!   the login cookie (`SameSite=Lax`, so it survives the IdP's cross-site redirect back) and a
//!   302 to the IdP.
//! - `GET /auth/callback?code&state`: the pending login is taken (single use) and must match the
//!   login cookie; the code is exchanged with the verifier; the ID token is validated
//!   ([`token`]); the product signs the identity in; the browser's previous session, if any, is
//!   ended (no fixation) and a new session cookie (`SameSite=Strict`) is set on a 200 page that
//!   continues to `next` ([`crate::web::continue_page`]).
//! - `POST /auth/logout`: with the exact `Origin`, the session cookie and its anti-CSRF token in
//!   the CSRF header; ends the session and answers 303 to the IdP's `end_session_endpoint` or
//!   to the base path.
//!
//! Every failure ends at `<base>/?login_error=<code>` ([`LoginError`]); the reason goes to the
//! product's [`SignInHooks::record`], never to the browser. The only outbound calls are to the
//! IdP, over TLS checked against the configured CA only. Codes, verifiers and tokens
//! live in zeroizing buffers and are dropped after validation, except the ID token kept for
//! RP-initiated logout. Nothing here logs.
//!
//! Limits (DOC-25 §3.2.2): `/auth/login` 30 per minute per client address, failed callbacks 10
//! per minute per client address, then 429 for a minute.

mod http;
mod provider;
pub mod token;

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::Router;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use rustls::pki_types::CertificateDer;
use security_types::{Clock, Principal};
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use url::Url;
use zeroize::Zeroizing;

use ambidex::engine::BoxFuture;

use crate::session::constant_time_eq;
use crate::store::{EndReason, LoginMethod, LoginSessions, NewSession, random_bytes};
use crate::web::{self, SameSite};
use crate::{ClientAddr, valid_path_prefix};

pub use http::{IDP_TIMEOUT, MAX_IDP_BODY};
pub use provider::{JWKS_REFRESH, RETRY_BACKOFF, UNKNOWN_KID_REFRESH};
pub use token::SignatureAlgorithm;

/// Pending logins kept at once; the oldest is dropped first.
pub const MAX_PENDING: usize = 1024;
/// How long a pending login waits for its callback.
pub const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// Default and largest clock skew allowed on ID token times.
pub const DEFAULT_CLOCK_SKEW: Duration = Duration::from_secs(60);
pub const MAX_CLOCK_SKEW: Duration = Duration::from_secs(300);
/// Groups kept per user, and the longest group name kept (DOC-25 §3.2.3).
pub const MAX_GROUPS: usize = 256;
pub const MAX_GROUP_BYTES: usize = 256;
/// `/auth/login` requests per client address per minute.
pub const LOGIN_PER_MINUTE: u32 = 30;
/// Failed callbacks per client address per minute before 429 for a minute.
pub const FAILED_CALLBACKS_PER_MINUTE: u32 = 10;

/// How the client authenticates at the token endpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenAuth {
    /// `client_secret_basic` (default).
    Basic,
    /// `client_secret_post`.
    Post,
    /// A public client relying on PKCE alone.
    None,
}

/// Where the groups and display claims come from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimsSource {
    IdToken,
    /// The userinfo endpoint, called once at sign-in with the access token.
    Userinfo,
}

/// The `[auth.oidc]` settings (DOC-25 §3.2.1).
#[derive(Clone)]
pub struct OidcConfig {
    /// `https://` URL; discovery's `issuer` must equal it exactly.
    pub issuer: String,
    pub client_id: String,
    /// Required unless [`OidcConfig::token_auth`] is [`TokenAuth::None`].
    pub client_secret: Option<Zeroizing<String>>,
    pub token_auth: TokenAuth,
    /// The only trust roots for every connection to the IdP.
    pub ca_certs: Vec<CertificateDer<'static>>,
    pub scopes: Vec<String>,
    /// A dotted path into the claims (`groups`, `realm_access.roles`).
    pub groups_claim: String,
    pub claims_source: ClaimsSource,
    /// For the sign-in page; default the issuer's host.
    pub display_name: String,
    pub clock_skew: Duration,
    /// RP-initiated logout when the IdP advertises `end_session_endpoint`.
    pub idp_logout: bool,
    pub algorithms: Vec<SignatureAlgorithm>,
}

impl fmt::Debug for OidcConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OidcConfig")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .field("token_auth", &self.token_auth)
            .field("ca_certs", &self.ca_certs.len())
            .field("scopes", &self.scopes)
            .field("groups_claim", &self.groups_claim)
            .field("claims_source", &self.claims_source)
            .field("display_name", &self.display_name)
            .field("clock_skew", &self.clock_skew)
            .field("idp_logout", &self.idp_logout)
            .field("algorithms", &self.algorithms)
            .finish()
    }
}

impl OidcConfig {
    /// The spec's defaults for everything but the issuer, client and CA.
    pub fn new(
        issuer: impl Into<String>,
        client_id: impl Into<String>,
        ca_certs: Vec<CertificateDer<'static>>,
    ) -> OidcConfig {
        let issuer = issuer.into();
        let display_name = Url::parse(&issuer)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .unwrap_or_else(|| issuer.clone());
        OidcConfig {
            issuer,
            client_id: client_id.into(),
            client_secret: None,
            token_auth: TokenAuth::Basic,
            ca_certs,
            scopes: ["openid", "profile", "email"].map(String::from).to_vec(),
            groups_claim: "groups".into(),
            claims_source: ClaimsSource::IdToken,
            display_name,
            clock_skew: DEFAULT_CLOCK_SKEW,
            idp_logout: true,
            algorithms: SignatureAlgorithm::ALL.to_vec(),
        }
    }

    /// Everything that can be checked without the network (DOC-25 §3.6.2 point 2).
    pub fn validate(&self) -> Result<(), OidcConfigError> {
        let issuer = Url::parse(&self.issuer).map_err(|_| OidcConfigError::Issuer)?;
        if issuer.scheme() != "https"
            || issuer.host().is_none()
            || issuer.query().is_some()
            || issuer.fragment().is_some()
            || !issuer.username().is_empty()
        {
            return Err(OidcConfigError::Issuer);
        }
        if self.client_id.is_empty() || self.client_id.bytes().any(|b| !b.is_ascii_graphic()) {
            return Err(OidcConfigError::ClientId);
        }
        if self.token_auth != TokenAuth::None
            && self.client_secret.as_ref().is_none_or(|s| s.is_empty())
        {
            return Err(OidcConfigError::ClientSecret);
        }
        if self.ca_certs.is_empty() {
            return Err(OidcConfigError::Ca);
        }
        if !self.scopes.iter().any(|s| s == "openid")
            || self
                .scopes
                .iter()
                .any(|s| s.is_empty() || s.bytes().any(|b| !b.is_ascii_graphic()))
        {
            return Err(OidcConfigError::Scopes);
        }
        if self.groups_claim.is_empty() || self.groups_claim.split('.').any(str::is_empty) {
            return Err(OidcConfigError::GroupsClaim);
        }
        if self.clock_skew > MAX_CLOCK_SKEW {
            return Err(OidcConfigError::ClockSkew);
        }
        if self.algorithms.is_empty() {
            return Err(OidcConfigError::Algorithms);
        }
        Ok(())
    }
}

/// Invalid [`OidcConfig`] or [`LoginRoutes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OidcConfigError {
    Issuer,
    ClientId,
    ClientSecret,
    Ca,
    Scopes,
    GroupsClaim,
    ClockSkew,
    Algorithms,
    PublicOrigin,
    BasePath,
    Cookie,
    Http(String),
}

impl fmt::Display for OidcConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OidcConfigError::Issuer => {
                f.write_str("issuer must be an https:// URL without query or fragment")
            }
            OidcConfigError::ClientId => f.write_str("client_id must be set (printable ASCII)"),
            OidcConfigError::ClientSecret => {
                f.write_str("a client secret is required unless token_auth = \"none\"")
            }
            OidcConfigError::Ca => f.write_str("ca_file must hold at least one certificate"),
            OidcConfigError::Scopes => f.write_str("scopes must include openid"),
            OidcConfigError::GroupsClaim => f.write_str("groups_claim must be a dotted path"),
            OidcConfigError::ClockSkew => f.write_str("clock_skew is at most 300 s"),
            OidcConfigError::Algorithms => f.write_str("algorithms must allow at least one"),
            OidcConfigError::PublicOrigin => {
                f.write_str("public_origin must be a lowercase https://host[:port]")
            }
            OidcConfigError::BasePath => f.write_str("invalid base path"),
            OidcConfigError::Cookie => f.write_str("cookie names must start with __Host-"),
            OidcConfigError::Http(e) => write!(f, "IdP client: {e}"),
        }
    }
}

impl std::error::Error for OidcConfigError {}

/// Where the sign-in lives in the product.
#[derive(Debug, Clone)]
pub struct LoginRoutes {
    /// `https://host[:port]`, as the browser sees it; the redirect URI and the logout's
    /// `Origin` check derive from it.
    pub public_origin: String,
    /// `""` or `/`-led segments (see [`valid_path_prefix`]).
    pub base_path: String,
    /// The session cookie ([`crate::WsConfig::session_cookie`]).
    pub session_cookie: String,
    /// The login cookie that binds a pending login to the browser.
    pub login_cookie: String,
    /// The header logout's anti-CSRF token comes in, and the pre-session token of the
    /// built-in accounts' routes ([`crate::accounts`]).
    pub csrf_header: HeaderName,
    /// The signed-out page's pre-session cookie (`SameSite=Strict`) that every `POST` of the
    /// built-in accounts must match in [`LoginRoutes::csrf_header`].
    pub pre_cookie: String,
    /// The cookie that binds a sign-in waiting for its second factor to the browser.
    pub totp_cookie: String,
}

impl LoginRoutes {
    pub fn new(public_origin: impl Into<String>) -> LoginRoutes {
        LoginRoutes {
            public_origin: public_origin.into(),
            base_path: String::new(),
            session_cookie: crate::DEFAULT_SESSION_COOKIE.into(),
            login_cookie: "__Host-ambidex_login".into(),
            csrf_header: HeaderName::from_static("x-ambidex-csrf"),
            pre_cookie: "__Host-ambidex_pre".into(),
            totp_cookie: "__Host-ambidex_totp".into(),
        }
    }

    /// `<public origin><base path>/auth/callback`: the one redirect URI to register at the IdP.
    pub fn redirect_uri(&self) -> String {
        format!("{}{}/auth/callback", self.public_origin, self.base_path)
    }

    fn home(&self) -> String {
        if self.base_path.is_empty() {
            "/".into()
        } else {
            self.base_path.clone()
        }
    }

    fn validate(&self) -> Result<(), OidcConfigError> {
        let mut ws = crate::WsConfig::new(["x"], self.public_origin.clone());
        ws.session_cookie = self.session_cookie.clone();
        ws.path_prefix = self.base_path.clone();
        if !valid_path_prefix(&self.base_path) {
            return Err(OidcConfigError::BasePath);
        }
        match ws.validate() {
            Ok(()) => {}
            Err(crate::ConfigError::PublicOrigin) => return Err(OidcConfigError::PublicOrigin),
            Err(_) => return Err(OidcConfigError::Cookie),
        }
        if !self.login_cookie.starts_with("__Host-")
            || !self.pre_cookie.starts_with("__Host-")
            || !self.totp_cookie.starts_with("__Host-")
        {
            return Err(OidcConfigError::Cookie);
        }
        Ok(())
    }
}

/// A user the IdP vouched for.
#[derive(Debug, Clone, PartialEq)]
pub struct OidcIdentity {
    pub issuer: String,
    /// `sub`: printable ASCII, at most 255 bytes.
    pub subject: String,
    /// `name`, else `preferred_username`, else `sub`. Shown only.
    pub display_name: String,
    /// `email`. Shown only, never used for authorization.
    pub email: Option<String>,
    /// The strings at `groups_claim`, at most [`MAX_GROUPS`] of at most [`MAX_GROUP_BYTES`].
    pub groups: Vec<String>,
    /// Groups left out by those bounds (a warning names the user).
    pub groups_dropped: usize,
    /// `auth_time` (Unix ms) when the IdP gave one.
    pub auth_time_ms: Option<u64>,
    /// Every claim (from the ID token, or userinfo with `claims_source = userinfo`).
    pub claims: Map<String, Value>,
}

impl OidcIdentity {
    /// `human:oidc:<sub>` (DOC-25 §3.2.3).
    pub fn principal_id(&self) -> String {
        format!("human:oidc:{}", self.subject)
    }
}

/// The product's answer to a sign-in.
#[derive(Debug, Clone)]
pub struct SignedIn {
    /// The user's stable id (sessions are revoked by it).
    pub user: String,
    /// Who acts on the session. Its `session` is set per connection.
    pub principal: Principal,
}

/// Why the product refused a sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignInRefusal {
    /// The user is disabled.
    Disabled,
}

/// The `login_error` a failed sign-in ends with (DOC-25 §3.2.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginError {
    /// The IdP returned `error`.
    Denied,
    /// Discovery, JWKS or token endpoint could not be reached.
    Unreachable,
    /// Any validation failure: state or binding mismatch, a replayed or expired code, a bad token.
    Invalid,
    Disabled,
    /// The pending login is gone.
    Expired,
    /// Too many sessions.
    Busy,
}

impl LoginError {
    pub fn as_str(self) -> &'static str {
        match self {
            LoginError::Denied => "denied",
            LoginError::Unreachable => "unreachable",
            LoginError::Invalid => "invalid",
            LoginError::Disabled => "disabled",
            LoginError::Expired => "expired",
            LoginError::Busy => "busy",
        }
    }
}

/// What the sign-in reports for the audit log (DOC-25 §3.5.1). Never holds a token, code,
/// cookie or secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthEvent {
    /// `auth.login` by the user.
    SignedIn {
        user: String,
        session: String,
        method: LoginMethod,
        client: Option<IpAddr>,
        groups: usize,
        roles: Vec<String>,
    },
    /// `auth.login` failed (principal `system:auth`). `reason` is for the log only.
    SignInFailed {
        error: LoginError,
        reason: String,
        client: Option<IpAddr>,
    },
    /// `auth.logout`.
    SignedOut {
        user: String,
        session: String,
        client: Option<IpAddr>,
    },
    /// The IdP gave more or longer groups than are kept.
    GroupsDropped { user: String, dropped: usize },
    /// The background fetch of discovery or the JWKS failed.
    IdpUnreachable { reason: String },
    /// A client address went over a sign-in limit and gets 429.
    RateLimited { route: &'static str, client: IpAddr },
    /// `auth.signup`: a built-in account was made by sign-up ([`crate::accounts`]).
    SignedUp {
        user: String,
        client: Option<IpAddr>,
    },
    /// `auth.lockout` (principal `system:auth`): too many failures locked an account until
    /// `until_ms`.
    Lockout {
        user: String,
        client: Option<IpAddr>,
        until_ms: u64,
    },
}

/// The product side of the sign-in.
pub trait SignInHooks: Send + Sync + 'static {
    /// Maps an identity to the user and principal (creating or updating the user record), or
    /// refuses it.
    fn sign_in<'a>(
        &'a self,
        identity: &'a OidcIdentity,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>>;

    /// Records an event. Called outside every lock; must not block for long.
    fn record(&self, event: AuthEvent);
}

impl<H: SignInHooks> SignInHooks for Arc<H> {
    fn sign_in<'a>(
        &'a self,
        identity: &'a OidcIdentity,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        (**self).sign_in(identity)
    }

    fn record(&self, event: AuthEvent) {
        (**self).record(event);
    }
}

struct Pending {
    binding_hash: [u8; 32],
    nonce: Zeroizing<String>,
    verifier: Zeroizing<String>,
    next: String,
    created_ms: u64,
}

#[derive(Default)]
struct PendingLogins {
    by_state: HashMap<String, Pending>,
    order: VecDeque<String>,
}

#[derive(Clone, Copy)]
struct Window {
    start_ms: u64,
    count: u32,
    blocked_until_ms: u64,
}

/// Fixed one-minute windows per client address, bounded in memory.
#[derive(Default)]
struct RateLimit {
    by_client: HashMap<IpAddr, Window>,
}

const MAX_TRACKED_CLIENTS: usize = 16_384;
const MINUTE_MS: u64 = 60_000;

impl RateLimit {
    /// Counts one event; `false` when the address is over `limit` this minute (and, with
    /// `block`, for the minute after).
    fn hit(&mut self, client: IpAddr, now: u64, limit: u32, block: bool) -> bool {
        if self.by_client.len() >= MAX_TRACKED_CLIENTS {
            self.by_client.retain(|_, w| {
                now < w.blocked_until_ms || now.saturating_sub(w.start_ms) < MINUTE_MS
            });
            if self.by_client.len() >= MAX_TRACKED_CLIENTS {
                self.by_client.clear();
            }
        }
        let window = self.by_client.entry(client).or_insert(Window {
            start_ms: now,
            count: 0,
            blocked_until_ms: 0,
        });
        if now < window.blocked_until_ms {
            return false;
        }
        if now.saturating_sub(window.start_ms) >= MINUTE_MS {
            *window = Window {
                start_ms: now,
                count: 0,
                blocked_until_ms: 0,
            };
        }
        window.count += 1;
        if window.count > limit {
            if block {
                window.blocked_until_ms = now + MINUTE_MS;
            }
            return false;
        }
        true
    }

    fn blocked(&self, client: IpAddr, now: u64) -> bool {
        self.by_client
            .get(&client)
            .is_some_and(|w| now < w.blocked_until_ms)
    }
}

struct Inner<H> {
    config: OidcConfig,
    routes: LoginRoutes,
    redirect_uri: String,
    provider: Arc<provider::Provider>,
    sessions: Arc<LoginSessions>,
    hooks: H,
    clock: Arc<dyn Clock>,
    pending: Mutex<PendingLogins>,
    login_limit: Mutex<RateLimit>,
    callback_limit: Mutex<RateLimit>,
}

/// The OIDC sign-in. See the [module docs](self).
pub struct OidcLogin<H> {
    inner: Arc<Inner<H>>,
}

impl<H> Clone for OidcLogin<H> {
    fn clone(&self) -> Self {
        OidcLogin {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<H: SignInHooks> OidcLogin<H> {
    /// Checks the configuration and builds the IdP client. Nothing is fetched yet: call
    /// [`OidcLogin::discover`] or [`OidcLogin::spawn_refresh`].
    pub fn new(
        config: OidcConfig,
        routes: LoginRoutes,
        sessions: Arc<LoginSessions>,
        hooks: H,
        clock: Arc<dyn Clock>,
    ) -> Result<OidcLogin<H>, OidcConfigError> {
        config.validate()?;
        routes.validate()?;
        let http =
            http::IdpHttp::new(&config.ca_certs, IDP_TIMEOUT).map_err(OidcConfigError::Http)?;
        let provider = Arc::new(provider::Provider::new(
            config.issuer.clone(),
            config.claims_source == ClaimsSource::Userinfo,
            http,
            Arc::clone(&clock),
        ));
        Ok(OidcLogin {
            inner: Arc::new(Inner {
                redirect_uri: routes.redirect_uri(),
                config,
                routes,
                provider,
                sessions,
                hooks,
                clock,
                pending: Mutex::default(),
                login_limit: Mutex::default(),
                callback_limit: Mutex::default(),
            }),
        })
    }

    /// Fetches discovery and the JWKS once.
    pub async fn discover(&self) -> Result<(), String> {
        self.inner.provider.load().await.map(|_| ())
    }

    /// Fetches the JWKS again now (keeping the old keys when that fails).
    pub async fn refresh_keys(&self) -> Result<(), String> {
        self.inner.provider.refresh_keys().await.map(|_| ())
    }

    /// Whether discovery and the JWKS are loaded.
    pub fn is_ready(&self) -> bool {
        self.inner.provider.current().is_some()
    }

    /// Retries discovery with backoff until it works, then fetches the JWKS every hour; each
    /// failure is recorded as [`AuthEvent::IdpUnreachable`].
    pub fn spawn_refresh(&self) -> tokio::task::JoinHandle<()> {
        let inner = Arc::clone(&self.inner);
        let provider = Arc::clone(&inner.provider);
        tokio::spawn(provider.run(move |reason| {
            inner.hooks.record(AuthEvent::IdpUnreachable {
                reason: reason.to_owned(),
            });
        }))
    }

    pub fn display_name(&self) -> &str {
        &self.inner.config.display_name
    }

    /// The redirect URI to register at the IdP.
    pub fn redirect_uri(&self) -> &str {
        &self.inner.redirect_uri
    }

    pub fn sessions(&self) -> &Arc<LoginSessions> {
        &self.inner.sessions
    }

    /// Pending logins held now.
    pub fn pending_len(&self) -> usize {
        lock(&self.inner.pending).by_state.len()
    }

    /// `/auth/login`, `/auth/callback` and `/auth/logout` under the base path.
    pub fn routes(&self) -> Router {
        let base = &self.inner.routes.base_path;
        Router::new()
            .route(&format!("{base}/auth/login"), get(login::<H>))
            .route(&format!("{base}/auth/callback"), get(callback::<H>))
            .route(&format!("{base}/auth/logout"), post(logout::<H>))
            .with_state(Arc::clone(&self.inner))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn client_of(headers_ext: Option<&ClientAddr>) -> Option<IpAddr> {
    headers_ext.map(|c| c.0.ip())
}

fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn redirect(status: StatusCode, location: &str) -> Response {
    let mut response = status.into_response();
    let headers = response.headers_mut();
    web::auth_headers(headers);
    if let Ok(value) = HeaderValue::from_str(location) {
        headers.insert(header::LOCATION, value);
    }
    response
}

fn too_many() -> Response {
    let mut response = (StatusCode::TOO_MANY_REQUESTS, "too many sign-in attempts").into_response();
    web::auth_headers(response.headers_mut());
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
    response
}

#[derive(Deserialize)]
struct LoginQuery {
    next: Option<String>,
}

async fn login<H: SignInHooks>(
    State(inner): State<Arc<Inner<H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    Query(query): Query<LoginQuery>,
) -> Response {
    let client = client_of(client.as_deref());
    let now = inner.clock.now_unix_ms();
    if let Some(ip) = client
        && !lock(&inner.login_limit).hit(ip, now, LOGIN_PER_MINUTE, false)
    {
        inner.hooks.record(AuthEvent::RateLimited {
            route: "/auth/login",
            client: ip,
        });
        return too_many();
    }
    let loaded = match inner.provider.ensure().await {
        Ok(loaded) => loaded,
        Err(reason) => {
            return fail(&inner, LoginError::Unreachable, reason, client, false);
        }
    };
    let state = b64(&random_bytes::<32>());
    let nonce = Zeroizing::new(b64(&random_bytes::<32>()));
    let verifier = Zeroizing::new(b64(&random_bytes::<32>()));
    let binding = Zeroizing::new(b64(&random_bytes::<32>()));
    let challenge = b64(&sha256(verifier.as_bytes()));
    let next = web::safe_next(query.next.as_deref(), &inner.routes.base_path);

    let mut url = loaded.discovery.authorization_endpoint.clone();
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &inner.config.client_id)
        .append_pair("redirect_uri", &inner.redirect_uri)
        .append_pair("scope", &inner.config.scopes.join(" "))
        .append_pair("state", &state)
        .append_pair("nonce", &nonce)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    {
        let mut pending = lock(&inner.pending);
        while pending.by_state.len() >= MAX_PENDING {
            match pending.order.pop_front() {
                Some(oldest) => {
                    pending.by_state.remove(&oldest);
                }
                None => break,
            }
        }
        pending.order.push_back(state.clone());
        pending.by_state.insert(
            state,
            Pending {
                binding_hash: sha256(binding.as_bytes()),
                nonce,
                verifier,
                next,
                created_ms: now,
            },
        );
    }
    let mut response = redirect(StatusCode::FOUND, url.as_str());
    response.headers_mut().insert(
        header::SET_COOKIE,
        web::set_cookie(
            &inner.routes.login_cookie,
            &binding,
            SameSite::Lax,
            Some(PENDING_TTL.as_secs()),
        ),
    );
    response
}

/// Ends a sign-in at `<base>/?login_error=<code>`, clears the login cookie and records why.
fn fail<H: SignInHooks>(
    inner: &Inner<H>,
    error: LoginError,
    reason: String,
    client: Option<IpAddr>,
    counts_as_failed_callback: bool,
) -> Response {
    if counts_as_failed_callback && let Some(ip) = client {
        let now = inner.clock.now_unix_ms();
        lock(&inner.callback_limit).hit(ip, now, FAILED_CALLBACKS_PER_MINUTE, true);
    }
    inner.hooks.record(AuthEvent::SignInFailed {
        error,
        reason,
        client,
    });
    let base = &inner.routes.base_path;
    let mut response = redirect(
        StatusCode::SEE_OTHER,
        &format!("{base}/?login_error={}", error.as_str()),
    );
    response.headers_mut().insert(
        header::SET_COOKIE,
        web::clear_cookie(&inner.routes.login_cookie, SameSite::Lax),
    );
    response
}

#[derive(Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
struct TokenAnswer {
    id_token: Option<Zeroizing<String>>,
    access_token: Option<Zeroizing<String>>,
}

async fn callback<H: SignInHooks>(
    State(inner): State<Arc<Inner<H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
    Query(query): Query<CallbackQuery>,
) -> Response {
    let client = client_of(client.as_deref());
    let now = inner.clock.now_unix_ms();
    if let Some(ip) = client
        && lock(&inner.callback_limit).blocked(ip, now)
    {
        inner.hooks.record(AuthEvent::RateLimited {
            route: "/auth/callback",
            client: ip,
        });
        return too_many();
    }
    let code = query.code.map(Zeroizing::new);
    let failed = |error, reason: &str| fail(&inner, error, reason.to_owned(), client, true);

    // The pending login is single use: it is gone after this, whatever happens next.
    let Some(state) = query.state.filter(|s| !s.is_empty()) else {
        return failed(LoginError::Invalid, "callback without state");
    };
    let pending = {
        let mut pending = lock(&inner.pending);
        let found = pending.by_state.remove(&state);
        if found.is_some() {
            pending.order.retain(|s| s != &state);
        }
        found
    };
    let Some(pending) = pending else {
        return failed(LoginError::Invalid, "state does not match a pending login");
    };
    if now.saturating_sub(pending.created_ms) >= millis(PENDING_TTL) {
        return failed(LoginError::Expired, "pending login expired");
    }
    let bound = web::cookie(&headers, &inner.routes.login_cookie).is_some_and(|binding| {
        constant_time_eq(&sha256(binding.as_bytes()), &pending.binding_hash)
    });
    if !bound {
        return failed(
            LoginError::Invalid,
            "login cookie missing or not bound to the state",
        );
    }
    if let Some(error) = query.error {
        let error: String = error
            .chars()
            .filter(char::is_ascii_graphic)
            .take(64)
            .collect();
        return failed(
            LoginError::Denied,
            &format!("the IdP returned error {error}"),
        );
    }
    let Some(code) = code.filter(|c| !c.is_empty()) else {
        return failed(LoginError::Invalid, "callback without code");
    };
    let loaded = match inner.provider.ensure().await {
        Ok(loaded) => loaded,
        Err(reason) => return failed(LoginError::Unreachable, &reason),
    };

    // The code exchange.
    let (form, authorization) =
        token_request(&inner.config, &inner.redirect_uri, &code, &pending.verifier);
    let answer = match inner
        .provider
        .http
        .post_form(&loaded.discovery.token_endpoint, form, authorization)
        .await
    {
        Ok(answer) => answer,
        Err(error) if provider::is_unreachable(&error) => {
            return failed(LoginError::Unreachable, &format!("token endpoint {error}"));
        }
        Err(error) => return failed(LoginError::Invalid, &format!("token endpoint {error}")),
    };
    if answer.status >= 500 {
        return failed(
            LoginError::Unreachable,
            &format!("token endpoint HTTP {}", answer.status),
        );
    }
    if answer.status != 200 {
        // A replayed, expired or wrong code (invalid_grant) or a wrong client.
        let error = serde_json::from_slice::<Value>(&answer.body)
            .ok()
            .and_then(|v| v.get("error").and_then(Value::as_str).map(str::to_owned))
            .unwrap_or_default();
        let error: String = error
            .chars()
            .filter(char::is_ascii_graphic)
            .take(64)
            .collect();
        return failed(
            LoginError::Invalid,
            &format!("token endpoint HTTP {} {error}", answer.status),
        );
    }
    let Ok(tokens) = serde_json::from_slice::<TokenAnswer>(&answer.body) else {
        return failed(LoginError::Invalid, "token endpoint answer is not JSON");
    };
    drop(answer);
    let Some(id_token) = tokens.id_token else {
        return failed(LoginError::Invalid, "token endpoint answer has no id_token");
    };

    // The ID token.
    let skew_s = inner.config.clock_skew.as_secs();
    let expect = |now_ms: u64| token::Expect {
        issuer: &inner.config.issuer,
        client_id: &inner.config.client_id,
        nonce: &pending.nonce,
        algorithms: &inner.config.algorithms,
        skew_s,
        now_s: now_ms / 1000,
    };
    let mut result = token::validate(&id_token, &loaded.keys, &expect(inner.clock.now_unix_ms()));
    if result == Err(token::TokenError::UnknownKey)
        && token::header(&id_token, &inner.config.algorithms).is_ok()
        && let Some(fresh) = inner.provider.refresh_for_unknown_kid().await
    {
        result = token::validate(&id_token, &fresh.keys, &expect(inner.clock.now_unix_ms()));
    }
    let mut claims = match result {
        Ok(claims) => claims,
        Err(error) => return failed(LoginError::Invalid, error.as_str()),
    };
    let subject = claims
        .get("sub")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let auth_time_ms = claims
        .get("auth_time")
        .and_then(Value::as_u64)
        .map(|s| s.saturating_mul(1000));

    if inner.config.claims_source == ClaimsSource::Userinfo {
        let (Some(endpoint), Some(access)) = (
            loaded.discovery.userinfo_endpoint.as_ref(),
            tokens.access_token.as_ref(),
        ) else {
            return failed(LoginError::Invalid, "no access token for userinfo");
        };
        let answer = match inner.provider.http.get(endpoint, Some(access)).await {
            Ok(answer) if answer.status == 200 => answer,
            Ok(answer) if answer.status >= 500 => {
                return failed(
                    LoginError::Unreachable,
                    &format!("userinfo HTTP {}", answer.status),
                );
            }
            Ok(answer) => {
                return failed(
                    LoginError::Invalid,
                    &format!("userinfo HTTP {}", answer.status),
                );
            }
            Err(error) if provider::is_unreachable(&error) => {
                return failed(LoginError::Unreachable, &format!("userinfo {error}"));
            }
            Err(error) => return failed(LoginError::Invalid, &format!("userinfo {error}")),
        };
        let Ok(Value::Object(info)) = serde_json::from_slice::<Value>(&answer.body) else {
            return failed(LoginError::Invalid, "userinfo is not a JSON object");
        };
        if info.get("sub").and_then(Value::as_str) != Some(subject.as_str()) {
            return failed(
                LoginError::Invalid,
                "userinfo sub differs from the ID token's",
            );
        }
        claims = info;
    }
    drop(tokens.access_token);

    let identity = identity(&inner.config, subject, auth_time_ms, claims);
    if identity.groups_dropped > 0 {
        inner.hooks.record(AuthEvent::GroupsDropped {
            user: identity.principal_id(),
            dropped: identity.groups_dropped,
        });
    }
    let signed_in = match inner.hooks.sign_in(&identity).await {
        Ok(signed_in) => signed_in,
        Err(SignInRefusal::Disabled) => {
            return failed(LoginError::Disabled, "the user is disabled");
        }
    };

    // No fixation: whatever session this browser had ends now.
    if let Some(old) = web::cookie(&headers, &inner.routes.session_cookie)
        && let Some(info) = inner.sessions.peek(old)
    {
        inner.sessions.end(&info.id, EndReason::Replaced, None);
    }
    let roles = signed_in
        .principal
        .roles
        .iter()
        .map(|r| r.as_str().to_owned())
        .collect();
    let issued = match inner.sessions.create(NewSession {
        user: signed_in.user.clone(),
        principal: signed_in.principal,
        groups: identity.groups.clone(),
        method: LoginMethod::Oidc,
        auth_time_ms: auth_time_ms.unwrap_or_else(|| inner.clock.now_unix_ms()),
        id_token: Some(id_token),
        client,
        must_change_password: false,
        must_enrol_totp: false,
    }) {
        Ok(issued) => issued,
        Err(_) => return failed(LoginError::Busy, "too many sessions"),
    };
    inner.hooks.record(AuthEvent::SignedIn {
        user: signed_in.user,
        session: issued.session_id.clone(),
        method: LoginMethod::Oidc,
        client,
        groups: identity.groups.len(),
        roles,
    });

    let mut response = (StatusCode::OK, web::continue_page(&pending.next)).into_response();
    let headers = response.headers_mut();
    web::auth_headers(headers);
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.append(
        header::SET_COOKIE,
        web::set_cookie(
            &inner.routes.session_cookie,
            &issued.cookie,
            SameSite::Strict,
            None,
        ),
    );
    headers.append(
        header::SET_COOKIE,
        web::clear_cookie(&inner.routes.login_cookie, SameSite::Lax),
    );
    response
}

/// The token request's form and `Authorization` header for the configured client authentication.
fn token_request(
    config: &OidcConfig,
    redirect_uri: &str,
    code: &str,
    verifier: &str,
) -> (Zeroizing<String>, Option<Zeroizing<String>>) {
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("grant_type", "authorization_code")
        .append_pair("code", code)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("code_verifier", verifier);
    let secret = config.client_secret.as_ref().map_or("", |s| s.as_str());
    let authorization = match config.token_auth {
        TokenAuth::Basic => {
            let user = encode_form_component(&config.client_id);
            let pass = Zeroizing::new(encode_form_component(secret));
            let pair = Zeroizing::new(format!("{user}:{}", pass.as_str()));
            Some(Zeroizing::new(format!(
                "Basic {}",
                STANDARD.encode(pair.as_bytes())
            )))
        }
        TokenAuth::Post => {
            form.append_pair("client_id", &config.client_id)
                .append_pair("client_secret", secret);
            None
        }
        TokenAuth::None => {
            form.append_pair("client_id", &config.client_id);
            None
        }
    };
    (Zeroizing::new(form.finish()), authorization)
}

/// `application/x-www-form-urlencoded` of one value, as RFC 6749 §2.3.1 asks before Basic.
fn encode_form_component(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Builds the identity from validated claims (DOC-25 §3.2.3).
fn identity(
    config: &OidcConfig,
    subject: String,
    auth_time_ms: Option<u64>,
    claims: Map<String, Value>,
) -> OidcIdentity {
    let text = |name: &str| {
        claims
            .get(name)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let display_name = text("name")
        .or_else(|| text("preferred_username"))
        .unwrap_or_else(|| subject.clone());
    let email = text("email");
    let mut at = Some(&Value::Object(claims.clone()));
    for part in config.groups_claim.split('.') {
        at = at.and_then(|v| v.get(part));
    }
    let raw: Vec<&str> = match at {
        Some(Value::String(one)) => vec![one.as_str()],
        Some(Value::Array(list)) if list.iter().all(Value::is_string) => {
            list.iter().filter_map(Value::as_str).collect()
        }
        _ => Vec::new(),
    };
    let mut groups = Vec::new();
    let mut dropped = 0;
    for group in raw {
        if group.is_empty() {
            continue;
        }
        if groups.len() >= MAX_GROUPS || group.len() > MAX_GROUP_BYTES {
            dropped += 1;
        } else if !groups.iter().any(|g| g == group) {
            groups.push(group.to_owned());
        }
    }
    OidcIdentity {
        issuer: config.issuer.clone(),
        subject,
        display_name,
        email,
        groups,
        groups_dropped: dropped,
        auth_time_ms,
        claims,
    }
}

async fn logout<H: SignInHooks>(
    State(inner): State<Arc<Inner<H>>>,
    client: Option<axum::Extension<ClientAddr>>,
    headers: HeaderMap,
) -> Response {
    let client = client_of(client.as_deref());
    let forbidden = || {
        let mut response = StatusCode::FORBIDDEN.into_response();
        web::auth_headers(response.headers_mut());
        response
    };
    if web::single_header(&headers, header::ORIGIN) != Some(inner.routes.public_origin.as_str()) {
        return forbidden();
    }
    let clear = web::clear_cookie(&inner.routes.session_cookie, SameSite::Strict);
    let home = inner.routes.home();
    let Some(cookie) = web::cookie(&headers, &inner.routes.session_cookie) else {
        let mut response = redirect(StatusCode::SEE_OTHER, &home);
        response.headers_mut().insert(header::SET_COOKIE, clear);
        return response;
    };
    let Some(expected) = inner.sessions.csrf_token(cookie) else {
        // Already ended: nothing to sign out of.
        let mut response = redirect(StatusCode::SEE_OTHER, &home);
        response.headers_mut().insert(header::SET_COOKIE, clear);
        return response;
    };
    let given = web::single_header(&headers, inner.routes.csrf_header.clone()).unwrap_or("");
    if given.is_empty() || !constant_time_eq(given.as_bytes(), expected.as_bytes()) {
        return forbidden();
    }
    let Some(ended) = inner.sessions.logout(cookie) else {
        let mut response = redirect(StatusCode::SEE_OTHER, &home);
        response.headers_mut().insert(header::SET_COOKIE, clear);
        return response;
    };
    inner.hooks.record(AuthEvent::SignedOut {
        user: ended.user.clone(),
        session: ended.id.clone(),
        client,
    });
    let mut location = format!("{}{}", inner.routes.public_origin, home);
    // A session signed in with a built-in account has no ID token: it is not signed out at the
    // IdP.
    if inner.config.idp_logout
        && ended.id_token.is_some()
        && let Some(loaded) = inner.provider.current()
        && let Some(end) = loaded.discovery.end_session_endpoint.as_ref()
    {
        let mut url = end.clone();
        {
            let mut query = url.query_pairs_mut();
            if let Some(id_token) = ended.id_token.as_ref() {
                query.append_pair("id_token_hint", id_token);
            }
            query
                .append_pair("client_id", &inner.config.client_id)
                .append_pair(
                    "post_logout_redirect_uri",
                    &format!("{}{}/", inner.routes.public_origin, inner.routes.base_path),
                );
        }
        location = url.into();
    }
    let mut response = redirect(StatusCode::SEE_OTHER, &location);
    response.headers_mut().insert(header::SET_COOKIE, clear);
    response
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> OidcConfig {
        let mut config = OidcConfig::new(
            "https://idp.test/dex",
            "mc",
            vec![CertificateDer::from(vec![1])],
        );
        config.client_secret = Some(Zeroizing::new("s".into()));
        config
    }

    #[test]
    fn config_checks() {
        assert_eq!(config().validate(), Ok(()));
        assert_eq!(config().display_name, "idp.test");
        let mut c = config();
        c.issuer = "http://idp.test".into();
        assert_eq!(c.validate(), Err(OidcConfigError::Issuer));
        let mut c = config();
        c.client_secret = None;
        assert_eq!(c.validate(), Err(OidcConfigError::ClientSecret));
        c.token_auth = TokenAuth::None;
        assert_eq!(c.validate(), Ok(()));
        let mut c = config();
        c.ca_certs.clear();
        assert_eq!(c.validate(), Err(OidcConfigError::Ca));
        let mut c = config();
        c.scopes = vec!["profile".into()];
        assert_eq!(c.validate(), Err(OidcConfigError::Scopes));
        let mut c = config();
        c.clock_skew = Duration::from_secs(301);
        assert_eq!(c.validate(), Err(OidcConfigError::ClockSkew));
        let mut c = config();
        c.groups_claim = "a..b".into();
        assert_eq!(c.validate(), Err(OidcConfigError::GroupsClaim));
        assert!(!format!("{:?}", config()).contains("\"s\""));
    }

    #[test]
    fn identity_maps_names_and_bounded_groups() {
        let mut c = config();
        c.groups_claim = "realm_access.roles".into();
        let mut groups: Vec<Value> = (0..300).map(|i| json!(format!("g{i}"))).collect();
        groups.push(json!("x".repeat(300)));
        let claims = json!({ "preferred_username": "alice", "email": "a@x",
            "realm_access": { "roles": groups } });
        let id = identity(
            &c,
            "sub-1".into(),
            None,
            claims.as_object().unwrap().clone(),
        );
        assert_eq!(id.display_name, "alice");
        assert_eq!(id.email.as_deref(), Some("a@x"));
        assert_eq!(id.groups.len(), MAX_GROUPS);
        assert_eq!(id.groups_dropped, 45);
        assert_eq!(id.principal_id(), "human:oidc:sub-1");
        let one = json!({ "groups": "ops" });
        let id = identity(
            &config(),
            "s".into(),
            None,
            one.as_object().unwrap().clone(),
        );
        assert_eq!(id.groups, ["ops"]);
        assert_eq!(id.display_name, "s");
        let mixed = json!({ "groups": ["ops", 1] });
        let id = identity(
            &config(),
            "s".into(),
            None,
            mixed.as_object().unwrap().clone(),
        );
        assert!(id.groups.is_empty());
    }

    #[test]
    fn rate_limits_count_per_minute_and_block_after_failures() {
        let ip: IpAddr = "10.0.0.1".parse().unwrap();
        let mut limit = RateLimit::default();
        for _ in 0..FAILED_CALLBACKS_PER_MINUTE {
            assert!(limit.hit(ip, 0, FAILED_CALLBACKS_PER_MINUTE, true));
        }
        assert!(!limit.blocked(ip, 1));
        assert!(!limit.hit(ip, 1, FAILED_CALLBACKS_PER_MINUTE, true));
        assert!(limit.blocked(ip, 60_000));
        assert!(!limit.blocked(ip, 60_001));
        let mut login = RateLimit::default();
        for _ in 0..LOGIN_PER_MINUTE {
            assert!(login.hit(ip, 0, LOGIN_PER_MINUTE, false));
        }
        assert!(!login.hit(ip, 10, LOGIN_PER_MINUTE, false));
        assert!(login.hit(ip, 60_000, LOGIN_PER_MINUTE, false));
    }

    #[test]
    fn the_redirect_uri_is_derived() {
        let mut routes = LoginRoutes::new("https://mc.test:7443");
        routes.base_path = "/tools/mc".into();
        assert_eq!(
            routes.redirect_uri(),
            "https://mc.test:7443/tools/mc/auth/callback"
        );
        assert_eq!(routes.validate(), Ok(()));
        routes.login_cookie = "mc_login".into();
        assert_eq!(routes.validate(), Err(OidcConfigError::Cookie));
    }
}
