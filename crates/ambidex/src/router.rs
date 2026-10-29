//! Procedure registry and router (Ambidex spec §1, §2, §8, §11).
//!
//! A [`Router`] holds every procedure a server exposes: static ones mounted from
//! `#[rpc::router]` impls, and dynamic ones (plugin operations) inserted and removed at runtime.
//! It implements [`Dispatch`], so the engine hands it every decoded call. For each call it:
//!
//! 1. looks the procedure up (`NotFound` otherwise);
//! 2. answers `NotFound` to agent principals for procedures not marked `agent = Agent::Exposed`;
//! 3. asks the [`Authorizer`] with the procedure's action, baseline risk and the input digest,
//!    and runs the handler only on [`Decision::Allow`]. There is no default authorizer: a router
//!    cannot be built without one, and the authorizer denies unknown permissions (default-deny);
//! 4. decodes the input, runs the handler and encodes its result or typed error.
//!
//! Right after the lookup it applies the procedure's `timeout_default`/`timeout_max` to the call's
//! [`CallScope`], so the deadline covers authorization too. Handlers observe cancellation through
//! [`Ctx::cancelled`] and pass [`Ctx::cancellation_token`] on (e.g. to the Plugin Host driver call).
//!
//! Handlers re-check targets and escalated risk with [`Ctx::authorize`].

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::fmt;
use std::future::Future;
use std::sync::{Arc, Mutex, RwLock};

use security_types::{
    ApprovalSpec, Authorizer, AuthzRequest, Decision, Digest, Principal, PrincipalKind, Risk,
    TargetRef,
};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::Digest as _;

use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use crate::cancel::CallScope;
use crate::codegen::ProcedureTypes;
use crate::engine::{BoxFuture, Dispatch, Session};
use crate::error::{IntoErrorPayload, RpcError};
use crate::message::{Call, Code, ErrorPayload};
use crate::procedure::{Agent, ProcedureMeta, is_valid_perm};

/// Type-erased handler: decoded call context and JSON input in, JSON result or wire error out.
pub type Handler =
    Arc<dyn Fn(Ctx, Value) -> BoxFuture<'static, Result<Value, ErrorPayload>> + Send + Sync>;

/// One registry entry.
#[derive(Clone)]
pub struct Procedure {
    meta: Arc<ProcedureMeta>,
    handler: Option<Handler>,
    types: Option<ProcedureTypes>,
}

impl Procedure {
    /// A query or mutation with its handler.
    pub fn new(meta: ProcedureMeta, handler: Handler) -> Procedure {
        Procedure {
            meta: Arc::new(meta),
            handler: Some(handler),
            types: None,
        }
    }

    /// A procedure whose call kind the engine cannot run yet (subscriptions and streams). It is
    /// listed and authorized like any other, then answered with `Unimplemented`.
    pub fn declared(meta: ProcedureMeta) -> Procedure {
        Procedure {
            meta: Arc::new(meta),
            handler: None,
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
        f.debug_struct("Procedure")
            .field("meta", &self.meta)
            .field("handler", &self.handler.is_some())
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
}

impl fmt::Display for RegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RegistryError::Duplicate(name) => write!(f, "procedure {name} is already registered"),
            RegistryError::InvalidName(name) => write!(f, "invalid procedure name {name:?}"),
            RegistryError::InvalidPermission(name) => {
                write!(f, "procedure {name} has an invalid permission")
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

/// Authorizer plus approval queue, shared by the router and every [`Ctx`].
struct Guard {
    authorizer: Box<dyn DynAuthorizer>,
    approvals: Option<Box<dyn Approvals>>,
}

impl Guard {
    /// Asks the authorizer and maps anything but `Allow` to the error the caller sees.
    async fn enforce(
        &self,
        principal: &Principal,
        meta: &ProcedureMeta,
        target: Option<&TargetRef>,
        risk: Risk,
        input_digest: Digest,
    ) -> Result<(), Rejected> {
        let action = meta.action();
        let req = AuthzRequest {
            principal,
            action: &action,
            target,
            risk,
            input_digest,
        };
        match self.authorizer.check(&req).await {
            Decision::Allow => Ok(()),
            // The reason stays on the server: the client learns only that it was denied.
            Decision::Deny { .. } => Err(Rejected {
                code: Code::PermissionDenied,
                approval_id: None,
            }),
            Decision::NeedsApproval { approval } => {
                let approval_id = match &self.approvals {
                    Some(approvals) => approvals.request(principal, &approval).await,
                    None => None,
                };
                Err(Rejected {
                    code: Code::ApprovalRequired,
                    approval_id,
                })
            }
        }
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
/// recorded approval request when there is an approval queue.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    pub code: Code,
    pub approval_id: Option<String>,
}

impl fmt::Display for Rejected {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.code {
            Code::ApprovalRequired => f.write_str("approval required"),
            _ => f.write_str("permission denied"),
        }
    }
}

impl std::error::Error for Rejected {}

impl IntoErrorPayload for Rejected {
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

    /// When the server cancels the call with `DeadlineExceeded`.
    pub fn deadline(&self) -> Instant {
        self.scope.deadline()
    }

    /// Authorizes this call again for a concrete `target` and the risk the handler determined at
    /// runtime (e.g. SQL classified as DDL). Risk only escalates from the procedure's baseline.
    pub async fn authorize(&self, target: Option<&TargetRef>, risk: Risk) -> Result<(), Rejected> {
        let risk = self.meta.risk.escalate(risk);
        let result = self
            .guard
            .enforce(
                self.principal(),
                &self.meta,
                target,
                risk,
                self.input_digest,
            )
            .await;
        if let Err(Rejected {
            approval_id: Some(id),
            ..
        }) = &result
        {
            *lock(&self.approval_id) = Some(id.clone());
        }
        result
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
                authorizer,
                approvals,
            }),
            procedures: Arc::default(),
        }
    }

