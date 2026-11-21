//! External Storage against the lab (TSK-103): the worker stores payloads of 256 KiB or more in the
//! lab's S3 store (SeaweedFS) through the SDK's S3 driver; Mightyconsole reads them back with the
//! profile's credentials, and writes a large input when the credentials may.
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_extstore_tests
//! ```

use std::path::PathBuf;
use std::time::Duration;

use serde_json::{Value, json};

use super::client::{self, TemporalClient};
use super::detail::{self, raw_event};
use super::start;
use super::types::ConnectTemporalProfile;
use crate::core::ToolErrorKind;

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn s3() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up temporal` first");
    serde_json::from_str::<Value>(&text).unwrap()["temporal"]["externalStorage"].clone()
}

/// The lab profile; with External Storage when `keys` gives the identity (`None`: without).
async fn lab(keys: Option<&Value>) -> TemporalClient {
    let s3 = s3();
    let mut profile = json!({ "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab" });
    if let Some(keys) = keys {
        profile["externalStorage"] = json!({
            "enabled": true,
            "bucket": s3["bucket"],
            "endpoint": s3["endpoint"],
            "region": s3["region"],
            "pathStyle": true,
        });
        profile["s3AccessKeyId"] = keys["accessKeyId"].clone();
        profile["s3SecretAccessKey"] = keys["secretAccessKey"].clone();
    }
    let profile: ConnectTemporalProfile = serde_json::from_value(profile).unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

async fn first_event(
    client: &TemporalClient,
    workflow_id: &str,
) -> super::detail_types::HistoryEvent {
    let history = detail::history(
        client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "workflowId": workflow_id, "pageSize": 1 }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    history.events.into_iter().next().expect("a first event")
}

/// A value as the UI reads it: a `$large` stub (over 64 KiB of JSON, TSK-92) is read from the
/// connection's store.
fn resolved(client: &TemporalClient, v: &Value) -> Value {
    match v.get("$large") {
        Some(stub) => client
            .large
            .require(stub["id"].as_str().unwrap())
            .unwrap()
            .value
            .clone(),
        None => v.clone(),
    }
}

#[tokio::test]
async fn a_stored_input_is_read_back_with_the_profiles_credentials() {
    let client = lab(Some(&s3())).await;
    let started = first_event(&client, "big-payload-1").await;
    // 300 KiB: kept on the server, sent as a stub (TSK-92).
    let stub = &started.attributes["input"][0]["$large"];
    assert_eq!(stub["encoding"], "json/plain", "{stub}");
    let input = &resolved(&client, &started.attributes["input"][0]);
    assert_eq!(input["kind"], "big");
    assert_eq!(input["text"].as_str().unwrap().len(), 300 * 1024);
    assert_eq!(
        started.encodings.as_deref(),
        Some(&["json/plain via aws.s3driver".to_owned()][..])
    );
}

#[tokio::test]
async fn without_external_storage_the_reference_says_where_it_is() {
    let client = lab(None).await;
    let started = first_event(&client, "big-payload-1").await;
    let external = &started.attributes["input"][0]["$external"];
    assert_eq!(external["driver"], "aws.s3driver");
    assert_eq!(external["bucket"], "temporal-payloads");
    assert!(
        external["key"]
            .as_str()
            .unwrap()
            .starts_with("v0/ns/lab/wt/BigPayload/wi/big-payload-1/")
    );
    assert!(
        external["error"]
            .as_str()
            .unwrap()
            .contains("set up External Storage")
    );
}

#[tokio::test]
async fn a_large_input_is_stored_outside_and_the_worker_reads_it() {
    let client = lab(Some(&s3())).await;
    let id = format!("extstore-start-{}", std::process::id());
    let text = "y".repeat(300 * 1024);
    start::start(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": id, "workflowType": "BigPayload", "taskQueue": "lab", "args": [{ "text": text }] })).unwrap(),
    )
    .await
    .unwrap();
    // As stored: a reference under the driver's context-free key.
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
    let payload = &raw["attributes"]["input"]["payloads"][0];
    let text = |v: &Value| {
        use base64::Engine as _;
        String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(v.as_str().unwrap())
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(
        text(&payload["metadata"]["messageType"]),
        "temporal.api.sdk.v1.ExternalStorageReference"
    );
    let reference: Value = serde_json::from_str(&text(&payload["data"])).unwrap();
    assert_eq!(reference["driverName"], "aws.s3driver");
    assert!(
        reference["claimData"]["key"]
            .as_str()
            .unwrap()
            .starts_with("v0/d/sha256/"),
        "{reference}"
    );
    assert_eq!(
        payload["externalPayloads"][0]["sizeBytes"]
            .as_i64()
            .map(|n| n > 300 * 1024),
        Some(true)
    );
    // The worker read it (the SDK's driver, from the same store) and answered with its length.
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
            result = resolved(&client, &done.attributes["result"][0]);
            break;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    assert_eq!(result["received"], 300 * 1024, "{result}");
    assert_eq!(result["echo"].as_str().map(str::len), Some(300 * 1024));
}

#[tokio::test]
async fn read_only_credentials_cannot_store_an_input() {
    let s3 = s3();
    let client = lab(Some(&s3["readOnly"])).await;
    // Reading works.
    let started = first_event(&client, "big-payload-1").await;
    assert_eq!(
        resolved(&client, &started.attributes["input"][0])["kind"],
        "big"
    );
    // Writing is refused by the store, and nothing is sent inline.
    let id = format!("extstore-ro-{}", std::process::id());
    let e = start::start(
        &client,
        serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": id, "workflowType": "BigPayload", "taskQueue": "lab", "args": [{ "text": "z".repeat(300 * 1024) }] })).unwrap(),
    )
    .await
    .unwrap_err();
    assert_eq!(e.kind, ToolErrorKind::Forbidden, "{}", e.message);
    assert!(e.message.contains("External Storage"), "{}", e.message);
}
