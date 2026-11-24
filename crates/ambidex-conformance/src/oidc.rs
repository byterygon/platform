//! Sign-in conformance (DOC-25 §3.2, §6 "Login and sessions"): the real `ambidex-axum` OIDC
//! routes and session store, served by the WebSocket harness, against [`TestIdp`], an identity
//! provider in this process over real TLS on loopback. A [`Browser`] follows the redirects and
//! keeps cookies as a browser would.
//!
//! Applies to the WebSocket transport only (the desktop has no login). Every case runs on a fresh
//! server and IdP ([`run`]); times (token `iat`/`exp`, session timeouts, the pending login's
//! lifetime) are on the fixture's [`ManualClock`](crate::ManualClock), which cases move by hand.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex_axum::oidc::{
    AuthEvent, LoginError, LoginRoutes, OidcConfig, OidcIdentity, OidcLogin, SignInHooks,
    SignInRefusal, SignedIn,
};
use ambidex_axum::{LoginSessions, NoSessionEvents, SessionLimits};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use security_types::{Clock, Principal, PrincipalKind, SessionId, TenantId};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::{TlsAcceptor, TlsConnector};
use url::Url;

use crate::client::Client;
use crate::fixture::Fixture;
use crate::harness::Harness;
use crate::ws::{HOST, ORIGIN, Ws};

/// The client the server is registered as at the [`TestIdp`].
pub const CLIENT_ID: &str = "mightyconsole";
/// Its secret (`client_secret_basic`).
pub const CLIENT_SECRET: &str = "test-client-secret";
/// The anti-CSRF header the routes are configured with.
pub const CSRF_HEADER: &str = "x-test-csrf";
/// The login cookie the routes are configured with.
pub const LOGIN_COOKIE: &str = "__Host-test_login";

/// How a [`TestIdp`] spoils the next ID token it issues.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tamper {
    Audience,
    Issuer,
    Nonce,
    /// `exp` this many seconds before now.
    ExpiredBy(u64),
    /// `iat` and `nbf` this many seconds after now.
    AheadBy(u64),
    /// Unsigned (`alg: none`, empty signature).
    AlgNone,
    /// HMAC with the client secret, the classic key-confusion attempt.
    Hs256,
    /// Signed with a key the JWKS does not list.
    UnknownKey,
    /// Several audiences and no `azp`.
    ExtraAudience,
}

struct SigningKey {
    kid: String,
    der: Vec<u8>,
    jwk: Value,
}

impl SigningKey {
    fn new(kid: &str) -> SigningKey {
        let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).expect("key");
        let point = pair.public_key_raw().to_vec();
        SigningKey {
            kid: kid.into(),
            der: pair.serialize_der(),
            jwk: json!({
                "kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256",
                "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
                "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
            }),
        }
    }

    fn sign(&self, kid: &str, claims: &Value) -> String {
        let mut header = Header::new(Algorithm::ES256);
        header.kid = Some(kid.into());
        jsonwebtoken::encode(&header, claims, &EncodingKey::from_ec_der(&self.der)).expect("sign")
    }
}

struct Grant {
    redirect_uri: String,
    challenge: String,
    nonce: String,
    sub: String,
    used: bool,
}

/// A user the IdP signs in.
#[derive(Debug, Clone)]
pub struct TestUser {
    pub sub: String,
    pub name: String,
    pub groups: Vec<String>,
}

#[derive(Default)]
struct Counters {
    discovery: usize,
    jwks: usize,
    token: usize,
    end_session: usize,
}

struct IdpState {
    keys: Vec<SigningKey>,
    /// The key that signs: the last one, unless rotation keeps it out of the JWKS.
    signing: usize,
    published: usize,
    codes: HashMap<String, Grant>,
    user: TestUser,
    tamper: Option<Tamper>,
    deny: bool,
    down: bool,
    counters: Counters,
    last_authorize: Option<HashMap<String, String>>,
}

