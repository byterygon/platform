//! A raw protocol client over any harness's [`Wire`].
//!
//! It speaks frames, not procedures, so cases can also send what a well-behaved client never
//! would (bad headers, reused call ids, frames split across chunks).

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::time::Duration;

use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::{Call, Code, ErrorPayload, Goaway, HelloAck};
use serde_json::{Value, json};

use crate::fixture::{API, SCHEMA_HASH};

/// Upper bound for any single wait in a case. Only a broken implementation gets near it; every
/// expectation is about what arrives, not when.
pub const RECV_TIMEOUT: Duration = Duration::from_secs(10);

pub type LocalBoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The client's end of one transport connection, as the transport presents it to a real client
/// (a WebSocket, a Tauri invoke plus Channel, an in-memory pipe).
pub trait Wire {
    /// Sends one chunk of bytes as the transport's unit (one WebSocket message, one invoke).
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, io::Result<()>>;

    /// Next chunk from the server, or `None` once the server has closed the connection and every
    /// chunk it sent was returned.
    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>>;

    /// Closes the connection from the client side (tab closed, webview closed the connection).
    fn close(&mut self) -> LocalBoxFuture<'_, ()>;
}

/// A protocol client on one connection.
pub struct Client {
    wire: Box<dyn Wire>,
    decoder: FrameDecoder,
    /// `Hello.auth` the transport requires (e.g. the web session's anti-CSRF token).
    auth: Option<Value>,
}

impl Client {
    pub fn new(wire: Box<dyn Wire>, auth: Option<Value>) -> Client {
        Client {
            wire,
            decoder: FrameDecoder::new(u32::MAX),
            auth,
        }
    }

    /// Sends raw bytes as one chunk.
    pub async fn send_bytes(&mut self, bytes: Vec<u8>) {
        self.wire
            .send(bytes)
            .await
            .expect("transport accepts bytes");
    }

    /// Sends `frames` encoded back to back in one chunk, so the engine reads them in one go.
    pub async fn send(&mut self, frames: &[Frame]) {
        let bytes = frames.iter().flat_map(encode).collect();
        self.send_bytes(bytes).await;
    }

    /// A Hello for the fixture API with this transport's auth.
    pub fn hello_frame(&self) -> Frame {
        hello_frame(SCHEMA_HASH, self.auth.clone())
    }

    pub async fn hello(&mut self) {
        let hello = self.hello_frame();
        self.send(&[hello]).await;
    }

    /// Hello, then HelloAck.
    pub async fn handshake(&mut self) -> HelloAck {
        self.hello().await;
        let frame = self.recv().await.expect("HelloAck");
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::HelloAck, 0),
            "{frame:?}"
        );
        serde_json::from_slice(&frame.payload).expect("HelloAck payload")
    }

    pub async fn call(&mut self, call_id: u32, procedure: &str, input: Value) {
        self.send(&[call_frame(call_id, procedure, input, None)])
            .await;
    }

    pub async fn call_with_timeout(
        &mut self,
        call_id: u32,
        procedure: &str,
        input: Value,
        timeout_ms: u64,
    ) {
        self.send(&[call_frame(call_id, procedure, input, Some(timeout_ms))])
            .await;
    }

    pub async fn cancel(&mut self, call_id: u32) {
        self.send(&[cancel_frame(call_id)]).await;
    }

    /// Next frame from the server, or `None` once it closed the connection.
    ///
    /// # Panics
    ///
    /// If nothing arrives within [`RECV_TIMEOUT`].
    pub async fn recv(&mut self) -> Option<Frame> {
        let next = async {
            loop {
                if let Some(frame) = self.decoder.next_frame().expect("server frames decode") {
                    return Some(frame);
                }
                let bytes = self.wire.recv().await?;
                self.decoder.push(&bytes);
            }
        };
        tokio::time::timeout(RECV_TIMEOUT, next)
            .await
            .expect("server did not answer in time")
    }

    /// The next frame must be a Result for `call_id`; returns its value.
    pub async fn expect_result(&mut self, call_id: u32) -> Value {
        let frame = self.recv().await.expect("Result, got close");
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::Result, call_id),
            "{frame:?}"
        );
        serde_json::from_slice(&frame.payload).expect("Result payload")
    }

    /// The next frame must be an Error for `call_id`; returns its payload.
    pub async fn expect_error(&mut self, call_id: u32) -> ErrorPayload {
        let frame = self.recv().await.expect("Error, got close");
        assert_eq!(
            (frame.kind, frame.call_id),
            (Kind::Error, call_id),
            "{frame:?}"
        );
        serde_json::from_slice(&frame.payload).expect("Error payload")
    }

    /// The next frame must be an Error with `code` for `call_id`.
    pub async fn expect_code(&mut self, call_id: u32, code: Code) -> ErrorPayload {
        let err = self.expect_error(call_id).await;
        assert_eq!(err.code, code, "{err:?}");
        err
    }

    /// The next frame must be a Goaway; returns it.
    pub async fn expect_goaway(&mut self) -> Goaway {
        let frame = self.recv().await.expect("Goaway, got close");
        assert_eq!((frame.kind, frame.call_id), (Kind::Goaway, 0), "{frame:?}");
        serde_json::from_slice(&frame.payload).expect("Goaway payload")
    }

    /// The server must close the connection without sending anything else.
    pub async fn expect_closed(&mut self) {
        if let Some(frame) = self.recv().await {
            panic!("expected the connection to close, got {frame:?}");
        }
    }

    /// A connection-level rejection: Error with `code` on call 0, then close.
    pub async fn expect_fatal(&mut self, code: Code) {
        self.expect_code(0, code).await;
        self.expect_closed().await;
    }

    /// Proves the connection still works and that nothing else was queued before the Pong:
    /// Ping must be answered by exactly its Pong.
    pub async fn expect_alive(&mut self, ping_id: u32) {
        self.send(&[Frame::new(Kind::Ping, ping_id, b"alive".to_vec())])
            .await;
        let frame = self.recv().await.expect("Pong, got close");
        assert_eq!(
            (frame.kind, frame.call_id, frame.payload.as_slice()),
            (Kind::Pong, ping_id, b"alive".as_slice()),
            "{frame:?}"
        );
    }

    /// Closes the connection from the client side.
    pub async fn disconnect(mut self) {
        self.wire.close().await;
    }
}

pub fn encode(frame: &Frame) -> Vec<u8> {
    frame.encode(u32::MAX).expect("test frames encode")
}

pub fn hello_frame(schema_hash: &str, auth: Option<Value>) -> Frame {
    let mut hello = json!({
        "protocol": 1,
        "api": API,
        "schema_hash": schema_hash,
        "client_version": "0.0.0-conformance",
    });
    if let Some(auth) = auth {
        hello["auth"] = auth;
    }
    json_frame(Kind::Hello, 0, &hello)
}

pub fn call_frame(call_id: u32, procedure: &str, input: Value, timeout_ms: Option<u64>) -> Frame {
    let call = Call {
        procedure: procedure.into(),
        input,
        timeout_ms,
    };
    json_frame(Kind::Call, call_id, &call)
}

pub fn cancel_frame(call_id: u32) -> Frame {
    Frame::new(Kind::Cancel, call_id, Vec::new())
}

pub fn json_frame(kind: Kind, call_id: u32, value: &impl serde::Serialize) -> Frame {
    Frame::new(
        kind,
        call_id,
        serde_json::to_vec(value).expect("JSON encodes"),
    )
}
