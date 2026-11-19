//! Temporal External Storage on S3 (TSK-103, spec "a codec server for External Storage on S3").
//!
//! The SDKs store a payload of 256 KiB or more outside Temporal and put a reference in its place:
//! `metadata.encoding = "json/protobuf"`, `metadata.messageType =
//! "temporal.api.sdk.v1.ExternalStorageReference"`, `data` the protojson of
//! `{ driverName, claimData }`, `externalPayloads[0].sizeBytes` the stored size. The legacy form
//! has `encoding = "json/external-storage-reference"` and `{ driver_name, driver_claim: {
//! claim_data } }`. The S3 driver (`aws.s3driver`) claims `bucket`, `key`, `hash_algorithm =
//! sha256` and `hash_value`; the object is the binary `temporal.api.common.v1.Payload`.
//!
//! This module reads and writes them with a connection profile's S3 credentials:
//! - [`ExternalStore::retrieve`] checks the claim (the driver, a bucket the profile may read, a key
//!   under the namespace or the driver's context-free `v0/d/`), gets the object, verifies its
//!   sha256 and unmarshals it;
//! - [`ExternalStore::store`] puts a payload under the driver's `v0/d/sha256/<hash>` when absent and
//!   returns the reference payload;
//! - [`resolve_json`] swaps every reference in a message's raw JSON for its stored payload (marked
//!   `$external`), or marks why it could not.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use futures_util::StreamExt as _;
use prost::Message as _;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::proto::temporal::api::common::v1::Payload;
use super::proto::temporal::api::common::v1::payload::ExternalPayloadDetails;
use super::s3::{S3Client, S3Config, S3Error, hex};
use super::types::ExternalStorageOptions;

pub const DEFAULT_DRIVER: &str = "aws.s3driver";
pub const REFERENCE_MESSAGE_TYPE: &str = "temporal.api.sdk.v1.ExternalStorageReference";
pub const LEGACY_ENCODING: &str = "json/external-storage-reference";
/// The SDKs' default `payload_size_threshold`.
pub const DEFAULT_THRESHOLD: u64 = 256 * 1024;
/// The Go driver's default `MaxPayloadSize`.
pub const DEFAULT_MAX_PAYLOAD: u64 = 50 * 1024 * 1024;
/// Resolved payloads kept per connection (content-addressed, so never stale).
const CACHE_BYTES: usize = 64 * 1024 * 1024;
/// S3 calls at once.
const PARALLEL: usize = 8;

/// A reference payload, read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    pub driver: String,
    pub claim: BTreeMap<String, String>,
    /// `externalPayloads[0].sizeBytes`, when present.
    pub size: Option<i64>,
}

fn claim_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// The reference a payload holds, if it is one (both forms).
pub fn reference_of(
    encoding: &str,
    message_type: Option<&str>,
    data: &[u8],
    size: Option<i64>,
) -> Option<Reference> {
    let parsed: Value = serde_json::from_slice(data).ok()?;
    let (driver, claim) =
        if encoding == "json/protobuf" && message_type == Some(REFERENCE_MESSAGE_TYPE) {
            let driver = parsed
                .get("driverName")
                .or_else(|| parsed.get("driver_name"))?;
            (
                driver,
                claim_map(parsed.get("claimData").or_else(|| parsed.get("claim_data"))),
            )
        } else if encoding == LEGACY_ENCODING {
            let driver = parsed
                .get("driver_name")
                .or_else(|| parsed.get("driverName"))?;
            let claim = parsed
                .get("driver_claim")
                .or_else(|| parsed.get("driverClaim"));
            (
                driver,
                claim_map(claim.and_then(|c| c.get("claim_data").or_else(|| c.get("claimData")))),
            )
        } else {
            return None;
        };
    Some(Reference {
        driver: driver.as_str()?.to_owned(),
        claim,
        size,
    })
}

/// The reference a typed payload holds.
pub fn reference_of_payload(payload: &Payload) -> Option<Reference> {
    let text = |k: &str| {
        payload
            .metadata
            .get(k)
            .and_then(|b| std::str::from_utf8(b).ok())
    };
    reference_of(
        text("encoding")?,
        text("messageType"),
        &payload.data,
        payload.external_payloads.first().map(|d| d.size_bytes),
    )
}

