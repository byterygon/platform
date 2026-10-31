//! Connection grants (Plugin Host spec §3).
//!
//! Creating a connection *is* the grant: the approver binds an installed plugin's network template
//! to one exact host, port, TLS policy, address policy and secret reference, for a tenant and a set
//! of eligible principals. The broker opens nothing without an active grant for the target.
//!
//! Grants are immutable. Changing the destination, TLS policy or anything else means revoking the
//! grant and approving a new one. Revoking closes every handle opened under the grant.
//!
//! # Expiry
//!
//! A grant with `expires_at_unix_ms` ends at that time, driven by the store's [`Clock`] (see
//! [`Clock::sleep_until`]), not on the next use:
//!
//! - every transport opened under it is closed at `expires_at`, idle or not;
//! - an operation in flight at that moment (`open` still connecting, `send`, `recv`, `start_tls`)
//!   is aborted: it returns `PermissionDenied` and its socket is closed. There is no grace
//!   period, because the approval no longer covers the connection;
//! - the grant stops being the target's active grant, so a new grant for the same target can be
//!   created ([`GrantError::TargetInUse`] only refers to unexpired, unrevoked grants).
//!
//! `create` and the broker also compare `expires_at` with the clock themselves, so an expired
//! grant is never used even if the expiry task has not run yet.
//!
//! # Request digest
//!
//! Grant creation is authorized and audited with [`grant_create_digest`] (domain
//! [`GRANT_CREATE_DIGEST_DOMAIN`]), which commits to the plugin binding and every field of the
//! [`GrantRequest`].

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, Weak};

use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, ServerName};
use security_types::{
    Action, AuditDecision, AuditEntry, AuditPrincipal, Authorizer, AuthzRequest, Decision, Digest,
    Outcome, Principal, PrincipalKind, Reason, Risk, RoleId, TargetRef, TenantId,
};
use sha2::{Digest as _, Sha256};
use tokio::sync::watch;

use crate::audit::{AuditSink, Clock};
use crate::manifest::{Capabilities, Manifest, PackageKind, Protocol, SecretScope, TlsRequirement};
use crate::net::{AddressPolicy, IpNet, normalize_dns_name};
use crate::{encode_digest, error_code};

/// Domain separator of [`grant_create_digest`].
///
/// v2 (TSK-20) replaces `byterygon.plugin-host.grant.create.v1`, which covered only tenant,
/// target, connection, plugin id and digest, template, host and port, so the `Authorizer` and the
/// audit log could not tell, for example, a TLS-pinned grant from a plaintext grant to the same
/// endpoint. The v1 digest is no longer computed: it was only passed to the `Authorizer` and
/// written to audit entries, and nothing stored or compared it, so no caller can present one. A
/// verifier that has a v1 digest cannot match it against v2, because the domains differ.
pub const GRANT_CREATE_DIGEST_DOMAIN: &str = "byterygon.plugin-host.grant.create.v2";

/// The digest that grant creation is authorized and audited with: SHA-256 over
/// [`GRANT_CREATE_DIGEST_DOMAIN`], a zero byte and the canonical encoding below. Two requests get
/// the same digest only if they ask for the same grant for the same plugin.
///
/// Encoding. Integers are big-endian. `str`/`bytes` is a `u64` length then the bytes; `list<T>`
/// is a `u64` count then the items; `option<T>` is `0x00`, or `0x01` then the value; `bool` is
/// `0x00`/`0x01`. Fields, in this order:
///
/// | # | Field | Encoding |
/// | --- | --- | --- |
/// | 1 | plugin id | str |
/// | 2 | plugin digest | 32 bytes |
/// | 3 | driver kind | u8: native 0, wasm 1, sidecar 2 |
/// | 4 | tenant | str |
/// | 5 | owner | str |
/// | 6 | eligible principals | list<str>, sorted |
/// | 7 | eligible roles | list<str>, sorted |
/// | 8 | connection id | str |
/// | 9 | target id | str |
/// | 10 | template id | str |
/// | 11 | host | str, as requested |
/// | 12 | port | u16 |
/// | 13 | TLS policy | u8: disabled 0; enabled 1, then mode u8 (direct 0, in-protocol upgrade 1), server name str, trust u8 (deployment CAs 0; pinned CAs 1, then list<bytes>; pinned certificates 2, then list<32 bytes>) |
/// | 14 | address policy | list of networks: u8 family (4 or 6), 4 or 16 address bytes, u8 prefix |
/// | 15 | secret binding | option: template id str, secret reference str |
/// | 16 | allow cancel connection | bool |
/// | 17 | expires at (Unix ms) | option<u64> |
///
/// Lists that are sets (eligibility, address policy, pinned CAs and pinned certificates) are
/// encoded sorted by their encoding and without duplicates, so equal sets give equal digests.
/// The secret reference is an opaque store reference, not a credential; the digest is one-way
/// and the audit log still never contains the reference itself.
pub fn grant_create_digest(plugin: &InstalledPlugin, req: &GrantRequest) -> Digest {
    domain_digest(GRANT_CREATE_DIGEST_DOMAIN, &grant_create_body(plugin, req))
}

fn domain_digest(domain: &str, body: &[u8]) -> Digest {
    let mut h = Sha256::new();
    h.update(domain.as_bytes());
    h.update([0]);
    h.update(body);
    Digest(h.finalize().into())
}

