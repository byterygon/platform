//! The conformance clock: a [`DeadlineClock`] that stands still until a case moves it.
//!
//! Every harness gives the engine the fixture's [`ManualClock`]
//! ([`Fixture::server_config`](crate::Fixture::server_config)), so call and subscription deadlines
//! are measured on it on every transport. A case can then put a call exactly one millisecond
//! before, or at, its deadline, minutes or hours after it started, without waiting. Everything
//! else (grace periods, the handshake timeout, the client's receive timeout) stays on real time.
//!
//! The same clock is also a wall clock ([`security_types::Clock`], from [`MANUAL_EPOCH_MS`]), so
//! web session timeouts and ID token times move with it too.
//!
//! Fixture handlers that must act at a given time (`fixture.sleep`, `fixture.ticks`) wait on the
//! same clock. That is what makes "just before the deadline" checks deterministic: the engine
//! checks the deadline against the clock when it accepts an answer or queues an event, and the
//! clock cannot move again until the case moves it.

use std::time::Duration;

use ambidex::DeadlineClock;
use ambidex::engine::BoxFuture;
use security_types::Clock;
use tokio::sync::watch;
use tokio::time::Instant;

/// A clock moved by hand. Time starts at its creation and only moves with
/// [`advance`](ManualClock::advance).
#[derive(Debug)]
pub struct ManualClock {
    origin: Instant,
    elapsed: watch::Sender<Duration>,
}

impl Default for ManualClock {
    fn default() -> ManualClock {
        ManualClock::new()
    }
}

impl ManualClock {
    pub fn new() -> ManualClock {
        ManualClock {
            origin: Instant::now(),
            elapsed: watch::Sender::new(Duration::ZERO),
        }
    }

    /// Time since the clock was created, on this clock.
    pub fn elapsed(&self) -> Duration {
        *self.elapsed.borrow()
    }

    /// Moves the clock forward by `by`, waking everything waiting on it.
    pub fn advance(&self, by: Duration) {
        self.elapsed.send_modify(|elapsed| *elapsed += by);
    }

    /// Resolves each time the clock moves after this call, with the new [`elapsed`] time.
    ///
    /// [`elapsed`]: ManualClock::elapsed
    pub fn watch(&self) -> watch::Receiver<Duration> {
        self.elapsed.subscribe()
    }

    /// Resolves once [`elapsed`](ManualClock::elapsed) reached `at`.
    pub async fn wait_until(&self, at: Duration) {
        wait(self.watch(), at).await
    }
}

impl DeadlineClock for ManualClock {
    fn now(&self) -> Instant {
        self.origin + self.elapsed()
    }

    fn sleep_until(&self, deadline: Instant) -> BoxFuture<'static, ()> {
        let at = deadline.saturating_duration_since(self.origin);
        Box::pin(wait(self.watch(), at))
    }
}

/// What [`ManualClock`] reads as wall-clock time before it is moved (2027-01-15T08:00:00Z).
pub const MANUAL_EPOCH_MS: u64 = 1_800_000_000_000;

impl Clock for ManualClock {
    fn now_unix_ms(&self) -> u64 {
        MANUAL_EPOCH_MS + u64::try_from(self.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn sleep_until(&self, deadline_unix_ms: u64) -> BoxFuture<'_, ()> {
        let at = Duration::from_millis(deadline_unix_ms.saturating_sub(MANUAL_EPOCH_MS));
        Box::pin(wait(self.watch(), at))
    }
}

async fn wait(mut elapsed: watch::Receiver<Duration>, at: Duration) {
    if elapsed.wait_for(|elapsed| *elapsed >= at).await.is_err() {
        // The clock is gone, so time no longer moves.
        std::future::pending::<()>().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Whether `fut` is ready when polled once now.
    async fn ready(fut: &mut BoxFuture<'static, ()>) -> bool {
        tokio::select! {
            biased;
            () = fut => true,
            () = std::future::ready(()) => false,
        }
    }

    #[tokio::test]
    async fn sleepers_wake_exactly_at_their_deadline() {
        let clock = ManualClock::new();
        let deadline = clock.now() + Duration::from_secs(60);
        let mut sleep = DeadlineClock::sleep_until(&clock, deadline);
        assert!(!ready(&mut sleep).await, "not before the deadline");
        clock.advance(Duration::from_millis(59_999));
        assert!(!ready(&mut sleep).await, "one millisecond before");
        assert_eq!(clock.now() + Duration::from_millis(1), deadline);
        clock.advance(Duration::from_millis(1));
        assert!(ready(&mut sleep).await, "at the deadline");
        // A deadline already reached resolves at once.
        assert!(ready(&mut DeadlineClock::sleep_until(&clock, deadline)).await);
    }

    #[tokio::test]
    async fn the_wall_clock_view_moves_with_it() {
        let clock = ManualClock::new();
        assert_eq!(clock.now_unix_ms(), MANUAL_EPOCH_MS);
        let mut sleep = Clock::sleep_until(&clock, MANUAL_EPOCH_MS + 1000);
        let early = tokio::select! {
            biased;
            () = &mut sleep => true,
            () = std::future::ready(()) => false,
        };
        assert!(!early);
        clock.advance(Duration::from_secs(1));
        assert_eq!(clock.now_unix_ms(), MANUAL_EPOCH_MS + 1000);
        sleep.await;
    }
}
