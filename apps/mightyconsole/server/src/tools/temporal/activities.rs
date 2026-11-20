//! Standalone activities (TSK-92, spec §9.3 "Activities", §9.4): activities run without a
//! workflow, with their own ID, retries and timeouts. Temporal Server 1.31 or newer runs them, in
//! public preview, when they are enabled on the namespace (`activity.enableStandalone`); a server
//! without them answers "Standalone activity is disabled" or does not know the methods, and every
//! procedure here says so in the same words (`remote.name = "StandaloneActivitiesUnsupported"`).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tonic::Status;
use ts_rs::TS;

use super::client::{TemporalClient, status_error};
use super::detail::to_json_resolved;
use super::proto::temporal::api::activity::v1::ActivityExecutionListInfo;
use super::proto::temporal::api::common::v1::ActivityType;
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::start::{
    IDENTITY, IdReusePolicy, RetryPolicyForm, parse_duration, payloads_of, required,
};
use super::{DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, TOOL, decode_token, encode_token, millis, rfc3339};
use crate::core::{RemoteError, ToolError, ToolErrorKind, random_id};

/// `remote.name` of the error a server without standalone activities gives.
pub const UNSUPPORTED: &str = "StandaloneActivitiesUnsupported";

/// What the spec says they need, after the server's own words.
const NEEDS: &str = "Standalone activities need Temporal Server 1.31 or newer, enabled on the namespace (public preview).";

/// Whether the server runs standalone activities on the profile's namespace (`temporal.connect`'s
/// capabilities, from a `CountActivityExecutions` at connect).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StandaloneActivitiesSupport {
    pub supported: bool,
    /// Why not, when not.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

/// A server error, or the "not supported" one when the server lacks standalone activities.
fn activity_error(address: &str, status: &Status) -> ToolError {
    let message = status.message().to_lowercase();
    let disabled = message.contains("standalone activit")
        && (message.contains("disabled")
            || message.contains("not enabled")
            || message.contains("not supported"));
    if status.code() == tonic::Code::Unimplemented || disabled {
        let said = if status.message().is_empty() {
            format!("{:?}", status.code())
        } else {
            status.message().trim_end_matches('.').to_owned()
        };
        return ToolError::new(
            ToolErrorKind::Remote,
            TOOL,
            format!("This server does not run standalone activities: {said}. {NEEDS}"),
        )
        .with_remote(RemoteError {
            code: format!("{:?}", status.code()),
            name: Some(UNSUPPORTED.into()),
            detail: Some(status.message().to_owned()).filter(|m| !m.is_empty()),
        });
    }
    status_error(address, status)
}

/// Asks the server (a count on the namespace); never fails the connection.
pub async fn support(client: &TemporalClient, namespace: &str) -> StandaloneActivitiesSupport {
    match client
        .service()
        .count_activity_executions(client.request(
            namespace,
            ws::CountActivityExecutionsRequest {
                namespace: namespace.to_owned(),
                query: String::new(),
            },
        ))
        .await
    {
        Ok(_) => StandaloneActivitiesSupport {
            supported: true,
            reason: None,
        },
        Err(status) => StandaloneActivitiesSupport {
            supported: false,
            reason: Some(activity_error(&client.address, &status).message),
        },
    }
}

// --- Types ------------------------------------------------------------------------------------

/// The status of a standalone activity (`ActivityExecutionStatus`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub enum ActivityStatus {
    Running,
    Completed,
    Failed,
    Canceled,
    Terminated,
    TimedOut,
    Paused,
    Unspecified,
}

impl ActivityStatus {
    pub fn from_proto(value: i32) -> ActivityStatus {
        match value {
            1 => ActivityStatus::Running,
            2 => ActivityStatus::Completed,
            3 => ActivityStatus::Failed,
            4 => ActivityStatus::Canceled,
            5 => ActivityStatus::Terminated,
            6 => ActivityStatus::TimedOut,
            7 => ActivityStatus::Paused,
            _ => ActivityStatus::Unspecified,
        }
    }
}

/// Where a running activity is (`PendingActivityState`).
fn run_state(value: i32) -> Option<&'static str> {
    match value {
        1 => Some("Scheduled"),
        2 => Some("Started"),
        3 => Some("CancelRequested"),
        4 => Some("Paused"),
        5 => Some("PauseRequested"),
        _ => None,
    }
}

/// Why an activity stopped retrying (`RetryState`).
fn retry_state(value: i32) -> Option<&'static str> {
    match value {
        1 => Some("InProgress"),
        2 => Some("NonRetryableFailure"),
        3 => Some("Timeout"),
        4 => Some("MaximumAttemptsReached"),
        5 => Some("RetryPolicyNotSet"),
        6 => Some("InternalServerError"),
        7 => Some("CancelRequested"),
        _ => None,
    }
}

