//! JetStream streams and consumers (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 2).
//!
//! - `nats.js.streams.*`: list, info (with messages per subject when asked), create, update,
//!   purge (all, a subject, keep the newest n, below a sequence), delete; `browse` reads a stream
//!   through an ordered ephemeral consumer (no acks, inactive threshold 30 s) as a pull source of
//!   the messaging core, and stops at the last sequence seen at the start unless it follows;
//!   `getMessage` is one whole message (direct get when the stream allows it).
//! - `nats.js.consumers.*`: list, info, create (pull or push, durable or ephemeral), delete.
//!
//! The JetStream API is called directly (`$JS.API.STREAM.*`, `$JS.API.CONSUMER.*`) so every call
//! answers the server's own error the same way: `NotFound`, `Conflict` when a stream or consumer
//! exists, `Invalid` with the field the server's description names, `Remote` otherwise.
//! Updates are applied on top of the stream's current configuration, so settings this screen does
//! not show (sources, republish, metadata, placement) are kept as they are.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx, RegistryError, Router, rpc};
use async_nats::jetstream::consumer::{self, AckPolicy, DeliverPolicy, ReplayPolicy};
use async_nats::jetstream::stream::{
    self, Compression, DiscardPolicy, RetentionPolicy, StorageType,
};
use futures_util::{FutureExt as _, StreamExt as _};
use message_codecs::filter::Filter;
use message_codecs::{DecodeOptions, Message, Target, TimestampKind};
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;
use ts_rs::TS;

use super::client::{NatsClient, headers_of, remote, subscribe_subject};
use super::{TOOL, handle};
use crate::core::messaging::decode_row;
use crate::core::messaging::record::MessageRecord;
use crate::core::messaging::tail::{self, BATCH_ROWS, Feed, PullSource, TailRequest, TailSummary};
use crate::core::{Empty, Hub, RemoteError, ToolError, ToolErrorKind, ToolResult};

/// Subjects a stream may list.
pub const MAX_STREAM_SUBJECTS: usize = 64;
/// The busiest subjects `info` returns, at most.
pub const SUBJECT_COUNTS: usize = 20;
/// Replicas a stream or consumer may ask for.
pub const MAX_REPLICAS: u32 = 5;
/// A non-durable consumer's inactive threshold when the form gives none.
pub const EPHEMERAL_INACTIVE: Duration = Duration::from_secs(300);

