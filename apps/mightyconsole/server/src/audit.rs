//! The call log of v0.1 (Mightyconsole spec §2.3, "Audit").
//!
//! v0.1 has no audit log (DOC-20 section 1), but the Ambidex router refuses Write and
//! Destructive calls whose admission entry cannot be written. [`LogAuditSink`] accepts every
//! entry and writes one line to the server log (stderr) for each admission and completion of a
//! Write or Destructive call, and for each refusal: procedure, correlation id, risk, outcome and
//! duration. Never inputs: entries carry only their digest, which is not printed either.
//!
//! Read calls are accepted silently, and so are the terminal's own input calls (`term.write`,
//! `term.resize`: one per keystroke batch) and an Object Store upload's parts
//! (`nats.obj.uploadPart`: one per 4 MiB; its start and finish are logged), which would otherwise
//! flood the log; recorded in the spec's Open questions.

use std::io::Write as _;
use std::sync::Arc;

use security_types::{AuditDecision, AuditEntry, AuditError, AuditSink, BoxFuture, Outcome, Risk};

/// Where the lines go: stderr, or a buffer in tests.
pub trait LineWriter: Send + Sync + 'static {
    fn line(&self, line: &str);
}

/// Writes to the process's stderr.
pub struct Stderr;

impl LineWriter for Stderr {
    fn line(&self, line: &str) {
        let _ = writeln!(std::io::stderr().lock(), "{line}");
    }
}

/// See the [module docs](self).
pub struct LogAuditSink {
    out: Arc<dyn LineWriter>,
}

impl LogAuditSink {
    pub fn new(out: Arc<dyn LineWriter>) -> LogAuditSink {
        LogAuditSink { out }
    }

    /// The line for an entry, or `None` when it is not logged.
    pub fn format(entry: &AuditEntry) -> Option<String> {
        let name = entry.action.name.as_str();
        let refused = matches!(entry.decision, AuditDecision::Deny { .. });
        let quiet = matches!(name, "term.write" | "term.resize" | "nats.obj.uploadPart");
        if !refused && (entry.risk == Risk::Read || quiet) {
            return None;
        }
        let what = match (&entry.decision, &entry.outcome) {
            (AuditDecision::Deny { .. }, _) => "refused".to_owned(),
            (_, Outcome::Started) => "started".to_owned(),
            (_, Outcome::Success) => "ok".to_owned(),
            (_, Outcome::Error { code }) => format!("error {code}"),
        };
        let risk = match entry.risk {
            Risk::Read => "read",
            Risk::Write => "write",
            Risk::Destructive => "destructive",
        };
        let duration = entry
            .duration_ms
            .map(|ms| format!(" {ms} ms"))
            .unwrap_or_default();
        Some(format!(
            "mightyconsole-server: call {name} {risk} {what}{duration} ({})",
            entry.correlation_id
        ))
    }
}

impl AuditSink for LogAuditSink {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if let Some(line) = Self::format(&entry) {
            self.out.line(&line);
        }
        Box::pin(std::future::ready(Ok(())))
    }
}
