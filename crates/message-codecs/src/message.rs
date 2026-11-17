//! The message model (Mightyconsole spec §5.1): one record for a Kafka record, a NATS message, a
//! JetStream message or a KV entry. Each system fills what it has and leaves the rest empty; the
//! model names no system-specific concept beyond the columns of §5.1 (a partition and offset for
//! Kafka, a sequence for JetStream and KV, a reply subject for NATS), and hides none.
//!
//! Raw bytes are always kept: decoding adds text next to them, never in place of them.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::{Deserialize, Serialize};

/// What a message's timestamp means (spec §5.1, `timestampKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimestampKind {
    /// Kafka `CreateTime`.
    Create,
    /// Kafka `LogAppendTime`.
    LogAppend,
    /// Core NATS: when the server received it.
    Received,
    /// JetStream and KV: when the stream stored it.
    Stored,
}

impl TimestampKind {
    pub fn as_str(self) -> &'static str {
        match self {
            TimestampKind::Create => "create",
            TimestampKind::LogAppend => "log-append",
            TimestampKind::Received => "received",
            TimestampKind::Stored => "stored",
        }
    }
}

/// A KV entry's operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Operation {
    Put,
    Delete,
    Purge,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Operation::Put => "put",
            Operation::Delete => "delete",
            Operation::Purge => "purge",
        }
    }
}

/// One header. Names repeat when a system allows several values (NATS); order is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Header {
    pub name: String,
    pub value: Vec<u8>,
}

impl Header {
    pub fn new(name: impl Into<String>, value: impl Into<Vec<u8>>) -> Self {
        Self {
            name: name.into(),
            value: value.into(),
        }
    }

    /// The value as text when it is valid UTF-8.
    pub fn text(&self) -> Option<&str> {
        std::str::from_utf8(&self.value).ok()
    }
}

/// One message as a backend reads it, before decoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Message {
    /// Topic (Kafka), subject (core NATS), stream (JetStream) or bucket (KV).
    pub source: String,
    /// NATS subject, or the KV key.
    pub subject: Option<String>,
    pub partition: Option<i32>,
    pub offset: Option<i64>,
    /// JetStream stream sequence, or KV revision.
    pub sequence: Option<u64>,
    /// Microseconds since the Unix epoch, UTC.
    pub timestamp_us: i64,
    pub timestamp_kind: TimestampKind,
    pub operation: Option<Operation>,
    pub reply_to: Option<String>,
    /// `None` when the system has no headers for this message (KV), empty when it has none.
    pub headers: Option<Vec<Header>>,
    /// Kafka key; `None` for a null key and for NATS.
    pub key: Option<Vec<u8>>,
    /// Value bytes; Kafka tombstones have an empty payload and `tombstone` set.
    pub payload: Vec<u8>,
    /// A Kafka record with a null value.
    pub tombstone: bool,
}

impl Message {
    /// A message with a source, a payload and a timestamp; everything else empty.
    pub fn new(
        source: impl Into<String>,
        payload: impl Into<Vec<u8>>,
        timestamp_us: i64,
        kind: TimestampKind,
    ) -> Self {
        Self {
            source: source.into(),
            subject: None,
            partition: None,
            offset: None,
            sequence: None,
            timestamp_us,
            timestamp_kind: kind,
            operation: None,
            reply_to: None,
            headers: None,
            key: None,
            payload: payload.into(),
            tombstone: false,
        }
    }

    /// The `headers` column (spec §5.1): JSON `[[name, value, "text" | "base64"], …]`, text when
    /// the value is valid UTF-8.
    pub fn headers_json(&self) -> Option<String> {
        self.headers.as_ref().map(|h| headers_json(h))
    }
}

/// The `headers` column for a list of headers.
pub fn headers_json(headers: &[Header]) -> String {
    let rows: Vec<serde_json::Value> = headers
        .iter()
        .map(|h| match h.text() {
            Some(t) => serde_json::json!([h.name, t, "text"]),
            None => serde_json::json!([h.name, BASE64.encode(&h.value), "base64"]),
        })
        .collect();
    serde_json::Value::Array(rows).to_string()
}

/// A header as the UI sends it (Composer, KeyValueEditor): text or base64.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct HeaderInput {
    pub key: String,
    pub value: String,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub encoding: Option<HeaderEncoding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum HeaderEncoding {
    Text,
    Base64,
}

impl HeaderInput {
    /// The header's bytes.
    pub fn to_header(&self) -> crate::Result<Header> {
        let value = match self.encoding.unwrap_or(HeaderEncoding::Text) {
            HeaderEncoding::Text => self.value.clone().into_bytes(),
            HeaderEncoding::Base64 => BASE64.decode(self.value.trim()).map_err(|e| {
                crate::CodecError::invalid(format!("header {}: not valid base64: {e}", self.key))
                    .field("headers")
            })?,
        };
        Ok(Header::new(self.key.clone(), value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_column() {
        let h = vec![
            Header::new("a", "x"),
            Header::new("a", "y"),
            Header::new("bin", vec![0xff, 0]),
        ];
        assert_eq!(
            headers_json(&h),
            r#"[["a","x","text"],["a","y","text"],["bin","/wA=","base64"]]"#
        );
        let input = HeaderInput {
            key: "k".into(),
            value: "/wA=".into(),
            encoding: Some(HeaderEncoding::Base64),
        };
        assert_eq!(input.to_header().unwrap().value, vec![0xff, 0]);
    }
}
