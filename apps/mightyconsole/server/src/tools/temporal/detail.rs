//! The workflow detail over the gRPC API (spec §9.3, §9.6): describe, history pages, following a
//! run's history, and queries. Plain functions on a [`TemporalClient`], so the lab tests call
//! them directly and the procedures in `mod.rs` stay thin.

use serde_json::{Map, Value, json};
use tonic::{Code, Status};

use super::client::{TemporalClient, status_error};
use super::detail_types::{
    EventCategory, HistoryEvent, WorkflowDetail, WorkflowHistoryInput, WorkflowHistoryOutput,
    WorkflowQueryInput, WorkflowQueryOutput, WorkflowRawEventInput, WorkflowRawEventOutput,
    WorkflowRef,
};
use super::large::{StubAt, cut_bytes, map_len};
use super::payloads::{
    decode_payloads, decode_payloads_at, decode_payloads_keeping, encode_json, payload_encodings,
    to_json_raw,
};
use super::proto::temporal::api::common::v1::{Payloads, WorkflowExecution};
use super::proto::temporal::api::history::v1::HistoryEvent as ProtoEvent;
use super::proto::temporal::api::query::v1::WorkflowQuery;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::{TOOL, decode_token, encode_token, row};
use crate::core::ToolError;

/// The most events in a page, and asked of Temporal at once.
const HISTORY_PAGE: u32 = 1_000;
/// A `history` reply stops at this many bytes of events; the first event always goes (TSK-109).
pub const REPLY_BYTES: usize = 4 * 1024 * 1024;
/// One event's share of a reply or of a followed line. Over it, every payload of the event over
/// 1 KiB is kept on the server as a stub with a 2 KiB preview; still over, its attributes are cut.
pub const EVENT_SHARE: usize = 1024 * 1024;
/// The preview of an event's attributes when they are cut.
pub const CUT_PREVIEW: usize = 2 * 1024;
/// Events asked of Temporal first, before their sizes are known.
pub const FIRST_ASK: u32 = 100;
/// What an event adds to a reply beside its attributes (id, time, type, category, size).
const EVENT_OVERHEAD: usize = 200;

pub(super) fn execution(
    workflow_id: &str,
    run_id: Option<&str>,
) -> Result<WorkflowExecution, ToolError> {
    if workflow_id.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "workflowId",
            "a workflow id is required",
        ));
    }
    Ok(WorkflowExecution {
        workflow_id: workflow_id.to_owned(),
        run_id: run_id.map(str::trim).unwrap_or_default().to_owned(),
    })
}

/// `EVENT_TYPE_WORKFLOW_EXECUTION_STARTED` as `WorkflowExecutionStarted`.
pub fn event_type_name(event_type: i32) -> (String, EventCategory) {
    use super::proto::temporal::api::enums::v1::EventType;
    let Ok(kind) = EventType::try_from(event_type) else {
        return (format!("Unknown{event_type}"), EventCategory::Other);
    };
    let shouty = kind.as_str_name().trim_start_matches("EVENT_TYPE_");
    let name: String = shouty
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            chars
                .next()
                .map(|c| c.to_string() + &chars.as_str().to_ascii_lowercase())
                .unwrap_or_default()
        })
        .collect();
    let category = if shouty.starts_with("WORKFLOW_EXECUTION_UPDATE") {
        EventCategory::Update
    } else if shouty.starts_with("WORKFLOW_EXECUTION_SIGNALED")
        || shouty.contains("SIGNAL_EXTERNAL")
        || shouty.starts_with("EXTERNAL_WORKFLOW_EXECUTION_SIGNALED")
    {
        EventCategory::Signal
    } else if shouty.starts_with("WORKFLOW_TASK") {
        EventCategory::WorkflowTask
    } else if shouty.starts_with("ACTIVITY_TASK") {
        EventCategory::Activity
    } else if shouty.starts_with("TIMER") {
        EventCategory::Timer
    } else if shouty.contains("CHILD_WORKFLOW") {
        EventCategory::ChildWorkflow
    } else if shouty.starts_with("MARKER") {
        EventCategory::Marker
    } else if shouty.starts_with("WORKFLOW_EXECUTION") {
        EventCategory::Workflow
    } else {
        EventCategory::Other
    };
    (name, category)
}

/// Events as the UI reads them, their External Storage references resolved (TSK-103).
pub async fn history_events<'a>(
    client: &TemporalClient,
    namespace: &str,
    events: impl IntoIterator<Item = &'a ProtoEvent>,
) -> Result<Vec<HistoryEvent>, ToolError> {
    let events: Vec<&ProtoEvent> = events.into_iter().collect();
    let mut raws = Value::Array(
        events
            .iter()
            .map(|e| to_json_raw("temporal.api.history.v1.HistoryEvent", *e))
            .collect::<Result<Vec<_>, _>>()?,
    );
    super::extstore::resolve_json(client.external.as_deref(), namespace, &mut raws).await;
    super::codec_client::decode_json(client.payload_codec.as_deref(), namespace, &mut raws).await;
    let Value::Array(raws) = raws else {
        unreachable!("an array stays an array")
    };
    events
        .into_iter()
        .zip(raws)
        .map(|(e, raw)| history_event_from(e, raw, &client.large))
        .collect()
}

