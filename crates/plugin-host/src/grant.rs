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
//! Expiry is an enforcement action of the host, so it is audited (spec question 36, TSK-22):
//! exactly one entry with the action [`GRANT_EXPIRE_ACTION`] per grant that expired while active,
//! written by the system principal [`GRANT_EXPIRY_PRINCIPAL`] once the transports are closed. The
//! entry shows the tenant, the connection target, the grant id (in `approval_id`) and the time
//! enforcement ran (its timestamp); the scheduled `expires_at` and the numbers of transports
//! closed and of operations aborted in flight are committed in `input_digest`
//! ([`grant_expire_digest`]) and readable in the entry's `detail` ([`grant_expire_detail`]). A
//! grant that was
//! revoked, or replaced by a version switch, before `expires_at` gets no expiry entry. Like a
//! revocation, expiry never waits for the audit sink: the entry goes through the same retry
//! queue, and a final failure is reported to the [`AuditReporter`].
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
use std::time::Duration;

use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, ServerName};
use security_types::{
    Action, AuditDecision, AuditDetail, AuditEntry, AuditPrincipal, Authorizer, AuthzRequest,
    Decision, Digest, Outcome, Principal, PrincipalKind, Reason, Risk, RoleId, SessionId,
    TargetRef, TenantId, append_within,
};
use sha2::{Digest as _, Sha256};
use tokio::sync::watch;

use crate::audit::{
    AuditEntryKind, AuditError, AuditFailure, AuditFailureEffect, AuditQueue, AuditReporter,
    AuditSink, Clock, RetryPolicy, StderrReporter,
};
use crate::manifest::{Capabilities, Manifest, PackageKind, Protocol, SecretScope, TlsRequirement};
use crate::net::{AddressPolicy, IpNet, normalize_dns_name};
use crate::{encode_digest, error_code};

// NOTE: Provisional names until the Plugin Host permission catalogue is fixed (spec questions 25
// and 36).
/// Action of the entry written when a grant expires (spec question 36).
pub const GRANT_EXPIRE_ACTION: &str = "plugin-host.grants.expire";
/// The permission named in expiry entries. Nobody holds it: expiry is not requested or
/// authorized, the host enforces it.
pub const GRANT_EXPIRE_PERM: &str = "system.grants.expire";
/// The id of the system principal that expiry entries are written by, in the grant's tenant.
pub const GRANT_EXPIRY_PRINCIPAL: &str = "system:plugin-host";
/// The session of [`GRANT_EXPIRY_PRINCIPAL`]: the host acts in no user session.
pub const GRANT_EXPIRY_SESSION: &str = "system";
/// Domain separator of [`grant_expire_digest`].
pub const GRANT_EXPIRE_DIGEST_DOMAIN: &str = "byterygon.plugin-host.grant.expire.v1";

/// What an expiry entry commits to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantExpiryRecord<'a> {
    pub grant_id: &'a GrantId,
    pub tenant: &'a TenantId,
    pub target_id: &'a str,
    /// The grant's scheduled expiry.
    pub expires_at_unix_ms: u64,
    /// When the host ended the grant; also the entry's timestamp.
    pub enforced_at_unix_ms: u64,
    /// Transports open under the grant that were closed.
    pub transports_closed: u64,
    /// Of those, the ones with an operation (`send`, `recv`, `start_tls`) in flight, which was
    /// aborted. An `open` still connecting has no transport yet and is audited by the broker as
    /// a denied open.
    pub operations_aborted: u64,
}

/// The `input_digest` of an expiry entry: SHA-256 over [`GRANT_EXPIRE_DIGEST_DOMAIN`], a zero
/// byte and, each as a little-endian `u64` length then the bytes: grant id, tenant, target id,
/// and the four numbers of the record in field order, each as 8 big-endian bytes.
pub fn grant_expire_digest(record: &GrantExpiryRecord<'_>) -> Digest {
    encode_digest(
        GRANT_EXPIRE_DIGEST_DOMAIN,
        &[
            record.grant_id.as_str().as_bytes(),
            record.tenant.as_str().as_bytes(),
            record.target_id.as_bytes(),
            &record.expires_at_unix_ms.to_be_bytes(),
            &record.enforced_at_unix_ms.to_be_bytes(),
            &record.transports_closed.to_be_bytes(),
            &record.operations_aborted.to_be_bytes(),
        ],
    )
}

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
/// | 6 | eligible principals | `list<str>`, sorted |
/// | 7 | eligible roles | `list<str>`, sorted |
/// | 8 | connection id | str |
/// | 9 | target id | str |
/// | 10 | template id | str |
/// | 11 | host | str, as requested |
/// | 12 | port | u16 |
/// | 13 | TLS policy | u8: disabled 0; enabled 1, then mode u8 (direct 0, in-protocol upgrade 1), server name str, trust u8 (deployment CAs 0; pinned CAs 1, then `list<bytes>`; pinned certificates 2, then `list<32 bytes>`) |
/// | 14 | address policy | list of networks: u8 family (4 or 6), 4 or 16 address bytes, u8 prefix |
/// | 15 | secret binding | option: template id str, secret reference str |
/// | 16 | allow cancel connection | bool |
/// | 17 | expires at (Unix ms) | `option<u64>` |
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

/// The `detail` of an expiry entry (spec question 44): the values [`grant_expire_digest`] commits
/// to that the entry does not show elsewhere, readable. The grant id is in `approval_id` and the
/// time enforcement ran is the entry's timestamp.
///
/// | Key | Value |
/// | --- | --- |
/// | `expires_at_unix_ms` | the grant's scheduled expiry, decimal |
/// | `transports_closed` | decimal |
/// | `operations_aborted` | decimal |
pub fn grant_expire_detail(record: &GrantExpiryRecord<'_>) -> Option<AuditDetail> {
    AuditDetail::new([
        ("expires_at_unix_ms", record.expires_at_unix_ms.to_string()),
        ("transports_closed", record.transports_closed.to_string()),
        ("operations_aborted", record.operations_aborted.to_string()),
    ])
    .ok()
}

