//! DBee core (DBee spec §2): the one Ambidex router both shells serve, with its procedures,
//! Authorizer, audit sink, workspace, secret store and connection manager.
//!
//! - [`api`]: the procedures of spec §5 ([`codegen_router`] is what `dbee-rpc-gen` exports).
//! - [`authz`]: the static Authorizer (the local human holds every permission).
//! - [`audit`]: the hash-chained JSON Lines sink and its verifier.
//! - [`workspace`]: `connections.json`, `settings.json`, `tabs.json`.
//! - [`secrets`]: the keychain and the session-only fallback.
//! - [`manager`]: grants, sessions, events.
//! - [`classify`]: the fail-closed SQL classifier.
//! - [`export`]: CSV, TSV and JSON Lines encoders.
//! - [`driver`]: the built-in PostgreSQL driver and the host services it needs.
//!
//! A shell builds a [`Core`] with [`Core::start`] and serves [`Core::router`] with
//! [`Core::server_config`] through its transport (`ambidex-tauri` or `ambidex-axum`).

pub mod api;
pub mod audit;
pub mod authz;
pub mod classify;
pub mod driver;
pub mod export;
pub mod manager;
pub mod secrets;
pub mod types;
pub mod workspace;

use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use ambidex::codegen::{self, ApiInfo};
use ambidex::{AuditPolicy, Router, ServerConfig};
use security_types::{AuditSink, CorrelationIdError, MemoryAuditLog, TenantId};

pub use api::{CoreState, SaveDialog};
use audit::{ContextSink, JsonlAuditSink, UnavailableAuditSink};
use authz::{DbeeAuthorizer, LOCAL_TENANT};
use driver::{BuiltinDriver, DriverFactory, Resolve, SystemResolve, postgres_driver};
use manager::{Manager, ManagerParts};
use secrets::Secrets;
pub use types::AppMode;
use workspace::Workspace;

/// The `api` the server announces in Hello.
pub const API_NAME: &str = "dbee";
/// The API version written into the generated client and announced as the server version.
pub const API_VERSION: &str = env!("CARGO_PKG_VERSION");

/// The schema hash of the DBee API, computed from the router as `dbee-rpc-gen` computes it.
pub static SCHEMA_HASH: LazyLock<String> = LazyLock::new(|| {
    codegen::schema_hash(&codegen_router(), &api_info()).expect("DBee API exports")
});

pub fn api_info() -> ApiInfo {
    ApiInfo::new(API_NAME, API_VERSION)
}

/// Where the generated `api.ts` and `api.manifest.json` are committed: `apps/dbee/ui/src/gen`.
pub fn generated_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("apps/dbee/core is inside apps/dbee")
        .join("ui/src/gen")
}

/// A random 128-bit id, hex.
pub fn random_id() -> Result<String, CorrelationIdError> {
    security_types::new_correlation_id()
}

impl From<CorrelationIdError> for secrets::SecretError {
    fn from(e: CorrelationIdError) -> Self {
        secrets::SecretError(e.to_string())
    }
}

/// How a manager operation failed: a typed domain error, the audit log being unavailable
/// (nothing happened), or an internal error whose detail stays on the server.
#[derive(Debug)]
pub enum Failure<E> {
    Domain(E),
    Unavailable,
    Internal,
}

impl<E> From<E> for Failure<E> {
    fn from(e: E) -> Self {
        Failure::Domain(e)
    }
}

/// Where passwords go.
pub enum SecretStoreConfig {
    /// Probe the OS keychain; fall back to session-only when it is unavailable (spec Open
    /// question 2).
    Auto,
    /// A given durable store (tests).
    Store(Arc<dyn secrets::SecretStore>),
    /// No durable store, with the reason shown to the user.
    SessionOnly(String),
}

/// Where audit entries go.
pub enum AuditConfig {
    /// `<workspace>/audit/log.jsonl` (the default); a log that cannot be opened makes every
    /// write fail, so recorded calls do not run.
    Workspace,
    /// A given sink (tests, the server shell's own path).
    Sink(Arc<dyn AuditSink>),
}

pub struct CoreConfig {
    pub workspace: PathBuf,
    pub mode: AppMode,
    pub secret_store: SecretStoreConfig,
    pub audit: AuditConfig,
    pub audit_policy: AuditPolicy,
    /// Host-side name resolution; the OS resolver unless a test pins answers.
    pub resolver: Arc<dyn Resolve>,
    /// The native save dialog; `None` on web.
    pub save_dialog: Option<Arc<dyn SaveDialog>>,
    /// How sessions connect; the built-in PostgreSQL driver unless a test supplies a fake.
    pub driver_factory: Option<Arc<dyn DriverFactory>>,
    /// CA certificates for grants with the deployment-CA policy. Empty means such handshakes
    /// fail (nothing is loaded implicitly).
    pub deployment_roots: Arc<rustls::RootCertStore>,
}

