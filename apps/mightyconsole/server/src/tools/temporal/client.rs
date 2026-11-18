//! The live Temporal client of a connected profile: a tonic channel to the frontend with the
//! profile's TLS options and API key, and the mapping of gRPC failures to [`ToolError`] (spec
//! §2.6, §9.1). Nothing here reaches any host but the address the profile names.

use std::time::Duration;

use tonic::metadata::{Ascii, MetadataValue};
use tonic::service::Interceptor;
use tonic::service::interceptor::InterceptedService;
use tonic::transport::{Certificate, Channel, ClientTlsConfig, Endpoint, Identity};
use tonic::{Code, Request, Status};

use super::TOOL;
use super::proto::temporal::api::workflowservice::v1::workflow_service_client::WorkflowServiceClient;
use super::types::{ConnectTemporalProfile, TemporalTlsOptions};
use crate::core::{RemoteError, ToolError, ToolErrorKind};

/// The address of a local dev server, used when the profile leaves it empty.
pub const DEFAULT_ADDRESS: &str = "127.0.0.1:7233";
/// The namespace opened first when the profile leaves it empty.
pub const DEFAULT_NAMESPACE: &str = "default";
/// Unary calls (spec §2.4: queries and mutations get 30 s).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Adds the API key and the client's name to every call.
#[derive(Clone)]
pub struct CallHeaders {
    bearer: Option<MetadataValue<Ascii>>,
}

impl Interceptor for CallHeaders {
    fn call(&mut self, mut request: Request<()>) -> Result<Request<()>, Status> {
        let metadata = request.metadata_mut();
        if let Some(bearer) = &self.bearer {
            metadata.insert("authorization", bearer.clone());
        }
        metadata.insert("client-name", MetadataValue::from_static("mightyconsole"));
        metadata.insert(
            "client-version",
            MetadataValue::from_static(env!("CARGO_PKG_VERSION")),
        );
        Ok(request)
    }
}

pub type Service = InterceptedService<Channel, CallHeaders>;

/// What `temporal.connect` keeps in the hub.
pub struct TemporalClient {
    /// A clone per call: the channel multiplexes.
    pub service: WorkflowServiceClient<Service>,
    pub address: String,
    /// The profile's namespace.
    pub namespace: String,
}

impl TemporalClient {
    pub fn service(&self) -> WorkflowServiceClient<Service> {
        self.service.clone()
    }

    /// The namespace a call names, the profile's when empty.
    pub fn namespace_or_default(&self, namespace: Option<&str>) -> String {
        match namespace.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => n.to_owned(),
            None => self.namespace.clone(),
        }
    }

    /// A request with the call timeout and the `temporal-namespace` header Temporal Cloud routes
    /// API-key calls by.
    pub fn request<T>(&self, namespace: &str, message: T) -> Request<T> {
        let mut request = Request::new(message);
        request.set_timeout(CALL_TIMEOUT);
        if let Ok(value) = MetadataValue::try_from(namespace) {
            request.metadata_mut().insert("temporal-namespace", value);
        }
        request
    }
}

fn invalid(field: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(TOOL, field, message)
}

/// Opens the channel to the profile's frontend. The first call that follows (GetSystemInfo)
/// proves the server speaks Temporal.
pub async fn connect(profile: &ConnectTemporalProfile) -> Result<TemporalClient, ToolError> {
    let address = profile
        .address
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or(DEFAULT_ADDRESS)
        .to_owned();
    if address.contains("://") || address.contains('/') || address.contains(char::is_whitespace) {
        return Err(invalid(
            "address",
            "use host:port, without a scheme or a path",
        ));
    }
    let namespace = profile
        .namespace
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(DEFAULT_NAMESPACE)
        .to_owned();
    let tls = profile.tls.clone().unwrap_or_default();
    let api_key = profile
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty());
    if api_key.is_some() && !tls.enabled {
        // The key would travel in the clear.
        return Err(invalid(
            "tls.enabled",
            "an API key is only sent over TLS; turn TLS on",
        ));
    }
    let bearer = match api_key {
        Some(key) => Some(
            MetadataValue::try_from(format!("Bearer {key}")).map_err(|_| {
                invalid("apiKey", "the API key has characters a header cannot carry")
            })?,
        ),
        None => None,
    };

    let scheme = if tls.enabled { "https" } else { "http" };
    let mut endpoint = Endpoint::from_shared(format!("{scheme}://{address}"))
        .map_err(|_| invalid("address", "not a valid host:port"))?
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_nodelay(true)
        .http2_keep_alive_interval(Duration::from_secs(30))
        .keep_alive_while_idle(true);
    if tls.enabled {
        endpoint = endpoint
            .tls_config(tls_config(profile, &tls, &address)?)
            .map_err(|e| tls_error(&e))?;
    }
    let channel = endpoint
        .connect()
        .await
        .map_err(|e| connect_error(&address, tls.enabled, &e))?;
    Ok(TemporalClient {
        service: WorkflowServiceClient::with_interceptor(channel, CallHeaders { bearer })
            // A history page of 1,000 events can be large; the default 4 MiB is too small.
            .max_decoding_message_size(64 * 1024 * 1024),
        address,
        namespace,
    })
}

