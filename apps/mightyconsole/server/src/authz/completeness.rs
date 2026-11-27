//! The completeness rules (DOC-25 §3.3.8): every procedure is protected, for tools that do not
//! exist yet too. [`problems`] reads the generated manifest (`api.manifest.json`, as
//! `ambidex::codegen` renders it from the router) and names every procedure that breaks a rule;
//! the server's tests fail the build on any.
//!
//! A procedure breaks a rule when:
//!
//! - its permission is not in the catalogue, or no built-in role holds it (`app.self` aside);
//! - its permission does not follow the risk rule: a tool's procedure carries `<tool>.read`,
//!   `<tool>.write` or `<tool>.destroy` by its risk, except the procedures in [`EXCEPTIONS`];
//!   another namespace's procedure carries one of the permissions [`NAMESPACES`] lists for it;
//! - it takes a handle (`connId`, `terminalId`, `uploadId`), a profile (`profileId`, a
//!   `<tool>.test`'s `draft` and `basedOn`)
//!   or a `namespace` and its permission's target kind is not `profile`, or the reverse: its
//!   target kind is `profile` and it takes none of them (it could never be allowed). The shared
//!   codec procedures (`messaging.*`) are the one exception: they work on a handle of any tool,
//!   which needed `<tool>.read` to open, with `messaging.read` (target kind any, DOC-25 §3.3.1);
//! - it is Destructive and declares no confirmation subject ([`confirm::SUBJECTS`]), or its
//!   subject's field is not in its input (the person would have nothing to type);
//! - it is exposed to agents.
//!
//! The secret-field rule (every secret of a tool's profile goes through the secret store) is
//! `tests/codegen.rs`'s `every_secret_field_goes_through_the_secret_store`; the redaction test
//! comes with TSK-141.

use serde_json::Value;

use super::catalogue::{self, TargetKind};
use super::confirm;

/// Tool procedures whose permission is a tool permission other than the risk rule's.
pub const EXCEPTIONS: [(&str, &str); 5] = [
    ("docker.containers.exec", "docker.exec"),
    ("docker.containers.files.read", "docker.files.read"),
    ("docker.containers.files.download", "docker.files.read"),
    ("k8s.pods.exec", "k8s.exec"),
    ("k8s.secrets.reveal", "k8s.secrets.read"),
];

/// The permissions the procedures of a namespace that is not a tool may carry.
pub const NAMESPACES: [(&str, &[&str]); 12] = [
    ("app", &["app.read", catalogue::APP_SELF]),
    ("term", &[catalogue::TERM_WRITE]),
    ("messaging", &["messaging.read"]),
    (
        "admin",
        &[
            "admin.users.read",
            "admin.users.write",
            "admin.roles.write",
            "admin.sessions.revoke",
            "admin.secrets.manage",
        ],
    ),
    ("audit", &["audit.read"]),
    (
        "profiles",
        &[
            catalogue::PROFILES_PERSONAL,
            "profiles.manage",
            "profiles.hostAccess",
        ],
    ),
    (
        "routes",
        &[
            catalogue::PROFILES_PERSONAL,
            "profiles.manage",
            "profiles.hostAccess",
        ],
    ),
    (
        "links",
        &[
            catalogue::PROFILES_PERSONAL,
            "profiles.manage",
            "profiles.hostAccess",
        ],
    ),
    (
        "proxies",
        &[catalogue::PROFILES_PERSONAL, "profiles.manage"],
    ),
    (
        "secrets",
        &[catalogue::PROFILES_PERSONAL, "profiles.manage"],
    ),
    (
        "sshHosts",
        &[catalogue::PROFILES_PERSONAL, "profiles.manage"],
    ),
    ("app.account", &[catalogue::APP_SELF]),
];

/// Input fields that name what a call acts on.
pub const TARGET_FIELDS: [&str; 7] = [
    "connId",
    "terminalId",
    "uploadId",
    "profileId",
    "draft",
    "basedOn",
    "namespace",
];

/// The top-level input fields of `procedure` in `manifest`.
fn input_fields(manifest: &Value, procedure: &Value) -> Vec<String> {
    let defs = &manifest["$defs"];
    let mut schema = &procedure["input"];
    if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
        let name = r.rsplit('/').next().unwrap_or_default();
        schema = &defs[name];
    }
    schema
        .get("properties")
        .and_then(Value::as_object)
        .map(|p| p.keys().cloned().collect())
        .unwrap_or_default()
}

fn expected_tool_perm(tool: &str, risk: &str) -> Option<String> {
    let level = match risk {
        "Read" => "read",
        "Write" => "write",
        "Destructive" => "destroy",
        _ => return None,
    };
    Some(format!("{tool}.{level}"))
}

