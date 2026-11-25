//! The SSH side of the Docker tool (Mightyconsole spec §10.2, §10.3): one russh session per live
//! handle, the host key checked in the handshake against the one the profile trusts, then one
//! `direct-streamlocal@openssh.com` channel to the Docker socket per API request.
//!
//! **Nothing reaches an untrusted host.** russh calls `Client::check_server_key` during the key
//! exchange, before any authentication message. A profile that trusts no key, or trusts another
//! one, gets `false` there, so the handshake stops and no password, key signature or agent
//! request is sent; the connect fails with `HostKey` and the key the host presented, which the UI
//! shows for the person to compare and trust. There is no "connect once anyway".

use std::borrow::Cow;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client::{self, AuthResult, DisconnectReason, Handle};
use russh::keys::{
    Algorithm, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate, decode_secret_key,
};
use russh::{ChannelMsg, ChannelOpenFailure, ChannelStream, Disconnect, MethodKind};
use tokio_util::sync::CancellationToken;

use super::TOOL;
use crate::core::{
    HostKeyDetails, HostKeyFingerprint, HostKeyState, RemoteError, ToolError, ToolErrorKind,
};

/// How long the TCP connect, the SSH handshake and the login may take together.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// How long opening one channel to the socket may take.
pub const CHANNEL_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the check of a refused socket may take.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(5);

/// Keepalives the host may leave unanswered before the session counts as lost.
const KEEPALIVE_MAX: usize = 3;

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
    /// The key the profile trusts; `None` on first use.
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
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// OpenSSH's fingerprint of a public key: `SHA256:` and the unpadded base64 digest.
pub fn fingerprint(key: &PublicKey) -> HostKeyFingerprint {
    HostKeyFingerprint {
        algorithm: key.algorithm().as_str().to_owned(),
        fingerprint_sha256: key.fingerprint(HashAlg::Sha256).to_string(),
    }
}

/// The key family of a host key algorithm: RSA's signature variants are one key type.
fn key_family(algorithm: &Algorithm) -> &str {
    match algorithm {
        Algorithm::Rsa { .. } => "ssh-rsa",
        other => other.as_str(),
    }
}

/// The client's host key preferences with the trusted key's type first, so a host holding
/// several keys presents the one the profile knows instead of a "changed" one.
fn prefer_trusted(preferred: &[Algorithm], trusted: Option<&HostKeyFingerprint>) -> Vec<Algorithm> {
    let mut algorithms = preferred.to_vec();
    if let Some(trusted) = trusted {
        // A stable sort keeps the library's order inside each group.
        algorithms.sort_by_key(|a| key_family(a) != trusted.algorithm);
    }
    algorithms
}

/// russh's callbacks for one session: the host key check and the end of the session.
struct Client {
    trusted: Option<HostKeyFingerprint>,
    /// The key the host presented, for the `HostKey` error.
    presented: Arc<Mutex<Option<HostKeyFingerprint>>>,
    lost: CancellationToken,
    lost_reason: Arc<Mutex<Option<String>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let presented = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => fingerprint(key),
            // A host certificate: the host's own key inside it is what the profile trusts.
            PublicKeyOrCertificate::Certificate(cert) => {
                fingerprint(&PublicKey::from(cert.public_key().clone()))
            }
        };
        let trusted = self.trusted.as_ref() == Some(&presented);
        *lock(&self.presented) = Some(presented);
        Ok(trusted)
    }

    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        let text = match &reason {
            DisconnectReason::ReceivedDisconnect(info) if info.message.is_empty() => {
                "the host closed the SSH connection".to_owned()
            }
            DisconnectReason::ReceivedDisconnect(info) => {
                format!("the host closed the SSH connection: {}", info.message)
            }
            DisconnectReason::Error(e) => format!("the SSH connection failed: {e}"),
        };
        lock(&self.lost_reason).get_or_insert(text);
        self.lost.cancel();
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// A logged-in SSH session to a Docker host.
pub struct SshSession {
    handle: Handle<Client>,
    target: String,
    /// The host key the session was opened with (the trusted one).
    pub host_key: HostKeyFingerprint,
    lost: CancellationToken,
    lost_reason: Arc<Mutex<Option<String>>>,
}

