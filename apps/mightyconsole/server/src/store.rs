//! The server's store, `DATA/store.redb` (DOC-25 §3.1, §3.6.3): one redb file, mode 0600,
//! opened by one process at a time (redb's exclusive-writer lock, so `reset-admin` can tell a
//! running server from a stopped one, §3.2.7).
//!
//! Tables (schema version [`SCHEMA_VERSION`] in `meta`):
//!
//! - `meta`: `schema` → the version.
//! - `accounts`: account id → the account as JSON ([`ambidex_axum::accounts::Account`]).
//! - `usernames`: user name (lower case) → account id, so names stay unique.
//! - `setup_links`: SHA-256 of a setup link's token → `{account, expires}` as JSON.
//!
//! - `users`: principal id (`human:oidc:<sub>`) → an OIDC user's record as JSON ([`OidcUser`]),
//!   made at the first sign-in (DOC-25 §3.2.3). Built-in accounts are in `accounts`.
//! - `roles`: role id → a custom role as JSON ([`CustomRole`]); built-in roles are not stored.
//! - `assignments`: principal id → the user's direct assignments as JSON (`[{ role, scope }]`).
//! - `group_roles`: `mappings` → the editable group mappings with their etag as JSON.
//! - `groups`: local group name → its members (principal ids) as JSON.
//!
//! - `profiles`, `imports`: stored profiles and the browser records imported as them
//!   ([`crate::profiles::table`]).
//! - `secrets`: one encrypted entry per secret ([`crate::secrets::table`]); `meta` also counts
//!   the data keys wrapped under each key (`wraps:<kekId>`).
//!
//! The tables of roles, groups and secrets are made on open when an older store lacks them.
//! An account's TOTP key is a `secrets` entry
//! (owner kind `account`, field `totp`), written in the transaction of its row; rows of TSK-142's
//! stores that still hold the key are moved at start ([`Store::migrate_totp_keys`]). Reading an
//! account with TOTP needs the keys ([`Store::set_vault`]).
//!
//! Every write is one transaction, durable when it commits. [`McAccountStore`] runs them on the
//! blocking pool.

use std::fmt;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use ambidex::engine::BoxFuture;
use ambidex_axum::accounts::{
    Account, AccountStore, CreateError, CreatedBy, StoreError, TotpRecord,
};
use redb::{
    Database, DatabaseError, ReadableDatabase, ReadableTable, ReadableTableMetadata,
    TableDefinition,
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::authz::policy::{Assignment, CustomRole, GroupMapping, PolicyParts};

/// The store's file in the data directory.
pub const STORE_FILE: &str = "store.redb";
/// The schema this build reads and writes.
pub const SCHEMA_VERSION: &str = "1";

const META: TableDefinition<&str, &str> = TableDefinition::new("meta");
const ACCOUNTS: TableDefinition<&str, &[u8]> = TableDefinition::new("accounts");
const USERNAMES: TableDefinition<&str, &str> = TableDefinition::new("usernames");
const SETUP_LINKS: TableDefinition<&[u8], &[u8]> = TableDefinition::new("setup_links");
const USERS: TableDefinition<&str, &[u8]> = TableDefinition::new("users");
const ROLES: TableDefinition<&str, &[u8]> = TableDefinition::new("roles");
const ASSIGNMENTS: TableDefinition<&str, &[u8]> = TableDefinition::new("assignments");
const GROUP_ROLES: TableDefinition<&str, &[u8]> = TableDefinition::new("group_roles");
const GROUPS: TableDefinition<&str, &[u8]> = TableDefinition::new("groups");

/// The one row of `group_roles`.
const MAPPINGS_KEY: &str = "mappings";

/// An OIDC user's record (DOC-25 §3.2.3): made at the first sign-in, updated at each. The name
/// and e-mail are shown only, never used for authorization.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OidcUser {
    /// `human:oidc:<sub>`.
    pub id: String,
    pub sub: String,
    pub display_name: String,
    pub email: Option<String>,
    /// The IdP's groups as of the last sign-in.
    pub groups: Vec<String>,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
    pub disabled: bool,
}

/// The editable group mappings and their etag (a stale etag is a conflict).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoredMappings {
    pub etag: u64,
    pub mappings: Vec<GroupMapping>,
}

/// Why the store did not open.
#[derive(Debug)]
pub enum OpenError {
    /// Another process has it open (a running server).
    Locked(PathBuf),
    /// A schema this build does not know (a newer server wrote it).
    Schema {
        path: PathBuf,
        found: String,
    },
    Other {
        path: PathBuf,
        message: String,
    },
}

impl fmt::Display for OpenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            OpenError::Locked(path) => write!(
                f,
                "store {}: another process has it open (is a server running on this data directory?)",
                path.display()
            ),
            OpenError::Schema { path, found } => write!(
                f,
                "store {}: schema version {found:?} is not one this server knows ({SCHEMA_VERSION})",
                path.display()
            ),
            OpenError::Other { path, message } => write!(f, "store {}: {message}", path.display()),
        }
    }
}

impl std::error::Error for OpenError {}

/// The store file of a data directory.
pub fn store_path(data: &Path) -> PathBuf {
    data.join(STORE_FILE)
}

/// An open `store.redb`.
pub struct Store {
    db: Database,
    path: PathBuf,
    /// The secret store's keys, once loaded: accounts' TOTP keys are entries of the `secrets`
    /// table (DOC-25 §3.2.6, owner kind `account`).
    vault: std::sync::OnceLock<Arc<crate::secrets::Vault>>,
}

impl fmt::Debug for Store {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Store").field("path", &self.path).finish()
    }
}

fn err(e: impl fmt::Display) -> StoreError {
    StoreError(e.to_string())
}

#[derive(Serialize, Deserialize)]
struct TotpRow {
    /// Hex. Only in rows written before the key moved to the `secrets` table; moved at start
    /// ([`Store::migrate_totp_keys`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<Zeroizing<String>>,
    last_step: u64,
    enrolled_ms: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountRow {
    id: String,
    username: String,
    display_name: String,
    password_hash: Option<String>,
    must_change_password: bool,
    /// `self`, `server`, or `admin:<principal id>`.
    created_by: String,
    created_ms: u64,
    last_seen_ms: Option<u64>,
    disabled: bool,
    locked_until_ms: Option<u64>,
    totp: Option<TotpRow>,
    recovery_codes: Vec<String>,
}

#[cfg(test)]
fn hex(bytes: &[u8]) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::with_capacity(bytes.len() * 2));
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

