//! `langgraph`: a LangGraph Studio-like tool for any LangGraph (Agent) Server (Mightyconsole
//! spec §11, TSK-84).
//!
//! Every procedure is one HTTP call of the LangGraph Server API made here, so the browser never
//! talks to the LangGraph server and needs no CORS (Decision 21). Run streams are SSE parsed here
//! and forwarded as JSON Lines (`jsonl`, spec §2.5), one [`RunEventLine`] per event, coalesced up
//! to 256 KiB or 50 ms; the server reads the next event only when the client has a credit, so a
//! paused view stops reading the run.
//!
//! **Runs survive the browser.** A run on a thread is created with `on_disconnect: continue`
//! and `stream_resumable: true`: closing the stream (Stop, a lost WebSocket) leaves the run
//! going, and `langgraph.runs.join` picks it up again from the last event id the UI saw (spec
//! §2.2, "Recovery"). Stopping the run itself is `langgraph.runs.cancel`. A run without a thread
//! is cancelled when its stream closes, as nothing could join it.
//!
//! The request and response shapes are those of the lab's server (`langgraph dev`, langgraph-api
//! 0.18.2, its `/openapi.json`): see `model.rs` for the answers.

pub mod budget;
mod client;
pub mod model;

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Code, Ctx, RpcError, rpc};
use eventsource_stream::Event;
use futures_util::{Stream, StreamExt as _};
use hyper::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio::time::Instant;
use ts_rs::TS;

use self::budget::{
    EVENT_SHARE, FULL_SHARE, ITEM_SHARE, Page, REPLY_BUDGET, STATE_SHARE, UPSTREAM_BUDGET, ValueCut,
};
use self::client::{LangGraphClient, SseItem};
use self::model::{
    Assistant, AssistantGraph, AssistantSchemas, LanggraphInfo, Run, StoreItem, Thread,
    ThreadState, items,
};
use crate::core::tls::TlsOptions;
use crate::core::{Empty, Handle, Hub, Progress, ToolError, ToolErrorKind, ToolResult};

/// The tool's id and namespace.
pub const TOOL: &str = "langgraph";

/// A `jsonl` chunk is sent when it reaches this size (spec §2.5).
const CHUNK_BYTES: usize = 256 * 1024;

/// ... or when its first event is this old.
const COALESCE: Duration = Duration::from_millis(50);

/// The stream modes a run may ask for (the server's `stream_mode` enum).
const STREAM_MODES: &[&str] = &[
    "values",
    "updates",
    "messages",
    "messages-tuple",
    "tasks",
    "checkpoints",
    "events",
    "debug",
    "custom",
    "tools",
];

/// An extra header of the profile (custom auth); its value is a secret.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HeaderPair {
    pub name: String,
    pub value: String,
}

impl std::fmt::Debug for HeaderPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: <redacted>", self.name)
    }
}

/// The LangGraph profile as `toConnect` builds it (spec §11.1).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectLanggraphProfile {
    pub name: String,
    /// The server's base URL, e.g. `http://127.0.0.1:2024`.
    pub url: String,
    /// Sent as `x-api-key` when set.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub api_key: Option<String>,
    /// Extra headers (custom auth), sent with every request.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Option<Vec<HeaderPair>>,
    /// For `https` URLs: a pinned CA, a client certificate, the expected name.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tls: Option<TlsOptions>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LanggraphConnectInput {
    pub profile: ConnectLanggraphProfile,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LanggraphConnectOutput {
    pub conn_id: String,
    pub info: LanggraphInfo,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LanggraphConnIdInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantsSearchInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub graph_id: Option<String>,
    /// Assistants whose metadata contains these keys and values.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub metadata: Option<Value>,
    /// 1 to 1000; 100 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantIdInput {
    pub conn_id: String,
    pub assistant_id: String,
}

/// How deep to draw subgraphs: `true` all the way, a number that many levels, `false` none.
#[derive(Debug, Clone, Copy, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum Xray {
    All(bool),
    Depth(u32),
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AssistantGraphInput {
    pub conn_id: String,
    pub assistant_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub xray: Option<Xray>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsSearchInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub metadata: Option<Value>,
    /// `idle`, `busy`, `interrupted` or `error`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub status: Option<String>,
    /// 1 to 1000; 50 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
    /// `updated_at` (when absent), `created_at`, `thread_id` or `status`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sort_by: Option<String>,
    /// `desc` (when absent, newest first) or `asc`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sort_order: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadsCreateInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub metadata: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdInput {
    pub conn_id: String,
    pub thread_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStateInput {
    pub conn_id: String,
    pub thread_id: String,
    /// The state at this checkpoint (time travel); the current state when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub checkpoint_id: Option<String>,
    /// Include the subgraphs' states in the tasks.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subgraphs: Option<bool>,
    /// Allow the reply to weigh up to 12 MiB instead of 8 MiB, to load a value that came back
    /// cut (`cuts`); over that, `threads.readValue` streams it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub full: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryInput {
    pub conn_id: String,
    pub thread_id: String,
    /// 1 to 1000; 50 when absent. Newest first.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    /// Checkpoints older than this one (the next page).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub before: Option<String>,
    /// Only the checkpoints whose metadata holds these pairs, e.g. `{ "run_id": … }` for one run's
    /// steps (TSK-96). An object.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub metadata: Option<Value>,
}

/// A page of the history: at most about 4 MiB, whatever `limit` says (TSK-108).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHistoryPage {
    /// Newest first. A value over its share is `null` with a note in the item's `cuts`.
    pub items: Vec<ThreadState>,
    /// Pass it as `before` for the next page; absent when the history ends here.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<String>,
}

