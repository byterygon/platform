//! `mightyconsole-server`: serves the UI and `/rpc/ws` until SIGINT or SIGTERM. See
//! [`mightyconsole_server::cli::USAGE`].

use std::process::ExitCode;

use mightyconsole_server::cli::{AuditTarget, Command, Env, USAGE, parse};
use mightyconsole_server::{API_VERSION, SCHEMA_HASH, ServeConfig, ServedUi, Server, VERSION};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A query's child process (spec §5.4.1): no runtime, no configuration, one run.
    if args.first().map(String::as_str) == Some(mightyconsole_server::core::jq::WORKER_ARG) {
        return ExitCode::from(mightyconsole_server::core::jq::worker_main(&args[1..]));
    }
    let command = match parse(args.clone(), &Env::from_process()) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("mightyconsole-server: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match command {
        Command::Help => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Command::Version => {
            println!(
                "mightyconsole-server {VERSION} (api {API_VERSION}, schema {})",
                SCHEMA_HASH.as_str()
            );
            ExitCode::SUCCESS
        }
        Command::AuditVerify(target) => audit_verify(&target),
        Command::Serve(config) => match runtime() {
            Some(runtime) => runtime.block_on(serve(config, args)),
            None => ExitCode::FAILURE,
        },
        Command::ResetAdmin { config, print } => match runtime() {
            Some(runtime) => runtime.block_on(reset_admin(config, print)),
            None => ExitCode::FAILURE,
        },
        Command::ConfigCheck { config, online } => match runtime() {
            Some(runtime) => runtime.block_on(config_check(config, online)),
            None => ExitCode::FAILURE,
        },
        Command::KeysGenerate { out } => keys_generate(&out),
        Command::SecretsStatus { config } => secrets_status(&config),
        Command::Restore {
            config,
            archive,
            check_secrets,
        } => match runtime() {
            Some(runtime) => runtime.block_on(restore(config, archive, check_secrets)),
            None => ExitCode::FAILURE,
        },
    }
}

/// `keys generate --out FILE` (DOC-25 §3.6.4): 32 random bytes in base64, mode 0600. Prints the
/// key's id, never the key.
fn keys_generate(out: &std::path::Path) -> ExitCode {
    match mightyconsole_server::secrets::keys::generate_file(out) {
        Ok(id) => {
            println!("wrote key {id} to {}", out.display());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("mightyconsole-server: keys generate: {e}");
            ExitCode::FAILURE
        }
    }
}

