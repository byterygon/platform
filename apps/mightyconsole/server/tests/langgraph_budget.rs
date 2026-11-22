//! Replies stay under the frame limit for threads with many runs or heavy states (TSK-108,
//! Mightyconsole spec §9 "Replies and the frame limit"): the `langgraph` thread procedures
//! against a stand-in upstream that answers with big data. Before the fix: `runs.list` of 300 runs
//! with 64 KiB metadata, `threads.history` with checkpoints of 5 MiB and a state over 16 MiB failed
//! with `ResourceExhausted` ("result exceeds the frame size limit") or "length limit exceeded".
//! Loopback only, so it runs in CI's network namespace.

mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use ambidex::{Code, Kind};
use axum::extract::Request;
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use support::*;

const THREAD: &str = "11111111-1111-1111-1111-111111111111";
const KIB: usize = 1024;
const MIB: usize = 1024 * KIB;
/// The frame limit (`DEFAULT_MAX_FRAME_BYTES`): no reply may reach it.
const FRAME: usize = 16 * MIB;

fn checkpoint(n: usize, bytes: usize) -> Value {
    json!({
        "values": { "messages": [{ "role": "user", "content": "x".repeat(bytes) }], "steps": [n] },
        "next": [], "tasks": [],
        "checkpoint": { "thread_id": THREAD, "checkpoint_ns": "", "checkpoint_id": format!("c{n}") },
        "parent_checkpoint": { "checkpoint_id": format!("c{}", n + 1) },
        "metadata": { "step": n, "source": "loop" },
        "created_at": "2026-11-18T00:00:00Z",
    })
}

fn run(n: usize, metadata_bytes: usize) -> Value {
    json!({ "run_id": format!("r{n}"), "thread_id": THREAD, "assistant_id": "a1",
            "status": "success", "created_at": "c", "updated_at": "u",
            "metadata": { "n": n, "blob": "y".repeat(metadata_bytes) } })
}

/// What the stand-in upstream holds: runs and checkpoints, newest first, and what it was asked.
#[derive(Clone, Default)]
struct Data {
    runs: Arc<Vec<Value>>,
    /// Newest first; `c<n>` is the id.
    history: Arc<Vec<Value>>,
    asked: Arc<Mutex<Vec<String>>>,
    /// The size of the one `values` event a run stream sends after its `metadata`.
    event_bytes: usize,
    /// An answer to a history call for more than one checkpoint is over the client's 64 MiB cap
    /// (streamed as it is read, never built).
    over_cap: bool,
}

