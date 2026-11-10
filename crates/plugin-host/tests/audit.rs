//! Grant changes against an audit sink that fails or hangs (Ambidex spec Open question 26h):
//! creates fail closed with `Unavailable` within the audit timeout, and revocation takes effect at
//! once while its entry is retried in the background and a final failure is reported.

use std::collections::{BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use plugin_host::grant::address_policy;
use plugin_host::{
    AuditEntryKind, AuditError, AuditFailure, AuditFailureEffect, AuditReporter, AuditSink,
    Eligibility, GrantError, GrantRequest, GrantStore, InstalledPlugin, Manifest, MemoryAuditLog,
    RetryPolicy, SystemClock, TlsPolicy,
};
use security_types::{
    AuditDecision, AuditEntry, Authorizer, AuthzRequest, BoxFuture, Decision, Digest, Outcome,
    Principal, PrincipalKind, RoleId, SessionId, TenantId,
};

const MANIFEST: &str = r#"
manifest_version = 1
id = "org.example.dbee.postgres"
version = "0.1.0"
kind = "wasm"
entry = "components/postgres.wasm"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "example"

[[capabilities.network]]
id = "tls-optional"
protocol = "tcp"
tls = "optional"
"#;

/// What the sink does with the next entries.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Record,
    Fail,
    /// Never answers.
    Hang,
    /// Records after a while.
    Slow(Duration),
    /// Fails after a while.
    SlowFail(Duration),
}

/// A sink whose behaviour a test switches; recorded entries go to an in-memory log.
#[derive(Clone)]
struct Switch {
    mode: Arc<Mutex<Mode>>,
    /// Modes for the next entries, one each, before `mode`.
    script: Arc<Mutex<VecDeque<Mode>>>,
    log: Arc<MemoryAuditLog>,
}

impl Switch {
    fn new(mode: Mode) -> Self {
        Self {
            mode: Arc::new(Mutex::new(mode)),
            script: Arc::default(),
            log: Arc::new(MemoryAuditLog::new()),
        }
    }

    fn set(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    /// The next entries get `modes`, one each.
    fn script(&self, modes: &[Mode]) {
        self.script.lock().unwrap().extend(modes);
    }

    fn actions(&self) -> Vec<(String, AuditDecision)> {
        self.log
            .entries()
            .into_iter()
            .map(|e| (e.action.name, e.decision))
            .collect()
    }
}

impl AuditSink for Switch {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        let scripted = self.script.lock().unwrap().pop_front();
        let mode = scripted.unwrap_or_else(|| *self.mode.lock().unwrap());
        match mode {
            Mode::Record => self.log.append(entry),
            Mode::Fail => Box::pin(async { Err(AuditError("disk full".into())) }),
            Mode::Hang => Box::pin(std::future::pending()),
            Mode::Slow(delay) => {
                let log = Arc::clone(&self.log);
                Box::pin(async move {
                    tokio::time::sleep(delay).await;
                    log.append(entry).await
                })
            }
            Mode::SlowFail(delay) => Box::pin(async move {
                tokio::time::sleep(delay).await;
                Err(AuditError("disk full".into()))
            }),
        }
    }
}

#[derive(Clone, Default)]
struct Reports(Arc<Mutex<Vec<AuditFailure>>>);

impl Reports {
    fn all(&self) -> Vec<AuditFailure> {
        self.0.lock().unwrap().clone()
    }
}

impl AuditReporter for Reports {
    fn report(&self, failure: &AuditFailure) {
        self.0.lock().unwrap().push(failure.clone());
    }
}

struct Allow;

impl Authorizer for Allow {
    async fn check(&self, _req: &AuthzRequest<'_>) -> Decision {
        Decision::Allow
    }
}

fn admin() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:oidc:admin".into(),
        tenant: TenantId::new("t1"),
        on_behalf_of: None,
        roles: vec![RoleId::new("admin")],
        session: SessionId::new("s1"),
    }
}

fn plugin() -> InstalledPlugin {
    InstalledPlugin::from_manifest(&Manifest::from_toml(MANIFEST).unwrap(), Digest([0xab; 32]))
}

fn request(target: &str) -> GrantRequest {
    GrantRequest {
        tenant: TenantId::new("t1"),
        owner: "tenant:t1".into(),
        eligible: Eligibility {
            principals: BTreeSet::new(),
            roles: [RoleId::new("analyst")].into_iter().collect(),
        },
        connection_id: format!("team:srv:{target}"),
        target_id: target.into(),
        template_id: "tls-optional".into(),
        host: "127.0.0.1".into(),
        port: 5432,
        tls: TlsPolicy::Disabled,
        addresses: address_policy(&["127.0.0.1/32"]).unwrap(),
        secret: None,
        allow_cancel_connection: false,
        expires_at_unix_ms: None,
    }
}

const AUDIT_TIMEOUT: Duration = Duration::from_millis(100);

/// Short retries, so a test sees the final outcome quickly.
const RETRY: RetryPolicy = RetryPolicy {
    attempts: 3,
    first_backoff: Duration::from_millis(10),
    max_backoff: Duration::from_millis(20),
    attempt_timeout: Duration::from_millis(50),
    capacity: 16,
};

