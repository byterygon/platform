//! `temporal.workflows.start` (TSK-92, spec §9.3 "Start workflow", §9.4) and the pieces it shares
//! with schedule create and edit and with standalone activities: durations as people write them
//! ("30s", "5m", "1h30m", "2d"), retry policies, ID policies, memo and search attributes as JSON
//! objects. Inputs are JSON values sent as `json/plain` payloads, one per argument.

use std::collections::HashMap;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::TOOL;
use super::client::{TemporalClient, status_error};
use super::payloads::encode_json;
use super::proto::temporal::api::common::v1::{
    Memo, Payload, Payloads, RetryPolicy, SearchAttributes, WorkflowType,
};
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflowservice::v1 as ws;
use crate::core::{ToolError, random_id};

/// Who the history says started the workflow.
pub(super) const IDENTITY: &str = "mightyconsole";

// --- Durations --------------------------------------------------------------------------------

/// "30s", "5m", "1h30m", "2d", "250ms" or a plain number of seconds; `None` for empty text.
pub fn parse_duration(field: &str, text: &str) -> Result<Option<prost_types::Duration>, ToolError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let invalid = || ToolError::invalid(TOOL, field, "a duration such as 30s, 5m, 1h30m or 2d");
    if let Ok(seconds) = text.parse::<u64>() {
        return Ok(Some(prost_types::Duration {
            seconds: i64::try_from(seconds).map_err(|_| invalid())?,
            nanos: 0,
        }));
    }
    let mut millis: u128 = 0;
    let mut rest = text;
    while !rest.is_empty() {
        let digits = rest
            .find(|c: char| !c.is_ascii_digit())
            .ok_or_else(invalid)?;
        if digits == 0 {
            return Err(invalid());
        }
        let n: u128 = rest[..digits].parse().map_err(|_| invalid())?;
        rest = &rest[digits..];
        let (unit, len) = if rest.starts_with("ms") {
            (1, 2)
        } else {
            match rest.chars().next() {
                Some('s') => (1_000, 1),
                Some('m') => (60_000, 1),
                Some('h') => (3_600_000, 1),
                Some('d') => (86_400_000, 1),
                _ => return Err(invalid()),
            }
        };
        millis = millis
            .checked_add(n.checked_mul(unit).ok_or_else(invalid)?)
            .ok_or_else(invalid)?;
        rest = &rest[len..];
    }
    let seconds = i64::try_from(millis / 1_000).map_err(|_| invalid())?;
    Ok(Some(prost_types::Duration {
        seconds,
        nanos: ((millis % 1_000) * 1_000_000) as i32,
    }))
}

/// A duration as `parse_duration` reads it: "1h30m", "45s", "250ms"; "0s" for zero.
pub fn format_duration(d: &prost_types::Duration) -> String {
    let millis = i128::from(d.seconds) * 1_000 + i128::from(d.nanos / 1_000_000);
    if millis <= 0 {
        return "0s".into();
    }
    let mut out = String::new();
    let mut rest = millis;
    for (unit, name) in [
        (86_400_000, "d"),
        (3_600_000, "h"),
        (60_000, "m"),
        (1_000, "s"),
        (1, "ms"),
    ] {
        let n = rest / unit;
        if n > 0 {
            out.push_str(&format!("{n}{name}"));
            rest -= n * unit;
        }
    }
    out
}

fn duration_of(
    field: &str,
    text: Option<&str>,
) -> Result<Option<prost_types::Duration>, ToolError> {
    parse_duration(field, text.unwrap_or(""))
}

// --- Policies ---------------------------------------------------------------------------------

/// What happens when a closed workflow with the same ID exists (`WorkflowIdReusePolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum IdReusePolicy {
    AllowDuplicate,
    AllowDuplicateFailedOnly,
    RejectDuplicate,
}

impl IdReusePolicy {
    pub fn to_proto(self) -> i32 {
        match self {
            IdReusePolicy::AllowDuplicate => 1,
            IdReusePolicy::AllowDuplicateFailedOnly => 2,
            IdReusePolicy::RejectDuplicate => 3,
        }
    }
}

/// What happens when a running workflow with the same ID exists (`WorkflowIdConflictPolicy`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum IdConflictPolicy {
    Fail,
    UseExisting,
    TerminateExisting,
}

impl IdConflictPolicy {
    pub fn to_proto(self) -> i32 {
        match self {
            IdConflictPolicy::Fail => 1,
            IdConflictPolicy::UseExisting => 2,
            IdConflictPolicy::TerminateExisting => 3,
        }
    }
}

