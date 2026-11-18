//! TSK-92 batch 2 against the lab: start workflow, schedule create and edit.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_form_tests
//! ```

use std::time::{Duration, Instant};

use super::actions::{schedule_delete, schedule_describe};
use super::actions_types::{ScheduleOverlap, ScheduleRef};
use super::client::{self, TemporalClient};
use super::detail::history;
use super::detail_types::WorkflowHistoryInput;
use super::schedule_form::{
    self, CalendarForm, IntervalForm, ScheduleActionForm, ScheduleForm, SchedulePoliciesForm,
    ScheduleSpecForm, ScheduleStateForm, ScheduleWriteInput,
};
use super::start::{self, IdConflictPolicy, WorkflowStartInput};
use super::types::ConnectTemporalProfile;
use crate::core::{ToolErrorKind, random_id};

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(serde_json::json!({
        "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab",
    }))
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", &random_id()[..8])
}

fn start_input(id: &str, conflict: Option<IdConflictPolicy>) -> WorkflowStartInput {
    let mut input: WorkflowStartInput = serde_json::from_value(serde_json::json!({
        "connId": "",
        "workflowType": "Completed",
        "taskQueue": "lab",
        "workflowId": id,
        "args": ["ord-started"],
        "executionTimeout": "5m",
        "memo": { "startedBy": "lab-test" },
    }))
    .unwrap();
    input.id_conflict_policy = conflict;
    input
}

#[tokio::test]
async fn a_started_workflow_runs_on_the_lab_worker_with_its_input_and_memo() {
    let client = lab().await;
    let id = unique("test-start");
    let out = start::start(&client, start_input(&id, None)).await.unwrap();
    assert!(out.started && !out.run_id.is_empty());

    let deadline = Instant::now() + Duration::from_secs(30);
    let events = loop {
        let events = history(
            &client,
            WorkflowHistoryInput {
                conn_id: String::new(),
                namespace: None,
                workflow_id: id.clone(),
                run_id: Some(out.run_id.clone()),
                page_size: None,
                next_page_token: None,
            },
        )
        .await
        .unwrap()
        .events;
        if events
            .iter()
            .any(|e| e.event_type == "WorkflowExecutionCompleted")
        {
            break events;
        }
        assert!(
            Instant::now() < deadline,
            "the started workflow did not complete"
        );
        tokio::time::sleep(Duration::from_millis(300)).await;
    };
    let started = &events[0].attributes;
    assert_eq!(started["input"], serde_json::json!(["ord-started"]));
    assert_eq!(started["memo"]["fields"]["startedBy"], "lab-test");
    assert_eq!(started["workflowExecutionTimeout"], "300s");

    // UseExisting on a running workflow returns it without starting; Fail refuses.
    let again = start::start(
        &client,
        start_input(
            "fulfilment-long-running",
            Some(IdConflictPolicy::UseExisting),
        ),
    )
    .await
    .unwrap();
    assert!(!again.started);
    let refused = start::start(
        &client,
        start_input("fulfilment-long-running", Some(IdConflictPolicy::Fail)),
    )
    .await
    .unwrap_err();
    assert_eq!(refused.kind, ToolErrorKind::Conflict, "{refused:?}");
}

fn schedule_form(hour: &str) -> ScheduleForm {
    ScheduleForm {
        spec: ScheduleSpecForm {
            calendars: vec![CalendarForm {
                hour: Some(hour.into()),
                minute: Some("30".into()),
                ..Default::default()
            }],
            intervals: vec![],
            cron_strings: vec![],
            timezone: Some("Europe/Berlin".into()),
            start_time: None,
            end_time: None,
            jitter: None,
        },
        action: ScheduleActionForm {
            workflow_type: "Completed".into(),
            task_queue: "lab".into(),
            workflow_id: "from-a-test-schedule".into(),
            args: vec![serde_json::json!("ord-sched")],
            execution_timeout: None,
            run_timeout: None,
            task_timeout: None,
            retry_policy: None,
            memo: None,
            search_attributes: None,
        },
        policies: SchedulePoliciesForm {
            overlap: Some(ScheduleOverlap::BufferOne),
            catchup_window: Some("1m".into()),
            pause_on_failure: false,
        },
        state: ScheduleStateForm {
            paused: true,
            notes: "made by a test".into(),
            remaining_actions: None,
        },
    }
}

fn write(id: &str, form: ScheduleForm, token: Option<String>) -> ScheduleWriteInput {
    ScheduleWriteInput {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
        schedule: form,
        conflict_token: token,
    }
}

fn reference(id: &str) -> ScheduleRef {
    ScheduleRef {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
    }
}

#[tokio::test]
async fn a_schedule_is_created_described_as_its_form_and_updated_with_its_token() {
    let client = lab().await;
    let id = unique("lab-test-form");
    schedule_form::create(&client, write(&id, schedule_form("2"), None))
        .await
        .unwrap();
    let described = schedule_describe(&client, reference(&id)).await.unwrap();
    let form = &described.form;
    assert_eq!(form.spec.calendars.len(), 1, "{:?}", form.spec);
    assert_eq!(form.spec.calendars[0].hour.as_deref(), Some("2"));
    assert_eq!(form.spec.calendars[0].minute.as_deref(), Some("30"));
    assert_eq!(form.spec.timezone.as_deref(), Some("Europe/Berlin"));
    assert_eq!(form.action.args, vec![serde_json::json!("ord-sched")]);
    assert_eq!(form.policies.overlap, Some(ScheduleOverlap::BufferOne));
    assert!(form.state.paused);
    assert!(!described.conflict_token.is_empty());

    let mut changed = described.form.clone();
    changed.spec.calendars[0].hour = Some("4".into());
    changed.spec.intervals.push(IntervalForm {
        every: "1h".into(),
        offset: None,
    });
    changed.state.notes = "edited by a test".into();
    schedule_form::update(
        &client,
        write(&id, changed, Some(described.conflict_token.clone())),
    )
    .await
    .unwrap();
    let after = schedule_describe(&client, reference(&id)).await.unwrap();
    assert_eq!(after.form.spec.calendars[0].hour.as_deref(), Some("4"));
    assert_eq!(after.form.spec.intervals.len(), 1);
    assert_eq!(after.form.state.notes, "edited by a test");

    // The old token is stale now.
    let stale = schedule_form::update(
        &client,
        write(&id, schedule_form("5"), Some(described.conflict_token)),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.kind, ToolErrorKind::Conflict, "{stale:?}");

    schedule_delete(&client, reference(&id)).await.unwrap();
}

#[tokio::test]
async fn a_cron_schedule_is_created_and_reads_back() {
    let client = lab().await;
    let id = unique("lab-test-cron");
    let mut form = schedule_form("0");
    form.spec.calendars.clear();
    form.spec.cron_strings = vec!["15 3 * * 1-5".into()];
    form.spec.timezone = None;
    schedule_form::create(&client, write(&id, form, None))
        .await
        .unwrap();
    let described = schedule_describe(&client, reference(&id)).await.unwrap();
    // The server keeps a cron string as a calendar or as the string; either reads back.
    let f = &described.form.spec;
    let as_calendar = f.calendars.first().is_some_and(|c| {
        c.minute.as_deref() == Some("15")
            && c.hour.as_deref() == Some("3")
            && c.day_of_week.as_deref() == Some("1-5")
    });
    assert!(
        as_calendar || f.cron_strings == vec!["15 3 * * 1-5".to_owned()],
        "{f:?}"
    );
    schedule_delete(&client, reference(&id)).await.unwrap();
}
