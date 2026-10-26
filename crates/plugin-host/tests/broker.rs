//! End-to-end tests of the native connection broker against real sockets and real TLS
//! (Plugin Host spec §3 and §8 acceptance tests).

use std::collections::{BTreeSet, VecDeque};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use plugin_host::grant::address_policy;
use plugin_host::{
    AddressPolicy, AuditSink, BrokerConfig, BrokerError, BrokerLimits, BrokerScope, Caller, Clock,
    DriverKind, Eligibility, GrantError, GrantRequest, GrantStore, InstalledPlugin, Manifest,
    MemoryAuditLog, NativeBroker, Resolver, SecretBinding, TlsMode, TlsPolicy, Transport,
    TrustRoots,
};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use rustls::RootCertStore;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use security_types::{
    Action, ApprovalSpec, AuditChain, AuditDecision, Authorizer, AuthzRequest, Decision, Digest,
    Outcome, Principal, PrincipalKind, Reason, Risk, RoleId, SessionId, TenantId,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::TlsAcceptor;

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
id = "db-transport"
protocol = "tcp"
default_port = 5432
tls = "required"
allow_in_protocol_tls_upgrade = true
allow_cancel_connection = true

[[capabilities.network]]
id = "direct-only"
protocol = "tcp"
tls = "required"

[[capabilities.secrets]]
id = "db-credentials"
purpose = "database-auth"
scope = "connection"
needs_credential = true
"#;

const PLUGIN_DIGEST: Digest = Digest([0xab; 32]);
const SECRET_REF: &str = "secret-ref-7f3a-do-not-log";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

struct Pki {
    ca: CertificateDer<'static>,
    issuer: Issuer<'static, KeyPair>,
}

impl Pki {
    fn new(name: &str) -> Self {
        let key = KeyPair::generate().unwrap();
        let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        params.distinguished_name.push(DnType::CommonName, name);
        let ca = params.self_signed(&key).unwrap().der().clone();
        Self {
            ca,
            issuer: Issuer::new(params, key),
        }
    }

    fn server_config(&self, name: &str) -> Arc<rustls::ServerConfig> {
        let key = KeyPair::generate().unwrap();
        let cert = CertificateParams::new(vec![name.to_owned()])
            .unwrap()
            .signed_by(&key, &self.issuer)
            .unwrap();
        let config = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )
        .unwrap();
        Arc::new(config)
    }
}

#[derive(Clone, Copy)]
enum ServerMode {
    /// TLS immediately, then echo.
    DirectTls,
    /// PostgreSQL style: read the 8-byte SSLRequest, answer `S`, then TLS, then echo.
    UpgradeTls,
    /// Plaintext echo.
    Plain,
}

/// A loopback server. Every accepted connection is reported on `accepted`.
struct Server {
    addr: SocketAddr,
    accepted: tokio::sync::mpsc::UnboundedReceiver<SocketAddr>,
}

async fn server(ip: &str, port: u16, mode: ServerMode, tls: Arc<rustls::ServerConfig>) -> Server {
    let listener = TcpListener::bind((ip.parse::<IpAddr>().unwrap(), port))
        .await
        .unwrap();
    let addr = listener.local_addr().unwrap();
    let (tx, accepted) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((mut tcp, peer)) = listener.accept().await else {
                return;
            };
            let _ = tx.send(peer);
            let acceptor = TlsAcceptor::from(tls.clone());
            tokio::spawn(async move {
                match mode {
                    ServerMode::Plain => echo(tcp).await,
                    ServerMode::DirectTls => {
                        if let Ok(s) = acceptor.accept(tcp).await {
                            echo(s).await;
                        }
                    }
                    ServerMode::UpgradeTls => {
                        let mut req = [0u8; 8];
                        if tcp.read_exact(&mut req).await.is_err() {
                            return;
                        }
                        if tcp.write_all(b"S").await.is_err() {
                            return;
                        }
                        if let Ok(s) = acceptor.accept(tcp).await {
                            echo(s).await;
                        }
                    }
                }
            });
        }
    });
    Server { addr, accepted }
}

