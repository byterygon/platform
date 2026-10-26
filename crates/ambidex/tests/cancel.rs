//! Deadlines and cancellation (Ambidex spec §7), through the engine and the router.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::security_types::{
    Authorizer, AuthzRequest, Decision, Principal, PrincipalKind, Reason, SessionId, TenantId,
};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{
    Authenticate, CallScope, CancellationToken, Closed, Code, Connection, Ctx, ErrorPayload,
    Goaway, Hello, Router, RpcError, Server, ServerConfig, Session, rpc,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio::time::Instant;

const GRACE: Duration = Duration::from_millis(250);

// ---- fixture API ----------------------------------------------------------------------------

struct State {
    /// One message per handler that started.
    started: mpsc::UnboundedSender<()>,
    /// Handlers that observed their token fire.
    saw_cancel: AtomicUsize,
    /// Handler futures dropped before they finished.
    dropped: AtomicUsize,
    /// Deadline each handler saw, and when it started.
    deadlines: Mutex<Vec<(Instant, Instant)>>,
}

impl State {
    fn saw_cancel(&self) -> usize {
        self.saw_cancel.load(Ordering::SeqCst)
    }

    fn dropped(&self) -> usize {
        self.dropped.load(Ordering::SeqCst)
    }
}

struct DropCount(Arc<State>);

impl Drop for DropCount {
    fn drop(&mut self) {
        self.0.dropped.fetch_add(1, Ordering::SeqCst);
    }
}

struct SlowApi(Arc<State>);

impl SlowApi {
    /// Waits for cancellation, then returns a value the client must never see.
    async fn until_cancelled(&self, ctx: &Ctx) -> Result<String, RpcError> {
        let guard = DropCount(Arc::clone(&self.0));
        self.0
            .deadlines
            .lock()
            .unwrap()
            .push((Instant::now(), ctx.deadline()));
        self.0.started.send(()).unwrap();
        ctx.cancelled().await;
        assert!(ctx.is_cancelled() && ctx.cancellation_token().is_cancelled());
        self.0.saw_cancel.fetch_add(1, Ordering::SeqCst);
        std::mem::forget(guard);
        Ok("finished after cancel".into())
    }
}

#[rpc::router(namespace = "slow")]
impl SlowApi {
    #[rpc::query(perm = "slow.run", risk = Risk::Read)]
    async fn cooperative(&self, ctx: Ctx, _input: ()) -> Result<String, RpcError> {
        self.until_cancelled(&ctx).await
    }

    #[rpc::query(perm = "slow.run", risk = Risk::Read, timeout_max = "100ms")]
    async fn capped(&self, ctx: Ctx, _input: ()) -> Result<String, RpcError> {
        self.until_cancelled(&ctx).await
    }

    #[rpc::query(perm = "slow.run", risk = Risk::Read, timeout_default = "300ms")]
    async fn defaulted(&self, ctx: Ctx, _input: ()) -> Result<String, RpcError> {
        self.until_cancelled(&ctx).await
    }

    /// Ignores its token entirely.
    #[rpc::query(perm = "slow.run", risk = Risk::Read)]
    async fn stubborn(&self, _ctx: Ctx, _input: ()) -> Result<String, RpcError> {
        let _guard = DropCount(Arc::clone(&self.0));
        self.0.started.send(()).unwrap();
        std::future::pending::<()>().await;
        unreachable!()
    }

    /// Yields `n` times, then answers.
    #[rpc::query(perm = "slow.run", risk = Risk::Read)]
    async fn quick(&self, _ctx: Ctx, n: u32) -> Result<u32, RpcError> {
        for _ in 0..n {
            tokio::task::yield_now().await;
        }
        Ok(n)
    }
}

struct AllowRun;

impl Authorizer for AllowRun {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        if req.action.perm.as_str() == "slow.run" {
            Decision::Allow
        } else {
            Decision::Deny {
                reason: Reason::MissingPermission {
                    perm: req.action.perm.clone(),
                },
            }
        }
    }
}

/// Accepts every Hello; the session is revoked when `revoke` fires.
struct Revocable {
    revoke: CancellationToken,
}

impl Authenticate for Revocable {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "s-1".into(),
                principal: Principal {
                    kind: PrincipalKind::Human,
                    id: "human:local:alice".into(),
                    tenant: TenantId::new("t-1"),
                    on_behalf_of: None,
                    roles: vec![],
                    session: SessionId::new("s-1"),
                },
            })
        })
    }

    fn revocation(&self, _session: &Session) -> Option<CancellationToken> {
        Some(self.revoke.clone())
    }
}

// ---- client ---------------------------------------------------------------------------------

struct Client {
    rx: MemoryRx,
    tx: Option<MemoryTx>,
    decoder: FrameDecoder,
}

