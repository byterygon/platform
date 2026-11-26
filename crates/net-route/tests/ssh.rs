//! SSH jump hosts against stand-in sshds (DOC-23 4.3, 5): `direct-tcpip`, the host key checked on
//! every hop before any login, errors naming the hop and the SSH host, sshd's refusal to forward,
//! multi-hop through a channel, the session pool, and Test's host keys.

mod support;

use std::sync::atomic::Ordering;
use std::time::Duration;

use net_route::{
    Dialer, Hop, HopOutcome, HostKeyState, Route, RouteError, RouteErrorKind, SessionPool,
    Socks5Auth, Socks5Hop, SshAuth, SshHop, SshSession, fingerprint,
};
use support::sshd::{self, ClientKey, NO_FORWARD_USER, PASSWORD, USER};
use support::{Socks5Proxy, echo_target, lines};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn ssh(
    name: &str,
    host: &str,
    port: u16,
    client: &ClientKey,
    trusted: Option<&russh::keys::PublicKey>,
) -> SshHop {
    SshHop {
        name: name.into(),
        host: host.into(),
        port,
        user: USER.into(),
        auth: SshAuth::PrivateKey {
            key: client.text.clone().into(),
            passphrase: None,
        },
        trusted: trusted.map(fingerprint),
        keepalive: None,
    }
}

fn local(name: &str, sshd: &sshd::Sshd, client: &ClientKey) -> SshHop {
    ssh(
        name,
        "127.0.0.1",
        sshd.addr.port(),
        client,
        Some(&sshd.host_key),
    )
}

fn through(hops: Vec<Hop>) -> Dialer {
    Dialer::through(Route::new("test", hops)).unwrap()
}

async fn talk(stream: net_route::BoxStream) -> String {
    let mut stream = BufReader::new(stream);
    let mut banner = String::new();
    stream.read_line(&mut banner).await.unwrap();
    stream.get_mut().write_all(b"ping\n").await.unwrap();
    let mut echo = String::new();
    stream.read_line(&mut echo).await.unwrap();
    assert_eq!(echo, "ping\n");
    banner.trim_end().to_owned()
}

async fn dial_err(dialer: &Dialer, host: &str, port: u16) -> RouteError {
    match dialer.dial(host, port).await {
        Ok(_) => panic!("{host}:{port} should fail"),
        Err(e) => e,
    }
}

fn count(log: &support::Log, prefix: &str) -> usize {
    lines(log).iter().filter(|l| l.starts_with(prefix)).count()
}