fn store(sink: &Switch, reports: &Reports) -> GrantStore {
    GrantStore::new(Arc::new(SystemClock), Arc::new(sink.clone()))
        .with_audit_timeout(AUDIT_TIMEOUT)
        .with_audit_reporter_and_retry(Arc::new(reports.clone()), RETRY)
}

async fn create(store: &GrantStore, target: &str) -> Result<plugin_host::GrantId, GrantError> {
    store
        .create(&Allow, &admin(), &plugin(), request(target), "corr-create")
        .await
        .map(|grant| grant.id.clone())
}

/// Waits (bounded) for something the background writer does.
async fn eventually(what: &str, mut done: impl FnMut() -> bool) {
    let waited = tokio::time::timeout(Duration::from_secs(5), async {
        while !done() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await;
    assert!(waited.is_ok(), "timed out waiting for {what}");
}

#[tokio::test]
async fn hung_sink_makes_grant_creation_time_out_and_fail_closed() {
    let sink = Switch::new(Mode::Hang);
    let reports = Reports::default();
    let store = store(&sink, &reports);

    // Two creates at once, of different targets: each write hangs, and each gives up within the
    // audit timeout instead of hanging.
    let started = tokio::time::Instant::now();
    let (first, second) = tokio::join!(create(&store, "pg1"), create(&store, "pg2"));
    assert_eq!(first, Err(GrantError::Unavailable));
    assert_eq!(second, Err(GrantError::Unavailable));
    assert!(
        started.elapsed() < AUDIT_TIMEOUT * 5,
        "{:?}",
        started.elapsed()
    );

    // Nothing was granted: both targets are still free once the sink answers again.
    sink.set(Mode::Record);
    let id = create(&store, "pg1").await.unwrap();
    assert!(store.is_active(&id));
    create(&store, "pg2").await.unwrap();

    // Both failures were reported as blocking the create, never as having let it through.
    let failures = reports.all();
    assert_eq!(failures.len(), 2, "{failures:?}");
    assert!(
        failures
            .iter()
            .all(|f| f.action == "plugin-host.grants.create"
                && f.entry == AuditEntryKind::Operation
                && f.effect == AuditFailureEffect::Blocked
                && f.correlation_id == "corr-create")
    );
}

#[tokio::test]
async fn failing_sink_makes_grant_creation_fail_closed() {
    let sink = Switch::new(Mode::Fail);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    assert_eq!(create(&store, "pg1").await, Err(GrantError::Unavailable));
    assert_eq!(reports.all()[0].error, AuditError("disk full".into()));
    sink.set(Mode::Record);
    create(&store, "pg1")
        .await
        .expect("the target is still free");
}

#[tokio::test]
async fn hung_sink_does_not_block_revocation() {
    let sink = Switch::new(Mode::Record);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let id = create(&store, "pg1").await.unwrap();

    sink.set(Mode::Hang);
    let revoked = tokio::time::timeout(
        Duration::from_millis(20),
        store.revoke(&Allow, &admin(), &id, "corr-revoke"),
    )
    .await
    .expect("revocation never waits on the sink");
    assert_eq!(revoked, Ok(()));
    assert!(store.is_revoked(&id));
    assert!(!store.is_active(&id));
    // The entry is not written yet, but it is not forgotten: once the sink answers, a retry
    // writes it.
    assert_eq!(sink.actions().len(), 1);
    sink.set(Mode::Record);
    tokio::time::timeout(Duration::from_secs(5), store.flush_audit())
        .await
        .expect("the queue drains");
    assert_eq!(
        sink.actions(),
        [
            ("plugin-host.grants.create".to_owned(), AuditDecision::Allow),
            ("plugin-host.grants.revoke".to_owned(), AuditDecision::Allow),
        ]
    );
    assert!(reports.all().is_empty(), "{:?}", reports.all());
}

#[tokio::test]
async fn revocation_entry_that_cannot_be_written_is_reported() {
    let sink = Switch::new(Mode::Record);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let id = create(&store, "pg1").await.unwrap();

    sink.set(Mode::Fail);
    store
        .revoke(&Allow, &admin(), &id, "corr-revoke")
        .await
        .unwrap();
    assert!(store.is_revoked(&id));
    store.flush_audit().await;
    let failures = reports.all();
    assert_eq!(failures.len(), 1, "{failures:?}");
    let failure = &failures[0];
    assert_eq!(failure.action, "plugin-host.grants.revoke");
    assert_eq!(failure.correlation_id, "corr-revoke");
    assert_eq!(failure.effect, AuditFailureEffect::EntryLost);
    assert_eq!(failure.attempts, RETRY.attempts);
    assert_eq!(failure.error, AuditError("disk full".into()));
}

#[tokio::test]
async fn revocation_entry_is_written_at_once_by_a_sink_that_answers() {
    let sink = Switch::new(Mode::Record);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let id = create(&store, "pg1").await.unwrap();
    store
        .revoke(&Allow, &admin(), &id, "corr-revoke")
        .await
        .unwrap();
    // No flush needed: the first poll wrote it.
    let entries = sink.log.entries();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].outcome, Outcome::Success);
    assert_eq!(entries[1].correlation_id, "corr-revoke");
}

