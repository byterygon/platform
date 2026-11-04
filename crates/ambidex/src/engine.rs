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
//! - A call's audit completion (registered by the router after the admission entry, see
//!   [`crate::audit`]) travels with its answer frame: the handler's answer, the cancellation
//!   reason, or `ResourceExhausted` for an answer too large for a frame. It is written in the
//!   background once the transport accepted the frame, with what that frame stands for; a frame
//!   dropped before that (Unsubscribe, close, a send error) records `Cancelled`. The answer
//!   never waits for the write. The writes are tracked per connection, at most
//!   `max_concurrent_calls` owed or running at once: when none is free a new call waits for
//!   room (still counted against `max_concurrent_calls`) while the connection keeps reading and
//!   handling the client's other frames, and [`Connection::closed`] resolves only once every
//!   write ended, each by its own write timeout (see [`crate::audit`]).
//!   Handshake rejections and protocol violations (call 0) carry a correlation id from the
//!   shared generator.
//! - `Subscribe` starts a subscription (see [`crate::subscription`]): admitted like a `Call` (same
//!   payload, call id rule and `max_concurrent_calls` slot), run through
//!   [`Dispatch::subscribe`] under its own [`CallScope`], which has no default deadline: only the
//!   client's `timeout_ms` and the procedure's declared maximum bound it (spec Open question
//!   24f). Its `Event` frames and its one terminal frame leave in order through a
//!   per-connection queue that may use at most half of the outbound queue, so a busy
//!   subscription cannot crowd out call answers and get a reading
//!   client disconnected as a slow consumer. Events count against their subscription's buffer
//!   until the writer hands them to the transport. `Unsubscribe` gets no reply: the frames still
//!   waiting in the engine (events, and the end if the handler already returned) are discarded,
//!   nothing more is queued for its id, and its token fires (the handler gets the grace period).
//!   Frames already in the outbound queue are in flight; the client drops them. `Unsubscribe` on call 0 is a violation; for an id that is no
//!   subscription in flight it is ignored.
//!
//! Streams and credits are M2: a stream procedure called with `Call` is authorized, then answered
//! with `Unimplemented`, and `Credit` frames are ignored.

use std::collections::{HashMap, HashSet, VecDeque};
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

use security_types::{Delivery, Principal};

