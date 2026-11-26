//! Sign-in cases (DOC-25 §3.2, §6 "Login and sessions") on the WebSocket transport, the only one
//! with a login: the real OIDC routes and session store against the in-process test IdP.

#![cfg(feature = "ws")]

use std::time::Duration;

use ambidex::Code;
use ambidex_axum::oidc::{AuthEvent, LoginError, PENDING_TTL};
use ambidex_axum::{DEFAULT_SESSION_COOKIE, EndReason, LoginMethod};
use ambidex_conformance::oidc::{
    CSRF_HEADER, LIMITS, LOGIN_COOKIE, SignInServer, Tamper, TestUser, assert_refused, login_error,
    run, session_set_cookie,
};
use ambidex_conformance::ws::{HOST, ORIGIN};
use serde_json::json;
use url::Url;

fn callback_with(callback: &str, key: &str, value: &str) -> String {
    let url = Url::parse(&format!("{ORIGIN}{callback}")).unwrap();
    let mut out = Url::parse(&format!("{ORIGIN}{}", url.path())).unwrap();
    for (k, v) in url.query_pairs() {
        let v = if k == key {
            value.to_owned()
        } else {
            v.into_owned()
        };
        out.query_pairs_mut().append_pair(&k, &v);
    }
    format!("{}?{}", out.path(), out.query().unwrap())
}

fn query_param(callback: &str, key: &str) -> String {
    Url::parse(&format!("{ORIGIN}{callback}"))
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .unwrap()
}

/// A lab user signs in and lands where they asked, with a new `__Host-`, `Secure`, `HttpOnly`,
/// `SameSite=Strict` session cookie; the flow used PKCE S256, a state and a nonce; the
/// principal on the WebSocket is the one built on the server.
#[test]
fn a_valid_sign_in_lands_on_next_with_a_strict_session() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        let start = browser.start_login("/tools/nats?tab=kv#/x").await;
        assert_eq!(start.status, 302);
        let login_cookie = browser.set_cookies.last().unwrap().clone();
        assert!(
            login_cookie.starts_with(&format!("{LOGIN_COOKIE}=")),
            "{login_cookie}"
        );
        assert!(login_cookie.contains("SameSite=Lax") && login_cookie.contains("Max-Age=600"));
        assert!(login_cookie.contains("Secure") && login_cookie.contains("HttpOnly"));
        let callback = browser.at_idp(&start).await;
        let asked = s.idp.last_authorize().unwrap();
        assert_eq!(asked["code_challenge_method"], "S256");
        assert_eq!(asked["code_challenge"].len(), 43);
        assert_eq!(asked["state"].len(), 43);
        assert_eq!(asked["nonce"].len(), 43);
        assert_eq!(asked["scope"], "openid profile email groups");
        assert_eq!(asked["redirect_uri"], format!("{ORIGIN}/auth/callback"));

        let done = browser.request("GET", &callback, &[]).await;
        assert_eq!(done.status, 200, "{done:?}");
        assert!(
            done.body
                .contains("content=\"0;url=/tools/nats?tab=kv#/x\""),
            "{}",
            done.body
        );
        assert!(!done.body.contains("<script"));
        assert_eq!(done.headers["referrer-policy"], "no-referrer");
        assert_eq!(done.headers["cache-control"], "no-store");
        let cookie = session_set_cookie(&browser).expect("a session cookie");
        assert!(cookie.starts_with(&format!("{DEFAULT_SESSION_COOKIE}=")));
        for attribute in ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] {
            assert!(cookie.contains(attribute), "{cookie} lacks {attribute}");
        }
        assert!(
            !cookie.contains("Max-Age"),
            "ends with the browser: {cookie}"
        );
        assert!(
            browser.cookie(LOGIN_COOKIE).is_none(),
            "the login cookie is cleared"
        );
        assert_eq!(s.login.pending_len(), 0);

        let mut client = browser.connect().await;
        client.call(1, "fixture.whoami", json!({})).await;
        let who = client.expect_result(1).await;
        assert_eq!(who["principal"], "human:oidc:alice");
        let session = who["session"].as_str().unwrap();
        assert!(
            session.starts_with("ls_") && session.contains('.'),
            "{session}"
        );

        let events = s.hooks.events();
        let signed_in = events
            .iter()
            .find_map(|e| match e {
                AuthEvent::SignedIn {
                    user,
                    method,
                    groups,
                    client,
                    ..
                } => Some((user.clone(), *method, *groups, *client)),
                _ => None,
            })
            .expect("auth.login recorded");
        assert_eq!(signed_in.0, "human:oidc:alice");
        assert_eq!(signed_in.1, LoginMethod::Oidc);
        assert_eq!(signed_in.2, 1);
        assert!(signed_in.3.is_some_and(|ip| ip.is_loopback()));
        let text = format!("{events:?}");
        let code = query_param(&callback, "code");
        for secret in [
            code.as_str(),
            "test-access-token",
            "eyJ",
            "test-client-secret",
        ] {
            assert!(!text.contains(secret), "events never hold {secret}");
        }
    });
}

