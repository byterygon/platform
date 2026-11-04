//! Helpers shared by the broker integration tests.

use std::net::{Ipv4Addr, SocketAddr};
use std::time::Duration;

use tokio::net::{TcpListener, TcpSocket, TcpStream};

/// A listener on `ip:port` that never accepts, with its accept queue filled so that further
/// connection attempts hang: the kernel drops their SYNs, so a connect neither succeeds nor
/// fails until the client gives up.
pub struct Hanging {
    _listener: TcpListener,
    _queued: Vec<TcpStream>,
}

/// Returns the hanging listener and its port.
pub async fn hanging(ip: Ipv4Addr, port: u16) -> (Hanging, u16) {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(ip.into(), port)).unwrap();
    // The smallest backlog that bounds the queue on both Linux and macOS (macOS does not bound
    // it for 0).
    let listener = socket.listen(1).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut queued = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(addr)).await {
            Ok(Ok(s)) => queued.push(s),
            Ok(Err(e)) => panic!("filling the accept queue of {addr}: {e}"),
            // The queue is full: this attempt hung, and so will the broker's.
            Err(_) => break,
        }
        assert!(queued.len() < 16, "the accept queue of {addr} never filled");
    }
    (
        Hanging {
            _listener: listener,
            _queued: queued,
        },
        addr.port(),
    )
}
