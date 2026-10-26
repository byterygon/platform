//! Server-side protocol engine (Ambidex spec §1, §3, §5).
//!
//! One [`Server`] serves any number of connections. Each connection runs as two tasks: the
//! connection task reads the transport, decodes frames, performs the Hello handshake and
//! dispatches calls concurrently; a writer task owns the sending half and drains a bounded queue
//! of encoded frames. The connection task never waits on the peer to read, so it always services
//! [`Connection::goaway`], incoming bytes and call completions. Everything that makes desktop and
//! web behave identically lives here, not in the transports.
//!
//! Rules enforced per connection:
//!
//! - The first frame must be `Hello` (call 0), at most [`ServerConfig::max_hello_bytes`], and the
//!   handshake including [`Authenticate`] must finish within [`ServerConfig::hello_timeout`].
//!   Protocol major, API name and schema hash must match exactly, otherwise `VersionMismatch`;
//!   then [`Authenticate`] decides, otherwise `Unauthenticated`. Either way the connection closes.
//!   After HelloAck the payload limit becomes [`ServerConfig::max_frame_bytes`].
//! - Frame-level violations (bad header, oversize payload, a frame kind the client may not send,
//!   a `Call` or `Subscribe` whose call id is not greater than every id used before on the
//!   connection, including 0) answer with `Error` on call 0 and close. Ids strictly increase, so a
//!   late `Cancel` can never reach a newer call (spec Open question 15).
//! - Per-call problems (undecodable `Call` payload, concurrency limit) answer with `Error` on that
//!   call id and keep the connection.
//! - `Ping` is answered with `Pong` echoing call id and payload.
//! - A peer that stops reading until [`ServerConfig::outbound_queue_frames`] frames are queued is
//!   disconnected ([`Closed::SlowConsumer`]).
//! - [`Connection::goaway`] sends `Goaway` and closes; a peer's `Goaway` closes without reply.
//!   Final frames (Goaway, a rejection, a violation) get at most [`ServerConfig::close_timeout`]
//!   to be delivered before the transport is dropped. Session revocation sends Goaway
//!   `Unauthenticated` and closes the same way ([`Closed::Revoked`]).
//! - Every call runs under a [`CallScope`] (spec §7, see [`crate::cancel`]): its token fires on a
//!   `Cancel` frame for the call, its deadline, session revocation ([`Authenticate::revocation`]),
//!   Goaway or disconnect. The call then gets [`ServerConfig::cancel_grace`] to stop before its
//!   future is dropped, and answers with one `Error` (`Cancelled` or `DeadlineExceeded`) while the
//!   connection is still open. A `Cancel` for a call id that is not in flight is ignored: the call
//!   already answered.
//! - When the connection closes for any reason, every call's token fires; calls get the same
//!   grace, their answers are discarded, and the rest are dropped.
//!
//! Subscriptions, streams and credits arrive with their own tasks and are rejected or ignored
//! here as noted below.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;

use security_types::Principal;

use crate::cancel::CallScope;
use crate::frame::{
    DEFAULT_MAX_FRAME_BYTES, Frame, FrameDecoder, FrameError, Kind, PROTOCOL_VERSION,
};
use crate::message::{Call, Code, ErrorPayload, Goaway, Hello, HelloAck, Limits};
use crate::transport::{TransportRx, TransportTx};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Server configuration.
#[derive(Debug, Clone)]
pub struct ServerConfig {
    /// API name the client must send in Hello (e.g. `"dbee"`).
    pub api: String,
    /// Schema hash from the generated manifest; must match the client's exactly (spec §10).
    pub schema_hash: String,
    pub server_version: String,
    /// Largest payload accepted from the client and sent to it, in bytes, once a session exists.
    pub max_frame_bytes: u32,
    /// Largest payload accepted before the handshake completes, so an unauthenticated peer
    /// cannot make the server reserve `max_frame_bytes`.
    pub max_hello_bytes: u32,
    /// Calls in flight per connection; further calls get `ResourceExhausted`.
    pub max_concurrent_calls: u32,
    /// Time allowed between connection start and a completed handshake, authentication included.
    pub hello_timeout: Duration,
    /// Encoded frames waiting for the peer to read. When full, the peer is disconnected.
    pub outbound_queue_frames: usize,
    /// Time allowed to deliver final frames (Goaway, rejections) before the transport is dropped.
    pub close_timeout: Duration,
    /// Time a call may keep running after its cancellation token fired (to stop cooperatively,
    /// e.g. send the database's cancel request) before its future is dropped.
    pub cancel_grace: Duration,
}