/// The canonical encoding hashed by [`grant_create_digest`].
fn grant_create_body(plugin: &InstalledPlugin, req: &GrantRequest) -> Vec<u8> {
    let mut e = Encoder::default();
    e.str(&plugin.id);
    e.raw(plugin.digest.as_bytes());
    e.u8(match plugin.driver_kind {
        DriverKind::Native => 0,
        DriverKind::Wasm => 1,
        DriverKind::Sidecar => 2,
    });
    e.str(req.tenant.as_str());
    e.str(&req.owner);
    e.set(
        req.eligible
            .principals
            .iter()
            .map(|p| bytes_item(p.as_bytes())),
    );
    e.set(
        req.eligible
            .roles
            .iter()
            .map(|r| bytes_item(r.as_str().as_bytes())),
    );
    e.str(&req.connection_id);
    e.str(&req.target_id);
    e.str(&req.template_id);
    e.str(&req.host);
    e.raw(&req.port.to_be_bytes());
    match &req.tls {
        TlsPolicy::Disabled => e.u8(0),
        TlsPolicy::Enabled(tls) => {
            e.u8(1);
            e.u8(match tls.mode {
                TlsMode::Direct => 0,
                TlsMode::InProtocolUpgrade => 1,
            });
            e.str(&tls.server_name);
            match &tls.trust {
                ServerTrust::DeploymentCas => e.u8(0),
                ServerTrust::PinnedCas(cas) => {
                    e.u8(1);
                    e.set(cas.iter().map(|der| bytes_item(der)));
                }
                ServerTrust::PinnedCertificates(pins) => {
                    e.u8(2);
                    e.set(pins.iter().map(|pin| pin.as_bytes().to_vec()));
                }
            }
        }
    }
    e.set(req.addresses.allowed.iter().map(|net| {
        let mut item = Vec::with_capacity(18);
        match net.addr() {
            IpAddr::V4(v4) => {
                item.push(4);
                item.extend(v4.octets());
            }
            IpAddr::V6(v6) => {
                item.push(6);
                item.extend(v6.octets());
            }
        }
        item.push(net.prefix());
        item
    }));
    match &req.secret {
        None => e.u8(0),
        Some(secret) => {
            e.u8(1);
            e.str(&secret.template_id);
            e.str(&secret.secret_ref);
        }
    }
    e.u8(u8::from(req.allow_cancel_connection));
    match req.expires_at_unix_ms {
        None => e.u8(0),
        Some(t) => {
            e.u8(1);
            e.raw(&t.to_be_bytes());
        }
    }
    e.0
}

/// Canonical encoder for [`grant_create_digest`].
#[derive(Default)]
struct Encoder(Vec<u8>);

impl Encoder {
    fn raw(&mut self, bytes: &[u8]) {
        self.0.extend_from_slice(bytes);
    }

    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }

    fn len(&mut self, n: usize) {
        self.raw(&(n as u64).to_be_bytes());
    }

    fn str(&mut self, s: &str) {
        self.len(s.len());
        self.raw(s.as_bytes());
    }

    /// A set: items (already encoded) sorted, without duplicates, behind their count.
    fn set(&mut self, items: impl Iterator<Item = Vec<u8>>) {
        let items: BTreeSet<Vec<u8>> = items.collect();
        self.len(items.len());
        for item in items {
            self.raw(&item);
        }
    }
}

/// A length-prefixed byte string, as one [`Encoder::set`] item.
fn bytes_item(bytes: &[u8]) -> Vec<u8> {
    let mut item = Vec::with_capacity(8 + bytes.len());
    item.extend((bytes.len() as u64).to_be_bytes());
    item.extend_from_slice(bytes);
    item
}

/// Action and permission checked when a grant is created or revoked.
///
/// NOTE: provisional names (Plugin Host spec, Open question 25, accepted as provisional by Uy Son
/// on 2026-10-26). Update them here, in the broker constants and in the spec once the permission
/// catalogue is fixed; the Ambidex admin API uses the `admin.grants.*` family.
pub const GRANT_CREATE_ACTION: &str = "plugin-host.grants.create";
pub const GRANT_CREATE_PERM: &str = "admin.grants.create";
pub const GRANT_REVOKE_ACTION: &str = "plugin-host.grants.revoke";
pub const GRANT_REVOKE_PERM: &str = "admin.grants.revoke";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GrantId(String);

impl GrantId {
    fn random() -> Result<Self, getrandom::Error> {
        let mut bytes = [0u8; 16];
        getrandom::fill(&mut bytes)?;
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        Ok(GrantId(format!("grant-{hex}")))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for GrantId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DriverKind {
    /// First-party driver compiled into the core.
    Native,
    Wasm,
    Sidecar,
}

/// An installed, enabled plugin version as the grant store sees it: identity, package digest and
/// the capability templates it may be granted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledPlugin {
    pub id: String,
    pub digest: Digest,
    pub driver_kind: DriverKind,
    pub capabilities: Capabilities,
}

impl InstalledPlugin {
    /// A packaged plugin, after its signature and digest were verified.
    pub fn from_manifest(manifest: &Manifest, digest: Digest) -> Self {
        Self {
            id: manifest.id.clone(),
            digest,
            driver_kind: match manifest.kind {
                PackageKind::Wasm => DriverKind::Wasm,
                PackageKind::Sidecar => DriverKind::Sidecar,
            },
            capabilities: manifest.capabilities.clone(),
        }
    }
}

/// The plugin a grant is bound to. A different plugin, or the same plugin with another digest,
/// cannot use the grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginBinding {
    pub plugin_id: String,
    pub digest: Digest,
    pub driver_kind: DriverKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Host {
    /// Lower-cased DNS name, resolved by the host on every open.
    Dns(String),
    Ip(IpAddr),
}

impl Host {
    /// An IP literal or a DNS name. Wildcards are rejected.
    pub fn parse(s: &str) -> Option<Host> {
        if let Ok(ip) = s.parse::<IpAddr>() {
            return Some(Host::Ip(ip));
        }
        normalize_dns_name(s).map(Host::Dns)
    }
}

impl fmt::Display for Host {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Host::Dns(name) => f.write_str(name),
            Host::Ip(ip) => write!(f, "{ip}"),
        }
    }
}

/// Transport security of a connection, chosen by the approver when the grant is created
/// (Plugin Host spec, Open question 26). The broker applies it to data and cancel connections
/// alike and never falls back from TLS to plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TlsPolicy {
    /// Plaintext TCP. Only when the template says `tls = "optional"`; `start_tls` is refused.
    Disabled,
    Enabled(TlsSettings),
}

