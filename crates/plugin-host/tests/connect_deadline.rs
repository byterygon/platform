//! The broker's overall connect deadline (TSK-20): one `connect_timeout` for every permitted
//! address of an `open`, not one per address.
//!
//! Hanging peers are loopback listeners whose accept queue is full: Linux drops further SYNs, so
//! a connect to them neither succeeds nor fails until the client gives up. Refusing peers are
//! loopback addresses with nothing listening. The tests use several `127.0.0.x` addresses and
//! `/proc`, so they run on Linux only (as CI does). They hold one lock each, so the socket
//! counts in [`no_socket_is_left_behind`] are not disturbed by the other tests of this binary.

#![cfg(target_os = "linux")]

use std::collections::BTreeSet;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use plugin_host::grant::address_policy;
use plugin_host::{
    AuditSink, BrokerConfig, BrokerError, BrokerLimits, BrokerScope, Caller, DriverKind,
    Eligibility, GrantRequest, GrantStore, InstalledPlugin, Manifest, MemoryAuditLog, NativeBroker,
    Resolver, SystemClock, TlsPolicy,
};
use security_types::{
    Authorizer, AuthzRequest, Decision, Digest, Outcome, Principal, PrincipalKind, RoleId,
    SessionId, TenantId,
};
use tokio::net::{TcpListener, TcpSocket, TcpStream};

const MANIFEST: &str = r#"
manifest_version = 1
id = "org.example.dbee.postgres"
version = "0.1.0"
kind = "wasm"
entry = "components/postgres.wasm"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "example"

[[capabilities.network]]
id = "tls-optional"
protocol = "tcp"
tls = "optional"
"#;

const DIGEST: Digest = Digest([0xab; 32]);
const DEADLINE: Duration = Duration::from_millis(600);
/// Scheduling slack on top of the deadline. The old per-address timeout would take
/// `DEADLINE` once per hanging address, far beyond this.
const SLACK: Duration = Duration::from_millis(300);

static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Resolves every name to a fixed list of addresses.
struct Answer(Vec<IpAddr>);

impl Resolver for Answer {
    async fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        Ok(self.0.clone())
    }
}

struct Allow;

impl Authorizer for Allow {
    fn check(&self, _req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(Decision::Allow)
    }
}

fn principal(kind: PrincipalKind, id: &str, role: &str) -> Principal {
    Principal {
        kind,
        id: id.into(),
        tenant: TenantId::new("t1"),
        on_behalf_of: None,
        roles: [RoleId::new(role)].into_iter().collect(),
        session: SessionId::new("s1"),
    }
}

fn v4(last: u8) -> Ipv4Addr {
    Ipv4Addr::new(127, 0, 0, last)
}

/// A broker scope for a plaintext grant to `db.test:port`, which resolves to `addrs`.
async fn scope(addrs: &[Ipv4Addr], port: u16) -> (BrokerScope<Answer>, Arc<MemoryAuditLog>) {
    let audit = Arc::new(MemoryAuditLog::new());
    let grants = Arc::new(GrantStore::new(
        Arc::new(SystemClock),
        audit.clone() as Arc<dyn AuditSink>,
    ));
    let plugin = InstalledPlugin::from_manifest(&Manifest::from_toml(MANIFEST).unwrap(), DIGEST);
    let req = GrantRequest {
        tenant: TenantId::new("t1"),
        owner: "tenant:t1".into(),
        eligible: Eligibility {
            principals: BTreeSet::new(),
            roles: [RoleId::new("analyst")].into_iter().collect(),
        },
        connection_id: "team:srv:pg1".into(),
        target_id: "pg1".into(),
        template_id: "tls-optional".into(),
        host: "db.test".into(),
        port,
        tls: TlsPolicy::Disabled,
        addresses: address_policy(&["127.0.0.0/8"]).unwrap(),
        secret: None,
        allow_cancel_connection: false,
        expires_at_unix_ms: None,
    };
    let admin = principal(PrincipalKind::Human, "human:oidc:admin", "admin");
    grants
        .create(&Allow, &admin, &plugin, req, "c")
        .await
        .unwrap();
    let config = BrokerConfig {
        limits: BrokerLimits {
            connect_timeout: DEADLINE,
            max_transports_per_scope: 1,
            ..BrokerLimits::default()
        },
        ..BrokerConfig::default()
    };
    let answer = Answer(addrs.iter().copied().map(IpAddr::V4).collect());
    let broker = NativeBroker::new(grants, answer, config);
    let scope = broker.scope(Caller {
        plugin_id: "org.example.dbee.postgres".into(),
        plugin_digest: DIGEST,
        driver_kind: DriverKind::Wasm,
        principal: principal(PrincipalKind::Human, "human:oidc:alice", "analyst"),
        correlation_id: "corr-1".into(),
    });
    (scope, audit)
}

/// A listener on `ip:port` that never accepts, with its accept queue filled so that further
/// connection attempts hang.
struct Hanging {
    _listener: TcpListener,
    _queued: Vec<TcpStream>,
}

