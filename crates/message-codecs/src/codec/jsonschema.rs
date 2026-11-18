//! JSON Schema (Mightyconsole spec §5.2): JSON payloads validated against a schema. Decoding
//! never fails on a violation: the JSON is shown and the violations are listed in
//! `decodeError`. Encoding refuses a payload that violates the schema.
//!
//! `$ref`s to other schemas resolve only among the schema's references (registry references or
//! the other files of a local schema); nothing is fetched (no HTTP or file retriever).

use std::collections::HashMap;
use std::sync::Arc;

use jsonschema::{Retrieve, Uri, Validator};
use serde_json::Value;

use crate::{CodecError, Result};

/// Violations listed in `decodeError`, at most.
const MAX_VIOLATIONS: usize = 20;

#[derive(Clone)]
pub struct JsonSchemaSchema {
    validator: Arc<Validator>,
    pub schema: Value,
    /// The schema text, as given.
    pub text: String,
}

impl std::fmt::Debug for JsonSchemaSchema {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsonSchemaSchema")
            .field("schema", &self.schema)
            .finish_non_exhaustive()
    }
}

struct References {
    by_name: HashMap<String, Value>,
}

impl Retrieve for References {
    fn retrieve(
        &self,
        uri: &Uri<String>,
    ) -> std::result::Result<Value, Box<dyn std::error::Error + Send + Sync>> {
        let full = uri.as_str();
        let path = uri.path().as_str();
        let candidates = [
            full,
            path,
            path.trim_start_matches('/'),
            path.rsplit('/').next().unwrap_or(path),
        ];
        for c in candidates {
            if let Some(v) = self.by_name.get(c) {
                return Ok(v.clone());
            }
        }
        Err(format!("{full} is not one of the schema's references").into())
    }
}

impl JsonSchemaSchema {
    /// Compiles a schema; `references` are `(name, text)` pairs a `$ref` may name.
    pub fn parse(text: &str, references: &[(String, String)]) -> Result<Self> {
        let schema: Value = serde_json::from_str(text).map_err(|e| {
            let mut err = CodecError::json(&e);
            err.message = format!("not a valid JSON Schema: {}", err.message);
            err
        })?;
        let mut by_name = HashMap::new();
        for (name, text) in references {
            let v: Value = serde_json::from_str(text).map_err(|e| {
                CodecError::invalid(format!("reference {name}: not valid JSON: {e}"))
            })?;
            by_name.insert(name.clone(), v);
        }
        let validator = jsonschema::options()
            .should_validate_formats(true)
            .with_retriever(References { by_name })
            .build(&schema)
            .map_err(|e| CodecError::invalid(format!("not a valid JSON Schema: {e}")))?;
        Ok(Self {
            validator: Arc::new(validator),
            schema,
            text: text.to_owned(),
        })
    }

    /// The schema's `title`, used as the record name by the record naming strategies.
    pub fn record_name(&self) -> Option<String> {
        self.schema
            .get("title")
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    /// The violations of `value`, as `"<instance path>: <message>"`.
    pub fn violations(&self, value: &Value) -> Vec<String> {
        self.validator
            .iter_errors(value)
            .take(MAX_VIOLATIONS)
            .map(|e| {
                let path = e.instance_path().to_string();
                format!("{}: {}", if path.is_empty() { "/" } else { &path }, e)
            })
            .collect()
    }

    /// Validates `value`; the error lists the violations.
    pub fn check(&self, value: &Value) -> Result<()> {
        let v = self.violations(value);
        if v.is_empty() {
            Ok(())
        } else {
            Err(CodecError::invalid(format!(
                "does not match the schema: {}",
                v.join("; ")
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_with_references() {
        let customer =
            r#"{"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}"#;
        let order = r#"{"title":"lab.Order","type":"object","properties":{"id":{"type":"string"},"customer":{"$ref":"customer.json"}},"required":["id"]}"#;
        let s =
            JsonSchemaSchema::parse(order, &[("customer.json".into(), customer.into())]).unwrap();
        assert_eq!(s.record_name().as_deref(), Some("lab.Order"));
        assert!(
            s.check(&json!({"id": "1", "customer": {"name": "a"}}))
                .is_ok()
        );
        let v = s.violations(&json!({"customer": {}}));
        assert_eq!(v.len(), 2, "{v:?}");
        assert!(v.iter().any(|m| m.starts_with("/customer:")), "{v:?}");
        assert!(v.iter().any(|m| m.starts_with("/:")), "{v:?}");
    }

    #[test]
    fn unknown_reference_is_an_error_not_a_fetch() {
        let order = r#"{"type":"object","properties":{"c":{"$ref":"https://example.com/c.json"}}}"#;
        assert!(JsonSchemaSchema::parse(order, &[]).is_err());
        assert!(JsonSchemaSchema::parse("{\"type\": 12}", &[]).is_err());
        let e = JsonSchemaSchema::parse("{\n\"type\": }", &[]).unwrap_err();
        assert_eq!(e.position.map(|p| p.line), Some(2));
    }
}
