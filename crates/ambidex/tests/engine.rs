//! Protocol engine tests over the in-memory transport.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Header, Kind};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{
    Authenticate, Call, Closed, Code, Connection, Dispatch, ErrorPayload, Flags, Goaway, Hello,
    HelloAck, Server, ServerConfig, Session,
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
}

fn config() -> ServerConfig {
    let mut config = ServerConfig::new("dbee", SCHEMA, "9.9.9");
    config.max_frame_bytes = 1024;
    config.max_hello_bytes = 512;
    config.max_concurrent_calls = 4;
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
    let ((client_rx, client_tx), (server_rx, server_tx)) = memory(capacity);
    let server = Server::new(config(), TokenAuth, fixture);
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
async fn call_ids_may_be_reused_after_completion() {
    let (mut client, _conn) = connected().await;
    for _ in 0..3 {
        client.call(5, "echo", json!(null)).await;
        assert_eq!(client.recv_result().await.0, 5);
    }
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

#[tokio::test]
async fn subscribe_is_unimplemented() {
    let (mut client, _conn) = connected().await;
    client
        .send_json(Kind::Subscribe, 6, json!({ "topic": "x" }))
        .await;
    let (call_id, err) = client.recv_error().await;
    assert_eq!((call_id, err.code), (6, Code::Unimplemented));
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
