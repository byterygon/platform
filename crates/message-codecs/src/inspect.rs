//! `messaging.schemas.inspect` (Mightyconsole spec §5.7, §5.8): a schema as the JSON Schema of
//! the JSON its codec reads and writes, for the Composer's validation and completion, plus an
//! example payload.
//!
//! - Avro → the natural JSON form of [`crate::codec::avro`] (unions as `anyOf`, longs as integer
//!   or string, decimals and logical types as strings with formats).
//! - Protobuf → proto3 canonical JSON (64-bit integers as integer or string, enums by name,
//!   well-known types in their JSON forms, every field optional).
//! - JSON Schema → itself.
//!
//! Named types become `$defs` entries referenced with `$ref`, so recursive schemas stay finite.
//! The example follows the JSON Schema: defaults, the first enum value, a first union branch,
//! and placeholder values by type and format.

use std::collections::BTreeMap;

use apache_avro::Schema as Avro;
use apache_avro::schema::{DecimalSchema, InnerDecimalSchema, UuidSchema};
use prost_reflect::{Kind, MessageDescriptor};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::codec::avro::AvroSchema;
use crate::codec::protobuf::ProtoSchema;
use crate::schema::CompiledSchema;
use crate::types::{SchemaIssue, SchemaType};
use crate::{CodecError, Result};

/// What `messaging.schemas.inspect` answers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    #[serde(rename = "type")]
    pub schema_type: SchemaType,
    /// Protobuf: the message types offered; empty for the other types.
    pub message_types: Vec<String>,
    /// Protobuf: every message type of the files, nested ones too; empty for the other types.
    pub all_message_types: Vec<String>,
    /// The JSON Schema (draft 2020-12) of the codec's JSON.
    #[cfg_attr(feature = "codegen", ts(type = "unknown"))]
    #[cfg_attr(feature = "codegen", schemars(with = "serde_json::Value"))]
    pub json_schema: Value,
    /// An example payload as JSON text.
    pub example: String,
    /// The schema text (Avro, `.proto` main file or JSON Schema).
    pub text: String,
    pub errors: Vec<SchemaIssue>,
}

/// Inspects a compiled schema. `message_type` picks the Protobuf message (the first offered one
/// when absent).
pub fn inspect(schema: &CompiledSchema, message_type: Option<&str>) -> Result<Inspection> {
    let (json_schema, text) = match schema {
        CompiledSchema::Avro(s) => (avro_json_schema(s), s.text.clone()),
        CompiledSchema::Protobuf(s) => {
            let msg = s.message(message_type)?;
            (proto_json_schema(&msg), proto_text(s))
        }
        CompiledSchema::JsonSchema(s) => (s.schema.clone(), s.text.clone()),
    };
    let example = example(&json_schema);
    Ok(Inspection {
        schema_type: schema.schema_type(),
        message_types: schema.message_types(),
        all_message_types: match schema {
            CompiledSchema::Protobuf(s) => s.all_message_types(),
            _ => Vec::new(),
        },
        example: serde_json::to_string_pretty(&example)
            .map_err(|e| CodecError::invalid(e.to_string()))?,
        json_schema,
        text,
        errors: Vec::new(),
    })
}

fn proto_text(s: &ProtoSchema) -> String {
    // The main file's source is not kept by the descriptor pool; name the file and its messages.
    let file = s
        .main_file
        .clone()
        .unwrap_or_else(|| "descriptor set".into());
    format!("// {file}\n// messages: {}\n", s.message_types.join(", "))
}

const DIALECT: &str = "https://json-schema.org/draft/2020-12/schema";

fn wrap(root: Value, defs: BTreeMap<String, Value>) -> Value {
    let mut out = match root {
        Value::Object(m) => m,
        other => {
            let mut m = Map::new();
            m.insert("allOf".into(), json!([other]));
            m
        }
    };
    out.insert("$schema".into(), json!(DIALECT));
    if !defs.is_empty() {
        out.insert("$defs".into(), Value::Object(defs.into_iter().collect()));
    }
    Value::Object(out)
}

fn def_ref(name: &str) -> Value {
    json!({ "$ref": format!("#/$defs/{name}") })
}

// --- Avro -------------------------------------------------------------------------------------

fn avro_json_schema(s: &AvroSchema) -> Value {
    let mut defs = BTreeMap::new();
    let lookup: BTreeMap<String, &Avro> = s
        .references
        .iter()
        .chain(std::iter::once(&s.schema))
        .flat_map(collect_avro)
        .collect();
    let root = avro_type(&s.schema, &lookup, &mut defs);
    wrap(root, defs)
}

