//! The 19 procedures of DBee spec §5, one `#[rpc::router]` per namespace.
//!
//! Every handler gets its state through [`CoreState`]. Permissions, risks, agent exposure and
//! timeouts are exactly the spec's table: queries and mutations keep the 30 s / 5 min defaults,
//! `query.execute` and `export.run` run 5 min by default and 1 h at most, `app.events` has no
//! deadline. `connections.list`, `schema.schemas`, `schema.tables` and `query.execute` are
//! `Exposed` for the MCP adapter of a later milestone; nothing publishes them here.

// RpcError<QueryError> carries three strings; boxing it would spread through every `?`.
#![allow(clippy::result_large_err)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use ambidex::arrow::ArrowSink;
use ambidex::{BinarySink, Code, Ctx, EventSink, RpcError, TargetRef, rpc};
use db_driver::{DbError, ExecuteOptions, NextItem};
use security_types::BoxFuture;

use crate::classify::classify;
use crate::export::{EncodeError, Encoder, IpcDecoder};
use crate::manager::{Manager, schema_error};
use crate::secrets::Secret;
use crate::types::*;
use crate::workspace::{SetDocumentsError, WorkspaceError};
use crate::{Failure, random_id};

/// Opens the native save dialog (desktop only; DBee spec §5 `files.chooseSavePath`).
pub trait SaveDialog: Send + Sync + 'static {
    /// `None` when the user cancelled.
    fn choose(
        &self,
        suggested_name: String,
        filters: Vec<FileFilter>,
    ) -> BoxFuture<'static, Option<PathBuf>>;
}

/// Everything the procedures share.
pub struct CoreState {
    pub manager: Arc<Manager>,
    pub mode: AppMode,
    pub save_dialog: Option<Arc<dyn SaveDialog>>,
    /// Paths chosen through `files.chooseSavePath`, by one-time handle.
    pub save_paths: Mutex<HashMap<String, PathBuf>>,
    pub workspace_path: String,
    pub audit_log_path: String,
}

impl CoreState {
    fn take_save_path(&self, handle: &str) -> Option<PathBuf> {
        self.save_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(handle)
    }
}

// ----------------------------------------------------------------------------------------------
// app
// ----------------------------------------------------------------------------------------------

pub struct AppApi(pub Arc<CoreState>);

#[rpc::router(namespace = "app")]
impl AppApi {
    /// About screen and feature gating.
    #[rpc::query(perm = "app.read", risk = Risk::Read)]
    async fn info(&self, _ctx: Ctx, _input: Empty) -> Result<AppInfo, RpcError> {
        let state = &self.0;
        let secrets = state.manager.secrets();
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            api_version: crate::API_VERSION.into(),
            schema_hash: crate::SCHEMA_HASH.clone(),
            mode: state.mode,
            platform: std::env::consts::OS.into(),
            drivers: vec![state.manager.driver().info.clone()],
            secret_store: secrets.kind(),
            secret_store_note: secrets.unavailable_reason.clone(),
            workspace_path: state.workspace_path.clone(),
            audit_log_path: state.audit_log_path.clone(),
        })
    }

    /// The UI's settings and query tabs from the workspace, with their revision.
    #[rpc::query(perm = "workspace.read", risk = Risk::Read, name = "getWorkspace")]
    async fn get_workspace(
        &self,
        _ctx: Ctx,
        _input: Empty,
    ) -> Result<WorkspaceDocuments, RpcError> {
        let docs = self.0.manager.workspace().ui_documents();
        Ok(WorkspaceDocuments {
            settings: docs.settings,
            tabs: docs.tabs,
            revision: docs.revision,
        })
    }

    /// Replaces the settings, the tabs or both if nothing wrote them since `baseRevision`. The
    /// audit entries carry the input digest only, never the documents (tab text is SQL).
    #[rpc::mutation(perm = "workspace.write", risk = Risk::Write, name = "setWorkspace")]
    async fn set_workspace(
        &self,
        _ctx: Ctx,
        input: SetWorkspaceInput,
    ) -> Result<SetWorkspaceOutput, RpcError<WorkspaceSaveError>> {
        for (name, document) in [("settings", &input.settings), ("tabs", &input.tabs)] {
            if let Some(document) = document {
                check_document(name, document)?;
            }
        }
        let written = self.0.manager.workspace().set_ui_documents(
            input.settings,
            input.tabs,
            &input.base_revision,
        );
        match written {
            Ok(revision) => Ok(SetWorkspaceOutput { revision }),
            Err(SetDocumentsError::Conflict { revision }) => {
                Err(WorkspaceSaveError::Conflict { revision }.into())
            }
            Err(SetDocumentsError::Write(e)) => {
                eprintln!("dbee: app.setWorkspace: {e}");
                Err(WorkspaceSaveError::WriteFailed {
                    message: write_failure_message(&e),
                }
                .into())
            }
        }
    }

    /// Connection status, grant expiry and session events. One per UI.
    #[rpc::subscription(perm = "app.read", risk = Risk::Read)]
    async fn events(
        &self,
        ctx: Ctx,
        _input: Empty,
        events: EventSink<AppEvent>,
    ) -> Result<(), RpcError> {
        let mut rx = self.0.manager.subscribe();
        loop {
            tokio::select! {
                biased;
                () = ctx.cancelled() => return Ok(()),
                received = rx.recv() => match received {
                    Ok(event) => events.send(&event).await?,
                    // A slow subscriber missed events; the UI refreshes on reconnect.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => return Ok(()),
                },
            }
        }
    }
}

