//! The `secrets` table of `store.redb` (DOC-25 §3.4.3): one row per secret, keyed by owner kind,
//! owner id and field (separated by U+001F, which no id or field path holds), holding the entry
//! `{ ownerKind, ownerId, field, version, kekId, wrapNonce, wrappedDek, nonce, ciphertext,
//! setBy, setAt, size }` as JSON with the bytes in base64. Setting a secret writes version n+1
//! and replaces version n in one transaction; removing deletes the row.
//!
//! `meta` counts the data keys wrapped under each key (`wraps:<kekId>`), so the store can refuse
//! a wrap past [`super::MAX_WRAPS_PER_KEK`].

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use redb::{ReadableDatabase as _, ReadableTable as _, TableDefinition};
use serde::{Deserialize, Serialize};

use super::crypto::{NONCE_LEN, Sealed};
use super::{Owner, OwnerKind, SecretError, SecretStatus};
use crate::store::Store;

pub(crate) const SECRETS: TableDefinition<&str, &[u8]> = TableDefinition::new("secrets");
const META: TableDefinition<&str, &str> = TableDefinition::new("meta");

const SEP: char = '\u{1f}';

fn row_key(owner: &Owner, field: &str) -> String {
    format!("{}{SEP}{}{SEP}{field}", owner.kind.as_str(), owner.id)
}

fn owner_prefix(owner: &Owner) -> String {
    format!("{}{SEP}{}{SEP}", owner.kind.as_str(), owner.id)
}

fn wraps_key(kek_id: &str) -> String {
    format!("wraps:{kek_id}")
}

fn store_err(e: impl std::fmt::Display) -> SecretError {
    SecretError::Store(e.to_string())
}

impl From<ambidex_axum::accounts::StoreError> for SecretError {
    fn from(e: ambidex_axum::accounts::StoreError) -> SecretError {
        SecretError::Store(e.0)
    }
}

/// A stored entry: the encrypted value and who set it. Holds no plaintext.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEntry {
    pub owner_kind: String,
    pub owner_id: String,
    pub field: String,
    pub version: u64,
    pub kek_id: String,
    /// Base64.
    pub wrap_nonce: String,
    pub wrapped_dek: String,
    pub nonce: String,
    pub ciphertext: String,
    pub set_by: String,
    pub set_at: u64,
    pub size: u64,
}

impl SecretEntry {
    pub fn new(
        owner: &Owner,
        field: &str,
        version: u64,
        sealed: Sealed,
        set_by: &str,
        set_at: u64,
        size: usize,
    ) -> SecretEntry {
        SecretEntry {
            owner_kind: owner.kind.as_str().to_owned(),
            owner_id: owner.id.clone(),
            field: field.to_owned(),
            version,
            kek_id: sealed.kek_id,
            wrap_nonce: BASE64.encode(sealed.wrap_nonce),
            wrapped_dek: BASE64.encode(&sealed.wrapped_dek),
            nonce: BASE64.encode(sealed.nonce),
            ciphertext: BASE64.encode(&sealed.ciphertext),
            set_by: set_by.to_owned(),
            set_at,
            size: size as u64,
        }
    }

    /// The owner (an unknown kind reads as a profile's; [`Self::sealed`] then fails to open).
    pub fn owner(&self) -> Owner {
        Owner::new(
            OwnerKind::parse(&self.owner_kind).unwrap_or(OwnerKind::Profile),
            self.owner_id.clone(),
        )
    }

    /// The encrypted parts, `None` when the row is malformed.
    pub fn sealed(&self) -> Option<Sealed> {
        let nonce12 =
            |text: &str| -> Option<[u8; NONCE_LEN]> { BASE64.decode(text).ok()?.try_into().ok() };
        OwnerKind::parse(&self.owner_kind)?;
        Some(Sealed {
            kek_id: self.kek_id.clone(),
            wrap_nonce: nonce12(&self.wrap_nonce)?,
            wrapped_dek: BASE64.decode(&self.wrapped_dek).ok()?,
            nonce: nonce12(&self.nonce)?,
            ciphertext: BASE64.decode(&self.ciphertext).ok()?,
        })
    }

    /// The same entry with other encrypted parts (a re-wrap).
    pub fn with_sealed(&self, sealed: Sealed) -> SecretEntry {
        SecretEntry {
            kek_id: sealed.kek_id,
            wrap_nonce: BASE64.encode(sealed.wrap_nonce),
            wrapped_dek: BASE64.encode(&sealed.wrapped_dek),
            nonce: BASE64.encode(sealed.nonce),
            ciphertext: BASE64.encode(&sealed.ciphertext),
            ..self.clone()
        }
    }

