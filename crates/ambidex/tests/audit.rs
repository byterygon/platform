//! Audit of calls that run (spec §8, Open questions 24g and 26), through the router directly and
//! through the engine: two entries per call, failing closed when the admission cannot be written,
//! human Read calls failing open, completions with the handler's outcome and the delivery, and
//! correlation ids everywhere.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::security_types::{
    AuditDecision, AuditEntry, AuditEntryKind, AuditFailure, AuditFailureEffect, Authorizer,
    AuthzRequest, Decision, Delivery, Outcome, Principal, PrincipalKind, Reason, SessionId,
    TenantId, unfinished,
};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{
    AuditError, AuditPolicy, AuditReporter, AuditSink, Authenticate, Call, Code, Ctx, ErrorPayload,
    Hello, HumanReads, MemoryAuditLog, Risk, Router, RpcError, Server, ServerConfig, Session,
    TargetRef, rpc,
};
use serde_json::{Value, json};
use tokio::sync::Semaphore;

// ---- the API ---------------------------------------------------------------------------------

/// Counts handler entries, and work done after an in-call re-check.
#[derive(Default)]
struct Probe {
    entered: AtomicUsize,
    escalated: AtomicUsize,
    /// The router `audit.nested` calls back into.
    router: std::sync::OnceLock<Router>,
}

struct AuditApi(Arc<Probe>);

impl AuditApi {
    fn enter(&self) {
        self.0.entered.fetch_add(1, Ordering::SeqCst);
    }
}

#[rpc::router(namespace = "audit")]
impl AuditApi {
    #[rpc::query(perm = "audit.use", risk = Risk::Read, agent = Agent::Exposed)]
    async fn read(&self, _ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        Ok(input)
    }

    #[rpc::mutation(perm = "audit.use", risk = Risk::Write, agent = Agent::Exposed)]
    async fn write(&self, _ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        Ok(input)
    }

    #[rpc::mutation(perm = "audit.use", risk = Risk::Destructive, agent = Agent::Exposed)]
    async fn destroy(&self, _ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        Ok(input)
    }

    /// Read at baseline; escalates to Write on a target, then does the Write work.
    #[rpc::query(perm = "audit.use", risk = Risk::Read, agent = Agent::Exposed)]
    async fn escalate(&self, ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        self.enter();
        ctx.authorize(Some(&TargetRef::connection("c-1")), Risk::Write)
            .await?;
        self.0.escalated.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// A Read whose admission the gated sink holds (see [`Sink::gate`]).
    #[rpc::query(perm = "audit.use", risk = Risk::Read, agent = Agent::Exposed)]
    async fn gated(&self, _ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        Ok(input)
    }

    /// Never returns.
    #[rpc::query(perm = "audit.use", risk = Risk::Read, agent = Agent::Exposed)]
    async fn forever(&self, _ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        self.enter();
        std::future::pending().await
    }

    #[rpc::query(perm = "audit.use", risk = Risk::Read)]
    async fn boom(&self, _ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        self.enter();
        panic!("handler panicked");
    }

    /// A Write that calls `audit.read` through the router, as a handler calling another
    /// procedure does, and returns what it got.
    #[rpc::mutation(perm = "audit.use", risk = Risk::Write, agent = Agent::Exposed)]
    async fn nested(&self, ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        let router = self.0.router.get().expect("the router is set").clone();
        let session = Arc::new(ctx.session().clone());
        let inner = router
            .call(session, Call::new("audit.read", input))
            .await
            .map_err(|err| RpcError::new(err.code, err.message))?;
        Ok(json!({ "inner": inner }))
    }

    /// Calls `audit.escalate` (which re-checks at Write on a target) through the router.
    #[rpc::mutation(perm = "audit.use", risk = Risk::Write, agent = Agent::Exposed)]
    async fn nested_escalate(&self, ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        self.enter();
        let router = self.0.router.get().expect("the router is set").clone();
        let session = Arc::new(ctx.session().clone());
        router
            .call(session, Call::new("audit.escalate", input))
            .await
            .map_err(|err| RpcError::new(err.code, err.message))
    }

    /// Requires a permission the policy does not grant.
    #[rpc::mutation(perm = "audit.secret", risk = Risk::Write, agent = Agent::Exposed)]
    async fn secret(&self, _ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        self.enter();
        Ok(())
    }
}

/// Grants `audit.use` at every risk; denies everything else.
struct Policy;

impl Authorizer for Policy {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        if req.action.perm.as_str() == "audit.use" {
            Decision::Allow
        } else {
            Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            }
        }
    }
}

