//! The NATS client of a connected profile (Mightyconsole spec §6.1, §6.6): the profile as the
//! browser sends it, the async-nats options built from it, the live client, and how async-nats
//! errors become [`ToolError`]s (spec §2.6).

use std::fmt;
use std::str::FromStr as _;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_nats::{ConnectErrorKind, ConnectOptions, HeaderMap, HeaderName};
use futures_util::StreamExt as _;
use message_codecs::message::HeaderInput;
use message_codecs::{Header, LocalSchema, SchemaMapping};
use schemars::JsonSchema;
use serde::Deserialize;
use ts_rs::TS;

use super::TOOL;
use crate::core::messaging::registry::RegistryProfile;
use crate::core::tls::{TlsOptions, TlsOptionsError, client_config};
use crate::core::{ConnectionState, Hub, RemoteError, ToolError, ToolErrorKind};

/// The default server (spec §6.1).
pub const DEFAULT_SERVER: &str = "nats://127.0.0.1:4222";
/// The default connection name, shown in the server's `connz`.
pub const DEFAULT_CONNECTION_NAME: &str = "mightyconsole";
/// Request-reply and JetStream API calls, by default.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(5000);
/// The longest request timeout a profile or a request may ask for.
pub const MAX_REQUEST_TIMEOUT_MS: u32 = 300_000;
/// How long the first connection may take.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How the profile authenticates (spec §6.1, `fields.auth`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum NatsAuth {
    #[default]
    None,
    UserPassword,
    Token,
    Nkey,
    Creds,
}

impl NatsAuth {
    pub fn as_str(self) -> &'static str {
        match self {
            NatsAuth::None => "none",
            NatsAuth::UserPassword => "userPassword",
            NatsAuth::Token => "token",
            NatsAuth::Nkey => "nkey",
            NatsAuth::Creds => "creds",
        }
    }
}

/// JetStream through a domain or an API prefix (leaf nodes, imported JetStream).
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsJetStreamOptions {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub domain: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub api_prefix: Option<String>,
}

/// The NATS profile as `toConnect` builds it (spec §4.4, §6.1). Secrets (`password`, `token`,
/// `nkeySeed`, `creds`, `tls.clientKeyPem`) are redacted from every log.
#[derive(Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectNatsProfile {
    pub name: String,
    /// `nats://` or `tls://` URLs, or `host:port`; several for a cluster.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub servers: Option<Vec<String>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<NatsAuth>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub user: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub token: Option<String>,
    /// A user nkey seed (`SU…`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub nkey_seed: Option<String>,
    /// The text of a `.creds` file: the user JWT and its seed.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub creds: Option<String>,
    /// `tls://` URLs turn TLS on as well.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tls: Option<TlsOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub connection_name: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub jetstream: Option<NatsJetStreamOptions>,
    /// `_INBOX` when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub inbox_prefix: Option<String>,
    /// Request-reply and JetStream API calls; 5,000 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub request_timeout_ms: Option<u32>,
    /// The profile's `extras.schemas`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schemas: Option<Vec<LocalSchema>>,
    /// The profile's `extras.mappings` (subject patterns, KV buckets).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub mappings: Option<Vec<SchemaMapping>>,
    /// The profile's Schema Registry (`fields.schemaRegistry` and its secrets).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schema_registry: Option<RegistryProfile>,
}

impl fmt::Debug for ConnectNatsProfile {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let set = |v: &Option<String>| v.as_ref().map(|_| "<redacted>");
        f.debug_struct("ConnectNatsProfile")
            .field("name", &self.name)
            .field("servers", &self.servers)
            .field("auth", &self.auth)
            .field("user", &self.user)
            .field("password", &set(&self.password))
            .field("token", &set(&self.token))
            .field("nkey_seed", &set(&self.nkey_seed))
            .field("creds", &set(&self.creds))
            .field("tls", &self.tls)
            .field("schema_registry", &self.schema_registry)
            .finish_non_exhaustive()
    }
}