    /// Registers every procedure of `api`. All or nothing: on a duplicate name nothing is added.
    pub fn mount<A: Api>(&self, api: A) -> Result<(), RegistryError> {
        let procs = Arc::new(api).procedures();
        let mut map = self.write();
        let mut seen = std::collections::HashSet::new();
        for p in &procs {
            validate(&p.meta)?;
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
        self.entries().iter().map(|p| Arc::clone(&p.meta)).collect()
    }

    /// Every registered procedure, sorted by name: what codegen exports.
    pub fn entries(&self) -> Vec<Procedure> {
        let mut all: Vec<_> = self.read().values().cloned().collect();
        all.sort_by(|a, b| a.meta.name.cmp(&b.meta.name));
        all
    }

    /// Runs one call for `session`. This is [`Dispatch::call`]; the MCP adapter calls it directly
    /// with an agent session.
    ///
    /// Whatever a handler returns, an `Internal` error leaves without its message and details, and
    /// an `ApprovalRequired` error without details gets the id recorded by [`Ctx::authorize`].
    ///
    /// The call uses [`CallScope::current`] (set by the engine), or a fresh scope from the call's
    /// `timeout_ms` when called outside the engine. Either way a call whose deadline has passed or
    /// whose token fired is refused before authorization and again before the handler runs;
    /// outside the engine, interrupting a running handler is the caller's job.
    pub fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> impl Future<Output = Result<Value, ErrorPayload>> + Send + 'static {
        let procedure = self.read().get(&call.procedure).cloned();
        let guard = Arc::clone(&self.guard);
        async move {
            let scope = CallScope::current().unwrap_or_else(|| CallScope::new(call.timeout()));
            // To an agent, a hidden procedure is indistinguishable from a missing one.
            let procedure = procedure
                .filter(|p| p.meta.agent == Agent::Exposed || !acts_as_agent(&session.principal));
            let Some(procedure) = procedure else {
                return Err(ErrorPayload::new(Code::NotFound, "unknown procedure"));
            };
            let meta = procedure.meta;
            scope.apply_timeouts(meta.timeout_default, meta.timeout_max);
            // Nothing runs for a call that is already over: not the authorizer (which may record
            // an approval request), not the handler.
            if scope.check().is_some() {
                return Err(scope.error());
            }
            let digest = input_digest(&call.input);
            guard
                .enforce(&session.principal, &meta, None, meta.risk, digest)
                .await
                .map_err(Rejected::into_error_payload)?;
            let Some(handler) = procedure.handler else {
                return Err(ErrorPayload::new(
                    Code::Unimplemented,
                    "this call kind is not supported yet",
                ));
            };
            if scope.check().is_some() {
                return Err(scope.error());
            }
            let approval_id = Arc::new(Mutex::new(None));
            let ctx = Ctx {
                session,
                meta,
                guard,
                input_digest: digest,
                scope,
                approval_id: Arc::clone(&approval_id),
            };
            handler(ctx, call.input)
                .await
                .map_err(|err| match err.code {
                    Code::Internal => {
                        let mut scrubbed = ErrorPayload::new(Code::Internal, "internal error");
                        scrubbed.correlation_id = err.correlation_id;
                        scrubbed
                    }
                    Code::ApprovalRequired if err.details.is_none() => {
                        let mut err = err;
                        err.details = lock(&approval_id).take().map(|approval_id| {
                            serde_json::to_value(ApprovalRequired { approval_id })
                                .expect("ApprovalRequired serializes")
                        });
                        err
                    }
                    _ => err,
                })
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
    Ok(())
}

/// Whether an agent is anywhere in the principal's `on_behalf_of` chain.
fn acts_as_agent(principal: &Principal) -> bool {
    principal.chain().any(|p| p.kind == PrincipalKind::Agent)
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
}
