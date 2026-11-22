//! Large payloads (TSK-92, spec §9.3 "Large payload", Open question 45 (l)). A payload whose
//! decoded JSON is over 64 KiB is not sent whole: the UI gets
//! `{ "$large": { id, bytes, decodedBytes, encoding, codec?, preview } }` (its stored size, its
//! decoded size, its encoding, the codec that decoded it and the first 64 KiB of its JSON text),
//! and the decoded value stays here, per connection: least recently used first out past 256 MiB
//! of decoded JSON, dropped 10 minutes after its last use. The id is a hash of the payload, so
//! reading the same event again keeps one copy.
//!
//! `temporal.payload.node` gives one node at a time (children in pages of 50, at most 200, each
//! with its type, length, encoded size and a short preview; the root adds the largest arrays),
//! `temporal.payload.query` runs jq on the server (jaq, as the messaging core's filter) and sends
//! only its results, cut at 1 MiB, and `temporal.payload.download` streams the decoded JSON or the
//! stored bytes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use super::TOOL;
use crate::core::{ErrorPosition, ToolError};

/// Decoded JSON over this many bytes is kept on the server and sent as a stub.
pub const STUB_OVER: usize = 64 * 1024;
/// How much decoded JSON a connection keeps.
pub const CACHE_BYTES: usize = 256 * 1024 * 1024;
/// How long a payload is kept after its last use.
pub const IDLE: Duration = Duration::from_secs(10 * 60);
/// Children per page, by default and at most.
pub const PAGE: usize = 50;
pub const MAX_PAGE: usize = 200;
/// jq's results are cut at this much JSON text, and its run at this time.
pub const QUERY_BYTES: usize = 1024 * 1024;
pub const QUERY_TIME: Duration = Duration::from_secs(10);
/// What is stubbed and how much of it is previewed (TSK-109): payloads over `over` bytes of
/// decoded JSON, with their first `preview` bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StubAt {
    pub over: usize,
    pub preview: usize,
}

impl StubAt {
    /// A payload over 64 KiB, anywhere (TSK-92).
    pub const LARGE: StubAt = StubAt {
        over: STUB_OVER,
        preview: STUB_OVER,
    };
    /// Every payload over 1 KiB of an event over its share of a reply, with a short preview.
    pub const TIGHT: StubAt = StubAt {
        over: 1024,
        preview: 2 * 1024,
    };
}
/// A child's preview, and a string node's value, in characters.
const PREVIEW_CHARS: usize = 120;
const STRING_CHARS: usize = 4096;
/// How many of the largest arrays the root names.
const LARGEST: usize = 5;

/// One payload kept on the server.
#[derive(Debug)]
pub struct Kept {
    pub value: Value,
    /// The payload's data as the encoding reads it: as stored, or as the codec returned it.
    pub stored: Vec<u8>,
    pub encoding: String,
    /// The codec that decoded it, and what it was before ("binary/encrypted").
    pub codec: Option<(String, String)>,
    pub decoded_bytes: usize,
}

struct Slot {
    kept: Arc<Kept>,
    used: Instant,
}

#[derive(Default)]
struct Inner {
    slots: HashMap<String, Slot>,
    bytes: usize,
}

/// The large payloads of one connection.
pub struct LargePayloads {
    inner: Mutex<Inner>,
    limit: usize,
}

impl Default for LargePayloads {
    fn default() -> Self {
        Self::new(CACHE_BYTES)
    }
}

