//! The actions, schedules and task queues against the lab's dev server (spec §9.4, §18). Each test
//! starts its own workflows (unique ids on the lab's task queue, run by the lab worker), so the
//! seeded ones the read tests rely on are never touched; the seeded schedule is paused and
//! resumed, and a schedule of the test's own is deleted.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_action_tests
//! ```

use std::time::{Duration, Instant};

use serde_json::json;

use super::actions::{
    Patch, cancel, reset, schedule_delete, schedule_describe, schedule_patch, schedules_list,
    signal, task_queue_describe, terminate,
};
use super::actions_types::{
    ResetReapply, ScheduleOverlap, SchedulePatchInput, ScheduleRef, SchedulesListInput,
    TaskQueueDescribeInput, WorkflowReasonInput, WorkflowResetInput, WorkflowSignalInput,
};
use super::client::{self, TemporalClient};
use super::detail::{follow_step, history, query};
use super::detail_types::{HistoryEvent, WorkflowHistoryInput, WorkflowQueryInput};
use super::payloads::encode_json;
use super::proto::temporal::api::common::v1::{Payloads, WorkflowExecution, WorkflowType};
use super::proto::temporal::api::schedule::v1 as sched;
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflow::v1::NewWorkflowExecutionInfo;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::types::ConnectTemporalProfile;
use crate::core::{ToolErrorKind, random_id};

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(
        json!({ "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab" }),
    )
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", &random_id()[..8])
}

fn input(value: serde_json::Value) -> Payloads {
    Payloads {
        payloads: vec![encode_json(&value).unwrap()],
    }
}

fn task_queue() -> Option<TaskQueue> {
    Some(TaskQueue {
        name: "lab".into(),
        kind: 1,
        normal_name: String::new(),
    })
}

/// Starts a sample workflow of the lab worker under a new id; returns the run id.
async fn start(client: &TemporalClient, workflow_type: &str, arg: &str) -> (String, String) {
    let id = unique(&format!("test-{}", workflow_type.to_lowercase()));
    let response = client
        .service()
        .start_workflow_execution(client.request(
            "lab",
            ws::StartWorkflowExecutionRequest {
                namespace: "lab".into(),
                workflow_id: id.clone(),
                workflow_type: Some(WorkflowType {
                    name: workflow_type.into(),
                }),
                task_queue: task_queue(),
                input: Some(input(json!(arg))),
                identity: "lab-test".into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .expect("the workflow starts")
        .into_inner();
    (id, response.run_id)
}

async fn events_of(client: &TemporalClient, id: &str) -> Vec<HistoryEvent> {
    history(
        client,
        WorkflowHistoryInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.into(),
            run_id: None,
            page_size: None,
            next_page_token: None,
            reverse: None,
        },
    )
    .await
    .unwrap()
    .events
}

/// Polls the history until `done` accepts it, for up to 30 s.
async fn wait_for(
    client: &TemporalClient,
    id: &str,
    what: &str,
    done: impl Fn(&[HistoryEvent]) -> bool,
) -> Vec<HistoryEvent> {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let events = events_of(client, id).await;
        if done(&events) {
            return events;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what} in {id}: {:?}",
            events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn has(events: &[HistoryEvent], event_type: &str) -> bool {
    events.iter().any(|e| e.event_type == event_type)
}

fn find<'a>(events: &'a [HistoryEvent], event_type: &str) -> &'a HistoryEvent {
    events
        .iter()
        .find(|e| e.event_type == event_type)
        .unwrap_or_else(|| panic!("no {event_type}"))
}

fn reason(id: &str, why: Option<&str>) -> WorkflowReasonInput {
    WorkflowReasonInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: id.into(),
        run_id: None,
        reason: why.map(Into::into),
    }
}

