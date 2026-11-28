//! `profiles.*`, `secrets.*` and `admin.profiles.transfer` (DOC-25 §3.4.7, §3.3.7). Secrets are
//! write-only: values arrive in `secrets` (create, update, import) and `value` (`secrets.set`),
//! redacted from the audit digest, and no procedure answers one; a record lists its secrets'
//! status only. Every procedure carries `profiles.personal` for the router (each built-in role
//! holds it) and the target of the profile it names; who may see, use and edit which profile is
//! decided per profile ([`super::ProfileService::access`]). The reads of
//! [`crate::authz::catalogue::PROFILE_READS`] (`profiles.list` / `get`, `sshHosts.list` / `get`)
//! also let in a person holding some `<tool>.read` without `profiles.personal` (DOC-25 §3.4.7),
//! who is answered the shared rows their roles cover and none of their own (`shown`).

use std::collections::BTreeMap;
use std::sync::Arc;

use ambidex::{Ctx, rpc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::table::{Ownership, StoredProfile};
use super::{Access, Draft, ProfileError, ProfileService};
use crate::core::{Empty, HostKeyFingerprint, ToolError, ToolErrorKind, ToolResult};
use crate::secrets::SecretStatus;
use crate::tools::docker::DockerAuth;

const SYSTEM: &str = "profiles";

fn tool_error(e: ProfileError) -> ToolError {
    match e {
        ProfileError::Invalid { field, message } => ToolError::invalid(SYSTEM, &field, message),
        ProfileError::NotFound => ToolError::not_found(SYSTEM, "profile", "no such profile"),
        ProfileError::Forbidden(m) => ToolError::new(ToolErrorKind::Forbidden, SYSTEM, m),
        ProfileError::Conflict(m) => ToolError::new(ToolErrorKind::Conflict, SYSTEM, m),
        ProfileError::Store(m) => ToolError::new(ToolErrorKind::Remote, SYSTEM, m),
    }
}

fn service(s: &Option<Arc<ProfileService>>) -> Result<Arc<ProfileService>, ToolError> {
    s.clone()
        .ok_or_else(|| ToolError::new(ToolErrorKind::Remote, SYSTEM, "no profile store"))
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ProfileError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ToolError::new(ToolErrorKind::Remote, SYSTEM, e.to_string()))?
        .map_err(tool_error)
}

fn etag_of(text: &str) -> Result<u64, ToolError> {
    text.parse()
        .map_err(|_| ToolError::invalid(SYSTEM, "etag", "the etag a read answered"))
}

// ---- wire types ------------------------------------------------------------------------------

/// Who a profile belongs to, on the wire.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OwnerWire {
    /// A user's: their principal id. In an input, the caller's own (any `user` given is ignored).
    Personal {
        #[serde(default)]
        #[ts(optional = nullable)]
        user: Option<String>,
    },
    Shared,
}

impl OwnerWire {
    pub(crate) fn ownership(&self, caller: &str) -> Ownership {
        match self {
            OwnerWire::Personal { .. } => Ownership::Personal {
                user: caller.to_owned(),
            },
            OwnerWire::Shared => Ownership::Shared,
        }
    }
}

/// A secret's status in a profile: never its value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRow {
    pub field: String,
    pub set: bool,
    pub version: u64,
    pub set_by: String,
    /// Unix ms.
    pub set_at: u64,
}

impl From<SecretStatus> for SecretRow {
    fn from(s: SecretStatus) -> SecretRow {
        SecretRow {
            field: s.field,
            set: true,
            version: s.version,
            set_by: s.set_by,
            set_at: s.set_at,
        }
    }
}

/// A stored profile as the caller may see it (DOC-21 §4.2 without `secrets`).
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub tool: String,
    pub version: u32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub color: Option<String>,
    /// All fields; only the target fields when `access` is `metadata`.
    #[ts(type = "unknown")]
    pub fields: Value,
    /// Empty when `access` is `metadata`.
    #[ts(type = "unknown")]
    pub extras: Value,
    pub owner: OwnerWire,
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
    /// `owner`, `edit`, `use` or `metadata`.
    pub access: String,
    /// The secrets set (none listed for `metadata`).
    pub secrets: Vec<SecretRow>,
}

