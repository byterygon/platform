//! The checks made before the server listens (DOC-25 §3.6.2): one message per failed condition,
//! each naming what is missing, all of them at once so an operator fixes the configuration in
//! one pass. `serve` runs them first and stops when any fails; `config check` runs the same
//! ones (and, with `--online`, asks the identity provider). They need no network, change
//! nothing and create nothing.
//!
//! What they cannot see without side effects is checked as the server opens it, and refuses the
//! start in the same way: the store (another process holds it, an unknown schema), the keys that
//! need a command or a passphrase, and the audit log's checkpoint.

use std::path::Path;
use std::sync::Arc;

use ambidex_axum::oidc::OidcLogin;
use ambidex_axum::{LoginSessions, NoSessionEvents};
use security_types::{Clock, SystemClock};

use crate::audit::{self, EventLog};
use crate::config::OIDC_CLIENT_SECRET_ENV;
use crate::sessions::McSignIn;
use crate::tls::TlsSource;
use crate::{
    ACCOUNTS_OFF_WITHOUT_OIDC, DEFAULT_ADMIN_OFF, ServeConfig, Stderr, has_pinned_admin, secrets,
    static_ui, tls,
};

/// What the checks found.
#[derive(Debug, Default)]
pub struct Preflight {
    /// What is in order, for `config check`.
    pub report: Vec<String>,
    /// One message per failed condition.
    pub problems: Vec<String>,
}

