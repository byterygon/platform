//! `api.manifest.json` and the schema hash (Ambidex spec §2, §3, §10).
//!
//! # Manifest
//!
//! One JSON object, keys sorted, two-space indentation, a final newline:
//!
//! - `format`: `"ambidex.manifest.v1"`; `protocol`: the frame protocol major;
//! - `api`: `{name, version}`; `schema_hash`;
//! - `procedures`: sorted by name, each with the full [`ProcedureMeta`](crate::ProcedureMeta)
//!   (`name`, `kind`, `perm`, `risk`, `agent`, `deprecated`, `timeout_default_ms`,
//!   `timeout_max_ms`, `log_input`, `redact`) and the JSON Schemas `input` (what the server
//!   accepts), `output` (what it sends: the event of a subscription, the final result of a stream)
//!   and `error` (the `details` of its errors as sent; `false` when it has none);
//! - `approval_required_details`: what else the `details` of any procedure's `ApprovalRequired`
//!   error can be: the approval id the router sets when the authorizer asks for approval;
//! - `$defs`: every named schema, referenced as `#/$defs/<name>`, so the manifest is itself a
//!   valid JSON Schema document to resolve them against. A type that serde writes differently
//!   from how it reads it (`#[serde(default)]`, `skip_serializing_if`, a plain `Option`, ...) has
//!   two entries: `<Name>` as read and `<Name>.Output` as written, and output schemas refer to the
//!   latter.
//!
//! # Schema hash
//!
//! `sha256:` + hex SHA-256 of the bytes `ambidex.schema-hash.v1` + `0x00` + the canonical JSON of
//! the contract. Canonical JSON is the same encoding as [`input_digest`](crate::input_digest):
//! object keys sorted by byte order, no whitespace, strings and numbers as serde_json writes them.
//! The contract is
//!
//! ```text
//! {"api": <name>, "protocol": 1,
//!  "procedures": [{name, kind, perm, risk, agent, deprecated, input, output, error}, ...],
//!  "$defs": {...}}
//! ```
//!
//! with procedures sorted by name and every schema reduced by [`normalize`] to its shape keywords
//! ([`SHAPE_KEYWORDS`]: `$ref`, `type`, `properties`, `required`, `items`, `enum`, `oneOf`, ...),
//! with `required` and `type` lists sorted. Doc comments, numeric formats and ranges, `default`,
//! `readOnly`/`writeOnly` and anything else schemars may add do not reach the hash. So the hash
//!
//! - changes with any procedure added, removed or renamed, any change of kind, permission, risk,
//!   agent exposure or deprecation, and any change of what JSON an input, output or error accepts
//!   (fields, renames, optionality, enum variants and their order, tagging), including renaming a
//!   named type;
//! - does not change with declaration order of procedures, fields or types, doc comments, integer
//!   widths (`u32` to `u64` is `number` either way), the API version, timeouts or audit settings
//!   (`log_input`, `redact`), none of which a client depends on;
//! - depends on the registry and on how the locked schemars version writes shapes: no time, path,
//!   host or environment. A schemars upgrade that writes a shape differently (a type name, how a
//!   nullable type is spelled) changes it; the CI drift check then fails, so that never ships
//!   unnoticed.
//!
//! A server puts it in [`ServerConfig::schema_hash`], which the engine compares exactly with the
//! client's `Hello.schema_hash`; the engine treats it as an opaque string, so the wire protocol is
//! unchanged.
//!
//! [`ServerConfig::schema_hash`]: crate::ServerConfig

use serde_json::{Map, Value, json};
use sha2::Digest as _;

use super::Model;
use crate::frame::PROTOCOL_VERSION;
use security_types::Digest;

pub const FORMAT: &str = "ambidex.manifest.v1";
pub const HASH_DOMAIN: &[u8] = b"ambidex.schema-hash.v1";

fn procedure_contract(model: &Model, p: &super::Resolved) -> Map<String, Value> {
    use super::Direction::{Input, Output};
    let meta = &p.meta;
    let mut obj = Map::new();
    obj.insert("name".into(), json!(meta.name));
    obj.insert("kind".into(), json!(meta.kind));
    obj.insert("perm".into(), json!(meta.perm.as_str()));
    obj.insert("risk".into(), json!(meta.risk));
    obj.insert("agent".into(), json!(meta.agent));
    obj.insert("deprecated".into(), json!(meta.deprecated));
    obj.insert("input".into(), model.published(&p.input_schema, Input));
    obj.insert("output".into(), model.published(&p.output_schema, Output));
    obj.insert("error".into(), model.published(&p.error_schema, Output));
    obj
}