impl ServerConfig {
    /// Config with default limits. Every default except `max_frame_bytes` is provisional (spec
    /// Open questions 9 and 17; defaults are confirmed after the M2 benchmark).
    pub fn new(
        api: impl Into<String>,
        schema_hash: impl Into<String>,
        server_version: impl Into<String>,
    ) -> ServerConfig {
        ServerConfig {
            api: api.into(),
            schema_hash: schema_hash.into(),
            server_version: server_version.into(),
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_hello_bytes: 64 * 1024,
            max_concurrent_calls: 256,
            hello_timeout: Duration::from_secs(10),
            outbound_queue_frames: 64,
            close_timeout: Duration::from_millis(500),
            cancel_grace: Duration::from_secs(1),
        }
    }
}

/// An authenticated session.
///
/// `id` is what the server returns in HelloAck; it is not a credential. `principal` is who acts
/// on this connection, built by the [`Authenticate`] implementation (never from client input);
/// the router authorizes every call against it. Session lifetime, revocation and expiry land in M3.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    pub id: String,
    pub principal: Principal,
}

/// Decides whether a Hello is allowed to open a session.
///
/// There is deliberately no permissive default implementation: a server cannot be built without
/// choosing one.
pub trait Authenticate: Send + Sync + 'static {
    /// `None` rejects. The client only ever learns `Unauthenticated`, never the reason.
    fn authenticate<'a>(&'a self, hello: &'a Hello) -> BoxFuture<'a, Option<Session>>;

    /// A token that fires when `session` is revoked. The connection then cancels all its calls,
    /// sends Goaway `Unauthenticated` and closes. `None` (the default) means the session is never
    /// revoked while connected; session lifetime and revocation land in M3.
    fn revocation(&self, session: &Session) -> Option<CancellationToken> {
        let _ = session;
        None
    }
}

/// Executes calls. [`Router`](crate::Router) implements this.
///
/// The returned future runs with the call's [`CallScope`] as [`CallScope::current`]; a dispatcher
/// should apply the procedure's timeouts to it ([`CallScope::apply_timeouts`]) and hand its token
/// to the handler.
pub trait Dispatch: Send + Sync + 'static {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>>;
}

/// Why a connection ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Closed {
    /// The transport reached end of stream.
    PeerClosed,
    /// The peer sent Goaway.
    PeerGoaway(Goaway),
    /// This side sent Goaway through [`Connection::goaway`].
    Goaway(Goaway),
    /// The session was revoked ([`Authenticate::revocation`]); Goaway `Unauthenticated` was sent.
    Revoked,
    /// The handshake, authentication included, did not finish within the configured timeout.
    HelloTimeout,
    /// Hello was refused with this code (`VersionMismatch` or `Unauthenticated`).
    HandshakeRejected(Code),
    /// The peer broke the protocol; the code was sent to it in an Error frame.
    ProtocolViolation(Code),
    /// The peer stopped reading and the outbound queue filled up (`ResourceExhausted`).
    SlowConsumer,
    /// The transport failed.
    Transport(io::ErrorKind),
    /// The connection could not be set up (no OS randomness for its correlation-id prefix).
    Internal,
}

/// A protocol engine shared by all connections of one server.
pub struct Server<A, D> {
    inner: Arc<Inner<A, D>>,
}

struct Inner<A, D> {
    config: ServerConfig,
    auth: A,
    dispatch: Arc<D>,
}

impl<A: Authenticate, D: Dispatch> Server<A, D> {
    pub fn new(config: ServerConfig, auth: A, dispatch: D) -> Server<A, D> {
        Server {
            inner: Arc::new(Inner {
                config,
                auth,
                dispatch: Arc::new(dispatch),
            }),
        }
    }

