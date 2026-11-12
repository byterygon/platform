//! Streams: ordered binary chunks with credit-based backpressure, then one typed result (Ambidex
//! spec §5 and §6).
//!
//! A client starts a stream with a `Call` frame, like a query. The procedure's handler runs like a
//! call's: same session and principal, same authorization, approvals and audit, same
//! [`CallScope`] (deadline, cancellation token, `cancel_grace`). It writes chunks to a
//! [`BinarySink`]; each becomes one `Chunk` frame on the call's id, with the binary flag, in
//! order. The stream then ends with exactly one terminal frame, after every chunk sent before it:
//!
//! - `StreamEnd` carrying the handler's result as JSON when it returns `Ok`;
//! - `Error` when it returns an error or its token fired (`Cancel`, deadline, a chunk larger than
//!   the frame limit), exactly as for calls. A stream refused before its handler ran (unknown
//!   procedure, denied, approval required) answers `Error` without any chunk.
//!
//! Session revocation, Goaway and disconnect end streams the way they end calls.
//!
//! # Credits
//!
//! The client decides how fast chunks come. Every stream starts with
//! [`ServerConfig::stream_initial_credits`] credits (4, spec §6); [`BinarySink::send`] takes one
//! credit per chunk and waits when none is left, until the client grants more with a `Credit`
//! frame on the call's id, payload `{"chunks": n}` (JSON, `n >= 1`). So the server holds at most
//! the granted window of chunks per stream, whatever the handler produces, and a slow consumer
//! slows the handler down instead of filling memory. Terminal frames need no credit.
//!
//! A `Credit` for a call that is not in flight (finished, or never started) is ignored: it lost
//! the race with the stream's end. These are protocol violations that close the connection:
//! `Credit` on call id 0, a payload that is not `{"chunks": n}` with `n >= 1`, and a grant that
//! would leave a call more than [`ServerConfig::stream_max_credits`] unused credits (the bound on
//! what one stream can make the server buffer).
//!
//! Chunks wait for the transport in the same per-connection queue as subscription events, which
//! may use at most half of the outbound queue (see [`crate::engine`]), so a stream cannot crowd
//! out call answers.
//!
//! # Outside the engine
//!
//! A stream needs a connection to carry its chunks. Called directly through
//! [`Router::call`](crate::Router::call) (for example by the MCP adapter) a stream procedure is
//! authorized and then answered with `Unimplemented`.
//!
//! [`ServerConfig::stream_initial_credits`]: crate::ServerConfig::stream_initial_credits
//! [`ServerConfig::stream_max_credits`]: crate::ServerConfig::stream_max_credits

use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::{Semaphore, mpsc};

use crate::cancel::CallScope;
use crate::error::{IntoErrorPayload, NoDetails, RpcError};
use crate::frame::{Frame, Kind};
use crate::message::{Code, ErrorPayload};
use crate::subscription::Queued;

/// The credit window of one call, shared by the connection (which grants) and the call's
/// [`Chunks`] (which spends).
pub(crate) struct Credits {
    available: Semaphore,
    max: usize,
    /// Set once the dispatcher runs the call as a stream: its end is then a `StreamEnd`, sent
    /// after its chunks.
    opened: AtomicBool,
}

impl Credits {
    pub(crate) fn new(initial: u32, max: u32) -> Arc<Credits> {
        let max = (max.max(1) as usize).min(Semaphore::MAX_PERMITS);
        Arc::new(Credits {
            available: Semaphore::new((initial as usize).min(max)),
            max,
            opened: AtomicBool::new(false),
        })
    }

    /// Adds `chunks` credits; `false` when the unused credits would exceed the maximum. Only the
    /// connection task grants, so the check cannot race with another grant.
    pub(crate) fn grant(&self, chunks: u64) -> bool {
        let unused = self.available.available_permits() as u64;
        if chunks > (self.max as u64).saturating_sub(unused) {
            return false;
        }
        self.available.add_permits(chunks as usize);
        true
    }

    pub(crate) fn is_open(&self) -> bool {
        self.opened.load(Ordering::SeqCst)
    }
}

/// Where a stream's chunks go: the engine's side, untyped.
///
/// [`Dispatch::call_stream`](crate::Dispatch::call_stream) receives one per `Call`; a dispatcher
/// that runs the call as a stream calls [`Chunks::open`] and hands it to the handler, which uses
/// the [`BinarySink`] built on it. Cheap to clone; clones feed the same stream.
#[derive(Clone)]
pub struct Chunks {
    inner: Arc<ChunksInner>,
}

struct ChunksInner {
    call_id: u32,
    scope: CallScope,
    queue: mpsc::UnboundedSender<Queued>,
    credits: Arc<Credits>,
    max_frame_bytes: u32,
}