/// A page of a thread's runs: at most about 4 MiB, whatever `limit` says (TSK-108).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsPage {
    /// Newest first. A run's metadata over its share is `null` with a note in its `cuts`.
    pub items: Vec<Run>,
    /// Pass it as `offset` for the next page; absent when the runs end here.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next: Option<u32>,
}

/// What `langgraph.threads.readValue` reads: one value of a checkpoint or of a run, whole.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadValueInput {
    pub conn_id: String,
    pub thread_id: String,
    /// A run's value (`metadata`, `request.input`); when absent, a checkpoint's.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// The checkpoint (the current state when absent).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub checkpoint_id: Option<String>,
    /// A `field` of a `cut`: `values`, `metadata`, `tasks.<n>.state`, `tasks.<n>.result`,
    /// `interrupts.<n>` or `tasks.<n>.interrupts.<m>`.
    pub field: String,
}

/// The end of `langgraph.threads.readValue`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadValueSummary {
    /// The JSON text sent.
    pub bytes: u64,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStateInput {
    pub conn_id: String,
    pub thread_id: String,
    /// The values to write, as a node's update.
    pub values: Value,
    /// The node the update is made as (the graph continues from its edges).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub as_node: Option<String>,
    /// Update the state at this checkpoint, which forks a new branch from it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub checkpoint_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStateOutput {
    /// The new checkpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub checkpoint_id: Option<String>,
    pub checkpoint: Value,
}

/// `Command` of a run: resume an interrupt, update the state, go to a node.
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunCommand {
    /// The value `interrupt()` returns.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub resume: Option<Value>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub update: Option<Value>,
    /// A node name, or a list of them.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub goto: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsStreamInput {
    pub conn_id: String,
    /// The thread to run on; `null` for a run without a thread.
    pub thread_id: Option<String>,
    /// An assistant id or a graph id.
    pub assistant_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub input: Option<Value>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub command: Option<RunCommand>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub config: Option<Value>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub context: Option<Value>,
    /// Run from this checkpoint (time travel).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub checkpoint_id: Option<String>,
    /// `values`, `updates`, `messages-tuple`, `tasks`, `custom`, `debug`, ...
    pub stream_mode: Vec<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub stream_subgraphs: Option<bool>,
    /// Node names, or `["*"]` for every node.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub interrupt_before: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub interrupt_after: Option<Vec<String>>,
    /// `reject`, `rollback`, `interrupt` or `enqueue` when the thread is busy.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub multitask_strategy: Option<String>,
    pub stream_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsJoinInput {
    pub conn_id: String,
    pub thread_id: String,
    pub run_id: String,
    /// The id of the last event seen: the stream resumes after it. From the run's current
    /// event when absent; `-1` replays the run from its start.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub last_event_id: Option<String>,
    pub stream_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunsListInput {
    pub conn_id: String,
    pub thread_id: String,
    /// 1 to 1000; 20 when absent. Newest first.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    /// The runs to skip: the `next` of the previous page.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunIdInput {
    pub conn_id: String,
    pub thread_id: String,
    pub run_id: String,
}

/// One line of a run stream (`jsonl`): an SSE event of the LangGraph server.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventLine {
    /// `metadata`, `values`, `updates`, `messages`, `custom`, `error`, ... With subgraphs,
    /// `updates|<subgraph>:<task>`.
    pub event: String,
    /// `null` when the event's data was over 4 MiB: `cut` says what it was (TSK-108). A `values`
    /// event repeats the whole state; `threads.state` or `threads.readValue` has it.
    pub data: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cut: Option<ValueCut>,
}

/// The end of `langgraph.runs.stream` and `langgraph.runs.join`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunStreamSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    /// The run's status when its stream ended (`success`, `error`, `interrupted`, ...).
    pub status: String,
    /// Events forwarded.
    pub events: u64,
    /// The id of the last event forwarded (for `langgraph.runs.join`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_event_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoreNamespacesInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub prefix: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_depth: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoreSearchInput {
    pub conn_id: String,
    pub namespace_prefix: Vec<String>,
    /// Natural-language query (semantic search, when the store has an index).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
    /// Items whose value has these fields and values.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<Value>,
    /// 1 to 1000; 50 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StoreKeyInput {
    pub conn_id: String,
    pub namespace: Vec<String>,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StorePutInput {
    pub conn_id: String,
    pub namespace: Vec<String>,
    pub key: String,
    /// A JSON object.
    pub value: Value,
}

// ---- Helpers ---------------------------------------------------------------------------------

/// An id that goes into a URL path: letters, digits and `-_.:~` only.
fn id<'a>(field: &str, value: &'a str) -> Result<&'a str, ToolError> {
    let ok = !value.is_empty()
        && value.len() <= 256
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':' | '~'));
    if ok {
        Ok(value)
    } else {
        Err(ToolError::invalid(
            TOOL,
            field,
            format!("{field} is not an id"),
        ))
    }
}

/// How many runs the first upstream call asks for.
const RUNS_FIRST_PAGE: usize = 10;

/// An upstream answer over the client's size cap: ask for less.
fn too_big(e: &ToolError) -> bool {
    e.message.contains("length limit exceeded")
}

