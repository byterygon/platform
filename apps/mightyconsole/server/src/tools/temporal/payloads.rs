//! Temporal messages as JSON, and their `Payload`s decoded (Mightyconsole spec §9.5).
//!
//! History events, `DescribeWorkflowExecution` and the like are turned into JSON through the
//! descriptors of the vendored protos (`prost-reflect`, protobuf's JSON mapping), so every
//! attribute of every event is there without a hand-written type per event. Then every `Payload`
//! (an object with `metadata.encoding` and `data`) is replaced by its decoded value:
//!
//! | `metadata.encoding` | becomes |
//! | --- | --- |
//! | `json/plain`, `json/protobuf` | the JSON value |
//! | `binary/null` | `null` |
//! | `binary/plain` | the text when it is UTF-8, else `{ "$opaque": … }` |
//! | `binary/protobuf` | `{ "$protobuf": <messageType>, "base64": … }` (the codec registry of TSK-80 decodes it once it is on `main`) |
//! | anything else, `binary/encrypted` | `{ "$opaque": <encoding>, "base64": …, "note": … }` |
//!
//! Raw bytes are always kept in `base64` of an opaque value.
//!
//! External Storage (TSK-103): [`super::extstore::resolve_json`] runs first and swaps a reference for
//! the payload it stands for, marked `$external`; that payload decodes as any other. A reference it
//! could not read (or one never resolved) becomes `{ "$external": { driver, bucket, key, bytes,
//! error } }`.

use std::sync::OnceLock;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use prost_reflect::{DescriptorPool, DynamicMessage, SerializeOptions};
use serde_json::{Map, Value, json};

use crate::core::ToolError;

const OPAQUE_NOTE: &str = "encoded by a payload codec; a codec server is not supported in v0.1";

/// The descriptors of the vendored Temporal protos, written by `build.rs`.
fn pool() -> &'static DescriptorPool {
    static POOL: OnceLock<DescriptorPool> = OnceLock::new();
    POOL.get_or_init(|| {
        DescriptorPool::decode(
            include_bytes!(concat!(env!("OUT_DIR"), "/temporal_descriptor.bin")).as_slice(),
        )
        .expect("the descriptor set that build.rs wrote is valid")
    })
}

/// `message` as protobuf-JSON (camelCase, enum names, RFC 3339 timestamps, 64-bit integers as
/// numbers, default fields left out), payloads decoded. `full_name` is the message's protobuf
/// name, such as `temporal.api.history.v1.HistoryEvent`.
pub fn to_json<M: prost::Message>(full_name: &str, message: &M) -> Result<Value, ToolError> {
    let mut value = to_json_raw(full_name, message)?;
    decode_payloads(&mut value);
    Ok(value)
}

/// `message` as protobuf-JSON with its payloads as stored (`metadata` and `data` in base64): the
/// History view's Raw form.
pub fn to_json_raw<M: prost::Message>(full_name: &str, message: &M) -> Result<Value, ToolError> {
    let internal =
        |what: String| ToolError::new(crate::core::ToolErrorKind::Remote, super::TOOL, what);
    let descriptor = pool()
        .get_message_by_name(full_name)
        .ok_or_else(|| internal(format!("unknown message {full_name}")))?;
    let dynamic = DynamicMessage::decode(descriptor, message.encode_to_vec().as_slice())
        .map_err(|e| internal(format!("cannot read {full_name}: {e}")))?;
    let options = SerializeOptions::new()
        .skip_default_fields(true)
        .stringify_64_bit_integers(false);
    dynamic
        .serialize_with_options(serde_json::value::Serializer, &options)
        .map_err(|e| internal(format!("cannot write {full_name} as JSON: {e}")))
}

/// The encodings of the payloads in `value` (as stored, before decoding), in document order:
/// `["json/plain", "binary/encrypted"]`. The History view labels a payload's form with them.
pub fn payload_encodings(value: &Value) -> Vec<String> {
    let mut out = Vec::new();
    collect_encodings(value, &mut out);
    out
}

fn collect_encodings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(object) => {
            let encoding = object
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|m| m.get("encoding"))
                .and_then(Value::as_str)
                .and_then(|b| BASE64.decode(b).ok())
                .and_then(|b| String::from_utf8(b).ok());
            match encoding {
                Some(encoding) if object.keys().all(|k| PAYLOAD_KEYS.contains(&k.as_str())) => {
                    // A payload read from External Storage names its driver; one the payload codec
                    // decoded, what it was ("binary/encrypted → json/plain").
                    let via = object
                        .get("$external")
                        .filter(|e| e.get("error").is_none())
                        .and_then(|e| e.get("driver"))
                        .and_then(Value::as_str);
                    let from = object
                        .get("$codec")
                        .and_then(|c| c.get("from"))
                        .and_then(Value::as_str);
                    let shown = match from {
                        Some(from) => format!("{from} → {encoding}"),
                        None => encoding,
                    };
                    out.push(match via {
                        Some(driver) => format!("{shown} via {driver}"),
                        None => shown,
                    })
                }
                _ => object.values().for_each(|v| collect_encodings(v, out)),
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_encodings(v, out)),
        _ => {}
    }
}

