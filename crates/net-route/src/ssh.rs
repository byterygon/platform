//! SSH (DOC-23 4.3): a session to an SSH host over any stream, the host key checked in the
//! handshake, `direct-tcpip` channels for the `ssh` hop, and the `direct-streamlocal` channels
//! and short commands Docker's SSH transport needs. Moved from Mightyconsole's
//! `tools/docker/ssh.rs` (our own code, relicensed MIT OR Apache-2.0 as DOC-23 4.3 allows).
//!
//! **Nothing reaches an untrusted host.** russh calls `check_server_key` during the key exchange,
//! before any authentication message. A host whose key the [`HostKeyCheck`] does not trust gets
//! `false` there, the handshake stops, and no password, key signature or agent request is sent;
//! the error is `HostKey` with the key presented and the SSH host it belongs to. There is no
//! "connect once anyway".

use std::borrow::Cow;
use std::collections::VecDeque;
use std::fmt;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};
use std::time::Duration;

use bytes::Bytes;
use russh::client::{self, AuthResult, DisconnectReason, Handle};
use russh::keys::{
    Algorithm, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
    decode_secret_key,
};
use russh::{
    Channel, ChannelMsg, ChannelOpenFailure, ChannelReadHalf, ChannelWriteHalf, Disconnect,
    MethodKind,
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_util::sync::CancellationToken;

use crate::error::{
    HopRef, HostKeyFingerprint, HostKeyProblem, HostKeyState, RouteError, RouteErrorKind,
};
use crate::name::format_address;
use crate::route::Secret;
use crate::{BoxStream, Dialer};

/// How long the SSH handshake and login may take (DOC-23 5, "Timeouts").
pub const SSH_LOGIN_CAP: Duration = Duration::from_secs(20);

/// The most of a command's stderr kept for its error message.
pub(crate) const STDERR_TAIL: usize = 8 * 1024;

/// `: <stderr>` for a message, the last line or two of it, printable only.
pub(crate) fn said(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text: String = text
        .trim()
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let text = text.trim();
    if text.is_empty() {
        String::new()
    } else {
        let start = text.len().saturating_sub(400);
        let start = (start..=text.len())
            .find(|i| text.is_char_boundary(*i))
            .unwrap_or(0);
        format!(": {}", &text[start..])
    }
}

/// Keepalives the host may leave unanswered before the session counts as lost.
const KEEPALIVE_MAX: usize = 3;

/// An SSH host as a hop or a transport receives it: resolved values (DOC-23 (ab)).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshHop {
    /// The SSH host's name in the caller's store, for the trust dialog ("Trust saves the key in
    /// the SSH host"); may be empty.
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    /// The key the SSH host trusts; `None` until the first Trust.
    pub trusted: Option<HostKeyFingerprint>,
    /// Keepalive interval; `None` sends none.
    pub keepalive: Option<Duration>,
}

/// How the client logs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SshAuth {
    /// An OpenSSH or PEM private key, with its passphrase when it is encrypted.
    PrivateKey {
        key: Secret,
        passphrase: Option<Secret>,
    },
    Password(Secret),
    /// The keys of the ssh-agent at `SSH_AUTH_SOCK` (Linux and macOS).
    Agent,
}

impl SshHop {
    /// `user@host:port`.
    pub fn display(&self) -> String {
        format!("{}@{}", self.user, format_address(&self.host, self.port))
    }

    /// The SSH host as messages name it: its name and address, or the address alone.
    fn who(&self) -> String {
        let address = format_address(&self.host, self.port);
        if self.name.is_empty() || self.name == address || self.name == self.host {
            address
        } else {
            format!("SSH host {} ({address})", self.name)
        }
    }

    pub(crate) fn validate(&self) -> Result<(), (Option<&'static str>, String)> {
        if self.user.is_empty() || self.user.chars().any(char::is_control) {
            return Err((Some("username"), "enter the user to log in as".into()));
        }
        match &self.auth {
            SshAuth::Password(p) if p.expose().is_empty() => {
                Err((Some("password"), "enter the password".into()))
            }
            _ => Ok(()),
        }
    }