// ---- sink and reporter -----------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Record,
    Fail,
    /// Fails only entries with a target (in-call re-checks).
    FailTargeted,
    /// Never answers.
    Hang,
}

/// A sink a test switches. Entries for the gated action wait until [`Sink::open_gate`].
#[derive(Clone)]
struct Sink {
    log: Arc<MemoryAuditLog>,
    mode: Arc<Mutex<Mode>>,
    gate: Arc<Semaphore>,
}

impl Sink {
    fn new(mode: Mode) -> Sink {
        Sink {
            log: Arc::new(MemoryAuditLog::new()),
            mode: Arc::new(Mutex::new(mode)),
            gate: Arc::new(Semaphore::new(0)),
        }
    }

    fn set(&self, mode: Mode) {
        *self.mode.lock().unwrap() = mode;
    }

    fn open_gate(&self) {
        self.gate.add_permits(Semaphore::MAX_PERMITS);
    }

    fn entries(&self) -> Vec<AuditEntry> {
        self.log.entries()
    }

    fn of(&self, action: &str) -> Vec<AuditEntry> {
        self.entries()
            .into_iter()
            .filter(|e| e.action.name == action)
            .collect()
    }
}

impl AuditSink for Sink {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        let mode = *self.mode.lock().unwrap();
        match mode {
            Mode::Fail => return failed(),
            Mode::FailTargeted if entry.target.is_some() => return failed(),
            Mode::Hang => return Box::pin(std::future::pending()),
            Mode::Record | Mode::FailTargeted => {}
        }
        if entry.action.name == "audit.gated" {
            let (gate, log) = (Arc::clone(&self.gate), Arc::clone(&self.log));
            return Box::pin(async move {
                let _open = gate.acquire().await;
                log.append(entry).await
            });
        }
        self.log.append(entry)
    }
}

fn failed() -> BoxFuture<'static, Result<(), AuditError>> {
    Box::pin(async { Err(AuditError("disk full".into())) })
}

#[derive(Clone, Default)]
struct Reports(Arc<Mutex<Vec<AuditFailure>>>);

impl Reports {
    fn all(&self) -> Vec<(AuditEntryKind, AuditFailureEffect, String)> {
        self.0
            .lock()
            .unwrap()
            .iter()
            .map(|f| (f.entry, f.effect, f.action.clone()))
            .collect()
    }
}

impl AuditReporter for Reports {
    fn report(&self, failure: &AuditFailure) {
        self.0.lock().unwrap().push(failure.clone());
    }
}

struct Setup {
    router: Router,
    sink: Sink,
    reports: Reports,
    probe: Arc<Probe>,
}

fn setup(mode: Mode) -> Setup {
    setup_with(mode, AuditPolicy::default())
}

fn setup_with(mode: Mode, policy: AuditPolicy) -> Setup {
    let sink = Sink::new(mode);
    let reports = Reports::default();
    let probe = Arc::new(Probe::default());
    let router = Router::new(Policy)
        .with_audit(sink.clone())
        .with_audit_reporter(reports.clone())
        .with_audit_policy(policy);
    router.mount(AuditApi(Arc::clone(&probe))).unwrap();
    let _ = probe.router.set(router.clone());
    Setup {
        router,
        sink,
        reports,
        probe,
    }
}

impl Setup {
    fn entered(&self) -> usize {
        self.probe.entered.load(Ordering::SeqCst)
    }
}

