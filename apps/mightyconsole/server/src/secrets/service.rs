//! The running server's secret store: the [`Vault`] over the store, the re-wrap job of a key
//! rotation and the reload of `[secrets]` (DOC-25 §3.4.5).
//!
//! **Rotation.** The operator adds the new key first in `[[secrets.keys]]`, keeping the old one
//! after it, and reloads: on Unix `SIGHUP` makes the server re-read `[secrets]` only, load and
//! check the keys and switch the active key without stopping; elsewhere a restart does the same.
//! A reload whose keys do not open every stored entry is refused and the keys in force stay.
//! Then the re-wrap job moves every data key that is not under the active key: one entry per
//! transaction, skipping an entry set again meanwhile (it is already under the active key), so
//! it is idempotent and a restart resumes it (the start runs it when entries are left). Values
//! are not re-encrypted. It writes `secrets.rewrap` when it starts and when it ends. When no
//! entry uses the old key, the operator removes it from the configuration.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::Serialize;
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use ts_rs::TS;

use super::keys::{self, KeyError, SecretsSettings};
use super::{MAX_WRAPS_PER_KEK, SecretError, Vault, checkpoint_keys, crypto, entries_by_key};
use crate::audit::{Event, EventLog};
use crate::store::Store;

/// Where the re-wrap job is.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RewrapProgress {
    /// The job is moving entries now.
    pub running: bool,
    /// The key entries are moved to (the active key when the job last ran).
    pub to: Option<String>,
    /// Entries moved by the job's current or last run.
    pub done: u64,
    /// Entries the current or last run set out to move.
    pub total: u64,
    /// Why the last run stopped early, without values.
    pub error: Option<String>,
}

