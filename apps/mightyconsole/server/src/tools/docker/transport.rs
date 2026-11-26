//! How the Docker tool reaches an Engine (DOC-23 §6, TSK-116): a [`DockerTransport`] opens one
//! byte stream per API request, and everything above it (requests, hijacked exec, logs, stats,
//! events, archives, the API version from `/_ping`) is the same on every transport.
//!
//! - [`SshTransport`] (§6.4): a `direct-streamlocal` channel to the socket on an SSH host.
//! - [`SocketTransport`] (§6.2): a Unix socket, or a Windows named pipe, on the server's own
//!   machine. Whoever may connect with it is root on that machine (§11.4): saving such a profile
//!   needs `profiles.hostAccess`.
//! - [`TcpTransport`] (§6.3): TCP through the server's outbound policy, with TLS (the pinned CA or
//!   the system's trust store, a client certificate; never "skip verification") or, when the
//!   profile carries the person's acceptance, without.
//!
//! The server never reads `DOCKER_HOST`, a Docker context or `~/.docker` (§11.6): a transport is
//! only what the profile says.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use net_route::BoxStream;
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use super::TOOL;
use super::ssh::SshSession;
use crate::core::{ToolError, ToolErrorKind};

/// How long a TCP connection (and its TLS handshake) or a local socket may take to open.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(15);

/// The transport a Docker profile names (`fields.transport`; `ssh` when absent).
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    Default,
    Serialize,
    Deserialize,
    ts_rs::TS,
    schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum DockerTransportKind {
    /// The socket on a saved SSH host (DOC-23 §6.4).
    #[default]
    Ssh,
    /// A Unix socket or a Windows named pipe on the server's machine (§6.2).
    Socket,
    /// The Engine's TCP API, with or without TLS (§6.3).
    Tcp,
}

/// Opens streams to one Docker Engine.
pub trait DockerTransport: Send + Sync {
    /// A new stream to the Engine's API, for one HTTP/1.1 connection.
    fn open(&self) -> BoxFuture<'_, Result<BoxStream, ToolError>>;

    /// What the streams reach, for messages: `/var/run/docker.sock on deploy@h:22`,
    /// `/var/run/docker.sock`, `docker.prod:2376`.
    fn describe(&self) -> String;

    /// Fires when the transport ended by itself (an SSH session the host closed); `None` for a
    /// transport that holds nothing open between requests.
    fn lost(&self) -> Option<CancellationToken> {
        None
    }

    /// Why the transport ended, once [`DockerTransport::lost`] fired.
    fn lost_reason(&self) -> String {
        String::new()
    }

    /// Ends what the transport holds open (on disconnect, when the handle is released).
    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async {})
    }

    /// The explained error of a request that failed on a stream this transport opened, when the
    /// transport knows better than "Docker did not answer" (a TLS alert after the handshake).
    fn explain(&self, error: &(dyn std::error::Error + 'static)) -> Option<ToolError> {
        let _ = error;
        None
    }
}

/// The socket on an SSH host: one channel per stream on one SSH session.
pub struct SshTransport {
    pub session: SshSession,
    pub socket_path: String,
    /// `user@host:port`.
    pub target: String,
}

impl DockerTransport for SshTransport {
    fn open(&self) -> BoxFuture<'_, Result<BoxStream, ToolError>> {
        Box::pin(self.session.open_socket(&self.socket_path))
    }

    fn describe(&self) -> String {
        format!("{} on {}", self.socket_path, self.target)
    }

    fn lost(&self) -> Option<CancellationToken> {
        Some(self.session.lost())
    }

    fn lost_reason(&self) -> String {
        self.session.lost_reason()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(self.session.close())
    }
}

/// A Unix socket (Linux, macOS) or a named pipe (Windows) on the server's machine.
pub struct SocketTransport {
    /// The path after `~` was expanded (see [`expand_socket_path`]).
    pub path: PathBuf,
}

impl DockerTransport for SocketTransport {
    fn open(&self) -> BoxFuture<'_, Result<BoxStream, ToolError>> {
        Box::pin(async move {
            let path = self.path.clone();
            match tokio::time::timeout(OPEN_TIMEOUT, open_local(&path)).await {
                Ok(result) => result,
                Err(_) => Err(ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!(
                        "{} did not accept a connection within {} s",
                        path.display(),
                        OPEN_TIMEOUT.as_secs()
                    ),
                )),
            }
        })
    }

    fn describe(&self) -> String {
        self.path.display().to_string()
    }
}

/// Who runs this server, for a message about a socket it may not use.
fn server_user() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "the user running mightyconsole-server".to_owned())
}

