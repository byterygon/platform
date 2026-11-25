//! A Schema Registry on a profile (Mightyconsole spec §5.3; DOC-21 Open question 45 (p)): the
//! profile's `fields.schemaRegistry` as a tool's connect input gives it, the client built from
//! it, and the shared `messaging.registry.*` procedures the Schemas tab uses on NATS (TSK-85)
//! and Kafka (TSK-86).
//!
//! The server is the only caller of the registry: the browser never reaches it. HTTPS needs the
//! profile's CA (no system roots, Open question 31). The password and the token are secrets of
//! the profile, redacted from the call log and from `Debug`.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use ambidex::{Ctx, rpc};
use message_codecs::{Codecs, RegistryAuth, RegistryClient, RegistryConfig};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::{SYSTEM, tool_error};
use crate::core::tls::TlsOptions;
use crate::core::{Empty, Hub, ToolError, ToolResult};

/// How long `messaging.registry.test` waits for each answer.
const TEST_TIMEOUT: Duration = Duration::from_secs(10);

/// How the server authenticates to the registry.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RegistryAuthKind {
    #[default]
    None,
    Basic,
    Bearer,
}

/// The profile's registry (`fields.schemaRegistry` with its secrets), as a tool's connect input
/// and `messaging.registry.test` take it.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryProfile {
    /// `http://host:port[/path]` or `https://…`.
    pub url: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<RegistryAuthKind>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub username: Option<String>,
    /// Secret `registryPassword`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
    /// Secret `registryToken`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub token: Option<String>,
    /// The CA to trust for `https` (no system roots), the server name to check, and a client
    /// certificate for mutual TLS (its key a secret).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tls: Option<TlsOptions>,
    /// NATS: the subject patterns whose messages may carry the Confluent wire format, which
    /// auto-detect looks for there only. Absent: everywhere (Kafka).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub wire_format_subjects: Option<Vec<String>>,
}

impl fmt::Debug for RegistryProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let set = |v: &Option<String>| v.as_ref().map(|_| "<redacted>");
        f.debug_struct("RegistryProfile")
            .field("url", &self.url)
            .field("auth", &self.auth)
            .field("username", &self.username)
            .field("password", &set(&self.password))
            .field("token", &set(&self.token))
            .field("tls", &self.tls)
            .field("wire_format_subjects", &self.wire_format_subjects)
            .finish()
    }
}

fn invalid(field: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(SYSTEM, &format!("schemaRegistry.{field}"), message)
}

fn filled(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

impl RegistryProfile {
    /// The client for this registry; `Invalid` names the field (`schemaRegistry.url`, …).
    pub fn client(&self) -> Result<RegistryClient, ToolError> {
        self.client_with(Duration::from_secs(30))
    }

    fn client_with(&self, timeout: Duration) -> Result<RegistryClient, ToolError> {
        let url = self.url.trim();
        if url.is_empty() {
            return Err(invalid("url", "A registry URL is required."));
        }
        let auth = match self.auth.unwrap_or_default() {
            RegistryAuthKind::None => RegistryAuth::None,
            RegistryAuthKind::Basic => {
                let user = filled(&self.username)
                    .ok_or_else(|| invalid("username", "A user name is required."))?;
                let password = filled(&self.password)
                    .ok_or_else(|| invalid("password", "The password is required."))?;
                RegistryAuth::Basic {
                    user: user.to_owned(),
                    password: password.to_owned(),
                }
            }
            RegistryAuthKind::Bearer => RegistryAuth::Bearer {
                token: filled(&self.token)
                    .ok_or_else(|| invalid("token", "The token is required."))?
                    .to_owned(),
            },
        };
        let tls = self.tls.as_ref().map(|t| {
            let some = |v: &Option<String>| v.clone().filter(|s| !s.trim().is_empty());
            message_codecs::TlsOptions {
                enabled: t.enabled.unwrap_or(false),
                ca_pem: some(&t.ca_pem),
                client_cert_pem: some(&t.client_cert_pem),
                server_name: some(&t.server_name),
            }
        });
        let client_key_pem = self
            .tls
            .as_ref()
            .and_then(|t| t.client_key_pem.clone())
            .filter(|s| !s.trim().is_empty());
        if url.starts_with("https://") && tls.as_ref().and_then(|t| t.ca_pem.as_ref()).is_none() {
            return Err(invalid(
                "tls.caPem",
                "An https registry needs its CA certificate: no system roots are trusted.",
            ));
        }
        for p in self.wire_format_subjects.iter().flatten() {
            if let Some(why) = pattern_problem(p) {
                return Err(invalid("wireFormatSubjects", format!("{p}: {why}")));
            }
        }
        let config = RegistryConfig {
            url: url.to_owned(),
            auth,
            tls,
            client_key_pem,
            timeout,
        };
        RegistryClient::new(&config).map_err(|e| {
            let field = e.field.clone().unwrap_or_else(|| "url".into());
            let mut t = tool_error(SYSTEM, e);
            t.field = Some(format!("schemaRegistry.{field}"));
            t
        })
    }

    /// The patterns auto-detect looks for the wire format on (`None`: everywhere).
    pub fn wire_format_on(&self) -> Option<Vec<String>> {
        self.wire_format_subjects.as_ref().map(|v| {
            v.iter()
                .map(|p| p.trim().to_owned())
                .filter(|p| !p.is_empty())
                .collect()
        })
    }
}

/// A NATS subject pattern's problem, if any.
fn pattern_problem(p: &str) -> Option<&'static str> {
    let p = p.trim();
    if p.is_empty() {
        return None;
    }
    if p.contains(char::is_whitespace) {
        return Some("a subject has no spaces");
    }
    let tokens: Vec<&str> = p.split('.').collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return Some("a subject has no empty tokens (..)");
    }
    if tokens[..tokens.len() - 1].contains(&">") {
        return Some("> comes last");
    }
    None
}

