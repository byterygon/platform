//! The fixture API every harness serves (Ambidex spec §12).
//!
//! Procedures live in namespace `fixture` and are declared with the real `#[rpc::router]` macro,
//! so calls go through the production [`Router`], [`Authorizer`] hook and error model. Handlers
//! report what happened to them through a shared [`Probe`], which the cases read to check that
//! cancellation reached the handler, that a denied call never ran, and so on.
//!
//! Not in the fixture yet: the counter subscription and the synthetic 1M-row Arrow stream have no
//! engine support (subscriptions are a later M1 task, streams and credits are M2). They are
//! declared, so the router authorizes them and answers `Unimplemented`; see the crate docs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ambidex::codegen::{self, ApiInfo};
use ambidex::security_types::{
    Action, ApprovalSpec, Authorizer, AuthzRequest, Decision, Principal, Reason, Risk, TargetRef,
};
use ambidex::{
    Approvals, Code, Ctx, DomainError, Router, RpcError, ServerConfig, engine::BoxFuture, rpc,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{Mutex, mpsc};
use ts_rs::TS;

/// API name and server version every harness configures.
pub const API: &str = "conformance";
pub const SERVER_VERSION: &str = "0.0.0-conformance";

/// The schema hash of the fixture API, computed from its router as `rpc-gen` computes it, so the
/// generated TypeScript client's Hello matches the servers every harness starts.
pub static SCHEMA_HASH: LazyLock<String> = LazyLock::new(|| {
    codegen::schema_hash(&Fixture::new().router(), &api_info()).expect("fixture API exports")
});

/// Identity written into the generated `api.ts` and `api.manifest.json`: the version the servers
/// announce in Welcome, so `API_VERSION` matches them.
pub fn api_info() -> ApiInfo {
    ApiInfo::new(API, SERVER_VERSION)
}

/// Where the fixture API's generated `api.ts` and `api.manifest.json` are committed: next to the
/// TypeScript client's conformance scenarios.
pub fn generated_dir() -> PathBuf {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/<name> is two levels below the workspace root");
    workspace.join("packages/ambidex/test/conformance")
}

/// Largest payload a client may send once the session exists. Small, so the limit cases stay
/// cheap on every transport.
pub const MAX_FRAME_BYTES: u32 = 4096;

/// Calls in flight per connection.
pub const MAX_CONCURRENT_CALLS: u32 = 4;

/// How long a cancelled handler may keep running before its future is dropped.
pub const CANCEL_GRACE: Duration = Duration::from_millis(100);

/// `timeout_max` of [`FixtureApi::capped`].
pub const CAPPED_TIMEOUT_MAX: Duration = Duration::from_millis(50);

/// Id the fixture approval queue gives every request.
pub const APPROVAL_ID: &str = "approval-1";

/// The engine configuration every harness uses.
pub fn server_config() -> ServerConfig {
    let mut config = ServerConfig::new(API, SCHEMA_HASH.as_str(), SERVER_VERSION);
    config.max_frame_bytes = MAX_FRAME_BYTES;
    config.max_hello_bytes = 1024;
    config.max_concurrent_calls = MAX_CONCURRENT_CALLS;
    config.cancel_grace = CANCEL_GRACE;
    config
}

/// Something a fixture handler did, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// The handler started running.
    Started(&'static str),
    /// The handler saw its cancellation token fire.
    Cancelled(&'static str),
    /// The handler's future was dropped before it finished (after the cancel grace).
    Dropped(&'static str),
}

/// What the fixture handlers did. Shared between the server (any runtime, any thread) and the
/// test.
pub struct Probe {
    events_tx: mpsc::UnboundedSender<Event>,
    events: Mutex<mpsc::UnboundedReceiver<Event>>,
    runs: AtomicUsize,
}

impl Probe {
    fn new() -> Probe {
        let (events_tx, events) = mpsc::unbounded_channel();
        Probe {
            events_tx,
            events: Mutex::new(events),
            runs: AtomicUsize::new(0),
        }
    }

    fn record(&self, event: Event) {
        if matches!(event, Event::Started(_)) {
            self.runs.fetch_add(1, Ordering::SeqCst);
        }
        let _ = self.events_tx.send(event);
    }

    /// Handlers that started so far.
    pub fn runs(&self) -> usize {
        self.runs.load(Ordering::SeqCst)
    }

    /// Waits for the next event and checks it. Panics after [`crate::client::RECV_TIMEOUT`].
    pub async fn expect(&self, expected: Event) {
        let mut events = self.events.lock().await;
        let event = tokio::time::timeout(crate::client::RECV_TIMEOUT, events.recv())
            .await
            .unwrap_or_else(|_| panic!("no handler event, expected {expected:?}"))
            .expect("probe sender lives in the fixture");
        assert_eq!(event, expected);
    }

    /// Events recorded so far and not yet consumed by [`Probe::expect`].
    pub async fn pending(&self) -> Vec<Event> {
        let mut events = self.events.lock().await;
        let mut pending = Vec::new();
        while let Ok(event) = events.try_recv() {
            pending.push(event);
        }
        pending
    }
}

/// One server's fixture: the probe its handlers report to.
#[derive(Clone)]
pub struct Fixture {
    pub probe: Arc<Probe>,
}

impl Default for Fixture {
    fn default() -> Fixture {
        Fixture::new()
    }
}

impl Fixture {
    pub fn new() -> Fixture {
        Fixture {
            probe: Arc::new(Probe::new()),
        }
    }

    /// The production router with the fixture API, authorizer and approval queue.
    pub fn router(&self) -> Router {
        let router = Router::with_approvals(FixtureAuthorizer, FixtureApprovals);
        router
            .mount(FixtureApi {
                probe: Arc::clone(&self.probe),
            })
            .expect("fixture API registers");
        router
    }
}

/// The typed domain error of [`FixtureApi::fail`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind")]
pub enum FixtureError {
    Requested { code: Code, retryable: bool },
}

impl DomainError for FixtureError {
    fn code(&self) -> Code {
        match self {
            FixtureError::Requested { code, .. } => *code,
        }
    }

    fn message(&self) -> String {
        format!("requested {:?}", self.code())
    }

    fn retryable(&self) -> bool {
        match self {
            FixtureError::Requested { retryable, .. } => *retryable,
        }
    }
}

/// Input of [`FixtureApi::fail`].
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct FailInput {
    pub code: Code,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retryable: bool,
}

/// Counts a handler future dropped before it finished.
struct DropGuard {
    probe: Arc<Probe>,
    name: &'static str,
    armed: bool,
}

impl Drop for DropGuard {
    fn drop(&mut self) {
        if self.armed {
            self.probe.record(Event::Dropped(self.name));
        }
    }
}

pub struct FixtureApi {
    probe: Arc<Probe>,
}

impl FixtureApi {
    fn guard(&self, name: &'static str) -> DropGuard {
        self.probe.record(Event::Started(name));
        DropGuard {
            probe: Arc::clone(&self.probe),
            name,
            armed: true,
        }
    }

    /// Waits for the call's token, records it, then returns a value the client must never see.
    async fn until_cancelled(&self, ctx: &Ctx, name: &'static str) -> Result<String, RpcError> {
        let mut guard = self.guard(name);
        ctx.cancelled().await;
        self.probe.record(Event::Cancelled(name));
        guard.armed = false;
        Ok("finished after cancel".into())
    }
}

#[rpc::router(namespace = "fixture")]
impl FixtureApi {
    /// Returns its input.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn echo(&self, _ctx: Ctx, input: Value) -> Result<Value, RpcError> {
        Ok(input)
    }

    /// A string of `len` bytes, to produce results larger than a frame.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn big(&self, _ctx: Ctx, len: usize) -> Result<String, RpcError> {
        Ok("x".repeat(len))
    }

    /// The session and principal the server attached to the call.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn whoami(&self, ctx: Ctx, _input: Value) -> Result<Value, RpcError> {
        Ok(serde_json::json!({
            "session": ctx.session().id,
            "principal": ctx.principal().id,
        }))
    }

    /// Fails with the requested code and a typed domain error in `details`.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn fail(&self, _ctx: Ctx, input: FailInput) -> Result<(), FixtureError> {
        Err(FixtureError::Requested {
            code: input.code,
            retryable: input.retryable,
        })
    }

    /// Runs until cancelled, by Cancel, deadline, revocation or disconnect.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn wait(&self, ctx: Ctx, _input: Value) -> Result<String, RpcError> {
        self.until_cancelled(&ctx, "wait").await
    }

    /// Like `wait`, but the procedure caps any client deadline.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read, timeout_max = "50ms")]
    async fn capped(&self, ctx: Ctx, _input: Value) -> Result<String, RpcError> {
        self.until_cancelled(&ctx, "capped").await
    }

    /// Ignores its token entirely; only dropping its future stops it.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn stubborn(&self, _ctx: Ctx, _input: Value) -> Result<String, RpcError> {
        let _guard = self.guard("stubborn");
        std::future::pending::<()>().await;
        unreachable!("never completes")
    }

    /// Requires a permission the fixture policy does not grant (default-deny). Its input is typed
    /// like `fail`'s, so a case can send input that would fail decoding.
    #[rpc::mutation(perm = "fixture.admin", risk = Risk::Write)]
    async fn protected(&self, _ctx: Ctx, _input: FailInput) -> Result<(), RpcError> {
        let _guard = self.guard("protected");
        Ok(())
    }

    /// Requires a human approval before dispatch.
    #[rpc::mutation(perm = "fixture.approve", risk = Risk::Write)]
    async fn approval(&self, _ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        let _guard = self.guard("approval");
        Ok(())
    }

    /// Allowed at its Read baseline, then escalates to Destructive on a target in the handler,
    /// which the policy answers with an approval request.
    #[rpc::mutation(perm = "fixture.call", risk = Risk::Read)]
    async fn escalate(&self, ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        let mut guard = self.guard("escalate");
        guard.armed = false;
        ctx.authorize(Some(&TargetRef::connection("c-1")), Risk::Destructive)
            .await?;
        Ok(())
    }

    /// Returns an `Internal` error carrying backend details, which must never reach the client.
    #[rpc::query(perm = "fixture.call", risk = Risk::Read)]
    async fn leak(&self, _ctx: Ctx, _input: Value) -> Result<(), ambidex::ErrorPayload> {
        let mut err = ambidex::ErrorPayload::new(Code::Internal, "db at 10.0.0.7 refused admin:pw");
        err.details = Some(serde_json::json!({ "dsn": "postgres://admin:pw@10.0.0.7" }));
        Err(err)
    }

    /// Counter subscription (spec §12). Declared only: subscriptions have no engine support yet.
    #[rpc::subscription(perm = "fixture.call", risk = Risk::Read)]
    async fn counter(&self, _ctx: Ctx, _input: Value) -> Result<u64, RpcError> {
        Err(RpcError::new(Code::Unimplemented, "declared only"))
    }

    /// Synthetic Arrow row stream (spec §12). Declared only: streams and credits are M2.
    #[rpc::stream(perm = "fixture.call", risk = Risk::Read)]
    async fn rows(&self, _ctx: Ctx, _input: Value) -> Result<u64, RpcError> {
        Err(RpcError::new(Code::Unimplemented, "declared only"))
    }
}

/// Default-deny policy: `fixture.call` is allowed up to `Write` and needs approval above it,
/// `fixture.approve` always needs approval, every other permission is unknown and denied.
pub struct FixtureAuthorizer;

impl Authorizer for FixtureAuthorizer {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        let needs_approval = || Decision::NeedsApproval {
            approval: ApprovalSpec {
                action: Action::new(req.action.name.clone(), req.action.perm.clone()),
                target: req.target.cloned(),
                risk: req.risk,
                input_digest: req.input_digest,
                expires_at_unix_ms: 0,
            },
        };
        match req.action.perm.as_str() {
            "fixture.call" if req.risk <= Risk::Write => Decision::Allow,
            "fixture.call" | "fixture.approve" => needs_approval(),
            _ => Decision::Deny {
                reason: Reason::UnknownPermission {
                    perm: req.action.perm.clone(),
                },
            },
        }
    }
}

/// Approval queue that records nothing and answers [`APPROVAL_ID`].
pub struct FixtureApprovals;

impl Approvals for FixtureApprovals {
    fn request<'a>(
        &'a self,
        _principal: &'a Principal,
        _spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>> {
        Box::pin(async { Some(APPROVAL_ID.to_owned()) })
    }
}
