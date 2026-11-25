//! The management procedures (DOC-25 §3.3.7): users and their roles, custom roles, group
//! mappings and local groups, sessions. Each carries its own `admin.*` permission (target kind
//! tenant: only an unscoped assignment grants it); `app.sessions.*` is one's own (`app.self`).
//! Every change goes through [`Management::change`]: the last-administrator rule, the store, the
//! policy in force, and the sessions of everyone who lost a permission. The router audits every
//! call (they are Write or Destructive); deletions need the destroy confirmation.
//!
//! Users are named by their principal id (`human:account:<id>`, `human:oidc:<sub>`). An OIDC user
//! exists once they have signed in; before that, an IdP group gives them roles.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use ambidex::{Ctx, rpc};
use ambidex_axum::accounts::{AccountStore as _, CreateAccountError, CreatedBy, account_id_of};
use schemars::JsonSchema;
use security_types::{Scope, ScopeEntry};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::admin::ADMIN_USERNAME;
use crate::authz::catalogue::{self, TargetKind};
use crate::authz::policy::{
    Assignment, CustomRole, GroupMapping, InForce, Policy, is_group, is_role_id,
};
use crate::core::{Empty, ToolError, ToolErrorKind, ToolResult};
use crate::management::{ChangeError, Management};

const SYSTEM: &str = "admin";

/// Users per page of `admin.users.list`.
pub const PAGE: usize = 500;

fn invalid(field: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(SYSTEM, field, message)
}

fn not_found(resource: &str, message: impl Into<String>) -> ToolError {
    ToolError::not_found(SYSTEM, resource, message)
}

fn conflict(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorKind::Conflict, SYSTEM, message)
}

fn store_error(e: impl std::fmt::Display) -> ToolError {
    ToolError::new(ToolErrorKind::Remote, SYSTEM, e.to_string())
}

fn change_error(e: ChangeError) -> ToolError {
    match e {
        ChangeError::LastAdministrator => conflict(e.to_string()),
        ChangeError::Store(e) => store_error(e),
    }
}

/// Runs blocking store work off the async threads.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| store_error(format!("the store task failed: {e}")))?
}

// ---- wire types ------------------------------------------------------------------------------

/// A scope on the wire: `null` (everywhere) or its entries (`profile:<id>/ns:<pattern>`, ...).
pub type ScopeWire = Option<Vec<String>>;

fn scope_to_wire(scope: &Scope) -> ScopeWire {
    scope
        .0
        .as_ref()
        .map(|entries| entries.iter().map(ToString::to_string).collect())
}

fn scope_from_wire(field: &str, scope: &ScopeWire) -> Result<Scope, ToolError> {
    match scope {
        None => Ok(Scope::everywhere()),
        Some(entries) => Ok(Scope::only(
            entries
                .iter()
                .map(|e| {
                    e.parse::<ScopeEntry>()
                        .map_err(|e| invalid(field, e.to_string()))
                })
                .collect::<Result<_, _>>()?,
        )),
    }
}

/// A role in force for a user, and how it reached them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleGrant {
    pub role: String,
    /// `null`: everywhere.
    pub scope: ScopeWire,
    /// `default`, `direct`, `group:<idp:…|local:…>` or `pinned`.
    pub via: String,
}

/// A permission a user holds, and where.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PermissionGrant {
    pub perm: String,
    /// Held everywhere (an unscoped assignment grants it).
    pub everywhere: bool,
    /// Otherwise, the scope entries it is held in.
    pub scope: Vec<String>,
}

/// The roles in force as the wire shows them.
pub fn role_grants(in_force: &[InForce]) -> Vec<RoleGrant> {
    in_force
        .iter()
        .map(|a| RoleGrant {
            role: a.role.clone(),
            scope: scope_to_wire(&a.scope),
            via: a.via.label(),
        })
        .collect()
}

/// The permissions those roles grant, each with where (`app.me`, for the UI to adapt).
pub fn permission_grants(policy: &Policy, in_force: &[InForce]) -> Vec<PermissionGrant> {
    let mut by_perm: BTreeMap<String, (bool, BTreeSet<String>)> = BTreeMap::new();
    for a in in_force {
        for perm in policy.role_permissions(&a.role).into_iter().flatten() {
            let entry = by_perm.entry(perm.clone()).or_default();
            match &a.scope.0 {
                None => entry.0 = true,
                Some(entries) => entry.1.extend(entries.iter().map(ToString::to_string)),
            }
        }
    }
    by_perm
        .into_iter()
        .map(|(perm, (everywhere, scope))| PermissionGrant {
            perm,
            everywhere,
            scope: if everywhere {
                Vec::new()
            } else {
                scope.into_iter().collect()
            },
        })
        .collect()
}

