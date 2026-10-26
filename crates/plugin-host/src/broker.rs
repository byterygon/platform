//! Native connection broker (Plugin Host spec §2 "Connection and cancellation", §3).
//!
//! Every driver, native or WASM, opens database connections through the broker, never through a
//! socket of its own. The broker:
//!
//! - opens only targets that have an active [`ConnectionGrant`] matching the calling plugin, the
//!   tenant and every principal in the `on_behalf_of` chain;
//! - resolves DNS names itself on every open, checks each address against the grant's address
//!   policy and connects to the checked address (DNS rebinding);
//! - verifies TLS against the grant's trust roots and server name, either directly after connect
//!   or through `start_tls` on the same handle after in-protocol negotiation, and never falls back
//!   to plaintext;
//! - allows a second "cancel" connection only when the same grant allows it;
//! - audits every open and every `start_tls`, allowed or not;
//! - issues [`Transport`] handles bound to one [`BrokerScope`] (plugin instance + principal), and
//!   closes them when their grant is revoked or expires.
//!
//! Plugin code receives only `BrokerScope` and `Transport`; neither exposes the socket.

use std::fmt;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use rustls::client::ClientConfig;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, RootCertStore, SignatureScheme};
use security_types::{
    Action, AuditDecision, AuditEntry, AuditPrincipal, Digest, Outcome, Principal, PrincipalKind,
    Reason, Risk, TargetRef,
};
use sha2::{Digest as _, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{Mutex, watch};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::encode_digest;
use crate::error_code;
use crate::grant::{
    ConnectionGrant, DriverKind, GrantEntry, GrantStore, Host, Revocable, ServerTrust, TlsMode,
    TlsPolicy, TlsSettings, pinned_ca_store, policy,
};
use crate::net::{Resolver, SystemResolver, canonical};

/// Audit action names and the permission recorded with them.
///
/// NOTE: provisional names (Plugin Host spec, Open question 25). Update together with the grant
/// constants in [`crate::grant`] once the permission catalogue is fixed.
pub const OPEN_ACTION: &str = "plugin-host.broker.open";
pub const OPEN_CANCEL_ACTION: &str = "plugin-host.broker.open-cancel";
pub const START_TLS_ACTION: &str = "plugin-host.broker.start-tls";
pub const BROKER_PERM: &str = "plugin.net.connect";

/// Why a broker call failed. Mirrors the `db-error` variants of the db-driver contract. Denials
/// never say why to the plugin; the reason is in the audit log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrokerError {
    PermissionDenied,
    TlsFailed,
    ConnectionLost,
    Timeout,
    Unsupported(&'static str),
    /// A broker resource limit (open transports per scope) was reached.
    LimitExceeded,
    Internal,
}

impl BrokerError {
    pub fn code(&self) -> &'static str {
        match self {
            BrokerError::PermissionDenied => error_code::PERMISSION_DENIED,
            BrokerError::TlsFailed => error_code::TLS_FAILED,
            BrokerError::ConnectionLost => error_code::CONNECTION_LOST,
            BrokerError::Timeout => error_code::TIMEOUT,
            BrokerError::Unsupported(_) => error_code::UNSUPPORTED,
            BrokerError::LimitExceeded => error_code::LIMIT_EXCEEDED,
            BrokerError::Internal => error_code::INTERNAL,
        }
    }

    fn from_io(e: &io::Error) -> Self {
        match e.kind() {
            io::ErrorKind::TimedOut => BrokerError::Timeout,
            _ => BrokerError::ConnectionLost,
        }
    }
}

impl fmt::Display for BrokerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BrokerError::Unsupported(what) => write!(f, "unsupported: {what}"),
            other => f.write_str(other.code()),
        }
    }
}

impl std::error::Error for BrokerError {}

/// What a transport is for. A cancel connection reaches the same endpoint under the same grant,
/// TLS policy and audit as the data connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Purpose {
    Data,
    Cancel,
}

impl Purpose {
    /// The contract's `purpose` string: `"data"` or `"cancel"`.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "data" => Some(Purpose::Data),
            "cancel" => Some(Purpose::Cancel),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Purpose::Data => "data",
            Purpose::Cancel => "cancel",
        }
    }
}