/// A document `app.setWorkspace` stores: a JSON object no larger than the cap.
fn check_document(
    name: &str,
    document: &serde_json::Value,
) -> Result<(), RpcError<WorkspaceSaveError>> {
    let invalid = |message: String| {
        RpcError::from(WorkspaceSaveError::InvalidDocument {
            document: name.into(),
            message,
        })
    };
    if !document.is_object() {
        return Err(invalid("must be a JSON object".into()));
    }
    let size = serde_json::to_vec(document)
        .map_err(|_| invalid("cannot be serialized".into()))?
        .len();
    if size > MAX_WORKSPACE_DOCUMENT_BYTES {
        return Err(invalid(format!(
            "is {size} bytes, more than the {MAX_WORKSPACE_DOCUMENT_BYTES} allowed"
        )));
    }
    Ok(())
}

/// What the client is told about a failed workspace write: the file's name and the OS error, not
/// the directory (the server shell's paths stay on the server; the core log has them).
fn write_failure_message(e: &WorkspaceError) -> String {
    match e {
        WorkspaceError::Io { path, error } => format!(
            "could not write {}: {error}",
            path.file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default()
        ),
        WorkspaceError::Malformed { .. } => "could not write the workspace".into(),
    }
}

// ----------------------------------------------------------------------------------------------
// connections
// ----------------------------------------------------------------------------------------------

pub struct ConnectionsApi(pub Arc<CoreState>);

#[rpc::router(namespace = "connections")]
impl ConnectionsApi {
    /// Every connection of the workspace. Never a credential or its reference.
    #[rpc::query(perm = "connections.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn list(&self, _ctx: Ctx, _input: Empty) -> Result<Vec<ConnectionSummary>, RpcError> {
        Ok(self.0.manager.list())
    }

    /// Validates the draft, resolves the host and returns what the approver will see. Connects
    /// to nothing.
    #[rpc::mutation(perm = "connections.create", risk = Risk::Write)]
    async fn prepare(
        &self,
        ctx: Ctx,
        input: ConnectionDraft,
    ) -> Result<GrantPreview, RpcError<ConnectionError>> {
        let prepared = self
            .0
            .manager
            .preview(&input, ctx.principal(), None)
            .await?;
        Ok(prepared.preview)
    }

    /// Approves the grant and stores the connection. Refused for a principal that does not act
    /// directly, for a stale preview, and when the audit log is unavailable (nothing is created).
    #[rpc::mutation(perm = "connections.create", risk = Risk::Write)]
    async fn create(
        &self,
        ctx: Ctx,
        input: CreateConnectionInput,
    ) -> Result<ConnectionSummary, RpcError<ConnectionError>> {
        Ok(self.0.manager.create(ctx.principal(), input).await?)
    }

    /// Name, description and colour. Grant-covered fields are refused.
    #[rpc::mutation(perm = "connections.update", risk = Risk::Write)]
    async fn update(
        &self,
        _ctx: Ctx,
        input: UpdateConnectionInput,
    ) -> Result<ConnectionSummary, RpcError<ConnectionError>> {
        Ok(self.0.manager.update(input).await?)
    }

    /// Stores or removes the password. Write-only.
    #[rpc::mutation(perm = "connections.update", risk = Risk::Write, name = "setSecret")]
    async fn set_secret(
        &self,
        _ctx: Ctx,
        input: SetSecretInput,
    ) -> Result<SetSecretOutput, RpcError<ConnectionError>> {
        let has_secret = self
            .0
            .manager
            .set_secret(&input.id, input.password.map(Secret::new))
            .await?;
        Ok(SetSecretOutput { has_secret })
    }

    /// Revokes the grant, closes the sessions, removes the password and the record.
    #[rpc::mutation(perm = "connections.delete", risk = Risk::Destructive)]
    async fn delete(
        &self,
        ctx: Ctx,
        input: ConnectionId,
    ) -> Result<Empty, RpcError<ConnectionError>> {
        self.0.manager.delete(ctx.principal(), &input.id).await?;
        Ok(Empty {})
    }
}

