//! Built-in account cases (DOC-25 §3.2.6, §6 "Built-in accounts") on the WebSocket transport:
//! the real account routes and session store, with accounts in memory.

#![cfg(feature = "ws")]

use std::time::Duration;

use ambidex_axum::accounts::{
    AccountsConfig, ChangePasswordError, RECOVERY_CODES, RequireTotp, Signup, TotpError, code_at,
};
use ambidex_axum::oidc::{AuthEvent, LoginError};
use ambidex_axum::{DEFAULT_SESSION_COOKIE, LoginMethod};
use ambidex_conformance::accounts::{
    AccountServer, CSRF_HEADER, GOOD_PASSWORD, PRE_COOKIE, body, run, run_with,
};
use ambidex_conformance::ws::ORIGIN;
use security_types::Clock;
use serde_json::json;

const FIFTEEN_MINUTES: Duration = Duration::from_secs(15 * 60);

fn failures(s: &AccountServer) -> Vec<(LoginError, String)> {
    s.hooks
        .events()
        .iter()
        .filter_map(|e| match e {
            AuthEvent::SignInFailed { error, reason, .. } => Some((*error, reason.clone())),
            _ => None,
        })
        .collect()
}

fn lockouts(s: &AccountServer) -> Vec<String> {
    s.hooks
        .events()
        .iter()
        .filter_map(|e| match e {
            AuthEvent::Lockout { user, .. } => Some(user.clone()),
            _ => None,
        })
        .collect()
}

/// Sign-up makes the account, signs it in with a new `__Host-` `SameSite=Strict` cookie, and the
/// principal on the WebSocket is `human:account:<ulid>`; the events are `auth.signup` and
/// `auth.login` with method password.
#[test]
fn sign_up_signs_the_new_account_in() {
    run(Signup::Open, async |s: &AccountServer| {
        let mut v = s.visitor();
        let answer = v
            .post(
                "/auth/signup",
                json!({ "username": "Alice", "displayName": " Alice A ", "password": GOOD_PASSWORD,
                        "next": "/tools/nats" }),
            )
            .await;
        assert_eq!(answer.status, 200, "{answer:?}");
        assert_eq!(
            body(&answer),
            json!({ "ok": true, "next": "/tools/nats", "mustChangePassword": false,
                "mustEnrolTotp": false })
        );
        assert_eq!(answer.headers["cache-control"], "no-store");
        let cookie = v.set_cookies.last().unwrap().clone();
        assert!(
            cookie.starts_with(&format!("{DEFAULT_SESSION_COOKIE}=")),
            "{cookie}"
        );
        for attribute in ["Path=/", "Secure", "HttpOnly", "SameSite=Strict"] {
            assert!(cookie.contains(attribute), "{cookie}");
        }
        let account = s.accounts.store().by_username_now("alice").expect("stored");
        assert_eq!(account.display_name, "Alice A");
        assert!(
            account
                .password_hash
                .as_deref()
                .unwrap()
                .starts_with("$argon2id$")
        );

        let mut client = v.connect().await;
        client.call(1, "fixture.whoami", json!({})).await;
        let who = client.expect_result(1).await;
        assert_eq!(who["principal"], format!("human:account:{}", account.id));

        let events = s.hooks.events();
        assert!(
            events
                .iter()
                .any(|e| matches!(e, AuthEvent::SignedUp { user, .. }
            if *user == account.principal_id()))
        );
        assert!(events.iter().any(|e| matches!(e,
            AuthEvent::SignedIn { method: LoginMethod::Password, user, .. }
            if *user == account.principal_id())));
    });
}