async fn echo<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin>(mut s: S) {
    let mut buf = [0u8; 4096];
    loop {
        match s.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                if s.write_all(&buf[..n]).await.is_err() {
                    return;
                }
            }
        }
    }
}

#[derive(Default)]
struct ManualClock(AtomicU64);

impl ManualClock {
    fn at(ms: u64) -> Arc<Self> {
        Arc::new(Self(AtomicU64::new(ms)))
    }

    fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_unix_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

/// Returns queued answers in order, then repeats the last one.
struct FakeResolver(Mutex<VecDeque<Vec<IpAddr>>>);

impl FakeResolver {
    fn new(answers: &[&[&str]]) -> Self {
        Self(Mutex::new(
            answers
                .iter()
                .map(|a| a.iter().map(|s| s.parse().unwrap()).collect())
                .collect(),
        ))
    }
}

impl Resolver for FakeResolver {
    async fn resolve(&self, _host: &str, _port: u16) -> io::Result<Vec<IpAddr>> {
        let mut q = self.0.lock().unwrap();
        let answer = if q.len() > 1 {
            q.pop_front()
        } else {
            q.front().cloned()
        };
        answer.ok_or_else(|| io::ErrorKind::NotFound.into())
    }
}

struct Fixed(Decision);

impl Authorizer for Fixed {
    fn check(&self, _req: &AuthzRequest<'_>) -> impl Future<Output = Decision> + Send {
        std::future::ready(self.0.clone())
    }
}

fn allow() -> Fixed {
    Fixed(Decision::Allow)
}

fn principal(kind: PrincipalKind, id: &str, tenant: &str, roles: &[&str]) -> Principal {
    Principal {
        kind,
        id: id.into(),
        tenant: TenantId::new(tenant),
        on_behalf_of: None,
        roles: roles.iter().map(|r| RoleId::new(*r)).collect(),
        session: SessionId::new("s1"),
    }
}

fn admin() -> Principal {
    principal(PrincipalKind::Human, "human:oidc:admin", "t1", &["admin"])
}

fn alice() -> Principal {
    principal(PrincipalKind::Human, "human:oidc:alice", "t1", &["analyst"])
}

fn agent_for(human: Principal, roles: &[&str]) -> Principal {
    let mut agent = principal(PrincipalKind::Agent, "agent:token:a", "t1", roles);
    agent.on_behalf_of = Some(Box::new(human));
    agent
}

fn plugin() -> InstalledPlugin {
    InstalledPlugin::from_manifest(&Manifest::from_toml(MANIFEST).unwrap(), PLUGIN_DIGEST)
}

fn caller(principal: Principal) -> Caller {
    Caller {
        plugin_id: "org.example.dbee.postgres".into(),
        plugin_digest: PLUGIN_DIGEST,
        driver_kind: DriverKind::Wasm,
        principal,
        correlation_id: "corr-1".into(),
    }
}

fn request(port: u16, mode: TlsMode, ca: &CertificateDer<'_>) -> GrantRequest {
    GrantRequest {
        tenant: TenantId::new("t1"),
        owner: "tenant:t1".into(),
        eligible: Eligibility {
            principals: BTreeSet::new(),
            roles: [RoleId::new("analyst"), RoleId::new("agent-read")]
                .into_iter()
                .collect(),
        },
        connection_id: "team:srv:pg1".into(),
        target_id: "pg1".into(),
        template_id: "db-transport".into(),
        host: "db.test".into(),
        port,
        tls: TlsPolicy {
            mode,
            server_name: "db.test".into(),
            roots: TrustRoots::Pinned(vec![ca.to_vec()]),
        },
        addresses: address_policy(&["127.0.0.1/32"]).unwrap(),
        secret: Some(SecretBinding {
            template_id: "db-credentials".into(),
            secret_ref: SECRET_REF.into(),
        }),
        allow_cancel_connection: true,
        expires_at_unix_ms: None,
    }
}

struct Env<R: Resolver> {
    clock: Arc<ManualClock>,
    audit: Arc<MemoryAuditLog>,
    grants: Arc<GrantStore>,
    broker: Arc<NativeBroker<R>>,
}

fn env_with<R: Resolver>(resolver: R, config: BrokerConfig) -> Env<R> {
    let clock = ManualClock::at(1_000_000);
    let audit = Arc::new(MemoryAuditLog::new());
    let grants = Arc::new(GrantStore::new(
        clock.clone(),
        audit.clone() as Arc<dyn AuditSink>,
    ));
    let broker = NativeBroker::new(grants.clone(), resolver, config);
    Env {
        clock,
        audit,
        grants,
        broker,
    }
}

fn env() -> Env<FakeResolver> {
    env_with(
        FakeResolver::new(&[&["127.0.0.1"]]),
        BrokerConfig::default(),
    )
}

impl<R: Resolver> Env<R> {
    async fn grant(&self, req: GrantRequest) -> plugin_host::GrantId {
        self.grants
            .create(&allow(), &admin(), &plugin(), req, "corr-grant")
            .await
            .unwrap()
            .id
            .clone()
    }

