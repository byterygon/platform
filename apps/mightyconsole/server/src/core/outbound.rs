//! What a profile may make the server reach (TSK-141; DOC-25 §3.7 "TSK-141's outbound allowlist",
//! Open question 27). Every connection a tool opens from a profile's hosts, URLs and addresses
//! goes through [`resolve`], [`connect_tcp`] or [`Connector`]: the host is resolved here, each
//! address is checked against the operator's `[outbound]` rules and the built-in refusals, and the
//! connection goes to an address that passed. Checking the addresses that are connected to (not
//! the name) means a name that resolves to a refused address, or an IP literal, is refused too.
//!
//! The decision for one address, in order:
//!
//! 1. an `[outbound] deny` rule that matches the host or the address refuses it;
//! 2. a [built-in refused](BUILT_IN) address (link-local, cloud metadata, "this network") is
//!    refused unless an `allow` rule names a network or an address that contains it (a host
//!    name does not lift it: DNS could map any name there);
//! 3. with `allow` rules, only an address or host they match is reached;
//! 4. anything else is reached: Mightyconsole is a console for an organisation's own systems,
//!    so private (RFC 1918) and loopback addresses are reached by default and an operator narrows
//!    them with `allow` or `deny`.
//!
//! A rule is an address (`10.1.2.3`, `fd00::1`), a network (`10.0.0.0/8`, `fd00::/8`), a host name
//! (`nats.corp.example`) or a domain (`*.corp.example`, which also matches `corp.example`).
//!
//! The policy is the process's: [`set_policy`] at start; until then (tests) the built-in refusals
//! alone. The IdP, the syslog collector and the key command are the operator's own configuration,
//! not a profile's, and do not go through it.

use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, LazyLock, RwLock};
use std::task::{Context, Poll};
use std::time::Duration;

use hyper::Uri;
use hyper_util::rt::TokioIo;
use tokio::net::TcpStream;

use super::route::Via;
use super::{ToolError, ToolErrorKind};

/// The addresses refused unless an operator allows them by network: link-local (where the cloud
/// metadata services of AWS, Azure, GCP and OpenStack answer, 169.254.169.254), the metadata
/// addresses outside it (AWS's IPv6 one, Alibaba Cloud's, Oracle Cloud's older one), and "this
/// network" / unspecified addresses, which some systems route to the machine itself.
pub const BUILT_IN: &[&str] = &[
    "169.254.0.0/16",
    "fe80::/10",
    "fd00:ec2::254/128",
    "100.100.100.200/32",
    "192.0.0.192/32",
    "0.0.0.0/8",
    "::/128",
];

/// One `[outbound]` rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rule {
    /// An address or a network: the address and the prefix length.
    Net(IpAddr, u8),
    /// A host name, lowercase.
    Host(String),
    /// `*.<domain>`: the domain and every name below it, lowercase.
    Domain(String),
}

impl Rule {
    pub fn parse(text: &str) -> Result<Rule, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("an empty rule".into());
        }
        if let Some(domain) = text.strip_prefix("*.") {
            return valid_name(domain).map(Rule::Domain);
        }
        let (addr, prefix) = match text.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (text, None),
        };
        if let Ok(ip) = addr.trim_matches(['[', ']']).parse::<IpAddr>() {
            let ip = canonical(ip);
            let max = if ip.is_ipv4() { 32 } else { 128 };
            let len = match prefix {
                None => max,
                Some(p) => p
                    .parse::<u8>()
                    .ok()
                    .filter(|l| *l <= max)
                    .ok_or_else(|| format!("{text}: the prefix length is 0 to {max}"))?,
            };
            return Ok(Rule::Net(ip, len));
        }
        if prefix.is_some() {
            return Err(format!(
                "{text}: a network is an address and a prefix length"
            ));
        }
        valid_name(text).map(Rule::Host)
    }

    fn contains_ip(&self, ip: IpAddr) -> bool {
        match self {
            Rule::Net(net, len) => in_network(ip, *net, *len),
            _ => false,
        }
    }

    fn matches_host(&self, host: &str) -> bool {
        match self {
            Rule::Host(name) => host == name,
            Rule::Domain(domain) => {
                host == domain
                    || host
                        .strip_suffix(domain.as_str())
                        .is_some_and(|rest| rest.ends_with('.'))
            }
            Rule::Net(..) => false,
        }
    }
}

fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    let ok = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
    if ok {
        Ok(name)
    } else {
        Err(format!(
            "{name:?} is not an address, a network or a host name"
        ))
    }
}

/// An IPv4-mapped IPv6 address as the IPv4 address it is.
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4),
        v4 => v4,
    }
}

