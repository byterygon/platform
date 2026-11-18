//! Avro (Mightyconsole spec §5.2, decision 11), through `apache-avro`.
//!
//! Decoded to the *natural* JSON form: unions unwrapped (`"x"`, not `{"string": "x"}`), enums and
//! uuids as strings, bytes and fixed as base64, decimals as strings (`"12.50"`), dates as
//! `YYYY-MM-DD`, times as `HH:MM:SS.fff`, timestamps as RFC 3339 (`…Z`; local timestamps
//! without the zone), durations as `{months, days, millis}`, longs beyond 2^53 as strings.
//! Encoded from the same JSON with the schema: numbers may also be given as strings, a union
//! takes the first branch the value fits (or Avro's tagged form `{"<branch>": value}`), missing
//! record fields take their defaults.

use std::collections::HashMap;

use apache_avro::schema::{DecimalSchema, InnerDecimalSchema, Name, RecordSchema, UuidSchema};
use apache_avro::types::Value;
use apache_avro::{Days, Decimal, Duration, Millis, Months, Schema};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use time::format_description::well_known::Rfc3339;
use time::{Date, OffsetDateTime};

use crate::ojson::Json;
use crate::{CodecError, Result};

/// A compiled Avro schema with the schemas it references (registry references or the other
/// files of a local schema).
#[derive(Debug, Clone)]
pub struct AvroSchema {
    pub schema: Schema,
    pub references: Vec<Schema>,
    names: HashMap<String, Schema>,
    /// The schema text, as given.
    pub text: String,
}

impl AvroSchema {
    /// Parses a schema text; `references` are the texts of the named types it uses.
    pub fn parse(text: &str, references: &[String]) -> Result<Self> {
        let (schema, references) = if references.is_empty() {
            (Schema::parse_str(text).map_err(avro_error)?, Vec::new())
        } else {
            Schema::parse_str_with_list(text, references).map_err(avro_error)?
        };
        let mut names = HashMap::new();
        for s in references.iter().chain(std::iter::once(&schema)) {
            collect_names(s, None, &mut names);
        }
        Ok(Self {
            schema,
            references,
            names,
            text: text.to_owned(),
        })
    }

    /// The fully qualified name of the top-level record, enum or fixed (for the record naming
    /// strategies).
    pub fn record_name(&self) -> Option<String> {
        named(&self.schema).map(|n| n.fullname(None))
    }

    pub fn decode(&self, bytes: &[u8]) -> Result<Json> {
        let mut rd = bytes;
        let reader = apache_avro::reader::datum::GenericDatumReader::builder(&self.schema);
        let value = if self.references.is_empty() {
            reader.build().and_then(|r| r.read_value(&mut rd))
        } else {
            reader
                .writer_schemata(self.references.iter().collect())
                .and_then(|b| b.build())
                .and_then(|r| r.read_value(&mut rd))
        }
        .map_err(|e| {
            CodecError::invalid(format!(
                "not valid Avro for this schema: {}",
                error_text(&e)
            ))
        })?;
        if !rd.is_empty() {
            return Err(CodecError::invalid(format!(
                "not valid Avro for this schema: {} bytes left after the value",
                rd.len()
            )));
        }
        self.value_to_json(&value, &self.schema, None)
    }

    pub fn encode(&self, json: &serde_json::Value) -> Result<Vec<u8>> {
        let value = self.json_to_value(json, &self.schema, None, "")?;
        let writer = apache_avro::writer::datum::GenericDatumWriter::builder(&self.schema);
        if self.references.is_empty() {
            writer.build().and_then(|w| w.write_value_to_vec(value))
        } else {
            writer
                .schemata(self.references.iter().collect())
                .and_then(|b| b.build())
                .and_then(|w| w.write_value_to_vec(value))
        }
        .map_err(|e| CodecError::invalid(format!("Avro: {}", error_text(&e))))
    }