    fn scope(&self, principal: Principal) -> BrokerScope<R> {
        self.broker.scope(caller(principal))
    }

    /// Audit records of broker calls (not grant changes).
    fn broker_audit(&self) -> Vec<security_types::AuditRecord> {
        self.audit
            .records()
            .into_iter()
            .filter(|r| r.entry.action.name.starts_with("plugin-host.broker."))
            .collect()
    }
}

async fn round_trip<R: Resolver>(scope: &BrokerScope<R>, t: &mut Transport, msg: &[u8]) {
    assert_eq!(scope.send(t, msg).await.unwrap(), msg.len());
    let mut got = Vec::new();
    while got.len() < msg.len() {
        let chunk = scope.recv(t, 1024).await.unwrap();
        assert!(!chunk.is_empty(), "peer closed early");
        got.extend(chunk);
    }
    assert_eq!(got, msg);
}

/// PostgreSQL SSLRequest: length 8, code 80877103.
const SSL_REQUEST: [u8; 8] = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];

async fn negotiate_upgrade<R: Resolver>(scope: &BrokerScope<R>, t: &mut Transport) {
    scope.send(t, &SSL_REQUEST).await.unwrap();
    assert_eq!(scope.recv(t, 1).await.unwrap(), b"S");
}

// ---------------------------------------------------------------------------------------------
// Grants and templates
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn manifest_template_alone_cannot_connect() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    let scope = env.scope(alice());
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );

    // The same target opens once a grant binds it.
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    scope.open("pg1", "data").await.unwrap();

    let audit = env.broker_audit();
    assert_eq!(audit.len(), 2, "every open is audited");
    assert!(matches!(
        &audit[0].entry.decision,
        AuditDecision::Deny { reason: Reason::Policy { message } } if message.contains("no active grant")
    ));
    assert_eq!(audit[1].entry.decision, AuditDecision::Allow);
    assert_eq!(audit[1].entry.outcome, Outcome::Success);
}

