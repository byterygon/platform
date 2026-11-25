//! The Authorizer (DOC-25 §3.3): roles that grant permissions per tool and risk, limited to
//! some profiles or namespaces, decided on the server for every call.
//!
//! - [`catalogue`]: the permissions, their target kinds and the built-in roles.
//! - [`policy`]: who holds which role, where (a snapshot swapped atomically on every change).
//! - [`targets`]: each call's target, built on the server before the check.
//! - [`completeness`]: the rules that stop a procedure from shipping unprotected.
//!
//! [`RoleAuthorizer::check`] decides in this order; the first step that applies decides
//! (DOC-25 §3.3.4):
//!
//! 1. A chain of principals, or anyone but a person → Deny ("only people act in Mightyconsole").
//! 2. Another tenant → Deny `TenantMismatch`.
//! 3. No live login session, a principal that is not the session's user, or a disabled user →
//!    Deny. A session that must change its password may call only
//!    `app.account.changePassword` and `app.me`; one that must enrol a second factor
//!    (`auth.require_totp`) only the TOTP enrolment and `app.me` (DOC-25 §3.2.6).
//! 4. A permission outside the catalogue → Deny `UnknownPermission`. `app.self` → Allow. A
//!    target that is the caller's own personal profile, with a permission of that profile's tool
//!    → Allow whatever the roles (Uy Son, 2026-11-23): their own credentials limit them at the
//!    target. Another user's personal profile → Deny, administrators included.
//! 5. The assignments in force: direct ones, the default role, the mappings of the session's IdP
//!    groups and of the user's local groups, pinned ones ([`policy::Policy::in_force`]).
//! 6. No assignment grants the permission → Deny `MissingPermission`; only assignments whose
//!    scope does not cover the target → Deny `OutOfScope`; a procedure that needs a target and
//!    has none → Deny ("no target").
//! 7. A Destructive call (the caller's own profile included) → Allow when a confirmed challenge
//!    matches it ([`confirm`]), else `NeedsApproval`.
//! 8. Allow.
//!
//! Until profiles move to the server (TSK-139) there is no stored profile: every connection is
//! opened with a profile the browser keeps and sends, a [`targets::BROWSER_TARGET`]. It counts as
//! the caller's personal profile when the caller holds `profiles.personal` (every built-in role
//! does; a site that takes it away with a custom default role makes roles bind there too).

pub mod catalogue;
pub mod completeness;
pub mod confirm;
pub mod policy;
pub mod targets;

use std::future::Future;
use std::sync::Arc;

use ambidex_axum::{LoginSessions, login_session_of};
use security_types::{
    ApprovalSpec, Authorizer, AuthzRequest, Decision, PROFILE_TARGET, PrincipalKind, Reason, Risk,
    TargetRef, TenantId,
};

use self::confirm::Confirmations;

use self::catalogue::TargetKind;
use self::policy::{InForce, Policy, PolicyHandle};

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

/// Who a stored profile belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileOwner {
    /// A user's personal profile: their principal id and the profile's tool.
    Personal { user: String, tool: String },
    /// The tenant's.
    Shared,
}

/// Looks up the owner of a stored profile. The store of profiles comes with TSK-139; until then
/// [`NoStoredProfiles`] knows none.
pub trait ProfileOwners: Send + Sync + 'static {
    fn owner(&self, profile: &str) -> Option<ProfileOwner>;
}

/// No profile is stored on the server yet (TSK-139).
pub struct NoStoredProfiles;

impl ProfileOwners for NoStoredProfiles {
    fn owner(&self, _profile: &str) -> Option<ProfileOwner> {
        None
    }
}

/// Whose the target of a call is.
enum Whose {
    /// The caller's own personal profile, of this tool.
    Own(String),
    /// Another user's personal profile.
    Other,
    /// A shared profile, or no target.
    Roles,
}

fn deny(message: &str) -> Decision {
    Decision::Deny {
        reason: Reason::Policy {
            message: message.into(),
        },
    }
}

/// Whether the assignments `in_force` make `user` an administrator: `admin` unscoped.
pub fn is_administrator(in_force: &[InForce]) -> bool {
    in_force
        .iter()
        .any(|a| a.role == catalogue::ADMIN_ROLE && a.scope.is_everywhere())
}

