//! Proxies, links and routes (DOC-23 §8.1 as revised by (aa) to (ac), TSK-117).
//!
//! Four things are saved once and named by id: **SSH hosts** ([`super::ssh_hosts`]),
//! **proxies** (an HTTP CONNECT or SOCKS5 proxy with its login), **links** (one way of reaching
//! a node from another: `{ from, to, method, settings, confirmed }`) and **routes** (a name and
//! the ordered links from this server to the target). net-route never sees any of this: a route
//! is resolved here into the hops it takes (`ProfileService::route_plan`, DOC-23 (ab)).
//!
//! - **A route as a path.** Nodes are this server, SSH hosts, proxies and the target (the
//!   profile's address). A link's method follows its source: from this server `tcp` or
//!   `command` (a local program), from an SSH host `ssh` (a channel) or `sshCommand` (a command
//!   run there), from a proxy `connect`. The route editor works in hops; [`links_of`] turns them
//!   into the links of the path and [`hops_of`] back: the hop of a proxy or an SSH host is the
//!   link that leaves it, a command hop is the link it is.
//! - **Links are shared.** Saving a route reuses a link of the same owner with the same source,
//!   destination, method and settings, so a command confirmed once is confirmed for every route
//!   that runs it, and a route's duplicate names the same links (its secrets come with it,
//!   DOC-23 (w)). A link no route uses any more is deleted with its secrets, until the network
//!   map (TSK-145) shows links of their own.
//! - **LinkConfirmation** (DOC-23 11.3, (j), (s)). A `command` or `sshCommand` link starts not
//!   confirmed, and changing its program, an argument, an environment name or the command makes
//!   a new link, not confirmed. A route with such a link cannot be tested, chosen or connected
//!   with until a person confirms it (`routes.confirm`), which records who and when.
//! - **Owners** as for SSH hosts (DOC-23 (ae)): a route, its links and the proxies and SSH hosts
//!   it goes through have one owner; a personal profile names its owner's own routes and a
//!   shared profile shared ones.
//! - **Host access** (DOC-25 §3.4.2): a route with a local `command` hop and the System route
//!   run or read something on the server's own machine, so saving or confirming one needs
//!   `profiles.hostAccess`.
//! - **Deleting.** A proxy or an SSH host a route goes through cannot be deleted (the refusal
//!   lists the routes). A route can: the profiles that name it show "Route missing" and never
//!   connect Direct on their own (DOC-23 (v)).

use std::collections::{BTreeMap, BTreeSet};

use net_route::{
    BasicAuth, CommandHop, Hop, HttpConnectHop, MAX_HOPS, ProxyScheme, Socks5Auth, Socks5Hop,
    SshAuth, SshCommandHop, SshHop,
};
use schemars::JsonSchema;
use security_types::Principal;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::spec::ROUTE_FIELD;
use super::table::{
    self, LINKS, Ownership, PROFILES, PROXIES, ROUTES, SSH_HOSTS, StoredProfile, WriteError,
};
use super::{Access, ProfileError, ProfileService, check_name, invalid, new_id, now_text};
use crate::core::AppEvent;
use crate::core::route::{HopHost, RoutePlan};
use crate::secrets::{Owner as SecretOwner, Secret, SecretStatus, size_limit};

/// The `tool` of a proxy row.
pub const PROXY_TOOL: &str = "proxy";
/// The `tool` of a link row.
pub const LINK_TOOL: &str = "link";
/// The `tool` of a route row.
pub const ROUTE_TOOL: &str = "route";
/// The record versions of proxies, links and routes.
pub const VERSION: u32 = 1;
/// An import's source id for a proxy or a route, so it never meets a profile's or a host's.
const PROXY_IMPORT: &str = "proxy/";
const ROUTE_IMPORT: &str = "route/";
/// The largest program, argument, command or value of a command hop.
const MAX_TEXT: usize = 4096;
/// The most arguments and environment variables of a command hop.
const MAX_ITEMS: usize = 64;

// ---- records ---------------------------------------------------------------------------------

/// A node of the network map (DOC-23 (aa)).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Node {
    /// The machine running this server.
    Server,
    SshHost {
        id: String,
    },
    Proxy {
        id: String,
    },
    /// The profile's own address.
    Target,
}

/// How a link's source reaches its destination.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Method {
    /// From this server: a TCP connection.
    Tcp,
    /// From this server: a local program whose stdio is the stream (DOC-23 4.4).
    Command,
    /// From a proxy: its CONNECT (HTTP) or CONNECT command (SOCKS5).
    Connect,
    /// From an SSH host: a `direct-tcpip` channel (DOC-23 4.3).
    Ssh,
    /// From an SSH host: a command run there, its stdio the stream (DOC-23 4.3b).
    SshCommand,
}

/// A variable a command hop adds to its clean environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    /// A secret's value lives in the secret store (`env.<name>` of the link), never here.
    pub secret: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub value: Option<String>,
}

/// Who confirmed a command link, and when (DOC-23 11.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LinkConfirmation {
    pub by: String,
    /// RFC 3339.
    pub at: String,
}

/// A link's fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkFields {
    pub from: Node,
    pub to: Node,
    pub method: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub program: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<EnvVar>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed: Option<LinkConfirmation>,
}

impl LinkFields {
    fn new(from: Node, to: Node, method: Method) -> LinkFields {
        LinkFields {
            from,
            to,
            method,
            program: None,
            args: Vec::new(),
            env: Vec::new(),
            cwd: None,
            command: None,
            confirmed: None,
        }
    }

    /// Whether two links do the same thing (everything but the confirmation).
    fn same_as(&self, other: &LinkFields) -> bool {
        LinkFields {
            confirmed: None,
            ..self.clone()
        } == LinkFields {
            confirmed: None,
            ..other.clone()
        }
    }

    /// A link that runs something a person must have read first.
    pub fn needs_confirmation(&self) -> bool {
        matches!(self.method, Method::Command | Method::SshCommand)
    }

    pub fn is_confirmed(&self) -> bool {
        !self.needs_confirmation() || self.confirmed.is_some()
    }

    fn of(row: &StoredProfile) -> Result<LinkFields, ProfileError> {
        serde_json::from_value(row.fields.clone())
            .map_err(|_| ProfileError::Store(format!("link {} does not read", row.id)))
    }
}

/// A route's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum RouteKind {
    /// A path of links.
    Path,
    /// The proxy variables of the server's environment (DOC-23 4.6, decision 3).
    System,
}

/// A route's fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteFields {
    pub kind: RouteKind,
    #[serde(default)]
    pub links: Vec<String>,
}

impl RouteFields {
    pub fn of(row: &StoredProfile) -> Result<RouteFields, ProfileError> {
        serde_json::from_value(row.fields.clone())
            .map_err(|_| ProfileError::Store(format!("route {} does not read", row.id)))
    }
}

/// A proxy's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProxyKind {
    /// HTTP CONNECT (DOC-23 4.1).
    HttpConnect,
    /// SOCKS5 (DOC-23 4.2).
    Socks5,
}

/// A proxy's fields (never its password).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProxyFields {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    /// HTTP CONNECT only: `https://` to the proxy itself.
    pub tls: bool,
    /// The login's user: Basic for HTTP CONNECT, RFC 1929 for SOCKS5. No login when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub username: Option<String>,
    /// For `tls`: the CA the proxy's certificate must chain to (PEM); the system's roots when
    /// absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub ca_pem: Option<String>,
}

impl ProxyFields {
    pub fn of(row: &StoredProfile) -> Result<ProxyFields, ProfileError> {
        serde_json::from_value(row.fields.clone())
            .map_err(|_| ProfileError::Store(format!("proxy {} does not read", row.id)))
    }

    /// `http://host:port`, `https://host:port` or `socks5://host:port`.
    pub fn url(&self) -> String {
        let scheme = match (self.kind, self.tls) {
            (ProxyKind::Socks5, _) => "socks5",
            (ProxyKind::HttpConnect, false) => "http",
            (ProxyKind::HttpConnect, true) => "https",
        };
        format!(
            "{scheme}://{}",
            net_route::format_address(&self.host, self.port)
        )
    }