    pub fn config(&self) -> &ServerConfig {
        &self.inner.config
    }

    /// Starts serving one connection on the current Tokio runtime.
    pub fn serve<R: TransportRx, T: TransportTx>(&self, rx: R, tx: T) -> Connection {
        let (control_tx, control_rx) = mpsc::channel(1);
        let inner = Arc::clone(&self.inner);
        Connection {
            control: control_tx,
            task: tokio::spawn(run(inner, rx, tx, control_rx)),
        }
    }
}

/// Handle to a running connection.
pub struct Connection {
    control: mpsc::Sender<Goaway>,
    task: JoinHandle<Closed>,
}

impl Connection {
    /// Asks the connection to send Goaway and close, cancelling every call on it. No-op if it
    /// already closed.
    pub async fn goaway(&self, code: Code, message: impl Into<String>) {
        let goaway = Goaway {
            code,
            message: message.into(),
        };
        let _ = self.control.send(goaway).await;
    }

    /// Waits for the connection to end.
    pub async fn closed(self) -> Closed {
        match self.task.await {
            Ok(closed) => closed,
            Err(err) if err.is_panic() => std::panic::resume_unwind(err.into_panic()),
            Err(_) => Closed::Transport(io::ErrorKind::Interrupted),
        }
    }
}

async fn run<A: Authenticate, D: Dispatch, R: TransportRx, T: TransportTx>(
    inner: Arc<Inner<A, D>>,
    mut rx: R,
    mut tx: T,
    mut control: mpsc::Receiver<Goaway>,
) -> Closed {
    // A random prefix keeps correlation ids unguessable and unique across connections and
    // restarts without revealing how many connections the server has seen.
    let Ok(prefix) = getrandom::u64() else {
        let _ = tx.close().await;
        return Closed::Internal;
    };
    let config = &inner.config;
    let (out, out_rx) = mpsc::channel(config.outbound_queue_frames.max(1));
    let mut writer = Writer {
        handle: tokio::spawn(write_loop(tx, out_rx)),
        finished: false,
    };
    let mut conn = ConnState {
        decoder: FrameDecoder::new(config.max_hello_bytes.min(config.max_frame_bytes)),
        hello_deadline: Instant::now() + config.hello_timeout,
        inner: Arc::clone(&inner),
        prefix,
        out,
        session: None,
        calls: JoinSet::new(),
        tasks: HashMap::new(),
        in_flight: HashMap::new(),
        conn_token: CancellationToken::new(),
        revoked: None,
        last_call_id: 0,
        close_by: None,
    };
    let closed = conn.run_loop(&mut rx, &mut control, &mut writer).await;
    let close_by = conn.close_deadline();
    // Every call's token fires. Calls get the grace period to stop; their answers are discarded.
    conn.conn_token.cancel();
    let calls = std::mem::take(&mut conn.calls);
    let drained = drain_calls(calls, config.cancel_grace);
    // Dropping the state drops the queue's only sender, so the writer delivers what is queued,
    // closes the transport and exits.
    drop(conn);
    if writer.finished {
        drained.await;
        return closed;
    }
    let (written, ()) = tokio::join!(
        tokio::time::timeout_at(close_by, &mut writer.handle),
        drained
    );
    match written {
        Ok(Ok(Err(err))) if matches!(closed, Closed::Transport(_)) => Closed::Transport(err.kind()),
        Ok(_) => closed,
        Err(_) => {
            // The peer is not reading; dropping the sending half closes the transport.
            writer.handle.abort();
            closed
        }
    }
}

struct Writer {
    handle: JoinHandle<io::Result<()>>,
    finished: bool,
}

/// Waits up to `grace` for cancelled calls to stop, then drops (aborts) the rest.
async fn drain_calls(mut calls: JoinSet<Frame>, grace: Duration) {
    let _ = tokio::time::timeout(grace, async { while calls.join_next().await.is_some() {} }).await;
}

