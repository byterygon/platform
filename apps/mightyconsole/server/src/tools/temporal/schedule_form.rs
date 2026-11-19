//! `temporal.schedules.create` and `update` (TSK-92, spec §9.3 "Create or edit schedule", §9.4):
//! a schedule as the sheet edits it, [`ScheduleForm`], to and from the protobuf `Schedule`.
//!
//! The server keeps calendar and cron specs as `structured_calendar` (ranges), so a described
//! schedule's calendars come back as Temporal's calendar strings ("0", "1-5", "*/15", "0,30");
//! cron strings and intervals stay as they are. Update starts from the stored schedule and
//! replaces only what the form holds, so fields the form does not show (headers, priority,
//! versioning, excluded calendars) are kept, and sends it with the conflict token the sheet was
//! opened with.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::actions_types::ScheduleOverlap;
use super::client::{TemporalClient, status_error};
use super::payloads::{decode_payloads, to_json};
use super::proto::temporal::api::common::v1::{Payloads, WorkflowType};
use super::proto::temporal::api::schedule::v1 as sched;
use super::proto::temporal::api::taskqueue::v1::TaskQueue;
use super::proto::temporal::api::workflow::v1::NewWorkflowExecutionInfo;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::start::{
    IDENTITY, RetryPolicyForm, format_duration, memo_of, parse_duration, payloads_of, required,
    search_attributes_of,
};
use super::{TOOL, rfc3339};
use crate::core::{ToolError, ToolErrorKind, random_id};

/// One calendar: Temporal's calendar strings per field; an absent field takes its default
/// (second, minute and hour 0; the others every value).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CalendarForm {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub second: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub minute: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub hour: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub day_of_month: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub month: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub year: Option<String>,
    /// 0 is Sunday.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub day_of_week: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub comment: Option<String>,
}

/// Every `every`, at `offset` after the Unix epoch's multiples of it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IntervalForm {
    pub every: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub offset: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSpecForm {
    pub calendars: Vec<CalendarForm>,
    pub intervals: Vec<IntervalForm>,
    pub cron_strings: Vec<String>,
    /// An IANA time zone; UTC when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub timezone: Option<String>,
    /// RFC 3339; no run before it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub start_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub end_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub jitter: Option<String>,
}

/// The workflow each run starts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleActionForm {
    pub workflow_type: String,
    pub task_queue: String,
    /// Temporal appends the scheduled time to it.
    pub workflow_id: String,
    /// One `json/plain` payload per argument. A described schedule whose input is not JSON has
    /// `{ "$opaque": … }` values here, which an update refuses until they are replaced.
    #[ts(type = "unknown[]")]
    #[schemars(with = "Vec<Value>")]
    pub args: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub execution_timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub run_timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub task_timeout: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub retry_policy: Option<RetryPolicyForm>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub memo: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "Record<string, unknown>")]
    #[schemars(with = "Option<Map<String, Value>>")]
    pub search_attributes: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchedulePoliciesForm {
    /// Skip when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub overlap: Option<ScheduleOverlap>,
    /// How late a missed run may still start; one year when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub catchup_window: Option<String>,
    pub pause_on_failure: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleStateForm {
    pub paused: bool,
    pub notes: String,
    /// Runs left before the schedule stops by itself; unlimited when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub remaining_actions: Option<i64>,
}

/// A schedule as the sheet edits it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleForm {
    pub spec: ScheduleSpecForm,
    pub action: ScheduleActionForm,
    pub policies: SchedulePoliciesForm,
    pub state: ScheduleStateForm,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleWriteInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
    pub schedule: ScheduleForm,
    /// For `update`: the token of the `describe` the sheet was filled from.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub conflict_token: Option<String>,
}

// --- Calendar strings <-> ranges ---------------------------------------------------------------