    fn resolve<'a>(
        &'a self,
        schema: &'a Schema,
        ns: Option<&str>,
    ) -> Result<(&'a Schema, Option<String>)> {
        match schema {
            Schema::Ref { name } => {
                let full = name.fullname(ns);
                let found = self
                    .names
                    .get(&full)
                    .or_else(|| self.names.get(&name.fullname(None)))
                    .ok_or_else(|| CodecError::invalid(format!("Avro: unknown type {full}")))?;
                Ok((found, named(found).and_then(namespace_of)))
            }
            s => Ok((
                s,
                named(s)
                    .and_then(namespace_of)
                    .or_else(|| ns.map(str::to_owned)),
            )),
        }
    }

    fn value_to_json(&self, value: &Value, schema: &Schema, ns: Option<&str>) -> Result<Json> {
        let (schema, ns) = self.resolve(schema, ns)?;
        let ns = ns.as_deref();
        Ok(match (value, schema) {
            (Value::Null, _) => Json::Null,
            (Value::Boolean(b), _) => Json::Bool(*b),
            (Value::Int(i), _) => Json::int(i64::from(*i)),
            (Value::Long(l), _) => Json::int(*l),
            (Value::Float(f), _) => Json::float(f64::from(*f)),
            (Value::Double(f), _) => Json::float(*f),
            (Value::Bytes(b), _) | (Value::Fixed(_, b), _) => Json::str(BASE64.encode(b)),
            (Value::String(s), _) => Json::str(s.clone()),
            (Value::Enum(_, symbol), _) => Json::str(symbol.clone()),
            (Value::Union(i, inner), Schema::Union(u)) => {
                let branch = u.variants().get(*i as usize).ok_or_else(|| {
                    CodecError::invalid(format!("Avro: union branch {i} out of range"))
                })?;
                self.value_to_json(inner, branch, ns)?
            }
            (Value::Union(_, inner), other) => self.value_to_json(inner, other, ns)?,
            (Value::Array(items), Schema::Array(a)) => Json::Array(
                items
                    .iter()
                    .map(|v| self.value_to_json(v, &a.items, ns))
                    .collect::<Result<_>>()?,
            ),
            (Value::Map(map), Schema::Map(m)) => {
                let mut entries: Vec<_> = map.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                Json::Object(
                    entries
                        .into_iter()
                        .map(|(k, v)| Ok((k.clone(), self.value_to_json(v, &m.types, ns)?)))
                        .collect::<Result<_>>()?,
                )
            }
            (Value::Record(fields), Schema::Record(r)) => Json::Object(
                fields
                    .iter()
                    .map(|(name, v)| {
                        let field_schema = field(r, name).map(|f| &f.schema).ok_or_else(|| {
                            CodecError::invalid(format!("Avro: record has no field {name}"))
                        })?;
                        Ok((name.clone(), self.value_to_json(v, field_schema, ns)?))
                    })
                    .collect::<Result<_>>()?,
            ),
            (Value::Decimal(d), Schema::Decimal(DecimalSchema { scale, .. })) => {
                let bytes: Vec<u8> = d
                    .try_into()
                    .map_err(|e| CodecError::invalid(format!("Avro decimal: {e}")))?;
                Json::str(scale_decimal(&signed_be_to_decimal(&bytes), *scale))
            }
            (Value::Decimal(d), _) => {
                let bytes: Vec<u8> = d
                    .try_into()
                    .map_err(|e| CodecError::invalid(format!("Avro decimal: {e}")))?;
                Json::str(signed_be_to_decimal(&bytes))
            }
            (Value::BigDecimal(d), _) => Json::str(d.to_string()),
            (Value::Uuid(u), _) => Json::str(u.to_string()),
            (Value::Date(days), _) => Json::str(date_text(*days)?),
            (Value::TimeMillis(ms), _) => Json::str(time_text(i64::from(*ms) * 1_000_000, 3)),
            (Value::TimeMicros(us), _) => Json::str(time_text(us * 1_000, 6)),
            (Value::TimestampMillis(v), _) => {
                Json::str(timestamp_text(i128::from(*v) * 1_000_000, 3, true)?)
            }
            (Value::TimestampMicros(v), _) => {
                Json::str(timestamp_text(i128::from(*v) * 1_000, 6, true)?)
            }
            (Value::TimestampNanos(v), _) => Json::str(timestamp_text(i128::from(*v), 9, true)?),
            (Value::LocalTimestampMillis(v), _) => {
                Json::str(timestamp_text(i128::from(*v) * 1_000_000, 3, false)?)
            }
            (Value::LocalTimestampMicros(v), _) => {
                Json::str(timestamp_text(i128::from(*v) * 1_000, 6, false)?)
            }
            (Value::LocalTimestampNanos(v), _) => {
                Json::str(timestamp_text(i128::from(*v), 9, false)?)
            }
            (Value::Duration(d), _) => Json::Object(vec![
                ("months".into(), Json::int(i64::from(u32::from(d.months())))),
                ("days".into(), Json::int(i64::from(u32::from(d.days())))),
                ("millis".into(), Json::int(i64::from(u32::from(d.millis())))),
            ]),
            (v, s) => {
                return Err(CodecError::invalid(format!(
                    "Avro: value {v:?} does not match schema {}",
                    kind(s)
                )));
            }
        })
    }

    fn json_to_value(
        &self,
        json: &serde_json::Value,
        schema: &Schema,
        ns: Option<&str>,
        path: &str,
    ) -> Result<Value> {
        use serde_json::Value as J;
        let (schema, ns) = self.resolve(schema, ns)?;
        let ns = ns.as_deref();
        let bad = |want: &str| {
            CodecError::invalid(format!(
                "{}: expected {want}, got {}",
                at(path),
                json_kind(json)
            ))
        };
        Ok(match schema {
            Schema::Null => match json {
                J::Null => Value::Null,
                _ => return Err(bad("null")),
            },
            Schema::Boolean => Value::Boolean(json.as_bool().ok_or_else(|| bad("a boolean"))?),
            Schema::Int => {
                let i = integer(json).ok_or_else(|| bad("an int"))?;
                Value::Int(i32::try_from(i).map_err(|_| {
                    CodecError::invalid(format!("{}: {i} is out of range for int", at(path)))
                })?)
            }
            Schema::Long => Value::Long(integer(json).ok_or_else(|| bad("a long"))?),
            Schema::Float => Value::Float(float(json).ok_or_else(|| bad("a float"))? as f32),
            Schema::Double => Value::Double(float(json).ok_or_else(|| bad("a double"))?),
            Schema::Bytes => Value::Bytes(base64_text(json, path)?),
            Schema::String => {
                Value::String(json.as_str().ok_or_else(|| bad("a string"))?.to_owned())
            }
            Schema::Array(a) => {
                let items = json.as_array().ok_or_else(|| bad("an array"))?;
                Value::Array(
                    items
                        .iter()
                        .enumerate()
                        .map(|(i, v)| self.json_to_value(v, &a.items, ns, &format!("{path}/{i}")))
                        .collect::<Result<_>>()?,
                )
            }
            Schema::Map(m) => {
                let obj = json.as_object().ok_or_else(|| bad("an object"))?;
                Value::Map(
                    obj.iter()
                        .map(|(k, v)| {
                            Ok((
                                k.clone(),
                                self.json_to_value(v, &m.types, ns, &format!("{path}/{k}"))?,
                            ))
                        })
                        .collect::<Result<_>>()?,
                )
            }
            Schema::Union(u) => {
                let variants = u.variants();
                if json.is_null()
                    && let Some(i) = variants.iter().position(|v| matches!(v, Schema::Null))
                {
                    return Ok(Value::Union(i as u32, Box::new(Value::Null)));
                }
                // Natural form: the first branch the value fits.
                let mut first_error = None;
                for (i, v) in variants.iter().enumerate() {
                    if matches!(v, Schema::Null) {
                        continue;
                    }
                    match self.json_to_value(json, v, ns, path) {
                        Ok(value) => return Ok(Value::Union(i as u32, Box::new(value))),
                        Err(e) => {
                            first_error.get_or_insert(e);
                        }
                    }
                }
                // Avro's tagged form: {"<branch type or name>": value}.
                if let Some(obj) = json.as_object()
                    && obj.len() == 1
                {
                    let (tag, inner) = obj.iter().next().expect("one entry");
                    for (i, v) in variants.iter().enumerate() {
                        if branch_names(v, ns).iter().any(|n| n == tag) {
                            let value =
                                self.json_to_value(inner, v, ns, &format!("{path}/{tag}"))?;
                            return Ok(Value::Union(i as u32, Box::new(value)));
                        }
                    }
                }
                return Err(first_error.unwrap_or_else(|| bad("a value of the union")));
            }
            Schema::Record(r) => {
                let obj = json.as_object().ok_or_else(|| bad("an object"))?;
                for k in obj.keys() {
                    if field(r, k).is_none() {
                        return Err(CodecError::invalid(format!(
                            "{}: {} has no field {k}",
                            at(path),
                            r.name.fullname(None)
                        )));
                    }
                }
                let mut fields = Vec::with_capacity(r.fields.len());
                for f in &r.fields {
                    let sub = format!("{path}/{}", f.name);
                    let value = match (obj.get(&f.name), &f.default) {
                        (Some(v), _) => self.json_to_value(v, &f.schema, ns, &sub)?,
                        (None, Some(default)) => {
                            self.default_value(default, &f.schema, ns, &sub)?
                        }
                        (None, None) => {
                            return Err(CodecError::invalid(format!(
                                "{}: missing field {}",
                                at(path),
                                f.name
                            )));
                        }
                    };
                    fields.push((f.name.clone(), value));
                }
                Value::Record(fields)
            }
            Schema::Enum(e) => {
                let s = json.as_str().ok_or_else(|| bad("an enum symbol"))?;
                let i = e.symbols.iter().position(|x| x == s).ok_or_else(|| {
                    CodecError::invalid(format!(
                        "{}: {s} is not one of {}",
                        at(path),
                        e.symbols.join(", ")
                    ))
                })?;
                Value::Enum(i as u32, s.to_owned())
            }
            Schema::Fixed(f) => {
                let bytes = base64_text(json, path)?;
                if bytes.len() != f.size {
                    return Err(CodecError::invalid(format!(
                        "{}: fixed {} takes {} bytes, got {}",
                        at(path),
                        f.name.fullname(None),
                        f.size,
                        bytes.len()
                    )));
                }
                Value::Fixed(f.size, bytes)
            }
            Schema::Decimal(d) => {
                let text = number_text(json).ok_or_else(|| bad("a decimal (string or number)"))?;
                let unscaled = parse_decimal(&text, d.scale, d.precision.get())
                    .map_err(|e| CodecError::invalid(format!("{}: {e}", at(path))))?;
                let bytes = match &d.inner {
                    InnerDecimalSchema::Fixed(f) => {
                        sign_extend(&unscaled, f.size).ok_or_else(|| {
                            CodecError::invalid(format!(
                                "{}: decimal does not fit {} bytes",
                                at(path),
                                f.size
                            ))
                        })?
                    }
                    _ => unscaled,
                };
                Value::Decimal(
                    Decimal::new(bytes)
                        .map_err(|e| CodecError::invalid(format!("{}: {e}", at(path))))?,
                )
            }
            Schema::BigDecimal => {
                let text = number_text(json).ok_or_else(|| bad("a decimal"))?;
                Value::BigDecimal(text.parse().map_err(|e| {
                    CodecError::invalid(format!("{}: not a decimal: {e}", at(path)))
                })?)
            }
            Schema::Uuid(u) => {
                let s = json.as_str().ok_or_else(|| bad("a UUID string"))?;
                let uuid = apache_avro::Uuid::parse_str(s)
                    .map_err(|e| CodecError::invalid(format!("{}: not a UUID: {e}", at(path))))?;
                match u {
                    UuidSchema::String | UuidSchema::Bytes | UuidSchema::Fixed(_) => {
                        Value::Uuid(uuid)
                    }
                }
            }
            Schema::Date => match json {
                J::String(s) => Value::Date(
                    parse_date(s).map_err(|e| CodecError::invalid(format!("{}: {e}", at(path))))?,
                ),
                _ => Value::Date(
                    integer(json)
                        .and_then(|i| i32::try_from(i).ok())
                        .ok_or_else(|| bad("a date"))?,
                ),
            },
            Schema::TimeMillis => Value::TimeMillis(
                i32::try_from(time_value(json, path, 1_000_000)?)
                    .map_err(|_| CodecError::invalid(format!("{}: time out of range", at(path))))?,
            ),
            Schema::TimeMicros => Value::TimeMicros(time_value(json, path, 1_000)?),
            Schema::TimestampMillis => {
                Value::TimestampMillis(timestamp_value(json, path, 1_000_000, true)?)
            }
            Schema::TimestampMicros => {
                Value::TimestampMicros(timestamp_value(json, path, 1_000, true)?)
            }
            Schema::TimestampNanos => Value::TimestampNanos(timestamp_value(json, path, 1, true)?),
            Schema::LocalTimestampMillis => {
                Value::LocalTimestampMillis(timestamp_value(json, path, 1_000_000, false)?)
            }
            Schema::LocalTimestampMicros => {
                Value::LocalTimestampMicros(timestamp_value(json, path, 1_000, false)?)
            }
            Schema::LocalTimestampNanos => {
                Value::LocalTimestampNanos(timestamp_value(json, path, 1, false)?)
            }
            Schema::Duration(_) => {
                let obj = json
                    .as_object()
                    .ok_or_else(|| bad("{months, days, millis}"))?;
                let part = |k: &str| -> Result<u32> {
                    obj.get(k)
                        .map_or(Some(0), |v| integer(v).and_then(|i| u32::try_from(i).ok()))
                        .ok_or_else(|| {
                            CodecError::invalid(format!(
                                "{}: {k} must be a non-negative integer",
                                at(path)
                            ))
                        })
                };
                Value::Duration(Duration::new(
                    Months::new(part("months")?),
                    Days::new(part("days")?),
                    Millis::new(part("millis")?),
                ))
            }
            Schema::Ref { .. } => unreachable!("resolved above"),
        })
    }

    /// A record field's default, in Avro's JSON encoding (a union's default is its first branch).
    fn default_value(
        &self,
        default: &serde_json::Value,
        schema: &Schema,
        ns: Option<&str>,
        path: &str,
    ) -> Result<Value> {
        let (resolved, rns) = self.resolve(schema, ns)?;
        if let Schema::Union(u) = resolved
            && let Some(first) = u.variants().first()
        {
            let v = self.default_value(default, first, rns.as_deref(), path)?;
            return Ok(Value::Union(0, Box::new(v)));
        }
        // Avro encodes bytes and fixed defaults as ISO-8859-1 strings.
        if let (Schema::Bytes | Schema::Fixed(_), serde_json::Value::String(s)) =
            (resolved, default)
        {
            let bytes: Vec<u8> = s.chars().map(|c| c as u32 as u8).collect();
            return Ok(match resolved {
                Schema::Fixed(f) => Value::Fixed(f.size, bytes),
                _ => Value::Bytes(bytes),
            });
        }
        self.json_to_value(default, schema, ns, path)
    }
}

