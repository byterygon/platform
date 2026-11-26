//! The system proxy (DOC-23 4.6, decision 3): only when a route of kind System is chosen, the
//! environment's `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` (or their lowercase forms) are read
//! once at connect and become one `httpConnect` or `socks5` hop, or Direct for a `NO_PROXY`
//! match. Nothing reads them otherwise.

use std::net::IpAddr;

use crate::name::{HostKind, bare_host, parse_host};
use crate::route::{BasicAuth, Hop, HttpConnectHop, ProxyScheme, Socks5Auth, Socks5Hop};

/// Reads one variable: `std::env::var` in use, a table in tests.
pub type EnvLookup = dyn Fn(&str) -> Option<String> + Send + Sync;

fn var(env: &EnvLookup, name: &str) -> Option<String> {
    env(name)
        .or_else(|| env(&name.to_ascii_lowercase()))
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

/// The hop the environment gives for `host:port`, `None` for Direct (no proxy set, or a
/// `NO_PROXY` match). Errors are a proxy variable that does not read, with the URL's login
/// left out of the message.
pub(crate) fn hop_for(env: &EnvLookup, host: &str, port: u16) -> Result<Option<Hop>, String> {
    if let Some(no_proxy) = var(env, "NO_PROXY")
        && bypasses(&no_proxy, host, port)
    {
        return Ok(None);
    }
    let Some((name, url)) = var(env, "HTTPS_PROXY")
        .map(|v| ("HTTPS_PROXY", v))
        .or_else(|| var(env, "ALL_PROXY").map(|v| ("ALL_PROXY", v)))
    else {
        return Ok(None);
    };
    parse_proxy(&url)
        .map(Some)
        .map_err(|e| format!("{name} does not read as a proxy URL: {e}"))
}

/// `http://`, `https://`, `socks5://` or `socks5h://` (both resolve the target at the proxy),
/// with an optional `user:password@`; no scheme is `http://`.
fn parse_proxy(url: &str) -> Result<Hop, String> {
    let (scheme, rest) = match url.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("http".to_owned(), url),
    };
    let rest = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let (login, address) = match rest.rsplit_once('@') {
        Some((login, address)) => (Some(login), address),
        None => (None, rest),
    };
    let login = login
        .map(|login| {
            let (user, password) = login.split_once(':').unwrap_or((login, ""));
            Ok::<_, String>((percent_decode(user)?, percent_decode(password)?))
        })
        .transpose()?;
    let default_port = match scheme.as_str() {
        "http" => 80,
        "https" => 443,
        "socks5" | "socks5h" => 1080,
        other => {
            return Err(format!(
                "the scheme {other}:// is not supported (http, https, socks5)"
            ));
        }
    };
    let (host, port) = split_host_port(address, default_port).ok_or("not a host and port")?;
    Ok(match scheme.as_str() {
        "socks5" | "socks5h" => Hop::Socks5(Socks5Hop {
            host,
            port,
            auth: match login {
                Some((user, password)) if !user.is_empty() => Socks5Auth::UserPassword {
                    user,
                    password: password.into(),
                },
                _ => Socks5Auth::None,
            },
        }),
        tls => Hop::HttpConnect(HttpConnectHop {
            scheme: if tls == "https" {
                ProxyScheme::Https
            } else {
                ProxyScheme::Http
            },
            host,
            port,
            auth: login
                .filter(|(user, _)| !user.is_empty())
                .map(|(user, password)| BasicAuth {
                    user,
                    password: password.into(),
                }),
            ca_pem: None,
        }),
    })
}

fn split_host_port(text: &str, default_port: u16) -> Option<(String, u16)> {
    if let Some(rest) = text.strip_prefix('[') {
        let (host, after) = rest.split_once(']')?;
        let port = match after {
            "" => default_port,
            p => p.strip_prefix(':')?.parse().ok()?,
        };
        return Some((host.to_owned(), port));
    }
    match text.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') => Some((host.to_owned(), port.parse().ok()?)),
        Some(_) => None,
        None if text.is_empty() => None,
        None => Some((text.to_owned(), default_port)),
    }
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).ok_or("a % escape is cut short")?;
            out.push(u8::from_str_radix(hex, 16).map_err(|_| "a % escape is not hexadecimal")?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| "the login is not UTF-8".to_owned())
}