    /// Checks and normalizes the fields.
    pub fn check(mut self) -> Result<ProxyFields, ProfileError> {
        self.host = self.host.trim().to_owned();
        if !net_route::is_valid_host(&self.host) {
            return Err(invalid(
                "fields.host",
                "a host name or an address, without a scheme, user or port",
            ));
        }
        if self.port == 0 {
            return Err(invalid("fields.port", "a port from 1 to 65535"));
        }
        if self.kind == ProxyKind::Socks5 && self.tls {
            return Err(invalid("fields.tls", "SOCKS5 has no TLS to the proxy"));
        }
        self.username = self
            .username
            .map(|u| u.trim().to_owned())
            .filter(|u| !u.is_empty());
        if let Some(user) = &self.username {
            let bad = match self.kind {
                ProxyKind::HttpConnect => user.contains(':'),
                ProxyKind::Socks5 => user.len() > 255,
            };
            if bad || user.chars().any(char::is_control) || user.len() > 255 {
                return Err(invalid(
                    "fields.username",
                    "up to 255 bytes, no control character (and no colon for HTTP CONNECT)",
                ));
            }
        }
        self.ca_pem = self.ca_pem.filter(|c| !c.trim().is_empty());
        if let Some(pem) = &self.ca_pem {
            if !self.tls {
                return Err(invalid(
                    "fields.caPem",
                    "a pinned CA needs an https:// proxy",
                ));
            }
            if pem.len() > 256 << 10 || !pem.contains("-----BEGIN CERTIFICATE-----") {
                return Err(invalid("fields.caPem", "a CA certificate in PEM"));
            }
        }
        Ok(self)
    }

    fn to_value(&self) -> Value {
        serde_json::to_value(self).unwrap_or_default()
    }

    /// The fields a stored password is bound to (DOC-25 §3.4.8): all of them.
    fn same_target(&self, other: &ProxyFields) -> bool {
        self == other
    }
}

// ---- the route editor's hops -----------------------------------------------------------------

/// A variable of a command hop, as the editor sends it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EnvInput {
    pub name: String,
    pub secret: bool,
    /// A secret's value is write-only (redacted, never answered); `null` keeps the stored one.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub value: Option<String>,
}

impl std::fmt::Debug for EnvInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnvInput")
            .field("name", &self.name)
            .field("secret", &self.secret)
            .finish_non_exhaustive()
    }
}

/// One hop of a route, as the route editor sends it (DOC-23 §4).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HopInput {
    /// A saved proxy: HTTP CONNECT or SOCKS5 by the proxy's kind.
    Proxy { proxy_id: String },
    /// An SSH jump host.
    Ssh { ssh_host_id: String },
    /// A command run on an SSH host; `{host}` and `{port}` are the next address.
    SshCommand {
        ssh_host_id: String,
        command: String,
    },
    /// A program on this server (first hop only); `{host}` and `{port}` in the arguments.
    Command {
        program: String,
        args: Vec<String>,
        env: Vec<EnvInput>,
        #[serde(default)]
        #[ts(optional = nullable)]
        cwd: Option<String>,
    },
}

fn hop_field(index: usize, field: &str) -> String {
    format!("hops.{index}.{field}")
}

fn check_text(index: usize, field: &str, text: &str, what: &str) -> Result<(), ProfileError> {
    if text.trim().is_empty() {
        return Err(invalid(
            &hop_field(index, field),
            format!("enter the {what}"),
        ));
    }
    if text.len() > MAX_TEXT || text.chars().any(|c| c == '\0') {
        return Err(invalid(
            &hop_field(index, field),
            format!("up to {MAX_TEXT} bytes, without a NUL character"),
        ));
    }
    Ok(())
}

fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 128
}

/// A link of a planned path and the secret variables given for it.
pub type PlannedLink = (LinkFields, Vec<(String, String)>);

/// A row as a list shows it: with the caller's access and who uses it.
pub type Listed = (StoredProfile, Access, Vec<User>);

/// The links of the path the editor's `hops` describe, from this server to the target, with
/// the secret values of each new link's variables by link position. Checks each hop's own
/// fields; the nodes' existence and owners are checked by the caller.
pub fn links_of(hops: &[HopInput]) -> Result<Vec<PlannedLink>, ProfileError> {
    if hops.is_empty() || hops.len() > MAX_HOPS {
        return Err(invalid("hops", format!("a route has 1 to {MAX_HOPS} hops")));
    }
    let mut out = Vec::new();
    let mut from = Node::Server;
    let mut pending = LinkFields::new(Node::Server, Node::Target, Method::Tcp);
    let mut pending_secrets: Vec<(String, String)> = Vec::new();
    let mut seen: BTreeSet<Node> = BTreeSet::new();
    for (index, hop) in hops.iter().enumerate() {
        let node = match hop {
            HopInput::Command {
                program,
                args,
                env,
                cwd,
            } => {
                if index > 0 {
                    return Err(invalid(
                        &hop_field(index, "kind"),
                        "a local command hop comes first in a route: it starts on this server and \
                         reaches the next address itself (DOC-23 4.4)",
                    ));
                }
                check_text(index, "program", program, "program to run")?;
                if args.len() > MAX_ITEMS || env.len() > MAX_ITEMS {
                    return Err(invalid(
                        &hop_field(index, "args"),
                        format!("at most {MAX_ITEMS} arguments and {MAX_ITEMS} variables"),
                    ));
                }
                for arg in args {
                    if arg.len() > MAX_TEXT || arg.contains('\0') {
                        return Err(invalid(
                            &hop_field(index, "args"),
                            format!("an argument is up to {MAX_TEXT} bytes, without NUL"),
                        ));
                    }
                }
                let mut names = BTreeSet::new();
                let mut vars = Vec::new();
                for var in env {
                    if !valid_env_name(&var.name) {
                        return Err(invalid(
                            &hop_field(index, "env"),
                            format!("{:?} is not a variable name (letters, digits, _)", var.name),
                        ));
                    }
                    if !names.insert(var.name.clone()) {
                        return Err(invalid(
                            &hop_field(index, "env"),
                            format!("{} is set twice", var.name),
                        ));
                    }
                    let value = var.value.clone().unwrap_or_default();
                    if value.len() > MAX_TEXT || value.contains('\0') {
                        return Err(invalid(
                            &hop_field(index, "env"),
                            format!("the value of {} is up to {MAX_TEXT} bytes", var.name),
                        ));
                    }
                    if var.secret {
                        if !value.is_empty() {
                            pending_secrets.push((format!("env.{}", var.name), value));
                        }
                        vars.push(EnvVar {
                            name: var.name.clone(),
                            secret: true,
                            value: None,
                        });
                    } else {
                        vars.push(EnvVar {
                            name: var.name.clone(),
                            secret: false,
                            value: Some(value),
                        });
                    }
                }
                let cwd = cwd.clone().filter(|c| !c.trim().is_empty());
                if let Some(cwd) = &cwd {
                    check_text(index, "cwd", cwd, "working directory")?;
                }
                pending = LinkFields {
                    program: Some(program.trim().to_owned()),
                    args: args.clone(),
                    env: vars,
                    cwd,
                    ..LinkFields::new(Node::Server, Node::Target, Method::Command)
                };
                // The program checks itself the way net-route will run it.
                let check = net_route::Route::new(
                    "check",
                    vec![Hop::Command(command_hop(&pending, &BTreeMap::new()))],
                );
                if let Err(e) = check.validate() {
                    return Err(invalid(
                        &hop_field(index, e.field.unwrap_or("program")),
                        e.message,
                    ));
                }
                continue;
            }
            HopInput::Proxy { proxy_id } => Node::Proxy {
                id: proxy_id.clone(),
            },
            HopInput::Ssh { ssh_host_id } | HopInput::SshCommand { ssh_host_id, .. } => {
                Node::SshHost {
                    id: ssh_host_id.clone(),
                }
            }
        };
        if !seen.insert(node.clone()) {
            return Err(invalid(
                &hop_field(index, "kind"),
                "a route passes each proxy and SSH host once (no loop)",
            ));
        }
        pending.from = from.clone();
        pending.to = node.clone();
        out.push((pending, std::mem::take(&mut pending_secrets)));
        from = node.clone();
        pending = match hop {
            HopInput::Proxy { .. } => LinkFields::new(node, Node::Target, Method::Connect),
            HopInput::Ssh { .. } => LinkFields::new(node, Node::Target, Method::Ssh),
            HopInput::SshCommand { command, .. } => {
                check_text(index, "command", command, "command to run on the host")?;
                if command.chars().any(char::is_control) {
                    return Err(invalid(
                        &hop_field(index, "command"),
                        "one line, without control characters",
                    ));
                }
                LinkFields {
                    command: Some(command.trim().to_owned()),
                    ..LinkFields::new(node, Node::Target, Method::SshCommand)
                }
            }
            HopInput::Command { .. } => unreachable!("handled above"),
        };
    }
    pending.from = from;
    pending.to = Node::Target;
    out.push((pending, pending_secrets));
    // The first link from this server is plain TCP unless a command opened it.
    Ok(out)
}

