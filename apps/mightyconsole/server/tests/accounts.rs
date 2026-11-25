//! Built-in accounts on the real server (DOC-25 §3.2.6, §3.2.7, §6 "Built-in accounts"): sign-up
//! through the signed-out page's pre-session token, the default administrator's first sign-in
//! that may only change the password, sign-out without an IdP, and the audit entries. The
//! routes' own cases (lockout, TOTP, setup links, cross-site posts) are the conformance suite's
//! (`crates/ambidex-conformance/tests/accounts.rs`).

mod support;

use std::sync::Arc;

use ambidex::Code;
use mightyconsole_server::StartOptions;
use security_types::MemoryAuditLog;
use serde_json::{Value, json};
use support::*;

async fn post(t: &TestServer, path: &str, body: Value) -> (HttpResponse, Option<String>) {
    t.post_auth(path, &body).await
}

fn body(answer: &HttpResponse) -> Value {
    serde_json::from_str(&answer.body).unwrap_or(Value::Null)
}

/// A tab on a session cookie.
async fn tab_for(t: &TestServer, cookie: &str) -> Tab {
    let page = t.http("/", HOST, Some(cookie)).await;
    let browser = Browser {
        cookie: cookie.to_owned(),
        csrf: page.csrf(),
    };
    t.tab(&browser).await
}

#[tokio::test]
async fn sign_up_signs_in_a_member_who_can_work() {
    let log = Arc::new(MemoryAuditLog::new());
    let t = start_with(
        None,
        StartOptions {
            audit_sink: Some(Arc::clone(&log) as Arc<dyn security_types::AuditSink>),
            ..StartOptions::default()
        },
    )
    .await;
    let (answer, cookie) = post(
        &t,
        "/auth/signup",
        json!({ "username": "alice", "password": "correct horse battery staple" }),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(body(&answer)["mustChangePassword"], false);
    let cookie = cookie.expect("a session cookie");
    let mut tab = tab_for(&t, &cookie).await;
    tab.call(1, "app.me", json!({})).await;
    let me = tab.result(1).await;
    assert!(
        me["user"].as_str().unwrap().starts_with("human:account:"),
        "{me}"
    );
    assert_eq!(me["account"], true);
    assert_eq!(me["username"], "alice");
    assert_eq!(me["method"], "password");
    tab.call(3, "app.info", json!({})).await;
    assert!(tab.result(3).await["version"].is_string());

    // Out, without an IdP: the session ends and the browser goes to the base path.
    let page = t.http("/", HOST, Some(&cookie)).await;
    let cookie_header = format!("{}={cookie}", t.cookie_name);
    let out = t
        .request(
            "POST",
            "/auth/logout",
            HOST,
            &[
                ("Origin", ORIGIN),
                ("Cookie", &cookie_header),
                ("X-Mightyconsole-Csrf", &page.csrf()),
            ],
        )
        .await;
    assert_eq!(out.status, 303);
    assert_eq!(out.header("location"), Some("/"));
    assert!(t.server.login_sessions().is_empty());

    events_flushed().await;
    let names: Vec<String> = log
        .entries()
        .iter()
        .map(|e| e.action.name.clone())
        .collect();
    for name in ["auth.signup", "auth.login", "auth.logout"] {
        assert!(names.iter().any(|n| n == name), "{name} in {names:?}");
    }
    let text = serde_json::to_string(&log.records()).unwrap();
    assert!(
        !text.contains("correct horse"),
        "no password in the audit log"
    );
}

/// The default administrator signs in with the generated password and may then only change it;
/// the change deletes `DATA/admin-password` and lifts the restriction.
#[tokio::test]
async fn the_default_administrator_must_change_its_password_first() {
    let t = start().await;
    let file = t._dir.path().join("admin-password");
    let generated = t.admin_password();
    let (answer, cookie) = post(
        &t,
        "/auth/password",
        json!({ "username": "admin", "password": generated }),
    )
    .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    assert_eq!(body(&answer)["mustChangePassword"], true);
    let cookie = cookie.unwrap();
    let mut tab = tab_for(&t, &cookie).await;
    tab.call(1, "app.me", json!({})).await;
    assert_eq!(tab.result(1).await["mustChangePassword"], true);
    tab.call(2, "app.info", json!({})).await;
    // Refused (the reason stays on the server; `app.me` says what the session needs).
    tab.error(2, Code::PermissionDenied).await;
    tab.call(
        3,
        "app.account.changePassword",
        json!({ "current": "wrong one, not it", "new": "a brand new passphrase" }),
    )
    .await;
    let _ = tab.error(3, Code::InvalidArgument).await;
    tab.call(
        4,
        "app.account.changePassword",
        json!({ "current": generated, "new": "a brand new passphrase" }),
    )
    .await;
    tab.result(4).await;
    assert!(!file.exists(), "the generated password's file is gone");
    tab.call(5, "app.info", json!({})).await;
    assert!(tab.result(5).await["version"].is_string());

    // The old password no longer works; the new one does, without the restriction.
    let (old, _) = post(
        &t,
        "/auth/password",
        json!({ "username": "admin", "password": generated }),
    )
    .await;
    assert_eq!(old.status, 401);
    let (new, _) = post(
        &t,
        "/auth/password",
        json!({ "username": "admin", "password": "a brand new passphrase" }),
    )
    .await;
    assert_eq!(body(&new)["mustChangePassword"], false);
}

/// `auth.signup = "off"`: the page says so and the route refuses.
#[tokio::test]
async fn signup_off_hides_and_refuses_sign_up() {
    let t = start_configured(None, StartOptions::default(), |c| {
        c.auth.signup = ambidex_axum::accounts::Signup::Off;
    })
    .await;
    let page = t.http("/", HOST, None).await;
    assert!(
        page.body
            .contains(r#"<meta name="mightyconsole-signup" content="off">"#)
    );
    let (answer, cookie) = post(
        &t,
        "/auth/signup",
        json!({ "username": "alice", "password": "correct horse battery staple" }),
    )
    .await;
    assert_eq!(answer.status, 403);
    assert_eq!(body(&answer)["error"], "signup_off");
    assert!(cookie.is_none());
}

/// Gives the event writer a moment to hand its queue to the sink.
async fn events_flushed() {
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
}