/// A user as the administrator sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    /// `human:account:<id>` or `human:oidc:<sub>`.
    pub id: String,
    /// `account` or `oidc`.
    pub kind: String,
    /// A built-in account's user name.
    pub username: Option<String>,
    pub display_name: String,
    pub email: Option<String>,
    /// The IdP's groups at the last sign-in (OIDC users).
    pub groups: Vec<String>,
    /// The local groups they are a member of.
    pub local_groups: Vec<String>,
    /// Their roles in force (IdP groups as of the last sign-in).
    pub roles: Vec<RoleGrant>,
    pub disabled: bool,
    /// A built-in account locked after wrong passwords.
    pub locked: bool,
    pub totp: bool,
    /// The default administrator (cannot be deleted; its `admin` is pinned).
    pub default_admin: bool,
    pub created_ms: Option<u64>,
    pub last_seen_ms: Option<u64>,
    /// Live sessions.
    pub sessions: u32,
}

#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersListInput {
    /// Matches the id, user name, name or e-mail (case-insensitive).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub text: Option<String>,
    /// Holds this role (any way).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub role: Option<String>,
    /// In this group (`idp:<name>` or `local:<name>`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub group: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub disabled: Option<bool>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UsersListOutput {
    /// At most 500, in id order, from `offset`.
    pub users: Vec<UserSummary>,
    /// Users matching the filter.
    pub total: u32,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UserIdInput {
    pub user_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssignmentInput {
    pub role: String,
    /// `null` or left out: everywhere.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub scope: ScopeWire,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetRolesInput {
    pub user_id: String,
    /// Replaces the user's direct assignments.
    pub assignments: Vec<AssignmentInput>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateUserInput {
    pub username: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub display_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub roles: Option<Vec<AssignmentInput>>,
    /// Local groups to add the account to (without `local:`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub groups: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResetPasswordInput {
    pub user_id: String,
    /// Also remove the account's TOTP and recovery codes.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub remove_totp: Option<bool>,
}

/// A one-time setup link to hand to the person (DOC-25 §3.2.6): it sets the account's password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetupLinkOutput {
    pub user_id: String,
    pub url: String,
    pub expires_ms: u64,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DeleteUserInput {
    pub user_id: String,
    /// The account's user name: what the person types to confirm; must match the account.
    pub username: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `member`, `viewer`, `operator`, `admin`: not editable.
    pub built_in: bool,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CataloguePermission {
    pub perm: String,
    /// `any`, `tenant` or `profile`: what a role's scope must cover for it to count.
    pub target_kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RolesListOutput {
    pub roles: Vec<RoleInfo>,
    pub catalogue: Vec<CataloguePermission>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleIdInput {
    /// The role id; what the person types to confirm a delete.
    pub role_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RoleInput {
    /// `[a-z][a-z0-9-]{1,31}`, not a built-in one.
    pub id: String,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    /// From the catalogue; a role with `docker.exec` or `k8s.exec` also gets `term.write`.
    pub permissions: Vec<String>,
}

/// A group mapping on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappingRow {
    /// `idp:<name>` or `local:<name>`.
    pub group: String,
    pub role: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub scope: ScopeWire,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LocalGroup {
    pub name: String,
    pub members: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsListOutput {
    /// Send it back with `admin.groups.set`; a stale one is a conflict.
    pub etag: u64,
    pub mappings: Vec<MappingRow>,
    /// `[[auth.group_roles]]` of the configuration: read-only.
    pub pinned: Vec<MappingRow>,
    pub local_groups: Vec<LocalGroup>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsSetInput {
    pub etag: u64,
    /// Replaces every editable mapping.
    pub mappings: Vec<MappingRow>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupCreateInput {
    /// Without `local:`; 1 to 256 characters.
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub members: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupNameInput {
    /// The local group's name; what the person types to confirm a delete.
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupMembersInput {
    pub name: String,
    /// Principal ids.
    pub members: Vec<String>,
}

/// A live login session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    /// `ls_…`.
    pub id: String,
    pub user: String,
    /// `password`, `totp` or `oidc`.
    pub method: String,
    pub created_ms: u64,
    pub last_activity_ms: u64,
    pub idle_expires_ms: u64,
    pub absolute_expires_ms: u64,
    /// The client address it signed in from.
    pub client: Option<String>,
    /// The caller's own session.
    pub current: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionsOutput {
    pub sessions: Vec<SessionRow>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdInput {
    pub session_id: String,
}

/// One of: a session, every session of a user, or every session but the caller's.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AdminRevokeInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub session_id: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub user_id: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub all: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RevokedOutput {
    pub revoked: u32,
}

// ---- helpers -----------------------------------------------------------------------------------

fn login_of(ctx: &Ctx) -> String {
    ambidex_axum::login_session_of(&ctx.session().id).to_owned()
}

fn session_row(s: &ambidex_axum::SessionInfo, own: &str) -> SessionRow {
    SessionRow {
        id: s.id.clone(),
        user: s.user.clone(),
        method: s.method.as_str().to_owned(),
        created_ms: s.created_ms,
        last_activity_ms: s.last_activity_ms,
        idle_expires_ms: s.idle_expires_ms,
        absolute_expires_ms: s.absolute_expires_ms,
        client: s.client.map(|c| c.to_string()),
        current: s.id == own,
    }
}

fn assignments_from(
    input: &[AssignmentInput],
    policy: &Policy,
) -> Result<Vec<Assignment>, ToolError> {
    input
        .iter()
        .enumerate()
        .map(|(i, a)| {
            if !policy.has_role(&a.role) {
                return Err(invalid(
                    &format!("assignments[{i}].role"),
                    format!("no role {:?}", a.role),
                ));
            }
            Ok(Assignment {
                role: a.role.clone(),
                scope: scope_from_wire(&format!("assignments[{i}].scope"), &a.scope)?,
            })
        })
        .collect()
}

fn mapping_row(m: &GroupMapping) -> MappingRow {
    MappingRow {
        group: m.group.clone(),
        role: m.role.clone(),
        scope: scope_to_wire(&m.scope),
    }
}

fn kind_name(kind: TargetKind) -> &'static str {
    match kind {
        TargetKind::Any => "any",
        TargetKind::Tenant => "tenant",
        TargetKind::Profile => "profile",
    }
}

fn role_infos(policy: &Policy) -> Vec<RoleInfo> {
    let mut out: Vec<RoleInfo> = catalogue::BUILT_IN
        .iter()
        .map(|id| RoleInfo {
            id: (*id).to_owned(),
            name: {
                let mut c = id.chars();
                c.next()
                    .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                    .unwrap_or_default()
            },
            description: String::new(),
            built_in: true,
            permissions: policy
                .role_permissions(id)
                .into_iter()
                .flatten()
                .cloned()
                .collect(),
        })
        .collect();
    for role in &policy.parts().custom_roles {
        if catalogue::built_in(&role.id).is_some() {
            continue;
        }
        out.push(RoleInfo {
            id: role.id.clone(),
            name: role.name.clone(),
            description: role.description.clone(),
            built_in: false,
            permissions: role.permissions.iter().cloned().collect(),
        });
    }
    out
}

/// A user's principal id names an account (`Some(account id)`) or an OIDC user (`None`).
fn account_of(user: &str) -> Option<&str> {
    account_id_of(user)
}

// ---- the procedures -------------------------------------------------------------------------

/// `admin.users.*`, `admin.roles.*`, `admin.groups.*`, `admin.sessions.*`.
pub struct AdminApi(pub Option<Arc<Management>>);

/// `app.sessions.*`: one's own sessions.
pub struct OwnSessionsApi(pub Option<Arc<Management>>);

fn the(m: &Option<Arc<Management>>) -> Result<&Arc<Management>, ToolError> {
    m.as_ref().ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::Remote,
            SYSTEM,
            "user management is not available on this server",
        )
    })
}

impl AdminApi {
    /// Every user (accounts and OIDC users), as summaries under `policy`.
    async fn summaries(&self, m: &Arc<Management>) -> Result<Vec<UserSummary>, ToolError> {
        let store = Arc::clone(&m.store);
        let (accounts, oidc) = blocking(move || {
            Ok((
                store.accounts().map_err(|e| store_error(e.0))?,
                store.oidc_users().map_err(|e| store_error(e.0))?,
            ))
        })
        .await?;
        let policy = m.policy.current();
        let live = m.sessions.list();
        let sessions = |user: &str| live.iter().filter(|s| s.user == user).count() as u32;
        let now = security_types::unix_now_ms();
        let mut out = Vec::new();
        for a in accounts {
            let id = a.principal_id();
            out.push(UserSummary {
                kind: "account".into(),
                username: Some(a.username.clone()),
                display_name: a.display_name.clone(),
                email: None,
                groups: Vec::new(),
                local_groups: policy
                    .local_groups_of(&id)
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                roles: role_grants(&policy.in_force(&id, &[])),
                disabled: a.disabled || policy.is_disabled(&id),
                locked: a.locked_until_ms.is_some_and(|until| until > now),
                totp: a.totp.is_some(),
                default_admin: policy.parts().default_admin.as_deref() == Some(id.as_str()),
                created_ms: Some(a.created_ms),
                last_seen_ms: a.last_seen_ms,
                sessions: sessions(&id),
                id,
            });
        }
        for u in oidc {
            out.push(UserSummary {
                kind: "oidc".into(),
                username: None,
                display_name: u.display_name.clone(),
                email: u.email.clone(),
                local_groups: policy
                    .local_groups_of(&u.id)
                    .into_iter()
                    .map(str::to_owned)
                    .collect(),
                roles: role_grants(&policy.in_force(&u.id, &u.groups)),
                groups: u.groups.clone(),
                disabled: u.disabled || policy.is_disabled(&u.id),
                locked: false,
                totp: false,
                default_admin: false,
                created_ms: Some(u.first_seen_ms),
                last_seen_ms: Some(u.last_seen_ms),
                sessions: sessions(&u.id),
                id: u.id,
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }

    async fn user(&self, m: &Arc<Management>, user_id: &str) -> Result<UserSummary, ToolError> {
        self.summaries(m)
            .await?
            .into_iter()
            .find(|u| u.id == user_id)
            .ok_or_else(|| not_found("user", format!("no user {user_id:?}")))
    }

    /// Disables or enables a user (account or OIDC user).
    async fn set_disabled(&self, ctx: &Ctx, user_id: &str, disabled: bool) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        self.user(m, user_id).await?;
        let by = ctx.principal().id.clone();
        let user = user_id.to_owned();
        let store_user = user.clone();
        m.change(
            &by,
            |p| {
                if disabled {
                    p.disabled.insert(user.clone());
                } else {
                    p.disabled.remove(&user);
                }
            },
            move |store| {
                let found = match account_of(&store_user) {
                    Some(id) => store
                        .update_account(id, |a| a.disabled = disabled)
                        .map_err(|e| e.0)?,
                    None => store
                        .update_oidc_user(&store_user, |u| u.disabled = disabled)
                        .map_err(|e| e.0)?,
                };
                found.ok_or_else(|| "the user is gone".to_owned())
            },
        )
        .await
        .map_err(change_error)?;
        if disabled {
            m.sessions.revoke_user(user_id, Some(&by));
        }
        Ok(Empty {})
    }
}

#[rpc::router(namespace = "admin.users")]
impl AdminApi {
    /// Users, accounts and OIDC users alike, with their roles in force; paged by 500, filtered by
    /// text, role, group and disabled.
    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn list(&self, _ctx: Ctx, input: UsersListInput) -> ToolResult<UsersListOutput> {
        let m = the(&self.0)?;
        let text = input.text.as_deref().map(str::to_lowercase);
        let users: Vec<UserSummary> = self
            .summaries(m)
            .await?
            .into_iter()
            .filter(|u| {
                text.as_deref().is_none_or(|t| {
                    [
                        Some(&u.id),
                        u.username.as_ref(),
                        Some(&u.display_name),
                        u.email.as_ref(),
                    ]
                    .into_iter()
                    .flatten()
                    .any(|f| f.to_lowercase().contains(t))
                })
            })
            .filter(|u| {
                input
                    .role
                    .as_deref()
                    .is_none_or(|r| u.roles.iter().any(|g| g.role == r))
            })
            .filter(|u| {
                input.group.as_deref().is_none_or(|g| {
                    if let Some(name) = g.strip_prefix("idp:") {
                        u.groups.iter().any(|x| x == name)
                    } else if let Some(name) = g.strip_prefix("local:") {
                        u.local_groups.iter().any(|x| x == name)
                    } else {
                        false
                    }
                })
            })
            .filter(|u| input.disabled.is_none_or(|d| u.disabled == d))
            .collect();
        let total = users.len() as u32;
        let offset = input.offset.unwrap_or(0) as usize;
        Ok(UsersListOutput {
            users: users.into_iter().skip(offset).take(PAGE).collect(),
            total,
        })
    }

    /// One user.
    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn get(&self, _ctx: Ctx, input: UserIdInput) -> ToolResult<UserSummary> {
        let m = the(&self.0)?;
        Ok(self.user(m, &input.user_id).await?)
    }

    /// Replaces the user's direct assignments (the default administrator's own `admin` is pinned
    /// and stays). Refused when it would remove the last administrator; ends the user's sessions
    /// when they lose a permission.
    #[rpc::mutation(name = "setRoles", perm = "admin.users.write", risk = Risk::Write)]
    async fn set_roles(&self, ctx: Ctx, input: SetRolesInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        self.user(m, &input.user_id).await?;
        let assignments = assignments_from(&input.assignments, &m.policy.current())?;
        let user = input.user_id.clone();
        let stored = assignments.clone();
        m.change(
            &ctx.principal().id,
            |p| {
                if assignments.is_empty() {
                    p.direct.remove(&user);
                } else {
                    p.direct.insert(user.clone(), assignments);
                }
            },
            move |store| {
                store
                    .set_assignments(&input.user_id, &stored)
                    .map_err(|e| e.0)
            },
        )
        .await
        .map_err(change_error)?;
        Ok(Empty {})
    }

    /// Disables a user: their sessions end and they cannot sign in. The last administrator
    /// cannot be disabled.
    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Write)]
    async fn disable(&self, ctx: Ctx, input: UserIdInput) -> ToolResult<Empty> {
        self.set_disabled(&ctx, &input.user_id, true).await
    }

    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Write)]
    async fn enable(&self, ctx: Ctx, input: UserIdInput) -> ToolResult<Empty> {
        self.set_disabled(&ctx, &input.user_id, false).await
    }

    /// Makes a built-in account with no password, its roles and local groups, and answers a
    /// one-time setup link that sets the password (DOC-25 §3.2.6).
    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: CreateUserInput) -> ToolResult<SetupLinkOutput> {
        let m = the(&self.0)?;
        let accounts = m.accounts.as_ref().ok_or_else(|| {
            invalid(
                "username",
                "built-in accounts are turned off on this server",
            )
        })?;
        let policy = m.policy.current();
        let assignments = assignments_from(input.roles.as_deref().unwrap_or_default(), &policy)?;
        let groups: Vec<String> = input.groups.clone().unwrap_or_default();
        for g in &groups {
            if !policy.parts().local_groups.contains_key(g) {
                return Err(invalid("groups", format!("no local group {g:?}")).into());
            }
        }
        let by = ctx.principal().id.clone();
        let account = accounts
            .create_account(
                &input.username,
                input.display_name.as_deref(),
                None,
                false,
                CreatedBy::Administrator(by.clone()),
            )
            .await
            .map_err(|e| match e {
                CreateAccountError::InvalidUsername => {
                    invalid("username", "3 to 64 characters of a-z 0-9 . _ -")
                }
                CreateAccountError::InvalidDisplayName => {
                    invalid("displayName", "1 to 128 printable characters")
                }
                CreateAccountError::UsernameTaken => invalid("username", "this user name is taken"),
                other => store_error(format!("{other:?}")),
            })?;
        let user = account.principal_id();
        if !assignments.is_empty() || !groups.is_empty() {
            let (u, a, g) = (user.clone(), assignments.clone(), groups.clone());
            let (su, sa, sg) = (user.clone(), assignments, groups);
            m.change(
                &by,
                move |p| {
                    if !a.is_empty() {
                        p.direct.insert(u.clone(), a);
                    }
                    for name in g {
                        p.local_groups.entry(name).or_default().insert(u.clone());
                    }
                },
                move |store| {
                    if !sa.is_empty() {
                        store.set_assignments(&su, &sa).map_err(|e| e.0)?;
                    }
                    let parts = store.policy_parts().map_err(|e| e.0)?;
                    for name in sg {
                        let mut members =
                            parts.local_groups.get(&name).cloned().unwrap_or_default();
                        members.insert(su.clone());
                        store.put_group(&name, &members).map_err(|e| e.0)?;
                    }
                    Ok(())
                },
            )
            .await
            .map_err(change_error)?;
        }
        let link = accounts
            .create_setup_link(&account.id)
            .await
            .map_err(|e| store_error(e.0))?;
        Ok(SetupLinkOutput {
            user_id: user,
            url: link.url.to_string(),
            expires_ms: link.expires_ms,
        })
    }

    /// Answers a one-time setup link that sets a new password for a built-in account; ends its
    /// sessions; with `removeTotp`, also removes its second factor.
    #[rpc::mutation(name = "resetPassword", perm = "admin.users.write", risk = Risk::Write)]
    async fn reset_password(
        &self,
        ctx: Ctx,
        input: ResetPasswordInput,
    ) -> ToolResult<SetupLinkOutput> {
        let m = the(&self.0)?;
        let accounts = m
            .accounts
            .as_ref()
            .ok_or_else(|| invalid("userId", "built-in accounts are turned off on this server"))?;
        let id = account_of(&input.user_id)
            .ok_or_else(|| invalid("userId", "only a built-in account has a password"))?;
        accounts
            .store()
            .by_id(id)
            .await
            .map_err(|e| store_error(e.0))?
            .ok_or_else(|| not_found("user", format!("no user {:?}", input.user_id)))?;
        if input.remove_totp.unwrap_or(false) {
            accounts
                .clear_totp(id)
                .await
                .map_err(|e| store_error(e.0))?;
        }
        let link = accounts
            .create_setup_link(id)
            .await
            .map_err(|e| store_error(e.0))?;
        m.sessions
            .revoke_user(&input.user_id, Some(&ctx.principal().id));
        Ok(SetupLinkOutput {
            user_id: input.user_id,
            url: link.url.to_string(),
            expires_ms: link.expires_ms,
        })
    }

    /// Ends a built-in account's lockout.
    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Write)]
    async fn unlock(&self, _ctx: Ctx, input: UserIdInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let accounts = m
            .accounts
            .as_ref()
            .ok_or_else(|| invalid("userId", "built-in accounts are turned off on this server"))?;
        let id = account_of(&input.user_id)
            .ok_or_else(|| invalid("userId", "only a built-in account is locked"))?;
        accounts.unlock(id).await.map_err(|e| store_error(e.0))?;
        Ok(Empty {})
    }

    /// Deletes a built-in account, its assignments and group memberships (an OIDC user is
    /// disabled instead). The default administrator and the last administrator cannot be
    /// deleted. Needs the destroy confirmation: the phrase is the user name.
    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: DeleteUserInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let user = self.user(m, &input.user_id).await?;
        if user.kind != "account" {
            return Err(invalid("userId", "an OIDC user is disabled, not deleted").into());
        }
        if user.username.as_deref() != Some(input.username.as_str()) {
            return Err(invalid("username", "this is not the account's user name").into());
        }
        if user.default_admin || input.username == ADMIN_USERNAME {
            return Err(conflict("the default administrator cannot be deleted").into());
        }
        let by = ctx.principal().id.clone();
        let id = input.user_id.clone();
        let store_id = id.clone();
        m.change(
            &by,
            |p| {
                p.direct.remove(&id);
                p.disabled.remove(&id);
                for members in p.local_groups.values_mut() {
                    members.remove(&id);
                }
            },
            move |store| {
                let parts = store.policy_parts().map_err(|e| e.0)?;
                for (name, members) in &parts.local_groups {
                    if members.contains(&store_id) {
                        let mut kept = members.clone();
                        kept.remove(&store_id);
                        store.put_group(name, &kept).map_err(|e| e.0)?;
                    }
                }
                store.set_assignments(&store_id, &[]).map_err(|e| e.0)?;
                let account = account_of(&store_id).unwrap_or_default();
                store.delete_account(account).map_err(|e| e.0)
            },
        )
        .await
        .map_err(change_error)?;
        m.sessions.revoke_user(&input.user_id, Some(&by));
        Ok(Empty {})
    }
}

/// `admin.roles.*`.
pub struct AdminRolesApi(pub Option<Arc<Management>>);

fn custom_role(input: &RoleInput) -> Result<CustomRole, ToolError> {
    if !is_role_id(&input.id) {
        return Err(invalid("id", "a role id is [a-z][a-z0-9-]{1,31}"));
    }
    if catalogue::built_in(&input.id).is_some() {
        return Err(invalid("id", "the built-in roles cannot be edited"));
    }
    let name = input.name.trim();
    if name.is_empty() || name.chars().count() > 128 {
        return Err(invalid("name", "1 to 128 characters"));
    }
    let mut permissions = BTreeSet::new();
    for p in &input.permissions {
        if catalogue::target_kind(p).is_none() || p == catalogue::APP_SELF {
            return Err(invalid(
                "permissions",
                format!("{p:?} is not in the catalogue"),
            ));
        }
        permissions.insert(p.clone());
    }
    if permissions.contains("docker.exec") || permissions.contains("k8s.exec") {
        permissions.insert(catalogue::TERM_WRITE.to_owned());
    }
    Ok(CustomRole {
        id: input.id.clone(),
        name: name.to_owned(),
        description: input.description.clone().unwrap_or_default(),
        permissions,
    })
}

#[rpc::router(namespace = "admin.roles")]
impl AdminRolesApi {
    /// The built-in and custom roles, with the permission catalogue.
    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn list(&self, _ctx: Ctx, _input: Empty) -> ToolResult<RolesListOutput> {
        let m = the(&self.0)?;
        let policy = m.policy.current();
        Ok(RolesListOutput {
            roles: role_infos(&policy),
            catalogue: catalogue::all()
                .into_iter()
                .filter(|p| p != catalogue::APP_SELF)
                .map(|perm| CataloguePermission {
                    target_kind: kind_name(
                        catalogue::target_kind(&perm).unwrap_or(TargetKind::Tenant),
                    )
                    .to_owned(),
                    perm,
                })
                .collect(),
        })
    }

    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn get(&self, _ctx: Ctx, input: RoleIdInput) -> ToolResult<RoleInfo> {
        let m = the(&self.0)?;
        Ok(role_infos(&m.policy.current())
            .into_iter()
            .find(|r| r.id == input.role_id)
            .ok_or_else(|| not_found("role", format!("no role {:?}", input.role_id)))?)
    }

    /// A new custom role.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: RoleInput) -> ToolResult<RoleInfo> {
        let m = the(&self.0)?;
        let role = custom_role(&input)?;
        if m.policy.current().has_role(&role.id) {
            return Err(invalid("id", "a role with this id exists").into());
        }
        let (r, stored) = (role.clone(), role.clone());
        m.change(
            &ctx.principal().id,
            move |p| p.custom_roles.push(r),
            move |store| store.put_role(&stored).map_err(|e| e.0),
        )
        .await
        .map_err(change_error)?;
        Ok(role_infos(&m.policy.current())
            .into_iter()
            .find(|r| r.id == role.id)
            .expect("just made"))
    }

    /// Changes a custom role; everyone who loses a permission by it is signed out.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Write)]
    async fn update(&self, ctx: Ctx, input: RoleInput) -> ToolResult<RoleInfo> {
        let m = the(&self.0)?;
        let role = custom_role(&input)?;
        if !m
            .policy
            .current()
            .parts()
            .custom_roles
            .iter()
            .any(|r| r.id == role.id)
        {
            return Err(not_found("role", format!("no custom role {:?}", role.id)).into());
        }
        let (r, stored) = (role.clone(), role.clone());
        m.change(
            &ctx.principal().id,
            move |p| {
                for existing in &mut p.custom_roles {
                    if existing.id == r.id {
                        *existing = r.clone();
                    }
                }
            },
            move |store| store.put_role(&stored).map_err(|e| e.0),
        )
        .await
        .map_err(change_error)?;
        Ok(role_infos(&m.policy.current())
            .into_iter()
            .find(|r| r.id == role.id)
            .expect("just changed"))
    }

    /// Deletes a custom role; refused while it is assigned or mapped. Needs the destroy
    /// confirmation: the phrase is the role id.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: RoleIdInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let policy = m.policy.current();
        let parts = policy.parts();
        if !parts.custom_roles.iter().any(|r| r.id == input.role_id) {
            return Err(not_found("role", format!("no custom role {:?}", input.role_id)).into());
        }
        let assigned = parts
            .direct
            .values()
            .flatten()
            .any(|a| a.role == input.role_id);
        let mapped = parts
            .mappings
            .iter()
            .chain(&parts.pinned)
            .any(|g| g.role == input.role_id);
        if assigned || mapped || parts.default_role.as_deref() == Some(input.role_id.as_str()) {
            return Err(conflict("the role is assigned or mapped; remove those first").into());
        }
        let (id, stored) = (input.role_id.clone(), input.role_id.clone());
        m.change(
            &ctx.principal().id,
            move |p| p.custom_roles.retain(|r| r.id != id),
            move |store| store.delete_role(&stored).map(|_| ()).map_err(|e| e.0),
        )
        .await
        .map_err(change_error)?;
        Ok(Empty {})
    }
}

