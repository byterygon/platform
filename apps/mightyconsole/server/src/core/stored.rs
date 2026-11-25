//! Connecting with a stored profile (DOC-25 §3.4.7): `<tool>.connect { profileId }` and
//! `<tool>.test { draft, basedOn? }`. The tools ask the [`Hub`] for the profile they connect
//! with; the Hub asks the profile store ([`StoredProfiles`], set at start), which checks who may
//! use the profile, opens its secrets and builds the tool's connect profile. A secret reaches the
//! tool's client and nothing else: no answer, log line or audit entry holds one.
//!
//! Until the UI moves to stored profiles (TSK-139, the next batch) `<tool>.connect` also takes
//! the `{ profile }` the browser sends; exactly one of the two is given.

use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use ambidex::Ctx;
use schemars::JsonSchema;
use security_types::{Principal, TargetRef};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{Hub, ToolError, ToolErrorKind};

/// A tool's connect profile, built from a stored or draft record with its secrets, and the
/// target the connection acts on.
pub struct Resolved {
    /// The tool's connect profile as JSON (secrets included): deserialized by the tool at once.
    pub profile: Value,
    pub target: TargetRef,
}

impl fmt::Debug for Resolved {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Resolved")
            .field("profile", &"<redacted>")
            .field("target", &self.target)
            .finish()
    }
}

/// The profile store, as the tools see it.
pub trait StoredProfiles: Send + Sync {
    /// The connect profile of the stored profile `profile_id` of `tool`, which `p` may use.
    fn connect(&self, p: &Principal, tool: &str, profile_id: &str) -> Result<Resolved, ToolError>;

    /// The connect profile of a draft (Test connection of the profile form), its missing
    /// secrets filled from `based_on` when `p` may edit it and the draft's target fields equal
    /// the stored ones (§3.4.8).
    fn test(
        &self,
        p: &Principal,
        tool: &str,
        draft: TestDraft,
        based_on: Option<&str>,
    ) -> Result<Resolved, ToolError>;
}

/// The profile form's draft, for `<tool>.test`.
#[derive(Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestDraft {
    /// The profile's name as typed; "draft" when empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// The record's `fields` (DOC-21 §4.2), without secrets.
    #[ts(type = "unknown")]
    pub fields: Value,
    #[serde(default)]
    #[ts(optional = nullable, type = "unknown")]
    pub extras: Option<Value>,
    /// The secrets typed in the form, by field path: used for this call only, never stored,
    /// logged or audited. `{}` when none was typed.
    pub secrets: BTreeMap<String, String>,
}

impl fmt::Debug for TestDraft {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TestDraft")
            .field("name", &self.name)
            .field("fields", &self.fields)
            .field("secrets", &self.secrets.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

/// Input of every `<tool>.test`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolTestInput {
    pub draft: TestDraft,
    /// The stored profile the form edits, whose secrets fill those the draft leaves empty.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub based_on: Option<String>,
}

fn no_store(tool: &str) -> ToolError {
    ToolError::new(
        ToolErrorKind::Remote,
        tool,
        "this server keeps no profiles (the codegen router)",
    )
}

async fn blocking<T: Send + 'static>(
    tool: &str,
    work: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| ToolError::new(ToolErrorKind::Remote, tool, e.to_string()))?
}

fn parse<T: DeserializeOwned>(tool: &str, resolved: Resolved) -> Result<(T, TargetRef), ToolError> {
    let target = resolved.target;
    // serde's message can quote the value it stopped at, which may be a secret: none is kept.
    let profile = serde_json::from_value(resolved.profile).map_err(|_| {
        ToolError::invalid(
            tool,
            "profileId",
            format!(
                "the profile's fields do not read as a {tool} profile: open it and save it again"
            ),
        )
    })?;
    Ok((profile, target))
}

impl Hub {
    /// Sets the profile store (once, at start). The Hub keeps a weak reference: the store holds
    /// the Hub, and the server owns both.
    pub fn set_stored_profiles(&self, profiles: &Arc<dyn StoredProfiles>) {
        let _ = self.profiles.set(Arc::downgrade(profiles));
    }

    fn stored_profiles(&self, tool: &str) -> Result<Arc<dyn StoredProfiles>, ToolError> {
        self.profiles
            .get()
            .and_then(std::sync::Weak::upgrade)
            .ok_or_else(|| no_store(tool))
    }

    /// The profile a `<tool>.connect` names: `profile_id` (stored) or `legacy` (sent by the
    /// browser), exactly one; with the target the handle acts on.
    pub async fn connect_profile<T: DeserializeOwned + Send + 'static>(
        &self,
        ctx: &Ctx,
        tool: &'static str,
        legacy: Option<T>,
        profile_id: Option<String>,
    ) -> Result<(T, TargetRef), ToolError> {
        match (legacy, profile_id) {
            (Some(profile), None) => Ok((profile, crate::authz::targets::browser(tool))),
            (None, Some(id)) => {
                let store = self.stored_profiles(tool)?;
                let p = ctx.principal().clone();
                let resolved = blocking(tool, move || store.connect(&p, tool, &id)).await?;
                parse(tool, resolved)
            }
            _ => Err(ToolError::invalid(
                tool,
                "profileId",
                "name the stored profile (profileId) or send a profile, not both",
            )),
        }
    }

    /// The draft profile of a `<tool>.test`, with the target the test acts on.
    pub async fn test_profile<T: DeserializeOwned + Send + 'static>(
        &self,
        ctx: &Ctx,
        tool: &'static str,
        input: ToolTestInput,
    ) -> Result<(T, TargetRef), ToolError> {
        let store = self.stored_profiles(tool)?;
        let p = ctx.principal().clone();
        let resolved = blocking(tool, move || {
            store.test(&p, tool, input.draft, input.based_on.as_deref())
        })
        .await?;
        parse(tool, resolved)
    }
}