fn view(
    service: &ProfileService,
    profile: StoredProfile,
    access: Access,
) -> Result<ProfileView, ProfileError> {
    let metadata = access == Access::Metadata;
    let secrets = if metadata {
        Vec::new()
    } else {
        service
            .secret_status(&profile.id)?
            .into_iter()
            .map(SecretRow::from)
            .collect()
    };
    let fields = if metadata {
        super::spec::spec(&profile.tool)
            .map(|s| s.target_view(&profile.fields))
            .unwrap_or_else(|| Value::Object(Default::default()))
    } else {
        profile.fields
    };
    Ok(ProfileView {
        id: profile.id,
        tool: profile.tool,
        version: profile.version,
        name: profile.name,
        color: profile.color,
        fields,
        extras: if metadata {
            Value::Object(Default::default())
        } else {
            profile.extras
        },
        owner: match profile.owner {
            Ownership::Personal { user } => OwnerWire::Personal { user: Some(user) },
            Ownership::Shared => OwnerWire::Shared,
        },
        etag: profile.etag.to_string(),
        created_at: profile.created_at,
        updated_at: profile.updated_at,
        created_by: profile.created_by,
        updated_by: profile.updated_by,
        access: access.as_str().to_owned(),
        secrets,
    })
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfilesListInput {
    /// One tool's profiles; all when left out.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tool: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesOutput {
    pub profiles: Vec<ProfileView>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileIdInput {
    pub id: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileCreateInput {
    pub tool: String,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color: Option<String>,
    pub owner: OwnerWire,
    #[ts(type = "unknown")]
    pub fields: Value,
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown")]
    pub extras: Option<Value>,
    /// Secret values by field (redacted). An empty value is left out.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
}

// Debug by hand: secret values never reach a log line, an error or a panic message (TSK-141).
impl std::fmt::Debug for ProfileCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileCreateInput")
            .field("tool", &self.tool)
            .field("name", &self.name)
            .field("owner", &self.owner)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileUpdateInput {
    pub id: String,
    /// The etag of the record this edit starts from.
    pub etag: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// A palette name; `""` clears it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown")]
    pub fields: Option<Value>,
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown")]
    pub extras: Option<Value>,
    /// Secrets set in the same change (redacted), which keeps them when a target field changes.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
}

impl std::fmt::Debug for ProfileUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileUpdateInput")
            .field("id", &self.id)
            .field("etag", &self.etag)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUpdateOutput {
    pub profile: ProfileView,
    /// Secrets removed because a target field changed and they were not set again (DOC-25
    /// §3.4.8).
    pub removed_secrets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDuplicateInput {
    pub id: String,
    /// The copy's name.
    pub name: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDuplicateOutput {
    pub profile: ProfileView,
    /// Whether the secrets came along (the caller may edit the source and the copy has its owner).
    pub secrets_copied: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileDeleteInput {
    pub id: String,
    /// The profile's name: what the person types to confirm.
    pub name: String,
}

/// A browser record to import (DOC-21 §4.2, migrated to its tool's newest version).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImportRecord {
    pub tool: String,
    pub version: u32,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color: Option<String>,
    #[ts(type = "unknown")]
    pub fields: Value,
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown")]
    pub extras: Option<Value>,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileImportInput {
    /// The record's id in the browser.
    pub source_id: String,
    pub record: ImportRecord,
    /// Its secrets by server field path (redacted).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
    pub owner: OwnerWire,
}

impl std::fmt::Debug for ProfileImportInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileImportInput")
            .field("source_id", &self.source_id)
            .field("owner", &self.owner)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ProfileImportOutput {
    pub profile: ProfileView,
    /// `false` when an earlier import of the same record made it.
    pub created: bool,
}

/// What a secret belongs to on the wire.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretOwnerWire {
    /// `profile`, `sshHost` or `proxy` (a command hop's secret variables are set through
    /// `routes.create` and `routes.update`).
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretSetInput {
    pub owner: SecretOwnerWire,
    pub field: String,
    /// The value (redacted; never answered).
    pub value: String,
}

impl std::fmt::Debug for SecretSetInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretSetInput")
            .field("owner", &self.owner)
            .field("field", &self.field)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretFieldInput {
    pub owner: SecretOwnerWire,
    pub field: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretOwnerInput {
    pub owner: SecretOwnerWire,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretRemoveOutput {
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsOutput {
    pub secrets: Vec<SecretRow>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransferInput {
    pub profile_ids: Vec<String>,
    /// The new owner's principal id.
    pub to_user_id: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TransferOutput {
    pub transferred: u32,
}

/// What a `secrets.*` call names: a profile, an SSH host or a proxy.
enum SecretOwnerRef {
    Profile(String),
    SshHost(String),
    Proxy(String),
}

fn owner_of(owner: &SecretOwnerWire) -> Result<SecretOwnerRef, ToolError> {
    match owner.kind.as_str() {
        "profile" => Ok(SecretOwnerRef::Profile(owner.id.clone())),
        "sshHost" => Ok(SecretOwnerRef::SshHost(owner.id.clone())),
        "proxy" => Ok(SecretOwnerRef::Proxy(owner.id.clone())),
        _ => Err(ToolError::invalid(
            SYSTEM,
            "owner.kind",
            "profile, sshHost or proxy (a command hop's variables are set with its route)",
        )),
    }
}

fn now() -> u64 {
    security_types::unix_now_ms()
}

/// Whether a read of [`crate::authz::catalogue::PROFILE_READS`] answers a row of `access`: the
/// caller's own personal rows only when `own` ([`ProfileService::reads_own`]).
pub(crate) fn shown(own: bool, access: Access) -> bool {
    own || access != Access::Owner
}

// ---- procedures ------------------------------------------------------------------------------

/// `profiles.*`. `None` only in the codegen router.
pub struct ProfilesApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "profiles")]
impl ProfilesApi {
    /// The profiles the caller sees: their own personal ones (with `profiles.personal`), the
    /// shared ones their roles let them use (`<tool>.read` on each, which also lets a person
    /// without `profiles.personal` call this, DOC-25 §3.4.7), and (with `profiles.manage`) other
    /// users' personal ones as metadata.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: ProfilesListInput) -> ToolResult<ProfilesOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let own = s.reads_own(&p);
            let profiles = s
                .list(&p, input.tool.as_deref())?
                .into_iter()
                .filter(|(_, access)| shown(own, *access))
                .map(|(profile, access)| view(&s, profile, access))
                .collect::<Result<_, _>>()?;
            Ok(ProfilesOutput { profiles })
        })
        .await?)
    }

    /// One profile, as the caller may see it (as `list` shows it).
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: ProfileIdInput) -> ToolResult<ProfileView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (profile, access) = s.get(&p, &input.id)?;
            if !shown(s.reads_own(&p), access) {
                return Err(ProfileError::NotFound);
            }
            view(&s, profile, access)
        })
        .await?)
    }

    /// A new personal (the caller's) or shared (`profiles.manage`) profile.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn create(&self, ctx: Ctx, input: ProfileCreateInput) -> ToolResult<ProfileView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let owner = input.owner.ownership(&p.id);
            let draft = Draft {
                name: Some(input.name),
                color: Some(input.color),
                fields: Some(input.fields),
                extras: input.extras,
            };
            let profile = s.create(
                &p,
                &input.tool,
                None,
                owner,
                draft,
                input.secrets.unwrap_or_default(),
                None,
                None,
                now(),
            )?;
            let access = s.access(&p, &profile);
            view(&s, profile, access)
        })
        .await?)
    }

    /// Changes the parts given, at `etag`. A changed target field removes the secrets of its
    /// target unless they are set in the same call (DOC-25 §3.4.8); the answer names them.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn update(&self, ctx: Ctx, input: ProfileUpdateInput) -> ToolResult<ProfileUpdateOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let etag = etag_of(&input.etag)?;
        Ok(blocking(move || {
            let draft = Draft {
                name: input.name,
                color: input.color.map(|c| (!c.is_empty()).then_some(c)),
                fields: input.fields,
                extras: input.extras,
            };
            let (profile, removed) = s.update(
                &p,
                &input.id,
                etag,
                draft,
                input.secrets.unwrap_or_default(),
                now(),
            )?;
            let access = s.access(&p, &profile);
            Ok(ProfileUpdateOutput {
                profile: view(&s, profile, access)?,
                removed_secrets: removed,
            })
        })
        .await?)
    }

    /// A copy named `name`: the caller's personal one, or shared when they edit the shared source.
    /// Secrets come along only when the caller may edit the source and the copy has its owner.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn duplicate(
        &self,
        ctx: Ctx,
        input: ProfileDuplicateInput,
    ) -> ToolResult<ProfileDuplicateOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (profile, copied) = s.duplicate(&p, &input.id, &input.name, now())?;
            let access = s.access(&p, &profile);
            Ok(ProfileDuplicateOutput {
                profile: view(&s, profile, access)?,
                secrets_copied: copied,
            })
        })
        .await?)
    }

    /// Deletes the profile and its secrets (confirmed by typing its name).
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: ProfileDeleteInput) -> ToolResult<Empty> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        blocking(move || s.delete(&p, &input.id, &input.name)).await?;
        Ok(Empty {})
    }

    /// Imports a browser record once (DOC-25 §3.4.9): a repeated call with the same `sourceId`
    /// answers the profile the first one made.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn import(&self, ctx: Ctx, input: ProfileImportInput) -> ToolResult<ProfileImportOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let owner = input.owner.ownership(&p.id);
            let record = input.record;
            let draft = Draft {
                name: Some(record.name),
                color: Some(record.color),
                fields: Some(record.fields),
                extras: record.extras,
            };
            let (profile, created) = s.import(
                &p,
                &input.source_id,
                &record.tool,
                record.version,
                owner,
                draft,
                input.secrets.unwrap_or_default(),
                now(),
            )?;
            let access = s.access(&p, &profile);
            Ok(ProfileImportOutput {
                profile: view(&s, profile, access)?,
                created,
            })
        })
        .await?)
    }
}

