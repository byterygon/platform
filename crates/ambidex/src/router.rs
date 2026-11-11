//! Procedure registry and router (Ambidex spec §1, §2, §8, §11).
//!
//! A [`Router`] holds every procedure a server exposes: static ones mounted from
//! `#[rpc::router]` impls, and dynamic ones (plugin operations) inserted and removed at runtime.
//! It implements [`Dispatch`], so the engine hands it every decoded call. For each call it:
//!
//! 1. looks the procedure up (`NotFound` otherwise);
//! 2. answers `NotFound` to agent principals for procedures not marked `agent = Agent::Exposed`;
//! 3. checks the call kind: a subscription is started with `Subscribe` ([`Router::subscribe`]),
//!    everything else with `Call` ([`Router::call`]); otherwise `InvalidArgument`, before any
//!    authorization (kinds are public in the manifest, like names);
//! 4. asks the [`Authorizer`] with the procedure's action, baseline risk and the input digest,
//!    and runs the handler only on [`Decision::Allow`]. There is no default authorizer: a router
//!    cannot be built without one, and the authorizer denies unknown permissions (default-deny);
//! 5. decodes the input, runs the handler and encodes its result or typed error.
//!
//! Calls and subscriptions share every step; a subscription handler also gets the subscription's
//! [`Events`], typed as an [`EventSink`](crate::EventSink) by `#[rpc::router]`.
//!
//! Right after the lookup it applies the procedure's `timeout_default`/`timeout_max` to the call's
//! [`CallScope`], so the deadline covers authorization too. Queries, mutations and streams always
//! have both; a subscription never has a default and has a maximum only if it declares one, so
//! without a client `timeout_ms` it may have no deadline at all (spec Open question 24f; the
//! registry refuses metadata that breaks these rules). Handlers observe cancellation through
//! [`Ctx::cancelled`] and pass [`Ctx::cancellation_token`] on (e.g. to the Plugin Host driver call).
//!
//! Handlers re-check targets and escalated risk with [`Ctx::authorize`].
//!
//! **Audit** (spec §8, Open questions 24g and 26; see [`crate::audit`]): with an [`AuditSink`]
//! ([`Router::with_audit`]), every refusal by the authorizer is one entry, and every call that
//! runs, of any kind, gets an admission entry (`Started`) written before its handler and a
//! completion entry with its outcome, delivery and duration. Between authorization and the
//! handler, step 4 above also writes the admission: if it cannot be written, Write/Destructive
//! calls and agent calls end with `Unavailable` and their handler never runs. A router without a
//! sink records nothing, so it runs only human Read calls.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};

use security_types::{
    Action, ApprovalSpec, AuditDecision, AuditEntry, AuditPrincipal, AuditReporter, AuditSink,
    Authorizer, AuthzRequest, Decision, Digest, Outcome, Principal, Risk, TargetRef, unix_now_ms,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::Digest as _;

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::audit::{
    Admission, AuditPolicy, Recorder, acts_as_agent, code_name, outcome_of, unavailable,
};
use crate::cancel::CallScope;
use crate::codegen::ProcedureTypes;
use crate::engine::{BoxFuture, Dispatch, Session};
use crate::error::{IntoErrorPayload, RpcError};
use crate::message::{Call, Code, ErrorPayload};
use crate::procedure::{Agent, ProcedureKind, ProcedureMeta, is_valid_perm};
use crate::subscription::Events;

/// Type-erased handler: decoded call context and JSON input in, JSON result or wire error out.
pub type Handler =
    Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, Result<Value, ErrorPayload>> + Send + Sync>;

/// Type-erased subscription handler: context, JSON input and the subscription's events in;
/// `Ok(())` for a normal end, or the wire error it ends with.
pub type SubscriptionHandler =
    Arc<dyn Fn(Ctx, Value, Events) -> BoxFuture<'static, Result<(), ErrorPayload>> + Send + Sync>;

/// What runs when a procedure is called.
#[derive(Clone)]
enum Run {
    /// A query or mutation.
    Unary(Handler),
    Subscription(SubscriptionHandler),
    /// Listed and authorized, then answered with `Unimplemented` (streams until M2).
    Declared,
}

/// One registry entry.
#[derive(Clone)]
pub struct Procedure {
    meta: Arc<ProcedureMeta>,
    run: Run,
    types: Option<ProcedureTypes>,
}

impl Procedure {
    /// A query or mutation with its handler.
    pub fn new(meta: ProcedureMeta, handler: Handler) -> Procedure {
        Procedure::with_run(meta, Run::Unary(handler))
    }

    /// A subscription with its handler.
    pub fn subscription(meta: ProcedureMeta, handler: SubscriptionHandler) -> Procedure {
        Procedure::with_run(meta, Run::Subscription(handler))
    }

    /// A procedure whose call kind the engine cannot run yet (streams, until M2). It is listed
    /// and authorized like any other, then answered with `Unimplemented`.
    pub fn declared(meta: ProcedureMeta) -> Procedure {
        Procedure::with_run(meta, Run::Declared)
    }

    fn with_run(meta: ProcedureMeta, run: Run) -> Procedure {
        Procedure {
            meta: Arc::new(meta),
            run,
            types: None,
        }
    }

    /// Attaches the input, output and error types codegen exports (`#[rpc::router]` always does).
    #[must_use]
    pub fn with_types(mut self, types: ProcedureTypes) -> Procedure {
        self.types = Some(types);
        self
    }

    pub fn meta(&self) -> &Arc<ProcedureMeta> {
        &self.meta
    }

    /// `None` for procedures built without types, e.g. dynamic plugin procedures.
    pub fn types(&self) -> Option<&ProcedureTypes> {
        self.types.as_ref()
    }
}

impl fmt::Debug for Procedure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let run = match self.run {
            Run::Unary(_) => "unary",
            Run::Subscription(_) => "subscription",
            Run::Declared => "declared",
        };
        f.debug_struct("Procedure")
            .field("meta", &self.meta)
            .field("run", &run)
            .finish()
    }
}

