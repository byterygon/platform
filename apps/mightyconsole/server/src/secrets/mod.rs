//! The secret store (DOC-25 §3.4): secrets of profiles, routes and accounts, encrypted in
//! `DATA/store.redb` and never returned.
//!
//! - [`crypto`]: the envelope (a data key per version of each secret, AES-256-GCM, wrapped by
//!   the key-encryption key, bound to tenant, owner, field and version).
//! - [`keys`]: where the key-encryption keys come from (`[[secrets.keys]]`: a file, a
//!   passphrase or a command) and the generated key of a first start.
//! - [`Vault`]: set, read, remove and list entries with the loaded keys.
//!
//! A value lives in memory in a [`Secret`], which zeroizes on drop and implements neither
//! `Debug`, `Display`, `Clone` nor `Serialize`. Errors ([`SecretError`]) name owners, fields
//! and key ids, never values.

pub mod api;
pub mod crypto;
pub mod keys;
pub mod service;
pub mod table;

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, RwLock};

use serde::Serialize;
use zeroize::Zeroizing;

use crate::store::Store;
use crypto::{Binding, CryptoError};
use keys::Keyring;
pub use table::SecretEntry;

/// The largest value of a `kubeconfig` (§3.4.1).
pub const KUBECONFIG_MAX: usize = 1 << 20;
/// The largest value of any other secret.
pub const SECRET_MAX: usize = 64 << 10;
/// At most this many DEKs are wrapped under one KEK (§3.4.3); then the store refuses until the
/// key is rotated.
pub const MAX_WRAPS_PER_KEK: u64 = 1 << 30;

/// A secret value in memory: zeroized on drop; no `Debug`, `Display`, `Clone` or `Serialize`.
pub struct Secret(Zeroizing<Vec<u8>>);

impl Secret {
    pub fn new(value: impl Into<Vec<u8>>) -> Secret {
        Secret(Zeroizing::new(value.into()))
    }

    pub fn from_vec(value: Vec<u8>) -> Secret {
        Secret(Zeroizing::new(value))
    }

    /// The bytes, for handing to a tool's client.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// The value as text, when it is UTF-8.
    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// What a secret belongs to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum OwnerKind {
    Profile,
    Route,
    /// A built-in account's TOTP key (§3.2.6).
    Account,
    /// A saved SSH host's key, passphrase or password (DOC-23 §4.3, §8.1).
    SshHost,
    /// A saved proxy's password (DOC-23 (ac)).
    Proxy,
    /// A link's secret command variables (DOC-23 (aa)).
    Link,
}

impl OwnerKind {
    pub fn as_str(self) -> &'static str {
        match self {
            OwnerKind::Profile => "profile",
            OwnerKind::Route => "route",
            OwnerKind::Account => "account",
            OwnerKind::SshHost => "sshHost",
            OwnerKind::Proxy => "proxy",
            OwnerKind::Link => "link",
        }
    }

    pub fn parse(text: &str) -> Option<OwnerKind> {
        match text {
            "profile" => Some(OwnerKind::Profile),
            "route" => Some(OwnerKind::Route),
            "account" => Some(OwnerKind::Account),
            "sshHost" => Some(OwnerKind::SshHost),
            "proxy" => Some(OwnerKind::Proxy),
            "link" => Some(OwnerKind::Link),
            _ => None,
        }
    }
}

/// A secret's owner: a profile, a route or an account, by id.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Owner {
    pub kind: OwnerKind,
    pub id: String,
}

impl Owner {
    pub fn new(kind: OwnerKind, id: impl Into<String>) -> Owner {
        Owner {
            kind,
            id: id.into(),
        }
    }

    pub fn profile(id: impl Into<String>) -> Owner {
        Owner::new(OwnerKind::Profile, id)
    }

    pub fn ssh_host(id: impl Into<String>) -> Owner {
        Owner::new(OwnerKind::SshHost, id)
    }

    pub fn proxy(id: impl Into<String>) -> Owner {
        Owner::new(OwnerKind::Proxy, id)
    }

