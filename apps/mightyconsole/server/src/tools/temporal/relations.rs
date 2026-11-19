//! A workflow's relations (Mightyconsole spec §9.3 "Workflow: Relations", §9.6
//! `temporal.workflows.relations`, TSK-104): its parent and root from `DescribeWorkflowExecution`,
//! its children, the signals and cancels it sent or received and its run links from its history,
//! and for Whole family every workflow under the root from a visibility query on `RootWorkflowId`.
//!
//! Only this run's history is read: the signals between two other workflows of the family are not
//! drawn (reading up to 200 histories for one tab would cost more than the arrows are worth).
//! `ParentWorkflowId` came with Temporal Server 1.23 and `RootWorkflowId` with 1.24; rather than
//! trusting a version string, the server is asked (a count on each attribute) and its answer is
//! the reason shown when it refuses.

use std::collections::{BTreeMap, HashMap, HashSet};

use futures_util::stream::{self, StreamExt as _};

use super::client::{TemporalClient, status_error};
use super::detail::execution;
use super::proto::temporal::api::common::v1::WorkflowExecution;
use super::proto::temporal::api::enums::v1::{
    CancelExternalWorkflowExecutionFailedCause, ContinueAsNewInitiator, ParentClosePolicy,
    SignalExternalWorkflowExecutionFailedCause, StartChildWorkflowExecutionFailedCause,
    WorkflowTaskFailedCause,
};
use super::proto::temporal::api::history::v1::HistoryEvent;
use super::proto::temporal::api::history::v1::history_event::Attributes as A;
use super::proto::temporal::api::workflow::v1::WorkflowExecutionInfo;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::relations_types::*;
use super::types::{WorkflowRow, WorkflowStatus};
use super::{TOOL, rfc3339, row};
use crate::core::{ToolError, ToolErrorKind};

/// Boxes drawn in the family tree at most (spec §9.3).
pub const MAX_DRAWN: usize = 200;
/// One visibility page of the family: enough to place 200 boxes by whole levels.
const FAMILY_PAGE: i32 = 1_000;
/// The other workflows of signals and cancels described at most, and at once.
const MAX_PEERS: usize = 50;
const PARALLEL: usize = 8;
/// History pages read at most (Temporal's default limit is 51,200 events).
const MAX_HISTORY_PAGES: usize = 60;

/// A value in a visibility query, double-quoted as the query bar writes it.
pub fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `PARENT_CLOSE_POLICY_REQUEST_CANCEL` as `RequestCancel`.
fn enum_word(name: &str, prefix: &str) -> String {
    name.trim_start_matches(prefix)
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|c| c.to_string() + &chars.as_str().to_ascii_lowercase())
                .unwrap_or_default()
        })
        .collect()
}

fn initiator(value: i32) -> Option<String> {
    ContinueAsNewInitiator::try_from(value)
        .ok()
        .filter(|i| *i != ContinueAsNewInitiator::Unspecified)
        .map(|i| enum_word(i.as_str_name(), "CONTINUE_AS_NEW_INITIATOR_"))
}

fn ms_between(a: &prost_types::Timestamp, b: &prost_types::Timestamp) -> i64 {
    (b.seconds - a.seconds) * 1_000 + i64::from((b.nanos - a.nanos) / 1_000_000)
}

fn some_id(execution: Option<&WorkflowExecution>) -> Option<&WorkflowExecution> {
    execution.filter(|e| !e.workflow_id.is_empty())
}

fn non_empty(s: &str) -> Option<String> {
    (!s.is_empty()).then(|| s.to_owned())
}

/// What one run's history says about its relations.
#[derive(Debug, Default, PartialEq)]
pub struct HistoryScan {
    pub children: Vec<RelationChild>,
    /// Child durations in milliseconds, by workflow ID (closed children only).
    pub child_durations: HashMap<String, i64>,
    pub signals: Vec<RelationSignal>,
    pub runs: RelationRuns,
}

