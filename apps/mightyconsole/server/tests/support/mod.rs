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
    /// The base path (`--base-path`) and the session cookie's name under it.
    pub prefix: String,
    pub cookie_name: String,
    /// `auth.tenant`.
    pub tenant: String,
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
        router: Default::default(),
        base_path: String::new(),
        data: Some(dir.to_path_buf()),
        auth: Default::default(),
        audit: Default::default(),
        secrets: Default::default(),
        policy: Default::default(),
    }
}

pub async fn start_with(ui: Option<std::path::PathBuf>, options: StartOptions) -> TestServer {
    start_configured(ui, options, |_| {}).await
}

/// A server whose configuration `change` adjusts (router mode, base path).
pub async fn start_configured(
    ui: Option<std::path::PathBuf>,
    options: StartOptions,
    change: impl FnOnce(&mut ServeConfig),
) -> TestServer {
    start_inner(ui, options, change, true).await
}

/// A server on the real audit log of its data directory (`TestServer::_dir`/audit), unless the
/// options name a sink.
pub async fn start_with_durable_audit(options: StartOptions) -> TestServer {
    start_inner(None, options, |_| {}, false).await
}

/// [`start_with_durable_audit`] with the configuration adjusted (the audit policy, say).
pub async fn start_durable_configured(
    options: StartOptions,
    change: impl FnOnce(&mut ServeConfig),
) -> TestServer {
    start_inner(None, options, change, false).await
}

