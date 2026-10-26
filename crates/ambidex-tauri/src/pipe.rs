//! The IPC byte pipe (Ambidex spec §4).
//!
//! Client frames arrive as raw-body invokes and are queued for the engine; server frames leave
//! through a [`FrameSink`], which the plugin backs with one Tauri `Channel` per connection. Bytes
//! are passed through unchanged: chunk boundaries need not match frame boundaries, and nothing
//! here looks inside them.

use std::io;

use ambidex::transport::{TransportRx, TransportTx};
use tokio::sync::mpsc;

/// Where server frames go. The plugin implements it with a Tauri `Channel` carrying raw bytes,
/// which the webview receives as an `ArrayBuffer`.
pub trait FrameSink: Send + Sync + 'static {
    fn send(&self, bytes: Vec<u8>) -> io::Result<()>;
}

/// Receiving half: client chunks queued by the `send` command.
pub struct IpcRx(mpsc::Receiver<Vec<u8>>);

/// Sending half: server chunks pushed to the webview.
pub struct IpcTx(Option<Box<dyn FrameSink>>);

/// Creates a pipe. Returns the inbound queue's sender, which the transport keeps while the
/// connection is open; dropping it ends the stream the engine reads. `inbound_chunks` bounds the
/// queue, so a webview that sends faster than the engine reads waits on its invoke.
pub(crate) fn pipe(
    sink: Box<dyn FrameSink>,
    inbound_chunks: usize,
) -> (mpsc::Sender<Vec<u8>>, IpcRx, IpcTx) {
    let (tx, rx) = mpsc::channel(inbound_chunks.max(1));
    (tx, IpcRx(rx), IpcTx(Some(sink)))
}

impl TransportRx for IpcRx {
    async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        Ok(self.0.recv().await)
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
