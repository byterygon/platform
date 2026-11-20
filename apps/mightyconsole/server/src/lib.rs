//! Mightyconsole web server (Mightyconsole spec §2; plan DOC-20 sections 3 and 4).
//!
//! One binary serving the UI and `/rpc/ws` through `ambidex-axum` over rustls TLS, listening on
//! `127.0.0.1:7443` unless told otherwise. Browsers cannot speak NATS, Kafka, Kubernetes,
//! Temporal, Docker-over-SSH or (without CORS) LangGraph, so the server holds the live
//! connections; it keeps no configuration: the browser sends a profile when it connects.
//!
//! - [`tls`]: the user's certificate, or a self-signed one made on first start and reused.
//! - [`sessions`]: the local browser session (no login in v0.1, spec Open question 1).
//! - [`authz`]: the static Authorizer (the local user may do everything).
//! - [`audit`]: the call log the router needs to run Write calls.
//! - [`core`]: live handles per connection, events, terminals, stream progress, `ToolError`.
//! - [`api`]: `app.info`, `app.events`, `term.*`.
//! - [`tools`]: one module per tool (the `echo` sample in the foundation).
//! - [`static_ui`]: the UI with its session `<meta>` and security headers.

// ToolError carries several strings for the UI; boxing it would spread through every `?` of
// every tool, as in dbee-core.
#![allow(clippy::result_large_err)]

pub mod api;
pub mod audit;
pub mod authz;
pub mod cli;
pub mod core;
pub mod sessions;
pub mod static_ui;
pub mod tls;
pub mod tools;

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ambidex::codegen::{self, ApiInfo};
use ambidex::{Router, ServerConfig};
use ambidex_axum::{ConfigError, DEFAULT_SESSION_COOKIE, WsConfig, WsTransport};
use security_types::{Clock, SystemClock};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::api::{AppApi, AppState, ServerFacts, TermApi};
use crate::audit::{LogAuditSink, Stderr};
use crate::authz::LocalAuthorizer;
use crate::core::{Hub, IDLE_TIMEOUT, SWEEP_INTERVAL};
use crate::sessions::{LocalSessions, local_principal};
use crate::tls::{ServerTls, TlsError, TlsSource};

/// The `api` the server announces in Hello.
pub const API_NAME: &str = "mightyconsole";
/// The API version written into the generated client.
pub const API_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The version this build reports (`--version`, `app.info`, About): `MIGHTYCONSOLE_VERSION` at
/// build time, which the release workflow sets to `0.1.0-alpha.N` (TSK-87), else the crate's.
pub const VERSION: &str = match option_env!("MIGHTYCONSOLE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

/// The schema hash of the API, computed from the router as `mightyconsole-rpc-gen` does.
pub static SCHEMA_HASH: LazyLock<String> = LazyLock::new(|| {
    codegen::schema_hash(&codegen_router(), &api_info()).expect("the Mightyconsole API exports")
});

pub fn api_info() -> ApiInfo {
    ApiInfo::new(API_NAME, API_VERSION)
}

/// Where `api.ts` and `api.manifest.json` are committed: `apps/mightyconsole/ui/src/gen`.
pub fn generated_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("apps/mightyconsole/server is inside apps/mightyconsole")
        .join("ui/src/gen")
}

/// Mounts every namespace: the shared procedures, then the tools.
fn mount(router: &Router, state: &Arc<AppState>) {
    router
        .mount(AppApi(Arc::clone(state)))
        .expect("app API registers");
    router
        .mount(TermApi(Arc::clone(state)))
        .expect("term API registers");
    core::messaging::mount(router, &state.hub).expect("messaging APIs register");
    tools::mount(router, &state.hub).expect("tool APIs register");
}

/// The router with every procedure, on a state that is never served: the one
/// `mightyconsole-rpc-gen` exports and [`SCHEMA_HASH`] is computed from.
pub fn codegen_router() -> Router {
    let state = Arc::new(AppState {
        hub: Arc::new(Hub::new(Arc::new(SystemClock), IDLE_TIMEOUT)),
        facts: ServerFacts {
            listen: String::new(),
            public_origin: String::new(),
            certificate_fingerprint: String::new(),
        },
    });
    let router = Router::new(LocalAuthorizer::new(local_principal().id));
    mount(&router, &state);
    router
}