/// The reference payload the SDKs write for a stored payload of `size` bytes.
pub fn reference_payload(driver: &str, claim: &BTreeMap<String, String>, size: i64) -> Payload {
    let data = serde_json::to_vec(&json!({ "driverName": driver, "claimData": claim }))
        .expect("a map of strings is JSON");
    Payload {
        metadata: [
            ("encoding".to_owned(), b"json/protobuf".to_vec()),
            (
                "messageType".to_owned(),
                REFERENCE_MESSAGE_TYPE.as_bytes().to_vec(),
            ),
        ]
        .into_iter()
        .collect(),
        data,
        external_payloads: vec![ExternalPayloadDetails { size_bytes: size }],
    }
}

/// Why a reference could not be read or a payload stored; `status` is what the codec endpoint
/// answers with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtError {
    pub status: u16,
    pub message: String,
}

impl ExtError {
    fn new(status: u16, message: impl Into<String>) -> ExtError {
        ExtError {
            status,
            message: message.into(),
        }
    }

    fn from_s3(e: &S3Error, what: &str) -> ExtError {
        let status = match e.status {
            Some(403) => 403,
            Some(404) => 404,
            Some(s) if s >= 500 => 502,
            Some(_) => 502,
            None if e.code == "TooLarge" => 413,
            None if e.code == "Timeout" => 504,
            None => 502,
        };
        ExtError::new(status, format!("{what}: {e}"))
    }
}

/// The store of one connected profile.
pub struct ExternalStore {
    s3: S3Client,
    pub driver: String,
    pub bucket: String,
    pub read_buckets: Vec<String>,
    pub threshold: u64,
    pub max_payload: u64,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    entries: HashMap<(String, String), Arc<Payload>>,
    order: VecDeque<(String, String)>,
    bytes: usize,
}

impl Cache {
    fn get(&self, key: &(String, String)) -> Option<Arc<Payload>> {
        self.entries.get(key).cloned()
    }

    fn put(&mut self, key: (String, String), payload: Arc<Payload>) {
        let size = payload.encoded_len();
        if size > CACHE_BYTES / 4 || self.entries.contains_key(&key) {
            return;
        }
        while self.bytes + size > CACHE_BYTES {
            let Some(old) = self.order.pop_front() else {
                break;
            };
            if let Some(p) = self.entries.remove(&old) {
                self.bytes -= p.encoded_len();
            }
        }
        self.bytes += size;
        self.order.push_back(key.clone());
        self.entries.insert(key, payload);
    }
}

/// The secrets that come with `externalStorage`.
pub struct S3Secrets {
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub session_token: Option<String>,
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

impl ExternalStore {
    /// The store a profile describes, or `None` when External Storage is off. `Err` names the
    /// field at fault.
    pub fn from_profile(
        options: Option<&ExternalStorageOptions>,
        secrets: S3Secrets,
    ) -> Result<Option<ExternalStore>, (&'static str, String)> {
        let Some(o) = options.filter(|o| o.enabled.unwrap_or(false)) else {
            return Ok(None);
        };
        let bucket = non_empty(o.bucket.as_deref())
            .ok_or(("externalStorage.bucket", "name the bucket".to_owned()))?;
        let access_key_id = non_empty(secrets.access_key_id.as_deref())
            .ok_or(("s3AccessKeyId", "give the access key ID".to_owned()))?;
        let secret_access_key = non_empty(secrets.secret_access_key.as_deref())
            .ok_or(("s3SecretAccessKey", "give the secret access key".to_owned()))?;
        let mut read_buckets: Vec<String> = o
            .read_buckets
            .iter()
            .flatten()
            .filter_map(|b| non_empty(Some(b)))
            .collect();
        if !read_buckets.contains(&bucket) {
            read_buckets.push(bucket.clone());
        }
        let region = non_empty(o.region.as_deref()).unwrap_or_else(|| "us-east-1".to_owned());
        let s3 = S3Client::new(S3Config {
            endpoint: non_empty(o.endpoint.as_deref()),
            region,
            path_style: o.path_style.unwrap_or(false),
            ca_pem: non_empty(o.ca_pem.as_deref()),
            access_key_id,
            secret_access_key,
            session_token: non_empty(secrets.session_token.as_deref()),
        })
        .map_err(|e| ("externalStorage.endpoint", e.message))?;
        Ok(Some(ExternalStore {
            s3,
            driver: non_empty(o.driver_name.as_deref())
                .unwrap_or_else(|| DEFAULT_DRIVER.to_owned()),
            bucket,
            read_buckets,
            threshold: o.threshold_bytes.unwrap_or(DEFAULT_THRESHOLD),
            max_payload: o.max_payload_bytes.unwrap_or(DEFAULT_MAX_PAYLOAD),
            cache: Mutex::new(Cache::default()),
        }))
    }