/// The role-based Authorizer of DOC-25 §3.3.4.
#[derive(Clone)]
pub struct RoleAuthorizer {
    tenant: TenantId,
    sessions: Arc<LoginSessions>,
    policy: PolicyHandle,
    owners: Arc<dyn ProfileOwners>,
    confirmations: Option<Arc<Confirmations>>,
}

impl RoleAuthorizer {
    pub fn new(
        tenant: &str,
        sessions: Arc<LoginSessions>,
        policy: PolicyHandle,
        owners: Arc<dyn ProfileOwners>,
    ) -> RoleAuthorizer {
        RoleAuthorizer {
            tenant: TenantId::new(tenant),
            sessions,
            policy,
            owners,
            confirmations: None,
        }
    }

    /// Destructive calls are allowed against the challenges confirmed in `confirmations`
    /// (DOC-25 §3.3.6); without it every Destructive call needs an approval it cannot get.
    #[must_use]
    pub fn with_confirmations(mut self, confirmations: Arc<Confirmations>) -> RoleAuthorizer {
        self.confirmations = Some(confirmations);
        self
    }

    /// Whether `principal` holds `perm` on `target` (`None`: anywhere it applies), by the same
    /// steps as a call (DOC-25 §3.3.4) but as a Read, so no confirmation is asked. The profile
    /// procedures use it for what one procedure permission cannot say: who sees, uses and edits
    /// which profile (§3.4.2).
    pub fn permits(
        &self,
        principal: &security_types::Principal,
        perm: &str,
        target: Option<&TargetRef>,
    ) -> bool {
        let action = security_types::Action::new("profiles.access", perm);
        self.decide(&AuthzRequest {
            principal,
            action: &action,
            target,
            risk: Risk::Read,
            input_digest: security_types::Digest::ZERO,
        })
        .is_allow()
    }

    /// Step 7: a Destructive call needs a confirmed challenge.
    fn confirmed(&self, req: &AuthzRequest<'_>) -> Decision {
        if req.risk < Risk::Destructive {
            return Decision::Allow;
        }
        let now = match &self.confirmations {
            Some(c) => {
                if c.consume(
                    req.principal,
                    &req.action.name,
                    req.target,
                    req.input_digest,
                ) {
                    return Decision::Allow;
                }
                c.now_ms()
            }
            None => security_types::unix_now_ms(),
        };
        Decision::NeedsApproval {
            approval: ApprovalSpec {
                action: req.action.clone(),
                target: req.target.cloned(),
                risk: req.risk,
                input_digest: req.input_digest,
                expires_at_unix_ms: now + confirm::PENDING_FOR_MS,
            },
        }
    }

    fn whose(
        &self,
        policy: &Policy,
        in_force: &[InForce],
        user: &str,
        target: Option<&TargetRef>,
    ) -> Whose {
        let Some(target) = target else {
            return Whose::Roles;
        };
        if let Some(tool) = targets::browser_tool(target) {
            // Built from the caller's own input and handles: theirs, when they may keep
            // personal profiles.
            return if policy.holds_anywhere(in_force, catalogue::PROFILES_PERSONAL) {
                Whose::Own(tool.to_owned())
            } else {
                Whose::Roles
            };
        }
        if target.kind != PROFILE_TARGET {
            return Whose::Roles;
        }
        let Some(t) = security_types::ProfileTarget::of(target) else {
            return Whose::Roles;
        };
        match self.owners.owner(t.profile) {
            Some(ProfileOwner::Personal { user: owner, tool }) if owner == user => Whose::Own(tool),
            Some(ProfileOwner::Personal { .. }) => Whose::Other,
            Some(ProfileOwner::Shared) | None => Whose::Roles,
        }
    }