/// A connection's codecs with another registry (or none); local schemas, mappings, naming and
/// the mappings' counts stay.
pub fn with_registry(
    current: &Codecs,
    registry: Option<&RegistryProfile>,
) -> Result<Codecs, ToolError> {
    Ok(match registry {
        Some(r) => current.with_registry(Some(r.client()?), r.wire_format_on()),
        None => current.with_registry(None, None),
    })
}

// --- Procedures -------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTestInput {
    /// The tool whose profile the draft is (`nats`).
    pub tool: String,
    /// The profile form's draft, its `schemaRegistry` in `fields` and its typed secrets.
    pub draft: crate::core::stored::TestDraft,
    /// The stored profile the form edits, whose secrets fill those the draft leaves empty
    /// while the draft keeps the registry's target fields (DOC-25 §3.4.8).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub based_on: Option<String>,
}

/// What a registry said when tested.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryTestOutput {
    pub url: String,
    pub subjects: u32,
    /// `READWRITE`, `READONLY`, `IMPORT`; absent when the registry does not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub mode: Option<String>,
    /// The global compatibility level; absent when the registry does not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub compatibility: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySetInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySubjectsInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RegistryVersionsInput {
    pub conn_id: String,
    pub subject: String,
}

/// `messaging.registry.*`.
pub struct RegistryApi(pub Arc<Hub>);

fn registry_of(codecs: &Codecs) -> Result<RegistryClient, ToolError> {
    codecs.registry().cloned().ok_or_else(|| {
        ToolError::new(
            crate::core::ToolErrorKind::Invalid,
            SYSTEM,
            "This profile has no Schema Registry.",
        )
    })
}

