//! WebSocket transport over real TLS on an ephemeral port.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::{Call, Code, Dispatch, ErrorPayload, HelloAck, ServerConfig, Session};
use ambidex_axum::{PlaceholderSessions, RPC_WS_PATH, WsConfig, WsTransport, tls_server_config};
use axum::Router;
use axum::routing::get;
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

const HOST: &str = "dbee.test";
const ORIGIN: &str = "https://dbee.test";
const SCHEMA: &str = "schema-1";
const MAX_FRAME: u32 = 1024;

#[derive(Default, Clone)]
struct Fixture {
    calls: Arc<AtomicUsize>,
}

impl Dispatch for Fixture {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            match call.procedure.as_str() {
                "whoami" => Ok(json!({
                    "session": session.id,
                    "principal": session.principal.id,
                    "input": call.input,
                })),
                _ => Err(ErrorPayload::new(Code::NotFound, "unknown procedure")),
            }
        })
    }
}

struct TestServer {
    port: u16,
    roots: Arc<rustls::RootCertStore>,
    sessions: Arc<PlaceholderSessions>,
    calls: Arc<AtomicUsize>,
    _shutdown: oneshot::Sender<()>,
}

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:placeholder:alice".into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("overwritten"),
    }
}

async fn start() -> TestServer {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert_der = CertificateDer::from(cert.cert.der().to_vec());
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()));
    let tls = tls_server_config(vec![cert_der.clone()], key).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert_der).unwrap();

    let mut engine = ServerConfig::new("dbee", SCHEMA, "9.9.9");
    engine.max_frame_bytes = MAX_FRAME;
    engine.max_hello_bytes = 512;
    let sessions = Arc::new(PlaceholderSessions::new());
    let fixture = Fixture::default();
    let calls = Arc::clone(&fixture.calls);
    let transport = WsTransport::new(
        WsConfig::new([HOST], ORIGIN),
        engine,
        Arc::clone(&sessions),
        fixture,
    )
    .unwrap();
    let routes = Router::new().route("/health", get(|| async { "ok" }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (shutdown, stop) = oneshot::channel();
    tokio::spawn(async move {
        transport
            .serve(listener, tls, routes, async {
                let _ = stop.await;
            })
            .await
            .unwrap();
    });
    TestServer {
        port,
        roots: Arc::new(roots),
        sessions,
        calls,
        _shutdown: shutdown,
    }
}

impl TestServer {
    async fn tls(&self) -> TlsStream<TcpStream> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(Arc::clone(&self.roots))
            .with_no_client_auth();
        let tcp = TcpStream::connect(("127.0.0.1", self.port)).await.unwrap();
        TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from("localhost").unwrap(), tcp)
            .await
            .unwrap()
    }

    fn issue(&self) -> (String, String) {
        let issued = self.sessions.issue(principal()).unwrap();
        (issued.cookie, issued.csrf_token)
    }

    /// Upgrade with explicit headers; `None` omits the header.
    async fn connect(
        &self,
        host: &str,
        origin: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<WebSocketStream<TlsStream<TcpStream>>, u16> {
        let url = format!("wss://localhost:{}{RPC_WS_PATH}", self.port);
        let mut request = url.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(cookie) = cookie {
            let value = format!("__Host-ambidex_session={cookie}");
            headers.insert(header::COOKIE, HeaderValue::from_str(&value).unwrap());
        }
        match tokio_tungstenite::client_async(request, self.tls().await).await {
            Ok((ws, _)) => Ok(ws),
            Err(WsError::Http(response)) => Err(response.status().as_u16()),
            Err(err) => panic!("unexpected handshake error: {err}"),
        }
    }

    async fn connect_ok(&self) -> (Client, String) {
        let (cookie, csrf) = self.issue();
        let ws = self
            .connect(HOST, Some(ORIGIN), Some(&cookie))
            .await
            .unwrap();
        (Client::new(ws), csrf)
    }

    /// Status code of a plain HTTP/1.1 GET over TLS.
    async fn http_status(&self, path: &str, host: &str) -> u16 {
        let mut tls = self.tls().await;
        let request = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        tls.write_all(request.as_bytes()).await.unwrap();
        let mut response = Vec::new();
        let _ = tls.read_to_end(&mut response).await;
        let text = String::from_utf8_lossy(&response);
        text.split(' ').nth(1).unwrap().parse().unwrap()
    }
}

struct Client {
    ws: WebSocketStream<TlsStream<TcpStream>>,
    decoder: FrameDecoder,
}

impl Client {
    fn new(ws: WebSocketStream<TlsStream<TcpStream>>) -> Client {
        Client {
            ws,
            decoder: FrameDecoder::new(u32::MAX),
        }
    }

    async fn send_bytes(&mut self, bytes: Vec<u8>) {
        self.ws.send(Message::Binary(bytes.into())).await.unwrap();
    }

    async fn send_json(&mut self, kind: Kind, call_id: u32, value: Value) {
        let frame = Frame::new(kind, call_id, serde_json::to_vec(&value).unwrap());
        self.send_bytes(frame.encode(u32::MAX).unwrap()).await;
    }

    async fn hello(&mut self, csrf: &str) {
        let hello = json!({
            "protocol": 1, "api": "dbee", "schema_hash": SCHEMA, "client_version": "1.0.0",
            "auth": { "csrf": csrf },
        });
        self.send_json(Kind::Hello, 0, hello).await;
    }