struct IdpShared {
    issuer: String,
    redirect_uri: String,
    clock: Arc<dyn Clock>,
    state: Mutex<IdpState>,
}

impl IdpShared {
    fn lock(&self) -> MutexGuard<'_, IdpState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// An OIDC provider for tests: discovery, JWKS, an authorization endpoint that signs the
/// configured user in at once, a token endpoint that checks the client, the code, the redirect
/// URI and the PKCE verifier (codes are single use), userinfo and an end-session endpoint.
pub struct TestIdp {
    shared: Arc<IdpShared>,
    cert: CertificateDer<'static>,
    port: u16,
    task: JoinHandle<()>,
}

impl TestIdp {
    /// Serves on 127.0.0.1 with a fresh certificate; `redirect_uri` is the one registered client
    /// redirect URI.
    pub async fn start(clock: Arc<dyn Clock>, redirect_uri: &str) -> TestIdp {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.subject_alt_names =
            vec![rcgen::SanType::IpAddress("127.0.0.1".parse().expect("ip"))];
        let key = rcgen::KeyPair::generate().expect("key");
        let cert = params.self_signed(&key).expect("certificate");
        let cert_der = CertificateDer::from(cert.der().to_vec());
        let tls = ambidex_axum::tls_server_config(
            vec![cert_der.clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .expect("TLS config");
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let shared = Arc::new(IdpShared {
            issuer: format!("https://127.0.0.1:{port}/dex"),
            redirect_uri: redirect_uri.into(),
            clock,
            state: Mutex::new(IdpState {
                keys: vec![SigningKey::new("key-1")],
                signing: 0,
                published: 1,
                codes: HashMap::new(),
                user: TestUser {
                    sub: "alice".into(),
                    name: "Alice".into(),
                    groups: vec!["ops".into()],
                },
                tamper: None,
                deny: false,
                down: false,
                counters: Counters::default(),
                last_authorize: None,
            }),
        });
        let app = axum::Router::new()
            .route("/dex/.well-known/openid-configuration", get(discovery))
            .route("/dex/keys", get(jwks))
            .route("/dex/auth", get(authorize))
            .route("/dex/token", post(token))
            .route("/dex/userinfo", get(userinfo))
            .route("/dex/logout", get(end_session))
            .layer(axum::middleware::from_fn_with_state(
                Arc::clone(&shared),
                down_on_open_connections,
            ))
            .with_state(Arc::clone(&shared));
        let acceptor = TlsAcceptor::from(tls);
        let serving = Arc::clone(&shared);
        let task = tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    continue;
                };
                if serving.lock().down {
                    // Down: the connection closes before TLS.
                    drop(tcp);
                    continue;
                }
                let acceptor = acceptor.clone();
                let app = app.clone();
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(tcp).await else {
                        return;
                    };
                    let _ = hyper::server::conn::http1::Builder::new()
                        .timer(TokioTimer::new())
                        .serve_connection(TokioIo::new(tls), TowerToHyperService::new(app))
                        .await;
                });
            }
        });
        TestIdp {
            shared,
            cert: cert_der,
            port,
            task,
        }
    }

    pub fn issuer(&self) -> &str {
        &self.shared.issuer
    }

    /// The IdP's certificate, the only CA the server is given.
    pub fn ca(&self) -> CertificateDer<'static> {
        self.cert.clone()
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Who the next sign-in is.
    pub fn set_user(&self, user: TestUser) {
        self.shared.lock().user = user;
    }

    /// Spoils the next ID tokens (until set back to `None`).
    pub fn tamper(&self, tamper: Option<Tamper>) {
        self.shared.lock().tamper = tamper;
    }

    /// The authorization endpoint answers `error=access_denied`.
    pub fn deny(&self, deny: bool) {
        self.shared.lock().deny = deny;
    }

    /// Every connection closes at once while down.
    pub fn set_down(&self, down: bool) {
        self.shared.lock().down = down;
    }

    /// A new signing key that the JWKS lists from now on beside the old ones; with
    /// `drop_old`, the JWKS lists only the new key.
    pub fn rotate(&self, drop_old: bool) {
        let mut state = self.shared.lock();
        let kid = format!("key-{}", state.keys.len() + 1);
        state.keys.push(SigningKey::new(&kid));
        state.signing = state.keys.len() - 1;
        state.published = if drop_old { 1 } else { state.keys.len() };
    }

    /// How often discovery, the JWKS, the token endpoint and end-session were requested.
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let state = self.shared.lock();
        let c = &state.counters;
        (c.discovery, c.jwks, c.token, c.end_session)
    }

    /// The query of the last authorization request.
    pub fn last_authorize(&self) -> Option<HashMap<String, String>> {
        self.shared.lock().last_authorize.clone()
    }

    pub fn shutdown(self) {
        self.task.abort();
    }
}

