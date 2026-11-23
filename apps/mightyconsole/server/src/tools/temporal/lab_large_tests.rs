//! Large payloads against the lab (TSK-92, spec §9.3 "Large payload", §18): `large-1`'s input is
//! about 1.5 MiB of JSON in the history itself (12,480 inventory lines, every 40th out of stock).
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_large_tests
//! ```

use serde_json::{Value, json};

use super::client::{self, TemporalClient};
use super::detail;
use super::detail_types::HistoryEvent;
use super::large::{self, PayloadForm, PayloadKind, PayloadNodeInput, PayloadQueryInput};
use super::types::ConnectTemporalProfile;

async fn lab() -> TemporalClient {
    let profile: ConnectTemporalProfile = serde_json::from_value(
        json!({ "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab" }),
    )
    .unwrap();
    client::connect(&profile)
        .await
        .expect("the lab's Temporal is up: `lab up temporal`")
}

async fn started(client: &TemporalClient, workflow_id: &str) -> HistoryEvent {
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

/// `large-1`'s input stub and its id.
async fn stub(client: &TemporalClient) -> (Value, String) {
    let event = started(client, "large-1").await;
    let stub = event.attributes["input"][0]["$large"].clone();
    let id = stub["id"].as_str().expect("a $large stub").to_owned();
    (stub, id)
}

fn node(client: &TemporalClient, id: &str, path: &str, offset: Option<u32>) -> large::PayloadNode {
    large::node(
        &client.large,
        &PayloadNodeInput {
            conn_id: String::new(),
            payload_id: id.to_owned(),
            path: Some(path.to_owned()),
            offset,
            limit: None,
        },
    )
    .unwrap()
}

#[tokio::test]
async fn a_large_input_comes_as_a_stub_with_its_sizes_and_the_event_its_size() {
    let client = lab().await;
    let event = started(&client, "large-1").await;
    let stub = &event.attributes["input"][0]["$large"];
    let bytes = stub["bytes"].as_u64().unwrap();
    assert!(bytes > 1024 * 1024 && bytes < 2 * 1024 * 1024, "{bytes}");
    assert_eq!(stub["encoding"], "json/plain");
    assert!(stub["decodedBytes"].as_u64().unwrap() >= bytes - 64);
    let preview = stub["preview"].as_str().unwrap();
    assert!(
        preview.len() <= 64 * 1024 && preview.starts_with('{'),
        "{}",
        preview.len()
    );
    assert!(event.size > bytes, "{} vs {bytes}", event.size);
    // Reading it again keeps one copy.
    let (_, again) = self::stub(&client).await;
    assert_eq!(again, stub["id"].as_str().unwrap());
    assert!(client.large.bytes() < 2 * 1024 * 1024);
    // The workflow's facts: the history's size.
    let described = detail::describe(
        &client,
        serde_json::from_value(
            json!({ "connId": "", "namespace": "lab", "workflowId": "large-1" }),
        )
        .unwrap(),
    )
    .await
    .unwrap();
    assert!(described.history_size_bytes as u64 > bytes);
}

#[tokio::test]
async fn small_payloads_stay_inline() {
    let client = lab().await;
    assert_eq!(
        started(&client, "completed-1").await.attributes["input"],
        json!(["ord-done"])
    );
}

#[tokio::test]
async fn its_nodes_load_one_at_a_time_and_an_array_of_thousands_pages() {
    let client = lab().await;
    let (_, id) = stub(&client).await;
    let root = node(&client, &id, "", None);
    assert_eq!(root.kind, PayloadKind::Object);
    let items = root.children.iter().find(|c| c.key == "items").unwrap();
    assert_eq!(items.length, Some(12_480));
    let info = root.info.unwrap();
    assert_eq!(info.largest_arrays[0].path, "/items");
    assert_eq!(info.largest_arrays[0].length, 12_480);
    let page = node(&client, &id, "/items", Some(12_450));
    assert_eq!(page.total, 12_480);
    assert_eq!(page.children.len(), 30);
    assert_eq!(page.children[0].path, "/items/12450");
    let sku = node(&client, &id, "/items/12450/sku", None);
    assert_eq!(sku.value, Some(json!("A-12450")));
}

#[tokio::test]
async fn jq_runs_on_the_server() {
    let client = lab().await;
    let (_, id) = stub(&client).await;
    let out = large::query(
        &client.large,
        PayloadQueryInput {
            conn_id: String::new(),
            payload_id: id,
            jq: ".items | map(select(.qty == 0)) | length".into(),
            timeout_ms: Some(10_000),
        },
    )
    .await
    .unwrap();
    assert_eq!(out.results, vec![json!(312)]);
}

#[tokio::test]
async fn both_forms_download() {
    let client = lab().await;
    let (stub, id) = stub(&client).await;
    let kept = client.large.require(&id).unwrap();
    let stored = large::download_bytes(&kept, PayloadForm::Stored);
    assert_eq!(stored.len() as u64, stub["bytes"].as_u64().unwrap());
    let decoded: Value =
        serde_json::from_slice(&large::download_bytes(&kept, PayloadForm::Decoded)).unwrap();
    assert_eq!(decoded["items"].as_array().unwrap().len(), 12_480);
    assert_eq!(serde_json::from_slice::<Value>(&stored).unwrap(), decoded);
}
