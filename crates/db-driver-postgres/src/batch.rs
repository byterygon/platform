//! PostgreSQL result columns to Arrow record batches and IPC stream chunks.
//!
//! Types whose binary form maps exactly onto an Arrow type are requested in binary; every other
//! type (numeric, json, interval, arrays, enums, ...) is requested in text and becomes `Utf8`, so
//! no value is rounded or lost. Each field carries its type OID in [`TYPE_OID_METADATA`].
//!
//! `date` and `timestamp` infinities have no Arrow value; they become the minimum and maximum of
//! the Arrow type (`Date32` `i32::MIN`/`i32::MAX`, `Timestamp` `i64::MIN`/`i64::MAX`).

use std::collections::HashMap;
use std::sync::Arc;

use arrow_array::RecordBatch;
use arrow_array::builder::{
    ArrayBuilder, BinaryBuilder, BooleanBuilder, Date32Builder, FixedSizeBinaryBuilder,
    Float32Builder, Float64Builder, Int16Builder, Int32Builder, Int64Builder, StringBuilder,
    Time64MicrosecondBuilder, TimestampMicrosecondBuilder, UInt32Builder,
};
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{DataType, Field, Schema, SchemaRef, TimeUnit};
use db_driver::DbError;
use fallible_iterator::FallibleIterator;
use postgres_protocol::message::backend::{DataRowBody, RowDescriptionBody};
use postgres_protocol::types;

use crate::TYPE_OID_METADATA;

/// Days from 1970-01-01 to PostgreSQL's epoch 2000-01-01.
const PG_EPOCH_DAYS: i32 = 10_957;
/// Microseconds from 1970-01-01 to 2000-01-01.
const PG_EPOCH_MICROS: i64 = 946_684_800_000_000;

/// Batch flush threshold in value bytes, so wide rows do not make huge chunks.
pub(crate) const MAX_BATCH_BYTES: usize = 8 << 20;
/// Rows per batch when the caller gives no hint.
pub(crate) const DEFAULT_BATCH_ROWS: usize = 4096;

/// Format codes in `Bind`.
const TEXT: i16 = 0;
const BINARY: i16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Bool,
    Int2,
    Int4,
    Int8,
    Oid,
    Float4,
    Float8,
    /// text, varchar, bpchar, name: the binary form is the UTF-8 text.
    Text,
    Bytea,
    Uuid,
    Date,
    Time,
    Timestamp,
    TimestampTz,
    /// Any other type, received in text format.
    Other,
}

impl Kind {
    fn of(oid: u32) -> Kind {
        match oid {
            16 => Kind::Bool,
            17 => Kind::Bytea,
            19 | 25 | 1042 | 1043 => Kind::Text,
            20 => Kind::Int8,
            21 => Kind::Int2,
            23 => Kind::Int4,
            26 => Kind::Oid,
            700 => Kind::Float4,
            701 => Kind::Float8,
            1082 => Kind::Date,
            1083 => Kind::Time,
            1114 => Kind::Timestamp,
            1184 => Kind::TimestampTz,
            2950 => Kind::Uuid,
            _ => Kind::Other,
        }
    }

    fn format(self) -> i16 {
        match self {
            Kind::Other => TEXT,
            _ => BINARY,
        }
    }

    fn data_type(self) -> DataType {
        match self {
            Kind::Bool => DataType::Boolean,
            Kind::Int2 => DataType::Int16,
            Kind::Int4 => DataType::Int32,
            Kind::Int8 => DataType::Int64,
            Kind::Oid => DataType::UInt32,
            Kind::Float4 => DataType::Float32,
            Kind::Float8 => DataType::Float64,
            Kind::Text | Kind::Other => DataType::Utf8,
            Kind::Bytea => DataType::Binary,
            Kind::Uuid => DataType::FixedSizeBinary(16),
            Kind::Date => DataType::Date32,
            Kind::Time => DataType::Time64(TimeUnit::Microsecond),
            Kind::Timestamp => DataType::Timestamp(TimeUnit::Microsecond, None),
            Kind::TimestampTz => DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        }
    }