fn unhex(text: &str) -> Option<Zeroizing<Vec<u8>>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    let mut out = Zeroizing::new(Vec::with_capacity(text.len() / 2));
    for pair in text.as_bytes().chunks(2) {
        let pair = std::str::from_utf8(pair).ok()?;
        out.push(u8::from_str_radix(pair, 16).ok()?);
    }
    Some(out)
}

impl AccountRow {
    fn from_account(a: &Account) -> AccountRow {
        AccountRow {
            id: a.id.clone(),
            username: a.username.clone(),
            display_name: a.display_name.clone(),
            password_hash: a.password_hash.clone(),
            must_change_password: a.must_change_password,
            created_by: match &a.created_by {
                CreatedBy::SelfSignup => "self".into(),
                CreatedBy::Server => "server".into(),
                CreatedBy::Administrator(by) => format!("admin:{by}"),
            },
            created_ms: a.created_ms,
            last_seen_ms: a.last_seen_ms,
            disabled: a.disabled,
            locked_until_ms: a.locked_until_ms,
            totp: a.totp.as_ref().map(|t| TotpRow {
                key: None,
                last_step: t.last_step,
                enrolled_ms: t.enrolled_ms,
            }),
            recovery_codes: a.recovery_codes.clone(),
        }
    }

    /// The account; `totp_key` reads its TOTP key from the `secrets` table when the row has
    /// none of its own.
    fn into_account(
        self,
        totp_key: impl FnOnce(&str) -> Result<Zeroizing<Vec<u8>>, StoreError>,
    ) -> Result<Account, StoreError> {
        let totp = match self.totp {
            Some(t) => Some(TotpRecord {
                key: match &t.key {
                    Some(legacy) => unhex(legacy).ok_or_else(|| err("a TOTP key is not hex"))?,
                    None => totp_key(&self.id)?,
                },
                last_step: t.last_step,
                enrolled_ms: t.enrolled_ms,
            }),
            None => None,
        };
        Ok(Account {
            id: self.id,
            username: self.username,
            display_name: self.display_name,
            password_hash: self.password_hash,
            must_change_password: self.must_change_password,
            created_by: match self.created_by.as_str() {
                "self" => CreatedBy::SelfSignup,
                "server" => CreatedBy::Server,
                other => CreatedBy::Administrator(
                    other.strip_prefix("admin:").unwrap_or(other).to_owned(),
                ),
            },
            created_ms: self.created_ms,
            last_seen_ms: self.last_seen_ms,
            disabled: self.disabled,
            locked_until_ms: self.locked_until_ms,
            totp,
            recovery_codes: self.recovery_codes,
        })
    }
}

fn encode(account: &Account) -> Result<Zeroizing<Vec<u8>>, StoreError> {
    serde_json::to_vec(&AccountRow::from_account(account))
        .map(Zeroizing::new)
        .map_err(err)
}

fn decode_row(bytes: &[u8]) -> Result<AccountRow, StoreError> {
    serde_json::from_slice::<AccountRow>(bytes)
        .map_err(|e| err(format!("an account row does not read: {e}")))
}

/// The owner of an account's TOTP key in the `secrets` table, and its field.
fn totp_owner(account_id: &str) -> crate::secrets::Owner {
    crate::secrets::Owner::new(crate::secrets::OwnerKind::Account, account_id)
}
const TOTP_FIELD: &str = "totp";

fn secret_err(e: crate::secrets::SecretError) -> StoreError {
    err(e.to_string())
}

fn json(value: &impl Serialize) -> Result<Vec<u8>, StoreError> {
    serde_json::to_vec(value).map_err(err)
}

fn read_json<T: serde::de::DeserializeOwned>(bytes: &[u8], what: &str) -> Result<T, StoreError> {
    serde_json::from_slice(bytes).map_err(|e| err(format!("{what} does not read: {e}")))
}

#[derive(Serialize, Deserialize)]
struct SetupRow {
    account: String,
    expires: u64,
}

