//! The default administrator (DOC-25 §3.2.7): the account `admin`, made on a first start with a
//! generated password in `DATA/admin-password` (0600), and `reset-admin`, the way back in.
//!
//! - The password is 24 characters from a 32-symbol alphabet (120 random bits). It is written to
//!   the file and never printed or logged by the server: logs are often shipped elsewhere. The
//!   account must change it at its first sign-in; the file is then deleted.
//! - `reset-admin` proves the operator by access to the data directory. With the server stopped
//!   it opens the store itself ([`reset`], `via = stopped`). With the server running the store
//!   is locked, so it writes `DATA/reset-admin.request` (0600); the server's [`watch_requests`]
//!   performs the reset within [`REQUEST_POLL`] and deletes the request (`via = request`).
//! - A reset sets a new password that must be changed, enables and unlocks the account, removes
//!   its TOTP and recovery codes; the running server also ends its sessions.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ambidex_axum::accounts::{Account, CreateError, CreatedBy, PasswordHasher, new_ulid};
use zeroize::Zeroizing;

use crate::store::Store;

/// The default administrator's user name.
pub const ADMIN_USERNAME: &str = "admin";
/// Where its generated password is, until it is changed.
pub const PASSWORD_FILE: &str = "admin-password";
/// What `reset-admin` writes for a running server.
pub const REQUEST_FILE: &str = "reset-admin.request";
/// How often a running server looks for a request.
pub const REQUEST_POLL: Duration = Duration::from_secs(1);
/// How long `reset-admin` waits for a running server.
pub const REQUEST_WAIT: Duration = Duration::from_secs(30);

/// Characters of a generated password.
pub const PASSWORD_CHARS: usize = 24;
/// 32 symbols: no `0 1 I L O U`, so a password read off a screen is hard to mistype.
const ALPHABET: &[u8; 32] = b"abcdefghjkmnpqrstvwxyz23456789AB";

/// A new password: [`PASSWORD_CHARS`] symbols of 5 random bits each.
pub fn generate_password() -> Zeroizing<String> {
    let mut bytes = Zeroizing::new([0u8; 15]);
    getrandom::fill(&mut *bytes).expect("OS randomness");
    let mut value = Zeroizing::new(0u128);
    for b in bytes.iter() {
        *value = (*value << 8) | u128::from(*b);
    }
    let mut out = Zeroizing::new(String::with_capacity(PASSWORD_CHARS));
    for i in (0..PASSWORD_CHARS).rev() {
        out.push(char::from(ALPHABET[((*value >> (i * 5)) & 31) as usize]));
    }
    out
}

pub fn password_file(data: &Path) -> PathBuf {
    data.join(PASSWORD_FILE)
}

pub fn request_file(data: &Path) -> PathBuf {
    data.join(REQUEST_FILE)
}

/// Writes `text` to a new file with mode 0600 (replacing one that is there).
pub fn write_private(path: &Path, text: &str) -> io::Result<()> {
    if fs::symlink_metadata(path).is_ok() {
        fs::remove_file(path)?;
    }
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(text.as_bytes())?;
    file.sync_all()
}

/// What a reset did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reset {
    pub account: String,
    pub password_file: PathBuf,
}

/// Creates the default administrator when the store has no account named `admin`: a generated
/// password in `DATA/admin-password`, `mustChangePassword`. Returns the file when it did.
pub async fn ensure(
    store: &Arc<Store>,
    data: &Path,
    hasher: &PasswordHasher,
    now_ms: u64,
) -> Result<Option<PathBuf>, String> {
    let exists = {
        let store = Arc::clone(store);
        tokio::task::spawn_blocking(move || store.account_by_username(ADMIN_USERNAME))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
            .is_some()
    };
    if exists {
        return Ok(None);
    }
    let password = generate_password();
    let hash = hasher
        .hash(password.clone())
        .await
        .map_err(|e| e.to_string())?;
    let file = password_file(data);
    write_private(&file, &format!("{}\n", password.as_str()))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    let account = Account {
        id: new_ulid(now_ms),
        username: ADMIN_USERNAME.into(),
        display_name: "Administrator".into(),
        password_hash: Some(hash),
        must_change_password: true,
        created_by: CreatedBy::Server,
        created_ms: now_ms,
        last_seen_ms: None,
        disabled: false,
        locked_until_ms: None,
        totp: None,
        recovery_codes: vec![],
    };
    let store = Arc::clone(store);
    let created = tokio::task::spawn_blocking(move || store.create_account(&account))
        .await
        .map_err(|e| e.to_string())?;
    match created {
        Ok(()) => Ok(Some(file)),
        Err(CreateError::UsernameTaken) => {
            let _ = fs::remove_file(&file);
            Ok(None)
        }
        Err(CreateError::Store(e)) => {
            let _ = fs::remove_file(&file);
            Err(e.to_string())
        }
    }
}