#[tokio::test]
async fn grant_creation_is_checked_against_the_template() {
    let pki = Pki::new("CA");
    let env = env();
    let create = |req: GrantRequest| {
        let grants = env.grants.clone();
        async move {
            grants
                .create(&allow(), &admin(), &plugin(), req, "c")
                .await
                .map(|_| ())
        }
    };
    let base = || request(5432, TlsMode::InProtocolUpgrade, &pki.ca);

    let mut r = base();
    r.template_id = "direct-only".into();
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid(
            "template does not allow in-protocol TLS upgrade"
        ))
    );

    let mut r = base();
    r.template_id = "direct-only".into();
    r.tls.mode = TlsMode::Direct;
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid(
            "template does not allow a cancel connection"
        ))
    );

    let mut r = base();
    r.template_id = "no-such-template".into();
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid("unknown network template"))
    );

    let mut r = base();
    r.host = "*.db.test".into();
    assert_eq!(create(r).await, Err(GrantError::Invalid("host")));

    let mut r = base();
    r.host = "10.0.0.5".into();
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid(
            "host address is outside the address policy"
        ))
    );

    let mut r = base();
    r.addresses = AddressPolicy::new([]);
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid("address policy is empty"))
    );

    let mut r = base();
    r.eligible = Eligibility::default();
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid("no eligible principals"))
    );

    let mut r = base();
    r.tls.roots = TrustRoots::Pinned(vec![b"not a certificate".to_vec()]);
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid("pinned trust roots"))
    );

    let mut r = base();
    r.secret.as_mut().unwrap().template_id = "other".into();
    assert_eq!(create(r).await, Err(GrantError::Invalid("secret binding")));

    let mut r = base();
    r.expires_at_unix_ms = Some(env.clock.now_unix_ms());
    assert_eq!(
        create(r).await,
        Err(GrantError::Invalid("expiry is in the past"))
    );

    assert_eq!(create(base()).await, Ok(()));
    // One active grant per target: changing host/port means revoke and approve a new grant.
    let mut r = base();
    r.port = 6543;
    assert_eq!(create(r).await, Err(GrantError::TargetInUse));
}

#[tokio::test]
async fn only_a_direct_human_approver_can_change_grants() {
    let pki = Pki::new("CA");
    let env = env();
    let req = request(5432, TlsMode::Direct, &pki.ca);
    let try_create = |authz: Fixed, approver: Principal| {
        let grants = env.grants.clone();
        let req = req.clone();
        async move {
            grants
                .create(&authz, &approver, &plugin(), req, "c")
                .await
                .map(|_| ())
        }
    };
    let denied = |r: Result<(), GrantError>| matches!(r, Err(GrantError::Denied(_)));

    assert!(denied(
        try_create(allow(), agent_for(admin(), &["admin"])).await
    ));
    assert!(denied(
        try_create(
            allow(),
            principal(PrincipalKind::Human, "human:oidc:bob", "t2", &["admin"])
        )
        .await
    ));
    assert!(denied(
        try_create(
            Fixed(Decision::Deny {
                reason: Reason::MissingPermission {
                    perm: "admin.grants.create".into()
                }
            }),
            admin()
        )
        .await
    ));
    let approval = ApprovalSpec {
        action: Action::new("x", "y"),
        target: None,
        risk: Risk::Write,
        input_digest: Digest::ZERO,
        expires_at_unix_ms: u64::MAX,
    };
    assert!(denied(
        try_create(Fixed(Decision::NeedsApproval { approval }), admin()).await
    ));

    // Every attempt is audited, denied ones included.
    let records = env.audit.records();
    assert_eq!(records.len(), 4);
    assert!(
        records
            .iter()
            .all(|r| matches!(r.entry.decision, AuditDecision::Deny { .. }))
    );
}

// ---------------------------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn direct_tls_verifies_and_round_trips() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let scope = env.scope(alice());
    let mut t = scope.open("pg1", "data").await.unwrap();
    assert!(t.is_tls());
    assert_eq!(t.peer_addr(), srv.addr);
    round_trip(&scope, &mut t, b"hello over tls").await;
    // Direct mode never allows a second upgrade.
    assert_eq!(
        scope.start_tls(&mut t, "db.test").await,
        Err(BrokerError::PermissionDenied)
    );
}

#[tokio::test]
async fn untrusted_ca_is_rejected() {
    let pki = Pki::new("CA");
    let other = Pki::new("Other CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &other.ca))
        .await;
    assert_eq!(
        env.scope(alice()).open("pg1", "data").await.unwrap_err(),
        BrokerError::TlsFailed
    );
    let audit = env.broker_audit();
    assert_eq!(
        audit[0].entry.outcome,
        Outcome::Error {
            code: "TlsFailed".into()
        }
    );
}

#[tokio::test]
async fn certificate_for_another_name_is_rejected() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("evil.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    assert_eq!(
        env.scope(alice()).open("pg1", "data").await.unwrap_err(),
        BrokerError::TlsFailed
    );
}

