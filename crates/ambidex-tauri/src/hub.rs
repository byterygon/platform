//! Connections and sessions, keyed by webview label.
//!
//! The hub is the Tauri-independent part of the transport. It opens connections for a webview,
//! routes that webview's client chunks to them, and closes them when the webview reloads or goes
//! away. A connection id is only looked up under the label of the webview that sent the invoke,
//! so one webview can never write into another's connection, and an id from a foreign webview is
//! indistinguishable from an unknown one.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use ambidex::engine::BoxFuture;
use ambidex::{Call, Connection, Dispatch, ErrorPayload, Server, ServerConfig, Session};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::pipe::{FrameSink, IpcRx, IpcTx, pipe};
use crate::session::{DesktopAuth, DesktopSession, LocalIdentity};

/// Transport limits.
#[derive(Debug, Clone)]
pub struct HubConfig {
    /// Webview labels that may open connections. Defence in depth behind the Tauri capability,
    /// which should grant the plugin to the same webviews only. Default: `["main"]`.
    pub allowed_webviews: Vec<String>,
    /// Open connections per webview; further `connect` calls fail. Default 8.
    pub max_connections_per_webview: usize,
    /// Client chunks queued per connection before `send` waits for the engine. Default 16.
    pub inbound_queue_chunks: usize,
}

impl Default for HubConfig {
    fn default() -> HubConfig {
        HubConfig {
            allowed_webviews: vec!["main".to_owned()],
            max_connections_per_webview: 8,
            inbound_queue_chunks: 16,
        }
    }
}

/// Why a transport command failed. Sent to the webview as a plain string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IpcError {
    /// The webview's label is not in [`HubConfig::allowed_webviews`].
    WebviewNotAllowed,
    /// The webview already has [`HubConfig::max_connections_per_webview`] connections.
    TooManyConnections,
    /// No open connection with this id belongs to the calling webview.
    UnknownConnection,
    /// A client frame invoke without a raw (binary) body or without the connection header.
    BadRequest,
    /// The OS had no randomness for a session or connection id.
    Internal,
}

impl fmt::Display for IpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            IpcError::WebviewNotAllowed => "webview not allowed",
            IpcError::TooManyConnections => "too many connections",
            IpcError::UnknownConnection => "unknown connection",
            IpcError::BadRequest => "bad request",
            IpcError::Internal => "internal error",
        })
    }
}

impl std::error::Error for IpcError {}

type ServeFn = dyn Fn(Arc<DesktopSession>, IpcRx, IpcTx) -> Connection + Send + Sync;

/// Open connections and sessions of all webviews.
pub struct Hub {
    config: HubConfig,
    identity: LocalIdentity,
    serve: Box<ServeFn>,
    webviews: Mutex<HashMap<String, WebviewState>>,
}

struct WebviewState {
    window_label: String,
    session: Arc<DesktopSession>,
    connections: HashMap<String, mpsc::Sender<Vec<u8>>>,
}

impl Hub {
    /// A hub whose connections run the Ambidex engine with `server_config` and `dispatch`
    /// (usually a [`Router`](ambidex::Router)), authenticated as `identity`.
    pub fn new<D: Dispatch>(
        config: HubConfig,
        identity: LocalIdentity,
        server_config: ServerConfig,
        dispatch: D,
    ) -> Hub {
        let dispatch = Arc::new(dispatch);
        Hub {
            config,
            identity,
            serve: Box::new(move |session, rx, tx| {
                let auth = DesktopAuth::new(session);
                Server::new(server_config.clone(), auth, Shared(Arc::clone(&dispatch)))
                    .serve(rx, tx)
            }),
            webviews: Mutex::new(HashMap::new()),
        }
    }

    pub fn config(&self) -> &HubConfig {
        &self.config
    }