impl Store {
    /// Opens (creating it when missing) the store of a data directory. Fails when another
    /// process has it open, or when its schema is not this build's.
    pub fn open(data: &Path) -> Result<Store, OpenError> {
        let path = store_path(data);
        let other = |message: String| OpenError::Other {
            path: path.clone(),
            message,
        };
        fs::create_dir_all(data).map_err(|e| other(e.to_string()))?;
        let created = !path.exists();
        let db = redb::Builder::new()
            .set_cache_size(16 << 20)
            .create(&path)
            .map_err(|e| match e {
                DatabaseError::DatabaseAlreadyOpen => OpenError::Locked(path.clone()),
                e => other(e.to_string()),
            })?;
        restrict(&path, created).map_err(|e| other(e.to_string()))?;
        let store = Store {
            db,
            path: path.clone(),
            vault: std::sync::OnceLock::new(),
        };
        let found = store.schema().map_err(|e| other(e.0))?;
        match found.as_deref() {
            Some(SCHEMA_VERSION) => {}
            None => store.init().map_err(|e| other(e.0))?,
            Some(found) => {
                return Err(OpenError::Schema {
                    path,
                    found: found.to_owned(),
                });
            }
        }
        store.ensure_tables().map_err(|e| other(e.0))?;
        Ok(store)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// A store with a fixed test key (tests of the crate): reopening it reads its entries.
    #[cfg(test)]
    pub(crate) fn open_for_tests(data: &Path) -> Store {
        let store = Store::open(data).unwrap();
        let key = crate::secrets::crypto::Kek::from_bytes(Zeroizing::new([7u8; 32]));
        let keyring = crate::secrets::keys::Keyring::new(vec![key]).unwrap();
        store.set_vault(Arc::new(crate::secrets::Vault::new(keyring, "default")));
        store
    }

    /// Gives the store the secret keys (once, after they load at start).
    pub fn set_vault(&self, vault: Arc<crate::secrets::Vault>) {
        let _ = self.vault.set(vault);
    }

    fn vault(&self) -> Result<&Arc<crate::secrets::Vault>, StoreError> {
        self.vault.get().ok_or_else(|| {
            err("the secret keys are not loaded, so an account's TOTP key cannot be read or written")
        })
    }

    /// Decodes an account row read in a transaction that also has the `secrets` table open.
    fn account_of(
        &self,
        bytes: &[u8],
        secrets: &impl redb::ReadableTable<&'static str, &'static [u8]>,
    ) -> Result<Account, StoreError> {
        decode_row(bytes)?.into_account(|id| {
            let owner = totp_owner(id);
            let entry = crate::secrets::table::get_in(secrets, &owner, TOTP_FIELD)
                .map_err(secret_err)?
                .ok_or_else(|| err(format!("account {id}: its TOTP key is missing")))?;
            let value = self.vault()?.open(&entry).map_err(secret_err)?;
            Ok(Zeroizing::new(value.expose().to_vec()))
        })
    }

    /// Writes (or removes) an account's TOTP key in the write transaction of its row: a new
    /// version only when the key changed.
    fn write_totp(
        &self,
        write: &redb::WriteTransaction,
        account: &Account,
    ) -> Result<(), StoreError> {
        let owner = totp_owner(&account.id);
        let (mut secrets, mut meta) =
            crate::secrets::table::open_tables(write).map_err(secret_err)?;
        let Some(totp) = &account.totp else {
            crate::secrets::table::remove_in(&mut secrets, &owner, TOTP_FIELD)
                .map_err(secret_err)?;
            return Ok(());
        };
        let vault = self.vault()?;
        if let Some(entry) =
            crate::secrets::table::get_in(&secrets, &owner, TOTP_FIELD).map_err(secret_err)?
            && vault
                .open(&entry)
                .is_ok_and(|v| v.expose() == totp.key.as_slice())
        {
            return Ok(());
        }
        let keyring = vault.keyring();
        let value = crate::secrets::Secret::new(totp.key.to_vec());
        let by = account.principal_id();
        let at = security_types::unix_now_ms();
        crate::secrets::table::put_in(
            &mut secrets,
            &mut meta,
            &owner,
            TOTP_FIELD,
            keyring.active().id(),
            crate::secrets::MAX_WRAPS_PER_KEK,
            |version| vault.seal_entry(&keyring, &owner, TOTP_FIELD, version, &value, &by, at),
        )
        .map_err(secret_err)?;
        Ok(())
    }

    /// Moves TOTP keys still kept in their account rows (stores of TSK-142) into the `secrets`
    /// table, in one transaction. How many moved.
    pub fn migrate_totp_keys(&self) -> Result<usize, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let moved = {
            let mut accounts = write.open_table(ACCOUNTS).map_err(err)?;
            let mut legacy = Vec::new();
            for row in accounts.iter().map_err(err)? {
                let (id, value) = row.map_err(err)?;
                let row = decode_row(value.value())?;
                if row.totp.as_ref().is_some_and(|t| t.key.is_some()) {
                    legacy.push((id.value().to_owned(), row));
                }
            }
            let moved = legacy.len();
            for (id, row) in legacy {
                // A legacy row holds its key: it decodes without the `secrets` table.
                let account =
                    row.into_account(|_| Err(err("a legacy TOTP row without its key")))?;
                self.write_totp(&write, &account)?;
                accounts
                    .insert(id.as_str(), encode(&account)?.as_slice())
                    .map_err(err)?;
            }
            moved
        };
        write.commit().map_err(err)?;
        Ok(moved)
    }

    pub(crate) fn db(&self) -> &Database {
        &self.db
    }

