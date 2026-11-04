//! Subscriptions through the router (Ambidex spec §5, §8, Open question 23): the same
//! authorization, agent exposure, approvals, audit and deadlines as calls, with typed events.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::security_types::{
    ApprovalSpec, AuditDecision, AuditEntry, Authorizer, AuthzRequest, Decision, Outcome,
    Principal, PrincipalKind, Reason, SessionId, TenantId,
};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{
    Approvals, AuditError, AuditSink, Authenticate, Code, Ctx, DomainError, ErrorPayload,
    EventSink, Hello, Procedure, ProcedureKind, ProcedureMeta, RegistryError, Risk, Router,
    RpcError, Server, ServerConfig, Session, TargetRef, rpc,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

// ---- fixture API ----------------------------------------------------------------------------

#[derive(Debug, Serialize, TS, JsonSchema)]
struct Tick {
    n: u32,
    principal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind")]
enum WatchError {
    TopicClosed { after: u32 },
}

impl DomainError for WatchError {
    fn code(&self) -> Code {
        Code::FailedPrecondition
    }

    fn message(&self) -> String {
        "topic closed".into()
    }
}

struct WatchApi;

#[rpc::router(namespace = "watch")]
impl WatchApi {
    /// Typed events, then a typed domain error.
    #[rpc::subscription(perm = "watch.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn ticks(
        &self,
        ctx: Ctx,
        count: u32,
        events: EventSink<Tick>,
    ) -> Result<(), RpcError<WatchError>> {
        for n in 0..count {
            let principal = ctx.principal().id.clone();
            events.send(&Tick { n, principal }).await?;
        }
        Err(RpcError::new(Code::FailedPrecondition, "topic closed")
            .with_details(WatchError::TopicClosed { after: count }))
    }

    /// Not exposed to agents.
    #[rpc::subscription(perm = "watch.read", risk = Risk::Read)]
    async fn hidden(&self, _ctx: Ctx, _input: (), events: EventSink<u32>) -> Result<(), RpcError> {
        events.send(&1).await?;
        Ok(())
    }

    /// The policy asks for approval.
    #[rpc::subscription(perm = "watch.approve", risk = Risk::Read)]
    async fn gated(&self, _ctx: Ctx, _input: (), events: EventSink<u32>) -> Result<(), RpcError> {
        events.send(&1).await?;
        Ok(())
    }

    /// One event, then a target check at Destructive risk, which the policy gates.
    #[rpc::subscription(perm = "watch.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn escalate(&self, ctx: Ctx, _input: (), events: EventSink<u32>) -> Result<(), RpcError> {
        events.send(&0).await?;
        ctx.authorize(Some(&TargetRef::connection("c-9")), Risk::Destructive)
            .await?;
        events.send(&1).await?;
        Ok(())
    }

    /// Reports its deadline, then waits for the end of the subscription.
    #[rpc::subscription(perm = "watch.read", risk = Risk::Read, timeout_max = "100ms")]
    async fn capped(&self, ctx: Ctx, _input: (), events: EventSink<u64>) -> Result<(), RpcError> {
        let left = ctx.deadline().expect("capped") - tokio::time::Instant::now();
        events.send(&(left.as_millis() as u64)).await?;
        events.closed().await;
        Ok(())
    }

    /// Reports the time left until its deadline (`null`: none), then waits for its end. Declares
    /// no maximum.
    #[rpc::subscription(perm = "watch.read", risk = Risk::Read)]
    async fn open(
        &self,
        ctx: Ctx,
        _input: (),
        events: EventSink<Option<u64>>,
    ) -> Result<(), RpcError> {
        let left = ctx
            .deadline()
            .map(|d| (d - tokio::time::Instant::now()).as_millis() as u64);
        events.send(&left).await?;
        events.closed().await;
        Ok(())
    }
}

/// `watch.read` is allowed below Destructive, `watch.approve` needs approval, everything else is
/// unknown and denied.
struct Policy;

impl Authorizer for Policy {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        let approval = || Decision::NeedsApproval {
            approval: ApprovalSpec {
                action: req.action.clone(),
                target: req.target.cloned(),
                risk: req.risk,
                input_digest: req.input_digest,
                expires_at_unix_ms: 0,
            },
        };
        match req.action.perm.as_str() {
            "watch.read" if req.risk < Risk::Destructive => Decision::Allow,
            "watch.read" | "watch.approve" => approval(),
            _ => Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            },
        }
    }
}

