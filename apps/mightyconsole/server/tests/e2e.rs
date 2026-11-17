//! The server end to end (Mightyconsole spec §18, TSK-79): the real `mightyconsole-server` over
//! TLS on a loopback port, a client that loads the page and upgrades like a browser tab, and
//! the tool contract on the `echo` sample (connect, a stream with credits, a terminal echo, the
//! release of handles). CI runs this file in a network namespace with only loopback: the server
//! opens no outbound connection.

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
use base64::Engine as _;
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
const HOST: &str = "mc.test";
const ALIAS: &str = "alias.test";
const ORIGIN: &str = "https://mc.test";
const COOKIE: &str = ambidex_axum::DEFAULT_SESSION_COOKIE;

type Socket = WebSocketStream<TlsStream<TcpStream>>;

/// A clock the test moves by hand, for the idle sweep.
#[derive(Default)]
struct ManualClock(AtomicU64);

impl ManualClock {
    fn advance(&self, by: Duration) {
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

struct TestServer {
    server: Server,
    roots: Arc<rustls::RootCertStore>,
    _dir: tempfile::TempDir,
}

fn config(dir: &Path, ui: Option<std::path::PathBuf>) -> ServeConfig {
    ServeConfig {
        listen: "127.0.0.1:0".parse().unwrap(),
        allowed_hosts: vec![HOST.into(), ALIAS.into()],
        public_origin: ORIGIN.into(),
        tls: TlsSource::Generated {
            dir: dir.join("tls"),
        },
        ui,
    }
}

async fn start_with(ui: Option<std::path::PathBuf>, options: StartOptions) -> TestServer {
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

async fn start() -> TestServer {
    start_with(None, StartOptions::default()).await
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }

    /// The session cookie the page set.
    fn cookie(&self) -> Option<String> {
        let set = self.header("set-cookie")?;
        let value = set.strip_prefix(&format!("{COOKIE}="))?;
        Some(value.split(';').next().unwrap().to_owned())
    }

    /// The anti-CSRF token of the page's `<meta>`.
    fn csrf(&self) -> String {
        let marker = "<meta name=\"mightyconsole-csrf\" content=\"";
        let start = self.body.find(marker).expect("the page has the token") + marker.len();
        self.body[start..start + 64].to_owned()
    }
}

/// A browser's credentials: the cookie and the page's token.
#[derive(Clone)]
struct Browser {
    cookie: String,
    csrf: String,
}

impl TestServer {
    fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }

    async fn tls(&self) -> TlsStream<TcpStream> {
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

    async fn http(&self, path: &str, host: &str, cookie: Option<&str>) -> HttpResponse {
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
    async fn browser(&self) -> Browser {
        let page = self.http("/", HOST, None).await;
        assert_eq!(page.status, 200);
        Browser {
            cookie: page.cookie().expect("a new browser gets a cookie"),
            csrf: page.csrf(),
        }
    }

    async fn upgrade(
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
    async fn tab(&self, browser: &Browser) -> Tab {
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

fn hello(csrf: &str) -> Frame {
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

/// A connected tab. Frames arrive interleaved (events, chunks, results), so it keeps the ones
/// a test has not asked for yet.
struct Tab {
    client: Client,
    pending: Vec<Frame>,
}

impl Tab {
    async fn call(&mut self, id: u32, procedure: &str, input: Value) {
        self.client
            .send(&[call_frame(id, procedure, input, None)])
            .await;
    }

    async fn subscribe_events(&mut self, id: u32) {
        self.client
            .send(&[subscribe_frame(id, "app.events", json!({}), None)])
            .await;
    }

    async fn frame(&mut self, id: u32) -> Frame {
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
    async fn quiet(&mut self, id: u32, wait: Duration) -> bool {
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

    async fn result(&mut self, id: u32) -> Value {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::Result,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    async fn error(&mut self, id: u32, code: Code) -> ErrorPayload {
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

    async fn chunk(&mut self, id: u32) -> Vec<u8> {
        let frame = self.frame(id).await;
        assert_eq!(
            frame.kind,
            Kind::Chunk,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        frame.payload
    }

    async fn stream_end(&mut self, id: u32) -> Value {
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
    async fn event(&mut self, id: u32, pick: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.frame(id).await;
            assert_eq!(frame.kind, Kind::Event, "{frame:?}");
            let event: Value = serde_json::from_slice(&frame.payload).unwrap();
            if pick(&event) {
                return event;
            }
        }
    }

    async fn connect(&mut self, id: u32) -> String {
        self.call(id, "echo.connect", json!({ "profile": { "name": "lab" } }))
            .await;
        let out = self.result(id).await;
        assert_eq!(out["greeting"], "hello from lab");
        out["connId"].as_str().unwrap().to_owned()
    }

    async fn disconnect(self) {
        self.client.disconnect().await;
    }
}

fn not_found_connection(err: &ErrorPayload) {
    let details = err.details.as_ref().expect("ToolError details");
    assert_eq!(details["kind"], "NotFound");
    assert_eq!(details["resource"], "connection");
}

async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    for _ in 0..200 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn the_page_gives_a_session_with_its_headers() {
    let t = start().await;
    let page = t.http("/", HOST, None).await;
    assert_eq!(page.status, 200);
    let set_cookie = page.header("set-cookie").unwrap();
    assert!(
        set_cookie.starts_with(&format!("{COOKIE}=")),
        "{set_cookie}"
    );
    for attribute in ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] {
        assert!(set_cookie.contains(attribute), "{set_cookie}");
    }
    assert_eq!(page.header("cache-control"), Some("no-store"));
    let csp = page.header("content-security-policy").unwrap();
    assert!(csp.contains("connect-src 'self' wss://mc.test;"), "{csp}");
    assert!(csp.contains("worker-src 'self' blob:"), "{csp}");
    assert_eq!(page.header("x-content-type-options"), Some("nosniff"));
    let csrf = page.csrf();
    assert!(csrf.bytes().all(|b| b.is_ascii_hexdigit()));

    // The same browser keeps its session on the next load: no new cookie, the same token.
    let cookie = page.cookie().unwrap();
    let again = t.http("/workflows/abc", HOST, Some(&cookie)).await;
    assert_eq!(again.status, 200);
    assert!(again.header("set-cookie").is_none());
    assert_eq!(again.csrf(), csrf);
    assert_eq!(t.server.sessions().len(), 1);

    // Another accepted Host is sent to the public origin; an unknown Host is refused.
    let alias = t.http("/x?y=1", ALIAS, None).await;
    assert_eq!(alias.status, 308);
    assert_eq!(alias.header("location"), Some("https://mc.test/x?y=1"));
    assert!(alias.header("set-cookie").is_none());
    assert_eq!(t.http("/", "evil.test", None).await.status, 421);
    // A file that is not there is 404, not the page.
    assert_eq!(t.http("/missing.js", HOST, None).await.status, 404);
    assert_eq!(t.server.sessions().len(), 1);
}

#[tokio::test]
async fn the_upgrade_needs_the_host_the_origin_the_cookie_and_the_token() {
    let t = start().await;
    let browser = t.browser().await;
    let cookie = Some(browser.cookie.as_str());
    assert_eq!(
        t.upgrade("evil.test", Some(ORIGIN), cookie).await.err(),
        Some(421)
    );
    assert_eq!(
        t.upgrade(HOST, Some("https://evil.test"), cookie)
            .await
            .err(),
        Some(403)
    );
    assert_eq!(t.upgrade(HOST, None, cookie).await.err(), Some(403));
    assert_eq!(t.upgrade(HOST, Some(ORIGIN), None).await.err(), Some(401));
    assert_eq!(
        t.upgrade(HOST, Some(ORIGIN), Some("forged")).await.err(),
        Some(401)
    );
    // The right cookie with another browser's token is refused at Hello.
    let other = t.browser().await;
    let socket = t.upgrade(HOST, Some(ORIGIN), cookie).await.unwrap();
    let mut client = Client::new(Box::new(WsWire(socket)), None);
    client.send(&[hello(&other.csrf)]).await;
    client.expect_fatal(Code::Unauthenticated).await;

    let mut tab = t.tab(&browser).await;
    tab.call(1, "app.info", json!({})).await;
    let info = tab.result(1).await;
    assert_eq!(info["schemaHash"], SCHEMA_HASH.as_str());
    assert_eq!(info["publicOrigin"], ORIGIN);
    assert_eq!(info["tools"][0]["id"], "echo");
    assert_eq!(
        info["certificateFingerprint"],
        t.server.tls().fingerprint.as_str()
    );
}

#[tokio::test]
async fn a_handle_belongs_to_the_connection_that_opened_it() {
    let t = start().await;
    let browser = t.browser().await;
    let mut a = t.tab(&browser).await;
    let mut b = t.tab(&browser).await;
    let conn = a.connect(1).await;

    a.call(2, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    assert_eq!(a.result(2).await["text"], "hi");
    // Another tab of the same browser cannot use it.
    b.call(1, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    not_found_connection(&b.error(1, Code::NotFound).await);
    b.call(2, "echo.disconnect", json!({ "connId": conn }))
        .await;
    b.result(2).await;
    assert_eq!(t.server.hub().handle_count(), 1);

    // A rejected credential is `Auth`.
    a.call(
        3,
        "echo.connect",
        json!({ "profile": { "name": "x", "token": "wrong" } }),
    )
    .await;
    let err = a.error(3, Code::Unauthenticated).await;
    assert_eq!(err.details.unwrap()["kind"], "Auth");

    // Disconnect releases it and says so; a second disconnect is fine.
    a.subscribe_events(4).await;
    a.call(5, "echo.disconnect", json!({ "connId": conn }))
        .await;
    a.result(5).await;
    let closed = a
        .event(4, |e| {
            e["kind"] == "ConnectionStatus" && e["status"] == "closed"
        })
        .await;
    assert_eq!(closed["connId"], conn.as_str());
    a.call(6, "echo.disconnect", json!({ "connId": conn }))
        .await;
    a.result(6).await;
    a.call(7, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    not_found_connection(&a.error(7, Code::NotFound).await);
    assert_eq!(t.server.hub().handle_count(), 0);
}

#[tokio::test]
async fn closing_the_websocket_releases_its_handles() {
    let t = start().await;
    let browser = t.browser().await;
    let mut a = t.tab(&browser).await;
    a.subscribe_events(1).await;
    a.connect(2).await;
    a.connect(3).await;
    let mut b = t.tab(&browser).await;
    b.connect(1).await;
    assert_eq!(t.server.hub().handle_count(), 3);
    a.disconnect().await;
    let hub = Arc::clone(t.server.hub());
    eventually("the closed tab's handles to be released", || {
        hub.handle_count() == 1
    })
    .await;
    // The other tab's handle (which has no app.events) is untouched.
    b.call(2, "app.info", json!({})).await;
    b.result(2).await;
    assert_eq!(hub.handle_count(), 1);
}

#[tokio::test]
async fn the_idle_sweep_releases_unused_handles_but_not_streaming_ones() {
    let clock = Arc::new(ManualClock::default());
    let options = StartOptions {
        clock: clock.clone(),
        idle_timeout: Duration::from_secs(600),
        sweep_interval: None,
    };
    let t = start_with(None, options).await;
    let hub = Arc::clone(t.server.hub());
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let idle = tab.connect(2).await;
    let streaming = tab.connect(3).await;
    tab.call(
        4,
        "echo.ticks",
        json!({ "connId": streaming, "streamId": "s-1", "intervalMs": 0 }),
    )
    .await;
    tab.chunk(4).await;

    clock.advance(Duration::from_secs(9 * 60));
    assert_eq!(hub.sweep(), 0);
    tab.call(5, "echo.ping", json!({ "connId": idle, "text": "x" }))
        .await;
    tab.result(5).await; // used: the idle time starts again
    clock.advance(Duration::from_secs(9 * 60));
    assert_eq!(hub.sweep(), 0);
    clock.advance(Duration::from_secs(60));
    assert_eq!(hub.sweep(), 1, "only the unused handle goes");
    let event = tab
        .event(1, |e| {
            e["kind"] == "ConnectionStatus" && e["status"] == "closed"
        })
        .await;
    assert_eq!(event["connId"], idle.as_str());
    assert!(event["message"].as_str().unwrap().contains("10 minutes"));
    tab.call(6, "echo.ping", json!({ "connId": idle, "text": "x" }))
        .await;
    not_found_connection(&tab.error(6, Code::NotFound).await);

    // Once the stream stops, the streaming handle ages like any other.
    tab.client.cancel(4).await;
    loop {
        let frame = tab.frame(4).await;
        if frame.kind == Kind::Error {
            break;
        }
    }
    let streaming_hub = Arc::clone(&hub);
    eventually("the sweep to take the stopped stream's handle", || {
        clock.advance(Duration::from_secs(600));
        streaming_hub.sweep() == 1
    })
    .await;
    assert_eq!(hub.handle_count(), 0);
}

#[tokio::test]
async fn a_stream_follows_the_credits_and_reports_progress() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let conn = tab.connect(2).await;
    tab.call(
        3,
        "echo.ticks",
        json!({ "connId": conn, "streamId": "ticks-1", "intervalMs": 0 }),
    )
    .await;
    // The initial window is 4 chunks: exactly 4 arrive, then nothing until a credit.
    for seq in 0..4 {
        let line = tab.chunk(3).await;
        assert_eq!(line.last(), Some(&b'\n'));
        let tick: Value = serde_json::from_slice(&line).unwrap();
        assert_eq!(tick["seq"], seq);
    }
    assert!(tab.quiet(3, Duration::from_millis(300)).await);
    tab.client.credit(3, 2).await;
    assert_eq!(
        serde_json::from_slice::<Value>(&tab.chunk(3).await).unwrap()["seq"],
        4
    );
    tab.chunk(3).await;
    assert!(tab.quiet(3, Duration::from_millis(300)).await);

    // A second stream with the same id is refused while the first runs.
    tab.call(
        4,
        "echo.ticks",
        json!({ "connId": conn, "streamId": "ticks-1" }),
    )
    .await;
    let err = tab.error(4, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "streamId");

    let progress = tab
        .event(1, |e| {
            e["kind"] == "StreamProgress" && e["streamId"] == "ticks-1"
        })
        .await;
    assert_eq!(progress["matched"], 6);
    assert_eq!(progress["scanned"], 6);
    assert_eq!(progress["dropped"], 0);

    // Disconnecting the handle ends its stream with Cancelled, and the last progress says done.
    tab.call(5, "echo.disconnect", json!({ "connId": conn }))
        .await;
    tab.result(5).await;
    tab.error(3, Code::Cancelled).await;
    let last = tab
        .event(1, |e| e["kind"] == "StreamProgress" && e["done"] == true)
        .await;
    assert_eq!(last["matched"], 6);

    // A finite stream ends with its summary; the id is free again.
    let conn = tab.connect(6).await;
    tab.call(
        7,
        "echo.ticks",
        json!({ "connId": conn, "streamId": "ticks-1", "count": 2, "intervalMs": 0 }),
    )
    .await;
    tab.chunk(7).await;
    tab.chunk(7).await;
    assert_eq!(tab.stream_end(7).await["sent"], 2);
}

#[tokio::test]
async fn a_terminal_echoes_its_input_and_reports_its_exit() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let conn = tab.connect(2).await;
    tab.call(
        3,
        "echo.shell",
        json!({ "connId": conn, "terminalId": "term-1" }),
    )
    .await;
    let banner = tab.chunk(3).await;
    assert_eq!(banner[0], 1, "stdout channel");
    assert!(String::from_utf8_lossy(&banner[1..]).contains("hello from lab"));

    let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);
    tab.call(
        4,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64(b"ls -l\r") }),
    )
    .await;
    tab.result(4).await;
    assert_eq!(tab.chunk(3).await, b"\x01ls -l\r");
    tab.call(
        5,
        "term.resize",
        json!({ "terminalId": "term-1", "cols": 120, "rows": 40 }),
    )
    .await;
    tab.result(5).await;
    assert_eq!(tab.chunk(3).await, b"\x01[120x40]\r\n");
    tab.call(
        6,
        "term.signal",
        json!({ "terminalId": "term-1", "signal": "interrupt" }),
    )
    .await;
    tab.result(6).await;
    assert_eq!(tab.chunk(3).await, b"\x01^C\r\n");

    // Another tab cannot type into it; bad input is refused.
    let mut other = t.tab(&browser).await;
    other
        .call(
            1,
            "term.write",
            json!({ "terminalId": "term-1", "data": b64(b"x") }),
        )
        .await;
    assert_eq!(
        other.error(1, Code::NotFound).await.details.unwrap()["resource"],
        "terminal"
    );
    tab.call(
        7,
        "term.write",
        json!({ "terminalId": "term-1", "data": "not base64!" }),
    )
    .await;
    tab.error(7, Code::InvalidArgument).await;
    let big = vec![b'a'; 64 * 1024 + 1];
    tab.call(
        8,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64(&big) }),
    )
    .await;
    tab.error(8, Code::InvalidArgument).await;

    // The four chunks so far used the initial window: output waits for the page's credit.
    tab.call(
        9,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64(b"bye\x04") }),
    )
    .await;
    tab.result(9).await;
    assert!(tab.quiet(3, Duration::from_millis(300)).await);
    tab.client.credit(3, 4).await;
    // Ctrl+D ended it with exit code 0; later input is NotFound.
    assert_eq!(tab.chunk(3).await, b"\x01bye");
    assert_eq!(tab.stream_end(3).await["exitCode"], 0);
    let exit = tab.event(1, |e| e["kind"] == "TerminalExit").await;
    assert_eq!(exit["terminalId"], "term-1");
    assert_eq!(exit["exitCode"], 0);
    tab.call(
        10,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64(b"x") }),
    )
    .await;
    tab.error(10, Code::NotFound).await;
}

#[tokio::test]
async fn the_ui_directory_is_served_with_the_session_in_its_page() {
    let ui = tempfile::tempdir().unwrap();
    std::fs::create_dir(ui.path().join("assets")).unwrap();
    std::fs::write(
        ui.path().join("index.html"),
        "<!doctype html><html><head><title>Mightyconsole</title></head><body></body></html>",
    )
    .unwrap();
    std::fs::write(ui.path().join("assets/app-1.js"), "console.log(1)").unwrap();
    let t = start_with(Some(ui.path().to_path_buf()), StartOptions::default()).await;
    let page = t.http("/", HOST, None).await;
    assert_eq!(page.status, 200);
    assert!(page.body.contains("<title>Mightyconsole</title>"));
    assert!(page.body.contains("<meta name=\"mightyconsole-csrf\""));
    let route = t.http("/k8s/pods", HOST, None).await;
    assert!(route.body.contains("<title>Mightyconsole</title>"));
    let asset = t.http("/assets/app-1.js", HOST, None).await;
    assert_eq!(asset.status, 200);
    assert_eq!(asset.body, "console.log(1)");
    assert_eq!(
        asset.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    assert!(asset.header("set-cookie").is_none());
    assert!(asset.header("content-security-policy").is_some());
    assert_eq!(t.http("/../Cargo.toml", HOST, None).await.status, 404);
}
