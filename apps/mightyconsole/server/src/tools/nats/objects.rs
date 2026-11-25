//! Object Store (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 3b).
//!
//! - `nats.obj.buckets.*`: list (the `OBJ_*` streams), info, create (description, TTL, max
//!   bytes, storage, replicas, compression; `Conflict` when the bucket exists), delete.
//! - `nats.obj.list` / `info`: the objects with their size, chunks, time, digest, description,
//!   headers, metadata and link (deleted objects left out), up to 10,000 then `truncated`.
//! - `nats.obj.get`: the object's bytes as a `bytes` stream, links followed, the digest checked by
//!   async-nats at the end; 1 GiB at most.
//! - `nats.obj.uploadStart` / `uploadPart` / `uploadFinish` / `uploadAbort`: Ambidex has no client
//!   stream (Open question 4), so an upload is parts of 4 MiB sent in order as mutations. Each part
//!   is published as the bucket's chunks and answers once JetStream acknowledged them
//!   (backpressure); finish writes the object's metadata (a rollup, as every client does) and
//!   purges the chunks of the version it replaces. Abort, a failed part, a closed connection or 60 s
//!   without a call purge the chunks written so far.
//! - `nats.obj.delete`: a delete marker and the chunks purged.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ambidex::{BinarySink, Ctx, RegistryError, Router, rpc};
use async_nats::jetstream::object_store;
use async_nats::jetstream::stream::{self, StorageType};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE};
use futures_util::StreamExt as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::io::AsyncReadExt as _;
use tokio::time::Instant;
use ts_rs::TS;

use super::client::{NatsClient, remote};
use super::jetstream::{
    MAX_REPLICAS, NatsStorage, api, get_info, limit, list_streams, ms, positive, positive_u, us,
};
use super::kv::bucket_of;
use super::{TOOL, handle};
use crate::core::{Empty, Hub, ToolError, ToolErrorKind, ToolResult, random_id};

/// The largest object downloaded or uploaded (Open question 12).
pub const MAX_OBJECT_BYTES: u64 = 1 << 30;
/// An upload part, at most (the last one may be shorter).
pub const PART_BYTES: usize = 4 * 1024 * 1024;
/// The chunks a part is stored as (the clients' default), or the server's max payload if smaller.
pub const CHUNK_BYTES: usize = 128 * 1024;
/// An upload with no call for this long is abandoned and its chunks purged.
pub const UPLOAD_IDLE: Duration = Duration::from_secs(60);
/// Objects `nats.obj.list` returns at most.
pub const MAX_OBJECTS: usize = 10_000;
/// A download's chunks to the browser, at most.
const DOWNLOAD_CHUNK_BYTES: usize = 1024 * 1024;

// ---- Wire types ------------------------------------------------------------------------------

/// An object store's configuration and state.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjBucketInfo {
    pub bucket: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    /// Bytes stored: the objects' chunks and their metadata.
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ttl_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_bytes: Option<i64>,
    pub storage: NatsStorage,
    pub replicas: u32,
    pub compression: bool,
    /// A sealed bucket takes no more changes.
    pub sealed: bool,
    pub created_us: i64,
}

/// A new object store (spec §6.4).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjConfig {
    pub bucket: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ttl_ms: Option<u64>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_bytes: Option<i64>,
    pub storage: NatsStorage,
    pub replicas: u32,
    pub compression: bool,
}

/// One header of an object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjectHeader {
    pub name: String,
    pub value: String,
}

/// The object or bucket an object links to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjectLink {
    pub bucket: String,
    /// The object; absent for a link to the whole bucket.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
}