fn collect_avro(schema: &Avro) -> Vec<(String, &Avro)> {
    let mut out = Vec::new();
    let mut stack = vec![schema];
    while let Some(s) = stack.pop() {
        if let Some(n) = avro_name(s) {
            out.push((n, s));
        }
        match s {
            Avro::Array(a) => stack.push(&a.items),
            Avro::Map(m) => stack.push(&m.types),
            Avro::Union(u) => stack.extend(u.variants()),
            Avro::Record(r) => stack.extend(r.fields.iter().map(|f| &f.schema)),
            _ => {}
        }
    }
    out
}

fn avro_name(s: &Avro) -> Option<String> {
    match s {
        Avro::Record(r) => Some(r.name.fullname(None)),
        Avro::Enum(e) => Some(e.name.fullname(None)),
        Avro::Fixed(f) => Some(f.name.fullname(None)),
        _ => None,
    }
}

fn avro_type(
    s: &Avro,
    lookup: &BTreeMap<String, &Avro>,
    defs: &mut BTreeMap<String, Value>,
) -> Value {
    let int_or_string = |desc: &str| json!({ "anyOf": [{ "type": "integer" }, { "type": "string", "pattern": "^-?[0-9]+$" }], "description": desc });
    match s {
        Avro::Null => json!({ "type": "null" }),
        Avro::Boolean => json!({ "type": "boolean" }),
        Avro::Int => json!({ "type": "integer", "minimum": i32::MIN, "maximum": i32::MAX }),
        Avro::Long => int_or_string("long (a string beyond 2^53)"),
        Avro::Float | Avro::Double => {
            json!({ "anyOf": [{ "type": "number" }, { "enum": ["NaN", "Infinity", "-Infinity"] }] })
        }
        Avro::Bytes => json!({ "type": "string", "contentEncoding": "base64" }),
        Avro::String => json!({ "type": "string" }),
        Avro::Array(a) => json!({ "type": "array", "items": avro_type(&a.items, lookup, defs) }),
        Avro::Map(m) => {
            json!({ "type": "object", "additionalProperties": avro_type(&m.types, lookup, defs) })
        }
        Avro::Union(u) => {
            json!({ "anyOf": u.variants().iter().map(|v| avro_type(v, lookup, defs)).collect::<Vec<_>>() })
        }
        Avro::Ref { name } => {
            let full = name.fullname(None);
            if !defs.contains_key(&full)
                && let Some(target) = lookup.get(&full)
            {
                return avro_type(target, lookup, defs);
            }
            def_ref(&full)
        }
        Avro::Record(r) => {
            let name = r.name.fullname(None);
            if !defs.contains_key(&name) {
                defs.insert(name.clone(), json!({})); // placeholder for recursion
                let mut props = Map::new();
                let mut required = Vec::new();
                for f in &r.fields {
                    let mut t = avro_type(&f.schema, lookup, defs);
                    if let (Some(d), Value::Object(m)) = (&f.default, &mut t) {
                        m.insert("default".into(), d.clone());
                    }
                    if let (Some(doc), Value::Object(m)) = (&f.doc, &mut t) {
                        m.insert("description".into(), json!(doc));
                    }
                    if f.default.is_none() {
                        required.push(json!(f.name));
                    }
                    props.insert(f.name.clone(), t);
                }
                let mut obj = json!({ "type": "object", "title": name, "properties": props, "required": required, "additionalProperties": false });
                if let Some(doc) = &r.doc {
                    obj["description"] = json!(doc);
                }
                defs.insert(name.clone(), obj);
            }
            def_ref(&name)
        }
        Avro::Enum(e) => {
            let name = e.name.fullname(None);
            defs.entry(name.clone())
                .or_insert_with(|| json!({ "type": "string", "title": name, "enum": e.symbols }));
            def_ref(&name)
        }
        Avro::Fixed(f) => {
            json!({ "type": "string", "contentEncoding": "base64", "description": format!("{} bytes", f.size) })
        }
        Avro::Decimal(DecimalSchema {
            precision,
            scale,
            inner,
        }) => {
            let fixed = matches!(inner, InnerDecimalSchema::Fixed(_));
            json!({
                "type": ["string", "number"],
                "pattern": "^-?[0-9]+(\\.[0-9]+)?$",
                "description": format!("decimal({}, {scale}){}", precision.get(), if fixed { " in fixed" } else { "" }),
                "examples": [if *scale == 0 { "0".to_owned() } else { format!("0.{}", "0".repeat(*scale)) }]
            })
        }
        Avro::BigDecimal => {
            json!({ "type": ["string", "number"], "description": "big decimal", "examples": ["0"] })
        }
        Avro::Uuid(UuidSchema::String | UuidSchema::Bytes | UuidSchema::Fixed(_)) => {
            json!({ "type": "string", "format": "uuid" })
        }
        Avro::Date => json!({ "type": "string", "format": "date" }),
        Avro::TimeMillis | Avro::TimeMicros => {
            json!({ "type": "string", "pattern": "^[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$", "description": "time of day", "examples": ["00:00:00.000"] })
        }
        Avro::TimestampMillis | Avro::TimestampMicros | Avro::TimestampNanos => {
            json!({ "type": "string", "format": "date-time" })
        }
        Avro::LocalTimestampMillis | Avro::LocalTimestampMicros | Avro::LocalTimestampNanos => {
            json!({ "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?$", "description": "local timestamp, no zone", "examples": ["2026-01-01T00:00:00"] })
        }
        Avro::Duration(_) => json!({
            "type": "object",
            "properties": { "months": { "type": "integer", "minimum": 0 }, "days": { "type": "integer", "minimum": 0 }, "millis": { "type": "integer", "minimum": 0 } },
            "additionalProperties": false
        }),
    }
}