/// Runs every offline check of DOC-25 §3.6.2 on `config`.
pub fn run(config: &ServeConfig) -> Preflight {
    let mut out = Preflight::default();
    out.report.push(format!(
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
    sign_in_possible(config, &mut out);
    oidc(config, &mut out);
    certificate(config, &mut out);
    if let Some(ui) = &config.ui
        && let Err(e) = static_ui::StaticUi::open(ui)
    {
        out.problems
            .push(format!("UI directory {}: {e}", ui.display()));
    }
    data_directory(config, &mut out);
    let (report, problems) = secrets::keys::check(config.data.as_deref(), &config.secrets);
    out.report.extend(report);
    out.problems.extend(problems);
    audit_log(config, &mut out);
    out.report.push(outbound_report(&config.outbound));
    out
}

fn outbound_report(policy: &crate::core::outbound::Policy) -> String {
    format!(
        "outbound: {}; {} deny rule(s); link-local and cloud metadata addresses refused{}",
        if policy.is_narrowed() {
            format!("only {} allow rule(s)", policy.allow.len())
        } else {
            "every address".to_owned()
        },
        policy.deny.len(),
        if policy
            .allow
            .iter()
            .any(|r| matches!(r, crate::core::outbound::Rule::Net(..)))
        {
            " unless an allow network names them"
        } else {
            ""
        }
    )
}

/// What the operator should know at start although nothing is wrong (DOC-25 §3.6.2 point 3).
pub fn warnings(config: &ServeConfig) -> Vec<String> {
    let mut out = Vec::new();
    // Login is always on, so an exposed server with the generated certificate is allowed
    // (Open question 2, decided 2026-11-24): the browser's first visit is the exposure.
    if config.is_exposed() && matches!(config.tls, TlsSource::Generated { .. }) {
        out.push(
            "the certificate is self-signed: give --tls-cert and --tls-key (a first visitor \
             could be fooled by someone between them and this server)"
                .into(),
        );
    }
    out
}

/// Point 1: someone can sign in.
fn sign_in_possible(config: &ServeConfig, out: &mut Preflight) {
    if !config.auth.accounts && config.auth.oidc.is_none() {
        out.problems
            .push(format!("sign-in: {ACCOUNTS_OFF_WITHOUT_OIDC}"));
    }
    if !config.auth.default_admin && !has_pinned_admin(&config.auth) {
        out.problems.push(format!("sign-in: {DEFAULT_ADMIN_OFF}"));
    }
}

/// Point 2: the identity provider's configuration, when there is one. The IdP being unreachable
/// is not a failure (DOC-25 §3.2.1).
fn oidc(config: &ServeConfig, out: &mut Preflight) {
    match &config.auth.oidc {
        None => out.report.push(format!(
            "sign-in: built-in accounts{}; no [auth.oidc]",
            if config.auth.accounts {
                ""
            } else {
                " off (the default administrator only)"
            }
        )),
        Some(_) => match oidc_login(config) {
            Err(e) => out.problems.push(e),
            Ok(login) => out.report.push(format!(
                "sign-in: OIDC through {}; register the redirect URI {}",
                config.auth.oidc.as_ref().map_or("", |o| o.issuer.as_str()),
                login.redirect_uri()
            )),
        },
    }
}

/// The login of `[auth.oidc]`, built the way the server builds it, to check it (and, online, to
/// fetch the discovery document and keys).
pub fn oidc_login(config: &ServeConfig) -> Result<OidcLogin<Arc<McSignIn>>, String> {
    let Some(oidc) = &config.auth.oidc else {
        return Err("no [auth.oidc]".into());
    };
    let loaded = oidc.load(std::env::var(OIDC_CLIENT_SECRET_ENV).ok())?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let store = Arc::new(LoginSessions::new(
        Arc::clone(&clock),
        config.auth.limits,
        Arc::new(NoSessionEvents),
    ));
    let hooks = Arc::new(McSignIn::new(
        &config.auth.tenant,
        Arc::new(Stderr),
        EventLog::discard(),
    ));
    OidcLogin::new(loaded, config.login_routes(), store, hooks, clock)
        .map_err(|e| format!("[auth.oidc]: {e}"))
}

fn certificate(config: &ServeConfig, out: &mut Preflight) {
    match &config.tls {
        TlsSource::Files { .. } => match tls::load(&config.tls) {
            Ok(tls) => out
                .report
                .push(format!("certificate SHA-256 {}", tls.fingerprint)),
            Err(e) => out.problems.push(e.to_string()),
        },
        TlsSource::Generated { dir } => out.report.push(format!(
            "certificate: self-signed, kept in {}",
            dir.display()
        )),
    }
}

/// Point 4: the data directory is not group- or world-writable (Unix). The directory is made
/// with mode 0700 when it is missing, by the store.
fn data_directory(config: &ServeConfig, out: &mut Preflight) {
    let Some(data) = &config.data else {
        out.problems
            .push("no data directory: give --data or set MIGHTYCONSOLE_DATA".into());
        return;
    };
    if let Some(problem) = writable_by_others(data) {
        out.problems.push(problem);
    }
}

/// `path` when it exists and others than its owner can write to it.
pub fn writable_by_others(path: &Path) -> Option<String> {
    #[cfg(unix)]
    if let Ok(meta) = std::fs::metadata(path) {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o022 != 0 {
            return Some(format!(
                "data directory {} has mode {mode:04o}: it must not be group- or world-writable \
                 (chmod 700 it)",
                path.display()
            ));
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    None
}

/// Point 6: the existing log verifies. It is read, not opened, so nothing is created; the
/// checkpoint is checked as the server opens the log, with its key. `--audit-new-chain` is the
/// way past a broken log.
fn audit_log(config: &ServeConfig, out: &mut Preflight) {
    let Some(data) = &config.data else {
        return;
    };
    let dir = audit::audit_dir(data);
    let files = audit_jsonl::segment_files(&dir).unwrap_or_default();
    match audit_jsonl::check_files(&files) {
        Ok(checked) => out.report.push(format!(
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
        Err(_) if config.audit.new_chain => out.report.push(format!(
            "audit log {}: broken, and --audit-new-chain will move it aside and start a new chain",
            dir.display()
        )),
        Err(e) => out.problems.push(format!("audit log {e}")),
    }
}
