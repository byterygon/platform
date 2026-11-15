//! `dbee-desktop`: the Tauri app. One tokio runtime serves the core and Tauri's async commands;
//! the window runs on the main thread.

#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

use std::process::ExitCode;
use std::time::Instant;

use dbee_desktop::{Desktop, local_identity};
use tauri::RunEvent;

fn main() -> ExitCode {
    let started = Instant::now();
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("dbee-desktop: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    tauri::async_runtime::set(runtime.handle().clone());

    let identity = match local_identity() {
        Ok(identity) => identity,
        Err(e) => {
            eprintln!("dbee-desktop: {e}");
            return ExitCode::FAILURE;
        }
    };
    let Some(workspace) = dbee_core::workspace::default_workspace_dir() else {
        eprintln!("dbee-desktop: no data directory on this platform and DBEE_WORKSPACE is unset");
        return ExitCode::FAILURE;
    };
    let desktop =
        match runtime.block_on(Desktop::start(workspace.clone(), identity, started, |_| {})) {
            Ok(desktop) => desktop,
            Err(e) => {
                eprintln!("dbee-desktop: {e}");
                return ExitCode::FAILURE;
            }
        };
    eprintln!(
        "dbee-desktop: workspace {}, audit log {}",
        workspace.display(),
        desktop.core().state().audit_log_path
    );
    if let Some(note) = desktop.core().secret_store_note() {
        eprintln!("dbee-desktop: {note}");
    }
    if let Some(reason) = desktop.core().audit_error() {
        eprintln!("dbee-desktop: audit log unavailable: {reason}; every recorded call is refused");
    }
    eprintln!(
        "dbee-desktop: core ready {} ms after process start",
        started.elapsed().as_millis()
    );

    let app = match desktop
        .configure(tauri::Builder::default())
        .build(tauri::generate_context!())
    {
        Ok(app) => app,
        Err(e) => {
            eprintln!("dbee-desktop: cannot build the app: {e}");
            return ExitCode::FAILURE;
        }
    };
    app.run(move |_app, event| {
        if let RunEvent::Ready = event {
            eprintln!(
                "dbee-desktop: window ready {} ms after process start",
                started.elapsed().as_millis()
            );
        }
    });
    ExitCode::SUCCESS
}
