//! The shared procedures of spec §2.7: `app.info`, `app.events` and `term.*`. Each tool's own
//! procedures (`<tool>.connect`, `<tool>.disconnect`, ...) are in [`crate::tools`].

use std::sync::Arc;

use ambidex::{Ctx, EventSink, RpcError, rpc};
use base64::Engine as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::error::RecvError;
use ts_rs::TS;

use crate::core::{AppEvent, Empty, Hub, TermInput, ToolError, ToolResult};

/// Largest decoded `term.write` payload (spec §2.7).
pub const MAX_TERM_WRITE_BYTES: usize = 64 * 1024;

/// What `app.info` reports about the running server.
#[derive(Debug, Clone)]
pub struct ServerFacts {
    pub listen: String,
    pub public_origin: String,
    pub certificate_fingerprint: String,
}

/// Everything the shared procedures need.
pub struct AppState {
    pub hub: Arc<Hub>,
    pub facts: ServerFacts,
}

/// A tool built into the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    /// The tool's namespace: `echo`, `nats`, `kafka`, `k8s`, `temporal`, `docker`, `langgraph`.
    pub id: String,
    /// The version of the tool's main library, or of the server for built-in samples.
    pub version: String,
}

/// Output of `app.info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub api_version: String,
    pub schema_hash: String,
    /// The address the server listens on.
    pub listen: String,
    pub public_origin: String,
    /// SHA-256 of the server certificate, `AB:CD:…`, for About.
    pub certificate_fingerprint: String,
    pub os: String,
    pub tools: Vec<ToolInfo>,
    /// Payload codecs the server decodes (the messaging core, TSK-80).
    pub codecs: Vec<String>,
}

pub struct AppApi(pub Arc<AppState>);

#[rpc::router(namespace = "app")]
impl AppApi {
    /// About and feature gating.
    #[rpc::query(perm = "app.read", risk = Risk::Read)]
    async fn info(&self, _ctx: Ctx, _input: Empty) -> Result<AppInfo, RpcError> {
        let facts = &self.0.facts;
        Ok(AppInfo {
            version: env!("CARGO_PKG_VERSION").into(),
            api_version: crate::API_VERSION.into(),
            schema_hash: crate::SCHEMA_HASH.clone(),
            listen: facts.listen.clone(),
            public_origin: facts.public_origin.clone(),
            certificate_fingerprint: facts.certificate_fingerprint.clone(),
            os: std::env::consts::OS.into(),
            tools: crate::tools::infos(),
            codecs: Vec::new(),
        })
    }

    /// Connection status, stream progress and terminal exits of this connection. One per page;
    /// when it ends (the WebSocket closed, or the page unsubscribed) the connection's live
    /// handles are released.
    #[rpc::subscription(perm = "app.read", risk = Risk::Read)]
    async fn events(
        &self,
        ctx: Ctx,
        _input: Empty,
        events: EventSink<AppEvent>,
    ) -> Result<(), RpcError> {
        let mut guard = self.0.hub.subscribe(&ctx.session().id);
        loop {
            tokio::select! {
                biased;
                () = ctx.cancelled() => return Ok(()),
                received = guard.events.recv() => match received {
                    Ok(event) => events.send(&event).await?,
                    // A slow page missed events; the next ones still describe the state.
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => return Ok(()),
                },
            }
        }
    }
}

/// Input of `term.write`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermWriteInput {
    pub terminal_id: String,
    /// The bytes typed or pasted, base64; at most 64 KiB decoded.
    pub data: String,
}

/// Input of `term.resize`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermResizeInput {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

/// What `term.signal` sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum TermSignal {
    Interrupt,
    Eof,
}

/// Input of `term.signal`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TermSignalInput {
    pub terminal_id: String,
    pub signal: TermSignal,
}

pub struct TermApi(pub Arc<AppState>);

#[rpc::router(namespace = "term")]
impl TermApi {
    /// Keystrokes and pastes for a terminal opened by this connection.
    #[rpc::mutation(perm = "term.write", risk = Risk::Write, redact = ["data"])]
    async fn write(&self, ctx: Ctx, input: TermWriteInput) -> ToolResult<Empty> {
        let data = base64::engine::general_purpose::STANDARD
            .decode(input.data.as_bytes())
            .map_err(|_| ToolError::invalid("term", "data", "data must be base64"))?;
        if data.len() > MAX_TERM_WRITE_BYTES {
            return Err(ToolError::invalid(
                "term",
                "data",
                format!("at most {MAX_TERM_WRITE_BYTES} bytes per call"),
            )
            .into());
        }
        self.0
            .hub
            .terminal_input(&ctx.session().id, &input.terminal_id, TermInput::Data(data))
            .await?;
        Ok(Empty {})
    }

    /// The terminal's new size in character cells.
    #[rpc::mutation(perm = "term.write", risk = Risk::Write)]
    async fn resize(&self, ctx: Ctx, input: TermResizeInput) -> ToolResult<Empty> {
        if input.cols == 0 || input.rows == 0 {
            return Err(ToolError::invalid("term", "cols", "the size must be at least 1x1").into());
        }
        self.0
            .hub
            .terminal_input(
                &ctx.session().id,
                &input.terminal_id,
                TermInput::Resize {
                    cols: input.cols,
                    rows: input.rows,
                },
            )
            .await?;
        Ok(Empty {})
    }

    /// Interrupt or end of input, for the toolbar buttons (Ctrl+C and Ctrl+D also arrive as
    /// bytes through `term.write`).
    #[rpc::mutation(perm = "term.write", risk = Risk::Write)]
    async fn signal(&self, ctx: Ctx, input: TermSignalInput) -> ToolResult<Empty> {
        let signal = match input.signal {
            TermSignal::Interrupt => TermInput::Interrupt,
            TermSignal::Eof => TermInput::Eof,
        };
        self.0
            .hub
            .terminal_input(&ctx.session().id, &input.terminal_id, signal)
            .await?;
        Ok(Empty {})
    }
}