/// `secrets.*`: write-only secrets of profiles.
pub struct SecretsApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "secrets")]
impl SecretsApi {
    /// Sets (or replaces) a secret of a profile the caller may edit. Answers its status.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["value"])]
    async fn set(&self, ctx: Ctx, input: SecretSetInput) -> ToolResult<SecretRow> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let owner = owner_of(&input.owner)?;
        Ok(blocking(move || {
            match owner {
                SecretOwnerRef::Profile(id) => {
                    s.set_secret(&p, &id, &input.field, input.value, now())
                }
                SecretOwnerRef::SshHost(id) => {
                    s.set_host_secret(&p, &id, &input.field, input.value, now())
                }
                SecretOwnerRef::Proxy(id) => {
                    s.set_proxy_secret(&p, &id, &input.field, input.value, now())
                }
            }
            .map(SecretRow::from)
        })
        .await?)
    }

    /// Removes a secret of a profile the caller may edit.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn remove(&self, ctx: Ctx, input: SecretFieldInput) -> ToolResult<SecretRemoveOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let owner = owner_of(&input.owner)?;
        Ok(blocking(move || {
            match owner {
                SecretOwnerRef::Profile(id) => s.remove_secret(&p, &id, &input.field),
                SecretOwnerRef::SshHost(id) => s.remove_host_secret(&p, &id, &input.field),
                SecretOwnerRef::Proxy(id) => s.remove_proxy_secret(&p, &id, &input.field),
            }
            .map(|removed| SecretRemoveOutput { removed })
        })
        .await?)
    }

    /// Which secrets a profile the caller sees has set, by whom and when; never a value.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn status(&self, ctx: Ctx, input: SecretOwnerInput) -> ToolResult<SecretsOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let owner = owner_of(&input.owner)?;
        Ok(blocking(move || {
            let status = match owner {
                SecretOwnerRef::Profile(id) => {
                    let (_, access) = s.get(&p, &id)?;
                    if access == Access::Metadata {
                        return Err(ProfileError::NotFound);
                    }
                    s.secret_status(&id)?
                }
                SecretOwnerRef::SshHost(id) => {
                    let (_, access) = s.get_host(&p, &id)?;
                    if !access.may_edit() {
                        return Err(ProfileError::NotFound);
                    }
                    s.host_secret_status(&id)?
                }
                SecretOwnerRef::Proxy(id) => {
                    let (_, access, _) = s.get_proxy(&p, &id)?;
                    if !access.may_edit() {
                        return Err(ProfileError::NotFound);
                    }
                    s.proxy_secret_status(&id)?
                }
            };
            Ok(SecretsOutput {
                secrets: status.into_iter().map(SecretRow::from).collect(),
            })
        })
        .await?)
    }
}