    pub fn status(&self) -> SecretStatus {
        SecretStatus {
            field: self.field.clone(),
            version: self.version,
            set_by: self.set_by.clone(),
            set_at: self.set_at,
            size: self.size,
            kek_id: self.kek_id.clone(),
        }
    }
}

fn decode(bytes: &[u8]) -> Result<SecretEntry, SecretError> {
    serde_json::from_slice(bytes).map_err(|e| store_err(format!("a secret row does not read: {e}")))
}

impl Store {
    /// Writes the next version of a secret in one transaction: `make` gets the new version and
    /// returns the entry sealed for it (under `kek_id`). Refuses when `kek_id` has wrapped
    /// `max_wraps` data keys.
    pub fn put_secret(
        &self,
        owner: &Owner,
        field: &str,
        kek_id: &str,
        max_wraps: u64,
        make: impl FnOnce(u64) -> Result<SecretEntry, SecretError>,
    ) -> Result<SecretEntry, SecretError> {
        let write = self.db().begin_write().map_err(store_err)?;
        let entry = {
            let mut table = write.open_table(SECRETS).map_err(store_err)?;
            let mut meta = write.open_table(META).map_err(store_err)?;
            put_in(&mut table, &mut meta, owner, field, kek_id, max_wraps, make)?
        };
        write.commit().map_err(store_err)?;
        Ok(entry)
    }

    /// Replaces an entry's wrap (rotation): `rewrap` gets the stored entry and returns it under
    /// `kek_id`. Skips (returns `false`) when the entry is gone, already under `kek_id`, or has
    /// changed version since it was read.
    pub fn rewrap_secret(
        &self,
        owner: &Owner,
        field: &str,
        version: u64,
        kek_id: &str,
        max_wraps: u64,
        rewrap: impl FnOnce(&SecretEntry) -> Result<SecretEntry, SecretError>,
    ) -> Result<bool, SecretError> {
        let key = row_key(owner, field);
        let write = self.db().begin_write().map_err(store_err)?;
        {
            let mut table = write.open_table(SECRETS).map_err(store_err)?;
            let mut meta = write.open_table(META).map_err(store_err)?;
            let current = match table.get(key.as_str()).map_err(store_err)? {
                Some(row) => decode(row.value())?,
                None => return Ok(false),
            };
            if current.version != version || current.kek_id == kek_id {
                return Ok(false);
            }
            let wraps = bump_wraps(&mut meta, kek_id, max_wraps)?;
            let moved = rewrap(&current)?;
            let bytes = serde_json::to_vec(&moved).map_err(store_err)?;
            table
                .insert(key.as_str(), bytes.as_slice())
                .map_err(store_err)?;
            meta.insert(wraps_key(kek_id).as_str(), wraps.to_string().as_str())
                .map_err(store_err)?;
        }
        write.commit().map_err(store_err)?;
        Ok(true)
    }

    /// One entry, `None` when the secret is not set.
    pub fn secret_entry(
        &self,
        owner: &Owner,
        field: &str,
    ) -> Result<Option<SecretEntry>, SecretError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(SECRETS).map_err(store_err)?;
        table
            .get(row_key(owner, field).as_str())
            .map_err(store_err)?
            .map(|row| decode(row.value()))
            .transpose()
    }

    /// Every entry of `owner` (by field), or of the store.
    pub fn secret_entries(&self, owner: Option<&Owner>) -> Result<Vec<SecretEntry>, SecretError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let table = read.open_table(SECRETS).map_err(store_err)?;
        let mut out = Vec::new();
        match owner {
            Some(owner) => {
                let prefix = owner_prefix(owner);
                for row in table.range(prefix.as_str()..).map_err(store_err)? {
                    let (key, value) = row.map_err(store_err)?;
                    if !key.value().starts_with(&prefix) {
                        break;
                    }
                    out.push(decode(value.value())?);
                }
            }
            None => {
                for row in table.iter().map_err(store_err)? {
                    let (_, value) = row.map_err(store_err)?;
                    out.push(decode(value.value())?);
                }
            }
        }
        Ok(out)
    }

    /// Removes one secret; `false` when it was not set.
    pub fn remove_secret(&self, owner: &Owner, field: &str) -> Result<bool, SecretError> {
        let write = self.db().begin_write().map_err(store_err)?;
        let removed = {
            let mut table = write.open_table(SECRETS).map_err(store_err)?;
            table
                .remove(row_key(owner, field).as_str())
                .map_err(store_err)?
                .is_some()
        };
        write.commit().map_err(store_err)?;
        Ok(removed)
    }

    /// Removes every secret of `owner` (a deleted profile, route or account); how many.
    pub fn remove_owner_secrets(&self, owner: &Owner) -> Result<usize, SecretError> {
        let prefix = owner_prefix(owner);
        let write = self.db().begin_write().map_err(store_err)?;
        let removed = {
            let mut table = write.open_table(SECRETS).map_err(store_err)?;
            let keys: Vec<String> = table
                .range(prefix.as_str()..)
                .map_err(store_err)?
                .map_while(|row| {
                    row.ok()
                        .map(|(k, _)| k.value().to_owned())
                        .filter(|k| k.starts_with(&prefix))
                })
                .collect();
            for key in &keys {
                table.remove(key.as_str()).map_err(store_err)?;
            }
            keys.len()
        };
        write.commit().map_err(store_err)?;
        Ok(removed)
    }

    /// The data keys wrapped under each key so far.
    pub fn wraps_by_key(&self) -> Result<Vec<(String, u64)>, SecretError> {
        let read = self.db().begin_read().map_err(store_err)?;
        let meta = read.open_table(META).map_err(store_err)?;
        let mut out = Vec::new();
        for row in meta.range("wraps:"..).map_err(store_err)? {
            let (key, value) = row.map_err(store_err)?;
            let Some(id) = key.value().strip_prefix("wraps:") else {
                break;
            };
            out.push((id.to_owned(), value.value().parse().unwrap_or(0)));
        }
        Ok(out)
    }
}