/// Resets the default administrator (creating it if it is missing): a new password in
/// `DATA/admin-password` that must be changed, enabled, unlocked, no TOTP or recovery codes.
/// The caller ends its sessions (a running server) and records `auth.admin.reset`.
pub async fn reset(
    store: &Arc<Store>,
    data: &Path,
    hasher: &PasswordHasher,
    now_ms: u64,
) -> Result<Reset, String> {
    if let Some(file) = ensure(store, data, hasher, now_ms).await? {
        let store = Arc::clone(store);
        let account =
            tokio::task::spawn_blocking(move || store.account_by_username(ADMIN_USERNAME))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
                .ok_or("the default administrator vanished")?;
        return Ok(Reset {
            account: account.id,
            password_file: file,
        });
    }
    let password = generate_password();
    let hash = hasher
        .hash(password.clone())
        .await
        .map_err(|e| e.to_string())?;
    let file = password_file(data);
    write_private(&file, &format!("{}\n", password.as_str()))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    let store = Arc::clone(store);
    let id = tokio::task::spawn_blocking(move || {
        let id = store
            .account_by_username(ADMIN_USERNAME)?
            .map(|a| a.id)
            .ok_or_else(|| ambidex_axum::accounts::StoreError("no admin account".into()))?;
        store.update_account(&id, |a| {
            a.password_hash = Some(hash);
            a.must_change_password = true;
            a.disabled = false;
            a.locked_until_ms = None;
            a.totp = None;
            a.recovery_codes.clear();
        })?;
        Ok::<_, ambidex_axum::accounts::StoreError>(id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    Ok(Reset {
        account: id,
        password_file: file,
    })
}

/// Whether a request is waiting: a regular file (not a link) named [`REQUEST_FILE`].
pub fn request_waiting(data: &Path) -> bool {
    fs::symlink_metadata(request_file(data)).is_ok_and(|m| m.file_type().is_file())
}

/// The running server's side of `reset-admin`: every [`REQUEST_POLL`], a waiting request is
/// performed with [`reset`], `done` is told (to end the sessions and record the event), and the
/// request is deleted. A request that fails is left for the command to time out on, and `failed`
/// is told why.
pub fn watch_requests(
    store: Arc<Store>,
    data: PathBuf,
    hasher: PasswordHasher,
    clock: Arc<dyn security_types::Clock>,
    done: impl Fn(&Reset) + Send + Sync + 'static,
    failed: impl Fn(&str) + Send + Sync + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(REQUEST_POLL);
        let mut reported = false;
        loop {
            tick.tick().await;
            if !request_waiting(&data) {
                reported = false;
                continue;
            }
            match reset(&store, &data, &hasher, clock.now_unix_ms()).await {
                Ok(reset) => {
                    done(&reset);
                    let _ = fs::remove_file(request_file(&data));
                    reported = false;
                }
                Err(e) if !reported => {
                    failed(&e);
                    reported = true;
                }
                Err(_) => {}
            }
        }
    })
}

/// The command's side against a running server: writes the request and waits for the server to
/// delete it. On a timeout the request is removed again.
pub async fn request_and_wait(data: &Path, wait: Duration) -> Result<(), String> {
    let request = request_file(data);
    write_private(&request, "reset-admin\n").map_err(|e| format!("{}: {e}", request.display()))?;
    let deadline = tokio::time::Instant::now() + wait;
    while tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if fs::symlink_metadata(&request).is_err() {
            return Ok(());
        }
    }
    let _ = fs::remove_file(&request);
    Err(format!(
        "the running server did not perform the reset within {} s; see its log",
        wait.as_secs()
    ))
}

