//! net-route against the Mightyconsole lab's `routes` profile (DOC-23 section 12): squid (HTTP
//! CONNECT, Basic auth, a plain and a TLS port), Dante (SOCKS5 with user and password), and
//! targets on a network that nothing but the proxies reaches. Needs
//! `node apps/mightyconsole/lab/lab.mts up routes`; run with
//! `cargo test -p net-route --features lab-tests --test lab`. The lab's generated files are read
//! from `apps/mightyconsole/lab/.generated` unless `MIGHTYCONSOLE_LAB_GENERATED` names another.
#![cfg(feature = "lab-tests")]

use std::path::PathBuf;

use net_route::{
    BasicAuth, BoxStream, Dialer, Hop, HopOutcome, HttpConnectHop, ProxyScheme, Route, RouteError,
    RouteErrorKind, Socks5Auth, Socks5Hop,
};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../apps/mightyconsole/lab/.generated")
        })
}

fn lab() -> Value {
    let path = generated().join("credentials.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e}; run `lab up routes` first", path.display()));
    let all: Value = serde_json::from_str(&text).unwrap();
    all["routes"].clone()
}

fn s(v: &Value) -> String {
    v.as_str().unwrap().to_owned()
}

fn split(address: &str) -> (String, u16) {
    let (host, port) = address.rsplit_once(':').unwrap();
    (host.to_owned(), port.parse().unwrap())
}

fn squid(lab: &Value, address: &str, password: Option<&str>) -> Hop {
    let (host, port) = split(address);
    Hop::HttpConnect(HttpConnectHop {
        scheme: ProxyScheme::Http,
        host,
        port,
        auth: password.map(|p| BasicAuth {
            user: s(&lab["httpProxy"]["user"]),
            password: p.into(),
        }),
        ca_pem: None,
    })
}

fn squid_tls(lab: &Value) -> Hop {
    let (host, port) = split(&s(&lab["httpProxy"]["https"]));
    let ca = std::fs::read_to_string(generated().join(s(&lab["httpProxy"]["caFile"]))).unwrap();
    Hop::HttpConnect(HttpConnectHop {
        scheme: ProxyScheme::Https,
        host,
        port,
        auth: Some(BasicAuth {
            user: s(&lab["httpProxy"]["user"]),
            password: s(&lab["httpProxy"]["password"]).into(),
        }),
        ca_pem: Some(ca),
    })
}

fn socks(lab: &Value, address: &str, password: &str) -> Hop {
    let (host, port) = split(address);
    Hop::Socks5(Socks5Hop {
        host,
        port,
        auth: Socks5Auth::UserPassword {
            user: s(&lab["socks5"]["user"]),
            password: password.into(),
        },
    })
}

fn through(hops: Vec<Hop>) -> Dialer {
    Dialer::through(Route::new("lab", hops)).unwrap()
}

async fn dial(dialer: &Dialer, target: &str) -> Result<BoxStream, RouteError> {
    let (host, port) = split(target);
    dialer.dial(&host, port).await
}

/// The echo target's banner, then one line echoed.
async fn echo(stream: BoxStream) {
    let mut stream = BufReader::new(stream);
    let mut banner = String::new();
    stream.read_line(&mut banner).await.unwrap();
    assert_eq!(banner, "HELLO routes-echo\n");
    stream
        .get_mut()
        .write_all(b"through the route\n")
        .await
        .unwrap();
    let mut back = String::new();
    stream.read_line(&mut back).await.unwrap();
    assert_eq!(back, "through the route\n");
}

#[tokio::test]
async fn squid_with_basic_auth_reaches_the_internal_echo() {
    let lab = lab();
    let password = s(&lab["httpProxy"]["password"]);
    let dialer = through(vec![squid(
        &lab,
        &s(&lab["httpProxy"]["http"]),
        Some(&password),
    )]);
    echo(dial(&dialer, &s(&lab["targets"]["echo"])).await.unwrap()).await;
}

