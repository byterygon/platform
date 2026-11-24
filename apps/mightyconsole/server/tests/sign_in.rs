//! OIDC sign-in end to end on the real server (DOC-25 §3.2, TSK-136): `[auth.oidc]` against the
//! conformance suite's test identity provider over TLS on loopback (the lab's Dex is the other
//! end-to-end test). CI runs this file in a network namespace with only loopback.

mod support;

use std::path::Path;
use std::sync::Arc;

use ambidex::{Code, Kind};
use ambidex_axum::oidc::{ClaimsSource, TokenAuth};
use ambidex_conformance::oidc::{CLIENT_ID, CLIENT_SECRET, TestIdp};
use base64::Engine as _;
use mightyconsole_server::StartOptions;
use mightyconsole_server::config::OidcSettings;
use rustls::pki_types::{CertificateDer, ServerName};
use security_types::{Clock, SystemClock};
use serde_json::json;
use support::*;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

const LOGIN_COOKIE: &str = "__Host-mc_login";

fn pem(cert: &CertificateDer<'_>) -> String {
    let body = base64::engine::general_purpose::STANDARD.encode(cert.as_ref());
    let lines: Vec<&str> = body
        .as_bytes()
        .chunks(64)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        lines.join("\n")
    )
}

fn settings(idp: &TestIdp, dir: &Path) -> OidcSettings {
    std::fs::write(dir.join("idp-ca.pem"), pem(&idp.ca())).unwrap();
    std::fs::write(dir.join("oidc-secret"), format!("{CLIENT_SECRET}\n")).unwrap();
    OidcSettings {
        issuer: idp.issuer().to_owned(),
        client_id: CLIENT_ID.into(),
        client_secret_file: Some(dir.join("oidc-secret")),
        token_auth: TokenAuth::Basic,
        ca_file: dir.join("idp-ca.pem"),
        scopes: Some(
            ["openid", "profile", "email", "groups"]
                .map(String::from)
                .to_vec(),
        ),
        groups_claim: None,
        claims_source: ClaimsSource::IdToken,
        display_name: Some("Test SSO".into()),
        clock_skew: None,
        idp_logout: true,
        algorithms: None,
    }
}

async fn signed_in_server() -> (TestServer, TestIdp, tempfile::TempDir) {
    signed_in_server_with(StartOptions::default()).await
}

async fn signed_in_server_with(options: StartOptions) -> (TestServer, TestIdp, tempfile::TempDir) {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let idp = TestIdp::start(clock, &format!("{ORIGIN}/auth/callback")).await;
    let dir = tempfile::tempdir().unwrap();
    let oidc = settings(&idp, dir.path());
    let t = start_configured(None, options, |config| {
        config.auth.oidc = Some(oidc);
        config.auth.tenant = "acme".into();
    })
    .await;
    (t, idp, dir)
}

/// A GET to the test IdP, trusting only its certificate.
async fn idp_get(idp: &TestIdp, url: &str) -> HttpResponse {
    let url = url::Url::parse(url).unwrap_or_else(|_| panic!("an IdP URL, not {url:?}"));
    let mut roots = rustls::RootCertStore::empty();
    roots.add(idp.ca()).unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(("127.0.0.1", idp.port())).await.unwrap();
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("127.0.0.1").unwrap(), tcp)
        .await
        .unwrap();
    let path = format!("{}?{}", url.path(), url.query().unwrap_or(""));
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        idp.port()
    );
    tls.write_all(request.as_bytes()).await.unwrap();
    read_response(&mut tls).await
}

fn set_cookie_value(response: &HttpResponse, name: &str) -> Option<String> {
    response
        .headers
        .iter()
        .filter(|(n, _)| n == "set-cookie")
        .filter_map(|(_, v)| v.strip_prefix(&format!("{name}=")))
        .map(|v| v.split(';').next().unwrap().to_owned())
        .find(|v| !v.is_empty())
}

