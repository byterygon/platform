//! The server's certificate (Mightyconsole spec §2.3, "Certificate").
//!
//! `--tls-cert` and `--tls-key` name PEM files to use as they are. Without them the server uses
//! `<data>/tls/cert.pem` and `key.pem`, making them on first start: a self-signed ECDSA P-256
//! certificate for `localhost`, `127.0.0.1` and `::1`, valid 825 days, the key written with mode
//! 0600 on Unix. Later starts reuse the files. The startup line prints the certificate's SHA-256
//! fingerprint so the user can compare it with what the browser shows.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls_pki_types::pem::PemObject as _;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};
use sha2::{Digest as _, Sha256};

/// Names the generated certificate is valid for.
pub const GENERATED_NAMES: [&str; 3] = ["localhost", "127.0.0.1", "::1"];

/// Validity of the generated certificate: the longest browsers accept for a server certificate.
pub const GENERATED_VALIDITY_DAYS: i64 = 825;

/// Where the certificate comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsSource {
    /// PEM files the user gave.
    Files { cert: PathBuf, key: PathBuf },
    /// `cert.pem` and `key.pem` in this directory, made on first use.
    Generated { dir: PathBuf },
}

/// A certificate that could not be loaded or made.
#[derive(Debug)]
pub enum TlsError {
    Pem { path: PathBuf, detail: String },
    Io { path: PathBuf, error: io::Error },
    Generate(String),
    Config(rustls::Error),
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TlsError::Pem { path, detail } => write!(f, "{}: {detail}", path.display()),
            TlsError::Io { path, error } => write!(f, "{}: {error}", path.display()),
            TlsError::Generate(e) => write!(f, "cannot make the certificate: {e}"),
            TlsError::Config(e) => write!(f, "TLS configuration: {e}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// The loaded certificate.
pub struct ServerTls {
    pub config: Arc<rustls::ServerConfig>,
    /// SHA-256 of the leaf certificate, uppercase hex pairs joined by `:`.
    pub fingerprint: String,
    pub cert_path: PathBuf,
    /// `true` when this start made the certificate.
    pub generated_now: bool,
}

impl std::fmt::Debug for ServerTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerTls")
            .field("fingerprint", &self.fingerprint)
            .field("cert_path", &self.cert_path)
            .field("generated_now", &self.generated_now)
            .finish_non_exhaustive()
    }
}

pub fn load(source: &TlsSource) -> Result<ServerTls, TlsError> {
    let (cert, key, generated_now) = match source {
        TlsSource::Files { cert, key } => (cert.clone(), key.clone(), false),
        TlsSource::Generated { dir } => {
            let cert = dir.join("cert.pem");
            let key = dir.join("key.pem");
            let made = if cert.is_file() && key.is_file() {
                false
            } else {
                generate(dir, &cert, &key)?;
                true
            };
            (cert, key, made)
        }
    };
    let chain = certificates(&cert)?;
    let fingerprint = fingerprint(&chain[0]);
    let private = PrivateKeyDer::from_pem_file(&key).map_err(|e| TlsError::Pem {
        path: key.clone(),
        detail: e.to_string(),
    })?;
    let config = ambidex_axum::tls_server_config(chain, private).map_err(TlsError::Config)?;
    Ok(ServerTls {
        config,
        fingerprint,
        cert_path: cert,
        generated_now,
    })
}

/// SHA-256 of a DER certificate as `AB:CD:…`.
pub fn fingerprint(der: &[u8]) -> String {
    Sha256::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

fn certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>, TlsError> {
    let pem = |detail: String| TlsError::Pem {
        path: path.to_path_buf(),
        detail,
    };
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(path)
        .map_err(|e| pem(e.to_string()))?
        .collect::<Result<_, _>>()
        .map_err(|e| pem(e.to_string()))?;
    if certs.is_empty() {
        return Err(pem("no CERTIFICATE block".into()));
    }
    Ok(certs)
}

fn generate(dir: &Path, cert_path: &Path, key_path: &Path) -> Result<(), TlsError> {
    let io = |path: &Path| {
        let path = path.to_path_buf();
        move |error| TlsError::Io { path, error }
    };
    std::fs::create_dir_all(dir).map_err(io(dir))?;
    let generate = |e: rcgen::Error| TlsError::Generate(e.to_string());
    let names: Vec<String> = GENERATED_NAMES.iter().map(|n| (*n).to_owned()).collect();
    let mut params = rcgen::CertificateParams::new(names).map_err(generate)?;
    let mut dn = rcgen::DistinguishedName::new();
    dn.push(rcgen::DnType::CommonName, "Mightyconsole (localhost)");
    params.distinguished_name = dn;
    let now = time::OffsetDateTime::now_utc();
    params.not_before = now - time::Duration::days(1);
    params.not_after = now + time::Duration::days(GENERATED_VALIDITY_DAYS - 1);
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).map_err(generate)?;
    let cert = params.self_signed(&key).map_err(generate)?;
    write_private(key_path, key.serialize_pem().as_bytes()).map_err(io(key_path))?;
    std::fs::write(cert_path, cert.pem()).map_err(io(cert_path))?;
    Ok(())
}

#[cfg(unix)]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)
}

#[cfg(not(unix))]
fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_certificate_is_made_once_and_reused() {
        let dir = tempfile::tempdir().unwrap();
        let source = TlsSource::Generated {
            dir: dir.path().join("tls"),
        };
        let first = load(&source).unwrap();
        assert!(first.generated_now);
        assert_eq!(first.fingerprint.len(), 32 * 3 - 1);
        let second = load(&source).unwrap();
        assert!(!second.generated_now);
        assert_eq!(first.fingerprint, second.fingerprint);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.path().join("tls/key.pem"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        // The user's own files are used as they are.
        let files = TlsSource::Files {
            cert: dir.path().join("tls/cert.pem"),
            key: dir.path().join("tls/key.pem"),
        };
        assert_eq!(load(&files).unwrap().fingerprint, first.fingerprint);
        let missing = TlsSource::Files {
            cert: dir.path().join("nope.pem"),
            key: dir.path().join("tls/key.pem"),
        };
        assert!(matches!(load(&missing), Err(TlsError::Pem { .. })));
    }
}