/// A message as JSON with its payloads decoded, External Storage references resolved first.
pub async fn to_json_resolved<M: prost::Message>(
    client: &TemporalClient,
    namespace: &str,
    full_name: &str,
    message: &M,
) -> Result<Value, ToolError> {
    let mut value = to_json_raw(full_name, message)?;
    super::extstore::resolve_json(client.external.as_deref(), namespace, &mut value).await;
    super::codec_client::decode_json(client.payload_codec.as_deref(), namespace, &mut value).await;
    decode_payloads_keeping(&mut value, Some(&client.large));
    Ok(value)
}

/// One event as the UI reads it, from its raw JSON (External Storage references already resolved):
/// the envelope typed, the attributes as decoded protobuf JSON, within the event's share.
fn history_event_from(
    event: &ProtoEvent,
    raw: Value,
    large: &super::large::LargePayloads,
) -> Result<HistoryEvent, ToolError> {
    let encodings = payload_encodings(&raw);
    let size = prost::Message::encoded_len(event);
    // Kept to decode again, tighter, when the event comes out over its share.
    let again = (size > EVENT_SHARE / 2).then(|| raw.clone());
    let mut attributes = attributes_of(raw, large, StubAt::LARGE)?;
    if map_len(&attributes) > EVENT_SHARE {
        if let Some(raw) = again {
            attributes = attributes_of(raw, large, StubAt::TIGHT)?;
        }
        let bytes = map_len(&attributes);
        if bytes > EVENT_SHARE {
            let text = serde_json::to_string(&attributes).unwrap_or_default();
            let mut cut = Map::new();
            cut.insert(
                "$cut".into(),
                json!({ "bytes": bytes, "preview": cut_bytes(&text, CUT_PREVIEW) }),
            );
            attributes = cut;
        }
    }
    let (event_type, category) = event_type_name(event.event_type);
    Ok(HistoryEvent {
        event_id: event.event_id,
        event_time: event.event_time.as_ref().and_then(super::rfc3339),
        event_type,
        category,
        attributes,
        encodings: (!encodings.is_empty()).then_some(encodings),
        size: size as u64,
    })
}

/// The decoded attributes of an event's raw JSON: the one `...EventAttributes` member (the oneof).
fn attributes_of(
    raw: Value,
    large: &super::large::LargePayloads,
    at: StubAt,
) -> Result<Map<String, Value>, ToolError> {
    let mut decoded = raw;
    decode_payloads_at(&mut decoded, Some((large, at)));
    let Value::Object(mut json) = decoded else {
        return Err(ToolError::new(
            crate::core::ToolErrorKind::Remote,
            TOOL,
            "a history event is not an object",
        ));
    };
    let key = json.keys().find(|k| k.ends_with("Attributes")).cloned();
    Ok(match key.and_then(|k| json.remove(&k)) {
        Some(Value::Object(attributes)) => attributes,
        _ => Map::new(),
    })
}

/// What an event adds to a reply, about: its attributes' JSON and the envelope.
fn reply_len(event: &HistoryEvent) -> usize {
    map_len(&event.attributes)
        + EVENT_OVERHEAD
        + event
            .encodings
            .as_ref()
            .map_or(0, |e| e.iter().map(|s| s.len() + 3).sum())
}

