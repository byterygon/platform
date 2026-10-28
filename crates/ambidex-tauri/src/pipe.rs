//! The IPC byte pipe (Ambidex spec §4).
//!
//! Client frames arrive as raw-body invokes and are queued for the engine; server frames leave
//! through a [`FrameSink`], which the plugin backs with one Tauri `Channel` per connection. Bytes
//! are passed through unchanged: chunk boundaries need not match frame boundaries, and nothing
//! here looks inside them.
//!
//! The inbound side is cut explicitly, not by dropping senders: dropping its [`Inbound`] revokes
//! it. From then on pending and later `send`s fail, and the engine's next read fails without
//! returning chunks still queued. The engine then closes the connection and cancels its calls.
//! The outbound side carries whatever the engine still writes while closing (e.g. Goaway).

use std::io;

use ambidex::transport::{TransportRx, TransportTx};
use tokio::sync::{mpsc, watch};

/// Where server frames go. The plugin implements it with a Tauri `Channel` carrying raw bytes,
/// which the webview receives as an `ArrayBuffer`.
pub trait FrameSink: Send + Sync + 'static {
    fn send(&self, bytes: Vec<u8>) -> io::Result<()>;
}

/// The transport's end of the inbound queue, kept while the connection is open. Dropping it
/// revokes the pipe.
pub(crate) struct Inbound {
    queue: mpsc::Sender<Vec<u8>>,
    revoked: watch::Sender<bool>,
}

/// A handle for queueing one chunk without holding the hub's lock; it cannot outlive the
/// revocation of its pipe.
pub(crate) struct InboundHandle {
    queue: mpsc::Sender<Vec<u8>>,
    revoked: watch::Receiver<bool>,
}

/// The pipe was revoked before the chunk was queued.
pub(crate) struct Revoked;

/// Receiving half: client chunks queued by the `send` command.
pub struct IpcRx {
    queue: mpsc::Receiver<Vec<u8>>,
    revoked: watch::Receiver<bool>,
}

/// Sending half: server chunks pushed to the webview.
pub struct IpcTx(Option<Box<dyn FrameSink>>);

/// Creates a pipe. `inbound_chunks` bounds the inbound queue, so a webview that sends faster than
/// the engine reads waits on its invoke.
pub(crate) fn pipe(sink: Box<dyn FrameSink>, inbound_chunks: usize) -> (Inbound, IpcRx, IpcTx) {
    let (queue, queue_rx) = mpsc::channel(inbound_chunks.max(1));
    let (revoked, revoked_rx) = watch::channel(false);
    let rx = IpcRx {
        queue: queue_rx,
        revoked: revoked_rx,
    };
    (Inbound { queue, revoked }, rx, IpcTx(Some(sink)))
}

impl Inbound {
    pub(crate) fn handle(&self) -> InboundHandle {
        InboundHandle {
            queue: self.queue.clone(),
            revoked: self.revoked.subscribe(),
        }
    }
}

impl Drop for Inbound {
    fn drop(&mut self) {
        self.revoked.send_replace(true);
    }
}

impl InboundHandle {
    /// Queues `bytes`, waiting while the queue is full. Fails as soon as the pipe is revoked.
    pub(crate) async fn send(mut self, bytes: Vec<u8>) -> Result<(), Revoked> {
        tokio::select! {
            biased;
            _ = self.revoked.wait_for(|revoked| *revoked) => Err(Revoked),
            sent = self.queue.send(bytes) => sent.map_err(|_| Revoked),
        }
    }
}

impl TransportRx for IpcRx {
    async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        // Revocation wins over queued chunks: nothing sent before it is read after it.
        tokio::select! {
            biased;
            _ = self.revoked.wait_for(|revoked| *revoked) => {
                Err(io::Error::from(io::ErrorKind::ConnectionAborted))
            }
            chunk = self.queue.recv() => Ok(chunk),
        }
    }
}

impl TransportTx for IpcTx {
    async fn send(&mut self, bytes: Vec<u8>) -> io::Result<()> {
        self.0
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotConnected))?
            .send(bytes)
    }

    /// Drops the sink. For a Tauri `Channel` this tells the webview that no more messages follow.
    async fn close(&mut self) -> io::Result<()> {
        self.0 = None;
        Ok(())
    }
}