/// The explained error of a local socket that did not open.
fn local_error(path: &std::path::Path, e: &std::io::Error) -> ToolError {
    let shown = path.display();
    match e.kind() {
        std::io::ErrorKind::NotFound => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!(
                "there is no socket at {shown} on this server's machine: check that Docker runs \
                 and that the path is right (rootless Docker: /run/user/<uid>/docker.sock; Docker \
                 Desktop on macOS: ~/.docker/run/docker.sock)"
            ),
        ),
        std::io::ErrorKind::PermissionDenied => {
            let user = server_user();
            ToolError::new(
                ToolErrorKind::Forbidden,
                TOOL,
                format!(
                    "{user}, who runs this server, cannot read and write {shown}: add {user} to \
                     the docker group (`sudo usermod -aG docker {user}`) and start the server \
                     again"
                ),
            )
        }
        std::io::ErrorKind::ConnectionRefused => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("nothing listens on {shown}: is Docker running?"),
        ),
        _ => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("opening {shown} failed: {e}"),
        ),
    }
}

async fn open_local(path: &std::path::Path) -> Result<BoxStream, ToolError> {
    crate::core::outbound::connect_local(path)
        .await
        .map_err(|e| local_error(path, &e))
}

/// Whether `path` names a Windows named pipe (`//./pipe/docker_engine`, `\\.\pipe\...`).
pub fn is_named_pipe(path: &str) -> bool {
    let normal = path.replace('\\', "/");
    normal
        .get(..9)
        .is_some_and(|p| p.eq_ignore_ascii_case("//./pipe/"))
        && normal.len() > 9
}

/// The socket path of a `socket` profile as the server opens it: `~` and `~/...` become the home
/// of the user running the server (DOC-23 §6.2: only in this field); the result must be absolute
/// (a Unix path) or a named pipe (Windows). `home` is that user's home directory.
pub fn expand_socket_path(path: &str, home: Option<PathBuf>) -> Result<PathBuf, ToolError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "socketPath",
            "enter the socket's path, like /var/run/docker.sock",
        ));
    }
    if path.contains(['\0', '\n', '\r']) {
        return Err(ToolError::invalid(
            TOOL,
            "socketPath",
            "the socket path has a control character",
        ));
    }
    if is_named_pipe(path) {
        if !cfg!(windows) {
            return Err(ToolError::invalid(
                TOOL,
                "socketPath",
                "a named pipe is a Windows path; this server runs elsewhere: give a Unix socket",
            ));
        }
        return Ok(PathBuf::from(path.replace('/', "\\")));
    }
    let expanded = match path.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => {
            let home = home.ok_or_else(|| {
                ToolError::invalid(
                    TOOL,
                    "socketPath",
                    "the server's user has no home directory to expand ~ into: give the full path",
                )
            })?;
            let rest = rest.trim_start_matches('/');
            if rest.is_empty() {
                home
            } else {
                home.join(rest)
            }
        }
        Some(_) => {
            return Err(ToolError::invalid(
                TOOL,
                "socketPath",
                "~user is not expanded: give the full path, or ~/ for the server's own user",
            ));
        }
        None => PathBuf::from(path),
    };
    if cfg!(windows) {
        return Err(ToolError::invalid(
            TOOL,
            "socketPath",
            "on Windows, Docker listens on a named pipe: //./pipe/docker_engine",
        ));
    }
    if !expanded.is_absolute() {
        return Err(ToolError::invalid(
            TOOL,
            "socketPath",
            "the socket path must be absolute, like /var/run/docker.sock",
        ));
    }
    Ok(expanded)
}

/// TLS on a TCP transport: the configuration and the name the certificate is checked against
/// (the profile's `serverName` override is inside the configuration's verifier).
pub struct TcpTls {
    pub config: Arc<ClientConfig>,
    pub server_name: ServerName<'static>,
}

/// The Engine's TCP API: one connection per stream, through the outbound policy.
pub struct TcpTransport {
    pub host: String,
    pub port: u16,
    /// `None` for plain TCP (the profile carries the person's acceptance).
    pub tls: Option<TcpTls>,
}

impl TcpTransport {
    /// `host:port`, with brackets around an IPv6 address.
    pub fn address(&self) -> String {
        net_route::format_address(&self.host, self.port)
    }
}

impl DockerTransport for TcpTransport {
    fn open(&self) -> BoxFuture<'_, Result<BoxStream, ToolError>> {
        Box::pin(async move {
            let address = self.address();
            let open = async {
                let tcp = crate::core::outbound::connect_tcp(
                    TOOL,
                    &self.host,
                    self.port,
                    Some(OPEN_TIMEOUT),
                )
                .await?;
                let Some(tls) = &self.tls else {
                    return Ok(Box::new(tcp) as BoxStream);
                };
                let connector = tokio_rustls::TlsConnector::from(Arc::clone(&tls.config));
                match connector.connect(tls.server_name.clone(), tcp).await {
                    Ok(stream) => Ok(Box::new(stream) as BoxStream),
                    Err(e) => Err(tls_error(&address, &e)),
                }
            };
            match tokio::time::timeout(OPEN_TIMEOUT, open).await {
                Ok(result) => result,
                Err(_) => Err(ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!(
                        "{address} did not answer within {} s",
                        OPEN_TIMEOUT.as_secs()
                    ),
                )),
            }
        })
    }

    fn describe(&self) -> String {
        self.address()
    }

    fn explain(&self, error: &(dyn std::error::Error + 'static)) -> Option<ToolError> {
        let _ = self.tls.as_ref()?;
        tls_cause(error).map(|_| tls_error(&self.address(), error))
    }
}

