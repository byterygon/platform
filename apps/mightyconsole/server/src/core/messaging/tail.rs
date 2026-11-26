//! Live tail and browse (Mightyconsole spec §2.5, §5.5): one stream of `arrow` chunks for any
//! message source, with the filter applied on the server.
//!
//! **Feeds.** A *pull* source ([`PullSource`]: Kafka fetch, a JetStream ordered consumer, a KV
//! watch) runs in its own task and hands batches over a channel of one, so it reads ahead by
//! at most one batch: when the client stops granting credits the tail stops taking batches and
//! the source stops reading upstream. A *push* source (core NATS subscribe) writes into a
//! [`PushBuffer`] that keeps the newest 10,000 messages or 64 MiB, drops the oldest beyond that
//! and counts them.
//!
//! **Chunks.** Matching messages are coalesced into Arrow batches of 500 rows, 1 MiB or 100 ms,
//! whichever comes first (spec §2.5). Each chunk waits for a credit: that wait is the pause.
//!
//! **Filter.** Every part of the filter but jq is evaluated here. A jq program runs in the
//! stream's own worker process ([`super::jq_filter`], spec §5.4, TSK-143): each feed batch is
//! decoded, the messages the other parts let through are sent to the worker at once, and its
//! answers are read back in order as the batch is processed, so a program that never ends,
//! overflows its stack or runs out of memory costs one message (a decode error), not the server.
//!
//! **End.** The stream ends with a [`TailSummary`] when the source ends, `limit` messages
//! matched, or `maxScan` messages were read; `lastPositions` lets Restart continue from there.

use std::collections::{BTreeMap, VecDeque};
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::arrow::ArrowSink;
use ambidex::{BinarySink, RpcError};
use message_codecs::filter::{CompiledFilter, Filter, FilterInput, jq_input_line};
use message_codecs::{Codecs, DecodeOptions, Message, Target};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, mpsc};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::arrow::{BatchBuilder, MESSAGE_SCHEMA, Row};
use super::decode_row;
use super::jq_filter::{Answer, JqFilter};
use crate::core::{Progress, ToolError};

/// Rows per chunk, at most (spec §2.5).
pub const BATCH_ROWS: usize = 500;
/// Bytes per chunk, roughly, at most.
pub const BATCH_BYTES: usize = 1 << 20;
/// Longest a matching message waits for its chunk.
pub const BATCH_INTERVAL: Duration = Duration::from_millis(100);
/// Messages read before a filtered scan stops (spec §5.4).
pub const DEFAULT_MAX_SCAN: u64 = 100_000;
/// A push buffer's limits (spec §2.5, decision 13).
pub const PUSH_MAX_MESSAGES: usize = 10_000;
pub const PUSH_MAX_BYTES: usize = 64 << 20;

/// Why a stream ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum EndReason {
    /// The source has no more messages (a browse reached its end).
    End,
    /// `limit` messages matched.
    Limit,
    /// `maxScan` messages were read.
    MaxScan,
    Cancelled,
}

/// Where a stream stopped, per source and partition: the last message read, so a restart
/// continues at the next one (offset + 1, sequence + 1). Decimal strings keep 64 bits exact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LastPosition {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub partition: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub offset: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sequence: Option<String>,
    /// Microseconds since the epoch, of the last message read.
    pub timestamp_us: i64,
}

/// The summary of a message stream (spec §5.5, `TailSummary`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TailSummary {
    pub scanned: u64,
    pub matched: u64,
    pub dropped: u64,
    pub decode_errors: u64,
    pub end_reason: EndReason,
    pub last_positions: Vec<LastPosition>,
    /// Why the filter's jq last failed on a message (its error, or the limit that stopped it);
    /// such a message counts in `decodeErrors`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub filter_error: Option<String>,
}

/// A source that can wait: it reads the next messages when asked. `Ok(None)` is the end.
pub trait PullSource: Send + 'static {
    fn next(&mut self) -> impl Future<Output = Result<Option<Vec<Message>>, ToolError>> + Send;
}

/// What a stream reads from.
pub enum Feed {
    Pull(mpsc::Receiver<Result<Vec<Message>, ToolError>>),
    Push(Arc<PushBuffer>),
}

