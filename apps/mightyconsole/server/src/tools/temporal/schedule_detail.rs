//! A schedule's detail tab (Mightyconsole spec §9.3 "Schedule", §9.6, TSK-104): the times its spec
//! matches (`ListScheduleMatchingTimes`), backfill (`PatchSchedule` with a backfill request), and
//! its runs, page by page.
//!
//! Runs are the workflows a Workflows query on `TemporalScheduledById` finds, the first page merged
//! with the schedule's recent actions (the visibility store can lag behind), sorted by the time
//! they were scheduled for. Temporal keeps no record of a time the spec matched without a run, only
//! counts (`overlapSkipped`, `missedCatchupWindow`, `bufferDropped`); so each page asks the server
//! which times the spec matched over the page's span, since the schedule's last update (an older
//! spec may have matched other times), and lists those with no run as "No run", with the reason
//! when it can be told: the overlap policy Skip while an earlier run was still running.

use std::collections::HashSet;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use ts_rs::TS;

use super::actions::{IDENTITY, action_of, overlap};
use super::actions_types::ScheduleOverlap;
use super::client::{TemporalClient, status_error};
use super::proto::temporal::api::enums::v1::ScheduleOverlapPolicy;
use super::proto::temporal::api::schedule::v1 as sched;
use super::proto::temporal::api::workflow::v1::WorkflowExecutionInfo;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::relations::quote;
use super::types::WorkflowStatus;
use super::{TOOL, rfc3339, row};
use crate::core::{ToolError, random_id};

/// Matched times sent at most in one answer.
pub const MAX_TIMES: usize = 1_000;
const DEFAULT_RUNS_PAGE: u32 = 20;
const MAX_RUNS_PAGE: u32 = 100;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTimesInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
    /// RFC 3339.
    pub start_time: String,
    /// RFC 3339; when absent, the range grows from `startTime` until `limit` times are found
    /// (at most five years ahead).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub end_time: Option<String>,
    /// At most this many times: 20 when absent, 1,000 at most.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleTimesOutput {
    /// RFC 3339, oldest first.
    pub times: Vec<String>,
    /// More times matched than were sent.
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleBackfillInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
    /// RFC 3339, in the past.
    pub start_time: String,
    /// RFC 3339, after the start and not in the future.
    pub end_time: String,
    /// The schedule's own policy when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub overlap: Option<ScheduleOverlap>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunsInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub namespace: Option<String>,
    pub schedule_id: String,
    /// 1 to 100; 20 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub page_size: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub next_page_token: Option<String>,
}

/// One row of a schedule's Runs: a workflow it started, or a time it matched with no run.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRun {
    /// The time the spec called for (`TemporalScheduledStartTime`); for Trigger now, the trigger.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub scheduled_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub close_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub workflow_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub status: Option<WorkflowStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duration_ms: Option<i64>,
    /// A matched time with no run: why, as far as it can be told.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub skipped: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRunsOutput {
    pub runs: Vec<ScheduleRun>,
    /// The Workflows query the runs come from.
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub next_page_token: Option<String>,
}

fn parse_time(field: &str, text: &str) -> Result<OffsetDateTime, ToolError> {
    OffsetDateTime::parse(text.trim(), &Rfc3339).map_err(|_| {
        ToolError::invalid(
            TOOL,
            field,
            "an RFC 3339 time, such as 2026-11-19T02:00:00Z",
        )
    })
}

fn timestamp(t: OffsetDateTime) -> prost_types::Timestamp {
    prost_types::Timestamp {
        seconds: t.unix_timestamp(),
        nanos: t.nanosecond() as i32,
    }
}

fn secs(t: &prost_types::Timestamp) -> i64 {
    t.seconds
}

fn from_secs(s: i64) -> Option<String> {
    rfc3339(&prost_types::Timestamp {
        seconds: s,
        nanos: 0,
    })
}

fn require_id(id: &str) -> Result<&str, ToolError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "scheduleId",
            "a schedule id is required",
        ));
    }
    Ok(id)
}