/// Each spoiled ID token is refused with `login_error=invalid`, its reason recorded, and no
/// session (DOC-25 §6: wrong audience, wrong issuer, wrong nonce, expired, `none`, `HS256`, a key
/// not in the JWKS).
#[test]
fn spoiled_id_tokens_are_refused() {
    run(true, async |s: &SignInServer| {
        for (tamper, reason) in [
            (Tamper::Audience, "aud wrong"),
            (Tamper::ExtraAudience, "azp wrong"),
            (Tamper::Issuer, "iss wrong"),
            (Tamper::Nonce, "nonce wrong"),
            (Tamper::ExpiredBy(3600), "expired"),
            (Tamper::AlgNone, "malformed"),
            (Tamper::Hs256, "alg not allowed"),
            (Tamper::UnknownKey, "kid not in the JWKS"),
        ] {
            s.idp.tamper(Some(tamper));
            let mut browser = s.browser();
            let answer = browser.sign_in("/").await;
            assert_refused(s, &answer, LoginError::Invalid, reason);
            assert!(
                browser.cookie(DEFAULT_SESSION_COOKIE).is_none(),
                "{tamper:?}"
            );
        }
        assert!(s.ws.sessions().is_empty());
    });
}

/// Token times are accepted up to the configured skew (60 s) and refused one second past it.
#[test]
fn clock_skew_at_the_edge() {
    run(true, async |s: &SignInServer| {
        for (tamper, ok) in [
            (Tamper::ExpiredBy(59), true),
            (Tamper::ExpiredBy(60), false),
            (Tamper::AheadBy(60), true),
            (Tamper::AheadBy(61), false),
        ] {
            s.idp.tamper(Some(tamper));
            let mut browser = s.browser();
            let answer = browser.sign_in("/").await;
            assert_eq!(answer.status == 200, ok, "{tamper:?}: {answer:?}");
            if !ok {
                assert_eq!(login_error(&answer).as_deref(), Some("invalid"));
            }
        }
    });
}

/// A state that matches no pending login, and a callback in another browser (no login cookie),
/// are refused; the pending login is single use either way.
#[test]
fn state_mismatch_and_another_browser_are_refused() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        let start = browser.start_login("/").await;
        let callback = browser.at_idp(&start).await;
        let forged = callback_with(&callback, "state", "forged-state");
        let answer = browser.request("GET", &forged, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "state does not match");

        let mut other = s.browser();
        let answer = other.request("GET", &callback, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "login cookie");
        // That attempt used the pending login up.
        let answer = browser.request("GET", &callback, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "state does not match");

        // A login cookie from another sign-in does not bind this one.
        let mut a = s.browser();
        let start_a = a.start_login("/").await;
        let mut b = s.browser();
        let start_b = b.start_login("/").await;
        let callback_b = b.at_idp(&start_b).await;
        let _ = start_a;
        let answer = a.request("GET", &callback_b, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "login cookie");
        assert!(s.ws.sessions().is_empty());
    });
}

/// A replayed callback finds no pending login; a code replayed under a fresh state is refused by
/// the IdP's token endpoint (`invalid_grant`).
#[test]
fn a_replayed_code_is_refused() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        let start = browser.start_login("/").await;
        let callback = browser.at_idp(&start).await;
        assert_eq!(browser.request("GET", &callback, &[]).await.status, 200);
        let answer = browser.request("GET", &callback, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "state does not match");

        let mut again = s.browser();
        let start = again.start_login("/").await;
        let fresh = again.at_idp(&start).await;
        let replay = callback_with(&fresh, "code", &query_param(&callback, "code"));
        let answer = again.request("GET", &replay, &[]).await;
        assert_refused(s, &answer, LoginError::Invalid, "invalid_grant");
        assert_eq!(s.ws.sessions().len(), 1);
    });
}

