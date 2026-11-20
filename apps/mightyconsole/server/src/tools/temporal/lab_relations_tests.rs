//! A workflow's relations against the lab (spec §9.3 "Workflow: Relations", §18 TSK-104): the
//! worker's family (`family-root` → `family-order` → fraud, payment, receipt; `family-support`
//! signals the order). Read-only.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_relations_tests
//! ```

use std::time::Duration;

use serde_json::json;

use super::client::{self, TemporalClient};
use super::relations::relations;
use super::relations_types::{
    RelationEdgeKind, RelationScope, SignalDirection, WorkflowRelations, WorkflowRelationsInput,
};
use super::types::{ConnectTemporalProfile, WorkflowStatus};

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(json!({
        "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab",
    }))
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

fn input(workflow_id: &str, scope: RelationScope) -> WorkflowRelationsInput {
    WorkflowRelationsInput {
        conn_id: String::new(),
        namespace: None,
        workflow_id: workflow_id.into(),
        run_id: None,
        scope: Some(scope),
    }
}

/// The order's relations once the family has formed: the receipt failed and the signal arrived.
async fn formed(client: &TemporalClient, scope: RelationScope) -> WorkflowRelations {
    for _ in 0..60 {
        let r = relations(client, input("family-order", scope))
            .await
            .unwrap();
        let receipt_failed = r
            .children
            .iter()
            .any(|c| c.workflow_id == "family-order-receipt" && c.status == WorkflowStatus::Failed);
        if receipt_failed && !r.signals.is_empty() {
            return r;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
    panic!("the lab's family did not form in a minute: is the worker up?");
}

#[tokio::test]
async fn the_order_sees_its_parent_children_and_the_signal() {
    let client = lab().await;
    let r = formed(&client, RelationScope::Direct).await;
    assert_eq!(r.workflow.workflow_id, "family-order");
    assert_eq!(r.root_workflow_id.as_deref(), Some("family-root"));
    let parent = r.parent.as_ref().expect("a parent");
    assert_eq!(parent.workflow_id, "family-root");
    // The order is pending in the root, which terminates it if it closes (the default).
    assert_eq!(parent.parent_close_policy.as_deref(), Some("Terminate"));
    let children: Vec<_> = r
        .children
        .iter()
        .map(|c| (c.workflow_id.as_str(), c.workflow_type.as_str(), c.status))
        .collect();
    assert_eq!(
        children,
        vec![
            ("family-order-fraud", "Completed", WorkflowStatus::Completed),
            (
                "family-order-payment",
                "Fulfilment",
                WorkflowStatus::Running
            ),
            ("family-order-receipt", "Failed", WorkflowStatus::Failed),
        ]
    );
    let receipt = &r.children[2];
    assert!(
        receipt
            .failure
            .as_deref()
            .unwrap_or_default()
            .contains("rejected"),
        "{receipt:?}"
    );
    let signal = r
        .signals
        .iter()
        .find(|s| s.direction == SignalDirection::Received)
        .expect("the support's signal");
    assert_eq!(signal.workflow_id, "family-support");
    assert_eq!(signal.signal_name.as_deref(), Some("customerConfirmed"));
    assert!(r.runs.continued_from.is_none() && r.runs.reset_from.is_none());

    // Direct only: the parent, the order, three children, and the support outside the tree.
    assert_eq!(r.family.scope, RelationScope::Direct);
    assert!(
        r.family.supported,
        "the lab's server knows RootWorkflowId: {:?}",
        r.family.reason
    );
    assert_eq!(
        r.family.query.as_deref(),
        Some("ParentWorkflowId = \"family-order\"")
    );
    let level = |id: &str| {
        r.nodes
            .iter()
            .find(|n| n.workflow_id == id)
            .map(|n| n.level)
    };
    assert_eq!(level("family-root"), Some(Some(0)));
    assert_eq!(level("family-order"), Some(Some(1)));
    assert_eq!(level("family-order-receipt"), Some(Some(2)));
    assert_eq!(level("family-support"), Some(None));
    assert!(
        r.nodes
            .iter()
            .find(|n| n.workflow_id == "family-order")
            .unwrap()
            .current
    );
    assert!(r.edges.iter().any(|e| e.kind == RelationEdgeKind::Signal
        && e.from == "family-support"
        && e.to == "family-order"
        && e.label.as_deref() == Some("customerConfirmed")));
}

#[tokio::test]
async fn the_whole_family_is_listed_from_the_root() {
    let client = lab().await;
    let r = formed(&client, RelationScope::Family).await;
    assert_eq!(r.family.scope, RelationScope::Family);
    assert_eq!(
        r.family.query.as_deref(),
        Some("RootWorkflowId = \"family-root\"")
    );
    assert!(r.family.total.unwrap_or_default() >= 5, "{:?}", r.family);
    assert_eq!((r.family.levels, r.family.not_drawn), (3, 0));
    let mut tree: Vec<_> = r
        .nodes
        .iter()
        .filter_map(|n| n.level.map(|l| (l, n.workflow_id.as_str())))
        .collect();
    tree.sort();
    assert_eq!(
        tree,
        vec![
            (0, "family-root"),
            (1, "family-order"),
            (2, "family-order-fraud"),
            (2, "family-order-payment"),
            (2, "family-order-receipt"),
        ]
    );
    let receipt = r
        .nodes
        .iter()
        .find(|n| n.workflow_id == "family-order-receipt")
        .unwrap();
    assert_eq!(receipt.status, WorkflowStatus::Failed);
    assert!(receipt.failure.is_some());
    let child_edges = r
        .edges
        .iter()
        .filter(|e| e.kind == RelationEdgeKind::Child)
        .count();
    assert_eq!(child_edges, 4);

    // From a child, the same family: its parent is the order.
    let from_child = relations(
        &client,
        input("family-order-receipt", RelationScope::Family),
    )
    .await
    .unwrap();
    assert_eq!(from_child.root_workflow_id.as_deref(), Some("family-root"));
    assert_eq!(from_child.parent.unwrap().workflow_id, "family-order");
    assert_eq!(from_child.family.drawn, r.family.drawn);
}