    /// The private key, decoded; `None` for the other methods. The errors name the field to fix
    /// and never the key.
    pub(crate) fn decode_key(&self) -> Result<Option<Arc<PrivateKey>>, RouteError> {
        let SshAuth::PrivateKey { key, passphrase } = &self.auth else {
            return Ok(None);
        };
        parse_private_key(key.expose(), passphrase.as_ref().map(Secret::expose))
            .map(|k| Some(Arc::new(k)))
    }
}

/// An SSH command hop (DOC-23 4.3b): logs into an SSH host and runs `command` there; the
/// command's stdin and stdout are the stream to the next address, as in `ssh host nc {host}
/// {port}`. For a host that forbids port forwarding but allows commands. Only `{host}` and
/// `{port}` are replaced ([`crate::expand_placeholders`]); the host's login shell reads the line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshCommandHop {
    pub ssh: SshHop,
    pub command: String,
}

impl SshCommandHop {
    pub(crate) fn validate(&self) -> Result<(), (Option<&'static str>, String)> {
        self.ssh.validate()?;
        if self.command.trim().is_empty() {
            return Err((
                Some("command"),
                "enter the command to run on the SSH host, like `nc {host} {port}`".into(),
            ));
        }
        if self.command.chars().any(char::is_control) {
            return Err((
                Some("command"),
                "the command is one line, without control characters".into(),
            ));
        }
        Ok(())
    }
}

/// What a [`HostKeyCheck`] is asked for one SSH hop.
#[derive(Debug)]
pub struct HostKeyQuery<'a> {
    /// The hop (or, for a transport, the SSH host as the last node).
    pub hop: &'a HopRef,
    /// The SSH host's name ([`SshHop::name`]).
    pub ssh_host: &'a str,
    pub presented: &'a HostKeyFingerprint,
    pub trusted: Option<&'a HostKeyFingerprint>,
}

/// Decides whether a presented host key is trusted. The default, [`TrustedKey`], trusts exactly
/// the key the SSH host holds.
pub trait HostKeyCheck: Send + Sync {
    fn trusts(&self, query: &HostKeyQuery<'_>) -> bool;
}

/// Trusts the presented key when it is the one the hop carries.
#[derive(Debug, Clone, Copy, Default)]
pub struct TrustedKey;

impl HostKeyCheck for TrustedKey {
    fn trusts(&self, query: &HostKeyQuery<'_>) -> bool {
        query.trusted == Some(query.presented)
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
/// several keys presents the one the SSH host knows instead of a "changed" one.
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
    check: Arc<dyn HostKeyCheck>,
    hop: HopRef,
    name: String,
    trusted: Option<HostKeyFingerprint>,
    /// The key the host presented and the verdict, for the `HostKey` error.
    presented: Arc<Mutex<Option<(HostKeyFingerprint, bool)>>>,
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
            // A host certificate: the host's own key inside it is what the SSH host trusts.
            PublicKeyOrCertificate::Certificate(cert) => {
                fingerprint(&PublicKey::from(cert.public_key().clone()))
            }
        };
        let trusted = self.check.trusts(&HostKeyQuery {
            hop: &self.hop,
            ssh_host: &self.name,
            presented: &presented,
            trusted: self.trusted.as_ref(),
        });
        *lock(&self.presented) = Some((presented, trusted));
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

/// A logged-in SSH session. Streams opened on it keep it alive; it ends when the last stream and
/// the last handle to it are gone, or when the host ends it ([`SshSession::lost`]).
pub struct SshSession {
    handle: Handle<Client>,
    display: String,
    who: String,
    host_key: HostKeyFingerprint,
    lost: CancellationToken,
    lost_reason: Arc<Mutex<Option<String>>>,
}

impl fmt::Debug for SshSession {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SshSession")
            .field("host", &self.display)
            .field("lost", &self.lost.is_cancelled())
            .finish()
    }
}

/// Why a channel did not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    /// The host refused it: `prohibited` for sshd's own settings (`AllowTcpForwarding`,
    /// `PermitOpen`, `AllowStreamLocalForwarding`), otherwise it could not reach the address.
    Refused {
        prohibited: bool,
        code: u32,
        description: String,
    },
    /// The session had ended.
    Lost(String),
    Failed(String),
}