/// `admin.profiles.*`.
pub struct AdminProfilesApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "admin.profiles")]
impl AdminProfilesApi {
    /// Gives personal profiles to another user; their secrets stay with them, so the new owner
    /// connects with them.
    #[rpc::mutation(perm = "admin.users.write", risk = Risk::Write)]
    async fn transfer(&self, ctx: Ctx, input: TransferInput) -> ToolResult<TransferOutput> {
        let s = service(&self.0)?;
        let by = ctx.principal().id.clone();
        if !crate::authz::PRINCIPAL_PREFIXES
            .iter()
            .any(|prefix| input.to_user_id.starts_with(prefix))
        {
            return Err(ToolError::invalid(SYSTEM, "toUserId", "a user's principal id").into());
        }
        Ok(blocking(move || {
            s.transfer(&input.profile_ids, &input.to_user_id, &by, now())
                .map(|transferred| TransferOutput { transferred })
        })
        .await?)
    }
}

// ---- SSH hosts (DOC-23 §4.3, §8.1) ------------------------------------------------------------

/// An SSH host's settings: never a secret (DOC-23 §4.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostFields {
    /// Host name or IP address of the SSH server.
    pub host: String,
    /// 22 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub port: Option<u16>,
    pub username: String,
    /// `privateKey` when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<DockerAuth>,
    /// SSH keepalive interval, 30 s when absent; 0 turns it off.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub keepalive_sec: Option<u32>,
    /// The trusted host key; `null` until the person trusts it on first use.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub host_key: Option<HostKeyFingerprint>,
}