/// Everything `mightyconsole-server` needs to start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeConfig {
    pub listen: SocketAddr,
    /// Accepted `Host` values (`host:port`).
    pub allowed_hosts: Vec<String>,
    /// `https://host[:port]` the browser sees; the upgrade's `Origin` must equal it.
    pub public_origin: String,
    pub tls: TlsSource,
    /// The built UI (`index.html`, `assets/`). Without it: the UI compiled into the binary
    /// (feature `embed-ui`), else a placeholder page.
    pub ui: Option<PathBuf>,
    /// A plain-HTTP listener on loopback for the codec endpoint only (TSK-103, Open question
    /// (a)): the `temporal` CLI trusts the system's roots, not the self-signed certificate.
    pub codec_listen: Option<SocketAddr>,
    /// The UI's history (DOC-21 §2.3, §3.7): real paths, or routes in the hash.
    pub router: RouterMode,
    /// The path everything is served under (`""` or e.g. `/tools/mc`, see
    /// [`ambidex_axum::valid_path_prefix`]): the page, its assets, `/rpc/ws` and the codec endpoint.
    pub base_path: String,
}

impl ServeConfig {
    /// Whether the listener accepts connections from other machines.
    pub fn is_exposed(&self) -> bool {
        !self.listen.ip().is_loopback()
    }

    /// The session cookie (DOC-21 §2.3): `__Host-` and `Path=/` always, so under a base path the
    /// name carries the path instead, keeping servers under different paths of one host apart.
    pub fn session_cookie(&self) -> String {
        session_cookie_for(&self.base_path)
    }
}

/// [`ServeConfig::session_cookie`] for a base path: `/tools/mc` gives `__Host-ambidex_session_tools_mc`.
pub fn session_cookie_for(base_path: &str) -> String {
    if base_path.is_empty() {
        DEFAULT_SESSION_COOKIE.to_owned()
    } else {
        format!("{DEFAULT_SESSION_COOKIE}{}", base_path.replace('/', "_"))
    }
}

/// How the UI keeps its place in the URL (DOC-21 §3.7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum RouterMode {
    /// Real paths; every extension-less path under the base path is the page.
    #[default]
    Browser,
    /// `<base path>/#/<route>`, for a proxy or host that cannot send the page for every path.
    Hash,
}

impl RouterMode {
    pub fn as_str(self) -> &'static str {
        match self {
            RouterMode::Browser => "browser",
            RouterMode::Hash => "hash",
        }
    }
}

/// The UI a running server serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ServedUi {
    /// `--ui DIR` (canonical).
    Dir(PathBuf),
    /// The UI compiled into the binary (feature `embed-ui`), with its number of files.
    Embedded { files: usize },
    /// No UI: a short page saying how to build one.
    Placeholder,
}

/// Why the server did not start.
#[derive(Debug)]
pub enum StartError {
    Tls(TlsError),
    Web(ConfigError),
    Ui { path: PathBuf, error: io::Error },
    Bind { addr: SocketAddr, error: io::Error },
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::Tls(e) => e.fmt(f),
            StartError::Web(e) => write!(f, "web configuration: {e}"),
            StartError::Ui { path, error } => {
                write!(f, "UI directory {}: {error}", path.display())
            }
            StartError::Bind { addr, error } => write!(f, "cannot listen on {addr}: {error}"),
        }
    }
}

impl std::error::Error for StartError {}

/// Options for tests: the clock of the idle sweep, and whether the server runs the sweep.
pub struct StartOptions {
    pub clock: Arc<dyn Clock>,
    pub idle_timeout: Duration,
    /// `None` runs no background sweep (tests call [`Hub::sweep`] themselves).
    pub sweep_interval: Option<Duration>,
}

impl Default for StartOptions {
    fn default() -> Self {
        StartOptions {
            clock: Arc::new(SystemClock),
            idle_timeout: IDLE_TIMEOUT,
            sweep_interval: Some(SWEEP_INTERVAL),
        }
    }
}

/// A running server.
pub struct Server {
    hub: Arc<Hub>,
    sessions: Arc<LocalSessions>,
    tls: ServerTls,
    local_addr: SocketAddr,
    ui: ServedUi,
    stop: Option<oneshot::Sender<()>>,
    task: JoinHandle<io::Result<()>>,
    sweep: Option<JoinHandle<()>>,
    codec_task: Option<JoinHandle<()>>,
}

impl Server {
    pub async fn start(config: ServeConfig) -> Result<Server, StartError> {
        Server::start_with(config, StartOptions::default()).await
    }