/// One event of a run with its payloads as stored, found by paging the history from its nearer end.
pub async fn raw_event(
    client: &TemporalClient,
    input: WorkflowRawEventInput,
) -> Result<WorkflowRawEventOutput, ToolError> {
    if input.event_id < 1 {
        return Err(ToolError::invalid(TOOL, "eventId", "1 or more"));
    }
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let execution = execution(&input.workflow_id, input.run_id.as_deref())?;
    // The last event's id says which end is nearer.
    let last = Temporal::new(client, &namespace, execution.clone(), true)
        .fetch(1, &[])
        .await?
        .and_then(|page| page.events.first().map(|e| e.event_id))
        .unwrap_or(0);
    let reverse = input.event_id > last / 2;
    let mut source = Temporal::new(client, &namespace, execution, reverse);
    let mut token = Vec::new();
    let mut ask = HISTORY_PAGE;
    loop {
        let Some(page) = source.fetch(ask, &token).await? else {
            if ask == 1 {
                return Err(too_large_error());
            }
            ask = (ask / 2).max(1);
            continue;
        };
        if let Some(event) = page.events.iter().find(|e| e.event_id == input.event_id) {
            let Value::Object(mut json) =
                to_json_raw("temporal.api.history.v1.HistoryEvent", event)?
            else {
                return Err(ToolError::new(
                    crate::core::ToolErrorKind::Remote,
                    TOOL,
                    "a history event is not an object",
                ));
            };
            let key = json.keys().find(|k| k.ends_with("Attributes")).cloned();
            let attributes = match key.and_then(|k| json.remove(&k)) {
                Some(Value::Object(attributes)) => attributes,
                _ => Map::new(),
            };
            return Ok(WorkflowRawEventOutput { attributes });
        }
        let past = page.events.last().is_some_and(|e| {
            if reverse {
                e.event_id < input.event_id
            } else {
                e.event_id > input.event_id
            }
        });
        if past || page.next.is_empty() {
            return Err(ToolError::not_found(
                TOOL,
                "event",
                format!("no event {} in this run", input.event_id),
            ));
        }
        token = page.next;
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

fn objects(value: Option<Value>) -> Vec<Map<String, Value>> {
    match value {
        Some(Value::Array(items)) => items.into_iter().map(object).collect(),
        _ => Vec::new(),
    }
}

/// `DescribeWorkflowExecution`: the row, the config, pending work, memo and search attributes.
pub async fn describe(
    client: &TemporalClient,
    input: WorkflowRef,
) -> Result<WorkflowDetail, ToolError> {
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .describe_workflow_execution(client.request(
            &namespace,
            ws::DescribeWorkflowExecutionRequest {
                namespace: namespace.clone(),
                execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
            },
        ))
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    let info = response.workflow_execution_info.clone().unwrap_or_default();
    let mut json = object(
        to_json_resolved(
            client,
            &namespace,
            "temporal.api.workflowservice.v1.DescribeWorkflowExecutionResponse",
            &response,
        )
        .await?,
    );
    let mut info_json = json
        .remove("workflowExecutionInfo")
        .map(object)
        .unwrap_or_default();
    let memo = info_json
        .remove("memo")
        .map(object)
        .and_then(|mut m| m.remove("fields"))
        .map(object)
        .unwrap_or_default();
    let search_attributes = info_json
        .remove("searchAttributes")
        .map(object)
        .and_then(|mut m| m.remove("indexedFields"))
        .map(object)
        .unwrap_or_default();
    Ok(WorkflowDetail {
        history_size_bytes: info.history_size_bytes,
        workflow: row(&info),
        execution_config: json
            .remove("executionConfig")
            .map(object)
            .unwrap_or_default(),
        pending_activities: objects(json.remove("pendingActivities")),
        pending_children: objects(json.remove("pendingChildren")),
        pending_workflow_task: json.remove("pendingWorkflowTask").map(object),
        memo,
        search_attributes,
        auto_reset_points: objects(
            info_json
                .remove("autoResetPoints")
                .map(object)
                .and_then(|mut p| p.remove("points")),
        ),
    })
}

// --- Pages by bytes (TSK-109) ----------------------------------------------------------------

/// Where the next page starts: Temporal's token for a page and, when that page was cut, the size
/// it was asked with and the last event sent from it. Opaque to the UI.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct Cursor {
    upstream: Vec<u8>,
    cut: Option<(u32, i64)>,
}

impl Cursor {
    const VERSION: u8 = 1;

    fn encode(&self) -> Option<String> {
        if self.cut.is_none() && self.upstream.is_empty() {
            return None;
        }
        let mut bytes = vec![Self::VERSION];
        match self.cut {
            Some((ask, after)) => {
                bytes.push(1);
                bytes.extend(ask.to_le_bytes());
                bytes.extend(after.to_le_bytes());
            }
            None => bytes.push(0),
        }
        bytes.extend(&self.upstream);
        encode_token(&bytes)
    }

    fn decode(token: Option<&str>) -> Result<Self, ToolError> {
        let bytes = decode_token(token)?;
        if bytes.is_empty() {
            return Ok(Self::default());
        }
        let bad = || ToolError::invalid(TOOL, "nextPageToken", "not a page token of this tool");
        match (bytes.first(), bytes.get(1)) {
            (Some(&Self::VERSION), Some(0)) => Ok(Self {
                upstream: bytes[2..].to_vec(),
                cut: None,
            }),
            (Some(&Self::VERSION), Some(1)) if bytes.len() >= 14 => {
                let ask = u32::from_le_bytes(bytes[2..6].try_into().map_err(|_| bad())?);
                let after = i64::from_le_bytes(bytes[6..14].try_into().map_err(|_| bad())?);
                Ok(Self {
                    upstream: bytes[14..].to_vec(),
                    cut: Some((ask, after)),
                })
            }
            _ => Err(bad()),
        }
    }
}

/// One page as Temporal sent it.
pub(super) struct Upstream {
    pub events: Vec<ProtoEvent>,
    pub next: Vec<u8>,
}

/// Where pages come from: Temporal, or a stand-in in the tests.
pub(super) trait PageSource {
    /// At most `ask` events from `token`; `None` when the answer is too large to read (over the
    /// client's 64 MiB, or the server's own limit), so the caller asks for fewer.
    async fn fetch(&mut self, ask: u32, token: &[u8]) -> Result<Option<Upstream>, ToolError>;
    /// The events as the UI reads them.
    async fn decode(&mut self, events: Vec<&ProtoEvent>) -> Result<Vec<HistoryEvent>, ToolError>;
}

/// The run's history on the Temporal server, oldest or newest first.
struct Temporal<'a> {
    client: &'a TemporalClient,
    namespace: &'a str,
    execution: WorkflowExecution,
    reverse: bool,
}

