//! The static Authorizer of v0.1 (Mightyconsole spec §2.3, "Authorizer").
//!
//! The local principal ([`crate::sessions::local_principal`]) may do everything; every other
//! principal, and any chain with an agent or a plugin in it, is denied.
//!
//! With OIDC sign-in configured ([`LocalAuthorizer::signed_in`]), every person signed in
//! through it (`human:oidc:…` in the server's tenant) may do everything, as v0.1's one user
//! could, until roles land (TSK-138; DOC-25 §3.8: the server warns at start). Permission names exist
//! for later roles (`<tool>.read`, `<tool>.write`, `<tool>.destroy`, `k8s.secrets.read`), and
//! every procedure carries its real risk, so roles and audit can be added without renaming.

use std::future::Future;

use security_types::{Authorizer, AuthzRequest, Decision, PrincipalKind, Reason, TenantId};

/// The tenant of the one local user.
pub const LOCAL_TENANT: &str = "local";

/// The prefix of every principal an OIDC sign-in makes (DOC-25 §3.2.3).
pub const OIDC_PRINCIPAL_PREFIX: &str = "human:oidc:";

#[derive(Debug, Clone)]
enum Who {
    One(String),
    SignedIn,
}

/// Allows everything to one principal id in [`LOCAL_TENANT`], a human with nobody behind it; or
/// to every signed-in human of the server's tenant.
#[derive(Debug, Clone)]
pub struct LocalAuthorizer {
    who: Who,
    tenant: TenantId,
}

impl LocalAuthorizer {
    pub fn new(principal_id: impl Into<String>) -> LocalAuthorizer {
        LocalAuthorizer {
            who: Who::One(principal_id.into()),
            tenant: TenantId::new(LOCAL_TENANT),
        }
    }

    /// Every human signed in through OIDC in `tenant`, with nobody behind them.
    pub fn signed_in(tenant: &str) -> LocalAuthorizer {
        LocalAuthorizer {
            who: Who::SignedIn,
            tenant: TenantId::new(tenant),
        }
    }

    fn decide(&self, req: &AuthzRequest<'_>) -> Decision {
        let p = req.principal;
        if p.tenant != self.tenant {
            return Decision::Deny {
                reason: Reason::TenantMismatch,
            };
        }
        let known = match &self.who {
            Who::One(id) => &p.id == id,
            Who::SignedIn => {
                p.id.strip_prefix(OIDC_PRINCIPAL_PREFIX)
                    .is_some_and(|sub| !sub.is_empty())
            }
        };
        if p.kind != PrincipalKind::Human || p.on_behalf_of.is_some() || !known {
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

    #[test]
    fn with_sign_in_every_signed_in_human_of_the_tenant_is_allowed() {
        let authz = LocalAuthorizer::signed_in("acme");
        let alice = principal(PrincipalKind::Human, "human:oidc:alice", "acme");
        assert_eq!(check(&authz, &alice), Decision::Allow);
        let local = principal(PrincipalKind::Human, "human:local:me", "acme");
        let empty = principal(PrincipalKind::Human, "human:oidc:", "acme");
        let other = principal(PrincipalKind::Human, "human:oidc:alice", "other");
        let agent = principal(PrincipalKind::Agent, "human:oidc:alice", "acme");
        let mut behind = alice.clone();
        behind.on_behalf_of = Some(Box::new(alice.clone()));
        for p in [&local, &empty, &other, &agent, &behind] {
            assert!(matches!(check(&authz, p), Decision::Deny { .. }), "{p:?}");
        }
    }
}