// ----------------------------------------------------------------------------------------------
// sessions
// ----------------------------------------------------------------------------------------------

pub struct SessionsApi(pub Arc<CoreState>);

#[rpc::router(namespace = "sessions")]
impl SessionsApi {
    /// Opens a database session through the broker. A connection's browser session is reused.
    #[rpc::mutation(perm = "db.connect", risk = Risk::Read)]
    async fn open(
        &self,
        ctx: Ctx,
        input: OpenSessionInput,
    ) -> Result<OpenSessionOutput, RpcError<SessionError>> {
        let correlation_id =
            random_id().map_err(|_| RpcError::new(Code::Internal, "internal error"))?;
        let (session, server_version) = self
            .0
            .manager
            .open_session(
                &input.connection_id,
                input.purpose,
                ctx.principal(),
                &correlation_id,
            )
            .await?;
        Ok(OpenSessionOutput {
            session_id: session.id.clone(),
            server_version,
        })
    }

    /// Idempotent.
    #[rpc::mutation(perm = "db.connect", risk = Risk::Read)]
    async fn close(&self, ctx: Ctx, input: SessionId) -> Result<Empty, RpcError> {
        self.0
            .manager
            .close_session(&input.session_id, ctx.principal());
        Ok(Empty {})
    }
}

// ----------------------------------------------------------------------------------------------
// schema
// ----------------------------------------------------------------------------------------------

pub struct SchemaApi(pub Arc<CoreState>);

impl SchemaApi {
    /// The connection's browser session, opened lazily.
    async fn browser(
        &self,
        ctx: &Ctx,
        connection_id: &str,
    ) -> Result<Arc<crate::manager::DbSession>, RpcError<SessionError>> {
        let correlation_id =
            random_id().map_err(|_| RpcError::new(Code::Internal, "internal error"))?;
        let (session, _) = self
            .0
            .manager
            .open_session(
                connection_id,
                SessionPurpose::Browser,
                ctx.principal(),
                &correlation_id,
            )
            .await?;
        Ok(session)
    }
}

