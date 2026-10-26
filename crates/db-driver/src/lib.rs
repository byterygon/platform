//! Database driver contract v0.1 shared by native drivers and WIT adapters.
//!
//! See the crate README for lifecycle rules and confirmed decisions.
//! No transport, authorization, secret storage or runtime is implemented here.

use std::{future::Future, pin::Pin};

/// Runtime-independent, object-safe asynchronous result.
pub type DbFuture<'a, T> = Pin<Box<dyn Future<Output = Result<T, DbError>> + Send + 'a>>;

/// Opaque caller-assigned ID, scoped to one logical connection; never reuse it.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OperationId(pub String);

/// Status of an idempotent cancellation request, separate from query outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CancelOutcome {
    /// Driver recorded the request and arranged backend propagation. Repeated
    /// pending requests return this too. The database may still finish normally.
    Requested,
    /// ID is unknown or already terminal on this connection; no action needed.
    NotRunning,
}

/// Structured database diagnostic. Position is a one-based Unicode scalar offset.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryError {
    pub message: String,
    pub position: Option<u64>,
    pub sqlstate: Option<String>,
    pub vendor_code: Option<String>,
}

/// Stable error categories shared with WIT. Messages must not contain secrets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DbError {
    PermissionDenied,
    AuthenticationFailed,
    TlsFailed,
    ConnectionLost,
    Cancelled,
    Timeout,
    InvalidQuery(QueryError),
    DatabaseError(QueryError),
    Unsupported(String),
    Internal,
}

impl std::fmt::Display for DbError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for DbError {}

/// Limits apply to execution, not authorization. A batch hint is advisory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ExecuteOptions {
    pub max_rows: Option<u64>,
    /// Relative milliseconds from execute admission, measured with a monotonic clock.
    pub deadline_ms: Option<u64>,
    /// Desired rows per batch; None lets the driver choose, zero is invalid.
    pub batch_size_hint: Option<u32>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QuerySummary {
    pub rows_affected: Option<u64>,
    pub rows_returned: Option<u64>,
    pub elapsed_ms: u64,
    pub notices: Vec<String>,
    /// True when max_rows cut the result short.
    pub truncated: bool,
}

/// Each chunk contains whole Arrow IPC stream messages, schema first.
/// After exactly one Finished on success, subsequent polls return None.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NextItem {
    Chunk(Vec<u8>),
    Finished(QuerySummary),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableInfo {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
}

/// Host-owned transport bound to the existing connection grant.
/// Partial sends are allowed; an empty receive means transport EOF.
pub trait Transport: Send + Sync {
    fn send<'a>(&'a self, bytes: &'a [u8]) -> DbFuture<'a, u32>;
    fn recv(&self, max_bytes: u32) -> DbFuture<'_, Vec<u8>>;
    /// Upgrade this same transport, retaining grant-bound certificate checks.
    fn start_tls<'a>(&'a self, server_name: &'a str) -> DbFuture<'a, ()>;
}

/// Bound host service; implementations retain instance/tenant/principal/grant
/// context. Cancellation opens use the same existing target grant and policy.
pub trait ConnectionBroker: Send + Sync {
    fn open<'a>(&'a self, target_id: &'a str, purpose: &'a str)
    -> DbFuture<'a, Box<dyn Transport>>;
}

/// Pull-based stream: poll only with downstream credit; never buffer all rows.
/// Cancel requests backend cancellation, but completion may win the race.
/// Drop must arrange cancellation/drain without requiring an async destructor.
pub trait ResultStream: Send {
    fn next(&mut self) -> DbFuture<'_, Option<NextItem>>;
    fn cancel(&self) -> DbFuture<'_, CancelOutcome>;
}

/// Logical connection, already bound to its broker authorization context.
/// A stream must retain the connection resources it needs after execute returns.
pub trait Connection: Send + Sync {
    fn execute<'a>(
        &'a self,
        operation_id: &'a OperationId,
        sql: &'a str,
        opts: ExecuteOptions,
    ) -> DbFuture<'a, Box<dyn ResultStream>>;
    /// Idempotent request. Requested acknowledges driver state, not backend termination.
    /// Unknown/already terminal IDs return NotRunning. Failures return DbError.
    fn cancel<'a>(&'a self, operation_id: &'a OperationId) -> DbFuture<'a, CancelOutcome>;
    fn schemas(&self) -> DbFuture<'_, Vec<String>>;
    fn tables<'a>(&'a self, schema: Option<&'a str>) -> DbFuture<'a, Vec<TableInfo>>;
    fn columns<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
    ) -> DbFuture<'a, Vec<ColumnInfo>>;
}

/// Object-safe erased facade for native driver registries.
/// Credentials remain opaque references; all networking goes through broker.
pub trait Driver: Send + Sync {
    fn connect<'a>(
        &'a self,
        broker: &'a dyn ConnectionBroker,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, Box<dyn Connection>>;
}
