//! `temporal.workers.list` (TSK-92, spec §9.3 "Workers"): every worker polling the namespace's
//! task queues. Temporal has no list of workers that every server and SDK fills (worker
//! heartbeats are newer and optional), but every server reports a task queue's pollers
//! (`DescribeTaskQueue`), so the workers are the pollers of each task queue seen in the
//! namespace's latest workflows (a schedule's runs among them) and of the ones the user typed.
//! Schedules are not described for this: `DescribeSchedule` is a consistent query on the
//! schedule's own workflow, too heavy for a list refreshed every 10 seconds. A worker that polls a
//! queue for workflow and activity tasks is one row.

use std::collections::{BTreeMap, BTreeSet};

use futures_util::stream::{self, StreamExt as _};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::client::{TemporalClient, status_error};
use super::proto::temporal::api::taskqueue::v1::{PollerInfo, TaskQueue};
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::rfc3339;
use crate::core::ToolError;

/// How many task queues one call describes, and how many at a time.
const MAX_QUEUES: usize = 50;
const PARALLEL: usize = 8;
/// How many of the latest workflows name the task queues.
const WORKFLOWS_SCANNED: i32 = 1_000;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkersListInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    /// Task queues to describe besides the ones seen.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub task_queues: Option<Vec<String>>,
}

