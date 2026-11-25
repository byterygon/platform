//! Targets, built on the server for every call (DOC-25 §3.3.3): the router asks [`McTargets`]
//! before the Authorizer, so the dispatch check, its audit entries and any destroy confirmation
//! name what the call acts on. The client never names a target; the resolver reads from the
//! input only the ids it looks up itself and the names below them:
//!
//! - `connId`: the live handle's target (a handle of another session is `NotFound`, as the
//!   handler would answer; `<tool>.disconnect` of a handle that is gone stays a no-op that
//!   succeeds, on the caller's own browser connection of that tool);
//! - `terminalId`: the target of the handle the terminal was opened on;
//! - `uploadId`: the handle a NATS upload runs on;
//! - `id` of a `profiles.*` call and `owner.id` of a `secrets.*` call: the stored profile;
//! - `profileId` (a `<tool>.connect`) and `basedOn` (a `<tool>.test`): the stored profile;
//! - `profile` (a `<tool>.connect`, `temporal.testCodec`): the profile the browser sends, and
//!   `draft` (a `<tool>.test` with no `basedOn`): the caller's own draft, both as below;
//! - then, for a tool with namespaces ([`catalogue::NAMESPACED_TOOLS`]), the input's
//!   `namespace` below that target.
//!
//! **Browser-held profiles.** Until profiles move to the server (TSK-139), every connection is
//! opened with a profile the browser keeps and sends: there is no stored profile id, owner or
//! shared profile yet. Such a target has the kind [`BROWSER_TARGET`] and the id
//! `<tool>[/ns:<namespace>]`. It is built only from the calling session's own input and handles,
//! so it is always the caller's own: the Authorizer treats it as the caller's personal profile
//! (DOC-25 §3.4.9 imports each of them as one), and no scoped assignment covers it.

use ambidex::{ErrorPayload, IntoErrorPayload, ProcedureMeta, Session, Targets};
use security_types::{PROFILE_TARGET, ProfileTarget, TargetRef};
use serde_json::Value;
use std::sync::Arc;

use super::catalogue;
use crate::core::{Hub, ToolError};

/// The target kind of a connection opened with a profile the browser sends.
pub const BROWSER_TARGET: &str = "browser";

/// The target of a browser-held profile of `tool`.
pub fn browser(tool: &str) -> TargetRef {
    TargetRef::new(BROWSER_TARGET, tool)
}

/// The tool of a browser target (`temporal` for `temporal/ns:default`).
pub fn browser_tool(target: &TargetRef) -> Option<&str> {
    (target.kind == BROWSER_TARGET).then(|| target.id.split('/').next().unwrap_or_default())
}

/// The longest namespace a target takes from the input (longer ones are left out, which makes
/// the target the whole profile: a stricter check, never a looser one).
const MAX_NAMESPACE: usize = security_types::scope::MAX_SEGMENT_LEN;

/// `target` narrowed to `namespace`.
pub fn with_namespace(target: &TargetRef, namespace: &str) -> TargetRef {
    let ok = !namespace.is_empty()
        && namespace.len() <= MAX_NAMESPACE
        && namespace.bytes().all(|b| b.is_ascii_graphic())
        && !namespace.contains("/ns:")
        && !namespace.contains("/ctx:");
    if !ok {
        return target.clone();
    }
    if target.kind == PROFILE_TARGET {
        match ProfileTarget::of(target) {
            Some(t) if t.namespace.is_none() => ProfileTarget {
                namespace: Some(namespace),
                ..t
            }
            .to_target(),
            _ => target.clone(),
        }
    } else if target.kind == BROWSER_TARGET && !target.id.contains("/ns:") {
        TargetRef::new(BROWSER_TARGET, format!("{}/ns:{namespace}", target.id))
    } else {
        target.clone()
    }
}

/// Mightyconsole's [`Targets`] resolver.
pub struct McTargets {
    hub: Arc<Hub>,
}

impl McTargets {
    pub fn new(hub: Arc<Hub>) -> McTargets {
        McTargets { hub }
    }