fn non_empty(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// The profile's servers: trimmed, without empty lines, the default when none.
pub fn servers_of(profile: &ConnectNatsProfile) -> Vec<String> {
    let list: Vec<String> = profile
        .servers
        .iter()
        .flatten()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() {
        vec![DEFAULT_SERVER.to_owned()]
    } else {
        list
    }
}

/// Checks each server address: a `nats://`, `tls://` URL or `host:port`.
fn parse_servers(servers: &[String]) -> Result<Vec<async_nats::ServerAddr>, ToolError> {
    servers
        .iter()
        .map(|s| {
            let lower = s.to_ascii_lowercase();
            if lower.contains("://")
                && !["nats://", "tls://", "ws://", "wss://"]
                    .iter()
                    .any(|p| lower.starts_with(p))
            {
                return Err(ToolError::invalid(
                    TOOL,
                    "servers",
                    format!("{s}: use nats://host:port or tls://host:port"),
                ));
            }
            if lower.starts_with("ws://") || lower.starts_with("wss://") {
                return Err(ToolError::invalid(
                    TOOL,
                    "servers",
                    format!("{s}: WebSocket connections are not supported; use nats:// or tls://"),
                ));
            }
            async_nats::ServerAddr::from_str(s)
                .map_err(|e| ToolError::invalid(TOOL, "servers", format!("{s}: {e}")))
        })
        .collect()
}

/// Whether the profile asks for TLS: the option, or a `tls://` server.
pub fn wants_tls(profile: &ConnectNatsProfile, servers: &[String]) -> bool {
    profile
        .tls
        .as_ref()
        .and_then(|t| t.enabled)
        .unwrap_or(false)
        || servers
            .iter()
            .any(|s| s.to_ascii_lowercase().starts_with("tls://"))
}

fn request_timeout(ms: Option<u32>, field: &str) -> Result<Duration, ToolError> {
    match ms {
        None => Ok(DEFAULT_REQUEST_TIMEOUT),
        Some(0) => Err(ToolError::invalid(TOOL, field, "at least 1 ms")),
        Some(ms) if ms > MAX_REQUEST_TIMEOUT_MS => Err(ToolError::invalid(
            TOOL,
            field,
            format!("at most {MAX_REQUEST_TIMEOUT_MS} ms"),
        )),
        Some(ms) => Ok(Duration::from_millis(u64::from(ms))),
    }
}

/// What connect needs besides the options: the parsed servers, TLS, the timeouts.
pub struct Prepared {
    pub options: ConnectOptions,
    pub servers: Vec<async_nats::ServerAddr>,
    pub server_text: Vec<String>,
    pub tls: bool,
    pub auth: NatsAuth,
    pub request_timeout: Duration,
    pub connection_name: String,
}

impl Prepared {
    /// Every server of the profile is one the server's outbound policy lets it reach (TSK-141):
    /// checked before connecting. async-nats resolves the names again itself, so a name whose
    /// address changes in between is not caught here (DOC-25 Open question 27).
    pub async fn check_reach(&self) -> Result<(), ToolError> {
        for server in &self.servers {
            crate::core::outbound::resolve(TOOL, server.host(), server.port()).await?;
        }
        Ok(())
    }
}

/// The async-nats options of a profile; field errors name the profile's field.
pub fn options(profile: &ConnectNatsProfile) -> Result<Prepared, ToolError> {
    let tls_config = client_config(&profile.tls.clone().unwrap_or_default());
    prepare(profile, tls_config)
}

/// [`options`] with the TLS configuration already built (or why it could not be). It is only
/// required when the profile asks for TLS: a plain `nats://` profile connects without one, so a
/// machine with no trust store (a `FROM scratch` image) still reaches a plain server, and a server
/// that turns out to require TLS fails at connect with a TLS error.
fn prepare(
    profile: &ConnectNatsProfile,
    tls_config: Result<rustls::ClientConfig, TlsOptionsError>,
) -> Result<Prepared, ToolError> {
    let server_text = servers_of(profile);
    let servers = parse_servers(&server_text)?;
    let tls = wants_tls(profile, &server_text);
    let auth = profile.auth.unwrap_or_default();
    let request_timeout = request_timeout(profile.request_timeout_ms, "requestTimeoutMs")?;
    let connection_name = non_empty(&profile.connection_name)
        .unwrap_or(DEFAULT_CONNECTION_NAME)
        .to_owned();
    let mut options = match auth {
        NatsAuth::None => ConnectOptions::new(),
        NatsAuth::UserPassword => {
            let user = non_empty(&profile.user)
                .ok_or_else(|| ToolError::invalid(TOOL, "user", "a user name is required"))?;
            // A password may be empty, but must be set.
            let password = profile
                .password
                .clone()
                .ok_or_else(|| ToolError::invalid(TOOL, "password", "the password is not set"))?;
            ConnectOptions::with_user_and_password(user.to_owned(), password)
        }
        NatsAuth::Token => {
            let token = non_empty(&profile.token)
                .ok_or_else(|| ToolError::invalid(TOOL, "token", "the token is not set"))?;
            ConnectOptions::with_token(token.to_owned())
        }
        NatsAuth::Nkey => {
            let seed = non_empty(&profile.nkey_seed)
                .ok_or_else(|| ToolError::invalid(TOOL, "nkeySeed", "the nkey seed is not set"))?;
            if !(seed.starts_with("SU") && seed.len() == 58) {
                return Err(ToolError::invalid(
                    TOOL,
                    "nkeySeed",
                    "a user nkey seed starts with SU and is 58 characters long",
                ));
            }
            ConnectOptions::with_nkey(seed.to_owned())
        }
        NatsAuth::Creds => {
            let creds = non_empty(&profile.creds)
                .ok_or_else(|| ToolError::invalid(TOOL, "creds", "the .creds file is not set"))?;
            ConnectOptions::with_credentials(creds)
                .map_err(|e| ToolError::invalid(TOOL, "creds", format!("not a .creds file: {e}")))?
        }
    };
    options = options
        .name(&connection_name)
        .connection_timeout(CONNECT_TIMEOUT)
        .request_timeout(Some(request_timeout))
        .require_tls(tls);
    match tls_config {
        Ok(config) => options = options.tls_client_config(config),
        Err(e) if tls => return Err(ToolError::invalid(TOOL, e.field, e.message)),
        // Plain: no usable trust store is not this connection's problem.
        Err(_) => {}
    }
    if let Some(prefix) = non_empty(&profile.inbox_prefix) {
        if prefix.contains(['*', '>', ' ']) {
            return Err(ToolError::invalid(
                TOOL,
                "inboxPrefix",
                "an inbox prefix is a subject without wildcards or spaces",
            ));
        }
        options = options.custom_inbox_prefix(prefix);
    }
    // A NATS server tells its clients about the other servers of its cluster, and the client may
    // reconnect to them without asking (async-nats resolves and connects itself). When the operator
    // narrowed the reach (`[outbound] allow`, TSK-141), only the profile's own servers, which
    // [`Prepared::check_reach`] checks, are used.
    if crate::core::outbound::policy().is_narrowed() {
        options = options.ignore_discovered_servers();
    }
    Ok(Prepared {
        options,
        servers,
        server_text,
        tls,
        auth,
        request_timeout,
        connection_name,
    })
}

/// A connect error as the UI needs it: `Auth`, `Tls`, `Connect` or `Invalid` (spec §6.5).
pub fn connect_error(e: async_nats::ConnectError, auth: NatsAuth, servers: &[String]) -> ToolError {
    let detail = e.to_string();
    let at = servers.join(", ");
    let lower = detail.to_ascii_lowercase();
    let tls_failure = lower.contains("certificate")
        || lower.contains("handshake")
        || lower.contains("unknownissuer")
        || lower.contains("tls");
    match e.kind() {
        ConnectErrorKind::AuthorizationViolation => ToolError::new(
            ToolErrorKind::Auth,
            TOOL,
            format!("{at} rejected the credentials (authorization violation)"),
        ),
        ConnectErrorKind::Authentication => {
            let what = match auth {
                NatsAuth::Nkey => "the nkey seed could not sign the server's nonce",
                NatsAuth::Creds => "the .creds file could not sign the server's nonce",
                _ => "authentication failed",
            };
            ToolError::new(ToolErrorKind::Auth, TOOL, format!("{what}: {detail}"))
        }
        ConnectErrorKind::Tls => ToolError::new(
            ToolErrorKind::Tls,
            TOOL,
            format!("TLS to {at} failed: {detail}"),
        ),
        ConnectErrorKind::ServerParse => ToolError::invalid(TOOL, "servers", detail.clone()),
        ConnectErrorKind::Io if tls_failure => ToolError::new(
            ToolErrorKind::Tls,
            TOOL,
            format!("TLS to {at} failed: {detail}"),
        ),
        ConnectErrorKind::TimedOut => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("{at} did not answer within {} s", CONNECT_TIMEOUT.as_secs()),
        ),
        _ => ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("could not reach {at}: {detail}"),
        ),
    }
    .with_remote(RemoteError {
        code: format!("{:?}", e.kind()),
        name: None,
        detail: Some(detail),
    })
}