use crate::audit::{Armed, Completions, Room, Rooms, code_name, delivery_for};
use crate::cancel::{CallScope, DeadlineClock, Start, TokioClock, deadline_at};
use crate::frame::{
    DEFAULT_MAX_FRAME_BYTES, Frame, FrameDecoder, FrameError, Kind, PROTOCOL_VERSION,
};
use crate::message::{
    Call, Code, ErrorPayload, Goaway, Hello, HelloAck, Limits, MAX_JSON_SAFE_INTEGER,
};
use crate::procedure::ProcedureKind;
use crate::subscription::{Events, Held, Queued};
use crate::transport::{TransportRx, TransportTx};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The smallest outbound queue the engine runs with: one slot for subscription frames, one kept
/// free for call answers.
pub const MIN_OUTBOUND_QUEUE_FRAMES: usize = 2;

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
    /// Subscription frames may use at most half of it, so call answers keep room; values below
    /// [`MIN_OUTBOUND_QUEUE_FRAMES`] are raised to it (with one slot, an event could take the
    /// only one and the next call answer would disconnect a peer that is reading).
    pub outbound_queue_frames: usize,
    /// Time allowed to deliver final frames (Goaway, rejections) before the transport is dropped.
    pub close_timeout: Duration,
    /// Time a call may keep running after its cancellation token fired (to stop cooperatively,
    /// e.g. send the database's cancel request) before its future is dropped. Advertised to the
    /// client as `HelloAck.limits.cancel_grace_ms`.
    pub cancel_grace: Duration,
    /// Events one subscription may have waiting for the transport, counting those in the
    /// outbound queue until the writer hands them over. One more ends the subscription with
    /// `ResourceExhausted` (see [`crate::subscription`]).
    pub subscription_buffer_events: usize,
    /// Payload bytes one subscription may have waiting for the transport, counted like
    /// `subscription_buffer_events`. An event that does not fit ends the subscription with
    /// `ResourceExhausted`; one event up to `max_frame_bytes` always fits an empty buffer.
    pub subscription_buffer_bytes: usize,
    /// The clock call and subscription deadlines are measured on (see [`crate::cancel`]).
    /// Default [`TokioClock`]; tests may supply one they move by hand. Grace periods, audit
    /// durations and write timeouts, and the handshake and close timeouts always use Tokio's
    /// timer.
    pub deadline_clock: Arc<dyn DeadlineClock>,
    /// Holds the writer before each send (tests only).
    #[cfg(feature = "test-hooks")]
    pub writer_gate: Option<WriterGate>,
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
            subscription_buffer_events: 64,
            subscription_buffer_bytes: 1024 * 1024,
            deadline_clock: Arc::new(TokioClock),
            #[cfg(feature = "test-hooks")]
            writer_gate: None,
        }
    }

    /// The outbound queue size the engine uses: `outbound_queue_frames`, at least
    /// [`MIN_OUTBOUND_QUEUE_FRAMES`].
    fn outbound_frames(&self) -> usize {
        self.outbound_queue_frames.max(MIN_OUTBOUND_QUEUE_FRAMES)
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

/// Executes calls and subscriptions. [`Router`](crate::Router) implements this.
///
/// The returned futures run with the call's [`CallScope`] as [`CallScope::current`]; a dispatcher
/// should apply the procedure's timeouts to it ([`CallScope::apply_timeouts`]) and hand its token
/// to the handler. A wrapper must forward both methods: `subscribe` has a default (answering
/// `Unimplemented`, as before subscriptions existed) so dispatchers that only serve calls keep
/// compiling, which also means a wrapper that forgets it silently turns subscriptions off.
pub trait Dispatch: Send + Sync + 'static {
    /// A `Call`: the result, or the error, of a query, mutation or stream.
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>>;

    /// A `Subscribe` (payload as for a `Call`): sends events to `events` until it ends. `Ok(())`
    /// ends the subscription with `Result` (payload `null`), an error with `Error`. The default
    /// answers `Unimplemented`; [`Router`](crate::Router) overrides it.
    fn subscribe(
        &self,
        session: Arc<Session>,
        call: Call,
        events: Events,
    ) -> BoxFuture<'static, Result<(), ErrorPayload>> {
        let _ = (session, call, events);
        Box::pin(async {
            Err(ErrorPayload::new(
                Code::Unimplemented,
                "subscriptions are not supported",
            ))
        })
    }
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
    let (out, out_rx) = mpsc::channel(config.outbound_frames());
    let (events_tx, events_rx) = mpsc::unbounded_channel();
    let mut writer = Writer {
        handle: tokio::spawn(write_loop(tx, out_rx, WriterHook::of(config))),
        finished: false,
    };
    let completions = Completions::new();
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
        subscriptions: HashSet::new(),
        events_tx,
        events_rx,
        ordered: VecDeque::new(),
        conn_token: CancellationToken::new(),
        revoked: None,
        last_call_id: 0,
        close_by: None,
        completions: completions.clone(),
        rooms: Rooms::new(config.max_concurrent_calls as usize),
        waiting: VecDeque::new(),
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
    let closed = if writer.finished {
        drained.await;
        closed
    } else {
        let (written, ()) = tokio::join!(
            tokio::time::timeout_at(close_by, &mut writer.handle),
            drained
        );
        match written {
            Ok(Ok(Err(err))) if matches!(closed, Closed::Transport(_)) => {
                Closed::Transport(err.kind())
            }
            Ok(_) => closed,
            Err(_) => {
                // The peer is not reading; dropping the sending half closes the transport. Its
                // queued answers are dropped with it, and complete as `Cancelled`.
                writer.handle.abort();
                let _ = (&mut writer.handle).await;
                closed
            }
        }
    };
    // Every completion of this connection is written, or reported lost, before it counts as
    // closed: at most the write timeout after the last one started.
    completions.close().await;
    closed
}

struct Writer {
    handle: JoinHandle<io::Result<()>>,
    finished: bool,
}

/// Waits up to `grace` for cancelled calls to stop, then drops (aborts) the rest.
async fn drain_calls(mut calls: JoinSet<Answer>, grace: Duration) {
    let _ = tokio::time::timeout(grace, async { while calls.join_next().await.is_some() {} }).await;
}

