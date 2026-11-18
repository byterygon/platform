//! TSK-92's additions against the lab's dev server and worker (spec §18, "TSK-92, Temporal
//! additions"):
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_more_tests
//! ```

use super::client::{self, TemporalClient};
use super::namespaces::{self, NamespaceDescribeInput};
use super::types::ConnectTemporalProfile;
use super::workers::{self, TaskQueueSource, WorkersListInput};
use crate::core::ToolErrorKind;

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(serde_json::json!({
        "name": "lab",
        "address": "127.0.0.1:7233",
        "namespace": "lab",
    }))
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

#[tokio::test]
async fn a_namespace_is_described_with_its_settings_and_capabilities() {
    let client = lab().await;
    let lab = namespaces::describe(
        &client,
        NamespaceDescribeInput {
            conn_id: String::new(),
            namespace: "lab".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(lab.name, "lab");
    assert_eq!(lab.state, "Registered");
    assert!(!lab.id.is_empty());
    assert!(lab.retention_secs.is_some_and(|s| s > 0));
    assert!(!lab.history_archival.enabled && !lab.visibility_archival.enabled);
    assert!(!lab.active_cluster.is_empty() && !lab.clusters.is_empty());
    // The dev server (Temporal Server 1.32) has standalone activities and reports its limits.
    assert!(
        lab.capabilities.iter().any(|c| c == "standaloneActivities"),
        "{:?}",
        lab.capabilities
    );
    assert_eq!(lab.limits.blob_size_limit_error, Some(2 * 1024 * 1024));

    let missing = namespaces::describe(
        &client,
        NamespaceDescribeInput {
            conn_id: String::new(),
            namespace: "no-such-namespace".into(),
        },
    )
    .await
    .unwrap_err();
    assert_eq!(missing.kind, ToolErrorKind::NotFound, "{missing:?}");
}

#[tokio::test]
async fn the_lab_worker_is_listed_on_its_task_queue_with_both_kinds() {
    let client = lab().await;
    let out = workers::list(
        &client,
        WorkersListInput {
            conn_id: String::new(),
            namespace: None,
            task_queues: Some(vec!["nobody-polls-this".into(), "  ".into()]),
        },
    )
    .await
    .unwrap();
    let lab_queue = out
        .task_queues
        .iter()
        .find(|q| q.name == "lab")
        .expect("the lab's workflows run on `lab`");
    assert_ne!(lab_queue.source, TaskQueueSource::Typed);
    assert!(lab_queue.error.is_none());
    let typed = out
        .task_queues
        .iter()
        .find(|q| q.name == "nobody-polls-this")
        .unwrap();
    assert_eq!(typed.source, TaskQueueSource::Typed);
    assert!(out.task_queues.iter().all(|q| !q.name.trim().is_empty()));

    let worker = out
        .workers
        .iter()
        .find(|w| w.task_queue == "lab")
        .expect("the lab worker polls `lab`");
    assert!(
        worker.polls_workflows && worker.polls_activities,
        "{worker:?}"
    );
    assert!(!worker.identity.is_empty());
    assert!(
        worker
            .last_access_time
            .as_deref()
            .is_some_and(|t| t.ends_with('Z'))
    );
    assert!(
        out.workers
            .iter()
            .all(|w| w.task_queue != "nobody-polls-this")
    );
    assert!(!out.truncated);
}
