//! net-route against in-process fakes (DOC-23 5, "Conformance tests"): every hop kind of this
//! batch, the errors that name the hop, the budget, cancellation and Test.

mod support;

use std::sync::Arc;
use std::time::Duration;

use net_route::{
    BasicAuth, Dialer, Hop, HopOutcome, HttpConnectHop, ProxyScheme, Route, RouteError,
    RouteErrorKind, Socks5Auth, Socks5Hop, TcpConnect, TcpConnectFuture,
};
use support::{HttpProxy, Socks5Proxy, closed_port, echo_target, lines, tls_for_localhost};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn http(addr: std::net::SocketAddr) -> HttpConnectHop {
    HttpConnectHop::from_url(&format!("http://{addr}")).unwrap()
}

fn socks(addr: std::net::SocketAddr, auth: Socks5Auth) -> Hop {
    Hop::Socks5(Socks5Hop {
        host: addr.ip().to_string(),
        port: addr.port(),
        auth,
    })
}

fn login(user: &str, password: &str) -> Socks5Auth {
    Socks5Auth::UserPassword {
        user: user.into(),
        password: password.into(),
    }
}

fn through(hops: Vec<Hop>) -> Dialer {
    Dialer::through(Route::new("test", hops)).unwrap()
}

/// The target's first line, then one line echoed back.
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

fn hosts(name: &str, addr: std::net::SocketAddr) -> support::Hosts {
    [(name.to_owned(), addr)].into()
}

#[tokio::test]
async fn direct_reaches_the_target() {
    let target = echo_target("direct").await;
    let stream = Dialer::direct()
        .dial("127.0.0.1", target.port())
        .await
        .unwrap();
    assert_eq!(talk(stream).await, "HELLO direct");
}

#[tokio::test]
async fn direct_names_the_target_when_it_is_closed() {
    let port = closed_port().await.port();
    let err = dial_err(&Dialer::direct(), "127.0.0.1", port).await;
    assert_eq!(err.kind, RouteErrorKind::Connect);
    let hop = err.hop.unwrap();
    assert!(hop.is_target());
    assert_eq!(hop.label, format!("127.0.0.1:{port}"));
}

#[tokio::test]
async fn http_connect_sends_the_name_and_keeps_what_the_target_says_first() {
    let target = echo_target("internal").await;
    let (proxy, log) = HttpProxy {
        hosts: hosts("echo.internal", target),
        ..Default::default()
    }
    .start()
    .await;
    let dialer = through(vec![Hop::HttpConnect(http(proxy))]);
    // The banner arrives in the same write as the proxy's 200.
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO internal"
    );
    assert_eq!(lines(&log), ["CONNECT echo.internal:7 HTTP/1.1", "auth:-"]);
}