/// `restore --data DIR [--check-secrets] FILE.tar` (DOC-25 §3.4.6): unpack into a new directory,
/// check the store and the audit chain; with --check-secrets, decrypt every entry with the
/// configured keys and name the failures (owner and field, never a value).
async fn restore(
    config: ServeConfig,
    archive: std::path::PathBuf,
    check_secrets: bool,
) -> ExitCode {
    let data = config.data.clone().expect("parse requires --data");
    let unpacked = {
        let (archive, data) = (archive.clone(), data.clone());
        tokio::task::spawn_blocking(move || mightyconsole_server::backup::restore(&archive, &data))
            .await
    };
    let restored = match unpacked {
        Ok(Ok(restored)) => restored,
        Ok(Err(e)) => {
            eprintln!("mightyconsole-server: restore: {e}");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("mightyconsole-server: restore: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "restored {} file(s) into {}: the store opens, the audit log is intact ({} records{})",
        restored.files,
        data.display(),
        restored.audit_records,
        restored
            .marker
            .backup_seq
            .map(|s| format!(", up to seq {s}"))
            .unwrap_or_default()
    );
    if check_secrets {
        let keyring = match mightyconsole_server::secrets::keys::load_existing(
            &data,
            &config.secrets,
        )
        .await
        {
            Ok(Some(keyring)) => keyring,
            Ok(None) => {
                eprintln!(
                    "mightyconsole-server: restore --check-secrets: no key is configured \
                         ([[secrets.keys]]) and DATA/keys holds none: provide the keys first"
                );
                return ExitCode::FAILURE;
            }
            Err(e) => {
                eprintln!("mightyconsole-server: restore --check-secrets: the keys: {e}");
                return ExitCode::FAILURE;
            }
        };
        let vault = mightyconsole_server::secrets::Vault::new(keyring, &config.auth.tenant);
        match mightyconsole_server::backup::check_secrets(&data, &vault) {
            Ok(failures) if failures.is_empty() => {
                println!("every stored secret decrypts with the configured keys");
            }
            Ok(failures) => {
                for (owner, field, why) in &failures {
                    eprintln!("secret {field} of {owner}: {why}");
                }
                eprintln!(
                    "mightyconsole-server: restore: {} secret(s) do not decrypt",
                    failures.len()
                );
                return ExitCode::FAILURE;
            }
            Err(e) => {
                eprintln!("mightyconsole-server: restore --check-secrets: {e}");
                return ExitCode::FAILURE;
            }
        }
    }
    println!(
        "provide the keys, then start the server with --data {}",
        data.display()
    );
    ExitCode::SUCCESS
}

/// `secrets status` (DOC-25 §3.4.5): the stored secrets by key, with the server stopped.
fn secrets_status(config: &ServeConfig) -> ExitCode {
    use mightyconsole_server::store::{OpenError, Store};
    let data = config
        .data
        .clone()
        .expect("parse requires a data directory");
    let store = match Store::open(&data) {
        Ok(store) => store,
        Err(OpenError::Locked(path)) => {
            eprintln!(
                "mightyconsole-server: secrets status: {} is open in a running server; stop it, \
                 or ask the server (admin.secrets.status)",
                path.display()
            );
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("mightyconsole-server: secrets status: {e}");
            return ExitCode::FAILURE;
        }
    };
    match mightyconsole_server::secrets::status_report(&store, &data, &config.secrets) {
        Ok(lines) => {
            for line in lines {
                println!("{line}");
            }
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("mightyconsole-server: secrets status: {e}");
            ExitCode::FAILURE
        }
    }
}

/// The checkpoint line of `audit verify` (DOC-25 §3.5.5): checked when the data directory's
/// keys load without a prompt (the generated key, key files, a passphrase file or variable, a
/// command), otherwise "not checked" and why. `Err` is a break.
fn checkpoint(
    target: &AuditTarget,
    files: &[std::path::PathBuf],
    checked: &audit_jsonl::Checked,
) -> Result<String, String> {
    use audit_jsonl::checkpoint::Verdict;
    const UNANCHORED: &str = "so a log cut at its end cannot be told from a shorter one";
    let AuditTarget::Dir(data) = target else {
        return Ok(format!(
            "checkpoint: not checked (files given, not a data directory: {UNANCHORED})"
        ));
    };
    let dir = mightyconsole_server::audit::audit_dir(data);
    let Some(runtime) = runtime() else {
        return Ok("checkpoint: not checked (no runtime)".into());
    };
    let config = mightyconsole_server::cli::serve_config_for(data, &Env::from_process());
    let keyring = match config {
        Err(e) => return Ok(format!("checkpoint: not checked (the configuration: {e})")),
        Ok(config) => runtime.block_on(mightyconsole_server::secrets::keys::load_existing(
            data,
            &config.secrets,
        )),
    };
    let keyring = match keyring {
        Ok(Some(keyring)) => keyring,
        Ok(None) => {
            return Ok(format!(
                "checkpoint: not checked (no secret key in this data directory: {UNANCHORED})"
            ));
        }
        Err(e) => return Ok(format!("checkpoint: not checked (the keys: {e})")),
    };
    let keys = mightyconsole_server::secrets::checkpoint_keys(&keyring);
    match audit_jsonl::check::check_checkpoint(&dir, files, checked, &keys) {
        Ok(Verdict::Intact { seq }) => Ok(format!(
            "checkpoint: intact (the log reaches seq {seq}, which the checkpoint names)"
        )),
        Ok(Verdict::Absent) => Ok(format!("checkpoint: none yet ({UNANCHORED})")),
        Ok(Verdict::NotChecked { kek_id }) => Ok(format!(
            "checkpoint: not checked (made with key {kek_id}, which is not configured)"
        )),
        Ok(other) => Err(format!("checkpoint: {other:?}")),
        Err(audit_jsonl::CheckError::Broken(b)) => Err(b.to_string()),
        Err(audit_jsonl::CheckError::Io { path, error }) => Ok(format!(
            "checkpoint: not checked ({}: {error})",
            path.display()
        )),
    }
}

/// `audit verify` (DOC-25 §3.5.5): the chain across the files, the first break with its file,
/// line, `seq` and kind. Exit 0 when intact, 1 when broken, 2 on a read error.
fn audit_verify(target: &AuditTarget) -> ExitCode {
    let files = match target {
        AuditTarget::Files(files) => files.clone(),
        AuditTarget::Dir(data) => {
            // The data directory, or the audit directory itself.
            let dir = if data.join(mightyconsole_server::audit::AUDIT_DIR).is_dir() {
                mightyconsole_server::audit::audit_dir(data)
            } else {
                data.clone()
            };
            match audit_jsonl::segment_files(&dir) {
                Ok(files) => files,
                Err(e) => {
                    eprintln!("mightyconsole-server: audit verify: {}: {e}", dir.display());
                    return ExitCode::from(2);
                }
            }
        }
    };
    if files.is_empty() {
        eprintln!("mightyconsole-server: audit verify: no audit-<n>.jsonl files to check");
        return ExitCode::from(2);
    }
    match audit_jsonl::check_files(&files) {
        Ok(checked) => {
            println!(
                "audit log intact: {} records in {} file(s){}{}",
                checked.records,
                checked.segments.len(),
                match (checked.first_seq, checked.head) {
                    (Some(first), Some((last, _))) => format!(", seq {first} to {last}"),
                    _ => String::new(),
                },
                if checked.retentions > 0 {
                    format!(
                        ", {} retention anchor(s): older segments were deleted by policy",
                        checked.retentions
                    )
                } else {
                    String::new()
                }
            );
            if checked.new_chains > 0 {
                println!(
                    "{} new chain(s) started after a broken log (audit.new_chain)",
                    checked.new_chains
                );
            }
            if !checked.unfinished.is_empty() {
                println!(
                    "{} admission(s) without a completion (outcome unknown: the process stopped or the write failed): {}",
                    checked.unfinished.len(),
                    checked.unfinished.join(", ")
                );
            }
            match checkpoint(target, &files, &checked) {
                Ok(line) => {
                    println!("{line}");
                    ExitCode::SUCCESS
                }
                Err(broken) => {
                    eprintln!("audit log BROKEN: {broken}");
                    ExitCode::from(1)
                }
            }
        }
        Err(audit_jsonl::CheckError::Broken(broken)) => {
            eprintln!("audit log BROKEN: {broken}");
            ExitCode::from(1)
        }
        Err(audit_jsonl::CheckError::Io { path, error }) => {
            eprintln!(
                "mightyconsole-server: audit verify: {}: {error}",
                path.display()
            );
            ExitCode::from(2)
        }
    }
}

fn runtime() -> Option<tokio::runtime::Runtime> {
    match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => Some(runtime),
        Err(e) => {
            eprintln!("mightyconsole-server: cannot start the runtime: {e}");
            None
        }
    }
}

/// `config check [--online]` (DOC-25 §3.6.1): everything that needs no network, and with
/// `--online` the IdP's discovery and keys. Never listens.
async fn config_check(config: ServeConfig, online: bool) -> ExitCode {
    match mightyconsole_server::check_config(&config, online).await {
        Ok(report) => {
            for line in report {
                println!("{line}");
            }
            println!("configuration ok");
            ExitCode::SUCCESS
        }
        Err(problems) => {
            for problem in problems {
                eprintln!("mightyconsole-server: {problem}");
            }
            ExitCode::FAILURE
        }
    }
}

/// `serve`. `args` are the command line, read again at `SIGHUP` for `[secrets]`.
async fn serve(config: ServeConfig, args: Vec<String>) -> ExitCode {
    // No core files with decrypted secrets in them (DOC-25 §3.4.3).
    if let Err(e) = mightyconsole_server::secrets::disable_core_dumps() {
        eprintln!("mightyconsole-server: WARNING: {e}");
    }
    let warnings = mightyconsole_server::preflight::warnings(&config);
    let sign_in = config.auth.oidc.as_ref().map(|oidc| oidc.issuer.clone());
    let accounts = config.auth.accounts;
    let signup_open = config.auth.signup == ambidex_axum::accounts::Signup::Open;
    let redirect_uri = config.login_routes().redirect_uri();
    let origin = format!("{}{}", config.public_origin, config.base_path);
    let hosts = config.allowed_hosts.join(", ");
    let server = match Server::start(config).await {
        Ok(server) => server,
        Err(e) => {
            eprintln!("mightyconsole-server: {e}");
            return ExitCode::FAILURE;
        }
    };
    // Before "listening on": a signal sent as soon as that line is out must find its handler, or
    // it would take its default action and end the process (TSK-155).
    let signals = Signals::listen();
    let tls = server.tls();
    if tls.generated_now {
        eprintln!(
            "mightyconsole-server: made a self-signed certificate at {}; trust it in the \
             browser once, or start with --tls-cert/--tls-key (e.g. from mkcert)",
            tls.cert_path.display()
        );
    }
    eprintln!(
        "mightyconsole-server: listening on {} (accepted hosts: {hosts})",
        server.local_addr()
    );
    eprintln!(
        "mightyconsole-server: certificate SHA-256 {}",
        tls.fingerprint
    );
    match server.ui() {
        ServedUi::Dir(dir) => eprintln!("mightyconsole-server: UI from {}", dir.display()),
        ServedUi::Embedded { files } => {
            eprintln!("mightyconsole-server: {VERSION}, UI built in ({files} files)")
        }
        ServedUi::Placeholder => {
            eprintln!("mightyconsole-server: no --ui directory; serving a placeholder page")
        }
    }
    if let Some(issuer) = &sign_in {
        eprintln!("mightyconsole-server: sign-in through {issuer} (redirect URI {redirect_uri})");
    }
    eprintln!(
        "mightyconsole-server: built-in accounts: {}; sign-up {}",
        if accounts {
            "on"
        } else {
            "off (the default administrator only)"
        },
        if accounts && signup_open {
            "open"
        } else {
            "off"
        }
    );
    // DOC-25 §3.6.2 point 3 (Open question 2): allowed, with a warning.
    for warning in warnings {
        eprintln!("mightyconsole-server: WARNING: {warning}");
    }
    eprintln!("mightyconsole-server: open {origin}/");

    run_until_stopped(&server, &args, signals).await;
    eprintln!("mightyconsole-server: stopping");
    match server.shutdown().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("mightyconsole-server: {e}");
            ExitCode::FAILURE
        }
    }
}