impl TlsPolicy {
    pub fn settings(&self) -> Option<&TlsSettings> {
        match self {
            TlsPolicy::Disabled => None,
            TlsPolicy::Enabled(s) => Some(s),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TlsSettings {
    pub mode: TlsMode,
    /// Sent as SNI and, with CA verification, the name (or IP) the certificate must match.
    /// `start_tls` must be called with exactly this.
    pub server_name: String,
    pub trust: ServerTrust,
}

/// When TLS starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// TLS handshake immediately after TCP connect.
    Direct,
    /// The driver negotiates TLS inside its protocol, then calls `start_tls` on the same handle.
    /// Requires the template's `allow_in_protocol_tls_upgrade`.
    InProtocolUpgrade,
}

/// How the server certificate is verified. Every option verifies; there is no "accept any
/// certificate" mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServerTrust {
    /// Chain to a CA the deployment configured on the broker, matching `server_name`, within its
    /// validity period.
    DeploymentCas,
    /// Chain to one of these DER-encoded CA certificates (e.g. a company-internal CA), matching
    /// `server_name`, within its validity period.
    PinnedCas(Vec<Vec<u8>>),
    /// The server presents exactly one of these certificates, identified by the SHA-256 of its
    /// DER encoding. For self-signed certificates: the name and validity period are not checked,
    /// because the pin already identifies the certificate. The TLS handshake signature is still
    /// verified, so only the holder of the private key passes.
    PinnedCertificates(Vec<Digest>),
}

/// Who may use a grant. Every principal in the caller's `on_behalf_of` chain must be eligible:
/// listed by id, or holding one of the roles.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Eligibility {
    pub principals: BTreeSet<String>,
    pub roles: BTreeSet<RoleId>,
}

impl Eligibility {
    fn admits(&self, p: &Principal) -> bool {
        self.principals.contains(&p.id) || p.roles.iter().any(|r| self.roles.contains(r))
    }

    fn is_empty(&self) -> bool {
        self.principals.is_empty() && self.roles.is_empty()
    }
}

/// The credential a connection may use: an opaque reference into the host secret store, scoped to
/// this connection. Never the secret itself.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretBinding {
    pub template_id: String,
    pub secret_ref: String,
}

impl fmt::Debug for SecretBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SecretBinding")
            .field("template_id", &self.template_id)
            .finish_non_exhaustive()
    }
}

/// What the approver asks to grant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GrantRequest {
    pub tenant: TenantId,
    /// The owning principal id (personal connection) or the tenant's admin scope (managed).
    pub owner: String,
    pub eligible: Eligibility,
    pub connection_id: String,
    pub target_id: String,
    pub template_id: String,
    pub host: String,
    pub port: u16,
    pub tls: TlsPolicy,
    pub addresses: AddressPolicy,
    pub secret: Option<SecretBinding>,
    pub allow_cancel_connection: bool,
    pub expires_at_unix_ms: Option<u64>,
}

/// An approved connection grant: the effective network permission for one target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectionGrant {
    pub id: GrantId,
    pub plugin: PluginBinding,
    pub tenant: TenantId,
    pub owner: String,
    pub eligible: Eligibility,
    pub connection_id: String,
    pub target_id: String,
    pub template_id: String,
    pub protocol: Protocol,
    pub host: Host,
    pub port: u16,
    pub tls: TlsPolicy,
    pub addresses: AddressPolicy,
    pub secret: Option<SecretBinding>,
    pub allow_cancel_connection: bool,
    pub created_at_unix_ms: u64,
    pub expires_at_unix_ms: Option<u64>,
    /// The approving principal, as recorded in the audit log.
    pub approver: AuditPrincipal,
}

impl ConnectionGrant {
    pub fn is_expired(&self, now_unix_ms: u64) -> bool {
        self.expires_at_unix_ms.is_some_and(|t| now_unix_ms >= t)
    }

    /// Why `principal` may not use this grant, or `None` if it may.
    pub(crate) fn ineligible(&self, principal: &Principal) -> Option<Reason> {
        for p in principal.chain() {
            if p.tenant != self.tenant {
                return Some(Reason::TenantMismatch);
            }
            if !self.eligible.admits(p) {
                return Some(policy("principal is not eligible for this connection"));
            }
        }
        None
    }
}

/// The CA store for pinned CAs. Validated at grant creation; an empty store fails every handshake.
pub(crate) fn pinned_ca_store(certs: &[Vec<u8>]) -> Arc<RootCertStore> {
    Arc::new(pinned_store(certs).unwrap_or_else(RootCertStore::empty))
}

fn pinned_store(certs: &[Vec<u8>]) -> Option<RootCertStore> {
    let mut store = RootCertStore::empty();
    for der in certs {
        store.add(CertificateDer::from(der.clone())).ok()?;
    }
    (!store.is_empty()).then_some(store)
}

pub(crate) fn policy(message: &str) -> Reason {
    Reason::Policy {
        message: message.to_owned(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GrantError {
    /// The approver may not make this change.
    Denied(Reason),
    /// The request does not fit the plugin's template or is malformed.
    Invalid(&'static str),
    /// The target already has an active (unexpired, unrevoked) grant; revoke it first.
    TargetInUse,
    NotFound,
    /// Auditing or id generation failed; nothing was changed.
    Internal,
}

impl fmt::Display for GrantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GrantError::Denied(reason) => write!(f, "grant change denied: {reason:?}"),
            GrantError::Invalid(what) => write!(f, "invalid grant request: {what}"),
            GrantError::TargetInUse => f.write_str("target already has an active grant"),
            GrantError::NotFound => f.write_str("grant not found"),
            GrantError::Internal => f.write_str("internal error"),
        }
    }
}

impl std::error::Error for GrantError {}

impl GrantError {
    fn outcome(&self) -> Outcome {
        let code = match self {
            GrantError::Denied(_) => error_code::PERMISSION_DENIED,
            GrantError::Invalid(_) => error_code::INVALID_ARGUMENT,
            GrantError::TargetInUse => error_code::FAILED_PRECONDITION,
            GrantError::NotFound => error_code::NOT_FOUND,
            GrantError::Internal => error_code::INTERNAL,
        };
        Outcome::Error {
            code: code.to_owned(),
        }
    }
}

/// Something opened under a grant that revocation must close.
pub(crate) trait Revocable: Send + Sync {
    fn close_now(&self);
}

/// Whether a grant can still be used. Once it leaves `Active` it never returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryState {
    Active,
    Revoked,
    Expired,
}