/// A set of procedures. Implemented by `#[rpc::router]`.
pub trait Api: Send + Sync + 'static {
    /// Metadata of every procedure, in declaration order, without needing an instance.
    fn metas() -> Vec<ProcedureMeta>
    where
        Self: Sized;

    fn procedures(self: Arc<Self>) -> Vec<Procedure>;
}

/// Records a human approval request and returns its id (spec §8, `approvals.pending`).
pub trait Approvals: Send + Sync + 'static {
    /// `None` if the request could not be recorded; the call is then refused without an id.
    fn request<'a>(
        &'a self,
        principal: &'a Principal,
        spec: &'a ApprovalSpec,
    ) -> BoxFuture<'a, Option<String>>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryError {
    /// A procedure with this name is already registered.
    Duplicate(String),
    /// The name is not `"<namespace>.<method>"` with non-empty segments.
    InvalidName(String),
    /// The permission is empty or contains whitespace.
    InvalidPermission(String),
    /// The handler does not match the procedure's kind (a unary handler on a subscription, or a
    /// subscription handler on anything else).
    KindMismatch(String),
    /// The timeouts break the rules of the kind: a query, mutation or stream without
    /// `timeout_default` or `timeout_max`, or a subscription with a `timeout_default`
    /// (subscriptions have no default deadline).
    InvalidTimeouts(String),
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::Duplicate(name) => write!(f, "procedure {name} is already registered"),
            RegistryError::InvalidName(name) => write!(f, "invalid procedure name {name:?}"),
            RegistryError::InvalidPermission(name) => {
                write!(f, "procedure {name} has an invalid permission")
            }
            RegistryError::KindMismatch(name) => {
                write!(f, "procedure {name} has a handler for another call kind")
            }
            RegistryError::InvalidTimeouts(name) => {
                write!(
                    f,
                    "procedure {name} has timeouts its call kind does not allow"
                )
            }
        }
    }
}

impl std::error::Error for RegistryError {}

/// Dyn-compatible view of an [`Authorizer`] (whose `check` returns `impl Future`).
trait DynAuthorizer: Send + Sync + 'static {
    fn check<'a>(&'a self, req: &'a AuthzRequest<'a>) -> BoxFuture<'a, Decision>;
}

impl<Z: Authorizer> DynAuthorizer for Z {
    fn check<'a>(&'a self, req: &'a AuthzRequest<'a>) -> BoxFuture<'a, Decision> {
        Box::pin(Authorizer::check(self, req))
    }
}

/// Authorizer, approval queue and audit, shared by the router and every [`Ctx`].
struct Guard {
    authorizer: Arc<dyn DynAuthorizer>,
    approvals: Option<Arc<dyn Approvals>>,
    audit: Arc<Recorder>,
}