// ---- Wire types: streams ---------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsStorage {
    #[default]
    File,
    Memory,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsRetention {
    #[default]
    Limits,
    Interest,
    WorkQueue,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsDiscard {
    #[default]
    Old,
    New,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsCompression {
    #[default]
    None,
    S2,
}

/// A stream this one mirrors or sources from (read only here: spec §6.6, "later").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamSource {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_subject: Option<String>,
    /// The other side's JetStream API prefix, for a source in another account or domain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub external_api: Option<String>,
}

/// A stream's configuration as the form edits it (spec §6.3, Stream form). Limits are absent
/// when there is none. `sealed`, `mirror` and `sources` are read only: `update` keeps the
/// server's values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamConfig {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub storage: NatsStorage,
    pub retention: NatsRetention,
    pub discard: NatsDiscard,
    /// With `discard: new`: the per-subject limit refuses new messages too.
    pub discard_new_per_subject: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_messages: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_bytes: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_age_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_message_size: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_messages_per_subject: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_consumers: Option<i32>,
    pub replicas: u32,
    /// The server's default (2 minutes) when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub duplicate_window_ms: Option<u64>,
    pub allow_direct: bool,
    pub allow_rollup: bool,
    pub deny_delete: bool,
    pub deny_purge: bool,
    pub compression: NatsCompression,
    pub sealed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mirror: Option<NatsStreamSource>,
    pub sources: Vec<NatsStreamSource>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamState {
    pub messages: u64,
    pub bytes: u64,
    pub first_sequence: u64,
    /// Microseconds since the epoch; absent for an empty stream.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub first_us: Option<i64>,
    pub last_sequence: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_us: Option<i64>,
    pub consumers: u64,
    pub subjects: u64,
    /// Messages deleted inside the range (interior gaps).
    pub deleted: u64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsPeer {
    pub name: String,
    pub current: bool,
    pub offline: bool,
    /// Operations behind the leader.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub lag: Option<u64>,
    /// Since it was last heard from, in milliseconds.
    pub active_ms: u64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsClusterInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub leader: Option<String>,
    /// The other peers (the leader is not one of them).
    pub replicas: Vec<NatsPeer>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsSourceState {
    pub name: String,
    /// Messages behind the origin.
    pub lag: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub active_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_subject: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubjectCount {
    pub subject: String,
    pub messages: u64,
}

/// A stream's configuration and state (spec §6.5, `StreamInfo`).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamInfo {
    pub config: NatsStreamConfig,
    pub created_us: i64,
    pub state: NatsStreamState,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cluster: Option<NatsClusterInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mirror: Option<NatsSourceState>,
    pub sources: Vec<NatsSourceState>,
    /// The busiest subjects, at most 20, when `subjectCounts` was asked; empty otherwise.
    pub subject_counts: Vec<NatsSubjectCount>,
}

/// One line of the stream list (spec §6.5, `StreamSummary`).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamSummary {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub subjects: Vec<String>,
    pub messages: u64,
    pub bytes: u64,
    pub consumers: u64,
    pub created_us: i64,
    pub storage: NatsStorage,
    pub retention: NatsRetention,
    pub sealed: bool,
    /// The stream it mirrors.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mirror: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamsListInput {
    pub conn_id: String,
    /// Only streams that take this subject.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subject: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamInfoInput {
    pub conn_id: String,
    pub stream: String,
    /// Also count the messages per subject (the busiest 20).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subject_counts: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamConfigInput {
    pub conn_id: String,
    pub config: NatsStreamConfig,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamInput {
    pub conn_id: String,
    pub stream: String,
}

/// What a purge removes: everything, one subject, all but the newest `keep`, or every message
/// below `upToSequence` (that one stays). `subject` combines with either of the others.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamPurgeInput {
    pub conn_id: String,
    pub stream: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subject: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub keep: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub up_to_sequence: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsStreamPurgeOutput {
    pub purged: u64,
}

/// Where a browse starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsBrowseFrom {
    First,
    /// The last `n` sequences of the stream.
    Last,
    Sequence,
    Time,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsBrowseStart {
    pub from: NatsBrowseFrom,
    /// `last`: how many sequences back (1 when absent).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub n: Option<u64>,
    /// `sequence`: the first sequence read.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sequence: Option<u64>,
    /// `time`: the first message stored at or after it, microseconds since the epoch.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time_us: Option<i64>,
}

/// Where a browse stops (the last message read is the one at or before it).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsBrowseEnd {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sequence: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub time_us: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsBrowseInput {
    pub conn_id: String,
    pub stream_id: String,
    pub stream: String,
    pub start: NatsBrowseStart,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub end: Option<NatsBrowseEnd>,
    /// Only messages on this subject or pattern.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub subject: Option<String>,
    /// Keep reading new messages after the last one there was at the start.
    pub follow: bool,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<Filter>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_scan: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsGetMessageInput {
    pub conn_id: String,
    pub stream: String,
    pub sequence: u64,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
}

// ---- Wire types: consumers -------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsDeliverFrom {
    #[default]
    All,
    Last,
    New,
    ByStartSequence,
    ByStartTime,
    LastPerSubject,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsAckPolicy {
    #[default]
    Explicit,
    All,
    None,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsReplayPolicy {
    #[default]
    Instant,
    Original,
}

/// A consumer's configuration (spec §6.3, Consumer). A push consumer has a `deliverSubject`;
/// without one it is a pull consumer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerConfig {
    pub name: String,
    /// Durable consumers stay; the others go after `inactiveThresholdMs` without a client.
    pub durable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub filter_subjects: Vec<String>,
    pub deliver: NatsDeliverFrom,
    /// `byStartSequence`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_sequence: Option<u64>,
    /// `byStartTime`, microseconds since the epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub start_time_us: Option<i64>,
    pub ack_policy: NatsAckPolicy,
    pub ack_wait_ms: u64,
    /// Absent: no limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_deliver: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_ack_pending: Option<i64>,
    /// Pull: pull requests that may wait at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_waiting: Option<i64>,
    pub replay: NatsReplayPolicy,
    /// Push: where the server sends the messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deliver_subject: Option<String>,
    /// Push: the queue group that shares them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub deliver_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub inactive_threshold_ms: Option<u64>,
    pub headers_only: bool,
    /// The stream's replica count when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub replicas: Option<u32>,
}

/// A consumer sequence and the stream sequence it stands for.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsSequencePair {
    pub consumer: u64,
    pub stream: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_active_us: Option<i64>,
}

/// A consumer's configuration and state (spec §6.5, `ConsumerInfo`).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerInfo {
    pub stream: String,
    pub name: String,
    pub created_us: i64,
    pub config: NatsConsumerConfig,
    /// The last message delivered.
    pub delivered: NatsSequencePair,
    /// Every message up to here is acknowledged.
    pub ack_floor: NatsSequencePair,
    /// Messages not delivered yet.
    pub num_pending: u64,
    /// Delivered and not acknowledged.
    pub num_ack_pending: u64,
    pub num_redelivered: u64,
    /// Pull requests waiting.
    pub num_waiting: u64,
    /// Push: a client listens on the deliver subject.
    pub push_bound: bool,
    pub paused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cluster: Option<NatsClusterInfo>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerInput {
    pub conn_id: String,
    pub stream: String,
    pub consumer: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConsumerCreateInput {
    pub conn_id: String,
    pub stream: String,
    pub config: NatsConsumerConfig,
}

// ---- The JetStream API -----------------------------------------------------------------------

/// The error a JetStream API call answers with.
#[derive(Debug, Clone, Default, Deserialize)]
struct ApiError {
    #[serde(default)]
    code: u16,
    #[serde(default)]
    err_code: u32,
    #[serde(default)]
    description: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ApiResponse<T> {
    Err { error: ApiError },
    Ok(T),
}

/// Server error codes this module answers specially (nats-server `server/errors.json`).
mod code {
    pub const INSUFFICIENT_RESOURCES: u32 = 10023;
    pub const CONSUMER_NOT_FOUND: u32 = 10014;
    pub const CONSUMER_NAME_EXIST: u32 = 10013;
    pub const MESSAGE_NOT_FOUND: u32 = 10037;
    pub const STREAM_INVALID_CONFIG: u32 = 10052;
    pub const STREAM_NAME_EXIST: u32 = 10058;
    pub const STREAM_NOT_FOUND: u32 = 10059;
    pub const STREAM_SUBJECT_OVERLAP: u32 = 10065;
    pub const JETSTREAM_NOT_ENABLED_FOR_ACCOUNT: u32 = 10039;
    pub const JETSTREAM_NOT_ENABLED: u32 = 10076;
    pub const CONSUMER_ALREADY_EXISTS: u32 = 10148;
}

/// The form field a server's description is about, when it names one.
fn field_of(description: &str) -> Option<&'static str> {
    let d = description.to_ascii_lowercase();
    let rules: &[(&[&str], &str)] = &[
        (&["subject"], "subjects"),
        (&["replica", "peer"], "replicas"),
        (
            &["max bytes", "max_bytes", "storage resources", "bytes"],
            "maxBytes",
        ),
        (&["max age", "max_age"], "maxAgeMs"),
        (&["duplicate"], "duplicateWindowMs"),
        (&["message size", "max_msg_size"], "maxMessageSize"),
        (
            &["per subject", "max_msgs_per_subject"],
            "maxMessagesPerSubject",
        ),
        (&["max messages", "max_msgs"], "maxMessages"),
        (&["max consumers"], "maxConsumers"),
        (&["retention"], "retention"),
        (&["storage type", "storage"], "storage"),
        (&["discard"], "discard"),
        (&["compression"], "compression"),
        (&["deny delete"], "denyDelete"),
        (&["deny purge"], "denyPurge"),
        (&["direct"], "allowDirect"),
        (&["rollup"], "allowRollup"),
        (&["name"], "name"),
    ];
    rules
        .iter()
        .find(|(words, _)| words.iter().any(|w| d.contains(w)))
        .map(|(_, field)| *field)
}

fn api_error(what: &str, e: ApiError) -> ToolError {
    let remote = RemoteError {
        code: e.err_code.to_string(),
        name: None,
        detail: Some(e.description.clone()),
    };
    let text = if e.description.is_empty() {
        format!("{what}: the server answered {}", e.code)
    } else {
        e.description.clone()
    };
    let mut out = match e.err_code {
        code::STREAM_NOT_FOUND => ToolError::not_found(TOOL, "stream", text),
        code::CONSUMER_NOT_FOUND => ToolError::not_found(TOOL, "consumer", text),
        code::MESSAGE_NOT_FOUND => ToolError::not_found(TOOL, "message", text),
        code::STREAM_NAME_EXIST | code::CONSUMER_NAME_EXIST | code::CONSUMER_ALREADY_EXISTS => {
            let mut c = ToolError::new(ToolErrorKind::Conflict, TOOL, text);
            c.field = Some("name".into());
            c
        }
        code::STREAM_SUBJECT_OVERLAP => ToolError::invalid(TOOL, "subjects", text),
        code::INSUFFICIENT_RESOURCES => {
            let field = field_of(&e.description).unwrap_or("maxBytes");
            ToolError::invalid(TOOL, field, text)
        }
        code::JETSTREAM_NOT_ENABLED | code::JETSTREAM_NOT_ENABLED_FOR_ACCOUNT => {
            ToolError::new(ToolErrorKind::Remote, TOOL, text)
        }
        _ if e.code == 400 || e.err_code == code::STREAM_INVALID_CONFIG => {
            match field_of(&e.description) {
                Some(field) => ToolError::invalid(TOOL, field, text),
                None => ToolError::new(ToolErrorKind::Invalid, TOOL, text),
            }
        }
        _ if e.code == 404 => ToolError::new(ToolErrorKind::NotFound, TOOL, text),
        _ => ToolError::new(ToolErrorKind::Remote, TOOL, text),
    };
    out.remote = Some(remote);
    out
}

/// One JetStream API call: `$JS.API.<subject>` (or the profile's prefix or domain).
pub(super) async fn api<T: DeserializeOwned, B: Serialize + ?Sized>(
    c: &NatsClient,
    what: &str,
    subject: String,
    body: &B,
) -> Result<T, ToolError> {
    use async_nats::jetstream::context::RequestErrorKind;
    let answer: ApiResponse<T> =
        c.jetstream
            .request(subject, body)
            .await
            .map_err(|e| {
                match e.kind() {
            RequestErrorKind::NoResponders => ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                "JetStream did not answer: it is not enabled on this server or for this account",
            )
            .with_remote(RemoteError {
                code: "no_responders".into(),
                name: None,
                detail: Some(e.to_string()),
            }),
            RequestErrorKind::TimedOut => {
                ToolError::new(ToolErrorKind::Remote, TOOL, format!("{what}: timed out"))
                    .with_remote(RemoteError {
                        code: "timeout".into(),
                        name: None,
                        detail: Some(e.to_string()),
                    })
                    .retryable(true)
            }
            RequestErrorKind::InvalidSubject => {
                ToolError::invalid(TOOL, "name", format!("{what}: not a valid name"))
            }
            RequestErrorKind::Other => remote(what, e),
        }
            })?;
    match answer {
        ApiResponse::Ok(v) => Ok(v),
        ApiResponse::Err { error } => Err(api_error(what, error)),
    }
}

// ---- Conversions -----------------------------------------------------------------------------

pub(super) fn us(t: OffsetDateTime) -> i64 {
    i64::try_from(t.unix_timestamp_nanos() / 1000).unwrap_or(i64::MAX)
}

/// A JetStream time, `None` for the zero time an empty stream reports.
pub(super) fn us_opt(t: OffsetDateTime) -> Option<i64> {
    let v = us(t);
    (v > 0).then_some(v)
}

pub(super) fn time_of(field: &str, micros: i64) -> Result<OffsetDateTime, ToolError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(micros) * 1000)
        .map_err(|_| ToolError::invalid(TOOL, field, "not a valid time"))
}

