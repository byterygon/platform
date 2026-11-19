//! Key-Value (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 3a).
//!
//! - `nats.kv.buckets.*`: list (the `KV_*` streams), info, create (history, TTL, sizes, storage,
//!   replicas, compression; `Conflict` when the bucket exists), delete.
//! - `nats.kv.keys`: the bucket's keys with their last revision, operation, time, size and a short
//!   preview, read by an ordered consumer on the bucket's stream (last per subject), up to 10,000,
//!   then `truncated`; deleted keys only when asked.
//! - `nats.kv.get` (a revision or the latest), `nats.kv.history`: entries as `MessageRecord`s through
//!   the codecs, mapped by bucket.
//! - `nats.kv.put` with an optional expected revision (0: the key must not exist): a wrong
//!   revision is `Conflict`, so "Put revision n back" never overwrites a change it did not see.
//!   `delete` writes a delete marker; `purge` removes the key's history.
//! - `nats.kv.watch`: a live tail over the bucket or a key pattern: the current value of each key,
//!   then the changes; with `includeHistory` every revision kept first; or from a revision. A pull
//!   source of the messaging core.

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx, RegistryError, Router, rpc};
use async_nats::jetstream::consumer::{self, DeliverPolicy};
use async_nats::jetstream::kv;
use async_nats::jetstream::stream::{self, StorageType};
use futures_util::{FutureExt as _, StreamExt as _};
use message_codecs::filter::Filter;
use message_codecs::{
    ComposePayload, DecodeOptions, Message, Operation, Part, Target, TimestampKind,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::client::{NatsClient, remote};
use super::jetstream::{
    MAX_REPLICAS, NatsStorage, api, get_info, limit, list_streams, ms, positive, positive_u, us,
};
use super::{TOOL, handle};
use crate::core::messaging::decode_row;
use crate::core::messaging::record::MessageRecord;
use crate::core::messaging::tail::{self, BATCH_ROWS, Feed, PullSource, TailRequest, TailSummary};
use crate::core::messaging::tool_error;
use crate::core::{Empty, Hub, ToolError, ToolErrorKind, ToolResult};

/// Keys `nats.kv.keys` lists at most (spec §6.3).
pub const MAX_KEYS: u32 = 10_000;
/// Characters of a value's preview in the key list.
pub const PREVIEW_CHARS: usize = 200;
/// Revisions a bucket keeps per key, at most (nats-server's limit).
pub const MAX_HISTORY: i64 = 64;

// ---- Wire types ------------------------------------------------------------------------------

/// A bucket's configuration and state (spec §6.5, `KvBucketInfo`).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvBucketInfo {
    pub bucket: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// Entries stored, every revision and delete marker included.
    pub values: u64,
    pub bytes: u64,
    /// Revisions kept per key.
    pub history: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ttl_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_value_size: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_bytes: Option<i64>,
    pub storage: NatsStorage,
    pub replicas: u32,
    pub compression: bool,
    pub created_us: i64,
    /// The bucket it mirrors (a leaf node's copy).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mirror: Option<String>,
}

