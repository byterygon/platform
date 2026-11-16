//! Test support: a core on a temporary workspace with an in-memory keychain, a pinned resolver
//! and a fake driver that needs no database; calls through the router directly, and through the
//! Ambidex engine on an in-memory transport for streams.

#![allow(dead_code)]

pub mod cluster;

use std::collections::HashMap;
use std::io;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ambidex::engine::BoxFuture as EngineFuture;
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{Authenticate, Call, ErrorPayload, Hello, Router, Server, Session};
use ambidex_conformance::client::{Client, LocalBoxFuture, Wire, json_frame};
use arrow_array::{Int64Array, RecordBatch, StringArray};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema};
use db_driver::{
    CancelOutcome, ColumnInfo, Connection, ConnectionBroker, DbError, DbFuture, ExecuteOptions,
    NextItem, OperationId, QuerySummary, ResultStream, TableInfo,
};
use dbee_core::driver::{DriverFactory, Resolve};
use dbee_core::secrets::{MemorySecretStore, SecretStore};
use dbee_core::{AppMode, AuditConfig, Core, CoreConfig, SecretStoreConfig};
use security_types::{AuditRecord, BoxFuture, Principal, PrincipalKind, SessionId, TenantId};
use serde_json::{Value, json};
use tokio::sync::Notify;

pub const PASSWORD: &str = "pw-7f3a9c-not-for-logs";
pub const TESTER: &str = "human:local:tester";

// ---------------------------------------------------------------------------------------------
// Fake driver
// ---------------------------------------------------------------------------------------------

/// What the fake driver saw.
#[derive(Default)]
pub struct Probe {
    pub connects: AtomicUsize,
    pub cancels: AtomicUsize,
    /// Fails every connect with this error.
    pub fail_connect: Mutex<Option<DbError>>,
}

pub struct FakeFactory(pub Arc<Probe>);

impl DriverFactory for FakeFactory {
    fn connect<'a>(
        &'a self,
        _broker: Arc<dyn ConnectionBroker>,
        _target_id: &'a str,
        _credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, Box<dyn Connection>> {
        Box::pin(async move {
            if let Some(e) = self.0.fail_connect.lock().unwrap().clone() {
                return Err(e);
            }
            self.0.connects.fetch_add(1, Ordering::SeqCst);
            Ok(Box::new(FakeConnection(Arc::clone(&self.0))) as Box<dyn Connection>)
        })
    }
}

struct FakeConnection(Arc<Probe>);

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("name", DataType::Utf8, true),
    ]))
}

/// The IPC chunks of a small result: schema, one batch, end marker.
pub fn ipc_chunks(rows: &[(i64, Option<&str>)]) -> Vec<Vec<u8>> {
    let schema = schema();
    let mut writer = StreamWriter::try_new(Vec::new(), &schema).unwrap();
    let mut chunks = vec![std::mem::take(writer.get_mut())];
    let batch = RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from_iter_values(rows.iter().map(|r| r.0))),
            Arc::new(StringArray::from(
                rows.iter().map(|r| r.1).collect::<Vec<_>>(),
            )),
        ],
    )
    .unwrap();
    writer.write(&batch).unwrap();
    chunks.push(std::mem::take(writer.get_mut()));
    writer.finish().unwrap();
    chunks.push(std::mem::take(writer.get_mut()));
    chunks
}

fn text_chunks(value: &str) -> Vec<Vec<u8>> {
    let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Utf8, false)]));
    let mut writer = StreamWriter::try_new(Vec::new(), &schema).unwrap();
    let mut chunks = vec![std::mem::take(writer.get_mut())];
    let batch =
        RecordBatch::try_new(schema, vec![Arc::new(StringArray::from(vec![value]))]).unwrap();
    writer.write(&batch).unwrap();
    chunks.push(std::mem::take(writer.get_mut()));
    writer.finish().unwrap();
    chunks.push(std::mem::take(writer.get_mut()));
    chunks
}