pub(crate) struct GrantEntry {
    pub(crate) grant: Arc<ConnectionGrant>,
    state: watch::Sender<EntryState>,
    handles: Mutex<Vec<Weak<dyn Revocable>>>,
}

impl GrantEntry {
    fn new(grant: Arc<ConnectionGrant>) -> Self {
        Self {
            grant,
            state: watch::Sender::new(EntryState::Active),
            handles: Mutex::default(),
        }
    }

    /// Changes when the grant is revoked or expires.
    pub(crate) fn state(&self) -> watch::Receiver<EntryState> {
        self.state.subscribe()
    }

    pub(crate) fn is_revoked(&self) -> bool {
        *self.state.borrow() == EntryState::Revoked
    }

    /// Neither revoked nor expired, by the entry's state and by the clock.
    pub(crate) fn is_active(&self, now_unix_ms: u64) -> bool {
        *self.state.borrow() == EntryState::Active && !self.grant.is_expired(now_unix_ms)
    }

    /// Track a handle so revocation or expiry can close it. Returns `false` (and tracks nothing)
    /// if the grant ended in the meantime.
    pub(crate) fn track(&self, handle: Weak<dyn Revocable>) -> bool {
        let mut handles = lock(&self.handles);
        if *self.state.borrow() != EntryState::Active {
            return false;
        }
        handles.retain(|h| h.strong_count() > 0);
        handles.push(handle);
        true
    }

    /// End the grant and close every handle opened under it. Revocation wins over expiry, so
    /// revoking an expired grant still records it as revoked.
    fn end(&self, to: EntryState) {
        let handles = {
            let mut handles = lock(&self.handles);
            self.state.send_if_modified(|s| {
                let change = match (*s, to) {
                    (EntryState::Active, _) | (EntryState::Expired, EntryState::Revoked) => true,
                    _ => false,
                };
                if change {
                    *s = to;
                }
                change
            });
            std::mem::take(&mut *handles)
        };
        for h in handles.iter().filter_map(Weak::upgrade) {
            h.close_now();
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Default)]
struct StoreInner {
    by_id: HashMap<GrantId, Arc<GrantEntry>>,
    /// Active grant per target. Revoked and expired grants are removed.
    active: HashMap<(TenantId, String), GrantId>,
}

impl StoreInner {
    /// The active entry for `key`. An entry that has expired by the clock but whose expiry task
    /// has not run yet is expired here, so it neither blocks `create` nor serves `lookup`.
    fn active_entry(&mut self, key: &(TenantId, String), now: u64) -> Option<Arc<GrantEntry>> {
        let entry = self.by_id.get(self.active.get(key)?)?.clone();
        if entry.is_active(now) {
            return Some(entry);
        }
        self.expire(&entry);
        None
    }

    fn expire(&mut self, entry: &GrantEntry) {
        self.active.retain(|_, id| id != &entry.grant.id);
        entry.end(EntryState::Expired);
    }
}

/// The grants of one host. In-memory; persistence belongs to the product's workspace/server store.
///
/// Grants with an expiry need a Tokio runtime: `create` starts a task that ends the grant at
/// `expires_at`, and fails with [`GrantError::Internal`] if it cannot.
pub struct GrantStore {
    clock: Arc<dyn Clock>,
    audit: Arc<dyn AuditSink>,
    inner: Arc<Mutex<StoreInner>>,
}

impl GrantStore {
    pub fn new(clock: Arc<dyn Clock>, audit: Arc<dyn AuditSink>) -> Self {
        Self {
            clock,
            audit,
            inner: Arc::default(),
        }
    }

    pub(crate) fn clock(&self) -> &dyn Clock {
        &*self.clock
    }

    pub(crate) fn audit(&self) -> &dyn AuditSink {
        &*self.audit
    }

    /// Approve a connection: bind `plugin`'s template to the concrete endpoint in `req`.
    ///
    /// `approver` must be a human acting directly (the local user, or a tenant administrator) in
    /// the grant's tenant, and `authz` must allow [`GRANT_CREATE_PERM`]. A `NeedsApproval`
    /// decision is a denial: grant changes are not approval-gated here.
    pub async fn create<A: Authorizer>(
        &self,
        authz: &A,
        approver: &Principal,
        plugin: &InstalledPlugin,
        req: GrantRequest,
        correlation_id: &str,
    ) -> Result<Arc<ConnectionGrant>, GrantError> {
        let action = Action::new(GRANT_CREATE_ACTION, GRANT_CREATE_PERM);
        let target = TargetRef::connection(&req.target_id);
        let input_digest = grant_create_digest(plugin, &req);
        let audit = |decision: AuditDecision, outcome: Outcome| {
            self.audit.append(AuditEntry {
                timestamp_unix_ms: self.clock.now_unix_ms(),
                principal_chain: AuditPrincipal::chain_of(approver),
                tenant: req.tenant.clone(),
                action: action.clone(),
                target: Some(target.clone()),
                risk: Risk::Write,
                decision,
                approval_id: None,
                outcome,
                duration_ms: None,
                correlation_id: correlation_id.to_owned(),
                input_digest,
                statement_digest: None,
            })
        };

        if let Err(reason) = self
            .authorize(authz, approver, &req.tenant, &action, &target, input_digest)
            .await
        {
            let err = GrantError::Denied(reason.clone());
            let _ = audit(AuditDecision::Deny { reason }, err.outcome());
            return Err(err);
        }

        let result = self.build(plugin, req.clone(), approver).and_then(|grant| {
            // The expiry task needs a runtime; without one the grant could not end on time.
            let runtime = match grant.expires_at_unix_ms {
                Some(_) => {
                    Some(tokio::runtime::Handle::try_current().map_err(|_| GrantError::Internal)?)
                }
                None => None,
            };
            let mut inner = lock(&self.inner);
            let key = (grant.tenant.clone(), grant.target_id.clone());
            if inner.active_entry(&key, self.clock.now_unix_ms()).is_some() {
                return Err(GrantError::TargetInUse);
            }
            let grant = Arc::new(grant);
            // Audit before the grant becomes usable; if auditing fails, nothing is granted.
            audit(AuditDecision::Allow, Outcome::Success).map_err(|_| GrantError::Internal)?;
            let entry = Arc::new(GrantEntry::new(grant.clone()));
            inner.active.insert(key, grant.id.clone());
            inner.by_id.insert(grant.id.clone(), entry.clone());
            drop(inner);
            if let (Some(runtime), Some(expires_at)) = (runtime, grant.expires_at_unix_ms) {
                runtime.spawn(expire_at(
                    self.clock.clone(),
                    Arc::downgrade(&self.inner),
                    Arc::downgrade(&entry),
                    entry.state(),
                    expires_at,
                ));
            }
            Ok(grant)
        });
        if let Err(e) = &result
            && *e != GrantError::Internal
        {
            let _ = audit(AuditDecision::Allow, e.outcome());
        }
        result
    }

