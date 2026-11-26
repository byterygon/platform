//! The `profiles`, `imports`, `ssh_hosts` and `profiles_backup` tables of `store.redb` (DOC-25
//! §3.4.2, §3.4.9; DOC-23 §8.1).
//!
//! - `profiles`: profile id → the record as JSON ([`StoredProfile`]): the shape of DOC-21 §4.2
//!   without `secrets`, plus the owner, an etag and who made and last changed it.
//! - `imports`: `<user>` U+001F `<source id>` → the profile id an import made, so a repeated import
//!   of the same browser record returns the same profile.
//!
//! Writes check, in the same transaction, the etag (a stale one is a conflict) and that the name
//! is unique per tool among the profiles a user sees: their personal ones and the shared ones.

use redb::{ReadableDatabase as _, ReadableTable as _, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::secrets::{Owner as SecretOwner, SecretError};
use crate::store::Store;

pub(crate) const PROFILES: TableDefinition<&str, &[u8]> = TableDefinition::new("profiles");
pub(crate) const IMPORTS: TableDefinition<&str, &str> = TableDefinition::new("imports");
/// SSH hosts (DOC-23 §4.3, §8.1): rows of the profile shape whose `tool` is `sshHost`.
pub(crate) const SSH_HOSTS: TableDefinition<&str, &[u8]> = TableDefinition::new("ssh_hosts");
/// Profiles as they were before a migration rewrote them (DOC-23 (z)): profile id → the record
/// (never a secret: a Docker profile's secrets moved to the SSH host it now names).
pub(crate) const PROFILES_BACKUP: TableDefinition<&str, &[u8]> =
    TableDefinition::new("profiles_backup");
/// Saved proxies (DOC-23 (ac)): rows of the profile shape whose `tool` is `proxy`.
pub(crate) const PROXIES: TableDefinition<&str, &[u8]> = TableDefinition::new("proxies");
/// Links (DOC-23 (aa)): one way of reaching a node from another; `tool` is `link`.
pub(crate) const LINKS: TableDefinition<&str, &[u8]> = TableDefinition::new("links");
/// Routes (DOC-23 (aa)): named paths of links; `tool` is `route`.
pub(crate) const ROUTES: TableDefinition<&str, &[u8]> = TableDefinition::new("routes");

const SEP: char = '\u{1f}';

/// Who a stored profile belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Ownership {
    /// One user's (their principal id).
    Personal { user: String },
    /// The tenant's.
    Shared,
}

/// A stored profile, without its secrets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProfile {
    pub id: String,
    pub tool: String,
    pub version: u32,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub fields: Value,
    pub extras: Value,
    pub owner: Ownership,
    /// Changes on every write; an update names the one it read.
    pub etag: u64,
    /// RFC 3339.
    pub created_at: String,
    pub updated_at: String,
    pub created_by: String,
    pub updated_by: String,
}

/// Why a profile write was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The etag is not the stored one.
    Stale,
    /// Another profile the owner sees has the name.
    NameTaken,
    /// No such profile.
    Missing,
    Store(String),
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WriteError::Stale => f.write_str("the profile changed since it was read: reload it"),
            WriteError::NameTaken => f.write_str("another profile of this tool has this name"),
            WriteError::Missing => f.write_str("no such profile"),
            WriteError::Store(e) => write!(f, "store: {e}"),
        }
    }
}

fn store_err(e: impl std::fmt::Display) -> WriteError {
    WriteError::Store(e.to_string())
}

fn decode(bytes: &[u8]) -> Result<StoredProfile, WriteError> {
    serde_json::from_slice(bytes)
        .map_err(|e| store_err(format!("a profile row does not read: {e}")))
}

fn import_key(user: &str, source_id: &str) -> String {
    format!("{user}{SEP}{source_id}")
}

/// Whether two profiles' names clash: the same tool and name, and one of them is shared or both
/// belong to the same user.
pub(crate) fn clash(a: &StoredProfile, b: &StoredProfile) -> bool {
    a.id != b.id
        && a.tool == b.tool
        && a.name.to_lowercase() == b.name.to_lowercase()
        && match (&a.owner, &b.owner) {
            (Ownership::Personal { user: x }, Ownership::Personal { user: y }) => x == y,
            _ => true,
        }
}

impl Store {
    /// Every profile, in id order.
    pub fn profiles(&self) -> Result<Vec<StoredProfile>, WriteError> {
        self.rows(PROFILES)
    }

    pub fn profile(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        self.row(PROFILES, id)
    }

    /// Every SSH host, in id order.
    pub fn ssh_hosts(&self) -> Result<Vec<StoredProfile>, WriteError> {
        self.rows(SSH_HOSTS)
    }

    pub fn ssh_host(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        self.row(SSH_HOSTS, id)
    }

    /// The copy of a profile a migration kept before rewriting it (DOC-23 (z)).
    pub fn profile_backup(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        self.row(PROFILES_BACKUP, id)
    }

