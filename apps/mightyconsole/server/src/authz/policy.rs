//! Who holds which role, where (DOC-25 §3.3.2, §3.3.5): the policy snapshot the
//! [`RoleAuthorizer`](super::RoleAuthorizer) reads on every call.
//!
//! - **Roles**: the built-in ones ([`super::catalogue::built_in`], recomputed at every start)
//!   and custom ones from the store. A custom role's permissions outside the catalogue of the
//!   running build grant nothing.
//! - **Assignments** `{ role, scope }`: direct ones per user (store), the default role every user
//!   gets (`auth.default_role`, unscoped), and the default administrator's pinned `admin`.
//! - **Group mappings** `{ group, role, scope }`: `idp:<name>` matches a group of the IdP in the
//!   user's session, `local:<name>` a local group the user is a member of. Mappings from the
//!   store can be edited; `[[auth.group_roles]]` in the configuration are pinned.
//! - **Disabled users**: refused even with a live session.
//!
//! A [`Policy`] is immutable. [`PolicyHandle`] swaps a new one in atomically on every change, so
//! a call never sees a half-applied change.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, RwLock};

use security_types::{Scope, TargetRef};
use serde::{Deserialize, Serialize};

use super::catalogue;

/// A role in force or stored: which role, limited to where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Assignment {
    pub role: String,
    #[serde(default)]
    pub scope: Scope,
}

/// A group's role: `group` is `idp:<name>` or `local:<name>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMapping {
    pub group: String,
    pub role: String,
    #[serde(default)]
    pub scope: Scope,
}

/// A custom role (DOC-25 §3.3.2): an id that is not a built-in one, a name, a description and
/// permissions from the catalogue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRole {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub permissions: BTreeSet<String>,
}

/// A role id: `[a-z][a-z0-9-]{1,31}`.
pub fn is_role_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_lowercase())
        && (2..=32).contains(&id.len())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A group name in a mapping: `idp:<name>` or `local:<name>`, the name 1 to 256 bytes.
pub fn is_group(group: &str) -> bool {
    let name = group
        .strip_prefix("idp:")
        .or_else(|| group.strip_prefix("local:"));
    name.is_some_and(|n| !n.is_empty() && n.len() <= 256 && !n.chars().any(char::is_control))
}

/// How an assignment reached the user (`app.me`'s `via`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Via {
    /// `auth.default_role`.
    Default,
    Direct,
    /// A mapping of this group (`idp:…` or `local:…`).
    Group(String),
    /// A pinned `[[auth.group_roles]]` entry, or the default administrator's own `admin`.
    Pinned,
}

impl Via {
    pub fn label(&self) -> String {
        match self {
            Via::Default => "default".into(),
            Via::Direct => "direct".into(),
            Via::Group(g) => format!("group:{g}"),
            Via::Pinned => "pinned".into(),
        }
    }
}

/// An assignment in force for one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InForce {
    pub role: String,
    pub scope: Scope,
    pub via: Via,
}

/// What the store and the configuration hold, before it becomes a [`Policy`].
#[derive(Debug, Clone, Default)]
pub struct PolicyParts {
    pub custom_roles: Vec<CustomRole>,
    /// Direct assignments per user (principal id).
    pub direct: HashMap<String, Vec<Assignment>>,
    /// Editable group mappings.
    pub mappings: Vec<GroupMapping>,
    /// `[[auth.group_roles]]`.
    pub pinned: Vec<GroupMapping>,
    /// Local groups: name (without `local:`) → members (principal ids).
    pub local_groups: BTreeMap<String, BTreeSet<String>>,
    pub disabled: HashSet<String>,
    /// `auth.default_role` (`None` for `""`).
    pub default_role: Option<String>,
    /// The default administrator's principal id, with its pinned `admin`.
    pub default_admin: Option<String>,
}

/// An immutable snapshot of the policy.
#[derive(Debug, Clone, Default)]
pub struct Policy {
    roles: BTreeMap<String, BTreeSet<String>>,
    parts: PolicyParts,
}

impl Policy {
    pub fn new(parts: PolicyParts) -> Policy {
        let mut roles: BTreeMap<String, BTreeSet<String>> = catalogue::BUILT_IN
            .iter()
            .map(|r| ((*r).to_owned(), catalogue::built_in(r).expect("built in")))
            .collect();
        let known = catalogue::all();
        for role in &parts.custom_roles {
            if roles.contains_key(&role.id) {
                // A stored role cannot shadow a built-in one.
                continue;
            }
            let perms = role
                .permissions
                .iter()
                .filter(|p| known.contains(*p) && p.as_str() != catalogue::APP_SELF)
                .cloned()
                .collect();
            roles.insert(role.id.clone(), perms);
        }
        Policy { roles, parts }
    }

    pub fn parts(&self) -> &PolicyParts {
        &self.parts
    }

    /// Whether a role with this id exists (built-in or custom).
    pub fn has_role(&self, role: &str) -> bool {
        self.roles.contains_key(role)
    }