/// A new bucket (spec §6.4: history, TTL, max value size, storage, replicas).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvConfig {
    pub bucket: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    /// Revisions kept per key, 1 to 64.
    pub history: i64,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ttl_ms: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_value_size: Option<i32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_bytes: Option<i64>,
    pub storage: NatsStorage,
    pub replicas: u32,
    pub compression: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvBucketsListInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvBucketInput {
    pub conn_id: String,
    pub bucket: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvCreateInput {
    pub conn_id: String,
    pub config: NatsKvConfig,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvKeysInput {
    pub conn_id: String,
    pub bucket: String,
    /// A key or pattern (`feature.>`, `limits.*`); every key when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<String>,
    /// At most 10,000 (the default).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
    /// Keys whose last entry is a delete or purge marker too.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub include_deleted: Option<bool>,
}

/// One key of the list: its last entry.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvKey {
    pub key: String,
    pub revision: u64,
    /// `put`, `delete` or `purge`.
    pub operation: String,
    pub created_us: i64,
    pub size: u64,
    /// The value's first characters when it is UTF-8.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvKeysOutput {
    pub keys: Vec<NatsKvKey>,
    /// More keys match than were listed: narrow with a filter.
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvGetInput {
    pub conn_id: String,
    pub bucket: String,
    pub key: String,
    /// The latest when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub revision: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvHistoryInput {
    pub conn_id: String,
    pub bucket: String,
    pub key: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvPutInput {
    pub conn_id: String,
    pub bucket: String,
    pub key: String,
    pub payload: ComposePayload,
    /// The key's current revision; 0 when it must not exist yet. A different one is `Conflict`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub expect_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvPutOutput {
    pub revision: u64,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvKeyInput {
    pub conn_id: String,
    pub bucket: String,
    pub key: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsKvWatchInput {
    pub conn_id: String,
    pub stream_id: String,
    pub bucket: String,
    /// A key or pattern; `>` for the whole bucket.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub keys: Option<String>,
    /// Every revision kept first, then the changes (else the current value of each key first).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub include_history: Option<bool>,
    /// Start at this revision (overrides `includeHistory`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub from_revision: Option<u64>,
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

// ---- Names and conversions -------------------------------------------------------------------

/// A bucket name: letters, digits, `_` and `-`.
pub fn bucket_of(field: &str, bucket: &str) -> Result<String, ToolError> {
    let b = bucket.trim();
    if b.is_empty() {
        return Err(ToolError::invalid(TOOL, field, "a bucket name is required"));
    }
    if !b
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "a bucket name has only letters, digits, _ and -",
        ));
    }
    Ok(b.to_owned())
}

/// A key: letters, digits and `- / _ = .`, not starting or ending with a dot; with `pattern`,
/// `*` and a final `>` too.
pub fn key_of(field: &str, key: &str, pattern: bool) -> Result<String, ToolError> {
    let k = key.trim();
    if k.is_empty() {
        return Err(ToolError::invalid(TOOL, field, "a key is required"));
    }
    if k.starts_with('.') || k.ends_with('.') || k.contains("..") {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "a key does not start or end with a dot, nor has two in a row",
        ));
    }
    let tokens: Vec<&str> = k.split('.').collect();
    for (i, t) in tokens.iter().enumerate() {
        let wildcard = pattern && (*t == "*" || (*t == ">" && i == tokens.len() - 1));
        if !wildcard
            && !t
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | '_' | '='))
        {
            return Err(ToolError::invalid(
                TOOL,
                field,
                if pattern {
                    format!("{k}: letters, digits, - / _ = and dots, with * or a final >")
                } else {
                    format!("{k}: letters, digits, - / _ = and dots")
                },
            ));
        }
    }
    Ok(k.to_owned())
}

fn stream_name(bucket: &str) -> String {
    format!("KV_{bucket}")
}

/// Whether a stream is a bucket's: `KV_<bucket>` on `$KV.<bucket>.>`.
pub fn is_bucket(i: &stream::Info) -> Option<String> {
    let bucket = i.config.name.strip_prefix("KV_")?;
    let ours = i.config.subjects.iter().all(|s| s.starts_with("$KV."));
    (ours && (!i.config.subjects.is_empty() || i.config.mirror.is_some()))
        .then(|| bucket.to_owned())
}

fn bucket_info(bucket: String, i: &stream::Info) -> NatsKvBucketInfo {
    let c = &i.config;
    NatsKvBucketInfo {
        bucket,
        description: c.description.clone().filter(|d| !d.is_empty()),
        values: i.state.messages,
        bytes: i.state.bytes,
        history: c.max_messages_per_subject.max(1),
        ttl_ms: (!c.max_age.is_zero()).then(|| ms(c.max_age)),
        max_value_size: limit(c.max_message_size),
        max_bytes: limit(c.max_bytes),
        storage: match c.storage {
            StorageType::File => NatsStorage::File,
            StorageType::Memory => NatsStorage::Memory,
        },
        replicas: u32::try_from(c.num_replicas.max(1)).unwrap_or(1),
        compression: matches!(c.compression, Some(stream::Compression::S2)),
        created_us: us(i.created),
        mirror: c
            .mirror
            .as_ref()
            .map(|m| m.name.trim_start_matches("KV_").to_owned()),
    }
}

fn operation_of(op: kv::Operation) -> Operation {
    match op {
        kv::Operation::Put => Operation::Put,
        kv::Operation::Delete => Operation::Delete,
        kv::Operation::Purge => Operation::Purge,
    }
}

/// A KV entry in the §5.1 model: the bucket as source, the key as subject, the revision as
/// sequence; KV entries have no headers.
pub fn entry_message(e: &kv::Entry) -> Message {
    let mut out = Message::new(
        e.bucket.clone(),
        e.value.to_vec(),
        us(e.created),
        TimestampKind::Stored,
    );
    out.subject = Some(e.key.clone());
    out.sequence = Some(e.revision);
    out.operation = Some(operation_of(e.operation));
    out
}