#[tokio::test]
async fn squid_errors_name_the_hop_or_the_target() {
    let lab = lab();
    let address = s(&lab["httpProxy"]["http"]);
    let password = s(&lab["httpProxy"]["password"]);

    // The wrong password goes to a user of its own (TSK-147). squid keeps one cached record per
    // Basic user, password, state and the queue of requests waiting for the helper together: a
    // wrong password for the user the other tests log in with can make a concurrent right one get
    // the helper's ERR and a 407.
    let mut decoy = squid(&lab, &address, Some("wrong"));
    if let Hop::HttpConnect(hop) = &mut decoy {
        hop.auth.as_mut().unwrap().user = s(&lab["httpProxy"]["decoyUser"]);
    }
    let err = dial(&through(vec![decoy]), &s(&lab["targets"]["echo"]))
        .await
        .err()
        .unwrap();
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Auth, 0)
    );

    let err = dial(
        &through(vec![squid(&lab, &address, None)]),
        &s(&lab["targets"]["echo"]),
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err.kind, RouteErrorKind::Auth);

    let port = lab["httpProxy"]["forbiddenPort"].as_u64().unwrap();
    let ok = through(vec![squid(&lab, &address, Some(&password))]);
    let err = dial(&ok, &format!("echo.routes.internal:{port}"))
        .await
        .err()
        .unwrap();
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Forbidden, 0)
    );

    let err = dial(&ok, "missing.routes.internal:7").await.err().unwrap();
    let hop = err.hop.unwrap();
    assert!(hop.is_target(), "{hop:?}: {}", err.message);
    assert_eq!(hop.label, "missing.routes.internal:7");
}

#[tokio::test]
async fn squid_over_tls_with_the_pinned_ca_reaches_the_internal_web_page() {
    let lab = lab();
    let dialer = through(vec![squid_tls(&lab)]);
    let mut stream = dial(&dialer, &s(&lab["targets"]["http"])).await.unwrap();
    stream
        .write_all(b"GET / HTTP/1.0\r\nHost: echo.routes.internal\r\n\r\n")
        .await
        .unwrap();
    let mut page = String::new();
    stream.read_to_string(&mut page).await.unwrap();
    assert!(
        page.starts_with("HTTP/1.") && page.contains("routes-echo"),
        "{page}"
    );
}

#[tokio::test]
async fn socks5_with_a_login_reaches_nats_which_speaks_first() {
    let lab = lab();
    let dialer = through(vec![socks(
        &lab,
        &s(&lab["socks5"]["address"]),
        &s(&lab["socks5"]["password"]),
    )]);
    let stream = dial(&dialer, &s(&lab["targets"]["nats"])).await.unwrap();
    let mut info = String::new();
    BufReader::new(stream).read_line(&mut info).await.unwrap();
    assert!(info.starts_with("INFO {"), "{info}");

    let err = dial(&dialer, "missing.routes.internal:4222")
        .await
        .err()
        .unwrap();
    assert!(err.hop.unwrap().is_target(), "{}", err.message);

    let wrong = through(vec![socks(&lab, &s(&lab["socks5"]["address"]), "wrong")]);
    let err = dial(&wrong, &s(&lab["targets"]["nats"]))
        .await
        .err()
        .unwrap();
    assert_eq!(
        (err.kind, err.hop.unwrap().index),
        (RouteErrorKind::Auth, 0)
    );
}

#[tokio::test]
async fn a_chain_socks5_then_squid_reaches_the_echo_and_test_reports_each_hop() {
    let lab = lab();
    let dialer = through(vec![
        socks(
            &lab,
            &s(&lab["socks5"]["address"]),
            &s(&lab["socks5"]["password"]),
        ),
        squid(
            &lab,
            &s(&lab["internal"]["httpProxy"]),
            Some(&s(&lab["httpProxy"]["password"])),
        ),
    ]);
    echo(dial(&dialer, &s(&lab["targets"]["echo"])).await.unwrap()).await;
    let (host, port) = split(&s(&lab["targets"]["echo"]));
    let report = dialer.test(&host, port).await;
    let lines: Vec<_> = report
        .iter()
        .map(|r| (r.hop.kind, r.outcome == HopOutcome::Ok))
        .collect();
    assert_eq!(
        lines,
        [("socks5", true), ("httpConnect", true), ("target", true)]
    );
}

#[tokio::test]
async fn the_internal_targets_are_not_reachable_directly() {
    let lab = lab();
    let err = dial(&Dialer::direct(), &s(&lab["targets"]["echo"]))
        .await
        .err()
        .unwrap();
    assert_eq!(err.kind, RouteErrorKind::Connect);
    assert!(err.hop.unwrap().is_target());
}
