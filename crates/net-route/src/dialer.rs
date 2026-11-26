//! The dialer: walks the route hop by hop within a budget, names the hop that failed, reuses
//! pooled SSH sessions, and reports each hop for a Test.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use russh::keys::PrivateKey;
use tokio::time::Instant;

use crate::connect::{SystemTcp, TcpConnect};
use crate::error::{HopFailure, HopRef, HostKeyFingerprint, RouteError, RouteErrorKind};
use crate::name::{format_address, is_valid_host};
use crate::pool::SessionPool;
use crate::route::{Hop, Route};
use crate::ssh::{HostKeyCheck, OpenError, SSH_LOGIN_CAP, SshSession, TrustedKey};
use crate::{BoxStream, http_connect, socks5};

/// The connect budget of a whole route when the caller sets none (DOC-23 5, "Timeouts").
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(20);

/// How long the dialer's own TCP connection (to the first hop, or the target) may take.
pub const TCP_CONNECT_CAP: Duration = Duration::from_secs(10);

/// How long a proxy hop may take to let the client in, and again to open the next stream.
pub const PROXY_HANDSHAKE_CAP: Duration = Duration::from_secs(10);

/// How long an SSH hop may take to open a channel to the next address.
pub const CHANNEL_OPEN_CAP: Duration = Duration::from_secs(10);

/// Opens streams to `host:port`, directly or through a route. Cheap to clone.
#[derive(Clone)]
pub struct Dialer {
    route: Option<Arc<Route>>,
    /// The private key of each SSH hop, decoded once when the dialer is made.
    keys: Arc<Vec<Option<Arc<PrivateKey>>>>,
    connector: Arc<dyn TcpConnect>,
    host_keys: Arc<dyn HostKeyCheck>,
    pool: Option<SessionPool>,
    budget: Duration,
}

impl fmt::Debug for Dialer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut d = f.debug_struct("Dialer");
        match &self.route {
            Some(route) => d.field("route", &route.name).field(
                "hops",
                &route
                    .hops
                    .iter()
                    .map(|h| format!("{} {}", h.kind(), h.label()))
                    .collect::<Vec<_>>(),
            ),
            None => d.field("route", &"direct"),
        };
        d.field("budget", &self.budget).finish()
    }
}

/// How one node of a Test went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HopOutcome {
    Ok,
    Failed(RouteError),
}

/// One line of [`Dialer::test`]: a hop, or the target last.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HopReport {
    pub hop: HopRef,
    /// From the end of the line before (or the start) to this one.
    pub elapsed: Duration,
    pub outcome: HopOutcome,
    /// For an SSH hop that was reached: the (trusted) host key it presented.
    pub host_key: Option<HostKeyFingerprint>,
}

/// A hop that let the client in: a stream to talk through, or an SSH session to open channels on.
enum Entered {
    Stream(BoxStream),
    Ssh(Arc<SshSession>),
}

impl Dialer {
    /// No route: a TCP connection to the target.
    pub fn direct() -> Dialer {
        Dialer {
            route: None,
            keys: Arc::default(),
            connector: Arc::new(SystemTcp),
            host_keys: Arc::new(TrustedKey),
            pool: None,
            budget: DEFAULT_BUDGET,
        }
    }