fn in_network(ip: IpAddr, net: IpAddr, len: u8) -> bool {
    match (canonical(ip), net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let mask = u32::MAX.checked_shl(32 - u32::from(len)).unwrap_or(0);
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let mask = u128::MAX.checked_shl(128 - u32::from(len)).unwrap_or(0);
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

/// The operator's rules, with the built-in refusals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    pub allow: Vec<Rule>,
    pub deny: Vec<Rule>,
    built_in: Vec<Rule>,
}

impl Default for Policy {
    fn default() -> Self {
        Policy::new(Vec::new(), Vec::new())
    }
}

/// Why an address is not reached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// An `[outbound] deny` rule.
    Denied,
    /// A built-in refused address no `allow` network names.
    BuiltIn,
    /// Not among the `allow` rules.
    NotAllowed,
}

impl Policy {
    pub fn new(allow: Vec<Rule>, deny: Vec<Rule>) -> Policy {
        Policy {
            allow,
            deny,
            built_in: BUILT_IN
                .iter()
                .map(|r| Rule::parse(r).expect("a built-in rule"))
                .collect(),
        }
    }

    /// Parses `[outbound] allow` and `deny`.
    pub fn from_lists(allow: &[String], deny: &[String]) -> Result<Policy, String> {
        let parse = |key: &str, list: &[String]| -> Result<Vec<Rule>, String> {
            list.iter()
                .map(|r| Rule::parse(r).map_err(|e| format!("[outbound] {key}: {e}")))
                .collect()
        };
        Ok(Policy::new(parse("allow", allow)?, parse("deny", deny)?))
    }

    /// Whether `ip`, reached as `host` (a name, or the address itself), may be connected to.
    pub fn decide(&self, host: &str, ip: IpAddr) -> Result<(), Refusal> {
        let ip = canonical(ip);
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        if self
            .deny
            .iter()
            .any(|r| r.contains_ip(ip) || r.matches_host(&host))
        {
            return Err(Refusal::Denied);
        }
        if self.built_in.iter().any(|r| r.contains_ip(ip))
            && !self.allow.iter().any(|r| r.contains_ip(ip))
        {
            return Err(Refusal::BuiltIn);
        }
        if !self.allow.is_empty()
            && !self
                .allow
                .iter()
                .any(|r| r.contains_ip(ip) || r.matches_host(&host))
        {
            return Err(Refusal::NotAllowed);
        }
        Ok(())
    }

    /// Whether `host` may be reached **behind a route's first hop** (DOC-23 (am)): it is resolved
    /// by the hop, not here, so a name is checked by name only, against the host and domain
    /// rules (deny first), and an address literal against the address rules and the built-in
    /// refusals as usual. With `allow` rules, a name must match one of them by name: an `allow`
    /// network cannot vouch for a name this server never resolves.
    pub fn decide_remote(&self, host: &str) -> Result<(), Refusal> {
        let bare = host.trim_matches(['[', ']']);
        if let Ok(ip) = bare.parse::<IpAddr>() {
            return self.decide(bare, ip);
        }
        let host = bare.trim_end_matches('.').to_ascii_lowercase();
        if self.deny.iter().any(|r| r.matches_host(&host)) {
            return Err(Refusal::Denied);
        }
        if !self.allow.is_empty() && !self.allow.iter().any(|r| r.matches_host(&host)) {
            return Err(Refusal::NotAllowed);
        }
        Ok(())
    }

    /// Whether the operator narrowed the reach with `allow` rules.
    pub fn is_narrowed(&self) -> bool {
        !self.allow.is_empty()
    }
}

static POLICY: LazyLock<RwLock<Arc<Policy>>> = LazyLock::new(|| RwLock::new(Arc::default()));

/// The policy every outbound connection follows from now on (at start).
pub fn set_policy(policy: Policy) {
    *POLICY
        .write()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(policy);
}