impl SshSession {
    /// Connects, checks the host key and logs in (spec §10.2). Errors: `Connect` (unreachable,
    /// timed out, the handshake failed), `HostKey` (unknown or changed), `Auth` (rejected),
    /// `Invalid` (a private key that does not parse, a wrong passphrase, no ssh-agent).
    pub async fn connect(target: SshTarget) -> Result<SshSession, ToolError> {
        let display = target.display();
        tokio::time::timeout(CONNECT_TIMEOUT, Self::open(target))
            .await
            .unwrap_or_else(|_| {
                Err(ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!(
                        "{display} did not answer within {} s",
                        CONNECT_TIMEOUT.as_secs()
                    ),
                ))
            })
    }

    async fn open(target: SshTarget) -> Result<SshSession, ToolError> {
        let address = target.address();
        let display = target.display();
        // Parse the key before opening anything, so a bad key never costs a connection.
        let key = match &target.credentials {
            Credentials::PrivateKey { text, passphrase } => {
                Some(parse_private_key(text, passphrase.as_deref())?)
            }
            _ => None,
        };
        // Through the server's outbound policy (TSK-141): the address connected to is checked.
        let tcp = crate::core::outbound::connect_tcp(TOOL, &target.host, target.port, None).await?;

        let mut config = client::Config {
            keepalive_interval: target.keepalive,
            keepalive_max: KEEPALIVE_MAX,
            inactivity_timeout: None,
            ..client::Config::default()
        };
        let algorithms = prefer_trusted(&config.preferred.key, target.trusted.as_ref());
        config.preferred.key = Cow::Owned(algorithms);

        let presented = Arc::new(Mutex::new(None));
        let lost = CancellationToken::new();
        let lost_reason = Arc::new(Mutex::new(None));
        let client = Client {
            trusted: target.trusted.clone(),
            presented: Arc::clone(&presented),
            lost: lost.clone(),
            lost_reason: Arc::clone(&lost_reason),
        };
        let handshake = client::connect_stream(Arc::new(config), tcp, client).await;
        let seen = lock(&presented).clone();
        let mut handle = match handshake {
            Ok(handle) => handle,
            Err(e) => {
                return Err(match seen {
                    Some(seen) if target.trusted.as_ref() != Some(&seen) => {
                        host_key_error(&target, seen)
                    }
                    _ => ToolError::new(
                        ToolErrorKind::Connect,
                        TOOL,
                        format!("the SSH handshake with {address} failed: {e}"),
                    ),
                });
            }
        };
        let host_key = seen.ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("{address} finished the handshake without a host key"),
            )
        })?;

        let result = login(&mut handle, &target, key).await?;
        if let AuthResult::Failure {
            remaining_methods,
            partial_success,
        } = result
        {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            let methods: Vec<&str> = remaining_methods.iter().map(method_name).collect();
            let mut message = format!("{display} rejected the {}", what(&target.credentials));
            if partial_success {
                message.push_str("; the host asks for a second method, which is not supported");
            } else if !methods.is_empty() {
                message.push_str(&format!(" (the host accepts: {})", methods.join(", ")));
            }
            return Err(ToolError::new(ToolErrorKind::Auth, TOOL, message));
        }
        Ok(SshSession {
            handle,
            target: display,
            host_key,
            lost,
            lost_reason,
        })
    }

    /// Opens a channel to the Unix socket `path` on the host. A host that refuses streamlocal
    /// forwarding, or cannot open the socket, gets the explained error of spec §10.3.
    pub async fn open_socket(&self, path: &str) -> Result<ChannelStream<client::Msg>, ToolError> {
        if self.lost.is_cancelled() {
            return Err(self.lost_error());
        }
        let open = self.handle.channel_open_direct_streamlocal(path);
        let channel = match tokio::time::timeout(CHANNEL_TIMEOUT, open).await {
            Err(_) => {
                return Err(ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!(
                        "{} did not open {path} within {} s",
                        self.target,
                        CHANNEL_TIMEOUT.as_secs()
                    ),
                ));
            }
            Ok(Err(russh::Error::ChannelOpenFailure(failure))) => {
                let check = self.check_socket(path).await;
                return Err(socket_refused(&self.target, path, failure, check));
            }
            Ok(Err(_)) if self.lost.is_cancelled() => return Err(self.lost_error()),
            Ok(Err(e)) => {
                return Err(ToolError::new(
                    ToolErrorKind::Connect,
                    TOOL,
                    format!("opening {path} on {} failed: {e}", self.target),
                ));
            }
            Ok(Ok(channel)) => channel,
        };
        Ok(channel.into_stream())
    }

    /// After a refused socket channel: runs a read-only `test` of the socket on the host (an
    /// exec channel, at most [`CHECK_TIMEOUT`]). `None` when the host does not allow commands or
    /// answers something else (a login shell that is not POSIX, a forced command).
    async fn check_socket(&self, path: &str) -> Option<SocketCheck> {
        let check = async {
            let mut channel = self.handle.channel_open_session().await.ok()?;
            channel.exec(true, check_command(path)).await.ok()?;
            let mut output = Vec::new();
            while let Some(message) = channel.wait().await {
                match message {
                    ChannelMsg::Data { data } => {
                        output.extend_from_slice(&data);
                        if output.len() > 1024 {
                            return None;
                        }
                    }
                    ChannelMsg::Close => break,
                    ChannelMsg::Failure => return None,
                    _ => {}
                }
            }
            parse_check(&output)
        };
        tokio::time::timeout(CHECK_TIMEOUT, check)
            .await
            .ok()
            .flatten()
    }

    /// Fires when the SSH session ended by itself (the host closed it, keepalives went
    /// unanswered).
    pub fn lost(&self) -> CancellationToken {
        self.lost.clone()
    }

    /// Why the session ended, once [`SshSession::lost`] fired.
    pub fn lost_reason(&self) -> String {
        lock(&self.lost_reason)
            .clone()
            .unwrap_or_else(|| "the SSH connection closed".to_owned())
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
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

fn what(credentials: &Credentials) -> &'static str {
    match credentials {
        Credentials::PrivateKey { .. } => "private key",
        Credentials::Password(_) => "password",
        Credentials::Agent => "keys of the ssh-agent",
    }
}