impl CoreConfig {
    /// Defaults for a workspace at `workspace`: keychain probed, audit in the workspace, the OS
    /// resolver, no save dialog, the built-in driver, no deployment CAs.
    pub fn new(workspace: impl Into<PathBuf>, mode: AppMode) -> CoreConfig {
        CoreConfig {
            workspace: workspace.into(),
            mode,
            secret_store: SecretStoreConfig::Auto,
            audit: AuditConfig::Workspace,
            audit_policy: AuditPolicy::default(),
            resolver: Arc::new(SystemResolve),
            save_dialog: None,
            driver_factory: None,
            deployment_roots: Arc::new(rustls::RootCertStore::empty()),
        }
    }
}

#[derive(Debug)]
pub enum CoreError {
    Workspace(workspace::WorkspaceError),
    /// The built-in driver was compiled out and no factory was given.
    NoDriver,
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CoreError::Workspace(e) => e.fmt(f),
            CoreError::NoDriver => f.write_str("no database driver is compiled in"),
        }
    }
}

impl std::error::Error for CoreError {}

/// A started core: the router both shells serve, and what they need around it.
pub struct Core {
    state: Arc<CoreState>,
    router: Router,
    audit: Arc<dyn AuditSink>,
    /// Why the workspace audit log could not be opened, if it could not.
    audit_error: Option<String>,
    secret_error: Option<String>,
}

impl Core {
    /// Opens the workspace and the audit log, probes the secret store, restores the grants and
    /// mounts the API.
    pub async fn start(config: CoreConfig) -> Result<Core, CoreError> {
        let workspace = Arc::new(Workspace::open(&config.workspace).map_err(CoreError::Workspace)?);
        let audit_path = workspace
            .audit_log_path()
            .expect("a workspace on disk has an audit path");

        let (audit, audit_error): (Arc<dyn AuditSink>, Option<String>) = match config.audit {
            AuditConfig::Sink(sink) => (sink, None),
            AuditConfig::Workspace => match JsonlAuditSink::open(&audit_path) {
                Ok(sink) => (Arc::new(sink), None),
                Err(e) => {
                    let message = e.to_string();
                    eprintln!("dbee: {message}; every recorded call will be refused");
                    (
                        Arc::new(UnavailableAuditSink(message.clone())),
                        Some(message),
                    )
                }
            },
        };
        let audit: Arc<dyn AuditSink> = Arc::new(ContextSink::new(audit));

        let (secrets, secret_error) = match config.secret_store {
            SecretStoreConfig::Store(store) => (Secrets::durable(store), None),
            SecretStoreConfig::SessionOnly(reason) => {
                (Secrets::session_only(reason.clone()), Some(reason))
            }
            SecretStoreConfig::Auto => probe_keychain().await,
        };
        let secrets = Arc::new(secrets);

        let driver = postgres_driver();
        let factory = match config.driver_factory {
            Some(factory) => factory,
            None => default_factory(&workspace, &secrets).ok_or(CoreError::NoDriver)?,
        };
        let manager = Arc::new(Manager::new(ManagerParts {
            workspace: Arc::clone(&workspace),
            secrets,
            audit: Arc::clone(&audit),
            resolver: config.resolver,
            driver,
            factory,
            tenant: TenantId::new(LOCAL_TENANT),
            deployment_roots: config.deployment_roots,
        }));
        manager.restore().await;

        let state = Arc::new(CoreState {
            manager,
            mode: config.mode,
            save_dialog: config.save_dialog,
            save_paths: Mutex::default(),
            workspace_path: config.workspace.display().to_string(),
            audit_log_path: audit_path.display().to_string(),
        });
        let router = Router::new(DbeeAuthorizer::new(TenantId::new(LOCAL_TENANT)))
            .with_audit(Arc::clone(&audit))
            .with_audit_policy(config.audit_policy);
        mount(&router, &state);
        Ok(Core {
            state,
            router,
            audit,
            audit_error,
            secret_error,
        })
    }

    /// The router: cheap to clone, clones share the registry.
    pub fn router(&self) -> Router {
        self.router.clone()
    }

    pub fn state(&self) -> &Arc<CoreState> {
        &self.state
    }