/// Runs one call under its scope: the answer, or the cancellation reason once the token fires.
///
/// The deadline is re-read whenever the dispatcher moves it. Once the token has fired the answer
/// is the reason, whatever the call returns: it gets `grace` to finish cooperatively, and if it
/// has not finished by then its future is dropped.
async fn run_call(
    fut: impl Future<Output = Result<Value, ErrorPayload>>,
    scope: CallScope,
    grace: Duration,
) -> Result<Value, ErrorPayload> {
    let mut fut = std::pin::pin!(scope.clone().enter(fut));
    let finished = loop {
        let deadline = scope.deadline();
        tokio::select! {
            biased;
            result = &mut fut => break Some(result),
            () = scope.cancelled() => break None,
            () = tokio::time::sleep_until(deadline) => {
                if scope.deadline() <= deadline {
                    scope.fire(Code::DeadlineExceeded);
                    break None;
                }
            }
            () = scope.deadline_changed() => {}
        }
    };
    match finished {
        // A handler that reacts to its token can finish in the poll that observed it; that
        // answer is discarded too, so a Cancel that reached the call always wins.
        Some(result) if !scope.is_cancelled() => return result,
        Some(_) => {}
        None => {
            let _ = tokio::time::timeout(grace, &mut fut).await;
        }
    }
    Err(match scope.reason() {
        Some(Code::DeadlineExceeded) => {
            ErrorPayload::new(Code::DeadlineExceeded, "deadline exceeded")
        }
        _ => ErrorPayload::new(Code::Cancelled, "call cancelled"),
    })
}

/// Resolves when `token` fires; never when there is none.
async fn revoked(token: Option<CancellationToken>) {
    match token {
        Some(token) => token.cancelled_owned().await,
        None => std::future::pending().await,
    }
}

async fn write_loop<T: TransportTx>(
    mut tx: T,
    mut queue: mpsc::Receiver<Vec<u8>>,
) -> io::Result<()> {
    while let Some(bytes) = queue.recv().await {
        tx.send(bytes).await?;
    }
    tx.close().await
}

struct ConnState<A, D> {
    inner: Arc<Inner<A, D>>,
    /// Random per-connection prefix of correlation ids.
    prefix: u64,
    /// Encoded frames for the writer task.
    out: mpsc::Sender<Vec<u8>>,
    decoder: FrameDecoder,
    hello_deadline: Instant,
    session: Option<Arc<Session>>,
    calls: JoinSet<Frame>,
    /// Call id of each running call task.
    tasks: HashMap<tokio::task::Id, u32>,
    /// Scope of each call in flight, by call id.
    in_flight: HashMap<u32, CallScope>,
    /// Parent of every call token; fires when the connection closes.
    conn_token: CancellationToken,
    /// Fires when the session is revoked.
    revoked: Option<CancellationToken>,
    /// Highest call id used on this connection; new calls must use a higher one.
    last_call_id: u32,
    /// Set when the connection starts closing; bounds delivery of the final frames.
    close_by: Option<Instant>,
}

/// Control flow out of frame handling.
type Step = Result<(), Closed>;

impl<A: Authenticate, D: Dispatch> ConnState<A, D> {
    async fn run_loop<R: TransportRx>(
        &mut self,
        rx: &mut R,
        control: &mut mpsc::Receiver<Goaway>,
        writer: &mut Writer,
    ) -> Closed {
        loop {
            if let Err(closed) = self.drain_frames().await {
                return closed;
            }
            tokio::select! {
                biased;
                Some(goaway) = control.recv() => {
                    self.send_final(Kind::Goaway, 0, &goaway).await;
                    return Closed::Goaway(goaway);
                }
                () = revoked(self.revoked.clone()) => {
                    let goaway = Goaway {
                        code: Code::Unauthenticated,
                        message: "session revoked".into(),
                    };
                    self.send_final(Kind::Goaway, 0, &goaway).await;
                    return Closed::Revoked;
                }
                () = tokio::time::sleep_until(self.hello_deadline), if self.session.is_none() => {
                    return Closed::HelloTimeout;
                }
                done = &mut writer.handle, if !writer.finished => {
                    writer.finished = true;
                    // The writer only stops early when the transport failed.
                    return match done {
                        Ok(Err(err)) => Closed::Transport(err.kind()),
                        _ => Closed::Transport(io::ErrorKind::BrokenPipe),
                    };
                }
                Some(done) = self.calls.join_next_with_id(), if !self.calls.is_empty() => {
                    if let Err(closed) = self.finish_call(done) {
                        return closed;
                    }
                }
                chunk = rx.recv() => match chunk {
                    Ok(Some(bytes)) => self.decoder.push(&bytes),
                    Ok(None) => return Closed::PeerClosed,
                    Err(err) => return Closed::Transport(err.kind()),
                },
            }
        }
    }