/// What a check is about, for the authorizer and the audit entry.
struct Check<'a> {
    principal: &'a Principal,
    meta: &'a ProcedureMeta,
    target: Option<&'a TargetRef>,
    risk: Risk,
    input_digest: Digest,
    correlation_id: &'a str,
    parent_correlation_id: Option<&'a str>,
}

/// The admission entry records exactly what was checked.
impl<'a> From<&Check<'a>> for Admission<'a> {
    fn from(check: &Check<'a>) -> Admission<'a> {
        Admission {
            principal: check.principal,
            action: check.meta.action(),
            target: check.target,
            risk: check.risk,
            input_digest: check.input_digest,
            correlation_id: check.correlation_id,
            parent_correlation_id: check.parent_correlation_id,
        }
    }
}

impl Guard {
    /// Asks the authorizer and maps anything but `Allow` to the error the caller sees. A refusal
    /// is audited (and refused whether or not its entry is written).
    async fn enforce(&self, check: &Check<'_>) -> Result<(), Rejected> {
        let action = check.meta.action();
        let req = AuthzRequest {
            principal: check.principal,
            action: &action,
            target: check.target,
            risk: check.risk,
            input_digest: check.input_digest,
        };
        let decision = self.authorizer.check(&req).await;
        let rejected = match &decision {
            Decision::Allow => return Ok(()),
            // The reason stays on the server: the client learns only that it was denied.
            Decision::Deny { .. } => Rejected {
                code: Code::PermissionDenied,
                approval_id: None,
            },
            Decision::NeedsApproval { approval } => {
                let approval_id = match &self.approvals {
                    Some(approvals) => approvals.request(check.principal, approval).await,
                    None => None,
                };
                Rejected {
                    code: Code::ApprovalRequired,
                    approval_id,
                }
            }
        };
        self.audit_refusal(check, action, &decision, &rejected)
            .await;
        Err(rejected)
    }

    async fn audit_refusal(
        &self,
        check: &Check<'_>,
        action: Action,
        decision: &Decision,
        rejected: &Rejected,
    ) {
        let entry = AuditEntry {
            timestamp_unix_ms: unix_now_ms(),
            principal_chain: AuditPrincipal::chain_of(check.principal),
            tenant: check.principal.tenant.clone(),
            action,
            target: check.target.cloned(),
            risk: check.risk,
            decision: AuditDecision::from(decision),
            approval_id: rejected.approval_id.clone(),
            outcome: Outcome::Error {
                code: code_name(rejected.code),
            },
            duration_ms: None,
            correlation_id: check.correlation_id.to_owned(),
            input_digest: check.input_digest,
            statement_digest: None,
            delivery: None,
            // A refused nested call (at dispatch or in a re-check) names its caller too (spec Open
            // question 26 item 14).
            parent_correlation_id: check.parent_correlation_id.map(str::to_owned),
        };
        // The call is refused whether or not the entry was recorded, so a failing sink cannot
        // let anything through; a failure is reported.
        self.audit.refusal(entry).await;
    }

    /// Records an allowed re-check as `Started` before the handler goes on. `Err` when it must
    /// not go on because the entry could not be written (see [`crate::audit`]).
    async fn recheck(&self, check: &Check<'_>) -> Result<(), ()> {
        self.audit.recheck(&Admission::from(check)).await
    }
}

/// `details` of an `ApprovalRequired` error raised by the authorizer: the id of the recorded
/// approval request.
#[derive(
    Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize, ts_rs::TS, schemars::JsonSchema,
)]
#[ts(rename = "ApprovalRequiredDetails")]
#[schemars(rename = "ApprovalRequiredDetails")]
pub struct ApprovalRequired {
    pub approval_id: String,
}

/// A call refused by the authorizer: `PermissionDenied`, or `ApprovalRequired` with the id of the
/// recorded approval request when there is an approval queue. [`Ctx::authorize`] also returns
/// `Unavailable` when an allowed re-check that must be recorded could not be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub code: Code,
    pub approval_id: Option<String>,
}

impl fmt::Display for Rejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Code::ApprovalRequired => f.write_str("approval required"),
            Code::Unavailable => f.write_str("audit log unavailable"),
            _ => f.write_str("permission denied"),
        }
    }
}

impl std::error::Error for Rejected {}

/// Its only details are the approval id, which every client error type has a slot for
/// (`ApprovalRequiredDetails` in `api.ts`).
impl IntoErrorPayload for Rejected {
    type Details = crate::error::NoDetails;

