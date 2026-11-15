//! The core against a real PostgreSQL through the first-party driver and the Plugin Host broker
//! (DBee spec §14: approve, connect, run a query whose rows arrive as Arrow, cancel, export,
//! pinned CA and pinned certificate against a self-signed test server).
//!
//! A throwaway cluster is started from `initdb`/`postgres` (found on `PATH`, in
//! `BYTERYGON_PG_BIN` or under `/usr/lib/postgresql/*/bin`) as the driver's own tests do. It
//! needs a non-root user; otherwise the tests skip, unless `BYTERYGON_REQUIRE_POSTGRES` is set
//! (CI).

mod support;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use ambidex::Code;
use dbee_core::driver::{Resolve, SystemResolve};
use dbee_core::export::IpcDecoder;
use dbee_core::secrets::{MemorySecretStore, SecretStore};
use dbee_core::{AppMode, Core, CoreConfig, SecretStoreConfig};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use serde_json::{Value, json};
use sha2::Digest as _;
use std::sync::Arc;
use support::{PASSWORD, kind};

const SERVER_NAME: &str = "db.test";

struct Cluster {
    port: u16,
    ca_pem: String,
    /// `sha256:<hex>` of the server certificate's DER.
    server_fingerprint: String,
}

fn cluster() -> Option<&'static Cluster> {
    static CLUSTER: OnceLock<Option<Cluster>> = OnceLock::new();
    CLUSTER
        .get_or_init(|| match start_cluster() {
            Ok(c) => Some(c),
            Err(why) if std::env::var_os("BYTERYGON_REQUIRE_POSTGRES").is_some() => {
                panic!("PostgreSQL is required but unavailable: {why}")
            }
            Err(why) => {
                eprintln!("skipping PostgreSQL core tests: {why}");
                None
            }
        })
        .as_ref()
}

