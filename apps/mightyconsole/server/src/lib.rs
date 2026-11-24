//! Mightyconsole web server (Mightyconsole spec §2; plan DOC-20 sections 3 and 4).
//!
//! One binary serving the UI and `/rpc/ws` through `ambidex-axum` over rustls TLS, listening on
//! `127.0.0.1:7443` unless told otherwise. Browsers cannot speak NATS, Kafka, Kubernetes,
//! Temporal, Docker-over-SSH or (without CORS) LangGraph, so the server holds the live
//! connections; it keeps no configuration: the browser sends a profile when it connects.
//!
//! - [`tls`]: the user's certificate, or a self-signed one made on first start and reused.
//! - [`config`]: the configuration file (DOC-25 §3.6.1) behind the flags.
//! - [`sessions`]: OIDC sign-in when `[auth.oidc]` is configured (DOC-25 §3.2, through
//!   `ambidex-axum`), else the local browser session of v0.1.
//! - [`authz`]: the static Authorizer (the local user, or every signed-in person, may do
//!   everything until roles land).
//! - [`audit`]: the durable audit log (DOC-25 §3.5, `audit-jsonl`): the filter in front of it
//!   (Write and Destructive calls, sensitive reads, refusals), and the sign-in and server events.
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
pub mod config;
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
use ambidex_axum::oidc::{LoginRoutes, OidcLogin};
use ambidex_axum::{ConfigError, DEFAULT_SESSION_COOKIE, LoginSessions, WsConfig, WsTransport};
use security_types::{AuditSink, Clock, SystemClock};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::api::{AppApi, AppState, ServerFacts, TermApi};
use crate::audit::{
    AuditSettings, Event, EventLog, LineWriter, McAuditSink, SensitiveTable, Stderr,
};
use crate::authz::LocalAuthorizer;
use crate::config::{AuthSettings, OIDC_CLIENT_SECRET_ENV};
use crate::core::{Hub, IDLE_TIMEOUT, SWEEP_INTERVAL};
use crate::sessions::{LocalSessions, local_principal};
use crate::sessions::{McSignIn, ServerSessions, SessionLog, SignInSessions};
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
    /// The data directory, when one is known.
    pub data: Option<PathBuf>,
    /// Sign-in (`[auth]`, DOC-25 §3.2).
    pub auth: AuthSettings,
    /// The audit log (`[audit]`, DOC-25 §3.5), kept in `data/audit`.
    pub audit: AuditSettings,
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

    /// The login cookie of a pending OIDC sign-in (DOC-25 §3.2.2): `__Host-mc_login`, with the
    /// base path in its name as for the session cookie.
    pub fn login_cookie(&self) -> String {
        if self.base_path.is_empty() {
            "__Host-mc_login".to_owned()
        } else {
            format!("__Host-mc_login{}", self.base_path.replace('/', "_"))
        }
    }

    /// The routes of the OIDC sign-in, the redirect URI included.
    pub fn login_routes(&self) -> LoginRoutes {
        let mut routes = LoginRoutes::new(self.public_origin.clone());
        routes.base_path = self.base_path.clone();
        routes.session_cookie = self.session_cookie();
        routes.login_cookie = self.login_cookie();
        routes.csrf_header = CSRF_HEADER.clone();
        routes
    }
}

/// The header that carries the anti-CSRF token on `POST /auth/*` (DOC-25 §3.2.4).
pub static CSRF_HEADER: axum::http::HeaderName =
    axum::http::HeaderName::from_static("x-mightyconsole-csrf");

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
    /// The sign-in configuration (DOC-25 §3.6.2 point 2).
    Auth(String),
    /// The audit log cannot be used (DOC-25 §3.6.2 point 6): no data directory, or a log that
    /// does not open or whose chain is broken. The server does not start without it.
    Audit(String),
    Web(ConfigError),
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
            StartError::Auth(e) => write!(f, "sign-in: {e}"),
            StartError::Audit(e) => write!(f, "audit log: {e}"),
            StartError::Web(e) => write!(f, "web configuration: {e}"),
            StartError::Ui { path, error } => {
                write!(f, "UI directory {}: {error}", path.display())
            }
            StartError::Bind { addr, error } => write!(f, "cannot listen on {addr}: {error}"),
        }
    }
}

