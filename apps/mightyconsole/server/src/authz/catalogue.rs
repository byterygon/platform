//! The permission catalogue and the built-in roles (DOC-25 §3.3.1, §3.3.2).
//!
//! Permission names are matched exactly. Each has a **target kind**, which says what an
//! assignment's scope must cover for it to count:
//!
//! - [`TargetKind::Any`]: any assignment of a role holding the permission, whatever its scope;
//! - [`TargetKind::Tenant`]: only an unscoped assignment;
//! - [`TargetKind::Profile`]: an assignment whose scope covers the call's target (a profile, a
//!   context or namespace in it, a terminal opened on it). A call to such a procedure without a
//!   target is refused.
//!
//! The built-in roles are recomputed from this table at every start, so a new tool's
//! permissions reach them by an upgrade: a new tool adds its name to [`TOOLS`] (and its own
//! permissions, such as `k8s.exec`, to [`TOOL_EXTRA`] and the role rows), and the completeness
//! test fails until it does.

use std::collections::BTreeSet;

/// What an assignment's scope must cover for a permission to count.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetKind {
    Any,
    Tenant,
    Profile,
}

/// Every tool, built or planned. Each has `<tool>.read`, `<tool>.write` and `<tool>.destroy`
/// (the sample tool `echo` has no destroy).
pub const TOOLS: [&str; 7] = [
    "nats",
    "kafka",
    "k8s",
    "temporal",
    "docker",
    "langgraph",
    "echo",
];

/// Tools whose targets have namespaces: the target of a call that names one is
/// `<profile>/ns:<namespace>` (Kubernetes adds its context, TSK-82).
pub const NAMESPACED_TOOLS: [&str; 2] = ["temporal", "k8s"];

/// A tool's own permissions beyond read, write and destroy.
pub const TOOL_EXTRA: [&str; 4] = [
    "k8s.secrets.read",
    "k8s.exec",
    "docker.exec",
    "docker.files.read",
];

/// Implied for every signed-in human; no role holds it (`app.me`, `app.sessions.*`,
/// `app.confirmations.*`, `app.account.*`).
pub const APP_SELF: &str = "app.self";

/// Typing into a terminal the same connection opened; its target is the terminal's profile.
pub const TERM_WRITE: &str = "term.write";

/// Create, edit and delete one's own personal profiles; the owner then holds every permission of
/// that profile's tool on it (DOC-25 §3.3.4 step 4).
pub const PROFILES_PERSONAL: &str = "profiles.personal";

/// The administrator role's id.
pub const ADMIN_ROLE: &str = "admin";
/// The role every user gets (`auth.default_role`).
pub const MEMBER_ROLE: &str = "member";

/// Permissions with a fixed target kind (the tools' are generated from [`TOOLS`]).
const FIXED: [(&str, TargetKind); 13] = [
    ("app.read", TargetKind::Any),
    (APP_SELF, TargetKind::Any),
    ("messaging.read", TargetKind::Any),
    (TERM_WRITE, TargetKind::Profile),
    (PROFILES_PERSONAL, TargetKind::Any),
    ("profiles.manage", TargetKind::Tenant),
    ("profiles.hostAccess", TargetKind::Tenant),
    ("admin.users.read", TargetKind::Tenant),
    ("admin.users.write", TargetKind::Tenant),
    ("admin.roles.write", TargetKind::Tenant),
    ("admin.sessions.revoke", TargetKind::Tenant),
    ("admin.secrets.manage", TargetKind::Tenant),
    ("audit.read", TargetKind::Tenant),
];

/// The tool a permission belongs to: `docker` for `docker.exec`; `None` for the rest
/// (`term.write` belongs to the terminal's tool, see [`belongs_to`]).
pub fn tool_of(perm: &str) -> Option<&'static str> {
    let first = perm.split('.').next()?;
    TOOLS.iter().copied().find(|t| *t == first)
}

/// Whether `perm` acts on a profile of `tool`: the tool's own permissions, and `term.write` on
/// its terminals (DOC-25 §3.3.4 step 4).
pub fn belongs_to(perm: &str, tool: &str) -> bool {
    perm == TERM_WRITE || tool_of(perm) == Some(tool)
}

fn tool_permissions(tool: &str) -> Vec<String> {
    let mut perms = vec![format!("{tool}.read"), format!("{tool}.write")];
    if tool != "echo" {
        perms.push(format!("{tool}.destroy"));
    }
    perms.extend(
        TOOL_EXTRA
            .iter()
            .filter(|p| tool_of(p) == Some(tool))
            .map(|p| (*p).to_owned()),
    );
    perms
}