fn avro_error(e: apache_avro::Error) -> CodecError {
    CodecError::invalid(format!("not a valid Avro schema: {}", error_text(&e)))
}

fn error_text(e: &apache_avro::Error) -> String {
    let s = e.to_string();
    // apache-avro's messages can embed whole schemas; keep them readable.
    if s.chars().count() > 400 {
        format!("{}…", s.chars().take(400).collect::<String>())
    } else {
        s
    }
}

fn collect_names(schema: &Schema, ns: Option<&str>, names: &mut HashMap<String, Schema>) {
    let ns_owned;
    let ns = match named(schema) {
        Some(n) => {
            let full = n.fullname(ns);
            names.entry(full).or_insert_with(|| schema.clone());
            ns_owned = namespace_of(n).or_else(|| ns.map(str::to_owned));
            ns_owned.as_deref()
        }
        None => ns,
    };
    match schema {
        Schema::Array(a) => collect_names(&a.items, ns, names),
        Schema::Map(m) => collect_names(&m.types, ns, names),
        Schema::Union(u) => u
            .variants()
            .iter()
            .for_each(|v| collect_names(v, ns, names)),
        Schema::Record(r) => r
            .fields
            .iter()
            .for_each(|f| collect_names(&f.schema, ns, names)),
        _ => {}
    }
}

