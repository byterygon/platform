//! CBOR (RFC 8949; TSK-85, DOC-21 Open question 45 (p)): self-describing, no schema. Decoded to
//! JSON as MessagePack is: byte strings as `{"$binary": base64}`, integers beyond 2^53 as strings,
//! map keys that are not text as their JSON text; tags as `{"$tag": n, "value": …}`. Encoded from
//! the same JSON.
//!
//! Detection (after JSON, before MessagePack): the bytes are one whole CBOR array or map, or
//! start with the self-describe tag 55799 (`d9 d9 f7`). Other tags are not detected, since their
//! first bytes (`c2` to `db`) also start UTF-8 characters. Bytes that read completely as both
//! MessagePack and CBOR (`80` is `{}` in one and `[]` in the other) stay MessagePack, as before
//! CBOR was added.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use ciborium::value::{Integer, Value};

use crate::ojson::Json;
use crate::{CodecError, Result};

const MAX_DEPTH: usize = 256;

/// The self-describe tag (RFC 8949 §3.4.6).
const SELF_DESCRIBE: u64 = 55799;

/// Whether the bytes are one whole CBOR array or map, or a self-described CBOR item.
pub fn detect(bytes: &[u8]) -> bool {
    let container = match bytes.first() {
        // Major type 4 (array) and 5 (map), definite or indefinite length.
        Some(0x80..=0x9b | 0x9f | 0xa0..=0xbb | 0xbf) => true,
        Some(0xd9) => bytes.starts_with(&[0xd9, 0xd9, 0xf7]),
        _ => false,
    };
    container && read(bytes).is_ok()
}

fn read(bytes: &[u8]) -> Result<Value> {
    let mut rd = bytes;
    let value: Value = ciborium::de::from_reader_with_recursion_limit(&mut rd, MAX_DEPTH)
        .map_err(|e| CodecError::invalid(format!("not valid CBOR: {e}")))?;
    if !rd.is_empty() {
        return Err(CodecError::invalid(format!(
            "not valid CBOR: {} bytes left after the first item",
            rd.len()
        )));
    }
    Ok(value)
}

pub fn decode(bytes: &[u8]) -> Result<Json> {
    Ok(to_json(&read(bytes)?))
}

fn integer(i: Integer) -> Json {
    let n = i128::from(i);
    match (i64::try_from(n), u64::try_from(n)) {
        (Ok(n), _) => Json::int(n),
        (Err(_), Ok(n)) => Json::uint(n),
        _ => Json::String(n.to_string()),
    }
}

fn to_json(v: &Value) -> Json {
    match v {
        Value::Null => Json::Null,
        Value::Bool(b) => Json::Bool(*b),
        Value::Integer(i) => integer(*i),
        Value::Float(f) => Json::float(*f),
        Value::Text(s) => Json::str(s.clone()),
        Value::Bytes(b) => binary(b),
        Value::Array(items) => Json::Array(items.iter().map(to_json).collect()),
        Value::Map(entries) => Json::Object(
            entries
                .iter()
                .map(|(k, v)| {
                    let key = match k {
                        Value::Text(s) => s.clone(),
                        other => to_json(other).to_text(),
                    };
                    (key, to_json(v))
                })
                .collect(),
        ),
        // The self-describe tag only says "this is CBOR".
        Value::Tag(SELF_DESCRIBE, inner) => to_json(inner),
        Value::Tag(tag, inner) => Json::Object(vec![
            ("$tag".into(), Json::uint(*tag)),
            ("value".into(), to_json(inner)),
        ]),
        // `Value` is non-exhaustive; every CBOR item is one of the above.
        _ => Json::Null,
    }
}

fn binary(bytes: &[u8]) -> Json {
    Json::Object(vec![("$binary".into(), Json::str(BASE64.encode(bytes)))])
}

/// Encodes JSON text as CBOR; object key order is kept.
pub fn encode(text: &str) -> Result<Vec<u8>> {
    let json = Json::parse(text).map_err(|e| CodecError::json(&e))?;
    let value = from_json(&json, "")?;
    let mut out = Vec::new();
    ciborium::ser::into_writer(&value, &mut out)
        .map_err(|e| CodecError::invalid(format!("CBOR: {e}")))?;
    Ok(out)
}