    pub async fn start_with(
        config: ServeConfig,
        options: StartOptions,
    ) -> Result<Server, StartError> {
        let tls = tls::load(&config.tls).map_err(StartError::Tls)?;
        let mut ws_config =
            WsConfig::new(config.allowed_hosts.clone(), config.public_origin.clone());
        // DOC-21 §2.3: under a base path the WebSocket is at <base>/rpc/ws, and the cookie keeps
        // `__Host-` (so `Path=/`) with the path in its name.
        ws_config.path_prefix = config.base_path.clone();
        ws_config.session_cookie = config.session_cookie();
        let ui = match &config.ui {
            Some(path) => Some(static_ui::UiSource::Dir(
                static_ui::StaticUi::open(path).map_err(|error| StartError::Ui {
                    path: path.clone(),
                    error,
                })?,
            )),
            None => static_ui::UiSource::embedded(),
        };
        let served_ui = match &ui {
            Some(static_ui::UiSource::Dir(dir)) => ServedUi::Dir(dir.root().to_path_buf()),
            Some(static_ui::UiSource::Embedded(files)) => ServedUi::Embedded { files: files.len() },
            None => ServedUi::Placeholder,
        };

        let principal = local_principal();
        let hub = Arc::new(Hub::new(options.clock, options.idle_timeout));
        let state = Arc::new(AppState {
            hub: Arc::clone(&hub),
            facts: ServerFacts {
                listen: config.listen.to_string(),
                public_origin: config.public_origin.clone(),
                certificate_fingerprint: tls.fingerprint.clone(),
            },
        });
        let router = Router::new(LocalAuthorizer::new(principal.id.clone()))
            .with_audit(LogAuditSink::new(Arc::new(Stderr)));
        mount(&router, &state);
        let engine = ServerConfig::new(API_NAME, SCHEMA_HASH.as_str(), API_VERSION);

        let sessions = Arc::new(LocalSessions::new(principal));
        let transport = WsTransport::new(ws_config, engine, Arc::clone(&sessions), router)
            .map_err(StartError::Web)?;
        let page = static_ui::PageConfig {
            cookie_name: config.session_cookie(),
            public_origin: config.public_origin.clone(),
            router: config.router,
            base_path: config.base_path.clone(),
        };
        let codec = if config.base_path.is_empty() {
            tools::temporal::codec::routes()
        } else {
            axum::Router::new().nest(&config.base_path, tools::temporal::codec::routes())
        };
        let routes = static_ui::routes(ui, Arc::clone(&sessions), page).merge(codec);
        let codec_task = match config.codec_listen {
            Some(addr) => {
                let listener = TcpListener::bind(addr)
                    .await
                    .map_err(|error| StartError::Bind { addr, error })?;
                Some(tokio::spawn(async move {
                    let _ = axum::serve(listener, tools::temporal::codec::routes()).await;
                }))
            }
            None => None,
        };

        let listener =
            TcpListener::bind(config.listen)
                .await
                .map_err(|error| StartError::Bind {
                    addr: config.listen,
                    error,
                })?;
        let local_addr = listener.local_addr().map_err(|error| StartError::Bind {
            addr: config.listen,
            error,
        })?;
        let (stop, stopped) = oneshot::channel();
        let tls_config = Arc::clone(&tls.config);
        let task = tokio::spawn(async move {
            transport
                .serve(listener, tls_config, routes, async {
                    let _ = stopped.await;
                })
                .await
        });
        let sweep = options.sweep_interval.map(|every| {
            let hub = Arc::clone(&hub);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(every);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    hub.sweep();
                }
            })
        });
        Ok(Server {
            hub,
            sessions,
            tls,
            local_addr,
            ui: served_ui,
            stop: Some(stop),
            task,
            sweep,
            codec_task,
        })
    }

    /// The address the listener is bound to (the actual port when the configuration asked for 0).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    pub fn sessions(&self) -> &Arc<LocalSessions> {
        &self.sessions
    }

    pub fn tls(&self) -> &ServerTls {
        &self.tls
    }

    /// The canonical UI directory being served, if one is configured.
    pub fn ui_dir(&self) -> Option<&Path> {
        match &self.ui {
            ServedUi::Dir(dir) => Some(dir),
            _ => None,
        }
    }

    /// What the server answers `GET /` with.
    pub fn ui(&self) -> &ServedUi {
        &self.ui
    }

    /// Stops accepting connections and waits for the accept loop.
    pub async fn shutdown(mut self) -> io::Result<()> {
        if let Some(sweep) = self.sweep.take() {
            sweep.abort();
        }
        if let Some(codec) = self.codec_task.take() {
            codec.abort();
        }
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        self.task
            .await
            .map_err(|e| io::Error::other(format!("accept loop panicked: {e}")))?
    }
}
