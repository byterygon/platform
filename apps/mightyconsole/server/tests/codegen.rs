//! The committed `apps/mightyconsole/ui/src/gen/{api.ts,api.manifest.json}` are current
//! (Ambidex spec §2: CI fails on drift), and the procedures have the kinds, risks, timeouts and
//! agent exposure of Mightyconsole spec §2.4 and §2.7.

use std::time::Duration;

use ambidex::codegen;
use ambidex::{Agent, ProcedureKind};
use mightyconsole_server::{SCHEMA_HASH, api_info, codegen_router, generated_dir};
use security_types::Risk;
use serde_json::{Value, json};

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

/// Every procedure is protected (DOC-25 §3.3.8): its permission is in the catalogue and a role,
/// follows the risk rule, and a procedure that acts on a connection checks its target.
#[test]
fn every_procedure_is_protected() {
    let output =
        codegen::generate(&codegen_router(), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let manifest: serde_json::Value = serde_json::from_str(&output.manifest_json).unwrap();
    let problems = mightyconsole_server::authz::completeness::problems(&manifest);
    assert!(problems.is_empty(), "{problems:#?}");
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
        // The management procedures (DOC-25 §3.3.7, TSK-138).
        (
            "admin.backup.snapshot",
            Mutation,
            "admin.secrets.manage",
            Risk::Write,
            defaults,
        ),
        (
            "admin.groups.addMembers",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.groups.create",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.groups.delete",
            Mutation,
            "admin.roles.write",
            Risk::Destructive,
            defaults,
        ),
        (
            "admin.groups.list",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.groups.removeMembers",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.groups.set",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.profiles.transfer",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.roles.create",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.roles.delete",
            Mutation,
            "admin.roles.write",
            Risk::Destructive,
            defaults,
        ),
        (
            "admin.roles.get",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.roles.list",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.roles.update",
            Mutation,
            "admin.roles.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.secrets.status",
            Query,
            "admin.secrets.manage",
            Risk::Read,
            defaults,
        ),
        (
            "admin.sessions.list",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.sessions.revoke",
            Mutation,
            "admin.sessions.revoke",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.create",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.delete",
            Mutation,
            "admin.users.write",
            Risk::Destructive,
            defaults,
        ),
        (
            "admin.users.disable",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.enable",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.get",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.users.list",
            Query,
            "admin.users.read",
            Risk::Read,
            defaults,
        ),
        (
            "admin.users.resetPassword",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.setRoles",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        (
            "admin.users.unlock",
            Mutation,
            "admin.users.write",
            Risk::Write,
            defaults,
        ),
        // A built-in account's own password and second factor (DOC-25 §3.2.6, TSK-142).
        (
            "app.account.changePassword",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        (
            "app.account.totp.begin",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        (
            "app.account.totp.confirm",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        (
            "app.account.totp.remove",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        // The destroy confirmation (DOC-25 §3.3.6, TSK-138).
        (
            "app.confirmations.confirm",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        (
            "app.confirmations.get",
            Query,
            "app.self",
            Risk::Read,
            defaults,
        ),
        (
            "app.events",
            Subscription,
            "app.read",
            Risk::Read,
            (None, None),
        ),
        ("app.info", Query, "app.read", Risk::Read, defaults),
        ("app.me", Query, "app.self", Risk::Read, defaults),
        ("app.sessions.list", Query, "app.self", Risk::Read, defaults),
        (
            "app.sessions.revoke",
            Mutation,
            "app.self",
            Risk::Write,
            defaults,
        ),
        // Reading the audit log (DOC-25 §3.5.7, TSK-140): all under audit.read.
        ("audit.get", Query, "audit.read", Risk::Read, defaults),
        ("audit.list", Query, "audit.read", Risk::Read, defaults),
        ("audit.status", Query, "audit.read", Risk::Read, defaults),
        (
            "audit.verify",
            Query,
            "audit.read",
            Risk::Read,
            (
                Some(Duration::from_secs(300)),
                Some(Duration::from_secs(600)),
            ),
        ),
        // Docker over SSH (TSK-81, spec §10.6): connect waits for SSH, the login and the ping.
        (
            "docker.compose.projects",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.connect",
            Mutation,
            "docker.read",
            Risk::Read,
            (
                Some(Duration::from_secs(60)),
                Some(Duration::from_secs(300)),
            ),
        ),
        // Containers and events (TSK-81 batch 2b): stop and restart wait out the grace period.
        (
            "docker.containers.exec",
            Stream,
            "docker.exec",
            Risk::Write,
            live,
        ),
        (
            "docker.containers.files.download",
            Stream,
            "docker.files.read",
            Risk::Read,
            live,
        ),
        (
            "docker.containers.files.list",
            Query,
            "docker.read",
            Risk::Read,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        (
            "docker.containers.files.read",
            Query,
            "docker.files.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.containers.inspect",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.containers.list",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.containers.logs",
            Stream,
            "docker.read",
            Risk::Read,
            live,
        ),
        (
            "docker.containers.remove",
            Mutation,
            "docker.destroy",
            Risk::Destructive,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        (
            "docker.containers.restart",
            Mutation,
            "docker.write",
            Risk::Write,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(720)),
            ),
        ),
        (
            "docker.containers.start",
            Mutation,
            "docker.write",
            Risk::Write,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        (
            "docker.containers.stats",
            Stream,
            "docker.read",
            Risk::Read,
            live,
        ),
        (
            "docker.containers.stop",
            Mutation,
            "docker.write",
            Risk::Write,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(720)),
            ),
        ),
        (
            "docker.containers.top",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.disconnect",
            Mutation,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        ("docker.events", Stream, "docker.read", Risk::Read, live),
        (
            "docker.host.counts",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        ("docker.host.df", Query, "docker.read", Risk::Read, defaults),
        (
            "docker.host.info",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        // Images, volumes and networks (TSK-81 batch 3): remove is Destructive.
        (
            "docker.images.inspect",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.images.list",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.images.remove",
            Mutation,
            "docker.destroy",
            Risk::Destructive,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        (
            "docker.networks.inspect",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.networks.list",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.networks.remove",
            Mutation,
            "docker.destroy",
            Risk::Destructive,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        ("docker.test", Mutation, "docker.read", Risk::Read, defaults),
        (
            "docker.volumes.inspect",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.volumes.list",
            Query,
            "docker.read",
            Risk::Read,
            defaults,
        ),
        (
            "docker.volumes.remove",
            Mutation,
            "docker.destroy",
            Risk::Destructive,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
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
        ("echo.test", Mutation, "echo.read", Risk::Read, defaults),
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
        // Node statistics read many runs' checkpoints (TSK-96): a minute by default.
        (
            "langgraph.assistants.nodeStats",
            Query,
            LG_READ,
            Risk::Read,
            (
                Some(Duration::from_secs(60)),
                Some(Duration::from_secs(300)),
            ),
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
        // An assistant's versions, a page of bytes (TSK-96).
        (
            "langgraph.assistants.versions",
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
        // Replies stay under the frame (TSK-108): `get` loads one run's metadata whole.
        ("langgraph.runs.get", Query, LG_READ, Risk::Read, defaults),
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
        ("langgraph.test", Mutation, LG_READ, Risk::Read, defaults),
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
        // One value of a checkpoint or a run as a stream, for what is over one reply (TSK-108).
        (
            "langgraph.threads.readValue",
            Stream,
            LG_READ,
            Risk::Read,
            (
                Some(Duration::from_secs(600)),
                Some(Duration::from_secs(3600)),
            ),
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
        // The large-state tree (TSK-96): a value kept on the server, as Temporal's payloads.
        (
            "langgraph.values.download",
            Stream,
            LG_READ,
            Risk::Read,
            (
                Some(Duration::from_secs(3600)),
                Some(Duration::from_secs(3600)),
            ),
        ),
        (
            "langgraph.values.node",
            Query,
            LG_READ,
            Risk::Read,
            defaults,
        ),
        (
            "langgraph.values.open",
            Query,
            LG_READ,
            Risk::Read,
            (
                Some(Duration::from_secs(120)),
                Some(Duration::from_secs(300)),
            ),
        ),
        (
            "langgraph.values.query",
            Query,
            LG_READ,
            Risk::Read,
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
        // jq on a value in a worker (TSK-113, spec §5.4.1): its own deadline is at most 30 s.
        (
            "messaging.query",
            Query,
            "messaging.read",
            Risk::Read,
            (Some(Duration::from_secs(35)), Some(Duration::from_secs(35))),
        ),
        (
            "messaging.registry.set",
            Mutation,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.registry.subjects",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.registry.test",
            Query,
            "messaging.read",
            Risk::Read,
            defaults,
        ),
        (
            "messaging.registry.versions",
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
            "messaging.schemas.status",
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
        // NATS, spec §6.5 (TSK-85).
        ("nats.connect", Mutation, "nats.read", Risk::Read, defaults),
        (
            "nats.core.publish",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.core.request",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        ("nats.core.subscribe", Stream, "nats.read", Risk::Read, live),
        (
            "nats.disconnect",
            Mutation,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.consumers.create",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.js.consumers.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.js.consumers.info",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.consumers.list",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.streams.browse",
            Stream,
            "nats.read",
            Risk::Read,
            live,
        ),
        (
            "nats.js.streams.create",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.js.streams.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.js.streams.getMessage",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.streams.info",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.streams.list",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.js.streams.purge",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.js.streams.update",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.kv.buckets.create",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.kv.buckets.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.kv.buckets.info",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.kv.buckets.list",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.kv.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        ("nats.kv.get", Query, "nats.read", Risk::Read, defaults),
        ("nats.kv.history", Query, "nats.read", Risk::Read, defaults),
        ("nats.kv.keys", Query, "nats.read", Risk::Read, defaults),
        (
            "nats.kv.purge",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        ("nats.kv.put", Mutation, "nats.write", Risk::Write, defaults),
        ("nats.kv.watch", Stream, "nats.read", Risk::Read, live),
        (
            "nats.obj.buckets.create",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.obj.buckets.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.obj.buckets.info",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.obj.buckets.list",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.obj.delete",
            Mutation,
            "nats.destroy",
            Risk::Destructive,
            defaults,
        ),
        (
            "nats.obj.get",
            Stream,
            "nats.read",
            Risk::Read,
            (
                Some(Duration::from_secs(3600)),
                Some(Duration::from_secs(3600)),
            ),
        ),
        ("nats.obj.info", Query, "nats.read", Risk::Read, defaults),
        ("nats.obj.list", Query, "nats.read", Risk::Read, defaults),
        (
            "nats.obj.uploadAbort",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.obj.uploadFinish",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.obj.uploadPart",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.obj.uploadStart",
            Mutation,
            "nats.write",
            Risk::Write,
            defaults,
        ),
        (
            "nats.schemas.test",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        ("nats.server.info", Query, "nats.read", Risk::Read, defaults),
        (
            "nats.services.discover",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.services.ping",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        (
            "nats.services.stats",
            Query,
            "nats.read",
            Risk::Read,
            defaults,
        ),
        ("nats.test", Mutation, "nats.read", Risk::Read, defaults),
        // Profiles on the server and their write-only secrets (DOC-25 §3.4.7, TSK-139).
        (
            "profiles.create",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "profiles.delete",
            Mutation,
            "profiles.personal",
            Risk::Destructive,
            defaults,
        ),
        (
            "profiles.duplicate",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "profiles.get",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "profiles.import",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "profiles.list",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "profiles.update",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        // Proxies and routes (DOC-23 §8.1, §9, TSK-117).
        (
            "proxies.create",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "proxies.delete",
            Mutation,
            "profiles.personal",
            Risk::Destructive,
            defaults,
        ),
        (
            "proxies.get",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "proxies.import",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "proxies.list",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "proxies.update",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "routes.confirm",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "routes.create",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "routes.delete",
            Mutation,
            "profiles.personal",
            Risk::Destructive,
            defaults,
        ),
        (
            "routes.duplicate",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "routes.get",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "routes.import",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "routes.list",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "routes.test",
            Mutation,
            "profiles.personal",
            Risk::Read,
            (Some(Duration::from_secs(60)), Some(Duration::from_secs(60))),
        ),
        (
            "routes.update",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "secrets.remove",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "secrets.set",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "secrets.status",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        // SSH hosts (DOC-23 §4.3, TSK-144).
        (
            "sshHosts.create",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "sshHosts.delete",
            Mutation,
            "profiles.personal",
            Risk::Destructive,
            defaults,
        ),
        (
            "sshHosts.get",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "sshHosts.import",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "sshHosts.list",
            Query,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "sshHosts.test",
            Mutation,
            "profiles.personal",
            Risk::Read,
            defaults,
        ),
        (
            "sshHosts.update",
            Mutation,
            "profiles.personal",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.activities.cancel",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.activities.count",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.activities.describe",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.activities.list",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.activities.start",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.activities.terminate",
            Mutation,
            "temporal.destroy",
            Risk::Destructive,
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
            "temporal.info",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.namespaces.describe",
            Query,
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
            "temporal.namespaces.searchAttributes",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        // Large payloads kept on the server (TSK-92): the download streams for up to an hour.
        (
            "temporal.payload.download",
            Stream,
            "temporal.read",
            Risk::Read,
            (
                Some(Duration::from_secs(3600)),
                Some(Duration::from_secs(3600)),
            ),
        ),
        (
            "temporal.payload.node",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.payload.query",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.schedules.backfill",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.schedules.create",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.schedules.delete",
            Mutation,
            "temporal.destroy",
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
            "temporal.schedules.matchingTimes",
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
            "temporal.schedules.runs",
            Query,
            "temporal.read",
            Risk::Read,
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
            "temporal.schedules.update",
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
            "temporal.test",
            Mutation,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.testCodec",
            Mutation,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workers.list",
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
            "temporal.workflows.downloadHistory",
            Stream,
            "temporal.read",
            Risk::Read,
            (
                Some(Duration::from_secs(3600)),
                Some(Duration::from_secs(3600)),
            ),
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
            "temporal.workflows.rawEvent",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.relations",
            Query,
            "temporal.read",
            Risk::Read,
            defaults,
        ),
        (
            "temporal.workflows.reset",
            Mutation,
            "temporal.destroy",
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
            "temporal.workflows.start",
            Mutation,
            "temporal.write",
            Risk::Write,
            defaults,
        ),
        (
            "temporal.workflows.terminate",
            Mutation,
            "temporal.destroy",
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
    // Passwords and codes never reach the audit digest or a log.
    assert_eq!(redact("app.account.changePassword"), ["current", "new"]);
    assert_eq!(redact("app.account.totp.confirm"), ["code"]);
    assert_eq!(redact("app.account.totp.remove"), ["current"]);
    // No connect takes a secret (DOC-25 §3.4.7): the server opens the stored profile's.
    for tool in ["echo", "nats", "temporal", "docker", "langgraph"] {
        assert!(redact(&format!("{tool}.connect")).is_empty(), "{tool}");
    }
    // Secret values given to the profile procedures never reach the digest or a log.
    assert_eq!(redact("profiles.create"), ["secrets"]);
    assert_eq!(redact("profiles.update"), ["secrets"]);
    assert_eq!(redact("profiles.import"), ["secrets"]);
    assert_eq!(redact("secrets.set"), ["value"]);
    // Test codec takes the form's draft, as Test connection does.
    assert_eq!(redact("temporal.testCodec"), ["draft.secrets"]);
    // Test connection's draft secrets are used for the call only (DOC-25 §3.4.7).
    for tool in ["echo", "nats", "temporal", "docker", "langgraph"] {
        assert_eq!(redact(&format!("{tool}.test")), ["draft.secrets"], "{tool}");
    }
    // A registry's secrets: typed in the form's draft for a test, else opened on the server.
    assert_eq!(redact("messaging.registry.test"), ["draft.secrets"]);
    assert!(redact("messaging.registry.set").is_empty());
}

/// The secret-field rule (DOC-25 §3.4.7, TSK-139): a connect takes only the stored profile's id,
/// never a secret; every secret field of a tool's profile is one the secret store knows
/// (`profiles::spec`), and the connect profile the server builds sends each of them to the tool
/// (`profiles::connect`) under the authentication that uses it. A secret field that is not routed
/// through the store fails here. Docker's TCP client key waits for Docker over TCP (DOC-23).
#[test]
fn every_secret_field_goes_through_the_secret_store() {
    use mightyconsole_server::profiles::connect::{View, connect_profile};
    use mightyconsole_server::profiles::spec::SPECS;
    use mightyconsole_server::secrets::Secret;
    let output =
        codegen::generate(&codegen_router(), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let manifest: Value = serde_json::from_str(&output.manifest_json).unwrap();
    // The settings under which each secret is used (one authentication at a time).
    let presets = |tool: &str| -> Vec<Value> {
        match tool {
            "nats" => vec![
                json!({ "auth": "userPassword", "tls": { "enabled": true }, "schemaRegistry": { "url": "https://r", "auth": "basic" } }),
                json!({ "auth": "token", "schemaRegistry": { "url": "https://r", "auth": "bearer" } }),
                json!({ "auth": "nkey" }),
                json!({ "auth": "creds" }),
            ],
            "temporal" => vec![json!({
                "tls": { "enabled": true },
                "codec": { "enabled": true, "endpoint": "https://c" },
                "externalStorage": { "enabled": true, "bucket": "b" },
            })],
            "docker" => vec![
                json!({ "auth": "privateKey" }),
                json!({ "auth": "password" }),
            ],
            _ => vec![json!({})],
        }
    };
    for spec in &SPECS {
        let name = format!("{}.connect", spec.tool);
        let connect = manifest["procedures"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["name"] == json!(name))
            .unwrap_or_else(|| panic!("{name}"));
        assert_eq!(
            input_fields_of(&manifest, connect),
            ["profileId"],
            "{}.connect takes the stored profile's id only",
            spec.tool
        );
        let secrets: std::collections::BTreeMap<String, Secret> = spec
            .secrets
            .iter()
            .map(|f| {
                let value = match *f {
                    "headerValues" => format!("X-Secret: {f}"),
                    _ => format!("secret:{f}"),
                };
                ((*f).to_owned(), Secret::new(value.into_bytes()))
            })
            .collect();
        let mut sent = std::collections::BTreeSet::new();
        for fields in presets(spec.tool) {
            let view = View {
                id: Some("P1"),
                name: "n",
                fields: &fields,
                extras: &json!({}),
                secrets: &secrets,
            };
            let text = connect_profile(spec.tool, &view).unwrap().to_string();
            for f in spec.secrets {
                if text.contains(&format!("secret:{f}"))
                    || text.contains(&format!("\"value\":\"{f}\""))
                {
                    sent.insert(*f);
                }
            }
        }
        let wanted: std::collections::BTreeSet<&str> = spec
            .secrets
            .iter()
            .copied()
            .filter(|f| !(spec.tool == "docker" && *f == "tls.clientKeyPem"))
            .collect();
        assert_eq!(
            sent, wanted,
            "{}: the secrets its connect profile sends",
            spec.tool
        );
    }
}

/// Every call that carries a secret from the browser has a budget (TSK-141): Test connection's
/// draft tests the smaller one, and only `term.write` (keystrokes) is left out.
#[test]
fn every_procedure_that_carries_a_secret_has_a_budget() {
    use mightyconsole_server::authz::limits::{Budget, UNCOUNTED};
    let procedures = codegen_router().procedures();
    let mut tests: Vec<&str> = procedures
        .iter()
        .filter(|m| Budget::of(m) == Some(Budget::Test))
        .map(|m| m.name.as_str())
        .collect();
    tests.sort_unstable();
    assert_eq!(
        tests,
        [
            "docker.test",
            "echo.test",
            "langgraph.test",
            "messaging.registry.test",
            "nats.test",
            "routes.test",
            "sshHosts.test",
            "temporal.test",
            "temporal.testCodec",
        ]
    );
    for meta in &procedures {
        if !meta.redact.is_empty() {
            assert!(
                Budget::of(meta).is_some() || UNCOUNTED.contains(&meta.name.as_str()),
                "{} carries a secret and has no budget",
                meta.name
            );
        }
    }
    assert_eq!(UNCOUNTED, ["term.write"]);
}

/// The top-level input fields of a procedure in the manifest.
fn input_fields_of(manifest: &Value, procedure: &Value) -> Vec<String> {
    let input = &procedure["input"];
    let schema = match input["$ref"].as_str() {
        Some(r) => &manifest["$defs"][r.rsplit('/').next().unwrap()],
        None => input,
    };
    let mut out: Vec<String> = schema["properties"]
        .as_object()
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default();
    out.sort();
    out
}
