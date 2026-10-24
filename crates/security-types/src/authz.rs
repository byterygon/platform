//! Authorization request and decision (Ambidex spec §8).

use std::future::Future;

use serde::{Deserialize, Serialize};

use crate::{Digest, Permission, Principal};

/// How dangerous an operation is. Ordered: `Read < Write < Destructive`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Risk {
    Read,
    Write,
    Destructive,
}

impl Risk {
    /// Handlers may raise the baseline risk at runtime (e.g. SQL classified as DDL), never lower it.
    #[must_use]
    pub fn escalate(self, to: Risk) -> Risk {
        self.max(to)
    }
}

/// The operation being authorized, independent of how it is transported.
///
/// Ambidex builds it from its procedure metadata, Plugin Host from a plugin operation, so neither
/// depends on the other.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    /// Procedure or operation name, e.g. `"query.execute"` or `"plugin.<plugin-id>.<op>"`.
    pub name: String,
    /// Permission the operation requires, e.g. `"db.query.execute"`.
    pub perm: Permission,
}

impl Action {
    pub fn new(name: impl Into<String>, perm: impl Into<Permission>) -> Self {
        Self {
            name: name.into(),
            perm: perm.into(),
        }
    }
}

/// The resource an operation acts on, e.g. a connection or a plugin.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetRef {
    pub kind: String,
    pub id: String,
}

impl TargetRef {
    pub fn new(kind: impl Into<String>, id: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            id: id.into(),
        }
    }

    pub fn connection(id: impl Into<String>) -> Self {
        Self::new("connection", id)
    }

    pub fn plugin(id: impl Into<String>) -> Self {
        Self::new("plugin", id)
    }
}

/// Input to the [`Authorizer`]. Runs before dispatch, and again inside handlers for targets and
/// runtime risk.
#[derive(Debug, Clone, Copy)]
pub struct AuthzRequest<'a> {
    pub principal: &'a Principal,
    pub action: &'a Action,
    pub target: Option<&'a TargetRef>,
    pub risk: Risk,
    pub input_digest: Digest,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Decision {
    Allow,
    Deny { reason: Reason },
    NeedsApproval { approval: ApprovalSpec },
}

impl Decision {
    pub fn is_allow(&self) -> bool {
        matches!(self, Decision::Allow)
    }
}

/// Why a request was denied. Safe to show to the caller: never contains secrets or SQL values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Reason {
    /// The required permission is not known to the policy (default-deny).
    UnknownPermission { perm: Permission },
    /// The effective permission set does not contain the required permission.
    MissingPermission { perm: Permission },
    /// The `on_behalf_of` chain crosses tenants.
    TenantMismatch,
    /// Denied by tenant or deployment policy.
    Policy { message: String },
}

/// What a human must approve. The approval is bound to the action, target, input digest and expiry
/// (Ambidex spec §8, Plugin Host spec §6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalSpec {
    pub action: Action,
    pub target: Option<TargetRef>,
    pub risk: Risk,
    pub input_digest: Digest,
    pub expires_at_unix_ms: u64,
}

pub trait Authorizer: Send + Sync + 'static {
    fn check(&self, req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_only_escalates() {
        assert_eq!(Risk::Read.escalate(Risk::Destructive), Risk::Destructive);
        assert_eq!(Risk::Destructive.escalate(Risk::Read), Risk::Destructive);
        assert_eq!(Risk::Write.escalate(Risk::Write), Risk::Write);
    }

    #[test]
    fn decision_serde_is_tagged() {
        let d = Decision::Deny {
            reason: Reason::MissingPermission {
                perm: "db.query.execute".into(),
            },
        };
        let json = serde_json::to_value(&d).unwrap();
        assert_eq!(json["kind"], "Deny");
        assert_eq!(json["reason"]["kind"], "MissingPermission");
        assert_eq!(json["reason"]["perm"], "db.query.execute");
        assert_eq!(serde_json::from_value::<Decision>(json).unwrap(), d);
    }
}
