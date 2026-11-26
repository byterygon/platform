//! The `temporal` tool over the wire against the test lab, for what goes through the server's
//! profile store (TSK-139, DOC-25 §3.4.7): a stored profile connects, and its codec server's
//! Authorization (a secret) is opened on the server. The tool's other lab tests call it in-crate
//! (`src/tools/temporal/lab_*_tests.rs`). Needs
//! `pnpm --filter @byterygon/mightyconsole lab up temporal`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test integration temporal_lab::`.
#![cfg(feature = "lab-tests")]

use std::path::PathBuf;

use crate::support::*;
use serde_json::{Value, json};

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

/// The lab's codec server: `endpoint`, `authorization`.
fn codec() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up temporal` first");
    serde_json::from_str::<Value>(&text).unwrap()["temporal"]["codec"].clone()
}

#[tokio::test]
async fn a_stored_temporal_profile_connects_and_its_codec_authorization_stays_on_the_server() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    let c = codec();
    let fields = json!({
        "address": "127.0.0.1:7233",
        "namespace": "lab",
        "codec": { "enabled": true, "endpoint": c["endpoint"] },
    });
    let id = tab
        .store_profile(
            "temporal",
            "lab",
            fields.clone(),
            json!({ "codecAuthorization": c["authorization"] }),
        )
        .await;
    tab.call(2, "temporal.connect", json!({ "profileId": id }))
        .await;
    let out = tab.result(2).await;
    assert!(out["serverVersion"].is_string(), "{out}");
    let conn = out["connId"].as_str().unwrap().to_owned();
    tab.call(3, "temporal.namespaces.list", json!({ "connId": conn }))
        .await;
    tab.result(3).await;

    // Test codec from the form: nothing typed, the stored Authorization decodes the samples.
    tab.call(
        4,
        "temporal.testCodec",
        json!({ "draft": { "fields": fields, "secrets": {} }, "basedOn": id }),
    )
    .await;
    let report = tab.result(4).await;
    assert!(report["sampled"].as_u64().unwrap() >= 1, "{report}");
    assert!(
        !report
            .to_string()
            .contains(c["authorization"].as_str().unwrap()),
        "the Authorization in an answer"
    );
    // Test connection of the draft.
    tab.call(
        6,
        "temporal.test",
        json!({ "draft": { "fields": fields, "secrets": {} }, "basedOn": id }),
    )
    .await;
    tab.result(6).await;
}
