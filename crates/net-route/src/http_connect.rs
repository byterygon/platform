//! The HTTP CONNECT hop (DOC-23 4.1, RFC 9110 §9.3.6): TLS to an `https://` proxy, then
//! `CONNECT host:port`, with `Proxy-Authorization: Basic` when the hop has a login. Any 2xx opens
//! the tunnel; the tool's own TLS then runs end to end to the target, so the proxy never sees a
//! request. The target's name goes to the proxy, which resolves it.

use std::sync::{Arc, OnceLock};

use base64::Engine as _;
use rustls::RootCertStore;
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, ServerName};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use crate::BoxStream;
use crate::error::{HopFailure, RouteErrorKind};
use crate::name::{bare_host, format_address};
use crate::route::{HttpConnectHop, ProxyScheme};

/// The most bytes of a proxy's answer head read before giving up on it.
const HEAD_LIMIT: usize = 16 * 1024;

/// The certificates of a pinned CA in PEM.
pub(crate) fn parse_ca(pem: &str) -> Result<Vec<CertificateDer<'static>>, String> {
    let certs = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("the pinned CA is not PEM: {e}"))?;
    if certs.is_empty() {
        return Err("the pinned CA holds no certificate (PEM, BEGIN CERTIFICATE)".into());
    }
    Ok(certs)
}

fn system_roots() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            let found = rustls_native_certs::load_native_certs();
            roots.add_parsable_certificates(found.certs);
            Arc::new(roots)
        })
        .clone()
}

/// Reaches the proxy itself: TLS for `https://`, nothing for `http://`.
pub(crate) async fn enter(
    stream: BoxStream,
    hop: &HttpConnectHop,
) -> Result<BoxStream, HopFailure> {
    if hop.scheme == ProxyScheme::Http {
        return Ok(stream);
    }
    let roots = match &hop.ca_pem {
        Some(pem) => {
            let mut roots = RootCertStore::empty();
            for cert in parse_ca(pem).map_err(|e| HopFailure::here(RouteErrorKind::Invalid, e))? {
                roots.add(cert).map_err(|e| {
                    HopFailure::here(RouteErrorKind::Invalid, format!("the pinned CA: {e}"))
                })?;
            }
            Arc::new(roots)
        }
        None => system_roots(),
    };
    if roots.is_empty() {
        return Err(HopFailure::here(
            RouteErrorKind::Invalid,
            "this machine has no CA certificates to check the proxy's TLS: pin the proxy's CA",
        ));
    }
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .map_err(|e| HopFailure::here(RouteErrorKind::Invalid, format!("TLS: {e}")))?
    .with_root_certificates(roots)
    .with_no_client_auth();
    let name = ServerName::try_from(bare_host(&hop.host).to_owned()).map_err(|e| {
        HopFailure::here(
            RouteErrorKind::Invalid,
            format!("{} is not a TLS server name: {e}", hop.host),
        )
    })?;
    let tls = TlsConnector::from(Arc::new(config))
        .connect(name, stream)
        .await
        .map_err(|e| {
            HopFailure::here(
                RouteErrorKind::Connect,
                format!("TLS with the proxy failed: {e}"),
            )
        })?;
    Ok(Box::new(tls))
}

/// Asks the proxy for a tunnel to `host:port`.
pub(crate) async fn open(
    stream: BoxStream,
    hop: &HttpConnectHop,
    host: &str,
    port: u16,
) -> Result<BoxStream, HopFailure> {
    let authority = format_address(host, port);
    let mut request = Zeroizing::new(format!(
        "CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n"
    ));
    if let Some(auth) = &hop.auth {
        let pair = Zeroizing::new(format!("{}:{}", auth.user, auth.password.expose()));
        let encoded =
            Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(pair.as_bytes()));
        request.push_str("Proxy-Authorization: Basic ");
        request.push_str(&encoded);
        request.push_str("\r\n");
    }
    request.push_str("\r\n");

    let mut reader = BufReader::new(stream);
    let closed = |e: std::io::Error| {
        HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy closed the connection during CONNECT {authority}: {e}"),
        )
    };
    reader
        .get_mut()
        .write_all(request.as_bytes())
        .await
        .map_err(closed)?;
    reader.get_mut().flush().await.map_err(closed)?;
    drop(request);

    let head = read_head(&mut reader).await.map_err(|e| match e {
        HeadError::Io(e) => closed(e),
        HeadError::TooLong => HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy's answer to CONNECT {authority} is longer than {HEAD_LIMIT} bytes"),
        ),
        HeadError::Closed => HopFailure::here(
            RouteErrorKind::Connect,
            format!("the proxy closed the connection without answering CONNECT {authority}"),
        ),
    })?;
    let status_line = head.first().map(String::as_str).unwrap_or_default();
    let Some(status) = parse_status(status_line) else {
        return Err(HopFailure::here(
            RouteErrorKind::Connect,
            format!(
                "the proxy did not answer as an HTTP proxy: {:?}",
                clean(status_line)
            ),
        ));
    };
    let said = clean(status_line);
    match status {
        200..=299 => {}
        407 => {
            let scheme = header(&head, "proxy-authenticate")
                .and_then(|v| v.split_whitespace().next())
                .map(str::to_owned);
            let message = match (&hop.auth, scheme.as_deref()) {
                (_, Some(s)) if !s.eq_ignore_ascii_case("basic") => format!(
                    "the proxy asks for {s} authentication ({said}); only Basic is supported"
                ),
                (None, _) => format!("the proxy needs a user and password ({said})"),
                (Some(_), _) => format!("the proxy rejected the user and password ({said})"),
            };
            return Err(HopFailure::here(RouteErrorKind::Auth, message));
        }
        403 => {
            return Err(HopFailure::here(
                RouteErrorKind::Forbidden,
                format!(
                    "the proxy refused CONNECT {authority} ({said}). Its rules may allow CONNECT \
                     to some ports only (squid: 443 unless `SSL_ports` lists more)"
                ),
            ));
        }
        502 | 503 => {
            return Err(HopFailure::next(
                RouteErrorKind::Connect,
                format!("the proxy could not reach {authority} ({said})"),
            ));
        }
        504 => {
            return Err(HopFailure::next(
                RouteErrorKind::Timeout,
                format!("the proxy timed out reaching {authority} ({said})"),
            ));
        }
        _ => {
            return Err(HopFailure::here(
                RouteErrorKind::Connect,
                format!("the proxy answered CONNECT {authority} with {said}"),
            ));
        }
    }
    // Bytes the target sent right after the proxy's answer (a server that speaks first) are in
    // the reader's buffer: keep the reader then.
    if reader.buffer().is_empty() {
        Ok(reader.into_inner())
    } else {
        Ok(Box::new(reader))
    }
}

