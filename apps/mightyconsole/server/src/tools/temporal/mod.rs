//! `temporal`: the Temporal Web UI's replacement over Temporal's gRPC API (Mightyconsole spec §9,
//! TSK-83). The protos of `temporalio/api` are vendored in `proto/temporal/` (see its README) and
//! compiled by `build.rs`; this module is their client, behind the tool contract of
//! [`crate::tools`].
//!
//! TSK-83 built the workflows, their detail and actions, schedules and task queues; TSK-92 adds
//! namespaces in full and the workers.

mod actions;
mod actions_types;
mod client;
pub mod codec;
mod detail;
mod detail_types;
mod extstore;
mod namespaces;
mod payloads;
mod proto;
mod relations;
mod relations_types;
mod s3;
mod schedule_form;
mod search_attributes;
mod start;
mod types;
mod workers;

use std::sync::Arc;

use ambidex::{BinarySink, Code, Ctx, RpcError, rpc};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use self::client::{TemporalClient, status_error};
use self::proto::temporal::api::workflowservice::v1 as ws;
use crate::core::{Empty, Handle, Hub, ToolError, ToolResult};

pub use self::actions_types::*;
pub use self::detail_types::*;
pub use self::namespaces::{Archival, NamespaceDescribeInput, NamespaceDetail, NamespaceLimits};
pub use self::relations_types::*;
pub use self::schedule_form::{
    CalendarForm, IntervalForm, ScheduleActionForm, ScheduleForm, SchedulePoliciesForm,
    ScheduleSpecForm, ScheduleStateForm, ScheduleWriteInput,
};
pub use self::search_attributes::{
    SearchAttribute, SearchAttributeType, SearchAttributesInput, SearchAttributesOutput,
};
pub use self::start::{
    IdConflictPolicy, IdReusePolicy, RetryPolicyForm, WorkflowStartInput, WorkflowStartOutput,
};
pub use self::types::*;
pub use self::workers::{
    SeenTaskQueue, TaskQueueSource, WorkerRow, WorkersListInput, WorkersListOutput,
};

/// The tool's id and namespace.
pub const TOOL: &str = "temporal";

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAX_PAGE_SIZE: u32 = 1_000;

/// `temporal.connect` and `temporal.disconnect`.
pub struct TemporalApi(pub Arc<Hub>);
/// `temporal.namespaces.*`.
pub struct TemporalNamespacesApi(pub Arc<Hub>);
/// `temporal.workflows.*`.
pub struct TemporalWorkflowsApi(pub Arc<Hub>);
/// `temporal.schedules.*`.
pub struct TemporalSchedulesApi(pub Arc<Hub>);
/// `temporal.taskQueues.*`.
pub struct TemporalTaskQueuesApi(pub Arc<Hub>);
/// `temporal.workers.*`.
pub struct TemporalWorkersApi(pub Arc<Hub>);

/// RFC 3339 in UTC, `None` for an unset or out-of-range timestamp.
fn rfc3339(timestamp: &prost_types::Timestamp) -> Option<String> {
    let nanos = i128::from(timestamp.seconds) * 1_000_000_000 + i128::from(timestamp.nanos);
    OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

fn millis(duration: &prost_types::Duration) -> i64 {
    duration.seconds.saturating_mul(1_000) + i64::from(duration.nanos / 1_000_000)
}

pub(super) fn namespace_state(state: i32) -> &'static str {
    match state {
        1 => "Registered",
        2 => "Deprecated",
        3 => "Deleted",
        _ => "Unspecified",
    }
}

fn row(info: &proto::temporal::api::workflow::v1::WorkflowExecutionInfo) -> WorkflowRow {
    let execution = info.execution.clone().unwrap_or_default();
    WorkflowRow {
        workflow_id: execution.workflow_id,
        run_id: execution.run_id,
        workflow_type: info
            .r#type
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_default(),
        status: WorkflowStatus::from_proto(info.status),
        start_time: info.start_time.as_ref().and_then(rfc3339),
        close_time: info.close_time.as_ref().and_then(rfc3339),
        duration_ms: info.execution_duration.as_ref().map(millis),
        task_queue: info.task_queue.clone(),
        history_length: info.history_length,
        parent_workflow_id: info
            .parent_execution
            .as_ref()
            .map(|p| p.workflow_id.clone())
            .filter(|id| !id.is_empty()),
    }
}