fn method_name(method: &MethodKind) -> &'static str {
    method.into()
}

fn host_key_error(target: &SshTarget, presented: HostKeyFingerprint) -> ToolError {
    let address = target.address();
    match &target.trusted {
        None => ToolError::host_key(
            TOOL,
            format!(
                "{address} is not trusted yet: compare its key {} {} and trust it",
                presented.algorithm, presented.fingerprint_sha256
            ),
            HostKeyDetails {
                state: HostKeyState::Unknown,
                algorithm: presented.algorithm,
                fingerprint_sha256: presented.fingerprint_sha256,
                expected: None,
            },
        ),
        Some(expected) => ToolError::host_key(
            TOOL,
            format!(
                "the host key of {address} changed: it presented {} {}, the profile trusts {} {}. \
                 Nothing was sent to it",
                presented.algorithm,
                presented.fingerprint_sha256,
                expected.algorithm,
                expected.fingerprint_sha256
            ),
            HostKeyDetails {
                state: HostKeyState::Changed,
                algorithm: presented.algorithm,
                fingerprint_sha256: presented.fingerprint_sha256,
                expected: Some(expected.clone()),
            },
        ),
    }
}

/// Decodes the profile's private key; the errors name the field to fix and never the key.
fn parse_private_key(
    text: &str,
    passphrase: Option<&str>,
) -> Result<russh::keys::PrivateKey, ToolError> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if text.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "privateKey",
            "paste the private key (OpenSSH or PEM text) or choose another method",
        ));
    }
    match decode_secret_key(text, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => Err(ToolError::invalid(
            TOOL,
            "passphrase",
            "the key is encrypted: enter its passphrase",
        )),
        Err(e) => {
            // With a passphrase: a key that is encrypted without one too means the passphrase
            // is wrong; anything else is the key's text.
            if passphrase.is_some()
                && matches!(
                    decode_secret_key(text, None),
                    Err(russh::keys::Error::KeyIsEncrypted)
                )
            {
                return Err(ToolError::invalid(
                    TOOL,
                    "passphrase",
                    "the passphrase does not open this key",
                ));
            }
            Err(ToolError::invalid(
                TOOL,
                "privateKey",
                format!("not a private key the server can read (OpenSSH or PEM): {e}"),
            ))
        }
    }
}

