//! Procedure macro, registry, authorization hook and error model (Ambidex spec §2, §8, §10).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::security_types::{
    Action, ApprovalSpec, Authorizer, AuthzRequest, Decision, Digest, Principal, PrincipalKind,
    Reason, SessionId, TenantId,
};
use ambidex::transport::{TransportRx, TransportTx, memory};
use ambidex::{
    Agent, Api, Approvals, Authenticate, Call, Code, Ctx, DomainError, ErrorPayload, Hello,
    Procedure, ProcedureKind, ProcedureMeta, RegistryError, Rejected, Risk, Router, RpcError,
    Server, ServerConfig, Session, TargetRef, input_digest, rpc,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

// ---- fixture API ----------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct EchoInput {
    text: String,
}

#[derive(Debug, Serialize)]
struct EchoOutput {
    text: String,
    principal: String,
}

#[derive(Debug, Deserialize)]
struct DropInput {
    connection: String,
    #[allow(dead_code)]
    password: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
enum QueryError {
    Syntax { position: u32 },
}

impl DomainError for QueryError {
    fn code(&self) -> Code {
        Code::InvalidArgument
    }

    fn message(&self) -> String {
        "syntax error".into()
    }
}

#[derive(Default)]
struct DemoApi {
    runs: AtomicUsize,
}

#[rpc::router(namespace = "demo")]
impl DemoApi {
    #[rpc::query(perm = "demo.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn echo(&self, ctx: Ctx, input: EchoInput) -> Result<EchoOutput, RpcError> {
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok(EchoOutput {
            text: input.text,
            principal: ctx.principal().id.clone(),
        })
    }

    #[rpc::query(perm = "demo.read", risk = Risk::Read)]
    async fn parse(&self, _ctx: Ctx, position: u32) -> Result<(), QueryError> {
        Err(QueryError::Syntax { position })
    }

    #[rpc::mutation(
        perm = "demo.drop",
        risk = Risk::Write,
        timeout_default = "10s",
        timeout_max = "1h",
        log_input,
        redact = ["password"],
        name = "dropTable",
        deprecated,
    )]
    async fn drop_table(&self, ctx: Ctx, input: DropInput) -> Result<String, Rejected> {
        // The handler learns the target and the real risk only now, and authorizes again.
        let target = TargetRef::connection(input.connection);
        ctx.authorize(Some(&target), Risk::Destructive).await?;
        self.runs.fetch_add(1, Ordering::SeqCst);
        Ok("dropped".into())
    }

    #[rpc::mutation(perm = "demo.lower", risk = Risk::Write)]
    async fn lower(&self, ctx: Ctx, _input: ()) -> Result<(), RpcError<QueryError>> {
        // Asking for a lower risk than the baseline must not lower it.
        ctx.authorize(None, Risk::Read).await?;
        Ok(())
    }

    #[rpc::mutation(perm = "demo.read", risk = Risk::Read)]
    async fn internal(&self, _ctx: Ctx, _input: ()) -> Result<(), RpcError> {
        Err(RpcError::new(
            Code::Internal,
            "db at 10.1.2.3 refused password 'hunter2'",
        ))
    }

    #[rpc::stream(perm = "demo.stream", risk = Risk::Read, timeout_default = "2h")]
    async fn rows(&self, _ctx: Ctx, _input: ()) {}

    #[rpc::subscription(perm = "demo.watch", risk = Risk::Read)]
    async fn watch(&self, _ctx: Ctx, _input: ()) {}

    /// Not a procedure: plain methods stay plain.
    #[allow(dead_code)]
    fn helper(&self) -> u32 {
        7
    }
}

// ---- fixture authorizer --------------------------------------------------------------------

