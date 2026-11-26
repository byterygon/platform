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
#[non_exhaustive]
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
    /// An SSH hop presented a host key that is not trusted (unknown or changed); nothing was sent
    /// to it. [`RouteError::host_key`] says which key and which SSH host.
    HostKey,
}

impl RouteErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RouteErrorKind::Invalid => "Invalid",
            RouteErrorKind::Connect => "Connect",
            RouteErrorKind::Timeout => "Timeout",
            RouteErrorKind::Auth => "Auth",
            RouteErrorKind::Forbidden => "Forbidden",
            RouteErrorKind::HostKey => "HostKey",
        }
    }
}

/// A failed dial. `message` is a sentence for a person and never holds a secret.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct RouteError {
    /// The hop (or the target) that failed; `None` when the route as a whole is wrong.
    pub hop: Option<HopRef>,
    pub kind: RouteErrorKind,
    pub message: String,
    /// For `Invalid`: the hop's field to fix (`privateKey`, `passphrase`, `auth`, ...).
    pub field: Option<&'static str>,
    /// For `HostKey`: the key presented, the trusted one, and the SSH host it belongs to.
    pub host_key: Option<Box<HostKeyProblem>>,
}

/// Whether the SSH host trusts no key yet or another one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyState {
    Unknown,
    Changed,
}

/// The details of a `HostKey` error, for the trust dialog: Trust saves `presented` into the SSH
/// host named `ssh_host` (DOC-23 4.3, 9).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostKeyProblem {
    pub state: HostKeyState,
    /// The SSH host's name as the caller gave it (`SshHop::name`).
    pub ssh_host: String,
    pub presented: HostKeyFingerprint,
    /// The trusted key, for `Changed`.
    pub expected: Option<HostKeyFingerprint>,
}

/// An SSH host key as OpenSSH prints it.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct HostKeyFingerprint {
    /// `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, ...
    pub algorithm: String,
    /// `SHA256:` and the unpadded base64 digest (`ssh-keygen -lf`).
    pub fingerprint_sha256: String,
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
            field: None,
            host_key: None,
        }
    }

    /// An `Invalid` error about one field of a hop.
    pub fn invalid(
        hop: Option<HopRef>,
        field: &'static str,
        message: impl Into<String>,
    ) -> RouteError {
        RouteError {
            field: Some(field),
            ..RouteError::new(hop, RouteErrorKind::Invalid, message)
        }
    }

    pub fn with_hop(mut self, hop: HopRef) -> RouteError {
        self.hop = Some(hop);
        self
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
    /// A complete error (an SSH login's), used as it is with the hop filled in.
    pub error: Option<Box<RouteError>>,
}

impl HopFailure {
    pub fn here(kind: RouteErrorKind, message: impl Into<String>) -> HopFailure {
        HopFailure {
            next: false,
            kind,
            message: message.into(),
            error: None,
        }
    }

    pub fn next(kind: RouteErrorKind, message: impl Into<String>) -> HopFailure {
        HopFailure {
            next: true,
            kind,
            message: message.into(),
            error: None,
        }
    }
}

impl From<RouteError> for HopFailure {
    fn from(error: RouteError) -> HopFailure {
        HopFailure {
            next: false,
            kind: error.kind,
            message: error.message.clone(),
            error: Some(Box::new(error)),
        }
    }
}
