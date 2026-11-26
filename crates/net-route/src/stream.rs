//! A stream that first hands out bytes already read from it.

use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::BoxStream;

/// `inner` with `prefix` read first: what a hop read past its own handshake.
pub(crate) struct Prefixed {
    prefix: Vec<u8>,
    at: usize,
    inner: BoxStream,
}

impl Prefixed {
    pub(crate) fn boxed(prefix: Vec<u8>, inner: BoxStream) -> BoxStream {
        if prefix.is_empty() {
            inner
        } else {
            Box::new(Prefixed {
                prefix,
                at: 0,
                inner,
            })
        }
    }
}

impl AsyncRead for Prefixed {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.at < self.prefix.len() {
            let n = buf.remaining().min(self.prefix.len() - self.at);
            let at = self.at;
            buf.put_slice(&self.prefix[at..at + n]);
            self.at += n;
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl AsyncWrite for Prefixed {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
