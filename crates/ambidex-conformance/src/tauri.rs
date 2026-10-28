//! Tauri harness: the real `ambidex-tauri` plugin in a Tauri app on the **mock runtime**.
//!
//! Client chunks go through `plugin:ambidex|send` as raw-body invokes, through Tauri's real IPC
//! and ACL layer ([`get_ipc_response`]). Server chunks are taken from the connection's `Channel`
//! by a channel interceptor, which sees exactly the raw `ArrayBuffer` payloads the webview would
//! get. No window, webview process or display is created, and nothing listens on a port. See
//! the crate docs for why the mock runtime was chosen over a headless app.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::frame::Kind;
use ambidex_tauri::{
    Builder, CONNECTION_HEADER, Hub, HubConfig, HubState, IpcError, LocalIdentity,
};
use security_types::{RoleId, TenantId};
use serde_json::{Value, json};
use tauri::http::HeaderMap;
use tauri::ipc::{CallbackFn, InvokeBody, InvokeResponseBody};
use tauri::test::{
    INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets,
};
use tauri::utils::acl::ExecutionContext;
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::mpsc;

use crate::client::{Client, LocalBoxFuture, Wire};
use crate::fixture::{Fixture, server_config};
use crate::harness::{Harness, Unsupported};

/// URL of bundled content, which the capability grants the plugin to.
pub const LOCAL_URL: &str = if cfg!(windows) {
    "http://tauri.localhost"
} else {
    "tauri://localhost"
};

/// The window (and webview) label the plugin allows by default.
pub const MAIN: &str = "main";

/// OS user of the local identity; the principal is `human:local:<os-user>`.
pub const OS_USER: &str = "alice";

/// How often a waiting [`Wire::recv`] checks whether the hub still knows the connection. Only
/// latency depends on it, never an outcome.
const CLOSE_POLL: Duration = Duration::from_millis(5);

/// Raw channel messages by channel id.
type Channels = Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<Vec<u8>>>>>;

pub struct Tauri {
    fixture: Fixture,
    app: App<MockRuntime>,
    window: WebviewWindow<MockRuntime>,
    hub: Arc<Hub>,
    channels: Channels,
    next_channel: AtomicU32,
    /// Every connection id handed out, in order.
    ids: Mutex<Vec<String>>,
    revoked: Arc<AtomicBool>,
}

impl Harness for Tauri {
    const NAME: &'static str = "tauri";

    async fn start(fixture: Fixture) -> Tauri {
        let channels = Channels::default();
        let app = app(&fixture, Arc::clone(&channels));
        let window = window(&app, MAIN);
        let hub = Arc::clone(&app.state::<HubState>().0);
        Tauri {
            fixture,
            app,
            window,
            hub,
            channels,
            next_channel: AtomicU32::new(1),
            ids: Mutex::new(Vec::new()),
            revoked: Arc::new(AtomicBool::new(false)),
        }
    }

    fn fixture(&self) -> &Fixture {
        &self.fixture
    }

    async fn connect(&self) -> Client {
        let channel = self.next_channel.fetch_add(1, Ordering::SeqCst);
        let (frames_tx, frames) = mpsc::unbounded_channel();
        lock(&self.channels).insert(channel, frames_tx);
        let id = connect(&self.window, LOCAL_URL, channel)
            .await
            .expect("connect accepted");
        lock(&self.ids).push(id.clone());
        Client::new(
            Box::new(TauriWire {
                window: self.window.clone(),
                hub: Arc::clone(&self.hub),
                id,
                frames,
                revoked: Arc::clone(&self.revoked),
                saw_goaway: false,
            }),
            None,
        )
    }

    fn principal_id(&self) -> String {
        format!("human:local:{OS_USER}")
    }

    fn revoke_sessions(&self) -> Result<(), Unsupported> {
        // App lock (spec §8): the app ends every desktop session through the hub.
        self.revoked.store(true, Ordering::SeqCst);
        self.hub.end_all_sessions();
        Ok(())
    }

    async fn shutdown(self) {
        self.hub.end_all_sessions();
        self.app.cleanup_before_exit();
    }
}

impl Tauri {
    pub fn app(&self) -> &App<MockRuntime> {
        &self.app
    }

