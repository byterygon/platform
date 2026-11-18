//! Wire types of the actions, schedules and task queues (Mightyconsole spec §9.3, §9.4, §9.6).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

/// Names a workflow run for an action.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowActionRef {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    /// The latest run when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSignalInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    pub signal_name: String,
    /// Each argument is sent as one `json/plain` payload.
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown[]")]
    #[schemars(with = "Option<Vec<Value>>")]
    pub args: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowReasonInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// Required to terminate; optional to ask for cancellation.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
}

/// Which signals a reset re-applies to the new run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ResetReapply {
    /// Every eligible event after the reset point (signals and updates).
    All,
    Signals,
    None,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResetInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    pub run_id: String,
    /// The event to reset to: a WorkflowTaskCompleted, WorkflowTaskStarted or failed task event.
    pub event_id: u64,
    pub reapply: ResetReapply,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResetOutput {
    /// The new run.
    pub run_id: String,
}

// --- Schedules --------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulesListInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    /// A schedule visibility query; every schedule when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
}

/// One action a schedule took.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleAction {
    /// When it should have run, RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scheduled_time: Option<String>,
    /// When it ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub actual_time: Option<String>,
    pub workflow_id: String,
    pub run_id: String,
    /// `Running`, `Completed`, ... as the workflow's status, when the server says it.
    pub status: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSummary {
    pub schedule_id: String,
    pub workflow_type: String,
    /// The spec in words: "Every 1 minute", "Cron 0 * * * *".
    pub spec: String,
    pub paused: bool,
    /// The note of the last pause or unpause.
    pub notes: String,
    /// The next runs, RFC 3339.
    pub next_runs: Vec<String>,
    pub recent_actions: Vec<ScheduleAction>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRef {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
}

/// Everything `DescribeSchedule` says; the parts are protobuf JSON, payloads decoded.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleDetail {
    pub summary: ScheduleSummary,
    /// `schedule.spec`: intervals, calendars, cron strings, jitter, time zone.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub spec: Map<String, Value>,
    /// `schedule.action`: the workflow it starts (type, id, task queue, input).
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub action: Map<String, Value>,
    /// `schedule.policies`: overlap, catch-up window, pause on failure.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub policies: Map<String, Value>,
    /// `schedule.state`: notes, paused, limited actions.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub state: Map<String, Value>,
    /// `info`: action counts, running workflows, create and update times.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub info: Map<String, Value>,
    /// The schedule as the edit sheet fills it (TSK-92).
    pub form: super::schedule_form::ScheduleForm,
    /// Sent back by `update` so a concurrent change is a conflict, not lost.
    pub conflict_token: String,
}

/// What to do when a triggered run meets one that is still running.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ScheduleOverlap {
    Skip,
    BufferOne,
    BufferAll,
    CancelOther,
    TerminateOther,
    AllowAll,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePatchInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
    /// The note shown with the pause or unpause.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub note: Option<String>,
    /// For `trigger`: the schedule's own policy when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub overlap: Option<ScheduleOverlap>,
}

// --- Task queues ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueDescribeInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub task_queue: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Poller {
    pub identity: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_access_time: Option<String>,
    pub rate_per_second: f64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TaskQueueDescription {
    pub workflow_pollers: Vec<Poller>,
    pub activity_pollers: Vec<Poller>,
    /// Tasks waiting for a poller, when the server reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow_backlog: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub activity_backlog: Option<u64>,
}