/// While down, a connection opened before answers 503 (new ones are closed before TLS).
async fn down_on_open_connections(
    State(idp): State<Arc<IdpShared>>,
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    if idp.lock().down {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    next.run(request).await
}

async fn discovery(State(idp): State<Arc<IdpShared>>) -> Response {
    idp.lock().counters.discovery += 1;
    let base = &idp.issuer;
    axum::Json(json!({
        "issuer": base,
        "authorization_endpoint": format!("{base}/auth"),
        "token_endpoint": format!("{base}/token"),
        "jwks_uri": format!("{base}/keys"),
        "userinfo_endpoint": format!("{base}/userinfo"),
        "end_session_endpoint": format!("{base}/logout"),
        "response_types_supported": ["code"],
        "code_challenge_methods_supported": ["S256"],
        "id_token_signing_alg_values_supported": ["ES256"],
    }))
    .into_response()
}

async fn jwks(State(idp): State<Arc<IdpShared>>) -> Response {
    let mut state = idp.lock();
    state.counters.jwks += 1;
    let skip = state.keys.len() - state.published;
    let keys: Vec<Value> = state
        .keys
        .iter()
        .skip(skip)
        .map(|k| k.jwk.clone())
        .collect();
    axum::Json(json!({ "keys": keys })).into_response()
}

async fn authorize(
    State(idp): State<Arc<IdpShared>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let mut state = idp.lock();
    state.last_authorize = Some(query.clone());
    let param = |name: &str| query.get(name).cloned().unwrap_or_default();
    let redirect = param("redirect_uri");
    if param("client_id") != CLIENT_ID
        || redirect != idp.redirect_uri
        || param("response_type") != "code"
        || param("code_challenge_method") != "S256"
    {
        return (StatusCode::BAD_REQUEST, "bad authorization request").into_response();
    }
    let mut target = Url::parse(&redirect).expect("registered URI");
    if state.deny {
        target
            .query_pairs_mut()
            .append_pair("error", "access_denied")
            .append_pair("state", &param("state"));
    } else {
        let code = URL_SAFE_NO_PAD.encode(rand_bytes());
        let sub = state.user.sub.clone();
        state.codes.insert(
            code.clone(),
            Grant {
                redirect_uri: redirect,
                challenge: param("code_challenge"),
                nonce: param("nonce"),
                sub,
                used: false,
            },
        );
        target
            .query_pairs_mut()
            .append_pair("code", &code)
            .append_pair("state", &param("state"));
    }
    (StatusCode::FOUND, [(header::LOCATION, target.to_string())]).into_response()
}

fn rand_bytes() -> [u8; 32] {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("randomness");
    bytes
}

#[derive(Deserialize)]
struct TokenForm {
    grant_type: String,
    code: String,
    redirect_uri: String,
    code_verifier: String,
}

fn invalid_grant() -> Response {
    (
        StatusCode::BAD_REQUEST,
        axum::Json(json!({ "error": "invalid_grant" })),
    )
        .into_response()
}

async fn token(
    State(idp): State<Arc<IdpShared>>,
    headers: HeaderMap,
    axum::Form(form): axum::Form<TokenForm>,
) -> Response {
    let expected = format!(
        "Basic {}",
        STANDARD.encode(format!("{CLIENT_ID}:{CLIENT_SECRET}"))
    );
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some(&expected)
    {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(json!({ "error": "invalid_client" })),
        )
            .into_response();
    }
    let mut state = idp.lock();
    state.counters.token += 1;
    if form.grant_type != "authorization_code" {
        return invalid_grant();
    }
    let Some(grant) = state.codes.get_mut(&form.code) else {
        return invalid_grant();
    };
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(form.code_verifier.as_bytes()));
    if grant.used || grant.redirect_uri != form.redirect_uri || grant.challenge != challenge {
        // A used code stays used: a replay is refused like a wrong verifier.
        grant.used = true;
        return invalid_grant();
    }
    grant.used = true;
    let nonce = grant.nonce.clone();
    let sub = grant.sub.clone();
    let now = idp.clock.now_unix_ms() / 1000;
    let mut claims = json!({
        "iss": idp.issuer, "aud": CLIENT_ID, "sub": sub, "nonce": nonce,
        "iat": now, "exp": now + 300, "auth_time": now,
        "name": state.user.name, "email": format!("{}@example.test", state.user.sub),
        "groups": state.user.groups,
    });
    let signing = &state.keys[state.signing];
    let mut kid = signing.kid.clone();
    let id_token = match state.tamper {
        None => signing.sign(&kid, &claims),
        Some(tamper) => {
            match tamper {
                Tamper::Audience => claims["aud"] = json!("someone-else"),
                Tamper::Issuer => claims["iss"] = json!("https://127.0.0.1:1/other"),
                Tamper::Nonce => claims["nonce"] = json!("not-the-nonce"),
                Tamper::ExpiredBy(s) => {
                    claims["exp"] = json!(now - s);
                    claims["iat"] = json!(now - s - 300);
                }
                Tamper::AheadBy(s) => {
                    claims["iat"] = json!(now + s);
                    claims["nbf"] = json!(now + s);
                }
                Tamper::ExtraAudience => claims["aud"] = json!([CLIENT_ID, "other"]),
                Tamper::UnknownKey => kid = "key-unknown".into(),
                Tamper::AlgNone | Tamper::Hs256 => {}
            }
            match tamper {
                Tamper::AlgNone => format!(
                    "{}.{}.",
                    URL_SAFE_NO_PAD.encode(json!({ "alg": "none", "kid": kid }).to_string()),
                    URL_SAFE_NO_PAD.encode(claims.to_string())
                ),
                Tamper::Hs256 => {
                    let mut header = Header::new(Algorithm::HS256);
                    header.kid = Some(kid);
                    jsonwebtoken::encode(
                        &header,
                        &claims,
                        &EncodingKey::from_secret(CLIENT_SECRET.as_bytes()).expect("key"),
                    )
                    .expect("sign")
                }
                Tamper::UnknownKey => SigningKey::new("key-unknown").sign(&kid, &claims),
                _ => signing.sign(&kid, &claims),
            }
        }
    };
    axum::Json(json!({
        "access_token": "test-access-token", "token_type": "Bearer", "expires_in": 300,
        "id_token": id_token,
    }))
    .into_response()
}