    /// The claim's bucket and key, if this profile may read them for `namespace`.
    fn check_claim<'a>(
        &self,
        namespace: &str,
        reference: &'a Reference,
    ) -> Result<(&'a str, &'a str), ExtError> {
        if reference.driver != self.driver {
            return Err(ExtError::new(
                400,
                format!(
                    "stored by the driver \"{}\"; this profile reads \"{}\"",
                    reference.driver, self.driver
                ),
            ));
        }
        let bucket = reference
            .claim
            .get("bucket")
            .ok_or_else(|| ExtError::new(400, "the claim has no bucket"))?;
        let key = reference
            .claim
            .get("key")
            .ok_or_else(|| ExtError::new(400, "the claim has no key"))?;
        if !self.read_buckets.iter().any(|b| b == bucket) {
            return Err(ExtError::new(
                403,
                format!("the bucket \"{bucket}\" is not one this profile reads"),
            ));
        }
        let own = format!("v0/ns/{}/", encode_key_segment(namespace));
        if !(key.starts_with(&own) || key.starts_with("v0/d/")) {
            return Err(ExtError::new(
                403,
                format!("the key is not under {own} or v0/d/"),
            ));
        }
        Ok((bucket, key))
    }

    /// The payload a reference stands for, read with the profile's credentials.
    pub async fn retrieve(
        &self,
        namespace: &str,
        reference: &Reference,
    ) -> Result<Arc<Payload>, ExtError> {
        let (bucket, key) = self.check_claim(namespace, reference)?;
        let cache_key = (bucket.to_owned(), key.to_owned());
        if let Some(hit) = self.cache.lock().expect("the cache lock").get(&cache_key) {
            return Ok(hit);
        }
        match reference.claim.get("hash_algorithm").map(String::as_str) {
            Some("sha256") | None => {}
            Some(other) => {
                return Err(ExtError::new(
                    400,
                    format!("the hash algorithm \"{other}\" is not supported"),
                ));
            }
        }
        let bytes = self
            .s3
            .get_object(bucket, key, self.max_payload as usize)
            .await
            .map_err(|e| ExtError::from_s3(&e, &format!("s3://{bucket}/{key}")))?;
        if let Some(expected) = reference.claim.get("hash_value") {
            let actual = hex(&Sha256::digest(&bytes));
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(ExtError::new(
                    502,
                    format!(
                        "integrity check failed for s3://{bucket}/{key}: expected {expected}, got {actual}"
                    ),
                ));
            }
        }
        let payload = Arc::new(Payload::decode(bytes.as_slice()).map_err(|e| {
            ExtError::new(
                502,
                format!("s3://{bucket}/{key} is not a Temporal payload: {e}"),
            )
        })?);
        self.cache
            .lock()
            .expect("the cache lock")
            .put(cache_key, Arc::clone(&payload));
        Ok(payload)
    }

    /// The reference payload for `payload`, stored under the driver's context-free key when absent
    /// (spec §4, Open question (c): the driver's layout). Payloads under the threshold come back
    /// as they are.
    pub async fn store(&self, payload: Payload) -> Result<Payload, ExtError> {
        let size = payload.encoded_len() as u64;
        if size < self.threshold || reference_of_payload(&payload).is_some() {
            return Ok(payload);
        }
        if size > self.max_payload {
            return Err(ExtError::new(
                413,
                format!(
                    "the payload is {size} bytes, over the {} byte limit",
                    self.max_payload
                ),
            ));
        }
        let bytes = payload.encode_to_vec();
        let digest = hex(&Sha256::digest(&bytes));
        let key = format!("v0/d/sha256/{digest}");
        let exists = self
            .s3
            .object_exists(&self.bucket, &key)
            .await
            .map_err(|e| ExtError::from_s3(&e, &format!("s3://{}/{key}", self.bucket)))?;
        if !exists {
            self.s3
                .put_object(&self.bucket, &key, bytes)
                .await
                .map_err(|e| {
                    ExtError::from_s3(&e, &format!("writing s3://{}/{key}", self.bucket))
                })?;
        }
        let claim: BTreeMap<String, String> = [
            ("bucket".to_owned(), self.bucket.clone()),
            ("key".to_owned(), key),
            ("hash_algorithm".to_owned(), "sha256".to_owned()),
            ("hash_value".to_owned(), digest),
        ]
        .into_iter()
        .collect();
        Ok(reference_payload(&self.driver, &claim, size as i64))
    }
}