/// Resource bounds. Defaults are provisional (Plugin Host spec, Open questions).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrokerLimits {
    pub max_transports_per_scope: usize,
    /// Upper bound for one `recv`; larger requests are clamped.
    pub max_recv_bytes: usize,
    pub resolve_timeout: Duration,
    pub connect_timeout: Duration,
    pub tls_handshake_timeout: Duration,
    /// Plaintext bytes (sent plus received) allowed on an in-protocol-upgrade transport before
    /// `start_tls`, enough for the PostgreSQL and MySQL TLS negotiation. Past it the transport is
    /// closed with `TlsFailed`, so a driver cannot keep talking plaintext.
    pub pre_tls_plaintext_bytes: usize,
}

impl Default for BrokerLimits {
    fn default() -> Self {
        Self {
            max_transports_per_scope: 16,
            max_recv_bytes: 256 * 1024,
            resolve_timeout: Duration::from_secs(5),
            connect_timeout: Duration::from_secs(10),
            tls_handshake_timeout: Duration::from_secs(10),
            pre_tls_plaintext_bytes: 512,
        }
    }
}

#[derive(Debug, Clone)]
pub struct BrokerConfig {
    pub limits: BrokerLimits,
    /// CA certificates for grants with [`crate::TrustRoots::Deployment`]. Nothing is loaded
    /// implicitly: with no roots configured, those handshakes fail.
    pub deployment_roots: Arc<RootCertStore>,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            limits: BrokerLimits::default(),
            deployment_roots: Arc::new(RootCertStore::empty()),
        }
    }
}

/// Who is calling the broker: one plugin instance acting for one principal.
#[derive(Debug, Clone)]
pub struct Caller {
    pub plugin_id: String,
    pub plugin_digest: Digest,
    pub driver_kind: DriverKind,
    /// The principal the plugin acts for (a human, or an agent acting for a human). Every
    /// principal in its `on_behalf_of` chain must be eligible for the grant.
    pub principal: Principal,
    pub correlation_id: String,
}

impl Caller {
    /// The audited principal chain: the plugin itself (with its digest) acting for `principal`.
    fn audit_chain(&self) -> Vec<AuditPrincipal> {
        let mut chain = vec![AuditPrincipal {
            kind: PrincipalKind::Plugin,
            id: format!("plugin:{}#sha256:{}", self.plugin_id, self.plugin_digest),
            tenant: self.principal.tenant.clone(),
            session: self.principal.session.clone(),
        }];
        chain.extend(AuditPrincipal::chain_of(&self.principal));
        chain
    }
}

pub struct NativeBroker<R: Resolver = SystemResolver> {
    grants: Arc<GrantStore>,
    resolver: R,
    config: BrokerConfig,
    provider: Arc<CryptoProvider>,
    next_id: AtomicU64,
}

impl<R: Resolver> NativeBroker<R> {
    pub fn new(grants: Arc<GrantStore>, resolver: R, config: BrokerConfig) -> Arc<Self> {
        Arc::new(Self {
            grants,
            resolver,
            config,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
            next_id: AtomicU64::new(1),
        })
    }

    /// A broker view for one plugin instance acting for one principal. Transports opened through
    /// it can only be used through it.
    pub fn scope(self: &Arc<Self>, caller: Caller) -> BrokerScope<R> {
        BrokerScope {
            broker: self.clone(),
            caller,
            id: self.next_id.fetch_add(1, Ordering::Relaxed),
            open: Arc::new(AtomicUsize::new(0)),
        }
    }
}

pub struct BrokerScope<R: Resolver = SystemResolver> {
    broker: Arc<NativeBroker<R>>,
    caller: Caller,
    id: u64,
    open: Arc<AtomicUsize>,
}

/// An open, brokered connection. Opaque: the plugin can only pass it back to the scope that
/// opened it. Dropping it closes the connection.
pub struct Transport {
    scope_id: u64,
    purpose: Purpose,
    peer: SocketAddr,
    entry: Arc<GrantEntry>,
    revoked: watch::Receiver<bool>,
    handle: Arc<Handle>,
    tls: bool,
    plaintext_bytes: usize,
}

impl Transport {
    pub fn purpose(&self) -> Purpose {
        self.purpose
    }

    /// The validated address the connection was made to.
    pub fn peer_addr(&self) -> SocketAddr {
        self.peer
    }

    pub fn is_tls(&self) -> bool {
        self.tls
    }

    pub fn grant(&self) -> &ConnectionGrant {
        &self.entry.grant
    }
}

