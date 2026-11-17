//! An ordered JSON value: decoders build one, then write it as text (field order kept, as the
//! record or map had it) and as a `serde_json::Value` (for filters). `serde_json::Map` sorts its
//! keys unless the workspace enables `preserve_order`, which this crate does not want to impose.

use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(serde_json::Number),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

/// Integers beyond ±(2^53 − 1) are written as strings so a JavaScript reader keeps every digit
/// (spec decision 11).
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

impl Json {
    pub fn str(s: impl Into<String>) -> Self {
        Json::String(s.into())
    }

    /// An integer: a number when JavaScript can hold it exactly, else a string.
    pub fn int(i: i64) -> Self {
        if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
            Json::Number(i.into())
        } else {
            Json::String(i.to_string())
        }
    }

    pub fn uint(u: u64) -> Self {
        if u <= MAX_SAFE_INTEGER as u64 {
            Json::Number(u.into())
        } else {
            Json::String(u.to_string())
        }
    }

    /// A float; NaN and infinities, which JSON cannot hold, become the strings `"NaN"`,
    /// `"Infinity"` and `"-Infinity"` (as proto3 JSON does).
    pub fn float(f: f64) -> Self {
        match serde_json::Number::from_f64(f) {
            Some(n) => Json::Number(n),
            None if f.is_nan() => Json::str("NaN"),
            None if f > 0.0 => Json::str("Infinity"),
            None => Json::str("-Infinity"),
        }
    }

    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("JSON values serialize")
    }

    pub fn to_value(&self) -> serde_json::Value {
        match self {
            Json::Null => serde_json::Value::Null,
            Json::Bool(b) => serde_json::Value::Bool(*b),
            Json::Number(n) => serde_json::Value::Number(n.clone()),
            Json::String(s) => serde_json::Value::String(s.clone()),
            Json::Array(items) => {
                serde_json::Value::Array(items.iter().map(Json::to_value).collect())
            }
            Json::Object(fields) => serde_json::Value::Object(
                fields
                    .iter()
                    .map(|(k, v)| (k.clone(), v.to_value()))
                    .collect(),
            ),
        }
    }
}

impl Serialize for Json {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        match self {
            Json::Null => s.serialize_unit(),
            Json::Bool(b) => s.serialize_bool(*b),
            Json::Number(n) => n.serialize(s),
            Json::String(v) => s.serialize_str(v),
            Json::Array(items) => {
                let mut seq = s.serialize_seq(Some(items.len()))?;
                for item in items {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Json::Object(fields) => {
                let mut map = s.serialize_map(Some(fields.len()))?;
                for (k, v) in fields {
                    map.serialize_entry(k, v)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> serde::Deserialize<'de> for Json {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> serde::de::Visitor<'de> for V {
            type Value = Json;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON")
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_bool<E>(self, b: bool) -> Result<Json, E> {
                Ok(Json::Bool(b))
            }
            fn visit_i64<E>(self, i: i64) -> Result<Json, E> {
                Ok(Json::Number(i.into()))
            }
            fn visit_u64<E>(self, u: u64) -> Result<Json, E> {
                Ok(Json::Number(u.into()))
            }
            fn visit_f64<E>(self, f: f64) -> Result<Json, E> {
                Ok(serde_json::Number::from_f64(f).map_or(Json::Null, Json::Number))
            }
            fn visit_str<E>(self, s: &str) -> Result<Json, E> {
                Ok(Json::String(s.to_owned()))
            }
            fn visit_string<E>(self, s: String) -> Result<Json, E> {
                Ok(Json::String(s))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut a: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(v) = a.next_element()? {
                    items.push(v);
                }
                Ok(Json::Array(items))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(self, mut a: A) -> Result<Json, A::Error> {
                let mut fields: Vec<(String, Json)> = Vec::new();
                while let Some((k, v)) = a.next_entry::<String, Json>()? {
                    // A repeated key keeps its last value, in its first place (as JSON.parse).
                    match fields.iter_mut().find(|(key, _)| *key == k) {
                        Some(slot) => slot.1 = v,
                        None => fields.push((k, v)),
                    }
                }
                Ok(Json::Object(fields))
            }
        }
        d.deserialize_any(V)
    }
}

impl Json {
    /// Parses JSON text keeping object key order.
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(text)
    }

    /// The value of a key of an object.
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn order_and_big_integers() {
        let j = Json::Object(vec![
            ("z".into(), Json::int(1)),
            ("a".into(), Json::int(1 << 60)),
            ("m".into(), Json::uint(u64::MAX)),
            ("f".into(), Json::float(f64::NAN)),
        ]);
        assert_eq!(
            j.to_text(),
            r#"{"z":1,"a":"1152921504606846976","m":"18446744073709551615","f":"NaN"}"#
        );
        assert_eq!(j.to_value()["a"], "1152921504606846976");
        assert_eq!(Json::int(MAX_SAFE_INTEGER).to_text(), "9007199254740991");
        assert_eq!(
            Json::int(-MAX_SAFE_INTEGER - 1).to_text(),
            "\"-9007199254740992\""
        );
        let parsed = Json::parse(r#"{"b":1,"a":[true,null,"x",-2,1.5],"b":2}"#).unwrap();
        assert_eq!(parsed.to_text(), r#"{"b":2,"a":[true,null,"x",-2,1.5]}"#);
    }
}
