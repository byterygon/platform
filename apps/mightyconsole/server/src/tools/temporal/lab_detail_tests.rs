//! The workflow detail against the lab's dev server (spec §9.3, §18): history with payloads
//! decoded, describe with pending activities, a Protobuf payload, queries, and following a run.
//! Read-only: the actions of batch 3 change workflows, these tests never do.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_detail_tests
//! ```

use serde_json::json;

use super::client::{self, TemporalClient};
use super::detail::{describe, follow_step, history, query};
use super::detail_types::{
    EventCategory, HistoryEvent, WorkflowHistoryInput, WorkflowQueryInput, WorkflowRef,
};
use super::proto::temporal::api::common::v1::WorkflowExecution;
use super::types::{ConnectTemporalProfile, WorkflowStatus};
use crate::core::ToolErrorKind;

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(json!({
        "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab",
    }))
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

fn target(workflow_id: &str) -> WorkflowRef {
    WorkflowRef {
        conn_id: String::new(),
        namespace: None,
        workflow_id: workflow_id.into(),
        run_id: None,
    }
}

fn page(workflow_id: &str, page_size: Option<u32>, token: Option<String>) -> WorkflowHistoryInput {
    WorkflowHistoryInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: workflow_id.into(),
        run_id: None,
        page_size,
        next_page_token: token,
    }
}

async fn all_events(client: &TemporalClient, workflow_id: &str) -> Vec<HistoryEvent> {
    let out = history(client, page(workflow_id, None, None))
        .await
        .unwrap();
    assert!(
        out.next_page_token.is_none(),
        "the sample histories are short"
    );
    out.events
}

fn find<'a>(events: &'a [HistoryEvent], event_type: &str) -> &'a HistoryEvent {
    events
        .iter()
        .find(|e| e.event_type == event_type)
        .unwrap_or_else(|| {
            panic!(
                "no {event_type} in {:?}",
                events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
            )
        })
}

#[tokio::test]
async fn a_completed_history_has_its_input_and_result_decoded() {
    let events = all_events(&lab().await, "completed-1").await;
    assert_eq!(events[0].event_id, 1);
    assert_eq!(events[0].event_type, "WorkflowExecutionStarted");
    assert_eq!(events[0].category, EventCategory::Workflow);
    assert!(
        events[0]
            .event_time
            .as_deref()
            .is_some_and(|t| t.ends_with('Z'))
    );
    assert_eq!(events[0].attributes["workflowType"]["name"], "Completed");
    assert_eq!(events[0].attributes["input"], json!(["ord-done"]));
    assert_eq!(events[0].attributes["taskQueue"]["name"], "lab");
    let last = events.last().unwrap();
    assert_eq!(last.event_type, "WorkflowExecutionCompleted");
    assert_eq!(last.attributes["result"], json!(["charged ord-done"]));
    let scheduled = find(&events, "ActivityTaskScheduled");
    assert_eq!(scheduled.category, EventCategory::Activity);
    assert_eq!(scheduled.attributes["activityType"]["name"], "charge");
    assert_eq!(
        find(&events, "WorkflowTaskScheduled").category,
        EventCategory::WorkflowTask
    );
    let ids: Vec<i64> = events.iter().map(|e| e.event_id).collect();
    assert!(
        ids.windows(2).all(|w| w[1] == w[0] + 1),
        "event ids are consecutive: {ids:?}"
    );
}

#[tokio::test]
async fn history_pages_join_into_the_whole_history() {
    let client = lab().await;
    let whole = all_events(&client, "completed-1").await;
    let mut joined = Vec::new();
    let mut token = None;
    let mut pages = 0;
    loop {
        // The server may return whole workflow-task batches, so a page can exceed the size asked.
        let out = history(&client, page("completed-1", Some(3), token))
            .await
            .unwrap();
        pages += 1;
        joined.extend(out.events);
        token = out.next_page_token;
        if token.is_none() {
            break;
        }
    }
    let ids = |events: &[HistoryEvent]| events.iter().map(|e| e.event_id).collect::<Vec<_>>();
    assert!(pages >= 2, "a page size of 3 splits an 11-event history");
    assert_eq!(ids(&joined), ids(&whole));
}

#[tokio::test]
async fn a_failed_workflow_has_its_failure_and_the_cause() {
    let events = all_events(&lab().await, "failed-1").await;
    let last = events.last().unwrap();
    assert_eq!(last.event_type, "WorkflowExecutionFailed");
    let failure = &last.attributes["failure"];
    assert_eq!(failure["message"], "order ord-bad was rejected");
    assert_eq!(failure["applicationFailureInfo"]["type"], "Rejected");
    assert_eq!(failure["applicationFailureInfo"]["nonRetryable"], true);
}