/// Reads children, signals, cancels and run links from a run's events, oldest first.
pub fn scan_history(events: &[HistoryEvent], run_id: &str) -> HistoryScan {
    let mut scan = HistoryScan::default();
    // By initiated event id: the index in `children` or `signals`.
    let mut child_at: HashMap<i64, usize> = HashMap::new();
    let mut child_started: HashMap<i64, prost_types::Timestamp> = HashMap::new();
    let mut sent_at: HashMap<i64, usize> = HashMap::new();
    for event in events {
        let time = event.event_time.as_ref();
        let Some(attributes) = &event.attributes else {
            continue;
        };
        match attributes {
            A::WorkflowExecutionStartedEventAttributes(a) => {
                if !a.continued_execution_run_id.is_empty() {
                    scan.runs.continued_from = Some(RunLink {
                        run_id: a.continued_execution_run_id.clone(),
                        initiator: initiator(a.initiator),
                    });
                }
                if !a.first_execution_run_id.is_empty() && a.first_execution_run_id != run_id {
                    scan.runs.first_run_id = Some(a.first_execution_run_id.clone());
                }
            }
            A::WorkflowExecutionContinuedAsNewEventAttributes(a) => {
                scan.runs.continued_as = non_empty(&a.new_execution_run_id).map(|r| RunLink {
                    run_id: r,
                    initiator: initiator(a.initiator).or_else(|| Some("Workflow".into())),
                });
            }
            A::WorkflowExecutionCompletedEventAttributes(a) => {
                scan.runs.continued_as = non_empty(&a.new_execution_run_id).map(|r| RunLink {
                    run_id: r,
                    initiator: Some("CronSchedule".into()),
                });
            }
            A::WorkflowExecutionFailedEventAttributes(a) => {
                scan.runs.continued_as = non_empty(&a.new_execution_run_id).map(|r| RunLink {
                    run_id: r,
                    initiator: None,
                });
            }
            A::WorkflowExecutionTimedOutEventAttributes(a) => {
                scan.runs.continued_as = non_empty(&a.new_execution_run_id).map(|r| RunLink {
                    run_id: r,
                    initiator: None,
                });
            }
            A::WorkflowTaskFailedEventAttributes(a) => {
                if a.cause == WorkflowTaskFailedCause::ResetWorkflow as i32
                    && !a.base_run_id.is_empty()
                    && a.base_run_id != run_id
                {
                    scan.runs.reset_from = Some(a.base_run_id.clone());
                }
            }
            A::StartChildWorkflowExecutionInitiatedEventAttributes(a) => {
                child_at.insert(event.event_id, scan.children.len());
                scan.children.push(RelationChild {
                    workflow_id: a.workflow_id.clone(),
                    run_id: None,
                    workflow_type: a
                        .workflow_type
                        .as_ref()
                        .map(|t| t.name.clone())
                        .unwrap_or_default(),
                    status: WorkflowStatus::Unspecified,
                    initiated_event_id: event.event_id,
                    start_time: None,
                    close_time: None,
                    failure: None,
                });
            }
            A::StartChildWorkflowExecutionFailedEventAttributes(a) => {
                if let Some(child) = child_at
                    .get(&a.initiated_event_id)
                    .and_then(|i| scan.children.get_mut(*i))
                {
                    let cause = StartChildWorkflowExecutionFailedCause::try_from(a.cause)
                        .map(|c| {
                            enum_word(
                                c.as_str_name(),
                                "START_CHILD_WORKFLOW_EXECUTION_FAILED_CAUSE_",
                            )
                        })
                        .unwrap_or_default();
                    child.failure = Some(format!("Could not start: {cause}"));
                    child.close_time = time.and_then(rfc3339);
                }
            }
            A::ChildWorkflowExecutionStartedEventAttributes(a) => {
                if let Some(child) = child_at
                    .get(&a.initiated_event_id)
                    .and_then(|i| scan.children.get_mut(*i))
                {
                    child.status = WorkflowStatus::Running;
                    child.run_id = a.workflow_execution.as_ref().map(|e| e.run_id.clone());
                    child.start_time = time.and_then(rfc3339);
                    if let Some(t) = time {
                        child_started.insert(a.initiated_event_id, *t);
                    }
                }
            }
            A::ChildWorkflowExecutionCompletedEventAttributes(a) => close_child(
                &mut scan,
                &child_at,
                &child_started,
                a.initiated_event_id,
                time,
                WorkflowStatus::Completed,
                None,
            ),
            A::ChildWorkflowExecutionFailedEventAttributes(a) => close_child(
                &mut scan,
                &child_at,
                &child_started,
                a.initiated_event_id,
                time,
                WorkflowStatus::Failed,
                a.failure.as_ref().map(|f| f.message.clone()),
            ),
            A::ChildWorkflowExecutionCanceledEventAttributes(a) => close_child(
                &mut scan,
                &child_at,
                &child_started,
                a.initiated_event_id,
                time,
                WorkflowStatus::Canceled,
                None,
            ),
            A::ChildWorkflowExecutionTimedOutEventAttributes(a) => close_child(
                &mut scan,
                &child_at,
                &child_started,
                a.initiated_event_id,
                time,
                WorkflowStatus::TimedOut,
                None,
            ),
            A::ChildWorkflowExecutionTerminatedEventAttributes(a) => close_child(
                &mut scan,
                &child_at,
                &child_started,
                a.initiated_event_id,
                time,
                WorkflowStatus::Terminated,
                None,
            ),
            A::WorkflowExecutionSignaledEventAttributes(a) => {
                if let Some(from) = some_id(a.external_workflow_execution.as_ref()) {
                    scan.signals.push(RelationSignal {
                        direction: SignalDirection::Received,
                        kind: RelationEdgeKind::Signal,
                        workflow_id: from.workflow_id.clone(),
                        run_id: non_empty(&from.run_id),
                        signal_name: non_empty(&a.signal_name),
                        event_id: event.event_id,
                        time: time.and_then(rfc3339),
                        outcome: None,
                    });
                }
            }
            A::WorkflowExecutionCancelRequestedEventAttributes(a) => {
                if let Some(from) = some_id(a.external_workflow_execution.as_ref()) {
                    scan.signals.push(RelationSignal {
                        direction: SignalDirection::Received,
                        kind: RelationEdgeKind::Cancel,
                        workflow_id: from.workflow_id.clone(),
                        run_id: non_empty(&from.run_id),
                        signal_name: None,
                        event_id: event.event_id,
                        time: time.and_then(rfc3339),
                        outcome: None,
                    });
                }
            }
            A::SignalExternalWorkflowExecutionInitiatedEventAttributes(a) => {
                if let Some(to) = some_id(a.workflow_execution.as_ref()) {
                    sent_at.insert(event.event_id, scan.signals.len());
                    scan.signals.push(RelationSignal {
                        direction: SignalDirection::Sent,
                        kind: RelationEdgeKind::Signal,
                        workflow_id: to.workflow_id.clone(),
                        run_id: non_empty(&to.run_id),
                        signal_name: non_empty(&a.signal_name),
                        event_id: event.event_id,
                        time: time.and_then(rfc3339),
                        outcome: None,
                    });
                }
            }
            A::RequestCancelExternalWorkflowExecutionInitiatedEventAttributes(a) => {
                if let Some(to) = some_id(a.workflow_execution.as_ref()) {
                    sent_at.insert(event.event_id, scan.signals.len());
                    scan.signals.push(RelationSignal {
                        direction: SignalDirection::Sent,
                        kind: RelationEdgeKind::Cancel,
                        workflow_id: to.workflow_id.clone(),
                        run_id: non_empty(&to.run_id),
                        signal_name: None,
                        event_id: event.event_id,
                        time: time.and_then(rfc3339),
                        outcome: None,
                    });
                }
            }
            A::ExternalWorkflowExecutionSignaledEventAttributes(a) => {
                outcome(
                    &mut scan,
                    &sent_at,
                    a.initiated_event_id,
                    "Delivered".into(),
                );
            }
            A::ExternalWorkflowExecutionCancelRequestedEventAttributes(a) => {
                outcome(
                    &mut scan,
                    &sent_at,
                    a.initiated_event_id,
                    "Delivered".into(),
                );
            }
            A::SignalExternalWorkflowExecutionFailedEventAttributes(a) => {
                let cause = SignalExternalWorkflowExecutionFailedCause::try_from(a.cause)
                    .map(|c| {
                        enum_word(
                            c.as_str_name(),
                            "SIGNAL_EXTERNAL_WORKFLOW_EXECUTION_FAILED_CAUSE_",
                        )
                    })
                    .unwrap_or_default();
                outcome(
                    &mut scan,
                    &sent_at,
                    a.initiated_event_id,
                    format!("Failed: {cause}"),
                );
            }
            A::RequestCancelExternalWorkflowExecutionFailedEventAttributes(a) => {
                let cause = CancelExternalWorkflowExecutionFailedCause::try_from(a.cause)
                    .map(|c| {
                        enum_word(
                            c.as_str_name(),
                            "CANCEL_EXTERNAL_WORKFLOW_EXECUTION_FAILED_CAUSE_",
                        )
                    })
                    .unwrap_or_default();
                outcome(
                    &mut scan,
                    &sent_at,
                    a.initiated_event_id,
                    format!("Failed: {cause}"),
                );
            }
            _ => {}
        }
    }
    scan
}

