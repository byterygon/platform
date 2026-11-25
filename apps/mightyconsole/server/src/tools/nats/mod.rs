//! `nats`: NATS on the messaging core (Mightyconsole spec §6, TSK-85), through async-nats 0.52.
//!
//! - `nats.connect` / `nats.disconnect`: a live client from the profile (servers, the five
//!   authentications, TLS, JetStream domain or prefix, inbox prefix, request timeout) with the
//!   profile's local schemas and mappings as its codecs. The client reconnects by itself and says
//!   so on `app.events`.
//! - `nats.server.info`: `ServerInfo`, the round trip, the client's counters and the JetStream
//!   account (or why there is none).
//! - `nats.core.subscribe`: subjects and wildcards, an optional queue group, as a live tail of
//!   `arrow` batches. Core NATS is push only: while the client pauses, the server-side buffer of
//!   the messaging core keeps the newest messages and counts the dropped ones (spec §2.5).
//! - `nats.core.publish` and `nats.core.request`: a Composer payload encoded by the codecs, with
//!   headers; a request answers with the reply as one `MessageRecord`.

pub mod client;
pub mod decoding;
pub mod jetstream;
pub mod kv;
pub mod objects;
pub mod services;

use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use ambidex::{BinarySink, Ctx, RegistryError, Router, rpc};
use async_nats::client::RequestErrorKind;
use futures_util::StreamExt as _;
use message_codecs::filter::Filter;
use message_codecs::message::HeaderInput;
use message_codecs::{
    Codecs, CodecsConfig, ComposePayload, DecodeOptions, Message, Part, SchemaIssue, Target,
    TimestampKind,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use self::client::{
    ConnectNatsProfile, NatsClient, Slot, connect_error, header_map, headers_of, options,
    publish_subject, remote, status_callback, subscribe_subject,
};
use crate::core::messaging::record::MessageRecord;
use crate::core::messaging::tail::{self, Feed, PushBuffer, TailRequest, TailSummary};
use crate::core::messaging::{decode_row, tool_error};
use crate::core::stored::ToolTestInput;
use crate::core::{Empty, Handle, Hub, RemoteError, ToolError, ToolErrorKind, ToolResult};

/// The tool's id and namespace.
pub const TOOL: &str = "nats";

/// The library and its version, for `app.info`.
pub const LIBRARY: &str = "async-nats 0.52";

/// Subjects one subscribe may name.
pub const MAX_SUBJECTS: usize = 32;

// ---- Wire types ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConnectInput {
    /// The stored profile to connect with (DOC-25 §3.4.7).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub profile_id: Option<String>,
    /// A profile the browser sends, until the UI moves to stored profiles; not with `profileId`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub profile: Option<ConnectNatsProfile>,
}

/// What the server said about itself when the client connected (`INFO`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServerInfo {
    pub server_id: String,
    pub server_name: String,
    pub version: String,
    /// The Go version the server was built with.
    pub go: String,
    pub host: String,
    pub port: u16,
    pub max_payload: u64,
    pub proto: i32,
    pub client_id: u64,
    pub client_ip: String,
    /// Other servers of the cluster the client may connect to.
    pub connect_urls: Vec<String>,
    pub headers: bool,
    pub auth_required: bool,
    pub tls_required: bool,
    pub jetstream: bool,
    pub lame_duck_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cluster: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub domain: Option<String>,
}