fn defs(model: &Model) -> Value {
    Value::Object(
        model
            .defs
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// The schema hash of `model`.
pub(crate) fn hash(model: &Model) -> String {
    let mut procedures: Vec<_> = model
        .procedures
        .iter()
        .map(|p| Value::Object(procedure_contract(model, p)))
        .collect();
    procedures.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    for p in &mut procedures {
        for key in ["input", "output", "error"] {
            normalize(&mut p[key]);
        }
    }
    let mut defs = defs(model);
    if let Value::Object(defs) = &mut defs {
        defs.values_mut().for_each(normalize);
    }
    let contract = json!({
        "api": model.api.name,
        "protocol": PROTOCOL_VERSION,
        "procedures": procedures,
        "$defs": defs,
    });
    hash_contract(&contract)
}

/// `sha256:<hex>` of the domain-separated canonical JSON of `contract`.
pub fn hash_contract(contract: &Value) -> String {
    let mut bytes = HASH_DOMAIN.to_vec();
    bytes.push(0);
    crate::router::write_canonical(contract, &mut bytes);
    format!("sha256:{}", Digest(sha2::Sha256::digest(&bytes).into()))
}

/// Reduces the JSON Schema `schema`, in place, to the keywords that decide which JSON it describes
/// as TypeScript sees it ([`SHAPE_KEYWORDS`]), and sorts what is a set (`required`, a `type`
/// list). Everything else goes, in it and in every subschema: doc comments (`description`,
/// `title`), numeric formats and ranges (`format: "uint64"`, `minimum`), `default`, `readOnly`,
/// `writeOnly`, `uniqueItems`, examples, and any keyword a later schemars adds.
///
/// It walks the schema by keyword, so a property or definition that happens to be named like a
/// keyword (`default`, `enum`, `title`, ...) is still treated as a schema, and literal values
/// (`const`, `enum`) are kept as they are.
pub fn normalize(schema: &mut Value) {
    let Value::Object(obj) = schema else {
        return; // `true`, `false`
    };
    obj.retain(|key, _| SHAPE_KEYWORDS.contains(&key.as_str()));
    for (key, child) in obj.iter_mut() {
        match key.as_str() {
            "required" | "type" => {
                if let Value::Array(set) = child
                    && set.iter().all(Value::is_string)
                {
                    set.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
                }
            }
            // A schema.
            "items"
            | "additionalProperties"
            | "unevaluatedProperties"
            | "unevaluatedItems"
            | "propertyNames"
            | "not" => normalize(child),
            // A list of schemas.
            "allOf" | "anyOf" | "oneOf" | "prefixItems" => {
                if let Value::Array(items) = child {
                    items.iter_mut().for_each(normalize);
                }
            }
            // Schemas by name: the names are data, not keywords.
            "properties" | "patternProperties" | "$defs" => {
                if let Value::Object(map) = child {
                    map.values_mut().for_each(normalize);
                }
            }
            _ => {}
        }
    }
}

/// The keywords the schema hash keeps (see [`normalize`]). `minItems`/`maxItems` stay because
/// equal bounds make an array a fixed-length tuple in TypeScript.
pub const SHAPE_KEYWORDS: &[&str] = &[
    "$ref",
    "$defs",
    "type",
    "const",
    "enum",
    "properties",
    "required",
    "additionalProperties",
    "patternProperties",
    "propertyNames",
    "unevaluatedProperties",
    "items",
    "prefixItems",
    "minItems",
    "maxItems",
    "unevaluatedItems",
    "allOf",
    "anyOf",
    "oneOf",
    "not",
];

/// Renders the manifest and returns it with its schema hash.
pub(crate) fn render(model: &Model) -> (String, String) {
    let schema_hash = hash(model);
    let procedures: Vec<Value> = model
        .procedures
        .iter()
        .map(|p| {
            let mut obj = procedure_contract(model, p);
            let meta = &p.meta;
            obj.insert(
                "timeout_default_ms".into(),
                json!(duration_ms(meta.timeout_default)),
            );
            obj.insert(
                "timeout_max_ms".into(),
                json!(duration_ms(meta.timeout_max)),
            );
            obj.insert("log_input".into(), json!(meta.log_input));
            obj.insert("redact".into(), json!(meta.redact));
            Value::Object(obj)
        })
        .collect();
    let manifest = json!({
        "format": FORMAT,
        "protocol": PROTOCOL_VERSION,
        "api": { "name": model.api.name, "version": model.api.version },
        "schema_hash": schema_hash,
        "approval_required_details": { "$ref": "#/$defs/ApprovalRequiredDetails" },
        "procedures": procedures,
        "$defs": defs(model),
    });
    let mut out = String::new();
    write_pretty(&manifest, 0, &mut out);
    out.push('\n');
    (out, schema_hash)
}

pub(crate) fn duration_ms(d: std::time::Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// Pretty canonical JSON: keys sorted, two-space indentation.
pub(crate) fn write_pretty(value: &Value, indent: usize, out: &mut String) {
    let pad = |n: usize| "  ".repeat(n);
    match value {
        Value::Array(items) if items.is_empty() => out.push_str("[]"),
        Value::Object(map) if map.is_empty() => out.push_str("{}"),
        Value::Array(items) => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                out.push_str(&pad(indent + 1));
                write_pretty(item, indent + 1, out);
                out.push_str(if i + 1 < items.len() { ",\n" } else { "\n" });
            }
            out.push_str(&pad(indent));
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push_str("{\n");
            let n = entries.len();
            for (i, (key, item)) in entries.into_iter().enumerate() {
                out.push_str(&pad(indent + 1));
                out.push_str(&Value::String(key.clone()).to_string());
                out.push_str(": ");
                write_pretty(item, indent + 1, out);
                out.push_str(if i + 1 < n { ",\n" } else { "\n" });
            }
            out.push_str(&pad(indent));
            out.push('}');
        }
        scalar => out.push_str(&scalar.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_ignores_key_order_and_annotations() {
        let a = json!({"type": "object", "title": "A", "properties": {
            "x": {"type": "string", "description": "x"}}});
        let mut b = json!({"properties": {"x": {"description": "y", "type": "string"}},
            "type": "object", "title": "B"});
        let mut a2 = a.clone();
        normalize(&mut a2);
        normalize(&mut b);
        assert_eq!(hash_contract(&a2), hash_contract(&b));
        assert_ne!(hash_contract(&a), hash_contract(&a2));
    }

    #[test]
    fn properties_named_like_keywords_are_still_schemas() {
        let mut v = json!({
            "type": "object",
            "properties": {
                "default": {"type": "object", "description": "doc", "title": "T",
                            "required": ["b", "a"]},
                "enum": {"type": "string", "description": "doc"},
                "description": {"type": "string", "description": "doc"},
            },
            "required": ["enum", "default"],
            "$defs": {"title": {"type": "object", "description": "doc", "required": ["z", "y"]}},
            "const": {"title": "kept", "required": ["b", "a"]},
        });
        normalize(&mut v);
        assert_eq!(
            v,
            json!({
                "type": "object",
                "properties": {
                    "default": {"type": "object", "required": ["a", "b"]},
                    "enum": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["default", "enum"],
                "$defs": {"title": {"type": "object", "required": ["y", "z"]}},
                "const": {"title": "kept", "required": ["b", "a"]},
            })
        );
    }

    #[test]
    fn only_shape_keywords_are_hashed() {
        let mut v = json!({
            "type": ["null", "integer"], "format": "uint64", "minimum": 0, "default": 3,
            "readOnly": true, "x-future": 1, "items": {"type": "string", "maxLength": 3},
            "enum": [1, 2],
        });
        normalize(&mut v);
        assert_eq!(
            v,
            json!({"type": ["integer", "null"], "items": {"type": "string"}, "enum": [1, 2]})
        );
    }

    #[test]
    fn hash_is_domain_separated_sha256() {
        let h = hash_contract(&json!({}));
        let mut bytes = HASH_DOMAIN.to_vec();
        bytes.extend_from_slice(b"\0{}");
        let expected = Digest(sha2::Sha256::digest(&bytes).into());
        assert_eq!(h, format!("sha256:{expected}"));
        assert_eq!(h.len(), "sha256:".len() + 64);
    }

    #[test]
    fn pretty_output_is_sorted() {
        let mut out = String::new();
        write_pretty(&json!({"b": [1, {}], "a": []}), 0, &mut out);
        assert_eq!(out, "{\n  \"a\": [],\n  \"b\": [\n    1,\n    {}\n  ]\n}");
    }
}