/// The first characters of a value, when it is text.
fn preview(value: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(value).ok()?;
    let mut out: String = text.chars().take(PREVIEW_CHARS).collect();
    if out.len() < text.len() {
        out.push('…');
    }
    Some(out)
}

fn kv_operation(headers: Option<&async_nats::HeaderMap>) -> &'static str {
    match headers
        .and_then(|h| h.get("KV-Operation"))
        .map(|v| v.as_str())
    {
        Some("DEL") => "delete",
        Some("PURGE") => "purge",
        _ => "put",
    }
}

async fn store(c: &NatsClient, bucket: &str) -> Result<kv::Store, ToolError> {
    c.jetstream.get_key_value(bucket).await.map_err(|e| {
        use async_nats::jetstream::context::KeyValueErrorKind;
        match e.kind() {
            KeyValueErrorKind::GetBucket => {
                ToolError::not_found(TOOL, "bucket", format!("no bucket {bucket}: {e}"))
            }
            KeyValueErrorKind::InvalidStoreName => {
                ToolError::invalid(TOOL, "bucket", format!("{bucket} is not a bucket name"))
            }
            _ => remote("open bucket", e),
        }
    })
}

/// Encodes a Composer payload for a bucket with the connection's codecs.
async fn encode(
    hub: &Hub,
    session: &str,
    conn_id: &str,
    bucket: &str,
    payload: &ComposePayload,
) -> Result<message_codecs::Encoded, ToolError> {
    let codecs = hub.codecs(session, conn_id)?;
    let target = Target::KvBucket {
        bucket: bucket.to_owned(),
    };
    codecs
        .encode(Some(&target), Part::Value, payload)
        .await
        .map_err(|e| tool_error(TOOL, e))
}

// ---- Watch -----------------------------------------------------------------------------------

/// A KV watch as a pull source: what is already there joins one batch, then it waits.
struct WatchSource {
    watch: kv::Watch,
}

impl PullSource for WatchSource {
    async fn next(&mut self) -> Result<Option<Vec<Message>>, ToolError> {
        let mut out = Vec::new();
        let mut next = self.watch.next().await;
        loop {
            match next {
                Some(Ok(e)) => out.push(entry_message(&e)),
                Some(Err(e)) => return Err(remote("watch", e)),
                None => {
                    return Ok((!out.is_empty()).then_some(out));
                }
            }
            if out.len() >= BATCH_ROWS {
                break;
            }
            match self.watch.next().now_or_never() {
                Some(n) => next = n,
                None => break,
            }
        }
        Ok(Some(out))
    }
}

// ---- Procedures ------------------------------------------------------------------------------

