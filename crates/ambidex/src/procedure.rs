//! Procedure metadata (Ambidex spec §2, §5, §8).
//!
//! Every registered procedure has one [`ProcedureMeta`]. The `#[rpc::router]` macro builds it from
//! the procedure attribute; plugin procedures build it at runtime. The same metadata feeds
//! authorization, audit, the MCP adapter and codegen.

use std::time::Duration;

use security_types::{Action, Permission, Risk};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Call kind, spec §5.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcedureKind {
    /// Read-only and idempotent.
    Query,
    /// Has side effects; never retried automatically.
    Mutation,
    /// Server-push JSON events for one authorized topic.
    Subscription,
    /// Ordered binary chunks with backpressure, then one typed final result.
    Stream,
}

/// Whether the MCP adapter may publish the procedure as a tool (still subject to authorization).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Exposed,
    Hidden,
}

/// Default for `timeout_default` when a procedure does not set one. Provisional (spec Open
/// question 9).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// Default for `timeout_max` when a procedure does not set one. Provisional (spec Open question 9).
pub const DEFAULT_TIMEOUT_MAX: Duration = Duration::from_secs(5 * 60);

/// Placeholder that replaces redacted input fields in loggable input.
pub const REDACTED: &str = "<redacted>";

/// Static description of one procedure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProcedureMeta {
    /// Full name, `"<namespace>.<method>"`, e.g. `"query.execute"`.
    pub name: String,
    pub kind: ProcedureKind,
    /// Permission the procedure requires. Never empty.
    pub perm: Permission,
    /// Baseline risk; a handler may escalate it at runtime, never lower it.
    pub risk: Risk,
    pub agent: Agent,
    /// Deadline when the client sets none.
    pub timeout_default: Duration,
    /// Upper bound for any client-requested deadline.
    pub timeout_max: Duration,
    /// Whether input values may be written to the audit log. Off unless the procedure opts in.
    pub log_input: bool,
    /// Input field paths (dot-separated, e.g. `"auth.password"`) that are never logged, even
    /// with `log_input`.
    pub redact: Vec<String>,
    pub deprecated: bool,
}

impl ProcedureMeta {
    /// Metadata with conservative defaults: hidden from agents, input not logged.
    ///
    /// # Panics
    ///
    /// If `perm` is empty or contains whitespace: every procedure needs a permission.
    pub fn new(
        name: impl Into<String>,
        kind: ProcedureKind,
        perm: impl Into<Permission>,
        risk: Risk,
    ) -> ProcedureMeta {
        let perm = perm.into();
        assert!(
            is_valid_perm(perm.as_str()),
            "procedure permission must be non-empty and contain no whitespace"
        );
        ProcedureMeta {
            name: name.into(),
            kind,
            perm,
            risk,
            agent: Agent::Hidden,
            timeout_default: DEFAULT_TIMEOUT,
            timeout_max: DEFAULT_TIMEOUT_MAX,
            log_input: false,
            redact: Vec::new(),
            deprecated: false,
        }
    }

    /// The neutral action handed to the [`Authorizer`](security_types::Authorizer).
    pub fn action(&self) -> Action {
        Action::new(self.name.clone(), self.perm.clone())
    }

    /// Input as it may appear in the audit log: `None` unless the procedure opted in with
    /// `log_input`, and with every `redact` path replaced by [`REDACTED`].
    pub fn loggable_input(&self, input: &Value) -> Option<Value> {
        if !self.log_input {
            return None;
        }
        let mut value = input.clone();
        for path in &self.redact {
            redact_path(&mut value, path);
        }
        Some(value)
    }
}

pub(crate) fn is_valid_perm(perm: &str) -> bool {
    !perm.is_empty() && !perm.chars().any(char::is_whitespace)
}

/// Replaces the value at `path`. Arrays on the way are descended element-wise, so
/// `"rows.password"` redacts the field in every row.
fn redact_path(value: &mut Value, path: &str) {
    let (head, rest) = match path.split_once('.') {
        Some((head, rest)) => (head, Some(rest)),
        None => (path, None),
    };
    match value {
        Value::Array(items) => items.iter_mut().for_each(|item| redact_path(item, path)),
        Value::Object(map) => match (map.get_mut(head), rest) {
            (Some(field), None) => *field = Value::String(REDACTED.into()),
            (Some(field), Some(rest)) => redact_path(field, rest),
            (None, _) => {}
        },
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta() -> ProcedureMeta {
        ProcedureMeta::new(
            "conn.create",
            ProcedureKind::Mutation,
            "db.conn.create",
            Risk::Write,
        )
    }

    #[test]
    fn defaults_are_conservative() {
        let meta = meta();
        assert_eq!(meta.agent, Agent::Hidden);
        assert!(!meta.log_input);
        assert_eq!(meta.loggable_input(&json!({"a": 1})), None);
    }

    #[test]
    fn redaction_covers_nested_and_array_paths() {
        let mut meta = meta();
        meta.log_input = true;
        meta.redact = vec![
            "password".into(),
            "auth.token".into(),
            "hosts.secret".into(),
        ];
        let input = json!({
            "name": "prod",
            "password": "hunter2",
            "auth": {"token": "t0k", "user": "u"},
            "hosts": [{"secret": "s1", "host": "a"}, {"host": "b"}],
        });
        let logged = meta.loggable_input(&input).unwrap();
        assert_eq!(
            logged,
            json!({
                "name": "prod",
                "password": REDACTED,
                "auth": {"token": REDACTED, "user": "u"},
                "hosts": [{"secret": REDACTED, "host": "a"}, {"host": "b"}],
            })
        );
    }

    #[test]
    #[should_panic(expected = "permission")]
    fn empty_perm_is_rejected() {
        ProcedureMeta::new("x.y", ProcedureKind::Query, "", Risk::Read);
    }
}