fn json_response(body: &Value) -> Response {
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn query_of(query: &str, key: &str) -> Option<usize> {
    query
        .split('&')
        .find_map(|q| q.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
}

fn text_response(body: String) -> Response {
    (StatusCode::OK, [("content-type", "application/json")], body).into_response()
}

async fn start_mock(data: Data) -> SocketAddr {
    // Serialised once: the answers are big and a slow runner should not spend its time on them.
    let history_text: Arc<Vec<String>> =
        Arc::new(data.history.iter().map(Value::to_string).collect());
    let runs_text: Arc<Vec<String>> = Arc::new(data.runs.iter().map(Value::to_string).collect());
    let app = axum::Router::new().fallback(move |request: Request| {
        let data = data.clone();
        let history_text = history_text.clone();
        let runs_text = runs_text.clone();
        async move {
            let path = request.uri().path().to_owned();
            let query = request.uri().query().unwrap_or_default().to_owned();
            let method = request.method().clone();
            let body = axum::body::to_bytes(request.into_body(), 1 << 20)
                .await
                .unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
            data.asked
                .lock()
                .unwrap()
                .push(format!("{method} {path}?{query} {}", body));
            match (method, path.as_str()) {
                (Method::GET, "/info") => {
                    json_response(&json!({ "version": "0.18.2", "flags": {} }))
                }
                (Method::POST, p) if p.ends_with("/runs/stream") => {
                    let big = json!({ "messages": [{ "content": "z".repeat(data.event_bytes) }] });
                    let text = format!(
                        "event: metadata\ndata: {}\nid: 0\n\nevent: values\ndata: {big}\nid: 1\n\nevent: updates\ndata: {{\"plan\":1}}\nid: 2\n\n",
                        json!({ "run_id": "r9" })
                    );
                    (
                        StatusCode::OK,
                        [("content-type", "text/event-stream")],
                        text,
                    )
                        .into_response()
                }
                (Method::GET, p) if p.ends_with("/runs") => {
                    let limit = query_of(&query, "limit").unwrap_or(10);
                    let offset = query_of(&query, "offset").unwrap_or(0);
                    let list: Vec<&str> = runs_text
                        .iter()
                        .skip(offset)
                        .take(limit)
                        .map(String::as_str)
                        .collect();
                    text_response(format!("[{}]", list.join(",")))
                }
                (Method::GET, p) if p.contains("/runs/") => {
                    let id = p.rsplit('/').next().unwrap();
                    match data.runs.iter().position(|r| r["run_id"] == id) {
                        Some(i) => text_response(runs_text[i].clone()),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
                (Method::GET, p) if p.ends_with("/state") => text_response(history_text[0].clone()),
                (Method::GET, p) if p.contains("/state/") => {
                    let id = p.rsplit('/').next().unwrap();
                    match data
                        .history
                        .iter()
                        .position(|c| c["checkpoint"]["checkpoint_id"] == id)
                    {
                        Some(i) => text_response(history_text[i].clone()),
                        None => StatusCode::NOT_FOUND.into_response(),
                    }
                }
                (Method::POST, p) if p.ends_with("/history") => {
                    let limit = body["limit"].as_u64().unwrap_or(10) as usize;
                    if data.over_cap && limit > 1 {
                        let chunks = futures_util::stream::iter((0..70).map(|_| {
                            Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![b' '; MIB]))
                        }));
                        return (
                            StatusCode::OK,
                            [("content-type", "application/json")],
                            axum::body::Body::from_stream(chunks),
                        )
                            .into_response();
                    }
                    let after = body["before"]["configurable"]["checkpoint_id"]
                        .as_str()
                        .and_then(|b| {
                            data.history
                                .iter()
                                .position(|c| c["checkpoint"]["checkpoint_id"] == b)
                        })
                        .map_or(0, |i| i + 1);
                    let list: Vec<&str> = history_text
                        .iter()
                        .skip(after)
                        .take(limit)
                        .map(String::as_str)
                        .collect();
                    text_response(format!("[{}]", list.join(",")))
                }
                _ => StatusCode::NOT_FOUND.into_response(),
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

async fn setup(data: Data) -> (TestServer, Tab, String) {
    let addr = start_mock(data).await;
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    tab.call(
        2,
        "langgraph.connect",
        json!({ "profile": { "name": "mock", "url": format!("http://{addr}") } }),
    )
    .await;
    let conn = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    (t, tab, conn)
}

/// A call's result and the size of its frame.
async fn sized(tab: &mut Tab, id: u32, procedure: &str, input: Value) -> (Value, usize) {
    tab.call(id, procedure, input).await;
    let frame = tab.frame(id).await;
    assert_eq!(
        frame.kind,
        Kind::Result,
        "{procedure}: {}",
        String::from_utf8_lossy(&frame.payload[..frame.payload.len().min(400)])
    );
    assert!(frame.payload.len() < FRAME);
    (
        serde_json::from_slice(&frame.payload).unwrap(),
        frame.payload.len(),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn runs_come_in_pages_of_bytes_and_the_pages_add_up_to_every_run() {
    // 300 runs of 64 KiB metadata: 19 MiB in all, over the frame (before: ResourceExhausted).
    let data = Data {
        runs: Arc::new((0..300).map(|n| run(n, 64 * KIB)).collect()),
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data.clone()).await;
    let mut seen = Vec::new();
    let mut offset = Value::Null;
    let mut pages = 0;
    loop {
        let (page, bytes) = sized(
            &mut tab,
            10 + pages,
            "langgraph.runs.list",
            json!({ "connId": conn, "threadId": THREAD, "limit": 300, "offset": offset }),
        )
        .await;
        assert!(bytes <= 5 * MIB, "page {pages} is {bytes} bytes");
        pages += 1;
        for item in page["items"].as_array().unwrap() {
            assert_eq!(item["cuts"], json!([]), "64 KiB is within its share");
            seen.push(item["runId"].as_str().unwrap().to_owned());
        }
        match page.get("next") {
            Some(next) => offset = next.clone(),
            None => break,
        }
        assert!(pages < 20);
    }
    let all: Vec<String> = (0..300).map(|n| format!("r{n}")).collect();
    assert_eq!(seen, all, "every run once, in order");
    assert!(pages >= 4, "19 MiB does not fit one reply: {pages} pages");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_with_big_metadata_is_cut_and_loaded_on_request() {
    // Run 1 has 3 MiB of metadata (over the 1 MiB share), run 2 has 13 MiB (over what `get` carries).
    let data = Data {
        runs: Arc::new(vec![run(0, 100), run(1, 3 * MIB), run(2, 13 * MIB)]),
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data).await;
    let (page, bytes) = sized(
        &mut tab,
        10,
        "langgraph.runs.list",
        json!({ "connId": conn, "threadId": THREAD }),
    )
    .await;
    assert!(
        bytes < MIB,
        "the list carries notes, not the values: {bytes}"
    );
    assert!(page.get("next").is_none(), "the runs end here");
    let items = page["items"].as_array().unwrap();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0]["cuts"], json!([]));
    assert_eq!(items[0]["metadata"]["n"], 0);
    let cut = &items[1]["cuts"][0];
    assert_eq!(
        items[1]["metadata"],
        Value::Null,
        "nothing is kept of a cut value"
    );
    assert_eq!(cut["field"], "metadata");
    assert_eq!(cut["kind"], "object");
    assert!(cut["bytes"].as_u64().unwrap() > 3 * MIB as u64);
    assert!(
        cut["preview"]
            .as_str()
            .unwrap()
            .starts_with("{\"blob\":\"yyyy")
    );
    assert_eq!(items[2]["cuts"][0]["field"], "metadata");

    // One run's metadata, whole, when it fits one reply.
    let (got, bytes) = sized(
        &mut tab,
        11,
        "langgraph.runs.get",
        json!({ "connId": conn, "threadId": THREAD, "runId": "r1" }),
    )
    .await;
    assert!(bytes > 3 * MIB);
    assert_eq!(got["cuts"], json!([]));
    assert_eq!(got["metadata"]["blob"].as_str().unwrap().len(), 3 * MIB);

    // Over that, `get` still cuts and `readValue` streams the metadata.
    let (got, _) = sized(
        &mut tab,
        12,
        "langgraph.runs.get",
        json!({ "connId": conn, "threadId": THREAD, "runId": "r2" }),
    )
    .await;
    assert_eq!(got["cuts"][0]["field"], "metadata");
    let whole = read_value(
        &mut tab,
        13,
        json!({ "connId": conn, "threadId": THREAD, "runId": "r2", "field": "metadata" }),
    )
    .await;
    let metadata: Value = serde_json::from_slice(&whole.0).unwrap();
    assert_eq!(metadata["n"], 2);
    assert_eq!(metadata["blob"].as_str().unwrap().len(), 13 * MIB);
    assert_eq!(whole.1["bytes"].as_u64().unwrap(), whole.0.len() as u64);
}

/// The bytes of `langgraph.threads.readValue` and its summary.
async fn read_value(tab: &mut Tab, id: u32, input: Value) -> (Vec<u8>, Value) {
    tab.call(id, "langgraph.threads.readValue", input).await;
    let mut out = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => {
                assert!(frame.payload.len() < FRAME);
                out.extend_from_slice(&frame.payload);
                tab.client.credit(id, 1).await;
            }
            Kind::StreamEnd => return (out, serde_json::from_slice(&frame.payload).unwrap()),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_history_of_heavy_checkpoints_comes_in_pages_with_notes() {
    // 6 checkpoints of 5 MiB (30 MiB upstream; before: ResourceExhausted from 5 per call, and
    // "length limit exceeded" at the UI's 50). Three a page, so the token is followed.
    let data = Data {
        history: Arc::new((0..6).map(|n| checkpoint(n, 5 * MIB)).collect()),
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data.clone()).await;
    let mut ids = Vec::new();
    let mut before = Value::Null;
    let mut pages = 0;
    loop {
        let (page, bytes) = sized(
            &mut tab,
            10 + pages,
            "langgraph.threads.history",
            json!({ "connId": conn, "threadId": THREAD, "limit": 3, "before": before }),
        )
        .await;
        assert!(bytes < 4 * MIB, "page {pages} is {bytes} bytes");
        pages += 1;
        for item in page["items"].as_array().unwrap() {
            ids.push(item["checkpointId"].as_str().unwrap().to_owned());
            assert_eq!(item["values"], Value::Null);
            assert_eq!(item["cuts"][0]["field"], "values");
            assert!(item["cuts"][0]["bytes"].as_u64().unwrap() > 5 * MIB as u64);
            // What is small stays: the Step and Source columns read the metadata.
            assert_eq!(item["metadata"]["source"], "loop");
        }
        match page.get("next") {
            Some(next) => before = next.clone(),
            None => break,
        }
        assert!(pages < 20);
    }
    let all: Vec<String> = (0..6).map(|n| format!("c{n}")).collect();
    assert_eq!(ids, all, "every checkpoint once, newest first");

    // The upstream was asked for few at a time: its answers are far under the client's 64 MiB.
    let asked = data.asked.lock().unwrap().clone();
    let limits: Vec<u64> = asked
        .iter()
        .filter(|a| a.contains("/history"))
        .map(|a| {
            let (_, body) = a.split_once(" {").unwrap();
            serde_json::from_str::<Value>(&format!("{{{body}")).unwrap()["limit"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert!(limits.iter().all(|l| *l <= 3), "{limits:?}");
    assert!(pages >= 2, "limit 3 of 6 is two pages: {pages}");

    // One checkpoint, whole, on request (5 MiB is within the state's reply).
    let (state, bytes) = sized(
        &mut tab,
        40,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": THREAD, "checkpointId": "c3" }),
    )
    .await;
    assert!(bytes > 5 * MIB);
    assert_eq!(state["cuts"], json!([]));
    assert_eq!(
        state["values"]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .len(),
        5 * MIB
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_heavy_page_is_asked_again_for_fewer_checkpoints() {
    // More than one checkpoint at once is over the client's 64 MiB cap ("length limit exceeded"
    // before): the tool asks for half as many, down to one.
    let data = Data {
        history: Arc::new((0..3).map(|n| checkpoint(n, 2 * MIB)).collect()),
        over_cap: true,
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data.clone()).await;
    let (page, _) = sized(
        &mut tab,
        10,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": THREAD, "limit": 50 }),
    )
    .await;
    let ids: Vec<&str> = page["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["checkpointId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["c0", "c1", "c2"], "all three, one at a time");
    assert!(page["items"][0]["cuts"][0]["bytes"].as_u64().unwrap() > 2 * MIB as u64);
    let asked = data.asked.lock().unwrap().clone();
    let history: Vec<&String> = asked.iter().filter(|a| a.contains("/history")).collect();
    assert!(history[0].contains("\"limit\":3"), "{history:?}");
    assert!(history[1].contains("\"limit\":1"), "{history:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_small_history_is_one_page_with_nothing_left() {
    let data = Data {
        history: Arc::new((0..50).map(|n| checkpoint(n, 100)).collect()),
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data).await;
    let (page, _) = sized(
        &mut tab,
        10,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": THREAD, "limit": 50 }),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 50);
    assert_eq!(page["items"][49]["checkpointId"], "c49");
    assert!(page["items"][0]["cuts"].as_array().unwrap().is_empty());
    assert_eq!(
        page["items"][0]["values"]["messages"][0]["content"],
        "x".repeat(100)
    );
    // The limit still counts: 20 of the 50, with `next` to go on.
    let (page, _) = sized(
        &mut tab,
        11,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": THREAD, "limit": 20 }),
    )
    .await;
    assert_eq!(page["items"].as_array().unwrap().len(), 20);
    assert_eq!(page["next"], "c19");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_state_over_its_share_is_cut_then_loaded_then_streamed() {
    // The current state weighs 13 MiB: over what `full` carries (12 MiB); before this, a state over
    // 16 MiB was ResourceExhausted.
    let data = Data {
        history: Arc::new(vec![checkpoint(0, 13 * MIB)]),
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data).await;
    let (state, bytes) = sized(
        &mut tab,
        10,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": THREAD }),
    )
    .await;
    assert!(bytes < MIB);
    assert_eq!(state["values"], Value::Null);
    assert_eq!(state["cuts"][0]["field"], "values");
    assert_eq!(state["cuts"][0]["kind"], "object");
    assert!(state["cuts"][0]["bytes"].as_u64().unwrap() > 13 * MIB as u64);
    assert_eq!(
        state["checkpointId"], "c0",
        "the rest of the state is there"
    );
    // `full` allows 12 MiB: still over.
    let (state, _) = sized(
        &mut tab,
        11,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": THREAD, "full": true }),
    )
    .await;
    assert_eq!(state["cuts"][0]["field"], "values");
    // The stream has all of it.
    let (bytes, summary) = read_value(
        &mut tab,
        12,
        json!({ "connId": conn, "threadId": THREAD, "checkpointId": "c0", "field": "values" }),
    )
    .await;
    let values: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        values["messages"][0]["content"].as_str().unwrap().len(),
        13 * MIB
    );
    assert_eq!(summary["bytes"].as_u64().unwrap(), bytes.len() as u64);
    // A field that is not there is NotFound, not an empty stream.
    tab.call(
        13,
        "langgraph.threads.readValue",
        json!({ "connId": conn, "threadId": THREAD, "field": "tasks.4.state" }),
    )
    .await;
    tab.error(13, Code::NotFound).await;
}

/// The `jsonl` lines of a run stream, with the size of the biggest chunk.
async fn run_lines(tab: &mut Tab, id: u32) -> (Vec<Value>, Value, usize) {
    let mut lines = Vec::new();
    let mut biggest = 0;
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => {
                biggest = biggest.max(frame.payload.len());
                for line in frame
                    .payload
                    .split(|b| *b == b'\n')
                    .filter(|l| !l.is_empty())
                {
                    lines.push(serde_json::from_slice(line).unwrap());
                }
                tab.client.credit(id, 1).await;
            }
            Kind::StreamEnd => {
                return (
                    lines,
                    serde_json::from_slice(&frame.payload).unwrap(),
                    biggest,
                );
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_run_event_over_its_share_is_forwarded_as_a_note() {
    // A `values` event of 6 MiB (the whole state again; over 16 MiB it ended the run's stream with
    // "chunk exceeds the frame size limit"): over the 4 MiB share it is a note.
    let data = Data {
        event_bytes: 6 * MIB,
        ..Data::default()
    };
    let (_t, mut tab, conn) = setup(data).await;
    tab.call(
        10,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent", "input": {},
                "streamMode": ["values"], "streamId": "run-1" }),
    )
    .await;
    let (lines, summary, biggest) = run_lines(&mut tab, 10).await;
    assert!(biggest < MIB, "{biggest}");
    let names: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
    assert_eq!(names, ["metadata", "values", "updates"]);
    assert_eq!(lines[1]["data"], Value::Null);
    assert_eq!(lines[1]["cut"]["field"], "data");
    assert_eq!(lines[1]["cut"]["kind"], "object");
    assert!(lines[1]["cut"]["bytes"].as_u64().unwrap() > 6 * MIB as u64);
    assert!(
        lines[1]["cut"]["preview"]
            .as_str()
            .unwrap()
            .starts_with("{\"messages\":[{\"content\":\"zzz")
    );
    assert_eq!(lines[1]["id"], "1");
    assert!(lines[0].get("cut").is_none());
    assert_eq!(lines[2]["data"], json!({ "plan": 1 }), "the stream goes on");
    assert_eq!(summary["events"], 3);
    assert_eq!(summary["status"], "success");
}
