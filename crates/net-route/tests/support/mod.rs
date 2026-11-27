//! In-process fakes for the conformance tests (DOC-23 5): a target that speaks first and echoes,
//! an HTTP CONNECT proxy (with TLS, a login, forced answers, silence) and a SOCKS5 proxy. The
//! proxies resolve names from their own table only, so a test that reaches `echo.internal`
//! proves the name went to the proxy and was not resolved on this side.

#![allow(dead_code)]

pub mod sshd;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};

pub type Log = Arc<Mutex<Vec<String>>>;

fn push(log: &Log, line: impl Into<String>) {
    log.lock().unwrap().push(line.into());
}

pub fn lines(log: &Log) -> Vec<String> {
    log.lock().unwrap().clone()
}

async fn listen() -> (TcpListener, SocketAddr) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    (listener, addr)
}

/// A target that sends `HELLO <name>\n` as soon as it is connected, then echoes.
pub async fn echo_target(name: &str) -> SocketAddr {
    let (listener, addr) = listen().await;
    let banner = format!("HELLO {name}\n");
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else {
                return;
            };
            let banner = banner.clone();
            tokio::spawn(async move {
                if tcp.write_all(banner.as_bytes()).await.is_err() {
                    return;
                }
                let mut buf = [0u8; 4096];
                loop {
                    match tcp.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => {
                            if tcp.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            });
        }
    });
    addr
}

/// A port nothing listens on.
pub async fn closed_port() -> SocketAddr {
    let (listener, addr) = listen().await;
    drop(listener);
    addr
}

/// Names a fake proxy resolves; anything else that is not `ip:port` is unknown to it.
pub type Hosts = HashMap<String, SocketAddr>;

fn resolve(hosts: &Hosts, host: &str, port: u16) -> Option<SocketAddr> {
    if let Some(addr) = hosts.get(host) {
        return Some(*addr);
    }
    let ip = host.trim_matches(['[', ']']).parse().ok()?;
    Some(SocketAddr::new(ip, port))
}

/// Connects to the target, waits briefly for what it says first, and sends `answer` and those
/// bytes in one write, as a proxy on a fast network may.
async fn splice<S>(mut client: S, target: SocketAddr, answer: &[u8])
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let Ok(mut upstream) = TcpStream::connect(target).await else {
        return;
    };
    let mut first = vec![0u8; 1024];
    let n = tokio::time::timeout(Duration::from_millis(200), upstream.read(&mut first))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0);
    let mut out = answer.to_vec();
    out.extend_from_slice(&first[..n]);
    if client.write_all(&out).await.is_err() {
        return;
    }
    let _ = copy_bidirectional(&mut client, &mut upstream).await;
}

/// How the fake HTTP proxy behaves.
#[derive(Clone, Default)]
pub struct HttpProxy {
    pub hosts: Hosts,
    /// `user:password` it requires.
    pub login: Option<(String, String)>,
    /// Answer this status to every CONNECT.
    pub status: Option<u16>,
    /// Read the request and never answer.
    pub silent: bool,
    pub tls: Option<Arc<rustls::ServerConfig>>,
}