struct Queue;

impl Approvals for Queue {
    fn request<'a>(
        &'a self,
        _principal: &'a Principal,
        _spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { Some("apr-7".to_owned()) })
    }
}

#[derive(Clone, Default)]
struct Log {
    entries: Arc<Mutex<Vec<AuditEntry>>>,
    broken: bool,
}

impl Log {
    fn entries(&self) -> Vec<AuditEntry> {
        self.entries.lock().unwrap().clone()
    }
}

impl AuditSink for Log {
    fn append(&self, entry: AuditEntry) -> Result<(), AuditError> {
        if self.broken {
            return Err(AuditError("disk full".into()));
        }
        self.entries.lock().unwrap().push(entry);
        Ok(())
    }
}

// ---- engine harness -------------------------------------------------------------------------

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
}

impl Client {
    async fn start(principal: Principal, log: Log) -> Client {
        let router = Router::with_approvals(Policy, Queue).with_audit(log);
        router.mount(WatchApi).unwrap();
        let server = Server::new(ServerConfig::new("dbee", "h", "1"), As(principal), router);
        let ((rx, tx), (server_rx, server_tx)) = memory(16);
        // The connection runs until the client side is dropped.
        let _conn = server.serve(server_rx, server_tx);
        let mut client = Client {
            rx,
            tx,
            decoder: FrameDecoder::new(u32::MAX),
        };
        let hello =
            json!({ "protocol": 1, "api": "dbee", "schema_hash": "h", "client_version": "1" });
        client.send(Kind::Hello, 0, &hello).await;
        assert_eq!(client.recv().await.kind, Kind::HelloAck);
        client
    }

    async fn send(&mut self, kind: Kind, call_id: u32, value: &Value) {
        let frame = Frame::new(kind, call_id, serde_json::to_vec(value).unwrap());
        self.tx.send(frame.encode(u32::MAX).unwrap()).await.unwrap();
    }

    async fn subscribe(&mut self, call_id: u32, procedure: &str, input: Value) {
        let call = json!({ "procedure": procedure, "input": input });
        self.send(Kind::Subscribe, call_id, &call).await;
    }

    async fn recv(&mut self) -> Frame {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(frame) = self.decoder.next_frame().unwrap() {
                    return frame;
                }
                let bytes = self.rx.recv().await.unwrap().expect("connection open");
                self.decoder.push(&bytes);
            }
        })
        .await
        .expect("server answered")
    }

    async fn event(&mut self, call_id: u32) -> Value {
        let frame = self.recv().await;
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::Event, call_id),
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

// ---- tests ----------------------------------------------------------------------------------

#[tokio::test]
async fn typed_events_carry_the_principal_then_a_typed_error() {
    let mut client = Client::start(human(), Log::default()).await;
    client.subscribe(1, "watch.ticks", json!(2)).await;
    for n in 0..2 {
        assert_eq!(
            client.event(1).await,
            json!({ "n": n, "principal": "human:local:alice" })
        );
    }
    let err = client.error(1).await;
    assert_eq!(err.code, Code::FailedPrecondition);
    assert_eq!(
        err.details,
        Some(json!({ "kind": "TopicClosed", "after": 2 }))
    );
}

#[tokio::test]
async fn agents_cannot_see_hidden_subscriptions() {
    let log = Log::default();
    let mut client = Client::start(agent(), log.clone()).await;
    // Indistinguishable from a missing procedure, and never authorized (so never audited).
    client.subscribe(1, "watch.hidden", Value::Null).await;
    assert_eq!(client.error(1).await.code, Code::NotFound);
    client.subscribe(2, "watch.missing", Value::Null).await;
    assert_eq!(client.error(2).await.code, Code::NotFound);
    assert!(log.entries().is_empty());
    // An exposed subscription works for the agent.
    client.subscribe(3, "watch.ticks", json!(1)).await;
    assert_eq!(client.event(3).await["principal"], "agent:token:bot");
}

