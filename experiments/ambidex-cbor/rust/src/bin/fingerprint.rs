//! Rust build-tool prototype: serde/schemars declaration plus explicit logical metadata.
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
#[allow(dead_code)]
#[derive(Serialize, Deserialize, JsonSchema)]
#[serde(rename = "EditInput")]
struct EditInput {
    id: u64,
    amount: String,
    at: String,
    date: String,
    local: String,
    secret: String,
}
fn canonical(v: &Value) -> Vec<u8> {
    // Frozen research grammar: canonical compact JSON, sorted UTF-8 keys, all
    // schema numbers converted to decimal strings so bounds never pass through f64.
    fn normalize(v: &Value) -> Value {
        match v {
            Value::Object(o) => {
                let mut sorted = serde_json::Map::new();
                let mut keys: Vec<_> = o.keys().collect();
                keys.sort();
                for k in keys {
                    if !["title", "description", "$schema"].contains(&k.as_str()) {
                        sorted.insert(k.clone(), normalize(&o[k]));
                    }
                }
                Value::Object(sorted)
            }
            Value::Array(a) => Value::Array(a.iter().map(normalize).collect()),
            Value::Number(n) => Value::String(n.to_string()),
            _ => v.clone(),
        }
    }
    serde_json::to_vec(&normalize(v)).unwrap()
}
fn fingerprint(domain: &str, v: &Value) -> String {
    let mut h = Sha256::new();
    h.update(domain);
    h.update([0]);
    h.update(canonical(v));
    format!("sha256:{:x}", h.finalize())
}
fn main() {
    let schema = serde_json::to_value(schema_for!(EditInput)).unwrap();
    let contract = json!({"api":"spike","procedure":"fixture.edit","kind":"mutation","input":schema,"mapping":"bigint","logical":{"id":{"type":"uint64","maximum":"18446744073709551615"},"amount":{"type":"decimal","precision":"38","scaleSignificant":true,"maxAbsScale":"1000"},"at":{"type":"instant","precision":"9"},"date":{"type":"date"},"local":{"type":"local-datetime","precision":"9"}}});
    let policy = json!({"perm":"fixture.edit","risk":"write","agent":"hidden","deprecated":false,"timeoutDefaultMs":"30000","timeoutMaxMs":"300000","logInput":false});
    let out = json!({"contract":fingerprint("ambidex.semantic-schema.v2",&contract),"policy":fingerprint("ambidex.policy.v2",&policy),"model":contract,"policyModel":policy,"limitations":["Not a generic semantic derive","ts-rs agreement extension not implemented","Nominal recursion and untagged precedence not implemented"]});
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity() {
        assert_eq!(
            canonical(&json!({"b":1,"a":2})),
            canonical(&json!({"a":2,"b":1,"description":"docs"}))
        );
        assert_ne!(
            fingerprint("contract", &json!({"integer":"u32"})),
            fingerprint("contract", &json!({"integer":"u64"}))
        );
        assert_ne!(
            fingerprint("contract", &json!({"mapping":"bigint"})),
            fingerprint("contract", &json!({"mapping":"checked"}))
        );
        assert_ne!(
            fingerprint("contract", &json!({})),
            fingerprint("policy", &json!({}))
        );
    }
}