/// Temporal's string for a list of ranges ("0", "1-5", "*/15", "0,30"); `None` for an empty list
/// (the field's default).
fn ranges_text(ranges: &[sched::Range], max: i32) -> Option<String> {
    if ranges.is_empty() {
        return None;
    }
    let parts: Vec<String> = ranges
        .iter()
        .map(|r| {
            let end = r.end.max(r.start);
            let step = r.step.max(1);
            if end == r.start {
                r.start.to_string()
            } else if r.start == 0 && end == max && step > 1 {
                format!("*/{step}")
            } else if r.start == 0 && end == max {
                "*".into()
            } else if step > 1 {
                format!("{}-{end}/{step}", r.start)
            } else {
                format!("{}-{end}", r.start)
            }
        })
        .collect();
    Some(parts.join(","))
}

fn calendar_of_structured(s: &sched::StructuredCalendarSpec) -> CalendarForm {
    // A year range's end is open (0 or far ahead); show the years as they are.
    CalendarForm {
        second: ranges_text(&s.second, 59),
        minute: ranges_text(&s.minute, 59),
        hour: ranges_text(&s.hour, 23),
        day_of_month: ranges_text(&s.day_of_month, 31).filter(|t| t != "1-31"),
        month: ranges_text(&s.month, 12).filter(|t| t != "1-12"),
        year: ranges_text(&s.year, i32::MAX),
        day_of_week: ranges_text(&s.day_of_week, 6),
        comment: (!s.comment.is_empty()).then(|| s.comment.clone()),
    }
}

fn calendar_of_strings(c: &sched::CalendarSpec) -> CalendarForm {
    let some = |s: &str| (!s.is_empty()).then(|| s.to_owned());
    CalendarForm {
        second: some(&c.second),
        minute: some(&c.minute),
        hour: some(&c.hour),
        day_of_month: some(&c.day_of_month),
        month: some(&c.month),
        year: some(&c.year),
        day_of_week: some(&c.day_of_week),
        comment: some(&c.comment),
    }
}

fn calendar_spec(c: &CalendarForm) -> sched::CalendarSpec {
    let text = |v: &Option<String>| v.as_deref().map(str::trim).unwrap_or("").to_owned();
    sched::CalendarSpec {
        second: text(&c.second),
        minute: text(&c.minute),
        hour: text(&c.hour),
        day_of_month: text(&c.day_of_month),
        month: text(&c.month),
        year: text(&c.year),
        day_of_week: text(&c.day_of_week),
        comment: text(&c.comment),
    }
}

// --- Form <-> proto ------------------------------------------------------------------------------

fn overlap_of(value: i32) -> Option<ScheduleOverlap> {
    match value {
        1 => Some(ScheduleOverlap::Skip),
        2 => Some(ScheduleOverlap::BufferOne),
        3 => Some(ScheduleOverlap::BufferAll),
        4 => Some(ScheduleOverlap::CancelOther),
        5 => Some(ScheduleOverlap::TerminateOther),
        6 => Some(ScheduleOverlap::AllowAll),
        _ => None,
    }
}

fn overlap_to(value: Option<ScheduleOverlap>) -> i32 {
    match value {
        None => 0,
        Some(ScheduleOverlap::Skip) => 1,
        Some(ScheduleOverlap::BufferOne) => 2,
        Some(ScheduleOverlap::BufferAll) => 3,
        Some(ScheduleOverlap::CancelOther) => 4,
        Some(ScheduleOverlap::TerminateOther) => 5,
        Some(ScheduleOverlap::AllowAll) => 6,
    }
}

/// JSON values of payloads (decoded as everywhere else; non-JSON ones as `$opaque`).
fn values_of(payloads: Option<&Payloads>) -> Vec<Value> {
    let Some(p) = payloads else { return Vec::new() };
    match to_json("temporal.api.common.v1.Payloads", p) {
        Ok(Value::Array(items)) => items,
        Ok(other) => vec![other],
        Err(_) => Vec::new(),
    }
}

