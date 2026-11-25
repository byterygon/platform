//! The Authorizer until roles land (TSK-138; DOC-25 §3.8): every person signed in to this server
//! (`human:account:…` or `human:oidc:…` in the server's tenant, with nobody behind them) may do
//! everything, as v0.1's one user could; the server warns at start. Permission names exist for
//! later roles (`<tool>.read`, `<tool>.write`, `<tool>.destroy`, `k8s.secrets.read`), and every
//! procedure carries its real risk, so roles and audit can be added without renaming.
//!
//! One restriction is in force already (DOC-25 §3.2.6): a session that must change its password
//! may call only `app.account.changePassword` and `app.me`; one that must enrol a second factor
//! (`auth.require_totp`) only the TOTP enrolment and `app.me`. The flags are read from the live
//! session on every call, so lifting them takes effect at once.

use std::future::Future;
use std::sync::Arc;

use ambidex_axum::{LoginSessions, login_session_of};
use security_types::{Authorizer, AuthzRequest, Decision, PrincipalKind, Reason, TenantId};

/// The prefixes of the principals a sign-in makes (DOC-25 §3.2.3).
pub const PRINCIPAL_PREFIXES: [&str; 2] = ["human:oidc:", "human:account:"];

/// What a session that must change its password may call.
pub const WHILE_CHANGING_PASSWORD: [&str; 2] = ["app.me", "app.account.changePassword"];
/// What a session that must enrol a second factor may call.
pub const WHILE_ENROLLING: [&str; 3] = [
    "app.me",
    "app.account.totp.begin",
    "app.account.totp.confirm",
];

/// Allows every signed-in human of the server's tenant, within their session's restrictions.
#[derive(Clone)]
pub struct SignedInAuthorizer {
    tenant: TenantId,
    sessions: Arc<LoginSessions>,
}

impl SignedInAuthorizer {
    pub fn new(tenant: &str, sessions: Arc<LoginSessions>) -> SignedInAuthorizer {
        SignedInAuthorizer {
            tenant: TenantId::new(tenant),
            sessions,
        }
    }

    fn decide(&self, req: &AuthzRequest<'_>) -> Decision {
        let p = req.principal;
        if p.tenant != self.tenant {
            return Decision::Deny {
                reason: Reason::TenantMismatch,
            };
        }
        let known = PRINCIPAL_PREFIXES.iter().any(|prefix| {
            p.id.strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        });
        if p.kind != PrincipalKind::Human || p.on_behalf_of.is_some() || !known {
            return Decision::Deny {
                reason: Reason::Policy {
                    message: "only people signed in to this server act in Mightyconsole".into(),
                },
            };
        }
        let Some(session) = self.sessions.get(login_session_of(p.session.as_str())) else {
            return Decision::Deny {
                reason: Reason::Policy {
                    message: "the session has ended; sign in again".into(),
                },
            };
        };
        let name = req.action.name.as_str();
        if session.must_change_password
            && !WHILE_CHANGING_PASSWORD.contains(&name)
            && !(session.must_enrol_totp && WHILE_ENROLLING.contains(&name))
        {
            return Decision::Deny {
                reason: Reason::Policy {
                    message: "change your password first".into(),
                },
            };
        }
        if session.must_enrol_totp
            && !WHILE_ENROLLING.contains(&name)
            && !(session.must_change_password && WHILE_CHANGING_PASSWORD.contains(&name))
        {
            return Decision::Deny {
                reason: Reason::Policy {
                    message: "set up two-step sign-in (TOTP) first".into(),
                },
            };
        }
        Decision::Allow
    }
}

