//! The filter's jq in a worker per stream (Mightyconsole spec §5.4, TSK-143).
//!
//! A stream whose filter has a jq program starts one long-lived worker, the server itself as
//! `jq-worker filter` (as the queries of §5.4.1), with an empty environment, `/` as its directory
//! and, on Linux, its memory capped. The stream sends it each feed batch's messages as JSON lines
//! ([`message_codecs::filter::jq_input_line`]) and reads one answer per message, in order:
//! match, no match, or the program's error. A program can no longer stall or end the server:
//!
//! - **Time.** Each answer must come within the per-message budget ([`budget`], the setting
//!   "Time limit of the filter's jq on one message", 1 s by default) of the moment the stream
//!   started waiting for it. When it does not, the worker is killed; the message it was running
//!   counts as a decode error with the reason, a new worker starts and evaluates the messages after
//!   it, in order, so nothing is dropped or reordered.
//! - **Stack and memory.** A stack overflow or the memory cap ends only the worker, with the same
//!   handling.
//! - **Three in a row.** After [`MAX_FAILURES_IN_ROW`] such failures with no answer between them
//!   the stream ends with an `Invalid` error on `filter` that says why.
//! - **Lifetime.** The worker dies with its stream: dropping the [`JqFilter`] (the stream ended,
//!   was cancelled or stopped, or its handle was released) kills it and reaps it. Once a stream
//!   has used one, one spare worker waits for the next stream's program, so a stream or a restart
//!   does not wait for a process to start; it holds no program and no message. Every worker ends
//!   itself when the server is gone.
//! - **At once.** Streams with a jq filter have slots of their own ([`MAX_STREAMS`]), apart from
//!   the queries' two, so a tail never waits behind a query; one stream more is refused as busy.

use std::collections::{HashSet, VecDeque};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use message_codecs::filter::FilterIssue;
use message_codecs::jq::wire;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::core::jq::{
    Ended, FILTER_ARG, MAX_MEMORY_BYTES, WORKER_ARG, human, why_ended, worker_failed,
    worker_program,
};
use crate::core::{ToolError, ToolErrorKind};

/// The per-message budget when the call names none.
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(1);
/// The range the server clamps a requested budget to (the setting's range).
pub const MIN_BUDGET: Duration = Duration::from_millis(500);
pub const MAX_BUDGET: Duration = Duration::from_secs(30);
/// Worker failures (time, stack, memory) in a row that end the stream.
pub const MAX_FAILURES_IN_ROW: u32 = 3;
/// Streams with a jq filter at a time on the server.
pub const MAX_STREAMS: usize = 16;
/// How long a new worker may take to start and compile the program.
const STARTUP: Duration = Duration::from_secs(10);

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(MAX_STREAMS)));

/// The process ids of the filter workers started and not yet reaped (tests check that a stream's
/// worker dies with it).
static LIVE: LazyLock<Mutex<HashSet<u32>>> = LazyLock::new(Mutex::default);

/// The process ids of the filter workers that run now (started and not yet reaped).
pub fn live_workers() -> Vec<u32> {
    let mut pids: Vec<u32> = lock_live().iter().copied().collect();
    pids.sort_unstable();
    pids
}

fn lock_live() -> std::sync::MutexGuard<'static, HashSet<u32>> {
    LIVE.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The budget a call asked for, clamped to the setting's range.
pub fn budget(ms: Option<u64>) -> Duration {
    ms.map_or(DEFAULT_BUDGET, |ms| {
        Duration::from_millis(ms).clamp(MIN_BUDGET, MAX_BUDGET)
    })
}

/// The worker's answer for one message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    Match,
    NoMatch,
    /// The program failed on the message, or was stopped on it; the reason, in words. The
    /// message counts as a decode error.
    Failed(String),
}

/// A stream's jq filter: its worker and the messages sent to it and not answered yet.
pub struct JqFilter {
    system: String,
    code: String,
    budget: Duration,
    worker: Option<Worker>,
    /// Lines sent (or to send to the next worker) and not answered, oldest first; each ends with
    /// a newline.
    pending: VecDeque<Arc<[u8]>>,
    failures_in_row: u32,
    _slot: OwnedSemaphorePermit,
}