/// Role-free policy: a fixed set of known permissions, a set of granted ones, and permissions
/// that need approval. Unknown permissions are denied (default-deny). Records every request.
#[derive(Default, Clone)]
struct Policy {
    known: Vec<&'static str>,
    granted: Vec<&'static str>,
    approval: Vec<&'static str>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

#[derive(Debug, Clone, PartialEq)]
struct Seen {
    principal: String,
    action: Action,
    target: Option<TargetRef>,
    risk: Risk,
    digest: Digest,
}

impl Authorizer for Policy {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        self.seen.lock().unwrap().push(Seen {
            principal: req.principal.id.clone(),
            action: req.action.clone(),
            target: req.target.cloned(),
            risk: req.risk,
            digest: req.input_digest,
        });
        let perm = req.action.perm.as_str();
        if !self.known.contains(&perm) {
            return Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            };
        }
        if self.approval.contains(&perm) || req.risk == Risk::Destructive {
            return Decision::NeedsApproval {
                approval: ApprovalSpec {
                    action: req.action.clone(),
                    target: req.target.cloned(),
                    risk: req.risk,
                    input_digest: req.input_digest,
                    expires_at_unix_ms: 0,
                },
            };
        }
        if self.granted.contains(&perm) {
            Decision::Allow
        } else {
            Decision::Deny {
                reason: Reason::MissingPermission {
                    perm: req.action.perm.clone(),
                },
            }
        }
    }
}

impl Policy {
    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

fn open_policy() -> Policy {
    let all = vec![
        "demo.read",
        "demo.drop",
        "demo.lower",
        "demo.stream",
        "demo.watch",
    ];
    Policy {
        known: all.clone(),
        granted: all,
        ..Policy::default()
    }
}

#[derive(Clone, Default)]
struct Queue(Arc<Mutex<Vec<ApprovalSpec>>>);

impl Approvals for Queue {
    fn request<'a>(
        &'a self,
        _principal: &'a Principal,
        spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async move {
            let mut pending = self.0.lock().unwrap();
            pending.push(spec.clone());
            Some(format!("apr-{}", pending.len()))
        })
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

fn setup(policy: &Policy) -> (Router, Arc<DemoApi>) {
    let router = Router::new(policy.clone());
    let api = Arc::new(DemoApi::default());
    router.mount(ArcApi(Arc::clone(&api))).unwrap();
    (router, api)
}

/// Mounts a shared instance so tests can inspect it afterwards.
struct ArcApi(Arc<DemoApi>);

impl Api for ArcApi {
    fn metas() -> Vec<ProcedureMeta> {
        DemoApi::metas()
    }

    fn procedures(self: Arc<Self>) -> Vec<Procedure> {
        Arc::clone(&self.0).procedures()
    }
}

async fn call(
    router: &Router,
    principal: Principal,
    procedure: &str,
    input: Value,
) -> Result<Value, ErrorPayload> {
    let call = Call {
        procedure: procedure.into(),
        input,
    };
    router.call(session(principal), call).await
}

// ---- macro metadata ------------------------------------------------------------------------

#[test]
fn macro_builds_procedure_meta() {
    let metas = DemoApi::metas();
    let names: Vec<_> = metas.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "demo.echo",
            "demo.parse",
            "demo.dropTable",
            "demo.lower",
            "demo.internal",
            "demo.rows",
            "demo.watch",
        ]
    );

    let echo = &metas[0];
    assert_eq!(echo.kind, ProcedureKind::Query);
    assert_eq!(echo.perm.as_str(), "demo.read");
    assert_eq!(echo.risk, Risk::Read);
    assert_eq!(echo.agent, Agent::Exposed);
    assert!(!echo.log_input && !echo.deprecated && echo.redact.is_empty());
    assert_eq!(echo.timeout_default, Duration::from_secs(30));
    assert_eq!(echo.timeout_max, Duration::from_secs(300));

    let drop = &metas[2];
    assert_eq!(drop.kind, ProcedureKind::Mutation);
    assert_eq!(drop.risk, Risk::Write);
    assert_eq!(drop.agent, Agent::Hidden, "agent exposure is opt-in");
    assert_eq!(drop.timeout_default, Duration::from_secs(10));
    assert_eq!(drop.timeout_max, Duration::from_secs(3600));
    assert!(drop.log_input && drop.deprecated);
    assert_eq!(
        drop.loggable_input(&json!({"connection": "c1", "password": "pw"})),
        Some(json!({"connection": "c1", "password": "<redacted>"}))
    );

    let rows = &metas[5];
    assert_eq!(rows.kind, ProcedureKind::Stream);
    assert_eq!(rows.timeout_default, Duration::from_secs(7200));
    assert_eq!(
        rows.timeout_max, rows.timeout_default,
        "max follows a larger default"
    );
    assert_eq!(metas[6].kind, ProcedureKind::Subscription);
}

