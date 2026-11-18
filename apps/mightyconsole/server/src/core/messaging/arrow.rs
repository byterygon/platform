//! Messages as Arrow record batches with one fixed schema, `mightyconsole.message` version 1
//! (Mightyconsole spec §5.1), so message lists reuse the data grid and the Arrow Worker.
//!
//! `source` and `timestampKind` are plain Utf8, not dictionary columns: the UI's Arrow decoder
//! reads no dictionaries (spec Open question 34).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use arrow_array::builder::{
    BinaryBuilder, BooleanBuilder, Int32Builder, Int64Builder, StringBuilder,
    TimestampMicrosecondBuilder, UInt64Builder,
};
use arrow_array::{ArrayRef, RecordBatch};
use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
use message_codecs::{Decoded, Message};

/// Schema metadata naming the format.
pub const SCHEMA_KEY: &str = "mightyconsole.schema";
pub const SCHEMA_VALUE: &str = "message/1";

/// The schema of every message batch.
pub static MESSAGE_SCHEMA: LazyLock<SchemaRef> = LazyLock::new(|| {
    let f = |name: &str, t: DataType, nullable: bool| Field::new(name, t, nullable);
    let utf8 = DataType::Utf8;
    Arc::new(Schema::new_with_metadata(
        vec![
            f("rowId", DataType::UInt64, false),
            f("source", utf8.clone(), false),
            f("subject", utf8.clone(), true),
            f("partition", DataType::Int32, true),
            f("offset", DataType::Int64, true),
            f("sequence", DataType::UInt64, true),
            f(
                "timestamp",
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
                false,
            ),
            f("timestampKind", utf8.clone(), false),
            f("operation", utf8.clone(), true),
            f("replyTo", utf8.clone(), true),
            f("headers", utf8.clone(), true),
            f("keyRaw", DataType::Binary, true),
            f("keyText", utf8.clone(), true),
            f("keyCodec", utf8.clone(), true),
            f("payloadRaw", DataType::Binary, false),
            f("payloadSize", DataType::Int64, false),
            f("payloadTruncated", DataType::Boolean, false),
            f("payloadText", utf8.clone(), true),
            f("payloadCodec", utf8.clone(), false),
            f("schemaRef", utf8.clone(), true),
            f("decodeError", utf8, true),
        ],
        HashMap::from([(SCHEMA_KEY.to_owned(), SCHEMA_VALUE.to_owned())]),
    ))
});

/// One message ready for a batch: the message, its decoded key and value, and the inline cut.
#[derive(Debug, Clone)]
pub struct Row {
    pub row_id: u64,
    pub message: Message,
    pub key: Option<Decoded>,
    pub value: Decoded,
    /// The payload bytes kept inline (at most the cap).
    pub inline_len: usize,
    /// The value as the filter's jq sees it: the JSON, or the text as a string.
    pub filter_value: serde_json::Value,
}

impl Row {
    /// The `decodeError` column: the value's error, the key's prefixed with `key:`.
    pub fn decode_error(&self) -> Option<String> {
        match (
            self.value.error.as_deref(),
            self.key.as_ref().and_then(|k| k.error.as_deref()),
        ) {
            (None, None) => None,
            (Some(v), None) => Some(v.to_owned()),
            (None, Some(k)) => Some(format!("key: {k}")),
            (Some(v), Some(k)) => Some(format!("{v}; key: {k}")),
        }
    }

    /// Bytes the row adds to a batch, roughly (for the 1 MiB coalescing limit).
    pub fn weight(&self) -> usize {
        64 + self.message.source.len()
            + self.message.subject.as_ref().map_or(0, String::len)
            + self.message.key.as_ref().map_or(0, Vec::len)
            + self
                .key
                .as_ref()
                .and_then(|k| k.text.as_ref())
                .map_or(0, String::len)
            + self.inline_len
            + self.value.text.as_ref().map_or(0, String::len)
            + self.message.headers.as_ref().map_or(0, |h| {
                h.iter().map(|h| h.name.len() + h.value.len() * 2).sum()
            })
    }
}