impl SshSession {
    /// Dials the SSH host's address with `dialer` (directly or through its route), checks the
    /// host key with [`TrustedKey`] and logs in, within [`SSH_LOGIN_CAP`] for the SSH part. A
    /// private key is decoded before anything is contacted. Errors name the SSH host as the node
    /// after the route's hops.
    pub async fn connect(dialer: &Dialer, hop: &SshHop) -> Result<SshSession, RouteError> {
        let at = HopRef {
            index: dialer.hop_count(),
            kind: "ssh",
            label: format_address(&hop.host, hop.port),
        };
        hop.validate()
            .map_err(|(field, message)| invalid(&at, field, message))?;
        let key = hop.decode_key().map_err(|e| e.with_hop(at.clone()))?;
        let stream = dialer.dial(&hop.host, hop.port).await?;
        let login = SshSession::login(stream, hop, key, &at, Arc::new(TrustedKey));
        match tokio::time::timeout(SSH_LOGIN_CAP, login).await {
            Ok(result) => result,
            Err(_) => Err(RouteError::new(
                Some(at),
                RouteErrorKind::Timeout,
                format!(
                    "{} did not finish the SSH login within {} s",
                    hop.who(),
                    SSH_LOGIN_CAP.as_secs()
                ),
            )),
        }
    }

    /// The SSH handshake and login over `stream`.
    pub(crate) async fn login(
        stream: BoxStream,
        hop: &SshHop,
        key: Option<Arc<PrivateKey>>,
        at: &HopRef,
        check: Arc<dyn HostKeyCheck>,
    ) -> Result<SshSession, RouteError> {
        let who = hop.who();
        let mut config = client::Config {
            keepalive_interval: hop.keepalive,
            keepalive_max: KEEPALIVE_MAX,
            inactivity_timeout: None,
            ..client::Config::default()
        };
        let algorithms = prefer_trusted(&config.preferred.key, hop.trusted.as_ref());
        config.preferred.key = Cow::Owned(algorithms);

        let presented = Arc::new(Mutex::new(None));
        let lost = CancellationToken::new();
        let lost_reason = Arc::new(Mutex::new(None));
        let client = Client {
            check,
            hop: at.clone(),
            name: hop.name.clone(),
            trusted: hop.trusted.clone(),
            presented: Arc::clone(&presented),
            lost: lost.clone(),
            lost_reason: Arc::clone(&lost_reason),
        };
        let handshake = client::connect_stream(Arc::new(config), stream, client).await;
        let seen = lock(&presented).clone();
        let mut handle = match handshake {
            Ok(handle) => handle,
            Err(e) => {
                return Err(match seen {
                    Some((seen, false)) => host_key_error(at, hop, seen),
                    _ => RouteError::new(
                        Some(at.clone()),
                        RouteErrorKind::Connect,
                        format!("the SSH handshake with {who} failed: {e}"),
                    ),
                });
            }
        };
        let host_key = seen.map(|(key, _)| key).ok_or_else(|| {
            RouteError::new(
                Some(at.clone()),
                RouteErrorKind::Connect,
                format!("{who} finished the handshake without a host key"),
            )
        })?;

        let result = authenticate(&mut handle, hop, key, at).await?;
        if let AuthResult::Failure {
            remaining_methods,
            partial_success,
        } = result
        {
            let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
            let methods: Vec<&str> = remaining_methods.iter().map(method_name).collect();
            let mut message = format!("{} rejected the {}", hop.display(), what(&hop.auth));
            if partial_success {
                message.push_str("; the host asks for a second method, which is not supported");
            } else if !methods.is_empty() {
                message.push_str(&format!(" (the host accepts: {})", methods.join(", ")));
            }
            return Err(RouteError::new(
                Some(at.clone()),
                RouteErrorKind::Auth,
                message,
            ));
        }
        Ok(SshSession {
            handle,
            display: hop.display(),
            who,
            host_key,
            lost,
            lost_reason,
        })
    }

    /// The host key the session was opened with (a trusted one).
    pub fn host_key(&self) -> &HostKeyFingerprint {
        &self.host_key
    }

    /// `user@host:port`.
    pub fn display(&self) -> &str {
        &self.display
    }