/// The TLS error somewhere in `e`'s chain (an I/O error wraps it, hyper wraps that).
pub fn tls_cause<'a>(e: &'a (dyn std::error::Error + 'static)) -> Option<&'a rustls::Error> {
    let mut here = Some(e);
    while let Some(error) = here {
        if let Some(tls) = error.downcast_ref::<rustls::Error>() {
            return Some(tls);
        }
        if let Some(inner) = error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .and_then(|inner| inner.downcast_ref::<rustls::Error>())
        {
            return Some(inner);
        }
        here = error.source();
    }
    None
}

/// A failed TLS session, explained: the certificate (not trusted, wrong name, expired), or the
/// Engine refusing the client certificate. With TLS 1.3 that refusal comes after the handshake,
/// on the first request, so [`super::engine`] explains a failed request with it too.
pub fn tls_error(address: &str, e: &(dyn std::error::Error + 'static)) -> ToolError {
    let inner = tls_cause(e);
    use rustls::AlertDescription as Alert;
    let (kind, hint) = match inner {
        Some(rustls::Error::InvalidCertificate(why)) => (
            ToolErrorKind::Tls,
            match why {
                rustls::CertificateError::UnknownIssuer | rustls::CertificateError::BadSignature => {
                    "the Engine's certificate is not signed by the CA the profile pins (or, with no CA, by one this system trusts)".to_owned()
                }
                rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. } => {
                    "the Engine's certificate is not for this address: set the server name it carries".to_owned()
                }
                rustls::CertificateError::Expired | rustls::CertificateError::ExpiredContext { .. } => {
                    "the Engine's certificate has expired".to_owned()
                }
                other => format!("the Engine's certificate is not accepted ({other:?})"),
            },
        ),
        Some(rustls::Error::AlertReceived(
            alert @ (Alert::BadCertificate
            | Alert::CertificateRequired
            | Alert::UnknownCA
            | Alert::CertificateUnknown),
        )) => (
            ToolErrorKind::Auth,
            format!(
                "the Engine refused the client certificate ({alert:?}): it wants one signed by its \
                 own CA (dockerd --tlsverify --tlscacert)"
            ),
        ),
        Some(other) => (ToolErrorKind::Tls, other.to_string()),
        None => (ToolErrorKind::Tls, e.to_string()),
    };
    ToolError::new(kind, TOOL, format!("TLS to {address} failed: {hint}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_path_expands_the_servers_home_only() {
        let home = Some(PathBuf::from("/home/mc"));
        if cfg!(unix) {
            assert_eq!(
                expand_socket_path("/var/run/docker.sock", None).unwrap(),
                PathBuf::from("/var/run/docker.sock")
            );
            assert_eq!(
                expand_socket_path("~/.docker/run/docker.sock", home.clone()).unwrap(),
                PathBuf::from("/home/mc/.docker/run/docker.sock")
            );
            let err = |p: &str| {
                expand_socket_path(p, home.clone())
                    .unwrap_err()
                    .field
                    .unwrap()
            };
            assert_eq!(err("docker.sock"), "socketPath");
            assert_eq!(err("~root/docker.sock"), "socketPath");
            assert_eq!(err(" "), "socketPath");
            assert_eq!(err("/a\nb"), "socketPath");
            assert!(
                expand_socket_path("//./pipe/docker_engine", None)
                    .unwrap_err()
                    .message
                    .contains("Windows")
            );
            assert!(expand_socket_path("~/x", None).is_err());
        }
        assert!(is_named_pipe("//./pipe/docker_engine"));
        assert!(is_named_pipe(r"\\.\pipe\docker_engine"));
        assert!(!is_named_pipe("//./pipe/"));
        assert!(!is_named_pipe("/var/run/docker.sock"));
    }

    #[test]
    fn the_transport_is_ssh_unless_the_profile_says_otherwise() {
        assert_eq!(DockerTransportKind::default(), DockerTransportKind::Ssh);
        let kind: DockerTransportKind = serde_json::from_str("\"socket\"").unwrap();
        assert_eq!(kind, DockerTransportKind::Socket);
        assert!(serde_json::from_str::<DockerTransportKind>("\"npipe\"").is_err());
    }
}
