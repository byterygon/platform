//! The destroy confirmation (DOC-25 §3.3.6): every Destructive call by a person needs a
//! confirmation the server issues and checks, on Ambidex's approval path.
//!
//! 1. The call arrives without a confirmed challenge: the [`RoleAuthorizer`](super::RoleAuthorizer)
//!    answers `NeedsApproval` (expiring in [`PENDING_FOR_MS`]); the router asks [`Confirmations`]
//!    (its [`Approvals`]) to record it, with the call's redacted input, and the client gets
//!    `ApprovalRequired { approvalId }`.
//! 2. `app.confirmations.get` shows the challenge to the same login session only: the action,
//!    where, and the **phrase** to type: the resource's name ([`subject`]).
//! 3. `app.confirmations.confirm { approvalId, typed }`: the same login session and principal, not
//!    expired, not used, and `typed` equal to the phrase (case-sensitive, not trimmed). The
//!    challenge is then confirmed for [`CONFIRMED_FOR_MS`]. Wrong answers: [`WRONG_PER_MINUTE`] per
//!    minute per session, then `ResourceExhausted` for a minute.
//! 4. The same call again, with the same input: the Authorizer finds the confirmed challenge for
//!    (login session, principal, action, target, input digest), marks it used and allows the
//!    call. Any other input gets a new challenge; a challenge is used once.
//!
//! At most [`MAX_PENDING`] challenges per session, in memory only: a restart drops them (the
//! oldest goes first when a session asks for more). Re-authentication before a destroy
//! (`auth.reauth_for_destroy`, default off, Open question 12) is not built yet; `reauth` is
//! always false.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use ambidex::Approvals;
use ambidex::engine::BoxFuture;
use ambidex_axum::login_session_of;
use security_types::{ApprovalSpec, Clock, Digest, Principal, ProfileTarget, TargetRef};
use serde_json::Value;

use super::targets;

/// How long a challenge waits for its answer.
pub const PENDING_FOR_MS: u64 = 120_000;
/// How long a confirmed challenge waits for the call it allows.
pub const CONFIRMED_FOR_MS: u64 = 60_000;
/// Pending challenges kept per login session.
pub const MAX_PENDING: usize = 16;
/// Wrong answers per minute per login session before a minute's pause.
pub const WRONG_PER_MINUTE: u32 = 5;

/// Names of at most this many characters are typed whole; longer ones by their first
/// [`SHORT_PHRASE`] characters (a container id, a UUID).
pub const LONG_NAME: usize = 32;
pub const SHORT_PHRASE: usize = 12;

/// What each Destructive procedure asks a person to type: the kind of resource and the input
/// field that names it. A list (Docker removes several at once) is confirmed by its one name, or
/// by its count (`3 containers`). The completeness test fails for a Destructive procedure
/// missing here.
pub const SUBJECTS: [(&str, &str, &str); 19] = [
    ("docker.containers.remove", "container", "ids"),
    ("docker.images.remove", "image", "ids"),
    ("docker.networks.remove", "network", "ids"),
    ("docker.volumes.remove", "volume", "names"),
    ("langgraph.runs.rollback", "run", "runId"),
    ("langgraph.store.delete", "item", "key"),
    ("langgraph.threads.delete", "thread", "threadId"),
    ("nats.js.consumers.delete", "consumer", "consumer"),
    ("nats.js.streams.delete", "stream", "stream"),
    ("nats.js.streams.purge", "stream", "stream"),
    ("nats.kv.buckets.delete", "bucket", "bucket"),
    ("nats.kv.delete", "key", "key"),
    ("nats.kv.purge", "key", "key"),
    ("nats.obj.buckets.delete", "bucket", "bucket"),
    ("nats.obj.delete", "object", "name"),
    ("temporal.activities.terminate", "activity", "activityId"),
    ("temporal.schedules.delete", "schedule", "scheduleId"),
    ("temporal.workflows.reset", "workflow", "workflowId"),
    ("temporal.workflows.terminate", "workflow", "workflowId"),
];

/// What a person confirms: the kind and name of the resource, and the phrase to type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Subject {
    pub kind: String,
    pub name: String,
    pub phrase: String,
}