    /// Revoke a grant and close every handle opened under it.
    pub async fn revoke<A: Authorizer>(
        &self,
        authz: &A,
        approver: &Principal,
        id: &GrantId,
        correlation_id: &str,
    ) -> Result<(), GrantError> {
        let entry = lock(&self.inner).by_id.get(id).cloned();
        let Some(entry) = entry.filter(|e| e.grant.tenant == approver.tenant) else {
            // Grants of other tenants are reported as missing, not as forbidden.
            return Err(GrantError::NotFound);
        };
        let grant = &entry.grant;
        let action = Action::new(GRANT_REVOKE_ACTION, GRANT_REVOKE_PERM);
        let target = TargetRef::connection(&grant.target_id);
        let input_digest = encode_digest(
            "byterygon.plugin-host.grant.revoke.v1",
            &[grant.id.as_str().as_bytes()],
        );
        let decision = self
            .authorize(
                authz,
                approver,
                &grant.tenant,
                &action,
                &target,
                input_digest,
            )
            .await;
        let result = match &decision {
            Err(reason) => Err(GrantError::Denied(reason.clone())),
            Ok(()) => Ok(()),
        };
        let audited = self.audit.append(AuditEntry {
            timestamp_unix_ms: self.clock.now_unix_ms(),
            principal_chain: AuditPrincipal::chain_of(approver),
            tenant: grant.tenant.clone(),
            action,
            target: Some(target),
            risk: Risk::Write,
            decision: match decision {
                Ok(()) => AuditDecision::Allow,
                Err(reason) => AuditDecision::Deny { reason },
            },
            approval_id: None,
            outcome: match &result {
                Ok(()) => Outcome::Success,
                Err(e) => e.outcome(),
            },
            duration_ms: None,
            correlation_id: correlation_id.to_owned(),
            input_digest,
            statement_digest: None,
        });
        result?;
        // Revocation removes access, so it happens even if the audit sink failed; the failure is
        // still reported to the caller.
        {
            let mut inner = lock(&self.inner);
            inner.active.retain(|_, active_id| active_id != &grant.id);
            entry.end(EntryState::Revoked);
        }
        audited.map_err(|_| GrantError::Internal)
    }

    pub fn get(&self, id: &GrantId) -> Option<Arc<ConnectionGrant>> {
        lock(&self.inner).by_id.get(id).map(|e| e.grant.clone())
    }

    pub fn is_revoked(&self, id: &GrantId) -> bool {
        lock(&self.inner)
            .by_id
            .get(id)
            .is_none_or(|e| e.is_revoked())
    }

    /// Whether the grant exists and is neither revoked nor expired.
    pub fn is_active(&self, id: &GrantId) -> bool {
        let now = self.clock.now_unix_ms();
        lock(&self.inner)
            .by_id
            .get(id)
            .is_some_and(|e| e.is_active(now))
    }

    /// The active (unrevoked, unexpired) grant for a target in a tenant.
    pub(crate) fn lookup(&self, tenant: &TenantId, target_id: &str) -> Option<Arc<GrantEntry>> {
        let now = self.clock.now_unix_ms();
        lock(&self.inner).active_entry(&(tenant.clone(), target_id.to_owned()), now)
    }

    async fn authorize<A: Authorizer>(
        &self,
        authz: &A,
        approver: &Principal,
        tenant: &TenantId,
        action: &Action,
        target: &TargetRef,
        input_digest: Digest,
    ) -> Result<(), Reason> {
        if approver.kind != PrincipalKind::Human || approver.on_behalf_of.is_some() {
            return Err(policy(
                "grant changes must be approved by a human acting directly",
            ));
        }
        if &approver.tenant != tenant {
            return Err(Reason::TenantMismatch);
        }
        let req = AuthzRequest {
            principal: approver,
            action,
            target: Some(target),
            risk: Risk::Write,
            input_digest,
        };
        match authz.check(&req).await {
            Decision::Allow => Ok(()),
            Decision::Deny { reason } => Err(reason),
            Decision::NeedsApproval { .. } => {
                Err(policy("grant changes cannot be approved by a second party"))
            }
        }
    }