#[tokio::test]
async fn deployment_roots_are_explicit() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let mut req = request(srv.addr.port(), TlsMode::Direct, &pki.ca);
    req.tls.roots = TrustRoots::Deployment;

    // No roots configured: nothing verifies.
    let env_empty = env();
    env_empty.grant(req.clone()).await;
    assert_eq!(
        env_empty
            .scope(alice())
            .open("pg1", "data")
            .await
            .unwrap_err(),
        BrokerError::TlsFailed
    );

    let mut roots = RootCertStore::empty();
    roots.add(pki.ca.clone()).unwrap();
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.1"]]),
        BrokerConfig {
            deployment_roots: Arc::new(roots),
            ..BrokerConfig::default()
        },
    );
    env.grant(req).await;
    env.scope(alice()).open("pg1", "data").await.unwrap();
}

#[tokio::test]
async fn in_protocol_start_tls_upgrades_the_same_handle() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::UpgradeTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(
        srv.addr.port(),
        TlsMode::InProtocolUpgrade,
        &pki.ca,
    ))
    .await;
    let scope = env.scope(alice());
    let mut t = scope.open("pg1", "data").await.unwrap();
    assert!(!t.is_tls());
    negotiate_upgrade(&scope, &mut t).await;

    // The name must be the one the grant bound; no handshake is attempted otherwise.
    assert_eq!(
        scope.start_tls(&mut t, "other.test").await,
        Err(BrokerError::PermissionDenied)
    );
    scope.start_tls(&mut t, "db.test").await.unwrap();
    assert!(t.is_tls());
    round_trip(&scope, &mut t, &[7u8; 2000]).await; // beyond the plaintext budget: encrypted
    assert_eq!(
        scope.start_tls(&mut t, "db.test").await,
        Err(BrokerError::PermissionDenied),
        "already TLS"
    );

    let actions: Vec<_> = env
        .broker_audit()
        .iter()
        .map(|r| (r.entry.action.name.clone(), r.entry.decision.clone()))
        .collect();
    assert_eq!(actions.len(), 4);
    assert!(matches!(actions[1].1, AuditDecision::Deny { .. }));
    assert_eq!(actions[2].1, AuditDecision::Allow);
}

#[tokio::test]
async fn start_tls_with_a_bad_certificate_closes_the_transport() {
    let pki = Pki::new("CA");
    let other = Pki::new("Other CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::UpgradeTls,
        other.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(
        srv.addr.port(),
        TlsMode::InProtocolUpgrade,
        &pki.ca,
    ))
    .await;
    let scope = env.scope(alice());
    let mut t = scope.open("pg1", "data").await.unwrap();
    negotiate_upgrade(&scope, &mut t).await;
    assert_eq!(
        scope.start_tls(&mut t, "db.test").await,
        Err(BrokerError::TlsFailed)
    );
    // No plaintext fallback.
    assert!(scope.send(&mut t, b"select 1").await.is_err());
}

#[tokio::test]
async fn plaintext_before_start_tls_is_bounded() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::Plain,
        pki.server_config("db.test"),
    )
    .await;
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.1"]]),
        BrokerConfig {
            limits: BrokerLimits {
                pre_tls_plaintext_bytes: 16,
                ..BrokerLimits::default()
            },
            ..BrokerConfig::default()
        },
    );
    env.grant(request(
        srv.addr.port(),
        TlsMode::InProtocolUpgrade,
        &pki.ca,
    ))
    .await;
    let scope = env.scope(alice());
    let mut t = scope.open("pg1", "data").await.unwrap();
    round_trip(&scope, &mut t, b"12345678").await; // 16 bytes counted
    assert_eq!(scope.send(&mut t, b"x").await, Err(BrokerError::TlsFailed));
    assert_eq!(
        scope.recv(&mut t, 10).await,
        Err(BrokerError::ConnectionLost)
    );
}

