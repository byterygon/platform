//! Wire types of the DBee API (DBee spec §5 and §8).
//!
//! Every input and output derives `TS` and `JsonSchema` so `dbee-rpc-gen` exports it; field
//! names are camelCase on the wire. Inputs mark `#[serde(default)]` fields `#[ts(optional =
//! nullable)]` so a client may omit them (Ambidex codegen rules). Credentials travel only in
//! [`CreateConnectionInput::secret`] and [`SetSecretInput::password`]; the procedures do not opt
//! into `log_input`, and no output type has a field for them.

use ambidex::{Code, DomainError};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The empty object, `{}`: the input of procedures that take nothing and the output of those
/// that return nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Empty {}

/// Which shell runs the core.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    /// The Tauri desktop app: one local human, no network listener.
    Standalone,
    /// The self-hosted web server.
    Server,
}

/// Where passwords go (DBee spec §4, Open question 2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum SecretStoreKind {
    /// The OS keychain: passwords persist across restarts.
    Keychain,
    /// No keychain is available: passwords are asked per session, kept in core memory only and
    /// zeroized when the session ends. Nothing is persisted.
    SessionOnly,
}

/// A database driver compiled into the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DriverInfo {
    /// Plugin id, e.g. `com.byterygon.dbee.postgres`.
    pub id: String,
    /// Human name, e.g. `PostgreSQL`.
    pub name: String,
    pub version: String,
    /// `sha256:<hex>` of the driver as the grant binds it.
    pub digest: String,
    pub first_party: bool,
}

/// Output of `app.info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Version of the core.
    pub version: String,
    /// The API version written into the generated client.
    pub api_version: String,
    /// The schema hash the server announces; equals `SCHEMA_HASH` of the generated client.
    pub schema_hash: String,
    pub mode: AppMode,
    /// The operating system, e.g. `linux`.
    pub platform: String,
    pub drivers: Vec<DriverInfo>,
    pub secret_store: SecretStoreKind,
    /// Why the keychain is not used, when it is not. Display-safe.
    pub secret_store_note: Option<String>,
    /// Where the workspace lives (connections, settings, tabs, audit log). Read-only in Settings.
    pub workspace_path: String,
    pub audit_log_path: String,
}

/// Output of `app.getWorkspace`: the UI's documents of the workspace (`settings.json`,
/// `tabs.json`) and their revision. The core stores the documents whole and never interprets
/// them; their layout and its version are the UI's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocuments {
    /// `null` until the UI first writes it.
    pub settings: serde_json::Value,
    /// `null` until the UI first writes it.
    pub tabs: serde_json::Value,
    /// Changes with every write; opaque. Pass it back as `baseRevision`.
    pub revision: String,
}

/// Input of `app.setWorkspace`. A document left out (or `null`) is not changed; a document given
/// must be a JSON object of at most [`MAX_WORKSPACE_DOCUMENT_BYTES`] serialized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tabs: Option<serde_json::Value>,
    /// The revision the client last read or wrote; a different current revision is a
    /// `Conflict` and nothing is written.
    pub base_revision: String,
}

/// Largest document `app.setWorkspace` accepts, serialized (4 MiB, a quarter of the frame limit).
pub const MAX_WORKSPACE_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;

/// Output of `app.setWorkspace`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetWorkspaceOutput {
    pub revision: String,
}

/// Typed errors of `app.setWorkspace`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum WorkspaceSaveError {
    /// The documents changed since `baseRevision` (another window wrote them); nothing was
    /// written. `revision` is the current one.
    Conflict { revision: String },
    /// `document` (`settings` or `tabs`) is not a JSON object or is too large.
    InvalidDocument { document: String, message: String },
    /// A workspace file could not be written; nothing changed. (Not `Internal`: the router
    /// scrubs those, and the UI shows this message.)
    WriteFailed { message: String },
}

impl DomainError for WorkspaceSaveError {
    fn code(&self) -> Code {
        match self {
            WorkspaceSaveError::Conflict { .. } => Code::FailedPrecondition,
            WorkspaceSaveError::InvalidDocument { .. } => Code::InvalidArgument,
            WorkspaceSaveError::WriteFailed { .. } => Code::FailedPrecondition,
        }
    }