    async fn drain_frames(&mut self) -> Step {
        loop {
            match self.decoder.next_frame() {
                Ok(Some(frame)) => self.on_frame(frame).await?,
                Ok(None) => return Ok(()),
                Err(err) => {
                    let code = match err {
                        FrameError::UnsupportedVersion(_) => Code::VersionMismatch,
                        FrameError::PayloadTooLarge { .. } => Code::ResourceExhausted,
                        FrameError::UnknownKind(_) | FrameError::UnsupportedFlags(_) => {
                            Code::InvalidArgument
                        }
                    };
                    return Err(self.violation(code, err.to_string()).await);
                }
            }
        }
    }

    async fn on_frame(&mut self, frame: Frame) -> Step {
        let Some(session) = self.session.clone() else {
            return self.on_hello(frame).await;
        };
        match frame.kind {
            Kind::Call => self.on_call(session, frame).await,
            Kind::Ping => {
                let pong = Frame {
                    kind: Kind::Pong,
                    ..frame
                };
                self.send(&pong)
            }
            Kind::Goaway => {
                let goaway = serde_json::from_slice(&frame.payload).unwrap_or(Goaway {
                    code: Code::Unavailable,
                    message: String::new(),
                });
                Err(Closed::PeerGoaway(goaway))
            }
            // No server-initiated pings yet, so a Pong needs no bookkeeping.
            Kind::Pong => Ok(()),
            Kind::Cancel => {
                if frame.call_id == 0 {
                    return Err(self
                        .violation(Code::InvalidArgument, "Cancel on call id 0")
                        .await);
                }
                // A call that is no longer in flight already answered; its Cancel lost the race.
                if let Some(scope) = self.in_flight.get(&frame.call_id) {
                    scope.cancel();
                }
                Ok(())
            }
            // Credit: binary streams (M2). Unsubscribe: subscriptions. Until those land there is
            // nothing to credit or unsubscribe, so these are no-ops.
            Kind::Credit | Kind::Unsubscribe => Ok(()),
            Kind::Subscribe => {
                if !self.claim_call_id(frame.call_id) {
                    return Err(self
                        .violation(Code::InvalidArgument, "call id not increasing")
                        .await);
                }
                let err = ErrorPayload::new(Code::Unimplemented, "subscriptions are not supported");
                self.send_error(frame.call_id, err)
            }
            Kind::Hello => Err(self
                .violation(Code::FailedPrecondition, "duplicate Hello")
                .await),
            Kind::HelloAck
            | Kind::Result
            | Kind::Error
            | Kind::Chunk
            | Kind::StreamEnd
            | Kind::Event => Err(self
                .violation(Code::InvalidArgument, "frame kind not allowed from client")
                .await),
        }
    }

