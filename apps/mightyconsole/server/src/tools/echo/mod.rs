//! `echo`: the sample tool of the foundation (TSK-79). It talks to nothing; it shows the tool
//! contract end to end so every real tool can copy its shape:
//!
//! - `echo.connect` keeps a profile's greeting as the live client and returns a `connId`; a
//!   profile whose `token` is `"wrong"` fails with `Auth`, as a real target would.
//! - `echo.ping` is a query on a handle.
//! - `echo.ticks` is a live `jsonl` stream with a `streamId`: one line per tick, paced by the
//!   client's credits, with `StreamProgress` on `app.events`.
//! - `echo.shell` is a terminal: a `bytes` stream whose input comes from `term.*`; it echoes what
//!   is typed and ends on end of input with exit code 0.

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Code, Ctx, RpcError, rpc};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::core::messaging::tail::{self, Feed, PushBuffer, TailRequest, TailSummary};
use crate::core::messaging::testing::{TestTopic, TopicReader};
use crate::core::messaging::tool_error;
use crate::core::{Empty, Hub, TermInput, ToolError, ToolErrorKind, ToolResult};
use base64::Engine as _;
use message_codecs::filter::Filter;
use message_codecs::message::HeaderInput;
use message_codecs::{Codecs, CodecsConfig, ComposePayload, DecodeOptions, Part, Target};

/// The tool's id and namespace.
pub const TOOL: &str = "echo";

/// The test topic of every echo connection (spec §5.8).
pub const TOPIC: &str = "echo";
pub const TOPIC_PARTITIONS: usize = 3;

/// The terminal's stdout channel byte (spec §2.5, `bytes` format).
pub const STDOUT: u8 = 1;