pub(super) fn ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// A positive limit, `None` for the server's "no limit" (`-1` or `0`).
pub(super) fn limit<T: Into<i64> + Copy>(v: T) -> Option<T> {
    (v.into() > 0).then_some(v)
}

fn source_of(s: &stream::Source) -> NatsStreamSource {
    NatsStreamSource {
        name: s.name.clone(),
        filter_subject: s.filter_subject.clone().filter(|f| !f.is_empty()),
        external_api: s.external.as_ref().map(|e| e.api_prefix.clone()),
    }
}

impl From<&stream::Config> for NatsStreamConfig {
    fn from(c: &stream::Config) -> Self {
        NatsStreamConfig {
            name: c.name.clone(),
            description: c.description.clone().filter(|d| !d.is_empty()),
            subjects: c.subjects.clone(),
            storage: match c.storage {
                StorageType::File => NatsStorage::File,
                StorageType::Memory => NatsStorage::Memory,
            },
            retention: match c.retention {
                RetentionPolicy::Limits => NatsRetention::Limits,
                RetentionPolicy::Interest => NatsRetention::Interest,
                RetentionPolicy::WorkQueue => NatsRetention::WorkQueue,
            },
            discard: match c.discard {
                DiscardPolicy::Old => NatsDiscard::Old,
                DiscardPolicy::New => NatsDiscard::New,
            },
            discard_new_per_subject: c.discard_new_per_subject,
            max_messages: limit(c.max_messages),
            max_bytes: limit(c.max_bytes),
            max_age_ms: (!c.max_age.is_zero()).then(|| ms(c.max_age)),
            max_message_size: limit(c.max_message_size),
            max_messages_per_subject: limit(c.max_messages_per_subject),
            max_consumers: limit(c.max_consumers),
            replicas: u32::try_from(c.num_replicas.max(1)).unwrap_or(1),
            duplicate_window_ms: (!c.duplicate_window.is_zero()).then(|| ms(c.duplicate_window)),
            allow_direct: c.allow_direct,
            allow_rollup: c.allow_rollup,
            deny_delete: c.deny_delete,
            deny_purge: c.deny_purge,
            compression: match c.compression {
                Some(Compression::S2) => NatsCompression::S2,
                _ => NatsCompression::None,
            },
            sealed: c.sealed,
            mirror: c.mirror.as_ref().map(source_of),
            sources: c.sources.iter().flatten().map(source_of).collect(),
        }
    }
}

fn cluster_of(c: &stream::ClusterInfo) -> NatsClusterInfo {
    NatsClusterInfo {
        name: c.name.clone().filter(|n| !n.is_empty()),
        leader: c.leader.clone().filter(|n| !n.is_empty()),
        replicas: c
            .replicas
            .iter()
            .map(|p| NatsPeer {
                name: p.name.clone(),
                current: p.current,
                offline: p.offline,
                lag: p.lag,
                active_ms: ms(p.active),
            })
            .collect(),
    }
}

fn source_state(s: &stream::SourceInfo) -> NatsSourceState {
    NatsSourceState {
        name: s.name.clone(),
        lag: s.lag,
        active_ms: s.active.map(ms),
        filter_subject: s.filter_subject.clone().filter(|f| !f.is_empty()),
    }
}

fn stream_info(i: &stream::Info, subject_counts: Vec<NatsSubjectCount>) -> NatsStreamInfo {
    let s = &i.state;
    NatsStreamInfo {
        config: NatsStreamConfig::from(&i.config),
        created_us: us(i.created),
        state: NatsStreamState {
            messages: s.messages,
            bytes: s.bytes,
            first_sequence: s.first_sequence,
            first_us: (s.messages > 0)
                .then(|| us_opt(s.first_timestamp))
                .flatten(),
            last_sequence: s.last_sequence,
            last_us: us_opt(s.last_timestamp),
            consumers: s.consumer_count as u64,
            subjects: s.subjects_count,
            deleted: s.deleted_count.unwrap_or(0),
        },
        cluster: i.cluster.as_ref().map(cluster_of),
        mirror: i.mirror.as_ref().map(source_state),
        sources: i.sources.iter().map(source_state).collect(),
        subject_counts,
    }
}

fn summary(i: &stream::Info) -> NatsStreamSummary {
    let c = NatsStreamConfig::from(&i.config);
    NatsStreamSummary {
        name: c.name,
        description: c.description,
        subjects: c.subjects,
        messages: i.state.messages,
        bytes: i.state.bytes,
        consumers: i.state.consumer_count as u64,
        created_us: us(i.created),
        storage: c.storage,
        retention: c.retention,
        sealed: c.sealed,
        mirror: c.mirror.map(|m| m.name),
    }
}

/// A stream or consumer name: not empty, none of `. * > / \` or spaces (nats-server's rule).
pub fn name_of(field: &str, what: &str, name: &str) -> Result<String, ToolError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("a {what} name is required"),
        ));
    }
    if n.chars()
        .any(|c| c.is_whitespace() || matches!(c, '.' | '*' | '>' | '/' | '\\'))
    {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("a {what} name has no spaces and none of . * > / \\"),
        ));
    }
    if n.len() > 255 {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("a {what} name is at most 255 bytes"),
        ));
    }
    Ok(n.to_owned())
}

pub(super) fn positive<T: Into<i64> + Copy>(
    field: &str,
    v: Option<T>,
) -> Result<Option<T>, ToolError> {
    match v {
        Some(x) if x.into() <= 0 => Err(ToolError::invalid(
            TOOL,
            field,
            "more than 0, or empty for no limit",
        )),
        other => Ok(other),
    }
}