    /// Through `route`, which is checked here: the number of hops, each hop's fields, and each
    /// SSH hop's private key, decoded before anything is contacted.
    pub fn through(route: Route) -> Result<Dialer, RouteError> {
        route.validate()?;
        let keys = route
            .hops
            .iter()
            .enumerate()
            .map(|(index, hop)| match hop {
                Hop::Ssh(ssh) => ssh.decode_key().map_err(|e| e.with_hop(hop.at(index))),
                _ => Ok(None),
            })
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Dialer {
            route: Some(Arc::new(route)),
            keys: Arc::new(keys),
            ..Dialer::direct()
        })
    }

    /// Opens the dialer's own TCP connection with `connector` instead of the system's.
    pub fn with_connector(mut self, connector: Arc<dyn TcpConnect>) -> Dialer {
        self.connector = connector;
        self
    }

    /// Decides the SSH hops' host keys with `check` instead of [`TrustedKey`].
    pub fn with_host_keys(mut self, check: Arc<dyn HostKeyCheck>) -> Dialer {
        self.host_keys = check;
        self
    }

    /// Shares SSH sessions through `pool` (DOC-23 (e)). Without a pool, each stream has its own
    /// sessions, closed with it.
    pub fn with_pool(mut self, pool: SessionPool) -> Dialer {
        self.pool = Some(pool);
        self
    }

    /// The budget for the whole route (the profile's own connect timeout, when it has one).
    pub fn with_budget(mut self, budget: Duration) -> Dialer {
        self.budget = budget;
        self
    }

    pub fn route(&self) -> Option<&Route> {
        self.route.as_deref()
    }

    /// The number of hops (0 for Direct): the index the target gets in errors.
    pub fn hop_count(&self) -> usize {
        self.route.as_ref().map_or(0, |r| r.hops.len())
    }

    /// A stream to `host:port`. Dropping the future closes whatever was half open.
    pub async fn dial(&self, host: &str, port: u16) -> Result<BoxStream, RouteError> {
        self.run(host, port, &mut Trace::default(), true).await
    }

    /// Each hop in order, then the target, up to the first failure (DOC-23 (q)): the time each
    /// took, the host key of each SSH hop, or the error. A Test logs in to every hop itself
    /// (no pooled session) and closes everything again.
    pub async fn test(&self, host: &str, port: u16) -> Vec<HopReport> {
        let mut trace = Trace::default();
        let result = self.run(host, port, &mut trace, false).await;
        match result {
            Ok(stream) => drop(stream),
            Err(error) => {
                let hop = error.hop.clone().unwrap_or_else(|| {
                    HopRef::target(self.hop_count(), format_address(host, port))
                });
                trace.failed(hop, error);
            }
        }
        trace.reports
    }

    async fn run(
        &self,
        host: &str,
        port: u16,
        trace: &mut Trace,
        use_pool: bool,
    ) -> Result<BoxStream, RouteError> {
        let target = HopRef::target(self.hop_count(), format_address(host, port));
        if !is_valid_host(host) {
            return Err(RouteError::new(
                Some(target),
                RouteErrorKind::Invalid,
                format!("{host:?} is not a host name or an address"),
            ));
        }
        if port == 0 {
            return Err(RouteError::new(
                Some(target),
                RouteErrorKind::Invalid,
                "the port is 1 to 65535",
            ));
        }
        let budget_end = Instant::now() + self.budget;
        let Some(route) = &self.route else {
            let stream = self.tcp(host, port, &target, budget_end).await?;
            trace.reached(target, None);
            return Ok(stream);
        };
        let hops = &route.hops;
        let pool = self.pool.as_ref().filter(|_| use_pool);

        // Start at the deepest SSH hop that has a live pooled session, else at the first hop.
        let pooled = pool.and_then(|pool| {
            (0..hops.len())
                .rev()
                .filter(|i| matches!(hops[*i], Hop::Ssh(_)))
                .find_map(|i| pool.get(&hops[..=i]).map(|s| (i, s)))
        });
        let (start, mut carried) = match pooled {
            Some((index, session)) => (index, Some(Entered::Ssh(session))),
            None => {
                let (first_host, first_port) = hops[0].address();
                let tcp = self
                    .tcp(first_host, first_port, &hops[0].at(0), budget_end)
                    .await?;
                (0, Some(Entered::Stream(tcp)))
            }
        };

        let mut stream = None;
        for (index, hop) in hops.iter().enumerate().skip(start) {
            let here = hop.at(index);
            let (next, next_host, next_port) = match hops.get(index + 1) {
                Some(after) => {
                    let (h, p) = after.address();
                    (after.at(index + 1), h, p)
                }
                None => (target.clone(), host, port),
            };
            let entered = match (carried.take(), stream.take()) {
                // A pooled session: already in.
                (Some(Entered::Ssh(session)), _) => Entered::Ssh(session),
                (Some(Entered::Stream(s)), _) | (None, Some(s)) => {
                    let cap = Cap::new(self.enter_cap(hop), budget_end, self.budget);
                    let entered = cap
                        .run(&self.entering(hop), self.enter(s, hop, index, &here))
                        .await
                        .map_err(|f| f.into_error(&here, &next))?;
                    if let (Entered::Ssh(session), Some(pool)) = (&entered, pool) {
                        pool.put(hops[..=index].to_vec(), Arc::clone(session));
                    }
                    let host_key = match &entered {
                        Entered::Ssh(session) => Some(session.host_key().clone()),
                        Entered::Stream(_) => None,
                    };
                    trace.reached(here.clone(), host_key);
                    entered
                }
                (None, None) => unreachable!("every hop gets a stream or a session"),
            };
            let cap = Cap::new(self.open_cap(hop), budget_end, self.budget);
            let opened = cap
                .run(
                    &format!("opening {}", format_address(next_host, next_port)),
                    open(entered, hop, next_host, next_port),
                )
                .await
                .map_err(|f| f.into_error(&here, &next))?;
            stream = Some(opened);
        }
        trace.reached(target, None);
        Ok(stream.expect("a route has at least one hop"))
    }

    fn enter_cap(&self, hop: &Hop) -> Duration {
        match hop {
            Hop::Ssh(_) => SSH_LOGIN_CAP,
            _ => PROXY_HANDSHAKE_CAP,
        }
    }

    fn open_cap(&self, hop: &Hop) -> Duration {
        match hop {
            Hop::Ssh(_) => CHANNEL_OPEN_CAP,
            _ => PROXY_HANDSHAKE_CAP,
        }
    }

    fn entering(&self, hop: &Hop) -> String {
        match hop {
            Hop::Ssh(_) => "logging in over SSH".to_owned(),
            _ => "letting the client in".to_owned(),
        }
    }

    async fn enter(
        &self,
        stream: BoxStream,
        hop: &Hop,
        index: usize,
        here: &HopRef,
    ) -> Result<Entered, HopFailure> {
        match hop {
            Hop::HttpConnect(h) => http_connect::enter(stream, h).await.map(Entered::Stream),
            Hop::Socks5(h) => socks5::enter(stream, h).await.map(Entered::Stream),
            Hop::Ssh(h) => {
                let key = self.keys.get(index).cloned().flatten();
                SshSession::login(stream, h, key, here, Arc::clone(&self.host_keys))
                    .await
                    .map(|s| Entered::Ssh(Arc::new(s)))
                    .map_err(HopFailure::from)
            }
        }
    }

    async fn tcp(
        &self,
        host: &str,
        port: u16,
        at: &HopRef,
        budget_end: Instant,
    ) -> Result<BoxStream, RouteError> {
        let cap = Cap::new(TCP_CONNECT_CAP, budget_end, self.budget);
        let label = format_address(host, port);
        match tokio::time::timeout_at(cap.end, self.connector.connect(host, port)).await {
            Ok(Ok(stream)) => Ok(stream),
            Ok(Err(mut error)) => {
                error.hop.get_or_insert_with(|| at.clone());
                Err(error)
            }
            Err(_) => Err(RouteError::new(
                Some(at.clone()),
                RouteErrorKind::Timeout,
                cap.timed_out(&format!("connecting to {label}")),
            )),
        }
    }
}