impl LargePayloads {
    pub fn new(limit: usize) -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            limit,
        }
    }

    /// Keeps a decoded payload and returns its id; the same payload again keeps one copy.
    pub fn keep(&self, kept: Kept) -> String {
        self.keep_at(kept, Instant::now())
    }

    fn keep_at(&self, kept: Kept, now: Instant) -> String {
        let mut hash = Sha256::new();
        hash.update(kept.encoding.as_bytes());
        hash.update([0]);
        hash.update(&kept.stored);
        let id: String = hash
            .finalize()
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        let mut inner = self
            .inner
            .lock()
            .expect("the large payload store is not poisoned");
        sweep(&mut inner, now);
        if let Some(slot) = inner.slots.get_mut(&id) {
            slot.used = now;
            return id;
        }
        inner.bytes += kept.decoded_bytes;
        inner.slots.insert(
            id.clone(),
            Slot {
                kept: Arc::new(kept),
                used: now,
            },
        );
        // Least recently used first out, never the one just kept.
        while inner.bytes > self.limit && inner.slots.len() > 1 {
            let Some(oldest) = inner
                .slots
                .iter()
                .filter(|(k, _)| **k != id)
                .min_by_key(|(_, s)| s.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(slot) = inner.slots.remove(&oldest) {
                inner.bytes -= slot.kept.decoded_bytes;
            }
        }
        id
    }

    /// The payload `id`, marked used; `None` once it was dropped.
    pub fn get(&self, id: &str) -> Option<Arc<Kept>> {
        self.get_at(id, Instant::now())
    }

    fn get_at(&self, id: &str, now: Instant) -> Option<Arc<Kept>> {
        let mut inner = self
            .inner
            .lock()
            .expect("the large payload store is not poisoned");
        sweep(&mut inner, now);
        let slot = inner.slots.get_mut(id)?;
        slot.used = now;
        Some(Arc::clone(&slot.kept))
    }

    /// The payload `id`, or the error that says it is gone.
    pub fn require(&self, id: &str) -> Result<Arc<Kept>, ToolError> {
        self.get(id).ok_or_else(|| {
            ToolError::not_found(
                TOOL,
                "payload",
                "this payload is no longer kept on the server (10 minutes unused, or the connection was opened again): reload the event",
            )
        })
    }

    /// The decoded JSON kept, in bytes.
    pub fn bytes(&self) -> usize {
        self.inner
            .lock()
            .expect("the large payload store is not poisoned")
            .bytes
    }
}

fn sweep(inner: &mut Inner, now: Instant) {
    let old: Vec<String> = inner
        .slots
        .iter()
        .filter(|(_, s)| now.duration_since(s.used) > IDLE)
        .map(|(k, _)| k.clone())
        .collect();
    for k in old {
        if let Some(slot) = inner.slots.remove(&k) {
            inner.bytes -= slot.kept.decoded_bytes;
        }
    }
}

// --- Sizes ------------------------------------------------------------------------------------

/// The length of an object's compact JSON text.
pub fn map_len(map: &serde_json::Map<String, Value>) -> usize {
    2 + map
        .iter()
        .map(|(k, v)| string_len(k) + 1 + json_len(v))
        .sum::<usize>()
        + map.len().saturating_sub(1)
}

/// The length of `value`'s compact JSON text (as `serde_json::to_vec` writes it).
pub fn json_len(value: &Value) -> usize {
    match value {
        Value::Null => 4,
        Value::Bool(true) => 4,
        Value::Bool(false) => 5,
        Value::Number(n) => n.to_string().len(),
        Value::String(s) => string_len(s),
        Value::Array(items) => {
            2 + items.iter().map(json_len).sum::<usize>() + items.len().saturating_sub(1)
        }
        Value::Object(map) => map_len(map),
    }
}

fn string_len(s: &str) -> usize {
    let mut n = 2;
    for c in s.chars() {
        n += match c {
            '"' | '\\' | '\n' | '\r' | '\t' | '\u{08}' | '\u{0c}' => 2,
            c if (c as u32) < 0x20 => 6,
            c => c.len_utf8(),
        };
    }
    n
}