/// The handle's identity, known once the hub registered it (for status events).
pub type Slot = Arc<OnceLock<(String, String)>>;

/// Reports the client's own reconnects on `app.events` (spec §2.2, "Status").
pub fn status_callback(options: ConnectOptions, hub: Arc<Hub>, slot: Slot) -> ConnectOptions {
    // The first `Connected` is the connection `connect` answers for (the hub announces it).
    let reconnecting = Arc::new(std::sync::atomic::AtomicBool::new(false));
    options.event_callback(move |event| {
        let hub = Arc::clone(&hub);
        let slot = Arc::clone(&slot);
        let reconnecting = Arc::clone(&reconnecting);
        async move {
            let Some((session, conn_id)) = slot.get() else {
                return;
            };
            let (state, message) = match event {
                async_nats::Event::Connected => {
                    if !reconnecting.swap(false, std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    (ConnectionState::Connected, None)
                }
                async_nats::Event::Disconnected => {
                    reconnecting.store(true, std::sync::atomic::Ordering::Relaxed);
                    (
                        ConnectionState::Reconnecting,
                        Some("lost the connection to the server; reconnecting".to_owned()),
                    )
                }
                async_nats::Event::LameDuckMode => (
                    ConnectionState::Connected,
                    Some("the server is in lame duck mode and will close".to_owned()),
                ),
                async_nats::Event::SlowConsumer(_) => (
                    ConnectionState::Connected,
                    Some("a subscription could not keep up; messages were dropped".to_owned()),
                ),
                async_nats::Event::ServerError(e) => (
                    ConnectionState::Connected,
                    Some(format!("server error: {e}")),
                ),
                async_nats::Event::ClientError(e) => (
                    ConnectionState::Connected,
                    Some(format!("client error: {e}")),
                ),
                async_nats::Event::Draining | async_nats::Event::Closed => return,
            };
            hub.status(session, TOOL, conn_id, state, message);
        }
    })
}

/// A connected profile.
pub struct NatsClient {
    pub client: async_nats::Client,
    pub jetstream: async_nats::jetstream::Context,
    pub tls: bool,
    pub auth: NatsAuth,
    pub request_timeout: Duration,
    pub connection_name: String,
    pub servers: Vec<String>,
}

impl NatsClient {
    pub fn new(
        client: async_nats::Client,
        profile: &ConnectNatsProfile,
        prepared: &Prepared,
    ) -> NatsClient {
        let js = profile.jetstream.clone().unwrap_or_default();
        let mut jetstream = match (non_empty(&js.domain), non_empty(&js.api_prefix)) {
            (Some(domain), _) => async_nats::jetstream::with_domain(client.clone(), domain),
            (None, Some(prefix)) => async_nats::jetstream::with_prefix(client.clone(), prefix),
            (None, None) => async_nats::jetstream::new(client.clone()),
        };
        // The profile's timeout covers JetStream API calls too (spec §6.1).
        jetstream.set_timeout(prepared.request_timeout);
        NatsClient {
            client,
            jetstream,
            tls: prepared.tls,
            auth: prepared.auth,
            request_timeout: prepared.request_timeout,
            connection_name: prepared.connection_name.clone(),
            servers: prepared.server_text.clone(),
        }
    }

    /// A round trip through the server: a message to a fresh inbox and back.
    pub async fn rtt(&self) -> Result<Duration, ToolError> {
        let inbox = self.client.new_inbox();
        let mut sub = self
            .client
            .subscribe(inbox.clone())
            .await
            .map_err(|e| remote("subscribe", e))?;
        let start = Instant::now();
        self.client
            .publish(inbox, bytes::Bytes::new())
            .await
            .map_err(|e| remote("publish", e))?;
        self.client.flush().await.map_err(|e| remote("flush", e))?;
        match tokio::time::timeout(self.request_timeout, sub.next()).await {
            Ok(Some(_)) => Ok(start.elapsed()),
            _ => Err(ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                "the server did not echo a message to this connection's inbox",
            )),
        }
    }
}