/// The members of a payload object: protobuf's, and the marks External Storage and the payload
/// codec leave (`$external`, `$codec`, `$codecError`).
const PAYLOAD_KEYS: &[&str] = &[
    "metadata",
    "data",
    "externalPayloads",
    "$external",
    "$codec",
    "$codecError",
];

/// Replaces every payload in `value` by its decoded form, and `{ "payloads": [...] }` by the array.
pub fn decode_payloads(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if let Some(decoded) = payload_value(object) {
                *value = decoded;
                return;
            }
            for child in object.values_mut() {
                decode_payloads(child);
            }
            // `Payloads` is just a list.
            if object.len() == 1 && object.get("payloads").is_some_and(Value::is_array) {
                *value = object.remove("payloads").unwrap_or(Value::Null);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(decode_payloads),
        _ => {}
    }
}

/// The decoded form of `object` if it is a payload (`metadata.encoding` is a string).
fn payload_value(object: &Map<String, Value>) -> Option<Value> {
    let metadata = object.get("metadata")?.as_object()?;
    if !object.keys().all(|k| PAYLOAD_KEYS.contains(&k.as_str())) {
        return None;
    }
    // A reference that could not be read says what and why.
    if let Some(external) = object.get("$external").filter(|e| e.get("error").is_some()) {
        return Some(json!({ "$external": external }));
    }
    let text_of = |key: &str| -> Option<String> {
        let bytes = BASE64.decode(metadata.get(key)?.as_str()?).ok()?;
        String::from_utf8(bytes).ok()
    };
    let encoding = text_of("encoding")?;
    let data = match object.get("data") {
        Some(Value::String(text)) => BASE64.decode(text).ok()?,
        Some(_) => return None,
        None => Vec::new(),
    };
    let message_type = text_of("messageType");
    if object.get("$external").is_none()
        && let Some(reference) =
            super::extstore::reference_of(&encoding, message_type.as_deref(), &data, None)
    {
        let mut info = Map::new();
        info.insert("driver".into(), Value::String(reference.driver));
        for k in ["bucket", "key"] {
            if let Some(v) = reference.claim.get(k) {
                info.insert(k.into(), Value::String(v.clone()));
            }
        }
        info.insert(
            "error".into(),
            Value::String(
                "stored outside Temporal; set up External Storage in the profile to read it".into(),
            ),
        );
        return Some(json!({ "$external": info }));
    }
    let mut decoded = decode(&encoding, &data, message_type.as_deref());
    // The payload codec could not read it: as stored, saying why.
    if let Some(error) = object
        .get("$codecError")
        .and_then(|e| e.get("error"))
        .and_then(Value::as_str)
        && let Value::Object(opaque) = &mut decoded
    {
        opaque.insert(
            "note".into(),
            Value::String(format!("Codec failed: {error}")),
        );
        opaque.insert("codecError".into(), Value::String(error.to_owned()));
    }
    Some(decoded)
}

/// One payload by its encoding (spec §9.5).
pub fn decode(encoding: &str, data: &[u8], message_type: Option<&str>) -> Value {
    let opaque = |encoding: &str| json!({ "$opaque": encoding, "bytes": data.len(), "base64": BASE64.encode(data), "note": OPAQUE_NOTE });
    match encoding {
        "binary/null" => Value::Null,
        "json/plain" | "json/protobuf" => match serde_json::from_slice(data) {
            Ok(value) => value,
            Err(_) => match std::str::from_utf8(data) {
                Ok(text) => Value::String(text.to_owned()),
                Err(_) => opaque(encoding),
            },
        },
        "binary/plain" => match std::str::from_utf8(data) {
            Ok(text) => Value::String(text.to_owned()),
            Err(_) => {
                json!({ "$opaque": encoding, "bytes": data.len(), "base64": BASE64.encode(data) })
            }
        },
        "binary/protobuf" => {
            json!({ "$protobuf": message_type.unwrap_or(""), "bytes": data.len(), "base64": BASE64.encode(data) })
        }
        other => opaque(other),
    }
}