/// A callback after the pending login's 10 minutes is `expired`; an IdP error is `denied`; a
/// disabled user is `disabled`.
#[test]
fn expired_denied_and_disabled() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        let start = browser.start_login("/").await;
        let callback = browser.at_idp(&start).await;
        s.clock().advance(PENDING_TTL);
        let answer = browser.request("GET", &callback, &[]).await;
        assert_refused(s, &answer, LoginError::Expired, "expired");

        s.idp.deny(true);
        let answer = s.browser().sign_in("/").await;
        assert_refused(s, &answer, LoginError::Denied, "access_denied");
        s.idp.deny(false);

        s.hooks.disable("alice");
        let answer = s.browser().sign_in("/").await;
        assert_refused(s, &answer, LoginError::Disabled, "disabled");
        assert!(s.ws.sessions().is_empty());
    });
}

/// The IdP rotates its key: a token with the new `kid` makes the server fetch the JWKS again,
/// once, and sign-in keeps working, also after the old key is gone.
#[test]
fn key_rotation_keeps_sign_in_working() {
    run(true, async |s: &SignInServer| {
        assert_eq!(s.browser().sign_in("/").await.status, 200);
        let (_, jwks, _, _) = s.idp.counts();
        assert_eq!(jwks, 1);
        s.idp.rotate(false);
        assert_eq!(s.browser().sign_in("/").await.status, 200);
        assert_eq!(s.idp.counts().1, 2, "one fetch for the unknown kid");
        // Unknown-kid fetches are at most once a minute.
        s.clock().advance(Duration::from_secs(61));
        s.idp.rotate(true);
        assert_eq!(s.browser().sign_in("/").await.status, 200);
        assert_eq!(s.idp.counts().1, 3);
        s.idp.tamper(Some(Tamper::UnknownKey));
        let answer = s.browser().sign_in("/").await;
        assert_refused(s, &answer, LoginError::Invalid, "kid not in the JWKS");
        assert_eq!(s.idp.counts().1, 3, "no second fetch within the minute");
        // A scheduled refresh picks keys up too.
        s.idp.tamper(None);
        s.login.refresh_keys().await.unwrap();
        assert_eq!(s.idp.counts().1, 4);
    });
}

/// With the IdP down, sign-in answers `unreachable` (before discovery and at the code exchange);
/// once it is back, sign-in works without a restart.
#[test]
fn the_idp_down_gives_unreachable() {
    run(false, async |s: &SignInServer| {
        s.idp.set_down(true);
        let answer = s.browser().start_login("/").await;
        assert_refused(s, &answer, LoginError::Unreachable, "unreachable");
        assert!(!s.login.is_ready());
        s.idp.set_down(false);
        // Retried on demand at most every 5 s.
        let answer = s.browser().start_login("/").await;
        assert_eq!(login_error(&answer).as_deref(), Some("unreachable"));
        s.clock().advance(Duration::from_secs(5));
        assert_eq!(s.browser().sign_in("/").await.status, 200);
        assert!(s.login.is_ready());

        let mut browser = s.browser();
        let start = browser.start_login("/").await;
        let callback = browser.at_idp(&start).await;
        s.idp.set_down(true);
        let answer = browser.request("GET", &callback, &[]).await;
        assert_refused(s, &answer, LoginError::Unreachable, "token endpoint");
    });
}

/// A sign-in that arrives while the start's fetch of discovery is still running waits for it
/// instead of answering `unreachable`.
#[test]
fn a_sign_in_during_the_first_fetch_waits_for_it() {
    run(false, async |s: &SignInServer| {
        let refresh = s.login.spawn_refresh();
        // Let the background fetch start, then sign in while it runs.
        tokio::task::yield_now().await;
        let answer = s.browser().sign_in("/").await;
        assert_eq!(answer.status, 200, "{answer:?}");
        assert_eq!(s.idp.counts().0, 1, "one discovery fetch");
        refresh.abort();
    });
}