async fn hanging(ip: Ipv4Addr, port: u16) -> (Hanging, u16) {
    let socket = TcpSocket::new_v4().unwrap();
    socket.bind(SocketAddr::new(ip.into(), port)).unwrap();
    let listener = socket.listen(0).unwrap();
    let addr = listener.local_addr().unwrap();
    let mut queued = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_millis(100), TcpStream::connect(addr)).await {
            Ok(Ok(s)) => queued.push(s),
            Ok(Err(e)) => panic!("filling the accept queue of {addr}: {e}"),
            // The queue is full: this attempt hung, and so will the broker's.
            Err(_) => break,
        }
        assert!(queued.len() < 16, "the accept queue of {addr} never filled");
    }
    (
        Hanging {
            _listener: listener,
            _queued: queued,
        },
        addr.port(),
    )
}

/// Hanging listeners on 127.0.0.2, .3, ... (`n` of them), all on one port. Returns the port.
async fn hanging_peers(n: u8) -> (Vec<Hanging>, u16) {
    let (first, port) = hanging(v4(2), 0).await;
    let mut peers = vec![first];
    for i in 1..n {
        peers.push(hanging(v4(2 + i), port).await.0);
    }
    (peers, port)
}

fn open_fds() -> usize {
    std::fs::read_dir("/proc/self/fd").unwrap().count()
}

/// Sockets of this network namespace still trying to connect (`SYN_SENT`) to `port`.
fn connecting_to(port: u16) -> usize {
    let tcp = std::fs::read_to_string("/proc/net/tcp").unwrap();
    tcp.lines()
        .skip(1)
        .filter(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            let remote_port = cols[2].rsplit(':').next().unwrap();
            u16::from_str_radix(remote_port, 16) == Ok(port) && cols[3] == "02"
        })
        .count()
}

fn last_open_outcome(audit: &MemoryAuditLog) -> Outcome {
    audit
        .records()
        .into_iter()
        .rev()
        .find(|r| r.entry.action.name == "plugin-host.broker.open")
        .unwrap()
        .entry
        .outcome
}

#[tokio::test]
async fn one_deadline_bounds_every_hanging_address() {
    let _serial = SERIAL.lock().await;
    let (_peers, port) = hanging_peers(3).await;
    let (scope, audit) = scope(&[v4(2), v4(3), v4(4)], port).await;

    let started = Instant::now();
    let err = scope.open("pg1", "data").await.unwrap_err();
    let elapsed = started.elapsed();

    assert_eq!(err, BrokerError::Timeout);
    assert!(
        elapsed >= DEADLINE - Duration::from_millis(10),
        "gave up early: {elapsed:?}"
    );
    assert!(
        elapsed < DEADLINE + SLACK,
        "3 hanging addresses took {elapsed:?}; the deadline is {DEADLINE:?} in total"
    );
    assert_eq!(
        last_open_outcome(&audit),
        Outcome::Error {
            code: "Timeout".into()
        }
    );
}

#[tokio::test]
async fn hanging_addresses_do_not_use_up_the_time_of_later_ones() {
    let _serial = SERIAL.lock().await;
    let (_peers, port) = hanging_peers(2).await;
    let good = TcpListener::bind((v4(4), port)).await.unwrap();
    let (scope, _) = scope(&[v4(2), v4(3), v4(4)], port).await;

    let started = Instant::now();
    let t = scope.open("pg1", "data").await.unwrap();
    assert!(started.elapsed() < DEADLINE, "took {:?}", started.elapsed());
    assert_eq!(t.peer_addr(), SocketAddr::new(v4(4).into(), port));
    let (_, from) = good.accept().await.unwrap();
    assert_eq!(from.ip(), IpAddr::V4(v4(1)));
}

#[tokio::test]
async fn refusing_addresses_fail_fast_with_connection_lost() {
    let _serial = SERIAL.lock().await;
    // Nothing listens on these addresses: each attempt is refused at once.
    let port = TcpListener::bind((v4(1), 0))
        .await
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let (scope, _) = scope(&[v4(5), v4(6), v4(7)], port).await;

    let started = Instant::now();
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::ConnectionLost
    );
    assert!(started.elapsed() < DEADLINE, "took {:?}", started.elapsed());
}

#[tokio::test]
async fn hanging_and_refusing_addresses_time_out_within_the_deadline() {
    let _serial = SERIAL.lock().await;
    let (_peers, port) = hanging_peers(2).await;
    // 127.0.0.6 refuses; .2 and .3 hang.
    let (scope, _) = scope(&[v4(2), v4(6), v4(3)], port).await;

    let started = Instant::now();
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::Timeout
    );
    let elapsed = started.elapsed();
    assert!(elapsed < DEADLINE + SLACK, "took {elapsed:?}");
}

#[tokio::test]
async fn no_socket_is_left_behind() {
    let _serial = SERIAL.lock().await;
    let (_peers, port) = hanging_peers(3).await;
    let (scope, _) = scope(&[v4(2), v4(3), v4(4)], port).await;

    let fds = open_fds();
    // The scope has one transport slot: if a failed open kept it, the next would fail with
    // `LimitExceeded` instead of `Timeout`.
    for _ in 0..3 {
        assert_eq!(
            scope.open("pg1", "data").await.unwrap_err(),
            BrokerError::Timeout
        );
        // No half-open connection: no socket of ours is still sending SYNs to the peers, and
        // the process holds no more descriptors than before.
        assert_eq!(connecting_to(port), 0);
        assert_eq!(open_fds(), fds);
    }
}