/// Logs in with the profile's method.
async fn login(
    handle: &mut Handle<Client>,
    target: &SshTarget,
    key: Option<russh::keys::PrivateKey>,
) -> Result<AuthResult, ToolError> {
    let user = target.username.clone();
    let failed = |e: russh::Error| {
        ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("logging in to {} failed: {e}", target.display()),
        )
    };
    match &target.credentials {
        Credentials::PrivateKey { .. } => {
            let key = key.expect("parsed before connecting");
            let hash = if key.algorithm().is_rsa() {
                handle
                    .best_supported_rsa_hash()
                    .await
                    .map_err(failed)?
                    .flatten()
            } else {
                None
            };
            handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(failed)
        }
        Credentials::Password(password) => handle
            .authenticate_password(user, password.clone())
            .await
            .map_err(failed),
        Credentials::Agent => agent_login(handle, target).await,
    }
}

#[cfg(unix)]
async fn agent_login(
    handle: &mut Handle<Client>,
    target: &SshTarget,
) -> Result<AuthResult, ToolError> {
    use russh::keys::agent::AgentIdentity;
    use russh::keys::agent::client::AgentClient;

    let no_agent = |detail: String| {
        ToolError::invalid(
            TOOL,
            "auth",
            format!("no ssh-agent for mightyconsole-server: {detail}"),
        )
    };
    let mut agent = match AgentClient::connect_env().await {
        Ok(agent) => agent,
        Err(russh::keys::Error::EnvVar(_)) => {
            return Err(no_agent(
                "SSH_AUTH_SOCK is not set for the user running the server".into(),
            ));
        }
        Err(e) => return Err(no_agent(e.to_string())),
    };
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| no_agent(format!("listing its keys failed: {e}")))?;
    let keys: Vec<PublicKey> = identities
        .into_iter()
        .filter_map(|identity| match identity {
            AgentIdentity::PublicKey { key, .. } => Some(key),
            // Certificates would need the host's CA; plain keys only in v0.1.
            _ => None,
        })
        .collect();
    if keys.is_empty() {
        return Err(no_agent("the agent holds no keys (ssh-add one)".into()));
    }
    let mut last = None;
    for key in keys {
        let hash = if key.algorithm().is_rsa() {
            handle
                .best_supported_rsa_hash()
                .await
                .ok()
                .flatten()
                .flatten()
        } else {
            None
        };
        match handle
            .authenticate_publickey_with(target.username.clone(), key, hash, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(AuthResult::Success),
            Ok(failure) => last = Some(failure),
            Err(e) => {
                // The agent declined or failed to sign; try the next key.
                last.get_or_insert(AuthResult::Failure {
                    remaining_methods: russh::MethodSet::empty(),
                    partial_success: false,
                });
                let _ = e;
            }
        }
    }
    Ok(last.expect("at least one key was tried"))
}