async fn userinfo(State(idp): State<Arc<IdpShared>>, headers: HeaderMap) -> Response {
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        != Some("Bearer test-access-token")
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let state = idp.lock();
    axum::Json(
        json!({ "sub": state.user.sub, "name": state.user.name, "groups": state.user.groups }),
    )
    .into_response()
}

async fn end_session(State(idp): State<Arc<IdpShared>>) -> Response {
    idp.lock().counters.end_session += 1;
    (StatusCode::OK, "signed out").into_response()
}

/// What the server's [`SignInHooks`] saw: every event, in order.
#[derive(Default)]
pub struct RecordingHooks {
    events: Mutex<Vec<AuthEvent>>,
    disabled: Mutex<HashSet<String>>,
}

impl RecordingHooks {
    pub fn events(&self) -> Vec<AuthEvent> {
        self.events.lock().expect("events").clone()
    }

    /// The reasons of every failed sign-in so far.
    pub fn failures(&self) -> Vec<(LoginError, String)> {
        self.events()
            .into_iter()
            .filter_map(|e| match e {
                AuthEvent::SignInFailed { error, reason, .. } => Some((error, reason)),
                _ => None,
            })
            .collect()
    }

    pub fn disable(&self, sub: &str) {
        self.disabled.lock().expect("disabled").insert(sub.into());
    }
}

