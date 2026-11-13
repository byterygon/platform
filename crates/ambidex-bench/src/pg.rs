//! The PostgreSQL side: a throwaway cluster (or an external server), the broker environment the
//! driver needs, and the table generator.
//!
//! The benchmark goes through the same path as a product: `PostgresDriver` opens its connection
//! through a Plugin Host `NativeBroker` bound to a grant that allows 127.0.0.1 only.

use std::collections::BTreeSet;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use db_driver::{
    Connection, ConnectionBroker, DbError, DbFuture, Driver, ExecuteOptions, NextItem, OperationId,
};
use db_driver_postgres::{AccessMode, Password, PgSettings, PgTls, PostgresDriver, SettingsSource};
use plugin_host::grant::address_policy;
use plugin_host::{
    AuditSink, BrokerConfig, Caller, ContractBroker, DriverKind, Eligibility, GrantRequest,
    GrantStore, InstalledPlugin, Manifest, MemoryAuditLog, NativeBroker, SecretBinding,
    SystemClock, TlsPolicy,
};
use security_types::{
    Authorizer, AuthzRequest, Decision, Digest, Principal, PrincipalKind, RoleId, SessionId,
    TenantId,
};

const TARGET: &str = "pg";
const CREDENTIAL: &str = "cred-1";
const PLUGIN_ID: &str = "com.byterygon.dbee.postgres";
const PLUGIN_DIGEST: Digest = Digest([0x5a; 32]);
/// The table the benchmark reads.
pub const TABLE: &str = "bench_rows";

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

pub type Result<T> = std::result::Result<T, String>;

/// Which PostgreSQL server to use.
#[derive(Clone, Debug)]
pub enum Server {
    /// Start a throwaway cluster from `initdb` and `postgres` (needs a non-root user).
    Managed,
    /// A server that already runs on 127.0.0.1.
    External {
        port: u16,
        user: String,
        database: String,
        password: Option<String>,
    },
}

/// A running PostgreSQL server the benchmark can read from.
pub struct Cluster {
    port: u16,
    user: String,
    database: String,
    password: Option<String>,
    /// Killed on drop, so the postmaster does not outlive the benchmark.
    process: Option<Child>,
    data_dir: Option<PathBuf>,
}

