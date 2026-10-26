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
//! Not here yet (M3, web security): OIDC login and `/auth/session`, session expiry and
//! revocation with Goaway, mTLS, plain HTTP behind a reverse proxy, connection and rate limits.

mod session;
mod transport;

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
use ambidex::{Call, Dispatch, ErrorPayload, Server, ServerConfig, Session};

pub use session::{IssuedSession, PlaceholderSessions, WebSession, WebSessions};
pub use transport::{WsRx, WsTx, split};

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
        Ok(())
    }
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
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ConfigError::AllowedHosts => "allowed_hosts must list at least one non-empty host",
            ConfigError::PublicOrigin => "public_origin must be a lowercase https://host[:port]",
            ConfigError::SessionCookie => "session_cookie must start with __Host-",
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
            .route(RPC_WS_PATH, get(upgrade::<S, D>))
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
            let (tcp, _peer): (_, SocketAddr) = tokio::select! {
                () = &mut shutdown => return Ok(()),
                accepted = listener.accept() => match accepted {
                    Ok(accepted) => accepted,
                    // Per-connection failures (e.g. the peer reset before accept) must not stop
                    // the server; the listener itself stays usable.
                    Err(_) => continue,
                },
            };
            let acceptor = acceptor.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let Ok(Ok(tls)) = tokio::time::timeout(timeout, acceptor.accept(tcp)).await else {
                    return;
                };
                let service = TowerToHyperService::new(app);
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

/// The value of a header that must appear exactly once, as text.
fn single_header(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next()?;
    if values.next().is_some() {
        return None;
    }
    value.to_str().ok()
}

/// The session cookie's value, if it appears exactly once across all `Cookie` headers.
fn session_cookie<'h>(headers: &'h HeaderMap, name: &str) -> Option<&'h str> {
    let mut found = None;
    for header in headers.get_all(header::COOKIE) {
        let header = header.to_str().ok()?;
        for pair in header.split(';') {
            let Some((key, value)) = pair.trim().split_once('=') else {
                continue;
            };
            if key == name {
                if found.is_some() {
                    // Two cookies of the same name (e.g. one planted by a sibling subdomain
                    // without the prefix): ambiguous, so fail closed.
                    return None;
                }
                found = Some(value);
            }
        }
    }
    found.filter(|value| !value.is_empty())
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
                session::CsrfAuth(web),
                SharedDispatch(Arc::clone(&state.dispatch)),
            );
            let (rx, tx) = split(socket);
            server.serve(rx, tx).closed().await;
        })
}

/// Lets every per-connection engine share the one dispatcher.
struct SharedDispatch<D>(Arc<D>);

impl<D: Dispatch> Dispatch for SharedDispatch<D> {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<serde_json::Value, ErrorPayload>> {
        self.0.call(session, call)
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