/// The signals `serve` stops (SIGTERM, SIGINT) or reloads (SIGHUP) on, listened for from
/// [`Signals::listen`] on: one that comes before [`run_until_stopped`] waits is kept for it.
#[cfg(unix)]
struct Signals {
    term: Option<tokio::signal::unix::Signal>,
    int: Option<tokio::signal::unix::Signal>,
    hup: Option<tokio::signal::unix::Signal>,
}

#[cfg(unix)]
impl Signals {
    fn listen() -> Self {
        use tokio::signal::unix::{SignalKind, signal};
        let listen = |kind: SignalKind, what: &str| {
            signal(kind)
                .map_err(|e| eprintln!("mightyconsole-server: cannot listen for {what}: {e}"))
                .ok()
        };
        Self {
            term: listen(SignalKind::terminate(), "SIGTERM"),
            int: listen(SignalKind::interrupt(), "SIGINT"),
            hup: listen(SignalKind::hangup(), "SIGHUP (key reload)"),
        }
    }
}

/// The next of these signals; never, once it cannot come.
#[cfg(unix)]
async fn next(signal: &mut Option<tokio::signal::unix::Signal>) {
    if let Some(s) = signal {
        if s.recv().await.is_some() {
            return;
        }
        *signal = None;
    }
    std::future::pending().await
}