/// Applies the form's values onto a stream configuration (a new one, or the server's current one
/// for an update). The read-only parts (`sealed`, `mirror`, `sources`) are left as they are.
fn apply(target: &mut stream::Config, c: &NatsStreamConfig) -> Result<(), ToolError> {
    let subjects = c
        .subjects
        .iter()
        .map(|s| subscribe_subject(s))
        .collect::<Result<Vec<_>, _>>()?;
    if subjects.len() > MAX_STREAM_SUBJECTS {
        return Err(ToolError::invalid(
            TOOL,
            "subjects",
            format!("at most {MAX_STREAM_SUBJECTS} subjects"),
        ));
    }
    if subjects.is_empty() && target.mirror.is_none() && target.sources.is_none() {
        return Err(ToolError::invalid(
            TOOL,
            "subjects",
            "name at least one subject",
        ));
    }
    if c.replicas == 0 || c.replicas > MAX_REPLICAS {
        return Err(ToolError::invalid(
            TOOL,
            "replicas",
            format!("1 to {MAX_REPLICAS}"),
        ));
    }
    target.description = c
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_owned);
    target.subjects = subjects;
    target.storage = match c.storage {
        NatsStorage::File => StorageType::File,
        NatsStorage::Memory => StorageType::Memory,
    };
    target.retention = match c.retention {
        NatsRetention::Limits => RetentionPolicy::Limits,
        NatsRetention::Interest => RetentionPolicy::Interest,
        NatsRetention::WorkQueue => RetentionPolicy::WorkQueue,
    };
    target.discard = match c.discard {
        NatsDiscard::Old => DiscardPolicy::Old,
        NatsDiscard::New => DiscardPolicy::New,
    };
    target.discard_new_per_subject = c.discard_new_per_subject;
    target.max_messages = positive("maxMessages", c.max_messages)?.unwrap_or(-1);
    target.max_bytes = positive("maxBytes", c.max_bytes)?.unwrap_or(-1);
    target.max_age = Duration::from_millis(positive_u("maxAgeMs", c.max_age_ms)?.unwrap_or(0));
    target.max_message_size = positive("maxMessageSize", c.max_message_size)?.unwrap_or(-1);
    target.max_messages_per_subject =
        positive("maxMessagesPerSubject", c.max_messages_per_subject)?.unwrap_or(-1);
    target.max_consumers = positive("maxConsumers", c.max_consumers)?.unwrap_or(-1);
    target.num_replicas = c.replicas as usize;
    target.duplicate_window =
        Duration::from_millis(positive_u("duplicateWindowMs", c.duplicate_window_ms)?.unwrap_or(0));
    target.allow_direct = c.allow_direct;
    target.allow_rollup = c.allow_rollup;
    target.deny_delete = c.deny_delete;
    target.deny_purge = c.deny_purge;
    target.compression = Some(match c.compression {
        NatsCompression::None => Compression::None,
        NatsCompression::S2 => Compression::S2,
    });
    Ok(())
}

pub(super) fn positive_u(field: &str, v: Option<u64>) -> Result<Option<u64>, ToolError> {
    match v {
        Some(0) => Err(ToolError::invalid(
            TOOL,
            field,
            "more than 0, or empty for none",
        )),
        other => Ok(other),
    }
}

impl From<&consumer::Config> for NatsConsumerConfig {
    fn from(c: &consumer::Config) -> Self {
        let durable = c.durable_name.as_deref().is_some_and(|d| !d.is_empty());
        let name = c
            .durable_name
            .clone()
            .filter(|d| !d.is_empty())
            .or_else(|| c.name.clone())
            .unwrap_or_default();
        let mut filter_subjects = c.filter_subjects.clone();
        if !c.filter_subject.is_empty() {
            filter_subjects.insert(0, c.filter_subject.clone());
        }
        let (deliver, start_sequence, start_time_us) = match c.deliver_policy {
            DeliverPolicy::All => (NatsDeliverFrom::All, None, None),
            DeliverPolicy::Last => (NatsDeliverFrom::Last, None, None),
            DeliverPolicy::New => (NatsDeliverFrom::New, None, None),
            DeliverPolicy::LastPerSubject => (NatsDeliverFrom::LastPerSubject, None, None),
            DeliverPolicy::ByStartSequence { start_sequence } => {
                (NatsDeliverFrom::ByStartSequence, Some(start_sequence), None)
            }
            DeliverPolicy::ByStartTime { start_time } => {
                (NatsDeliverFrom::ByStartTime, None, Some(us(start_time)))
            }
        };
        NatsConsumerConfig {
            name,
            durable,
            description: c.description.clone().filter(|d| !d.is_empty()),
            filter_subjects,
            deliver,
            start_sequence,
            start_time_us,
            ack_policy: match c.ack_policy {
                AckPolicy::None => NatsAckPolicy::None,
                AckPolicy::All => NatsAckPolicy::All,
                _ => NatsAckPolicy::Explicit,
            },
            ack_wait_ms: ms(c.ack_wait),
            max_deliver: limit(c.max_deliver),
            max_ack_pending: limit(c.max_ack_pending),
            max_waiting: limit(c.max_waiting),
            replay: match c.replay_policy {
                ReplayPolicy::Instant => NatsReplayPolicy::Instant,
                ReplayPolicy::Original => NatsReplayPolicy::Original,
            },
            deliver_subject: c.deliver_subject.clone().filter(|d| !d.is_empty()),
            deliver_group: c.deliver_group.clone().filter(|d| !d.is_empty()),
            inactive_threshold_ms: (!c.inactive_threshold.is_zero())
                .then(|| ms(c.inactive_threshold)),
            headers_only: c.headers_only,
            replicas: (c.num_replicas > 0).then(|| u32::try_from(c.num_replicas).unwrap_or(1)),
        }
    }
}

fn consumer_info(i: &consumer::Info) -> NatsConsumerInfo {
    let pair = |s: &consumer::SequenceInfo| NatsSequencePair {
        consumer: s.consumer_sequence,
        stream: s.stream_sequence,
        last_active_us: s.last_active.map(us),
    };
    NatsConsumerInfo {
        stream: i.stream_name.clone(),
        name: i.name.clone(),
        created_us: us(i.created),
        config: NatsConsumerConfig::from(&i.config),
        delivered: pair(&i.delivered),
        ack_floor: pair(&i.ack_floor),
        num_pending: i.num_pending,
        num_ack_pending: i.num_ack_pending as u64,
        num_redelivered: i.num_redelivered as u64,
        num_waiting: i.num_waiting as u64,
        push_bound: i.push_bound,
        paused: i.paused,
        cluster: i.cluster.as_ref().map(cluster_of),
    }
}