/// `admin.groups.*`: group mappings and local groups.
pub struct AdminGroupsApi(pub Option<Arc<Management>>);

fn local_group_name(field: &str, name: &str) -> Result<String, ToolError> {
    if is_group(&format!("local:{name}")) {
        Ok(name.to_owned())
    } else {
        Err(invalid(field, "a group name is 1 to 256 characters"))
    }
}

impl AdminGroupsApi {
    /// Checks that every member is a known user.
    async fn known_users(&self, m: &Arc<Management>, members: &[String]) -> Result<(), ToolError> {
        let store = Arc::clone(&m.store);
        let members = members.to_vec();
        blocking(move || {
            for id in &members {
                let known = match account_of(id) {
                    Some(a) => store.account(a).map_err(|e| store_error(e.0))?.is_some(),
                    None => store.oidc_user(id).map_err(|e| store_error(e.0))?.is_some(),
                };
                if !known {
                    return Err(invalid(
                        "members",
                        format!("no user {id:?} (an OIDC user exists once they signed in)"),
                    ));
                }
            }
            Ok(())
        })
        .await
    }

    async fn set_members(
        &self,
        ctx: &Ctx,
        name: &str,
        change: impl FnOnce(&mut BTreeSet<String>) + Clone + Send + 'static,
    ) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let name = local_group_name("name", name)?;
        if !m.policy.current().parts().local_groups.contains_key(&name) {
            return Err(not_found("group", format!("no local group {name:?}")).into());
        }
        let (n, stored, c) = (name.clone(), name, change.clone());
        m.change(
            &ctx.principal().id,
            move |p| {
                if let Some(members) = p.local_groups.get_mut(&n) {
                    change(members);
                }
            },
            move |store| {
                let parts = store.policy_parts().map_err(|e| e.0)?;
                let mut members = parts.local_groups.get(&stored).cloned().unwrap_or_default();
                c(&mut members);
                store.put_group(&stored, &members).map_err(|e| e.0)
            },
        )
        .await
        .map_err(change_error)?;
        Ok(Empty {})
    }
}

