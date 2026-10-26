//! WebSocket byte pipe (Ambidex spec §4).
//!
//! [`WsRx`] and [`WsTx`] implement the engine's transport traits over one axum WebSocket and do
//! nothing else: every binary message is one chunk of bytes, every chunk is sent as one binary
//! message. Frame boundaries, limits and errors are the engine's business.

use std::io;

use axum::extract::ws::{Message, WebSocket};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};

use ambidex::transport::{TransportRx, TransportTx};

/// Receiving half of a WebSocket transport.
pub struct WsRx(SplitStream<WebSocket>);

/// Sending half of a WebSocket transport.
pub struct WsTx(SplitSink<WebSocket, Message>);

/// Splits an upgraded WebSocket into transport halves.
pub fn split(socket: WebSocket) -> (WsRx, WsTx) {
    let (sink, stream) = socket.split();
    (WsRx(stream), WsTx(sink))
}

impl TransportRx for WsRx {
    async fn recv(&mut self) -> io::Result<Option<Vec<u8>>> {
        loop {
            match self.0.next().await {
                None | Some(Ok(Message::Close(_))) => return Ok(None),
                Some(Ok(Message::Binary(bytes))) => return Ok(Some(bytes.into())),
                // The protocol is binary only (spec §4). A text message is a protocol violation;
                // failing the transport closes the connection before the engine sees the bytes.
                Some(Ok(Message::Text(_))) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "text WebSocket message",
                    ));
                }
                // WebSocket keepalive; the WebSocket library answers pings itself.
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Err(err)) => return Err(io::Error::other(err)),
            }
        }
    }
}

impl TransportTx for WsTx {
    async fn send(&mut self, bytes: Vec<u8>) -> io::Result<()> {
        self.0
            .send(Message::Binary(bytes.into()))
            .await
            .map_err(io::Error::other)
    }

    async fn close(&mut self) -> io::Result<()> {
        self.0.close().await.map_err(io::Error::other)
    }
}
