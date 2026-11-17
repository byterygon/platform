//! The committed `apps/mightyconsole/ui/src/gen/{api.ts,api.manifest.json}` are current
//! (Ambidex spec §2: CI fails on drift), and the procedures have the kinds, risks, timeouts and
//! agent exposure of Mightyconsole spec §2.4 and §2.7.

use std::time::Duration;

use ambidex::codegen;
use ambidex::{Agent, ProcedureKind};
use mightyconsole_server::{SCHEMA_HASH, api_info, codegen_router, generated_dir};
use security_types::Risk;

#[test]
fn committed_artifacts_match_the_router() {
    let output =
        codegen::generate(&codegen_router(), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let stale = codegen::check(&output, &generated_dir()).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        stale.is_empty(),
        "stale generated files {stale:?}; regenerate with `cargo run -p mightyconsole-rpc-gen`"
    );
    assert_eq!(output.schema_hash, *SCHEMA_HASH);
}

#[test]
fn the_procedures_of_the_spec() {
    let defaults = (
        Some(Duration::from_secs(30)),
        Some(Duration::from_secs(300)),
    );
    let live = (
        Some(Duration::from_secs(30)),
        Some(Duration::from_secs(12 * 3600)),
    );
    use ProcedureKind::{Mutation, Query, Stream, Subscription};
    let expected = [
        (
            "app.events",
            Subscription,
            "app.read",
            Risk::Read,
            (None, None),
        ),
        ("app.info", Query, "app.read", Risk::Read, defaults),
        ("echo.connect", Mutation, "echo.read", Risk::Read, defaults),
        (
            "echo.disconnect",
            Mutation,
            "echo.read",
            Risk::Read,
            defaults,
        ),
        ("echo.ping", Query, "echo.read", Risk::Read, defaults),
        ("echo.shell", Stream, "echo.write", Risk::Write, live),
        ("echo.ticks", Stream, "echo.read", Risk::Read, live),
        ("term.resize", Mutation, "term.write", Risk::Write, defaults),
        ("term.signal", Mutation, "term.write", Risk::Write, defaults),
        ("term.write", Mutation, "term.write", Risk::Write, defaults),
    ];
    let mut procedures = codegen_router().procedures();
    procedures.sort_by(|a, b| a.name.cmp(&b.name));
    let names: Vec<&str> = procedures.iter().map(|m| m.name.as_str()).collect();
    assert_eq!(names, expected.map(|row| row.0));
    for (meta, (name, kind, perm, risk, timeouts)) in procedures.iter().zip(expected) {
        assert_eq!(meta.kind, kind, "{name}");
        assert_eq!(meta.perm.as_str(), perm, "{name}");
        assert_eq!(meta.risk, risk, "{name}");
        assert_eq!(
            meta.agent,
            Agent::Hidden,
            "{name}: every procedure is hidden"
        );
        assert_eq!((meta.timeout_default, meta.timeout_max), timeouts, "{name}");
        assert!(!meta.log_input, "{name}: inputs are never logged");
    }
    let redact = |name: &str| {
        procedures
            .iter()
            .find(|m| m.name == name)
            .unwrap()
            .redact
            .clone()
    };
    assert_eq!(redact("term.write"), ["data"]);
    assert_eq!(redact("echo.connect"), ["profile.token"]);
}