/// Runs one call under its scope: the answer, or the cancellation reason once the token fires.
///
/// The deadline is re-read whenever the dispatcher moves it; without one (a subscription with no
/// client timeout and no declared maximum) only the token ends the call. Once the token has fired
/// the answer is the reason, whatever the call returns: it gets `grace` to finish cooperatively,
/// and if it has not finished by then its future is dropped.
async fn run_call(
    fut: impl Future<Output = Result<Value, ErrorPayload>>,
    scope: CallScope,
    grace: Duration,
) -> Finished {
    // A call cancelled or out of time before its task first ran never starts: `fut` is dropped
    // unpolled, so the handler has no side effects.
    if let Some(reason) = scope.check() {
        return Finished::replaced(&scope, reason);
    }
    let mut fut = std::pin::pin!(scope.clone().enter(fut));
    let finished = loop {
        let deadline = scope.deadline();
        tokio::select! {
            biased;
            result = &mut fut => break Some(result),
            () = scope.cancelled() => break None,
            () = scope.reached(deadline) => {
                // It passed, unless the dispatcher moved it later (or removed it) meanwhile.
                if scope
                    .deadline()
                    .zip(deadline)
                    .is_some_and(|(current, reached)| current <= reached)
                {
                    scope.fire(Code::DeadlineExceeded);
                    break None;
                }
            }
            () = scope.deadline_changed() => {}
        }
    };
    match finished {
        Some(result) => {
            // The handler is polled first, so it can finish after its deadline has passed (a zero
            // timeout, or a task first polled late): that answer is too late. `fire` keeps the
            // first reason, so a Cancel that already fired still wins.
            // A handler that reacts to its token can finish in the poll that observed it; that
            // answer is discarded too, so a Cancel that reached the call always wins.
            let Some(reason) = scope.check() else {
                return Finished {
                    result,
                    replaced_by: None,
                };
            };
            Finished::replaced(&scope, reason)
        }
        None => {
            let _ = tokio::time::timeout(grace, &mut fut).await;
            Finished::replaced(&scope, scope.reason().unwrap_or(Code::Cancelled))
        }
    }
}

/// How a call ended, as the engine answers it.
struct Finished {
    result: Result<Value, ErrorPayload>,
    /// The reason the token fired, when it replaced the dispatcher's answer.
    replaced_by: Option<Code>,
}

impl Finished {
    fn replaced(scope: &CallScope, reason: Code) -> Finished {
        Finished {
            result: Err(scope.error()),
            replaced_by: Some(reason),
        }
    }
}

/// Waits until `out` has at least `slots` free slots; `false` once the writer is gone. The
/// reservation is released at once: the caller is the queue's only sender.
async fn has_room(out: &mpsc::Sender<Outbound>, slots: usize) -> bool {
    out.reserve_many(slots).await.is_ok()
}

/// Resolves when `token` fires; never when there is none.
async fn revoked(token: Option<CancellationToken>) {
    match token {
        Some(token) => token.cancelled_owned().await,
        None => std::future::pending().await,
    }
}

/// An encoded frame for the writer. An event frame carries its share of its subscription's
/// buffer, so the event counts against the buffer until the transport has taken it. A call's
/// answer frame carries the call's audit completion, written once the transport has taken it;
/// dropped anywhere before that, the completion records `Cancelled`.
struct Outbound {
    bytes: Vec<u8>,
    held: Option<Held>,
    completion: Option<Armed>,
}

impl From<Vec<u8>> for Outbound {
    fn from(bytes: Vec<u8>) -> Outbound {
        Outbound {
            bytes,
            held: None,
            completion: None,
        }
    }
}

async fn write_loop<T: TransportTx>(
    mut tx: T,
    mut queue: mpsc::Receiver<Outbound>,
    hook: WriterHook,
) -> io::Result<()> {
    while let Some(Outbound {
        bytes,
        held,
        completion,
    }) = queue.recv().await
    {
        hook.before_send().await;
        // On a send error the frame did not go out: `completion` drops here, as `Cancelled`.
        tx.send(bytes).await?;
        drop(held);
        // Delivered means the transport accepted the frame (Open question 26 item 11b). The
        // write runs on its own task, so this loop never waits on the sink.
        if let Some(completion) = completion {
            completion.sent();
        }
    }
    tx.close().await
}

/// What the writer does before each send: nothing, unless a test holds it
/// ([`ServerConfig::writer_gate`], feature `test-hooks`).
struct WriterHook {
    #[cfg(feature = "test-hooks")]
    gate: Option<WriterGate>,
}

impl WriterHook {
    #[cfg_attr(not(feature = "test-hooks"), allow(unused_variables))]
    fn of(config: &ServerConfig) -> WriterHook {
        WriterHook {
            #[cfg(feature = "test-hooks")]
            gate: config.writer_gate.clone(),
        }
    }

