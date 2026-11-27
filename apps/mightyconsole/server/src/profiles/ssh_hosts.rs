//! SSH hosts (DOC-23 §4.3, §6.4, §8.1, (x), (z)): a login to one machine, saved once and chosen
//! by Docker's SSH profiles (and, with TSK-117, by the SSH hops of routes), so the address, the
//! user, the key and the trusted host key live in one place.
//!
//! - A host is a row of the profile shape in its own table (`ssh_hosts`, `tool` = `sshHost`),
//!   with the same owners (DOC-25 §3.4.2): **personal** (one user's, full rights) or **shared**
//!   (the tenant's, edited with `profiles.manage`). Its secrets (private key, passphrase,
//!   password) are write-only entries of the secret store under the owner kind `sshHost`, bound
//!   to the address, port and user, and to the trusted host key once there is one
//!   ([`spec::ssh_host_secrets_to_unbind`]).
//! - **Who may name which host.** A personal profile names its owner's own hosts; a shared
//!   profile names shared hosts. A personal profile has every right of its tool (§3.3.4), so a
//!   person who could point one at a shared host would get a shell-equivalent on that machine
//!   with a login they were never given. Checked when a profile is saved and again at connect.
//! - **Who sees which host.** Its owner; for a shared host, those with `profiles.manage` (who
//!   edit it) and those who may use a profile that names it (who see where it connects, never
//!   its secrets); administrators with `profiles.manage` see other users' personal hosts as
//!   metadata.
//! - **In use.** A host that a profile names cannot be deleted; the refusal lists them.
//! - **Migration** (DOC-23 (z)). A Docker profile of version 1 held its SSH login. At start, and
//!   when a browser record is imported, each becomes an SSH host of the same owner (identical
//!   logins merge into one; a name taken gets `-2`, `-3`, …) and a profile of version 2 that
//!   names it and keeps its socket path. The record as it was is kept in `profiles_backup`; its
//!   secrets move to the host (decrypted and sealed again under the host, in the same
//!   transaction), so nothing is lost.

use std::collections::BTreeMap;

use security_types::Principal;
use serde_json::{Map, Value, json};

use super::routes::Node;
use super::spec::{self, SSH_HOST, SSH_HOST_KEY};
use super::table::{self, Ownership, PROFILES, SSH_HOSTS, StoredProfile, WriteError};
use super::{
    Access, Draft, MAX_NAME_CHARS, ProfileError, ProfileService, check_name, invalid, new_id,
    now_text,
};
use crate::core::AppEvent;
use crate::secrets::{Owner as SecretOwner, Secret, SecretStatus, size_limit};

/// The `tool` of a host row.
pub const HOST_TOOL: &str = "sshHost";
/// The profile field that names a host.
pub const HOST_FIELD: &str = "sshHostId";
/// The SSH port when a host names none.
pub const DEFAULT_PORT: u64 = 22;
/// The Docker profile version that names a host (DOC-23 §6.4).
pub const DOCKER_HOST_VERSION: u32 = 2;
/// An import's source id for a host, so it never meets a profile's.
const IMPORT_PREFIX: &str = "sshHost/";

/// A host the same transaction as a profile writes (an import of a Docker profile of version 1).
pub struct PendingHost {
    pub row: StoredProfile,
    pub secrets: Vec<(String, Secret)>,
}

/// Who names a host: a profile (or a route, with TSK-117).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub tool: String,
    pub name: String,
    /// Whether the caller sees it.
    pub visible: bool,
}

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or_default()
}

