//! The filter's throughput on the echo backend (TSK-143): messages per second through
//! `echo.messages.tail` with no filter, a text filter and a simple jq filter, over the real
//! server and WebSocket. Ignored by default (it measures, it does not check); run it with
//!
//! ```sh
//! cargo test -p mightyconsole-server --release --test filter_throughput -- --ignored --nocapture
//! ```
//!
//! The numbers before and after the filter's jq moved into a worker are on the TSK-143 page.

mod support;

use std::time::{Duration, Instant};

use ambidex::Kind;
use serde_json::{Value, json};
use support::*;

const MESSAGES: usize = 20_000;
const RUNS: usize = 3;

/// An order of about 250 bytes of JSON, half of them over 50.
fn order(i: usize) -> String {
    json!({
        "id": format!("o-{i}"),
        "status": if i.is_multiple_of(3) { "open" } else { "paid" },
        "total": (i % 100) as f64 + 0.5,
        "currency": "EUR",
        "customer": { "id": format!("c-{}", i % 977), "country": "VN", "tier": "gold" },
        "items": [
            { "sku": "a-1", "qty": 2, "price": 12.5 },
            { "sku": format!("b-{}", i % 13), "qty": 1, "price": 7.25 }
        ],
        "createdAt": "2026-11-24T10:00:00Z"
    })
    .to_string()
}

async fn produce(tab: &mut Tab, next: &mut u32, conn: &str, n: usize) {
    let mut sent = Vec::new();
    for i in 0..n {
        let id = *next;
        *next += 1;
        tab.call(
            id,
            "echo.messages.produce",
            json!({ "connId": conn, "value": { "codec": "json", "text": order(i) } }),
        )
        .await;
        sent.push(id);
        if sent.len() == 64 || i + 1 == n {
            for id in sent.drain(..) {
                tab.result(id).await;
            }
        }
    }
}

/// Reads a stream to its end, granting credits ahead; the summary and the time it took.
async fn drain(tab: &mut Tab, id: u32) -> (Value, Duration) {
    let started = Instant::now();
    tab.credit(id, 60).await;
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => tab.credit(id, 1).await,
            Kind::StreamEnd => {
                return (
                    serde_json::from_slice(&frame.payload).unwrap(),
                    started.elapsed(),
                );
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "measures throughput; run by hand with --ignored --nocapture"]
async fn filter_throughput_on_the_echo_backend() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = tab.connect(1).await;
    let mut next = 100;
    produce(&mut tab, &mut next, &conn, MESSAGES).await;

    let cases = [
        ("no filter", Value::Null),
        ("text filter", json!({ "text": "\"status\":\"paid\"" })),
        ("jq .value.total > 50", json!({ "jq": ".value.total > 50" })),
        (
            "jq .value.items | any(.qty > 1)",
            json!({ "jq": ".value.items | any(.qty > 1)" }),
        ),
    ];
    let mut id = 1_000_000;
    for (name, filter) in cases {
        let mut best = 0f64;
        for _ in 0..RUNS {
            id += 1;
            let mut input = json!({ "connId": conn, "streamId": format!("t{id}"), "start": { "kind": "earliest" }, "follow": false, "maxScan": 0 });
            if !filter.is_null() {
                input["filter"] = filter.clone();
            }
            tab.call(id, "echo.messages.tail", input).await;
            let (summary, took) = drain(&mut tab, id).await;
            assert_eq!(summary["scanned"], MESSAGES as u64, "{summary}");
            best = best.max(MESSAGES as f64 / took.as_secs_f64());
        }
        println!("{name:<34} {best:>10.0} messages/s (best of {RUNS}, {MESSAGES} messages)");
    }
}