/// A signed-in session ends past the idle limit and past the absolute limit: its connection gets
/// Goaway, new upgrades are refused, the page sees no session.
#[test]
fn session_idle_and_absolute_expiry() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        assert_eq!(browser.sign_in("/").await.status, 200);
        let cookie = browser.cookie(DEFAULT_SESSION_COOKIE).unwrap().to_owned();
        let mut client = browser.connect().await;
        s.clock().advance(LIMITS.idle);
        s.ws.sessions().sweep();
        assert_eq!(client.expect_goaway().await.code, Code::Unauthenticated);
        client.expect_closed().await;
        assert!(s.ws.sessions().page(&cookie).is_none());
        assert_eq!(
            s.ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.err(),
            Some(401)
        );

        let mut browser = s.browser();
        assert_eq!(browser.sign_in("/").await.status, 200);
        let mut client = browser.connect().await;
        let mut lived = Duration::ZERO;
        let step = LIMITS.idle - Duration::from_secs(60);
        let mut call = 1;
        while lived + step < LIMITS.absolute {
            s.clock().advance(step);
            lived += step;
            client.call(call, "fixture.echo", json!(call)).await;
            client.expect_result(call).await;
            call += 1;
        }
        s.clock().advance(LIMITS.absolute - lived);
        s.ws.sessions().sweep();
        assert_eq!(client.expect_goaway().await.code, Code::Unauthenticated);
    });
}

/// Sign-out needs the exact Origin and the session's anti-CSRF token; it ends the session on
/// every tab (Goaway), clears the cookie and goes to the IdP's logout with the ID token hint.
#[test]
fn logout_ends_the_session_everywhere_and_goes_to_the_idp() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        assert_eq!(browser.sign_in("/").await.status, 200);
        let mut tab_a = browser.connect().await;
        let mut tab_b = browser.connect().await;
        let csrf = browser.csrf().unwrap();
        let wrong_origin = browser
            .request(
                "POST",
                "/auth/logout",
                &[("origin", "https://evil.test"), (CSRF_HEADER, &csrf)],
            )
            .await;
        assert_eq!(wrong_origin.status, 403);
        let no_token = browser
            .request("POST", "/auth/logout", &[("origin", ORIGIN)])
            .await;
        assert_eq!(no_token.status, 403);
        let wrong_token = browser
            .request(
                "POST",
                "/auth/logout",
                &[("origin", ORIGIN), (CSRF_HEADER, "00")],
            )
            .await;
        assert_eq!(wrong_token.status, 403);
        assert_eq!(s.ws.sessions().len(), 1);

        let answer = browser.logout().await;
        assert_eq!(answer.status, 303, "{answer:?}");
        let location = Url::parse(answer.location().unwrap()).unwrap();
        assert_eq!(location.path(), "/dex/logout");
        let query: std::collections::HashMap<_, _> = location.query_pairs().into_owned().collect();
        assert!(query["id_token_hint"].starts_with("eyJ"));
        assert_eq!(query["post_logout_redirect_uri"], format!("{ORIGIN}/"));
        assert!(browser.cookie(DEFAULT_SESSION_COOKIE).is_none());
        for tab in [&mut tab_a, &mut tab_b] {
            assert_eq!(tab.expect_goaway().await.code, Code::Unauthenticated);
        }
        assert!(s.ws.sessions().is_empty());
        assert!(
            s.hooks.events().iter().any(
                |e| matches!(e, AuthEvent::SignedOut { user, .. } if user == "human:oidc:alice")
            )
        );
        // Signing out again is harmless.
        assert_eq!(browser.logout().await.status, 303);
    });
}

/// A script that asks for JSON (the UI's sign-out) gets the place to go as a 200 it can read, since
/// `fetch` cannot read a redirect to another origin; the session still ends and the cookie goes.
#[test]
fn logout_tells_a_script_where_to_go() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        assert_eq!(browser.sign_in("/").await.status, 200);
        let mut tab = browser.connect().await;
        let csrf = browser.csrf().unwrap();
        let answer = browser
            .request(
                "POST",
                "/auth/logout",
                &[
                    ("origin", ORIGIN),
                    (CSRF_HEADER, &csrf),
                    ("accept", "application/json"),
                ],
            )
            .await;
        assert_eq!(answer.status, 200, "{answer:?}");
        assert!(answer.location().is_none());
        let body: serde_json::Value = serde_json::from_str(&answer.body).unwrap();
        let location = Url::parse(body["location"].as_str().unwrap()).unwrap();
        assert_eq!(location.path(), "/dex/logout");
        assert!(browser.cookie(DEFAULT_SESSION_COOKIE).is_none());
        assert_eq!(tab.expect_goaway().await.code, Code::Unauthenticated);
        // Without a session the script is sent home.
        let again = browser
            .request(
                "POST",
                "/auth/logout",
                &[("origin", ORIGIN), ("accept", "application/json")],
            )
            .await;
        assert_eq!(again.status, 200);
        let body: serde_json::Value = serde_json::from_str(&again.body).unwrap();
        assert_eq!(body["location"], "/");
    });
}

