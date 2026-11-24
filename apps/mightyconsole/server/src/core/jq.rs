//! jq on a value, in a child process (Mightyconsole spec §5.4.1, TSK-113).
//!
//! The server starts itself again as `mightyconsole-server jq-worker` for each run, with an empty
//! environment and the root as its directory, writes the program and the value's JSON text to
//! the child's stdin and reads [`message_codecs::jq::wire`] lines back. A program that never
//! ends, overflows its stack or grows without bound ends only the child: the server kills it at
//! the deadline, when its results pass the output cap, or when the call is cancelled (the future
//! is dropped and the child with it), and reports what happened in words. On Linux the child
//! limits its own memory and CPU time first ([`worker_main`]).
//!
//! Every query on a value goes through [`run`]: `messaging.query`, `temporal.payload.query` and
//! `langgraph.values.query`. The compiler that refuses the builtins reaching outside the value is
//! `message_codecs::jq`, shared with the filter.
//!
//! The same binary is the filter's long-lived worker per stream (`jq-worker filter`, spec §5.4,
//! TSK-143): the stream's side is [`crate::core::messaging::jq_filter`].

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{LazyLock, RwLock};
use std::time::Duration;

use message_codecs::filter::FilterIssue;
use message_codecs::jq::wire;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Semaphore;
use tokio::time::Instant;
use ts_rs::TS;

use super::{ErrorPosition, ToolError, ToolErrorKind};

/// The deadline when the call names none (spec §5.4.1).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(2);
/// The range the server clamps a requested deadline to (the setting's range).
pub const MIN_TIMEOUT: Duration = Duration::from_millis(500);
pub const MAX_TIMEOUT: Duration = Duration::from_secs(30);
/// Results are cut at this much JSON text: 1/16 of Ambidex's 16 MiB frame.
pub const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
/// The largest value the browser may send (`messaging.query`).
pub const MAX_TEXT_INPUT_BYTES: usize = 8 * 1024 * 1024;
/// The largest value the server keeps that a query may run on (Temporal, LangGraph).
pub const MAX_KEPT_INPUT_BYTES: usize = 32 * 1024 * 1024;
/// Memory a run may use, on Linux.
pub const MAX_MEMORY_BYTES: u64 = 512 * 1024 * 1024;
/// Runs at a time on the server; a further one waits for a slot within its deadline.
pub const MAX_RUNNING: usize = 2;

/// The argument that makes the server a worker.
pub const WORKER_ARG: &str = "jq-worker";
/// After [`WORKER_ARG`]: the worker of a stream's filter, not of one query.
pub const FILTER_ARG: &str = "filter";

/// The server's engine: its slots are shared by every caller.
static ENGINE: LazyLock<JqEngine> = LazyLock::new(|| JqEngine::new(MAX_RUNNING));

/// Runs queries in workers, at most `slots` at a time.
pub struct JqEngine {
    slots: Semaphore,
    running: usize,
}

/// Why a run returned before its program ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Stopped {
    /// The next result would have passed 1 MiB of JSON text.
    Output,
    /// The deadline passed; the results are those that arrived before it.
    Deadline,
}

/// What a run gave.
#[derive(Debug, Clone, PartialEq)]
pub struct Outputs {
    pub results: Vec<Value>,
    /// The results' JSON text, in bytes.
    pub bytes: usize,
    pub stopped: Option<Stopped>,
    pub ms: u64,
}

/// The deadline a call asked for, clamped to the setting's range.
pub fn timeout(ms: Option<u64>) -> Duration {
    ms.map_or(DEFAULT_TIMEOUT, |ms| {
        Duration::from_millis(ms).clamp(MIN_TIMEOUT, MAX_TIMEOUT)
    })
}

static WORKER: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Names the program queries run in, in place of the server's own binary (a server started
/// inside a test harness, [`crate::StartOptions::jq_worker`]).
pub fn set_worker_program(path: PathBuf) {
    *WORKER
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
}

