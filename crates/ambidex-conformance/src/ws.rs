//! WebSocket harness: the real [`WsTransport`] (axum, rustls TLS) on an ephemeral loopback port.
//!
//! A self-signed certificate is generated per server, so nothing is read from disk or fetched.
//! Every connection gets its own placeholder web session (cookie plus anti-CSRF token) and passes
//! the Host, Origin and cookie checks like a browser tab would.

use std::io;
use std::sync::Arc;

use ambidex_axum::{PlaceholderSessions, RPC_WS_PATH, WsConfig, WsTransport, tls_server_config};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::json;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use crate::client::{Client, LocalBoxFuture, Wire};
use crate::fixture::{Fixture, server_config};
use crate::harness::{Harness, Unsupported};

/// Host the server accepts.
pub const HOST: &str = "conformance.test";
/// The server's public origin.
pub const ORIGIN: &str = "https://conformance.test";
/// Principal of every web session the harness issues.
pub const PRINCIPAL_ID: &str = "human:placeholder:alice";

/// Name in the self-signed certificate; the client connects to 127.0.0.1 under this name.
const TLS_NAME: &str = "localhost";

pub type Socket = WebSocketStream<TlsStream<TcpStream>>;

pub struct Ws {
    fixture: Fixture,
    port: u16,
    roots: Arc<rustls::RootCertStore>,
    sessions: Arc<PlaceholderSessions>,
    stop: oneshot::Sender<()>,
    server: JoinHandle<io::Result<()>>,
}

impl Harness for Ws {
    const NAME: &'static str = "websocket";

    async fn start(fixture: Fixture) -> Ws {
        let cert = rcgen::generate_simple_self_signed(vec![TLS_NAME.into()]).expect("certificate");
        let cert_der = CertificateDer::from(cert.cert.der().to_vec());
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
        let tls = tls_server_config(vec![cert_der.clone()], key).expect("TLS config");
        let mut roots = rustls::RootCertStore::empty();
        roots.add(cert_der).expect("root certificate");

        let sessions = Arc::new(PlaceholderSessions::new());
        let transport = WsTransport::new(
            WsConfig::new([HOST], ORIGIN),
            server_config(),
            Arc::clone(&sessions),
            fixture.router(),
        )
        .expect("valid WsConfig");
        // Loopback only, ephemeral port: nothing outside this machine is involved.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(async move {
            transport
                .serve(listener, tls, axum_routes(), async {
                    let _ = stopped.await;
                })
                .await
        });
        Ws {
            fixture,
            port,
            roots: Arc::new(roots),
            sessions,
            stop,
            server,
        }
    }

    fn fixture(&self) -> &Fixture {
        &self.fixture
    }

    async fn connect(&self) -> Client {
        let issued = self.sessions.issue(principal()).expect("OS randomness");
        let socket = self
            .upgrade(HOST, Some(ORIGIN), Some(&issued.cookie))
            .await
            .expect("upgrade accepted");
        Client::new(
            Box::new(WsWire(socket)),
            Some(json!({ "csrf": issued.csrf_token })),
        )
    }

    fn principal_id(&self) -> String {
        PRINCIPAL_ID.into()
    }

    fn revoke_sessions(&self) -> Result<(), Unsupported> {
        Err(Unsupported(
            "web session expiry and revocation are M3: PlaceholderSessions cannot revoke a \
             session, and removing one only refuses new upgrades",
        ))
    }

    async fn shutdown(self) {
        let _ = self.stop.send(());
        self.server
            .await
            .expect("server task")
            .expect("server stops cleanly");
    }
}

impl Ws {
    /// TLS to the server, verified against the generated certificate.
    pub async fn tls(&self) -> TlsStream<TcpStream> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("TLS versions")
            .with_root_certificates(Arc::clone(&self.roots))
            .with_no_client_auth();
        let tcp = TcpStream::connect(("127.0.0.1", self.port))
            .await
            .expect("connect");
        TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from(TLS_NAME).expect("name"), tcp)
            .await
            .expect("TLS handshake")
    }

    /// WebSocket upgrade with explicit `Host`, `Origin` and session cookie (`None` omits the
    /// header). An HTTP rejection returns its status code.
    pub async fn upgrade(
        &self,
        host: &str,
        origin: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<Socket, u16> {
        let url = format!("wss://{TLS_NAME}:{}{RPC_WS_PATH}", self.port);
        let mut request = url.into_client_request().expect("request");
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(host).expect("host"));
        if let Some(origin) = origin {
            headers.insert(
                header::ORIGIN,
                HeaderValue::from_str(origin).expect("origin"),
            );
        }
        if let Some(cookie) = cookie {
            let value = format!("{}={cookie}", ambidex_axum::DEFAULT_SESSION_COOKIE);
            headers.insert(
                header::COOKIE,
                HeaderValue::from_str(&value).expect("cookie"),
            );
        }
        match tokio_tungstenite::client_async(request, self.tls().await).await {
            Ok((socket, _)) => Ok(socket),
            Err(WsError::Http(response)) => Err(response.status().as_u16()),
            Err(err) => panic!("unexpected WebSocket handshake error: {err}"),
        }
    }

    pub fn sessions(&self) -> &PlaceholderSessions {
        &self.sessions
    }

    /// A fresh session's cookie and anti-CSRF token.
    pub fn issue(&self) -> (String, String) {
        let issued = self.sessions.issue(principal()).expect("OS randomness");
        (issued.cookie, issued.csrf_token)
    }

    /// A client on an already upgraded socket.
    pub fn client(socket: Socket, csrf: &str) -> Client {
        Client::new(Box::new(WsWire(socket)), Some(json!({ "csrf": csrf })))
    }
}

fn axum_routes() -> axum::Router {
    axum::Router::new()
}

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: PRINCIPAL_ID.into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("overwritten by issue"),
    }
}

/// One binary WebSocket message per chunk, like the browser runtime sends.
struct WsWire(Socket);

impl Wire for WsWire {
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, io::Result<()>> {
        Box::pin(async {
            self.0
                .send(Message::Binary(bytes.into()))
                .await
                .map_err(io::Error::other)
        })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>> {
        Box::pin(async {
            loop {
                match self.0.next().await? {
                    Ok(Message::Binary(bytes)) => return Some(bytes.into()),
                    Ok(Message::Ping(_) | Message::Pong(_)) => {}
                    Ok(Message::Close(_)) | Err(_) => return None,
                    Ok(other) => panic!("server sent a non-binary message: {other:?}"),
                }
            }
        })
    }

    fn close(&mut self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async {
            let _ = self.0.close(None).await;
        })
    }
}