    /// The handle `conn_id` of `session`, for a procedure of `namespace` (a tool, or `messaging`
    /// whose procedures work on any tool's handle).
    fn handle(
        &self,
        session: &str,
        namespace: &str,
        conn_id: &str,
    ) -> Result<TargetRef, ErrorPayload> {
        let tool = catalogue::TOOLS.contains(&namespace).then_some(namespace);
        match self.hub.handle_target(session, conn_id) {
            Some((t, target)) if tool.is_none_or(|tool| tool == t) => Ok(target),
            _ => Err(ToolError::connection_gone(tool.unwrap_or(namespace)).into_error_payload()),
        }
    }
}

fn text<'a>(input: &'a Value, field: &str) -> Option<&'a str> {
    input.get(field).and_then(Value::as_str)
}

/// The stored profile a `profiles.*` or `secrets.*` call names: `id` (`profiles.get`, `update`,
/// `duplicate`, `delete`), or `owner.id` of a profile's secret.
fn stored_profile<'a>(procedure: &str, input: &'a Value) -> Option<&'a str> {
    if procedure.starts_with("profiles.") {
        text(input, "id")
    } else if procedure.starts_with("secrets.") {
        let owner = input.get("owner")?;
        (text(owner, "kind") == Some("profile"))
            .then(|| text(owner, "id"))
            .flatten()
    } else {
        None
    }
}

impl Targets for McTargets {
    fn target(
        &self,
        session: &Session,
        meta: &ProcedureMeta,
        input: &Value,
    ) -> Result<Option<TargetRef>, ErrorPayload> {
        let namespace = meta.name.split('.').next().unwrap_or_default();
        let base = if let Some(conn_id) = text(input, "connId") {
            match self.handle(&session.id, namespace, conn_id) {
                Ok(target) => target,
                // Releasing what is already gone does nothing, and says so by succeeding.
                Err(_)
                    if meta.name == format!("{namespace}.disconnect")
                        && catalogue::TOOLS.contains(&namespace) =>
                {
                    browser(namespace)
                }
                Err(e) => return Err(e),
            }
        } else if let Some(terminal) = text(input, "terminalId") {
            self.hub
                .terminal_target(&session.id, terminal)
                .ok_or_else(|| {
                    ToolError::not_found("term", "terminal", "this terminal has ended")
                        .into_error_payload()
                })?
        } else if let Some(upload) = text(input, "uploadId") {
            let conn_id = self
                .hub
                .linked(&session.id, "uploadId", upload)
                .ok_or_else(|| {
                    ToolError::not_found(namespace, "upload", "the upload ended or does not exist")
                        .into_error_payload()
                })?;
            self.handle(&session.id, namespace, &conn_id)?
        } else if let Some(id) = stored_profile(&meta.name, input) {
            crate::profiles::target_of(id)
        } else if let Some(id) = text(input, "profileId").or_else(|| text(input, "basedOn"))
            && catalogue::TOOLS.contains(&namespace)
        {
            crate::profiles::target_of(id)
        } else if (input.get("profile").is_some_and(Value::is_object)
            || input.get("draft").is_some_and(Value::is_object))
            && catalogue::TOOLS.contains(&namespace)
        {
            browser(namespace)
        } else {
            return Ok(None);
        };
        let tool = browser_tool(&base).unwrap_or(namespace);
        let target = match text(input, "namespace") {
            Some(ns) if catalogue::NAMESPACED_TOOLS.contains(&tool) => with_namespace(&base, ns),
            _ => base,
        };
        Ok(Some(target))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn namespaces_narrow_a_target_once() {
        let b = browser("temporal");
        assert_eq!(with_namespace(&b, "default").id, "temporal/ns:default");
        let p = TargetRef::new(PROFILE_TARGET, "P");
        assert_eq!(with_namespace(&p, "team-a").id, "P/ns:team-a");
        let k = TargetRef::new(PROFILE_TARGET, "P/ctx:prod");
        assert_eq!(with_namespace(&k, "web").id, "P/ctx:prod/ns:web");
        // Already narrowed, or a name that cannot be one: unchanged (the whole profile).
        let n = with_namespace(&p, "a");
        assert_eq!(with_namespace(&n, "b"), n);
        assert_eq!(with_namespace(&p, "has space"), p);
        assert_eq!(with_namespace(&p, ""), p);
        assert_eq!(with_namespace(&p, "x/ns:y"), p);
        assert_eq!(browser_tool(&with_namespace(&b, "x")), Some("temporal"));
        assert_eq!(browser_tool(&p), None);
    }
}
