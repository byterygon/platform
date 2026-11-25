//! Backup and restore (DOC-25 §3.4.6).
//!
//! - **Offline** (the baseline): stop the server, copy the data directory without `keys/`, keep
//!   the keys (or the passphrase) apart. Restore: put the copy back, provide the keys, start.
//! - **Online**: `admin.backup.snapshot` writes `DATA/backups/backup-<utc>.tar` (0600) holding
//!   `store.redb` (a new file filled from one read transaction), the closed audit segments
//!   (`audit/audit-<n>.jsonl`; the active one is closed first, so every record is in) and
//!   `audit/checkpoint.json`. Never the keys. The operator moves it off the machine.
//! - `mightyconsole-server restore --data DIR FILE.tar [--check-secrets]` refuses a non-empty
//!   `DIR`, unpacks only those names, and checks the store (it opens, its schema is known) and
//!   the audit chain (with its checkpoint when the keys load without a prompt). With
//!   `--check-secrets` it decrypts every entry with the configured keys and reports failures by
//!   owner and field, never values. It leaves `DATA/restore.json`; the first start after it
//!   appends `server.restore` with the backup's last audit record and deletes the file.
//!
//! Losing every copy of a key loses the secrets under it, by design.

pub mod tar;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::audit::{AUDIT_DIR, audit_dir};
use crate::store::{STORE_FILE, Store};

/// The directory of online backups in the data directory.
pub const BACKUPS_DIR: &str = "backups";
/// What `restore` leaves for the next start.
pub const RESTORE_MARKER: &str = "restore.json";
/// The largest file `restore` unpacks (the store or one segment).
pub const MAX_FILE: u64 = 64 << 30;

/// Why a backup or a restore failed. Never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackupError(pub String);

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for BackupError {}

fn fail(what: &Path, e: impl std::fmt::Display) -> BackupError {
    BackupError(format!("{}: {e}", what.display()))
}

fn private_dir(dir: &Path) -> Result<(), BackupError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(dir).map_err(|e| fail(dir, e))
}

fn private_file(path: &Path) -> Result<fs::File, BackupError> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path).map_err(|e| fail(path, e))
}

/// What `admin.backup.snapshot` made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub path: PathBuf,
    pub bytes: u64,
    /// The last audit record in it.
    pub audit_seq: Option<u64>,
}

/// Writes an online backup of `data` (DOC-25 §3.4.6). `log` is the durable audit log.
pub fn snapshot(
    store: &Store,
    data: &Path,
    log: &audit_jsonl::SegmentedSink,
    now_ms: u64,
) -> Result<Snapshot, BackupError> {
    let dir = data.join(BACKUPS_DIR);
    private_dir(&dir)?;
    let stamp = audit_jsonl::segments::utc_stamp(now_ms);
    let path = dir.join(format!("backup-{stamp}.tar"));
    let tmp = dir.join(format!(".backup-{stamp}.tar.tmp"));
    let store_copy = dir.join(format!(".store-{stamp}.redb.tmp"));
    let _ = fs::remove_file(&tmp);
    let _ = fs::remove_file(&store_copy);
    let result = (|| {
        store
            .snapshot_to(&store_copy)
            .map_err(|e| BackupError(format!("copying the store: {e}")))?;
        let set = log
            .close_for_backup()
            .map_err(|e| BackupError(format!("the audit log: {}", e.0)))?;
        let file = private_file(&tmp)?;
        let mut tar = tar::Writer::new(io::BufWriter::new(file));
        let mtime = now_ms / 1000;
        let add = |tar: &mut tar::Writer<io::BufWriter<fs::File>>, name: &str, from: &Path| {
            let source = fs::File::open(from).map_err(|e| fail(from, e))?;
            let size = source.metadata().map_err(|e| fail(from, e))?.len();
            tar.file(name, size, mtime, source)
                .map_err(|e| fail(from, e))
        };
        add(&mut tar, STORE_FILE, &store_copy)?;
        for segment in &set.segments {
            let name = segment
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| fail(segment, "not a segment name"))?;
            add(&mut tar, &format!("{AUDIT_DIR}/{name}"), segment)?;
        }
        if let Some(checkpoint) = &set.checkpoint {
            tar.file(
                &format!("{AUDIT_DIR}/{}", audit_jsonl::checkpoint::CHECKPOINT_FILE),
                checkpoint.len() as u64,
                mtime,
                &checkpoint[..],
            )
            .map_err(|e| fail(&tmp, e))?;
        }
        let out = tar.finish().map_err(|e| fail(&tmp, e))?;
        let file = out.into_inner().map_err(|e| fail(&tmp, e.error()))?;
        file.sync_all().map_err(|e| fail(&tmp, e))?;
        fs::rename(&tmp, &path).map_err(|e| fail(&path, e))?;
        if let Ok(d) = fs::File::open(&dir) {
            let _ = d.sync_all();
        }
        let bytes = fs::metadata(&path).map_err(|e| fail(&path, e))?.len();
        Ok(Snapshot {
            path: path.clone(),
            bytes,
            audit_seq: set.head.map(|(seq, _)| seq),
        })
    })();
    let _ = fs::remove_file(&store_copy);
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

