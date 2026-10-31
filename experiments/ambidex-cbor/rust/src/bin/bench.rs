//! Validated, hydrated decode/encode pipeline on the same Rust-defined workloads.
use ambidex_cbor_spike::{
    alloc, cbor, fixture, hydrate, json,
    model::{Direction, Graph},
    workloads,
};
use std::{hint::black_box, time::Instant};
#[global_allocator]
static ALLOC: alloc::Tracking = alloc::Tracking;
fn main() {
    let mut rows = Vec::new();
    for w in workloads::all()
        .into_iter()
        .chain(workloads::supplemental())
    {
        let samples_count = if w.name.starts_with("large-control") {
            10
        } else {
            200
        };
        let warmup = if samples_count == 10 { 2 } else { 50 };
        let lossless = serde_json::to_vec(&hydrate::emit(&w.logical, &w.schema).unwrap()).unwrap();
        let binary = cbor::encode(&w.logical);
        let legacy = serde_json::to_vec(&w.legacy).unwrap();
        for codec in ["json-v1", "json", "cbor"] {
            let bytes = match codec {
                "cbor" => &binary,
                "json" => &lossless,
                _ => &legacy,
            };
            let op = || {
                if codec == "json-v1" {
                    let v: serde_json::Value = serde_json::from_slice(black_box(bytes)).unwrap();
                    black_box(serde_json::to_vec(&v).unwrap());
                    return;
                }
                let raw = if codec == "cbor" {
                    cbor::decode(black_box(bytes), true).unwrap()
                } else {
                    hydrate::raw_json(json::parse(black_box(bytes)).unwrap()).unwrap()
                };
                let logical = hydrate::hydrate(&raw, &w.schema, codec == "json").unwrap();
                if codec == "cbor" {
                    black_box(cbor::encode(&logical));
                } else {
                    black_box(
                        serde_json::to_vec(&hydrate::emit(&logical, &w.schema).unwrap()).unwrap(),
                    );
                }
            };
            for _ in 0..warmup {
                op()
            }
            for trial in 0..5 {
                let mut samples = Vec::with_capacity(samples_count);
                let usage_before = alloc::usage();
                let start_alloc = alloc::reset();
                let cpu = Instant::now();
                for _ in 0..samples_count {
                    let start = Instant::now();
                    op();
                    samples.push(start.elapsed().as_secs_f64() * 1000.0);
                }
                let elapsed = cpu.elapsed().as_secs_f64() * 1000.0;
                let (peak, calls) = alloc::finish(start_alloc);
                let usage_after = alloc::usage();
                rows.push(serde_json::json!({"name":w.name,"codec":codec,"trial":trial,"bytes":bytes.len(),"samplesMs":samples,"elapsedMs":elapsed,"allocationCalls":calls,"peakRequestedLiveBytesAboveBaseline":peak,"cpuUserSeconds":usage_after.0-usage_before.0,"cpuSystemSeconds":usage_after.1-usage_before.1,"processPeakRssBytesCumulative":usage_after.2,"legacyContextOnly":codec=="json-v1"}));
            }
        }
    }
    // Compare direct schema-guided serde with the logical-tree route separately.
    let schema = Graph::document::<fixture::EditInput>(Direction::Input).unwrap();
    let bytes=br#"{"id":"18446744073709551615","amount":"1.2300","at":"2026-10-29T12:34:56.123456789Z","date":"2026-02-28","local":"2026-10-29T12:34:56.123456789","secret":"hidden"}"#;
    let mut direct = Vec::new();
    for mode in ["direct-serde", "logical-tree"] {
        for trial in 0..5 {
            let mut samples = Vec::with_capacity(200);
            let tracking = alloc::reset();
            for _ in 0..200 {
                let start = Instant::now();
                if mode == "direct-serde" {
                    black_box(fixture::direct(bytes).unwrap());
                } else {
                    let raw = hydrate::raw_json(json::parse(bytes).unwrap()).unwrap();
                    let logical = hydrate::hydrate(&raw, &schema, true).unwrap();
                    let typed: fixture::EditInput =
                        serde_json::from_value(hydrate::json_value(&logical, false).unwrap())
                            .unwrap();
                    black_box(fixture::edit(typed));
                }
                samples.push(start.elapsed().as_secs_f64() * 1000.0);
            }
            let (peak, calls) = alloc::finish(tracking);
            direct.push(serde_json::json!({"mode":mode,"trial":trial,"samplesMs":samples,"allocationCalls":calls,"peakRequestedLiveBytesAboveBaseline":peak}));
        }
    }
    println!("{}",serde_json::to_string_pretty(&serde_json::json!({"measurement":"Validated syntax + hydration + encode. Direct-vs-tree benchmark includes Rust typed dispatch; json-v1 is contextual without extra validation.","allocationCaveat":"Requested bytes measured through System allocator wrapper, not malloc overhead or RSS","results":rows,"directVsTree":direct})).unwrap());
}