pub fn policy() -> Arc<Policy> {
    Arc::clone(
        &POLICY
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

fn refusal_message(host: &str, ip: IpAddr, why: &Refusal) -> String {
    let at = if host.parse::<IpAddr>().is_ok() {
        ip.to_string()
    } else {
        format!("{host} ({ip})")
    };
    match why {
        Refusal::Denied => format!("{at} is refused by this server's [outbound] deny rules"),
        Refusal::BuiltIn => format!(
            "{at} is a link-local or cloud metadata address, which this server never connects to \
             unless an operator allows its network in [outbound] allow"
        ),
        Refusal::NotAllowed => format!("{at} is not among this server's [outbound] allow rules"),
    }
}

/// Checks a name (or address) a route's hop reaches for this server (DOC-23 (am)): `Forbidden`
/// with the rule's reason when the policy refuses it.
pub fn check_remote(system: &str, host: &str) -> Result<(), ToolError> {
    policy().decide_remote(host).map_err(|why| {
        let message = match why {
            Refusal::Denied => {
                format!("{host} is refused by this server's [outbound] deny rules")
            }
            Refusal::BuiltIn => format!(
                "{host} is a link-local or cloud metadata address, which this server never \
                 connects to unless an operator allows its network in [outbound] allow"
            ),
            Refusal::NotAllowed => format!(
                "{host} is reached through a route, so this server checks it by name, and no \
                 [outbound] allow rule names it (an allowed network cannot vouch for a name \
                 resolved by the hop): an operator can allow the name or its domain"
            ),
        };
        ToolError::new(ToolErrorKind::Forbidden, system, message)
    })
}

/// The addresses of `host:port` this server may connect to, in the resolver's order; an error
/// naming the first refused address when none may be (`Forbidden`), or when the name does not
/// resolve (`Connect`).
pub async fn resolve(system: &str, host: &str, port: u16) -> Result<Vec<SocketAddr>, ToolError> {
    let host = host.trim_matches(['[', ']']);
    let found: Vec<SocketAddr> = match host.parse::<IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| {
                ToolError::new(
                    ToolErrorKind::Connect,
                    system,
                    format!("cannot resolve {host}: {e}"),
                )
            })?
            .collect(),
    };
    let policy = policy();
    let mut refused = None;
    let mut allowed = Vec::new();
    for addr in found {
        match policy.decide(host, addr.ip()) {
            Ok(()) => allowed.push(addr),
            Err(why) => {
                refused.get_or_insert((addr.ip(), why));
            }
        }
    }
    if allowed.is_empty() {
        return Err(match refused {
            Some((ip, why)) => ToolError::new(
                ToolErrorKind::Forbidden,
                system,
                refusal_message(host, ip, &why),
            ),
            None => ToolError::new(
                ToolErrorKind::Connect,
                system,
                format!("cannot resolve {host}: no address"),
            ),
        });
    }
    Ok(allowed)
}

/// A TCP connection to `host:port` through the policy: the first allowed address that answers.
pub async fn connect_tcp(
    system: &str,
    host: &str,
    port: u16,
    timeout: Option<Duration>,
) -> Result<TcpStream, ToolError> {
    let addrs = resolve(system, host, port).await?;
    let display = if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let mut last = None;
    for addr in addrs {
        let attempt = TcpStream::connect(addr);
        let result = match timeout {
            Some(limit) => match tokio::time::timeout(limit, attempt).await {
                Ok(r) => r,
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "timed out",
                )),
            },
            None => attempt.await,
        };
        match result {
            Ok(tcp) => {
                let _ = tcp.set_nodelay(true);
                return Ok(tcp);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(ToolError::new(
        ToolErrorKind::Connect,
        system,
        format!(
            "cannot reach {display}: {}",
            last.map_or_else(|| "no address".to_owned(), |e| e.to_string())
        ),
    ))
}

/// A local socket on this machine (Docker's `socket` transport, DOC-23 §6.2): a Unix socket, or
/// a named pipe on Windows. The network rules do not apply (nothing leaves the machine); what
/// guards it is `profiles.hostAccess`, needed to save a profile that names one (DOC-25 §3.4.2).
/// Opened here so that every connection the server makes is in this file.
pub async fn connect_local(path: &std::path::Path) -> std::io::Result<net_route::BoxStream> {
    #[cfg(unix)]
    {
        let stream = tokio::net::UnixStream::connect(path).await?;
        Ok(Box::new(stream))
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        /// `ERROR_PIPE_BUSY`: every instance of the pipe is in use; the server makes one soon.
        const ERROR_PIPE_BUSY: i32 = 231;
        loop {
            match ClientOptions::new().open(path.as_os_str()) {
                Ok(pipe) => return Ok(Box::new(pipe)),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "this system has no local sockets",
        ))
    }
}

/// The one connector for hyper's client and tonic's channel (DOC-23 §7): plain TCP through the
/// policy, or a stream through the profile's route ([`Via`]). The TLS of `hyper_rustls` or
/// tonic wraps it, so TLS runs end to end to the target and no hop opens it.
#[derive(Debug, Clone)]
pub struct Connector {
    system: &'static str,
    timeout: Option<Duration>,
    via: Via,
}

impl Connector {
    pub fn new(system: &'static str, timeout: Option<Duration>) -> Connector {
        Connector {
            system,
            timeout,
            via: Via::Direct,
        }
    }

    /// Connects through `via` (the profile's route) instead of Direct.
    pub fn via(mut self, via: Via) -> Connector {
        self.via = via;
        self
    }
}

type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// A route's failure as the error a connector returns: hyper and tonic wrap it, and
/// [`route_failure`] finds it again, so the tool's error keeps the hop (`ToolError.hop`).
#[derive(Debug)]
pub struct RouteFailure(pub ToolError);

impl std::fmt::Display for RouteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0.message)
    }
}