    /// A `direct-tcpip` channel to `host:port` as a stream (the `ssh` hop, `ssh -W`). The
    /// stream keeps the session alive.
    pub async fn open_direct_tcpip(
        self: &Arc<Self>,
        host: &str,
        port: u16,
    ) -> Result<BoxStream, OpenError> {
        let opened = self
            .handle
            .channel_open_direct_tcpip(host, u32::from(port), "127.0.0.1", 0)
            .await;
        let channel = self.opened(opened)?;
        Ok(Box::new(SessionStream::new(channel, self)))
    }

    /// A `direct-streamlocal@openssh.com` channel to the Unix socket `path` on the host
    /// (Docker's socket).
    pub async fn open_streamlocal(self: &Arc<Self>, path: &str) -> Result<BoxStream, OpenError> {
        let opened = self.handle.channel_open_direct_streamlocal(path).await;
        let channel = self.opened(opened)?;
        Ok(Box::new(SessionStream::new(channel, self)))
    }

    /// Runs `command` in an exec channel; its stdin and stdout are the stream (the `sshCommand`
    /// hop). A host that refuses the command (a forced command, no shell, `exec` denied) is
    /// `Refused { prohibited: true }`; a command that ends before the host confirms it is
    /// `Failed` with what it wrote to stderr. The stream keeps the session alive.
    pub async fn open_exec(self: &Arc<Self>, command: &str) -> Result<BoxStream, OpenError> {
        let opened = self.handle.channel_open_session().await;
        let mut channel = self.opened(opened)?;
        channel
            .exec(true, command)
            .await
            .map_err(|e| OpenError::Failed(e.to_string()))?;
        let mut early = Vec::new();
        let mut stderr = Vec::new();
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure) => {
                    return Err(OpenError::Refused {
                        prohibited: true,
                        code: 0,
                        description: "the host refused to run the command".into(),
                    });
                }
                Some(ChannelMsg::Data { data }) => early.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    stderr.extend_from_slice(&data);
                    let excess = stderr.len().saturating_sub(STDERR_TAIL);
                    stderr.drain(..excess);
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    return Err(OpenError::Failed(format!(
                        "the command exited with {exit_status}{}",
                        said(&stderr)
                    )));
                }
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => {
                    return Err(OpenError::Failed(format!(
                        "the host closed the command's channel{}",
                        said(&stderr)
                    )));
                }
                Some(_) => {}
            }
        }
        // Confirmed. Watch it briefly, as a local command (DOC-23 4.4): a command that ends at
        // once (a missing `nc`, a host it cannot reach) is the hop's error with its stderr.
        if early.is_empty() {
            let deadline = tokio::time::Instant::now() + crate::command::COMMAND_EARLY_EXIT;
            loop {
                match tokio::time::timeout_at(deadline, channel.wait()).await {
                    Err(_) => break,
                    Ok(Some(ChannelMsg::Data { data })) => {
                        early.extend_from_slice(&data);
                        break;
                    }
                    Ok(Some(ChannelMsg::ExtendedData { data, .. })) => {
                        stderr.extend_from_slice(&data);
                        let excess = stderr.len().saturating_sub(STDERR_TAIL);
                        stderr.drain(..excess);
                    }
                    Ok(Some(ChannelMsg::ExitStatus { exit_status })) => {
                        // Its stderr may still be on the way.
                        while let Ok(Some(ChannelMsg::ExtendedData { data, .. })) =
                            tokio::time::timeout(
                                std::time::Duration::from_millis(100),
                                channel.wait(),
                            )
                            .await
                        {
                            stderr.extend_from_slice(&data);
                        }
                        return Err(OpenError::Failed(format!(
                            "the command exited with {exit_status}{}",
                            said(&stderr)
                        )));
                    }
                    Ok(Some(ChannelMsg::Eof | ChannelMsg::Close) | None) => {
                        return Err(OpenError::Failed(format!(
                            "the command ended at once{}",
                            said(&stderr)
                        )));
                    }
                    Ok(Some(_)) => {}
                }
            }
        }
        let stream: BoxStream = Box::new(SessionStream::new(channel, self));
        Ok(crate::stream::Prefixed::boxed(early, stream))
    }

    fn opened(
        &self,
        opened: Result<russh::Channel<client::Msg>, russh::Error>,
    ) -> Result<russh::Channel<client::Msg>, OpenError> {
        match opened {
            Ok(channel) => Ok(channel),
            Err(russh::Error::ChannelOpenFailure(failure)) => Err(OpenError::Refused {
                prohibited: matches!(failure, ChannelOpenFailure::AdministrativelyProhibited),
                code: failure.code(),
                description: failure.description().to_owned(),
            }),
            Err(_) if self.lost.is_cancelled() => Err(OpenError::Lost(self.lost_reason())),
            Err(e) => Err(OpenError::Failed(e.to_string())),
        }
    }

    /// Runs `command` in an exec channel and returns its standard output, at most `max_bytes`;
    /// `None` when the host refuses commands, the command fails to start or says more.
    pub async fn exec_output(&self, command: &str, max_bytes: usize) -> Option<Vec<u8>> {
        let mut channel = self.handle.channel_open_session().await.ok()?;
        channel.exec(true, command).await.ok()?;
        let mut output = Vec::new();
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } => {
                    output.extend_from_slice(&data);
                    if output.len() > max_bytes {
                        return None;
                    }
                }
                ChannelMsg::Close => break,
                ChannelMsg::Failure => return None,
                _ => {}
            }
        }
        Some(output)
    }

    /// Fires when the session ended by itself (the host closed it, keepalives went unanswered).
    pub fn lost(&self) -> CancellationToken {
        self.lost.clone()
    }

    pub fn is_lost(&self) -> bool {
        self.lost.is_cancelled() || self.handle.is_closed()
    }

    /// Why the session ended, once [`SshSession::lost`] fired.
    pub fn lost_reason(&self) -> String {
        lock(&self.lost_reason)
            .clone()
            .unwrap_or_else(|| "the SSH connection closed".to_owned())
    }

    /// The SSH host as messages name it.
    pub(crate) fn who(&self) -> &str {
        &self.who
    }

    /// Whether the host still answers: a keepalive that wants a reply, answered within `within`
    /// (TSK-166). A host that does not answer ends the session, which then counts as lost
    /// ([`SshSession::lost`] fires) with that reason.
    pub async fn check_alive(&self, within: Duration) -> bool {
        if self.is_lost() {
            return false;
        }
        let answered = tokio::time::timeout(within, self.handle.send_ping())
            .await
            .is_ok_and(|sent| sent.is_ok());
        if answered && !self.is_lost() {
            return true;
        }
        lock(&self.lost_reason).get_or_insert(format!(
            "{} stopped answering (no reply to a keepalive within {} s)",
            self.who,
            within.as_secs()
        ));
        self.lost.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(1), self.close()).await;
        false
    }

    /// Ends the session now.
    pub async fn close(&self) {
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "en")
            .await;
    }
}