/// Domain separator of the digest a grant carry-over entry commits to.
pub const GRANT_CARRY_DIGEST_DOMAIN: &str = "byterygon.plugin-host.grant.carry.v1";
/// Domain separator of the digest a grant restore entry commits to.
pub const GRANT_RESTORE_DIGEST_DOMAIN: &str = "byterygon.plugin-host.grant.restore.v1";

/// What the audit entry of a grant carry-over or restore commits to (Plugin Host spec, question
/// 42). `old` is the grant the switch started from and `new` the one that becomes active; for a
/// restore they are the same grant.
pub struct GrantSwitchRecord<'a> {
    pub plugin_id: &'a str,
    pub from_digest: Digest,
    /// The manifest `version` of the version the grant comes from; empty if it was unreadable.
    pub from_version: &'a str,
    pub to_digest: Digest,
    /// The manifest `version` of the version the grant is bound to afterwards.
    pub to_version: &'a str,
    pub old: &'a ConnectionGrant,
    pub new: &'a ConnectionGrant,
}

/// The `input_digest` of a grant carry-over ([`GRANT_CARRY_DIGEST_DOMAIN`]) or restore
/// ([`GRANT_RESTORE_DIGEST_DOMAIN`]) entry: SHA-256 over the domain, a zero byte and the encoding
/// below, which uses the encoding rules of [`grant_create_digest`]. The audit entry itself
/// shows the action, the connection target, the plugin (with its new digest) acting for the
/// person who switched versions, and the grant ids (`approval_id`); everything else it
/// commits to here, as for grant creation. Fields, in this order:
///
/// | # | Field | Encoding |
/// | --- | --- | --- |
/// | 1 | plugin id | str |
/// | 2 | source version digest | 32 bytes |
/// | 3 | source version | str |
/// | 4 | destination version digest | 32 bytes |
/// | 5 | destination version | str |
/// | 6 | old grant id | str |
/// | 7 | new grant id | str |
/// | 8 | tenant | str |
/// | 9 | connection id | str |
/// | 10 | target id | str |
/// | 11 | original approver id | str |
/// | 12 | original approver session | str |
/// | 13 | expires at (Unix ms) | `0x00`, or `0x01` then a `u64` |
/// | 14 | cancel connection kept | `0x00`/`0x01` |
/// | 15 | secret binding kept | `0x00`/`0x01` |
///
/// The approver and the expiry are those of the original approval: a carried grant keeps both.
pub fn grant_switch_digest(domain: &str, record: &GrantSwitchRecord<'_>) -> Digest {
    let mut e = Encoder::default();
    e.str(record.plugin_id);
    e.raw(record.from_digest.as_bytes());
    e.str(record.from_version);
    e.raw(record.to_digest.as_bytes());
    e.str(record.to_version);
    e.str(record.old.id.as_str());
    e.str(record.new.id.as_str());
    e.str(record.new.tenant.as_str());
    e.str(&record.new.connection_id);
    e.str(&record.new.target_id);
    e.str(&record.new.approver.id);
    e.str(record.new.approver.session.as_str());
    match record.new.expires_at_unix_ms {
        None => e.u8(0),
        Some(t) => {
            e.u8(1);
            e.raw(&t.to_be_bytes());
        }
    }
    e.u8(u8::from(record.new.allow_cancel_connection));
    e.u8(u8::from(record.new.secret.is_some()));
    domain_digest(domain, &e.0)
}

/// The `detail` of a grant carry-over or restore entry (spec question 42): the values
/// [`grant_switch_digest`] commits to that the entry does not show elsewhere, readable. The
/// plugin id and the destination digest are in the entry's first principal, the tenant and the
/// target id in the entry itself. With them, everything the digest covers can be read from the
/// entry, unless a value was clipped ([`AuditDetail::clip`]: the versions come from plugin
/// manifests and the approver from the identity provider, so they may be long or contain
/// control characters); the digest always covers the exact values.
///
/// | Key | Value |
/// | --- | --- |
/// | `from_digest` | source version digest, `sha256:<hex>` |
/// | `from_version` | source version; absent if its manifest was unreadable |
/// | `to_version` | destination version |
/// | `old_grant`, `new_grant` | grant ids (equal for a restore) |
/// | `connection` | connection id |
/// | `approver`, `approver_session` | who originally approved the grant |
/// | `expires_at_unix_ms` | the grant's expiry, decimal; absent if it has none |
/// | `cancel_connection` | `true`/`false`: the cancel connection was kept |
/// | `secret_binding` | `true`/`false`: the secret binding was kept. The secret itself is never here |
pub fn grant_switch_detail(record: &GrantSwitchRecord<'_>) -> Option<AuditDetail> {
    let new = record.new;
    let mut fields = vec![
        ("from_digest", format!("sha256:{}", record.from_digest)),
        ("to_version", AuditDetail::clip(record.to_version)),
        ("old_grant", record.old.id.to_string()),
        ("new_grant", new.id.to_string()),
        ("connection", AuditDetail::clip(&new.connection_id)),
        ("approver", AuditDetail::clip(&new.approver.id)),
        (
            "approver_session",
            AuditDetail::clip(new.approver.session.as_str()),
        ),
        ("cancel_connection", new.allow_cancel_connection.to_string()),
        ("secret_binding", new.secret.is_some().to_string()),
    ];
    if !record.from_version.is_empty() {
        fields.push(("from_version", AuditDetail::clip(record.from_version)));
    }
    if let Some(t) = new.expires_at_unix_ms {
        fields.push(("expires_at_unix_ms", t.to_string()));
    }
    AuditDetail::new(fields).ok()
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
    /// Id generation failed, or there is no runtime for an expiring grant; nothing was changed.
    Internal,
    /// The change could not be recorded in time (the audit sink failed or did not answer, or
    /// another grant change held the store that long); nothing was changed. Retryable.
    Unavailable,
}

impl fmt::Display for GrantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GrantError::Denied(reason) => write!(f, "grant change denied: {reason:?}"),
            GrantError::Invalid(what) => write!(f, "invalid grant request: {what}"),
            GrantError::TargetInUse => f.write_str("target already has an active grant"),
            GrantError::NotFound => f.write_str("grant not found"),
            GrantError::Internal => f.write_str("internal error"),
            GrantError::Unavailable => f.write_str("audit log unavailable; nothing was changed"),
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
            GrantError::Unavailable => error_code::UNAVAILABLE,
        };
        Outcome::Error {
            code: code.to_owned(),
        }
    }
}