/// The program the server starts as a worker: itself, unless [`set_worker_program`] named
/// another. On Linux that is `/proc/self/exe`, the running image, which still works after the
/// file on disk was replaced (an upgrade in place, or a rebuild while it runs). Unit tests run
/// inside the test harness, so they use the server binary Cargo builds next to it.
pub(crate) fn worker_program() -> std::io::Result<PathBuf> {
    if let Some(path) = WORKER
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
    {
        return Ok(path);
    }
    let exe = std::env::current_exe()?;
    #[cfg(test)]
    {
        let dir = exe
            .parent()
            .and_then(std::path::Path::parent)
            .ok_or_else(|| std::io::Error::other("no target directory"))?;
        let bin = dir.join(format!(
            "mightyconsole-server{}",
            std::env::consts::EXE_SUFFIX
        ));
        if !bin.exists() {
            return Err(std::io::Error::other(format!(
                "{} is missing: run the server's tests with `cargo test -p mightyconsole-server`, \
                 which builds it",
                bin.display()
            )));
        }
        Ok(bin)
    }
    #[cfg(all(not(test), target_os = "linux"))]
    {
        let image = PathBuf::from("/proc/self/exe");
        Ok(if image.exists() { image } else { exe })
    }
    #[cfg(all(not(test), not(target_os = "linux")))]
    Ok(exe)
}

fn jq_error(system: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(system, "jq", message)
}

/// The first compile issue as an `Invalid` error on `jq`, with its position.
fn issues_error(system: &str, issues: Vec<FilterIssue>) -> ToolError {
    let first = issues.into_iter().next();
    let mut error = jq_error(
        system,
        first
            .as_ref()
            .map_or_else(|| "jq failed".to_owned(), |i| i.message.clone()),
    );
    if let Some(i) = first
        && let (Some(line), Some(column)) = (i.line, i.column)
    {
        error.position = Some(ErrorPosition { line, column });
    }
    error
}

/// Runs `code` on the JSON text `value` (at most `max_input` bytes) in a worker of the server's
/// engine, within `timeout`. Errors are `Invalid` on `jq` (with the position when the program
/// does not compile or is refused) or on `value` (too large, not JSON); `Conflict` (retryable)
/// when every slot stayed busy until the deadline; a worker that could not start or ended in a
/// way the server did not expect is `Remote`.
pub async fn run(
    system: &str,
    code: &str,
    value: Vec<u8>,
    max_input: usize,
    timeout: Duration,
) -> Result<Outputs, ToolError> {
    ENGINE.run(system, code, value, max_input, timeout).await
}

impl JqEngine {
    pub fn new(slots: usize) -> Self {
        Self {
            slots: Semaphore::new(slots),
            running: slots,
        }
    }

    /// See [`run`].
    pub async fn run(
        &self,
        system: &str,
        code: &str,
        value: Vec<u8>,
        max_input: usize,
        timeout: Duration,
    ) -> Result<Outputs, ToolError> {
        let started = Instant::now();
        let deadline = started + timeout;
        if code.trim().is_empty() {
            return Err(jq_error(system, "a jq program is required"));
        }
        if value.len() > max_input {
            return Err(ToolError::invalid(
                system,
                "value",
                format!(
                    "the value is {} MiB; a query runs on at most {} MiB (download it to work on it \
                 elsewhere)",
                    value.len().div_ceil(1024 * 1024),
                    max_input / (1024 * 1024)
                ),
            ));
        }
        let _slot = tokio::time::timeout_at(deadline, self.slots.acquire())
            .await
            .map_err(|_| {
                ToolError::new(
                    ToolErrorKind::Conflict,
                    system,
                    format!(
                        "the server is busy with {} other queries; try again in a moment",
                        self.running
                    ),
                )
                .retryable(true)
            })?
            .map_err(|_| {
                ToolError::new(ToolErrorKind::Remote, system, "the query slots are closed")
            })?;

        let program = worker_program().map_err(|e| worker_failed(system, &e.to_string()))?;
        let mut command = tokio::process::Command::new(program);
        command
            .arg(WORKER_ARG)
            .arg(MAX_OUTPUT_BYTES.to_string())
            .arg(MAX_MEMORY_BYTES.to_string())
            .arg(timeout.as_secs().saturating_add(2).to_string())
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
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|e| worker_failed(system, &format!("cannot start it: {e}")))?;

