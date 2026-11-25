//! The durable audit sink (Ambidex spec §8, DBee spec §4 and Decision 21, Mightyconsole spec
//! DOC-25 §3.5), shared by DBee and Mightyconsole.
//!
//! [`JsonlAuditSink`] appends hash-chained [`AuditRecord`]s as JSON Lines, one `fsync` per entry,
//! with the `security-types` v1 encoding (so `Started`, `delivery`, `parent_correlation_id` and
//! `detail` are covered by the hash). Opening the log verifies the whole chain and resumes after
//! its last record; a broken or unreadable log is refused, and the caller then runs with an
//! [`UnavailableAuditSink`] that fails every write, so calls that must be recorded end with
//! `Unavailable` and nothing happens unrecorded.
//!
//! [`verify`] checks a log file for the products' `audit verify` commands. Anchoring against
//! truncation of the newest records is the checkpoint of DOC-25 §3.5.4 (Ambidex Open question 13).
//!
//! The record format and hash domain are `security-types`' and do not change here: logs written
//! before this crate existed (DBee's) verify unchanged.

pub mod check;
pub mod checkpoint;
pub mod segments;

pub use check::{
    Break, BreakKind, CheckError, Checked, NEW_CHAIN_ACTION, RETENTION_ACTION, SegmentInfo,
    check_files, segment_files,
};
pub use segments::{BackupSet, SegmentOptions, SegmentPolicy, SegmentStatus, SegmentedSink};

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use security_types::{
    AuditChain, AuditEntry, AuditError, AuditRecord, AuditSink, BoxFuture, ChainError, unfinished,
};

/// Why a log could not be opened or verified.
#[derive(Debug)]
pub enum AuditLogError {
    Io {
        path: PathBuf,
        error: io::Error,
    },
    /// Line `line` (1-based) is not an audit record.
    Malformed {
        path: PathBuf,
        line: usize,
    },
    /// The chain is broken at this record.
    Chain {
        path: PathBuf,
        error: ChainError,
    },
    /// A log of several segment files breaks here ([`check_files`]).
    Broken(Box<Break>),
}

impl std::fmt::Display for AuditLogError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuditLogError::Io { path, error } => {
                write!(f, "audit log {}: {error}", path.display())
            }
            AuditLogError::Malformed { path, line } => {
                write!(
                    f,
                    "audit log {}: line {line} is not a record",
                    path.display()
                )
            }
            AuditLogError::Chain { path, error } => {
                write!(f, "audit log {}: {error}", path.display())
            }
            AuditLogError::Broken(broken) => write!(f, "audit log {broken}"),
        }
    }
}

impl std::error::Error for AuditLogError {}

/// Reads and verifies every record of the log at `path`. An absent file is an empty, valid log.
pub fn read_records(path: &Path) -> Result<Vec<AuditRecord>, AuditLogError> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(AuditLogError::Io {
                path: path.to_path_buf(),
                error,
            });
        }
    };
    let mut records = Vec::new();
    for (i, line) in io::BufReader::new(file).lines().enumerate() {
        let line = line.map_err(|error| AuditLogError::Io {
            path: path.to_path_buf(),
            error,
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record: AuditRecord =
            serde_json::from_str(&line).map_err(|_| AuditLogError::Malformed {
                path: path.to_path_buf(),
                line: i + 1,
            })?;
        records.push(record);
    }
    AuditChain::verify_all(&records).map_err(|error| AuditLogError::Chain {
        path: path.to_path_buf(),
        error,
    })?;
    Ok(records)
}

/// The result of [`verify`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    pub records: usize,
    /// Correlation ids of admissions (`Started`) without a completion: outcome unknown.
    pub unfinished: Vec<String>,
}

/// Verifies the chain of the log at `path` and lists its unfinished calls.
pub fn verify(path: &Path) -> Result<VerifyReport, AuditLogError> {
    let records = read_records(path)?;
    let entries: Vec<AuditEntry> = records.iter().map(|r| r.entry.clone()).collect();
    Ok(VerifyReport {
        records: records.len(),
        unfinished: unfinished(&entries)
            .into_iter()
            .map(|e| e.correlation_id.clone())
            .collect(),
    })
}

struct LogState {
    file: File,
    chain: AuditChain,
    /// Set by a failed write: the chain head already moved, so a later append would leave a gap
    /// on disk. Every later write fails until the log is repaired and reopened.
    failed: bool,
}

/// Append-only, hash-chained JSON Lines on disk, one fsync per entry.
pub struct JsonlAuditSink {
    path: PathBuf,
    state: Arc<Mutex<LogState>>,
}

