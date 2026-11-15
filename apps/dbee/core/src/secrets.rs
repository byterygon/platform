//! Where passwords live (DBee spec §4, Decision 6, Open question 2).
//!
//! The durable store is the OS keychain through the `keyring` crate (service `dbee`, account =
//! the connection's secret reference), behind the [`SecretStore`] trait so tests supply an
//! in-memory one. Where no keychain exists (Linux without a Secret Service, or any platform
//! where the probe fails) the core **does not persist** passwords: it fails closed with
//! `SecretStoreUnavailable` at `connections.create`, and keeps a password given later through
//! `connections.setSecret` in [`SessionSecrets`], in memory only, zeroized when it is removed or
//! the process ends.
//!
//! Secret material is held in [`Secret`] (zeroized on drop, never printed) from the moment it is
//! decoded from the call input until the driver has used it.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex};

use security_types::BoxFuture;
use zeroize::Zeroizing;

/// A password in memory: zeroized on drop, `Debug` prints nothing of it.
#[derive(Clone)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(Zeroizing::new(value.into()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(..)")
    }
}

/// The store could not do what was asked. The message is display-safe (never the value).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretError(pub String);

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SecretError {}

/// A durable password store keyed by secret reference.
pub trait SecretStore: Send + Sync + 'static {
    fn set(&self, secret_ref: &str, value: Secret) -> BoxFuture<'_, Result<(), SecretError>>;
    /// `Ok(None)` when there is no entry.
    fn get(&self, secret_ref: &str) -> BoxFuture<'_, Result<Option<Secret>, SecretError>>;
    /// Removing a missing entry is not an error.
    fn delete(&self, secret_ref: &str) -> BoxFuture<'_, Result<(), SecretError>>;
}

/// An in-memory [`SecretStore`]: the keychain stand-in of tests, and the backing of
/// [`SessionSecrets`].
#[derive(Default)]
pub struct MemorySecretStore {
    entries: Mutex<HashMap<String, Secret>>,
}

impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn len(&self) -> usize {
        lock(&self.entries).len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Whether any stored value equals `needle`, for tests that check nothing leaked.
    pub fn contains_value(&self, needle: &str) -> bool {
        lock(&self.entries).values().any(|v| v.as_str() == needle)
    }
}

impl SecretStore for MemorySecretStore {
    fn set(&self, secret_ref: &str, value: Secret) -> BoxFuture<'_, Result<(), SecretError>> {
        lock(&self.entries).insert(secret_ref.to_owned(), value);
        Box::pin(std::future::ready(Ok(())))
    }

    fn get(&self, secret_ref: &str) -> BoxFuture<'_, Result<Option<Secret>, SecretError>> {
        let found = lock(&self.entries).get(secret_ref).cloned();
        Box::pin(std::future::ready(Ok(found)))
    }

    fn delete(&self, secret_ref: &str) -> BoxFuture<'_, Result<(), SecretError>> {
        lock(&self.entries).remove(secret_ref);
        Box::pin(std::future::ready(Ok(())))
    }
}

/// A store that fails every call, for tests of the fail-closed paths.
pub struct FailingSecretStore(pub String);

impl SecretStore for FailingSecretStore {
    fn set(&self, _: &str, _: Secret) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(std::future::ready(Err(SecretError(self.0.clone()))))
    }

    fn get(&self, _: &str) -> BoxFuture<'_, Result<Option<Secret>, SecretError>> {
        Box::pin(std::future::ready(Err(SecretError(self.0.clone()))))
    }

    fn delete(&self, _: &str) -> BoxFuture<'_, Result<(), SecretError>> {
        Box::pin(std::future::ready(Err(SecretError(self.0.clone()))))
    }
}

/// The OS keychain through `keyring` (feature `keychain`). Calls run on the blocking pool: the
/// Linux backend speaks D-Bus synchronously.
#[cfg(feature = "keychain")]
pub struct KeychainStore {
    service: String,
}

#[cfg(feature = "keychain")]
impl KeychainStore {
    /// The keychain service name entries are filed under.
    pub const SERVICE: &str = "dbee";