    fn build(
        &self,
        plugin: &InstalledPlugin,
        req: GrantRequest,
        approver: &Principal,
    ) -> Result<ConnectionGrant, GrantError> {
        let now = self.clock.now_unix_ms();
        let template = plugin
            .capabilities
            .network
            .iter()
            .find(|t| t.id == req.template_id)
            .ok_or(GrantError::Invalid("unknown network template"))?;
        for (value, what) in [
            (&req.owner, "owner"),
            (&req.connection_id, "connection_id"),
            (&req.target_id, "target_id"),
        ] {
            if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
                return Err(GrantError::Invalid(what));
            }
        }
        if req.eligible.is_empty() {
            return Err(GrantError::Invalid("no eligible principals"));
        }
        let host = Host::parse(&req.host).ok_or(GrantError::Invalid("host"))?;
        if req.port == 0 {
            return Err(GrantError::Invalid("port"));
        }
        if req.addresses.allowed.is_empty() {
            return Err(GrantError::Invalid("address policy is empty"));
        }
        if let Host::Ip(ip) = host
            && !req.addresses.permits(ip)
        {
            return Err(GrantError::Invalid(
                "host address is outside the address policy",
            ));
        }
        match &req.tls {
            TlsPolicy::Disabled => {
                if template.tls == TlsRequirement::Required {
                    return Err(GrantError::Invalid("template requires TLS"));
                }
            }
            TlsPolicy::Enabled(tls) => {
                if tls.mode == TlsMode::InProtocolUpgrade && !template.allow_in_protocol_tls_upgrade
                {
                    return Err(GrantError::Invalid(
                        "template does not allow in-protocol TLS upgrade",
                    ));
                }
                if ServerName::try_from(tls.server_name.clone()).is_err() {
                    return Err(GrantError::Invalid("tls server_name"));
                }
                match &tls.trust {
                    ServerTrust::DeploymentCas => {}
                    ServerTrust::PinnedCas(certs) => {
                        if pinned_store(certs).is_none() {
                            return Err(GrantError::Invalid("pinned CA certificates"));
                        }
                    }
                    ServerTrust::PinnedCertificates(pins) => {
                        if pins.is_empty() {
                            return Err(GrantError::Invalid("pinned server certificates"));
                        }
                    }
                }
            }
        }
        if req.allow_cancel_connection && !template.allow_cancel_connection {
            return Err(GrantError::Invalid(
                "template does not allow a cancel connection",
            ));
        }
        if let Some(secret) = &req.secret {
            let ok = plugin
                .capabilities
                .secrets
                .iter()
                .any(|t| t.id == secret.template_id && t.scope == SecretScope::Connection);
            if !ok || secret.secret_ref.is_empty() {
                return Err(GrantError::Invalid("secret binding"));
            }
        }
        if req.expires_at_unix_ms.is_some_and(|t| t <= now) {
            return Err(GrantError::Invalid("expiry is in the past"));
        }
        Ok(ConnectionGrant {
            id: GrantId::random().map_err(|_| GrantError::Internal)?,
            plugin: PluginBinding {
                plugin_id: plugin.id.clone(),
                digest: plugin.digest,
                driver_kind: plugin.driver_kind,
            },
            tenant: req.tenant,
            owner: req.owner,
            eligible: req.eligible,
            connection_id: req.connection_id,
            target_id: req.target_id,
            template_id: req.template_id,
            protocol: template.protocol,
            host,
            port: req.port,
            tls: req.tls,
            addresses: req.addresses,
            secret: req.secret,
            allow_cancel_connection: req.allow_cancel_connection,
            created_at_unix_ms: now,
            expires_at_unix_ms: req.expires_at_unix_ms,
            approver: AuditPrincipal::chain_of(approver).swap_remove(0),
        })
    }
}

/// The expiry task of one grant: at `expires_at` (by `clock`) it ends the grant, closing every
/// transport opened under it, and frees its target. It stops early if the grant is revoked, and
/// holds only weak references, so it never keeps a dropped store or grant alive.
async fn expire_at(
    clock: Arc<dyn Clock>,
    store: Weak<Mutex<StoreInner>>,
    entry: Weak<GrantEntry>,
    mut state: watch::Receiver<EntryState>,
    expires_at: u64,
) {
    tokio::select! {
        () = clock.sleep_until(expires_at) => {}
        // Revoked, or every reference to the grant is gone.
        _ = state.wait_for(|s| *s != EntryState::Active) => return,
    }
    let Some(entry) = entry.upgrade() else {
        return;
    };
    match store.upgrade() {
        Some(store) => lock(&store).expire(&entry),
        None => entry.end(EntryState::Expired),
    }
}