/// The server's consumer configuration from the form.
fn consumer_config(c: &NatsConsumerConfig) -> Result<consumer::Config, ToolError> {
    let name = name_of("name", "consumer", &c.name)?;
    let filters = c
        .filter_subjects
        .iter()
        .map(|s| {
            subscribe_subject(s).map_err(|mut e| {
                e.field = Some("filterSubjects".into());
                e
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let deliver_policy = match c.deliver {
        NatsDeliverFrom::All => DeliverPolicy::All,
        NatsDeliverFrom::Last => DeliverPolicy::Last,
        NatsDeliverFrom::New => DeliverPolicy::New,
        NatsDeliverFrom::LastPerSubject => DeliverPolicy::LastPerSubject,
        NatsDeliverFrom::ByStartSequence => DeliverPolicy::ByStartSequence {
            start_sequence: c
                .start_sequence
                .filter(|s| *s > 0)
                .ok_or_else(|| ToolError::invalid(TOOL, "startSequence", "a sequence from 1"))?,
        },
        NatsDeliverFrom::ByStartTime => DeliverPolicy::ByStartTime {
            start_time: time_of(
                "startTimeUs",
                c.start_time_us
                    .ok_or_else(|| ToolError::invalid(TOOL, "startTimeUs", "a time is required"))?,
            )?,
        },
    };
    if c.ack_wait_ms == 0 && c.ack_policy != NatsAckPolicy::None {
        return Err(ToolError::invalid(TOOL, "ackWaitMs", "more than 0"));
    }
    let deliver_subject = match c
        .deliver_subject
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(d) => Some(super::client::publish_subject("deliverSubject", d)?),
        None => None,
    };
    let deliver_group = c
        .deliver_group
        .as_deref()
        .map(str::trim)
        .filter(|g| !g.is_empty())
        .map(str::to_owned);
    if deliver_group.is_some() && deliver_subject.is_none() {
        return Err(ToolError::invalid(
            TOOL,
            "deliverGroup",
            "a queue group needs a deliver subject (a push consumer)",
        ));
    }
    if let Some(r) = c.replicas
        && (r == 0 || r > MAX_REPLICAS)
    {
        return Err(ToolError::invalid(
            TOOL,
            "replicas",
            format!("1 to {MAX_REPLICAS}"),
        ));
    }
    let mut out = consumer::Config {
        durable_name: c.durable.then(|| name.clone()),
        name: Some(name),
        description: c
            .description
            .as_deref()
            .map(str::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned),
        deliver_policy,
        ack_policy: match c.ack_policy {
            NatsAckPolicy::Explicit => AckPolicy::Explicit,
            NatsAckPolicy::All => AckPolicy::All,
            NatsAckPolicy::None => AckPolicy::None,
        },
        ack_wait: Duration::from_millis(c.ack_wait_ms),
        max_deliver: positive("maxDeliver", c.max_deliver)?.unwrap_or(-1),
        max_ack_pending: positive("maxAckPending", c.max_ack_pending)?.unwrap_or(0),
        replay_policy: match c.replay {
            NatsReplayPolicy::Instant => ReplayPolicy::Instant,
            NatsReplayPolicy::Original => ReplayPolicy::Original,
        },
        headers_only: c.headers_only,
        num_replicas: c.replicas.map_or(0, |r| r as usize),
        ..consumer::Config::default()
    };
    match filters.len() {
        0 => {}
        1 => out.filter_subject = filters[0].clone(),
        _ => out.filter_subjects = filters,
    }
    match deliver_subject {
        Some(subject) => {
            out.deliver_subject = Some(subject);
            out.deliver_group = deliver_group;
        }
        None => out.max_waiting = positive("maxWaiting", c.max_waiting)?.unwrap_or(0),
    }
    if !c.durable {
        out.inactive_threshold = Duration::from_millis(
            positive_u("inactiveThresholdMs", c.inactive_threshold_ms)?
                .unwrap_or(ms(EPHEMERAL_INACTIVE)),
        );
    } else if let Some(t) = positive_u("inactiveThresholdMs", c.inactive_threshold_ms)? {
        out.inactive_threshold = Duration::from_millis(t);
    }
    Ok(out)
}

// ---- Browse ----------------------------------------------------------------------------------

/// A stored JetStream message in the §5.1 model.
pub fn stored_message(
    stream: &str,
    m: &async_nats::Message,
    sequence: u64,
    stored_us: i64,
) -> Message {
    let mut out = Message::new(stream, m.payload.to_vec(), stored_us, TimestampKind::Stored);
    out.subject = Some(m.subject.to_string());
    out.sequence = Some(sequence);
    out.headers = Some(headers_of(m.headers.as_ref()));
    out
}

/// A browse: an ordered consumer read as a pull source, up to the end it was given, or up to the
/// last message there was at the start unless it follows.
struct Browse {
    stream: String,
    messages: Option<consumer::pull::Ordered>,
    follow: bool,
    /// The last sequence when the browse started.
    stop_at: u64,
    end_sequence: Option<u64>,
    end_us: Option<i64>,
    done: bool,
    /// The ordered consumer's first name, deleted when the browse ends rather than left to its
    /// 30 s inactive threshold (one it recreated after a gap still goes by itself).
    cleanup: Option<(async_nats::jetstream::Context, String)>,
}

impl Drop for Browse {
    fn drop(&mut self) {
        let Some((js, consumer)) = self.cleanup.take() else {
            return;
        };
        let subject = format!("CONSUMER.DELETE.{}.{consumer}", self.stream);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                let _: Result<serde_json::Value, _> =
                    js.request(subject, &serde_json::json!({})).await;
            });
        }
    }
}

impl Browse {
    /// Takes one message; `false` once the browse is over (the message may still be kept).
    fn take(
        &mut self,
        m: &async_nats::jetstream::Message,
        out: &mut Vec<Message>,
    ) -> Result<(), ToolError> {
        let info = m.info().map_err(|e| remote("browse", e))?;
        let sequence = info.stream_sequence;
        let stored = us(info.published);
        if self.end_sequence.is_some_and(|e| sequence > e)
            || self.end_us.is_some_and(|e| stored > e)
        {
            self.done = true;
            return Ok(());
        }
        out.push(stored_message(&self.stream, &m.message, sequence, stored));
        let caught_up = info.pending == 0 || sequence >= self.stop_at;
        if !self.follow && caught_up {
            self.done = true;
        }
        if self.end_sequence.is_some_and(|e| sequence >= e) {
            self.done = true;
        }
        Ok(())
    }
}

impl PullSource for Browse {
    async fn next(&mut self) -> Result<Option<Vec<Message>>, ToolError> {
        let Some(messages) = self.messages.as_mut() else {
            return Ok(None);
        };
        if self.done {
            return Ok(None);
        }
        let first = messages.next().await;
        let mut out = Vec::new();
        let mut next = first;
        loop {
            match next {
                Some(Ok(m)) => self.take(&m, &mut out)?,
                Some(Err(e)) => return Err(remote("browse", e)),
                None => {
                    self.done = true;
                    break;
                }
            }
            if self.done || out.len() >= BATCH_ROWS {
                break;
            }
            // What is already here joins this batch; the next one waits.
            match self.messages.as_mut().and_then(|m| m.next().now_or_never()) {
                Some(n) => next = n,
                None => break,
            }
        }
        if out.is_empty() && self.done {
            return Ok(None);
        }
        Ok(Some(out))
    }
}

// ---- Procedures: streams ---------------------------------------------------------------------

#[derive(Deserialize)]
struct StreamPage {
    #[serde(default)]
    total: usize,
    #[serde(default)]
    streams: Option<Vec<stream::Info>>,
}

#[derive(Deserialize)]
struct ConsumerPage {
    #[serde(default)]
    total: usize,
    #[serde(default)]
    consumers: Option<Vec<consumer::Info>>,
}

#[derive(Deserialize)]
struct SubjectsState {
    #[serde(default)]
    subjects: Option<HashMap<String, u64>>,
}

#[derive(Deserialize)]
struct SubjectsInfo {
    state: SubjectsState,
}

#[derive(Deserialize)]
struct Success {
    #[serde(default)]
    success: bool,
}

#[derive(Deserialize)]
struct Purged {
    #[serde(default)]
    purged: u64,
}

#[derive(Deserialize)]
struct RawGet {
    message: RawStored,
}

#[derive(Deserialize)]
struct RawStored {
    subject: String,
    seq: u64,
    #[serde(default)]
    data: String,
    #[serde(default, rename = "hdrs")]
    headers: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    time: OffsetDateTime,
}

