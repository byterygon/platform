//! Audit of calls (Ambidex spec §8, Open questions 24g and 26).
//!
//! The [`Router`](crate::Router) records, in the shared `security_types` format and through one
//! asynchronous [`AuditSink`]:
//!
//! - every **refusal** by the authorizer, at dispatch or in [`Ctx::authorize`](crate::Ctx::authorize),
//!   as one entry. A refusal is refused whether or not the entry is written.
//! - every **call that runs**, of every kind and risk (human Read calls included), as two entries
//!   with the call's correlation id:
//!   - the **admission** ([`Outcome::Started`]), written and awaited after the authorizer allowed
//!     the call and before its handler runs;
//!   - the **completion**, written when the call ended: the handler's result as `outcome`
//!     (`Success`, or `Error` with its code), what the client actually received as
//!     [`Delivery`], the duration from frame receipt, and the highest risk the call was allowed
//!     at (a handler can escalate with `Ctx::authorize`).
//! - every allowed **re-check** inside a handler (`Ctx::authorize`) as one more `Started` entry,
//!   with its target and escalated risk, before `authorize` returns `Ok`.
//!
//! **Failing closed.** When an admission (or re-check) entry cannot be written — the sink fails,
//! does not answer within [`AuditPolicy::write_timeout`], or the router has no sink — a call with
//! risk Write or Destructive, and any call with an agent anywhere in its principal chain (Reads
//! included), does not run: it ends with `Unavailable`, retryable, because nothing ran. A human
//! Read call follows [`AuditPolicy::human_reads`]: by default it runs and the failure is
//! reported. Every failure goes to the router's [`AuditReporter`] (by default a rate-limited
//! line on stderr).
//!
//! **Completion.** Inside the engine, the engine writes the completion once it has chosen the
//! answer frame, so `delivery` is what went out: the handler's answer (`Delivered`), `Cancelled`
//! or `DeadlineExceeded` when the token fired first (the answer is then discarded, or the
//! handler was dropped after its grace), or `FrameTooLarge` when the answer did not fit a frame.
//! A handler dropped before it returned has the code it was cancelled with as its outcome. The
//! write runs in its own task, so it survives the call task being aborted, and the answer waits
//! for it at most `write_timeout`. Outside the engine (the MCP adapter calling the router
//! directly) the router writes it when the handler returns, as `Delivered`. A completion that
//! cannot be written is reported and never changes the answer: the handler already ran. A
//! `Started` entry without a matching completion therefore means the outcome is unknown: the
//! process crashed, or an admission write failed ambiguously and the client retried.

use std::sync::Arc;
use std::time::Duration;

use security_types::{
    Action, AuditDecision, AuditEntry, AuditEntryKind, AuditError, AuditFailure,
    AuditFailureEffect, AuditPrincipal, AuditReporter, AuditSink, Delivery, Digest, Outcome,
    Principal, PrincipalKind, Risk, StderrReporter, TargetRef, unix_now_ms,
};
use serde_json::Value;
use tokio::time::Instant;

use crate::message::{Code, ErrorPayload};

/// What the router does with a human Read call whose admission entry cannot be written.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum HumanReads {
    /// Run it and report the failure (the default, Open question 26c).
    #[default]
    RunAndReport,
    /// Refuse it with `Unavailable`, like a Write call.
    FailClosed,
}

/// How the router audits calls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AuditPolicy {
    pub human_reads: HumanReads,
    /// How long one entry may take to write before it counts as failed (a sink that hangs fails
    /// closed instead of holding the call). Provisional default: 5 s (Open question 26).
    pub write_timeout: Duration,
}

impl Default for AuditPolicy {
    fn default() -> Self {
        AuditPolicy {
            human_reads: HumanReads::RunAndReport,
            write_timeout: DEFAULT_WRITE_TIMEOUT,
        }
    }
}

/// Default of [`AuditPolicy::write_timeout`].
pub const DEFAULT_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

/// The router's sink, reporter and policy.
pub(crate) struct Recorder {
    sink: Option<Arc<dyn AuditSink>>,
    reporter: Arc<dyn AuditReporter>,
    policy: AuditPolicy,
}

/// What one admission (or re-check) is about.
pub(crate) struct Admission<'a> {
    pub principal: &'a Principal,
    pub action: Action,
    pub target: Option<&'a TargetRef>,
    pub risk: Risk,
    pub input_digest: Digest,
    pub correlation_id: &'a str,
}