impl JsonlAuditSink {
    /// Opens the log at `path`, verifying every existing record, and resumes its chain.
    pub fn open(path: &Path) -> Result<JsonlAuditSink, AuditLogError> {
        let io_err = |error| AuditLogError::Io {
            path: path.to_path_buf(),
            error,
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(io_err)?;
        }
        let records = read_records(path)?;
        let chain = match records.last() {
            Some(last) => AuditChain::resume_after(last).map_err(|error| AuditLogError::Chain {
                path: path.to_path_buf(),
                error,
            })?,
            None => AuditChain::new(),
        };
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(io_err)?;
        Ok(JsonlAuditSink {
            path: path.to_path_buf(),
            state: Arc::new(Mutex::new(LogState {
                file,
                chain,
                failed: false,
            })),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Records written so far (the next record's `seq`).
    pub fn len(&self) -> u64 {
        lock(&self.state).chain.next_seq()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn lock(m: &Mutex<LogState>) -> std::sync::MutexGuard<'_, LogState> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AuditSink for JsonlAuditSink {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        let state = Arc::clone(&self.state);
        Box::pin(async move {
            // The write and its fsync block; they run off the runtime, serialized by the lock so
            // the chain order is the file order.
            let written = tokio::task::spawn_blocking(move || {
                let mut state = lock(&state);
                if state.failed {
                    return Err(AuditError("an earlier write failed".into()));
                }
                let record = state.chain.append(entry);
                let mut line = serde_json::to_vec(&record)
                    .map_err(|_| AuditError("record did not serialize".into()))?;
                line.push(b'\n');
                let result = state
                    .file
                    .write_all(&line)
                    .and_then(|()| state.file.sync_data());
                if let Err(e) = result {
                    // The chain head already moved; a later append would leave a gap on disk.
                    // Fail every later write too: the log is unusable until it is repaired.
                    state.failed = true;
                    return Err(AuditError(format!("write failed: {}", e.kind())));
                }
                Ok(())
            })
            .await;
            written.unwrap_or_else(|_| Err(AuditError("audit writer panicked".into())))
        })
    }
}

/// A sink that refuses every entry, for a log that could not be opened and for tests of the
/// fail-closed paths. Calls that must be recorded then do not run.
pub struct UnavailableAuditSink(pub String);

impl AuditSink for UnavailableAuditSink {
    fn append(&self, _entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        Box::pin(std::future::ready(Err(AuditError(self.0.clone()))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{
        Action, AuditDecision, AuditPrincipal, Digest, Outcome, Principal, PrincipalKind, Risk,
        SessionId, TenantId,
    };

    fn entry(n: u64) -> AuditEntry {
        let human = Principal {
            kind: PrincipalKind::Human,
            id: "human:local:me".into(),
            tenant: TenantId::new("local"),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("s"),
        };
        AuditEntry {
            timestamp_unix_ms: n,
            principal_chain: AuditPrincipal::chain_of(&human),
            tenant: TenantId::new("local"),
            action: Action::new("connections.list", "connections.read"),
            target: None,
            risk: Risk::Read,
            decision: AuditDecision::Allow,
            approval_id: None,
            outcome: Outcome::Success,
            duration_ms: Some(1),
            correlation_id: format!("c-{n}"),
            input_digest: Digest::ZERO,
            statement_digest: None,
            delivery: None,
            parent_correlation_id: None,
            detail: None,
        }
    }

    #[tokio::test]
    async fn appends_verify_and_resume_across_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("audit/log.jsonl");
        let sink = JsonlAuditSink::open(&path).unwrap();
        sink.append(entry(1)).await.unwrap();
        sink.append(entry(2)).await.unwrap();
        assert_eq!(sink.len(), 2);
        drop(sink);
        let sink = JsonlAuditSink::open(&path).unwrap();
        sink.append(entry(3)).await.unwrap();
        let report = verify(&path).unwrap();
        assert_eq!(report.records, 3);
        assert!(report.unfinished.is_empty());
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.lines().count(), 3);
        assert!(text.lines().all(|l| l.starts_with("{\"seq\":")));
    }

    #[tokio::test]
    async fn a_modified_line_breaks_verification_and_refuses_opening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let sink = JsonlAuditSink::open(&path).unwrap();
        sink.append(entry(1)).await.unwrap();
        sink.append(entry(2)).await.unwrap();
        drop(sink);
        let text = fs::read_to_string(&path).unwrap();
        let tampered = text.replacen("\"risk\":\"Read\"", "\"risk\":\"Write\"", 1);
        fs::write(&path, tampered).unwrap();
        assert!(matches!(
            verify(&path),
            Err(AuditLogError::Chain {
                error: ChainError::HashMismatch { seq: 0 },
                ..
            })
        ));
        assert!(JsonlAuditSink::open(&path).is_err());
        // A deleted first line is a sequence gap.
        let text = fs::read_to_string(&path).unwrap();
        fs::write(&path, text.lines().skip(1).collect::<Vec<_>>().join("\n")).unwrap();
        assert!(matches!(
            verify(&path),
            Err(AuditLogError::Chain {
                error: ChainError::UnexpectedSeq { .. },
                ..
            })
        ));
    }

    #[tokio::test]
    async fn verify_lists_unfinished_calls() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("log.jsonl");
        let sink = JsonlAuditSink::open(&path).unwrap();
        let mut started = entry(1);
        started.outcome = Outcome::Started;
        started.duration_ms = None;
        sink.append(started).await.unwrap();
        assert_eq!(verify(&path).unwrap().unfinished, vec!["c-1".to_owned()]);
    }

    #[tokio::test]
    async fn unavailable_sink_fails_every_write() {
        let sink = UnavailableAuditSink("test".into());
        assert_eq!(sink.append(entry(1)).await, Err(AuditError("test".into())));
    }
}
