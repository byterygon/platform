//! The standalone workspace on disk (DBee spec §2, Ambidex spec §15).
//!
//! `<workspace>/connections.json` holds the connection records: the grant as approved (never a
//! credential, only the opaque secret reference), the driver settings a grant does not cover,
//! and the display fields. `settings.json` and `tabs.json` are JSON documents the UI owns; the
//! core stores them whole. Every write goes to a temporary file in the same directory, is
//! fsynced and renamed over the old file, so a crash leaves either the old or the new file.
//! `audit/log.jsonl` is the audit sink's (see [`crate::audit`]).
//!
//! The default directory is `dirs::data_dir()/dbee/workspace`, overridable with
//! `DBEE_WORKSPACE`.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{GrantState, TlsKind};

/// Environment variable that overrides the workspace directory.
pub const WORKSPACE_ENV: &str = "DBEE_WORKSPACE";

pub const CONNECTIONS_FILE: &str = "connections.json";
pub const SETTINGS_FILE: &str = "settings.json";
pub const TABS_FILE: &str = "tabs.json";
/// The audit log, relative to the workspace.
pub const AUDIT_LOG: &str = "audit/log.jsonl";

/// `DBEE_WORKSPACE`, or `dirs::data_dir()/dbee/workspace`. `None` when the platform has no data
/// directory and the variable is unset.
pub fn default_workspace_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os(WORKSPACE_ENV)
        && !dir.is_empty()
    {
        return Some(PathBuf::from(dir));
    }
    dirs::data_dir().map(|d| d.join("dbee").join("workspace"))
}

/// Version of the `connections.json` layout.
const CONNECTIONS_VERSION: u32 = 1;

/// TLS policy of a connection as stored: enough to rebuild the Plugin Host `TlsPolicy` and the
/// driver's TLS mode. Certificates are DER, hex-encoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTls {
    pub kind: TlsKind,
    /// `None` for plaintext.
    pub server_name: Option<String>,
    /// Pinned CA certificates (DER, hex) for `pinned-ca`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_cas: Vec<String>,
    /// Pinned server certificate digests (`sha256:<hex>`) for `pinned-cert`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_certs: Vec<String>,
}

/// The grant of a connection as approved (Plugin Host `GrantRequest` fields) plus its state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGrant {
    /// The grant store's id of the live grant. Changes when the grant is rebuilt at startup.
    pub id: String,
    pub state: GrantState,
    pub tenant: String,
    pub owner: String,
    pub target_id: String,
    pub template_id: String,
    pub host: String,
    pub port: u16,
    pub tls: StoredTls,
    /// CIDR networks.
    pub addresses: Vec<String>,
    pub allow_cancel_connection: bool,
    pub created_at: u64,
    pub expires_at: Option<u64>,
    /// The approving principal id.
    pub approver: String,
}

/// The credential binding: the template and an opaque reference into the secret store. Never the
/// value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSecret {
    pub template_id: String,
    pub secret_ref: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDriver {
    pub id: String,
    pub version: String,
    /// `sha256:<hex>`.
    pub digest: String,
}

/// One connection record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionRecord {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub colour: Option<String>,
    pub driver: StoredDriver,
    pub grant: StoredGrant,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub secret: Option<StoredSecret>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionsFile {
    version: u32,
    connections: Vec<ConnectionRecord>,
}