#[rpc::router(namespace = "schema")]
impl SchemaApi {
    #[rpc::query(perm = "db.schema.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn schemas(
        &self,
        ctx: Ctx,
        input: SchemasInput,
    ) -> Result<Vec<String>, RpcError<SessionError>> {
        let session = self.browser(&ctx, &input.connection_id).await?;
        Ok(session.conn.schemas().await.map_err(schema_error)?)
    }

    #[rpc::query(perm = "db.schema.read", risk = Risk::Read, agent = Agent::Exposed)]
    async fn tables(
        &self,
        ctx: Ctx,
        input: TablesInput,
    ) -> Result<Vec<TableInfo>, RpcError<SessionError>> {
        let session = self.browser(&ctx, &input.connection_id).await?;
        let tables = session
            .conn
            .tables(input.schema.as_deref())
            .await
            .map_err(schema_error)?;
        Ok(tables
            .into_iter()
            .map(|t| TableInfo {
                schema: t.schema,
                name: t.name,
                kind: t.kind,
            })
            .collect())
    }

    #[rpc::query(perm = "db.schema.read", risk = Risk::Read)]
    async fn columns(
        &self,
        ctx: Ctx,
        input: ColumnsInput,
    ) -> Result<Vec<ColumnInfo>, RpcError<SessionError>> {
        let session = self.browser(&ctx, &input.connection_id).await?;
        let columns = session
            .conn
            .columns(input.schema.as_deref(), &input.table)
            .await
            .map_err(schema_error)?;
        Ok(columns
            .into_iter()
            .map(|c| ColumnInfo {
                name: c.name,
                type_name: c.type_name,
                nullable: c.nullable,
            })
            .collect())
    }
}

// ----------------------------------------------------------------------------------------------
// query
// ----------------------------------------------------------------------------------------------

pub struct QueryApi(pub Arc<CoreState>);

/// Milliseconds left until the call's deadline, for the driver's own deadline.
fn remaining_ms(ctx: &Ctx) -> Option<u64> {
    ctx.deadline().map(|deadline| {
        u64::try_from(
            deadline
                .saturating_duration_since(tokio::time::Instant::now())
                .as_millis(),
        )
        .unwrap_or(u64::MAX)
    })
}

/// The typed error of a driver failure during a statement.
fn query_error(e: DbError) -> RpcError<QueryError> {
    match e {
        DbError::InvalidQuery(q) => QueryError::Syntax {
            message: q.message,
            position: q.position,
            sqlstate: q.sqlstate,
        }
        .into(),
        DbError::DatabaseError(q) => QueryError::Database {
            message: q.message,
            sqlstate: q.sqlstate,
            vendor_code: q.vendor_code,
        }
        .into(),
        DbError::Cancelled => QueryError::Cancelled.into(),
        DbError::PermissionDenied => QueryError::AccessEnded.into(),
        DbError::ConnectionLost | DbError::AuthenticationFailed | DbError::TlsFailed => {
            QueryError::Connection {
                message: "connection lost".into(),
            }
            .into()
        }
        DbError::Timeout => QueryError::Connection {
            message: "the database did not answer in time".into(),
        }
        .into(),
        DbError::Unsupported(message) => QueryError::Unsupported { message }.into(),
        DbError::Internal => RpcError::new(Code::Internal, "internal error"),
    }
}

/// The session, the classification and the re-check with the connection target: what every
/// statement runs through (DBee spec §4, Ambidex spec §8).
async fn admit_statement(
    state: &CoreState,
    ctx: &Ctx,
    session_id: &str,
    sql: &str,
) -> Result<(Arc<crate::manager::DbSession>, Classification), RpcError<QueryError>> {
    let session = state
        .manager
        .session(session_id, ctx.principal())
        .ok_or(QueryError::NotFound)?;
    let classification = classify(sql);
    ctx.authorize(
        Some(&TargetRef::connection(&session.connection_id)),
        classification.risk.into(),
    )
    .await?;
    Ok((session, classification))
}

#[rpc::router(namespace = "query")]
impl QueryApi {
    /// The fail-closed classification the server applies before running.
    #[rpc::query(perm = "db.query.execute", risk = Risk::Read)]
    async fn classify(&self, _ctx: Ctx, input: ClassifyInput) -> Result<Classification, RpcError> {
        Ok(classify(&input.sql))
    }

