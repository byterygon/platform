//! MessagePack (Mightyconsole spec §5.2, decision 11): decoded to JSON with binary as
//! `{"$binary": base64}`, ext as `{"$ext": type, "data": base64}` and integers beyond 2^53 as
//! strings; encoded from the same JSON.
//!
//! Map keys that are not strings are written as their JSON text (`1` → `"1"`). Integers beyond
//! 2^53 come back as strings, so re-encoding a decoded message writes them as strings unless
//! they are typed as numbers again (JSON text can hold them; the Composer sends text).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use rmpv::Value;

use crate::ojson::Json;
use crate::{CodecError, Result};

const MAX_DEPTH: usize = 256;

/// Whether the bytes parse completely as one MessagePack map or array (spec §5.2).
pub fn detect(bytes: &[u8]) -> bool {
    let Some(&first) = bytes.first() else {
        return false;
    };
    // fixmap 0x80-0x8f, fixarray 0x90-0x9f, array16/32 0xdc/0xdd, map16/32 0xde/0xdf.
    let container = matches!(first, 0x80..=0x9f | 0xdc..=0xdf);
    container && read(bytes).is_ok()
}

fn read(bytes: &[u8]) -> Result<Value> {
    let mut rd = bytes;
    let value = rmpv::decode::read_value_with_max_depth(&mut rd, MAX_DEPTH)
        .map_err(|e| CodecError::invalid(format!("not valid MessagePack: {e}")))?;
    if !rd.is_empty() {
        return Err(CodecError::invalid(format!(
            "not valid MessagePack: {} bytes left after the first value",
            rd.len()
        )));
    }
    Ok(value)
}

pub fn decode(bytes: &[u8]) -> Result<Json> {
    Ok(to_json(&read(bytes)?))
}

fn to_json(v: &Value) -> Json {
    match v {
        Value::Nil => Json::Null,
        Value::Boolean(b) => Json::Bool(*b),
        Value::Integer(i) => match (i.as_i64(), i.as_u64()) {
            (Some(n), _) => Json::int(n),
            (None, Some(n)) => Json::uint(n),
            (None, None) => Json::Null,
        },
        Value::F32(f) => Json::float(f64::from(*f)),
        Value::F64(f) => Json::float(*f),
        Value::String(s) => match s.as_str() {
            Some(s) => Json::str(s),
            // A str with invalid UTF-8: keep its bytes.
            None => binary(s.as_bytes()),
        },
        Value::Binary(b) => binary(b),
        Value::Array(items) => Json::Array(items.iter().map(to_json).collect()),
        Value::Map(entries) => Json::Object(
            entries
                .iter()
                .map(|(k, v)| {
                    let key = match k {
                        Value::String(s) if s.as_str().is_some() => {
                            s.as_str().unwrap_or_default().to_owned()
                        }
                        other => to_json(other).to_text(),
                    };
                    (key, to_json(v))
                })
                .collect(),
        ),
        Value::Ext(t, data) => Json::Object(vec![
            ("$ext".into(), Json::int(i64::from(*t))),
            ("data".into(), Json::str(BASE64.encode(data))),
        ]),
    }
}

fn binary(bytes: &[u8]) -> Json {
    Json::Object(vec![("$binary".into(), Json::str(BASE64.encode(bytes)))])
}

/// Encodes JSON text as MessagePack; object key order is kept.
pub fn encode(text: &str) -> Result<Vec<u8>> {
    let json = Json::parse(text).map_err(|e| CodecError::json(&e))?;
    let value = from_json(&json, "")?;
    let mut out = Vec::new();
    rmpv::encode::write_value(&mut out, &value)
        .map_err(|e| CodecError::invalid(format!("MessagePack: {e}")))?;
    Ok(out)
}

fn from_json(v: &Json, path: &str) -> Result<Value> {
    Ok(match v {
        Json::Null => Value::Nil,
        Json::Bool(b) => Value::Boolean(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else if let Some(u) = n.as_u64() {
                Value::from(u)
            } else {
                Value::F64(n.as_f64().unwrap_or(f64::NAN))
            }
        }
        Json::String(s) => Value::from(s.as_str()),
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
                return Ok(Value::Binary(base64_at(b, path)?));
            }
            if fields.len() == 2
                && let (Some(t), Some(Json::String(data))) = (v.get("$ext"), v.get("data"))
            {
                let t = match t {
                    Json::Number(n) => n.as_i64().and_then(|t| i8::try_from(t).ok()),
                    _ => None,
                }
                .ok_or_else(|| {
                    CodecError::invalid(format!(
                        "{}: $ext must be an integer from -128 to 127",
                        at(path)
                    ))
                })?;
                return Ok(Value::Ext(t, base64_at(data, path)?));
            }
            Value::Map(
                fields
                    .iter()
                    .map(|(k, v)| {
                        Ok((
                            Value::from(k.as_str()),
                            from_json(v, &format!("{path}/{k}"))?,
                        ))
                    })
                    .collect::<Result<_>>()?,
            )
        }
    })
}

fn base64_at(s: &str, path: &str) -> Result<Vec<u8>> {
    BASE64
        .decode(s)
        .map_err(|e| CodecError::invalid(format!("{}: not valid base64: {e}", at(path))))
}

fn at(path: &str) -> &str {
    if path.is_empty() { "/" } else { path }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_with_tags() {
        let text = r#"{"id":7,"name":"Xin chào","big":12345678901234567890,"neg":-9007199254740993,"f":1.5,"bin":{"$binary":"AAH/"},"ext":{"$ext":5,"data":"AQI="},"list":[null,true,{"x":[]}]}"#;
        let bytes = encode(text).unwrap();
        assert!(detect(&bytes));
        let json = decode(&bytes).unwrap();
        // Key order is kept; integers beyond 2^53 come back as strings.
        assert_eq!(
            json.to_text(),
            r#"{"id":7,"name":"Xin chào","big":"12345678901234567890","neg":"-9007199254740993","f":1.5,"bin":{"$binary":"AAH/"},"ext":{"$ext":5,"data":"AQI="},"list":[null,true,{"x":[]}]}"#
        );
        // Binary and ext survive a second trip byte for byte.
        let again = decode(&encode(&json.to_text()).unwrap()).unwrap();
        assert_eq!(again.to_value()["bin"], json.to_value()["bin"]);
        assert_eq!(again.to_value()["ext"], json.to_value()["ext"]);
    }

    #[test]
    fn detection() {
        assert!(detect(&[0x80])); // {}
        assert!(detect(&[0x91, 0x01])); // [1]
        assert!(!detect(&[0x01])); // a bare integer
        assert!(!detect(&[0x91])); // truncated
        assert!(!detect(&[0x90, 0x00])); // trailing bytes
        assert!(!detect(br#"{"a":1}"#)); // JSON's '{' is 0x7b, a positive fixint
    }

    #[test]
    fn non_string_keys_and_bad_tags() {
        let mut bytes = Vec::new();
        let v = Value::Map(vec![(Value::from(1), Value::from("one"))]);
        rmpv::encode::write_value(&mut bytes, &v).unwrap();
        assert_eq!(decode(&bytes).unwrap().to_text(), r#"{"1":"one"}"#);
        assert!(encode(r#"{"$ext":300,"data":""}"#).is_err());
        assert!(encode(r#"{"$binary":"%%"}"#).is_err());
    }
}
