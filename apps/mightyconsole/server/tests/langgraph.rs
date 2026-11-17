//! The `langgraph` tool against a stand-in LangGraph server on loopback (Mightyconsole spec §11,
//! TSK-84): the HTTP calls each procedure makes, the answers as the UI reads them, the errors,
//! and run streams (credits, resumable runs, join with `Last-Event-ID`). The real server is
//! `tests/langgraph_lab.rs` (feature `lab-tests`). Runs in CI's network namespace: loopback only.

mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::{Code, ErrorPayload};
use axum::body::{Body, Bytes};
use axum::extract::Request;
use axum::http::{HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use support::*;

/// A request the stand-in server received.
#[derive(Debug, Clone)]
struct Seen {
    method: Method,
    path: String,
    query: String,
    headers: HeaderMap,
    body: Value,
}

#[derive(Clone, Default)]
struct Mock {
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Mock {
    fn requests(&self, path: &str) -> Vec<Seen> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .filter(|s| s.path == path)
            .cloned()
            .collect()
    }

    fn last(&self, path: &str) -> Seen {
        self.requests(path)
            .pop()
            .unwrap_or_else(|| panic!("no request to {path}"))
    }
}

const THREAD: &str = "11111111-1111-1111-1111-111111111111";
const RUN: &str = "22222222-2222-2222-2222-222222222222";

fn sse(events: &[(&str, Value)]) -> String {
    events
        .iter()
        .enumerate()
        .map(|(i, (name, data))| format!("event: {name}\ndata: {data}\nid: {i}\n\n"))
        .collect()
}

/// Events sent `gap` apart, so each lands in its own chunk.
fn slow_sse(count: usize, gap: Duration) -> Body {
    let stream = futures_util::stream::unfold(0usize, move |i| async move {
        if i >= count {
            return None;
        }
        if i > 0 {
            tokio::time::sleep(gap).await;
        }
        let event = if i == 0 {
            format!(
                "event: metadata\ndata: {}\nid: 0\n\n",
                json!({ "run_id": RUN })
            )
        } else {
            format!("event: values\ndata: {}\nid: {i}\n\n", json!({ "n": i }))
        };
        Some((Ok::<_, std::io::Error>(Bytes::from(event)), i + 1))
    });
    Body::from_stream(stream)
}

fn json_response(status: StatusCode, body: Value) -> Response {
    (
        status,
        [("content-type", "application/json")],
        body.to_string(),
    )
        .into_response()
}

fn event_stream(body: Body) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        body,
    )
        .into_response()
}

fn state(checkpoint: &str) -> Value {
    json!({
        "values": { "messages": [], "steps": ["plan"] },
        "next": ["approve"],
        "tasks": [{ "id": "t1", "name": "approve", "error": null,
                    "interrupts": [{ "value": { "question": "Send this answer?" }, "id": "i1" }] }],
        "checkpoint": { "thread_id": THREAD, "checkpoint_ns": "", "checkpoint_id": checkpoint },
        "parent_checkpoint": { "checkpoint_id": "c0" },
        "metadata": { "step": 2, "source": "loop" },
        "created_at": "2026-11-18T00:00:00Z",
    })
}

