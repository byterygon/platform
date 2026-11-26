//! Routes and hops: what a caller hands the dialer, as values.

use std::fmt;

use zeroize::Zeroizing;

use crate::command::CommandHop;
use crate::error::{HopRef, RouteError, RouteErrorKind};
use crate::name::{format_address, is_valid_host};
use crate::ssh::{SshCommandHop, SshHop};

/// The most hops a route may have (DOC-23 Open question (f)).
pub const MAX_HOPS: usize = 8;

/// A password or another secret value: wiped from memory when dropped, never printed by `Debug`.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: impl Into<String>) -> Secret {
        Secret(Zeroizing::new(value.into()))
    }

    /// The value, for the one place that sends it.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(<redacted>)")
    }
}

impl From<&str> for Secret {
    fn from(value: &str) -> Secret {
        Secret::new(value)
    }
}

impl From<String> for Secret {
    fn from(value: String) -> Secret {
        Secret::new(value)
    }
}

/// A named, ordered list of 1 to [`MAX_HOPS`] hops. The last hop's stream goes to the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub name: String,
    pub hops: Vec<Hop>,
}

impl Route {
    pub fn new(name: impl Into<String>, hops: Vec<Hop>) -> Route {
        Route {
            name: name.into(),
            hops,
        }
    }

    /// Checks the route before anything is contacted: the number of hops and each hop's fields.
    pub fn validate(&self) -> Result<(), RouteError> {
        if self.hops.is_empty() {
            return Err(RouteError::new(
                None,
                RouteErrorKind::Invalid,
                format!("route {:?} has no hops", self.name),
            ));
        }
        if self.hops.len() > MAX_HOPS {
            return Err(RouteError::new(
                None,
                RouteErrorKind::Invalid,
                format!(
                    "route {:?} has {} hops; a route has at most {MAX_HOPS}",
                    self.name,
                    self.hops.len()
                ),
            ));
        }
        for (index, hop) in self.hops.iter().enumerate() {
            if index > 0 && matches!(hop, Hop::Command(_)) {
                return Err(RouteError::new(
                    Some(hop.at(index)),
                    RouteErrorKind::Invalid,
                    "a local command hop comes first in a route: it starts on this machine and \
                     reaches the next address itself (DOC-23 4.4)",
                ));
            }
            hop.validate().map_err(|(field, message)| match field {
                Some(field) => RouteError::invalid(Some(hop.at(index)), field, message),
                None => RouteError::new(Some(hop.at(index)), RouteErrorKind::Invalid, message),
            })?;
        }
        Ok(())
    }
}

/// One step of a route.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Hop {
    HttpConnect(HttpConnectHop),
    Socks5(Socks5Hop),
    /// An SSH jump host: a `direct-tcpip` channel to the next address (DOC-23 4.3).
    Ssh(SshHop),
    /// A command run on an SSH host, its stdio the stream (DOC-23 4.3b).
    SshCommand(SshCommandHop),
    /// A program on this machine, its stdio the stream; first in a route only (DOC-23 4.4).
    Command(CommandHop),
}