/// `auth.signup = off` refuses sign-up; a taken name, a bad name and each weak password are
/// refused with their own code and make no account.
#[test]
fn sign_up_refusals() {
    run(Signup::Off, async |s: &AccountServer| {
        let answer = s.visitor().sign_up("alice", GOOD_PASSWORD).await;
        assert_eq!(answer.status, 403);
        assert_eq!(body(&answer)["error"], "signup_off");
        assert!(s.accounts.store().by_username_now("alice").is_none());
    });
    run(Signup::Open, async |s: &AccountServer| {
        s.account("alice", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();
        let taken = v.sign_up("ALICE", GOOD_PASSWORD).await;
        assert_eq!(
            (taken.status, body(&taken)["error"].clone()),
            (409, json!("username_taken"))
        );
        let bad = v.sign_up("a b", GOOD_PASSWORD).await;
        assert_eq!(body(&bad)["error"], "invalid_username");
        for (password, reason) in [
            ("short pass", "too_short"),
            ("bob-is-my-name-ok", "contains_username"),
            ("Unbelievable", "common"),
        ] {
            let weak = v.sign_up("bob", password).await;
            assert_eq!(weak.status, 422, "{password}");
            assert_eq!(
                body(&weak),
                json!({ "error": "weak_password", "reason": reason })
            );
        }
        assert!(s.accounts.store().by_username_now("bob").is_none());
    });
}

/// Five sign-ups per client address per hour.
#[test]
fn sign_ups_are_limited_per_address() {
    run(Signup::Open, async |s: &AccountServer| {
        let mut v = s.visitor();
        for i in 0..5 {
            let answer = v.sign_up(&format!("user{i}"), GOOD_PASSWORD).await;
            assert_eq!(answer.status, 200, "{i}: {answer:?}");
        }
        let sixth = v.sign_up("user5", GOOD_PASSWORD).await;
        assert_eq!(sixth.status, 429);
        assert!(s.accounts.store().by_username_now("user5").is_none());
        s.clock().advance(Duration::from_secs(3600));
        assert_eq!(v.sign_up("user5", GOOD_PASSWORD).await.status, 200);
    });
}

/// The right password signs in; a wrong password and an unknown user name get the same answer at
/// the same cost (one hash each), and the reason goes to the events only.
#[test]
fn wrong_password_and_unknown_user_look_the_same() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();

        let before = s.hashes();
        let wrong = v.sign_in("alice", "not the right one").await;
        assert_eq!(s.hashes() - before, 1);
        let before = s.hashes();
        let unknown = v.sign_in("nobody", "not the right one").await;
        assert_eq!(s.hashes() - before, 1);
        let before = s.hashes();
        let malformed = v.sign_in("x", "not the right one").await;
        assert_eq!(
            s.hashes() - before,
            1,
            "even a name that cannot exist costs a hash"
        );
        for answer in [&wrong, &unknown, &malformed] {
            assert_eq!(answer.status, 401);
            assert_eq!(answer.body, wrong.body);
            assert_eq!(body(answer), json!({ "error": "invalid" }));
            assert!(v.session_cookie().is_none());
        }
        let reasons = failures(s);
        assert!(reasons[0].1.contains("wrong password") && reasons[0].1.contains(&account.id));
        assert!(reasons[1].1.contains("unknown user name"));
        assert!(
            !reasons[1].1.contains("nobody"),
            "an attempted name may be a password"
        );
        assert!(
            reasons
                .iter()
                .all(|(_, r)| !r.contains("not the right one"))
        );

        let ok = v.sign_in("ALICE", GOOD_PASSWORD).await;
        assert_eq!(ok.status, 200, "{ok:?}");
        assert!(v.session_cookie().is_some());
        assert!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .last_seen_ms
                .is_some()
        );
    });
}

