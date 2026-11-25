//! Mightyconsole web server (Mightyconsole spec §2; plan DOC-20 sections 3 and 4).
//!
//! One binary serving the UI and `/rpc/ws` through `ambidex-axum` over rustls TLS, listening on
//! `127.0.0.1:7443` unless told otherwise. Browsers cannot speak NATS, Kafka, Kubernetes,
//! Temporal, Docker-over-SSH or (without CORS) LangGraph, so the server holds the live
//! connections; it keeps no configuration: the browser sends a profile when it connects.
//!
//! - [`tls`]: the user's certificate, or a self-signed one made on first start and reused.
//! - [`config`]: the configuration file (DOC-25 §3.6.1) behind the flags.
//! - [`sessions`]: everyone signs in (DOC-25 §3.2, through `ambidex-axum`): built-in accounts,
//!   and OIDC when `[auth.oidc]` is configured.
//! - [`authz`]: the role-based Authorizer (DOC-25 §3.3): the permission catalogue, the built-in
//!   and custom roles, assignments and group mappings with scopes, and the targets the server
//!   builds for every call.
//! - [`audit`]: the durable audit log (DOC-25 §3.5, `audit-jsonl`): the filter in front of it
//!   (Write and Destructive calls, sensitive reads, refusals), and the sign-in and server events.
//! - [`store`]: `DATA/store.redb`: the accounts, OIDC users, roles, assignments and groups
//!   (DOC-25 §3.1); [`admin`]: the default
//!   administrator and `reset-admin` (DOC-25 §3.2.7).
//! - [`core`]: live handles per connection, events, terminals, stream progress, `ToolError`.
//! - [`api`]: `app.info`, `app.events`, `term.*`.
//! - [`tools`]: one module per tool (the `echo` sample in the foundation).
//! - [`static_ui`]: the UI with its session `<meta>` and security headers.

// ToolError carries several strings for the UI; boxing it would spread through every `?` of
// every tool, as in dbee-core.
#![allow(clippy::result_large_err)]

pub mod admin;
pub mod admin_api;
pub mod api;
pub mod audit;
pub mod authz;
pub mod backup;
pub mod cli;
pub mod config;
pub mod core;
pub mod management;
pub mod profiles;
pub mod secrets;
pub mod sessions;
pub mod static_ui;
pub mod store;
pub mod tls;
pub mod tools;

