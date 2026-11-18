//! Actions on workflows, schedules and task queues over the gRPC API (spec §9.3, §9.4): signal,
//! request cancellation, terminate, reset; list, describe, pause, unpause, trigger and delete
//! schedules; task queue pollers. Plain functions on a [`TemporalClient`], so the lab tests call
//! them directly and the procedures in `mod.rs` stay thin. Every change names this tool as the
//! identity, so the history shows who asked.

use serde_json::{Map, Value};

use super::actions_types::{
    Poller, ResetReapply, ScheduleAction, ScheduleDetail, ScheduleOverlap, SchedulePatchInput,
    ScheduleRef, ScheduleSummary, SchedulesListInput, TaskQueueDescribeInput, TaskQueueDescription,
    WorkflowReasonInput, WorkflowResetInput, WorkflowResetOutput, WorkflowSignalInput,
};
use super::client::{TemporalClient, status_error};
use super::detail::execution;
use super::payloads::{encode_json, to_json};
use super::proto::temporal::api::common::v1::Payloads;
use super::proto::temporal::api::schedule::v1 as sched;
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::{TOOL, rfc3339};
use crate::core::{ToolError, random_id};

/// Who the history says made the change.
const IDENTITY: &str = "mightyconsole";

fn required(field: &str, value: Option<&str>) -> Result<String, ToolError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        Some(v) => Ok(v.to_owned()),
        None => Err(ToolError::invalid(TOOL, field, "a reason is required")),
    }
}

