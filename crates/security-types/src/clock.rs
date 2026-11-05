//! Wall-clock time for audit timestamps and grant expiry (Ambidex spec Open question 26f).
//!
//! The crate stays runtime-free by default: [`Clock`] has no default `sleep_until`, because
//! sleeping needs a timer. [`SystemClock`], the real clock, sleeps on the Tokio timer and exists
//! only with the `tokio` feature (Plugin Host enables it). [`unix_now_ms`] reads the wall clock
//! without any runtime.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::sink::BoxFuture;

/// Wall-clock time in Unix milliseconds.
pub trait Clock: Send + Sync + 'static {
    fn now_unix_ms(&self) -> u64;

    /// Completes once [`now_unix_ms`](Clock::now_unix_ms) has reached `deadline_unix_ms`. Plugin
    /// Host's grant store uses it to close grants eagerly at their expiry. A clock not driven by
    /// real time (e.g. a manual test clock) completes when it is moved past the deadline.
    fn sleep_until(&self, deadline_unix_ms: u64) -> BoxFuture<'_, ()>;
}

/// The current wall-clock time in Unix milliseconds (0 before 1970, saturating far in the future).
pub fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

/// Longest time [`SystemClock::sleep_until`](Clock::sleep_until) waits before reading the clock
/// again, so a wall clock that is stepped forward is noticed within that time.
#[cfg(feature = "tokio")]
pub const CLOCK_RECHECK: std::time::Duration = std::time::Duration::from_secs(1);

/// The system wall clock, sleeping on the Tokio timer (feature `tokio`). `sleep_until` must run
/// inside a Tokio runtime with the time driver enabled.
#[cfg(feature = "tokio")]
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

#[cfg(feature = "tokio")]
impl Clock for SystemClock {
    fn now_unix_ms(&self) -> u64 {
        unix_now_ms()
    }

    fn sleep_until(&self, deadline_unix_ms: u64) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            loop {
                let now = self.now_unix_ms();
                if now >= deadline_unix_ms {
                    return;
                }
                let wait =
                    std::time::Duration::from_millis(deadline_unix_ms - now).min(CLOCK_RECHECK);
                tokio::time::sleep(wait).await;
            }
        })
    }
}

#[cfg(all(test, feature = "tokio"))]
mod tests {
    use super::*;
    use std::task::{Context, Poll, Waker};

    #[test]
    fn a_past_deadline_completes_without_a_runtime() {
        let clock = SystemClock;
        let mut sleep = clock.sleep_until(0);
        let mut cx = Context::from_waker(Waker::noop());
        assert_eq!(sleep.as_mut().poll(&mut cx), Poll::Ready(()));
        assert!(clock.now_unix_ms() > 1_700_000_000_000);
    }
}