    fn into_error_payload(self) -> ErrorPayload {
        let mut payload = ErrorPayload::new(self.code, self.to_string());
        payload.details = self.approval_id.map(|approval_id| {
            serde_json::to_value(ApprovalRequired { approval_id })
                .expect("ApprovalRequired serializes")
        });
        payload
    }
}

/// Lets a handler whose error type is `RpcError<E>` use `?` on [`Ctx::authorize`]. The approval
/// id cannot be an `E`; the router restores it in the wire `details` (see [`Router::call`]).
impl<E> From<Rejected> for RpcError<E> {
    fn from(rejected: Rejected) -> Self {
        RpcError::new(rejected.code, rejected.to_string())
    }
}

/// Per-call context handed to every handler.
#[derive(Clone)]
pub struct Ctx {
    session: Arc<Session>,
    meta: Arc<ProcedureMeta>,
    guard: Arc<Guard>,
    input_digest: Digest,
    scope: CallScope,
    /// Approval id recorded by the last [`Ctx::authorize`] of this call, if any.
    approval_id: Arc<Mutex<Option<String>>>,
}

impl Ctx {
    /// The acting principal.
    pub fn principal(&self) -> &Principal {
        &self.session.principal
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    pub fn procedure(&self) -> &ProcedureMeta {
        &self.meta
    }

    /// SHA-256 over the canonical JSON of the call input; see [`input_digest`].
    pub fn input_digest(&self) -> Digest {
        self.input_digest
    }

    /// Resolves once the call is cancelled: `Cancel` frame, deadline, session revocation or
    /// disconnect (spec §7). After that the handler has the server's cancel grace period to stop
    /// before its future is dropped, and the client gets `Cancelled` or `DeadlineExceeded` whatever
    /// the handler returns.
    pub async fn cancelled(&self) {
        self.scope.cancelled().await
    }

    pub fn is_cancelled(&self) -> bool {
        self.scope.is_cancelled()
    }

    /// The call's token, to hand to work that must react to cancellation itself (e.g. the Plugin
    /// Host driver call, which issues the database's cancel request).
    pub fn cancellation_token(&self) -> &CancellationToken {
        self.scope.token()
    }

    /// When the server cancels the call with `DeadlineExceeded`, on the server's
    /// [`DeadlineClock`](crate::DeadlineClock); `None` for a subscription without a deadline (no
    /// client `timeout_ms` and no declared maximum).
    pub fn deadline(&self) -> Option<Instant> {
        self.scope.deadline()
    }

    /// Authorizes this call again for a concrete `target` and the risk the handler determined at
    /// runtime (e.g. SQL classified as DDL). Risk only escalates from the procedure's baseline.
    ///
    /// An allowed re-check is recorded as a `Started` entry with its target and risk before this
    /// returns `Ok`. If that entry cannot be written, a Write/Destructive re-check, or any
    /// re-check of an agent call, returns `Unavailable` so the handler stops before the work it
    /// was about to do.
    pub async fn authorize(&self, target: Option<&TargetRef>, risk: Risk) -> Result<(), Rejected> {
        let risk = self.meta.risk.escalate(risk);
        let check = Check {
            principal: self.principal(),
            meta: &self.meta,
            target,
            risk,
            input_digest: self.input_digest,
            correlation_id: self.scope.correlation_id(),
            parent_correlation_id: self.scope.parent_correlation_id(),
        };
        if let Err(rejected) = self.guard.enforce(&check).await {
            if let Some(id) = &rejected.approval_id {
                *lock(&self.approval_id) = Some(id.clone());
            }
            return Err(rejected);
        }
        if self.guard.recheck(&check).await.is_err() {
            return Err(Rejected {
                code: Code::Unavailable,
                approval_id: None,
            });
        }
        self.scope.update_completion(|c| c.raise_risk(risk));
        Ok(())
    }
}

impl fmt::Debug for Ctx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ctx")
            .field("session", &self.session.id)
            .field("procedure", &self.meta.name)
            .finish_non_exhaustive()
    }
}

/// The procedure registry. Cheap to clone; clones share the registry.
#[derive(Clone)]
pub struct Router {
    guard: Arc<Guard>,
    procedures: Arc<RwLock<HashMap<String, Procedure>>>,
}