fn tls_config(
    profile: &ConnectTemporalProfile,
    tls: &TemporalTlsOptions,
    address: &str,
) -> Result<ClientTlsConfig, ToolError> {
    let mut config = ClientTlsConfig::new().with_native_roots();
    if let Some(ca) = tls.ca_pem.as_deref().filter(|c| !c.trim().is_empty()) {
        if !ca.contains("BEGIN CERTIFICATE") {
            return Err(invalid("tls.caPem", "not a PEM certificate"));
        }
        config = config.ca_certificate(Certificate::from_pem(ca));
    }
    let cert = tls
        .client_cert_pem
        .as_deref()
        .filter(|c| !c.trim().is_empty());
    let key = profile
        .client_key_pem
        .as_deref()
        .filter(|k| !k.trim().is_empty());
    match (cert, key) {
        (Some(cert), Some(key)) => {
            if !cert.contains("BEGIN CERTIFICATE") {
                return Err(invalid("tls.clientCertPem", "not a PEM certificate"));
            }
            config = config.identity(Identity::from_pem(cert, key));
        }
        (None, None) => {}
        (Some(_), None) => {
            return Err(invalid(
                "clientKeyPem",
                "a client certificate needs its private key",
            ));
        }
        (None, Some(_)) => {
            return Err(invalid(
                "tls.clientCertPem",
                "a client key needs its certificate",
            ));
        }
    }
    let host = address.rsplit_once(':').map_or(address, |(host, _)| host);
    let name = tls
        .server_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(host);
    Ok(config.domain_name(name.trim_matches(['[', ']'])))
}

/// The messages of an error and its sources, for deciding what failed.
fn chain(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(e) = source {
        text.push_str(": ");
        text.push_str(&e.to_string());
        source = e.source();
    }
    text
}