impl JqFilter {
    /// Takes a slot and starts the worker for `code` (already compiled once by the stream, so it
    /// is known to compile). `Conflict` (retryable) when every slot is taken.
    pub fn start(system: &str, code: &str, budget: Duration) -> Result<Self, ToolError> {
        let slot = Arc::clone(&SLOTS).try_acquire_owned().map_err(|_| {
            ToolError::new(
                ToolErrorKind::Conflict,
                system,
                format!(
                    "{MAX_STREAMS} live views with a jq filter are open on the server; stop one, \
                     or filter without jq"
                ),
            )
            .retryable(true)
        })?;
        let mut filter = Self {
            system: system.to_owned(),
            code: code.to_owned(),
            budget,
            worker: None,
            pending: VecDeque::new(),
            failures_in_row: 0,
            _slot: slot,
        };
        filter.worker = Some(filter.spawn()?);
        Ok(filter)
    }

    /// Queues messages (the lines of [`message_codecs::filter::jq_input_line`], without their
    /// newline); their answers come from [`Self::next`], in order.
    pub fn send(&mut self, lines: Vec<Vec<u8>>) {
        if lines.is_empty() {
            return;
        }
        let mut batch = Vec::with_capacity(lines.iter().map(|l| l.len() + 1).sum());
        for mut line in lines {
            line.push(b'\n');
            batch.extend_from_slice(&line);
            self.pending.push_back(line.into());
        }
        if let Some(w) = &self.worker {
            // A worker that died is noticed when its answer is read.
            let _ = w.input.send(batch);
        }
    }

    /// Messages queued and not answered.
    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// The answer for the oldest message queued and not answered. Restarts the worker when it was
    /// stopped or died; `Err` ends the stream ([`MAX_FAILURES_IN_ROW`] failures in a row, or a
    /// worker that cannot start). Cancel-safe: dropping the future loses no answer.
    pub async fn next(&mut self) -> Result<Answer, ToolError> {
        assert!(!self.pending.is_empty(), "next() without a message queued");
        if self.worker.is_none() {
            self.worker = Some(self.spawn()?);
        }
        let w = self.worker.as_mut().expect("a worker");
        if !w.ready {
            match w.read_line(Instant::now() + STARTUP).await {
                Read::Line(l) if l == wire::READY => w.ready = true,
                Read::Line(l) => {
                    let why = if let Some(issues) = l.strip_prefix(wire::ISSUES) {
                        let issues: Vec<FilterIssue> =
                            serde_json::from_str(issues).unwrap_or_default();
                        issues
                            .first()
                            .map_or_else(|| "jq failed".to_owned(), |i| i.message.clone())
                    } else {
                        format!("it answered {l:?} when it started")
                    };
                    return Err(worker_failed(&self.system, &why));
                }
                Read::Timeout => {
                    return Err(worker_failed(
                        &self.system,
                        &format!("it did not start within {}", human(STARTUP)),
                    ));
                }
                Read::Ended => {
                    let why = w.ended_words().await;
                    return Err(worker_failed(
                        &self.system,
                        &format!("it ended as it started: {why}"),
                    ));
                }
            }
        }
        let reason = match w.read_line(Instant::now() + self.budget).await {
            Read::Line(l) => {
                let answer = if l == wire::MATCH {
                    Some(Answer::Match)
                } else if l == wire::NO_MATCH {
                    Some(Answer::NoMatch)
                } else {
                    l.strip_prefix(wire::FAILED).map(|m| {
                        Answer::Failed(
                            serde_json::from_str::<String>(m).unwrap_or_else(|_| m.to_owned()),
                        )
                    })
                };
                match answer {
                    Some(answer) => {
                        self.pending.pop_front();
                        self.failures_in_row = 0;
                        return Ok(answer);
                    }
                    None => "the jq worker wrote something the server cannot read".to_owned(),
                }
            }
            Read::Timeout => format!(
                "the filter's jq ran for more than {} on this message and was stopped (the \
                 time limit is in Settings)",
                human(self.budget)
            ),
            Read::Ended => w.ended_words().await,
        };
        // This message stopped the worker: it counts as failed, and the next worker starts
        // from the message after it.
        self.worker = None;
        self.pending.pop_front();
        self.failures_in_row += 1;
        if self.failures_in_row >= MAX_FAILURES_IN_ROW {
            return Err(ToolError::invalid(
                &self.system,
                "filter",
                format!(
                    "the filter's jq was stopped on {MAX_FAILURES_IN_ROW} messages in a row, \
                     so the stream was stopped; the last time: {reason}"
                ),
            ));
        }
        Ok(Answer::Failed(reason))
    }