    async fn on_hello(&mut self, frame: Frame) -> Step {
        if frame.kind != Kind::Hello {
            return Err(self
                .violation(Code::Unauthenticated, "Hello required")
                .await);
        }
        if frame.call_id != 0 || frame.flags.is_binary() {
            return Err(self
                .violation(Code::InvalidArgument, "malformed Hello")
                .await);
        }
        let Ok(hello) = serde_json::from_slice::<Hello>(&frame.payload) else {
            return Err(self
                .violation(Code::InvalidArgument, "malformed Hello")
                .await);
        };
        let config = &self.inner.config;
        // Messages stay generic: the peer is not authenticated yet, so it learns nothing about
        // which field differed or what the server runs.
        if hello.protocol != PROTOCOL_VERSION
            || hello.api != config.api
            || hello.schema_hash != config.schema_hash
        {
            return Err(self
                .reject(Code::VersionMismatch, "client and server versions differ")
                .await);
        }
        // Authentication shares the handshake deadline, so a slow or hung implementation cannot
        // hold the connection open.
        let authenticated =
            tokio::time::timeout_at(self.hello_deadline, self.inner.auth.authenticate(&hello))
                .await;
        let session = match authenticated {
            Err(_) => return Err(Closed::HelloTimeout),
            Ok(None) => {
                return Err(self
                    .reject(Code::Unauthenticated, "authentication failed")
                    .await);
            }
            Ok(Some(session)) => session,
        };
        let revocation = self.inner.auth.revocation(&session);
        if revocation
            .as_ref()
            .is_some_and(CancellationToken::is_cancelled)
        {
            return Err(self
                .reject(Code::Unauthenticated, "authentication failed")
                .await);
        }
        self.revoked = revocation;
        let config = &self.inner.config;
        let ack = HelloAck {
            session: session.id.clone(),
            limits: Limits {
                max_frame_bytes: config.max_frame_bytes,
                max_concurrent_calls: config.max_concurrent_calls,
            },
            server_version: config.server_version.clone(),
        };
        self.decoder.set_max_payload(config.max_frame_bytes);
        self.session = Some(Arc::new(session));
        self.send_json(Kind::HelloAck, 0, &ack)
    }

    async fn on_call(&mut self, session: Arc<Session>, frame: Frame) -> Step {
        let call_id = frame.call_id;
        if !self.claim_call_id(call_id) {
            return Err(self
                .violation(Code::InvalidArgument, "call id not increasing")
                .await);
        }
        if self.in_flight.len() >= self.inner.config.max_concurrent_calls as usize {
            let mut err = ErrorPayload::new(Code::ResourceExhausted, "too many concurrent calls");
            err.retryable = true;
            return self.send_error(call_id, err);
        }
        if frame.flags.is_binary() {
            let err = ErrorPayload::new(Code::InvalidArgument, "Call payload must be JSON");
            return self.send_error(call_id, err);
        }
        let call = match serde_json::from_slice::<Call>(&frame.payload) {
            Ok(call) => call,
            Err(_) => {
                let err = ErrorPayload::new(Code::InvalidArgument, "malformed Call payload");
                return self.send_error(call_id, err);
            }
        };
        // The deadline runs from here; the dispatcher narrows it to the procedure's bounds.
        let scope = CallScope::with_token(self.conn_token.child_token(), call.timeout());
        let fut = self.inner.dispatch.call(session, call);
        let correlation_id = self.correlation_id(call_id);
        let config = &self.inner.config;
        let (max, grace) = (config.max_frame_bytes, config.cancel_grace);
        let task_scope = scope.clone();
        let handle = self.calls.spawn(async move {
            let result = run_call(fut, task_scope, grace).await;
            result_frame(call_id, result, correlation_id, max)
        });
        self.tasks.insert(handle.id(), call_id);
        self.in_flight.insert(call_id, scope);
        Ok(())
    }

    /// Sends the one terminal frame of a finished call task.
    fn finish_call(
        &mut self,
        done: Result<(tokio::task::Id, Frame), tokio::task::JoinError>,
    ) -> Step {
        match done {
            Ok((task, frame)) => {
                if let Some(call_id) = self.tasks.remove(&task) {
                    self.in_flight.remove(&call_id);
                }
                self.send(&frame)
            }
            Err(err) => {
                let call_id = self.tasks.remove(&err.id()).unwrap_or(0);
                self.in_flight.remove(&call_id);
                // A panicking handler must not take the connection down or leak its message.
                let mut payload = ErrorPayload::new(Code::Internal, "internal error");
                payload.correlation_id = self.correlation_id(call_id);
                self.send_error(call_id, payload)
            }
        }
    }

    /// Accepts `call_id` for a new call if it is greater than every id used so far (so never 0).
    fn claim_call_id(&mut self, call_id: u32) -> bool {
        let fresh = call_id > self.last_call_id;
        if fresh {
            self.last_call_id = call_id;
        }
        fresh
    }