    fn decide(&self, req: &AuthzRequest<'_>) -> Decision {
        let p = req.principal;
        // 1.
        if p.kind != PrincipalKind::Human || p.on_behalf_of.is_some() {
            return deny("only people act in Mightyconsole");
        }
        // 2.
        if p.tenant != self.tenant {
            return Decision::Deny {
                reason: Reason::TenantMismatch,
            };
        }
        // 3.
        let known = PRINCIPAL_PREFIXES.iter().any(|prefix| {
            p.id.strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        });
        if !known {
            return deny("only people signed in to this server act in Mightyconsole");
        }
        let Some(session) = self.sessions.get(login_session_of(p.session.as_str())) else {
            return deny("the session has ended; sign in again");
        };
        if session.user != p.id {
            return deny("the session belongs to someone else");
        }
        let policy = self.policy.current();
        if policy.is_disabled(&p.id) {
            return deny("this user is disabled");
        }
        let name = req.action.name.as_str();
        if session.must_change_password
            && !WHILE_CHANGING_PASSWORD.contains(&name)
            && !(session.must_enrol_totp && WHILE_ENROLLING.contains(&name))
        {
            return deny("change your password first");
        }
        if session.must_enrol_totp
            && !WHILE_ENROLLING.contains(&name)
            && !(session.must_change_password && WHILE_CHANGING_PASSWORD.contains(&name))
        {
            return deny("set up two-step sign-in (TOTP) first");
        }
        // 4.
        let perm = req.action.perm.as_str();
        let Some(kind) = catalogue::target_kind(perm) else {
            return Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            };
        };
        if perm == catalogue::APP_SELF {
            return Decision::Allow;
        }
        // 5.
        let in_force = policy.in_force(&p.id, &session.groups);
        let own = match self.whose(&policy, &in_force, &p.id, req.target) {
            Whose::Own(tool) if catalogue::belongs_to(perm, &tool) => {
                return self.confirmed(req);
            }
            Whose::Own(_) => true,
            Whose::Other => {
                return deny("this is another user's personal profile");
            }
            Whose::Roles => false,
        };
        // 6.
        let granted = match (kind, req.target) {
            (TargetKind::Any, _) => policy.holds_anywhere(&in_force, perm),
            (TargetKind::Tenant, _) => policy.holds_everywhere(&in_force, perm),
            (TargetKind::Profile, None) => return deny("no target"),
            (TargetKind::Profile, Some(target)) => policy.holds_on(&in_force, perm, target, own),
        };
        if granted {
            // 7. and 8.
            return self.confirmed(req);
        }
        let reason = if policy.holds_anywhere(&in_force, perm) {
            Reason::OutOfScope {
                perm: req.action.perm.clone(),
            }
        } else {
            Reason::MissingPermission {
                perm: req.action.perm.clone(),
            }
        };
        Decision::Deny { reason }
    }
}

impl Authorizer for RoleAuthorizer {
    fn check(&self, req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(self.decide(req))
    }
}

#[cfg(test)]
mod tests {
    use super::policy::{Assignment, CustomRole, GroupMapping, PolicyParts};
    use super::*;
    use ambidex_axum::{LoginMethod, NewSession, NoSessionEvents, SessionLimits};
    use security_types::{
        Action, Digest, Principal, Risk, Scope, ScopeEntry, SessionId, SystemClock,
    };
    use std::collections::HashMap;

    const TENANT: &str = "acme";