impl fmt::Debug for Transport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Transport")
            .field("purpose", &self.purpose)
            .field("peer", &self.peer)
            .field("grant", &self.entry.grant.id)
            .field("tls", &self.tls)
            .finish_non_exhaustive()
    }
}

enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
    Closed,
}

impl Stream {
    async fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        match self {
            Stream::Plain(s) => s.write_all(bytes).await,
            Stream::Tls(s) => {
                s.write_all(bytes).await?;
                s.flush().await
            }
            Stream::Closed => Err(io::ErrorKind::NotConnected.into()),
        }
    }

    async fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf).await,
            Stream::Tls(s) => s.read(buf).await,
            Stream::Closed => Err(io::ErrorKind::NotConnected.into()),
        }
    }
}

/// The socket behind a transport, shared with the grant entry so revocation can close it.
struct Handle {
    stream: Mutex<Stream>,
    closed: AtomicBool,
    _slot: Slot,
}

impl Revocable for Handle {
    fn close_now(&self) {
        self.closed.store(true, Ordering::SeqCst);
        // If an operation holds the lock, it sees the revocation and closes the stream itself.
        if let Ok(mut stream) = self.stream.try_lock() {
            *stream = Stream::Closed;
        }
    }
}

/// One of the scope's transport slots; released on drop.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Outcome of an open attempt before it is audited.
struct Denied {
    reason: Reason,
}

enum OpenError {
    Denied(Denied),
    Failed(BrokerError),
}

impl From<BrokerError> for OpenError {
    fn from(e: BrokerError) -> Self {
        OpenError::Failed(e)
    }
}

fn deny(message: &str) -> OpenError {
    OpenError::Denied(Denied {
        reason: policy(message),
    })
}

impl<R: Resolver> BrokerScope<R> {
    pub fn caller(&self) -> &Caller {
        &self.caller
    }

    /// Open a connection to `target_id` for `purpose` (`"data"` or `"cancel"`).
    pub async fn open(&self, target_id: &str, purpose: &str) -> Result<Transport, BrokerError> {
        let started = Instant::now();
        let parsed = Purpose::parse(purpose);
        let entry = self
            .broker
            .grants
            .lookup(&self.caller.principal.tenant, target_id);
        let result = match parsed {
            None => Err(OpenError::Failed(BrokerError::Unsupported("purpose"))),
            Some(purpose) => match &entry {
                None => Err(deny("no active grant for target")),
                Some(entry) => self.open_granted(entry, purpose).await,
            },
        };

        let (decision, outcome) = match &result {
            Ok(_) => (AuditDecision::Allow, Outcome::Success),
            Err(OpenError::Denied(d)) => (
                AuditDecision::Deny {
                    reason: d.reason.clone(),
                },
                error_outcome(&BrokerError::PermissionDenied),
            ),
            Err(OpenError::Failed(e)) => (AuditDecision::Allow, error_outcome(e)),
        };
        let action = match parsed {
            Some(Purpose::Cancel) => OPEN_CANCEL_ACTION,
            _ => OPEN_ACTION,
        };
        let audited = self.audit(
            action,
            target_id,
            encode_digest(
                "byterygon.plugin-host.broker.open.v1",
                &[target_id.as_bytes(), purpose.as_bytes()],
            ),
            decision,
            outcome,
            started,
        );
        match result {
            // A connection that cannot be audited is not handed out.
            Ok(transport) => audited.map(|()| transport),
            Err(OpenError::Denied(_)) => Err(BrokerError::PermissionDenied),
            Err(OpenError::Failed(e)) => Err(e),
        }
    }