impl Router {
    /// A router without an approval queue: `NeedsApproval` decisions are refused with
    /// `ApprovalRequired` and no approval id.
    pub fn new(authorizer: impl Authorizer) -> Router {
        Router::build(Box::new(authorizer), None)
    }

    /// A router that records `NeedsApproval` decisions in `approvals` and returns their id.
    pub fn with_approvals(authorizer: impl Authorizer, approvals: impl Approvals) -> Router {
        Router::build(Box::new(authorizer), Some(Box::new(approvals)))
    }

    fn build(authorizer: Box<dyn DynAuthorizer>, approvals: Option<Box<dyn Approvals>>) -> Router {
        Router {
            guard: Arc::new(Guard {
                authorizer: Arc::from(authorizer),
                approvals: approvals.map(Arc::from),
                audit: Arc::new(Recorder::new()),
            }),
            procedures: Arc::default(),
        }
    }

    /// This router (same registry, authorizer and approvals) auditing to `audit` (see
    /// [`crate::audit`]). Clones made before keep their own audit settings, as for the other
    /// `with_` methods.
    #[must_use]
    pub fn with_audit(self, audit: impl AuditSink) -> Router {
        let recorder = self.guard.audit.with_sink(Arc::new(audit));
        self.with_recorder(recorder)
    }

    /// This router reporting audit sink failures to `reporter` instead of stderr.
    #[must_use]
    pub fn with_audit_reporter(self, reporter: impl AuditReporter) -> Router {
        let recorder = self.guard.audit.with_reporter(Arc::new(reporter));
        self.with_recorder(recorder)
    }

    /// This router auditing under `policy` (human Read calls, write timeout).
    #[must_use]
    pub fn with_audit_policy(self, policy: AuditPolicy) -> Router {
        let recorder = self.guard.audit.with_policy(policy);
        self.with_recorder(recorder)
    }

    fn with_recorder(self, recorder: Recorder) -> Router {
        Router {
            guard: Arc::new(Guard {
                authorizer: Arc::clone(&self.guard.authorizer),
                approvals: self.guard.approvals.clone(),
                audit: Arc::new(recorder),
            }),
            procedures: self.procedures,
        }
    }

    /// Registers every procedure of `api`. All or nothing: on a duplicate name nothing is added.
    pub fn mount<A: Api>(&self, api: A) -> Result<(), RegistryError> {
        let procs = Arc::new(api).procedures();
        let mut map = self.write();
        let mut seen = std::collections::HashSet::new();
        for p in &procs {
            validate(&p.meta)?;
            validate_run(p)?;
            if map.contains_key(&p.meta.name) || !seen.insert(p.meta.name.as_str()) {
                return Err(RegistryError::Duplicate(p.meta.name.clone()));
            }
        }
        for p in procs {
            map.insert(p.meta.name.clone(), p);
        }
        Ok(())
    }

    /// Registers one procedure, e.g. a plugin operation `plugin.<plugin-id>.<op>` when the plugin
    /// is enabled.
    pub fn insert(&self, procedure: Procedure) -> Result<(), RegistryError> {
        validate(&procedure.meta)?;
        validate_run(&procedure)?;
        match self.write().entry(procedure.meta.name.clone()) {
            Entry::Occupied(e) => Err(RegistryError::Duplicate(e.key().clone())),
            Entry::Vacant(e) => {
                e.insert(procedure);
                Ok(())
            }
        }
    }

    /// Unregisters a procedure, e.g. when its plugin is disabled. Calls already running finish.
    pub fn remove(&self, name: &str) -> Option<Procedure> {
        self.write().remove(name)
    }

    pub fn get(&self, name: &str) -> Option<Arc<ProcedureMeta>> {
        self.read().get(name).map(|p| Arc::clone(&p.meta))
    }

    /// Metadata of every registered procedure, sorted by name.
    pub fn procedures(&self) -> Vec<Arc<ProcedureMeta>> {
        self.sorted(|p| Arc::clone(&p.meta))
    }

    /// Every registered procedure, sorted by name: what codegen exports.
    pub fn entries(&self) -> Vec<Procedure> {
        self.sorted(Procedure::clone)
    }

    /// One snapshot of the registry, sorted by name, taking only what `f` keeps.
    fn sorted<T>(&self, f: impl Fn(&Procedure) -> T) -> Vec<T> {
        let procedures = self.read();
        let mut all: Vec<&Procedure> = procedures.values().collect();
        all.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
        all.into_iter().map(f).collect()
    }

