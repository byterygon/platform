//! The profile's payload codec against the lab (TSK-92, spec §9.5): the lab's AES-GCM codec
//! server (`temporal-codec`, Temporal's codec-server protocol) and `encrypted-1`, whose payloads
//! the lab worker stores encrypted.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_payload_codec_tests
//! ```

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use super::client::{self, TemporalClient};
use super::detail::{self, raw_event};
use super::start;
use super::types::ConnectTemporalProfile;

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn codec() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up temporal` first");
    serde_json::from_str::<Value>(&text).unwrap()["temporal"]["codec"].clone()
}

fn profile(codec_settings: Option<Value>, authorization: Option<&str>) -> Value {
    let mut p = json!({ "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab" });
    if let Some(c) = codec_settings {
        p["codec"] = c;
    }
    if let Some(a) = authorization {
        p["codecAuthorization"] = json!(a);
    }
    p
}

async fn lab(p: Value) -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(p).unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

async fn with_codec() -> TemporalClient {
    let c = codec();
    lab(profile(
        Some(json!({ "enabled": true, "endpoint": c["endpoint"] })),
        c["authorization"].as_str(),
    ))
    .await
}

async fn first_event(
    client: &TemporalClient,
    workflow_id: &str,
) -> super::detail_types::HistoryEvent {
    detail::history(
        client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "workflowId": workflow_id, "pageSize": 1 }),
        )
        .unwrap(),
    )
    .await
    .unwrap()
    .events
    .into_iter()
    .next()
    .expect("a first event")
}

#[tokio::test]
async fn encrypted_payloads_are_decoded_through_the_codec_and_labelled() {
    let client = with_codec().await;
    let started = first_event(&client, "encrypted-1").await;
    assert_eq!(started.attributes["input"][0]["card"], "4111111111111111");
    assert_eq!(started.attributes["input"][0]["amount"], 42);
    assert_eq!(
        started.encodings.as_deref(),
        Some(&["binary/encrypted → json/plain".to_owned()][..])
    );
}

#[tokio::test]
async fn without_the_codec_they_show_as_stored() {
    let client = lab(profile(None, None)).await;
    let started = first_event(&client, "encrypted-1").await;
    assert_eq!(
        started.attributes["input"][0]["$opaque"],
        "binary/encrypted"
    );
}

#[tokio::test]
async fn a_refusing_codec_leaves_them_as_stored_and_says_why() {
    let c = codec();
    let client = lab(profile(
        Some(json!({ "enabled": true, "endpoint": c["endpoint"] })),
        Some("Bearer wrong"),
    ))
    .await;
    let started = first_event(&client, "encrypted-1").await;
    let input = &started.attributes["input"][0];
    assert_eq!(input["$opaque"], "binary/encrypted");
    assert!(
        input["codecError"].as_str().unwrap().contains("401"),
        "{input}"
    );
    assert!(input["note"].as_str().unwrap().starts_with("Codec failed:"));
    // Nothing else on the screen fails: plain payloads still read.
    let plain = first_event(&client, "completed-1").await;
    assert_eq!(plain.attributes["input"][0], "ord-done");
}

#[tokio::test]
async fn inputs_are_encoded_and_the_worker_reads_them() {
    let client = with_codec().await;
    let c = codec();
    let id = format!("codec-start-{}", std::process::id());
    start::start(&client, serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": id, "workflowType": "Encrypted", "taskQueue": c["taskQueue"], "args": [{ "card": "5500000000000004", "amount": 7 }] })).unwrap())
        .await
        .unwrap();
    // As stored: encrypted.
    let raw = raw_event(
        &client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "workflowId": id, "eventId": 1 }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let raw = serde_json::to_value(&raw).unwrap();
    let encoding = raw["attributes"]["input"]["payloads"][0]["metadata"]["encoding"]
        .as_str()
        .unwrap();
    assert_eq!(BASE64.decode(encoding).unwrap(), b"binary/encrypted");
    // The worker (the SDK's codec, the same key) read it and answered.
    let mut result = Value::Null;
    for _ in 0..60 {
        let history = detail::history(
            &client,
            serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": id }))
                .unwrap(),
        )
        .await
        .unwrap();
        if let Some(done) = history
            .events
            .iter()
            .find(|e| e.event_type == "WorkflowExecutionCompleted")
        {
            result = done.attributes["result"][0].clone();
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(result, json!({ "charged": 7, "card": "****0004" }));
}

#[tokio::test]
async fn an_encode_failure_fails_the_action() {
    let c = codec();
    let client = lab(profile(
        Some(json!({ "enabled": true, "endpoint": c["endpoint"] })),
        Some("Bearer wrong"),
    ))
    .await;
    let e = start::start(&client, serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": format!("codec-refused-{}", std::process::id()), "workflowType": "Encrypted", "taskQueue": c["taskQueue"], "args": [{ "amount": 1 }] })).unwrap())
        .await
        .unwrap_err();
    assert!(e.message.contains("nothing was sent"), "{}", e.message);
}

#[tokio::test]
async fn test_codec_reports_the_sample() {
    let c = codec();
    let input: super::types::TemporalTestCodecInput = serde_json::from_value(json!({ "profile": profile(Some(json!({ "enabled": true, "endpoint": c["endpoint"] })), c["authorization"].as_str()) })).unwrap();
    let report = super::codec_client::test(&input).await.unwrap();
    assert_eq!(report.namespace, "lab");
    assert_eq!(report.codec, "127.0.0.1:8234");
    assert!(report.sampled >= 1, "{report:?}");
    assert!(report.error.is_none(), "{report:?}");
}