impl Cluster {
    pub async fn start(server: Server) -> Result<Cluster> {
        match server {
            Server::External {
                port,
                user,
                database,
                password,
            } => Ok(Cluster {
                port,
                user,
                database,
                password,
                process: None,
                data_dir: None,
            }),
            Server::Managed => start_managed().await,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Stops a managed server and deletes its files.
    pub async fn stop(mut self) {
        self.shutdown();
    }

    fn shutdown(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        if let Some(dir) = self.data_dir.take() {
            let _ = std::fs::remove_dir_all(&dir);
            let _ = std::fs::remove_file(dir.with_extension("log"));
        }
    }
}

impl Drop for Cluster {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Directories to look for `initdb` and `postgres` in, in order.
fn candidate_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = std::env::var_os("BYTERYGON_PG_BIN") {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    // Versioned installs: Debian/Ubuntu, Homebrew, the Windows installer.
    for base in [
        "/usr/lib/postgresql",
        "/opt/homebrew/opt",
        "/usr/local/opt",
        "C:\\Program Files\\PostgreSQL",
    ] {
        let Ok(entries) = std::fs::read_dir(base) else {
            continue;
        };
        let mut found: Vec<PathBuf> = entries
            .filter_map(|e| e.ok())
            .map(|e| e.path().join("bin"))
            .collect();
        found.sort();
        found.reverse();
        dirs.extend(found);
    }
    dirs
}

fn bin_dir() -> Option<PathBuf> {
    let exe = |name: &str| format!("{name}{}", std::env::consts::EXE_SUFFIX);
    candidate_bin_dirs()
        .into_iter()
        .find(|d| d.join(exe("initdb")).is_file() && d.join(exe("postgres")).is_file())
}

async fn start_managed() -> Result<Cluster> {
    let bin = bin_dir().ok_or(
        "no initdb/postgres binaries found: install PostgreSQL, set BYTERYGON_PG_BIN to its bin \
         directory, or pass --pg-port to use a server that already runs",
    )?;
    let exe = |name: &str| bin.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    let data = std::env::temp_dir().join(format!("byterygon-bench-{}-{nanos}", std::process::id()));
    let initdb = Command::new(exe("initdb"))
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
        .map_err(|e| format!("initdb: {e}"))?;
    if !initdb.status.success() {
        return Err(format!(
            "initdb failed (it refuses to run as root; as root start your own server and pass \
             --pg-port): {}",
            String::from_utf8_lossy(&initdb.stderr)
        ));
    }
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map_err(|e| format!("free port: {e}"))?
        .port();
    // Loopback only; no durability, which a throwaway benchmark table does not need.
    let mut conf = std::fs::read_to_string(data.join("postgresql.conf"))
        .map_err(|e| format!("postgresql.conf: {e}"))?;
    if cfg!(unix) {
        // No socket file: nothing but loopback TCP, and no directory to create or clean up.
        conf.push_str("\nunix_socket_directories = ''\n");
    }
    conf.push_str(&format!(
        "\nlisten_addresses = '127.0.0.1'\nport = {port}\nfsync = off\nsynchronous_commit = off\n\
         full_page_writes = off\nmax_connections = 20\n"
    ));
    std::fs::write(data.join("postgresql.conf"), conf).map_err(|e| e.to_string())?;
    std::fs::write(
        data.join("pg_hba.conf"),
        "host all all 127.0.0.1/32 trust\n",
    )
    .map_err(|e| e.to_string())?;
    let log = std::fs::File::create(data.with_extension("log")).map_err(|e| e.to_string())?;
    let process = Command::new(exe("postgres"))
        .arg("-D")
        .arg(&data)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| format!("postgres: {e}"))?;
    Ok(Cluster {
        port,
        user: "postgres".into(),
        database: "postgres".into(),
        password: None,
        process: Some(process),
        data_dir: Some(data),
    })
}

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

struct Settings(Mutex<PgSettings>);

impl SettingsSource for Settings {
    fn settings<'a>(
        &'a self,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, PgSettings> {
        Box::pin(async move {
            if target_id == TARGET && credential_ref == Some(CREDENTIAL) {
                Ok(self.0.lock().unwrap().clone())
            } else {
                Err(DbError::PermissionDenied)
            }
        })
    }
}

/// Connections to the cluster through the Plugin Host broker, as a product opens them.
pub struct Db {
    broker: Arc<dyn ConnectionBroker>,
    cluster_settings: PgSettings,
}

impl Db {
    /// Grants the driver plugin access to the cluster's loopback address and builds the broker.
    pub async fn new(cluster: &Cluster) -> Result<Db> {
        let audit = Arc::new(MemoryAuditLog::new());
        let grants = Arc::new(GrantStore::new(
            Arc::new(SystemClock),
            audit as Arc<dyn AuditSink>,
        ));
        let broker = NativeBroker::new(
            grants.clone(),
            plugin_host::SystemResolver,
            BrokerConfig::default(),
        );
        let plugin = InstalledPlugin {
            id: PLUGIN_ID.into(),
            digest: PLUGIN_DIGEST,
            driver_kind: DriverKind::Native,
            capabilities: Manifest::from_toml(MANIFEST)
                .map_err(|e| format!("manifest: {e:?}"))?
                .capabilities,
        };
        let request = GrantRequest {
            tenant: TenantId::new("t1"),
            owner: "human:bench:runner".into(),
            eligible: Eligibility {
                principals: BTreeSet::new(),
                roles: [RoleId::new("bench")].into_iter().collect(),
            },
            connection_id: "bench:pg".into(),
            target_id: TARGET.into(),
            template_id: "db".into(),
            host: "127.0.0.1".into(),
            port: cluster.port,
            tls: TlsPolicy::Disabled,
            addresses: address_policy(&["127.0.0.1/32"]).map_err(|e| format!("{e:?}"))?,
            secret: Some(SecretBinding {
                template_id: "db-credentials".into(),
                secret_ref: CREDENTIAL.into(),
            }),
            allow_cancel_connection: true,
            expires_at_unix_ms: None,
        };
        let admin = principal(PrincipalKind::Human, "human:bench:admin", &["admin"]);
        grants
            .create(&AllowAll, &admin, &plugin, request, "bench-grant")
            .await
            .map_err(|e| format!("grant: {e:?}"))?;
        let caller = principal(PrincipalKind::Human, "human:bench:runner", &["bench"]);
        let broker: Arc<dyn ConnectionBroker> =
            Arc::new(ContractBroker::new(broker.scope(Caller {
                plugin_id: PLUGIN_ID.into(),
                plugin_digest: PLUGIN_DIGEST,
                driver_kind: DriverKind::Native,
                principal: caller,
                correlation_id: "bench".into(),
            })));
        Ok(Db {
            broker,
            cluster_settings: PgSettings {
                user: cluster.user.clone(),
                database: cluster.database.clone(),
                password: cluster.password.as_deref().map(Password::new),
                tls: PgTls::Disabled,
                access: AccessMode::ReadWrite,
                application_name: "ambidex-bench".into(),
                connect_timeout: Duration::from_secs(30),
            },
        })
    }