fn close_child(
    scan: &mut HistoryScan,
    child_at: &HashMap<i64, usize>,
    started: &HashMap<i64, prost_types::Timestamp>,
    initiated: i64,
    time: Option<&prost_types::Timestamp>,
    status: WorkflowStatus,
    failure: Option<String>,
) {
    let Some(child) = child_at
        .get(&initiated)
        .and_then(|i| scan.children.get_mut(*i))
    else {
        return;
    };
    child.status = status;
    child.close_time = time.and_then(rfc3339);
    child.failure = failure.filter(|f| !f.is_empty());
    if let (Some(start), Some(end)) = (started.get(&initiated), time) {
        scan.child_durations
            .insert(child.workflow_id.clone(), ms_between(start, end));
    }
}

fn outcome(scan: &mut HistoryScan, sent_at: &HashMap<i64, usize>, initiated: i64, text: String) {
    if let Some(signal) = sent_at
        .get(&initiated)
        .and_then(|i| scan.signals.get_mut(*i))
    {
        signal.outcome = Some(text);
    }
}

fn node_of(row: &WorkflowRow) -> RelationNode {
    RelationNode {
        workflow_id: row.workflow_id.clone(),
        run_id: row.run_id.clone(),
        workflow_type: row.workflow_type.clone(),
        status: row.status,
        start_time: row.start_time.clone(),
        close_time: row.close_time.clone(),
        duration_ms: row.duration_ms,
        parent_workflow_id: row.parent_workflow_id.clone(),
        level: None,
        failure: None,
        missing: false,
        current: false,
    }
}

fn missing_node(workflow_id: &str, run_id: &str) -> RelationNode {
    RelationNode {
        workflow_id: workflow_id.to_owned(),
        run_id: run_id.to_owned(),
        workflow_type: String::new(),
        status: WorkflowStatus::Unspecified,
        start_time: None,
        close_time: None,
        duration_ms: None,
        parent_workflow_id: None,
        level: None,
        failure: None,
        missing: true,
        current: false,
    }
}