        let mut stdin = child.stdin.take().expect("piped stdin");
        let head = format!("{}\n", Value::String(code.trim().to_owned()));
        let writer = tokio::spawn(async move {
            // The child may stop reading (it failed to compile, or was killed): ignore broken pipes.
            let _ = stdin.write_all(head.as_bytes()).await;
            let _ = stdin.write_all(&value).await;
            let _ = stdin.shutdown().await;
        });
        let stdout = child.stdout.take().expect("piped stdout");
        let mut stderr = child.stderr.take().expect("piped stderr");
        let stderr_tail = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut buf).await;
            buf
        });

        let mut out = Outputs {
            results: Vec::new(),
            bytes: 0,
            stopped: None,
            ms: 0,
        };
        let mut reader = Reader {
            system,
            out: &mut out,
            ended: false,
            failure: None,
        };
        // One timer for the whole run; the worker's lines are read in chunks and split here, so
        // a million small results are not a million wakeups.
        let expired = tokio::time::sleep_until(deadline);
        tokio::pin!(expired);
        let mut stdout = stdout;
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let mut received = 0usize;
        loop {
            let read = tokio::select! {
                biased;
                () = &mut expired => None,
                read = stdout.read(&mut chunk) => Some(read),
            };
            match read {
                None => {
                    reader.out.stopped = Some(Stopped::Deadline);
                    break;
                }
                Some(Err(e)) => {
                    reader.failure = Some(worker_failed(system, &e.to_string()));
                    break;
                }
                Some(Ok(0)) => break,
                Some(Ok(n)) => {
                    received += n;
                    // A result is at least 1 byte and its line adds 3 (`R `, the newline): more
                    // than that over the cap is a worker that misbehaves.
                    if received > MAX_OUTPUT_BYTES * 4 + 64 * 1024 {
                        reader.failure = Some(worker_failed(
                            system,
                            "it wrote more than it was allowed to",
                        ));
                        break;
                    }
                    pending.extend_from_slice(&chunk[..n]);
                    let mut start = 0;
                    while let Some(end) = pending[start..].iter().position(|b| *b == b'\n') {
                        let line = &pending[start..start + end];
                        start += end + 1;
                        if !reader.line(line) {
                            break;
                        }
                    }
                    pending.drain(..start);
                    if reader.done() {
                        break;
                    }
                }
            }
        }
        let ended = reader.ended;
        let mut failure = reader.failure;
        if !ended && out.stopped.is_none() && failure.is_none() {
            // The worker ended without saying so: read why from its exit and its last words.
            match tokio::time::timeout_at(deadline, child.wait()).await {
                Err(_) => out.stopped = Some(Stopped::Deadline),
                Ok(status) => {
                    // The child has ended, so its stderr ends too.
                    let tail = stderr_tail.await.unwrap_or_default();
                    failure = Some(ended_early(
                        system,
                        status.ok(),
                        &String::from_utf8_lossy(&tail),
                    ));
                }
            }
        }
        let _ = child.start_kill();
        writer.abort();
        out.ms = started.elapsed().as_millis() as u64;
        if let Some(e) = failure {
            return Err(e);
        }
        if out.stopped == Some(Stopped::Deadline) && out.results.is_empty() {
            return Err(ToolError::invalid(
                system,
                "jq",
                format!(
                    "the program ran for {} and was stopped before its first result; the time limit \
                 is in Settings",
                    human(timeout)
                ),
            ));
        }
        Ok(out)
    }
}

/// Reads the worker's [`wire`] lines into the outputs.
struct Reader<'a> {
    system: &'a str,
    out: &'a mut Outputs,
    /// The worker said it was done (or that the program does not compile).
    ended: bool,
    failure: Option<ToolError>,
}

impl Reader<'_> {
    fn done(&self) -> bool {
        self.ended || self.failure.is_some() || self.out.stopped.is_some()
    }

    /// Takes one line; false when the run is over.
    fn line(&mut self, line: &[u8]) -> bool {
        let text = String::from_utf8_lossy(line);
        if let Some(result) = text.strip_prefix(wire::RESULT) {
            if self.out.bytes + result.len() > MAX_OUTPUT_BYTES {
                self.out.stopped = Some(Stopped::Output);
            } else {
                self.out.bytes += result.len();
                self.out.results.push(
                    serde_json::from_str(result)
                        .unwrap_or_else(|_| Value::String(result.to_owned())),
                );
            }
        } else if text == wire::CUT {
            self.out.stopped = Some(Stopped::Output);
        } else if text == wire::DONE {
            self.ended = true;
        } else if let Some(issues) = text.strip_prefix(wire::ISSUES) {
            let issues: Vec<FilterIssue> = serde_json::from_str(issues).unwrap_or_default();
            self.failure = Some(issues_error(self.system, issues));
            self.ended = true;
        } else if let Some(message) = text.strip_prefix(wire::FAILED) {
            let message: String =
                serde_json::from_str(message).unwrap_or_else(|_| message.to_owned());
            let field = if message.starts_with("the value is not JSON") {
                "value"
            } else {
                "jq"
            };
            // The worker still writes `D` after a failure; the run is over either way.
            self.failure = Some(ToolError::invalid(self.system, field, message));
        } else {
            self.failure = Some(worker_failed(
                self.system,
                "it wrote something the server cannot read",
            ));
        }
        !self.done()
    }
}

