//! Security types shared by Ambidex and Plugin Host (Ambidex spec §8, Plugin Host spec §7).
//!
//! Neither library depends on the other for these types: both build an [`AuthzRequest`] from
//! their own metadata (procedure or plugin operation) and emit the same [`AuditRecord`] format.
//!
//! - [`principal`]: who is acting, including the `on_behalf_of` chain.
//! - [`authz`]: the authorization request, decision and risk, and the [`Authorizer`] hook.
//! - [`permissions`]: effective permissions as the intersection along the `on_behalf_of` chain.
//! - [`audit`]: the audit record and its SHA-256 hash chain.
//! - [`sink`]: the asynchronous [`AuditSink`] both libraries write to, and [`MemoryAuditLog`].
//! - [`report`]: how sink failures reach operators ([`AuditReporter`], [`StderrReporter`]).
//! - [`clock`]: the [`Clock`] both libraries stamp entries with; `SystemClock` with feature `tokio`.
//! - [`correlation`]: the shared correlation-id generator.
//!
//! Runtime-free by default: the only async runtime code (`SystemClock`'s timer and the bounded
//! writes `append_within`/`write_within`) is behind the `tokio` feature.

pub mod audit;
pub mod authz;
pub mod clock;
pub mod correlation;
mod digest;
pub mod permissions;
pub mod principal;
pub mod report;
pub mod sink;

pub use audit::{
    AuditChain, AuditDecision, AuditDetail, AuditEntry, AuditPrincipal, AuditRecord, ChainError,
    Delivery, DetailError, Outcome, unfinished,
};
pub use authz::{
    Action, ApprovalSpec, Authorizer, AuthzRequest, Decision, Reason, Risk, TargetRef,
};
#[cfg(feature = "tokio")]
pub use clock::{CLOCK_RECHECK, SystemClock};
pub use clock::{Clock, unix_now_ms};
pub use correlation::{CorrelationIdError, new_correlation_id};
pub use digest::{Digest, ParseDigestError};
pub use permissions::{Permission, PermissionSet, RolePermissions, effective_permissions};
pub use principal::{Principal, PrincipalKind, RoleId, SessionId, TenantId};
pub use report::{AuditEntryKind, AuditFailure, AuditFailureEffect, AuditReporter, StderrReporter};
pub use sink::{AuditError, AuditSink, BoxFuture, MemoryAuditLog};
#[cfg(feature = "tokio")]
pub use sink::{append_within, write_within};