impl From<async_nats::ServerInfo> for NatsServerInfo {
    fn from(i: async_nats::ServerInfo) -> Self {
        NatsServerInfo {
            server_id: i.server_id,
            server_name: i.server_name,
            version: i.version,
            go: i.go,
            host: i.host,
            port: i.port,
            max_payload: i.max_payload as u64,
            proto: i32::from(i.proto),
            client_id: i.client_id,
            client_ip: i.client_ip,
            connect_urls: i.connect_urls,
            headers: i.headers,
            auth_required: i.auth_required,
            tls_required: i.tls_required,
            jetstream: i.jetstream,
            lame_duck_mode: i.lame_duck_mode,
            cluster: i.cluster.filter(|c| !c.is_empty()),
            domain: i.domain.filter(|d| !d.is_empty()),
        }
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConnectOutput {
    pub conn_id: String,
    pub server: NatsServerInfo,
    /// Local schemas that did not compile, with file and line.
    pub schema_issues: Vec<SchemaIssue>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConnIdInput {
    pub conn_id: String,
}

/// The client's own connection.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsConnection {
    pub name: String,
    /// The profile's servers.
    pub servers: Vec<String>,
    pub tls: bool,
    /// `none`, `userPassword`, `token`, `nkey` or `creds`.
    pub auth: String,
    /// `connected`, `disconnected` (reconnecting) or `pending`.
    pub state: String,
    pub in_messages: u64,
    pub out_messages: u64,
    pub in_bytes: u64,
    pub out_bytes: u64,
    /// Connections made, the first one included.
    pub connects: u64,
}

/// A JetStream limit; absent means unlimited.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsAccountLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_memory: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_storage: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_streams: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub max_consumers: Option<i64>,
}

/// The JetStream account of the connection (spec §6.3, Server).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsAccountInfo {
    pub memory: u64,
    pub storage: u64,
    pub streams: u64,
    pub consumers: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub domain: Option<String>,
    pub limits: NatsAccountLimits,
    /// JetStream API calls of the account, and how many failed.
    pub api_total: u64,
    pub api_errors: u64,
}