fn child_node(
    child: &RelationChild,
    parent: &str,
    durations: &HashMap<String, i64>,
) -> RelationNode {
    RelationNode {
        workflow_id: child.workflow_id.clone(),
        run_id: child.run_id.clone().unwrap_or_default(),
        workflow_type: child.workflow_type.clone(),
        status: child.status,
        start_time: child.start_time.clone(),
        close_time: child.close_time.clone(),
        duration_ms: durations.get(&child.workflow_id).copied(),
        parent_workflow_id: Some(parent.to_owned()),
        level: None,
        failure: child.failure.clone(),
        missing: false,
        current: false,
    }
}

/// The family's executions, one per workflow ID: its latest run by start time.
pub fn latest_runs(infos: &[WorkflowExecutionInfo]) -> Vec<WorkflowRow> {
    let mut latest: BTreeMap<String, &WorkflowExecutionInfo> = BTreeMap::new();
    let start = |i: &WorkflowExecutionInfo| {
        i.start_time
            .as_ref()
            .map(|t| (t.seconds, t.nanos))
            .unwrap_or_default()
    };
    for info in infos {
        let Some(id) = info.execution.as_ref().map(|e| e.workflow_id.clone()) else {
            continue;
        };
        match latest.get(&id) {
            Some(seen) if start(seen) >= start(info) => {}
            _ => {
                latest.insert(id, info);
            }
        }
    }
    let mut rows: Vec<WorkflowRow> = latest.values().map(|i| row(i)).collect();
    rows.sort_by(|a, b| {
        a.start_time
            .cmp(&b.start_time)
            .then(a.workflow_id.cmp(&b.workflow_id))
    });
    rows
}

/// The family laid out by levels from the root: whole levels while they fit in `limit` boxes,
/// then the path from the root to `current`. Returns the drawn nodes (with `level`), the number of
/// levels drawn and how many of `nodes` were left out.
pub fn layout_family(
    nodes: Vec<RelationNode>,
    root: &str,
    current: &str,
    limit: usize,
) -> (Vec<RelationNode>, u32, u32) {
    let total = nodes.len();
    let by_id: HashMap<String, RelationNode> = nodes
        .into_iter()
        .map(|n| (n.workflow_id.clone(), n))
        .collect();
    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for n in by_id.values() {
        if let Some(parent) = n.parent_workflow_id.as_deref()
            && n.workflow_id != root
        {
            children.entry(parent).or_default().push(&n.workflow_id);
        }
    }
    for list in children.values_mut() {
        list.sort_by_key(|id| (by_id[*id].start_time.clone(), id.to_string()));
    }
    // Breadth first from the root: depth by workflow ID.
    let mut depth: HashMap<String, u32> = HashMap::new();
    let mut levels: Vec<Vec<String>> = Vec::new();
    if by_id.contains_key(root) {
        let mut frontier = vec![root.to_owned()];
        depth.insert(root.to_owned(), 0);
        while !frontier.is_empty() {
            let mut next = Vec::new();
            for id in &frontier {
                for child in children.get(id.as_str()).into_iter().flatten() {
                    if !depth.contains_key(*child) {
                        depth.insert((*child).to_owned(), levels.len() as u32 + 1);
                        next.push((*child).to_owned());
                    }
                }
            }
            levels.push(std::mem::take(&mut frontier));
            frontier = next;
        }
    }
    let mut keep: Vec<String> = Vec::new();
    let mut drawn_levels = 0;
    for level in &levels {
        if keep.len() + level.len() > limit {
            break;
        }
        keep.extend(level.iter().cloned());
        drawn_levels += 1;
    }
    // The path from the root to the current workflow is always drawn.
    let kept: HashSet<String> = keep.iter().cloned().collect();
    let mut path = Vec::new();
    let mut at = Some(current.to_owned());
    while let Some(id) = at {
        if !depth.contains_key(&id) || path.contains(&id) {
            break;
        }
        at = by_id
            .get(&id)
            .and_then(|n| n.parent_workflow_id.clone())
            .filter(|_| id != root);
        path.push(id);
    }
    for id in path.into_iter().rev() {
        if !kept.contains(&id) {
            drawn_levels = drawn_levels.max(depth[&id] + 1);
            keep.push(id);
        }
    }
    let drawn: Vec<RelationNode> = keep
        .iter()
        .filter_map(|id| {
            let mut n = by_id.get(id)?.clone();
            n.level = depth.get(id).copied();
            Some(n)
        })
        .collect();
    let not_drawn = (total - drawn.len()) as u32;
    (drawn, drawn_levels, not_drawn)
}