    /// Opens a connection for webview `webview_label` in window `window_label`; server frames go
    /// to `sink`. Returns the connection id the webview passes with its client frames.
    ///
    /// Must run inside a Tokio runtime: the engine is spawned on it.
    pub fn connect(
        self: &Arc<Self>,
        window_label: &str,
        webview_label: &str,
        sink: Box<dyn FrameSink>,
    ) -> Result<String, IpcError> {
        if !self
            .config
            .allowed_webviews
            .iter()
            .any(|l| l == webview_label)
        {
            return Err(IpcError::WebviewNotAllowed);
        }
        let id = getrandom::u64()
            .map(|n| format!("{n:016x}"))
            .map_err(|_| IpcError::Internal)?;
        let (inbound, rx, tx) = pipe(sink, self.config.inbound_queue_chunks);
        let session = {
            let mut webviews = self.lock();
            let state = match webviews.get_mut(webview_label) {
                Some(state) => state,
                None => {
                    let session = DesktopSession::new(&self.identity, webview_label)
                        .map_err(|_| IpcError::Internal)?;
                    webviews
                        .entry(webview_label.to_owned())
                        .or_insert(WebviewState {
                            window_label: window_label.to_owned(),
                            session: Arc::new(session),
                            connections: HashMap::new(),
                        })
                }
            };
            if state.connections.len() >= self.config.max_connections_per_webview {
                return Err(IpcError::TooManyConnections);
            }
            state.connections.insert(id.clone(), inbound);
            Arc::clone(&state.session)
        };

        let connection = (self.serve)(session, rx, tx);
        let hub = Arc::downgrade(self);
        let (label, conn_id) = (webview_label.to_owned(), id.clone());
        tokio::spawn(async move {
            connection.closed().await;
            if let Some(hub) = hub.upgrade() {
                hub.forget(&label, &conn_id);
            }
        });
        Ok(id)
    }

    /// Queues a client chunk for connection `id` of webview `webview_label`. Waits while the
    /// connection's inbound queue is full.
    pub async fn send(
        &self,
        webview_label: &str,
        id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), IpcError> {
        let inbound = self
            .lock()
            .get(webview_label)
            .and_then(|state| state.connections.get(id))
            .cloned()
            .ok_or(IpcError::UnknownConnection)?;
        inbound
            .send(bytes)
            .await
            .map_err(|_| IpcError::UnknownConnection)
    }

    /// Closes connection `id` of webview `webview_label`: the engine sees end of stream.
    pub fn close(&self, webview_label: &str, id: &str) -> Result<(), IpcError> {
        self.lock()
            .get_mut(webview_label)
            .and_then(|state| state.connections.remove(id))
            .map(drop)
            .ok_or(IpcError::UnknownConnection)
    }

    /// Ends the webview's session and closes all its connections. Called when the webview starts
    /// loading a page (navigation or reload): the new page gets a new session.
    pub fn end_webview(&self, webview_label: &str) {
        self.lock().remove(webview_label);
    }

    /// Ends the sessions of all webviews in a destroyed window.
    pub fn end_window(&self, window_label: &str) {
        self.lock()
            .retain(|_, state| state.window_label != window_label);
    }

    /// The current session of a webview, if it has one.
    pub fn session(&self, webview_label: &str) -> Option<Arc<DesktopSession>> {
        self.lock()
            .get(webview_label)
            .map(|state| Arc::clone(&state.session))
    }

    /// Open connections of a webview.
    pub fn connection_count(&self, webview_label: &str) -> usize {
        self.lock()
            .get(webview_label)
            .map_or(0, |state| state.connections.len())
    }

    fn forget(&self, webview_label: &str, id: &str) {
        if let Some(state) = self.lock().get_mut(webview_label) {
            state.connections.remove(id);
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, WebviewState>> {
        // The map stays consistent across a panic (every update is a single insert or remove).
        self.webviews.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Shares one dispatcher between the per-connection servers.
struct Shared<D>(Arc<D>);

impl<D: Dispatch> Dispatch for Shared<D> {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        self.0.call(session, call)
    }
}