impl Chunks {
    pub(crate) fn new(
        call_id: u32,
        scope: CallScope,
        queue: mpsc::UnboundedSender<Queued>,
        credits: Arc<Credits>,
        max_frame_bytes: u32,
    ) -> Chunks {
        Chunks {
            inner: Arc::new(ChunksInner {
                call_id,
                scope,
                queue,
                credits,
                max_frame_bytes,
            }),
        }
    }

    /// Marks the call as a stream: a successful end is sent as `StreamEnd` instead of `Result`.
    /// The dispatcher calls it when it is about to run a stream handler.
    pub fn open(&self) {
        self.inner.credits.opened.store(true, Ordering::SeqCst);
    }

    /// Sends one chunk, waiting for a credit first.
    ///
    /// Fails once the stream is over, with the reason: `Cancelled` (Cancel, disconnect,
    /// revocation), `DeadlineExceeded`, or `ResourceExhausted` when this chunk exceeds the frame
    /// limit, which ends the stream.
    pub async fn send(&self, chunk: Vec<u8>) -> Result<(), StreamEnded> {
        let inner = &*self.inner;
        if let Some(code) = inner.scope.check() {
            return Err(StreamEnded { code });
        }
        if chunk.len() > inner.max_frame_bytes as usize {
            return Err(self.fail(
                Code::ResourceExhausted,
                "chunk exceeds the frame size limit",
            ));
        }
        tokio::select! {
            biased;
            () = inner.scope.cancelled() => {
                return Err(StreamEnded {
                    code: inner.scope.reason().unwrap_or(Code::Cancelled),
                });
            }
            permit = inner.credits.available.acquire() => match permit {
                // Spent: the client grants a new one when it has consumed a chunk.
                Ok(permit) => permit.forget(),
                // The semaphore is never closed.
                Err(_) => return Err(StreamEnded { code: Code::Cancelled }),
            },
        }
        // The deadline may have passed while waiting for the credit.
        if let Some(code) = inner.scope.check() {
            return Err(StreamEnded { code });
        }
        let bytes = Frame::binary(Kind::Chunk, inner.call_id, chunk)
            .encode(inner.max_frame_bytes)
            .expect("payload checked against the frame limit");
        let queued = Queued {
            call_id: inner.call_id,
            bytes,
            held: None,
            stream: true,
        };
        // The receiver lives as long as the connection; once it is gone the token has fired.
        inner.queue.send(queued).map_err(|_| StreamEnded {
            code: Code::Cancelled,
        })
    }

    /// Whether the stream is over (its token fired); later chunks are refused.
    pub fn is_closed(&self) -> bool {
        self.inner.scope.is_cancelled()
    }

    /// Resolves once the stream is over.
    pub async fn closed(&self) {
        self.inner.scope.cancelled().await
    }

    /// Ends the stream with `code` (the first reason wins) and reports why it is over.
    fn fail(&self, code: Code, message: &'static str) -> StreamEnded {
        self.inner.scope.fail(code, message);
        StreamEnded {
            code: self.inner.scope.reason().unwrap_or(code),
        }
    }
}

impl fmt::Debug for Chunks {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Chunks")
            .field("call_id", &self.inner.call_id)
            .field("closed", &self.is_closed())
            .finish()
    }
}

/// A stream handler's chunk sink (spec §6): the last argument of a `#[rpc::stream]` method.
///
/// ```text
/// #[rpc::stream(perm = "files.read", risk = Risk::Read)]
/// async fn download(&self, ctx: Ctx, input: FileId, sink: BinarySink) -> Result<Summary, RpcError> {
///     let mut bytes = 0;
///     while let Some(block) = self.files.next_block(&input).await {
///         bytes += block.len() as u64;
///         sink.send(block).await?;   // waits for a credit; Err once the stream is over
///     }
///     Ok(Summary { bytes })          // ends it with StreamEnd
/// }
/// ```
///
/// `send` waits until the client has room (see the [module docs](self)), so a handler that pulls
/// its source only before each `send` never buffers more than one chunk itself. It fails once the
/// stream is over, so a loop that uses `?` stops by itself on Cancel, deadline or disconnect.
/// Whatever the handler returns after that, the client gets the reason. `?` converts
/// [`StreamEnded`] into `RpcError<E>`; a handler with another error type maps it (any value will
/// do, it is never sent).
///
/// Chunks are opaque bytes here. Arrow IPC encoding is layered on top of this sink.
#[derive(Clone)]
pub struct BinarySink {
    chunks: Chunks,
}

impl BinarySink {
    pub fn new(chunks: Chunks) -> BinarySink {
        BinarySink { chunks }
    }

