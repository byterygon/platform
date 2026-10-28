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
//!   `timeout_max_ms`, `log_input`, `redact`) and the JSON Schemas `input`, `output` (the event
//!   of a subscription, the final result of a stream) and `error` (the `details` of its errors;
//!   `false` when it has none);
//! - `$defs`: every named schema, referenced as `#/$defs/<name>`, so the manifest is itself a
//!   valid JSON Schema document to resolve them against.
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
//! with procedures sorted by name, every `description` annotation removed and every `required` list
//! sorted (a set: its order is field declaration order). So the hash
//!
//! - changes with any procedure added, removed or renamed, any change of kind, permission, risk,
//!   agent exposure or deprecation, and any change of what JSON an input, output or error accepts
//!   (fields, renames, optionality, enum variants and their order, tagging), including renaming a
//!   named type;
//! - does not change with declaration order of procedures, fields or types, doc comments, the API
//!   version, timeouts or audit settings (`log_input`, `redact`), none of which a client depends
//!   on;
//! - depends on nothing but the registry: no time, path, host or environment.
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

pub const FORMAT: &str = "ambidex.manifest.v1";
pub const HASH_DOMAIN: &[u8] = b"ambidex.schema-hash.v1";

fn procedure_contract(p: &super::Resolved) -> Map<String, Value> {
    let meta = &p.meta;
    let mut obj = Map::new();
    obj.insert("name".into(), json!(meta.name));
    obj.insert("kind".into(), json!(meta.kind));
    obj.insert("perm".into(), json!(meta.perm.as_str()));
    obj.insert("risk".into(), json!(meta.risk));
    obj.insert("agent".into(), json!(meta.agent));
    obj.insert("deprecated".into(), json!(meta.deprecated));
    obj.insert("input".into(), p.input_schema.clone());
    obj.insert("output".into(), p.output_schema.clone());
    obj.insert("error".into(), p.error_schema.clone());
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
        .map(|p| Value::Object(procedure_contract(p)))
        .collect();
    procedures.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    let mut contract = json!({
        "api": model.api.name,
        "protocol": PROTOCOL_VERSION,
        "procedures": procedures,
        "$defs": defs(model),
    });
    normalize(&mut contract);
    hash_contract(&contract)
}

/// `sha256:<hex>` of the domain-separated canonical JSON of `contract`.
pub fn hash_contract(contract: &Value) -> String {
    let mut bytes = HASH_DOMAIN.to_vec();
    bytes.push(0);
    write_canonical(contract, &mut bytes);
    let digest = sha2::Sha256::digest(&bytes);
    let mut out = String::from("sha256:");
    for b in digest {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// Removes `description` annotations and sorts `required` lists, everywhere except inside literal
/// values.
pub fn normalize(value: &mut Value) {
    match value {
        Value::Object(obj) => {
            if obj.get("description").is_some_and(Value::is_string) {
                obj.remove("description");
            }
            if let Some(Value::Array(required)) = obj.get_mut("required")
                && required.iter().all(Value::is_string)
            {
                required.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
            for (key, child) in obj.iter_mut() {
                if !matches!(key.as_str(), "const" | "default" | "enum" | "examples") {
                    normalize(child);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(normalize),
        _ => {}
    }
}

/// Renders the manifest and returns it with its schema hash.
pub(crate) fn render(model: &Model) -> (String, String) {
    let schema_hash = hash(model);
    let procedures: Vec<Value> = model
        .procedures
        .iter()
        .map(|p| {
            let mut obj = procedure_contract(p);
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

/// Compact canonical JSON: keys sorted by byte order, independent of serde_json's
/// `preserve_order` feature.
fn write_canonical(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_canonical(item, out);
            }
            out.push(b']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            out.push(b'{');
            for (i, (key, item)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(Value::String(key.clone()).to_string().as_bytes());
                out.push(b':');
                write_canonical(item, out);
            }
            out.push(b'}');
        }
        scalar => out.extend_from_slice(scalar.to_string().as_bytes()),
    }
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
    fn hash_ignores_key_order_and_descriptions() {
        let a = json!({"b": 1, "a": {"type": "string", "description": "x"}});
        let mut b = json!({"a": {"description": "y", "type": "string"}, "b": 1});
        let mut a2 = a.clone();
        normalize(&mut a2);
        normalize(&mut b);
        assert_eq!(hash_contract(&a2), hash_contract(&b));
        assert_ne!(hash_contract(&a), hash_contract(&a2));
    }

    #[test]
    fn descriptions_inside_literals_and_properties_stay() {
        let mut v = json!({
            "properties": {"description": {"type": "string", "description": "doc"}},
            "default": {"description": "kept"},
        });
        normalize(&mut v);
        assert_eq!(
            v,
            json!({
                "properties": {"description": {"type": "string"}},
                "default": {"description": "kept"},
            })
        );
    }

    #[test]
    fn hash_is_domain_separated_sha256() {
        let h = hash_contract(&json!({}));
        let mut bytes = HASH_DOMAIN.to_vec();
        bytes.extend_from_slice(b"\0{}");
        let expected: String = sha2::Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(h, format!("sha256:{expected}"));
    }

    #[test]
    fn pretty_output_is_sorted() {
        let mut out = String::new();
        write_pretty(&json!({"b": [1, {}], "a": []}), 0, &mut out);
        assert_eq!(out, "{\n  \"a\": [],\n  \"b\": [\n    1,\n    {}\n  ]\n}");
    }
}