/// A retry policy; empty fields take the server's defaults.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicyForm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub initial_interval: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub backoff_coefficient: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub maximum_interval: Option<String>,
    /// 0 or absent: unlimited.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub maximum_attempts: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub non_retryable_error_types: Option<Vec<String>>,
}

impl RetryPolicyForm {
    pub fn to_proto(&self) -> Result<RetryPolicy, ToolError> {
        if self.backoff_coefficient.is_some_and(|b| b < 1.0) {
            return Err(ToolError::invalid(
                TOOL,
                "retryPolicy.backoffCoefficient",
                "1 or more",
            ));
        }
        if self.maximum_attempts.is_some_and(|n| n < 0) {
            return Err(ToolError::invalid(
                TOOL,
                "retryPolicy.maximumAttempts",
                "0 (unlimited) or more",
            ));
        }
        Ok(RetryPolicy {
            initial_interval: duration_of(
                "retryPolicy.initialInterval",
                self.initial_interval.as_deref(),
            )?,
            backoff_coefficient: self.backoff_coefficient.unwrap_or(0.0),
            maximum_interval: duration_of(
                "retryPolicy.maximumInterval",
                self.maximum_interval.as_deref(),
            )?,
            maximum_attempts: self.maximum_attempts.unwrap_or(0),
            non_retryable_error_types: self.non_retryable_error_types.clone().unwrap_or_default(),
        })
    }

    pub fn from_proto(p: &RetryPolicy) -> RetryPolicyForm {
        RetryPolicyForm {
            initial_interval: p.initial_interval.as_ref().map(format_duration),
            backoff_coefficient: (p.backoff_coefficient > 0.0).then_some(p.backoff_coefficient),
            maximum_interval: p.maximum_interval.as_ref().map(format_duration),
            maximum_attempts: (p.maximum_attempts > 0).then_some(p.maximum_attempts),
            non_retryable_error_types: (!p.non_retryable_error_types.is_empty())
                .then(|| p.non_retryable_error_types.clone()),
        }
    }
}

// --- Payloads ---------------------------------------------------------------------------------

/// Each argument as one `json/plain` payload; `None` for no arguments.
pub fn payloads_of(args: Option<&[Value]>) -> Result<Option<Payloads>, ToolError> {
    let args = args.unwrap_or_default();
    if args.is_empty() {
        return Ok(None);
    }
    Ok(Some(Payloads {
        payloads: args.iter().map(encode_json).collect::<Result<_, _>>()?,
    }))
}

fn payload_map(object: Option<&Map<String, Value>>) -> Result<HashMap<String, Payload>, ToolError> {
    object
        .into_iter()
        .flatten()
        .map(|(k, v)| Ok((k.clone(), encode_json(v)?)))
        .collect()
}

pub fn memo_of(object: Option<&Map<String, Value>>) -> Result<Option<Memo>, ToolError> {
    let fields = payload_map(object)?;
    Ok((!fields.is_empty()).then_some(Memo { fields }))
}

pub fn search_attributes_of(
    object: Option<&Map<String, Value>>,
) -> Result<Option<SearchAttributes>, ToolError> {
    let indexed_fields = payload_map(object)?;
    Ok((!indexed_fields.is_empty()).then_some(SearchAttributes { indexed_fields }))
}

/// A required, trimmed text field.
pub fn required(field: &str, value: &str, what: &str) -> Result<String, ToolError> {
    let v = value.trim();
    if v.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("{what} is required"),
        ));
    }
    Ok(v.to_owned())
}

// --- Start ------------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStartInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub workflow_type: String,
    pub task_queue: String,
    pub workflow_id: String,
    /// One `json/plain` payload per argument.
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown[]")]
    #[schemars(with = "Option<Vec<Value>>")]
    pub args: Option<Vec<Value>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub execution_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub run_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub task_timeout: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub retry_policy: Option<RetryPolicyForm>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub id_reuse_policy: Option<IdReusePolicy>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub id_conflict_policy: Option<IdConflictPolicy>,
    #[serde(default)]
    #[ts(optional = nullable, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub memo: Option<Map<String, Value>>,
    #[serde(default)]
    #[ts(optional = nullable, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub search_attributes: Option<Map<String, Value>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub start_delay: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowStartOutput {
    pub run_id: String,
    /// False when the conflict policy UseExisting returned the running workflow instead.
    pub started: bool,
}