/// The host a profile's fields name, if any.
pub fn host_id_of(fields: &Value) -> Option<&str> {
    fields
        .get(HOST_FIELD)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Checks and normalizes a host's fields: `host`, `port` (22), `username`, `auth`
/// (`privateKey`), `keepaliveSec` and `hostKey`, nothing else.
pub fn check_host_fields(fields: &Value) -> Result<Value, ProfileError> {
    let Some(object) = fields.as_object() else {
        return Err(invalid("fields", "an object"));
    };
    for key in object.keys() {
        if ![
            "host",
            "port",
            "username",
            "auth",
            "keepaliveSec",
            "hostKey",
        ]
        .contains(&key.as_str())
        {
            if SSH_HOST.is_secret(key) {
                return Err(invalid(
                    &format!("fields.{key}"),
                    "is a secret: give it in `secrets` (it is stored encrypted, never in the record)",
                ));
            }
            return Err(invalid(
                &format!("fields.{key}"),
                "not a field of an SSH host",
            ));
        }
    }
    let host = text(&fields["host"]).trim();
    if host.is_empty() {
        return Err(invalid(
            "fields.host",
            "the host name or address is required",
        ));
    }
    if host.len() > 253
        || host
            .chars()
            .any(|c| c.is_whitespace() || c == '@' || c.is_control())
    {
        return Err(invalid(
            "fields.host",
            "only the host name or address: the user goes in username and the port in port",
        ));
    }
    let port = match &fields["port"] {
        Value::Null => DEFAULT_PORT,
        v => match v.as_u64() {
            Some(p @ 1..=65535) => p,
            _ => return Err(invalid("fields.port", "a port from 1 to 65535")),
        },
    };
    let username = text(&fields["username"]).trim();
    if username.is_empty() {
        return Err(invalid(
            "fields.username",
            "the user to log in as is required",
        ));
    }
    if username.len() > 256
        || username
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(invalid("fields.username", "a user name without spaces"));
    }
    let auth = match &fields["auth"] {
        Value::Null => "privateKey",
        Value::String(a) if ["privateKey", "password", "agent"].contains(&a.as_str()) => a,
        _ => return Err(invalid("fields.auth", "privateKey, password or agent")),
    };
    let keepalive = match &fields["keepaliveSec"] {
        Value::Null => Value::Null,
        v => match v.as_u64() {
            Some(k @ 0..=3600) => json!(k),
            _ => {
                return Err(invalid(
                    "fields.keepaliveSec",
                    "seconds from 0 (off) to 3600",
                ));
            }
        },
    };
    let host_key = match &fields[SSH_HOST_KEY] {
        Value::Null => Value::Null,
        key => match (&key["algorithm"], &key["fingerprintSha256"]) {
            (Value::String(a), Value::String(f))
                if !a.is_empty() && a.len() <= 64 && !f.is_empty() && f.len() <= 128 =>
            {
                json!({ "algorithm": a, "fingerprintSha256": f })
            }
            _ => {
                return Err(invalid(
                    "fields.hostKey",
                    "{ algorithm, fingerprintSha256 } as the server presented it, or null",
                ));
            }
        },
    };
    Ok(json!({
        "host": host,
        "port": port,
        "username": username,
        "auth": auth,
        "keepaliveSec": keepalive,
        "hostKey": host_key,
    }))
}