impl Drop for NatsClient {
    fn drop(&mut self) {
        // Released: flush what is pending and close, without waiting for it.
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            let client = self.client.clone();
            rt.spawn(async move {
                let _ = client.drain().await;
            });
        }
    }
}

/// Any other async-nats error, with its text (`Remote`).
pub fn remote(what: &str, e: impl fmt::Display) -> ToolError {
    ToolError::new(ToolErrorKind::Remote, TOOL, format!("{what} failed: {e}"))
}

/// A subject to publish or request on: not empty, no spaces, no wildcards.
pub fn publish_subject(field: &str, subject: &str) -> Result<String, ToolError> {
    let s = subject.trim();
    if s.is_empty() {
        return Err(ToolError::invalid(TOOL, field, "a subject is required"));
    }
    if s.contains(char::is_whitespace) {
        return Err(ToolError::invalid(TOOL, field, "a subject has no spaces"));
    }
    if s.split('.').any(|t| t.is_empty()) {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "a subject has no empty tokens (..)",
        ));
    }
    if s.split('.').any(|t| t == "*" || t == ">") {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "wildcards (* and >) only subscribe; publish to a whole subject",
        ));
    }
    Ok(s.to_owned())
}

/// A subject or pattern to subscribe to: `*` and `>` allowed, `>` last.
pub fn subscribe_subject(subject: &str) -> Result<String, ToolError> {
    let s = subject.trim();
    if s.is_empty() || s.contains(char::is_whitespace) {
        return Err(ToolError::invalid(
            TOOL,
            "subjects",
            format!("{subject:?} is not a subject"),
        ));
    }
    let tokens: Vec<&str> = s.split('.').collect();
    if tokens.iter().any(|t| t.is_empty()) {
        return Err(ToolError::invalid(
            TOOL,
            "subjects",
            format!("{s} has an empty token"),
        ));
    }
    if tokens[..tokens.len() - 1].contains(&">") {
        return Err(ToolError::invalid(
            TOOL,
            "subjects",
            format!("{s}: > comes last"),
        ));
    }
    Ok(s.to_owned())
}

