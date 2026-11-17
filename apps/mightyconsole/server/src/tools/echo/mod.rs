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

use crate::core::{Empty, Hub, TermInput, ToolError, ToolErrorKind, ToolResult};

/// The tool's id and namespace.
pub const TOOL: &str = "echo";

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
    #[rpc::mutation(perm = "echo.read", risk = Risk::Read, redact = ["profile.token"])]
    async fn connect(&self, ctx: Ctx, input: EchoConnectInput) -> ToolResult<EchoConnectOutput> {
        let profile = input.profile;
        if profile.token.as_deref() == Some("wrong") {
            return Err(ToolError::new(ToolErrorKind::Auth, TOOL, "the token was rejected").into());
        }
        let greeting = profile
            .greeting
            .filter(|g| !g.is_empty())
            .unwrap_or_else(|| format!("hello from {}", profile.name));
        let handle = self.0.insert(
            &ctx.session().id,
            TOOL,
            Arc::new(EchoClient {
                greeting: greeting.clone(),
            }),
        );
        Ok(EchoConnectOutput {
            conn_id: handle.conn_id,
            greeting,
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
        let mut terminal = self.0.open_terminal(&session, TOOL, &input.terminal_id)?;
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
