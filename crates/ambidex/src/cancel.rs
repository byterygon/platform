//! Per-call cancellation and deadlines (Ambidex spec §7).
//!
//! The engine gives every call a [`CallScope`]: a cancellation token plus a deadline. The token
//! fires on the first of
//!
//! - a `Cancel` frame for the call ([`Code::Cancelled`]);
//! - the deadline ([`Code::DeadlineExceeded`]);
//! - session revocation, [`Connection::goaway`](crate::Connection::goaway) or disconnect: these
//!   cancel the connection's parent token, so every call on it fires ([`Code::Cancelled`]).
//!
//! The deadline is `min(client timeout_ms, timeout_max)`, or `timeout_default` when the client
//! sets none, measured from the moment the server read the `Call`. The engine starts with
//! [`DEFAULT_TIMEOUT`]/[`DEFAULT_TIMEOUT_MAX`]; the dispatcher narrows it to the procedure's own
//! bounds with [`CallScope::apply_timeouts`] before running anything ([`Router`](crate::Router)
//! does this right after the lookup).
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

use std::future::Future;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use tokio::sync::Notify;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::message::{Code, ErrorPayload};
use crate::procedure::{DEFAULT_TIMEOUT, DEFAULT_TIMEOUT_MAX};

tokio::task_local! {
    static CURRENT: CallScope;
}

/// Cancellation token and deadline of one call. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct CallScope {
    inner: Arc<Inner>,
}

struct Inner {
    token: CancellationToken,
    /// Why the token fired. Unset when a parent (connection) token fired: that is `Cancelled`.
    reason: OnceLock<Code>,
    start: Instant,
    requested: Option<Duration>,
    deadline: Mutex<Instant>,
    /// Wakes the engine's deadline timer when [`CallScope::apply_timeouts`] moves the deadline.
    changed: Notify,
}

impl CallScope {
    /// A scope that starts now with its own token. `requested` is the client's timeout.
    ///
    /// The engine creates scopes itself; this is for running a dispatcher outside the engine
    /// (e.g. the MCP adapter calling [`Router::call`](crate::Router::call)), where the caller
    /// enforces the deadline.
    pub fn new(requested: Option<Duration>) -> CallScope {
        CallScope::with_token(CancellationToken::new(), requested)
    }

    pub(crate) fn with_token(token: CancellationToken, requested: Option<Duration>) -> CallScope {
        let start = Instant::now();
        CallScope {
            inner: Arc::new(Inner {
                token,
                reason: OnceLock::new(),
                start,
                requested,
                deadline: Mutex::new(
                    start + effective_timeout(requested, DEFAULT_TIMEOUT, DEFAULT_TIMEOUT_MAX),
                ),
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

    /// Resolves once the token fires.
    pub async fn cancelled(&self) {
        self.inner.token.cancelled().await
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.token.is_cancelled()
    }

    /// `Cancelled` or `DeadlineExceeded` once the token fired, `None` before.
    pub fn reason(&self) -> Option<Code> {
        self.is_cancelled()
            .then(|| *self.inner.reason.get().unwrap_or(&Code::Cancelled))
    }

    /// Fires the token with `Cancelled`. No-op if it already fired.
    pub fn cancel(&self) {
        self.fire(Code::Cancelled);
    }

    /// Fires the token; the first reason wins.
    pub(crate) fn fire(&self, reason: Code) {
        if !self.is_cancelled() {
            let _ = self.inner.reason.set(reason);
        }
        self.inner.token.cancel();
    }

    /// Fires `DeadlineExceeded` if the deadline has passed, then returns why the token fired, if it
    /// has. Checked before a call starts and before its answer is accepted.
    pub(crate) fn check(&self) -> Option<Code> {
        if Instant::now() >= self.deadline() {
            self.fire(Code::DeadlineExceeded);
        }
        self.reason()
    }

    /// The `Error` a call answers once its token fired.
    pub(crate) fn error(&self) -> ErrorPayload {
        match self.reason() {
            Some(Code::DeadlineExceeded) => {
                ErrorPayload::new(Code::DeadlineExceeded, "deadline exceeded")
            }
            _ => ErrorPayload::new(Code::Cancelled, "call cancelled"),
        }
    }

    /// Timeout the client asked for, if any.
    pub fn requested_timeout(&self) -> Option<Duration> {
        self.inner.requested
    }

    pub fn deadline(&self) -> Instant {
        *lock(&self.inner.deadline)
    }

    /// Sets the deadline from the procedure's bounds: `min(requested, max)`, or `default` (itself
    /// capped by `max`) when the client set none. Measured from the start of the call.
    pub fn apply_timeouts(&self, default: Duration, max: Duration) {
        let timeout = effective_timeout(self.inner.requested, default, max);
        *lock(&self.inner.deadline) = self.inner.start + timeout;
        self.inner.changed.notify_one();
    }

    /// Resolves after [`CallScope::apply_timeouts`] ran (once per call to it).
    pub(crate) async fn deadline_changed(&self) {
        self.inner.changed.notified().await
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

/// `min(requested, max)`, or `min(default, max)` when the client set no timeout.
pub fn effective_timeout(
    requested: Option<Duration>,
    default: Duration,
    max: Duration,
) -> Duration {
    requested.unwrap_or(default).min(max)
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_timeout_is_capped_by_max() {
        let s = Duration::from_secs;
        assert_eq!(effective_timeout(Some(s(10)), s(30), s(60)), s(10));
        assert_eq!(effective_timeout(Some(s(600)), s(30), s(60)), s(60));
        assert_eq!(effective_timeout(None, s(30), s(60)), s(30));
        assert_eq!(effective_timeout(None, s(90), s(60)), s(60));
        assert_eq!(effective_timeout(Some(s(0)), s(30), s(60)), s(0));
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
    fn parent_cancel_reads_as_cancelled() {
        let parent = CancellationToken::new();
        let scope = CallScope::with_token(parent.child_token(), None);
        parent.cancel();
        assert_eq!(scope.reason(), Some(Code::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn apply_timeouts_moves_the_deadline() {
        let scope = CallScope::new(Some(Duration::from_secs(600)));
        let start = scope.deadline() - DEFAULT_TIMEOUT_MAX;
        scope.apply_timeouts(Duration::from_secs(1), Duration::from_secs(2));
        assert_eq!(scope.deadline(), start + Duration::from_secs(2));
        // The notification is stored until someone waits.
        scope.deadline_changed().await;
    }
}