    /// Runs one statement; chunks are the driver's Arrow IPC stream (schema first), forwarded
    /// only when the client has a credit. Cancel reaches the driver's `ResultStream::cancel`.
    #[rpc::stream(
        perm = "db.query.execute",
        risk = Risk::Read,
        agent = Agent::Exposed,
        timeout_default = "5m",
        timeout_max = "1h"
    )]
    async fn execute(
        &self,
        ctx: Ctx,
        input: ExecuteInput,
        sink: BinarySink,
    ) -> Result<ExecuteSummary, RpcError<QueryError>> {
        let (session, classification) =
            admit_statement(&self.0, &ctx, &input.session_id, &input.sql).await?;
        let op = session.next_operation();
        let opts = ExecuteOptions {
            max_rows: input.max_rows,
            deadline_ms: remaining_ms(&ctx),
            batch_size_hint: input.batch_rows,
        };
        let mut stream = session
            .conn
            .execute(&op, &input.sql, opts)
            .await
            .map_err(query_error)?;
        let mut arrow = ArrowSink::new(sink);
        loop {
            arrow.ready().await?;
            let item = tokio::select! {
                biased;
                () = ctx.cancelled() => {
                    let _ = stream.cancel().await;
                    return Err(QueryError::Cancelled.into());
                }
                item = stream.next() => item,
            };
            match item {
                Ok(Some(NextItem::Chunk(chunk))) => arrow.send_ipc(chunk).await?,
                Ok(Some(NextItem::Finished(summary))) => {
                    return Ok(ExecuteSummary {
                        rows_affected: summary.rows_affected,
                        rows_returned: summary.rows_returned,
                        elapsed_ms: summary.elapsed_ms,
                        notices: summary.notices,
                        truncated: summary.truncated,
                        statement_kind: classification.kind,
                        risk: classification.risk,
                    });
                }
                Ok(None) => {
                    return Err(QueryError::Connection {
                        message: "the driver ended the result early".into(),
                    }
                    .into());
                }
                Err(e) => return Err(query_error(e)),
            }
        }
    }
}

// ----------------------------------------------------------------------------------------------
// export
// ----------------------------------------------------------------------------------------------

pub struct ExportApi(pub Arc<CoreState>);

/// Chunks sent to the client are at most this large.
const EXPORT_CHUNK_BYTES: usize = 1024 * 1024;

fn encode_error(e: EncodeError) -> RpcError<QueryError> {
    match e {
        EncodeError::Decode => RpcError::new(Code::Internal, "internal error"),
        EncodeError::UnsupportedType => QueryError::Unsupported {
            message: e.to_string(),
        }
        .into(),
    }
}

/// Where the encoded text goes.
enum Output {
    Client {
        sink: BinarySink,
        pending: Vec<u8>,
    },
    File {
        file: std::io::BufWriter<std::fs::File>,
        path: PathBuf,
    },
}

impl Output {
    async fn write(&mut self, text: &str) -> Result<(), RpcError<QueryError>> {
        match self {
            Output::Client { sink, pending } => {
                pending.extend_from_slice(text.as_bytes());
                while pending.len() >= EXPORT_CHUNK_BYTES {
                    let rest = pending.split_off(EXPORT_CHUNK_BYTES);
                    let chunk = std::mem::replace(pending, rest);
                    sink.send(chunk).await?;
                }
                Ok(())
            }
            Output::File { file, .. } => {
                use std::io::Write as _;
                file.write_all(text.as_bytes()).map_err(|e| {
                    RpcError::from(QueryError::Unsupported {
                        message: format!("could not write the file: {}", e.kind()),
                    })
                })
            }
        }
    }

    async fn finish(self) -> Result<Option<String>, RpcError<QueryError>> {
        match self {
            Output::Client { sink, pending } => {
                if !pending.is_empty() {
                    sink.send(pending).await?;
                }
                Ok(None)
            }
            Output::File { mut file, path } => {
                use std::io::Write as _;
                file.flush()
                    .and_then(|()| file.get_ref().sync_all())
                    .map_err(|e| {
                        RpcError::from(QueryError::Unsupported {
                            message: format!("could not write the file: {}", e.kind()),
                        })
                    })?;
                Ok(Some(path.display().to_string()))
            }
        }
    }
}

