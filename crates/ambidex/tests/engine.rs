//! Protocol engine tests over the in-memory transport.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Header, Kind};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{
    Authenticate, Call, Closed, Code, Connection, Dispatch, ErrorPayload, Events, Flags, Goaway,
    Hello, HelloAck, Server, ServerConfig, Session,
};
use security_types::{Principal, PrincipalKind, SessionId, TenantId};
use serde_json::{Value, json};
use tokio::sync::Notify;

const SCHEMA: &str = "schema-1";

struct TokenAuth;

fn principal() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:local:tester".into(),
        tenant: TenantId::new("t-1"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("s-1"),
    }
}

impl Authenticate for TokenAuth {
    fn authenticate<'a>(&'a self, hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async move {
            if hello.auth == Some(json!("hang")) {
                // An authenticator that never answers, e.g. a stuck IdP call.
                std::future::pending::<()>().await;
            }
            (hello.auth == Some(json!("good"))).then(|| Session {
                id: "s-1".into(),
                principal: principal(),
            })
        })
    }
}

#[derive(Default)]
struct Fixture {
    gate: Arc<Notify>,
    started: Arc<Notify>,
    dropped: Arc<AtomicBool>,
    /// What a sink clone left behind by the `orphan` handler saw: `send` after `closed()`.
    orphan: Arc<std::sync::Mutex<Option<Result<(), Code>>>>,
}

struct DropFlag(Arc<AtomicBool>);

impl Drop for DropFlag {
    fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
    }
}

impl Dispatch for Fixture {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        let gate = Arc::clone(&self.gate);
        let started = Arc::clone(&self.started);
        let dropped = Arc::clone(&self.dropped);
        Box::pin(async move {
            match call.procedure.as_str() {
                "echo" => Ok(json!({ "input": call.input, "session": session.id })),
                "fail" => Err(ErrorPayload::new(Code::NotFound, "no such thing")),
                "wait" => {
                    let _flag = DropFlag(dropped);
                    started.notify_one();
                    gate.notified().await;
                    Ok(json!("waited"))
                }
                "open" => {
                    gate.notify_one();
                    Ok(json!("opened"))
                }
                "big" => Ok(json!("x".repeat(2048))),
                "panic" => panic!("handler bug with secret detail"),
                _ => Err(ErrorPayload::new(Code::NotFound, "unknown procedure")),
            }
        })
    }

    /// Subscriptions: `ticks` (events 0..n, then a normal end), `fail` (events 0..n, then an
    /// error), `hold` (events 0..n, then waits until the subscription is over and returns `Ok`),
    /// `flood` (sends without ever yielding until the engine refuses), `huge` (one event over the
    /// frame limit).
    fn subscribe(
        &self,
        _session: Arc<Session>,
        call: Call,
        events: Events,
    ) -> BoxFuture<'static, Result<(), ErrorPayload>> {
        let started = Arc::clone(&self.started);
        let dropped = Arc::clone(&self.dropped);
        let orphan = Arc::clone(&self.orphan);
        Box::pin(async move {
            let n = call.input.as_u64().unwrap_or(0);
            let send = |i: u64| {
                events
                    .send_json(i.to_string().into_bytes())
                    .map_err(|ended| ErrorPayload::new(ended.code(), "ended"))
            };
            match call.procedure.as_str() {
                "ticks" | "fail" | "hold" => {
                    for i in 0..n {
                        send(i)?;
                    }
                    match call.procedure.as_str() {
                        "fail" => Err(ErrorPayload::new(Code::FailedPrecondition, "topic gone")),
                        "hold" => {
                            let _flag = DropFlag(dropped);
                            started.notify_one();
                            events.closed().await;
                            Ok(())
                        }
                        _ => Ok(()),
                    }
                }
                // Sends, yielding after each event so the engine can forward it, until refused.
                "trickle" => {
                    let mut i = 0;
                    while send(i).is_ok() {
                        i += 1;
                        tokio::task::yield_now().await;
                    }
                    Ok(())
                }
                "flood" => {
                    let mut i = 0;
                    loop {
                        if let Err(ended) = send(i) {
                            // Whatever the handler answers, the engine's reason wins.
                            assert_eq!(ended.code, Code::ResourceExhausted);
                            return Ok(());
                        }
                        i += 1;
                    }
                }
                "huge" => events
                    .send_json(format!("\"{}\"", "x".repeat(2048)).into_bytes())
                    .map_err(|ended| ErrorPayload::new(ended.code(), "ended")),
                // Leaves a sink clone in a task of its own, then returns `Ok`.
                "orphan" => {
                    let left = events.clone();
                    tokio::spawn(async move {
                        left.closed().await;
                        let sent = left.send_json(b"1".to_vec()).map_err(|e| e.code());
                        *orphan.lock().unwrap() = Some(sent);
                        started.notify_one();
                    });
                    Ok(())
                }
                _ => Err(ErrorPayload::new(Code::NotFound, "unknown procedure")),
            }
        })
    }
}