impl Feed {
    /// Runs a pull source in its own task, one batch ahead at most; `token` stops it.
    pub fn pull<S: PullSource>(mut source: S, token: CancellationToken) -> Feed {
        let (tx, rx) = mpsc::channel(1);
        tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    biased;
                    () = token.cancelled() => return,
                    () = tx.closed() => return,
                    next = source.next() => next,
                };
                let end = !matches!(next, Ok(Some(_)));
                let item = match next {
                    Ok(Some(batch)) => Ok(batch),
                    Ok(None) => return,
                    Err(e) => Err(e),
                };
                if tx.send(item).await.is_err() || end {
                    return;
                }
            }
        });
        Feed::Pull(rx)
    }

    pub fn push(buffer: Arc<PushBuffer>) -> Feed {
        Feed::Push(buffer)
    }

    /// The next messages, `None` at the end; the count of messages a push source dropped since
    /// the last call. Cancel-safe.
    async fn recv(&mut self) -> (Option<Result<Vec<Message>, ToolError>>, u64) {
        match self {
            Feed::Pull(rx) => (rx.recv().await, 0),
            Feed::Push(buffer) => buffer.recv(BATCH_ROWS).await,
        }
    }
}

#[derive(Default)]
struct PushState {
    queue: VecDeque<Message>,
    bytes: usize,
    dropped: u64,
    closed: bool,
    error: Option<ToolError>,
}

/// The ring buffer of a push-only source (spec §2.5): newest kept, oldest dropped and counted.
pub struct PushBuffer {
    max_messages: usize,
    max_bytes: usize,
    state: Mutex<PushState>,
    notify: Notify,
}

impl Default for PushBuffer {
    fn default() -> Self {
        Self::new(PUSH_MAX_MESSAGES, PUSH_MAX_BYTES)
    }
}

fn message_bytes(m: &Message) -> usize {
    m.payload.len() + m.key.as_ref().map_or(0, Vec::len) + m.source.len() + 64
}