/// A Write action's input with every payload at or over the threshold stored outside (spec §6).
/// Without a store, or under the threshold, the payloads go as they are; a store that refuses
/// fails the action rather than sending the payload inline.
pub async fn offload(
    store: Option<&ExternalStore>,
    payloads: Option<super::proto::temporal::api::common::v1::Payloads>,
) -> Result<Option<super::proto::temporal::api::common::v1::Payloads>, crate::core::ToolError> {
    let (Some(store), Some(mut payloads)) = (store, payloads.clone()) else {
        return Ok(payloads);
    };
    let mut stored = Vec::with_capacity(payloads.payloads.len());
    for payload in payloads.payloads.drain(..) {
        stored.push(store.store(payload).await.map_err(tool_error)?);
    }
    payloads.payloads = stored;
    Ok(Some(payloads))
}

/// An External Storage failure as the tool's error.
pub fn tool_error(e: ExtError) -> crate::core::ToolError {
    use crate::core::{ToolError, ToolErrorKind};
    let kind = match e.status {
        403 => ToolErrorKind::Forbidden,
        404 => ToolErrorKind::NotFound,
        400 | 413 => ToolErrorKind::Invalid,
        504 => ToolErrorKind::Connect,
        _ => ToolErrorKind::Remote,
    };
    if kind == ToolErrorKind::Invalid {
        return ToolError::invalid(
            super::TOOL,
            "args",
            format!("External Storage: {}", e.message),
        );
    }
    ToolError::new(
        kind,
        super::TOOL,
        format!("External Storage: {}", e.message),
    )
}