impl std::error::Error for StartError {}

/// What `config check` validates (DOC-25 §3.6.1): the TLS files, the UI directory, the
/// sign-in configuration (the CA file, the client secret, the issuer, the routes) and, with
/// `online`, the IdP's discovery document and keys. Never listens and creates nothing. `Ok`
/// lists what was checked; `Err` every problem found.
pub async fn check_config(config: &ServeConfig, online: bool) -> Result<Vec<String>, Vec<String>> {
    let mut report = Vec::new();
    let mut problems = Vec::new();
    report.push(format!(
        "listen {}{}; public origin {}{}",
        config.listen,
        if config.is_exposed() {
            " (beyond loopback)"
        } else {
            ""
        },
        config.public_origin,
        config.base_path
    ));
    match &config.tls {
        TlsSource::Files { .. } => match tls::load(&config.tls) {
            Ok(tls) => report.push(format!("certificate SHA-256 {}", tls.fingerprint)),
            Err(e) => problems.push(e.to_string()),
        },
        TlsSource::Generated { dir } => report.push(format!(
            "certificate: self-signed, kept in {}",
            dir.display()
        )),
    }
    if let Some(ui) = &config.ui
        && let Err(e) = static_ui::StaticUi::open(ui)
    {
        problems.push(format!("UI directory {}: {e}", ui.display()));
    }
    // The log is verified, not opened: `config check` creates nothing (DOC-25 §3.6.1).
    match &config.data {
        None => problems
            .push("audit log: no data directory: give --data or set MIGHTYCONSOLE_DATA".into()),
        Some(data) => {
            let dir = audit::audit_dir(data);
            let files = audit_jsonl::segment_files(&dir).unwrap_or_default();
            match audit_jsonl::check_files(&files) {
                Ok(checked) => report.push(format!(
                    "audit log {}: {} records in {} segment(s), chain intact; reads: {}{}",
                    dir.display(),
                    checked.records,
                    checked.segments.len(),
                    config.audit.reads.as_str(),
                    if config.audit.stderr {
                        ", also on stderr"
                    } else {
                        ""
                    }
                )),
                Err(e) => problems.push(format!("audit log {e}")),
            }
        }
    }
    match &config.auth.oidc {
        None => report.push("sign-in: none configured ([auth.oidc]); the local user only".into()),
        Some(oidc) => match oidc.load(std::env::var(OIDC_CLIENT_SECRET_ENV).ok()) {
            Err(e) => problems.push(e),
            Ok(loaded) => {
                let clock: Arc<dyn Clock> = Arc::new(SystemClock);
                let store = Arc::new(LoginSessions::new(
                    Arc::clone(&clock),
                    config.auth.limits,
                    Arc::new(ambidex_axum::NoSessionEvents),
                ));
                let hooks = Arc::new(McSignIn::new(
                    &config.auth.tenant,
                    Arc::new(Stderr),
                    EventLog::discard(),
                ));
                let issuer = loaded.issuer.clone();
                match OidcLogin::new(loaded, config.login_routes(), store, hooks, clock) {
                    Err(e) => problems.push(format!("[auth.oidc]: {e}")),
                    Ok(login) => {
                        report.push(format!(
                            "sign-in: OIDC through {issuer}; register the redirect URI {}",
                            login.redirect_uri()
                        ));
                        if online {
                            match login.discover().await {
                                Ok(()) => report
                                    .push("identity provider: discovery and keys fetched".into()),
                                Err(e) => problems.push(format!("identity provider: {e}")),
                            }
                        }
                    }
                }
            }
        },
    }
    if problems.is_empty() {
        Ok(report)
    } else {
        Err(problems)
    }
}

/// How often the audit log's retention and size policy is applied (DOC-25 §3.5.6).
pub const RETENTION_EVERY: Duration = Duration::from_secs(24 * 3600);

/// How often expired sessions are ended, so their connections get Goaway.
pub const SESSION_SWEEP: Duration = Duration::from_secs(15);

