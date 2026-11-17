//! The static Authorizer of v0.1 (Mightyconsole spec §2.3, "Authorizer").
//!
//! The local principal ([`crate::sessions::local_principal`]) may do everything; every other
//! principal, and any chain with an agent or a plugin in it, is denied. Permission names exist
//! for later roles (`<tool>.read`, `<tool>.write`, `<tool>.destroy`, `k8s.secrets.read`), and
//! every procedure carries its real risk, so roles and audit can be added without renaming.

use std::future::Future;

use security_types::{Authorizer, AuthzRequest, Decision, PrincipalKind, Reason, TenantId};

/// The tenant of the one local user.
pub const LOCAL_TENANT: &str = "local";

/// Allows everything to one principal id in [`LOCAL_TENANT`], a human with nobody behind it.
#[derive(Debug, Clone)]
pub struct LocalAuthorizer {
    principal_id: String,
    tenant: TenantId,
}

impl LocalAuthorizer {
    pub fn new(principal_id: impl Into<String>) -> LocalAuthorizer {
        LocalAuthorizer {
            principal_id: principal_id.into(),
            tenant: TenantId::new(LOCAL_TENANT),
        }
    }

    fn decide(&self, req: &AuthzRequest<'_>) -> Decision {
        let p = req.principal;
        if p.tenant != self.tenant {
            return Decision::Deny {
                reason: Reason::TenantMismatch,
            };
        }
        if p.kind != PrincipalKind::Human || p.on_behalf_of.is_some() || p.id != self.principal_id {
            return Decision::Deny {
                reason: Reason::Policy {
                    message: "only the local user acts in Mightyconsole v0.1".into(),
                },
            };
        }
        Decision::Allow
    }
}

impl Authorizer for LocalAuthorizer {
    fn check(&self, req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(self.decide(req))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{Action, Digest, Principal, Risk, SessionId};

    fn principal(kind: PrincipalKind, id: &str, tenant: &str) -> Principal {
        Principal {
            kind,
            id: id.into(),
            tenant: TenantId::new(tenant),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("s"),
        }
    }

    fn check(authz: &LocalAuthorizer, principal: &Principal) -> Decision {
        let action = Action::new("k8s.pods.delete", "k8s.destroy");
        authz.decide(&AuthzRequest {
            principal,
            action: &action,
            target: None,
            risk: Risk::Destructive,
            input_digest: Digest::ZERO,
        })
    }

    #[test]
    fn only_the_local_human_is_allowed() {
        let authz = LocalAuthorizer::new("human:local:me");
        let me = principal(PrincipalKind::Human, "human:local:me", LOCAL_TENANT);
        assert_eq!(check(&authz, &me), Decision::Allow);
        let someone = principal(PrincipalKind::Human, "human:local:other", LOCAL_TENANT);
        let tenant = principal(PrincipalKind::Human, "human:local:me", "t-2");
        let agent = principal(PrincipalKind::Agent, "human:local:me", LOCAL_TENANT);
        let mut behind = principal(PrincipalKind::Human, "human:local:me", LOCAL_TENANT);
        behind.on_behalf_of = Some(Box::new(me.clone()));
        for p in [&someone, &tenant, &agent, &behind] {
            assert!(matches!(check(&authz, p), Decision::Deny { .. }), "{p:?}");
        }
    }
}
