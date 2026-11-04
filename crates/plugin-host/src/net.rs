//! Host-side name resolution and address policy (Plugin Host spec §3, DNS rebinding).
//!
//! The broker resolves names itself, checks every resolved address against the grant's
//! [`AddressPolicy`] and connects to the address it checked, never to the name. It resolves again
//! for every open, so a name that later resolves somewhere else is checked again.

use std::fmt;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// An IP network in CIDR notation, e.g. `10.0.0.0/8` or `fd00::/8`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct IpNet {
    addr: IpAddr,
    prefix: u8,
}

impl IpNet {
    /// The network containing `addr` with `prefix` bits. Host bits must be zero.
    pub fn new(addr: IpAddr, prefix: u8) -> Result<Self, ParseIpNetError> {
        let addr = canonical(addr);
        let max = match addr {
            IpAddr::V4(_) => 32,
            IpAddr::V6(_) => 128,
        };
        if prefix > max {
            return Err(ParseIpNetError);
        }
        let net = Self { addr, prefix };
        if mask(addr, prefix) != bits(addr) {
            return Err(ParseIpNetError);
        }
        Ok(net)
    }

    /// A network holding exactly one address.
    pub fn host(addr: IpAddr) -> Self {
        let addr = canonical(addr);
        let prefix = if addr.is_ipv4() { 32 } else { 128 };
        Self { addr, prefix }
    }

    /// The network address (host bits zero, IPv4-mapped addresses as IPv4).
    pub fn addr(&self) -> IpAddr {
        self.addr
    }

    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        ip.is_ipv4() == self.addr.is_ipv4() && mask(ip, self.prefix) == bits(self.addr)
    }
}

fn bits(ip: IpAddr) -> u128 {
    match ip {
        IpAddr::V4(v4) => u32::from(v4).into(),
        IpAddr::V6(v6) => v6.into(),
    }
}

fn mask(ip: IpAddr, prefix: u8) -> u128 {
    let width = if ip.is_ipv4() { 32 } else { 128 };
    let host_bits = width - u32::from(prefix);
    let m = if host_bits >= 128 {
        0
    } else {
        u128::MAX << host_bits
    };
    bits(ip) & m
}

/// IPv4-mapped IPv6 addresses (`::ffff:a.b.c.d`) are checked as the IPv4 address they reach.
pub(crate) fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
        v4 => v4,
    }
}

impl fmt::Display for IpNet {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.addr, self.prefix)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseIpNetError;

impl fmt::Display for ParseIpNetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("expected an IP network such as 10.0.0.0/8, with host bits zero")
    }
}

impl std::error::Error for ParseIpNetError {}

impl FromStr for IpNet {
    type Err = ParseIpNetError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (addr, prefix) = s.split_once('/').ok_or(ParseIpNetError)?;
        let addr: IpAddr = addr.parse().map_err(|_| ParseIpNetError)?;
        if prefix.is_empty() || prefix.len() > 3 || !prefix.bytes().all(|b| b.is_ascii_digit()) {
            return Err(ParseIpNetError);
        }
        let prefix: u8 = prefix.parse().map_err(|_| ParseIpNetError)?;
        IpNet::new(addr, prefix)
    }
}

impl Serialize for IpNet {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for IpNet {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

/// Which resolved addresses a grant may connect to. Approved together with the grant; there is
/// no implicit default, so an empty policy permits nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressPolicy {
    pub allowed: Vec<IpNet>,
}

impl AddressPolicy {
    pub fn new(allowed: impl IntoIterator<Item = IpNet>) -> Self {
        Self {
            allowed: allowed.into_iter().collect(),
        }
    }

    /// The policy the connection form proposes for a new grant: this machine only
    /// (`127.0.0.1` and `::1`, which is what `localhost` resolves to). The approver widens it to
    /// the database's real addresses when the database runs elsewhere (Plugin Host spec, Open
    /// question 28).
    pub fn loopback() -> Self {
        Self::new([
            IpNet::host(IpAddr::V4(Ipv4Addr::LOCALHOST)),
            IpNet::host(IpAddr::V6(Ipv6Addr::LOCALHOST)),
        ])
    }