async fn status_query(client: &TemporalClient, id: &str) -> String {
    let out = query(
        client,
        WorkflowQueryInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.into(),
            run_id: None,
            query_type: "status".into(),
            args: None,
        },
    )
    .await
    .unwrap();
    out.result.as_str().unwrap().to_owned()
}

#[tokio::test]
async fn a_signal_reaches_the_workflow_and_its_arguments_are_in_the_history() {
    let client = lab().await;
    let (id, _) = start(&client, "Fulfilment", "ord-signal").await;
    wait_for(&client, &id, "the first workflow task", |e| {
        has(e, "WorkflowTaskCompleted")
    })
    .await;
    assert_eq!(status_query(&client, &id).await, "waiting for approval");
    signal(
        &client,
        WorkflowSignalInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: None,
            signal_name: "approve".into(),
            args: Some(vec![json!("tester")]),
        },
    )
    .await
    .unwrap();
    let events = wait_for(&client, &id, "completion", |e| {
        has(e, "WorkflowExecutionCompleted")
    })
    .await;
    let signaled = find(&events, "WorkflowExecutionSignaled");
    assert_eq!(signaled.attributes["signalName"], "approve");
    assert_eq!(signaled.attributes["input"], json!(["tester"]));
    assert_eq!(signaled.attributes["identity"], "mightyconsole");
    assert_eq!(
        find(&events, "WorkflowExecutionCompleted").attributes["result"],
        json!(["charged ord-signal"])
    );
}

#[tokio::test]
async fn a_signal_needs_a_name_and_a_running_workflow() {
    let client = lab().await;
    let blank = signal(
        &client,
        WorkflowSignalInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: "x".into(),
            run_id: None,
            signal_name: " ".into(),
            args: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(blank.field.as_deref(), Some("signalName"));
    let gone = signal(
        &client,
        WorkflowSignalInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: "completed-1".into(),
            run_id: None,
            signal_name: "approve".into(),
            args: None,
        },
    )
    .await
    .unwrap_err();
    assert!(
        matches!(gone.kind, ToolErrorKind::NotFound | ToolErrorKind::Conflict),
        "{gone:?}"
    );
}

