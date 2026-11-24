//! The only HTTP client of the sign-in: HTTPS to the identity provider, trusting only the CA
//! certificates from the configuration (never the system roots), HTTP/1.1, no redirects
//! followed, no proxy, a deadline per request and a bound on every answer's size.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Request;
use hyper::header::{self, HeaderValue};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use rustls::RootCertStore;
use rustls::pki_types::CertificateDer;
use url::Url;
use zeroize::Zeroizing;

/// Time allowed for one request to the IdP, connection included (DOC-25 §3.2.2).
pub const IDP_TIMEOUT: Duration = Duration::from_secs(10);
/// Largest answer read from the IdP.
pub const MAX_IDP_BODY: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HttpError {
    /// No answer: DNS, TCP, TLS (an untrusted certificate included) or the deadline.
    Unreachable(String),
    /// An answer too large or not readable.
    Body(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::Unreachable(e) => write!(f, "unreachable: {e}"),
            HttpError::Body(e) => write!(f, "bad answer: {e}"),
        }
    }
}

/// An answer: status and body (zeroized when dropped: it may hold tokens).
pub(crate) struct Answer {
    pub status: u16,
    pub body: Zeroizing<Vec<u8>>,
}

pub(crate) struct IdpHttp {
    client: Client<HttpsConnector<HttpConnector>, Full<Bytes>>,
    timeout: Duration,
}

impl IdpHttp {
    pub fn new(ca_certs: &[CertificateDer<'static>], timeout: Duration) -> Result<IdpHttp, String> {
        let mut roots = RootCertStore::empty();
        for cert in ca_certs {
            roots
                .add(cert.clone())
                .map_err(|e| format!("CA certificate: {e}"))?;
        }
        if roots.is_empty() {
            return Err("no CA certificate".into());
        }
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let tls = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| format!("TLS: {e}"))?
            .with_root_certificates(roots)
            .with_no_client_auth();
        let mut tcp = HttpConnector::new();
        tcp.enforce_http(false);
        tcp.set_connect_timeout(Some(timeout));
        tcp.set_nodelay(true);
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_only()
            .enable_http1()
            .wrap_connector(tcp);
        Ok(IdpHttp {
            client: Client::builder(TokioExecutor::new()).build(connector),
            timeout,
        })
    }

    async fn send(&self, request: Request<Full<Bytes>>) -> Result<Answer, HttpError> {
        let work = async {
            let response = self
                .client
                .request(request)
                .await
                .map_err(|e| HttpError::Unreachable(error_chain(&e)))?;
            let status = response.status().as_u16();
            let body = Limited::new(response.into_body(), MAX_IDP_BODY)
                .collect()
                .await
                .map_err(|e| HttpError::Body(e.to_string()))?
                .to_bytes();
            Ok(Answer {
                status,
                body: Zeroizing::new(body.to_vec()),
            })
        };
        tokio::time::timeout(self.timeout, work)
            .await
            .map_err(|_| HttpError::Unreachable("timed out".into()))?
    }

    /// `GET url`, with a bearer token when given.
    pub async fn get(&self, url: &Url, bearer: Option<&str>) -> Result<Answer, HttpError> {
        let mut request = Request::get(url.as_str())
            .header(header::ACCEPT, "application/json")
            .body(Full::new(Bytes::new()))
            .map_err(|e| HttpError::Unreachable(e.to_string()))?;
        if let Some(token) = bearer {
            let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|_| HttpError::Unreachable("access token is not a header value".into()))?;
            value.set_sensitive(true);
            request.headers_mut().insert(header::AUTHORIZATION, value);
        }
        self.send(request).await
    }

    /// `POST url` with a form body and an optional `Authorization` header value.
    pub async fn post_form(
        &self,
        url: &Url,
        form: Zeroizing<String>,
        authorization: Option<Zeroizing<String>>,
    ) -> Result<Answer, HttpError> {
        let mut request = Request::post(url.as_str())
            .header(header::ACCEPT, "application/json")
            .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(Full::new(Bytes::from(form.as_bytes().to_vec())))
            .map_err(|e| HttpError::Unreachable(e.to_string()))?;
        if let Some(authorization) = authorization {
            let mut value = HeaderValue::from_str(&authorization).map_err(|_| {
                HttpError::Unreachable("client credentials are not a header value".into())
            })?;
            value.set_sensitive(true);
            request.headers_mut().insert(header::AUTHORIZATION, value);
        }
        self.send(request).await
    }
}

/// An error with its sources, for the audit reason (never holds a token: requests carry them
/// in the body or a sensitive header, which errors do not print).
fn error_chain(error: &dyn std::error::Error) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(next) = source {
        text.push_str(": ");
        text.push_str(&next.to_string());
        source = next.source();
    }
    text
}
