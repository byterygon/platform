//! The `langgraph` tool against the test lab's LangGraph server (`langgraph dev` with the sample
//! graph `agent`, Mightyconsole spec §14 and §18, TSK-84). Needs
//! `pnpm --filter @byterygon/mightyconsole lab up langgraph`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test langgraph_lab`. The address is
//! `http://127.0.0.1:2024` unless `MIGHTYCONSOLE_LAB_LANGGRAPH` says otherwise.
#![cfg(feature = "lab-tests")]

mod support;

use ambidex::{Code, Kind};
use serde_json::{Value, json};
use support::*;

fn url() -> String {
    std::env::var("MIGHTYCONSOLE_LAB_LANGGRAPH").unwrap_or_else(|_| "http://127.0.0.1:2024".into())
}

/// A `POST` straight to the lab server (HTTP/1.0, so the answer is not chunked), for what the
/// tool does not do itself.
async fn post_json(path: &str, body: &Value) -> Value {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let base = url::Url::parse(&url()).unwrap();
    let host = format!(
        "{}:{}",
        base.host_str().unwrap(),
        base.port_or_known_default().unwrap()
    );
    let mut tcp = tokio::net::TcpStream::connect(&host).await.unwrap();
    let body = body.to_string();
    let request = format!(
        "POST {path} HTTP/1.0\r\nHost: {host}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    tcp.write_all(request.as_bytes()).await.unwrap();
    let mut raw = Vec::new();
    tcp.read_to_end(&mut raw).await.unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    serde_json::from_slice(&raw[split + 4..]).unwrap()
}

async fn setup() -> (TestServer, Tab, String) {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let conn = connect(&mut tab, 2, json!({ "name": "lab", "url": url() })).await;
    (t, tab, conn)
}

async fn connect(tab: &mut Tab, id: u32, profile: Value) -> String {
    tab.call(id, "langgraph.connect", json!({ "profile": profile }))
        .await;
    let out = tab.result(id).await;
    out["connId"].as_str().unwrap().to_owned()
}

async fn call(tab: &mut Tab, id: u32, procedure: &str, input: Value) -> Value {
    tab.call(id, procedure, input).await;
    tab.result(id).await
}

/// Every `jsonl` line of stream `id`, granting a credit per chunk, and its summary.
async fn lines(tab: &mut Tab, id: u32) -> (Vec<Value>, Value) {
    let mut out = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => {
                for line in frame
                    .payload
                    .split(|b| *b == b'\n')
                    .filter(|l| !l.is_empty())
                {
                    out.push(serde_json::from_slice(line).unwrap());
                }
                tab.client.credit(id, 1).await;
            }
            Kind::StreamEnd => return (out, serde_json::from_slice(&frame.payload).unwrap()),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

fn events(lines: &[Value]) -> Vec<&str> {
    lines.iter().map(|l| l["event"].as_str().unwrap()).collect()
}

async fn new_thread(tab: &mut Tab, id: u32, conn: &str) -> String {
    let thread = call(
        tab,
        id,
        "langgraph.threads.create",
        json!({ "connId": conn, "metadata": { "test": "mightyconsole" } }),
    )
    .await;
    thread["threadId"].as_str().unwrap().to_owned()
}

/// Runs "What is 6 times 7?" on `thread` until the approval interrupt.
async fn run_to_interrupt(tab: &mut Tab, id: u32, conn: &str, thread: &str) -> (Vec<Value>, Value) {
    tab.call(
        id,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": thread, "assistantId": "agent",
                "input": { "messages": [{ "type": "human", "content": "What is 6 times 7?" }] },
                "streamMode": ["values", "updates", "messages-tuple", "tasks"], "streamSubgraphs": true,
                "streamId": format!("run-{id}") }),
    )
    .await;
    lines(tab, id).await
}