impl SshHostFields {
    fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// The stored fields as the wire's (a row a migration kept as it was reads as far as it can).
    fn of(fields: &Value) -> SshHostFields {
        serde_json::from_value(fields.clone()).unwrap_or_else(|_| SshHostFields {
            host: fields["host"].as_str().unwrap_or_default().to_owned(),
            port: fields["port"].as_u64().and_then(|p| u16::try_from(p).ok()),
            username: fields["username"].as_str().unwrap_or_default().to_owned(),
            auth: serde_json::from_value(fields["auth"].clone()).ok(),
            keepalive_sec: fields["keepaliveSec"]
                .as_u64()
                .and_then(|k| u32::try_from(k).ok()),
            host_key: serde_json::from_value(fields["hostKey"].clone()).ok(),
        })
    }
}

/// A profile that names an SSH host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostUser {
    pub id: String,
    pub tool: String,
    pub name: String,
}

/// A saved SSH host as the caller may see it: never a secret value.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostView {
    pub id: String,
    pub name: String,
    pub fields: SshHostFields,
    pub owner: OwnerWire,
    pub etag: String,
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
    /// `owner`, `edit`, `use` or `metadata`.
    pub access: String,
    /// The secrets set (none listed for `metadata` and `use`).
    pub secrets: Vec<SecretRow>,
    /// The profiles that name it and the caller sees.
    pub used_by: Vec<SshHostUser>,
    /// How many more name it that the caller does not see.
    pub used_by_hidden: u32,
}