impl<'a> Temporal<'a> {
    fn new(
        client: &'a TemporalClient,
        namespace: &'a str,
        execution: WorkflowExecution,
        reverse: bool,
    ) -> Self {
        Self {
            client,
            namespace,
            execution,
            reverse,
        }
    }
}

/// Temporal's answer was too large to read, or for the server to send.
fn too_large(status: &Status) -> bool {
    let message = status.message().to_ascii_lowercase();
    matches!(status.code(), Code::OutOfRange | Code::ResourceExhausted)
        && (message.contains("too large")
            || message.contains("larger than max")
            || message.contains("message length"))
}

fn too_large_error() -> ToolError {
    ToolError::new(
        crate::core::ToolErrorKind::Remote,
        TOOL,
        "one event of this history is too large to read (over 64 MiB)",
    )
}

impl PageSource for Temporal<'_> {
    async fn fetch(&mut self, ask: u32, token: &[u8]) -> Result<Option<Upstream>, ToolError> {
        let client = self.client;
        let answer = if self.reverse {
            client
                .service()
                .get_workflow_execution_history_reverse(client.request(
                    self.namespace,
                    ws::GetWorkflowExecutionHistoryReverseRequest {
                        namespace: self.namespace.to_owned(),
                        execution: Some(self.execution.clone()),
                        maximum_page_size: ask as i32,
                        next_page_token: token.to_vec(),
                    },
                ))
                .await
                .map(|r| {
                    let r = r.into_inner();
                    (r.history, r.next_page_token)
                })
        } else {
            client
                .service()
                .get_workflow_execution_history(client.request(
                    self.namespace,
                    ws::GetWorkflowExecutionHistoryRequest {
                        namespace: self.namespace.to_owned(),
                        execution: Some(self.execution.clone()),
                        maximum_page_size: ask as i32,
                        next_page_token: token.to_vec(),
                        ..Default::default()
                    },
                ))
                .await
                .map(|r| {
                    let r = r.into_inner();
                    (r.history, r.next_page_token)
                })
        };
        match answer {
            Ok((history, next)) => Ok(Some(Upstream {
                events: history.unwrap_or_default().events,
                next,
            })),
            Err(status) if too_large(&status) => Ok(None),
            Err(status) => Err(status_error(&client.address, &status)),
        }
    }

    async fn decode(&mut self, events: Vec<&ProtoEvent>) -> Result<Vec<HistoryEvent>, ToolError> {
        history_events(self.client, self.namespace, events).await
    }
}

/// One reply's events from `cursor`: at most `max` events and `budget` bytes (the first event
/// always goes), and where the next reply starts. Temporal is asked for [`FIRST_ASK`] events
/// first, then for as many as the events so far say fit in the rest; a page that goes over is cut
/// and asked for again next time, after the last event sent. Only the events that may fit are
/// decoded.
pub(super) async fn page_by_bytes<S: PageSource>(
    source: &mut S,
    cursor: Cursor,
    max: u32,
    reverse: bool,
    budget: usize,
) -> Result<(Vec<HistoryEvent>, Cursor), ToolError> {
    let mut out: Vec<HistoryEvent> = Vec::new();
    let mut used = 0usize;
    let mut token = cursor.upstream;
    let mut after = cursor.cut.map(|(_, a)| a);
    let mut ask = cursor
        .cut
        .map_or(FIRST_ASK, |(a, _)| a)
        .clamp(1, HISTORY_PAGE)
        .min(max);
    loop {
        let page = loop {
            match source.fetch(ask, &token).await? {
                Some(page) => break page,
                None if ask > 1 => ask = (ask / 2).max(1),
                None => return Err(too_large_error()),
            }
        };
        let fresh: Vec<&ProtoEvent> = page
            .events
            .iter()
            .filter(|e| match after {
                Some(a) if reverse => e.event_id < a,
                Some(a) => e.event_id > a,
                None => true,
            })
            .collect();
        // Decode only what may fit: by count, and by twice the budget left in stored bytes.
        let room = (max as usize).saturating_sub(out.len());
        let left = budget.saturating_sub(used).saturating_mul(2);
        let mut stored = 0usize;
        let mut take = 0usize;
        for event in fresh.iter().take(room) {
            let size = prost::Message::encoded_len(*event);
            if take > 0 && stored + size > left {
                break;
            }
            stored += size;
            take += 1;
        }
        let whole = take == fresh.len();
        let mut last_sent: Option<i64> = None;
        let mut over = false;
        for event in source.decode(fresh[..take].to_vec()).await? {
            let size = reply_len(&event);
            if !out.is_empty() && used + size > budget {
                over = true;
                break;
            }
            used += size;
            last_sent = Some(event.event_id);
            out.push(event);
        }
        if over || !whole {
            // The rest of this page goes next time, after the last event sent from it.
            let cut = last_sent.or(after).map(|a| (ask, a));
            return Ok((
                out,
                Cursor {
                    upstream: token,
                    cut,
                },
            ));
        }
        after = None;
        if page.next.is_empty() {
            return Ok((out, Cursor::default()));
        }
        token = page.next;
        let next = Cursor {
            upstream: token.clone(),
            cut: None,
        };
        if out.len() >= max as usize {
            return Ok((out, next));
        }
        let average = (used / out.len().max(1)).max(1);
        let left = budget.saturating_sub(used);
        if left < average {
            return Ok((out, next));
        }
        ask = u32::try_from(left / average)
            .unwrap_or(u32::MAX)
            .clamp(1, max - out.len() as u32)
            .min(HISTORY_PAGE);
    }
}