fn human() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:local:alice".into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("s-1"),
    }
}

fn agent() -> Principal {
    Principal {
        kind: PrincipalKind::Agent,
        id: "agent:token:bot".into(),
        on_behalf_of: Some(Box::new(human())),
        ..human()
    }
}

fn session(principal: Principal) -> Arc<Session> {
    Arc::new(Session {
        id: "s-1".into(),
        principal,
    })
}

/// A call through the router directly, outside the engine (as the MCP adapter will).
async fn call(
    router: &Router,
    principal: Principal,
    procedure: &str,
    input: Value,
) -> Result<Value, ErrorPayload> {
    router
        .call(session(principal), Call::new(procedure, input))
        .await
}

/// Checks `entries` are one call's admission then completion, and returns the completion.
fn pair(entries: &[AuditEntry], risk: Risk) -> AuditEntry {
    let [admission, completion] = entries else {
        panic!("expected admission and completion, got {entries:?}");
    };
    assert_eq!(admission.outcome, Outcome::Started);
    assert_eq!(admission.decision, AuditDecision::Allow);
    assert_eq!((admission.delivery, admission.duration_ms), (None, None));
    assert_eq!(admission.risk, risk);
    assert!(!admission.correlation_id.is_empty());
    assert_eq!(completion.correlation_id, admission.correlation_id);
    assert_eq!(completion.decision, AuditDecision::Allow);
    assert!(completion.duration_ms.is_some());
    assert_eq!(completion.risk, risk);
    completion.clone()
}

// ---- engine harness --------------------------------------------------------------------------

struct As(Principal);

impl Authenticate for As {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "s-1".into(),
                principal: self.0.clone(),
            })
        })
    }
}

struct Client {
    rx: MemoryRx,
    tx: MemoryTx,
    decoder: FrameDecoder,
    _conn: ambidex::Connection,
}

impl Client {
    async fn connect(server: &Server<As, Router>) -> Client {
        let ((rx, tx), (server_rx, server_tx)) = memory(16);
        let conn = server.serve(server_rx, server_tx);
        let mut client = Client {
            rx,
            tx,
            decoder: FrameDecoder::new(u32::MAX),
            _conn: conn,
        };
        let hello = json!({ "protocol": 1, "api": "a", "schema_hash": "h", "client_version": "1" });
        client.send(Kind::Hello, 0, &hello).await;
        assert_eq!(client.recv().await.kind, Kind::HelloAck);
        client
    }

    async fn send(&mut self, kind: Kind, call_id: u32, value: &Value) {
        let frame = Frame::new(kind, call_id, serde_json::to_vec(value).unwrap());
        self.tx.send(frame.encode(u32::MAX).unwrap()).await.unwrap();
    }

    async fn call(&mut self, call_id: u32, procedure: &str, input: Value) {
        let call = json!({ "procedure": procedure, "input": input });
        self.send(Kind::Call, call_id, &call).await;
    }

    async fn recv(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(5), self.next())
            .await
            .expect("server answered")
    }

    async fn next(&mut self) -> Frame {
        loop {
            if let Some(frame) = self.decoder.next_frame().unwrap() {
                return frame;
            }
            let bytes = self.rx.recv().await.unwrap().expect("connection open");
            self.decoder.push(&bytes);
        }
    }

    async fn result(&mut self, call_id: u32) -> Value {
        let frame = self.recv().await;
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::Result, call_id),
            "{frame:?}"
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }

    async fn error(&mut self, call_id: u32) -> ErrorPayload {
        let frame = self.recv().await;
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::Error, call_id),
            "{frame:?}"
        );
        serde_json::from_slice(&frame.payload).unwrap()
    }
}

fn server(setup: &Setup, principal: Principal) -> Server<As, Router> {
    Server::new(
        ServerConfig::new("a", "h", "1"),
        As(principal),
        setup.router.clone(),
    )
}

// ---- tests -----------------------------------------------------------------------------------