/// The echo tool's profile as `toConnect` builds it (spec §4.4).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectEchoProfile {
    pub name: String,
    /// Sent back by `echo.ping`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub greeting: Option<String>,
    /// A stand-in secret: `"wrong"` is refused with `Auth`. Never logged.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub token: Option<String>,
    /// Local schemas for the test topic's messages (the profile's `extras.schemas`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schemas: Option<Vec<message_codecs::LocalSchema>>,
    /// Mappings of local schemas to the topic `echo` (the profile's `extras.mappings`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub mappings: Option<Vec<message_codecs::SchemaMapping>>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoConnectInput {
    pub profile: ConnectEchoProfile,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoConnectOutput {
    pub conn_id: String,
    pub greeting: String,
    /// Local schemas that did not compile, with file and line.
    pub schema_issues: Vec<message_codecs::SchemaIssue>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoConnIdInput {
    pub conn_id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoPingInput {
    pub conn_id: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoPingOutput {
    pub greeting: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoTicksInput {
    pub conn_id: String,
    pub stream_id: String,
    /// Ticks to send before ending; until stopped when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub count: Option<u32>,
    /// Time between ticks, 0 to 60,000 ms; 100 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub interval_ms: Option<u32>,
}

/// One line of `echo.ticks` (`jsonl`).
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoTick {
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoTicksSummary {
    pub sent: u64,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoShellInput {
    pub conn_id: String,
    pub terminal_id: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoShellSummary {
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
}

/// The live "client" of a connected echo profile.
struct EchoClient {
    greeting: String,
    /// The test backend of the messaging core (spec §5.8): topic `echo`, 3 partitions.
    topic: Arc<TestTopic>,
}

pub struct EchoApi(pub Arc<Hub>);

impl EchoApi {
    fn ended(code: Code) -> RpcError<ToolError> {
        RpcError::new(code, "the connection was closed")
    }
}

#[rpc::router(namespace = "echo")]
impl EchoApi {
    /// Opens a connection from the profile.
    #[rpc::mutation(perm = "echo.read", risk = Risk::Read, redact = ["profile.token"], audit = "always")]
    async fn connect(&self, ctx: Ctx, input: EchoConnectInput) -> ToolResult<EchoConnectOutput> {
        let profile = input.profile;
        if profile.token.as_deref() == Some("wrong") {
            return Err(ToolError::new(ToolErrorKind::Auth, TOOL, "the token was rejected").into());
        }
        let greeting = profile
            .greeting
            .filter(|g| !g.is_empty())
            .unwrap_or_else(|| format!("hello from {}", profile.name));
        let session = &ctx.session().id;
        let handle = self.0.insert(
            session,
            TOOL,
            Arc::new(EchoClient {
                greeting: greeting.clone(),
                topic: Arc::new(TestTopic::new(TOPIC, TOPIC_PARTITIONS, self.0.clock())),
            }),
        );
        let codecs = Codecs::new(CodecsConfig {
            local_schemas: profile.schemas.unwrap_or_default(),
            mappings: profile.mappings.unwrap_or_default(),
            ..CodecsConfig::default()
        });
        let schema_issues = codecs.issues().to_vec();
        self.0.set_codecs(session, &handle.conn_id, codecs)?;
        Ok(EchoConnectOutput {
            conn_id: handle.conn_id,
            greeting,
            schema_issues,
        })
    }

    /// Releases the connection and ends its streams; idempotent.
    #[rpc::mutation(perm = "echo.read", risk = Risk::Read)]
    async fn disconnect(&self, ctx: Ctx, input: EchoConnIdInput) -> ToolResult<Empty> {
        self.0.remove(&ctx.session().id, TOOL, &input.conn_id);
        Ok(Empty {})
    }

    /// Answers with the connection's greeting and the text.
    #[rpc::query(perm = "echo.read", risk = Risk::Read)]
    async fn ping(&self, ctx: Ctx, input: EchoPingInput) -> ToolResult<EchoPingOutput> {
        let handle = self
            .0
            .get::<EchoClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        Ok(EchoPingOutput {
            greeting: handle.value.greeting.clone(),
            text: input.text,
        })
    }

    /// A live `jsonl` stream of ticks, one line per chunk, as fast as the interval and the
    /// client's credits allow.
    #[rpc::stream(perm = "echo.read", risk = Risk::Read, timeout_max = "12h")]
    async fn ticks(
        &self,
        ctx: Ctx,
        input: EchoTicksInput,
        sink: BinarySink,
    ) -> ToolResult<EchoTicksSummary> {
        let session = ctx.session().id.clone();
        let interval = input.interval_ms.unwrap_or(100);
        if interval > 60_000 {
            return Err(ToolError::invalid(TOOL, "intervalMs", "at most 60000").into());
        }
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self.0.busy::<EchoClient>(&session, TOOL, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let mut sent = 0u64;
        loop {
            if input.count.is_some_and(|count| sent >= u64::from(count)) {
                return Ok(EchoTicksSummary { sent });
            }
            tokio::select! {
                biased;
                () = handle.token.cancelled() => return Err(Self::ended(Code::Cancelled)),
                ready = sink.ready() => ready?,
            }
            let mut line = serde_json::to_vec(&EchoTick { seq: sent }).expect("a tick serializes");
            line.push(b'\n');
            progress.scanned(1);
            progress.matched(1, line.len() as u64);
            sink.send(line).await?;
            sent += 1;
            if interval > 0 {
                tokio::select! {
                    biased;
                    () = handle.token.cancelled() => return Err(Self::ended(Code::Cancelled)),
                    () = tokio::time::sleep(Duration::from_millis(u64::from(interval))) => {}
                }
            }
        }
    }

    /// A terminal that echoes its input: `term.write` bytes come back on stdout, Ctrl+D or
    /// `term.signal eof` ends it with exit code 0.
    #[rpc::stream(perm = "echo.write", risk = Risk::Write, timeout_max = "12h")]
    async fn shell(
        &self,
        ctx: Ctx,
        input: EchoShellInput,
        sink: BinarySink,
    ) -> ToolResult<EchoShellSummary> {
        let session = ctx.session().id.clone();
        let (handle, _busy) = self.0.busy::<EchoClient>(&session, TOOL, &input.conn_id)?;
        let mut terminal =
            self.0
                .open_terminal(&session, TOOL, &input.conn_id, &input.terminal_id)?;
        let out = |text: &[u8]| {
            let mut chunk = Vec::with_capacity(text.len() + 1);
            chunk.push(STDOUT);
            chunk.extend_from_slice(text);
            chunk
        };
        let banner = format!("{}\r\necho shell: Ctrl+D ends\r\n", handle.value.greeting);
        sink.send(out(banner.as_bytes())).await?;
        loop {
            let next = tokio::select! {
                biased;
                () = handle.token.cancelled() => {
                    terminal.exit(None, "the connection was closed");
                    return Err(Self::ended(Code::Cancelled));
                }
                next = terminal.input.recv() => next,
            };
            match next {
                None => {
                    terminal.exit(None, "the connection was closed");
                    return Err(Self::ended(Code::Cancelled));
                }
                Some(TermInput::Eof) => break,
                Some(TermInput::Data(bytes)) => {
                    if let Some(at) = bytes.iter().position(|&b| b == 0x04) {
                        if at > 0 {
                            sink.send(out(&bytes[..at])).await?;
                        }
                        break;
                    }
                    sink.send(out(&bytes)).await?;
                }
                Some(TermInput::Interrupt) => sink.send(out(b"^C\r\n")).await?,
                Some(TermInput::Resize { cols, rows }) => {
                    sink.send(out(format!("[{cols}x{rows}]\r\n").as_bytes()))
                        .await?;
                }
            }
        }
        terminal.exit(Some(0), "exited");
        Ok(EchoShellSummary { exit_code: Some(0) })
    }
}

// --- echo.messages: the messaging core on the test backend (TSK-80) ---------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoProduceInput {
    pub conn_id: String,
    /// The partition; by the key's hash, or round robin, when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub partition: Option<i32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub key: Option<ComposePayload>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub headers: Option<Vec<HeaderInput>>,
    pub value: ComposePayload,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoProduceOutput {
    pub partition: i32,
    /// Decimal, as every offset on the wire.
    pub offset: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
}

/// One partition's start offset.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PartitionOffset {
    pub partition: i32,
    /// Decimal.
    pub offset: String,
}

/// Where a tail starts (Kafka's words: the test topic behaves as a Kafka topic).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EchoStart {
    Earliest,
    Latest,
    /// The last `n` messages of each partition.
    LatestN {
        n: u32,
    },
    Offsets {
        offsets: Vec<PartitionOffset>,
    },
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EchoTailInput {
    pub conn_id: String,
    pub stream_id: String,
    pub start: EchoStart,
    /// Keep reading new messages; else stop at the end as of the start.
    pub follow: bool,
    /// Push-only, as core NATS: new messages only, dropped when the client does not read.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub push: Option<bool>,
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
    /// Messages read before a filtered scan stops; 0 for no limit, 100,000 with a filter.
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
pub struct EchoGetInput {
    pub conn_id: String,
    pub partition: i32,
    pub offset: String,
}

/// A whole message, for "Load full payload" (spec §5.1).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FullMessage {
    pub partition: i32,
    pub offset: String,
    /// Base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub key: Option<String>,
    /// Base64, the whole payload.
    pub payload: String,
    pub size: u64,
}

pub struct EchoMessagesApi(pub Arc<Hub>);

fn offset_arg(field: &str, s: &str) -> Result<i64, ToolError> {
    s.trim()
        .parse::<i64>()
        .ok()
        .filter(|o| *o >= 0)
        .ok_or_else(|| ToolError::invalid(TOOL, field, format!("{s} is not an offset")))
}

#[rpc::router(namespace = "echo.messages")]
impl EchoMessagesApi {
    /// Writes a message to the test topic through the codecs (the Composer's Send).
    #[rpc::mutation(perm = "echo.write", risk = Risk::Write)]
    async fn produce(&self, ctx: Ctx, input: EchoProduceInput) -> ToolResult<EchoProduceOutput> {
        let session = &ctx.session().id;
        let handle = self.0.get::<EchoClient>(session, TOOL, &input.conn_id)?;
        let codecs = self.0.codecs(session, &input.conn_id)?;
        let target = Target::Topic { name: TOPIC.into() };
        let key = match &input.key {
            Some(k) => Some(
                codecs
                    .encode(Some(&target), Part::Key, k)
                    .await
                    .map_err(|e| tool_error(TOOL, e))?
                    .bytes,
            ),
            None => None,
        };
        let value = codecs
            .encode(Some(&target), Part::Value, &input.value)
            .await
            .map_err(|e| tool_error(TOOL, e))?;
        let headers = input
            .headers
            .iter()
            .flatten()
            .map(|h| h.to_header().map_err(|e| tool_error(TOOL, e)))
            .collect::<Result<Vec<_>, _>>()?;
        let size = value.bytes.len() as u64;
        let (partition, offset) =
            handle
                .value
                .topic
                .append(input.partition, key, value.bytes, headers)?;
        Ok(EchoProduceOutput {
            partition,
            offset: offset.to_string(),
            size,
            schema_ref: value.schema_ref,
        })
    }

    /// Reads the test topic as Arrow message batches (spec §5.5): from a start, to the end or
    /// following, decoded and filtered on the server; pull-able, or push-only with `push`.
    #[rpc::stream(perm = "echo.read", risk = Risk::Read, timeout_max = "12h")]
    async fn tail(
        &self,
        ctx: Ctx,
        input: EchoTailInput,
        sink: BinarySink,
    ) -> ToolResult<TailSummary> {
        let session = ctx.session().id.clone();
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self.0.busy::<EchoClient>(&session, TOOL, &input.conn_id)?;
        let codecs = self.0.codecs(&session, &input.conn_id)?;
        let progress = self.0.progress(&session, claim.stream_id());
        let topic = Arc::clone(&handle.value.topic);
        let ends = topic.end_offsets();
        let feed = if input.push.unwrap_or(false) {
            let buffer = Arc::new(PushBuffer::default());
            topic.subscribe(&buffer);
            Feed::push(buffer)
        } else {
            let next: Vec<i64> = match &input.start {
                EchoStart::Earliest => vec![0; ends.len()],
                EchoStart::Latest => ends.clone(),
                EchoStart::LatestN { n } => {
                    ends.iter().map(|e| (e - i64::from(*n)).max(0)).collect()
                }
                EchoStart::Offsets { offsets } => {
                    let mut next = vec![0; ends.len()];
                    for o in offsets {
                        let p = usize::try_from(o.partition)
                            .ok()
                            .filter(|p| *p < ends.len())
                            .ok_or_else(|| {
                                ToolError::invalid(
                                    TOOL,
                                    "start",
                                    format!("partition {} does not exist", o.partition),
                                )
                            })?;
                        next[p] = offset_arg("start", &o.offset)?;
                    }
                    next
                }
            };
            Feed::pull(
                TopicReader::new(topic, next, input.follow),
                handle.token.clone(),
            )
        };
        let decode = input.decode.unwrap_or_default();
        let target = |_: &message_codecs::Message| Some(Target::Topic { name: TOPIC.into() });
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
        tail::run(sink, feed, req, &progress, &handle.token).await
    }

    /// One whole message (Load full payload).
    #[rpc::query(perm = "echo.read", risk = Risk::Read)]
    async fn get(&self, ctx: Ctx, input: EchoGetInput) -> ToolResult<FullMessage> {
        let handle = self
            .0
            .get::<EchoClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        let offset = offset_arg("offset", &input.offset)?;
        let m = handle
            .value
            .topic
            .get(input.partition, offset)
            .ok_or_else(|| {
                ToolError::not_found(
                    TOOL,
                    "message",
                    format!("no message at {}:{offset}", input.partition),
                )
            })?;
        let b64 = base64::engine::general_purpose::STANDARD;
        Ok(FullMessage {
            partition: input.partition,
            offset: offset.to_string(),
            key: m.key.as_ref().map(|k| b64.encode(k)),
            size: m.payload.len() as u64,
            payload: b64.encode(&m.payload),
        })
    }
}