/// `nats.kv.buckets.*`.
pub struct NatsKvBucketsApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.kv.buckets")]
impl NatsKvBucketsApi {
    /// Every bucket of the account, in name order.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn list(
        &self,
        ctx: Ctx,
        input: NatsKvBucketsListInput,
    ) -> ToolResult<Vec<NatsKvBucketInfo>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let streams = list_streams(&h.value, None).await?;
        Ok(streams
            .iter()
            .filter_map(|i| is_bucket(i).map(|b| bucket_info(b, i)))
            .collect())
    }

    /// A bucket's configuration and state.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsKvBucketInput) -> ToolResult<NatsKvBucketInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let info = get_info(&h.value, &stream_name(&bucket))
            .await
            .map_err(|mut e| {
                if e.kind == ToolErrorKind::NotFound {
                    e.resource = Some("bucket".into());
                    e.message = format!("no bucket {bucket}");
                }
                e
            })?;
        Ok(bucket_info(bucket, &info))
    }

    /// Creates a bucket; `Conflict` on `bucket` when one by that name exists.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: NatsKvCreateInput) -> ToolResult<NatsKvBucketInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let c = &input.config;
        let bucket = bucket_of("bucket", &c.bucket)?;
        if !(1..=MAX_HISTORY).contains(&c.history) {
            return Err(ToolError::invalid(TOOL, "history", format!("1 to {MAX_HISTORY}")).into());
        }
        if c.replicas == 0 || c.replicas > MAX_REPLICAS {
            return Err(
                ToolError::invalid(TOOL, "replicas", format!("1 to {MAX_REPLICAS}")).into(),
            );
        }
        if get_info(&h.value, &stream_name(&bucket)).await.is_ok() {
            let mut e = ToolError::new(
                ToolErrorKind::Conflict,
                TOOL,
                format!("a bucket {bucket} exists"),
            );
            e.field = Some("bucket".into());
            return Err(e.into());
        }
        let config = kv::Config {
            bucket: bucket.clone(),
            description: c.description.clone().unwrap_or_default(),
            history: c.history,
            max_age: Duration::from_millis(positive_u("ttlMs", c.ttl_ms)?.unwrap_or(0)),
            max_value_size: positive("maxValueSize", c.max_value_size)?.unwrap_or(-1),
            max_bytes: positive("maxBytes", c.max_bytes)?.unwrap_or(-1),
            storage: match c.storage {
                NatsStorage::File => StorageType::File,
                NatsStorage::Memory => StorageType::Memory,
            },
            num_replicas: c.replicas as usize,
            compression: c.compression,
            ..kv::Config::default()
        };
        h.value
            .jetstream
            .create_key_value(config)
            .await
            .map_err(|e| {
                use async_nats::jetstream::context::CreateKeyValueErrorKind;
                match e.kind() {
                    CreateKeyValueErrorKind::InvalidStoreName => {
                        ToolError::invalid(TOOL, "bucket", e.to_string())
                    }
                    CreateKeyValueErrorKind::TooLongHistory => {
                        ToolError::invalid(TOOL, "history", e.to_string())
                    }
                    _ => remote("create bucket", e),
                }
            })?;
        let info = get_info(&h.value, &stream_name(&bucket)).await?;
        Ok(bucket_info(bucket, &info))
    }

    /// Deletes a bucket with every key and revision.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsKvBucketInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        #[derive(Deserialize)]
        struct Success {
            #[serde(default)]
            success: bool,
        }
        let out: Success = api(
            &h.value,
            "delete bucket",
            format!("STREAM.DELETE.{}", stream_name(&bucket)),
            &serde_json::json!({}),
        )
        .await
        .map_err(|mut e| {
            if e.kind == ToolErrorKind::NotFound {
                e.resource = Some("bucket".into());
                e.message = format!("no bucket {bucket}");
            }
            e
        })?;
        if !out.success {
            return Err(ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("the server did not delete {bucket}"),
            )
            .into());
        }
        Ok(Empty {})
    }
}

