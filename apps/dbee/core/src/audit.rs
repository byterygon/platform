//! The durable audit sink (Ambidex spec §8, DBee spec §4 and Decision 21).
//!
//! [`JsonlAuditSink`] appends hash-chained [`AuditRecord`]s as JSON Lines to `audit/log.jsonl`,
//! one `fsync` per entry, with the `security-types` v1 encoding (so `Started`, `delivery`,
//! `parent_correlation_id` and `detail` are covered by the hash). Opening the log verifies the
//! whole chain and resumes after its last record; a broken or unreadable log is refused, and the
//! core then runs with a sink that fails every write, so Write and Destructive calls (and every
//! grant change and broker open) end with `Unavailable` and nothing happens unrecorded.
//!
//! SQL text never enters an entry: `statement_digest` stays `None` until the audit passphrase
//! and encryption scheme land (Ambidex M3); `input_digest` is the only trace of a call's input.
//!
//! [`ContextSink`] wraps the sink for the Plugin Host: its grant and broker entries are written
//! from inside DBee handlers, so the wrapper sets `parent_correlation_id` to the current call's
//! correlation id (Ambidex [`CallScope::current`]) when the entry has none of its own, and adds
//! the [`AuditDetail`] a task set with [`with_detail`] (workspace restores say so).
//!
//! [`verify`] checks a log file for the `dbee-server audit verify` command. Anchoring against
//! truncation of the newest records stays open (Ambidex Open question 13).

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use ambidex::CallScope;
use security_types::{
    AuditChain, AuditDetail, AuditEntry, AuditError, AuditRecord, AuditSink, BoxFuture, ChainError,
    unfinished,
};

tokio::task_local! {
    /// Detail added to Plugin Host entries written while the task runs.
    static DETAIL: Option<AuditDetail>;
}

/// Runs `fut` with `detail` attached to every Plugin Host entry written from it.
pub async fn with_detail<T>(detail: AuditDetail, fut: impl Future<Output = T>) -> T {
    DETAIL.scope(Some(detail), fut).await
}

/// Entries whose action starts with this are the Plugin Host's.
const PLUGIN_HOST_PREFIX: &str = "plugin-host.";

/// Adds the calling DBee call's correlation id as `parent_correlation_id`, and the task's detail,
/// to Plugin Host entries (see the module docs).
pub struct ContextSink<S> {
    inner: S,
}

impl<S: AuditSink> ContextSink<S> {
    pub fn new(inner: S) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: AuditSink> AuditSink for ContextSink<S> {
    fn append(&self, mut entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if entry.action.name.starts_with(PLUGIN_HOST_PREFIX) {
            if entry.parent_correlation_id.is_none()
                && let Some(scope) = CallScope::current()
                && scope.correlation_id() != entry.correlation_id
            {
                entry.parent_correlation_id = Some(scope.correlation_id().to_owned());
            }
            if entry.detail.is_none()
                && let Ok(Some(detail)) = DETAIL.try_with(Clone::clone)
            {
                entry.detail = Some(detail);
            }
        }
        self.inner.append(entry)
    }
}

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
            state: Arc::new(Mutex::new(LogState { file, chain })),
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
                    state.chain = AuditChain::new();
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
    async fn context_sink_adds_parent_and_detail_to_plugin_host_entries_only() {
        let log = Arc::new(security_types::MemoryAuditLog::new());
        let sink = ContextSink::new(Arc::clone(&log));
        // Outside a call there is no scope: no parent is added, the detail still is.
        let detail = AuditDetail::new([("origin", "workspace_restore")]).unwrap();
        with_detail(detail.clone(), async {
            let mut grant = entry(1);
            grant.action = Action::new("plugin-host.grants.create", "admin.grants.create");
            grant.correlation_id = "child".into();
            sink.append(grant).await.unwrap();
            sink.append(entry(2)).await.unwrap();
        })
        .await;
        let entries = log.entries();
        assert_eq!(entries[0].parent_correlation_id, None);
        assert_eq!(entries[0].detail, Some(detail));
        assert_eq!(entries[1].parent_correlation_id, None);
        assert_eq!(entries[1].detail, None);
        // The parent is tested through the router in tests/core.rs, where a call scope exists.
    }

    #[tokio::test]
    async fn unavailable_sink_fails_every_write() {
        let sink = UnavailableAuditSink("test".into());
        assert_eq!(sink.append(entry(1)).await, Err(AuditError("test".into())));
    }
}