    struct Owners(HashMap<&'static str, ProfileOwner>);

    impl ProfileOwners for Owners {
        fn owner(&self, profile: &str) -> Option<ProfileOwner> {
            self.0.get(profile).cloned()
        }
    }

    struct Fixture {
        sessions: Arc<LoginSessions>,
        policy: PolicyHandle,
        authz: RoleAuthorizer,
    }

    fn fixture(parts: PolicyParts) -> Fixture {
        let sessions = Arc::new(LoginSessions::new(
            Arc::new(SystemClock),
            SessionLimits::default(),
            Arc::new(NoSessionEvents),
        ));
        let policy = PolicyHandle::new(Policy::new(parts));
        let owners = Owners(HashMap::from([
            ("SHARED", ProfileOwner::Shared),
            (
                "ALICES",
                ProfileOwner::Personal {
                    user: "human:account:ALICE".into(),
                    tool: "nats".into(),
                },
            ),
        ]));
        let authz = RoleAuthorizer::new(
            TENANT,
            Arc::clone(&sessions),
            policy.clone(),
            Arc::new(owners),
        );
        Fixture {
            sessions,
            policy,
            authz,
        }
    }

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

    impl Fixture {
        fn sign_in(
            &self,
            user: &str,
            groups: &[&str],
            must_change: bool,
            must_enrol: bool,
        ) -> Principal {
            let issued = self
                .sessions
                .create(NewSession {
                    user: user.into(),
                    principal: principal(PrincipalKind::Human, user, TENANT, "-"),
                    groups: groups.iter().map(|g| (*g).to_owned()).collect(),
                    method: LoginMethod::Password,
                    auth_time_ms: 0,
                    id_token: None,
                    client: None,
                    must_change_password: must_change,
                    must_enrol_totp: must_enrol,
                })
                .unwrap();
            principal(
                PrincipalKind::Human,
                user,
                TENANT,
                &format!("{}.conn1", issued.session_id),
            )
        }

        fn user(&self, user: &str, groups: &[&str]) -> Principal {
            self.sign_in(user, groups, false, false)
        }

        fn check(
            &self,
            p: &Principal,
            name: &str,
            perm: &str,
            target: Option<&TargetRef>,
        ) -> Decision {
            let action = Action::new(name, perm);
            self.authz.decide(&AuthzRequest {
                principal: p,
                action: &action,
                target,
                risk: Risk::Read,
                input_digest: Digest::ZERO,
            })
        }
    }

    fn direct(user: &str, role: &str, scope: Scope) -> PolicyParts {
        let mut parts = PolicyParts {
            default_role: Some("member".into()),
            ..PolicyParts::default()
        };
        parts.direct.insert(
            user.into(),
            vec![Assignment {
                role: role.into(),
                scope,
            }],
        );
        parts
    }

    fn scope(entries: &[&str]) -> Scope {
        Scope::only(
            entries
                .iter()
                .map(|e| e.parse::<ScopeEntry>().unwrap())
                .collect(),
        )
    }

    fn shared(id: &str) -> TargetRef {
        TargetRef::new(PROFILE_TARGET, id)
    }

    fn kind(d: &Decision) -> &'static str {
        match d {
            Decision::Allow => "allow",
            Decision::Deny {
                reason: Reason::MissingPermission { .. },
            } => "missing",
            Decision::Deny {
                reason: Reason::OutOfScope { .. },
            } => "scope",
            Decision::Deny {
                reason: Reason::UnknownPermission { .. },
            } => "unknown",
            Decision::Deny {
                reason: Reason::TenantMismatch,
            } => "tenant",
            Decision::Deny {
                reason: Reason::Policy { .. },
            } => "policy",
            Decision::NeedsApproval { .. } => "approval",
        }
    }

    /// Representative procedures of every tool, with the permission each carries and the lowest
    /// built-in role that may call it on a shared profile (0 member, 1 viewer, 2 operator,
    /// 3 admin).
    const MATRIX: &[(&str, &str, u8)] = &[
        ("nats.kv.get", "nats.read", 1),
        ("nats.kv.put", "nats.write", 2),
        ("nats.kv.delete", "nats.destroy", 3),
        ("kafka.topics.list", "kafka.read", 1),
        ("kafka.produce", "kafka.write", 2),
        ("kafka.topics.delete", "kafka.destroy", 3),
        ("k8s.pods.list", "k8s.read", 1),
        ("k8s.deployments.scale", "k8s.write", 2),
        ("k8s.pods.exec", "k8s.exec", 2),
        ("k8s.pods.delete", "k8s.destroy", 3),
        ("k8s.secrets.reveal", "k8s.secrets.read", 3),
        ("temporal.workflows.list", "temporal.read", 1),
        ("temporal.workflows.start", "temporal.write", 2),
        ("temporal.workflows.terminate", "temporal.destroy", 3),
        ("docker.containers.list", "docker.read", 1),
        ("docker.containers.restart", "docker.write", 2),
        ("docker.containers.exec", "docker.exec", 2),
        ("docker.containers.files.read", "docker.files.read", 2),
        ("docker.containers.remove", "docker.destroy", 3),
        ("langgraph.threads.get", "langgraph.read", 1),
        ("langgraph.store.put", "langgraph.write", 2),
        ("langgraph.threads.delete", "langgraph.destroy", 3),
        ("echo.ping", "echo.read", 1),
        ("echo.messages.produce", "echo.write", 2),
        ("term.write", "term.write", 2),
    ];