/// Something opened under a grant that revocation must close.
pub(crate) trait Revocable: Send + Sync {
    /// Closes it. Returns whether an operation was in flight on it (and is thereby aborted).
    fn close_now(&self) -> bool;
}

/// What ending a grant closed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Closed {
    transports: u64,
    in_flight: u64,
}

/// An expiry that was enforced and still has to be audited.
#[derive(Debug, Clone, Copy)]
struct Expiry {
    enforced_at_unix_ms: u64,
    closed: Closed,
}

/// Whether a grant can still be used. Once it leaves `Active` it never returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryState {
    Active,
    Revoked,
    Expired,
    /// The plugin version the grant is bound to was replaced by an upgrade or a rollback. The
    /// store keeps the grant value for a later rollback (see [`GrantStore`]), but this entry
    /// never becomes active again; a restored grant gets a new entry.
    Superseded,
}

pub(crate) struct GrantEntry {
    pub(crate) grant: Arc<ConnectionGrant>,
    state: watch::Sender<EntryState>,
    handles: Mutex<Vec<Weak<dyn Revocable>>>,
    /// Set when the grant expired while active; taken by the expiry task, which audits it.
    expiry: Mutex<Option<Expiry>>,
}

impl GrantEntry {
    fn new(grant: Arc<ConnectionGrant>) -> Self {
        Self {
            grant,
            state: watch::Sender::new(EntryState::Active),
            handles: Mutex::default(),
            expiry: Mutex::default(),
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
    /// revoking an expired grant still records it as revoked. Returns what was closed when the
    /// state changed, `None` when the grant had already ended this way.
    fn end(&self, to: EntryState) -> Option<Closed> {
        let (changed, handles) = {
            let mut handles = lock(&self.handles);
            let changed = self.state.send_if_modified(|s| {
                let change = matches!(
                    (*s, to),
                    (EntryState::Active, _)
                        | (
                            EntryState::Expired | EntryState::Superseded,
                            EntryState::Revoked
                        )
                );
                if change {
                    *s = to;
                }
                change
            });
            (changed, std::mem::take(&mut *handles))
        };
        let mut closed = Closed::default();
        for h in handles.iter().filter_map(Weak::upgrade) {
            closed.transports += 1;
            closed.in_flight += u64::from(h.close_now());
        }
        changed.then_some(closed)
    }

    /// End the grant as expired, at `now`. Only the change from active is noted for the audit
    /// entry, so a grant gets at most one.
    fn expire(&self, now_unix_ms: u64) {
        if let Some(closed) = self.end(EntryState::Expired) {
            *lock(&self.expiry) = Some(Expiry {
                enforced_at_unix_ms: now_unix_ms,
                closed,
            });
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
    /// Per plugin id: the grant set of the retained previous version, for rollback.
    parked: HashMap<String, Parked>,
    /// A carried grant and the grant it was carried from, so revoking an ancestor revokes it.
    lineage: HashMap<GrantId, GrantId>,
    /// Grants a version switch is about to activate, waiting for their audit entry. A grant is
    /// activated only while it is still here; revoking its source removes it.
    pending: HashMap<GrantId, Arc<ConnectionGrant>>,
}

/// The grants a plugin version held when it stopped being the active version.
struct Parked {
    digest: Digest,
    grants: Vec<Arc<ConnectionGrant>>,
}

impl StoreInner {
    /// The active entry for `key`. An entry that has expired by the clock but whose expiry task
    /// has not run yet is expired here, so it neither blocks `create` nor serves `lookup`.
    fn active_entry(&mut self, key: &(TenantId, String), now: u64) -> Option<Arc<GrantEntry>> {
        let entry = self.by_id.get(self.active.get(key)?)?.clone();
        if entry.is_active(now) {
            return Some(entry);
        }
        self.expire(&entry, now);
        None
    }

    /// Whether `id` was carried (directly or through several upgrades) from `ancestor`.
    fn descends_from(&self, id: &GrantId, ancestor: &GrantId) -> bool {
        let mut current = id;
        // A chain has one link per upgrade; the bound only guards against a corrupted map.
        for _ in 0..self.lineage.len() {
            match self.lineage.get(current) {
                Some(source) if source == ancestor => return true,
                Some(source) => current = source,
                None => return false,
            }
        }
        false
    }

    fn expire(&mut self, entry: &GrantEntry, now: u64) {
        self.active.retain(|_, id| id != &entry.grant.id);
        entry.expire(now);
    }

    /// End every active grant bound to `plugin_id` at `digest` as superseded and return them.
    fn supersede(
        &mut self,
        plugin_id: &str,
        digest: Digest,
        now: u64,
    ) -> Vec<Arc<ConnectionGrant>> {
        let keys: Vec<_> = self.active.keys().cloned().collect();
        let mut ended = Vec::new();
        for key in keys {
            let Some(entry) = self.active_entry(&key, now) else {
                continue;
            };
            let binding = &entry.grant.plugin;
            if binding.plugin_id != plugin_id || binding.digest != digest {
                continue;
            }
            self.active.remove(&key);
            entry.end(EntryState::Superseded);
            ended.push(entry.grant.clone());
        }
        ended.sort_by(|a, b| a.id.cmp(&b.id));
        ended
    }
}

/// A grant a version switch wants to make active, waiting for its audit entry.
pub(crate) struct Candidate {
    /// The grant to activate: a new grant for a carry-over, the parked grant itself for a
    /// restore.
    pub(crate) grant: Arc<ConnectionGrant>,
    /// The grant it comes from (the same grant, for a restore).
    pub(crate) source: Arc<ConnectionGrant>,
    /// The new version no longer requests something the source had (carry-over only).
    pub(crate) narrowed: bool,
}

/// What [`GrantStore::activate_audited`] did.
pub(crate) enum ActivateOutcome<T, E> {
    /// The entry was written and the grant is active; `T` is what writing the entry returned.
    Activated(T),
    /// The grant was not activated, and no entry was written: it was revoked, has expired,
    /// its target has another active grant, or the target's lock could not be taken in time.
    Skipped,
    /// The entry could not be written, so the grant was not activated.
    Refused(E),
}

/// What a plugin version switch did to the plugin's connection grants. Produced by the installer
/// under the per-plugin lock (see [`crate::install`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GrantSwitch {
    /// Grants of the version that was left. They are kept, inactive, for a rollback.
    pub parked: Vec<GrantId>,
    /// `(old, new)`: an old-version grant and the new-version grant that carries it over.
    pub carried: Vec<(GrantId, GrantId)>,
    /// New-version grants (also in `carried`) that lost a permission the new version no longer
    /// requests: the cancel connection or the secret binding.
    pub narrowed: Vec<GrantId>,
    /// Old-version grants the new version cannot use (template removed or now incompatible).
    /// They stay parked, so a rollback restores them.
    pub dropped: Vec<GrantId>,
    /// Grants of the version returned to by a rollback, active again under their own ids.
    pub restored: Vec<GrantId>,
    /// Parked grants a rollback did not restore: expired, or their target now has another
    /// active grant.
    pub not_restored: Vec<GrantId>,
    /// For a rollback: whether the version's parked grant set was found.
    pub restore: RestoreOutcome,
    /// Grants that could have been carried over but were not, because their audit entry could
    /// not be written (the source grant, and why). Fail closed: no grant becomes active without
    /// its entry. They stay parked, so a rollback restores them. Never set for a rollback, which
    /// restores grants even if the audit sink fails (spec question 41).
    pub audit_failed: Vec<(GrantId, AuditError)>,
}

/// Whether a rollback found the parked grant set of the version it returned to.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum RestoreOutcome {
    /// Not a rollback.
    #[default]
    NotARollback,
    /// The parked set was found; `restored` and `not_restored` list what happened to it. An
    /// empty set means that version had no grants.
    Restored,
    /// No parked set exists for that version: the in-memory state was lost (a restart, or the
    /// store was replaced), or the versions were not switched through this store. Nothing was
    /// restored; the caller must have the approver create the grants again.
    NoParkedState,
}

/// `grant` rebound to `to`, if `to` still requests what it uses. Returns the carried grant and
/// whether it was narrowed. `from` is what the version the grant came from requested.
///
/// A grant is not carried (it stays parked for a rollback, and needs a new approval) when its
/// network template is gone, has another protocol, or no longer allows its TLS policy, and when
/// the secret template it uses changed `purpose` or `scope`, or began to need a credential: the
/// approver chose that secret for the old purpose. A secret template that is gone, or no longer
/// needs a credential, is a narrowing: the grant is carried without its secret binding.
fn carry(
    grant: &ConnectionGrant,
    from: &Capabilities,
    to: &InstalledPlugin,
) -> Option<(ConnectionGrant, bool)> {
    let template = to
        .capabilities
        .network
        .iter()
        .find(|t| t.id == grant.template_id && t.protocol == grant.protocol)?;
    match &grant.tls {
        TlsPolicy::Disabled if template.tls == TlsRequirement::Required => return None,
        TlsPolicy::Enabled(tls)
            if tls.mode == TlsMode::InProtocolUpgrade
                && !template.allow_in_protocol_tls_upgrade =>
        {
            return None;
        }
        _ => {}
    }
    let mut carried = grant.clone();
    carried.plugin = PluginBinding {
        plugin_id: to.id.clone(),
        digest: to.digest,
        driver_kind: to.driver_kind,
    };
    let mut narrowed = false;
    if carried.allow_cancel_connection && !template.allow_cancel_connection {
        carried.allow_cancel_connection = false;
        narrowed = true;
    }
    if let Some(secret) = &carried.secret {
        let old = from.secrets.iter().find(|t| t.id == secret.template_id)?;
        let new = to
            .capabilities
            .secrets
            .iter()
            .find(|t| t.id == secret.template_id);
        match new {
            None => {
                carried.secret = None;
                narrowed = true;
            }
            Some(new) => {
                if new.purpose != old.purpose
                    || new.scope != old.scope
                    || new.scope != SecretScope::Connection
                    || (new.needs_credential && !old.needs_credential)
                {
                    return None;
                }
                if old.needs_credential && !new.needs_credential {
                    carried.secret = None;
                    narrowed = true;
                }
            }
        }
    }
    Some((carried, narrowed))
}

/// How long a grant change, a broker operation or a package install step waits for its audit
/// entry to be written before failing closed, and how long a grant create waits for another
/// create of the same target. Provisional (Ambidex spec Open question 26).
pub const DEFAULT_AUDIT_TIMEOUT: Duration = Duration::from_secs(5);

/// Grant target (tenant, target id).
type TargetKey = (TenantId, String);

/// One async lock per grant target, kept only while a create holds or waits for it.
#[derive(Default)]
struct TargetLocks {
    locks: Mutex<HashMap<TargetKey, Arc<tokio::sync::Mutex<()>>>>,
}

/// A held [`TargetLocks`] lock, or a wait for one that gave up. Dropping it releases the lock
/// and forgets it when nobody else holds or waits for it.
struct TargetLock<'a> {
    locks: &'a TargetLocks,
    key: TargetKey,
    lock: Option<Arc<tokio::sync::Mutex<()>>>,
    guard: Option<tokio::sync::OwnedMutexGuard<()>>,
}

impl TargetLocks {
    /// Locks `key`, waiting at most `timeout`; `None` if another create held it that long.
    async fn lock(&self, key: &TargetKey, timeout: Duration) -> Option<TargetLock<'_>> {
        let lock = Arc::clone(lock(&self.locks).entry(key.clone()).or_default());
        let mut held = TargetLock {
            locks: self,
            key: key.clone(),
            lock: Some(Arc::clone(&lock)),
            guard: None,
        };
        // On a timeout `held` is dropped without a guard, which forgets an unused lock.
        held.guard = Some(
            tokio::time::timeout(timeout, lock.lock_owned())
                .await
                .ok()?,
        );
        Some(held)
    }
}