/// The phrase for a name: whole, or the first [`SHORT_PHRASE`] characters of a long one.
pub fn phrase_of(name: &str) -> String {
    if name.chars().count() > LONG_NAME {
        name.chars().take(SHORT_PHRASE).collect()
    } else {
        name.to_owned()
    }
}

/// The subject of a call to `procedure` with `input`; `None` for a procedure not in
/// [`SUBJECTS`] or an input without its name.
pub fn subject(procedure: &str, input: &Value) -> Option<Subject> {
    let (_, kind, field) = SUBJECTS.iter().find(|(p, _, _)| *p == procedure)?;
    let name = match &input[*field] {
        Value::String(s) if !s.is_empty() => s.clone(),
        Value::Array(items) => match items.as_slice() {
            [] => return None,
            [one] => one.as_str().filter(|s| !s.is_empty())?.to_owned(),
            many => {
                let count = format!("{} {kind}s", many.len());
                return Some(Subject {
                    kind: (*kind).to_owned(),
                    name: count.clone(),
                    phrase: count,
                });
            }
        },
        _ => return None,
    };
    Some(Subject {
        kind: (*kind).to_owned(),
        phrase: phrase_of(&name),
        name,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Confirmed { until_ms: u64 },
    Used,
}

#[derive(Debug, Clone)]
struct Challenge {
    login_session: String,
    principal: String,
    action: String,
    target: Option<TargetRef>,
    input_digest: Digest,
    subject: Subject,
    created_ms: u64,
    expires_ms: u64,
    state: State,
}

#[derive(Default)]
struct Wrong {
    window_start_ms: u64,
    count: u32,
    paused_until_ms: u64,
}

#[derive(Default)]
struct Inner {
    challenges: HashMap<String, Challenge>,
    wrong: HashMap<String, Wrong>,
}

/// What `app.confirmations.get` shows of a challenge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChallengeView {
    pub action: String,
    pub tool: String,
    pub target: Option<TargetRef>,
    pub context: Option<String>,
    pub namespace: Option<String>,
    pub subject: Subject,
    pub expires_ms: u64,
}

/// Why a challenge was not shown or confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmError {
    /// No such challenge for this login session (another session's looks the same).
    NotFound,
    Expired,
    /// Confirmed or used already.
    Answered,
    /// The typed text is not the phrase.
    Wrong,
    /// Too many wrong answers: wait until then (Unix ms).
    Paused {
        until_ms: u64,
    },
}

/// The challenges of every session, and the Approvals store of the router.
pub struct Confirmations {
    clock: Arc<dyn Clock>,
    inner: Mutex<Inner>,
}

fn new_id() -> String {
    format!("apr_{}", crate::core::random_id())
}

impl Confirmations {
    pub fn new(clock: Arc<dyn Clock>) -> Confirmations {
        Confirmations {
            clock,
            inner: Mutex::default(),
        }
    }