/// The secrets an SSH host's write gives: known fields, within their size, as [`Secret`]s.
fn check_host_secrets(
    secrets: BTreeMap<String, String>,
) -> Result<Vec<(String, Secret)>, ProfileError> {
    let mut out = Vec::new();
    for (field, value) in secrets {
        if !SSH_HOST.is_secret(&field) {
            return Err(invalid(
                &format!("secrets.{field}"),
                format!("SSH hosts have no secret {field:?}"),
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

/// Whether two hosts' fields are the same login: address (case aside), port, user and
/// authentication, and host keys that do not disagree.
fn same_login(a: &Value, b: &Value) -> bool {
    let key_a = &a[SSH_HOST_KEY];
    let key_b = &b[SSH_HOST_KEY];
    text(&a["host"]).eq_ignore_ascii_case(text(&b["host"]))
        && a["port"] == b["port"]
        && a["username"] == b["username"]
        && a["auth"] == b["auth"]
        && (key_a.is_null() || key_b.is_null() || key_a == key_b)
}

/// Whether two sets of secrets hold the same values.
fn same_secrets(a: &BTreeMap<String, Secret>, b: &BTreeMap<String, Secret>) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(k, v)| b.get(k).is_some_and(|w| w.expose() == v.expose()))
}

/// `base`, or `base-2`, `base-3`, … whichever no host `owner` sees has.
fn free_host_name(hosts: &[StoredProfile], owner: &Ownership, base: &str) -> String {
    let base: String = base.chars().take(MAX_NAME_CHARS - 4).collect();
    let probe = |name: &str| StoredProfile {
        id: String::new(),
        tool: HOST_TOOL.to_owned(),
        version: SSH_HOST.version,
        name: name.to_owned(),
        color: None,
        fields: Value::Null,
        extras: Value::Null,
        owner: owner.clone(),
        etag: 0,
        created_at: String::new(),
        updated_at: String::new(),
        created_by: String::new(),
        updated_by: String::new(),
    };
    let taken = |name: &str| hosts.iter().any(|h| table::clash(h, &probe(name)));
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|name| !taken(name))
        .unwrap_or(base)
}

/// A Docker profile's fields of version 1, split into the SSH host's and the profile's own
/// (version 2: everything but the login, plus the host's id).
fn split_docker_v1(fields: &Value) -> (Value, Map<String, Value>) {
    let mut rest = fields.as_object().cloned().unwrap_or_default();
    let mut host = Map::new();
    for key in [
        "host",
        "port",
        "username",
        "auth",
        "keepaliveSec",
        "hostKey",
    ] {
        if let Some(v) = rest.remove(key) {
            host.insert(key.to_owned(), v);
        }
    }
    (Value::Object(host), rest)
}

/// The login's secrets of a Docker profile of version 1, for the auth it uses.
fn login_secrets(
    host_fields: &Value,
    mut secrets: BTreeMap<String, Secret>,
) -> BTreeMap<String, Secret> {
    let keep: &[&str] = match text(&host_fields["auth"]) {
        "password" => &["password"],
        "agent" => &[],
        _ => &["privateKey", "passphrase"],
    };
    secrets.retain(|k, v| keep.contains(&k.as_str()) && !v.is_empty());
    secrets
}

impl ProfileService {
    /// What `p` may do with a host; `profiles` are the stored profiles (who uses it).
    pub fn host_access(
        &self,
        p: &Principal,
        host: &StoredProfile,
        profiles: &[StoredProfile],
    ) -> Access {
        match &host.owner {
            Ownership::Personal { user } if *user == p.id => Access::Owner,
            Ownership::Personal { .. } => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Access::Metadata
                } else {
                    Access::None
                }
            }
            Ownership::Shared => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Access::Edit
                } else if profiles
                    .iter()
                    .filter(|profile| host_id_of(&profile.fields) == Some(&host.id))
                    .any(|profile| self.access(p, profile).may_use())
                    || self.graph().is_ok_and(|graph| {
                        graph
                            .routes_through(&Node::SshHost {
                                id: host.id.clone(),
                            })
                            .iter()
                            .any(|route| self.route_access(p, route, &graph).may_use())
                    })
                {
                    Access::Use
                } else {
                    Access::None
                }
            }
        }
    }

    fn host_changed(&self, host: &StoredProfile) {
        let event = AppEvent::SshHostChanged {
            id: host.id.clone(),
        };
        let profiles = self.store.profiles().unwrap_or_default();
        self.hub.publish_where(&event, |p| {
            self.host_access(p, host, &profiles) > Access::None
        });
    }

    /// The profiles that name `host_id` and the routes that pass it (`tool` = `route`), and
    /// whether `p` sees each.
    pub fn host_users(
        &self,
        p: &Principal,
        host_id: &str,
        profiles: &[StoredProfile],
    ) -> Vec<User> {
        let mut users: Vec<User> = profiles
            .iter()
            .filter(|profile| host_id_of(&profile.fields) == Some(host_id))
            .map(|profile| User {
                id: profile.id.clone(),
                tool: profile.tool.clone(),
                name: profile.name.clone(),
                visible: self.access(p, profile) > Access::None,
            })
            .collect();
        if let Ok(graph) = self.graph() {
            let node = Node::SshHost {
                id: host_id.to_owned(),
            };
            users.extend(self.node_users(p, &node, &graph));
        }
        users
    }

    /// The host `id` as `p` may see it, with that access.
    pub fn get_host(
        &self,
        p: &Principal,
        id: &str,
    ) -> Result<(StoredProfile, Access), ProfileError> {
        let host = self.store.ssh_host(id)?.ok_or(ProfileError::NotFound)?;
        let profiles = self.store.profiles()?;
        match self.host_access(p, &host, &profiles) {
            Access::None => Err(ProfileError::NotFound),
            access => Ok((host, access)),
        }
    }

    /// Every host `p` sees, with that access and who uses it.
    pub fn list_hosts(
        &self,
        p: &Principal,
    ) -> Result<Vec<(StoredProfile, Access, Vec<User>)>, ProfileError> {
        let profiles = self.store.profiles()?;
        Ok(self
            .store
            .ssh_hosts()?
            .into_iter()
            .filter_map(|host| match self.host_access(p, &host, &profiles) {
                Access::None => None,
                access => {
                    let users = self.host_users(p, &host.id, &profiles);
                    Some((host, access, users))
                }
            })
            .collect())
    }

    /// The secrets' status of a host.
    pub fn host_secret_status(&self, id: &str) -> Result<Vec<SecretStatus>, ProfileError> {
        Ok(self.vault.status(&self.store, &SecretOwner::ssh_host(id))?)
    }

    /// Every stored secret of a host, opened.
    pub(crate) fn open_host_secrets(
        &self,
        id: &str,
    ) -> Result<BTreeMap<String, Secret>, ProfileError> {
        let owner = SecretOwner::ssh_host(id);
        let mut out = BTreeMap::new();
        for entry in self.store.secret_entries(Some(&owner))? {
            let value = self.vault.open(&entry)?;
            out.insert(entry.field.clone(), value);
        }
        Ok(out)
    }

    /// A new host row (not stored yet).
    fn host_row(
        &self,
        p_id: &str,
        owner: Ownership,
        name: String,
        fields: Value,
        now_ms: u64,
    ) -> StoredProfile {
        let now = now_text(now_ms);
        StoredProfile {
            id: new_id(now_ms),
            tool: HOST_TOOL.to_owned(),
            version: SSH_HOST.version,
            name,
            color: None,
            fields,
            extras: json!({}),
            owner,
            etag: 0,
            created_at: now.clone(),
            updated_at: now,
            created_by: p_id.to_owned(),
            updated_by: p_id.to_owned(),
        }
    }

    /// Writes a pending host and its secrets in a profile's write transaction.
    pub(crate) fn put_pending_host(
        &self,
        write: &redb::WriteTransaction,
        host: PendingHost,
        by: &str,
        now_ms: u64,
    ) -> Result<(), WriteError> {
        let row = table::put_in(write, SSH_HOSTS, host.row, None)?;
        self.write_secrets(
            write,
            &SecretOwner::ssh_host(&row.id),
            &host.secrets,
            &[],
            by,
            now_ms,
        )?;
        Ok(())
    }

    /// `sshHosts.create` and the body of `sshHosts.import`.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn create_host(
        &self,
        p: &Principal,
        owner: Ownership,
        name: &str,
        fields: &Value,
        secrets: BTreeMap<String, String>,
        import: Option<&str>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        self.may_create(p, &owner)?;
        let name = check_name(name)?;
        let fields = check_host_fields(fields)?;
        let secrets = check_host_secrets(secrets)?;
        let row = self.host_row(&p.id, owner, name, fields, now_ms);
        let stored = self.store.put_ssh_host(row, None, |write, stored| {
            self.write_secrets(
                write,
                &SecretOwner::ssh_host(&stored.id),
                &secrets,
                &[],
                &p.id,
                now_ms,
            )?;
            if let Some(source) = import {
                table::record_import(
                    write,
                    &p.id,
                    &format!("{IMPORT_PREFIX}{source}"),
                    &stored.id,
                )?;
            }
            Ok(())
        })?;
        self.host_changed(&stored);
        Ok(stored)
    }

    /// `sshHosts.update`: the parts given, at `etag`. A changed address, port or user, or a
    /// replaced trusted key, removes the login's secrets unless the call sets them (DOC-25
    /// §3.4.8). Returns the host and the secrets removed.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn update_host(
        &self,
        p: &Principal,
        id: &str,
        etag: u64,
        name: Option<&str>,
        fields: Option<&Value>,
        secrets: BTreeMap<String, String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, Vec<String>), ProfileError> {
        let (current, access) = self.get_host(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not edit this SSH host".into(),
            ));
        }
        let mut next = current.clone();
        if let Some(name) = name {
            next.name = check_name(name)?;
        }
        if let Some(fields) = fields {
            next.fields = check_host_fields(fields)?;
        }
        let secrets = check_host_secrets(secrets)?;
        let unbind: Vec<&str> = spec::ssh_host_secrets_to_unbind(&current.fields, &next.fields)
            .into_iter()
            .filter(|f| !secrets.iter().any(|(set, _)| set == f))
            .collect();
        next.updated_at = now_text(now_ms);
        next.updated_by = p.id.clone();
        let mut removed = Vec::new();
        let stored = self.store.put_ssh_host(next, Some(etag), |write, stored| {
            removed = self.write_secrets(
                write,
                &SecretOwner::ssh_host(&stored.id),
                &secrets,
                &unbind,
                &p.id,
                now_ms,
            )?;
            Ok(())
        })?;
        self.host_changed(&stored);
        Ok((stored, removed))
    }

    /// `sshHosts.delete`: refused while a profile names the host (the message lists them, and
    /// says how many the caller does not see). `name` must be the host's (the confirmation).
    pub fn delete_host(&self, p: &Principal, id: &str, name: &str) -> Result<(), ProfileError> {
        let (current, access) = self.get_host(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not delete this SSH host".into(),
            ));
        }
        if current.name != name {
            return Err(invalid("name", "is not the SSH host's name"));
        }
        let mut in_use = None;
        self.store
            .delete_ssh_host(id, |write| {
                // Read in the write, so a route saved meanwhile is counted.
                let graph = super::routes::Graph::in_write(write)?;
                let node = Node::SshHost { id: id.to_owned() };
                let mut users: Vec<User> = graph
                    .profiles
                    .iter()
                    .filter(|profile| host_id_of(&profile.fields) == Some(id))
                    .map(|profile| User {
                        id: profile.id.clone(),
                        tool: profile.tool.clone(),
                        name: profile.name.clone(),
                        visible: self.access(p, profile) > Access::None,
                    })
                    .collect();
                users.extend(self.node_users(p, &node, &graph));
                if !users.is_empty() {
                    in_use = Some(users);
                    return Err(WriteError::Stale);
                }
                // No route passes it: the links drawn to and from it go with it.
                graph.delete_links_at(write, &node)?;
                Ok(())
            })
            .map_err(|e| match in_use.take() {
                Some(users) => in_use_error(&current.name, &users),
                None => e.into(),
            })?;
        self.host_changed(&current);
        Ok(())
    }

    /// `secrets.set` on a host the caller may edit.
    pub fn set_host_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
        value: String,
        now_ms: u64,
    ) -> Result<SecretStatus, ProfileError> {
        let (host, access) = self.get_host(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not set this SSH host's secrets".into(),
            ));
        }
        let mut checked = check_host_secrets(BTreeMap::from([(field.to_owned(), value)]))?;
        let Some((field, value)) = checked.pop() else {
            return Err(invalid("value", "empty: remove the secret instead"));
        };
        let status = self.vault.set(
            &self.store,
            &SecretOwner::ssh_host(id),
            &field,
            &value,
            &p.id,
            now_ms,
        )?;
        self.host_changed(&host);
        Ok(status)
    }

    /// `secrets.remove` on a host the caller may edit; whether it was set.
    pub fn remove_host_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
    ) -> Result<bool, ProfileError> {
        let (host, access) = self.get_host(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not remove this SSH host's secrets".into(),
            ));
        }
        if !SSH_HOST.is_secret(field) {
            return Err(invalid(
                "field",
                format!("SSH hosts have no secret {field:?}"),
            ));
        }
        let removed = self
            .vault
            .remove(&self.store, &SecretOwner::ssh_host(id), field)?;
        self.host_changed(&host);
        Ok(removed)
    }

    /// `sshHosts.import`: a host from an export file, once per `(user, sourceId)`. Returns the
    /// host and whether this call made it.
    #[allow(clippy::too_many_arguments, reason = "the import's parts")]
    pub fn import_host(
        &self,
        p: &Principal,
        source_id: &str,
        owner: Ownership,
        name: &str,
        fields: &Value,
        secrets: BTreeMap<String, String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, bool), ProfileError> {
        if source_id.is_empty() || source_id.len() > 128 {
            return Err(invalid("sourceId", "1 to 128 characters"));
        }
        if let Some(id) = self
            .store
            .imported(&p.id, &format!("{IMPORT_PREFIX}{source_id}"))?
            && let Ok((host, _)) = self.get_host(p, &id)
        {
            return Ok((host, false));
        }
        let hosts = self.store.ssh_hosts()?;
        let name = free_host_name(&hosts, &owner, &check_name(name)?);
        let host = self.create_host(p, owner, &name, fields, secrets, Some(source_id), now_ms)?;
        Ok((host, true))
    }

    /// Checks that a profile of `owner` may name the host its `fields` name (see the module
    /// docs); `pending` is a host the same write makes.
    pub(crate) fn check_link(
        &self,
        owner: &Ownership,
        fields: &Value,
        pending: Option<&StoredProfile>,
    ) -> Result<Option<StoredProfile>, ProfileError> {
        let Some(id) = host_id_of(fields) else {
            if fields
                .get(HOST_FIELD)
                .is_some_and(|v| !v.is_null() && v != "")
            {
                return Err(invalid(&format!("fields.{HOST_FIELD}"), "an SSH host's id"));
            }
            return Ok(None);
        };
        let host = match pending {
            Some(host) if host.id == id => host.clone(),
            _ => self
                .store
                .ssh_host(id)?
                .ok_or_else(|| invalid(&format!("fields.{HOST_FIELD}"), "no such SSH host"))?,
        };
        match (owner, &host.owner) {
            (Ownership::Personal { user }, Ownership::Personal { user: host_user })
                if user == host_user => {}
            (Ownership::Shared, Ownership::Shared) => {}
            (Ownership::Personal { .. }, _) => {
                return Err(invalid(
                    &format!("fields.{HOST_FIELD}"),
                    "a personal profile uses one of its owner's own SSH hosts",
                ));
            }
            (Ownership::Shared, _) => {
                return Err(invalid(
                    &format!("fields.{HOST_FIELD}"),
                    "a shared profile uses a shared SSH host",
                ));
            }
        }
        Ok(Some(host))
    }

    /// The host a draft (`<tool>.test` with no stored profile) may name: the caller's own, or a
    /// shared one when they edit shared profiles.
    pub(crate) fn check_draft_link(
        &self,
        p: &Principal,
        fields: &Value,
    ) -> Result<Option<StoredProfile>, ProfileError> {
        let owner = match host_id_of(fields).and_then(|id| self.store.ssh_host(id).ok().flatten()) {
            Some(host)
                if host.owner == Ownership::Shared
                    && self.authorizer.permits(p, "profiles.manage", None) =>
            {
                Ownership::Shared
            }
            _ => Ownership::Personal { user: p.id.clone() },
        };
        self.check_link(&owner, fields, None)
    }

    /// The fields and secrets a tool connects with when its profile names a host: the host's
    /// login over the profile's own fields, the host's secrets beside the profile's.
    pub(crate) fn with_host(
        &self,
        host: Option<StoredProfile>,
        fields: &Value,
        secrets: BTreeMap<String, Secret>,
    ) -> Result<(Value, BTreeMap<String, Secret>), ProfileError> {
        let Some(host) = host else {
            return Ok((fields.clone(), secrets));
        };
        let mut merged = fields.as_object().cloned().unwrap_or_default();
        if let Some(login) = host.fields.as_object() {
            for (k, v) in login {
                merged.insert(k.clone(), v.clone());
            }
        }
        let mut secrets = secrets;
        secrets.extend(self.open_host_secrets(&host.id)?);
        Ok((Value::Object(merged), secrets))
    }

    /// A Docker profile of version 1 as a profile of version 2 and the host it names: an
    /// identical login `owner` already has, or a new host (returned as pending).
    #[allow(clippy::type_complexity, reason = "the parts of an import")]
    pub(crate) fn docker_v1_to_v2(
        &self,
        p: &Principal,
        owner: &Ownership,
        draft: Draft,
        secrets: BTreeMap<String, String>,
        now_ms: u64,
    ) -> Result<(u32, Draft, BTreeMap<String, String>, Option<PendingHost>), ProfileError> {
        let fields = draft.fields.clone().unwrap_or_else(|| json!({}));
        let (host_fields, mut rest) = split_docker_v1(&fields);
        let mut profile_secrets = BTreeMap::new();
        let mut login = BTreeMap::new();
        for (field, value) in secrets {
            if SSH_HOST.is_secret(&field) {
                login.insert(field, Secret::new(value.into_bytes()));
            } else {
                profile_secrets.insert(field, value);
            }
        }
        let mut pending = None;
        // A record without a host yet keeps no login: the person chooses a host later.
        if !text(&host_fields["host"]).trim().is_empty() {
            let host_fields = check_host_fields(&host_fields)?;
            let login = login_secrets(&host_fields, login);
            for (field, value) in &login {
                if value.len() > size_limit(field) {
                    return Err(invalid(&format!("secrets.{field}"), "too large"));
                }
            }
            let hosts = self.store.ssh_hosts()?;
            let (id, made) = self.find_or_make_host(
                &p.id,
                owner,
                &hosts,
                host_fields,
                login,
                draft.name.as_deref().unwrap_or_default(),
                now_ms,
            )?;
            rest.insert(HOST_FIELD.to_owned(), json!(id));
            pending = made;
        }
        let draft = Draft {
            fields: Some(Value::Object(rest)),
            ..draft
        };
        Ok((DOCKER_HOST_VERSION, draft, profile_secrets, pending))
    }

    /// An identical login among `hosts` of `owner` (its id), or a new one (pending).
    #[allow(clippy::too_many_arguments, reason = "the login's parts")]
    fn find_or_make_host(
        &self,
        by: &str,
        owner: &Ownership,
        hosts: &[StoredProfile],
        fields: Value,
        login: BTreeMap<String, Secret>,
        fallback_name: &str,
        now_ms: u64,
    ) -> Result<(String, Option<PendingHost>), ProfileError> {
        for host in hosts {
            if host.owner == *owner
                && same_login(&host.fields, &fields)
                && same_secrets(&self.open_host_secrets(&host.id)?, &login)
            {
                return Ok((host.id.clone(), None));
            }
        }
        let base = match text(&fields["host"]) {
            "" => fallback_name,
            h => h,
        };
        let base = check_name(base).unwrap_or_else(|_| "SSH host".to_owned());
        let name = free_host_name(hosts, owner, &base);
        let row = self.host_row(by, owner.clone(), name, fields, now_ms);
        let id = row.id.clone();
        Ok((
            id,
            Some(PendingHost {
                row,
                secrets: login.into_iter().collect(),
            }),
        ))
    }

    /// At start: every stored Docker profile of version 1 becomes a profile of version 2 that
    /// names an SSH host (DOC-23 (z)), one transaction per profile. Returns how many moved and
    /// how many hosts were made.
    pub fn migrate_docker_profiles(&self, now_ms: u64) -> Result<(usize, usize), ProfileError> {
        let mut moved = 0;
        let mut made = 0;
        for profile in self.store.profiles()? {
            if profile.tool != "docker" || profile.version >= DOCKER_HOST_VERSION {
                continue;
            }
            let owner = SecretOwner::profile(&profile.id);
            let mut secrets = BTreeMap::new();
            for entry in self.store.secret_entries(Some(&owner))? {
                secrets.insert(entry.field.clone(), self.vault.open(&entry)?);
            }
            let (host_fields, mut rest) = split_docker_v1(&profile.fields);
            let by = "system:migration";
            let mut pending = None;
            // The login's secrets leave the profile only for a host that holds them; a record
            // with no host yet keeps them where they are.
            let mut gone: Vec<&str> = Vec::new();
            if !text(&host_fields["host"]).trim().is_empty() {
                gone = SSH_HOST
                    .secrets
                    .iter()
                    .copied()
                    .filter(|f| secrets.contains_key(*f))
                    .collect();
                // A stored v1 profile was checked by the browser only: a login this server would
                // refuse keeps its fields under the host as they were, for the person to fix.
                let host_fields = check_host_fields(&host_fields).unwrap_or(host_fields);
                let login = login_secrets(&host_fields, secrets);
                let hosts = self.store.ssh_hosts()?;
                let (id, host) = self.find_or_make_host(
                    by,
                    &profile.owner,
                    &hosts,
                    host_fields,
                    login,
                    &profile.name,
                    now_ms,
                )?;
                rest.insert(HOST_FIELD.to_owned(), json!(id));
                pending = host;
            }
            let mut next = profile.clone();
            next.version = DOCKER_HOST_VERSION;
            next.fields = Value::Object(rest);
            next.updated_at = now_text(now_ms);
            next.updated_by = by.to_owned();
            let made_host = pending.is_some();
            self.store.write(|write| {
                table::backup_in(write, &profile)?;
                if let Some(host) = pending {
                    self.put_pending_host(write, host, by, now_ms)?;
                }
                table::put_in(write, PROFILES, next, Some(profile.etag))?;
                self.write_secrets(write, &owner, &[], &gone, by, now_ms)?;
                Ok(())
            })?;
            moved += 1;
            made += usize::from(made_host);
        }
        Ok((moved, made))
    }
}