/// One page of a run's history, oldest first or (`reverse`) newest first, at most 4 MiB.
pub async fn history(
    client: &TemporalClient,
    input: WorkflowHistoryInput,
) -> Result<WorkflowHistoryOutput, ToolError> {
    let max = input.page_size.unwrap_or(HISTORY_PAGE);
    if !(1..=HISTORY_PAGE).contains(&max) {
        return Err(ToolError::invalid(TOOL, "pageSize", "1 to 1000"));
    }
    let reverse = input.reverse.unwrap_or(false);
    let cursor = Cursor::decode(input.next_page_token.as_deref())?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let execution = execution(&input.workflow_id, input.run_id.as_deref())?;
    let mut source = Temporal::new(client, &namespace, execution, reverse);
    let (events, next) = page_by_bytes(&mut source, cursor, max, reverse, REPLY_BYTES).await?;
    Ok(WorkflowHistoryOutput {
        events,
        next_page_token: next.encode(),
    })
}

/// The whole history, oldest first, a page at a time as `temporal workflow show --output json`
/// writes its events, for `downloadHistory`; with `decoded`, every payload decoded in full. Pages
/// of up to 1,000 events (fewer when Temporal's answer is too large), one page in memory at once.
pub struct HistoryDownload<'a> {
    source: Temporal<'a>,
    token: Vec<u8>,
    ask: u32,
    decoded: bool,
    done: bool,
}

impl<'a> HistoryDownload<'a> {
    pub fn new(
        client: &'a TemporalClient,
        namespace: &'a str,
        execution: WorkflowExecution,
        decoded: bool,
    ) -> Self {
        Self {
            source: Temporal::new(client, namespace, execution, false),
            token: Vec::new(),
            ask: HISTORY_PAGE,
            decoded,
            done: false,
        }
    }

    /// The next page's events as JSON values; `None` after the last.
    pub async fn next_page(&mut self) -> Result<Option<Vec<Value>>, ToolError> {
        if self.done {
            return Ok(None);
        }
        let page = loop {
            match self.source.fetch(self.ask, &self.token).await? {
                Some(page) => break page,
                None if self.ask > 1 => self.ask = (self.ask / 2).max(1),
                None => return Err(too_large_error()),
            }
        };
        let client = self.source.client;
        let namespace = self.source.namespace;
        let mut values = Vec::with_capacity(page.events.len());
        for event in &page.events {
            let mut value = to_json_raw("temporal.api.history.v1.HistoryEvent", event)?;
            if self.decoded {
                super::extstore::resolve_json(client.external.as_deref(), namespace, &mut value)
                    .await;
                super::codec_client::decode_json(
                    client.payload_codec.as_deref(),
                    namespace,
                    &mut value,
                )
                .await;
                decode_payloads(&mut value);
            }
            values.push(value);
        }
        self.done = page.next.is_empty();
        self.token = page.next;
        Ok(Some(values))
    }
}

/// One long-poll step of following a run: the events after `after`, and the token for the next
/// step. The server holds the call until something happens (about 20 s at most) and hands back a
/// token as long as the run is open; an empty token means the run is closed and everything was
/// sent. (Without the long poll an open run also comes back with an empty token, which is why every
/// step waits, the first included: the first returns the history so far at once.)
pub struct FollowStep {
    pub events: Vec<HistoryEvent>,
    pub token: Vec<u8>,
}

