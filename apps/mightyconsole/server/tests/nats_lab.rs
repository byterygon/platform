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
