//! The server's integration tests in one test binary (TSK-155): each file of `tests/` is a module
//! here, so `support` and the generic code it instantiates (the WebSocket client, TLS, the server
//! start) compile once, not once per file. A test's name is `<file>::<fn>`, and the acceptance
//! checklists' `cargo test -- <filter>` still finds it by its function name.
//!
//! `Cargo.toml` turns off cargo's one-binary-per-file discovery (`autotests = false`) and names
//! this binary and the three that keep a process of their own, because they use state the server
//! keeps per process: `outbound` sets the process's outbound policy, `filter_worker` counts the
//! process's jq filter workers, and `messaging` keeps the process's two jq query slots busy on
//! purpose (programs that never end, results up to the output cap), which would make other
//! files' queries wait out their deadlines. A new test file is a `mod` line here, or a `[[test]]`
//! in `Cargo.toml` when it needs its own process.
//!
//! The `*_lab` modules start with `#![cfg(feature = "lab-tests")]`: plain `cargo test` leaves
//! them out.

mod support;

mod accounts;
mod admin;
mod audit;
mod audit_api;
mod backup;
mod codegen;
mod default_admin;
mod docker;
mod docker_lab;
mod e2e;
mod filter_throughput;
mod headers;
mod langgraph;
mod langgraph_budget;
mod langgraph_lab;
mod limits;
mod nats_lab;
mod profiles;
mod redaction;
mod roles;
mod routes;
mod routes_lab;
mod secrets;
mod sign_in;
mod sign_in_lab;
mod ssh_hosts;
mod startup;
mod temporal_lab;

/// Every file of `tests/` is a module here or a `[[test]]` of `Cargo.toml`: with
/// `autotests = false`, a file listed in neither would never compile or run.
#[test]
fn every_test_file_is_in_a_test_binary() {
    let crate_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let root = std::fs::read_to_string(crate_dir.join("tests/integration.rs")).unwrap();
    let manifest = std::fs::read_to_string(crate_dir.join("Cargo.toml")).unwrap();
    let mut missing = Vec::new();
    for entry in std::fs::read_dir(crate_dir.join("tests")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_none_or(|e| e != "rs") {
            continue;
        }
        let stem = path.file_stem().unwrap().to_string_lossy().into_owned();
        let built = stem == "integration"
            || root.lines().any(|l| l == format!("mod {stem};"))
            || manifest.contains(&format!("path = \"tests/{stem}.rs\""));
        if !built {
            missing.push(stem);
        }
    }
    assert!(
        missing.is_empty(),
        "test files no test binary builds: {missing:?}"
    );
}