#[rpc::router(namespace = "admin.groups")]
impl AdminGroupsApi {
    /// The editable mappings with their etag, the pinned ones, and the local groups.
    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn list(&self, _ctx: Ctx, _input: Empty) -> ToolResult<GroupsListOutput> {
        let m = the(&self.0)?;
        let store = Arc::clone(&m.store);
        let stored = blocking(move || store.mappings().map_err(|e| store_error(e.0))).await?;
        let policy = m.policy.current();
        Ok(GroupsListOutput {
            etag: stored.etag,
            mappings: stored.mappings.iter().map(mapping_row).collect(),
            pinned: policy.parts().pinned.iter().map(mapping_row).collect(),
            local_groups: policy
                .parts()
                .local_groups
                .iter()
                .map(|(name, members)| LocalGroup {
                    name: name.clone(),
                    members: members.iter().cloned().collect(),
                })
                .collect(),
        })
    }

    /// Replaces the editable mappings as a whole; a stale etag is a conflict. Refused when it
    /// would remove the last administrator; everyone who loses a permission is signed out.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Write)]
    async fn set(&self, ctx: Ctx, input: GroupsSetInput) -> ToolResult<GroupsListOutput> {
        let m = the(&self.0)?;
        let policy = m.policy.current();
        let mut mappings = Vec::new();
        for (i, row) in input.mappings.iter().enumerate() {
            if !is_group(&row.group) {
                return Err(invalid(
                    &format!("mappings[{i}].group"),
                    "idp:<name> or local:<name>",
                )
                .into());
            }
            if !policy.has_role(&row.role) {
                return Err(invalid(
                    &format!("mappings[{i}].role"),
                    format!("no role {:?}", row.role),
                )
                .into());
            }
            mappings.push(GroupMapping {
                group: row.group.clone(),
                role: row.role.clone(),
                scope: scope_from_wire(&format!("mappings[{i}].scope"), &row.scope)?,
            });
        }
        let (mp, stored, etag) = (mappings.clone(), mappings, input.etag);
        m.change(
            &ctx.principal().id,
            move |p| p.mappings = mp,
            move |store| match store.set_mappings(etag, &stored).map_err(|e| e.0)? {
                Some(next) => Ok(next),
                None => Err("stale".to_owned()),
            },
        )
        .await
        .map_err(|e| match e {
            ChangeError::Store(s) if s == "stale" => {
                conflict("the mappings changed since they were read; read them again")
            }
            e => change_error(e),
        })?;
        self.list(ctx, Empty {}).await
    }

