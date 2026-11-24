//! The filter's jq in a worker per stream (Mightyconsole spec §5.4, TSK-143), end to end over the
//! real server and WebSocket on the echo backend: a program that never ends on a message, one
//! that overflows its stack and (on Linux) one that runs out of memory cost that message only (a
//! decode error with the reason) while the server stays responsive and the next messages are
//! evaluated; three such messages in a row end the stream with an error that says why; the
//! worker dies with its stream (cancelled, or its connection released).
//!
//! One test, run step by step: it counts the server's filter workers, which every stream of
//! this test binary shares.

mod support;

use std::time::{Duration, Instant};

use ambidex::{Code, Kind};
use mightyconsole_server::core::messaging::jq_filter::live_workers;
use serde_json::{Value, json};
use support::*;

async fn produce(tab: &mut Tab, next: &mut u32, conn: &str, n: usize) {
    let mut sent = Vec::new();
    for i in 0..n {
        let id = *next;
        *next += 1;
        tab.call(
            id,
            "echo.messages.produce",
            json!({ "connId": conn, "partition": 0, "value": { "codec": "json", "text": format!(r#"{{"n":{i}}}"#) } }),
        )
        .await;
        sent.push(id);
    }
    for id in sent {
        tab.result(id).await;
    }
}

/// Reads a stream to its end; the summary.
async fn summary(tab: &mut Tab, id: u32) -> Value {
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => tab.client.credit(id, 1).await,
            Kind::StreamEnd => return serde_json::from_slice(&frame.payload).unwrap(),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

/// Whether a process still runs (a zombie does not count).
fn alive(pid: u32) -> bool {
    let out = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

/// Waits until at most the spare worker is left, and checks the others are gone.
async fn only_the_spare_is_left(before: &[u32]) {
    let started = Instant::now();
    while live_workers().len() > 1 {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "filter workers still run: {:?}",
            live_workers()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let left = live_workers();
    for pid in before.iter().filter(|p| !left.contains(p)) {
        assert!(!alive(*pid), "worker {pid} still runs");
    }
}

/// The server answers a call at once while a stream's filter is busy.
async fn responsive(tab: &mut Tab, id: u32) {
    let started = Instant::now();
    tab.call(id, "app.info", json!({})).await;
    tab.result(id).await;
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "app.info took {:?}",
        started.elapsed()
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_filter_s_jq_runs_in_a_worker_per_stream() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = tab.connect(1).await;
    let mut next = 100;
    produce(&mut tab, &mut next, &conn, 10).await;
    let tail = |id: u32, jq: &str, extra: Value| {
        let mut input = json!({ "connId": conn, "streamId": format!("f{id}"), "start": { "kind": "earliest" }, "follow": false, "filter": { "jq": jq } });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        input
    };

    // A filter without trouble: the worker answers in order, as the filter did in process.
    tab.call(1000, "echo.messages.tail", tail(1000, ".value.n % 3 == 0", json!({})))
        .await;
    let s = summary(&mut tab, 1000).await;
    assert_eq!((&s["scanned"], &s["matched"], &s["decodeErrors"]), (&json!(10), &json!(4), &json!(0)), "{s}");
    assert!(s.get("filterError").is_none(), "{s}");

    // A program that never ends on one message: stopped at the budget, that message is a decode
    // error with the reason, and the messages after it are evaluated.
    let started = Instant::now();
    tab.call(
        1001,
        "echo.messages.tail",
        tail(1001, "if .value.n == 3 then (def f: f; f) else .value.n % 2 == 0 end", json!({ "jqTimeoutMs": 500 })),
    )
    .await;
    let s = summary(&mut tab, 1001).await;
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!((&s["scanned"], &s["matched"], &s["decodeErrors"]), (&json!(10), &json!(5), &json!(1)), "{s}");
    assert_eq!(s["endReason"], "end");
    assert!(
        s["filterError"].as_str().unwrap().contains("ran for more than 0.5 s"),
        "{s}"
    );

    // A stack overflow ends only the worker.
    tab.call(
        1002,
        "echo.messages.tail",
        tail(1002, "if .value.n == 5 then (def f: 1 + f; f) else true end", json!({})),
    )
    .await;
    let s = summary(&mut tab, 1002).await;
    assert_eq!((&s["matched"], &s["decodeErrors"]), (&json!(9), &json!(1)), "{s}");
    assert!(
        s["filterError"].as_str().unwrap().contains("recursed too deeply"),
        "{s}"
    );

    // The memory cap ends only the worker (Linux: the other systems have none reachable from
    // safe Rust, spec Open question 65 (d)).
    #[cfg(target_os = "linux")]
    {
        tab.call(
            1003,
            "echo.messages.tail",
            tail(1003, "if .value.n == 1 then (def f: f, f; [f]) else true end", json!({ "jqTimeoutMs": 30000 })),
        )
        .await;
        let s = summary(&mut tab, 1003).await;
        assert_eq!((&s["matched"], &s["decodeErrors"]), (&json!(9), &json!(1)), "{s}");
        assert!(
            s["filterError"].as_str().unwrap().contains("MiB of memory"),
            "{s}"
        );
    }

    // Three in a row end the stream, with the reason.
    tab.call(
        1004,
        "echo.messages.tail",
        tail(1004, "if .value.n >= 4 then (def f: f; f) else true end", json!({ "jqTimeoutMs": 500 })),
    )
    .await;
    let mut chunks = 0;
    let err = loop {
        let frame = tab.frame(1004).await;
        match frame.kind {
            Kind::Chunk => {
                chunks += 1;
                tab.client.credit(1004, 1).await;
            }
            Kind::Error => {
                break serde_json::from_slice::<ambidex::ErrorPayload>(&frame.payload).unwrap();
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert!(chunks >= 1, "the schema and the matches before the failures");
    assert_eq!(err.code, Code::InvalidArgument, "{err:?}");
    assert_eq!(err.details.as_ref().unwrap()["field"], "filter", "{err:?}");
    let message = err.message.as_str();
    assert!(message.contains("3 messages in a row"), "{message}");
    assert!(message.contains("ran for more than 0.5 s"), "{message}");

    // Cancelling a stream whose filter is busy forever: the server stays responsive, and the
    // worker dies with the stream.
    only_the_spare_is_left(&[]).await;
    tab.call(
        1005,
        "echo.messages.tail",
        tail(1005, "def f: f; f", json!({ "follow": true, "jqTimeoutMs": 30000 })),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    responsive(&mut tab, 1006).await;
    let busy = live_workers();
    assert!(!busy.is_empty());
    tab.client.cancel(1005).await;
    only_the_spare_is_left(&busy).await;

    // Releasing the connection ends its streams and their workers.
    tab.call(
        1007,
        "echo.messages.tail",
        tail(1007, "def f: f; f", json!({ "follow": true, "jqTimeoutMs": 30000 })),
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    responsive(&mut tab, 1008).await;
    let busy = live_workers();
    tab.call(1009, "echo.disconnect", json!({ "connId": conn }))
        .await;
    tab.result(1009).await;
    loop {
        if tab.frame(1007).await.kind == Kind::Error {
            break;
        }
    }
    only_the_spare_is_left(&busy).await;
}