/// A name a backup holds.
fn allowed(name: &str) -> bool {
    if name == STORE_FILE {
        return true;
    }
    let Some(rest) = name.strip_prefix(&format!("{AUDIT_DIR}/")) else {
        return false;
    };
    rest == audit_jsonl::checkpoint::CHECKPOINT_FILE
        || audit_jsonl::check::segment_first_seq(rest).is_some()
}

/// What `restore` leaves for the next start: the backup's last audit record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreMarker {
    pub backup_seq: Option<u64>,
    pub backup_hash: Option<String>,
}

/// What `restore` found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Restored {
    pub files: usize,
    pub audit_records: u64,
    pub marker: RestoreMarker,
}

/// Unpacks `archive` into the empty (or absent) `data` and checks the store and the audit
/// chain. The keys are not in a backup; checking the secrets is [`check_secrets`].
pub fn restore(archive: &Path, data: &Path) -> Result<Restored, BackupError> {
    if data.exists() {
        let mut entries = fs::read_dir(data).map_err(|e| fail(data, e))?;
        if entries.next().is_some() {
            return Err(BackupError(format!(
                "{} is not empty: restore into a new directory",
                data.display()
            )));
        }
    }
    let input = fs::File::open(archive).map_err(|e| fail(archive, e))?;
    private_dir(data)?;
    let mut files = 0usize;
    tar::read_all(
        io::BufReader::new(input),
        allowed,
        MAX_FILE,
        |name, _size, body| {
            let path = data.join(name);
            if let Some(parent) = path.parent() {
                private_dir(parent).map_err(|e| io::Error::other(e.0))?;
            }
            let mut out = private_file(&path).map_err(|e| io::Error::other(e.0))?;
            io::copy(body, &mut out)?;
            out.sync_all()?;
            files += 1;
            Ok(())
        },
    )
    .map_err(|e| fail(archive, e))?;
    if !data.join(STORE_FILE).is_file() {
        return Err(BackupError(format!(
            "{}: no store.redb in it: not a Mightyconsole backup",
            archive.display()
        )));
    }
    Store::open(data).map_err(|e| BackupError(format!("the restored store: {e}")))?;
    let segments =
        audit_jsonl::segment_files(&audit_dir(data)).map_err(|e| fail(&audit_dir(data), e))?;
    let checked = audit_jsonl::check_files(&segments)
        .map_err(|e| BackupError(format!("the restored audit log: {e}")))?;
    let marker = RestoreMarker {
        backup_seq: checked.head.map(|(seq, _)| seq),
        backup_hash: checked.head.map(|(_, hash)| hash.to_string()),
    };
    let text = serde_json::to_vec(&marker).map_err(|e| BackupError(e.to_string()))?;
    let marker_path = data.join(RESTORE_MARKER);
    use std::io::Write as _;
    private_file(&marker_path)?
        .write_all(&text)
        .map_err(|e| fail(&marker_path, e))?;
    Ok(Restored {
        files,
        audit_records: checked.records,
        marker,
    })
}

/// Takes the marker `restore` left (the first start after it), deleting it.
pub fn take_restore_marker(data: &Path) -> Result<Option<RestoreMarker>, BackupError> {
    let path = data.join(RESTORE_MARKER);
    let text = match fs::read(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(fail(&path, e)),
    };
    let marker = serde_json::from_slice(&text).map_err(|e| fail(&path, e))?;
    fs::remove_file(&path).map_err(|e| fail(&path, e))?;
    Ok(Some(marker))
}

/// `restore --check-secrets`: decrypts every entry with `vault`; the failures by owner and
/// field, never a value.
pub fn check_secrets(
    data: &Path,
    vault: &crate::secrets::Vault,
) -> Result<Vec<(String, String, String)>, BackupError> {
    let store = Store::open(data).map_err(|e| BackupError(format!("the restored store: {e}")))?;
    vault
        .check_all(&store)
        .map_err(|e| BackupError(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_files_of_a_backup_are_allowed() {
        for ok in [
            "store.redb",
            "audit/audit-000000000001.jsonl",
            "audit/checkpoint.json",
        ] {
            assert!(allowed(ok), "{ok}");
        }
        for bad in [
            "keys/kek-0123.key",
            "../store.redb",
            "/store.redb",
            "audit/../store.redb",
            "audit/audit-1.jsonl/x",
            "config.toml",
            "admin-password",
        ] {
            assert!(!allowed(bad), "{bad}");
        }
    }

    #[test]
    fn the_snapshot_knows_every_table_of_the_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        let copy = dir.path().join("copy.redb");
        store.snapshot_to(&copy).unwrap();
        drop(store);
        let db = redb::Database::open(&copy).unwrap();
        use redb::{ReadableDatabase as _, TableHandle as _};
        let read = db.begin_read().unwrap();
        let mut tables: Vec<String> = read
            .list_tables()
            .unwrap()
            .map(|t| t.name().to_owned())
            .collect();
        tables.sort();
        let mut known: Vec<String> = Store::TABLES.iter().map(|t| (*t).to_owned()).collect();
        known.sort();
        assert_eq!(tables, known);
    }

    #[test]
    fn a_non_empty_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("x"), b"").unwrap();
        let e = restore(&dir.path().join("none.tar"), dir.path()).unwrap_err();
        assert!(e.0.contains("is not empty"), "{e}");
    }
}
