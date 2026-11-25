//! The `profiles` and `imports` tables of `store.redb` (DOC-25 §3.4.2, §3.4.9).
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
fn clash(a: &StoredProfile, b: &StoredProfile) -> bool {
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
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(PROFILES).map_err(store_err)?;
        let mut out = Vec::new();
        for row in table.iter().map_err(store_err)? {
            let (_, value) = row.map_err(store_err)?;
            out.push(decode(value.value())?);
        }
        Ok(out)
    }

    pub fn profile(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(PROFILES).map_err(store_err)?;
        table
            .get(id)
            .map_err(store_err)?
            .map(|v| decode(v.value()))
            .transpose()
    }

    /// Writes `profile` (a new one when `expected` is `None`, else over the stored one whose
    /// etag is `expected`), with the next etag. `after` runs in the same transaction (the
    /// secrets of the profile, an import's row).
    pub fn put_profile(
        &self,
        mut profile: StoredProfile,
        expected: Option<u64>,
        after: impl FnOnce(&redb::WriteTransaction, &StoredProfile) -> Result<(), WriteError>,
    ) -> Result<StoredProfile, WriteError> {
        let write = self.db().begin_write().map_err(store_err)?;
        {
            let mut table = write.open_table(PROFILES).map_err(store_err)?;
            let current = table
                .get(profile.id.as_str())
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
            for row in table.iter().map_err(store_err)? {
                let (_, value) = row.map_err(store_err)?;
                if clash(&decode(value.value())?, &profile) {
                    return Err(WriteError::NameTaken);
                }
            }
            profile.etag = current.map_or(1, |c| c.etag + 1);
            let bytes = serde_json::to_vec(&profile).map_err(store_err)?;
            table
                .insert(profile.id.as_str(), bytes.as_slice())
                .map_err(store_err)?;
        }
        after(&write, &profile)?;
        write.commit().map_err(store_err)?;
        Ok(profile)
    }

    /// Deletes a profile, its secrets and the imports that made it. `None` when it was gone.
    pub fn delete_profile(&self, id: &str) -> Result<Option<StoredProfile>, WriteError> {
        let write = self.db().begin_write().map_err(store_err)?;
        let removed = {
            let mut table = write.open_table(PROFILES).map_err(store_err)?;
            let removed = table
                .remove(id)
                .map_err(store_err)?
                .map(|v| decode(v.value()))
                .transpose()?;
            if removed.is_some() {
                let (mut secrets, _) = crate::secrets::table::open_tables(&write)
                    .map_err(|e| store_err(e.to_string()))?;
                let owner = SecretOwner::profile(id);
                let fields: Vec<String> = crate::secrets::table::fields_in(&secrets, &owner)
                    .map_err(|e| store_err(e.to_string()))?;
                for field in fields {
                    crate::secrets::table::remove_in(&mut secrets, &owner, &field)
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
            removed
        };
        write.commit().map_err(store_err)?;
        Ok(removed)
    }

    /// The profile an earlier import of `(user, source_id)` made.
    pub fn imported(&self, user: &str, source_id: &str) -> Result<Option<String>, WriteError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(IMPORTS).map_err(store_err)?;
        Ok(table
            .get(import_key(user, source_id).as_str())
            .map_err(store_err)?
            .map(|v| v.value().to_owned()))
    }
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
