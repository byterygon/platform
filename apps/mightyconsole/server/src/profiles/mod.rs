//! Profiles on the server (DOC-25 §3.4.2): personal and shared profiles in `store.redb`, their
//! secrets in the secret store, who sees, uses and edits which.
//!
//! - **Personal** profiles belong to one user. Only the owner sees, uses and edits them and sets
//!   their secrets. Administrators with `profiles.manage` see their metadata (name, tool, owner,
//!   target fields) and transfer them (`admin.profiles.transfer`), never their secrets.
//!   `policy.allow_personal_profiles = false` stops new ones.
//! - **Shared** profiles belong to the tenant. `profiles.manage` edits them and sets their
//!   secrets; whoever holds `<tool>.read` on one sees and connects with it, never seeing its
//!   secrets.
//! - Names are unique per tool among the profiles a user sees. Edits name the `etag` they read.
//! - A change of a target field removes the secrets of its group unless the same call sets them
//!   (§3.4.8, [`spec::ToolSpec::secrets_to_unbind`]).
//! - Host-access fields need `profiles.hostAccess` to be saved.
//! - Deleting a profile, or giving it to another user, ends its live connections.
//! - Every change is pushed on `app.events` as `ProfileChanged { id, tool }` to the sessions that
//!   may see the profile.
//!
//! The procedures are in [`api`]; [`StoreOwners`] tells the Authorizer whose a profile is.

pub mod api;
pub mod connect;
pub mod docker;
pub mod spec;
pub mod ssh_hosts;
pub mod table;

use std::collections::BTreeMap;
use std::sync::Arc;

use security_types::{PROFILE_TARGET, Principal, TargetRef};
use serde_json::Value;

use crate::authz::{ProfileOwner, ProfileOwners, RoleAuthorizer};
use crate::core::{AppEvent, Hub};
use crate::secrets::{Owner as SecretOwner, Secret, SecretStatus, Vault, size_limit};
use crate::store::Store;
use spec::ToolSpec;
use table::{Ownership, StoredProfile, WriteError};

/// The largest `fields` and `extras` together, as JSON (§3.4.2).
pub const MAX_RECORD_BYTES: usize = 4 << 20;
/// The longest profile name, in characters.
pub const MAX_NAME_CHARS: usize = 100;
/// Personal profiles one user may keep (TSK-141; DOC-25 Open question 26). Sign-up is open by
/// default (Open question 1), so without a quota anyone who can reach the server could fill its
/// disk with records of [`MAX_RECORD_BYTES`].
pub const MAX_PERSONAL_PROFILES: usize = 200;
/// The largest total of one user's personal profiles, as stored.
pub const MAX_PERSONAL_BYTES: usize = 64 << 20;

/// What a person may do with a profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Access {
    /// Nothing: it is not shown.
    None,
    /// Its metadata only (an administrator, another user's personal profile).
    Metadata,
    /// See it and connect with it (a shared profile with `<tool>.read`).
    Use,
    /// Edit it and set its secrets (a shared profile with `profiles.manage`).
    Edit,
    /// Its owner: full rights.
    Owner,
}

impl Access {
    pub fn as_str(self) -> &'static str {
        match self {
            Access::None => "none",
            Access::Metadata => "metadata",
            Access::Use => "use",
            Access::Edit => "edit",
            Access::Owner => "owner",
        }
    }

    pub fn may_edit(self) -> bool {
        self >= Access::Edit
    }

    pub fn may_use(self) -> bool {
        self >= Access::Use
    }
}

/// The target of a stored profile.
pub fn target_of(id: &str) -> TargetRef {
    TargetRef::new(PROFILE_TARGET, id)
}

/// A profile id: 26 characters of Crockford base32 (a ULID: time, then randomness).
pub fn new_id(now_ms: u64) -> String {
    const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    let mut out = String::with_capacity(26);
    let mut t = now_ms;
    let mut time = [0u8; 10];
    for slot in time.iter_mut().rev() {
        *slot = CROCKFORD[(t % 32) as usize];
        t /= 32;
    }
    out.extend(time.iter().map(|&b| b as char));
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).expect("OS randomness");
    out.extend(random.iter().map(|b| CROCKFORD[(*b % 32) as usize] as char));
    out
}

fn now_text(now_ms: u64) -> String {
    time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
        .ok()
        .and_then(|t| {
            t.format(&time::format_description::well_known::Rfc3339)
                .ok()
        })
        .unwrap_or_default()
}