/// See the [module docs](self).
pub struct SecretService {
    pub store: Arc<Store>,
    pub vault: Arc<Vault>,
    data: PathBuf,
    events: EventLog,
    /// The durable audit log, whose checkpoint keys follow the keys in force.
    audit: Option<Arc<audit_jsonl::SegmentedSink>>,
    progress: Mutex<RewrapProgress>,
    wake: Notify,
    /// One reload or re-wrap pass at a time.
    turn: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for SecretService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretService")
            .field("vault", &self.vault)
            .finish()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl SecretService {
    pub fn new(
        store: Arc<Store>,
        vault: Arc<Vault>,
        data: PathBuf,
        events: EventLog,
        audit: Option<Arc<audit_jsonl::SegmentedSink>>,
    ) -> SecretService {
        SecretService {
            store,
            vault,
            data,
            events,
            audit,
            progress: Mutex::new(RewrapProgress::default()),
            wake: Notify::new(),
            turn: tokio::sync::Mutex::new(()),
        }
    }

    /// The re-wrap job's progress.
    pub fn progress(&self) -> RewrapProgress {
        lock(&self.progress).clone()
    }

    /// Re-reads the keys (`SIGHUP`): loads and checks them, then switches the active key and
    /// wakes the re-wrap job. Refused, with the keys in force kept, when a key does not load or
    /// a stored entry's key is not among them. Returns the warnings to print.
    pub async fn reload(&self, settings: &SecretsSettings) -> Result<Vec<String>, KeyError> {
        let _turn = self.turn.lock().await;
        let store = Arc::clone(&self.store);
        let entries = tokio::task::spawn_blocking(move || entries_by_key(&store))
            .await
            .map_err(|e| KeyError(format!("reading the store failed: {e}")))?
            .map_err(|e| KeyError(e.to_string()))?;
        let loaded = keys::load(&self.data, settings, &entries, false).await?;
        if let Some(audit) = &self.audit {
            audit.set_checkpoint_keys(Arc::new(checkpoint_keys(&loaded.keyring)));
        }
        self.vault.replace_keyring(loaded.keyring);
        self.wake.notify_one();
        Ok(loaded.warnings)
    }

    /// Starts the re-wrap job: a pass now (resuming one a restart cut short) and one after
    /// every reload.
    pub fn spawn_rewrap(self: &Arc<Self>) -> JoinHandle<()> {
        let service = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                if let Err(e) = service.rewrap_pending().await {
                    lock(&service.progress).error = Some(e.to_string());
                }
                service.wake.notified().await;
            }
        })
    }

    /// One pass of the re-wrap job: every entry not under the active key is moved to it, one
    /// per transaction. Returns how many were moved.
    pub async fn rewrap_pending(&self) -> Result<u64, SecretError> {
        let _turn = self.turn.lock().await;
        let keyring = self.vault.keyring();
        let active = keyring.active().id().to_owned();
        let store = Arc::clone(&self.store);
        let entries = tokio::task::spawn_blocking(move || store.secret_entries(None))
            .await
            .map_err(|e| SecretError::Store(format!("the store task failed: {e}")))??;
        let pending: Vec<_> = entries.into_iter().filter(|e| e.kek_id != active).collect();
        if pending.is_empty() {
            return Ok(0);
        }
        let from: BTreeSet<String> = pending.iter().map(|e| e.kek_id.clone()).collect();
        let from: Vec<String> = from.into_iter().collect();
        let total = pending.len() as u64;
        *lock(&self.progress) = RewrapProgress {
            running: true,
            to: Some(active.clone()),
            done: 0,
            total,
            error: None,
        };
        self.events.record(&Event::SecretsRewrap {
            phase: "start",
            from: from.clone(),
            to: active.clone(),
            count: total,
        });
        let tenant = self.vault.tenant().to_owned();
        let mut moved = 0u64;
        let mut failure = None;
        for entry in pending {
            let (store, keyring, tenant, active) = (
                Arc::clone(&self.store),
                Arc::clone(&keyring),
                tenant.clone(),
                active.clone(),
            );
            let result = tokio::task::spawn_blocking(move || {
                let owner = entry.owner();
                store.rewrap_secret(
                    &owner,
                    &entry.field,
                    entry.version,
                    &active,
                    MAX_WRAPS_PER_KEK,
                    |current| {
                        let old = keyring.get(&current.kek_id).ok_or_else(|| {
                            SecretError::KeyNotLoaded {
                                kek_id: current.kek_id.clone(),
                            }
                        })?;
                        let damaged = || SecretError::Damaged {
                            owner: owner.to_string(),
                            field: current.field.clone(),
                        };
                        let sealed = current.sealed().ok_or_else(damaged)?;
                        let binding =
                            super::binding(&tenant, &owner, &current.field, current.version);
                        let moved = crypto::rewrap(old, keyring.active(), &binding, &sealed)
                            .map_err(|_| damaged())?;
                        Ok(current.with_sealed(moved))
                    },
                )
            })
            .await
            .map_err(|e| SecretError::Store(format!("the store task failed: {e}")))
            .and_then(|r| r);
            match result {
                Ok(true) => {
                    moved += 1;
                    lock(&self.progress).done = moved;
                }
                // Set again or removed meanwhile: nothing to move.
                Ok(false) => {}
                Err(e) => {
                    failure = Some(e);
                    break;
                }
            }
        }
        {
            let mut progress = lock(&self.progress);
            progress.running = false;
            progress.error = failure.as_ref().map(ToString::to_string);
        }
        self.events.record(&Event::SecretsRewrap {
            phase: "end",
            from,
            to: active,
            count: moved,
        });
        match failure {
            Some(e) => Err(e),
            None => Ok(moved),
        }
    }

    /// The keys in force with their entries (`admin.secrets.status`, `secrets status`).
    pub fn key_status(&self) -> Result<(Vec<KeyRow>, u64), SecretError> {
        let by_key = entries_by_key(&self.store)?;
        let keyring = self.vault.keyring();
        let mut rows: Vec<KeyRow> = keyring
            .keks()
            .zip(keyring.sources())
            .enumerate()
            .map(|(i, (kek, source))| KeyRow {
                id: kek.id().to_owned(),
                source: source.to_owned(),
                active: i == 0,
                loaded: true,
                entries: by_key.get(kek.id()).copied().unwrap_or(0),
            })
            .collect();
        let loaded: BTreeSet<String> = keyring.ids().into_iter().collect();
        let missing: BTreeMap<&String, &u64> = by_key
            .iter()
            .filter(|(id, _)| !loaded.contains(*id))
            .collect();
        for (id, n) in missing {
            rows.push(KeyRow {
                id: id.clone(),
                source: String::new(),
                active: false,
                loaded: false,
                entries: *n,
            });
        }
        Ok((rows, by_key.values().sum()))
    }
}