impl std::error::Error for RouteFailure {}

/// The route's failure inside an error chain, if a route failed.
pub fn route_failure(error: &(dyn std::error::Error + 'static)) -> Option<ToolError> {
    let mut at = Some(error);
    while let Some(e) = at {
        if let Some(found) = e.downcast_ref::<RouteFailure>() {
            return Some(found.0.clone());
        }
        at = e.source();
    }
    None
}

/// What a [`Connector`] connects: a TCP connection, or a route's stream.
pub enum Conn {
    Tcp(TcpStream),
    Routed(net_route::BoxStream),
}

impl tokio::io::AsyncRead for Conn {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(s) => Pin::new(s).poll_read(cx, buf),
            Conn::Routed(s) => Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl tokio::io::AsyncWrite for Conn {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.get_mut() {
            Conn::Tcp(s) => Pin::new(s).poll_write(cx, buf),
            Conn::Routed(s) => Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(s) => Pin::new(s).poll_flush(cx),
            Conn::Routed(s) => Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        match self.get_mut() {
            Conn::Tcp(s) => Pin::new(s).poll_shutdown(cx),
            Conn::Routed(s) => Pin::new(s).poll_shutdown(cx),
        }
    }
}

impl hyper_util::client::legacy::connect::Connection for Conn {
    fn connected(&self) -> hyper_util::client::legacy::connect::Connected {
        match self {
            Conn::Tcp(s) => s.connected(),
            Conn::Routed(_) => hyper_util::client::legacy::connect::Connected::new(),
        }
    }
}

impl tower_service::Service<Uri> for Connector {
    type Response = TokioIo<Conn>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let (system, timeout, via) = (self.system, self.timeout, self.via.clone());
        Box::pin(async move {
            let host = uri.host().ok_or("the URL has no host")?.to_owned();
            let host = host.trim_matches(['[', ']']).to_owned();
            let port = uri.port_u16().unwrap_or(match uri.scheme_str() {
                Some("https") => 443,
                _ => 80,
            });
            match via.routed() {
                None => connect_tcp(system, &host, port, timeout)
                    .await
                    .map(|tcp| TokioIo::new(Conn::Tcp(tcp)))
                    .map_err(|e| BoxError::from(e.message)),
                Some(routed) => routed
                    .dial(&host, port, timeout)
                    .await
                    .map(|stream| TokioIo::new(Conn::Routed(stream)))
                    .map_err(|e| BoxError::from(RouteFailure(e))),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    fn rules(list: &[&str]) -> Vec<Rule> {
        list.iter().map(|r| Rule::parse(r).unwrap()).collect()
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    #[test]
    fn names_behind_a_route_are_checked_by_name() {
        let open = Policy::new(vec![], rules(&["*.denied.example"]));
        assert_eq!(open.decide_remote("db.internal"), Ok(()));
        assert_eq!(open.decide_remote("x.denied.example"), Err(Refusal::Denied));
        assert_eq!(open.decide_remote("169.254.169.254"), Err(Refusal::BuiltIn));
        let narrowed = Policy::new(rules(&["10.0.0.0/8", "*.corp.example"]), vec![]);
        assert_eq!(narrowed.decide_remote("db.corp.example"), Ok(()));
        assert_eq!(narrowed.decide_remote("10.1.2.3"), Ok(()));
        // An allowed network cannot vouch for a name the hop resolves.
        assert_eq!(
            narrowed.decide_remote("db.internal"),
            Err(Refusal::NotAllowed)
        );
    }

    #[test]
    fn rules_parse_addresses_networks_hosts_and_domains() {
        assert_eq!(Rule::parse("10.0.0.0/8"), Ok(Rule::Net(ip("10.0.0.0"), 8)));
        assert_eq!(Rule::parse("10.1.2.3"), Ok(Rule::Net(ip("10.1.2.3"), 32)));
        assert_eq!(Rule::parse("[fd00::1]"), Ok(Rule::Net(ip("fd00::1"), 128)));
        assert_eq!(
            Rule::parse("NATS.Corp.Example."),
            Ok(Rule::Host("nats.corp.example".into()))
        );
        assert_eq!(
            Rule::parse("*.corp.example"),
            Ok(Rule::Domain("corp.example".into()))
        );
        for bad in [
            "",
            "10.0.0.0/33",
            "fd00::/129",
            "nats corp",
            "a/8",
            "*.",
            "x..y",
        ] {
            assert!(Rule::parse(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn by_default_metadata_and_link_local_are_refused_and_private_networks_reached() {
        let p = Policy::default();
        for refused in [
            "169.254.169.254",
            "169.254.1.1",
            "fe80::1",
            "fd00:ec2::254",
            "100.100.100.200",
            "192.0.0.192",
            "0.0.0.0",
            "::",
            "::ffff:169.254.169.254",
        ] {
            assert_eq!(
                p.decide(refused, ip(refused)),
                Err(Refusal::BuiltIn),
                "{refused}"
            );
        }
        // A name that resolves there is refused just the same.
        assert_eq!(
            p.decide("metadata.google.internal", ip("169.254.169.254")),
            Err(Refusal::BuiltIn)
        );
        for reached in [
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "::1",
            "fd12::1",
            "8.8.8.8",
        ] {
            assert_eq!(p.decide(reached, ip(reached)), Ok(()), "{reached}");
        }
    }

    #[test]
    fn deny_wins_allow_narrows_and_only_a_network_lifts_a_built_in_refusal() {
        let p = Policy::new(
            rules(&["10.0.0.0/8", "*.corp.example", "169.254.10.0/24"]),
            rules(&["10.9.0.0/16", "bad.corp.example"]),
        );
        assert_eq!(p.decide("10.1.2.3", ip("10.1.2.3")), Ok(()));
        assert_eq!(p.decide("10.9.1.1", ip("10.9.1.1")), Err(Refusal::Denied));
        assert_eq!(
            p.decide("192.168.1.1", ip("192.168.1.1")),
            Err(Refusal::NotAllowed)
        );
        // A host the allow rules name, at any address the policy does not otherwise refuse.
        assert_eq!(p.decide("nats.corp.example", ip("203.0.113.5")), Ok(()));
        assert_eq!(p.decide("corp.example", ip("203.0.113.5")), Ok(()));
        assert_eq!(
            p.decide("notcorp.example", ip("203.0.113.5")),
            Err(Refusal::NotAllowed)
        );
        assert_eq!(
            p.decide("bad.corp.example", ip("10.1.2.3")),
            Err(Refusal::Denied)
        );
        // An allowed name does not lift the built-in refusal; an allowed network does.
        assert_eq!(
            p.decide("meta.corp.example", ip("169.254.169.254")),
            Err(Refusal::BuiltIn)
        );
        assert_eq!(p.decide("169.254.10.7", ip("169.254.10.7")), Ok(()));
    }

    /// No code of the server opens a connection around the policy: a new tool cannot forget it.
    /// Its tests (`*tests.rs`, the `tests` modules) may.
    #[test]
    fn every_outbound_connection_goes_through_here() {
        const AROUND: &[&str] = &[
            "TcpStream::connect(",
            "UnixStream::connect(",
            "HttpConnector::new(",
            "connect_lazy(",
            ".connect()\n",
            "lookup_host(",
        ];
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut found = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().filter_map(Result::ok) {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if !name.ends_with(".rs")
                    || name.ends_with("tests.rs")
                    || path.ends_with("core/outbound.rs")
                {
                    continue;
                }
                let text = std::fs::read_to_string(&path).unwrap();
                // The code before the file's test module.
                let code = text
                    .split("#[cfg(test)]\nmod tests")
                    .next()
                    .unwrap_or_default();
                for pattern in AROUND {
                    if code.contains(pattern) {
                        found.push(format!(
                            "{}: {pattern:?}",
                            path.strip_prefix(&root).unwrap().display()
                        ));
                    }
                }
            }
        }
        assert!(
            found.is_empty(),
            "connections around the outbound policy: {found:#?}"
        );
    }

    #[tokio::test]
    async fn resolve_refuses_literals_and_names_and_says_why() {
        let err = resolve("nats", "169.254.169.254", 4222).await.unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        assert!(err.message.contains("cloud metadata"), "{}", err.message);
        let err = resolve("nats", "[fe80::1]", 4222).await.unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::Forbidden);
        // localhost resolves, and loopback is reached by default.
        assert!(!resolve("nats", "localhost", 4222).await.unwrap().is_empty());
        let addr = resolve("nats", "127.0.0.1", 4222).await.unwrap();
        assert_eq!(
            addr,
            vec![SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 4222)]
        );
    }
}