/// `nats.kv.*`.
pub struct NatsKvApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.kv")]
impl NatsKvApi {
    /// The keys with their last entry (up to 10,000, then `truncated`).
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn keys(&self, ctx: Ctx, input: NatsKvKeysInput) -> ToolResult<NatsKvKeysOutput> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let filter = match input
            .filter
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
        {
            Some(f) => key_of("filter", f, true)?,
            None => ">".to_owned(),
        };
        let cap = input.limit.unwrap_or(MAX_KEYS).clamp(1, MAX_KEYS) as usize;
        let deleted = input.include_deleted.unwrap_or(false);
        let name = stream_name(&bucket);
        let prefix = format!("$KV.{bucket}.");
        let js_stream = h.value.jetstream.get_stream(&name).await.map_err(|e| {
            ToolError::not_found(TOOL, "bucket", format!("no bucket {bucket}: {e}"))
        })?;
        let mut consumer = js_stream
            .create_consumer(consumer::pull::OrderedConfig {
                filter_subject: format!("{prefix}{filter}"),
                deliver_policy: DeliverPolicy::LastPerSubject,
                ..consumer::pull::OrderedConfig::default()
            })
            .await
            .map_err(|e| remote("list keys", e))?;
        let consumer_name = consumer.cached_info().name.clone();
        let pending = consumer.info().await.map(|i| i.num_pending).unwrap_or(0);
        let mut keys = Vec::new();
        let mut truncated = false;
        if pending > 0 {
            let mut messages = consumer
                .messages()
                .await
                .map_err(|e| remote("list keys", e))?;
            let wait = h.value.request_timeout;
            loop {
                let next = tokio::select! {
                    biased;
                    () = h.token.cancelled() => return Err(ToolError::connection_gone(TOOL).into()),
                    n = tokio::time::timeout(wait, messages.next()) => n,
                };
                let m = match next {
                    Ok(Some(Ok(m))) => m,
                    Ok(Some(Err(e))) => return Err(remote("list keys", e).into()),
                    Ok(None) | Err(_) => break,
                };
                let info = m.info().map_err(|e| remote("list keys", e))?;
                let (revision, created, left) =
                    (info.stream_sequence, us(info.published), info.pending);
                let op = kv_operation(m.message.headers.as_ref());
                if deleted || op == "put" {
                    if keys.len() == cap {
                        truncated = true;
                        break;
                    }
                    let key = m
                        .message
                        .subject
                        .as_str()
                        .strip_prefix(&prefix)
                        .unwrap_or(m.message.subject.as_str())
                        .to_owned();
                    keys.push(NatsKvKey {
                        key,
                        revision,
                        operation: op.to_owned(),
                        created_us: created,
                        size: m.message.payload.len() as u64,
                        preview: (op == "put").then(|| preview(&m.message.payload)).flatten(),
                    });
                }
                if left == 0 {
                    break;
                }
            }
        }
        let _: Result<serde_json::Value, _> = h
            .value
            .jetstream
            .request(
                format!("CONSUMER.DELETE.{name}.{consumer_name}"),
                &serde_json::json!({}),
            )
            .await;
        keys.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(NatsKvKeysOutput { keys, truncated })
    }

    /// One entry, the latest or a given revision, through the codecs; a key deleted at that
    /// revision is its delete marker.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: NatsKvGetInput) -> ToolResult<MessageRecord> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let key = key_of("key", &input.key, false)?;
        let s = store(&h.value, &bucket).await?;
        let entry = match input.revision {
            Some(r) => s.entry_for_revision(key.clone(), r).await,
            None => s.entry(key.clone()).await,
        }
        .map_err(|e| remote("get", e))?
        .ok_or_else(|| {
            ToolError::not_found(
                TOOL,
                "key",
                match input.revision {
                    Some(r) => format!("{key} has no revision {r} in {bucket}"),
                    None => format!("no key {key} in {bucket}"),
                },
            )
        })?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let message = entry_message(&entry);
        let mut decode = input.decode.unwrap_or_default();
        decode.max_payload_bytes = Some(
            u32::try_from(message.payload.len())
                .unwrap_or(u32::MAX)
                .max(1),
        );
        let target = Target::KvBucket { bucket };
        let row = decode_row(&codecs, message, &decode, Some(&target), 0).await;
        Ok(MessageRecord::from_row(&row))
    }

    /// Every revision of a key the bucket keeps, oldest first.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn history(&self, ctx: Ctx, input: NatsKvHistoryInput) -> ToolResult<Vec<MessageRecord>> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let key = key_of("key", &input.key, false)?;
        let s = store(&h.value, &bucket).await?;
        let mut history = s.history(&key).await.map_err(|e| remote("history", e))?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let decode = input.decode.unwrap_or_default();
        let target = Target::KvBucket {
            bucket: bucket.clone(),
        };
        let mut out = Vec::new();
        while let Some(e) = history.next().await {
            let e = e.map_err(|e| remote("history", e))?;
            let row = decode_row(&codecs, entry_message(&e), &decode, Some(&target), 0).await;
            out.push(MessageRecord::from_row(&row));
        }
        if out.is_empty() {
            return Err(
                ToolError::not_found(TOOL, "key", format!("no key {key} in {bucket}")).into(),
            );
        }
        Ok(out)
    }

    /// Puts a value; with `expectRevision` only if the key is still at that revision (0: absent),
    /// else `Conflict`.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn put(&self, ctx: Ctx, input: NatsKvPutInput) -> ToolResult<NatsKvPutOutput> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let key = key_of("key", &input.key, false)?;
        let encoded = encode(&self.0, &session, &input.conn_id, &bucket, &input.payload).await?;
        let bytes = encoded.bytes.len() as u64;
        let value = bytes::Bytes::from(encoded.bytes);
        let s = store(&h.value, &bucket).await?;
        let conflict = |what: String| {
            let mut e = ToolError::new(ToolErrorKind::Conflict, TOOL, what);
            e.field = Some("expectRevision".into());
            e
        };
        let revision = match input.expect_revision {
            None => s.put(&key, value).await.map_err(|e| remote("put", e))?,
            Some(0) => s.create(&key, value).await.map_err(|e| {
                use async_nats::jetstream::kv::CreateErrorKind;
                match e.kind() {
                    CreateErrorKind::AlreadyExists => {
                        conflict(format!("{key} exists in {bucket}: it was not created"))
                    }
                    _ => remote("put", e),
                }
            })?,
            Some(r) => s.update(&key, value, r).await.map_err(|e| {
                use async_nats::jetstream::kv::UpdateErrorKind;
                match e.kind() {
                    UpdateErrorKind::WrongLastRevision => conflict(format!(
                        "{key} is no longer at revision {r}: someone changed it; nothing was written"
                    )),
                    _ => remote("put", e),
                }
            })?,
        };
        Ok(NatsKvPutOutput {
            revision,
            bytes,
            schema_ref: encoded.schema_ref,
        })
    }

    /// Writes a delete marker: the key reads as deleted, its earlier revisions stay.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsKvKeyInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let key = key_of("key", &input.key, false)?;
        store(&h.value, &bucket)
            .await?
            .delete(&key)
            .await
            .map_err(|e| remote("delete", e))?;
        Ok(Empty {})
    }

    /// Removes the key's history, leaving one purge marker.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn purge(&self, ctx: Ctx, input: NatsKvKeyInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let key = key_of("key", &input.key, false)?;
        store(&h.value, &bucket)
            .await?
            .purge(&key)
            .await
            .map_err(|e| remote("purge", e))?;
        Ok(Empty {})
    }

    /// The bucket or a key pattern as a live tail: each key's current value, then the changes;
    /// every revision kept first, or from a revision, when asked.
    #[rpc::stream(perm = "nats.read", risk = Risk::Read, timeout_max = "12h")]
    async fn watch(
        &self,
        ctx: Ctx,
        input: NatsKvWatchInput,
        sink: BinarySink,
    ) -> ToolResult<TailSummary> {
        let session = ctx.session().id.clone();
        let bucket = bucket_of("bucket", &input.bucket)?;
        let keys = match input
            .keys
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
        {
            Some(k) => key_of("keys", k, true)?,
            None => ">".to_owned(),
        };
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (h, _busy) = self.0.busy::<NatsClient>(&session, TOOL, &input.conn_id)?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let s = store(&h.value, &bucket).await?;
        // async-nats's `watch_with_history` delivers the last entry per key (`LastPerSubject`):
        // that is the default here, as `nats kv watch` shows the current values first. "Include
        // history" is every revision kept (the Go client's `IncludeHistory`): from revision 1.
        let watch = match (input.from_revision, input.include_history.unwrap_or(false)) {
            (Some(r), _) => s.watch_from_revision(&keys, r.max(1)).await,
            (None, true) => s.watch_from_revision(&keys, 1).await,
            (None, false) => s.watch_with_history(&keys).await,
        }
        .map_err(|e| remote("watch", e))?;
        let decode = input.decode.unwrap_or_default();
        let target = |m: &Message| {
            Some(Target::KvBucket {
                bucket: m.source.clone(),
            })
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
        let feed = Feed::pull(WatchSource { watch }, h.token.child_token());
        tail::run(sink, feed, req, &progress, &h.token).await
    }
}

