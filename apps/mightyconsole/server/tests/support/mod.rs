//! What the server's integration tests share: a real `mightyconsole-server` over TLS on a
//! loopback port, and a client that loads the page and upgrades like a browser tab.
#![allow(dead_code)]

use std::io;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ambidex::{Code, ErrorPayload, Frame, Kind};
use ambidex_conformance::client::{
    Client, LocalBoxFuture, Wire, call_frame, json_frame, subscribe_frame,
};
use futures_util::{SinkExt, StreamExt};
use mightyconsole_server::tls::TlsSource;
use mightyconsole_server::{SCHEMA_HASH, ServeConfig, Server, StartOptions};
use rustls::pki_types::{CertificateDer, ServerName};
use rustls_pki_types::pem::PemObject as _;
use security_types::Clock;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The public origin's host; `ALIAS` is another accepted Host that the page redirects from.
pub const HOST: &str = "mc.test";
pub const ALIAS: &str = "alias.test";
pub const ORIGIN: &str = "https://mc.test";
pub const COOKIE: &str = ambidex_axum::DEFAULT_SESSION_COOKIE;

pub type Socket = WebSocketStream<TlsStream<TcpStream>>;

/// A clock the test moves by hand, for the idle sweep.
#[derive(Default)]
pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn advance(&self, by: Duration) {
        self.0.fetch_add(by.as_millis() as u64, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_unix_ms(&self) -> u64 {
        1_800_000_000_000 + self.0.load(Ordering::SeqCst)
    }

    fn sleep_until(&self, deadline_unix_ms: u64) -> security_types::BoxFuture<'_, ()> {
        Box::pin(async move {
            while self.now_unix_ms() < deadline_unix_ms {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
    }
}

pub struct TestServer {
    pub server: Server,
    pub roots: Arc<rustls::RootCertStore>,
    pub _dir: tempfile::TempDir,
}

pub fn config(dir: &Path, ui: Option<std::path::PathBuf>) -> ServeConfig {
    ServeConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        allowed_hosts: vec![HOST.into(), ALIAS.into()],
        public_origin: ORIGIN.into(),
        tls: TlsSource::Generated {
            dir: dir.join("tls"),
        },
        ui,
        codec_listen: None,
    }
}

pub async fn start_with(ui: Option<std::path::PathBuf>, options: StartOptions) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let server = Server::start_with(config(dir.path(), ui), options)
        .await
        .expect("server starts");
    // The generated certificate names localhost; the test trusts exactly it.
    let cert = CertificateDer::from_pem_file(dir.path().join("tls/cert.pem")).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots.add(cert).unwrap();
    TestServer {
        server,
        roots: Arc::new(roots),
        _dir: dir,
    }
}

pub async fn start() -> TestServer {
    start_with(None, StartOptions::default()).await
}

pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl HttpResponse {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// The session cookie the page set.
    pub fn cookie(&self) -> Option<String> {
        let set = self.header("set-cookie")?;
        let value = set.strip_prefix(&format!("{COOKIE}="))?;
        Some(value.split(';').next().unwrap().to_owned())
    }

    /// The anti-CSRF token of the page's `<meta>`.
    pub fn csrf(&self) -> String {
        let marker = "<meta name=\"mightyconsole-csrf\" content=\"";
        let start = self.body.find(marker).expect("the page has the token") + marker.len();
        self.body[start..start + 64].to_owned()
    }
}

/// A browser's credentials: the cookie and the page's token.
#[derive(Clone)]
pub struct Browser {
    pub cookie: String,
    pub csrf: String,
}

impl TestServer {
    pub fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }

    pub async fn tls(&self) -> TlsStream<TcpStream> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(Arc::clone(&self.roots))
            .with_no_client_auth();
        let tcp = TcpStream::connect(self.addr()).await.unwrap();
        tcp.set_nodelay(true).unwrap();
        TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from("localhost").unwrap(), tcp)
            .await
            .expect("TLS handshake against the generated certificate")
    }

    pub async fn http(&self, path: &str, host: &str, cookie: Option<&str>) -> HttpResponse {
        let mut tls = self.tls().await;
        let cookie = cookie
            .map(|c| format!("Cookie: {COOKIE}={c}\r\n"))
            .unwrap_or_default();
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{cookie}Connection: close\r\n\r\n");
        tls.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        let _ = tls.read_to_end(&mut raw).await;
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("end of headers");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let mut lines = head.lines();
        let status = lines.next().unwrap().split(' ').nth(1).unwrap().parse();
        HttpResponse {
            status: status.unwrap(),
            headers: lines
                .filter_map(|line| line.split_once(':'))
                .map(|(n, v)| (n.trim().to_ascii_lowercase(), v.trim().to_owned()))
                .collect(),
            body: String::from_utf8_lossy(&raw[split + 4..]).into_owned(),
        }
    }

    /// Loads the page as a new browser.
    pub async fn browser(&self) -> Browser {
        let page = self.http("/", HOST, None).await;
        assert_eq!(page.status, 200);
        Browser {
            cookie: page.cookie().expect("a new browser gets a cookie"),
            csrf: page.csrf(),
        }
    }

    pub async fn upgrade(
        &self,
        host: &str,
        origin: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<Socket, u16> {
        let url = format!("wss://localhost:{}/rpc/ws", self.addr().port());
        let mut request = url.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(cookie) = cookie {
            let value = format!("{COOKIE}={cookie}");
            headers.insert(header::COOKIE, HeaderValue::from_str(&value).unwrap());
        }
        match tokio_tungstenite::client_async(request, self.tls().await).await {
            Ok((socket, _)) => Ok(socket),
            Err(WsError::Http(response)) => Err(response.status().as_u16()),
            Err(err) => panic!("unexpected WebSocket handshake error: {err}"),
        }
    }

    /// A tab of `browser`: upgrade and Hello with the page's token.
    pub async fn tab(&self, browser: &Browser) -> Tab {
        let socket = self
            .upgrade(HOST, Some(ORIGIN), Some(&browser.cookie))
            .await
            .expect("upgrade accepted");
        let mut client = Client::new(Box::new(WsWire(socket)), None);
        client.send(&[hello(&browser.csrf)]).await;
        let frame = client.recv().await.expect("HelloAck");
        assert_eq!(
            frame.kind,
            Kind::HelloAck,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        Tab {
            client,
            pending: Vec::new(),
        }
    }
}

pub fn hello(csrf: &str) -> Frame {
    json_frame(
        Kind::Hello,
        0,
        &json!({
            "protocol": 1,
            "api": mightyconsole_server::API_NAME,
            "schema_hash": SCHEMA_HASH.as_str(),
            "client_version": "mightyconsole-e2e",
            "auth": { "csrf": csrf },
        }),
    )
}

/// One binary WebSocket message per frame, as the browser runtime sends.
pub struct WsWire(pub Socket);

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

/// A connected tab. Frames arrive interleaved (events, chunks, results), so it keeps the ones
/// a test has not asked for yet.
pub struct Tab {
    pub client: Client,
    pub pending: Vec<Frame>,
}

impl Tab {
    pub async fn call(&mut self, id: u32, procedure: &str, input: Value) {
        self.client
            .send(&[call_frame(id, procedure, input, None)])
            .await;
    }

    pub async fn subscribe_events(&mut self, id: u32) {
        self.client
            .send(&[subscribe_frame(id, "app.events", json!({}), None)])
            .await;
    }

    pub async fn frame(&mut self, id: u32) -> Frame {
        if let Some(at) = self.pending.iter().position(|f| f.call_id == id) {
            return self.pending.remove(at);
        }
        loop {
            let frame = self.client.recv().await.expect("a frame, got close");
            if frame.call_id == id {
                return frame;
            }
            self.pending.push(frame);
        }
    }

    /// `true` when no frame for `id` arrives within `wait`.
    pub async fn quiet(&mut self, id: u32, wait: Duration) -> bool {
        if self.pending.iter().any(|f| f.call_id == id) {
            return false;
        }
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            match tokio::time::timeout_at(deadline, self.client.recv()).await {
                Err(_) => return true,
                Ok(None) => panic!("closed"),
                Ok(Some(frame)) if frame.call_id == id => {
                    self.pending.push(frame);
                    return false;
                }
                Ok(Some(frame)) => self.pending.push(frame),
            }
        }
    }

    pub async fn result(&mut self, id: u32) -> Value {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::Result,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    pub async fn error(&mut self, id: u32, code: Code) -> ErrorPayload {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::Error,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        let err: ErrorPayload = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(err.code, code, "{err:?}");
        err
    }

    pub async fn chunk(&mut self, id: u32) -> Vec<u8> {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::Chunk,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        frame.payload
    }

    pub async fn stream_end(&mut self, id: u32) -> Value {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::StreamEnd,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    /// The next `app.events` event (subscription `id`) for which `pick` holds.
    pub async fn event(&mut self, id: u32, pick: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.frame(id).await;
            assert_eq!(frame.kind, Kind::Event, "{frame:?}");
            let event: Value = serde_json::from_slice(&frame.payload).unwrap();
            if pick(&event) {
                return event;
            }
        }
    }

    pub async fn connect(&mut self, id: u32) -> String {
        self.call(id, "echo.connect", json!({ "profile": { "name": "lab" } }))
            .await;
        let out = self.result(id).await;
        assert_eq!(out["greeting"], "hello from lab");
        out["connId"].as_str().unwrap().to_owned()
    }

    pub async fn disconnect(self) {
        self.client.disconnect().await;
    }
}

pub fn not_found_connection(err: &ErrorPayload) {
    let details = err.details.as_ref().expect("ToolError details");
    assert_eq!(details["kind"], "NotFound");
    assert_eq!(details["resource"], "connection");
}

pub async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}
