//! `temporal.namespaces.describe` (TSK-92, spec §9.3 "Namespaces"): one namespace's settings as
//! `DescribeNamespace` reports them, for the Namespaces tab's side pane. Read only: registering,
//! updating and deleting namespaces is cluster administration and stays out (spec §9.4).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::client::{TemporalClient, status_error};
use super::proto::temporal::api::namespace::v1::namespace_info::Capabilities;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::{TOOL, namespace_state};
use crate::core::ToolError;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceDescribeInput {
    pub conn_id: String,
    pub namespace: String,
}

/// Whether closed workflows' histories or visibility records are archived, and where.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Archival {
    pub enabled: bool,
    /// The archive's URI when one is set.
    pub uri: String,
}

/// The size limits the namespace enforces, in bytes, when the server reports them.
#[derive(Debug, Clone, Default, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceLimits {
    /// A payload larger than this fails the workflow task (Temporal's default: 2 MiB).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub blob_size_limit_error: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memo_size_limit_error: Option<i64>,
}

/// One namespace in full (`DescribeNamespace`).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NamespaceDetail {
    pub name: String,
    pub id: String,
    /// `Registered`, `Deprecated`, `Deleted` or `Unspecified`.
    pub state: String,
    pub description: String,
    pub owner_email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub retention_secs: Option<i64>,
    pub history_archival: Archival,
    pub visibility_archival: Archival,
    pub is_global: bool,
    /// The cluster that accepts writes; empty when the server did not say.
    pub active_cluster: String,
    pub clusters: Vec<String>,
    /// The features the namespace reports as on, by their camelCase proto names
    /// (`eagerWorkflowStart`, `standaloneActivities`, ...).
    pub capabilities: Vec<String>,
    pub limits: NamespaceLimits,
    /// The namespace's own key-value data.
    pub data: Vec<(String, String)>,
}

/// The capabilities that are on, by name.
fn capability_names(c: &Capabilities) -> Vec<String> {
    [
        ("eagerWorkflowStart", c.eager_workflow_start),
        ("syncUpdate", c.sync_update),
        ("asyncUpdate", c.async_update),
        ("workerHeartbeats", c.worker_heartbeats),
        ("workflowPause", c.workflow_pause),
        ("standaloneActivities", c.standalone_activities),
        ("standaloneNexusOperation", c.standalone_nexus_operation),
        ("pollerAutoscaling", c.poller_autoscaling),
    ]
    .into_iter()
    .filter(|(_, on)| *on)
    .map(|(name, _)| name.to_owned())
    .collect()
}

/// `DescribeNamespace` as the side pane shows it.
pub async fn describe(
    client: &TemporalClient,
    input: NamespaceDescribeInput,
) -> Result<NamespaceDetail, ToolError> {
    let name = input.namespace.trim();
    if name.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "namespace",
            "a namespace name is required",
        ));
    }
    let response = client
        .service()
        .describe_namespace(client.request(
            name,
            ws::DescribeNamespaceRequest {
                namespace: name.to_owned(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let info = response.namespace_info.unwrap_or_default();
    let config = response.config.unwrap_or_default();
    let replication = response.replication_config.unwrap_or_default();
    let positive = |n: i64| (n > 0).then_some(n);
    let limits = info
        .limits
        .as_ref()
        .map(|l| NamespaceLimits {
            blob_size_limit_error: positive(l.blob_size_limit_error),
            memo_size_limit_error: positive(l.memo_size_limit_error),
        })
        .unwrap_or_default();
    let mut data: Vec<(String, String)> = info.data.into_iter().collect();
    data.sort();
    Ok(NamespaceDetail {
        name: info.name,
        id: info.id,
        state: namespace_state(info.state).into(),
        description: info.description,
        owner_email: info.owner_email,
        retention_secs: config
            .workflow_execution_retention_ttl
            .as_ref()
            .map(|d| d.seconds),
        // ArchivalState: 1 disabled, 2 enabled.
        history_archival: Archival {
            enabled: config.history_archival_state == 2,
            uri: config.history_archival_uri,
        },
        visibility_archival: Archival {
            enabled: config.visibility_archival_state == 2,
            uri: config.visibility_archival_uri,
        },
        is_global: response.is_global_namespace,
        active_cluster: replication.active_cluster_name,
        clusters: replication
            .clusters
            .into_iter()
            .map(|c| c.cluster_name)
            .collect(),
        capabilities: info
            .capabilities
            .as_ref()
            .map(capability_names)
            .unwrap_or_default(),
        limits,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_capabilities_that_are_on_are_named() {
        let c = Capabilities {
            eager_workflow_start: true,
            standalone_activities: true,
            ..Default::default()
        };
        assert_eq!(
            capability_names(&c),
            vec!["eagerWorkflowStart", "standaloneActivities"]
        );
    }
}