    /// The permissions a role grants; empty for an unknown role.
    pub fn role_permissions(&self, role: &str) -> Option<&BTreeSet<String>> {
        self.roles.get(role)
    }

    pub fn grants(&self, role: &str, perm: &str) -> bool {
        self.roles.get(role).is_some_and(|p| p.contains(perm))
    }

    pub fn is_disabled(&self, user: &str) -> bool {
        self.parts.disabled.contains(user)
    }

    /// The local groups `user` is a member of (without `local:`).
    pub fn local_groups_of(&self, user: &str) -> Vec<&str> {
        self.parts
            .local_groups
            .iter()
            .filter(|(_, members)| members.contains(user))
            .map(|(name, _)| name.as_str())
            .collect()
    }

    /// The assignments in force for `user` whose session carries the IdP groups `idp_groups`
    /// (DOC-25 §3.3.4 step 5). Assignments of unknown roles are dropped.
    pub fn in_force(&self, user: &str, idp_groups: &[String]) -> Vec<InForce> {
        let mut out = Vec::new();
        if let Some(role) = &self.parts.default_role {
            out.push(InForce {
                role: role.clone(),
                scope: Scope::everywhere(),
                via: Via::Default,
            });
        }
        if self.parts.default_admin.as_deref() == Some(user) {
            out.push(InForce {
                role: catalogue::ADMIN_ROLE.into(),
                scope: Scope::everywhere(),
                via: Via::Pinned,
            });
        }
        for a in self.parts.direct.get(user).into_iter().flatten() {
            out.push(InForce {
                role: a.role.clone(),
                scope: a.scope.clone(),
                via: Via::Direct,
            });
        }
        let local = self.local_groups_of(user);
        let member = |group: &str| {
            if let Some(name) = group.strip_prefix("idp:") {
                idp_groups.iter().any(|g| g == name)
            } else if let Some(name) = group.strip_prefix("local:") {
                local.contains(&name)
            } else {
                false
            }
        };
        for (mappings, pinned) in [(&self.parts.mappings, false), (&self.parts.pinned, true)] {
            for m in mappings.iter().filter(|m| member(&m.group)) {
                out.push(InForce {
                    role: m.role.clone(),
                    scope: m.scope.clone(),
                    via: if pinned {
                        Via::Pinned
                    } else {
                        Via::Group(m.group.clone())
                    },
                });
            }
        }
        out.retain(|a| self.has_role(&a.role));
        out
    }

    /// The role ids in force, sorted and without repeats (the principal's `roles` in the audit
    /// log).
    pub fn role_ids(&self, user: &str, idp_groups: &[String]) -> Vec<String> {
        let ids: BTreeSet<String> = self
            .in_force(user, idp_groups)
            .into_iter()
            .map(|a| a.role)
            .collect();
        ids.into_iter().collect()
    }

    /// Whether any assignment in force grants `perm` (whatever its scope).
    pub fn holds_anywhere(&self, in_force: &[InForce], perm: &str) -> bool {
        in_force.iter().any(|a| self.grants(&a.role, perm))
    }

    /// Whether an unscoped assignment in force grants `perm`.
    pub fn holds_everywhere(&self, in_force: &[InForce], perm: &str) -> bool {
        in_force
            .iter()
            .any(|a| a.scope.is_everywhere() && self.grants(&a.role, perm))
    }

    /// Whether an assignment in force grants `perm` with a scope covering `target`.
    pub fn holds_on(
        &self,
        in_force: &[InForce],
        perm: &str,
        target: &TargetRef,
        own_personal: bool,
    ) -> bool {
        in_force
            .iter()
            .any(|a| self.grants(&a.role, perm) && a.scope.covers(target, own_personal))
    }
}

/// The policy in force, swapped atomically on every change.
#[derive(Clone, Default)]
pub struct PolicyHandle(Arc<RwLock<Arc<Policy>>>);

impl PolicyHandle {
    pub fn new(policy: Policy) -> PolicyHandle {
        PolicyHandle(Arc::new(RwLock::new(Arc::new(policy))))
    }