/// Five wrong passwords within 15 minutes lock the account for 15 minutes: the answer does not
/// change, the right password is refused meanwhile, the lockout is an event, and it ends.
#[test]
fn five_failures_lock_the_account_for_fifteen_minutes() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();
        for _ in 0..4 {
            assert_eq!(v.sign_in("alice", "wrong password!").await.status, 401);
        }
        assert!(lockouts(s).is_empty());
        let fifth = v.sign_in("alice", "wrong password!").await;
        assert_eq!(
            (fifth.status, body(&fifth)),
            (401, json!({ "error": "invalid" }))
        );
        assert_eq!(lockouts(s), [account.principal_id()]);
        assert!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .locked_until_ms
                .is_some()
        );

        let before = s.hashes();
        let locked = v.sign_in("alice", GOOD_PASSWORD).await;
        assert_eq!(
            (locked.status, locked.body.clone()),
            (401, fifth.body.clone())
        );
        assert_eq!(s.hashes() - before, 1, "a locked account costs the same");
        assert!(failures(s).last().unwrap().1.contains("account locked"));

        s.clock().advance(FIFTEEN_MINUTES);
        assert_eq!(v.sign_in("alice", GOOD_PASSWORD).await.status, 200);
        assert_eq!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .locked_until_ms,
            None
        );

        // An administrator's unlock lifts a lock at once.
        let mut w = s.visitor();
        for _ in 0..5 {
            w.sign_in("alice", "wrong password!").await;
        }
        assert_eq!(w.sign_in("alice", GOOD_PASSWORD).await.status, 401);
        s.accounts.unlock(&account.id).await.unwrap();
        assert_eq!(w.sign_in("alice", GOOD_PASSWORD).await.status, 200);
    });
}

/// Twenty failures from one client address within 15 minutes answer 429 for 15 minutes, before
/// any hash is computed.
#[test]
fn twenty_failures_block_the_address() {
    run(Signup::Open, async |s: &AccountServer| {
        s.account("alice", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();
        for i in 0..20 {
            let answer = v.sign_in(&format!("nobody{i}"), "wrong password!").await;
            assert_eq!(answer.status, 401, "{i}");
        }
        let before = s.hashes();
        let blocked = v.sign_in("alice", GOOD_PASSWORD).await;
        assert_eq!(blocked.status, 429);
        assert_eq!(blocked.headers["retry-after"], "900");
        assert_eq!(s.hashes(), before);
        assert!(
            lockouts(s).is_empty(),
            "the account itself was not guessed at"
        );
        s.clock().advance(FIFTEEN_MINUTES);
        assert_eq!(v.sign_in("alice", GOOD_PASSWORD).await.status, 200);
    });
}

/// A request from another site cannot sign a browser in or up: without the exact Origin, the
/// pre-session token (cookie and header equal) or a JSON body, it is refused before any hash.
#[test]
fn cross_site_posts_are_refused() {
    run(Signup::Open, async |s: &AccountServer| {
        s.account("alice", Some(GOOD_PASSWORD), false).await;
        let login = json!({ "username": "alice", "password": GOOD_PASSWORD }).to_string();
        let mut v = s.visitor();
        let token = v.pre_token.clone();
        let other = "f".repeat(64);
        let cases: Vec<(Vec<(&str, &str)>, u16)> = vec![
            (
                vec![("content-type", "application/json"), (CSRF_HEADER, &token)],
                403,
            ),
            (
                vec![
                    ("origin", "https://evil.test"),
                    ("content-type", "application/json"),
                    (CSRF_HEADER, &token),
                ],
                403,
            ),
            (
                vec![("origin", ORIGIN), ("content-type", "application/json")],
                403,
            ),
            (
                vec![
                    ("origin", ORIGIN),
                    ("content-type", "application/json"),
                    (CSRF_HEADER, &other),
                ],
                403,
            ),
            (
                vec![
                    ("origin", ORIGIN),
                    ("content-type", "application/x-www-form-urlencoded"),
                    (CSRF_HEADER, &token),
                ],
                415,
            ),
        ];
        let before = s.hashes();
        for (headers, status) in &cases {
            for path in ["/auth/password", "/auth/signup", "/auth/setup"] {
                let answer = v.raw_post(path, headers, &login).await;
                assert_eq!(answer.status, *status, "{path} {headers:?}");
            }
        }
        // Without the pre-session cookie (a cross-site request does not carry a Strict cookie),
        // the header alone is not enough.
        v.cookies.remove(PRE_COOKIE);
        let answer = v
            .raw_post(
                "/auth/password",
                &[
                    ("origin", ORIGIN),
                    ("content-type", "application/json"),
                    (CSRF_HEADER, &token),
                ],
                &login,
            )
            .await;
        assert_eq!(answer.status, 403);
        assert_eq!(s.hashes(), before);
        assert!(v.session_cookie().is_none());
        assert!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .locked_until_ms
                .is_none()
        );
    });
}

