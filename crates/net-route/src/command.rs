//! The local command hop (DOC-23 4.4, 11.3): a program on the machine running the dialer whose
//! stdin and stdout are the stream to the next address, as OpenSSH's `ProxyCommand` (`tsh proxy
//! ssh`, `cloudflared access ssh`, `aws ssm start-session`, `ssh -W`).
//!
//! - **No shell.** The program and its arguments are given as a list and run as they are; only
//!   `{host}` and `{port}` are replaced, and only by a valid name or address and digits.
//! - **A clean environment**: `PATH`, `HOME`, `USER`, `LANG`, `TMPDIR` (Windows: `SystemRoot`,
//!   `USERPROFILE`, `PATH`, `TEMP`) of this process, plus the hop's own variables, so this
//!   process's secrets do not reach the program.
//! - **Its stderr** is kept (the last 8 KiB) for the error message.
//! - **It lives as long as the stream**: dropping the stream closes its stdin, then SIGTERM
//!   after 2 s and SIGKILL 3 s later (Windows: TerminateProcess after 2 s). A program that ends
//!   before the stream is handed out is a `Connect` error with its exit code and stderr.
//! - **Its stdin and stdout are one socket pair on Unix, not pipes** (as libuv gives a child).
//!   A program may `splice(2)` a socket into a pipe on its stdout (Rust's `std::io::copy` does),
//!   and Linux then holds the pipe's lock while it waits for more from the socket: what it already
//!   moved cannot be read, even by a blocking reader, and a protocol whose next byte depends on
//!   that one stops (TSK-115 batch 3, found with the test program). Nothing splices between two
//!   sockets. Windows has no splice: there the pipes are read and written by threads of their own.

use std::io::Read;
#[cfg(not(unix))]
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
#[cfg(not(unix))]
use std::task::ready;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
#[cfg(not(unix))]
use tokio::sync::mpsc;
use tokio::sync::oneshot;
#[cfg(not(unix))]
use tokio_util::sync::PollSender;

use crate::BoxStream;
use crate::error::{HopFailure, RouteErrorKind};
use crate::name::expand_placeholders;
use crate::route::Secret;
use crate::ssh::{STDERR_TAIL, said};

/// How long a started program is watched for ending at once (a missing login, a bad argument)
/// before its stream is handed out, unless it writes first.
pub const COMMAND_EARLY_EXIT: Duration = Duration::from_millis(300);

/// After the stream is dropped: how long the program may take to end on its own (stdin closed),
/// and then after SIGTERM.
const TERM_AFTER: Duration = Duration::from_secs(2);
const KILL_AFTER: Duration = Duration::from_secs(3);

/// How often the watcher thread looks whether the program ended.
const WATCH_EVERY: Duration = Duration::from_millis(25);

/// Chunks in flight between the stream and the pipe threads, each way.
#[cfg(not(unix))]
const CHANNEL_CHUNKS: usize = 16;
const CHUNK: usize = 16 * 1024;

/// The variables of this process a command hop's program receives (DOC-23 11.3).
#[cfg(not(windows))]
const KEPT_ENV: &[&str] = &["PATH", "HOME", "USER", "LANG", "TMPDIR"];
#[cfg(windows)]
const KEPT_ENV: &[&str] = &["SystemRoot", "USERPROFILE", "PATH", "TEMP"];

/// A local command hop: the first hop of a route.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandHop {
    /// An absolute path, or a name found on this process's `PATH`.
    pub program: String,
    /// The arguments as a list (no shell, no splitting); `{host}` and `{port}` are the next
    /// address.
    pub args: Vec<String>,
    /// Variables added to the clean environment; the values may be secrets.
    pub env: Vec<(String, Secret)>,
    pub cwd: Option<PathBuf>,
}

impl CommandHop {
    /// The program's file name, as the hop is named in errors and reports (never an argument).
    pub fn label(&self) -> String {
        let name = self
            .program
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(&self.program);
        if name.is_empty() {
            self.program.clone()
        } else {
            name.to_owned()
        }
    }