impl Recorder {
    /// No sink: nothing can be recorded, so calls that must be recorded do not run.
    pub(crate) fn new() -> Recorder {
        Recorder {
            sink: None,
            reporter: Arc::new(StderrReporter::new()),
            policy: AuditPolicy::default(),
        }
    }

    pub(crate) fn with_sink(&self, sink: Arc<dyn AuditSink>) -> Recorder {
        Recorder {
            sink: Some(sink),
            reporter: Arc::clone(&self.reporter),
            policy: self.policy,
        }
    }

    pub(crate) fn with_reporter(&self, reporter: Arc<dyn AuditReporter>) -> Recorder {
        Recorder {
            sink: self.sink.clone(),
            reporter,
            policy: self.policy,
        }
    }

    pub(crate) fn with_policy(&self, policy: AuditPolicy) -> Recorder {
        Recorder {
            sink: self.sink.clone(),
            reporter: Arc::clone(&self.reporter),
            policy,
        }
    }

    /// Writes one entry, waiting at most the write timeout.
    async fn write(&self, entry: AuditEntry) -> Result<(), AuditError> {
        let Some(sink) = &self.sink else {
            return Err(AuditError("no audit sink configured".into()));
        };
        write(&**sink, entry, self.policy.write_timeout).await
    }

    fn report(
        &self,
        entry: AuditEntryKind,
        effect: AuditFailureEffect,
        of: &AuditEntry,
        error: AuditError,
    ) {
        self.reporter.report(&AuditFailure {
            entry,
            effect,
            action: of.action.name.clone(),
            correlation_id: of.correlation_id.clone(),
            error,
            attempts: 1,
        });
    }

    /// Records a refusal. The call is refused whatever happens here.
    pub(crate) async fn refusal(&self, entry: AuditEntry) {
        if let Err(error) = self.write(entry.clone()).await {
            self.report(
                AuditEntryKind::Refusal,
                AuditFailureEffect::EntryLost,
                &entry,
                error,
            );
        }
    }

    /// Whether a call or re-check that cannot be recorded must not run: Write and Destructive
    /// risk, an agent anywhere in the chain, or a human Read under [`HumanReads::FailClosed`].
    fn fails_closed(&self, principal: &Principal, risk: Risk) -> bool {
        risk >= Risk::Write
            || acts_as_agent(principal)
            || self.policy.human_reads == HumanReads::FailClosed
    }

    /// Writes a `Started` entry for an allowed call or re-check. `Err` means it must not run;
    /// `Ok(true)` that the entry is recorded, `Ok(false)` that it runs unrecorded.
    pub(crate) async fn admit(&self, admission: &Admission<'_>) -> Result<bool, ()> {
        let entry = started(admission);
        let Err(error) = self.write(entry.clone()).await else {
            return Ok(true);
        };
        let blocked = self.fails_closed(admission.principal, admission.risk);
        let effect = if blocked {
            AuditFailureEffect::Blocked
        } else {
            AuditFailureEffect::RanUnrecorded
        };
        self.report(AuditEntryKind::Admission, effect, &entry, error);
        if blocked { Err(()) } else { Ok(false) }
    }

    /// The completion of an admitted call, to fill in and write when it ends. `None` without a
    /// sink: there is nowhere to write it, and the admission failure was already reported.
    pub(crate) fn completion(
        self: &Arc<Self>,
        admission: &Admission<'_>,
        start: Instant,
    ) -> Option<Completion> {
        self.sink.as_ref()?;
        Some(Completion {
            recorder: Arc::clone(self),
            entry: started(admission),
            start,
            outcome: None,
            risk: admission.risk,
            written: false,
        })
    }
}

/// `entry`, waiting at most `timeout`.
async fn write(
    sink: &dyn AuditSink,
    entry: AuditEntry,
    timeout: Duration,
) -> Result<(), AuditError> {
    match tokio::time::timeout(timeout, sink.append(entry)).await {
        Ok(result) => result,
        Err(_) => Err(AuditError("write timed out".into())),
    }
}

/// The admission entry.
fn started(admission: &Admission<'_>) -> AuditEntry {
    AuditEntry {
        timestamp_unix_ms: unix_now_ms(),
        principal_chain: AuditPrincipal::chain_of(admission.principal),
        tenant: admission.principal.tenant.clone(),
        action: admission.action.clone(),
        target: admission.target.cloned(),
        risk: admission.risk,
        decision: AuditDecision::Allow,
        approval_id: None,
        outcome: Outcome::Started,
        duration_ms: None,
        correlation_id: admission.correlation_id.to_owned(),
        input_digest: admission.input_digest,
        statement_digest: None,
        delivery: None,
    }
}

