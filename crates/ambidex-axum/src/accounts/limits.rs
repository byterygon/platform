//! Counters for sign-in guessing and sign-up (DOC-25 §3.2.6): sliding windows of failure times
//! per key (an account, a client address), bounded in memory.

use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

/// Keys tracked at once. When it is reached, entries with nothing left to count go first, then
/// the least recently touched eighth: flooding with new keys can push out old state, but never
/// clears it all at once.
pub(crate) const MAX_TRACKED: usize = 16_384;

/// Failed passwords or codes for one account within [`ACCOUNT_WINDOW_MS`] that lock it.
pub(crate) const ACCOUNT_FAILURES: usize = 5;
/// How long an account is locked, and the window failures are counted in (15 minutes).
pub(crate) const ACCOUNT_WINDOW_MS: u64 = 15 * 60_000;
/// Failures from one client address within [`ADDRESS_WINDOW_MS`] that block it.
pub(crate) const ADDRESS_FAILURES: usize = 20;
/// The window, and how long the address is then blocked (15 minutes).
pub(crate) const ADDRESS_WINDOW_MS: u64 = 15 * 60_000;
/// Sign-ups per client address per hour.
pub(crate) const SIGNUPS_PER_HOUR: usize = 5;
pub(crate) const SIGNUP_WINDOW_MS: u64 = 60 * 60_000;

struct Entry {
    times: VecDeque<u64>,
    blocked_until_ms: u64,
    touched_ms: u64,
}

/// Sliding-window event counts per key, with an optional block.
pub(crate) struct Windows<K> {
    by_key: HashMap<K, Entry>,
}

impl<K> Default for Windows<K> {
    fn default() -> Self {
        Windows {
            by_key: HashMap::new(),
        }
    }
}

impl<K: Hash + Eq + Clone> Windows<K> {
    /// Whether `key` is blocked at `now`.
    pub(crate) fn blocked(&self, key: &K, now: u64) -> bool {
        self.by_key
            .get(key)
            .is_some_and(|e| now < e.blocked_until_ms)
    }

    /// Counts an event at `now` and returns how many events (this one included) fall within
    /// `window_ms`.
    pub(crate) fn record(&mut self, key: &K, now: u64, window_ms: u64) -> usize {
        self.make_room(now, window_ms);
        let entry = self.by_key.entry(key.clone()).or_insert_with(|| Entry {
            times: VecDeque::new(),
            blocked_until_ms: 0,
            touched_ms: now,
        });
        while entry
            .times
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= window_ms)
        {
            entry.times.pop_front();
        }
        entry.times.push_back(now);
        entry.touched_ms = now;
        entry.times.len()
    }

    /// Blocks `key` until `until_ms`.
    pub(crate) fn block(&mut self, key: &K, until_ms: u64, now: u64) {
        if let Some(entry) = self.by_key.get_mut(key) {
            entry.blocked_until_ms = until_ms;
            entry.touched_ms = now;
        }
    }

    /// Forgets `key` (a successful sign-in, an administrator's unlock).
    pub(crate) fn clear(&mut self, key: &K) {
        self.by_key.remove(key);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.by_key.len()
    }

    fn make_room(&mut self, now: u64, window_ms: u64) {
        if self.by_key.len() < MAX_TRACKED {
            return;
        }
        self.by_key.retain(|_, e| {
            now < e.blocked_until_ms || now.saturating_sub(e.touched_ms) < window_ms
        });
        if self.by_key.len() < MAX_TRACKED {
            return;
        }
        let mut touched: Vec<u64> = self.by_key.values().map(|e| e.touched_ms).collect();
        touched.sort_unstable();
        let cut = touched[MAX_TRACKED / 8];
        self.by_key.retain(|_, e| e.touched_ms > cut);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_within_the_window_only() {
        let mut w: Windows<&str> = Windows::default();
        assert_eq!(w.record(&"a", 0, 1000), 1);
        assert_eq!(w.record(&"a", 500, 1000), 2);
        assert_eq!(w.record(&"a", 1200, 1000), 2, "the first one aged out");
        assert_eq!(w.record(&"b", 1200, 1000), 1);
        w.clear(&"a");
        assert_eq!(w.record(&"a", 1300, 1000), 1);
    }

    #[test]
    fn a_block_lasts_until_its_time() {
        let mut w: Windows<u8> = Windows::default();
        w.record(&1, 0, 1000);
        assert!(!w.blocked(&1, 0));
        w.block(&1, 5000, 0);
        assert!(w.blocked(&1, 4999));
        assert!(!w.blocked(&1, 5000));
        assert!(!w.blocked(&2, 0));
    }

    #[test]
    fn a_flood_of_new_keys_evicts_the_oldest_and_not_everything() {
        let mut w: Windows<u32> = Windows::default();
        for k in 0..MAX_TRACKED as u32 {
            w.record(&k, u64::from(k), u64::MAX);
        }
        assert_eq!(w.len(), MAX_TRACKED);
        w.record(&u32::MAX, MAX_TRACKED as u64, u64::MAX);
        assert!(w.len() < MAX_TRACKED);
        assert!(w.len() > MAX_TRACKED / 2, "most state is kept");
        assert_eq!(w.record(&(MAX_TRACKED as u32 - 1), 99_999, u64::MAX), 2);
    }
}