impl HttpProxy {
    /// Starts it; the log gets each request line, `auth:<header or ->` and `closed` when a silent
    /// connection ends.
    pub async fn start(self) -> (SocketAddr, Log) {
        let (listener, addr) = listen().await;
        let log: Log = Arc::default();
        let config = Arc::new(self);
        let l = log.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let config = config.clone();
                let log = l.clone();
                tokio::spawn(async move {
                    match &config.tls {
                        Some(tls) => {
                            let acceptor = tokio_rustls::TlsAcceptor::from(tls.clone());
                            match acceptor.accept(tcp).await {
                                Ok(stream) => serve_http(stream, &config, &log).await,
                                Err(e) => push(&log, format!("tls error: {e}")),
                            }
                        }
                        None => serve_http(tcp, &config, &log).await,
                    }
                });
            }
        });
        (addr, log)
    }
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Vec<String>> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.ok()? == 0 {
            return None;
        }
        head.push(byte[0]);
    }
    Some(
        String::from_utf8_lossy(&head)
            .split("\r\n")
            .filter(|l| !l.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

async fn serve_http<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    config: &HttpProxy,
    log: &Log,
) {
    let Some(head) = read_head(&mut stream).await else {
        return;
    };
    push(log, head[0].clone());
    let auth = head
        .iter()
        .find_map(|l| l.strip_prefix("Proxy-Authorization: "))
        .map(str::to_owned);
    push(log, format!("auth:{}", auth.as_deref().unwrap_or("-")));
    if config.silent {
        let mut buf = [0u8; 64];
        while matches!(stream.read(&mut buf).await, Ok(n) if n > 0) {}
        push(log, "closed");
        return;
    }
    if let Some((user, password)) = &config.login {
        let expected = format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}"))
        );
        if auth.as_deref() != Some(expected.as_str()) {
            let _ = stream
                .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"fake\"\r\nContent-Length: 0\r\n\r\n")
                .await;
            return;
        }
    }
    if let Some(status) = config.status {
        let _ = stream
            .write_all(format!("HTTP/1.1 {status} Fake\r\nContent-Length: 0\r\n\r\n").as_bytes())
            .await;
        return;
    }
    let mut parts = head[0].split(' ');
    let (Some("CONNECT"), Some(authority)) = (parts.next(), parts.next()) else {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n").await;
        return;
    };
    let (host, port) = authority.rsplit_once(':').unwrap();
    match resolve(&config.hosts, host, port.parse().unwrap()) {
        Some(target) => {
            splice(
                stream,
                target,
                b"HTTP/1.1 200 Connection established\r\n\r\n",
            )
            .await
        }
        None => {
            let _ = stream
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\n\r\n")
                .await;
        }
    }
}

/// How the fake SOCKS5 proxy behaves.
#[derive(Clone, Default)]
pub struct Socks5Proxy {
    pub hosts: Hosts,
    pub login: Option<(String, String)>,
    /// Answer this reply code to every CONNECT.
    pub reply: Option<u8>,
}

impl Socks5Proxy {
    /// Starts it; the log gets `methods:<list>`, `login:<user>` and `connect:<atyp>:<host>:<port>`.
    pub async fn start(self) -> (SocketAddr, Log) {
        let (listener, addr) = listen().await;
        let log: Log = Arc::default();
        let config = Arc::new(self);
        let l = log.clone();
        tokio::spawn(async move {
            loop {
                let Ok((tcp, _)) = listener.accept().await else {
                    return;
                };
                let config = config.clone();
                let log = l.clone();
                tokio::spawn(async move {
                    let _ = serve_socks(tcp, &config, &log).await;
                });
            }
        });
        (addr, log)
    }
}