/// Why a profile operation was refused. Never holds a secret value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProfileError {
    /// The input is wrong: the field and why.
    Invalid {
        field: String,
        message: String,
    },
    /// Not visible to the caller, or gone.
    NotFound,
    /// Visible but not editable, or a permission is missing.
    Forbidden(String),
    /// A stale etag, or a name taken.
    Conflict(String),
    Store(String),
}

impl std::fmt::Display for ProfileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProfileError::Invalid { field, message } => write!(f, "{field}: {message}"),
            ProfileError::NotFound => f.write_str("no such profile"),
            ProfileError::Forbidden(m) | ProfileError::Conflict(m) | ProfileError::Store(m) => {
                f.write_str(m)
            }
        }
    }
}

fn invalid(field: &str, message: impl Into<String>) -> ProfileError {
    ProfileError::Invalid {
        field: field.to_owned(),
        message: message.into(),
    }
}

impl From<WriteError> for ProfileError {
    fn from(e: WriteError) -> ProfileError {
        match e {
            WriteError::Stale | WriteError::NameTaken => ProfileError::Conflict(e.to_string()),
            WriteError::Missing => ProfileError::NotFound,
            WriteError::Store(e) => ProfileError::Store(e),
        }
    }
}

impl From<crate::secrets::SecretError> for ProfileError {
    fn from(e: crate::secrets::SecretError) -> ProfileError {
        match &e {
            crate::secrets::SecretError::TooLarge { field, .. }
            | crate::secrets::SecretError::Empty { field } => {
                invalid(&format!("secrets.{field}"), e.to_string())
            }
            other => ProfileError::Store(other.to_string()),
        }
    }
}

/// The parts of a profile its owner or an editor gives (create, update, import).
#[derive(Debug, Clone, Default)]
pub struct Draft {
    pub name: Option<String>,
    pub color: Option<Option<String>>,
    pub fields: Option<Value>,
    pub extras: Option<Value>,
}

/// Who does what to profiles: see the [module docs](self).
pub struct ProfileService {
    pub store: Arc<Store>,
    pub vault: Arc<Vault>,
    authorizer: RoleAuthorizer,
    hub: Arc<Hub>,
    allow_personal: bool,
}

impl std::fmt::Debug for ProfileService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProfileService").finish_non_exhaustive()
    }
}