fn config() -> ServerConfig {
    let mut config = ServerConfig::new("dbee", SCHEMA, "9.9.9");
    config.max_frame_bytes = 1024;
    config.max_hello_bytes = 512;
    config.max_concurrent_calls = 4;
    config.cancel_grace = Duration::from_millis(50);
    config.subscription_buffer_events = 8;
    config
}

struct Client {
    rx: MemoryRx,
    tx: MemoryTx,
    decoder: FrameDecoder,
}

impl Client {
    async fn send(&mut self, frame: Frame) {
        self.send_raw(frame.encode(u32::MAX).unwrap()).await;
    }

    async fn send_raw(&mut self, bytes: Vec<u8>) {
        self.tx.send(bytes).await.unwrap();
    }

    async fn send_json(&mut self, kind: Kind, call_id: u32, value: Value) {
        self.send(Frame::new(
            kind,
            call_id,
            serde_json::to_vec(&value).unwrap(),
        ))
        .await;
    }

    async fn call(&mut self, call_id: u32, procedure: &str, input: Value) {
        self.send_json(
            Kind::Call,
            call_id,
            json!({ "procedure": procedure, "input": input }),
        )
        .await;
    }

    /// Next frame from the server, or `None` once the server closed.
    async fn recv(&mut self) -> Option<Frame> {
        tokio::time::timeout(Duration::from_secs(5), async {
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

    async fn recv_result(&mut self) -> (u32, Value) {
        let frame = self.recv().await.expect("connection open");
        assert_eq!(frame.kind, Kind::Result, "{frame:?}");
        (
            frame.call_id,
            serde_json::from_slice(&frame.payload).unwrap(),
        )
    }

    async fn expect_closed(&mut self) {
        assert_eq!(self.recv().await, None);
    }
}

fn hello_json() -> Value {
    json!({ "protocol": 1, "api": "dbee", "schema_hash": SCHEMA, "client_version": "1.0.0", "auth": "good" })
}

fn start() -> (Client, Connection) {
    start_with(Fixture::default())
}

fn start_with(fixture: Fixture) -> (Client, Connection) {
    start_with_capacity(fixture, 16)
}

/// `capacity` is the number of chunks each transport direction holds before the sender waits.
fn start_with_capacity(fixture: Fixture, capacity: usize) -> (Client, Connection) {
    start_with_config(fixture, config(), capacity)
}

fn start_with_config(
    fixture: Fixture,
    config: ServerConfig,
    capacity: usize,
) -> (Client, Connection) {
    let ((client_rx, client_tx), (server_rx, server_tx)) = memory(capacity);
    let server = Server::new(config, TokenAuth, fixture);
    let conn = server.serve(server_rx, server_tx);
    let client = Client {
        rx: client_rx,
        tx: client_tx,
        decoder: FrameDecoder::new(u32::MAX),
    };
    (client, conn)
}

async fn connected() -> (Client, Connection) {
    let (mut client, conn) = start();
    client.send_json(Kind::Hello, 0, hello_json()).await;
    let ack = client.recv().await.unwrap();
    assert_eq!((ack.kind, ack.call_id), (Kind::HelloAck, 0));
    (client, conn)
}

#[tokio::test]
async fn handshake_returns_session_and_limits() {
    let (mut client, _conn) = start();
    client.send_json(Kind::Hello, 0, hello_json()).await;
    let frame = client.recv().await.unwrap();
    assert_eq!(frame.kind, Kind::HelloAck);
    let ack: HelloAck = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(ack.session, "s-1");
    assert_eq!(ack.server_version, "9.9.9");
    assert_eq!(ack.limits.max_frame_bytes, 1024);
    assert_eq!(ack.limits.max_concurrent_calls, 4);
    assert_eq!(ack.limits.cancel_grace_ms, Some(50));
}

#[tokio::test]
async fn a_huge_cancel_grace_is_advertised_as_a_safe_integer() {
    // Review finding [4]: Duration::MAX would be u64::MAX ms, which a JavaScript client cannot
    // read exactly.
    for (grace, advertised) in [
        (Duration::MAX, (1u64 << 53) - 1),
        (Duration::from_millis(1 << 60), (1 << 53) - 1),
        (Duration::from_millis((1 << 53) - 1), (1 << 53) - 1),
        (Duration::from_micros(1500), 1),
    ] {
        let mut config = config();
        config.cancel_grace = grace;
        let (mut client, _conn) = start_with_config(Fixture::default(), config, 16);
        client.send_json(Kind::Hello, 0, hello_json()).await;
        let frame = client.recv().await.unwrap();
        let ack: HelloAck = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(ack.limits.cancel_grace_ms, Some(advertised), "{grace:?}");
    }
}

#[tokio::test]
async fn handshake_survives_byte_by_byte_delivery() {
    let (mut client, _conn) = start();
    let bytes = Frame::new(Kind::Hello, 0, serde_json::to_vec(&hello_json()).unwrap())
        .encode(u32::MAX)
        .unwrap();
    for byte in bytes {
        client.send_raw(vec![byte]).await;
    }
    assert_eq!(client.recv().await.unwrap().kind, Kind::HelloAck);
}

async fn assert_rejected(hello: Value, code: Code) {
    let (mut client, conn) = start();
    client.send_json(Kind::Hello, 0, hello).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, code));
    client.expect_closed().await;
    assert_eq!(conn.closed().await, Closed::HandshakeRejected(code));
}

#[tokio::test]
async fn schema_hash_mismatch_is_version_mismatch() {
    let mut hello = hello_json();
    hello["schema_hash"] = json!("stale");
    assert_rejected(hello, Code::VersionMismatch).await;
}

#[tokio::test]
async fn protocol_or_api_mismatch_is_version_mismatch() {
    let mut hello = hello_json();
    hello["protocol"] = json!(2);
    assert_rejected(hello, Code::VersionMismatch).await;
    let mut hello = hello_json();
    hello["api"] = json!("other");
    assert_rejected(hello, Code::VersionMismatch).await;
}

#[tokio::test]
async fn version_is_checked_before_authentication() {
    let mut hello = hello_json();
    hello["schema_hash"] = json!("stale");
    hello["auth"] = json!("bad");
    assert_rejected(hello, Code::VersionMismatch).await;
}

#[tokio::test]
async fn bad_credentials_are_unauthenticated() {
    let mut hello = hello_json();
    hello["auth"] = json!("bad");
    assert_rejected(hello, Code::Unauthenticated).await;
    let mut hello = hello_json();
    hello.as_object_mut().unwrap().remove("auth");
    assert_rejected(hello, Code::Unauthenticated).await;
}

#[tokio::test]
async fn call_before_hello_is_rejected() {
    let (mut client, conn) = start();
    client.call(1, "echo", json!(1)).await;
    let (_, err) = client.recv_error().await;
    assert_eq!(err.code, Code::Unauthenticated);
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::Unauthenticated)
    );
}