async fn answer(method: &Method, path: &str, headers: &HeaderMap, body: &Value) -> Response {
    let thread = format!("/threads/{THREAD}");
    match (method.as_str(), path) {
        ("GET", "/info") => {
            if headers.get("x-api-key").is_some_and(|k| k == "wrong") {
                return json_response(
                    StatusCode::UNAUTHORIZED,
                    json!({ "detail": "Invalid API key" }),
                );
            }
            json_response(
                StatusCode::OK,
                json!({ "version": "0.18.2", "flags": { "assistants": true } }),
            )
        }
        ("POST", "/assistants/search") => json_response(
            StatusCode::OK,
            json!([{ "assistant_id": "a1", "graph_id": "agent", "name": "agent", "version": 1,
                     "config": {}, "context": null, "metadata": { "created_by": "system" },
                     "created_at": "2026-11-17T00:00:00Z", "updated_at": "2026-11-17T00:00:00Z" }]),
        ),
        ("GET", "/assistants/a1/graph") => json_response(
            StatusCode::OK,
            json!({
                "nodes": [{ "id": "__start__", "data": { "name": "__start__" } }, { "id": "plan", "data": { "name": "plan" } },
                          { "id": "summarize:remember", "data": { "name": "summarize:remember" } }, { "id": "__end__" }],
                "edges": [{ "source": "__start__", "target": "plan" },
                          { "source": "plan", "target": "summarize:remember", "conditional": true },
                          { "source": "summarize:remember", "target": "__end__" }],
            }),
        ),
        ("GET", "/assistants/a1/schemas") => json_response(
            StatusCode::OK,
            json!({ "graph_id": "agent", "input_schema": { "type": "object" }, "output_schema": {},
                    "state_schema": {}, "config_schema": {} }),
        ),
        ("GET", "/assistants/missing") => json_response(
            StatusCode::NOT_FOUND,
            json!({ "detail": "Assistant not found" }),
        ),
        ("POST", "/threads/search") => json_response(
            StatusCode::OK,
            json!([{ "thread_id": THREAD, "status": "interrupted", "created_at": "c", "updated_at": "u",
                     "metadata": { "lab": "history" }, "values": { "big": true } }]),
        ),
        ("POST", "/threads") => json_response(
            StatusCode::OK,
            json!({ "thread_id": THREAD, "status": "idle", "created_at": "c", "updated_at": "u", "metadata": body["metadata"] }),
        ),
        ("DELETE", p) if p == thread => StatusCode::NO_CONTENT.into_response(),
        ("GET", p) if p == format!("{thread}/state") || p == format!("{thread}/state/c1") => {
            json_response(StatusCode::OK, state("c2"))
        }
        ("POST", p) if p == format!("{thread}/history") => {
            json_response(StatusCode::OK, json!([state("c2"), state("c1")]))
        }
        ("POST", p) if p == format!("{thread}/state") => json_response(
            StatusCode::OK,
            json!({ "checkpoint": { "thread_id": THREAD, "checkpoint_ns": "", "checkpoint_id": "c3" } }),
        ),
        ("POST", p) if p == format!("{thread}/runs/stream") => {
            if body["input"]["slow"] == true {
                return event_stream(slow_sse(12, Duration::from_millis(80)));
            }
            if body["input"]["fail"] == true {
                return event_stream(Body::from(sse(&[
                    ("metadata", json!({ "run_id": RUN })),
                    ("error", json!({ "error": "ValueError", "message": "boom" })),
                ])));
            }
            event_stream(Body::from(sse(&[
                ("metadata", json!({ "run_id": RUN, "attempt": 1 })),
                ("values", json!({ "messages": [] })),
                ("updates", json!({ "plan": { "steps": ["plan"] } })),
                (
                    "messages",
                    json!([{ "content": "Hi", "type": "AIMessageChunk" }, { "langgraph_node": "plan" }]),
                ),
                (
                    "updates",
                    json!({ "__interrupt__": [{ "value": { "question": "Send?" }, "id": "i1" }] }),
                ),
            ])))
        }
        ("POST", "/runs/stream") => {
            event_stream(Body::from(sse(&[("metadata", json!({ "run_id": RUN }))])))
        }
        ("GET", p) if p == format!("{thread}/runs/{RUN}/stream") => {
            let after: usize = headers
                .get("last-event-id")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse::<i64>().ok())
                .map_or(0, |n| (n + 1).max(0) as usize);
            let all = [
                ("values", json!({ "n": 0 })),
                ("values", json!({ "n": 1 })),
                ("values", json!({ "n": 2 })),
            ];
            let text: String = all
                .iter()
                .enumerate()
                .skip(after)
                .map(|(i, (name, data))| format!("event: {name}\ndata: {data}\nid: {i}\n\n"))
                .collect();
            event_stream(Body::from(text))
        }
        ("GET", p) if p == format!("{thread}/runs/{RUN}") => json_response(
            StatusCode::OK,
            json!({ "run_id": RUN, "thread_id": THREAD, "status": "success" }),
        ),
        ("GET", p) if p == format!("{thread}/runs") => json_response(
            StatusCode::OK,
            json!([{ "run_id": RUN, "thread_id": THREAD, "assistant_id": "a1", "status": "success",
                     "created_at": "c", "updated_at": "u", "metadata": {}, "multitask_strategy": "reject" }]),
        ),
        ("POST", p) if p == format!("{thread}/runs/{RUN}/cancel") => {
            StatusCode::NO_CONTENT.into_response()
        }
        ("GET", p) if p.starts_with("/threads/") => json_response(
            StatusCode::NOT_FOUND,
            json!({ "detail": "Thread not found" }),
        ),
        ("POST", "/store/namespaces") => json_response(
            StatusCode::OK,
            json!({ "namespaces": [["lab", "answers"], ["users"]] }),
        ),
        ("POST", "/store/items/search") => json_response(
            StatusCode::OK,
            json!({ "items": [{ "namespace": ["lab", "answers"], "key": "answer-5", "value": { "text": "42" },
                                "created_at": "c", "updated_at": "u", "score": null }] }),
        ),
        ("GET", "/store/items") => json_response(
            StatusCode::OK,
            json!({ "namespace": ["lab", "answers"], "key": "answer-5", "value": { "text": "42" } }),
        ),
        ("PUT" | "DELETE", "/store/items") => StatusCode::NO_CONTENT.into_response(),
        _ => json_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({ "detail": format!("unexpected {method} {path}") }),
        ),
    }
}

