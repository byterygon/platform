//! Reporting audit sink failures (Ambidex spec Open question 26d).
//!
//! When an entry cannot be written, the operation either does not run (fail closed), runs anyway
//! (human Read calls fail open), or has already happened (a completion, a refusal, a revocation).
//! Either way an operator must hear about it, and the log itself cannot tell them. Ambidex's router
//! and Plugin Host's grant store hand every such failure to an [`AuditReporter`] as a structured
//! [`AuditFailure`], so an application can forward it to its own logging (e.g. `tracing`); the
//! default, [`StderrReporter`], writes one rate-limited line per failure.
//!
//! A failure carries no input, principal ids or error details: only the action name, the
//! correlation id (to find the call), which entry failed, what happened to the operation, and the
//! sink's own message, which sinks must keep free of secrets.

use std::fmt;
use std::io::Write as _;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::sink::AuditError;

/// Which entry could not be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuditEntryKind {
    /// Written before an operation runs ([`Outcome::Started`](crate::Outcome::Started)): an Ambidex
    /// call's admission, or an allowed re-check inside a running call.
    Admission,
    /// Written after an Ambidex call ended, with its outcome and delivery.
    Completion,
    /// A refusal (`Deny` or `NeedsApproval`).
    Refusal,
    /// An operation recorded in one entry (Plugin Host broker and grant operations).
    Operation,
}

/// What happened to the operation whose entry could not be written.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AuditFailureEffect {
    /// It did not run (fail closed).
    Blocked,
    /// It ran without the entry (fail open: human Read calls).
    RanUnrecorded,
    /// It had already happened, or was refused anyway; only the entry is missing.
    EntryLost,
}

/// One audit sink failure, as reported to an [`AuditReporter`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditFailure {
    pub entry: AuditEntryKind,
    pub effect: AuditFailureEffect,
    /// The audited action, e.g. `"query.execute"` or `"plugin-host.grants.revoke"`.
    pub action: String,
    pub correlation_id: String,
    /// The sink's error, or why the write was given up (e.g. it timed out).
    pub error: AuditError,
    /// Writes attempted, including retries (1 when there was no retry).
    pub attempts: u32,
}

impl fmt::Display for AuditFailure {
    /// One line, with every string quoted and escaped so a message cannot break the line.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entry = match self.entry {
            AuditEntryKind::Admission => "admission",
            AuditEntryKind::Completion => "completion",
            AuditEntryKind::Refusal => "refusal",
            AuditEntryKind::Operation => "operation",
        };
        let effect = match self.effect {
            AuditFailureEffect::Blocked => "blocked",
            AuditFailureEffect::RanUnrecorded => "ran-unrecorded",
            AuditFailureEffect::EntryLost => "entry-lost",
        };
        write!(
            f,
            "audit sink failure: entry={entry} effect={effect} action={:?} correlation_id={:?} \
             attempts={} error={:?}",
            self.action, self.correlation_id, self.attempts, self.error.0
        )
    }
}

/// Receives audit sink failures. Called inline on the path that saw the failure, so it must be
/// quick and must not block.
pub trait AuditReporter: Send + Sync + 'static {
    fn report(&self, failure: &AuditFailure);
}

impl<R: AuditReporter + ?Sized> AuditReporter for std::sync::Arc<R> {
    fn report(&self, failure: &AuditFailure) {
        (**self).report(failure)
    }
}

/// The default reporter: one line per failure on stderr, at most [`StderrReporter::BURST`] lines
/// per [`StderrReporter::WINDOW`]. Failures beyond that are counted, and the next line written
/// says how many were suppressed, so a failing sink under load cannot flood the log.
#[derive(Debug)]
pub struct StderrReporter {
    limiter: Mutex<Limiter>,
}

impl StderrReporter {
    /// Lines written per window (provisional, Ambidex spec Open question 26).
    pub const BURST: u32 = 10;
    /// Length of the rate-limit window (provisional, Ambidex spec Open question 26).
    pub const WINDOW: Duration = Duration::from_secs(10);