/// Convenience for address policies written as strings in tests and config.
pub fn address_policy(nets: &[&str]) -> Result<AddressPolicy, crate::net::ParseIpNetError> {
    nets.iter()
        .map(|s| s.parse::<IpNet>())
        .collect::<Result<Vec<_>, _>>()
        .map(AddressPolicy::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plugin() -> InstalledPlugin {
        InstalledPlugin {
            id: "org.example.dbee.postgres".into(),
            digest: Digest([0xab; 32]),
            driver_kind: DriverKind::Wasm,
            capabilities: Capabilities::default(),
        }
    }

    /// A request that sets every optional field, so each one can be changed below.
    fn full() -> GrantRequest {
        GrantRequest {
            tenant: TenantId::new("t1"),
            owner: "tenant:t1".into(),
            eligible: Eligibility {
                principals: ["human:oidc:alice".to_owned()].into_iter().collect(),
                roles: [RoleId::new("analyst")].into_iter().collect(),
            },
            connection_id: "team:srv:pg1".into(),
            target_id: "pg1".into(),
            template_id: "db-transport".into(),
            host: "db.test".into(),
            port: 5432,
            tls: TlsPolicy::Enabled(TlsSettings {
                mode: TlsMode::InProtocolUpgrade,
                server_name: "db.test".into(),
                trust: ServerTrust::PinnedCas(vec![vec![0x30, 0x82, 0x01]]),
            }),
            addresses: address_policy(&["10.0.0.0/8", "fd00::/8"]).unwrap(),
            secret: Some(SecretBinding {
                template_id: "db-credentials".into(),
                secret_ref: "secret-ref-1".into(),
            }),
            allow_cancel_connection: true,
            expires_at_unix_ms: Some(1_700_000_000_000),
        }
    }

    /// The smallest request: plaintext, no secret, no cancel connection, no expiry.
    fn minimal() -> GrantRequest {
        GrantRequest {
            tenant: TenantId::new("t1"),
            owner: "u".into(),
            eligible: Eligibility {
                principals: ["u".to_owned()].into_iter().collect(),
                roles: BTreeSet::new(),
            },
            connection_id: "c".into(),
            target_id: "t".into(),
            template_id: "tpl".into(),
            host: "127.0.0.1".into(),
            port: 1,
            tls: TlsPolicy::Disabled,
            addresses: AddressPolicy::loopback(),
            secret: None,
            allow_cancel_connection: false,
            expires_at_unix_ms: None,
        }
    }

    fn tls(r: &mut GrantRequest) -> &mut TlsSettings {
        match &mut r.tls {
            TlsPolicy::Enabled(t) => t,
            TlsPolicy::Disabled => unreachable!("full() uses TLS"),
        }
    }

    fn with_trust(trust: ServerTrust) -> GrantRequest {
        let mut r = full();
        tls(&mut r).trust = trust;
        r
    }

    fn hex(d: Digest) -> String {
        d.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
    }

    fn v1_digest(p: &InstalledPlugin, r: &GrantRequest) -> Digest {
        encode_digest(
            "byterygon.plugin-host.grant.create.v1",
            &[
                r.tenant.as_str().as_bytes(),
                r.target_id.as_bytes(),
                r.connection_id.as_bytes(),
                p.id.as_bytes(),
                p.digest.as_bytes(),
                r.template_id.as_bytes(),
                r.host.as_bytes(),
                &r.port.to_be_bytes(),
            ],
        )
    }

    /// Golden vectors. The v2 digest is recorded in audit entries, so its encoding must not
    /// change silently: if one of these fails, the encoding changed and the domain must be bumped.
    #[test]
    fn golden_vectors_v2() {
        let cases = [
            ("full", full(), GOLDEN_FULL),
            ("minimal", minimal(), GOLDEN_MINIMAL),
            (
                "pinned certificates",
                with_trust(ServerTrust::PinnedCertificates(vec![Digest([0x11; 32])])),
                GOLDEN_PINNED_CERTS,
            ),
            (
                "deployment CAs",
                with_trust(ServerTrust::DeploymentCas),
                GOLDEN_DEPLOYMENT_CAS,
            ),
        ];
        for (name, req, want) in cases {
            assert_eq!(hex(grant_create_digest(&plugin(), &req)), want, "{name}");
        }
    }

    // Cross-checked outside Rust: `sha256sum` over the domain, a zero byte and the encoded body.
    const GOLDEN_FULL: &str = "0a6da4bd64c395a247034cb5a2040a44b050ab2885625da04f397e0a57e578c8";
    const GOLDEN_MINIMAL: &str = "caf801c166227b52f6c5401dc65a2a840ac386f1b6844d802801475abb6b0331";
    const GOLDEN_PINNED_CERTS: &str =
        "28e726a423a41c30e88b30420e6afbaa56d453fbdda3f16e83e780a0b7010b87";
    const GOLDEN_DEPLOYMENT_CAS: &str =
        "09b9579b3a5f83117ef8b55d5a103f77d2bd8fffbecf4c7dcb7a46b1503c1708";

    /// The exact bytes of the minimal request, written out field by field as documented on
    /// [`grant_create_digest`], so the layout is pinned independently of the hash.
    #[test]
    fn minimal_encoding_matches_the_documented_layout() {
        let mut want = Vec::new();
        let s = |want: &mut Vec<u8>, s: &str| {
            want.extend((s.len() as u64).to_be_bytes());
            want.extend(s.as_bytes());
        };
        s(&mut want, "org.example.dbee.postgres"); // 1 plugin id
        want.extend([0xab; 32]); // 2 plugin digest
        want.push(1); // 3 wasm
        s(&mut want, "t1"); // 4 tenant
        s(&mut want, "u"); // 5 owner
        want.extend(1u64.to_be_bytes()); // 6 one eligible principal
        s(&mut want, "u");
        want.extend(0u64.to_be_bytes()); // 7 no eligible roles
        s(&mut want, "c"); // 8 connection id
        s(&mut want, "t"); // 9 target id
        s(&mut want, "tpl"); // 10 template id
        s(&mut want, "127.0.0.1"); // 11 host
        want.extend(1u16.to_be_bytes()); // 12 port
        want.push(0); // 13 TLS disabled
        want.extend(2u64.to_be_bytes()); // 14 two networks, sorted: IPv4 first
        want.extend([4, 127, 0, 0, 1, 32]);
        want.push(6);
        want.extend(std::net::Ipv6Addr::LOCALHOST.octets());
        want.push(128);
        want.push(0); // 15 no secret
        want.push(0); // 16 no cancel connection
        want.push(0); // 17 no expiry
        assert_eq!(grant_create_body(&plugin(), &minimal()), want);

        let mut hashed = GRANT_CREATE_DIGEST_DOMAIN.as_bytes().to_vec();
        hashed.push(0);
        hashed.extend(&want);
        assert_eq!(
            grant_create_digest(&plugin(), &minimal()),
            Digest(Sha256::digest(&hashed).into())
        );
    }

    type Mutation = (&'static str, fn(&mut InstalledPlugin, &mut GrantRequest));

    /// One row per field of the plugin binding and of [`GrantRequest`] (and per variant where a
    /// field has several): each change alone gives a new digest, distinct from all the others.
    const MUTATIONS: &[Mutation] = &[
        ("plugin id", |p, _| p.id.push('x')),
        ("plugin digest", |p, _| p.digest = Digest([0xac; 32])),
        ("driver kind", |p, _| p.driver_kind = DriverKind::Native),
        ("tenant", |_, r| r.tenant = TenantId::new("t2")),
        ("owner", |_, r| r.owner.push('x')),
        ("eligible principal added", |_, r| {
            r.eligible.principals.insert("human:oidc:bob".into());
        }),
        ("eligible principals emptied", |_, r| {
            r.eligible.principals.clear()
        }),
        ("eligible role added", |_, r| {
            r.eligible.roles.insert(RoleId::new("agent-read"));
        }),
        ("eligible role renamed", |_, r| {
            r.eligible.roles = [RoleId::new("analyst2")].into_iter().collect();
        }),
        ("connection id", |_, r| r.connection_id.push('x')),
        ("target id", |_, r| r.target_id.push('x')),
        ("template id", |_, r| r.template_id.push('x')),
        ("host", |_, r| r.host = "db2.test".into()),
        ("port", |_, r| r.port = 5433),
        ("tls disabled (plaintext)", |_, r| {
            r.tls = TlsPolicy::Disabled
        }),
        ("tls mode", |_, r| tls(r).mode = TlsMode::Direct),
        ("tls server name", |_, r| {
            tls(r).server_name = "other.test".into()
        }),
        ("tls trust: deployment CAs", |_, r| {
            tls(r).trust = ServerTrust::DeploymentCas;
        }),
        ("tls trust: pinned CA bytes", |_, r| {
            tls(r).trust = ServerTrust::PinnedCas(vec![vec![0x30, 0x82, 0x02]]);
        }),
        ("tls trust: pinned CA added", |_, r| {
            tls(r).trust = ServerTrust::PinnedCas(vec![vec![0x30, 0x82, 0x01], vec![0x30]]);
        }),
        ("tls trust: pinned certificate", |_, r| {
            tls(r).trust = ServerTrust::PinnedCertificates(vec![Digest([0x11; 32])]);
        }),
        ("address network prefix", |_, r| {
            r.addresses = address_policy(&["10.0.0.0/9", "fd00::/8"]).unwrap();
        }),
        ("address network added", |_, r| {
            r.addresses = address_policy(&["10.0.0.0/8", "fd00::/8", "127.0.0.1/32"]).unwrap();
        }),
        ("address network removed", |_, r| {
            r.addresses = address_policy(&["10.0.0.0/8"]).unwrap();
        }),
        ("secret removed", |_, r| r.secret = None),
        ("secret template", |_, r| {
            if let Some(s) = &mut r.secret {
                s.template_id.push('x');
            }
        }),
        ("secret ref", |_, r| {
            if let Some(s) = &mut r.secret {
                s.secret_ref.push('x');
            }
        }),
        ("cancel allowance", |_, r| r.allow_cancel_connection = false),
        ("expiry changed", |_, r| {
            r.expires_at_unix_ms = Some(1_700_000_000_001)
        }),
        ("expiry removed", |_, r| r.expires_at_unix_ms = None),
    ];

    #[test]
    fn every_field_changes_the_digest() {
        let base = grant_create_digest(&plugin(), &full());
        let mut seen = BTreeSet::from([*base.as_bytes()]);
        for (name, mutate) in MUTATIONS {
            let (mut p, mut r) = (plugin(), full());
            mutate(&mut p, &mut r);
            assert!(
                p != plugin() || r != full(),
                "{name}: the mutation changed nothing"
            );
            let d = grant_create_digest(&p, &r);
            assert_ne!(d, base, "{name} does not change the digest");
            assert!(
                seen.insert(*d.as_bytes()),
                "{name} collides with another row"
            );
        }
    }

    /// Exhaustive destructuring: adding a field to `GrantRequest` fails to compile here, as a
    /// reminder to encode it in [`grant_create_body`] and to add a row to [`MUTATIONS`].
    #[test]
    fn digest_covers_every_request_field() {
        let GrantRequest {
            tenant: _,
            owner: _,
            eligible:
                Eligibility {
                    principals: _,
                    roles: _,
                },
            connection_id: _,
            target_id: _,
            template_id: _,
            host: _,
            port: _,
            tls: _,
            addresses: AddressPolicy { allowed: _ },
            secret: _,
            allow_cancel_connection: _,
            expires_at_unix_ms: _,
        } = full();
        let InstalledPlugin {
            id: _,
            digest: _,
            driver_kind: _,
            capabilities: _, // not part of the binding: the template is checked when building
        } = plugin();
    }

    /// Moving bytes between adjacent string fields changes the digest (length prefixes).
    #[test]
    fn field_boundaries_are_unambiguous() {
        let mut a = full();
        a.connection_id = "ab".into();
        a.target_id = "c".into();
        let mut b = full();
        b.connection_id = "a".into();
        b.target_id = "bc".into();
        assert_ne!(
            grant_create_digest(&plugin(), &a),
            grant_create_digest(&plugin(), &b)
        );
    }

    /// Sets are canonical: order and duplicates do not change the digest.
    #[test]
    fn sets_are_order_insensitive() {
        let mut a = full();
        a.addresses = address_policy(&["fd00::/8", "10.0.0.0/8", "10.0.0.0/8"]).unwrap();
        tls(&mut a).trust = ServerTrust::PinnedCas(vec![vec![2], vec![1], vec![2]]);
        let mut b = full();
        tls(&mut b).trust = ServerTrust::PinnedCas(vec![vec![1], vec![2]]);
        assert_eq!(
            grant_create_digest(&plugin(), &a),
            grant_create_digest(&plugin(), &b)
        );
    }

    /// v2 is domain-separated from v1: the v1 digest of a request, and the v2 body hashed under
    /// the v1 domain, both differ from the v2 digest. The v1 digest could not tell a TLS grant
    /// from a plaintext grant to the same endpoint; v2 can.
    #[test]
    fn v2_is_domain_separated_from_v1() {
        assert_eq!(
            GRANT_CREATE_DIGEST_DOMAIN,
            "byterygon.plugin-host.grant.create.v2"
        );
        let (p, r) = (plugin(), full());
        let v2 = grant_create_digest(&p, &r);
        assert_ne!(v1_digest(&p, &r), v2);
        let body = grant_create_body(&p, &r);
        assert_ne!(
            domain_digest("byterygon.plugin-host.grant.create.v1", &body),
            v2
        );
        assert_eq!(domain_digest(GRANT_CREATE_DIGEST_DOMAIN, &body), v2);

        let mut plain = full();
        plain.tls = TlsPolicy::Disabled;
        assert_eq!(v1_digest(&p, &r), v1_digest(&p, &plain));
        assert_ne!(v2, grant_create_digest(&p, &plain));
    }
}