async fn start_mock() -> (Mock, SocketAddr) {
    let mock = Mock::default();
    let recorder = mock.clone();
    let app = axum::Router::new().fallback(move |request: Request| {
        let recorder = recorder.clone();
        async move {
            let (parts, body) = request.into_parts();
            let bytes = axum::body::to_bytes(body, 1 << 20).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let path = parts.uri.path().to_owned();
            recorder.seen.lock().unwrap().push(Seen {
                method: parts.method.clone(),
                path: path.clone(),
                query: parts.uri.query().unwrap_or_default().to_owned(),
                headers: parts.headers.clone(),
                body: body.clone(),
            });
            answer(&parts.method, &path, &parts.headers, &body).await
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (mock, addr)
}

/// A server, a stand-in LangGraph server and a tab with `app.events` on call 1.
async fn setup() -> (TestServer, Mock, SocketAddr, Tab) {
    let t = start().await;
    let (mock, addr) = start_mock().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    (t, mock, addr, tab)
}

async fn connect(tab: &mut Tab, id: u32, profile: Value) -> String {
    tab.call(id, "langgraph.connect", json!({ "profile": profile }))
        .await;
    let out = tab.result(id).await;
    assert_eq!(out["info"]["version"], "0.18.2");
    out["connId"].as_str().unwrap().to_owned()
}

fn details(err: &ErrorPayload) -> &Value {
    err.details.as_ref().expect("ToolError details")
}

#[tokio::test]
async fn connect_sends_the_api_key_and_headers_and_maps_auth_and_reach_errors() {
    let (_t, mock, addr, mut tab) = setup().await;
    let url = format!("http://{addr}/");
    // Without an API key: no x-api-key header.
    connect(&mut tab, 2, json!({ "name": "lab", "url": url })).await;
    assert!(mock.last("/info").headers.get("x-api-key").is_none());
    // With one, and an extra header.
    connect(
        &mut tab,
        3,
        json!({ "name": "lab", "url": url, "apiKey": "k-123",
                "headers": [{ "name": "X-Tenant", "value": "blue" }] }),
    )
    .await;
    let seen = mock.last("/info");
    assert_eq!(seen.headers["x-api-key"], "k-123");
    assert_eq!(seen.headers["x-tenant"], "blue");

    // A rejected key is Auth; the key is not in the message.
    tab.call(
        4,
        "langgraph.connect",
        json!({ "profile": { "name": "lab", "url": url, "apiKey": "wrong" } }),
    )
    .await;
    let err = tab.error(4, Code::Unauthenticated).await;
    assert_eq!(details(&err)["kind"], "Auth");
    assert_eq!(details(&err)["remote"]["code"], "401");
    assert!(!err.message.contains("wrong"));

    // Nobody listening: Connect, retryable, naming the address.
    let closed = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap();
    tab.call(
        5,
        "langgraph.connect",
        json!({ "profile": { "name": "x", "url": format!("http://{closed}") } }),
    )
    .await;
    let err = tab.error(5, Code::Unavailable).await;
    assert_eq!(details(&err)["kind"], "Connect");
    assert_eq!(details(&err)["retryable"], true);
    assert!(err.message.contains(&closed.to_string()), "{}", err.message);

    // A bad URL names its field.
    tab.call(
        6,
        "langgraph.connect",
        json!({ "profile": { "name": "x", "url": "ftp://x" } }),
    )
    .await;
    let err = tab.error(6, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "url");
}

#[tokio::test]
async fn assistants_graph_and_schemas() {
    let (_t, mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;

    tab.call(
        3,
        "langgraph.assistants.search",
        json!({ "connId": conn, "graphId": "agent" }),
    )
    .await;
    let out = tab.result(3).await;
    assert_eq!(out[0]["assistantId"], "a1");
    assert_eq!(out[0]["graphId"], "agent");
    assert_eq!(out[0]["context"], json!({}));
    let body = mock.last("/assistants/search").body;
    assert_eq!(
        body,
        json!({ "graph_id": "agent", "limit": 100, "offset": 0 })
    );

    tab.call(
        4,
        "langgraph.assistants.graph",
        json!({ "connId": conn, "assistantId": "a1", "xray": true }),
    )
    .await;
    let graph = tab.result(4).await;
    assert_eq!(mock.last("/assistants/a1/graph").query, "xray=true");
    assert_eq!(graph["nodes"][0]["kind"], "start");
    assert_eq!(graph["nodes"][2]["id"], "summarize:remember");
    assert_eq!(graph["nodes"][3]["kind"], "end");
    assert_eq!(graph["edges"][1]["conditional"], true);
    tab.call(
        5,
        "langgraph.assistants.graph",
        json!({ "connId": conn, "assistantId": "a1", "xray": 2 }),
    )
    .await;
    tab.result(5).await;
    assert_eq!(mock.last("/assistants/a1/graph").query, "xray=2");

    tab.call(
        6,
        "langgraph.assistants.schemas",
        json!({ "connId": conn, "assistantId": "a1" }),
    )
    .await;
    let schemas = tab.result(6).await;
    assert_eq!(schemas["inputSchema"], json!({ "type": "object" }));
    assert!(schemas.get("contextSchema").is_none());

    tab.call(
        7,
        "langgraph.assistants.get",
        json!({ "connId": conn, "assistantId": "missing" }),
    )
    .await;
    let err = tab.error(7, Code::NotFound).await;
    assert_eq!(details(&err)["resource"], "assistant");
    assert_eq!(err.message, "Assistant not found");

    // Ids go into URL paths, so only id characters are accepted.
    tab.call(
        8,
        "langgraph.assistants.get",
        json!({ "connId": conn, "assistantId": "../info" }),
    )
    .await;
    let err = tab.error(8, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "assistantId");
}

#[tokio::test]
async fn threads_state_history_and_fork() {
    let (_t, mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;
    let thread = format!("/threads/{THREAD}");

    tab.call(
        3,
        "langgraph.threads.search",
        json!({ "connId": conn, "status": "interrupted" }),
    )
    .await;
    let threads = tab.result(3).await;
    assert_eq!(threads[0]["threadId"], THREAD);
    assert_eq!(threads[0]["status"], "interrupted");
    assert!(threads[0].get("values").is_none(), "lists stay light");
    assert_eq!(
        mock.last("/threads/search").body,
        json!({ "limit": 50, "offset": 0, "status": "interrupted", "sort_by": "updated_at", "sort_order": "desc" })
    );
    tab.call(
        4,
        "langgraph.threads.search",
        json!({ "connId": conn, "status": "sleeping" }),
    )
    .await;
    tab.error(4, Code::InvalidArgument).await;

    tab.call(
        5,
        "langgraph.threads.create",
        json!({ "connId": conn, "metadata": { "by": "mc" } }),
    )
    .await;
    assert_eq!(tab.result(5).await["metadata"], json!({ "by": "mc" }));

    tab.call(
        6,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": THREAD, "subgraphs": true }),
    )
    .await;
    let st = tab.result(6).await;
    assert_eq!(
        mock.last(&format!("{thread}/state")).query,
        "subgraphs=true"
    );
    assert_eq!(st["checkpointId"], "c2");
    assert_eq!(st["parentCheckpointId"], "c0");
    assert_eq!(st["next"], json!(["approve"]));
    assert_eq!(
        st["interrupts"][0]["value"]["question"],
        "Send this answer?"
    );

    tab.call(
        7,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": THREAD, "checkpointId": "c1" }),
    )
    .await;
    tab.result(7).await;
    assert_eq!(mock.requests(&format!("{thread}/state/c1")).len(), 1);

    tab.call(
        8,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": THREAD, "limit": 10, "before": "c3" }),
    )
    .await;
    let history = tab.result(8).await;
    assert_eq!(history.as_array().unwrap().len(), 2);
    assert_eq!(
        mock.last(&format!("{thread}/history")).body,
        json!({ "limit": 10, "before": { "configurable": { "checkpoint_id": "c3" } } })
    );

    // Fork: update the state at a checkpoint.
    tab.call(
        9,
        "langgraph.threads.updateState",
        json!({ "connId": conn, "threadId": THREAD, "values": { "approved": true }, "asNode": "approve", "checkpointId": "c1" }),
    )
    .await;
    assert_eq!(tab.result(9).await["checkpointId"], "c3");
    let body = mock.last(&format!("{thread}/state")).body;
    assert_eq!(body["values"], json!({ "approved": true }));
    assert_eq!(body["as_node"], "approve");
    assert_eq!(body["checkpoint"]["checkpoint_id"], "c1");

    tab.call(
        10,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": THREAD }),
    )
    .await;
    tab.result(10).await;
    assert_eq!(mock.last(&thread).method, Method::DELETE);

    tab.call(
        11,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": "33333333-3333-3333-3333-333333333333" }),
    )
    .await;
    let err = tab.error(11, Code::NotFound).await;
    assert_eq!(details(&err)["resource"], "thread");
}

/// The `jsonl` lines of every chunk of call `id` until its end, and the summary.
async fn run_lines(tab: &mut Tab, id: u32) -> (Vec<Value>, Value) {
    let mut lines = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                assert_eq!(frame.payload.last(), Some(&b'\n'), "whole lines only");
                for line in frame
                    .payload
                    .split(|b| *b == b'\n')
                    .filter(|l| !l.is_empty())
                {
                    lines.push(serde_json::from_slice(line).unwrap());
                }
                tab.client.credit(id, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                return (lines, serde_json::from_slice(&frame.payload).unwrap());
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test]
async fn a_run_streams_its_events_as_json_lines() {
    let (_t, mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;
    tab.call(
        3,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent",
                "input": { "messages": [{ "type": "human", "content": "hi" }] },
                "streamMode": ["values", "updates", "messages-tuple"], "streamSubgraphs": true,
                "interruptBefore": ["*"], "multitaskStrategy": "reject", "streamId": "run-1" }),
    )
    .await;
    let (lines, summary) = run_lines(&mut tab, 3).await;
    let names: Vec<&str> = lines.iter().map(|l| l["event"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        ["metadata", "values", "updates", "messages", "updates"]
    );
    assert_eq!(lines[3]["data"][0]["content"], "Hi");
    assert_eq!(lines[4]["id"], "4");
    assert_eq!(summary["runId"], RUN);
    assert_eq!(summary["status"], "success");
    assert_eq!(summary["events"], 5);
    assert_eq!(summary["lastEventId"], "4");

    let body = mock.last(&format!("/threads/{THREAD}/runs/stream")).body;
    assert_eq!(body["assistant_id"], "agent");
    assert_eq!(
        body["stream_mode"],
        json!(["values", "updates", "messages-tuple"])
    );
    assert_eq!(body["stream_subgraphs"], true);
    assert_eq!(
        body["stream_resumable"], true,
        "a thread's run can be joined"
    );
    assert_eq!(
        body["on_disconnect"], "continue",
        "closing the stream leaves the run"
    );
    assert_eq!(body["interrupt_before"], "*");
    assert_eq!(body["multitask_strategy"], "reject");

    // Progress was reported for the stream id.
    let done = tab
        .event(1, |e| {
            e["kind"] == "StreamProgress" && e["streamId"] == "run-1" && e["done"] == true
        })
        .await;
    assert_eq!(done["matched"], 5);

    // An `error` event ends the run as an error, not the call.
    tab.call(
        4,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent", "input": { "fail": true },
                "streamMode": ["values"], "streamId": "run-2" }),
    )
    .await;
    let (lines, summary) = run_lines(&mut tab, 4).await;
    assert_eq!(lines[1]["event"], "error");
    assert_eq!(lines[1]["data"]["message"], "boom");
    assert_eq!(summary["status"], "error");

    // Resume an interrupt with a command; a run without a thread is cancelled with its stream.
    tab.call(
        5,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": null, "assistantId": "agent",
                "command": { "resume": "approved" }, "checkpointId": "c1",
                "streamMode": ["values"], "streamId": "run-3" }),
    )
    .await;
    run_lines(&mut tab, 5).await;
    let body = mock.last("/runs/stream").body;
    assert_eq!(body["command"], json!({ "resume": "approved" }));
    assert_eq!(body["checkpoint"], json!({ "checkpoint_id": "c1" }));
    assert_eq!(body["on_disconnect"], "cancel");
    assert!(body.get("stream_resumable").is_none());

    // Bad stream modes are refused before any request.
    tab.call(
        6,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent", "streamMode": ["everything"], "streamId": "run-4" }),
    )
    .await;
    let err = tab.error(6, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "streamMode");
}

#[tokio::test]
async fn a_run_stream_follows_the_credits_and_joins_from_the_last_event() {
    let (_t, mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;
    tab.call(
        3,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent", "input": { "slow": true },
                "streamMode": ["values"], "streamId": "slow" }),
    )
    .await;
    // Events 80 ms apart land in separate chunks; the initial window is 4.
    for _ in 0..4 {
        tab.chunk(3).await;
    }
    assert!(
        tab.quiet(3, Duration::from_millis(400)).await,
        "no credit, no chunk"
    );
    tab.client.credit(3, 1).await;
    tab.chunk(3).await;
    // Stop: the stream ends; the run itself is the server's (cancel is a separate call).
    tab.client.cancel(3).await;
    tab.error(3, Code::Cancelled).await;

    // Join after a reconnect, from the last event seen.
    tab.call(
        4,
        "langgraph.runs.join",
        json!({ "connId": conn, "threadId": THREAD, "runId": RUN, "lastEventId": "0", "streamId": "join-1" }),
    )
    .await;
    let (lines, summary) = run_lines(&mut tab, 4).await;
    let seen = mock.last(&format!("/threads/{THREAD}/runs/{RUN}/stream"));
    assert_eq!(seen.headers["last-event-id"], "0");
    assert_eq!(
        lines
            .iter()
            .map(|l| l["data"]["n"].as_i64().unwrap())
            .collect::<Vec<_>>(),
        [1, 2]
    );
    assert_eq!(summary["runId"], RUN);
    assert_eq!(summary["lastEventId"], "2");

    tab.call(
        5,
        "langgraph.runs.list",
        json!({ "connId": conn, "threadId": THREAD }),
    )
    .await;
    let runs = tab.result(5).await;
    assert_eq!(runs[0]["multitaskStrategy"], "reject");
    assert_eq!(
        mock.last(&format!("/threads/{THREAD}/runs")).query,
        "limit=20"
    );

    let cancel = format!("/threads/{THREAD}/runs/{RUN}/cancel");
    tab.call(
        6,
        "langgraph.runs.cancel",
        json!({ "connId": conn, "threadId": THREAD, "runId": RUN }),
    )
    .await;
    tab.result(6).await;
    assert_eq!(mock.last(&cancel).query, "action=interrupt&wait=true");
    tab.call(
        7,
        "langgraph.runs.rollback",
        json!({ "connId": conn, "threadId": THREAD, "runId": RUN }),
    )
    .await;
    tab.result(7).await;
    assert_eq!(mock.last(&cancel).query, "action=rollback&wait=true");
}

#[tokio::test]
async fn disconnecting_ends_a_run_stream() {
    let (_t, _mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;
    tab.call(
        3,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": THREAD, "assistantId": "agent", "input": { "slow": true },
                "streamMode": ["values"], "streamId": "slow" }),
    )
    .await;
    tab.chunk(3).await;
    tab.call(4, "langgraph.disconnect", json!({ "connId": conn }))
        .await;
    tab.result(4).await;
    tab.error(3, Code::Cancelled).await;
    tab.call(
        5,
        "langgraph.threads.get",
        json!({ "connId": conn, "threadId": THREAD }),
    )
    .await;
    let err = tab.error(5, Code::NotFound).await;
    assert_eq!(details(&err)["resource"], "connection");
}