/// Signs a browser in: login, the IdP, the callback. Returns the session cookie.
async fn sign_in(t: &TestServer, idp: &TestIdp, next: &str) -> (String, HttpResponse) {
    let start = t
        .request("GET", &format!("/auth/login?next={next}"), HOST, &[])
        .await;
    assert_eq!(start.status, 302, "{}", start.body);
    let binding = set_cookie_value(&start, LOGIN_COOKIE).expect("the login cookie");
    let at_idp = idp_get(idp, start.header("location").unwrap()).await;
    assert_eq!(at_idp.status, 302);
    let back = url::Url::parse(at_idp.header("location").unwrap()).unwrap();
    assert_eq!(back.origin().ascii_serialization(), ORIGIN);
    let callback = format!("{}?{}", back.path(), back.query().unwrap());
    let cookie = format!("{LOGIN_COOKIE}={binding}");
    let done = t
        .request("GET", &callback, HOST, &[("Cookie", &cookie)])
        .await;
    assert_eq!(done.status, 200, "{}", done.body);
    let session = set_cookie_value(&done, COOKIE).expect("a session cookie");
    (session, done)
}

#[tokio::test]
async fn the_signed_out_page_has_no_token_and_names_the_idp() {
    let (t, _idp, _dir) = signed_in_server().await;
    let page = t.http("/", HOST, None).await;
    assert_eq!(page.status, 200);
    assert!(
        page.body
            .contains("<meta name=\"mightyconsole-auth\" content=\"signed-out\">")
    );
    assert!(
        page.body
            .contains("<meta name=\"mightyconsole-idp\" content=\"Test SSO\">")
    );
    assert!(
        !page.body.contains("mightyconsole-csrf"),
        "no token signed out"
    );
    assert!(
        page.header("set-cookie").is_none(),
        "no session without sign-in"
    );
    let health = t.http("/healthz", HOST, None).await;
    assert_eq!((health.status, health.body.as_str()), (200, "ok"));
    // Without a session the upgrade is refused.
    assert_eq!(
        t.upgrade(HOST, Some(ORIGIN), Some("forged")).await.err(),
        Some(401)
    );
}

#[tokio::test]
async fn a_person_signs_in_uses_the_console_and_signs_out() {
    let (t, idp, _dir) = signed_in_server().await;
    let (session, done) = sign_in(&t, &idp, "%2Fnats%2Fdev").await;
    assert!(
        done.body.contains("content=\"0;url=/nats/dev\""),
        "{}",
        done.body
    );
    let set = done
        .headers
        .iter()
        .find(|(n, v)| n == "set-cookie" && v.starts_with(&format!("{COOKIE}=")))
        .unwrap()
        .1
        .clone();
    for attribute in ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] {
        assert!(set.contains(attribute), "{set}");
    }

    // The page now carries the session's token.
    let page = t.http("/", HOST, Some(&session)).await;
    assert!(page.body.contains("content=\"signed-in\""));
    let csrf = page.csrf();
    assert_eq!(t.server.login_sessions().unwrap().len(), 1);
    let info = &t.server.login_sessions().unwrap().list()[0];
    assert_eq!(info.user, "human:oidc:alice");
    assert_eq!(info.groups, ["ops"]);

    // Calls are allowed to the signed-in person (allow-all until roles, TSK-138).
    let browser = Browser {
        cookie: session.clone(),
        csrf: csrf.clone(),
    };
    let mut tab = t.tab(&browser).await;
    tab.call(1, "app.info", json!({})).await;
    let frame = tab.frame(1).await;
    assert_eq!(frame.kind, Kind::Result, "{frame:?}");

    // Sign-out: the exact Origin, the token and the cookie; the tab gets Goaway.
    let cookie = format!("{COOKIE}={session}");
    let refused = t
        .request(
            "POST",
            "/auth/logout",
            HOST,
            &[("Cookie", &cookie), ("Origin", ORIGIN)],
        )
        .await;
    assert_eq!(refused.status, 403);
    let out = t
        .request(
            "POST",
            "/auth/logout",
            HOST,
            &[
                ("Cookie", &cookie),
                ("Origin", ORIGIN),
                ("X-Mightyconsole-Csrf", &csrf),
            ],
        )
        .await;
    assert_eq!(out.status, 303, "{}", out.body);
    assert!(
        out.header("location")
            .unwrap()
            .contains("/dex/logout?id_token_hint=")
    );
    let goaway = tab.client.expect_goaway().await;
    assert_eq!(goaway.code, Code::Unauthenticated);
    assert!(t.server.login_sessions().unwrap().is_empty());
    let page = t.http("/", HOST, Some(&session)).await;
    assert!(page.body.contains("content=\"signed-out\""));
}