    async fn before_send(&self) {
        #[cfg(feature = "test-hooks")]
        if let Some(gate) = &self.gate {
            gate.pass().await;
        }
    }
}

/// Holds a connection's writer before each send, as a transport that does not accept frames
/// would: the frame is not handed to the transport until the gate opens, and the frames behind it
/// stay queued. For conformance tests of what the audit records about frames that were chosen
/// but not sent (spec Open question 26 item 11); production servers never set it.
#[cfg(feature = "test-hooks")]
#[derive(Debug, Clone)]
pub struct WriterGate {
    open: Arc<tokio::sync::watch::Sender<bool>>,
    waiting: Arc<std::sync::atomic::AtomicUsize>,
}

#[cfg(feature = "test-hooks")]
impl Default for WriterGate {
    fn default() -> WriterGate {
        WriterGate {
            open: Arc::new(tokio::sync::watch::channel(true).0),
            waiting: Arc::default(),
        }
    }
}

#[cfg(feature = "test-hooks")]
impl WriterGate {
    /// An open gate.
    pub fn new() -> WriterGate {
        WriterGate::default()
    }

    /// Holds every later send until [`WriterGate::open`].
    pub fn close(&self) {
        self.open.send_replace(false);
    }

    pub fn open(&self) {
        self.open.send_replace(true);
    }