#[tokio::test]
async fn approval_gated_subscription_returns_its_id_and_is_audited() {
    let log = Log::default();
    let mut client = Client::start(human(), log.clone()).await;
    client.subscribe(1, "watch.gated", Value::Null).await;
    let err = client.error(1).await;
    assert_eq!(err.code, Code::ApprovalRequired);
    assert_eq!(err.details, Some(json!({ "approval_id": "apr-7" })));
    let entries = log.entries();
    assert_eq!(entries.len(), 1);
    let entry = &entries[0];
    assert_eq!(entry.action.name, "watch.gated");
    assert_eq!(entry.decision, AuditDecision::NeedsApproval);
    assert_eq!(entry.approval_id.as_deref(), Some("apr-7"));
    assert_eq!(
        entry.outcome,
        Outcome::Error {
            code: "ApprovalRequired".into()
        }
    );
    assert_eq!(entry.correlation_id, err.correlation_id);
    assert_eq!(entry.tenant, TenantId::new("t-1"));
}

#[tokio::test]
async fn escalation_inside_a_subscription_is_refused_and_audited() {
    let log = Log::default();
    let mut client = Client::start(agent(), log.clone()).await;
    client.subscribe(1, "watch.escalate", Value::Null).await;
    // The baseline (Read, no target) was allowed; the target check at Destructive was not, so
    // the subscription ends after its first event.
    assert_eq!(client.event(1).await, json!(0));
    let err = client.error(1).await;
    assert_eq!(err.code, Code::ApprovalRequired);
    assert_eq!(err.details, Some(json!({ "approval_id": "apr-7" })));
    let entries = log.entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(entry.target, Some(TargetRef::connection("c-9")));
    assert_eq!(entry.risk, Risk::Destructive);
    let chain: Vec<_> = entry
        .principal_chain
        .iter()
        .map(|p| p.id.as_str())
        .collect();
    assert_eq!(chain, ["agent:token:bot", "human:local:alice"]);
    assert_eq!(entry.correlation_id, err.correlation_id);
}

#[tokio::test]
async fn hidden_subscriptions_are_reachable_for_humans() {
    let mut client = Client::start(human(), Log::default()).await;
    client.subscribe(1, "watch.hidden", Value::Null).await;
    assert_eq!(client.event(1).await, json!(1));
    let frame = client.recv().await;
    assert_eq!(
        (frame.kind, frame.payload.as_slice()),
        (Kind::Result, b"null".as_slice())
    );
}

#[tokio::test]
async fn a_failing_audit_sink_cannot_let_a_refused_subscription_through() {
    let log = Log {
        broken: true,
        ..Log::default()
    };
    let mut client = Client::start(human(), log).await;
    client.subscribe(1, "watch.gated", Value::Null).await;
    assert_eq!(client.error(1).await.code, Code::ApprovalRequired);
}

#[tokio::test(start_paused = true)]
async fn the_procedure_caps_a_subscription_deadline() {
    let mut client = Client::start(human(), Log::default()).await;
    let call = json!({ "procedure": "watch.capped", "input": null, "timeout_ms": 3_600_000 });
    client.send(Kind::Subscribe, 1, &call).await;
    // The handler sees the procedure's 100 ms, not the hour the client asked for.
    assert_eq!(client.event(1).await, json!(100));
    assert_eq!(client.error(1).await.code, Code::DeadlineExceeded);
    // The declared maximum bounds a subscription without a client timeout too.
    client.subscribe(2, "watch.capped", Value::Null).await;
    assert_eq!(client.event(2).await, json!(100));
    assert_eq!(client.error(2).await.code, Code::DeadlineExceeded);
}

// ---- no default deadline (spec Open question 24f) -------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_subscription_has_no_default_deadline() {
    let mut client = Client::start(human(), Log::default()).await;
    client.subscribe(1, "watch.open", Value::Null).await;
    assert_eq!(client.event(1).await, Value::Null, "no deadline");
    // Far past the call default (30 s) and cap (5 min): any deadline timer would have fired and
    // its Error would come before the answer to the Cancel below.
    tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
    client.send(Kind::Cancel, 1, &Value::Null).await;
    assert_eq!(client.error(1).await.code, Code::Cancelled);
}

