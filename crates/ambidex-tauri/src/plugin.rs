//! The Tauri plugin: three commands on top of [`Hub`].
//!
//! | Command | Arguments | Result |
//! | --- | --- | --- |
//! | `plugin:ambidex\|connect` | `{ onFrame: Channel }` | connection id (string) |
//! | `plugin:ambidex\|send` | raw body = client bytes, header `ambidex-connection: <id>` | nothing |
//! | `plugin:ambidex\|close` | `{ connection: <id> }` | nothing |
//!
//! Server frames arrive on the `onFrame` channel as `ArrayBuffer`s. The plugin opens no network
//! listener and registers no URI scheme.

use std::io;
use std::sync::Arc;

use ambidex::{Dispatch, ServerConfig};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::webview::PageLoadEvent;
use tauri::{Manager, RunEvent, Runtime, State, Webview, WindowEvent};

use crate::hub::{Hub, HubConfig, IpcError};
use crate::pipe::FrameSink;
use crate::session::LocalIdentity;

/// Plugin name; commands are `plugin:ambidex|<command>` and permissions `ambidex:<permission>`.
pub const PLUGIN_NAME: &str = "ambidex";

/// Header carrying the connection id on `send`.
pub const CONNECTION_HEADER: &str = "ambidex-connection";

/// Builds the plugin.
///
/// ```no_run
/// # fn router() -> ambidex::Router { unimplemented!() }
/// use ambidex::ServerConfig;
/// use ambidex::security_types::TenantId;
/// use ambidex_tauri::LocalIdentity;
///
/// fn with_ambidex<R: tauri::Runtime>(app: tauri::Builder<R>) -> tauri::Builder<R> {
///     let identity = LocalIdentity::from_env(TenantId::new("local"), vec![]).unwrap();
///     let config = ServerConfig::new("dbee", "<schema hash>", env!("CARGO_PKG_VERSION"));
///     app.plugin(ambidex_tauri::Builder::new(identity, config, router()).build())
/// }
/// ```
pub struct Builder<D> {
    hub_config: HubConfig,
    identity: LocalIdentity,
    server_config: ServerConfig,
    dispatch: D,
}

impl<D: Dispatch> Builder<D> {
    pub fn new(identity: LocalIdentity, server_config: ServerConfig, dispatch: D) -> Builder<D> {
        Builder {
            hub_config: HubConfig::default(),
            identity,
            server_config,
            dispatch,
        }
    }

    /// Replaces the transport limits and the webview allowlist.
    pub fn hub_config(mut self, hub_config: HubConfig) -> Builder<D> {
        self.hub_config = hub_config;
        self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R> {
        let hub = Arc::new(Hub::new(
            self.hub_config,
            self.identity,
            self.server_config,
            self.dispatch,
        ));
        let on_load = Arc::clone(&hub);
        let on_event = Arc::clone(&hub);
        PluginBuilder::new(PLUGIN_NAME)
            .invoke_handler(tauri::generate_handler![connect, send, close])
            .setup(move |app, _api| {
                app.manage(HubState(hub));
                Ok(())
            })
            .on_page_load(move |webview, payload| {
                if payload.event() == PageLoadEvent::Started {
                    on_load.end_webview(webview.label());
                }
            })
            .on_event(move |_app, event| {
                if let RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Destroyed,
                    ..
                } = event
                {
                    on_event.end_window(label);
                }
            })
            .build()
    }
}

/// The hub as Tauri managed state, for the app to inspect sessions.
pub struct HubState(pub Arc<Hub>);

struct ChannelSink(Channel<InvokeResponseBody>);

impl FrameSink for ChannelSink {
    fn send(&self, bytes: Vec<u8>) -> io::Result<()> {
        self.0
            .send(InvokeResponseBody::Raw(bytes))
            .map_err(io::Error::other)
    }
}

#[tauri::command]
async fn connect<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, HubState>,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<String, String> {
    hub.0
        .connect(
            webview.window().label(),
            webview.label(),
            Box::new(ChannelSink(on_frame)),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn send<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, HubState>,
    request: Request<'_>,
) -> Result<(), String> {
    let id = request
        .headers()
        .get(CONNECTION_HEADER)
        .and_then(|v| v.to_str().ok())
        .ok_or(IpcError::BadRequest.to_string())?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err(IpcError::BadRequest.to_string());
    };
    hub.0
        .send(webview.label(), id, bytes.clone())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn close<R: Runtime>(
    webview: Webview<R>,
    hub: State<'_, HubState>,
    connection: String,
) -> Result<(), String> {
    hub.0
        .close(webview.label(), &connection)
        .map_err(|e| e.to_string())
}