macro_rules! require_cluster {
    () => {
        match cluster() {
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
    let data = std::env::temp_dir().join(format!("dbee-core-pg-{}-{nanos}", std::process::id()));
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
        .push(DnType::CommonName, "DBee test CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let ca_pem = ca.pem();
    let issuer = Issuer::new(ca_params, ca_key);
    let key = KeyPair::generate().unwrap();
    let cert = CertificateParams::new(vec![SERVER_NAME.to_owned()])
        .unwrap()
        .signed_by(&key, &issuer)
        .unwrap();
    let digest: [u8; 32] = sha2::Sha256::digest(cert.der()).into();
    let server_fingerprint = format!("sha256:{}", security_types::Digest(digest));
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
         fsync = off\nsynchronous_commit = off\nfull_page_writes = off\nmax_connections = 100\n"
    );
    let mut existing = std::fs::read_to_string(data.join("postgresql.conf")).unwrap();
    existing.push_str(&conf);
    std::fs::write(data.join("postgresql.conf"), existing).unwrap();
    std::fs::write(
        data.join("pg_hba.conf"),
        "host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 scram-sha-256\n",
    )
    .unwrap();

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

    // Wait for the server to accept connections.
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        if Instant::now() > deadline {
            return Err("server not ready".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(Cluster {
        port,
        ca_pem,
        server_fingerprint,
    })
}

/// A core with the real driver, an in-memory keychain and the OS resolver.
async fn core(dir: &Path) -> (Core, Arc<MemorySecretStore>) {
    let keychain = Arc::new(MemorySecretStore::new());
    let mut config = CoreConfig::new(dir, AppMode::Standalone);
    config.secret_store = SecretStoreConfig::Store(Arc::clone(&keychain) as Arc<dyn SecretStore>);
    config.resolver = Arc::new(SystemResolve) as Arc<dyn Resolve>;
    (Core::start(config).await.unwrap(), keychain)
}

async fn call(core: &Core, procedure: &str, input: Value) -> Result<Value, ambidex::ErrorPayload> {
    let session = Arc::new(ambidex::Session {
        id: "pg-test".into(),
        principal: support::tester(),
    });
    core.router()
        .call(session, ambidex::Call::new(procedure, input))
        .await
}

fn draft(name: &str, port: u16, user: &str, tls: Value, has_secret: bool) -> Value {
    json!({
        "name": name,
        "host": "127.0.0.1",
        "port": port,
        "database": "postgres",
        "user": user,
        "tls": tls,
        "hasSecret": has_secret,
    })
}

/// Prepares and approves `draft`; a password when `secret` is given.
async fn approve(
    core: &Core,
    draft: Value,
    secret: Option<&str>,
) -> Result<Value, ambidex::ErrorPayload> {
    let preview = call(core, "connections.prepare", draft.clone()).await?;
    let mut input = json!({ "draft": draft, "previewDigest": preview["previewDigest"] });
    if let Some(password) = secret {
        input["secret"] = json!({ "password": password });
    }
    call(core, "connections.create", input).await
}

async fn open(core: &Core, connection_id: &str) -> Result<Value, ambidex::ErrorPayload> {
    call(
        core,
        "sessions.open",
        json!({ "connectionId": connection_id, "purpose": "editor" }),
    )
    .await
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn approve_connect_query_cancel_and_export() {
    let cluster = require_cluster!();
    let dir = tempfile::tempdir().unwrap();
    let (core, _keychain) = core(dir.path()).await;

    // Plaintext to the superuser (trust auth: no password).
    let summary = approve(
        &core,
        draft(
            "Plain",
            cluster.port,
            "postgres",
            json!({ "kind": "plaintext" }),
            false,
        ),
        None,
    )
    .await
    .unwrap();
    let id = summary["id"].as_str().unwrap().to_owned();
    let opened = open(&core, &id).await.unwrap();
    let session = opened["sessionId"].as_str().unwrap().to_owned();
    assert!(
        opened["serverVersion"]
            .as_str()
            .unwrap()
            .chars()
            .next()
            .unwrap()
            .is_ascii_digit(),
        "{opened}"
    );
    let schemas = call(&core, "schema.schemas", json!({ "connectionId": id }))
        .await
        .unwrap();
    assert!(schemas.as_array().unwrap().iter().any(|s| s == "public"));

    // Rows arrive as Arrow IPC over the engine and decode.
    let t = support::TestCore::connect_to(&core).await;
    let mut client = t;
    client
        .call(
            1,
            "query.execute",
            json!({ "sessionId": session, "sql": "select g::int8 as id, 'row ' || g as name from generate_series(1, 5) g" }),
        )
        .await;
    let mut decoder = IpcDecoder::new();
    let mut rows = 0;
    loop {
        let frame = client.recv().await.expect("frame");
        match frame.kind {
            ambidex::Kind::Chunk => {
                for batch in decoder.push(&frame.payload).unwrap() {
                    rows += batch.num_rows();
                }
            }
            ambidex::Kind::StreamEnd => {
                let summary: Value = serde_json::from_slice(&frame.payload).unwrap();
                assert_eq!(summary["rowsReturned"], 5);
                assert_eq!(summary["statementKind"], "SELECT");
                break;
            }
            other => panic!(
                "unexpected {other:?}: {}",
                String::from_utf8_lossy(&frame.payload)
            ),
        }
    }
    assert_eq!(rows, 5);
    assert_eq!(decoder.schema().unwrap().fields().len(), 2);

    // Export re-runs the statement and encodes in the core.
    client
        .call(
            2,
            "export.run",
            json!({
                "sessionId": session,
                "sql": "select g as id from generate_series(1, 3) g",
                "format": "csv",
                "destination": { "kind": "client" },
            }),
        )
        .await;
    let chunk = client.expect_chunk(2).await;
    assert_eq!(String::from_utf8(chunk).unwrap(), "id\n1\n2\n3\n");
    let summary = client.expect_stream_end(2).await;
    assert_eq!(summary["rows"], 3);

    // Cancel reaches the database through a cancel connection under the same grant: the
    // statement ends with Cancelled well before pg_sleep would.
    let started = Instant::now();
    client
        .call(
            3,
            "query.execute",
            json!({ "sessionId": session, "sql": "select pg_sleep(30)" }),
        )
        .await;
    client.expect_chunk(3).await; // the schema
    client.cancel(3).await;
    client.expect_code(3, Code::Cancelled).await;
    assert!(started.elapsed() < Duration::from_secs(20));
    // The session is usable again once the backend dropped the statement.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        client
            .call(
                4,
                "query.execute",
                json!({ "sessionId": session, "sql": "select 1" }),
            )
            .await;
        let frame = client.recv().await.unwrap();
        if frame.kind == ambidex::Kind::Chunk {
            loop {
                let f = client.recv().await.unwrap();
                if f.kind == ambidex::Kind::StreamEnd {
                    break;
                }
            }
            break;
        }
        assert!(Instant::now() < deadline, "session did not recover");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }

    // The error of a wrong statement carries SQLSTATE and position.
    client
        .call(
            5,
            "query.execute",
            json!({ "sessionId": session, "sql": "selec 1" }),
        )
        .await;
    let err = client.expect_code(5, Code::InvalidArgument).await;
    assert_eq!(kind(&err), "Syntax");
    assert_eq!(err.details.as_ref().unwrap()["sqlstate"], "42601");
    assert_eq!(err.details.as_ref().unwrap()["position"], 1);

    // Audit: broker opens under the sessions.open call, no SQL text anywhere.
    let records = dbee_core::audit::read_records(&dir.path().join("audit/log.jsonl")).unwrap();
    let text = std::fs::read_to_string(dir.path().join("audit/log.jsonl")).unwrap();
    assert!(!text.contains("generate_series"));
    assert!(!text.contains("pg_sleep"));
    let open_entry = records
        .iter()
        .find(|r| r.entry.action.name == "plugin-host.broker.open")
        .expect("broker open entry");
    assert!(open_entry.entry.parent_correlation_id.is_some());
    assert!(
        records
            .iter()
            .any(|r| r.entry.action.name == "plugin-host.broker.open-cancel")
    );
    let _ = core.state().manager.secrets().session.has(&id);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passwords_and_tls_policies() {
    let cluster = require_cluster!();
    let dir = tempfile::tempdir().unwrap();
    let (core, keychain) = core(dir.path()).await;

    // A role with a password, created through a plaintext superuser connection.
    let admin = approve(
        &core,
        draft(
            "Admin",
            cluster.port,
            "postgres",
            json!({ "kind": "plaintext" }),
            false,
        ),
        None,
    )
    .await
    .unwrap();
    let admin_id = admin["id"].as_str().unwrap().to_owned();
    let session = open(&core, &admin_id).await.unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut client = support::TestCore::connect_to(&core).await;
    client
        .call(
            1,
            "query.execute",
            json!({ "sessionId": session, "sql": format!("create role app login password '{PASSWORD}'") }),
        )
        .await;
    loop {
        let frame = client.recv().await.unwrap();
        if frame.kind == ambidex::Kind::StreamEnd {
            break;
        }
        assert_eq!(
            frame.kind,
            ambidex::Kind::Chunk,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
    }

    // Pinned CA: the password is released only to this connection, from the keychain.
    let tls_ca = json!({ "kind": "pinned-ca", "caPem": cluster.ca_pem, "serverName": SERVER_NAME });
    let pinned = approve(
        &core,
        draft("Pinned CA", cluster.port, "app", tls_ca.clone(), true),
        Some(PASSWORD),
    )
    .await
    .unwrap();
    assert_eq!(pinned["tls"], "pinned-ca");
    assert_eq!(keychain.len(), 1);
    let pinned_id = pinned["id"].as_str().unwrap().to_owned();
    open(&core, &pinned_id).await.unwrap();

    // Pinned certificate: exactly the server's certificate.
    let tls_cert = json!({ "kind": "pinned-cert", "fingerprint": cluster.server_fingerprint, "serverName": SERVER_NAME });
    let cert = approve(
        &core,
        draft("Pinned cert", cluster.port, "app", tls_cert, true),
        Some(PASSWORD),
    )
    .await
    .unwrap();
    open(&core, cert["id"].as_str().unwrap()).await.unwrap();

    // The wrong pin fails TLS; nothing falls back to plaintext.
    let wrong =
        json!({ "kind": "pinned-cert", "fingerprint": "ab".repeat(32), "serverName": SERVER_NAME });
    let bad = approve(
        &core,
        draft("Wrong pin", cluster.port, "app", wrong, true),
        Some(PASSWORD),
    )
    .await
    .unwrap();
    let err = open(&core, bad["id"].as_str().unwrap()).await.unwrap_err();
    assert_eq!(
        (err.code, kind(&err).as_str()),
        (Code::FailedPrecondition, "TlsFailed")
    );

    // Deployment CAs: none are configured, so the handshake fails closed.
    let deployment = json!({ "kind": "deployment-ca", "serverName": SERVER_NAME });
    let dep = approve(
        &core,
        draft("Deployment", cluster.port, "app", deployment, true),
        Some(PASSWORD),
    )
    .await
    .unwrap();
    let err = open(&core, dep["id"].as_str().unwrap()).await.unwrap_err();
    assert_eq!(kind(&err), "TlsFailed");

    // A wrong password is AuthenticationFailed; no password at all asks for one.
    let other = approve(
        &core,
        draft("Wrong pw", cluster.port, "app", tls_ca.clone(), true),
        Some("nope"),
    )
    .await
    .unwrap();
    let err = open(&core, other["id"].as_str().unwrap())
        .await
        .unwrap_err();
    assert_eq!(kind(&err), "AuthenticationFailed");
    let none = approve(
        &core,
        draft("No pw", cluster.port, "app", tls_ca, false),
        None,
    )
    .await
    .unwrap();
    let err = open(&core, none["id"].as_str().unwrap()).await.unwrap_err();
    assert_eq!(kind(&err), "SecretMissing");
    call(
        &core,
        "connections.setSecret",
        json!({ "id": none["id"], "password": PASSWORD }),
    )
    .await
    .unwrap();
    open(&core, none["id"].as_str().unwrap()).await.unwrap();

    // The password is nowhere but the keychain.
    let mut all = String::new();
    for entry in std::fs::read_dir(dir.path()).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() {
            all.push_str(&std::fs::read_to_string(&path).unwrap());
        }
    }
    all.push_str(&std::fs::read_to_string(dir.path().join("audit/log.jsonl")).unwrap());
    assert!(!all.contains(PASSWORD));
    let _ = core.state().manager.driver();
    let _ = Ordering::SeqCst;
}