#[tokio::test]
async fn a_slow_revocation_write_finishes_in_the_background() {
    let sink = Switch::new(Mode::Record);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let id = create(&store, "pg1").await.unwrap();
    sink.set(Mode::Hang);
    store
        .revoke(&Allow, &admin(), &id, "corr-revoke")
        .await
        .unwrap();
    // The first attempt hangs and times out; later attempts succeed once the sink recovers.
    sink.set(Mode::Record);
    eventually("the revoke entry", || sink.actions().len() == 2).await;
    store.flush_audit().await;
    assert!(reports.all().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_slow_sink_does_not_fail_creates_of_other_targets() {
    // Each write takes most of the audit timeout. Six creates of different targets at once all
    // succeed: they do not wait for each other.
    let delay = AUDIT_TIMEOUT * 4 / 5;
    let sink = Switch::new(Mode::Slow(delay));
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let started = tokio::time::Instant::now();
    let (a, b, c, d, e, f) = tokio::join!(
        create(&store, "pg1"),
        create(&store, "pg2"),
        create(&store, "pg3"),
        create(&store, "pg4"),
        create(&store, "pg5"),
        create(&store, "pg6"),
    );
    let results = [a, b, c, d, e, f];
    assert!(results.iter().all(Result::is_ok), "{results:?}");
    assert_eq!(started.elapsed(), delay);
    assert_eq!(sink.actions().len(), 6);
    assert!(reports.all().is_empty(), "{:?}", reports.all());
}

#[tokio::test(start_paused = true)]
async fn creates_of_one_target_wait_for_each_other_and_each_write_has_its_own_timeout() {
    // The first create of pg1 holds the target while its write fails slowly; the second waits
    // for it, then gets the whole audit timeout for its own slow write.
    let delay = AUDIT_TIMEOUT * 4 / 5;
    let sink = Switch::new(Mode::Record);
    sink.script(&[Mode::SlowFail(delay), Mode::Slow(delay)]);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let (first, second) = tokio::join!(create(&store, "pg1"), create(&store, "pg1"));
    assert_eq!(first, Err(GrantError::Unavailable));
    let id = second.expect("the second create had its own write timeout");
    assert!(store.is_active(&id));
    // A third create of the same target now finds it taken.
    assert_eq!(create(&store, "pg1").await, Err(GrantError::TargetInUse));
    let failures = reports.all();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].error, AuditError("disk full".into()));
}

#[tokio::test(start_paused = true)]
async fn a_create_waiting_too_long_for_the_same_target_fails_closed() {
    let sink = Switch::new(Mode::Hang);
    let reports = Reports::default();
    let store = store(&sink, &reports);
    let (first, second) = tokio::join!(create(&store, "pg1"), create(&store, "pg1"));
    assert_eq!(first, Err(GrantError::Unavailable));
    assert_eq!(second, Err(GrantError::Unavailable));
    // Both time out at the same instant, so in either order.
    let mut errors: Vec<_> = reports.all().into_iter().map(|f| f.error.0).collect();
    errors.sort();
    assert_eq!(
        errors,
        [
            "timed out waiting for another create of this target",
            "write timed out",
        ]
    );
}

#[test]
fn entries_queued_when_the_writer_runtime_stops_are_reported_lost() {
    let runtime = || {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    };
    let sink = Switch::new(Mode::Record);
    let reports = Reports::default();
    let store = store(&sink, &reports);

    // The revoke entry is queued on the first runtime's writer, which then goes away.
    let first = runtime();
    let id = first.block_on(async {
        let id = create(&store, "pg1").await.unwrap();
        sink.set(Mode::Hang);
        store
            .revoke(&Allow, &admin(), &id, "corr-revoke")
            .await
            .unwrap();
        tokio::task::yield_now().await;
        id
    });
    drop(first);
    assert!(store.is_revoked(&id));

    // Nothing hangs and nothing disappears unreported: the entry is reported as lost, and a new
    // writer serves the next runtime.
    let second = runtime();
    second.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), store.flush_audit())
            .await
            .expect("flush_audit returns");
        let failures = reports.all();
        assert_eq!(failures.len(), 1, "{failures:?}");
        assert_eq!(failures[0].action, "plugin-host.grants.revoke");
        assert_eq!(failures[0].correlation_id, "corr-revoke");
        assert_eq!(failures[0].effect, AuditFailureEffect::EntryLost);

        sink.set(Mode::Record);
        let id = create(&store, "pg2").await.unwrap();
        sink.set(Mode::Slow(Duration::from_millis(1)));
        store
            .revoke(&Allow, &admin(), &id, "corr-revoke-2")
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), store.flush_audit())
            .await
            .expect("flush_audit returns");
        assert_eq!(reports.all().len(), 1, "{:?}", reports.all());
        assert_eq!(
            sink.log.entries().last().unwrap().correlation_id,
            "corr-revoke-2"
        );
    });
}
