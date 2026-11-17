//! `mightyconsole-server`: serves the UI and `/rpc/ws` until SIGINT or SIGTERM. See
//! [`mightyconsole_server::cli::USAGE`].

use std::process::ExitCode;

use mightyconsole_server::cli::{Command, USAGE, default_data_dir, parse};
use mightyconsole_server::{API_VERSION, SCHEMA_HASH, ServeConfig, Server};

fn main() -> ExitCode {
    let command = match parse(std::env::args().skip(1), default_data_dir()) {
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
                "mightyconsole-server {} (api {API_VERSION}, schema {})",
                env!("CARGO_PKG_VERSION"),
                SCHEMA_HASH.as_str()
            );
            ExitCode::SUCCESS
        }
        Command::Serve(config) => {
            let runtime = match tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(e) => {
                    eprintln!("mightyconsole-server: cannot start the runtime: {e}");
                    return ExitCode::FAILURE;
                }
            };
            runtime.block_on(serve(config))
        }
    }
}

async fn serve(config: ServeConfig) -> ExitCode {
    let exposed = config.is_exposed();
    let origin = config.public_origin.clone();
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
    match server.ui_dir() {
        Some(dir) => eprintln!("mightyconsole-server: UI from {}", dir.display()),
        None => eprintln!("mightyconsole-server: no --ui directory; serving a placeholder page"),
    }
    if exposed {
        eprintln!(
            "mightyconsole-server: WARNING: listening beyond loopback. There is no login in \
             this version: anyone who reaches this port can use every connection you open."
        );
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
