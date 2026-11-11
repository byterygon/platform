//! Where audit entries go: the asynchronous [`AuditSink`] shared by Ambidex and Plugin Host
//! (Ambidex spec Open questions 24g and 26).
//!
//! The sink is asynchronous because failing closed means awaiting the write before an operation
//! runs, and a durable sink (file, database, fsync, hash chain) must not block the runtime while
//! it writes. `append` returns a boxed future so the trait stays object-safe (`Arc<dyn
//! AuditSink>`) without an async-trait dependency.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::audit::{AuditChain, AuditEntry, AuditRecord};

/// A `Send` future borrowing for `'a`, as the object-safe traits of this crate return.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Receives audit entries.
///
/// `Ok(())` means the entry is recorded. What callers do on an error depends on the entry: an
/// operation whose entry must exist before it runs fails closed (Write/Destructive and agent
/// calls in Ambidex, broker opens and grant creates in Plugin Host); a refusal is refused either
/// way. Callers bound how long they wait, so a sink that hangs is treated like one that fails.
///
/// The message of an [`AuditError`] is reported to operators (see [`crate::report`]), so it must
/// not contain secrets.
pub trait AuditSink: Send + Sync + 'static {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>>;
}

impl<S: AuditSink + ?Sized> AuditSink for Arc<S> {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        (**self).append(entry)
    }
}

/// An [`AuditSink`] could not record an entry. The message is safe to log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditError(pub String);

impl fmt::Display for AuditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "audit sink failed: {}", self.0)
    }
}

impl std::error::Error for AuditError {}

impl AuditError {
    /// The error of a write that did not finish in time.
    pub fn timed_out() -> AuditError {
        AuditError("write timed out".into())
    }
}

/// Appends `entry` to `sink`, giving up at `deadline` with [`AuditError::timed_out`]. Every
/// caller that bounds a write uses this, so a hung sink fails the same way everywhere.
#[cfg(feature = "tokio")]
pub async fn append_within(
    sink: &dyn AuditSink,
    entry: AuditEntry,
    deadline: tokio::time::Instant,
) -> Result<(), AuditError> {
    write_within(sink.append(entry), deadline).await
}

/// Awaits a write already started (an [`AuditSink::append`] future), giving up at `deadline`
/// with [`AuditError::timed_out`].
#[cfg(feature = "tokio")]
pub async fn write_within(
    write: impl Future<Output = Result<(), AuditError>>,
    deadline: tokio::time::Instant,
) -> Result<(), AuditError> {
    tokio::time::timeout_at(deadline, write)
        .await
        .unwrap_or_else(|_| Err(AuditError::timed_out()))
}

/// An in-memory, hash-chained audit log. Durable storage is the audit store's job (M3); this is
/// the reference sink and the one tests use.
///
/// An entry is appended when [`AuditSink::append`] is called, before the returned future is
/// polled, so the order of the log is the order of the calls.
#[derive(Debug, Default)]
pub struct MemoryAuditLog {
    inner: Mutex<(AuditChain, Vec<AuditRecord>)>,
}

impl MemoryAuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn records(&self) -> Vec<AuditRecord> {
        self.lock().1.clone()
    }

    /// The entries of [`MemoryAuditLog::records`], in order.
    pub fn entries(&self) -> Vec<AuditEntry> {
        self.lock().1.iter().map(|r| r.entry.clone()).collect()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, (AuditChain, Vec<AuditRecord>)> {
        // A poisoned lock only means another append panicked; the chain itself is consistent.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl AuditSink for MemoryAuditLog {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        let mut guard = self.lock();
        let (chain, records) = &mut *guard;
        let record = chain.append(entry);
        records.push(record);
        Box::pin(std::future::ready(Ok(())))
    }
}