// --- Protobuf ---------------------------------------------------------------------------------

fn proto_json_schema(msg: &MessageDescriptor) -> Value {
    let mut defs = BTreeMap::new();
    let root = proto_message(msg, &mut defs);
    wrap(root, defs)
}

fn proto_message(msg: &MessageDescriptor, defs: &mut BTreeMap<String, Value>) -> Value {
    if let Some(wkt) = well_known(msg.full_name()) {
        return wkt;
    }
    let name = msg.full_name().to_owned();
    if !defs.contains_key(&name) {
        defs.insert(name.clone(), json!({}));
        let mut props = Map::new();
        for f in msg.fields() {
            let t = if f.is_map() {
                let Kind::Message(entry) = f.kind() else {
                    unreachable!("map fields are messages")
                };
                json!({ "type": "object", "additionalProperties": proto_kind(&entry.map_entry_value_field().kind(), defs) })
            } else if f.is_list() {
                json!({ "type": "array", "items": proto_kind(&f.kind(), defs) })
            } else {
                proto_kind(&f.kind(), defs)
            };
            props.insert(f.json_name().to_owned(), t);
        }
        defs.insert(name.clone(), json!({ "type": "object", "title": name, "properties": props, "additionalProperties": false }));
    }
    def_ref(&name)
}

fn proto_kind(kind: &Kind, defs: &mut BTreeMap<String, Value>) -> Value {
    let int64 =
        json!({ "anyOf": [{ "type": "integer" }, { "type": "string", "pattern": "^-?[0-9]+$" }] });
    match kind {
        Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 => {
            json!({ "type": "integer", "minimum": i32::MIN, "maximum": i32::MAX })
        }
        Kind::Uint32 | Kind::Fixed32 => {
            json!({ "type": "integer", "minimum": 0, "maximum": u32::MAX })
        }
        Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 | Kind::Uint64 | Kind::Fixed64 => int64,
        Kind::Float | Kind::Double => {
            json!({ "anyOf": [{ "type": "number" }, { "enum": ["NaN", "Infinity", "-Infinity"] }] })
        }
        Kind::Bool => json!({ "type": "boolean" }),
        Kind::String => json!({ "type": "string" }),
        Kind::Bytes => json!({ "type": "string", "contentEncoding": "base64" }),
        Kind::Enum(e) => {
            let name = e.full_name().to_owned();
            defs.entry(name.clone()).or_insert_with(|| {
                json!({ "title": name, "anyOf": [{ "enum": e.values().map(|v| v.name().to_owned()).collect::<Vec<_>>() }, { "type": "integer" }] })
            });
            def_ref(&name)
        }
        Kind::Message(m) => proto_message(m, defs),
    }
}