    pub(crate) fn rows(&self, def: Table) -> Result<Vec<StoredProfile>, WriteError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(def).map_err(store_err)?;
        let mut out = Vec::new();
        for row in table.iter().map_err(store_err)? {
            let (_, value) = row.map_err(store_err)?;
            out.push(decode(value.value())?);
        }
        Ok(out)
    }

    /// How many personal profiles `user` keeps and the bytes of their rows, leaving out
    /// `except` (the profile being replaced). Reads only each row's owner.
    pub fn personal_usage(
        &self,
        user: &str,
        except: Option<&str>,
    ) -> Result<(usize, usize), WriteError> {
        #[derive(Deserialize)]
        struct Owned {
            owner: Ownership,
        }
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(PROFILES).map_err(store_err)?;
        let (mut count, mut bytes) = (0, 0);
        for row in table.iter().map_err(store_err)? {
            let (key, value) = row.map_err(store_err)?;
            if Some(key.value()) == except {
                continue;
            }
            let owned: Owned = serde_json::from_slice(value.value())
                .map_err(|e| store_err(format!("a profile row does not read: {e}")))?;
            if matches!(&owned.owner, Ownership::Personal { user: u } if u == user) {
                count += 1;
                bytes += value.value().len();
            }
        }
        Ok((count, bytes))
    }

    pub(crate) fn row(&self, def: Table, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(def).map_err(store_err)?;
        table
            .get(id)
            .map_err(store_err)?
            .map(|v| decode(v.value()))
            .transpose()
    }

    /// Writes `profile` (a new one when `expected` is `None`, else over the stored one whose
    /// etag is `expected`), with the next etag. `after` runs in the same transaction (the
    /// secrets of the profile, an import's row, the SSH host a Docker import makes).
    pub fn put_profile(
        &self,
        profile: StoredProfile,
        expected: Option<u64>,
        after: impl FnOnce(&redb::WriteTransaction, &StoredProfile) -> Result<(), WriteError>,
    ) -> Result<StoredProfile, WriteError> {
        self.put_row(PROFILES, profile, expected, after)
    }

    /// [`Store::put_profile`] for an SSH host.
    pub fn put_ssh_host(
        &self,
        host: StoredProfile,
        expected: Option<u64>,
        after: impl FnOnce(&redb::WriteTransaction, &StoredProfile) -> Result<(), WriteError>,
    ) -> Result<StoredProfile, WriteError> {
        self.put_row(SSH_HOSTS, host, expected, after)
    }

    pub(crate) fn put_row(
        &self,
        def: Table,
        row: StoredProfile,
        expected: Option<u64>,
        after: impl FnOnce(&redb::WriteTransaction, &StoredProfile) -> Result<(), WriteError>,
    ) -> Result<StoredProfile, WriteError> {
        let write = self.db().begin_write().map_err(store_err)?;
        let row = put_in(&write, def, row, expected)?;
        after(&write, &row)?;
        write.commit().map_err(store_err)?;
        Ok(row)
    }

    /// Runs `work` in one write transaction (a migration's steps).
    pub(crate) fn write<T>(
        &self,
        work: impl FnOnce(&redb::WriteTransaction) -> Result<T, WriteError>,
    ) -> Result<T, WriteError> {
        let write = self.db().begin_write().map_err(store_err)?;
        let out = work(&write)?;
        write.commit().map_err(store_err)?;
        Ok(out)
    }

    /// Deletes a profile, its secrets and the imports that made it. `None` when it was gone.
    pub fn delete_profile(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        self.delete_row(PROFILES, SecretOwner::profile(id), |_| Ok(()))
    }

    /// Deletes an SSH host, its secrets and the imports that made it, in one transaction with
    /// `check`, which refuses while something uses the host. `None` when it was gone.
    pub fn delete_ssh_host(
        &self,
        id: &str,
        check: impl FnOnce(&redb::WriteTransaction) -> Result<(), WriteError>,
    ) -> Result<Option<StoredProfile>, WriteError> {
        self.delete_row(SSH_HOSTS, SecretOwner::ssh_host(id), check)
    }

    /// Deletes a row of `def`, the secrets of `owner` (its id is the row's) and the imports that
    /// made it, in one transaction with `check`. `None` when it was gone.
    pub(crate) fn delete_row(
        &self,
        def: Table,
        owner: SecretOwner,
        check: impl FnOnce(&redb::WriteTransaction) -> Result<(), WriteError>,
    ) -> Result<Option<StoredProfile>, WriteError> {
        let write = self.db().begin_write().map_err(store_err)?;
        check(&write)?;
        let removed = delete_in(&write, def, &owner)?;
        write.commit().map_err(store_err)?;
        Ok(removed)
    }

    /// The profile (or SSH host) an earlier import of `(user, source_id)` made.
    pub fn imported(&self, user: &str, source_id: &str) -> Result<Option<String>, WriteError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(IMPORTS).map_err(store_err)?;
        Ok(table
            .get(import_key(user, source_id).as_str())
            .map_err(store_err)?
            .map(|v| v.value().to_owned()))
    }
}