// ---------------------------------------------------------------------------------------------
// Addresses and DNS rebinding
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn dns_rebinding_is_denied_at_connect_time() {
    let pki = Pki::new("CA");
    let tls = pki.server_config("db.test");
    let good = server("127.0.0.1", 0, ServerMode::DirectTls, tls.clone()).await;
    // A second service on another loopback address, same port: the rebinding target.
    let mut evil = server("127.0.0.2", good.addr.port(), ServerMode::DirectTls, tls).await;

    // First lookup returns the approved address, later lookups the attacker's.
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.1"], &["127.0.0.2"]]),
        BrokerConfig::default(),
    );
    env.grant(request(good.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let scope = env.scope(alice());
    scope.open("pg1", "data").await.unwrap();
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        evil.accepted.try_recv().is_err(),
        "connected to a rebound address"
    );

    let audit = env.broker_audit();
    assert!(matches!(
        &audit[1].entry.decision,
        AuditDecision::Deny { reason: Reason::Policy { message } } if message.contains("address")
    ));
}

#[tokio::test]
async fn only_permitted_addresses_of_an_answer_are_used() {
    let pki = Pki::new("CA");
    let tls = pki.server_config("db.test");
    let good = server("127.0.0.1", 0, ServerMode::DirectTls, tls.clone()).await;
    let mut evil = server("127.0.0.2", good.addr.port(), ServerMode::DirectTls, tls).await;
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.2", "::ffff:127.0.0.2", "127.0.0.1"]]),
        BrokerConfig::default(),
    );
    env.grant(request(good.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let t = env.scope(alice()).open("pg1", "data").await.unwrap();
    assert_eq!(t.peer_addr(), good.addr);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(evil.accepted.try_recv().is_err());
}

#[tokio::test]
async fn ip_literal_targets_connect_without_dns() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    // A resolver that would rebind if it were asked.
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.2"]]),
        BrokerConfig::default(),
    );
    let mut req = request(srv.addr.port(), TlsMode::Direct, &pki.ca);
    req.host = "127.0.0.1".into();
    env.grant(req).await;
    let t = env.scope(alice()).open("pg1", "data").await.unwrap();
    assert_eq!(t.peer_addr(), srv.addr);
}

