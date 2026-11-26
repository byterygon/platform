//! The server's side of `net-route` (DOC-23, TSK-115): the dialer's one TCP connection goes
//! through the outbound policy ([`OutboundTcp`]), and a [`RouteError`] becomes a [`ToolError`]
//! ([`tool_error`]). TSK-117 adds the route itself, `ToolError.hop` and the policy's check of the
//! names behind a route (DOC-23 (am)).

use std::sync::Arc;

use net_route::{BoxStream, RouteError, RouteErrorKind, TcpConnect, TcpConnectFuture};

use super::{HostKeyDetails, HostKeyFingerprint, HostKeyState, ToolError, ToolErrorKind};

/// Opens net-route's own TCP connection (the first hop, or the target when Direct) through
/// [`super::outbound::connect_tcp`], so the operator's `[outbound]` rules decide it.
pub struct OutboundTcp {
    system: &'static str,
}

impl OutboundTcp {
    pub fn new(system: &'static str) -> Arc<OutboundTcp> {
        Arc::new(OutboundTcp { system })
    }
}

impl TcpConnect for OutboundTcp {
    fn connect<'a>(&'a self, host: &'a str, port: u16) -> TcpConnectFuture<'a> {
        Box::pin(async move {
            match super::outbound::connect_tcp(self.system, host, port, None).await {
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

/// The tool error of a failed dial or SSH login: the same kinds (Timeout is Connect), the
/// field of an invalid login, the host key of a `HostKey` error.
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