fn host_view(
    service: &ProfileService,
    host: StoredProfile,
    access: Access,
    users: Vec<super::ssh_hosts::User>,
) -> Result<SshHostView, ProfileError> {
    let secrets = if access.may_edit() {
        service
            .host_secret_status(&host.id)?
            .into_iter()
            .map(SecretRow::from)
            .collect()
    } else {
        Vec::new()
    };
    let hidden = users.iter().filter(|u| !u.visible).count();
    Ok(SshHostView {
        fields: SshHostFields::of(&host.fields),
        owner: match &host.owner {
            Ownership::Personal { user } => OwnerWire::Personal {
                user: Some(user.clone()),
            },
            Ownership::Shared => OwnerWire::Shared,
        },
        etag: host.etag.to_string(),
        access: access.as_str().to_owned(),
        secrets,
        used_by: users
            .into_iter()
            .filter(|u| u.visible)
            .map(|u| SshHostUser {
                id: u.id,
                tool: u.tool,
                name: u.name,
            })
            .collect(),
        used_by_hidden: u32::try_from(hidden).unwrap_or(u32::MAX),
        id: host.id,
        name: host.name,
        created_at: host.created_at,
        updated_at: host.updated_at,
        created_by: host.created_by,
        updated_by: host.updated_by,
    })
}