/// How far a channel's reader may fall behind what the host sent before the channel is closed
/// (TSK-166). russh gives the host more window as soon as data arrives, not when it is read, and
/// it hands a channel's data to a short queue that, once full, stops the whole session: every
/// other channel, new channels and keepalives. So each channel's data is moved off russh's queue
/// at once into the stream's own buffer, and a reader this far behind (a paused log view of a
/// chatty container, a browser slower than the host) loses its own channel, never the session.
pub const CHANNEL_BACKLOG: usize = 16 * 1024 * 1024;

/// Why a channel's stream has nothing more to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum End {
    /// The host ended the channel.
    Eof,
    /// The reader fell [`CHANNEL_BACKLOG`] behind; the channel was closed.
    Behind,
}

/// What the host sent on a channel and the stream has not read yet.
#[derive(Default)]
struct Inbox {
    chunks: VecDeque<Bytes>,
    len: usize,
    end: Option<End>,
    waker: Option<Waker>,
}

/// A channel stream that keeps its session alive. Its data is drained from russh by a task of
/// its own (see [`CHANNEL_BACKLOG`]); writes go to the channel as they did.
struct SessionStream {
    tx: Pin<Box<dyn AsyncWrite + Send + Sync>>,
    inbox: Arc<Mutex<Inbox>>,
    write: Arc<ChannelWriteHalf<client::Msg>>,
    drain: tokio::task::JoinHandle<()>,
    _session: Arc<SshSession>,
}