    pub fn window(&self) -> &WebviewWindow<MockRuntime> {
        &self.window
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    /// Ids of every connection opened through [`Harness::connect`].
    pub fn connection_ids(&self) -> Vec<String> {
        lock(&self.ids).clone()
    }

    /// Opens another window (and webview) with this label.
    pub fn open_window(&self, label: &str) -> WebviewWindow<MockRuntime> {
        window(&self.app, label)
    }
}

/// The app as DBee would build it, with the recommended capability: the plugin's commands for
/// local content only (no `remote` section).
fn app(fixture: &Fixture, channels: Channels) -> App<MockRuntime> {
    let mut context = mock_context(noop_assets());
    for command in ["connect", "send", "close"] {
        context
            .runtime_authority_mut()
            .__allow_command(format!("plugin:ambidex|{command}"), ExecutionContext::Local);
    }
    let identity = LocalIdentity::new(OS_USER, TenantId::new("local"), vec![RoleId::new("owner")])
        .expect("valid OS user");
    mock_builder()
        .channel_interceptor(move |_webview, callback, _index, body| {
            if let InvokeResponseBody::Raw(bytes) = body
                && let Some(frames) = lock(&channels).get(&callback.0)
            {
                let _ = frames.send(bytes.clone());
            }
            true
        })
        .plugin(
            Builder::new(identity, server_config(), fixture.router())
                .hub_config(HubConfig::default())
                .build(),
        )
        .build(context)
        .expect("mock app builds")
}

fn window(app: &App<MockRuntime>, label: &str) -> WebviewWindow<MockRuntime> {
    WebviewWindowBuilder::new(app, label, Default::default())
        .build()
        .expect("mock window")
}

/// Invokes a plugin command through Tauri's IPC layer, as the webview's `invoke` would.
/// [`get_ipc_response`] blocks until the command answers, so it runs off the test's runtime.
pub async fn invoke(
    window: &WebviewWindow<MockRuntime>,
    cmd: &str,
    url: &str,
    body: InvokeBody,
    headers: HeaderMap,
) -> Result<InvokeResponseBody, Value> {
    let window = window.clone();
    let request = InvokeRequest {
        cmd: format!("plugin:ambidex|{cmd}"),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: url.parse().expect("URL"),
        body,
        headers,
        invoke_key: INVOKE_KEY.to_string(),
    };
    tokio::task::spawn_blocking(move || get_ipc_response(&window, request))
        .await
        .expect("invoke thread")
}

/// `plugin:ambidex|connect` with server frames on channel `channel`.
pub async fn connect(
    window: &WebviewWindow<MockRuntime>,
    url: &str,
    channel: u32,
) -> Result<String, Value> {
    let body = InvokeBody::Json(json!({ "onFrame": format!("__CHANNEL__:{channel}") }));
    let response = invoke(window, "connect", url, body, HeaderMap::new()).await?;
    Ok(response.deserialize::<String>().expect("connection id"))
}

/// `plugin:ambidex|send` of a raw chunk on connection `id`.
pub async fn send(
    window: &WebviewWindow<MockRuntime>,
    id: &str,
    bytes: Vec<u8>,
) -> Result<(), Value> {
    let mut headers = HeaderMap::new();
    headers.insert(CONNECTION_HEADER, id.parse().expect("header value"));
    invoke(window, "send", LOCAL_URL, InvokeBody::Raw(bytes), headers)
        .await
        .map(drop)
}

struct TauriWire {
    window: WebviewWindow<MockRuntime>,
    hub: Arc<Hub>,
    id: String,
    frames: mpsc::UnboundedReceiver<Vec<u8>>,
    revoked: Arc<AtomicBool>,
    saw_goaway: bool,
}

impl TauriWire {
    /// Whether the connection has ended.
    ///
    /// A Tauri `Channel` tells the webview it ended through an `eval`, which the mock runtime
    /// does not expose, so this asks the hub instead. The hub forgets a connection only after its
    /// engine has written its last frame, so every frame is already queued by then. The one
    /// exception is ending a session, which forgets its connections at once while their engines
    /// still send Goaway; after a revocation the connection counts as ended once Goaway arrived.
    async fn ended(&self) -> bool {
        let probe = tokio::time::timeout(CLOSE_POLL, self.hub.send(MAIN, &self.id, Vec::new()));
        let unknown = matches!(
            probe.await,
            Ok(Err(IpcError::UnknownConnection | IpcError::SessionExpired))
        );
        unknown && (!self.revoked.load(Ordering::SeqCst) || self.saw_goaway)
    }
}

impl Wire for TauriWire {
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, io::Result<()>> {
        Box::pin(async {
            send(&self.window, &self.id, bytes)
                .await
                .map_err(|err| io::Error::new(io::ErrorKind::BrokenPipe, err.to_string()))
        })
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>> {
        Box::pin(async {
            loop {
                if let Ok(Some(bytes)) = tokio::time::timeout(CLOSE_POLL, self.frames.recv()).await
                {
                    // The engine writes whole frames, one per channel message.
                    self.saw_goaway |= bytes.get(1) == Some(&(Kind::Goaway as u8));
                    return Some(bytes);
                }
                if self.ended().await {
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

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