enum HeadError {
    Io(std::io::Error),
    TooLong,
    Closed,
}

/// The status line and header lines, up to the empty line, at most [`HEAD_LIMIT`] bytes. Reads
/// nothing past the empty line.
async fn read_head<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<String>, HeadError> {
    let mut lines = Vec::new();
    let mut total = 0;
    loop {
        let mut line = Vec::new();
        loop {
            let (found, used) = {
                let buf = reader.fill_buf().await.map_err(HeadError::Io)?;
                if buf.is_empty() {
                    return Err(HeadError::Closed);
                }
                match buf.iter().position(|b| *b == b'\n') {
                    Some(pos) => {
                        line.extend_from_slice(&buf[..=pos]);
                        (true, pos + 1)
                    }
                    None => {
                        line.extend_from_slice(buf);
                        (false, buf.len())
                    }
                }
            };
            reader.consume(used);
            if total + line.len() > HEAD_LIMIT {
                return Err(HeadError::TooLong);
            }
            if found {
                break;
            }
        }
        total += line.len();
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end_matches(['\r', '\n']);
        if text.is_empty() {
            if lines.is_empty() {
                // Tolerate a stray empty line before the status line.
                continue;
            }
            return Ok(lines);
        }
        lines.push(text.to_owned());
    }
}

fn parse_status(line: &str) -> Option<u16> {
    let mut parts = line.split_whitespace();
    let version = parts.next()?;
    if !version.starts_with("HTTP/") {
        return None;
    }
    let code = parts.next()?;
    if code.len() != 3 {
        return None;
    }
    code.parse().ok()
}

fn header<'a>(head: &'a [String], name: &str) -> Option<&'a str> {
    head.iter().skip(1).find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// A proxy's words as they may appear in a message: printable ASCII, at most 160 characters.
fn clean(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .take(160)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_head_stops_at_the_empty_line() {
        let data: &[u8] =
            b"HTTP/1.1 200 Connection established\r\nVia: x\r\n\r\nSSH-2.0-banner\r\n";
        let mut reader = BufReader::new(data);
        let head = read_head(&mut reader).await.ok().unwrap();
        assert_eq!(head, ["HTTP/1.1 200 Connection established", "Via: x"]);
        assert_eq!(reader.buffer(), b"SSH-2.0-banner\r\n");
    }

    #[tokio::test]
    async fn a_head_without_end_is_cut() {
        let data = vec![b'a'; HEAD_LIMIT + 10];
        let mut reader = BufReader::new(&data[..]);
        assert!(matches!(
            read_head(&mut reader).await,
            Err(HeadError::TooLong)
        ));
        let mut reader = BufReader::new(&b"HTTP/1.1 200 OK\r\n"[..]);
        assert!(matches!(
            read_head(&mut reader).await,
            Err(HeadError::Closed)
        ));
    }

    #[test]
    fn status_lines() {
        assert_eq!(
            parse_status("HTTP/1.1 200 Connection established"),
            Some(200)
        );
        assert_eq!(
            parse_status("HTTP/1.0 407 Proxy Authentication Required"),
            Some(407)
        );
        assert_eq!(parse_status("SSH-2.0-OpenSSH"), None);
        assert_eq!(parse_status("HTTP/1.1 20 x"), None);
        assert_eq!(clean("HTTP/1.1 200 \u{1b}[31mok\r"), "HTTP/1.1 200 [31mok");
    }
}