#[tokio::test]
async fn read_write_and_destructive_calls_get_an_admission_and_a_completion() {
    let s = setup(Mode::Record);
    let server = server(&s, human());
    let mut client = Client::connect(&server).await;
    for (id, (procedure, risk)) in [
        ("audit.read", Risk::Read),
        ("audit.write", Risk::Write),
        ("audit.destroy", Risk::Destructive),
    ]
    .into_iter()
    .enumerate()
    {
        let id = id as u32 + 1;
        client.call(id, procedure, json!(id)).await;
        assert_eq!(client.result(id).await, json!(id));
        // Written before the answer left.
        let completion = pair(&s.sink.of(procedure), risk);
        assert_eq!(completion.outcome, Outcome::Success);
        assert_eq!(completion.delivery, Some(Delivery::Delivered));
        assert_eq!(completion.principal_chain[0].id, "human:local:alice");
        assert_eq!(completion.input_digest, ambidex::input_digest(&json!(id)));
    }
    let ids: std::collections::HashSet<_> = s
        .sink
        .entries()
        .into_iter()
        .map(|e| e.correlation_id)
        .collect();
    assert_eq!(ids.len(), 3, "one correlation id per call");
    assert!(unfinished(&s.sink.entries()).is_empty());
}

#[tokio::test]
async fn a_failing_sink_stops_writes_and_agent_calls_before_the_handler() {
    let s = setup(Mode::Fail);
    for (principal, procedure) in [
        (human(), "audit.write"),
        (human(), "audit.destroy"),
        (agent(), "audit.read"),
        (agent(), "audit.write"),
    ] {
        let err = call(&s.router, principal, procedure, json!(1))
            .await
            .unwrap_err();
        assert_eq!(err.code, Code::Unavailable, "{procedure}");
        assert!(err.retryable, "nothing ran");
        assert_eq!(err.message, "audit log unavailable; the call did not run");
    }
    assert_eq!(s.entered(), 0, "no handler was entered");
    // A human Read fails open: it runs, and the failure is reported.
    assert_eq!(
        call(&s.router, human(), "audit.read", json!("r")).await,
        Ok(json!("r"))
    );
    assert_eq!(s.entered(), 1);
    let reports = s.reports.all();
    assert_eq!(reports.len(), 6, "{reports:?}");
    assert!(
        reports[..4]
            .iter()
            .all(|r| r.0 == AuditEntryKind::Admission && r.1 == AuditFailureEffect::Blocked)
    );
    assert_eq!(
        reports[4..],
        [
            (
                AuditEntryKind::Admission,
                AuditFailureEffect::RanUnrecorded,
                "audit.read".to_owned()
            ),
            (
                AuditEntryKind::Completion,
                AuditFailureEffect::EntryLost,
                "audit.read".to_owned()
            ),
        ]
    );
}