/// The token of a page as the UI holds it; the empty token is "no more pages".
fn encode_token(token: &[u8]) -> Option<String> {
    (!token.is_empty()).then(|| BASE64.encode(token))
}

fn decode_token(token: Option<&str>) -> Result<Vec<u8>, ToolError> {
    match token.filter(|t| !t.is_empty()) {
        None => Ok(Vec::new()),
        Some(t) => BASE64.decode(t).map_err(|_| {
            ToolError::invalid(TOOL, "nextPageToken", "not a page token of this tool")
        }),
    }
}

/// The live client of `conn_id` in this session.
fn client_of(hub: &Hub, ctx: &Ctx, conn_id: &str) -> ToolResult<Arc<Handle<TemporalClient>>> {
    Ok(Arc::new(hub.get::<TemporalClient>(
        &ctx.session().id,
        TOOL,
        conn_id,
    )?))
}

/// What the server says about itself when a profile connects.
struct ServerInfo {
    server_version: String,
    cluster_name: Option<String>,
    capabilities: TemporalCapabilities,
}

/// Asks the server who it is (`GetSystemInfo`, and `GetClusterInfo` when it answers).
async fn server_info(client: &TemporalClient) -> Result<ServerInfo, ToolError> {
    let namespace = client.namespace.clone();
    let mut service = client.service();
    let info = service
        .get_system_info(client.request(&namespace, ws::GetSystemInfoRequest {}))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    // Best effort: a cluster that withholds this (Temporal Cloud) still connects.
    let cluster = service
        .get_cluster_info(client.request(&namespace, ws::GetClusterInfoRequest {}))
        .await
        .ok()
        .map(tonic::Response::into_inner);
    Ok(ServerInfo {
        server_version: info.server_version,
        capabilities: TemporalCapabilities {
            signal_and_query_header: info
                .capabilities
                .as_ref()
                .is_some_and(|c| c.signal_and_query_header),
            visibility_store: cluster
                .as_ref()
                .map(|c| c.visibility_store.clone())
                .unwrap_or_default(),
        },
        cluster_name: cluster
            .map(|c| c.cluster_name)
            .filter(|name| !name.is_empty()),
    })
}

/// Every namespace of the cluster, by name (`ListNamespaces`, all pages).
async fn list_namespaces(client: &TemporalClient) -> Result<Vec<NamespaceSummary>, ToolError> {
    let mut service = client.service();
    let mut namespaces = Vec::new();
    let mut token = Vec::new();
    loop {
        let page = service
            .list_namespaces(client.request(
                &client.namespace,
                ws::ListNamespacesRequest {
                    page_size: 100,
                    next_page_token: token,
                    namespace_filter: None,
                },
            ))
            .await
            .map_err(|s| status_error(&client.address, &s))?
            .into_inner();
        for described in page.namespaces {
            let info = described.namespace_info.unwrap_or_default();
            namespaces.push(NamespaceSummary {
                is_default: info.name == client.namespace,
                name: info.name,
                state: namespace_state(info.state).into(),
                retention_secs: described
                    .config
                    .and_then(|c| c.workflow_execution_retention_ttl)
                    .map(|d| d.seconds),
                description: info.description,
                owner_email: info.owner_email,
                is_global: described.is_global_namespace,
            });
        }
        token = page.next_page_token;
        if token.is_empty() {
            break;
        }
    }
    namespaces.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(namespaces)
}

