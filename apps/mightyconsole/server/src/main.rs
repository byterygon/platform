//! `mightyconsole-server`: serves the UI and `/rpc/ws` until SIGINT or SIGTERM. See
//! [`mightyconsole_server::cli::USAGE`].

use std::process::ExitCode;

use mightyconsole_server::cli::{Command, Env, USAGE, parse};
use mightyconsole_server::tls::TlsSource;
use mightyconsole_server::{API_VERSION, SCHEMA_HASH, ServeConfig, ServedUi, Server, VERSION};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // A query's child process (spec §5.4.1): no runtime, no configuration, one run.
    if args.first().map(String::as_str) == Some(mightyconsole_server::core::jq::WORKER_ARG) {
        return ExitCode::from(mightyconsole_server::core::jq::worker_main(&args[1..]));
    }
    let command = match parse(args, &Env::from_process()) {
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
        Command::Serve(config) => match runtime() {
            Some(runtime) => runtime.block_on(serve(config)),
            None => ExitCode::FAILURE,
        },
        Command::ConfigCheck { config, online } => match runtime() {
            Some(runtime) => runtime.block_on(config_check(config, online)),
            None => ExitCode::FAILURE,
        },
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

async fn serve(config: ServeConfig) -> ExitCode {
    let exposed = config.is_exposed();
    let sign_in = config.auth.oidc.as_ref().map(|oidc| oidc.issuer.clone());
    let redirect_uri = config.login_routes().redirect_uri();
    let generated_cert = matches!(config.tls, TlsSource::Generated { .. });
    let origin = format!("{}{}", config.public_origin, config.base_path);
    let hosts = config.allowed_hosts.join(", ");
    let server = match Server::start(config).await {
        Ok(server) => server,
        Err(e) => {
            eprintln!("mightyconsole-server: {e}");
            return ExitCode::FAILURE;
        }
    };
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
    match &sign_in {
        Some(issuer) => {
            eprintln!(
                "mightyconsole-server: sign-in through {issuer} (redirect URI {redirect_uri})"
            );
            eprintln!(
                "mightyconsole-server: WARNING: roles are not built yet: every signed-in person \
                 may do everything"
            );
            if exposed && generated_cert {
                eprintln!(
                    "mightyconsole-server: WARNING: the certificate is self-signed: give \
                     --tls-cert and --tls-key"
                );
            }
        }
        None if exposed => eprintln!(
            "mightyconsole-server: WARNING: listening beyond loopback without [auth.oidc]: \
             there is no login, anyone who reaches this port can use every connection you open."
        ),
        None => {}
    }
    eprintln!("mightyconsole-server: open {origin}/");

    wait_for_signal().await;
    eprintln!("mightyconsole-server: stopping");
    match server.shutdown().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("mightyconsole-server: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(unix)]
async fn wait_for_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = match signal(SignalKind::terminate()) {
        Ok(term) => term,
        Err(e) => {
            eprintln!("mightyconsole-server: cannot listen for SIGTERM: {e}");
            let _ = tokio::signal::ctrl_c().await;
            return;
        }
    };
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
}

#[cfg(not(unix))]
async fn wait_for_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
