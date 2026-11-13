//! The benchmark API: one stream procedure, `bench.rows`, that forwards the PostgreSQL driver's
//! Arrow IPC chunks to the client without decoding them.

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use ambidex::arrow::ArrowSink;
use ambidex::codegen::{self, ApiInfo};
use ambidex::engine::BoxFuture;
use ambidex::security_types::{AuditEntry, Authorizer, AuthzRequest, Decision, Reason, Risk};
use ambidex::{AuditError, AuditSink, BinarySink, Code, Ctx, Router, RpcError, ServerConfig, rpc};
use db_driver::{ExecuteOptions, NextItem, OperationId};
use db_driver_postgres::AccessMode;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pg::{Db, TABLE};

/// API name and server version the server announces.
pub const API: &str = "bench";
pub const SERVER_VERSION: &str = "0.0.0-bench";

pub fn api_info() -> ApiInfo {
    ApiInfo::new(API, SERVER_VERSION)
}

/// The schema hash of the generated client, from the router as `bench-gen` computes it.
pub fn schema_hash() -> &'static str {
    static HASH: LazyLock<String> = LazyLock::new(|| {
        codegen::schema_hash(&router(None), &api_info()).expect("benchmark API exports")
    });
    HASH.as_str()
}

/// Engine configuration; the defaults of [`ServerConfig::new`] unless the caller tunes them.
pub fn server_config() -> ServerConfig {
    ServerConfig::new(API, schema_hash(), SERVER_VERSION)
}

/// Where the generated `api.ts` and `api.manifest.json` are committed: next to the benchmark
/// client.
pub fn generated_dir() -> PathBuf {
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(2)
        .expect("crates/<name> is two levels below the workspace root");
    workspace.join("packages/ambidex/bench/generated")
}

/// The only permission the benchmark's sessions need.
struct BenchAuthorizer;

impl Authorizer for BenchAuthorizer {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        if req.action.perm == "bench.read".into() && req.risk <= Risk::Read {
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

/// The benchmark keeps no audit trail: entries are accepted and dropped, so a throwaway run
/// leaves nothing behind and the sink adds no I/O to the measurement.
struct DiscardAudit;

impl AuditSink for DiscardAudit {
    fn append(&self, _entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        Box::pin(async { Ok(()) })
    }
}

/// The router the server serves. Without a database the procedure fails, which is all code
/// generation needs.
pub fn router(db: Option<Arc<Db>>) -> Router {
    let router = Router::new(BenchAuthorizer).with_audit(DiscardAudit);
    router
        .mount(BenchApi { db })
        .expect("benchmark API registers");
    router
}

pub struct BenchApi {
    db: Option<Arc<Db>>,
}

/// Input of `bench.rows`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct BenchRowsInput {
    /// Rows to stream, at most the table's size.
    pub rows: u32,
    /// Rows per Arrow record batch; the driver's default when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub batch_rows: Option<u32>,
}

/// Final result of `bench.rows`: what the server saw. Times are milliseconds from the start of
/// the call.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct BenchSummary {
    pub rows: u32,
    /// Chunks (Ambidex stream frames) sent.
    pub chunks: u32,
    /// Arrow IPC bytes sent.
    pub bytes: u32,
    /// Opening the database connection through the broker.
    pub connect_ms: u32,
    /// The first chunk was handed to the transport.
    pub first_chunk_ms: u32,
    /// The driver's own time for the statement.
    pub query_ms: u32,
    /// The whole call.
    pub total_ms: u32,
}

fn ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn internal(what: &str, err: impl std::fmt::Display) -> RpcError {
    // Goes to the server's stderr; the client only sees a scrubbed Internal.
    eprintln!("bench.rows: {what}: {err}");
    RpcError::new(Code::Internal, what.to_owned())
}

#[rpc::router(namespace = "bench")]
impl BenchApi {
    /// Streams the first `rows` rows of the benchmark table as Arrow IPC.
    #[rpc::stream(perm = "bench.read", risk = Risk::Read)]
    async fn rows(
        &self,
        _ctx: Ctx,
        input: BenchRowsInput,
        sink: BinarySink,
    ) -> Result<BenchSummary, RpcError> {
        let start = Instant::now();
        let db = self
            .db
            .as_ref()
            .ok_or_else(|| RpcError::new(Code::Internal, "no database".to_owned()))?;
        let conn = db
            .connect(AccessMode::ReadOnly)
            .await
            .map_err(|e| internal("connect failed", e))?;
        let connect_ms = ms(start);
        let opts = ExecuteOptions {
            max_rows: Some(u64::from(input.rows)),
            batch_size_hint: input.batch_rows.filter(|n| *n > 0),
            ..ExecuteOptions::default()
        };
        let op = OperationId(format!("bench-{}", start.elapsed().as_nanos()));
        let mut stream = conn
            .execute(&op, &format!("SELECT * FROM {TABLE}"), opts)
            .await
            .map_err(|e| internal("execute failed", e))?;

        let mut sink = ArrowSink::new(sink);
        let (mut chunks, mut bytes, mut first_chunk_ms) = (0u32, 0u64, 0u32);
        let summary = loop {
            // Pull from the database only when the client has room: its credits pace the driver.
            if let Err(e) = sink.ready().await {
                let _ = stream.cancel().await;
                return Err(e.into());
            }
            match stream.next().await {
                Ok(Some(NextItem::Chunk(chunk))) => {
                    chunks += 1;
                    bytes += chunk.len() as u64;
                    if let Err(e) = sink.send_ipc(chunk).await {
                        let _ = stream.cancel().await;
                        return Err(e.into());
                    }
                    if chunks == 1 {
                        first_chunk_ms = ms(start);
                    }
                }
                Ok(Some(NextItem::Finished(summary))) => break summary,
                Ok(None) => break Default::default(),
                Err(e) => return Err(internal("query failed", e)),
            }
        };
        sink.finish().await?;
        Ok(BenchSummary {
            rows: u32::try_from(summary.rows_returned.unwrap_or(0)).unwrap_or(u32::MAX),
            chunks,
            bytes: u32::try_from(bytes).unwrap_or(u32::MAX),
            connect_ms,
            first_chunk_ms,
            query_ms: u32::try_from(summary.elapsed_ms).unwrap_or(u32::MAX),
            total_ms: ms(start),
        })
    }
}