/// The driver's percent-encoding of a key segment: bytes outside `[A-Za-z0-9!-_.*'()]` as `%XX`,
/// an empty segment as `null`.
pub fn encode_key_segment(segment: &str) -> String {
    if segment.is_empty() {
        return "null".to_owned();
    }
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric()
            || matches!(b, b'!' | b'-' | b'_' | b'.' | b'*' | b'\'' | b'(' | b')')
        {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The reference a raw-JSON payload object holds (`metadata` and `data` in base64).
fn reference_in_json(object: &Map<String, Value>) -> Option<Reference> {
    let metadata = object.get("metadata")?.as_object()?;
    if !object
        .keys()
        .all(|k| k == "metadata" || k == "data" || k == "externalPayloads")
    {
        return None;
    }
    let text = |key: &str| -> Option<String> {
        String::from_utf8(BASE64.decode(metadata.get(key)?.as_str()?).ok()?).ok()
    };
    let data = BASE64
        .decode(object.get("data").and_then(Value::as_str).unwrap_or(""))
        .ok()?;
    let size = object
        .get("externalPayloads")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|d| d.get("sizeBytes"))
        .and_then(|s| s.as_i64().or_else(|| s.as_str()?.parse().ok()));
    reference_of(
        &text("encoding")?,
        text("messageType").as_deref(),
        &data,
        size,
    )
}

fn collect(value: &Value, path: String, out: &mut Vec<(String, Reference)>) {
    match value {
        Value::Object(object) => {
            if let Some(reference) = reference_in_json(object) {
                out.push((path, reference));
                return;
            }
            for (k, v) in object {
                collect(
                    v,
                    format!("{path}/{}", k.replace('~', "~0").replace('/', "~1")),
                    out,
                );
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                collect(v, format!("{path}/{i}"), out);
            }
        }
        _ => {}
    }
}

/// What a reference is, for `$external`.
fn external_info(reference: &Reference) -> Map<String, Value> {
    let mut info = Map::new();
    info.insert("driver".into(), Value::String(reference.driver.clone()));
    for k in ["bucket", "key"] {
        if let Some(v) = reference.claim.get(k) {
            info.insert(k.into(), Value::String(v.clone()));
        }
    }
    if let Some(size) = reference.size {
        info.insert("bytes".into(), json!(size));
    }
    info
}

/// Swaps every reference in `value` (a message as raw protobuf JSON) for the payload it stands
/// for, with `"$external": { driver, bucket, key, bytes }` beside its `metadata` and `data`. When
/// it cannot be read (no store, refused, missing, altered), the reference stays and `$external`
/// says why (`error`).
pub async fn resolve_json(store: Option<&ExternalStore>, namespace: &str, value: &mut Value) {
    let mut found = Vec::new();
    collect(value, String::new(), &mut found);
    if found.is_empty() {
        return;
    }
    let results: Vec<(String, Reference, Result<Arc<Payload>, ExtError>)> = futures_util::stream::iter(found)
        .map(|(path, reference)| async move {
            let outcome = match store {
                Some(store) => store.retrieve(namespace, &reference).await,
                None => Err(ExtError::new(424, "stored outside Temporal; set up External Storage in the profile to read it")),
            };
            (path, reference, outcome)
        })
        .buffer_unordered(PARALLEL)
        .collect()
        .await;
    for (path, reference, outcome) in results {
        let Some(slot) = value.pointer_mut(&path) else {
            continue;
        };
        let mut info = external_info(&reference);
        match outcome {
            Ok(payload) => {
                let mut stored = Map::new();
                stored.insert(
                    "metadata".into(),
                    Value::Object(
                        payload
                            .metadata
                            .iter()
                            .map(|(k, v)| (k.clone(), Value::String(BASE64.encode(v))))
                            .collect(),
                    ),
                );
                if !payload.data.is_empty() {
                    stored.insert("data".into(), Value::String(BASE64.encode(&payload.data)));
                }
                stored.insert("$external".into(), Value::Object(info));
                *slot = Value::Object(stored);
            }
            Err(e) => {
                info.insert("error".into(), Value::String(e.message));
                if let Value::Object(object) = slot {
                    object.insert("$external".into(), Value::Object(info));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim() -> BTreeMap<String, String> {
        [
            ("bucket", "temporal-payloads"),
            ("key", "v0/ns/lab/wt/Big/wi/big-1/ri/r/d/sha256/ab"),
            ("hash_algorithm", "sha256"),
            ("hash_value", "ab"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect()
    }

    #[test]
    fn a_reference_round_trips() {
        let p = reference_payload(DEFAULT_DRIVER, &claim(), 300_000);
        let r = reference_of_payload(&p).expect("a reference");
        assert_eq!(r.driver, "aws.s3driver");
        assert_eq!(r.claim, claim());
        assert_eq!(r.size, Some(300_000));
        assert_eq!(p.metadata["messageType"], REFERENCE_MESSAGE_TYPE.as_bytes());
    }

    #[test]
    fn the_legacy_form_and_snake_case_are_read() {
        let legacy = br#"{"driver_name":"aws.s3driver","driver_claim":{"claim_data":{"bucket":"b","key":"v0/d/sha256/x"}}}"#;
        let r = reference_of(LEGACY_ENCODING, None, legacy, None).unwrap();
        assert_eq!(r.claim["bucket"], "b");
        let snake = br#"{"driver_name":"aws.s3driver","claim_data":{"bucket":"b","key":"k"}}"#;
        assert_eq!(
            reference_of("json/protobuf", Some(REFERENCE_MESSAGE_TYPE), snake, None)
                .unwrap()
                .claim["key"],
            "k"
        );
        // A json/protobuf payload of another message is not a reference.
        assert!(reference_of("json/protobuf", Some("other.Message"), snake, None).is_none());
    }

    #[test]
    fn segments_are_encoded_as_the_driver_does() {
        assert_eq!(encode_key_segment("lab"), "lab");
        assert_eq!(encode_key_segment("a b/c"), "a%20b%2Fc");
        assert_eq!(encode_key_segment(""), "null");
    }

    #[tokio::test]
    async fn without_a_store_a_reference_says_why() {
        let p = reference_payload(DEFAULT_DRIVER, &claim(), 300_000);
        let mut value = json!({ "input": { "payloads": [{
            "metadata": p.metadata.iter().map(|(k, v)| (k.clone(), Value::String(BASE64.encode(v)))).collect::<Map<_, _>>(),
            "data": BASE64.encode(&p.data),
            "externalPayloads": [{ "sizeBytes": 300000 }],
        }] } });
        resolve_json(None, "lab", &mut value).await;
        let ext = &value["input"]["payloads"][0]["$external"];
        assert_eq!(ext["bucket"], "temporal-payloads");
        assert_eq!(ext["bytes"], 300_000);
        assert!(
            ext["error"]
                .as_str()
                .unwrap()
                .contains("set up External Storage")
        );
    }
}
