//! Message framing over a brokered transport.

use bytes::BytesMut;
use db_driver::{DbError, Transport};
use postgres_protocol::message::backend::{Header, Message};

/// Bytes asked from the broker per `recv`; the broker clamps it to its own limit.
const RECV_BYTES: u32 = 64 * 1024;
/// Largest backend message accepted. PostgreSQL's own field limit is 1 GiB.
const MAX_MESSAGE_BYTES: usize = 1 << 30;

pub(crate) struct Wire {
    io: Box<dyn Transport>,
    buf: BytesMut,
}

impl Wire {
    pub(crate) fn new(io: Box<dyn Transport>) -> Self {
        Self {
            io,
            buf: BytesMut::new(),
        }
    }

    pub(crate) fn transport(&self) -> &dyn Transport {
        &*self.io
    }

    pub(crate) async fn write(&self, mut bytes: &[u8]) -> Result<(), DbError> {
        while !bytes.is_empty() {
            let sent = self.io.send(bytes).await? as usize;
            if sent == 0 || sent > bytes.len() {
                return Err(DbError::ConnectionLost);
            }
            bytes = &bytes[sent..];
        }
        Ok(())
    }

    /// The next backend message. Cancel-safe: dropping the future loses no received bytes.
    pub(crate) async fn read(&mut self) -> Result<Message, DbError> {
        loop {
            if let Some(header) = Header::parse(&self.buf).map_err(|_| DbError::ConnectionLost)?
                && usize::try_from(header.len()).unwrap_or(usize::MAX) > MAX_MESSAGE_BYTES
            {
                return Err(DbError::ConnectionLost);
            }
            if let Some(message) =
                Message::parse(&mut self.buf).map_err(|_| DbError::ConnectionLost)?
            {
                return Ok(message);
            }
            let bytes = self.io.recv(RECV_BYTES).await?;
            if bytes.is_empty() {
                return Err(DbError::ConnectionLost);
            }
            self.buf.extend_from_slice(&bytes);
        }
    }

    /// One raw byte, for the answer to `SSLRequest`. Reads exactly one byte so that nothing the
    /// server sends after it (CVE-2021-23222) is taken as protocol data.
    pub(crate) async fn read_byte(&mut self) -> Result<u8, DbError> {
        debug_assert!(self.buf.is_empty());
        match self.io.recv(1).await?.as_slice() {
            [byte] => Ok(*byte),
            _ => Err(DbError::ConnectionLost),
        }
    }
}