    /// A local group (DOC-25 §3.3.5): adding someone to a group is how an administrator lets a
    /// person who signed up see shared profiles.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: GroupCreateInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let name = local_group_name("name", &input.name)?;
        if m.policy.current().parts().local_groups.contains_key(&name) {
            return Err(invalid("name", "a local group with this name exists").into());
        }
        let members: BTreeSet<String> = input
            .members
            .clone()
            .unwrap_or_default()
            .into_iter()
            .collect();
        self.known_users(m, &members.iter().cloned().collect::<Vec<_>>())
            .await?;
        let (n, mem, sn, smem) = (name.clone(), members.clone(), name, members);
        m.change(
            &ctx.principal().id,
            move |p| {
                p.local_groups.insert(n, mem);
            },
            move |store| store.put_group(&sn, &smem).map_err(|e| e.0),
        )
        .await
        .map_err(change_error)?;
        Ok(Empty {})
    }

    /// Deletes a local group; refused while a mapping names it. Needs the destroy confirmation:
    /// the phrase is the group's name.
    #[rpc::mutation(perm = "admin.roles.write", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: GroupNameInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        let name = local_group_name("name", &input.name)?;
        let policy = m.policy.current();
        if !policy.parts().local_groups.contains_key(&name) {
            return Err(not_found("group", format!("no local group {name:?}")).into());
        }
        let group = format!("local:{name}");
        if policy
            .parts()
            .mappings
            .iter()
            .chain(&policy.parts().pinned)
            .any(|g| g.group == group)
        {
            return Err(conflict("a mapping names this group; remove it first").into());
        }
        let (n, sn) = (name.clone(), name);
        m.change(
            &ctx.principal().id,
            move |p| {
                p.local_groups.remove(&n);
            },
            move |store| store.delete_group(&sn).map(|_| ()).map_err(|e| e.0),
        )
        .await
        .map_err(change_error)?;
        Ok(Empty {})
    }

    #[rpc::mutation(name = "addMembers", perm = "admin.roles.write", risk = Risk::Write)]
    async fn add_members(&self, ctx: Ctx, input: GroupMembersInput) -> ToolResult<Empty> {
        let m = the(&self.0)?;
        self.known_users(m, &input.members).await?;
        let add = input.members.clone();
        self.set_members(&ctx, &input.name, move |members| {
            members.extend(add);
        })
        .await
    }

    #[rpc::mutation(name = "removeMembers", perm = "admin.roles.write", risk = Risk::Write)]
    async fn remove_members(&self, ctx: Ctx, input: GroupMembersInput) -> ToolResult<Empty> {
        let gone: BTreeSet<String> = input.members.iter().cloned().collect();
        self.set_members(&ctx, &input.name, move |members| {
            members.retain(|m| !gone.contains(m));
        })
        .await
    }
}