    /// Procedures without a profile target, with the lowest role (4: nobody, it is implied).
    const UNTARGETED: &[(&str, &str, u8)] = &[
        ("app.info", "app.read", 0),
        ("messaging.decode", "messaging.read", 0),
        ("admin.users.list", "admin.users.read", 3),
        ("admin.users.setRoles", "admin.users.write", 3),
        ("admin.roles.create", "admin.roles.write", 3),
        ("admin.sessions.revoke", "admin.sessions.revoke", 3),
        ("admin.secrets.status", "admin.secrets.manage", 3),
        ("audit.list", "audit.read", 3),
    ];

    #[test]
    fn every_built_in_role_on_every_tool() {
        for (rank, role) in catalogue::BUILT_IN.iter().enumerate() {
            let f = fixture(direct("human:account:U", role, Scope::everywhere()));
            let u = f.user("human:account:U", &[]);
            for (name, perm, lowest) in MATRIX {
                let target = shared("SHARED");
                let want = if rank as u8 >= *lowest {
                    "allow"
                } else {
                    "missing"
                };
                assert_eq!(
                    kind(&f.check(&u, name, perm, Some(&target))),
                    want,
                    "{role}: {name}"
                );
            }
            for (name, perm, lowest) in UNTARGETED {
                let want = if rank as u8 >= *lowest {
                    "allow"
                } else {
                    "missing"
                };
                assert_eq!(kind(&f.check(&u, name, perm, None)), want, "{role}: {name}");
            }
            // Implied for every signed-in person.
            assert_eq!(kind(&f.check(&u, "app.me", "app.self", None)), "allow");
        }
    }

    #[test]
    fn a_user_without_a_role_can_only_see_who_they_are() {
        let f = fixture(PolicyParts::default());
        let u = f.user("human:oidc:nobody", &[]);
        assert_eq!(kind(&f.check(&u, "app.me", "app.self", None)), "allow");
        assert_eq!(kind(&f.check(&u, "app.info", "app.read", None)), "missing");
        let browser = targets::browser("nats");
        assert_eq!(
            kind(&f.check(&u, "nats.kv.get", "nats.read", Some(&browser))),
            "missing"
        );
    }

    #[test]
    fn a_browser_held_profile_is_the_callers_own() {
        // Only the default role, member: full rights on their own connections.
        let f = fixture(direct("human:account:U", "member", Scope::everywhere()));
        let u = f.user("human:account:U", &[]);
        for (name, perm, _) in MATRIX {
            let tool = name.split('.').next().unwrap();
            let target = if *perm == "term.write" {
                targets::browser("docker")
            } else {
                targets::browser(tool)
            };
            assert_eq!(
                kind(&f.check(&u, name, perm, Some(&target))),
                "allow",
                "{name}"
            );
        }
        // A namespace below it is still theirs.
        let ns = targets::with_namespace(&targets::browser("temporal"), "default");
        assert_eq!(
            kind(&f.check(
                &u,
                "temporal.workflows.terminate",
                "temporal.destroy",
                Some(&ns)
            )),
            "allow"
        );
        // Not another tool's permission, nor a tenant one, through it.
        let nats = targets::browser("nats");
        assert_eq!(
            kind(&f.check(
                &u,
                "docker.containers.remove",
                "docker.destroy",
                Some(&nats)
            )),
            "missing"
        );
        assert_eq!(
            kind(&f.check(&u, "admin.users.list", "admin.users.read", Some(&nats))),
            "missing"
        );
        // Permissions of any target kind still work through roles.
        assert_eq!(
            kind(&f.check(&u, "messaging.decode", "messaging.read", Some(&nats))),
            "allow"
        );
    }

    #[test]
    fn without_profiles_personal_roles_bind_on_browser_profiles_too() {
        let mut parts = PolicyParts {
            default_role: Some("reader".into()),
            ..PolicyParts::default()
        };
        parts.custom_roles.push(CustomRole {
            id: "reader".into(),
            name: "Reader".into(),
            description: String::new(),
            permissions: ["app.read", "nats.read"].map(str::to_owned).into(),
        });
        let f = fixture(parts);
        let u = f.user("human:account:U", &[]);
        let nats = targets::browser("nats");
        assert_eq!(
            kind(&f.check(&u, "nats.kv.get", "nats.read", Some(&nats))),
            "allow"
        );
        assert_eq!(
            kind(&f.check(&u, "nats.kv.put", "nats.write", Some(&nats))),
            "missing"
        );
    }

