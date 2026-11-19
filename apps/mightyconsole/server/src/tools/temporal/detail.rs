//! The workflow detail over the gRPC API (spec §9.3, §9.6): describe, history pages, following a
//! run's history, and queries. Plain functions on a [`TemporalClient`], so the lab tests call
//! them directly and the procedures in `mod.rs` stay thin.

use serde_json::{Map, Value};

use super::client::{TemporalClient, status_error};
use super::detail_types::{
    EventCategory, HistoryEvent, WorkflowDetail, WorkflowHistoryInput, WorkflowHistoryOutput,
    WorkflowQueryInput, WorkflowQueryOutput, WorkflowRawEventInput, WorkflowRawEventOutput,
    WorkflowRef,
};
use super::payloads::{decode_payloads, encode_json, payload_encodings, to_json_raw};
use super::proto::temporal::api::common::v1::{Payloads, WorkflowExecution};
use super::proto::temporal::api::history::v1::HistoryEvent as ProtoEvent;
use super::proto::temporal::api::query::v1::WorkflowQuery;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::{TOOL, decode_token, encode_token, row};
use crate::core::ToolError;

const HISTORY_PAGE: u32 = 1_000;

pub(super) fn execution(
    workflow_id: &str,
    run_id: Option<&str>,
) -> Result<WorkflowExecution, ToolError> {
    if workflow_id.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "workflowId",
            "a workflow id is required",
        ));
    }
    Ok(WorkflowExecution {
        workflow_id: workflow_id.to_owned(),
        run_id: run_id.map(str::trim).unwrap_or_default().to_owned(),
    })
}

/// `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` as `WorkflowExecutionStarted`.
pub fn event_type_name(event_type: i32) -> (String, EventCategory) {
    use super::proto::temporal::api::enums::v1::EventType;
    let Ok(kind) = EventType::try_from(event_type) else {
        return (format!("Unknown{event_type}"), EventCategory::Other);
    };
    let shouty = kind.as_str_name().trim_start_matches("EVENT_TYPE_");
    let name: String = shouty
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|c| c.to_string() + &chars.as_str().to_ascii_lowercase())
                .unwrap_or_default()
        })
        .collect();
    let category = if shouty.starts_with("WORKFLOW_EXECUTION_UPDATE") {
        EventCategory::Update
    } else if shouty.starts_with("WORKFLOW_EXECUTION_SIGNALED")
        || shouty.contains("SIGNAL_EXTERNAL")
        || shouty.starts_with("EXTERNAL_WORKFLOW_EXECUTION_SIGNALED")
    {
        EventCategory::Signal
    } else if shouty.starts_with("WORKFLOW_TASK") {
        EventCategory::WorkflowTask
    } else if shouty.starts_with("ACTIVITY_TASK") {
        EventCategory::Activity
    } else if shouty.starts_with("TIMER") {
        EventCategory::Timer
    } else if shouty.contains("CHILD_WORKFLOW") {
        EventCategory::ChildWorkflow
    } else if shouty.starts_with("MARKER") {
        EventCategory::Marker
    } else if shouty.starts_with("WORKFLOW_EXECUTION") {
        EventCategory::Workflow
    } else {
        EventCategory::Other
    };
    (name, category)
}

/// Events as the UI reads them, their External Storage references resolved (TSK-103).
pub async fn history_events<'a>(
    client: &TemporalClient,
    namespace: &str,
    events: impl IntoIterator<Item = &'a ProtoEvent>,
) -> Result<Vec<HistoryEvent>, ToolError> {
    let events: Vec<&ProtoEvent> = events.into_iter().collect();
    let mut raws = Value::Array(
        events
            .iter()
            .map(|e| to_json_raw("temporal.api.history.v1.HistoryEvent", *e))
            .collect::<Result<Vec<_>, _>>()?,
    );
    super::extstore::resolve_json(client.external.as_deref(), namespace, &mut raws).await;
    let Value::Array(raws) = raws else {
        unreachable!("an array stays an array")
    };
    events
        .into_iter()
        .zip(raws)
        .map(|(e, raw)| history_event_from(e, raw))
        .collect()
}

/// A message as JSON with its payloads decoded, External Storage references resolved first.
pub async fn to_json_resolved<M: prost::Message>(
    client: &TemporalClient,
    namespace: &str,
    full_name: &str,
    message: &M,
) -> Result<Value, ToolError> {
    let mut value = to_json_raw(full_name, message)?;
    super::extstore::resolve_json(client.external.as_deref(), namespace, &mut value).await;
    decode_payloads(&mut value);
    Ok(value)
}