impl Client {
    async fn send(&mut self, frames: &[Frame]) {
        // Several frames go out in one chunk, so the engine reads them in one go.
        let bytes = frames
            .iter()
            .flat_map(|f| f.encode(u32::MAX).unwrap())
            .collect();
        self.tx.as_mut().unwrap().send(bytes).await.unwrap();
    }

    async fn call(&mut self, call_id: u32, procedure: &str, extra: Value) {
        self.send(&[call_frame(call_id, procedure, extra)]).await;
    }

    async fn cancel(&mut self, call_id: u32) {
        self.send(&[Frame::new(Kind::Cancel, call_id, vec![])])
            .await;
    }

    async fn recv(&mut self) -> Option<Frame> {
        tokio::time::timeout(Duration::from_secs(3600), async {
            loop {
                if let Some(frame) = self.decoder.next_frame().unwrap() {
                    return Some(frame);
                }
                let bytes = self.rx.recv().await.unwrap()?;
                self.decoder.push(&bytes);
            }
        })
        .await
        .expect("server did not answer")
    }

    async fn recv_error(&mut self) -> (u32, ErrorPayload) {
        let frame = self.recv().await.expect("connection open");
        assert_eq!(frame.kind, Kind::Error, "{frame:?}");
        (
            frame.call_id,
            serde_json::from_slice(&frame.payload).unwrap(),
        )
    }

    /// Proves nothing else is queued: a Ping sent now is answered by the very next frame.
    async fn expect_quiet(&mut self) {
        self.send(&[Frame::new(Kind::Ping, 0, b"q".to_vec())]).await;
        let frame = self.recv().await.unwrap();
        assert_eq!(
            (frame.kind, frame.payload.as_slice()),
            (Kind::Pong, &b"q"[..])
        );
    }
}

fn call_frame(call_id: u32, procedure: &str, extra: Value) -> Frame {
    let mut call = json!({ "procedure": procedure, "input": null });
    if let Value::Object(extra) = extra {
        call.as_object_mut().unwrap().extend(extra);
    }
    Frame::new(Kind::Call, call_id, serde_json::to_vec(&call).unwrap())
}

struct Harness {
    client: Client,
    conn: Connection,
    state: Arc<State>,
    started: mpsc::UnboundedReceiver<()>,
    revoke: CancellationToken,
}

impl Harness {
    async fn start() -> Harness {
        let (started_tx, started) = mpsc::unbounded_channel();
        let state = Arc::new(State {
            started: started_tx,
            saw_cancel: AtomicUsize::new(0),
            dropped: AtomicUsize::new(0),
            deadlines: Mutex::default(),
        });
        let router = Router::new(AllowRun);
        router.mount(SlowApi(Arc::clone(&state))).unwrap();
        let mut config = ServerConfig::new("dbee", "h", "1");
        config.cancel_grace = GRACE;
        let revoke = CancellationToken::new();
        let auth = Revocable {
            revoke: revoke.clone(),
        };
        let ((rx, tx), (srx, stx)) = memory(64);
        let conn = Server::new(config, auth, router).serve(srx, stx);
        let mut client = Client {
            rx,
            tx: Some(tx),
            decoder: FrameDecoder::new(u32::MAX),
        };
        let hello =
            json!({"protocol": 1, "api": "dbee", "schema_hash": "h", "client_version": "1"});
        client
            .send(&[Frame::new(
                Kind::Hello,
                0,
                serde_json::to_vec(&hello).unwrap(),
            )])
            .await;
        assert_eq!(client.recv().await.unwrap().kind, Kind::HelloAck);
        Harness {
            client,
            conn,
            state,
            started,
            revoke,
        }
    }

    async fn started(&mut self, n: usize) {
        for _ in 0..n {
            self.started.recv().await.unwrap();
        }
    }
}

// ---- Cancel frame ---------------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn cancel_frame_fires_the_token_and_answers_cancelled_once() {
    let mut h = Harness::start().await;
    h.client.call(1, "slow.cooperative", json!({})).await;
    h.started(1).await;
    h.client.cancel(1).await;

    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::Cancelled));
    assert!(!err.correlation_id.is_empty());
    // The handler saw the token and returned a value; the client never gets it.
    assert_eq!(h.state.saw_cancel(), 1);
    h.client.expect_quiet().await;

    // The id is free again, and a second Cancel for it is ignored.
    h.client.cancel(1).await;
    h.client.expect_quiet().await;
}