#[tokio::test]
async fn human_reads_can_be_made_to_fail_closed() {
    let s = setup_with(
        Mode::Fail,
        AuditPolicy {
            human_reads: HumanReads::FailClosed,
            ..AuditPolicy::default()
        },
    );
    let err = call(&s.router, human(), "audit.read", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    assert_eq!(s.entered(), 0);
}

#[tokio::test]
async fn a_router_without_a_sink_runs_only_human_reads() {
    let probe = Arc::new(Probe::default());
    let reports = Reports::default();
    let router = Router::new(Policy).with_audit_reporter(reports.clone());
    router.mount(AuditApi(Arc::clone(&probe))).unwrap();
    let err = call(&router, human(), "audit.write", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    let err = call(&router, agent(), "audit.read", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    assert_eq!(probe.entered.load(Ordering::SeqCst), 0);
    call(&router, human(), "audit.read", json!(1))
        .await
        .unwrap();
    assert_eq!(probe.entered.load(Ordering::SeqCst), 1);
    // Reported once per call: there is no completion to lose.
    assert_eq!(reports.all().len(), 3, "{:?}", reports.all());
}

#[tokio::test(start_paused = true)]
async fn a_hung_sink_fails_closed_within_the_write_timeout() {
    let s = setup_with(
        Mode::Hang,
        AuditPolicy {
            write_timeout: Duration::from_millis(50),
            ..AuditPolicy::default()
        },
    );
    let started = tokio::time::Instant::now();
    let err = call(&s.router, human(), "audit.write", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    assert_eq!(started.elapsed(), Duration::from_millis(50));
    assert_eq!(s.entered(), 0);
}

#[tokio::test]
async fn refusals_are_audited_and_refused_whatever_the_sink_does() {
    let s = setup(Mode::Record);
    let err = call(&s.router, agent(), "audit.secret", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);
    let entries = s.sink.entries();
    assert_eq!(entries.len(), 1, "a refusal is one entry: {entries:?}");
    assert!(matches!(entries[0].decision, AuditDecision::Deny { .. }));
    assert_eq!(entries[0].correlation_id, err.correlation_id);

    s.sink.set(Mode::Fail);
    let err = call(&s.router, agent(), "audit.secret", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied, "still refused");
    assert_eq!(s.entered(), 0);
    assert_eq!(
        s.reports.all(),
        [(
            AuditEntryKind::Refusal,
            AuditFailureEffect::EntryLost,
            "audit.secret".to_owned()
        )]
    );
}

#[tokio::test]
async fn an_allowed_recheck_is_recorded_and_fails_closed() {
    let s = setup(Mode::Record);
    call(&s.router, human(), "audit.escalate", Value::Null)
        .await
        .unwrap();
    let entries = s.sink.entries();
    assert_eq!(entries.len(), 3, "{entries:?}");
    // Admission at the baseline, the re-check with its target and risk, then the completion at
    // the highest risk the call was allowed.
    assert_eq!(
        (
            entries[0].outcome.clone(),
            entries[0].risk,
            entries[0].target.clone()
        ),
        (Outcome::Started, Risk::Read, None)
    );
    assert_eq!(
        (
            entries[1].outcome.clone(),
            entries[1].risk,
            entries[1].target.clone()
        ),
        (
            Outcome::Started,
            Risk::Write,
            Some(TargetRef::connection("c-1"))
        )
    );
    assert_eq!(
        (entries[2].risk, entries[2].is_completion()),
        (Risk::Write, true)
    );
    assert!(
        entries
            .iter()
            .all(|e| e.correlation_id == entries[0].correlation_id)
    );
    assert_eq!(s.probe.escalated.load(Ordering::SeqCst), 1);

    // The re-check's entry cannot be written: the Write work after it never happens.
    s.sink.set(Mode::FailTargeted);
    let err = call(&s.router, human(), "audit.escalate", Value::Null)
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Unavailable);
    assert_eq!(
        s.probe.escalated.load(Ordering::SeqCst),
        1,
        "stopped before the work"
    );
    let last = s.sink.entries().pop().unwrap();
    assert_eq!(
        last.outcome,
        Outcome::Error {
            code: "Unavailable".into()
        }
    );
}

#[tokio::test(flavor = "current_thread")]
async fn a_slow_sink_does_not_block_other_connections() {
    let s = setup(Mode::Record);
    let server = server(&s, human());
    let mut slow = Client::connect(&server).await;
    let mut other = Client::connect(&server).await;
    // The admission of `gated` waits on the sink.
    slow.call(1, "audit.gated", json!("slow")).await;
    tokio::task::yield_now().await;
    // Another connection (and another call) is served meanwhile on the same thread.
    other.call(1, "audit.read", json!("fast")).await;
    assert_eq!(other.result(1).await, json!("fast"));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), slow.next())
            .await
            .is_err(),
        "the gated call is still waiting for its admission"
    );
    assert_eq!(s.entered(), 1, "only the fast call ran");
    s.sink.open_gate();
    assert_eq!(slow.result(1).await, json!("slow"));
    pair(&s.sink.of("audit.gated"), Risk::Read);
}