/// Options for tests: the clock of the idle sweep, and whether the server runs the sweep.
pub struct StartOptions {
    pub clock: Arc<dyn Clock>,
    pub idle_timeout: Duration,
    /// `None` runs no background sweep (tests call [`Hub::sweep`] themselves).
    pub sweep_interval: Option<Duration>,
    /// The program jq queries run in (spec §5.4.1): `None` is the server's own binary. Tests that
    /// start the server inside the test harness name the built server binary.
    pub jq_worker: Option<std::path::PathBuf>,
    /// Where the audit entries go instead of the durable log in `data/audit` (tests that make
    /// thousands of audited calls, or that read the entries back). `None` is the log of the
    /// data directory, opened and verified before the server listens.
    pub audit_sink: Option<Arc<dyn AuditSink>>,
}

impl Default for StartOptions {
    fn default() -> Self {
        StartOptions {
            clock: Arc::new(SystemClock),
            idle_timeout: IDLE_TIMEOUT,
            sweep_interval: Some(SWEEP_INTERVAL),
            jq_worker: None,
            audit_sink: None,
        }
    }
}

/// A running server.
pub struct Server {
    hub: Arc<Hub>,
    sessions: ServerSessions,
    /// The audit log's event writer, flushed at shutdown.
    events: EventLog,
    event_task: JoinHandle<()>,
    retention_task: Option<JoinHandle<()>>,
    /// The JWKS refresh and the session sweep, with sign-in.
    auth_tasks: Vec<JoinHandle<()>>,
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

