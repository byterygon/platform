//! Export encoders (DBee spec §3.8 and Decision 15): CSV, TSV and JSON Lines from the driver's
//! Arrow IPC chunks, decoded in Rust.
//!
//! Cell text follows the grid's rendering rules (DBee spec §6) where a text form exists: integers
//! in decimal without grouping, `Int64` exactly, floats in their shortest round-trip form, bytes
//! as `\x` hex, uuids in 8-4-4-4-12 form, dates as ISO dates, times and timestamps with the
//! microsecond fraction trimmed of trailing zeros, timestamps with a zone in UTC with `+00:00`.
//! `NULL` is the configured null text in CSV and TSV and `null` in JSON Lines, distinct from the
//! empty string. JSON Lines writes numbers and booleans as JSON values (`NaN` and infinities as
//! strings, since JSON has none), everything else as strings.

use std::fmt::Write as _;

use arrow_array::cast::AsArray;
use arrow_array::types::{
    Date32Type, Float32Type, Float64Type, Int16Type, Int32Type, Int64Type, Time64MicrosecondType,
    TimestampMicrosecondType, UInt32Type,
};
use arrow_array::{Array, ArrayRef, RecordBatch};
use arrow_buffer::Buffer;
use arrow_ipc::reader::StreamDecoder;
use arrow_schema::{DataType, SchemaRef, TimeUnit};

use crate::types::{ExportFormat, ExportOptions, LineEnding};

/// Decodes a driver's Arrow IPC stream chunk by chunk.
#[derive(Default)]
pub struct IpcDecoder {
    decoder: StreamDecoder,
    schema: Option<SchemaRef>,
}

impl IpcDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn schema(&self) -> Option<&SchemaRef> {
        self.schema.as_ref()
    }

    /// The record batches completed by `chunk` (whole IPC messages, so none is left half read).
    /// The schema becomes known with the chunk after the schema message (the decoder finishes a
    /// bodiless message when the next bytes arrive), so a result always has it by its end.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<RecordBatch>, EncodeError> {
        let mut buffer = Buffer::from(chunk);
        let mut batches = Vec::new();
        while !buffer.is_empty() {
            match self.decoder.decode(&mut buffer) {
                Ok(Some(batch)) => batches.push(batch),
                Ok(None) => {}
                Err(_) => return Err(EncodeError::Decode),
            }
        }
        if self.schema.is_none() {
            self.schema = self.decoder.schema();
        }
        Ok(batches)
    }
}

/// Why encoding stopped. Messages never quote data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeError {
    /// The chunks are not an Arrow IPC stream.
    Decode,
    /// A column has a type the encoder does not know.
    UnsupportedType,
}

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            EncodeError::Decode => "the result is not an Arrow stream",
            EncodeError::UnsupportedType => "a column type cannot be exported",
        })
    }
}

impl std::error::Error for EncodeError {}

/// Encodes record batches into one text format.
pub struct Encoder {
    format: ExportFormat,
    options: ExportOptions,
    header_written: bool,
    rows: u64,
}

impl Encoder {
    pub fn new(format: ExportFormat, options: ExportOptions) -> Self {
        Encoder {
            format,
            options,
            header_written: false,
            rows: 0,
        }
    }

    pub fn rows(&self) -> u64 {
        self.rows
    }

    fn newline(&self) -> &'static str {
        match self.options.line_ending {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }

    /// The header line for `schema` if the format has one and it was not written yet. Call it
    /// once the schema is known, so a result without rows still gets its header.
    pub fn header(&mut self, schema: &SchemaRef) -> String {
        if self.header_written {
            return String::new();
        }
        self.header_written = true;
        if !self.options.header {
            return String::new();
        }
        let names: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        match self.format {
            ExportFormat::Csv => {
                let mut out = String::new();
                for (i, name) in names.iter().enumerate() {
                    if i > 0 {
                        out.push_str(&self.options.delimiter);
                    }
                    self.csv_field(&mut out, name);
                }
                out.push_str(self.newline());
                out
            }
            ExportFormat::Tsv => {
                let mut out = String::new();
                for (i, name) in names.iter().enumerate() {
                    if i > 0 {
                        out.push('\t');
                    }
                    tsv_escape(&mut out, name);
                }
                out.push_str(self.newline());
                out
            }
            // JSON Lines carries the names in every object.
            ExportFormat::Jsonl => String::new(),
        }
    }

