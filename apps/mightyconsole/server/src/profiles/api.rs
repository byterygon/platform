//! `profiles.*`, `secrets.*` and `admin.profiles.transfer` (DOC-25 §3.4.7, §3.3.7). Secrets are
//! write-only: values arrive in `secrets` (create, update, import) and `value` (`secrets.set`),
//! redacted from the audit digest, and no procedure answers one; a record lists its secrets'
//! status only. Every procedure carries `profiles.personal` for the router (each built-in role
//! holds it) and the target of the profile it names; who may see, use and edit which profile is
//! decided per profile ([`super::ProfileService::access`]).

use std::collections::BTreeMap;
use std::sync::Arc;

use ambidex::{Ctx, rpc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::table::{Ownership, StoredProfile};
use super::{Access, Draft, ProfileError, ProfileService};
use crate::core::{Empty, ToolError, ToolErrorKind, ToolResult};
use crate::secrets::SecretStatus;

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
    fn ownership(&self, caller: &str) -> Ownership {
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
    /// `profile` (routes come with DOC-23).
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

fn profile_of(owner: &SecretOwnerWire) -> Result<String, ToolError> {
    if owner.kind != "profile" {
        return Err(ToolError::invalid(
            SYSTEM,
            "owner.kind",
            "profile (route secrets come with connection routes)",
        ));
    }
    Ok(owner.id.clone())
}

fn now() -> u64 {
    security_types::unix_now_ms()
}

// ---- procedures ------------------------------------------------------------------------------

/// `profiles.*`. `None` only in the codegen router.
pub struct ProfilesApi(pub Option<Arc<ProfileService>>);

#[rpc::router(namespace = "profiles")]
impl ProfilesApi {
    /// The profiles the caller sees: their own personal ones, the shared ones their roles let
    /// them use, and (with `profiles.manage`) other users' personal ones as metadata.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: ProfilesListInput) -> ToolResult<ProfilesOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let profiles = s
                .list(&p, input.tool.as_deref())?
                .into_iter()
                .map(|(profile, access)| view(&s, profile, access))
                .collect::<Result<_, _>>()?;
            Ok(ProfilesOutput { profiles })
        })
        .await?)
    }

    /// One profile, as the caller may see it.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: ProfileIdInput) -> ToolResult<ProfileView> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        Ok(blocking(move || {
            let (profile, access) = s.get(&p, &input.id)?;
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
        let id = profile_of(&input.owner)?;
        Ok(blocking(move || {
            s.set_secret(&p, &id, &input.field, input.value, now())
                .map(SecretRow::from)
        })
        .await?)
    }

    /// Removes a secret of a profile the caller may edit.
    #[rpc::mutation(perm = "profiles.personal", risk = Risk::Write)]
    async fn remove(&self, ctx: Ctx, input: SecretFieldInput) -> ToolResult<SecretRemoveOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let id = profile_of(&input.owner)?;
        Ok(blocking(move || {
            s.remove_secret(&p, &id, &input.field)
                .map(|removed| SecretRemoveOutput { removed })
        })
        .await?)
    }

    /// Which secrets a profile the caller sees has set, by whom and when; never a value.
    #[rpc::query(perm = "profiles.personal", risk = Risk::Read)]
    async fn status(&self, ctx: Ctx, input: SecretOwnerInput) -> ToolResult<SecretsOutput> {
        let s = service(&self.0)?;
        let p = ctx.principal().clone();
        let id = profile_of(&input.owner)?;
        Ok(blocking(move || {
            let (_, access) = s.get(&p, &id)?;
            if access == Access::Metadata {
                return Err(ProfileError::NotFound);
            }
            Ok(SecretsOutput {
                secrets: s
                    .secret_status(&id)?
                    .into_iter()
                    .map(SecretRow::from)
                    .collect(),
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