fn map_of<M: prost::Message>(
    full_name: &str,
    message: Option<&M>,
    key: &str,
) -> Option<Map<String, Value>> {
    let mut json = to_json(full_name, message?).ok()?;
    decode_payloads(&mut json);
    match json.get_mut(key).map(Value::take) {
        Some(Value::Object(map)) if !map.is_empty() => Some(map),
        _ => None,
    }
}

/// The form of a stored schedule.
pub fn form_of(schedule: &sched::Schedule) -> ScheduleForm {
    let spec = schedule.spec.clone().unwrap_or_default();
    let mut calendars: Vec<CalendarForm> = spec.calendar.iter().map(calendar_of_strings).collect();
    calendars.extend(spec.structured_calendar.iter().map(calendar_of_structured));
    let start = match schedule.action.as_ref().and_then(|a| a.action.as_ref()) {
        Some(sched::schedule_action::Action::StartWorkflow(w)) => w.clone(),
        None => NewWorkflowExecutionInfo::default(),
    };
    let policies = schedule.policies.unwrap_or_default();
    let state = schedule.state.clone().unwrap_or_default();
    ScheduleForm {
        spec: ScheduleSpecForm {
            calendars,
            intervals: spec
                .interval
                .iter()
                .map(|i| IntervalForm {
                    every: i.interval.as_ref().map(format_duration).unwrap_or_default(),
                    offset: i
                        .phase
                        .as_ref()
                        .filter(|p| p.seconds != 0 || p.nanos != 0)
                        .map(format_duration),
                })
                .collect(),
            cron_strings: spec.cron_string.clone(),
            timezone: (!spec.timezone_name.is_empty()).then(|| spec.timezone_name.clone()),
            start_time: spec.start_time.as_ref().and_then(rfc3339),
            end_time: spec.end_time.as_ref().and_then(rfc3339),
            jitter: spec
                .jitter
                .as_ref()
                .filter(|j| j.seconds != 0 || j.nanos != 0)
                .map(format_duration),
        },
        action: ScheduleActionForm {
            workflow_type: start.workflow_type.map(|t| t.name).unwrap_or_default(),
            task_queue: start.task_queue.map(|q| q.name).unwrap_or_default(),
            workflow_id: start.workflow_id,
            args: values_of(start.input.as_ref()),
            execution_timeout: start
                .workflow_execution_timeout
                .as_ref()
                .map(format_duration),
            run_timeout: start.workflow_run_timeout.as_ref().map(format_duration),
            task_timeout: start.workflow_task_timeout.as_ref().map(format_duration),
            retry_policy: start.retry_policy.as_ref().map(RetryPolicyForm::from_proto),
            memo: map_of("temporal.api.common.v1.Memo", start.memo.as_ref(), "fields"),
            search_attributes: map_of(
                "temporal.api.common.v1.SearchAttributes",
                start.search_attributes.as_ref(),
                "indexedFields",
            ),
        },
        policies: SchedulePoliciesForm {
            overlap: overlap_of(policies.overlap_policy),
            catchup_window: policies.catchup_window.as_ref().map(format_duration),
            pause_on_failure: policies.pause_on_failure,
        },
        state: ScheduleStateForm {
            paused: state.paused,
            notes: state.notes,
            remaining_actions: state.limited_actions.then_some(state.remaining_actions),
        },
    }
}

fn timestamp(field: &str, text: Option<&str>) -> Result<Option<prost_types::Timestamp>, ToolError> {
    let Some(text) = text.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let t = time::OffsetDateTime::parse(text, &time::format_description::well_known::Rfc3339)
        .map_err(|_| {
            ToolError::invalid(
                TOOL,
                field,
                "an RFC 3339 time, such as 2026-12-01T00:00:00Z",
            )
        })?;
    Ok(Some(prost_types::Timestamp {
        seconds: t.unix_timestamp(),
        nanos: t.nanosecond() as i32,
    }))
}