/// The JSON forms of Google's well-known types.
fn well_known(name: &str) -> Option<Value> {
    Some(match name {
        "google.protobuf.Timestamp" => json!({ "type": "string", "format": "date-time" }),
        "google.protobuf.Duration" => {
            json!({ "type": "string", "pattern": "^-?[0-9]+(\\.[0-9]+)?s$", "examples": ["0s"] })
        }
        "google.protobuf.FieldMask" => json!({ "type": "string" }),
        "google.protobuf.Struct" => json!({ "type": "object" }),
        "google.protobuf.ListValue" => json!({ "type": "array" }),
        "google.protobuf.Value" | "google.protobuf.Any" => json!({}),
        "google.protobuf.Empty" => json!({ "type": "object", "additionalProperties": false }),
        "google.protobuf.BoolValue" => json!({ "type": ["boolean", "null"] }),
        "google.protobuf.StringValue" => json!({ "type": ["string", "null"] }),
        "google.protobuf.BytesValue" => {
            json!({ "type": ["string", "null"], "contentEncoding": "base64" })
        }
        "google.protobuf.Int32Value" | "google.protobuf.UInt32Value" => {
            json!({ "type": ["integer", "null"] })
        }
        "google.protobuf.Int64Value" | "google.protobuf.UInt64Value" => {
            json!({ "type": ["integer", "string", "null"] })
        }
        "google.protobuf.FloatValue" | "google.protobuf.DoubleValue" => {
            json!({ "type": ["number", "null"] })
        }
        _ => return None,
    })
}

// --- Examples ---------------------------------------------------------------------------------

/// An example value for a JSON Schema: `default`, `const`, `examples`, the first of `enum`,
/// the first non-null branch of `anyOf`/`oneOf`, then a placeholder by type and format. Local
/// `$ref`s (`#/$defs/…`, `#/definitions/…`) are followed; a `$ref` already being expanded
/// (recursion) gives no value, so arrays of it stay empty and optional fields are left out.
pub fn example(schema: &Value) -> Value {
    example_at(schema, schema, &mut Vec::new()).unwrap_or(Value::Null)
}

fn example_at(root: &Value, s: &Value, visiting: &mut Vec<String>) -> Option<Value> {
    let obj = s.as_object()?;
    if let Some(v) = obj.get("default").or_else(|| obj.get("const")) {
        return Some(v.clone());
    }
    if let Some(v) = obj
        .get("examples")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        return Some(v.clone());
    }
    if let Some(v) = obj
        .get("enum")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
    {
        return Some(v.clone());
    }
    if let Some(r) = obj.get("$ref").and_then(Value::as_str) {
        if visiting.iter().any(|v| v == r) {
            return None;
        }
        let target = resolve_local(root, r)?;
        visiting.push(r.to_owned());
        let out = example_at(root, target, visiting);
        visiting.pop();
        return out;
    }
    for key in ["anyOf", "oneOf", "allOf"] {
        if let Some(branches) = obj.get(key).and_then(Value::as_array) {
            let is_null = |b: &Value| b.get("type") == Some(&json!("null"));
            for b in branches.iter().filter(|b| !is_null(b)) {
                if let Some(v) = example_at(root, b, visiting) {
                    return Some(v);
                }
            }
            return branches.iter().any(is_null).then_some(Value::Null);
        }
    }
    let ty = match obj.get("type") {
        Some(Value::String(t)) => t.as_str(),
        Some(Value::Array(ts)) => ts
            .iter()
            .filter_map(Value::as_str)
            .find(|t| *t != "null")
            .unwrap_or("null"),
        _ if obj.contains_key("properties") => "object",
        _ => return Some(Value::Null),
    };
    Some(match ty {
        "object" => {
            let required: Vec<&str> = obj
                .get("required")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let mut out = Map::new();
            if let Some(props) = obj.get("properties").and_then(Value::as_object) {
                for (k, v) in props {
                    match example_at(root, v, visiting) {
                        Some(value) => {
                            out.insert(k.clone(), value);
                        }
                        None if required.contains(&k.as_str()) => return None,
                        None => {}
                    }
                }
            }
            Value::Object(out)
        }
        "array" => match obj
            .get("items")
            .and_then(|items| example_at(root, items, visiting))
        {
            Some(item) => json!([item]),
            None => json!([]),
        },
        "string" => json!(match obj.get("format").and_then(Value::as_str) {
            Some("date-time") => "2026-01-01T00:00:00Z",
            Some("date") => "2026-01-01",
            Some("uuid") => "00000000-0000-4000-8000-000000000000",
            Some("email") => "name@example.com",
            Some("uri") => "urn:example",
            _ => "",
        }),
        "integer" => json!(
            obj.get("minimum")
                .and_then(Value::as_i64)
                .filter(|m| *m > 0)
                .unwrap_or(0)
        ),
        "number" => json!(0),
        "boolean" => json!(false),
        _ => Value::Null,
    })
}