fn named(schema: &Schema) -> Option<&Name> {
    match schema {
        Schema::Record(r) => Some(&r.name),
        Schema::Enum(e) => Some(&e.name),
        Schema::Fixed(f) | Schema::Duration(f) => Some(&f.name),
        Schema::Decimal(DecimalSchema {
            inner: InnerDecimalSchema::Fixed(f),
            ..
        }) => Some(&f.name),
        Schema::Uuid(UuidSchema::Fixed(f)) => Some(&f.name),
        _ => None,
    }
}

fn namespace_of(name: &Name) -> Option<String> {
    name.namespace()
        .map(|n| n.to_string())
        .filter(|n| !n.is_empty())
}

fn field<'a>(r: &'a RecordSchema, name: &str) -> Option<&'a apache_avro::schema::RecordField> {
    r.lookup.get(name).and_then(|&i| r.fields.get(i))
}

fn branch_names(schema: &Schema, ns: Option<&str>) -> Vec<String> {
    let primitive = match schema {
        Schema::Null => "null",
        Schema::Boolean => "boolean",
        Schema::Int | Schema::Date | Schema::TimeMillis => "int",
        Schema::Long
        | Schema::TimeMicros
        | Schema::TimestampMillis
        | Schema::TimestampMicros
        | Schema::TimestampNanos
        | Schema::LocalTimestampMillis
        | Schema::LocalTimestampMicros
        | Schema::LocalTimestampNanos => "long",
        Schema::Float => "float",
        Schema::Double => "double",
        Schema::Bytes | Schema::BigDecimal => "bytes",
        Schema::String | Schema::Uuid(UuidSchema::String) => "string",
        Schema::Array(_) => "array",
        Schema::Map(_) => "map",
        _ => "",
    };
    let mut out = Vec::new();
    if !primitive.is_empty() {
        out.push(primitive.to_owned());
    }
    let name = match schema {
        Schema::Ref { name } => Some(name),
        s => named(s),
    };
    if let Some(n) = name {
        out.push(n.fullname(ns));
        out.push(n.name().to_owned());
    }
    out
}