    pub(crate) fn validate(&self) -> Result<(), (Option<&'static str>, String)> {
        if self.program.trim().is_empty() {
            return Err((Some("program"), "enter the program to run".into()));
        }
        if self.program.contains('\0') || self.args.iter().any(|a| a.contains('\0')) {
            return Err((
                Some("args"),
                "the program and its arguments cannot hold NUL".into(),
            ));
        }
        for (name, value) in &self.env {
            let ok = name
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            if !ok {
                return Err((
                    Some("env"),
                    format!("{name:?} is not an environment variable name"),
                ));
            }
            if value.expose().contains('\0') {
                return Err((Some("env"), format!("the value of {name} cannot hold NUL")));
            }
        }
        Ok(())
    }
}

/// The program, shared by the watcher and whoever ends it.
struct Process {
    child: Mutex<Child>,
    exited: Mutex<Option<ExitStatus>>,
}

impl Process {
    fn exited(&self) -> Option<ExitStatus> {
        *lock(&self.exited)
    }

    /// SIGTERM where there is one; `false` otherwise (Windows: TerminateProcess comes next).
    #[cfg(unix)]
    fn terminate(&self) -> bool {
        let id = lock(&self.child).id();
        let Some(pid) = i32::try_from(id)
            .ok()
            .and_then(rustix::process::Pid::from_raw)
        else {
            return false;
        };
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).is_ok()
    }

    #[cfg(not(unix))]
    fn terminate(&self) -> bool {
        false
    }

    fn kill(&self) {
        let _ = lock(&self.child).kill();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// Starts the program for `host:port` and hands out its stdio as the stream.
// Unix returns from its own block; the Windows block after it is compiled out there.
#[cfg_attr(unix, allow(clippy::needless_return))]
pub(crate) async fn spawn(
    hop: &CommandHop,
    host: &str,
    port: u16,
) -> Result<BoxStream, HopFailure> {
    let label = hop.label();
    let args = hop
        .args
        .iter()
        .map(|a| expand_placeholders(a, host, port))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| HopFailure::next(RouteErrorKind::Invalid, e))?;
    let mut command = Command::new(&hop.program);
    command
        .args(&args)
        .env_clear()
        .envs(
            KEPT_ENV
                .iter()
                .filter_map(|k| Some((*k, std::env::var_os(k)?))),
        )
        .envs(hop.env.iter().map(|(k, v)| (k.as_str(), v.expose())))
        .stderr(Stdio::piped());
    #[cfg(unix)]
    let ours = {
        let (ours, theirs) = std::os::unix::net::UnixStream::pair().map_err(|e| {
            HopFailure::here(
                RouteErrorKind::Connect,
                format!("{label}: no socket pair: {e}"),
            )
        })?;
        let stdin = theirs.try_clone().map_err(|e| {
            HopFailure::here(
                RouteErrorKind::Connect,
                format!("{label}: no socket pair: {e}"),
            )
        })?;
        command
            .stdin(Stdio::from(std::os::fd::OwnedFd::from(stdin)))
            .stdout(Stdio::from(std::os::fd::OwnedFd::from(theirs)));
        ours
    };
    #[cfg(not(unix))]
    command.stdin(Stdio::piped()).stdout(Stdio::piped());
    if let Some(cwd) = &hop.cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn().map_err(|e| {
        let message = if e.kind() == std::io::ErrorKind::NotFound {
            format!(
                "{} was not found: give an absolute path or a program on this machine's PATH",
                hop.program
            )
        } else {
            format!("{label} did not start: {e}")
        };
        HopFailure::here(RouteErrorKind::Connect, message)
    })?;
    // The command holds its own copies of the socket pair's other end; ours goes with the
    // stream. (`command` dropping at the end of this function closes the parent's copies.)
    drop(command);
    let Some(stderr) = child.stderr.take() else {
        let _ = child.kill();
        return Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!("{label} started without its stderr"),
        ));
    };
    #[cfg(not(unix))]
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        return Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!("{label} started without its stdio"),
        ));
    };
    let process = Arc::new(Process {
        child: Mutex::new(child),
        exited: Mutex::new(None),
    });

    // stderr: its last bytes, for the message.
    let tail = Arc::new(Mutex::new(Vec::new()));
    let stderr_done = {
        let tail = Arc::clone(&tail);
        let (done, done_rx) = oneshot::channel::<()>();
        std::thread::spawn(move || {
            let mut stderr = stderr;
            let mut buf = [0u8; 4096];
            while let Ok(n) = stderr.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let mut tail = lock(&tail);
                tail.extend_from_slice(&buf[..n]);
                let excess = tail.len().saturating_sub(STDERR_TAIL);
                tail.drain(..excess);
            }
            let _ = done.send(());
        });
        done_rx
    };
    let (exit_tx, mut exit_rx) = oneshot::channel::<ExitStatus>();
    watch(&process, exit_tx);

    #[cfg(unix)]
    {
        use tokio::io::AsyncReadExt;
        let _ = ours.set_nonblocking(true);
        let mut socket = tokio::net::UnixStream::from_std(ours)
            .map_err(|e| HopFailure::here(RouteErrorKind::Connect, format!("{label}: {e}")))?;
        let mut first = vec![0u8; CHUNK];
        let ended = tokio::select! {
            status = &mut exit_rx => status.ok(),
            read = socket.read(&mut first) => match read {
                Ok(n) if n > 0 => {
                    first.truncate(n);
                    None
                }
                // End of output: the exit status follows, briefly.
                _ => {
                    first.clear();
                    tokio::time::timeout(COMMAND_EARLY_EXIT, &mut exit_rx)
                        .await
                        .ok()
                        .and_then(Result::ok)
                }
            },
            () = tokio::time::sleep(COMMAND_EARLY_EXIT) => {
                first.clear();
                None
            }
        };
        if let Some(status) = ended {
            return Err(ended_early(&label, status, stderr_done, &tail).await);
        }
        let stream = crate::stream::Prefixed::boxed(first, Box::new(socket));
        return Ok(Box::new(ChildSocket {
            inner: stream,
            process: Some(process),
        }));
    }

    #[cfg(not(unix))]
    {
        // stdout: chunks to the stream; the channel closing is the end of output.
        let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_CHUNKS);
        std::thread::spawn(move || {
            let mut stdout = stdout;
            let mut buf = vec![0u8; CHUNK];
            while let Ok(n) = stdout.read(&mut buf) {
                if n == 0 || out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                    break;
                }
            }
        });
        // stdin: chunks from the stream; the channel closing closes the program's stdin.
        let (in_tx, mut in_rx) = mpsc::channel::<Vec<u8>>(CHANNEL_CHUNKS);
        std::thread::spawn(move || {
            let mut stdin = stdin;
            while let Some(chunk) = in_rx.blocking_recv() {
                if stdin
                    .write_all(&chunk)
                    .and_then(|()| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
        });
        // Watch it briefly: an ending program is the hop's error; a program that writes first (an
        // SSH banner) or keeps running is handed out.
        let mut first = Vec::new();
        let ended = tokio::select! {
            status = &mut exit_rx => status.ok(),
            chunk = out_rx.recv() => match chunk {
                Some(chunk) => {
                    first = chunk;
                    None
                }
                // End of output: the exit status follows, briefly.
                None => tokio::time::timeout(COMMAND_EARLY_EXIT, &mut exit_rx)
                    .await
                    .ok()
                    .and_then(Result::ok),
            },
            () = tokio::time::sleep(COMMAND_EARLY_EXIT) => None,
        };
        if let Some(status) = ended {
            return Err(ended_early(&label, status, stderr_done, &tail).await);
        }
        Ok(Box::new(ChildStream {
            pending: first,
            at: 0,
            out: out_rx,
            input: PollSender::new(in_tx),
            process: Some(process),
        }))
    }
}