pub async fn follow_step(
    client: &TemporalClient,
    namespace: &str,
    execution: WorkflowExecution,
    token: Vec<u8>,
    after: i64,
) -> Result<FollowStep, ToolError> {
    let mut ask = HISTORY_PAGE;
    let response = loop {
        let mut request = client.request(
            namespace,
            ws::GetWorkflowExecutionHistoryRequest {
                namespace: namespace.to_owned(),
                execution: Some(execution.clone()),
                maximum_page_size: ask as i32,
                next_page_token: token.clone(),
                wait_new_event: true,
                ..Default::default()
            },
        );
        // The server holds a waiting call for up to ~20 s; give it room.
        request.set_timeout(std::time::Duration::from_secs(60));
        match client
            .service()
            .get_workflow_execution_history(request)
            .await
        {
            Ok(response) => break response.into_inner(),
            // A page too large to read (long histories of big events, TSK-109): ask for fewer.
            Err(status) if too_large(&status) && ask > 1 => ask = (ask / 2).max(1),
            Err(status) if too_large(&status) => return Err(too_large_error()),
            Err(status) => return Err(status_error(&client.address, &status)),
        }
    };
    let history = response.history.unwrap_or_default();
    let events = history_events(
        client,
        namespace,
        history.events.iter().filter(|e| e.event_id > after),
    )
    .await?;
    Ok(FollowStep {
        events,
        token: response.next_page_token,
    })
}