/// The target kind of a permission; `None` for a permission not in the catalogue (it grants
/// nothing).
pub fn target_kind(perm: &str) -> Option<TargetKind> {
    if let Some((_, kind)) = FIXED.iter().find(|(p, _)| *p == perm) {
        return Some(*kind);
    }
    let tool = tool_of(perm)?;
    tool_permissions(tool)
        .iter()
        .any(|p| p == perm)
        .then_some(TargetKind::Profile)
}

/// Every permission in the catalogue, sorted.
pub fn all() -> BTreeSet<String> {
    let mut all: BTreeSet<String> = FIXED.iter().map(|(p, _)| (*p).to_owned()).collect();
    for tool in TOOLS {
        all.extend(tool_permissions(tool));
    }
    all
}

/// The built-in roles, in the order the UI lists them.
pub const BUILT_IN: [&str; 4] = [MEMBER_ROLE, "viewer", "operator", ADMIN_ROLE];

/// The permissions of a built-in role (DOC-25 §3.3.2); `None` for any other id.
pub fn built_in(role: &str) -> Option<BTreeSet<String>> {
    let mut perms: BTreeSet<String> = ["app.read", "messaging.read", PROFILES_PERSONAL]
        .into_iter()
        .map(str::to_owned)
        .collect();
    let rank = match role {
        MEMBER_ROLE => return Some(perms),
        "viewer" => 1,
        "operator" => 2,
        ADMIN_ROLE => 3,
        _ => return None,
    };
    for tool in TOOLS {
        perms.insert(format!("{tool}.read"));
        if rank >= 2 {
            perms.insert(format!("{tool}.write"));
        }
        if rank >= 3 && tool != "echo" {
            perms.insert(format!("{tool}.destroy"));
        }
    }
    if rank >= 2 {
        perms.extend(
            ["docker.exec", "k8s.exec", TERM_WRITE, "docker.files.read"].map(str::to_owned),
        );
    }
    if rank >= 3 {
        perms.extend(
            [
                "k8s.secrets.read",
                "profiles.manage",
                "profiles.hostAccess",
                "admin.users.read",
                "admin.users.write",
                "admin.roles.write",
                "admin.sessions.revoke",
                "admin.secrets.manage",
                "audit.read",
            ]
            .map(str::to_owned),
        );
    }
    Some(perms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_built_in_permission_is_in_the_catalogue() {
        let all = all();
        for role in BUILT_IN {
            for perm in built_in(role).unwrap() {
                assert!(all.contains(&perm), "{role}: {perm}");
                assert!(target_kind(&perm).is_some(), "{perm}");
            }
        }
        assert!(built_in("root").is_none());
    }

    #[test]
    fn app_self_is_in_no_role_and_admin_holds_everything_else() {
        let admin = built_in(ADMIN_ROLE).unwrap();
        for perm in all() {
            assert_eq!(admin.contains(&perm), perm != APP_SELF, "{perm}");
        }
    }

    #[test]
    fn the_roles_follow_the_matrix() {
        let member = built_in(MEMBER_ROLE).unwrap();
        let viewer = built_in("viewer").unwrap();
        let operator = built_in("operator").unwrap();
        assert_eq!(member.len(), 3);
        assert!(member.is_subset(&viewer) && viewer.is_subset(&operator));
        assert!(viewer.contains("temporal.read") && !viewer.contains("temporal.write"));
        assert!(!viewer.contains("docker.exec") && !viewer.contains("docker.files.read"));
        assert!(operator.contains("docker.exec") && operator.contains(TERM_WRITE));
        assert!(!operator.contains("nats.destroy") && !operator.contains("k8s.secrets.read"));
        assert!(!operator.contains("profiles.manage") && !operator.contains("audit.read"));
    }

    #[test]
    fn target_kinds_and_tools() {
        assert_eq!(target_kind("nats.read"), Some(TargetKind::Profile));
        assert_eq!(target_kind("k8s.secrets.read"), Some(TargetKind::Profile));
        assert_eq!(target_kind("echo.destroy"), None);
        assert_eq!(target_kind("nats.anything"), None);
        assert_eq!(target_kind("admin.users.read"), Some(TargetKind::Tenant));
        assert_eq!(target_kind("app.read"), Some(TargetKind::Any));
        assert_eq!(tool_of("docker.files.read"), Some("docker"));
        assert_eq!(tool_of("messaging.read"), None);
        assert!(belongs_to(TERM_WRITE, "docker"));
        assert!(belongs_to("docker.exec", "docker"));
        assert!(!belongs_to("nats.write", "docker"));
    }
}