    fn message(&self) -> String {
        match self {
            WorkspaceSaveError::Conflict { .. } => {
                "the workspace changed since it was read; read it again".into()
            }
            WorkspaceSaveError::InvalidDocument { document, message } => {
                format!("{document}: {message}")
            }
            WorkspaceSaveError::WriteFailed { message } => message.clone(),
        }
    }
}

/// Status of a connection as the tree shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
    Expired,
}

/// One event of `app.events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AppEvent {
    ConnectionStatus {
        connection_id: String,
        status: ConnectionStatus,
    },
    /// The grant ends soon (15 minutes before, DBee spec Decision 9).
    GrantExpiring {
        connection_id: String,
        expires_at: u64,
    },
    GrantExpired {
        connection_id: String,
        expired_at: u64,
    },
    /// A database session ended for a reason other than `sessions.close`.
    SessionEnded { session_id: String, reason: String },
}

/// Transport security of a connection, as the list shows it (DBee spec §3.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum TlsKind {
    /// TLS required, verified against the deployment CA bundle.
    DeploymentCa,
    /// TLS required, verified against a pinned CA certificate.
    PinnedCa,
    /// TLS required, the server must present exactly the pinned certificate.
    PinnedCert,
    /// Plaintext. Offered only because the first-party template says `tls = "optional"`.
    Plaintext,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum GrantState {
    Active,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrantSummary {
    pub id: String,
    pub state: GrantState,
    /// Unix milliseconds; `null` for a grant that does not expire.
    pub expires_at: Option<u64>,
    pub created_at: u64,
}

/// One connection as `connections.list` returns it. Never a credential or its reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub colour: Option<String>,
    pub driver: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub tls: TlsKind,
    /// Whether a password is available for this connection (in the keychain, or for this
    /// session only).
    pub has_secret: bool,
    pub allow_cancel_connection: bool,
    pub status: ConnectionStatus,
    pub grant: GrantSummary,
}

/// TLS policy as the form submits it (DBee spec §3.3). The server name defaults to the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TlsDraft {
    DeploymentCa {
        #[serde(default)]
        #[ts(optional = nullable)]
        server_name: Option<String>,
    },
    PinnedCa {
        /// One or more CA certificates, PEM.
        ca_pem: String,
        #[serde(default)]
        #[ts(optional = nullable)]
        server_name: Option<String>,
    },
    PinnedCert {
        /// SHA-256 of the server certificate's DER encoding, as `sha256:<hex>`, with or without
        /// colons, as the DBA gives it.
        fingerprint: String,
        #[serde(default)]
        #[ts(optional = nullable)]
        server_name: Option<String>,
    },
    Plaintext,
}

fn default_port() -> u16 {
    5432
}

fn default_true() -> bool {
    true
}

/// What the connection form submits to `connections.prepare` and `connections.create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionDraft {
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub colour: Option<String>,
    /// A host name or IP literal, matched exactly in the grant.
    pub host: String,
    #[serde(default = "default_port")]
    #[ts(optional = nullable)]
    pub port: u16,
    pub database: String,
    pub user: String,
    pub tls: TlsDraft,
    /// Networks (CIDR) the connection may reach. `null` proposes the addresses resolved right
    /// now (loopback for `localhost`); a list replaces the proposal (the user widened it).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub allowed_addresses: Option<Vec<String>>,
    #[serde(default = "default_true")]
    #[ts(optional = nullable)]
    pub allow_cancel_connection: bool,
    /// Unix milliseconds; `null` for a personal connection that does not expire.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub expires_at: Option<u64>,
    /// Whether a password is bound to the connection: supplied with `connections.create`, or
    /// kept from the connection being replaced.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub has_secret: bool,
}

/// TLS policy as the approval dialog states it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TlsPreview {
    pub kind: TlsKind,
    /// The name (or IP) the certificate must match; `null` for plaintext.
    pub server_name: Option<String>,
    /// What is pinned: `sha256:<hex>` of each pinned CA or server certificate.
    pub pinned: Vec<String>,
}