    fn schema(&self) -> Result<Option<String>, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let table = match read.open_table(META) {
            Ok(table) => table,
            Err(redb::TableError::TableDoesNotExist(_)) => return Ok(None),
            Err(e) => return Err(err(e)),
        };
        Ok(table
            .get("schema")
            .map_err(err)?
            .map(|v| v.value().to_owned()))
    }

    fn init(&self) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        {
            write
                .open_table(META)
                .map_err(err)?
                .insert("schema", SCHEMA_VERSION)
                .map_err(err)?;
            write.open_table(ACCOUNTS).map_err(err)?;
            write.open_table(USERNAMES).map_err(err)?;
            write.open_table(SETUP_LINKS).map_err(err)?;
        }
        write.commit().map_err(err)
    }

    /// Makes the tables of roles, groups and secrets when the store predates them.
    fn ensure_tables(&self) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        {
            write.open_table(USERS).map_err(err)?;
            write.open_table(ROLES).map_err(err)?;
            write.open_table(ASSIGNMENTS).map_err(err)?;
            write.open_table(GROUP_ROLES).map_err(err)?;
            write.open_table(GROUPS).map_err(err)?;
            write
                .open_table(crate::secrets::table::SECRETS)
                .map_err(err)?;
            write
                .open_table(crate::profiles::table::PROFILES)
                .map_err(err)?;
            write
                .open_table(crate::profiles::table::IMPORTS)
                .map_err(err)?;
        }
        write.commit().map_err(err)
    }

    /// Records an OIDC sign-in: makes the user's record at the first one, otherwise updates its
    /// name, e-mail, groups and last sign-in. Returns the record (a disabled user stays
    /// disabled).
    pub fn record_oidc_user(
        &self,
        id: &str,
        sub: &str,
        display_name: &str,
        email: Option<&str>,
        groups: &[String],
        now_ms: u64,
    ) -> Result<OidcUser, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let user = {
            let mut users = write.open_table(USERS).map_err(err)?;
            let existing = users
                .get(id)
                .map_err(err)?
                .map(|v| read_json::<OidcUser>(v.value(), "a user"))
                .transpose()?;
            let user = OidcUser {
                id: id.to_owned(),
                sub: sub.to_owned(),
                display_name: display_name.to_owned(),
                email: email.map(str::to_owned),
                groups: groups.to_vec(),
                first_seen_ms: existing.as_ref().map_or(now_ms, |u| u.first_seen_ms),
                last_seen_ms: now_ms,
                disabled: existing.as_ref().is_some_and(|u| u.disabled),
            };
            users.insert(id, json(&user)?.as_slice()).map_err(err)?;
            user
        };
        write.commit().map_err(err)?;
        Ok(user)
    }

    pub fn oidc_user(&self, id: &str) -> Result<Option<OidcUser>, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let users = read.open_table(USERS).map_err(err)?;
        users
            .get(id)
            .map_err(err)?
            .map(|v| read_json(v.value(), "a user"))
            .transpose()
    }

    /// Every OIDC user, in id order.
    pub fn oidc_users(&self) -> Result<Vec<OidcUser>, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let users = read.open_table(USERS).map_err(err)?;
        let mut out = Vec::new();
        for row in users.iter().map_err(err)? {
            let (_, value) = row.map_err(err)?;
            out.push(read_json(value.value(), "a user")?);
        }
        Ok(out)
    }

    /// Changes an OIDC user's record; `None` when there is none.
    pub fn update_oidc_user<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut OidcUser) -> T,
    ) -> Result<Option<T>, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let out = {
            let mut users = write.open_table(USERS).map_err(err)?;
            let current = users
                .get(id)
                .map_err(err)?
                .map(|v| read_json::<OidcUser>(v.value(), "a user"))
                .transpose()?;
            match current {
                None => None,
                Some(mut user) => {
                    let out = change(&mut user);
                    user.id = id.to_owned();
                    users.insert(id, json(&user)?.as_slice()).map_err(err)?;
                    Some(out)
                }
            }
        };
        write.commit().map_err(err)?;
        Ok(out)
    }

    /// Adds or replaces a custom role.
    pub fn put_role(&self, role: &CustomRole) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        write
            .open_table(ROLES)
            .map_err(err)?
            .insert(role.id.as_str(), json(role)?.as_slice())
            .map_err(err)?;
        write.commit().map_err(err)
    }

    /// Removes a custom role; `false` when there was none.
    pub fn delete_role(&self, id: &str) -> Result<bool, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let removed = write
            .open_table(ROLES)
            .map_err(err)?
            .remove(id)
            .map_err(err)?
            .is_some();
        write.commit().map_err(err)?;
        Ok(removed)
    }

    /// Replaces a user's direct assignments (none removes the row).
    pub fn set_assignments(
        &self,
        user: &str,
        assignments: &[Assignment],
    ) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        {
            let mut table = write.open_table(ASSIGNMENTS).map_err(err)?;
            if assignments.is_empty() {
                table.remove(user).map_err(err)?;
            } else {
                table
                    .insert(user, json(&assignments)?.as_slice())
                    .map_err(err)?;
            }
        }
        write.commit().map_err(err)
    }

    /// Replaces the editable group mappings when `etag` is the current one; returns the new
    /// etag, or `None` for a stale one.
    pub fn set_mappings(
        &self,
        etag: u64,
        mappings: &[GroupMapping],
    ) -> Result<Option<u64>, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let next = {
            let mut table = write.open_table(GROUP_ROLES).map_err(err)?;
            let current: StoredMappings = table
                .get(MAPPINGS_KEY)
                .map_err(err)?
                .map(|v| read_json(v.value(), "the group mappings"))
                .transpose()?
                .unwrap_or_default();
            if current.etag != etag {
                None
            } else {
                let next = StoredMappings {
                    etag: etag + 1,
                    mappings: mappings.to_vec(),
                };
                table
                    .insert(MAPPINGS_KEY, json(&next)?.as_slice())
                    .map_err(err)?;
                Some(next.etag)
            }
        };
        write.commit().map_err(err)?;
        Ok(next)
    }

    pub fn mappings(&self) -> Result<StoredMappings, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let table = read.open_table(GROUP_ROLES).map_err(err)?;
        Ok(table
            .get(MAPPINGS_KEY)
            .map_err(err)?
            .map(|v| read_json(v.value(), "the group mappings"))
            .transpose()?
            .unwrap_or_default())
    }

    /// Sets a local group's members (an empty set keeps the group; [`Store::delete_group`]
    /// removes it).
    pub fn put_group(&self, name: &str, members: &BTreeSet<String>) -> Result<(), StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        write
            .open_table(GROUPS)
            .map_err(err)?
            .insert(name, json(members)?.as_slice())
            .map_err(err)?;
        write.commit().map_err(err)
    }

    pub fn delete_group(&self, name: &str) -> Result<bool, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let removed = write
            .open_table(GROUPS)
            .map_err(err)?
            .remove(name)
            .map_err(err)?
            .is_some();
        write.commit().map_err(err)?;
        Ok(removed)
    }

    /// Everything the policy needs from the store (DOC-25 §3.3.5): custom roles, direct
    /// assignments, editable mappings, local groups, and the disabled accounts and OIDC users.
    /// The configuration adds the rest ([`PolicyParts::default_role`], the pinned mappings, the
    /// default administrator).
    pub fn policy_parts(&self) -> Result<PolicyParts, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let mut parts = PolicyParts::default();
        for row in read.open_table(ROLES).map_err(err)?.iter().map_err(err)? {
            let (_, v) = row.map_err(err)?;
            parts.custom_roles.push(read_json(v.value(), "a role")?);
        }
        let mut direct = HashMap::new();
        for row in read
            .open_table(ASSIGNMENTS)
            .map_err(err)?
            .iter()
            .map_err(err)?
        {
            let (k, v) = row.map_err(err)?;
            direct.insert(
                k.value().to_owned(),
                read_json::<Vec<Assignment>>(v.value(), "assignments")?,
            );
        }
        parts.direct = direct;
        parts.mappings = read
            .open_table(GROUP_ROLES)
            .map_err(err)?
            .get(MAPPINGS_KEY)
            .map_err(err)?
            .map(|v| read_json::<StoredMappings>(v.value(), "the group mappings"))
            .transpose()?
            .unwrap_or_default()
            .mappings;
        let mut groups = BTreeMap::new();
        for row in read.open_table(GROUPS).map_err(err)?.iter().map_err(err)? {
            let (k, v) = row.map_err(err)?;
            groups.insert(
                k.value().to_owned(),
                read_json::<BTreeSet<String>>(v.value(), "a group")?,
            );
        }
        parts.local_groups = groups;
        for row in read
            .open_table(ACCOUNTS)
            .map_err(err)?
            .iter()
            .map_err(err)?
        {
            let (_, v) = row.map_err(err)?;
            // The row alone: no TOTP key is read for the policy.
            let account = decode_row(v.value())?;
            if account.disabled {
                parts
                    .disabled
                    .insert(ambidex_axum::accounts::principal_id(&account.id));
            }
        }
        for row in read.open_table(USERS).map_err(err)?.iter().map_err(err)? {
            let (_, v) = row.map_err(err)?;
            let user: OidcUser = read_json(v.value(), "a user")?;
            if user.disabled {
                parts.disabled.insert(user.id);
            }
        }
        Ok(parts)
    }

    /// Adds an account; its user name and id must be free.
    pub fn create_account(&self, account: &Account) -> Result<(), CreateError> {
        let bytes = encode(account)?;
        let write = self.db.begin_write().map_err(err)?;
        if account.totp.is_some() {
            self.write_totp(&write, account)?;
        }
        {
            let mut names = write.open_table(USERNAMES).map_err(err)?;
            let mut accounts = write.open_table(ACCOUNTS).map_err(err)?;
            if names.get(account.username.as_str()).map_err(err)?.is_some()
                || accounts.get(account.id.as_str()).map_err(err)?.is_some()
            {
                return Err(CreateError::UsernameTaken);
            }
            names
                .insert(account.username.as_str(), account.id.as_str())
                .map_err(err)?;
            accounts
                .insert(account.id.as_str(), bytes.as_slice())
                .map_err(err)?;
        }
        write.commit().map_err(err)?;
        Ok(())
    }

    pub fn account(&self, id: &str) -> Result<Option<Account>, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let accounts = read.open_table(ACCOUNTS).map_err(err)?;
        let secrets = read
            .open_table(crate::secrets::table::SECRETS)
            .map_err(err)?;
        accounts
            .get(id)
            .map_err(err)?
            .map(|v| self.account_of(v.value(), &secrets))
            .transpose()
    }

    pub fn account_by_username(&self, username: &str) -> Result<Option<Account>, StoreError> {
        let id = {
            let read = self.db.begin_read().map_err(err)?;
            let names = read.open_table(USERNAMES).map_err(err)?;
            names
                .get(username)
                .map_err(err)?
                .map(|v| v.value().to_owned())
        };
        match id {
            Some(id) => self.account(&id),
            None => Ok(None),
        }
    }

    /// Every account, in id order (oldest first: ids are ULIDs).
    pub fn accounts(&self) -> Result<Vec<Account>, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let accounts = read.open_table(ACCOUNTS).map_err(err)?;
        let secrets = read
            .open_table(crate::secrets::table::SECRETS)
            .map_err(err)?;
        let mut out = Vec::new();
        for row in accounts.iter().map_err(err)? {
            let (_, value) = row.map_err(err)?;
            out.push(self.account_of(value.value(), &secrets)?);
        }
        Ok(out)
    }

    /// Deletes an account and frees its user name; `false` when there was none.
    pub fn delete_account(&self, id: &str) -> Result<bool, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let removed = {
            let mut accounts = write.open_table(ACCOUNTS).map_err(err)?;
            let removed = accounts
                .remove(id)
                .map_err(err)?
                .map(|v| decode_row(v.value()))
                .transpose()?;
            if let Some(account) = &removed {
                write
                    .open_table(USERNAMES)
                    .map_err(err)?
                    .remove(account.username.as_str())
                    .map_err(err)?;
                let (mut secrets, _) =
                    crate::secrets::table::open_tables(&write).map_err(secret_err)?;
                crate::secrets::table::remove_in(&mut secrets, &totp_owner(id), TOTP_FIELD)
                    .map_err(secret_err)?;
            }
            removed.is_some()
        };
        write.commit().map_err(err)?;
        Ok(removed)
    }

    /// Changes an account in one transaction; `change` answers what to return. `None` when the
    /// account does not exist. The user name cannot change here.
    pub fn update_account<T>(
        &self,
        id: &str,
        change: impl FnOnce(&mut Account) -> T,
    ) -> Result<Option<T>, StoreError> {
        let write = self.db.begin_write().map_err(err)?;
        let out = {
            let mut accounts = write.open_table(ACCOUNTS).map_err(err)?;
            let current = {
                let (secrets, _) =
                    crate::secrets::table::open_tables(&write).map_err(secret_err)?;
                accounts
                    .get(id)
                    .map_err(err)?
                    .map(|v| self.account_of(v.value(), &secrets))
            };
            match current {
                None => None,
                Some(account) => {
                    let mut account = account?;
                    let username = account.username.clone();
                    let had_totp = account.totp.is_some();
                    let out = change(&mut account);
                    account.username = username;
                    if had_totp || account.totp.is_some() {
                        self.write_totp(&write, &account)?;
                    }
                    let bytes = encode(&account)?;
                    accounts.insert(id, bytes.as_slice()).map_err(err)?;
                    Some(out)
                }
            }
        };
        write.commit().map_err(err)?;
        Ok(out)
    }

    pub fn put_setup_link(
        &self,
        token_hash: [u8; 32],
        account: &str,
        expires: u64,
    ) -> Result<(), StoreError> {
        let row = serde_json::to_vec(&SetupRow {
            account: account.to_owned(),
            expires,
        })
        .map_err(err)?;
        let write = self.db.begin_write().map_err(err)?;
        {
            let mut links = write.open_table(SETUP_LINKS).map_err(err)?;
            // A new link for an account replaces its older ones.
            let mut older = Vec::new();
            for entry in links.iter().map_err(err)? {
                let (key, value) = entry.map_err(err)?;
                if let Ok(existing) = serde_json::from_slice::<SetupRow>(value.value())
                    && existing.account == account
                {
                    older.push(key.value().to_vec());
                }
            }
            for key in older {
                links.remove(key.as_slice()).map_err(err)?;
            }
            links
                .insert(token_hash.as_slice(), row.as_slice())
                .map_err(err)?;
        }
        write.commit().map_err(err)
    }

    /// The account of a live setup link; with `take`, the link is removed (whether live or
    /// expired) in the same transaction.
    pub fn setup_link(
        &self,
        token_hash: [u8; 32],
        now: u64,
        take: bool,
    ) -> Result<Option<String>, StoreError> {
        let live = |bytes: &[u8]| {
            serde_json::from_slice::<SetupRow>(bytes)
                .ok()
                .filter(|row| now < row.expires)
                .map(|row| row.account)
        };
        if !take {
            let read = self.db.begin_read().map_err(err)?;
            let links = read.open_table(SETUP_LINKS).map_err(err)?;
            return Ok(links
                .get(token_hash.as_slice())
                .map_err(err)?
                .and_then(|v| live(v.value())));
        }
        let write = self.db.begin_write().map_err(err)?;
        let found = {
            let mut links = write.open_table(SETUP_LINKS).map_err(err)?;
            let removed = links.remove(token_hash.as_slice()).map_err(err)?;
            removed.and_then(|v| live(v.value()))
        };
        write.commit().map_err(err)?;
        Ok(found)
    }

    /// Setup links held (expired ones included).
    pub fn setup_links(&self) -> Result<usize, StoreError> {
        let read = self.db.begin_read().map_err(err)?;
        let links = read.open_table(SETUP_LINKS).map_err(err)?;
        Ok(links.len().map_err(err)? as usize)
    }
}

