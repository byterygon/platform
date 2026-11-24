//! Ambidex WebSocket transport on axum (Ambidex spec §4, §8 "Web", §9).
//!
//! One binary WebSocket per tab at [`RPC_WS_PATH`], served only over rustls TLS. The WebSocket is
//! a dumb byte pipe into the same [`ambidex::Server`] engine the Tauri transport uses; nothing in
//! this crate interprets frames.
//!
//! Before the engine sees a single byte:
//!
//! 1. TLS (rustls, ring provider) must complete within [`WsConfig::tls_handshake_timeout`].
//! 2. Every HTTP request, not only the upgrade, must name an allowed `Host` (DNS rebinding).
//! 3. The upgrade must carry an `Origin` exactly equal to [`WsConfig::public_origin`]
//!    (cross-site WebSocket hijacking). A missing origin is rejected.
//! 4. The upgrade must carry a session cookie that [`WebSessions`] resolves to a server-side
//!    session; the principal is built there, never from client input.
//!
//! Then the engine runs the Hello handshake, which must carry that session's anti-CSRF token.
//! Each WebSocket message is bounded by the engine's frame limit plus the 12-byte header, so a
//! client must send at most one maximum-size frame per message.
//!
//! Sign-in and sessions (DOC-25 §3.2): [`oidc`] is the OIDC login (authorization code with
//! PKCE), [`accounts`] the built-in accounts (passwords, sign-up, setup links), [`LoginSessions`]
//! the server-side sessions both create, with idle and absolute expiry
//! and revocation. An ended session's connections get Goaway `Unauthenticated`
//! ([`WebSessions::revocation`]), and every call a client starts counts as activity
//! ([`WebSessions::touch`]). Every request carries the peer's address as a [`ClientAddr`]
//! extension, for rate limits and the audit log.
//!
//! Not here: mTLS and plain HTTP behind a reverse proxy.

pub mod accounts;
pub mod oidc;
mod session;
mod store;
mod transport;
pub mod web;

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::ws::WebSocketUpgrade;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::net::TcpListener;
use tokio_rustls::TlsAcceptor;

use ambidex::engine::BoxFuture;
use ambidex::frame::HEADER_LEN;
use ambidex::{Call, Chunks, Dispatch, ErrorPayload, Events, Server, ServerConfig, Session};

pub use session::{IssuedSession, PlaceholderSessions, WebSession, WebSessions};
pub use store::{
    EndReason, EndedSession, IssuedLogin, LoginMethod, LoginSessions, NewSession, NoSessionEvents,
    PageSession, SessionEvents, SessionInfo, SessionLimits, SessionsFull, login_session_of,
};
pub use transport::{WsRx, WsTx, split};

/// The TCP peer of a request, inserted into every request's extensions by
/// [`WsTransport::serve`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClientAddr(pub SocketAddr);

/// Path of the RPC WebSocket (spec §4).
pub const RPC_WS_PATH: &str = "/rpc/ws";

/// Default session cookie name. The `__Host-` prefix makes browsers require `Secure`, `Path=/`
/// and no `Domain` (spec §8).
pub const DEFAULT_SESSION_COOKIE: &str = "__Host-ambidex_session";

/// Web transport configuration.
#[derive(Debug, Clone)]
pub struct WsConfig {
    /// Accepted `Host` header values, compared ASCII case-insensitively and otherwise exactly:
    /// list `host:port` when the server is not on the scheme's default port.
    pub allowed_hosts: Vec<String>,
    /// The configured public origin, e.g. `https://dbee.example.com`. The upgrade's `Origin`
    /// header must equal it byte for byte.
    pub public_origin: String,
    pub session_cookie: String,
    /// A path the product is served under (`""`, or e.g. `/tools/mc`): the WebSocket is then at
    /// `<path_prefix>/rpc/ws`. `/`-led segments of `A-Z a-z 0-9 - _ ~`, no trailing slash.
    pub path_prefix: String,
    /// Time allowed for the TLS handshake and for reading request headers.
    pub tls_handshake_timeout: Duration,
}

impl WsConfig {
    pub fn new(
        allowed_hosts: impl IntoIterator<Item = impl Into<String>>,
        public_origin: impl Into<String>,
    ) -> WsConfig {
        WsConfig {
            allowed_hosts: allowed_hosts.into_iter().map(Into::into).collect(),
            public_origin: public_origin.into(),
            session_cookie: DEFAULT_SESSION_COOKIE.into(),
            path_prefix: String::new(),
            tls_handshake_timeout: Duration::from_secs(10),
        }
    }