    async fn open_granted(
        &self,
        entry: &Arc<GrantEntry>,
        purpose: Purpose,
    ) -> Result<Transport, OpenError> {
        let grant = &entry.grant;
        let caller = &self.caller;
        if entry.is_revoked() {
            return Err(deny("grant revoked"));
        }
        if grant.plugin.plugin_id != caller.plugin_id
            || grant.plugin.digest != caller.plugin_digest
            || grant.plugin.driver_kind != caller.driver_kind
        {
            return Err(deny("plugin does not match the grant"));
        }
        if let Some(reason) = grant.ineligible(&caller.principal) {
            return Err(OpenError::Denied(Denied { reason }));
        }
        if grant.is_expired(self.now()) {
            return Err(deny("grant expired"));
        }
        if purpose == Purpose::Cancel && !grant.allow_cancel_connection {
            return Err(deny("cancel connection not granted"));
        }
        let max = self.broker.config.limits.max_transports_per_scope;
        if self
            .open
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < max).then_some(n + 1)
            })
            .is_err()
        {
            return Err(OpenError::Failed(BrokerError::LimitExceeded));
        }
        let slot = Slot(self.open.clone());

        let mut revoked = entry.revoked();
        let connect = self.connect(grant);
        let (stream, peer, tls) = tokio::select! {
            r = connect => r?,
            e = interrupted(&mut revoked, self.until_expiry(grant)) => return Err(e.into()),
        };

        let handle = Arc::new(Handle {
            stream: Mutex::new(stream),
            closed: AtomicBool::new(false),
            _slot: slot,
        });
        let weak: Weak<dyn Revocable> = Arc::downgrade(&handle) as Weak<dyn Revocable>;
        if !entry.track(weak) {
            return Err(deny("grant revoked"));
        }
        Ok(Transport {
            scope_id: self.id,
            purpose,
            peer,
            entry: entry.clone(),
            revoked,
            handle,
            tls,
            plaintext_bytes: 0,
        })
    }

    /// Resolve, check addresses, connect to a checked address, and run direct TLS if required.
    async fn connect(
        &self,
        grant: &ConnectionGrant,
    ) -> Result<(Stream, SocketAddr, bool), OpenError> {
        let limits = &self.broker.config.limits;
        let candidates: Vec<IpAddr> = match &grant.host {
            Host::Ip(ip) => vec![*ip],
            Host::Dns(name) => tokio::time::timeout(
                limits.resolve_timeout,
                self.broker.resolver.resolve(name, grant.port),
            )
            .await
            .map_err(|_| BrokerError::Timeout)?
            .map_err(|e| BrokerError::from_io(&e))?,
        };
        let mut permitted: Vec<IpAddr> = Vec::new();
        for ip in candidates.into_iter().map(canonical) {
            if grant.addresses.permits(ip) && !permitted.contains(&ip) {
                permitted.push(ip);
            }
        }
        if permitted.is_empty() {
            return Err(deny("resolved address not permitted by the grant"));
        }

        let mut last = BrokerError::ConnectionLost;
        let mut connected = None;
        for ip in permitted {
            let addr = SocketAddr::new(ip, grant.port);
            match tokio::time::timeout(limits.connect_timeout, TcpStream::connect(addr)).await {
                Ok(Ok(tcp)) => {
                    // Connect-time check: the socket must be connected to the address we checked.
                    let peer = tcp.peer_addr().map_err(|e| BrokerError::from_io(&e))?;
                    if canonical(peer.ip()) != ip || peer.port() != grant.port {
                        return Err(BrokerError::Internal.into());
                    }
                    connected = Some((tcp, addr));
                    break;
                }
                Ok(Err(e)) => last = BrokerError::from_io(&e),
                Err(_) => last = BrokerError::Timeout,
            }
        }
        let (tcp, peer) = connected.ok_or(last)?;
        let _ = tcp.set_nodelay(true);

        match &grant.tls {
            TlsPolicy::Enabled(tls) if tls.mode == TlsMode::Direct => {
                let tls = self.handshake(tls, tcp).await?;
                Ok((Stream::Tls(Box::new(tls)), peer, true))
            }
            TlsPolicy::Enabled(_) | TlsPolicy::Disabled => Ok((Stream::Plain(tcp), peer, false)),
        }
    }

    async fn handshake(
        &self,
        tls: &TlsSettings,
        tcp: TcpStream,
    ) -> Result<TlsStream<TcpStream>, BrokerError> {
        let server_name =
            ServerName::try_from(tls.server_name.clone()).map_err(|_| BrokerError::TlsFailed)?;
        let provider = &self.broker.provider;
        let builder = ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .map_err(|_| BrokerError::Internal)?;
        let config = match &tls.trust {
            ServerTrust::DeploymentCas => builder
                .with_root_certificates(self.broker.config.deployment_roots.clone())
                .with_no_client_auth(),
            ServerTrust::PinnedCas(cas) => builder
                .with_root_certificates(pinned_ca_store(cas))
                .with_no_client_auth(),
            ServerTrust::PinnedCertificates(pins) => builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(PinnedCertVerifier {
                    pins: pins.clone(),
                    provider: provider.clone(),
                }))
                .with_no_client_auth(),
        };
        let connector = TlsConnector::from(Arc::new(config));
        match tokio::time::timeout(
            self.broker.config.limits.tls_handshake_timeout,
            connector.connect(server_name, tcp),
        )
        .await
        {
            Ok(Ok(tls)) => Ok(tls),
            Ok(Err(_)) => Err(BrokerError::TlsFailed),
            Err(_) => Err(BrokerError::Timeout),
        }
    }

    /// Send all of `bytes`. Returns the number of bytes sent.
    pub async fn send(&self, io: &mut Transport, bytes: &[u8]) -> Result<usize, BrokerError> {
        self.check(io)?;
        if awaiting_tls(io) {
            let budget = self.broker.config.limits.pre_tls_plaintext_bytes;
            if io.plaintext_bytes + bytes.len() > budget {
                close(io).await;
                return Err(BrokerError::TlsFailed);
            }
        }
        let until_expiry = self.until_expiry(&io.entry.grant);
        let mut stream = io.handle.stream.lock().await;
        let result = tokio::select! {
            r = stream.write_all(bytes) => r.map_err(|e| BrokerError::from_io(&e)),
            e = interrupted(&mut io.revoked, until_expiry) => Err(e),
        };
        if result.is_err() {
            *stream = Stream::Closed;
        }
        drop(stream);
        result?;
        if awaiting_tls(io) {
            io.plaintext_bytes += bytes.len();
        }
        Ok(bytes.len())
    }

    /// Receive up to `max_bytes` (clamped to the broker limit). An empty result means the peer
    /// closed the connection.
    pub async fn recv(&self, io: &mut Transport, max_bytes: usize) -> Result<Vec<u8>, BrokerError> {
        self.check(io)?;
        if max_bytes == 0 {
            return Err(BrokerError::Unsupported("max_bytes must be positive"));
        }
        let mut max = max_bytes.min(self.broker.config.limits.max_recv_bytes);
        if awaiting_tls(io) {
            let budget = self.broker.config.limits.pre_tls_plaintext_bytes;
            let remaining = budget.saturating_sub(io.plaintext_bytes);
            if remaining == 0 {
                close(io).await;
                return Err(BrokerError::TlsFailed);
            }
            // Never read past the budget, so no bytes meant for the TLS layer are consumed here.
            max = max.min(remaining);
        }
        let mut buf = vec![0u8; max];
        let until_expiry = self.until_expiry(&io.entry.grant);
        let mut stream = io.handle.stream.lock().await;
        let result = tokio::select! {
            r = stream.read(&mut buf) => r.map_err(|e| BrokerError::from_io(&e)),
            e = interrupted(&mut io.revoked, until_expiry) => Err(e),
        };
        if result.is_err() {
            *stream = Stream::Closed;
        }
        drop(stream);
        let n = result?;
        if awaiting_tls(io) {
            io.plaintext_bytes += n;
        }
        buf.truncate(n);
        Ok(buf)
    }

    /// Upgrade the same connection to TLS after the driver negotiated it in-protocol (PostgreSQL
    /// `SSLRequest`, MySQL `SSL_REQUEST`). `server_name` must equal the grant's TLS server name;
    /// the certificate is verified against the grant's roots. On failure the transport is closed.
    pub async fn start_tls(
        &self,
        io: &mut Transport,
        server_name: &str,
    ) -> Result<(), BrokerError> {
        let started = Instant::now();
        let result = self.start_tls_inner(io, server_name).await;
        let (decision, outcome) = match &result {
            Ok(()) => (AuditDecision::Allow, Outcome::Success),
            Err(BrokerError::PermissionDenied) => (
                AuditDecision::Deny {
                    reason: policy("start_tls not permitted by the grant"),
                },
                error_outcome(&BrokerError::PermissionDenied),
            ),
            Err(e) => (AuditDecision::Allow, error_outcome(e)),
        };
        let audited = self.audit(
            START_TLS_ACTION,
            &io.entry.grant.target_id,
            encode_digest(
                "byterygon.plugin-host.broker.start-tls.v1",
                &[io.entry.grant.target_id.as_bytes(), server_name.as_bytes()],
            ),
            decision,
            outcome,
            started,
        );
        if result.is_ok() && audited.is_err() {
            close(io).await;
        }
        result.and(audited)
    }

    async fn start_tls_inner(
        &self,
        io: &mut Transport,
        server_name: &str,
    ) -> Result<(), BrokerError> {
        self.check(io)?;
        let grant = io.entry.grant.clone();
        let Some(tls) = grant.tls.settings() else {
            // Plaintext grant: TLS was not approved for this connection.
            return Err(BrokerError::PermissionDenied);
        };
        if tls.mode != TlsMode::InProtocolUpgrade
            || io.tls
            || !server_name.eq_ignore_ascii_case(&tls.server_name)
        {
            return Err(BrokerError::PermissionDenied);
        }
        let until_expiry = self.until_expiry(&grant);
        let mut stream = io.handle.stream.lock().await;
        let Stream::Plain(tcp) = std::mem::replace(&mut *stream, Stream::Closed) else {
            return Err(BrokerError::ConnectionLost);
        };
        let result = tokio::select! {
            r = self.handshake(tls, tcp) => r,
            e = interrupted(&mut io.revoked, until_expiry) => Err(e),
        };
        match result {
            Ok(tls) => {
                *stream = Stream::Tls(Box::new(tls));
                io.tls = true;
                Ok(())
            }
            // The stream stays closed: no plaintext fallback.
            Err(e) => Err(e),
        }
    }

    /// Ownership, revocation, expiry. Revoked or expired transports are closed.
    fn check(&self, io: &Transport) -> Result<(), BrokerError> {
        if io.scope_id != self.id {
            // Handles are not transferable between plugin instances or principals.
            return Err(BrokerError::PermissionDenied);
        }
        if io.entry.is_revoked() || io.entry.grant.is_expired(self.now()) {
            io.handle.close_now();
            return Err(BrokerError::PermissionDenied);
        }
        if io.handle.closed.load(Ordering::SeqCst) {
            return Err(BrokerError::ConnectionLost);
        }
        Ok(())
    }

    fn now(&self) -> u64 {
        self.broker.grants.clock().now_unix_ms()
    }

    fn until_expiry(&self, grant: &ConnectionGrant) -> Option<Duration> {
        grant
            .expires_at_unix_ms
            .map(|t| Duration::from_millis(t.saturating_sub(self.now())))
    }

    fn audit(
        &self,
        action: &str,
        target_id: &str,
        input_digest: Digest,
        decision: AuditDecision,
        outcome: Outcome,
        started: Instant,
    ) -> Result<(), BrokerError> {
        let caller = &self.caller;
        self.broker
            .grants
            .audit()
            .append(AuditEntry {
                timestamp_unix_ms: self.now(),
                principal_chain: caller.audit_chain(),
                tenant: caller.principal.tenant.clone(),
                action: Action::new(action, BROKER_PERM),
                target: Some(TargetRef::connection(target_id)),
                risk: Risk::Read,
                decision,
                approval_id: None,
                outcome,
                duration_ms: Some(u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)),
                correlation_id: caller.correlation_id.clone(),
                input_digest,
                statement_digest: None,
            })
            .map_err(|_| BrokerError::Internal)
    }
}