/// Deletes `DATA/admin-password` (the default administrator changed its password).
pub fn forget_password_file(data: &Path) {
    let _ = fs::remove_file(password_file(data));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hasher() -> PasswordHasher {
        PasswordHasher::with_params(8, 1, 1, 4).unwrap()
    }

    #[test]
    fn generated_passwords() {
        let a = generate_password();
        assert_eq!(a.len(), PASSWORD_CHARS);
        assert!(a.bytes().all(|b| ALPHABET.contains(&b)));
        assert_ne!(a, generate_password());
        let distinct: std::collections::HashSet<u8> = ALPHABET.iter().copied().collect();
        assert_eq!(distinct.len(), 32);
    }

    #[tokio::test]
    async fn a_first_start_makes_the_administrator_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let h = hasher();
        let file = ensure(&store, dir.path(), &h, 1).await.unwrap().unwrap();
        assert_eq!(file, dir.path().join("admin-password"));
        let password = fs::read_to_string(&file).unwrap();
        assert_eq!(password.trim().len(), PASSWORD_CHARS);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let admin = store.account_by_username("admin").unwrap().unwrap();
        assert!(admin.must_change_password);
        assert_eq!(admin.created_by, CreatedBy::Server);
        assert!(
            h.verify(
                password.trim().to_owned().into(),
                admin.password_hash.clone()
            )
            .await
        );
        // Not again.
        assert_eq!(ensure(&store, dir.path(), &h, 2).await.unwrap(), None);
        assert_eq!(fs::read_to_string(&file).unwrap(), password);
    }

    #[tokio::test]
    async fn a_reset_sets_a_new_password_and_lifts_everything() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        let h = hasher();
        ensure(&store, dir.path(), &h, 1).await.unwrap();
        let first = fs::read_to_string(password_file(dir.path())).unwrap();
        let id = store.account_by_username("admin").unwrap().unwrap().id;
        store
            .update_account(&id, |a| {
                a.disabled = true;
                a.locked_until_ms = Some(u64::MAX);
                a.must_change_password = false;
                a.totp = Some(ambidex_axum::accounts::TotpRecord {
                    key: Zeroizing::new(vec![1; 20]),
                    last_step: 1,
                    enrolled_ms: 1,
                });
                a.recovery_codes = vec!["$argon2id$x".into()];
            })
            .unwrap();
        forget_password_file(dir.path());
        let reset = reset(&store, dir.path(), &h, 5).await.unwrap();
        assert_eq!(reset.account, id);
        let second = fs::read_to_string(&reset.password_file).unwrap();
        assert_ne!(first, second);
        let admin = store.account(&id).unwrap().unwrap();
        assert!(!admin.disabled && admin.must_change_password);
        assert_eq!(admin.locked_until_ms, None);
        assert!(admin.totp.is_none() && admin.recovery_codes.is_empty());
        assert!(
            h.verify(second.trim().to_owned().into(), admin.password_hash)
                .await
        );
    }

    #[tokio::test]
    async fn a_request_is_performed_by_the_watcher_and_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path()).unwrap());
        ensure(&store, dir.path(), &hasher(), 1).await.unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let watcher = watch_requests(
            Arc::clone(&store),
            dir.path().to_path_buf(),
            hasher(),
            Arc::new(security_types::SystemClock),
            move |r: &Reset| {
                let _ = tx.send(r.account.clone());
            },
            |_| {},
        );
        let before = fs::read_to_string(password_file(dir.path())).unwrap();
        request_and_wait(dir.path(), REQUEST_WAIT).await.unwrap();
        assert!(!request_waiting(dir.path()));
        assert!(rx.recv().await.is_some());
        assert_ne!(
            fs::read_to_string(password_file(dir.path())).unwrap(),
            before
        );
        watcher.abort();

        // Nobody watching: the command gives up and removes its request.
        let e = request_and_wait(dir.path(), Duration::from_millis(500))
            .await
            .unwrap_err();
        assert!(e.contains("did not perform"));
        assert!(!request_waiting(dir.path()));
    }
}