/// Every stream of the account, in name order.
pub(super) async fn list_streams(
    c: &NatsClient,
    subject: Option<&str>,
) -> Result<Vec<stream::Info>, ToolError> {
    let mut out = Vec::new();
    loop {
        let mut body = serde_json::json!({ "offset": out.len() });
        if let Some(s) = subject {
            body["subject"] = serde_json::Value::String(s.to_owned());
        }
        let page: StreamPage = api(c, "list streams", "STREAM.LIST".into(), &body).await?;
        let got = page.streams.unwrap_or_default();
        let empty = got.is_empty();
        out.extend(got);
        if empty || out.len() >= page.total {
            break;
        }
    }
    out.sort_by(|a, b| a.config.name.cmp(&b.config.name));
    Ok(out)
}

pub(super) async fn get_info(c: &NatsClient, name: &str) -> Result<stream::Info, ToolError> {
    api(
        c,
        "stream info",
        format!("STREAM.INFO.{name}"),
        &serde_json::json!({}),
    )
    .await
}

/// The busiest subjects of a stream (one page of the server's subject counts).
async fn subject_counts(c: &NatsClient, name: &str) -> Result<Vec<NatsSubjectCount>, ToolError> {
    let info: SubjectsInfo = api(
        c,
        "stream subjects",
        format!("STREAM.INFO.{name}"),
        &serde_json::json!({ "subjects_filter": ">" }),
    )
    .await?;
    let mut counts: Vec<NatsSubjectCount> = info
        .state
        .subjects
        .unwrap_or_default()
        .into_iter()
        .map(|(subject, messages)| NatsSubjectCount { subject, messages })
        .collect();
    counts.sort_by(|a, b| {
        b.messages
            .cmp(&a.messages)
            .then_with(|| a.subject.cmp(&b.subject))
    });
    counts.truncate(SUBJECT_COUNTS);
    Ok(counts)
}

/// `nats.js.streams.*`.
pub struct NatsStreamsApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.js.streams")]
impl NatsStreamsApi {
    /// Every stream of the account (or those that take `subject`), in name order.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn list(
        &self,
        ctx: Ctx,
        input: NatsStreamsListInput,
    ) -> ToolResult<Vec<NatsStreamSummary>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = match input
            .subject
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => Some(subscribe_subject(s).map_err(|mut e| {
                e.field = Some("subject".into());
                e
            })?),
            None => None,
        };
        let streams = list_streams(&h.value, subject.as_deref()).await?;
        Ok(streams.iter().map(summary).collect())
    }

    /// A stream's configuration and state; with `subjectCounts`, its busiest subjects too.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsStreamInfoInput) -> ToolResult<NatsStreamInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("stream", "stream", &input.stream)?;
        let info = get_info(&h.value, &name).await?;
        let counts = if input.subject_counts.unwrap_or(false) && info.state.subjects_count > 0 {
            subject_counts(&h.value, &name).await?
        } else {
            Vec::new()
        };
        Ok(stream_info(&info, counts))
    }

    /// Creates a stream; `Conflict` on `name` when one by that name exists.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: NatsStreamConfigInput) -> ToolResult<NatsStreamInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("name", "stream", &input.config.name)?;
        let mut config = stream::Config {
            name: name.clone(),
            ..stream::Config::default()
        };
        apply(&mut config, &input.config)?;
        let info: stream::Info = api(
            &h.value,
            "create stream",
            format!("STREAM.CREATE.{name}"),
            &config,
        )
        .await?;
        Ok(stream_info(&info, Vec::new()))
    }

    /// Changes a stream: the form's values on top of its current configuration, so what the form
    /// does not show is kept. The server refuses changes it does not allow (storage, retention),
    /// with the field marked.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn update(&self, ctx: Ctx, input: NatsStreamConfigInput) -> ToolResult<NatsStreamInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("name", "stream", &input.config.name)?;
        let current = get_info(&h.value, &name).await?;
        if current.config.sealed {
            return Err(ToolError::new(
                ToolErrorKind::Invalid,
                TOOL,
                format!("{name} is sealed: it cannot change"),
            )
            .into());
        }
        let mut config = current.config.clone();
        apply(&mut config, &input.config)?;
        let info: stream::Info = api(
            &h.value,
            "update stream",
            format!("STREAM.UPDATE.{name}"),
            &config,
        )
        .await?;
        Ok(stream_info(&info, Vec::new()))
    }

    /// Removes messages: all, those of a subject, all but the newest `keep`, or those below
    /// `upToSequence`.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn purge(
        &self,
        ctx: Ctx,
        input: NatsStreamPurgeInput,
    ) -> ToolResult<NatsStreamPurgeOutput> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("stream", "stream", &input.stream)?;
        if input.keep.is_some() && input.up_to_sequence.is_some() {
            return Err(ToolError::invalid(TOOL, "keep", "keep or a sequence, not both").into());
        }
        if input.up_to_sequence == Some(0) {
            return Err(ToolError::invalid(TOOL, "upToSequence", "a sequence from 1").into());
        }
        let mut body = serde_json::Map::new();
        if let Some(s) = input
            .subject
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let s = subscribe_subject(s).map_err(|mut e| {
                e.field = Some("subject".into());
                e
            })?;
            body.insert("filter".into(), s.into());
        }
        if let Some(k) = input.keep {
            body.insert("keep".into(), k.into());
        }
        if let Some(s) = input.up_to_sequence {
            body.insert("seq".into(), s.into());
        }
        let out: Purged = api(
            &h.value,
            "purge stream",
            format!("STREAM.PURGE.{name}"),
            &body,
        )
        .await?;
        Ok(NatsStreamPurgeOutput { purged: out.purged })
    }

    /// Deletes a stream with its messages and consumers.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsStreamInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("stream", "stream", &input.stream)?;
        let out: Success = api(
            &h.value,
            "delete stream",
            format!("STREAM.DELETE.{name}"),
            &serde_json::json!({}),
        )
        .await?;
        if !out.success {
            return Err(ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("the server did not delete {name}"),
            )
            .into());
        }
        Ok(Empty {})
    }

    /// Reads a stream from the first message, the last `n`, a sequence or a time, through an
    /// ordered ephemeral consumer (no acks); stops at the last message there was at the start
    /// unless it follows (spec §6.5).
    #[rpc::stream(perm = "nats.read", risk = Risk::Read, timeout_max = "12h")]
    async fn browse(
        &self,
        ctx: Ctx,
        input: NatsBrowseInput,
        sink: BinarySink,
    ) -> ToolResult<TailSummary> {
        let session = ctx.session().id.clone();
        let name = name_of("stream", "stream", &input.stream)?;
        let subject = match input
            .subject
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            Some(s) => Some(subscribe_subject(s).map_err(|mut e| {
                e.field = Some("subject".into());
                e
            })?),
            None => None,
        };
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (h, _busy) = self.0.busy::<NatsClient>(&session, TOOL, &input.conn_id)?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let info = get_info(&h.value, &name).await?;
        let state = &info.state;
        let deliver_policy = match input.start.from {
            NatsBrowseFrom::First => DeliverPolicy::All,
            NatsBrowseFrom::Last => {
                let n = input.start.n.unwrap_or(1).max(1);
                let start = state
                    .last_sequence
                    .saturating_sub(n - 1)
                    .max(state.first_sequence)
                    .max(1);
                DeliverPolicy::ByStartSequence {
                    start_sequence: start,
                }
            }
            NatsBrowseFrom::Sequence => DeliverPolicy::ByStartSequence {
                start_sequence: input.start.sequence.filter(|s| *s > 0).ok_or_else(|| {
                    ToolError::invalid(TOOL, "start.sequence", "a sequence from 1")
                })?,
            },
            NatsBrowseFrom::Time => DeliverPolicy::ByStartTime {
                start_time: time_of(
                    "start.timeUs",
                    input.start.time_us.ok_or_else(|| {
                        ToolError::invalid(TOOL, "start.timeUs", "a time is required")
                    })?,
                )?,
            },
        };
        let end = input.end.clone().unwrap_or(NatsBrowseEnd {
            sequence: None,
            time_us: None,
        });
        let nothing_yet = state.messages == 0 || state.last_sequence == 0;
        let mut cleanup = None;
        let messages = if nothing_yet && !input.follow {
            None
        } else {
            let js_stream = h
                .value
                .jetstream
                .get_stream_no_info(&name)
                .await
                .map_err(|e| remote("browse", e))?;
            let mut consumer = js_stream
                .create_consumer(consumer::pull::OrderedConfig {
                    filter_subject: subject.clone().unwrap_or_default(),
                    deliver_policy,
                    ..consumer::pull::OrderedConfig::default()
                })
                .await
                .map_err(|e| remote("browse", e))?;
            cleanup = Some((
                h.value.jetstream.clone(),
                consumer.cached_info().name.clone(),
            ));
            let pending = consumer.info().await.map(|i| i.num_pending).unwrap_or(1);
            if pending == 0 && !input.follow {
                None
            } else {
                Some(consumer.messages().await.map_err(|e| remote("browse", e))?)
            }
        };
        let source = Browse {
            stream: name,
            messages,
            follow: input.follow,
            stop_at: state.last_sequence,
            end_sequence: end.sequence,
            end_us: end.time_us,
            done: false,
            cleanup,
        };
        let decode = input.decode.unwrap_or_default();
        let target = |m: &Message| {
            m.subject
                .as_ref()
                .map(|s| Target::Subject { subject: s.clone() })
        };
        let req = TailRequest {
            codecs: &codecs,
            decode: &decode,
            filter: input.filter.as_ref(),
            max_scan: input.max_scan,
            limit: input.limit,
            target: &target,
            system: TOOL,
        };
        let feed = Feed::pull(source, h.token.child_token());
        tail::run(sink, feed, req, &progress, &h.token).await
    }

    /// One whole message, for "Load full payload": direct get when the stream allows it.
    #[rpc::query(name = "getMessage", perm = "nats.read", risk = Risk::Read)]
    async fn get_message(&self, ctx: Ctx, input: NatsGetMessageInput) -> ToolResult<MessageRecord> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("stream", "stream", &input.stream)?;
        if input.sequence == 0 {
            return Err(ToolError::invalid(TOOL, "sequence", "a sequence from 1").into());
        }
        let info = get_info(&h.value, &name).await?;
        let message = if info.config.allow_direct {
            let js_stream = h
                .value
                .jetstream
                .get_stream_no_info(&name)
                .await
                .map_err(|e| remote("get message", e))?;
            let m = js_stream.direct_get(input.sequence).await.map_err(|e| {
                use async_nats::jetstream::stream::DirectGetErrorKind;
                match e.kind() {
                    DirectGetErrorKind::NotFound => ToolError::not_found(
                        TOOL,
                        "message",
                        format!("no message at sequence {} in {name}", input.sequence),
                    ),
                    _ => remote("get message", e),
                }
            })?;
            let mut out = Message::new(
                name.clone(),
                m.payload.to_vec(),
                us(m.time),
                TimestampKind::Stored,
            );
            out.subject = Some(m.subject.to_string());
            out.sequence = Some(m.sequence);
            out.headers = Some(headers_of(Some(&m.headers)));
            out
        } else {
            let raw: RawGet = api(
                &h.value,
                "get message",
                format!("STREAM.MSG.GET.{name}"),
                &serde_json::json!({ "seq": input.sequence }),
            )
            .await?;
            raw_message(&name, raw.message)?
        };
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let mut decode = input.decode.unwrap_or_default();
        decode.max_payload_bytes = Some(
            u32::try_from(message.payload.len())
                .unwrap_or(u32::MAX)
                .max(1),
        );
        let target = message
            .subject
            .clone()
            .map(|subject| Target::Subject { subject });
        let row = decode_row(&codecs, message, &decode, target.as_ref(), 0).await;
        Ok(MessageRecord::from_row(&row))
    }
}