/// One page of workflows matching a visibility query (`ListWorkflowExecutions`).
async fn list_workflows(
    client: &TemporalClient,
    input: WorkflowsListInput,
) -> Result<WorkflowsListOutput, ToolError> {
    let page_size = input.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    if !(1..=MAX_PAGE_SIZE).contains(&page_size) {
        return Err(ToolError::invalid(TOOL, "pageSize", "1 to 1000"));
    }
    let next_page_token = decode_token(input.next_page_token.as_deref())?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .list_workflow_executions(client.request(
            &namespace,
            ws::ListWorkflowExecutionsRequest {
                namespace: namespace.clone(),
                page_size: page_size as i32,
                next_page_token,
                query: input.query.unwrap_or_default().trim().to_owned(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    Ok(WorkflowsListOutput {
        executions: response.executions.iter().map(row).collect(),
        next_page_token: encode_token(&response.next_page_token),
    })
}

/// How many workflows a visibility query matches (`CountWorkflowExecutions`).
async fn count_workflows(
    client: &TemporalClient,
    input: WorkflowsCountInput,
) -> Result<WorkflowsCountOutput, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .count_workflow_executions(client.request(
            &namespace,
            ws::CountWorkflowExecutionsRequest {
                namespace: namespace.clone(),
                query: input.query.unwrap_or_default().trim().to_owned(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    Ok(WorkflowsCountOutput {
        count: response.count,
    })
}

#[rpc::router(namespace = "temporal")]
impl TemporalApi {
    /// Opens the connection from the profile and asks the server who it is.
    #[rpc::mutation(
        perm = "temporal.read",
        risk = Risk::Read,
        redact = ["profile.clientKeyPem", "profile.apiKey", "profile.s3AccessKeyId", "profile.s3SecretAccessKey", "profile.s3SessionToken"]
    )]
    async fn connect(
        &self,
        ctx: Ctx,
        input: TemporalConnectInput,
    ) -> ToolResult<TemporalConnectOutput> {
        let client = Arc::new(client::connect(&input.profile).await?);
        let info = server_info(&client).await?;
        // The codec endpoint serves the profile while this connection lives (TSK-103).
        if client.codec.is_some()
            && let Some(id) = input
                .profile
                .profile_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
        {
            codec::register(id, &client);
        }
        let handle = self.0.insert(&ctx.session().id, TOOL, client);
        Ok(TemporalConnectOutput {
            conn_id: handle.conn_id,
            server_version: info.server_version,
            cluster_name: info.cluster_name,
            capabilities: info.capabilities,
        })
    }

    /// The server's version and cluster name, asked again for a connected profile (the Namespaces
    /// view shows them).
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: TemporalConnIdInput) -> ToolResult<TemporalInfoOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        let info = server_info(&handle.value).await?;
        Ok(TemporalInfoOutput {
            server_version: info.server_version,
            cluster_name: info.cluster_name,
        })
    }

    /// Releases the connection and ends its streams; idempotent.
    #[rpc::mutation(perm = "temporal.read", risk = Risk::Read)]
    async fn disconnect(&self, ctx: Ctx, input: TemporalConnIdInput) -> ToolResult<Empty> {
        self.0.remove(&ctx.session().id, TOOL, &input.conn_id);
        Ok(Empty {})
    }
}

#[rpc::router(namespace = "temporal.namespaces")]
impl TemporalNamespacesApi {
    /// The cluster's namespaces, every page.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn list(
        &self,
        ctx: Ctx,
        input: TemporalConnIdInput,
    ) -> ToolResult<Vec<NamespaceSummary>> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(list_namespaces(&handle.value).await?)
    }

    /// The search attributes a visibility query can name in a namespace, with their types (the
    /// built-in ones, and why, when the server does not list them).
    #[rpc::query(name = "searchAttributes", perm = "temporal.read", risk = Risk::Read)]
    async fn search_attributes(
        &self,
        ctx: Ctx,
        input: SearchAttributesInput,
    ) -> ToolResult<SearchAttributesOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(search_attributes::search_attributes(&handle.value, input).await?)
    }

    /// One namespace in full: id, retention, archival, clusters, capabilities and limits.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn describe(
        &self,
        ctx: Ctx,
        input: NamespaceDescribeInput,
    ) -> ToolResult<NamespaceDetail> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(namespaces::describe(&handle.value, input).await?)
    }
}