impl SignInHooks for RecordingHooks {
    fn sign_in<'a>(
        &'a self,
        identity: &'a OidcIdentity,
    ) -> BoxFuture<'a, Result<SignedIn, SignInRefusal>> {
        let refused = self
            .disabled
            .lock()
            .expect("disabled")
            .contains(&identity.subject);
        let user = identity.principal_id();
        Box::pin(async move {
            if refused {
                return Err(SignInRefusal::Disabled);
            }
            Ok(SignedIn {
                principal: Principal {
                    kind: PrincipalKind::Human,
                    id: user.clone(),
                    tenant: TenantId::new("default"),
                    on_behalf_of: None,
                    roles: vec![],
                    session: SessionId::new("set per connection"),
                },
                user,
            })
        })
    }

    fn record(&self, event: AuthEvent) {
        self.events.lock().expect("events").push(event);
    }
}

/// The WebSocket harness with the sign-in routes, a [`TestIdp`] and the hooks.
pub struct SignInServer {
    pub ws: Ws,
    pub idp: TestIdp,
    pub hooks: Arc<RecordingHooks>,
    pub login: OidcLogin<Arc<RecordingHooks>>,
}

/// Session limits small enough to reach in a case.
pub const LIMITS: SessionLimits = SessionLimits {
    idle: Duration::from_secs(60 * 60),
    absolute: Duration::from_secs(12 * 60 * 60),
    max_per_user: 10,
    max_total: 1000,
};

impl SignInServer {
    /// A server whose IdP is up and discovered (unless `discover` is false).
    pub async fn start(discover: bool) -> SignInServer {
        let fixture = Fixture::new();
        let clock: Arc<dyn Clock> = fixture.clock.clone();
        let sessions = Arc::new(LoginSessions::new(
            Arc::clone(&clock),
            LIMITS,
            Arc::new(NoSessionEvents),
        ));
        let mut routes = LoginRoutes::new(ORIGIN);
        routes.login_cookie = LOGIN_COOKIE.into();
        routes.csrf_header = header::HeaderName::from_static(CSRF_HEADER);
        let idp = TestIdp::start(Arc::clone(&clock), &routes.redirect_uri()).await;
        let mut config = OidcConfig::new(idp.issuer(), CLIENT_ID, vec![idp.ca()]);
        config.client_secret = Some(CLIENT_SECRET.to_owned().into());
        config.scopes.push("groups".into());
        let hooks = Arc::new(RecordingHooks::default());
        let login = OidcLogin::new(
            config,
            routes,
            Arc::clone(&sessions),
            Arc::clone(&hooks),
            clock,
        )
        .expect("valid configuration");
        if discover {
            login.discover().await.expect("the test IdP is up");
        }
        let router = login.routes();
        let ws = Ws::start_with(fixture, sessions, move |_| router).await;
        SignInServer {
            ws,
            idp,
            hooks,
            login,
        }
    }

    pub fn clock(&self) -> &crate::ManualClock {
        &self.ws.fixture().clock
    }

    pub fn browser(&self) -> Browser<'_> {
        Browser {
            server: self,
            cookies: HashMap::new(),
            set_cookies: Vec::new(),
        }
    }

    pub async fn shutdown(self) {
        self.idp.shutdown();
        self.ws.shutdown().await;
    }
}

