//! The static Authorizer of the first usable version (DBee spec §4, Decision 22).
//!
//! The local human principal holds every DBee permission; any principal chain that contains an
//! agent or a plugin is denied, and so is any other tenant. Unknown permissions are denied
//! (default-deny), so a procedure registered with a permission outside [`PERMISSIONS`] never
//! runs. The Plugin Host's grant permissions are in the catalogue because the local human is the
//! approver of their own connections ([`plugin_host::GrantStore::create`] asks the same
//! authorizer).
//!
//! Permission names are provisional, like the Plugin Host's (Plugin Host spec Open question 25).

use std::future::Future;

use security_types::{Authorizer, AuthzRequest, Decision, PrincipalKind, Reason, TenantId};

/// Permissions of the DBee API (DBee spec §5) and the Plugin Host actions the core performs for
/// the local human.
pub const PERMISSIONS: &[&str] = &[
    "app.read",
    "connections.read",
    "connections.create",
    "connections.update",
    "connections.delete",
    "db.connect",
    "db.schema.read",
    "db.query.execute",
    "db.export",
    "files.write",
    plugin_host::grant::GRANT_CREATE_PERM,
    plugin_host::grant::GRANT_REVOKE_PERM,
];

/// The tenant of a standalone workspace.
pub const LOCAL_TENANT: &str = "local";

/// Allows every known permission to a chain of humans in the configured tenant.
#[derive(Debug, Clone)]
pub struct DbeeAuthorizer {
    tenant: TenantId,
}

impl DbeeAuthorizer {
    pub fn new(tenant: TenantId) -> Self {
        Self { tenant }
    }

    pub fn tenant(&self) -> &TenantId {
        &self.tenant
    }

    fn decide(&self, req: &AuthzRequest<'_>) -> Decision {
        for p in req.principal.chain() {
            if p.tenant != self.tenant {
                return Decision::Deny {
                    reason: Reason::TenantMismatch,
                };
            }
            if p.kind != PrincipalKind::Human {
                return Decision::Deny {
                    reason: Reason::Policy {
                        message: "only humans act in the first usable version".into(),
                    },
                };
            }
        }
        if !PERMISSIONS.contains(&req.action.perm.as_str()) {
            return Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            };
        }
        Decision::Allow
    }
}

impl Authorizer for DbeeAuthorizer {
    fn check(&self, req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(self.decide(req))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{Action, Digest, Principal, Risk, SessionId};

    fn principal(kind: PrincipalKind, tenant: &str, obo: Option<Principal>) -> Principal {
        Principal {
            kind,
            id: "p".into(),
            tenant: TenantId::new(tenant),
            on_behalf_of: obo.map(Box::new),
            roles: vec![],
            session: SessionId::new("s"),
        }
    }

    fn check(authz: &DbeeAuthorizer, principal: &Principal, perm: &str) -> Decision {
        let action = Action::new("x.y", perm);
        authz.decide(&AuthzRequest {
            principal,
            action: &action,
            target: None,
            risk: Risk::Read,
            input_digest: Digest::ZERO,
        })
    }

    #[test]
    fn local_human_holds_every_permission() {
        let authz = DbeeAuthorizer::new(TenantId::new(LOCAL_TENANT));
        let human = principal(PrincipalKind::Human, LOCAL_TENANT, None);
        for perm in PERMISSIONS {
            assert_eq!(check(&authz, &human, perm), Decision::Allow, "{perm}");
        }
        assert!(matches!(
            check(&authz, &human, "admin.anything"),
            Decision::Deny {
                reason: Reason::UnknownPermission { .. }
            }
        ));
    }

    #[test]
    fn agents_plugins_and_other_tenants_are_denied() {
        let authz = DbeeAuthorizer::new(TenantId::new(LOCAL_TENANT));
        let human = principal(PrincipalKind::Human, LOCAL_TENANT, None);
        let agent = principal(PrincipalKind::Agent, LOCAL_TENANT, Some(human.clone()));
        let plugin = principal(PrincipalKind::Plugin, LOCAL_TENANT, Some(human.clone()));
        let other = principal(PrincipalKind::Human, "t-2", None);
        for p in [&agent, &plugin, &other] {
            assert!(matches!(
                check(&authz, p, "app.read"),
                Decision::Deny { .. }
            ));
        }
        // An agent hidden behind a human at the front of the chain is still denied.
        let fronted = principal(PrincipalKind::Human, LOCAL_TENANT, Some(agent));
        assert!(matches!(
            check(&authz, &fronted, "app.read"),
            Decision::Deny { .. }
        ));
    }
}
