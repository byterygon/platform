//! Wire types of the Temporal tool (Mightyconsole spec §9.1, §9.6). camelCase; optional inputs
//! are `#[serde(default)]` with `#[ts(optional = nullable)]`, outputs left out when empty are
//! `#[ts(optional)]` (CLAUDE.md, codegen).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// TLS settings of a profile (spec §4.2 `TemporalTlsOptions`); `secrets.clientKeyPem` comes beside it as
/// `clientKeyPem`. There is no "skip verification" (spec Open question 6).
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalTlsOptions {
    pub enabled: bool,
    /// Extra trusted CA certificates (PEM); the operating system's roots are used as well.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ca_pem: Option<String>,
    /// Client certificate chain (PEM) for mTLS.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub client_cert_pem: Option<String>,
    /// The name to verify the server certificate against, when it is not the address's host.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub server_name: Option<String>,
}

/// The Temporal profile as `toConnect` builds it (spec §9.1).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectTemporalProfile {
    pub name: String,
    /// `host:port` of the frontend; 127.0.0.1:7233 when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub address: Option<String>,
    /// The namespace opened first; `default` when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tls: Option<TemporalTlsOptions>,
    /// The client certificate's private key (PEM); never logged.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub client_key_pem: Option<String>,
    /// Sent as `Authorization: Bearer`; never logged.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalConnectInput {
    pub profile: ConnectTemporalProfile,
}

/// What the server reports about itself.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalCapabilities {
    /// Signals and queries carry headers.
    pub signal_and_query_header: bool,
    /// Which store holds visibility (`cassandra`, `mysql8`, `postgres12`, `sqlite`,
    /// `elasticsearch`, ...); empty when the cluster did not say. Cassandra has basic visibility
    /// only, so the list's query bar is limited (spec §9.3).
    pub visibility_store: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalConnectOutput {
    pub conn_id: String,
    pub server_version: String,
    /// The cluster's name, when it reported one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cluster_name: Option<String>,
    pub capabilities: TemporalCapabilities,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalConnIdInput {
    pub conn_id: String,
}

/// One namespace of the cluster.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceSummary {
    pub name: String,
    /// `Registered`, `Deprecated`, `Deleted` or `Unspecified`.
    pub state: String,
    /// How long closed workflows are kept, in seconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retention_secs: Option<i64>,
    pub description: String,
    pub owner_email: String,
    pub is_global: bool,
    /// The namespace the profile opened first.
    pub is_default: bool,
}

/// The execution status of a workflow (`WorkflowExecutionStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub enum WorkflowStatus {
    Running,
    Completed,
    Failed,
    Canceled,
    Terminated,
    ContinuedAsNew,
    TimedOut,
    Paused,
    Unspecified,
}

impl WorkflowStatus {
    pub fn from_proto(value: i32) -> WorkflowStatus {
        match value {
            1 => WorkflowStatus::Running,
            2 => WorkflowStatus::Completed,
            3 => WorkflowStatus::Failed,
            4 => WorkflowStatus::Canceled,
            5 => WorkflowStatus::Terminated,
            6 => WorkflowStatus::ContinuedAsNew,
            7 => WorkflowStatus::TimedOut,
            8 => WorkflowStatus::Paused,
            _ => WorkflowStatus::Unspecified,
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsListInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    /// A visibility query (`WorkflowType = "Order" AND ExecutionStatus = "Running"`); every
    /// workflow when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
    /// 1 to 1,000; 50 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub page_size: Option<u32>,
    /// The `nextPageToken` of the previous page.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub next_page_token: Option<String>,
}

/// One row of the workflow list.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRow {
    pub workflow_id: String,
    pub run_id: String,
    pub workflow_type: String,
    pub status: WorkflowStatus,
    /// RFC 3339, UTC.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub close_time: Option<String>,
    /// Close (or now, while running) minus start, in milliseconds, as the server reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<i64>,
    pub task_queue: String,
    pub history_length: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub parent_workflow_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsListOutput {
    pub executions: Vec<WorkflowRow>,
    /// Absent on the last page.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsCountInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
}

/// The number of workflows a query matches.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowsCountOutput {
    pub count: i64,
}
