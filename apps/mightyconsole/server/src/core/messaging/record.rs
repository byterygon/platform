//! One message as JSON (Mightyconsole spec §6.5, `MessageRecord`): the columns of one §5.1 row,
//! for procedures that answer with a single message rather than a stream of batches (a NATS
//! request's reply, a JetStream or KV get, a Kafka get). Bytes are base64; offsets and sequences
//! are decimal strings, as everywhere on the wire, so 64 bits stay exact in TypeScript.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use message_codecs::CodecId;
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

use super::arrow::Row;

/// How a header value travels: as text when it is valid UTF-8, else as base64.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum RecordHeaderEncoding {
    Text,
    Base64,
}

/// One header of a [`MessageRecord`]; names repeat when the system allows several values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecordHeader {
    pub name: String,
    pub value: String,
    pub encoding: RecordHeaderEncoding,
}

/// One §5.1 row as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    /// Topic, subject, stream or bucket.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub partition: Option<i32>,
    /// Decimal.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<String>,
    /// Stream sequence or KV revision, decimal.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sequence: Option<String>,
    /// Microseconds since the epoch, UTC.
    pub timestamp_us: i64,
    /// `create`, `log-append`, `received` or `stored`.
    pub timestamp_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub operation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reply_to: Option<String>,
    /// `None` when the system has no headers for this message (KV).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub headers: Option<Vec<RecordHeader>>,
    /// Base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_raw: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key_codec: Option<CodecId>,
    /// Base64, the bytes kept inline (all of them unless `payloadTruncated`).
    pub payload_raw: String,
    pub payload_size: u64,
    pub payload_truncated: bool,
    /// The decoded value: canonical JSON text, or text.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub payload_text: Option<String>,
    pub payload_codec: CodecId,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub decode_error: Option<String>,
}

impl MessageRecord {
    /// The record of a decoded row, as a batch would carry it.
    pub fn from_row(row: &Row) -> MessageRecord {
        let m = &row.message;
        let headers = m.headers.as_ref().map(|hs| {
            hs.iter()
                .map(|h| match h.text() {
                    Some(t) => RecordHeader {
                        name: h.name.clone(),
                        value: t.to_owned(),
                        encoding: RecordHeaderEncoding::Text,
                    },
                    None => RecordHeader {
                        name: h.name.clone(),
                        value: BASE64.encode(&h.value),
                        encoding: RecordHeaderEncoding::Base64,
                    },
                })
                .collect()
        });
        MessageRecord {
            source: m.source.clone(),
            subject: m.subject.clone(),
            partition: m.partition,
            offset: m.offset.map(|o| o.to_string()),
            sequence: m.sequence.map(|s| s.to_string()),
            timestamp_us: m.timestamp_us,
            timestamp_kind: m.timestamp_kind.as_str().to_owned(),
            operation: m.operation.map(|o| o.as_str().to_owned()),
            reply_to: m.reply_to.clone(),
            headers,
            key_raw: m.key.as_ref().map(|k| BASE64.encode(k)),
            key_text: row.key.as_ref().and_then(|k| k.text.clone()),
            key_codec: row.key.as_ref().map(|k| k.codec),
            payload_raw: BASE64.encode(&m.payload[..row.inline_len.min(m.payload.len())]),
            payload_size: m.payload.len() as u64,
            payload_truncated: row.inline_len < m.payload.len(),
            payload_text: row.value.text.clone(),
            payload_codec: row.value.codec,
            schema_ref: row.value.schema_ref.clone(),
            decode_error: row.decode_error(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use message_codecs::{Codecs, DecodeOptions, Header, Message, TimestampKind};

    #[tokio::test]
    async fn a_row_as_json() {
        let mut m = Message::new(
            "_INBOX.x",
            br#"{"a":1}"#.to_vec(),
            1_700_000_000_000_000,
            TimestampKind::Received,
        );
        m.subject = Some("_INBOX.x".into());
        m.headers = Some(vec![Header::new("t", "x"), Header::new("b", vec![0xff])]);
        let row =
            super::super::decode_row(&Codecs::default(), m, &DecodeOptions::default(), None, 0)
                .await;
        let r = MessageRecord::from_row(&row);
        assert_eq!(r.payload_codec, CodecId::Json);
        assert_eq!(r.payload_text.as_deref(), Some(r#"{"a":1}"#));
        assert_eq!(r.payload_raw, BASE64.encode(br#"{"a":1}"#));
        assert!(!r.payload_truncated);
        let h = r.headers.unwrap();
        assert_eq!(h[0].encoding, RecordHeaderEncoding::Text);
        assert_eq!(
            (h[1].value.as_str(), h[1].encoding),
            ("/w==", RecordHeaderEncoding::Base64)
        );
        let json = serde_json::to_value(MessageRecord::from_row(&row)).unwrap();
        assert_eq!(json["timestampKind"], "received");
        assert!(json.get("partition").is_none());
    }
}
