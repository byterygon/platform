//! Connection grants (Plugin Host spec §3).
//!
//! Creating a connection *is* the grant: the approver binds an installed plugin's network template
//! to one exact host, port, TLS policy, address policy and secret reference, for a tenant and a set
//! of eligible principals. The broker opens nothing without an active grant for the target.
//!
//! Grants are immutable. Changing the destination, TLS policy or anything else means revoking the
//! grant and approving a new one. Revoking closes every handle opened under the grant.

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
use tokio::sync::watch;

use crate::audit::{AuditSink, Clock};
use crate::manifest::{Capabilities, Manifest, PackageKind, Protocol, SecretScope, TlsRequirement};
use crate::net::{AddressPolicy, IpNet, normalize_dns_name};
use crate::{encode_digest, error_code};

/// Action and permission checked when a grant is created or revoked.
///
/// NOTE: provisional names (Plugin Host spec, Open question 13, accepted as provisional by Uy Son
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
/// (Plugin Host spec, Open question 14). The broker applies it to data and cancel connections
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
    /// The target already has an active grant; revoke it first.
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

pub(crate) struct GrantEntry {
    pub(crate) grant: Arc<ConnectionGrant>,
    revoked: watch::Sender<bool>,
    handles: Mutex<Vec<Weak<dyn Revocable>>>,
}

impl GrantEntry {
    pub(crate) fn revoked(&self) -> watch::Receiver<bool> {
        self.revoked.subscribe()
    }

    pub(crate) fn is_revoked(&self) -> bool {
        *self.revoked.borrow()
    }

    /// Track a handle so revocation can close it. Returns `false` (and tracks nothing) if the
    /// grant was revoked in the meantime.
    pub(crate) fn track(&self, handle: Weak<dyn Revocable>) -> bool {
        let mut handles = lock(&self.handles);
        if self.is_revoked() {
            return false;
        }
        handles.retain(|h| h.strong_count() > 0);
        handles.push(handle);
        true
    }

    fn revoke(&self) {
        let handles = {
            let mut handles = lock(&self.handles);
            self.revoked.send_replace(true);
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
    active: HashMap<(TenantId, String), GrantId>,
}

/// The grants of one host. In-memory; persistence belongs to the product's workspace/server store.
pub struct GrantStore {
    clock: Arc<dyn Clock>,
    audit: Arc<dyn AuditSink>,
    inner: Mutex<StoreInner>,
}

impl GrantStore {
    pub fn new(clock: Arc<dyn Clock>, audit: Arc<dyn AuditSink>) -> Self {
        Self {
            clock,
            audit,
            inner: Mutex::default(),
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
        let input_digest = encode_digest(
            "byterygon.plugin-host.grant.create.v1",
            &[
                req.tenant.as_str().as_bytes(),
                req.target_id.as_bytes(),
                req.connection_id.as_bytes(),
                plugin.id.as_bytes(),
                plugin.digest.as_bytes(),
                req.template_id.as_bytes(),
                req.host.as_bytes(),
                &req.port.to_be_bytes(),
            ],
        );
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
            let mut inner = lock(&self.inner);
            let key = (grant.tenant.clone(), grant.target_id.clone());
            if inner.active.contains_key(&key) {
                return Err(GrantError::TargetInUse);
            }
            let grant = Arc::new(grant);
            // Audit before the grant becomes usable; if auditing fails, nothing is granted.
            audit(AuditDecision::Allow, Outcome::Success).map_err(|_| GrantError::Internal)?;
            let entry = Arc::new(GrantEntry {
                grant: grant.clone(),
                revoked: watch::Sender::new(false),
                handles: Mutex::default(),
            });
            inner.active.insert(key, grant.id.clone());
            inner.by_id.insert(grant.id.clone(), entry);
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
            entry.revoke();
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

    /// The active grant for a target in a tenant.
    pub(crate) fn lookup(&self, tenant: &TenantId, target_id: &str) -> Option<Arc<GrantEntry>> {
        let inner = lock(&self.inner);
        let id = inner.active.get(&(tenant.clone(), target_id.to_owned()))?;
        inner.by_id.get(id).cloned()
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

/// Convenience for address policies written as strings in tests and config.
pub fn address_policy(nets: &[&str]) -> Result<AddressPolicy, crate::net::ParseIpNetError> {
    nets.iter()
        .map(|s| s.parse::<IpNet>())
        .collect::<Result<Vec<_>, _>>()
        .map(AddressPolicy::new)
}
