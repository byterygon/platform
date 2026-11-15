//! The desktop shell on Tauri's mock runtime (DBee spec §14): the app as `main.rs` builds it,
//! with the core on a temporary workspace and an in-memory keychain, driven through Tauri's real
//! IPC and ACL layer. No window process, no display, no port.
//!
//! Also pins the shipped configuration: the capability grants the IPC to the `main` window only
//! with local content, the CSP is `ambidex_tauri::CSP` verbatim, no `devUrl`, no global Tauri
//! object.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ambidex::Kind;
use ambidex_conformance::client::{Client, LocalBoxFuture, Wire, json_frame};
use ambidex_conformance::tauri::{LOCAL_URL, connect, invoke, send};
use ambidex_tauri::{HubState, IpcError, LocalIdentity};
use dbee_core::SecretStoreConfig;
use dbee_core::api::SaveDialog;
use dbee_core::authz::LOCAL_TENANT;
use dbee_core::secrets::{MemorySecretStore, SecretStore};
use dbee_core::types::FileFilter;
use dbee_desktop::{Desktop, MAIN_WINDOW};
use security_types::{BoxFuture, TenantId};
use serde_json::{Value, json};
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, InvokeResponseBody};
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};
use tauri::utils::acl::ExecutionContext;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::mpsc;

const OS_USER: &str = "alice";

type Channels = Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>>;

/// A save dialog that answers with a fixed path, or cancels, and records what it was asked.
#[derive(Default)]
struct FakeDialog {
    answer: Mutex<Option<PathBuf>>,
    asked: Mutex<Vec<(String, Vec<FileFilter>)>>,
}

impl SaveDialog for FakeDialog {
    fn choose(
        &self,
        suggested_name: String,
        filters: Vec<FileFilter>,
    ) -> BoxFuture<'static, Option<PathBuf>> {
        self.asked.lock().unwrap().push((suggested_name, filters));
        let answer = self.answer.lock().unwrap().clone();
        Box::pin(async move { answer })
    }
}

struct TestApp {
    app: App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    channels: Channels,
    next_channel: AtomicU32,
    dialog: Arc<FakeDialog>,
    _dir: tempfile::TempDir,
}

async fn start() -> TestApp {
    let dir = tempfile::tempdir().unwrap();
    let identity =
        LocalIdentity::new(OS_USER, TenantId::new(LOCAL_TENANT), vec![]).expect("valid OS user");
    let keychain = Arc::new(MemorySecretStore::new());
    let desktop = Desktop::start(
        dir.path().join("workspace"),
        identity,
        Instant::now(),
        |c| {
            c.secret_store = SecretStoreConfig::Store(keychain as Arc<dyn SecretStore>);
        },
    )
    .await
    .expect("core starts");
    let dialog = Arc::new(FakeDialog::default());
    desktop
        .dialog()
        .attach(Arc::clone(&dialog) as Arc<dyn SaveDialog>);

    // The capability of `capabilities/main.json`, as the mock runtime expresses it.
    let mut context = mock_context(noop_assets());
    for command in ["connect", "send", "close"] {
        context
            .runtime_authority_mut()
            .__allow_command(format!("plugin:ambidex|{command}"), ExecutionContext::Local);
    }
    let channels = Channels::default();
    let interceptor_channels = Arc::clone(&channels);
    let app = desktop
        .configure(
            mock_builder().channel_interceptor(move |_webview, callback, _index, body| {
                if let InvokeResponseBody::Raw(bytes) = body
                    && let Some(frames) = interceptor_channels.lock().unwrap().get(&callback.0)
                {
                    let _ = frames.send(bytes.clone());
                }
                true
            }),
        )
        .build(context)
        .expect("app builds");
    let window = WebviewWindowBuilder::new(&app, MAIN_WINDOW, Default::default())
        .build()
        .expect("main window");
    TestApp {
        app,
        window,
        channels,
        next_channel: AtomicU32::new(1),
        dialog,
        _dir: dir,
    }
}