/// Mounts `nats.kv.*`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsKvBucketsApi(Arc::clone(hub)))?;
    router.mount(NatsKvApi(Arc::clone(hub)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_buckets_are_checked() {
        assert_eq!(
            key_of("key", " feature.checkout ", false).unwrap(),
            "feature.checkout"
        );
        assert!(key_of("key", "a/b=c_d-e", false).is_ok());
        assert!(key_of("key", ".a", false).is_err());
        assert!(key_of("key", "a..b", false).is_err());
        assert!(key_of("key", "a b", false).is_err());
        assert!(key_of("key", "feature.*", false).is_err());
        assert!(key_of("filter", "feature.*", true).is_ok());
        assert!(key_of("filter", "feature.>", true).is_ok());
        assert!(key_of("filter", "feature.>.x", true).is_err());
        assert!(bucket_of("bucket", "config-2_b").is_ok());
        assert_eq!(
            bucket_of("bucket", "con.fig").unwrap_err().field.as_deref(),
            Some("bucket")
        );
    }

    #[test]
    fn previews_are_text_and_short() {
        assert_eq!(preview(b"{\"a\":1}").as_deref(), Some("{\"a\":1}"));
        assert_eq!(preview(&[0xff, 0xfe]), None);
        let long = "x".repeat(PREVIEW_CHARS + 10);
        let p = preview(long.as_bytes()).unwrap();
        assert!(p.ends_with('…'));
        assert_eq!(p.chars().count(), PREVIEW_CHARS + 1);
    }

    #[test]
    fn operations_come_from_the_header() {
        let mut h = async_nats::HeaderMap::new();
        assert_eq!(kv_operation(None), "put");
        h.insert("KV-Operation", "DEL");
        assert_eq!(kv_operation(Some(&h)), "delete");
        h.insert("KV-Operation", "PURGE");
        assert_eq!(kv_operation(Some(&h)), "purge");
    }
}