#[rpc::router(namespace = "temporal.workflows")]
impl TemporalWorkflowsApi {
    /// One page of workflows matching a visibility query.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: WorkflowsListInput) -> ToolResult<WorkflowsListOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(list_workflows(&handle.value, input).await?)
    }

    /// How many workflows a visibility query matches.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn count(
        &self,
        ctx: Ctx,
        input: WorkflowsCountInput,
    ) -> ToolResult<WorkflowsCountOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(count_workflows(&handle.value, input).await?)
    }

    /// A run's config, pending activities and children, memo and search attributes.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn describe(&self, ctx: Ctx, input: WorkflowRef) -> ToolResult<WorkflowDetail> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(detail::describe(&handle.value, input).await?)
    }

    /// One page of a run's history, oldest first, payloads decoded.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn history(
        &self,
        ctx: Ctx,
        input: WorkflowHistoryInput,
    ) -> ToolResult<WorkflowHistoryOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(detail::history(&handle.value, input).await?)
    }

    /// The run's parent, children, signals and cancels with other workflows, and runs; with
    /// `scope: "family"`, every workflow under its root (TSK-104).
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn relations(
        &self,
        ctx: Ctx,
        input: WorkflowRelationsInput,
    ) -> ToolResult<WorkflowRelations> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(relations::relations(&handle.value, input).await?)
    }

    /// One event with its payloads as stored (the History view's Raw form).
    #[rpc::query(name = "rawEvent", perm = "temporal.read", risk = Risk::Read)]
    async fn raw_event(
        &self,
        ctx: Ctx,
        input: WorkflowRawEventInput,
    ) -> ToolResult<WorkflowRawEventOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(detail::raw_event(&handle.value, input).await?)
    }

    /// Runs a query on the workflow; `__stack_trace` is the stack trace.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn query(&self, ctx: Ctx, input: WorkflowQueryInput) -> ToolResult<WorkflowQueryOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(detail::query(&handle.value, input).await?)
    }

    /// Starts a workflow; JSON arguments, one payload each (TSK-92).
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn start(&self, ctx: Ctx, input: WorkflowStartInput) -> ToolResult<WorkflowStartOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(start::start(&handle.value, input).await?)
    }

    /// Sends a signal with JSON arguments to the run.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn signal(&self, ctx: Ctx, input: WorkflowSignalInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::signal(&handle.value, input).await?;
        Ok(Empty {})
    }

    /// Asks the workflow to cancel itself; it may still finish or refuse.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn cancel(&self, ctx: Ctx, input: WorkflowReasonInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::cancel(&handle.value, input).await?;
        Ok(Empty {})
    }

    /// Ends the run at once, without cleanup; the reason is required.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Destructive)]
    async fn terminate(&self, ctx: Ctx, input: WorkflowReasonInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::terminate(&handle.value, input).await?;
        Ok(Empty {})
    }

    /// Starts a new run from an earlier event of this one; returns the new run id.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Destructive)]
    async fn reset(&self, ctx: Ctx, input: WorkflowResetInput) -> ToolResult<WorkflowResetOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(actions::reset(&handle.value, input).await?)
    }

    /// The events of a run after `fromEventId`, as `jsonl` lines (`HistoryEvent`), until the run
    /// closes. Long-polls the server; the client's credits pace the lines.
    #[rpc::stream(
        name = "followHistory",
        perm = "temporal.read",
        risk = Risk::Read,
        timeout_max = "12h"
    )]
    async fn follow_history(
        &self,
        ctx: Ctx,
        input: FollowHistoryInput,
        sink: BinarySink,
    ) -> ToolResult<FollowHistorySummary> {
        let session = ctx.session().id.clone();
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self
            .0
            .busy::<TemporalClient>(&session, TOOL, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let client = &handle.value;
        let namespace = client.namespace_or_default(input.namespace.as_deref());
        let gone = || RpcError::new(Code::Cancelled, "the connection was closed");
        let mut after = i64::try_from(input.from_event_id).unwrap_or(i64::MAX);
        let mut token = Vec::new();
        loop {
            let execution = detail::execution(&input.workflow_id, Some(&input.run_id))?;
            let step = tokio::select! {
                biased;
                () = handle.token.cancelled() => return Err(gone()),
                step = detail::follow_step(client, &namespace, execution, token, after) => step?,
            };
            for event in step.events {
                tokio::select! {
                    biased;
                    () = handle.token.cancelled() => return Err(gone()),
                    ready = sink.ready() => ready?,
                }
                let mut line = serde_json::to_vec(&event).expect("an event serializes");
                line.push(b'\n');
                progress.scanned(1);
                progress.matched(1, line.len() as u64);
                after = after.max(event.event_id);
                sink.send(line).await?;
            }
            if step.token.is_empty() {
                return Ok(FollowHistorySummary { closed: true });
            }
            token = step.token;
        }
    }
}