/// What an approver sees before `connections.create` (Plugin Host spec §3, DBee spec §3.4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GrantPreview {
    pub driver: DriverInfo,
    /// The network template the grant binds, `db-transport`.
    pub template: String,
    pub host: String,
    pub port: u16,
    /// What the host resolved to right now.
    pub resolved_addresses: Vec<String>,
    /// The address policy the grant will carry (CIDR). Only these may be connected to.
    pub proposed_addresses: Vec<String>,
    pub tls: TlsPreview,
    pub allow_cancel_connection: bool,
    pub expires_at: Option<u64>,
    /// Whether a password will be stored in the secret store and released only to this
    /// connection.
    pub secret_binding: bool,
    /// Who approves: the principal of this session.
    pub approver: String,
    /// Binds `connections.create` to exactly this preview.
    pub preview_digest: String,
}

/// The credential, write-only. Its `Debug` output names the type only.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct SecretInput {
    pub password: String,
}

impl std::fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretInput { .. }")
    }
}

/// Input of `connections.create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionInput {
    pub draft: ConnectionDraft,
    /// From the `GrantPreview` the approver saw.
    pub preview_digest: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub secret: Option<SecretInput>,
    /// The connection this one replaces (a grant-covered edit or a renewal): its grant is
    /// revoked once the new one is active, and the connection keeps its id.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub replaces: Option<String>,
}

/// Input of `connections.update`: the fields a grant does not cover. Anything else is refused
/// with `InvalidArgument` (use prepare and create with `replaces`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateConnectionInput {
    pub id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// An empty string clears the description.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    /// An empty string clears the colour.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub colour: Option<String>,
}

/// Input of `connections.setSecret`. `null` removes the password.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetSecretInput {
    pub id: String,
    pub password: Option<String>,
}

impl std::fmt::Debug for SetSecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetSecretInput")
            .field("id", &self.id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SetSecretOutput {
    pub has_secret: bool,
}

/// Input of procedures that name one connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionId {
    pub id: String,
}

/// Typed errors of the `connections` procedures (DBee spec §5, §8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum ConnectionError {
    /// A field of the draft is invalid; `field` is its camelCase name.
    InvalidTarget {
        field: String,
        message: String,
    },
    /// The host did not resolve.
    ResolveFailed {
        message: String,
    },
    /// The preview no longer matches the draft (or the driver, or the resolved addresses);
    /// prepare again.
    PreviewStale,
    /// The keychain is unavailable; the connection can be created without saving the password.
    SecretStoreUnavailable {
        reason: String,
    },
    /// The Plugin Host refused the grant.
    GrantRefused {
        reason: String,
    },
    NotFound,
}

impl DomainError for ConnectionError {
    fn code(&self) -> Code {
        match self {
            ConnectionError::InvalidTarget { .. } => Code::InvalidArgument,
            ConnectionError::ResolveFailed { .. } => Code::FailedPrecondition,
            ConnectionError::PreviewStale => Code::FailedPrecondition,
            ConnectionError::SecretStoreUnavailable { .. } => Code::FailedPrecondition,
            ConnectionError::GrantRefused { .. } => Code::PermissionDenied,
            ConnectionError::NotFound => Code::NotFound,
        }
    }