    /// Encodes every row of `batch`.
    pub fn encode(&mut self, batch: &RecordBatch) -> Result<String, EncodeError> {
        let mut out = self.header(&batch.schema());
        let columns: Vec<Column<'_>> = batch
            .columns()
            .iter()
            .map(|c| Column::new(c.as_ref()))
            .collect::<Result<_, _>>()?;
        let schema = batch.schema();
        let newline = self.newline();
        for row in 0..batch.num_rows() {
            match self.format {
                ExportFormat::Csv => {
                    for (i, column) in columns.iter().enumerate() {
                        if i > 0 {
                            out.push_str(&self.options.delimiter);
                        }
                        match column.text(row) {
                            Some(text) => self.csv_field(&mut out, &text),
                            None => self.csv_field(&mut out, &self.options.null_text.clone()),
                        }
                    }
                }
                ExportFormat::Tsv => {
                    for (i, column) in columns.iter().enumerate() {
                        if i > 0 {
                            out.push('\t');
                        }
                        match column.text(row) {
                            Some(text) => tsv_escape(&mut out, &text),
                            None => tsv_escape(&mut out, &self.options.null_text),
                        }
                    }
                }
                ExportFormat::Jsonl => {
                    out.push('{');
                    for (i, (column, field)) in columns.iter().zip(schema.fields()).enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        json_string(&mut out, field.name());
                        out.push(':');
                        column.json(row, &mut out);
                    }
                    out.push('}');
                }
            }
            out.push_str(newline);
            self.rows += 1;
        }
        Ok(out)
    }

    fn csv_field(&self, out: &mut String, text: &str) {
        let quote = &self.options.quote;
        let needs_quotes = text.contains(&*self.options.delimiter)
            || (!quote.is_empty() && text.contains(&**quote))
            || text.contains('\n')
            || text.contains('\r')
            || text.starts_with(' ')
            || text.ends_with(' ');
        if needs_quotes && !quote.is_empty() {
            out.push_str(quote);
            out.push_str(&text.replace(&**quote, &format!("{quote}{quote}")));
            out.push_str(quote);
        } else {
            out.push_str(text);
        }
    }
}

/// TSV escapes tabs, newlines, carriage returns and backslashes as `\t`, `\n`, `\r`, `\\`.
fn tsv_escape(out: &mut String, text: &str) {
    for c in text.chars() {
        match c {
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\\' => out.push_str("\\\\"),
            c => out.push(c),
        }
    }
}

fn json_string(out: &mut String, text: &str) {
    out.push_str(&serde_json::to_string(text).expect("a string serializes"));
}

