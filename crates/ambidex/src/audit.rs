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
//! **Completion.** Inside the engine, the completion travels with the call's answer frame (Open
//! question 26 item 11). When the engine chooses the frame it fixes the outcome, the duration and
//! the delivery that frame stands for: the handler's answer (`Delivered`), `Cancelled` or
//! `DeadlineExceeded` when the token fired first (the answer is then discarded, or the handler
//! was dropped after its grace), or `FrameTooLarge` when the answer did not fit a frame. The
//! completion is written with that delivery only once the transport accepted the frame
//! (`TransportTx::send` returned `Ok`), in the background, bounded by `write_timeout`; the
//! answer never waits for it. A frame dropped before that (Unsubscribe, the connection closed,
//! its queue discarded, a send error) completes as `Cancelled`, from the drop guard. The writes
//! of one connection are tracked (`Completions`) and bounded (`Rooms`): at most
//! `max_concurrent_calls` are owed or running, a call frame waits for room while the connection
//! keeps reading the client's other frames, and closing waits for the writes, each of which ends
//! by its own write timeout. One that is never written (stopped at close, or dropped with its
//! runtime) is reported as `EntryLost`, like one the sink refused. Loss after
//! the transport accepted the frame is not detected. A handler dropped before it returned has
//! the code it was cancelled with as its outcome. Outside the engine (the MCP adapter calling the
//! router directly), and for a call a handler makes to another procedure (which runs under a
//! scope of its own, with its own correlation id and its caller's as
//! `parent_correlation_id`), the router writes it when the handler returns, as `Delivered`. A
//! completion that cannot be written is reported and never changes the answer: the handler
//! already ran. A
//! `Started` entry without a matching completion therefore means the outcome is unknown: the
//! process crashed, or an admission write failed ambiguously and the client retried.

use std::sync::Arc;
use std::time::Duration;

use security_types::{
    Action, AuditDecision, AuditEntry, AuditEntryKind, AuditError, AuditFailure,
    AuditFailureEffect, AuditPrincipal, AuditReporter, AuditSink, Delivery, Digest, Outcome,
    Principal, PrincipalKind, Risk, StderrReporter, TargetRef, append_within, unix_now_ms,
};
use serde_json::Value;
use tokio::time::Instant;

use crate::cancel::CallScope;
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
#[derive(Clone)]
pub(crate) struct Recorder {
    sink: Option<Arc<dyn AuditSink>>,
    reporter: Arc<dyn AuditReporter>,
    policy: AuditPolicy,
    /// Completion writes of calls outside the engine (the MCP adapter calling the router, and
    /// calls their handlers make), shared by every such call of this router. Nothing closes it:
    /// those callers await their completion, and a write dropped with its runtime is reported.
    outside: Completions,
}

/// What one admission (or re-check) is about.
pub(crate) struct Admission<'a> {
    pub principal: &'a Principal,
    pub action: Action,
    pub target: Option<&'a TargetRef>,
    pub risk: Risk,
    pub input_digest: Digest,
    pub correlation_id: &'a str,
    /// The calling call's id, for a call made from inside another call's handler.
    pub parent_correlation_id: Option<&'a str>,
}

impl Recorder {
    /// No sink: nothing can be recorded, so calls that must be recorded do not run.
    pub(crate) fn new() -> Recorder {
        Recorder {
            sink: None,
            reporter: Arc::new(StderrReporter::new()),
            policy: AuditPolicy::default(),
            outside: Completions::new(),
        }
    }

    pub(crate) fn with_sink(&self, sink: Arc<dyn AuditSink>) -> Recorder {
        let mut recorder = self.clone();
        recorder.sink = Some(sink);
        recorder
    }

    pub(crate) fn with_reporter(&self, reporter: Arc<dyn AuditReporter>) -> Recorder {
        let mut recorder = self.clone();
        recorder.reporter = reporter;
        recorder
    }

    pub(crate) fn with_policy(&self, policy: AuditPolicy) -> Recorder {
        let mut recorder = self.clone();
        recorder.policy = policy;
        recorder
    }

    /// Writes one entry, waiting at most the write timeout. On failure the reporter hears about
    /// it as `kind` with `effect`; the caller decides what the failure means for the call.
    async fn write(
        &self,
        entry: AuditEntry,
        kind: AuditEntryKind,
        effect: impl FnOnce() -> AuditFailureEffect,
    ) -> Result<(), ()> {
        let deadline = Instant::now() + self.policy.write_timeout;
        self.write_by(entry, kind, effect, deadline).await
    }