fn resolve_local<'a>(root: &'a Value, r: &str) -> Option<&'a Value> {
    let pointer = r.strip_prefix('#')?;
    let pointer = pointer
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .map(|t| t.replace('/', "~1"))
        .collect::<Vec<_>>()
        .join("/");
    root.pointer(&pointer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codec::jsonschema::JsonSchemaSchema;
    use crate::types::SchemaFile;

    #[test]
    fn avro_to_json_schema_validates_what_the_codec_reads() {
        let s = AvroSchema::parse(include_str!("../tests/fixtures/order-v2.avsc"), &[]).unwrap();
        let i = inspect(&CompiledSchema::Avro(s.clone()), None).unwrap();
        // The JSON Schema accepts a decoded value and the example, and the example encodes.
        let validator = JsonSchemaSchema::parse(&i.json_schema.to_string(), &[]).unwrap();
        let decoded = s
            .decode(
                &s.encode(&json!({"id":"a","customer":"c","amount":"1.50","placedAt":0}))
                    .unwrap(),
            )
            .unwrap();
        assert!(
            validator.violations(&decoded.to_value()).is_empty(),
            "{:?}",
            validator.violations(&decoded.to_value())
        );
        let example: Value = serde_json::from_str(&i.example).unwrap();
        assert!(validator.violations(&example).is_empty(), "{example}");
        s.encode(&example).unwrap();
        assert_eq!(example["channel"], "WEB");
        assert!(!validator.violations(&json!({"id": 1})).is_empty());
    }

    #[test]
    fn protobuf_to_json_schema() {
        let files = vec![
            SchemaFile {
                path: "lab/orders/order.proto".into(),
                text: include_str!("../tests/fixtures/order.proto").into(),
            },
            SchemaFile {
                path: "lab/common/money.proto".into(),
                text: include_str!("../tests/fixtures/money.proto").into(),
            },
        ];
        let s = ProtoSchema::compile(&files, None).unwrap();
        let i = inspect(&CompiledSchema::Protobuf(s.clone()), None).unwrap();
        assert_eq!(i.message_types, vec!["lab.orders.Order"]);
        let validator = JsonSchemaSchema::parse(&i.json_schema.to_string(), &[]).unwrap();
        let msg = s.message(None).unwrap();
        let (_, decoded) = s
            .decode(
                &msg,
                &s.encode(
                    &msg,
                    r#"{"id":"x","total":{"units":"5"},"status":"PAID","items":["a"]}"#,
                )
                .unwrap(),
            )
            .unwrap();
        assert!(validator.violations(&decoded).is_empty());
        let example: Value = serde_json::from_str(&i.example).unwrap();
        assert!(validator.violations(&example).is_empty(), "{example}");
        s.encode(&msg, &i.example).unwrap();
        assert!(!validator.violations(&json!({"status": "LOST"})).is_empty());
    }

    #[test]
    fn recursive_and_well_known() {
        let files = vec![SchemaFile {
            path: "t.proto".into(),
            text: "syntax = \"proto3\"; import \"google/protobuf/timestamp.proto\"; message Node { string id = 1; repeated Node children = 2; map<string, int64> counts = 3; google.protobuf.Timestamp at = 4; }".into(),
        }];
        let s = ProtoSchema::compile(&files, None).unwrap();
        let i = inspect(&CompiledSchema::Protobuf(s.clone()), None).unwrap();
        let validator = JsonSchemaSchema::parse(&i.json_schema.to_string(), &[]).unwrap();
        let v = json!({"id": "a", "children": [{"id": "b", "children": []}], "counts": {"x": "9007199254740993"}, "at": "2026-11-18T00:00:00Z"});
        assert!(
            validator.violations(&v).is_empty(),
            "{:?}",
            validator.violations(&v)
        );
        let msg = s.message(None).unwrap();
        s.encode(&msg, &i.example).unwrap();

        let avro = AvroSchema::parse(
            r#"{"type":"record","name":"L","fields":[{"name":"next","type":["null","L"]}]}"#,
            &[],
        )
        .unwrap();
        let i = inspect(&CompiledSchema::Avro(avro), None).unwrap();
        assert_eq!(
            i.json_schema["$defs"]["L"]["properties"]["next"]["anyOf"][1]["$ref"],
            "#/$defs/L"
        );
    }

    #[test]
    fn json_schema_examples() {
        let s = json!({"type":"object","properties":{"a":{"type":"string","format":"date"},"b":{"$ref":"#/$defs/B"},"c":{"type":["null","integer"],"minimum":3}},"$defs":{"B":{"enum":["x","y"]}}});
        assert_eq!(example(&s), json!({"a":"2026-01-01","b":"x","c":3}));
    }
}