#[tokio::test]
async fn cancellation_is_requested_and_the_workflow_ends_canceled() {
    let client = lab().await;
    let (id, _) = start(&client, "Fulfilment", "ord-cancel").await;
    wait_for(&client, &id, "the first workflow task", |e| {
        has(e, "WorkflowTaskCompleted")
    })
    .await;
    cancel(&client, reason(&id, Some("no longer needed")))
        .await
        .unwrap();
    let events = wait_for(&client, &id, "the end", |e| {
        has(e, "WorkflowExecutionCanceled") || has(e, "WorkflowExecutionFailed")
    })
    .await;
    let requested = find(&events, "WorkflowExecutionCancelRequested");
    assert_eq!(requested.attributes["cause"], "no longer needed");
    assert_eq!(requested.attributes["identity"], "mightyconsole");
    assert!(
        has(&events, "WorkflowExecutionCanceled"),
        "{:?}",
        events.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn terminate_needs_a_reason_and_ends_the_run_with_it() {
    let client = lab().await;
    let (id, _) = start(&client, "Fulfilment", "ord-terminate").await;
    wait_for(&client, &id, "the first workflow task", |e| {
        has(e, "WorkflowTaskCompleted")
    })
    .await;
    for why in [None, Some("   ")] {
        let error = terminate(&client, reason(&id, why)).await.unwrap_err();
        assert_eq!(error.field.as_deref(), Some("reason"));
    }
    assert!(
        !has(
            &events_of(&client, &id).await,
            "WorkflowExecutionTerminated"
        ),
        "nothing happened without a reason"
    );
    terminate(&client, reason(&id, Some("bad deploy")))
        .await
        .unwrap();
    let events = events_of(&client, &id).await;
    let ended = find(&events, "WorkflowExecutionTerminated");
    assert_eq!(ended.attributes["reason"], "bad deploy");
    assert_eq!(ended.attributes["identity"], "mightyconsole");
    // A second time the run is already closed.
    let again = terminate(&client, reason(&id, Some("again")))
        .await
        .unwrap_err();
    assert!(
        matches!(
            again.kind,
            ToolErrorKind::NotFound | ToolErrorKind::Conflict
        ),
        "{again:?}"
    );
}

#[tokio::test]
async fn reset_starts_a_new_run_from_the_event_and_ends_the_old_one() {
    let client = lab().await;
    let (id, old_run) = start(&client, "Fulfilment", "ord-reset").await;
    let events = wait_for(&client, &id, "the first workflow task", |e| {
        has(e, "WorkflowTaskCompleted")
    })
    .await;
    let point = find(&events, "WorkflowTaskCompleted").event_id;
    let blank = reset(
        &client,
        WorkflowResetInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: old_run.clone(),
            event_id: point as u64,
            reapply: ResetReapply::All,
            reason: " ".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(blank.field.as_deref(), Some("reason"));
    let out = reset(
        &client,
        WorkflowResetInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: old_run.clone(),
            event_id: point as u64,
            reapply: ResetReapply::All,
            reason: "retry from the start".into(),
        },
    )
    .await
    .unwrap();
    assert!(!out.run_id.is_empty() && out.run_id != old_run);
    let fresh = history(
        &client,
        WorkflowHistoryInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: Some(out.run_id.clone()),
            page_size: None,
            next_page_token: None,
            reverse: None,
        },
    )
    .await
    .unwrap()
    .events;
    assert_eq!(fresh[0].event_type, "WorkflowExecutionStarted");
    // The old run was closed by the reset.
    let old = history(
        &client,
        WorkflowHistoryInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: Some(old_run),
            page_size: None,
            next_page_token: None,
            reverse: None,
        },
    )
    .await
    .unwrap()
    .events;
    assert!(
        has(&old, "WorkflowExecutionTerminated"),
        "{:?}",
        old.iter().map(|e| &e.event_type).collect::<Vec<_>>()
    );
    // The new run waits for an approval like the first did: end it, so the lab does not collect
    // running workflows from every test run.
    terminate(&client, reason(&id, Some("test over")))
        .await
        .unwrap();
}

#[tokio::test]
async fn reset_checks_its_input_before_asking() {
    let client = lab().await;
    let bad = |run: &str, event: u64| WorkflowResetInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: "x".into(),
        run_id: run.into(),
        event_id: event,
        reapply: ResetReapply::None,
        reason: "r".into(),
    };
    assert_eq!(
        reset(&client, bad("", 4))
            .await
            .unwrap_err()
            .field
            .as_deref(),
        Some("runId")
    );
    assert_eq!(
        reset(&client, bad("run", 0))
            .await
            .unwrap_err()
            .field
            .as_deref(),
        Some("eventId")
    );
}

fn patch(id: &str, note: Option<&str>, policy: Option<ScheduleOverlap>) -> SchedulePatchInput {
    SchedulePatchInput {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
        note: note.map(Into::into),
        overlap: policy,
    }
}

fn schedule_ref(id: &str) -> ScheduleRef {
    ScheduleRef {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
    }
}