#[tokio::test]
async fn a_failed_sign_in_returns_to_the_page_with_its_code() {
    let (t, idp, _dir) = signed_in_server().await;
    let start = t.request("GET", "/auth/login", HOST, &[]).await;
    let at_idp = idp_get(&idp, start.header("location").unwrap()).await;
    let back = url::Url::parse(at_idp.header("location").unwrap()).unwrap();
    // The callback without the login cookie: another browser.
    let callback = format!("{}?{}", back.path(), back.query().unwrap());
    let answer = t.request("GET", &callback, HOST, &[]).await;
    assert_eq!(answer.status, 303);
    assert_eq!(answer.header("location"), Some("/?login_error=invalid"));
    assert!(t.server.login_sessions().unwrap().is_empty());
}

#[tokio::test]
async fn under_a_base_path_the_routes_and_cookies_follow_it() {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let idp = TestIdp::start(clock, &format!("{ORIGIN}/tools/mc/auth/callback")).await;
    let dir = tempfile::tempdir().unwrap();
    let oidc = settings(&idp, dir.path());
    let t = start_configured(None, StartOptions::default(), |config| {
        config.auth.oidc = Some(oidc);
        config.base_path = "/tools/mc".into();
    })
    .await;
    assert_eq!(t.http("/tools/mc/healthz", HOST, None).await.body, "ok");
    let start = t.request("GET", "/tools/mc/auth/login", HOST, &[]).await;
    assert_eq!(start.status, 302);
    let binding = set_cookie_value(&start, "__Host-mc_login_tools_mc").expect("login cookie");
    let at_idp = idp_get(&idp, start.header("location").unwrap()).await;
    let back = url::Url::parse(at_idp.header("location").unwrap()).unwrap();
    assert_eq!(back.path(), "/tools/mc/auth/callback");
    let callback = format!("{}?{}", back.path(), back.query().unwrap());
    let cookie = format!("__Host-mc_login_tools_mc={binding}");
    let done = t
        .request("GET", &callback, HOST, &[("Cookie", &cookie)])
        .await;
    assert_eq!(done.status, 200, "{}", done.body);
    assert!(done.body.contains("content=\"0;url=/tools/mc\""));
    assert!(set_cookie_value(&done, &t.cookie_name).is_some());
}

#[tokio::test]
async fn a_bad_sign_in_configuration_stops_the_start() {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let idp = TestIdp::start(clock, &format!("{ORIGIN}/auth/callback")).await;
    let dir = tempfile::tempdir().unwrap();
    let mut oidc = settings(&idp, dir.path());
    oidc.issuer = "http://127.0.0.1:1/dex".into();
    let mut config = support::config(dir.path(), None);
    config.auth.oidc = Some(oidc.clone());
    let err = mightyconsole_server::Server::start(config.clone())
        .await
        .err()
        .unwrap();
    assert!(err.to_string().contains("https://"), "{err}");
    oidc.issuer = idp.issuer().to_owned();
    oidc.client_secret_file = Some(dir.path().join("missing"));
    config.auth.oidc = Some(oidc);
    let err = mightyconsole_server::Server::start(config)
        .await
        .err()
        .unwrap();
    assert!(err.to_string().contains("missing"), "{err}");
}