fn kind(schema: &Schema) -> String {
    format!("{:?}", apache_avro::schema::SchemaKind::from(schema))
}

fn json_kind(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

fn at(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}

/// An integer from a JSON number or a string of digits (longs beyond 2^53 are strings).
fn integer(v: &serde_json::Value) -> Option<i64> {
    match v {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

fn float(v: &serde_json::Value) -> Option<f64> {
    match v {
        serde_json::Value::Number(n) => n.as_f64(),
        serde_json::Value::String(s) => match s.as_str() {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            s => s.trim().parse().ok(),
        },
        _ => None,
    }
}

fn number_text(v: &serde_json::Value) -> Option<String> {
    match v {
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::String(s) => Some(s.trim().to_owned()),
        _ => None,
    }
}

fn base64_text(v: &serde_json::Value, path: &str) -> Result<Vec<u8>> {
    let s = v.as_str().ok_or_else(|| {
        CodecError::invalid(format!(
            "{}: expected base64 text, got {}",
            at(path),
            json_kind(v)
        ))
    })?;
    BASE64
        .decode(s)
        .map_err(|e| CodecError::invalid(format!("{}: not valid base64: {e}", at(path))))
}

/// A big-endian two's-complement integer as decimal digits.
pub(crate) fn signed_be_to_decimal(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "0".into();
    }
    let negative = bytes[0] & 0x80 != 0;
    let mut mag: Vec<u8> = if negative {
        // Two's complement: invert and add one.
        let mut m: Vec<u8> = bytes.iter().map(|b| !b).collect();
        for b in m.iter_mut().rev() {
            let (v, carry) = b.overflowing_add(1);
            *b = v;
            if !carry {
                break;
            }
        }
        m
    } else {
        bytes.to_vec()
    };
    let mut digits = Vec::new();
    while mag.iter().any(|&b| b != 0) {
        let mut rem: u32 = 0;
        for b in mag.iter_mut() {
            let cur = (rem << 8) | u32::from(*b);
            *b = (cur / 10) as u8;
            rem = cur % 10;
        }
        digits.push(b'0' + rem as u8);
    }
    if digits.is_empty() {
        digits.push(b'0');
    }
    if negative {
        digits.push(b'-');
    }
    digits.reverse();
    String::from_utf8(digits).expect("ASCII digits")
}

/// Puts the decimal point `scale` digits from the right: `1250`, 2 → `12.50`.
fn scale_decimal(unscaled: &str, scale: usize) -> String {
    if scale == 0 {
        return unscaled.to_owned();
    }
    let (sign, digits) = unscaled
        .strip_prefix('-')
        .map_or(("", unscaled), |d| ("-", d));
    let digits = if digits.len() <= scale {
        format!("{}{digits}", "0".repeat(scale + 1 - digits.len()))
    } else {
        digits.to_owned()
    };
    let (int, frac) = digits.split_at(digits.len() - scale);
    format!("{sign}{int}.{frac}")
}

/// Parses decimal text into the unscaled big-endian two's-complement bytes for `scale`;
/// up to 38 digits (i128).
fn parse_decimal(
    text: &str,
    scale: usize,
    precision: usize,
) -> std::result::Result<Vec<u8>, String> {
    let (negative, body) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    let (int, frac) = body.split_once('.').unwrap_or((body, ""));
    if int.is_empty() && frac.is_empty()
        || !int.chars().chain(frac.chars()).all(|c| c.is_ascii_digit())
    {
        return Err(format!("{text} is not a decimal number"));
    }
    if frac.len() > scale && frac[scale..].chars().any(|c| c != '0') {
        return Err(format!("{text} has more than {scale} decimal places"));
    }
    let mut digits: String = int.trim_start_matches('0').to_owned();
    let frac: String = frac
        .chars()
        .chain(std::iter::repeat('0'))
        .take(scale)
        .collect();
    digits.push_str(&frac);
    let digits = digits.trim_start_matches('0');
    if digits.len() > precision {
        return Err(format!("{text} has more than {precision} digits"));
    }
    if digits.len() > 38 {
        return Err(format!("{text}: decimals over 38 digits are not supported"));
    }
    let mut n: i128 = if digits.is_empty() {
        0
    } else {
        digits
            .parse()
            .map_err(|_| format!("{text} is out of range"))?
    };
    if negative {
        n = -n;
    }
    Ok(minimal_be(n))
}

fn minimal_be(n: i128) -> Vec<u8> {
    let bytes = n.to_be_bytes();
    let mut start = 0;
    while start < 15 {
        let (b, next) = (bytes[start], bytes[start + 1]);
        if (b == 0 && next & 0x80 == 0) || (b == 0xff && next & 0x80 != 0) {
            start += 1;
        } else {
            break;
        }
    }
    bytes[start..].to_vec()
}

fn sign_extend(bytes: &[u8], size: usize) -> Option<Vec<u8>> {
    if bytes.len() > size {
        return None;
    }
    let fill = if bytes.first().is_some_and(|b| b & 0x80 != 0) {
        0xff
    } else {
        0
    };
    let mut out = vec![fill; size - bytes.len()];
    out.extend_from_slice(bytes);
    Some(out)
}

fn date_text(days: i32) -> Result<String> {
    let date = Date::from_julian_day(
        Date::from_calendar_date(1970, time::Month::January, 1)
            .expect("epoch")
            .to_julian_day()
            + days,
    )
    .map_err(|_| CodecError::invalid(format!("Avro date {days} is out of range")))?;
    Ok(date.to_string())
}

fn parse_date(s: &str) -> std::result::Result<i32, String> {
    let bad = || format!("{s} is not a date (YYYY-MM-DD)");
    let mut it = s.trim().splitn(3, '-');
    let (y, m, d) = (it.next(), it.next(), it.next());
    let (Some(y), Some(m), Some(d)) = (y, m, d) else {
        return Err(bad());
    };
    let month = time::Month::try_from(m.parse::<u8>().map_err(|_| bad())?).map_err(|_| bad())?;
    let date = Date::from_calendar_date(
        y.parse().map_err(|_| bad())?,
        month,
        d.parse().map_err(|_| bad())?,
    )
    .map_err(|_| bad())?;
    Ok(date.to_julian_day()
        - Date::from_calendar_date(1970, time::Month::January, 1)
            .expect("epoch")
            .to_julian_day())
}

/// `HH:MM:SS.fff` (3 or 6 fraction digits) for nanoseconds since midnight.
fn time_text(nanos: i64, digits: usize) -> String {
    let total = nanos.rem_euclid(86_400 * 1_000_000_000);
    let (secs, frac) = (total / 1_000_000_000, total % 1_000_000_000);
    let frac = format!("{frac:09}");
    format!(
        "{:02}:{:02}:{:02}.{}",
        secs / 3600,
        secs / 60 % 60,
        secs % 60,
        &frac[..digits]
    )
}

/// A time of day from `HH:MM:SS[.f]` text or an integer, in units of `unit_nanos`.
fn time_value(json: &serde_json::Value, path: &str, unit_nanos: i64) -> Result<i64> {
    if let Some(i) = integer(json) {
        return Ok(i);
    }
    let s = json
        .as_str()
        .ok_or_else(|| CodecError::invalid(format!("{}: expected a time (HH:MM:SS)", at(path))))?;
    let bad = || CodecError::invalid(format!("{}: {s} is not a time (HH:MM:SS.fff)", at(path)));
    let (hms, frac) = s.split_once('.').unwrap_or((s, ""));
    let parts: Vec<&str> = hms.split(':').collect();
    if parts.len() != 3 || frac.len() > 9 || !frac.chars().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    let n = |p: &str, max: i64| p.parse::<i64>().ok().filter(|v| (0..max).contains(v));
    let (h, m, sec) = (
        n(parts[0], 24).ok_or_else(bad)?,
        n(parts[1], 60).ok_or_else(bad)?,
        n(parts[2], 60).ok_or_else(bad)?,
    );
    let frac_nanos: i64 = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<9}").parse().map_err(|_| bad())?
    };
    Ok(((h * 3600 + m * 60 + sec) * 1_000_000_000 + frac_nanos) / unit_nanos)
}

