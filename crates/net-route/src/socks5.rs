//! The SOCKS5 hop (DOC-23 4.2): RFC 1928 with no authentication or RFC 1929's user and password.
//! A target name is sent as a name (ATYP 3), so the proxy resolves it (`socks5h`); an address is
//! sent as an address. SOCKS4 and GSSAPI are not spoken.

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use zeroize::Zeroizing;

use crate::BoxStream;
use crate::error::{HopFailure, RouteErrorKind};
use crate::name::{HostKind, format_address, parse_host};
use crate::route::{Socks5Auth, Socks5Hop};

const VERSION: u8 = 5;
const NO_AUTH: u8 = 0;
const USER_PASSWORD: u8 = 2;
const NO_ACCEPTABLE: u8 = 0xff;

fn io_failure(stage: &str) -> impl Fn(std::io::Error) -> HopFailure + '_ {
    move |e| {
        let message = if e.kind() == std::io::ErrorKind::UnexpectedEof {
            format!("the proxy closed the connection during the SOCKS5 {stage}")
        } else {
            format!("the SOCKS5 {stage} failed: {e}")
        };
        HopFailure::here(RouteErrorKind::Connect, message)
    }
}

/// Greets the proxy and logs in.
pub(crate) async fn enter(mut stream: BoxStream, hop: &Socks5Hop) -> Result<BoxStream, HopFailure> {
    let greeting: &[u8] = match hop.auth {
        Socks5Auth::None => &[VERSION, 1, NO_AUTH],
        Socks5Auth::UserPassword { .. } => &[VERSION, 2, NO_AUTH, USER_PASSWORD],
    };
    let fail = io_failure("greeting");
    stream.write_all(greeting).await.map_err(&fail)?;
    let mut reply = [0u8; 2];
    stream.read_exact(&mut reply).await.map_err(&fail)?;
    if reply[0] != VERSION {
        return Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!(
                "the proxy did not answer as a SOCKS5 proxy (version byte {:#04x})",
                reply[0]
            ),
        ));
    }
    match (reply[1], &hop.auth) {
        (NO_AUTH, _) => Ok(stream),
        (USER_PASSWORD, Socks5Auth::UserPassword { user, password }) => {
            let password = password.expose().as_bytes();
            let mut login = Zeroizing::new(Vec::with_capacity(3 + user.len() + password.len()));
            login.push(1);
            login.push(user.len() as u8);
            login.extend_from_slice(user.as_bytes());
            login.push(password.len() as u8);
            login.extend_from_slice(password);
            let fail = io_failure("login");
            stream.write_all(&login).await.map_err(&fail)?;
            let mut status = [0u8; 2];
            stream.read_exact(&mut status).await.map_err(&fail)?;
            if status[1] != 0 {
                return Err(HopFailure::here(
                    RouteErrorKind::Auth,
                    "the proxy rejected the user and password",
                ));
            }
            Ok(stream)
        }
        (NO_ACCEPTABLE, Socks5Auth::None) | (USER_PASSWORD, Socks5Auth::None) => Err(
            HopFailure::here(RouteErrorKind::Auth, "the proxy needs a user and password"),
        ),
        (NO_ACCEPTABLE, _) => Err(HopFailure::here(
            RouteErrorKind::Auth,
            "the proxy accepts none of the methods offered (no authentication, user and password)",
        )),
        (other, _) => Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy chose authentication method {other:#04x}, which was not offered"),
        )),
    }
}

/// Asks the proxy to connect to `host:port`.
pub(crate) async fn open(
    mut stream: BoxStream,
    host: &str,
    port: u16,
) -> Result<BoxStream, HopFailure> {
    let authority = format_address(host, port);
    let mut request = vec![VERSION, 1, 0];
    match parse_host(host) {
        Some(HostKind::Ip(std::net::IpAddr::V4(ip))) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Some(HostKind::Ip(std::net::IpAddr::V6(ip))) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Some(HostKind::Name) => {
            let name = host.strip_suffix('.').unwrap_or(host);
            request.push(3);
            request.push(name.len() as u8);
            request.extend_from_slice(name.as_bytes());
        }
        None => {
            return Err(HopFailure::next(
                RouteErrorKind::Invalid,
                format!("{host:?} is not a host name or an address"),
            ));
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    let fail = io_failure("connect request");
    stream.write_all(&request).await.map_err(&fail)?;

    let mut head = [0u8; 4];
    stream.read_exact(&mut head).await.map_err(&fail)?;
    if head[0] != VERSION {
        return Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!(
                "the proxy did not answer as a SOCKS5 proxy (version byte {:#04x})",
                head[0]
            ),
        ));
    }
    if head[1] != 0 {
        return Err(reply_failure(head[1], &authority));
    }
    // The bound address, read in full so none of it is taken for the target's bytes.
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(&fail)?;
            usize::from(len[0]) + 2
        }
        other => {
            return Err(HopFailure::here(
                RouteErrorKind::Connect,
                format!("the proxy answered with an unknown address type {other:#04x}"),
            ));
        }
    };
    let mut bound = vec![0u8; rest];
    stream.read_exact(&mut bound).await.map_err(&fail)?;
    Ok(stream)
}

/// RFC 1928 §6's reply codes. Codes about reaching the target name the next node.
fn reply_failure(code: u8, authority: &str) -> HopFailure {
    match code {
        2 => HopFailure::here(
            RouteErrorKind::Forbidden,
            format!("the proxy's rules do not allow a connection to {authority}"),
        ),
        3 => HopFailure::next(
            RouteErrorKind::Connect,
            format!("the proxy could not reach {authority}: network unreachable"),
        ),
        4 => HopFailure::next(
            RouteErrorKind::Connect,
            format!(
                "the proxy could not reach {authority}: host unreachable (or its name did not resolve)"
            ),
        ),
        5 => HopFailure::next(
            RouteErrorKind::Connect,
            format!("the proxy could not reach {authority}: connection refused"),
        ),
        6 => HopFailure::next(
            RouteErrorKind::Timeout,
            format!("the proxy timed out reaching {authority}"),
        ),
        7 => HopFailure::here(
            RouteErrorKind::Connect,
            "the proxy does not support CONNECT",
        ),
        8 => HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy does not support the address type of {authority}"),
        ),
        1 => HopFailure::next(
            RouteErrorKind::Connect,
            format!("the proxy could not reach {authority}: general failure"),
        ),
        other => HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy refused {authority} with reply code {other:#04x}"),
        ),
    }
}