#[tokio::test]
async fn the_store_lists_searches_puts_and_deletes() {
    let (_t, mock, addr, mut tab) = setup().await;
    let conn = connect(
        &mut tab,
        2,
        json!({ "name": "lab", "url": format!("http://{addr}") }),
    )
    .await;

    tab.call(
        3,
        "langgraph.store.namespaces",
        json!({ "connId": conn, "maxDepth": 2 }),
    )
    .await;
    assert_eq!(tab.result(3).await, json!([["lab", "answers"], ["users"]]));
    assert_eq!(
        mock.last("/store/namespaces").body,
        json!({ "limit": 1000, "max_depth": 2 })
    );

    tab.call(
        4,
        "langgraph.store.search",
        json!({ "connId": conn, "namespacePrefix": ["lab"], "query": "answer", "filter": { "approved": true } }),
    )
    .await;
    let found = tab.result(4).await;
    assert_eq!(found[0]["key"], "answer-5");
    assert!(found[0].get("score").is_none());
    assert_eq!(
        mock.last("/store/items/search").body,
        json!({ "namespace_prefix": ["lab"], "query": "answer", "filter": { "approved": true }, "limit": 50, "offset": 0 })
    );

    tab.call(
        5,
        "langgraph.store.get",
        json!({ "connId": conn, "namespace": ["lab", "answers"], "key": "answer-5" }),
    )
    .await;
    assert_eq!(tab.result(5).await["value"]["text"], "42");
    assert_eq!(
        mock.last("/store/items").query,
        "namespace=lab.answers&key=answer-5"
    );

    tab.call(
        6,
        "langgraph.store.put",
        json!({ "connId": conn, "namespace": ["lab", "notes"], "key": "n1", "value": { "text": "hi" } }),
    )
    .await;
    tab.result(6).await;
    let put = mock.last("/store/items");
    assert_eq!(put.method, Method::PUT);
    assert_eq!(
        put.body,
        json!({ "namespace": ["lab", "notes"], "key": "n1", "value": { "text": "hi" } })
    );

    tab.call(
        7,
        "langgraph.store.put",
        json!({ "connId": conn, "namespace": ["lab"], "key": "n1", "value": 5 }),
    )
    .await;
    assert_eq!(
        details(&tab.error(7, Code::InvalidArgument).await)["field"],
        "value"
    );
    tab.call(
        8,
        "langgraph.store.put",
        json!({ "connId": conn, "namespace": ["a.b"], "key": "n1", "value": {} }),
    )
    .await;
    assert_eq!(
        details(&tab.error(8, Code::InvalidArgument).await)["field"],
        "namespace"
    );

    tab.call(
        9,
        "langgraph.store.delete",
        json!({ "connId": conn, "namespace": ["lab", "notes"], "key": "n1" }),
    )
    .await;
    tab.result(9).await;
    let del = mock.last("/store/items");
    assert_eq!(del.method, Method::DELETE);
    assert_eq!(
        del.body,
        json!({ "namespace": ["lab", "notes"], "key": "n1" })
    );
}