#[tokio::test(start_paused = true)]
async fn a_handler_that_ignores_the_token_is_dropped_after_the_grace_period() {
    let mut h = Harness::start().await;
    h.client.call(7, "slow.stubborn", json!({})).await;
    h.started(1).await;
    let cancelled_at = Instant::now();
    h.client.cancel(7).await;

    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (7, Code::Cancelled));
    assert_eq!(cancelled_at.elapsed(), GRACE);
    assert_eq!(h.state.dropped(), 1);
    h.client.expect_quiet().await;
}

#[tokio::test(start_paused = true)]
async fn cancel_for_an_unknown_call_is_ignored_and_call_zero_is_a_violation() {
    let mut h = Harness::start().await;
    h.client.cancel(42).await;
    h.client.expect_quiet().await;

    h.client.cancel(0).await;
    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::InvalidArgument));
    assert_eq!(
        h.conn.closed().await,
        Closed::ProtocolViolation(Code::InvalidArgument)
    );
}

// ---- deadlines ------------------------------------------------------------------------------

async fn assert_deadline(procedure: &str, extra: Value, expected: Duration) {
    let mut h = Harness::start().await;
    let sent = Instant::now();
    h.client.call(3, procedure, extra).await;
    h.started(1).await;

    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (3, Code::DeadlineExceeded));
    assert_eq!(sent.elapsed(), expected);
    assert_eq!(h.state.saw_cancel(), 1);
    let (start, deadline) = h.state.deadlines.lock().unwrap()[0];
    assert_eq!(deadline - start, expected);
    h.client.expect_quiet().await;
}

#[tokio::test(start_paused = true)]
async fn client_timeout_below_the_maximum_is_the_deadline() {
    assert_deadline(
        "slow.cooperative",
        json!({"timeout_ms": 200}),
        Duration::from_millis(200),
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn timeout_max_caps_the_client_timeout() {
    assert_deadline(
        "slow.capped",
        json!({"timeout_ms": 600_000}),
        Duration::from_millis(100),
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn timeout_default_applies_without_a_client_timeout() {
    assert_deadline("slow.defaulted", json!({}), Duration::from_millis(300)).await;
    // The provisional procedure default (30 s) also applies, then the cap (5 min) on request.
    assert_deadline("slow.cooperative", json!({}), Duration::from_secs(30)).await;
    assert_deadline(
        "slow.cooperative",
        json!({"timeout_ms": u64::MAX}),
        Duration::from_secs(300),
    )
    .await;
}

#[tokio::test(start_paused = true)]
async fn a_stubborn_handler_past_its_deadline_is_dropped() {
    let mut h = Harness::start().await;
    let sent = Instant::now();
    h.client
        .call(5, "slow.stubborn", json!({"timeout_ms": 50}))
        .await;
    h.started(1).await;
    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (5, Code::DeadlineExceeded));
    assert_eq!(sent.elapsed(), Duration::from_millis(50) + GRACE);
    assert_eq!(h.state.dropped(), 1);
}

#[tokio::test(start_paused = true)]
async fn malformed_timeout_is_invalid_argument() {
    let mut h = Harness::start().await;
    h.client
        .call(2, "slow.quick", json!({"timeout_ms": -1}))
        .await;
    let (call_id, err) = h.client.recv_error().await;
    assert_eq!((call_id, err.code), (2, Code::InvalidArgument));
}

// ---- connection-wide triggers ---------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn disconnect_cancels_every_call_on_the_connection() {
    let mut h = Harness::start().await;
    h.client.call(1, "slow.cooperative", json!({})).await;
    h.client.call(2, "slow.cooperative", json!({})).await;
    h.client.call(3, "slow.stubborn", json!({})).await;
    h.started(3).await;

    drop(h.client.tx.take());
    assert_eq!(h.conn.closed().await, Closed::PeerClosed);
    assert_eq!(h.state.saw_cancel(), 2);
    // The stubborn call was dropped once the grace period ran out.
    assert_eq!(h.state.dropped(), 1);
}

#[tokio::test(start_paused = true)]
async fn session_revocation_cancels_calls_and_sends_goaway() {
    let mut h = Harness::start().await;
    h.client.call(1, "slow.cooperative", json!({})).await;
    h.client.call(2, "slow.cooperative", json!({})).await;
    h.started(2).await;

    h.revoke.cancel();
    let frame = h.client.recv().await.unwrap();
    assert_eq!((frame.kind, frame.call_id), (Kind::Goaway, 0));
    let goaway: Goaway = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(goaway.code, Code::Unauthenticated);
    // Goaway is the answer for every call: no per-call frames follow.
    assert_eq!(h.client.recv().await, None);
    assert_eq!(h.conn.closed().await, Closed::Revoked);
    assert_eq!(h.state.saw_cancel(), 2);
}

#[tokio::test(start_paused = true)]
async fn a_session_revoked_before_the_handshake_is_rejected() {
    let (started, _rx) = mpsc::unbounded_channel();
    let state = Arc::new(State {
        started,
        saw_cancel: AtomicUsize::new(0),
        dropped: AtomicUsize::new(0),
        deadlines: Mutex::default(),
    });
    let router = Router::new(AllowRun);
    router.mount(SlowApi(state)).unwrap();
    let revoke = CancellationToken::new();
    revoke.cancel();
    let ((rx, tx), (srx, stx)) = memory(8);
    let conn = Server::new(
        ServerConfig::new("dbee", "h", "1"),
        Revocable { revoke },
        router,
    )
    .serve(srx, stx);
    let mut client = Client {
        rx,
        tx: Some(tx),
        decoder: FrameDecoder::new(u32::MAX),
    };
    let hello = json!({"protocol": 1, "api": "dbee", "schema_hash": "h", "client_version": "1"});
    client
        .send(&[Frame::new(
            Kind::Hello,
            0,
            serde_json::to_vec(&hello).unwrap(),
        )])
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::Unauthenticated));
    assert_eq!(
        conn.closed().await,
        Closed::HandshakeRejected(Code::Unauthenticated)
    );
}