/// A JSON pointer token: `~` as `~0`, `/` as `~1`.
fn token(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

/// The arrays of `value` with their sizes, biggest first.
fn largest_arrays(value: &Value) -> Vec<LargeArray> {
    fn walk(v: &Value, path: &str, out: &mut Vec<LargeArray>) -> usize {
        match v {
            Value::Array(items) => {
                let mut total = 2 + items.len().saturating_sub(1);
                for (i, item) in items.iter().enumerate() {
                    total += walk(item, &format!("{path}/{i}"), out);
                }
                if items.len() > 1 {
                    out.push(LargeArray {
                        path: path.to_owned(),
                        length: items.len(),
                        bytes: total,
                        entry_bytes: total / items.len(),
                    });
                }
                total
            }
            Value::Object(map) => {
                let mut total = 2 + map.len().saturating_sub(1);
                for (k, child) in map {
                    total += string_len(k) + 1 + walk(child, &format!("{path}/{}", token(k)), out);
                }
                total
            }
            other => json_len(other),
        }
    }
    let mut out = Vec::new();
    walk(value, "", &mut out);
    out.sort_by_key(|a| std::cmp::Reverse(a.bytes));
    out.truncate(LARGEST);
    out
}

/// The first `chars` characters of `text`, and whether it was cut.
fn cut(text: &str, chars: usize) -> (String, bool) {
    match text.char_indices().nth(chars) {
        Some((at, _)) => (text[..at].to_owned(), true),
        None => (text.to_owned(), false),
    }
}

/// The first `bytes` of `text`, on a character boundary.
pub fn cut_bytes(text: &str, bytes: usize) -> &str {
    if text.len() <= bytes {
        return text;
    }
    let mut end = bytes;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

// --- The stub ---------------------------------------------------------------------------------

/// The stub sent in place of a decoded payload over [`STUB_OVER`], or `None` for a smaller one.
/// `stored` is the data the encoding read; `codec` the codec's label and the encoding before it.
pub fn stub_if_large(
    store: &LargePayloads,
    value: &Value,
    encoding: &str,
    stored: &[u8],
    codec: Option<(String, String)>,
) -> Option<Value> {
    stub_at(store, value, encoding, stored, codec, StubAt::LARGE)
}

/// As [`stub_if_large`], over `at.over` bytes with a preview of `at.preview` bytes.
pub fn stub_at(
    store: &LargePayloads,
    value: &Value,
    encoding: &str,
    stored: &[u8],
    codec: Option<(String, String)>,
    at: StubAt,
) -> Option<Value> {
    // A payload's JSON is never much smaller than its data: skip measuring the small ones.
    if stored.len() < at.over / 4 && !matches!(value, Value::Object(_) | Value::Array(_)) {
        return None;
    }
    let decoded_bytes = json_len(value);
    if decoded_bytes <= at.over {
        return None;
    }
    let text = serde_json::to_string_pretty(value).unwrap_or_default();
    let preview = cut_bytes(&text, at.preview).to_owned();
    let id = store.keep(Kept {
        value: value.clone(),
        stored: stored.to_vec(),
        encoding: encoding.to_owned(),
        codec: codec.clone(),
        decoded_bytes,
    });
    let mut stub = json!({
        "id": id,
        "bytes": stored.len(),
        "decodedBytes": decoded_bytes,
        "encoding": encoding,
        "preview": preview,
    });
    if let Some((label, from)) = codec {
        stub["codec"] = json!({ "codec": label, "from": from });
    }
    Some(json!({ "$large": stub }))
}

// --- Procedures -------------------------------------------------------------------------------

/// What a JSON node is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum PayloadKind {
    Object,
    Array,
    String,
    Number,
    Bool,
    Null,
}

fn kind_of(v: &Value) -> PayloadKind {
    match v {
        Value::Object(_) => PayloadKind::Object,
        Value::Array(_) => PayloadKind::Array,
        Value::String(_) => PayloadKind::String,
        Value::Number(_) => PayloadKind::Number,
        Value::Bool(_) => PayloadKind::Bool,
        Value::Null => PayloadKind::Null,
    }
}

fn length_of(v: &Value) -> Option<usize> {
    match v {
        Value::Object(m) => Some(m.len()),
        Value::Array(a) => Some(a.len()),
        Value::String(s) => Some(s.chars().count()),
        _ => None,
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadNodeInput {
    pub conn_id: String,
    pub payload_id: String,
    /// A JSON pointer: `""` for the payload, `/items/3/sku` below it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub path: Option<String>,
    /// The first child of the page.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub offset: Option<u32>,
    /// Children per page: 50 when absent, at most 200.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

/// One child of a node.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadChild {
    /// The member's name, or the entry's index.
    pub key: String,
    /// Its JSON pointer.
    pub path: String,
    pub kind: PayloadKind,
    /// Members, entries or characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<usize>,
    /// Its compact JSON text, in bytes.
    pub bytes: usize,
    /// The start of its compact JSON text.
    pub preview: String,
}

/// An array of the payload with its size.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LargeArray {
    pub path: String,
    pub length: usize,
    pub bytes: usize,
    /// Its size per entry, on average.
    pub entry_bytes: usize,
}

/// What is known of the payload, given with the root.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadInfo {
    /// The data the encoding read, in bytes.
    pub bytes: usize,
    pub decoded_bytes: usize,
    pub encoding: String,
    /// The codec that decoded it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub codec: Option<String>,
    /// What it was before the codec.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub codec_from: Option<String>,
    /// The largest arrays, biggest first.
    pub largest_arrays: Vec<LargeArray>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadNode {
    pub path: String,
    pub kind: PayloadKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub length: Option<usize>,
    pub bytes: usize,
    /// The value of a number, a boolean, null or a string (its first 4,096 characters).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "unknown")]
    #[schemars(with = "Option<Value>")]
    pub value: Option<Value>,
    /// A string longer than what `value` holds.
    pub cut: bool,
    /// The page of children of an object or an array.
    pub children: Vec<PayloadChild>,
    pub offset: usize,
    /// Members or entries in all.
    pub total: usize,
    /// For the root only.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub info: Option<PayloadInfo>,
}

/// One node of a kept payload.
pub fn node(store: &LargePayloads, input: &PayloadNodeInput) -> Result<PayloadNode, ToolError> {
    let kept = store.require(&input.payload_id)?;
    let path = input.path.clone().unwrap_or_default();
    if !path.is_empty() && !path.starts_with('/') {
        return Err(ToolError::invalid(
            TOOL,
            "path",
            "a JSON pointer: empty, or starting with /",
        ));
    }
    let v = kept
        .value
        .pointer(&path)
        .ok_or_else(|| ToolError::not_found(TOOL, "node", format!("the payload has no {path}")))?;
    let limit = input.limit.map_or(PAGE, |l| l as usize);
    if !(1..=MAX_PAGE).contains(&limit) {
        return Err(ToolError::invalid(TOOL, "limit", "1 to 200"));
    }
    let offset = input.offset.unwrap_or(0) as usize;
    let child = |key: String, at: String, c: &Value| -> PayloadChild {
        let text = serde_json::to_string(c).unwrap_or_default();
        let (preview, _) = cut(&text, PREVIEW_CHARS);
        PayloadChild {
            key,
            path: at,
            kind: kind_of(c),
            length: length_of(c),
            bytes: text.len(),
            preview,
        }
    };
    let (children, total) = match v {
        Value::Array(items) => (
            items
                .iter()
                .enumerate()
                .skip(offset)
                .take(limit)
                .map(|(i, c)| child(i.to_string(), format!("{path}/{i}"), c))
                .collect(),
            items.len(),
        ),
        Value::Object(map) => (
            map.iter()
                .skip(offset)
                .take(limit)
                .map(|(k, c)| child(k.clone(), format!("{path}/{}", token(k)), c))
                .collect(),
            map.len(),
        ),
        _ => (Vec::new(), 0),
    };
    let (value, cut_string) = match v {
        Value::String(s) => {
            let (text, was_cut) = cut(s, STRING_CHARS);
            (Some(Value::String(text)), was_cut)
        }
        Value::Object(_) | Value::Array(_) => (None, false),
        other => (Some(other.clone()), false),
    };
    Ok(PayloadNode {
        bytes: if path.is_empty() {
            kept.decoded_bytes
        } else {
            json_len(v)
        },
        kind: kind_of(v),
        length: length_of(v),
        value,
        cut: cut_string,
        children,
        offset,
        total,
        info: path.is_empty().then(|| PayloadInfo {
            bytes: kept.stored.len(),
            decoded_bytes: kept.decoded_bytes,
            encoding: kept.encoding.clone(),
            codec: kept.codec.as_ref().map(|c| c.0.clone()),
            codec_from: kept.codec.as_ref().map(|c| c.1.clone()),
            largest_arrays: largest_arrays(&kept.value),
        }),
        path,
    })
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadQueryInput {
    pub conn_id: String,
    pub payload_id: String,
    /// A jq program, run by jaq.
    pub jq: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadQueryOutput {
    #[ts(type = "unknown[]")]
    #[schemars(with = "Vec<Value>")]
    pub results: Vec<Value>,
    /// The results' JSON text, in bytes.
    pub bytes: usize,
    /// Results were left out: over 1 MiB, or past 10 seconds.
    pub truncated: bool,
    pub ms: u64,
}

/// jq on a kept payload, on a blocking thread; only the results travel.
pub async fn query(
    store: &LargePayloads,
    input: PayloadQueryInput,
) -> Result<PayloadQueryOutput, ToolError> {
    let kept = store.require(&input.payload_id)?;
    if input.jq.trim().is_empty() {
        return Err(ToolError::invalid(TOOL, "jq", "a jq program is required"));
    }
    let started = Instant::now();
    let code = input.jq.clone();
    let run = tokio::task::spawn_blocking(move || {
        message_codecs::filter::run_jq_value(
            &code,
            &kept.value,
            QUERY_BYTES,
            Some(Instant::now() + QUERY_TIME),
        )
    });
    let out = tokio::time::timeout(QUERY_TIME + Duration::from_secs(1), run)
        .await
        .map_err(|_| ToolError::invalid(TOOL, "jq", "the program ran for over 10 seconds"))?
        .map_err(|e| {
            ToolError::new(
                crate::core::ToolErrorKind::Remote,
                TOOL,
                format!("jq stopped: {e}"),
            )
        })?
        .map_err(|issues| {
            let first = issues.into_iter().next();
            let mut error = ToolError::invalid(
                TOOL,
                "jq",
                first
                    .as_ref()
                    .map_or_else(|| "jq failed".to_owned(), |i| i.message.clone()),
            );
            if let Some(i) = first
                && let (Some(line), Some(column)) = (i.line, i.column)
            {
                error.position = Some(ErrorPosition { line, column });
            }
            error
        })?;
    Ok(PayloadQueryOutput {
        results: out.results,
        bytes: out.bytes,
        truncated: out.truncated,
        ms: started.elapsed().as_millis() as u64,
    })
}

/// What `temporal.payload.download` sends.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[ts(rename_all = "camelCase")]
pub enum PayloadForm {
    /// The decoded value as indented JSON.
    Decoded,
    /// The data the encoding read.
    Stored,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDownloadInput {
    pub conn_id: String,
    pub payload_id: String,
    pub form: PayloadForm,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PayloadDownloadSummary {
    pub bytes: u64,
}

/// The bytes a download sends.
pub fn download_bytes(kept: &Kept, form: PayloadForm) -> Vec<u8> {
    match form {
        PayloadForm::Decoded => serde_json::to_vec_pretty(&kept.value).unwrap_or_default(),
        PayloadForm::Stored => kept.stored.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn big(entries: usize) -> Value {
        json!({
            "warehouseIds": ["BER-1", "HAM-2"],
            "items": (0..entries).map(|i| json!({ "sku": format!("A-{i:05}"), "qty": i % 3, "history": "x".repeat(60) })).collect::<Vec<_>>(),
            "snapshotAt": "2026-11-18T10:29:58Z",
        })
    }

    fn kept(value: &Value) -> Kept {
        let stored = serde_json::to_vec(value).unwrap();
        Kept {
            decoded_bytes: stored.len(),
            value: value.clone(),
            stored,
            encoding: "json/plain".into(),
            codec: None,
        }
    }

    #[test]
    fn json_len_is_the_compact_text_length() {
        for v in [
            json!(null),
            json!(true),
            json!(false),
            json!(-12.5),
            json!("a \"q\" \\ é \n \u{1}"),
            json!({ "a/b": [1, 2, { "c": [] }], "d": {} }),
            big(3),
        ] {
            assert_eq!(json_len(&v), serde_json::to_vec(&v).unwrap().len(), "{v}");
        }
    }

    #[test]
    fn a_small_payload_stays_inline_and_a_large_one_becomes_a_stub() {
        let store = LargePayloads::default();
        let small = json!({ "a": 1 });
        assert!(stub_if_large(&store, &small, "json/plain", b"{\"a\":1}", None).is_none());
        let value = big(2_000);
        let data = serde_json::to_vec(&value).unwrap();
        let stub = stub_if_large(
            &store,
            &value,
            "json/plain",
            &data,
            Some(("codec.lab".into(), "binary/encrypted".into())),
        )
        .unwrap();
        let s = &stub["$large"];
        assert_eq!(s["bytes"], data.len());
        assert_eq!(s["decodedBytes"], data.len());
        assert_eq!(s["encoding"], "json/plain");
        assert_eq!(s["codec"]["from"], "binary/encrypted");
        assert!(s["preview"].as_str().unwrap().len() <= STUB_OVER);
        assert!(s["preview"].as_str().unwrap().starts_with("{\n"));
        // The same payload again: the same id, one copy.
        let again = stub_if_large(&store, &value, "json/plain", &data, None).unwrap();
        assert_eq!(again["$large"]["id"], s["id"]);
        assert_eq!(store.bytes(), data.len());
    }

    #[test]
    fn the_store_drops_the_least_recently_used_and_the_idle() {
        let store = LargePayloads::new(250);
        let t0 = Instant::now();
        let mk = |n: usize| Kept {
            value: json!(n),
            stored: vec![n as u8; 3],
            encoding: "json/plain".into(),
            codec: None,
            decoded_bytes: 100,
        };
        let a = store.keep_at(mk(1), t0);
        let b = store.keep_at(mk(2), t0 + Duration::from_secs(1));
        assert!(store.get_at(&a, t0 + Duration::from_secs(2)).is_some());
        // Over 250 bytes: b, the least recently used, goes.
        let c = store.keep_at(mk(3), t0 + Duration::from_secs(3));
        assert!(store.get_at(&b, t0 + Duration::from_secs(4)).is_none());
        assert!(store.get_at(&a, t0 + Duration::from_secs(4)).is_some());
        // Ten minutes unused: gone, and the error says to reload the event.
        let later = t0 + Duration::from_secs(4) + IDLE + Duration::from_secs(1);
        assert!(store.get_at(&c, later).is_none());
        assert!(store.get_at(&a, later).is_none());
        assert_eq!(store.bytes(), 0);
        let e = store.require(&a).unwrap_err();
        assert!(e.message.contains("reload the event"), "{}", e.message);
    }

    #[test]
    fn nodes_come_one_at_a_time_with_pages_of_children_and_the_root_names_the_largest_arrays() {
        let store = LargePayloads::default();
        let value = big(120);
        let id = store.keep(kept(&value));
        let input = |path: &str, offset: Option<u32>, limit: Option<u32>| PayloadNodeInput {
            conn_id: String::new(),
            payload_id: id.clone(),
            path: Some(path.into()),
            offset,
            limit,
        };
        let root = node(&store, &input("", None, None)).unwrap();
        assert_eq!(root.kind, PayloadKind::Object);
        assert_eq!(root.total, 3);
        let items = root.children.iter().find(|c| c.key == "items").unwrap();
        assert_eq!(items.length, Some(120));
        assert_eq!(items.bytes, json_len(&value["items"]));
        let info = root.info.unwrap();
        assert_eq!(info.largest_arrays[0].path, "/items");
        assert_eq!(info.largest_arrays[0].length, 120);
        assert_eq!(
            info.largest_arrays[0].entry_bytes,
            json_len(&value["items"]) / 120
        );
        let page = node(&store, &input("/items", Some(100), None)).unwrap();
        assert_eq!(page.total, 120);
        assert_eq!(page.children.len(), 20);
        assert_eq!(page.children[0].key, "100");
        assert_eq!(page.children[0].path, "/items/100");
        assert!(page.info.is_none());
        let leaf = node(&store, &input("/items/7/sku", None, None)).unwrap();
        assert_eq!(leaf.value, Some(json!("A-00007")));
        assert!(node(&store, &input("/nope", None, None)).is_err());
        assert!(node(&store, &input("items", None, None)).is_err());
        assert!(node(&store, &input("", None, Some(201))).is_err());
    }

    #[tokio::test]
    async fn jq_runs_on_the_server_and_reports_where_it_is_wrong() {
        let store = LargePayloads::default();
        let id = store.keep(kept(&big(30)));
        let q = |jq: &str| PayloadQueryInput {
            conn_id: String::new(),
            payload_id: id.clone(),
            jq: jq.into(),
        };
        let out = query(&store, q(".items | map(select(.qty == 0)) | length"))
            .await
            .unwrap();
        assert_eq!(out.results, vec![json!(10)]);
        assert!(!out.truncated);
        let bad = query(&store, q(".items | nope")).await.unwrap_err();
        assert_eq!(bad.field.as_deref(), Some("jq"));
        let gone = query(
            &store,
            PayloadQueryInput {
                payload_id: "0".repeat(32),
                ..q(".")
            },
        )
        .await
        .unwrap_err();
        assert_eq!(gone.resource.as_deref(), Some("payload"));
    }

    #[test]
    fn downloads_give_indented_json_or_the_stored_bytes() {
        let value = big(2);
        let k = kept(&value);
        assert_eq!(
            download_bytes(&k, PayloadForm::Stored),
            serde_json::to_vec(&value).unwrap()
        );
        let decoded: Value =
            serde_json::from_slice(&download_bytes(&k, PayloadForm::Decoded)).unwrap();
        assert_eq!(decoded, value);
    }
}