#[tokio::test]
async fn wrong_header_version_is_version_mismatch() {
    let (mut client, conn) = start();
    let mut bytes = Frame::new(Kind::Hello, 0, b"{}".to_vec())
        .encode(u32::MAX)
        .unwrap();
    bytes[0] = 2;
    client.send_raw(bytes).await;
    let (_, err) = client.recv_error().await;
    assert_eq!(err.code, Code::VersionMismatch);
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::VersionMismatch)
    );
}

#[tokio::test(start_paused = true)]
async fn missing_hello_times_out() {
    let (mut client, conn) = start();
    assert_eq!(conn.closed().await, Closed::HelloTimeout);
    client.expect_closed().await;
}

#[tokio::test]
async fn call_returns_result_with_session() {
    let (mut client, _conn) = connected().await;
    client.call(7, "echo", json!({ "a": 1 })).await;
    assert_eq!(
        client.recv_result().await,
        (7, json!({ "input": { "a": 1 }, "session": "s-1" }))
    );
}

#[tokio::test]
async fn handler_error_carries_code_and_correlation_id() {
    let (mut client, _conn) = connected().await;
    client.call(3, "fail", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (3, Code::NotFound));
    assert!(!err.correlation_id.is_empty());
}

#[tokio::test]
async fn calls_run_concurrently_and_complete_out_of_order() {
    let (mut client, _conn) = connected().await;
    client.call(1, "wait", Value::Null).await;
    client.call(2, "open", Value::Null).await;
    let first = client.recv_result().await;
    let second = client.recv_result().await;
    assert_eq!(first, (2, json!("opened")));
    assert_eq!(second, (1, json!("waited")));
}

#[tokio::test]
async fn call_ids_must_increase_even_after_completion() {
    let (mut client, conn) = connected().await;
    client.call(5, "echo", json!(null)).await;
    assert_eq!(client.recv_result().await.0, 5);
    // Gaps are fine.
    client.call(9, "echo", json!(null)).await;
    assert_eq!(client.recv_result().await.0, 9);
    // A late Cancel for a finished call cannot reach anything: its id is never reused.
    client.send(Frame::new(Kind::Cancel, 5, vec![])).await;
    client.call(9, "echo", json!(null)).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::InvalidArgument));
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::InvalidArgument)
    );
}

#[tokio::test]
async fn a_lower_call_id_closes_connection() {
    let (mut client, conn) = connected().await;
    client.call(4, "echo", json!(null)).await;
    assert_eq!(client.recv_result().await.0, 4);
    client.call(3, "echo", json!(null)).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::InvalidArgument));
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::InvalidArgument)
    );
}