// ---------------------------------------------------------------------------------------------
// Cancel connection
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn cancel_connection_needs_the_same_grant_to_allow_it() {
    let pki = Pki::new("CA");
    let mut srv = server(
        "127.0.0.1",
        0,
        ServerMode::UpgradeTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    let mut req = request(srv.addr.port(), TlsMode::InProtocolUpgrade, &pki.ca);
    req.allow_cancel_connection = false;
    let id = env.grant(req.clone()).await;
    let scope = env.scope(alice());
    let _data = scope.open("pg1", "data").await.unwrap();
    assert_eq!(
        scope.open("pg1", "cancel").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
    assert_eq!(
        scope.open("pg1", "anything").await.unwrap_err(),
        BrokerError::Unsupported("purpose")
    );

    env.grants
        .revoke(&allow(), &admin(), &id, "c")
        .await
        .unwrap();
    req.allow_cancel_connection = true;
    env.grant(req).await;
    let data = scope.open("pg1", "data").await.unwrap();
    let mut cancel = scope.open("pg1", "cancel").await.unwrap();
    assert_eq!(cancel.peer_addr(), data.peer_addr(), "same endpoint");
    // Same TLS policy: the cancel connection is upgraded and verified like the data one.
    negotiate_upgrade(&scope, &mut cancel).await;
    scope.start_tls(&mut cancel, "db.test").await.unwrap();

    let opens: Vec<_> = env
        .broker_audit()
        .into_iter()
        .filter(|r| r.entry.action.name == "plugin-host.broker.open-cancel")
        .collect();
    assert_eq!(opens.len(), 2);
    assert!(matches!(
        opens[0].entry.decision,
        AuditDecision::Deny { .. }
    ));
    assert_eq!(opens[1].entry.decision, AuditDecision::Allow);
    while srv.accepted.try_recv().is_ok() {}
}

// ---------------------------------------------------------------------------------------------
// Revocation, expiry, ownership
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn revocation_closes_open_handles() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    let id = env
        .grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let scope = Arc::new(env.scope(alice()));
    let mut idle = scope.open("pg1", "data").await.unwrap();
    let mut busy = scope.open("pg1", "data").await.unwrap();
    round_trip(&scope, &mut idle, b"ping").await;

    // A recv blocked on the network is interrupted by revocation.
    let pending = {
        let scope = scope.clone();
        tokio::spawn(async move { scope.recv(&mut busy, 100).await })
    };
    tokio::time::sleep(Duration::from_millis(50)).await;
    env.grants
        .revoke(&allow(), &admin(), &id, "c")
        .await
        .unwrap();
    assert!(env.grants.is_revoked(&id));

    let r = tokio::time::timeout(Duration::from_secs(5), pending)
        .await
        .expect("recv was not interrupted")
        .unwrap();
    assert_eq!(r, Err(BrokerError::PermissionDenied));
    assert_eq!(
        scope.send(&mut idle, b"x").await,
        Err(BrokerError::PermissionDenied)
    );
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
}

#[tokio::test]
async fn revocation_closes_the_socket() {
    let pki = Pki::new("CA");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let env = env();
    let id = env
        .grant(request(port, TlsMode::InProtocolUpgrade, &pki.ca))
        .await;
    let scope = env.scope(alice());
    let _t = scope.open("pg1", "data").await.unwrap();
    let (mut server_side, _): (TcpStream, _) = listener.accept().await.unwrap();

    env.grants
        .revoke(&allow(), &admin(), &id, "c")
        .await
        .unwrap();
    // The broker closed its end although the plugin still holds the handle.
    let mut buf = [0u8; 1];
    let n = tokio::time::timeout(Duration::from_secs(5), server_side.read(&mut buf))
        .await
        .expect("socket stayed open")
        .unwrap_or(0);
    assert_eq!(n, 0);
}

#[tokio::test]
async fn expired_grant_denies_and_closes() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    let mut req = request(srv.addr.port(), TlsMode::Direct, &pki.ca);
    req.expires_at_unix_ms = Some(env.clock.now_unix_ms() + 60_000);
    env.grant(req).await;
    let scope = env.scope(alice());
    let mut t = scope.open("pg1", "data").await.unwrap();
    round_trip(&scope, &mut t, b"ok").await;

    env.clock.advance(60_000);
    assert_eq!(
        scope.send(&mut t, b"x").await,
        Err(BrokerError::PermissionDenied)
    );
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
}

#[tokio::test]
async fn handles_are_not_transferable() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let a = env.scope(alice());
    let b = env.scope(alice()); // another plugin instance, same principal
    let mut t = a.open("pg1", "data").await.unwrap();
    assert_eq!(
        b.send(&mut t, b"x").await,
        Err(BrokerError::PermissionDenied)
    );
    assert_eq!(b.recv(&mut t, 1).await, Err(BrokerError::PermissionDenied));
    round_trip(&a, &mut t, b"still mine").await;
}