#[tokio::test]
async fn no_entry_has_an_empty_correlation_id() {
    let s = setup(Mode::Record);
    // Outside the engine: ids come from the shared generator.
    call(&s.router, human(), "audit.read", json!(1))
        .await
        .unwrap();
    call(&s.router, agent(), "audit.escalate", Value::Null)
        .await
        .unwrap();
    let _ = call(&s.router, agent(), "audit.secret", json!(1)).await;
    // Inside the engine: ids assigned at frame receipt.
    let server = server(&s, human());
    let mut client = Client::connect(&server).await;
    client.call(1, "audit.write", json!(1)).await;
    client.result(1).await;
    client.call(2, "audit.secret", json!(1)).await;
    let err = client.error(2).await;

    let entries = s.sink.entries();
    assert_eq!(entries.len(), 2 + 3 + 1 + 2 + 1, "{entries:?}");
    assert!(entries.iter().all(|e| !e.correlation_id.is_empty()));
    let outside = &entries[0].correlation_id;
    assert_eq!(outside.len(), 32, "generator id: {outside}");
    assert!(!outside.contains('-'));
    // An outside call's completion is written by the router, as delivered.
    let read = pair(&s.sink.of("audit.read"), Risk::Read);
    assert_eq!(read.delivery, Some(Delivery::Delivered));
    assert_eq!(entries.last().unwrap().correlation_id, err.correlation_id);
    assert!(
        err.correlation_id.contains('-'),
        "engine id: {}",
        err.correlation_id
    );
}

#[tokio::test]
async fn a_crash_between_admission_and_completion_leaves_the_outcome_unknown() {
    let s = setup(Mode::Record);
    let mut running = Box::pin(call(&s.router, human(), "audit.forever", Value::Null));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), &mut running)
            .await
            .is_err()
    );
    assert_eq!(s.entered(), 1, "the handler is running");
    // The process dies here: nothing after the admission ever runs, not even destructors.
    std::mem::forget(running);
    let entries = s.sink.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!(unfinished(&entries), [&entries[0]], "outcome unknown");
}