#[rpc::router(namespace = "temporal.schedules")]
impl TemporalSchedulesApi {
    /// The schedules of the namespace with their next runs and recent actions.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: SchedulesListInput) -> ToolResult<Vec<ScheduleSummary>> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(actions::schedules_list(&handle.value, input).await?)
    }

    /// One schedule: spec, action, policies, state and info.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn describe(&self, ctx: Ctx, input: ScheduleRef) -> ToolResult<ScheduleDetail> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(actions::schedule_describe(&handle.value, input).await?)
    }

    /// Creates a schedule from the edit sheet's form (TSK-92).
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: ScheduleWriteInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        schedule_form::create(&handle.value, input).await?;
        Ok(Empty {})
    }

    /// Replaces the schedule's spec, action, policies and state with the form's, keeping the rest;
    /// a change since the sheet was filled is a conflict.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn update(&self, ctx: Ctx, input: ScheduleWriteInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        schedule_form::update(&handle.value, input).await?;
        Ok(Empty {})
    }

    /// Pauses the schedule, with a note.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn pause(&self, ctx: Ctx, input: SchedulePatchInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::schedule_patch(&handle.value, input, actions::Patch::Pause).await?;
        Ok(Empty {})
    }

    /// Resumes the schedule, with a note.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn unpause(&self, ctx: Ctx, input: SchedulePatchInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::schedule_patch(&handle.value, input, actions::Patch::Unpause).await?;
        Ok(Empty {})
    }

    /// Runs the schedule's action now, with an overlap policy.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Write)]
    async fn trigger(&self, ctx: Ctx, input: SchedulePatchInput) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::schedule_patch(&handle.value, input, actions::Patch::Trigger).await?;
        Ok(Empty {})
    }

    /// Deletes the schedule; runs it already started go on.
    #[rpc::mutation(perm = "temporal.write", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: ScheduleRef) -> ToolResult<Empty> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        actions::schedule_delete(&handle.value, input).await?;
        Ok(Empty {})
    }
}

#[rpc::router(namespace = "temporal.taskQueues")]
impl TemporalTaskQueuesApi {
    /// The workflow and activity pollers of a task queue, and its backlog when reported.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn describe(
        &self,
        ctx: Ctx,
        input: TaskQueueDescribeInput,
    ) -> ToolResult<TaskQueueDescription> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(actions::task_queue_describe(&handle.value, input).await?)
    }
}

#[rpc::router(namespace = "temporal.workers")]
impl TemporalWorkersApi {
    /// The workers polling the namespace's task queues: those seen in its latest workflows and
    /// schedules and the typed ones, one row per worker and queue.
    #[rpc::query(perm = "temporal.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: WorkersListInput) -> ToolResult<WorkersListOutput> {
        let handle = client_of(&self.0, &ctx, &input.conn_id)?;
        Ok(workers::list(&handle.value, input).await?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timestamps_are_rfc3339_utc() {
        let t = prost_types::Timestamp {
            seconds: 1_794_000_000,
            nanos: 500_000_000,
        };
        assert_eq!(rfc3339(&t).as_deref(), Some("2026-11-06T21:20:00.5Z"));
    }

    #[test]
    fn page_tokens_round_trip_and_empty_means_the_end() {
        assert_eq!(encode_token(&[]), None);
        let token = encode_token(&[1, 2, 3, 255]).unwrap();
        assert_eq!(decode_token(Some(&token)).unwrap(), vec![1, 2, 3, 255]);
        assert!(decode_token(None).unwrap().is_empty());
        assert!(decode_token(Some("not base64!")).is_err());
    }

    #[test]
    fn statuses_follow_the_proto_enum() {
        assert_eq!(WorkflowStatus::from_proto(1), WorkflowStatus::Running);
        assert_eq!(
            WorkflowStatus::from_proto(6),
            WorkflowStatus::ContinuedAsNew
        );
        assert_eq!(WorkflowStatus::from_proto(99), WorkflowStatus::Unspecified);
    }
}

#[cfg(all(test, feature = "lab-tests"))]
mod lab_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_detail_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_action_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_more_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_extstore_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_codec_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_form_tests;

#[cfg(all(test, feature = "lab-tests"))]
mod lab_relations_tests;
