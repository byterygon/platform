//! Connections and sessions, keyed by webview label.
//!
//! The hub is the Tauri-independent part of the transport. It opens connections for a webview,
//! routes that webview's client chunks to them, and closes them when the webview reloads or goes
//! away. A connection id is only looked up under the label of the webview that sent the invoke,
//! so one webview can never write into another's connection, and an id from a foreign webview is
//! indistinguishable from an unknown one. When sessions start and end is up to a
//! [`SessionPolicy`].

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use ambidex::engine::BoxFuture;
use ambidex::{
    Call, CancellationToken, Connection, Dispatch, ErrorPayload, Server, ServerConfig, Session,
};
use serde_json::Value;

use crate::pipe::{FrameSink, Inbound, IpcRx, IpcTx, pipe};
use crate::session::{
    DefaultSessionPolicy, DesktopAuth, DesktopSession, LocalIdentity, SessionPolicy,
};

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
    /// The [`SessionPolicy`] refused to start a session (e.g. the app is locked).
    SessionRefused,
    /// The session passed its [`SessionPolicy::max_age`] and was ended with its connections.
    /// The webview may `connect` again.
    SessionExpired,
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
            IpcError::SessionRefused => "session refused",
            IpcError::SessionExpired => "session expired",
            IpcError::TooManyConnections => "too many connections",
            IpcError::UnknownConnection => "unknown connection",
            IpcError::BadRequest => "bad request",
            IpcError::Internal => "internal error",
        })
    }
}

impl std::error::Error for IpcError {}

type ServeFn =
    dyn Fn(Arc<DesktopSession>, CancellationToken, IpcRx, IpcTx) -> Connection + Send + Sync;

/// Open connections and sessions of all webviews.
pub struct Hub {
    config: HubConfig,
    identity: LocalIdentity,
    policy: Arc<dyn SessionPolicy>,
    serve: Box<ServeFn>,
    webviews: Mutex<HashMap<String, WebviewState>>,
}

struct WebviewState {
    window_label: String,
    session: Arc<DesktopSession>,
    started: Instant,
    /// Fires when the session ends; the engine then cancels the session's calls, sends Goaway
    /// `Unauthenticated` and closes ([`Authenticate::revocation`](ambidex::Authenticate)).
    revoked: CancellationToken,
    /// Removing a connection, or the whole state, drops its [`Inbound`] and so revokes its pipe.
    connections: HashMap<String, Inbound>,
}

/// Every way a session ends removes its state from the map, so ending it is dropping it.
impl Drop for WebviewState {
    fn drop(&mut self) {
        self.revoked.cancel();
    }
}

impl Hub {
    /// A hub whose connections run the Ambidex engine with `server_config` and `dispatch`
    /// (usually a [`Router`](ambidex::Router)), authenticated as `identity`, with the
    /// [`DefaultSessionPolicy`].
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
            policy: Arc::new(DefaultSessionPolicy),
            serve: Box::new(move |session, revoked, rx, tx| {
                let auth = DesktopAuth::new(session, revoked);
                Server::new(server_config.clone(), auth, Shared(Arc::clone(&dispatch)))
                    .serve(rx, tx)
            }),
            webviews: Mutex::new(HashMap::new()),
        }
    }

    /// Replaces the session policy.
    pub fn with_session_policy(mut self, policy: Arc<dyn SessionPolicy>) -> Hub {
        self.policy = policy;
        self
    }

    pub fn config(&self) -> &HubConfig {
        &self.config
    }

    /// Opens a connection for webview `webview_label` in window `window_label`; server frames go
    /// to `sink`. Returns the connection id the webview passes with its client frames. Starts a
    /// session if the webview has none (or only an expired one) and the policy allows it.
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
        let (session, revoked) = {
            let mut webviews = self.lock();
            if webviews
                .get(webview_label)
                .is_some_and(|state| self.expired(webview_label, state))
            {
                webviews.remove(webview_label);
            }
            let state = match webviews.get_mut(webview_label) {
                Some(state) => state,
                None => {
                    if !self.policy.allow_session(webview_label) {
                        return Err(IpcError::SessionRefused);
                    }
                    let session = DesktopSession::new(&self.identity, webview_label)
                        .map_err(|_| IpcError::Internal)?;
                    webviews
                        .entry(webview_label.to_owned())
                        .or_insert(WebviewState {
                            window_label: window_label.to_owned(),
                            session: Arc::new(session),
                            started: Instant::now(),
                            revoked: CancellationToken::new(),
                            connections: HashMap::new(),
                        })
                }
            };
            if state.connections.len() >= self.config.max_connections_per_webview {
                return Err(IpcError::TooManyConnections);
            }
            state.connections.insert(id.clone(), inbound);
            (Arc::clone(&state.session), state.revoked.clone())
        };

        let connection = (self.serve)(session, revoked, rx, tx);
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
    /// connection's inbound queue is full. Fails with [`IpcError::UnknownConnection`] if the
    /// connection is closed or its session ends meanwhile; the chunk is then never read.
    pub async fn send(
        &self,
        webview_label: &str,
        id: &str,
        bytes: Vec<u8>,
    ) -> Result<(), IpcError> {
        let inbound = {
            let mut webviews = self.lock();
            let state = webviews
                .get(webview_label)
                .ok_or(IpcError::UnknownConnection)?;
            let inbound = state
                .connections
                .get(id)
                .map(Inbound::handle)
                .ok_or(IpcError::UnknownConnection)?;
            if self.expired(webview_label, state) {
                webviews.remove(webview_label);
                return Err(IpcError::SessionExpired);
            }
            inbound
        };
        inbound
            .send(bytes)
            .await
            .map_err(|_| IpcError::UnknownConnection)
    }

    /// Closes connection `id` of webview `webview_label`: its pipe is revoked, so the engine
    /// closes and cancels the connection's in-flight calls.
    pub fn close(&self, webview_label: &str, id: &str) -> Result<(), IpcError> {
        self.lock()
            .get_mut(webview_label)
            .and_then(|state| state.connections.remove(id))
            .map(drop)
            .ok_or(IpcError::UnknownConnection)
    }

    /// The webview started loading a page (navigation or reload). Its connections are closed,
    /// because the old page can no longer use them; its session ends too unless
    /// [`SessionPolicy::end_on_page_load`] says otherwise.
    pub fn page_loaded(&self, webview_label: &str) {
        let mut webviews = self.lock();
        if self.policy.end_on_page_load(webview_label) {
            webviews.remove(webview_label);
        } else if let Some(state) = webviews.get_mut(webview_label) {
            state.connections.clear();
        }
    }

    /// Ends the webview's session and closes all its connections, e.g. on logout or app lock.
    /// The session is revoked: its connections cancel their in-flight calls, send Goaway
    /// `Unauthenticated` and close. Chunks not yet read and `send`s still waiting are discarded.
    pub fn end_session(&self, webview_label: &str) {
        self.lock().remove(webview_label);
    }

    /// Ends every session and closes every connection, e.g. when the app locks.
    pub fn end_all_sessions(&self) {
        self.lock().clear();
    }

    /// Ends the sessions of all webviews in a destroyed window, whatever the policy says.
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

    fn expired(&self, webview_label: &str, state: &WebviewState) -> bool {
        self.policy
            .max_age(webview_label)
            .is_some_and(|max_age| state.started.elapsed() >= max_age)
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