    pub fn now_ms(&self) -> u64 {
        self.clock.now_unix_ms()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Records a challenge; `None` when the call names nothing to confirm.
    fn record(&self, principal: &Principal, spec: &ApprovalSpec, input: &Value) -> Option<String> {
        let subject = subject(&spec.action.name, input)?;
        let now = self.now_ms();
        let login_session = login_session_of(principal.session.as_str()).to_owned();
        let mut inner = self.lock();
        inner.challenges.retain(|_, c| match c.state {
            State::Pending => c.expires_ms > now,
            State::Confirmed { until_ms } => until_ms > now,
            State::Used => false,
        });
        let mut mine: Vec<(u64, String)> = inner
            .challenges
            .iter()
            .filter(|(_, c)| c.login_session == login_session && c.state == State::Pending)
            .map(|(id, c)| (c.created_ms, id.clone()))
            .collect();
        mine.sort();
        while mine.len() >= MAX_PENDING {
            let (_, oldest) = mine.remove(0);
            inner.challenges.remove(&oldest);
        }
        let id = new_id();
        let expires_ms = if spec.expires_at_unix_ms > now {
            spec.expires_at_unix_ms
        } else {
            now + PENDING_FOR_MS
        };
        inner.challenges.insert(
            id.clone(),
            Challenge {
                login_session,
                principal: principal.id.clone(),
                action: spec.action.name.clone(),
                target: spec.target.clone(),
                input_digest: spec.input_digest,
                subject,
                created_ms: now,
                expires_ms,
                state: State::Pending,
            },
        );
        Some(id)
    }

    /// The challenge `id` as its own login session sees it.
    pub fn get(&self, login_session: &str, id: &str) -> Result<ChallengeView, ConfirmError> {
        let now = self.now_ms();
        let inner = self.lock();
        let c = inner
            .challenges
            .get(id)
            .filter(|c| c.login_session == login_session)
            .ok_or(ConfirmError::NotFound)?;
        if c.state != State::Pending {
            return Err(ConfirmError::Answered);
        }
        if c.expires_ms <= now {
            return Err(ConfirmError::Expired);
        }
        let (tool, context, namespace) = match &c.target {
            Some(t) if targets::browser_tool(t).is_some() => {
                let tool = targets::browser_tool(t).unwrap_or_default().to_owned();
                let ns = t.id.split_once("/ns:").map(|(_, n)| n.to_owned());
                (tool, None, ns)
            }
            Some(t) => match ProfileTarget::of(t) {
                Some(p) => (
                    c.action.split('.').next().unwrap_or_default().to_owned(),
                    p.context.map(str::to_owned),
                    p.namespace.map(str::to_owned),
                ),
                None => (String::new(), None, None),
            },
            None => (
                c.action.split('.').next().unwrap_or_default().to_owned(),
                None,
                None,
            ),
        };
        Ok(ChallengeView {
            action: c.action.clone(),
            tool,
            target: c.target.clone(),
            context,
            namespace,
            subject: c.subject.clone(),
            expires_ms: c.expires_ms,
        })
    }

    /// Answers the challenge `id` for `principal` on its login session.
    pub fn confirm(
        &self,
        principal: &Principal,
        id: &str,
        typed: &str,
    ) -> Result<(), ConfirmError> {
        let now = self.now_ms();
        let login_session = login_session_of(principal.session.as_str());
        let mut guard = self.lock();
        let inner = &mut *guard;
        let wrong = inner.wrong.entry(login_session.to_owned()).or_default();
        if wrong.paused_until_ms > now {
            return Err(ConfirmError::Paused {
                until_ms: wrong.paused_until_ms,
            });
        }
        let c = inner
            .challenges
            .get_mut(id)
            .filter(|c| c.login_session == login_session && c.principal == principal.id)
            .ok_or(ConfirmError::NotFound)?;
        if c.state != State::Pending {
            return Err(ConfirmError::Answered);
        }
        if c.expires_ms <= now {
            return Err(ConfirmError::Expired);
        }
        if typed != c.subject.phrase {
            if now.saturating_sub(wrong.window_start_ms) >= 60_000 {
                wrong.window_start_ms = now;
                wrong.count = 0;
            }
            wrong.count += 1;
            if wrong.count >= WRONG_PER_MINUTE {
                wrong.paused_until_ms = now + 60_000;
                wrong.count = 0;
            }
            return Err(ConfirmError::Wrong);
        }
        c.state = State::Confirmed {
            until_ms: now + CONFIRMED_FOR_MS,
        };
        Ok(())
    }

    /// Uses the confirmed challenge that matches this call, if there is one: the Authorizer's
    /// step 7.
    pub fn consume(
        &self,
        principal: &Principal,
        action: &str,
        target: Option<&TargetRef>,
        input_digest: Digest,
    ) -> bool {
        let now = self.now_ms();
        let login_session = login_session_of(principal.session.as_str());
        let mut inner = self.lock();
        let found = inner.challenges.values_mut().find(|c| {
            matches!(c.state, State::Confirmed { until_ms } if until_ms > now)
                && c.login_session == login_session
                && c.principal == principal.id
                && c.action == action
                && c.target.as_ref() == target
                && c.input_digest == input_digest
        });
        match found {
            Some(c) => {
                c.state = State::Used;
                true
            }
            None => false,
        }
    }

    /// Records a challenge as the router would (tests of the Authorizer).
    #[cfg(test)]
    pub fn record_for_test(
        &self,
        principal: &Principal,
        spec: &ApprovalSpec,
        input: &Value,
    ) -> String {
        self.record(principal, spec, input).expect("a subject")
    }

    /// Challenges held (tests).
    pub fn len(&self) -> usize {
        self.lock().challenges.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Approvals for Confirmations {
    fn request<'a>(
        &'a self,
        _principal: &'a Principal,
        _spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>> {
        // Without the input there is no name to confirm.
        Box::pin(std::future::ready(None))
    }

    fn request_for<'a>(
        &'a self,
        principal: &'a Principal,
        spec: &'a ApprovalSpec,
        input: Option<&'a Value>,
    ) -> BoxFuture<'a, Option<String>> {
        let id = input.and_then(|input| self.record(principal, spec, input));
        Box::pin(std::future::ready(id))
    }
}

/// [`Approvals`] for an `Arc<Confirmations>` shared with the Authorizer and the procedures.
pub struct SharedConfirmations(pub Arc<Confirmations>);

impl Approvals for SharedConfirmations {
    fn request<'a>(
        &'a self,
        principal: &'a Principal,
        spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>> {
        self.0.request(principal, spec)
    }