/// A one-answer HTTPS server with a certificate for `name`, signed by the returned CA.
async fn https_info(name: &str) -> (SocketAddr, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf = rcgen::CertificateParams::new(vec![name.to_owned()])
        .unwrap()
        .signed_by(&leaf_key, &issuer)
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![leaf.der().clone()],
            rustls::pki_types::PrivateKeyDer::try_from(leaf_key.serialize_der()).unwrap(),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                let Ok(mut tls) = acceptor.accept(tcp).await else {
                    return;
                };
                let mut buf = vec![0u8; 4096];
                let mut got = Vec::new();
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    match tls.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&buf[..n]),
                    }
                }
                let body = json!({ "version": "0.18.2", "flags": {} }).to_string();
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = tls.write_all(response.as_bytes()).await;
                let _ = tls.shutdown().await;
            });
        }
    });
    (addr, ca.pem())
}

#[tokio::test]
async fn https_verifies_against_the_pinned_ca_and_the_expected_name() {
    let (_t, _mock, _addr, mut tab) = setup().await;
    let (addr, ca) = https_info("langgraph.lab").await;
    let url = format!("https://127.0.0.1:{}", addr.port());
    // The system store does not know the lab CA.
    tab.call(
        2,
        "langgraph.connect",
        json!({ "profile": { "name": "tls", "url": url } }),
    )
    .await;
    let err = tab.error(2, Code::Unavailable).await;
    assert_eq!(details(&err)["kind"], "Tls", "{}", err.message);
    // The pinned CA, but the certificate names langgraph.lab, not 127.0.0.1.
    tab.call(
        3,
        "langgraph.connect",
        json!({ "profile": { "name": "tls", "url": url, "tls": { "caPem": ca } } }),
    )
    .await;
    let err = tab.error(3, Code::Unavailable).await;
    assert_eq!(details(&err)["kind"], "Tls", "{}", err.message);
    // With the expected name it connects.
    connect(
        &mut tab,
        4,
        json!({ "name": "tls", "url": url, "tls": { "caPem": ca, "serverName": "langgraph.lab" } }),
    )
    .await;
}