impl Hop {
    /// The kind as the spec names it: `httpConnect`, `socks5`, `ssh`, `sshCommand`, `command`.
    pub fn kind(&self) -> &'static str {
        match self {
            Hop::HttpConnect(_) => "httpConnect",
            Hop::Socks5(_) => "socks5",
            Hop::Ssh(_) => "ssh",
            Hop::SshCommand(_) => "sshCommand",
            Hop::Command(_) => "command",
        }
    }

    /// The address the stream before this hop must reach; `None` for a local command, which
    /// nothing reaches.
    pub fn address(&self) -> Option<(&str, u16)> {
        match self {
            Hop::HttpConnect(h) => Some((&h.host, h.port)),
            Hop::Socks5(h) => Some((&h.host, h.port)),
            Hop::Ssh(h) => Some((&h.host, h.port)),
            Hop::SshCommand(h) => Some((&h.ssh.host, h.ssh.port)),
            Hop::Command(_) => None,
        }
    }

    /// The SSH host of an `ssh` or `sshCommand` hop.
    pub(crate) fn ssh(&self) -> Option<&SshHop> {
        match self {
            Hop::Ssh(h) => Some(h),
            Hop::SshCommand(h) => Some(&h.ssh),
            _ => None,
        }
    }

    /// `host:port` (a local command: its program's name), as the hop is named in errors and
    /// reports.
    pub fn label(&self) -> String {
        match (self, self.address()) {
            (Hop::Command(h), _) => h.label(),
            (_, Some((host, port))) => format_address(host, port),
            (_, None) => self.kind().to_owned(),
        }
    }

    /// This hop as the `index`th of its route.
    pub fn at(&self, index: usize) -> HopRef {
        HopRef {
            index,
            kind: self.kind(),
            label: self.label(),
        }
    }

    fn validate(&self) -> Result<(), (Option<&'static str>, String)> {
        let Some((host, port)) = self.address() else {
            return match self {
                Hop::Command(h) => h.validate(),
                _ => Ok(()),
            };
        };
        if !is_valid_host(host) {
            return Err((
                Some("host"),
                format!("{host:?} is not a host name or an address"),
            ));
        }
        if port == 0 {
            return Err((Some("port"), format!("{host}: the port is 1 to 65535")));
        }
        match self {
            Hop::HttpConnect(h) => h.validate().map_err(|m| (None, m)),
            Hop::Socks5(h) => h.validate().map_err(|m| (None, m)),
            Hop::Ssh(h) => h.validate(),
            Hop::SshCommand(h) => h.validate(),
            Hop::Command(h) => h.validate(),
        }
    }
}

/// `http://` or `https://` to the proxy itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyScheme {
    Http,
    Https,
}

/// An HTTP proxy that tunnels with `CONNECT` (DOC-23 4.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpConnectHop {
    pub scheme: ProxyScheme,
    pub host: String,
    pub port: u16,
    pub auth: Option<BasicAuth>,
    /// For `https://`: the CA the proxy's certificate must chain to, in PEM; `None` uses the
    /// system's roots.
    pub ca_pem: Option<String>,
}

/// A user and password sent as `Proxy-Authorization: Basic`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BasicAuth {
    pub user: String,
    pub password: Secret,
}

impl HttpConnectHop {
    /// A proxy from its URL, `http://host:port` or `https://host:port` (ports 80 and 443 when
    /// left out). Nothing after the port: no path, no user in the URL.
    pub fn from_url(url: &str) -> Result<HttpConnectHop, String> {
        let (scheme, rest, default_port) = if let Some(rest) = url.strip_prefix("http://") {
            (ProxyScheme::Http, rest, 80)
        } else if let Some(rest) = url.strip_prefix("https://") {
            (ProxyScheme::Https, rest, 443)
        } else {
            return Err(format!(
                "{url:?}: a proxy URL starts with http:// or https://"
            ));
        };
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        if rest.contains(['/', '@', '?', '#']) {
            return Err(format!(
                "{url:?}: a proxy URL is a scheme, a host and a port (the login goes in its own fields)"
            ));
        }
        let (host, port) = split_host_port(rest, default_port)
            .ok_or_else(|| format!("{url:?}: not a host and port"))?;
        Ok(HttpConnectHop {
            scheme,
            host,
            port,
            auth: None,
            ca_pem: None,
        })
    }

    fn validate(&self) -> Result<(), String> {
        if let Some(auth) = &self.auth {
            if auth.user.is_empty() {
                return Err(format!("{}: the proxy user is empty", self.label()));
            }
            if auth.user.contains(':') || auth.user.chars().any(char::is_control) {
                return Err(format!(
                    "{}: a Basic login's user cannot contain a colon or a control character",
                    self.label()
                ));
            }
        }
        if let Some(pem) = &self.ca_pem {
            if self.scheme == ProxyScheme::Http {
                return Err(format!(
                    "{}: a pinned CA needs an https:// proxy",
                    self.label()
                ));
            }
            crate::http_connect::parse_ca(pem).map_err(|e| format!("{}: {e}", self.label()))?;
        }
        Ok(())
    }