/// The arrows between the drawn boxes: parent to child, and this run's signals and cancels.
pub fn edges_of(
    nodes: &[RelationNode],
    current: &str,
    signals: &[RelationSignal],
) -> Vec<RelationEdge> {
    let present: HashSet<&str> = nodes.iter().map(|n| n.workflow_id.as_str()).collect();
    let mut edges = Vec::new();
    for n in nodes {
        if n.level.is_none() {
            continue;
        }
        if let Some(parent) = n.parent_workflow_id.as_deref()
            && present.contains(parent)
            && parent != n.workflow_id
        {
            edges.push(RelationEdge {
                from: parent.to_owned(),
                to: n.workflow_id.clone(),
                kind: RelationEdgeKind::Child,
                label: None,
                event_id: None,
            });
        }
    }
    let mut seen = HashSet::new();
    for s in signals {
        if !present.contains(s.workflow_id.as_str()) || s.workflow_id == current {
            continue;
        }
        let (from, to) = match s.direction {
            SignalDirection::Received => (s.workflow_id.clone(), current.to_owned()),
            SignalDirection::Sent => (current.to_owned(), s.workflow_id.clone()),
        };
        let label = s
            .signal_name
            .clone()
            .or_else(|| (s.kind == RelationEdgeKind::Cancel).then(|| "cancel".to_owned()));
        if seen.insert((from.clone(), to.clone(), s.kind, label.clone())) {
            edges.push(RelationEdge {
                from,
                to,
                kind: s.kind,
                label,
                event_id: Some(s.event_id),
            });
        }
    }
    edges
}