/// A message the `STREAM.MSG.GET` API answered (payload and headers in base64).
fn raw_message(stream: &str, m: RawStored) -> Result<Message, ToolError> {
    use base64::Engine as _;
    let b64 = base64::engine::general_purpose::STANDARD;
    let payload = b64
        .decode(m.data.as_bytes())
        .map_err(|e| remote("get message", e))?;
    let headers = match m.headers.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => {
            let bytes = b64
                .decode(h.as_bytes())
                .map_err(|e| remote("get message", e))?;
            Some(parse_headers(&bytes))
        }
        None => None,
    };
    let mut out = Message::new(stream, payload, us(m.time), TimestampKind::Stored);
    out.subject = Some(m.subject);
    out.sequence = Some(m.seq);
    out.headers = Some(headers_of(headers.as_ref()));
    Ok(out)
}

/// `NATS/1.0\r\nName: value\r\n...` as a header map.
fn parse_headers(bytes: &[u8]) -> async_nats::HeaderMap {
    let mut map = async_nats::HeaderMap::new();
    let text = String::from_utf8_lossy(bytes);
    for line in text.split("\r\n").skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            let k = k.trim();
            if !k.is_empty() {
                map.append(k, v.trim());
            }
        }
    }
    map
}

// ---- Procedures: consumers -------------------------------------------------------------------

/// `nats.js.consumers.*`.
pub struct NatsConsumersApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.js.consumers")]
impl NatsConsumersApi {
    /// A stream's consumers, in name order.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: NatsStreamInput) -> ToolResult<Vec<NatsConsumerInfo>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let name = name_of("stream", "stream", &input.stream)?;
        let mut out: Vec<consumer::Info> = Vec::new();
        loop {
            let page: ConsumerPage = api(
                &h.value,
                "list consumers",
                format!("CONSUMER.LIST.{name}"),
                &serde_json::json!({ "offset": out.len() }),
            )
            .await?;
            let got = page.consumers.unwrap_or_default();
            let empty = got.is_empty();
            out.extend(got);
            if empty || out.len() >= page.total {
                break;
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out.iter().map(consumer_info).collect())
    }

