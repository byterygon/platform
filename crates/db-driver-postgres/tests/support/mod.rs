//! A throwaway PostgreSQL cluster and a Plugin Host broker environment for driver tests.
//!
//! The cluster is started once per test binary from the `initdb`/`postgres` binaries found in
//! `BYTERYGON_PG_BIN`, on `PATH` or under `/usr/lib/postgresql/*/bin`, listens on 127.0.0.1 only,
//! serves TLS with a test CA, and is stopped and deleted by a watchdog when the test process
//! exits. Without binaries (or as root, which `initdb` refuses) the tests are skipped, unless
//! `BYTERYGON_REQUIRE_POSTGRES` is set, as in CI.

#![allow(dead_code)]

use std::collections::{BTreeSet, HashMap};
use std::io::Cursor;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use arrow_array::RecordBatch;
use arrow_ipc::reader::StreamReader;
use arrow_schema::SchemaRef;
use db_driver::conformance::{self, Drained};
use db_driver::{
    Connection, ConnectionBroker, DbError, DbFuture, Driver, ExecuteOptions, OperationId,
    QuerySummary,
};
use db_driver_postgres::{AccessMode, Password, PgSettings, PgTls, PostgresDriver, SettingsSource};
use plugin_host::grant::address_policy;
use plugin_host::{
    AuditSink, BrokerConfig, Caller, ContractBroker, DriverKind, Eligibility, GrantId,
    GrantRequest, GrantStore, InstalledPlugin, Manifest, MemoryAuditLog, NativeBroker,
    SecretBinding, ServerTrust, SystemClock, TlsMode, TlsPolicy, TlsSettings,
};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use security_types::{
    Authorizer, AuthzRequest, Decision, Digest, Principal, PrincipalKind, RoleId, SessionId,
    TenantId,
};

pub const TARGET: &str = "pg";
pub const SERVER_NAME: &str = "db.test";
pub const PLUGIN_ID: &str = "com.byterygon.dbee.postgres";
pub const PLUGIN_DIGEST: Digest = Digest([0x5a; 32]);

/// Logins created in the cluster: (user, password, pg_hba method).
pub const APP: (&str, &str) = ("app", "app-secret-6b1f");
pub const TLS_ONLY: (&str, &str) = ("tls_user", "tls-secret-90ad");
pub const MD5: (&str, &str) = ("md5_user", "md5-secret-1c2e");
pub const CLEARTEXT: (&str, &str) = ("pw_user", "pw-secret-77d0");

const MANIFEST: &str = r#"
manifest_version = 1
id = "com.byterygon.dbee.postgres"
version = "0.1.0"
kind = "wasm"
entry = "builtin"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "byterygon"

[[capabilities.network]]
id = "db"
protocol = "tcp"
default_port = 5432
tls = "optional"
allow_in_protocol_tls_upgrade = true
allow_cancel_connection = true

[[capabilities.secrets]]
id = "db-credentials"
purpose = "database-auth"
scope = "connection"
needs_credential = true
"#;

const HBA: &str = "\
host    all  postgres  127.0.0.1/32  trust
hostssl all  tls_user  127.0.0.1/32  scram-sha-256
host    all  tls_user  127.0.0.1/32  reject
host    all  md5_user  127.0.0.1/32  md5
host    all  pw_user   127.0.0.1/32  password
host    all  all       127.0.0.1/32  scram-sha-256
";