// ---- authorization before dispatch ---------------------------------------------------------

#[tokio::test]
async fn allowed_call_runs_after_authorization() {
    let policy = open_policy();
    let (router, api) = setup(&policy);
    let input = json!({"text": "hi"});
    let out = call(&router, human(), "demo.echo", input.clone())
        .await
        .unwrap();
    assert_eq!(out, json!({"text": "hi", "principal": "human:local:alice"}));
    assert_eq!(api.runs.load(Ordering::SeqCst), 1);
    assert_eq!(
        policy.seen(),
        [Seen {
            principal: "human:local:alice".into(),
            action: Action::new("demo.echo", "demo.read"),
            target: None,
            risk: Risk::Read,
            digest: input_digest(&input),
        }]
    );
}

#[tokio::test]
async fn unknown_permission_is_denied_and_handler_never_runs() {
    // The policy knows no permission at all: default-deny.
    let policy = Policy::default();
    let (router, api) = setup(&policy);
    let err = call(&router, human(), "demo.echo", json!({"text": "hi"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);
    assert_eq!(err.message, "permission denied");
    assert_eq!(err.details, None, "the deny reason stays on the server");
    assert_eq!(api.runs.load(Ordering::SeqCst), 0);
    assert_eq!(policy.seen().len(), 1);
}

#[tokio::test]
async fn missing_permission_is_denied() {
    let policy = Policy {
        known: vec!["demo.read"],
        ..Policy::default()
    };
    let (router, api) = setup(&policy);
    let err = call(&router, human(), "demo.echo", json!({"text": "hi"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);
    assert_eq!(api.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn authorization_runs_before_input_decoding() {
    let policy = Policy::default();
    let (router, _) = setup(&policy);
    let err = call(&router, human(), "demo.echo", json!(42))
        .await
        .unwrap_err();
    assert_eq!(
        err.code,
        Code::PermissionDenied,
        "a denied caller learns nothing about inputs"
    );
}

#[tokio::test]
async fn unknown_procedure_is_not_found() {
    let policy = open_policy();
    let (router, _) = setup(&policy);
    let err = call(&router, human(), "demo.nope", json!(null))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::NotFound);
    assert!(policy.seen().is_empty());
}

#[tokio::test]
async fn approval_required_with_and_without_queue() {
    let policy = Policy {
        known: vec!["demo.read"],
        granted: vec!["demo.read"],
        approval: vec!["demo.read"],
        ..Policy::default()
    };

    let (router, api) = setup(&policy);
    let err = call(&router, human(), "demo.echo", json!({"text": "x"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::ApprovalRequired);
    assert_eq!(err.details, None, "no queue, no approval id");

    let queue = Queue::default();
    let router = Router::with_approvals(policy.clone(), queue.clone());
    router.mount(DemoApi::default()).unwrap();
    let input = json!({"text": "x"});
    let err = call(&router, human(), "demo.echo", input.clone())
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::ApprovalRequired);
    assert_eq!(err.details, Some(json!({"approval_id": "apr-1"})));
    let pending = queue.0.lock().unwrap();
    assert_eq!(pending[0].action, Action::new("demo.echo", "demo.read"));
    assert_eq!(pending[0].input_digest, input_digest(&input));
    assert_eq!(api.runs.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn handler_reauthorizes_with_target_and_escalated_risk() {
    let policy = open_policy();
    let queue = Queue::default();
    let router = Router::with_approvals(policy.clone(), queue.clone());
    let api = Arc::new(DemoApi::default());
    router.mount(ArcApi(Arc::clone(&api))).unwrap();

    let input = json!({"connection": "c-9", "password": "pw"});
    let err = call(&router, human(), "demo.dropTable", input.clone())
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::ApprovalRequired);
    assert_eq!(err.details, Some(json!({"approval_id": "apr-1"})));
    assert_eq!(api.runs.load(Ordering::SeqCst), 0);

    let seen = policy.seen();
    assert_eq!(seen.len(), 2);
    assert_eq!((seen[0].risk, seen[0].target.clone()), (Risk::Write, None));
    assert_eq!(
        (seen[1].risk, seen[1].target.clone()),
        (Risk::Destructive, Some(TargetRef::connection("c-9")))
    );
    assert_eq!(seen[1].digest, input_digest(&input));
}

#[tokio::test]
async fn handler_cannot_lower_risk() {
    let policy = open_policy();
    let (router, _) = setup(&policy);
    call(&router, human(), "demo.lower", json!(null))
        .await
        .unwrap();
    let risks: Vec<_> = policy.seen().iter().map(|s| s.risk).collect();
    assert_eq!(risks, [Risk::Write, Risk::Write]);
}

#[tokio::test]
async fn agents_only_reach_exposed_procedures() {
    let policy = open_policy();
    let (router, _) = setup(&policy);

    let out = call(&router, agent(), "demo.echo", json!({"text": "hi"}))
        .await
        .unwrap();
    assert_eq!(out["principal"], "agent:token:bot");

    let err = call(&router, agent(), "demo.lower", json!(null))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);

    // A plugin acting for an agent is still an agent call.
    let plugin = Principal {
        kind: PrincipalKind::Plugin,
        id: "plugin:x@1".into(),
        on_behalf_of: Some(Box::new(agent())),
        ..human()
    };
    let err = call(&router, plugin, "demo.lower", json!(null))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);
    assert_eq!(
        policy.seen().len(),
        1,
        "hidden procedures never reach the authorizer for agents"
    );
}

#[tokio::test]
async fn streams_and_subscriptions_are_authorized_then_unimplemented() {
    let policy = Policy::default();
    let (router, _) = setup(&policy);
    let err = call(&router, human(), "demo.rows", json!(null))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::PermissionDenied);

    let policy = open_policy();
    let (router, _) = setup(&policy);
    for name in ["demo.rows", "demo.watch"] {
        let err = call(&router, human(), name, json!(null)).await.unwrap_err();
        assert_eq!(err.code, Code::Unimplemented);
    }
}

// ---- error model ---------------------------------------------------------------------------

#[tokio::test]
async fn typed_domain_error_travels_as_details() {
    let policy = open_policy();
    let (router, _) = setup(&policy);
    let err = call(&router, human(), "demo.parse", json!(12))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::InvalidArgument);
    assert_eq!(err.message, "syntax error");
    let typed = RpcError::<QueryError>::from_payload(err);
    assert_eq!(typed.details, Some(QueryError::Syntax { position: 12 }));
}

#[tokio::test]
async fn invalid_input_does_not_echo_values() {
    let policy = open_policy();
    let (router, _) = setup(&policy);
    let err = call(
        &router,
        human(),
        "demo.echo",
        json!({"text": 5, "secret": "s3cret"}),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, Code::InvalidArgument);
    assert!(!err.message.contains("s3cret") && !err.message.contains('5'));
}

#[tokio::test]
async fn internal_errors_are_scrubbed() {
    let policy = open_policy();
    let (router, _) = setup(&policy);
    let err = call(&router, human(), "demo.internal", json!(null))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::Internal);
    assert_eq!(err.message, "internal error");
}

// ---- registry ------------------------------------------------------------------------------

#[test]
fn mount_rejects_duplicates_atomically() {
    let router = Router::new(open_policy());
    router.mount(DemoApi::default()).unwrap();
    let before = router.procedures().len();
    assert_eq!(
        router.mount(DemoApi::default()),
        Err(RegistryError::Duplicate("demo.echo".into()))
    );
    assert_eq!(router.procedures().len(), before);
}

#[tokio::test]
async fn dynamic_procedures_can_be_added_and_removed() {
    let policy = Policy {
        known: vec!["plugin.pg.ping"],
        granted: vec!["plugin.pg.ping"],
        ..Policy::default()
    };
    let router = Router::new(policy.clone());
    let meta = ProcedureMeta::new(
        "plugin.pg.ping",
        ProcedureKind::Query,
        "plugin.pg.ping",
        Risk::Read,
    );
    let handler: ambidex::Handler = Arc::new(|_ctx, input| Box::pin(async move { Ok(input) }));
    router
        .insert(Procedure::new(meta.clone(), handler.clone()))
        .unwrap();
    assert_eq!(
        router.insert(Procedure::new(meta, handler.clone())),
        Err(RegistryError::Duplicate("plugin.pg.ping".into()))
    );

    assert_eq!(
        call(&router, human(), "plugin.pg.ping", json!(1))
            .await
            .unwrap(),
        json!(1)
    );
    assert!(router.remove("plugin.pg.ping").is_some());
    let err = call(&router, human(), "plugin.pg.ping", json!(1))
        .await
        .unwrap_err();
    assert_eq!(err.code, Code::NotFound);

    let bad = ProcedureMeta::new("noNamespace", ProcedureKind::Query, "p", Risk::Read);
    assert_eq!(
        router.insert(Procedure::new(bad, handler)),
        Err(RegistryError::InvalidName("noNamespace".into()))
    );
}

#[test]
fn input_digest_ignores_key_order_and_whitespace() {
    let a: Value = serde_json::from_str(r#"{"b": [1, {"y": 2, "x": 1}], "a": "s"}"#).unwrap();
    let b: Value = serde_json::from_str(r#"{"a":"s","b":[1,{"x":1,"y":2}]}"#).unwrap();
    assert_eq!(input_digest(&a), input_digest(&b));
    assert_ne!(input_digest(&a), input_digest(&json!({"a": "s"})));
    // Golden value: SHA-256 of the canonical bytes `{"a":"s","b":[1,{"x":1,"y":2}]}`.
    assert_eq!(
        input_digest(&a).to_string(),
        "fc76477f3faaa4e6774397befd97e4b2a6af6aaff6aeea3c72487efaac3486d4"
    );
}

// ---- end to end through the engine ---------------------------------------------------------

struct OneUser;

impl Authenticate for OneUser {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "s-1".into(),
                principal: human(),
            })
        })
    }
}