/// The tables a write transaction needs for [`put_in`].
/// The `secrets` table and `meta`, open in a write transaction.
pub(crate) type WriteTables<'t> = (
    redb::Table<'t, &'static str, &'static [u8]>,
    redb::Table<'t, &'static str, &'static str>,
);

pub(crate) fn open_tables(write: &redb::WriteTransaction) -> Result<WriteTables<'_>, SecretError> {
    Ok((
        write.open_table(SECRETS).map_err(store_err)?,
        write.open_table(META).map_err(store_err)?,
    ))
}

/// One entry, read in a transaction the caller holds.
pub(crate) fn get_in(
    table: &impl redb::ReadableTable<&'static str, &'static [u8]>,
    owner: &Owner,
    field: &str,
) -> Result<Option<SecretEntry>, SecretError> {
    table
        .get(row_key(owner, field).as_str())
        .map_err(store_err)?
        .map(|row| decode(row.value()))
        .transpose()
}

/// [`Store::put_secret`] in a transaction the caller holds (an account and its TOTP key in one).
pub(crate) fn put_in(
    table: &mut redb::Table<'_, &'static str, &'static [u8]>,
    meta: &mut redb::Table<'_, &'static str, &'static str>,
    owner: &Owner,
    field: &str,
    kek_id: &str,
    max_wraps: u64,
    make: impl FnOnce(u64) -> Result<SecretEntry, SecretError>,
) -> Result<SecretEntry, SecretError> {
    let key = row_key(owner, field);
    let version = match table.get(key.as_str()).map_err(store_err)? {
        Some(row) => decode(row.value())?.version + 1,
        None => 1,
    };
    let wraps = bump_wraps(meta, kek_id, max_wraps)?;
    let entry = make(version)?;
    debug_assert_eq!(entry.kek_id, kek_id);
    let bytes = serde_json::to_vec(&entry).map_err(store_err)?;
    table
        .insert(key.as_str(), bytes.as_slice())
        .map_err(store_err)?;
    meta.insert(wraps_key(kek_id).as_str(), wraps.to_string().as_str())
        .map_err(store_err)?;
    Ok(entry)
}

/// Removes one entry in a transaction the caller holds.
pub(crate) fn remove_in(
    table: &mut redb::Table<'_, &'static str, &'static [u8]>,
    owner: &Owner,
    field: &str,
) -> Result<bool, SecretError> {
    Ok(table
        .remove(row_key(owner, field).as_str())
        .map_err(store_err)?
        .is_some())
}

/// The count of wraps under `kek_id` after one more, refused at `max_wraps`.
fn bump_wraps(
    meta: &mut redb::Table<'_, &str, &str>,
    kek_id: &str,
    max_wraps: u64,
) -> Result<u64, SecretError> {
    let done: u64 = meta
        .get(wraps_key(kek_id).as_str())
        .map_err(store_err)?
        .and_then(|v| v.value().parse().ok())
        .unwrap_or(0);
    if done >= max_wraps {
        return Err(SecretError::KeyExhausted {
            kek_id: kek_id.to_owned(),
        });
    }
    Ok(done + 1)
}