/// The signed-out page keeps the browser's pre-session token and makes one when it has none.
#[test]
fn the_pre_session_token() {
    run(Signup::Open, async |s: &AccountServer| {
        let fresh = s.accounts.pre_session(&Default::default());
        let set = fresh
            .set_cookie
            .expect("a new cookie")
            .to_str()
            .unwrap()
            .to_owned();
        assert!(
            set.starts_with(&format!("{PRE_COOKIE}={}", fresh.token)),
            "{set}"
        );
        assert!(
            set.contains("SameSite=Strict") && set.contains("HttpOnly") && set.contains("Secure")
        );
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            "cookie",
            format!("{PRE_COOKIE}={}", fresh.token).parse().unwrap(),
        );
        let again = s.accounts.pre_session(&headers);
        assert_eq!(again.token, fresh.token);
        assert!(again.set_cookie.is_none());
        headers.insert("cookie", format!("{PRE_COOKIE}=short").parse().unwrap());
        assert_ne!(s.accounts.pre_session(&headers).token, "short");
    });
}

/// A session cookie from before the sign-in is ended and not accepted after it (fixation).
#[test]
fn signing_in_replaces_the_previous_session() {
    run(Signup::Open, async |s: &AccountServer| {
        s.account("alice", Some(GOOD_PASSWORD), false).await;
        s.account("mallory", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();
        assert_eq!(v.sign_in("mallory", GOOD_PASSWORD).await.status, 200);
        let planted = v.session_cookie().unwrap().to_owned();
        assert_eq!(v.sign_in("alice", GOOD_PASSWORD).await.status, 200);
        let mine = v.session_cookie().unwrap().to_owned();
        assert_ne!(planted, mine);
        assert!(
            s.sessions().peek(&planted).is_none(),
            "the earlier session ended"
        );
        assert!(s.sessions().peek(&mine).is_some());
        assert_eq!(s.sessions().len(), 1);
    });
}

/// A disabled account: the right password answers `disabled`, a wrong one the usual `invalid`.
#[test]
fn a_disabled_account_cannot_sign_in() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        s.store.update(&account.id, |a| a.disabled = true);
        let mut v = s.visitor();
        assert_eq!(
            body(&v.sign_in("alice", "wrong password!").await)["error"],
            "invalid"
        );
        let right = v.sign_in("alice", GOOD_PASSWORD).await;
        assert_eq!(
            (right.status, body(&right)["error"].clone()),
            (403, json!("disabled"))
        );
        assert!(v.session_cookie().is_none());
        assert_eq!(failures(s).last().unwrap().0, LoginError::Disabled);
    });
}

/// `mustChangePassword`: the session says so until the password is changed; changing it needs
/// the current password (a wrong one counts towards the lockout), checks the policy, ends the
/// account's other sessions and tells the hooks.
#[test]
fn must_change_password_and_changing_it() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("admin", Some("generated-password-1"), true).await;
        let mut other = s.visitor();
        assert_eq!(
            other.sign_in("admin", "generated-password-1").await.status,
            200
        );
        let mut v = s.visitor();
        let answer = v.sign_in("admin", "generated-password-1").await;
        assert_eq!(body(&answer)["mustChangePassword"], true);
        let info = s.sessions().peek(v.session_cookie().unwrap()).unwrap();
        assert!(info.must_change_password);
        let user = account.principal_id();

        let err = s
            .accounts
            .change_password(
                &user,
                &info.id,
                "wrong current!!".to_owned().into(),
                GOOD_PASSWORD.to_owned().into(),
                None,
            )
            .await;
        assert_eq!(err, Err(ChangePasswordError::WrongPassword));
        assert!(
            failures(s)
                .last()
                .unwrap()
                .1
                .contains("wrong current password")
        );
        let err = s
            .accounts
            .change_password(
                &user,
                &info.id,
                "generated-password-1".to_owned().into(),
                "admin-password-x".to_owned().into(),
                None,
            )
            .await;
        assert!(matches!(err, Err(ChangePasswordError::Rejected(_))));
        assert!(s.hooks.changed().is_empty());

        s.accounts
            .change_password(
                &user,
                &info.id,
                "generated-password-1".to_owned().into(),
                GOOD_PASSWORD.to_owned().into(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(s.hooks.changed(), std::slice::from_ref(&account.id));
        let info = s
            .sessions()
            .peek(v.session_cookie().unwrap())
            .expect("this session stays");
        assert!(!info.must_change_password);
        assert!(
            s.sessions().peek(other.session_cookie().unwrap()).is_none(),
            "the other ended"
        );
        let stored = s.accounts.store().by_username_now("admin").unwrap();
        assert!(!stored.must_change_password);

        let mut w = s.visitor();
        assert_eq!(w.sign_in("admin", "generated-password-1").await.status, 401);
        let answer = w.sign_in("admin", GOOD_PASSWORD).await;
        assert_eq!(body(&answer)["mustChangePassword"], false);

        let oidc = s
            .accounts
            .change_password(
                "human:oidc:x",
                &info.id,
                "a".to_owned().into(),
                "b".to_owned().into(),
                None,
            )
            .await;
        assert_eq!(oidc, Err(ChangePasswordError::NotAnAccount));
    });
}