impl TestApp {
    /// A connection through `plugin:ambidex|connect` and the Hello of the DBee API.
    async fn client(&self) -> Client {
        let channel = self.next_channel.fetch_add(1, Ordering::SeqCst);
        let (tx, frames) = mpsc::unbounded_channel();
        self.channels.lock().unwrap().insert(channel, tx);
        let id = connect(&self.window, LOCAL_URL, channel)
            .await
            .expect("connect accepted");
        let mut client = Client::new(
            Box::new(TauriWire {
                window: self.window.clone(),
                hub: Arc::clone(&self.app.state::<HubState>().0),
                id,
                frames,
            }),
            None,
        );
        client
            .send(&[json_frame(
                Kind::Hello,
                0,
                &json!({
                    "protocol": 1,
                    "api": dbee_core::API_NAME,
                    "schema_hash": dbee_core::SCHEMA_HASH.as_str(),
                    "client_version": "dbee-desktop-tests",
                }),
            )])
            .await;
        let frame = client.recv().await.expect("HelloAck");
        assert_eq!(
            frame.kind,
            Kind::HelloAck,
            "{}",
            String::from_utf8_lossy(&frame.payload)
        );
        client
    }
}

struct TauriWire {
    window: WebviewWindow<MockRuntime>,
    hub: Arc<ambidex_tauri::Hub>,
    id: String,
    frames: mpsc::UnboundedReceiver<Vec<u8>>,
}