/// An object's metadata (spec §6.3: name, size, modified, chunks, digest, description, headers).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjectInfo {
    pub bucket: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub size: u64,
    pub chunks: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub modified_us: Option<i64>,
    /// `SHA-256=<base64url>`, as the clients write it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub digest: Option<String>,
    pub headers: Vec<NatsObjectHeader>,
    pub metadata: BTreeMap<String, String>,
    /// This version's id; its chunks are on `$O.<bucket>.C.<nuid>`.
    pub nuid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link: Option<NatsObjectLink>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub chunk_size: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjBucketsListInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjBucketInput {
    pub conn_id: String,
    pub bucket: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjCreateInput {
    pub conn_id: String,
    pub config: NatsObjConfig,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjListOutput {
    /// In name order.
    pub objects: Vec<NatsObjectInfo>,
    /// More than 10,000 objects: the first ones read are listed.
    pub truncated: bool,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjectInput {
    pub conn_id: String,
    pub bucket: String,
    pub name: String,
}

/// The end of a download.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjGetSummary {
    pub name: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadStartInput {
    pub conn_id: String,
    pub bucket: String,
    pub name: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub description: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Option<Vec<NatsObjectHeader>>,
    /// The file's size: the parts must add up to it.
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadStartOutput {
    pub upload_id: String,
    /// Every part but the last is this long.
    pub part_bytes: u32,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadPartInput {
    pub upload_id: String,
    /// 0, 1, 2… in order.
    pub index: u32,
    /// The part's bytes in base64.
    pub data: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadPartOutput {
    /// Bytes stored so far.
    pub received: u64,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadFinishInput {
    pub upload_id: String,
    /// The file's SHA-256 as the browser computed it (hex, or `SHA-256=<base64url>`); checked
    /// when given.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsObjUploadIdInput {
    pub upload_id: String,
}

// ---- Names and conversions -------------------------------------------------------------------

fn stream_name(bucket: &str) -> String {
    format!("OBJ_{bucket}")
}

/// Whether a stream is an object store's: `OBJ_<bucket>` on `$O.<bucket>.…`.
pub fn is_bucket(i: &stream::Info) -> Option<String> {
    let bucket = i.config.name.strip_prefix("OBJ_")?;
    let ours = i.config.subjects.iter().all(|s| s.starts_with("$O."));
    (ours && (!i.config.subjects.is_empty() || i.config.mirror.is_some()))
        .then(|| bucket.to_owned())
}

fn bucket_info(bucket: String, i: &stream::Info) -> NatsObjBucketInfo {
    let c = &i.config;
    NatsObjBucketInfo {
        bucket,
        description: c.description.clone().filter(|d| !d.is_empty()),
        bytes: i.state.bytes,
        ttl_ms: (!c.max_age.is_zero()).then(|| ms(c.max_age)),
        max_bytes: limit(c.max_bytes),
        storage: match c.storage {
            StorageType::File => NatsStorage::File,
            StorageType::Memory => NatsStorage::Memory,
        },
        replicas: u32::try_from(c.num_replicas.max(1)).unwrap_or(1),
        compression: matches!(c.compression, Some(stream::Compression::S2)),
        sealed: c.sealed,
        created_us: us(i.created),
    }
}

/// An object name: any text but empty, surrounding spaces or control characters.
pub fn object_name_of(field: &str, name: &str) -> Result<String, ToolError> {
    if name.trim().is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "an object name is required",
        ));
    }
    if name.trim() != name {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "an object name does not start or end with a space",
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "an object name has no control characters",
        ));
    }
    Ok(name.to_owned())
}

/// The headers of an upload: names without spaces or colons, values on one line.
fn header_map(headers: &[NatsObjectHeader]) -> Result<Option<async_nats::HeaderMap>, ToolError> {
    if headers.is_empty() {
        return Ok(None);
    }
    let mut map = async_nats::HeaderMap::new();
    for h in headers {
        let name = h.name.trim();
        if name.is_empty()
            || name
                .chars()
                .any(|c| c == ':' || c.is_whitespace() || c.is_control())
        {
            return Err(ToolError::invalid(
                TOOL,
                "headers",
                format!("{:?} is not a header name", h.name),
            ));
        }
        if h.value.contains(['\r', '\n']) {
            return Err(ToolError::invalid(
                TOOL,
                "headers",
                format!("the value of {name} is on one line"),
            ));
        }
        map.append(name, h.value.as_str());
    }
    Ok(Some(map))
}

pub fn object_info(o: &object_store::ObjectInfo) -> NatsObjectInfo {
    let mut headers: Vec<NatsObjectHeader> = o
        .headers
        .as_ref()
        .map(|m| {
            m.iter()
                .flat_map(|(name, values)| {
                    let name: &str = name.as_ref();
                    values.iter().map(move |v| NatsObjectHeader {
                        name: name.to_owned(),
                        value: v.as_str().to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    headers.sort_by(|a, b| a.name.cmp(&b.name));
    let options = o.options.as_ref();
    NatsObjectInfo {
        bucket: o.bucket.clone(),
        name: o.name.clone(),
        description: o.description.clone().filter(|d| !d.is_empty()),
        size: o.size as u64,
        chunks: o.chunks as u64,
        modified_us: o.modified.map(us).filter(|t| *t > 0),
        digest: o.digest.clone().filter(|d| !d.is_empty()),
        headers,
        metadata: o
            .metadata
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
        nuid: o.nuid.clone(),
        link: options
            .and_then(|x| x.link.as_ref())
            .map(|l| NatsObjectLink {
                bucket: l.bucket.clone(),
                name: l.name.clone(),
            }),
        chunk_size: options.and_then(|x| x.max_chunk_size).map(|n| n as u64),
    }
}

/// The digest as the clients write it.
fn digest_text(digest: &[u8]) -> String {
    format!("SHA-256={}", URL_SAFE.encode(digest))
}

/// Whether `expected` (hex, or `SHA-256=<base64url>`) is this digest.
fn digest_matches(expected: &str, digest: &[u8]) -> bool {
    let e = expected.trim();
    if let Some(b64) = e.strip_prefix("SHA-256=") {
        return b64 == URL_SAFE.encode(digest);
    }
    let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
    e.eq_ignore_ascii_case(&hex)
}

fn not_found_bucket(bucket: &str) -> impl FnOnce(ToolError) -> ToolError + '_ {
    move |mut e| {
        if e.kind == ToolErrorKind::NotFound {
            e.resource = Some("bucket".into());
            e.message = format!("no object store {bucket}");
        }
        e
    }
}

fn not_found_object(bucket: &str, name: &str) -> ToolError {
    ToolError::not_found(TOOL, "object", format!("no object {name} in {bucket}"))
}

async fn open(c: &NatsClient, bucket: &str) -> Result<object_store::ObjectStore, ToolError> {
    c.jetstream.get_object_store(bucket).await.map_err(|e| {
        use async_nats::jetstream::context::ObjectStoreErrorKind;
        match e.kind() {
            ObjectStoreErrorKind::InvalidBucketName => {
                ToolError::invalid(TOOL, "bucket", format!("{bucket} is not a bucket name"))
            }
            ObjectStoreErrorKind::GetStore => {
                ToolError::not_found(TOOL, "bucket", format!("no object store {bucket}: {e}"))
            }
        }
    })
}

/// The object's metadata, deleted objects being `NotFound`.
async fn info_of(
    s: &object_store::ObjectStore,
    bucket: &str,
    name: &str,
) -> Result<object_store::ObjectInfo, ToolError> {
    use async_nats::jetstream::object_store::InfoErrorKind;
    match s.info(name).await {
        Ok(i) if !i.deleted => Ok(i),
        Ok(_) => Err(not_found_object(bucket, name)),
        Err(e) => Err(match e.kind() {
            InfoErrorKind::NotFound => not_found_object(bucket, name),
            InfoErrorKind::InvalidName => {
                ToolError::invalid(TOOL, "name", format!("{name} is not an object name"))
            }
            InfoErrorKind::TimedOut => remote("object info", e).retryable(true),
            InfoErrorKind::Other => remote("object info", e),
        }),
    }
}

/// Purges a version's chunks.
async fn purge_chunks(c: &NatsClient, bucket: &str, nuid: &str) -> Result<u64, ToolError> {
    #[derive(Deserialize)]
    struct Purged {
        #[serde(default)]
        purged: u64,
    }
    let out: Purged = api(
        c,
        "purge chunks",
        format!("STREAM.PURGE.{}", stream_name(bucket)),
        &serde_json::json!({ "filter": format!("$O.{bucket}.C.{nuid}") }),
    )
    .await?;
    Ok(out.purged)
}

// ---- Uploads ---------------------------------------------------------------------------------

/// One upload in progress.
struct Upload {
    conn_id: String,
    client: Arc<NatsClient>,
    bucket: String,
    name: String,
    description: Option<String>,
    headers: Option<async_nats::HeaderMap>,
    size: u64,
    nuid: String,
    chunk_size: usize,
    next_index: u32,
    received: u64,
    chunks: u64,
    sha: Sha256,
    last_used: Instant,
    /// Finished or discarded: later calls are `NotFound`.
    over: bool,
}

impl Upload {
    /// Publishes a part as chunks and waits for every acknowledgement.
    async fn write(&mut self, data: &[u8]) -> Result<(), ToolError> {
        let subject = format!("$O.{}.C.{}", self.bucket, self.nuid);
        let mut acks = Vec::with_capacity(data.len().div_ceil(self.chunk_size));
        for chunk in data.chunks(self.chunk_size) {
            let ack = self
                .client
                .jetstream
                .publish(subject.clone(), bytes::Bytes::copy_from_slice(chunk))
                .await
                .map_err(|e| remote("upload part", e))?;
            acks.push(ack);
        }
        for ack in acks {
            ack.await.map_err(|e| remote("upload part", e))?;
        }
        self.sha.update(data);
        self.received += data.len() as u64;
        self.chunks += data.len().div_ceil(self.chunk_size) as u64;
        Ok(())
    }

    /// Writes the object's metadata, then purges the version it replaces.
    async fn commit(&mut self) -> Result<object_store::ObjectInfo, ToolError> {
        let digest = self.sha.clone().finalize();
        let store = open(&self.client, &self.bucket).await?;
        let previous = store.info(&self.name).await.ok().filter(|i| !i.deleted);
        let info = object_store::ObjectInfo {
            name: self.name.clone(),
            description: self.description.clone(),
            metadata: HashMap::new(),
            headers: self.headers.clone(),
            options: Some(object_store::ObjectOptions {
                link: None,
                max_chunk_size: Some(self.chunk_size),
            }),
            bucket: self.bucket.clone(),
            nuid: self.nuid.clone(),
            size: usize::try_from(self.size).unwrap_or(usize::MAX),
            chunks: usize::try_from(self.chunks).unwrap_or(usize::MAX),
            modified: Some(time::OffsetDateTime::now_utc()),
            digest: Some(digest_text(&digest)),
            deleted: false,
        };
        let body = serde_json::to_vec(&info).map_err(|e| remote("object metadata", e))?;
        let mut headers = async_nats::HeaderMap::new();
        headers.insert("Nats-Rollup", "sub");
        self.client
            .jetstream
            .publish_with_headers(
                format!("$O.{}.M.{}", self.bucket, URL_SAFE.encode(&self.name)),
                headers,
                body.into(),
            )
            .await
            .map_err(|e| remote("object metadata", e))?
            .await
            .map_err(|e| remote("object metadata", e))?;
        if let Some(old) = previous.filter(|p| p.nuid != self.nuid && !p.nuid.is_empty()) {
            purge_chunks(&self.client, &self.bucket, &old.nuid).await?;
        }
        Ok(info)
    }

    /// Purges what was written (best effort).
    async fn discard(&mut self) {
        self.over = true;
        if self.received > 0 {
            let _ = purge_chunks(&self.client, &self.bucket, &self.nuid).await;
        }
    }
}

/// An upload and the session it belongs to.
struct Slot {
    session: String,
    upload: tokio::sync::Mutex<Upload>,
}

type Entry = Arc<Slot>;

/// The uploads in progress of every session.
pub struct Uploads {
    idle: Duration,
    map: Mutex<HashMap<String, Entry>>,
}

impl Uploads {
    pub fn new(idle: Duration) -> Uploads {
        Uploads {
            idle,
            map: Mutex::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.map.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, id: &str) -> Option<Entry> {
        self.lock().get(id).cloned()
    }

    fn remove(&self, id: &str) {
        self.lock().remove(id);
    }

    /// Uploads in progress (tests).
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Ends the upload once it has no call for the idle time.
fn expire(uploads: Weak<Uploads>, id: String, idle: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep((idle / 4).max(Duration::from_millis(10))).await;
            let Some(all) = uploads.upgrade() else { return };
            let Some(entry) = all.get(&id) else { return };
            // A part being written holds the lock: the upload is in use.
            let Ok(mut u) = entry.upload.try_lock() else {
                continue;
            };
            if u.over {
                return;
            }
            if u.last_used.elapsed() >= idle {
                all.remove(&id);
                u.discard().await;
                return;
            }
        }
    });
}

// ---- Procedures ------------------------------------------------------------------------------

/// `nats.obj.buckets.*`.
pub struct NatsObjBucketsApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.obj.buckets")]
impl NatsObjBucketsApi {
    /// Every object store of the account, in name order.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn list(
        &self,
        ctx: Ctx,
        input: NatsObjBucketsListInput,
    ) -> ToolResult<Vec<NatsObjBucketInfo>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let streams = list_streams(&h.value, None).await?;
        Ok(streams
            .iter()
            .filter_map(|i| is_bucket(i).map(|b| bucket_info(b, i)))
            .collect())
    }

    /// An object store's configuration and state.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsObjBucketInput) -> ToolResult<NatsObjBucketInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let info = get_info(&h.value, &stream_name(&bucket))
            .await
            .map_err(not_found_bucket(&bucket))?;
        Ok(bucket_info(bucket, &info))
    }

    /// Creates an object store; `Conflict` on `bucket` when one by that name exists.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn create(&self, ctx: Ctx, input: NatsObjCreateInput) -> ToolResult<NatsObjBucketInfo> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let c = &input.config;
        let bucket = bucket_of("bucket", &c.bucket)?;
        if c.replicas == 0 || c.replicas > MAX_REPLICAS {
            return Err(
                ToolError::invalid(TOOL, "replicas", format!("1 to {MAX_REPLICAS}")).into(),
            );
        }
        if get_info(&h.value, &stream_name(&bucket)).await.is_ok() {
            let mut e = ToolError::new(
                ToolErrorKind::Conflict,
                TOOL,
                format!("an object store {bucket} exists"),
            );
            e.field = Some("bucket".into());
            return Err(e.into());
        }
        let config = object_store::Config {
            bucket: bucket.clone(),
            description: c.description.clone().filter(|d| !d.trim().is_empty()),
            max_age: Duration::from_millis(positive_u("ttlMs", c.ttl_ms)?.unwrap_or(0)),
            max_bytes: positive("maxBytes", c.max_bytes)?.unwrap_or(-1),
            storage: match c.storage {
                NatsStorage::File => StorageType::File,
                NatsStorage::Memory => StorageType::Memory,
            },
            num_replicas: c.replicas as usize,
            compression: c.compression,
            placement: None,
        };
        h.value
            .jetstream
            .create_object_store(config)
            .await
            .map_err(|e| {
                use async_nats::jetstream::context::CreateKeyValueErrorKind;
                match e.kind() {
                    CreateKeyValueErrorKind::InvalidStoreName => {
                        ToolError::invalid(TOOL, "bucket", e.to_string())
                    }
                    _ => remote("create object store", e),
                }
            })?;
        let info = get_info(&h.value, &stream_name(&bucket)).await?;
        Ok(bucket_info(bucket, &info))
    }

    /// Deletes an object store with every object.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsObjBucketInput) -> ToolResult<Empty> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        #[derive(Deserialize)]
        struct Success {
            #[serde(default)]
            success: bool,
        }
        let out: Success = api(
            &h.value,
            "delete object store",
            format!("STREAM.DELETE.{}", stream_name(&bucket)),
            &serde_json::json!({}),
        )
        .await
        .map_err(not_found_bucket(&bucket))?;
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

/// `nats.obj.*`.
pub struct NatsObjApi {
    hub: Arc<Hub>,
    uploads: Arc<Uploads>,
}

impl NatsObjApi {
    pub fn new(hub: Arc<Hub>, uploads: Arc<Uploads>) -> NatsObjApi {
        NatsObjApi { hub, uploads }
    }

    /// The upload `id` of this session.
    /// Ends an upload: its entry and its link to the connection.
    fn forget(&self, session: &ambidex::Session, id: &str) {
        self.uploads.remove(id);
        self.hub.unlink(&session.id, "uploadId", id);
    }

    fn upload(&self, ctx: &Ctx, id: &str) -> Result<Entry, ToolError> {
        self.uploads
            .get(id)
            .filter(|e| e.session == ctx.session().id)
            .ok_or_else(|| {
                ToolError::not_found(TOOL, "upload", "the upload ended or does not exist")
            })
    }
}

#[rpc::router(namespace = "nats.obj")]
impl NatsObjApi {
    /// The objects in name order (up to 10,000, then `truncated`), deleted ones left out.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: NatsObjBucketInput) -> ToolResult<NatsObjListOutput> {
        let h = handle(&self.hub, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let s = open(&h.value, &bucket).await?;
        let mut list = s.list().await.map_err(|e| remote("list objects", e))?;
        let mut objects = Vec::new();
        let mut truncated = false;
        while let Some(item) = list.next().await {
            let o = item.map_err(|e| remote("list objects", e))?;
            if objects.len() == MAX_OBJECTS {
                truncated = true;
                break;
            }
            objects.push(object_info(&o));
        }
        objects.sort_by(|a: &NatsObjectInfo, b| a.name.cmp(&b.name));
        Ok(NatsObjListOutput { objects, truncated })
    }

    /// An object's metadata.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsObjectInput) -> ToolResult<NatsObjectInfo> {
        let h = handle(&self.hub, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let name = object_name_of("name", &input.name)?;
        let s = open(&h.value, &bucket).await?;
        Ok(object_info(&info_of(&s, &bucket, &name).await?))
    }

    /// The object's bytes (a link is followed); the digest is checked once all are read.
    #[rpc::stream(
        perm = "nats.read",
        risk = Risk::Read,
        timeout_default = "1h",
        timeout_max = "1h",
        audit = "always",
    )]
    async fn get(
        &self,
        ctx: Ctx,
        input: NatsObjectInput,
        sink: BinarySink,
    ) -> ToolResult<NatsObjGetSummary> {
        use async_nats::jetstream::object_store::GetErrorKind;
        let session = ctx.session().id.clone();
        let bucket = bucket_of("bucket", &input.bucket)?;
        let name = object_name_of("name", &input.name)?;
        let (h, _busy) = self
            .hub
            .busy::<NatsClient>(&session, TOOL, &input.conn_id)?;
        let s = open(&h.value, &bucket).await?;
        let mut object = s.get(&name).await.map_err(|e| match e.kind() {
            GetErrorKind::NotFound => not_found_object(&bucket, &name),
            GetErrorKind::InvalidName => {
                ToolError::invalid(TOOL, "name", format!("{name} is not an object name"))
            }
            GetErrorKind::BucketLink => ToolError::invalid(
                TOOL,
                "name",
                format!("{name} links to a whole bucket, not an object"),
            ),
            _ => remote("get object", e),
        })?;
        let info = object.info().clone();
        if info.size as u64 > MAX_OBJECT_BYTES {
            return Err(ToolError::invalid(
                TOOL,
                "name",
                format!("{name} is over 1 GiB, the largest download (Open question 12)"),
            )
            .into());
        }
        let mut buf = vec![0u8; sink.max_chunk_bytes().clamp(1, DOWNLOAD_CHUNK_BYTES)];
        let mut filled = 0;
        let mut size: u64 = 0;
        loop {
            let n = tokio::select! {
                biased;
                () = sink.closed() => {
                    return Err(ToolError::new(ToolErrorKind::Remote, TOOL, "download cancelled").into());
                }
                n = object.read(&mut buf[filled..]) => n.map_err(|e| remote("read object", e))?,
            };
            if n == 0 {
                break;
            }
            filled += n;
            size += n as u64;
            if size > MAX_OBJECT_BYTES {
                return Err(ToolError::invalid(TOOL, "name", "the object is over 1 GiB").into());
            }
            if filled == buf.len() {
                sink.send(buf[..filled].to_vec()).await?;
                filled = 0;
            }
        }
        if filled > 0 {
            sink.send(buf[..filled].to_vec()).await?;
        }
        Ok(NatsObjGetSummary {
            name: info.name,
            size,
            digest: info.digest,
        })
    }

    /// Starts an upload of `size` bytes; the parts follow with `uploadPart`.
    #[rpc::mutation(name = "uploadStart", perm = "nats.write", risk = Risk::Write)]
    async fn upload_start(
        &self,
        ctx: Ctx,
        input: NatsObjUploadStartInput,
    ) -> ToolResult<NatsObjUploadStartOutput> {
        let h = handle(&self.hub, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let name = object_name_of("name", &input.name)?;
        if input.size > MAX_OBJECT_BYTES {
            return Err(
                ToolError::invalid(TOOL, "size", "1 GiB at most (Open question 12)").into(),
            );
        }
        let headers = header_map(input.headers.as_deref().unwrap_or_default())?;
        let info = get_info(&h.value, &stream_name(&bucket))
            .await
            .map_err(not_found_bucket(&bucket))?;
        if is_bucket(&info).is_none() {
            return Err(
                ToolError::not_found(TOOL, "bucket", format!("no object store {bucket}")).into(),
            );
        }
        if info.config.sealed {
            return Err(ToolError::new(
                ToolErrorKind::Conflict,
                TOOL,
                format!("{bucket} is sealed: it takes no new objects"),
            )
            .into());
        }
        let max_payload = h.value.client.server_info().max_payload;
        let chunk_size = if max_payload > 0 {
            CHUNK_BYTES.min(max_payload)
        } else {
            CHUNK_BYTES
        };
        let upload_id = random_id();
        let upload = Upload {
            conn_id: input.conn_id.clone(),
            client: Arc::clone(&h.value),
            bucket,
            name,
            description: input.description.filter(|d| !d.trim().is_empty()),
            headers,
            size: input.size,
            nuid: random_id(),
            chunk_size,
            next_index: 0,
            received: 0,
            chunks: 0,
            sha: Sha256::new(),
            last_used: Instant::now(),
            over: false,
        };
        // The Authorizer finds the upload's connection, and so its target, from `uploadId`.
        self.hub
            .link(&ctx.session().id, &input.conn_id, "uploadId", &upload_id);
        self.uploads.lock().insert(
            upload_id.clone(),
            Arc::new(Slot {
                session: ctx.session().id.clone(),
                upload: tokio::sync::Mutex::new(upload),
            }),
        );
        expire(
            Arc::downgrade(&self.uploads),
            upload_id.clone(),
            self.uploads.idle,
        );
        Ok(NatsObjUploadStartOutput {
            upload_id,
            part_bytes: PART_BYTES as u32,
        })
    }

    /// Stores one part (in order); answers once JetStream has it. A failed part ends the upload.
    #[rpc::mutation(name = "uploadPart", perm = "nats.write", risk = Risk::Write)]
    async fn upload_part(
        &self,
        ctx: Ctx,
        input: NatsObjUploadPartInput,
    ) -> ToolResult<NatsObjUploadPartOutput> {
        let entry = self.upload(&ctx, &input.upload_id)?;
        let mut u = entry.upload.lock().await;
        if u.over {
            return Err(
                ToolError::not_found(TOOL, "upload", "the upload ended or does not exist").into(),
            );
        }
        u.last_used = Instant::now();
        if handle(&self.hub, &ctx, &u.conn_id).is_err() {
            self.forget(ctx.session(), &input.upload_id);
            u.discard().await;
            return Err(ToolError::connection_gone(TOOL).into());
        }
        if input.index != u.next_index {
            return Err(ToolError::invalid(
                TOOL,
                "index",
                format!("part {} comes next, not {}", u.next_index, input.index),
            )
            .into());
        }
        let data = BASE64
            .decode(input.data.as_bytes())
            .map_err(|e| ToolError::invalid(TOOL, "data", format!("not valid base64: {e}")))?;
        if data.is_empty() || data.len() > PART_BYTES {
            return Err(ToolError::invalid(
                TOOL,
                "data",
                format!("a part is 1 byte to {PART_BYTES} bytes"),
            )
            .into());
        }
        if u.received + data.len() as u64 > u.size {
            return Err(ToolError::invalid(
                TOOL,
                "data",
                format!(
                    "the parts pass the size given at the start ({} bytes)",
                    u.size
                ),
            )
            .into());
        }
        if let Err(e) = u.write(&data).await {
            self.forget(ctx.session(), &input.upload_id);
            u.discard().await;
            return Err(e.into());
        }
        u.next_index += 1;
        u.last_used = Instant::now();
        Ok(NatsObjUploadPartOutput {
            received: u.received,
        })
    }

    /// Writes the object once every byte is in; the version it replaces is purged.
    #[rpc::mutation(name = "uploadFinish", perm = "nats.write", risk = Risk::Write)]
    async fn upload_finish(
        &self,
        ctx: Ctx,
        input: NatsObjUploadFinishInput,
    ) -> ToolResult<NatsObjectInfo> {
        let entry = self.upload(&ctx, &input.upload_id)?;
        let mut u = entry.upload.lock().await;
        if u.over {
            return Err(
                ToolError::not_found(TOOL, "upload", "the upload ended or does not exist").into(),
            );
        }
        u.last_used = Instant::now();
        if u.received != u.size {
            return Err(ToolError::invalid(
                TOOL,
                "size",
                format!("{} of {} bytes arrived", u.received, u.size),
            )
            .into());
        }
        if let Some(expected) = input.sha256.as_deref().filter(|s| !s.trim().is_empty()) {
            let digest = u.sha.clone().finalize();
            if !digest_matches(expected, &digest) {
                self.forget(ctx.session(), &input.upload_id);
                u.discard().await;
                return Err(ToolError::invalid(
                    TOOL,
                    "sha256",
                    "the bytes stored do not have this SHA-256; the upload was discarded",
                )
                .into());
            }
        }
        let out = u.commit().await;
        self.forget(ctx.session(), &input.upload_id);
        match out {
            Ok(info) => {
                u.over = true;
                Ok(object_info(&info))
            }
            Err(e) => {
                u.discard().await;
                Err(e.into())
            }
        }
    }

    /// Ends an upload and purges what it wrote.
    #[rpc::mutation(name = "uploadAbort", perm = "nats.write", risk = Risk::Write)]
    async fn upload_abort(&self, ctx: Ctx, input: NatsObjUploadIdInput) -> ToolResult<Empty> {
        if let Ok(entry) = self.upload(&ctx, &input.upload_id) {
            self.forget(ctx.session(), &input.upload_id);
            let mut u = entry.upload.lock().await;
            if !u.over {
                u.discard().await;
            }
        }
        Ok(Empty {})
    }

    /// Deletes an object: a delete marker, and its chunks purged.
    #[rpc::mutation(perm = "nats.destroy", risk = Risk::Destructive)]
    async fn delete(&self, ctx: Ctx, input: NatsObjectInput) -> ToolResult<Empty> {
        let h = handle(&self.hub, &ctx, &input.conn_id)?;
        let bucket = bucket_of("bucket", &input.bucket)?;
        let name = object_name_of("name", &input.name)?;
        let s = open(&h.value, &bucket).await?;
        info_of(&s, &bucket, &name).await?;
        s.delete(&name)
            .await
            .map_err(|e| remote("delete object", e))?;
        Ok(Empty {})
    }
}

/// Mounts `nats.obj.*`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsObjBucketsApi(Arc::clone(hub)))?;
    router.mount(NatsObjApi::new(
        Arc::clone(hub),
        Arc::new(Uploads::new(UPLOAD_IDLE)),
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_names_are_checked() {
        assert_eq!(
            object_name_of("name", "reports/2026 Q3.pdf").unwrap(),
            "reports/2026 Q3.pdf"
        );
        assert!(object_name_of("name", "").is_err());
        assert!(object_name_of("name", " a").is_err());
        assert_eq!(
            object_name_of("name", "a\nb").unwrap_err().field.as_deref(),
            Some("name")
        );
    }

    #[test]
    fn headers_are_checked() {
        let h = |name: &str, value: &str| NatsObjectHeader {
            name: name.into(),
            value: value.into(),
        };
        assert!(header_map(&[]).unwrap().is_none());
        let map = header_map(&[
            h("Content-Type", "text/plain"),
            h("X-A", "1"),
            h("X-A", "2"),
        ])
        .unwrap()
        .unwrap();
        assert_eq!(map.get_all("X-A").count(), 2);
        assert!(header_map(&[h("Bad Name", "x")]).is_err());
        assert!(header_map(&[h("A:B", "x")]).is_err());
        assert!(header_map(&[h("A", "x\r\ny")]).is_err());
    }

    #[test]
    fn digests_match_in_both_forms() {
        let d = Sha256::digest(b"abc");
        let hex = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert!(digest_matches(hex, &d));
        assert!(digest_matches(&hex.to_uppercase(), &d));
        assert!(digest_matches(&digest_text(&d), &d));
        assert!(!digest_matches("SHA-256=AAAA", &d));
        assert!(!digest_matches(&hex[2..], &d));
    }

    #[test]
    fn object_info_in_the_wire_type() {
        let mut headers = async_nats::HeaderMap::new();
        headers.insert("Content-Type", "text/plain");
        let o = object_store::ObjectInfo {
            name: "readme.txt".into(),
            description: Some(String::new()),
            metadata: HashMap::from([("k".to_owned(), "v".to_owned())]),
            headers: Some(headers),
            options: Some(object_store::ObjectOptions {
                link: None,
                max_chunk_size: Some(CHUNK_BYTES),
            }),
            bucket: "files".into(),
            nuid: "n1".into(),
            size: 32,
            chunks: 1,
            modified: None,
            digest: Some("SHA-256=x".into()),
            deleted: false,
        };
        let w = object_info(&o);
        assert_eq!(w.description, None);
        assert_eq!(w.headers[0].name, "Content-Type");
        assert_eq!(w.metadata["k"], "v");
        assert_eq!(w.chunk_size, Some(CHUNK_BYTES as u64));
        assert_eq!(w.link, None);
    }
}