#[tokio::test]
async fn lab_connect_assistants_and_the_xray_graph() {
    let (_t, mut tab, conn) = setup().await;
    // `langgraph dev` takes any API key; the header is sent all the same (see tests/langgraph.rs).
    connect(
        &mut tab,
        3,
        json!({ "name": "lab-key", "url": url(), "apiKey": "lab-key" }),
    )
    .await;

    let assistants = call(
        &mut tab,
        4,
        "langgraph.assistants.search",
        json!({ "connId": conn, "graphId": "agent" }),
    )
    .await;
    let mut names: Vec<&str> = assistants
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["agent", "agent-strict"]);
    let id = assistants[0]["assistantId"].as_str().unwrap().to_owned();

    let flat = call(
        &mut tab,
        5,
        "langgraph.assistants.graph",
        json!({ "connId": conn, "assistantId": id }),
    )
    .await;
    let ids = |g: &Value| -> Vec<String> {
        g["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap().to_owned())
            .collect()
    };
    assert!(ids(&flat).contains(&"summarize".to_owned()), "{flat}");
    let xray = call(
        &mut tab,
        6,
        "langgraph.assistants.graph",
        json!({ "connId": conn, "assistantId": id, "xray": true }),
    )
    .await;
    assert!(
        ids(&xray).contains(&"summarize:remember".to_owned()),
        "{xray}"
    );
    assert!(
        xray["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["conditional"] == true)
    );

    let schemas = call(
        &mut tab,
        7,
        "langgraph.assistants.schemas",
        json!({ "connId": conn, "assistantId": id }),
    )
    .await;
    assert_eq!(schemas["graphId"], "agent");
    assert!(schemas["stateSchema"]["properties"]["messages"].is_object());
}

#[tokio::test]
async fn lab_threads_search_create_delete_state_and_history() {
    let (_t, mut tab, conn) = setup().await;
    let seeded = call(
        &mut tab,
        3,
        "langgraph.threads.search",
        json!({ "connId": conn, "metadata": { "lab": "history" } }),
    )
    .await;
    let seeded = seeded[0]["threadId"]
        .as_str()
        .expect("the seeded thread")
        .to_owned();
    let history = call(
        &mut tab,
        4,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": seeded }),
    )
    .await;
    assert!(history["items"].as_array().unwrap().len() >= 5, "{history}");
    let state = call(
        &mut tab,
        5,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": seeded }),
    )
    .await;
    assert_eq!(state["values"]["approved"], true);
    assert_eq!(state["checkpointId"], history["items"][0]["checkpointId"]);

    let thread = new_thread(&mut tab, 6, &conn).await;
    let found = call(
        &mut tab,
        7,
        "langgraph.threads.search",
        json!({ "connId": conn, "metadata": { "test": "mightyconsole" } }),
    )
    .await;
    assert!(
        found
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["threadId"] == thread.as_str())
    );
    call(
        &mut tab,
        8,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    tab.call(
        9,
        "langgraph.threads.get",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    tab.error(9, Code::NotFound).await;
}

#[tokio::test]
async fn lab_a_run_streams_stops_at_the_interrupt_and_resumes() {
    let (_t, mut tab, conn) = setup().await;
    let thread = new_thread(&mut tab, 3, &conn).await;
    let (run, summary) = run_to_interrupt(&mut tab, 4, &conn, &thread).await;
    let names = events(&run);
    for expected in ["metadata", "values", "updates", "messages", "tasks"] {
        assert!(names.contains(&expected), "{expected} in {names:?}");
    }
    // The nodes ran in order (what the GraphView highlights), then the interrupt.
    let updated: Vec<&str> = run
        .iter()
        .filter(|l| l["event"] == "updates")
        .flat_map(|l| l["data"].as_object().unwrap().keys().map(String::as_str))
        .collect();
    assert_eq!(updated, ["plan", "tools", "plan", "__interrupt__"]);
    assert!(summary["runId"].is_string());
    let state = call(
        &mut tab,
        5,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    assert_eq!(state["next"], json!(["approve"]));
    assert_eq!(
        state["interrupts"][0]["value"]["question"],
        "Send this answer?"
    );
    let threads = call(
        &mut tab,
        6,
        "langgraph.threads.get",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    assert_eq!(threads["status"], "interrupted");

    // Resume with a value.
    tab.call(
        7,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": thread, "assistantId": "agent", "command": { "resume": "approved" },
                "streamMode": ["values", "updates"], "streamSubgraphs": true, "streamId": "resume" }),
    )
    .await;
    let (_, summary) = lines(&mut tab, 7).await;
    assert_eq!(summary["status"], "success");
    let state = call(
        &mut tab,
        8,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    assert_eq!(state["values"]["approved"], true);
    assert_eq!(state["next"], json!([]));
    let messages = state["values"]["messages"].as_array().unwrap();
    assert_eq!(
        messages.last().unwrap()["content"],
        "Final: Here is what I found: 42"
    );
    call(
        &mut tab,
        9,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
}

#[tokio::test]
async fn lab_stop_and_rollback_a_run() {
    let (_t, mut tab, conn) = setup().await;
    // A run that waits before starting (`after_seconds`) stays pending long enough to stop.
    let pending = |thread: String| async move {
        let body =
            json!({ "assistant_id": "agent", "input": { "messages": [] }, "after_seconds": 60 });
        let run = post_json(&format!("/threads/{thread}/runs"), &body).await;
        run["run_id"].as_str().unwrap().to_owned()
    };
    let thread = new_thread(&mut tab, 3, &conn).await;
    let run = pending(thread.clone()).await;
    call(
        &mut tab,
        4,
        "langgraph.runs.cancel",
        json!({ "connId": conn, "threadId": thread, "runId": run }),
    )
    .await;
    let runs = call(
        &mut tab,
        5,
        "langgraph.runs.list",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    let status = runs["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["runId"] == run.as_str())
        .unwrap()["status"]
        .clone();
    assert_eq!(status, "interrupted");

    let run = pending(thread.clone()).await;
    call(
        &mut tab,
        6,
        "langgraph.runs.rollback",
        json!({ "connId": conn, "threadId": thread, "runId": run }),
    )
    .await;
    let runs = call(
        &mut tab,
        7,
        "langgraph.runs.list",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    // A pending run is stopped at once; `langgraph dev` deletes it when its worker would have
    // picked it up, so it may still be listed, but no longer pending.
    let left = runs["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["runId"] == run.as_str());
    assert!(
        left.is_none_or(|r| r["status"] == "interrupted"),
        "{left:?}"
    );

    // A run that is over cannot be stopped.
    tab.call(
        8,
        "langgraph.runs.cancel",
        json!({ "connId": conn, "threadId": thread, "runId": run }),
    )
    .await;
    tab.error(8, Code::NotFound).await;
    call(
        &mut tab,
        9,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
}

#[tokio::test]
async fn lab_fork_and_time_travel_make_new_checkpoints() {
    let (_t, mut tab, conn) = setup().await;
    let thread = new_thread(&mut tab, 3, &conn).await;
    run_to_interrupt(&mut tab, 4, &conn, &thread).await;
    let before = call(
        &mut tab,
        5,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    let before = before["items"].as_array().unwrap().clone();
    // The checkpoint where the tool node is next (step 1).
    let at_tools = before
        .iter()
        .find(|s| s["next"] == json!(["tools"]))
        .expect("a checkpoint before tools");
    let at_tools_id = at_tools["checkpointId"].as_str().unwrap().to_owned();

    // Fork: change the state at that checkpoint.
    let fork = call(
        &mut tab,
        6,
        "langgraph.threads.updateState",
        json!({ "connId": conn, "threadId": thread, "values": { "steps": ["forked"] }, "checkpointId": at_tools_id }),
    )
    .await;
    let forked = fork["checkpointId"].as_str().unwrap().to_owned();
    let state = call(
        &mut tab,
        7,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread, "checkpointId": forked }),
    )
    .await;
    assert_eq!(state["parentCheckpointId"], at_tools_id.as_str());
    assert!(
        state["values"]["steps"]
            .as_array()
            .unwrap()
            .contains(&json!("forked"))
    );

    // Time travel: run again from the original checkpoint.
    tab.call(
        8,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": thread, "assistantId": "agent", "checkpointId": at_tools_id,
                "streamMode": ["updates"], "streamId": "replay" }),
    )
    .await;
    let (replay, _) = lines(&mut tab, 8).await;
    assert!(
        replay.iter().any(|l| l["data"].get("tools").is_some()),
        "the run continued from the tool node"
    );
    let after = call(
        &mut tab,
        9,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": thread, "limit": 100 }),
    )
    .await;
    let after = after["items"].as_array().unwrap();
    assert!(
        after.len() > before.len() + 1,
        "{} then {}",
        before.len(),
        after.len()
    );
    assert!(after.iter().any(|s| s["checkpointId"] == forked.as_str()));
    call(
        &mut tab,
        10,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
}

#[tokio::test]
async fn lab_a_run_s_request_and_its_own_checkpoints() {
    // TSK-96: the Runs tab's "Run again with the same input" and a run's error read the run's
    // request from `runs.get` and its checkpoints from History filtered by `run_id`.
    let (_t, mut tab, conn) = setup().await;
    let thread = new_thread(&mut tab, 3, &conn).await;
    run_to_interrupt(&mut tab, 4, &conn, &thread).await;
    let runs = call(
        &mut tab,
        5,
        "langgraph.runs.list",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    let run = runs["items"][0]["runId"].as_str().unwrap().to_owned();
    assert!(runs["items"][0].get("request").is_none());
    let got = call(
        &mut tab,
        6,
        "langgraph.runs.get",
        json!({ "connId": conn, "threadId": thread, "runId": run }),
    )
    .await;
    assert_eq!(
        got["request"]["input"]["messages"][0]["content"],
        "What is 6 times 7?"
    );
    assert!(
        got["request"]["streamMode"]
            .as_array()
            .unwrap()
            .contains(&json!("values"))
    );
    let steps = call(
        &mut tab,
        7,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": thread, "metadata": { "run_id": run } }),
    )
    .await;
    let steps = steps["items"].as_array().unwrap();
    assert!(!steps.is_empty(), "the run wrote checkpoints");
    assert!(
        steps
            .iter()
            .all(|s| s["metadata"]["run_id"] == run.as_str())
    );
}

#[tokio::test]
async fn lab_an_assistant_s_versions_and_node_statistics() {
    // TSK-96: Versions, and node statistics over the latest runs, read from their checkpoints.
    let (_t, mut tab, conn) = setup().await;
    let found = call(
        &mut tab,
        3,
        "langgraph.assistants.search",
        json!({ "connId": conn, "graphId": "agent" }),
    )
    .await;
    let assistant = found[0]["assistantId"].as_str().unwrap().to_owned();
    let thread = new_thread(&mut tab, 4, &conn).await;
    run_to_interrupt(&mut tab, 5, &conn, &thread).await;
    let versions = call(
        &mut tab,
        6,
        "langgraph.assistants.versions",
        json!({ "connId": conn, "assistantId": assistant }),
    )
    .await;
    assert!(versions["items"][0]["version"].as_i64().unwrap() >= 1);
    let stats = call(
        &mut tab,
        7,
        "langgraph.assistants.nodeStats",
        json!({ "connId": conn, "assistantId": assistant, "runs": 5 }),
    )
    .await;
    assert!(stats["runs"].as_u64().unwrap() >= 1, "{stats}");
    let nodes = stats["nodes"].as_array().unwrap();
    assert!(
        nodes.iter().any(|n| n["visits"].as_u64().unwrap() >= 1),
        "{stats}"
    );
    assert!(
        nodes
            .iter()
            .all(|n| !n["node"].as_str().unwrap().starts_with("__"))
    );
}

#[tokio::test]
async fn lab_a_run_is_joined_after_a_reconnect() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = connect(&mut tab, 2, json!({ "name": "lab", "url": url() })).await;
    let thread = new_thread(&mut tab, 3, &conn).await;
    tab.call(
        4,
        "langgraph.runs.stream",
        json!({ "connId": conn, "threadId": thread, "assistantId": "agent",
                "input": { "messages": [{ "type": "human", "content": "What is 2 times 3?" }] },
                "streamMode": ["values", "updates"], "streamId": "first" }),
    )
    .await;
    // Read the first chunk (its first line is the run id), then lose the WebSocket.
    let first = tab.chunk(4).await;
    let first: Vec<Value> = first
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect();
    let run = first[0]["data"]["run_id"].as_str().unwrap().to_owned();
    // As if only the first event (the run id) had arrived before the connection broke.
    let last = first[0]["id"].as_str().unwrap().to_owned();
    tab.disconnect().await;

    // A new connection joins the run from the last event it saw.
    let mut tab = t.tab(&browser).await;
    let conn = connect(&mut tab, 2, json!({ "name": "lab", "url": url() })).await;
    tab.call(
        3,
        "langgraph.runs.join",
        json!({ "connId": conn, "threadId": thread, "runId": run, "lastEventId": last, "streamId": "join" }),
    )
    .await;
    let (rest, summary) = lines(&mut tab, 3).await;
    assert!(!rest.is_empty(), "the events after the last one seen");
    assert!(
        rest.iter().all(|l| l["id"] != last.as_str()),
        "nothing seen twice"
    );
    assert!(
        rest.iter()
            .any(|l| l["data"].get("__interrupt__").is_some()),
        "{rest:?}"
    );
    assert_eq!(summary["runId"], run.as_str());
    call(
        &mut tab,
        4,
        "langgraph.threads.delete",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
}

#[tokio::test]
async fn lab_the_store_lists_searches_puts_and_deletes() {
    let (_t, mut tab, conn) = setup().await;
    let label = format!("mc-{}", std::process::id());
    let ns = json!(["mightyconsole", label]);
    call(&mut tab, 3, "langgraph.store.put", json!({ "connId": conn, "namespace": ns, "key": "k1", "value": { "text": "hello", "n": 1 } })).await;
    call(
        &mut tab,
        4,
        "langgraph.store.put",
        json!({ "connId": conn, "namespace": ns, "key": "k2", "value": { "text": "bye", "n": 2 } }),
    )
    .await;

    let spaces = call(
        &mut tab,
        5,
        "langgraph.store.namespaces",
        json!({ "connId": conn, "prefix": ["mightyconsole"] }),
    )
    .await;
    assert!(spaces.as_array().unwrap().contains(&ns), "{spaces}");
    let all = call(
        &mut tab,
        6,
        "langgraph.store.search",
        json!({ "connId": conn, "namespacePrefix": ns }),
    )
    .await;
    assert_eq!(all.as_array().unwrap().len(), 2);
    let filtered = call(
        &mut tab,
        7,
        "langgraph.store.search",
        json!({ "connId": conn, "namespacePrefix": ns, "filter": { "n": 2 } }),
    )
    .await;
    assert_eq!(filtered[0]["key"], "k2");
    let item = call(
        &mut tab,
        8,
        "langgraph.store.get",
        json!({ "connId": conn, "namespace": ns, "key": "k1" }),
    )
    .await;
    assert_eq!(item["value"]["text"], "hello");

    for (id, key) in [(9, "k1"), (10, "k2")] {
        call(
            &mut tab,
            id,
            "langgraph.store.delete",
            json!({ "connId": conn, "namespace": ns, "key": key }),
        )
        .await;
    }
    tab.call(
        11,
        "langgraph.store.get",
        json!({ "connId": conn, "namespace": ns, "key": "k1" }),
    )
    .await;
    tab.error(11, Code::NotFound).await;
}

/// The id of the thread the lab seeded with `metadata.lab == kind` (`lab seed langgraph`).
async fn seeded(tab: &mut Tab, id: u32, conn: &str, kind: &str) -> String {
    let found = call(
        tab,
        id,
        "langgraph.threads.search",
        json!({ "connId": conn, "metadata": { "lab": kind } }),
    )
    .await;
    found[0]["threadId"]
        .as_str()
        .unwrap_or_else(|| panic!("run `lab seed langgraph`: no {kind} thread"))
        .to_owned()
}

/// TSK-108: a thread with 41 runs of big metadata (40 of 128 KiB, one of 2 MiB) comes in pages of
/// at most 4 MiB, and the 2 MiB one is left out with a note and loaded on request.
#[tokio::test]
async fn lab_a_thread_with_many_heavy_runs_is_paged_by_bytes() {
    let (_t, mut tab, conn) = setup().await;
    let thread = seeded(&mut tab, 3, &conn, "many-runs").await;
    let mut ids = Vec::new();
    let mut cut_run = None;
    let mut offset = Value::Null;
    let mut pages = 0;
    loop {
        tab.call(
            10 + pages,
            "langgraph.runs.list",
            json!({ "connId": conn, "threadId": thread, "limit": 100, "offset": offset }),
        )
        .await;
        let frame = tab.frame(10 + pages).await;
        assert_eq!(frame.kind, Kind::Result);
        assert!(
            frame.payload.len() < 5 * 1024 * 1024,
            "{} bytes",
            frame.payload.len()
        );
        let page: Value = serde_json::from_slice(&frame.payload).unwrap();
        pages += 1;
        for run in page["items"].as_array().unwrap() {
            ids.push(run["runId"].as_str().unwrap().to_owned());
            if !run["cuts"].as_array().unwrap().is_empty() {
                assert_eq!(run["cuts"][0]["field"], "metadata");
                assert_eq!(run["metadata"], Value::Null);
                cut_run = Some(run["runId"].as_str().unwrap().to_owned());
            }
        }
        match page.get("next") {
            Some(next) => offset = next.clone(),
            None => break,
        }
        assert!(pages < 10);
    }
    assert_eq!(ids.len(), 41, "every run once");
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        41
    );
    assert!(pages >= 2, "7 MiB of metadata is more than one 4 MiB page");
    let cut_run = cut_run.expect("the run with 2 MiB of metadata is left out");
    let run = call(
        &mut tab,
        30,
        "langgraph.runs.get",
        json!({ "connId": conn, "threadId": thread, "runId": cut_run }),
    )
    .await;
    assert_eq!(run["cuts"], json!([]));
    assert_eq!(
        run["metadata"]["blob"].as_str().unwrap().len(),
        2 * 1024 * 1024
    );
}

/// TSK-108: a thread with checkpoints of up to 6 MiB: History's values are left out with a note,
/// one checkpoint's state comes whole, and `readValue` streams the same value.
#[tokio::test]
async fn lab_heavy_checkpoints_are_left_out_of_history_and_load_on_request() {
    let (_t, mut tab, conn) = setup().await;
    let thread = seeded(&mut tab, 3, &conn, "heavy-state").await;
    tab.call(
        4,
        "langgraph.threads.history",
        json!({ "connId": conn, "threadId": thread }),
    )
    .await;
    let frame = tab.frame(4).await;
    assert_eq!(frame.kind, Kind::Result);
    assert!(
        frame.payload.len() < 4 * 1024 * 1024,
        "{} bytes",
        frame.payload.len()
    );
    let history: Value = serde_json::from_slice(&frame.payload).unwrap();
    let items = history["items"].as_array().unwrap();
    assert!(items.len() >= 5, "{history}");
    // The checkpoints whose values are left out (over 1 MiB), and what else was: the first
    // checkpoint's task holds the 1.5 MiB input.
    let cut_field = |s: &Value, field: &str| {
        s["cuts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["field"] == field)
            .cloned()
    };
    let big: Vec<&Value> = items
        .iter()
        .filter(|s| cut_field(s, "values").is_some())
        .collect();
    assert!(
        big.len() >= 4,
        "checkpoints over 1 MiB of values are left out"
    );
    assert!(
        items
            .iter()
            .any(|s| cut_field(s, "tasks.0.result").is_some()),
        "a task's result over 1 MiB too: {history}"
    );
    let newest = big[0];
    assert_eq!(newest["values"], Value::Null);
    assert!(
        cut_field(newest, "values").unwrap()["bytes"]
            .as_u64()
            .unwrap()
            > 1024 * 1024
    );
    // The Step and Source columns still have their metadata.
    assert!(newest["metadata"]["source"].is_string());

    // The smallest of them comes whole from `state` (its values and the rest are under 8 MiB).
    let bytes_of = |s: &Value| cut_field(s, "values").unwrap()["bytes"].as_u64().unwrap();
    let smallest = big.iter().min_by_key(|s| bytes_of(s)).unwrap();
    let state = call(
        &mut tab,
        5,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread, "checkpointId": smallest["checkpointId"] }),
    )
    .await;
    assert_eq!(state["cuts"], json!([]), "{}", state["cuts"]);
    assert_eq!(
        serde_json::to_vec(&state["values"]).unwrap().len() as u64,
        bytes_of(smallest)
    );

    // The newest checkpoint holds the 6 MiB of values and the interrupt's copies of the last
    // message: over the 8 MiB of `state`, so its values are left out, and `full` (12 MiB) loads them.
    let checkpoint = newest["checkpointId"].as_str().unwrap().to_owned();
    let state = call(
        &mut tab,
        7,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread, "checkpointId": checkpoint }),
    )
    .await;
    assert_eq!(state["cuts"][0]["field"], "values");
    assert_eq!(state["values"], Value::Null);
    let loaded = call(
        &mut tab,
        8,
        "langgraph.threads.state",
        json!({ "connId": conn, "threadId": thread, "checkpointId": checkpoint, "full": true }),
    )
    .await;
    assert_eq!(loaded["cuts"], json!([]));
    assert_eq!(
        serde_json::to_vec(&loaded["values"]).unwrap().len() as u64,
        bytes_of(newest)
    );
    // The stream carries the same value, for what is over even that.
    tab.call(
        9,
        "langgraph.threads.readValue",
        json!({ "connId": conn, "threadId": thread, "checkpointId": checkpoint, "field": "values" }),
    )
    .await;
    let mut streamed = Vec::new();
    loop {
        let frame = tab.frame(9).await;
        match frame.kind {
            Kind::Chunk => {
                streamed.extend_from_slice(&frame.payload);
                tab.client.credit(9, 1).await;
            }
            Kind::StreamEnd => break,
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
    assert_eq!(streamed.len() as u64, bytes_of(newest));
    let streamed: Value = serde_json::from_slice(&streamed).unwrap();
    assert_eq!(streamed, loaded["values"]);
}
