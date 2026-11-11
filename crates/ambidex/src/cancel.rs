//! Per-call cancellation and deadlines (Ambidex spec §7).
//!
//! The engine gives every call a [`CallScope`]: a cancellation token plus a deadline. The token
//! fires on the first of
//!
//! - a `Cancel` frame for the call ([`Code::Cancelled`]);
//! - the deadline ([`Code::DeadlineExceeded`]);
//! - for a subscription, an `Unsubscribe` frame ([`Code::Cancelled`]) or an event the server cannot
//!   buffer ([`Code::ResourceExhausted`], see [`crate::subscription`]);
//! - session revocation, [`Connection::goaway`](crate::Connection::goaway) or disconnect: these
//!   cancel the connection's parent token, so every call on it fires ([`Code::Cancelled`]).
//!
//! The deadline is `min(client timeout_ms, timeout_max)`, or `timeout_default` when the client
//! sets none, measured from the moment the server read the `Call` (see [`effective_timeout`]).
//! Queries, mutations and streams always have both bounds ([`DEFAULT_TIMEOUT`] and
//! [`DEFAULT_TIMEOUT_MAX`] unless they declare their own). Subscriptions have no default deadline
//! (spec Open question 24f): only the client's `timeout_ms` and a maximum the procedure declares
//! bound them, so a subscription with neither has no deadline at all and runs until Cancel,
//! Unsubscribe, session revocation or disconnect ends it. A deadline too far away to represent is
//! no deadline. The engine starts with the defaults of the frame's kind
//! ([`ProcedureKind::default_timeouts`]); the dispatcher narrows them to the procedure's own
//! bounds with [`CallScope::apply_timeouts`] before running anything ([`Router`](crate::Router)
//! does this right after the lookup).
//!
//! Deadlines are measured on a [`DeadlineClock`] ([`ServerConfig::deadline_clock`]): Tokio's
//! clock ([`TokioClock`]) unless a test supplies one it moves by hand. Grace periods and the
//! handshake and close timeouts always use Tokio's timer.
//!
//! [`ServerConfig::deadline_clock`]: crate::ServerConfig::deadline_clock
//! [`DEFAULT_TIMEOUT`]: crate::procedure::DEFAULT_TIMEOUT
//! [`DEFAULT_TIMEOUT_MAX`]: crate::procedure::DEFAULT_TIMEOUT_MAX
//!
//! The scope reaches the dispatcher as a task-local ([`CallScope::current`]) rather than as an
//! argument, so `Dispatch` wrappers (e.g. the one in `ambidex-axum`) need no change. A wrapper
//! that moves the call future to another task loses the scope; the engine still enforces the
//! deadline and cancellation, but the handler can no longer observe them.
//!
//! A call whose token already fired or whose deadline already passed never starts: the engine
//! checks before polling the dispatcher, and [`Router`](crate::Router) checks again after narrowing
//! the deadline and after authorization, before running the handler.
//!
//! Cancellation is cooperative, then forced: once the token fires, the handler gets
//! [`ServerConfig::cancel_grace`](crate::ServerConfig::cancel_grace) to stop (e.g. to send the
//! database's out-of-band cancel), then its future is dropped. Either way the call answers with
//! exactly one `Error` carrying the reason; a value the handler returns after the token fired is
//! discarded.

use std::fmt;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::audit::{Completion, Completions, Room};
use crate::engine::BoxFuture;
use crate::message::{Code, ErrorPayload};
use crate::procedure::ProcedureKind;

tokio::task_local! {
    static CURRENT: CallScope;
}

/// The time call and subscription deadlines are measured on.
///
/// The engine reads [`now`](DeadlineClock::now) when it admits a call and whenever it checks the
/// deadline, and waits with [`sleep_until`](DeadlineClock::sleep_until) for the deadline to pass.
/// [`TokioClock`] is the default; a test clock that only moves when the test says so lets a test
/// put a call exactly at its deadline without waiting (the conformance suite does this on every
/// transport).
pub trait DeadlineClock: fmt::Debug + Send + Sync + 'static {
    fn now(&self) -> Instant;

    /// Completes once [`now`](DeadlineClock::now) has reached `deadline`.
    fn sleep_until(&self, deadline: Instant) -> BoxFuture<'static, ()>;
}