async fn describe_raw(
    client: &TemporalClient,
    namespace: &str,
    workflow_id: &str,
    run_id: Option<&str>,
) -> Result<ws::DescribeWorkflowExecutionResponse, ToolError> {
    Ok(client
        .service()
        .describe_workflow_execution(client.request(
            namespace,
            ws::DescribeWorkflowExecutionRequest {
                namespace: namespace.to_owned(),
                execution: Some(execution(workflow_id, run_id)?),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner())
}

async fn all_events(
    client: &TemporalClient,
    namespace: &str,
    workflow_id: &str,
    run_id: &str,
) -> Result<Vec<HistoryEvent>, ToolError> {
    let mut events = Vec::new();
    let mut token = Vec::new();
    for _ in 0..MAX_HISTORY_PAGES {
        let response = client
            .service()
            .get_workflow_execution_history(client.request(
                namespace,
                ws::GetWorkflowExecutionHistoryRequest {
                    namespace: namespace.to_owned(),
                    execution: Some(execution(workflow_id, Some(run_id))?),
                    maximum_page_size: 1_000,
                    next_page_token: token,
                    ..Default::default()
                },
            ))
            .await
            .map_err(|s| status_error(&client.address, &s))?
            .into_inner();
        events.extend(response.history.unwrap_or_default().events);
        token = response.next_page_token;
        if token.is_empty() {
            break;
        }
    }
    Ok(events)
}

async fn count(client: &TemporalClient, namespace: &str, query: &str) -> Result<i64, ToolError> {
    Ok(client
        .service()
        .count_workflow_executions(client.request(
            namespace,
            ws::CountWorkflowExecutionsRequest {
                namespace: namespace.to_owned(),
                query: query.to_owned(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner()
        .count)
}

/// `temporal.workflows.relations`.
pub async fn relations(
    client: &TemporalClient,
    input: WorkflowRelationsInput,
) -> Result<WorkflowRelations, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let ns = namespace.as_str();
    let described = describe_raw(client, ns, &input.workflow_id, input.run_id.as_deref()).await?;
    let info = described
        .workflow_execution_info
        .clone()
        .unwrap_or_default();
    let workflow = row(&info);
    let current = workflow.workflow_id.clone();
    let events = all_events(client, ns, &current, &workflow.run_id).await?;
    let scan = scan_history(&events, &workflow.run_id);
    let mut runs = scan.runs.clone();
    runs.reset_to = described
        .workflow_extended_info
        .as_ref()
        .and_then(|x| non_empty(&x.reset_run_id))
        .filter(|r| *r != workflow.run_id);

    // The parent, and what its close does to this child.
    let parent_execution = some_id(info.parent_execution.as_ref()).cloned();
    let mut parent = None;
    let mut parent_node = None;
    if let Some(p) = &parent_execution {
        let mut policy = None;
        let node = match describe_raw(client, ns, &p.workflow_id, Some(&p.run_id)).await {
            Ok(d) => {
                policy = d
                    .pending_children
                    .iter()
                    .find(|c| c.workflow_id == current)
                    .and_then(|c| ParentClosePolicy::try_from(c.parent_close_policy).ok())
                    .filter(|p| *p != ParentClosePolicy::Unspecified)
                    .map(|p| enum_word(p.as_str_name(), "PARENT_CLOSE_POLICY_"));
                node_of(&row(&d.workflow_execution_info.unwrap_or_default()))
            }
            Err(e) if e.kind == ToolErrorKind::NotFound => missing_node(&p.workflow_id, &p.run_id),
            Err(e) => return Err(e),
        };
        parent = Some(RelationParent {
            workflow_id: p.workflow_id.clone(),
            run_id: p.run_id.clone(),
            parent_close_policy: policy,
        });
        parent_node = Some(node);
    }

    // What the server can list: the family by its root, the children by their parent.
    let root_id = some_id(info.root_execution.as_ref())
        .map(|r| r.workflow_id.clone())
        .or_else(|| parent_execution.is_none().then(|| current.clone()));
    let family_query = root_id
        .as_ref()
        .map(|r| format!("RootWorkflowId = {}", quote(r)));
    let direct_query = format!("ParentWorkflowId = {}", quote(&current));
    let (family_count, direct_count) = tokio::join!(
        async {
            match &family_query {
                Some(q) => count(client, ns, q).await,
                None => Err(ToolError::new(
                    ToolErrorKind::Invalid,
                    TOOL,
                    "the server does not report the root workflow (Temporal Server 1.24 or newer does)",
                )),
            }
        },
        count(client, ns, &direct_query),
    );
    let (supported, reason, total) = match family_count {
        Ok(n) => (true, None, Some(n)),
        Err(e) => (false, Some(e.message), None),
    };
    let scope = match input.scope.unwrap_or_default() {
        RelationScope::Family if supported => RelationScope::Family,
        _ => RelationScope::Direct,
    };

    let mut current_node = node_of(&workflow);
    current_node.current = true;
    let failures: HashMap<&str, &RelationChild> = scan
        .children
        .iter()
        .map(|c| (c.workflow_id.as_str(), c))
        .collect();
    let (mut nodes, levels, not_drawn) = match scope {
        RelationScope::Family => {
            let root = root_id.clone().unwrap_or_else(|| current.clone());
            let response = client
                .service()
                .list_workflow_executions(client.request(
                    ns,
                    ws::ListWorkflowExecutionsRequest {
                        namespace: namespace.clone(),
                        page_size: FAMILY_PAGE,
                        next_page_token: Vec::new(),
                        query: family_query.clone().unwrap_or_default(),
                    },
                ))
                .await
                .map_err(|s| status_error(&client.address, &s))?
                .into_inner();
            let fetched = response.executions.len() as i64;
            let mut family: Vec<RelationNode> = latest_runs(&response.executions)
                .iter()
                .map(|r| {
                    if r.workflow_id == current {
                        current_node.clone()
                    } else {
                        let mut n = node_of(r);
                        if let Some(c) = failures.get(r.workflow_id.as_str()) {
                            n.failure = c.failure.clone();
                        }
                        n
                    }
                })
                .collect();
            // The visibility store may lag behind the history: this run and its parent stay in.
            if !family.iter().any(|n| n.current) {
                family.push(current_node.clone());
            }
            if let Some(p) = &parent_node
                && !family.iter().any(|n| n.workflow_id == p.workflow_id)
            {
                family.push(p.clone());
            }
            let (drawn, levels, not_drawn) = layout_family(family, &root, &current, MAX_DRAWN);
            let unlisted = total.map_or(0, |t| (t - fetched).max(0)) as u32;
            (drawn, levels, not_drawn + unlisted)
        }
        RelationScope::Direct => {
            let mut direct = Vec::new();
            let top = u32::from(parent_node.is_some());
            if let Some(mut p) = parent_node.clone() {
                p.level = Some(0);
                direct.push(p);
            }
            current_node.level = Some(top);
            direct.push(current_node.clone());
            let mut seen = HashSet::new();
            for child in scan.children.iter().rev() {
                // A child ID started again: its latest start.
                if seen.insert(child.workflow_id.clone()) {
                    let mut n = child_node(child, &current, &scan.child_durations);
                    n.level = Some(top + 1);
                    direct.push(n);
                }
            }
            let levels = top + 1 + u32::from(!scan.children.is_empty());
            (direct, levels, 0)
        }
    };
    let drawn = nodes.len() as u32;

    // The other ends of signals and cancels outside the tree.
    let known: HashSet<String> = nodes.iter().map(|n| n.workflow_id.clone()).collect();
    let mut peers: Vec<(String, Option<String>)> = Vec::new();
    for s in &scan.signals {
        if !known.contains(&s.workflow_id) && !peers.iter().any(|(id, _)| *id == s.workflow_id) {
            peers.push((s.workflow_id.clone(), s.run_id.clone()));
        }
    }
    peers.truncate(MAX_PEERS);
    let described_peers: Vec<RelationNode> = stream::iter(peers)
        .map(|(id, run)| {
            let ns = namespace.clone();
            async move {
                match describe_raw(client, &ns, &id, None).await {
                    Ok(d) => node_of(&row(&d.workflow_execution_info.unwrap_or_default())),
                    Err(_) => missing_node(&id, run.as_deref().unwrap_or_default()),
                }
            }
        })
        .buffered(PARALLEL)
        .collect()
        .await;
    nodes.extend(described_peers.into_iter().map(|mut n| {
        n.level = None;
        n
    }));

    let edges = edges_of(&nodes, &current, &scan.signals);
    Ok(WorkflowRelations {
        workflow,
        root_workflow_id: root_id,
        nodes,
        edges,
        parent,
        children: scan.children,
        signals: scan.signals,
        runs,
        family: RelationFamily {
            scope,
            supported,
            reason,
            query: match scope {
                RelationScope::Family => family_query,
                RelationScope::Direct => direct_count.ok().map(|_| direct_query),
            },
            total,
            drawn,
            levels,
            not_drawn,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::super::proto::temporal::api::common::v1::WorkflowType;
    use super::super::proto::temporal::api::failure::v1::Failure;
    use super::super::proto::temporal::api::history::v1 as h;
    use super::*;

    fn at(seconds: i64) -> Option<prost_types::Timestamp> {
        Some(prost_types::Timestamp {
            seconds: 1_794_000_000 + seconds,
            nanos: 0,
        })
    }

    fn ev(event_id: i64, seconds: i64, attributes: A) -> HistoryEvent {
        HistoryEvent {
            event_id,
            event_time: at(seconds),
            attributes: Some(attributes),
            ..Default::default()
        }
    }

    fn wf(id: &str, run: &str) -> Option<WorkflowExecution> {
        Some(WorkflowExecution {
            workflow_id: id.into(),
            run_id: run.into(),
        })
    }

    fn initiated(id: &str, ty: &str) -> A {
        A::StartChildWorkflowExecutionInitiatedEventAttributes(
            h::StartChildWorkflowExecutionInitiatedEventAttributes {
                workflow_id: id.into(),
                workflow_type: Some(WorkflowType { name: ty.into() }),
                ..Default::default()
            },
        )
    }

    fn started(initiated_event_id: i64, id: &str) -> A {
        A::ChildWorkflowExecutionStartedEventAttributes(
            h::ChildWorkflowExecutionStartedEventAttributes {
                initiated_event_id,
                workflow_execution: wf(id, &format!("run-{id}")),
                ..Default::default()
            },
        )
    }

    #[test]
    fn children_signals_and_runs_come_from_the_history() {
        let events = vec![
            ev(
                1,
                0,
                A::WorkflowExecutionStartedEventAttributes(
                    h::WorkflowExecutionStartedEventAttributes {
                        continued_execution_run_id: "run-0".into(),
                        initiator: ContinueAsNewInitiator::Retry as i32,
                        first_execution_run_id: "run-0".into(),
                        ..Default::default()
                    },
                ),
            ),
            ev(5, 1, initiated("fraud", "FraudCheck")),
            ev(6, 1, initiated("payment", "PaymentWorkflow")),
            ev(7, 1, initiated("receipt", "ReceiptWorkflow")),
            ev(8, 2, started(5, "fraud")),
            ev(9, 2, started(6, "payment")),
            ev(10, 2, started(7, "receipt")),
            ev(
                11,
                3,
                A::ChildWorkflowExecutionCompletedEventAttributes(
                    h::ChildWorkflowExecutionCompletedEventAttributes {
                        initiated_event_id: 5,
                        ..Default::default()
                    },
                ),
            ),
            ev(
                12,
                14,
                A::ChildWorkflowExecutionFailedEventAttributes(
                    h::ChildWorkflowExecutionFailedEventAttributes {
                        initiated_event_id: 7,
                        failure: Some(Failure {
                            message: "SmtpUnavailable".into(),
                            ..Default::default()
                        }),
                        ..Default::default()
                    },
                ),
            ),
            ev(
                13,
                15,
                A::WorkflowExecutionSignaledEventAttributes(
                    h::WorkflowExecutionSignaledEventAttributes {
                        signal_name: "customerConfirmed".into(),
                        external_workflow_execution: wf("support", "run-s"),
                        ..Default::default()
                    },
                ),
            ),
            // A signal from a client, not a workflow: not a relation.
            ev(
                14,
                15,
                A::WorkflowExecutionSignaledEventAttributes(
                    h::WorkflowExecutionSignaledEventAttributes {
                        signal_name: "nudge".into(),
                        ..Default::default()
                    },
                ),
            ),
            ev(
                15,
                16,
                A::SignalExternalWorkflowExecutionInitiatedEventAttributes(
                    h::SignalExternalWorkflowExecutionInitiatedEventAttributes {
                        workflow_execution: wf("audit", ""),
                        signal_name: "recorded".into(),
                        ..Default::default()
                    },
                ),
            ),
            ev(
                16,
                17,
                A::SignalExternalWorkflowExecutionFailedEventAttributes(
                    h::SignalExternalWorkflowExecutionFailedEventAttributes {
                        initiated_event_id: 15,
                        cause: SignalExternalWorkflowExecutionFailedCause::ExternalWorkflowExecutionNotFound
                            as i32,
                        ..Default::default()
                    },
                ),
            ),
            ev(
                17,
                18,
                A::WorkflowExecutionContinuedAsNewEventAttributes(
                    h::WorkflowExecutionContinuedAsNewEventAttributes {
                        new_execution_run_id: "run-2".into(),
                        initiator: ContinueAsNewInitiator::Workflow as i32,
                        ..Default::default()
                    },
                ),
            ),
        ];
        let scan = scan_history(&events, "run-1");
        let statuses: Vec<_> = scan
            .children
            .iter()
            .map(|c| (c.workflow_id.as_str(), c.status, c.failure.as_deref()))
            .collect();
        assert_eq!(
            statuses,
            vec![
                ("fraud", WorkflowStatus::Completed, None),
                ("payment", WorkflowStatus::Running, None),
                ("receipt", WorkflowStatus::Failed, Some("SmtpUnavailable")),
            ]
        );
        assert_eq!(scan.children[1].run_id.as_deref(), Some("run-payment"));
        assert_eq!(scan.child_durations.get("fraud"), Some(&1_000));
        assert_eq!(scan.child_durations.get("receipt"), Some(&12_000));
        assert_eq!(scan.signals.len(), 2);
        assert_eq!(scan.signals[0].direction, SignalDirection::Received);
        assert_eq!(scan.signals[0].workflow_id, "support");
        assert_eq!(
            scan.signals[0].signal_name.as_deref(),
            Some("customerConfirmed")
        );
        assert_eq!(scan.signals[1].direction, SignalDirection::Sent);
        assert_eq!(
            scan.signals[1].outcome.as_deref(),
            Some("Failed: ExternalWorkflowExecutionNotFound")
        );
        assert_eq!(
            scan.runs.continued_from,
            Some(RunLink {
                run_id: "run-0".into(),
                initiator: Some("Retry".into())
            })
        );
        assert_eq!(scan.runs.first_run_id.as_deref(), Some("run-0"));
        assert_eq!(
            scan.runs.continued_as,
            Some(RunLink {
                run_id: "run-2".into(),
                initiator: Some("Workflow".into())
            })
        );
    }

    #[test]
    fn a_reset_run_names_its_base() {
        let events = vec![ev(
            4,
            0,
            A::WorkflowTaskFailedEventAttributes(h::WorkflowTaskFailedEventAttributes {
                cause: WorkflowTaskFailedCause::ResetWorkflow as i32,
                base_run_id: "run-old".into(),
                new_run_id: "run-new".into(),
                ..Default::default()
            }),
        )];
        assert_eq!(
            scan_history(&events, "run-new").runs.reset_from.as_deref(),
            Some("run-old")
        );
    }

    fn n(id: &str, parent: Option<&str>) -> RelationNode {
        let mut node = missing_node(id, "");
        node.missing = false;
        node.parent_workflow_id = parent.map(str::to_owned);
        node
    }

    #[test]
    fn the_family_is_drawn_by_whole_levels_with_the_path_to_the_current_one() {
        // root → a, b; a → 4 children; b → 5 children; one grandchild of a's first child.
        let mut nodes = vec![n("root", None), n("a", Some("root")), n("b", Some("root"))];
        for i in 0..4 {
            nodes.push(n(&format!("a{i}"), Some("a")));
        }
        for i in 0..5 {
            nodes.push(n(&format!("b{i}"), Some("b")));
        }
        nodes.push(n("deep", Some("a0")));
        nodes.push(n("stray", Some("elsewhere")));
        let (all, levels, left) = layout_family(nodes.clone(), "root", "deep", 200);
        assert_eq!((all.len(), levels, left), (13, 4, 1));
        assert_eq!(
            all.iter().find(|n| n.workflow_id == "deep").unwrap().level,
            Some(3)
        );

        // Room for 5: root and its two children, then the path down to `deep`.
        let (some, levels, left) = layout_family(nodes, "root", "deep", 5);
        let ids: Vec<_> = some.iter().map(|n| n.workflow_id.as_str()).collect();
        assert_eq!(ids, vec!["root", "a", "b", "a0", "deep"]);
        assert_eq!((levels, left), (4, 9));
    }

    #[test]
    fn edges_go_parent_to_child_and_along_the_signals() {
        let mut nodes = vec![
            n("root", None),
            n("cur", Some("root")),
            n("kid", Some("cur")),
        ];
        for (i, node) in nodes.iter_mut().enumerate() {
            node.level = Some(i as u32);
        }
        nodes.push(n("support", None));
        let signal = |direction, id: &str, name: Option<&str>, event_id| RelationSignal {
            direction,
            kind: RelationEdgeKind::Signal,
            workflow_id: id.into(),
            run_id: None,
            signal_name: name.map(str::to_owned),
            event_id,
            time: None,
            outcome: None,
        };
        let signals = vec![
            signal(
                SignalDirection::Received,
                "support",
                Some("customerConfirmed"),
                13,
            ),
            signal(
                SignalDirection::Received,
                "support",
                Some("customerConfirmed"),
                20,
            ),
            signal(SignalDirection::Sent, "nowhere", Some("x"), 21),
        ];
        let edges = edges_of(&nodes, "cur", &signals);
        let pairs: Vec<_> = edges
            .iter()
            .map(|e| (e.from.as_str(), e.to.as_str(), e.kind, e.event_id))
            .collect();
        assert_eq!(
            pairs,
            vec![
                ("root", "cur", RelationEdgeKind::Child, None),
                ("cur", "kid", RelationEdgeKind::Child, None),
                ("support", "cur", RelationEdgeKind::Signal, Some(13)),
            ]
        );
    }

    #[test]
    fn query_values_are_quoted_as_the_query_bar_does() {
        assert_eq!(quote("order-1"), "\"order-1\"");
        assert_eq!(quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    #[test]
    fn enum_names_read_as_words() {
        assert_eq!(
            enum_word("PARENT_CLOSE_POLICY_REQUEST_CANCEL", "PARENT_CLOSE_POLICY_"),
            "RequestCancel"
        );
        assert_eq!(
            initiator(ContinueAsNewInitiator::CronSchedule as i32).as_deref(),
            Some("CronSchedule")
        );
        assert_eq!(initiator(0), None);
    }
}
