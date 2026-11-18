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

const LG_READ: &str = "langgraph.read";
const LG_WRITE: &str = "langgraph.write";
const LG_DESTROY: &str = "langgraph.destroy";

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
        // The messaging core on the test backend (TSK-80, spec §5.8).
        (
            "echo.messages.get",
            Query,
            "echo.read",
            Risk::Read,
            defaults,
        ),
        (
            "echo.messages.produce",
            Mutation,
            "echo.write",
            Risk::Write,
            defaults,
        ),
        ("echo.messages.tail", Stream, "echo.read", Risk::Read, live),
        ("echo.ping", Query, "echo.read", Risk::Read, defaults),
        ("echo.shell", Stream, "echo.write", Risk::Write, live),
        ("echo.ticks", Stream, "echo.read", Risk::Read, live),
        // LangGraph, spec §11.4.
        (
            "langgraph.assistants.get",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.assistants.graph",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.assistants.schemas",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.assistants.search",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        ("langgraph.connect", Mutation, LG_READ, Risk::Read, defaults),
        (
            "langgraph.disconnect",
            Mutation,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.runs.cancel",
            Mutation,
            LG_WRITE,
            Risk::Write,
            defaults,
        ),
        ("langgraph.runs.join", Stream, LG_READ, Risk::Read, live),
        ("langgraph.runs.list", Query, LG_READ, Risk::Read, defaults),
        (
            "langgraph.runs.rollback",
            Mutation,
            LG_DESTROY,
            Risk::Destructive,
            defaults,
        ),
        ("langgraph.runs.stream", Stream, LG_WRITE, Risk::Write, live),
        (
            "langgraph.store.delete",
            Mutation,
            LG_DESTROY,
            Risk::Destructive,
            defaults,
        ),
        ("langgraph.store.get", Query, LG_READ, Risk::Read, defaults),
        (
            "langgraph.store.namespaces",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.store.put",
            Mutation,
            LG_WRITE,
            Risk::Write,
            defaults,
        ),
        (
            "langgraph.store.search",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.threads.create",
            Mutation,
            LG_WRITE,
            Risk::Write,
            defaults,
        ),
        (
            "langgraph.threads.delete",
            Mutation,
            LG_DESTROY,
            Risk::Destructive,
            defaults,
        ),
        (
            "langgraph.threads.get",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.threads.history",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.threads.search",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.threads.state",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.threads.updateState",
            Mutation,
            LG_WRITE,
            Risk::Write,
            defaults,
        ),
        // The messaging core, spec §5.8.
        (
            "messaging.codecs.list",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.decode",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.encode",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.filter.check",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.schemas.inspect",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.schemas.update",
            Mutation,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.connect",
            Mutation,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.disconnect",
            Mutation,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.namespaces.list",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.schedules.delete",
            Mutation,
            "temporal.write",
            Risk::Destructive,
            defaults,
        ),
        (
            "temporal.schedules.describe",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.schedules.list",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.schedules.pause",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.schedules.trigger",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.schedules.unpause",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.taskQueues.describe",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.cancel",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.workflows.count",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.describe",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.followHistory",
            Stream,
            "temporal.read",
            Risk::Read,
            live,
        ),
        (
            "temporal.workflows.history",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.list",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.query",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.reset",
            Mutation,
            "temporal.write",
            Risk::Destructive,
            defaults,
        ),
        (
            "temporal.workflows.signal",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.workflows.terminate",
            Mutation,
            "temporal.write",
            Risk::Destructive,
            defaults,
        ),
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
    assert_eq!(
        redact("temporal.connect"),
        ["profile.clientKeyPem", "profile.apiKey"]
    );
    assert_eq!(
        redact("langgraph.connect"),
        [
            "profile.apiKey",
            "profile.headers",
            "profile.tls.clientKeyPem"
        ]
    );
}