/// Every broken rule, one line each (`<procedure>: <what>`); empty when the API is complete.
pub fn problems(manifest: &Value) -> Vec<String> {
    let mut out = Vec::new();
    let Some(procedures) = manifest["procedures"].as_array() else {
        return vec!["the manifest has no procedures".into()];
    };
    let held: Vec<_> = catalogue::BUILT_IN
        .iter()
        .filter_map(|r| catalogue::built_in(r))
        .collect();
    for p in procedures {
        let name = p["name"].as_str().unwrap_or_default();
        let perm = p["perm"].as_str().unwrap_or_default();
        let risk = p["risk"].as_str().unwrap_or_default();
        let mut problem = |what: String| out.push(format!("{name}: {what}"));
        if p["agent"].as_str() != Some("hidden") {
            problem("is exposed to agents; every procedure is hidden (DOC-25 §2)".into());
        }
        let Some(kind) = catalogue::target_kind(perm) else {
            problem(format!(
                "its permission {perm:?} is not in the catalogue (authz::catalogue)"
            ));
            continue;
        };
        if perm != catalogue::APP_SELF && !held.iter().any(|r| r.contains(perm)) {
            problem(format!("no built-in role holds {perm:?}"));
        }
        let namespace = name.split('.').next().unwrap_or_default();
        if catalogue::TOOLS.contains(&namespace) {
            let exception = EXCEPTIONS.iter().find(|(n, _)| *n == name);
            let want = match exception {
                Some((_, p)) => Some((*p).to_owned()),
                None => expected_tool_perm(namespace, risk),
            };
            if want.as_deref() != Some(perm) {
                problem(format!(
                    "a {risk} procedure of {namespace} carries {perm:?}, not {:?} (the risk rule)",
                    want.unwrap_or_default()
                ));
            }
        } else {
            let allowed = NAMESPACES
                .iter()
                .filter(|(ns, _)| name.starts_with(&format!("{ns}.")))
                .max_by_key(|(ns, _)| ns.len())
                .map(|(_, perms)| *perms);
            match allowed {
                None => problem(format!(
                    "the namespace {namespace:?} is neither a tool nor listed in \
                     authz::completeness::NAMESPACES"
                )),
                Some(perms) if !perms.contains(&perm) => {
                    problem(format!("carries {perm:?}; its namespace allows {perms:?}"))
                }
                Some(_) => {}
            }
        }
        let fields = input_fields(manifest, p);
        let takes = TARGET_FIELDS
            .iter()
            .find(|f| fields.iter().any(|x| x == *f));
        let codec = namespace == "messaging";
        match (kind, takes) {
            (TargetKind::Profile, None) => problem(format!(
                "{perm:?} needs a target, but the input names no handle, terminal, upload, \
                 profile or namespace (the call could never be allowed)"
            )),
            (TargetKind::Any | TargetKind::Tenant, Some(field)) if !codec => problem(format!(
                "takes {field:?} but {perm:?} is not checked against a target"
            )),
            _ => {}
        }
        if risk == "Destructive" {
            match confirm::SUBJECTS.iter().find(|(n, _, _)| *n == name) {
                None => problem(
                    "is Destructive but declares no confirmation subject \
                     (authz::confirm::SUBJECTS)"
                        .into(),
                ),
                Some((_, _, field)) if !fields.iter().any(|f| f == field) => problem(format!(
                    "its confirmation subject reads {field:?}, which its input does not have"
                )),
                Some(_) => {}
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn manifest(procedures: Value) -> Value {
        json!({
            "$defs": {
                "ConnInput": { "properties": { "connId": {}, "id": {} } },
                "KeyInput": { "properties": { "connId": {}, "bucket": {}, "key": {} } },
                "WorkflowInput": { "properties": { "connId": {}, "workflowId": {} } },
                "NsInput": { "properties": { "namespace": {} } },
                "Empty": { "properties": {} },
            },
            "procedures": procedures,
        })
    }

    fn procedure(name: &str, perm: &str, risk: &str, input: &str) -> Value {
        json!({
            "name": name,
            "perm": perm,
            "risk": risk,
            "agent": "hidden",
            "input": { "$ref": format!("#/$defs/{input}") },
        })
    }

    #[test]
    fn a_complete_fixture_passes() {
        let m = manifest(json!([
            procedure("nats.kv.get", "nats.read", "Read", "ConnInput"),
            procedure("nats.kv.delete", "nats.destroy", "Destructive", "KeyInput"),
            procedure(
                "docker.containers.exec",
                "docker.exec",
                "Write",
                "ConnInput"
            ),
            procedure("app.info", "app.read", "Read", "Empty"),
            procedure("app.me", "app.self", "Read", "Empty"),
            procedure("app.account.changePassword", "app.self", "Write", "Empty"),
            procedure("messaging.decode", "messaging.read", "Read", "ConnInput"),
            procedure("admin.users.list", "admin.users.read", "Read", "Empty"),
        ]));
        assert_eq!(problems(&m), Vec::<String>::new());
    }

    #[test]
    fn the_fixture_catches_each_gap() {
        let mut exposed = procedure("nats.kv.keys", "nats.read", "Read", "ConnInput");
        exposed["agent"] = json!("exposed");
        let m = manifest(json!([
            // No permission the catalogue knows.
            procedure("nats.kv.watch", "", "Read", "ConnInput"),
            procedure("nats.kv.history", "nats.history", "Read", "ConnInput"),
            // A destroy carrying write (the Temporal fix of DOC-25 §3.3.1).
            procedure(
                "temporal.workflows.terminate",
                "temporal.write",
                "Destructive",
                "WorkflowInput"
            ),
            // A destroy with no name to type, and one whose name is not in its input.
            procedure("nats.kv.wipe", "nats.destroy", "Destructive", "KeyInput"),
            procedure("nats.kv.purge", "nats.destroy", "Destructive", "ConnInput"),
            // A tool procedure with no target: never allowed.
            procedure("nats.server.version", "nats.read", "Read", "Empty"),
            // A namespace without a target check.
            procedure("app.namespaces", "app.read", "Read", "NsInput"),
            // A new namespace nobody listed.
            procedure("billing.invoices.list", "app.read", "Read", "Empty"),
            procedure("term.write", "app.read", "Write", "Empty"),
            exposed,
        ]));
        let found = problems(&m);
        let names: Vec<&str> = found.iter().map(|p| p.split(':').next().unwrap()).collect();
        assert_eq!(
            names,
            [
                "nats.kv.watch",
                "nats.kv.history",
                "temporal.workflows.terminate",
                "nats.kv.wipe",
                "nats.kv.purge",
                "nats.server.version",
                "app.namespaces",
                "billing.invoices.list",
                "term.write",
                "nats.kv.keys",
            ],
            "{found:#?}"
        );
    }
}