    pub fn audit(&self) -> &Arc<dyn AuditSink> {
        &self.audit
    }

    /// The engine configuration a shell serves this core with.
    pub fn server_config(&self) -> ServerConfig {
        ServerConfig::new(API_NAME, SCHEMA_HASH.as_str(), API_VERSION)
    }

    /// Why the workspace audit log is unavailable, if it is (every recorded call is refused).
    pub fn audit_error(&self) -> Option<&str> {
        self.audit_error.as_deref()
    }

    /// Why the keychain is not used, if it is not.
    pub fn secret_store_note(&self) -> Option<&str> {
        self.secret_error.as_deref()
    }
}

#[cfg(feature = "keychain")]
async fn probe_keychain() -> (Secrets, Option<String>) {
    match secrets::KeychainStore::probe().await {
        Ok(store) => (Secrets::durable(Arc::new(store)), None),
        Err(e) => {
            let reason = format!("{e}; passwords are kept for this session only");
            (Secrets::session_only(reason.clone()), Some(reason))
        }
    }
}

#[cfg(not(feature = "keychain"))]
async fn probe_keychain() -> (Secrets, Option<String>) {
    let reason = "this build has no keychain support; passwords are kept for this session only";
    (Secrets::session_only(reason), Some(reason.to_owned()))
}

#[cfg(feature = "driver-postgres")]
fn default_factory(
    workspace: &Arc<Workspace>,
    secrets: &Arc<Secrets>,
) -> Option<Arc<dyn DriverFactory>> {
    Some(Arc::new(driver::PostgresFactory {
        settings: Arc::new(driver::DbeeSettings {
            workspace: Arc::clone(workspace),
            secrets: Arc::clone(secrets),
        }),
    }))
}

#[cfg(not(feature = "driver-postgres"))]
fn default_factory(_: &Arc<Workspace>, _: &Arc<Secrets>) -> Option<Arc<dyn DriverFactory>> {
    None
}

/// Mounts every namespace of the API.
fn mount(router: &Router, state: &Arc<CoreState>) {
    router
        .mount(api::AppApi(Arc::clone(state)))
        .expect("app API registers");
    router
        .mount(api::ConnectionsApi(Arc::clone(state)))
        .expect("connections API registers");
    router
        .mount(api::SessionsApi(Arc::clone(state)))
        .expect("sessions API registers");
    router
        .mount(api::SchemaApi(Arc::clone(state)))
        .expect("schema API registers");
    router
        .mount(api::QueryApi(Arc::clone(state)))
        .expect("query API registers");
    router
        .mount(api::ExportApi(Arc::clone(state)))
        .expect("export API registers");
    router
        .mount(api::FilesApi(Arc::clone(state)))
        .expect("files API registers");
}

/// A driver factory that connects to nothing, for the codegen router.
struct NoFactory;

impl DriverFactory for NoFactory {
    fn connect<'a>(
        &'a self,
        _broker: Arc<dyn db_driver::ConnectionBroker>,
        _target_id: &'a str,
        _credential_ref: Option<&'a str>,
    ) -> db_driver::DbFuture<'a, Box<dyn db_driver::Connection>> {
        Box::pin(std::future::ready(Err(db_driver::DbError::Unsupported(
            "no driver".into(),
        ))))
    }
}

/// The router with every procedure mounted on an in-memory core that touches no file, keychain
/// or network: the one `dbee-rpc-gen` exports and [`SCHEMA_HASH`] is computed from. Its
/// registry (names, kinds, permissions, risks, timeouts, types) is identical to a started
/// core's.
pub fn codegen_router() -> Router {
    let driver: BuiltinDriver = postgres_driver();
    let secrets = Arc::new(Secrets::session_only("codegen"));
    let workspace = Arc::new(Workspace::in_memory());
    let manager = Arc::new(Manager::new(ManagerParts {
        workspace,
        secrets,
        audit: Arc::new(MemoryAuditLog::new()),
        resolver: Arc::new(SystemResolve),
        driver,
        factory: Arc::new(NoFactory),
        tenant: TenantId::new(LOCAL_TENANT),
        deployment_roots: Arc::new(rustls::RootCertStore::empty()),
    }));
    let state = Arc::new(CoreState {
        manager,
        mode: AppMode::Standalone,
        save_dialog: None,
        save_paths: Mutex::default(),
        workspace_path: String::new(),
        audit_log_path: String::new(),
    });
    let router = Router::new(DbeeAuthorizer::new(TenantId::new(LOCAL_TENANT)));
    mount(&router, &state);
    router
}