// ---------------------------------------------------------------------------------------------
// Principals, tenants and plugins
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn every_principal_in_the_chain_must_be_eligible() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;

    // Eligible agent acting for an eligible human.
    env.scope(agent_for(alice(), &["agent-read"]))
        .open("pg1", "data")
        .await
        .unwrap();
    // The agent's own roles are not eligible.
    assert_eq!(
        env.scope(agent_for(alice(), &["agent-write"]))
            .open("pg1", "data")
            .await
            .unwrap_err(),
        BrokerError::PermissionDenied
    );
    // An eligible agent cannot lend its eligibility to a human who has none.
    let mallory = principal(
        PrincipalKind::Human,
        "human:oidc:mallory",
        "t1",
        &["viewer"],
    );
    assert_eq!(
        env.scope(agent_for(mallory, &["agent-read"]))
            .open("pg1", "data")
            .await
            .unwrap_err(),
        BrokerError::PermissionDenied
    );
    // A chain that crosses tenants.
    let foreign = principal(PrincipalKind::Human, "human:oidc:bob", "t2", &["analyst"]);
    let denied = env.scope(agent_for(foreign, &["agent-read"]));
    assert_eq!(
        denied.open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
    assert!(matches!(
        env.broker_audit().last().unwrap().entry.decision,
        AuditDecision::Deny {
            reason: Reason::TenantMismatch
        }
    ));
    // Another tenant does not see the target at all.
    let other_tenant = principal(PrincipalKind::Human, "human:oidc:bob", "t2", &["analyst"]);
    assert_eq!(
        env.scope(other_tenant)
            .open("pg1", "data")
            .await
            .unwrap_err(),
        BrokerError::PermissionDenied
    );
}

#[tokio::test]
async fn grant_is_bound_to_the_plugin_digest() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let mut c = caller(alice());
    c.plugin_digest = Digest([0xcd; 32]);
    assert_eq!(
        env.broker.scope(c).open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
    let mut c = caller(alice());
    c.driver_kind = DriverKind::Native;
    assert_eq!(
        env.broker.scope(c).open("pg1", "data").await.unwrap_err(),
        BrokerError::PermissionDenied
    );
}

#[tokio::test]
async fn transports_per_scope_are_limited() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env_with(
        FakeResolver::new(&[&["127.0.0.1"]]),
        BrokerConfig {
            limits: BrokerLimits {
                max_transports_per_scope: 1,
                ..BrokerLimits::default()
            },
            ..BrokerConfig::default()
        },
    );
    env.grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let scope = env.scope(alice());
    let first = scope.open("pg1", "data").await.unwrap();
    assert_eq!(
        scope.open("pg1", "data").await.unwrap_err(),
        BrokerError::LimitExceeded
    );
    drop(first);
    scope.open("pg1", "data").await.unwrap();
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn audit_is_chained_attributed_and_redacted() {
    let pki = Pki::new("CA");
    let srv = server(
        "127.0.0.1",
        0,
        ServerMode::DirectTls,
        pki.server_config("db.test"),
    )
    .await;
    let env = env();
    let id = env
        .grant(request(srv.addr.port(), TlsMode::Direct, &pki.ca))
        .await;
    let scope = env.scope(agent_for(alice(), &["agent-read"]));
    let mut t = scope.open("pg1", "data").await.unwrap();
    round_trip(&scope, &mut t, b"payload-bytes-must-not-be-logged").await;
    env.grants
        .revoke(&allow(), &admin(), &id, "c")
        .await
        .unwrap();

    let records = env.audit.records();
    AuditChain::verify_all(&records).unwrap();
    let names: Vec<_> = records
        .iter()
        .map(|r| r.entry.action.name.as_str())
        .collect();
    assert_eq!(
        names,
        [
            "plugin-host.grants.create",
            "plugin-host.broker.open",
            "plugin-host.grants.revoke"
        ]
    );

    let open = &records[1].entry;
    let chain: Vec<_> = open
        .principal_chain
        .iter()
        .map(|p| (p.kind, p.id.as_str()))
        .collect();
    let plugin_id = format!("plugin:org.example.dbee.postgres#sha256:{PLUGIN_DIGEST}");
    assert_eq!(
        chain,
        [
            (PrincipalKind::Plugin, plugin_id.as_str()),
            (PrincipalKind::Agent, "agent:token:a"),
            (PrincipalKind::Human, "human:oidc:alice"),
        ]
    );
    assert_eq!(open.target.as_ref().unwrap().id, "pg1");
    assert_eq!(open.correlation_id, "corr-1");

    let json = serde_json::to_string(&records).unwrap();
    assert!(!json.contains(SECRET_REF));
    assert!(!json.contains("payload-bytes"));
}