    pub fn link(id: impl Into<String>) -> Owner {
        Owner::new(OwnerKind::Link, id)
    }
}

impl fmt::Display for Owner {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} {}", self.kind.as_str(), self.id)
    }
}

/// A secret's status: everything but its value (§3.4.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub field: String,
    pub version: u64,
    /// The principal who set it.
    pub set_by: String,
    /// Unix milliseconds.
    pub set_at: u64,
    /// Bytes of the value.
    pub size: u64,
    /// The key its data key is wrapped under.
    pub kek_id: String,
}

/// Why a secret operation failed. Names owners, fields and key ids, never values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// The value is over its size limit.
    TooLarge { field: String, limit: usize },
    /// An empty value (remove it instead).
    Empty { field: String },
    /// The entry's key is not loaded.
    KeyNotLoaded { kek_id: String },
    /// The active key wrapped [`MAX_WRAPS_PER_KEK`] data keys: rotate it.
    KeyExhausted { kek_id: String },
    /// The entry does not decrypt.
    Damaged { owner: String, field: String },
    /// The store failed, or the random generator.
    Store(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecretError::TooLarge { field, limit } => {
                write!(f, "secret {field} is larger than {limit} bytes")
            }
            SecretError::Empty { field } => {
                write!(f, "secret {field} is empty (remove it instead)")
            }
            SecretError::KeyNotLoaded { kek_id } => {
                write!(f, "the key {kek_id} of this secret is not loaded")
            }
            SecretError::KeyExhausted { kek_id } => write!(
                f,
                "the key {kek_id} has wrapped {MAX_WRAPS_PER_KEK} data keys: rotate it (add a new \
                 key first in [[secrets.keys]])"
            ),
            SecretError::Damaged { owner, field } => write!(
                f,
                "secret {field} of {owner} does not decrypt (changed bytes, or an entry moved \
                 from elsewhere)"
            ),
            SecretError::Store(e) => write!(f, "secret store: {e}"),
        }
    }
}

impl std::error::Error for SecretError {}

/// The size limit of a field (§3.4.1).
pub fn size_limit(field: &str) -> usize {
    if field == "kubeconfig" {
        KUBECONFIG_MAX
    } else {
        SECRET_MAX
    }
}

pub(crate) fn binding<'a>(
    tenant: &'a str,
    owner: &'a Owner,
    field: &'a str,
    version: u64,
) -> Binding<'a> {
    Binding {
        tenant,
        owner_kind: owner.kind.as_str(),
        owner_id: &owner.id,
        field,
        version,
    }
}

/// The store's secrets with the loaded keys. The keyring can be swapped (a reload) while the
/// server runs.
pub struct Vault {
    keyring: RwLock<Arc<Keyring>>,
    tenant: String,
}

impl fmt::Debug for Vault {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Vault")
            .field("keys", &self.keyring().ids())
            .field("tenant", &self.tenant)
            .finish()
    }
}

impl Vault {
    pub fn new(keyring: Keyring, tenant: impl Into<String>) -> Vault {
        Vault {
            keyring: RwLock::new(Arc::new(keyring)),
            tenant: tenant.into(),
        }
    }

    /// The keys in force.
    pub fn keyring(&self) -> Arc<Keyring> {
        Arc::clone(&self.keyring.read().unwrap_or_else(|e| e.into_inner()))
    }

    /// Replaces the keys (a reload of `[secrets]`).
    pub fn replace_keyring(&self, keyring: Keyring) {
        *self.keyring.write().unwrap_or_else(|e| e.into_inner()) = Arc::new(keyring);
    }

    pub fn tenant(&self) -> &str {
        &self.tenant
    }