/// `config check` validates without listening; `--online` also reaches the IdP.
#[tokio::test]
async fn config_check_reports_and_reaches_the_idp_when_asked() {
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);
    let idp = TestIdp::start(clock, &format!("{ORIGIN}/auth/callback")).await;
    let dir = tempfile::tempdir().unwrap();
    settings(&idp, dir.path());
    let file = dir.path().join("config.toml");
    std::fs::write(
        &file,
        format!(
            "[server]\npublic_origin = \"{ORIGIN}\"\n\n[auth.oidc]\nissuer = \"{}\"\n\
             client_id = \"{CLIENT_ID}\"\nclient_secret_file = \"oidc-secret\"\nca_file = \"idp-ca.pem\"\n",
            idp.issuer()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let run = |online: bool| {
        let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_mightyconsole-server"));
        command
            .args(["config", "check", "--config"])
            .arg(&file)
            .arg("--data")
            .arg(dir.path());
        if online {
            command.arg("--online");
        }
        command
            .env_remove("MIGHTYCONSOLE_OIDC_CLIENT_SECRET")
            .output()
    };
    let offline = run(false).await.unwrap();
    let text = String::from_utf8_lossy(&offline.stdout).into_owned();
    assert!(
        offline.status.success(),
        "{text}{}",
        String::from_utf8_lossy(&offline.stderr)
    );
    assert!(
        text.contains(&format!("redirect URI {ORIGIN}/auth/callback")),
        "{text}"
    );
    assert!(!text.contains("discovery"));
    assert!(
        text.contains("audit log ") && text.contains("0 records, chain intact"),
        "{text}"
    );
    assert!(
        !dir.path().join("audit").exists(),
        "config check does not create the log"
    );
    let online = run(true).await.unwrap();
    let text = String::from_utf8_lossy(&online.stdout).into_owned();
    assert!(online.status.success(), "{text}");
    assert!(text.contains("discovery and keys fetched"), "{text}");
    assert!(
        !dir.path().join("tls").exists() && !dir.path().join("audit").exists(),
        "config check creates nothing"
    );

    idp.set_down(true);
    let down = run(true).await.unwrap();
    assert!(!down.status.success());
    assert!(String::from_utf8_lossy(&down.stderr).contains("identity provider"));
}

/// DOC-25 §3.5.1: a sign-in, a refused sign-in and a sign-out each leave one entry, in the
/// server's tenant, with identifiers and counts and never a token, code or cookie.
#[tokio::test]
async fn sign_in_a_refused_sign_in_and_sign_out_are_in_the_audit_log() {
    use security_types::{AuditDecision, MemoryAuditLog, Outcome, PrincipalKind};

    let log = Arc::new(MemoryAuditLog::new());
    let options = StartOptions {
        audit_sink: Some(Arc::clone(&log) as Arc<dyn security_types::AuditSink>),
        ..StartOptions::default()
    };
    let (t, idp, _dir) = signed_in_server_with(options).await;
    let (session, _) = sign_in(&t, &idp, "%2F").await;
    // A callback from another browser: refused.
    let start = t.request("GET", "/auth/login", HOST, &[]).await;
    let at_idp = idp_get(&idp, start.header("location").unwrap()).await;
    let back = url::Url::parse(at_idp.header("location").unwrap()).unwrap();
    let callback = format!("{}?{}", back.path(), back.query().unwrap());
    let refused = t.request("GET", &callback, HOST, &[]).await;
    assert_eq!(refused.header("location"), Some("/?login_error=invalid"));
    // Sign out.
    let page = t.http("/", HOST, Some(&session)).await;
    let csrf = page.csrf();
    let cookie = format!("{COOKIE}={session}");
    let out = t
        .request(
            "POST",
            "/auth/logout",
            HOST,
            &[
                ("Cookie", &cookie),
                ("Origin", ORIGIN),
                ("X-Mightyconsole-Csrf", &csrf),
            ],
        )
        .await;
    assert_eq!(out.status, 303);

    let named = |name: &str| {
        log.entries()
            .into_iter()
            .filter(|e| e.action.name == name)
            .collect::<Vec<_>>()
    };
    eventually("the sign-out entry", || !named("auth.logout").is_empty()).await;
    let logins = named("auth.login");
    assert_eq!(logins.len(), 2, "{logins:?}");
    let ok = &logins[0];
    assert_eq!(ok.tenant.as_str(), "acme");
    assert_eq!(ok.principal_chain[0].id, "human:oidc:alice");
    assert_eq!(ok.principal_chain[0].kind, PrincipalKind::Human);
    assert!(!ok.principal_chain[0].session.as_str().is_empty());
    assert_eq!(ok.outcome, Outcome::Success);
    let detail = serde_json::to_value(&ok.detail).unwrap();
    assert_eq!(detail["method"], "oidc");
    assert_eq!(detail["groups"], "1");
    let bad = &logins[1];
    assert_eq!(bad.principal_chain[0].id, "system:auth");
    assert!(matches!(bad.decision, AuditDecision::Deny { .. }));
    assert_eq!(
        bad.outcome,
        Outcome::Error {
            code: "invalid".into()
        }
    );
    let out = &named("auth.logout")[0];
    assert_eq!(out.principal_chain[0].id, "human:oidc:alice");
    assert_eq!(
        out.principal_chain[0].session, ok.principal_chain[0].session,
        "the same session signed in and out"
    );
    assert!(
        named("auth.session.end").is_empty(),
        "a sign-out is auth.logout, not a session end"
    );
    assert_eq!(named("server.start").len(), 1);
    // Nothing secret: the session cookie, the CSRF token and the client secret are not in it.
    let text = serde_json::to_string(&log.entries()).unwrap();
    for secret in [session.as_str(), csrf.as_str(), CLIENT_SECRET] {
        assert!(!text.contains(secret), "a secret reached the audit log");
    }
}