/// A `field` of a cut (`values`, `tasks.0.state`, `interrupts.1`, ...) in the upstream's JSON.
fn resolve_field<'a>(v: &'a Value, field: &str) -> Option<&'a Value> {
    let mut cur = v;
    let mut parts = field.split('.').peekable();
    let mut last = "";
    while let Some(key) = parts.next() {
        cur = cur.get(key)?;
        last = key;
        if let Some(n) = parts.peek().and_then(|p| p.parse::<usize>().ok()) {
            parts.next();
            cur = cur.get(n)?;
        }
    }
    // An interrupt is `{ "value": ..., "id": ... }`: its value is what was cut.
    if last == "interrupts" {
        cur = cur.get("value")?;
    }
    Some(cur)
}

fn limit(field: &str, value: Option<u32>, default: u32) -> Result<u32, ToolError> {
    match value.unwrap_or(default) {
        n @ 1..=1000 => Ok(n),
        _ => Err(ToolError::invalid(TOOL, field, "between 1 and 1000")),
    }
}

/// The threads search's order: `updated_at` newest first when absent (TSK-95, the Advanced menu).
fn thread_sort(
    by: Option<String>,
    order: Option<String>,
) -> Result<(&'static str, &'static str), ToolError> {
    let by = match by.as_deref().filter(|s| !s.is_empty()) {
        None | Some("updated_at") => "updated_at",
        Some("created_at") => "created_at",
        Some("thread_id") => "thread_id",
        Some("status") => "status",
        Some(_) => {
            return Err(ToolError::invalid(
                TOOL,
                "sortBy",
                "updated_at, created_at, thread_id or status",
            ));
        }
    };
    let order = match order.as_deref().filter(|s| !s.is_empty()) {
        None | Some("desc") => "desc",
        Some("asc") => "asc",
        Some(_) => return Err(ToolError::invalid(TOOL, "sortOrder", "asc or desc")),
    };
    Ok((by, order))
}

fn object(field: &str, value: Option<Value>) -> Result<Option<Value>, ToolError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v @ Value::Object(_)) => Ok(Some(v)),
        Some(_) => Err(ToolError::invalid(
            TOOL,
            field,
            format!("{field} must be a JSON object"),
        )),
    }
}

fn namespace(field: &str, parts: &[String]) -> Result<(), ToolError> {
    if parts.iter().any(|p| p.is_empty() || p.contains('.')) {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "namespace labels are non-empty and have no \".\"",
        ));
    }
    Ok(())
}

fn ended(code: Code) -> RpcError<ToolError> {
    RpcError::new(code, "the connection was closed")
}

/// What a run stream saw, for its summary.
#[derive(Default)]
struct Seen {
    run_id: Option<String>,
    error: bool,
    events: u64,
    last_event_id: Option<String>,
}

impl Seen {
    fn push(&mut self, chunk: &mut Vec<u8>, event: Event, progress: &Progress) {
        let name = if event.event.is_empty() {
            "message".to_owned()
        } else {
            event.event
        };
        let (data, cut) = if event.data.len() > EVENT_SHARE {
            (Value::Null, Some(budget::cut_text("data", &event.data)))
        } else {
            (
                serde_json::from_str(&event.data).unwrap_or(Value::String(event.data)),
                None,
            )
        };
        if name == "metadata"
            && let Some(run_id) = data.get("run_id").and_then(Value::as_str)
        {
            self.run_id = Some(run_id.to_owned());
        }
        if name == "error" {
            self.error = true;
        }
        let id = (!event.id.is_empty()).then_some(event.id);
        if id.is_some() {
            self.last_event_id.clone_from(&id);
        }
        let line = RunEventLine {
            event: name,
            data,
            id,
            cut,
        };
        let before = chunk.len();
        serde_json::to_writer(&mut *chunk, &line).expect("a JSON value serializes");
        chunk.push(b'\n');
        self.events += 1;
        progress.scanned(1);
        progress.matched(1, (chunk.len() - before) as u64);
    }
}

/// Forwards SSE events as `jsonl` chunks, one credit per chunk, until the run's stream ends.
async fn pump<S>(
    ctx: &Ctx,
    handle: &Handle<LangGraphClient>,
    sink: &BinarySink,
    events: &mut S,
    progress: &Progress,
    seen: &mut Seen,
) -> ToolResult<()>
where
    S: Stream<Item = SseItem> + Unpin,
{
    loop {
        tokio::select! {
            biased;
            () = handle.token.cancelled() => return Err(ended(Code::Cancelled)),
            () = ctx.cancelled() => return Err(ended(Code::Cancelled)),
            ready = sink.ready() => ready?,
        }
        let first = tokio::select! {
            biased;
            () = handle.token.cancelled() => return Err(ended(Code::Cancelled)),
            () = ctx.cancelled() => return Err(ended(Code::Cancelled)),
            next = events.next() => next,
        };
        let mut chunk = Vec::new();
        match first {
            None => return Ok(()),
            Some(Err(e)) => return Err(e.into()),
            Some(Ok(event)) => seen.push(&mut chunk, event, progress),
        }
        let deadline = Instant::now() + COALESCE;
        let mut end: Option<Result<(), ToolError>> = None;
        while chunk.len() < CHUNK_BYTES {
            match tokio::time::timeout_at(deadline, events.next()).await {
                Err(_) => break,
                Ok(None) => {
                    end = Some(Ok(()));
                    break;
                }
                Ok(Some(Err(e))) => {
                    end = Some(Err(e));
                    break;
                }
                Ok(Some(Ok(event))) => seen.push(&mut chunk, event, progress),
            }
        }
        sink.send(chunk).await?;
        match end {
            None => {}
            Some(Ok(())) => return Ok(()),
            Some(Err(e)) => return Err(e.into()),
        }
    }
}