    fn validate(&self) -> Result<(), ConfigError> {
        if self.allowed_hosts.is_empty() || self.allowed_hosts.iter().any(|h| h.is_empty()) {
            return Err(ConfigError::AllowedHosts);
        }
        // A browser serializes an origin as lowercase `scheme://host[:port]`; anything else could
        // never match, so it is a configuration mistake.
        let origin = &self.public_origin;
        let rest = origin.strip_prefix("https://").unwrap_or("");
        if rest.is_empty()
            || rest.contains(['/', '?', '#', '@'])
            || origin
                .bytes()
                .any(|b| b.is_ascii_uppercase() || !b.is_ascii_graphic())
        {
            return Err(ConfigError::PublicOrigin);
        }
        if !self.session_cookie.starts_with("__Host-") {
            return Err(ConfigError::SessionCookie);
        }
        if !valid_path_prefix(&self.path_prefix) {
            return Err(ConfigError::PathPrefix);
        }
        Ok(())
    }

    /// Where the WebSocket is served: [`RPC_WS_PATH`] under [`WsConfig::path_prefix`].
    pub fn rpc_path(&self) -> String {
        format!("{}{RPC_WS_PATH}", self.path_prefix)
    }
}

/// `""`, or `/`-led segments of unreserved characters with no trailing slash.
pub fn valid_path_prefix(prefix: &str) -> bool {
    prefix.is_empty()
        || (prefix.starts_with('/')
            && prefix[1..].split('/').all(|s| {
                !s.is_empty()
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'~'))
            }))
}

/// Invalid [`WsConfig`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigError {
    /// No allowed hosts, or an empty entry.
    AllowedHosts,
    /// Not a lowercase `https://host[:port]` origin.
    PublicOrigin,
    /// The session cookie name lacks the `__Host-` prefix.
    SessionCookie,
    /// The path prefix is not `""` or `/`-led segments of unreserved characters.
    PathPrefix,
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ConfigError::AllowedHosts => "allowed_hosts must list at least one non-empty host",
            ConfigError::PublicOrigin => "public_origin must be a lowercase https://host[:port]",
            ConfigError::SessionCookie => "session_cookie must start with __Host-",
            ConfigError::PathPrefix => {
                "path_prefix must be empty or /-led segments of A-Z a-z 0-9 - _ ~"
            }
        })
    }
}

impl std::error::Error for ConfigError {}

/// The WebSocket transport: HTTP routes, upgrade checks and one engine per connection.
pub struct WsTransport<S, D> {
    state: Arc<Shared<S, D>>,
}

struct Shared<S, D> {
    config: WsConfig,
    engine: ServerConfig,
    sessions: S,
    dispatch: Arc<D>,
}

impl<S, D> Clone for WsTransport<S, D> {
    fn clone(&self) -> Self {
        WsTransport {
            state: Arc::clone(&self.state),
        }
    }
}

impl<S: WebSessions, D: Dispatch> WsTransport<S, D> {
    pub fn new(
        config: WsConfig,
        engine: ServerConfig,
        sessions: S,
        dispatch: D,
    ) -> Result<WsTransport<S, D>, ConfigError> {
        config.validate()?;
        Ok(WsTransport {
            state: Arc::new(Shared {
                config,
                engine,
                sessions,
                dispatch: Arc::new(dispatch),
            }),
        })
    }

    /// The axum router: [`RPC_WS_PATH`] merged with the product's own `routes`, all behind the
    /// Host check. Private on purpose: it is only served through [`WsTransport::serve`], so it is
    /// never reachable without TLS.
    fn router(&self, routes: Router) -> Router {
        Router::new()
            .route(&self.state.config.rpc_path(), get(upgrade::<S, D>))
            .with_state(Arc::clone(&self.state))
            .merge(routes)
            .layer(middleware::from_fn_with_state(
                Arc::clone(&self.state),
                check_host::<S, D>,
            ))
    }