    /// [`Recorder::write`] with the deadline given: a write queued earlier keeps the deadline
    /// it was given when queued, whenever its task first runs.
    async fn write_by(
        &self,
        entry: AuditEntry,
        kind: AuditEntryKind,
        effect: impl FnOnce() -> AuditFailureEffect,
        deadline: Instant,
    ) -> Result<(), ()> {
        // Kept for the report: the entry itself moves into the sink.
        let action = entry.action.name.clone();
        let correlation_id = entry.correlation_id.clone();
        let result = match &self.sink {
            Some(sink) => append_within(&**sink, entry, deadline).await,
            None => Err(AuditError("no audit sink configured".into())),
        };
        let Err(error) = result else {
            return Ok(());
        };
        self.reporter.report(&AuditFailure {
            entry: kind,
            effect: effect(),
            action,
            correlation_id,
            error,
            attempts: 1,
        });
        Err(())
    }

    /// Records a refusal. The call is refused whatever happens here.
    pub(crate) async fn refusal(&self, entry: AuditEntry) {
        let _ = self
            .write(entry, AuditEntryKind::Refusal, || {
                AuditFailureEffect::EntryLost
            })
            .await;
    }

    /// Whether a call or re-check that cannot be recorded must not run: Write and Destructive
    /// risk, an agent anywhere in the chain, or a human Read under [`HumanReads::FailClosed`].
    fn fails_closed(&self, principal: &Principal, risk: Risk) -> bool {
        risk >= Risk::Write
            || acts_as_agent(principal)
            || self.policy.human_reads == HumanReads::FailClosed
    }

    /// Writes a `Started` entry for an allowed re-check. `Err` means the work it guards must not
    /// run (see [`Recorder::fails_closed`]).
    pub(crate) async fn recheck(&self, admission: &Admission<'_>) -> Result<(), ()> {
        self.write_started(started(admission), admission).await
    }

    /// Writes the admission entry of a call that started at `start`. `Err` means it must not run.
    /// Otherwise its completion, to fill in and write when the call ends; `None` without a sink:
    /// there is nowhere to write it, and the admission failure was already reported.
    pub(crate) async fn admit(
        self: &Arc<Self>,
        admission: &Admission<'_>,
        scope: &CallScope,
    ) -> Result<Option<Completion>, ()> {
        let entry = started(admission);
        // The completion repeats the admission entry; built only once the call may run, so a
        // blocked call leaves no completion behind.
        let base = self.sink.is_some().then(|| entry.clone());
        self.write_started(entry, admission).await?;
        Ok(base.map(|entry| Completion {
            recorder: Arc::clone(self),
            completions: scope.completions().unwrap_or(&self.outside).clone(),
            room: scope.take_room(),
            entry,
            start: scope.start(),
            ended: None,
            outcome: None,
            risk: admission.risk,
            written: false,
        }))
    }