#[tokio::test]
async fn a_call_dropped_while_running_still_gets_its_completion() {
    let s = setup(Mode::Record);
    let mut running = Box::pin(call(&s.router, human(), "audit.forever", Value::Null));
    let _ = tokio::time::timeout(Duration::from_millis(20), &mut running).await;
    drop(running);
    // Written on a task of its own.
    for _ in 0..100 {
        if s.sink.entries().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let completion = pair(&s.sink.of("audit.forever"), Risk::Read);
    assert_eq!(
        completion.outcome,
        Outcome::Error {
            code: "Cancelled".into()
        }
    );
    assert_eq!(completion.delivery, Some(Delivery::Cancelled));
}

#[tokio::test]
async fn a_panicking_handler_is_completed_as_internal() {
    let s = setup(Mode::Record);
    let server = server(&s, human());
    let mut client = Client::connect(&server).await;
    client.call(1, "audit.boom", Value::Null).await;
    let err = client.error(1).await;
    assert_eq!(err.code, Code::Internal);
    for _ in 0..100 {
        if s.sink.entries().len() == 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let completion = pair(&s.sink.of("audit.boom"), Risk::Read);
    assert_eq!(
        completion.outcome,
        Outcome::Error {
            code: "Internal".into()
        }
    );
    assert_eq!(completion.delivery, Some(Delivery::Delivered));
    assert_eq!(completion.correlation_id, err.correlation_id);
}

#[tokio::test(start_paused = true)]
async fn a_deadline_passed_during_the_admission_write_is_completed_without_running() {
    let s = setup(Mode::Record);
    let mut call = Call::new("audit.gated", json!(1));
    call.timeout_ms = Some(10);
    let mut running = Box::pin(s.router.call(session(human()), call));
    // The call starts, is authorized, and waits for its admission write...
    assert!(
        tokio::time::timeout(Duration::from_millis(1), &mut running)
            .await
            .is_err()
    );
    // ...until after its deadline.
    tokio::time::advance(Duration::from_millis(20)).await;
    s.sink.open_gate();
    let err = running.await.unwrap_err();
    assert_eq!(err.code, Code::DeadlineExceeded);
    assert_eq!(s.entered(), 0, "the handler never ran");
    let completion = pair(&s.sink.of("audit.gated"), Risk::Read);
    assert_eq!(
        completion.outcome,
        Outcome::Error {
            code: "DeadlineExceeded".into()
        }
    );
    // Outside the engine the router's answer is what its caller gets.
    assert_eq!(completion.delivery, Some(Delivery::Delivered));
    assert_eq!(completion.correlation_id, err.correlation_id);
}

/// Checks one handler calling another procedure: each call has its own two entries and its own
/// correlation id, the inner pair sits inside the outer one, and nothing was recorded as
/// cancelled. Returns the outer call's correlation id.
fn assert_nested_pairs(s: &Setup) -> String {
    let entries = s.sink.entries();
    let names: Vec<_> = entries
        .iter()
        .map(|e| (e.action.name.as_str(), e.outcome.clone()))
        .collect();
    assert_eq!(
        names,
        [
            ("audit.nested", Outcome::Started),
            ("audit.read", Outcome::Started),
            ("audit.read", Outcome::Success),
            ("audit.nested", Outcome::Success),
        ],
        "{entries:?}"
    );
    let outer = pair(&s.sink.of("audit.nested"), Risk::Write);
    let inner = pair(&s.sink.of("audit.read"), Risk::Read);
    assert_eq!(outer.delivery, Some(Delivery::Delivered));
    // Delivered to the calling handler.
    assert_eq!(inner.delivery, Some(Delivery::Delivered));
    assert_ne!(inner.correlation_id, outer.correlation_id);
    // Both inner entries name the outer call; the outer call is top-level.
    for e in s.sink.of("audit.read") {
        assert_eq!(
            e.parent_correlation_id.as_deref(),
            Some(&*outer.correlation_id)
        );
    }
    for e in s.sink.of("audit.nested") {
        assert_eq!(e.parent_correlation_id, None);
    }
    assert!(unfinished(&entries).is_empty());
    assert!(s.reports.all().is_empty(), "{:?}", s.reports.all());
    assert_eq!(s.entered(), 2);
    outer.correlation_id
}

#[tokio::test]
async fn a_call_made_by_a_handler_gets_its_own_entries_in_the_engine() {
    let s = setup(Mode::Record);
    let server = server(&s, human());
    let mut client = Client::connect(&server).await;
    client.call(1, "audit.nested", json!(7)).await;
    assert_eq!(client.result(1).await, json!({ "inner": 7 }));
    let outer = assert_nested_pairs(&s);
    assert!(outer.ends_with("-1"), "the engine's id for call 1: {outer}");
}

#[tokio::test]
async fn a_call_made_by_a_handler_gets_its_own_entries_outside_the_engine() {
    let s = setup(Mode::Record);
    let result = call(&s.router, agent(), "audit.nested", json!(7)).await;
    assert_eq!(result, Ok(json!({ "inner": 7 })));
    assert_nested_pairs(&s);
}

#[tokio::test]
async fn a_recheck_inside_a_nested_call_names_the_calling_call() {
    let s = setup(Mode::Record);
    let result = call(&s.router, human(), "audit.nested_escalate", Value::Null).await;
    assert_eq!(result, Ok(Value::Null));
    let outer = pair(&s.sink.of("audit.nested_escalate"), Risk::Write);
    let inner = s.sink.of("audit.escalate");
    // Admission, the re-check's `Started` entry (with its target), completion.
    assert_eq!(inner.len(), 3, "{inner:?}");
    let recheck = inner
        .iter()
        .find(|e| e.target.is_some())
        .expect("re-check entry");
    assert_eq!(recheck.outcome, Outcome::Started);
    for e in &inner {
        assert_eq!(
            e.parent_correlation_id.as_deref(),
            Some(&*outer.correlation_id)
        );
    }
    assert_eq!(outer.parent_correlation_id, None);
}
