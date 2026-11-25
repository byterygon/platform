//! A small HTTP/1.1 client for the Schema Registry: hyper over a tokio TCP stream, TLS through
//! rustls with the profile's CA only. One connection per request (registry calls are few and
//! their results are cached). No proxy, no redirects, no cookies, nothing loaded implicitly.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::Request;
use hyper_util::rt::TokioIo;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, ServerName};
use tokio::net::TcpStream;

use crate::error::{ErrorKind, RemoteCode};
use crate::types::TlsOptions;
use crate::{CodecError, Result};

/// Largest response body read.
const MAX_BODY: usize = 16 * 1024 * 1024;

/// How the client authenticates (spec §5.3).
#[derive(Clone, Default, PartialEq, Eq)]
pub enum RegistryAuth {
    #[default]
    None,
    Basic {
        user: String,
        password: String,
    },
    Bearer {
        token: String,
    },
}

impl std::fmt::Debug for RegistryAuth {
    // Never print a secret.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RegistryAuth::None => f.write_str("None"),
            RegistryAuth::Basic { user, .. } => {
                write!(f, "Basic {{ user: {user:?}, password: <redacted> }}")
            }
            RegistryAuth::Bearer { .. } => f.write_str("Bearer { token: <redacted> }"),
        }
    }
}

/// Resolves the registry's host and port to the addresses the client may connect to (an
/// embedder's outbound policy); an `Err` refuses the connection with its message.
pub type Resolver = Arc<
    dyn Fn(
            String,
            u16,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = std::result::Result<Vec<std::net::SocketAddr>, String>,
                    > + Send,
            >,
        > + Send
        + Sync,
>;

/// Where and how to reach a registry.
#[derive(Clone)]
pub struct RegistryConfig {
    /// `http://host:port[/path]` or `https://…`.
    pub url: String,
    pub auth: RegistryAuth,
    /// Required for `https` URLs: the CA to trust (no system roots are loaded, spec Open
    /// question 6: pin a CA instead).
    pub tls: Option<TlsOptions>,
    /// The client key for `tls.clientCertPem` (from the profile's secrets).
    pub client_key_pem: Option<String>,
    /// Per request; 30 s by default.
    pub timeout: Duration,
    /// How the host is resolved; `None` lets the system resolve it and connects to the first
    /// address that answers.
    pub resolve: Option<Resolver>,
}

impl std::fmt::Debug for RegistryConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RegistryConfig")
            .field("url", &self.url)
            .field("auth", &self.auth)
            .field("tls", &self.tls.as_ref().map(|t| t.enabled))
            .field(
                "client_key_pem",
                &self.client_key_pem.as_ref().map(|_| "<redacted>"),
            )
            .field("timeout", &self.timeout)
            .finish()
    }
}

impl RegistryConfig {
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            auth: RegistryAuth::None,
            tls: None,
            client_key_pem: None,
            timeout: Duration::from_secs(30),
            resolve: None,
        }
    }
}

#[derive(Debug, Clone)]
struct BaseUrl {
    https: bool,
    host: String,
    port: u16,
    path: String,
}

fn parse_url(url: &str) -> Result<BaseUrl> {
    let bad = |why: &str| CodecError::invalid(format!("registry URL {url:?}: {why}")).field("url");
    let (https, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(bad("must start with http:// or https://"));
    };
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.contains('@') {
        return Err(bad(
            "put credentials in the profile's authentication, not the URL",
        ));
    }
    if path.contains(['?', '#']) {
        return Err(bad("must not have a query or fragment"));
    }
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6
            .split_once(']')
            .ok_or_else(|| bad("unclosed IPv6 address"))?;
        (h.to_owned(), after.strip_prefix(':'))
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_owned(), Some(p)),
            None => (authority.to_owned(), None),
        }
    };
    if host.is_empty() {
        return Err(bad("has no host"));
    }
    let port = match port {
        Some(p) => p.parse().map_err(|_| bad("has an invalid port"))?,
        None if https => 443,
        None => 80,
    };
    let path = path.trim_end_matches('/');
    Ok(BaseUrl {
        https,
        host,
        port,
        path: if path.is_empty() {
            String::new()
        } else {
            format!("/{path}")
        },
    })
}

/// The transport of a registry client.
pub(crate) struct Http {
    base: BaseUrl,
    authorization: Option<String>,
    tls: Option<(tokio_rustls::TlsConnector, ServerName<'static>)>,
    timeout: Duration,
    resolve: Option<Resolver>,
}

impl std::fmt::Debug for Http {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Http")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

/// A response: the status and the body.
pub(crate) struct Response {
    pub status: u16,
    pub body: Bytes,
}

impl Http {
    pub fn new(config: &RegistryConfig) -> Result<Self> {
        let base = parse_url(&config.url)?;
        let authorization = match &config.auth {
            RegistryAuth::None => None,
            RegistryAuth::Basic { user, password } => Some(format!(
                "Basic {}",
                BASE64.encode(format!("{user}:{password}"))
            )),
            RegistryAuth::Bearer { token } => Some(format!("Bearer {token}")),
        };
        let tls_on = base.https || config.tls.as_ref().is_some_and(|t| t.enabled);
        let tls = if tls_on {
            let opts = config.tls.clone().unwrap_or_default();
            Some(tls_connector(
                &opts,
                config.client_key_pem.as_deref(),
                &base.host,
            )?)
        } else {
            None
        };
        Ok(Self {
            base,
            authorization,
            tls,
            timeout: config.timeout,
            resolve: config.resolve.clone(),
        })
    }

