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
