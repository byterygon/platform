//! Dials `host:port` directly or through a **route**: an ordered list of hops, each of which turns
//! a stream to itself into a stream to the next address (DOC-23 "Connection routes", sections 4
//! and 5). The caller gets a [`BoxStream`] and runs its own protocol over it, TLS included: the
//! only TLS in this crate is to an `https://` proxy.
//!
//! The crate takes **resolved** hops (DOC-23 (ab)): addresses, logins and keys as values. Where
//! they are saved (SSH hosts, proxies, links, the network map) is the caller's business.
//!
//! - **Nothing is contacted that the route does not name.** The machine running the dialer opens
//!   one TCP connection: to the first hop, or to the target when there is no route, through a
//!   [`TcpConnect`] the caller may replace (Mightyconsole checks its outbound policy there).
//!   Everything further is reached through the hop before it, which also resolves the name
//!   (no local DNS for a target behind a hop).
//! - **Errors name the hop** ([`RouteError::hop`]): the hop that refused or did not answer, or the
//!   next hop or the target when a hop says it could not reach it.
//! - **A budget for the whole route** (20 s by default) and a cap per hop; dropping the future of
//!   [`Dialer::dial`] closes every half-opened hop.
//! - **Secrets** ([`Secret`]) never appear in `Debug`, in an error or in a log line.
//!
//! Hop kinds so far: HTTP CONNECT (`http://` and `https://` proxies, Basic auth, a pinned CA),
//! SOCKS5 (no auth or user and password, the target's name resolved by the proxy) and SSH jump
//! hosts (`direct-tcpip`, the host key checked on every hop, sessions shared through a
//! [`SessionPool`]). [`SshSession`] also serves a tool's own SSH connection (Docker's socket).
//! SSH commands (`sshCommand`: a command run on an SSH host as the stream), local commands
//! (`command`: a program on this machine, no shell, a clean environment) and the opt-in System
//! route ([`Dialer::system`]) complete the kinds of DOC-23 section 4.

mod command;
mod connect;
mod dialer;
mod error;
mod http_connect;
mod name;
mod pool;
mod route;
mod socks5;
mod ssh;
mod stream;
mod system;

use tokio::io::{AsyncRead, AsyncWrite};

pub use command::{COMMAND_EARLY_EXIT, CommandHop};
pub use connect::{SystemTcp, TcpConnect, TcpConnectFuture};
pub use dialer::{
    CHANNEL_OPEN_CAP, COMMAND_START_CAP, DEFAULT_BUDGET, Dialer, HopOutcome, HopReport,
    PROXY_HANDSHAKE_CAP, TCP_CONNECT_CAP,
};
pub use error::{
    HopRef, HostKeyFingerprint, HostKeyProblem, HostKeyState, RouteError, RouteErrorKind,
};
pub use name::{expand_placeholders, format_address, is_valid_host};
pub use pool::{POOL_IDLE, SessionPool};
pub use route::{
    BasicAuth, Hop, HttpConnectHop, MAX_HOPS, ProxyScheme, Route, Secret, Socks5Auth, Socks5Hop,
};
pub use ssh::{
    CHANNEL_BACKLOG, HostKeyCheck, HostKeyQuery, OpenError, SSH_LOGIN_CAP, SshAuth, SshCommandHop,
    SshHop, SshSession, TrustedKey, fingerprint,
};
pub use system::EnvLookup;

/// A bidirectional byte stream: TCP, a proxy tunnel, a TLS session to a proxy and so on.
pub trait AsyncReadWrite: AsyncRead + AsyncWrite {}
impl<T: AsyncRead + AsyncWrite + ?Sized> AsyncReadWrite for T {}

/// The stream [`Dialer::dial`] hands back.
pub type BoxStream = Box<dyn AsyncReadWrite + Send + Unpin>;