impl From<async_nats::jetstream::account::Account> for NatsAccountInfo {
    fn from(a: async_nats::jetstream::account::Account) -> Self {
        NatsAccountInfo {
            memory: a.memory,
            storage: a.storage,
            streams: a.streams as u64,
            consumers: a.consumers as u64,
            domain: a.domain.filter(|d| !d.is_empty()),
            limits: NatsAccountLimits {
                max_memory: a.limits.max_memory,
                max_storage: a.limits.max_storage,
                max_streams: a.limits.max_streams,
                max_consumers: a.limits.max_consumers,
            },
            api_total: a.requests.total,
            api_errors: a.requests.errors,
        }
    }
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServerInfoOutput {
    pub server: NatsServerInfo,
    /// A round trip through the server, in milliseconds.
    pub rtt_ms: f64,
    pub connection: NatsConnection,
    /// `null` when JetStream is off on the server or for this account; `jetstreamError` says why.
    pub jetstream: Option<NatsAccountInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub jetstream_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsSubscribeInput {
    pub conn_id: String,
    pub stream_id: String,
    /// Subjects and patterns (`orders.*.created`, `orders.>`), at most 32.
    pub subjects: Vec<String>,
    /// Share the messages with other members of the queue group.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub queue_group: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<Filter>,
    /// The filter's jq time limit per message, in milliseconds (0.5 to 30 s; 1 s when absent).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub jq_timeout_ms: Option<u64>,
    /// Messages read before a filtered tail stops; 0 for no limit, 100,000 with a filter.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub max_scan: Option<u64>,
    /// Stop after this many matches.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsPublishInput {
    pub conn_id: String,
    pub subject: String,
    /// The reply subject a responder answers to.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub reply_to: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Option<Vec<HeaderInput>>,
    pub payload: ComposePayload,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsPublishOutput {
    /// Payload bytes sent.
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsRequestInput {
    pub conn_id: String,
    pub subject: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Option<Vec<HeaderInput>>,
    pub payload: ComposePayload,
    /// The profile's request timeout when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub timeout_ms: Option<u32>,
    /// How to decode the reply; Auto when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub decode: Option<DecodeOptions>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsRequestOutput {
    pub reply: MessageRecord,
    pub elapsed_ms: f64,
    /// Request payload bytes sent.
    pub bytes: u64,
}

// ---- Helpers ---------------------------------------------------------------------------------

fn now_us() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as i64)
}

/// A received core NATS message in the §5.1 model.
pub fn core_message(m: async_nats::Message, received_us: i64) -> Message {
    let subject = m.subject.to_string();
    let mut out = Message::new(
        subject.clone(),
        m.payload.to_vec(),
        received_us,
        TimestampKind::Received,
    );
    out.subject = Some(subject);
    out.reply_to = m.reply.map(|r| r.to_string());
    out.headers = Some(headers_of(m.headers.as_ref()));
    out
}

fn handle(hub: &Hub, ctx: &Ctx, conn_id: &str) -> Result<Handle<NatsClient>, ToolError> {
    hub.get::<NatsClient>(&ctx.session().id, TOOL, conn_id)
}

fn timeout_of(
    ms: Option<u32>,
    default: std::time::Duration,
) -> Result<std::time::Duration, ToolError> {
    match ms {
        None => Ok(default),
        Some(0) => Err(ToolError::invalid(TOOL, "timeoutMs", "at least 1 ms")),
        Some(ms) if ms > client::MAX_REQUEST_TIMEOUT_MS => Err(ToolError::invalid(
            TOOL,
            "timeoutMs",
            format!("at most {} ms", client::MAX_REQUEST_TIMEOUT_MS),
        )),
        Some(ms) => Ok(std::time::Duration::from_millis(u64::from(ms))),
    }
}

fn publish_error(e: async_nats::PublishError, subject: &str) -> ToolError {
    use async_nats::client::PublishErrorKind;
    match e.kind() {
        PublishErrorKind::MaxPayloadExceeded => ToolError::invalid(
            TOOL,
            "payload",
            format!("the message is larger than the server's max payload: {e}"),
        ),
        PublishErrorKind::InvalidSubject => {
            ToolError::invalid(TOOL, "subject", format!("{subject} is not a valid subject"))
        }
        PublishErrorKind::Send => remote("publish", e),
    }
}

fn request_error(
    e: async_nats::RequestError,
    subject: &str,
    timeout: std::time::Duration,
) -> ToolError {
    let remote_code = |code: &str| RemoteError {
        code: code.into(),
        name: None,
        detail: Some(e.to_string()),
    };
    match e.kind() {
        RequestErrorKind::NoResponders => ToolError::new(
            ToolErrorKind::Remote,
            TOOL,
            format!("No responders on {subject}"),
        )
        .with_remote(remote_code("no_responders")),
        RequestErrorKind::TimedOut => ToolError::new(
            ToolErrorKind::Remote,
            TOOL,
            format!("No reply on {subject} within {} ms", timeout.as_millis()),
        )
        .with_remote(remote_code("timeout"))
        .retryable(true),
        RequestErrorKind::InvalidSubject => {
            ToolError::invalid(TOOL, "subject", format!("{subject} is not a valid subject"))
        }
        RequestErrorKind::MaxPayloadExceeded => ToolError::invalid(
            TOOL,
            "payload",
            format!("the request is larger than the server's max payload: {e}"),
        ),
        RequestErrorKind::Other => remote("request", e),
    }
}

/// Encodes a Composer payload for a subject with the connection's codecs.
async fn encode(
    hub: &Hub,
    session: &str,
    conn_id: &str,
    subject: &str,
    payload: &ComposePayload,
) -> Result<message_codecs::Encoded, ToolError> {
    let codecs = hub.codecs(session, conn_id)?;
    let target = Target::subject(subject);
    codecs
        .encode(Some(&target), Part::Value, payload)
        .await
        .map_err(|e| tool_error(TOOL, e))
}

// ---- Procedures ------------------------------------------------------------------------------

/// `nats.connect` and `nats.disconnect`.
pub struct NatsApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats")]
impl NatsApi {
    /// Opens a connection from the profile; `Auth`, `Tls` and `Connect` errors say what failed.
    #[rpc::mutation(
        perm = "nats.read",
        risk = Risk::Read,
        redact = ["profile.password", "profile.token", "profile.nkeySeed", "profile.creds", "profile.tls.clientKeyPem", "profile.schemaRegistry.password", "profile.schemaRegistry.token", "profile.schemaRegistry.tls.clientKeyPem"],
        audit = "always",
    )]
    async fn connect(&self, ctx: Ctx, input: NatsConnectInput) -> ToolResult<NatsConnectOutput> {
        let (profile, target) = self
            .0
            .connect_profile(&ctx, TOOL, input.profile, input.profile_id)
            .await?;
        let prepared = options(&profile)?;
        // Checked before connecting: a registry the profile cannot use fails the connect.
        let registry = match &profile.schema_registry {
            Some(r) => Some((r.client()?, r.wire_format_on().unwrap_or_default())),
            None => None,
        };
        let slot: Slot = Slot::default();
        let opts = status_callback(
            prepared.options.clone(),
            Arc::clone(&self.0),
            Arc::clone(&slot),
        );
        let nats = opts
            .connect(prepared.servers.clone())
            .await
            .map_err(|e| connect_error(e, prepared.auth, &prepared.server_text))?;
        let server = NatsServerInfo::from(nats.server_info());
        let session = ctx.session().id.clone();
        let client = NatsClient::new(nats, &profile, &prepared);
        let handle = self.0.insert_for(&session, TOOL, Arc::new(client), target);
        let _ = slot.set((session.clone(), handle.conn_id.clone()));
        let (registry, wire_format_on) = match registry {
            // NATS looks for the wire format only on the subjects the profile lists.
            Some((client, subjects)) => (Some(client), Some(subjects)),
            None => (None, None),
        };
        let codecs = Codecs::new(CodecsConfig {
            registry,
            wire_format_on,
            local_schemas: profile.schemas.unwrap_or_default(),
            mappings: profile.mappings.unwrap_or_default(),
            ..CodecsConfig::default()
        });
        let schema_issues = codecs.issues().to_vec();
        self.0.set_codecs(&session, &handle.conn_id, codecs)?;
        Ok(NatsConnectOutput {
            conn_id: handle.conn_id,
            server,
            schema_issues,
        })
    }