    /// Runs one call for `session`. This is [`Dispatch::call`]; the MCP adapter calls it directly
    /// with an agent session.
    ///
    /// Whatever a handler returns, an `Internal` error leaves without its message and details, and
    /// an `ApprovalRequired` error without details gets the id recorded by [`Ctx::authorize`].
    ///
    /// The call uses the scope the engine set for it ([`CallScope::current`]), or a scope of its
    /// own from the call's `timeout_ms`, with a correlation id from the shared generator: outside
    /// the engine, and for a call a handler makes to another procedure (a child of the calling
    /// handler's scope: cancelled with it, and its deadline is never later than the caller's). Each call therefore
    /// has its own audit entries. Either way a call whose deadline has passed or whose token fired is refused
    /// before authorization and again before the handler runs; outside the engine, interrupting
    /// a running handler is the caller's job, and the router writes the call's audit completion
    /// itself when the handler returns.
    pub fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> impl Future<Output = Result<Value, ErrorPayload>> + Send + 'static {
        let procedure = self.read().get(&call.procedure).cloned();
        let guard = Arc::clone(&self.guard);
        async move {
            let scope = CallScope::for_call(call.timeout());
            // Entered, so a call the handler makes in turn gets a scope of its own (see
            // `CallScope::for_call`).
            let result = scope
                .clone()
                .enter(async {
                    let (run, ctx) = admit(guard, procedure, session, &call, false, &scope).await?;
                    match run {
                        Run::Unary(handler) => {
                            let approval_id = Arc::clone(&ctx.approval_id);
                            let result = handler(ctx, call.input).await;
                            result.map_err(|err| scrub(err, &approval_id))
                        }
                        _ => Err(ErrorPayload::new(
                            Code::Unimplemented,
                            "this call kind is not supported yet",
                        )),
                    }
                })
                .await;
            ended(&scope, &result).await;
            with_correlation_id(&scope, result)
        }
    }

    /// Runs one subscription for `session`, sending its events to `events`. This is
    /// [`Dispatch::subscribe`]; every step before the handler is the one [`Router::call`] takes.
    pub fn subscribe(
        &self,
        session: Arc<Session>,
        call: Call,
        events: Events,
    ) -> impl Future<Output = Result<(), ErrorPayload>> + Send + 'static {
        let procedure = self.read().get(&call.procedure).cloned();
        let guard = Arc::clone(&self.guard);
        async move {
            let scope = CallScope::for_call(call.timeout());
            // Entered, so a call the handler makes in turn gets a scope of its own (see
            // `CallScope::for_call`).
            let result = scope
                .clone()
                .enter(async {
                    let (run, ctx) = admit(guard, procedure, session, &call, true, &scope).await?;
                    match run {
                        Run::Subscription(handler) => {
                            let approval_id = Arc::clone(&ctx.approval_id);
                            let result = handler(ctx, call.input, events).await;
                            result.map_err(|err| scrub(err, &approval_id))
                        }
                        _ => Err(ErrorPayload::new(
                            Code::Unimplemented,
                            "this call kind is not supported yet",
                        )),
                    }
                })
                .await;
            ended(&scope, &result).await;
            with_correlation_id(&scope, result)
        }
    }

    fn read(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, Procedure>> {
        // A panic while holding the lock cannot leave the map half-updated (every write is a
        // single insert or remove), so a poisoned lock is safe to keep using.
        self.procedures.read().unwrap_or_else(|e| e.into_inner())
    }

    fn write(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, Procedure>> {
        self.procedures.write().unwrap_or_else(|e| e.into_inner())
    }
}

impl fmt::Debug for Router {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let names: Vec<_> = self.procedures().iter().map(|m| m.name.clone()).collect();
        f.debug_struct("Router")
            .field("procedures", &names)
            .finish()
    }
}

impl Dispatch for Router {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        Box::pin(Router::call(self, session, call))
    }

    fn subscribe(
        &self,
        session: Arc<Session>,
        call: Call,
        events: Events,
    ) -> BoxFuture<'static, Result<(), ErrorPayload>> {
        Box::pin(Router::subscribe(self, session, call, events))
    }
}

/// Every error the router returns carries the call's correlation id, so a caller outside the
/// engine (which fills ids in itself) can find the call's audit entries.
fn with_correlation_id<T>(
    scope: &CallScope,
    mut result: Result<T, ErrorPayload>,
) -> Result<T, ErrorPayload> {
    if let Err(err) = &mut result
        && err.correlation_id.is_empty()
    {
        err.correlation_id = scope.correlation_id().to_owned();
    }
    result
}