    fn builder(self) -> Box<dyn ArrayBuilder> {
        match self {
            Kind::Bool => Box::new(BooleanBuilder::new()),
            Kind::Int2 => Box::new(Int16Builder::new()),
            Kind::Int4 => Box::new(Int32Builder::new()),
            Kind::Int8 => Box::new(Int64Builder::new()),
            Kind::Oid => Box::new(UInt32Builder::new()),
            Kind::Float4 => Box::new(Float32Builder::new()),
            Kind::Float8 => Box::new(Float64Builder::new()),
            Kind::Text | Kind::Other => Box::new(StringBuilder::new()),
            Kind::Bytea => Box::new(BinaryBuilder::new()),
            Kind::Uuid => Box::new(FixedSizeBinaryBuilder::new(16)),
            Kind::Date => Box::new(Date32Builder::new()),
            Kind::Time => Box::new(Time64MicrosecondBuilder::new()),
            Kind::Timestamp => Box::new(TimestampMicrosecondBuilder::new()),
            Kind::TimestampTz => Box::new(TimestampMicrosecondBuilder::new().with_timezone("UTC")),
        }
    }
}

/// The result columns of a statement, from its `RowDescription` (none for `NoData`).
pub(crate) struct Columns {
    kinds: Vec<Kind>,
    schema: SchemaRef,
}

impl Columns {
    pub(crate) fn none() -> Self {
        Self {
            kinds: Vec::new(),
            schema: Arc::new(Schema::empty()),
        }
    }

    pub(crate) fn describe(body: &RowDescriptionBody) -> Result<Self, DbError> {
        let mut kinds = Vec::new();
        let mut fields = Vec::new();
        let mut it = body.fields();
        while let Some(f) = it.next().map_err(|_| DbError::ConnectionLost)? {
            let kind = Kind::of(f.type_oid());
            let mut metadata =
                HashMap::from([(TYPE_OID_METADATA.to_owned(), f.type_oid().to_string())]);
            if kind == Kind::Uuid {
                metadata.insert("ARROW:extension:name".into(), "arrow.uuid".into());
                metadata.insert("ARROW:extension:metadata".into(), String::new());
            }
            fields.push(Field::new(f.name(), kind.data_type(), true).with_metadata(metadata));
            kinds.push(kind);
        }
        Ok(Self {
            kinds,
            schema: Arc::new(Schema::new(fields)),
        })
    }

    pub(crate) fn has_rows(&self) -> bool {
        !self.kinds.is_empty()
    }

    /// Result format codes for `Bind`, one per column.
    pub(crate) fn formats(&self) -> Vec<i16> {
        self.kinds.iter().map(|k| k.format()).collect()
    }

    pub(crate) fn schema(&self) -> &SchemaRef {
        &self.schema
    }
}

/// Accumulates rows into one record batch.
pub(crate) struct BatchBuilder {
    kinds: Vec<Kind>,
    schema: SchemaRef,
    builders: Vec<Box<dyn ArrayBuilder>>,
    rows: usize,
    bytes: usize,
}

impl BatchBuilder {
    pub(crate) fn new(columns: &Columns) -> Self {
        Self {
            kinds: columns.kinds.clone(),
            schema: columns.schema.clone(),
            builders: columns.kinds.iter().map(|k| k.builder()).collect(),
            rows: 0,
            bytes: 0,
        }
    }

    pub(crate) fn rows(&self) -> usize {
        self.rows
    }

    pub(crate) fn bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn append(&mut self, row: &DataRowBody) -> Result<(), DbError> {
        let buf = row.buffer();
        let mut ranges = row.ranges();
        let mut i = 0;
        while let Some(range) = ranges.next().map_err(|_| DbError::ConnectionLost)? {
            let (Some(kind), Some(builder)) = (self.kinds.get(i), self.builders.get_mut(i)) else {
                return Err(DbError::ConnectionLost);
            };
            let value = range.map(|r| &buf[r]);
            self.bytes += value.map_or(1, <[u8]>::len);
            append(*kind, builder.as_any_mut(), value).map_err(|_| DbError::ConnectionLost)?;
            i += 1;
        }
        if i != self.kinds.len() {
            return Err(DbError::ConnectionLost);
        }
        self.rows += 1;
        Ok(())
    }

    /// The accumulated rows as a batch; the builder starts over.
    pub(crate) fn finish(&mut self) -> Result<RecordBatch, DbError> {
        let columns = self.builders.iter_mut().map(|b| b.finish()).collect();
        self.rows = 0;
        self.bytes = 0;
        RecordBatch::try_new(self.schema.clone(), columns).map_err(|_| DbError::Internal)
    }
}

type DecodeError = Box<dyn std::error::Error + Sync + Send>;

macro_rules! put {
    ($builder:expr, $ty:ty, $value:expr, $decode:expr) => {{
        let b = $builder
            .downcast_mut::<$ty>()
            .ok_or("builder type mismatch")?;
        match $value {
            None => b.append_null(),
            Some(v) => b.append_value($decode(v)?),
        }
    }};
}

