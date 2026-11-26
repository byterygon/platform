//! The server's side of `net-route` (DOC-23, TSK-115, TSK-117).
//!
//! - The dialer's one TCP connection goes through the outbound policy ([`OutboundTcp`]); every
//!   address after it (the later hops and the target, which the hop before resolves) is checked
//!   by name against the same policy before anything is dialled (DOC-23 (am),
//!   [`super::outbound::check_remote`]).
//! - [`Via`] is how a tool's connection goes out: Direct, or through a route the profile store
//!   resolved ([`Routed`]: the hops with their secrets, the SSH host of each hop, the shared
//!   session pool).
//! - A [`RouteError`] becomes a [`ToolError`] that names the hop ([`ToolError::hop`]) and, for a
//!   host key, the SSH host Trust saves it into ([`Routed::error`]; [`tool_error`] without a
//!   route).

use std::sync::Arc;
use std::time::Duration;

use net_route::{
    BoxStream, Dialer, HopOutcome, HopRef, RouteError, RouteErrorKind, SessionPool, TcpConnect,
    TcpConnectFuture,
};
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

use super::{ErrorHop, HostKeyDetails, HostKeyFingerprint, HostKeyState, ToolError, ToolErrorKind};

/// Opens net-route's own TCP connection (the first hop, or the target when Direct) through
/// [`super::outbound::connect_tcp`], so the operator's `[outbound]` rules decide it.
pub struct OutboundTcp {
    system: String,
}

impl OutboundTcp {
    pub fn new(system: impl Into<String>) -> Arc<OutboundTcp> {
        Arc::new(OutboundTcp {
            system: system.into(),
        })
    }
}

impl TcpConnect for OutboundTcp {
    fn connect<'a>(&'a self, host: &'a str, port: u16) -> TcpConnectFuture<'a> {
        Box::pin(async move {
            match super::outbound::connect_tcp(&self.system, host, port, None).await {
                Ok(tcp) => Ok(Box::new(tcp) as BoxStream),
                Err(e) => {
                    let kind = match e.kind {
                        ToolErrorKind::Forbidden => RouteErrorKind::Forbidden,
                        ToolErrorKind::Invalid => RouteErrorKind::Invalid,
                        _ => RouteErrorKind::Connect,
                    };
                    Err(RouteError::new(None, kind, e.message))
                }
            }
        })
    }
}

/// A key as the profile stores it, from net-route's.
pub fn fingerprint(key: net_route::HostKeyFingerprint) -> HostKeyFingerprint {
    HostKeyFingerprint {
        algorithm: key.algorithm,
        fingerprint_sha256: key.fingerprint_sha256,
    }
}

/// A key as net-route takes it, from the profile's.
pub fn route_fingerprint(key: HostKeyFingerprint) -> net_route::HostKeyFingerprint {
    net_route::HostKeyFingerprint {
        algorithm: key.algorithm,
        fingerprint_sha256: key.fingerprint_sha256,
    }
}

/// A node of a route as the wire names it.
pub fn error_hop(hop: &HopRef) -> ErrorHop {
    ErrorHop {
        index: u32::try_from(hop.index).unwrap_or(u32::MAX),
        kind: hop.kind.to_owned(),
        label: hop.label.clone(),
    }
}