/// The answer a call whose admission entry could not be written gets: nothing ran, so the
/// client may retry.
pub(crate) fn unavailable() -> ErrorPayload {
    let mut err = ErrorPayload::new(
        Code::Unavailable,
        "audit log unavailable; the call did not run",
    );
    err.retryable = true;
    err
}

/// Whether an agent is anywhere in the principal's `on_behalf_of` chain.
pub(crate) fn acts_as_agent(principal: &Principal) -> bool {
    principal.chain().any(|p| p.kind == PrincipalKind::Agent)
}

/// The wire name of `code`, e.g. `"PermissionDenied"`.
pub(crate) fn code_name(code: Code) -> String {
    match serde_json::to_value(code) {
        Ok(Value::String(name)) => name,
        _ => format!("{code:?}"),
    }
}

/// The audit outcome of what a call returned.
pub(crate) fn outcome_of<T>(result: &Result<T, ErrorPayload>) -> Outcome {
    match result {
        Ok(_) => Outcome::Success,
        Err(err) => Outcome::Error {
            code: code_name(err.code),
        },
    }
}

/// What the client gets instead of the answer once the token fired with `reason`.
pub(crate) fn delivery_for(reason: Code) -> Delivery {
    match reason {
        Code::DeadlineExceeded => Delivery::DeadlineExceeded,
        // A subscription whose event did not fit its buffer or a frame.
        Code::ResourceExhausted => Delivery::FrameTooLarge,
        _ => Delivery::Cancelled,
    }
}

/// The completion entry of an admitted call, waiting for the call to end.
///
/// Written exactly once: by [`Completion::finish`] when the call ends normally, or, if the call
/// is dropped before that (the connection closed and its tasks were aborted, or a panic), from
/// `Drop` on a task of its own, as `Cancelled`.
pub(crate) struct Completion {
    recorder: Arc<Recorder>,
    /// The admission entry it completes.
    entry: AuditEntry,
    start: Instant,
    /// What the handler returned, once it did.
    outcome: Option<Outcome>,
    /// The highest risk the call was allowed at.
    risk: Risk,
    written: bool,
}

impl Completion {
    pub(crate) fn record_outcome(&mut self, outcome: Outcome) {
        self.outcome = Some(outcome);
    }

    pub(crate) fn raise_risk(&mut self, risk: Risk) {
        self.risk = self.risk.max(risk);
    }

    /// Writes the completion, for a call that ended with `delivery`. `reason` is the code the
    /// call was cancelled with, used as the outcome if the handler never returned.
    pub(crate) async fn finish(mut self, delivery: Delivery, reason: Code) {
        self.written = true;
        let entry = self.entry(delivery, reason);
        let recorder = Arc::clone(&self.recorder);
        let task = async move { recorder.complete(entry).await };
        // Its own task, so the write survives the call task being aborted (a connection that
        // closes drops its calls after the grace period). It is bounded by the write timeout.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                let _ = runtime.spawn(task).await;
            }
            Err(_) => task.await,
        }
    }

    fn entry(&self, delivery: Delivery, reason: Code) -> AuditEntry {
        let outcome = self.outcome.clone().unwrap_or_else(|| Outcome::Error {
            code: code_name(reason),
        });
        let duration = Instant::now().saturating_duration_since(self.start);
        AuditEntry {
            timestamp_unix_ms: unix_now_ms(),
            target: None,
            risk: self.risk,
            outcome,
            duration_ms: Some(u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)),
            delivery: Some(delivery),
            ..self.entry.clone()
        }
    }
}

impl Recorder {
    async fn complete(&self, entry: AuditEntry) {
        if let Err(error) = self.write(entry.clone()).await {
            self.report(
                AuditEntryKind::Completion,
                AuditFailureEffect::EntryLost,
                &entry,
                error,
            );
        }
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        if self.written {
            return;
        }
        // The call was dropped before it ended normally: the client got nothing, or an error
        // the engine made up (a panic answers `Internal`).
        let entry = self.entry(Delivery::Cancelled, Code::Cancelled);
        let recorder = Arc::clone(&self.recorder);
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move { recorder.complete(entry).await });
            }
            Err(_) => recorder.report(
                AuditEntryKind::Completion,
                AuditFailureEffect::EntryLost,
                &entry,
                AuditError("no runtime to write the completion".into()),
            ),
        }
    }
}
