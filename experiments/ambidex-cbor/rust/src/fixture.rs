//! Rust-first fixture types. Semantic metadata comes from these declarations.
use crate::model::{Direction, Graph, Semantic};
use crate::scalar::{Decimal as D, temporal};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;
macro_rules! scalar_type {
    ($name:ident,$kind:literal,$validate:expr,$meta:expr) => {
        #[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
        #[serde(try_from = "String", into = "String")]
        #[schemars(with = "String")]
        #[ts(type = "string")]
        pub struct $name(pub String);
        impl TryFrom<String> for $name {
            type Error = String;
            fn try_from(s: String) -> Result<Self, String> {
                ($validate)(&s).map(Self)
            }
        }
        impl From<$name> for String {
            fn from(v: $name) -> String {
                v.0
            }
        }
        impl Semantic for $name {
            fn name() -> String {
                stringify!($name).into()
            }
            fn describe(_: &mut Graph, _: Direction) -> Result<Value, String> {
                Ok($meta)
            }
        }
    };
}
scalar_type!(
    Decimal,
    "decimal",
    |s: &str| D::parse(s).map(|d| d.text()),
    json!({"type":"decimal","precision":"38","maxAbsScale":"1000","scaleSignificant":true})
);
scalar_type!(
    Instant,
    "instant",
    |s: &str| temporal(s, "instant"),
    json!({"type":"instant","precision":"9"})
);
scalar_type!(
    Date,
    "date",
    |s: &str| temporal(s, "date"),
    json!({"type":"date"})
);
scalar_type!(
    LocalDateTime,
    "local",
    |s: &str| temporal(s, "local"),
    json!({"type":"local","precision":"9"})
);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
#[serde(rename = "EditInput", deny_unknown_fields)]
pub struct EditInput {
    pub id: u64,
    pub amount: Decimal,
    pub at: Instant,
    pub date: Date,
    pub local: LocalDateTime,
    pub secret: String,
}
/// Typed handler used at the simulated router boundary, with no production state.
pub fn edit(input: EditInput) -> EditInput {
    input
}
/// Direct schema-guided serde baseline: no logical tree before typed dispatch.
/// The prevalidator still runs first, so serde cannot collapse duplicate keys.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DirectEditInput {
    #[serde(with = "lossless_u64")]
    pub id: u64,
    pub amount: Decimal,
    pub at: Instant,
    pub date: Date,
    pub local: LocalDateTime,
    pub secret: String,
}
mod lossless_u64 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(v: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&v.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        let text = String::deserialize(d)?;
        crate::decode_u64(&text).map_err(D::Error::custom)
    }
}
pub fn direct(bytes: &[u8]) -> Result<DirectEditInput, String> {
    crate::json::validate(bytes)?;
    serde_json::from_slice(bytes).map_err(|e| e.to_string())
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct Recursive {
    pub value: u64,
    pub next: Option<Box<Recursive>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct Flattened {
    pub id: u64,
    #[serde(flatten)]
    pub extra: std::collections::BTreeMap<String, String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct Optional {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub count: u32,
    pub nullable: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
#[serde(untagged)]
pub enum Untagged {
    Number { value: u64 },
    Text { value: String },
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
pub enum Tagged {
    Number(u64),
    Text(String),
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS)]
#[serde(try_from = "i64", into = "i64")]
#[schemars(with = "i64")]
#[ts(type = "number")]
pub struct CheckedInteger(pub i64);
impl TryFrom<i64> for CheckedInteger {
    type Error = String;
    fn try_from(v: i64) -> Result<Self, String> {
        if v.unsigned_abs() > 9007199254740991 {
            return Err("unsafe number".into());
        }
        Ok(Self(v))
    }
}
impl From<CheckedInteger> for i64 {
    fn from(v: CheckedInteger) -> i64 {
        v.0
    }
}
impl Semantic for CheckedInteger {
    fn name() -> String {
        "CheckedInteger".into()
    }
    fn describe(_: &mut Graph, _: Direction) -> Result<Value, String> {
        Ok(
            json!({"type":"i64","mapping":"checked-number","minimum":"-9007199254740991","maximum":"9007199254740991"}),
        )
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct MappingInput {
    pub safe: CheckedInteger,
    pub full_signed: i64,
    pub full_unsigned: u64,
}
scalar_type!(
    LogicalBytes,
    "bytes",
    |s: &str| crate::bytes::decode(s).map(|v| crate::bytes::encode(&v)),
    json!({"type":"bytes","jsonEncoding":"base64-padded"})
);
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
#[serde(tag = "code", content = "details", rename_all = "snake_case")]
pub enum FixtureError {
    Rejected { message: String },
    Bounds { field: String },
}
pub fn try_edit(input: EditInput) -> Result<EditInput, FixtureError> {
    if input.id == 0 {
        return Err(FixtureError::Bounds { field: "id".into() });
    }
    Ok(edit(input))
}