/// The tool error of a failed dial or SSH login: the same kinds (Timeout is Connect), the
/// field of an invalid login, the host key of a `HostKey` error. Without a route: no hop.
pub fn tool_error(system: &str, e: RouteError) -> ToolError {
    match e.kind {
        RouteErrorKind::HostKey => match e.host_key {
            Some(problem) => {
                let problem = *problem;
                ToolError::host_key(
                    system,
                    e.message,
                    HostKeyDetails {
                        state: match problem.state {
                            net_route::HostKeyState::Unknown => HostKeyState::Unknown,
                            net_route::HostKeyState::Changed => HostKeyState::Changed,
                        },
                        algorithm: problem.presented.algorithm,
                        fingerprint_sha256: problem.presented.fingerprint_sha256,
                        expected: problem.expected.map(fingerprint),
                        hop: None,
                        ssh_host_id: None,
                        ssh_host: None,
                    },
                )
            }
            None => ToolError::new(ToolErrorKind::HostKey, system, e.message),
        },
        RouteErrorKind::Invalid => match e.field {
            Some(field) => ToolError::invalid(system, field, e.message),
            None => ToolError::new(ToolErrorKind::Invalid, system, e.message),
        },
        RouteErrorKind::Auth => ToolError::new(ToolErrorKind::Auth, system, e.message),
        RouteErrorKind::Forbidden => ToolError::new(ToolErrorKind::Forbidden, system, e.message),
        RouteErrorKind::Connect | RouteErrorKind::Timeout => {
            ToolError::new(ToolErrorKind::Connect, system, e.message)
        }
        _ => ToolError::new(ToolErrorKind::Connect, system, e.message),
    }
}

/// A saved SSH host a hop of a route logs into: Trust saves a key there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopHost {
    pub id: String,
    pub name: String,
}

/// What a stored route resolves into for one connection (DOC-23 (ab)): the hops as net-route
/// takes them, with their secrets, or the System route.
#[derive(Debug, Clone)]
pub enum RoutePlan {
    /// The hops, and the SSH host of each `ssh` or `sshCommand` hop by index.
    Hops {
        route: net_route::Route,
        hosts: Vec<Option<HopHost>>,
    },
    /// The proxy variables of the server's environment, read at each dial (DOC-23 4.6).
    System,
}

/// A route the profile store resolved for one connection: its id, its name and its hops with
/// their secrets.
pub struct ResolvedRoute {
    pub id: String,
    pub name: String,
    pub plan: RoutePlan,
}

impl std::fmt::Debug for ResolvedRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedRoute")
            .field("id", &self.id)
            .field("name", &self.name)
            .finish_non_exhaustive()
    }
}

impl ResolvedRoute {
    /// The route ready to dial for `system`, over the shared session `pool`.
    pub fn routed(self, system: &str, pool: SessionPool) -> Result<Routed, ToolError> {
        Routed::new(system, self.id, self.name, self.plan, pool)
    }
}

/// How a tool's connection goes out (DOC-23 §3): Direct, today's behaviour and the default, or
/// through a route. Never Direct for a profile whose route is missing: the store refuses that
/// profile instead.
#[derive(Clone, Default)]
pub enum Via {
    #[default]
    Direct,
    Route(Arc<Routed>),
}

impl std::fmt::Debug for Via {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Via::Direct => f.write_str("Direct"),
            Via::Route(r) => write!(f, "Route({:?})", r.name),
        }
    }
}

impl Via {
    pub fn routed(&self) -> Option<&Routed> {
        match self {
            Via::Direct => None,
            Via::Route(r) => Some(r),
        }
    }

    /// "Direct", or the route's name, for the status bar and messages.
    pub fn describe(&self) -> String {
        match self {
            Via::Direct => "Direct".into(),
            Via::Route(r) => format!("route {}", r.name),
        }
    }
}

/// A route resolved for one tool's connections: a ready dialer (outbound policy, the shared
/// session pool), the SSH host of each hop, and the names to check.
pub struct Routed {
    pub id: String,
    pub name: String,
    system: String,
    dialer: Dialer,
    hosts: Vec<Option<HopHost>>,
}

impl std::fmt::Debug for Routed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Routed")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("dialer", &self.dialer)
            .finish_non_exhaustive()
    }
}

/// One line of `routes.test` (DOC-23 §9, (q)): a hop, or the target last.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RouteTestLine {
    pub hop: ErrorHop,
    pub ok: bool,
    /// From the end of the line before (or the start) to this one.
    pub ms: u32,
    /// An SSH hop that was reached: the (trusted) key it presented.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub host_key: Option<HostKeyFingerprint>,
    /// The saved SSH host of an `ssh` or `sshCommand` hop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ssh_host_id: Option<String>,
    /// For a failure: `Invalid`, `Connect`, `Timeout`, `Auth`, `Forbidden` or `HostKey`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<String>,
    /// For a failure: the error as a connect would report it (host key details included).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ToolError>,
}