/// One row of the Activities table.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRow {
    pub activity_id: String,
    pub run_id: String,
    pub activity_type: String,
    pub status: ActivityStatus,
    /// When it was scheduled, RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub close_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<i64>,
    pub task_queue: String,
}

fn row(info: &ActivityExecutionListInfo) -> ActivityRow {
    ActivityRow {
        activity_id: info.activity_id.clone(),
        run_id: info.run_id.clone(),
        activity_type: info
            .activity_type
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_default(),
        status: ActivityStatus::from_proto(info.status),
        start_time: info.schedule_time.as_ref().and_then(rfc3339),
        close_time: info.close_time.as_ref().and_then(rfc3339),
        duration_ms: info.execution_duration.as_ref().map(millis),
        task_queue: info.task_queue.clone(),
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivitiesListInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    /// A visibility query (`ActivityType = "charge" AND ExecutionStatus = "Running"`); every
    /// standalone activity when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
    /// 1 to 1,000; 50 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub page_size: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivitiesListOutput {
    pub executions: Vec<ActivityRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_page_token: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivitiesCountInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivitiesCountOutput {
    pub count: i64,
}

/// One standalone activity; the latest run of the ID when `runId` is absent.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRef {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub activity_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
}

/// A standalone activity in full, its payloads decoded.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDetail {
    pub activity: ActivityRow,
    /// Where a running one is: Scheduled, Started, CancelRequested, Paused, PauseRequested.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_state: Option<String>,
    /// The current or last attempt, from 1.
    pub attempt: i32,
    /// `ActivityExecutionInfo` as protobuf JSON, payloads decoded (timeouts, retry policy,
    /// heartbeat, last failure, last worker...), the fields of `activity` left out.
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub info: Map<String, Value>,
    /// One decoded value per argument.
    #[ts(type = "unknown[]")]
    #[schemars(with = "Vec<Value>")]
    pub input: Vec<Value>,
    /// One decoded value per result payload, when it completed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown[]")]
    #[schemars(with = "Option<Vec<Value>>")]
    pub result: Option<Vec<Value>>,
    /// The failure as protobuf JSON, when it failed, timed out, was canceled or terminated.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub failure: Option<Map<String, Value>>,
    /// Why it stopped retrying, when it closed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retry_state: Option<String>,
}

/// What happens when a running activity with the same ID exists (`ActivityIdConflictPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum ActivityIdConflictPolicy {
    Fail,
    UseExisting,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStartInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub activity_type: String,
    pub task_queue: String,
    pub activity_id: String,
    /// One `json/plain` payload per argument.
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown[]")]
    #[schemars(with = "Option<Vec<Value>>")]
    pub args: Option<Vec<Value>>,
    /// One attempt; this or `scheduleToCloseTimeout` is required.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub start_to_close_timeout: Option<String>,
    /// All attempts.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schedule_to_close_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schedule_to_start_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub heartbeat_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retry_policy: Option<RetryPolicyForm>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub id_reuse_policy: Option<IdReusePolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub id_conflict_policy: Option<ActivityIdConflictPolicy>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityStartOutput {
    pub run_id: String,
    /// False when the conflict policy UseExisting returned the running activity instead.
    pub started: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ActivityReasonInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub activity_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_id: Option<String>,
    /// Required to terminate; optional to ask for cancellation.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reason: Option<String>,
}

// --- Procedures -------------------------------------------------------------------------------

/// One page of standalone activities matching a visibility query (`ListActivityExecutions`).
pub async fn list(
    client: &TemporalClient,
    input: ActivitiesListInput,
) -> Result<ActivitiesListOutput, ToolError> {
    let page_size = input.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(ToolError::invalid(TOOL, "pageSize", "1 to 1000"));
    }
    let next_page_token = decode_token(input.next_page_token.as_deref())?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .list_activity_executions(client.request(
            &namespace,
            ws::ListActivityExecutionsRequest {
                namespace: namespace.clone(),
                page_size: page_size as i32,
                next_page_token,
                query: input.query.unwrap_or_default().trim().to_owned(),
            },
        ))
        .await
        .map_err(|s| activity_error(&client.address, &s))?
        .into_inner();
    Ok(ActivitiesListOutput {
        executions: response.executions.iter().map(row).collect(),
        next_page_token: encode_token(&response.next_page_token),
    })
}