async fn matching(
    client: &TemporalClient,
    namespace: &str,
    id: &str,
    start: prost_types::Timestamp,
    end: prost_types::Timestamp,
) -> Result<Vec<prost_types::Timestamp>, ToolError> {
    Ok(client
        .service()
        .list_schedule_matching_times(client.request(
            namespace,
            ws::ListScheduleMatchingTimesRequest {
                namespace: namespace.to_owned(),
                schedule_id: id.to_owned(),
                start_time: Some(start),
                end_time: Some(end),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner()
        .start_time)
}

/// `temporal.schedules.matchingTimes`.
pub async fn matching_times(
    client: &TemporalClient,
    input: ScheduleTimesInput,
) -> Result<ScheduleTimesOutput, ToolError> {
    let id = require_id(&input.schedule_id)?;
    let limit = input.limit.unwrap_or(20).clamp(1, MAX_TIMES as u32) as usize;
    let start = parse_time("startTime", &input.start_time)?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let mut times = match &input.end_time {
        Some(end) => {
            let end = parse_time("endTime", end)?;
            if end <= start {
                return Err(ToolError::invalid(TOOL, "endTime", "after the start time"));
            }
            matching(client, &namespace, id, timestamp(start), timestamp(end)).await?
        }
        None => {
            // A day, then eight times longer until enough times or five years.
            let mut span = time::Duration::days(1);
            loop {
                let found = matching(
                    client,
                    &namespace,
                    id,
                    timestamp(start),
                    timestamp(start + span),
                )
                .await?;
                if found.len() >= limit || span >= time::Duration::days(5 * 366) {
                    break found;
                }
                span = (span * 8_i32).min(time::Duration::days(5 * 366));
            }
        }
    };
    let truncated = times.len() > limit;
    times.truncate(limit);
    Ok(ScheduleTimesOutput {
        times: times.iter().filter_map(rfc3339).collect(),
        truncated,
    })
}

/// `temporal.schedules.backfill`.
pub async fn backfill(
    client: &TemporalClient,
    input: ScheduleBackfillInput,
) -> Result<(), ToolError> {
    let id = require_id(&input.schedule_id)?;
    let start = parse_time("startTime", &input.start_time)?;
    let end = parse_time("endTime", &input.end_time)?;
    if end <= start {
        return Err(ToolError::invalid(TOOL, "endTime", "after the start time"));
    }
    if end > OffsetDateTime::now_utc() + time::Duration::minutes(1) {
        return Err(ToolError::invalid(
            TOOL,
            "endTime",
            "a backfill covers past times only",
        ));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    client
        .service()
        .patch_schedule(client.request(
            &namespace,
            ws::PatchScheduleRequest {
                namespace: namespace.clone(),
                schedule_id: id.to_owned(),
                patch: Some(sched::SchedulePatch {
                    backfill_request: vec![sched::BackfillRequest {
                        start_time: Some(timestamp(start)),
                        end_time: Some(timestamp(end)),
                        overlap_policy: overlap(input.overlap),
                    }],
                    ..Default::default()
                }),
                identity: IDENTITY.into(),
                request_id: random_id(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?;
    Ok(())
}

/// The time a run was scheduled for, from its `TemporalScheduledStartTime` search attribute.
fn scheduled_of(info: &WorkflowExecutionInfo) -> Option<i64> {
    let payload = info
        .search_attributes
        .as_ref()?
        .indexed_fields
        .get("TemporalScheduledStartTime")?;
    let text: String = serde_json::from_slice(&payload.data).ok()?;
    OffsetDateTime::parse(&text, &Rfc3339)
        .ok()
        .map(OffsetDateTime::unix_timestamp)
}

/// A run as the skip check reads it: scheduled, started and closed, in seconds.
#[derive(Debug, Clone, Copy)]
pub struct RunSpan {
    pub scheduled: i64,
    pub start: Option<i64>,
    pub close: Option<i64>,
}

/// The matched times with no run, each with why: under the overlap policy Skip, a time while an
/// earlier run was still running was skipped for it; otherwise the reason is not recorded.
pub fn skipped_times(matched: &[i64], runs: &[RunSpan], overlap_skip: bool) -> Vec<(i64, String)> {
    let had: HashSet<i64> = runs.iter().map(|r| r.scheduled).collect();
    matched
        .iter()
        .filter(|t| !had.contains(t))
        .map(|&t| {
            let busy = runs
                .iter()
                .any(|r| r.start.is_some_and(|s| s <= t) && r.close.is_none_or(|c| c > t));
            let reason = if overlap_skip && busy {
                "Skipped: the previous run was still running (overlap Skip)".to_owned()
            } else {
                "No run started: paused, outside the catch-up window, or dropped from the buffer"
                    .to_owned()
            };
            (t, reason)
        })
        .collect()
}

/// Our page token: the oldest scheduled time of the pages before (the end of the next page's span)
/// and the visibility store's token.
fn encode_runs_token(boundary: i64, token: &[u8]) -> String {
    format!("{boundary}:{}", BASE64.encode(token))
}

fn decode_runs_token(token: &str) -> Result<(i64, Vec<u8>), ToolError> {
    let bad = || ToolError::invalid(TOOL, "nextPageToken", "not a page token of this tool");
    let (boundary, rest) = token.split_once(':').ok_or_else(bad)?;
    Ok((
        boundary.parse().map_err(|_| bad())?,
        BASE64.decode(rest).map_err(|_| bad())?,
    ))
}

/// `temporal.schedules.runs`.
pub async fn runs(
    client: &TemporalClient,
    input: ScheduleRunsInput,
) -> Result<ScheduleRunsOutput, ToolError> {
    let id = require_id(&input.schedule_id)?.to_owned();
    let page_size = input.page_size.unwrap_or(DEFAULT_RUNS_PAGE);
    if !(1..=MAX_RUNS_PAGE).contains(&page_size) {
        return Err(ToolError::invalid(TOOL, "pageSize", "1 to 100"));
    }
    let given = input.next_page_token.as_deref().filter(|t| !t.is_empty());
    let first = given.is_none();
    let (end, token) = match given {
        Some(t) => decode_runs_token(t)?,
        None => (OffsetDateTime::now_utc().unix_timestamp(), Vec::new()),
    };
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let query = format!("TemporalScheduledById = {}", quote(&id));
    let described = client
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
    let info = described.info.unwrap_or_default();
    let skip_policy = described
        .schedule
        .as_ref()
        .and_then(|s| s.policies.as_ref())
        .map_or(0, |p| p.overlap_policy);
    let overlap_skip = matches!(
        ScheduleOverlapPolicy::try_from(skip_policy),
        Ok(ScheduleOverlapPolicy::Skip | ScheduleOverlapPolicy::Unspecified)
    );
    let listed = client
        .service()
        .list_workflow_executions(client.request(
            &namespace,
            ws::ListWorkflowExecutionsRequest {
                namespace: namespace.clone(),
                page_size: page_size as i32,
                next_page_token: token,
                query: query.clone(),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();

    let mut runs: Vec<ScheduleRun> = Vec::new();
    let mut spans: Vec<RunSpan> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for execution in &listed.executions {
        let r = row(execution);
        let scheduled = scheduled_of(execution).or_else(|| execution.start_time.as_ref().map(secs));
        spans.push(RunSpan {
            scheduled: scheduled.unwrap_or_default(),
            start: execution.start_time.as_ref().map(secs),
            close: execution.close_time.as_ref().map(secs),
        });
        seen.insert(r.run_id.clone());
        runs.push(ScheduleRun {
            scheduled_time: scheduled.and_then(from_secs),
            start_time: r.start_time,
            close_time: r.close_time,
            workflow_id: Some(r.workflow_id),
            run_id: Some(r.run_id),
            status: Some(r.status),
            duration_ms: r.duration_ms,
            skipped: None,
        });
    }
    if first {
        // Started but not yet in the visibility store.
        for result in &info.recent_actions {
            let action = action_of(result);
            if action.run_id.is_empty() || seen.contains(&action.run_id) {
                continue;
            }
            let scheduled = result.schedule_time.as_ref().map(secs);
            spans.push(RunSpan {
                scheduled: scheduled.unwrap_or_default(),
                start: result.actual_time.as_ref().map(secs),
                close: None,
            });
            runs.push(ScheduleRun {
                scheduled_time: action.scheduled_time,
                start_time: action.actual_time,
                close_time: None,
                workflow_id: Some(action.workflow_id),
                run_id: Some(action.run_id),
                status: Some(WorkflowStatus::from_proto(result.start_workflow_status)),
                duration_ms: None,
                skipped: None,
            });
        }
    }

    // The page's span: from its oldest scheduled time (or, on the last page, the last update) to
    // the end of the pages before, never before the last update.
    let since = info
        .update_time
        .as_ref()
        .or(info.create_time.as_ref())
        .map_or(i64::MIN, secs);
    let more = !listed.next_page_token.is_empty();
    let oldest = spans.iter().map(|s| s.scheduled).filter(|s| *s > 0).min();
    let start = if more { oldest.unwrap_or(end) } else { since };
    let start = start.max(since);
    if start < end && since > i64::MIN {
        let matched = matching(
            client,
            &namespace,
            &id,
            prost_types::Timestamp {
                seconds: start,
                nanos: 0,
            },
            prost_types::Timestamp {
                seconds: end,
                nanos: 0,
            },
        )
        .await?;
        let matched: Vec<i64> = matched.iter().map(secs).take(MAX_TIMES).collect();
        for (t, reason) in skipped_times(&matched, &spans, overlap_skip) {
            runs.push(ScheduleRun {
                scheduled_time: from_secs(t),
                start_time: None,
                close_time: None,
                workflow_id: None,
                run_id: None,
                status: None,
                duration_ms: None,
                skipped: Some(reason),
            });
        }
    }
    runs.sort_by(|a, b| {
        b.scheduled_time
            .as_deref()
            .and_then(|t| OffsetDateTime::parse(t, &Rfc3339).ok())
            .cmp(
                &a.scheduled_time
                    .as_deref()
                    .and_then(|t| OffsetDateTime::parse(t, &Rfc3339).ok()),
            )
    });
    Ok(ScheduleRunsOutput {
        runs,
        query,
        next_page_token: more
            .then(|| encode_runs_token(oldest.unwrap_or(end), &listed.next_page_token)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_matched_time_without_a_run_is_skipped_with_its_reason() {
        let runs = [
            // 02:00 ran for 30 hours (still running at the next day's 02:00).
            RunSpan {
                scheduled: 0,
                start: Some(0),
                close: Some(30 * 3600),
            },
            RunSpan {
                scheduled: 2 * 86_400,
                start: Some(2 * 86_400),
                close: Some(2 * 86_400 + 60),
            },
        ];
        let matched = [0, 86_400, 2 * 86_400, 3 * 86_400];
        let skipped = skipped_times(&matched, &runs, true);
        assert_eq!(skipped.len(), 2);
        assert_eq!(skipped[0].0, 86_400);
        assert!(skipped[0].1.contains("overlap Skip"), "{}", skipped[0].1);
        assert_eq!(skipped[1].0, 3 * 86_400);
        assert!(skipped[1].1.starts_with("No run started"));
        // Under another policy the overlap is not the reason.
        assert!(
            skipped_times(&matched, &runs, false)[0]
                .1
                .starts_with("No run started")
        );
    }

    #[test]
    fn runs_tokens_round_trip() {
        let token = encode_runs_token(1_794_000_000, &[1, 2, 255]);
        assert_eq!(
            decode_runs_token(&token).unwrap(),
            (1_794_000_000, vec![1, 2, 255])
        );
        assert!(decode_runs_token("nonsense").is_err());
    }

    #[test]
    fn times_are_rfc3339() {
        assert!(parse_time("startTime", "2026-11-19T02:00:00+01:00").is_ok());
        assert!(parse_time("startTime", "tomorrow").is_err());
    }
}