/// Runs a sign-in case on a fresh server and IdP, on a current-thread runtime.
pub fn run<F>(discover: bool, case: F)
where
    F: AsyncFnOnce(&SignInServer),
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime")
        .block_on(async {
            let server = SignInServer::start(discover).await;
            case(&server).await;
            server.shutdown().await;
        });
}

/// An HTTP answer.
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: String,
}

impl Answer {
    pub fn location(&self) -> Option<&str> {
        self.headers
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
    }
}

/// A browser: a cookie jar and redirect-following against the server and the IdP.
pub struct Browser<'s> {
    server: &'s SignInServer,
    cookies: HashMap<String, String>,
    /// Every `Set-Cookie` the server sent, in order.
    pub set_cookies: Vec<String>,
}

impl Browser<'_> {
    pub fn cookie(&self, name: &str) -> Option<&str> {
        self.cookies.get(name).map(String::as_str)
    }

    pub fn set_cookie(&mut self, name: &str, value: &str) {
        self.cookies.insert(name.into(), value.into());
    }

    pub fn forget(&mut self, name: &str) {
        self.cookies.remove(name);
    }

    fn take_cookies(&mut self, headers: &HeaderMap) {
        for value in headers.get_all(header::SET_COOKIE) {
            let text = value.to_str().expect("ASCII cookie").to_owned();
            let (pair, attributes) = text.split_once(';').unwrap_or((&text, ""));
            let (name, value) = pair.split_once('=').expect("name=value");
            if attributes.contains("Max-Age=0") {
                self.cookies.remove(name);
            } else {
                self.cookies.insert(name.into(), value.into());
            }
            self.set_cookies.push(text);
        }
    }

    /// A request to the server (through `Host: conformance.test`), with the jar's cookies.
    pub async fn request(
        &mut self,
        method: &str,
        path_and_query: &str,
        headers: &[(&str, &str)],
    ) -> Answer {
        let stream = self.server.ws.tls().await;
        let mut builder = hyper::Request::builder()
            .method(method)
            .uri(path_and_query)
            .header(header::HOST, HOST);
        if !self.cookies.is_empty() {
            let jar: Vec<String> = self
                .cookies
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect();
            builder = builder.header(header::COOKIE, jar.join("; "));
        }
        for (name, value) in headers {
            builder = builder.header(*name, *value);
        }
        let answer = send(
            stream,
            builder.body(Full::new(Bytes::new())).expect("request"),
        )
        .await;
        self.take_cookies(&answer.headers);
        answer
    }

    /// A GET to the IdP (a URL the server redirected to), with no cookies.
    pub async fn idp_get(&mut self, url: &str) -> Answer {
        let url = Url::parse(url).expect("IdP URL");
        assert_eq!(
            url.port(),
            Some(self.server.idp.port()),
            "only the test IdP: {url}"
        );
        let mut roots = rustls::RootCertStore::empty();
        roots.add(self.server.idp.ca()).expect("root");
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        let tcp = TcpStream::connect(("127.0.0.1", self.server.idp.port()))
            .await
            .expect("connect");
        let stream = TlsConnector::from(Arc::new(config))
            .connect(
                ServerName::IpAddress(IpAddr::from([127, 0, 0, 1]).into()),
                tcp,
            )
            .await
            .expect("TLS to the IdP");
        let path = match url.query() {
            Some(q) => format!("{}?{q}", url.path()),
            None => url.path().to_owned(),
        };
        let request = hyper::Request::get(path)
            .header(
                header::HOST,
                format!("127.0.0.1:{}", self.server.idp.port()),
            )
            .body(Full::new(Bytes::new()))
            .expect("request");
        send(stream, request).await
    }

    /// `GET /auth/login?next=…`; on success the answer is the 302 to the IdP.
    pub async fn start_login(&mut self, next: &str) -> Answer {
        let next: String = url::form_urlencoded::byte_serialize(next.as_bytes()).collect();
        self.request("GET", &format!("/auth/login?next={next}"), &[])
            .await
    }

    /// The IdP's redirect back for a login start: the callback path and query on the server.
    pub async fn at_idp(&mut self, start: &Answer) -> String {
        assert_eq!(start.status, 302, "{start:?}");
        let back = self.idp_get(start.location().expect("Location")).await;
        assert_eq!(back.status, 302, "{back:?}");
        let back = Url::parse(back.location().expect("Location")).expect("redirect URI");
        assert_eq!(back.origin().ascii_serialization(), ORIGIN);
        format!("{}?{}", back.path(), back.query().unwrap_or(""))
    }

    /// The whole sign-in: login, the IdP, the callback. Returns the callback's answer.
    pub async fn sign_in(&mut self, next: &str) -> Answer {
        let start = self.start_login(next).await;
        let callback = self.at_idp(&start).await;
        self.request("GET", &callback, &[]).await
    }

    /// The session's anti-CSRF token, as the page would get it.
    pub fn csrf(&self) -> Option<String> {
        let cookie = self.cookie(ambidex_axum::DEFAULT_SESSION_COOKIE)?;
        self.server
            .ws
            .sessions()
            .csrf_token(cookie)
            .map(|t| t.to_string())
    }

    /// A WebSocket client on the browser's session (Hello done).
    pub async fn connect(&self) -> Client {
        let cookie = self
            .cookie(ambidex_axum::DEFAULT_SESSION_COOKIE)
            .expect("signed in");
        let socket = self
            .server
            .ws
            .upgrade(HOST, Some(ORIGIN), Some(cookie))
            .await
            .expect("upgrade");
        let mut client = Ws::client(socket, &self.csrf().expect("live session"));
        client.handshake().await;
        client
    }

    /// `POST /auth/logout` with the Origin and the anti-CSRF token.
    pub async fn logout(&mut self) -> Answer {
        let csrf = self.csrf().unwrap_or_default();
        self.request(
            "POST",
            "/auth/logout",
            &[("origin", ORIGIN), (CSRF_HEADER, &csrf)],
        )
        .await
    }
}