use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use ambidex::codegen::{self, ApiInfo};
use ambidex::{Router, ServerConfig};
use ambidex_axum::accounts::{Accounts, AccountsConfig, PasswordHasher, Signup};
use ambidex_axum::oidc::{LoginRoutes, OidcLogin};
use ambidex_axum::{ConfigError, DEFAULT_SESSION_COOKIE, LoginSessions, WsConfig, WsTransport};
use security_types::{AuditSink, Clock, SystemClock};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::api::{
    AccountApi, AppApi, AppState, ConfirmationsApi, MeApi, ServerFacts, TermApi, TotpApi,
};
use crate::audit::{
    AuditSettings, Event, EventLog, LineWriter, McAuditSink, SensitiveTable, Stderr,
};
use crate::authz::confirm::{Confirmations, SharedConfirmations};
use crate::authz::policy::{Policy, PolicyHandle};
use crate::authz::targets::McTargets;
use crate::authz::{NoStoredProfiles, RoleAuthorizer};
use crate::config::{AuthSettings, OIDC_CLIENT_SECRET_ENV};
use crate::core::{Hub, IDLE_TIMEOUT, SWEEP_INTERVAL};
use crate::sessions::{McAccounts, McSignIn, ServerSessions, SessionLog};
use crate::store::McAccountStore;
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
    router
        .mount(MeApi(Arc::clone(state)))
        .expect("app.me registers");
    router
        .mount(AccountApi(Arc::clone(state)))
        .expect("app.account API registers");
    router
        .mount(TotpApi(Arc::clone(state)))
        .expect("app.account.totp API registers");
    router
        .mount(ConfirmationsApi(Arc::clone(state)))
        .expect("app.confirmations API registers");
    let m = state.management.clone();
    router
        .mount(admin_api::OwnSessionsApi(m.clone()))
        .expect("app.sessions API registers");
    router
        .mount(admin_api::AdminApi(m.clone()))
        .expect("admin.users API registers");
    router
        .mount(admin_api::AdminRolesApi(m.clone()))
        .expect("admin.roles API registers");
    router
        .mount(admin_api::AdminGroupsApi(m.clone()))
        .expect("admin.groups API registers");
    router
        .mount(admin_api::AdminSessionsApi(m))
        .expect("admin.sessions API registers");
    router
        .mount(secrets::api::AdminSecretsApi(state.secrets.clone()))
        .expect("admin.secrets API registers");
    router
        .mount(secrets::api::AdminBackupApi(state.secrets.clone()))
        .expect("admin.backup API registers");
    router
        .mount(profiles::api::ProfilesApi(state.profiles.clone()))
        .expect("profiles API registers");
    router
        .mount(profiles::api::SecretsApi(state.profiles.clone()))
        .expect("secrets API registers");
    router
        .mount(profiles::api::AdminProfilesApi(state.profiles.clone()))
        .expect("admin.profiles API registers");
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
        sessions: Arc::new(LoginSessions::new(
            Arc::new(SystemClock),
            ambidex_axum::SessionLimits::default(),
            Arc::new(ambidex_axum::NoSessionEvents),
        )),
        accounts: None,
        confirmations: Arc::new(Confirmations::new(Arc::new(SystemClock))),
        management: None,
        secrets: None,
        profiles: None,
    });
    let router = Router::new(RoleAuthorizer::new(
        "codegen",
        Arc::clone(&state.sessions),
        PolicyHandle::default(),
        Arc::new(NoStoredProfiles),
    ));
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
    /// The keys of the secret store (`[secrets]`, DOC-25 §3.4.4); none means the generated key.
    pub secrets: secrets::keys::SecretsSettings,
    /// `[policy]` (DOC-25 §3.6.1).
    pub policy: config::PolicySettings,
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
        self.cookie_named("__Host-mc_login")
    }

    /// `name`, with the base path in it as for the session cookie (`__Host-` needs `Path=/`).
    fn cookie_named(&self, name: &str) -> String {
        if self.base_path.is_empty() {
            name.to_owned()
        } else {
            format!("{name}{}", self.base_path.replace('/', "_"))
        }
    }

    /// The routes of the OIDC sign-in, the redirect URI included.
    pub fn login_routes(&self) -> LoginRoutes {
        let mut routes = LoginRoutes::new(self.public_origin.clone());
        routes.base_path = self.base_path.clone();
        routes.session_cookie = self.session_cookie();
        routes.login_cookie = self.login_cookie();
        routes.pre_cookie = self.cookie_named("__Host-mc_pre");
        routes.totp_cookie = self.cookie_named("__Host-mc_totp");
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
    /// `DATA/store.redb` cannot be used (DOC-25 §3.6.2 point 7): no data directory, another
    /// process holds it, an unknown schema; or the default administrator cannot be made.
    Store(String),
    /// The keys of the secret store (DOC-25 §3.6.2 point 5): a key that does not load, or an
    /// entry whose key is not configured. There is no plaintext fallback.
    Secrets(String),
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
            StartError::Store(e) => write!(f, "{e}"),
            StartError::Secrets(e) => write!(f, "secret store: {e}"),
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
    let (keys_report, keys_problems) =
        secrets::keys::check(config.data.as_deref(), &config.secrets);
    report.extend(keys_report);
    problems.extend(keys_problems);
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
        None => report.push(format!(
            "sign-in: built-in accounts{}; no [auth.oidc]",
            if config.auth.accounts {
                ""
            } else {
                " off (the default administrator only)"
            }
        )),
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

/// The tenant the audit log records in: the server's (`auth.tenant`).
pub fn audit_tenant(config: &ServeConfig) -> String {
    config.auth.tenant.clone()
}

/// Why `auth.accounts = false` without OIDC does not start (DOC-25 §3.6.2 point 1).
pub const ACCOUNTS_OFF_WITHOUT_OIDC: &str = "auth.accounts = false needs [auth.oidc]: \
     otherwise only the default administrator could sign in";

/// Why `auth.default_admin = false` does not start without a pinned administrator mapping
/// (DOC-25 §3.2.7, §3.6.2 point 1).
pub const DEFAULT_ADMIN_OFF: &str = "auth.default_admin = false needs a pinned \
     [[auth.group_roles]] entry granting admin everywhere (no scope); otherwise nobody could \
     administer this server";

/// Whether the pinned mappings make someone an administrator everywhere.
pub fn has_pinned_admin(auth: &AuthSettings) -> bool {
    auth.group_roles
        .iter()
        .any(|m| m.role == authz::catalogue::ADMIN_ROLE && m.scope.is_everywhere())
}

/// The policy at start (DOC-25 §3.3.2, §3.3.5): the store's roles, assignments, groups and
/// disabled users, `auth.default_role`, the pinned `[[auth.group_roles]]`, and the default
/// administrator's own pinned `admin` while it is on.
pub fn load_policy(store: &store::Store, auth: &AuthSettings) -> Result<Policy, String> {
    let mut parts = store
        .policy_parts()
        .map_err(|e| format!("reading the roles: {}", e.0))?;
    parts.default_role = auth.default_role.clone();
    parts.pinned = auth.group_roles.clone();
    parts.default_admin = if auth.default_admin {
        store
            .account_by_username(admin::ADMIN_USERNAME)
            .map_err(|e| format!("reading the default administrator: {}", e.0))?
            .map(|a| a.principal_id())
    } else {
        None
    };
    Ok(Policy::new(parts))
}

/// The running server's side of `reset-admin` (DOC-25 §3.2.7): performs a request, ends the
/// administrator's sessions, records `auth.admin.reset` and says where the password is.
fn reset_watcher(
    store: &Arc<store::Store>,
    data: &Path,
    hasher: PasswordHasher,
    clock: &Arc<dyn Clock>,
    sessions: &ServerSessions,
    events: &EventLog,
    log: &Arc<dyn LineWriter>,
) -> JoinHandle<()> {
    let (sessions, events, done_log, failed_log) = (
        sessions.clone(),
        events.clone(),
        Arc::clone(log),
        Arc::clone(log),
    );
    admin::watch_requests(
        Arc::clone(store),
        data.to_path_buf(),
        hasher,
        Arc::clone(clock),
        move |reset: &admin::Reset| {
            sessions.sessions.revoke_user(
                &ambidex_axum::accounts::principal_id(&reset.account),
                Some("system:server"),
            );
            events.record(&Event::AdminReset {
                via: "request".into(),
            });
            done_log.line(&format!(
                "mightyconsole-server: reset-admin: the default administrator was reset; its new \
                 password is in {}",
                reset.password_file.display()
            ));
        },
        move |error: &str| {
            failed_log.line(&format!(
                "mightyconsole-server: WARNING: reset-admin: the reset failed: {error}"
            ));
        },
    )
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
    /// The durable log (not a test's sink), checkpointed at a clean stop.
    durable_log: Option<Arc<audit_jsonl::SegmentedSink>>,
    /// The JWKS refresh and the session sweep, with sign-in; the `reset-admin` watcher.
    auth_tasks: Vec<JoinHandle<()>>,
    store: Arc<store::Store>,
    /// The secret store: its keys, the re-wrap job, the reload.
    secrets: Arc<secrets::service::SecretService>,
    /// Roles, assignments and groups in force.
    policy: PolicyHandle,
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

        // Someone can sign in (DOC-25 §3.6.2 point 1). Pinned group mappings come with roles.
        if !config.auth.accounts && config.auth.oidc.is_none() {
            return Err(StartError::Auth(ACCOUNTS_OFF_WITHOUT_OIDC.into()));
        }
        if !config.auth.default_admin && !has_pinned_admin(&config.auth) {
            return Err(StartError::Auth(DEFAULT_ADMIN_OFF.into()));
        }
        if let Some(worker) = options.jq_worker {
            core::jq::set_worker_program(worker);
        }
        let log: Arc<dyn LineWriter> = Arc::new(Stderr);
        // The store and the secret store's keys before the audit log, whose checkpoint is keyed
        // from them (DOC-25 §3.5.4).
        let data = config.data.clone().ok_or_else(|| {
            StartError::Store(
                "no data directory for the store: give --data or set MIGHTYCONSOLE_DATA".into(),
            )
        })?;
        let store = {
            let data = data.clone();
            tokio::task::spawn_blocking(move || store::Store::open(&data))
                .await
                .map_err(|e| StartError::Store(format!("opening the store panicked: {e}")))?
                .map_err(|e| StartError::Store(e.to_string()))?
        };
        let store = Arc::new(store);
        // The keys of the secret store (DOC-25 §3.4.4, §3.6.2 point 5): every configured key
        // loads and every entry's key is among them, or the server does not start.
        let vault = {
            let entries = {
                let store = Arc::clone(&store);
                tokio::task::spawn_blocking(move || secrets::entries_by_key(&store))
                    .await
                    .map_err(|e| StartError::Secrets(format!("reading the store panicked: {e}")))?
                    .map_err(|e| StartError::Secrets(e.to_string()))?
            };
            let prompt = std::io::IsTerminal::is_terminal(&std::io::stdin());
            let loaded = secrets::keys::load(&data, &config.secrets, &entries, prompt)
                .await
                .map_err(|e| StartError::Secrets(e.0))?;
            for warning in &loaded.warnings {
                log.line(&format!("mightyconsole-server: WARNING: {warning}"));
            }
            Arc::new(secrets::Vault::new(loaded.keyring, &config.auth.tenant))
        };
        // Accounts' TOTP keys are entries of the secret store (DOC-25 §3.2.6); a store of
        // TSK-142 still keeps them in the account rows, moved here once.
        store.set_vault(Arc::clone(&vault));
        {
            let store = Arc::clone(&store);
            let moved = tokio::task::spawn_blocking(move || store.migrate_totp_keys())
                .await
                .map_err(|e| StartError::Store(format!("moving TOTP keys panicked: {e}")))?
                .map_err(|e| StartError::Store(format!("moving TOTP keys: {e}")))?;
            if moved > 0 {
                log.line(&format!(
                    "mightyconsole-server: moved {moved} account TOTP key(s) into the encrypted \
                     secret store"
                ));
            }
        }
        // The audit log: a server that cannot record does not start (DOC-25 §3.6.2).
        let tenant = audit_tenant(&config);
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
                let checkpoint = Arc::new(secrets::checkpoint_keys(&vault.keyring()));
                let (durable, moved_to) = tokio::task::spawn_blocking(move || {
                    audit::open_log(&data, &settings, &tenant, Some(warn), checkpoint)
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
        let durable_log = retention_sink.clone();
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
        // The first start after a restore (DOC-25 §3.4.6): server.restore names the backup's
        // last audit record.
        match backup::take_restore_marker(&data) {
            Ok(Some(marker)) => events.record(&Event::ServerRestore {
                backup_seq: marker
                    .backup_seq
                    .map_or_else(|| "-".to_owned(), |s| s.to_string()),
                backup_hash: marker.backup_hash.unwrap_or_else(|| "-".to_owned()),
            }),
            Ok(None) => {}
            Err(e) => return Err(StartError::Store(format!("after a restore: {e}"))),
        }
        // The secret store's service: the re-wrap job (resuming a rotation a restart cut short,
        // DOC-25 §3.4.5) and the reload of the keys.
        let secret_service = Arc::new(secrets::service::SecretService::new(
            Arc::clone(&store),
            Arc::clone(&vault),
            data.clone(),
            events.clone(),
            durable_log.clone(),
        ));
        let hasher = PasswordHasher::new();
        let made = if config.auth.default_admin {
            admin::ensure(&store, &data, &hasher, options.clock.now_unix_ms())
                .await
                .map_err(|e| StartError::Store(format!("the default administrator: {e}")))?
        } else {
            None
        };
        if let Some(file) = made {
            log.line(&format!(
                "mightyconsole-server: made the default administrator `{}`; its password is in {} \
                 (in a container: docker cp <container>:/data/{} -). It must be changed at the \
                 first sign-in, and the file is then deleted.",
                admin::ADMIN_USERNAME,
                file.display(),
                admin::PASSWORD_FILE,
            ));
        }
        // Roles (DOC-25 §3.3): the store's, the configuration's, and the default administrator's
        // pinned `admin`.
        let policy = {
            let store = Arc::clone(&store);
            let auth = config.auth.clone();
            tokio::task::spawn_blocking(move || load_policy(&store, &auth).map(PolicyHandle::new))
                .await
                .map_err(|e| StartError::Store(format!("loading the roles panicked: {e}")))?
                .map_err(StartError::Store)?
        };
        // Every browser signs in (DOC-25 §3.1): one session store for the built-in accounts and
        // OIDC.
        let clock: Arc<dyn Clock> = Arc::clone(&options.clock);
        let login_sessions = Arc::new(LoginSessions::new(
            Arc::clone(&clock),
            config.auth.limits,
            Arc::new(SessionLog(events.clone())),
        ));
        let hooks = Arc::new(
            McSignIn::new(&config.auth.tenant, Arc::clone(&log), events.clone())
                .with_data(data.clone())
                .accounts_enabled(config.auth.accounts)
                .default_admin_enabled(config.auth.default_admin)
                .with_policy(Arc::clone(&store), policy.clone()),
        );
        let mut accounts_config = AccountsConfig::new("Mightyconsole");
        accounts_config.signup = if config.auth.accounts {
            config.auth.signup
        } else {
            Signup::Off
        };
        accounts_config.require_totp = config.auth.require_totp;
        let accounts = Accounts::new(
            McAccountStore(Arc::clone(&store)),
            Arc::clone(&hooks),
            Arc::clone(&login_sessions),
            config.login_routes(),
            accounts_config,
            hasher.clone(),
            Arc::clone(&clock),
        );
        let mut auth_tasks = vec![login_sessions.spawn_sweeper(SESSION_SWEEP)];
        let oidc = match &config.auth.oidc {
            None => None,
            Some(oidc) => {
                let env_secret = std::env::var(OIDC_CLIENT_SECRET_ENV).ok();
                let oidc = oidc.load(env_secret).map_err(StartError::Auth)?;
                let login = OidcLogin::new(
                    oidc,
                    config.login_routes(),
                    Arc::clone(&login_sessions),
                    Arc::clone(&hooks),
                    Arc::clone(&clock),
                )
                .map_err(|e| StartError::Auth(e.to_string()))?;
                // The IdP being unreachable is not a start failure (DOC-25 §3.2.1): the refresh
                // task retries with backoff and sign-in answers `unreachable` meanwhile, while
                // built-in accounts and the default administrator still sign in.
                auth_tasks.push(login.spawn_refresh());
                Some(login)
            }
        };
        let sessions = ServerSessions {
            sessions: Arc::clone(&login_sessions),
            accounts: Some(accounts.clone()),
            oidc,
        };
        // The destroy confirmations (DOC-25 §3.3.6): recorded by the router's approval path,
        // answered through `app.confirmations.*`, used by the Authorizer.
        let confirmations = Arc::new(Confirmations::new(Arc::clone(&clock)));
        let authorizer = RoleAuthorizer::new(
            &config.auth.tenant,
            Arc::clone(&login_sessions),
            policy.clone(),
            Arc::new(profiles::StoreOwners(Arc::clone(&store))),
        )
        .with_confirmations(Arc::clone(&confirmations));
        auth_tasks.push(reset_watcher(
            &store,
            &data,
            hasher,
            &options.clock,
            &sessions,
            &events,
            &log,
        ));
        let hub = Arc::new(Hub::new(options.clock, options.idle_timeout));
        // Profiles on the server (DOC-25 §3.4.2).
        let profile_service = Arc::new(profiles::ProfileService::new(
            Arc::clone(&store),
            Arc::clone(&vault),
            authorizer.clone(),
            Arc::clone(&hub),
            config.policy.allow_personal_profiles,
        ));
        let state = Arc::new(AppState {
            hub: Arc::clone(&hub),
            facts: ServerFacts {
                listen: config.listen.to_string(),
                public_origin: config.public_origin.clone(),
                certificate_fingerprint: tls.fingerprint.clone(),
            },
            sessions: Arc::clone(&login_sessions),
            accounts: Some(accounts.clone()),
            confirmations: Arc::clone(&confirmations),
            management: Some(Arc::new(management::Management::new(
                Arc::clone(&store),
                policy.clone(),
                Arc::clone(&login_sessions),
                Some(accounts.clone()),
            ))),
            secrets: Some(Arc::clone(&secret_service)),
            profiles: Some(profile_service),
        });
        // The router offers every call and refusal to the filter in front of the log; which reads
        // are sensitive is read from the router's own table once everything is mounted.
        let sensitive = SensitiveTable::default();
        let router = Router::with_approvals(authorizer, SharedConfirmations(confirmations))
            .with_audit(McAuditSink::new(
                sink,
                sensitive.clone(),
                config.audit,
                Arc::clone(&log),
            ))
            .with_targets(McTargets::new(Arc::clone(&hub)))
            .with_denial_details();
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
        let mut routes = static_ui::routes(ui, sessions.clone(), page)
            .merge(codec)
            .merge(accounts.routes());
        routes = match &sessions.oidc {
            Some(login) => routes.merge(login.routes()),
            None => routes.merge(accounts.logout_routes()),
        };
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
            mode: match (config.auth.accounts, config.auth.oidc.is_some()) {
                (true, true) => "accounts+oidc",
                (true, false) => "accounts",
                (false, _) => "oidc",
            }
            .to_owned(),
            exposed: config.is_exposed(),
        });
        // Last, once nothing can fail: a task left running by a refused start would hold the
        // store open.
        auth_tasks.push(secret_service.spawn_rewrap());
        Ok(Server {
            hub,
            sessions,
            events,
            event_task,
            retention_task,
            durable_log,
            auth_tasks,
            store,
            secrets: secret_service,
            policy,
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

    /// The roles, assignments and groups in force (tests change them as the management
    /// procedures will).
    pub fn policy(&self) -> &PolicyHandle {
        &self.policy
    }

    pub fn hub(&self) -> &Arc<Hub> {
        &self.hub
    }

    pub fn sessions(&self) -> &ServerSessions {
        &self.sessions
    }

    /// `DATA/store.redb`.
    pub fn store(&self) -> &Arc<store::Store> {
        &self.store
    }

    /// The secret store's keys and entries.
    pub fn vault(&self) -> &Arc<secrets::Vault> {
        &self.secrets.vault
    }

    /// The secret store's service (the re-wrap job's progress).
    pub fn secrets(&self) -> &Arc<secrets::service::SecretService> {
        &self.secrets
    }

    /// Re-reads the secret store's keys (`SIGHUP`, DOC-25 §3.4.5): switches the active key and
    /// starts the re-wrap job, or keeps the keys in force when the new ones do not load or do
    /// not open every stored entry. Returns the warnings to print.
    pub async fn reload_secrets(
        &self,
        settings: &secrets::keys::SecretsSettings,
    ) -> Result<Vec<String>, secrets::keys::KeyError> {
        self.secrets.reload(settings).await
    }

    /// The login sessions.
    pub fn login_sessions(&self) -> &Arc<LoginSessions> {
        &self.sessions.sessions
    }

    /// The built-in accounts.
    pub fn accounts(&self) -> Option<&McAccounts> {
        self.sessions.accounts.as_ref()
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
        // The checkpoint at a clean stop (DOC-25 §3.5.4).
        if let Some(log) = self.durable_log.take() {
            let _ = tokio::task::spawn_blocking(move || log.checkpoint()).await;
        }
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