impl PushBuffer {
    pub fn new(max_messages: usize, max_bytes: usize) -> Self {
        Self {
            max_messages: max_messages.max(1),
            max_bytes,
            state: Mutex::default(),
            notify: Notify::new(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, PushState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Adds a message; drops the oldest ones over the limits.
    pub fn push(&self, m: Message) {
        let mut st = self.lock();
        if st.closed {
            return;
        }
        st.bytes += message_bytes(&m);
        st.queue.push_back(m);
        while st.queue.len() > self.max_messages
            || (st.bytes > self.max_bytes && st.queue.len() > 1)
        {
            if let Some(old) = st.queue.pop_front() {
                st.bytes -= message_bytes(&old);
                st.dropped += 1;
            }
        }
        drop(st);
        self.notify.notify_one();
    }

    /// Ends the source; what is buffered is still read, then the stream ends (with the error,
    /// if any).
    pub fn close(&self, error: Option<ToolError>) {
        let mut st = self.lock();
        st.closed = true;
        st.error = error;
        drop(st);
        self.notify.notify_one();
    }

    /// Messages waiting.
    pub fn len(&self) -> usize {
        self.lock().queue.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    async fn recv(&self, max: usize) -> (Option<Result<Vec<Message>, ToolError>>, u64) {
        loop {
            let notified = self.notify.notified();
            {
                let mut st = self.lock();
                let dropped = std::mem::take(&mut st.dropped);
                if !st.queue.is_empty() {
                    let n = st.queue.len().min(max);
                    let batch: Vec<Message> = st.queue.drain(..n).collect();
                    st.bytes -= batch.iter().map(message_bytes).sum::<usize>();
                    return (Some(Ok(batch)), dropped);
                }
                if st.closed {
                    return (st.error.take().map(Err), dropped);
                }
                st.dropped += dropped;
            }
            notified.await;
        }
    }
}

/// What a message stream asks for.
pub struct TailRequest<'a> {
    pub codecs: &'a Codecs,
    pub decode: &'a DecodeOptions,
    pub filter: Option<&'a Filter>,
    /// 0 for no limit; [`DEFAULT_MAX_SCAN`] when a filter is set and this is `None`.
    pub max_scan: Option<u64>,
    /// Stop after this many matches.
    pub limit: Option<u64>,
    /// The filter's jq time budget per message ([`super::jq_filter::budget`]).
    pub jq_budget: Duration,
    /// The mapping target of a message (its topic, subject or bucket).
    pub target: &'a (dyn Fn(&Message) -> Option<Target> + Send + Sync),
    /// The tool, for errors.
    pub system: &'a str,
}

/// Compiles a filter, or the `Invalid` error listing its issues.
pub fn compile_filter(
    system: &str,
    filter: Option<&Filter>,
) -> Result<Option<CompiledFilter>, ToolError> {
    match filter.filter(|f| !f.is_empty()) {
        None => Ok(None),
        Some(f) => CompiledFilter::compile(f).map(Some).map_err(|issues| {
            let text = issues
                .iter()
                .map(|i| format!("{}: {}", i.part, i.message))
                .collect::<Vec<_>>()
                .join("; ");
            ToolError::invalid(system, "filter", text)
        }),
    }
}

fn sink_error(e: ambidex::arrow::ArrowSinkError) -> RpcError<ToolError> {
    RpcError::new(e.code(), e.to_string())
}

struct Counters {
    scanned: u64,
    matched: u64,
    dropped: u64,
    decode_errors: u64,
}

/// Runs a message stream to its end. A released handle (`cancel`) ends it with `Cancelled`,
/// whatever it waits for then: the source, the jq worker or, paused, the client's next credit.
pub async fn run(
    sink: BinarySink,
    feed: Feed,
    req: TailRequest<'_>,
    progress: &Progress,
    cancel: &CancellationToken,
) -> Result<TailSummary, RpcError<ToolError>> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err(RpcError::new(ambidex::Code::Cancelled, "the connection was closed")),
        summary = stream(sink, feed, req, progress) => summary,
    }
}

async fn stream(
    sink: BinarySink,
    mut feed: Feed,
    req: TailRequest<'_>,
    progress: &Progress,
) -> Result<TailSummary, RpcError<ToolError>> {
    let filter = compile_filter(req.system, req.filter)?;
    let mut jq = match filter.as_ref().and_then(CompiledFilter::jq_code) {
        Some(code) => Some(JqFilter::start(req.system, code, req.jq_budget)?),
        None => None,
    };
    let mut filter_error = None;
    let max_scan = match req.max_scan {
        Some(0) => None,
        Some(n) => Some(n),
        None if filter.is_some() => Some(DEFAULT_MAX_SCAN),
        None => None,
    };
    let mut out = ArrowSink::new(sink);
    out.start(&MESSAGE_SCHEMA).await.map_err(sink_error)?;
    let mut builder = BatchBuilder::new();
    let mut deadline: Option<Instant> = None;
    let mut positions: BTreeMap<(String, Option<i32>), LastPosition> = BTreeMap::new();
    let mut c = Counters {
        scanned: 0,
        matched: 0,
        dropped: 0,
        decode_errors: 0,
    };
    let mut row_id = 0u64;

    let end_reason = 'outer: loop {
        let next = tokio::select! {
            biased;
            () = sleep_until(deadline), if deadline.is_some() => {
                flush(&mut out, &mut builder, progress).await?;
                deadline = None;
                continue;
            }
            next = feed.recv() => next,
        };
        let (batch, dropped) = next;
        if dropped > 0 {
            c.dropped += dropped;
            progress.dropped(dropped);
        }
        let messages = match batch {
            None => break EndReason::End,
            Some(Err(e)) => {
                flush(&mut out, &mut builder, progress).await?;
                return Err(e.into());
            }
            Some(Ok(m)) => m,
        };
        // Messages past `maxScan` are never read.
        let room = max_scan.map_or(usize::MAX, |m| {
            usize::try_from(m.saturating_sub(c.scanned)).unwrap_or(usize::MAX)
        });
        let mut rows = Vec::with_capacity(messages.len().min(room));
        for message in messages.into_iter().take(room) {
            let target = (req.target)(&message);
            rows.push(decode_row(req.codecs, message, req.decode, target.as_ref(), row_id).await);
            row_id += 1;
        }
        // The parts without jq decide here; the rest go to the worker together, and its answers
        // are read in order below.
        let pass: Vec<Pass> = rows
            .iter()
            .map(|row| match &filter {
                None => Pass::Match,
                Some(f) if !f.evaluate_without_jq(&filter_input(row)) => Pass::NoMatch,
                Some(_) if jq.is_some() => Pass::Jq,
                Some(_) => Pass::Match,
            })
            .collect();
        if let Some(jq) = &mut jq {
            jq.send(
                rows.iter()
                    .zip(&pass)
                    .filter(|(_, p)| **p == Pass::Jq)
                    .map(|(row, _)| jq_input_line(&filter_input(row)))
                    .collect(),
            );
        }
        for (row, pass) in rows.into_iter().zip(pass) {
            c.scanned += 1;
            progress.scanned(1);
            let m = &row.message;
            let key = (m.source.clone(), m.partition);
            positions.insert(
                key.clone(),
                LastPosition {
                    source: key.0,
                    partition: key.1,
                    offset: m.offset.map(|o| o.to_string()),
                    sequence: m.sequence.map(|s| s.to_string()),
                    timestamp_us: m.timestamp_us,
                },
            );
            if row.value.error.is_some() || row.key.as_ref().is_some_and(|k| k.error.is_some()) {
                c.decode_errors += 1;
                progress.decode_error();
            }
            let matched = match pass {
                Pass::NoMatch => false,
                Pass::Match => true,
                Pass::Jq => {
                    let jq = jq.as_mut().expect("a jq worker");
                    match jq.next().await {
                        Ok(Answer::Match) => true,
                        Ok(Answer::NoMatch) => false,
                        Ok(Answer::Failed(reason)) => {
                            c.decode_errors += 1;
                            progress.decode_error();
                            filter_error = Some(reason);
                            false
                        }
                        Err(e) => {
                            flush(&mut out, &mut builder, progress).await?;
                            return Err(e.into());
                        }
                    }
                }
            };
            if matched {
                c.matched += 1;
                builder.push(&row);
                progress.matched(1, row.weight() as u64);
                deadline.get_or_insert_with(|| Instant::now() + BATCH_INTERVAL);
                if builder.rows() >= BATCH_ROWS || builder.bytes() >= BATCH_BYTES {
                    flush(&mut out, &mut builder, progress).await?;
                    deadline = None;
                }
                if req.limit.is_some_and(|l| c.matched >= l) {
                    break 'outer EndReason::Limit;
                }
            }
            if max_scan.is_some_and(|m| c.scanned >= m) {
                break 'outer EndReason::MaxScan;
            }
        }
    };
    flush(&mut out, &mut builder, progress).await?;
    out.finish().await.map_err(sink_error)?;
    Ok(TailSummary {
        scanned: c.scanned,
        matched: c.matched,
        dropped: c.dropped,
        decode_errors: c.decode_errors,
        end_reason,
        last_positions: positions.into_values().collect(),
        filter_error,
    })
}

/// What the filter's parts without jq decided for a message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pass {
    NoMatch,
    Match,
    /// The other parts match; the jq worker decides.
    Jq,
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

async fn flush(
    out: &mut ArrowSink,
    builder: &mut BatchBuilder,
    _progress: &Progress,
) -> Result<(), RpcError<ToolError>> {
    if builder.is_empty() {
        return Ok(());
    }
    let batch = builder.finish();
    out.send(&batch).await.map_err(sink_error)
}

/// What the filter reads of a decoded row.
pub fn filter_input(row: &Row) -> FilterInput<'_> {
    let m = &row.message;
    FilterInput {
        source: &m.source,
        subject: m.subject.as_deref(),
        partition: m.partition,
        offset: m.offset,
        sequence: m.sequence,
        timestamp_us: m.timestamp_us,
        headers: m.headers.as_deref(),
        key: row.key.as_ref().and_then(|k| k.text.as_deref()),
        text: row.value.text.as_deref(),
        value: &row.filter_value,
    }
}