/// A JSON value as one `json/plain` payload (arguments of signals, queries and resets).
pub fn encode_json(
    value: &Value,
) -> Result<crate::tools::temporal::proto::temporal::api::common::v1::Payload, ToolError> {
    use crate::tools::temporal::proto::temporal::api::common::v1::Payload;
    let data = serde_json::to_vec(value)
        .map_err(|e| ToolError::invalid(super::TOOL, "args", e.to_string()))?;
    Ok(Payload {
        metadata: [("encoding".to_owned(), b"json/plain".to_vec())].into(),
        data,
        external_payloads: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(encoding: &str, data: &[u8]) -> Value {
        json!({ "metadata": { "encoding": BASE64.encode(encoding) }, "data": BASE64.encode(data) })
    }

    #[test]
    fn each_encoding_decodes_as_the_spec_says() {
        let mut v = payload("json/plain", br#"{"orderId":"o-1","qty":2}"#);
        decode_payloads(&mut v);
        assert_eq!(v, json!({ "orderId": "o-1", "qty": 2 }));

        let mut v = payload("binary/null", b"");
        decode_payloads(&mut v);
        assert_eq!(v, Value::Null);

        let mut v = payload("binary/plain", "héllo".as_bytes());
        decode_payloads(&mut v);
        assert_eq!(v, json!("héllo"));

        let mut v = payload("json/protobuf", br#"{"a":1}"#);
        decode_payloads(&mut v);
        assert_eq!(v, json!({ "a": 1 }));

        let mut v = json!({ "metadata": { "encoding": BASE64.encode("binary/protobuf"), "messageType": BASE64.encode("lab.Order") }, "data": BASE64.encode([1, 2, 3]) });
        decode_payloads(&mut v);
        assert_eq!(
            v,
            json!({ "$protobuf": "lab.Order", "bytes": 3, "base64": "AQID" })
        );

        let mut v = payload("binary/encrypted", &[9, 9]);
        decode_payloads(&mut v);
        assert_eq!(v["$opaque"], "binary/encrypted");
        assert_eq!(v["base64"], "CQk=");
        assert!(v["note"].as_str().unwrap().contains("codec server"));
    }

    #[test]
    fn invalid_json_in_a_json_payload_falls_back_to_the_text() {
        let mut v = payload("json/plain", b"not json");
        decode_payloads(&mut v);
        assert_eq!(v, json!("not json"));
    }

    #[test]
    fn payload_lists_and_nested_payloads_are_decoded_in_place() {
        let mut v = json!({
            "input": { "payloads": [payload("json/plain", b"\"a\""), payload("json/plain", b"2")] },
            "memo": { "fields": { "note": payload("json/plain", b"\"hi\"") } },
            "other": { "metadata": { "k": "v" }, "title": "not a payload" },
        });
        decode_payloads(&mut v);
        assert_eq!(v["input"], json!(["a", 2]));
        assert_eq!(v["memo"]["fields"]["note"], json!("hi"));
        assert_eq!(v["other"]["title"], "not a payload");
    }

    #[test]
    fn a_history_event_becomes_json_with_its_payloads_decoded() {
        use crate::tools::temporal::proto::temporal::api::common::v1::{
            Payload, Payloads, WorkflowType,
        };
        use crate::tools::temporal::proto::temporal::api::history::v1::{
            HistoryEvent, WorkflowExecutionStartedEventAttributes, history_event::Attributes,
        };
        let input = Payloads {
            payloads: vec![encode_json(&json!({ "orderId": "o-1" })).unwrap()],
        };
        let event = HistoryEvent {
            event_id: 1,
            event_type: 1,
            attributes: Some(Attributes::WorkflowExecutionStartedEventAttributes(
                WorkflowExecutionStartedEventAttributes {
                    workflow_type: Some(WorkflowType {
                        name: "Fulfilment".into(),
                    }),
                    input: Some(input),
                    ..Default::default()
                },
            )),
            ..Default::default()
        };
        let json = to_json("temporal.api.history.v1.HistoryEvent", &event).unwrap();
        assert_eq!(json["eventId"], 1);
        assert_eq!(json["eventType"], "EVENT_TYPE_WORKFLOW_EXECUTION_STARTED");
        let attrs = &json["workflowExecutionStartedEventAttributes"];
        assert_eq!(attrs["workflowType"]["name"], "Fulfilment");
        assert_eq!(attrs["input"], json!([{ "orderId": "o-1" }]));
        let _ = Payload::default();
    }

    #[test]
    fn the_raw_form_keeps_payloads_as_stored_and_names_their_encodings() {
        use crate::tools::temporal::proto::temporal::api::common::v1::Payloads;
        use crate::tools::temporal::proto::temporal::api::history::v1::{
            HistoryEvent, WorkflowExecutionSignaledEventAttributes, history_event::Attributes,
        };
        let event = HistoryEvent {
            event_id: 7,
            attributes: Some(Attributes::WorkflowExecutionSignaledEventAttributes(
                WorkflowExecutionSignaledEventAttributes {
                    signal_name: "approve".into(),
                    input: Some(Payloads {
                        payloads: vec![encode_json(&json!("me")).unwrap()],
                    }),
                    ..Default::default()
                },
            )),
            ..Default::default()
        };
        let raw = to_json_raw("temporal.api.history.v1.HistoryEvent", &event).unwrap();
        assert_eq!(payload_encodings(&raw), vec!["json/plain".to_owned()]);
        let input = &raw["workflowExecutionSignaledEventAttributes"]["input"]["payloads"][0];
        assert_eq!(input["data"], BASE64.encode(b"\"me\""));
        assert!(input["metadata"]["encoding"].is_string());
    }
}