impl Drop for TargetLock<'_> {
    fn drop(&mut self) {
        self.guard.take();
        let mut locks = lock(&self.locks.locks);
        // The map's reference and ours: nobody else holds or waits for this lock.
        if let Some(mine) = self.lock.take()
            && Arc::strong_count(&mine) == 2
        {
            locks.remove(&self.key);
        }
    }
}

/// The grants of one host. In-memory; persistence belongs to the product's workspace/server store.
///
/// Grants with an expiry need a Tokio runtime: `create` starts a task that ends the grant at
/// `expires_at`, and fails with [`GrantError::Internal`] if it cannot.
///
/// Audit (Ambidex spec Open question 26h): a grant becomes usable only after its entry is written,
/// so a create fails closed with [`GrantError::Unavailable`] when the sink fails or does not
/// answer within the [audit timeout](GrantStore::with_audit_timeout). Creates of one target are
/// serialized; a create waits at most the audit timeout for the one ahead of it, then has the
/// audit timeout again for its own write. Creates of different targets run in parallel. A
/// revocation takes effect at once and
/// never waits on the sink; its entry is written in the background with retries
/// ([`GrantStore::flush_audit`] waits for it), and an entry that could not be written is reported
/// to the [`AuditReporter`].
///
/// # Plugin upgrades and rollback (Plugin Host spec, question 39)
///
/// A grant is bound to one plugin version (its package digest). When the installer activates a
/// new version, the grants of the old version are *parked* and each one the new version can
/// still use is *carried over*: a new grant with a new id, bound to the new version, with the
/// same destination, TLS policy, address policy, eligibility, approver and expiry. A carried
/// grant drops what the new version no longer requests (cancel connection, secret binding); a
/// grant whose network template is gone or no longer admits its TLS policy, or whose secret
/// template changed purpose or scope, is not carried (see `carry`).
/// Rollback parks the current version's grants and restores the parked grants of the version it
/// returns to, under their original ids. Only one parked set (the retained previous version) is
/// kept per plugin, matching the installer's retention. Only the installer switches versions,
/// under its per-plugin lock.
///
/// A carried or restored grant becomes active only after its audit entry is written (spec
/// question 42, see [`crate::install`]): the switch first ends and parks the old grants, then
/// activates each candidate under the lock of its target, entry first. The installer decides what
/// an audit failure means: a carry-over then does not take effect, while a restore does (spec
/// question 41).
///
/// Revocation wins over upgrades and rollback: revoking a grant by any id it had (the original,
/// or a carried copy) revokes every active grant carried from it and discards every parked grant
/// of the same plugin for the same tenant and target, so neither the new version nor a rollback
/// brings back a destination an administrator revoked. Parked sets live in memory only; after a
/// restart a rollback restores nothing and reports [`RestoreOutcome::NoParkedState`].
pub struct GrantStore {
    clock: Arc<dyn Clock>,
    audit: Arc<dyn AuditSink>,
    reporter: Arc<dyn AuditReporter>,
    audit_timeout: Duration,
    /// Per target, held across the target check, the audit write and the insert of one create.
    creating: TargetLocks,
    /// Revocation and expiry entries. Shared with the expiry tasks.
    queue: Arc<AuditQueue>,
    inner: Arc<Mutex<StoreInner>>,
}