    /// Whether the broker may connect to `ip`. Addresses that can never be a TCP peer
    /// (unspecified, multicast, broadcast) are refused whatever the policy says.
    pub fn permits(&self, ip: IpAddr) -> bool {
        let ip = canonical(ip);
        let never = match ip {
            IpAddr::V4(v4) => v4.is_unspecified() || v4.is_multicast() || v4 == Ipv4Addr::BROADCAST,
            IpAddr::V6(v6) => v6.is_unspecified() || v6.is_multicast(),
        };
        !never && self.allowed.iter().any(|net| net.contains(ip))
    }
}

/// Resolves a host name to addresses. The default uses the operating system resolver; tests and
/// deployments with their own DNS policy can supply another.
pub trait Resolver: Send + Sync + 'static {
    fn resolve(
        &self,
        host: &str,
        port: u16,
    ) -> impl Future<Output = io::Result<Vec<IpAddr>>> + Send;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolver;

impl Resolver for SystemResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        Ok(tokio::net::lookup_host((host, port))
            .await?
            .map(|sa| sa.ip())
            .collect())
    }
}

/// A DNS host name, lower-cased: dot-separated labels of letters, digits and inner hyphens.
/// Wildcards are not accepted (no wildcard policy exists yet).
pub(crate) fn normalize_dns_name(name: &str) -> Option<String> {
    let name = name.to_ascii_lowercase();
    let ok = !name.is_empty()
        && name.len() <= 253
        && name.parse::<Ipv4Addr>().is_err()
        && name.parse::<Ipv6Addr>().is_err()
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        });
    ok.then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn cidr_contains() {
        let net: IpNet = "10.1.0.0/16".parse().unwrap();
        assert!(net.contains(ip("10.1.2.3")));
        assert!(!net.contains(ip("10.2.0.1")));
        assert!(!net.contains(ip("fd00::1")));

        let v6: IpNet = "fd00::/8".parse().unwrap();
        assert!(v6.contains(ip("fd12::1")));
        assert!(!v6.contains(ip("fe80::1")));

        let all: IpNet = "0.0.0.0/0".parse().unwrap();
        assert!(all.contains(ip("8.8.8.8")));
        assert!(IpNet::host(ip("127.0.0.1")).contains(ip("127.0.0.1")));
        assert!(!IpNet::host(ip("127.0.0.1")).contains(ip("127.0.0.2")));
    }

    #[test]
    fn mapped_ipv6_is_checked_as_ipv4() {
        let net: IpNet = "127.0.0.1/32".parse().unwrap();
        assert!(net.contains(ip("::ffff:127.0.0.1")));
        let policy = AddressPolicy::new(["10.0.0.0/8".parse().unwrap()]);
        assert!(!policy.permits(ip("::ffff:127.0.0.1")));
        assert!(policy.permits(ip("::ffff:10.0.0.1")));
    }

    #[test]
    fn rejects_bad_cidr() {
        for s in [
            "10.0.0.1/8",
            "10.0.0.0/33",
            "10.0.0.0",
            "10.0.0.0/",
            "10.0.0.0/+8",
            "fd00::/129",
            "host/8",
        ] {
            assert!(s.parse::<IpNet>().is_err(), "accepted {s}");
        }
    }

    #[test]
    fn policy_never_permits_non_unicast() {
        let any = AddressPolicy::new(["0.0.0.0/0".parse().unwrap(), "::/0".parse().unwrap()]);
        assert!(any.permits(ip("192.0.2.1")));
        for s in ["0.0.0.0", "255.255.255.255", "224.0.0.1", "::", "ff02::1"] {
            assert!(!any.permits(ip(s)), "permitted {s}");
        }
        assert!(!AddressPolicy::new([]).permits(ip("192.0.2.1")));
    }

    #[test]
    fn loopback_proposal_is_this_machine_only() {
        let p = AddressPolicy::loopback();
        assert!(p.permits(ip("127.0.0.1")));
        assert!(p.permits(ip("::1")));
        assert!(p.permits(ip("::ffff:127.0.0.1")));
        assert!(!p.permits(ip("127.0.0.2")));
        assert!(!p.permits(ip("172.17.0.1")));
        assert!(!p.permits(ip("10.0.0.1")));
    }

    #[test]
    fn dns_names() {
        assert_eq!(
            normalize_dns_name("DB.Example.com").as_deref(),
            Some("db.example.com")
        );
        for bad in [
            "",
            "*.example.com",
            "a..b",
            "-a.b",
            "a_b.c",
            "10.0.0.1",
            "::1",
            "a b",
        ] {
            assert!(normalize_dns_name(bad).is_none(), "accepted {bad:?}");
        }
    }
}
