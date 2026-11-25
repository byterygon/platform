//! `docker.containers.exec` (Mightyconsole spec §10.4 "Terminal", §10.6): a process in a running
//! container on a TTY, as `docker exec -it` runs it. Its output is a `bytes` stream (spec §2.5:
//! the channel byte 1, then raw bytes, sent at 64 KiB or 16 ms); its input comes through
//! `term.write`, `term.resize` and `term.signal` on the terminal the call opened.
//!
//! The exec is created with `POST /containers/{id}/exec` and started with the connection
//! upgraded (`Upgrade: tcp`), so the SSH channel then carries the TTY both ways. A resize is
//! `POST /exec/{id}/resize`. When the process ends its exit code is read from
//! `GET /exec/{id}/json`. Closing the stream (Disconnect) closes the channel: the process loses
//! its TTY, as when `docker exec` is killed.

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx};
use hyper::Method;
use hyper_util::rt::TokioIo;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::Instant;
use ts_rs::TS;

use super::containers::container_ref;
use super::engine::{ApiVersion, Engine};
use super::stream::ended;
use super::{DockerClient, TOOL};
use crate::core::{Hub, TermInput, ToolError, ToolErrorKind, ToolResult};

/// The terminal's output channel byte (spec §2.5): a TTY merges stdout and stderr.
pub const STDOUT: u8 = 1;

/// The command when the call names none: bash when the image has it, else sh (spec §10.4).
pub const DEFAULT_CMD: [&str; 3] = [
    "/bin/sh",
    "-c",
    "command -v bash >/dev/null && exec bash || exec sh",
];

/// A chunk is sent at this size ...
const CHUNK_BYTES: usize = 64 * 1024;
/// ... or this long after its first byte (spec §2.5).
const COALESCE: Duration = Duration::from_millis(16);

/// The largest terminal accepted.
pub const MAX_SIZE: u16 = 1000;

/// `ConsoleSize` on create and start is understood from this API on (Docker 23).
const CONSOLE_SIZE_API: ApiVersion = ApiVersion(1, 42);

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersExecInput {
    pub conn_id: String,
    pub id: String,
    /// The command and its arguments; bash if the image has it, else sh, when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cmd: Option<Vec<String>>,
    /// `user`, `uid`, `user:group`; the container's user when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub user: Option<String>,
    /// The working directory; the container's when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub workdir: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub terminal_id: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersExecSummary {
    /// The process's exit code, when Docker reports one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i64>,
}

/// The command to run, checked: 1 to 64 arguments, none with a NUL, the first not empty.
pub fn command(cmd: Option<&[String]>) -> Result<Vec<String>, ToolError> {
    let Some(cmd) = cmd.filter(|c| !c.is_empty()) else {
        return Ok(DEFAULT_CMD.iter().map(|s| (*s).to_owned()).collect());
    };
    let bad = |why: &str| ToolError::invalid(TOOL, "cmd", why);
    if cmd.len() > 64 {
        return Err(bad("at most 64 arguments"));
    }
    if cmd[0].trim().is_empty() {
        return Err(bad("name the program to run"));
    }
    if cmd.iter().any(|a| a.contains('\0') || a.len() > 4096) {
        return Err(bad(
            "arguments are text without NUL, at most 4096 bytes each",
        ));
    }
    Ok(cmd.to_vec())
}

/// An optional text field without control characters, at most 256 bytes.
fn short_text(field: &str, value: Option<&str>) -> Result<Option<String>, ToolError> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) if v.len() <= 256 && !v.chars().any(char::is_control) => Ok(Some(v.to_owned())),
        Some(_) => Err(ToolError::invalid(
            TOOL,
            field,
            "at most 256 characters, no control characters",
        )),
    }
}

fn check_size(cols: u16, rows: u16) -> Result<(), ToolError> {
    for (field, n) in [("cols", cols), ("rows", rows)] {
        if n == 0 || n > MAX_SIZE {
            return Err(ToolError::invalid(TOOL, field, format!("1 to {MAX_SIZE}")));
        }
    }
    Ok(())
}

/// An exec id as Docker gives it: hexadecimal.
fn exec_id(created: &Value) -> Result<String, ToolError> {
    created
        .get("Id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_hexdigit()))
        .map(str::to_owned)
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                "Docker created the exec without an id",
            )
        })
}

async fn resize(engine: &Engine, exec: &str, cols: u16, rows: u16) -> Result<(), ToolError> {
    engine
        .act(
            Method::POST,
            &format!("/exec/{exec}/resize?h={rows}&w={cols}"),
            "exec",
            Duration::from_secs(10),
        )
        .await
}