/// `SignalWorkflowExecution`: a named signal with JSON arguments.
pub async fn signal(client: &TemporalClient, input: WorkflowSignalInput) -> Result<(), ToolError> {
    let name = input.signal_name.trim();
    if name.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "signalName",
            "a signal name is required",
        ));
    }
    let args = input
        .args
        .unwrap_or_default()
        .iter()
        .map(encode_json)
        .collect::<Result<Vec<_>, _>>()?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .signal_workflow_execution(client.request(
            &namespace,
            ws::SignalWorkflowExecutionRequest {
                namespace: namespace.clone(),
                workflow_execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                signal_name: name.to_owned(),
                input: (!args.is_empty()).then_some(Payloads { payloads: args }),
                identity: IDENTITY.into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// `RequestCancelWorkflowExecution`: asks the workflow to cancel itself.
pub async fn cancel(client: &TemporalClient, input: WorkflowReasonInput) -> Result<(), ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .request_cancel_workflow_execution(client.request(
            &namespace,
            ws::RequestCancelWorkflowExecutionRequest {
                namespace: namespace.clone(),
                workflow_execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                identity: IDENTITY.into(),
                request_id: random_id(),
                reason: input.reason.unwrap_or_default().trim().to_owned(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// `TerminateWorkflowExecution`: ends the run at once; the reason is required.
pub async fn terminate(
    client: &TemporalClient,
    input: WorkflowReasonInput,
) -> Result<(), ToolError> {
    let reason = required("reason", input.reason.as_deref())?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .terminate_workflow_execution(client.request(
            &namespace,
            ws::TerminateWorkflowExecutionRequest {
                namespace: namespace.clone(),
                workflow_execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                reason,
                identity: IDENTITY.into(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// `ResetWorkflowExecution`: a new run from `eventId`; returns its run id.
pub async fn reset(
    client: &TemporalClient,
    input: WorkflowResetInput,
) -> Result<WorkflowResetOutput, ToolError> {
    let reason = required("reason", Some(&input.reason))?;
    if input.run_id.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "runId",
            "reset names the run to reset",
        ));
    }
    let event_id = i64::try_from(input.event_id)
        .map_err(|_| ToolError::invalid(TOOL, "eventId", "not an event id"))?;
    if event_id < 1 {
        return Err(ToolError::invalid(
            TOOL,
            "eventId",
            "an event id starts at 1",
        ));
    }
    // `reset_reapply_type` is deprecated: say what to leave out instead (1 signal, 2 update, 3 nexus).
    let exclude: Vec<i32> = match input.reapply {
        ResetReapply::All => vec![],
        ResetReapply::Signals => vec![2, 3],
        ResetReapply::None => vec![1, 2, 3],
    };
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .reset_workflow_execution(client.request(
            &namespace,
            ws::ResetWorkflowExecutionRequest {
                namespace: namespace.clone(),
                workflow_execution: Some(execution(&input.workflow_id, Some(&input.run_id))?),
                reason,
                workflow_task_finish_event_id: event_id,
                request_id: random_id(),
                reset_reapply_exclude_types: exclude,
                identity: IDENTITY.into(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    Ok(WorkflowResetOutput {
        run_id: response.run_id,
    })
}

// --- Schedules --------------------------------------------------------------------------------

fn duration_words(d: &prost_types::Duration) -> String {
    let mut seconds = d.seconds;
    if seconds <= 0 {
        return format!("{} ms", d.nanos / 1_000_000);
    }
    let mut parts = Vec::new();
    for (unit, size) in [
        ("day", 86_400),
        ("hour", 3_600),
        ("minute", 60),
        ("second", 1),
    ] {
        let n = seconds / size;
        seconds %= size;
        if n > 0 {
            parts.push(format!("{n} {unit}{}", if n == 1 { "" } else { "s" }));
        }
    }
    parts.join(" ")
}

/// A schedule's spec in words: intervals, cron strings, calendars.
pub fn spec_in_words(spec: Option<&sched::ScheduleSpec>) -> String {
    let Some(spec) = spec else {
        return String::new();
    };
    let mut parts = Vec::new();
    for interval in &spec.interval {
        if let Some(every) = &interval.interval {
            let mut text = format!("Every {}", duration_words(every));
            if let Some(phase) = interval.phase.as_ref().filter(|p| p.seconds != 0) {
                text.push_str(&format!(" at offset {}", duration_words(phase)));
            }
            parts.push(text);
        }
    }
    parts.extend(spec.cron_string.iter().map(|c| format!("Cron {c}")));
    let calendars = spec.structured_calendar.len() + spec.calendar.len();
    if calendars > 0 {
        parts.push(format!(
            "{calendars} calendar {}",
            if calendars == 1 { "rule" } else { "rules" }
        ));
    }
    parts.join("; ")
}

fn action_of(result: &sched::ScheduleActionResult) -> ScheduleAction {
    let started = result.start_workflow_result.clone().unwrap_or_default();
    ScheduleAction {
        scheduled_time: result.schedule_time.as_ref().and_then(rfc3339),
        actual_time: result.actual_time.as_ref().and_then(rfc3339),
        workflow_id: started.workflow_id,
        run_id: started.run_id,
        status: workflow_status_name(result.start_workflow_status),
    }
}

fn workflow_status_name(status: i32) -> String {
    let name = super::types::WorkflowStatus::from_proto(status);
    match name {
        super::types::WorkflowStatus::Unspecified => String::new(),
        other => format!("{other:?}"),
    }
}

fn summary_of(entry: &sched::ScheduleListEntry) -> ScheduleSummary {
    let info = entry.info.clone().unwrap_or_default();
    ScheduleSummary {
        schedule_id: entry.schedule_id.clone(),
        workflow_type: info
            .workflow_type
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_default(),
        spec: spec_in_words(info.spec.as_ref()),
        paused: info.paused,
        notes: info.notes.clone(),
        next_runs: info
            .future_action_times
            .iter()
            .filter_map(rfc3339)
            .collect(),
        recent_actions: info.recent_actions.iter().map(action_of).collect(),
    }
}

/// Schedules of the namespace, by id (`ListSchedules`, every page up to 1,000).
pub async fn schedules_list(
    client: &TemporalClient,
    input: SchedulesListInput,
) -> Result<Vec<ScheduleSummary>, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let query = input.query.unwrap_or_default().trim().to_owned();
    let mut out = Vec::new();
    let mut token = Vec::new();
    loop {
        let page = client
            .service()
            .list_schedules(client.request(
                &namespace,
                ws::ListSchedulesRequest {
                    namespace: namespace.clone(),
                    maximum_page_size: 100,
                    next_page_token: token,
                    query: query.clone(),
                },
            ))
            .await
            .map_err(|s| status_error(&client.address, &s))?
            .into_inner();
        out.extend(page.schedules.iter().map(summary_of));
        token = page.next_page_token;
        if token.is_empty() || out.len() >= 1000 {
            break;
        }
    }
    out.sort_by(|a, b| a.schedule_id.cmp(&b.schedule_id));
    Ok(out)
}

fn part(json: &mut Map<String, Value>, key: &str) -> Map<String, Value> {
    match json.remove(key) {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// `DescribeSchedule`: spec, action, policies, state and info.
pub async fn schedule_describe(
    client: &TemporalClient,
    input: ScheduleRef,
) -> Result<ScheduleDetail, ToolError> {
    let id = input.schedule_id.trim();
    if id.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "scheduleId",
            "a schedule id is required",
        ));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .describe_schedule(client.request(
            &namespace,
            ws::DescribeScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id.to_owned(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let schedule = response.schedule.clone().unwrap_or_default();
    let info = response.info.clone().unwrap_or_default();
    let workflow_type = match schedule.action.as_ref().and_then(|a| a.action.as_ref()) {
        Some(sched::schedule_action::Action::StartWorkflow(w)) => w
            .workflow_type
            .as_ref()
            .map(|t| t.name.clone())
            .unwrap_or_default(),
        _ => String::new(),
    };
    let summary = ScheduleSummary {
        schedule_id: id.to_owned(),
        workflow_type,
        spec: spec_in_words(schedule.spec.as_ref()),
        paused: schedule.state.as_ref().is_some_and(|s| s.paused),
        notes: schedule
            .state
            .as_ref()
            .map(|s| s.notes.clone())
            .unwrap_or_default(),
        next_runs: info
            .future_action_times
            .iter()
            .filter_map(rfc3339)
            .collect(),
        recent_actions: info.recent_actions.iter().map(action_of).collect(),
    };
    let Value::Object(mut json) = to_json(
        "temporal.api.workflowservice.v1.DescribeScheduleResponse",
        &response,
    )?
    else {
        return Err(ToolError::new(
            crate::core::ToolErrorKind::Remote,
            TOOL,
            "a schedule is not an object",
        ));
    };
    let mut schedule_json = part(&mut json, "schedule");
    Ok(ScheduleDetail {
        summary,
        spec: part(&mut schedule_json, "spec"),
        action: part(&mut schedule_json, "action"),
        policies: part(&mut schedule_json, "policies"),
        state: part(&mut schedule_json, "state"),
        info: part(&mut json, "info"),
        form: super::schedule_form::form_of(&schedule),
        conflict_token: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &response.conflict_token,
        ),
    })
}

fn overlap(policy: Option<ScheduleOverlap>) -> i32 {
    match policy {
        None => 0,
        Some(ScheduleOverlap::Skip) => 1,
        Some(ScheduleOverlap::BufferOne) => 2,
        Some(ScheduleOverlap::BufferAll) => 3,
        Some(ScheduleOverlap::CancelOther) => 4,
        Some(ScheduleOverlap::TerminateOther) => 5,
        Some(ScheduleOverlap::AllowAll) => 6,
    }
}

/// What a `PatchSchedule` does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Patch {
    Pause,
    Unpause,
    Trigger,
}

/// `PatchSchedule`: pause, unpause (both with a note) or trigger now (with an overlap policy).
pub async fn schedule_patch(
    client: &TemporalClient,
    input: SchedulePatchInput,
    what: Patch,
) -> Result<(), ToolError> {
    let id = input.schedule_id.trim();
    if id.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "scheduleId",
            "a schedule id is required",
        ));
    }
    let note = input.note.unwrap_or_default().trim().to_owned();
    let mut patch = sched::SchedulePatch::default();
    match what {
        Patch::Pause => {
            patch.pause = if note.is_empty() {
                "Paused from Mightyconsole".into()
            } else {
                note
            }
        }
        Patch::Unpause => {
            patch.unpause = if note.is_empty() {
                "Unpaused from Mightyconsole".into()
            } else {
                note
            }
        }
        Patch::Trigger => {
            patch.trigger_immediately = Some(sched::TriggerImmediatelyRequest {
                overlap_policy: overlap(input.overlap),
                scheduled_time: None,
            });
        }
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .patch_schedule(client.request(
            &namespace,
            ws::PatchScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id.to_owned(),
                patch: Some(patch),
                identity: IDENTITY.into(),
                request_id: random_id(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// `DeleteSchedule`.
pub async fn schedule_delete(client: &TemporalClient, input: ScheduleRef) -> Result<(), ToolError> {
    let id = input.schedule_id.trim();
    if id.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "scheduleId",
            "a schedule id is required",
        ));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .delete_schedule(client.request(
            &namespace,
            ws::DeleteScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id.to_owned(),
                identity: IDENTITY.into(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

// --- Task queues ------------------------------------------------------------------------------

fn poller_of(p: &super::proto::temporal::api::taskqueue::v1::PollerInfo) -> Poller {
    Poller {
        identity: p.identity.clone(),
        last_access_time: p.last_access_time.as_ref().and_then(rfc3339),
        rate_per_second: p.rate_per_second,
    }
}

/// One kind of poller of a queue (`DescribeTaskQueue`): the pollers and the backlog it reports.
async fn describe_kind(
    client: &TemporalClient,
    namespace: &str,
    name: &str,
    kind: i32,
) -> Result<(Vec<Poller>, Option<u64>), ToolError> {
    let response = client
        .service()
        .describe_task_queue(client.request(
            namespace,
            ws::DescribeTaskQueueRequest {
                namespace: namespace.to_owned(),
                task_queue: Some(TaskQueue {
                    name: name.to_owned(),
                    kind: 1,
                    normal_name: String::new(),
                }),
                task_queue_type: kind,
                report_stats: true,
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let mut pollers: Vec<Poller> = response.pollers.iter().map(poller_of).collect();
    pollers.sort_by(|a, b| a.identity.cmp(&b.identity));
    let backlog = response
        .stats
        .as_ref()
        .and_then(|s| u64::try_from(s.approximate_backlog_count).ok());
    Ok((pollers, backlog))
}

/// The workflow and activity pollers of a task queue, and its backlog when the server reports it.
pub async fn task_queue_describe(
    client: &TemporalClient,
    input: TaskQueueDescribeInput,
) -> Result<TaskQueueDescription, ToolError> {
    let name = input.task_queue.trim();
    if name.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "taskQueue",
            "a task queue name is required",
        ));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let (workflow_pollers, workflow_backlog) = describe_kind(client, &namespace, name, 1).await?;
    let (activity_pollers, activity_backlog) = describe_kind(client, &namespace, name, 2).await?;
    Ok(TaskQueueDescription {
        workflow_pollers,
        activity_pollers,
        workflow_backlog,
        activity_backlog,
    })
}

#[cfg(test)]
mod tests {
    use super::sched::{IntervalSpec, ScheduleSpec};
    use super::*;

    fn secs(seconds: i64) -> prost_types::Duration {
        prost_types::Duration { seconds, nanos: 0 }
    }

    #[test]
    fn specs_read_in_words() {
        let spec = ScheduleSpec {
            interval: vec![
                IntervalSpec {
                    interval: Some(secs(60)),
                    phase: None,
                },
                IntervalSpec {
                    interval: Some(secs(3_660)),
                    phase: Some(secs(30)),
                },
            ],
            cron_string: vec!["0 * * * *".into()],
            ..Default::default()
        };
        assert_eq!(
            spec_in_words(Some(&spec)),
            "Every 1 minute; Every 1 hour 1 minute at offset 30 seconds; Cron 0 * * * *"
        );
        assert_eq!(spec_in_words(None), "");
    }

    #[test]
    fn a_reason_is_required_to_terminate_and_reset_and_trimmed() {
        assert!(required("reason", None).is_err());
        assert!(required("reason", Some("  ")).is_err());
        assert_eq!(
            required("reason", Some(" bad deploy ")).unwrap(),
            "bad deploy"
        );
    }

    #[test]
    fn overlap_policies_follow_the_proto_numbers() {
        assert_eq!(overlap(None), 0);
        assert_eq!(overlap(Some(ScheduleOverlap::Skip)), 1);
        assert_eq!(overlap(Some(ScheduleOverlap::AllowAll)), 6);
    }
}