/// One event as the UI reads it, from its raw JSON (External Storage references already resolved):
/// the envelope typed, the attributes as decoded protobuf JSON.
fn history_event_from(event: &ProtoEvent, raw: Value) -> Result<HistoryEvent, ToolError> {
    let encodings = payload_encodings(&raw);
    let mut decoded = raw;
    decode_payloads(&mut decoded);
    let Value::Object(mut json) = decoded else {
        return Err(ToolError::new(
            crate::core::ToolErrorKind::Remote,
            TOOL,
            "a history event is not an object",
        ));
    };
    let (event_type, category) = event_type_name(event.event_type);
    // The attributes are the one `...EventAttributes` member (the oneof).
    let key = json.keys().find(|k| k.ends_with("Attributes")).cloned();
    let attributes = match key.and_then(|k| json.remove(&k)) {
        Some(Value::Object(attributes)) => attributes,
        _ => Map::new(),
    };
    Ok(HistoryEvent {
        event_id: event.event_id,
        event_time: event.event_time.as_ref().and_then(super::rfc3339),
        event_type,
        category,
        attributes,
        encodings: (!encodings.is_empty()).then_some(encodings),
    })
}

/// One event of a run with its payloads as stored, found by paging the history up to it.
pub async fn raw_event(
    client: &TemporalClient,
    input: WorkflowRawEventInput,
) -> Result<WorkflowRawEventOutput, ToolError> {
    if input.event_id < 1 {
        return Err(ToolError::invalid(TOOL, "eventId", "1 or more"));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let mut token = Vec::new();
    loop {
        let response = client
            .service()
            .get_workflow_execution_history(client.request(
                &namespace,
                ws::GetWorkflowExecutionHistoryRequest {
                    namespace: namespace.clone(),
                    execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                    maximum_page_size: HISTORY_PAGE as i32,
                    next_page_token: token,
                    ..Default::default()
                },
            ))
            .await
            .map_err(|s| status_error(&client.address, &s))?
            .into_inner();
        let events = response.history.unwrap_or_default().events;
        if let Some(event) = events.iter().find(|e| e.event_id == input.event_id) {
            let Value::Object(mut json) =
                to_json_raw("temporal.api.history.v1.HistoryEvent", event)?
            else {
                return Err(ToolError::new(
                    crate::core::ToolErrorKind::Remote,
                    TOOL,
                    "a history event is not an object",
                ));
            };
            let key = json.keys().find(|k| k.ends_with("Attributes")).cloned();
            let attributes = match key.and_then(|k| json.remove(&k)) {
                Some(Value::Object(attributes)) => attributes,
                _ => Map::new(),
            };
            return Ok(WorkflowRawEventOutput { attributes });
        }
        let past = events.last().is_some_and(|e| e.event_id > input.event_id);
        if past || response.next_page_token.is_empty() {
            return Err(ToolError::not_found(
                TOOL,
                "event",
                format!("no event {} in this run", input.event_id),
            ));
        }
        token = response.next_page_token;
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn objects(value: Option<Value>) -> Vec<Map<String, Value>> {
    match value {
        Some(Value::Array(items)) => items.into_iter().map(object).collect(),
        _ => Vec::new(),
    }
}

/// `DescribeWorkflowExecution`: the row, the config, pending work, memo and search attributes.
pub async fn describe(
    client: &TemporalClient,
    input: WorkflowRef,
) -> Result<WorkflowDetail, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .describe_workflow_execution(client.request(
            &namespace,
            ws::DescribeWorkflowExecutionRequest {
                namespace: namespace.clone(),
                execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let info = response.workflow_execution_info.clone().unwrap_or_default();
    let mut json = object(
        to_json_resolved(
            client,
            &namespace,
            "temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse",
            &response,
        )
        .await?,
    );
    let mut info_json = json
        .remove("workflowExecutionInfo")
        .map(object)
        .unwrap_or_default();
    let memo = info_json
        .remove("memo")
        .map(object)
        .and_then(|mut m| m.remove("fields"))
        .map(object)
        .unwrap_or_default();
    let search_attributes = info_json
        .remove("searchAttributes")
        .map(object)
        .and_then(|mut m| m.remove("indexedFields"))
        .map(object)
        .unwrap_or_default();
    Ok(WorkflowDetail {
        workflow: row(&info),
        execution_config: json
            .remove("executionConfig")
            .map(object)
            .unwrap_or_default(),
        pending_activities: objects(json.remove("pendingActivities")),
        pending_children: objects(json.remove("pendingChildren")),
        pending_workflow_task: json.remove("pendingWorkflowTask").map(object),
        memo,
        search_attributes,
        auto_reset_points: objects(
            info_json
                .remove("autoResetPoints")
                .map(object)
                .and_then(|mut p| p.remove("points")),
        ),
    })
}

/// One page of a run's history (`GetWorkflowExecutionHistory`), oldest first.
pub async fn history(
    client: &TemporalClient,
    input: WorkflowHistoryInput,
) -> Result<WorkflowHistoryOutput, ToolError> {
    let page_size = input.page_size.unwrap_or(HISTORY_PAGE);
    if !(1..=HISTORY_PAGE).contains(&page_size) {
        return Err(ToolError::invalid(TOOL, "pageSize", "1 to 1000"));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .get_workflow_execution_history(client.request(
            &namespace,
            ws::GetWorkflowExecutionHistoryRequest {
                namespace: namespace.clone(),
                execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                maximum_page_size: page_size as i32,
                next_page_token: decode_token(input.next_page_token.as_deref())?,
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let history = response.history.unwrap_or_default();
    let events = history_events(client, &namespace, &history.events).await?;
    Ok(WorkflowHistoryOutput {
        events,
        next_page_token: encode_token(&response.next_page_token),
    })
}

/// One long-poll step of following a run: the events after `after`, and the token for the next
/// step. The server holds the call until something happens (about 20 s at most) and hands back a
/// token as long as the run is open; an empty token means the run is closed and everything was
/// sent. (Without the long poll an open run also comes back with an empty token, which is why every
/// step waits, the first included: the first returns the history so far at once.)
pub struct FollowStep {
    pub events: Vec<HistoryEvent>,
    pub token: Vec<u8>,
}

pub async fn follow_step(
    client: &TemporalClient,
    namespace: &str,
    execution: WorkflowExecution,
    token: Vec<u8>,
    after: i64,
) -> Result<FollowStep, ToolError> {
    let mut request = client.request(
        namespace,
        ws::GetWorkflowExecutionHistoryRequest {
            namespace: namespace.to_owned(),
            execution: Some(execution),
            maximum_page_size: HISTORY_PAGE as i32,
            next_page_token: token,
            wait_new_event: true,
            ..Default::default()
        },
    );
    // The server holds a waiting call for up to ~20 s; give it room.
    request.set_timeout(std::time::Duration::from_secs(60));
    let response = client
        .service()
        .get_workflow_execution_history(request)
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let history = response.history.unwrap_or_default();
    let events = history_events(
        client,
        namespace,
        history.events.iter().filter(|e| e.event_id > after),
    )
    .await?;
    Ok(FollowStep {
        events,
        token: response.next_page_token,
    })
}

/// A query on a running workflow (`QueryWorkflow`), arguments as `json/plain` payloads.
pub async fn query(
    client: &TemporalClient,
    input: WorkflowQueryInput,
) -> Result<WorkflowQueryOutput, ToolError> {
    if input.query_type.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "queryType",
            "a query type is required",
        ));
    }
    let args = input
        .args
        .unwrap_or_default()
        .iter()
        .map(encode_json)
        .collect::<Result<Vec<_>, _>>()?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .query_workflow(
            client.request(
                &namespace,
                ws::QueryWorkflowRequest {
                    namespace: namespace.clone(),
                    execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                    query: Some(WorkflowQuery {
                        query_type: input.query_type.trim().to_owned(),
                        query_args: super::extstore::offload(
                            client.external.as_deref(),
                            (!args.is_empty()).then_some(Payloads { payloads: args }),
                        )
                        .await?,
                        header: None,
                    }),
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    if response.query_rejected.is_some() {
        return Err(ToolError::new(
            crate::core::ToolErrorKind::Conflict,
            TOOL,
            "the workflow is not running, so the query was rejected",
        ));
    }
    let mut result = to_json_resolved(
        client,
        &namespace,
        "temporal.api.common.v1.Payloads",
        &response.query_result.unwrap_or_default(),
    )
    .await?;
    // `Payloads` came out as an array; one result is the value itself.
    if let Value::Array(items) = &mut result
        && items.len() == 1
    {
        result = items.remove(0);
    }
    Ok(WorkflowQueryOutput { result })
}
