//! The one TCP connection the dialer opens itself: to the first hop, or to the target when there
//! is no route.

use std::future::Future;
use std::pin::Pin;

use tokio::net::TcpStream;

use crate::BoxStream;
use crate::error::{RouteError, RouteErrorKind};
use crate::name::{bare_host, format_address};

/// The future a [`TcpConnect`] returns.
pub type TcpConnectFuture<'a> =
    Pin<Box<dyn Future<Output = Result<BoxStream, RouteError>> + Send + 'a>>;

/// Opens the dialer's own TCP connection. Replace it to put a policy in front (Mightyconsole
/// checks the addresses a name resolves to against its `[outbound]` rules) or to test.
/// The dialer adds the hop to the error and applies the timeouts.
pub trait TcpConnect: Send + Sync {
    fn connect<'a>(&'a self, host: &'a str, port: u16) -> TcpConnectFuture<'a>;
}

/// The system resolver, then each address in turn.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemTcp;

impl TcpConnect for SystemTcp {
    fn connect<'a>(&'a self, host: &'a str, port: u16) -> TcpConnectFuture<'a> {
        Box::pin(async move {
            let display = format_address(host, port);
            let addrs: Vec<_> = tokio::net::lookup_host((bare_host(host), port))
                .await
                .map_err(|e| {
                    RouteError::new(
                        None,
                        RouteErrorKind::Connect,
                        format!("cannot resolve {}: {e}", bare_host(host)),
                    )
                })?
                .collect();
            let mut last = None;
            for addr in addrs {
                match TcpStream::connect(addr).await {
                    Ok(tcp) => {
                        let _ = tcp.set_nodelay(true);
                        return Ok(Box::new(tcp) as BoxStream);
                    }
                    Err(e) => last = Some(e),
                }
            }
            Err(RouteError::new(
                None,
                RouteErrorKind::Connect,
                format!(
                    "cannot reach {display}: {}",
                    last.map_or_else(|| "the name has no address".to_owned(), |e| e.to_string())
                ),
            ))
        })
    }
}
