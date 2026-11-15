//! The web shell end to end (DBee spec §14): the real `dbee-server` over TLS on a loopback port,
//! a client that passes the Host, Origin and session checks like a browser tab, the static UI
//! with its headers, `audit verify`, and, against a throwaway PostgreSQL, a server-issued session
//! that adds a connection, approves it, runs a query and receives Arrow chunks over the
//! WebSocket. CI runs this file in a network namespace with only loopback: nothing but the
//! approved database is reachable.

#[path = "../../core/tests/support/cluster.rs"]
mod cluster;

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ambidex::Kind;
use ambidex_conformance::client::{Client, LocalBoxFuture, Wire, json_frame};
use dbee_core::authz::LOCAL_TENANT;
use dbee_core::export::IpcDecoder;
use dbee_server::{ServeConfig, Server, StartError};
use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::{CertificateDer, ServerName};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderValue, header};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The deployment's host name: what the operator lists in `--allowed-host` and the browser puts
/// in `Host`; the certificate names `localhost`, which the client connects to on 127.0.0.1.
const HOST: &str = "dbee.test";
const ORIGIN: &str = "https://dbee.test";
const PRINCIPAL: &str = "human:local:e2e";

type Socket = WebSocketStream<TlsStream<TcpStream>>;

struct TestServer {
    server: Server,
    roots: Arc<rustls::RootCertStore>,
    dir: tempfile::TempDir,
}

/// A certificate for `localhost` as PEM files, as an operator would provide them.
fn write_tls_files(dir: &Path) -> (PathBuf, PathBuf, CertificateDer<'static>) {
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    std::fs::write(&cert_path, cert.cert.pem()).unwrap();
    std::fs::write(&key_path, cert.signing_key.serialize_pem()).unwrap();
    (
        cert_path,
        key_path,
        CertificateDer::from(cert.cert.der().to_vec()),
    )
}

fn config(dir: &Path, ui: Option<PathBuf>) -> (ServeConfig, CertificateDer<'static>) {
    let (tls_cert, tls_key, der) = write_tls_files(dir);
    (
        ServeConfig {
            bind: "127.0.0.1:0".parse().unwrap(),
            tls_cert,
            tls_key,
            allowed_hosts: vec![HOST.into()],
            public_origin: ORIGIN.into(),
            workspace: dir.join("workspace"),
            ui,
            deployment_cas: vec![],
        },
        der,
    )
}

async fn start(ui: Option<PathBuf>) -> TestServer {
    let dir = tempfile::tempdir().unwrap();
    let (config, der) = config(dir.path(), ui);
    let mut roots = rustls::RootCertStore::empty();
    roots.add(der).unwrap();
    let server = Server::start(config).await.expect("server starts");
    TestServer {
        server,
        roots: Arc::new(roots),
        dir,
    }
}

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: PRINCIPAL.into(),
        tenant: TenantId::new(LOCAL_TENANT),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("overwritten by issue"),
    }
}

impl TestServer {
    fn addr(&self) -> SocketAddr {
        self.server.local_addr()
    }

    fn audit_log(&self) -> PathBuf {
        self.dir.path().join("workspace/audit/log.jsonl")
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
            .expect("TLS handshake against the PEM files")
    }

    /// WebSocket upgrade with explicit `Host`, `Origin` and cookie (`None` omits the header);
    /// an HTTP rejection is its status code.
    async fn upgrade(
        &self,
        host: &str,
        origin: Option<&str>,
        cookie: Option<&str>,
    ) -> Result<Socket, u16> {
        let url = format!(
            "wss://localhost:{}{}",
            self.addr().port(),
            ambidex_axum::RPC_WS_PATH
        );
        let mut request = url.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert(header::HOST, HeaderValue::from_str(host).unwrap());
        if let Some(origin) = origin {
            headers.insert(header::ORIGIN, HeaderValue::from_str(origin).unwrap());
        }
        if let Some(cookie) = cookie {
            let value = format!("{}={cookie}", ambidex_axum::DEFAULT_SESSION_COOKIE);
            headers.insert(header::COOKIE, HeaderValue::from_str(&value).unwrap());
        }
        match tokio_tungstenite::client_async(request, self.tls().await).await {
            Ok((socket, _)) => Ok(socket),
            Err(WsError::Http(response)) => Err(response.status().as_u16()),
            Err(err) => panic!("unexpected WebSocket handshake error: {err}"),
        }
    }

