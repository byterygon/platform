//! The SSH side of the Docker tool (Mightyconsole spec §10.2, §10.3): one SSH session per live
//! handle, then one `direct-streamlocal@openssh.com` channel to the Docker socket per API request.
//!
//! The session is `net-route`'s ([`net_route::SshSession`], moved there from this file by
//! TSK-115): the host key is checked in the handshake against the one the SSH host trusts, so
//! **nothing reaches an untrusted host** (no password, key signature or agent request is sent; the
//! connect fails with `HostKey` and the key the host presented). The TCP connection goes through
//! the server's outbound policy. What stays here is Docker's own: the socket channel and the
//! explained error of a socket the host does not forward.

use std::sync::Arc;
use std::time::Duration;

use net_route::{Dialer, OpenError, SshAuth, SshHop};
use tokio_util::sync::CancellationToken;

use super::TOOL;
use crate::core::route::{OutboundTcp, Via, fingerprint, route_fingerprint, tool_error};
use crate::core::{HostKeyFingerprint, RemoteError, ToolError, ToolErrorKind};

/// How long the TCP connection (through the outbound policy) may take; the SSH handshake and
/// login then have net-route's own 20 s.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// How long opening one channel to the socket may take.
pub const CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the host may take to answer a keepalive after a channel did not open in time.
pub const ALIVE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the check of a refused socket may take.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// What the server logs in with. The secrets never reach a log line or an error message.
pub enum Credentials {
    PrivateKey {
        text: String,
        passphrase: Option<String>,
    },
    Password(String),
    Agent,
}

/// Where and as whom to connect.
pub struct SshTarget {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub credentials: Credentials,
    /// The key the SSH host trusts; `None` on first use.
    pub trusted: Option<HostKeyFingerprint>,
    pub keepalive: Option<Duration>,
}

impl SshTarget {
    /// `user@host:port`, for messages and the Host page.
    pub fn display(&self) -> String {
        format!("{}@{}", self.username, self.address())
    }

    /// `host:port`, with brackets around an IPv6 address.
    pub fn address(&self) -> String {
        net_route::format_address(&self.host, self.port)
    }

    /// The SSH host as net-route takes it.
    fn hop(self) -> SshHop {
        SshHop {
            name: String::new(),
            host: self.host,
            port: self.port,
            user: self.username,
            auth: match self.credentials {
                Credentials::PrivateKey { text, passphrase } => SshAuth::PrivateKey {
                    key: text.into(),
                    passphrase: passphrase.map(Into::into),
                },
                Credentials::Password(password) => SshAuth::Password(password.into()),
                Credentials::Agent => SshAuth::Agent,
            },
            trusted: self.trusted.map(route_fingerprint),
            keepalive: self.keepalive,
        }
    }
}

/// A logged-in SSH session to a Docker host.
pub struct SshSession {
    inner: Arc<net_route::SshSession>,
    target: String,
    /// The host key the session was opened with (the trusted one).
    pub host_key: HostKeyFingerprint,
}

/// A channel the host refused, as Docker's explained error reads it.
#[derive(Debug, Clone)]
struct Refusal {
    prohibited: bool,
    code: u32,
    description: String,
}

impl SshSession {
    /// Connects through the outbound policy, checks the host key and logs in (spec §10.2).
    /// Errors: `Connect` (unreachable, timed out, the handshake failed), `HostKey` (unknown or
    /// changed), `Auth` (rejected), `Invalid` (a private key that does not parse, a wrong
    /// passphrase, no ssh-agent), `Forbidden` (the outbound policy).
    pub async fn connect(target: SshTarget) -> Result<SshSession, ToolError> {
        SshSession::connect_via(target, &Via::Direct).await
    }

    /// [`SshSession::connect`] through the profile's route (DOC-23 §6.4): the route reaches the
    /// host's sshd and Docker's own SSH login runs over that stream, with its own host key.
    pub async fn connect_via(target: SshTarget, via: &Via) -> Result<SshSession, ToolError> {
        let display = target.display();
        let hop = target.hop();
        let session = match via.routed() {
            None => {
                let dialer = Dialer::direct()
                    .with_connector(OutboundTcp::new(TOOL))
                    .with_budget(CONNECT_TIMEOUT);
                net_route::SshSession::connect(&dialer, &hop)
                    .await
                    .map_err(|e| tool_error(TOOL, e))?
            }
            Some(routed) => {
                let dialer = routed.dialer_to(&hop.host, Some(CONNECT_TIMEOUT))?;
                net_route::SshSession::connect(&dialer, &hop)
                    .await
                    .map_err(|e| routed.error(e))?
            }
        };
        Ok(SshSession {
            host_key: fingerprint(session.host_key().clone()),
            inner: Arc::new(session),
            target: display,
        })
    }