fn is_tls_failure(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    [
        "certificate",
        "handshake",
        "invalid peer",
        "tls",
        "unknownissuer",
        "notvalidforname",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn tls_error(error: &tonic::transport::Error) -> ToolError {
    ToolError::new(
        ToolErrorKind::Tls,
        TOOL,
        format!("TLS settings rejected: {}", chain(error)),
    )
}

fn connect_error(address: &str, tls: bool, error: &tonic::transport::Error) -> ToolError {
    let text = chain(error);
    if tls && is_tls_failure(&text) {
        return ToolError::new(
            ToolErrorKind::Tls,
            TOOL,
            format!("TLS to {address} failed: {text}"),
        );
    }
    ToolError::new(
        ToolErrorKind::Connect,
        TOOL,
        format!("cannot reach the Temporal frontend at {address}: {text}"),
    )
}

/// A gRPC failure as the tool's error (spec §2.6). The status message is the server's own text;
/// it never holds the credentials we sent.
pub fn status_error(address: &str, status: &Status) -> ToolError {
    let remote = RemoteError {
        code: format!("{:?}", status.code()),
        name: None,
        detail: Some(status.message().to_owned()).filter(|m| !m.is_empty()),
    };
    let message = if status.message().is_empty() {
        format!("{:?}", status.code())
    } else {
        status.message().to_owned()
    };
    let error = match status.code() {
        Code::Unauthenticated => ToolError::new(ToolErrorKind::Auth, TOOL, message),
        Code::PermissionDenied => ToolError::new(ToolErrorKind::Forbidden, TOOL, message),
        Code::NotFound => ToolError {
            resource: Some("resource".into()),
            ..ToolError::new(ToolErrorKind::NotFound, TOOL, message)
        },
        Code::InvalidArgument => ToolError::new(ToolErrorKind::Invalid, TOOL, message),
        Code::FailedPrecondition | Code::AlreadyExists | Code::Aborted => {
            ToolError::new(ToolErrorKind::Conflict, TOOL, message)
        }
        Code::Unavailable => {
            let text = chain(status);
            if is_tls_failure(&text) {
                ToolError::new(
                    ToolErrorKind::Tls,
                    TOOL,
                    format!("TLS to {address} failed: {text}"),
                )
            } else {
                ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!("the Temporal frontend at {address} is unavailable: {message}"),
                )
            }
        }
        Code::DeadlineExceeded => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("the Temporal frontend at {address} did not answer in time"),
        ),
        // Rate limited: the same call works a moment later.
        Code::ResourceExhausted => {
            ToolError::new(ToolErrorKind::Remote, TOOL, message).retryable(true)
        }
        _ => ToolError::new(ToolErrorKind::Remote, TOOL, message).retryable(false),
    };
    error.with_remote(remote)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> ConnectTemporalProfile {
        serde_json::from_value(serde_json::json!({ "name": "t" })).unwrap()
    }

    #[test]
    fn grpc_codes_map_to_the_error_kinds_of_the_spec() {
        let kind = |code| status_error("h:1", &Status::new(code, "x")).kind;
        assert_eq!(kind(Code::Unauthenticated), ToolErrorKind::Auth);
        assert_eq!(kind(Code::PermissionDenied), ToolErrorKind::Forbidden);
        assert_eq!(kind(Code::NotFound), ToolErrorKind::NotFound);
        assert_eq!(kind(Code::InvalidArgument), ToolErrorKind::Invalid);
        assert_eq!(kind(Code::FailedPrecondition), ToolErrorKind::Conflict);
        assert_eq!(kind(Code::Unavailable), ToolErrorKind::Connect);
        assert_eq!(kind(Code::DeadlineExceeded), ToolErrorKind::Connect);
        assert_eq!(kind(Code::Internal), ToolErrorKind::Remote);
        let error = status_error("h:1", &Status::new(Code::NotFound, "no such workflow"));
        assert_eq!(error.remote.unwrap().code, "NotFound");
    }

    #[tokio::test]
    async fn an_api_key_needs_tls() {
        let mut p = profile();
        p.api_key = Some("secret-key".into());
        let Err(error) = connect(&p).await else {
            panic!("expected an error")
        };
        assert_eq!(error.kind, ToolErrorKind::Invalid);
        assert_eq!(error.field.as_deref(), Some("tls.enabled"));
        assert!(!error.message.contains("secret-key"));
    }

    #[tokio::test]
    async fn a_client_certificate_needs_its_key() {
        let mut p = profile();
        p.tls = Some(TemporalTlsOptions {
            enabled: true,
            ..TemporalTlsOptions::default()
        });
        p.tls.as_mut().unwrap().client_cert_pem =
            Some("-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----".into());
        let Err(error) = connect(&p).await else {
            panic!("expected an error")
        };
        assert_eq!(error.field.as_deref(), Some("clientKeyPem"));
    }

    #[tokio::test]
    async fn the_address_is_host_and_port() {
        let mut p = profile();
        p.address = Some("https://temporal.example:7233/x".into());
        let Err(error) = connect(&p).await else {
            panic!("expected an error")
        };
        assert_eq!(error.field.as_deref(), Some("address"));
    }

    #[tokio::test]
    async fn nothing_listening_is_a_connect_error_with_the_address() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut p = profile();
        p.address = Some(format!("127.0.0.1:{port}"));
        let Err(error) = connect(&p).await else {
            panic!("expected an error")
        };
        assert_eq!(error.kind, ToolErrorKind::Connect);
        assert!(error.message.contains(&format!("127.0.0.1:{port}")));
        assert!(error.retryable);
    }
}