    async fn write_started(&self, entry: AuditEntry, admission: &Admission<'_>) -> Result<(), ()> {
        let blocked = self.fails_closed(admission.principal, admission.risk);
        let effect = || {
            if blocked {
                AuditFailureEffect::Blocked
            } else {
                AuditFailureEffect::RanUnrecorded
            }
        };
        match self.write(entry, AuditEntryKind::Admission, effect).await {
            Err(()) if blocked => Err(()),
            _ => Ok(()),
        }
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
        parent_correlation_id: admission.parent_correlation_id.map(str::to_owned),
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
/// Written exactly once, through its [`Completions`] queue: by [`Completion::finish`] when a
/// call outside the engine ends, by [`Armed::sent`] when the transport accepted an engine call's
/// answer frame, or, if it is dropped before either (the call task was aborted, or its frame was
/// dropped unsent), from `Drop`, as `Cancelled`. It holds the call's [`Room`] in the queue until
/// its write ends.
pub(crate) struct Completion {
    recorder: Arc<Recorder>,
    /// Where its write runs.
    completions: Completions,
    room: Option<Room>,
    /// The admission entry it completes.
    entry: AuditEntry,
    start: Instant,
    /// When the call ended, once [armed](Completion::arm), on the monotonic clock (for the
    /// duration) and the wall clock (for the timestamp): the entry records when the call ended,
    /// not when its frame went out.
    ended: Option<(Instant, u64)>,
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

    /// The call ended and its answer frame stands for `delivery`: fixes the outcome (`reason`,
    /// the code it was stopped with, if the handler never returned), the duration and the
    /// timestamp, for a completion written once the frame's fate is known.
    pub(crate) fn arm(mut self, delivery: Delivery, reason: Code) -> Armed {
        if self.outcome.is_none() {
            self.outcome = Some(Outcome::Error {
                code: code_name(reason),
            });
        }
        self.ended = Some((Instant::now(), unix_now_ms()));
        Armed {
            completion: self,
            delivery,
        }
    }

    /// Writes the completion of a call outside the engine, which ended with `delivery`, and
    /// waits for the write. `reason` is the code the call was stopped with, the outcome if the
    /// handler never returned.
    pub(crate) async fn finish(self, delivery: Delivery, reason: Code) {
        if let Some(write) = self.arm(delivery, reason).sent() {
            // The write is its own tracked task, so it survives this future being dropped.
            let _ = write.await;
        }
    }

    /// Hands the entry to the queue, with the delivery the client got.
    fn write(&mut self, delivery: Delivery) -> Option<tokio::sync::oneshot::Receiver<()>> {
        self.written = true;
        let entry = self.entry(delivery);
        self.completions
            .spawn(&self.recorder, entry, self.room.take())
    }

    fn entry(&self, delivery: Delivery) -> AuditEntry {
        // Only a completion dropped before it was armed has no outcome: its call never ended
        // normally.
        let outcome = self.outcome.clone().unwrap_or_else(|| Outcome::Error {
            code: code_name(Code::Cancelled),
        });
        let (end, timestamp) = self
            .ended
            .unwrap_or_else(|| (Instant::now(), unix_now_ms()));
        let duration = end.saturating_duration_since(self.start);
        AuditEntry {
            timestamp_unix_ms: timestamp,
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
    /// Writes a completion, giving up at `deadline`.
    async fn complete(&self, entry: AuditEntry, deadline: Instant) {
        let _ = self
            .write_by(
                entry,
                AuditEntryKind::Completion,
                || AuditFailureEffect::EntryLost,
                deadline,
            )
            .await;
    }

    fn report_lost(&self, action: String, correlation_id: String, why: &str) {
        self.reporter.report(&AuditFailure {
            entry: AuditEntryKind::Completion,
            effect: AuditFailureEffect::EntryLost,
            action,
            correlation_id,
            error: AuditError(why.into()),
            attempts: 1,
        });
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        if !self.written {
            // The call, or its answer frame, was dropped before the client got it.
            let _ = self.write(Delivery::Cancelled);
        }
    }
}

/// A completion travelling with its call's answer frame. Dropped unsent, it completes as
/// `Cancelled` (the drop guard of [`Completion`]).
pub(crate) struct Armed {
    completion: Completion,
    /// What the client gets once the frame is sent.
    delivery: Delivery,
}

impl Armed {
    /// The transport accepted the frame: writes the completion with its delivery, on a tracked
    /// task, so the connection's writer never waits on the sink. The handle is for a caller that
    /// does wait ([`Completion::finish`]); `None` when there was no runtime to write it on (it
    /// was reported lost).
    pub(crate) fn sent(self) -> Option<tokio::sync::oneshot::Receiver<()>> {
        let Armed {
            mut completion,
            delivery,
        } = self;
        completion.write(delivery)
    }
}

/// A call's place in its connection's [`Rooms`]: taken by the engine before it starts the call,
/// held by the call's completion until that is written.
pub(crate) struct Room(#[allow(dead_code)] tokio::sync::OwnedSemaphorePermit);

/// Room for a connection's audit completions (Open question 26 item 11): at most `bound` calls
/// at a time have a completion owed or being written. When none is free the engine starts no new
/// call until a completion is written, so a slow sink slows down new calls, not the answers
/// already chosen.
#[derive(Clone)]
pub(crate) struct Rooms(Arc<tokio::sync::Semaphore>);

impl Rooms {
    /// Room for `bound` calls (at least one).
    pub(crate) fn new(bound: usize) -> Rooms {
        Rooms(Arc::new(tokio::sync::Semaphore::new(bound.max(1))))
    }

    /// A place, if one is free now.
    pub(crate) fn try_take(&self) -> Option<Room> {
        Arc::clone(&self.0).try_acquire_owned().ok().map(Room)
    }

    /// Waits for a place.
    pub(crate) async fn take(&self) -> Room {
        let permit = Arc::clone(&self.0).acquire_owned().await;
        // The semaphore is never closed.
        Room(permit.expect("rooms are never closed"))
    }
}

/// Completion writes, each on a task tracked in a [`JoinSet`](tokio::task::JoinSet) (Open
/// question 26 item 11): one queue per connection, and one per router for calls outside the
/// engine.
///
/// [`Completions::close`] waits for the writes. Each ends by itself within its write timeout
/// (the recorder reports a write that failed or timed out); only one still running
/// [`ABORT_GRACE`] after the last write's timeout is aborted. A write that ends without being
/// written, aborted or dropped with its runtime, is reported as `EntryLost`, so no completion
/// disappears unreported.
#[derive(Clone)]
pub(crate) struct Completions {
    inner: Arc<std::sync::Mutex<Tracked>>,
}

#[derive(Default)]
struct Tracked {
    tasks: tokio::task::JoinSet<()>,
    /// When the last write started so far must have ended by its own timeout.
    latest: Option<Instant>,
}

impl Completions {
    pub(crate) fn new() -> Completions {
        Completions {
            inner: Arc::default(),
        }
    }

    /// Writes `entry` on a tracked task, which holds `room` until it ends. The receiver
    /// resolves once the write ended, for a caller that waits ([`Completion::finish`]); `None`
    /// when there was no runtime to write it on (it was reported lost).
    fn spawn(
        &self,
        recorder: &Arc<Recorder>,
        entry: AuditEntry,
        room: Option<Room>,
    ) -> Option<tokio::sync::oneshot::Receiver<()>> {
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            recorder.report_lost(
                entry.action.name,
                entry.correlation_id,
                "no runtime to write the completion",
            );
            return None;
        };
        let (ended, wait) = tokio::sync::oneshot::channel();
        let mut write = Write {
            recorder: Arc::clone(recorder),
            action: entry.action.name.clone(),
            correlation_id: entry.correlation_id.clone(),
            done: false,
            _room: room,
        };
        let mut tracked = lock(&self.inner);
        // Forget the writes that already ended.
        while tracked.tasks.try_join_next().is_some() {}
        // The write's own deadline, fixed now: `close` waits for it from the same instant, so it
        // never aborts a write before that write's own timeout, however late its task runs.
        let ends = Instant::now() + recorder.policy.write_timeout;
        tracked.latest = Some(tracked.latest.map_or(ends, |latest| latest.max(ends)));
        // Spawned under the lock, so `close` can always abort it.
        tracked.tasks.spawn_on(
            async move {
                write.recorder.complete(entry, ends).await;
                write.finished();
                let _ = ended.send(());
            },
            &runtime,
        );
        Some(wait)
    }

    /// Waits until every write has ended; aborts any still running [`ABORT_GRACE`] after the
    /// last one's write timeout, which reports them lost.
    pub(crate) async fn close(&self) {
        // Writes started meanwhile (drop guards) go to a fresh set, taken on the next round.
        loop {
            let (mut tasks, latest) = {
                let mut tracked = lock(&self.inner);
                (std::mem::take(&mut tracked.tasks), tracked.latest)
            };
            let Some(latest) = latest.filter(|_| !tasks.is_empty()) else {
                return;
            };
            let ended = tokio::time::timeout_at(latest + ABORT_GRACE, join_all(&mut tasks)).await;
            if ended.is_err() {
                tasks.abort_all();
                // Each aborted write's guard reports it as it is dropped.
                join_all(&mut tasks).await;
            }
        }
    }
}

async fn join_all(tasks: &mut tokio::task::JoinSet<()>) {
    while tasks.join_next().await.is_some() {}
}

/// How long after the last write's own timeout [`Completions::close`] waits before aborting
/// what still runs: a write gives up through its own timeout first, and the recorder reports
/// what happened to it.
const ABORT_GRACE: Duration = Duration::from_millis(100);

/// One completion write in flight. Dropped before it was done (aborted, or with its runtime), it
/// reports the entry lost.
struct Write {
    recorder: Arc<Recorder>,
    action: String,
    correlation_id: String,
    done: bool,
    _room: Option<Room>,
}

impl Write {
    /// The recorder wrote the entry, or reported why it could not.
    fn finished(&mut self) {
        self.done = true;
    }
}

impl Drop for Write {
    fn drop(&mut self) {
        if !self.done {
            self.recorder.report_lost(
                std::mem::take(&mut self.action),
                std::mem::take(&mut self.correlation_id),
                "the completion write was stopped before it finished",
            );
        }
    }
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use security_types::{Action, AuditDecision, AuditPrincipal, Digest, Outcome, Risk, TenantId};

    use super::*;

    /// Records entries after `delay`, or never answers (`None`).
    struct Slow {
        delay: Option<Duration>,
        entries: Arc<Mutex<Vec<AuditEntry>>>,
    }

    impl AuditSink for Slow {
        fn append(
            &self,
            entry: AuditEntry,
        ) -> security_types::BoxFuture<'_, Result<(), AuditError>> {
            let (delay, entries) = (self.delay, Arc::clone(&self.entries));
            Box::pin(async move {
                match delay {
                    Some(delay) => tokio::time::sleep(delay).await,
                    None => std::future::pending().await,
                }
                entries.lock().unwrap().push(entry);
                Ok(())
            })
        }
    }

    #[derive(Clone, Default)]
    struct Reports(Arc<Mutex<Vec<AuditFailure>>>);

    impl AuditReporter for Reports {
        fn report(&self, failure: &AuditFailure) {
            self.0.lock().unwrap().push(failure.clone());
        }
    }

    impl Reports {
        fn errors(&self) -> Vec<String> {
            self.0
                .lock()
                .unwrap()
                .iter()
                .map(|f| f.error.0.clone())
                .collect()
        }
    }

    const WRITE_TIMEOUT: Duration = Duration::from_millis(300);

    fn setup(delay: Option<Duration>) -> (Arc<Recorder>, Arc<Mutex<Vec<AuditEntry>>>, Reports) {
        let entries = Arc::default();
        let reports = Reports::default();
        let recorder = Recorder::new()
            .with_sink(Arc::new(Slow {
                delay,
                entries: Arc::clone(&entries),
            }))
            .with_reporter(Arc::new(reports.clone()))
            .with_policy(AuditPolicy {
                write_timeout: WRITE_TIMEOUT,
                ..AuditPolicy::default()
            });
        (Arc::new(recorder), entries, reports)
    }

    fn completion() -> AuditEntry {
        AuditEntry {
            timestamp_unix_ms: 0,
            principal_chain: Vec::<AuditPrincipal>::new(),
            tenant: TenantId::new("t"),
            action: Action::new("test.call", "test.use"),
            target: None,
            risk: Risk::Read,
            decision: AuditDecision::Allow,
            approval_id: None,
            outcome: Outcome::Success,
            duration_ms: Some(1),
            correlation_id: "c-1".into(),
            input_digest: Digest([0; 32]),
            statement_digest: None,
            delivery: Some(Delivery::Delivered),
            parent_correlation_id: None,
        }
    }

    /// Blocks the (current-thread) runtime, so a task spawned before runs only after `late`.
    fn first_poll_after(late: Duration) {
        std::thread::sleep(late);
    }

    #[tokio::test]
    async fn a_write_first_polled_late_still_ends_by_its_own_timeout() {
        let late = ABORT_GRACE + Duration::from_millis(50);
        // The sink answers within the write timeout of the moment the write was queued.
        let (recorder, entries, reports) = setup(Some(Duration::from_millis(50)));
        let completions = Completions::new();
        completions.spawn(&recorder, completion(), None);
        first_poll_after(late);
        completions.close().await;
        assert_eq!(entries.lock().unwrap().len(), 1, "written");
        assert!(reports.errors().is_empty(), "{:?}", reports.errors());

        // A sink that never answers: the write gives up through its own timeout, counted from
        // when it was queued, before `close` would abort it.
        let (recorder, _, reports) = setup(None);
        let completions = Completions::new();
        completions.spawn(&recorder, completion(), None);
        first_poll_after(late);
        completions.close().await;
        assert_eq!(reports.errors(), ["write timed out"]);
    }
}
