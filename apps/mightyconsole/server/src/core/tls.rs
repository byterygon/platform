//! TLS to the systems a tool talks to (Mightyconsole spec §4.2, `TlsOptions`; Open question 6).
//!
//! Always verified: the operating system's trust store, or only the CA the profile pins. A
//! profile may name the certificate's expected name (`serverName`) when it differs from the
//! address, and give a client certificate. There is no "skip verification".
//!
//! rustls with the `ring` provider, as the server's own listener, so no C toolchain is needed.

use std::fmt;
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::pem::PemObject as _;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use schemars::JsonSchema;
use serde::Deserialize;
use ts_rs::TS;

/// TLS settings of a profile, as `toConnect` sends them (spec §4.2). `clientKeyPem` comes from
/// the profile's `secrets`; procedures that take it list it in `redact`.
#[derive(Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TlsOptions {
    /// Use TLS. Tools whose address says it (`https://`) use TLS either way.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub enabled: Option<bool>,
    /// PEM certificates of the CA to trust instead of the system's trust store.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ca_pem: Option<String>,
    /// PEM client certificate (chain) for mutual TLS.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub client_cert_pem: Option<String>,
    /// PEM private key of the client certificate. A secret.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub client_key_pem: Option<String>,
    /// The name the server's certificate must carry, when it is not the address's host.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub server_name: Option<String>,
}

impl fmt::Debug for TlsOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TlsOptions")
            .field("enabled", &self.enabled)
            .field("ca_pem", &self.ca_pem.as_ref().map(|_| "…"))
            .field(
                "client_cert_pem",
                &self.client_cert_pem.as_ref().map(|_| "…"),
            )
            .field(
                "client_key_pem",
                &self.client_key_pem.as_ref().map(|_| "<redacted>"),
            )
            .field("server_name", &self.server_name)
            .finish()
    }
}

/// Why the options cannot be used, naming the profile field (`tls.caPem`, ...).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsOptionsError {
    pub field: &'static str,
    pub message: String,
}

impl TlsOptionsError {
    fn new(field: &'static str, message: impl Into<String>) -> TlsOptionsError {
        TlsOptionsError {
            field,
            message: message.into(),
        }
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

fn certificates(
    pem: &str,
    field: &'static str,
) -> Result<Vec<CertificateDer<'static>>, TlsOptionsError> {
    let certs = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| TlsOptionsError::new(field, format!("not a PEM certificate: {e}")))?;
    if certs.is_empty() {
        return Err(TlsOptionsError::new(field, "no PEM certificate found"));
    }
    Ok(certs)
}

/// A rustls client configuration for `options`: verified against the pinned CA or the system's
/// trust store, with the client certificate when one is given.
pub fn client_config(options: &TlsOptions) -> Result<ClientConfig, TlsOptionsError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = RootCertStore::empty();
    let roots_field = match non_empty(&options.ca_pem) {
        Some(pem) => {
            for cert in certificates(pem, "tls.caPem")? {
                roots
                    .add(cert)
                    .map_err(|e| TlsOptionsError::new("tls.caPem", format!("unusable CA: {e}")))?;
            }
            "tls.caPem"
        }
        None => {
            // The operating system's trust store, read from disk (or the keychain, or the
            // Windows store); certificates it cannot parse are skipped.
            let native = rustls_native_certs::load_native_certs();
            roots.add_parsable_certificates(native.certs);
            if roots.is_empty() {
                return Err(TlsOptionsError::new(
                    "tls.caPem",
                    "this system has no trusted CA certificates; pin the server's CA",
                ));
            }
            "tls"
        }
    };
    let mut verifier: Arc<dyn ServerCertVerifier> =
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), Arc::clone(&provider))
            .build()
            .map_err(|e| TlsOptionsError::new(roots_field, format!("unusable CA: {e}")))?;
    if let Some(name) = non_empty(&options.server_name) {
        let name = ServerName::try_from(name.to_owned())
            .map_err(|_| TlsOptionsError::new("tls.serverName", "not a host name or address"))?;
        verifier = Arc::new(ExpectedName {
            inner: verifier,
            name,
        });
    }
    let builder = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| TlsOptionsError::new("tls", e.to_string()))?
        .dangerous()
        // A verifier that verifies: the pinned CA or the system's, with the expected name.
        .with_custom_certificate_verifier(verifier);
    match (
        non_empty(&options.client_cert_pem),
        non_empty(&options.client_key_pem),
    ) {
        (None, None) => Ok(builder.with_no_client_auth()),
        (Some(_), None) => Err(TlsOptionsError::new(
            "tls.clientKeyPem",
            "the client certificate needs its private key",
        )),
        (None, Some(_)) => Err(TlsOptionsError::new(
            "tls.clientCertPem",
            "the private key needs its client certificate",
        )),
        (Some(cert), Some(key)) => {
            let chain = certificates(cert, "tls.clientCertPem")?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|_| TlsOptionsError::new("tls.clientKeyPem", "not a PEM private key"))?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|e| TlsOptionsError::new("tls.clientKeyPem", e.to_string()))
        }
    }
}

/// A configuration for clients that only speak plain HTTP but need one (an `https` URL would
/// fail: nothing is trusted).
pub fn plain_config() -> ClientConfig {
    ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default versions")
        .with_root_certificates(RootCertStore::empty())
        .with_no_client_auth()
}

/// Verifies the certificate against `name` instead of the name the connection was opened with.
#[derive(Debug)]
struct ExpectedName {
    inner: Arc<dyn ServerCertVerifier>,
    name: ServerName<'static>,
}

impl ServerCertVerifier for ExpectedName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.inner
            .verify_server_cert(end_entity, intermediates, &self.name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }

    fn requires_raw_public_keys(&self) -> bool {
        self.inner.requires_raw_public_keys()
    }

    fn root_hint_subjects(&self) -> Option<&[rustls::DistinguishedName]> {
        self.inner.root_hint_subjects()
    }
}

/// The provider the configurations above use (for tests that build a matching server).
pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_system_store_is_the_default() {
        assert!(client_config(&TlsOptions::default()).is_ok());
    }

    #[test]
    fn bad_pem_names_its_field() {
        let err = client_config(&TlsOptions {
            ca_pem: Some("not a certificate".into()),
            ..TlsOptions::default()
        })
        .unwrap_err();
        assert_eq!(err.field, "tls.caPem");
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let err = client_config(&TlsOptions {
            client_cert_pem: Some(cert.cert.pem()),
            ..TlsOptions::default()
        })
        .unwrap_err();
        assert_eq!(err.field, "tls.clientKeyPem");
        let err = client_config(&TlsOptions {
            server_name: Some("not a name!".into()),
            ..TlsOptions::default()
        })
        .unwrap_err();
        assert_eq!(err.field, "tls.serverName");
    }

    #[test]
    fn a_pinned_ca_and_a_client_certificate_are_accepted() {
        let ca = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let config = client_config(&TlsOptions {
            enabled: Some(true),
            ca_pem: Some(ca.cert.pem()),
            client_cert_pem: Some(ca.cert.pem()),
            client_key_pem: Some(ca.signing_key.serialize_pem()),
            server_name: Some("localhost".into()),
        })
        .unwrap();
        assert!(config.client_auth_cert_resolver.has_certs());
        // The key never shows in debug output.
        let debug = format!(
            "{:?}",
            TlsOptions {
                client_key_pem: Some("SECRET".into()),
                ..TlsOptions::default()
            }
        );
        assert!(!debug.contains("SECRET"));
    }
}