#[tokio::test]
async fn the_seeded_schedule_is_listed_described_paused_resumed_and_triggered() {
    let client = lab().await;
    let all = schedules_list(
        &client,
        SchedulesListInput {
            conn_id: String::new(),
            namespace: None,
            query: None,
        },
    )
    .await
    .unwrap();
    let seeded = all
        .iter()
        .find(|s| s.schedule_id == "every-minute")
        .expect("the lab seeds every-minute");
    assert_eq!(seeded.workflow_type, "Completed");
    assert_eq!(seeded.spec, "Every 1 minute");

    let detail = schedule_describe(&client, schedule_ref("every-minute"))
        .await
        .unwrap();
    assert_eq!(detail.summary.workflow_type, "Completed");
    assert_eq!(
        detail.action["startWorkflow"]["workflowType"]["name"],
        "Completed"
    );
    assert_eq!(
        detail.action["startWorkflow"]["input"],
        json!(["ord-scheduled"])
    );
    assert!(detail.spec.contains_key("interval"), "{:?}", detail.spec);
    assert!(!detail.summary.next_runs.is_empty());

    schedule_patch(
        &client,
        patch("every-minute", Some("pausing for a test"), None),
        Patch::Pause,
    )
    .await
    .unwrap();
    let paused = schedule_describe(&client, schedule_ref("every-minute"))
        .await
        .unwrap();
    assert!(paused.summary.paused);
    assert_eq!(paused.summary.notes, "pausing for a test");

    let before = paused.summary.recent_actions.len();
    schedule_patch(
        &client,
        patch("every-minute", None, Some(ScheduleOverlap::AllowAll)),
        Patch::Trigger,
    )
    .await
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let now = schedule_describe(&client, schedule_ref("every-minute"))
            .await
            .unwrap();
        // The list of recent actions is capped, so compare the action count the server keeps.
        if now.info["actionCount"].as_i64().unwrap_or(0)
            > paused.info["actionCount"].as_i64().unwrap_or(0)
            || now.summary.recent_actions.len() > before
        {
            break;
        }
        assert!(Instant::now() < deadline, "the trigger started no run");
        tokio::time::sleep(Duration::from_millis(500)).await;
    }

    schedule_patch(
        &client,
        patch("every-minute", Some("back on"), None),
        Patch::Unpause,
    )
    .await
    .unwrap();
    let resumed = schedule_describe(&client, schedule_ref("every-minute"))
        .await
        .unwrap();
    assert!(!resumed.summary.paused);
    assert_eq!(resumed.summary.notes, "back on");
}