/// Where a task queue was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum TaskQueueSource {
    Typed,
    Workflows,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SeenTaskQueue {
    pub name: String,
    pub source: TaskQueueSource,
    /// Why the queue could not be described.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// One worker on one task queue.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkerRow {
    pub identity: String,
    pub task_queue: String,
    pub polls_workflows: bool,
    pub polls_activities: bool,
    /// The build id it reports (worker versioning or deployment options).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub build_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deployment_name: Option<String>,
    /// Its latest poll on either kind, RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_access_time: Option<String>,
    /// Tasks per second over both kinds, as the server measures it.
    pub rate_per_second: f64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WorkersListOutput {
    pub workers: Vec<WorkerRow>,
    pub task_queues: Vec<SeenTaskQueue>,
    /// More task queues were seen than one call describes (50); typed ones come first.
    pub truncated: bool,
}

/// The task queues of the latest workflows; a failure is not fatal (an empty list).
async fn queues_of_workflows(client: &TemporalClient, namespace: &str) -> BTreeSet<String> {
    let response = client
        .service()
        .list_workflow_executions(client.request(
            namespace,
            ws::ListWorkflowExecutionsRequest {
                namespace: namespace.to_owned(),
                page_size: WORKFLOWS_SCANNED,
                next_page_token: Vec::new(),
                query: String::new(),
            },
        ))
        .await;
    response
        .map(|r| {
            r.into_inner()
                .executions
                .into_iter()
                .map(|e| e.task_queue)
                .filter(|q| !q.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// The pollers of one kind (1 workflow, 2 activity) of a queue.
async fn pollers(
    client: &TemporalClient,
    namespace: &str,
    queue: &str,
    kind: i32,
) -> Result<Vec<PollerInfo>, ToolError> {
    Ok(client
        .service()
        .describe_task_queue(client.request(
            namespace,
            ws::DescribeTaskQueueRequest {
                namespace: namespace.to_owned(),
                task_queue: Some(TaskQueue {
                    name: queue.to_owned(),
                    kind: 1,
                    normal_name: String::new(),
                }),
                task_queue_type: kind,
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner()
        .pollers)
}

/// The later of two RFC 3339 times in UTC (they compare as text).
fn later(a: Option<String>, b: Option<String>) -> Option<String> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// Adds one poller to the rows, keyed by identity and queue.
fn merge(
    rows: &mut BTreeMap<(String, String), WorkerRow>,
    queue: &str,
    poller: &PollerInfo,
    workflow: bool,
) {
    let deployment = poller.deployment_options.as_ref();
    #[allow(deprecated)]
    let build_id = deployment
        .map(|d| d.build_id.clone())
        .filter(|b| !b.is_empty())
        .or_else(|| {
            poller
                .worker_version_capabilities
                .as_ref()
                .map(|c| c.build_id.clone())
                .filter(|b| !b.is_empty())
        });
    let row = rows
        .entry((poller.identity.clone(), queue.to_owned()))
        .or_insert_with(|| WorkerRow {
            identity: poller.identity.clone(),
            task_queue: queue.to_owned(),
            polls_workflows: false,
            polls_activities: false,
            build_id: None,
            deployment_name: None,
            last_access_time: None,
            rate_per_second: 0.0,
        });
    if workflow {
        row.polls_workflows = true;
    } else {
        row.polls_activities = true;
    }
    row.build_id = row.build_id.take().or(build_id);
    row.deployment_name = row.deployment_name.take().or_else(|| {
        deployment
            .map(|d| d.deployment_name.clone())
            .filter(|n| !n.is_empty())
    });
    row.last_access_time = later(
        row.last_access_time.take(),
        poller.last_access_time.as_ref().and_then(rfc3339),
    );
    row.rate_per_second += poller.rate_per_second;
}

/// The workers of a namespace from the pollers of every task queue seen.
pub async fn list(
    client: &TemporalClient,
    input: WorkersListInput,
) -> Result<WorkersListOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let typed: BTreeSet<String> = input
        .task_queues
        .unwrap_or_default()
        .into_iter()
        .map(|q| q.trim().to_owned())
        .filter(|q| !q.is_empty())
        .collect();
    let of_workflows = queues_of_workflows(client, &namespace).await;
    // One source per queue: typed wins.
    let mut seen: BTreeMap<String, TaskQueueSource> = BTreeMap::new();
    for (queues, source) in [
        (&of_workflows, TaskQueueSource::Workflows),
        (&typed, TaskQueueSource::Typed),
    ] {
        for q in queues {
            seen.insert(q.clone(), source);
        }
    }
    let mut ordered: Vec<(String, TaskQueueSource)> = seen.into_iter().collect();
    ordered.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| a.0.cmp(&b.0)));
    let truncated = ordered.len() > MAX_QUEUES;
    ordered.truncate(MAX_QUEUES);

    let described: Vec<(String, TaskQueueSource, Result<_, ToolError>)> = stream::iter(ordered)
        .map(|(queue, source)| {
            let namespace = &namespace;
            async move {
                let both = async {
                    let workflow = pollers(client, namespace, &queue, 1).await?;
                    let activity = pollers(client, namespace, &queue, 2).await?;
                    Ok((workflow, activity))
                }
                .await;
                (queue, source, both)
            }
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;

    let mut rows = BTreeMap::new();
    let mut task_queues = Vec::new();
    for (queue, source, result) in described {
        match result {
            Ok((workflow, activity)) => {
                workflow
                    .iter()
                    .for_each(|p| merge(&mut rows, &queue, p, true));
                activity
                    .iter()
                    .for_each(|p| merge(&mut rows, &queue, p, false));
                task_queues.push(SeenTaskQueue {
                    name: queue,
                    source,
                    error: None,
                });
            }
            Err(e) => task_queues.push(SeenTaskQueue {
                name: queue,
                source,
                error: Some(e.message.clone()),
            }),
        }
    }
    task_queues.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(WorkersListOutput {
        workers: rows.into_values().collect(),
        task_queues,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::temporal::proto::temporal::api::deployment::v1::WorkerDeploymentOptions;

    fn poller(identity: &str, seconds: i64, rate: f64) -> PollerInfo {
        PollerInfo {
            identity: identity.into(),
            last_access_time: Some(prost_types::Timestamp { seconds, nanos: 0 }),
            rate_per_second: rate,
            ..Default::default()
        }
    }

    #[test]
    fn a_worker_on_both_kinds_is_one_row_with_its_latest_poll() {
        let mut rows = BTreeMap::new();
        merge(
            &mut rows,
            "orders",
            &poller("w1@h", 1_794_000_000, 1.5),
            true,
        );
        merge(
            &mut rows,
            "orders",
            &poller("w1@h", 1_794_000_060, 2.0),
            false,
        );
        merge(
            &mut rows,
            "payments",
            &poller("w1@h", 1_794_000_030, 0.0),
            false,
        );
        let rows: Vec<WorkerRow> = rows.into_values().collect();
        assert_eq!(rows.len(), 2);
        let orders = &rows[0];
        assert_eq!(orders.task_queue, "orders");
        assert!(orders.polls_workflows && orders.polls_activities);
        assert_eq!(
            orders.last_access_time.as_deref(),
            Some("2026-11-06T21:21:00Z")
        );
        assert!((orders.rate_per_second - 3.5).abs() < f64::EPSILON);
        assert!(!rows[1].polls_workflows && rows[1].polls_activities);
    }

    #[test]
    fn the_build_id_comes_from_the_deployment_options() {
        let mut rows = BTreeMap::new();
        let mut p = poller("w2", 1, 0.0);
        p.deployment_options = Some(WorkerDeploymentOptions {
            deployment_name: "orders".into(),
            build_id: "8c1e2a".into(),
            worker_versioning_mode: 0,
        });
        merge(&mut rows, "q", &p, true);
        let row = rows.into_values().next().unwrap();
        assert_eq!(row.build_id.as_deref(), Some("8c1e2a"));
        assert_eq!(row.deployment_name.as_deref(), Some("orders"));
    }
}
