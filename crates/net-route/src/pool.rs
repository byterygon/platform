//! The SSH session pool (DOC-23 5, Open question (e)): sessions shared by the route's hops up to
//! and including the SSH hop, compared by value (not by the route's name), so every profile and
//! tool going through the same jump host uses one login. Each dial opens a new channel on the
//! pooled session; streams and handles keep it alive by holding it, and the pool lets it go a
//! while (60 s by default) after the last of them, or as soon as it is lost.

use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use tokio::time::Instant;

use crate::route::Hop;
use crate::ssh::SshSession;

/// How long a session nobody uses stays open (DOC-23 (e)).
pub const POOL_IDLE: Duration = Duration::from_secs(60);

/// Shared SSH sessions. Cheap to clone; clones share the sessions.
#[derive(Clone)]
pub struct SessionPool {
    inner: Arc<Mutex<State>>,
}

struct State {
    entries: Vec<Entry>,
    idle: Duration,
    reaping: bool,
}

struct Entry {
    key: Vec<Hop>,
    session: Arc<SshSession>,
    /// The last time something besides the pool held the session.
    last_used: Instant,
}

impl Default for SessionPool {
    fn default() -> SessionPool {
        SessionPool::with_idle(POOL_IDLE)
    }
}

impl std::fmt::Debug for SessionPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SessionPool")
            .field("sessions", &self.len())
            .finish()
    }
}

impl SessionPool {
    pub fn new() -> SessionPool {
        SessionPool::default()
    }

    /// A pool whose idle sessions close after `idle` instead of [`POOL_IDLE`].
    pub fn with_idle(idle: Duration) -> SessionPool {
        SessionPool {
            inner: Arc::new(Mutex::new(State {
                entries: Vec::new(),
                idle,
                reaping: false,
            })),
        }
    }

    /// The number of sessions held.
    pub fn len(&self) -> usize {
        self.lock().entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Lets every session go.
    pub fn clear(&self) {
        self.lock().entries.clear();
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The live session for these hops, if there is one.
    pub(crate) fn get(&self, key: &[Hop]) -> Option<Arc<SshSession>> {
        let mut state = self.lock();
        state.entries.retain(|e| !e.session.is_lost());
        let entry = state.entries.iter_mut().find(|e| e.key == key)?;
        entry.last_used = Instant::now();
        Some(Arc::clone(&entry.session))
    }

    pub(crate) fn put(&self, key: Vec<Hop>, session: Arc<SshSession>) {
        let mut state = self.lock();
        state
            .entries
            .retain(|e| e.key != key || !Arc::ptr_eq(&e.session, &session));
        state.entries.push(Entry {
            key,
            session,
            last_used: Instant::now(),
        });
        if !state.reaping {
            state.reaping = true;
            let tick = (state.idle / 6).clamp(Duration::from_millis(20), Duration::from_secs(10));
            tokio::spawn(reap(Arc::downgrade(&self.inner), tick));
        }
    }
}

/// Drops sessions that are lost or that nothing else has held for the idle time; ends when the
/// pool is gone or empty.
async fn reap(state: Weak<Mutex<State>>, tick: Duration) {
    loop {
        tokio::time::sleep(tick).await;
        let Some(state) = state.upgrade() else { return };
        let mut state = state.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let idle = state.idle;
        for entry in &mut state.entries {
            if Arc::strong_count(&entry.session) > 1 {
                entry.last_used = now;
            }
        }
        state
            .entries
            .retain(|e| !e.session.is_lost() && now.duration_since(e.last_used) < idle);
        if state.entries.is_empty() {
            state.reaping = false;
            return;
        }
    }
}