#[tokio::test]
async fn router_serves_calls_over_the_engine() {
    let policy = Policy {
        known: vec!["demo.read"],
        granted: vec!["demo.read"],
        ..Policy::default()
    };
    let router = Router::new(policy.clone());
    router.mount(DemoApi::default()).unwrap();
    let server = Server::new(ServerConfig::new("dbee", "h", "1"), OneUser, router);
    let ((mut rx, mut tx), (srx, stx)) = memory(16);
    let _conn = server.serve(srx, stx);

    let send = |kind, id, value: Value| Frame::new(kind, id, serde_json::to_vec(&value).unwrap());
    let hello = json!({"protocol": 1, "api": "dbee", "schema_hash": "h", "client_version": "1"});
    tx.send(send(Kind::Hello, 0, hello).encode(u32::MAX).unwrap())
        .await
        .unwrap();
    let call = json!({"procedure": "demo.echo", "input": {"text": "over the wire"}});
    tx.send(send(Kind::Call, 1, call).encode(u32::MAX).unwrap())
        .await
        .unwrap();
    let call =
        json!({"procedure": "demo.dropTable", "input": {"connection": "c", "password": "p"}});
    tx.send(send(Kind::Call, 2, call).encode(u32::MAX).unwrap())
        .await
        .unwrap();

    let mut decoder = FrameDecoder::new(u32::MAX);
    let mut frames = Vec::new();
    while frames.len() < 3 {
        while let Some(frame) = decoder.next_frame().unwrap() {
            frames.push(frame);
        }
        if frames.len() < 3 {
            decoder.push(&rx.recv().await.unwrap().unwrap());
        }
    }
    assert_eq!(frames[0].kind, Kind::HelloAck);
    frames[1..].sort_by_key(|f| f.call_id);
    assert_eq!((frames[1].kind, frames[1].call_id), (Kind::Result, 1));
    let result: Value = serde_json::from_slice(&frames[1].payload).unwrap();
    assert_eq!(result["text"], "over the wire");
    assert_eq!((frames[2].kind, frames[2].call_id), (Kind::Error, 2));
    let err: ErrorPayload = serde_json::from_slice(&frames[2].payload).unwrap();
    assert_eq!(err.code, Code::PermissionDenied);
    assert!(!err.correlation_id.is_empty());
}