/// The watcher: notes the exit status as soon as the program ends.
fn watch(process: &Arc<Process>, exit_tx: oneshot::Sender<ExitStatus>) {
    let process = Arc::clone(process);
    std::thread::spawn(move || {
        loop {
            let status = lock(&process.child).try_wait();
            match status {
                Ok(Some(status)) => {
                    *lock(&process.exited) = Some(status);
                    let _ = exit_tx.send(status);
                    return;
                }
                Ok(None) => std::thread::sleep(WATCH_EVERY),
                Err(_) => return,
            }
        }
    });
}

/// The error of a program that ended before its stream was handed out.
async fn ended_early(
    label: &str,
    status: ExitStatus,
    stderr_done: oneshot::Receiver<()>,
    tail: &Mutex<Vec<u8>>,
) -> HopFailure {
    let _ = tokio::time::timeout(Duration::from_millis(200), stderr_done).await;
    let stderr = lock(tail).clone();
    let code = match status.code() {
        Some(code) => format!("exit code {code}"),
        None => "a signal".to_owned(),
    };
    HopFailure::here(
        RouteErrorKind::Connect,
        format!(
            "{label} ended ({code}) before the stream was used{}",
            said(&stderr)
        ),
    )
}

/// Unix: the program's end of the socket pair; dropping it ends the program.
#[cfg(unix)]
struct ChildSocket {
    inner: BoxStream,
    process: Option<Arc<Process>>,
}