/// `admin.sessions.*`.
pub struct AdminSessionsApi(pub Option<Arc<Management>>);

#[rpc::router(namespace = "admin.sessions")]
impl AdminSessionsApi {
    /// Every live session: user, method, when it started and was last used, client address.
    #[rpc::query(perm = "admin.users.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<SessionsOutput> {
        let m = the(&self.0)?;
        let own = login_of(&ctx);
        Ok(SessionsOutput {
            sessions: m
                .sessions
                .list()
                .iter()
                .map(|s| session_row(s, &own))
                .collect(),
        })
    }

    /// Ends a session, every session of a user, or every session but the caller's own.
    #[rpc::mutation(perm = "admin.sessions.revoke", risk = Risk::Write)]
    async fn revoke(&self, ctx: Ctx, input: AdminRevokeInput) -> ToolResult<RevokedOutput> {
        let m = the(&self.0)?;
        let by = ctx.principal().id.clone();
        let own = login_of(&ctx);
        let revoked = match (input.session_id, input.user_id, input.all.unwrap_or(false)) {
            (Some(id), None, false) => usize::from(m.sessions.end(
                &id,
                ambidex_axum::EndReason::Revoked,
                Some(&by),
            )),
            (None, Some(user), false) => m.sessions.revoke_user(&user, Some(&by)),
            (None, None, true) => m.sessions.revoke_all(Some(&own), Some(&by)),
            _ => {
                return Err(invalid("sessionId", "name one: sessionId, userId or all").into());
            }
        };
        Ok(RevokedOutput {
            revoked: revoked as u32,
        })
    }
}

#[rpc::router(namespace = "app.sessions")]
impl OwnSessionsApi {
    /// The caller's own live sessions.
    #[rpc::query(perm = "app.self", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<SessionsOutput> {
        let m = the(&self.0)?;
        let own = login_of(&ctx);
        Ok(SessionsOutput {
            sessions: m
                .sessions
                .list_user(&ctx.principal().id)
                .iter()
                .map(|s| session_row(s, &own))
                .collect(),
        })
    }

    /// Ends one of the caller's own sessions (another browser, or this one).
    #[rpc::mutation(perm = "app.self", risk = Risk::Write)]
    async fn revoke(&self, ctx: Ctx, input: SessionIdInput) -> ToolResult<RevokedOutput> {
        let m = the(&self.0)?;
        let user = ctx.principal().id.clone();
        let mine = m
            .sessions
            .list_user(&user)
            .iter()
            .any(|s| s.id == input.session_id);
        if !mine {
            return Err(not_found("session", "no such session of yours").into());
        }
        let ended = m.sessions.end(
            &input.session_id,
            ambidex_axum::EndReason::Revoked,
            Some(&user),
        );
        Ok(RevokedOutput {
            revoked: u32::from(ended),
        })
    }
}