/// A typed view of one column for cell access.
enum Column<'a> {
    Bool(&'a arrow_array::BooleanArray),
    Int16(&'a arrow_array::PrimitiveArray<Int16Type>),
    Int32(&'a arrow_array::PrimitiveArray<Int32Type>),
    Int64(&'a arrow_array::PrimitiveArray<Int64Type>),
    UInt32(&'a arrow_array::PrimitiveArray<UInt32Type>),
    Float32(&'a arrow_array::PrimitiveArray<Float32Type>),
    Float64(&'a arrow_array::PrimitiveArray<Float64Type>),
    Utf8(&'a arrow_array::StringArray),
    LargeUtf8(&'a arrow_array::LargeStringArray),
    Binary(&'a arrow_array::BinaryArray),
    Uuid(&'a arrow_array::FixedSizeBinaryArray),
    FixedBinary(&'a arrow_array::FixedSizeBinaryArray),
    Date32(&'a arrow_array::PrimitiveArray<Date32Type>),
    TimeMicros(&'a arrow_array::PrimitiveArray<Time64MicrosecondType>),
    TimestampMicros {
        array: &'a arrow_array::PrimitiveArray<TimestampMicrosecondType>,
        utc: bool,
    },
}

impl<'a> Column<'a> {
    fn new(array: &'a dyn Array) -> Result<Column<'a>, EncodeError> {
        Ok(match array.data_type() {
            DataType::Boolean => Column::Bool(array.as_boolean()),
            DataType::Int16 => Column::Int16(array.as_primitive()),
            DataType::Int32 => Column::Int32(array.as_primitive()),
            DataType::Int64 => Column::Int64(array.as_primitive()),
            DataType::UInt32 => Column::UInt32(array.as_primitive()),
            DataType::Float32 => Column::Float32(array.as_primitive()),
            DataType::Float64 => Column::Float64(array.as_primitive()),
            DataType::Utf8 => Column::Utf8(array.as_string()),
            DataType::LargeUtf8 => Column::LargeUtf8(array.as_string()),
            DataType::Binary => Column::Binary(array.as_binary()),
            DataType::FixedSizeBinary(16) => Column::Uuid(array.as_fixed_size_binary()),
            DataType::FixedSizeBinary(_) => Column::FixedBinary(array.as_fixed_size_binary()),
            DataType::Date32 => Column::Date32(array.as_primitive()),
            DataType::Time64(TimeUnit::Microsecond) => Column::TimeMicros(array.as_primitive()),
            DataType::Timestamp(TimeUnit::Microsecond, tz) => Column::TimestampMicros {
                array: array.as_primitive(),
                utc: tz.is_some(),
            },
            _ => return Err(EncodeError::UnsupportedType),
        })
    }

    fn is_null(&self, row: usize) -> bool {
        match self {
            Column::Bool(a) => a.is_null(row),
            Column::Int16(a) => a.is_null(row),
            Column::Int32(a) => a.is_null(row),
            Column::Int64(a) => a.is_null(row),
            Column::UInt32(a) => a.is_null(row),
            Column::Float32(a) => a.is_null(row),
            Column::Float64(a) => a.is_null(row),
            Column::Utf8(a) => a.is_null(row),
            Column::LargeUtf8(a) => a.is_null(row),
            Column::Binary(a) => a.is_null(row),
            Column::Uuid(a) | Column::FixedBinary(a) => a.is_null(row),
            Column::Date32(a) => a.is_null(row),
            Column::TimeMicros(a) => a.is_null(row),
            Column::TimestampMicros { array, .. } => array.is_null(row),
        }
    }

    /// The cell as text; `None` for NULL.
    fn text(&self, row: usize) -> Option<String> {
        if self.is_null(row) {
            return None;
        }
        Some(match self {
            Column::Bool(a) => a.value(row).to_string(),
            Column::Int16(a) => a.value(row).to_string(),
            Column::Int32(a) => a.value(row).to_string(),
            Column::Int64(a) => a.value(row).to_string(),
            Column::UInt32(a) => a.value(row).to_string(),
            Column::Float32(a) => float_text(f64::from(a.value(row))),
            Column::Float64(a) => float_text(a.value(row)),
            Column::Utf8(a) => a.value(row).to_owned(),
            Column::LargeUtf8(a) => a.value(row).to_owned(),
            Column::Binary(a) => hex_bytes(a.value(row)),
            Column::Uuid(a) => uuid_text(a.value(row)),
            Column::FixedBinary(a) => hex_bytes(a.value(row)),
            Column::Date32(a) => date_text(i64::from(a.value(row))),
            Column::TimeMicros(a) => time_text(a.value(row)),
            Column::TimestampMicros { array, utc } => timestamp_text(array.value(row), *utc),
        })
    }

    /// The cell as a JSON value.
    fn json(&self, row: usize, out: &mut String) {
        if self.is_null(row) {
            out.push_str("null");
            return;
        }
        match self {
            Column::Bool(a) => out.push_str(if a.value(row) { "true" } else { "false" }),
            Column::Int16(a) => write!(out, "{}", a.value(row)).expect("string write"),
            Column::Int32(a) => write!(out, "{}", a.value(row)).expect("string write"),
            Column::Int64(a) => write!(out, "{}", a.value(row)).expect("string write"),
            Column::UInt32(a) => write!(out, "{}", a.value(row)).expect("string write"),
            Column::Float32(a) => json_float(out, f64::from(a.value(row))),
            Column::Float64(a) => json_float(out, a.value(row)),
            other => json_string(out, &other.text(row).unwrap_or_default()),
        }
    }
}

fn json_float(out: &mut String, v: f64) {
    if v.is_finite() {
        write!(out, "{v}").expect("string write");
    } else {
        json_string(out, &float_text(v));
    }
}

fn float_text(v: f64) -> String {
    if v.is_nan() {
        "NaN".into()
    } else if v.is_infinite() {
        if v > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else {
        v.to_string()
    }
}

fn hex_bytes(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(2 + bytes.len() * 2);
    out.push_str("\\x");
    for b in bytes {
        write!(out, "{b:02x}").expect("string write");
    }
    out
}

fn uuid_text(bytes: &[u8]) -> String {
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    if hex.len() != 32 {
        return hex;
    }
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Civil date of a day count from 1970-01-01 (Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn date_text(days: i64) -> String {
    let (y, m, d) = civil(days);
    if y < 0 {
        format!("{:05}-{m:02}-{d:02}", y)
    } else {
        format!("{y:04}-{m:02}-{d:02}")
    }
}

/// `HH:MM:SS[.ffffff]` of microseconds since midnight, fraction trimmed.
fn time_text(micros: i64) -> String {
    let micros = micros.rem_euclid(86_400_000_000);
    let secs = micros / 1_000_000;
    let frac = micros % 1_000_000;
    let mut out = format!(
        "{:02}:{:02}:{:02}",
        secs / 3600,
        (secs / 60) % 60,
        secs % 60
    );
    if frac != 0 {
        let fraction = format!("{frac:06}");
        out.push('.');
        out.push_str(fraction.trim_end_matches('0'));
    }
    out
}

fn timestamp_text(micros: i64, utc: bool) -> String {
    let days = micros.div_euclid(86_400_000_000);
    let in_day = micros.rem_euclid(86_400_000_000);
    let mut out = format!("{} {}", date_text(days), time_text(in_day));
    if utc {
        out.push_str("+00:00");
    }
    out
}

/// Formatting shared with tests and the grid's expectations: public so the shells' tests can
/// check a cell.
pub fn cell_text(array: &ArrayRef, row: usize) -> Result<Option<String>, EncodeError> {
    Ok(Column::new(array.as_ref())?.text(row))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::{
        BinaryArray, BooleanArray, Date32Array, FixedSizeBinaryArray, Float64Array, Int64Array,
        StringArray, Time64MicrosecondArray, TimestampMicrosecondArray,
    };
    use arrow_ipc::writer::StreamWriter;
    use arrow_schema::{Field, Schema};

    use super::*;

    fn batch() -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("ok", DataType::Boolean, true),
            Field::new("ratio", DataType::Float64, true),
            Field::new("data", DataType::Binary, true),
            Field::new("uid", DataType::FixedSizeBinary(16), true),
            Field::new("day", DataType::Date32, true),
            Field::new("at", DataType::Time64(TimeUnit::Microsecond), true),
            Field::new(
                "created",
                DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
                true,
            ),
        ]));
        let uid: FixedSizeBinaryArray = FixedSizeBinaryArray::try_from_sparse_iter_with_size(
            vec![
                Some(vec![
                    0xa0, 0xee, 0xbc, 0x99, 0x9c, 0x0b, 0x4e, 0xf8, 0xbb, 0x6d, 0x6b, 0xb9, 0xbd,
                    0x38, 0x0a, 0x11,
                ]),
                None,
                None,
            ]
            .into_iter(),
            16,
        )
        .unwrap();
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![9_000_000_000, 2, 3])),
                Arc::new(StringArray::from(vec![Some("a,\"b\"\nc"), None, Some("")])),
                Arc::new(BooleanArray::from(vec![Some(true), None, Some(false)])),
                Arc::new(Float64Array::from(vec![Some(0.25), None, Some(f64::NAN)])),
                Arc::new(BinaryArray::from_opt_vec(vec![
                    Some(&[0x00, 0xff, 0x10][..]),
                    None,
                    Some(&[][..]),
                ])),
                Arc::new(uid),
                // 2024-02-29 is day 19782; 1969-12-31 is day -1.
                Arc::new(Date32Array::from(vec![Some(19_782), None, Some(-1)])),
                Arc::new(Time64MicrosecondArray::from(vec![
                    Some(13 * 3_600_000_000 + 14 * 60_000_000 + 15_500_000),
                    None,
                    Some(0),
                ])),
                Arc::new(
                    TimestampMicrosecondArray::from(vec![
                        Some(1_709_212_455_123_456),
                        None,
                        Some(-1),
                    ])
                    .with_timezone("UTC"),
                ),
            ],
        )
        .unwrap()
    }

    #[test]
    fn csv_quotes_only_what_needs_it_and_tells_null_from_empty() {
        let mut enc = Encoder::new(ExportFormat::Csv, ExportOptions::default());
        let out = enc.encode(&batch()).unwrap();
        let expected = concat!(
            "id,name,ok,ratio,data,uid,day,at,created\n",
            "9000000000,\"a,\"\"b\"\"\nc\",true,0.25,\\x00ff10,",
            "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11,2024-02-29,13:14:15.5,",
            "2024-02-29 13:14:15.123456+00:00\n",
            "2,,,,,,,,\n",
            "3,,false,NaN,\\x,,1969-12-31,00:00:00,1969-12-31 23:59:59.999999+00:00\n",
        );
        assert_eq!(out, expected);
        assert_eq!(enc.rows(), 3);

        let mut enc = Encoder::new(
            ExportFormat::Csv,
            ExportOptions {
                header: false,
                delimiter: ";".into(),
                null_text: "NULL".into(),
                ..ExportOptions::default()
            },
        );
        let out = enc.encode(&batch()).unwrap();
        assert!(out.starts_with("9000000000;\"a,\"\"b\"\"\nc\";true;"));
        assert!(out.contains("2;NULL;NULL;NULL;"));
    }

    #[test]
    fn tsv_escapes_and_jsonl_types() {
        let mut enc = Encoder::new(ExportFormat::Tsv, ExportOptions::default());
        let out = enc.encode(&batch()).unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "id\tname\tok\tratio\tdata\tuid\tday\tat\tcreated");
        assert!(lines[1].starts_with("9000000000\ta,\"b\"\\nc\ttrue\t0.25\t"));

        let mut enc = Encoder::new(ExportFormat::Jsonl, ExportOptions::default());
        let out = enc.encode(&batch()).unwrap();
        let lines: Vec<serde_json::Value> = out
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0]["id"], 9_000_000_000_i64);
        assert_eq!(lines[0]["ok"], true);
        assert_eq!(lines[0]["data"], "\\x00ff10");
        assert_eq!(lines[1]["name"], serde_json::Value::Null);
        assert_eq!(lines[2]["name"], "");
        assert_eq!(lines[2]["ratio"], "NaN");
        // Keys keep the column order.
        assert!(out.starts_with("{\"id\":9000000000,\"name\":"));
    }

    #[test]
    fn decodes_an_ipc_stream_chunk_by_chunk_and_writes_the_header_for_an_empty_result() {
        let batch = batch();
        let mut writer = StreamWriter::try_new(Vec::new(), &batch.schema()).unwrap();
        let schema_chunk = std::mem::take(writer.get_mut());
        writer.write(&batch).unwrap();
        let batch_chunk = std::mem::take(writer.get_mut());
        writer.finish().unwrap();
        let end_chunk = std::mem::take(writer.get_mut());

        let mut decoder = IpcDecoder::new();
        assert!(decoder.push(&schema_chunk).unwrap().is_empty());
        // The schema message has no body, so the decoder finishes it with the next chunk.
        let batches = decoder.push(&batch_chunk).unwrap();
        assert_eq!(decoder.schema().unwrap().fields().len(), 9);
        assert_eq!(batches.len(), 1);
        assert!(decoder.push(&end_chunk).unwrap().is_empty());
        // A result without rows: schema, then the end marker.
        let mut empty = IpcDecoder::new();
        assert!(empty.push(&schema_chunk).unwrap().is_empty());
        assert!(empty.push(&end_chunk).unwrap().is_empty());
        assert!(empty.schema().is_some());
        // Bytes that are not an IPC message fail once a whole (bogus) message is in.
        let mut garbage = vec![16, 0, 0, 0];
        garbage.extend_from_slice(&[0xff; 32]);
        assert_eq!(
            IpcDecoder::new().push(&garbage).unwrap_err(),
            EncodeError::Decode
        );

        let mut enc = Encoder::new(ExportFormat::Csv, ExportOptions::default());
        let header = enc.header(decoder.schema().unwrap());
        assert_eq!(header, "id,name,ok,ratio,data,uid,day,at,created\n");
        assert_eq!(enc.header(decoder.schema().unwrap()), "");
    }

    #[test]
    fn civil_dates() {
        assert_eq!(date_text(0), "1970-01-01");
        assert_eq!(date_text(19_782), "2024-02-29");
        assert_eq!(date_text(-719_528), "0000-01-01");
        assert_eq!(time_text(59 * 1_000_000 + 10), "00:00:59.00001");
    }
}