struct FakeStream {
    probe: Arc<Probe>,
    chunks: std::vec::IntoIter<Vec<u8>>,
    /// Hang after the chunks until cancelled.
    hang: bool,
    cancelled: Arc<Notify>,
    is_cancelled: Arc<std::sync::atomic::AtomicBool>,
    rows: u64,
    done: bool,
}

impl ResultStream for FakeStream {
    fn next(&mut self) -> DbFuture<'_, Option<NextItem>> {
        Box::pin(async move {
            if self.done {
                return Ok(None);
            }
            if let Some(chunk) = self.chunks.next() {
                return Ok(Some(NextItem::Chunk(chunk)));
            }
            if self.hang {
                if !self.is_cancelled.load(Ordering::SeqCst) {
                    self.cancelled.notified().await;
                }
                self.done = true;
                return Err(DbError::Cancelled);
            }
            self.done = true;
            Ok(Some(NextItem::Finished(QuerySummary {
                rows_affected: None,
                rows_returned: Some(self.rows),
                elapsed_ms: 1,
                notices: vec![],
                truncated: false,
            })))
        })
    }

    fn cancel(&self) -> DbFuture<'_, CancelOutcome> {
        Box::pin(async move {
            self.probe.cancels.fetch_add(1, Ordering::SeqCst);
            self.is_cancelled.store(true, Ordering::SeqCst);
            self.cancelled.notify_waiters();
            Ok(CancelOutcome::Requested)
        })
    }
}

impl Connection for FakeConnection {
    fn execute<'a>(
        &'a self,
        _operation_id: &'a OperationId,
        sql: &'a str,
        _opts: ExecuteOptions,
    ) -> DbFuture<'a, Box<dyn ResultStream>> {
        Box::pin(async move {
            let lower = sql.to_ascii_lowercase();
            if lower.contains("syntax error") {
                return Err(DbError::InvalidQuery(db_driver::QueryError {
                    message: "syntax error at or near \"error\"".into(),
                    position: Some(8),
                    sqlstate: Some("42601".into()),
                    vendor_code: None,
                }));
            }
            let (chunks, hang, rows) = if lower.starts_with("show server_version") {
                (text_chunks("16.1 (fake)"), false, 1)
            } else if lower.contains("pg_sleep") {
                (ipc_chunks(&[])[..1].to_vec(), true, 0)
            } else {
                (
                    ipc_chunks(&[(1, Some("a,b")), (2, None), (3, Some(""))]),
                    false,
                    3,
                )
            };
            Ok(Box::new(FakeStream {
                probe: Arc::clone(&self.0),
                chunks: chunks.into_iter(),
                hang,
                cancelled: Arc::new(Notify::new()),
                is_cancelled: Arc::default(),
                rows,
                done: false,
            }) as Box<dyn ResultStream>)
        })
    }

    fn cancel<'a>(&'a self, _operation_id: &'a OperationId) -> DbFuture<'a, CancelOutcome> {
        Box::pin(std::future::ready(Ok(CancelOutcome::NotRunning)))
    }

    fn schemas(&self) -> DbFuture<'_, Vec<String>> {
        Box::pin(std::future::ready(Ok(vec![
            "public".into(),
            "sales".into(),
        ])))
    }

    fn tables<'a>(&'a self, schema: Option<&'a str>) -> DbFuture<'a, Vec<TableInfo>> {
        Box::pin(std::future::ready(Ok(vec![TableInfo {
            schema: schema.map(str::to_owned),
            name: "items".into(),
            kind: "table".into(),
        }])))
    }

    fn columns<'a>(
        &'a self,
        _schema: Option<&'a str>,
        _table: &'a str,
    ) -> DbFuture<'a, Vec<ColumnInfo>> {
        Box::pin(std::future::ready(Ok(vec![ColumnInfo {
            name: "id".into(),
            type_name: "int8".into(),
            nullable: false,
        }])))
    }
}

// ---------------------------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------------------------

/// Answers from a table; unknown names fail like NXDOMAIN.
pub struct PinnedResolver(pub Mutex<HashMap<String, Vec<IpAddr>>>);