impl SessionStream {
    fn new(channel: Channel<client::Msg>, session: &Arc<SshSession>) -> SessionStream {
        let (read, write) = channel.split();
        let write = Arc::new(write);
        let inbox = Arc::new(Mutex::new(Inbox::default()));
        let drain = tokio::spawn(drain(read, Arc::clone(&inbox), Arc::clone(&write)));
        SessionStream {
            tx: Box::pin(write.make_writer()),
            inbox,
            write,
            drain,
            _session: Arc::clone(session),
        }
    }
}

/// Moves a channel's data from russh's queue into `inbox` as it arrives, so the session never
/// waits for this channel's reader.
async fn drain(
    mut read: ChannelReadHalf,
    inbox: Arc<Mutex<Inbox>>,
    write: Arc<ChannelWriteHalf<client::Msg>>,
) {
    let end = loop {
        match read.wait().await {
            Some(ChannelMsg::Data { data }) => {
                let mut held = lock(&inbox);
                if held.len + data.len() > CHANNEL_BACKLOG {
                    break End::Behind;
                }
                held.len += data.len();
                held.chunks.push_back(data);
                if let Some(waker) = held.waker.take() {
                    waker.wake();
                }
            }
            Some(ChannelMsg::Eof | ChannelMsg::Close) | None => break End::Eof,
            Some(_) => {}
        }
    };
    let waker = {
        let mut held = lock(&inbox);
        held.end = Some(end);
        held.waker.take()
    };
    if let Some(waker) = waker {
        waker.wake();
    }
    if end == End::Behind {
        drop(read);
        let _ = write.close().await;
    }
}

impl AsyncRead for SessionStream {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let mut inbox = lock(&self.inbox);
        if let Some(front) = inbox.chunks.front_mut() {
            let n = front.len().min(buf.remaining());
            buf.put_slice(&front[..n]);
            if n == front.len() {
                inbox.chunks.pop_front();
            } else {
                *front = front.slice(n..);
            }
            inbox.len -= n;
            return Poll::Ready(Ok(()));
        }
        match inbox.end {
            Some(End::Eof) => Poll::Ready(Ok(())),
            Some(End::Behind) => Poll::Ready(Err(std::io::Error::other(format!(
                "this stream was not read for too long (more than {} MiB waiting), so its SSH \
                 channel was closed; the session's other channels go on",
                CHANNEL_BACKLOG / (1024 * 1024)
            )))),
            None => {
                inbox.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl AsyncWrite for SessionStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        self.tx.as_mut().poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.tx.as_mut().poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.tx.as_mut().poll_shutdown(cx)
    }
}

impl Drop for SessionStream {
    fn drop(&mut self) {
        self.drain.abort();
        // Closes the channel, as russh's own stream does when it is dropped.
        let write = Arc::clone(&self.write);
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                let _ = write.close().await;
            });
        }
    }
}

fn invalid(at: &HopRef, field: Option<&'static str>, message: String) -> RouteError {
    match field {
        Some(field) => RouteError::invalid(Some(at.clone()), field, message),
        None => RouteError::new(Some(at.clone()), RouteErrorKind::Invalid, message),
    }
}

fn what(auth: &SshAuth) -> &'static str {
    match auth {
        SshAuth::PrivateKey { .. } => "private key",
        SshAuth::Password(_) => "password",
        SshAuth::Agent => "keys of the ssh-agent",
    }
}

fn method_name(method: &MethodKind) -> &'static str {
    method.into()
}

fn host_key_error(at: &HopRef, hop: &SshHop, presented: HostKeyFingerprint) -> RouteError {
    let who = hop.who();
    let (state, message) = match &hop.trusted {
        None => (
            HostKeyState::Unknown,
            format!(
                "{who} is not trusted yet: compare its key {} {} and trust it",
                presented.algorithm, presented.fingerprint_sha256
            ),
        ),
        Some(expected) => (
            HostKeyState::Changed,
            format!(
                "the host key of {who} changed: it presented {} {}, the SSH host trusts {} {}. \
                 Nothing was sent to it",
                presented.algorithm,
                presented.fingerprint_sha256,
                expected.algorithm,
                expected.fingerprint_sha256
            ),
        ),
    };
    RouteError {
        host_key: Some(Box::new(HostKeyProblem {
            state,
            ssh_host: hop.name.clone(),
            presented,
            expected: hop.trusted.clone(),
        })),
        ..RouteError::new(Some(at.clone()), RouteErrorKind::HostKey, message)
    }
}

