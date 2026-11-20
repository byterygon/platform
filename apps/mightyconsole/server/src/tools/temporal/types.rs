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

/// Temporal External Storage on an S3-compatible store (TSK-103): where the SDKs' S3 driver keeps
/// payloads of 256 KiB or more. Its credentials come beside it as `s3AccessKeyId`,
/// `s3SecretAccessKey` and `s3SessionToken`.
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExternalStorageOptions {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub enabled: Option<bool>,
    /// Where Mightyconsole and the codec endpoint write; read too.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub bucket: Option<String>,
    /// Other buckets references may name (the workers' buckets); `bucket` is always read.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub read_buckets: Option<Vec<String>>,
    /// `us-east-1` when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub region: Option<String>,
    /// `https://s3.<region>.amazonaws.com` when empty; MinIO and other stores give theirs.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub endpoint: Option<String>,
    /// `<endpoint>/<bucket>/<key>` addressing (MinIO and most S3-compatible stores).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub path_style: Option<bool>,
    /// The store's CA (PEM); the system's trust store when empty (spec Open question (b)).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ca_pem: Option<String>,
    /// `aws.s3driver` when empty: the name the workers' driver has.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub driver_name: Option<String>,
    /// Payloads this size or larger are stored outside (262144, the SDKs' default).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub threshold_bytes: Option<u64>,
    /// The largest payload read or written (50 MiB, the Go driver's default).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_payload_bytes: Option<u64>,
}

/// "Test codec" in the profile sheet: the draft profile, and the namespace to sample (the
/// profile's when empty).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalTestCodecInput {
    pub profile: ConnectTemporalProfile,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
}

/// What the codec did with the inputs of the namespace's latest workflows.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalTestCodecOutput {
    pub namespace: String,
    /// The codec's host and port.
    pub codec: String,
    /// The workflows sampled (their inputs' first payload).
    pub workflow_ids: Vec<String>,
    pub sampled: u32,
    /// Payloads the codec changed.
    pub decoded: u32,
    /// Encodings before and after, distinct.
    pub from: Vec<String>,
    pub to: Vec<String>,
    pub ms: u64,
    /// Why the codec failed, when it did.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// One namespace's own codec endpoint.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodecNamespaceEndpoint {
    pub namespace: String,
    pub endpoint: String,
}

/// The profile's payload codec (TSK-92, spec §9.5): a codec server of the user's own that
/// mightyconsole-server calls to decode payloads and encode inputs. Its `Authorization` header
/// comes beside it as `codecAuthorization`.
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadCodecOptions {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub enabled: Option<bool>,
    /// `https://codec.internal:8888`; plain http on localhost only.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub endpoint: Option<String>,
    /// Namespaces with their own endpoint.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespaces: Option<Vec<CodecNamespaceEndpoint>>,
    /// The codec's CA (PEM): the only trusted root (Open question 31).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ca_pem: Option<String>,
    /// Send `X-Namespace` (on when empty).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub send_namespace: Option<bool>,
    /// Encode the inputs Mightyconsole sends through `/encode` (on when empty).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub encode_inputs: Option<bool>,
    /// Per call (10000 when empty).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub timeout_ms: Option<u64>,
}

/// The codec endpoint of a profile (TSK-103): Temporal's codec-server protocol at
/// `/codec/<profileId>/decode` and `/encode` while the profile is connected.
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CodecServerOptions {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub enabled: Option<bool>,
    /// The browser origins allowed to call it (the Temporal Web UI's); callers without an Origin
    /// (the CLI) are accepted.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub allowed_origins: Option<Vec<String>>,
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
    /// External Storage (TSK-103).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub external_storage: Option<ExternalStorageOptions>,
    /// The profile's stable id in the browser: the codec endpoint's path names it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub profile_id: Option<String>,
    /// The payload codec (TSK-92, spec §9.5).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub codec: Option<PayloadCodecOptions>,
    /// The codec's `Authorization` header value; never logged, never sent to the browser again.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub codec_authorization: Option<String>,
    /// Serve the profile on the codec endpoint (TSK-103).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub codec_server: Option<CodecServerOptions>,
    /// The S3 credentials of External Storage; never logged.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub s3_access_key_id: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub s3_secret_access_key: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub s3_session_token: Option<String>,
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

/// What `temporal.info` says about the server.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TemporalInfoOutput {
    pub server_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cluster_name: Option<String>,
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