impl PinnedResolver {
    pub fn new() -> Arc<PinnedResolver> {
        let mut map = HashMap::new();
        map.insert("localhost".to_owned(), vec!["127.0.0.1".parse().unwrap()]);
        map.insert("db.example".to_owned(), vec!["10.1.2.3".parse().unwrap()]);
        Arc::new(PinnedResolver(Mutex::new(map)))
    }

    pub fn set(&self, host: &str, addrs: &[&str]) {
        self.0.lock().unwrap().insert(
            host.to_owned(),
            addrs.iter().map(|a| a.parse().unwrap()).collect(),
        );
    }
}

impl Resolve for PinnedResolver {
    fn resolve(&self, host: &str, _port: u16) -> BoxFuture<'_, io::Result<Vec<IpAddr>>> {
        let found = self.0.lock().unwrap().get(host).cloned();
        Box::pin(std::future::ready(found.ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "no such host")
        })))
    }
}

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

/// A wall clock that moves only when a test advances it, so expiry tests do not sleep and can
/// jump over a deadline the way a machine waking from sleep does.
pub struct ManualClock(tokio::sync::watch::Sender<u64>);

impl ManualClock {
    pub fn at(ms: u64) -> Arc<Self> {
        Arc::new(Self(tokio::sync::watch::Sender::new(ms)))
    }

    pub fn advance(&self, ms: u64) {
        self.0.send_modify(|now| *now += ms);
    }
}

impl security_types::Clock for ManualClock {
    fn now_unix_ms(&self) -> u64 {
        *self.0.borrow()
    }

    fn sleep_until(&self, deadline_unix_ms: u64) -> BoxFuture<'_, ()> {
        let mut now = self.0.subscribe();
        Box::pin(async move {
            let _ = now.wait_for(|now| *now >= deadline_unix_ms).await;
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------------------------

pub struct TestCore {
    pub core: Core,
    pub dir: tempfile::TempDir,
    pub keychain: Arc<MemorySecretStore>,
    pub probe: Arc<Probe>,
    pub resolver: Arc<PinnedResolver>,
}

#[derive(Default)]
pub struct Options {
    pub secret_store: Option<SecretStoreConfig>,
    pub audit: Option<AuditConfig>,
    pub dir: Option<tempfile::TempDir>,
    pub clock: Option<Arc<dyn security_types::Clock>>,
}

impl TestCore {
    pub async fn start() -> TestCore {
        TestCore::with(Options::default()).await
    }

    pub async fn with(options: Options) -> TestCore {
        let dir = options.dir.unwrap_or_else(|| tempfile::tempdir().unwrap());
        let keychain = Arc::new(MemorySecretStore::new());
        let probe = Arc::new(Probe::default());
        let resolver = PinnedResolver::new();
        let mut config = CoreConfig::new(dir.path(), AppMode::Standalone);
        config.secret_store = options.secret_store.unwrap_or_else(|| {
            SecretStoreConfig::Store(Arc::clone(&keychain) as Arc<dyn SecretStore>)
        });
        if let Some(audit) = options.audit {
            config.audit = audit;
        }
        if let Some(clock) = options.clock {
            config.clock = clock;
        }
        config.resolver = Arc::clone(&resolver) as Arc<dyn Resolve>;
        config.driver_factory = Some(Arc::new(FakeFactory(Arc::clone(&probe))));
        let core = Core::start(config).await.expect("core starts");
        TestCore {
            core,
            dir,
            keychain,
            probe,
            resolver,
        }
    }

    pub fn router(&self) -> Router {
        self.core.router()
    }

    pub fn workspace_dir(&self) -> &Path {
        self.dir.path()
    }

    pub fn audit_path(&self) -> PathBuf {
        self.dir.path().join("audit/log.jsonl")
    }

    /// Every record of the workspace audit log, verified.
    pub fn audit_records(&self) -> Vec<AuditRecord> {
        dbee_core::audit::read_records(&self.audit_path()).expect("audit log verifies")
    }

    /// The text of every file under the workspace directory.
    pub fn workspace_text(&self) -> String {
        let mut out = String::new();
        fn walk(dir: &Path, out: &mut String) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(&path, out);
                } else {
                    out.push_str(&String::from_utf8_lossy(&std::fs::read(&path).unwrap()));
                }
            }
        }
        walk(self.dir.path(), &mut out);
        out
    }