const SETUP: &[&str] = &[
    "CREATE ROLE app LOGIN PASSWORD 'app-secret-6b1f'",
    "CREATE ROLE tls_user LOGIN PASSWORD 'tls-secret-90ad'",
    "CREATE ROLE pw_user LOGIN PASSWORD 'pw-secret-77d0'",
    "SET password_encryption = 'md5'",
    "CREATE ROLE md5_user LOGIN PASSWORD 'md5-secret-1c2e'",
    "GRANT pg_read_all_data, pg_write_all_data TO app, tls_user",
    "CREATE TABLE public.items (
        id int4 PRIMARY KEY, flag bool, small int2, big int8, f4 float4, ratio float8,
        name text NOT NULL, note varchar(20), price numeric(10,2), data bytea, uid uuid,
        day date, at time, local timestamp, created timestamptz, js jsonb, tags text[], o oid)",
    "INSERT INTO public.items VALUES
        (1, true, 7, 9000000000, 1.5, 0.25, 'zażółć', 'n', 12.50, '\\x00ff10'::bytea,
         'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2024-02-29', '13:14:15.5',
         '2024-02-29 13:14:15.123456', '2024-02-29 13:14:15.123456+02', '{\"k\": [1, 2]}',
         '{a,b}', 42),
        (2, NULL, NULL, NULL, NULL, NULL, 'nulls', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, NULL, NULL),
        (3, false, -1, -1, 'NaN', '-Infinity', '', '', -0.01, '', NULL, 'infinity', '00:00',
         '-infinity', 'infinity', 'null', '{}', 0)",
    "CREATE SCHEMA sales",
    "CREATE TABLE sales.orders (id int8 GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        item_id int4 NOT NULL, qty int4, note text)",
    "CREATE VIEW sales.big_orders AS SELECT * FROM sales.orders WHERE qty > 10",
    "CREATE TABLE sales.empty ()",
    "GRANT USAGE ON SCHEMA sales TO app",
];

pub struct Cluster {
    pub port: u16,
    /// DER of the CA that signed the server certificate for [`SERVER_NAME`].
    pub ca: Vec<u8>,
}

/// The shared cluster, or `None` when the tests must be skipped.
pub fn cluster() -> Option<&'static Cluster> {
    static CLUSTER: OnceLock<Option<Cluster>> = OnceLock::new();
    CLUSTER
        .get_or_init(|| {
            // Setup needs its own runtime; the calling test may be inside one.
            let started = std::thread::spawn(start_cluster).join().unwrap();
            match started {
                Ok(cluster) => Some(cluster),
                Err(why) if std::env::var_os("BYTERYGON_REQUIRE_POSTGRES").is_some() => {
                    panic!("PostgreSQL is required but unavailable: {why}")
                }
                Err(why) => {
                    eprintln!("skipping PostgreSQL driver tests: {why}");
                    None
                }
            }
        })
        .as_ref()
}

/// Returns early from a test when no cluster is available.
#[macro_export]
macro_rules! require_cluster {
    () => {
        match support::cluster() {
            Some(c) => c,
            None => return,
        }
    };
}

fn bin_dir() -> Option<PathBuf> {
    let has = |d: &Path| d.join("initdb").is_file() && d.join("postgres").is_file();
    if let Some(dir) = std::env::var_os("BYTERYGON_PG_BIN") {
        return Some(dir.into());
    }
    if let Some(path) = std::env::var_os("PATH")
        && let Some(dir) = std::env::split_paths(&path).find(|d| has(d))
    {
        return Some(dir);
    }
    // Debian/Ubuntu keep server binaries off PATH.
    let mut found: Vec<(u32, PathBuf)> = std::fs::read_dir("/usr/lib/postgresql")
        .ok()?
        .filter_map(|e| {
            let e = e.ok()?;
            let version = e.file_name().to_str()?.parse().ok()?;
            let dir = e.path().join("bin");
            has(&dir).then_some((version, dir))
        })
        .collect();
    found.sort();
    found.pop().map(|(_, dir)| dir)
}