/// A query on a running workflow (`QueryWorkflow`), arguments as `json/plain` payloads.
pub async fn query(
    client: &TemporalClient,
    input: WorkflowQueryInput,
) -> Result<WorkflowQueryOutput, ToolError> {
    if input.query_type.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "queryType",
            "a query type is required",
        ));
    }
    let args = input
        .args
        .unwrap_or_default()
        .iter()
        .map(encode_json)
        .collect::<Result<Vec<_>, _>>()?;
    let namespace = client.namespace_or_default(input.namespace.as_deref());
    let response = client
        .service()
        .query_workflow(
            client.request(
                &namespace,
                ws::QueryWorkflowRequest {
                    namespace: namespace.clone(),
                    execution: Some(execution(&input.workflow_id, input.run_id.as_deref())?),
                    query: Some(WorkflowQuery {
                        query_type: input.query_type.trim().to_owned(),
                        query_args: super::extstore::offload(
                            client,
                            &namespace,
                            (!args.is_empty()).then_some(Payloads { payloads: args }),
                        )
                        .await?,
                        header: None,
                    }),
                    ..Default::default()
                },
            ),
        )
        .await
        .map_err(|s| status_error(&client.address, &s))?
        .into_inner();
    if response.query_rejected.is_some() {
        return Err(ToolError::new(
            crate::core::ToolErrorKind::Conflict,
            TOOL,
            "the workflow is not running, so the query was rejected",
        ));
    }
    let mut result = to_json_resolved(
        client,
        &namespace,
        "temporal.api.common.v1.Payloads",
        &response.query_result.unwrap_or_default(),
    )
    .await?;
    // `Payloads` came out as an array; one result is the value itself.
    if let Value::Array(items) = &mut result
        && items.len() == 1
    {
        result = items.remove(0);
    }
    Ok(WorkflowQueryOutput { result })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::super::proto::temporal::api::common::v1::Payload;
    use super::super::proto::temporal::api::enums::v1::EventType;
    use super::super::proto::temporal::api::failure::v1::Failure;
    use super::super::proto::temporal::api::history::v1::history_event::Attributes;
    use super::super::proto::temporal::api::history::v1::{
        ActivityTaskFailedEventAttributes, WorkflowExecutionSignaledEventAttributes,
    };
    use super::*;

    fn payload(text_bytes: usize) -> Payload {
        Payload {
            metadata: HashMap::from([("encoding".to_owned(), b"json/plain".to_vec())]),
            data: format!("\"{}\"", "x".repeat(text_bytes)).into_bytes(),
            ..Default::default()
        }
    }

    /// A signal carrying `payloads` payloads of `bytes` each.
    fn signal(id: i64, payloads: usize, bytes: usize) -> ProtoEvent {
        ProtoEvent {
            event_id: id,
            event_type: EventType::WorkflowExecutionSignaled as i32,
            attributes: Some(Attributes::WorkflowExecutionSignaledEventAttributes(
                WorkflowExecutionSignaledEventAttributes {
                    signal_name: "s".into(),
                    input: Some(Payloads {
                        payloads: (0..payloads).map(|_| payload(bytes)).collect(),
                    }),
                    ..Default::default()
                },
            )),
            ..Default::default()
        }
    }

    /// A history in memory: pages of `ask` events from a position, oldest or newest first, and an
    /// answer over `max_answer` stored bytes is too large to read.
    struct Fake {
        events: Vec<ProtoEvent>,
        reverse: bool,
        max_answer: usize,
        asks: Vec<u32>,
        decoded: usize,
    }

    impl Fake {
        fn new(events: Vec<ProtoEvent>, reverse: bool) -> Self {
            Self {
                events,
                reverse,
                max_answer: usize::MAX,
                asks: Vec::new(),
                decoded: 0,
            }
        }
    }

    impl PageSource for Fake {
        async fn fetch(&mut self, ask: u32, token: &[u8]) -> Result<Option<Upstream>, ToolError> {
            self.asks.push(ask);
            let at = if token.is_empty() {
                0
            } else {
                usize::from_le_bytes(token.try_into().unwrap())
            };
            let ordered: Vec<&ProtoEvent> = if self.reverse {
                self.events.iter().rev().collect()
            } else {
                self.events.iter().collect()
            };
            let end = (at + ask as usize).min(ordered.len());
            let events: Vec<ProtoEvent> = ordered[at..end].iter().map(|e| (*e).clone()).collect();
            let stored: usize = events.iter().map(prost::Message::encoded_len).sum();
            if stored > self.max_answer {
                return Ok(None);
            }
            let next = if end < ordered.len() {
                end.to_le_bytes().to_vec()
            } else {
                Vec::new()
            };
            Ok(Some(Upstream { events, next }))
        }

        async fn decode(
            &mut self,
            events: Vec<&ProtoEvent>,
        ) -> Result<Vec<HistoryEvent>, ToolError> {
            self.decoded += events.len();
            let large = super::super::large::LargePayloads::default();
            events
                .into_iter()
                .map(|e| {
                    history_event_from(
                        e,
                        to_json_raw("temporal.api.history.v1.HistoryEvent", e)?,
                        &large,
                    )
                })
                .collect()
        }
    }

    /// Every reply of a history from the start, and how big each was.
    async fn all_pages(fake: &mut Fake, max: u32, budget: usize) -> Vec<(Vec<i64>, usize)> {
        let mut cursor = Cursor::default();
        let mut pages = Vec::new();
        loop {
            let reverse = fake.reverse;
            let (events, next) = page_by_bytes(fake, cursor, max, reverse, budget)
                .await
                .unwrap();
            let bytes = events.iter().map(reply_len).sum();
            pages.push((events.iter().map(|e| e.event_id).collect(), bytes));
            // The token travels as text through the UI.
            match next.encode() {
                Some(token) => cursor = Cursor::decode(Some(&token)).unwrap(),
                None => return pages,
            }
            assert!(pages.len() < 10_000, "the pages never end");
        }
    }

    #[tokio::test]
    async fn pages_stop_at_the_budget_and_join_without_gaps_or_repeats() {
        for reverse in [false, true] {
            // 300 events of about 50 KiB: 15 MiB, a frame's worth in one page of 1,000.
            let events: Vec<ProtoEvent> = (1..=300).map(|id| signal(id, 1, 50 * 1024)).collect();
            let mut fake = Fake::new(events, reverse);
            let pages = all_pages(&mut fake, 1_000, REPLY_BYTES).await;
            assert!(pages.len() >= 4, "{} pages", pages.len());
            for (_, bytes) in &pages {
                assert!(*bytes <= REPLY_BYTES, "a page of {bytes} bytes");
            }
            let ids: Vec<i64> = pages.iter().flat_map(|(ids, _)| ids.clone()).collect();
            let mut want: Vec<i64> = (1..=300).collect();
            if reverse {
                want.reverse();
            }
            assert_eq!(ids, want, "reverse {reverse}");
        }
    }

    #[tokio::test]
    async fn a_page_that_goes_over_is_cut_and_resumed_after_the_last_event_sent() {
        // 150 small events, then big ones: the ask from the small ones' average overshoots.
        let mut events: Vec<ProtoEvent> = (1..=150).map(|id| signal(id, 1, 100)).collect();
        events.extend((151..=400).map(|id| signal(id, 1, 60 * 1024)));
        let mut fake = Fake::new(events, false);
        let pages = all_pages(&mut fake, 1_000, REPLY_BYTES).await;
        let ids: Vec<i64> = pages.iter().flat_map(|(ids, _)| ids.clone()).collect();
        assert_eq!(ids, (1..=400).collect::<Vec<i64>>());
        for (_, bytes) in &pages {
            assert!(*bytes <= REPLY_BYTES);
        }
        // Decoding is limited to what may fit: never more than twice what was sent.
        assert!(fake.decoded <= 2 * 400, "{} decoded", fake.decoded);
    }

    #[tokio::test]
    async fn the_first_event_always_goes_and_the_count_is_a_maximum() {
        let events: Vec<ProtoEvent> = (1..=5).map(|id| signal(id, 1, 900 * 1024)).collect();
        let mut fake = Fake::new(events, false);
        // A budget smaller than one event still sends one event a page.
        let pages = all_pages(&mut fake, 1_000, 1024).await;
        assert_eq!(pages.len(), 5);
        assert!(pages.iter().all(|(ids, _)| ids.len() == 1));
        let events: Vec<ProtoEvent> = (1..=25).map(|id| signal(id, 1, 10)).collect();
        let mut fake = Fake::new(events, false);
        let pages = all_pages(&mut fake, 10, REPLY_BYTES).await;
        let sizes: Vec<usize> = pages.iter().map(|(ids, _)| ids.len()).collect();
        assert_eq!(sizes, vec![10, 10, 5]);
    }

    #[tokio::test]
    async fn an_answer_too_large_to_read_is_asked_again_for_fewer() {
        let events: Vec<ProtoEvent> = (1..=200).map(|id| signal(id, 1, 30 * 1024)).collect();
        let mut fake = Fake::new(events, false);
        // Temporal's answer may not be over 1 MiB of stored events here.
        fake.max_answer = 1024 * 1024;
        let pages = all_pages(&mut fake, 1_000, REPLY_BYTES).await;
        let ids: Vec<i64> = pages.iter().flat_map(|(ids, _)| ids.clone()).collect();
        assert_eq!(ids, (1..=200).collect::<Vec<i64>>());
        assert!(
            fake.asks.windows(2).any(|w| w[1] == w[0] / 2),
            "{:?}",
            fake.asks
        );
        // One event over the limit cannot be read at all, and says so.
        let mut fake = Fake::new(vec![signal(1, 1, 2 * 1024 * 1024)], false);
        fake.max_answer = 1024 * 1024;
        let error = page_by_bytes(&mut fake, Cursor::default(), 1_000, false, REPLY_BYTES)
            .await
            .unwrap_err();
        assert!(error.message.contains("too large"), "{}", error.message);
    }

    #[test]
    fn cursors_round_trip_and_reject_other_tokens() {
        let cursors = [
            Cursor {
                upstream: b"abc".to_vec(),
                cut: None,
            },
            Cursor {
                upstream: Vec::new(),
                cut: Some((100, 42)),
            },
            Cursor {
                upstream: b"next".to_vec(),
                cut: Some((7, -1)),
            },
        ];
        for cursor in cursors {
            let token = cursor.encode().unwrap();
            assert_eq!(Cursor::decode(Some(&token)).unwrap(), cursor);
        }
        assert_eq!(Cursor::default().encode(), None);
        assert_eq!(Cursor::decode(None).unwrap(), Cursor::default());
        // A token of the old form (Temporal's bytes as they were) is refused, not misread.
        let old = encode_token(b"\x0a\x02ab").unwrap();
        assert!(Cursor::decode(Some(&old)).is_err());
    }

    #[test]
    fn an_event_over_its_share_has_its_payloads_kept_on_the_server() {
        let large = super::super::large::LargePayloads::default();
        // 20 payloads of 60 KiB: each under the 64 KiB of a stub, together 1.2 MiB.
        let event = signal(9, 20, 60 * 1024);
        let raw = to_json_raw("temporal.api.history.v1.HistoryEvent", &event).unwrap();
        let out = history_event_from(&event, raw, &large).unwrap();
        assert!(map_len(&out.attributes) <= EVENT_SHARE);
        let input = out.attributes["input"].as_array().unwrap();
        assert_eq!(input.len(), 20);
        for stub in input {
            let stub = &stub["$large"];
            assert!(stub["preview"].as_str().unwrap().len() <= 2 * 1024);
            assert_eq!(stub["decodedBytes"].as_u64(), Some(60 * 1024 + 2));
        }
        // A small event is as it was.
        let small = signal(10, 2, 100);
        let raw = to_json_raw("temporal.api.history.v1.HistoryEvent", &small).unwrap();
        let out = history_event_from(&small, raw, &large).unwrap();
        assert_eq!(out.attributes["input"][0].as_str().unwrap().len(), 100);
    }

    #[test]
    fn an_event_still_over_its_share_is_cut_with_a_preview() {
        let large = super::super::large::LargePayloads::default();
        let event = ProtoEvent {
            event_id: 3,
            event_type: EventType::ActivityTaskFailed as i32,
            attributes: Some(Attributes::ActivityTaskFailedEventAttributes(
                ActivityTaskFailedEventAttributes {
                    failure: Some(Failure {
                        message: "m".repeat(1536 * 1024),
                        ..Default::default()
                    }),
                    ..Default::default()
                },
            )),
            ..Default::default()
        };
        let raw = to_json_raw("temporal.api.history.v1.HistoryEvent", &event).unwrap();
        let out = history_event_from(&event, raw, &large).unwrap();
        let cut = &out.attributes["$cut"];
        assert!(cut["bytes"].as_u64().unwrap() > EVENT_SHARE as u64);
        assert!(cut["preview"].as_str().unwrap().len() <= CUT_PREVIEW);
        assert_eq!(out.event_type, "ActivityTaskFailed");
    }
}
