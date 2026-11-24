//! The conformance suite on the WebSocket harness, plus checks only a web transport has.

#![cfg(feature = "ws")]

use std::time::Duration;

use ambidex::Code;
use ambidex_axum::EndReason;
use ambidex_conformance::Harness;
use ambidex_conformance::harness::run;
use ambidex_conformance::ws::{HOST, ORIGIN, Ws};
use serde_json::json;

ambidex_conformance::conformance_suite!(Ws);

/// Host, Origin and session cookie are checked before the engine sees a byte (spec §8, §9).
#[test]
fn rejected_upgrades_never_reach_the_engine() {
    run(async |ws: &Ws| {
        let (cookie, _) = ws.issue();
        let host = ws.upgrade("evil.test", Some(ORIGIN), Some(&cookie)).await;
        assert_eq!(host.err(), Some(421));
        for origin in [
            None,
            Some("https://evil.test"),
            Some("http://conformance.test"),
        ] {
            let status = ws.upgrade(HOST, origin, Some(&cookie)).await;
            assert_eq!(status.err(), Some(403), "{origin:?}");
        }
        for cookie in [None, Some("forged")] {
            let status = ws.upgrade(HOST, Some(ORIGIN), cookie).await;
            assert_eq!(status.err(), Some(401), "{cookie:?}");
        }
        assert_eq!(ws.fixture().probe.runs(), 0);
    });
}

/// The web session's anti-CSRF token must be in Hello (spec §8).
#[test]
fn hello_needs_the_session_csrf_token() {
    run(async |ws: &Ws| {
        let (cookie, _) = ws.issue();
        let (_, other_csrf) = ws.issue();
        let socket = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.unwrap();
        let mut client = Ws::client(socket, &other_csrf);
        client.hello().await;
        client.expect_fatal(Code::Unauthenticated).await;
    });
}

/// Revoking one web session ends its connections with Goaway and refuses new upgrades; other
/// sessions' connections stay open (DOC-25 §3.2.4).
#[test]
fn a_revoked_session_ends_its_connections_only() {
    run(async |ws: &Ws| {
        let (cookie, csrf) = ws.issue();
        let (other_cookie, other_csrf) = ws.issue();
        let socket = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.unwrap();
        let mut client = Ws::client(socket, &csrf);
        client.handshake().await;
        let other = ws
            .upgrade(HOST, Some(ORIGIN), Some(&other_cookie))
            .await
            .unwrap();
        let mut other = Ws::client(other, &other_csrf);
        other.handshake().await;
        let id = ws.sessions().peek(&cookie).unwrap().id;
        assert!(
            ws.sessions()
                .end(&id, EndReason::Revoked, Some("human:oidc:admin"))
        );
        let goaway = client.expect_goaway().await;
        assert_eq!(goaway.code, Code::Unauthenticated);
        client.expect_closed().await;
        let status = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await;
        assert_eq!(status.err(), Some(401));
        other.call(1, "fixture.echo", json!(1)).await;
        other.expect_result(1).await;
    });
}

/// Calls a client starts are activity; a session idle past the limit, or older than the absolute
/// limit, ends and its connection gets Goaway (DOC-25 §3.2.4).
#[test]
fn idle_and_absolute_limits_end_open_connections() {
    run(async |ws: &Ws| {
        let limits = ws.sessions().limits();
        let clock = &ws.fixture().clock;
        let (cookie, csrf) = ws.issue();
        let socket = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.unwrap();
        let mut client = Ws::client(socket, &csrf);
        client.handshake().await;
        // Activity just before each idle limit keeps it alive up to the absolute limit.
        let step = limits.idle - Duration::from_secs(1);
        let mut lived = Duration::ZERO;
        let mut call = 1;
        while lived + step < limits.absolute {
            clock.advance(step);
            lived += step;
            assert_eq!(ws.sessions().sweep(), 0);
            client.call(call, "fixture.echo", json!(call)).await;
            client.expect_result(call).await;
            call += 1;
        }
        clock.advance(limits.absolute - lived);
        assert_eq!(ws.sessions().sweep(), 1);
        assert_eq!(client.expect_goaway().await.code, Code::Unauthenticated);
        client.expect_closed().await;

        // Idle: no call for the whole idle limit.
        let (cookie, csrf) = ws.issue();
        let socket = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.unwrap();
        let mut client = Ws::client(socket, &csrf);
        client.handshake().await;
        clock.advance(limits.idle - Duration::from_millis(1));
        assert_eq!(ws.sessions().sweep(), 0);
        clock.advance(Duration::from_millis(1));
        assert_eq!(ws.sessions().sweep(), 1);
        assert_eq!(client.expect_goaway().await.code, Code::Unauthenticated);
        assert_eq!(
            ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.err(),
            Some(401)
        );
    });
}
