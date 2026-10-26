//! Security types shared by Ambidex and Plugin Host (Ambidex spec §8, Plugin Host spec §7).
//!
//! Neither library depends on the other for these types: both build an [`AuthzRequest`] from
//! their own metadata (procedure or plugin operation) and emit the same [`AuditRecord`] format.
//!
//! - [`principal`]: who is acting, including the `on_behalf_of` chain.
//! - [`authz`]: the authorization request, decision and risk, and the [`Authorizer`] hook.
//! - [`permissions`]: effective permissions as the intersection along the `on_behalf_of` chain.
//! - [`audit`]: the audit record and its SHA-256 hash chain.

pub mod audit;
pub mod authz;
mod digest;
pub mod permissions;
pub mod principal;

pub use audit::{
    AuditChain, AuditDecision, AuditEntry, AuditPrincipal, AuditRecord, ChainError, Outcome,
};
pub use authz::{
    Action, ApprovalSpec, Authorizer, AuthzRequest, Decision, Reason, Risk, TargetRef,
};
pub use digest::{Digest, ParseDigestError};
pub use permissions::{Permission, PermissionSet, RolePermissions, effective_permissions};
pub use principal::{Principal, PrincipalKind, RoleId, SessionId, TenantId};