async fn serve_socks(mut tcp: TcpStream, config: &Socks5Proxy, log: &Log) -> std::io::Result<()> {
    let mut head = [0u8; 2];
    tcp.read_exact(&mut head).await?;
    let mut methods = vec![0u8; usize::from(head[1])];
    tcp.read_exact(&mut methods).await?;
    push(log, format!("methods:{methods:?}"));
    match &config.login {
        None => tcp.write_all(&[5, 0]).await?,
        Some((user, password)) => {
            if !methods.contains(&2) {
                tcp.write_all(&[5, 0xff]).await?;
                return Ok(());
            }
            tcp.write_all(&[5, 2]).await?;
            let mut ver_len = [0u8; 2];
            tcp.read_exact(&mut ver_len).await?;
            let mut got_user = vec![0u8; usize::from(ver_len[1])];
            tcp.read_exact(&mut got_user).await?;
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut got_password = vec![0u8; usize::from(len[0])];
            tcp.read_exact(&mut got_password).await?;
            push(log, format!("login:{}", String::from_utf8_lossy(&got_user)));
            if got_user != user.as_bytes() || got_password != password.as_bytes() {
                tcp.write_all(&[1, 1]).await?;
                return Ok(());
            }
            tcp.write_all(&[1, 0]).await?;
        }
    }
    let mut request = [0u8; 4];
    tcp.read_exact(&mut request).await?;
    let host = match request[3] {
        1 => {
            let mut ip = [0u8; 4];
            tcp.read_exact(&mut ip).await?;
            std::net::Ipv4Addr::from(ip).to_string()
        }
        4 => {
            let mut ip = [0u8; 16];
            tcp.read_exact(&mut ip).await?;
            std::net::Ipv6Addr::from(ip).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            tcp.read_exact(&mut len).await?;
            let mut name = vec![0u8; usize::from(len[0])];
            tcp.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        _ => return Ok(()),
    };
    let mut port = [0u8; 2];
    tcp.read_exact(&mut port).await?;
    let port = u16::from_be_bytes(port);
    push(log, format!("connect:{}:{host}:{port}", request[3]));
    // The bound address of the reply: a name, so the client must read a variable length.
    let bound = |code: u8| {
        let mut reply = vec![5, code, 0, 3, 9];
        reply.extend_from_slice(b"fake.bind");
        reply.extend_from_slice(&1080u16.to_be_bytes());
        reply
    };
    if let Some(code) = config.reply {
        tcp.write_all(&bound(code)).await?;
        return Ok(());
    }
    match resolve(&config.hosts, &host, port) {
        Some(target) => splice(tcp, target, &bound(0)).await,
        None => tcp.write_all(&bound(4)).await?,
    }
    Ok(())
}

/// A CA and a certificate for `localhost` and 127.0.0.1 signed by it: (CA PEM, server config).
pub fn tls_for_localhost() -> (String, Arc<rustls::ServerConfig>) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let ca_issuer = rcgen::Issuer::new(ca_params, ca_key);
    let key = KeyPair::generate().unwrap();
    let params =
        CertificateParams::new(vec!["localhost".to_owned(), "127.0.0.1".to_owned()]).unwrap();
    let cert = params.signed_by(&key, &ca_issuer).unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![cert.der().clone()],
        rustls_pki_types::PrivateKeyDer::try_from(key.serialize_der()).unwrap(),
    )
    .unwrap();
    (ca.pem(), Arc::new(config))
}

/// A target that writes without end as soon as it is connected (a `docker logs -f` of a chatty
/// container), whether or not anyone reads.
pub async fn flood_target() -> SocketAddr {
    let (listener, addr) = listen().await;
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let chunk = vec![b'x'; 32 * 1024];
                while tcp.write_all(&chunk).await.is_ok() {}
            });
        }
    });
    addr
}

/// A TCP relay to `target` that a test can freeze (it stops passing bytes and keeps the
/// connections open, as a dead NAT entry or a suspended host does) or cut (it closes them, as a
/// host that went away does).
pub struct Relay {
    pub addr: SocketAddr,
    frozen: Arc<std::sync::atomic::AtomicBool>,
    cut: Arc<tokio::sync::Notify>,
}

impl Relay {
    pub async fn start(target: SocketAddr) -> Relay {
        let (listener, addr) = listen().await;
        let frozen = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let cut = Arc::new(tokio::sync::Notify::new());
        let (f, c) = (Arc::clone(&frozen), Arc::clone(&cut));
        tokio::spawn(async move {
            loop {
                let Ok((client, _)) = listener.accept().await else {
                    return;
                };
                let Ok(upstream) = TcpStream::connect(target).await else {
                    continue;
                };
                let (f, c) = (Arc::clone(&f), Arc::clone(&c));
                tokio::spawn(async move {
                    let (cr, cw) = client.into_split();
                    let (ur, uw) = upstream.into_split();
                    tokio::select! {
                        () = pass(cr, uw, Arc::clone(&f)) => {}
                        () = pass(ur, cw, f) => {}
                        () = c.notified() => {}
                    }
                });
            }
        });
        Relay { addr, frozen, cut }
    }

    pub fn freeze(&self) {
        self.frozen.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    pub fn cut(&self) {
        self.cut.notify_waiters();
    }
}

async fn pass(
    mut from: tokio::net::tcp::OwnedReadHalf,
    mut to: tokio::net::tcp::OwnedWriteHalf,
    frozen: Arc<std::sync::atomic::AtomicBool>,
) {
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let Ok(n) = from.read(&mut buf).await else {
            return;
        };
        if n == 0 {
            return;
        }
        if frozen.load(std::sync::atomic::Ordering::SeqCst) {
            // Swallow everything from now on; keep the connection open.
            std::future::pending::<()>().await;
        }
        if to.write_all(&buf[..n]).await.is_err() {
            return;
        }
    }
}
