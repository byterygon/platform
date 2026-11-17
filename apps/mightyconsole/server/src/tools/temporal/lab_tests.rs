//! The Temporal tool against the lab's dev server (spec §14, §18; run by `acceptance temporal`):
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_tests
//! ```
//!
//! The lab seeds namespace `lab` with a running, a completed and a failed workflow, among others.

use super::client::{self, TemporalClient};
use super::types::{
    ConnectTemporalProfile, WorkflowStatus, WorkflowsCountInput, WorkflowsListInput,
};
use super::{count_workflows, list_namespaces, list_workflows, server_info};
use crate::core::ToolErrorKind;

fn profile(address: &str, namespace: &str) -> ConnectTemporalProfile {
    serde_json::from_value(serde_json::json!({
        "name": "lab",
        "address": address,
        "namespace": namespace,
    }))
    .unwrap()
}

async fn lab() -> TemporalClient {
    client::connect(&profile("127.0.0.1:7233", "lab"))
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

fn list(query: &str, page_size: u32, token: Option<String>) -> WorkflowsListInput {
    WorkflowsListInput {
        conn_id: String::new(),
        namespace: None,
        query: Some(query.into()),
        page_size: Some(page_size),
        next_page_token: token,
    }
}

#[tokio::test]
async fn the_server_says_who_it_is() {
    let info = server_info(&lab().await).await.unwrap();
    assert!(
        info.server_version.starts_with("1."),
        "{}",
        info.server_version
    );
}

#[tokio::test]
async fn namespaces_are_listed_with_the_profiles_one_marked() {
    let namespaces = list_namespaces(&lab().await).await.unwrap();
    let names: Vec<&str> = namespaces.iter().map(|n| n.name.as_str()).collect();
    assert!(
        names.contains(&"default") && names.contains(&"lab"),
        "{names:?}"
    );
    assert!(names.windows(2).all(|w| w[0] <= w[1]), "sorted: {names:?}");
    let lab = namespaces.iter().find(|n| n.name == "lab").unwrap();
    assert!(lab.is_default);
    assert_eq!(lab.state, "Registered");
    assert!(lab.retention_secs.is_some());
    assert!(
        !namespaces
            .iter()
            .find(|n| n.name == "default")
            .unwrap()
            .is_default
    );
}

#[tokio::test]
async fn workflows_are_listed_by_visibility_query_with_status_and_paging() {
    let client = lab().await;
    for (status, expected) in [
        ("Running", WorkflowStatus::Running),
        ("Completed", WorkflowStatus::Completed),
        ("Failed", WorkflowStatus::Failed),
    ] {
        let page = list_workflows(
            &client,
            list(&format!("ExecutionStatus = \"{status}\""), 50, None),
        )
        .await
        .unwrap();
        assert!(!page.executions.is_empty(), "a {status} workflow is seeded");
        assert!(page.executions.iter().all(|w| w.status == expected));
        let first = &page.executions[0];
        assert!(!first.workflow_id.is_empty() && !first.run_id.is_empty());
        assert!(!first.workflow_type.is_empty() && !first.task_queue.is_empty());
        assert!(
            first
                .start_time
                .as_deref()
                .is_some_and(|t| t.ends_with('Z'))
        );
        assert_eq!(
            first.close_time.is_some(),
            expected != WorkflowStatus::Running
        );
    }

    // Paging: one at a time until the token ends; every page is as asked and none repeats.
    let total = count_workflows(
        &client,
        WorkflowsCountInput {
            conn_id: String::new(),
            namespace: None,
            query: None,
        },
    )
    .await
    .unwrap()
    .count;
    assert!(total >= 3, "the lab seeds several workflows, found {total}");
    let mut seen = Vec::new();
    let mut token = None;
    loop {
        let page = list_workflows(&client, list("", 2, token)).await.unwrap();
        assert!(page.executions.len() <= 2);
        seen.extend(
            page.executions
                .into_iter()
                .map(|w| (w.workflow_id, w.run_id)),
        );
        token = page.next_page_token;
        if token.is_none() {
            break;
        }
    }
    let mut unique = seen.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), seen.len(), "no workflow on two pages");
    assert_eq!(seen.len() as i64, total);
}

#[tokio::test]
async fn the_count_follows_the_query() {
    let client = lab().await;
    let count = |query: &str| {
        let query = query.to_owned();
        let client = &client;
        async move {
            count_workflows(
                client,
                WorkflowsCountInput {
                    conn_id: String::new(),
                    namespace: None,
                    query: Some(query),
                },
            )
            .await
            .unwrap()
            .count
        }
    };
    let all = count("").await;
    let failed = count("ExecutionStatus = \"Failed\"").await;
    assert!(failed >= 1 && failed < all, "{failed} of {all}");
    assert_eq!(count("WorkflowType = \"no-such-type-anywhere\"").await, 0);
}

#[tokio::test]
async fn a_bad_query_is_invalid_and_an_unknown_namespace_is_not_found() {
    let client = lab().await;
    let error = list_workflows(&client, list("this is not a query ((", 10, None))
        .await
        .unwrap_err();
    assert_eq!(error.kind, ToolErrorKind::Invalid, "{error:?}");
    assert!(!error.message.is_empty());

    let mut other = list("", 10, None);
    other.namespace = Some("no-such-namespace".into());
    let error = list_workflows(&client, other).await.unwrap_err();
    assert_eq!(error.kind, ToolErrorKind::NotFound, "{error:?}");
}

#[tokio::test]
async fn a_bad_page_size_or_token_is_invalid_before_any_call() {
    let client = lab().await;
    let error = list_workflows(&client, list("", 0, None))
        .await
        .unwrap_err();
    assert_eq!(error.field.as_deref(), Some("pageSize"));
    let error = list_workflows(&client, list("", 10, Some("@@".into())))
        .await
        .unwrap_err();
    assert_eq!(error.field.as_deref(), Some("nextPageToken"));
}
