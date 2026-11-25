//! Budgets for the calls that carry a secret from the browser (TSK-141; DOC-25 Open question
//! 26): the router asks [`SecretCallLimits`] for a call's target before the Authorizer, and it
//! refuses a call over its budget with `ResourceExhausted` before anything else happens.
//!
//! The rule is on the procedure's metadata, so a new tool cannot forget it: a call counts when
//! one of its `redact` paths holds a value. Two budgets, per user (every session of a person
//! shares them), over a sliding minute:
//!
//! - [`TEST_PER_MINUTE`] for Test connection with a draft (`<tool>.test`, `temporal.testCodec`,
//!   `messaging.registry.test`): each one signs in at a target with credentials the caller typed,
//!   so the budget bounds how fast the server can be used to guess a target's password;
//! - [`WRITE_PER_MINUTE`] for the others (`secrets.set`, `profiles.create`, `update`, `import`,
//!   `app.account.*`), generous enough for importing a browser's profiles one call each.
//!
//! [`UNCOUNTED`] lists the one exception: `term.write` redacts what is typed into a terminal,
//! which is keystrokes, not a credential sent to the server.
//!
//! A refused call is not audited (it never reaches the Authorizer), as a call to a handle that is
//! gone is not.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use ambidex::{Code, ErrorPayload, ProcedureMeta, Session, Targets};
use security_types::{Clock, TargetRef};
use serde_json::Value;

/// Test connections with a draft, per user per minute.
pub const TEST_PER_MINUTE: usize = 20;
/// Other calls carrying a secret, per user per minute.
pub const WRITE_PER_MINUTE: usize = 300;
/// Procedures whose redacted input is not a secret sent to the server.
pub const UNCOUNTED: &[&str] = &["term.write"];
/// Users tracked at once; past it the idle ones go first, then the oldest.
const MAX_TRACKED: usize = 16_384;
const MINUTE_MS: u64 = 60_000;

/// Which budget a procedure's calls draw from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Budget {
    /// Test connection with a draft.
    Test,
    /// Any other call that carries a secret.
    Write,
}

impl Budget {
    /// The budget of `meta`'s calls, `None` for a procedure that carries no secret.
    pub fn of(meta: &ProcedureMeta) -> Option<Budget> {
        if meta.redact.is_empty() || UNCOUNTED.contains(&meta.name.as_str()) {
            return None;
        }
        let test = meta.name.ends_with(".test") || meta.name.ends_with(".testCodec");
        Some(if test { Budget::Test } else { Budget::Write })
    }

    pub fn per_minute(self) -> usize {
        match self {
            Budget::Test => TEST_PER_MINUTE,
            Budget::Write => WRITE_PER_MINUTE,
        }
    }

    fn what(self) -> &'static str {
        match self {
            Budget::Test => "Test connection calls with typed credentials",
            Budget::Write => "calls that carry a secret",
        }
    }
}

/// Whether `input` holds a value at one of `meta`'s redacted paths.
pub fn carries_secret(meta: &ProcedureMeta, input: &Value) -> bool {
    meta.redact.iter().any(|path| {
        let mut at = input;
        for part in path.split('.') {
            match at.get(part) {
                Some(next) => at = next,
                None => return false,
            }
        }
        has_value(at)
    })
}

fn has_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => a.iter().any(has_value),
        Value::Object(o) => o.values().any(has_value),
        Value::Bool(_) | Value::Number(_) => true,
    }
}

#[derive(Default)]
struct Windows {
    by_user: HashMap<(String, Budget), VecDeque<u64>>,
}

impl Windows {
    /// Counts a call at `now`; `Err(wait_ms)` when the budget is spent.
    fn hit(&mut self, user: &str, budget: Budget, now: u64) -> Result<(), u64> {
        if self.by_user.len() >= MAX_TRACKED {
            self.by_user.retain(|_, times| {
                times
                    .back()
                    .is_some_and(|t| now.saturating_sub(*t) < MINUTE_MS)
            });
            while self.by_user.len() >= MAX_TRACKED {
                let oldest = self
                    .by_user
                    .iter()
                    .min_by_key(|(_, times)| times.back().copied().unwrap_or(0))
                    .map(|(key, _)| key.clone());
                match oldest {
                    Some(key) => {
                        self.by_user.remove(&key);
                    }
                    None => break,
                }
            }
        }
        let times = self.by_user.entry((user.to_owned(), budget)).or_default();
        while times
            .front()
            .is_some_and(|t| now.saturating_sub(*t) >= MINUTE_MS)
        {
            times.pop_front();
        }
        if times.len() >= budget.per_minute() {
            let oldest = times.front().copied().unwrap_or(now);
            return Err((oldest + MINUTE_MS).saturating_sub(now).max(1));
        }
        times.push_back(now);
        Ok(())
    }
}

/// A [`Targets`] resolver that spends the caller's budget first (see the module docs).
pub struct SecretCallLimits<T> {
    inner: T,
    clock: Arc<dyn Clock>,
    windows: Mutex<Windows>,
}

impl<T> SecretCallLimits<T> {
    pub fn new(inner: T, clock: Arc<dyn Clock>) -> SecretCallLimits<T> {
        SecretCallLimits {
            inner,
            clock,
            windows: Mutex::default(),
        }
    }

