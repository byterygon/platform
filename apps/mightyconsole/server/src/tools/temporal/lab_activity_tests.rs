//! Standalone activities against the lab's dev server (TSK-92, spec §9.3 "Activities", §18): the
//! lab worker runs `charge`, `flaky` and `hold` (heartbeats until cancelled) on task queue `lab`.
//! Each test runs activities of its own, with unique IDs.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_activity_tests
//! ```

use std::time::{Duration, Instant};

use serde_json::{Value, json};

use super::activities::{self, ActivityDetail, ActivityStatus};
use super::client::{self, TemporalClient};
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

async fn start(
    client: &TemporalClient,
    id: &str,
    fields: Value,
) -> activities::ActivityStartOutput {
    let mut input =
        json!({ "connId": "", "namespace": "lab", "activityId": id, "taskQueue": "lab" });
    for (k, v) in fields.as_object().unwrap() {
        input[k] = v.clone();
    }
    activities::start(client, serde_json::from_value(input).unwrap())
        .await
        .unwrap()
}

async fn describe(client: &TemporalClient, id: &str) -> ActivityDetail {
    activities::describe(
        client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "activityId": id }))
            .unwrap(),
    )
    .await
    .unwrap()
}

/// Describes the activity until it is no longer running (20 s at most).
async fn closed(client: &TemporalClient, id: &str) -> ActivityDetail {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let detail = describe(client, id).await;
        if detail.activity.status != ActivityStatus::Running || Instant::now() > deadline {
            return detail;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

#[tokio::test]
async fn the_lab_server_runs_them() {
    let client = lab().await;
    let support = activities::support(&client, "lab").await;
    assert!(support.supported, "{support:?}");
}

#[tokio::test]
async fn one_is_run_listed_counted_and_described_with_its_input_and_result() {
    let client = lab().await;
    let id = unique("sa-charge");
    let out = start(
        &client,
        &id,
        json!({ "activityType": "charge", "args": ["ord-sa"], "startToCloseTimeout": "10s", "retryPolicy": { "maximumAttempts": 3 } }),
    )
    .await;
    assert!(out.started);
    assert!(!out.run_id.is_empty());
    let detail = closed(&client, &id).await;
    assert_eq!(
        detail.activity.status,
        ActivityStatus::Completed,
        "{detail:?}"
    );
    assert_eq!(detail.activity.activity_type, "charge");
    assert_eq!(detail.activity.task_queue, "lab");
    assert_eq!(detail.activity.run_id, out.run_id);
    assert_eq!(detail.attempt, 1);
    assert_eq!(detail.input, vec![json!("ord-sa")]);
    assert_eq!(detail.result, Some(vec![json!("charged ord-sa")]));
    assert!(detail.failure.is_none());
    assert_eq!(detail.info["startToCloseTimeout"], "10s");
    assert_eq!(detail.info["retryPolicy"]["maximumAttempts"], 3);
    // Visibility catches up a moment later.
    let query = format!("ActivityId = \"{id}\"");
    let mut rows = Vec::new();
    for _ in 0..40 {
        rows = activities::list(
            &client,
            serde_json::from_value(json!({ "connId": "", "namespace": "lab", "query": query }))
                .unwrap(),
        )
        .await
        .unwrap()
        .executions;
        if rows
            .first()
            .is_some_and(|r| r.status == ActivityStatus::Completed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].activity_id, id);
    assert_eq!(rows[0].activity_type, "charge");
    assert_eq!(rows[0].status, ActivityStatus::Completed);
    assert!(rows[0].start_time.is_some() && rows[0].close_time.is_some());
    let count = activities::count(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "query": query }))
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(count.count, 1);
}

#[tokio::test]
async fn a_failing_one_shows_its_failure_and_why_it_stopped() {
    let client = lab().await;
    let id = unique("sa-flaky");
    start(
        &client,
        &id,
        json!({ "activityType": "flaky", "args": ["ord-sa"], "startToCloseTimeout": "10s", "retryPolicy": { "maximumAttempts": 1 } }),
    )
    .await;
    let detail = closed(&client, &id).await;
    assert_eq!(detail.activity.status, ActivityStatus::Failed, "{detail:?}");
    let failure = detail.failure.expect("a failure");
    assert!(
        failure["message"]
            .as_str()
            .unwrap()
            .contains("payment provider is down"),
        "{failure:?}"
    );
    assert_eq!(
        detail.retry_state.as_deref(),
        Some("MaximumAttemptsReached")
    );
}

#[tokio::test]
async fn a_running_one_is_cancelled_through_its_heartbeat() {
    let client = lab().await;
    let id = unique("sa-cancel");
    start(
        &client,
        &id,
        json!({ "activityType": "hold", "args": [60], "startToCloseTimeout": "2m", "heartbeatTimeout": "2s" }),
    )
    .await;
    // Started on the worker before it is asked.
    let deadline = Instant::now() + Duration::from_secs(10);
    while describe(&client, &id).await.run_state.as_deref() != Some("Started") {
        assert!(Instant::now() < deadline, "the worker did not start it");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    activities::cancel(
        &client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "activityId": id, "reason": "lab test" }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let detail = closed(&client, &id).await;
    assert_eq!(
        detail.activity.status,
        ActivityStatus::Canceled,
        "{detail:?}"
    );
}

#[tokio::test]
async fn terminate_needs_a_reason_and_ends_it_at_once() {
    let client = lab().await;
    let id = unique("sa-terminate");
    start(
        &client,
        &id,
        json!({ "activityType": "hold", "args": [60], "startToCloseTimeout": "2m" }),
    )
    .await;
    let no_reason = activities::terminate(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "activityId": id }))
            .unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(no_reason.kind, ToolErrorKind::Invalid);
    assert_eq!(no_reason.field.as_deref(), Some("reason"));
    activities::terminate(
        &client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "activityId": id, "reason": "lab test" }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let detail = describe(&client, &id).await;
    assert_eq!(
        detail.activity.status,
        ActivityStatus::Terminated,
        "{detail:?}"
    );
}

#[tokio::test]
async fn a_start_needs_one_of_the_close_timeouts_and_a_used_id_conflicts() {
    let client = lab().await;
    let id = unique("sa-rules");
    let no_timeout = activities::start(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "activityId": id, "activityType": "charge", "taskQueue": "lab" })).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(no_timeout.field.as_deref(), Some("startToCloseTimeout"));
    start(
        &client,
        &id,
        json!({ "activityType": "hold", "args": [30], "scheduleToCloseTimeout": "1m" }),
    )
    .await;
    // Running with the same ID: Fail (the default) refuses, UseExisting gives the running one.
    let again = activities::start(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "activityId": id, "activityType": "hold", "taskQueue": "lab", "args": [30], "scheduleToCloseTimeout": "1m" })).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(again.kind, ToolErrorKind::Conflict, "{again:?}");
    let existing = start(
        &client,
        &id,
        json!({ "activityType": "hold", "args": [30], "scheduleToCloseTimeout": "1m", "idConflictPolicy": "useExisting" }),
    )
    .await;
    assert!(!existing.started);
    activities::terminate(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "activityId": id, "reason": "lab test done" })).unwrap(),
    )
    .await
    .unwrap();
}