        if let Some(worker) = options.jq_worker {
            core::jq::set_worker_program(worker);
        }
        let principal = local_principal();
        let log: Arc<dyn LineWriter> = Arc::new(Stderr);
        // The audit log first: a server that cannot record does not start (DOC-25 §3.6.2).
        let tenant = match &config.auth.oidc {
            Some(_) => config.auth.tenant.clone(),
            None => authz::LOCAL_TENANT.to_owned(),
        };
        let mut retention_sink: Option<Arc<audit_jsonl::SegmentedSink>> = None;
        let sink: Arc<dyn AuditSink> = match options.audit_sink {
            Some(sink) => sink,
            None => {
                let data = config.data.clone().ok_or_else(|| {
                    StartError::Audit(
                        "no data directory for the audit log: give --data or set \
                         MIGHTYCONSOLE_DATA"
                            .into(),
                    )
                })?;
                let (settings, tenant) = (config.audit, tenant.clone());
                let warn_to = Arc::clone(&log);
                let warn: audit_jsonl::segments::Warn = Arc::new(move |message: &str| {
                    warn_to.line(&format!("mightyconsole-server: WARNING: {message}"));
                });
                let (durable, moved_to) = tokio::task::spawn_blocking(move || {
                    audit::open_log(&data, &settings, &tenant, Some(warn))
                })
                .await
                .map_err(|e| StartError::Audit(format!("opening the log panicked: {e}")))?
                .map_err(|e| StartError::Audit(e.to_string()))?;
                if let Some(moved_to) = moved_to {
                    log.line(&format!(
                        "mightyconsole-server: the audit log was moved to {}/{moved_to} and a new chain started",
                        audit::audit_dir(config.data.as_deref().unwrap_or(Path::new("."))).display()
                    ));
                }
                let durable = Arc::new(durable);
                retention_sink = Some(Arc::clone(&durable));
                durable
            }
        };
        // Retention once a day, the first time at start (DOC-25 §3.5.6); the sink also applies it
        // after every rotation and when the log is over its size.
        let retention_task = retention_sink.map(|sink| {
            let log = Arc::clone(&log);
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(RETENTION_EVERY);
                loop {
                    tick.tick().await;
                    let sink = Arc::clone(&sink);
                    match tokio::task::spawn_blocking(move || sink.enforce_retention()).await {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => log.line(&format!(
                            "mightyconsole-server: WARNING: audit retention: {}",
                            e.0
                        )),
                        Err(_) => {}
                    }
                }
            })
        });
        let (events, event_task) = EventLog::spawn(
            Arc::clone(&sink),
            &tenant,
            config.audit.stderr,
            Arc::clone(&log),
        );
        let (sessions, authorizer, auth_tasks) = match &config.auth.oidc {
            None => (
                ServerSessions::Local(Arc::new(LocalSessions::new(principal.clone()))),
                LocalAuthorizer::new(principal.id.clone()),
                Vec::new(),
            ),
            Some(oidc) => {
                let env_secret = std::env::var(OIDC_CLIENT_SECRET_ENV).ok();
                let oidc = oidc.load(env_secret).map_err(StartError::Auth)?;
                let clock: Arc<dyn Clock> = Arc::clone(&options.clock);
                let store = Arc::new(LoginSessions::new(
                    Arc::clone(&clock),
                    config.auth.limits,
                    Arc::new(SessionLog(events.clone())),
                ));
                let hooks = Arc::new(McSignIn::new(
                    &config.auth.tenant,
                    Arc::clone(&log),
                    events.clone(),
                ));
                let login = OidcLogin::new(
                    oidc,
                    config.login_routes(),
                    Arc::clone(&store),
                    hooks,
                    clock,
                )
                .map_err(|e| StartError::Auth(e.to_string()))?;
                // The IdP being unreachable is not a start failure (DOC-25 §3.2.1): the refresh
                // task retries with backoff and sign-in answers `unreachable` meanwhile.
                let tasks = vec![login.spawn_refresh(), store.spawn_sweeper(SESSION_SWEEP)];
                (
                    ServerSessions::SignIn(SignInSessions {
                        sessions: store,
                        login,
                    }),
                    LocalAuthorizer::signed_in(&config.auth.tenant),
                    tasks,
                )
            }
        };
        let hub = Arc::new(Hub::new(options.clock, options.idle_timeout));
        let state = Arc::new(AppState {
            hub: Arc::clone(&hub),
            facts: ServerFacts {
                listen: config.listen.to_string(),
                public_origin: config.public_origin.clone(),
                certificate_fingerprint: tls.fingerprint.clone(),
            },
        });
        // The router offers every call and refusal to the filter in front of the log; which reads
        // are sensitive is read from the router's own table once everything is mounted.
        let sensitive = SensitiveTable::default();
        let router = Router::new(authorizer).with_audit(McAuditSink::new(
            sink,
            sensitive.clone(),
            config.audit,
            Arc::clone(&log),
        ));
        mount(&router, &state);
        sensitive.fill(&router);
        let engine = ServerConfig::new(API_NAME, SCHEMA_HASH.as_str(), API_VERSION);

        let transport = WsTransport::new(ws_config, engine, sessions.clone(), router)
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
        let mut routes = static_ui::routes(ui, sessions.clone(), page).merge(codec);
        if let ServerSessions::SignIn(signed) = &sessions {
            routes = routes.merge(signed.login.routes());
        }
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
        events.record(&Event::ServerStart {
            version: VERSION.to_owned(),
            mode: if config.auth.oidc.is_some() {
                "oidc"
            } else {
                "local"
            }
            .to_owned(),
            exposed: config.is_exposed(),
        });
        Ok(Server {
            hub,
            sessions,
            events,
            event_task,
            retention_task,
            auth_tasks,
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

    pub fn sessions(&self) -> &ServerSessions {
        &self.sessions
    }

    /// The local browser sessions, when no sign-in is configured.
    pub fn local_sessions(&self) -> Option<&Arc<LocalSessions>> {
        match &self.sessions {
            ServerSessions::Local(local) => Some(local),
            ServerSessions::SignIn(_) => None,
        }
    }

    /// The signed-in sessions, with OIDC sign-in.
    pub fn login_sessions(&self) -> Option<&Arc<LoginSessions>> {
        match &self.sessions {
            ServerSessions::Local(_) => None,
            ServerSessions::SignIn(signed) => Some(&signed.sessions),
        }
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
        if let Some(retention) = self.retention_task.take() {
            retention.abort();
        }
        self.events.record(&Event::ServerStop);
        self.events.flush().await;
        self.event_task.abort();
        for task in self.auth_tasks.drain(..) {
            task.abort();
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