    #[test]
    fn a_stored_personal_profile_is_its_owners_alone() {
        let alices = shared("ALICES");
        let mut parts = direct("human:account:ADMIN", "admin", Scope::everywhere());
        parts.default_role = None;
        let f = fixture(parts);
        let alice = f.user("human:account:ALICE", &[]);
        assert_eq!(
            kind(&f.check(&alice, "nats.kv.delete", "nats.destroy", Some(&alices))),
            "allow"
        );
        assert_eq!(
            kind(&f.check(
                &alice,
                "docker.containers.list",
                "docker.read",
                Some(&alices)
            )),
            "missing"
        );
        let admin = f.user("human:account:ADMIN", &[]);
        assert_eq!(
            kind(&f.check(&admin, "nats.kv.get", "nats.read", Some(&alices))),
            "policy"
        );
    }

    #[test]
    fn scopes_limit_a_role_to_profiles_and_namespaces() {
        let mut parts = PolicyParts {
            default_role: Some("member".into()),
            ..PolicyParts::default()
        };
        parts.mappings.push(GroupMapping {
            group: "idp:team-a".into(),
            role: "operator".into(),
            scope: scope(&["profile:SHARED/ns:team-a-*"]),
        });
        parts.pinned.push(GroupMapping {
            group: "idp:ops".into(),
            role: "admin".into(),
            scope: scope(&["profile:OTHER"]),
        });
        let f = fixture(parts);
        let u = f.user("human:oidc:bob", &["team-a"]);
        let inside = shared("SHARED/ns:team-a-web");
        let outside = shared("SHARED/ns:team-b");
        let profile = shared("SHARED");
        let w = |t: Option<&TargetRef>| {
            kind(&f.check(&u, "temporal.workflows.start", "temporal.write", t))
        };
        assert_eq!(w(Some(&inside)), "allow");
        assert_eq!(w(Some(&outside)), "scope");
        assert_eq!(w(Some(&profile)), "scope", "a call on the whole profile");
        assert_eq!(w(None), "policy", "no target");
        assert_eq!(w(Some(&targets::browser("temporal"))), "allow", "their own");
        // The group is read from the session: without it, nothing.
        let other = f.user("human:oidc:carol", &[]);
        assert_eq!(
            kind(&f.check(
                &other,
                "temporal.workflows.start",
                "temporal.write",
                Some(&inside)
            )),
            "missing"
        );
        // A scoped administrator is no administrator for tenant permissions; any-kind ones work.
        let ops = f.user("human:oidc:dave", &["ops"]);
        assert_eq!(
            kind(&f.check(&ops, "admin.users.list", "admin.users.read", None)),
            "scope"
        );
        assert_eq!(
            kind(&f.check(
                &ops,
                "nats.kv.delete",
                "nats.destroy",
                Some(&shared("OTHER"))
            )),
            "allow"
        );
        assert_eq!(
            kind(&f.check(&ops, "nats.kv.delete", "nats.destroy", Some(&profile))),
            "scope"
        );
    }

    #[test]
    fn only_signed_in_people_of_the_tenant_with_a_live_session() {
        let f = fixture(direct("human:account:U", "admin", Scope::everywhere()));
        let u = f.user("human:account:U", &[]);
        assert_eq!(kind(&f.check(&u, "app.info", "app.read", None)), "allow");
        let s = u.session.as_str().to_owned();
        let ended = principal(PrincipalKind::Human, "human:account:U", TENANT, "ls_gone.c");
        let local = principal(PrincipalKind::Human, "human:local:me", TENANT, &s);
        let empty = principal(PrincipalKind::Human, "human:account:", TENANT, &s);
        let someone_else = principal(PrincipalKind::Human, "human:account:V", TENANT, &s);
        let agent = principal(PrincipalKind::Agent, "human:account:U", TENANT, &s);
        let mut behind = u.clone();
        behind.on_behalf_of = Some(Box::new(u.clone()));
        for p in [&ended, &local, &empty, &someone_else, &agent, &behind] {
            assert_eq!(
                kind(&f.check(p, "app.info", "app.read", None)),
                "policy",
                "{p:?}"
            );
        }
        let other = principal(PrincipalKind::Human, "human:account:U", "other", &s);
        assert_eq!(
            kind(&f.check(&other, "app.info", "app.read", None)),
            "tenant"
        );
        assert_eq!(
            kind(&f.check(&u, "nats.everything", "nats.everything", None)),
            "unknown"
        );
        // A disabled user is refused even with a live session, at once.
        f.policy.update(|p| {
            p.disabled.insert("human:account:U".into());
        });
        assert_eq!(kind(&f.check(&u, "app.me", "app.self", None)), "policy");
    }