/// A setup link sets the password and signs in, once; a reused, unknown or expired link is
/// refused; a password the policy refuses does not use the link up.
#[test]
fn setup_links_work_once_and_expire() {
    run(Signup::Off, async |s: &AccountServer| {
        let account = s.account("bob", None, false).await;
        let mut v = s.visitor();
        assert_eq!(
            v.sign_in("bob", "anything at all").await.status,
            401,
            "no password yet"
        );

        let link = s.accounts.create_setup_link(&account.id).await.unwrap();
        assert!(link.url.starts_with(&format!("{ORIGIN}/auth/setup?token=")));
        let token = link.url.split("token=").nth(1).unwrap().to_owned();

        let weak = v
            .post(
                "/auth/setup",
                json!({ "token": token, "password": "short" }),
            )
            .await;
        assert_eq!(body(&weak)["error"], "weak_password");
        let used = v
            .post(
                "/auth/setup",
                json!({ "token": token, "password": GOOD_PASSWORD }),
            )
            .await;
        assert_eq!(used.status, 200, "{used:?}");
        assert!(v.session_cookie().is_some());
        assert_eq!(s.hooks.changed(), std::slice::from_ref(&account.id));

        let mut w = s.visitor();
        let again = w
            .post(
                "/auth/setup",
                json!({ "token": token, "password": GOOD_PASSWORD }),
            )
            .await;
        assert_eq!(
            (again.status, body(&again)["error"].clone()),
            (401, json!("invalid_link"))
        );
        let unknown = w
            .post(
                "/auth/setup",
                json!({ "token": "0".repeat(64), "password": GOOD_PASSWORD }),
            )
            .await;
        assert_eq!(body(&unknown)["error"], "invalid_link");
        assert_eq!(w.sign_in("bob", GOOD_PASSWORD).await.status, 200);

        let link = s.accounts.create_setup_link(&account.id).await.unwrap();
        let token = link.url.split("token=").nth(1).unwrap().to_owned();
        s.clock().advance(Duration::from_secs(24 * 3600));
        let expired = w
            .post(
                "/auth/setup",
                json!({ "token": token, "password": GOOD_PASSWORD }),
            )
            .await;
        assert_eq!(body(&expired)["error"], "invalid_link");
    });
}

/// A malformed or oversized body is refused.
#[test]
fn malformed_bodies() {
    run(Signup::Open, async |s: &AccountServer| {
        let mut v = s.visitor();
        let answer = v
            .post("/auth/password", json!({ "username": "alice" }))
            .await;
        assert_eq!(
            (answer.status, body(&answer)["error"].clone()),
            (400, json!("bad_request"))
        );
        let big = json!({ "username": "alice", "password": "x".repeat(20_000) });
        assert_eq!(v.post("/auth/password", big).await.status, 413);
    });
}