#[tokio::test]
async fn duplicate_in_flight_call_id_closes_connection() {
    let (mut client, conn) = connected().await;
    client.call(1, "wait", Value::Null).await;
    client.call(1, "echo", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::InvalidArgument));
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::InvalidArgument)
    );
}

#[tokio::test]
async fn call_on_id_zero_closes_connection() {
    let (mut client, conn) = connected().await;
    client.call(0, "echo", Value::Null).await;
    assert_eq!(client.recv_error().await.1.code, Code::InvalidArgument);
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::InvalidArgument)
    );
}

#[tokio::test]
async fn malformed_call_fails_only_that_call() {
    let (mut client, _conn) = connected().await;
    client
        .send(Frame::new(Kind::Call, 4, b"not json".to_vec()))
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (4, Code::InvalidArgument));
    client
        .send(Frame::binary(Kind::Call, 5, b"{}".to_vec()))
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (5, Code::InvalidArgument));
    // The connection keeps working.
    client.call(6, "echo", Value::Null).await;
    assert_eq!(client.recv_result().await.0, 6);
}

#[tokio::test]
async fn ping_is_answered_with_pong_echo() {
    let (mut client, _conn) = connected().await;
    client
        .send(Frame::binary(Kind::Ping, 0, vec![1, 2, 3]))
        .await;
    let pong = client.recv().await.unwrap();
    assert_eq!(pong, Frame::binary(Kind::Pong, 0, vec![1, 2, 3]));
}

#[tokio::test]
async fn oversize_frame_is_rejected_from_header_alone() {
    let (mut client, conn) = connected().await;
    let header = Header {
        kind: Kind::Call,
        flags: Flags::empty(),
        call_id: 1,
        payload_len: 1025,
    };
    // Only the header is sent; the server must not wait for the payload.
    client.send_raw(header.to_bytes().to_vec()).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::ResourceExhausted));
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::ResourceExhausted)
    );
}

#[tokio::test]
async fn oversize_result_becomes_resource_exhausted() {
    let (mut client, _conn) = connected().await;
    client.call(9, "big", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (9, Code::ResourceExhausted));
}

#[tokio::test]
async fn concurrency_limit_rejects_extra_calls() {
    let (mut client, _conn) = connected().await;
    for id in 1..=4 {
        client.call(id, "wait", Value::Null).await;
    }
    client.call(5, "echo", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!(
        (call_id, err.code, err.retryable),
        (5, Code::ResourceExhausted, true)
    );
}

#[tokio::test]
async fn handler_panic_is_internal_without_details() {
    let (mut client, _conn) = connected().await;
    client.call(2, "panic", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (2, Code::Internal));
    assert!(!err.message.contains("secret"));
    // The connection keeps working.
    client.call(3, "echo", Value::Null).await;
    assert_eq!(client.recv_result().await.0, 3);
}

#[tokio::test]
async fn server_goaway_is_sent_and_closes() {
    let (mut client, conn) = connected().await;
    conn.goaway(Code::Unauthenticated, "session revoked").await;
    let frame = client.recv().await.unwrap();
    assert_eq!((frame.kind, frame.call_id), (Kind::Goaway, 0));
    let goaway: Goaway = serde_json::from_slice(&frame.payload).unwrap();
    assert_eq!(goaway.code, Code::Unauthenticated);
    client.expect_closed().await;
    assert!(matches!(conn.closed().await, Closed::Goaway(g) if g == goaway));
}

#[tokio::test]
async fn client_goaway_closes() {
    let (mut client, conn) = connected().await;
    client
        .send_json(
            Kind::Goaway,
            0,
            json!({ "code": "Unavailable", "message": "bye" }),
        )
        .await;
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::PeerGoaway(Goaway {
            code: Code::Unavailable,
            message: "bye".into()
        })
    );
}

#[tokio::test]
async fn disconnect_drops_in_flight_calls() {
    let fixture = Fixture::default();
    let started = Arc::clone(&fixture.started);
    let dropped = Arc::clone(&fixture.dropped);
    let (mut client, conn) = start_with(fixture);
    client.send_json(Kind::Hello, 0, hello_json()).await;
    client.recv().await.unwrap();
    client.call(1, "wait", Value::Null).await;
    started.notified().await;
    client.tx.close().await.unwrap();
    assert_eq!(conn.closed().await, Closed::PeerClosed);
    assert!(dropped.load(Ordering::SeqCst));
}

// ---- subscriptions ----------------------------------------------------------------------

impl Client {
    async fn subscribe(&mut self, call_id: u32, procedure: &str, input: Value) {
        self.send_json(
            Kind::Subscribe,
            call_id,
            json!({ "procedure": procedure, "input": input }),
        )
        .await;
    }