/// Builds message batches.
pub struct BatchBuilder {
    row_id: UInt64Builder,
    source: StringBuilder,
    subject: StringBuilder,
    partition: Int32Builder,
    offset: Int64Builder,
    sequence: UInt64Builder,
    timestamp: TimestampMicrosecondBuilder,
    timestamp_kind: StringBuilder,
    operation: StringBuilder,
    reply_to: StringBuilder,
    headers: StringBuilder,
    key_raw: BinaryBuilder,
    key_text: StringBuilder,
    key_codec: StringBuilder,
    payload_raw: BinaryBuilder,
    payload_size: Int64Builder,
    payload_truncated: BooleanBuilder,
    payload_text: StringBuilder,
    payload_codec: StringBuilder,
    schema_ref: StringBuilder,
    decode_error: StringBuilder,
    rows: usize,
    bytes: usize,
}

impl Default for BatchBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl BatchBuilder {
    pub fn new() -> Self {
        Self {
            row_id: UInt64Builder::new(),
            source: StringBuilder::new(),
            subject: StringBuilder::new(),
            partition: Int32Builder::new(),
            offset: Int64Builder::new(),
            sequence: UInt64Builder::new(),
            timestamp: TimestampMicrosecondBuilder::new().with_timezone("UTC"),
            timestamp_kind: StringBuilder::new(),
            operation: StringBuilder::new(),
            reply_to: StringBuilder::new(),
            headers: StringBuilder::new(),
            key_raw: BinaryBuilder::new(),
            key_text: StringBuilder::new(),
            key_codec: StringBuilder::new(),
            payload_raw: BinaryBuilder::new(),
            payload_size: Int64Builder::new(),
            payload_truncated: BooleanBuilder::new(),
            payload_text: StringBuilder::new(),
            payload_codec: StringBuilder::new(),
            schema_ref: StringBuilder::new(),
            decode_error: StringBuilder::new(),
            rows: 0,
            bytes: 0,
        }
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn is_empty(&self) -> bool {
        self.rows == 0
    }

    pub fn push(&mut self, row: &Row) {
        let m = &row.message;
        self.row_id.append_value(row.row_id);
        self.source.append_value(&m.source);
        self.subject.append_option(m.subject.as_deref());
        self.partition.append_option(m.partition);
        self.offset.append_option(m.offset);
        self.sequence.append_option(m.sequence);
        self.timestamp.append_value(m.timestamp_us);
        self.timestamp_kind.append_value(m.timestamp_kind.as_str());
        self.operation
            .append_option(m.operation.map(|o| o.as_str()));
        self.reply_to.append_option(m.reply_to.as_deref());
        self.headers.append_option(m.headers_json());
        self.key_raw.append_option(m.key.as_deref());
        self.key_text
            .append_option(row.key.as_ref().and_then(|k| k.text.as_deref()));
        self.key_codec
            .append_option(row.key.as_ref().map(|k| k.codec.as_str()));
        self.payload_raw
            .append_value(&m.payload[..row.inline_len.min(m.payload.len())]);
        self.payload_size.append_value(m.payload.len() as i64);
        self.payload_truncated
            .append_value(row.inline_len < m.payload.len());
        self.payload_text.append_option(row.value.text.as_deref());
        self.payload_codec.append_value(row.value.codec.as_str());
        self.schema_ref
            .append_option(row.value.schema_ref.as_deref());
        self.decode_error.append_option(row.decode_error());
        self.rows += 1;
        self.bytes += row.weight();
    }

    /// The batch of the rows pushed so far; the builder starts over.
    pub fn finish(&mut self) -> RecordBatch {
        let columns: Vec<ArrayRef> = vec![
            Arc::new(self.row_id.finish()),
            Arc::new(self.source.finish()),
            Arc::new(self.subject.finish()),
            Arc::new(self.partition.finish()),
            Arc::new(self.offset.finish()),
            Arc::new(self.sequence.finish()),
            Arc::new(self.timestamp.finish()),
            Arc::new(self.timestamp_kind.finish()),
            Arc::new(self.operation.finish()),
            Arc::new(self.reply_to.finish()),
            Arc::new(self.headers.finish()),
            Arc::new(self.key_raw.finish()),
            Arc::new(self.key_text.finish()),
            Arc::new(self.key_codec.finish()),
            Arc::new(self.payload_raw.finish()),
            Arc::new(self.payload_size.finish()),
            Arc::new(self.payload_truncated.finish()),
            Arc::new(self.payload_text.finish()),
            Arc::new(self.payload_codec.finish()),
            Arc::new(self.schema_ref.finish()),
            Arc::new(self.decode_error.finish()),
        ];
        self.rows = 0;
        self.bytes = 0;
        RecordBatch::try_new(MESSAGE_SCHEMA.clone(), columns)
            .expect("the builders follow the schema")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow_array::{Array, BinaryArray, BooleanArray, Int64Array, StringArray};
    use message_codecs::{CodecId, Header, TimestampKind};

    fn decoded(text: &str) -> Decoded {
        Decoded {
            codec: CodecId::Json,
            text: Some(text.into()),
            json: None,
            schema_ref: None,
            error: None,
        }
    }

    #[test]
    fn a_batch_has_the_schema_of_5_1() {
        let mut m = Message::new(
            "orders",
            b"{\"a\":1}".to_vec(),
            1_000,
            TimestampKind::Create,
        );
        m.partition = Some(3);
        m.offset = Some(41);
        m.key = Some(b"k".to_vec());
        m.headers = Some(vec![Header::new("h", "v")]);
        let mut b = BatchBuilder::new();
        b.push(&Row {
            row_id: 0,
            message: m.clone(),
            key: Some(decoded("k")),
            value: decoded("{\"a\":1}"),
            inline_len: 7,
            filter_value: serde_json::Value::Null,
        });
        let mut big = m;
        big.payload = vec![b'x'; 10];
        b.push(&Row {
            row_id: 1,
            message: big,
            key: None,
            value: Decoded {
                codec: CodecId::Utf8,
                text: None,
                json: None,
                schema_ref: Some("local:s".into()),
                error: Some("bad".into()),
            },
            inline_len: 4,
            filter_value: serde_json::Value::Null,
        });
        assert_eq!(b.rows(), 2);
        let batch = b.finish();
        assert!(b.is_empty());
        assert_eq!(
            batch
                .schema()
                .metadata()
                .get(SCHEMA_KEY)
                .map(String::as_str),
            Some(SCHEMA_VALUE)
        );
        assert_eq!(batch.num_columns(), 21);
        let col = |n: &str| batch.column_by_name(n).unwrap().clone();
        let raw = col("payloadRaw");
        let raw = raw.as_any().downcast_ref::<BinaryArray>().unwrap();
        assert_eq!(raw.value(1), b"xxxx");
        let size = col("payloadSize");
        assert_eq!(
            size.as_any().downcast_ref::<Int64Array>().unwrap().value(1),
            10
        );
        let trunc = col("payloadTruncated");
        let trunc = trunc.as_any().downcast_ref::<BooleanArray>().unwrap();
        assert!(!trunc.value(0) && trunc.value(1));
        let headers = col("headers");
        assert_eq!(
            headers
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap()
                .value(0),
            r#"[["h","v","text"]]"#
        );
        let err = col("decodeError");
        let err = err.as_any().downcast_ref::<StringArray>().unwrap();
        assert!(err.is_null(0));
        assert_eq!(err.value(1), "bad");
        assert!(col("payloadText").is_null(1));
    }
}