impl Wire for TauriWire {
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, io::Result<()>> {
        Box::pin(async {
            send(&self.window, &self.id, bytes)
                .await
                .map_err(|e| io::Error::new(io::ErrorKind::BrokenPipe, e.to_string()))
        })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>> {
        Box::pin(async {
            loop {
                if let Ok(Some(bytes)) =
                    tokio::time::timeout(Duration::from_millis(5), self.frames.recv()).await
                {
                    return Some(bytes);
                }
                let probe = self.hub.send(MAIN_WINDOW, &self.id, Vec::new());
                if matches!(
                    tokio::time::timeout(Duration::from_millis(5), probe).await,
                    Ok(Err(IpcError::UnknownConnection | IpcError::SessionExpired))
                ) {
                    return self.frames.try_recv().ok();
                }
            }
        })
    }

    fn close(&mut self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async {
            let body = InvokeBody::Json(json!({ "connection": self.id }));
            let _ = invoke(&self.window, "close", LOCAL_URL, body, HeaderMap::new()).await;
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_main_window_talks_to_the_core_as_the_local_human() {
    let t = start().await;
    let mut client = t.client().await;

    client.call(1, "app.info", json!({})).await;
    let info = client.expect_result(1).await;
    assert_eq!(info["mode"], "standalone", "{info}");
    assert_eq!(info["schemaHash"], dbee_core::SCHEMA_HASH.as_str());
    assert_eq!(info["secretStore"], "keychain");
    assert_eq!(info["platform"], std::env::consts::OS);
    assert_eq!(info["drivers"][0]["id"], "com.byterygon.dbee.postgres");

    client.call(2, "connections.list", json!({})).await;
    assert_eq!(client.expect_result(2).await, json!([]));

    // The audit entries name the local human the plugin built from the OS user.
    let log = PathBuf::from(info["auditLogPath"].as_str().unwrap());
    let records = dbee_core::audit::read_records(&log).unwrap();
    let info_entry = records
        .iter()
        .find(|r| r.entry.action.name == "app.info")
        .expect("app.info audited");
    assert_eq!(
        info_entry.entry.principal_chain[0].id,
        format!("human:local:{OS_USER}")
    );

    // A second window gets no connection: the hub allows the main webview only.
    let other = WebviewWindowBuilder::new(&t.app, "other", Default::default())
        .build()
        .unwrap();
    let refused = connect(&other, LOCAL_URL, 99).await;
    assert!(refused.is_err(), "{refused:?}");
    client.disconnect().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn choose_save_path_goes_through_the_core_and_the_native_dialog() {
    let t = start().await;
    let mut client = t.client().await;

    // Cancelled: null, nothing kept.
    client
        .call(
            1,
            "files.chooseSavePath",
            json!({ "suggestedName": "rows.csv", "filters": [{ "name": "CSV", "extensions": ["csv"] }] }),
        )
        .await;
    assert_eq!(client.expect_result(1).await, Value::Null);

    // Chosen: the webview gets a one-time handle and the display name, never the path.
    let chosen = t._dir.path().join("exports").join("rows.csv");
    *t.dialog.answer.lock().unwrap() = Some(chosen.clone());
    client
        .call(
            2,
            "files.chooseSavePath",
            json!({ "suggestedName": "rows.csv" }),
        )
        .await;
    let result = client.expect_result(2).await;
    assert_eq!(result["displayName"], "rows.csv", "{result}");
    assert!(result["handle"].as_str().is_some_and(|h| h.len() >= 32));
    assert!(!result.to_string().contains("exports"));
    {
        let asked = t.dialog.asked.lock().unwrap();
        assert_eq!(asked.len(), 2);
        assert_eq!(asked[0].0, "rows.csv");
        assert_eq!(asked[0].1[0].extensions, vec!["csv".to_owned()]);
        assert!(asked[1].1.is_empty());
    }

    // The handle is resolved by the core (export.run with a file destination): an unknown or
    // used handle is refused. There is no session to export from here, so the handle check is
    // what this shell adds; the write path is covered by dbee-core's tests.
    client
        .call(
            3,
            "export.run",
            json!({
                "sessionId": "none",
                "sql": "select 1",
                "format": "csv",
                "destination": { "kind": "file", "handle": "not-a-handle" },
            }),
        )
        .await;
    client.expect_code(3, ambidex::Code::InvalidArgument).await;
    client.disconnect().await;
}

fn manifest(path: &str) -> Value {
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    serde_json::from_str(&std::fs::read_to_string(&file).unwrap())
        .unwrap_or_else(|e| panic!("{}: {e}", file.display()))
}

#[test]
fn the_capability_grants_the_ipc_to_the_main_window_only() {
    let capability = manifest("capabilities/main.json");
    assert_eq!(capability["identifier"], "main");
    assert_eq!(capability["local"], true);
    assert_eq!(capability["windows"], json!([MAIN_WINDOW]));
    assert_eq!(capability["permissions"], json!(["ambidex:default"]));
    assert!(capability.get("remote").is_none(), "{capability}");
    assert!(capability.get("webviews").is_none(), "{capability}");
}

#[test]
fn the_config_has_the_strict_csp_no_dev_url_and_one_window() {
    let config = manifest("tauri.conf.json");
    assert_eq!(config["app"]["security"]["csp"], ambidex_tauri::CSP);
    assert_eq!(config["app"]["security"]["capabilities"], json!(["main"]));
    assert_eq!(config["app"]["withGlobalTauri"], false);
    assert!(config["build"].get("devUrl").is_none(), "{config}");
    assert!(config["build"]["frontendDist"].is_string());
    let windows = config["app"]["windows"].as_array().unwrap();
    assert_eq!(windows.len(), 1);
    assert_eq!(windows[0]["label"], MAIN_WINDOW);
    assert!(windows[0].get("url").is_none(), "bundled index.html only");
    // The policy itself: nothing remote, the IPC origins only, a worker from the bundle.
    let csp = ambidex_tauri::CSP;
    assert!(csp.contains("connect-src ipc: http://ipc.localhost;"));
    assert!(csp.contains("worker-src 'self';"));
    assert!(!csp.contains("https:") && !csp.contains("wss:"));
    assert_eq!(config["identifier"], "com.byterygon.dbee");
}