pub(crate) async fn send<S>(stream: S, request: hyper::Request<Full<Bytes>>) -> Answer
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .expect("HTTP handshake");
    tokio::spawn(connection);
    let response = sender.send_request(request).await.expect("HTTP answer");
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    Answer {
        status,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    }
}

/// The `login_error` a failed sign-in redirected to.
pub fn login_error(answer: &Answer) -> Option<String> {
    let location = answer.location()?;
    let url = Url::parse(&format!("{ORIGIN}{location}")).ok()?;
    url.query_pairs()
        .find(|(k, _)| k == "login_error")
        .map(|(_, v)| v.into_owned())
}

/// Asserts a sign-in failed with `error`, recorded with a reason containing `reason`, and left
/// no session behind.
pub fn assert_refused(s: &SignInServer, answer: &Answer, error: LoginError, reason: &str) {
    assert_eq!(answer.status, 303, "{answer:?}");
    assert_eq!(
        login_error(answer).as_deref(),
        Some(error.as_str()),
        "{answer:?}"
    );
    let failures = s.hooks.failures();
    let (got, why) = failures.last().expect("a recorded failure");
    assert_eq!(*got, error);
    assert!(
        why.contains(reason),
        "reason {why:?} should mention {reason:?}"
    );
    assert!(
        !answer.body.contains(reason),
        "the reason never reaches the browser"
    );
}

/// The session cookie's `Set-Cookie` of a sign-in.
pub fn session_set_cookie(browser: &Browser<'_>) -> Option<String> {
    let prefix = format!("{}=", ambidex_axum::DEFAULT_SESSION_COOKIE);
    browser
        .set_cookies
        .iter()
        .rev()
        .find(|c| c.starts_with(&prefix) && !c.contains("Max-Age=0"))
        .cloned()
}