impl GrantStore {
    /// A store reporting sink failures to stderr ([`StderrReporter`]) and waiting at most
    /// [`DEFAULT_AUDIT_TIMEOUT`] for the sink.
    pub fn new(clock: Arc<dyn Clock>, audit: Arc<dyn AuditSink>) -> Self {
        let reporter: Arc<dyn AuditReporter> = Arc::new(StderrReporter::new());
        Self {
            queue: Arc::new(AuditQueue::new(
                Arc::clone(&audit),
                Arc::clone(&reporter),
                RetryPolicy::default(),
            )),
            clock,
            audit,
            reporter,
            audit_timeout: DEFAULT_AUDIT_TIMEOUT,
            creating: TargetLocks::default(),
            inner: Arc::default(),
        }
    }

    /// Reports audit sink failures to `reporter` instead of stderr. Set it before using the store.
    #[must_use]
    pub fn with_audit_reporter(self, reporter: impl AuditReporter) -> Self {
        self.with_audit_reporter_and_retry(Arc::new(reporter), RetryPolicy::default())
    }

    /// How long a grant change or broker operation waits for the sink before failing closed.
    #[must_use]
    pub fn with_audit_timeout(mut self, timeout: Duration) -> Self {
        self.audit_timeout = timeout;
        self
    }

    /// Like [`GrantStore::with_audit_reporter`], also choosing how revocation entries are retried.
    #[must_use]
    pub fn with_audit_reporter_and_retry(
        mut self,
        reporter: Arc<dyn AuditReporter>,
        retry: RetryPolicy,
    ) -> Self {
        self.queue = Arc::new(AuditQueue::new(
            Arc::clone(&self.audit),
            Arc::clone(&reporter),
            retry,
        ));
        self.reporter = reporter;
        self
    }

    /// Completes once every revocation and expiry entry submitted so far is written, or given up after its
    /// retries and reported. Call it before shutting down.
    pub async fn flush_audit(&self) {
        self.queue.flushed().await;
    }

    pub(crate) fn clock(&self) -> &dyn Clock {
        &*self.clock
    }

    /// Writes `entry`, waiting at most the audit timeout. On failure the reporter hears about it
    /// with `effect`, and the caller decides (fail closed, or only report).
    pub(crate) async fn record(
        &self,
        entry: AuditEntry,
        effect: AuditFailureEffect,
    ) -> Result<(), ()> {
        let action = entry.action.name.clone();
        let correlation_id = entry.correlation_id.clone();
        let deadline = tokio::time::Instant::now() + self.audit_timeout;
        let Err(error) = append_within(&*self.audit, entry, deadline).await else {
            return Ok(());
        };
        self.report(effect, action, correlation_id, error);
        Err(())
    }

    fn report(
        &self,
        effect: AuditFailureEffect,
        action: String,
        correlation_id: String,
        error: AuditError,
    ) {
        self.reporter.report(&AuditFailure {
            entry: AuditEntryKind::Operation,
            effect,
            action,
            correlation_id,
            error,
            attempts: 1,
        });
    }