#[tokio::test(start_paused = true)]
async fn a_client_timeout_beyond_the_call_cap_bounds_a_subscription() {
    let mut client = Client::start(human(), Log::default()).await;
    let hour = 3_600_000u64;
    let call = json!({ "procedure": "watch.open", "input": null, "timeout_ms": hour });
    let sent = tokio::time::Instant::now();
    client.send(Kind::Subscribe, 1, &call).await;
    // The hour, not the 5 min cap of calls.
    assert_eq!(client.event(1).await, json!(hour));
    // (`recv` gives up after 5 s, so wait for the deadline first.)
    tokio::time::sleep_until(sent + Duration::from_millis(hour)).await;
    assert_eq!(client.error(1).await.code, Code::DeadlineExceeded);
    assert_eq!(sent.elapsed(), Duration::from_millis(hour));
}

#[tokio::test(start_paused = true)]
async fn the_largest_client_timeout_neither_overflows_nor_expires() {
    let mut client = Client::start(human(), Log::default()).await;
    // No declared maximum caps it. Where an Instant cannot hold it, there is no deadline.
    let call = json!({ "procedure": "watch.open", "input": null, "timeout_ms": u64::MAX });
    client.send(Kind::Subscribe, 1, &call).await;
    let left = client.event(1).await;
    assert!(left == json!(u64::MAX) || left.is_null(), "{left}");
    tokio::time::sleep(Duration::from_secs(24 * 3600)).await;
    client.send(Kind::Cancel, 1, &Value::Null).await;
    assert_eq!(client.error(1).await.code, Code::Cancelled);
}

#[test]
fn the_registry_enforces_the_timeouts_of_each_kind() {
    let router = Router::new(Policy);
    let sub: ambidex::SubscriptionHandler = Arc::new(|_, _, _| Box::pin(async { Ok(()) }));
    let unary: ambidex::Handler = Arc::new(|_, _| Box::pin(async { Ok(Value::Null) }));
    let meta = |name: &str, kind| ProcedureMeta::new(name, kind, "watch.read", Risk::Read);
    let invalid = |name: &str| Err(RegistryError::InvalidTimeouts(name.into()));

    // A subscription may declare a maximum, never a default.
    let mut defaulted = meta("x.defaulted", ProcedureKind::Subscription);
    defaulted.timeout_default = Some(Duration::from_secs(30));
    assert_eq!(
        router.insert(Procedure::subscription(defaulted, sub.clone())),
        invalid("x.defaulted")
    );
    let mut capped = meta("x.capped", ProcedureKind::Subscription);
    capped.timeout_max = Some(Duration::from_secs(600));
    assert_eq!(
        router.insert(Procedure::subscription(capped, sub.clone())),
        Ok(())
    );

    // Calls keep both bounds.
    let mut uncapped = meta("x.uncapped", ProcedureKind::Query);
    uncapped.timeout_max = None;
    assert_eq!(
        router.insert(Procedure::new(uncapped, unary.clone())),
        invalid("x.uncapped")
    );
    let mut undefaulted = meta("x.undefaulted", ProcedureKind::Mutation);
    undefaulted.timeout_default = None;
    assert_eq!(
        router.insert(Procedure::new(undefaulted, unary)),
        invalid("x.undefaulted")
    );
    let mut stream = meta("x.stream", ProcedureKind::Stream);
    stream.timeout_max = None;
    assert_eq!(
        router.insert(Procedure::declared(stream)),
        invalid("x.stream")
    );
}

#[test]
fn the_registry_refuses_a_handler_of_another_kind() {
    let router = Router::new(Policy);
    let subscription = ProcedureMeta::new(
        "x.watch",
        ProcedureKind::Subscription,
        "watch.read",
        Risk::Read,
    );
    let unary: ambidex::Handler = Arc::new(|_, _| Box::pin(async { Ok(Value::Null) }));
    assert_eq!(
        router.insert(Procedure::new(subscription.clone(), unary)),
        Err(RegistryError::KindMismatch("x.watch".into()))
    );
    let query = ProcedureMeta::new("x.get", ProcedureKind::Query, "watch.read", Risk::Read);
    let sub: ambidex::SubscriptionHandler = Arc::new(|_, _, _| Box::pin(async { Ok(()) }));
    assert_eq!(
        router.insert(Procedure::subscription(query, sub.clone())),
        Err(RegistryError::KindMismatch("x.get".into()))
    );
    assert_eq!(
        router.insert(Procedure::subscription(subscription, sub)),
        Ok(())
    );
}