    /// Spends one call of `meta` for `user`, or says how long to wait.
    pub fn spend(
        &self,
        user: &str,
        meta: &ProcedureMeta,
        input: &Value,
    ) -> Result<(), ErrorPayload> {
        let Some(budget) = Budget::of(meta) else {
            return Ok(());
        };
        if !carries_secret(meta, input) {
            return Ok(());
        }
        let now = self.clock.now_unix_ms();
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        windows.hit(user, budget, now).map_err(|wait_ms| {
            let mut err = ErrorPayload::new(
                Code::ResourceExhausted,
                format!(
                    "too many {} (at most {} a minute for one person); try again in {} s",
                    budget.what(),
                    budget.per_minute(),
                    wait_ms.div_ceil(1000)
                ),
            );
            err.retryable = true;
            err
        })
    }
}

impl<T: Targets> Targets for SecretCallLimits<T> {
    fn target(
        &self,
        session: &Session,
        meta: &ProcedureMeta,
        input: &Value,
    ) -> Result<Option<TargetRef>, ErrorPayload> {
        self.spend(&session.principal.id, meta, input)?;
        self.inner.target(session, meta, input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestClock(AtomicU64);

    impl Clock for TestClock {
        fn now_unix_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }
        fn sleep_until(&self, _deadline: u64) -> futures_util::future::BoxFuture<'_, ()> {
            Box::pin(std::future::pending())
        }
    }

    fn meta(name: &str, redact: &[&str]) -> ProcedureMeta {
        let mut meta = ProcedureMeta::new(
            name,
            ambidex::ProcedureKind::Mutation,
            "x.write",
            ambidex::Risk::Write,
        );
        meta.redact = redact.iter().map(|s| (*s).to_owned()).collect();
        meta
    }

    fn limits() -> (Arc<TestClock>, SecretCallLimits<()>) {
        let clock = Arc::new(TestClock(AtomicU64::new(1_000_000)));
        (clock.clone(), SecretCallLimits::new((), clock))
    }

    #[test]
    fn the_budget_comes_from_the_metadata() {
        assert_eq!(
            Budget::of(&meta("nats.test", &["draft.secrets"])),
            Some(Budget::Test)
        );
        assert_eq!(
            Budget::of(&meta("temporal.testCodec", &["draft.secrets"])),
            Some(Budget::Test)
        );
        assert_eq!(
            Budget::of(&meta("secrets.set", &["value"])),
            Some(Budget::Write)
        );
        assert_eq!(Budget::of(&meta("term.write", &["data"])), None);
        assert_eq!(Budget::of(&meta("nats.list", &[])), None);
    }

    #[test]
    fn only_a_call_that_holds_a_secret_counts() {
        let m = meta("profiles.create", &["secrets"]);
        assert!(!carries_secret(&m, &serde_json::json!({ "name": "a" })));
        assert!(!carries_secret(&m, &serde_json::json!({ "secrets": {} })));
        assert!(!carries_secret(
            &m,
            &serde_json::json!({ "secrets": { "token": "" } })
        ));
        assert!(carries_secret(
            &m,
            &serde_json::json!({ "secrets": { "token": "t" } })
        ));
        let t = meta("nats.test", &["draft.secrets"]);
        assert!(carries_secret(
            &t,
            &serde_json::json!({ "draft": { "secrets": { "password": "p" } } })
        ));
        assert!(!carries_secret(&t, &serde_json::json!({ "basedOn": "p1" })));
    }

    #[test]
    fn a_spent_budget_refuses_until_the_minute_has_passed() {
        let (clock, limits) = limits();
        let m = meta("nats.test", &["draft.secrets"]);
        let input = serde_json::json!({ "draft": { "secrets": { "password": "p" } } });
        for _ in 0..TEST_PER_MINUTE {
            limits.spend("alice", &m, &input).unwrap();
        }
        let err = limits.spend("alice", &m, &input).unwrap_err();
        assert_eq!(err.code, Code::ResourceExhausted);
        assert!(err.message.contains("try again in 60 s"), "{}", err.message);
        // Another person has their own budget, and so has the other budget of the same person.
        limits.spend("bob", &m, &input).unwrap();
        limits
            .spend(
                "alice",
                &meta("secrets.set", &["value"]),
                &serde_json::json!({ "value": "v" }),
            )
            .unwrap();
        // The secret is never in the message.
        assert!(!err.message.contains("\"p\""));
        clock.0.fetch_add(MINUTE_MS, Ordering::SeqCst);
        limits.spend("alice", &m, &input).unwrap();
    }

    #[test]
    fn calls_without_a_secret_are_never_refused() {
        let (_, limits) = limits();
        let m = meta("profiles.create", &["secrets"]);
        for _ in 0..(WRITE_PER_MINUTE * 2) {
            limits
                .spend("alice", &m, &serde_json::json!({ "secrets": {} }))
                .unwrap();
        }
    }

    #[test]
    fn many_users_stay_bounded_in_memory() {
        let (_, limits) = limits();
        let m = meta("secrets.set", &["value"]);
        let input = serde_json::json!({ "value": "v" });
        for i in 0..(MAX_TRACKED + 10) {
            limits.spend(&format!("u{i}"), &m, &input).unwrap();
        }
        assert!(limits.windows.lock().unwrap().by_user.len() <= MAX_TRACKED);
    }
}