    fn label(&self) -> String {
        format_address(&self.host, self.port)
    }
}

/// A SOCKS5 proxy (RFC 1928), DOC-23 4.2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Socks5Hop {
    pub host: String,
    pub port: u16,
    pub auth: Socks5Auth,
}

/// How the client logs in to a SOCKS5 proxy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Socks5Auth {
    None,
    /// RFC 1929; each 1 to 255 bytes.
    UserPassword {
        user: String,
        password: Secret,
    },
}

impl Socks5Hop {
    fn validate(&self) -> Result<(), String> {
        if let Socks5Auth::UserPassword { user, password } = &self.auth {
            let label = format_address(&self.host, self.port);
            if user.is_empty() || user.len() > 255 {
                return Err(format!("{label}: the SOCKS5 user is 1 to 255 bytes"));
            }
            if password.expose().is_empty() || password.expose().len() > 255 {
                return Err(format!("{label}: the SOCKS5 password is 1 to 255 bytes"));
            }
        }
        Ok(())
    }
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
        None => Some((text.to_owned(), default_port)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn socks(host: &str) -> Hop {
        Hop::Socks5(Socks5Hop {
            host: host.into(),
            port: 1080,
            auth: Socks5Auth::None,
        })
    }

    #[test]
    fn secrets_stay_out_of_debug() {
        let hop = Hop::HttpConnect(HttpConnectHop {
            auth: Some(BasicAuth {
                user: "alice".into(),
                password: Secret::new("hunter2"),
            }),
            ..HttpConnectHop::from_url("http://proxy:3128").unwrap()
        });
        let text = format!("{:?}", Route::new("r", vec![hop]));
        assert!(
            text.contains("alice") && !text.contains("hunter2"),
            "{text}"
        );
    }

    #[test]
    fn proxy_urls() {
        let h = HttpConnectHop::from_url("https://proxy.corp:8443/").unwrap();
        assert_eq!(
            (h.scheme, h.host.as_str(), h.port),
            (ProxyScheme::Https, "proxy.corp", 8443)
        );
        let h = HttpConnectHop::from_url("http://[fd00::1]").unwrap();
        assert_eq!((h.host.as_str(), h.port), ("fd00::1", 80));
        assert!(HttpConnectHop::from_url("socks5://p:1080").is_err());
        assert!(HttpConnectHop::from_url("http://u:p@proxy:3128").is_err());
        assert!(HttpConnectHop::from_url("http://proxy:3128/path").is_err());
        assert!(HttpConnectHop::from_url("http://proxy:x").is_err());
    }

    #[test]
    fn routes_are_checked_before_use() {
        let err = Route::new("empty", vec![]).validate().unwrap_err();
        assert_eq!((err.kind, err.hop), (RouteErrorKind::Invalid, None));
        let err = Route::new("long", vec![socks("p"); 9])
            .validate()
            .unwrap_err();
        assert!(err.message.contains("at most 8"));
        Route::new("eight", vec![socks("p"); 8]).validate().unwrap();
        let err = Route::new("bad", vec![socks("p"), socks("a b")])
            .validate()
            .unwrap_err();
        assert_eq!(err.hop.unwrap().index, 1);
        let mut hop = HttpConnectHop::from_url("http://p:3128").unwrap();
        hop.auth = Some(BasicAuth {
            user: "a:b".into(),
            password: "x".into(),
        });
        assert!(
            Route::new("r", vec![Hop::HttpConnect(hop)])
                .validate()
                .is_err()
        );
        let mut hop = HttpConnectHop::from_url("https://p:3128").unwrap();
        hop.ca_pem = Some("not a certificate".into());
        let err = Route::new("r", vec![Hop::HttpConnect(hop)])
            .validate()
            .unwrap_err();
        assert!(err.message.contains("CA"), "{}", err.message);
        let long = Hop::Socks5(Socks5Hop {
            host: "p".into(),
            port: 1080,
            auth: Socks5Auth::UserPassword {
                user: "u".repeat(256),
                password: "x".into(),
            },
        });
        assert!(Route::new("r", vec![long]).validate().is_err());
    }
}