/// Tokio's clock: real time, or Tokio's paused test clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct TokioClock;

impl DeadlineClock for TokioClock {
    fn now(&self) -> Instant {
        Instant::now()
    }

    fn sleep_until(&self, deadline: Instant) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep_until(deadline))
    }
}

/// When a call started, on the two clocks it is measured on: Tokio's for its audit duration (a
/// test [`DeadlineClock`] may stand still), and its deadline clock for its deadline.
#[derive(Debug, Clone)]
pub(crate) struct Start {
    pub(crate) at: Instant,
    pub(crate) clock: Arc<dyn DeadlineClock>,
    pub(crate) clock_at: Instant,
}

impl Start {
    pub(crate) fn now(clock: Arc<dyn DeadlineClock>) -> Start {
        Start {
            at: Instant::now(),
            clock_at: clock.now(),
            clock,
        }
    }
}

/// Cancellation token and deadline of one call. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct CallScope {
    inner: Arc<Inner>,
}

struct Inner {
    token: CancellationToken,
    /// Why the token fired, with the message the call answers. Unset when a parent (connection)
    /// token fired: that is `Cancelled`.
    reason: OnceLock<(Code, &'static str)>,
    /// The id the call's errors and audit entries carry: the engine's, or one from the shared
    /// generator ([`security_types::new_correlation_id`]) outside the engine.
    correlation_id: String,
    /// Whether the engine created this scope, and so records the call's audit completion once
    /// it knows what the client received.
    managed: bool,
    /// Whether a call already runs under this scope (see [`CallScope::for_call`]).
    claimed: AtomicBool,
    /// The scope of the handler that made this call, for a call made from inside a handler. Its
    /// token is this token's parent, and its deadline bounds this one.
    parent: Option<CallScope>,
    /// The audit completion the router registered after the admission entry, until written.
    completion: Mutex<Option<Completion>>,
    /// Where the call's completion is written: the connection's queue in the engine (shared by
    /// a call a handler makes); `None` outside it, where the router's own queue is used.
    completions: Option<Completions>,
    /// The call's place in its connection's `Rooms`, until its completion takes it.
    room: Mutex<Option<Room>>,
    /// The clock the deadline is measured on, and when the call started on it.
    clock: Arc<dyn DeadlineClock>,
    clock_start: Instant,
    /// When the call started on Tokio's clock: its audit duration runs from here.
    start: Instant,
    requested: Option<Duration>,
    /// `None`: no deadline (a subscription without a client timeout or a declared maximum).
    deadline: Mutex<Option<Instant>>,
    /// Wakes the engine's deadline timer when [`CallScope::apply_timeouts`] moves the deadline.
    changed: Notify,
}

impl CallScope {
    /// A scope that starts now on Tokio's clock with its own token. `requested` is the client's
    /// timeout. It starts with the bounds of a query; [`CallScope::apply_timeouts`] (which the
    /// [`Router`](crate::Router) runs for every call and subscription) replaces them.
    ///
    /// The engine creates scopes itself; this is for running a dispatcher outside the engine
    /// (e.g. the MCP adapter calling [`Router::call`](crate::Router::call)), where the caller
    /// enforces the deadline. Its correlation id comes from the shared generator; it is empty
    /// only if the OS had no randomness, and the router refuses such a call.
    pub fn new(requested: Option<Duration>) -> CallScope {
        let correlation_id = security_types::new_correlation_id().unwrap_or_default();
        CallScope::build(
            CancellationToken::new(),
            requested,
            (correlation_id, Start::now(Arc::new(TokioClock))),
            false,
            None,
            (None, None),
            ProcedureKind::Query,
        )
    }

    /// The scope a dispatcher runs one call under: the engine's scope for it, the first time it
    /// is asked for; a [child](CallScope::child) of the current scope when a call already runs
    /// under it (a handler calling another procedure); a [new](CallScope::new) one outside any
    /// scope. Each call so gets its own correlation id, deadline and audit completion.
    pub(crate) fn for_call(requested: Option<Duration>) -> CallScope {
        match CallScope::current() {
            Some(scope) if !scope.inner.claimed.swap(true, Ordering::SeqCst) => scope,
            Some(outer) => outer.child(requested),
            None => CallScope::new(requested),
        }
    }