fn millis(d: Duration) -> u32 {
    u32::try_from(d.as_millis()).unwrap_or(u32::MAX)
}

impl Routed {
    /// The dialer for `plan`, checked: 1 to 8 hops, each hop's fields, each SSH key decoded.
    pub fn new(
        system: &str,
        id: String,
        name: String,
        plan: RoutePlan,
        pool: SessionPool,
    ) -> Result<Routed, ToolError> {
        let mut routed = Routed {
            id,
            name,
            system: system.to_owned(),
            dialer: Dialer::direct(),
            hosts: Vec::new(),
        };
        let dialer = match plan {
            RoutePlan::System => Dialer::system(),
            RoutePlan::Hops { route, hosts } => {
                routed.hosts = hosts;
                Dialer::through(route)
                    .map_err(|e| routed.error(e))?
                    .with_pool(pool)
            }
        };
        routed.dialer = dialer.with_connector(OutboundTcp::new(system));
        Ok(routed)
    }

    pub fn hop_count(&self) -> usize {
        self.dialer.hop_count()
    }

    /// The hops as `(kind, label)`, for logs (no secret, no argument).
    pub fn hops(&self) -> Vec<(String, String)> {
        self.dialer
            .route()
            .map(|r| {
                r.hops
                    .iter()
                    .map(|h| (h.kind().to_owned(), h.label()))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// The addresses after the first hop and the target, against the outbound policy by name
    /// (DOC-23 (am)). The System route's proxy is its first hop; the target is behind it.
    fn check_names(&self, host: &str) -> Result<(), ToolError> {
        if let Some(route) = self.dialer.route() {
            for (index, hop) in route.hops.iter().enumerate().skip(1) {
                if let Some((name, _)) = hop.address() {
                    super::outbound::check_remote(&self.system, name).map_err(|mut e| {
                        e.hop = Some(error_hop(&hop.at(index)));
                        e
                    })?;
                }
            }
        }
        super::outbound::check_remote(&self.system, host).map_err(|mut e| {
            e.hop = Some(ErrorHop {
                index: u32::try_from(self.hop_count()).unwrap_or(u32::MAX),
                kind: "target".into(),
                label: host.to_owned(),
            });
            e
        })
    }

    /// A stream to `host:port` through the route, within `budget` (the route's 20 s when
    /// `None`). Errors name the hop.
    pub async fn dial(
        &self,
        host: &str,
        port: u16,
        budget: Option<Duration>,
    ) -> Result<BoxStream, ToolError> {
        self.check_names(host).map_err(|e| self.prefixed(e))?;
        let dialer = match budget {
            Some(b) => self.dialer.clone().with_budget(b),
            None => self.dialer.clone(),
        };
        dialer.dial(host, port).await.map_err(|e| self.error(e))
    }

    /// `routes.test`: each hop in order, then the target, up to the first failure.
    pub async fn test(&self, host: &str, port: u16) -> Vec<RouteTestLine> {
        if let Err(e) = self.check_names(host) {
            let hop = e.hop.clone().unwrap_or(ErrorHop {
                index: 0,
                kind: "target".into(),
                label: host.to_owned(),
            });
            return vec![RouteTestLine {
                ssh_host_id: self.host_at(hop.index as usize).map(|h| h.id.clone()),
                hop,
                ok: false,
                ms: 0,
                host_key: None,
                failure: Some("Forbidden".into()),
                error: Some(self.prefixed(e)),
            }];
        }
        self.dialer
            .test(host, port)
            .await
            .into_iter()
            .map(|report| {
                let ssh_host_id = self.host_at(report.hop.index).map(|h| h.id.clone());
                let hop = error_hop(&report.hop);
                match report.outcome {
                    HopOutcome::Ok => RouteTestLine {
                        hop,
                        ok: true,
                        ms: millis(report.elapsed),
                        host_key: report.host_key.map(fingerprint),
                        ssh_host_id,
                        failure: None,
                        error: None,
                    },
                    HopOutcome::Failed(e) => RouteTestLine {
                        hop,
                        ok: false,
                        ms: millis(report.elapsed),
                        host_key: None,
                        ssh_host_id,
                        failure: Some(e.kind.as_str().to_owned()),
                        error: Some(self.error(e)),
                    },
                }
            })
            .collect()
    }

    fn host_at(&self, index: usize) -> Option<&HopHost> {
        self.hosts.get(index).and_then(Option::as_ref)
    }

    /// The tool error of a failed dial: [`tool_error`], plus the hop and, for a host key, the
    /// SSH host Trust saves it into.
    pub fn error(&self, e: RouteError) -> ToolError {
        let hop = e.hop.clone();
        let mut out = tool_error(&self.system, e);
        if let Some(hop) = &hop {
            out.hop = Some(error_hop(hop));
            if let Some(details) = out.host_key.as_mut() {
                details.hop = Some(error_hop(hop));
                if let Some(host) = self.host_at(hop.index) {
                    details.ssh_host_id = Some(host.id.clone());
                    details.ssh_host = Some(host.name.clone());
                }
            }
        }
        out.message = with_hop(hop.as_ref(), &out.message);
        self.prefixed(out)
    }

    /// The message with the route's name in front: "through route prod: …".
    fn prefixed(&self, mut e: ToolError) -> ToolError {
        e.message = format!("through route {}: {}", self.name, e.message);
        e
    }
}

/// "hop 2 (ssh bastion.prod:22): …", or the message as it is when it names no hop.
fn with_hop(hop: Option<&HopRef>, message: &str) -> String {
    match hop {
        Some(hop) if hop.is_target() => format!("target {}: {message}", hop.label),
        Some(hop) => format!(
            "hop {} ({} {}): {message}",
            hop.index + 1,
            hop.kind,
            hop.label
        ),
        None => message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use net_route::{Hop, Socks5Auth, Socks5Hop};

    fn socks(host: &str) -> Hop {
        Hop::Socks5(Socks5Hop {
            host: host.into(),
            port: 1080,
            auth: Socks5Auth::None,
        })
    }

    #[test]
    fn an_invalid_route_is_refused_before_anything_is_dialled() {
        let plan = RoutePlan::Hops {
            route: net_route::Route::new("r", vec![socks("a b")]),
            hosts: vec![None],
        };
        let err =
            Routed::new("echo", "R".into(), "r".into(), plan, SessionPool::new()).unwrap_err();
        assert_eq!(err.kind, ToolErrorKind::Invalid);
        assert_eq!(err.hop.unwrap().index, 0);
        assert!(
            err.message.starts_with("through route r: hop 1 (socks5"),
            "{}",
            err.message
        );
    }

    #[tokio::test]
    async fn a_failed_hop_is_named_with_the_ssh_host_it_belongs_to() {
        // Nothing listens on port 1 of the loopback: the first hop is refused.
        let plan = RoutePlan::Hops {
            route: net_route::Route::new(
                "r",
                vec![Hop::Socks5(Socks5Hop {
                    host: "127.0.0.1".into(),
                    port: 1,
                    auth: Socks5Auth::None,
                })],
            ),
            hosts: vec![Some(HopHost {
                id: "H".into(),
                name: "bastion".into(),
            })],
        };
        let routed =
            Routed::new("echo", "R".into(), "prod".into(), plan, SessionPool::new()).unwrap();
        let lines = routed.test("t.example", 80).await;
        assert_eq!(lines.len(), 1);
        let line = &lines[0];
        assert!(!line.ok);
        assert_eq!(line.hop.index, 0);
        assert_eq!(line.ssh_host_id.as_deref(), Some("H"));
        let error = line.error.as_ref().unwrap();
        assert_eq!(error.kind, ToolErrorKind::Connect);
        assert!(
            error.message.starts_with("through route prod: hop 1"),
            "{}",
            error.message
        );
        let err = routed.dial("t.example", 80, None).await.err().unwrap();
        assert_eq!(err.hop.unwrap().index, 0);
    }
}