    /// A consumer's configuration and state (pending, ack pending, redelivered, waiting).
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsConsumerInput) -> ToolResult<NatsConsumerInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let stream = name_of("stream", "stream", &input.stream)?;
        let name = name_of("consumer", "consumer", &input.consumer)?;
        let info: consumer::Info = api(
            &h.value,
            "consumer info",
            format!("CONSUMER.INFO.{stream}.{name}"),
            &serde_json::json!({}),
        )
        .await?;
        Ok(consumer_info(&info))
    }

    /// Creates a pull or push consumer; `Conflict` on `name` when one by that name exists.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn create(
        &self,
        ctx: Ctx,
        input: NatsConsumerCreateInput,
    ) -> ToolResult<NatsConsumerInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let stream = name_of("stream", "stream", &input.stream)?;
        let config = consumer_config(&input.config)?;
        let name = config.name.clone().unwrap_or_default();
        let body =
            serde_json::json!({ "stream_name": stream, "config": config, "action": "create" });
        let info: consumer::Info = api(
            &h.value,
            "create consumer",
            format!("CONSUMER.CREATE.{stream}.{name}"),
            &body,
        )
        .await?;
        Ok(consumer_info(&info))
    }

    /// Deletes a consumer (its position goes with it).
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsConsumerInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let stream = name_of("stream", "stream", &input.stream)?;
        let name = name_of("consumer", "consumer", &input.consumer)?;
        let out: Success = api(
            &h.value,
            "delete consumer",
            format!("CONSUMER.DELETE.{stream}.{name}"),
            &serde_json::json!({}),
        )
        .await?;
        if !out.success {
            return Err(ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("the server did not delete {name}"),
            )
            .into());
        }
        Ok(Empty {})
    }
}

/// Mounts `nats.js.*`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsStreamsApi(Arc::clone(hub)))?;
    router.mount(NatsConsumersApi(Arc::clone(hub)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form() -> NatsStreamConfig {
        NatsStreamConfig {
            name: "ORDERS".into(),
            description: None,
            subjects: vec!["orders.>".into()],
            storage: NatsStorage::File,
            retention: NatsRetention::Limits,
            discard: NatsDiscard::Old,
            discard_new_per_subject: false,
            max_messages: Some(5_000_000),
            max_bytes: None,
            max_age_ms: Some(86_400_000),
            max_message_size: None,
            max_messages_per_subject: None,
            max_consumers: None,
            replicas: 1,
            duplicate_window_ms: None,
            allow_direct: true,
            allow_rollup: false,
            deny_delete: false,
            deny_purge: false,
            compression: NatsCompression::S2,
            sealed: false,
            mirror: None,
            sources: Vec::new(),
        }
    }

    #[test]
    fn the_form_goes_onto_the_config_and_back() {
        let mut c = stream::Config {
            name: "ORDERS".into(),
            ..stream::Config::default()
        };
        apply(&mut c, &form()).unwrap();
        assert_eq!(c.max_messages, 5_000_000);
        assert_eq!(c.max_bytes, -1);
        assert_eq!(c.max_age, Duration::from_secs(86_400));
        assert_eq!(c.compression, Some(Compression::S2));
        let back = NatsStreamConfig::from(&c);
        assert_eq!(back, form());
    }

    #[test]
    fn an_update_keeps_what_the_form_does_not_show() {
        let mut c = stream::Config {
            name: "ORDERS".into(),
            sources: Some(vec![stream::Source {
                name: "EU".into(),
                ..stream::Source::default()
            }]),
            allow_message_ttl: true,
            ..stream::Config::default()
        };
        let mut f = form();
        f.subjects.clear();
        apply(&mut c, &f).unwrap();
        assert!(c.allow_message_ttl);
        assert_eq!(c.sources.as_ref().unwrap()[0].name, "EU");
    }

    #[test]
    fn form_values_are_checked() {
        let mut c = stream::Config::default();
        let mut f = form();
        f.subjects = vec!["orders.>.x".into()];
        assert_eq!(
            apply(&mut c, &f).unwrap_err().field.as_deref(),
            Some("subjects")
        );
        let mut f = form();
        f.subjects.clear();
        assert_eq!(
            apply(&mut c, &f).unwrap_err().field.as_deref(),
            Some("subjects")
        );
        let mut f = form();
        f.replicas = 7;
        assert_eq!(
            apply(&mut c, &f).unwrap_err().field.as_deref(),
            Some("replicas")
        );
        let mut f = form();
        f.max_bytes = Some(0);
        assert_eq!(
            apply(&mut c, &f).unwrap_err().field.as_deref(),
            Some("maxBytes")
        );
        assert!(name_of("name", "stream", "OR DERS").is_err());
        assert!(name_of("name", "stream", "orders.eu").is_err());
        assert_eq!(name_of("name", "stream", " ORDERS ").unwrap(), "ORDERS");
    }

    #[test]
    fn server_errors_name_their_field() {
        let e = api_error(
            "create stream",
            ApiError {
                code: 400,
                err_code: code::STREAM_SUBJECT_OVERLAP,
                description: "subjects overlap with an existing stream".into(),
            },
        );
        assert_eq!(e.kind, ToolErrorKind::Invalid);
        assert_eq!(e.field.as_deref(), Some("subjects"));
        let e = api_error(
            "create stream",
            ApiError {
                code: 400,
                err_code: code::STREAM_NAME_EXIST,
                description: "stream name already in use with a different configuration".into(),
            },
        );
        assert_eq!(e.kind, ToolErrorKind::Conflict);
        let e = api_error(
            "update stream",
            ApiError {
                code: 500,
                err_code: code::INSUFFICIENT_RESOURCES,
                description: "insufficient resources".into(),
            },
        );
        assert_eq!(e.field.as_deref(), Some("maxBytes"));
        let e = api_error(
            "info",
            ApiError {
                code: 404,
                err_code: code::STREAM_NOT_FOUND,
                description: "stream not found".into(),
            },
        );
        assert_eq!(e.kind, ToolErrorKind::NotFound);
        assert_eq!(e.remote.unwrap().code, "10059");
    }

    #[test]
    fn a_consumer_from_the_form() {
        let f = NatsConsumerConfig {
            name: "billing".into(),
            durable: true,
            description: None,
            filter_subjects: vec!["orders.eu.>".into()],
            deliver: NatsDeliverFrom::ByStartSequence,
            start_sequence: Some(10),
            start_time_us: None,
            ack_policy: NatsAckPolicy::Explicit,
            ack_wait_ms: 30_000,
            max_deliver: Some(5),
            max_ack_pending: None,
            max_waiting: None,
            replay: NatsReplayPolicy::Instant,
            deliver_subject: None,
            deliver_group: None,
            inactive_threshold_ms: None,
            headers_only: false,
            replicas: None,
        };
        let c = consumer_config(&f).unwrap();
        assert_eq!(c.durable_name.as_deref(), Some("billing"));
        assert_eq!(c.filter_subject, "orders.eu.>");
        assert_eq!(
            c.deliver_policy,
            DeliverPolicy::ByStartSequence { start_sequence: 10 }
        );
        assert_eq!(NatsConsumerConfig::from(&c), f);
        let mut eph = f.clone();
        eph.durable = false;
        let c = consumer_config(&eph).unwrap();
        assert_eq!(c.durable_name, None);
        assert_eq!(c.inactive_threshold, EPHEMERAL_INACTIVE);
        let mut push = f.clone();
        push.deliver_group = Some("workers".into());
        assert_eq!(
            consumer_config(&push).unwrap_err().field.as_deref(),
            Some("deliverGroup")
        );
        let mut bad = f;
        bad.start_sequence = None;
        assert_eq!(
            consumer_config(&bad).unwrap_err().field.as_deref(),
            Some("startSequence")
        );
    }

    #[test]
    fn stored_headers_are_parsed() {
        let map =
            parse_headers(b"NATS/1.0\r\nLab-Seq: 7\r\nContent-Type: application/json\r\n\r\n");
        assert_eq!(map.get("Lab-Seq").map(|v| v.as_str()), Some("7"));
        assert_eq!(
            map.get("Content-Type").map(|v| v.as_str()),
            Some("application/json")
        );
    }
}