async fn start_inner(
    ui: Option<std::path::PathBuf>,
    mut options: StartOptions,
    change: impl FnOnce(&mut ServeConfig),
    memory_audit: bool,
) -> TestServer {
    // The server runs inside the test harness: jq queries run in the built server binary.
    options
        .jq_worker
        .get_or_insert_with(|| env!("CARGO_BIN_EXE_mightyconsole-server").into());
    // Most tests do not look at the audit log, and some make thousands of audited calls, each
    // of which the durable log would fsync twice: they get an in-memory sink. tests/audit.rs
    // starts the server on the real log.
    if memory_audit {
        options
            .audit_sink
            .get_or_insert_with(|| Arc::new(security_types::MemoryAuditLog::new()));
    }
    let dir = tempfile::tempdir().unwrap();
    let mut config = config(dir.path(), ui);
    change(&mut config);
    let prefix = config.base_path.clone();
    let cookie_name = config.session_cookie();
    let tenant = config.auth.tenant.clone();
    let server = Server::start_with(config, options)
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
        prefix,
        cookie_name,
        tenant,
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

/// Reads one HTTP/1.1 answer to the end of the connection.
pub async fn read_response<S: tokio::io::AsyncRead + Unpin>(stream: &mut S) -> HttpResponse {
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw).await;
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
        let cookie = cookie.map(|c| format!("{}={c}", self.cookie_name));
        let headers: Vec<(&str, &str)> = cookie.iter().map(|c| ("Cookie", c.as_str())).collect();
        self.request("GET", path, host, &headers).await
    }

    /// Any request, with the given headers, through `host`.
    pub async fn request(
        &self,
        method: &str,
        path: &str,
        host: &str,
        headers: &[(&str, &str)],
    ) -> HttpResponse {
        self.request_with_body(method, path, host, headers, "")
            .await
    }

    /// A request with a body (sent with its `Content-Length`).
    pub async fn request_with_body(
        &self,
        method: &str,
        path: &str,
        host: &str,
        headers: &[(&str, &str)],
        body: &str,
    ) -> HttpResponse {
        let mut tls = self.tls().await;
        let extra: String = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}\r\n"))
            .collect();
        let length = if method == "POST" {
            format!("Content-Length: {}\r\n", body.len())
        } else {
            String::new()
        };
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: {host}\r\n{extra}{length}Connection: close\r\n\r\n{body}"
        );
        tls.write_all(request.as_bytes()).await.unwrap();
        read_response(&mut tls).await
    }

    /// The signed-out page's pre-session token (its meta; the cookie holds the same value).
    pub async fn pre_token(&self) -> String {
        let page = self.http(&format!("{}/", self.prefix), HOST, None).await;
        let marker = r#"<meta name="mightyconsole-pre" content=""#;
        let start = page.body.find(marker).expect("a pre-session token") + marker.len();
        page.body[start..start + 64].to_owned()
    }

    /// A `POST /auth/*` of the built-in accounts as the sign-in page sends it (Origin, JSON, the
    /// pre-session token); the answer and the session cookie it set.
    pub async fn post_auth(
        &self,
        path: &str,
        body: &serde_json::Value,
    ) -> (HttpResponse, Option<String>) {
        let pre = self.pre_token().await;
        let cookie = format!("__Host-mc_pre{}={pre}", self.prefix.replace('/', "_"));
        let answer = self
            .request_with_body(
                "POST",
                &format!("{}{path}", self.prefix),
                HOST,
                &[
                    ("Origin", ORIGIN),
                    ("Content-Type", "application/json"),
                    ("X-Mightyconsole-Csrf", &pre),
                    ("Cookie", &cookie),
                ],
                &body.to_string(),
            )
            .await;
        let session = answer.cookie();
        (answer, session)
    }

    /// The default administrator's generated password (`DATA/admin-password`).
    pub fn admin_password(&self) -> String {
        std::fs::read_to_string(self._dir.path().join("admin-password"))
            .expect("the default administrator's password")
            .trim()
            .to_owned()
    }

    /// A new browser, signed in as a new built-in account (`human:account:test-<n>`): the session
    /// is made in the store, as a sign-in would make it (the sign-in itself is tested on its own,
    /// and sign-up is limited per address), then the page is loaded for its token.
    pub async fn browser(&self) -> Browser {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.browser_as(&format!("human:account:test-{n}"), &[])
            .await
    }

    /// A new browser signed in as `user` with the IdP groups `groups` in its session.
    pub async fn browser_as(&self, user: &str, groups: &[&str]) -> Browser {
        let user = user.to_owned();
        let issued = self
            .server
            .login_sessions()
            .create(ambidex_axum::NewSession {
                user: user.clone(),
                principal: security_types::Principal {
                    kind: security_types::PrincipalKind::Human,
                    id: user,
                    tenant: security_types::TenantId::new(&self.tenant),
                    on_behalf_of: None,
                    roles: vec![],
                    session: security_types::SessionId::new("set per connection"),
                },
                groups: groups.iter().map(|g| (*g).to_owned()).collect(),
                method: ambidex_axum::LoginMethod::Password,
                auth_time_ms: 0,
                id_token: None,
                client: None,
                must_change_password: false,
                must_enrol_totp: false,
            })
            .expect("below the session cap");
        let cookie = issued.cookie.to_string();
        let page = self
            .http(&format!("{}/", self.prefix), HOST, Some(&cookie))
            .await;
        assert_eq!(page.status, 200);
        Browser {
            cookie,
            csrf: page.csrf(),
        }
    }

    pub async fn upgrade(
        &self,
        host: &str,
        origin: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<Socket, u16> {
        let url = format!(
            "wss://localhost:{}{}/rpc/ws",
            self.addr().port(),
            self.prefix
        );
        let mut request = url.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(cookie) = cookie {
            let value = format!("{}={cookie}", self.cookie_name);
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
            wire: std::collections::HashMap::new(),
            next_wire: 1,
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
///
/// A test names its calls with its own ids; the tab sends each with a **wire id**, the same
/// number until [`Tab::confirmed`] has used extra ones (call ids strictly increase on a
/// connection), after which later calls get the next free wire id. Every method of the tab maps
/// a test id to its wire id; frames sent through `client` directly use their ids as they are.
pub struct Tab {
    pub client: Client,
    pub pending: Vec<Frame>,
    wire: std::collections::HashMap<u32, u32>,
    next_wire: u32,
}

impl Tab {
    /// The wire id for a new call named `id`.
    fn assign(&mut self, id: u32) -> u32 {
        let wire = id.max(self.next_wire);
        self.wire.insert(id, wire);
        self.next_wire = wire + 1;
        wire
    }

    /// The wire id of the call named `id`.
    pub fn wire_of(&self, id: u32) -> u32 {
        self.wire.get(&id).copied().unwrap_or(id)
    }

    pub async fn call(&mut self, id: u32, procedure: &str, input: Value) {
        let wire = self.assign(id);
        self.client
            .send(&[call_frame(wire, procedure, input, None)])
            .await;
    }

    pub async fn subscribe_events(&mut self, id: u32) {
        let wire = self.assign(id);
        self.client
            .send(&[subscribe_frame(wire, "app.events", json!({}), None)])
            .await;
    }

    /// Grants `chunks` more chunks to the stream named `id`.
    pub async fn credit(&mut self, id: u32, chunks: u64) {
        let wire = self.wire_of(id);
        self.client.credit(wire, chunks).await;
    }

    /// Cancels the call named `id`.
    pub async fn cancel(&mut self, id: u32) {
        let wire = self.wire_of(id);
        self.client.cancel(wire).await;
    }

    pub async fn frame(&mut self, id: u32) -> Frame {
        let wire = self.wire_of(id);
        self.frame_wire(wire).await
    }

    async fn frame_wire(&mut self, id: u32) -> Frame {
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
        let id = self.wire_of(id);
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

    /// A Destructive call answered as a person would (DOC-25 §3.3.6): sent as call `id`, which
    /// gets `ApprovalRequired`; the challenge's phrase is read and typed; the same call is sent
    /// again, and `id` then names that call (read its answer with [`Tab::result`] or
    /// [`Tab::error`]). The extra calls take wire ids of their own (see [`Tab`]).
    pub async fn confirmed(&mut self, id: u32, procedure: &str, input: Value) -> u32 {
        self.call(id, procedure, input.clone()).await;
        let err = self.error(id, Code::ApprovalRequired).await;
        let approval = err.details.expect("an approval id")["approval_id"]
            .as_str()
            .expect("approval_id")
            .to_owned();
        let challenge = self
            .extra_call("app.confirmations.get", json!({ "approvalId": approval }))
            .await;
        assert_eq!(challenge["action"], procedure);
        let phrase = challenge["phrase"].as_str().unwrap().to_owned();
        self.extra_call(
            "app.confirmations.confirm",
            json!({ "approvalId": approval, "typed": phrase }),
        )
        .await;
        // `id` now names the call sent again.
        let wire = self.next_wire;
        self.wire.insert(id, wire);
        self.next_wire = wire + 1;
        self.client
            .send(&[call_frame(wire, procedure, input, None)])
            .await;
        id
    }

    /// [`Tab::call`], answering the confirmation first when the procedure is Destructive.
    pub async fn call_answered(&mut self, id: u32, procedure: &str, input: Value) {
        if is_destructive(procedure) {
            self.confirmed(id, procedure, input).await;
        } else {
            self.call(id, procedure, input).await;
        }
    }

    /// A call on a wire id of its own, answered with a result.
    async fn extra_call(&mut self, procedure: &str, input: Value) -> Value {
        let wire = self.next_wire;
        self.next_wire = wire + 1;
        self.client
            .send(&[call_frame(wire, procedure, input, None)])
            .await;
        let frame = self.frame_wire(wire).await;
        assert_eq!(
            frame.kind,
            Kind::Result,
            "{procedure}: {}",
            String::from_utf8_lossy(&frame.payload)
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    pub async fn disconnect(self) {
        self.client.disconnect().await;
    }
}

/// Whether `procedure` is Destructive (it has a confirmation subject).
pub fn is_destructive(procedure: &str) -> bool {
    mightyconsole_server::authz::confirm::SUBJECTS
        .iter()
        .any(|(name, _, _)| *name == procedure)
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