// The second factor (DOC-25 §3.2.6, Open question 8).

/// The key of an `otpauth://` URI (RFC 4648 base32, no padding).
fn key_of(uri: &str) -> Vec<u8> {
    let secret = uri
        .split(['?', '&'])
        .find_map(|p| p.strip_prefix("secret="))
        .expect("a secret");
    let mut bits = 0u32;
    let mut count = 0;
    let mut out = Vec::new();
    for c in secret.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => panic!("not base32: {c}"),
        };
        bits = (bits << 5) | u32::from(v);
        count += 5;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    out
}

/// A code that differs from `code` in its first digit.
fn other_code(code: &str) -> String {
    let first = if code.starts_with('0') { '1' } else { '0' };
    format!("{first}{}", &code[1..])
}

/// Signs `username` in and enrols TOTP; returns the key and the recovery codes.
async fn enrol(s: &AccountServer, username: &str) -> (Vec<u8>, Vec<String>) {
    let mut v = s.visitor();
    let answer = v.sign_in(username, GOOD_PASSWORD).await;
    assert_eq!(answer.status, 200, "{answer:?}");
    let session = s.sessions().peek(v.session_cookie().unwrap()).unwrap();
    let enrolment = s.accounts.totp_begin(&session.user).await.unwrap();
    assert!(
        enrolment
            .uri
            .starts_with(&format!("otpauth://totp/Conformance:{username}?"))
    );
    assert!(enrolment.qr_svg.starts_with("<svg") && !enrolment.qr_svg.contains("<script"));
    let key = key_of(&enrolment.uri);
    assert_eq!(key.len(), 20);
    let now = s.clock().now_unix_ms();
    let wrong = other_code(&code_at(&key, now).unwrap());
    assert_eq!(
        s.accounts
            .totp_confirm(&session.user, &session.id, &wrong)
            .await
            .err(),
        Some(TotpError::WrongCode)
    );
    let codes = s
        .accounts
        .totp_confirm(&session.user, &session.id, &code_at(&key, now).unwrap())
        .await
        .unwrap();
    assert_eq!(codes.len(), RECOVERY_CODES);
    let stored = s.accounts.store().by_username_now(username).unwrap();
    assert!(stored.totp.is_some());
    assert_eq!(stored.recovery_codes.len(), RECOVERY_CODES);
    assert!(
        stored
            .recovery_codes
            .iter()
            .all(|h| h.starts_with("$argon2id$"))
    );
    // The enrolment's own step is used: the next code is a step later.
    s.clock().advance(STEP);
    (key, codes.iter().map(|c| c.to_string()).collect())
}

const STEP: Duration = Duration::from_secs(30);

fn now(s: &AccountServer) -> u64 {
    s.clock().now_unix_ms()
}

/// With TOTP the password alone gives no session: the answer asks for a code and a pending
/// sign-in cookie; the right code completes it (method totp); a code is not accepted twice; one
/// step of drift either way is.
#[test]
fn totp_sign_in_needs_the_code_once() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        let (key, _) = enrol(s, "alice").await;

        let mut v = s.visitor();
        let first = v.sign_in("alice", GOOD_PASSWORD).await;
        assert_eq!((first.status, body(&first)), (200, json!({ "totp": true })));
        assert!(
            v.session_cookie().is_none(),
            "no session before every factor"
        );
        let pending = v.set_cookies.last().unwrap().clone();
        assert!(
            pending.contains("SameSite=Strict") && pending.contains("Max-Age=300"),
            "{pending}"
        );

        let right_code = code_at(&key, now(s)).unwrap();
        let wrong = v.code(&other_code(&right_code)).await;
        assert_eq!(
            (wrong.status, body(&wrong)),
            (401, json!({ "error": "invalid" }))
        );
        let done = v.code(&right_code).await;
        assert_eq!(done.status, 200, "{done:?}");
        assert!(v.session_cookie().is_some());
        assert!(s.hooks.events().iter().any(|e| matches!(e,
            AuthEvent::SignedIn { method: LoginMethod::Totp, user, .. } if *user == account.principal_id())));

        // The same code again, from another browser that knows the password: refused.
        let mut w = s.visitor();
        assert_eq!(body(&w.sign_in("alice", GOOD_PASSWORD).await)["totp"], true);
        assert_eq!(w.code(&right_code).await.status, 401);
        assert!(failures(s).last().unwrap().1.contains("code already used"));
        // The previous step's code (drift) is not accepted either: it is older than the one used.
        // The next step's code is (one step of drift ahead).
        let ahead = code_at(&key, now(s) + 30_000).unwrap();
        assert_eq!(w.code(&ahead).await.status, 200);
        assert!(w.session_cookie().is_some());

        // A code a step behind the clock, when nothing later was used, passes.
        s.clock().advance(STEP * 3);
        let mut x = s.visitor();
        x.sign_in("alice", GOOD_PASSWORD).await;
        let behind = code_at(&key, now(s) - 30_000).unwrap();
        assert_eq!(x.code(&behind).await.status, 200);
        let mut y = s.visitor();
        y.sign_in("alice", GOOD_PASSWORD).await;
        let two_behind = code_at(&key, now(s) + 90_000).unwrap();
        assert_eq!(y.code(&two_behind).await.status, 401, "two steps of drift");
    });
}