/// The editor's hops of a path of links (the inverse of [`links_of`]).
pub fn hops_of(links: &[LinkFields]) -> Vec<HopInput> {
    let mut hops = Vec::new();
    for link in links {
        match link.method {
            Method::Command => hops.push(HopInput::Command {
                program: link.program.clone().unwrap_or_default(),
                args: link.args.clone(),
                env: link
                    .env
                    .iter()
                    .map(|v| EnvInput {
                        name: v.name.clone(),
                        secret: v.secret,
                        value: v.value.clone(),
                    })
                    .collect(),
                cwd: link.cwd.clone(),
            }),
            Method::Tcp => {}
            Method::Connect | Method::Ssh | Method::SshCommand => match &link.from {
                Node::Proxy { id } => hops.push(HopInput::Proxy {
                    proxy_id: id.clone(),
                }),
                Node::SshHost { id } if link.method == Method::Ssh => hops.push(HopInput::Ssh {
                    ssh_host_id: id.clone(),
                }),
                Node::SshHost { id } => hops.push(HopInput::SshCommand {
                    ssh_host_id: id.clone(),
                    command: link.command.clone().unwrap_or_default(),
                }),
                Node::Server | Node::Target => {}
            },
        }
    }
    hops
}

/// Checks that `links` are a path from this server to the target whose methods follow their
/// sources (a row changed by hand, or a future map, can break that).
fn check_path(links: &[LinkFields]) -> Result<(), ProfileError> {
    let broken = |why: &str| ProfileError::Invalid {
        field: "links".into(),
        message: format!("the route's path is broken ({why}): open it and save it again"),
    };
    let mut at = Node::Server;
    for (i, link) in links.iter().enumerate() {
        if link.from != at {
            return Err(broken("a link does not start where the one before ends"));
        }
        let allowed = match &link.from {
            Node::Server => {
                matches!(link.method, Method::Tcp | Method::Command)
                    && (link.method == Method::Command || link.to != Node::Target)
            }
            Node::Proxy { .. } => link.method == Method::Connect,
            Node::SshHost { .. } => matches!(link.method, Method::Ssh | Method::SshCommand),
            Node::Target => false,
        };
        if !allowed {
            return Err(broken("a link's method does not fit its source"));
        }
        if (link.to == Node::Target) != (i + 1 == links.len()) {
            return Err(broken("only the last link reaches the target"));
        }
        at = link.to.clone();
    }
    if at != Node::Target {
        return Err(broken("it does not reach the target"));
    }
    Ok(())
}

// ---- resolving into net-route's hops ---------------------------------------------------------

fn text(secret: Option<&Secret>) -> Option<net_route::Secret> {
    secret
        .and_then(Secret::as_str)
        .filter(|s| !s.is_empty())
        .map(net_route::Secret::new)
}

fn command_hop(link: &LinkFields, secrets: &BTreeMap<String, Secret>) -> CommandHop {
    CommandHop {
        program: link.program.clone().unwrap_or_default(),
        args: link.args.clone(),
        env: link
            .env
            .iter()
            .map(|v| {
                let value = if v.secret {
                    text(secrets.get(&format!("env.{}", v.name)))
                        .unwrap_or_else(|| net_route::Secret::new(""))
                } else {
                    net_route::Secret::new(v.value.clone().unwrap_or_default())
                };
                (v.name.clone(), value)
            })
            .collect(),
        cwd: link.cwd.clone().map(Into::into),
    }
}

fn proxy_hop(proxy: &ProxyFields, password: Option<&Secret>) -> Hop {
    match proxy.kind {
        ProxyKind::HttpConnect => Hop::HttpConnect(HttpConnectHop {
            scheme: if proxy.tls {
                ProxyScheme::Https
            } else {
                ProxyScheme::Http
            },
            host: proxy.host.clone(),
            port: proxy.port,
            auth: proxy.username.clone().map(|user| BasicAuth {
                user,
                password: text(password).unwrap_or_else(|| net_route::Secret::new("")),
            }),
            ca_pem: proxy.ca_pem.clone(),
        }),
        ProxyKind::Socks5 => Hop::Socks5(Socks5Hop {
            host: proxy.host.clone(),
            port: proxy.port,
            auth: match &proxy.username {
                Some(user) => Socks5Auth::UserPassword {
                    user: user.clone(),
                    password: text(password).unwrap_or_else(|| net_route::Secret::new("")),
                },
                None => Socks5Auth::None,
            },
        }),
    }
}

/// An SSH host's row and secrets as net-route's hop.
pub fn ssh_hop(host: &StoredProfile, secrets: &BTreeMap<String, Secret>) -> SshHop {
    let f = &host.fields;
    let auth = match f["auth"].as_str() {
        Some("password") => SshAuth::Password(
            text(secrets.get("password")).unwrap_or_else(|| net_route::Secret::new("")),
        ),
        Some("agent") => SshAuth::Agent,
        _ => SshAuth::PrivateKey {
            key: text(secrets.get("privateKey")).unwrap_or_else(|| net_route::Secret::new("")),
            passphrase: text(secrets.get("passphrase")),
        },
    };
    let trusted = match (
        f["hostKey"]["algorithm"].as_str(),
        f["hostKey"]["fingerprintSha256"].as_str(),
    ) {
        (Some(a), Some(fp)) => Some(net_route::HostKeyFingerprint {
            algorithm: a.to_owned(),
            fingerprint_sha256: fp.to_owned(),
        }),
        _ => None,
    };
    SshHop {
        name: host.name.clone(),
        host: f["host"].as_str().unwrap_or_default().to_owned(),
        port: f["port"]
            .as_u64()
            .and_then(|p| u16::try_from(p).ok())
            .unwrap_or(22),
        user: f["username"].as_str().unwrap_or_default().to_owned(),
        auth,
        trusted,
        keepalive: match f["keepaliveSec"].as_u64() {
            Some(0) => None,
            Some(s) => Some(std::time::Duration::from_secs(s)),
            None => Some(std::time::Duration::from_secs(30)),
        },
    }
}

// ---- the graph -------------------------------------------------------------------------------

/// The saved profiles, routes, links, proxies and SSH hosts, read together for a view or a
/// check.
pub struct Graph {
    pub profiles: Vec<StoredProfile>,
    pub routes: Vec<StoredProfile>,
    pub links: BTreeMap<String, StoredProfile>,
    pub proxies: BTreeMap<String, StoredProfile>,
    pub hosts: BTreeMap<String, StoredProfile>,
}

impl Graph {
    fn by_id(rows: Vec<StoredProfile>) -> BTreeMap<String, StoredProfile> {
        rows.into_iter().map(|r| (r.id.clone(), r)).collect()
    }

    /// Read in one write transaction (a check that must hold when the write commits).
    pub(crate) fn in_write(write: &redb::WriteTransaction) -> Result<Graph, WriteError> {
        Ok(Graph {
            profiles: table::rows_in(write, PROFILES)?,
            routes: table::rows_in(write, ROUTES)?,
            links: Graph::by_id(table::rows_in(write, LINKS)?),
            proxies: Graph::by_id(table::rows_in(write, PROXIES)?),
            hosts: Graph::by_id(table::rows_in(write, SSH_HOSTS)?),
        })
    }

    /// The links of a route, in order (a missing link breaks the path).
    pub fn route_links(
        &self,
        route: &StoredProfile,
    ) -> Result<Vec<(String, LinkFields)>, ProfileError> {
        let fields = RouteFields::of(route)?;
        fields
            .links
            .iter()
            .map(|id| {
                let row = self.links.get(id).ok_or_else(|| ProfileError::Invalid {
                    field: "links".into(),
                    message: format!("route {} names a link that is gone", route.name),
                })?;
                Ok((id.clone(), LinkFields::of(row)?))
            })
            .collect()
    }

    /// Whether every command link of the route is confirmed.
    pub fn route_confirmed(&self, route: &StoredProfile) -> bool {
        self.route_links(route)
            .map(|links| links.iter().all(|(_, l)| l.is_confirmed()))
            .unwrap_or(false)
    }

    /// The routes whose links pass `node`.
    pub fn routes_through(&self, node: &Node) -> Vec<&StoredProfile> {
        self.routes
            .iter()
            .filter(|route| {
                self.route_links(route)
                    .map(|links| links.iter().any(|(_, l)| l.from == *node || l.to == *node))
                    .unwrap_or(false)
            })
            .collect()
    }

    /// The profiles that name `route_id`.
    pub fn profiles_of(&self, route_id: &str) -> Vec<&StoredProfile> {
        self.profiles
            .iter()
            .filter(|p| route_id_of(&p.fields) == Some(route_id))
            .collect()
    }

    /// The ids of links no route names.
    fn orphan_links(&self) -> Vec<String> {
        let used: BTreeSet<String> = self
            .routes
            .iter()
            .filter_map(|r| RouteFields::of(r).ok())
            .flat_map(|f| f.links)
            .collect();
        self.links
            .keys()
            .filter(|id| !used.contains(*id))
            .cloned()
            .collect()
    }
}

/// The route a profile's fields name, if any.
pub fn route_id_of(fields: &Value) -> Option<&str> {
    fields
        .get(ROUTE_FIELD)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
}

/// Who uses a route, a proxy or an SSH host: a profile or a route.
pub type User = super::ssh_hosts::User;

/// What a stored route resolves to, with its name, for a connection.
pub type Resolution = crate::core::route::ResolvedRoute;

// ---- the service -----------------------------------------------------------------------------