    #[test]
    fn restricted_sessions_may_only_do_what_lifts_the_restriction() {
        let f = fixture(direct("human:account:01A", "admin", Scope::everywhere()));
        let user = "human:account:01A";
        let change = f.sign_in(user, &[], true, false);
        let enrol = f.sign_in(user, &[], false, true);
        let both = f.sign_in(user, &[], true, true);
        let perm = |name: &str| {
            if name == "app.me" || name.starts_with("app.account") {
                "app.self"
            } else {
                "app.read"
            }
        };
        for name in WHILE_CHANGING_PASSWORD {
            assert_eq!(
                kind(&f.check(&change, name, perm(name), None)),
                "allow",
                "{name}"
            );
            assert_eq!(
                kind(&f.check(&both, name, perm(name), None)),
                "allow",
                "{name}"
            );
        }
        for name in WHILE_ENROLLING {
            assert_eq!(
                kind(&f.check(&enrol, name, perm(name), None)),
                "allow",
                "{name}"
            );
            assert_eq!(
                kind(&f.check(&both, name, perm(name), None)),
                "allow",
                "{name}"
            );
        }
        assert_eq!(
            kind(&f.check(&change, "app.account.totp.begin", "app.self", None)),
            "policy"
        );
        assert_eq!(
            kind(&f.check(&enrol, "app.account.changePassword", "app.self", None)),
            "policy"
        );
        for p in [&change, &enrol, &both] {
            assert_eq!(kind(&f.check(p, "app.info", "app.read", None)), "policy");
        }
        // Lifted on the live session: allowed at once.
        f.sessions
            .set_must_change(login_session_of(change.session.as_str()), false);
        assert_eq!(
            kind(&f.check(&change, "app.info", "app.read", None)),
            "allow"
        );
    }

    #[test]
    fn a_destroy_needs_a_confirmed_challenge_even_on_ones_own_connection() {
        let f = fixture(direct("human:account:U", "admin", Scope::everywhere()));
        let confirmations = Arc::new(Confirmations::new(Arc::new(SystemClock)));
        let authz = f
            .authz
            .clone()
            .with_confirmations(Arc::clone(&confirmations));
        let u = f.user("human:account:U", &[]);
        let action = Action::new("nats.kv.delete", "nats.destroy");
        for target in [shared("SHARED"), targets::browser("nats")] {
            let req = AuthzRequest {
                principal: &u,
                action: &action,
                target: Some(&target),
                risk: Risk::Destructive,
                input_digest: Digest([7; 32]),
            };
            let Decision::NeedsApproval { approval } = authz.decide(&req) else {
                panic!("a destroy without a confirmation");
            };
            assert_eq!(approval.target.as_ref(), Some(&target));
            let input = serde_json::json!({ "key": "k1" });
            let id = confirmations.record_for_test(&u, &approval, &input);
            confirmations.confirm(&u, &id, "k1").unwrap();
            assert_eq!(authz.decide(&req), Decision::Allow);
            assert!(
                matches!(authz.decide(&req), Decision::NeedsApproval { .. }),
                "used once"
            );
        }
        // Without the permission, no challenge: a refusal.
        let f = fixture(direct("human:account:V", "operator", Scope::everywhere()));
        let v = f.user("human:account:V", &[]);
        let req = AuthzRequest {
            principal: &v,
            action: &action,
            target: Some(&shared("SHARED")),
            risk: Risk::Destructive,
            input_digest: Digest::ZERO,
        };
        assert_eq!(kind(&f.authz.decide(&req)), "missing");
    }

    #[test]
    fn administrators_hold_admin_everywhere() {
        let policy = Policy::new(direct("human:account:U", "admin", Scope::everywhere()));
        assert!(is_administrator(&policy.in_force("human:account:U", &[])));
        let policy = Policy::new(direct("human:account:U", "admin", scope(&["profile:P"])));
        assert!(!is_administrator(&policy.in_force("human:account:U", &[])));
    }
}
