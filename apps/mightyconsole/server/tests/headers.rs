//! The browser's side after login and the new screens (TSK-141 review; DOC-25 §3.2.4, §3.7, Ambidex
//! §9): the page's Content-Security-Policy, framing and referrer rules; every other answer (errors,
//! redirects, `healthz`, the sign-in routes, the codec endpoint) with the baseline headers; the
//! session cookie's attributes; and the WebSocket upgrade refused for another Host, another Origin
//! or no session.

mod support;

use serde_json::json;
use support::*;

/// The baseline every answer carries.
fn baseline(what: &str, answer: &HttpResponse) {
    assert_eq!(
        answer.header("x-content-type-options"),
        Some("nosniff"),
        "{what}"
    );
    assert_eq!(
        answer.header("referrer-policy"),
        Some("no-referrer"),
        "{what}"
    );
    let csp = answer.header("content-security-policy").unwrap_or_default();
    assert!(csp.contains("frame-ancestors 'none'"), "{what}: {csp:?}");
}

#[tokio::test]
async fn every_answer_carries_the_browser_rules() {
    let t = start().await;

    // The page: its own policy, scripts from itself only.
    let page = t.http("/", HOST, None).await;
    assert_eq!(page.status, 200);
    baseline("the page", &page);
    let csp = page.header("content-security-policy").unwrap();
    for part in [
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ] {
        assert!(csp.contains(part), "{csp}");
    }
    assert!(!csp.contains("unsafe-eval"), "{csp}");
    assert!(page.header("strict-transport-security").is_some());
    assert_eq!(
        page.header("cross-origin-opener-policy"),
        Some("same-origin")
    );

    // Everything else, with the baseline.
    let healthz = t.http("/healthz", HOST, None).await;
    assert_eq!((healthz.status, healthz.body.trim()), (200, "ok"));
    baseline("healthz", &healthz);
    let missing = t.http("/assets/no-such-file.js", HOST, None).await;
    assert_eq!(missing.status, 404);
    baseline("a missing asset", &missing);
    let post = t.request("POST", "/", HOST, &[]).await;
    assert_eq!(post.status, 405);
    baseline("POST to the page", &post);
    let codec = t
        .request_with_body(
            "POST",
            "/codec/nothing/decode",
            HOST,
            &[
                ("Content-Type", "application/json"),
                ("X-Namespace", "default"),
            ],
            "{\"payloads\":[]}",
        )
        .await;
    assert_eq!(codec.status, 503, "{}", codec.body);
    baseline("the codec endpoint", &codec);
    assert!(codec.header("access-control-allow-origin").is_none());
    let login = t.http("/auth/login", HOST, None).await;
    baseline("the sign-in route", &login);

    // The session cookie of a sign-up: host-only, secure, not for scripts, same site only, and
    // gone with the browser.
    let (answer, _) = t
        .post_auth(
            "/auth/signup",
            &json!({ "username": "hdr", "password": "a long enough password here" }),
        )
        .await;
    assert_eq!(answer.status, 200, "{}", answer.body);
    baseline("the sign-up answer", &answer);
    assert_eq!(answer.header("cache-control"), Some("no-store"));
    let set = answer
        .headers
        .iter()
        .filter(|(n, _)| n == "set-cookie")
        .map(|(_, v)| v.as_str())
        .find(|v| v.starts_with("__Host-ambidex_session"))
        .expect("the session cookie");
    for attribute in ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"] {
        assert!(set.contains(attribute), "{set}");
    }
    for absent in ["Max-Age", "Expires", "Domain"] {
        assert!(!set.contains(absent), "{set}");
    }

    // A page from another Host is not served (DNS rebinding), nor is the WebSocket upgraded.
    let elsewhere = t.http("/", "attacker.test", None).await;
    assert_ne!(elsewhere.status, 200, "{}", elsewhere.status);
    let browser = t.browser().await;
    assert!(
        t.upgrade("attacker.test", Some(ORIGIN), Some(&browser.cookie))
            .await
            .is_err()
    );
    // Another Origin (a web page in the user's browser) and no session: refused.
    assert!(
        t.upgrade(HOST, Some("https://attacker.test"), Some(&browser.cookie))
            .await
            .is_err()
    );
    assert!(t.upgrade(HOST, None, Some(&browser.cookie)).await.is_err());
    assert!(t.upgrade(HOST, Some(ORIGIN), None).await.is_err());
    assert!(
        t.upgrade(HOST, Some(ORIGIN), Some(&browser.cookie))
            .await
            .is_ok()
    );
}