/// A recovery code signs in once, in any case and with or without its dash.
#[test]
fn a_recovery_code_works_once() {
    run(Signup::Open, async |s: &AccountServer| {
        s.account("alice", Some(GOOD_PASSWORD), false).await;
        let (_, codes) = enrol(s, "alice").await;
        let mut v = s.visitor();
        v.sign_in("alice", GOOD_PASSWORD).await;
        let typed = codes[3].replace('-', "").to_lowercase();
        assert_eq!(v.code(&typed).await.status, 200);
        assert_eq!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .recovery_codes
                .len(),
            RECOVERY_CODES - 1
        );
        let mut w = s.visitor();
        w.sign_in("alice", GOOD_PASSWORD).await;
        assert_eq!(w.code(&codes[3]).await.status, 401);
        assert!(
            failures(s)
                .last()
                .unwrap()
                .1
                .contains("wrong recovery code")
        );
        assert_eq!(w.code(&codes[4]).await.status, 200);
    });
}

/// Wrong codes count towards the lockout (a known password does not reset the count); the
/// pending sign-in ends after five tries, expires after five minutes, and belongs to its browser.
#[test]
fn wrong_codes_lock_and_pending_sign_ins_end() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        let (key, _) = enrol(s, "alice").await;
        let bad = if code_at(&key, now(s)).unwrap() == "111111" {
            "222222"
        } else {
            "111111"
        };

        let mut v = s.visitor();
        v.sign_in("alice", GOOD_PASSWORD).await;
        // Another browser cannot complete it: the pending sign-in is bound by its cookie.
        let mut thief = s.visitor();
        let stolen = thief.code(&code_at(&key, now(s)).unwrap()).await;
        assert_eq!(
            (stolen.status, body(&stolen)),
            (401, json!({ "error": "expired" }))
        );

        for _ in 0..2 {
            assert_eq!(v.code(bad).await.status, 401);
        }
        // Signing in again with the password keeps the count.
        let mut w = s.visitor();
        w.sign_in("alice", GOOD_PASSWORD).await;
        for _ in 0..2 {
            assert_eq!(w.code(bad).await.status, 401);
        }
        assert!(lockouts(s).is_empty());
        assert_eq!(w.code(bad).await.status, 401);
        assert_eq!(lockouts(s), [account.principal_id()]);
        // Locked: the right code is refused, and the password too.
        assert_eq!(v.code(&code_at(&key, now(s)).unwrap()).await.status, 401);
        assert_eq!(
            s.visitor().sign_in("alice", GOOD_PASSWORD).await.status,
            401
        );

        s.clock().advance(FIFTEEN_MINUTES);
        let mut x = s.visitor();
        x.sign_in("alice", GOOD_PASSWORD).await;
        for _ in 0..4 {
            x.code(bad).await;
        }
        s.clock().advance(FIFTEEN_MINUTES);
        // Five tries end the pending sign-in.
        let mut y = s.visitor();
        y.sign_in("alice", GOOD_PASSWORD).await;
        for _ in 0..5 {
            y.code(bad).await;
        }
        assert_eq!(
            body(&y.code(&code_at(&key, now(s)).unwrap()).await)["error"],
            "expired"
        );

        s.clock().advance(FIFTEEN_MINUTES);
        let mut z = s.visitor();
        z.sign_in("alice", GOOD_PASSWORD).await;
        s.clock().advance(Duration::from_secs(5 * 60));
        assert_eq!(
            body(&z.code(&code_at(&key, now(s)).unwrap()).await)["error"],
            "expired"
        );
    });
}