/// The headers of a received message, sorted by name, every value kept.
pub fn headers_of(map: Option<&HeaderMap>) -> Vec<Header> {
    let Some(map) = map else {
        return Vec::new();
    };
    let mut out: Vec<Header> = map
        .iter()
        .flat_map(|(name, values)| {
            let name: &str = name.as_ref();
            values
                .iter()
                .map(move |v| Header::new(name, v.as_str().as_bytes().to_vec()))
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// The headers the Composer sends; NATS headers are text, so a base64 value must decode to UTF-8.
pub fn header_map(inputs: &[HeaderInput]) -> Result<Option<HeaderMap>, ToolError> {
    if inputs.is_empty() {
        return Ok(None);
    }
    let mut map = HeaderMap::new();
    for input in inputs {
        let header = input
            .to_header()
            .map_err(|e| crate::core::messaging::tool_error(TOOL, e))?;
        let name = HeaderName::from_str(header.name.trim()).map_err(|e| {
            ToolError::invalid(TOOL, "headers", format!("header {:?}: {e}", header.name))
        })?;
        let value = String::from_utf8(header.value).map_err(|_| {
            ToolError::invalid(
                TOOL,
                "headers",
                format!("header {}: NATS header values are text", header.name),
            )
        })?;
        if value.contains(['\r', '\n']) {
            return Err(ToolError::invalid(
                TOOL,
                "headers",
                format!("header {}: a value is one line", header.name),
            ));
        }
        map.append(name, value);
    }
    Ok(Some(map))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn profile(v: serde_json::Value) -> ConnectNatsProfile {
        serde_json::from_value(v).unwrap()
    }

    fn err(v: serde_json::Value) -> ToolError {
        match options(&profile(v)) {
            Ok(_) => panic!("accepted"),
            Err(e) => e,
        }
    }

    #[test]
    fn no_trust_store_only_matters_when_tls_is_asked_for() {
        // A machine without CA certificates (the FROM scratch image): client_config fails.
        let none = || {
            Err(TlsOptionsError {
                field: "tls.caPem",
                message: "this system has no trusted CA certificates; pin the server's CA".into(),
            })
        };
        let plain = profile(json!({ "name": "lab", "servers": ["nats://127.0.0.1:4222"] }));
        let prepared = prepare(&plain, none()).unwrap();
        assert!(!prepared.tls);
        for asks in [
            json!({ "name": "lab", "servers": ["tls://127.0.0.1:4222"] }),
            json!({ "name": "lab", "tls": { "enabled": true } }),
        ] {
            let e = match prepare(&profile(asks), none()) {
                Ok(_) => panic!("TLS without a trust store accepted"),
                Err(e) => e,
            };
            assert_eq!(e.field.as_deref(), Some("tls.caPem"));
            assert!(e.message.contains("no trusted CA"));
        }
    }

    #[test]
    fn defaults_and_tls() {
        let p = profile(json!({ "name": "lab" }));
        let prepared = options(&p).unwrap();
        assert_eq!(prepared.server_text, vec![DEFAULT_SERVER]);
        assert!(!prepared.tls);
        assert_eq!(prepared.request_timeout, DEFAULT_REQUEST_TIMEOUT);
        assert_eq!(prepared.connection_name, "mightyconsole");
        let p = profile(json!({ "name": "lab", "servers": ["tls://127.0.0.1:4222", " "] }));
        let prepared = options(&p).unwrap();
        assert!(prepared.tls);
        assert_eq!(prepared.server_text.len(), 1);
    }

    #[test]
    fn each_auth_needs_its_secret() {
        assert_eq!(
            err(json!({ "name": "l", "auth": "userPassword" }))
                .field
                .as_deref(),
            Some("user")
        );
        assert_eq!(
            err(json!({ "name": "l", "auth": "userPassword", "user": "lab" }))
                .field
                .as_deref(),
            Some("password")
        );
        assert_eq!(
            err(json!({ "name": "l", "auth": "token" }))
                .field
                .as_deref(),
            Some("token")
        );
        assert_eq!(
            err(json!({ "name": "l", "auth": "nkey", "nkeySeed": "SAxyz" }))
                .field
                .as_deref(),
            Some("nkeySeed")
        );
        assert_eq!(
            err(json!({ "name": "l", "auth": "creds", "creds": "not a creds file" }))
                .field
                .as_deref(),
            Some("creds")
        );
        assert_eq!(
            err(json!({ "name": "l", "servers": ["http://x:1"] }))
                .field
                .as_deref(),
            Some("servers")
        );
        assert_eq!(
            err(json!({ "name": "l", "requestTimeoutMs": 0 }))
                .field
                .as_deref(),
            Some("requestTimeoutMs")
        );
        assert_eq!(
            err(json!({ "name": "l", "tls": { "enabled": true, "caPem": "nope" } }))
                .field
                .as_deref(),
            Some("tls.caPem")
        );
        assert_eq!(
            err(json!({ "name": "l", "inboxPrefix": "a.*" }))
                .field
                .as_deref(),
            Some("inboxPrefix")
        );
        assert!(
            options(&profile(
                json!({ "name": "l", "auth": "userPassword", "user": "lab", "password": "" })
            ))
            .is_ok()
        );
    }

    #[test]
    fn secrets_stay_out_of_debug() {
        let p = profile(
            json!({ "name": "l", "auth": "token", "token": "SECRET", "creds": "SECRET2", "password": "SECRET3" }),
        );
        let text = format!("{p:?}");
        assert!(!text.contains("SECRET"), "{text}");
    }

    #[test]
    fn subjects() {
        assert!(publish_subject("subject", "orders.eu.created").is_ok());
        for bad in ["", "a b", "a..b", "orders.*", "orders.>"] {
            assert_eq!(
                publish_subject("subject", bad)
                    .unwrap_err()
                    .field
                    .as_deref(),
                Some("subject"),
                "{bad}"
            );
        }
        assert!(subscribe_subject("orders.*.created").is_ok());
        assert!(subscribe_subject(">").is_ok());
        for bad in ["", "a b", "a..b", "a.>.b"] {
            assert!(subscribe_subject(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn headers_round_trip_as_text() {
        use message_codecs::message::HeaderEncoding;
        let map = header_map(&[
            HeaderInput {
                key: "Nats-Msg-Id".into(),
                value: "a".into(),
                encoding: None,
            },
            HeaderInput {
                key: "X".into(),
                value: "1".into(),
                encoding: None,
            },
            HeaderInput {
                key: "X".into(),
                value: "Mg==".into(),
                encoding: Some(HeaderEncoding::Base64),
            },
        ])
        .unwrap()
        .unwrap();
        let back = headers_of(Some(&map));
        let pairs: Vec<(&str, &str)> = back
            .iter()
            .map(|h| (h.name.as_str(), h.text().unwrap()))
            .collect();
        assert_eq!(pairs, vec![("Nats-Msg-Id", "a"), ("X", "1"), ("X", "2")]);
        let bad = header_map(&[HeaderInput {
            key: "B".into(),
            value: "/w==".into(),
            encoding: Some(HeaderEncoding::Base64),
        }]);
        assert_eq!(bad.unwrap_err().field.as_deref(), Some("headers"));
        let bad = header_map(&[HeaderInput {
            key: "a b".into(),
            value: "x".into(),
            encoding: None,
        }]);
        assert_eq!(bad.unwrap_err().field.as_deref(), Some("headers"));
        assert!(header_map(&[]).unwrap().is_none());
    }
}