/// The exit code, once Docker says the process ended (it may lag the end of the output a little).
async fn exit_code(engine: &Engine, exec: &str) -> Option<i64> {
    for _ in 0..20 {
        let info: Value = engine
            .get(&format!("/exec/{exec}/json"), "exec")
            .await
            .ok()?;
        if info.get("Running").and_then(Value::as_bool) != Some(true) {
            return info.get("ExitCode").and_then(Value::as_i64);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

/// `docker.containers.exec`: see the module docs.
pub async fn run(
    hub: &Arc<Hub>,
    ctx: &Ctx,
    input: ContainersExecInput,
    sink: &BinarySink,
) -> ToolResult<ContainersExecSummary> {
    let session = ctx.session().id.clone();
    let id = container_ref("id", &input.id)?.to_owned();
    let cmd = command(input.cmd.as_deref())?;
    let user = short_text("user", input.user.as_deref())?;
    let workdir = short_text("workdir", input.workdir.as_deref())?;
    check_size(input.cols, input.rows)?;
    let (handle, _busy) = hub.busy::<DockerClient>(&session, TOOL, &input.conn_id)?;
    let mut terminal = hub.open_terminal(&session, TOOL, &input.conn_id, &input.terminal_id)?;
    let engine = &handle.value.engine;

    let console = engine.api >= CONSOLE_SIZE_API;
    let size = json!([input.rows, input.cols]);
    let started = async {
        let mut create = json!({
            "AttachStdin": true, "AttachStdout": true, "AttachStderr": true, "Tty": true,
            "Cmd": cmd, "Env": ["TERM=xterm-256color"],
        });
        if let Some(user) = &user {
            create["User"] = json!(user);
        }
        if let Some(workdir) = &workdir {
            create["WorkingDir"] = json!(workdir);
        }
        let mut start = json!({ "Detach": false, "Tty": true });
        if console {
            create["ConsoleSize"] = size.clone();
            start["ConsoleSize"] = size.clone();
        }
        let created: Value = engine
            .call(
                Method::POST,
                &format!("/containers/{id}/exec"),
                Some(&create),
                "container",
            )
            .await?;
        let exec = exec_id(&created)?;
        let io = engine
            .upgrade(&format!("/exec/{exec}/start"), &start, "exec")
            .await?;
        // Older engines take the size only this way; newer ones already have it.
        let _ = resize(engine, &exec, input.cols, input.rows).await;
        Ok::<_, ToolError>((exec, io))
    };
    let (exec, io) = match started.await {
        Ok(started) => started,
        Err(e) => {
            terminal.exit(None, e.message.clone());
            return Err(e.into());
        }
    };
    let (mut reader, mut writer) = tokio::io::split(TokioIo::new(io));
    let mut buf = vec![0u8; CHUNK_BYTES];
    loop {
        tokio::select! {
            biased;
            () = handle.token.cancelled() => {
                terminal.exit(None, "the connection was closed");
                return Err(ended());
            }
            () = ctx.cancelled() => {
                terminal.exit(None, "disconnected");
                return Err(ended());
            }
            next = terminal.input.recv() => {
                let written = match next {
                    None => {
                        terminal.exit(None, "the page closed its connection to the server");
                        return Err(ended());
                    }
                    Some(TermInput::Data(bytes)) => writer.write_all(&bytes).await,
                    Some(TermInput::Interrupt) => writer.write_all(&[0x03]).await,
                    Some(TermInput::Eof) => writer.write_all(&[0x04]).await,
                    Some(TermInput::Resize { cols, rows }) => {
                        if check_size(cols, rows).is_ok() {
                            let _ = resize(engine, &exec, cols, rows).await;
                        }
                        Ok(())
                    }
                };
                // The process ended while input was on its way: its output says the rest.
                if written.is_err() {
                    continue;
                }
                let _ = writer.flush().await;
            }
            read = reader.read(&mut buf) => {
                let n = match read {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut chunk = Vec::with_capacity(n + 1);
                chunk.push(STDOUT);
                chunk.extend_from_slice(&buf[..n]);
                let deadline = Instant::now() + COALESCE;
                let mut ended_too = false;
                while chunk.len() < CHUNK_BYTES {
                    let room = (CHUNK_BYTES - chunk.len()).min(buf.len());
                    match tokio::time::timeout_at(deadline, reader.read(&mut buf[..room])).await {
                        Err(_) => break,
                        Ok(Ok(0) | Err(_)) => {
                            ended_too = true;
                            break;
                        }
                        Ok(Ok(n)) => chunk.extend_from_slice(&buf[..n]),
                    }
                }
                sink.send(chunk).await?;
                if ended_too {
                    break;
                }
            }
        }
    }
    let code = exit_code(engine, &exec).await;
    let reason = match code {
        Some(code) => format!("exited with code {code}"),
        None => "ended".to_owned(),
    };
    terminal.exit(code.and_then(|c| i32::try_from(c).ok()), reason);
    Ok(ContainersExecSummary { exit_code: code })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_users_and_sizes_are_checked() {
        assert_eq!(command(None).unwrap()[0], "/bin/sh");
        assert_eq!(command(Some(&[])).unwrap().len(), 3);
        assert_eq!(
            command(Some(&["ls".into(), "-la".into()])).unwrap(),
            ["ls", "-la"]
        );
        for bad in [
            vec![" ".to_owned()],
            vec!["sh".into(), "a\0b".into()],
            vec!["x".to_owned(); 65],
        ] {
            assert_eq!(
                command(Some(&bad)).unwrap_err().field.as_deref(),
                Some("cmd")
            );
        }
        assert_eq!(
            short_text("user", Some(" app ")).unwrap().as_deref(),
            Some("app")
        );
        assert_eq!(short_text("user", Some("")).unwrap(), None);
        assert!(short_text("workdir", Some("/a\nb")).is_err());
        assert!(check_size(80, 24).is_ok());
        assert_eq!(
            check_size(0, 24).unwrap_err().field.as_deref(),
            Some("cols")
        );
        assert_eq!(
            check_size(80, 1001).unwrap_err().field.as_deref(),
            Some("rows")
        );
        assert_eq!(exec_id(&json!({ "Id": "ab12" })).unwrap(), "ab12");
        assert!(exec_id(&json!({ "Id": "../x" })).is_err());
    }
}