    fn message(&self) -> String {
        match self {
            ConnectionError::InvalidTarget { field, message } => format!("{field}: {message}"),
            ConnectionError::ResolveFailed { message } => {
                format!("host did not resolve: {message}")
            }
            ConnectionError::PreviewStale => "the preview is stale; prepare again".into(),
            ConnectionError::SecretStoreUnavailable { reason } => {
                format!("the secret store is unavailable: {reason}")
            }
            ConnectionError::GrantRefused { reason } => format!("grant refused: {reason}"),
            ConnectionError::NotFound => "unknown connection".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SessionPurpose {
    /// A query tab's session: one per tab.
    Editor,
    /// The schema browser's session: one per connection, reused.
    Browser,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionInput {
    pub connection_id: String,
    pub purpose: SessionPurpose,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionOutput {
    pub session_id: String,
    /// The database's version string.
    pub server_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SessionId {
    pub session_id: String,
}

/// Why a grant refused the connection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum DeniedReason {
    Expired {
        expired_at: u64,
    },
    Revoked,
    /// The host resolved to an address outside the grant's address policy.
    AddressNotAllowed {
        address: String,
    },
    /// The broker refused the open; the audit log has the reason.
    Refused,
}

/// Typed errors of `sessions.*` and `schema.*` (DBee spec §8, mapping every `DbError`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum SessionError {
    AuthenticationFailed {
        user: String,
    },
    TlsFailed {
        policy: TlsKind,
    },
    PermissionDenied {
        reason: DeniedReason,
    },
    ConnectionLost,
    /// No answer from the host in time.
    Timeout {
        host: String,
        port: u16,
    },
    /// The connection has no password and the keychain holds none: ask the user and call
    /// `connections.setSecret` for this session.
    SecretMissing,
    /// The database reported an error.
    Database {
        message: String,
        sqlstate: Option<String>,
    },
    Unsupported {
        message: String,
    },
    NotFound,
}

impl DomainError for SessionError {
    fn code(&self) -> Code {
        match self {
            SessionError::AuthenticationFailed { .. } => Code::FailedPrecondition,
            SessionError::TlsFailed { .. } => Code::FailedPrecondition,
            SessionError::PermissionDenied { .. } => Code::PermissionDenied,
            SessionError::ConnectionLost => Code::Unavailable,
            SessionError::Timeout { .. } => Code::Unavailable,
            SessionError::SecretMissing => Code::FailedPrecondition,
            SessionError::Database { .. } => Code::FailedPrecondition,
            SessionError::Unsupported { .. } => Code::Unimplemented,
            SessionError::NotFound => Code::NotFound,
        }
    }

    fn message(&self) -> String {
        match self {
            SessionError::AuthenticationFailed { user } => {
                format!("authentication failed for user {user}")
            }
            SessionError::TlsFailed { .. } => {
                "TLS failed: the server certificate does not match the policy".into()
            }
            SessionError::PermissionDenied { reason } => match reason {
                DeniedReason::Expired { .. } => "access expired".into(),
                DeniedReason::Revoked => "access was revoked".into(),
                DeniedReason::AddressNotAllowed { address } => {
                    format!("{address} is not an allowed address")
                }
                DeniedReason::Refused => "the connection was refused".into(),
            },
            SessionError::ConnectionLost => "connection lost".into(),
            SessionError::Timeout { host, port } => format!("no answer from {host}:{port}"),
            SessionError::SecretMissing => "enter the password for this session".into(),
            SessionError::Database { message, .. } => message.clone(),
            SessionError::Unsupported { message } => message.clone(),
            SessionError::NotFound => "unknown session".into(),
        }
    }

    fn retryable(&self) -> bool {
        matches!(
            self,
            SessionError::ConnectionLost | SessionError::Timeout { .. }
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemasInput {
    pub connection_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TablesInput {
    pub connection_id: String,
    /// `null` lists what the session's search path makes visible.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schema: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ColumnsInput {
    pub connection_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schema: Option<String>,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub schema: Option<String>,
    pub name: String,
    /// The contract's kind string: `table`, `view`, `materialized view`, ...
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
    pub nullable: bool,
}

/// Risk of a statement, as the fail-closed classifier sees it (Ambidex spec §8).
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS, JsonSchema,
)]
pub enum SqlRisk {
    Read,
    Write,
    Destructive,
}

impl From<SqlRisk> for security_types::Risk {
    fn from(risk: SqlRisk) -> Self {
        match risk {
            SqlRisk::Read => security_types::Risk::Read,
            SqlRisk::Write => security_types::Risk::Write,
            SqlRisk::Destructive => security_types::Risk::Destructive,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ClassifyInput {
    pub sql: String,
}

/// Output of `query.classify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Classification {
    pub risk: SqlRisk,
    /// Statements in the text; the server runs one per call.
    pub statements: u32,
    /// The leading keyword(s) of the first statement, e.g. `SELECT`, `DROP TABLE`, or
    /// `unparseable`.
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteInput {
    pub session_id: String,
    pub sql: String,
    /// Rows per Arrow record batch (advisory).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub batch_rows: Option<u32>,
    /// Row limit for this run; `null` is unlimited (DBee spec Decision 13).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_rows: Option<u64>,
}

/// Final result of `query.execute` (Ambidex spec §13 shape).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSummary {
    pub rows_affected: Option<u64>,
    pub rows_returned: Option<u64>,
    pub elapsed_ms: u64,
    pub notices: Vec<String>,
    /// `max_rows` cut the result short.
    pub truncated: bool,
    /// The classifier's kind of the statement.
    pub statement_kind: String,
    pub risk: SqlRisk,
}

/// Typed errors of `query.execute` and `export.run` (DBee spec §5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum QueryError {
    /// The statement does not parse; `position` is a one-based character offset.
    Syntax {
        message: String,
        position: Option<u64>,
        sqlstate: Option<String>,
    },
    Database {
        message: String,
        sqlstate: Option<String>,
        vendor_code: Option<String>,
    },
    /// The database session is gone, or the statement could not be sent.
    Connection {
        message: String,
    },
    Cancelled,
    /// The grant ended while the statement ran; its outcome on the database is unknown.
    AccessEnded,
    Unsupported {
        message: String,
    },
    NotFound,
}

impl DomainError for QueryError {
    fn code(&self) -> Code {
        match self {
            QueryError::Syntax { .. } => Code::InvalidArgument,
            QueryError::Database { .. } => Code::FailedPrecondition,
            QueryError::Connection { .. } => Code::Unavailable,
            QueryError::Cancelled => Code::Cancelled,
            QueryError::AccessEnded => Code::PermissionDenied,
            QueryError::Unsupported { .. } => Code::Unimplemented,
            QueryError::NotFound => Code::NotFound,
        }
    }

    fn message(&self) -> String {
        match self {
            QueryError::Syntax { message, .. } | QueryError::Database { message, .. } => {
                message.clone()
            }
            QueryError::Connection { message } => message.clone(),
            QueryError::Cancelled => "cancelled".into(),
            QueryError::AccessEnded => {
                "access ended; the statement's outcome on the database is unknown".into()
            }
            QueryError::Unsupported { message } => message.clone(),
            QueryError::NotFound => "unknown session".into(),
        }
    }

    fn retryable(&self) -> bool {
        matches!(self, QueryError::Connection { .. })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Csv,
    Tsv,
    Jsonl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    Lf,
    Crlf,
}

fn default_delimiter() -> String {
    ",".into()
}

fn default_quote() -> String {
    "\"".into()
}

fn default_line_ending() -> LineEnding {
    LineEnding::Lf
}

/// Encoding options (DBee spec §3.8). `delimiter` and `quote` apply to CSV only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default = "default_true")]
    #[ts(optional = nullable)]
    pub header: bool,
    #[serde(default = "default_delimiter")]
    #[ts(optional = nullable)]
    pub delimiter: String,
    #[serde(default = "default_quote")]
    #[ts(optional = nullable)]
    pub quote: String,
    /// Text written for NULL (CSV and TSV); empty by default.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub null_text: String,
    #[serde(default = "default_line_ending")]
    #[ts(optional = nullable)]
    pub line_ending: LineEnding,
}

impl Default for ExportOptions {
    fn default() -> Self {
        ExportOptions {
            header: true,
            delimiter: default_delimiter(),
            quote: default_quote(),
            null_text: String::new(),
            line_ending: LineEnding::Lf,
        }
    }
}

/// Where the encoded bytes go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ExportDestination {
    /// Streamed to the client as chunks (a download on web).
    Client,
    /// Written by the core to the path behind a handle from `files.chooseSavePath`.
    File { handle: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportInput {
    pub session_id: String,
    pub sql: String,
    pub format: ExportFormat,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub options: ExportOptions,
    pub destination: ExportDestination,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_rows: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub rows: u64,
    pub bytes: u64,
    /// The file written, for the `file` destination.
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FileFilter {
    pub name: String,
    /// Extensions without the dot, e.g. `csv`.
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChooseSavePathInput {
    pub suggested_name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filters: Vec<FileFilter>,
}

/// A chosen save path: an opaque one-time handle the core resolves, and the name to show.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SavePath {
    pub handle: String,
    pub display_name: String,
}