    /// Sends one chunk as one `Chunk` frame, waiting for a credit first.
    pub async fn send(&self, chunk: impl Into<Vec<u8>>) -> Result<(), StreamEnded> {
        self.chunks.send(chunk.into()).await
    }

    /// Whether the stream is over; later chunks are refused.
    pub fn is_closed(&self) -> bool {
        self.chunks.is_closed()
    }

    /// Resolves once the stream is over (Cancel, deadline, disconnect), for handlers that wait
    /// for something other than `send`.
    pub async fn closed(&self) {
        self.chunks.closed().await
    }
}

impl fmt::Debug for BinarySink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_tuple("BinarySink").field(&self.chunks).finish()
    }
}

/// [`BinarySink::send`] refused a chunk: the stream is over, for this reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StreamEnded {
    code: Code,
}

impl StreamEnded {
    /// `Cancelled`, `DeadlineExceeded` or `ResourceExhausted`.
    pub fn code(&self) -> Code {
        self.code
    }
}

impl fmt::Display for StreamEnded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "stream ended ({:?})", self.code)
    }
}

impl std::error::Error for StreamEnded {}

/// The client never sees this error: once a stream is over, its answer is the reason the token
/// fired.
impl IntoErrorPayload for StreamEnded {
    type Details = NoDetails;

    fn into_error_payload(self) -> ErrorPayload {
        ErrorPayload::new(self.code, "stream ended")
    }
}

/// Lets a handler whose error type is `RpcError<E>` use `?` on [`BinarySink::send`].
impl<E> From<StreamEnded> for RpcError<E> {
    fn from(ended: StreamEnded) -> Self {
        RpcError::new(ended.code, "stream ended")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunks(initial: u32, max: u32) -> (Chunks, Arc<Credits>, mpsc::UnboundedReceiver<Queued>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let credits = Credits::new(initial, max);
        let scope = CallScope::new(None);
        (
            Chunks::new(7, scope, tx, Arc::clone(&credits), 64),
            credits,
            rx,
        )
    }

    #[tokio::test]
    async fn send_spends_a_credit_and_waits_without_one() {
        let (chunks, credits, mut rx) = chunks(2, 8);
        chunks.send(b"a".to_vec()).await.unwrap();
        chunks.send(b"b".to_vec()).await.unwrap();
        let third = chunks.send(b"c".to_vec());
        tokio::pin!(third);
        // No credit left: the send is pending and nothing more was queued.
        assert!(futures_now(&mut third).await.is_none());
        assert!(rx.try_recv().is_ok() && rx.try_recv().is_ok() && rx.try_recv().is_err());
        assert!(credits.grant(1));
        third.await.unwrap();
        let queued = rx.try_recv().unwrap();
        assert!(queued.stream && queued.held.is_none());
        let mut decoder = crate::frame::FrameDecoder::new(64);
        decoder.push(&queued.bytes);
        let frame = decoder.next_frame().unwrap().unwrap();
        assert_eq!((frame.kind, frame.call_id), (Kind::Chunk, 7));
        assert!(frame.flags.is_binary());
        assert_eq!(frame.payload, b"c");
    }

    #[tokio::test]
    async fn grants_beyond_the_maximum_are_refused() {
        let (_chunks, credits, _rx) = chunks(4, 8);
        assert!(credits.grant(4));
        assert!(!credits.grant(1), "8 unused credits is the maximum");
        assert!(!credits.grant(u64::MAX));
    }

    #[tokio::test]
    async fn an_oversized_chunk_ends_the_stream() {
        let (chunks, _credits, mut rx) = chunks(4, 8);
        let err = chunks.send(vec![0; 65]).await.unwrap_err();
        assert_eq!(err.code(), Code::ResourceExhausted);
        assert!(chunks.is_closed());
        assert_eq!(
            chunks.send(vec![0; 1]).await.unwrap_err().code(),
            Code::ResourceExhausted
        );
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn a_send_waiting_for_credit_ends_when_the_stream_is_cancelled() {
        let (tx, _rx) = mpsc::unbounded_channel();
        let scope = CallScope::new(None);
        let chunks = Chunks::new(1, scope.clone(), tx, Credits::new(0, 8), 64);
        let (result, ()) = tokio::join!(chunks.send(b"a".to_vec()), async { scope.cancel() });
        assert_eq!(result.unwrap_err().code(), Code::Cancelled);
    }

    /// Polls once: `Some` if the future is ready.
    async fn futures_now<F: std::future::Future + Unpin>(fut: &mut F) -> Option<F::Output> {
        tokio::select! {
            biased;
            out = fut => Some(out),
            () = std::future::ready(()) => None,
        }
    }
}