    async fn cancel(&mut self, call_id: u32) {
        self.send(Frame::new(Kind::Cancel, call_id, Vec::new()))
            .await;
    }

    async fn unsubscribe(&mut self, call_id: u32) {
        self.send(Frame::new(Kind::Unsubscribe, call_id, Vec::new()))
            .await;
    }

    /// The next frames must be the events `values` for `call_id`, in order.
    async fn expect_events(&mut self, call_id: u32, values: std::ops::Range<u64>) {
        for value in values {
            let frame = self.recv().await.expect("Event, got close");
            assert_eq!(
                (frame.kind, frame.call_id),
                (Kind::Event, call_id),
                "{frame:?}"
            );
            assert!(!frame.flags.is_binary());
            assert_eq!(frame.payload, value.to_string().into_bytes());
        }
    }

    /// The next frame must be this Pong.
    async fn expect_pong(&mut self, id: u32) {
        self.send(Frame::new(Kind::Ping, id, Vec::new())).await;
        let frame = self.recv().await.expect("Pong, got close");
        assert_eq!((frame.kind, frame.call_id), (Kind::Pong, id), "{frame:?}");
    }
}

#[tokio::test]
async fn subscription_sends_events_in_order_then_a_null_result() {
    let (mut client, _conn) = connected().await;
    client.subscribe(1, "ticks", json!(5)).await;
    client.expect_events(1, 0..5).await;
    assert_eq!(client.recv_result().await, (1, Value::Null));
    client.expect_pong(0).await;
}

/// A dispatcher written before subscriptions existed: it only serves calls.
struct CallsOnly;

impl Dispatch for CallsOnly {
    fn call(
        &self,
        _session: Arc<Session>,
        _call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        Box::pin(async { Ok(json!("called")) })
    }
}

#[tokio::test]
async fn a_dispatcher_without_subscribe_answers_unimplemented() {
    // Review finding [7]: `Dispatch::subscribe` has a default, as before this change.
    let ((client_rx, client_tx), (server_rx, server_tx)) = memory(16);
    let _conn = Server::new(config(), TokenAuth, CallsOnly).serve(server_rx, server_tx);
    let mut client = Client {
        rx: client_rx,
        tx: client_tx,
        decoder: FrameDecoder::new(u32::MAX),
    };
    handshake(&mut client).await;
    client.subscribe(1, "anything", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::Unimplemented));
    client.call(2, "anything", Value::Null).await;
    assert_eq!(client.recv_result().await, (2, json!("called")));
}

#[tokio::test]
async fn a_finished_subscription_closes_sinks_it_left_behind() {
    // Review finding [1]: the scope fires when the handler returns, not only on cancel.
    let fixture = Fixture::default();
    let (started, orphan) = (Arc::clone(&fixture.started), Arc::clone(&fixture.orphan));
    let (mut client, _conn) = start_with(fixture);
    handshake(&mut client).await;
    client.subscribe(1, "orphan", Value::Null).await;
    assert_eq!(client.recv_result().await, (1, Value::Null));
    tokio::time::timeout(Duration::from_secs(5), started.notified())
        .await
        .expect("the left-behind sink's closed() resolves");
    assert_eq!(*orphan.lock().unwrap(), Some(Err(Code::Cancelled)));
    // And nothing it tried to send went out.
    client.expect_pong(0).await;
}

#[tokio::test]
async fn subscription_error_follows_its_events() {
    let (mut client, _conn) = connected().await;
    client.subscribe(1, "fail", json!(2)).await;
    client.expect_events(1, 0..2).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::FailedPrecondition));
    assert!(!err.correlation_id.is_empty());
}

#[tokio::test]
async fn subscribe_payload_is_checked_like_a_call() {
    let (mut client, _conn) = connected().await;
    client
        .send_json(Kind::Subscribe, 6, json!({ "topic": "x" }))
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (6, Code::InvalidArgument));
    client
        .send(Frame::binary(Kind::Subscribe, 7, b"{}".to_vec()))
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (7, Code::InvalidArgument));
    client.expect_pong(0).await;
}

#[tokio::test]
async fn subscriptions_share_the_concurrency_limit_with_calls() {
    let fixture = Fixture::default();
    let gate = Arc::clone(&fixture.gate);
    let (mut client, _conn) = start_with(fixture);
    handshake(&mut client).await;
    for id in 1..=2 {
        client.subscribe(id, "hold", json!(0)).await;
    }
    client.call(3, "wait", Value::Null).await;
    client.subscribe(4, "hold", json!(0)).await;
    // 4 in flight (the limit): the fifth, of either kind, is refused.
    client.subscribe(5, "hold", json!(0)).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (5, Code::ResourceExhausted));
    assert!(err.retryable);
    gate.notify_one();
    assert_eq!(client.recv_result().await, (3, json!("waited")));
    client.call(6, "echo", json!(6)).await;
    assert_eq!(client.recv_result().await.0, 6);
}