    /// Writers holding a frame at the gate right now.
    pub fn waiting(&self) -> usize {
        self.waiting.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn pass(&self) {
        let mut open = self.open.subscribe();
        if *open.borrow_and_update() {
            return;
        }
        self.waiting
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let _ = open.wait_for(|open| *open).await;
        self.waiting
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

/// What a call task ends with: its terminal frame, and its audit completion if it was admitted.
struct Answer {
    frame: Frame,
    completion: Option<Armed>,
}

/// A running call task, by task id.
struct Task {
    call_id: u32,
    subscription: bool,
}

/// A subscription frame waiting for room in the outbound queue, in order.
enum Ordered {
    Event(Queued),
    /// The subscription's terminal Result or Error, with its audit completion.
    End(Box<Answer>),
}

impl Ordered {
    fn call_id(&self) -> u32 {
        match self {
            Ordered::Event(queued) => queued.call_id,
            Ordered::End(end) => end.frame.call_id,
        }
    }
}

struct ConnState<A, D> {
    inner: Arc<Inner<A, D>>,
    /// Random per-connection prefix of correlation ids.
    prefix: u64,
    /// Encoded frames for the writer task.
    out: mpsc::Sender<Outbound>,
    decoder: FrameDecoder,
    hello_deadline: Instant,
    session: Option<Arc<Session>>,
    calls: JoinSet<Answer>,
    /// Call id of each running call or subscription task.
    tasks: HashMap<tokio::task::Id, Task>,
    /// Scope of each call and subscription in flight, by call id.
    in_flight: HashMap<u32, CallScope>,
    /// Subscriptions whose frames are still sent: in flight and not unsubscribed.
    subscriptions: HashSet<u32>,
    /// Handed to every subscription's [`Events`]; events arrive on `events_rx`.
    events_tx: mpsc::UnboundedSender<Queued>,
    events_rx: mpsc::UnboundedReceiver<Queued>,
    /// Subscription frames (events, then their terminal frame) waiting for outbound room.
    ordered: VecDeque<Ordered>,
    /// Parent of every call token; fires when the connection closes.
    conn_token: CancellationToken,
    /// Fires when the session is revoked.
    revoked: Option<CancellationToken>,
    /// Highest call id used on this connection; new calls must use a higher one.
    last_call_id: u32,
    /// Set when the connection starts closing; bounds delivery of the final frames.
    close_by: Option<Instant>,
    /// The connection's audit completion writes (Open question 26 item 11).
    completions: Completions,
    /// Room for `max_concurrent_calls` completions owed or being written on this connection.
    rooms: Rooms,
    /// Calls received and checked, waiting in order for room (see [`ConnState::on_call_frame`]).
    /// Other client frames are still read and handled meanwhile.
    waiting: VecDeque<Received>,
}

/// A `Call` or `Subscribe` the connection accepted (id claimed, payload decoded) and has not
/// started yet.
struct Received {
    call_id: u32,
    subscribe: bool,
    call: Call,
    session: Arc<Session>,
    /// When the frame was read: the call's deadline and duration run from here (spec §7).
    at: Start,
    /// When it ends if it is still waiting, on the deadline clock: the deadline its scope would
    /// start with (the engine's default bounds for its kind; the procedure's own apply once it
    /// starts). `None` for a subscription without a client timeout (spec Open question 24f).
    deadline: Option<Instant>,
}

impl Received {
    /// The kind whose default bounds the call starts with: any call kind for `Call` (they share
    /// them), or a subscription.
    fn kind(&self) -> ProcedureKind {
        if self.subscribe {
            ProcedureKind::Subscription
        } else {
            ProcedureKind::Query
        }
    }
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
        // Subscription frames leave only while this many outbound slots stay free, so call
        // answers (sent without waiting) always find room while the peer reads.
        let headroom = self.inner.config.outbound_frames() / 2;
        let rooms = self.rooms.clone();
        loop {
            if let Err(closed) = self.drain_frames().await {
                return closed;
            }
            // The earliest deadline of a call waiting for room, on the deadline clock. None
            // while none waits, or while every waiting one is a subscription without deadline.
            let expiry = self.waiting.iter().filter_map(|w| w.deadline).min();
            let clock = Arc::clone(&self.inner.config.deadline_clock);
            let expired = async move {
                match expiry {
                    Some(at) => clock.sleep_until(at).await,
                    None => std::future::pending().await,
                }
            };
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
                // A waiting call whose deadline passed ends without running.
                () = expired, if expiry.is_some() => {
                    if let Err(closed) = self.expire_waiting() {
                        return closed;
                    }
                }
                // The oldest call waiting for room starts once a completion was written.
                room = rooms.take(), if !self.waiting.is_empty() => {
                    if let Some(received) = self.waiting.pop_front() {
                        self.start(received, room);
                    }
                }
                // Client frames come before more subscription output, so a busy subscription
                // cannot delay its own Cancel or Unsubscribe.
                chunk = rx.recv() => match chunk {
                    Ok(Some(bytes)) => self.decoder.push(&bytes),
                    Ok(None) => return Closed::PeerClosed,
                    Err(err) => return Closed::Transport(err.kind()),
                },
                room = has_room(&self.out, headroom + 1), if !self.ordered.is_empty() => {
                    if !room {
                        return Closed::Transport(io::ErrorKind::BrokenPipe);
                    }
                    if let Err(closed) = self.send_ordered() {
                        return closed;
                    }
                }
                Some(queued) = self.events_rx.recv() => self.take_event(queued),
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
            Kind::Call => self.on_call_frame(session, frame, false).await,
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
                    return Ok(());
                }
                // A call still waiting for room never starts: it answers `Cancelled` at once,
                // as a call cancelled before its handler ran does.
                if let Some(at) = self.waiting.iter().position(|w| w.call_id == frame.call_id) {
                    self.waiting.remove(at);
                    let err = ErrorPayload::new(Code::Cancelled, "call cancelled");
                    return self.send_error(frame.call_id, err);
                }
                Ok(())
            }
            Kind::Subscribe => self.on_call_frame(session, frame, true).await,
            Kind::Unsubscribe => {
                if frame.call_id == 0 {
                    return Err(self
                        .violation(Code::InvalidArgument, "Unsubscribe on call id 0")
                        .await);
                }
                self.unsubscribe(frame.call_id);
                Ok(())
            }
            // Credit: binary streams (M2). Until they land there is nothing to credit.
            Kind::Credit => Ok(()),
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
                cancel_grace_ms: Some(advertised_ms(config.cancel_grace)),
            },
            server_version: config.server_version.clone(),
        };
        self.decoder.set_max_payload(config.max_frame_bytes);
        self.session = Some(Arc::new(session));
        self.send_json(Kind::HelloAck, 0, &ack)
    }

    /// A `Call` or `Subscribe` frame: checked and accepted at once (see [`ConnState::accept`]),
    /// then started when there is room for its audit completion. Without room it waits, in
    /// order, while the connection keeps reading and handling the client's other frames, so a
    /// slow audit sink delays new calls but never a `Cancel`, an `Unsubscribe`, a `Ping` or a
    /// close.
    async fn on_call_frame(
        &mut self,
        session: Arc<Session>,
        frame: Frame,
        subscribe: bool,
    ) -> Step {
        let Some(received) = self.accept(session, &frame, subscribe).await? else {
            return Ok(());
        };
        if self.waiting.is_empty()
            && let Some(room) = self.rooms.try_take()
        {
            self.start(received, room);
        } else {
            self.waiting.push_back(received);
        }
        Ok(())
    }

    /// Claims the call's id, checks the concurrency limit (a call waiting for room counts: the
    /// client is waiting for its answer) and decodes the payload. `Ok(None)` when the call was
    /// answered with an error and the connection stays; no room is taken for such a call.
    async fn accept(
        &mut self,
        session: Arc<Session>,
        frame: &Frame,
        subscribe: bool,
    ) -> Result<Option<Received>, Closed> {
        let at = Start::now(Arc::clone(&self.inner.config.deadline_clock));
        let call_id = frame.call_id;
        if !self.claim_call_id(call_id) {
            return Err(self
                .violation(Code::InvalidArgument, "call id not increasing")
                .await);
        }
        let calls = self.in_flight.len() + self.waiting.len();
        if calls >= self.inner.config.max_concurrent_calls as usize {
            let mut err = ErrorPayload::new(Code::ResourceExhausted, "too many concurrent calls");
            err.retryable = true;
            self.send_error(call_id, err)?;
            return Ok(None);
        }
        if frame.flags.is_binary() {
            let err = ErrorPayload::new(Code::InvalidArgument, "Call payload must be JSON");
            self.send_error(call_id, err)?;
            return Ok(None);
        }
        let call = match serde_json::from_slice::<Call>(&frame.payload) {
            Ok(call) => call,
            Err(_) => {
                let err = ErrorPayload::new(Code::InvalidArgument, "malformed Call payload");
                self.send_error(call_id, err)?;
                return Ok(None);
            }
        };
        let mut received = Received {
            call_id,
            subscribe,
            call,
            session,
            at,
            deadline: None,
        };
        let (default, max) = received.kind().default_timeouts();
        received.deadline =
            deadline_at(received.at.clock_at, received.call.timeout(), default, max);
        Ok(Some(received))
    }

    /// Ends every waiting call whose deadline has passed, as the Cancel of a waiting call does:
    /// it never runs and has no audit entry. A call answers `DeadlineExceeded` at once; a
    /// subscription is dropped and nothing is sent for it (spec Open question 26 item 11).
    fn expire_waiting(&mut self) -> Step {
        let now = self.inner.config.deadline_clock.now();
        let mut expired = Vec::new();
        self.waiting.retain(|w| {
            let over = w.deadline.is_some_and(|deadline| deadline <= now);
            if over && !w.subscribe {
                expired.push(w.call_id);
            }
            !over
        });
        for call_id in expired {
            let err = ErrorPayload::new(Code::DeadlineExceeded, "deadline exceeded");
            self.send_error(call_id, err)?;
        }
        Ok(())
    }

    /// Starts an accepted call with its room in the completion queue.
    fn start(&mut self, received: Received, room: Room) {
        let kind = received.kind();
        let Received {
            call_id,
            subscribe,
            call,
            session,
            at,
            deadline: _,
        } = received;
        // The deadline runs from frame receipt, with the default bounds of its kind; the
        // dispatcher narrows it to the procedure's bounds.
        let scope = CallScope::with_token(
            self.conn_token.child_token(),
            call.timeout(),
            self.correlation_id(call_id),
            at,
            self.completions.clone(),
            Some(room),
            kind,
        );
        if !subscribe {
            let fut = self.inner.dispatch.call(session, call);
            self.spawn(call_id, scope, fut, false);
            return;
        }
        let config = &self.inner.config;
        let events = Events::new(
            call_id,
            scope.clone(),
            self.events_tx.clone(),
            config.subscription_buffer_events,
            config.subscription_buffer_bytes,
            config.max_frame_bytes,
        );
        let fut = self.inner.dispatch.subscribe(session, call, events);
        // A normal end is a `Result` with payload `null`.
        let fut = Box::pin(async move { fut.await.map(|()| Value::Null) });
        self.subscriptions.insert(call_id);
        self.spawn(call_id, scope, fut, true);
    }

    /// Runs a call or subscription task under `scope`; its terminal frame comes to `finish_call`.
    fn spawn(
        &mut self,
        call_id: u32,
        scope: CallScope,
        fut: BoxFuture<'static, Result<Value, ErrorPayload>>,
        subscription: bool,
    ) {
        let correlation_id = scope.correlation_id().to_owned();
        let config = &self.inner.config;
        let (max, grace) = (config.max_frame_bytes, config.cancel_grace);
        let task_scope = scope.clone();
        let handle = self.calls.spawn(async move {
            let finished = run_call(fut, task_scope.clone(), grace).await;
            let replaced_by = finished.replaced_by;
            let (frame, delivery) = result_frame(call_id, finished, correlation_id, max);
            // The audit completion records what the client gets (Open question 26a, item 11):
            // it travels with the frame and is written once the transport accepted it.
            let completion = task_scope
                .take_completion()
                .map(|c| c.arm(delivery, replaced_by.unwrap_or(Code::Cancelled)));
            Answer { frame, completion }
        });
        self.tasks.insert(
            handle.id(),
            Task {
                call_id,
                subscription,
            },
        );
        self.in_flight.insert(call_id, scope);
    }

    /// `Unsubscribe`: nothing more is sent for `call_id`, and the handler is cancelled. Its frames
    /// still waiting here are dropped even when the handler already returned (its end frame may
    /// be among them). Otherwise a call id that is not a subscription in flight (already ended,
    /// or a call) is ignored: `ordered` only ever holds subscription frames.
    fn unsubscribe(&mut self, call_id: u32) {
        // A subscription still waiting for room never starts, and nothing is sent for it.
        self.waiting
            .retain(|w| !(w.subscribe && w.call_id == call_id));
        self.ordered.retain(|frame| frame.call_id() != call_id);
        if !self.subscriptions.remove(&call_id) {
            return;
        }
        if let Some(scope) = self.in_flight.get(&call_id) {
            scope.cancel();
        }
    }

    /// Moves the oldest subscription frame to the outbound queue. Only called once
    /// [`has_room`] saw room, which only the writer changes (by taking frames), so it fits.
    fn send_ordered(&mut self) -> Step {
        let outbound = match self.ordered.pop_front() {
            Some(Ordered::Event(queued)) => Outbound {
                bytes: queued.bytes,
                held: Some(queued.held),
                completion: None,
            },
            Some(Ordered::End(end)) => Outbound {
                bytes: end
                    .frame
                    .encode(self.inner.config.max_frame_bytes)
                    .map_err(|_| Closed::Transport(io::ErrorKind::InvalidData))?,
                held: None,
                completion: end.completion,
            },
            None => return Ok(()),
        };
        self.out.try_send(outbound).map_err(|err| match err {
            TrySendError::Full(_) => Closed::SlowConsumer,
            TrySendError::Closed(_) => Closed::Transport(io::ErrorKind::BrokenPipe),
        })
    }

    /// Queues an event for the transport, unless its subscription was unsubscribed.
    fn take_event(&mut self, queued: Queued) {
        if self.subscriptions.contains(&queued.call_id) {
            self.ordered.push_back(Ordered::Event(queued));
        }
    }

    /// Sends the one terminal frame of a finished call or subscription task.
    fn finish_call(
        &mut self,
        done: Result<(tokio::task::Id, Answer), tokio::task::JoinError>,
    ) -> Step {
        let (task, frame, mut completion) = match done {
            Ok((task, Answer { frame, completion })) => (task, Ok(frame), completion),
            Err(err) => (err.id(), Err(err.is_panic()), None),
        };
        let Task {
            call_id,
            subscription,
        } = self.tasks.remove(&task).unwrap_or(Task {
            call_id: 0,
            subscription: false,
        });
        let scope = self.in_flight.remove(&call_id);
        // A panicking handler's audit completion: it ended with `Internal`, which the client
        // gets below, and travels with that frame like any answer, so the frame's fate decides
        // the delivery. A task that was aborted instead keeps its completion, written from its
        // drop guard as `Cancelled` once the last clone of its scope goes (below): the engine
        // never finished that call.
        if matches!(frame, Err(true))
            && let Some(mut panicked) = scope.as_ref().and_then(CallScope::take_completion)
        {
            panicked.record_outcome(security_types::Outcome::Error {
                code: code_name(Code::Internal),
            });
            completion = Some(panicked.arm(Delivery::Delivered, Code::Internal));
        }
        let frame = frame.unwrap_or_else(|panicked| {
            // A panicking handler must not take the connection down or leak its message. An
            // aborted call answers with the reason its token fired, `Cancelled` if none.
            let mut payload = match &scope {
                Some(scope) if !panicked => scope.error(),
                _ => ErrorPayload::new(Code::Internal, "internal error"),
            };
            payload.correlation_id = self.correlation_id(call_id);
            let payload = serde_json::to_vec(&payload).expect("ErrorPayload serializes");
            Frame::new(Kind::Error, call_id, payload)
        });
        // A finished subscription is over: a sink clone the handler left behind (e.g. in a task
        // it spawned) is refused from now on, and its `closed()` resolves.
        if let Some(scope) = scope
            && subscription
        {
            scope.cancel();
        }
        if !subscription {
            return self.send_answer(&frame, completion);
        }
        // After Unsubscribe nothing more goes out for this id, not even the end: its completion
        // drops here, as `Cancelled`.
        if !self.subscriptions.contains(&call_id) {
            return Ok(());
        }
        // Every event the handler sent before it returned is already in the channel; they go
        // first, then the end.
        while let Ok(queued) = self.events_rx.try_recv() {
            self.take_event(queued);
        }
        self.subscriptions.remove(&call_id);
        self.ordered
            .push_back(Ordered::End(Box::new(Answer { frame, completion })));
        Ok(())
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
        self.send_final(Kind::Error, 0, &transport_refusal(code, message))
            .await;
        Closed::HandshakeRejected(code)
    }

    /// Reports a protocol violation on call 0. The caller closes the connection.
    async fn violation(&mut self, code: Code, message: impl Into<String>) -> Closed {
        self.send_final(Kind::Error, 0, &transport_refusal(code, message))
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
        let _ = tokio::time::timeout_at(close_by, self.out.send(bytes.into())).await;
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
        self.send_answer(frame, None)
    }

    /// [`ConnState::send`] for a call's answer frame, carrying its audit completion to the
    /// writer. If the frame is not queued, the completion drops with it, as `Cancelled`.
    fn send_answer(&mut self, frame: &Frame, completion: Option<Armed>) -> Step {
        // Frames built here are bounded by construction (result_frame checks the only
        // unbounded payload), so an encode error is a bug, not a peer fault.
        let bytes = frame
            .encode(self.inner.config.max_frame_bytes)
            .map_err(|_| Closed::Transport(io::ErrorKind::InvalidData))?;
        let outbound = Outbound {
            bytes,
            held: None,
            completion,
        };
        self.out.try_send(outbound).map_err(|err| match err {
            TrySendError::Full(_) => Closed::SlowConsumer,
            TrySendError::Closed(_) => Closed::Transport(io::ErrorKind::BrokenPipe),
        })
    }
}