/// Records what the call returned (the handler's result, or the error it ended with before its
/// handler ran) in its audit completion, if it was admitted. Outside the engine the router then
/// writes the completion, as delivered; inside, the engine writes it once it chose the answer.
async fn ended<T>(scope: &CallScope, result: &Result<T, ErrorPayload>) {
    scope.update_completion(|c| c.record_outcome(outcome_of(result)));
    if !scope.is_managed()
        && let Some(completion) = scope.take_completion()
    {
        completion
            .finish(security_types::Delivery::Delivered, Code::Cancelled)
            .await;
    }
}

/// Every step before a handler runs, shared by calls and subscriptions: lookup and agent
/// exposure, call kind, the procedure's timeouts, authorization, the audit admission. Returns
/// what to run and its context.
async fn admit(
    guard: Arc<Guard>,
    procedure: Option<Procedure>,
    session: Arc<Session>,
    call: &Call,
    subscribe: bool,
    scope: &CallScope,
) -> Result<(Run, Ctx), ErrorPayload> {
    // Outside the engine without OS randomness: no correlation id, so nothing could be audited.
    if scope.correlation_id().is_empty() {
        return Err(ErrorPayload::new(Code::Internal, "internal error"));
    }
    // To an agent, a hidden procedure is indistinguishable from a missing one.
    let procedure =
        procedure.filter(|p| p.meta.agent == Agent::Exposed || !acts_as_agent(&session.principal));
    let Some(procedure) = procedure else {
        return Err(ErrorPayload::new(Code::NotFound, "unknown procedure"));
    };
    let meta = procedure.meta;
    if subscribe != (meta.kind == ProcedureKind::Subscription) {
        let message = if subscribe {
            "only subscriptions are started with Subscribe"
        } else {
            "subscriptions are started with Subscribe"
        };
        return Err(ErrorPayload::new(Code::InvalidArgument, message));
    }
    scope.apply_timeouts(meta.timeout_default, meta.timeout_max);
    // Nothing runs for a call that is already over: not the authorizer (which may record an
    // approval request), not the handler.
    if scope.check().is_some() {
        return Err(scope.error());
    }
    let digest = input_digest(&call.input);
    let check = Check {
        principal: &session.principal,
        meta: &meta,
        target: None,
        risk: meta.risk,
        input_digest: digest,
        correlation_id: scope.correlation_id(),
        parent_correlation_id: scope.parent_correlation_id(),
    };
    guard
        .enforce(&check)
        .await
        .map_err(Rejected::into_error_payload)?;
    if scope.check().is_some() {
        return Err(scope.error());
    }
    // The admission entry is written before anything runs; a call that must be recorded and was
    // not does not run.
    let completion = guard
        .audit
        .admit(&Admission::from(&check), scope)
        .await
        .map_err(|()| unavailable())?;
    if let Some(completion) = completion {
        scope.set_completion(completion);
    }
    // The write may have taken until the deadline. The completion then records this error.
    if scope.check().is_some() {
        return Err(scope.error());
    }
    let ctx = Ctx {
        session,
        meta,
        guard,
        input_digest: digest,
        scope: scope.clone(),
        approval_id: Arc::new(Mutex::new(None)),
    };
    Ok((procedure.run, ctx))
}

