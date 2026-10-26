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
    InstalledPlugin, PluginBinding, SecretBinding, TlsMode, TlsPolicy, TrustRoots,
};
pub use manifest::{Manifest, ManifestError, NetworkTemplate};
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
