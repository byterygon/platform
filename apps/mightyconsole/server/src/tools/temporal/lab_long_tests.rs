//! Long histories against the lab (TSK-109, spec §9.6.1): the seed's `history-many-1` (about
//! 48,000 events), `history-heavy-1` (about 46 MiB in 40 KiB payloads, whose 1,000-event pages
//! were over the 16 MiB frame) and `history-follow-1` (running, growing). Read-only.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_long_tests
//! ```

use serde_json::json;

use super::client::{self, TemporalClient};
use super::detail::{
    EVENT_SHARE, HistoryDownload, REPLY_BYTES, describe, follow_step, history, raw_event,
};
use super::detail_types::{
    WorkflowHistoryInput, WorkflowHistoryOutput, WorkflowRawEventInput, WorkflowRef,
};
use super::proto::temporal::api::common::v1::WorkflowExecution;
use super::types::ConnectTemporalProfile;

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(json!({
        "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab",
    }))
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up and seeded: `lab up temporal`")
}

async fn length_and_run(client: &TemporalClient, workflow_id: &str) -> (i64, String) {
    let detail = describe(
        client,
        WorkflowRef {
            conn_id: String::new(),
            namespace: None,
            workflow_id: workflow_id.into(),
            run_id: None,
        },
    )
    .await
    .unwrap();
    (detail.workflow.history_length, detail.workflow.run_id)
}

fn page(
    workflow_id: &str,
    run_id: &str,
    token: Option<String>,
    reverse: bool,
) -> WorkflowHistoryInput {
    WorkflowHistoryInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: workflow_id.into(),
        run_id: Some(run_id.into()),
        page_size: None,
        next_page_token: token,
        reverse: Some(reverse),
    }
}

/// Every page of a closed run in one order; each reply as it would travel is under the budget
/// (plus one event's share: the first event always goes).
async fn all_pages(client: &TemporalClient, workflow_id: &str, reverse: bool) -> (Vec<i64>, usize) {
    let (_, run_id) = length_and_run(client, workflow_id).await;
    let mut ids = Vec::new();
    let mut token = None;
    let mut pages = 0;
    loop {
        let out: WorkflowHistoryOutput =
            history(client, page(workflow_id, &run_id, token, reverse))
                .await
                .unwrap();
        let bytes = serde_json::to_vec(&out).unwrap().len();
        assert!(
            bytes <= REPLY_BYTES + EVENT_SHARE,
            "a reply of {bytes} bytes for {workflow_id}"
        );
        ids.extend(out.events.iter().map(|e| e.event_id));
        pages += 1;
        match out.next_page_token {
            Some(next) => token = Some(next),
            None => return (ids, pages),
        }
    }
}

#[tokio::test]
async fn the_longest_history_pages_newest_first_without_gaps() {
    let client = lab().await;
    let (length, _) = length_and_run(&client, "history-many-1").await;
    assert!(
        length >= 40_000,
        "history-many-1 has {length} events: seed the lab"
    );
    let (ids, pages) = all_pages(&client, "history-many-1", true).await;
    assert_eq!(ids, (1..=length).rev().collect::<Vec<i64>>());
    assert!(pages >= 2, "{pages} pages");
}

#[tokio::test]
async fn the_heaviest_history_pages_under_the_frame_both_ways() {
    let client = lab().await;
    let (length, _) = length_and_run(&client, "history-heavy-1").await;
    assert!(
        length >= 1_000,
        "history-heavy-1 has {length} events: seed the lab"
    );
    for reverse in [false, true] {
        let (ids, pages) = all_pages(&client, "history-heavy-1", reverse).await;
        let mut want: Vec<i64> = (1..=length).collect();
        if reverse {
            want.reverse();
        }
        assert_eq!(ids, want, "reverse {reverse}");
        // 46 MiB in replies of at most 4 MiB.
        assert!(pages >= 11, "{pages} pages");
    }
}

#[tokio::test]
async fn a_running_long_history_is_followed_from_its_newest_event() {
    let client = lab().await;
    let (_, run_id) = length_and_run(&client, "history-follow-1").await;
    let first = history(&client, page("history-follow-1", &run_id, None, true))
        .await
        .unwrap();
    let newest = first.events.first().map(|e| e.event_id).unwrap();
    assert!(newest >= 20_000, "history-follow-1 has {newest} events");
    let execution = WorkflowExecution {
        workflow_id: "history-follow-1".into(),
        run_id,
    };
    // The run adds an activity every 2 s; the long poll answers with the events after `newest`.
    let mut token = Vec::new();
    let mut seen = Vec::new();
    for _ in 0..80 {
        let step = follow_step(&client, "lab", execution.clone(), token, newest)
            .await
            .unwrap();
        seen.extend(step.events.iter().map(|e| e.event_id));
        if !seen.is_empty() || step.token.is_empty() {
            break;
        }
        token = step.token;
    }
    assert_eq!(seen.first(), Some(&(newest + 1)), "{seen:?}");
    assert!(seen.windows(2).all(|w| w[1] == w[0] + 1));
}

#[tokio::test]
async fn an_event_reads_as_stored_from_either_end() {
    let client = lab().await;
    let (length, run_id) = length_and_run(&client, "history-many-1").await;
    for event_id in [2, length - 1] {
        let out = raw_event(
            &client,
            WorkflowRawEventInput {
                conn_id: String::new(),
                namespace: None,
                workflow_id: "history-many-1".into(),
                run_id: Some(run_id.clone()),
                event_id,
            },
        )
        .await
        .unwrap();
        assert!(!out.attributes.is_empty(), "event {event_id}");
    }
}

#[tokio::test]
async fn the_heavy_history_downloads_a_page_at_a_time_in_both_forms() {
    let client = lab().await;
    let (length, run_id) = length_and_run(&client, "history-heavy-1").await;
    for decoded in [true, false] {
        let execution = WorkflowExecution {
            workflow_id: "history-heavy-1".into(),
            run_id: run_id.clone(),
        };
        let mut download = HistoryDownload::new(&client, "lab", execution, decoded);
        let mut count = 0i64;
        let mut first = None;
        while let Some(page) = download.next_page().await.unwrap() {
            if first.is_none() {
                first = page.first().cloned();
            }
            count += page.len() as i64;
        }
        assert_eq!(count, length);
        // `temporal workflow show --output json`'s events: the id, the type, the attributes.
        let first = first.unwrap();
        assert_eq!(first["eventId"], json!(1));
        let input = &first["workflowExecutionStartedEventAttributes"]["input"];
        if decoded {
            assert!(input.is_array(), "decoded input: {input}");
        } else {
            assert!(
                input["payloads"][0]["data"].is_string(),
                "stored input: {input}"
            );
        }
    }
}