    /// Starts a worker (the spare one when there is one): the program first, then every
    /// message not answered yet.
    fn spawn(&self) -> Result<Worker, ToolError> {
        let mut child = take_process()
            .map_err(|e| worker_failed(&self.system, &format!("cannot start it: {e}")))?;
        let adopt = |child: &mut std::process::Child| -> std::io::Result<_> {
            Ok((
                ChildStdin::from_std(child.stdin.take().expect("piped stdin"))?,
                ChildStdout::from_std(child.stdout.take().expect("piped stdout"))?,
                ChildStderr::from_std(child.stderr.take().expect("piped stderr"))?,
            ))
        };
        let (mut stdin, stdout, mut stderr) = match adopt(&mut child) {
            Ok(pipes) => pipes,
            Err(e) => {
                reap(child);
                return Err(worker_failed(
                    &self.system,
                    &format!("cannot start it: {e}"),
                ));
            }
        };
        let (input, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let writer = tokio::spawn(async move {
            // The worker stops reading when it dies or is killed: the broken pipe ends this.
            while let Some(buf) = rx.recv().await {
                if stdin.write_all(&buf).await.is_err() {
                    return;
                }
            }
        });
        let mut head = Value::String(self.code.clone()).to_string().into_bytes();
        head.push(b'\n');
        let _ = input.send(head);
        if !self.pending.is_empty() {
            let mut batch = Vec::with_capacity(self.pending.iter().map(|l| l.len()).sum());
            for line in &self.pending {
                batch.extend_from_slice(line);
            }
            let _ = input.send(batch);
        }
        let stderr_tail = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut buf).await;
            buf
        });
        Ok(Worker {
            child: Some(child),
            input,
            writer,
            stdout,
            buf: Vec::new(),
            scanned: 0,
            stderr_tail: Some(stderr_tail),
            ready: false,
        })
    }
}

/// A worker started ahead and waiting for its program, so a stream (or a restart) does not wait
/// for a process to start (about 13 ms on a Mac, TSK-143). The first stream with a jq filter
/// starts it; one is kept from then on. It is a plain process, not tied to a runtime, until a
/// stream adopts its pipes.
static SPARE: Mutex<Option<std::process::Child>> = Mutex::new(None);

fn lock_spare() -> std::sync::MutexGuard<'static, Option<std::process::Child>> {
    SPARE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The spare worker when it still runs, else a new one; then a new spare, started on a thread
/// of its own.
fn take_process() -> std::io::Result<std::process::Child> {
    let spare = lock_spare().take();
    let child = match spare {
        Some(mut child) => {
            if matches!(child.try_wait(), Ok(None)) {
                child
            } else {
                reap(child);
                start_process()?
            }
        }
        None => start_process()?,
    };
    let _ = std::thread::Builder::new()
        .name("jq-spare".into())
        .spawn(|| {
            if let Ok(child) = start_process() {
                let mut spare = lock_spare();
                if spare.is_none() {
                    *spare = Some(child);
                } else {
                    drop(spare);
                    reap(child);
                }
            }
        });
    Ok(child)
}