    /// Test connection of the profile form: the draft connects (its registry included) and
    /// nothing is kept.
    #[rpc::mutation(perm = "nats.read", risk = Risk::Read, redact = ["draft.secrets"], audit = "always")]
    async fn test(&self, ctx: Ctx, input: ToolTestInput) -> ToolResult<Empty> {
        let (profile, _) = self
            .0
            .test_profile::<ConnectNatsProfile>(&ctx, TOOL, input)
            .await?;
        let prepared = options(&profile)?;
        if let Some(r) = &profile.schema_registry {
            r.client()?;
        }
        let nats = prepared
            .options
            .clone()
            .connect(prepared.servers.clone())
            .await
            .map_err(|e| connect_error(e, prepared.auth, &prepared.server_text))?;
        drop(nats);
        Ok(Empty {})
    }

    /// Releases the connection and ends its streams; idempotent.
    #[rpc::mutation(perm = "nats.read", risk = Risk::Read)]
    async fn disconnect(&self, ctx: Ctx, input: NatsConnIdInput) -> ToolResult<Empty> {
        self.0.remove(&ctx.session().id, TOOL, &input.conn_id);
        Ok(Empty {})
    }
}

/// `nats.server.info`.
pub struct NatsServerApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.server")]
impl NatsServerApi {
    /// `ServerInfo`, the round trip, the client's counters and the JetStream account.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: NatsConnIdInput) -> ToolResult<NatsServerInfoOutput> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let c = &h.value;
        let rtt = c.rtt().await?;
        let info = c.client.server_info();
        let (jetstream, jetstream_error) = if !info.jetstream {
            (
                None,
                Some("JetStream is not enabled on this server".to_owned()),
            )
        } else {
            match c.jetstream.query_account().await {
                Ok(a) => (Some(NatsAccountInfo::from(a)), None),
                Err(e) => (
                    None,
                    Some(format!("JetStream is not available to this account: {e}")),
                ),
            }
        };
        let stats = c.client.statistics();
        let state = match c.client.connection_state() {
            async_nats::connection::State::Connected => "connected",
            async_nats::connection::State::Disconnected => "disconnected",
            async_nats::connection::State::Pending => "pending",
        };
        Ok(NatsServerInfoOutput {
            server: info.into(),
            rtt_ms: rtt.as_secs_f64() * 1000.0,
            connection: NatsConnection {
                name: c.connection_name.clone(),
                servers: c.servers.clone(),
                tls: c.tls,
                auth: c.auth.as_str().into(),
                state: state.into(),
                in_messages: stats.in_messages.load(std::sync::atomic::Ordering::Relaxed),
                out_messages: stats
                    .out_messages
                    .load(std::sync::atomic::Ordering::Relaxed),
                in_bytes: stats.in_bytes.load(std::sync::atomic::Ordering::Relaxed),
                out_bytes: stats.out_bytes.load(std::sync::atomic::Ordering::Relaxed),
                connects: stats.connects.load(std::sync::atomic::Ordering::Relaxed),
            },
            jetstream,
            jetstream_error,
        })
    }
}

