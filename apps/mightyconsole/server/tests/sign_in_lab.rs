//! OIDC sign-in through the lab's Dex (DOC-25 §6 "Login and sessions", TSK-136): the real server
//! with `[auth.oidc]` pointing at `https://localhost:5556/dex`, its CA from the lab, and a lab user
//! signing in through Dex's own login form (RS256 tokens, groups from Dex). Needs
//! `pnpm --filter @byterygon/mightyconsole lab up idp`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test sign_in_lab`. Credentials come
//! from `lab/.generated/credentials.json` (or `MIGHTYCONSOLE_LAB_GENERATED`).
#![cfg(feature = "lab-tests")]

mod support;

use std::path::PathBuf;
use std::sync::Arc;

use ambidex::{Code, Kind};
use ambidex_axum::oidc::{ClaimsSource, TokenAuth};
use mightyconsole_server::StartOptions;
use mightyconsole_server::config::OidcSettings;
use rustls::pki_types::{CertificateDer, ServerName};
use rustls_pki_types::pem::PemObject as _;
use serde_json::{Value, json};
use support::*;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn idp() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up idp` first");
    serde_json::from_str::<Value>(&text).unwrap()["idp"].clone()
}

fn user(idp: &Value, name: &str) -> (String, String) {
    let user = idp["users"]
        .as_array()
        .unwrap()
        .iter()
        .find(|u| u["username"] == name)
        .unwrap();
    (
        user["email"].as_str().unwrap().into(),
        user["password"].as_str().unwrap().into(),
    )
}

async fn lab_server() -> TestServer {
    let idp = idp();
    let oidc = OidcSettings {
        issuer: idp["issuer"].as_str().unwrap().into(),
        client_id: idp["clientId"].as_str().unwrap().into(),
        client_secret_file: Some(generated().join(idp["clientSecretFile"].as_str().unwrap())),
        token_auth: TokenAuth::Basic,
        ca_file: generated().join(idp["caFile"].as_str().unwrap()),
        scopes: Some(
            ["openid", "profile", "email", "groups"]
                .map(String::from)
                .to_vec(),
        ),
        groups_claim: None,
        claims_source: ClaimsSource::IdToken,
        display_name: Some("Lab Dex".into()),
        clock_skew: None,
        idp_logout: true,
        algorithms: None,
    };
    start_configured(None, StartOptions::default(), |config| {
        config.auth.oidc = Some(oidc);
    })
    .await
}

/// A request to Dex (`https://localhost:5556`), trusting only the lab IdP's CA.
async fn dex(method: &str, path_and_query: &str, form: Option<&str>) -> HttpResponse {
    let pem = std::fs::read(generated().join(idp()["caFile"].as_str().unwrap())).unwrap();
    let mut roots = rustls::RootCertStore::empty();
    for cert in CertificateDer::pem_slice_iter(&pem) {
        roots.add(cert.unwrap()).unwrap();
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let tcp = TcpStream::connect(("127.0.0.1", 5556)).await.unwrap();
    let mut tls = TlsConnector::from(Arc::new(config))
        .connect(ServerName::try_from("localhost").unwrap(), tcp)
        .await
        .expect("TLS to Dex against the lab IdP's CA");
    let body = form.unwrap_or("");
    let extra = if form.is_some() {
        format!(
            "Content-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\n",
            body.len()
        )
    } else {
        String::new()
    };
    let request = format!(
        "{method} {path_and_query} HTTP/1.1\r\nHost: localhost:5556\r\n{extra}Connection: close\r\n\r\n{body}"
    );
    tls.write_all(request.as_bytes()).await.unwrap();
    read_response(&mut tls).await
}

fn path_of(location: &str) -> String {
    let url = url::Url::parse("https://localhost:5556")
        .unwrap()
        .join(location)
        .unwrap();
    match url.query() {
        Some(q) => format!("{}?{q}", url.path()),
        None => url.path().to_owned(),
    }
}

fn html_unescape(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&#43;", "+")
        .replace("&#61;", "=")
}

/// Signs `username` in: the server's `/auth/login`, Dex's login form, back to the callback.
/// Returns the session cookie and the callback's answer.
async fn sign_in(t: &TestServer, username: &str, next: &str) -> (String, HttpResponse) {
    let idp = idp();
    let (email, password) = user(&idp, username);
    let start = t
        .request("GET", &format!("/auth/login?next={next}"), HOST, &[])
        .await;
    assert_eq!(start.status, 302, "{}", start.body);
    let login_cookie = start
        .headers
        .iter()
        .find(|(n, v)| n == "set-cookie" && v.starts_with("__Host-mc_login="))
        .map(|(_, v)| v.split(';').next().unwrap().to_owned())
        .expect("the login cookie");
    let authorize = start.header("location").unwrap().to_owned();
    assert!(
        authorize.starts_with("https://localhost:5556/dex/auth?"),
        "{authorize}"
    );

    // Dex: redirects to its password connector's form, which posts back to itself.
    let mut answer = dex("GET", &path_of(&authorize), None).await;
    let mut hops = 0;
    while (300..400).contains(&answer.status) {
        answer = dex("GET", &path_of(answer.header("location").unwrap()), None).await;
        hops += 1;
        assert!(hops < 5, "too many redirects at Dex");
    }
    assert_eq!(answer.status, 200, "{}", answer.body);
    let action_at = answer.body.find("action=\"").expect("Dex's login form") + 8;
    let action =
        html_unescape(&answer.body[action_at..][..answer.body[action_at..].find('"').unwrap()]);
    let form: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("login", &email)
        .append_pair("password", &password)
        .finish();
    let mut answer = dex("POST", &path_of(&action), Some(&form)).await;
    let callback = loop {
        assert!(
            (300..400).contains(&answer.status),
            "{}: {}",
            answer.status,
            answer.body
        );
        let location = answer.header("location").unwrap().to_owned();
        if location.starts_with(ORIGIN) {
            break location;
        }
        answer = dex("GET", &path_of(&location), None).await;
    };
    let callback = callback.strip_prefix(ORIGIN).unwrap().to_owned();
    assert!(callback.starts_with("/auth/callback?code="), "{callback}");
    let done = t
        .request("GET", &callback, HOST, &[("Cookie", &login_cookie)])
        .await;
    assert_eq!(done.status, 200, "{}", done.body);
    let session = done
        .headers
        .iter()
        .find(|(n, v)| n == "set-cookie" && v.starts_with(&format!("{COOKIE}=")))
        .map(|(_, v)| {
            v.split(';')
                .next()
                .unwrap()
                .split_once('=')
                .unwrap()
                .1
                .to_owned()
        })
        .expect("a session cookie");
    (session, done)
}

#[tokio::test]
async fn a_lab_user_signs_in_through_dex_and_out_again() {
    let t = lab_server().await;
    let (session, done) = sign_in(&t, "alice", "%2Fdocker%2Flab").await;
    assert!(
        done.body.contains("content=\"0;url=/docker/lab\""),
        "{}",
        done.body
    );
    let sessions = t.server.login_sessions().unwrap();
    let info = sessions.list().pop().unwrap();
    assert!(info.user.starts_with("human:oidc:"), "{}", info.user);
    assert_eq!(info.groups, ["mc-admins", "ops"]);

    let page = t.http("/", HOST, Some(&session)).await;
    assert!(page.body.contains("content=\"signed-in\""));
    let csrf = page.csrf();
    let mut tab = t
        .tab(&Browser {
            cookie: session.clone(),
            csrf: csrf.clone(),
        })
        .await;
    tab.call(1, "app.info", json!({})).await;
    assert_eq!(tab.frame(1).await.kind, Kind::Result);

    // Dex has no end_session_endpoint: sign-out returns to the base path.
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
    assert_eq!(out.status, 303, "{}", out.body);
    assert_eq!(out.header("location"), Some(&*format!("{ORIGIN}/")));
    assert_eq!(tab.client.expect_goaway().await.code, Code::Unauthenticated);
    assert!(sessions.is_empty());
}

#[tokio::test]
async fn each_lab_user_gets_their_own_groups_and_session() {
    let t = lab_server().await;
    let (bob, _) = sign_in(&t, "bob", "%2F").await;
    let (carol, _) = sign_in(&t, "carol", "%2F").await;
    assert_ne!(bob, carol);
    let mut all = t.server.login_sessions().unwrap().list();
    all.sort_by(|a, b| a.groups.len().cmp(&b.groups.len()));
    assert_eq!(all.len(), 2);
    assert!(all[0].groups.is_empty());
    assert_eq!(all[1].groups, ["mc-viewers"]);
    assert_ne!(all[0].user, all[1].user);
}