    /// Approve a connection: bind `plugin`'s template to the concrete endpoint in `req`.
    ///
    /// `approver` must be a human acting directly (the local user, or a tenant administrator) in
    /// the grant's tenant, and `authz` must allow [`GRANT_CREATE_PERM`]. A `NeedsApproval`
    /// decision is a denial: grant changes are not approval-gated here.
    ///
    /// The grant is usable only once its audit entry is written. If the sink fails, or the entry
    /// is not written within the audit timeout, or a create of the same target ahead of this one
    /// holds it longer than the audit timeout, the create fails closed with
    /// [`GrantError::Unavailable`] and nothing is granted.
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
        let entry = |decision: AuditDecision, outcome: Outcome| AuditEntry {
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
            delivery: None,
            parent_correlation_id: None,
            detail: None,
        };

        if let Err(reason) = self
            .authorize(authz, approver, &req.tenant, &action, &target, input_digest)
            .await
        {
            let err = GrantError::Denied(reason.clone());
            // Refused whether or not the refusal is recorded.
            let _ = self
                .record(
                    entry(AuditDecision::Deny { reason }, err.outcome()),
                    AuditFailureEffect::EntryLost,
                )
                .await;
            return Err(err);
        }

        let result = self
            .create_authorized(plugin, req.clone(), approver, || {
                entry(AuditDecision::Allow, Outcome::Success)
            })
            .await;
        if let Err(e) = &result
            && !matches!(e, GrantError::Internal | GrantError::Unavailable)
        {
            let _ = self
                .record(
                    entry(AuditDecision::Allow, e.outcome()),
                    AuditFailureEffect::EntryLost,
                )
                .await;
        }
        result
    }

    /// The part of `create` after authorization. `granted` builds the entry that is written
    /// before the grant becomes usable.
    async fn create_authorized(
        &self,
        plugin: &InstalledPlugin,
        req: GrantRequest,
        approver: &Principal,
        granted: impl FnOnce() -> AuditEntry,
    ) -> Result<Arc<ConnectionGrant>, GrantError> {
        let grant = self.build(plugin, req, approver)?;
        // The expiry task needs a runtime; without one the grant could not end on time.
        let runtime = match grant.expires_at_unix_ms {
            Some(_) => {
                Some(tokio::runtime::Handle::try_current().map_err(|_| GrantError::Internal)?)
            }
            None => None,
        };
        // Creates of one target run one at a time, so no other create can take it between the
        // check below and the insert, while the audit write is awaited in between. The wait is
        // bounded, so a create stuck on a hung sink makes the ones behind it fail closed too.
        let key = (grant.tenant.clone(), grant.target_id.clone());
        let Some(_creating) = self.creating.lock(&key, self.audit_timeout).await else {
            self.report(
                AuditFailureEffect::Blocked,
                GRANT_CREATE_ACTION.to_owned(),
                granted().correlation_id,
                AuditError("timed out waiting for another create of this target".into()),
            );
            return Err(GrantError::Unavailable);
        };
        if lock(&self.inner)
            .active_entry(&key, self.clock.now_unix_ms())
            .is_some()
        {
            return Err(GrantError::TargetInUse);
        }
        // Audit before the grant becomes usable; if auditing fails, nothing is granted.
        self.record(granted(), AuditFailureEffect::Blocked)
            .await
            .map_err(|()| GrantError::Unavailable)?;
        let grant = Arc::new(grant);
        let entry = Arc::new(GrantEntry::new(grant.clone()));
        {
            let mut inner = lock(&self.inner);
            // A plugin upgrade or rollback switches grants without this target lock, so the
            // target may have been taken while the audit entry was written.
            if inner.active_entry(&key, self.clock.now_unix_ms()).is_some() {
                return Err(GrantError::TargetInUse);
            }
            inner.active.insert(key, grant.id.clone());
            inner.by_id.insert(grant.id.clone(), entry.clone());
        }
        if let (Some(runtime), Some(expires_at)) = (runtime, grant.expires_at_unix_ms) {
            runtime.spawn(expire_at(
                self.clock.clone(),
                self.queue.clone(),
                Arc::downgrade(&self.inner),
                Arc::downgrade(&entry),
                entry.state(),
                expires_at,
            ));
        }
        Ok(grant)
    }

    /// Revoke a grant and close every handle opened under it.
    ///
    /// The revocation takes effect before anything is written and never waits on the audit sink.
    /// Its entry (and a denied attempt's) is written right away when the sink answers at once,
    /// otherwise in the background with retries; see [`GrantStore::flush_audit`]. An entry that
    /// cannot be written is reported to the [`AuditReporter`], and `Ok` is still returned: the
    /// grant is revoked.
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
        let audit_entry = AuditEntry {
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
            delivery: None,
            parent_correlation_id: None,
            detail: None,
        };
        if result.is_ok() {
            // Revocation removes access, so it happens first and never waits on the sink.
            let mut inner = lock(&self.inner);
            inner.active.retain(|_, active_id| active_id != &grant.id);
            entry.end(EntryState::Revoked);
            // Grants carried from this one (through any number of upgrades) are revoked too.
            let descendants: Vec<_> = inner
                .active
                .values()
                .filter(|id| inner.descends_from(id, &grant.id))
                .cloned()
                .collect();
            for id in descendants {
                inner.active.retain(|_, active_id| active_id != &id);
                if let Some(carried) = inner.by_id.get(&id) {
                    carried.end(EntryState::Revoked);
                }
            }
            // A grant a switch is about to activate counts as well: it must not become active.
            let pending: Vec<_> = inner
                .pending
                .values()
                .filter(|g| {
                    g.id == grant.id
                        || inner.descends_from(&g.id, &grant.id)
                        || (g.plugin.plugin_id == grant.plugin.plugin_id
                            && g.tenant == grant.tenant
                            && g.target_id == grant.target_id)
                })
                .map(|g| g.id.clone())
                .collect();
            for id in pending {
                inner.pending.remove(&id);
            }
            if let Some(parked) = inner.parked.get_mut(&grant.plugin.plugin_id) {
                parked.grants.retain(|g| {
                    g.id != grant.id && (g.tenant != grant.tenant || g.target_id != grant.target_id)
                });
            }
        }
        self.queue.submit(audit_entry).await;
        result
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

    /// Insert `grant` as the active grant of `key`, with an expiry task if it expires.
    fn insert_active(
        &self,
        inner: &mut StoreInner,
        key: TargetKey,
        grant: &Arc<ConnectionGrant>,
        runtime: Option<tokio::runtime::Handle>,
    ) {
        let entry = Arc::new(GrantEntry::new(grant.clone()));
        inner.active.insert(key, grant.id.clone());
        inner.by_id.insert(grant.id.clone(), entry.clone());
        if let (Some(runtime), Some(expires_at)) = (runtime, grant.expires_at_unix_ms) {
            runtime.spawn(expire_at(
                self.clock.clone(),
                self.queue.clone(),
                Arc::downgrade(&self.inner),
                Arc::downgrade(&entry),
                entry.state(),
                expires_at,
            ));
        }
    }

    /// Upgrade, first half: end the grants of version `from` of `to.id`, park them, and return
    /// the grants `to` can use as candidates. Nothing new is active yet: each candidate becomes
    /// active through [`activate_audited`](Self::activate_audited), after its audit entry. The
    /// caller holds the plugin's install lock and has already made `to` the active version.
    ///
    /// `from_capabilities` is what the old version requested; `None` (its manifest could not be
    /// read) carries nothing, so every old grant stays parked and needs a new approval.
    pub(crate) fn begin_upgrade(
        &self,
        from: Digest,
        from_capabilities: Option<&Capabilities>,
        to: &InstalledPlugin,
    ) -> (Vec<Candidate>, GrantSwitch) {
        let now = self.clock.now_unix_ms();
        let mut inner = lock(&self.inner);
        let old = inner.supersede(&to.id, from, now);
        let mut out = GrantSwitch {
            parked: old.iter().map(|g| g.id.clone()).collect(),
            ..GrantSwitch::default()
        };
        let mut candidates = Vec::new();
        for grant in &old {
            let carried = from_capabilities
                .and_then(|from| carry(grant, from, to))
                .and_then(|(mut carried, narrowed)| {
                    carried.id = GrantId::random().ok()?;
                    Some((carried, narrowed))
                });
            let Some((carried, narrowed)) = carried else {
                out.dropped.push(grant.id.clone());
                continue;
            };
            let carried = Arc::new(carried);
            inner.lineage.insert(carried.id.clone(), grant.id.clone());
            inner.pending.insert(carried.id.clone(), carried.clone());
            candidates.push(Candidate {
                grant: carried,
                source: grant.clone(),
                narrowed,
            });
        }
        // One previous version is retained, so this replaces any older parked set.
        inner.parked.insert(
            to.id.clone(),
            Parked {
                digest: from,
                grants: old,
            },
        );
        (candidates, out)
    }

    /// Rollback of `plugin_id` from version `from` to version `to`, first half: end the grants
    /// of `from`, park them, and return the parked grants of `to` as candidates (see
    /// [`begin_upgrade`](Self::begin_upgrade)). The caller holds the plugin's install lock and
    /// has already made `to` the active version.
    pub(crate) fn begin_roll_back(
        &self,
        plugin_id: &str,
        from: Digest,
        to: Digest,
    ) -> (Vec<Candidate>, GrantSwitch) {
        let now = self.clock.now_unix_ms();
        let mut inner = lock(&self.inner);
        let current = inner.supersede(plugin_id, from, now);
        let mut out = GrantSwitch {
            parked: current.iter().map(|g| g.id.clone()).collect(),
            ..GrantSwitch::default()
        };
        let parked = inner.parked.remove(plugin_id).filter(|p| p.digest == to);
        out.restore = if parked.is_some() {
            RestoreOutcome::Restored
        } else {
            RestoreOutcome::NoParkedState
        };
        let mut candidates = Vec::new();
        for grant in parked.into_iter().flat_map(|p| p.grants) {
            inner.pending.insert(grant.id.clone(), grant.clone());
            candidates.push(Candidate {
                source: grant.clone(),
                grant,
                narrowed: false,
            });
        }
        inner.parked.insert(
            plugin_id.to_owned(),
            Parked {
                digest: from,
                grants: current,
            },
        );
        (candidates, out)
    }

    /// Second half of a version switch: make the candidate the active grant of its target, but
    /// only after `record` has written its audit entry, so the entry and the grant never come
    /// apart. Like `create`, it holds the target's lock from the check through the entry to the
    /// insert; the entry is written first and the grant becomes active right after, so a
    /// crash in between leaves an entry without a grant, never a grant without an entry.
    ///
    /// `record` is called at most once and decides what an audit failure means: `Err` means the
    /// grant stays inactive (fail closed); a rollback passes a `record` that falls back instead
    /// and so returns `Ok` (spec question 41).
    pub(crate) async fn activate_audited<T, E, Fut>(
        &self,
        candidate: &Candidate,
        record: impl FnOnce() -> Fut,
    ) -> ActivateOutcome<T, E>
    where
        Fut: std::future::Future<Output = Result<T, E>>,
    {
        let grant = &candidate.grant;
        let key = (grant.tenant.clone(), grant.target_id.clone());
        let runtime = match grant.expires_at_unix_ms {
            Some(_) => match tokio::runtime::Handle::try_current() {
                Ok(runtime) => Some(runtime),
                Err(_) => return self.skip(grant),
            },
            None => None,
        };
        let Some(_target) = self.creating.lock(&key, self.audit_timeout).await else {
            return self.skip(grant);
        };
        {
            let mut inner = lock(&self.inner);
            let now = self.clock.now_unix_ms();
            if !inner.pending.contains_key(&grant.id) {
                return ActivateOutcome::Skipped;
            }
            if grant.is_expired(now) {
                inner.pending.remove(&grant.id);
                return ActivateOutcome::Skipped;
            }
            if inner.active_entry(&key, now).is_some() {
                inner.pending.remove(&grant.id);
                return ActivateOutcome::Skipped;
            }
        }
        let recorded = match record().await {
            Ok(recorded) => recorded,
            Err(e) => {
                lock(&self.inner).pending.remove(&grant.id);
                return ActivateOutcome::Refused(e);
            }
        };
        let mut inner = lock(&self.inner);
        // Revoked while the entry was written: the revocation wins.
        if inner.pending.remove(&grant.id).is_none() {
            return ActivateOutcome::Skipped;
        }
        if inner.active_entry(&key, self.clock.now_unix_ms()).is_some() {
            return ActivateOutcome::Skipped;
        }
        self.insert_active(&mut inner, key, grant, runtime);
        ActivateOutcome::Activated(recorded)
    }

    fn skip<T, E>(&self, grant: &ConnectionGrant) -> ActivateOutcome<T, E> {
        lock(&self.inner).pending.remove(&grant.id);
        ActivateOutcome::Skipped
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
/// transport opened under it, frees its target, and writes the expiry's audit entry. It also
/// writes the entry when the store noticed the expiry first (a `create` or `lookup` that compared
/// the clock). It stops without an entry if the grant is revoked or replaced first. It holds only
/// weak references to the store and the grant, so it never keeps either alive; the audit queue it
/// holds lives as long as the grant has a reference.
async fn expire_at(
    clock: Arc<dyn Clock>,
    queue: Arc<AuditQueue>,
    store: Weak<Mutex<StoreInner>>,
    entry: Weak<GrantEntry>,
    mut state: watch::Receiver<EntryState>,
    expires_at: u64,
) {
    tokio::select! {
        () = clock.sleep_until(expires_at) => {}
        // Ended some other way; `false` when every reference to the grant is gone.
        alive = async { state.wait_for(|s| *s != EntryState::Active).await.is_ok() } => {
            if !alive {
                return;
            }
        }
    }
    let Some(entry) = entry.upgrade() else {
        return;
    };
    // No effect on a grant that has already ended.
    let now = clock.now_unix_ms();
    match store.upgrade() {
        Some(store) => lock(&store).expire(&entry, now),
        None => entry.expire(now),
    }
    let expiry = lock(&entry.expiry).take();
    if let Some(expiry) = expiry {
        queue.submit(expiry_entry(&entry.grant, expiry)).await;
    }
}

/// The audit entry of an enforced expiry (see the module docs).
fn expiry_entry(grant: &ConnectionGrant, expiry: Expiry) -> AuditEntry {
    let record = GrantExpiryRecord {
        grant_id: &grant.id,
        tenant: &grant.tenant,
        target_id: &grant.target_id,
        // Only a grant with an expiry has an expiry task.
        expires_at_unix_ms: grant.expires_at_unix_ms.unwrap_or_default(),
        enforced_at_unix_ms: expiry.enforced_at_unix_ms,
        transports_closed: expiry.closed.transports,
        operations_aborted: expiry.closed.in_flight,
    };
    AuditEntry {
        timestamp_unix_ms: expiry.enforced_at_unix_ms,
        principal_chain: vec![AuditPrincipal {
            kind: PrincipalKind::System,
            id: GRANT_EXPIRY_PRINCIPAL.into(),
            tenant: grant.tenant.clone(),
            session: SessionId::new(GRANT_EXPIRY_SESSION),
        }],
        tenant: grant.tenant.clone(),
        action: Action::new(GRANT_EXPIRE_ACTION, GRANT_EXPIRE_PERM),
        target: Some(TargetRef::connection(&grant.target_id)),
        risk: Risk::Write,
        decision: AuditDecision::Allow,
        approval_id: Some(grant.id.to_string()),
        outcome: Outcome::Success,
        duration_ms: None,
        correlation_id: format!("expire:{}", grant.id),
        input_digest: grant_expire_digest(&record),
        statement_digest: None,
        delivery: None,
        parent_correlation_id: None,
        detail: grant_expire_detail(&record),
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

    #[test]
    fn switch_detail_clips_text_the_host_does_not_control() {
        let req = minimal();
        let grant = ConnectionGrant {
            id: GrantId("grant-1".into()),
            plugin: PluginBinding {
                plugin_id: plugin().id,
                digest: plugin().digest,
                driver_kind: DriverKind::Wasm,
            },
            tenant: req.tenant,
            owner: req.owner,
            eligible: req.eligible,
            connection_id: req.connection_id,
            target_id: req.target_id,
            template_id: req.template_id,
            protocol: Protocol::Tcp,
            host: Host::Dns("db.test".into()),
            port: req.port,
            tls: req.tls,
            addresses: req.addresses,
            secret: None,
            allow_cancel_connection: false,
            created_at_unix_ms: 0,
            expires_at_unix_ms: None,
            approver: AuditPrincipal {
                kind: PrincipalKind::Human,
                id: format!("human:oidc:{}", "a".repeat(400)),
                tenant: TenantId::new("t1"),
                session: SessionId::new("s\n1"),
            },
        };
        let long = "9".repeat(10_000);
        let record = GrantSwitchRecord {
            plugin_id: "org.example.pg",
            from_digest: Digest([1; 32]),
            from_version: "",
            to_digest: Digest([2; 32]),
            to_version: &format!("2.0\u{1b}[31m{long}"),
            old: &grant,
            new: &grant,
        };
        let detail = grant_switch_detail(&record).expect("always within the limits");
        // An unreadable source manifest and a grant without expiry leave their keys out.
        assert_eq!(detail.get("from_version"), None);
        assert_eq!(detail.get("expires_at_unix_ms"), None);
        let version = detail.get("to_version").unwrap();
        assert!(version.starts_with("2.0\u{fffd}[31m999") && version.ends_with('…'));
        assert_eq!(version.len(), AuditDetail::MAX_VALUE_BYTES);
        assert!(detail.get("approver").unwrap().ends_with('…'));
        assert_eq!(detail.get("approver_session"), Some("s\u{fffd}1"));
        assert_eq!(
            detail.get("from_digest").unwrap(),
            format!("sha256:{}", "01".repeat(32))
        );
        // The digest still covers the exact values.
        let exact = grant_switch_digest(GRANT_CARRY_DIGEST_DOMAIN, &record);
        let clipped = GrantSwitchRecord {
            to_version: version,
            ..record
        };
        assert_ne!(
            grant_switch_digest(GRANT_CARRY_DIGEST_DOMAIN, &clipped),
            exact
        );
    }
}