/// Checks a name: 1 to 100 characters after trimming, no control characters.
fn check_name(name: &str) -> Result<String, ProfileError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(invalid("name", "a profile needs a name"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(invalid(
            "name",
            format!("at most {MAX_NAME_CHARS} characters"),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(invalid("name", "no control characters"));
    }
    Ok(name.to_owned())
}

fn check_color(color: &Option<String>) -> Result<(), ProfileError> {
    match color {
        Some(c) if c.len() > 32 || !c.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') => {
            Err(invalid("color", "a palette name (letters, digits, -)"))
        }
        _ => Ok(()),
    }
}

/// The size of a record's `fields` and `extras`, as JSON.
fn record_bytes(fields: &Value, extras: &Value) -> usize {
    serde_json::to_vec(fields).map_or(0, |v| v.len())
        + serde_json::to_vec(extras).map_or(0, |v| v.len())
}

/// `fields` and `extras` are objects, small enough, and `fields` holds no secret.
fn check_record(spec: &ToolSpec, fields: &Value, extras: &Value) -> Result<(), ProfileError> {
    if !fields.is_object() {
        return Err(invalid("fields", "an object"));
    }
    if !extras.is_object() {
        return Err(invalid("extras", "an object"));
    }
    for secret in spec.secrets {
        if !spec::at(fields, secret).is_null() {
            return Err(invalid(
                &format!("fields.{secret}"),
                "is a secret: give it in `secrets` (it is stored encrypted, never in the record)",
            ));
        }
    }
    let size = record_bytes(fields, extras);
    if size > MAX_RECORD_BYTES {
        return Err(invalid(
            "extras",
            format!("the record is {size} bytes; at most {MAX_RECORD_BYTES}"),
        ));
    }
    Ok(())
}

/// The secrets given with a write: known fields of the tool, within their size, as [`Secret`]s.
/// An empty value is left out.
fn check_secrets(
    spec: &ToolSpec,
    secrets: BTreeMap<String, String>,
) -> Result<Vec<(String, Secret)>, ProfileError> {
    let mut out = Vec::new();
    for (field, value) in secrets {
        if !spec.is_secret(&field) {
            return Err(invalid(
                &format!("secrets.{field}"),
                format!("{} profiles have no secret {field:?}", spec.tool),
            ));
        }
        if value.is_empty() {
            continue;
        }
        if value.len() > size_limit(&field) {
            return Err(invalid(
                &format!("secrets.{field}"),
                format!("larger than {} bytes", size_limit(&field)),
            ));
        }
        out.push((field, Secret::new(value.into_bytes())));
    }
    Ok(out)
}

impl ProfileService {
    pub fn new(
        store: Arc<Store>,
        vault: Arc<Vault>,
        authorizer: RoleAuthorizer,
        hub: Arc<Hub>,
        allow_personal: bool,
    ) -> ProfileService {
        ProfileService {
            store,
            vault,
            authorizer,
            hub,
            allow_personal,
        }
    }

    /// What `p` may do with `profile`.
    pub fn access(&self, p: &Principal, profile: &StoredProfile) -> Access {
        match &profile.owner {
            Ownership::Personal { user } if *user == p.id => Access::Owner,
            Ownership::Personal { .. } => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Access::Metadata
                } else {
                    Access::None
                }
            }
            Ownership::Shared => {
                let target = target_of(&profile.id);
                if self.authorizer.permits(p, "profiles.manage", Some(&target)) {
                    Access::Edit
                } else if self.authorizer.permits(
                    p,
                    &format!("{}.read", profile.tool),
                    Some(&target),
                ) {
                    Access::Use
                } else {
                    Access::None
                }
            }
        }
    }

    fn changed(&self, profile: &StoredProfile) {
        let event = AppEvent::ProfileChanged {
            id: profile.id.clone(),
            tool: profile.tool.clone(),
        };
        self.hub
            .publish_where(&event, |p| self.access(p, profile) > Access::None);
    }

    fn spec(tool: &str) -> Result<&'static ToolSpec, ProfileError> {
        spec::spec(tool).ok_or_else(|| invalid("tool", format!("no tool {tool:?} keeps profiles")))
    }

    /// The profile `id` as `p` may see it, with that access.
    pub fn get(&self, p: &Principal, id: &str) -> Result<(StoredProfile, Access), ProfileError> {
        let profile = self.store.profile(id)?.ok_or(ProfileError::NotFound)?;
        match self.access(p, &profile) {
            Access::None => Err(ProfileError::NotFound),
            access => Ok((profile, access)),
        }
    }

    /// Every profile `p` sees, of `tool` or of every tool.
    pub fn list(
        &self,
        p: &Principal,
        tool: Option<&str>,
    ) -> Result<Vec<(StoredProfile, Access)>, ProfileError> {
        Ok(self
            .store
            .profiles()?
            .into_iter()
            .filter(|profile| tool.is_none_or(|t| t == profile.tool))
            .filter_map(|profile| match self.access(p, &profile) {
                Access::None => None,
                access => Some((profile, access)),
            })
            .collect())
    }

    /// The secrets' status of a profile `p` sees.
    pub fn secret_status(&self, id: &str) -> Result<Vec<SecretStatus>, ProfileError> {
        Ok(self.vault.status(&self.store, &SecretOwner::profile(id))?)
    }

    fn may_create(&self, p: &Principal, owner: &Ownership) -> Result<(), ProfileError> {
        match owner {
            Ownership::Personal { user } => {
                if *user != p.id {
                    return Err(ProfileError::Forbidden(
                        "a personal profile is the caller's own".into(),
                    ));
                }
                if !self.allow_personal {
                    return Err(ProfileError::Forbidden(
                        "personal profiles are turned off on this server \
                         (policy.allow_personal_profiles)"
                            .into(),
                    ));
                }
                if !self
                    .authorizer
                    .permits(p, crate::authz::catalogue::PROFILES_PERSONAL, None)
                {
                    return Err(ProfileError::Forbidden(
                        "your roles do not let you keep personal profiles (profiles.personal)"
                            .into(),
                    ));
                }
                Ok(())
            }
            Ownership::Shared => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Ok(())
                } else {
                    Err(ProfileError::Forbidden(
                        "shared profiles are made by those who hold profiles.manage".into(),
                    ))
                }
            }
        }
    }

    /// The personal quota of `user` (TSK-141): `adding` bytes more, as a new profile when
    /// `replacing` is `None`, else instead of that profile's record.
    fn within_quota(
        &self,
        user: &str,
        adding: usize,
        replacing: Option<&str>,
    ) -> Result<(), ProfileError> {
        let (count, bytes) = self.store.personal_usage(user, replacing)?;
        if replacing.is_none() && count >= MAX_PERSONAL_PROFILES {
            return Err(ProfileError::Conflict(format!(
                "you keep {count} personal profiles, the most this server allows \
                 ({MAX_PERSONAL_PROFILES}): delete one first"
            )));
        }
        if bytes.saturating_add(adding) > MAX_PERSONAL_BYTES {
            return Err(ProfileError::Conflict(format!(
                "your personal profiles would take {} bytes, more than this server keeps for one \
                 person ({MAX_PERSONAL_BYTES}): make them smaller or delete one first",
                bytes.saturating_add(adding)
            )));
        }
        Ok(())
    }

    fn may_use_host(
        &self,
        p: &Principal,
        spec: &ToolSpec,
        fields: &Value,
    ) -> Result<(), ProfileError> {
        if spec.uses_host_access(fields) && !self.authorizer.permits(p, "profiles.hostAccess", None)
        {
            return Err(ProfileError::Forbidden(
                "this profile reaches the server's own machine: saving it needs profiles.hostAccess"
                    .into(),
            ));
        }
        Ok(())
    }

    /// Writes the secrets of `owner` (a profile, an SSH host) in a write transaction.
    pub(crate) fn write_secrets(
        &self,
        write: &redb::WriteTransaction,
        owner: &SecretOwner,
        set: &[(String, Secret)],
        remove: &[&str],
        by: &str,
        at: u64,
    ) -> Result<Vec<String>, WriteError> {
        let owner = owner.clone();
        let (mut secrets, mut meta) = crate::secrets::table::open_tables(write)?;
        let mut removed = Vec::new();
        for field in remove {
            if crate::secrets::table::remove_in(&mut secrets, &owner, field)? {
                removed.push((*field).to_owned());
            }
        }
        let keyring = self.vault.keyring();
        for (field, value) in set {
            crate::secrets::table::put_in(
                &mut secrets,
                &mut meta,
                &owner,
                field,
                keyring.active().id(),
                crate::secrets::MAX_WRAPS_PER_KEK,
                |version| {
                    self.vault
                        .seal_entry(&keyring, &owner, field, version, value, by, at)
                },
            )?;
        }
        Ok(removed)
    }

    /// `profiles.create` and the body of `profiles.import`.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn create(
        &self,
        p: &Principal,
        tool: &str,
        version: Option<u32>,
        owner: Ownership,
        draft: Draft,
        secrets: BTreeMap<String, String>,
        import: Option<&str>,
        host: Option<ssh_hosts::PendingHost>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let spec = Self::spec(tool)?;
        self.may_create(p, &owner)?;
        let name = check_name(draft.name.as_deref().unwrap_or_default())?;
        let color = draft.color.flatten();
        check_color(&color)?;
        let mut fields = draft
            .fields
            .unwrap_or_else(|| Value::Object(Default::default()));
        let extras = draft
            .extras
            .unwrap_or_else(|| Value::Object(Default::default()));
        check_record(spec, &fields, &extras)?;
        if tool == "docker" {
            docker::check_fields(
                &p.id,
                None,
                &mut fields,
                import.is_some(),
                &now_text(now_ms),
            )?;
        }
        self.may_use_host(p, spec, &fields)?;
        if let Ownership::Personal { user } = &owner {
            self.within_quota(user, record_bytes(&fields, &extras), None)?;
        }
        let version = version.unwrap_or(spec.version);
        if version == 0 || version > spec.version {
            return Err(invalid(
                "version",
                format!(
                    "{tool} profiles are at version {} on this server",
                    spec.version
                ),
            ));
        }
        let secrets = check_secrets(spec, secrets)?;
        let now = now_text(now_ms);
        let profile = StoredProfile {
            id: new_id(now_ms),
            tool: tool.to_owned(),
            version,
            name,
            color,
            fields,
            extras,
            owner,
            etag: 0,
            created_at: now.clone(),
            updated_at: now,
            created_by: p.id.clone(),
            updated_by: p.id.clone(),
        };
        if let Some(host) = &host {
            self.check_link(&profile.owner, &profile.fields, Some(&host.row))?;
        } else {
            self.check_link(&profile.owner, &profile.fields, None)?;
        }
        let stored = self.store.put_profile(profile, None, |write, stored| {
            if let Some(host) = host {
                self.put_pending_host(write, host, &p.id, now_ms)?;
            }
            self.write_secrets(
                write,
                &SecretOwner::profile(&stored.id),
                &secrets,
                &[],
                &p.id,
                now_ms,
            )?;
            if let Some(source) = import {
                table::record_import(write, &p.id, source, &stored.id)?;
            }
            Ok(())
        })?;
        self.changed(&stored);
        Ok(stored)
    }

    /// `profiles.update`: the parts given, at `etag`. Returns the profile and the secrets that
    /// were removed because their target changed (§3.4.8).
    pub fn update(
        &self,
        p: &Principal,
        id: &str,
        etag: u64,
        draft: Draft,
        secrets: BTreeMap<String, String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, Vec<String>), ProfileError> {
        let (current, access) = self.get(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not edit this profile".into(),
            ));
        }
        let spec = Self::spec(&current.tool)?;
        let mut next = current.clone();
        if let Some(name) = &draft.name {
            next.name = check_name(name)?;
        }
        if let Some(color) = draft.color {
            check_color(&color)?;
            next.color = color;
        }
        if let Some(fields) = draft.fields {
            next.fields = fields;
        }
        if let Some(extras) = draft.extras {
            next.extras = extras;
        }
        check_record(spec, &next.fields, &next.extras)?;
        if next.tool == "docker" {
            docker::check_fields(
                &p.id,
                Some(&current.fields),
                &mut next.fields,
                false,
                &now_text(now_ms),
            )?;
        }
        self.may_use_host(p, spec, &next.fields)?;
        if let Ownership::Personal { user } = &next.owner {
            self.within_quota(
                user,
                record_bytes(&next.fields, &next.extras),
                Some(&current.id),
            )?;
        }
        self.check_link(&next.owner, &next.fields, None)?;
        let secrets = check_secrets(spec, secrets)?;
        let unbind: Vec<&str> = spec
            .secrets_to_unbind(&current.fields, &next.fields)
            .into_iter()
            .filter(|f| !secrets.iter().any(|(set, _)| set == f))
            .collect();
        next.updated_at = now_text(now_ms);
        next.updated_by = p.id.clone();
        let mut removed = Vec::new();
        let stored = self.store.put_profile(next, Some(etag), |write, stored| {
            removed = self.write_secrets(
                write,
                &SecretOwner::profile(&stored.id),
                &secrets,
                &unbind,
                &p.id,
                now_ms,
            )?;
            Ok(())
        })?;
        self.changed(&stored);
        Ok((stored, removed))
    }

    /// `profiles.duplicate`: a copy named `name`, owned by the caller (personal) or shared like
    /// the source; its secrets are copied only when the caller may edit the source and the copy
    /// has the same owner (DOC-21 Open question 22).
    pub fn duplicate(
        &self,
        p: &Principal,
        id: &str,
        name: &str,
        now_ms: u64,
    ) -> Result<(StoredProfile, bool), ProfileError> {
        let (source, access) = self.get(p, id)?;
        if !access.may_use() {
            return Err(ProfileError::Forbidden(
                "you may not copy this profile".into(),
            ));
        }
        let owner = match (&source.owner, access) {
            (Ownership::Shared, Access::Edit) => Ownership::Shared,
            _ => Ownership::Personal { user: p.id.clone() },
        };
        let copy_secrets = access.may_edit() && owner == source.owner;
        let secrets = if copy_secrets {
            let owner = SecretOwner::profile(&source.id);
            self.vault
                .status(&self.store, &owner)?
                .into_iter()
                .map(|s| {
                    let value = self
                        .vault
                        .get(&self.store, &owner, &s.field)?
                        .and_then(|v| v.as_str().map(str::to_owned))
                        .unwrap_or_default();
                    Ok((s.field, value))
                })
                .collect::<Result<BTreeMap<_, _>, crate::secrets::SecretError>>()?
        } else {
            BTreeMap::new()
        };
        let draft = Draft {
            name: Some(name.to_owned()),
            color: Some(source.color.clone()),
            fields: Some(source.fields.clone()),
            extras: Some(source.extras.clone()),
        };
        let copy = self.create(
            p,
            &source.tool,
            Some(source.version),
            owner,
            draft,
            secrets,
            None,
            None,
            now_ms,
        )?;
        Ok((copy, copy_secrets))
    }

    /// `profiles.delete`: the profile, its secrets and its import rows. `name` must be the
    /// profile's (the confirmation phrase).
    pub fn delete(&self, p: &Principal, id: &str, name: &str) -> Result<(), ProfileError> {
        let (current, access) = self.get(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not delete this profile".into(),
            ));
        }
        if current.name != name {
            return Err(invalid("name", "is not the profile's name"));
        }
        self.store.delete_profile(id)?;
        self.hub.release_profile(id, "the profile was deleted");
        self.changed(&current);
        Ok(())
    }

    /// `secrets.set` on a profile the caller may edit.
    pub fn set_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
        value: String,
        now_ms: u64,
    ) -> Result<SecretStatus, ProfileError> {
        let (profile, access) = self.get(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not set this profile's secrets".into(),
            ));
        }
        let spec = Self::spec(&profile.tool)?;
        let mut checked = check_secrets(spec, BTreeMap::from([(field.to_owned(), value)]))?;
        let Some((field, value)) = checked.pop() else {
            return Err(invalid("value", "empty: remove the secret instead"));
        };
        let status = self.vault.set(
            &self.store,
            &SecretOwner::profile(id),
            &field,
            &value,
            &p.id,
            now_ms,
        )?;
        self.changed(&profile);
        Ok(status)
    }

    /// `secrets.remove` on a profile the caller may edit; whether it was set.
    pub fn remove_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
    ) -> Result<bool, ProfileError> {
        let (profile, access) = self.get(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not remove this profile's secrets".into(),
            ));
        }
        let spec = Self::spec(&profile.tool)?;
        if !spec.is_secret(field) {
            return Err(invalid(
                "field",
                format!("{} profiles have no secret {field:?}", spec.tool),
            ));
        }
        let removed = self
            .vault
            .remove(&self.store, &SecretOwner::profile(id), field)?;
        self.changed(&profile);
        Ok(removed)
    }

    /// `profiles.import` (§3.4.9): a browser record as a profile, once per `(user, sourceId)`.
    /// Returns the profile and whether this call made it.
    #[allow(clippy::too_many_arguments, reason = "the import's parts")]
    pub fn import(
        &self,
        p: &Principal,
        source_id: &str,
        tool: &str,
        version: u32,
        owner: Ownership,
        draft: Draft,
        secrets: BTreeMap<String, String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, bool), ProfileError> {
        if source_id.is_empty() || source_id.len() > 128 {
            return Err(invalid("sourceId", "1 to 128 characters"));
        }
        if let Some(id) = self.store.imported(&p.id, source_id)?
            && let Ok((profile, _)) = self.get(p, &id)
        {
            return Ok((profile, false));
        }
        // A Docker profile of version 1 holds its SSH login: it becomes an SSH host (or names an
        // identical one the owner has) and a profile of version 2 (DOC-23 (z)).
        let (version, draft, secrets, host) = if tool == "docker" && version < 2 {
            self.may_create(p, &owner)?;
            self.docker_v1_to_v2(p, &owner, draft, secrets, now_ms)?
        } else {
            (version, draft, secrets, None)
        };
        let profile = self.create(
            p,
            tool,
            Some(version),
            owner,
            draft,
            secrets,
            Some(source_id),
            host,
            now_ms,
        )?;
        Ok((profile, true))
    }

    /// `admin.profiles.transfer`: personal profiles change owner; their secrets stay with them.
    pub fn transfer(
        &self,
        ids: &[String],
        to_user: &str,
        by: &str,
        now_ms: u64,
    ) -> Result<u32, ProfileError> {
        let mut done = 0;
        for id in ids {
            let current = self.store.profile(id)?.ok_or(ProfileError::NotFound)?;
            if current.owner == Ownership::Shared {
                return Err(invalid(
                    "profileIds",
                    format!("{id} is shared, not personal"),
                ));
            }
            let mut next = current.clone();
            next.owner = Ownership::Personal {
                user: to_user.to_owned(),
            };
            next.updated_at = now_text(now_ms);
            next.updated_by = by.to_owned();
            let stored = self
                .store
                .put_profile(next, Some(current.etag), |_, _| Ok(()))?;
            // The previous owner's connections end with their right to use it.
            self.hub
                .release_profile(id, "the profile was given to another user");
            self.changed(&current);
            self.changed(&stored);
            done += 1;
        }
        Ok(done)
    }
}

/// [`ProfileOwners`] from the store, for the Authorizer.
pub struct StoreOwners(pub Arc<Store>);

impl ProfileOwners for StoreOwners {
    fn owner(&self, profile: &str) -> Option<ProfileOwner> {
        let stored = self.0.profile(profile).ok()??;
        Some(match stored.owner {
            Ownership::Personal { user } => ProfileOwner::Personal {
                user,
                tool: stored.tool,
            },
            Ownership::Shared => ProfileOwner::Shared,
        })
    }
}
