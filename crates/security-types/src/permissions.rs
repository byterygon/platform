//! Effective permissions along the `on_behalf_of` chain (Ambidex spec §8, Plugin Host spec §3).
//!
//! Effective permission is the intersection of the principal's roles, every principal in its
//! `on_behalf_of` chain, tenant policy and (for plugin targets) the Plugin Host grants. This module
//! computes the chain part; callers intersect the result with tenant policy and grants using
//! [`PermissionSet::intersect`].

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::principal::string_id;
use crate::{Principal, RoleId, TenantId};

string_id!(
    /// A permission name, e.g. `"db.query.execute"`. Matched exactly; there are no wildcards.
    Permission
);

impl From<&str> for Permission {
    fn from(s: &str) -> Self {
        Permission::new(s)
    }
}

impl From<String> for Permission {
    fn from(s: String) -> Self {
        Permission(s)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct PermissionSet(BTreeSet<Permission>);

impl PermissionSet {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn contains(&self, perm: &Permission) -> bool {
        self.0.contains(perm)
    }

    pub fn insert(&mut self, perm: impl Into<Permission>) -> bool {
        self.0.insert(perm.into())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Permission> {
        self.0.iter()
    }

    #[must_use]
    pub fn intersect(&self, other: &PermissionSet) -> PermissionSet {
        PermissionSet(self.0.intersection(&other.0).cloned().collect())
    }

    #[must_use]
    pub fn union(&self, other: &PermissionSet) -> PermissionSet {
        PermissionSet(self.0.union(&other.0).cloned().collect())
    }
}

impl<P: Into<Permission>> FromIterator<P> for PermissionSet {
    fn from_iter<I: IntoIterator<Item = P>>(iter: I) -> Self {
        PermissionSet(iter.into_iter().map(Into::into).collect())
    }
}

/// Resolves the permissions granted by one role in one tenant. Unknown roles grant nothing.
pub trait RolePermissions {
    fn role_permissions(&self, tenant: &TenantId, role: &RoleId) -> PermissionSet;
}

impl<F> RolePermissions for F
where
    F: Fn(&TenantId, &RoleId) -> PermissionSet,
{
    fn role_permissions(&self, tenant: &TenantId, role: &RoleId) -> PermissionSet {
        self(tenant, role)
    }
}

/// The permissions `principal` holds after intersecting every principal in its `on_behalf_of`
/// chain. Each principal contributes the union of its roles' permissions.
///
/// Fails closed: if any principal in the chain belongs to a different tenant than `principal`,
/// the result is empty.
pub fn effective_permissions(principal: &Principal, roles: &impl RolePermissions) -> PermissionSet {
    let mut effective: Option<PermissionSet> = None;
    for p in principal.chain() {
        if p.tenant != principal.tenant {
            return PermissionSet::new();
        }
        let own = p.roles.iter().fold(PermissionSet::new(), |acc, role| {
            acc.union(&roles.role_permissions(&p.tenant, role))
        });
        let next = match effective {
            None => own,
            Some(e) => e.intersect(&own),
        };
        if next.is_empty() {
            return next;
        }
        effective = Some(next);
    }
    effective.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PrincipalKind, SessionId};

    fn role_table(tenant: &TenantId, role: &RoleId) -> PermissionSet {
        match (tenant.as_str(), role.as_str()) {
            ("t1", "analyst") => ["db.query.execute", "db.schema.read"].into_iter().collect(),
            ("t1", "admin") => [
                "db.query.execute",
                "db.schema.read",
                "admin.connections.write",
            ]
            .into_iter()
            .collect(),
            ("t1", "agent-read") => ["db.query.execute", "db.schema.read", "audit.reveal"]
                .into_iter()
                .collect(),
            ("t1", "plugin-pg") => ["db.query.execute", "plugin.net.connect"]
                .into_iter()
                .collect(),
            ("t2", "admin") => ["db.query.execute", "admin.connections.write"]
                .into_iter()
                .collect(),
            _ => PermissionSet::new(),
        }
    }

    fn p(
        kind: PrincipalKind,
        id: &str,
        tenant: &str,
        roles: &[&str],
        obo: Option<Principal>,
    ) -> Principal {
        Principal {
            kind,
            id: id.into(),
            tenant: TenantId::new(tenant),
            on_behalf_of: obo.map(Box::new),
            roles: roles.iter().map(|r| RoleId::new(*r)).collect(),
            session: SessionId::new("s"),
        }
    }

    fn human(roles: &[&str]) -> Principal {
        p(PrincipalKind::Human, "human:oidc:alice", "t1", roles, None)
    }

    fn set(perms: &[&str]) -> PermissionSet {
        perms.iter().copied().collect()
    }

    #[test]
    fn human_alone_gets_union_of_roles() {
        let h = human(&["analyst", "admin"]);
        assert_eq!(
            effective_permissions(&h, &role_table),
            set(&[
                "admin.connections.write",
                "db.query.execute",
                "db.schema.read"
            ])
        );
    }

    #[test]
    fn agent_never_exceeds_its_human() {
        // The agent role includes audit.reveal, which the human lacks.
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["agent-read"],
            Some(human(&["analyst"])),
        );
        let eff = effective_permissions(&a, &role_table);
        assert_eq!(eff, set(&["db.query.execute", "db.schema.read"]));
        assert!(!eff.contains(&"audit.reveal".into()));
    }

    #[test]
    fn human_privileges_do_not_leak_to_agent() {
        // The human is an admin, but the agent's own roles do not include admin permissions.
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["agent-read"],
            Some(human(&["admin"])),
        );
        assert!(
            !effective_permissions(&a, &role_table).contains(&"admin.connections.write".into())
        );
    }