#[tokio::test]
async fn a_schedule_of_the_tests_own_is_deleted_and_then_gone() {
    let client = lab().await;
    let id = unique("lab-test-schedule");
    let action = sched::ScheduleAction {
        action: Some(sched::schedule_action::Action::StartWorkflow(
            NewWorkflowExecutionInfo {
                workflow_id: format!("{id}-run"),
                workflow_type: Some(WorkflowType {
                    name: "Completed".into(),
                }),
                task_queue: task_queue(),
                input: Some(input(json!("ord-from-test"))),
                ..Default::default()
            },
        )),
    };
    let spec = sched::ScheduleSpec {
        interval: vec![sched::IntervalSpec {
            interval: Some(prost_types::Duration {
                seconds: 3600,
                nanos: 0,
            }),
            phase: None,
        }],
        ..Default::default()
    };
    client
        .service()
        .create_schedule(client.request(
            "lab",
            ws::CreateScheduleRequest {
                namespace: "lab".into(),
                schedule_id: id.clone(),
                schedule: Some(sched::Schedule {
                    spec: Some(spec),
                    action: Some(action),
                    ..Default::default()
                }),
                identity: "lab-test".into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .expect("the schedule is created");
    assert_eq!(
        schedule_describe(&client, schedule_ref(&id))
            .await
            .unwrap()
            .summary
            .spec,
        "Every 1 hour"
    );
    schedule_delete(&client, schedule_ref(&id)).await.unwrap();
    let gone = schedule_describe(&client, schedule_ref(&id))
        .await
        .unwrap_err();
    assert_eq!(gone.kind, ToolErrorKind::NotFound, "{gone:?}");
}

#[tokio::test]
async fn schedule_calls_need_an_id() {
    let client = lab().await;
    assert_eq!(
        schedule_describe(&client, schedule_ref(" "))
            .await
            .unwrap_err()
            .field
            .as_deref(),
        Some("scheduleId")
    );
    assert_eq!(
        schedule_delete(&client, schedule_ref(""))
            .await
            .unwrap_err()
            .field
            .as_deref(),
        Some("scheduleId")
    );
    assert_eq!(
        schedule_patch(&client, patch("", None, None), Patch::Pause)
            .await
            .unwrap_err()
            .field
            .as_deref(),
        Some("scheduleId")
    );
}

#[tokio::test]
async fn the_lab_queue_has_workflow_and_activity_pollers_and_an_unknown_one_has_none() {
    let client = lab().await;
    let lab_queue = task_queue_describe(
        &client,
        TaskQueueDescribeInput {
            conn_id: String::new(),
            namespace: None,
            task_queue: "lab".into(),
        },
    )
    .await
    .unwrap();
    assert!(
        !lab_queue.workflow_pollers.is_empty(),
        "the worker polls workflows"
    );
    assert!(
        !lab_queue.activity_pollers.is_empty(),
        "the worker polls activities"
    );
    let poller = &lab_queue.workflow_pollers[0];
    assert!(!poller.identity.is_empty());
    assert!(
        poller
            .last_access_time
            .as_deref()
            .is_some_and(|t| t.ends_with('Z'))
    );
    let none = task_queue_describe(
        &client,
        TaskQueueDescribeInput {
            conn_id: String::new(),
            namespace: None,
            task_queue: unique("no-such-queue"),
        },
    )
    .await
    .unwrap();
    assert!(none.workflow_pollers.is_empty() && none.activity_pollers.is_empty());
    let blank = task_queue_describe(
        &client,
        TaskQueueDescribeInput {
            conn_id: String::new(),
            namespace: None,
            task_queue: " ".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(blank.field.as_deref(), Some("taskQueue"));
}

#[tokio::test]
async fn following_an_open_run_sees_new_events_until_it_closes() {
    let client = lab().await;
    let (id, run_id) = start(&client, "Fulfilment", "ord-follow").await;
    let execution = || WorkflowExecution {
        workflow_id: id.clone(),
        run_id: run_id.clone(),
    };
    // The first step answers at once with the history so far, and the run is open: a token comes back.
    let first = follow_step(&client, "lab", execution(), Vec::new(), 0)
        .await
        .unwrap();
    assert_eq!(
        first.events.first().map(|e| e.event_type.as_str()),
        Some("WorkflowExecutionStarted")
    );
    assert!(!first.token.is_empty(), "an open run keeps its token");
    let mut seen: Vec<i64> = first.events.iter().map(|e| e.event_id).collect();
    let mut token = first.token;

    signal(
        &client,
        WorkflowSignalInput {
            conn_id: String::new(),
            namespace: None,
            workflow_id: id.clone(),
            run_id: Some(run_id.clone()),
            signal_name: "approve".into(),
            args: Some(vec![json!("follower")]),
        },
    )
    .await
    .unwrap();

    // Follow until the token ends: the signal, the activity and the completion all arrive, once, in order.
    let deadline = Instant::now() + Duration::from_secs(40);
    let mut types = Vec::new();
    while !token.is_empty() {
        assert!(Instant::now() < deadline, "the run never closed: {types:?}");
        let after = *seen.last().unwrap();
        let step = follow_step(&client, "lab", execution(), token, after)
            .await
            .unwrap();
        for e in &step.events {
            assert!(e.event_id > after, "an event came twice");
            seen.push(e.event_id);
            types.push(e.event_type.clone());
        }
        token = step.token;
    }
    assert!(
        types.iter().any(|t| t == "WorkflowExecutionSignaled"),
        "{types:?}"
    );
    assert_eq!(
        types.last().map(String::as_str),
        Some("WorkflowExecutionCompleted"),
        "{types:?}"
    );
    let all = events_of(&client, &id).await;
    assert_eq!(
        seen,
        all.iter().map(|e| e.event_id).collect::<Vec<_>>(),
        "the followed events are the whole history"
    );
}