    /// Opens a channel to the Unix socket `path` on the host. A host that refuses streamlocal
    /// forwarding, or cannot open the socket, gets the explained error of spec §10.3.
    pub async fn open_socket(&self, path: &str) -> Result<net_route::BoxStream, ToolError> {
        if self.inner.is_lost() {
            return Err(self.lost_error());
        }
        let open = self.inner.open_streamlocal(path);
        match tokio::time::timeout(CHANNEL_TIMEOUT, open).await {
            // A session that stopped answering ends here, and the connection shows as failed
            // (TSK-166); a host that still answers is only slow to open the socket.
            Err(_) if !self.inner.check_alive(ALIVE_TIMEOUT).await => Err(self.lost_error()),
            Err(_) => Err(ToolError::new(
                ToolErrorKind::Connect,
                TOOL,
                format!(
                    "{} answers, but did not open {path} within {} s: is Docker's socket busy?",
                    self.target,
                    CHANNEL_TIMEOUT.as_secs()
                ),
            )),
            Ok(Ok(stream)) => Ok(stream),
            Ok(Err(OpenError::Refused {
                prohibited,
                code,
                description,
            })) => {
                let check = self.check_socket(path).await;
                let refusal = Refusal {
                    prohibited,
                    code,
                    description,
                };
                Err(socket_refused(&self.target, path, refusal, check))
            }
            Ok(Err(OpenError::Lost(_))) => Err(self.lost_error()),
            Ok(Err(OpenError::Failed(e))) if self.inner.is_lost() => {
                let _ = e;
                Err(self.lost_error())
            }
            Ok(Err(OpenError::Failed(e))) => Err(ToolError::new(
                ToolErrorKind::Connect,
                TOOL,
                format!("opening {path} on {} failed: {e}", self.target),
            )),
        }
    }

    /// After a refused socket channel: runs a read-only `test` of the socket on the host (an
    /// exec channel, at most [`CHECK_TIMEOUT`]). `None` when the host does not allow commands or
    /// answers something else (a login shell that is not POSIX, a forced command).
    async fn check_socket(&self, path: &str) -> Option<SocketCheck> {
        let command = check_command(path);
        let check = self.inner.exec_output(&command, 1024);
        let output = tokio::time::timeout(CHECK_TIMEOUT, check).await.ok()??;
        parse_check(&output)
    }

    /// Fires when the SSH session ended by itself (the host closed it, keepalives went
    /// unanswered).
    pub fn lost(&self) -> CancellationToken {
        self.inner.lost()
    }

    /// Why the session ended, once [`SshSession::lost`] fired.
    pub fn lost_reason(&self) -> String {
        self.inner.lost_reason()
    }

    fn lost_error(&self) -> ToolError {
        ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("{}: {}; connect again", self.target, self.lost_reason()),
        )
    }

    /// Ends the session (on disconnect and when the handle is released).
    pub async fn close(&self) {
        self.inner.close().await;
    }
}

/// What a failed socket channel found when it looked at the socket (see
/// `SshSession::check_socket`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SocketCheck {
    /// The socket is there and the user can read and write it: sshd refused to forward it.
    Usable,
    /// The socket is there; the user cannot use it.
    NoAccess,
    /// No socket at that path.
    Missing,
}

/// The path as one single-quoted shell word.
fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', "'\\''"))
}

/// The read-only command that looks at the socket: `test` only, one word on stdout.
fn check_command(path: &str) -> String {
    let p = shell_quote(path);
    format!(
        "if test -S {p}; then if test -r {p} && test -w {p}; then echo usable; else echo noaccess; fi; else echo missing; fi"
    )
}

fn parse_check(output: &[u8]) -> Option<SocketCheck> {
    match String::from_utf8_lossy(output).trim() {
        "usable" => Some(SocketCheck::Usable),
        "noaccess" => Some(SocketCheck::NoAccess),
        "missing" => Some(SocketCheck::Missing),
        _ => None,
    }
}