    /// The current snapshot.
    pub fn current(&self) -> Arc<Policy> {
        Arc::clone(&self.0.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Puts `policy` in force for every call that starts from now on.
    pub fn replace(&self, policy: Policy) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(policy);
    }

    /// Changes the parts and puts the result in force; returns the new snapshot.
    pub fn update(&self, change: impl FnOnce(&mut PolicyParts)) -> Arc<Policy> {
        let mut guard = self.0.write().unwrap_or_else(|e| e.into_inner());
        let mut parts = guard.parts.clone();
        change(&mut parts);
        let next = Arc::new(Policy::new(parts));
        *guard = Arc::clone(&next);
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::ScopeEntry;

    fn scope(entries: &[&str]) -> Scope {
        Scope::only(
            entries
                .iter()
                .map(|e| e.parse::<ScopeEntry>().unwrap())
                .collect(),
        )
    }

    fn parts() -> PolicyParts {
        let mut p = PolicyParts {
            default_role: Some("member".into()),
            default_admin: Some("human:account:ADMIN".into()),
            ..PolicyParts::default()
        };
        p.custom_roles.push(CustomRole {
            id: "deployer".into(),
            name: "Deployer".into(),
            description: String::new(),
            permissions: ["temporal.write", "made.up", "app.self"]
                .map(str::to_owned)
                .into(),
        });
        p.direct.insert(
            "human:account:A".into(),
            vec![
                Assignment {
                    role: "viewer".into(),
                    scope: Scope::everywhere(),
                },
                Assignment {
                    role: "ghost".into(),
                    scope: Scope::everywhere(),
                },
            ],
        );
        p.mappings.push(GroupMapping {
            group: "idp:ops".into(),
            role: "operator".into(),
            scope: scope(&["profile:P/ns:team-a-*"]),
        });
        p.mappings.push(GroupMapping {
            group: "local:deployers".into(),
            role: "deployer".into(),
            scope: Scope::everywhere(),
        });
        p.pinned.push(GroupMapping {
            group: "idp:admins".into(),
            role: "admin".into(),
            scope: Scope::everywhere(),
        });
        p.local_groups
            .insert("deployers".into(), ["human:account:A".to_owned()].into());
        p
    }

    #[test]
    fn assignments_in_force_come_from_every_source() {
        let policy = Policy::new(parts());
        let vias = |user: &str, groups: &[&str]| -> Vec<(String, String)> {
            let groups: Vec<String> = groups.iter().map(|g| (*g).to_owned()).collect();
            policy
                .in_force(user, &groups)
                .into_iter()
                .map(|a| (a.role, a.via.label()))
                .collect()
        };
        assert_eq!(
            vias("human:account:A", &["ops"]),
            [
                ("member", "default"),
                ("viewer", "direct"),
                ("operator", "group:idp:ops"),
                ("deployer", "group:local:deployers"),
            ]
            .map(|(r, v)| (r.to_owned(), v.to_owned()))
        );
        assert_eq!(
            vias("human:account:ADMIN", &[]),
            [("member", "default"), ("admin", "pinned")].map(|(r, v)| (r.to_owned(), v.to_owned()))
        );
        assert_eq!(
            vias("human:oidc:b", &["admins", "other"]),
            [("member", "default"), ("admin", "pinned")].map(|(r, v)| (r.to_owned(), v.to_owned()))
        );
        assert_eq!(
            policy.role_ids("human:account:A", &[]),
            ["deployer", "member", "viewer"]
        );
    }

    #[test]
    fn custom_roles_grant_only_catalogue_permissions() {
        let policy = Policy::new(parts());
        assert!(policy.grants("deployer", "temporal.write"));
        assert!(!policy.grants("deployer", "made.up"));
        assert!(!policy.grants("deployer", "app.self"));
        assert!(!policy.grants("ghost", "app.read"));
        // A stored role cannot redefine a built-in one.
        let mut p = parts();
        p.custom_roles.push(CustomRole {
            id: "viewer".into(),
            name: "x".into(),
            description: String::new(),
            permissions: ["nats.destroy".to_owned()].into(),
        });
        assert!(!Policy::new(p).grants("viewer", "nats.destroy"));
    }

    #[test]
    fn scopes_decide_where_a_permission_counts() {
        let policy = Policy::new(parts());
        let a = policy.in_force("human:oidc:b", &["ops".into()]);
        let inside = TargetRef::new("profile", "P/ns:team-a-web");
        let outside = TargetRef::new("profile", "P/ns:team-b");
        assert!(policy.holds_on(&a, "temporal.write", &inside, false));
        assert!(!policy.holds_on(&a, "temporal.write", &outside, false));
        assert!(policy.holds_anywhere(&a, "temporal.write"));
        assert!(!policy.holds_everywhere(&a, "temporal.write"));
        assert!(policy.holds_everywhere(&a, "app.read"));
    }

    #[test]
    fn no_default_role_means_nothing() {
        let policy = Policy::new(PolicyParts::default());
        assert!(policy.in_force("human:account:A", &[]).is_empty());
    }

    #[test]
    fn the_handle_swaps_whole_snapshots() {
        let handle = PolicyHandle::new(Policy::new(parts()));
        let before = handle.current();
        handle.update(|p| {
            p.disabled.insert("human:account:A".into());
        });
        assert!(!before.is_disabled("human:account:A"));
        assert!(handle.current().is_disabled("human:account:A"));
    }

    #[test]
    fn ids_and_groups() {
        assert!(is_role_id("ops-team2"));
        for bad in ["a", "Ops", "1ops", "ops_team", &"a".repeat(33)] {
            assert!(!is_role_id(bad), "{bad}");
        }
        assert!(is_group("idp:ops") && is_group("local:x y"));
        assert!(!is_group("ops") && !is_group("idp:") && !is_group("ldap:x"));
    }
}