#[tokio::test]
async fn a_parent_has_child_workflow_events() {
    let events = all_events(&lab().await, "parent-1").await;
    let child = find(&events, "StartChildWorkflowExecutionInitiated");
    assert_eq!(child.category, EventCategory::ChildWorkflow);
    assert_eq!(
        find(&events, "ChildWorkflowExecutionCompleted").category,
        EventCategory::ChildWorkflow
    );
}

#[tokio::test]
async fn the_labs_protobuf_payload_arrives_as_its_json() {
    // The Python SDK writes messages as `json/protobuf`: JSON, as spec §9.5 says. A
    // `binary/protobuf` one stays opaque with its message type (payloads::tests).
    let events = all_events(&lab().await, "proto-1").await;
    let input = &events[0].attributes["input"][0];
    assert_eq!(input["id"], "ord-00007", "{input}");
    assert_eq!(input["total"]["currency"], "EUR");
    let result = &events.last().unwrap().attributes["result"][0];
    assert_eq!(result["status"], "PAID", "{result}");
}

#[tokio::test]
async fn describe_a_running_workflow() {
    let detail = describe(&lab().await, target("fulfilment-long-running"))
        .await
        .unwrap();
    assert_eq!(detail.workflow.status, WorkflowStatus::Running);
    assert_eq!(detail.workflow.workflow_type, "Fulfilment");
    assert_eq!(detail.execution_config["taskQueue"]["name"], "lab");
    assert!(detail.pending_children.is_empty());
}

#[tokio::test]
async fn describe_shows_the_retrying_activity() {
    let detail = describe(&lab().await, target("retrying-1")).await.unwrap();
    assert_eq!(detail.workflow.status, WorkflowStatus::Running);
    let activity = detail
        .pending_activities
        .first()
        .expect("a pending activity");
    assert_eq!(activity["activityType"]["name"], "flaky");
    assert!(
        activity["attempt"].as_i64().is_some_and(|n| n >= 1),
        "{activity:?}"
    );
    assert!(
        activity["lastFailure"]["message"]
            .as_str()
            .is_some_and(|m| m.contains("payment provider is down")),
        "{activity:?}"
    );
    assert!(
        activity["state"]
            .as_str()
            .is_some_and(|s| s.starts_with("PENDING_ACTIVITY_STATE"))
    );
}

#[tokio::test]
async fn describe_a_closed_workflow_has_no_pending_work() {
    let detail = describe(&lab().await, target("completed-1")).await.unwrap();
    assert_eq!(detail.workflow.status, WorkflowStatus::Completed);
    assert!(detail.workflow.close_time.is_some());
    assert!(detail.pending_activities.is_empty() && detail.pending_workflow_task.is_none());
}

#[tokio::test]
async fn queries_answer_through_the_worker() {
    let client = lab().await;
    let ask = |query_type: &str| WorkflowQueryInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: "fulfilment-long-running".into(),
        run_id: None,
        query_type: query_type.into(),
        args: None,
    };
    let status = query(&client, ask("status")).await.unwrap().result;
    assert!(status.as_str().is_some_and(|s| !s.is_empty()), "{status}");
    let stack = query(&client, ask("__stack_trace")).await.unwrap().result;
    assert!(stack.as_str().is_some_and(|s| !s.is_empty()), "{stack}");
    let error = query(&client, ask("no-such-query")).await.unwrap_err();
    assert!(
        matches!(
            error.kind,
            ToolErrorKind::Invalid | ToolErrorKind::Remote | ToolErrorKind::Conflict
        ),
        "{error:?}"
    );
}

#[tokio::test]
async fn following_a_closed_run_sends_everything_after_the_cursor_and_ends() {
    let client = lab().await;
    let whole = all_events(&client, "completed-1").await;
    let run_id = {
        let detail = describe(&client, target("completed-1")).await.unwrap();
        detail.workflow.run_id
    };
    let execution = || WorkflowExecution {
        workflow_id: "completed-1".into(),
        run_id: run_id.clone(),
    };
    let step = follow_step(&client, "lab", execution(), Vec::new(), false, 4)
        .await
        .unwrap();
    assert_eq!(step.events.first().map(|e| e.event_id), Some(5));
    assert_eq!(step.events.len(), whole.len() - 4);
    assert!(step.token.is_empty(), "a closed run has no more to follow");
}

#[tokio::test]
async fn unknown_workflows_are_not_found_and_blank_ids_invalid() {
    let client = lab().await;
    let error = history(&client, page("no-such-workflow", None, None))
        .await
        .unwrap_err();
    assert_eq!(error.kind, ToolErrorKind::NotFound, "{error:?}");
    let error = describe(&client, target("no-such-workflow"))
        .await
        .unwrap_err();
    assert_eq!(error.kind, ToolErrorKind::NotFound, "{error:?}");
    let error = history(&client, page(" ", None, None)).await.unwrap_err();
    assert_eq!(error.field.as_deref(), Some("workflowId"));
    let error = history(&client, page("completed-1", Some(5000), None))
        .await
        .unwrap_err();
    assert_eq!(error.field.as_deref(), Some("pageSize"));
}