pub(crate) type Table = TableDefinition<'static, &'static str, &'static [u8]>;

/// [`Store::delete_row`] inside `write`.
pub(crate) fn delete_in(
    write: &redb::WriteTransaction,
    def: Table,
    owner: &SecretOwner,
) -> Result<Option<StoredProfile>, WriteError> {
    let id = owner.id.as_str();
    let mut table = write.open_table(def).map_err(store_err)?;
    let removed = table
        .remove(id)
        .map_err(store_err)?
        .map(|v| decode(v.value()))
        .transpose()?;
    if removed.is_some() {
        let (mut secrets, _) =
            crate::secrets::table::open_tables(write).map_err(|e| store_err(e.to_string()))?;
        let fields: Vec<String> = crate::secrets::table::fields_in(&secrets, owner)
            .map_err(|e| store_err(e.to_string()))?;
        for field in fields {
            crate::secrets::table::remove_in(&mut secrets, owner, &field)
                .map_err(|e| store_err(e.to_string()))?;
        }
        let mut imports = write.open_table(IMPORTS).map_err(store_err)?;
        let keys: Vec<String> = imports
            .iter()
            .map_err(store_err)?
            .filter_map(Result::ok)
            .filter(|(_, v)| v.value() == id)
            .map(|(k, _)| k.value().to_owned())
            .collect();
        for key in keys {
            imports.remove(key.as_str()).map_err(store_err)?;
        }
    }
    Ok(removed)
}

/// Writes `row` into `def` in `write` (a new one when `expected` is `None`, else over the stored
/// one whose etag is `expected`) with the next etag, after checking that its name is free.
pub(crate) fn put_in(
    write: &redb::WriteTransaction,
    def: Table,
    mut row: StoredProfile,
    expected: Option<u64>,
) -> Result<StoredProfile, WriteError> {
    let mut table = write.open_table(def).map_err(store_err)?;
    let current = table
        .get(row.id.as_str())
        .map_err(store_err)?
        .map(|v| decode(v.value()))
        .transpose()?;
    match (expected, &current) {
        (None, Some(_)) => return Err(WriteError::NameTaken),
        (Some(_), None) => return Err(WriteError::Missing),
        (Some(etag), Some(current)) if current.etag != etag => {
            return Err(WriteError::Stale);
        }
        _ => {}
    }
    for stored in table.iter().map_err(store_err)? {
        let (_, value) = stored.map_err(store_err)?;
        if clash(&decode(value.value())?, &row) {
            return Err(WriteError::NameTaken);
        }
    }
    row.etag = current.map_or(1, |c| c.etag + 1);
    let bytes = serde_json::to_vec(&row).map_err(store_err)?;
    table
        .insert(row.id.as_str(), bytes.as_slice())
        .map_err(store_err)?;
    Ok(row)
}

/// Keeps the record a migration is about to rewrite ([`PROFILES_BACKUP`]). A copy already kept
/// for the same profile stays: the oldest is the one worth having.
pub(crate) fn backup_in(
    write: &redb::WriteTransaction,
    before: &StoredProfile,
) -> Result<(), WriteError> {
    let mut table = write.open_table(PROFILES_BACKUP).map_err(store_err)?;
    if table.get(before.id.as_str()).map_err(store_err)?.is_some() {
        return Ok(());
    }
    let bytes = serde_json::to_vec(before).map_err(store_err)?;
    table
        .insert(before.id.as_str(), bytes.as_slice())
        .map_err(store_err)?;
    Ok(())
}

/// Every row of `def` as `write` sees it.
pub(crate) fn rows_in(
    write: &redb::WriteTransaction,
    def: Table,
) -> Result<Vec<StoredProfile>, WriteError> {
    let table = write.open_table(def).map_err(store_err)?;
    let mut out = Vec::new();
    for row in table.iter().map_err(store_err)? {
        let (_, value) = row.map_err(store_err)?;
        out.push(decode(value.value())?);
    }
    Ok(out)
}

/// Records an import in a profile's write transaction ([`Store::put_profile`]'s `after`).
pub(crate) fn record_import(
    write: &redb::WriteTransaction,
    user: &str,
    source_id: &str,
    profile_id: &str,
) -> Result<(), WriteError> {
    let mut table = write.open_table(IMPORTS).map_err(store_err)?;
    table
        .insert(import_key(user, source_id).as_str(), profile_id)
        .map_err(store_err)?;
    Ok(())
}

impl From<SecretError> for WriteError {
    fn from(e: SecretError) -> WriteError {
        WriteError::Store(e.to_string())
    }
}