fn from_json(v: &Json, path: &str) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Bool(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i.into())
            } else if let Some(u) = n.as_u64() {
                Value::Integer(u.into())
            } else {
                Value::Float(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        Json::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(i, item)| from_json(item, &format!("{path}/{i}")))
                .collect::<Result<_>>()?,
        ),
        Json::Object(fields) => {
            if let [(k, Json::String(b))] = fields.as_slice()
                && k == "$binary"
            {
                return Ok(Value::Bytes(BASE64.decode(b).map_err(|e| {
                    CodecError::invalid(format!("{}: not valid base64: {e}", at(path)))
                })?));
            }
            if fields.len() == 2
                && let (Some(tag), Some(inner)) = (v.get("$tag"), v.get("value"))
            {
                let tag = match tag {
                    Json::Number(n) => n.as_u64(),
                    _ => None,
                }
                .ok_or_else(|| {
                    CodecError::invalid(format!("{}: $tag must be a whole number from 0", at(path)))
                })?;
                return Ok(Value::Tag(
                    tag,
                    Box::new(from_json(inner, &format!("{path}/value"))?),
                ));
            }
            Value::Map(
                fields
                    .iter()
                    .map(|(k, v)| {
                        Ok((
                            Value::Text(k.clone()),
                            from_json(v, &format!("{path}/{k}"))?,
                        ))
                    })
                    .collect::<Result<_>>()?,
            )
        }
    })
}

fn at(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_tags_and_binary() {
        let text = r#"{"user":"c-2207","cart":[1009,1010],"big":12345678901234567890,"neg":-9007199254740993,"f":1.5,"bin":{"$binary":"AAH/"},"at":{"$tag":1,"value":1795060000},"list":[null,true,{"x":[]}],"name":"Xin chào"}"#;
        let bytes = encode(text).unwrap();
        assert!(detect(&bytes));
        let json = decode(&bytes).unwrap();
        assert_eq!(
            json.to_text(),
            r#"{"user":"c-2207","cart":[1009,1010],"big":"12345678901234567890","neg":"-9007199254740993","f":1.5,"bin":{"$binary":"AAH/"},"at":{"$tag":1,"value":1795060000},"list":[null,true,{"x":[]}],"name":"Xin chào"}"#
        );
        let again = decode(&encode(&json.to_text()).unwrap()).unwrap();
        assert_eq!(again.to_value()["bin"], json.to_value()["bin"]);
        assert_eq!(again.to_value()["at"], json.to_value()["at"]);
    }

    #[test]
    fn rfc_examples_and_keys() {
        // RFC 8949 appendix A: {1: 2, 3: 4}, [1, [2, 3], [4, 5]], h'01020304', 0.5 (half float).
        assert_eq!(
            decode(&[0xa2, 0x01, 0x02, 0x03, 0x04]).unwrap().to_text(),
            r#"{"1":2,"3":4}"#
        );
        let nested = [0x83, 0x01, 0x82, 0x02, 0x03, 0x82, 0x04, 0x05];
        assert!(detect(&nested));
        assert_eq!(decode(&nested).unwrap().to_text(), "[1,[2,3],[4,5]]");
        assert_eq!(
            decode(&[0x81, 0x44, 1, 2, 3, 4]).unwrap().to_text(),
            r#"[{"$binary":"AQIDBA=="}]"#
        );
        assert_eq!(
            decode(&[0x81, 0xf9, 0x38, 0x00]).unwrap().to_text(),
            "[0.5]"
        );
        // Indefinite-length map {"a": 1}.
        assert_eq!(
            decode(&[0xbf, 0x61, b'a', 0x01, 0xff]).unwrap().to_text(),
            r#"{"a":1}"#
        );
        // The self-describe tag is dropped.
        assert_eq!(decode(&[0xd9, 0xd9, 0xf7, 0x80]).unwrap().to_text(), "[]");
    }

    #[test]
    fn detection() {
        assert!(detect(&[0xa0])); // {}
        assert!(detect(&[0xd9, 0xd9, 0xf7, 0xa0]));
        assert!(!detect(&[0x01])); // a bare integer
        assert!(!detect(&[0x82, 0x01])); // truncated
        assert!(!detect(&[0x81, 0x01, 0x00])); // trailing bytes
        assert!(!detect(br#"{"a":1}"#));
        assert!(!detect("é et è".as_bytes())); // c3 a9 …: a tag in CBOR, text here
        assert!(!detect(&[0xc1, 0xa0])); // a tag other than self-describe
    }

    #[test]
    fn bad_json_and_tags() {
        assert!(encode(r#"{"$tag":-1,"value":0}"#).is_err());
        assert!(encode(r#"{"$binary":"%%"}"#).is_err());
        assert!(encode("{").is_err());
        assert!(decode(&[0xff]).is_err());
    }
}