pub(crate) fn human(d: Duration) -> String {
    if d.subsec_millis() == 0 {
        format!("{} s", d.as_secs())
    } else {
        format!("{:.1} s", d.as_secs_f64())
    }
}

pub(crate) fn worker_failed(system: &str, why: &str) -> ToolError {
    ToolError::new(
        ToolErrorKind::Remote,
        system,
        format!("the jq worker failed: {why}"),
    )
}

/// Why a worker ended before it was done, read from its exit and its last words.
pub(crate) enum Ended {
    StackOverflow,
    Memory,
    /// Killed by a signal that left no words (a build without them).
    Signal(i32),
    /// Something else: the exit status.
    Other(String),
}

pub(crate) fn why_ended(status: Option<std::process::ExitStatus>, stderr: &str) -> Ended {
    if stderr.contains("has overflowed its stack") {
        return Ended::StackOverflow;
    }
    if stderr.contains("memory allocation of") {
        return Ended::Memory;
    }
    #[cfg(unix)]
    if let Some(signal) = status.and_then(|s| std::os::unix::process::ExitStatusExt::signal(&s)) {
        return Ended::Signal(signal);
    }
    Ended::Other(status.map_or_else(|| "unknown".to_owned(), |s| s.to_string()))
}

/// Words for a worker that ended without finishing: a stack overflow, the memory limit, or
/// something else.
fn ended_early(system: &str, status: Option<std::process::ExitStatus>, stderr: &str) -> ToolError {
    let mib = MAX_MEMORY_BYTES / (1024 * 1024);
    match why_ended(status, stderr) {
        Ended::StackOverflow => jq_error(
            system,
            "the program recursed too deeply and was stopped (it overflowed its stack)",
        ),
        Ended::Memory => jq_error(
            system,
            format!("the program needed more than {mib} MiB of memory and was stopped"),
        ),
        // A stack overflow or a failed allocation that left no words (a build without them).
        Ended::Signal(signal) => jq_error(
            system,
            format!(
                "the program was stopped by the system (signal {signal}): it may have recursed \
                 too deeply or needed more than {mib} MiB of memory"
            ),
        ),
        Ended::Other(how) => worker_failed(system, &format!("it ended early ({how})")),
    }
}

/// The worker's main (`mightyconsole-server jq-worker <max output bytes> <max memory bytes>
/// <max cpu seconds>`): limits itself where the OS allows it, then serves one run on stdin and
/// stdout. `jq-worker filter <max memory bytes>` is a stream filter's worker instead
/// ([`filter_worker_main`]). Returns the process's exit code.
pub fn worker_main(args: &[String]) -> u8 {
    if args.first().map(String::as_str) == Some(FILTER_ARG) {
        return filter_worker_main(&args[1..]);
    }
    let num = |i: usize| args.get(i).and_then(|a| a.parse::<u64>().ok());
    let (Some(max_output), Some(memory), Some(cpu)) = (num(0), num(1), num(2)) else {
        eprintln!(
            "mightyconsole-server {WORKER_ARG}: the server starts this itself; it expects the \
             output, memory and CPU limits"
        );
        return 2;
    };
    if let Err(e) = limit_self(memory, cpu) {
        eprintln!("mightyconsole-server {WORKER_ARG}: cannot set its limits: {e}");
        return 2;
    }
    let stdin = std::io::stdin().lock();
    let stdout = std::io::stdout().lock();
    match message_codecs::jq::serve_worker(stdin, stdout, max_output as usize) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// A stream filter's worker (`jq-worker filter <max memory bytes>`, TSK-143): caps its memory
/// where the OS allows it, ends itself when the server is gone, then answers the stream's
/// messages on stdin and stdout until stdin ends.
///
/// It runs as long as its stream, so a CPU-time limit would end a busy tail that is working
/// as it should: the server bounds each message with its time budget instead, and should the
/// server die without killing the worker, the worker notices it has a new parent and exits
/// ([`watch_parent`]).
fn filter_worker_main(args: &[String]) -> u8 {
    let Some(memory) = args.first().and_then(|a| a.parse::<u64>().ok()) else {
        eprintln!(
            "mightyconsole-server {WORKER_ARG} {FILTER_ARG}: the server starts this itself; it \
             expects the memory limit"
        );
        return 2;
    };
    if let Err(e) = limit_memory(memory) {
        eprintln!("mightyconsole-server {WORKER_ARG} {FILTER_ARG}: cannot set its limits: {e}");
        return 2;
    }
    watch_parent();
    let stdin = std::io::stdin().lock();
    let stdout = std::io::stdout().lock();
    match message_codecs::jq::serve_filter_worker(stdin, stdout) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

/// Unix: a thread that exits the process once its parent is gone (it is then adopted, so its
/// parent's id changes). The main thread may be inside a program that never ends and never
/// reads stdin again, so the closed pipe alone would not end it.
#[cfg(unix)]
fn watch_parent() {
    let parent = std::os::unix::process::parent_id();
    let _ = std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(500));
                if std::os::unix::process::parent_id() != parent {
                    std::process::exit(3);
                }
            }
        });
}