/// A refusal on call 0 (handshake rejection, protocol violation). It belongs to no call, so its
/// correlation id comes from the shared generator (empty only without OS randomness).
fn transport_refusal(code: Code, message: impl Into<String>) -> ErrorPayload {
    let mut err = ErrorPayload::new(code, message);
    err.correlation_id = security_types::new_correlation_id().unwrap_or_default();
    err
}

/// `duration` in whole milliseconds for HelloAck, clamped so a JavaScript client reads it exactly
/// (a `cancel_grace` of `Duration::MAX` means "never drop"; any value this large reads the same).
fn advertised_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis())
        .unwrap_or(u64::MAX)
        .min(MAX_JSON_SAFE_INTEGER)
}

/// Builds the Result or Error frame for a finished call, and says what the client gets.
fn result_frame(
    call_id: u32,
    finished: Finished,
    correlation_id: String,
    max_payload: u32,
) -> (Frame, Delivery) {
    // The token fired first: the client gets its reason, whatever the handler did.
    let mut delivery = finished
        .replaced_by
        .map_or(Delivery::Delivered, delivery_for);
    let error = match finished.result.map(|value| serde_json::to_vec(&value)) {
        Ok(Ok(payload)) if payload.len() <= max_payload as usize => {
            return (Frame::new(Kind::Result, call_id, payload), delivery);
        }
        Ok(Ok(_)) => {
            delivery = Delivery::FrameTooLarge;
            ErrorPayload::new(
                Code::ResourceExhausted,
                "result exceeds the frame size limit",
            )
        }
        // Not reachable for a `Value`; the answer could not be put in a frame either way.
        Ok(Err(_)) => {
            delivery = Delivery::FrameTooLarge;
            ErrorPayload::new(Code::Internal, "internal error")
        }
        Err(err) => err,
    };
    let mut error = error;
    if error.correlation_id.is_empty() {
        error.correlation_id = correlation_id;
    }
    let mut payload = serde_json::to_vec(&error).expect("ErrorPayload serializes");
    if payload.len() > max_payload as usize {
        if delivery == Delivery::Delivered {
            delivery = Delivery::FrameTooLarge;
        }
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
    (Frame::new(Kind::Error, call_id, payload), delivery)
}
