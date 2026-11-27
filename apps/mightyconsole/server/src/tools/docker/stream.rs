//! Forwarding a Docker body that streams (logs, events) as `jsonl` chunks (Mightyconsole spec
//! §2.5): whole lines only, a chunk sent at 256 KiB or 50 ms after its first line, one credit
//! per chunk. The body is read only while the client holds a credit, so a paused view stops
//! the reading. Over SSH the host is not held back by the channel's window (russh grants it on
//! arrival): the channel's stream holds what arrives, and a view paused while more than
//! [`net_route::CHANNEL_BACKLOG`] arrived loses its stream, not the session (TSK-166).

use std::time::Duration;

use ambidex::{BinarySink, Code, Ctx, RpcError};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use super::TOOL;
use crate::core::{Progress, ToolError, ToolErrorKind, ToolResult};

/// A `jsonl` chunk is sent when it reaches this size (spec §2.5).
pub const CHUNK_BYTES: usize = 256 * 1024;

/// ... or when its first line is this old.
pub const COALESCE: Duration = Duration::from_millis(50);

/// Turns the bytes of a body into JSON Lines.
pub trait Lines {
    /// Appends the lines that `data` completes to `chunk`; returns how many.
    fn feed(&mut self, data: &[u8], chunk: &mut Vec<u8>) -> u64;
    /// The body ended: appends what is left as lines; returns how many.
    fn finish(&mut self, chunk: &mut Vec<u8>) -> u64;
}

/// The stream ended because the handle was released or the call was cancelled.
pub fn ended() -> RpcError<ToolError> {
    RpcError::new(Code::Cancelled, "the connection was closed")
}

pub fn read_error(e: hyper::Error) -> ToolError {
    ToolError::new(
        ToolErrorKind::Remote,
        TOOL,
        format!("reading Docker's stream failed: {e}"),
    )
}

/// What one read of the body gave.
enum Read {
    Data(u64),
    End,
}

async fn read(
    body: &mut Incoming,
    lines: &mut impl Lines,
    chunk: &mut Vec<u8>,
) -> Result<Read, ToolError> {
    match body.frame().await {
        None => Ok(Read::End),
        Some(Err(e)) => Err(read_error(e)),
        Some(Ok(frame)) => Ok(Read::Data(
            frame.into_data().map_or(0, |data| lines.feed(&data, chunk)),
        )),
    }
}

/// Forwards `body` through `lines` to `sink` until the body ends (returns the lines sent), the
/// handle's `released` fires or the call is cancelled.
pub async fn pump(
    ctx: &Ctx,
    released: &CancellationToken,
    sink: &BinarySink,
    mut body: Incoming,
    lines: &mut impl Lines,
    progress: &Progress,
) -> ToolResult<u64> {
    let mut sent = 0u64;
    loop {
        tokio::select! {
            biased;
            () = released.cancelled() => return Err(ended()),
            () = ctx.cancelled() => return Err(ended()),
            ready = sink.ready() => ready?,
        }
        let mut chunk = Vec::new();
        let mut count = 0u64;
        let mut done = false;
        // Wait as long as it takes for the first complete line.
        while count == 0 && !done {
            let next = tokio::select! {
                biased;
                () = released.cancelled() => return Err(ended()),
                () = ctx.cancelled() => return Err(ended()),
                next = read(&mut body, lines, &mut chunk) => next?,
            };
            match next {
                Read::Data(n) => count += n,
                Read::End => {
                    count += lines.finish(&mut chunk);
                    done = true;
                }
            }
        }
        // Then add what arrives within the coalescing window.
        let deadline = Instant::now() + COALESCE;
        while !done && chunk.len() < CHUNK_BYTES {
            match tokio::time::timeout_at(deadline, read(&mut body, lines, &mut chunk)).await {
                Err(_) => break,
                Ok(next) => match next? {
                    Read::Data(n) => count += n,
                    Read::End => {
                        count += lines.finish(&mut chunk);
                        done = true;
                    }
                },
            }
        }
        if count > 0 {
            progress.scanned(count);
            progress.matched(count, chunk.len() as u64);
            sink.send(chunk).await?;
            sent += count;
        }
        if done {
            return Ok(sent);
        }
    }
}

/// Splits bytes into lines (`\n`, a trailing `\r` dropped); a line longer than `max` is cut
/// into pieces of `max` bytes so one endless line cannot hold memory.
#[derive(Debug, Default)]
pub struct LineSplitter {
    partial: Vec<u8>,
}

impl LineSplitter {
    /// Calls `line` with every line that `data` completes.
    pub fn push(&mut self, data: &[u8], max: usize, mut line: impl FnMut(&[u8])) {
        let mut rest = data;
        while !rest.is_empty() {
            match rest.iter().position(|&b| b == b'\n') {
                Some(at) => {
                    self.partial.extend_from_slice(&rest[..at]);
                    rest = &rest[at + 1..];
                    if self.partial.last() == Some(&b'\r') {
                        self.partial.pop();
                    }
                    self.emit_long(max, &mut line);
                    line(&self.partial);
                    self.partial.clear();
                }
                None => {
                    self.partial.extend_from_slice(rest);
                    rest = &[];
                    self.emit_long(max, &mut line);
                }
            }
        }
    }

    /// Emits whole `max`-byte pieces of the partial line.
    fn emit_long(&mut self, max: usize, line: &mut impl FnMut(&[u8])) {
        while self.partial.len() > max {
            let tail = self.partial.split_off(max);
            line(&self.partial);
            self.partial = tail;
        }
    }

    /// The text after the last newline, as a last line (none when empty).
    pub fn finish(&mut self, mut line: impl FnMut(&[u8])) {
        if !self.partial.is_empty() {
            line(&self.partial);
            self.partial.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(parts: &[&[u8]], max: usize) -> Vec<String> {
        let mut splitter = LineSplitter::default();
        let mut out = Vec::new();
        for part in parts {
            splitter.push(part, max, |l| {
                out.push(String::from_utf8_lossy(l).into_owned())
            });
        }
        splitter.finish(|l| out.push(String::from_utf8_lossy(l).into_owned()));
        out
    }

    #[test]
    fn lines_join_across_reads_and_long_ones_are_cut() {
        assert_eq!(
            split(&[b"one\r\ntw", b"o\n", b"\nthree"], 100),
            ["one", "two", "", "three"]
        );
        assert_eq!(
            split(&[b"abcdefg", b"h\nij"], 3),
            ["abc", "def", "gh", "ij"]
        );
        assert!(split(&[b""], 10).is_empty());
    }
}