/// The run's status once its stream ended.
async fn run_status(client: &LangGraphClient, thread_id: Option<&str>, seen: &Seen) -> String {
    if seen.error {
        return "error".into();
    }
    if let (Some(thread), Some(run)) = (thread_id, seen.run_id.as_deref())
        && let Ok(v) = client
            .get(&format!("/threads/{thread}/runs/{run}"), &[], "run")
            .await
        && let Some(status) = v.get("status").and_then(Value::as_str)
    {
        return status.to_owned();
    }
    "success".into()
}

// ---- Procedures ------------------------------------------------------------------------------

/// `langgraph.connect` and `langgraph.disconnect`.
pub struct LanggraphApi(pub Arc<Hub>);

#[rpc::router(namespace = "langgraph")]
impl LanggraphApi {
    /// Opens a connection: checks the server answers (`GET /info`, `GET /ok` as a fallback).
    #[rpc::mutation(
        perm = "langgraph.read",
        risk = Risk::Read,
        redact = ["profile.apiKey", "profile.headers", "profile.tls.clientKeyPem"]
    )]
    async fn connect(
        &self,
        ctx: Ctx,
        input: LanggraphConnectInput,
    ) -> ToolResult<LanggraphConnectOutput> {
        let client = LangGraphClient::new(&input.profile)?;
        let info = match client.get("/info", &[], "server").await {
            Ok(v) => LanggraphInfo::from_json(&v),
            Err(e) if e.kind == ToolErrorKind::NotFound => {
                client.get("/ok", &[], "server").await?;
                LanggraphInfo {
                    version: None,
                    flags: json!({}),
                }
            }
            Err(e) => return Err(e.into()),
        };
        let handle = self.0.insert(&ctx.session().id, TOOL, Arc::new(client));
        Ok(LanggraphConnectOutput {
            conn_id: handle.conn_id,
            info,
        })
    }

    /// Releases the connection and ends its streams (the runs go on); idempotent.
    #[rpc::mutation(perm = "langgraph.read", risk = Risk::Read)]
    async fn disconnect(&self, ctx: Ctx, input: LanggraphConnIdInput) -> ToolResult<Empty> {
        self.0.remove(&ctx.session().id, TOOL, &input.conn_id);
        Ok(Empty {})
    }
}

fn client(hub: &Hub, ctx: &Ctx, conn_id: &str) -> Result<Handle<LangGraphClient>, ToolError> {
    hub.get::<LangGraphClient>(&ctx.session().id, TOOL, conn_id)
}

/// `langgraph.assistants.*`.
pub struct AssistantsApi(pub Arc<Hub>);

#[rpc::router(namespace = "langgraph.assistants")]
impl AssistantsApi {
    /// Assistants, newest first (`POST /assistants/search`).
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn search(&self, ctx: Ctx, input: AssistantsSearchInput) -> ToolResult<Vec<Assistant>> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let mut body = Map::new();
        body.insert("limit".into(), limit("limit", input.limit, 100)?.into());
        body.insert("offset".into(), input.offset.unwrap_or(0).into());
        if let Some(graph) = input.graph_id.filter(|g| !g.is_empty()) {
            body.insert("graph_id".into(), graph.into());
        }
        if let Some(metadata) = object("metadata", input.metadata)? {
            body.insert("metadata".into(), metadata);
        }
        let v = handle
            .value
            .post("/assistants/search", &Value::Object(body), "assistant")
            .await?;
        Ok(items(&v, "assistants").map(Assistant::from_json).collect())
    }

    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: AssistantIdInput) -> ToolResult<Assistant> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let assistant = id("assistantId", &input.assistant_id)?;
        let v = handle
            .value
            .get(&format!("/assistants/{assistant}"), &[], "assistant")
            .await?;
        Ok(Assistant::from_json(&v))
    }

    /// The graph for the GraphView; `xray` draws subgraphs' nodes as `<subgraph>:<node>`.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn graph(&self, ctx: Ctx, input: AssistantGraphInput) -> ToolResult<AssistantGraph> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let assistant = id("assistantId", &input.assistant_id)?;
        let query = match input.xray {
            None | Some(Xray::All(false)) | Some(Xray::Depth(0)) => vec![],
            Some(Xray::All(true)) => vec![("xray", "true".to_owned())],
            Some(Xray::Depth(n)) => vec![("xray", n.to_string())],
        };
        let v = handle
            .value
            .get(
                &format!("/assistants/{assistant}/graph"),
                &query,
                "assistant",
            )
            .await?;
        Ok(AssistantGraph::from_json(&v))
    }

    /// Input, output, state, config and context JSON Schemas of the assistant's graph.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn schemas(&self, ctx: Ctx, input: AssistantIdInput) -> ToolResult<AssistantSchemas> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let assistant = id("assistantId", &input.assistant_id)?;
        let v = handle
            .value
            .get(
                &format!("/assistants/{assistant}/schemas"),
                &[],
                "assistant",
            )
            .await?;
        Ok(AssistantSchemas::from_json(&v))
    }
}

/// `langgraph.threads.*`.
pub struct ThreadsApi(pub Arc<Hub>);