    /// A session issued server-side, the upgrade, and the Hello with its anti-CSRF token.
    async fn client(&self) -> Client {
        let issued = self.server.issue_session(principal()).unwrap();
        let socket = self
            .upgrade(HOST, Some(ORIGIN), Some(&issued.cookie))
            .await
            .expect("upgrade accepted");
        let mut client = Client::new(Box::new(WsWire(socket)), None);
        let hello = json_frame(
            Kind::Hello,
            0,
            &json!({
                "protocol": 1,
                "api": dbee_core::API_NAME,
                "schema_hash": dbee_core::SCHEMA_HASH.as_str(),
                "client_version": "dbee-server-e2e",
                "auth": { "csrf": issued.csrf_token },
            }),
        );
        client.send(&[hello]).await;
        let frame = client.recv().await.expect("HelloAck");
        assert_eq!(
            frame.kind,
            Kind::HelloAck,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        client
    }

    /// A plain HTTP/1.1 request over TLS: status, lowercase header names with values, body.
    async fn http(&self, method: &str, path: &str, host: &str) -> HttpResponse {
        let mut tls = self.tls().await;
        let request =
            format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
        tls.write_all(request.as_bytes()).await.unwrap();
        let mut raw = Vec::new();
        let _ = tls.read_to_end(&mut raw).await;
        let split = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("end of headers");
        let head = String::from_utf8_lossy(&raw[..split]).into_owned();
        let body = raw[split + 4..].to_vec();
        let mut lines = head.lines();
        let status = lines
            .next()
            .unwrap()
            .split(' ')
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .filter_map(|line| line.split_once(':'))
            .map(|(name, value)| (name.trim().to_ascii_lowercase(), value.trim().to_owned()))
            .collect();
        HttpResponse {
            status,
            headers,
            body,
        }
    }
}

struct HttpResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpResponse {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
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

/// `dbee-server audit verify FILE`: exit code and stdout.
async fn audit_verify(path: &Path) -> (Option<i32>, String) {
    let out = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbee-server"))
        .args(["audit", "verify"])
        .arg(path)
        .output()
        .await
        .unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).into(),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_upgrade_needs_the_host_the_origin_and_a_server_issued_session() {
    let server = start(None).await;
    // Fail closed: a fresh server has no session, so no cookie can pass (spec Open question 1).
    assert_eq!(
        server.upgrade(HOST, Some(ORIGIN), None).await.err(),
        Some(401)
    );
    assert_eq!(
        server
            .upgrade(HOST, Some(ORIGIN), Some(&"0".repeat(64)))
            .await
            .err(),
        Some(401)
    );
    let issued = server.server.issue_session(principal()).unwrap();
    // Host allowlist (every request), exact Origin (the upgrade).
    assert_eq!(
        server
            .upgrade("evil.test", Some(ORIGIN), Some(&issued.cookie))
            .await
            .err(),
        Some(421)
    );
    assert_eq!(
        server
            .upgrade(HOST, Some("https://evil.test"), Some(&issued.cookie))
            .await
            .err(),
        Some(403)
    );
    assert_eq!(
        server.upgrade(HOST, None, Some(&issued.cookie)).await.err(),
        Some(403)
    );
    assert!(
        server
            .upgrade(HOST, Some(ORIGIN), Some(&issued.cookie))
            .await
            .is_ok()
    );

    // Through the handshake: the core runs in server mode with the session-only secret store.
    let mut client = server.client().await;
    client.call(1, "app.info", json!({})).await;
    let info = client.expect_result(1).await;
    assert_eq!(info["mode"], "server");
    assert_eq!(info["secretStore"], "session-only");
    assert_eq!(info["schemaHash"], dbee_core::SCHEMA_HASH.as_str());
    assert_eq!(
        info["secretStoreNote"],
        dbee_server::SESSION_ONLY_REASON,
        "{info}"
    );
    assert_eq!(
        info["auditLogPath"],
        server.audit_log().display().to_string()
    );
    assert_eq!(client.call_and_list(2).await, Vec::<Value>::new());

    // A Hello without the session's anti-CSRF token is refused.
    let issued = server.server.issue_session(principal()).unwrap();
    let socket = server
        .upgrade(HOST, Some(ORIGIN), Some(&issued.cookie))
        .await
        .unwrap();
    let mut client = Client::new(Box::new(WsWire(socket)), None);
    client
        .send(&[json_frame(
            Kind::Hello,
            0,
            &json!({
                "protocol": 1,
                "api": dbee_core::API_NAME,
                "schema_hash": dbee_core::SCHEMA_HASH.as_str(),
                "client_version": "dbee-server-e2e",
                "auth": { "csrf": "not the token" },
            }),
        )])
        .await;
    client.expect_fatal(ambidex::Code::Unauthenticated).await;

    server.server.shutdown().await.unwrap();
}

trait ListConnections {
    async fn call_and_list(&mut self, call_id: u32) -> Vec<Value>;
}

impl ListConnections for Client {
    async fn call_and_list(&mut self, call_id: u32) -> Vec<Value> {
        self.call(call_id, "connections.list", json!({})).await;
        self.expect_result(call_id)
            .await
            .as_array()
            .cloned()
            .unwrap_or_default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_ui_is_served_with_its_headers_and_only_from_its_directory() {
    let dir = tempfile::tempdir().unwrap();
    let ui = dir.path().join("dist");
    std::fs::create_dir_all(ui.join("assets")).unwrap();
    std::fs::write(ui.join("index.html"), "<!doctype html><title>DBee</title>").unwrap();
    std::fs::write(ui.join("assets/app-1a2b.js"), "console.log('dbee')").unwrap();
    std::fs::write(ui.join("robots.txt"), "User-agent: *\n").unwrap();
    std::fs::write(dir.path().join("outside.txt"), "not served").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(dir.path().join("outside.txt"), ui.join("link.txt")).unwrap();
    let server = start(Some(ui.clone())).await;
    assert_eq!(
        server.server.ui_dir(),
        Some(ui.canonicalize().unwrap().as_path())
    );

    let index = server.http("GET", "/", HOST).await;
    assert_eq!(index.status, 200);
    assert_eq!(index.body, b"<!doctype html><title>DBee</title>");
    assert_eq!(
        index.header("content-type"),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(index.header("cache-control"), Some("no-cache"));
    let csp = index.header("content-security-policy").expect("CSP");
    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("connect-src 'self' wss://dbee.test"), "{csp}");
    assert!(csp.contains("worker-src 'self'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(!csp.contains("http:"), "{csp}");
    assert_eq!(index.header("x-content-type-options"), Some("nosniff"));
    assert_eq!(index.header("referrer-policy"), Some("no-referrer"));
    assert!(index.header("strict-transport-security").is_some());

    let asset = server.http("GET", "/assets/app-1a2b.js", HOST).await;
    assert_eq!(asset.status, 200);
    assert_eq!(asset.body, b"console.log('dbee')");
    assert_eq!(
        asset.header("content-type"),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        asset.header("cache-control"),
        Some("public, max-age=31536000, immutable")
    );
    let head = server.http("HEAD", "/assets/app-1a2b.js", HOST).await;
    assert_eq!(head.status, 200);
    assert!(head.body.is_empty());
    assert_eq!(head.header("content-length"), Some("19"));

    // Client-side routes fall back to the page; missing files do not.
    let route = server.http("GET", "/connections/c-1/query", HOST).await;
    assert_eq!(route.status, 200);
    assert_eq!(route.body, index.body);
    assert_eq!(server.http("GET", "/missing.png", HOST).await.status, 404);
    assert_eq!(server.http("GET", "/robots.txt", HOST).await.status, 200);

    // Nothing outside the directory, however the path is spelled.
    for path in [
        "/../outside.txt",
        "/assets/../../outside.txt",
        "/%2e%2e/outside.txt",
        "/assets/..%2f..%2foutside.txt",
        "/link.txt",
        "/assets%5c..%5c..%5coutside.txt",
    ] {
        let response = server.http("GET", path, HOST).await;
        assert_eq!(response.status, 404, "{path}");
        assert!(
            !response.body.windows(10).any(|w| w == b"not served"),
            "{path}"
        );
    }
    assert_eq!(server.http("POST", "/", HOST).await.status, 405);
    // The Host check covers the UI too (DNS rebinding).
    assert_eq!(server.http("GET", "/", "evil.test").await.status, 421);
    assert_eq!(server.http("GET", "/", "DBEE.TEST").await.status, 200);
    // The RPC path answers the browser, not the UI handler.
    assert_eq!(server.http("GET", "/rpc/ws", HOST).await.status, 403);
    server.server.shutdown().await.unwrap();

    // Without a UI directory every page is 404; a missing directory does not start.
    let bare = start(None).await;
    let response = bare.http("GET", "/", HOST).await;
    assert_eq!(response.status, 404);
    assert!(
        String::from_utf8_lossy(&response.body).contains("no UI directory"),
        "{:?}",
        response.body
    );
    bare.server.shutdown().await.unwrap();
    let (mut config, _) = config(dir.path(), Some(dir.path().join("nowhere")));
    config.workspace = dir.path().join("ws2");
    assert!(matches!(
        Server::start(config).await.err(),
        Some(StartError::Ui { .. })
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bad_configuration_does_not_start() {
    let dir = tempfile::tempdir().unwrap();
    let (good, _) = config(dir.path(), None);

    let mut no_hosts = good.clone();
    no_hosts.allowed_hosts.clear();
    assert!(matches!(
        Server::start(no_hosts).await.err(),
        Some(StartError::Web(_))
    ));
    let mut http_origin = good.clone();
    http_origin.public_origin = "http://dbee.test".into();
    assert!(matches!(
        Server::start(http_origin).await.err(),
        Some(StartError::Web(_))
    ));
    let mut no_cert = good.clone();
    no_cert.tls_cert = dir.path().join("missing.pem");
    assert!(matches!(
        Server::start(no_cert).await.err(),
        Some(StartError::Tls(_))
    ));
    let mut swapped = good.clone();
    std::mem::swap(&mut swapped.tls_cert, &mut swapped.tls_key);
    assert!(matches!(
        Server::start(swapped).await.err(),
        Some(StartError::Tls(_))
    ));
    let mut bad_ca = good.clone();
    bad_ca.deployment_cas = vec![good.tls_key.clone()];
    assert!(matches!(
        Server::start(bad_ca).await.err(),
        Some(StartError::Tls(_))
    ));
    // The server certificate is a valid CA file syntactically: loading it as a root works.
    let mut ca = good.clone();
    ca.deployment_cas = vec![good.tls_cert.clone()];
    Server::start(ca).await.unwrap().shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn audit_verify_checks_the_chain() {
    let server = start(None).await;
    let mut client = server.client().await;
    for id in 1..=3 {
        client.call(id, "app.info", json!({})).await;
        client.expect_result(id).await;
    }
    let log = server.audit_log();
    server.server.shutdown().await.unwrap();

    let (code, out) = audit_verify(&log).await;
    assert_eq!(code, Some(0), "{out}");
    assert!(out.contains("chain OK"), "{out}");
    // Three admissions and three completions, at least (restore writes nothing for an empty
    // workspace).
    let records: usize = out
        .lines()
        .find_map(|l| l.strip_prefix("records: "))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(records >= 6, "{out}");
    assert!(out.contains("unfinished calls: 0"), "{out}");

    // Tampering with one record breaks the chain.
    let text = std::fs::read_to_string(&log).unwrap();
    let mut lines: Vec<&str> = text.lines().collect();
    let edited = lines[1].replacen("app.info", "app.inf0", 1);
    assert_ne!(edited, lines[1]);
    lines[1] = &edited;
    std::fs::write(&log, lines.join("\n") + "\n").unwrap();
    let (code, out) = audit_verify(&log).await;
    assert_eq!(code, Some(1), "{out}");
    assert!(out.contains("chain BROKEN"), "{out}");

    // Truncating the tail is not detected (Ambidex Open question 13: anchoring is open), but a
    // missing file is an error.
    let (code, out) = audit_verify(&log.with_file_name("none.jsonl")).await;
    assert_eq!(code, Some(1), "{out}");

    let usage = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbee-server"))
        .arg("audit")
        .output()
        .await
        .unwrap();
    assert_eq!(usage.status.code(), Some(2));
    let help = tokio::process::Command::new(env!("CARGO_BIN_EXE_dbee-server"))
        .arg("--help")
        .output()
        .await
        .unwrap();
    assert_eq!(help.status.code(), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).contains("audit verify FILE"));
}

/// Spec §14: a server-issued session adds a connection, approves it, runs a query and receives
/// Arrow chunks over the WebSocket. Needs the throwaway PostgreSQL (required in CI).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_server_issued_session_adds_approves_and_queries_over_the_websocket() {
    let Some(pg) = cluster::cluster() else {
        return;
    };
    let server = start(None).await;
    let mut client = server.client().await;

    let draft = json!({
        "name": "Local",
        "host": "127.0.0.1",
        "port": pg.port,
        "database": "postgres",
        "user": "postgres",
        "tls": { "kind": "plaintext" },
        "hasSecret": false,
    });
    client.call(1, "connections.prepare", draft.clone()).await;
    let preview = client.expect_result(1).await;
    assert_eq!(preview["host"], "127.0.0.1", "{preview}");
    assert_eq!(preview["port"], pg.port, "{preview}");
    let digest = preview["previewDigest"]
        .as_str()
        .expect("digest")
        .to_owned();

    client
        .call(
            2,
            "connections.create",
            json!({ "draft": draft, "previewDigest": digest }),
        )
        .await;
    let summary = client.expect_result(2).await;
    let connection_id = summary["id"].as_str().expect("id").to_owned();
    let listed = client.call_and_list(3).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0]["id"], connection_id);

    client
        .call(
            4,
            "sessions.open",
            json!({ "connectionId": connection_id, "purpose": "editor" }),
        )
        .await;
    let opened = client.expect_result(4).await;
    let session_id = opened["sessionId"].as_str().expect("session").to_owned();

    client
        .call(
            5,
            "query.execute",
            json!({
                "sessionId": session_id,
                "sql": "select g::int8 as id, 'row ' || g as name from generate_series(1, 5) g",
            }),
        )
        .await;
    let mut decoder = IpcDecoder::new();
    let mut rows = 0;
    let mut chunks = 0;
    loop {
        let frame = client.recv().await.expect("a frame");
        match frame.kind {
            Kind::Chunk => {
                assert_eq!(frame.call_id, 5);
                assert!(frame.flags.is_binary());
                chunks += 1;
                for batch in decoder.push(&frame.payload).unwrap() {
                    rows += batch.num_rows();
                }
                // A client returns the credit it consumed (spec §6).
                client.credit(5, 1).await;
            }
            Kind::StreamEnd => {
                let end: Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(end["rowsReturned"], 5, "{end}");
                assert_eq!(end["statementKind"], "SELECT", "{end}");
                break;
            }
            other => panic!(
                "unexpected {other:?}: {}",
                String::from_utf8_lossy(&frame.payload)
            ),
        }
    }
    assert_eq!(rows, 5);
    assert!(chunks >= 2, "schema and at least one batch");
    let schema = decoder.schema().expect("schema");
    assert_eq!(schema.fields().len(), 2);
    assert_eq!(schema.field(0).name(), "id");

    client
        .call(6, "sessions.close", json!({ "sessionId": session_id }))
        .await;
    client.expect_result(6).await;
    client.disconnect().await;

    // The audit chain verifies, the broker entries hang off the DBee calls, no SQL text, no
    // password anywhere in the workspace (there was none to store).
    let log = server.audit_log();
    server.server.shutdown().await.unwrap();
    let (code, out) = audit_verify(&log).await;
    assert_eq!(code, Some(0), "{out}");
    let text = std::fs::read_to_string(&log).unwrap();
    assert!(!text.contains("generate_series"));
    let records = dbee_core::audit::read_records(&log).unwrap();
    let names: Vec<&str> = records
        .iter()
        .map(|r| r.entry.action.name.as_str())
        .collect();
    for expected in [
        "connections.prepare",
        "connections.create",
        "plugin-host.grants.create",
        "sessions.open",
        "plugin-host.broker.open",
        "query.execute",
    ] {
        assert!(names.contains(&expected), "{expected} missing in {names:?}");
    }
    let broker_open = records
        .iter()
        .find(|r| r.entry.action.name == "plugin-host.broker.open")
        .unwrap();
    assert!(broker_open.entry.parent_correlation_id.is_some());
    assert!(
        records
            .iter()
            .all(|r| r.entry.principal_chain[0].id == PRINCIPAL)
    );
    let connections =
        std::fs::read_to_string(log.parent().unwrap().join("../connections.json")).unwrap();
    assert!(connections.contains(&connection_id));
    assert!(!connections.contains("password"));
}
