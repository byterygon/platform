//! TLS material from PEM files: the server's certificate chain and key, and the deployment CA
//! roots for database grants. Nothing is loaded that was not named in the configuration.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls::RootCertStore;
use rustls_pki_types::pem::PemObject as _;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

/// A PEM file that could not be used.
#[derive(Debug)]
pub enum TlsError {
    /// The file cannot be read or holds no object of the expected kind.
    Pem { path: PathBuf, detail: String },
    /// The certificate chain and key do not form a usable server configuration.
    Config(rustls::Error),
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TlsError::Pem { path, detail } => write!(f, "{}: {detail}", path.display()),
            TlsError::Config(e) => write!(f, "TLS configuration: {e}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// Every `CERTIFICATE` block of the file, in order.
fn certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>, TlsError> {
    let pem = |detail: String| TlsError::Pem {
        path: path.to_path_buf(),
        detail,
    };
    let iter = CertificateDer::pem_file_iter(path).map_err(|e| pem(e.to_string()))?;
    let certs: Vec<CertificateDer<'static>> = iter
        .collect::<Result<_, _>>()
        .map_err(|e| pem(e.to_string()))?;
    if certs.is_empty() {
        return Err(pem("no CERTIFICATE block".into()));
    }
    Ok(certs)
}

/// The rustls server configuration for the certificate chain in `cert` and the key in `key`.
pub fn server_config(cert: &Path, key: &Path) -> Result<Arc<rustls::ServerConfig>, TlsError> {
    let chain = certificates(cert)?;
    let key = PrivateKeyDer::from_pem_file(key).map_err(|e| TlsError::Pem {
        path: key.to_path_buf(),
        detail: e.to_string(),
    })?;
    ambidex_axum::tls_server_config(chain, key).map_err(TlsError::Config)
}

/// The CA certificates of every file in `paths`; empty when there are none.
pub fn root_store(paths: &[PathBuf]) -> Result<RootCertStore, TlsError> {
    let mut roots = RootCertStore::empty();
    for path in paths {
        for cert in certificates(path)? {
            roots.add(cert).map_err(|e| TlsError::Pem {
                path: path.clone(),
                detail: format!("not a CA certificate: {e}"),
            })?;
        }
    }
    Ok(roots)
}