#[tokio::test(start_paused = true)]
async fn goaway_cancels_calls_on_the_connection() {
    let mut h = Harness::start().await;
    h.client.call(1, "slow.cooperative", json!({})).await;
    h.started(1).await;
    h.conn.goaway(Code::Unavailable, "shutting down").await;
    let frame = h.client.recv().await.unwrap();
    assert_eq!(frame.kind, Kind::Goaway);
    assert!(matches!(h.conn.closed().await, Closed::Goaway(_)));
    assert_eq!(h.state.saw_cancel(), 1);
}

// ---- Result racing Cancel -------------------------------------------------------------------

/// Calls finish after 0–7 yields while a Cancel for each is already on its way, on a
/// multi-threaded runtime. Whichever wins, each call id gets exactly one terminal frame.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn result_racing_cancel_yields_exactly_one_terminal_frame() {
    const CALLS: u32 = 2_000;
    const BATCH: u32 = 40;
    let mut h = Harness::start().await;
    let mut answers = std::collections::HashMap::new();
    let (mut results, mut cancelled) = (0, 0);
    for batch in 0..CALLS / BATCH {
        for i in 0..BATCH {
            let id = batch * BATCH + i + 1;
            let call = call_frame(id, "slow.quick", json!({"input": id % 8}));
            if id.is_multiple_of(2) {
                // Call and Cancel in one chunk: the Cancel is read before the call is polled.
                h.client
                    .send(&[call, Frame::new(Kind::Cancel, id, vec![])])
                    .await;
            } else {
                h.client.send(&[call]).await;
                h.client.cancel(id).await;
            }
        }
        // The server disconnects a peer that leaves 64 frames unread, so drain each batch.
        let mut seen = 0;
        while seen < BATCH {
            let frame = h.client.recv().await.unwrap();
            assert!(
                answers.insert(frame.call_id, frame.kind).is_none(),
                "two terminal frames for call {}",
                frame.call_id
            );
            match frame.kind {
                Kind::Result => results += 1,
                Kind::Error => {
                    let err: ErrorPayload = serde_json::from_slice(&frame.payload).unwrap();
                    assert_eq!(err.code, Code::Cancelled);
                    cancelled += 1;
                }
                other => panic!("unexpected {other:?}"),
            }
            seen += 1;
        }
    }
    assert_eq!(answers.len(), CALLS as usize);
    h.client.expect_quiet().await;
    // Not asserted, as scheduling decides: both outcomes normally occur.
    eprintln!("results: {results}, cancelled: {cancelled}");
}

/// A Cancel that arrives after the Result was sent is ignored: the call is no longer in flight.
#[tokio::test(start_paused = true)]
async fn a_cancel_after_the_result_is_ignored() {
    let mut h = Harness::start().await;
    h.client.call(9, "slow.quick", json!({"input": 0})).await;
    let frame = h.client.recv().await.unwrap();
    assert_eq!((frame.kind, frame.call_id), (Kind::Result, 9));
    h.client.cancel(9).await;
    h.client.expect_quiet().await;
}

// ---- outside the engine ---------------------------------------------------------------------

#[tokio::test(start_paused = true)]
async fn a_scope_outside_the_engine_applies_procedure_bounds() {
    let scope = CallScope::new(Some(Duration::from_secs(3600)));
    let start = Instant::now();
    scope.apply_timeouts(Duration::from_secs(30), Duration::from_secs(300));
    assert_eq!(scope.deadline() - start, Duration::from_secs(300));
    assert_eq!(scope.reason(), None);
    scope.cancel();
    assert_eq!(scope.reason(), Some(Code::Cancelled));
}