/// `base` with the form's fields written over it.
pub fn apply(form: &ScheduleForm, base: sched::Schedule) -> Result<sched::Schedule, ToolError> {
    let f = &form.spec;
    if f.calendars.is_empty()
        && f.intervals.is_empty()
        && f.cron_strings.iter().all(|c| c.trim().is_empty())
    {
        return Err(ToolError::invalid(
            TOOL,
            "schedule.spec",
            "a calendar, an interval or a cron string is required",
        ));
    }
    if let Some(bad) = form
        .action
        .args
        .iter()
        .position(|v| v.get("$opaque").is_some())
    {
        return Err(ToolError::invalid(
            TOOL,
            "schedule.action.args",
            format!(
                "argument {} is encoded and cannot be sent back; replace it with JSON",
                bad + 1
            ),
        ));
    }
    let mut spec = base.spec.unwrap_or_default();
    spec.calendar = f.calendars.iter().map(calendar_spec).collect();
    spec.structured_calendar = Vec::new();
    spec.cron_string = f
        .cron_strings
        .iter()
        .map(|c| c.trim().to_owned())
        .filter(|c| !c.is_empty())
        .collect();
    spec.interval = f
        .intervals
        .iter()
        .enumerate()
        .map(|(i, interval)| {
            let field = format!("schedule.spec.intervals.{i}");
            let every = parse_duration(&format!("{field}.every"), &interval.every)?
                .filter(|d| d.seconds > 0)
                .ok_or_else(|| {
                    ToolError::invalid(TOOL, &format!("{field}.every"), "at least 1s")
                })?;
            Ok(sched::IntervalSpec {
                interval: Some(every),
                phase: parse_duration(
                    &format!("{field}.offset"),
                    interval.offset.as_deref().unwrap_or(""),
                )?,
            })
        })
        .collect::<Result<_, ToolError>>()?;
    spec.timezone_name = f
        .timezone
        .as_deref()
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    spec.timezone_data = Vec::new();
    spec.start_time = timestamp("schedule.spec.startTime", f.start_time.as_deref())?;
    spec.end_time = timestamp("schedule.spec.endTime", f.end_time.as_deref())?;
    spec.jitter = parse_duration("schedule.spec.jitter", f.jitter.as_deref().unwrap_or(""))?;

    let a = &form.action;
    let mut start = match base.action.and_then(|x| x.action) {
        Some(sched::schedule_action::Action::StartWorkflow(w)) => w,
        None => NewWorkflowExecutionInfo::default(),
    };
    start.workflow_type = Some(WorkflowType {
        name: required(
            "schedule.action.workflowType",
            &a.workflow_type,
            "a workflow type",
        )?,
    });
    start.task_queue = Some(TaskQueue {
        name: required("schedule.action.taskQueue", &a.task_queue, "a task queue")?,
        kind: 1,
        normal_name: String::new(),
    });
    start.workflow_id = required(
        "schedule.action.workflowId",
        &a.workflow_id,
        "a workflow ID",
    )?;
    start.input = payloads_of(Some(&a.args))?;
    start.workflow_execution_timeout = parse_duration(
        "schedule.action.executionTimeout",
        a.execution_timeout.as_deref().unwrap_or(""),
    )?;
    start.workflow_run_timeout = parse_duration(
        "schedule.action.runTimeout",
        a.run_timeout.as_deref().unwrap_or(""),
    )?;
    start.workflow_task_timeout = parse_duration(
        "schedule.action.taskTimeout",
        a.task_timeout.as_deref().unwrap_or(""),
    )?;
    start.retry_policy = a
        .retry_policy
        .as_ref()
        .map(RetryPolicyForm::to_proto)
        .transpose()?;
    start.memo = memo_of(a.memo.as_ref())?;
    start.search_attributes = search_attributes_of(a.search_attributes.as_ref())?;

    let mut policies = base.policies.unwrap_or_default();
    policies.overlap_policy = overlap_to(form.policies.overlap);
    policies.catchup_window = parse_duration(
        "schedule.policies.catchupWindow",
        form.policies.catchup_window.as_deref().unwrap_or(""),
    )?;
    policies.pause_on_failure = form.policies.pause_on_failure;

    let s = &form.state;
    if s.remaining_actions.is_some_and(|n| n < 1) {
        return Err(ToolError::invalid(
            TOOL,
            "schedule.state.remainingActions",
            "1 or more",
        ));
    }
    let state = sched::ScheduleState {
        notes: s.notes.trim().to_owned(),
        paused: s.paused,
        limited_actions: s.remaining_actions.is_some(),
        remaining_actions: s.remaining_actions.unwrap_or(0),
    };
    Ok(sched::Schedule {
        spec: Some(spec),
        action: Some(sched::ScheduleAction {
            action: Some(sched::schedule_action::Action::StartWorkflow(start)),
        }),
        policies: Some(policies),
        state: Some(state),
    })
}