#[rpc::router(namespace = "messaging.registry")]
impl RegistryApi {
    /// Reaches the registry of the profile form's draft (before it is saved): counts its
    /// subjects and reads its mode and global compatibility. Its typed secrets are used for this
    /// call only.
    #[rpc::query(
        perm = "messaging.read",
        risk = Risk::Read,
        redact = ["draft.secrets"],
        audit = "always",
    )]
    async fn test(&self, ctx: Ctx, input: RegistryTestInput) -> ToolResult<RegistryTestOutput> {
        let test = crate::core::stored::ToolTestInput {
            draft: input.draft,
            based_on: input.based_on,
        };
        let registry: RegistryProfile = self.0.draft_registry(&ctx, input.tool, test).await?;
        let client = registry.client_with(TEST_TIMEOUT)?;
        let subjects = client.subjects().await.map_err(|e| tool_error(SYSTEM, e))?;
        // Registries that answer `/subjects` but not these (older or compatible ones) still pass.
        let mode = client.mode().await.ok();
        let compatibility = client.compatibility_level(None).await.ok().flatten();
        Ok(RegistryTestOutput {
            url: client.url(),
            subjects: subjects.len() as u32,
            mode,
            compatibility,
        })
    }

    /// Gives a connection its stored profile's registry as saved (or none), its secrets opened
    /// on the server. Streams already running keep the codecs they started with.
    #[rpc::mutation(perm = "messaging.read", risk = Risk::Read)]
    async fn set(&self, ctx: Ctx, input: RegistrySetInput) -> ToolResult<Empty> {
        let session = &ctx.session().id;
        let current = self.0.codecs(session, &input.conn_id)?;
        let registry: Option<RegistryProfile> =
            self.0.stored_registry(&ctx, &input.conn_id).await?;
        let codecs = with_registry(&current, registry.as_ref())?;
        self.0.set_codecs(session, &input.conn_id, codecs)?;
        Ok(Empty {})
    }

    /// The registry's subjects, sorted (the mapping sheet).
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn subjects(&self, ctx: Ctx, input: RegistrySubjectsInput) -> ToolResult<Vec<String>> {
        let codecs = self.0.codecs(&ctx.session().id, &input.conn_id)?;
        let mut subjects = registry_of(&codecs)?
            .subjects()
            .await
            .map_err(|e| tool_error(SYSTEM, e))?;
        subjects.sort();
        Ok(subjects)
    }

    /// A subject's versions, oldest first.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn versions(&self, ctx: Ctx, input: RegistryVersionsInput) -> ToolResult<Vec<u32>> {
        let codecs = self.0.codecs(&ctx.session().id, &input.conn_id)?;
        Ok(registry_of(&codecs)?
            .versions(&input.subject)
            .await
            .map_err(|e| tool_error(SYSTEM, e))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(url: &str) -> RegistryProfile {
        RegistryProfile {
            url: url.into(),
            auth: None,
            username: None,
            password: None,
            token: None,
            tls: None,
            wire_format_subjects: None,
        }
    }

    #[test]
    fn each_field_is_checked_and_named() {
        let field = |p: &RegistryProfile| p.client().unwrap_err().field.unwrap();
        assert_eq!(field(&profile(" ")), "schemaRegistry.url");
        assert_eq!(field(&profile("ftp://x")), "schemaRegistry.url");
        assert_eq!(
            field(&profile("https://r:8081")),
            "schemaRegistry.tls.caPem"
        );
        let mut basic = profile("http://r:8081");
        basic.auth = Some(RegistryAuthKind::Basic);
        assert_eq!(field(&basic), "schemaRegistry.username");
        basic.username = Some("u".into());
        assert_eq!(field(&basic), "schemaRegistry.password");
        basic.password = Some("p".into());
        assert!(basic.client().is_ok());
        let mut bearer = profile("http://r:8081");
        bearer.auth = Some(RegistryAuthKind::Bearer);
        assert_eq!(field(&bearer), "schemaRegistry.token");
        let mut subjects = profile("http://r:8081");
        subjects.wire_format_subjects = Some(vec!["orders.>".into(), "a.>.b".into()]);
        assert_eq!(field(&subjects), "schemaRegistry.wireFormatSubjects");
    }

    #[test]
    fn wire_format_subjects_none_means_everywhere() {
        let mut p = profile("http://r:8081");
        assert_eq!(p.wire_format_on(), None);
        p.wire_format_subjects = Some(vec![" orders.> ".into(), "".into()]);
        assert_eq!(p.wire_format_on(), Some(vec!["orders.>".to_owned()]));
        p.wire_format_subjects = Some(vec![]);
        assert_eq!(p.wire_format_on(), Some(vec![]));
    }

    #[test]
    fn secrets_stay_out_of_debug() {
        let mut p = profile("http://r:8081");
        p.password = Some("hunter2".into());
        p.token = Some("tok-123".into());
        let text = format!("{p:?}");
        assert!(!text.contains("hunter2") && !text.contains("tok-123"));
    }

    #[test]
    fn a_new_registry_keeps_schemas_mappings_and_counts() {
        let codecs = Codecs::default();
        let mut p = profile("http://127.0.0.1:1");
        p.wire_format_subjects = Some(vec!["orders.>".into()]);
        let next = with_registry(&codecs, Some(&p)).unwrap();
        assert!(next.registry().is_some());
        assert_eq!(next.wire_format_on(), Some(&["orders.>".to_owned()][..]));
        let none = with_registry(&next, None).unwrap();
        assert!(none.registry().is_none() && none.wire_format_on().is_none());
    }
}
