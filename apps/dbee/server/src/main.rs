//! `dbee-server`: `serve` runs the web shell until SIGINT or SIGTERM; `audit verify FILE` checks
//! an audit log's hash chain. See [`dbee_server::cli::USAGE`].

use std::process::ExitCode;

use dbee_server::cli::{Command, USAGE, parse};
use dbee_server::{SESSION_ONLY_REASON, Server};

fn main() -> ExitCode {
    let command = match parse(
        std::env::args().skip(1),
        dbee_core::workspace::default_workspace_dir(),
    ) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("dbee-server: {message}\n\n{USAGE}");
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
                "dbee-server {} (api {}, schema {})",
                env!("CARGO_PKG_VERSION"),
                dbee_core::API_VERSION,
                dbee_core::SCHEMA_HASH.as_str()
            );
            ExitCode::SUCCESS
        }
        Command::AuditVerify(path) => audit_verify(&path),
        Command::Serve(config) => {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(e) => {
                    eprintln!("dbee-server: cannot start the runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            runtime.block_on(serve(config))
        }
    }
}

fn audit_verify(path: &std::path::Path) -> ExitCode {
    println!("dbee-server audit verify: {}", path.display());
    // The sink treats a missing log as empty so it can create one; a verifier must not.
    if !path.is_file() {
        println!("chain BROKEN: {} is not a file", path.display());
        return ExitCode::FAILURE;
    }
    match dbee_core::audit::verify(path) {
        Ok(report) => {
            println!("records: {}", report.records);
            println!("unfinished calls: {}", report.unfinished.len());
            for id in &report.unfinished {
                println!("  {id}");
            }
            println!("chain OK");
            ExitCode::SUCCESS
        }
        Err(e) => {
            println!("chain BROKEN: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(config: dbee_server::ServeConfig) -> ExitCode {
    let allowed = config.allowed_hosts.join(", ");
    let origin = config.public_origin.clone();
    let workspace = config.workspace.clone();
    let server = match Server::start(config).await {
        Ok(server) => server,
        Err(e) => {
            eprintln!("dbee-server: {e}");
            return ExitCode::FAILURE;
        }
    };
    eprintln!(
        "dbee-server: listening on https://{} (allowed hosts: {allowed}; public origin: {origin})",
        server.local_addr()
    );
    eprintln!(
        "dbee-server: workspace {}, audit log {}",
        workspace.display(),
        server.core().state().audit_log_path
    );
    match server.ui_dir() {
        Some(dir) => eprintln!("dbee-server: UI from {}", dir.display()),
        None => eprintln!("dbee-server: no UI directory configured; non-RPC paths answer 404"),
    }
    eprintln!("dbee-server: secret store: {SESSION_ONLY_REASON}");
    if let Some(reason) = server.core().audit_error() {
        eprintln!("dbee-server: audit log unavailable: {reason}; every recorded call is refused");
    }
    eprintln!(
        "dbee-server: no login exists before Ambidex M3 (OIDC); every /rpc/ws upgrade is refused"
    );

    wait_for_signal().await;
    eprintln!("dbee-server: stopping");
    match server.shutdown().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("dbee-server: {e}");
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
            eprintln!("dbee-server: cannot listen for SIGTERM: {e}");
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