async fn open(entered: Entered, hop: &Hop, host: &str, port: u16) -> Result<BoxStream, HopFailure> {
    match (entered, hop) {
        (Entered::Stream(s), Hop::HttpConnect(h)) => http_connect::open(s, h, host, port).await,
        (Entered::Stream(s), Hop::Socks5(_)) => socks5::open(s, host, port).await,
        (Entered::Ssh(session), Hop::Ssh(_)) => {
            let authority = format_address(host, port);
            session
                .open_direct_tcpip(host, port)
                .await
                .map_err(|e| match e {
                    OpenError::Refused {
                        prohibited: true, ..
                    } => HopFailure::here(
                        RouteErrorKind::Forbidden,
                        format!(
                            "{} refused to forward to {authority}: sshd's `AllowTcpForwarding` \
                             (or `PermitOpen`) does not allow it for this user. An SSH command \
                             hop (`nc {{host}} {{port}}`) works where commands are allowed",
                            session.who()
                        ),
                    ),
                    OpenError::Refused { description, .. } => HopFailure::next(
                        RouteErrorKind::Connect,
                        format!(
                            "{} could not reach {authority}: {description}",
                            session.who()
                        ),
                    ),
                    OpenError::Lost(reason) => HopFailure::here(
                        RouteErrorKind::Connect,
                        format!("{}: {reason}", session.who()),
                    ),
                    OpenError::Failed(reason) => HopFailure::here(
                        RouteErrorKind::Connect,
                        format!("opening {authority} on {} failed: {reason}", session.who()),
                    ),
                })
        }
        _ => unreachable!("a hop opens with what it entered"),
    }
}