#[cfg(not(unix))]
async fn agent_login(
    _handle: &mut Handle<Client>,
    _target: &SshTarget,
) -> Result<AuthResult, ToolError> {
    Err(ToolError::invalid(
        TOOL,
        "auth",
        "ssh-agent is supported on Linux and macOS only; use a private key",
    ))
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
    failure: ChannelOpenFailure,
    check: Option<SocketCheck>,
) -> ToolError {
    let user = target.split('@').next().unwrap_or(target);
    let remote = RemoteError {
        code: failure.code().to_string(),
        name: Some(failure.description().to_owned()),
        detail: check.map(|c| format!("socket check: {c:?}")),
    };
    let said = failure.description().to_lowercase();
    let sshd = format!(
        "In the host's sshd_config set `AllowStreamLocalForwarding yes` (or `local`) and make sure \
         `AllowTcpForwarding` is not `no` (it stops socket forwarding too, and sshd keeps the \
         first value of a setting), then reload sshd; `sshd -T -C user={user}` prints what \
         applies."
    );
    let (kind, message) = match (check, &failure) {
        (Some(SocketCheck::Usable), _) | (None, ChannelOpenFailure::AdministrativelyProhibited) => {
            (
                ToolErrorKind::Forbidden,
                format!(
                    "SSH works, Docker's socket does not: {target} logged in, then the host refused \
                 to forward {path} ({said}). {sshd}"
                ),
            )
        }
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

    fn fp(algorithm: &str) -> HostKeyFingerprint {
        HostKeyFingerprint {
            algorithm: algorithm.into(),
            fingerprint_sha256: "SHA256:x".into(),
        }
    }

    #[test]
    fn the_trusted_key_type_comes_first() {
        let preferred = client::Config::default().preferred.key.to_vec();
        let ordered = prefer_trusted(&preferred, Some(&fp("ecdsa-sha2-nistp256")));
        assert_eq!(ordered[0].as_str(), "ecdsa-sha2-nistp256");
        assert_eq!(ordered.len(), preferred.len());
        let rsa = prefer_trusted(&preferred, Some(&fp("ssh-rsa")));
        assert!(matches!(rsa[0], Algorithm::Rsa { .. }));
        assert_eq!(prefer_trusted(&preferred, None), preferred);
    }

    #[test]
    fn fingerprints_read_as_ssh_keygen_prints_them() {
        // The public half of RFC 8032's first Ed25519 test vector.
        let key = russh::keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAINdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea",
        )
        .unwrap();
        let fp = fingerprint(&key);
        assert_eq!(fp.algorithm, "ssh-ed25519");
        assert!(fp.fingerprint_sha256.starts_with("SHA256:"));
        assert!(!fp.fingerprint_sha256.ends_with('='));
        assert_eq!(fp.fingerprint_sha256.len(), "SHA256:".len() + 43);
    }

    #[test]
    fn key_errors_name_the_field_and_not_the_key() {
        let err = parse_private_key("", None).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("privateKey"));
        let err = parse_private_key("not a key at all", Some("pw")).unwrap_err();
        assert_eq!(err.field.as_deref(), Some("privateKey"));
        assert!(!err.message.contains("not a key at all"));
    }

    #[test]
    fn a_refused_socket_says_what_the_check_found() {
        let refused = |failure, check| {
            socket_refused("deploy@10.0.0.1:22", "/var/run/docker.sock", failure, check)
        };
        let err = refused(ChannelOpenFailure::ConnectFailed, Some(SocketCheck::Usable));
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        assert!(err.message.contains("AllowStreamLocalForwarding"));
        assert!(err.message.contains("AllowTcpForwarding"));
        assert!(err.message.contains("sshd -T -C user=deploy"));
        let err = refused(
            ChannelOpenFailure::ConnectFailed,
            Some(SocketCheck::NoAccess),
        );
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        assert!(err.message.contains("usermod -aG docker deploy"));
        let err = refused(
            ChannelOpenFailure::ConnectFailed,
            Some(SocketCheck::Missing),
        );
        assert_eq!(err.kind, ToolErrorKind::Connect);
        assert!(err.message.contains("no socket at /var/run/docker.sock"));
        let err = refused(ChannelOpenFailure::AdministrativelyProhibited, None);
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        let err = refused(ChannelOpenFailure::ConnectFailed, None);
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