/// One key, as `admin.secrets.status` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeyRow {
    pub id: String,
    /// `file`, `generated`, `passphrase` or `command`; empty for a key not loaded.
    pub source: String,
    pub active: bool,
    /// `false` for a key that stored entries name but the server has not loaded (only seen
    /// after a refused reload).
    pub loaded: bool,
    /// Entries whose data key is wrapped under it.
    pub entries: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::crypto::Kek;
    use crate::secrets::keys::{KeySource, Keyring, key_file_text};
    use crate::secrets::{Owner, Secret};
    use std::path::Path;

    fn write_key(dir: &Path, name: &str, kek: &Kek) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, key_file_text(kek).as_bytes()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        path
    }

    fn copy(kek: &Kek) -> Kek {
        Kek::from_bytes(zeroize::Zeroizing::new(*kek.expose()))
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        service: Arc<SecretService>,
        old: PathBuf,
        new: PathBuf,
        old_id: String,
        new_id: String,
    }

    fn fixture(entries: usize) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let (old, new) = (Kek::generate().unwrap(), Kek::generate().unwrap());
        let old_path = write_key(dir.path(), "old.key", &old);
        let new_path = write_key(dir.path(), "new.key", &new);
        let (old_id, new_id) = (old.id().to_owned(), new.id().to_owned());
        let vault = Arc::new(Vault::new(
            Keyring::new(vec![copy(&old)]).unwrap(),
            "default",
        ));
        for i in 0..entries {
            vault
                .set(
                    &store,
                    &Owner::profile(format!("p{i}")),
                    "password",
                    &Secret::new(format!("v{i}")),
                    "x",
                    1,
                )
                .unwrap();
        }
        let service = Arc::new(SecretService::new(
            store,
            vault,
            dir.path().to_path_buf(),
            EventLog::discard(),
            None,
        ));
        Fixture {
            _dir: dir,
            service,
            old: old_path,
            new: new_path,
            old_id,
            new_id,
        }
    }

    fn both(f: &Fixture) -> SecretsSettings {
        SecretsSettings {
            keys: vec![
                KeySource::File(f.new.clone()),
                KeySource::File(f.old.clone()),
            ],
        }
    }

    #[tokio::test]
    async fn a_reload_switches_the_active_key_and_the_job_moves_every_entry() {
        let f = fixture(5);
        f.service.reload(&both(&f)).await.unwrap();
        assert_eq!(f.service.vault.keyring().active().id(), f.new_id);
        let moved = f.service.rewrap_pending().await.unwrap();
        assert_eq!(moved, 5);
        let progress = f.service.progress();
        assert_eq!(
            (progress.running, progress.done, progress.total),
            (false, 5, 5)
        );
        assert_eq!(progress.to.as_deref(), Some(f.new_id.as_str()));
        let (rows, total) = f.service.key_status().unwrap();
        assert_eq!(total, 5);
        assert_eq!(rows[0].id, f.new_id);
        assert_eq!(
            (rows[0].entries, rows[0].active, rows[0].source.as_str()),
            (5, true, "file")
        );
        assert_eq!(
            (rows[1].id.as_str(), rows[1].entries),
            (f.old_id.as_str(), 0)
        );
        // Nothing left: a second pass moves nothing; the old key can go.
        assert_eq!(f.service.rewrap_pending().await.unwrap(), 0);
        let new_only = SecretsSettings {
            keys: vec![KeySource::File(f.new.clone())],
        };
        f.service.reload(&new_only).await.unwrap();
        for i in 0..5 {
            let value = f
                .service
                .vault
                .get(
                    &f.service.store,
                    &Owner::profile(format!("p{i}")),
                    "password",
                )
                .unwrap()
                .unwrap();
            assert_eq!(value.as_str(), Some(format!("v{i}").as_str()));
        }
    }

    #[tokio::test]
    async fn a_reload_without_the_key_of_stored_entries_is_refused() {
        let f = fixture(2);
        let new_only = SecretsSettings {
            keys: vec![KeySource::File(f.new.clone())],
        };
        let e = f.service.reload(&new_only).await.unwrap_err();
        assert!(
            e.0.contains(&format!("2 secret entries under key {}", f.old_id)),
            "{e}"
        );
        assert_eq!(f.service.vault.keyring().active().id(), f.old_id);
    }

    #[tokio::test]
    async fn the_job_resumes_after_a_restart_half_way() {
        let f = fixture(6);
        f.service.reload(&both(&f)).await.unwrap();
        // Move half by hand, as a job a restart stopped would have.
        let keyring = f.service.vault.keyring();
        for entry in f
            .service
            .store
            .secret_entries(None)
            .unwrap()
            .into_iter()
            .take(3)
        {
            let owner = entry.owner();
            f.service
                .store
                .rewrap_secret(
                    &owner,
                    &entry.field,
                    entry.version,
                    &f.new_id,
                    MAX_WRAPS_PER_KEK,
                    |e| {
                        let b = crate::secrets::binding("default", &owner, &e.field, e.version);
                        let sealed = crypto::rewrap(
                            keyring.get(&e.kek_id).unwrap(),
                            keyring.active(),
                            &b,
                            &e.sealed().unwrap(),
                        )
                        .unwrap();
                        Ok(e.with_sealed(sealed))
                    },
                )
                .unwrap();
        }
        // A new service on the same store (a restart) moves the rest.
        let restarted = SecretService::new(
            Arc::clone(&f.service.store),
            Arc::new(Vault::new(
                keys::load(
                    &f.service.data,
                    &both(&f),
                    &entries_by_key(&f.service.store).unwrap(),
                    false,
                )
                .await
                .unwrap()
                .keyring,
                "default",
            )),
            f.service.data.clone(),
            EventLog::discard(),
            None,
        );
        assert_eq!(restarted.rewrap_pending().await.unwrap(), 3);
        assert_eq!(
            entries_by_key(&f.service.store).unwrap(),
            BTreeMap::from([(f.new_id.clone(), 6)])
        );
    }

    #[tokio::test]
    async fn rotation_with_calls_running_loses_nothing() {
        let f = fixture(40);
        f.service.reload(&both(&f)).await.unwrap();
        let service = Arc::clone(&f.service);
        // Sets and reads while the job runs.
        let calls = tokio::spawn(async move {
            for round in 0..20 {
                let (s, owner) = (
                    Arc::clone(&service),
                    Owner::profile(format!("p{}", round % 40)),
                );
                tokio::task::spawn_blocking(move || {
                    s.vault
                        .set(
                            &s.store,
                            &owner,
                            "password",
                            &Secret::new(format!("new{round}")),
                            "x",
                            2,
                        )
                        .unwrap();
                    let read = s.vault.get(&s.store, &owner, "password").unwrap().unwrap();
                    assert!(read.as_str().unwrap().starts_with("new"));
                })
                .await
                .unwrap();
            }
        });
        let moved = f.service.rewrap_pending().await.unwrap();
        calls.await.unwrap();
        assert!(moved <= 40);
        // Whatever ran first, every entry ends under the new key and decrypts.
        f.service.rewrap_pending().await.unwrap();
        assert_eq!(
            entries_by_key(&f.service.store).unwrap(),
            BTreeMap::from([(f.new_id.clone(), 40)])
        );
        for i in 0..40 {
            let value = f
                .service
                .vault
                .get(
                    &f.service.store,
                    &Owner::profile(format!("p{i}")),
                    "password",
                )
                .unwrap()
                .unwrap();
            assert!(value.as_str().is_some());
        }
    }
}
