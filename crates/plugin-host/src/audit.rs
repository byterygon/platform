//! Where Plugin Host audit entries go, and the clock that stamps them.
//!
//! Entries use the shared [`AuditEntry`] format from `security-types`, so Plugin Host and Ambidex
//! records can share one hash-chained log. Entries never contain credentials, secret references or
//! payload bytes.

use std::fmt;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use security_types::{AuditChain, AuditEntry, AuditRecord};

/// Receives audit entries. Operations fail closed when the sink fails: an action that cannot be
/// audited is not performed.
pub trait AuditSink: Send + Sync + 'static {
    fn append(&self, entry: AuditEntry) -> Result<(), AuditError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditError(pub String);

impl fmt::Display for AuditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "audit sink failed: {}", self.0)
    }
}

impl std::error::Error for AuditError {}

/// An in-memory, hash-chained audit log. Durable storage is the audit store's job (M3); this is
/// the reference sink and the one tests use.
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

    fn lock(&self) -> std::sync::MutexGuard<'_, (AuditChain, Vec<AuditRecord>)> {
        // A poisoned lock only means another append panicked; the chain itself is consistent.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

impl AuditSink for MemoryAuditLog {
    fn append(&self, entry: AuditEntry) -> Result<(), AuditError> {
        let mut guard = self.lock();
        let (chain, records) = &mut *guard;
        let record = chain.append(entry);
        records.push(record);
        Ok(())
    }
}

/// Wall-clock time in Unix milliseconds, used for grant expiry and audit timestamps.
pub trait Clock: Send + Sync + 'static {
    fn now_unix_ms(&self) -> u64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
    }
}