impl Authorizer for SignedInAuthorizer {
    fn check(&self, req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(self.decide(req))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ambidex_axum::{LoginMethod, NewSession, NoSessionEvents, SessionLimits};
    use security_types::{Action, Digest, Principal, Risk, SessionId, SystemClock};

    fn principal(kind: PrincipalKind, id: &str, tenant: &str, session: &str) -> Principal {
        Principal {
            kind,
            id: id.into(),
            tenant: TenantId::new(tenant),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new(session),
        }
    }

    fn check(authz: &SignedInAuthorizer, principal: &Principal, name: &str) -> Decision {
        let action = Action::new(name, "x");
        authz.decide(&AuthzRequest {
            principal,
            action: &action,
            target: None,
            risk: Risk::Destructive,
            input_digest: Digest::ZERO,
        })
    }

    fn session(store: &LoginSessions, user: &str, must_change: bool, must_enrol: bool) -> String {
        let issued = store
            .create(NewSession {
                user: user.into(),
                principal: principal(PrincipalKind::Human, user, "acme", "-"),
                groups: vec![],
                method: LoginMethod::Password,
                auth_time_ms: 0,
                id_token: None,
                client: None,
                must_change_password: must_change,
                must_enrol_totp: must_enrol,
            })
            .unwrap();
        format!("{}.conn1", issued.session_id)
    }

    fn store() -> Arc<LoginSessions> {
        Arc::new(LoginSessions::new(
            Arc::new(SystemClock),
            SessionLimits::default(),
            Arc::new(NoSessionEvents),
        ))
    }

    #[test]
    fn every_signed_in_human_of_the_tenant_with_a_live_session() {
        let sessions = store();
        let authz = SignedInAuthorizer::new("acme", Arc::clone(&sessions));
        let s = session(&sessions, "human:account:01A", false, false);
        for id in ["human:account:01A", "human:oidc:alice"] {
            let p = principal(PrincipalKind::Human, id, "acme", &s);
            assert_eq!(
                check(&authz, &p, "k8s.pods.delete"),
                Decision::Allow,
                "{id}"
            );
        }
        let ended = principal(
            PrincipalKind::Human,
            "human:account:01A",
            "acme",
            "ls_gone.c",
        );
        let local = principal(PrincipalKind::Human, "human:local:me", "acme", &s);
        let empty = principal(PrincipalKind::Human, "human:account:", "acme", &s);
        let other = principal(PrincipalKind::Human, "human:oidc:alice", "other", &s);
        let agent = principal(PrincipalKind::Agent, "human:oidc:alice", "acme", &s);
        let mut behind = principal(PrincipalKind::Human, "human:oidc:alice", "acme", &s);
        behind.on_behalf_of = Some(Box::new(behind.clone()));
        for p in [&ended, &local, &empty, &other, &agent, &behind] {
            assert!(
                matches!(check(&authz, p, "app.info"), Decision::Deny { .. }),
                "{p:?}"
            );
        }
    }

    #[test]
    fn restricted_sessions_may_only_do_what_lifts_the_restriction() {
        let sessions = store();
        let authz = SignedInAuthorizer::new("acme", Arc::clone(&sessions));
        let user = "human:account:01A";
        let change = principal(
            PrincipalKind::Human,
            user,
            "acme",
            &session(&sessions, user, true, false),
        );
        let enrol = principal(
            PrincipalKind::Human,
            user,
            "acme",
            &session(&sessions, user, false, true),
        );
        let both = principal(
            PrincipalKind::Human,
            user,
            "acme",
            &session(&sessions, user, true, true),
        );
        for name in WHILE_CHANGING_PASSWORD {
            assert_eq!(check(&authz, &change, name), Decision::Allow, "{name}");
            assert_eq!(check(&authz, &both, name), Decision::Allow, "{name}");
        }
        for name in WHILE_ENROLLING {
            assert_eq!(check(&authz, &enrol, name), Decision::Allow, "{name}");
            assert_eq!(check(&authz, &both, name), Decision::Allow, "{name}");
        }
        assert!(matches!(
            check(&authz, &change, "app.account.totp.begin"),
            Decision::Deny { .. }
        ));
        assert!(matches!(
            check(&authz, &enrol, "app.account.changePassword"),
            Decision::Deny { .. }
        ));
        for p in [&change, &enrol, &both] {
            assert!(matches!(
                check(&authz, p, "app.info"),
                Decision::Deny { .. }
            ));
            assert!(matches!(
                check(&authz, p, "docker.exec"),
                Decision::Deny { .. }
            ));
        }
        // Lifted on the live session: allowed at once.
        sessions.set_must_change(login_session_of(change.session.as_str()), false);
        assert_eq!(check(&authz, &change, "app.info"), Decision::Allow);
    }
}