#[rpc::router(namespace = "langgraph.threads")]
impl ThreadsApi {
    /// Threads, most recently updated first unless `sortBy`/`sortOrder` say otherwise (`POST /threads/search`).
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn search(&self, ctx: Ctx, input: ThreadsSearchInput) -> ToolResult<Vec<Thread>> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let mut body = Map::new();
        body.insert("limit".into(), limit("limit", input.limit, 50)?.into());
        body.insert("offset".into(), input.offset.unwrap_or(0).into());
        let (sort_by, sort_order) = thread_sort(input.sort_by, input.sort_order)?;
        body.insert("sort_by".into(), sort_by.into());
        body.insert("sort_order".into(), sort_order.into());
        if let Some(status) = input.status.filter(|s| !s.is_empty()) {
            if !matches!(status.as_str(), "idle" | "busy" | "interrupted" | "error") {
                return Err(
                    ToolError::invalid(TOOL, "status", "idle, busy, interrupted or error").into(),
                );
            }
            body.insert("status".into(), status.into());
        }
        if let Some(metadata) = object("metadata", input.metadata)? {
            body.insert("metadata".into(), metadata);
        }
        let v = handle
            .value
            .post("/threads/search", &Value::Object(body), "thread")
            .await?;
        Ok(items(&v, "threads").map(Thread::from_json).collect())
    }

    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: ThreadIdInput) -> ToolResult<Thread> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let v = handle
            .value
            .get(&format!("/threads/{thread}"), &[], "thread")
            .await?;
        Ok(Thread::from_json(&v))
    }

    #[rpc::mutation(perm = "langgraph.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: ThreadsCreateInput) -> ToolResult<Thread> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let mut body = Map::new();
        if let Some(metadata) = object("metadata", input.metadata)? {
            body.insert("metadata".into(), metadata);
        }
        let v = handle
            .value
            .post("/threads", &Value::Object(body), "thread")
            .await?;
        Ok(Thread::from_json(&v))
    }

    /// Deletes the thread with its checkpoints and runs.
    #[rpc::mutation(perm = "langgraph.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: ThreadIdInput) -> ToolResult<Empty> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        handle
            .value
            .call(
                Method::DELETE,
                &format!("/threads/{thread}"),
                &[],
                None,
                "thread",
            )
            .await?;
        Ok(Empty {})
    }

    /// The current state, or the state at a checkpoint.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn state(&self, ctx: Ctx, input: ThreadStateInput) -> ToolResult<ThreadState> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let path = match input.checkpoint_id.as_deref().filter(|c| !c.is_empty()) {
            Some(checkpoint) => format!(
                "/threads/{thread}/state/{}",
                id("checkpointId", checkpoint)?
            ),
            None => format!("/threads/{thread}/state"),
        };
        let query = if input.subgraphs.unwrap_or(false) {
            vec![("subgraphs", "true".to_owned())]
        } else {
            vec![]
        };
        let v = handle.value.get(&path, &query, "thread").await?;
        let share = if input.full.unwrap_or(false) {
            FULL_SHARE
        } else {
            STATE_SHARE
        };
        Ok(ThreadState::from_json(&v).within(share))
    }

    /// One value of a checkpoint or a run, whole, as JSON text in chunks: for a `cut` too big for
    /// `state` with `full`.
    #[rpc::stream(
        perm = "langgraph.read",
        risk = Risk::Read,
        name = "readValue",
        timeout_default = "10m",
        timeout_max = "1h"
    )]
    async fn read_value(
        &self,
        ctx: Ctx,
        input: ReadValueInput,
        sink: BinarySink,
    ) -> ToolResult<ReadValueSummary> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let path = match (&input.run_id, &input.checkpoint_id) {
            (Some(run), _) => format!("/threads/{thread}/runs/{}", id("runId", run)?),
            (None, Some(c)) if !c.is_empty() => {
                format!("/threads/{thread}/state/{}", id("checkpointId", c)?)
            }
            _ => format!("/threads/{thread}/state"),
        };
        let query = if input.run_id.is_none() && input.field.starts_with("tasks.") {
            vec![("subgraphs", "true".to_owned())]
        } else {
            vec![]
        };
        let v = handle.value.get(&path, &query, "thread").await?;
        // A run's request is its `kwargs` upstream (TSK-96).
        let field = match input.field.strip_prefix("request.") {
            Some(rest) if input.run_id.is_some() => format!("kwargs.{rest}"),
            _ => input.field.clone(),
        };
        let value = resolve_field(&v, &field).ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::NotFound,
                TOOL,
                format!("{} has no {}", path, input.field),
            )
        })?;
        let bytes = serde_json::to_vec(value).expect("a JSON value serializes");
        for chunk in bytes.chunks(sink.max_chunk_bytes().clamp(1, CHUNK_BYTES)) {
            sink.send(chunk.to_vec()).await?;
        }
        Ok(ReadValueSummary {
            bytes: bytes.len() as u64,
        })
    }

    /// Checkpoints, newest first, a page of at most about 4 MiB: fewer than `limit` when they are
    /// big, with `next` for the rest. A value over its share comes back `null` and named in the
    /// item's `cuts`; `state` (or `readValue`) gives it whole.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn history(&self, ctx: Ctx, input: ThreadHistoryInput) -> ToolResult<ThreadHistoryPage> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let want = limit("limit", input.limit, 50)? as usize;
        let mut before = input.before.filter(|b| !b.is_empty());
        if let Some(b) = &before {
            id("before", b)?;
        }
        let metadata = object("metadata", input.metadata)?;
        let mut page: Page<ThreadState> = Page::new(REPLY_BUDGET);
        let mut ask = budget::FIRST_PAGE;
        let mut fetched = 0;
        let next = loop {
            let take = ask.min(want - page.items.len()).max(1);
            let mut body = Map::new();
            body.insert("limit".into(), take.into());
            if let Some(metadata) = &metadata {
                body.insert("metadata".into(), metadata.clone());
            }
            if let Some(before) = &before {
                body.insert(
                    "before".into(),
                    json!({ "configurable": { "checkpoint_id": before } }),
                );
            }
            let v = match handle
                .value
                .post(
                    &format!("/threads/{thread}/history"),
                    &Value::Object(body),
                    "thread",
                )
                .await
            {
                // A heavy page: ask for half as many, down to one checkpoint.
                Err(e) if take > 1 && too_big(&e) => {
                    ask = take / 2;
                    continue;
                }
                other => other?,
            };
            let raw: Vec<&Value> = items(&v, "history").collect();
            let got = raw.len();
            let mut raw_bytes = 0;
            let mut full = false;
            for item in raw {
                raw_bytes += budget::json_len(item);
                let state = ThreadState::from_json(item).within(ITEM_SHARE);
                let weight = state.weight();
                if !page.fits(weight) {
                    full = true;
                    break;
                }
                page.add(state, weight);
            }
            fetched += raw_bytes;
            let last = page.items.last().and_then(|s| s.checkpoint_id.clone());
            if full || page.items.len() >= want || (got == take && fetched >= UPSTREAM_BUDGET) {
                break last;
            }
            if got < take {
                break None;
            }
            let Some(last) = last else { break None };
            before = Some(last);
            ask = budget::next_page_size(raw_bytes, got, want);
        };
        Ok(ThreadHistoryPage {
            items: page.items,
            next,
        })
    }

    /// Writes values as a node; at a checkpoint this forks a new branch from it.
    #[rpc::mutation(perm = "langgraph.write", risk = Risk::Write, name = "updateState")]
    async fn update_state(
        &self,
        ctx: Ctx,
        input: UpdateStateInput,
    ) -> ToolResult<UpdateStateOutput> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let mut body = Map::new();
        body.insert("values".into(), input.values);
        if let Some(node) = input.as_node.filter(|n| !n.is_empty()) {
            body.insert("as_node".into(), node.into());
        }
        if let Some(checkpoint) = input.checkpoint_id.filter(|c| !c.is_empty()) {
            id("checkpointId", &checkpoint)?;
            body.insert("checkpoint_id".into(), checkpoint.clone().into());
            body.insert("checkpoint".into(), json!({ "checkpoint_id": checkpoint }));
        }
        let v = handle
            .value
            .post(
                &format!("/threads/{thread}/state"),
                &Value::Object(body),
                "thread",
            )
            .await?;
        let checkpoint = v.get("checkpoint").cloned().unwrap_or(Value::Null);
        Ok(UpdateStateOutput {
            checkpoint_id: checkpoint
                .get("checkpoint_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            checkpoint,
        })
    }
}

