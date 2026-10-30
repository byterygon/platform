//! Shared scenario values and schemas originate in Rust; all engines consume them.
use crate::{
    cbor::Value as C,
    fixture::{Date, Decimal, Instant, LocalDateTime},
    hydrate,
    model::{Direction, Graph, Semantic},
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;
// Mirrors db-driver::QuerySummary (RFC workload name: ExecuteSummary).
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct ExecuteSummary {
    pub rows_affected: Option<u64>,
    pub rows_returned: Option<u64>,
    pub elapsed_ms: u64,
    pub notices: Vec<String>,
    pub truncated: bool,
}
// Mirrors db-driver::TableInfo.
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct TableInfo {
    pub schema: Option<String>,
    pub name: String,
    pub kind: String,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct GridRow {
    pub id: u64,
    pub amount: Decimal,
    pub at: Instant,
    pub local: LocalDateTime,
}
#[derive(Clone, Serialize, Deserialize, JsonSchema, TS, Semantic)]
pub struct Mutation20 {
    pub customer_id: u64,
    pub version: u64,
    pub quantity: i64,
    pub unit_price: Decimal,
    pub discount: Decimal,
    pub tax: Decimal,
    pub ordered_at: Instant,
    pub delivery_date: Date,
    pub delivery_time: LocalDateTime,
    pub active: bool,
    pub approved: bool,
    pub customer_name: String,
    pub address: String,
    pub notes: String,
    pub sku: String,
    pub currency: String,
    pub region: String,
    pub email: String,
    pub reference: String,
    pub warehouse: String,
}
pub struct Workload {
    pub name: &'static str,
    pub schema: Value,
    pub logical: C,
    pub legacy: Value,
}
pub fn native_lossless(v: Value, schema: &Value) -> Result<Value, String> {
    fn walk(v: Value, s: &Value, defs: &Value) -> Result<Value, String> {
        if let Some(name) = s["ref"].as_str() {
            return walk(v, &defs[format!("{name}.Input")], defs);
        }
        let t = s["type"].as_str().unwrap_or("");
        match t {
            "i64" | "u64" => Ok(Value::String(v.to_string())),
            "nullable" => {
                if v.is_null() {
                    Ok(v)
                } else {
                    walk(v, &s["inner"], defs)
                }
            }
            "object" => {
                let mut map = v.as_object().ok_or("object")?.clone();
                for f in s["fields"].as_array().ok_or("fields")? {
                    let name = f["name"].as_str().ok_or("field name")?;
                    if let Some(v) = map.remove(name) {
                        map.insert(name.into(), walk(v, &f["schema"], defs)?);
                    }
                }
                Ok(Value::Object(map))
            }
            "array" => Ok(Value::Array(
                v.as_array()
                    .ok_or("array")?
                    .iter()
                    .cloned()
                    .map(|v| walk(v, &s["items"], defs))
                    .collect::<Result<_, _>>()?,
            )),
            _ => Ok(v),
        }
    }
    walk(v, &schema["root"], &schema["definitions"])
}
pub fn make<T: Serialize + Semantic + ambidex::codegen::Type>(
    name: &'static str,
    value: T,
) -> Workload {
    let schema = crate::model::checked::<T>(Direction::Input).unwrap();
    let legacy = serde_json::to_value(value).unwrap();
    let lossless = native_lossless(legacy.clone(), &schema).unwrap();
    let logical = hydrate::hydrate(&hydrate::raw_json(lossless).unwrap(), &schema, true).unwrap();
    Workload {
        name,
        schema,
        logical,
        legacy,
    }
}
pub fn all() -> Vec<Workload> {
    let mutation = Mutation20 {
        customer_id: 42,
        version: 7,
        quantity: 3,
        unit_price: Decimal::try_from("123456.2300".to_owned()).unwrap(),
        discount: Decimal::try_from("0.0000".to_owned()).unwrap(),
        tax: Decimal::try_from("8.2500".to_owned()).unwrap(),
        ordered_at: Instant::try_from("2026-10-29T12:34:56.123456789Z".to_owned()).unwrap(),
        delivery_date: Date::try_from("2026-10-30".to_owned()).unwrap(),
        delivery_time: LocalDateTime::try_from("2026-10-30T09:00:00.123456789".to_owned()).unwrap(),
        active: true,
        approved: false,
        customer_name: "Example customer account".repeat(3),
        address: "Example delivery address; local warehouse. ".repeat(3),
        notes: "Grid edit fixture: retain exact Decimal scale and nanosecond values. ".repeat(8),
        sku: "EXAMPLE-SKU-0000000042".into(),
        currency: "USD".into(),
        region: "local-region".into(),
        email: "customer@example.invalid".into(),
        reference: "00000000-0000-0000-0000-000000000042".into(),
        warehouse: "local-warehouse".into(),
    };
    vec![
        make(
            "ExecuteSummary",
            ExecuteSummary {
                rows_affected: Some(42),
                rows_returned: None,
                elapsed_ms: 123456,
                notices: vec!["execution complete".into()],
                truncated: false,
            },
        ),
        make(
            "metadata-500",
            (0..500)
                .map(|i| TableInfo {
                    schema: Some("public".into()),
                    name: format!("table_{i}"),
                    kind: "TABLE".into(),
                })
                .collect::<Vec<_>>(),
        ),
        make("mutation-20", mutation),
        make(
            "edited-grid",
            (0..100)
                .map(|i| GridRow {
                    id: i,
                    amount: Decimal::try_from("123456.2300".to_owned()).unwrap(),
                    at: Instant::try_from("2026-10-29T12:34:56.123456789Z".to_owned()).unwrap(),
                    local: LocalDateTime::try_from("2026-10-29T12:34:56.123456789".to_owned())
                        .unwrap(),
                })
                .collect::<Vec<_>>(),
        ),
    ]
}
pub fn export() -> Value {
    Value::Array(all().into_iter().map(|w|json!({"name":w.name,"schema":w.schema,"json":hydrate::emit(&w.logical,&w.schema).unwrap(),"legacy":w.legacy})).collect())
}
pub fn supplemental() -> Vec<Workload> {
    [
        (32, "large-control-256KiB"),
        (64, "large-control-512KiB"),
        (127, "large-control-near-1MiB"),
    ]
    .into_iter()
    .map(|(n, name)| make(name, vec!["x".repeat(8190); n]))
    .collect()
}
