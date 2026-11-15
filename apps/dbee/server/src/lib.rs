//! DBee self-hosted web server (DBee spec §2, §11; Ambidex spec §8 "Web", §9).
//!
//! The same [`dbee_core::Core`] the desktop shell links, served by `ambidex-axum`: one binary
//! WebSocket per tab at `/rpc/ws` over rustls TLS, every request behind the Host allowlist, the
//! upgrade behind the exact public origin and a server-side session, the Hello behind that
//! session's anti-CSRF token. Next to it the static UI bundle (`apps/dbee/ui`, batch 4) with a
//! strict Content-Security-Policy, and `dbee-server audit verify` for the audit chain.
//!
//! **No human can log in before Ambidex M3** (spec Open question 1, Decision 2): the specs allow
//! no login method but OIDC, so the server starts with an empty [`PlaceholderSessions`] and
//! refuses every upgrade. The end-to-end test issues a session server-side through
//! [`Server::issue_session`]; the binary never does.
//!
//! The server differs from the desktop shell only in what it injects into the core (spec §2):
//! [`dbee_core::AppMode::Server`], no native save dialog, the session-only secret store (spec
//! §11: personal web connections need per-user encrypted storage, which needs a logged-in user;
//! a headless host's keychain is never touched), and the audit log on the server's own
//! workspace path (`<workspace>/audit/log.jsonl`, the same sink type as the desktop until M3).

pub mod cli;
pub mod static_ui;
mod tls;

use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use ambidex_axum::{ConfigError, IssuedSession, PlaceholderSessions, WsConfig, WsTransport};
use dbee_core::{AppMode, Core, CoreConfig, CoreError, SecretStoreConfig};
use security_types::Principal;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

pub use tls::TlsError;

/// Why passwords are not persisted by the web shell (spec §11, Open question 2).
pub const SESSION_ONLY_REASON: &str = "the web shell has no per-user secret storage before \
                                        Ambidex M3; passwords are kept for this session only";

/// Everything `dbee-server serve` needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeConfig {
    /// Address of the TLS listener.
    pub bind: SocketAddr,
    /// PEM file with the server certificate chain, leaf first.
    pub tls_cert: PathBuf,
    /// PEM file with the server's private key (PKCS#8, SEC1 or PKCS#1).
    pub tls_key: PathBuf,
    /// Accepted `Host` header values, `host[:port]`; compared exactly, ASCII case-insensitively.
    pub allowed_hosts: Vec<String>,
    /// `https://host[:port]` the browser serializes as the page's origin; the WebSocket upgrade's
    /// `Origin` must equal it byte for byte.
    pub public_origin: String,
    /// The workspace: `connections.json`, `settings.json`, `tabs.json`, `audit/log.jsonl`.
    pub workspace: PathBuf,
    /// Directory with the built UI (`index.html` and `assets/`). Without it every non-RPC path
    /// answers 404.
    pub ui: Option<PathBuf>,
    /// PEM files with the CA certificates that database grants with the "required, deployment
    /// CAs" TLS policy verify against. Nothing is loaded implicitly.
    pub deployment_cas: Vec<PathBuf>,
}

/// Why the server did not start.
#[derive(Debug)]
pub enum StartError {
    Tls(TlsError),
    /// Invalid Host allowlist or public origin.
    Web(ConfigError),
    Core(CoreError),
    /// The UI directory does not exist or is not a directory.
    Ui {
        path: PathBuf,
        error: io::Error,
    },
    Bind {
        addr: SocketAddr,
        error: io::Error,
    },
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Tls(e) => e.fmt(f),
            StartError::Web(e) => write!(f, "web configuration: {e}"),
            StartError::Core(e) => write!(f, "core: {e}"),
            StartError::Ui { path, error } => {
                write!(f, "UI directory {}: {error}", path.display())
            }
            StartError::Bind { addr, error } => write!(f, "cannot listen on {addr}: {error}"),
        }
    }
}

impl std::error::Error for StartError {}

/// A running server: the core, the listener and the accept loop.
pub struct Server {
    core: Core,
    sessions: Arc<PlaceholderSessions>,
    local_addr: SocketAddr,
    ui: Option<PathBuf>,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<io::Result<()>>,
}

impl Server {
    /// Loads the TLS files, starts the core on the workspace, binds the listener and begins
    /// accepting connections on the current runtime.
    pub async fn start(config: ServeConfig) -> Result<Server, StartError> {
        let tls = tls::server_config(&config.tls_cert, &config.tls_key).map_err(StartError::Tls)?;
        let roots = tls::root_store(&config.deployment_cas).map_err(StartError::Tls)?;
        let ws_config = WsConfig::new(config.allowed_hosts.clone(), config.public_origin.clone());

        let ui = match config.ui {
            Some(path) => Some(
                static_ui::StaticUi::open(&path).map_err(|error| StartError::Ui { path, error })?,
            ),
            None => None,
        };
        let ui_root = ui.as_ref().map(|ui| ui.root().to_path_buf());

        let mut core_config = CoreConfig::new(&config.workspace, AppMode::Server);
        core_config.secret_store = SecretStoreConfig::SessionOnly(SESSION_ONLY_REASON.into());
        core_config.deployment_roots = Arc::new(roots);
        let core = Core::start(core_config).await.map_err(StartError::Core)?;

        let sessions = Arc::new(PlaceholderSessions::new());
        let transport = WsTransport::new(
            ws_config,
            core.server_config(),
            Arc::clone(&sessions),
            core.router(),
        )
        .map_err(StartError::Web)?;
        let routes = static_ui::routes(ui, &config.public_origin);

        let listener = TcpListener::bind(config.bind)
            .await
            .map_err(|error| StartError::Bind {
                addr: config.bind,
                error,
            })?;
        let local_addr = listener.local_addr().map_err(|error| StartError::Bind {
            addr: config.bind,
            error,
        })?;
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            transport
                .serve(listener, tls, routes, async {
                    let _ = stopped.await;
                })
                .await
        });
        Ok(Server {
            core,
            sessions,
            local_addr,
            ui: ui_root,
            stop: Some(stop),
            task,
        })
    }

    /// The address the listener is bound to (the actual port when `bind` asked for 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn core(&self) -> &Core {
        &self.core
    }

    /// The canonical UI directory being served, if one is configured.
    pub fn ui_dir(&self) -> Option<&std::path::Path> {
        self.ui.as_deref()
    }

    /// Issues a web session for `principal` (cookie, anti-CSRF token). There is no login before
    /// Ambidex M3, so this is how the end-to-end test gets a session; the `dbee-server` binary
    /// never calls it, and the principal is built by the caller, never from client input.
    pub fn issue_session(&self, principal: Principal) -> io::Result<IssuedSession> {
        self.sessions
            .issue(principal)
            .map_err(|e| io::Error::other(format!("OS randomness unavailable: {e}")))
    }

    /// Stops accepting connections and waits for the accept loop. Connections already open keep
    /// running until their peers close them.
    pub async fn shutdown(mut self) -> io::Result<()> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task
            .await
            .map_err(|e| io::Error::other(format!("accept loop panicked: {e}")))?
    }
}