    pub async fn connect(
        &self,
        access: AccessMode,
    ) -> std::result::Result<Box<dyn Connection>, DbError> {
        let settings = PgSettings {
            access,
            ..self.cluster_settings.clone()
        };
        let driver = PostgresDriver::new(
            self.broker.clone(),
            Arc::new(Settings(Mutex::new(settings))),
        );
        driver
            .connect(&*self.broker, TARGET, Some(CREDENTIAL))
            .await
    }

    /// Runs one statement and discards its chunks.
    async fn run(&self, conn: &dyn Connection, id: &str, sql: &str) -> Result<()> {
        let mut stream = conn
            .execute(&OperationId(id.into()), sql, ExecuteOptions::default())
            .await
            .map_err(|e| format!("{sql}: {e}"))?;
        loop {
            match stream.next().await.map_err(|e| format!("{sql}: {e}"))? {
                Some(NextItem::Chunk(_)) => {}
                Some(NextItem::Finished(_)) | None => return Ok(()),
            }
        }
    }

    /// Waits for the server to accept connections, then (re)creates the benchmark table with
    /// `rows` rows. Returns how long the generation took.
    pub async fn load(&self, rows: u64) -> Result<Duration> {
        let deadline = Instant::now() + Duration::from_secs(60);
        let conn = loop {
            match self.connect(AccessMode::ReadWrite).await {
                Ok(conn) => break conn,
                Err(e) if Instant::now() > deadline => {
                    return Err(format!("server not ready: {e}"));
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };
        let start = Instant::now();
        for (i, sql) in load_statements(rows).iter().enumerate() {
            self.run(&*conn, &format!("load-{i}"), sql).await?;
        }
        Ok(start.elapsed())
    }
}

/// Ten mixed columns, every value a function of the row number `n` (0-based), so the result is
/// reproducible and the client can check it: an int8 id, nullable int4, int2, float8, float4,
/// short and long text (one nullable), timestamptz, date and a nullable bool.
pub fn load_statements(rows: u64) -> Vec<String> {
    vec![
        format!("DROP TABLE IF EXISTS {TABLE}"),
        format!(
            "CREATE TABLE {TABLE} AS SELECT
                n::int8 AS id,
                CASE WHEN n % 10 = 3 THEN NULL ELSE (n % 100000)::int4 END AS qty,
                (n % 32000)::int2 AS level,
                n * 0.37::float8 AS score,
                (n % 1000)::float4 / 8 AS ratio,
                'user-' || (n % 5000) AS name,
                CASE WHEN n % 5 = 0 THEN NULL ELSE md5(n::text) || md5((n + 1)::text) END AS note,
                TIMESTAMPTZ '2020-01-01 00:00:00+00' + n * INTERVAL '37 seconds' AS created,
                DATE '2000-01-01' + (n % 10000)::int AS day,
                CASE WHEN n % 20 = 7 THEN NULL ELSE n % 3 = 0 END AS flag
             FROM generate_series(0, {} ) AS n",
            rows.saturating_sub(1)
        ),
        format!("ANALYZE {TABLE}"),
        // A big table is read with a synchronized scan, which starts wherever the last scan
        // stopped; the client checks that the ids run from 0, so scans must start at the
        // first page. A per-session SET would be rolled back with the read-only transaction the
        // driver wraps around each statement, hence the database default.
        "DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET synchronize_seqscans = off', \
         current_database()); END $$"
            .to_owned(),
    ]
}
