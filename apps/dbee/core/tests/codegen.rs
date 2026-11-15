//! The committed `apps/dbee/ui/src/gen/{api.ts,api.manifest.json}` are current (Ambidex spec
//! §2: CI fails on drift), and describe the router both shells serve (DBee spec §5).

use ambidex::codegen;
use ambidex::{Agent, ProcedureKind};
use dbee_core::{SCHEMA_HASH, api_info, codegen_router, generated_dir};
use security_types::Risk;
use std::time::Duration;

#[test]
fn committed_artifacts_match_the_router() {
    let output =
        codegen::generate(&codegen_router(), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let stale = codegen::check(&output, &generated_dir()).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        stale.is_empty(),
        "stale generated files {stale:?}; regenerate with `cargo run -p dbee-rpc-gen`"
    );
    assert_eq!(output.schema_hash, *SCHEMA_HASH);
}

/// The table of DBee spec §5: name, kind, permission, risk, agent exposure, timeouts.
#[test]
fn the_seventeen_procedures_of_the_spec() {
    let min = |m: u64| Some(Duration::from_secs(m * 60));
    let defaults = (Some(Duration::from_secs(30)), min(5));
    type Row = (
        &'static str,
        ProcedureKind,
        &'static str,
        Risk,
        Agent,
        (Option<Duration>, Option<Duration>),
    );
    let expected: Vec<Row> = vec![
        (
            "app.events",
            ProcedureKind::Subscription,
            "app.read",
            Risk::Read,
            Agent::Hidden,
            (None, None),
        ),
        (
            "app.info",
            ProcedureKind::Query,
            "app.read",
            Risk::Read,
            Agent::Hidden,
            defaults,
        ),
        (
            "connections.create",
            ProcedureKind::Mutation,
            "connections.create",
            Risk::Write,
            Agent::Hidden,
            defaults,
        ),
        (
            "connections.delete",
            ProcedureKind::Mutation,
            "connections.delete",
            Risk::Destructive,
            Agent::Hidden,
            defaults,
        ),
        (
            "connections.list",
            ProcedureKind::Query,
            "connections.read",
            Risk::Read,
            Agent::Exposed,
            defaults,
        ),
        (
            "connections.prepare",
            ProcedureKind::Mutation,
            "connections.create",
            Risk::Write,
            Agent::Hidden,
            defaults,
        ),
        (
            "connections.setSecret",
            ProcedureKind::Mutation,
            "connections.update",
            Risk::Write,
            Agent::Hidden,
            defaults,
        ),
        (
            "connections.update",
            ProcedureKind::Mutation,
            "connections.update",
            Risk::Write,
            Agent::Hidden,
            defaults,
        ),
        (
            "export.run",
            ProcedureKind::Stream,
            "db.export",
            Risk::Read,
            Agent::Hidden,
            (min(5), min(60)),
        ),
        (
            "files.chooseSavePath",
            ProcedureKind::Mutation,
            "files.write",
            Risk::Write,
            Agent::Hidden,
            defaults,
        ),
        (
            "query.classify",
            ProcedureKind::Query,
            "db.query.execute",
            Risk::Read,
            Agent::Hidden,
            defaults,
        ),
        (
            "query.execute",
            ProcedureKind::Stream,
            "db.query.execute",
            Risk::Read,
            Agent::Exposed,
            (min(5), min(60)),
        ),
        (
            "schema.columns",
            ProcedureKind::Query,
            "db.schema.read",
            Risk::Read,
            Agent::Hidden,
            defaults,
        ),
        (
            "schema.schemas",
            ProcedureKind::Query,
            "db.schema.read",
            Risk::Read,
            Agent::Exposed,
            defaults,
        ),
        (
            "schema.tables",
            ProcedureKind::Query,
            "db.schema.read",
            Risk::Read,
            Agent::Exposed,
            defaults,
        ),
        (
            "sessions.close",
            ProcedureKind::Mutation,
            "db.connect",
            Risk::Read,
            Agent::Hidden,
            defaults,
        ),
        (
            "sessions.open",
            ProcedureKind::Mutation,
            "db.connect",
            Risk::Read,
            Agent::Hidden,
            defaults,
        ),
    ];
    let procedures = codegen_router().procedures();
    assert_eq!(procedures.len(), 17);
    for (meta, (name, kind, perm, risk, agent, timeouts)) in procedures.iter().zip(&expected) {
        assert_eq!(meta.name, *name);
        assert_eq!(meta.kind, *kind, "{name}");
        assert_eq!(meta.perm.as_str(), *perm, "{name}");
        assert_eq!(meta.risk, *risk, "{name}");
        assert_eq!(meta.agent, *agent, "{name}");
        assert_eq!(
            (meta.timeout_default, meta.timeout_max),
            *timeouts,
            "{name}"
        );
        assert!(!meta.log_input, "{name}: inputs are never logged");
    }
    // Every permission is one the static Authorizer knows.
    for meta in &procedures {
        assert!(
            dbee_core::authz::PERMISSIONS.contains(&meta.perm.as_str()),
            "{} uses an unknown permission",
            meta.name
        );
    }
}