async fn eventually(what: &str, check: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !check() {
        assert!(std::time::Instant::now() < deadline, "{what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn an_ssh_hop_forwards_to_a_name_only_it_knows() {
    let client = ClientKey::new();
    let target = echo_target("behind").await;
    let jump = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let dialer = through(vec![Hop::Ssh(local("bastion", &jump, &client))]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO behind"
    );
    assert!(lines(&jump.log).contains(&"direct-tcpip:echo.internal:7".to_owned()));
}

#[tokio::test]
async fn an_unknown_or_changed_host_key_stops_before_any_login_and_names_the_ssh_host() {
    let client = ClientKey::new();
    let jump = sshd::start(&client, Default::default()).await;
    let unknown = ssh("bastion", "127.0.0.1", jump.addr.port(), &client, None);
    let err = dial_err(&through(vec![Hop::Ssh(unknown)]), "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::HostKey);
    assert_eq!(err.hop.as_ref().unwrap().index, 0);
    let problem = err.host_key.clone().unwrap();
    assert_eq!(problem.state, HostKeyState::Unknown);
    assert_eq!(problem.ssh_host, "bastion");
    assert_eq!(problem.presented, fingerprint(&jump.host_key));
    assert!(
        err.message.contains("SSH host bastion (127.0.0.1:"),
        "{}",
        err.message
    );
    assert_eq!(jump.auth_attempts.load(Ordering::SeqCst), 0);

    let other = sshd::key();
    let changed = ssh(
        "bastion",
        "127.0.0.1",
        jump.addr.port(),
        &client,
        Some(other.public_key()),
    );
    let err = dial_err(&through(vec![Hop::Ssh(changed)]), "t", 1).await;
    let problem = err.host_key.clone().unwrap();
    assert_eq!(problem.state, HostKeyState::Changed);
    assert_eq!(problem.expected, Some(fingerprint(other.public_key())));
    assert!(err.message.contains("Nothing was sent"), "{}", err.message);
    assert_eq!(jump.auth_attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn two_ssh_hops_run_the_second_session_over_the_first_channel() {
    let client = ClientKey::new();
    let target = echo_target("deep").await;
    let inner = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let outer = sshd::start(&client, [("jump2.internal".to_owned(), inner.addr)].into()).await;
    let second = |trusted: Option<&russh::keys::PublicKey>| {
        Hop::Ssh(ssh("jump2", "jump2.internal", 22, &client, trusted))
    };
    let dialer = through(vec![
        Hop::Ssh(local("bastion", &outer, &client)),
        second(Some(&inner.host_key)),
    ]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO deep"
    );
    assert!(lines(&outer.log).contains(&"direct-tcpip:jump2.internal:22".to_owned()));

    // The second host's key is unknown: hop 2 and its SSH host are named, the first host was
    // logged in to, the second was sent nothing.
    let before = inner.auth_attempts.load(Ordering::SeqCst);
    let dialer = through(vec![
        Hop::Ssh(local("bastion", &outer, &client)),
        second(None),
    ]);
    let err = dial_err(&dialer, "echo.internal", 7).await;
    assert_eq!(err.kind, RouteErrorKind::HostKey);
    let hop = err.hop.clone().unwrap();
    assert_eq!(
        (hop.index, hop.kind, hop.label.as_str()),
        (1, "ssh", "jump2.internal:22")
    );
    assert_eq!(err.host_key.unwrap().ssh_host, "jump2");
    assert_eq!(inner.auth_attempts.load(Ordering::SeqCst), before);
}

#[tokio::test]
async fn sshd_refusing_to_forward_is_forbidden_and_an_unreachable_next_names_it() {
    let client = ClientKey::new();
    let jump = sshd::start(&client, Default::default()).await;
    let mut hop = local("bastion", &jump, &client);
    hop.user = NO_FORWARD_USER.into();
    let err = dial_err(&through(vec![Hop::Ssh(hop)]), "db.internal", 5432).await;
    assert_eq!(
        (err.kind, err.hop.as_ref().unwrap().index),
        (RouteErrorKind::Forbidden, 0)
    );
    assert!(
        err.message.contains("AllowTcpForwarding"),
        "{}",
        err.message
    );

    let err = dial_err(
        &through(vec![Hop::Ssh(local("bastion", &jump, &client))]),
        "nowhere",
        1,
    )
    .await;
    assert_eq!(err.kind, RouteErrorKind::Connect);
    assert!(err.hop.as_ref().unwrap().is_target(), "{err}");
}

#[tokio::test]
async fn logins_are_checked_and_keys_are_read_before_anything_is_contacted() {
    let client = ClientKey::new();
    let target = echo_target("pw").await;
    let jump = sshd::start(&client, [("t".to_owned(), target)].into()).await;
    let with_password = |password: &str| {
        let mut hop = local("bastion", &jump, &client);
        hop.auth = SshAuth::Password(password.into());
        through(vec![Hop::Ssh(hop)])
    };
    talk(with_password(PASSWORD).dial("t", 1).await.unwrap()).await;
    let err = dial_err(&with_password("hunter2"), "t", 1).await;
    assert_eq!(
        (err.kind, err.hop.as_ref().unwrap().index),
        (RouteErrorKind::Auth, 0)
    );
    assert!(
        err.message.contains("rejected the password"),
        "{}",
        err.message
    );
    assert!(!err.to_string().contains("hunter2"));

    let mut bad = local("bastion", &jump, &client);
    bad.auth = SshAuth::PrivateKey {
        key: "not a key".into(),
        passphrase: None,
    };
    let logged = lines(&jump.log).len();
    let err = Dialer::through(Route::new("r", vec![Hop::Ssh(bad)])).unwrap_err();
    assert_eq!(
        (err.kind, err.field),
        (RouteErrorKind::Invalid, Some("privateKey"))
    );
    assert_eq!(err.hop.unwrap().index, 0);
    assert!(!err.message.contains("not a key"));
    assert_eq!(lines(&jump.log).len(), logged);
}

#[tokio::test]
async fn without_a_pool_the_session_ends_with_its_stream() {
    let client = ClientKey::new();
    let target = echo_target("t").await;
    let jump = sshd::start(&client, [("t".to_owned(), target)].into()).await;
    let stream = through(vec![Hop::Ssh(local("bastion", &jump, &client))])
        .dial("t", 1)
        .await
        .unwrap();
    talk(stream).await;
    eventually("the session closes", || {
        count(&jump.log, "session closed") == 1
    })
    .await;
}

#[tokio::test]
async fn the_pool_shares_sessions_by_hops_and_lets_them_go_when_idle() {
    let client = ClientKey::new();
    let target = echo_target("pooled").await;
    let inner = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let outer = sshd::start(&client, [("jump2.internal".to_owned(), inner.addr)].into()).await;
    let pool = SessionPool::with_idle(Duration::from_millis(300));
    let hops = vec![
        Hop::Ssh(local("bastion", &outer, &client)),
        Hop::Ssh(ssh(
            "jump2",
            "jump2.internal",
            22,
            &client,
            Some(&inner.host_key),
        )),
    ];
    // Two dialers (two profiles) with equal hops share the sessions.
    let a = through(hops.clone()).with_pool(pool.clone());
    let b = through(hops.clone()).with_pool(pool.clone());
    let first = a.dial("echo.internal", 7).await.unwrap();
    let second = b.dial("echo.internal", 7).await.unwrap();
    talk(first).await;
    talk(second).await;
    assert_eq!(count(&outer.log, "login:"), 1);
    assert_eq!(count(&inner.log, "login:"), 1);
    assert_eq!(count(&inner.log, "direct-tcpip:echo.internal:7"), 2);
    assert_eq!(pool.len(), 2);

    // The first hop alone, as another route's prefix, reuses the outer session.
    let prefix = through(hops[..1].to_vec()).with_pool(pool.clone());
    let (host, port) = (inner.addr.ip().to_string(), inner.addr.port());
    drop(prefix.dial(&host, port).await.unwrap());
    assert_eq!(count(&outer.log, "login:"), 1);

    // Nothing holds them: both close after the idle time.
    eventually("the pool lets the idle sessions go", || pool.is_empty()).await;
    eventually("both sessions close", || {
        count(&outer.log, "session closed") == 1 && count(&inner.log, "session closed") == 1
    })
    .await;
}

#[tokio::test]
async fn test_reports_the_host_key_of_each_ssh_hop_and_logs_in_itself() {
    let client = ClientKey::new();
    let target = echo_target("t").await;
    let jump = sshd::start(&client, [("t".to_owned(), target)].into()).await;
    let pool = SessionPool::new();
    let dialer = through(vec![Hop::Ssh(local("bastion", &jump, &client))]).with_pool(pool.clone());
    drop(dialer.dial("t", 1).await.unwrap());
    let report = dialer.test("t", 1).await;
    assert_eq!(report.len(), 2);
    assert!(report.iter().all(|r| r.outcome == HopOutcome::Ok));
    assert_eq!(report[0].host_key, Some(fingerprint(&jump.host_key)));
    assert_eq!(count(&jump.log, "login:"), 2, "Test does not use the pool");
    assert_eq!(pool.len(), 1);

    let unknown = ssh("bastion", "127.0.0.1", jump.addr.port(), &client, None);
    let report = through(vec![Hop::Ssh(unknown)]).test("t", 1).await;
    assert_eq!(report.len(), 1);
    match &report[0].outcome {
        HopOutcome::Failed(e) => assert_eq!(
            e.host_key.as_ref().unwrap().presented,
            fingerprint(&jump.host_key)
        ),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn socks5_then_ssh_reaches_a_host_behind_both() {
    let client = ClientKey::new();
    let target = echo_target("mixed").await;
    let jump = sshd::start(&client, [("echo.internal".to_owned(), target)].into()).await;
    let (socks, socks_log) = Socks5Proxy {
        hosts: [("bastion.internal".to_owned(), jump.addr)].into(),
        ..Default::default()
    }
    .start()
    .await;
    let dialer = through(vec![
        Hop::Socks5(Socks5Hop {
            host: socks.ip().to_string(),
            port: socks.port(),
            auth: Socks5Auth::None,
        }),
        Hop::Ssh(ssh(
            "bastion",
            "bastion.internal",
            22,
            &client,
            Some(&jump.host_key),
        )),
    ]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO mixed"
    );
    assert!(lines(&socks_log).contains(&"connect:3:bastion.internal:22".to_owned()));
}

#[tokio::test]
async fn a_tools_own_session_opens_channels_through_the_dialer() {
    let client = ClientKey::new();
    let target = echo_target("own").await;
    let jump = sshd::start(&client, [("t".to_owned(), target)].into()).await;
    let session = std::sync::Arc::new(
        SshSession::connect(&Dialer::direct(), &local("bastion", &jump, &client))
            .await
            .unwrap(),
    );
    assert_eq!(session.host_key(), &fingerprint(&jump.host_key));
    talk(session.open_direct_tcpip("t", 1).await.unwrap()).await;
    session.close().await;
    eventually("closed", || count(&jump.log, "session closed") == 1).await;

    let unknown = ssh("bastion", "127.0.0.1", jump.addr.port(), &client, None);
    let err = SshSession::connect(&Dialer::direct(), &unknown)
        .await
        .unwrap_err();
    assert_eq!(err.kind, RouteErrorKind::HostKey);
    assert_eq!(
        err.hop.unwrap(),
        net_route::HopRef {
            index: 0,
            kind: "ssh",
            label: format!("127.0.0.1:{}", jump.addr.port())
        }
    );
}