    pub fn url(&self, path: &str) -> String {
        let scheme = if self.tls.is_some() { "https" } else { "http" };
        format!(
            "{scheme}://{}:{}{}{path}",
            self.base.host, self.base.port, self.base.path
        )
    }

    /// Sends a request to `path` (with its query) under the base path.
    pub async fn send(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Response> {
        match tokio::time::timeout(self.timeout, self.send_inner(method, path, body)).await {
            Ok(r) => r,
            Err(_) => Err(CodecError::new(
                ErrorKind::Connect,
                format!(
                    "the registry at {} did not answer within {} s",
                    self.url(""),
                    self.timeout.as_secs()
                ),
            )),
        }
    }

    async fn send_inner(
        &self,
        method: hyper::Method,
        path: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Response> {
        let unreachable = |e: String| {
            CodecError::new(
                ErrorKind::Connect,
                format!(
                    "cannot reach the registry at {}:{}: {e}",
                    self.base.host, self.base.port
                ),
            )
        };
        let tcp = match &self.resolve {
            None => TcpStream::connect((self.base.host.as_str(), self.base.port))
                .await
                .map_err(|e| unreachable(e.to_string()))?,
            Some(resolve) => {
                let addrs = resolve(self.base.host.clone(), self.base.port)
                    .await
                    .map_err(|e| CodecError::new(ErrorKind::Connect, e))?;
                let mut last = "no address".to_owned();
                let mut connected = None;
                for addr in addrs {
                    match TcpStream::connect(addr).await {
                        Ok(tcp) => {
                            connected = Some(tcp);
                            break;
                        }
                        Err(e) => last = e.to_string(),
                    }
                }
                connected.ok_or_else(|| unreachable(last))?
            }
        };
        let _ = tcp.set_nodelay(true);
        let host_header = if (self.base.port == 443 && self.tls.is_some())
            || (self.base.port == 80 && self.tls.is_none())
        {
            self.base.host.clone()
        } else if self.base.host.contains(':') {
            format!("[{}]:{}", self.base.host, self.base.port)
        } else {
            format!("{}:{}", self.base.host, self.base.port)
        };
        let mut req = Request::builder()
            .method(method)
            .uri(format!("{}{path}", self.base.path))
            .header(hyper::header::HOST, host_header)
            .header(
                hyper::header::ACCEPT,
                "application/vnd.schemaregistry.v1+json, application/json",
            );
        if body.is_some() {
            req = req.header(
                hyper::header::CONTENT_TYPE,
                "application/vnd.schemaregistry.v1+json",
            );
        }
        if let Some(a) = &self.authorization {
            req = req.header(hyper::header::AUTHORIZATION, a);
        }
        let req = req
            .body(Full::new(Bytes::from(body.unwrap_or_default())))
            .map_err(|e| CodecError::invalid(format!("registry request: {e}")))?;

        match &self.tls {
            Some((connector, name)) => {
                let stream = connector.connect(name.clone(), tcp).await.map_err(|e| {
                    CodecError::new(
                        ErrorKind::Tls,
                        format!("TLS with the registry at {} failed: {e}", self.base.host),
                    )
                })?;
                exchange(TokioIo::new(stream), req).await
            }
            None => exchange(TokioIo::new(tcp), req).await,
        }
    }
}

async fn exchange<T>(io: T, req: Request<Full<Bytes>>) -> Result<Response>
where
    T: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
{
    let (mut sender, conn) = hyper::client::conn::http1::handshake(io)
        .await
        .map_err(|e| CodecError::new(ErrorKind::Connect, format!("registry connection: {e}")))?;
    let driver = tokio::spawn(async move {
        let _ = conn.await;
    });
    let result = async {
        let resp = sender.send_request(req).await.map_err(|e| {
            CodecError::new(ErrorKind::Connect, format!("registry request failed: {e}"))
        })?;
        let status = resp.status().as_u16();
        let body = Limited::new(resp.into_body(), MAX_BODY)
            .collect()
            .await
            .map_err(|e| CodecError::new(ErrorKind::Remote, format!("registry response: {e}")))?
            .to_bytes();
        Ok(Response { status, body })
    }
    .await;
    driver.abort();
    result
}

fn tls_connector(
    opts: &TlsOptions,
    client_key_pem: Option<&str>,
    host: &str,
) -> Result<(tokio_rustls::TlsConnector, ServerName<'static>)> {
    let tls_err = |m: String| CodecError::new(ErrorKind::Tls, m).field("tls");
    let ca = opts
        .ca_pem
        .as_deref()
        .filter(|p| !p.trim().is_empty())
        .ok_or_else(|| {
            tls_err("TLS to the registry needs its CA certificate (PEM) in the profile".into())
        })?;
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(ca.as_bytes()) {
        let cert = cert.map_err(|e| tls_err(format!("CA certificate: {e}")))?;
        roots
            .add(cert)
            .map_err(|e| tls_err(format!("CA certificate: {e}")))?;
    }
    if roots.is_empty() {
        return Err(tls_err("CA certificate: no PEM certificate found".into()));
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| tls_err(format!("TLS: {e}")))?
        .with_root_certificates(roots);
    let config = match (
        opts.client_cert_pem
            .as_deref()
            .filter(|p| !p.trim().is_empty()),
        client_key_pem,
    ) {
        (Some(cert), Some(key)) => {
            let chain = CertificateDer::pem_slice_iter(cert.as_bytes())
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| tls_err(format!("client certificate: {e}")))?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|e| tls_err(format!("client key: {e}")))?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|e| tls_err(format!("client certificate: {e}")))?
        }
        (Some(_), None) => return Err(tls_err("the client certificate needs its key".into())),
        _ => builder.with_no_client_auth(),
    };
    let name = opts
        .server_name
        .as_deref()
        .filter(|n| !n.is_empty())
        .unwrap_or(host);
    let name = ServerName::try_from(name.to_owned())
        .map_err(|e| tls_err(format!("server name {name}: {e}")))?;
    Ok((tokio_rustls::TlsConnector::from(Arc::new(config)), name))
}

/// The error of a non-2xx registry response (`{"error_code": 40401, "message": "…"}`).
pub(crate) fn status_error(status: u16, body: &[u8]) -> CodecError {
    #[derive(serde::Deserialize)]
    struct Body {
        error_code: Option<i64>,
        message: Option<String>,
    }
    let parsed: Option<Body> = serde_json::from_slice(body).ok();
    let message = parsed
        .as_ref()
        .and_then(|b| b.message.clone())
        .unwrap_or_else(|| String::from_utf8_lossy(&body[..body.len().min(500)]).into_owned());
    let code = parsed.as_ref().and_then(|b| b.error_code);
    let kind = match (status, code) {
        (401, _) => ErrorKind::Auth,
        (403, _) => ErrorKind::Forbidden,
        (404, _) => ErrorKind::NotFound,
        (409, _) => ErrorKind::Conflict,
        (422, _) => ErrorKind::Invalid,
        _ => ErrorKind::Remote,
    };
    let mut e = CodecError::new(
        kind,
        if message.is_empty() {
            format!("registry answered HTTP {status}")
        } else {
            message
        },
    );
    e.remote = Some(RemoteCode {
        code: code.map_or_else(|| format!("HTTP {status}"), |c| c.to_string()),
        detail: Some(format!("HTTP {status}")),
    });
    e
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls() {
        let u = parse_url("http://localhost:8081").unwrap();
        assert_eq!(
            (u.https, u.host.as_str(), u.port, u.path.as_str()),
            (false, "localhost", 8081, "")
        );
        let u = parse_url("https://reg.example/api/ccompat/").unwrap();
        assert_eq!(
            (u.https, u.port, u.path.as_str()),
            (true, 443, "/api/ccompat")
        );
        let u = parse_url("http://[::1]:9000").unwrap();
        assert_eq!((u.host.as_str(), u.port), ("::1", 9000));
        assert!(parse_url("ftp://x").is_err());
        assert!(parse_url("http://u:p@x").is_err());
        assert!(parse_url("http://x:abc").is_err());
        assert!(parse_url("http://x/?a=1").is_err());
    }

    #[test]
    fn https_needs_a_ca_and_secrets_are_not_printed() {
        let mut c = RegistryConfig::new("https://reg.example");
        let e = Http::new(&c).unwrap_err();
        assert_eq!(e.kind, ErrorKind::Tls);
        c.auth = RegistryAuth::Basic {
            user: "u".into(),
            password: "hunter2".into(),
        };
        c.client_key_pem = Some("-----BEGIN PRIVATE KEY-----".into());
        let printed = format!("{c:?}");
        assert!(
            !printed.contains("hunter2") && !printed.contains("BEGIN"),
            "{printed}"
        );
    }

    #[test]
    fn errors() {
        let e = status_error(
            404,
            br#"{"error_code":40403,"message":"Schema 9 not found"}"#,
        );
        assert_eq!(e.kind, ErrorKind::NotFound);
        assert_eq!(e.message, "Schema 9 not found");
        assert_eq!(e.remote.unwrap().code, "40403");
        assert_eq!(status_error(401, b"").kind, ErrorKind::Auth);
        assert_eq!(status_error(409, b"{}").kind, ErrorKind::Conflict);
        assert_eq!(status_error(500, b"oops").message, "oops");
    }
}