    /// Serves `/rpc/ws` and the product's HTTP `routes` over TLS until `shutdown` resolves.
    /// Connections already open keep running.
    pub async fn serve(
        &self,
        listener: TcpListener,
        tls: Arc<rustls::ServerConfig>,
        routes: Router,
        shutdown: impl Future<Output = ()>,
    ) -> io::Result<()> {
        let app = self.router(routes);
        let acceptor = TlsAcceptor::from(tls);
        let timeout = self.state.config.tls_handshake_timeout;
        let mut shutdown = std::pin::pin!(shutdown);
        loop {
            let (tcp, peer): (_, SocketAddr) = tokio::select! {
                () = &mut shutdown => return Ok(()),
                accepted = listener.accept() => match accepted {
                    Ok(accepted) => accepted,
                    // Per-connection failures (e.g. the peer reset before accept) must not stop
                    // the server; the listener itself stays usable.
                    Err(_) => continue,
                },
            };
            // Every write is a whole frame, so Nagle's algorithm only adds delay: with it, a
            // stream's chunk can wait for the ACK of the frame before it (tens of milliseconds
            // with delayed ACKs) on every credit round trip.
            let _ = tcp.set_nodelay(true);
            let acceptor = acceptor.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let Ok(Ok(tls)) = tokio::time::timeout(timeout, acceptor.accept(tcp)).await else {
                    return;
                };
                let service = TowerToHyperService::new(app);
                let service = hyper::service::service_fn(
                    move |mut request: hyper::Request<hyper::body::Incoming>| {
                        request.extensions_mut().insert(ClientAddr(peer));
                        hyper::service::Service::call(&service, request)
                    },
                );
                let _ = hyper::server::conn::http1::Builder::new()
                    .timer(TokioTimer::new())
                    .header_read_timeout(timeout)
                    .serve_connection(TokioIo::new(tls), service)
                    .with_upgrades()
                    .await;
            });
        }
    }
}

/// Builds a rustls server config on the ring provider with the safe default protocol versions,
/// no client authentication (mTLS is M3) and ALPN `http/1.1` (the WebSocket upgrade is HTTP/1.1).
pub fn tls_server_config(
    cert_chain: Vec<CertificateDer<'static>>,
    key: PrivateKeyDer<'static>,
) -> Result<Arc<rustls::ServerConfig>, rustls::Error> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_no_client_auth()
        .with_single_cert(cert_chain, key)?;
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    Ok(Arc::new(config))
}

/// DNS-rebinding defense (spec §9): every request must name an allowed host.
async fn check_host<S: WebSessions, D: Dispatch>(
    State(state): State<Arc<Shared<S, D>>>,
    request: Request,
    next: Next,
) -> Response {
    let host = single_header(request.headers(), header::HOST);
    // An absolute-form request target overrides Host (RFC 9112 §3.2.2), so it must agree.
    let authority = request.uri().authority().map(|a| a.as_str());
    let allowed = match (host, authority) {
        (Some(host), None) => host_allowed(&state.config, host),
        (Some(host), Some(authority)) => {
            host.eq_ignore_ascii_case(authority) && host_allowed(&state.config, host)
        }
        (None, _) => false,
    };
    if !allowed {
        return StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    next.run(request).await
}

fn host_allowed(config: &WsConfig, host: &str) -> bool {
    config
        .allowed_hosts
        .iter()
        .any(|allowed| allowed.eq_ignore_ascii_case(host))
}

use web::single_header;

/// The session cookie's value, if it appears exactly once across all `Cookie` headers.
fn session_cookie<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    web::cookie(headers, name)
}