#[tokio::test]
async fn http_connect_logs_in_with_basic() {
    let target = echo_target("t").await;
    let (proxy, log) = HttpProxy {
        hosts: hosts("t", target),
        login: Some(("alice".into(), "s3cret".into())),
        ..Default::default()
    }
    .start()
    .await;
    let with = |password: Option<&str>| {
        let mut hop = http(proxy);
        hop.auth = password.map(|p| BasicAuth {
            user: "alice".into(),
            password: p.into(),
        });
        through(vec![Hop::HttpConnect(hop)])
    };
    talk(with(Some("s3cret")).dial("t", 1).await.unwrap()).await;
    assert!(lines(&log).contains(&"auth:Basic YWxpY2U6czNjcmV0".to_owned()));

    let err = dial_err(&with(Some("wrong")), "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Auth);
    assert_eq!(err.hop.as_ref().unwrap().index, 0);
    assert!(
        err.message.contains("rejected the user and password"),
        "{}",
        err.message
    );
    assert!(!err.to_string().contains("wrong"));

    let err = dial_err(&with(None), "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Auth);
    assert!(
        err.message.contains("needs a user and password"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn http_connect_statuses_name_the_right_node() {
    let (forbidden, _) = HttpProxy {
        status: Some(403),
        ..Default::default()
    }
    .start()
    .await;
    let err = dial_err(
        &through(vec![Hop::HttpConnect(http(forbidden))]),
        "db",
        5432,
    )
    .await;
    assert_eq!(err.kind, RouteErrorKind::Forbidden);
    assert_eq!(err.hop.unwrap().kind, "httpConnect");
    assert!(err.message.contains("SSL_ports"), "{}", err.message);

    // The proxy cannot reach the target: the target is named.
    let (proxy, _) = HttpProxy::default().start().await;
    let err = dial_err(&through(vec![Hop::HttpConnect(http(proxy))]), "nowhere", 80).await;
    assert_eq!(err.kind, RouteErrorKind::Connect);
    let hop = err.hop.unwrap();
    assert!(hop.is_target(), "{hop:?}");
    assert_eq!((hop.index, hop.label.as_str()), (1, "nowhere:80"));
    assert!(err.message.contains("503"), "{}", err.message);

    let (teapot, _) = HttpProxy {
        status: Some(418),
        ..Default::default()
    }
    .start()
    .await;
    let err = dial_err(&through(vec![Hop::HttpConnect(http(teapot))]), "db", 1).await;
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Connect, 0)
    );
    assert!(err.message.contains("HTTP/1.1 418 Fake"), "{}", err.message);
}

#[tokio::test]
async fn https_proxy_checks_the_pinned_ca() {
    let target = echo_target("tls").await;
    let (ca, tls) = tls_for_localhost();
    let (proxy, _) = HttpProxy {
        hosts: hosts("t", target),
        tls: Some(tls),
        ..Default::default()
    }
    .start()
    .await;
    let hop = |ca: Option<String>| HttpConnectHop {
        scheme: ProxyScheme::Https,
        host: "localhost".into(),
        port: proxy.port(),
        auth: None,
        ca_pem: ca,
    };
    let dialer = through(vec![Hop::HttpConnect(hop(Some(ca)))]);
    assert_eq!(talk(dialer.dial("t", 1).await.unwrap()).await, "HELLO tls");

    // Another CA: the TLS handshake with the proxy fails, nothing is sent through it.
    let (other_ca, _) = tls_for_localhost();
    let err = dial_err(
        &through(vec![Hop::HttpConnect(hop(Some(other_ca)))]),
        "t",
        1,
    )
    .await;
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Connect, 0)
    );
    assert!(
        err.message.contains("TLS with the proxy failed"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn socks5_without_auth_sends_names_as_names_and_addresses_as_addresses() {
    let target = echo_target("socks").await;
    let (proxy, log) = Socks5Proxy {
        hosts: hosts("echo.internal", target),
        ..Default::default()
    }
    .start()
    .await;
    let dialer = through(vec![socks(proxy, Socks5Auth::None)]);
    assert_eq!(
        talk(dialer.dial("echo.internal", 7).await.unwrap()).await,
        "HELLO socks"
    );
    talk(dialer.dial("127.0.0.1", target.port()).await.unwrap()).await;
    assert_eq!(
        lines(&log),
        [
            "methods:[0]".to_owned(),
            "connect:3:echo.internal:7".to_owned(),
            "methods:[0]".to_owned(),
            format!("connect:1:127.0.0.1:{}", target.port()),
        ]
    );
}

#[tokio::test]
async fn socks5_logs_in_with_user_and_password() {
    let target = echo_target("t").await;
    let (proxy, log) = Socks5Proxy {
        hosts: hosts("t", target),
        login: Some(("bob".into(), "pw".into())),
        ..Default::default()
    }
    .start()
    .await;
    talk(
        through(vec![socks(proxy, login("bob", "pw"))])
            .dial("t", 1)
            .await
            .unwrap(),
    )
    .await;
    assert_eq!(lines(&log)[..2], ["methods:[0, 2]", "login:bob"]);

    let err = dial_err(&through(vec![socks(proxy, login("bob", "nope"))]), "t", 1).await;
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Auth, 0)
    );

    let err = dial_err(&through(vec![socks(proxy, Socks5Auth::None)]), "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Auth);
    assert!(
        err.message.contains("needs a user and password"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn socks5_replies_name_the_right_node() {
    for (code, kind, is_target) in [
        (2, RouteErrorKind::Forbidden, false),
        (4, RouteErrorKind::Connect, true),
        (5, RouteErrorKind::Connect, true),
        (6, RouteErrorKind::Timeout, true),
        (7, RouteErrorKind::Connect, false),
    ] {
        let (proxy, _) = Socks5Proxy {
            reply: Some(code),
            ..Default::default()
        }
        .start()
        .await;
        let err = dial_err(
            &through(vec![socks(proxy, Socks5Auth::None)]),
            "db.internal",
            5432,
        )
        .await;
        assert_eq!(err.kind, kind, "reply {code}: {err}");
        assert_eq!(err.hop.unwrap().is_target(), is_target, "reply {code}");
    }
}

#[tokio::test]
async fn a_chain_of_proxies_reaches_the_target_and_names_the_failing_hop() {
    let target = echo_target("deep").await;
    // SOCKS5 → HTTP CONNECT → target: only the HTTP proxy knows the target's name, and only the
    // SOCKS5 proxy is reached from here.
    let (inner, inner_log) = HttpProxy {
        hosts: hosts("deep.internal", target),
        ..Default::default()
    }
    .start()
    .await;
    let (outer, outer_log) = Socks5Proxy {
        hosts: hosts("proxy.internal", inner),
        ..Default::default()
    }
    .start()
    .await;
    let inner_hop = |port: u16| {
        Hop::HttpConnect(HttpConnectHop {
            host: "proxy.internal".into(),
            port,
            ..http(inner)
        })
    };
    let dialer = through(vec![
        socks(outer, Socks5Auth::None),
        inner_hop(inner.port()),
    ]);
    assert_eq!(
        talk(dialer.dial("deep.internal", 9).await.unwrap()).await,
        "HELLO deep"
    );
    assert_eq!(
        lines(&outer_log)[1],
        format!("connect:3:proxy.internal:{}", inner.port())
    );
    assert_eq!(lines(&inner_log)[0], "CONNECT deep.internal:9 HTTP/1.1");

    // The second hop's own failure names hop 2 (index 1).
    let err = dial_err(&dialer, "unknown.internal", 9).await;
    assert!(err.hop.as_ref().unwrap().is_target(), "{err}");
    let (forbidding, _) = HttpProxy {
        status: Some(403),
        ..Default::default()
    }
    .start()
    .await;
    let (outer, _) = Socks5Proxy {
        hosts: hosts("proxy.internal", forbidding),
        ..Default::default()
    }
    .start()
    .await;
    let dialer = through(vec![
        socks(outer, Socks5Auth::None),
        inner_hop(forbidding.port()),
    ]);
    let err = dial_err(&dialer, "deep.internal", 9).await;
    assert_eq!(err.kind, RouteErrorKind::Forbidden);
    assert!(
        err.to_string()
            .starts_with("hop 2 (httpConnect proxy.internal:"),
        "{err}"
    );
    let hop = err.hop.unwrap();
    assert_eq!((hop.index, hop.kind), (1, "httpConnect"));
    assert_eq!(hop.label, format!("proxy.internal:{}", forbidding.port()));
}

#[tokio::test]
async fn a_silent_hop_times_out_within_the_budget_and_cancelling_closes_it() {
    let (silent, log) = HttpProxy {
        silent: true,
        ..Default::default()
    }
    .start()
    .await;
    let dialer =
        through(vec![Hop::HttpConnect(http(silent))]).with_budget(Duration::from_millis(300));
    let started = std::time::Instant::now();
    let err = dial_err(&dialer, "db", 1).await;
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Timeout, 0)
    );
    assert!(err.message.contains("budget of 0.3 s"), "{}", err.message);

    // Dropping the dial future closes the half-open connection to the proxy.
    let dialer = through(vec![Hop::HttpConnect(http(silent))]);
    let pending = tokio::time::timeout(Duration::from_millis(200), dialer.dial("db", 2)).await;
    assert!(pending.is_err());
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while lines(&log).iter().filter(|l| *l == "closed").count() < 2 {
        assert!(std::time::Instant::now() < deadline, "{:?}", lines(&log));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn the_first_hop_unreachable_names_it() {
    let closed = closed_port().await;
    let err = dial_err(&through(vec![socks(closed, Socks5Auth::None)]), "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Connect);
    let hop = err.hop.unwrap();
    assert_eq!((hop.index, hop.kind), (0, "socks5"));
}

/// A connector standing for the server's outbound policy.
struct Refusing;

impl TcpConnect for Refusing {
    fn connect<'a>(&'a self, host: &'a str, _port: u16) -> TcpConnectFuture<'a> {
        Box::pin(async move {
            Err(RouteError::new(
                None,
                RouteErrorKind::Forbidden,
                format!("{host} is refused by the outbound policy"),
            ))
        })
    }
}

#[tokio::test]
async fn the_connector_decides_the_first_connection_only() {
    let dialer = through(vec![socks(
        "127.0.0.1:1".parse().unwrap(),
        Socks5Auth::None,
    )])
    .with_connector(Arc::new(Refusing));
    let err = dial_err(&dialer, "t", 1).await;
    assert_eq!(err.kind, RouteErrorKind::Forbidden);
    assert_eq!(err.hop.unwrap().index, 0);
    let err = dial_err(&Dialer::direct().with_connector(Arc::new(Refusing)), "t", 1).await;
    assert!(err.hop.unwrap().is_target());
}

#[tokio::test]
async fn invalid_targets_are_refused_before_anything_is_contacted() {
    let (proxy, log) = HttpProxy::default().start().await;
    let dialer = through(vec![Hop::HttpConnect(http(proxy))]);
    for host in ["evil\r\nX-Injected: 1", "a b", ""] {
        let err = dial_err(&dialer, host, 80).await;
        assert_eq!(err.kind, RouteErrorKind::Invalid, "{host:?}");
    }
    assert_eq!(
        dial_err(&dialer, "ok", 0).await.kind,
        RouteErrorKind::Invalid
    );
    assert!(lines(&log).is_empty());
    assert!(Dialer::through(Route::new("none", vec![])).is_err());
}

#[tokio::test]
async fn test_reports_each_hop_then_the_target() {
    let target = echo_target("t").await;
    let (inner, _) = HttpProxy {
        hosts: hosts("t", target),
        login: Some(("u".into(), "p".into())),
        ..Default::default()
    }
    .start()
    .await;
    let (outer, _) = Socks5Proxy::default().start().await;
    let route = |password: &str| {
        let mut hop = http(inner);
        hop.auth = Some(BasicAuth {
            user: "u".into(),
            password: password.into(),
        });
        through(vec![socks(outer, Socks5Auth::None), Hop::HttpConnect(hop)])
    };
    let report = route("p").test("t", 1).await;
    let kinds: Vec<_> = report.iter().map(|r| (r.hop.index, r.hop.kind)).collect();
    assert_eq!(kinds, [(0, "socks5"), (1, "httpConnect"), (2, "target")]);
    assert!(report.iter().all(|r| r.outcome == HopOutcome::Ok));

    // The HTTP proxy was reached, then refused the login: its line is the failure, and the
    // target is not tried.
    let report = route("wrong").test("t", 1).await;
    assert_eq!(report.len(), 2);
    assert_eq!(report[0].outcome, HopOutcome::Ok);
    match &report[1].outcome {
        HopOutcome::Failed(e) => assert_eq!(e.kind, RouteErrorKind::Auth),
        other => panic!("{other:?}"),
    }
    assert_eq!(report[1].hop.index, 1);

    let report = Dialer::direct().test("127.0.0.1", target.port()).await;
    assert_eq!(report.len(), 1);
    assert!(report[0].hop.is_target() && report[0].outcome == HopOutcome::Ok);
}