/// How many standalone activities a visibility query matches (`CountActivityExecutions`).
pub async fn count(
    client: &TemporalClient,
    input: ActivitiesCountInput,
) -> Result<ActivitiesCountOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .count_activity_executions(client.request(
            &namespace,
            ws::CountActivityExecutionsRequest {
                namespace: namespace.clone(),
                query: input.query.unwrap_or_default().trim().to_owned(),
            },
        ))
        .await
        .map_err(|s| activity_error(&client.address, &s))?
        .into_inner();
    Ok(ActivitiesCountOutput {
        count: response.count,
    })
}

fn object(value: Option<Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Decoded payloads as their values: `[...]` as `decode_payloads` leaves them, or `{payloads}`.
fn values(value: Option<Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(items)) => items,
        Some(Value::Object(mut map)) => match map.remove("payloads") {
            Some(Value::Array(items)) => items,
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

/// `DescribeActivityExecution` with its input, outcome, heartbeat details and last failure, every
/// payload read from External Storage and through the profile's codec first.
pub async fn describe(
    client: &TemporalClient,
    input: ActivityRef,
) -> Result<ActivityDetail, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .describe_activity_execution(client.request(
            &namespace,
            ws::DescribeActivityExecutionRequest {
                namespace: namespace.clone(),
                activity_id: required("activityId", &input.activity_id, "an activity ID")?,
                run_id: input.run_id.unwrap_or_default().trim().to_owned(),
                include_input: true,
                include_outcome: true,
                long_poll_token: Vec::new(),
                include_heartbeat_details: true,
                include_last_failure: true,
            },
        ))
        .await
        .map_err(|s| activity_error(&client.address, &s))?
        .into_inner();
    let info = response.info.clone().unwrap_or_default();
    let mut json = object(Some(
        to_json_resolved(
            client,
            &namespace,
            "temporal.api.workflowservice.v1.DescribeActivityExecutionResponse",
            &response,
        )
        .await?,
    ));
    let mut info_json = object(json.remove("info"));
    for shown in [
        "activityId",
        "runId",
        "activityType",
        "status",
        "runState",
        "taskQueue",
        "attempt",
        "scheduleTime",
        "closeTime",
        "executionDuration",
    ] {
        info_json.remove(shown);
    }
    let mut outcome = object(json.remove("outcome"));
    let outcome_retry = response
        .outcome
        .as_ref()
        .and_then(|o| retry_state(o.retry_state));
    Ok(ActivityDetail {
        activity: ActivityRow {
            activity_id: info.activity_id.clone(),
            run_id: if info.run_id.is_empty() {
                response.run_id.clone()
            } else {
                info.run_id.clone()
            },
            activity_type: info
                .activity_type
                .as_ref()
                .map(|t| t.name.clone())
                .unwrap_or_default(),
            status: ActivityStatus::from_proto(info.status),
            start_time: info.schedule_time.as_ref().and_then(rfc3339),
            close_time: info.close_time.as_ref().and_then(rfc3339),
            duration_ms: info.execution_duration.as_ref().map(millis),
            task_queue: info.task_queue.clone(),
        },
        run_state: (ActivityStatus::from_proto(info.status) == ActivityStatus::Running)
            .then(|| run_state(info.run_state))
            .flatten()
            .map(str::to_owned),
        attempt: info.attempt,
        info: info_json,
        input: values(json.remove("input")),
        result: outcome.remove("result").map(|r| values(Some(r))),
        failure: outcome.remove("failure").map(|f| object(Some(f))),
        retry_state: outcome_retry.map(str::to_owned),
    })
}

/// `StartActivityExecution`: the arguments through the codec and External Storage as a workflow's.
pub async fn start(
    client: &TemporalClient,
    input: ActivityStartInput,
) -> Result<ActivityStartOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let start_to_close = parse_duration(
        "startToCloseTimeout",
        input.start_to_close_timeout.as_deref().unwrap_or(""),
    )?;
    let schedule_to_close = parse_duration(
        "scheduleToCloseTimeout",
        input.schedule_to_close_timeout.as_deref().unwrap_or(""),
    )?;
    if start_to_close.is_none() && schedule_to_close.is_none() {
        return Err(ToolError::invalid(
            TOOL,
            "startToCloseTimeout",
            "start-to-close or schedule-to-close: at least one of the two timeouts is required",
        ));
    }
    let request = ws::StartActivityExecutionRequest {
        namespace: namespace.clone(),
        identity: IDENTITY.into(),
        request_id: random_id(),
        activity_id: required("activityId", &input.activity_id, "an activity ID")?,
        activity_type: Some(ActivityType {
            name: required("activityType", &input.activity_type, "an activity type")?,
        }),
        task_queue: Some(TaskQueue {
            name: required("taskQueue", &input.task_queue, "a task queue")?,
            kind: 1,
            normal_name: String::new(),
        }),
        schedule_to_close_timeout: schedule_to_close,
        schedule_to_start_timeout: parse_duration(
            "scheduleToStartTimeout",
            input.schedule_to_start_timeout.as_deref().unwrap_or(""),
        )?,
        start_to_close_timeout: start_to_close,
        heartbeat_timeout: parse_duration(
            "heartbeatTimeout",
            input.heartbeat_timeout.as_deref().unwrap_or(""),
        )?,
        retry_policy: input
            .retry_policy
            .as_ref()
            .map(RetryPolicyForm::to_proto)
            .transpose()?,
        id_reuse_policy: input.id_reuse_policy.map_or(0, IdReusePolicy::to_proto),
        id_conflict_policy: match input.id_conflict_policy {
            None => 0,
            Some(ActivityIdConflictPolicy::Fail) => 1,
            Some(ActivityIdConflictPolicy::UseExisting) => 2,
        },
        input: super::extstore::offload(client, &namespace, payloads_of(input.args.as_deref())?)
            .await?,
        ..Default::default()
    };
    let response = client
        .service()
        .start_activity_execution(client.request(&namespace, request))
        .await
        .map_err(|s| activity_error(&client.address, &s))?
        .into_inner();
    Ok(ActivityStartOutput {
        run_id: response.run_id,
        started: response.started,
    })
}