fn start_cluster() -> Result<Cluster, String> {
    let bin = bin_dir().ok_or("no initdb/postgres binaries found")?;
    let uid = Command::new("id")
        .arg("-u")
        .output()
        .map_err(|e| e.to_string())?;
    if String::from_utf8_lossy(&uid.stdout).trim() == "0" {
        return Err("initdb refuses to run as root".into());
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .subsec_nanos();
    let data = std::env::temp_dir().join(format!("byterygon-pg-{}-{nanos}", std::process::id()));
    let out = Command::new(bin.join("initdb"))
        .arg("-D")
        .arg(&data)
        .args([
            "-U",
            "postgres",
            "--auth=trust",
            "--no-sync",
            "-E",
            "UTF8",
            "--locale=C",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "initdb failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }

    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params
        .distinguished_name
        .push(DnType::CommonName, "Byterygon test CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = Issuer::new(ca_params, ca_key);
    let key = KeyPair::generate().unwrap();
    let cert = CertificateParams::new(vec![SERVER_NAME.to_owned()])
        .unwrap()
        .signed_by(&key, &issuer)
        .unwrap();
    std::fs::write(data.join("server.crt"), cert.pem()).unwrap();
    std::fs::write(data.join("server.key"), key.serialize_pem()).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        data.join("server.key"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();

    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let conf = format!(
        "listen_addresses = '127.0.0.1'\nport = {port}\nunix_socket_directories = ''\n\
         ssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n\
         fsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 200\n"
    );
    let mut existing = std::fs::read_to_string(data.join("postgresql.conf")).unwrap();
    existing.push_str(&conf);
    std::fs::write(data.join("postgresql.conf"), existing).unwrap();
    std::fs::write(data.join("pg_hba.conf"), HBA).unwrap();

    // The watchdog stops the server and deletes its files once this test process is gone.
    Command::new("sh")
        .arg("-c")
        .arg(
            r#""$1/postgres" -D "$2" >"$2.log" 2>&1 & pg=$!
               while kill -0 "$3" 2>/dev/null && kill -0 "$pg" 2>/dev/null; do sleep 0.2; done
               kill -INT "$pg" 2>/dev/null; wait "$pg"; rm -rf "$2" "$2.log""#,
        )
        .arg("sh")
        .arg(&bin)
        .arg(&data)
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;

    let cluster = Cluster {
        port,
        ca: ca.der().to_vec(),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let deadline = Instant::now() + Duration::from_secs(60);
        let conn = loop {
            let env = Env::new(&cluster, Grant::plain()).await;
            match env.connect(alice(), superuser()).await {
                Ok(conn) => break conn,
                Err(e) if Instant::now() > deadline => {
                    return Err(format!("server not ready: {e}"));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };
        for (i, sql) in SETUP.iter().enumerate() {
            let drained = run(
                &*conn,
                &format!("setup-{i}"),
                sql,
                ExecuteOptions::default(),
            )
            .await;
            if let Err(e) = drained.terminal {
                return Err(format!("setup failed at {sql:?}: {e}"));
            }
        }
        Ok(())
    })?;
    Ok(cluster)
}

// ---------------------------------------------------------------------------------------------
// Broker environment
// ---------------------------------------------------------------------------------------------

struct AllowAll;

impl Authorizer for AllowAll {
    fn check(&self, _req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(Decision::Allow)
    }
}

fn principal(kind: PrincipalKind, id: &str, roles: &[&str]) -> Principal {
    Principal {
        kind,
        id: id.into(),
        tenant: TenantId::new("t1"),
        on_behalf_of: None,
        roles: roles.iter().map(|r| RoleId::new(*r)).collect(),
        session: SessionId::new("s1"),
    }
}

pub fn admin() -> Principal {
    principal(PrincipalKind::Human, "human:oidc:admin", &["admin"])
}

pub fn alice() -> Principal {
    principal(PrincipalKind::Human, "human:oidc:alice", &["analyst"])
}

/// An agent acting for alice.
pub fn agent() -> Principal {
    let mut agent = principal(PrincipalKind::Agent, "agent:token:a", &["agent-read"]);
    agent.on_behalf_of = Some(Box::new(alice()));
    agent
}

/// Someone the grant does not name.
pub fn mallory() -> Principal {
    principal(PrincipalKind::Human, "human:oidc:mallory", &["guest"])
}

pub fn plugin() -> InstalledPlugin {
    InstalledPlugin {
        id: PLUGIN_ID.into(),
        digest: PLUGIN_DIGEST,
        driver_kind: DriverKind::Native,
        capabilities: Manifest::from_toml(MANIFEST).unwrap().capabilities,
    }
}

/// What the approver grants.
#[derive(Clone)]
pub struct Grant {
    pub tls: Option<Vec<u8>>,
    pub allow_cancel: bool,
}

impl Grant {
    pub fn plain() -> Self {
        Self {
            tls: None,
            allow_cancel: true,
        }
    }

    /// In-protocol TLS upgrade, verified against `ca`.
    pub fn tls(ca: &[u8]) -> Self {
        Self {
            tls: Some(ca.to_vec()),
            allow_cancel: true,
        }
    }
}

pub struct Env {
    pub audit: Arc<MemoryAuditLog>,
    pub grants: Arc<GrantStore>,
    pub broker: Arc<NativeBroker>,
    pub grant: GrantId,
}

impl Env {
    pub async fn new(cluster: &Cluster, grant: Grant) -> Self {
        Self::with_config(cluster, grant, BrokerConfig::default()).await
    }

    pub async fn with_config(cluster: &Cluster, grant: Grant, config: BrokerConfig) -> Self {
        let audit = Arc::new(MemoryAuditLog::new());
        let grants = Arc::new(GrantStore::new(
            Arc::new(SystemClock),
            audit.clone() as Arc<dyn AuditSink>,
        ));
        let broker = NativeBroker::new(grants.clone(), plugin_host::SystemResolver, config);
        let request = GrantRequest {
            tenant: TenantId::new("t1"),
            owner: "human:oidc:alice".into(),
            eligible: Eligibility {
                principals: BTreeSet::new(),
                roles: [RoleId::new("analyst"), RoleId::new("agent-read")]
                    .into_iter()
                    .collect(),
            },
            connection_id: "personal:alice:pg".into(),
            target_id: TARGET.into(),
            template_id: "db".into(),
            host: "127.0.0.1".into(),
            port: cluster.port,
            tls: match &grant.tls {
                None => TlsPolicy::Disabled,
                Some(ca) => TlsPolicy::Enabled(TlsSettings {
                    mode: TlsMode::InProtocolUpgrade,
                    server_name: SERVER_NAME.into(),
                    trust: ServerTrust::PinnedCas(vec![ca.clone()]),
                }),
            },
            addresses: address_policy(&["127.0.0.1/32"]).unwrap(),
            secret: Some(SecretBinding {
                template_id: "db-credentials".into(),
                secret_ref: "cred-1".into(),
            }),
            allow_cancel_connection: grant.allow_cancel,
            expires_at_unix_ms: None,
        };
        let created = grants
            .create(&AllowAll, &admin(), &plugin(), request, "corr-grant")
            .await
            .unwrap();
        Self {
            audit,
            grants,
            broker,
            grant: created.id.clone(),
        }
    }

    /// The contract broker for one principal, as the host would hand it to the driver.
    pub fn broker_for(&self, principal: Principal) -> Arc<dyn ConnectionBroker> {
        Arc::new(ContractBroker::new(self.broker.scope(Caller {
            plugin_id: PLUGIN_ID.into(),
            plugin_digest: PLUGIN_DIGEST,
            driver_kind: DriverKind::Native,
            principal,
            correlation_id: "corr-test".into(),
        })))
    }

    pub async fn connect(
        &self,
        principal: Principal,
        settings: PgSettings,
    ) -> Result<Box<dyn Connection>, DbError> {
        let broker = self.broker_for(principal);
        let driver =
            PostgresDriver::new(broker.clone(), Arc::new(Settings::one("cred-1", settings)));
        driver.connect(&*broker, TARGET, Some("cred-1")).await
    }

    pub async fn revoke(&self) {
        self.grants
            .revoke(&AllowAll, &admin(), &self.grant, "corr-revoke")
            .await
            .unwrap();
    }

    /// Names of broker audit actions, with their outcome codes.
    pub fn broker_actions(&self) -> Vec<(String, security_types::Outcome)> {
        self.audit
            .records()
            .into_iter()
            .filter(|r| r.entry.action.name.starts_with("plugin-host.broker."))
            .map(|r| (r.entry.action.name.clone(), r.entry.outcome.clone()))
            .collect()
    }
}

/// A host settings source holding settings per credential reference.
pub struct Settings(Mutex<HashMap<String, PgSettings>>);

impl Settings {
    pub fn one(credential_ref: &str, settings: PgSettings) -> Self {
        Self(Mutex::new(HashMap::from([(
            credential_ref.to_owned(),
            settings,
        )])))
    }
}

impl SettingsSource for Settings {
    fn settings<'a>(
        &'a self,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, PgSettings> {
        Box::pin(async move {
            let found = credential_ref.and_then(|r| self.0.lock().unwrap().get(r).cloned());
            match found {
                Some(s) if target_id == TARGET => Ok(s),
                _ => Err(DbError::PermissionDenied),
            }
        })
    }
}

pub fn login((user, password): (&str, &str)) -> PgSettings {
    PgSettings {
        user: user.into(),
        database: "postgres".into(),
        password: Some(Password::new(password)),
        tls: PgTls::Disabled,
        access: AccessMode::ReadWrite,
        application_name: "dbee-test".into(),
        connect_timeout: Duration::from_secs(10),
    }
}

pub fn superuser() -> PgSettings {
    PgSettings {
        password: None,
        ..login(("postgres", ""))
    }
}

pub fn with_tls(settings: PgSettings) -> PgSettings {
    PgSettings {
        tls: PgTls::InProtocolUpgrade {
            server_name: SERVER_NAME.into(),
        },
        ..settings
    }
}

pub fn read_only(settings: PgSettings) -> PgSettings {
    PgSettings {
        access: AccessMode::ReadOnly,
        ..settings
    }
}

// ---------------------------------------------------------------------------------------------
// Running statements
// ---------------------------------------------------------------------------------------------

pub fn op(id: &str) -> OperationId {
    OperationId(id.into())
}

/// Executes and drains one statement, checking the contract lifecycle on the way.
pub async fn run(conn: &dyn Connection, id: &str, sql: &str, opts: ExecuteOptions) -> Drained {
    match conn.execute(&op(id), sql, opts).await {
        Ok(mut stream) => conformance::drain(&mut *stream).await,
        Err(error) => Drained {
            chunks: Vec::new(),
            terminal: Err(error),
        },
    }
}

/// A successful statement's batches and summary, after checking the chunks.
pub async fn query(
    conn: &dyn Connection,
    id: &str,
    sql: &str,
    opts: ExecuteOptions,
) -> (SchemaRef, Vec<RecordBatch>, QuerySummary) {
    let drained = run(conn, id, sql, opts).await;
    let summary = drained.terminal.unwrap_or_else(|e| panic!("{sql}: {e}"));
    let (schema, batches) = decode(&drained.chunks);
    (schema, batches, summary)
}

/// Checks that every chunk holds whole IPC messages, the first being the schema and the last
/// ending with the end-of-stream marker, then decodes the concatenated stream.
pub fn decode(chunks: &[Vec<u8>]) -> (SchemaRef, Vec<RecordBatch>) {
    assert!(!chunks.is_empty(), "no chunks");
    let mut first = true;
    for (i, chunk) in chunks.iter().enumerate() {
        let mut at = 0;
        while at < chunk.len() {
            assert_eq!(&chunk[at..at + 4], &[0xff; 4], "continuation marker");
            let len = i32::from_le_bytes(chunk[at + 4..at + 8].try_into().unwrap()) as usize;
            if len == 0 {
                assert_eq!(i, chunks.len() - 1, "end-of-stream only in the last chunk");
                assert_eq!(at + 8, chunk.len(), "nothing after end-of-stream");
                at += 8;
                continue;
            }
            let message = arrow_ipc::root_as_message(&chunk[at + 8..at + 8 + len]).unwrap();
            if first {
                assert_eq!(
                    message.header_type(),
                    arrow_ipc::MessageHeader::Schema,
                    "schema first"
                );
                first = false;
            }
            at += 8 + len + message.bodyLength() as usize;
        }
        assert_eq!(at, chunk.len(), "chunk {i} splits a message");
    }
    assert!(
        chunks
            .last()
            .unwrap()
            .ends_with(&[0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]),
        "end-of-stream marker"
    );
    let bytes = chunks.concat();
    let reader = StreamReader::try_new(Cursor::new(bytes), None).unwrap();
    let schema = reader.schema();
    let batches = reader.collect::<Result<Vec<_>, _>>().unwrap();
    (schema, batches)
}