    /// Sets a secret: version n+1 under a new data key wrapped by the active key, replacing
    /// version n in the same transaction.
    pub fn set(
        &self,
        store: &Store,
        owner: &Owner,
        field: &str,
        value: &Secret,
        set_by: &str,
        set_at: u64,
    ) -> Result<SecretStatus, SecretError> {
        if value.is_empty() {
            return Err(SecretError::Empty {
                field: field.to_owned(),
            });
        }
        let limit = size_limit(field);
        if value.len() > limit {
            return Err(SecretError::TooLarge {
                field: field.to_owned(),
                limit,
            });
        }
        let keyring = self.keyring();
        let entry = store.put_secret(
            owner,
            field,
            keyring.active().id(),
            MAX_WRAPS_PER_KEK,
            |version| self.seal_entry(&keyring, owner, field, version, value, set_by, set_at),
        )?;
        Ok(entry.status())
    }

    /// An entry for `value`, sealed under the active key of `keyring` for `version`.
    #[allow(clippy::too_many_arguments, reason = "the entry's every part")]
    pub(crate) fn seal_entry(
        &self,
        keyring: &Keyring,
        owner: &Owner,
        field: &str,
        version: u64,
        value: &Secret,
        set_by: &str,
        set_at: u64,
    ) -> Result<SecretEntry, SecretError> {
        let sealed = crypto::seal(
            keyring.active(),
            &binding(&self.tenant, owner, field, version),
            value.expose(),
        )
        .map_err(|e| SecretError::Store(e.to_string()))?;
        Ok(SecretEntry::new(
            owner,
            field,
            version,
            sealed,
            set_by,
            set_at,
            value.len(),
        ))
    }

    /// A secret's value, `None` when it is not set.
    pub fn get(
        &self,
        store: &Store,
        owner: &Owner,
        field: &str,
    ) -> Result<Option<Secret>, SecretError> {
        let Some(entry) = store.secret_entry(owner, field)? else {
            return Ok(None);
        };
        self.open(&entry).map(Some)
    }

    /// Decrypts an entry read from the store.
    pub fn open(&self, entry: &SecretEntry) -> Result<Secret, SecretError> {
        let keyring = self.keyring();
        let kek = keyring
            .get(&entry.kek_id)
            .ok_or_else(|| SecretError::KeyNotLoaded {
                kek_id: entry.kek_id.clone(),
            })?;
        let owner = entry.owner();
        let sealed = entry.sealed().ok_or_else(|| SecretError::Damaged {
            owner: owner.to_string(),
            field: entry.field.clone(),
        })?;
        crypto::open(
            kek,
            &binding(&self.tenant, &owner, &entry.field, entry.version),
            &sealed,
        )
        .map_err(|e| match e {
            CryptoError::Decrypt => SecretError::Damaged {
                owner: owner.to_string(),
                field: entry.field.clone(),
            },
            other => SecretError::Store(other.to_string()),
        })
    }

    /// Removes a secret; `false` when it was not set.
    pub fn remove(&self, store: &Store, owner: &Owner, field: &str) -> Result<bool, SecretError> {
        store.remove_secret(owner, field)
    }

    /// The status of every secret of `owner`, by field.
    pub fn status(&self, store: &Store, owner: &Owner) -> Result<Vec<SecretStatus>, SecretError> {
        Ok(store
            .secret_entries(Some(owner))?
            .iter()
            .map(SecretEntry::status)
            .collect())
    }

    /// Decrypts every entry and lists those that fail, by owner and field (never values): what
    /// `restore --check-secrets` reports.
    pub fn check_all(&self, store: &Store) -> Result<Vec<(String, String, String)>, SecretError> {
        let mut failures = Vec::new();
        for entry in store.secret_entries(None)? {
            if let Err(e) = self.open(&entry) {
                failures.push((
                    entry.owner().to_string(),
                    entry.field.clone(),
                    e.to_string(),
                ));
            }
        }
        Ok(failures)
    }
}

/// The entries per key id: what the start checks against the loaded keys and `secrets status`
/// shows.
pub fn entries_by_key(store: &Store) -> Result<BTreeMap<String, u64>, SecretError> {
    let mut out = BTreeMap::new();
    for entry in store.secret_entries(None)? {
        *out.entry(entry.kek_id.clone()).or_insert(0) += 1;
    }
    Ok(out)
}