/// Decodes a private key; the errors name the field to fix and never the key.
fn parse_private_key(text: &str, passphrase: Option<&str>) -> Result<PrivateKey, RouteError> {
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if text.trim().is_empty() {
        return Err(RouteError::invalid(
            None,
            "privateKey",
            "paste the private key (OpenSSH or PEM text) or choose another method",
        ));
    }
    match decode_secret_key(text, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => {
            Err(RouteError::invalid(
                None,
                "passphrase",
                "the key is encrypted: enter its passphrase",
            ))
        }
        Err(e) => {
            // With a passphrase: a key that is encrypted without one too means the passphrase
            // is wrong; anything else is the key's text.
            if passphrase.is_some()
                && matches!(
                    decode_secret_key(text, None),
                    Err(russh::keys::Error::KeyIsEncrypted)
                )
            {
                return Err(RouteError::invalid(
                    None,
                    "passphrase",
                    "the passphrase does not open this key",
                ));
            }
            Err(RouteError::invalid(
                None,
                "privateKey",
                format!("not a private key this machine can read (OpenSSH or PEM): {e}"),
            ))
        }
    }
}

/// Logs in with the hop's method.
async fn authenticate(
    handle: &mut Handle<Client>,
    hop: &SshHop,
    key: Option<Arc<PrivateKey>>,
    at: &HopRef,
) -> Result<AuthResult, RouteError> {
    let user = hop.user.clone();
    let failed = |e: russh::Error| {
        RouteError::new(
            Some(at.clone()),
            RouteErrorKind::Connect,
            format!("logging in to {} failed: {e}", hop.display()),
        )
    };
    match &hop.auth {
        SshAuth::PrivateKey { .. } => {
            let key = match key {
                Some(key) => key,
                None => hop
                    .decode_key()
                    .map_err(|e| e.with_hop(at.clone()))?
                    .ok_or_else(|| {
                        RouteError::invalid(Some(at.clone()), "privateKey", "no private key")
                    })?,
            };
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
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(key, hash))
                .await
                .map_err(failed)
        }
        SshAuth::Password(password) => handle
            .authenticate_password(user, password.expose().to_owned())
            .await
            .map_err(failed),
        SshAuth::Agent => agent_login(handle, hop, at).await,
    }
}

#[cfg(unix)]
async fn agent_login(
    handle: &mut Handle<Client>,
    hop: &SshHop,
    at: &HopRef,
) -> Result<AuthResult, RouteError> {
    use russh::keys::agent::AgentIdentity;
    use russh::keys::agent::client::AgentClient;

    let no_agent = |detail: String| {
        RouteError::invalid(
            Some(at.clone()),
            "auth",
            format!("no ssh-agent for this process: {detail}"),
        )
    };
    let mut agent = match AgentClient::connect_env().await {
        Ok(agent) => agent,
        Err(russh::keys::Error::EnvVar(_)) => {
            return Err(no_agent(
                "SSH_AUTH_SOCK is not set for the user running it".into(),
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
            // Certificates would need the host's CA; plain keys only.
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
            .authenticate_publickey_with(hop.user.clone(), key, hash, &mut agent)
            .await
        {
            Ok(AuthResult::Success) => return Ok(AuthResult::Success),
            Ok(failure) => last = Some(failure),
            Err(_) => {
                // The agent declined or failed to sign; try the next key.
                last.get_or_insert(AuthResult::Failure {
                    remaining_methods: russh::MethodSet::empty(),
                    partial_success: false,
                });
            }
        }
    }
    Ok(last.expect("at least one key was tried"))
}

#[cfg(not(unix))]
async fn agent_login(
    _handle: &mut Handle<Client>,
    _hop: &SshHop,
    at: &HopRef,
) -> Result<AuthResult, RouteError> {
    Err(RouteError::invalid(
        Some(at.clone()),
        "auth",
        "ssh-agent is supported on Linux and macOS only; use a private key",
    ))
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
        assert_eq!(err.field, Some("privateKey"));
        let err = parse_private_key("not a key at all", Some("pw")).unwrap_err();
        assert_eq!(err.field, Some("privateKey"));
        assert!(!err.message.contains("not a key at all"));
    }
}