#[cfg(unix)]
impl AsyncRead for ChildSocket {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

#[cfg(unix)]
impl AsyncWrite for ChildSocket {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    /// Closes the program's stdin (the socket's write half).
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(unix)]
impl Drop for ChildSocket {
    fn drop(&mut self) {
        let Some(process) = self.process.take() else {
            return;
        };
        std::thread::spawn(move || end(&process));
    }
}

/// Windows: the program's stdout and stdin as one stream through the pipe threads; dropping it
/// ends the program.
#[cfg(not(unix))]
struct ChildStream {
    pending: Vec<u8>,
    at: usize,
    out: mpsc::Receiver<Vec<u8>>,
    input: PollSender<Vec<u8>>,
    process: Option<Arc<Process>>,
}

#[cfg(not(unix))]
impl AsyncRead for ChildStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.at >= self.pending.len() {
            match ready!(self.out.poll_recv(cx)) {
                Some(chunk) => {
                    self.pending = chunk;
                    self.at = 0;
                }
                None => return Poll::Ready(Ok(())),
            }
        }
        let n = buf.remaining().min(self.pending.len() - self.at);
        let at = self.at;
        buf.put_slice(&self.pending[at..at + n]);
        self.at += n;
        Poll::Ready(Ok(()))
    }
}

#[cfg(not(unix))]
impl AsyncWrite for ChildStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let broken = || std::io::Error::from(std::io::ErrorKind::BrokenPipe);
        ready!(self.input.poll_reserve(cx)).map_err(|_| broken())?;
        let n = buf.len().min(CHUNK);
        self.input
            .send_item(buf[..n].to_vec())
            .map_err(|_| broken())?;
        Poll::Ready(Ok(n))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    /// Closes the program's stdin.
    fn poll_shutdown(mut self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        self.input.close();
        Poll::Ready(Ok(()))
    }
}

#[cfg(not(unix))]
impl Drop for ChildStream {
    fn drop(&mut self) {
        self.input.close();
        let Some(process) = self.process.take() else {
            return;
        };
        std::thread::spawn(move || end(&process));
    }
}

/// Lets the program end on its closed stdin, then SIGTERM, then SIGKILL.
fn end(process: &Process) {
    let waited = |limit: Duration| {
        let deadline = std::time::Instant::now() + limit;
        while std::time::Instant::now() < deadline {
            if process.exited().is_some() {
                return true;
            }
            std::thread::sleep(WATCH_EVERY);
        }
        process.exited().is_some()
    };
    if waited(TERM_AFTER) {
        return;
    }
    if process.terminate() && waited(KILL_AFTER) {
        return;
    }
    process.kill();
}
