//! The conformance suite on the WebSocket harness, plus checks only a web transport has.

#![cfg(feature = "ws")]

use ambidex::Code;
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

/// Until M3, removing a web session refuses new upgrades but cannot revoke open connections.
#[test]
fn removed_session_refuses_new_upgrades() {
    run(async |ws: &Ws| {
        assert!(ws.revoke_sessions().is_err());
        let (cookie, csrf) = ws.issue();
        let socket = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await.unwrap();
        let mut client = Ws::client(socket, &csrf);
        client.handshake().await;
        ws.sessions().remove(&cookie);
        let status = ws.upgrade(HOST, Some(ORIGIN), Some(&cookie)).await;
        assert_eq!(status.err(), Some(401));
        client.call(1, "fixture.echo", json!(1)).await;
        client.expect_result(1).await;
    });
}
