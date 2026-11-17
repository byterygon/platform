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
    let mut value = dynamic
        .serialize_with_options(serde_json::value::Serializer, &options)
        .map_err(|e| internal(format!("cannot write {full_name} as JSON: {e}")))?;
    decode_payloads(&mut value);
    Ok(value)
}

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
    if !object
        .keys()
        .all(|k| k == "metadata" || k == "data" || k == "externalPayloads")
    {
        return None;
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
    Some(decode(&encoding, &data, text_of("messageType").as_deref()))
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
}