impl ProfileService {
    pub fn graph(&self) -> Result<Graph, ProfileError> {
        Ok(Graph {
            profiles: self.store.profiles()?,
            routes: self.store.rows(ROUTES)?,
            links: Graph::by_id(self.store.rows(LINKS)?),
            proxies: Graph::by_id(self.store.rows(PROXIES)?),
            hosts: Graph::by_id(self.store.ssh_hosts()?),
        })
    }

    fn owned_access(
        &self,
        p: &Principal,
        owner: &Ownership,
        used: impl FnOnce() -> bool,
    ) -> Access {
        match owner {
            Ownership::Personal { user } if *user == p.id => Access::Owner,
            Ownership::Personal { .. } => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Access::Metadata
                } else {
                    Access::None
                }
            }
            Ownership::Shared => {
                if self.authorizer.permits(p, "profiles.manage", None) {
                    Access::Edit
                } else if used() {
                    Access::Use
                } else {
                    Access::None
                }
            }
        }
    }

    /// What `p` may do with a route: as an SSH host; a shared one is seen (never its secrets) by
    /// whoever may use a profile that names it.
    pub fn route_access(&self, p: &Principal, route: &StoredProfile, graph: &Graph) -> Access {
        self.owned_access(p, &route.owner, || {
            graph
                .profiles_of(&route.id)
                .iter()
                .any(|profile| self.access(p, profile).may_use())
        })
    }

    /// What `p` may do with a proxy (or, for [`super::ssh_hosts`], an SSH host's routes): a
    /// shared one is seen by whoever may use a route that passes it.
    pub fn node_access(
        &self,
        p: &Principal,
        row: &StoredProfile,
        node: &Node,
        graph: &Graph,
    ) -> Access {
        self.owned_access(p, &row.owner, || {
            graph
                .routes_through(node)
                .iter()
                .any(|route| self.route_access(p, route, graph).may_use())
        })
    }

    /// The routes that pass `node`, and whether `p` sees each.
    pub fn node_users(&self, p: &Principal, node: &Node, graph: &Graph) -> Vec<User> {
        graph
            .routes_through(node)
            .into_iter()
            .map(|route| User {
                id: route.id.clone(),
                tool: ROUTE_TOOL.into(),
                name: route.name.clone(),
                visible: self.route_access(p, route, graph) > Access::None,
            })
            .collect()
    }

    /// The profiles that name a route, and whether `p` sees each.
    pub fn route_users(&self, p: &Principal, route_id: &str, graph: &Graph) -> Vec<User> {
        graph
            .profiles_of(route_id)
            .into_iter()
            .map(|profile| User {
                id: profile.id.clone(),
                tool: profile.tool.clone(),
                name: profile.name.clone(),
                visible: self.access(p, profile) > Access::None,
            })
            .collect()
    }

    fn route_changed(&self, route: &StoredProfile) {
        let event = AppEvent::RouteChanged {
            id: route.id.clone(),
        };
        let graph = self.graph().ok();
        self.hub.publish_where(&event, |p| match &graph {
            Some(g) => self.route_access(p, route, g) > Access::None,
            None => false,
        });
    }

    fn proxy_changed(&self, proxy: &StoredProfile) {
        let event = AppEvent::ProxyChanged {
            id: proxy.id.clone(),
        };
        let node = Node::Proxy {
            id: proxy.id.clone(),
        };
        let graph = self.graph().ok();
        self.hub.publish_where(&event, |p| match &graph {
            Some(g) => self.node_access(p, proxy, &node, g) > Access::None,
            None => false,
        });
    }

    fn may_reach_host(&self, p: &Principal) -> Result<(), ProfileError> {
        if self.authorizer.permits(p, "profiles.hostAccess", None) {
            Ok(())
        } else {
            Err(ProfileError::Forbidden(
                "a local command hop and the System route run or read something on the server's \
                 own machine: saving or confirming one needs profiles.hostAccess"
                    .into(),
            ))
        }
    }

    fn new_row(
        &self,
        by: &str,
        tool: &str,
        owner: Ownership,
        name: String,
        fields: Value,
        now_ms: u64,
    ) -> StoredProfile {
        let now = now_text(now_ms);
        let id = new_id(now_ms);
        StoredProfile {
            // A link has no name of its own: its id keeps names unique.
            name: if tool == LINK_TOOL { id.clone() } else { name },
            id,
            tool: tool.to_owned(),
            version: VERSION,
            color: None,
            fields,
            extras: json!({}),
            owner,
            etag: 0,
            created_at: now.clone(),
            updated_at: now,
            created_by: by.to_owned(),
            updated_by: by.to_owned(),
        }
    }

    // ---- proxies -----------------------------------------------------------------------------

    pub fn get_proxy(
        &self,
        p: &Principal,
        id: &str,
    ) -> Result<(StoredProfile, Access, Graph), ProfileError> {
        let proxy = self.store.row(PROXIES, id)?.ok_or(ProfileError::NotFound)?;
        let graph = self.graph()?;
        let node = Node::Proxy { id: id.to_owned() };
        match self.node_access(p, &proxy, &node, &graph) {
            Access::None => Err(ProfileError::NotFound),
            access => Ok((proxy, access, graph)),
        }
    }

    /// Every proxy `p` sees, with that access and the routes that pass it.
    pub fn list_proxies(&self, p: &Principal) -> Result<Vec<Listed>, ProfileError> {
        let graph = self.graph()?;
        Ok(graph
            .proxies
            .values()
            .filter_map(|proxy| {
                let node = Node::Proxy {
                    id: proxy.id.clone(),
                };
                match self.node_access(p, proxy, &node, &graph) {
                    Access::None => None,
                    access => Some((proxy.clone(), access, self.node_users(p, &node, &graph))),
                }
            })
            .collect())
    }

    pub fn proxy_secret_status(&self, id: &str) -> Result<Vec<SecretStatus>, ProfileError> {
        Ok(self.vault.status(&self.store, &SecretOwner::proxy(id))?)
    }

    fn open(&self, owner: &SecretOwner) -> Result<BTreeMap<String, Secret>, ProfileError> {
        let mut out = BTreeMap::new();
        for entry in self.store.secret_entries(Some(owner))? {
            out.insert(entry.field.clone(), self.vault.open(&entry)?);
        }
        Ok(out)
    }

    fn proxy_password(password: Option<String>) -> Result<Vec<(String, Secret)>, ProfileError> {
        match password.filter(|p| !p.is_empty()) {
            Some(p) if p.len() > size_limit("password") || p.len() > 255 => {
                Err(invalid("secrets.password", "up to 255 bytes"))
            }
            Some(p) => Ok(vec![("password".into(), Secret::new(p.into_bytes()))]),
            None => Ok(Vec::new()),
        }
    }

    /// `proxies.create` and the body of `proxies.import`.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn create_proxy(
        &self,
        p: &Principal,
        owner: Ownership,
        name: &str,
        fields: ProxyFields,
        password: Option<String>,
        import: Option<&str>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        self.may_create(p, &owner)?;
        let name = check_name(name)?;
        let fields = fields.check()?;
        let secrets = Self::proxy_password(password)?;
        let row = self.new_row(&p.id, PROXY_TOOL, owner, name, fields.to_value(), now_ms);
        let stored = self.store.put_row(PROXIES, row, None, |write, stored| {
            self.write_secrets(
                write,
                &SecretOwner::proxy(&stored.id),
                &secrets,
                &[],
                &p.id,
                now_ms,
            )?;
            if let Some(source) = import {
                table::record_import(write, &p.id, &format!("{PROXY_IMPORT}{source}"), &stored.id)?;
            }
            Ok(())
        })?;
        self.proxy_changed(&stored);
        Ok(stored)
    }

    /// `proxies.update`: a change of any field removes the stored password unless the call sets
    /// it (DOC-25 §3.4.8). Returns the proxy and the secrets removed.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn update_proxy(
        &self,
        p: &Principal,
        id: &str,
        etag: u64,
        name: Option<&str>,
        fields: Option<ProxyFields>,
        password: Option<String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, Vec<String>), ProfileError> {
        let (current, access, _) = self.get_proxy(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not edit this proxy".into(),
            ));
        }
        let mut next = current.clone();
        if let Some(name) = name {
            next.name = check_name(name)?;
        }
        let before = ProxyFields::of(&current)?;
        if let Some(fields) = fields {
            next.fields = fields.check()?.to_value();
        }
        let after = ProxyFields::of(&next)?;
        let secrets = Self::proxy_password(password)?;
        let unbind: Vec<&str> = if !before.same_target(&after) && secrets.is_empty() {
            vec!["password"]
        } else {
            Vec::new()
        };
        next.updated_at = now_text(now_ms);
        next.updated_by = p.id.clone();
        let mut removed = Vec::new();
        let stored = self
            .store
            .put_row(PROXIES, next, Some(etag), |write, stored| {
                removed = self.write_secrets(
                    write,
                    &SecretOwner::proxy(&stored.id),
                    &secrets,
                    &unbind,
                    &p.id,
                    now_ms,
                )?;
                Ok(())
            })?;
        self.proxy_changed(&stored);
        Ok((stored, removed))
    }

    /// `proxies.delete`: refused while a route passes it.
    pub fn delete_proxy(&self, p: &Principal, id: &str, name: &str) -> Result<(), ProfileError> {
        let (current, access, _) = self.get_proxy(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not delete this proxy".into(),
            ));
        }
        if current.name != name {
            return Err(invalid("name", "is not the proxy's name"));
        }
        let node = Node::Proxy { id: id.to_owned() };
        let mut in_use = None;
        self.store
            .delete_row(PROXIES, SecretOwner::proxy(id), |write| {
                let graph = Graph::in_write(write)?;
                let users = self.node_users(p, &node, &graph);
                if !users.is_empty() {
                    in_use = Some(users);
                    return Err(WriteError::Stale);
                }
                Ok(())
            })
            .map_err(|e| match in_use.take() {
                Some(users) => in_use_error(&current.name, "proxy", &users),
                None => e.into(),
            })?;
        self.proxy_changed(&current);
        Ok(())
    }

    /// `secrets.set` of a proxy's password.
    pub fn set_proxy_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
        value: String,
        now_ms: u64,
    ) -> Result<SecretStatus, ProfileError> {
        let (proxy, access, _) = self.get_proxy(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not set this proxy's password".into(),
            ));
        }
        if field != "password" {
            return Err(invalid("field", "a proxy's only secret is password"));
        }
        let Some((field, value)) = Self::proxy_password(Some(value))?.pop() else {
            return Err(invalid("value", "empty: remove the secret instead"));
        };
        let status = self.vault.set(
            &self.store,
            &SecretOwner::proxy(id),
            &field,
            &value,
            &p.id,
            now_ms,
        )?;
        self.proxy_changed(&proxy);
        Ok(status)
    }

    /// `secrets.remove` of a proxy's password.
    pub fn remove_proxy_secret(
        &self,
        p: &Principal,
        id: &str,
        field: &str,
    ) -> Result<bool, ProfileError> {
        let (proxy, access, _) = self.get_proxy(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not remove this proxy's password".into(),
            ));
        }
        if field != "password" {
            return Err(invalid("field", "a proxy's only secret is password"));
        }
        let removed = self
            .vault
            .remove(&self.store, &SecretOwner::proxy(id), field)?;
        self.proxy_changed(&proxy);
        Ok(removed)
    }

    /// `proxies.import`: once per `(user, sourceId)`; a taken name gets `-2`.
    #[allow(clippy::too_many_arguments, reason = "the import's parts")]
    pub fn import_proxy(
        &self,
        p: &Principal,
        source_id: &str,
        owner: Ownership,
        name: &str,
        fields: ProxyFields,
        password: Option<String>,
        now_ms: u64,
    ) -> Result<(StoredProfile, bool), ProfileError> {
        check_source(source_id)?;
        if let Some(id) = self
            .store
            .imported(&p.id, &format!("{PROXY_IMPORT}{source_id}"))?
            && let Ok((proxy, _, _)) = self.get_proxy(p, &id)
        {
            return Ok((proxy, false));
        }
        let rows = self.store.rows(PROXIES)?;
        let name = free_name(&rows, &owner, PROXY_TOOL, &check_name(name)?);
        let proxy =
            self.create_proxy(p, owner, &name, fields, password, Some(source_id), now_ms)?;
        Ok((proxy, true))
    }

    // ---- routes ------------------------------------------------------------------------------

    pub fn get_route(
        &self,
        p: &Principal,
        id: &str,
    ) -> Result<(StoredProfile, Access, Graph), ProfileError> {
        let route = self.store.row(ROUTES, id)?.ok_or(ProfileError::NotFound)?;
        let graph = self.graph()?;
        match self.route_access(p, &route, &graph) {
            Access::None => Err(ProfileError::NotFound),
            access => Ok((route, access, graph)),
        }
    }

    /// Every route `p` sees, with that access and the profiles that name it.
    pub fn list_routes(&self, p: &Principal) -> Result<(Vec<Listed>, Graph), ProfileError> {
        let graph = self.graph()?;
        let routes = graph
            .routes
            .iter()
            .filter_map(|route| match self.route_access(p, route, &graph) {
                Access::None => None,
                access => Some((
                    route.clone(),
                    access,
                    self.route_users(p, &route.id, &graph),
                )),
            })
            .collect();
        Ok((routes, graph))
    }

    /// The status of a link's secrets (its secret variables).
    pub fn link_secret_status(&self, id: &str) -> Result<Vec<SecretStatus>, ProfileError> {
        Ok(self.vault.status(&self.store, &SecretOwner::link(id))?)
    }

    /// Checks that every node the links pass exists and has `owner`.
    fn check_nodes(
        &self,
        owner: &Ownership,
        links: &[LinkFields],
        graph: &Graph,
    ) -> Result<(), ProfileError> {
        for (index, link) in links.iter().enumerate() {
            let (row, what, field) = match &link.to {
                Node::Proxy { id } => (graph.proxies.get(id), "proxy", "proxyId"),
                Node::SshHost { id } => (graph.hosts.get(id), "SSH host", "sshHostId"),
                Node::Server | Node::Target => continue,
            };
            let field = hop_field(index, field);
            let row = row.ok_or_else(|| invalid(&field, format!("no such {what}")))?;
            if row.owner != *owner {
                return Err(invalid(
                    &field,
                    match owner {
                        Ownership::Personal { .. } => {
                            format!("a personal route goes through its owner's own {what}s")
                        }
                        Ownership::Shared => format!("a shared route goes through shared {what}s"),
                    },
                ));
            }
        }
        Ok(())
    }

    /// The links of `hops` for a route of `owner`: an existing link that does the same thing, or
    /// a new one (not confirmed when it runs something). `carry` holds the secret variables of
    /// the route's previous links by position, kept when the same variable stays secret.
    #[allow(clippy::type_complexity, reason = "the plan's parts")]
    fn plan_links(
        &self,
        by: &str,
        owner: &Ownership,
        hops: &[HopInput],
        graph: &Graph,
        carry: &[BTreeMap<String, Secret>],
        now_ms: u64,
    ) -> Result<
        (
            Vec<String>,
            Vec<(StoredProfile, Vec<(String, Secret)>)>,
            Vec<(String, Vec<(String, Secret)>)>,
        ),
        ProfileError,
    > {
        let wanted = links_of(hops)?;
        let fields: Vec<LinkFields> = wanted.iter().map(|(f, _)| f.clone()).collect();
        self.check_nodes(owner, &fields, graph)?;
        let mut ids = Vec::new();
        let mut new_links = Vec::new();
        let mut set_on_existing = Vec::new();
        for (position, (link, given)) in wanted.into_iter().enumerate() {
            let given: Vec<(String, Secret)> = given
                .into_iter()
                .map(|(k, v)| (k, Secret::new(v.into_bytes())))
                .collect();
            let existing = graph.links.values().find(|row| {
                row.owner == *owner && LinkFields::of(row).is_ok_and(|l| l.same_as(&link))
            });
            match existing {
                Some(row) => {
                    if !given.is_empty() {
                        set_on_existing.push((row.id.clone(), given));
                    }
                    ids.push(row.id.clone());
                }
                None => {
                    let mut secrets = given;
                    for var in link.env.iter().filter(|v| v.secret) {
                        let field = format!("env.{}", var.name);
                        if secrets.iter().any(|(k, _)| *k == field) {
                            continue;
                        }
                        match carry.get(position).and_then(|c| c.get(&field)) {
                            Some(value) => {
                                secrets.push((field, Secret::new(value.expose().to_vec())))
                            }
                            None => {
                                return Err(invalid(
                                    &hop_field(0, "env"),
                                    format!("enter the value of the secret variable {}", var.name),
                                ));
                            }
                        }
                    }
                    let row = self.new_row(
                        by,
                        LINK_TOOL,
                        owner.clone(),
                        String::new(),
                        serde_json::to_value(&link).unwrap_or_default(),
                        now_ms,
                    );
                    ids.push(row.id.clone());
                    new_links.push((row, secrets));
                }
            }
        }
        Ok((ids, new_links, set_on_existing))
    }

    /// Writes a route row with its new links and their secrets, sets the secrets given for
    /// links it reuses, and deletes the links no route uses any more, in one transaction.
    #[allow(clippy::too_many_arguments, reason = "the write's parts")]
    fn write_route(
        &self,
        by: &str,
        row: StoredProfile,
        expected: Option<u64>,
        new_links: Vec<(StoredProfile, Vec<(String, Secret)>)>,
        set_on_existing: Vec<(String, Vec<(String, Secret)>)>,
        import: Option<&str>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        Ok(self.store.put_row(ROUTES, row, expected, |write, stored| {
            for (link, secrets) in new_links {
                let link = table::put_in(write, LINKS, link, None)?;
                self.write_secrets(
                    write,
                    &SecretOwner::link(&link.id),
                    &secrets,
                    &[],
                    by,
                    now_ms,
                )?;
            }
            for (id, secrets) in set_on_existing {
                self.write_secrets(write, &SecretOwner::link(&id), &secrets, &[], by, now_ms)?;
            }
            if let Some(source) = import {
                table::record_import(write, by, &format!("{ROUTE_IMPORT}{source}"), &stored.id)?;
            }
            let graph = Graph::in_write(write)?;
            for id in graph.orphan_links() {
                table::delete_in(write, LINKS, &SecretOwner::link(&id))?;
            }
            Ok(())
        })?)
    }

    fn route_fields_value(kind: RouteKind, links: Vec<String>) -> Value {
        serde_json::to_value(RouteFields { kind, links }).unwrap_or_default()
    }

    /// `routes.create` and the body of `routes.import`: a path of `hops`, or the System route.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn create_route(
        &self,
        p: &Principal,
        owner: Ownership,
        name: &str,
        kind: RouteKind,
        hops: &[HopInput],
        import: Option<&str>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        self.may_create(p, &owner)?;
        let name = check_name(name)?;
        let graph = self.graph()?;
        let (links, new_links, set) = match kind {
            RouteKind::System => {
                if !hops.is_empty() {
                    return Err(invalid("hops", "the System route has no hops"));
                }
                self.may_reach_host(p)?;
                (Vec::new(), Vec::new(), Vec::new())
            }
            RouteKind::Path => {
                if hops.iter().any(|h| matches!(h, HopInput::Command { .. })) {
                    self.may_reach_host(p)?;
                }
                self.plan_links(&p.id, &owner, hops, &graph, &[], now_ms)?
            }
        };
        let row = self.new_row(
            &p.id,
            ROUTE_TOOL,
            owner,
            name,
            Self::route_fields_value(kind, links),
            now_ms,
        );
        let stored = self.write_route(&p.id, row, None, new_links, set, import, now_ms)?;
        self.route_changed(&stored);
        Ok(stored)
    }

    /// `routes.update`: the name and the hops given, at `etag`.
    #[allow(clippy::too_many_arguments, reason = "the record's parts")]
    pub fn update_route(
        &self,
        p: &Principal,
        id: &str,
        etag: u64,
        name: Option<&str>,
        hops: Option<&[HopInput]>,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let (current, access, graph) = self.get_route(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not edit this route".into(),
            ));
        }
        let mut next = current.clone();
        if let Some(name) = name {
            next.name = check_name(name)?;
        }
        let fields = RouteFields::of(&current)?;
        let (mut new_links, mut set) = (Vec::new(), Vec::new());
        if let Some(hops) = hops {
            if fields.kind == RouteKind::System {
                return Err(invalid("hops", "the System route has no hops"));
            }
            if hops.iter().any(|h| matches!(h, HopInput::Command { .. })) {
                self.may_reach_host(p)?;
            }
            // The secret variables of the links it had, by position.
            let mut carry = Vec::new();
            for id in &fields.links {
                carry.push(self.open(&SecretOwner::link(id)).unwrap_or_default());
            }
            let (links, n, s) =
                self.plan_links(&p.id, &current.owner, hops, &graph, &carry, now_ms)?;
            next.fields = Self::route_fields_value(RouteKind::Path, links);
            new_links = n;
            set = s;
        }
        next.updated_at = now_text(now_ms);
        next.updated_by = p.id.clone();
        let stored = self.write_route(&p.id, next, Some(etag), new_links, set, None, now_ms)?;
        self.route_changed(&stored);
        Ok(stored)
    }

    /// `routes.duplicate`: a copy named `name` with the same owner, over the same links (their
    /// secrets and confirmations with them, DOC-23 (w)).
    pub fn duplicate_route(
        &self,
        p: &Principal,
        id: &str,
        name: &str,
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let (source, access, graph) = self.get_route(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not copy this route".into(),
            ));
        }
        let fields = RouteFields::of(&source)?;
        let local = fields.kind == RouteKind::System
            || graph
                .route_links(&source)?
                .iter()
                .any(|(_, l)| l.method == Method::Command);
        if local {
            self.may_reach_host(p)?;
        }
        let row = self.new_row(
            &p.id,
            ROUTE_TOOL,
            source.owner.clone(),
            check_name(name)?,
            source.fields.clone(),
            now_ms,
        );
        let stored = self.write_route(&p.id, row, None, Vec::new(), Vec::new(), None, now_ms)?;
        self.route_changed(&stored);
        Ok(stored)
    }

    /// `routes.delete` (confirmed by the route's name): the profiles that name it show "Route
    /// missing" from now on.
    pub fn delete_route(&self, p: &Principal, id: &str, name: &str) -> Result<(), ProfileError> {
        let (current, access, _) = self.get_route(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not delete this route".into(),
            ));
        }
        if current.name != name {
            return Err(invalid("name", "is not the route's name"));
        }
        self.store.write(|write| {
            table::delete_in(
                write,
                ROUTES,
                &SecretOwner::new(crate::secrets::OwnerKind::Route, id),
            )?;
            let graph = Graph::in_write(write)?;
            for link in graph.orphan_links() {
                table::delete_in(write, LINKS, &SecretOwner::link(&link))?;
            }
            Ok(())
        })?;
        self.route_changed(&current);
        Ok(())
    }

    /// `routes.confirm`: a person read the commands of `links` (as the confirmation showed
    /// them) and lets the route run them. Only links of this route; a local command needs
    /// `profiles.hostAccess`.
    pub fn confirm_route(
        &self,
        p: &Principal,
        id: &str,
        links: &[String],
        now_ms: u64,
    ) -> Result<StoredProfile, ProfileError> {
        let (route, access, graph) = self.get_route(p, id)?;
        if !access.may_edit() {
            return Err(ProfileError::Forbidden(
                "you may not confirm this route".into(),
            ));
        }
        let path = graph.route_links(&route)?;
        for link_id in links {
            let Some((_, link)) = path.iter().find(|(lid, _)| lid == link_id) else {
                return Err(invalid(
                    "links",
                    "a link is no longer part of this route: reload it and read it again",
                ));
            };
            if link.method == Method::Command {
                self.may_reach_host(p)?;
            }
        }
        let at = now_text(now_ms);
        self.store.write(|write| {
            for link_id in links {
                let Some(row) = table::rows_in(write, LINKS)?
                    .into_iter()
                    .find(|r| r.id == *link_id)
                else {
                    return Err(WriteError::Missing);
                };
                let mut fields: LinkFields = serde_json::from_value(row.fields.clone())
                    .map_err(|e| WriteError::Store(e.to_string()))?;
                if !fields.needs_confirmation() || fields.confirmed.is_some() {
                    continue;
                }
                fields.confirmed = Some(LinkConfirmation {
                    by: p.id.clone(),
                    at: at.clone(),
                });
                let mut next = row.clone();
                next.fields =
                    serde_json::to_value(&fields).map_err(|e| WriteError::Store(e.to_string()))?;
                next.updated_at = at.clone();
                next.updated_by = p.id.clone();
                table::put_in(write, LINKS, next, Some(row.etag))?;
            }
            Ok(())
        })?;
        // Every route over these links changed state.
        let graph = self.graph()?;
        for other in &graph.routes {
            if RouteFields::of(other).is_ok_and(|f| f.links.iter().any(|l| links.contains(l))) {
                self.route_changed(other);
            }
        }
        Ok(self.store.row(ROUTES, id)?.unwrap_or(route))
    }

    /// `routes.import`: once per `(user, sourceId)`; the hops name proxies and SSH hosts already
    /// imported. A command the owner has not confirmed arrives not confirmed.
    #[allow(clippy::too_many_arguments, reason = "the import's parts")]
    pub fn import_route(
        &self,
        p: &Principal,
        source_id: &str,
        owner: Ownership,
        name: &str,
        kind: RouteKind,
        hops: &[HopInput],
        now_ms: u64,
    ) -> Result<(StoredProfile, bool), ProfileError> {
        check_source(source_id)?;
        if let Some(id) = self
            .store
            .imported(&p.id, &format!("{ROUTE_IMPORT}{source_id}"))?
            && let Ok((route, _, _)) = self.get_route(p, &id)
        {
            return Ok((route, false));
        }
        let rows = self.store.rows(ROUTES)?;
        let name = free_name(&rows, &owner, ROUTE_TOOL, &check_name(name)?);
        let route = self.create_route(p, owner, &name, kind, hops, Some(source_id), now_ms)?;
        Ok((route, true))
    }

    // ---- profiles and connections ------------------------------------------------------------

    /// Checks the route a profile of `tool` and `owner` names in `fields`: it exists, has the
    /// profile's owner and is confirmed, and the tool connects through routes.
    pub(crate) fn check_route_link(
        &self,
        tool: &str,
        owner: &Ownership,
        fields: &Value,
    ) -> Result<(), ProfileError> {
        let Some(id) = route_id_of(fields) else {
            if fields
                .get(ROUTE_FIELD)
                .is_some_and(|v| !v.is_null() && v != "")
            {
                return Err(invalid(&format!("fields.{ROUTE_FIELD}"), "a route's id"));
            }
            return Ok(());
        };
        takes_routes(tool, fields)?;
        let field = format!("fields.{ROUTE_FIELD}");
        let graph = self.graph()?;
        let route = graph
            .routes
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| invalid(&field, ROUTE_MISSING))?;
        same_owner(owner, &route.owner, &field)?;
        if !graph.route_confirmed(route) {
            return Err(invalid(
                &field,
                format!(
                    "route {} runs a command nobody confirmed yet: confirm it in Settings → Routes first",
                    route.name
                ),
            ));
        }
        Ok(())
    }

    /// The route a profile names, resolved with its secrets for a connection: `None` for Direct.
    pub(crate) fn route_plan(
        &self,
        tool: &str,
        owner: &Ownership,
        fields: &Value,
    ) -> Result<Option<Resolution>, ProfileError> {
        let Some(id) = route_id_of(fields) else {
            return Ok(None);
        };
        self.check_route_link(tool, owner, fields)?;
        let graph = self.graph()?;
        let route = graph
            .routes
            .iter()
            .find(|r| r.id == id)
            .ok_or_else(|| invalid(&format!("fields.{ROUTE_FIELD}"), ROUTE_MISSING))?;
        Ok(Some(self.resolve_route(route, &graph)?))
    }

    /// A stored route's hops with their secrets.
    pub(crate) fn resolve_route(
        &self,
        route: &StoredProfile,
        graph: &Graph,
    ) -> Result<Resolution, ProfileError> {
        let fields = RouteFields::of(route)?;
        if fields.kind == RouteKind::System {
            return Ok(Resolution {
                id: route.id.clone(),
                name: route.name.clone(),
                plan: RoutePlan::System,
            });
        }
        let links: Vec<(String, LinkFields)> = graph.route_links(route)?;
        let plain: Vec<LinkFields> = links.iter().map(|(_, l)| l.clone()).collect();
        check_path(&plain)?;
        let mut hops = Vec::new();
        let mut hosts = Vec::new();
        for (link_id, link) in &links {
            if !link.is_confirmed() {
                return Err(invalid(
                    "links",
                    format!("route {} runs a command nobody confirmed yet", route.name),
                ));
            }
            match (&link.from, link.method) {
                (_, Method::Tcp) => {}
                (_, Method::Command) => {
                    let secrets = self.open(&SecretOwner::link(link_id))?;
                    hops.push(Hop::Command(command_hop(link, &secrets)));
                    hosts.push(None);
                }
                (Node::Proxy { id }, _) => {
                    let row = graph
                        .proxies
                        .get(id)
                        .ok_or_else(|| invalid("links", "a proxy of the route is gone"))?;
                    let secrets = self.open(&SecretOwner::proxy(id))?;
                    hops.push(proxy_hop(&ProxyFields::of(row)?, secrets.get("password")));
                    hosts.push(None);
                }
                (Node::SshHost { id }, method) => {
                    let row = graph
                        .hosts
                        .get(id)
                        .ok_or_else(|| invalid("links", "an SSH host of the route is gone"))?;
                    let ssh = ssh_hop(row, &self.open_host_secrets(id)?);
                    hops.push(if method == Method::SshCommand {
                        Hop::SshCommand(SshCommandHop {
                            ssh,
                            command: link.command.clone().unwrap_or_default(),
                        })
                    } else {
                        Hop::Ssh(ssh)
                    });
                    hosts.push(Some(HopHost {
                        id: id.clone(),
                        name: row.name.clone(),
                    }));
                }
                (Node::Server | Node::Target, _) => {}
            }
        }
        Ok(Resolution {
            id: route.id.clone(),
            name: route.name.clone(),
            plan: RoutePlan::Hops {
                route: net_route::Route::new(route.name.clone(), hops),
                hosts,
            },
        })
    }

    /// A draft of the route editor resolved for `routes.test`: the hops as they would be saved
    /// for a route of the caller (or shared, when every node is shared and the caller manages
    /// shared profiles). A secret variable left empty takes the stored value of a link of the
    /// same owner that does the same thing.
    pub fn resolve_draft(
        &self,
        p: &Principal,
        hops: &[HopInput],
    ) -> Result<Resolution, ProfileError> {
        let may_keep = self
            .authorizer
            .permits(p, crate::authz::catalogue::PROFILES_PERSONAL, None)
            || self.authorizer.permits(p, "profiles.manage", None);
        if !may_keep {
            return Err(ProfileError::Forbidden(
                "testing a route needs profiles.personal or profiles.manage".into(),
            ));
        }
        if hops.iter().any(|h| matches!(h, HopInput::Command { .. })) {
            self.may_reach_host(p)?;
        }
        let graph = self.graph()?;
        let wanted = links_of(hops)?;
        let fields: Vec<LinkFields> = wanted.iter().map(|(f, _)| f.clone()).collect();
        let shared = fields
            .iter()
            .any(|l| matches!(l.to, Node::Proxy { .. } | Node::SshHost { .. }))
            && fields.iter().all(|l| match &l.to {
                Node::Proxy { id } => graph
                    .proxies
                    .get(id)
                    .is_some_and(|r| r.owner == Ownership::Shared),
                Node::SshHost { id } => graph
                    .hosts
                    .get(id)
                    .is_some_and(|r| r.owner == Ownership::Shared),
                _ => true,
            })
            && self.authorizer.permits(p, "profiles.manage", None);
        let owner = if shared {
            Ownership::Shared
        } else {
            Ownership::Personal { user: p.id.clone() }
        };
        self.check_nodes(&owner, &fields, &graph)?;
        let mut hops_out = Vec::new();
        let mut hosts = Vec::new();
        for (link, given) in &wanted {
            let mut secrets: BTreeMap<String, Secret> = given
                .iter()
                .map(|(k, v)| (k.clone(), Secret::new(v.clone().into_bytes())))
                .collect();
            if let Some(row) = graph.links.values().find(|row| {
                row.owner == owner && LinkFields::of(row).is_ok_and(|l| l.same_as(link))
            }) {
                for (k, v) in self.open(&SecretOwner::link(&row.id))? {
                    secrets.entry(k).or_insert(v);
                }
            }
            match (&link.from, link.method) {
                (_, Method::Tcp) => {}
                (_, Method::Command) => {
                    hops_out.push(Hop::Command(command_hop(link, &secrets)));
                    hosts.push(None);
                }
                (Node::Proxy { id }, _) => {
                    let row = &graph.proxies[id];
                    let stored = self.open(&SecretOwner::proxy(id))?;
                    hops_out.push(proxy_hop(&ProxyFields::of(row)?, stored.get("password")));
                    hosts.push(None);
                }
                (Node::SshHost { id }, method) => {
                    let row = &graph.hosts[id];
                    let ssh = ssh_hop(row, &self.open_host_secrets(id)?);
                    hops_out.push(if method == Method::SshCommand {
                        Hop::SshCommand(SshCommandHop {
                            ssh,
                            command: link.command.clone().unwrap_or_default(),
                        })
                    } else {
                        Hop::Ssh(ssh)
                    });
                    hosts.push(Some(HopHost {
                        id: id.clone(),
                        name: row.name.clone(),
                    }));
                }
                (Node::Server | Node::Target, _) => {}
            }
        }
        Ok(Resolution {
            id: String::new(),
            name: "draft".into(),
            plan: RoutePlan::Hops {
                route: net_route::Route::new("draft", hops_out),
                hosts,
            },
        })
    }

    /// A stored route for `routes.test`: one the caller may use, confirmed.
    pub fn resolve_for_test(&self, p: &Principal, id: &str) -> Result<Resolution, ProfileError> {
        let (route, access, graph) = self.get_route(p, id)?;
        if !access.may_use() {
            return Err(ProfileError::Forbidden("you may not use this route".into()));
        }
        if !graph.route_confirmed(&route) {
            return Err(invalid(
                "routeId",
                format!(
                    "route {} runs a command nobody confirmed yet: confirm it first",
                    route.name
                ),
            ));
        }
        self.resolve_route(&route, &graph)
    }
}

