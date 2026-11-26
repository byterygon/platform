//! Errors that name the hop.

use std::fmt;

/// Which node of a route an error or a report is about: a hop, or the target (`kind` `"target"`,
/// `index` the number of hops).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopRef {
    /// 0-based position: hops first, then the target.
    pub index: usize,
    /// `httpConnect`, `socks5`, ... or `target`.
    pub kind: &'static str,
    /// `host:port`.
    pub label: String,
}

impl HopRef {
    pub(crate) fn target(index: usize, label: String) -> HopRef {
        HopRef {
            index,
            kind: "target",
            label,
        }
    }

    pub fn is_target(&self) -> bool {
        self.kind == "target"
    }
}

/// What went wrong, in the kinds the UI shows (DOC-23 (q)).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteErrorKind {
    /// The route or the target is not valid; nothing was contacted.
    Invalid,
    /// Unreachable, refused, closed, or a hop that answered something unexpected.
    Connect,
    /// A hop did not answer within its cap or the route's budget.
    Timeout,
    /// A hop rejected the login, or wants one and has none.
    Auth,
    /// A hop refused this connection by its own rules (a proxy's ACL, sshd's forwarding settings).
    Forbidden,
}

impl RouteErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RouteErrorKind::Invalid => "Invalid",
            RouteErrorKind::Connect => "Connect",
            RouteErrorKind::Timeout => "Timeout",
            RouteErrorKind::Auth => "Auth",
            RouteErrorKind::Forbidden => "Forbidden",
        }
    }
}

/// A failed dial. `message` is a sentence for a person and never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteError {
    /// The hop (or the target) that failed; `None` when the route as a whole is wrong.
    pub hop: Option<HopRef>,
    pub kind: RouteErrorKind,
    pub message: String,
}

impl RouteError {
    pub fn new(
        hop: Option<HopRef>,
        kind: RouteErrorKind,
        message: impl Into<String>,
    ) -> RouteError {
        RouteError {
            hop,
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for RouteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.hop {
            Some(hop) if hop.is_target() => write!(f, "target {}: {}", hop.label, self.message),
            Some(hop) => write!(
                f,
                "hop {} ({} {}): {}",
                hop.index + 1,
                hop.kind,
                hop.label,
                self.message
            ),
            None => f.write_str(&self.message),
        }
    }
}

impl std::error::Error for RouteError {}

/// A hop's own failure, before the dialer knows the hop's place in the route.
#[derive(Debug)]
pub(crate) struct HopFailure {
    /// The failure is about the next node (the hop said it could not reach it), not the hop.
    pub next: bool,
    pub kind: RouteErrorKind,
    pub message: String,
}

impl HopFailure {
    pub fn here(kind: RouteErrorKind, message: impl Into<String>) -> HopFailure {
        HopFailure {
            next: false,
            kind,
            message: message.into(),
        }
    }

    pub fn next(kind: RouteErrorKind, message: impl Into<String>) -> HopFailure {
        HopFailure {
            next: true,
            kind,
            message: message.into(),
        }
    }
}