fn append(kind: Kind, b: &mut dyn std::any::Any, v: Option<&[u8]>) -> Result<(), DecodeError> {
    match kind {
        Kind::Bool => put!(b, BooleanBuilder, v, types::bool_from_sql),
        Kind::Int2 => put!(b, Int16Builder, v, types::int2_from_sql),
        Kind::Int4 => put!(b, Int32Builder, v, types::int4_from_sql),
        Kind::Int8 => put!(b, Int64Builder, v, types::int8_from_sql),
        Kind::Oid => put!(b, UInt32Builder, v, types::oid_from_sql),
        Kind::Float4 => put!(b, Float32Builder, v, types::float4_from_sql),
        Kind::Float8 => put!(b, Float64Builder, v, types::float8_from_sql),
        Kind::Text | Kind::Other => put!(b, StringBuilder, v, std::str::from_utf8),
        Kind::Bytea => put!(b, BinaryBuilder, v, Ok::<_, DecodeError>),
        Kind::Uuid => {
            let b = b
                .downcast_mut::<FixedSizeBinaryBuilder>()
                .ok_or("builder type mismatch")?;
            match v {
                None => b.append_null(),
                Some(v) => b.append_value(types::uuid_from_sql(v)?)?,
            }
        }
        Kind::Date => put!(b, Date32Builder, v, |v| types::date_from_sql(v).map(date)),
        Kind::Time => put!(b, Time64MicrosecondBuilder, v, types::time_from_sql),
        Kind::Timestamp | Kind::TimestampTz => {
            put!(b, TimestampMicrosecondBuilder, v, |v| {
                types::timestamp_from_sql(v).map(timestamp)
            })
        }
    }
    Ok(())
}

/// PostgreSQL days since 2000-01-01 to Arrow days since 1970-01-01; infinities saturate.
fn date(days: i32) -> i32 {
    match days {
        i32::MAX | i32::MIN => days,
        d => d.saturating_add(PG_EPOCH_DAYS),
    }
}

/// PostgreSQL microseconds since 2000-01-01 to Unix microseconds; infinities saturate.
fn timestamp(micros: i64) -> i64 {
    match micros {
        i64::MAX | i64::MIN => micros,
        m => m.saturating_add(PG_EPOCH_MICROS),
    }
}

/// Writes one Arrow IPC stream incrementally; each call returns whole messages only.
pub(crate) struct IpcStream {
    writer: StreamWriter<Vec<u8>>,
}

impl IpcStream {
    /// Starts the stream; [`IpcStream::take`] then returns the schema message.
    pub(crate) fn new(schema: &Schema) -> Result<Self, DbError> {
        let writer = StreamWriter::try_new(Vec::new(), schema).map_err(|_| DbError::Internal)?;
        Ok(Self { writer })
    }

    pub(crate) fn write(&mut self, batch: &RecordBatch) -> Result<(), DbError> {
        self.writer.write(batch).map_err(|_| DbError::Internal)
    }

    /// Writes the end-of-stream marker.
    pub(crate) fn finish(&mut self) -> Result<(), DbError> {
        self.writer.finish().map_err(|_| DbError::Internal)
    }

    /// The bytes written since the last call.
    pub(crate) fn take(&mut self) -> Vec<u8> {
        std::mem::take(self.writer.get_mut())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epochs_shift_and_infinities_saturate() {
        assert_eq!(date(0), PG_EPOCH_DAYS);
        assert_eq!(date(i32::MAX), i32::MAX);
        assert_eq!(date(i32::MIN), i32::MIN);
        assert_eq!(timestamp(0), PG_EPOCH_MICROS);
        assert_eq!(timestamp(i64::MAX), i64::MAX);
        assert_eq!(timestamp(i64::MIN), i64::MIN);
    }

    #[test]
    fn exact_types_are_binary_and_the_rest_text() {
        for oid in [
            16, 17, 20, 21, 23, 25, 26, 700, 701, 1082, 1083, 1114, 1184, 2950,
        ] {
            assert_eq!(Kind::of(oid).format(), BINARY, "oid {oid}");
        }
        // numeric, json, jsonb, interval, int4[], timetz
        for oid in [1700, 114, 3802, 1186, 1007, 1266] {
            assert_eq!(Kind::of(oid), Kind::Other, "oid {oid}");
            assert_eq!(Kind::of(oid).data_type(), DataType::Utf8);
        }
    }
}