/// The explained error of spec §10.3: SSH works, the socket does not. OpenSSH answers
/// "connect failed" both when its configuration refuses to forward Unix sockets and when the
/// socket cannot be opened, so the check of the socket (when the host lets the server run it)
/// says which one it is.
fn socket_refused(
    target: &str,
    path: &str,
    failure: Refusal,
    check: Option<SocketCheck>,
) -> ToolError {
    let user = target.split('@').next().unwrap_or(target);
    let remote = RemoteError {
        code: failure.code.to_string(),
        name: Some(failure.description.clone()),
        detail: check.map(|c| format!("socket check: {c:?}")),
    };
    let said = failure.description.to_lowercase();
    let sshd = format!(
        "In the host's sshd_config set `AllowStreamLocalForwarding yes` (or `local`) and make sure \
         `AllowTcpForwarding` is not `no` (it stops socket forwarding too, and sshd keeps the \
         first value of a setting), then reload sshd; `sshd -T -C user={user}` prints what \
         applies."
    );
    let (kind, message) = match (check, &failure) {
        (Some(SocketCheck::Usable), _)
        | (
            None,
            Refusal {
                prohibited: true, ..
            },
        ) => (
            ToolErrorKind::Forbidden,
            format!(
                "SSH works, Docker's socket does not: {target} logged in, then the host refused \
                 to forward {path} ({said}). {sshd}"
            ),
        ),
        (Some(SocketCheck::NoAccess), _) => (
            ToolErrorKind::Forbidden,
            format!(
                "SSH works, Docker's socket does not: {path} is there, but {user} cannot read and \
                 write it. Add {user} to the docker group (`sudo usermod -aG docker {user}`) and \
                 connect again."
            ),
        ),
        (Some(SocketCheck::Missing), _) => (
            ToolErrorKind::Connect,
            format!(
                "SSH works, Docker's socket does not: there is no socket at {path} on the host. \
                 Check that Docker runs and that the socket path is right (rootless Docker: \
                 /run/user/<uid>/docker.sock)."
            ),
        ),
        (None, _) => (
            ToolErrorKind::Connect,
            format!(
                "SSH works, Docker's socket does not: {target} logged in, then the host did not \
                 open {path} ({said}). Check that Docker runs and that the socket path is right \
                 (rootless Docker: /run/user/<uid>/docker.sock), that {user} can read it (member \
                 of the docker group), and that sshd forwards sockets. {sshd}"
            ),
        ),
    };
    ToolError::new(kind, TOOL, message).with_remote(remote)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::ChannelOpenFailure;

    fn refusal(failure: ChannelOpenFailure) -> Refusal {
        Refusal {
            prohibited: matches!(failure, ChannelOpenFailure::AdministrativelyProhibited),
            code: failure.code(),
            description: failure.description().to_owned(),
        }
    }

    #[test]
    fn a_refused_socket_says_what_the_check_found() {
        let refused = |failure, check| {
            socket_refused("deploy@10.0.0.1:22", "/var/run/docker.sock", failure, check)
        };
        let err = refused(
            refusal(ChannelOpenFailure::ConnectFailed),
            Some(SocketCheck::Usable),
        );
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        assert!(err.message.contains("AllowStreamLocalForwarding"));
        assert!(err.message.contains("AllowTcpForwarding"));
        assert!(err.message.contains("sshd -T -C user=deploy"));
        let err = refused(
            refusal(ChannelOpenFailure::ConnectFailed),
            Some(SocketCheck::NoAccess),
        );
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        assert!(err.message.contains("usermod -aG docker deploy"));
        let err = refused(
            refusal(ChannelOpenFailure::ConnectFailed),
            Some(SocketCheck::Missing),
        );
        assert_eq!(err.kind, ToolErrorKind::Connect);
        assert!(err.message.contains("no socket at /var/run/docker.sock"));
        let err = refused(
            refusal(ChannelOpenFailure::AdministrativelyProhibited),
            None,
        );
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        let err = refused(refusal(ChannelOpenFailure::ConnectFailed), None);
        assert_eq!(err.kind, ToolErrorKind::Connect);
        assert!(err.message.contains("docker group") && err.message.contains("AllowTcpForwarding"));
        assert_eq!(err.remote.unwrap().code, "2");
    }

    #[test]
    fn the_socket_check_quotes_the_path() {
        assert_eq!(shell_quote("/a b/it's.sock"), "'/a b/it'\\''s.sock'");
        let command = check_command("/x;rm -rf /");
        assert!(command.contains("test -S '/x;rm -rf /'"), "{command}");
        assert_eq!(parse_check(b"usable\n"), Some(SocketCheck::Usable));
        assert_eq!(parse_check(b"Welcome!\nusable\n"), None);
    }
}