    pub fn new() -> Self {
        Self {
            limiter: Mutex::new(Limiter::new(Self::BURST, Self::WINDOW)),
        }
    }

    /// The lines one failure produces at `now`: none when rate-limited, otherwise the failure,
    /// preceded by a count of the failures suppressed before it.
    fn lines(&self, failure: &AuditFailure, now: Instant) -> Vec<String> {
        let admitted = self
            .limiter
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .admit(now);
        let Some(suppressed) = admitted else {
            return Vec::new();
        };
        let mut lines = Vec::with_capacity(2);
        if suppressed > 0 {
            lines.push(format!(
                "audit sink failure: {suppressed} more reports suppressed"
            ));
        }
        lines.push(failure.to_string());
        lines
    }
}

impl Default for StderrReporter {
    fn default() -> Self {
        Self::new()
    }
}

impl AuditReporter for StderrReporter {
    fn report(&self, failure: &AuditFailure) {
        let lines = self.lines(failure, Instant::now());
        if lines.is_empty() {
            return;
        }
        let mut stderr = std::io::stderr().lock();
        for line in lines {
            // Nothing sensible to do if stderr itself fails.
            let _ = writeln!(stderr, "{line}");
        }
    }
}

/// Fixed-window rate limit.
#[derive(Debug)]
struct Limiter {
    burst: u32,
    window: Duration,
    window_start: Option<Instant>,
    used: u32,
    suppressed: u64,
}

impl Limiter {
    fn new(burst: u32, window: Duration) -> Self {
        Self {
            burst,
            window,
            window_start: None,
            used: 0,
            suppressed: 0,
        }
    }

    /// `Some(n)` if a line may be written at `now`, with `n` the lines suppressed since the last
    /// one written; `None` if this one is suppressed.
    fn admit(&mut self, now: Instant) -> Option<u64> {
        let expired = self
            .window_start
            .is_none_or(|start| now.saturating_duration_since(start) >= self.window);
        if expired {
            self.window_start = Some(now);
            self.used = 0;
        }
        if self.used >= self.burst {
            self.suppressed += 1;
            return None;
        }
        self.used += 1;
        Some(std::mem::take(&mut self.suppressed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(n: u32) -> AuditFailure {
        AuditFailure {
            entry: AuditEntryKind::Admission,
            effect: AuditFailureEffect::Blocked,
            action: "query.execute".into(),
            correlation_id: format!("c-{n}"),
            error: AuditError("disk full".into()),
            attempts: 1,
        }
    }

    #[test]
    fn line_is_one_escaped_line() {
        let mut f = failure(1);
        f.error = AuditError("bad\nline \"quoted\"".into());
        let line = f.to_string();
        assert!(!line.contains('\n'));
        assert_eq!(
            line,
            "audit sink failure: entry=admission effect=blocked action=\"query.execute\" \
             correlation_id=\"c-1\" attempts=1 error=\"bad\\nline \\\"quoted\\\"\""
        );
    }

    #[test]
    fn stderr_reporter_is_rate_limited_and_counts_what_it_dropped() {
        let reporter = StderrReporter::new();
        let start = Instant::now();
        let burst = StderrReporter::BURST;
        for n in 0..burst {
            assert_eq!(reporter.lines(&failure(n), start).len(), 1);
        }
        // Over the burst within the window: nothing is written.
        for n in 0..5 {
            assert!(reporter.lines(&failure(burst + n), start).is_empty());
        }
        // The next window starts with a count of the suppressed reports.
        let later = start + StderrReporter::WINDOW;
        let lines = reporter.lines(&failure(99), later);
        assert_eq!(
            lines,
            [
                "audit sink failure: 5 more reports suppressed".to_owned(),
                failure(99).to_string()
            ]
        );
        assert_eq!(reporter.lines(&failure(100), later).len(), 1);
    }
}