/// Waits for SIGINT or SIGTERM; on Unix, SIGHUP reloads the secret store's keys meanwhile
/// (DOC-25 §3.4.5): the configuration is read again, `[secrets]` only is applied.
#[cfg(unix)]
async fn run_until_stopped(server: &Server, args: &[String], mut signals: Signals) {
    loop {
        tokio::select! {
            () = next(&mut signals.term) => return,
            () = next(&mut signals.int) => return,
            () = next(&mut signals.hup) => reload_secrets(server, args).await,
        }
    }
}

#[cfg(not(unix))]
struct Signals;

#[cfg(not(unix))]
impl Signals {
    fn listen() -> Self {
        Self
    }
}

#[cfg(not(unix))]
async fn run_until_stopped(_server: &Server, _args: &[String], _signals: Signals) {
    let _ = tokio::signal::ctrl_c().await;
}

/// SIGHUP: the keys of `[secrets]` from the configuration as it is now.
#[cfg(unix)]
async fn reload_secrets(server: &Server, args: &[String]) {
    let settings = match parse(args.to_vec(), &Env::from_process()) {
        Ok(Command::Serve(config)) => config.secrets,
        Ok(_) => return,
        Err(e) => {
            eprintln!(
                "mightyconsole-server: WARNING: the secret keys were not reloaded: the \
                 configuration: {e}"
            );
            return;
        }
    };
    match server.reload_secrets(&settings).await {
        Ok(warnings) => {
            for warning in warnings {
                eprintln!("mightyconsole-server: WARNING: {warning}");
            }
            eprintln!(
                "mightyconsole-server: reloaded the secret keys: active {}, loaded {}",
                server.vault().keyring().active().id(),
                server.vault().keyring().ids().join(", ")
            );
        }
        Err(e) => eprintln!(
            "mightyconsole-server: WARNING: the secret keys were not reloaded (the keys in \
             force stay): {e}"
        ),
    }
}

