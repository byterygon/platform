//! Plugin Host (Plugin Host spec). This crate currently holds the native connection broker and
//! connection grants (spec §3, TSK-14):
//!
//! - [`manifest`]: capability templates a plugin manifest requests. A template is not a grant.
//! - [`grant`]: connection grants. Creating a connection binds host, port, TLS policy, address
//!   policy and secret reference to one target; that grant is the effective network permission.
//! - [`broker`]: the native broker every driver (native or WASM) must open connections through.
//!   It resolves names itself, checks addresses at connect time, verifies TLS (including
//!   in-protocol `start_tls`), audits every open and closes handles when a grant is revoked.
//! - [`net`]: address policy and host-side resolution.
//! - [`audit`]: audit sink and clock.
//!
//! Identity, authorization and the audit record come from `security-types`; Plugin Host does not
//! depend on Ambidex.
//!
//! # Security decisions
//!
//! Recorded in the Plugin Host spec, Open questions 12–17 (Uy Son, 2026-10-26):
//!
//! 1. **Who approves grants (12).** Only a human acting directly (no `on_behalf_of`) creates or
//!    revokes a grant. Agents cannot, with or without approval; an `Authorizer` `NeedsApproval`
//!    decision is a denial.
//! 2. **Names (13).** Action and permission names are provisional; see the `NOTE` on the
//!    constants in [`grant`] and [`broker`].
//! 3. **Transport security (14).** Self-hosted databases often run without TLS or with
//!    self-signed certificates. The approver picks one [`TlsPolicy`] per connection:
//!    - [`TlsPolicy::Disabled`]: plaintext, only if the template says `tls = "optional"`;
//!    - TLS with [`ServerTrust::DeploymentCas`] or [`ServerTrust::PinnedCas`] (chain, name and
//!      validity checked);
//!    - TLS with [`ServerTrust::PinnedCertificates`] for self-signed certificates (exact
//!      certificate by SHA-256; name and validity not checked; handshake signature checked).
//!
//!    There is no "accept any certificate" mode and no fallback from TLS to plaintext.
//! 4. **Cancel connections (15).** A cancel connection follows exactly the data connection's
//!    policy: same endpoint, address checks, TLS policy and audit. With an in-protocol upgrade,
//!    the driver negotiates and calls `start_tls` before sending the cancel request, as on the
//!    data connection (PostgreSQL: `SSLRequest` then `CancelRequest`; MySQL: a normal TLS login
//!    then `KILL QUERY`). The broker allows at most
//!    [`BrokerLimits::pre_tls_plaintext_bytes`] of plaintext before `start_tls` on any
//!    upgrade-mode handle. It cannot tell negotiation bytes from protocol bytes, so first-party
//!    drivers are held to "upgrade first" by code review and tests.
//! 5. **Address policy (16).** Every grant carries an explicit allowlist. The connection form
//!    proposes [`AddressPolicy::loopback`] (`127.0.0.1`, `::1`); the approver widens it for
//!    remote databases.
//! 6. **Eligibility and limits (17).** Every principal in the caller's `on_behalf_of` chain must
//!    be in the grant's tenant and be eligible (listed by id or by role). The plugin is checked
//!    through its binding (id, digest, driver kind) and is audited as the first principal of the
//!    chain. The defaults are in [`BrokerLimits`].

pub mod audit;
pub mod broker;
pub mod grant;
pub mod manifest;
pub mod net;

pub use audit::{AuditError, AuditSink, Clock, MemoryAuditLog, SystemClock};
pub use broker::{
    BrokerConfig, BrokerError, BrokerLimits, BrokerScope, Caller, NativeBroker, Purpose, Transport,
};
pub use grant::{
    ConnectionGrant, DriverKind, Eligibility, GrantError, GrantId, GrantRequest, GrantStore, Host,
    InstalledPlugin, PluginBinding, SecretBinding, ServerTrust, TlsMode, TlsPolicy, TlsSettings,
};
pub use manifest::{Manifest, ManifestError, NetworkTemplate, TlsRequirement};
pub use net::{AddressPolicy, IpNet, Resolver, SystemResolver};

use security_types::Digest;
use sha2::{Digest as _, Sha256};

/// Error codes used in audit outcomes. They match the `db-error` variant names of the db-driver
/// contract where one exists.
pub mod error_code {
    pub const PERMISSION_DENIED: &str = "PermissionDenied";
    pub const TLS_FAILED: &str = "TlsFailed";
    pub const CONNECTION_LOST: &str = "ConnectionLost";
    pub const TIMEOUT: &str = "Timeout";
    pub const UNSUPPORTED: &str = "Unsupported";
    pub const LIMIT_EXCEEDED: &str = "LimitExceeded";
    pub const INVALID_ARGUMENT: &str = "InvalidArgument";
    pub const FAILED_PRECONDITION: &str = "FailedPrecondition";
    pub const NOT_FOUND: &str = "NotFound";
    pub const INTERNAL: &str = "Internal";
}

/// SHA-256 over a domain separator and length-prefixed parts, for audit `input_digest`s.
pub(crate) fn encode_digest(domain: &str, parts: &[&[u8]]) -> Digest {
    let mut h = Sha256::new();
    h.update(domain.as_bytes());
    h.update([0]);
    for part in parts {
        h.update((part.len() as u64).to_le_bytes());
        h.update(part);
    }
    Digest(h.finalize().into())
}