#[derive(Debug)]
pub enum WorkspaceError {
    Io {
        path: PathBuf,
        error: io::Error,
    },
    /// A file is not what the core writes.
    Malformed {
        path: PathBuf,
        message: String,
    },
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WorkspaceError::Io { path, error } => {
                write!(f, "could not read or write {}: {error}", path.display())
            }
            WorkspaceError::Malformed { path, message } => {
                write!(
                    f,
                    "{} is not a valid workspace file: {message}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for WorkspaceError {}

#[derive(Debug, Default)]
struct Documents {
    connections: Vec<ConnectionRecord>,
    settings: Value,
    tabs: Value,
}

/// The workspace store. `dir` is `None` for a store that lives in memory only (codegen, tests).
pub struct Workspace {
    dir: Option<PathBuf>,
    documents: Mutex<Documents>,
}

impl Workspace {
    /// Opens (creating if needed) the workspace at `dir` and loads its files.
    pub fn open(dir: &Path) -> Result<Workspace, WorkspaceError> {
        fs::create_dir_all(dir).map_err(|error| WorkspaceError::Io {
            path: dir.to_path_buf(),
            error,
        })?;
        let connections = match read_json::<ConnectionsFile>(&dir.join(CONNECTIONS_FILE))? {
            Some(file) if file.version == CONNECTIONS_VERSION => file.connections,
            Some(file) => {
                return Err(WorkspaceError::Malformed {
                    path: dir.join(CONNECTIONS_FILE),
                    message: format!("unsupported version {}", file.version),
                });
            }
            None => Vec::new(),
        };
        let settings = read_json::<Value>(&dir.join(SETTINGS_FILE))?.unwrap_or(Value::Null);
        let tabs = read_json::<Value>(&dir.join(TABS_FILE))?.unwrap_or(Value::Null);
        Ok(Workspace {
            dir: Some(dir.to_path_buf()),
            documents: Mutex::new(Documents {
                connections,
                settings,
                tabs,
            }),
        })
    }

    /// A workspace that writes nothing.
    pub fn in_memory() -> Workspace {
        Workspace {
            dir: None,
            documents: Mutex::default(),
        }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /// Where the audit log goes; `None` for an in-memory workspace.
    pub fn audit_log_path(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join(AUDIT_LOG))
    }

    pub fn connections(&self) -> Vec<ConnectionRecord> {
        self.lock().connections.clone()
    }

    pub fn connection(&self, id: &str) -> Option<ConnectionRecord> {
        self.lock().connections.iter().find(|c| c.id == id).cloned()
    }

    /// Changes the records under the lock and writes the file. If writing fails the change is
    /// rolled back and the error returned, so memory and disk never disagree.
    pub fn update_connections<T>(
        &self,
        f: impl FnOnce(&mut Vec<ConnectionRecord>) -> T,
    ) -> Result<T, WorkspaceError> {
        let mut docs = self.lock();
        let before = docs.connections.clone();
        let out = f(&mut docs.connections);
        if let Some(dir) = &self.dir {
            let file = ConnectionsFile {
                version: CONNECTIONS_VERSION,
                connections: docs.connections.clone(),
            };
            if let Err(e) = write_json(&dir.join(CONNECTIONS_FILE), &file) {
                docs.connections = before;
                return Err(e);
            }
        }
        Ok(out)
    }

    pub fn settings(&self) -> Value {
        self.lock().settings.clone()
    }

    pub fn set_settings(&self, value: Value) -> Result<(), WorkspaceError> {
        let mut docs = self.lock();
        if let Some(dir) = &self.dir {
            write_json(&dir.join(SETTINGS_FILE), &value)?;
        }
        docs.settings = value;
        Ok(())
    }

    pub fn tabs(&self) -> Value {
        self.lock().tabs.clone()
    }

    pub fn set_tabs(&self, value: Value) -> Result<(), WorkspaceError> {
        let mut docs = self.lock();
        if let Some(dir) = &self.dir {
            write_json(&dir.join(TABS_FILE), &value)?;
        }
        docs.tabs = value;
        Ok(())
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Documents> {
        self.documents.lock().unwrap_or_else(|e| e.into_inner())
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, WorkspaceError> {
    let text = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(WorkspaceError::Io {
                path: path.to_path_buf(),
                error,
            });
        }
    };
    serde_json::from_slice(&text)
        .map(Some)
        .map_err(|e| WorkspaceError::Malformed {
            path: path.to_path_buf(),
            // serde's message can quote the file; it names the position only.
            message: format!("invalid JSON at line {} column {}", e.line(), e.column()),
        })
}

/// Writes `value` as pretty JSON through a temporary file in the same directory, fsyncs it and
/// renames it into place.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), WorkspaceError> {
    let io_err = |error| WorkspaceError::Io {
        path: path.to_path_buf(),
        error,
    };
    let dir = path
        .parent()
        .ok_or_else(|| io_err(io::Error::other("workspace file has no parent directory")))?;
    fs::create_dir_all(dir).map_err(io_err)?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    let mut text =
        serde_json::to_vec_pretty(value).map_err(|e| io_err(io::Error::other(e.to_string())))?;
    text.push(b'\n');
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(&text)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        // The rename is durable only once the directory entry is.
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result.map_err(io_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: id.into(),
            name: id.into(),
            description: None,
            colour: None,
            driver: StoredDriver {
                id: "d".into(),
                version: "0".into(),
                digest: "sha256:00".into(),
            },
            grant: StoredGrant {
                id: "g".into(),
                state: GrantState::Active,
                tenant: "local".into(),
                owner: "human:local:me".into(),
                target_id: "t".into(),
                template_id: "db-transport".into(),
                host: "localhost".into(),
                port: 5432,
                tls: StoredTls {
                    kind: TlsKind::Plaintext,
                    server_name: None,
                    pinned_cas: vec![],
                    pinned_certs: vec![],
                },
                addresses: vec!["127.0.0.1/32".into()],
                allow_cancel_connection: true,
                created_at: 1,
                expires_at: None,
                approver: "human:local:me".into(),
            },
            database: "db".into(),
            user: "u".into(),
            secret: None,
        }
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        ws.update_connections(|c| c.push(record("a"))).unwrap();
        ws.set_settings(serde_json::json!({ "density": "compact" }))
            .unwrap();
        ws.set_tabs(serde_json::json!([{ "sql": "select 1" }]))
            .unwrap();
        assert!(dir.path().join(CONNECTIONS_FILE).is_file());
        assert!(
            !dir.path()
                .read_dir()
                .unwrap()
                .any(|e| { e.unwrap().file_name().to_string_lossy().ends_with(".tmp") })
        );

        let again = Workspace::open(dir.path()).unwrap();
        assert_eq!(again.connections(), vec![record("a")]);
        assert_eq!(again.settings()["density"], "compact");
        assert_eq!(again.tabs()[0]["sql"], "select 1");
    }

    #[test]
    fn a_failed_write_rolls_the_change_back() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::open(dir.path()).unwrap();
        ws.update_connections(|c| c.push(record("a"))).unwrap();
        // Make the directory unwritable by replacing the file with a directory of the same name.
        fs::remove_file(dir.path().join(CONNECTIONS_FILE)).unwrap();
        fs::create_dir(dir.path().join(CONNECTIONS_FILE)).unwrap();
        let err = ws.update_connections(|c| c.push(record("b"))).unwrap_err();
        assert!(matches!(err, WorkspaceError::Io { .. }));
        assert_eq!(ws.connections().len(), 1);
    }

    #[test]
    fn a_malformed_file_is_reported_without_its_contents() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(CONNECTIONS_FILE), "{ not json, hunter2 }").unwrap();
        let text = match Workspace::open(dir.path()) {
            Ok(_) => panic!("a malformed file opened"),
            Err(e) => e.to_string(),
        };
        assert!(text.contains("not a valid workspace file"));
        assert!(!text.contains("hunter2"));
    }
}