/// `auth.require_totp`: `all` gives an account without TOTP a session that must enrol first;
/// `admins` only for administrators; an account it applies to cannot remove its own TOTP.
#[test]
fn require_totp() {
    let mut config = AccountsConfig::new("Conformance");
    config.require_totp = RequireTotp::All;
    run_with(config, async |s: &AccountServer| {
        s.account("bob", Some(GOOD_PASSWORD), false).await;
        let mut v = s.visitor();
        let answer = v.sign_in("bob", GOOD_PASSWORD).await;
        assert_eq!(body(&answer)["mustEnrolTotp"], true);
        assert!(
            s.sessions()
                .peek(v.session_cookie().unwrap())
                .unwrap()
                .must_enrol_totp
        );
        let (_, _) = enrol(s, "bob").await;
        let user = s
            .accounts
            .store()
            .by_username_now("bob")
            .unwrap()
            .principal_id();
        assert_eq!(
            s.accounts
                .totp_remove(&user, GOOD_PASSWORD.to_owned().into(), None)
                .await,
            Err(TotpError::Required)
        );
    });
    let mut config = AccountsConfig::new("Conformance");
    config.require_totp = RequireTotp::Admins;
    run_with(config, async |s: &AccountServer| {
        s.account("admin", Some(GOOD_PASSWORD), false).await;
        s.account("bob", Some(GOOD_PASSWORD), false).await;
        let mut a = s.visitor();
        assert_eq!(
            body(&a.sign_in("admin", GOOD_PASSWORD).await)["mustEnrolTotp"],
            true
        );
        let mut b = s.visitor();
        assert_eq!(
            body(&b.sign_in("bob", GOOD_PASSWORD).await)["mustEnrolTotp"],
            false
        );
        // Enrolling lifts the restriction of the session that enrolled.
        let (_, _) = enrol(s, "admin").await;
        let mut c = s.visitor();
        assert_eq!(body(&c.sign_in("admin", GOOD_PASSWORD).await)["totp"], true);
    });
}

/// Removing one's own TOTP needs the current password; an administrator's reset clears it.
#[test]
fn removing_totp() {
    run(Signup::Open, async |s: &AccountServer| {
        let account = s.account("alice", Some(GOOD_PASSWORD), false).await;
        enrol(s, "alice").await;
        let user = account.principal_id();
        assert_eq!(
            s.accounts
                .totp_remove(&user, "wrong password!".to_owned().into(), None)
                .await,
            Err(TotpError::WrongPassword)
        );
        s.accounts
            .totp_remove(&user, GOOD_PASSWORD.to_owned().into(), None)
            .await
            .unwrap();
        let stored = s.accounts.store().by_username_now("alice").unwrap();
        assert!(stored.totp.is_none() && stored.recovery_codes.is_empty());
        let mut v = s.visitor();
        assert_eq!(body(&v.sign_in("alice", GOOD_PASSWORD).await)["ok"], true);

        enrol(s, "alice").await;
        s.accounts.clear_totp(&account.id).await.unwrap();
        assert!(
            s.accounts
                .store()
                .by_username_now("alice")
                .unwrap()
                .totp
                .is_none()
        );
        assert_eq!(
            s.accounts.totp_confirm(&user, "ls_x", "123456").await,
            Err(TotpError::NoEnrolment)
        );
    });
}