/// What `secrets status` prints (server stopped): the stored secrets by key, which configured
/// key files those are, and how many data keys each key has wrapped. Loads no key, so it asks
/// for no passphrase and runs no command.
pub fn status_report(
    store: &Store,
    data: &std::path::Path,
    settings: &keys::SecretsSettings,
) -> Result<Vec<String>, SecretError> {
    let by_key = entries_by_key(store)?;
    let wraps: BTreeMap<String, u64> = store.wraps_by_key()?.into_iter().collect();
    let total: u64 = by_key.values().sum();
    let mut lines = vec![format!(
        "{total} secret entr{} in {}",
        if total == 1 { "y" } else { "ies" },
        store.path().display()
    )];
    // The ids of key files that can be read without a passphrase or a command.
    let mut named: BTreeMap<String, String> = BTreeMap::new();
    let files: Vec<std::path::PathBuf> = if settings.keys.is_empty() {
        std::fs::read_dir(keys::keys_dir(data))
            .map(|dir| {
                dir.filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| p.extension().is_some_and(|x| x == "key"))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        settings
            .keys
            .iter()
            .filter_map(|k| match k {
                keys::KeySource::File(path) => Some(path.clone()),
                _ => None,
            })
            .collect()
    };
    for path in files {
        if let Ok(kek) = keys::read_key_file(&path) {
            named.insert(kek.id().to_owned(), path.display().to_string());
        }
    }
    let ids: std::collections::BTreeSet<&String> = by_key.keys().chain(wraps.keys()).collect();
    for id in ids {
        lines.push(format!(
            "key {id}: {} entr{}, {} data key{} wrapped{}",
            by_key.get(id).copied().unwrap_or(0),
            if by_key.get(id) == Some(&1) {
                "y"
            } else {
                "ies"
            },
            wraps.get(id).copied().unwrap_or(0),
            if wraps.get(id) == Some(&1) { "" } else { "s" },
            named.get(id).map(|p| format!(" ({p})")).unwrap_or_default()
        ));
    }
    Ok(lines)
}

/// The audit checkpoint's info string for HKDF (DOC-25 §3.5.4).
pub const CHECKPOINT_INFO: &[u8] = b"mightyconsole.audit.checkpoint.v1";

/// The checkpoint keys of the audit log (DOC-25 §3.5.4): for each loaded KEK, active first,
/// HKDF-SHA-256 with the KEK as input key material, no salt and the info
/// [`CHECKPOINT_INFO`], named by the KEK's id.
pub fn checkpoint_keys(keyring: &Keyring) -> audit_jsonl::checkpoint::CheckpointKeys {
    use audit_jsonl::checkpoint::{CheckpointKey, CheckpointKeys};
    let keys = keyring
        .keks()
        .map(|kek| {
            let hk = hkdf::Hkdf::<sha2::Sha256>::new(None, kek.expose());
            let mut okm = Zeroizing::new([0u8; 32]);
            hk.expand(CHECKPOINT_INFO, &mut *okm)
                .expect("32 bytes is a valid HKDF-SHA-256 output length");
            CheckpointKey::new(kek.id(), okm)
        })
        .collect();
    CheckpointKeys::new(keys)
}

/// Turns core dumps off (`RLIMIT_CORE` 0, §3.4.3), so a crash does not write decrypted values to
/// disk. A no-op off Unix.
pub fn disable_core_dumps() -> Result<(), String> {
    #[cfg(unix)]
    {
        use rustix::process::{Resource, Rlimit, setrlimit};
        setrlimit(
            Resource::Core,
            Rlimit {
                current: Some(0),
                maximum: Some(0),
            },
        )
        .map_err(|e| format!("could not turn core dumps off (RLIMIT_CORE): {e}"))
    }
    #[cfg(not(unix))]
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crypto::Kek;

    fn open_store() -> (tempfile::TempDir, Store) {
        let data = tempfile::tempdir().unwrap();
        let store = Store::open(data.path()).unwrap();
        (data, store)
    }

    fn vault(keys: Vec<Kek>) -> Vault {
        Vault::new(Keyring::new(keys).unwrap(), "default")
    }

    #[test]
    fn set_get_replace_and_remove() {
        let (_data, store) = open_store();
        let vault = vault(vec![Kek::generate().unwrap()]);
        let owner = Owner::profile("p1");
        assert!(vault.get(&store, &owner, "password").unwrap().is_none());

        let first = vault
            .set(
                &store,
                &owner,
                "password",
                &Secret::new("one"),
                "human:account:a",
                10,
            )
            .unwrap();
        assert_eq!((first.version, first.size, first.set_at), (1, 3, 10));
        let second = vault
            .set(
                &store,
                &owner,
                "password",
                &Secret::new("two-2"),
                "human:account:b",
                20,
            )
            .unwrap();
        assert_eq!((second.version, second.size), (2, 5));
        assert_eq!(second.set_by, "human:account:b");
        let value = vault.get(&store, &owner, "password").unwrap().unwrap();
        assert_eq!(value.as_str(), Some("two-2"));
        // One row per secret: the older version is gone.
        assert_eq!(store.secret_entries(None).unwrap().len(), 1);

        vault
            .set(
                &store,
                &owner,
                "tls.clientKeyPem",
                &Secret::new("pem"),
                "x",
                30,
            )
            .unwrap();
        let other = Owner::profile("p10");
        vault
            .set(&store, &other, "token", &Secret::new("t"), "x", 40)
            .unwrap();
        let fields: Vec<String> = vault
            .status(&store, &owner)
            .unwrap()
            .into_iter()
            .map(|s| s.field)
            .collect();
        assert_eq!(fields, ["password", "tls.clientKeyPem"]);

        assert!(vault.remove(&store, &owner, "password").unwrap());
        assert!(!vault.remove(&store, &owner, "password").unwrap());
        assert!(vault.get(&store, &owner, "password").unwrap().is_none());
        assert_eq!(store.remove_owner_secrets(&owner).unwrap(), 1);
        assert_eq!(store.secret_entries(None).unwrap().len(), 1);
    }

    #[test]
    fn the_stored_row_holds_no_plaintext() {
        let (data, store) = open_store();
        let vault = vault(vec![Kek::generate().unwrap()]);
        let marker = "plaintext-marker-5a1e2b";
        vault
            .set(
                &store,
                &Owner::profile("p1"),
                "password",
                &Secret::new(marker),
                "x",
                1,
            )
            .unwrap();
        drop(store);
        let bytes = std::fs::read(data.path().join(crate::store::STORE_FILE)).unwrap();
        let found = bytes.windows(marker.len()).any(|w| w == marker.as_bytes());
        assert!(!found, "the value is in store.redb in clear");
    }

    #[test]
    fn a_row_copied_to_another_owner_or_field_does_not_decrypt() {
        let (_data, store) = open_store();
        let vault = vault(vec![Kek::generate().unwrap()]);
        let owner = Owner::profile("p1");
        vault
            .set(&store, &owner, "password", &Secret::new("v"), "x", 1)
            .unwrap();
        let entry = store.secret_entry(&owner, "password").unwrap().unwrap();
        for (owner_id, field) in [("p2", "password"), ("p1", "token")] {
            let moved = SecretEntry {
                owner_id: owner_id.into(),
                field: field.into(),
                ..entry.clone()
            };
            assert!(matches!(
                vault.open(&moved),
                Err(SecretError::Damaged { .. })
            ));
        }
        let older = SecretEntry {
            version: 2,
            ..entry.clone()
        };
        assert!(matches!(
            vault.open(&older),
            Err(SecretError::Damaged { .. })
        ));
        let other_tenant = Vault::new(vault_keyring_copy(&vault), "other");
        assert!(matches!(
            other_tenant.open(&entry),
            Err(SecretError::Damaged { .. })
        ));
    }

    fn vault_keyring_copy(vault: &Vault) -> Keyring {
        let key = Zeroizing::new(*vault.keyring().active().expose());
        Keyring::new(vec![Kek::from_bytes(key)]).unwrap()
    }

    #[test]
    fn a_vault_without_the_entrys_key_names_it() {
        let (_data, store) = open_store();
        let first = vault(vec![Kek::generate().unwrap()]);
        let owner = Owner::profile("p1");
        first
            .set(&store, &owner, "password", &Secret::new("v"), "x", 1)
            .unwrap();
        let id = first.keyring().active().id().to_owned();
        let other = vault(vec![Kek::generate().unwrap()]);
        assert_eq!(
            other.get(&store, &owner, "password").err(),
            Some(SecretError::KeyNotLoaded { kek_id: id.clone() })
        );
        assert_eq!(entries_by_key(&store).unwrap(), BTreeMap::from([(id, 1)]));
    }

    #[test]
    fn sizes_are_limited_and_empty_values_refused() {
        let (_data, store) = open_store();
        let vault = vault(vec![Kek::generate().unwrap()]);
        let owner = Owner::profile("p1");
        let big = Secret::new(vec![b'a'; SECRET_MAX + 1]);
        assert!(matches!(
            vault.set(&store, &owner, "password", &big, "x", 1),
            Err(SecretError::TooLarge { .. })
        ));
        vault
            .set(&store, &owner, "kubeconfig", &big, "x", 1)
            .unwrap();
        let huge = Secret::new(vec![b'a'; KUBECONFIG_MAX + 1]);
        assert!(
            vault
                .set(&store, &owner, "kubeconfig", &huge, "x", 1)
                .is_err()
        );
        assert!(matches!(
            vault.set(&store, &owner, "token", &Secret::new(""), "x", 1),
            Err(SecretError::Empty { .. })
        ));
    }

    #[test]
    fn a_key_stops_wrapping_at_its_limit() {
        let (_data, store) = open_store();
        let kek = Kek::generate().unwrap();
        let owner = Owner::profile("p1");
        let set = |n: u64| {
            store.put_secret(&owner, "password", kek.id(), 2, |version| {
                let sealed =
                    crypto::seal(&kek, &binding("default", &owner, "password", version), b"v")
                        .unwrap();
                Ok(SecretEntry::new(
                    &owner, "password", version, sealed, "x", n, 1,
                ))
            })
        };
        set(1).unwrap();
        set(2).unwrap();
        assert!(matches!(set(3), Err(SecretError::KeyExhausted { .. })));
        assert_eq!(store.wraps_by_key().unwrap(), [(kek.id().to_owned(), 2)]);
    }

    #[test]
    fn rewrapping_moves_an_entry_to_the_active_key() {
        let (_data, store) = open_store();
        let (old, new) = (Kek::generate().unwrap(), Kek::generate().unwrap());
        let new_id = new.id().to_owned();
        let before = vault(vec![old]);
        let owner = Owner::profile("p1");
        before
            .set(&store, &owner, "password", &Secret::new("v"), "x", 1)
            .unwrap();
        let old_key = Kek::from_bytes(Zeroizing::new(*before.keyring().active().expose()));
        let after = vault(vec![new, old_key]);
        let entry = store.secret_entry(&owner, "password").unwrap().unwrap();
        let keyring = after.keyring();
        let moved = store
            .rewrap_secret(
                &owner,
                "password",
                entry.version,
                &new_id,
                MAX_WRAPS_PER_KEK,
                |e| {
                    let sealed = crypto::rewrap(
                        keyring.get(&e.kek_id).unwrap(),
                        keyring.active(),
                        &binding("default", &owner, "password", e.version),
                        &e.sealed().unwrap(),
                    )
                    .unwrap();
                    Ok(e.with_sealed(sealed))
                },
            )
            .unwrap();
        assert!(moved);
        let entry = store.secret_entry(&owner, "password").unwrap().unwrap();
        assert_eq!(entry.kek_id, new_id);
        assert_eq!(
            after
                .get(&store, &owner, "password")
                .unwrap()
                .unwrap()
                .as_str(),
            Some("v")
        );
        // Already under the active key: nothing to do.
        let again = store
            .rewrap_secret(
                &owner,
                "password",
                entry.version,
                &new_id,
                MAX_WRAPS_PER_KEK,
                |_| unreachable!(),
            )
            .unwrap();
        assert!(!again);
    }
}