/// `langgraph.runs.*`.
pub struct RunsApi(pub Arc<Hub>);

#[rpc::router(namespace = "langgraph.runs")]
impl RunsApi {
    /// Starts a run and streams its events (`jsonl`: [`RunEventLine`]). Closing the stream
    /// leaves a thread's run going (join it again, or cancel it).
    #[rpc::stream(perm = "langgraph.write", risk = Risk::Write, timeout_max = "12h")]
    async fn stream(
        &self,
        ctx: Ctx,
        input: RunsStreamInput,
        sink: BinarySink,
    ) -> ToolResult<RunStreamSummary> {
        let session = ctx.session().id.clone();
        let thread = match input.thread_id.as_deref() {
            Some(t) => Some(id("threadId", t)?.to_owned()),
            None => None,
        };
        id("assistantId", &input.assistant_id)?;
        if input.stream_mode.is_empty()
            || input
                .stream_mode
                .iter()
                .any(|m| !STREAM_MODES.contains(&m.as_str()))
        {
            return Err(ToolError::invalid(
                TOOL,
                "streamMode",
                format!("one or more of {}", STREAM_MODES.join(", ")),
            )
            .into());
        }
        let mut body = Map::new();
        body.insert("assistant_id".into(), input.assistant_id.into());
        body.insert("stream_mode".into(), input.stream_mode.into());
        body.insert(
            "stream_subgraphs".into(),
            input.stream_subgraphs.unwrap_or(false).into(),
        );
        if let Some(value) = input.input {
            body.insert("input".into(), value);
        }
        if let Some(command) = input.command {
            let mut c = Map::new();
            if let Some(resume) = command.resume {
                c.insert("resume".into(), resume);
            }
            if let Some(update) = command.update {
                c.insert("update".into(), update);
            }
            if let Some(goto) = command.goto {
                c.insert("goto".into(), goto);
            }
            if c.is_empty() {
                return Err(ToolError::invalid(TOOL, "command", "resume, update or goto").into());
            }
            body.insert("command".into(), Value::Object(c));
        }
        if let Some(config) = object("config", input.config)? {
            body.insert("config".into(), config);
        }
        if let Some(context) = object("context", input.context)? {
            body.insert("context".into(), context);
        }
        if let Some(checkpoint) = input.checkpoint_id.filter(|c| !c.is_empty()) {
            id("checkpointId", &checkpoint)?;
            body.insert("checkpoint".into(), json!({ "checkpoint_id": checkpoint }));
        }
        for (field, key, nodes) in [
            (
                "interruptBefore",
                "interrupt_before",
                input.interrupt_before,
            ),
            ("interruptAfter", "interrupt_after", input.interrupt_after),
        ] {
            match nodes {
                Some(n) if n.iter().any(|x| x == "*") => {
                    body.insert(key.into(), "*".into());
                }
                Some(n) if !n.is_empty() => {
                    if n.iter().any(String::is_empty) {
                        return Err(ToolError::invalid(TOOL, field, "node names").into());
                    }
                    body.insert(key.into(), n.into());
                }
                _ => {}
            }
        }
        if let Some(strategy) = input.multitask_strategy.filter(|s| !s.is_empty()) {
            if !matches!(
                strategy.as_str(),
                "reject" | "rollback" | "interrupt" | "enqueue"
            ) {
                return Err(ToolError::invalid(
                    TOOL,
                    "multitaskStrategy",
                    "reject, rollback, interrupt or enqueue",
                )
                .into());
            }
            body.insert("multitask_strategy".into(), strategy.into());
        }
        let path = match &thread {
            Some(thread) => {
                body.insert("stream_resumable".into(), true.into());
                body.insert("on_disconnect".into(), "continue".into());
                format!("/threads/{thread}/runs/stream")
            }
            None => {
                body.insert("on_disconnect".into(), "cancel".into());
                "/runs/stream".to_owned()
            }
        };
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self
            .0
            .busy::<LangGraphClient>(&session, TOOL, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let mut events = handle
            .value
            .sse(
                Method::POST,
                &path,
                Some(&Value::Object(body)),
                None,
                "thread",
            )
            .await?;
        let mut seen = Seen::default();
        pump(&ctx, &handle, &sink, &mut events, &progress, &mut seen).await?;
        let status = run_status(&handle.value, thread.as_deref(), &seen).await;
        Ok(RunStreamSummary {
            run_id: seen.run_id,
            status,
            events: seen.events,
            last_event_id: seen.last_event_id,
        })
    }

    /// Streams a running run again, from after `lastEventId` (after a reconnect).
    #[rpc::stream(perm = "langgraph.read", risk = Risk::Read, timeout_max = "12h")]
    async fn join(
        &self,
        ctx: Ctx,
        input: RunsJoinInput,
        sink: BinarySink,
    ) -> ToolResult<RunStreamSummary> {
        let session = ctx.session().id.clone();
        let thread = id("threadId", &input.thread_id)?.to_owned();
        let run = id("runId", &input.run_id)?.to_owned();
        if let Some(last) = input.last_event_id.as_deref()
            && (last.is_empty() || last.len() > 128 || last.chars().any(char::is_control))
        {
            return Err(ToolError::invalid(TOOL, "lastEventId", "an event id").into());
        }
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self
            .0
            .busy::<LangGraphClient>(&session, TOOL, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let mut events = handle
            .value
            .sse(
                Method::GET,
                &format!("/threads/{thread}/runs/{run}/stream"),
                None,
                input.last_event_id.as_deref(),
                "run",
            )
            .await?;
        let mut seen = Seen {
            run_id: Some(run.clone()),
            ..Seen::default()
        };
        pump(&ctx, &handle, &sink, &mut events, &progress, &mut seen).await?;
        let status = run_status(&handle.value, Some(&thread), &seen).await;
        Ok(RunStreamSummary {
            run_id: Some(run),
            status,
            events: seen.events,
            last_event_id: seen.last_event_id,
        })
    }

    /// The thread's runs, newest first, a page of at most about 4 MiB: fewer than `limit` when
    /// their metadata is big, with `next` (an offset) for the rest. Metadata over its share comes
    /// back `null` and named in the run's `cuts`; `get` gives it whole.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: RunsListInput) -> ToolResult<RunsPage> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let want = limit("limit", input.limit, 20)? as usize;
        let start = input.offset.unwrap_or(0) as usize;
        let mut offset = start;
        let mut page: Page<Run> = Page::new(REPLY_BUDGET);
        let mut ask = RUNS_FIRST_PAGE;
        let mut fetched = 0;
        let next = loop {
            let take = ask.min(want - page.items.len()).max(1);
            let query = [("limit", take.to_string()), ("offset", offset.to_string())];
            let v = match handle
                .value
                .get(&format!("/threads/{thread}/runs"), &query, "thread")
                .await
            {
                Err(e) if take > 1 && too_big(&e) => {
                    ask = take / 2;
                    continue;
                }
                other => other?,
            };
            let raw: Vec<&Value> = items(&v, "runs").collect();
            let got = raw.len();
            let mut raw_bytes = 0;
            let mut full = false;
            for item in raw {
                raw_bytes += budget::json_len(item);
                let run = Run::from_json(item).within(ITEM_SHARE);
                let weight = run.weight();
                if !page.fits(weight) {
                    full = true;
                    break;
                }
                page.add(run, weight);
            }
            fetched += raw_bytes;
            let consumed = start + page.items.len();
            if full || page.items.len() >= want || (got == take && fetched >= UPSTREAM_BUDGET) {
                break Some(consumed);
            }
            if got < take {
                break None;
            }
            offset = consumed;
            ask = budget::next_page_size(raw_bytes, got, want);
        };
        Ok(RunsPage {
            items: page.items,
            next: next.and_then(|n| u32::try_from(n).ok()),
        })
    }

    /// One run with its request (TSK-96), its metadata and input whole when the run weighs up to
    /// 12 MiB (more: `threads.readValue`).
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: RunIdInput) -> ToolResult<Run> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let run = id("runId", &input.run_id)?;
        let v = handle
            .value
            .get(&format!("/threads/{thread}/runs/{run}"), &[], "run")
            .await?;
        Ok(Run::from_json(&v).with_request(&v).within(FULL_SHARE))
    }

    /// Stops the run where it is (the thread keeps its checkpoints).
    #[rpc::mutation(perm = "langgraph.write", risk = Risk::Write)]
    async fn cancel(&self, ctx: Ctx, input: RunIdInput) -> ToolResult<Empty> {
        self.cancel_with(&ctx, &input, "interrupt").await
    }

    /// Stops the run and deletes it with the checkpoints it wrote.
    #[rpc::mutation(perm = "langgraph.destroy", risk = Risk::Destructive)]
    async fn rollback(&self, ctx: Ctx, input: RunIdInput) -> ToolResult<Empty> {
        self.cancel_with(&ctx, &input, "rollback").await
    }
}