    /// Runs a procedure through the router as the tester (outside the engine).
    pub async fn call(&self, procedure: &str, input: Value) -> Result<Value, ErrorPayload> {
        self.call_as(&tester(), procedure, input).await
    }

    pub async fn call_as(
        &self,
        principal: &Principal,
        procedure: &str,
        input: Value,
    ) -> Result<Value, ErrorPayload> {
        let session = Arc::new(Session {
            id: "test-session".into(),
            principal: principal.clone(),
        });
        self.router()
            .call(session, Call::new(procedure, input))
            .await
    }

    pub async fn ok(&self, procedure: &str, input: Value) -> Value {
        match self.call(procedure, input).await {
            Ok(v) => v,
            Err(e) => panic!("{procedure} failed: {e:?}"),
        }
    }

    pub async fn err(&self, procedure: &str, input: Value) -> ErrorPayload {
        match self.call(procedure, input).await {
            Ok(v) => panic!("{procedure} succeeded: {v}"),
            Err(e) => e,
        }
    }

    /// Prepares and approves a plaintext connection to `localhost`, with the test password.
    pub async fn approve(&self, name: &str) -> Value {
        let draft = draft(name);
        let preview = self.ok("connections.prepare", draft.clone()).await;
        self.ok(
            "connections.create",
            json!({
                "draft": draft,
                "previewDigest": preview["previewDigest"],
                "secret": { "password": PASSWORD },
            }),
        )
        .await
    }

    /// A client on the engine over an in-memory transport, handshake done.
    pub async fn connect(&self) -> Client {
        TestCore::connect_to(&self.core).await
    }

    /// The same for any core.
    pub async fn connect_to(core: &Core) -> Client {
        let server = Server::new(core.server_config(), TestAuth, core.router());
        let ((server_rx, server_tx), (client_rx, client_tx)) = memory(16);
        let _connection = server.serve(server_rx, server_tx);
        let mut client = Client::new(
            Box::new(MemoryWire {
                rx: client_rx,
                tx: client_tx,
            }),
            None,
        );
        let hello = json_frame(
            ambidex::Kind::Hello,
            0,
            &json!({
                "protocol": 1,
                "api": dbee_core::API_NAME,
                "schema_hash": dbee_core::SCHEMA_HASH.as_str(),
                "client_version": "dbee-core-tests",
            }),
        );
        client.send(&[hello]).await;
        let frame = client.recv().await.expect("HelloAck");
        assert_eq!(
            frame.kind,
            ambidex::Kind::HelloAck,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        client
    }
}

pub fn draft(name: &str) -> Value {
    json!({
        "name": name,
        "host": "localhost",
        "port": 5432,
        "database": "app",
        "user": "app",
        "tls": { "kind": "plaintext" },
        "hasSecret": true,
    })
}

pub fn tester() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: TESTER.into(),
        tenant: TenantId::new("local"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("test-session"),
    }
}

/// Accepts every Hello as the tester.
pub struct TestAuth;

impl Authenticate for TestAuth {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> EngineFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "engine-session".into(),
                principal: tester(),
            })
        })
    }
}

struct MemoryWire {
    rx: MemoryRx,
    tx: MemoryTx,
}

impl Wire for MemoryWire {
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, io::Result<()>> {
        Box::pin(async move { self.tx.send(bytes).await })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>> {
        Box::pin(async move { self.rx.recv().await.ok().flatten() })
    }

    fn close(&mut self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.tx.close().await;
        })
    }
}

/// `details.kind` of an error payload.
pub fn kind(err: &ErrorPayload) -> String {
    err.details
        .as_ref()
        .and_then(|d| d.get("kind"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}