    /// A scope for a call made from inside the call of this scope. Its token is a child of this
    /// token, so it is cancelled with this call (and with the reason this call fired with), and
    /// its deadline, on the same clock, is never later than this one. Like [`CallScope::new`] its
    /// correlation id comes from the shared generator and it starts with the bounds of a query,
    /// and the router writes its completion when its handler returns: what it returns is
    /// delivered to the calling handler.
    fn child(&self, requested: Option<Duration>) -> CallScope {
        let correlation_id = security_types::new_correlation_id().unwrap_or_default();
        CallScope::build(
            self.inner.token.child_token(),
            requested,
            (correlation_id, Start::now(Arc::clone(&self.inner.clock))),
            false,
            Some(self.clone()),
            // Its completion is written on the connection's queue, so the connection waits for
            // it too; the calling handler awaits it, so it takes no room of its own.
            (self.inner.completions.clone(), None),
            ProcedureKind::Query,
        )
    }

    /// The engine's scope for one call, which started at `received` (when its frame was read; the
    /// call may have waited for room since), with the connection's completion queue and the
    /// call's room in it. It is bounded by the default timeouts of `kind` until the dispatcher
    /// applies the procedure's own.
    pub(crate) fn with_token(
        token: CancellationToken,
        requested: Option<Duration>,
        correlation_id: String,
        received: Start,
        completions: Completions,
        room: Option<Room>,
        kind: ProcedureKind,
    ) -> CallScope {
        CallScope::build(
            token,
            requested,
            (correlation_id, received),
            true,
            None,
            (Some(completions), room),
            kind,
        )
    }

    fn build(
        token: CancellationToken,
        requested: Option<Duration>,
        (correlation_id, start): (String, Start),
        managed: bool,
        parent: Option<CallScope>,
        (completions, room): (Option<Completions>, Option<Room>),
        kind: ProcedureKind,
    ) -> CallScope {
        let (default, max) = kind.default_timeouts();
        let deadline = deadline_at(start.clock_at, requested, default, max);
        CallScope {
            inner: Arc::new(Inner {
                token,
                reason: OnceLock::new(),
                correlation_id,
                managed,
                // Only the engine's scope waits for the call that runs under it.
                claimed: AtomicBool::new(!managed),
                parent,
                completion: Mutex::new(None),
                completions,
                room: Mutex::new(room),
                clock: start.clock,
                clock_start: start.clock_at,
                start: start.at,
                requested,
                deadline: Mutex::new(deadline),
                changed: Notify::new(),
            }),
        }
    }

    /// The scope of the call being dispatched, when running inside the engine.
    pub fn current() -> Option<CallScope> {
        CURRENT.try_with(CallScope::clone).ok()
    }

    /// Runs `fut` with this scope as [`CallScope::current`].
    pub(crate) fn enter<F: Future>(self, fut: F) -> impl Future<Output = F::Output> {
        CURRENT.scope(self, fut)
    }

    pub fn token(&self) -> &CancellationToken {
        &self.inner.token
    }

    /// The id this call's errors and audit entries carry (see [`CallScope::new`]).
    pub fn correlation_id(&self) -> &str {
        &self.inner.correlation_id
    }

    /// The correlation id of the call whose handler made this call, for a call made from inside
    /// another call's handler; `None` for a top-level call.
    pub fn parent_correlation_id(&self) -> Option<&str> {
        self.inner.parent.as_ref().map(CallScope::correlation_id)
    }

    /// When the call started: the engine read its frame, or [`CallScope::new`] ran.
    pub(crate) fn start(&self) -> Instant {
        self.inner.start
    }

    /// The connection's completion queue, for a call inside the engine.
    pub(crate) fn completions(&self) -> Option<&Completions> {
        self.inner.completions.as_ref()
    }

    /// The call's place in its connection's `Rooms`, for its completion to hold.
    pub(crate) fn take_room(&self) -> Option<Room> {
        lock(&self.inner.room).take()
    }

    pub(crate) fn is_managed(&self) -> bool {
        self.inner.managed
    }

    /// Keeps the call's pending audit completion until the call ends.
    pub(crate) fn set_completion(&self, completion: Completion) {
        *lock(&self.inner.completion) = Some(completion);
    }