/// Starts `jq-worker filter` with an empty environment and `/` as its directory.
fn start_process() -> std::io::Result<std::process::Child> {
    let child = std::process::Command::new(worker_program()?)
        .arg(WORKER_ARG)
        .arg(FILTER_ARG)
        .arg(MAX_MEMORY_BYTES.to_string())
        .env_clear()
        .current_dir(
            std::env::temp_dir()
                .ancestors()
                .last()
                .unwrap_or(std::path::Path::new("/")),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    lock_live().insert(child.id());
    Ok(child)
}

/// Kills a worker and waits for it on a thread of its own, so it never lingers as a zombie.
fn reap(mut child: std::process::Child) {
    let _ = child.kill();
    let pid = child.id();
    let spawned = std::thread::Builder::new()
        .name("jq-reap".into())
        .spawn(move || {
            let _ = child.wait();
            lock_live().remove(&pid);
        });
    if spawned.is_err() {
        lock_live().remove(&pid);
    }
}

enum Read {
    Line(String),
    Timeout,
    /// The worker closed its output: it ended.
    Ended,
}

struct Worker {
    /// `None` once handed to [`reap`].
    child: Option<std::process::Child>,
    input: mpsc::UnboundedSender<Vec<u8>>,
    writer: JoinHandle<()>,
    stdout: ChildStdout,
    /// Bytes read and not taken as lines yet.
    buf: Vec<u8>,
    /// How much of `buf` is known to hold no newline.
    scanned: usize,
    stderr_tail: Option<JoinHandle<Vec<u8>>>,
    /// The worker said it compiled the program.
    ready: bool,
}

impl Worker {
    /// The next line, without its newline. Cancel-safe: bytes read stay in `buf`.
    async fn read_line(&mut self, deadline: Instant) -> Read {
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if let Some(at) = self.buf[self.scanned..].iter().position(|b| *b == b'\n') {
                let end = self.scanned + at;
                let line = String::from_utf8_lossy(&self.buf[..end]).into_owned();
                self.buf.drain(..=end);
                self.scanned = 0;
                return Read::Line(line);
            }
            self.scanned = self.buf.len();
            // An answer is a letter, or an error cut to a few hundred characters: a worker that
            // writes far more misbehaves.
            if self.buf.len() > 64 * 1024 {
                return Read::Ended;
            }
            let read = tokio::select! {
                biased;
                read = self.stdout.read(&mut chunk) => read,
                () = tokio::time::sleep_until(deadline) => return Read::Timeout,
            };
            match read {
                Ok(0) | Err(_) => return Read::Ended,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
            }
        }
    }

    /// Why the worker ended, in words, from its exit and its last words.
    async fn ended_words(&mut self) -> String {
        let mut status = None;
        if let Some(child) = self.child.as_mut() {
            let until = Instant::now() + Duration::from_secs(2);
            while status.is_none() && Instant::now() < until {
                match child.try_wait() {
                    Ok(Some(s)) => status = Some(s),
                    Ok(None) => tokio::time::sleep(Duration::from_millis(5)).await,
                    Err(_) => break,
                }
            }
        }
        let stderr = match self.stderr_tail.take() {
            Some(tail) => tokio::time::timeout(Duration::from_secs(1), tail)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let mib = MAX_MEMORY_BYTES / (1024 * 1024);
        match why_ended(status, &String::from_utf8_lossy(&stderr)) {
            Ended::StackOverflow => "the filter's jq recursed too deeply on this message and was \
                                     stopped (it overflowed its stack)"
                .to_owned(),
            Ended::Memory => format!(
                "the filter's jq needed more than {mib} MiB of memory on this message and was \
                 stopped"
            ),
            Ended::Signal(signal) => format!(
                "the filter's jq was stopped by the system on this message (signal {signal}): it \
                 may have recursed too deeply or needed more than {mib} MiB of memory"
            ),
            Ended::Other(how) => format!("the jq worker ended early ({how})"),
        }
    }
}

impl Drop for Worker {
    /// Kills the worker and reaps it, so it never outlives its stream.
    fn drop(&mut self) {
        self.writer.abort();
        if let Some(tail) = &self.stderr_tail {
            tail.abort();
        }
        if let Some(child) = self.child.take() {
            reap(child);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "value": v })).unwrap()
    }

    async fn answers(f: &mut JqFilter, n: usize) -> Vec<Answer> {
        let mut out = Vec::new();
        for _ in 0..n {
            out.push(f.next().await.unwrap());
        }
        out
    }

    #[tokio::test]
    async fn answers_come_in_order() {
        let mut f = JqFilter::start("test", ".value > 1", DEFAULT_BUDGET).unwrap();
        f.send((0..5).map(|i| line(i.into())).collect());
        assert_eq!(f.pending(), 5);
        let got = answers(&mut f, 5).await;
        use Answer::{Match as M, NoMatch as N};
        assert_eq!(got, [N, N, M, M, M]);
        assert_eq!(f.pending(), 0);
        f.send(vec![line("x".into()), b"{nope".to_vec()]);
        assert_eq!(f.next().await.unwrap(), M);
        assert!(
            matches!(f.next().await.unwrap(), Answer::Failed(m) if m.starts_with("jq input: "))
        );
    }

    #[tokio::test]
    async fn a_runaway_message_is_stopped_and_the_next_ones_are_evaluated() {
        let code = "if .value == 2 then (def f: f; f) else .value > 0 end";
        let mut f = JqFilter::start("test", code, MIN_BUDGET).unwrap();
        f.send((0..5).map(|i| line(i.into())).collect());
        let started = std::time::Instant::now();
        let got = answers(&mut f, 5).await;
        // The budget, a restart and four quick answers (other tests' runaways share the cores).
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(got[..2], [Answer::NoMatch, Answer::Match]);
        assert!(
            matches!(&got[2], Answer::Failed(m) if m.contains("ran for more than 0.5 s")),
            "{got:?}"
        );
        assert_eq!(got[3..], [Answer::Match, Answer::Match]);
    }

    #[tokio::test]
    async fn a_stack_overflow_ends_only_the_worker() {
        let code = "if .value == 1 then (def f: 1 + f; f) else true end";
        let mut f = JqFilter::start("test", code, Duration::from_secs(10)).unwrap();
        f.send((0..3).map(|i| line(i.into())).collect());
        let got = answers(&mut f, 3).await;
        assert_eq!(got[0], Answer::Match);
        assert!(
            matches!(&got[1], Answer::Failed(m) if m.contains("recursed too deeply")),
            "{got:?}"
        );
        assert_eq!(got[2], Answer::Match);
    }

    #[tokio::test]
    async fn three_failures_in_a_row_end_the_stream_and_an_answer_between_resets_the_count() {
        // Stack overflows end a worker in milliseconds; a program that never ends would hold a
        // core for the budget each time, beside the timing tests of `core::jq` (tests/filter_worker.rs
        // runs those in a row end to end).
        let code = "if .value % 3 == 0 then true else (def f: 1 + f; f) end";
        let mut f = JqFilter::start("test", code, Duration::from_secs(10)).unwrap();
        // 1 and 2 fail, 3 answers, 4 and 5 fail, 6 answers: never three in a row.
        f.send((1..=6).map(|i| line(i.into())).collect());
        let got = answers(&mut f, 6).await;
        assert!(matches!(got[0], Answer::Failed(_)) && matches!(got[1], Answer::Failed(_)));
        assert_eq!(got[2], Answer::Match);
        assert_eq!(got[5], Answer::Match);
        f.send(vec![line(7.into()), line(8.into()), line(10.into())]);
        assert!(matches!(f.next().await.unwrap(), Answer::Failed(_)));
        assert!(matches!(f.next().await.unwrap(), Answer::Failed(_)));
        let e = f.next().await.unwrap_err();
        assert_eq!(e.kind, ToolErrorKind::Invalid);
        assert_eq!(e.field.as_deref(), Some("filter"));
        assert!(e.message.contains("3 messages in a row"), "{}", e.message);
        assert!(e.message.contains("recursed too deeply"), "{}", e.message);
    }

    #[tokio::test]
    async fn dropping_the_filter_kills_its_worker() {
        let mut f = JqFilter::start("test", "def f: f; f", MAX_BUDGET).unwrap();
        let pid = f
            .worker
            .as_ref()
            .and_then(|w| w.child.as_ref())
            .map(std::process::Child::id)
            .unwrap();
        f.send(vec![line(1.into())]);
        // The worker is busy forever on the message; the stream goes away.
        let waiting = tokio::time::timeout(Duration::from_millis(300), f.next()).await;
        assert!(waiting.is_err());
        drop(f);
        let started = std::time::Instant::now();
        while live_workers().contains(&pid) {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "worker {pid} still runs"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    #[test]
    fn the_budget_is_clamped_to_the_setting_s_range() {
        assert_eq!(budget(None), Duration::from_secs(1));
        assert_eq!(budget(Some(1)), MIN_BUDGET);
        assert_eq!(budget(Some(2_500)), Duration::from_millis(2_500));
        assert_eq!(budget(Some(u64::MAX)), MAX_BUDGET);
    }
}
