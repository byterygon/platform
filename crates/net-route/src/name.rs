//! Host names and addresses as the crate accepts them.

use std::net::IpAddr;

/// A host the crate sends somewhere (a CONNECT line, a SOCKS5 request, later a command's
/// `{host}`): an IPv4 or IPv6 address (brackets allowed) or a DNS name of letters, digits, `-`
/// and `_` in dot-separated labels. Anything else, a space, a colon in a name, a line break, is
/// refused before anything is contacted, so a host can never add a header or an argument.
pub fn is_valid_host(host: &str) -> bool {
    parse_host(host).is_some()
}

/// What a valid host is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HostKind {
    Ip(IpAddr),
    Name,
}

pub(crate) fn parse_host(host: &str) -> Option<HostKind> {
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        // Brackets only around IPv6.
        if bare.len() != host.len() && ip.is_ipv4() {
            return None;
        }
        return Some(HostKind::Ip(ip));
    }
    if bare.len() != host.len() {
        return None;
    }
    let name = host.strip_suffix('.').unwrap_or(host);
    let ok = !name.is_empty()
        && name.len() <= 253
        && name.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        });
    ok.then_some(HostKind::Name)
}

/// The host without the brackets of an IPv6 address.
pub(crate) fn bare_host(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

/// `host:port`, with brackets around an IPv6 address.
pub fn format_address(host: &str, port: u16) -> String {
    let host = bare_host(host);
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_addresses() {
        for ok in [
            "localhost",
            "db.internal",
            "a-b_c.example.",
            "10.0.0.1",
            "::1",
            "[fd00::1]",
            "xn--bcher-kva.example",
        ] {
            assert!(is_valid_host(ok), "{ok}");
        }
        for bad in [
            "",
            "a b",
            "evil\r\nX-Injected: 1",
            "host:22",
            "[10.0.0.1]",
            "-leading.example",
            "a..b",
            "{host}",
            "$(id)",
            "~",
            &"a".repeat(64),
        ] {
            assert!(!is_valid_host(bad), "{bad:?}");
        }
        assert_eq!(
            parse_host("10.1.2.3"),
            Some(HostKind::Ip([10, 1, 2, 3].into()))
        );
        assert_eq!(parse_host("db"), Some(HostKind::Name));
    }

    #[test]
    fn addresses_bracket_ipv6() {
        assert_eq!(format_address("fd00::1", 22), "[fd00::1]:22");
        assert_eq!(format_address("[fd00::1]", 22), "[fd00::1]:22");
        assert_eq!(format_address("bastion", 22), "bastion:22");
    }
}