/// Revoking a session, or all of a user's, ends its streams at once.
#[test]
fn a_revoked_session_ends_its_connections() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        assert_eq!(browser.sign_in("/").await.status, 200);
        let mut other = s.browser();
        s.idp.set_user(TestUser {
            sub: "bob".into(),
            name: "Bob".into(),
            groups: vec![],
        });
        assert_eq!(other.sign_in("/").await.status, 200);
        let mut alice = browser.connect().await;
        let mut bob = other.connect().await;
        alice.call(1, "fixture.wait", json!(null)).await;
        assert_eq!(
            s.ws.sessions()
                .revoke_user("human:oidc:alice", Some("human:oidc:admin")),
            1
        );
        assert_eq!(alice.expect_goaway().await.code, Code::Unauthenticated);
        bob.call(1, "fixture.echo", json!("still here")).await;
        assert_eq!(bob.expect_result(1).await, json!("still here"));
        let id = s.ws.sessions().list_user("human:oidc:bob")[0].id.clone();
        assert!(s.ws.sessions().end(&id, EndReason::Revoked, None));
        assert_eq!(bob.expect_goaway().await.code, Code::Unauthenticated);
    });
}

/// A cookie from before the sign-in is not accepted after it: the browser's old session ends and
/// a planted cookie value never becomes a session (no fixation).
#[test]
fn no_session_fixation() {
    run(true, async |s: &SignInServer| {
        let mut browser = s.browser();
        browser.set_cookie(DEFAULT_SESSION_COOKIE, &"a".repeat(64));
        assert_eq!(browser.sign_in("/").await.status, 200);
        let first = browser.cookie(DEFAULT_SESSION_COOKIE).unwrap().to_owned();
        assert_ne!(first, "a".repeat(64));
        assert_eq!(
            s.ws.upgrade(HOST, Some(ORIGIN), Some(&"a".repeat(64)))
                .await
                .err(),
            Some(401)
        );
        let mut tab = browser.connect().await;
        assert_eq!(browser.sign_in("/").await.status, 200);
        let second = browser.cookie(DEFAULT_SESSION_COOKIE).unwrap().to_owned();
        assert_ne!(first, second);
        assert_eq!(tab.expect_goaway().await.code, Code::Unauthenticated);
        assert_eq!(
            s.ws.upgrade(HOST, Some(ORIGIN), Some(&first)).await.err(),
            Some(401)
        );
        assert_eq!(s.ws.sessions().len(), 1);
    });
}

/// `next` must be a local path: anything else returns to the base path.
#[test]
fn next_cannot_leave_the_site() {
    run(true, async |s: &SignInServer| {
        for next in [
            "//evil.example/x",
            "https://evil.example",
            "/\\evil.example",
            "/a\"b",
        ] {
            let answer = s.browser().sign_in(next).await;
            assert!(
                answer.body.contains("content=\"0;url=/\""),
                "{next}: {}",
                answer.body
            );
        }
    });
}

/// `/auth/login` answers 429 past 30 a minute per client address; failed callbacks past 10 a
/// minute block that address's callbacks for a minute.
#[test]
fn sign_in_is_rate_limited() {
    run(true, async |s: &SignInServer| {
        for _ in 0..30 {
            assert_eq!(s.browser().start_login("/").await.status, 302);
        }
        assert_eq!(s.browser().start_login("/").await.status, 429);
        s.clock().advance(Duration::from_secs(60));
        let mut browser = s.browser();
        for _ in 0..10 {
            let answer = browser
                .request("GET", "/auth/callback?code=x&state=y", &[])
                .await;
            assert_eq!(login_error(&answer).as_deref(), Some("invalid"));
        }
        let answer = browser
            .request("GET", "/auth/callback?code=x&state=y", &[])
            .await;
        assert_eq!(login_error(&answer).as_deref(), Some("invalid"));
        let blocked = browser
            .request("GET", "/auth/callback?code=x&state=y", &[])
            .await;
        assert_eq!(blocked.status, 429);
        s.clock().advance(Duration::from_secs(61));
        assert_eq!(s.browser().sign_in("/").await.status, 200);
    });
}