fn copy_table<K, V>(
    read: &redb::ReadTransaction,
    write: &redb::WriteTransaction,
    table: TableDefinition<K, V>,
) -> Result<(), StoreError>
where
    K: redb::Key + 'static,
    V: redb::Value + 'static,
    for<'a> K::SelfType<'a>: std::borrow::Borrow<K::SelfType<'a>>,
    for<'a> V::SelfType<'a>: std::borrow::Borrow<V::SelfType<'a>>,
{
    let from = match read.open_table(table) {
        Ok(from) => from,
        Err(redb::TableError::TableDoesNotExist(_)) => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    let mut to = write.open_table(table).map_err(err)?;
    for row in from.iter().map_err(err)? {
        let (k, v) = row.map_err(err)?;
        to.insert(k.value(), v.value()).map_err(err)?;
    }
    Ok(())
}

impl Store {
    /// The tables a snapshot copies: every table the store has (a test checks that none is
    /// missing).
    pub const TABLES: [&'static str; 12] = [
        "meta",
        "accounts",
        "usernames",
        "setup_links",
        "users",
        "roles",
        "assignments",
        "group_roles",
        "groups",
        "secrets",
        "profiles",
        "imports",
    ];

    /// Writes a consistent copy of the store to a new file `to` (DOC-25 §3.4.6): a new redb file
    /// filled from one read transaction, mode 0600. Refuses a table this build does not know,
    /// so nothing is left out silently.
    pub fn snapshot_to(&self, to: &Path) -> Result<(), StoreError> {
        use redb::TableHandle as _;
        let read = self.db.begin_read().map_err(err)?;
        for table in read.list_tables().map_err(err)? {
            if !Store::TABLES.contains(&table.name()) {
                return Err(err(format!(
                    "the store has a table {:?} a snapshot does not know",
                    table.name()
                )));
            }
        }
        let copy = redb::Builder::new().create(to).map_err(err)?;
        restrict(to, true).map_err(err)?;
        let write = copy.begin_write().map_err(err)?;
        copy_table(&read, &write, META)?;
        copy_table(&read, &write, ACCOUNTS)?;
        copy_table(&read, &write, USERNAMES)?;
        copy_table(&read, &write, SETUP_LINKS)?;
        copy_table(&read, &write, USERS)?;
        copy_table(&read, &write, ROLES)?;
        copy_table(&read, &write, ASSIGNMENTS)?;
        copy_table(&read, &write, GROUP_ROLES)?;
        copy_table(&read, &write, GROUPS)?;
        copy_table(&read, &write, crate::secrets::table::SECRETS)?;
        copy_table(&read, &write, crate::profiles::table::PROFILES)?;
        copy_table(&read, &write, crate::profiles::table::IMPORTS)?;
        write.commit().map_err(err)
    }
}

/// Mode 0600 on Unix. A file that already existed keeps its content but has its mode put right.
fn restrict(path: &Path, _created: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// [`AccountStore`] on the server's [`Store`], each operation on the blocking pool.
#[derive(Clone)]
pub struct McAccountStore(pub Arc<Store>);

impl McAccountStore {
    fn run<'a, T: Send + 'static>(
        &'a self,
        work: impl FnOnce(&Store) -> T + Send + 'static,
    ) -> BoxFuture<'a, Result<T, StoreError>> {
        let store = Arc::clone(&self.0);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || work(&store))
                .await
                .map_err(|e| err(format!("the store task failed: {e}")))
        })
    }
}