/// `StartWorkflowExecution`.
pub async fn start(
    client: &TemporalClient,
    input: WorkflowStartInput,
) -> Result<WorkflowStartOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let args = super::extstore::offload(
        client.external.as_deref(),
        payloads_of(input.args.as_deref())?,
    )
    .await?;
    let request = ws::StartWorkflowExecutionRequest {
        namespace: namespace.clone(),
        workflow_id: required("workflowId", &input.workflow_id, "a workflow ID")?,
        workflow_type: Some(WorkflowType {
            name: required("workflowType", &input.workflow_type, "a workflow type")?,
        }),
        task_queue: Some(TaskQueue {
            name: required("taskQueue", &input.task_queue, "a task queue")?,
            kind: 1,
            normal_name: String::new(),
        }),
        input: args,
        workflow_execution_timeout: duration_of(
            "executionTimeout",
            input.execution_timeout.as_deref(),
        )?,
        workflow_run_timeout: duration_of("runTimeout", input.run_timeout.as_deref())?,
        workflow_task_timeout: duration_of("taskTimeout", input.task_timeout.as_deref())?,
        identity: IDENTITY.into(),
        request_id: random_id(),
        workflow_id_reuse_policy: input.id_reuse_policy.map_or(0, IdReusePolicy::to_proto),
        workflow_id_conflict_policy: input
            .id_conflict_policy
            .map_or(0, IdConflictPolicy::to_proto),
        retry_policy: input
            .retry_policy
            .as_ref()
            .map(RetryPolicyForm::to_proto)
            .transpose()?,
        memo: memo_of(input.memo.as_ref())?,
        search_attributes: search_attributes_of(input.search_attributes.as_ref())?,
        workflow_start_delay: duration_of("startDelay", input.start_delay.as_deref())?,
        ..Default::default()
    };
    let response = client
        .service()
        .start_workflow_execution(client.request(&namespace, request))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    Ok(WorkflowStartOutput {
        run_id: response.run_id,
        started: response.started,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(text: &str) -> Option<prost_types::Duration> {
        parse_duration("f", text).unwrap()
    }

    #[test]
    fn durations_read_as_people_write_them_and_round_trip() {
        assert_eq!(d(""), None);
        assert_eq!(
            d("90"),
            Some(prost_types::Duration {
                seconds: 90,
                nanos: 0
            })
        );
        assert_eq!(d("1h30m").unwrap().seconds, 5_400);
        assert_eq!(d("2d").unwrap().seconds, 172_800);
        assert_eq!(
            d("1s250ms"),
            Some(prost_types::Duration {
                seconds: 1,
                nanos: 250_000_000
            })
        );
        for bad in ["5x", "m", "1h 30m", "-5s", "1.5s"] {
            assert!(parse_duration("timeout", bad).is_err(), "{bad}");
        }
        for text in ["1h30m", "45s", "250ms", "2d3h", "1m1s1ms"] {
            assert_eq!(format_duration(&d(text).unwrap()), text);
        }
        assert_eq!(format_duration(&prost_types::Duration::default()), "0s");
    }

    #[test]
    fn retry_policies_check_their_numbers_and_round_trip() {
        let form = RetryPolicyForm {
            initial_interval: Some("1s".into()),
            backoff_coefficient: Some(2.0),
            maximum_interval: Some("1m".into()),
            maximum_attempts: Some(3),
            non_retryable_error_types: Some(vec!["BadInput".into()]),
        };
        assert_eq!(RetryPolicyForm::from_proto(&form.to_proto().unwrap()), form);
        let low = RetryPolicyForm {
            backoff_coefficient: Some(0.5),
            ..Default::default()
        };
        assert!(low.to_proto().is_err());
        assert_eq!(
            RetryPolicyForm::from_proto(&RetryPolicy::default()),
            RetryPolicyForm::default()
        );
    }

    #[test]
    fn arguments_memo_and_attributes_become_json_payloads() {
        assert!(payloads_of(None).unwrap().is_none());
        let p = payloads_of(Some(&[serde_json::json!({"a": 1}), serde_json::json!("b")]))
            .unwrap()
            .unwrap();
        assert_eq!(p.payloads.len(), 2);
        assert_eq!(p.payloads[1].data, br#""b""#);
        let memo: Map<String, Value> = serde_json::from_str(r#"{"note":"hi"}"#).unwrap();
        assert_eq!(
            memo_of(Some(&memo)).unwrap().unwrap().fields["note"].data,
            br#""hi""#
        );
        assert!(search_attributes_of(Some(&Map::new())).unwrap().is_none());
        assert!(required("workflowId", "  ", "a workflow ID").is_err());
    }
}