#[tokio::test(start_paused = true)]
async fn unsubscribe_discards_queued_events_and_silences_the_end() {
    let fixture = Fixture::default();
    let (started, dropped) = (Arc::clone(&fixture.started), Arc::clone(&fixture.dropped));
    // One chunk per transport direction and a 4-frame outbound queue (2 for subscription
    // frames): most of the 8 events wait in the engine.
    let mut config = config();
    config.outbound_queue_frames = 4;
    let (mut client, conn) = start_with_config(fixture, config, 1);
    handshake(&mut client).await;
    client.subscribe(1, "hold", json!(8)).await;
    started.notified().await;
    settle().await;
    // Unsubscribe and Ping in one chunk: everything after the Pong is for other ids.
    let mut bytes = Frame::new(Kind::Unsubscribe, 1, Vec::new())
        .encode(u32::MAX)
        .unwrap();
    Frame::new(Kind::Ping, 9, Vec::new())
        .encode_into(&mut bytes, u32::MAX)
        .unwrap();
    client.send_raw(bytes).await;
    // Events already handed to the transport may still arrive, in order, before the Pong.
    let mut next_event = 0;
    loop {
        let frame = client.recv().await.expect("Pong, got close");
        if frame.kind == Kind::Pong {
            assert_eq!(frame.call_id, 9);
            break;
        }
        assert_eq!((frame.kind, frame.call_id), (Kind::Event, 1), "{frame:?}");
        assert_eq!(frame.payload, next_event.to_string().into_bytes());
        next_event += 1;
    }
    assert!(next_event < 8, "queued events were discarded");
    // The handler saw the end and returned Ok, which is not sent.
    settle().await;
    assert!(dropped.load(Ordering::SeqCst));
    client.expect_pong(10).await;
    client.call(2, "echo", json!(2)).await;
    assert_eq!(client.recv_result().await.0, 2);
    drop(conn);
}

#[tokio::test(start_paused = true)]
async fn unsubscribe_after_the_handler_returned_drops_its_waiting_frames() {
    // Review finding [2]. One chunk per transport direction and a 4-frame outbound queue, and the
    // peer reads nothing: the handler sends 8 events and returns, so most of them and its end
    // frame are still waiting in the engine when the Unsubscribe arrives.
    let mut config = config();
    config.outbound_queue_frames = 4;
    let (mut client, _conn) = start_with_config(Fixture::default(), config, 1);
    handshake(&mut client).await;
    client.subscribe(1, "ticks", json!(8)).await;
    settle().await;
    let mut bytes = Frame::new(Kind::Unsubscribe, 1, Vec::new())
        .encode(u32::MAX)
        .unwrap();
    Frame::new(Kind::Ping, 9, Vec::new())
        .encode_into(&mut bytes, u32::MAX)
        .unwrap();
    client.send_raw(bytes).await;
    // Frames already handed to the outbound queue are in flight; the end is not among them.
    let mut next_event = 0;
    loop {
        let frame = client.recv().await.expect("Pong, got close");
        if frame.kind == Kind::Pong {
            break;
        }
        assert_eq!((frame.kind, frame.call_id), (Kind::Event, 1), "{frame:?}");
        assert_eq!(frame.payload, next_event.to_string().into_bytes());
        next_event += 1;
    }
    assert!(next_event < 8, "waiting events were dropped");
    // Nothing more for id 1: not the remaining events, not its Result.
    client.expect_pong(10).await;
    client.call(2, "echo", json!(2)).await;
    assert_eq!(client.recv_result().await.0, 2);
}

#[tokio::test]
async fn unsubscribe_rules() {
    let (mut client, _conn) = connected().await;
    // Unknown and finished ids are ignored: the subscription already ended.
    client.unsubscribe(42).await;
    client.subscribe(1, "ticks", json!(1)).await;
    client.expect_events(1, 0..1).await;
    client.recv_result().await;
    client.unsubscribe(1).await;
    // On a call it is ignored too; the call still answers.
    client.call(2, "echo", json!(2)).await;
    client.unsubscribe(2).await;
    assert_eq!(client.recv_result().await.0, 2);
    client.expect_pong(0).await;
    // Call id 0 is a violation.
    client.unsubscribe(0).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::InvalidArgument));
    client.expect_closed().await;
}

#[tokio::test]
async fn cancel_ends_a_subscription_after_its_queued_events() {
    let fixture = Fixture::default();
    let started = Arc::clone(&fixture.started);
    let (mut client, _conn) = start_with(fixture);
    handshake(&mut client).await;
    client.subscribe(1, "hold", json!(3)).await;
    started.notified().await;
    client.cancel(1).await;
    client.expect_events(1, 0..3).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::Cancelled));
}