impl RunsApi {
    async fn cancel_with(&self, ctx: &Ctx, input: &RunIdInput, action: &str) -> ToolResult<Empty> {
        let handle = client(&self.0, ctx, &input.conn_id)?;
        let thread = id("threadId", &input.thread_id)?;
        let run = id("runId", &input.run_id)?;
        handle
            .value
            .call(
                Method::POST,
                &format!("/threads/{thread}/runs/{run}/cancel"),
                &[("action", action.to_owned()), ("wait", "true".to_owned())],
                None,
                "run",
            )
            .await?;
        Ok(Empty {})
    }
}

/// `langgraph.store.*`.
pub struct StoreApi(pub Arc<Hub>);

#[rpc::router(namespace = "langgraph.store")]
impl StoreApi {
    /// Namespaces under `prefix`, each a list of labels.
    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn namespaces(
        &self,
        ctx: Ctx,
        input: StoreNamespacesInput,
    ) -> ToolResult<Vec<Vec<String>>> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        let mut body = Map::new();
        body.insert("limit".into(), 1000.into());
        if let Some(prefix) = input.prefix.filter(|p| !p.is_empty()) {
            namespace("prefix", &prefix)?;
            body.insert("prefix".into(), prefix.into());
        }
        if let Some(depth) = input.max_depth {
            body.insert("max_depth".into(), depth.into());
        }
        let v = handle
            .value
            .post("/store/namespaces", &Value::Object(body), "store")
            .await?;
        Ok(items(&v, "namespaces")
            .filter_map(|ns| {
                ns.as_array().map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.as_str().map(str::to_owned))
                        .collect()
                })
            })
            .collect())
    }

    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn search(&self, ctx: Ctx, input: StoreSearchInput) -> ToolResult<Vec<StoreItem>> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        namespace("namespacePrefix", &input.namespace_prefix)?;
        let mut body = Map::new();
        body.insert("namespace_prefix".into(), input.namespace_prefix.into());
        body.insert("limit".into(), limit("limit", input.limit, 50)?.into());
        body.insert("offset".into(), input.offset.unwrap_or(0).into());
        if let Some(query) = input.query.filter(|q| !q.trim().is_empty()) {
            body.insert("query".into(), query.into());
        }
        if let Some(filter) = object("filter", input.filter)? {
            body.insert("filter".into(), filter);
        }
        let v = handle
            .value
            .post("/store/items/search", &Value::Object(body), "store")
            .await?;
        Ok(items(&v, "items").map(StoreItem::from_json).collect())
    }

    #[rpc::query(perm = "langgraph.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: StoreKeyInput) -> ToolResult<StoreItem> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        namespace("namespace", &input.namespace)?;
        let query = [("namespace", input.namespace.join(".")), ("key", input.key)];
        let v = handle.value.get("/store/items", &query, "item").await?;
        if v.is_null() {
            return Err(ToolError::not_found(TOOL, "item", "no item with this key").into());
        }
        Ok(StoreItem::from_json(&v))
    }

    /// Writes an item (a JSON object), replacing the one with the same key.
    #[rpc::mutation(perm = "langgraph.write", risk = Risk::Write)]
    async fn put(&self, ctx: Ctx, input: StorePutInput) -> ToolResult<Empty> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        namespace("namespace", &input.namespace)?;
        if input.namespace.is_empty() {
            return Err(ToolError::invalid(TOOL, "namespace", "at least one label").into());
        }
        if input.key.is_empty() {
            return Err(ToolError::invalid(TOOL, "key", "a key").into());
        }
        if !input.value.is_object() {
            return Err(
                ToolError::invalid(TOOL, "value", "the value must be a JSON object").into(),
            );
        }
        let body = json!({ "namespace": input.namespace, "key": input.key, "value": input.value });
        handle
            .value
            .call(Method::PUT, "/store/items", &[], Some(&body), "store")
            .await?;
        Ok(Empty {})
    }

    #[rpc::mutation(perm = "langgraph.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: StoreKeyInput) -> ToolResult<Empty> {
        let handle = client(&self.0, &ctx, &input.conn_id)?;
        namespace("namespace", &input.namespace)?;
        let body = json!({ "namespace": input.namespace, "key": input.key });
        handle
            .value
            .call(Method::DELETE, "/store/items", &[], Some(&body), "item")
            .await?;
        Ok(Empty {})
    }
}

/// Mounts the tool's APIs.
pub fn mount(router: &ambidex::Router, hub: &Arc<Hub>) -> Result<(), ambidex::RegistryError> {
    router.mount(LanggraphApi(Arc::clone(hub)))?;
    router.mount(AssistantsApi(Arc::clone(hub)))?;
    router.mount(ThreadsApi(Arc::clone(hub)))?;
    router.mount(RunsApi(Arc::clone(hub)))?;
    router.mount(StoreApi(Arc::clone(hub)))?;
    Ok(())
}