fn host_view_of(
    service: &ProfileService,
    p: &security_types::Principal,
    host: StoredProfile,
) -> Result<SshHostView, ProfileError> {
    let profiles = service.store.profiles()?;
    let access = service.host_access(p, &host, &profiles);
    let users = service.host_users(p, &host.id, &profiles);
    host_view(service, host, access, users)
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostsOutput {
    pub hosts: Vec<SshHostView>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostIdInput {
    pub id: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostCreateInput {
    pub name: String,
    pub owner: OwnerWire,
    pub fields: SshHostFields,
    /// `privateKey`, `passphrase`, `password` (redacted; never answered).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
}

// Debug by hand: secret values never reach a log line, an error or a panic message (TSK-141).
impl std::fmt::Debug for SshHostCreateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHostCreateInput")
            .field("name", &self.name)
            .field("owner", &self.owner)
            .field("fields", &self.fields)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostUpdateInput {
    pub id: String,
    pub etag: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub fields: Option<SshHostFields>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
}

// Debug by hand: secret values never reach a log line, an error or a panic message (TSK-141).
impl std::fmt::Debug for SshHostUpdateInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHostUpdateInput")
            .field("id", &self.id)
            .field("etag", &self.etag)
            .field("name", &self.name)
            .field("fields", &self.fields)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostUpdateOutput {
    pub host: SshHostView,
    /// Secrets removed because the address, port, user or trusted key changed (DOC-25 §3.4.8).
    pub removed_secrets: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostDeleteInput {
    pub id: String,
    /// The host's name: the confirmation phrase.
    pub name: String,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostImportInput {
    /// The host's id in the file it comes from: a repeated import answers the same host.
    pub source_id: String,
    pub name: String,
    pub owner: OwnerWire,
    pub fields: SshHostFields,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secrets: Option<BTreeMap<String, String>>,
}

// Debug by hand: secret values never reach a log line, an error or a panic message (TSK-141).
impl std::fmt::Debug for SshHostImportInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHostImportInput")
            .field("source_id", &self.source_id)
            .field("name", &self.name)
            .field("owner", &self.owner)
            .field("fields", &self.fields)
            .field(
                "secrets",
                &self.secrets.as_ref().map(|s| s.keys().collect::<Vec<_>>()),
            )
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostImportOutput {
    pub host: SshHostView,
    pub created: bool,
}

#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SshHostTestInput {
    pub fields: SshHostFields,
    /// The secrets typed in the form: used for this call only, never stored, logged or audited.
    pub secrets: BTreeMap<String, String>,
    /// The stored host the form edits, whose secrets fill those left empty while the form keeps
    /// its address, port, user and trusted key.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub host_id: Option<String>,
}

impl std::fmt::Debug for SshHostTestInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshHostTestInput")
            .field("fields", &self.fields)
            .field("secrets", &self.secrets.keys().collect::<Vec<_>>())
            .field("host_id", &self.host_id)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshHostTestOutput {
    /// The key the host presented (the trusted one).
    pub host_key: HostKeyFingerprint,
    /// The login's time, handshake included.
    pub ms: u32,
}

/// `sshHosts.*`: saved SSH logins that Docker profiles (and routes) choose. `None` only in the
/// codegen router.
pub struct SshHostsApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "sshHosts")]
impl SshHostsApi {
    /// The hosts the caller sees, with who uses each: their own personal ones (with
    /// `profiles.personal`), and the shared ones a profile or route they may use names (DOC-23
    /// (ae)), which also lets a person with `<tool>.read` and no `profiles.personal` call this.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, _input: Empty) -> ToolResult<SshHostsOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let own = s.reads_own(&p);
            let hosts = s
                .list_hosts(&p)?
                .into_iter()
                .filter(|(_, access, _)| shown(own, *access))
                .map(|(host, access, users)| host_view(&s, host, access, users))
                .collect::<Result<_, _>>()?;
            Ok(SshHostsOutput { hosts })
        })
        .await?)
    }

    /// One host, as the caller may see it (as `list` shows it).
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: SshHostIdInput) -> ToolResult<SshHostView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (host, access) = s.get_host(&p, &input.id)?;
            if !shown(s.reads_own(&p), access) {
                return Err(ProfileError::NotFound);
            }
            host_view_of(&s, &p, host)
        })
        .await?)
    }

    /// A new personal (the caller's) or shared (`profiles.manage`) host.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn create(&self, ctx: Ctx, input: SshHostCreateInput) -> ToolResult<SshHostView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let host = s.create_host(
                &p,
                input.owner.ownership(&p.id),
                &input.name,
                &input.fields.to_value(),
                input.secrets.unwrap_or_default(),
                None,
                now(),
            )?;
            host_view_of(&s, &p, host)
        })
        .await?)
    }

    /// Changes the parts given, at `etag`. A changed address, port or user, or a replaced trusted
    /// key, removes the login's secrets unless they are set in the same call; the answer names
    /// them.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn update(&self, ctx: Ctx, input: SshHostUpdateInput) -> ToolResult<SshHostUpdateOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let etag = etag_of(&input.etag)?;
        Ok(blocking(move || {
            let fields = input.fields.as_ref().map(SshHostFields::to_value);
            let (host, removed) = s.update_host(
                &p,
                &input.id,
                etag,
                input.name.as_deref(),
                fields.as_ref(),
                input.secrets.unwrap_or_default(),
                now(),
            )?;
            Ok(SshHostUpdateOutput {
                host: host_view_of(&s, &p, host)?,
                removed_secrets: removed,
            })
        })
        .await?)
    }

    /// Deletes the host and its secrets (confirmed by typing its name); refused while a profile
    /// names it.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: SshHostDeleteInput) -> ToolResult<Empty> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        blocking(move || s.delete_host(&p, &input.id, &input.name)).await?;
        Ok(Empty {})
    }

    /// Imports a host from an export file once: a repeated call with the same `sourceId` answers
    /// the host the first one made. A name taken gets `-2`.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write, redact = ["secrets"])]
    async fn import(&self, ctx: Ctx, input: SshHostImportInput) -> ToolResult<SshHostImportOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (host, created) = s.import_host(
                &p,
                &input.source_id,
                input.owner.ownership(&p.id),
                &input.name,
                &input.fields.to_value(),
                input.secrets.unwrap_or_default(),
                now(),
            )?;
            Ok(SshHostImportOutput {
                host: host_view_of(&s, &p, host)?,
                created,
            })
        })
        .await?)
    }

    /// Test of the host form: logs in over SSH with the draft and closes. The host key is checked
    /// as at connect: unknown or changed fails as `HostKey` with the key to trust.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Read, redact = ["secrets"], audit = "always")]
    async fn test(&self, ctx: Ctx, input: SshHostTestInput) -> ToolResult<SshHostTestOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let profile = blocking(move || {
            s.resolve_host_test(
                &p,
                &input.fields.to_value(),
                input.secrets,
                input.host_id.as_deref(),
            )
        })
        .await?;
        // serde's message can quote a secret: none is kept.
        let profile: crate::tools::docker::ConnectDockerProfile =
            serde_json::from_value(profile)
                .map_err(|_| ToolError::invalid(SYSTEM, "fields", "the host does not read"))?;
        let target = crate::tools::docker::target(&profile)?;
        let started = std::time::Instant::now();
        let ssh = crate::tools::docker::ssh::SshSession::connect(target).await?;
        let ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        let host_key = ssh.host_key.clone();
        ssh.close().await;
        Ok(SshHostTestOutput { host_key, ms })
    }
}