/// The message of a profile whose route was deleted (DOC-23 (v)).
pub const ROUTE_MISSING: &str = "Route missing: the route this profile connects through was \
    deleted. Choose a route, or Direct, in the profile; it never connects Direct on its own";

/// Whether a profile of `tool` with `fields` can connect through a route.
pub fn takes_routes(tool: &str, fields: &Value) -> Result<(), ProfileError> {
    let field = format!("fields.{ROUTE_FIELD}");
    match tool {
        "echo" => Err(invalid(
            &field,
            "the echo tool connects to nothing: no route",
        )),
        "nats" => Err(invalid(
            &field,
            "NATS connects through routes with its loopback forwarder (TSK-118), not yet",
        )),
        "docker" if super::docker::transport(fields) == Some("socket") => Err(invalid(
            &field,
            "a local socket is on this server's own machine: it takes no route",
        )),
        _ => Ok(()),
    }
}

fn same_owner(profile: &Ownership, route: &Ownership, field: &str) -> Result<(), ProfileError> {
    match (profile, route) {
        (Ownership::Personal { user: a }, Ownership::Personal { user: b }) if a == b => Ok(()),
        (Ownership::Shared, Ownership::Shared) => Ok(()),
        (Ownership::Personal { .. }, _) => Err(invalid(
            field,
            "a personal profile connects through one of its owner's own routes",
        )),
        (Ownership::Shared, _) => Err(invalid(
            field,
            "a shared profile connects through a shared route",
        )),
    }
}