impl ProfileService {
    /// The Docker connect profile (its SSH part) of a host form's draft, for `sshHosts.test`:
    /// the secrets typed, and those of the stored host `host_id` that the draft leaves empty when
    /// the caller may edit it and the draft keeps its address, port, user and trusted key.
    pub fn resolve_host_test(
        &self,
        p: &Principal,
        fields: &Value,
        secrets: BTreeMap<String, String>,
        host_id: Option<&str>,
    ) -> Result<Value, ProfileError> {
        let may_keep = self
            .authorizer
            .permits(p, crate::authz::catalogue::PROFILES_PERSONAL, None)
            || self.authorizer.permits(p, "profiles.manage", None);
        if !may_keep {
            return Err(ProfileError::Forbidden(
                "testing an SSH host needs profiles.personal or profiles.manage".into(),
            ));
        }
        let fields = check_host_fields(fields)?;
        let mut secrets: BTreeMap<String, Secret> =
            check_host_secrets(secrets)?.into_iter().collect();
        let mut name = "draft".to_owned();
        if let Some(id) = host_id {
            let (stored, access) = self.get_host(p, id)?;
            name = stored.name.clone();
            if access.may_edit()
                && spec::ssh_host_secrets_to_unbind(&stored.fields, &fields).is_empty()
            {
                for (field, value) in self.open_host_secrets(id)? {
                    secrets.entry(field).or_insert(value);
                }
            }
        }
        let view = super::connect::View {
            id: host_id,
            name: &name,
            fields: &fields,
            extras: &json!({}),
            secrets: &secrets,
        };
        Ok(super::connect::docker(&view))
    }
}

