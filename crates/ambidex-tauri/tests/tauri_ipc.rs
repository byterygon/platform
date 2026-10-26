//! The plugin's commands through Tauri's IPC layer, on the mock runtime.
//!
//! The ACL grants the plugin's commands to local content only, as the recommended capability does
//! (no `remote` section). Server frames are captured with a channel interceptor, which sees
//! exactly what the webview would receive.

mod common;

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::frame::Kind;
use ambidex_tauri::{Builder, CONNECTION_HEADER, HubConfig, HubState};
use common::{Frames, WhoAmI, call, hello, identity, payload, server_config};
use serde_json::json;
use tauri::http::HeaderMap;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};

const LOCAL_URL: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

/// Raw channel messages by channel id.
type Captured = Arc<Mutex<Vec<(u32, Vec<u8>)>>>;

fn app(captured: Captured, notify: mpsc::Sender<()>) -> App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    for command in ["connect", "send", "close"] {
        context
            .runtime_authority_mut()
            .__allow_command(format!("plugin:ambidex|{command}"), ExecutionContext::Local);
    }
    let notify = Mutex::new(notify);
    mock_builder()
        .channel_interceptor(move |_webview, callback, _index, body| {
            if let InvokeResponseBody::Raw(bytes) = body {
                captured.lock().unwrap().push((callback.0, bytes.clone()));
                let _ = notify.lock().unwrap().send(());
            }
            true
        })
        .plugin(
            Builder::new(identity(), server_config(), WhoAmI)
                .hub_config(HubConfig::default())
                .build(),
        )
        .build(context)
        .unwrap()
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .unwrap()
}

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    url: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<InvokeResponseBody, serde_json::Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: format!("plugin:ambidex|{cmd}"),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.parse().unwrap(),
            body,
            headers,
            invoke_key: INVOKE_KEY.to_string(),
        },
    )
}

fn connect(window: &WebviewWindow<MockRuntime>, channel: u32) -> Result<String, serde_json::Value> {
    invoke(
        window,
        "connect",
        LOCAL_URL,
        InvokeBody::Json(json!({ "onFrame": format!("__CHANNEL__:{channel}") })),
        HeaderMap::new(),
    )
    .map(|body| body.deserialize::<String>().unwrap())
}

fn send(
    window: &WebviewWindow<MockRuntime>,
    connection: &str,
    bytes: Vec<u8>,
) -> Result<InvokeResponseBody, serde_json::Value> {
    let mut headers = HeaderMap::new();
    headers.insert(CONNECTION_HEADER, connection.parse().unwrap());
    invoke(window, "send", LOCAL_URL, InvokeBody::Raw(bytes), headers)
}

/// Waits for the next raw message on `channel` and decodes the frames in it.
fn next_frames(
    captured: &Captured,
    notify: &mpsc::Receiver<()>,
    channel: u32,
    frames: &mut Frames,
) -> Vec<ambidex::Frame> {
    loop {
        let message = {
            let mut captured = captured.lock().unwrap();
            captured
                .iter()
                .position(|(id, _)| *id == channel)
                .map(|i| captured.remove(i).1)
        };
        match message {
            Some(bytes) => return frames.push(&bytes),
            None => notify
                .recv_timeout(Duration::from_secs(5))
                .expect("no channel message"),
        }
    }
}

#[test]
fn frames_round_trip_over_raw_invoke_and_channel() {
    let captured = Captured::default();
    let (notify_tx, notify) = mpsc::channel();
    let app = app(Arc::clone(&captured), notify_tx);
    let main = window(&app, "main");
    let mut frames = Frames::new();

    let id = connect(&main, 7).unwrap();
    send(&main, &id, hello()).unwrap();
    let ack = next_frames(&captured, &notify, 7, &mut frames);
    assert_eq!(ack[0].kind, Kind::HelloAck);

    let hub = &app.state::<HubState>().0;
    let session = hub.session("main").unwrap();
    assert_eq!(payload(&ack[0])["session"], session.id.as_str());

    send(&main, &id, call(1, "whoami")).unwrap();
    let result = next_frames(&captured, &notify, 7, &mut frames);
    assert_eq!((result[0].kind, result[0].call_id), (Kind::Result, 1));
    assert_eq!(payload(&result[0])["principal"], "human:local:alice");

    invoke(
        &main,
        "close",
        LOCAL_URL,
        InvokeBody::Json(json!({ "connection": id })),
        HeaderMap::new(),
    )
    .unwrap();
    assert_eq!(
        send(&main, &id, call(2, "whoami")).unwrap_err(),
        json!("unknown connection")
    );
}

#[test]
fn client_frames_must_be_raw_with_a_connection_header() {
    let (notify_tx, _notify) = mpsc::channel();
    let app = app(Captured::default(), notify_tx);
    let main = window(&app, "main");
    let id = connect(&main, 1).unwrap();

    let mut headers = HeaderMap::new();
    headers.insert(CONNECTION_HEADER, id.parse().unwrap());
    let json_body = InvokeBody::Json(json!([1, 2, 3]));
    assert_eq!(
        invoke(&main, "send", LOCAL_URL, json_body, headers).unwrap_err(),
        json!("bad request")
    );
    assert_eq!(
        invoke(
            &main,
            "send",
            LOCAL_URL,
            InvokeBody::Raw(hello()),
            HeaderMap::new()
        )
        .unwrap_err(),
        json!("bad request")
    );
}

#[test]
fn other_windows_cannot_connect_or_write() {
    let (notify_tx, _notify) = mpsc::channel();
    let app = app(Captured::default(), notify_tx);
    let main = window(&app, "main");
    let other = window(&app, "other");
    let id = connect(&main, 1).unwrap();

    assert_eq!(
        connect(&other, 2).unwrap_err(),
        json!("webview not allowed")
    );
    assert_eq!(
        send(&other, &id, hello()).unwrap_err(),
        json!("unknown connection")
    );
}

#[test]
fn remote_content_gets_no_ipc_access() {
    let (notify_tx, _notify) = mpsc::channel();
    let app = app(Captured::default(), notify_tx);
    let main = window(&app, "main");
    let denied = invoke(
        &main,
        "connect",
        "https://attacker.example",
        InvokeBody::Json(json!({ "onFrame": "__CHANNEL__:1" })),
        HeaderMap::new(),
    );
    assert!(denied.is_err(), "{denied:?}");
    assert!(app.state::<HubState>().0.session("main").is_none());
}