/// `NO_PROXY`: comma or space separated; `*` matches everything; a name matches itself and every
/// name below it (a leading `.` or `*.` changes nothing); an address or a network (`10.0.0.0/8`)
/// matches addresses; `name:port` only that port.
fn bypasses(no_proxy: &str, host: &str, port: u16) -> bool {
    let host = bare_host(host).trim_end_matches('.').to_ascii_lowercase();
    let ip = match parse_host(&host) {
        Some(HostKind::Ip(ip)) => Some(ip),
        _ => None,
    };
    no_proxy
        .split([',', ' '])
        .map(str::trim)
        .filter(|e| !e.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let (entry, entry_port) = match split_host_port(entry, 0) {
                Some((h, p)) => (h, p),
                None => (entry.to_owned(), 0),
            };
            if entry_port != 0 && entry_port != port {
                return false;
            }
            let entry = entry.to_ascii_lowercase();
            if let Some((net, len)) = entry.split_once('/') {
                return match (ip, net.parse::<IpAddr>(), len.parse::<u8>()) {
                    (Some(ip), Ok(net), Ok(len)) => in_network(ip, net, len),
                    _ => false,
                };
            }
            if let Ok(addr) = entry.parse::<IpAddr>() {
                return ip == Some(addr);
            }
            let name = entry.trim_start_matches("*.").trim_start_matches('.');
            !name.is_empty()
                && (host == name
                    || host
                        .strip_suffix(name)
                        .is_some_and(|rest| rest.ends_with('.')))
        })
}

fn in_network(ip: IpAddr, net: IpAddr, len: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) if len <= 32 => {
            let mask = u32::MAX.checked_shl(32 - u32::from(len)).unwrap_or(0);
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) if len <= 128 => {
            let mask = u128::MAX.checked_shl(128 - u32::from(len)).unwrap_or(0);
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Box<EnvLookup> {
        let pairs: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        Box::new(move |name: &str| {
            pairs
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.clone())
        })
    }

    #[test]
    fn https_proxy_then_all_proxy_and_lowercase() {
        let hop = hop_for(
            &*env(&[("https_proxy", "http://u:p%40ss@proxy.corp:3128")]),
            "db",
            5432,
        )
        .unwrap()
        .unwrap();
        match hop {
            Hop::HttpConnect(h) => {
                assert_eq!(
                    (h.host.as_str(), h.port, h.scheme),
                    ("proxy.corp", 3128, ProxyScheme::Http)
                );
                let auth = h.auth.unwrap();
                assert_eq!((auth.user.as_str(), auth.password.expose()), ("u", "p@ss"));
            }
            other => panic!("{other:?}"),
        }
        let hop = hop_for(&*env(&[("ALL_PROXY", "socks5h://s.corp")]), "db", 1)
            .unwrap()
            .unwrap();
        assert!(matches!(
            hop,
            Hop::Socks5(Socks5Hop {
                port: 1080,
                auth: Socks5Auth::None,
                ..
            })
        ));
        assert_eq!(hop_for(&*env(&[]), "db", 1).unwrap(), None);
        let err = hop_for(&*env(&[("HTTPS_PROXY", "ftp://u:secret@x")]), "db", 1).unwrap_err();
        assert!(
            err.contains("HTTPS_PROXY") && !err.contains("secret"),
            "{err}"
        );
    }

    #[test]
    fn no_proxy_entries() {
        let rules = "localhost, .corp.example, *.lan, 10.0.0.0/8, 192.168.1.5, db.prod:5432";
        for (host, port, direct) in [
            ("localhost", 80, true),
            ("a.corp.example", 1, true),
            ("corp.example", 1, true),
            ("xcorp.example", 1, false),
            ("printer.lan", 1, true),
            ("10.2.3.4", 1, true),
            ("11.0.0.1", 1, false),
            ("192.168.1.5", 1, true),
            ("db.prod", 5432, true),
            ("db.prod", 5433, false),
            ("example.com", 443, false),
        ] {
            assert_eq!(bypasses(rules, host, port), direct, "{host}:{port}");
        }
        assert!(bypasses("*", "anything", 1));
        let hop = hop_for(
            &*env(&[("HTTPS_PROXY", "proxy:3128"), ("NO_PROXY", "db")]),
            "db",
            1,
        )
        .unwrap();
        assert_eq!(hop, None);
    }
}
