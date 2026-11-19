//! A schedule's detail against the lab (spec §9.3 "Schedule", §18 TSK-104): the times its spec
//! matches, its runs after Trigger now and a backfill, and the times it did not run. Each test makes
//! and deletes its own schedule; the seeded `every-minute` is not touched.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_schedule_detail_tests
//! ```

use std::time::Duration;

use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::actions::{Patch, schedule_delete, schedule_describe, schedule_patch};
use super::actions_types::{SchedulePatchInput, ScheduleRef};
use super::client::{self, TemporalClient};
use super::payloads::encode_json;
use super::proto::temporal::api::common::v1::{Payloads, WorkflowType};
use super::proto::temporal::api::schedule::v1 as sched;
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflow::v1::NewWorkflowExecutionInfo;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::schedule_detail::{
    ScheduleBackfillInput, ScheduleRunsInput, ScheduleTimesInput, backfill, matching_times, runs,
};
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

fn schedule_ref(id: &str) -> ScheduleRef {
    ScheduleRef {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
    }
}

/// A paused schedule of `Completed` every `every` seconds, so only Trigger now and backfill run it.
async fn create(client: &TemporalClient, every: i64) -> String {
    let id = format!("lab-test-detail-{}", &random_id()[..8]);
    client
        .service()
        .create_schedule(client.request(
            "lab",
            ws::CreateScheduleRequest {
                namespace: "lab".into(),
                schedule_id: id.clone(),
                schedule: Some(sched::Schedule {
                    spec: Some(sched::ScheduleSpec {
                        interval: vec![sched::IntervalSpec {
                            interval: Some(prost_types::Duration {
                                seconds: every,
                                nanos: 0,
                            }),
                            phase: None,
                        }],
                        ..Default::default()
                    }),
                    action: Some(sched::ScheduleAction {
                        action: Some(sched::schedule_action::Action::StartWorkflow(
                            NewWorkflowExecutionInfo {
                                workflow_id: format!("{id}-run"),
                                workflow_type: Some(WorkflowType {
                                    name: "Completed".into(),
                                }),
                                task_queue: Some(TaskQueue {
                                    name: "lab".into(),
                                    kind: 1,
                                    normal_name: String::new(),
                                }),
                                input: Some(Payloads {
                                    payloads: vec![encode_json(&json!("ord-detail")).unwrap()],
                                }),
                                ..Default::default()
                            },
                        )),
                    }),
                    state: Some(sched::ScheduleState {
                        paused: true,
                        notes: "made by a lab test".into(),
                        ..Default::default()
                    }),
                    ..Default::default()
                }),
                identity: "lab-test".into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .expect("the schedule is created");
    id
}

fn iso(t: OffsetDateTime) -> String {
    t.format(&Rfc3339).unwrap()
}

fn runs_input(id: &str) -> ScheduleRunsInput {
    ScheduleRunsInput {
        conn_id: String::new(),
        namespace: None,
        schedule_id: id.into(),
        page_size: None,
        next_page_token: None,
    }
}

#[tokio::test]
async fn the_next_times_are_the_servers_and_a_range_counts_its_runs() {
    let client = lab().await;
    let id = create(&client, 600).await;
    let now = OffsetDateTime::now_utc();
    let next = matching_times(
        &client,
        ScheduleTimesInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: id.clone(),
            start_time: iso(now),
            end_time: None,
            limit: Some(20),
        },
    )
    .await
    .unwrap();
    assert_eq!(next.times.len(), 20);
    assert!(next.truncated, "a day of ten-minute runs is more than 20");
    let first = OffsetDateTime::parse(&next.times[0], &Rfc3339).unwrap();
    assert_eq!(first.unix_timestamp() % 600, 0, "{first}");
    // An hour holds six runs of every ten minutes: the backfill's count.
    let hour = matching_times(
        &client,
        ScheduleTimesInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: id.clone(),
            start_time: iso(now - time::Duration::hours(1)),
            end_time: Some(iso(now)),
            limit: Some(1000),
        },
    )
    .await
    .unwrap();
    assert_eq!(hour.times.len(), 6, "{:?}", hour.times);
    schedule_delete(&client, schedule_ref(&id)).await.unwrap();
}

#[tokio::test]
async fn trigger_and_backfill_runs_are_listed_with_their_scheduled_times() {
    let client = lab().await;
    let id = create(&client, 600).await;
    schedule_patch(
        &client,
        SchedulePatchInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: id.clone(),
            note: None,
            overlap: None,
        },
        Patch::Trigger,
    )
    .await
    .unwrap();
    let now = OffsetDateTime::now_utc();
    backfill(
        &client,
        ScheduleBackfillInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: id.clone(),
            start_time: iso(now - time::Duration::minutes(30)),
            end_time: iso(now),
            overlap: Some(super::actions_types::ScheduleOverlap::AllowAll),
        },
    )
    .await
    .unwrap();
    // The trigger and three backfilled times (every ten minutes in half an hour).
    let mut started = Vec::new();
    for _ in 0..60 {
        let out = runs(&client, runs_input(&id)).await.unwrap();
        started = out
            .runs
            .iter()
            .filter(|r| r.workflow_id.is_some())
            .cloned()
            .collect();
        if started.len() >= 4 {
            assert_eq!(out.query, format!("TemporalScheduledById = \"{id}\""));
            break;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    assert!(started.len() >= 4, "{started:?}");
    assert!(started.iter().all(|r| {
        r.scheduled_time.is_some()
            && r.workflow_id
                .as_deref()
                .unwrap()
                .starts_with(&format!("{id}-run"))
    }));
    // Newest scheduled first.
    let times: Vec<_> = started
        .iter()
        .map(|r| r.scheduled_time.clone().unwrap())
        .collect();
    let mut sorted = times.clone();
    sorted.sort_by(|a, b| b.cmp(a));
    assert_eq!(times, sorted);

    // A note on pause and the detail says paused.
    schedule_patch(
        &client,
        SchedulePatchInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: id.clone(),
            note: Some("detail test".into()),
            overlap: None,
        },
        Patch::Pause,
    )
    .await
    .unwrap();
    let d = schedule_describe(&client, schedule_ref(&id)).await.unwrap();
    assert!(d.summary.paused);
    assert_eq!(d.summary.notes, "detail test");
    schedule_delete(&client, schedule_ref(&id)).await.unwrap();
    let gone = runs(&client, runs_input(&id)).await.unwrap_err();
    assert_eq!(gone.kind, ToolErrorKind::NotFound, "{gone:?}");
}

#[tokio::test]
async fn a_future_backfill_is_refused() {
    let client = lab().await;
    let now = OffsetDateTime::now_utc();
    let err = backfill(
        &client,
        ScheduleBackfillInput {
            conn_id: String::new(),
            namespace: None,
            schedule_id: "any".into(),
            start_time: iso(now),
            end_time: iso(now + time::Duration::hours(1)),
            overlap: None,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(err.kind, ToolErrorKind::Invalid);
}