/// RFC 3339 with the fraction at the logical type's precision (`digits`: 3, 6 or 9), left out
/// when it is zero; local timestamps without the zone.
fn timestamp_text(nanos: i128, digits: usize, utc: bool) -> Result<String> {
    let t = OffsetDateTime::from_unix_timestamp_nanos(nanos)
        .map_err(|_| CodecError::invalid(format!("Avro timestamp {nanos} ns is out of range")))?;
    let whole = t.replace_nanosecond(0).expect("0 ns is valid");
    let text = whole
        .format(&Rfc3339)
        .map_err(|e| CodecError::invalid(format!("Avro timestamp: {e}")))?;
    let base = text.trim_end_matches('Z');
    let frac = t.nanosecond();
    let frac = if frac == 0 {
        String::new()
    } else {
        format!(".{}", &format!("{frac:09}")[..digits])
    };
    Ok(format!("{base}{frac}{}", if utc { "Z" } else { "" }))
}

fn timestamp_value(
    json: &serde_json::Value,
    path: &str,
    unit_nanos: i128,
    utc: bool,
) -> Result<i64> {
    if let Some(i) = integer(json) {
        return Ok(i);
    }
    let s = json.as_str().ok_or_else(|| {
        CodecError::invalid(format!("{}: expected a timestamp (RFC 3339)", at(path)))
    })?;
    let text = if utc {
        s.to_owned()
    } else {
        format!("{}Z", s.trim_end_matches('Z'))
    };
    let t = OffsetDateTime::parse(&text, &Rfc3339).map_err(|e| {
        CodecError::invalid(format!(
            "{}: {s} is not an RFC 3339 timestamp: {e}",
            at(path)
        ))
    })?;
    i64::try_from(t.unix_timestamp_nanos() / unit_nanos)
        .map_err(|_| CodecError::invalid(format!("{}: timestamp out of range", at(path))))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const ORDER_V2: &str = include_str!("../../tests/fixtures/order-v2.avsc");

    #[test]
    fn natural_json_round_trip() {
        let s = AvroSchema::parse(ORDER_V2, &[]).unwrap();
        assert_eq!(s.record_name().as_deref(), Some("lab.orders.Order"));
        let input = json!({
            "id": "o-1", "customer": "c-9", "amount": "1234.50",
            "placedAt": "2026-11-17T10:00:00.123Z", "note": "fragile", "channel": "STORE"
        });
        let bytes = s.encode(&input).unwrap();
        let out = s.decode(&bytes).unwrap();
        assert_eq!(
            out.to_text(),
            r#"{"id":"o-1","customer":"c-9","amount":"1234.50","placedAt":"2026-11-17T10:00:00.123Z","note":"fragile","channel":"STORE"}"#
        );
        // Defaults fill missing fields; a null union branch decodes as null.
        let bytes = s
            .encode(&json!({"id": "o-2", "customer": "c", "amount": -0.5, "placedAt": 0}))
            .unwrap();
        let out = s.decode(&bytes).unwrap().to_value();
        assert_eq!(out["note"], serde_json::Value::Null);
        assert_eq!(out["channel"], "WEB");
        assert_eq!(out["amount"], "-0.50");
        assert_eq!(out["placedAt"], "1970-01-01T00:00:00Z");
    }

    #[test]
    fn logical_types_and_big_longs() {
        let schema = r#"{"type":"record","name":"T","namespace":"x","fields":[
            {"name":"big","type":"long"},
            {"name":"d","type":{"type":"int","logicalType":"date"}},
            {"name":"tm","type":{"type":"int","logicalType":"time-millis"}},
            {"name":"tu","type":{"type":"long","logicalType":"time-micros"}},
            {"name":"ts","type":{"type":"long","logicalType":"timestamp-micros"}},
            {"name":"lts","type":{"type":"long","logicalType":"local-timestamp-millis"}},
            {"name":"u","type":{"type":"string","logicalType":"uuid"}},
            {"name":"fx","type":{"type":"fixed","name":"F4","size":4}},
            {"name":"dec","type":{"type":"fixed","name":"D8","size":8,"logicalType":"decimal","precision":18,"scale":3}},
            {"name":"by","type":"bytes"},
            {"name":"m","type":{"type":"map","values":"double"}},
            {"name":"e","type":["null","int","string",{"type":"array","items":"F4"}]}
        ]}"#;
        let s = AvroSchema::parse(schema, &[]).unwrap();
        let input = json!({
            "big": "9007199254740993", "d": "2026-11-17", "tm": "10:11:12.345", "tu": "23:59:59.999999",
            "ts": "2026-11-17T10:00:00.000001Z", "lts": "2026-11-17T10:00:00.5",
            "u": "3fa85f64-5717-4562-b3fc-2c963f66afa6", "fx": "AQIDBA==", "dec": "-12.345",
            "by": "AP8=", "m": {"b": 1.5, "a": "NaN"}, "e": ["AQIDBA=="]
        });
        let out = s.decode(&s.encode(&input).unwrap()).unwrap();
        assert_eq!(
            out.to_text(),
            concat!(
                r#"{"big":"9007199254740993","d":"2026-11-17","tm":"10:11:12.345","tu":"23:59:59.999999","#,
                r#""ts":"2026-11-17T10:00:00.000001Z","lts":"2026-11-17T10:00:00.500","#,
                r#""u":"3fa85f64-5717-4562-b3fc-2c963f66afa6","fx":"AQIDBA==","dec":"-12.345","#,
                r#""by":"AP8=","m":{"a":"NaN","b":1.5},"e":["AQIDBA=="]}"#
            )
        );
        // Union branches: the first that fits, or the tagged form.
        let pick = |v| {
            s.decode(&s.encode(&json!({"big":1,"d":0,"tm":0,"tu":0,"ts":0,"lts":0,
            "u":"3fa85f64-5717-4562-b3fc-2c963f66afa6","fx":"AQIDBA==","dec":"0","by":"","m":{},"e":v})).unwrap()).unwrap().to_value()["e"].clone()
        };
        assert_eq!(pick(json!(7)), json!(7));
        assert_eq!(pick(json!("7")), json!(7)); // "7" fits int first, as Avro's natural form allows
        assert_eq!(pick(json!({"string": "7"})), json!("7"));
        assert_eq!(pick(json!(null)), json!(null));
    }

    #[test]
    fn errors_name_the_path() {
        let s = AvroSchema::parse(ORDER_V2, &[]).unwrap();
        let e = s.encode(&json!({"id": 1})).unwrap_err();
        assert!(e.message.contains("/id"), "{}", e.message);
        let e = s
            .encode(&json!({"id": "a", "customer": "c", "amount": "1.234", "placedAt": 0}))
            .unwrap_err();
        assert!(
            e.message.contains("more than 2 decimal places"),
            "{}",
            e.message
        );
        let e = s.encode(&json!({"id": "a", "customer": "c", "amount": "1", "placedAt": 0, "channel": "FAX"})).unwrap_err();
        assert!(e.message.contains("FAX is not one of"), "{}", e.message);
        let e = s
            .encode(&json!({"id": "a", "customer": "c", "amount": "1", "placedAt": 0, "extra": 1}))
            .unwrap_err();
        assert!(e.message.contains("no field extra"), "{}", e.message);
        assert!(s.decode(&[0x02]).is_err());
        assert!(AvroSchema::parse("{\"type\":\"record\"}", &[]).is_err());
    }

    #[test]
    fn references() {
        let money = r#"{"type":"record","name":"Money","namespace":"lab.common","fields":[{"name":"units","type":"long"},{"name":"currency","type":"string"}]}"#;
        let order = r#"{"type":"record","name":"Order","namespace":"lab.orders","fields":[{"name":"total","type":"lab.common.Money"}]}"#;
        let s = AvroSchema::parse(order, &[money.to_owned()]).unwrap();
        let bytes = s
            .encode(&json!({"total": {"units": 5, "currency": "EUR"}}))
            .unwrap();
        assert_eq!(
            s.decode(&bytes).unwrap().to_text(),
            r#"{"total":{"units":5,"currency":"EUR"}}"#
        );
    }

    #[test]
    fn decimal_helpers() {
        assert_eq!(signed_be_to_decimal(&[0x04, 0xd2]), "1234");
        assert_eq!(signed_be_to_decimal(&[0xfb, 0x2e]), "-1234");
        assert_eq!(signed_be_to_decimal(&[0x00]), "0");
        assert_eq!(signed_be_to_decimal(&[0xff; 3]), "-1");
        assert_eq!(
            signed_be_to_decimal(&[0x01, 0, 0, 0, 0, 0, 0, 0, 0]),
            "18446744073709551616"
        );
        assert_eq!(scale_decimal("5", 2), "0.05");
        assert_eq!(scale_decimal("-1250", 2), "-12.50");
        assert_eq!(parse_decimal("12.5", 2, 10).unwrap(), minimal_be(1250));
        assert_eq!(parse_decimal("-0.01", 2, 10).unwrap(), vec![0xff]);
        assert!(parse_decimal("1e3", 0, 10).is_err());
        assert!(parse_decimal("123", 0, 2).is_err());
        assert_eq!(sign_extend(&[0xff], 3).unwrap(), vec![0xff, 0xff, 0xff]);
    }
}