impl AccountStore for McAccountStore {
    fn create<'a>(&'a self, account: Account) -> BoxFuture<'a, Result<(), CreateError>> {
        let run = self.run(move |s| s.create_account(&account));
        Box::pin(async move { run.await.map_err(CreateError::Store)? })
    }

    fn by_username<'a>(
        &'a self,
        username: &'a str,
    ) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        let username = username.to_owned();
        let run = self.run(move |s| s.account_by_username(&username));
        Box::pin(async move { run.await? })
    }

    fn by_id<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<Option<Account>, StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| s.account(&id));
        Box::pin(async move { run.await? })
    }

    fn set_password<'a>(
        &'a self,
        id: &'a str,
        hash: String,
        must_change: bool,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| {
            s.update_account(&id, |a| {
                a.password_hash = Some(hash);
                a.must_change_password = must_change;
            })
        });
        Box::pin(async move { Ok(run.await??.is_some()) })
    }

    fn set_locked_until<'a>(
        &'a self,
        id: &'a str,
        until_ms: Option<u64>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| s.update_account(&id, |a| a.locked_until_ms = until_ms));
        Box::pin(async move { run.await?.map(|_| ()) })
    }

    fn set_last_seen<'a>(
        &'a self,
        id: &'a str,
        at_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| s.update_account(&id, |a| a.last_seen_ms = Some(at_ms)));
        Box::pin(async move { run.await?.map(|_| ()) })
    }

    fn put_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        account_id: &'a str,
        expires_ms: u64,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        let account = account_id.to_owned();
        let run = self.run(move |s| s.put_setup_link(token_hash, &account, expires_ms));
        Box::pin(async move { run.await? })
    }

    fn peek_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        let run = self.run(move |s| s.setup_link(token_hash, now_ms, false));
        Box::pin(async move { run.await? })
    }

    fn take_setup_token<'a>(
        &'a self,
        token_hash: [u8; 32],
        now_ms: u64,
    ) -> BoxFuture<'a, Result<Option<String>, StoreError>> {
        let run = self.run(move |s| s.setup_link(token_hash, now_ms, true));
        Box::pin(async move { run.await? })
    }

    fn set_totp<'a>(
        &'a self,
        id: &'a str,
        totp: Option<TotpRecord>,
        recovery_codes: Vec<String>,
    ) -> BoxFuture<'a, Result<(), StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| {
            s.update_account(&id, |a| {
                a.totp = totp;
                a.recovery_codes = recovery_codes;
            })
        });
        Box::pin(async move { run.await?.map(|_| ()) })
    }

    fn advance_totp_step<'a>(
        &'a self,
        id: &'a str,
        step: u64,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let id = id.to_owned();
        let run = self.run(move |s| {
            s.update_account(&id, |a| match a.totp.as_mut() {
                Some(totp) if step > totp.last_step => {
                    totp.last_step = step;
                    true
                }
                _ => false,
            })
        });
        Box::pin(async move { Ok(run.await??.unwrap_or(false)) })
    }

    fn remove_recovery_code<'a>(
        &'a self,
        id: &'a str,
        hash: &'a str,
    ) -> BoxFuture<'a, Result<bool, StoreError>> {
        let id = id.to_owned();
        let hash = hash.to_owned();
        let run = self.run(move |s| {
            s.update_account(&id, |a| {
                let before = a.recovery_codes.len();
                a.recovery_codes.retain(|h| *h != hash);
                a.recovery_codes.len() < before
            })
        });
        Box::pin(async move { Ok(run.await??.unwrap_or(false)) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_totp_key_is_a_stored_secret_not_part_of_the_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_for_tests(dir.path());
        store.create_account(&account("01A", "mia")).unwrap();
        let row = {
            let read = store.db.begin_read().unwrap();
            let accounts = read.open_table(ACCOUNTS).unwrap();
            String::from_utf8(accounts.get("01A").unwrap().unwrap().value().to_vec()).unwrap()
        };
        assert!(!row.contains("\"key\""), "{row}");
        let owner = totp_owner("01A");
        let entry = store.secret_entry(&owner, TOTP_FIELD).unwrap().unwrap();
        assert_eq!((entry.version, entry.size), (1, 3));
        assert_eq!(
            store
                .account("01A")
                .unwrap()
                .unwrap()
                .totp
                .unwrap()
                .key
                .to_vec(),
            [1, 2, 0xff]
        );
        // A sign-in moves last_step: the key does not get a new version.
        store
            .update_account("01A", |a| a.totp.as_mut().unwrap().last_step = 99)
            .unwrap();
        assert_eq!(
            store
                .secret_entry(&owner, TOTP_FIELD)
                .unwrap()
                .unwrap()
                .version,
            1
        );
        // A new key does.
        store
            .update_account("01A", |a| {
                a.totp.as_mut().unwrap().key = Zeroizing::new(vec![9])
            })
            .unwrap();
        assert_eq!(
            store
                .secret_entry(&owner, TOTP_FIELD)
                .unwrap()
                .unwrap()
                .version,
            2
        );
        // Removing TOTP, or the account, removes the entry.
        store.update_account("01A", |a| a.totp = None).unwrap();
        assert!(store.secret_entry(&owner, TOTP_FIELD).unwrap().is_none());
        store
            .update_account("01A", |a| {
                a.totp = Some(TotpRecord {
                    key: Zeroizing::new(vec![4]),
                    last_step: 0,
                    enrolled_ms: 0,
                })
            })
            .unwrap();
        assert!(store.delete_account("01A").unwrap());
        assert!(store.secret_entry(&owner, TOTP_FIELD).unwrap().is_none());
        // Without the keys an account with TOTP cannot be read.
        store.create_account(&account("01B", "noor")).unwrap();
        drop(store);
        let bare = Store::open(dir.path()).unwrap();
        let e = bare.account("01B").unwrap_err();
        assert!(e.0.contains("secret keys are not loaded"), "{e}");
        assert!(bare.account_by_username("nobody").unwrap().is_none());
    }

    #[test]
    fn keys_of_rows_written_before_the_move_are_migrated() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_for_tests(dir.path());
        // A row as TSK-142 wrote it: the key in hex inside the row.
        let mut legacy = AccountRow::from_account(&account("01A", "mia"));
        legacy.totp.as_mut().unwrap().key = Some(hex(&[1, 2, 0xff]));
        {
            let write = store.db.begin_write().unwrap();
            write
                .open_table(ACCOUNTS)
                .unwrap()
                .insert("01A", serde_json::to_vec(&legacy).unwrap().as_slice())
                .unwrap();
            write
                .open_table(USERNAMES)
                .unwrap()
                .insert("mia", "01A")
                .unwrap();
            write.commit().unwrap();
        }
        assert_eq!(
            store
                .account("01A")
                .unwrap()
                .unwrap()
                .totp
                .unwrap()
                .key
                .to_vec(),
            [1, 2, 0xff]
        );
        assert_eq!(store.migrate_totp_keys().unwrap(), 1);
        assert_eq!(store.migrate_totp_keys().unwrap(), 0);
        assert!(
            store
                .secret_entry(&totp_owner("01A"), TOTP_FIELD)
                .unwrap()
                .is_some()
        );
        assert_eq!(
            store
                .account("01A")
                .unwrap()
                .unwrap()
                .totp
                .unwrap()
                .key
                .to_vec(),
            [1, 2, 0xff]
        );
    }

    fn account(id: &str, username: &str) -> Account {
        Account {
            id: id.into(),
            username: username.into(),
            display_name: username.into(),
            password_hash: Some("$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaA".into()),
            must_change_password: true,
            created_by: CreatedBy::Administrator("human:account:01A".into()),
            created_ms: 1,
            last_seen_ms: None,
            disabled: false,
            locked_until_ms: None,
            totp: Some(TotpRecord {
                key: Zeroizing::new(vec![1, 2, 0xff]),
                last_step: 7,
                enrolled_ms: 2,
            }),
            recovery_codes: vec!["$argon2id$x".into()],
        }
    }

    #[test]
    fn accounts_round_trip_and_names_stay_unique() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_for_tests(dir.path());
        let a = account("01A", "alice");
        store.create_account(&a).unwrap();
        assert_eq!(store.account("01A").unwrap(), Some(a.clone()));
        assert_eq!(store.account_by_username("alice").unwrap(), Some(a.clone()));
        assert_eq!(
            store.create_account(&account("01B", "alice")),
            Err(CreateError::UsernameTaken)
        );
        assert_eq!(
            store.create_account(&account("01A", "bob")),
            Err(CreateError::UsernameTaken)
        );
        let changed = store
            .update_account("01A", |a| {
                a.disabled = true;
                a.username = "mallory".into();
            })
            .unwrap();
        assert_eq!(changed, Some(()));
        let back = store.account("01A").unwrap().unwrap();
        assert!(back.disabled);
        assert_eq!(
            back.username, "alice",
            "the name cannot change through an update"
        );
        assert_eq!(store.update_account("nope", |_| ()).unwrap(), None);
        assert_eq!(store.accounts().unwrap().len(), 1);
    }

    #[test]
    fn the_file_is_private_reopens_and_is_locked_while_open() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_for_tests(dir.path());
        store.create_account(&account("01A", "alice")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(store.path()).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        drop(store);
        let store = Store::open_for_tests(dir.path());
        assert!(store.account("01A").unwrap().is_some());
        // A second process (here: a second open) is refused while it is open.
        assert!(matches!(Store::open(dir.path()), Err(OpenError::Locked(_))));
    }

    #[test]
    fn roles_assignments_groups_and_users_make_the_policy() {
        use crate::authz::policy::Policy;
        use security_types::{Scope, ScopeEntry};
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open_for_tests(dir.path());
        // OIDC users: made at the first sign-in, kept disabled, updated after.
        let u = store
            .record_oidc_user(
                "human:oidc:bob",
                "bob",
                "Bob",
                Some("b@x"),
                &["ops".into()],
                10,
            )
            .unwrap();
        assert_eq!(
            (u.first_seen_ms, u.last_seen_ms, u.disabled),
            (10, 10, false)
        );
        store
            .update_oidc_user("human:oidc:bob", |u| u.disabled = true)
            .unwrap()
            .unwrap();
        let u = store
            .record_oidc_user("human:oidc:bob", "bob", "Robert", None, &[], 20)
            .unwrap();
        assert_eq!(
            (u.first_seen_ms, u.last_seen_ms, u.disabled),
            (10, 20, true)
        );
        assert_eq!(u.display_name, "Robert");
        assert_eq!(store.oidc_users().unwrap().len(), 1);
        assert!(
            store
                .update_oidc_user("human:oidc:none", |_| ())
                .unwrap()
                .is_none()
        );
        // A disabled account counts too.
        let mut a = account("01A", "alice");
        a.disabled = true;
        store.create_account(&a).unwrap();

        store
            .put_role(&CustomRole {
                id: "deployer".into(),
                name: "Deployer".into(),
                description: "d".into(),
                permissions: ["temporal.write".to_owned()].into(),
            })
            .unwrap();
        let scoped = Scope::only(vec!["profile:P/ns:a".parse::<ScopeEntry>().unwrap()]);
        store
            .set_assignments(
                "human:account:01B",
                &[Assignment {
                    role: "deployer".into(),
                    scope: scoped.clone(),
                }],
            )
            .unwrap();
        let mapping = GroupMapping {
            group: "local:team".into(),
            role: "viewer".into(),
            scope: Scope::everywhere(),
        };
        assert_eq!(
            store
                .set_mappings(0, std::slice::from_ref(&mapping))
                .unwrap(),
            Some(1)
        );
        assert_eq!(store.set_mappings(0, &[]).unwrap(), None, "a stale etag");
        assert_eq!(
            store.mappings().unwrap().mappings,
            std::slice::from_ref(&mapping)
        );
        store
            .put_group("team", &["human:account:01B".to_owned()].into())
            .unwrap();

        let parts = store.policy_parts().unwrap();
        assert_eq!(parts.custom_roles.len(), 1);
        assert_eq!(parts.direct["human:account:01B"][0].scope, scoped);
        assert_eq!(parts.mappings, [mapping]);
        assert!(parts.local_groups["team"].contains("human:account:01B"));
        assert_eq!(
            parts.disabled,
            ["human:oidc:bob".to_owned(), "human:account:01A".to_owned()].into()
        );
        let policy = Policy::new(parts);
        assert_eq!(
            policy.role_ids("human:account:01B", &[]),
            ["deployer", "viewer"]
        );

        // Removing is durable across a reopen.
        store.set_assignments("human:account:01B", &[]).unwrap();
        assert!(store.delete_role("deployer").unwrap());
        assert!(!store.delete_role("deployer").unwrap());
        assert!(store.delete_group("team").unwrap());
        drop(store);
        let store = Store::open_for_tests(dir.path());
        let parts = store.policy_parts().unwrap();
        assert!(parts.custom_roles.is_empty() && parts.direct.is_empty());
        assert!(parts.local_groups.is_empty());
    }

    #[test]
    fn an_unknown_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        {
            let store = Store::open_for_tests(dir.path());
            let write = store.db.begin_write().unwrap();
            write
                .open_table(META)
                .unwrap()
                .insert("schema", "99")
                .unwrap();
            write.commit().unwrap();
        }
        let e = Store::open(dir.path()).unwrap_err();
        assert!(matches!(e, OpenError::Schema { .. }), "{e}");
        assert!(e.to_string().contains("\"99\""));
    }

    #[tokio::test]
    async fn the_account_store_contract() {
        let dir = tempfile::tempdir().unwrap();
        let store = McAccountStore(Arc::new(Store::open_for_tests(dir.path())));
        store.create(account("01A", "alice")).await.unwrap();
        assert!(store.by_username("alice").await.unwrap().is_some());
        assert!(store.by_username("bob").await.unwrap().is_none());
        assert!(
            store
                .set_password("01A", "$argon2id$new".into(), false)
                .await
                .unwrap()
        );
        assert!(!store.set_password("nope", "x".into(), false).await.unwrap());
        let a = store.by_id("01A").await.unwrap().unwrap();
        assert_eq!(a.password_hash.as_deref(), Some("$argon2id$new"));
        assert!(!a.must_change_password);

        // A step works once; an older one never.
        assert!(store.advance_totp_step("01A", 8).await.unwrap());
        assert!(!store.advance_totp_step("01A", 8).await.unwrap());
        assert!(!store.advance_totp_step("01A", 3).await.unwrap());
        assert!(
            store
                .remove_recovery_code("01A", "$argon2id$x")
                .await
                .unwrap()
        );
        assert!(
            !store
                .remove_recovery_code("01A", "$argon2id$x")
                .await
                .unwrap()
        );
        store.set_totp("01A", None, vec![]).await.unwrap();
        assert!(!store.advance_totp_step("01A", 9).await.unwrap());

        store.put_setup_token([1; 32], "01A", 100).await.unwrap();
        store.put_setup_token([2; 32], "01A", 100).await.unwrap();
        assert_eq!(
            store.0.setup_links().unwrap(),
            1,
            "a new link replaces the old"
        );
        assert_eq!(
            store
                .peek_setup_token([2; 32], 99)
                .await
                .unwrap()
                .as_deref(),
            Some("01A")
        );
        assert_eq!(store.peek_setup_token([2; 32], 100).await.unwrap(), None);
        assert_eq!(
            store
                .take_setup_token([2; 32], 50)
                .await
                .unwrap()
                .as_deref(),
            Some("01A")
        );
        assert_eq!(store.take_setup_token([2; 32], 50).await.unwrap(), None);
    }
}
