//! Transport abstraction (Ambidex spec §1, §4).
//!
//! A transport is a dumb duplex byte pipe. It carries no semantics: chunk boundaries need not match
//! frame boundaries, and the engine never asks what kind of transport it runs on. The Tauri and
//! WebSocket adapters implement these two traits; [`memory`] provides an in-process pair for tests
//! and the in-process conformance harness.

use std::future::Future;
use std::io;

use tokio::sync::mpsc;

/// Receiving half of a transport.
pub trait TransportRx: Send + 'static {
    /// Next chunk of bytes, or `Ok(None)` once the peer has closed.
    fn recv(&mut self) -> impl Future<Output = io::Result<Option<Vec<u8>>>> + Send;
}

/// Sending half of a transport.
pub trait TransportTx: Send + 'static {
    fn send(&mut self, bytes: Vec<u8>) -> impl Future<Output = io::Result<()>> + Send;

    /// Closes the sending direction. Further sends fail.
    fn close(&mut self) -> impl Future<Output = io::Result<()>> + Send;
}

/// One end of an in-memory transport pair.
pub struct MemoryRx(mpsc::Receiver<Vec<u8>>);

/// One end of an in-memory transport pair.
pub struct MemoryTx(Option<mpsc::Sender<Vec<u8>>>);

/// Creates two connected in-memory transport ends. `capacity` bounds the number of chunks in
/// flight per direction, so a sender waits when the reader falls behind.
pub fn memory(capacity: usize) -> ((MemoryRx, MemoryTx), (MemoryRx, MemoryTx)) {
    let (a_tx, a_rx) = mpsc::channel(capacity);
    let (b_tx, b_rx) = mpsc::channel(capacity);
    (
        (MemoryRx(a_rx), MemoryTx(Some(b_tx))),
        (MemoryRx(b_rx), MemoryTx(Some(a_tx))),
    )
}

impl TransportRx for MemoryRx {
    async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        Ok(self.0.recv().await)
    }
}

impl TransportTx for MemoryTx {
    async fn send(&mut self, bytes: Vec<u8>) -> io::Result<()> {
        let sender = self
            .0
            .as_ref()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotConnected))?;
        sender
            .send(bytes)
            .await
            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))
    }

    async fn close(&mut self) -> io::Result<()> {
        self.0 = None;
        Ok(())
    }
}
