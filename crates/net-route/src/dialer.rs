//! The dialer: walks the route hop by hop within a budget, names the hop that failed, and reports
//! each hop for a Test.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::time::Instant;

use crate::connect::{SystemTcp, TcpConnect};
use crate::error::{HopFailure, HopRef, RouteError, RouteErrorKind};
use crate::name::{format_address, is_valid_host};
use crate::route::{Hop, Route};
use crate::{BoxStream, http_connect, socks5};

/// The connect budget of a whole route when the caller sets none (DOC-23 5, "Timeouts").
pub const DEFAULT_BUDGET: Duration = Duration::from_secs(20);

/// How long the dialer's own TCP connection (to the first hop, or the target) may take.
pub const TCP_CONNECT_CAP: Duration = Duration::from_secs(10);

/// How long a proxy hop may take to let the client in and open the stream to the next address.
pub const PROXY_HANDSHAKE_CAP: Duration = Duration::from_secs(10);

/// Opens streams to `host:port`, directly or through a route. Cheap to clone.
#[derive(Clone)]
pub struct Dialer {
    route: Option<Arc<Route>>,
    connector: Arc<dyn TcpConnect>,
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
}

impl Dialer {
    /// No route: a TCP connection to the target.
    pub fn direct() -> Dialer {
        Dialer {
            route: None,
            connector: Arc::new(SystemTcp),
            budget: DEFAULT_BUDGET,
        }
    }

    /// Through `route`, which is checked here (number of hops, each hop's fields).
    pub fn through(route: Route) -> Result<Dialer, RouteError> {
        route.validate()?;
        Ok(Dialer {
            route: Some(Arc::new(route)),
            ..Dialer::direct()
        })
    }

    /// Opens the dialer's own TCP connection with `connector` instead of the system's.
    pub fn with_connector(mut self, connector: Arc<dyn TcpConnect>) -> Dialer {
        self.connector = connector;
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

    /// A stream to `host:port`. Dropping the future closes whatever was half open.
    pub async fn dial(&self, host: &str, port: u16) -> Result<BoxStream, RouteError> {
        self.run(host, port, &mut Trace::default()).await
    }

    /// Each hop in order, then the target, up to the first failure (DOC-23 (q)): the time each
    /// took, or the error. The stream, when the target was reached, is closed again.
    pub async fn test(&self, host: &str, port: u16) -> Vec<HopReport> {
        let mut trace = Trace::default();
        let result = self.run(host, port, &mut trace).await;
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

    fn hop_count(&self) -> usize {
        self.route.as_ref().map_or(0, |r| r.hops.len())
    }

    async fn run(&self, host: &str, port: u16, trace: &mut Trace) -> Result<BoxStream, RouteError> {
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
            trace.reached(target);
            return Ok(stream);
        };
        let hops = &route.hops;
        let (first_host, first_port) = hops[0].address();
        let mut stream = self
            .tcp(first_host, first_port, &hops[0].at(0), budget_end)
            .await?;
        for (index, hop) in hops.iter().enumerate() {
            let here = hop.at(index);
            let (next, next_host, next_port) = match hops.get(index + 1) {
                Some(after) => {
                    let (h, p) = after.address();
                    (after.at(index + 1), h, p)
                }
                None => (target.clone(), host, port),
            };
            let cap = Cap::new(PROXY_HANDSHAKE_CAP, budget_end, self.budget);
            let entered = cap
                .run("letting the client in", enter(stream, hop))
                .await
                .map_err(|f| f.into_error(&here, &next))?;
            trace.reached(here.clone());
            stream = cap
                .run(
                    &format!("opening {}", format_address(next_host, next_port)),
                    open(entered, hop, next_host, next_port),
                )
                .await
                .map_err(|f| f.into_error(&here, &next))?;
        }
        trace.reached(target);
        Ok(stream)
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

async fn enter(stream: BoxStream, hop: &Hop) -> Result<BoxStream, HopFailure> {
    match hop {
        Hop::HttpConnect(h) => http_connect::enter(stream, h).await,
        Hop::Socks5(h) => socks5::enter(stream, h).await,
    }
}

async fn open(
    stream: BoxStream,
    hop: &Hop,
    host: &str,
    port: u16,
) -> Result<BoxStream, HopFailure> {
    match hop {
        Hop::HttpConnect(h) => http_connect::open(stream, h, host, port).await,
        Hop::Socks5(_) => socks5::open(stream, host, port).await,
    }
}

impl HopFailure {
    fn into_error(self, here: &HopRef, next: &HopRef) -> RouteError {
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

    async fn run<F>(&self, what: &str, step: F) -> Result<BoxStream, HopFailure>
    where
        F: Future<Output = Result<BoxStream, HopFailure>>,
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

    fn reached(&mut self, hop: HopRef) {
        let now = Instant::now();
        self.reports.push(HopReport {
            hop,
            elapsed: now - self.last(),
            outcome: HopOutcome::Ok,
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
        });
        self.times.push(now);
    }
}
