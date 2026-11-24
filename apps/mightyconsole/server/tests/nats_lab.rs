//! The `nats` tool against the test lab's NATS servers (Mightyconsole spec §6, §14, §18;
//! TSK-85): the main server (password and nkey users, no-auth default user, TLS from the lab CA,
//! JetStream), a token server and an operator-mode server for `.creds` files. Needs
//! `pnpm --filter @byterygon/mightyconsole lab up nats`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test nats_lab`. Credentials come from
//! `apps/mightyconsole/lab/.generated` (or `$MIGHTYCONSOLE_LAB_GENERATED`).
#![cfg(feature = "lab-tests")]

mod support;

use std::path::PathBuf;

use ambidex::{Code, Kind};
use arrow_array::{Array, RecordBatch, StringArray};
use serde_json::{Value, json};
use support::*;

const ORDER_PROTO: &str =
    include_str!("../../../../crates/message-codecs/tests/fixtures/order.proto");
const MONEY_PROTO: &str =
    include_str!("../../../../crates/message-codecs/tests/fixtures/money.proto");

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn creds() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up nats` first");
    serde_json::from_str::<Value>(&text).unwrap()["nats"].clone()
}

fn file(name: &str) -> String {
    std::fs::read_to_string(generated().join(name)).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

async fn setup() -> (TestServer, Tab) {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    (t, tab)
}

/// The password profile with the Protobuf schema mapped to `lab.proto.>`.
fn lab_profile() -> Value {
    let c = creds();
    json!({
        "name": "lab",
        "servers": [c["url"]],
        "auth": "userPassword",
        "user": c["user"],
        "password": c["password"],
        "schemas": [{ "id": "orders", "name": "orders", "type": "protobuf", "files": [
            { "path": "lab/orders/order.proto", "text": ORDER_PROTO },
            { "path": "lab/common/money.proto", "text": MONEY_PROTO }
        ] }],
        "mappings": [{ "id": "m1", "target": { "kind": "subject", "pattern": "lab.proto.>" }, "part": "value", "schemaId": "orders", "messageType": "lab.orders.Order" }]
    })
}

async fn connect(tab: &mut Tab, id: u32, profile: Value) -> Value {
    tab.call(id, "nats.connect", json!({ "profile": profile }))
        .await;
    tab.result(id).await
}

async fn call(tab: &mut Tab, id: u32, procedure: &str, input: Value) -> Value {
    tab.call(id, procedure, input).await;
    tab.result(id).await
}

fn decode(ipc: &[u8]) -> Vec<RecordBatch> {
    let reader =
        arrow_ipc::reader::StreamReader::try_new(std::io::Cursor::new(ipc.to_vec()), None).unwrap();
    reader.map(Result::unwrap).collect()
}

fn column(batches: &[RecordBatch], name: &str) -> Vec<Option<String>> {
    batches
        .iter()
        .flat_map(|b| {
            let a: &StringArray = b
                .column_by_name(name)
                .unwrap()
                .as_any()
                .downcast_ref()
                .unwrap();
            (0..a.len())
                .map(|i| (!a.is_null(i)).then(|| a.value(i).to_owned()))
                .collect::<Vec<_>>()
        })
        .collect()
}

#[tokio::test]
async fn every_authentication_connects_and_wrong_credentials_are_auth() {
    let (_t, mut tab) = setup().await;
    let c = creds();
    let mut id = 10;
    let mut next = || {
        id += 1;
        id
    };
    // No credentials: the main server's no_auth_user.
    let out = connect(
        &mut tab,
        next(),
        json!({ "name": "anon", "servers": [c["url"]] }),
    )
    .await;
    assert_eq!(out["server"]["serverName"], "lab");
    assert!(out["server"]["jetstream"].as_bool().unwrap());
    // User and password.
    connect(&mut tab, next(), lab_profile()).await;
    // Token, on its own server.
    let out = connect(
        &mut tab,
        next(),
        json!({ "name": "token", "servers": [c["tokenUrl"]], "auth": "token", "token": c["token"] }),
    )
    .await;
    assert_eq!(out["server"]["serverName"], "lab-token");
    // An nkey over TLS with the lab CA pinned.
    let nkey = file(s(&c["nkeySeedFile"]));
    let ca = file(s(&c["caFile"]));
    let out = connect(
        &mut tab,
        next(),
        json!({
            "name": "nkey",
            "servers": ["tls://127.0.0.1:4222"],
            "auth": "nkey",
            "nkeySeed": nkey.trim(),
            "tls": { "enabled": true, "caPem": ca }
        }),
    )
    .await;
    let conn = s(&out["connId"]).to_owned();
    let info = call(
        &mut tab,
        next(),
        "nats.server.info",
        json!({ "connId": conn }),
    )
    .await;
    assert_eq!(info["connection"]["tls"], true);
    assert_eq!(info["connection"]["auth"], "nkey");
    // A .creds file, on the operator-mode server.
    let out = connect(
        &mut tab,
        next(),
        json!({ "name": "creds", "servers": [c["credsUrl"]], "auth": "creds", "creds": file(s(&c["credsFile"])) }),
    )
    .await;
    assert_eq!(out["server"]["serverName"], "lab-jwt");

    // Wrong credentials are Auth (Unauthenticated), whatever the kind.
    for profile in [
        json!({ "name": "bad", "servers": [c["url"]], "auth": "userPassword", "user": "lab", "password": "wrong" }),
        json!({ "name": "bad", "servers": [c["tokenUrl"]], "auth": "token", "token": "wrong" }),
        json!({ "name": "bad", "servers": [c["tokenUrl"]] }),
    ] {
        let call_id = next();
        tab.call(call_id, "nats.connect", json!({ "profile": profile }))
            .await;
        let err = tab.error(call_id, Code::Unauthenticated).await;
        assert_eq!(err.details.unwrap()["kind"], "Auth");
    }
    // TLS against the system store does not trust the lab CA: Tls.
    let call_id = next();
    tab.call(
        call_id,
        "nats.connect",
        json!({ "profile": { "name": "tls", "servers": ["tls://127.0.0.1:4222"] } }),
    )
    .await;
    let err = tab.error(call_id, Code::Unavailable).await;
    assert_eq!(err.details.unwrap()["kind"], "Tls", "{}", err.message);
    // Nothing listens: Connect.
    let call_id = next();
    tab.call(
        call_id,
        "nats.connect",
        json!({ "profile": { "name": "none", "servers": ["nats://127.0.0.1:1"] } }),
    )
    .await;
    let err = tab.error(call_id, Code::Unavailable).await;
    assert_eq!(err.details.unwrap()["kind"], "Connect", "{}", err.message);
}

#[tokio::test]
async fn server_info_and_the_jetstream_account() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let info = call(&mut tab, 3, "nats.server.info", json!({ "connId": conn })).await;
    assert_eq!(info["server"]["serverName"], "lab");
    assert!(info["rttMs"].as_f64().unwrap() >= 0.0);
    assert_eq!(info["connection"]["name"], "mightyconsole");
    assert_eq!(info["connection"]["state"], "connected");
    let js = &info["jetstream"];
    assert!(js["streams"].as_u64().unwrap() >= 1, "{info}");
    assert!(js["storage"].as_u64().unwrap() > 0);
    // The token server runs without JetStream and says so.
    let c = creds();
    let out = connect(
        &mut tab,
        4,
        json!({ "name": "token", "servers": [c["tokenUrl"]], "auth": "token", "token": c["token"] }),
    )
    .await;
    let info = call(
        &mut tab,
        5,
        "nats.server.info",
        json!({ "connId": out["connId"] }),
    )
    .await;
    assert!(info["jetstream"].is_null());
    assert_eq!(
        info["jetstreamError"],
        "JetStream is not enabled on this server"
    );
}

#[tokio::test]
async fn subscribe_with_wildcards_and_a_queue_group_publish_and_request() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    tab.call(
        3,
        "nats.core.subscribe",
        json!({
            "connId": conn,
            "streamId": "s-1",
            "subjects": ["lab.test.*.created", "lab.proto.>"],
            "queueGroup": "mc-test",
            "limit": 3
        }),
    )
    .await;
    // The schema comes first: the subscriptions exist from then on.
    let mut ipc = tab.chunk(3).await;
    tab.client.credit(3, 1).await;

    let published = call(
        &mut tab,
        4,
        "nats.core.publish",
        json!({
            "connId": conn,
            "subject": "lab.test.eu.created",
            "replyTo": "lab.reply.here",
            "headers": [{ "key": "Lab-Seq", "value": "1" }, { "key": "Lab-Seq", "value": "2" }],
            "payload": { "codec": "json", "text": "{\"id\": 1}" }
        }),
    )
    .await;
    assert_eq!(published["bytes"], 9); // JSON goes as typed, validated
    // Not matched by the patterns: never shows.
    call(
        &mut tab,
        5,
        "nats.core.publish",
        json!({ "connId": conn, "subject": "lab.test.eu.x.created", "payload": { "codec": "utf8", "text": "no" } }),
    )
    .await;
    call(
        &mut tab,
        6,
        "nats.core.publish",
        json!({
            "connId": conn,
            "subject": "lab.proto.eu",
            "payload": {
                "codec": "protobuf",
                "text": "{\"id\": \"ord-1\", \"customer\": \"c\", \"status\": \"PAID\"}",
                "schema": { "local": "orders" },
                "messageType": "lab.orders.Order"
            }
        }),
    )
    .await;
    call(
        &mut tab,
        7,
        "nats.core.publish",
        json!({ "connId": conn, "subject": "lab.test.us.created", "payload": { "codec": "utf8", "text": "plain" } }),
    )
    .await;
    let summary = loop {
        let frame = tab.frame(3).await;
        match frame.kind {
            Kind::Chunk => {
                ipc.extend_from_slice(&frame.payload);
                tab.client.credit(3, 1).await;
            }
            Kind::StreamEnd => break serde_json::from_slice::<Value>(&frame.payload).unwrap(),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert_eq!(summary["endReason"], "limit");
    assert_eq!(summary["matched"], 3);
    let batches = decode(&ipc);
    assert_eq!(
        column(&batches, "subject"),
        [
            Some("lab.test.eu.created".into()),
            Some("lab.proto.eu".into()),
            Some("lab.test.us.created".into())
        ]
    );
    assert_eq!(
        column(&batches, "replyTo")[0].as_deref(),
        Some("lab.reply.here")
    );
    assert_eq!(
        column(&batches, "headers")[0].as_deref(),
        Some(r#"[["Lab-Seq","1","text"],["Lab-Seq","2","text"]]"#)
    );
    assert_eq!(
        column(&batches, "timestampKind")[0].as_deref(),
        Some("received")
    );
    // The local Protobuf schema mapped to lab.proto.> decodes the second one.
    let codecs = column(&batches, "payloadCodec");
    assert_eq!(codecs[0].as_deref(), Some("json"));
    assert_eq!(codecs[1].as_deref(), Some("protobuf"));
    let text: Value =
        serde_json::from_str(column(&batches, "payloadText")[1].as_deref().unwrap()).unwrap();
    assert_eq!(text["id"], "ord-1");
    assert_eq!(text["status"], "PAID");
    assert_eq!(
        column(&batches, "schemaRef")[1].as_deref(),
        Some("local:orders#lab.orders.Order")
    );

    // Request: the lab's echo service answers, with its header.
    let out = call(
        &mut tab,
        8,
        "nats.core.request",
        json!({ "connId": conn, "subject": "lab.echo", "headers": [{ "key": "X", "value": "y" }], "payload": { "codec": "json", "text": "{\"ping\": true}" }, "timeoutMs": 5000 }),
    )
    .await;
    assert_eq!(out["reply"]["payloadCodec"], "json");
    let echoed: Value = serde_json::from_str(s(&out["reply"]["payloadText"])).unwrap();
    assert_eq!(echoed, json!({ "ping": true }));
    let headers = out["reply"]["headers"].as_array().unwrap();
    assert!(
        headers
            .iter()
            .any(|h| h["name"] == "Lab-Service" && h["value"] == "echo"),
        "{headers:?}"
    );
    assert!(out["elapsedMs"].as_f64().unwrap() >= 0.0);
    // Nobody listens: Remote with no_responders, at once.
    tab.call(
        9,
        "nats.core.request",
        json!({ "connId": conn, "subject": "lab.nobody.here", "payload": { "codec": "utf8", "text": "?" }, "timeoutMs": 5000 }),
    )
    .await;
    let err = tab.error(9, Code::Unavailable).await;
    let d = err.details.unwrap();
    assert_eq!(d["kind"], "Remote");
    assert_eq!(d["remote"]["code"], "no_responders");
    assert_eq!(d["message"], "No responders on lab.nobody.here");
    // Wildcards do not publish.
    tab.call(
        10,
        "nats.core.publish",
        json!({ "connId": conn, "subject": "lab.*", "payload": { "codec": "utf8", "text": "x" } }),
    )
    .await;
    let err = tab.error(10, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "subject");
}

#[tokio::test]
async fn a_paused_subscription_drops_the_oldest_and_counts_them() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    // Ends after 2,500 matches: the first batches before the pause, then the buffer's newest.
    tab.call(
        3,
        "nats.core.subscribe",
        json!({ "connId": conn, "streamId": "s-2", "subjects": ["lab.flood"], "limit": 2500 }),
    )
    .await;
    let _schema = tab.chunk(3).await;
    // About 2,000 leave the buffer before the pause takes hold (3 batches sent, one coalescing,
    // one waiting for a credit); 14,000 overflow the 10,000 kept.
    for i in 0..14_000 {
        tab.call(
            100 + i,
            "nats.core.publish",
            json!({ "connId": conn, "subject": "lab.flood", "payload": { "codec": "utf8", "text": format!("{i}") } }),
        )
        .await;
        let _ = tab.result(100 + i).await;
    }
    // Resume: the stream reads the buffer again and ends at the limit with what was dropped.
    let summary = loop {
        let frame = tab.frame(3).await;
        match frame.kind {
            Kind::Chunk => tab.client.credit(3, 1).await,
            Kind::StreamEnd => break serde_json::from_slice::<Value>(&frame.payload).unwrap(),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
        if tab.pending.iter().all(|f| f.call_id != 3) {
            tab.client.credit(3, 8).await;
        }
    };
    assert_eq!(summary["endReason"], "limit");
    let dropped = summary["dropped"].as_u64().unwrap();
    assert!(
        (1..=14_000 - 10_000).contains(&dropped),
        "dropped {dropped}: {summary}"
    );
}

// ---- JetStream (batch 2) -----------------------------------------------------------------------

fn u64s(batches: &[RecordBatch], name: &str) -> Vec<u64> {
    batches
        .iter()
        .flat_map(|b| {
            let a: &arrow_array::UInt64Array = b
                .column_by_name(name)
                .unwrap()
                .as_any()
                .downcast_ref()
                .unwrap();
            a.values().to_vec()
        })
        .collect()
}

fn i64s(batches: &[RecordBatch], name: &str) -> Vec<i64> {
    batches
        .iter()
        .flat_map(|b| {
            let a: &arrow_array::Int64Array = b
                .column_by_name(name)
                .unwrap()
                .as_any()
                .downcast_ref()
                .unwrap();
            a.values().to_vec()
        })
        .collect()
}

/// Reads a finite message stream to its end: the batches and the summary.
async fn read_stream(tab: &mut Tab, id: u32) -> (Vec<RecordBatch>, Value) {
    let mut ipc = tab.chunk(id).await;
    tab.client.credit(id, 1).await;
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => {
                ipc.extend_from_slice(&frame.payload);
                tab.client.credit(id, 1).await;
            }
            Kind::StreamEnd => {
                let summary = serde_json::from_slice::<Value>(&frame.payload).unwrap();
                return (decode(&ipc), summary);
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

/// A stream of this test run, gone when the test ends.
fn scratch(tag: &str) -> (String, String) {
    let id = format!("{}{}", std::process::id(), tag);
    (format!("MC_LABTEST_{id}"), format!("mc.labtest.{id}"))
}

fn stream_form(name: &str, subjects: &[String]) -> Value {
    json!({
        "name": name, "subjects": subjects, "storage": "memory", "retention": "limits",
        "discard": "old", "discardNewPerSubject": false, "maxMessages": 100, "replicas": 1,
        "allowDirect": true, "allowRollup": false, "denyDelete": false, "denyPurge": false,
        "compression": "none", "sealed": false, "sources": []
    })
}

#[tokio::test]
async fn streams_list_info_create_update_purge_and_delete() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();

    let list = call(
        &mut tab,
        3,
        "nats.js.streams.list",
        json!({ "connId": conn }),
    )
    .await;
    let orders = list
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "ORDERS")
        .expect("ORDERS is listed");
    assert_eq!(orders["messages"], 1051, "{orders}");
    assert_eq!(orders["subjects"], json!(["orders.>"]));
    let info = call(
        &mut tab,
        4,
        "nats.js.streams.info",
        json!({ "connId": conn, "stream": "ORDERS", "subjectCounts": true }),
    )
    .await;
    assert_eq!(info["state"]["messages"], 1051);
    assert_eq!(info["state"]["firstSequence"], 1);
    assert!(info["state"]["lastUs"].as_i64().unwrap() > 0);
    let counts = info["subjectCounts"].as_array().unwrap();
    assert_eq!(counts[0]["subject"], "orders.eu.created", "{info}");
    assert_eq!(counts[0]["messages"], 334);

    let (name, prefix) = scratch("a");
    let subjects = vec![format!("{prefix}.>")];
    let created = call(
        &mut tab,
        5,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&name, &subjects) }),
    )
    .await;
    assert_eq!(created["config"]["name"], name.as_str());
    assert_eq!(created["config"]["storage"], "memory");
    assert_eq!(created["config"]["maxMessages"], 100);
    assert!(created["config"].get("maxBytes").is_none());
    // The same name again: Conflict on the name.
    tab.call(
        6,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&name, &[format!("{prefix}.other")]) }),
    )
    .await;
    let err = tab.error(6, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["field"], "name");
    // Another stream on the same subjects: Invalid on the subjects.
    let (other, _) = scratch("b");
    tab.call(
        7,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&other, &subjects) }),
    )
    .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "subjects");

    // Update: the form's values on top of the server's; storage cannot change.
    let mut form = stream_form(&name, &subjects);
    form["maxMessages"] = json!(50);
    form["description"] = json!("Mightyconsole lab test");
    let updated = call(
        &mut tab,
        8,
        "nats.js.streams.update",
        json!({ "connId": conn, "config": form }),
    )
    .await;
    assert_eq!(updated["config"]["maxMessages"], 50);
    assert_eq!(updated["config"]["description"], "Mightyconsole lab test");
    let mut form = stream_form(&name, &subjects);
    form["storage"] = json!("file");
    tab.call(
        9,
        "nats.js.streams.update",
        json!({ "connId": conn, "config": form }),
    )
    .await;
    let err = tab.error(9, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "storage", "{}", err.message);

    // Ten messages, five on each subject; then purge a subject, keep 2, and all.
    for i in 0..10u32 {
        let subject = format!("{prefix}.{}", if i % 2 == 0 { "a" } else { "b" });
        call(
            &mut tab,
            20 + i,
            "nats.core.publish",
            json!({ "connId": conn, "subject": subject, "payload": { "codec": "utf8", "text": format!("{i}") } }),
        )
        .await;
    }
    // Core publish is not acknowledged by JetStream: wait until all ten are stored.
    let mut stored = 0;
    for attempt in 0..50u32 {
        let info = call(
            &mut tab,
            40 + attempt,
            "nats.js.streams.info",
            json!({ "connId": conn, "stream": name }),
        )
        .await;
        stored = info["state"]["messages"].as_u64().unwrap();
        if stored == 10 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(stored, 10);
    let out = call(
        &mut tab,
        100,
        "nats.js.streams.purge",
        json!({ "connId": conn, "stream": name, "subject": format!("{prefix}.a") }),
    )
    .await;
    assert_eq!(out["purged"], 5);
    let out = call(
        &mut tab,
        101,
        "nats.js.streams.purge",
        json!({ "connId": conn, "stream": name, "keep": 2 }),
    )
    .await;
    assert_eq!(out["purged"], 3);
    tab.call(
        102,
        "nats.js.streams.purge",
        json!({ "connId": conn, "stream": name, "keep": 1, "upToSequence": 3 }),
    )
    .await;
    let err = tab.error(102, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "keep");
    let out = call(
        &mut tab,
        103,
        "nats.js.streams.purge",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
    assert_eq!(out["purged"], 2);

    call(
        &mut tab,
        104,
        "nats.js.streams.delete",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
    tab.call(
        105,
        "nats.js.streams.info",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
    let err = tab.error(105, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "stream");
}

#[tokio::test]
async fn browse_from_first_last_a_sequence_and_a_time_and_follow() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let info = call(
        &mut tab,
        3,
        "nats.js.streams.info",
        json!({ "connId": conn, "stream": "ORDERS" }),
    )
    .await;
    let last = info["state"]["lastSequence"].as_u64().unwrap();
    let browse = |id: &str, start: Value, extra: Value| {
        let mut input = json!({ "connId": conn, "streamId": id, "stream": "ORDERS", "start": start, "follow": false });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        input
    };

    // The last 5 sequences, then the end.
    tab.call(
        4,
        "nats.js.streams.browse",
        browse("b-1", json!({ "from": "last", "n": 5 }), json!({})),
    )
    .await;
    let (batches, summary) = read_stream(&mut tab, 4).await;
    assert_eq!(summary["endReason"], "end", "{summary}");
    assert_eq!(
        u64s(&batches, "sequence"),
        ((last - 4)..=last).collect::<Vec<_>>()
    );
    assert_eq!(column(&batches, "source")[0].as_deref(), Some("ORDERS"));
    assert_eq!(
        column(&batches, "timestampKind")[0].as_deref(),
        Some("stored")
    );

    // From sequence 10 to 14.
    tab.call(
        5,
        "nats.js.streams.browse",
        browse(
            "b-2",
            json!({ "from": "sequence", "sequence": 10 }),
            json!({ "end": { "sequence": 14 } }),
        ),
    )
    .await;
    let (batches, summary) = read_stream(&mut tab, 5).await;
    assert_eq!(
        u64s(&batches, "sequence"),
        vec![10, 11, 12, 13, 14],
        "{summary}"
    );
    let headers = column(&batches, "headers");
    assert!(
        headers[0].as_deref().unwrap().contains("Lab-Seq"),
        "{headers:?}"
    );

    // From the first message, one subject pattern: the 50 Protobuf orders.
    tab.call(
        6,
        "nats.js.streams.browse",
        browse(
            "b-3",
            json!({ "from": "first" }),
            json!({ "subject": "orders.proto.>" }),
        ),
    )
    .await;
    let (batches, summary) = read_stream(&mut tab, 6).await;
    assert_eq!(summary["matched"], 50, "{summary}");
    assert!(
        column(&batches, "subject")
            .iter()
            .all(|s| s.as_deref().unwrap().starts_with("orders.proto."))
    );

    // From a time: the messages stored at or after the last one's time.
    let last_us = info["state"]["lastUs"].as_i64().unwrap();
    tab.call(
        7,
        "nats.js.streams.browse",
        browse(
            "b-4",
            json!({ "from": "time", "timeUs": last_us }),
            json!({}),
        ),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 7).await;
    let seqs = u64s(&batches, "sequence");
    assert_eq!(seqs.last(), Some(&last));
    assert!(seqs.len() < 1051);

    // The message over 1 MiB: its first MiB in the batch, the whole of it from getMessage.
    tab.call(
        8,
        "nats.js.streams.browse",
        browse(
            "b-5",
            json!({ "from": "first" }),
            json!({ "subject": "orders.large" }),
        ),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 8).await;
    let seq = u64s(&batches, "sequence")[0];
    let size = i64s(&batches, "payloadSize")[0];
    assert!(size > 1 << 20, "{size}");
    let truncated: &arrow_array::BooleanArray = batches[0]
        .column_by_name("payloadTruncated")
        .unwrap()
        .as_any()
        .downcast_ref()
        .unwrap();
    assert!(truncated.value(0));
    let full = call(
        &mut tab,
        9,
        "nats.js.streams.getMessage",
        json!({ "connId": conn, "stream": "ORDERS", "sequence": seq }),
    )
    .await;
    assert_eq!(full["payloadSize"], size);
    assert_eq!(full["payloadTruncated"], false);
    assert_eq!(full["subject"], "orders.large");
    assert_eq!(full["sequence"], seq.to_string());
    use base64::Engine as _;
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s(&full["payloadRaw"]))
        .unwrap();
    assert_eq!(raw.len() as i64, size);

    // Follow: a scratch stream read from its start; new messages arrive until the limit.
    let (name, prefix) = scratch("f");
    call(
        &mut tab,
        10,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&name, &[format!("{prefix}.>")]) }),
    )
    .await;
    tab.call(
        11,
        "nats.js.streams.browse",
        json!({ "connId": conn, "streamId": "b-6", "stream": name, "start": { "from": "first" }, "follow": true, "limit": 3 }),
    )
    .await;
    let mut ipc = tab.chunk(11).await;
    tab.client.credit(11, 1).await;
    for i in 0..3u32 {
        call(
            &mut tab,
            20 + i,
            "nats.core.publish",
            json!({ "connId": conn, "subject": format!("{prefix}.x"), "payload": { "codec": "utf8", "text": format!("{i}") } }),
        )
        .await;
    }
    let summary = loop {
        let frame = tab.frame(11).await;
        match frame.kind {
            Kind::Chunk => {
                ipc.extend_from_slice(&frame.payload);
                tab.client.credit(11, 1).await;
            }
            Kind::StreamEnd => break serde_json::from_slice::<Value>(&frame.payload).unwrap(),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert_eq!(summary["endReason"], "limit");
    assert_eq!(u64s(&decode(&ipc), "sequence"), vec![1, 2, 3]);
    // An empty stream without follow ends at once.
    call(
        &mut tab,
        30,
        "nats.js.streams.purge",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
    tab.call(
        31,
        "nats.js.streams.browse",
        json!({ "connId": conn, "streamId": "b-7", "stream": name, "start": { "from": "first" }, "follow": false }),
    )
    .await;
    let (_, summary) = read_stream(&mut tab, 31).await;
    assert_eq!(summary["scanned"], 0);
    assert_eq!(summary["endReason"], "end");
    call(
        &mut tab,
        32,
        "nats.js.streams.delete",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
    // Each browse deleted its ordered consumer when it ended: only durable ones remain.
    let mut left = usize::MAX;
    for attempt in 0..40u32 {
        let list = call(
            &mut tab,
            50 + attempt,
            "nats.js.consumers.list",
            json!({ "connId": conn, "stream": "ORDERS" }),
        )
        .await;
        left = list
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["config"]["durable"] == false)
            .count();
        if left == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(left, 0, "ephemeral consumers left on ORDERS");
}

/// The message detail's Query (TSK-113, spec §5.4.1): jq on a NATS message's decoded value as
/// the UI holds it, and on the 1.5 MiB message loaded whole, which is over the inline cap but
/// under the query's 8 MiB.
#[tokio::test]
async fn a_jq_query_on_a_nats_message() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    tab.call(
        3,
        "nats.js.streams.browse",
        json!({ "connId": conn, "streamId": "q-1", "stream": "ORDERS", "start": { "from": "first" },
                "follow": false, "limit": 1 }),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 3).await;
    let text = column(&batches, "payloadText")[0].clone().unwrap();
    let out = call(
        &mut tab,
        4,
        "messaging.query",
        json!({ "text": text, "jq": ".id, .region, (.amount | type)" }),
    )
    .await;
    assert_eq!(out["results"], json!(["ord-00000", "eu", "number"]));
    assert_eq!(out["count"], 3);

    tab.call(
        5,
        "nats.js.streams.browse",
        json!({ "connId": conn, "streamId": "q-2", "stream": "ORDERS", "start": { "from": "first" },
                "follow": false, "subject": "orders.large" }),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 5).await;
    let seq = u64s(&batches, "sequence")[0];
    let full = call(
        &mut tab,
        6,
        "nats.js.streams.getMessage",
        json!({ "connId": conn, "stream": "ORDERS", "sequence": seq }),
    )
    .await;
    let out = call(
        &mut tab,
        7,
        "messaging.query",
        json!({ "text": s(&full["payloadText"]), "jq": "{id, note: (.note | length)}" }),
    )
    .await;
    assert_eq!(
        out["results"],
        json!([{ "id": "ord-large", "note": 1536 * 1024 }])
    );
    // `.` on it: the result is over 1 MiB, so nothing comes back and the reply says why.
    let out = call(
        &mut tab,
        8,
        "messaging.query",
        json!({ "text": s(&full["payloadText"]), "jq": "." }),
    )
    .await;
    assert_eq!(out["stopped"], "output");
    assert_eq!(out["count"], 0);
}

#[tokio::test]
async fn consumers_list_info_create_and_delete() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let list = call(
        &mut tab,
        3,
        "nats.js.consumers.list",
        json!({ "connId": conn, "stream": "ORDERS" }),
    )
    .await;
    let billing = list
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "billing")
        .expect("billing is listed");
    assert!(billing["config"]["durable"].as_bool().unwrap());
    assert_eq!(billing["config"]["filterSubjects"], json!(["orders.eu.>"]));
    assert_eq!(billing["numAckPending"], 3, "{billing}");
    assert!(billing["numPending"].as_u64().unwrap() > 0);
    assert!(billing["ackFloor"]["stream"].as_u64().unwrap() > 0);
    let info = call(
        &mut tab,
        4,
        "nats.js.consumers.info",
        json!({ "connId": conn, "stream": "ORDERS", "consumer": "billing" }),
    )
    .await;
    assert_eq!(info["config"]["ackPolicy"], "explicit");
    assert_eq!(info["config"]["ackWaitMs"], 30_000);

    let name = format!("mc-labtest-{}", std::process::id());
    let config = json!({
        "name": name, "durable": true, "filterSubjects": ["orders.us.>"], "deliver": "all",
        "ackPolicy": "explicit", "ackWaitMs": 30000, "maxDeliver": 5, "replay": "instant", "headersOnly": false
    });
    let created = call(
        &mut tab,
        5,
        "nats.js.consumers.create",
        json!({ "connId": conn, "stream": "ORDERS", "config": config }),
    )
    .await;
    assert_eq!(created["name"], name.as_str());
    assert_eq!(created["numPending"], 333);
    assert_eq!(created["config"]["maxDeliver"], 5);
    let mut other = config.clone();
    other["filterSubjects"] = json!(["orders.apac.>"]);
    tab.call(
        6,
        "nats.js.consumers.create",
        json!({ "connId": conn, "stream": "ORDERS", "config": other }),
    )
    .await;
    let err = tab.error(6, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["field"], "name");
    call(
        &mut tab,
        7,
        "nats.js.consumers.delete",
        json!({ "connId": conn, "stream": "ORDERS", "consumer": name }),
    )
    .await;
    tab.call(
        8,
        "nats.js.consumers.info",
        json!({ "connId": conn, "stream": "ORDERS", "consumer": name }),
    )
    .await;
    let err = tab.error(8, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "consumer");
}

// ---- Key-Value (batch 3a) ----------------------------------------------------------------------

#[tokio::test]
async fn kv_buckets_keys_get_history_and_the_deleted_key() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let buckets = call(
        &mut tab,
        3,
        "nats.kv.buckets.list",
        json!({ "connId": conn }),
    )
    .await;
    let config = buckets
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["bucket"] == "config")
        .expect("the config bucket");
    assert_eq!(config["history"], 5, "{config}");
    let keys = call(
        &mut tab,
        4,
        "nats.kv.keys",
        json!({ "connId": conn, "bucket": "config" }),
    )
    .await;
    let names: Vec<&str> = keys["keys"]
        .as_array()
        .unwrap()
        .iter()
        .map(|k| s(&k["key"]))
        .collect();
    assert_eq!(names, ["feature.checkout", "limits.orders", "motd"]);
    assert_eq!(keys["truncated"], false);
    let motd = &keys["keys"][2];
    assert_eq!(motd["preview"], "Welcome to the lab");
    let all = call(
        &mut tab,
        5,
        "nats.kv.keys",
        json!({ "connId": conn, "bucket": "config", "includeDeleted": true }),
    )
    .await;
    let legacy = all["keys"]
        .as_array()
        .unwrap()
        .iter()
        .find(|k| k["key"] == "legacy.flag")
        .expect("the deleted key");
    assert_eq!(legacy["operation"], "delete");
    let filtered = call(
        &mut tab,
        6,
        "nats.kv.keys",
        json!({ "connId": conn, "bucket": "config", "filter": "feature.>" }),
    )
    .await;
    assert_eq!(filtered["keys"].as_array().unwrap().len(), 1);

    let latest = call(
        &mut tab,
        7,
        "nats.kv.get",
        json!({ "connId": conn, "bucket": "config", "key": "feature.checkout" }),
    )
    .await;
    assert_eq!(latest["source"], "config");
    assert_eq!(latest["subject"], "feature.checkout");
    assert_eq!(latest["operation"], "put");
    assert_eq!(latest["payloadCodec"], "json");
    let history = call(
        &mut tab,
        8,
        "nats.kv.history",
        json!({ "connId": conn, "bucket": "config", "key": "feature.checkout" }),
    )
    .await;
    let revisions: Vec<u64> = history
        .as_array()
        .unwrap()
        .iter()
        .map(|e| s(&e["sequence"]).parse().unwrap())
        .collect();
    assert_eq!(revisions.len(), 3);
    assert_eq!(
        revisions.last().unwrap().to_string(),
        s(&latest["sequence"])
    );
    let first = call(
        &mut tab,
        9,
        "nats.kv.get",
        json!({ "connId": conn, "bucket": "config", "key": "feature.checkout", "revision": revisions[0] }),
    )
    .await;
    assert!(
        s(&first["payloadText"]).contains("\"revision\": 0"),
        "{first}"
    );
    tab.call(
        10,
        "nats.kv.get",
        json!({ "connId": conn, "bucket": "config", "key": "no.such.key" }),
    )
    .await;
    let err = tab.error(10, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "key");
    tab.call(
        11,
        "nats.kv.buckets.info",
        json!({ "connId": conn, "bucket": "nope" }),
    )
    .await;
    let err = tab.error(11, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "bucket");

    // Watch: by default each key's current entry first (the deleted key's marker too), then
    // changes; with history, every revision kept.
    tab.call(
        12,
        "nats.kv.watch",
        json!({ "connId": conn, "streamId": "w-cur", "bucket": "config", "limit": 4 }),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 12).await;
    let mut keys = column(&batches, "subject");
    keys.sort();
    assert_eq!(
        keys,
        [
            Some("feature.checkout".into()),
            Some("legacy.flag".into()),
            Some("limits.orders".into()),
            Some("motd".into())
        ]
    );
    tab.call(
        13,
        "nats.kv.watch",
        json!({ "connId": conn, "streamId": "w-all", "bucket": "config", "keys": "feature.>", "includeHistory": true, "limit": 3 }),
    )
    .await;
    let (batches, _) = read_stream(&mut tab, 13).await;
    assert_eq!(u64s(&batches, "sequence"), revisions);
}

#[tokio::test]
async fn kv_create_put_with_revisions_delete_purge_watch_and_delete_the_bucket() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let bucket = format!("mc_labtest_{}", std::process::id());
    let created = call(
        &mut tab,
        3,
        "nats.kv.buckets.create",
        json!({ "connId": conn, "config": { "bucket": bucket, "history": 4, "storage": "memory", "replicas": 1, "compression": false, "ttlMs": 3_600_000 } }),
    )
    .await;
    assert_eq!(created["history"], 4);
    assert_eq!(created["ttlMs"], 3_600_000);
    tab.call(
        4,
        "nats.kv.buckets.create",
        json!({ "connId": conn, "config": { "bucket": bucket, "history": 1, "storage": "memory", "replicas": 1, "compression": false } }),
    )
    .await;
    let err = tab.error(4, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["field"], "bucket");

    // A watch with history over the bucket, ending after four entries.
    tab.call(
        5,
        "nats.kv.watch",
        json!({ "connId": conn, "streamId": "w-1", "bucket": bucket, "includeHistory": true, "limit": 4 }),
    )
    .await;
    let mut ipc = tab.chunk(5).await;
    tab.client.credit(5, 1).await;

    let put = |id: u32, value: &str, expect: Option<u64>| {
        let mut input = json!({ "connId": conn, "bucket": bucket, "key": "feature.x", "payload": { "codec": "json", "text": value } });
        if let Some(r) = expect {
            input["expectRevision"] = json!(r);
        }
        (id, input)
    };
    let (id, input) = put(6, "{\"v\": 1}", Some(0));
    let r1 = call(&mut tab, id, "nats.kv.put", input).await["revision"]
        .as_u64()
        .unwrap();
    let (id, input) = put(7, "{\"v\": 2}", Some(0));
    tab.call(id, "nats.kv.put", input).await;
    let err = tab.error(7, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["field"], "expectRevision");
    let (id, input) = put(8, "{\"v\": 2}", Some(r1));
    let r2 = call(&mut tab, id, "nats.kv.put", input).await["revision"]
        .as_u64()
        .unwrap();
    assert!(r2 > r1);
    // "Put revision 1 back" with the revision seen before a concurrent change: Conflict.
    let (id, input) = put(9, "{\"v\": 1}", Some(r1));
    tab.call(id, "nats.kv.put", input).await;
    let err = tab.error(9, Code::FailedPrecondition).await;
    assert!(
        err.message.contains("no longer at revision"),
        "{}",
        err.message
    );
    let (id, input) = put(10, "{\"v\": 1}", Some(r2));
    call(&mut tab, id, "nats.kv.put", input).await;
    call(
        &mut tab,
        11,
        "nats.kv.delete",
        json!({ "connId": conn, "bucket": bucket, "key": "feature.x" }),
    )
    .await;

    let summary = loop {
        let frame = tab.frame(5).await;
        match frame.kind {
            Kind::Chunk => {
                ipc.extend_from_slice(&frame.payload);
                tab.client.credit(5, 1).await;
            }
            Kind::StreamEnd => break serde_json::from_slice::<Value>(&frame.payload).unwrap(),
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert_eq!(summary["endReason"], "limit");
    let batches = decode(&ipc);
    assert_eq!(
        column(&batches, "operation"),
        [
            Some("put".into()),
            Some("put".into()),
            Some("put".into()),
            Some("delete".into())
        ]
    );
    assert_eq!(column(&batches, "subject")[0].as_deref(), Some("feature.x"));

    let keys = call(
        &mut tab,
        12,
        "nats.kv.keys",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    assert_eq!(keys["keys"].as_array().unwrap().len(), 0);
    let history = call(
        &mut tab,
        13,
        "nats.kv.history",
        json!({ "connId": conn, "bucket": bucket, "key": "feature.x" }),
    )
    .await;
    assert_eq!(history.as_array().unwrap().len(), 4);
    call(
        &mut tab,
        14,
        "nats.kv.purge",
        json!({ "connId": conn, "bucket": bucket, "key": "feature.x" }),
    )
    .await;
    let history = call(
        &mut tab,
        15,
        "nats.kv.history",
        json!({ "connId": conn, "bucket": bucket, "key": "feature.x" }),
    )
    .await;
    assert_eq!(history.as_array().unwrap().len(), 1);
    assert_eq!(history[0]["operation"], "purge");

    call(
        &mut tab,
        16,
        "nats.kv.buckets.delete",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    tab.call(
        17,
        "nats.kv.buckets.info",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    tab.error(17, Code::NotFound).await;
}

/// Reads a `bytes` stream to its end: the bytes and the summary.
async fn download(tab: &mut Tab, id: u32) -> (Vec<u8>, Value) {
    let mut out = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            Kind::Chunk => {
                out.extend_from_slice(&frame.payload);
                tab.client.credit(id, 1).await;
            }
            Kind::StreamEnd => {
                return (
                    out,
                    serde_json::from_slice::<Value>(&frame.payload).unwrap(),
                );
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

/// The seed's 5 MiB file (`labtools/seed.py`).
fn lab_blob() -> Vec<u8> {
    (0..5 * 1024 * 1024)
        .map(|i: usize| ((i * 31 + 7) % 251) as u8)
        .collect()
}

fn sha256_digest(bytes: &[u8]) -> String {
    use base64::Engine as _;
    use sha2::Digest as _;
    format!(
        "SHA-256={}",
        base64::engine::general_purpose::URL_SAFE.encode(sha2::Sha256::digest(bytes))
    )
}

#[tokio::test]
async fn object_store_buckets_list_info_and_download_the_lab_files() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let buckets = call(
        &mut tab,
        3,
        "nats.obj.buckets.list",
        json!({ "connId": conn }),
    )
    .await;
    let files = buckets
        .as_array()
        .unwrap()
        .iter()
        .find(|b| b["bucket"] == "files")
        .expect("the lab's object store files");
    assert_eq!(files["description"], "Mightyconsole lab");
    assert!(files["bytes"].as_u64().unwrap() > 5 * 1024 * 1024);
    assert_eq!(files["sealed"], false);
    // KV buckets are not object stores.
    assert!(
        !buckets
            .as_array()
            .unwrap()
            .iter()
            .any(|b| b["bucket"] == "config")
    );
    let info = call(
        &mut tab,
        4,
        "nats.obj.buckets.info",
        json!({ "connId": conn, "bucket": "files" }),
    )
    .await;
    assert_eq!(info["bucket"], "files");

    let list = call(
        &mut tab,
        5,
        "nats.obj.list",
        json!({ "connId": conn, "bucket": "files" }),
    )
    .await;
    assert_eq!(list["truncated"], false);
    let names: Vec<&str> = list["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| s(&o["name"]))
        .collect();
    assert_eq!(names, ["blob-5MiB.bin", "readme.txt"]);
    let blob = &list["objects"][0];
    assert_eq!(blob["size"], 5 * 1024 * 1024);
    assert_eq!(blob["chunks"], 40, "128 KiB chunks");
    assert!(blob["modifiedUs"].as_i64().unwrap() > 0);
    let expected = lab_blob();
    assert_eq!(blob["digest"], sha256_digest(&expected));

    let readme = call(
        &mut tab,
        6,
        "nats.obj.info",
        json!({ "connId": conn, "bucket": "files", "name": "readme.txt" }),
    )
    .await;
    assert_eq!(readme["size"], 32);

    tab.call(
        7,
        "nats.obj.get",
        json!({ "connId": conn, "bucket": "files", "name": "blob-5MiB.bin" }),
    )
    .await;
    let (bytes, summary) = download(&mut tab, 7).await;
    assert_eq!(summary["size"], 5 * 1024 * 1024);
    assert_eq!(summary["digest"], blob["digest"]);
    assert!(bytes == expected, "the downloaded bytes are the seed's");

    tab.call(
        8,
        "nats.obj.info",
        json!({ "connId": conn, "bucket": "files", "name": "nope.bin" }),
    )
    .await;
    let err = tab.error(8, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "object");
    tab.call(
        9,
        "nats.obj.get",
        json!({ "connId": conn, "bucket": "files", "name": "nope.bin" }),
    )
    .await;
    tab.error(9, Code::NotFound).await;
    tab.call(
        10,
        "nats.obj.list",
        json!({ "connId": conn, "bucket": "no_such_store" }),
    )
    .await;
    let err = tab.error(10, Code::NotFound).await;
    assert_eq!(err.details.unwrap()["resource"], "bucket");
}

#[tokio::test]
async fn object_store_create_upload_in_parts_replace_abort_and_delete() {
    use base64::Engine as _;
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let bucket = format!("mc_labtest_obj_{}", std::process::id());
    let created = call(
        &mut tab,
        3,
        "nats.obj.buckets.create",
        json!({ "connId": conn, "config": { "bucket": bucket, "description": "test", "storage": "memory", "replicas": 1, "compression": false } }),
    )
    .await;
    assert_eq!(created["storage"], "memory");
    tab.call(
        4,
        "nats.obj.buckets.create",
        json!({ "connId": conn, "config": { "bucket": bucket, "storage": "memory", "replicas": 1, "compression": false } }),
    )
    .await;
    let err = tab.error(4, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["field"], "bucket");

    // 9 MiB in three parts: 4 MiB, 4 MiB, 1 MiB.
    let size = 9 * 1024 * 1024;
    let data: Vec<u8> = (0..size).map(|i: usize| (i % 253) as u8).collect();
    let start = |id: u32, size: usize| {
        (
            id,
            json!({ "connId": conn, "bucket": bucket, "name": "reports/big file.bin", "size": size, "description": "nine", "headers": [{ "name": "Content-Type", "value": "application/octet-stream" }] }),
        )
    };
    let (id, input) = start(5, size);
    let started = call(&mut tab, id, "nats.obj.uploadStart", input).await;
    let upload = s(&started["uploadId"]).to_owned();
    let part = started["partBytes"].as_u64().unwrap() as usize;
    assert_eq!(part, 4 * 1024 * 1024);
    // Out of order.
    tab.call(
        6,
        "nats.obj.uploadPart",
        json!({ "uploadId": upload, "index": 1, "data": b64(&data[..part]) }),
    )
    .await;
    let err = tab.error(6, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "index");
    // Finishing early.
    tab.call(7, "nats.obj.uploadFinish", json!({ "uploadId": upload }))
        .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "size");
    let mut id = 8;
    for (i, chunk) in data.chunks(part).enumerate() {
        let got = call(
            &mut tab,
            id,
            "nats.obj.uploadPart",
            json!({ "uploadId": upload, "index": i, "data": b64(chunk) }),
        )
        .await;
        assert_eq!(got["received"], (i * part + chunk.len()) as u64);
        id += 1;
    }
    let hex: String = {
        use sha2::Digest as _;
        sha2::Sha256::digest(&data)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    let info = call(
        &mut tab,
        id,
        "nats.obj.uploadFinish",
        json!({ "uploadId": upload, "sha256": hex }),
    )
    .await;
    id += 1;
    assert_eq!(info["size"], size as u64);
    assert_eq!(info["chunks"], 72, "9 MiB in 128 KiB chunks");
    assert_eq!(info["digest"], sha256_digest(&data));
    assert_eq!(info["description"], "nine");
    assert_eq!(info["headers"][0]["value"], "application/octet-stream");
    // The upload is over.
    tab.call(
        id,
        "nats.obj.uploadPart",
        json!({ "uploadId": upload, "index": 3, "data": b64(b"x") }),
    )
    .await;
    tab.error(id, Code::NotFound).await;
    id += 1;

    tab.call(
        id,
        "nats.obj.get",
        json!({ "connId": conn, "bucket": bucket, "name": "reports/big file.bin" }),
    )
    .await;
    let (bytes, summary) = download(&mut tab, id).await;
    id += 1;
    assert_eq!(summary["size"], size as u64);
    assert!(bytes == data, "the bytes read back are the ones uploaded");

    // Replace it with a small version: the old chunks are purged.
    let (sid, input) = start(id, 5);
    let small = call(&mut tab, sid, "nats.obj.uploadStart", input).await;
    id += 1;
    let small_id = s(&small["uploadId"]).to_owned();
    call(
        &mut tab,
        id,
        "nats.obj.uploadPart",
        json!({ "uploadId": small_id, "index": 0, "data": b64(b"hello") }),
    )
    .await;
    id += 1;
    let v2 = call(
        &mut tab,
        id,
        "nats.obj.uploadFinish",
        json!({ "uploadId": small_id, "sha256": sha256_digest(b"hello") }),
    )
    .await;
    id += 1;
    assert_eq!(v2["size"], 5);
    assert_ne!(v2["nuid"], info["nuid"]);
    let state = call(
        &mut tab,
        id,
        "nats.obj.buckets.info",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    id += 1;
    assert!(
        state["bytes"].as_u64().unwrap() < 1024 * 1024,
        "the 9 MiB version's chunks are gone: {state}"
    );

    // An aborted upload leaves nothing; a wrong digest discards the upload.
    let (sid, input) = start(id, part + 10);
    let aborted = call(&mut tab, sid, "nats.obj.uploadStart", input).await;
    id += 1;
    let aborted_id = s(&aborted["uploadId"]).to_owned();
    call(
        &mut tab,
        id,
        "nats.obj.uploadPart",
        json!({ "uploadId": aborted_id, "index": 0, "data": b64(&data[..part]) }),
    )
    .await;
    id += 1;
    call(
        &mut tab,
        id,
        "nats.obj.uploadAbort",
        json!({ "uploadId": aborted_id }),
    )
    .await;
    id += 1;
    tab.call(
        id,
        "nats.obj.uploadPart",
        json!({ "uploadId": aborted_id, "index": 1, "data": b64(b"0123456789") }),
    )
    .await;
    tab.error(id, Code::NotFound).await;
    id += 1;
    let (sid, input) = start(id, 3);
    let wrong = call(&mut tab, sid, "nats.obj.uploadStart", input).await;
    id += 1;
    let wrong_id = s(&wrong["uploadId"]).to_owned();
    call(
        &mut tab,
        id,
        "nats.obj.uploadPart",
        json!({ "uploadId": wrong_id, "index": 0, "data": b64(b"abc") }),
    )
    .await;
    id += 1;
    tab.call(
        id,
        "nats.obj.uploadFinish",
        json!({ "uploadId": wrong_id, "sha256": sha256_digest(b"abd") }),
    )
    .await;
    let err = tab.error(id, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "sha256");
    id += 1;
    let state = call(
        &mut tab,
        id,
        "nats.obj.buckets.info",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    id += 1;
    assert!(
        state["bytes"].as_u64().unwrap() < 1024 * 1024,
        "the aborted upload's chunks are gone: {state}"
    );
    let current = call(
        &mut tab,
        id,
        "nats.obj.info",
        json!({ "connId": conn, "bucket": bucket, "name": "reports/big file.bin" }),
    )
    .await;
    id += 1;
    assert_eq!(current["nuid"], v2["nuid"], "neither replaced the object");

    // Too large, and a bad header.
    tab.call(
        id,
        "nats.obj.uploadStart",
        json!({ "connId": conn, "bucket": bucket, "name": "x", "size": 2u64 << 30 }),
    )
    .await;
    let err = tab.error(id, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "size");
    id += 1;
    tab.call(id, "nats.obj.uploadStart", json!({ "connId": conn, "bucket": bucket, "name": "x", "size": 1, "headers": [{ "name": "a b", "value": "1" }] }))
        .await;
    let err = tab.error(id, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "headers");
    id += 1;

    // An empty file.
    let empty = call(
        &mut tab,
        id,
        "nats.obj.uploadStart",
        json!({ "connId": conn, "bucket": bucket, "name": "empty", "size": 0 }),
    )
    .await;
    id += 1;
    let empty = call(
        &mut tab,
        id,
        "nats.obj.uploadFinish",
        json!({ "uploadId": empty["uploadId"] }),
    )
    .await;
    id += 1;
    assert_eq!(empty["size"], 0);
    assert_eq!(empty["chunks"], 0);

    call(
        &mut tab,
        id,
        "nats.obj.delete",
        json!({ "connId": conn, "bucket": bucket, "name": "reports/big file.bin" }),
    )
    .await;
    id += 1;
    let list = call(
        &mut tab,
        id,
        "nats.obj.list",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    id += 1;
    let names: Vec<&str> = list["objects"]
        .as_array()
        .unwrap()
        .iter()
        .map(|o| s(&o["name"]))
        .collect();
    assert_eq!(names, ["empty"]);
    tab.call(
        id,
        "nats.obj.delete",
        json!({ "connId": conn, "bucket": bucket, "name": "reports/big file.bin" }),
    )
    .await;
    tab.error(id, Code::NotFound).await;
    id += 1;
    call(
        &mut tab,
        id,
        "nats.obj.buckets.delete",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    id += 1;
    tab.call(
        id,
        "nats.obj.buckets.info",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    tab.error(id, Code::NotFound).await;
}

#[tokio::test]
async fn services_discover_stats_and_ping_the_lab_echo() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let found = call(
        &mut tab,
        3,
        "nats.services.discover",
        json!({ "connId": conn, "timeoutMs": 1000 }),
    )
    .await;
    let echo = found
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "echo")
        .unwrap_or_else(|| panic!("the lab's echo service: {found}"));
    assert_eq!(echo["version"], "1.0.0");
    assert_eq!(
        echo["description"],
        "Echoes the request (Mightyconsole lab)"
    );
    let subjects: Vec<&str> = echo["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| s(&e["subject"]))
        .collect();
    assert!(
        subjects.contains(&"lab.echo") && subjects.contains(&"lab.echo.upper"),
        "{subjects:?}"
    );
    let id = s(&echo["id"]).to_owned();

    // A request through the service, then its counters.
    call(&mut tab, 4, "nats.core.request", json!({ "connId": conn, "subject": "lab.echo", "headers": [], "payload": { "codec": "utf8", "text": "ping" }, "timeoutMs": 5000 })).await;
    let stats = call(
        &mut tab,
        5,
        "nats.services.stats",
        json!({ "connId": conn, "name": "echo", "id": id, "timeoutMs": 1000 }),
    )
    .await;
    let stats = stats.as_array().unwrap();
    assert_eq!(stats.len(), 1, "{stats:?}");
    let endpoint = stats[0]["endpoints"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["subject"] == "lab.echo")
        .unwrap();
    assert!(endpoint["requests"].as_u64().unwrap() >= 1, "{endpoint}");
    assert!(stats[0]["started"].is_string());

    let pings = call(
        &mut tab,
        6,
        "nats.services.ping",
        json!({ "connId": conn, "name": "echo", "timeoutMs": 1000 }),
    )
    .await;
    let ping = pings
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id.as_str())
        .unwrap();
    assert!(ping["rttMs"].as_f64().unwrap() >= 0.0);

    // Nobody by that name: an empty answer, quickly (no responders).
    let started = std::time::Instant::now();
    let none = call(
        &mut tab,
        7,
        "nats.services.ping",
        json!({ "connId": conn, "name": "nobody_here", "timeoutMs": 2000 }),
    )
    .await;
    assert_eq!(none, json!([]));
    assert!(
        started.elapsed() < std::time::Duration::from_millis(1500),
        "no responders ends the wait"
    );
    tab.call(
        8,
        "nats.services.stats",
        json!({ "connId": conn, "id": "x" }),
    )
    .await;
    let err = tab.error(8, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "id");
}

fn subjects_of(out: &Value) -> Vec<String> {
    out["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| s(&r["subject"]).to_owned())
        .collect()
}

#[tokio::test]
async fn mapping_tests_on_streams_buckets_and_a_cbor_stream_and_the_counts() {
    let (_t, mut tab) = setup().await;
    let out = connect(&mut tab, 2, lab_profile()).await;
    let conn = s(&out["connId"]).to_owned();
    let test = |mapping: Value, extra: Value| {
        let mut input = json!({ "connId": conn, "mapping": mapping });
        for (k, v) in extra.as_object().unwrap() {
            input[k] = v.clone();
        }
        input
    };
    let proto = |pattern: &str| {
        json!({ "id": "t", "target": { "kind": "subject", "pattern": pattern }, "part": "value",
                "codec": "protobuf", "schemaId": "orders", "messageType": "lab.orders.Order" })
    };

    // The lab's Protobuf messages: the last 20 of orders.proto.>, all decoded, oldest first.
    let out = call(
        &mut tab,
        3,
        "nats.schemas.test",
        test(proto("orders.proto.>"), json!({})),
    )
    .await;
    assert_eq!(out["source"], "stream ORDERS", "{out}");
    assert_eq!(
        (out["decoded"].as_u64(), out["failed"].as_u64()),
        (Some(20), Some(0)),
        "{out}"
    );
    assert!(
        subjects_of(&out)
            .iter()
            .all(|s| s.starts_with("orders.proto."))
    );
    let seqs: Vec<u64> = out["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["sequence"].as_u64().unwrap())
        .collect();
    assert!(seqs.windows(2).all(|w| w[0] < w[1]), "{seqs:?}");
    assert!(s(&out["rows"][0]["text"]).contains("\"customer\""), "{out}");

    // orders.>: the newest is the 1.5 MiB JSON message, which is not Protobuf: it fails, shown
    // as hex cut at 400 characters, and names its subject.
    let out = call(
        &mut tab,
        4,
        "nats.schemas.test",
        test(proto("orders.>"), json!({ "limit": 5 })),
    )
    .await;
    assert_eq!(out["rows"].as_array().unwrap().len(), 5, "{out}");
    let last = &out["rows"][4];
    assert_eq!(last["subject"], "orders.large", "{out}");
    assert_eq!(last["codec"], "hex");
    assert!(last["error"].is_string());
    assert!(s(&last["text"]).chars().count() <= 401);

    // A stream, whatever the subject, as JSON: the Protobuf ones fail, the large one decodes.
    let out = call(
        &mut tab,
        5,
        "nats.schemas.test",
        test(json!({ "id": "t", "target": { "kind": "stream", "name": "ORDERS" }, "part": "value", "codec": "json" }), json!({ "limit": 3 })),
    )
    .await;
    assert_eq!(out["source"], "stream ORDERS");
    assert_eq!(
        (out["decoded"].as_u64(), out["failed"].as_u64()),
        (Some(1), Some(2)),
        "{out}"
    );

    // A KV bucket: its puts by key (the deleted key's put is history, the delete marker is not).
    let out = call(
        &mut tab,
        6,
        "nats.schemas.test",
        test(json!({ "id": "t", "target": { "kind": "kvBucket", "bucket": "config" }, "part": "value", "codec": "json" }), json!({})),
    )
    .await;
    assert_eq!(out["source"], "bucket config");
    let keys = subjects_of(&out);
    assert_eq!(
        keys.iter().filter(|k| *k == "feature.checkout").count(),
        3,
        "{out}"
    );
    assert!(
        keys.contains(&"limits.orders".to_owned()) && keys.contains(&"motd".to_owned()),
        "{out}"
    );
    let motd = out["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["subject"] == "motd")
        .unwrap();
    assert!(
        motd["error"].is_string(),
        "\"Welcome to the lab\" is not JSON: {motd}"
    );

    // A pattern no stream stores: nothing to test on, and why.
    let out = call(
        &mut tab,
        7,
        "nats.schemas.test",
        test(proto("lab.core.only.>"), json!({})),
    )
    .await;
    assert_eq!(out["rows"], json!([]));
    assert!(
        s(&out["note"]).contains("No stream stores lab.core.only.>"),
        "{out}"
    );

    // A schema as edited, not saved: its compile errors come back with the failing rows.
    let broken = json!([{ "id": "orders", "name": "orders", "type": "protobuf", "files": [{ "path": "o.proto", "text": "syntax = \"proto3\";\nmessage {" }] }]);
    let out = call(
        &mut tab,
        8,
        "nats.schemas.test",
        test(
            proto("orders.proto.>"),
            json!({ "schemas": broken, "limit": 2 }),
        ),
    )
    .await;
    assert_eq!(out["issues"][0]["file"], "o.proto", "{out}");
    assert_eq!(out["failed"], 2);

    // Keys: NATS has none. Topics: Kafka's.
    tab.call(9, "nats.schemas.test", test(json!({ "id": "t", "target": { "kind": "subject", "pattern": "orders.>" }, "part": "key", "codec": "json" }), json!({}))).await;
    assert_eq!(
        tab.error(9, Code::InvalidArgument).await.details.unwrap()["field"],
        "mapping.part"
    );
    tab.call(10, "nats.schemas.test", test(json!({ "id": "t", "target": { "kind": "topic", "name": "orders" }, "part": "value", "codec": "json" }), json!({}))).await;
    tab.error(10, Code::InvalidArgument).await;

    // CBOR end to end: published through the Composer's codec into a stream of this test, found by
    // the test, then decoded by a saved mapping in a browse, which counts it.
    let (name, prefix) = scratch("cbor");
    let subjects = vec![format!("{prefix}.>")];
    call(
        &mut tab,
        11,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&name, &subjects) }),
    )
    .await;
    let body = r#"{"user":"c-2207","cart":[1009,1010],"exp":1795060000}"#;
    let published = call(
        &mut tab,
        12,
        "nats.core.publish",
        json!({ "connId": conn, "subject": format!("{prefix}.sessions"), "payload": { "codec": "cbor", "text": body } }),
    )
    .await;
    assert!(published["bytes"].as_u64().unwrap() < body.len() as u64);
    let cbor = json!({ "id": "c1", "target": { "kind": "subject", "pattern": format!("{prefix}.>") }, "part": "value", "codec": "cbor" });
    // The stream may take a moment to store the core publish.
    let mut out = Value::Null;
    for attempt in 0..20 {
        out = call(
            &mut tab,
            13 + attempt,
            "nats.schemas.test",
            test(cbor.clone(), json!({})),
        )
        .await;
        if out["decoded"] == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(out["rows"][0]["text"], body, "{out}");
    assert_eq!(out["source"], format!("stream {name}"));
    // Auto-detect finds CBOR without a mapping as well.
    tab.call(40, "nats.js.streams.browse", json!({ "connId": conn, "streamId": "cbor-1", "stream": name, "start": { "from": "first" }, "follow": false })).await;
    let (batches, _) = read_stream(&mut tab, 40).await;
    assert_eq!(
        column(&batches, "payloadCodec"),
        vec![Some("cbor".to_owned())]
    );
    assert_eq!(column(&batches, "payloadText")[0].as_deref(), Some(body));
    // Saved, the mapping decodes the browse and counts it; the other mapping keeps its place.
    let mut mappings = lab_profile()["mappings"].clone();
    mappings.as_array_mut().unwrap().insert(0, cbor.clone());
    let updated = call(
        &mut tab,
        41,
        "messaging.schemas.update",
        json!({ "connId": conn, "schemas": lab_profile()["schemas"], "mappings": mappings }),
    )
    .await;
    assert_eq!(updated["issues"], json!([]));
    tab.call(42, "nats.js.streams.browse", json!({ "connId": conn, "streamId": "cbor-2", "stream": name, "start": { "from": "first" }, "follow": false })).await;
    let (batches, _) = read_stream(&mut tab, 42).await;
    assert_eq!(
        column(&batches, "payloadCodec"),
        vec![Some("cbor".to_owned())]
    );
    let status = call(
        &mut tab,
        43,
        "messaging.schemas.status",
        json!({ "connId": conn }),
    )
    .await;
    assert_eq!(status["schemas"][0]["id"], "orders", "{status}");
    assert_eq!(status["schemas"][0]["messageTypes"][0], "lab.orders.Order");
    assert_eq!(
        status["mappings"][0],
        json!({ "id": "c1", "count": { "decoded": 1, "failed": 0 } }),
        "{status}"
    );
    assert_eq!(status["mappings"][1]["id"], "m1");
    call(
        &mut tab,
        44,
        "nats.js.streams.delete",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
}

/// A Confluent-compatible registry on loopback with one Avro subject (the lab has no registry on
/// its NATS profile; the codec crate's `registry_lab` covers Confluent's own). Records the paths.
async fn fake_registry() -> (String, std::sync::Arc<std::sync::Mutex<Vec<String>>>) {
    use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
    const SCHEMA: &str = r#"{"type":"record","name":"Order","namespace":"lab","fields":[{"name":"id","type":"string"},{"name":"amount","type":"long"}]}"#;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            let log = log.clone();
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                        match sock.read(&mut chunk).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => buf.extend_from_slice(&chunk[..n]),
                        }
                        continue;
                    };
                    let head = String::from_utf8_lossy(&buf[..end]).into_owned();
                    buf.drain(..end + 4);
                    let path = head
                        .split(' ')
                        .nth(1)
                        .unwrap_or("")
                        .split('?')
                        .next()
                        .unwrap_or("")
                        .to_owned();
                    log.lock().unwrap().push(path.clone());
                    let version = json!({ "subject": "lab-orders-value", "version": 1, "id": 1, "schema": SCHEMA });
                    let (status, body) = match path.as_str() {
                        "/subjects" => (200, json!(["lab-orders-value"])),
                        "/schemas/ids/1" => (200, json!({ "schema": SCHEMA })),
                        "/subjects/lab-orders-value/versions" => (200, json!([1])),
                        "/subjects/lab-orders-value/versions/1"
                        | "/subjects/lab-orders-value/versions/latest" => (200, version),
                        "/mode" => (200, json!({ "mode": "READWRITE" })),
                        "/config" => (200, json!({ "compatibilityLevel": "BACKWARD" })),
                        p if p.starts_with("/schemas/ids/") => (
                            404,
                            json!({ "error_code": 40403, "message": "Schema not found" }),
                        ),
                        _ => (
                            404,
                            json!({ "error_code": 40401, "message": "Subject not found" }),
                        ),
                    };
                    let body = body.to_string();
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-type: application/vnd.schemaregistry.v1+json\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    if sock.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    (url, seen)
}

#[tokio::test]
async fn a_registry_on_the_profile_decodes_the_wire_format_on_listed_subjects_and_through_mappings()
{
    let (url, seen) = fake_registry().await;
    let (_t, mut tab) = setup().await;
    let (name, prefix) = scratch("registry");

    // Test before saving: the subjects, the mode, the compatibility; a wrong draft names its field.
    let registry =
        json!({ "url": url, "auth": "none", "wireFormatSubjects": [format!("{prefix}.wire.>")] });
    let out = call(
        &mut tab,
        2,
        "messaging.registry.test",
        json!({ "registry": registry }),
    )
    .await;
    assert_eq!(
        (
            out["subjects"].as_u64(),
            out["mode"].as_str(),
            out["compatibility"].as_str()
        ),
        (Some(1), Some("READWRITE"), Some("BACKWARD")),
        "{out}"
    );
    tab.call(
        3,
        "messaging.registry.test",
        json!({ "registry": { "url": "https://127.0.0.1:1", "auth": "none" } }),
    )
    .await;
    assert_eq!(
        tab.error(3, Code::InvalidArgument).await.details.unwrap()["field"],
        "schemaRegistry.tls.caPem"
    );
    tab.call(4, "messaging.registry.test", json!({ "registry": { "url": "http://127.0.0.1:1", "auth": "basic", "username": "u", "password": "secret-pw" } })).await;
    let refused = tab.error(4, Code::Unavailable).await;
    assert!(!format!("{refused:?}").contains("secret-pw"));

    // Connect with the registry: the wire format is looked for on <prefix>.wire.> only.
    let mut profile = lab_profile();
    profile["schemaRegistry"] = registry.clone();
    let out = connect(&mut tab, 5, profile).await;
    let conn = s(&out["connId"]).to_owned();
    let status = call(
        &mut tab,
        6,
        "messaging.schemas.status",
        json!({ "connId": conn }),
    )
    .await;
    assert_eq!(
        status["registryUrl"].as_str(),
        Some(url.as_str()),
        "{status}"
    );
    assert_eq!(
        call(
            &mut tab,
            7,
            "messaging.registry.subjects",
            json!({ "connId": conn })
        )
        .await,
        json!(["lab-orders-value"])
    );
    assert_eq!(
        call(
            &mut tab,
            8,
            "messaging.registry.versions",
            json!({ "connId": conn, "subject": "lab-orders-value" })
        )
        .await,
        json!([1])
    );
    call(
        &mut tab,
        9,
        "nats.js.streams.create",
        json!({ "connId": conn, "config": stream_form(&name, &[format!("{prefix}.>")]) }),
    )
    .await;

    // The same wire-format bytes on a listed subject and elsewhere, and raw Avro bytes.
    let order = r#"{"id":"o-1","amount":1990}"#;
    let avro = |wire: &str| json!({ "codec": "avro", "text": order, "schema": { "registry": { "id": 1 } }, "wireFormat": wire });
    for (id, subject, payload) in [
        (10, format!("{prefix}.wire.a"), avro("confluent")),
        (11, format!("{prefix}.other"), avro("confluent")),
        (12, format!("{prefix}.raw"), avro("none")),
    ] {
        call(
            &mut tab,
            id,
            "nats.core.publish",
            json!({ "connId": conn, "subject": subject, "payload": payload }),
        )
        .await;
    }
    let ids_before = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|p| p.starts_with("/schemas/ids/"))
        .count();
    // The stream may take a moment to store the core publishes.
    let mut batches = Vec::new();
    for attempt in 0..20u32 {
        let id = 13 + attempt;
        tab.call(id, "nats.js.streams.browse", json!({ "connId": conn, "streamId": format!("reg-1-{attempt}"), "stream": name, "start": { "from": "first" }, "follow": false })).await;
        batches = read_stream(&mut tab, id).await.0;
        if column(&batches, "payloadCodec").len() == 3 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let codecs = column(&batches, "payloadCodec");
    assert_eq!(
        codecs[0].as_deref(),
        Some("avro"),
        "a listed subject: {codecs:?}"
    );
    assert_eq!(column(&batches, "payloadText")[0].as_deref(), Some(order));
    assert_ne!(
        codecs[1].as_deref(),
        Some("avro"),
        "elsewhere a zero byte is not a schema id: {codecs:?}"
    );
    assert_ne!(codecs[2].as_deref(), Some("avro"));
    // The id was fetched once (at publish) and cached: browsing asked for nothing more.
    assert_eq!(
        seen.lock()
            .unwrap()
            .iter()
            .filter(|p| p.starts_with("/schemas/ids/"))
            .count(),
        ids_before
    );

    // A mapping to the registry subject decodes the raw bytes; tested before saving.
    let raw = json!({ "id": "r1", "target": { "kind": "subject", "pattern": format!("{prefix}.raw") }, "part": "value",
                      "codec": "avro", "registry": { "subject": "lab-orders-value", "version": "latest" } });
    let out = call(
        &mut tab,
        40,
        "nats.schemas.test",
        json!({ "connId": conn, "mapping": raw }),
    )
    .await;
    assert_eq!(
        (out["decoded"].as_u64(), out["failed"].as_u64()),
        (Some(1), Some(0)),
        "{out}"
    );
    assert_eq!(out["rows"][0]["text"], order);
    // The id in each message: a `confluent` mapping without a schema on the other subject.
    let by_id = json!({ "id": "w1", "target": { "kind": "subject", "pattern": format!("{prefix}.other") }, "part": "value", "codec": "avro", "wireFormat": "confluent" });
    let out = call(
        &mut tab,
        41,
        "nats.schemas.test",
        json!({ "connId": conn, "mapping": by_id }),
    )
    .await;
    assert_eq!(out["rows"][0]["text"], order, "{out}");
    // A subject the registry does not know: the reason, per row.
    let missing = json!({ "id": "x", "target": { "kind": "subject", "pattern": format!("{prefix}.raw") }, "part": "value", "codec": "avro", "registry": { "subject": "nope-value", "version": 1 } });
    let out = call(
        &mut tab,
        42,
        "nats.schemas.test",
        json!({ "connId": conn, "mapping": missing }),
    )
    .await;
    assert!(
        s(&out["rows"][0]["error"]).contains("Subject not found"),
        "{out}"
    );

    // Saved, both mappings decode the browse and count.
    let mut mappings = lab_profile()["mappings"].clone();
    mappings
        .as_array_mut()
        .unwrap()
        .splice(0..0, [raw.clone(), by_id.clone()]);
    call(
        &mut tab,
        43,
        "messaging.schemas.update",
        json!({ "connId": conn, "schemas": lab_profile()["schemas"], "mappings": mappings }),
    )
    .await;
    tab.call(44, "nats.js.streams.browse", json!({ "connId": conn, "streamId": "reg-2", "stream": name, "start": { "from": "first" }, "follow": false })).await;
    let (batches, _) = read_stream(&mut tab, 44).await;
    assert_eq!(
        column(&batches, "payloadCodec"),
        vec![Some("avro".to_owned()); 3]
    );
    let status = call(
        &mut tab,
        45,
        "messaging.schemas.status",
        json!({ "connId": conn }),
    )
    .await;
    assert_eq!(
        status["mappings"][0],
        json!({ "id": "r1", "count": { "decoded": 1, "failed": 0 } }),
        "{status}"
    );
    assert_eq!(
        status["mappings"][1],
        json!({ "id": "w1", "count": { "decoded": 1, "failed": 0 } }),
        "{status}"
    );
    assert_eq!(
        status["registryUrl"].as_str(),
        Some(url.as_str()),
        "the update keeps the registry"
    );

    // Removed from the connection: the mappings that need it say so; the counts stay.
    call(
        &mut tab,
        46,
        "messaging.registry.set",
        json!({ "connId": conn, "registry": null }),
    )
    .await;
    let status = call(
        &mut tab,
        47,
        "messaging.schemas.status",
        json!({ "connId": conn }),
    )
    .await;
    assert!(status.get("registryUrl").is_none(), "{status}");
    assert_eq!(status["mappings"][0]["count"]["decoded"], 1);
    let out = call(
        &mut tab,
        48,
        "nats.schemas.test",
        json!({ "connId": conn, "mapping": raw }),
    )
    .await;
    assert!(
        s(&out["rows"][0]["error"]).contains("no Schema Registry"),
        "{out}"
    );
    tab.call(49, "messaging.registry.subjects", json!({ "connId": conn }))
        .await;
    tab.error(49, Code::InvalidArgument).await;
    call(
        &mut tab,
        50,
        "nats.js.streams.delete",
        json!({ "connId": conn, "stream": name }),
    )
    .await;
}

/// DOC-25 §6, Audit (TSK-137): a connect, a write, a destroy and a download (a sensitive read)
/// on the lab's NATS each leave their entries in the durable log, which verifies and holds no
/// credential and no object bytes.
#[tokio::test]
async fn a_connect_a_write_a_destroy_and_a_download_are_recorded_in_the_audit_log() {
    use audit_jsonl::{read_records, verify};
    use mightyconsole_server::StartOptions;
    use mightyconsole_server::audit::log_path;
    use security_types::{AuditDecision, Outcome, Risk};

    let t = start_with_durable_audit(StartOptions::default()).await;
    let path = log_path(t._dir.path());
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let profile = lab_profile();
    let password = s(&profile["password"]).to_owned();
    let out = connect(&mut tab, 2, profile).await;
    let conn = s(&out["connId"]).to_owned();
    let bucket = format!("mc_audit_{}", std::process::id());
    call(
        &mut tab,
        3,
        "nats.kv.buckets.create",
        json!({ "connId": conn, "config": { "bucket": bucket, "history": 1, "storage": "memory", "replicas": 1, "compression": false } }),
    )
    .await;
    call(
        &mut tab,
        4,
        "nats.kv.buckets.delete",
        json!({ "connId": conn, "bucket": bucket }),
    )
    .await;
    tab.call(
        5,
        "nats.obj.get",
        json!({ "connId": conn, "bucket": "files", "name": "readme.txt" }),
    )
    .await;
    let (bytes, _) = download(&mut tab, 5).await;
    assert_eq!(bytes.len(), 32);
    // An ordinary read is not recorded.
    call(
        &mut tab,
        6,
        "nats.obj.info",
        json!({ "connId": conn, "bucket": "files", "name": "readme.txt" }),
    )
    .await;
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();

    let report = verify(&path).expect("the log verifies");
    assert!(report.unfinished.is_empty(), "{:?}", report.unfinished);
    let records = read_records(&path).unwrap();
    let done = |name: &str| {
        records
            .iter()
            .map(|r| &r.entry)
            .find(|e| e.action.name == name && e.outcome == Outcome::Success)
            .unwrap_or_else(|| panic!("no completed {name} in the log"))
    };
    assert_eq!(done("nats.connect").risk, Risk::Read);
    assert_eq!(done("nats.kv.buckets.create").risk, Risk::Write);
    assert_eq!(done("nats.kv.buckets.delete").risk, Risk::Destructive);
    assert_eq!(done("nats.obj.get").risk, Risk::Read);
    for name in ["nats.connect", "nats.kv.buckets.delete", "nats.obj.get"] {
        let admission = records
            .iter()
            .map(|r| &r.entry)
            .find(|e| e.action.name == name && e.outcome == Outcome::Started)
            .unwrap_or_else(|| panic!("no admission for {name}"));
        assert_eq!(admission.decision, AuditDecision::Allow);
        assert!(!admission.principal_chain.is_empty());
    }
    assert!(
        !records
            .iter()
            .any(|r| r.entry.action.name == "nats.obj.info"),
        "an ordinary read is not recorded"
    );
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains(&password), "a credential reached the log");
}