    /// Updates the pending completion, if there is one.
    pub(crate) fn update_completion(&self, f: impl FnOnce(&mut Completion)) {
        if let Some(completion) = lock(&self.inner.completion).as_mut() {
            f(completion);
        }
    }

    /// The pending completion, to write it. A completion never taken is written when the last
    /// clone of the scope is dropped (see [`Completion`]).
    pub(crate) fn take_completion(&self) -> Option<Completion> {
        lock(&self.inner.completion).take()
    }

    /// Resolves once the token fires.
    pub async fn cancelled(&self) {
        self.inner.token.cancelled().await
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.token.is_cancelled()
    }

    /// Why the token fired (`Cancelled`, `DeadlineExceeded`, or `ResourceExhausted` for a
    /// subscription whose events could not be buffered), `None` before.
    pub fn reason(&self) -> Option<Code> {
        self.is_cancelled().then(|| match self.inner.reason.get() {
            Some(reason) => reason.0,
            None => self
                .inner
                .parent
                .as_ref()
                .and_then(CallScope::reason)
                .unwrap_or(Code::Cancelled),
        })
    }

    /// Fires the token with `Cancelled`. No-op if it already fired.
    pub fn cancel(&self) {
        self.fire(Code::Cancelled);
    }

    /// Fires the token; the first reason wins.
    pub(crate) fn fire(&self, reason: Code) {
        let message = match reason {
            Code::DeadlineExceeded => "deadline exceeded",
            _ => "call cancelled",
        };
        self.fail(reason, message);
    }

    /// Fires the token with `code` and the message the call then answers; the first reason wins.
    pub(crate) fn fail(&self, code: Code, message: &'static str) {
        if !self.is_cancelled() {
            let _ = self.inner.reason.set((code, message));
        }
        self.inner.token.cancel();
    }

    /// Fires `DeadlineExceeded` if the deadline has passed, then returns why the token fired, if it
    /// has. Checked before a call starts, before its answer is accepted, and before a
    /// subscription event is queued.
    pub(crate) fn check(&self) -> Option<Code> {
        if self
            .deadline()
            .is_some_and(|deadline| self.inner.clock.now() >= deadline)
        {
            self.fire(Code::DeadlineExceeded);
        }
        self.reason()
    }

    /// The `Error` a call answers once its token fired.
    pub(crate) fn error(&self) -> ErrorPayload {
        match (self.inner.reason.get(), &self.inner.parent) {
            (Some(&(code, message)), _) if self.is_cancelled() => ErrorPayload::new(code, message),
            // Fired by the calling handler's scope: its reason.
            (None, Some(parent)) if self.is_cancelled() && parent.is_cancelled() => parent.error(),
            _ => ErrorPayload::new(Code::Cancelled, "call cancelled"),
        }
    }

    /// Timeout the client asked for, if any.
    pub fn requested_timeout(&self) -> Option<Duration> {
        self.inner.requested
    }

    /// When the call ends with `DeadlineExceeded`, on the scope's [`DeadlineClock`]; `None` when it
    /// has no deadline. A call made from inside a handler ends no later than the calling one.
    pub fn deadline(&self) -> Option<Instant> {
        let own = *lock(&self.inner.deadline);
        let parent = self.inner.parent.as_ref().and_then(CallScope::deadline);
        match (own, parent) {
            (Some(own), Some(parent)) => Some(own.min(parent)),
            (own, parent) => own.or(parent),
        }
    }

    /// Sets the deadline from the procedure's bounds (see [`effective_timeout`]), measured from
    /// the start of the call. `None` for a bound means the procedure has none.
    pub fn apply_timeouts(&self, default: Option<Duration>, max: Option<Duration>) {
        let deadline = deadline_at(self.inner.clock_start, self.inner.requested, default, max);
        *lock(&self.inner.deadline) = deadline;
        self.inner.changed.notify_one();
    }

    /// Resolves after [`CallScope::apply_timeouts`] ran (once per call to it).
    pub(crate) async fn deadline_changed(&self) {
        self.inner.changed.notified().await
    }