#[rpc::router(namespace = "export")]
impl ExportApi {
    /// Re-runs the statement (same authorization, classification and audit as `query.execute`)
    /// and encodes the whole result in the core: a stream of file bytes for the client, or a
    /// file the core writes to a path from `files.chooseSavePath`.
    #[rpc::stream(
        perm = "db.export",
        risk = Risk::Read,
        timeout_default = "5m",
        timeout_max = "1h"
    )]
    async fn run(
        &self,
        ctx: Ctx,
        input: ExportInput,
        sink: BinarySink,
    ) -> Result<ExportSummary, RpcError<QueryError>> {
        let mut output = match &input.destination {
            ExportDestination::Client => Output::Client {
                sink,
                pending: Vec::new(),
            },
            ExportDestination::File { handle } => {
                let path = self.0.take_save_path(handle).ok_or_else(|| {
                    RpcError::new(Code::InvalidArgument, "unknown or used save handle")
                })?;
                let file = std::fs::File::create(&path).map_err(|e| {
                    RpcError::from(QueryError::Unsupported {
                        message: format!("could not create the file: {}", e.kind()),
                    })
                })?;
                Output::File {
                    file: std::io::BufWriter::new(file),
                    path,
                }
            }
        };
        let (session, _) = admit_statement(&self.0, &ctx, &input.session_id, &input.sql).await?;
        let op = session.next_operation();
        let opts = ExecuteOptions {
            max_rows: input.max_rows,
            deadline_ms: remaining_ms(&ctx),
            batch_size_hint: None,
        };
        let mut stream = session
            .conn
            .execute(&op, &input.sql, opts)
            .await
            .map_err(query_error)?;
        let mut decoder = IpcDecoder::new();
        let mut encoder = Encoder::new(input.format, input.options.clone());
        let mut bytes: u64 = 0;
        loop {
            let item = tokio::select! {
                biased;
                () = ctx.cancelled() => {
                    let _ = stream.cancel().await;
                    return Err(QueryError::Cancelled.into());
                }
                item = stream.next() => item,
            };
            match item {
                Ok(Some(NextItem::Chunk(chunk))) => {
                    let batches = decoder.push(&chunk).map_err(encode_error)?;
                    if let Some(schema) = decoder.schema() {
                        let header = encoder.header(schema);
                        bytes += header.len() as u64;
                        output.write(&header).await?;
                    }
                    for batch in &batches {
                        let text = encoder.encode(batch).map_err(encode_error)?;
                        bytes += text.len() as u64;
                        output.write(&text).await?;
                    }
                }
                Ok(Some(NextItem::Finished(_))) | Ok(None) => break,
                Err(e) => return Err(query_error(e)),
            }
        }
        // A result without rows still gets its header.
        if let Some(schema) = decoder.schema() {
            let header = encoder.header(schema);
            bytes += header.len() as u64;
            output.write(&header).await?;
        }
        let path = output.finish().await?;
        Ok(ExportSummary {
            rows: encoder.rows(),
            bytes,
            path,
        })
    }
}

// ----------------------------------------------------------------------------------------------
// files
// ----------------------------------------------------------------------------------------------

pub struct FilesApi(pub Arc<CoreState>);

#[rpc::router(namespace = "files")]
impl FilesApi {
    /// Desktop only: the core opens the native save dialog and keeps the chosen path behind a
    /// one-time handle. On web it answers `Unimplemented`.
    #[rpc::mutation(perm = "files.write", risk = Risk::Write, name = "chooseSavePath")]
    async fn choose_save_path(
        &self,
        _ctx: Ctx,
        input: ChooseSavePathInput,
    ) -> Result<Option<SavePath>, RpcError> {
        let Some(dialog) = &self.0.save_dialog else {
            return Err(RpcError::new(
                Code::Unimplemented,
                "no native save dialog in this shell",
            ));
        };
        let Some(path) = dialog.choose(input.suggested_name, input.filters).await else {
            return Ok(None);
        };
        let handle = random_id().map_err(|_| RpcError::new(Code::Internal, "internal error"))?;
        let display_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.0
            .save_paths
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(handle.clone(), path);
        Ok(Some(SavePath {
            handle,
            display_name,
        }))
    }
}

impl<E: ambidex::DomainError> From<Failure<E>> for RpcError<E> {
    fn from(failure: Failure<E>) -> Self {
        match failure {
            Failure::Domain(e) => RpcError::from(e),
            Failure::Unavailable => RpcError::new(
                Code::Unavailable,
                "audit log unavailable; nothing was changed",
            )
            .with_retryable(true),
            Failure::Internal => RpcError::new(Code::Internal, "internal error"),
        }
    }
}