async fn close(io: &mut Transport) {
    io.handle.closed.store(true, Ordering::SeqCst);
    *io.handle.stream.lock().await = Stream::Closed;
}

fn error_outcome(e: &BrokerError) -> Outcome {
    Outcome::Error {
        code: e.code().to_owned(),
    }
}

/// Resolves when the grant is revoked or expires; the caller then abandons its I/O.
async fn interrupted(
    revoked: &mut watch::Receiver<bool>,
    until_expiry: Option<Duration>,
) -> BrokerError {
    let expiry = async {
        match until_expiry {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        _ = revoked.wait_for(|r| *r) => BrokerError::PermissionDenied,
        () = expiry => BrokerError::PermissionDenied,
    }
}

/// Whether the transport still has to upgrade to TLS: its grant requires TLS and `start_tls` has
/// not succeeded yet. Plaintext grants have no budget; they never upgrade.
fn awaiting_tls(io: &Transport) -> bool {
    !io.tls && io.entry.grant.tls.settings().is_some()
}

/// Accepts exactly the pinned server certificates ([`ServerTrust::PinnedCertificates`]), for
/// self-signed certificates in self-hosted deployments. The handshake signature is still checked
/// against the presented certificate, so a copied certificate without its private key fails.
#[derive(Debug)]
struct PinnedCertVerifier {
    pins: Vec<Digest>,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let fingerprint = Digest(Sha256::digest(end_entity.as_ref()).into());
        if self.pins.contains(&fingerprint) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