/// `reset-admin [--print]` (DOC-25 §3.2.7): with the server stopped, the store is opened here and
/// `auth.admin.reset` (via stopped) goes to the audit log; with it running (the store is
/// locked), the server is asked through `DATA/reset-admin.request` and performs it. Never listens.
async fn reset_admin(config: ServeConfig, print: bool) -> ExitCode {
    use mightyconsole_server::admin::{self, REQUEST_WAIT};
    use mightyconsole_server::store::{OpenError, Store};
    let Some(data) = config.data.clone() else {
        eprintln!("mightyconsole-server: reset-admin: no data directory");
        return ExitCode::from(2);
    };
    if !config.auth.default_admin {
        eprintln!(
            "mightyconsole-server: reset-admin: auth.default_admin = false: the default administrator is turned off"
        );
        return ExitCode::FAILURE;
    }
    let opened = {
        let data = data.clone();
        tokio::task::spawn_blocking(move || Store::open(&data)).await
    };
    let file = match opened {
        Ok(Ok(store)) => {
            // Stopped: the secret keys (the administrator's TOTP key is a stored secret, and the
            // audit checkpoint is keyed from them), loaded as they are: none is made here.
            let keyring =
                match mightyconsole_server::secrets::keys::load_existing(&data, &config.secrets)
                    .await
                {
                    Ok(keyring) => keyring,
                    Err(e) => {
                        eprintln!("mightyconsole-server: reset-admin: the secret keys: {e}");
                        return ExitCode::FAILURE;
                    }
                };
            let checkpoint = std::sync::Arc::new(
                keyring
                    .as_ref()
                    .map(mightyconsole_server::secrets::checkpoint_keys)
                    .unwrap_or_default(),
            );
            if let Some(keyring) = keyring {
                store.set_vault(std::sync::Arc::new(
                    mightyconsole_server::secrets::Vault::new(keyring, &config.auth.tenant),
                ));
            }
            // Then the audit log, as at a start: a reset that cannot be recorded does not happen.
            let tenant = mightyconsole_server::audit_tenant(&config);
            let (settings, log_data) = (config.audit, data.clone());
            let opened = tokio::task::spawn_blocking(move || {
                mightyconsole_server::audit::open_log(
                    &log_data, &settings, &tenant, None, checkpoint,
                )
            })
            .await;
            let sink = match opened {
                Ok(Ok((sink, _))) => std::sync::Arc::new(sink),
                Ok(Err(e)) => {
                    eprintln!("mightyconsole-server: reset-admin: audit log: {e}");
                    return ExitCode::FAILURE;
                }
                Err(e) => {
                    eprintln!("mightyconsole-server: reset-admin: audit log: {e}");
                    return ExitCode::FAILURE;
                }
            };
            let store = std::sync::Arc::new(store);
            let hasher = ambidex_axum::accounts::PasswordHasher::new();
            let reset =
                match admin::reset(&store, &data, &hasher, security_types::unix_now_ms()).await {
                    Ok(reset) => reset,
                    Err(e) => {
                        eprintln!("mightyconsole-server: reset-admin: {e}");
                        return ExitCode::FAILURE;
                    }
                };
            let (events, task) = mightyconsole_server::audit::EventLog::spawn(
                sink,
                &mightyconsole_server::audit_tenant(&config),
                false,
                std::sync::Arc::new(mightyconsole_server::audit::Stderr),
            );
            events.record(&mightyconsole_server::audit::Event::AdminReset {
                via: "stopped".into(),
            });
            events.flush().await;
            task.abort();
            reset.password_file
        }
        Ok(Err(OpenError::Locked(_))) => {
            eprintln!(
                "mightyconsole-server: reset-admin: the server is running; asking it (up to {} s)",
                REQUEST_WAIT.as_secs()
            );
            if let Err(e) = admin::request_and_wait(&data, REQUEST_WAIT).await {
                eprintln!("mightyconsole-server: reset-admin: {e}");
                return ExitCode::FAILURE;
            }
            admin::password_file(&data)
        }
        Ok(Err(e)) => {
            eprintln!("mightyconsole-server: reset-admin: {e}");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("mightyconsole-server: reset-admin: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!(
        "the default administrator `{}` was reset; its new password is in {} and must be changed at the next sign-in",
        admin::ADMIN_USERNAME,
        file.display()
    );
    if print {
        match std::fs::read_to_string(&file) {
            Ok(password) => println!("{}", password.trim()),
            Err(e) => {
                eprintln!("mightyconsole-server: reset-admin: {}: {e}", file.display());
                return ExitCode::FAILURE;
            }
        }
    }
    ExitCode::SUCCESS
}