    #[test]
    fn three_level_chain_intersects_all() {
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["agent-read"],
            Some(human(&["analyst"])),
        );
        let plugin = p(
            PrincipalKind::Plugin,
            "plugin:pg@0.1.0",
            "t1",
            &["plugin-pg"],
            Some(a),
        );
        assert_eq!(
            effective_permissions(&plugin, &role_table),
            set(&["db.query.execute"])
        );
    }

    #[test]
    fn principal_without_roles_gets_nothing() {
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &[],
            Some(human(&["admin"])),
        );
        assert!(effective_permissions(&a, &role_table).is_empty());

        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["agent-read"],
            Some(human(&[])),
        );
        assert!(effective_permissions(&a, &role_table).is_empty());
    }

    #[test]
    fn unknown_roles_grant_nothing() {
        assert!(effective_permissions(&human(&["no-such-role"]), &role_table).is_empty());
    }

    #[test]
    fn cross_tenant_chain_is_denied() {
        // Same role name in another tenant must not be honoured for a t1 agent.
        let other = p(
            PrincipalKind::Human,
            "human:oidc:bob",
            "t2",
            &["admin"],
            None,
        );
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["admin"],
            Some(other),
        );
        assert!(effective_permissions(&a, &role_table).is_empty());
    }

    #[test]
    fn roles_resolve_in_the_principals_tenant() {
        let h = p(
            PrincipalKind::Human,
            "human:oidc:bob",
            "t2",
            &["admin"],
            None,
        );
        assert_eq!(
            effective_permissions(&h, &role_table),
            set(&["admin.connections.write", "db.query.execute"])
        );
    }

    #[test]
    fn caller_intersects_with_policy_and_grants() {
        let a = p(
            PrincipalKind::Agent,
            "agent:token:a",
            "t1",
            &["agent-read"],
            Some(human(&["analyst"])),
        );
        let tenant_policy = set(&["db.query.execute", "db.schema.read"]);
        let plugin_grants = set(&["db.query.execute"]);
        let eff = effective_permissions(&a, &role_table)
            .intersect(&tenant_policy)
            .intersect(&plugin_grants);
        assert_eq!(eff, set(&["db.query.execute"]));
    }
}