#[tokio::test(start_paused = true)]
async fn events_in_the_outbound_queue_count_against_the_buffer() {
    // Review finding [3]. The peer reads nothing and the transport holds one chunk; the 64-frame
    // outbound queue would take 32 events. They count until the writer hands them over, so the
    // subscription ends after the 8-event buffer plus the one event the transport took.
    let (mut client, _conn) = start_with_capacity(Fixture::default(), 1);
    handshake(&mut client).await;
    client.subscribe(1, "trickle", Value::Null).await;
    settle().await;
    client.expect_events(1, 0..9).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::ResourceExhausted));
    assert_eq!(err.message, "subscription event buffer is full");
}

#[tokio::test]
async fn full_buffer_ends_the_subscription_with_resource_exhausted() {
    let (mut client, _conn) = connected().await;
    // The handler never yields, so nothing is forwarded while it sends: exactly the buffer
    // (8 events) is accepted, the ninth ends the subscription.
    client.subscribe(1, "flood", Value::Null).await;
    client.expect_events(1, 0..8).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::ResourceExhausted));
    assert_eq!(err.message, "subscription event buffer is full");
    client.expect_pong(0).await;
}

#[tokio::test]
async fn event_over_the_frame_limit_ends_the_subscription() {
    let (mut client, _conn) = connected().await;
    client.subscribe(1, "huge", Value::Null).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::ResourceExhausted));
    assert_eq!(err.message, "event exceeds the frame size limit");
    client.expect_pong(0).await;
}

