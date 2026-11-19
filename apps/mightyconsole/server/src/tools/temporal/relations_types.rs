//! Wire types of a workflow's relations (Mightyconsole spec §9.3 "Workflow: Relations", §9.6
//! `temporal.workflows.relations`, TSK-104): the boxes and arrows of the graph and the side's lists.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::types::{WorkflowRow, WorkflowStatus};

/// Whole family (every workflow under the root) or Direct only (one level each way).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RelationScope {
    #[default]
    Family,
    Direct,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRelationsInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_id: String,
    /// The latest run when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// `family` when absent; a server without `RootWorkflowId` answers as `direct`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub scope: Option<RelationScope>,
}

/// One box of the graph: a workflow, by its ID (its latest run seen).
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationNode {
    pub workflow_id: String,
    /// Empty when only the workflow ID is known (a child that did not start).
    pub run_id: String,
    pub workflow_type: String,
    pub status: WorkflowStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub close_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_workflow_id: Option<String>,
    /// Depth below the top drawn level (0); absent for a workflow outside the tree (the other end
    /// of a signal or cancel).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub level: Option<u32>,
    /// The failure's message, for a failed child (from this run's history).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<String>,
    /// Gone from the server (past retention, or never started).
    pub missing: bool,
    /// The run the tab shows.
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RelationEdgeKind {
    Child,
    Signal,
    Cancel,
}

/// An arrow: parent to child, or the sender of a signal or cancel to its target.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationEdge {
    pub from: String,
    pub to: String,
    pub kind: RelationEdgeKind,
    /// The signal's name.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub label: Option<String>,
    /// The event of this run that records it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub event_id: Option<i64>,
}

/// The parent, with what happens to this child when it closes (while the child is pending in it).
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationParent {
    pub workflow_id: String,
    pub run_id: String,
    /// `Terminate`, `Abandon` or `RequestCancel`.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_close_policy: Option<String>,
}

/// A child started by this run, from its history.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationChild {
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    pub workflow_type: String,
    /// `Running` once started; `Unspecified` while only initiated or when it could not start.
    pub status: WorkflowStatus,
    pub initiated_event_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub close_time: Option<String>,
    /// The failure's message, or why it could not start.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum SignalDirection {
    Received,
    Sent,
}

/// A signal or cancel between this run and another workflow, from this run's history.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationSignal {
    pub direction: SignalDirection,
    /// `signal` or `cancel`.
    pub kind: RelationEdgeKind,
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub signal_name: Option<String>,
    pub event_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub time: Option<String>,
    /// For a sent one: `Delivered`, `Failed: <cause>`, or absent while in flight.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub outcome: Option<String>,
}

/// Another run of the same workflow ID, and why it exists.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RunLink {
    pub run_id: String,
    /// `Workflow` (continue-as-new), `Retry` or `CronSchedule`; absent for a reset.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub initiator: Option<String>,
}

/// The run's place in its chain of runs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationRuns {
    /// The first run of the chain, when it is another run.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_run_id: Option<String>,
    /// The run this one continued from (continue-as-new, retry or cron).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continued_from: Option<RunLink>,
    /// The run that continued this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub continued_as: Option<RunLink>,
    /// The run this one was reset from.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_from: Option<String>,
    /// The latest run made by resetting this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reset_to: Option<String>,
}

/// What the server can say about the family, and how much of it is drawn.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RelationFamily {
    /// The scope the answer is for (`direct` when the server cannot list the family).
    pub scope: RelationScope,
    /// The server's visibility knows `RootWorkflowId` (Temporal Server 1.24 and later).
    pub supported: bool,
    /// Why Whole family is not offered: the server's answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
    /// The Workflows query that lists the scope's workflows; absent when the server has no
    /// attribute for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub query: Option<String>,
    /// Workflows in the family (every run), as the server counts them; absent when unsupported.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub total: Option<i64>,
    /// Boxes drawn in the tree (the other ends of signals not counted).
    pub drawn: u32,
    /// Levels drawn.
    pub levels: u32,
    /// Workflows of the family left out of the drawing.
    pub not_drawn: u32,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRelations {
    /// The run the tab shows.
    pub workflow: WorkflowRow,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub root_workflow_id: Option<String>,
    pub nodes: Vec<RelationNode>,
    pub edges: Vec<RelationEdge>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent: Option<RelationParent>,
    pub children: Vec<RelationChild>,
    pub signals: Vec<RelationSignal>,
    pub runs: RelationRuns,
    pub family: RelationFamily,
}