    /// Next frame, or `None` once the server closed the WebSocket.
    async fn recv(&mut self) -> Option<Frame> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(frame) = self.decoder.next_frame().unwrap() {
                    return Some(frame);
                }
                match self.ws.next().await {
                    Some(Ok(Message::Binary(bytes))) => self.decoder.push(&bytes),
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
                    Some(Ok(other)) => panic!("unexpected message {other:?}"),
                }
            }
        })
        .await
        .expect("server did not answer")
    }

    async fn handshake(&mut self, csrf: &str) -> HelloAck {
        self.hello(csrf).await;
        let frame = self.recv().await.expect("HelloAck");
        assert_eq!(frame.kind, Kind::HelloAck, "{frame:?}");
        serde_json::from_slice(&frame.payload).unwrap()
    }
}

#[tokio::test]
async fn call_runs_with_server_side_principal() {
    let server = start().await;
    let (mut client, csrf) = server.connect_ok().await;
    let ack = client.handshake(&csrf).await;
    assert_eq!(ack.limits.max_frame_bytes, MAX_FRAME);

    let call = json!({ "procedure": "whoami", "input": { "principal": "human:oidc:mallory" } });
    client.send_json(Kind::Call, 1, call).await;
    let frame = client.recv().await.unwrap();
    assert_eq!((frame.kind, frame.call_id), (Kind::Result, 1));
    let result: Value = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(result["principal"], "human:placeholder:alice");
    assert_eq!(result["session"], ack.session);
}

#[tokio::test]
async fn frames_may_be_split_and_coalesced_across_messages() {
    let server = start().await;
    let (mut client, csrf) = server.connect_ok().await;
    client.handshake(&csrf).await;

    let mut bytes = Vec::new();
    for call_id in 1..=3 {
        let call = json!({ "procedure": "whoami", "input": call_id });
        let frame = Frame::new(Kind::Call, call_id, serde_json::to_vec(&call).unwrap());
        bytes.extend(frame.encode(u32::MAX).unwrap());
    }
    let (head, tail) = bytes.split_at(5);
    client.send_bytes(head.to_vec()).await;
    client.send_bytes(tail.to_vec()).await;
    let mut ids: Vec<u32> = Vec::new();
    for _ in 0..3 {
        let frame = client.recv().await.unwrap();
        assert_eq!(frame.kind, Kind::Result);
        ids.push(frame.call_id);
    }
    ids.sort();
    assert_eq!(ids, [1, 2, 3]);
}

#[tokio::test]
async fn host_outside_allowlist_is_rejected() {
    let server = start().await;
    let (cookie, _) = server.issue();
    for host in [
        "evil.test",
        "dbee.test.evil.test",
        "127.0.0.1",
        "dbee.test:1",
    ] {
        let status = server.connect(host, Some(ORIGIN), Some(&cookie)).await;
        assert_eq!(status.err(), Some(421), "{host}");
    }
    // Every route is behind the Host check, not only the upgrade.
    assert_eq!(server.http_status("/health", "evil.test").await, 421);
    assert_eq!(server.http_status("/health", "DBEE.test").await, 200);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn origin_must_match_exactly() {
    let server = start().await;
    let (cookie, _) = server.issue();
    let bad = [
        None,
        Some("https://evil.test"),
        Some("http://dbee.test"),
        Some("https://dbee.test/"),
        Some("https://dbee.test:443"),
        Some("https://DBEE.test"),
        Some("null"),
    ];
    for origin in bad {
        let status = server.connect(HOST, origin, Some(&cookie)).await;
        assert_eq!(status.err(), Some(403), "{origin:?}");
    }
}

#[tokio::test]
async fn upgrade_without_valid_session_is_rejected() {
    let server = start().await;
    for cookie in [None, Some("forged")] {
        let status = server.connect(HOST, Some(ORIGIN), cookie).await;
        assert_eq!(status.err(), Some(401), "{cookie:?}");
    }
    let (cookie, _) = server.issue();
    server.sessions.remove(&cookie);
    let status = server.connect(HOST, Some(ORIGIN), Some(&cookie)).await;
    assert_eq!(status.err(), Some(401));
}

#[tokio::test]
async fn hello_without_matching_csrf_is_unauthenticated() {
    let server = start().await;
    let (_, other_csrf) = server.issue();
    let (mut client, _csrf) = server.connect_ok().await;
    client.hello(&other_csrf).await;
    let frame = client.recv().await.unwrap();
    assert_eq!((frame.kind, frame.call_id), (Kind::Error, 0));
    let err: ErrorPayload = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(err.code, Code::Unauthenticated);
    assert_eq!(client.recv().await, None);
}

#[tokio::test]
async fn text_message_closes_the_connection() {
    let server = start().await;
    let (mut client, csrf) = server.connect_ok().await;
    client.handshake(&csrf).await;
    let call = json!({ "procedure": "whoami", "input": null });
    let frame = Frame::new(Kind::Call, 1, serde_json::to_vec(&call).unwrap());
    // Valid frame bytes, but in a text message: never reaches the engine.
    let text = String::from_utf8(frame.encode(u32::MAX).unwrap()).unwrap();
    client.ws.send(Message::Text(text.into())).await.unwrap();
    assert_eq!(client.recv().await, None);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn message_larger_than_a_frame_closes_the_connection() {
    let server = start().await;
    let (mut client, csrf) = server.connect_ok().await;
    client.handshake(&csrf).await;
    let call = json!({ "procedure": "whoami", "input": "x".repeat(MAX_FRAME as usize) });
    client.send_json(Kind::Call, 1, call).await;
    assert_eq!(client.recv().await, None);
    assert_eq!(server.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn plain_http_is_not_served() {
    let server = start().await;
    let mut tcp = TcpStream::connect(("127.0.0.1", server.port))
        .await
        .unwrap();
    let request = format!("GET /health HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n\r\n");
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut response)).await;
    assert!(!response.starts_with(b"HTTP/"), "{response:?}");
}