fn in_use_error(name: &str, users: &[User]) -> ProfileError {
    let seen: Vec<String> = users
        .iter()
        .filter(|u| u.visible)
        .map(|u| format!("{} ({})", u.name, u.tool))
        .collect();
    let hidden = users.len() - seen.len();
    let mut message = format!("{name} is in use: ");
    if !seen.is_empty() {
        message.push_str(&seen.join(", "));
    }
    if hidden > 0 {
        if !seen.is_empty() {
            message.push_str(" and ");
        }
        message.push_str(&format!("{hidden} profile(s) you do not see"));
    }
    message.push_str(". Choose another SSH host in them first.");
    ProfileError::Conflict(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_fields_are_checked_and_normalized() {
        let out = check_host_fields(&json!({ "host": " h.example ", "username": " u " })).unwrap();
        assert_eq!(
            out,
            json!({ "host": "h.example", "port": 22, "username": "u", "auth": "privateKey", "keepaliveSec": null, "hostKey": null })
        );
        assert!(check_host_fields(&json!({ "host": "u@h", "username": "u" })).is_err());
        assert!(check_host_fields(&json!({ "host": "h", "username": "u", "port": 0 })).is_err());
        assert!(check_host_fields(&json!({ "host": "h", "username": "u", "auth": "x" })).is_err());
        let secret = check_host_fields(&json!({ "host": "h", "username": "u", "privateKey": "k" }));
        assert!(
            matches!(secret, Err(ProfileError::Invalid { field, .. }) if field == "fields.privateKey")
        );
        assert!(
            check_host_fields(&json!({ "host": "h", "username": "u", "socketPath": "/s" }))
                .is_err()
        );
    }

    #[test]
    fn a_v1_docker_profile_splits_into_a_login_and_the_socket() {
        let (host, rest) = split_docker_v1(&json!({
            "host": "h", "port": 2222, "username": "u", "auth": "password",
            "hostKey": null, "socketPath": "/run/docker.sock", "keepaliveSec": 30
        }));
        assert_eq!(host["port"], 2222);
        assert_eq!(
            Value::Object(rest),
            json!({ "socketPath": "/run/docker.sock" })
        );
    }

    #[test]
    fn logins_match_on_address_port_user_auth_and_keys_that_agree() {
        let a =
            json!({ "host": "H", "port": 22, "username": "u", "auth": "agent", "hostKey": null });
        let b = json!({ "host": "h", "port": 22, "username": "u", "auth": "agent", "hostKey": { "algorithm": "x", "fingerprintSha256": "1" } });
        let c = json!({ "host": "h", "port": 22, "username": "u", "auth": "agent", "hostKey": { "algorithm": "x", "fingerprintSha256": "2" } });
        assert!(same_login(&a, &b));
        assert!(!same_login(&b, &c));
        let d =
            json!({ "host": "h", "port": 22, "username": "v", "auth": "agent", "hostKey": null });
        assert!(!same_login(&a, &d));
    }

    #[test]
    fn only_the_secrets_of_the_login_s_auth_move() {
        let s = |pairs: &[(&str, &str)]| -> BTreeMap<String, Secret> {
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), Secret::new(v.as_bytes().to_vec())))
                .collect()
        };
        let kept = login_secrets(
            &json!({ "auth": "privateKey" }),
            s(&[("privateKey", "k"), ("passphrase", ""), ("password", "p")]),
        );
        assert_eq!(kept.keys().collect::<Vec<_>>(), ["privateKey"]);
        assert!(login_secrets(&json!({ "auth": "agent" }), s(&[("password", "p")])).is_empty());
    }

    #[test]
    fn a_taken_name_gets_a_number() {
        let owner = Ownership::Personal { user: "u".into() };
        let host = |name: &str, owner: Ownership| StoredProfile {
            id: name.to_owned(),
            tool: HOST_TOOL.to_owned(),
            version: 1,
            name: name.to_owned(),
            color: None,
            fields: json!({}),
            extras: json!({}),
            owner,
            etag: 1,
            created_at: String::new(),
            updated_at: String::new(),
            created_by: String::new(),
            updated_by: String::new(),
        };
        let hosts = vec![
            host("h", owner.clone()),
            host("h-2", Ownership::Shared),
            host(
                "x",
                Ownership::Personal {
                    user: "other".into(),
                },
            ),
        ];
        assert_eq!(free_host_name(&hosts, &owner, "h"), "h-3");
        assert_eq!(free_host_name(&hosts, &owner, "x"), "x");
    }
}