#[cfg(not(unix))]
fn watch_parent() {}

/// Linux: the data segment (every heap allocation, since Linux 4.7) and CPU seconds as a backstop
/// should the server die before it kills the worker. Other systems have no limit reachable from
/// safe Rust; the deadline bounds them (spec Open question 65 (d)).
#[cfg(target_os = "linux")]
fn limit_self(memory: u64, cpu: u64) -> std::io::Result<()> {
    use rustix::process::{Resource, Rlimit, setrlimit};
    let limit = |n: u64| Rlimit {
        current: Some(n),
        maximum: Some(n),
    };
    limit_memory(memory)?;
    setrlimit(Resource::Cpu, limit(cpu))?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn limit_self(_memory: u64, _cpu: u64) -> std::io::Result<()> {
    Ok(())
}

/// Linux: the data segment, as [`limit_self`].
#[cfg(target_os = "linux")]
fn limit_memory(memory: u64) -> std::io::Result<()> {
    use rustix::process::{Resource, Rlimit, setrlimit};
    setrlimit(
        Resource::Data,
        Rlimit {
            current: Some(memory),
            maximum: Some(memory),
        },
    )?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn limit_memory(_memory: u64) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A query whose result matters, not its limits: an engine of its own and a long deadline,
    /// so the runaway tests running beside it (each holding a core) never make it time out.
    async fn q(code: &str, value: &str) -> Result<Outputs, ToolError> {
        JqEngine::new(1)
            .run(
                "test",
                code,
                value.as_bytes().to_vec(),
                MAX_TEXT_INPUT_BYTES,
                Duration::from_secs(20),
            )
            .await
    }

    /// An engine of its own, so a test that holds slots does not starve the others.
    async fn on(engine: &JqEngine, code: &str, timeout: Duration) -> Result<Outputs, ToolError> {
        engine
            .run(
                "test",
                code,
                b"null".to_vec(),
                MAX_TEXT_INPUT_BYTES,
                timeout,
            )
            .await
    }

    fn ints(xs: &[i64]) -> Vec<Value> {
        xs.iter().map(|x| Value::from(*x)).collect()
    }

    #[tokio::test]
    async fn a_program_that_never_ends_is_stopped_at_the_deadline() {
        let engine = JqEngine::new(1);
        for code in [
            "def f: f; f",
            "last(range(1e18))",
            "until(false; .)",
            "reduce range(1e18) as $x (0; . + 1)",
        ] {
            let started = std::time::Instant::now();
            let e = on(&engine, code, MIN_TIMEOUT).await.unwrap_err();
            let took = started.elapsed();
            assert!(
                e.message.contains("was stopped before its first result"),
                "{code}: {e:?}"
            );
            assert!(
                took < MIN_TIMEOUT + Duration::from_millis(400),
                "{code}: {took:?}"
            );
        }
        // Results that arrived before the deadline are kept.
        let out = on(&engine, "1, 2, last(range(1e18))", MIN_TIMEOUT)
            .await
            .unwrap();
        assert_eq!(out.results, ints(&[1, 2]));
        assert_eq!(out.stopped, Some(Stopped::Deadline));
        // The slot is free again: the engine still answers.
        let out = on(&engine, "1 + 1", DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(out.results, ints(&[2]));
    }

    #[tokio::test]
    async fn results_stop_at_the_output_cap() {
        let engine = JqEngine::new(1);
        for code in ["repeat(1)", "range(1e18)"] {
            let out = on(&engine, code, Duration::from_secs(10)).await.unwrap();
            assert_eq!(out.stopped, Some(Stopped::Output), "{code}");
            assert!(out.bytes <= MAX_OUTPUT_BYTES, "{code}: {}", out.bytes);
            assert!(out.bytes > MAX_OUTPUT_BYTES - 32, "{code}: {}", out.bytes);
        }
        // One result over the cap: nothing is kept, and the run says why.
        let out = on(&engine, "[range(1e6)] | tostring", Duration::from_secs(10))
            .await
            .unwrap();
        assert!(out.results.is_empty());
        assert_eq!(out.stopped, Some(Stopped::Output));
    }

    #[tokio::test]
    async fn a_stack_overflow_ends_only_the_worker() {
        let engine = JqEngine::new(1);
        for code in ["def f: 1 + f; f", "def f: [f]; f"] {
            let e = on(&engine, code, Duration::from_secs(10))
                .await
                .unwrap_err();
            assert_eq!(e.field.as_deref(), Some("jq"), "{code}: {e:?}");
            assert!(
                e.message.contains("recursed too deeply"),
                "{code}: {}",
                e.message
            );
        }
        let out = on(&engine, "1", DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(out.results, ints(&[1]));
    }

    /// Linux only: the other systems have no memory limit reachable from safe Rust (spec Open
    /// question 65 (d)); the deadline bounds them.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn memory_is_capped() {
        let engine = JqEngine::new(1);
        let e = on(&engine, "def f: f, f; [f]", MAX_TIMEOUT)
            .await
            .unwrap_err();
        assert!(e.message.contains("MiB of memory"), "{}", e.message);
    }

    #[tokio::test]
    async fn refused_builtins_and_errors_name_the_program_s_position() {
        let e = q(".a |\n  env", "{}").await.unwrap_err();
        assert_eq!(e.field.as_deref(), Some("jq"));
        assert!(e.message.contains("env is not available"), "{}", e.message);
        let p = e.position.unwrap();
        assert_eq!((p.line, p.column), (2, 3));
        for code in [
            "halt",
            "$ENV",
            "input",
            "debug",
            "\"x\" | stderr",
            "0 | localtime",
            "include \"a\"; .",
        ] {
            let e = q(code, "{}").await.unwrap_err();
            assert!(e.message.contains("not available"), "{code}: {}", e.message);
        }
        let e = q(".a + 1", r#"{"a":"x"}"#).await.unwrap_err();
        assert!(e.message.starts_with("jq: "), "{}", e.message);
        let e = q(".", "{nope").await.unwrap_err();
        assert_eq!(e.field.as_deref(), Some("value"));
    }

    #[tokio::test]
    async fn a_third_run_waits_for_a_slot_and_then_fails_as_busy() {
        let engine = std::sync::Arc::new(JqEngine::new(2));
        let hold = |e: std::sync::Arc<JqEngine>| {
            tokio::spawn(async move { on(&e, "def f: f; f", Duration::from_secs(5)).await })
        };
        let a = hold(engine.clone());
        let b = hold(engine.clone());
        tokio::time::sleep(Duration::from_millis(300)).await;
        let e = on(&engine, "1", MIN_TIMEOUT).await.unwrap_err();
        assert_eq!(e.kind, ToolErrorKind::Conflict, "{e:?}");
        assert!(e.retryable, "{e:?}");
        // Cancelling a call drops its worker (killed) and frees its slot.
        a.abort();
        b.abort();
        let _ = a.await;
        let _ = b.await;
        // The held runs had 5 s left: a slot within this 2 s deadline means cancelling freed it.
        let out = on(&engine, "1", DEFAULT_TIMEOUT).await.unwrap();
        assert_eq!(out.results, ints(&[1]));
    }

    /// The Query bar and the FilterBar run one compiler (spec §5.4.1): on the object the filter
    /// reads, a message matches exactly when the query yields a value that is neither `false`
    /// nor `null`, and a program is refused or fails in both.
    #[tokio::test]
    async fn the_query_and_the_filter_agree() {
        use message_codecs::filter::{CompiledFilter, Filter, FilterInput, Outcome};
        let value = serde_json::json!({
            "order": { "id": "o-17", "total": 42.5, "items": [{ "sku": "a", "qty": 2 }, { "sku": "b", "qty": 0 }] },
            "tags": ["x", "y"], "note": null
        });
        let input = FilterInput {
            source: "orders",
            subject: Some("orders.created"),
            partition: None,
            offset: None,
            sequence: Some(7),
            timestamp_us: 0,
            headers: None,
            key: None,
            text: None,
            value: &value,
        };
        // What the filter's jq reads (filter.rs, `jq_input`), as text for the query.
        let object = serde_json::json!({
            "key": null, "value": value, "headers": {}, "subject": "orders.created",
            "source": "orders", "partition": null, "offset": null, "sequence": "7",
            "timestamp": "1970-01-01T00:00:00Z"
        })
        .to_string();
        let cases = [
            ".value.order.total > 40",
            ".value.order.total > 100",
            ".value.order.items[] | select(.qty == 0)",
            ".value.order.items | map(.qty) | add",
            ".value.tags | index(\"y\")",
            ".value.note",
            "false, null",
            "empty",
            ".sequence == \"7\" and .subject == \"orders.created\"",
            ".timestamp | startswith(\"1970\")",
            "[paths(type == \"number\")] | length > 2",
            ".value.order.id | test(\"^o-\\\\d+$\")",
            ".value.order.id | tonumber",
            "error(\"no\")",
            "env",
            "$ENV",
            "halt",
            "input",
            "debug",
        ];
        for code in cases {
            let filter = CompiledFilter::compile(&Filter {
                jq: Some(code.into()),
                ..Filter::default()
            });
            let query = q(code, &object).await;
            match (filter, query) {
                (Err(issues), Err(e)) => {
                    assert_eq!(issues[0].message, e.message, "{code}");
                    assert_eq!(e.field.as_deref(), Some("jq"), "{code}");
                }
                (Ok(filter), Ok(out)) => {
                    let truthy = out
                        .results
                        .iter()
                        .any(|v| !matches!(v, Value::Null | Value::Bool(false)));
                    let want = if truthy {
                        Outcome::Match
                    } else {
                        Outcome::NoMatch
                    };
                    assert_eq!(filter.evaluate(&input), want, "{code}: {:?}", out.results);
                }
                (Ok(filter), Err(e)) => {
                    // A program that fails on this value fails in both.
                    assert!(
                        matches!(filter.evaluate(&input), Outcome::JqError(ref m) if *m == e.message),
                        "{code}: {e:?}"
                    );
                }
                (Err(issues), Ok(out)) => panic!("{code}: filter {issues:?}, query {out:?}"),
            }
        }
    }

    #[test]
    fn the_deadline_is_clamped_to_the_setting_s_range() {
        assert_eq!(timeout(None), Duration::from_secs(2));
        assert_eq!(timeout(Some(10)), MIN_TIMEOUT);
        assert_eq!(timeout(Some(5_000)), Duration::from_secs(5));
        assert_eq!(timeout(Some(3_600_000)), MAX_TIMEOUT);
    }

    #[tokio::test]
    async fn results_come_back_as_json_values() {
        let out = q(".items[] | .qty", r#"{"items":[{"qty":2},{"qty":5}]}"#)
            .await
            .unwrap();
        assert_eq!(out.results, vec![Value::from(2), Value::from(5)]);
        assert_eq!(out.bytes, 2);
        assert_eq!(out.stopped, None);
    }

    #[tokio::test]
    async fn an_empty_program_and_a_large_value_are_refused_before_running() {
        let e = q("  ", "{}").await.unwrap_err();
        assert_eq!(e.field.as_deref(), Some("jq"));
        let big = vec![b' '; 2048];
        let e = run("test", ".", big, 1024, DEFAULT_TIMEOUT)
            .await
            .unwrap_err();
        assert_eq!(e.field.as_deref(), Some("value"));
        assert!(e.message.contains("at most"), "{e:?}");
    }
}
