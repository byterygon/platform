//! A throwaway PostgreSQL cluster started from `initdb`/`postgres` (found on `PATH`, in
//! `BYTERYGON_PG_BIN` or under `/usr/lib/postgresql/*/bin`), with TLS from a test CA, trust
//! authentication for `postgres` on loopback and SCRAM for everyone else. It needs a non-root
//! user; otherwise [`cluster`] answers `None`, unless `BYTERYGON_REQUIRE_POSTGRES` is set (CI),
//! which makes it panic instead.
//!
//! Shared by `dbee-core`'s tests (`mod support;`) and `dbee-server`'s end-to-end test (by path).

#![allow(dead_code)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use sha2::Digest as _;

/// Name in the server certificate.
pub const SERVER_NAME: &str = "db.test";

pub struct Cluster {
    pub port: u16,
    pub ca_pem: String,
    /// `sha256:<hex>` of the server certificate's DER.
    pub server_fingerprint: String,
}

/// The cluster of this test process, started on first use; `None` when it cannot start.
pub fn cluster() -> Option<&'static Cluster> {
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
