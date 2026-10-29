//! Parser-only Rust benchmark, not an end-to-end typed RPC measurement.
use ambidex_cbor_spike::cbor::{Value, decode, encode};
use std::{hint::black_box, time::Instant};
fn main() {
    let mut rows = Vec::new();
    for count in [1, 20, 100, 500] {
        let v = Value::Array(
            (0..count)
                .map(|i| Value::Array(vec![Value::Int(i), Value::Text("table_name".into())]))
                .collect(),
        );
        let bytes = encode(&v);
        for trial in 0..5 {
            let mut samples = Vec::new();
            for _ in 0..200 {
                let start = Instant::now();
                let v = decode(black_box(&bytes), true).unwrap();
                black_box(encode(&v));
                samples.push(start.elapsed().as_nanos() as u64);
            }
            rows.push(serde_json::json!({"elements":count,"trial":trial,"bytes":bytes.len(),"samplesNs":samples}));
        }
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"measurement":"CBOR syntax parse/re-encode only; not comparable with typed JS benchmark","results":rows})).unwrap());
}