    /// Checks that the keychain works by writing, reading and removing a probe entry under a
    /// random reference. `Err` carries a display-safe reason (the keychain is then not used and
    /// the core runs session-only, DBee spec Open question 2).
    pub async fn probe() -> Result<KeychainStore, SecretError> {
        let store = KeychainStore {
            service: Self::SERVICE.to_owned(),
        };
        let probe_ref = format!("probe-{}", crate::random_id()?);
        let service = store.service.clone();
        let value = probe_ref.clone();
        run_blocking(move || {
            let entry = keyring::Entry::new(&service, &probe_ref).map_err(keyring_error)?;
            entry.set_password(&value).map_err(keyring_error)?;
            let back = entry.get_password().map_err(keyring_error)?;
            entry.delete_credential().map_err(keyring_error)?;
            if back != value {
                return Err(SecretError("the keychain returned another value".into()));
            }
            Ok(())
        })
        .await?;
        Ok(store)
    }
}

#[cfg(feature = "keychain")]
fn keyring_error(err: keyring::Error) -> SecretError {
    // keyring's messages name the platform problem (no Secret Service, locked keychain); they
    // never contain the value.
    SecretError(match err {
        keyring::Error::NoEntry => "no such entry".into(),
        keyring::Error::NoDefaultStore => "no keychain is available on this platform".into(),
        keyring::Error::NoStorageAccess(e) => format!("the keychain is not accessible: {e}"),
        keyring::Error::PlatformFailure(e) => format!("the keychain failed: {e}"),
        other => format!("keychain error: {other}"),
    })
}

#[cfg(feature = "keychain")]
async fn run_blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, SecretError> + Send + 'static,
) -> Result<T, SecretError> {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| Err(SecretError("the keychain call panicked".into())))
}

#[cfg(feature = "keychain")]
impl SecretStore for KeychainStore {
    fn set(&self, secret_ref: &str, value: Secret) -> BoxFuture<'_, Result<(), SecretError>> {
        let service = self.service.clone();
        let secret_ref = secret_ref.to_owned();
        Box::pin(run_blocking(move || {
            keyring::Entry::new(&service, &secret_ref)
                .and_then(|entry| entry.set_password(value.as_str()))
                .map_err(keyring_error)
        }))
    }

    fn get(&self, secret_ref: &str) -> BoxFuture<'_, Result<Option<Secret>, SecretError>> {
        let service = self.service.clone();
        let secret_ref = secret_ref.to_owned();
        Box::pin(run_blocking(move || {
            let entry = keyring::Entry::new(&service, &secret_ref).map_err(keyring_error)?;
            match entry.get_password() {
                Ok(value) => Ok(Some(Secret(Zeroizing::new(value)))),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(keyring_error(e)),
            }
        }))
    }

    fn delete(&self, secret_ref: &str) -> BoxFuture<'_, Result<(), SecretError>> {
        let service = self.service.clone();
        let secret_ref = secret_ref.to_owned();
        Box::pin(run_blocking(move || {
            let entry = keyring::Entry::new(&service, &secret_ref).map_err(keyring_error)?;
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(keyring_error(e)),
            }
        }))
    }
}

/// Passwords given for this process only, by connection id. Never written anywhere.
#[derive(Default)]
pub struct SessionSecrets {
    entries: Mutex<HashMap<String, Secret>>,
}

impl SessionSecrets {
    pub fn set(&self, connection_id: &str, value: Secret) {
        lock(&self.entries).insert(connection_id.to_owned(), value);
    }

    pub fn get(&self, connection_id: &str) -> Option<Secret> {
        lock(&self.entries).get(connection_id).cloned()
    }

    pub fn has(&self, connection_id: &str) -> bool {
        lock(&self.entries).contains_key(connection_id)
    }

    pub fn remove(&self, connection_id: &str) {
        lock(&self.entries).remove(connection_id);
    }
}

/// How the core stores passwords: a durable store, or none.
pub struct Secrets {
    /// The keychain (or a test stand-in); `None` means session-only.
    pub durable: Option<Arc<dyn SecretStore>>,
    /// Why there is no durable store, display-safe.
    pub unavailable_reason: Option<String>,
    pub session: SessionSecrets,
}

impl Secrets {
    pub fn durable(store: Arc<dyn SecretStore>) -> Secrets {
        Secrets {
            durable: Some(store),
            unavailable_reason: None,
            session: SessionSecrets::default(),
        }
    }

    pub fn session_only(reason: impl Into<String>) -> Secrets {
        Secrets {
            durable: None,
            unavailable_reason: Some(reason.into()),
            session: SessionSecrets::default(),
        }
    }

    pub fn kind(&self) -> crate::types::SecretStoreKind {
        if self.durable.is_some() {
            crate::types::SecretStoreKind::Keychain
        } else {
            crate::types::SecretStoreKind::SessionOnly
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}