fn check_source(source_id: &str) -> Result<(), ProfileError> {
    if source_id.is_empty() || source_id.len() > 128 {
        return Err(invalid("sourceId", "1 to 128 characters"));
    }
    Ok(())
}

/// `base`, or `base-2`, `base-3`, … whichever no row of `tool` that `owner` sees has.
fn free_name(rows: &[StoredProfile], owner: &Ownership, tool: &str, base: &str) -> String {
    let base: String = base.chars().take(super::MAX_NAME_CHARS - 4).collect();
    let taken = |name: &str| {
        rows.iter().any(|r| {
            r.tool == tool
                && r.name.to_lowercase() == name.to_lowercase()
                && match (&r.owner, owner) {
                    (Ownership::Personal { user: x }, Ownership::Personal { user: y }) => x == y,
                    _ => true,
                }
        })
    };
    if !taken(&base) {
        return base;
    }
    (2..)
        .map(|n| format!("{base}-{n}"))
        .find(|name| !taken(name))
        .unwrap_or(base)
}

pub(crate) fn in_use_error(name: &str, what: &str, users: &[User]) -> ProfileError {
    let seen: Vec<String> = users
        .iter()
        .filter(|u| u.visible)
        .map(|u| format!("{} ({})", u.name, u.tool))
        .collect();
    let hidden = users.len() - seen.len();
    let mut message = format!("{name} is in use: ");
    if !seen.is_empty() {
        message.push_str(&seen.join(", "));
    }
    if hidden > 0 {
        if !seen.is_empty() {
            message.push_str(" and ");
        }
        message.push_str(&format!("{hidden} you do not see"));
    }
    message.push_str(&format!(". Take the {what} out of them first."));
    ProfileError::Conflict(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proxy(id: &str) -> HopInput {
        HopInput::Proxy {
            proxy_id: id.into(),
        }
    }

    fn ssh(id: &str) -> HopInput {
        HopInput::Ssh {
            ssh_host_id: id.into(),
        }
    }

    fn command(program: &str) -> HopInput {
        HopInput::Command {
            program: program.into(),
            args: vec!["-W".into(), "{host}:{port}".into()],
            env: vec![EnvInput {
                name: "TOKEN".into(),
                secret: true,
                value: Some("s3cret".into()),
            }],
            cwd: None,
        }
    }

    #[test]
    fn hops_become_a_path_of_links_and_back() {
        let hops = vec![
            proxy("P"),
            ssh("A"),
            HopInput::SshCommand {
                ssh_host_id: "B".into(),
                command: "nc {host} {port}".into(),
            },
        ];
        let links = links_of(&hops).unwrap();
        let fields: Vec<LinkFields> = links.iter().map(|(l, _)| l.clone()).collect();
        let shape: Vec<(Node, Node, Method)> = fields
            .iter()
            .map(|l| (l.from.clone(), l.to.clone(), l.method))
            .collect();
        let p = Node::Proxy { id: "P".into() };
        let a = Node::SshHost { id: "A".into() };
        let b = Node::SshHost { id: "B".into() };
        assert_eq!(
            shape,
            vec![
                (Node::Server, p.clone(), Method::Tcp),
                (p, a.clone(), Method::Connect),
                (a, b.clone(), Method::Ssh),
                (b, Node::Target, Method::SshCommand),
            ]
        );
        check_path(&fields).unwrap();
        assert_eq!(hops_of(&fields), hops);
    }

    #[test]
    fn a_command_hop_is_the_first_link_and_keeps_its_secret_out_of_the_record() {
        let links = links_of(&[command("/usr/bin/ssh"), ssh("A")]).unwrap();
        assert_eq!(links.len(), 2);
        let (first, secrets) = &links[0];
        assert_eq!(
            (first.from.clone(), first.method),
            (Node::Server, Method::Command)
        );
        assert_eq!(first.to, Node::SshHost { id: "A".into() });
        assert_eq!(first.env[0].value, None);
        assert_eq!(
            secrets,
            &vec![("env.TOKEN".to_owned(), "s3cret".to_owned())]
        );
        assert!(!serde_json::to_string(first).unwrap().contains("s3cret"));
        assert!(first.needs_confirmation() && !first.is_confirmed());
        // A command alone reaches the target itself.
        let alone = links_of(&[command("cloudflared")]).unwrap();
        assert_eq!(alone.len(), 1);
        assert_eq!(alone[0].0.to, Node::Target);
        check_path(&[alone[0].0.clone()]).unwrap();
    }

    #[test]
    fn bad_paths_are_refused() {
        assert!(links_of(&[]).is_err());
        assert!(links_of(&vec![ssh("A"); 9]).is_err());
        let err = links_of(&[ssh("A"), command("tsh")]).unwrap_err();
        assert!(matches!(err, ProfileError::Invalid { field, .. } if field == "hops.1.kind"));
        assert!(links_of(&[ssh("A"), proxy("P"), ssh("A")]).is_err());
        assert!(
            links_of(&[HopInput::SshCommand {
                ssh_host_id: "A".into(),
                command: "nc {host}\n{port}".into()
            }])
            .is_err()
        );
        assert!(
            links_of(&[HopInput::Command {
                program: "x".into(),
                args: vec![],
                env: vec![EnvInput {
                    name: "1BAD".into(),
                    secret: false,
                    value: None
                }],
                cwd: None
            }])
            .is_err()
        );
        // A path whose methods do not fit their sources.
        let mut broken = links_of(&[ssh("A")]).unwrap();
        broken[1].0.method = Method::Connect;
        let fields: Vec<LinkFields> = broken.into_iter().map(|(l, _)| l).collect();
        assert!(check_path(&fields).is_err());
    }

    #[test]
    fn links_match_on_what_they_do_not_on_the_confirmation() {
        let a = links_of(&[command("tsh")]).unwrap().remove(0).0;
        let mut b = a.clone();
        b.confirmed = Some(LinkConfirmation {
            by: "u".into(),
            at: "t".into(),
        });
        assert!(a.same_as(&b));
        b.args.push("--more".into());
        assert!(!a.same_as(&b));
    }

    #[test]
    fn proxies_are_checked() {
        let base = ProxyFields {
            kind: ProxyKind::HttpConnect,
            host: " proxy.corp ".into(),
            port: 3128,
            tls: false,
            username: Some(" alice ".into()),
            ca_pem: None,
        };
        let ok = base.clone().check().unwrap();
        assert_eq!(
            (ok.host.as_str(), ok.username.as_deref()),
            ("proxy.corp", Some("alice"))
        );
        assert_eq!(ok.url(), "http://proxy.corp:3128");
        assert!(
            ProxyFields {
                host: "u@p".into(),
                ..base.clone()
            }
            .check()
            .is_err()
        );
        assert!(
            ProxyFields {
                username: Some("a:b".into()),
                ..base.clone()
            }
            .check()
            .is_err()
        );
        assert!(
            ProxyFields {
                ca_pem: Some("-----BEGIN CERTIFICATE-----".into()),
                ..base.clone()
            }
            .check()
            .is_err()
        );
        assert!(
            ProxyFields {
                kind: ProxyKind::Socks5,
                tls: true,
                ..base.clone()
            }
            .check()
            .is_err()
        );
        let socks = ProxyFields {
            kind: ProxyKind::Socks5,
            username: None,
            ..base
        }
        .check()
        .unwrap();
        assert_eq!(socks.url(), "socks5://proxy.corp:3128");
        match proxy_hop(&socks, None) {
            Hop::Socks5(h) => assert_eq!(h.auth, Socks5Auth::None),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn some_tools_take_no_route() {
        assert!(takes_routes("temporal", &json!({})).is_ok());
        assert!(takes_routes("docker", &json!({ "transport": "tcp" })).is_ok());
        assert!(takes_routes("docker", &json!({ "transport": "socket" })).is_err());
        assert!(takes_routes("nats", &json!({})).is_err());
    }
}