/// `nats.core.*`: subscribe, publish, request.
pub struct NatsCoreApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.core")]
impl NatsCoreApi {
    /// Subjects and wildcards as a live tail (spec §5.5): decoded and filtered on the server;
    /// push only, so a paused view fills the server's ring buffer, then drops the oldest.
    #[rpc::stream(perm = "nats.read", risk = Risk::Read, timeout_max = "12h")]
    async fn subscribe(
        &self,
        ctx: Ctx,
        input: NatsSubscribeInput,
        sink: BinarySink,
    ) -> ToolResult<TailSummary> {
        let session = ctx.session().id.clone();
        if input.subjects.is_empty() {
            return Err(ToolError::invalid(TOOL, "subjects", "name at least one subject").into());
        }
        if input.subjects.len() > MAX_SUBJECTS {
            return Err(ToolError::invalid(
                TOOL,
                "subjects",
                format!("at most {MAX_SUBJECTS} subjects"),
            )
            .into());
        }
        let subjects = input
            .subjects
            .iter()
            .map(|s| subscribe_subject(s))
            .collect::<Result<Vec<_>, _>>()?;
        let queue = input
            .queue_group
            .as_deref()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(str::to_owned);
        if queue
            .as_deref()
            .is_some_and(|q| q.contains(char::is_whitespace))
        {
            return Err(
                ToolError::invalid(TOOL, "queueGroup", "a queue group has no spaces").into(),
            );
        }
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (h, _busy) = self.0.busy::<NatsClient>(&session, TOOL, &input.conn_id)?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let mut subs = Vec::with_capacity(subjects.len());
        for s in &subjects {
            let sub = match &queue {
                Some(q) => h.value.client.queue_subscribe(s.clone(), q.clone()).await,
                None => h.value.client.subscribe(s.clone()).await,
            }
            .map_err(|e| remote("subscribe", e))?;
            subs.push(sub);
        }
        let buffer = Arc::new(PushBuffer::default());
        let stop = CancellationToken::new();
        let _stop = stop.clone().drop_guard();
        {
            let buffer = Arc::clone(&buffer);
            let mut merged = futures_util::stream::select_all(subs);
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = stop.cancelled() => return,
                        next = merged.next() => match next {
                            Some(m) => {
                                buffer.push(core_message(m, now_us()));
                                // A flood is always ready: leave room for the other tasks.
                                tokio::task::consume_budget().await;
                            }
                            None => {
                                buffer.close(Some(ToolError::new(
                                    ToolErrorKind::Connect,
                                    TOOL,
                                    "Ended: the NATS connection closed",
                                )));
                                return;
                            }
                        },
                    }
                }
            });
        }
        let decode = input.decode.unwrap_or_default();
        let target = |m: &Message| m.subject.as_ref().map(|s| Target::subject(s.clone()));
        let req = TailRequest {
            codecs: &codecs,
            decode: &decode,
            filter: input.filter.as_ref(),
            max_scan: input.max_scan,
            jq_budget: crate::core::messaging::jq_filter::budget(input.jq_timeout_ms),
            limit: input.limit,
            target: &target,
            system: TOOL,
        };
        tail::run(sink, Feed::push(buffer), req, &progress, &h.token).await
    }

    /// Publishes one message, with headers and a reply subject; answers once the server has it
    /// (flushed).
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write)]
    async fn publish(&self, ctx: Ctx, input: NatsPublishInput) -> ToolResult<NatsPublishOutput> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = publish_subject("subject", &input.subject)?;
        let reply = match input
            .reply_to
            .as_deref()
            .map(str::trim)
            .filter(|r| !r.is_empty())
        {
            Some(r) => Some(publish_subject("replyTo", r)?),
            None => None,
        };
        let headers = header_map(input.headers.as_deref().unwrap_or_default())?;
        let encoded = encode(&self.0, &session, &input.conn_id, &subject, &input.payload).await?;
        let bytes = encoded.bytes.len() as u64;
        let payload = bytes::Bytes::from(encoded.bytes);
        let client = &h.value.client;
        let sent = match (reply, headers) {
            (None, None) => client.publish(subject.clone(), payload).await,
            (None, Some(hs)) => {
                client
                    .publish_with_headers(subject.clone(), hs, payload)
                    .await
            }
            (Some(r), None) => client.publish_with_reply(subject.clone(), r, payload).await,
            (Some(r), Some(hs)) => {
                client
                    .publish_with_reply_and_headers(subject.clone(), r, hs, payload)
                    .await
            }
        };
        sent.map_err(|e| publish_error(e, &subject))?;
        client.flush().await.map_err(|e| remote("flush", e))?;
        Ok(NatsPublishOutput {
            bytes,
            schema_ref: encoded.schema_ref,
        })
    }

    /// Sends a request and waits for the first reply; `Remote` with `no_responders` when nobody
    /// listens, `timeout` when nobody answered in time.
    #[rpc::mutation(perm = "nats.write", risk = Risk::Write, timeout_max = "5m")]
    async fn request(&self, ctx: Ctx, input: NatsRequestInput) -> ToolResult<NatsRequestOutput> {
        let session = ctx.session().id.clone();
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = publish_subject("subject", &input.subject)?;
        let timeout = timeout_of(input.timeout_ms, h.value.request_timeout)?;
        let headers = header_map(input.headers.as_deref().unwrap_or_default())?;
        let encoded = encode(&self.0, &session, &input.conn_id, &subject, &input.payload).await?;
        let bytes = encoded.bytes.len() as u64;
        let mut request = async_nats::Request::new()
            .payload(bytes::Bytes::from(encoded.bytes))
            .timeout(Some(timeout));
        if let Some(hs) = headers {
            request = request.headers(hs);
        }
        let start = Instant::now();
        let reply = tokio::select! {
            biased;
            () = h.token.cancelled() => return Err(ToolError::connection_gone(TOOL).into()),
            reply = h.value.client.send_request(subject.clone(), request) => reply,
        }
        .map_err(|e| request_error(e, &subject, timeout))?;
        let elapsed = start.elapsed();
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let message = core_message(reply, now_us());
        let target = Target::subject(message.source.clone());
        let decode = input.decode.unwrap_or_default();
        let row = decode_row(&codecs, message, &decode, Some(&target), 0).await;
        Ok(NatsRequestOutput {
            reply: MessageRecord::from_row(&row),
            elapsed_ms: elapsed.as_secs_f64() * 1000.0,
            bytes,
        })
    }
}

