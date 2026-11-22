//! Wire types of the workflow detail (Mightyconsole spec §9.3, §9.6): describe, history, follow
//! and query. Nested protobuf messages travel as protobuf JSON with their payloads decoded (see
//! [`super::payloads`]); the screens read them field by field.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::types::WorkflowRow;

/// Names a workflow run: the run id is the latest run when absent.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRef {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
}

/// Everything `DescribeWorkflowExecution` says, payloads decoded.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDetail {
    pub workflow: WorkflowRow,
    /// The history's size in bytes, as the server counts it (TSK-92; Temporal's limit is 50 MiB).
    pub history_size_bytes: i64,
    /// `WorkflowExecutionConfig`: task queue, timeouts.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub execution_config: Map<String, Value>,
    /// `PendingActivityInfo[]`: type, state, attempt, last failure, heartbeat details, times.
    #[ts(type = "Record<string, unknown>[]")]
    #[schemars(with = "Vec<Map<String, Value>>")]
    pub pending_activities: Vec<Map<String, Value>>,
    /// `PendingChildExecutionInfo[]`.
    #[ts(type = "Record<string, unknown>[]")]
    #[schemars(with = "Vec<Map<String, Value>>")]
    pub pending_children: Vec<Map<String, Value>>,
    /// `PendingWorkflowTaskInfo`, absent when none is pending.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub pending_workflow_task: Option<Map<String, Value>>,
    /// The memo's fields by name, decoded.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub memo: Map<String, Value>,
    /// The search attributes by name, decoded.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub search_attributes: Map<String, Value>,
    /// `ResetPointInfo[]`: the points the server can reset to by itself.
    #[ts(type = "Record<string, unknown>[]")]
    #[schemars(with = "Vec<Map<String, Value>>")]
    pub auto_reset_points: Vec<Map<String, Value>>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// At most this many events, 1 to 1,000; 1,000 when absent. A page also stops at 4 MiB of
    /// reply (TSK-109).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub page_size: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub next_page_token: Option<String>,
    /// Newest first (`GetWorkflowExecutionHistoryReverse`); oldest first when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reverse: Option<bool>,
}

/// What an event is about, for the History filter and the Timeline's lanes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub enum EventCategory {
    Workflow,
    WorkflowTask,
    Activity,
    Timer,
    ChildWorkflow,
    Signal,
    Update,
    Marker,
    Other,
}

/// One event of a workflow's history.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub event_id: i64,
    /// RFC 3339, UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event_time: Option<String>,
    /// `WorkflowExecutionStarted`, `ActivityTaskScheduled`, ... (the enum name in CamelCase).
    pub event_type: String,
    pub category: EventCategory,
    /// The event's own attributes, as protobuf JSON, payloads decoded.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub attributes: Map<String, Value>,
    /// The encodings of the event's payloads as stored, in order (`json/plain`, `binary/encrypted`);
    /// absent when it has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub encodings: Option<Vec<String>>,
    /// The event's encoded size in the history, in bytes (TSK-92).
    pub size: u64,
}

/// One event of a run, to read as stored.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRawEventInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    pub event_id: i64,
}

/// An event's attributes as stored: protobuf JSON with each payload's `metadata` and `data` in base64.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRawEventOutput {
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub attributes: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowHistoryOutput {
    pub events: Vec<HistoryEvent>,
    /// Absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FollowHistoryInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    pub run_id: String,
    /// The last event the screen has; only later events are sent.
    pub from_event_id: u64,
    pub stream_id: String,
}

/// The whole history to save, as a stream (TSK-109).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHistoryInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// Payloads decoded in full, or as stored (what `temporal workflow show --output json` writes).
    pub form: super::large::PayloadForm,
}

/// The end of `downloadHistory`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DownloadHistorySummary {
    pub bytes: u64,
    pub events: u64,
}

/// The end of `followHistory`.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FollowHistorySummary {
    /// The run closed: there is nothing more to follow.
    pub closed: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowQueryInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// `__stack_trace`, or a query the workflow defines.
    pub query_type: String,
    /// Each argument is sent as one `json/plain` payload.
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown[]")]
    #[schemars(with = "Option<Vec<Value>>")]
    pub args: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowQueryOutput {
    /// The result payloads decoded: the value when there is one, an array of them otherwise.
    #[ts(type = "unknown")]
    #[schemars(with = "Value")]
    pub result: Value,
}