/// `CreateSchedule`.
/// The schedule's workflow input, stored outside when it is large (TSK-103).
async fn offload_input(
    client: &TemporalClient,
    schedule: &mut sched::Schedule,
) -> Result<(), ToolError> {
    if let Some(sched::schedule_action::Action::StartWorkflow(start)) =
        schedule.action.as_mut().and_then(|a| a.action.as_mut())
    {
        start.input =
            super::extstore::offload(client.external.as_deref(), start.input.take()).await?;
    }
    Ok(())
}

pub async fn create(client: &TemporalClient, input: ScheduleWriteInput) -> Result<(), ToolError> {
    let id = required("scheduleId", &input.schedule_id, "a schedule ID")?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let mut schedule = apply(&input.schedule, sched::Schedule::default())?;
    offload_input(client, &mut schedule).await?;
    client
        .service()
        .create_schedule(client.request(
            &namespace,
            ws::CreateScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id,
                schedule: Some(schedule),
                identity: IDENTITY.into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// `UpdateSchedule` from the stored schedule, with the sheet's conflict token.
pub async fn update(client: &TemporalClient, input: ScheduleWriteInput) -> Result<(), ToolError> {
    let id = required("scheduleId", &input.schedule_id, "a schedule ID")?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let conflict_token = match input.conflict_token.as_deref().filter(|t| !t.is_empty()) {
        Some(t) => BASE64
            .decode(t)
            .map_err(|_| ToolError::invalid(TOOL, "conflictToken", "not a token of this tool"))?,
        None => Vec::new(),
    };
    let stored = client
        .service()
        .describe_schedule(client.request(
            &namespace,
            ws::DescribeScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id.clone(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    if !conflict_token.is_empty() && stored.conflict_token != conflict_token {
        return Err(ToolError::new(
            ToolErrorKind::Conflict,
            TOOL,
            "the schedule changed since this sheet was opened; reload it and apply your changes again",
        ));
    }
    let mut schedule = apply(&input.schedule, stored.schedule.unwrap_or_default())?;
    offload_input(client, &mut schedule).await?;
    client
        .service()
        .update_schedule(client.request(
            &namespace,
            ws::UpdateScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id,
                schedule: Some(schedule),
                conflict_token: if conflict_token.is_empty() {
                    stored.conflict_token
                } else {
                    conflict_token
                },
                identity: IDENTITY.into(),
                request_id: random_id(),
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(start: i32, end: i32, step: i32) -> sched::Range {
        sched::Range { start, end, step }
    }

    fn form() -> ScheduleForm {
        ScheduleForm {
            spec: ScheduleSpecForm {
                calendars: vec![CalendarForm {
                    hour: Some("2".into()),
                    ..Default::default()
                }],
                intervals: vec![IntervalForm {
                    every: "1h".into(),
                    offset: Some("15m".into()),
                }],
                cron_strings: vec!["30 4 * * 1-5".into()],
                timezone: Some("Europe/Berlin".into()),
                start_time: None,
                end_time: Some("2027-01-01T00:00:00Z".into()),
                jitter: Some("30s".into()),
            },
            action: ScheduleActionForm {
                workflow_type: "InventorySync".into(),
                task_queue: "inventory".into(),
                workflow_id: "inventory-sync".into(),
                args: vec![serde_json::json!({ "full": false })],
                execution_timeout: Some("1h".into()),
                run_timeout: None,
                task_timeout: None,
                retry_policy: None,
                memo: None,
                search_attributes: None,
            },
            policies: SchedulePoliciesForm {
                overlap: Some(ScheduleOverlap::BufferOne),
                catchup_window: Some("1m".into()),
                pause_on_failure: true,
            },
            state: ScheduleStateForm {
                paused: true,
                notes: "new".into(),
                remaining_actions: Some(10),
            },
        }
    }

    #[test]
    fn ranges_read_as_calendar_strings() {
        assert_eq!(ranges_text(&[], 59), None);
        assert_eq!(ranges_text(&[r(0, 0, 0)], 59).as_deref(), Some("0"));
        assert_eq!(ranges_text(&[r(1, 5, 1)], 6).as_deref(), Some("1-5"));
        assert_eq!(ranges_text(&[r(0, 59, 15)], 59).as_deref(), Some("*/15"));
        assert_eq!(
            ranges_text(&[r(0, 0, 1), r(30, 0, 0)], 59).as_deref(),
            Some("0,30")
        );
        assert_eq!(ranges_text(&[r(8, 18, 2)], 23).as_deref(), Some("8-18/2"));
        let c = calendar_of_structured(&sched::StructuredCalendarSpec {
            second: vec![r(0, 0, 0)],
            minute: vec![r(0, 0, 0)],
            hour: vec![r(2, 0, 0)],
            day_of_month: vec![r(1, 31, 1)],
            month: vec![r(1, 12, 1)],
            day_of_week: vec![r(0, 6, 1)],
            ..Default::default()
        });
        assert_eq!(c.hour.as_deref(), Some("2"));
        assert_eq!(c.day_of_month, None);
        assert_eq!(c.month, None);
        assert_eq!(c.day_of_week.as_deref(), Some("*"));
    }

    #[test]
    fn a_form_round_trips_through_the_proto() {
        let f = form();
        let schedule = apply(&f, sched::Schedule::default()).unwrap();
        let spec = schedule.spec.as_ref().unwrap();
        assert_eq!(spec.calendar[0].hour, "2");
        assert_eq!(spec.interval[0].phase.as_ref().unwrap().seconds, 900);
        assert_eq!(schedule.policies.as_ref().unwrap().overlap_policy, 2);
        assert!(schedule.state.as_ref().unwrap().limited_actions);
        assert_eq!(form_of(&schedule), f);
    }

    #[test]
    fn update_keeps_what_the_form_does_not_show() {
        let mut base = apply(&form(), sched::Schedule::default()).unwrap();
        base.policies.as_mut().unwrap().keep_original_workflow_id = true;
        let mut changed = form();
        changed.state.notes = "edited".into();
        let next = apply(&changed, base).unwrap();
        assert!(next.policies.unwrap().keep_original_workflow_id);
        assert_eq!(next.state.unwrap().notes, "edited");
    }

    #[test]
    fn a_form_without_a_spec_or_with_encoded_input_is_invalid() {
        let mut f = form();
        f.spec.calendars.clear();
        f.spec.intervals.clear();
        f.spec.cron_strings = vec![" ".into()];
        assert_eq!(
            apply(&f, sched::Schedule::default())
                .unwrap_err()
                .field
                .as_deref(),
            Some("schedule.spec")
        );
        let mut f = form();
        f.action.args =
            vec![serde_json::json!({ "$opaque": "binary/encrypted", "base64": "AA==" })];
        assert!(apply(&f, sched::Schedule::default()).is_err());
        let mut f = form();
        f.state.remaining_actions = Some(0);
        assert!(apply(&f, sched::Schedule::default()).is_err());
        let mut f = form();
        f.spec.intervals[0].every = "0s".into();
        assert!(apply(&f, sched::Schedule::default()).is_err());
    }
}