/// Mounts the `nats.*` procedures.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsApi(Arc::clone(hub)))?;
    router.mount(NatsServerApi(Arc::clone(hub)))?;
    router.mount(NatsCoreApi(Arc::clone(hub)))?;
    jetstream::mount(router, hub)?;
    kv::mount(router, hub)?;
    objects::mount(router, hub)?;
    services::mount(router, hub)?;
    decoding::mount(router, hub)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_core_message_in_the_model() {
        let mut headers = async_nats::HeaderMap::new();
        headers.insert("Lab-Seq", "7");
        let m = async_nats::Message {
            subject: "orders.eu.created".into(),
            reply: Some("_INBOX.r".into()),
            payload: bytes::Bytes::from_static(b"{}"),
            headers: Some(headers),
            status: None,
            description: None,
            length: 2,
        };
        let out = core_message(m, 5);
        assert_eq!(out.source, "orders.eu.created");
        assert_eq!(out.subject.as_deref(), Some("orders.eu.created"));
        assert_eq!(out.reply_to.as_deref(), Some("_INBOX.r"));
        assert_eq!(out.timestamp_kind, TimestampKind::Received);
        assert_eq!(out.headers.unwrap()[0].text(), Some("7"));
    }

    #[test]
    fn timeouts_are_checked() {
        let d = std::time::Duration::from_secs(5);
        assert_eq!(timeout_of(None, d).unwrap(), d);
        assert_eq!(
            timeout_of(Some(0), d).unwrap_err().field.as_deref(),
            Some("timeoutMs")
        );
        assert!(timeout_of(Some(400_000), d).is_err());
    }
}