    /// Resolves once the scope's clock reached `deadline`; never for `None`.
    pub(crate) async fn reached(&self, deadline: Option<Instant>) {
        match deadline {
            Some(deadline) => self.inner.clock.sleep_until(deadline).await,
            None => std::future::pending().await,
        }
    }
}

impl std::fmt::Debug for CallScope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CallScope")
            .field("deadline", &self.deadline())
            .field("reason", &self.reason())
            .finish()
    }
}

/// The timeout a call gets: the client's `requested`, or `default` when it set none, capped by
/// `max`. A missing bound is no bound: with no `requested` and no `default` the timeout is `max`,
/// and with none of the three there is no timeout (`None`), which only a subscription can have.
pub fn effective_timeout(
    requested: Option<Duration>,
    default: Option<Duration>,
    max: Option<Duration>,
) -> Option<Duration> {
    match (requested.or(default), max) {
        (Some(timeout), Some(max)) => Some(timeout.min(max)),
        (timeout, max) => timeout.or(max),
    }
}

/// `start + effective_timeout(..)`; `None` when there is no timeout, or when it is too far away
/// to represent (a client may send any u64 for a subscription without a declared maximum).
pub(crate) fn deadline_at(
    start: Instant,
    requested: Option<Duration>,
    default: Option<Duration>,
    max: Option<Duration>,
) -> Option<Instant> {
    effective_timeout(requested, default, max).and_then(|timeout| start.checked_add(timeout))
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_timeout_is_capped_by_max() {
        let s = |n| Some(Duration::from_secs(n));
        assert_eq!(effective_timeout(s(10), s(30), s(60)), s(10));
        assert_eq!(effective_timeout(s(600), s(30), s(60)), s(60));
        assert_eq!(effective_timeout(None, s(30), s(60)), s(30));
        assert_eq!(effective_timeout(None, s(90), s(60)), s(60));
        assert_eq!(effective_timeout(s(0), s(30), s(60)), s(0));
    }

    #[test]
    fn a_missing_bound_is_no_bound() {
        let s = |n| Some(Duration::from_secs(n));
        // A subscription: no default deadline; the client's timeout and a declared maximum apply.
        assert_eq!(effective_timeout(None, None, None), None);
        assert_eq!(effective_timeout(s(3600), None, None), s(3600));
        assert_eq!(effective_timeout(s(3600), None, s(600)), s(600));
        assert_eq!(effective_timeout(s(10), None, s(600)), s(10));
        assert_eq!(effective_timeout(None, None, s(600)), s(600));
        assert_eq!(effective_timeout(None, s(30), None), s(30));
    }

    #[test]
    fn a_subscription_scope_has_no_deadline_unless_bounded() {
        let scope = |requested| {
            engine_scope(
                CancellationToken::new(),
                requested,
                "",
                ProcedureKind::Subscription,
            )
        };
        let unbounded = scope(None);
        assert_eq!(unbounded.deadline(), None);
        assert_eq!(unbounded.check(), None);
        let start = Instant::now();
        let requested = scope(Some(Duration::from_secs(3600)));
        assert!(requested.deadline().unwrap() >= start + Duration::from_secs(3600));
        // The largest client timeout (u64 ms) is far away but not expired.
        let huge = scope(Some(Duration::from_millis(u64::MAX)));
        huge.apply_timeouts(None, None);
        assert_eq!(huge.check(), None);
        // A deadline beyond what an Instant can hold is no deadline, not a panic.
        let beyond = scope(Some(Duration::MAX));
        assert_eq!(beyond.deadline(), None);
        beyond.apply_timeouts(None, None);
        assert_eq!(beyond.deadline(), None);
        assert_eq!(beyond.check(), None);
    }

    #[test]
    fn first_reason_wins() {
        let scope = CallScope::new(None);
        assert_eq!(scope.reason(), None);
        scope.fire(Code::DeadlineExceeded);
        scope.cancel();
        assert_eq!(scope.reason(), Some(Code::DeadlineExceeded));
    }

    #[tokio::test(start_paused = true)]
    async fn check_fires_once_the_deadline_passed() {
        let scope = CallScope::new(Some(Duration::from_millis(10)));
        assert_eq!(scope.check(), None);
        tokio::time::advance(Duration::from_millis(10)).await;
        assert_eq!(scope.check(), Some(Code::DeadlineExceeded));
        assert_eq!(scope.error().code, Code::DeadlineExceeded);
    }

    #[test]
    fn check_keeps_an_earlier_cancel() {
        let scope = CallScope::new(Some(Duration::ZERO));
        scope.cancel();
        assert_eq!(scope.check(), Some(Code::Cancelled));
        assert_eq!(scope.error().code, Code::Cancelled);
    }

    #[test]
    fn fail_keeps_its_code_and_message() {
        let scope = CallScope::new(None);
        scope.fail(Code::ResourceExhausted, "subscription event buffer is full");
        scope.cancel();
        assert_eq!(scope.reason(), Some(Code::ResourceExhausted));
        let err = scope.error();
        assert_eq!(err.code, Code::ResourceExhausted);
        assert_eq!(err.message, "subscription event buffer is full");
    }

    #[test]
    fn parent_cancel_reads_as_cancelled() {
        let parent = CancellationToken::new();
        let scope = engine_scope(parent.child_token(), None, "", ProcedureKind::Query);
        parent.cancel();
        assert_eq!(scope.reason(), Some(Code::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn apply_timeouts_moves_the_deadline() {
        use crate::procedure::DEFAULT_TIMEOUT_MAX;
        let scope = CallScope::new(Some(Duration::from_secs(600)));
        let start = scope.deadline().unwrap() - DEFAULT_TIMEOUT_MAX;
        let s = |n| Some(Duration::from_secs(n));
        scope.apply_timeouts(s(1), s(2));
        assert_eq!(scope.deadline(), Some(start + Duration::from_secs(2)));
        // The notification is stored until someone waits.
        scope.deadline_changed().await;
        // Without a maximum the client's 600 s stand.
        scope.apply_timeouts(None, None);
        assert_eq!(scope.deadline(), Some(start + Duration::from_secs(600)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_inside_a_call_gets_a_child_scope() {
        let s = |n| Some(Duration::from_secs(n));
        let outer = engine_scope(CancellationToken::new(), None, "c-1", ProcedureKind::Query);
        outer.apply_timeouts(s(10), s(10));
        outer
            .clone()
            .enter(async {
                // The first call under the engine's scope is the engine's call.
                let first = CallScope::for_call(None);
                assert_eq!(first.correlation_id(), "c-1");
                // A call its handler makes is a child, with its own id.
                let inner = CallScope::for_call(Some(Duration::from_secs(60)));
                assert_ne!(inner.correlation_id(), "c-1");
                assert!(!inner.is_managed());
                // Its own bounds do not move the outer deadline, and never pass it.
                inner.apply_timeouts(s(30), s(300));
                assert_eq!(inner.deadline(), outer.deadline());
                inner.apply_timeouts(s(1), s(1));
                assert!(inner.deadline() < outer.deadline());
                // It is cancelled with the outer call, for the same reason.
                outer.fire(Code::DeadlineExceeded);
                assert_eq!(inner.reason(), Some(Code::DeadlineExceeded));
                assert_eq!(inner.error().code, Code::DeadlineExceeded);
            })
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_call_inside_a_subscription_without_deadline_has_its_own() {
        let s = |n| Some(Duration::from_secs(n));
        let outer = engine_scope(
            CancellationToken::new(),
            None,
            "c-1",
            ProcedureKind::Subscription,
        );
        outer.apply_timeouts(None, None);
        assert_eq!(outer.deadline(), None);
        outer
            .clone()
            .enter(async {
                let _ = CallScope::for_call(None);
                // A call the subscription's handler makes keeps the bounds of a call.
                let inner = CallScope::for_call(None);
                let start = Instant::now();
                inner.apply_timeouts(s(30), s(300));
                assert_eq!(inner.deadline(), Some(start + Duration::from_secs(30)));
            })
            .await;
    }

    /// A scope as the engine creates it, on Tokio's clock.
    fn engine_scope(
        token: CancellationToken,
        requested: Option<Duration>,
        correlation_id: &str,
        kind: ProcedureKind,
    ) -> CallScope {
        CallScope::with_token(
            token,
            requested,
            correlation_id.to_owned(),
            Start::now(Arc::new(TokioClock)),
            Completions::new(),
            None,
            kind,
        )
    }
}