    fn request_for<'a>(
        &'a self,
        principal: &'a Principal,
        spec: &'a ApprovalSpec,
        input: Option<&'a Value>,
    ) -> BoxFuture<'a, Option<String>> {
        self.0.request_for(principal, spec, input)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::{Action, PrincipalKind, Risk, SessionId, TenantId};
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct TestClock(AtomicU64);

    impl Clock for TestClock {
        fn now_unix_ms(&self) -> u64 {
            self.0.load(Ordering::SeqCst)
        }

        fn sleep_until(&self, _deadline_unix_ms: u64) -> security_types::BoxFuture<'_, ()> {
            Box::pin(std::future::ready(()))
        }
    }

    fn principal(id: &str, session: &str) -> Principal {
        Principal {
            kind: PrincipalKind::Human,
            id: id.into(),
            tenant: TenantId::new("t"),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new(format!("{session}.conn1")),
        }
    }

    fn spec(target: &str, digest: u8) -> ApprovalSpec {
        ApprovalSpec {
            action: Action::new("nats.kv.delete", "nats.destroy"),
            target: Some(targets::browser(target)),
            risk: Risk::Destructive,
            input_digest: Digest([digest; 32]),
            expires_at_unix_ms: 0,
        }
    }

    fn fixture() -> (Arc<TestClock>, Confirmations) {
        let clock = Arc::new(TestClock(AtomicU64::new(1_000_000)));
        let c = Confirmations::new(Arc::clone(&clock) as Arc<dyn Clock>);
        (clock, c)
    }

    fn ask(c: &Confirmations, p: &Principal, digest: u8) -> String {
        c.record(
            p,
            &spec("nats", digest),
            &json!({ "bucket": "b", "key": "orders.1" }),
        )
        .unwrap()
    }

    #[test]
    fn the_right_phrase_allows_the_same_call_once() {
        let (_, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        let id = ask(&c, &alice, 1);
        let view = c.get("ls_a", &id).unwrap();
        assert_eq!(view.subject.phrase, "orders.1");
        assert_eq!(
            (view.tool.as_str(), view.subject.kind.as_str()),
            ("nats", "key")
        );
        let target = targets::browser("nats");
        assert!(
            !c.consume(&alice, "nats.kv.delete", Some(&target), Digest([1; 32])),
            "not yet"
        );
        assert_eq!(c.confirm(&alice, &id, "Orders.1"), Err(ConfirmError::Wrong));
        assert_eq!(
            c.confirm(&alice, &id, " orders.1"),
            Err(ConfirmError::Wrong)
        );
        c.confirm(&alice, &id, "orders.1").unwrap();
        assert_eq!(
            c.confirm(&alice, &id, "orders.1"),
            Err(ConfirmError::Answered)
        );
        // Another input, target or action is another call.
        assert!(!c.consume(&alice, "nats.kv.delete", Some(&target), Digest([2; 32])));
        assert!(!c.consume(&alice, "nats.kv.purge", Some(&target), Digest([1; 32])));
        assert!(!c.consume(
            &alice,
            "nats.kv.delete",
            Some(&targets::browser("docker")),
            Digest([1; 32])
        ));
        assert!(c.consume(&alice, "nats.kv.delete", Some(&target), Digest([1; 32])));
        assert!(
            !c.consume(&alice, "nats.kv.delete", Some(&target), Digest([1; 32])),
            "used"
        );
    }

    #[test]
    fn another_session_or_principal_cannot_see_or_answer_it() {
        let (_, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        let id = ask(&c, &alice, 1);
        assert_eq!(c.get("ls_b", &id), Err(ConfirmError::NotFound));
        let alice_elsewhere = principal("human:account:A", "ls_b");
        assert_eq!(
            c.confirm(&alice_elsewhere, &id, "orders.1"),
            Err(ConfirmError::NotFound)
        );
        let mallory = principal("human:account:M", "ls_a");
        assert_eq!(
            c.confirm(&mallory, &id, "orders.1"),
            Err(ConfirmError::NotFound)
        );
        // Confirmed by Alice, the call of another session does not use it.
        c.confirm(&alice, &id, "orders.1").unwrap();
        let target = targets::browser("nats");
        assert!(!c.consume(
            &alice_elsewhere,
            "nats.kv.delete",
            Some(&target),
            Digest([1; 32])
        ));
    }

    #[test]
    fn challenges_expire_pending_and_confirmed() {
        let (clock, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        let id = ask(&c, &alice, 1);
        clock.0.fetch_add(PENDING_FOR_MS, Ordering::SeqCst);
        assert_eq!(c.get("ls_a", &id), Err(ConfirmError::Expired));
        assert_eq!(
            c.confirm(&alice, &id, "orders.1"),
            Err(ConfirmError::Expired)
        );
        let id = ask(&c, &alice, 1);
        c.confirm(&alice, &id, "orders.1").unwrap();
        clock.0.fetch_add(CONFIRMED_FOR_MS, Ordering::SeqCst);
        let target = targets::browser("nats");
        assert!(!c.consume(&alice, "nats.kv.delete", Some(&target), Digest([1; 32])));
    }

    #[test]
    fn wrong_answers_pause_the_session() {
        let (clock, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        let id = ask(&c, &alice, 1);
        for _ in 0..WRONG_PER_MINUTE {
            assert_eq!(c.confirm(&alice, &id, "nope"), Err(ConfirmError::Wrong));
        }
        assert!(matches!(
            c.confirm(&alice, &id, "orders.1"),
            Err(ConfirmError::Paused { .. })
        ));
        clock.0.fetch_add(60_000, Ordering::SeqCst);
        let id = ask(&c, &alice, 1);
        c.confirm(&alice, &id, "orders.1").unwrap();
    }

    #[test]
    fn a_session_keeps_its_newest_challenges() {
        let (clock, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        let first = ask(&c, &alice, 0);
        for i in 1..=MAX_PENDING as u8 {
            clock.0.fetch_add(1, Ordering::SeqCst);
            ask(&c, &alice, i);
        }
        assert_eq!(c.len(), MAX_PENDING);
        assert_eq!(c.get("ls_a", &first), Err(ConfirmError::NotFound));
    }

    #[test]
    fn subjects_name_what_is_destroyed() {
        let s = subject(
            "docker.volumes.remove",
            &json!({ "names": ["lab-scratch"] }),
        )
        .unwrap();
        assert_eq!(
            (s.kind.as_str(), s.phrase.as_str()),
            ("volume", "lab-scratch")
        );
        let s = subject(
            "docker.containers.remove",
            &json!({ "ids": ["a", "b", "c"] }),
        )
        .unwrap();
        assert_eq!(s.phrase, "3 containers");
        let long = "4f1c2a9e8d7b6c5a4f1c2a9e8d7b6c5a4f1c2a9e8d7b6c5a4f1c2a9e8d7b6c5a";
        let s = subject("docker.containers.remove", &json!({ "ids": [long] })).unwrap();
        assert_eq!((s.name.as_str(), s.phrase.as_str()), (long, "4f1c2a9e8d7b"));
        assert!(subject("docker.containers.remove", &json!({ "ids": [] })).is_none());
        assert!(subject("nats.kv.delete", &json!({ "key": "" })).is_none());
        assert!(subject("nats.kv.get", &json!({ "key": "k" })).is_none());
        // Without the input (a handler's re-check) nothing is recorded.
        let (_, c) = fixture();
        let alice = principal("human:account:A", "ls_a");
        assert!(c.record(&alice, &spec("nats", 1), &json!({})).is_none());
    }
}