/// `GET /rpc/ws`: Origin, then session, then the upgrade. Nothing reaches the engine on failure.
async fn upgrade<S: WebSessions, D: Dispatch>(
    State(state): State<Arc<Shared<S, D>>>,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    // Cross-site WebSocket hijacking defense (spec §9): exact match, missing is rejected.
    if single_header(&headers, header::ORIGIN) != Some(state.config.public_origin.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(cookie) = session_cookie(&headers, &state.config.session_cookie) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(web) = state.sessions.lookup(cookie).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let ws = match ws {
        Ok(ws) => ws,
        Err(rejection) => return rejection.into_response(),
    };
    // One maximum-size frame per message; the engine still enforces its own (smaller,
    // pre-handshake) limits on the bytes inside.
    let max_message = state.engine.max_frame_bytes as usize + HEADER_LEN;
    ws.max_message_size(max_message)
        .max_frame_size(max_message)
        .on_upgrade(move |socket| async move {
            let server = Server::new(
                state.engine.clone(),
                session::CsrfAuth(web, StateSessions(Arc::clone(&state))),
                SharedDispatch(Arc::clone(&state)),
            );
            let (rx, tx) = split(socket);
            server.serve(rx, tx).closed().await;
        })
}

/// The transport's session store, as each connection's [`session::CsrfAuth`] sees it.
struct StateSessions<S, D>(Arc<Shared<S, D>>);

impl<S: WebSessions, D: Dispatch> WebSessions for StateSessions<S, D> {
    fn lookup<'a>(&'a self, cookie: &'a str) -> BoxFuture<'a, Option<WebSession>> {
        self.0.sessions.lookup(cookie)
    }

    fn revocation(&self, session: &Session) -> Option<ambidex::CancellationToken> {
        self.0.sessions.revocation(session)
    }

    fn touch(&self, session: &Session) {
        self.0.sessions.touch(session);
    }
}

/// Lets every per-connection engine share the one dispatcher, and records each call a client
/// starts as activity on its web session.
struct SharedDispatch<S, D>(Arc<Shared<S, D>>);

impl<S: WebSessions, D: Dispatch> Dispatch for SharedDispatch<S, D> {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<serde_json::Value, ErrorPayload>> {
        self.0.sessions.touch(&session);
        self.0.dispatch.call(session, call)
    }

    fn call_stream(
        &self,
        session: Arc<Session>,
        call: Call,
        chunks: Chunks,
    ) -> BoxFuture<'static, Result<serde_json::Value, ErrorPayload>> {
        self.0.sessions.touch(&session);
        self.0.dispatch.call_stream(session, call, chunks)
    }

    fn subscribe(
        &self,
        session: Arc<Session>,
        call: Call,
        events: Events,
    ) -> BoxFuture<'static, Result<(), ErrorPayload>> {
        self.0.sessions.touch(&session);
        self.0.dispatch.subscribe(session, call, events)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(name.clone(), HeaderValue::from_str(value).unwrap());
        }
        map
    }

    #[test]
    fn config_validation() {
        let ok = WsConfig::new(["dbee.example.com"], "https://dbee.example.com:8443");
        assert_eq!(ok.validate(), Ok(()));
        let bad_origins = [
            "http://dbee.example.com",
            "https://",
            "https://dbee.example.com/",
            "https://Dbee.example.com",
            "https://user@dbee.example.com",
            "null",
        ];
        for origin in bad_origins {
            let config = WsConfig::new(["dbee.example.com"], origin);
            assert_eq!(
                config.validate(),
                Err(ConfigError::PublicOrigin),
                "{origin}"
            );
        }
        let none: [&str; 0] = [];
        let config = WsConfig::new(none, "https://dbee.example.com");
        assert_eq!(config.validate(), Err(ConfigError::AllowedHosts));
        let mut config = ok.clone();
        config.session_cookie = "session".into();
        assert_eq!(config.validate(), Err(ConfigError::SessionCookie));
        for (prefix, valid) in [
            ("", true),
            ("/mc", true),
            ("/tools/mc-1_~", true),
            ("/", false),
            ("mc", false),
            ("/mc/", false),
            ("/a//b", false),
            ("/a/../b", false),
            ("/a%2fb", false),
        ] {
            let mut config = ok.clone();
            config.path_prefix = prefix.into();
            assert_eq!(config.validate().is_ok(), valid, "{prefix}");
        }
        let mut config = ok.clone();
        config.path_prefix = "/mc".into();
        assert_eq!(config.rpc_path(), "/mc/rpc/ws");
    }

    #[test]
    fn session_cookie_parsing() {
        let name = DEFAULT_SESSION_COOKIE;
        let h = headers(&[(header::COOKIE, "a=1; __Host-ambidex_session=abc; b=2")]);
        assert_eq!(session_cookie(&h, name), Some("abc"));
        let h = headers(&[(header::COOKIE, "ambidex_session=abc")]);
        assert_eq!(session_cookie(&h, name), None);
        let h = headers(&[(header::COOKIE, "__Host-ambidex_session=")]);
        assert_eq!(session_cookie(&h, name), None);
        let h = headers(&[
            (header::COOKIE, "__Host-ambidex_session=abc"),
            (header::COOKIE, "__Host-ambidex_session=def"),
        ]);
        assert_eq!(session_cookie(&h, name), None);
        assert_eq!(session_cookie(&HeaderMap::new(), name), None);
    }

    #[test]
    fn duplicate_headers_are_not_single() {
        let h = headers(&[
            (header::ORIGIN, "https://a.example"),
            (header::ORIGIN, "https://a.example"),
        ]);
        assert_eq!(single_header(&h, header::ORIGIN), None);
    }
}
