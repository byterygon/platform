//! The conformance suite on the Tauri harness, plus the desktop "not reachable" checks.

#![cfg(feature = "tauri")]

use ambidex_conformance::Harness;
use ambidex_conformance::harness::run;
use ambidex_conformance::tauri::{LOCAL_URL, MAIN, Tauri, connect, send};
use serde_json::json;

ambidex_conformance::conformance_suite!(Tauri);

/// Remote content gets no IPC access: the capability grants the plugin to local content only
/// (spec §8). This is the desktop's counterpart of the web Origin check.
#[test]
fn remote_content_cannot_connect() {
    run(async |tauri: &Tauri| {
        let denied = connect(tauri.window(), "https://attacker.example", 1).await;
        assert!(denied.is_err(), "{denied:?}");
        assert!(tauri.hub().session(MAIN).is_none());
    });
}

/// Only allowed webviews connect, and another webview cannot write into main's connection.
#[test]
fn other_webviews_cannot_connect_or_write() {
    run(async |tauri: &Tauri| {
        let mut client = tauri.connect().await;
        client.handshake().await;
        let other = tauri.open_window("other");
        assert_eq!(
            connect(&other, LOCAL_URL, 99).await.unwrap_err(),
            json!("webview not allowed")
        );
        for id in tauri.connection_ids() {
            assert_eq!(
                send(&other, &id, Vec::new()).await.unwrap_err(),
                json!("unknown connection")
            );
        }
        assert_eq!(tauri.fixture().probe.runs(), 0);
        client.expect_alive(0).await;
    });
}

/// A connection closed by the webview is released by the hub.
#[test]
fn closed_connections_are_released() {
    run(async |tauri: &Tauri| {
        let client = tauri.connect().await;
        assert_eq!(tauri.hub().connection_count(MAIN), 1);
        client.disconnect().await;
        assert_eq!(tauri.hub().connection_count(MAIN), 0);
    });
}