/// What a handler's error looks like on the wire: an `Internal` error leaves without its message
/// and details, and an `ApprovalRequired` error without details gets the id recorded by
/// [`Ctx::authorize`].
fn scrub(err: ErrorPayload, approval_id: &Mutex<Option<String>>) -> ErrorPayload {
    match err.code {
        Code::Internal => {
            let mut scrubbed = ErrorPayload::new(Code::Internal, "internal error");
            scrubbed.correlation_id = err.correlation_id;
            scrubbed
        }
        Code::ApprovalRequired if err.details.is_none() => {
            let mut err = err;
            err.details = lock(approval_id).take().map(|approval_id| {
                serde_json::to_value(ApprovalRequired { approval_id })
                    .expect("ApprovalRequired serializes")
            });
            err
        }
        _ => err,
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Same grammar as `#[rpc::router]`: at least two `.`-separated segments of `[A-Za-z0-9_-]`.
fn validate(meta: &ProcedureMeta) -> Result<(), RegistryError> {
    let segment_ok = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    };
    let valid_name = meta.name.split('.').count() >= 2 && meta.name.split('.').all(segment_ok);
    if !valid_name {
        return Err(RegistryError::InvalidName(meta.name.clone()));
    }
    if !is_valid_perm(meta.perm.as_str()) {
        return Err(RegistryError::InvalidPermission(meta.name.clone()));
    }
    // Calls keep a default deadline and a cap; subscriptions have no default (spec Open question
    // 24f) and may declare a cap.
    let timeouts_ok = match meta.kind {
        ProcedureKind::Subscription => meta.timeout_default.is_none(),
        ProcedureKind::Query | ProcedureKind::Mutation | ProcedureKind::Stream => {
            meta.timeout_default.is_some() && meta.timeout_max.is_some()
        }
    };
    if !timeouts_ok {
        return Err(RegistryError::InvalidTimeouts(meta.name.clone()));
    }
    Ok(())
}

/// A unary handler serves a query or mutation, a subscription handler a subscription.
fn validate_run(procedure: &Procedure) -> Result<(), RegistryError> {
    let kind = procedure.meta.kind;
    let ok = match procedure.run {
        Run::Unary(_) => matches!(kind, ProcedureKind::Query | ProcedureKind::Mutation),
        Run::Subscription(_) => kind == ProcedureKind::Subscription,
        Run::Declared => true,
    };
    if ok {
        Ok(())
    } else {
        Err(RegistryError::KindMismatch(procedure.meta.name.clone()))
    }
}

/// SHA-256 over the canonical JSON encoding of `input`: object keys sorted by byte order, no
/// whitespace, strings and numbers as serde_json writes them. Independent of serde_json's
/// `preserve_order` feature, so the same input always yields the same digest.
pub fn input_digest(input: &Value) -> Digest {
    let mut buf = Vec::new();
    write_canonical(input, &mut buf);
    Digest(sha2::Sha256::digest(&buf).into())
}

/// Canonical JSON, shared by [`input_digest`] and the schema hash (`codegen::manifest`).
pub(crate) fn write_canonical(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push(b'{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                serde_json::to_writer(&mut *out, key).expect("writing to a Vec cannot fail");
                out.push(b':');
                write_canonical(item, out);
            }
            out.push(b'}');
        }
        scalar => serde_json::to_writer(&mut *out, scalar).expect("writing to a Vec cannot fail"),
    }
}

/// Support code for `#[rpc::router]`. Not a stable API.
#[doc(hidden)]
pub mod __private {
    use super::*;

    pub use serde_json::Value;

    pub fn decode_input<I: DeserializeOwned>(input: Value) -> Result<I, ErrorPayload> {
        // serde's message can quote input values, so it is not sent to the client.
        serde_json::from_value(input)
            .map_err(|_| ErrorPayload::new(Code::InvalidArgument, "invalid input"))
    }

    pub fn encode_output<O: Serialize, E: IntoErrorPayload>(
        result: Result<O, E>,
    ) -> Result<Value, ErrorPayload> {
        match result {
            Ok(out) => serde_json::to_value(out)
                .map_err(|_| ErrorPayload::new(Code::Internal, "internal error")),
            Err(err) => Err(err.into_error_payload()),
        }
    }

    pub fn handler<A, F>(api: &Arc<A>, f: F) -> Handler
    where
        A: Send + Sync + 'static,
        F: Fn(Arc<A>, Ctx, Value) -> BoxFuture<'static, Result<Value, ErrorPayload>>
            + Send
            + Sync
            + 'static,
    {
        let api = Arc::clone(api);
        Arc::new(move |ctx, input| f(Arc::clone(&api), ctx, input))
    }

    /// The normal end (`Ok(())`) or the error a subscription handler ended with.
    pub fn encode_end<E: IntoErrorPayload>(result: Result<(), E>) -> Result<(), ErrorPayload> {
        result.map_err(IntoErrorPayload::into_error_payload)
    }

    pub fn subscription_handler<A, F>(api: &Arc<A>, f: F) -> SubscriptionHandler
    where
        A: Send + Sync + 'static,
        F: Fn(Arc<A>, Ctx, Value, Events) -> BoxFuture<'static, Result<(), ErrorPayload>>
            + Send
            + Sync
            + 'static,
    {
        let api = Arc::clone(api);
        Arc::new(move |ctx, input, events| f(Arc::clone(&api), ctx, input, events))
    }
}