#[tokio::test(start_paused = true)]
async fn busy_subscription_leaves_room_for_call_answers() {
    // An 8-frame outbound queue: subscription frames may use 4 of it.
    let mut config = config();
    config.outbound_queue_frames = 8;
    config.max_concurrent_calls = 16;
    config.subscription_buffer_events = 64;
    let fixture = Fixture::default();
    let started = Arc::clone(&fixture.started);
    let (mut client, conn) = start_with_config(fixture, config, 1);
    handshake(&mut client).await;
    client.subscribe(1, "hold", json!(40)).await;
    started.notified().await;
    settle().await;
    // The client reads nothing yet. Four answers fit in the room events left free.
    for id in 2..=5 {
        client.call(id, "echo", json!(id)).await;
    }
    settle().await;
    let mut results = 0;
    let mut events = 0;
    while results < 4 {
        let frame = client.recv().await.expect("connection stays open");
        match frame.kind {
            Kind::Result => results += 1,
            Kind::Event => {
                assert_eq!(frame.payload, events.to_string().into_bytes());
                events += 1;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    client.expect_events(1, events..40).await;
    client.cancel(1).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::Cancelled));
    drop(conn);
}

#[tokio::test(start_paused = true)]
async fn a_one_frame_outbound_queue_still_leaves_room_for_answers() {
    // Review finding [9a]: with one slot, an event could take it and the next call answer would
    // close the connection as a slow consumer. The engine raises the queue to two slots.
    let mut config = config();
    config.outbound_queue_frames = 1;
    let fixture = Fixture::default();
    let started = Arc::clone(&fixture.started);
    let (mut client, conn) = start_with_config(fixture, config, 1);
    handshake(&mut client).await;
    client.subscribe(1, "hold", json!(8)).await;
    started.notified().await;
    settle().await;
    // The client reads nothing yet; the answer fits in the slot events left free.
    client.call(2, "echo", json!(2)).await;
    settle().await;
    let mut events = 0;
    loop {
        let frame = client.recv().await.expect("connection stays open");
        match frame.kind {
            Kind::Result => {
                assert_eq!(frame.call_id, 2);
                break;
            }
            Kind::Event => {
                assert_eq!(frame.payload, events.to_string().into_bytes());
                events += 1;
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    client.expect_events(1, events..8).await;
    client.cancel(1).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (1, Code::Cancelled));
    drop(conn);
}

#[tokio::test]
async fn disconnect_cancels_subscriptions() {
    let fixture = Fixture::default();
    let (started, dropped) = (Arc::clone(&fixture.started), Arc::clone(&fixture.dropped));
    let (mut client, conn) = start_with(fixture);
    handshake(&mut client).await;
    client.subscribe(1, "hold", json!(0)).await;
    started.notified().await;
    client.tx.close().await.unwrap();
    assert_eq!(conn.closed().await, Closed::PeerClosed);
    assert!(dropped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn server_only_kinds_from_client_close_connection() {
    for kind in [
        Kind::HelloAck,
        Kind::Result,
        Kind::Error,
        Kind::Chunk,
        Kind::StreamEnd,
        Kind::Event,
        Kind::Hello,
    ] {
        let (mut client, conn) = connected().await;
        client.send(Frame::new(kind, 1, b"{}".to_vec())).await;
        let (call_id, _) = client.recv_error().await;
        assert_eq!(call_id, 0);
        client.expect_closed().await;
        assert!(
            matches!(conn.closed().await, Closed::ProtocolViolation(_)),
            "{kind:?}"
        );
    }
}

async fn handshake(client: &mut Client) {
    client.send_json(Kind::Hello, 0, hello_json()).await;
    assert_eq!(client.recv().await.unwrap().kind, Kind::HelloAck);
}

/// `n` Ping frames coalesced into one transport chunk.
fn pings(n: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    for i in 0..n {
        Frame::binary(Kind::Ping, 0, vec![i as u8])
            .encode_into(&mut bytes, u32::MAX)
            .unwrap();
    }
    bytes
}

/// Lets the server task process everything sent so far (time is paused, so this only advances
/// once every task is idle).
async fn settle() {
    tokio::time::sleep(Duration::from_millis(10)).await;
}

#[tokio::test(start_paused = true)]
async fn goaway_completes_while_peer_never_reads() {
    // Review repro: 49 coalesced Pings over memory(2), and the client never reads the Pongs.
    let (mut client, conn) = start_with_capacity(Fixture::default(), 2);
    handshake(&mut client).await;
    client.send_raw(pings(49)).await;
    settle().await;
    let closed = tokio::time::timeout(Duration::from_secs(1), async {
        conn.goaway(Code::Unavailable, "shutting down").await;
        conn.closed().await
    })
    .await
    .expect("goaway/closed blocked by a peer that does not read");
    assert!(matches!(closed, Closed::Goaway(_)), "{closed:?}");
    // The transport is dropped: the client drains what was delivered, then sees the close.
    while client.recv().await.is_some() {}
}

#[tokio::test(start_paused = true)]
async fn peer_that_never_reads_is_disconnected() {
    // More Pongs than the transport and the outbound queue (64 frames) can hold.
    let (mut client, conn) = start_with_capacity(Fixture::default(), 2);
    handshake(&mut client).await;
    client.send_raw(pings(200)).await;
    settle().await;
    let closed = tokio::time::timeout(Duration::from_secs(1), async {
        conn.goaway(Code::Unavailable, "shutting down").await;
        conn.closed().await
    })
    .await
    .expect("connection wedged by a slow peer");
    assert_eq!(closed, Closed::SlowConsumer);
    while client.recv().await.is_some() {}
}

#[tokio::test]
async fn pre_handshake_frames_use_the_hello_limit() {
    let (mut client, conn) = start();
    // 513 bytes: above max_hello_bytes (512) but below max_frame_bytes (1024).
    let header = Header {
        kind: Kind::Hello,
        flags: Flags::empty(),
        call_id: 0,
        payload_len: 513,
    };
    client.send_raw(header.to_bytes().to_vec()).await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (0, Code::ResourceExhausted));
    client.expect_closed().await;
    assert_eq!(
        conn.closed().await,
        Closed::ProtocolViolation(Code::ResourceExhausted)
    );
}

#[tokio::test]
async fn frame_limit_applies_once_the_session_exists() {
    let (mut client, _conn) = start();
    // Hello and a 1000-byte Ping in one chunk: the Ping's header is parsed after HelloAck.
    let mut bytes = Frame::new(Kind::Hello, 0, serde_json::to_vec(&hello_json()).unwrap())
        .encode(u32::MAX)
        .unwrap();
    Frame::binary(Kind::Ping, 0, vec![7; 1000])
        .encode_into(&mut bytes, u32::MAX)
        .unwrap();
    client.send_raw(bytes).await;
    assert_eq!(client.recv().await.unwrap().kind, Kind::HelloAck);
    assert_eq!(
        client.recv().await.unwrap(),
        Frame::binary(Kind::Pong, 0, vec![7; 1000])
    );
}

#[tokio::test(start_paused = true)]
async fn hung_authentication_times_out() {
    let (mut client, conn) = start();
    let mut hello = hello_json();
    hello["auth"] = json!("hang");
    client.send_json(Kind::Hello, 0, hello).await;
    assert_eq!(conn.closed().await, Closed::HelloTimeout);
    client.expect_closed().await;
}

#[tokio::test]
async fn correlation_ids_use_a_random_connection_prefix() {
    let mut prefixes = Vec::new();
    for _ in 0..2 {
        let (mut client, _conn) = connected().await;
        client.call(3, "fail", Value::Null).await;
        let (_, err) = client.recv_error().await;
        let (prefix, call) = err.correlation_id.split_once('-').unwrap();
        assert_eq!((prefix.len(), call), (16, "3"));
        prefixes.push(prefix.to_owned());
    }
    assert_ne!(prefixes[0], prefixes[1]);
}
