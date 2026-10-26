//! Ambidex over Tauri IPC: the desktop transport and the desktop session.
//!
//! Spec: Notion "Ambidex spec" (DOC-5), §4 (Desktop transport) and §8 (Desktop authentication).
//!
//! - Client frames travel to Rust as raw-body invokes of `plugin:ambidex|send` (no JSON
//!   wrapping); server frames travel back on one Tauri `Channel` per connection carrying raw
//!   bytes, received by the webview as `ArrayBuffer`s. See [`plugin`] for the command table.
//! - The transport is a dumb byte pipe ([`pipe`]): every protocol rule is in the
//!   [`ambidex`] engine, the same one the WebSocket transport runs.
//! - Each webview gets a [`DesktopSession`] bound to its label; a connection can only be written
//!   by the webview that opened it. The session's principal is the local human
//!   (`human:local:<os-user>`), built from the app's [`LocalIdentity`] and never from client
//!   input. Calls still pass the router's Authorizer like on web.
//! - No network listener is opened and no URI scheme is registered.
//!
//! # App configuration (required)
//!
//! The plugin's commands must be reachable only from the bundled `main` window loading local
//! content. In the app's `capabilities/main.json`, grant `ambidex:default` to that window and
//! never add a `remote` section:
//!
//! ```json
//! {
//!   "identifier": "main",
//!   "local": true,
//!   "windows": ["main"],
//!   "permissions": ["ambidex:default"]
//! }
//! ```
//!
//! and set `app.security.csp` in `tauri.conf.json` to [`CSP`] (no remote scripts, no remote
//! connections; Tauri adds its own script hashes). The plugin also refuses connections from
//! webviews outside [`HubConfig::allowed_webviews`] (default `["main"]`) as defence in depth.

pub mod hub;
pub mod pipe;
pub mod plugin;
pub mod session;

pub use hub::{Hub, HubConfig, IpcError};
pub use pipe::{FrameSink, IpcRx, IpcTx};
pub use plugin::{Builder, CONNECTION_HEADER, HubState, PLUGIN_NAME};
pub use session::{DesktopAuth, DesktopSession, InvalidOsUser, LocalIdentity};

/// Content Security Policy for apps using this transport (spec §8: strict CSP, no remote
/// scripts). Only bundled resources load; the only connections allowed are Tauri's IPC origins
/// (`ipc:` on Linux and macOS, `http://ipc.localhost` on Windows).
pub const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self'; \
img-src 'self'; font-src 'self'; connect-src ipc: http://ipc.localhost; worker-src 'self'; \
object-src 'none'; base-uri 'none'; form-action 'none'; \
frame-ancestors 'none'";