    fn correlation_id(&self, call_id: u32) -> String {
        format!("{:016x}-{:x}", self.prefix, call_id)
    }

    fn close_deadline(&mut self) -> Instant {
        let close_timeout = self.inner.config.close_timeout;
        *self
            .close_by
            .get_or_insert_with(|| Instant::now() + close_timeout)
    }

    /// Sends a handshake rejection on call 0. The caller closes the connection.
    async fn reject(&mut self, code: Code, message: &str) -> Closed {
        self.send_final(Kind::Error, 0, &ErrorPayload::new(code, message))
            .await;
        Closed::HandshakeRejected(code)
    }

    /// Reports a protocol violation on call 0. The caller closes the connection.
    async fn violation(&mut self, code: Code, message: impl Into<String>) -> Closed {
        self.send_final(Kind::Error, 0, &ErrorPayload::new(code, message))
            .await;
        Closed::ProtocolViolation(code)
    }

    /// Queues the last frame before closing, waiting for queue space until the close deadline.
    /// Delivery is best effort: the connection closes either way.
    async fn send_final<M: Serialize>(&mut self, kind: Kind, call_id: u32, msg: &M) {
        let payload = serde_json::to_vec(msg).expect("control messages serialize");
        let Ok(bytes) =
            Frame::new(kind, call_id, payload).encode(self.inner.config.max_frame_bytes)
        else {
            return;
        };
        let close_by = self.close_deadline();
        let _ = tokio::time::timeout_at(close_by, self.out.send(bytes)).await;
    }

    fn send_error(&mut self, call_id: u32, mut err: ErrorPayload) -> Step {
        if err.correlation_id.is_empty() && call_id != 0 {
            err.correlation_id = self.correlation_id(call_id);
        }
        self.send_json(Kind::Error, call_id, &err)
    }

    fn send_json<M: Serialize>(&mut self, kind: Kind, call_id: u32, msg: &M) -> Step {
        let payload = serde_json::to_vec(msg).expect("control messages serialize");
        self.send(&Frame::new(kind, call_id, payload))
    }

    /// Queues a frame for the writer without waiting. A full queue means the peer is not reading.
    fn send(&mut self, frame: &Frame) -> Step {
        // Frames built here are bounded by construction (result_frame checks the only
        // unbounded payload), so an encode error is a bug, not a peer fault.
        let bytes = frame
            .encode(self.inner.config.max_frame_bytes)
            .map_err(|_| Closed::Transport(io::ErrorKind::InvalidData))?;
        self.out.try_send(bytes).map_err(|err| match err {
            TrySendError::Full(_) => Closed::SlowConsumer,
            TrySendError::Closed(_) => Closed::Transport(io::ErrorKind::BrokenPipe),
        })
    }
}

/// Builds the Result or Error frame for a finished call.
fn result_frame(
    call_id: u32,
    result: Result<Value, ErrorPayload>,
    correlation_id: String,
    max_payload: u32,
) -> Frame {
    let error = match result.map(|value| serde_json::to_vec(&value)) {
        Ok(Ok(payload)) if payload.len() <= max_payload as usize => {
            return Frame::new(Kind::Result, call_id, payload);
        }
        Ok(Ok(_)) => ErrorPayload::new(
            Code::ResourceExhausted,
            "result exceeds the frame size limit",
        ),
        Ok(Err(_)) => ErrorPayload::new(Code::Internal, "internal error"),
        Err(err) => err,
    };
    let mut error = error;
    if error.correlation_id.is_empty() {
        error.correlation_id = correlation_id;
    }
    let mut payload = serde_json::to_vec(&error).expect("ErrorPayload serializes");
    if payload.len() > max_payload as usize {
        // A handler's details or message can exceed the limit too; drop them rather than fail.
        let fallback = ErrorPayload {
            code: error.code,
            message: "error exceeds the frame size limit".into(),
            details: None,
            retryable: error.retryable,
            correlation_id: error.correlation_id,
        };
        payload = serde_json::to_vec(&fallback).expect("ErrorPayload serializes");
    }
    Frame::new(Kind::Error, call_id, payload)
}