/// `RequestCancelActivityExecution`: the worker sees it at its next heartbeat.
pub async fn cancel(client: &TemporalClient, input: ActivityReasonInput) -> Result<(), ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .request_cancel_activity_execution(client.request(
            &namespace,
            ws::RequestCancelActivityExecutionRequest {
                namespace: namespace.clone(),
                activity_id: required("activityId", &input.activity_id, "an activity ID")?,
                run_id: input.run_id.unwrap_or_default().trim().to_owned(),
                identity: IDENTITY.into(),
                request_id: random_id(),
                reason: input.reason.unwrap_or_default().trim().to_owned(),
            },
        ))
        .await
        .map_err(|s| activity_error(&client.address, &s))?;
    Ok(())
}

/// `TerminateActivityExecution`: ends it at once; the reason is required.
pub async fn terminate(
    client: &TemporalClient,
    input: ActivityReasonInput,
) -> Result<(), ToolError> {
    let reason = required("reason", input.reason.as_deref().unwrap_or(""), "a reason")?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .terminate_activity_execution(client.request(
            &namespace,
            ws::TerminateActivityExecutionRequest {
                namespace: namespace.clone(),
                activity_id: required("activityId", &input.activity_id, "an activity ID")?,
                run_id: input.run_id.unwrap_or_default().trim().to_owned(),
                identity: IDENTITY.into(),
                request_id: random_id(),
                reason,
            },
        ))
        .await
        .map_err(|s| activity_error(&client.address, &s))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_follow_the_proto_enum() {
        assert_eq!(ActivityStatus::from_proto(1), ActivityStatus::Running);
        assert_eq!(ActivityStatus::from_proto(6), ActivityStatus::TimedOut);
        assert_eq!(ActivityStatus::from_proto(7), ActivityStatus::Paused);
        assert_eq!(ActivityStatus::from_proto(42), ActivityStatus::Unspecified);
        assert_eq!(run_state(3), Some("CancelRequested"));
        assert_eq!(retry_state(4), Some("MaximumAttemptsReached"));
    }

    #[test]
    fn a_server_without_them_says_so_and_what_they_need() {
        let disabled = activity_error(
            "lab:7233",
            &Status::failed_precondition("Standalone activity is disabled"),
        );
        assert_eq!(
            disabled.message,
            format!(
                "This server does not run standalone activities: Standalone activity is disabled. {NEEDS}"
            )
        );
        assert_eq!(disabled.remote.unwrap().name.as_deref(), Some(UNSUPPORTED));
        let old = activity_error("lab:7233", &Status::unimplemented(""));
        assert!(old.message.contains("Unimplemented"), "{}", old.message);
        // Any other error stays as the server gave it.
        let missing = activity_error("lab:7233", &Status::not_found("activity not found"));
        assert_eq!(missing.kind, ToolErrorKind::NotFound);
        assert!(missing.remote.and_then(|r| r.name).is_none());
    }

    #[test]
    fn decoded_payloads_read_as_values() {
        assert_eq!(
            values(Some(serde_json::json!([1, "a"]))),
            vec![serde_json::json!(1), serde_json::json!("a")]
        );
        assert_eq!(
            values(Some(serde_json::json!({ "payloads": [true] }))),
            vec![serde_json::json!(true)]
        );
        assert!(values(None).is_empty());
    }
}