impl HopFailure {
    fn into_error(self, here: &HopRef, next: &HopRef) -> RouteError {
        if let Some(error) = self.error {
            return *error;
        }
        let hop = if self.next { next } else { here };
        RouteError::new(Some(hop.clone()), self.kind, self.message)
    }
}

/// A hop's cap, cut short by the route's budget.
struct Cap {
    end: Instant,
    cap: Duration,
    budget: Duration,
    by_budget: bool,
}

impl Cap {
    fn new(cap: Duration, budget_end: Instant, budget: Duration) -> Cap {
        let own = Instant::now() + cap;
        Cap {
            end: own.min(budget_end),
            cap,
            budget,
            by_budget: budget_end < own,
        }
    }

    fn timed_out(&self, what: &str) -> String {
        if self.by_budget {
            format!(
                "the route's connect budget of {} ran out while {what}",
                seconds(self.budget)
            )
        } else {
            format!("no answer within {} while {what}", seconds(self.cap))
        }
    }

    async fn run<T, F>(&self, what: &str, step: F) -> Result<T, HopFailure>
    where
        F: Future<Output = Result<T, HopFailure>>,
    {
        match tokio::time::timeout_at(self.end, step).await {
            Ok(result) => result,
            Err(_) => Err(HopFailure::here(
                RouteErrorKind::Timeout,
                self.timed_out(what),
            )),
        }
    }
}

fn seconds(d: Duration) -> String {
    if d.subsec_millis() == 0 {
        format!("{} s", d.as_secs())
    } else {
        format!("{:.1} s", d.as_secs_f64())
    }
}

/// What [`Dialer::test`] collects as the route is walked.
struct Trace {
    start: Instant,
    reports: Vec<HopReport>,
    times: Vec<Instant>,
}

impl Default for Trace {
    fn default() -> Trace {
        Trace {
            start: Instant::now(),
            reports: Vec::new(),
            times: Vec::new(),
        }
    }
}

impl Trace {
    fn last(&self) -> Instant {
        self.times.last().copied().unwrap_or(self.start)
    }

    fn reached(&mut self, hop: HopRef, host_key: Option<HostKeyFingerprint>) {
        let now = Instant::now();
        self.reports.push(HopReport {
            hop,
            elapsed: now - self.last(),
            outcome: HopOutcome::Ok,
            host_key,
        });
        self.times.push(now);
    }

    /// The failure replaces the line of its hop (a proxy reached and then refusing the login)
    /// and anything after it.
    fn failed(&mut self, hop: HopRef, error: RouteError) {
        self.reports.truncate(hop.index);
        self.times.truncate(hop.index);
        let now = Instant::now();
        self.reports.push(HopReport {
            hop,
            elapsed: now - self.last(),
            outcome: HopOutcome::Failed(error),
            host_key: None,
        });
        self.times.push(now);
    }
}
