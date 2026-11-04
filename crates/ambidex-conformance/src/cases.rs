//! The conformance cases, each written once and run on every [`Harness`].
//!
//! Expectations come from the Ambidex spec (§3 wire protocol, §5 call kinds, §7 cancellation and
//! deadlines, §8 authorization and audit, §10 errors) and the decisions recorded in its Open
//! questions 14–16, 21, 23 and 24 (subscriptions, and their deadlines in 24f). Cases assert
//! outcomes, not timing: where a race is allowed by the spec, every allowed outcome is accepted
//! and checked.
//!
//! Deadlines are measured on the fixture's [`ManualClock`](crate::ManualClock), which only moves
//! when a case calls [`advance`]. A case therefore waits until the handler started before moving
//! it, and can check a call one millisecond before and exactly at its deadline, minutes or hours
//! after it started, without waiting.

use std::collections::BTreeMap;
use std::time::Duration;

use ambidex::frame::{Flags, Frame, HEADER_LEN, Kind};
use ambidex::procedure::{DEFAULT_TIMEOUT, DEFAULT_TIMEOUT_MAX};
use ambidex::security_types::{AuditDecision, Outcome, Reason};
use ambidex::{Code, Goaway, input_digest};
use serde_json::{Value, json};

use crate::client::{
    Client, call_frame, cancel_frame, encode, json_frame, subscribe_frame, unsubscribe_frame,
};
use crate::fixture::{
    APPROVAL_ID, CANCEL_GRACE, CAPPED_TIMEOUT_MAX, Event, MAX_CONCURRENT_CALLS, MAX_FRAME_BYTES,
    SCHEMA_HASH, SERVER_VERSION, SUBSCRIPTION_BUFFER_EVENTS, TICKS_CAPPED_TIMEOUT_MAX,
};
use crate::harness::Harness;

async fn ready<H: Harness>(h: &H) -> Client {
    let mut client = h.connect().await;
    client.handshake().await;
    client
}

/// A valid header-only Ping, for corrupting single header fields.
fn ping_bytes() -> Vec<u8> {
    encode(&Frame::new(Kind::Ping, 0, Vec::new()))
}

/// Collects one terminal frame for each of `ids`, in whatever order they arrive.
async fn terminal_frames(client: &mut Client, ids: &[u32]) -> BTreeMap<u32, Frame> {
    let mut frames = BTreeMap::new();
    while frames.len() < ids.len() {
        let frame = client.recv().await.expect("terminal frame, got close");
        assert!(
            matches!(frame.kind, Kind::Result | Kind::Error) && ids.contains(&frame.call_id),
            "{frame:?}"
        );
        assert!(frames.insert(frame.call_id, frame).is_none(), "two answers");
    }
    frames
}

fn error_code(frame: &Frame) -> Code {
    assert_eq!(frame.kind, Kind::Error, "{frame:?}");
    serde_json::from_slice::<ambidex::ErrorPayload>(&frame.payload)
        .expect("Error payload")
        .code
}

/// Moves the fixture's deadline clock forward by `ms`.
fn advance<H: Harness>(h: &H, ms: u64) {
    h.fixture().clock.advance(Duration::from_millis(ms));
}

fn millis(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).expect("fits")
}

const HOUR_MS: u64 = 3_600_000;

/// After a call was cancelled before or while running: either the handler never started, or it
/// started, saw its token and returned within the grace period.
async fn assert_never_started_or_saw_cancel<H: Harness>(h: &H, name: &'static str) {
    let events = h.fixture().probe.pending().await;
    let allowed = [vec![], vec![Event::Started(name), Event::Cancelled(name)]];
    assert!(allowed.contains(&events), "{}: {events:?}", H::NAME);
}

// ---- handshake (§3) ------------------------------------------------------------------------

pub async fn handshake_returns_ack_with_limits<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    let ack = client.handshake().await;
    assert!(!ack.session.is_empty());
    assert_eq!(ack.server_version, SERVER_VERSION);
    assert_eq!(ack.limits.max_frame_bytes, MAX_FRAME_BYTES);
    assert_eq!(ack.limits.max_concurrent_calls, MAX_CONCURRENT_CALLS);
    // Spec Open question 23b: the client sizes its safety slack from it.
    let grace_ms = u64::try_from(CANCEL_GRACE.as_millis()).unwrap();
    assert_eq!(ack.limits.cancel_grace_ms, Some(grace_ms));
}

pub async fn version_mismatch_is_rejected<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    let mut hello = client.hello_frame();
    let mut value: Value = serde_json::from_slice(&hello.payload).unwrap();
    value["schema_hash"] = json!(format!("{}-stale", *SCHEMA_HASH));
    hello.payload = serde_json::to_vec(&value).unwrap();
    client.send(&[hello]).await;
    client.expect_fatal(Code::VersionMismatch).await;
}

pub async fn first_frame_must_be_hello<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    client.call(1, "fixture.echo", json!(1)).await;
    client.expect_fatal(Code::Unauthenticated).await;
    assert_eq!(h.fixture().probe.runs(), 0);
}

pub async fn duplicate_hello_is_rejected<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.hello().await;
    client.expect_fatal(Code::FailedPrecondition).await;
}

// ---- frame codec (§3, Open question 14) ----------------------------------------------------

pub async fn bad_header_version_is_fatal<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let mut bytes = ping_bytes();
    bytes[0] = 2;
    client.send_bytes(bytes).await;
    client.expect_fatal(Code::VersionMismatch).await;
}

pub async fn unknown_kind_is_fatal<H: Harness>(h: &H) {
    for kind in [0u8, 16, 255] {
        let mut client = ready(h).await;
        let mut bytes = ping_bytes();
        bytes[1] = kind;
        client.send_bytes(bytes).await;
        client.expect_fatal(Code::InvalidArgument).await;
    }
}

pub async fn reserved_flags_are_fatal<H: Harness>(h: &H) {
    // Bit 1 is `compressed` (reserved), bit 15 is unassigned.
    for flags in [Flags::COMPRESSED.bits(), 1 << 15] {
        let mut client = ready(h).await;
        let mut bytes = ping_bytes();
        bytes[2..4].copy_from_slice(&flags.to_le_bytes());
        client.send_bytes(bytes).await;
        client.expect_fatal(Code::InvalidArgument).await;
    }
}

pub async fn oversize_payload_is_fatal<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // Only the header: the declared length alone must be refused, before any payload arrives.
    let mut bytes = ping_bytes();
    bytes[8..12].copy_from_slice(&(MAX_FRAME_BYTES + 1).to_le_bytes());
    assert_eq!(bytes.len(), HEADER_LEN);
    client.send_bytes(bytes).await;
    client.expect_fatal(Code::ResourceExhausted).await;
}

pub async fn server_only_kind_from_client_is_fatal<H: Harness>(h: &H) {
    for kind in [
        Kind::HelloAck,
        Kind::Result,
        Kind::Error,
        Kind::Chunk,
        Kind::StreamEnd,
        Kind::Event,
    ] {
        let mut client = ready(h).await;
        client.send(&[json_frame(kind, 1, &json!({}))]).await;
        client.expect_fatal(Code::InvalidArgument).await;
    }
}

pub async fn frames_split_and_coalesced_across_chunks<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    let mut bytes = encode(&client.hello_frame());
    bytes.extend(encode(&call_frame(1, "fixture.echo", json!("one"), None)));
    bytes.extend(encode(&call_frame(2, "fixture.echo", json!("two"), None)));
    // Cuts inside the Hello header, inside a payload, and inside the last header.
    let cuts = [5, HEADER_LEN + 9, bytes.len() - 30, bytes.len()];
    let mut start = 0;
    for cut in cuts {
        client.send_bytes(bytes[start..cut].to_vec()).await;
        start = cut;
    }
    let ack = client.recv().await.expect("HelloAck");
    assert_eq!(ack.kind, Kind::HelloAck);
    let frames = terminal_frames(&mut client, &[1, 2]).await;
    assert_eq!(frames[&1].payload, br#""one""#);
    assert_eq!(frames[&2].payload, br#""two""#);
}

pub async fn ping_is_answered_with_pong<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.expect_alive(0).await;
    // Pings do not use up call ids.
    client.expect_alive(7).await;
    client.call(1, "fixture.echo", json!(null)).await;
    client.expect_result(1).await;
}

// ---- dispatch and errors (§5, §10) ---------------------------------------------------------

pub async fn unary_call_round_trip<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let input = json!({ "nested": [1, "two", { "three": 3.5 }], "unicode": "Ambidex ✓" });
    client.call(1, "fixture.echo", input.clone()).await;
    assert_eq!(client.expect_result(1).await, input);
}

pub async fn concurrent_calls_answer_by_call_id<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // A call that never finishes on its own must not hold back the ones after it.
    client
        .send(&[
            call_frame(1, "fixture.wait", json!(null), None),
            call_frame(2, "fixture.echo", json!(2), None),
            call_frame(3, "fixture.echo", json!(3), None),
        ])
        .await;
    let frames = terminal_frames(&mut client, &[2, 3]).await;
    assert_eq!(frames[&2].payload, b"2");
    assert_eq!(frames[&3].payload, b"3");
    client.cancel(1).await;
    client.expect_code(1, Code::Cancelled).await;
}

pub async fn principal_comes_from_the_transport<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    // Claims in Hello.auth beyond what the transport's authentication reads are ignored.
    let mut hello = client.hello_frame();
    let mut value: Value = serde_json::from_slice(&hello.payload).unwrap();
    let auth = value
        .get_mut("auth")
        .filter(|auth| auth.is_object())
        .map(std::mem::take)
        .unwrap_or_else(|| json!({}));
    let mut auth = auth;
    auth["principal"] = json!("human:oidc:root");
    auth["roles"] = json!(["admin"]);
    value["auth"] = auth;
    hello.payload = serde_json::to_vec(&value).unwrap();
    client.send(&[hello]).await;
    let ack = client.recv().await.expect("HelloAck");
    assert_eq!(ack.kind, Kind::HelloAck, "{ack:?}");
    let ack: ambidex::HelloAck = serde_json::from_slice(&ack.payload).unwrap();

    client
        .call(
            1,
            "fixture.whoami",
            json!({ "principal": "human:oidc:root" }),
        )
        .await;
    let who = client.expect_result(1).await;
    assert_eq!(who["principal"], h.principal_id());
    assert_eq!(who["session"], ack.session);
}

pub async fn typed_domain_error_travels_as_details<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let codes = [
        Code::Cancelled,
        Code::DeadlineExceeded,
        Code::Unauthenticated,
        Code::PermissionDenied,
        Code::ApprovalRequired,
        Code::InvalidArgument,
        Code::NotFound,
        Code::FailedPrecondition,
        Code::ResourceExhausted,
        Code::Unavailable,
        Code::Unimplemented,
        Code::VersionMismatch,
    ];
    for (call_id, code) in (1..).zip(codes) {
        let retryable = call_id % 2 == 0;
        let input = json!({ "code": code, "retryable": retryable });
        client.call(call_id, "fixture.fail", input).await;
        let err = client.expect_code(call_id, code).await;
        assert_eq!(err.message, format!("requested {code:?}"));
        assert_eq!(err.retryable, retryable);
        assert_eq!(
            err.details,
            Some(json!({ "kind": "Requested", "code": code, "retryable": retryable }))
        );
        assert!(!err.correlation_id.is_empty());
    }
    // The connection stays usable after any number of call errors.
    client.expect_alive(0).await;
}

pub async fn internal_errors_are_scrubbed<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.leak", json!(null)).await;
    client
        .call(2, "fixture.fail", json!({ "code": "Internal" }))
        .await;
    // Answers to concurrent calls may arrive in any order.
    for frame in terminal_frames(&mut client, &[1, 2]).await.values() {
        assert_eq!(frame.kind, Kind::Error, "{frame:?}");
        let err: ambidex::ErrorPayload = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(err.code, Code::Internal);
        assert_eq!(err.message, "internal error");
        assert_eq!(err.details, None);
        assert!(!err.correlation_id.is_empty());
    }
}

pub async fn unknown_procedure_is_not_found<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    for (call_id, name) in [(1, "fixture.missing"), (2, "missing"), (3, "")] {
        client.call(call_id, name, json!(null)).await;
        client.expect_code(call_id, Code::NotFound).await;
    }
}

pub async fn invalid_input_is_invalid_argument<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .call(1, "fixture.fail", json!({ "code": "NoSuchCode" }))
        .await;
    let err = client.expect_code(1, Code::InvalidArgument).await;
    // serde's message could quote the input, so it never reaches the client.
    assert_eq!(err.message, "invalid input");
}

pub async fn malformed_call_payload_keeps_connection<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .send(&[Frame::new(Kind::Call, 1, b"{not json".to_vec())])
        .await;
    client.expect_code(1, Code::InvalidArgument).await;
    client
        .send(&[json_frame(Kind::Call, 2, &json!({ "input": 1 }))])
        .await;
    client.expect_code(2, Code::InvalidArgument).await;
    client.expect_alive(0).await;
    client.call(3, "fixture.echo", json!(3)).await;
    client.expect_result(3).await;
}

pub async fn binary_call_payload_keeps_connection<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let call = call_frame(1, "fixture.echo", json!(1), None);
    client
        .send(&[Frame::binary(Kind::Call, 1, call.payload)])
        .await;
    client.expect_code(1, Code::InvalidArgument).await;
    assert_eq!(h.fixture().probe.runs(), 0);
    client.expect_alive(0).await;
}

pub async fn oversize_result_is_resource_exhausted<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .call(1, "fixture.big", json!(MAX_FRAME_BYTES as usize + 1))
        .await;
    client.expect_code(1, Code::ResourceExhausted).await;
    // A result that fits is sent; the JSON string adds two quotes.
    client
        .call(2, "fixture.big", json!(MAX_FRAME_BYTES as usize - 2))
        .await;
    let value = client.expect_result(2).await;
    assert_eq!(
        value.as_str().map(str::len),
        Some(MAX_FRAME_BYTES as usize - 2)
    );
}

// ---- authorization (§8) --------------------------------------------------------------------

pub async fn permission_denied_never_runs_handler<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // `protected` and `fail` share an input type. This input fails to decode, as the allowed
    // `fail` shows, yet `protected` answers PermissionDenied: authorization runs before input
    // decoding, so a denied caller learns nothing about input validity.
    let undecodable = json!([1, 2, 3]);
    client.call(1, "fixture.fail", undecodable.clone()).await;
    client.expect_code(1, Code::InvalidArgument).await;
    client.call(2, "fixture.protected", undecodable).await;
    client.expect_code(2, Code::PermissionDenied).await;
    client
        .call(3, "fixture.protected", json!({ "code": "NotFound" }))
        .await;
    let err = client.expect_code(3, Code::PermissionDenied).await;
    // The deny reason stays on the server.
    assert_eq!(err.message, "permission denied");
    assert_eq!(err.details, None);
    assert_eq!(h.fixture().probe.runs(), 0);
    // Both refusals are audited, with the reason the client never saw.
    let entries = h.fixture().audit.entries();
    assert_eq!(entries.len(), 2, "{entries:?}");
    assert!(entries.iter().all(|e| e.action.name == "fixture.protected"
        && matches!(e.decision, AuditDecision::Deny { .. })
        && e.outcome
            == Outcome::Error {
                code: "PermissionDenied".into()
            }));
    assert_eq!(entries[1].correlation_id, err.correlation_id);
}

pub async fn approval_required_carries_approval_id<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.approval", json!({ "a": 1 })).await;
    let err = client.expect_code(1, Code::ApprovalRequired).await;
    assert_eq!(err.details, Some(json!({ "approval_id": APPROVAL_ID })));
    assert_eq!(h.fixture().probe.runs(), 0);
}

pub async fn in_handler_escalation_requires_approval<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.escalate", json!(null)).await;
    let err = client.expect_code(1, Code::ApprovalRequired).await;
    assert_eq!(err.details, Some(json!({ "approval_id": APPROVAL_ID })));
    h.fixture().probe.expect(Event::Started("escalate")).await;
}

// ---- call ids (Open question 15) -----------------------------------------------------------

pub async fn call_ids_may_skip_but_must_increase<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    for call_id in [1, 5, 1000, u32::MAX] {
        client.call(call_id, "fixture.echo", json!(call_id)).await;
        assert_eq!(client.expect_result(call_id).await, json!(call_id));
    }
}

pub async fn reused_call_id_is_fatal<H: Harness>(h: &H) {
    // Reusing a finished call's id, or going back below it, closes the connection.
    for call_id in [2, 1] {
        let mut client = ready(h).await;
        client.call(2, "fixture.echo", json!(null)).await;
        client.expect_result(2).await;
        client.call(call_id, "fixture.echo", json!(null)).await;
        client.expect_fatal(Code::InvalidArgument).await;
    }
}

pub async fn call_id_zero_is_fatal<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(0, "fixture.echo", json!(null)).await;
    client.expect_fatal(Code::InvalidArgument).await;
    assert_eq!(h.fixture().probe.runs(), 0);
}

pub async fn subscribe_must_also_increase_call_id<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(3, "fixture.counter", counter(0, "finish"))
        .await;
    assert_eq!(client.expect_result(3).await, Value::Null);
    client.call(3, "fixture.echo", json!(null)).await;
    client.expect_fatal(Code::InvalidArgument).await;
}

pub async fn concurrency_limit_is_retryable<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let limit = MAX_CONCURRENT_CALLS;
    let frames: Vec<_> = (1..=limit + 1)
        .map(|id| call_frame(id, "fixture.wait", json!(null), None))
        .collect();
    client.send(&frames).await;
    let err = client.expect_code(limit + 1, Code::ResourceExhausted).await;
    assert!(err.retryable);
    let cancels: Vec<_> = (1..=limit).map(cancel_frame).collect();
    client.send(&cancels).await;
    let ids: Vec<_> = (1..=limit).collect();
    for frame in terminal_frames(&mut client, &ids).await.values() {
        assert_eq!(error_code(frame), Code::Cancelled);
    }
    // Finished calls free their slots.
    client.call(limit + 2, "fixture.echo", json!(null)).await;
    client.expect_result(limit + 2).await;
}

// ---- deadlines (§7, Open question 21) ------------------------------------------------------

pub async fn zero_timeout_never_runs_handler<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .call_with_timeout(1, "fixture.wait", json!(null), 0)
        .await;
    client.expect_code(1, Code::DeadlineExceeded).await;
    assert_eq!(h.fixture().probe.runs(), 0);
    client.expect_alive(0).await;
}

pub async fn deadline_cancels_running_handler<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .call_with_timeout(1, "fixture.wait", json!(null), 200)
        .await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("wait")).await;
    advance(h, 200);
    client.expect_code(1, Code::DeadlineExceeded).await;
    probe.expect(Event::Cancelled("wait")).await;
    client.expect_alive(0).await;
}

pub async fn procedure_timeout_max_caps_client_timeout<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // An hour requested, 50 ms allowed by the procedure: the procedure wins.
    client
        .call_with_timeout(1, "fixture.capped", json!(null), HOUR_MS)
        .await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("capped")).await;
    advance(h, millis(CAPPED_TIMEOUT_MAX));
    client.expect_code(1, Code::DeadlineExceeded).await;
    probe.expect(Event::Cancelled("capped")).await;
}

/// Calls keep their 30 s default deadline (spec Open question 24f changes subscriptions only): a
/// call still running 1 ms before it is answered, one running at it gets `DeadlineExceeded`.
pub async fn calls_keep_the_default_deadline<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let default = millis(DEFAULT_TIMEOUT);
    // `fixture.sleep` answers once the clock moved that far; the engine checks the deadline when
    // it accepts the answer.
    client.call(1, "fixture.sleep", json!(default - 1)).await;
    client.call(2, "fixture.sleep", json!(default)).await;
    let started = Event::Started("sleep");
    h.fixture()
        .probe
        .expect_all(&[started.clone(), started])
        .await;
    advance(h, default - 1);
    assert_eq!(client.expect_result(1).await, json!(default - 1));
    advance(h, 1);
    client.expect_code(2, Code::DeadlineExceeded).await;
    client.expect_alive(0).await;
}

/// Calls keep the 5 min cap on a client timeout: an hour requested, 5 min granted.
pub async fn calls_keep_the_timeout_cap<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let max = millis(DEFAULT_TIMEOUT_MAX);
    client
        .call_with_timeout(1, "fixture.sleep", json!(max - 1), HOUR_MS)
        .await;
    client
        .call_with_timeout(2, "fixture.sleep", json!(max), HOUR_MS)
        .await;
    let started = Event::Started("sleep");
    h.fixture()
        .probe
        .expect_all(&[started.clone(), started])
        .await;
    advance(h, max - 1);
    assert_eq!(client.expect_result(1).await, json!(max - 1));
    advance(h, 1);
    client.expect_code(2, Code::DeadlineExceeded).await;
    client.expect_alive(0).await;
}

// ---- cancellation (§7) ---------------------------------------------------------------------

pub async fn cancel_reaches_running_handler<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.wait", json!(null)).await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("wait")).await;
    client.cancel(1).await;
    // The handler returned a value after seeing its token; the client still gets Cancelled.
    client.expect_code(1, Code::Cancelled).await;
    probe.expect(Event::Cancelled("wait")).await;
    client.expect_alive(0).await;
}

pub async fn cancel_in_same_chunk_as_call_wins<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .send(&[
            call_frame(1, "fixture.wait", json!(null), None),
            cancel_frame(1),
        ])
        .await;
    client.expect_code(1, Code::Cancelled).await;
    assert_never_started_or_saw_cancel(h, "wait").await;
    client.expect_alive(0).await;
}

pub async fn cancel_after_result_is_ignored<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.echo", json!(1)).await;
    client.expect_result(1).await;
    // The Result already sent wins; the late Cancel produces nothing.
    client.cancel(1).await;
    client.expect_alive(0).await;
}

pub async fn cancel_for_unknown_call_is_ignored<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.cancel(99).await;
    client.expect_alive(0).await;
    // A Cancel does not claim its id.
    client.call(2, "fixture.echo", json!(2)).await;
    client.expect_result(2).await;
}

pub async fn cancel_on_call_zero_is_fatal<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.cancel(0).await;
    client.expect_fatal(Code::InvalidArgument).await;
}

pub async fn stubborn_handler_is_dropped_after_grace<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.stubborn", json!(null)).await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("stubborn")).await;
    client.cancel(1).await;
    client.expect_code(1, Code::Cancelled).await;
    // The future is dropped before the answer is sent.
    probe.expect(Event::Dropped("stubborn")).await;
    client.expect_alive(0).await;
}

// ---- connection lifecycle ------------------------------------------------------------------

pub async fn disconnect_cancels_calls<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.wait", json!(null)).await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("wait")).await;
    client.disconnect().await;
    probe.expect(Event::Cancelled("wait")).await;
}

pub async fn client_goaway_closes_and_cancels_calls<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.wait", json!(null)).await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("wait")).await;
    let goaway = Goaway {
        code: Code::Unavailable,
        message: "tab closing".into(),
    };
    client.send(&[json_frame(Kind::Goaway, 0, &goaway)]).await;
    // No reply to a peer's Goaway, and the cancelled call's answer is discarded.
    client.expect_closed().await;
    probe.expect(Event::Cancelled("wait")).await;
}

pub async fn session_revocation_sends_goaway_and_cancels_calls<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.wait", json!(null)).await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("wait")).await;
    if let Err(reason) = h.revoke_sessions() {
        eprintln!("{}: session revocation not applicable: {reason}", H::NAME);
        client.cancel(1).await;
        client.expect_code(1, Code::Cancelled).await;
        return;
    }
    // Goaway is the only frame: no per-call errors (spec Open question 21d).
    let goaway = client.expect_goaway().await;
    assert_eq!(goaway.code, Code::Unauthenticated);
    assert_eq!(goaway.message, "session revoked");
    client.expect_closed().await;
    probe.expect(Event::Cancelled("wait")).await;
}

pub async fn connections_are_independent<H: Harness>(h: &H) {
    let mut a = ready(h).await;
    let mut b = ready(h).await;
    a.call(1, "fixture.wait", json!(null)).await;
    h.fixture().probe.expect(Event::Started("wait")).await;
    // Call ids are per connection: b may use 1 while a's call 1 runs.
    b.call(1, "fixture.echo", json!("b")).await;
    assert_eq!(b.expect_result(1).await, json!("b"));
    // A violation closes b only.
    b.call(1, "fixture.echo", json!(null)).await;
    b.expect_fatal(Code::InvalidArgument).await;
    a.expect_alive(0).await;
    a.cancel(1).await;
    a.expect_code(1, Code::Cancelled).await;
}

// ---- subscriptions (§5, Open questions 21 and 23) -------------------------------------------

/// Input of `fixture.counter`: events 0..count, then `then` (finish, fail, wait, hang).
fn counter(count: u64, then: &str) -> Value {
    json!({ "count": count, "then": then })
}

/// The next frames must be the events 0..`count` of subscription `call_id`, in order.
async fn expect_counter(client: &mut Client, call_id: u32, count: u64) {
    for n in 0..count {
        assert_eq!(client.expect_event(call_id).await, json!(n));
    }
}

pub async fn subscription_events_arrive_in_order_then_result<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(5, "finish"))
        .await;
    expect_counter(&mut client, 1, 5).await;
    // A normal end: Result with payload null, exactly once.
    assert_eq!(client.expect_result(1).await, Value::Null);
    client.expect_alive(0).await;
}

pub async fn subscription_ends_with_server_error<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(2, "fail"))
        .await;
    expect_counter(&mut client, 1, 2).await;
    let err = client.expect_code(1, Code::FailedPrecondition).await;
    assert_eq!(
        err.details,
        Some(json!({ "kind": "Requested", "code": "FailedPrecondition", "retryable": false }))
    );
    assert!(!err.correlation_id.is_empty());
    client.expect_alive(0).await;
}

pub async fn nothing_is_sent_after_unsubscribe<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let count = SUBSCRIPTION_BUFFER_EVENTS as u64;
    client
        .subscribe(1, "fixture.counter", counter(count, "wait"))
        .await;
    assert_eq!(client.expect_event(1).await, json!(0));
    // Unsubscribe and a Ping in one chunk. Events the server sent before it read them may still
    // be in flight; after the Pong nothing more may come for id 1.
    let ping = Frame::new(Kind::Ping, 1, b"after".to_vec());
    client.send(&[unsubscribe_frame(1), ping]).await;
    let mut next = 1;
    loop {
        let frame = client.recv().await.expect("Pong, got close");
        if frame.kind == Kind::Pong {
            assert_eq!(frame.call_id, 1, "{frame:?}");
            break;
        }
        assert_eq!((frame.kind, frame.call_id), (Kind::Event, 1), "{frame:?}");
        assert_eq!(frame.payload, next.to_string().into_bytes(), "in order");
        next += 1;
    }
    // The handler was cancelled and returned Ok; that end is not sent either.
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    probe.expect(Event::Cancelled("counter")).await;
    client.expect_alive(2).await;
    client.call(2, "fixture.echo", json!(2)).await;
    assert_eq!(client.expect_result(2).await, json!(2));
}

pub async fn unsubscribed_handler_gets_cancel_grace<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(1, "hang"))
        .await;
    assert_eq!(client.expect_event(1).await, json!(0));
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    client.unsubscribe(1).await;
    // The handler ignores its token: its future is dropped after the grace period, silently.
    probe.expect(Event::Dropped("counter")).await;
    client.expect_alive(0).await;
    client.call(2, "fixture.echo", json!(2)).await;
    assert_eq!(client.expect_result(2).await, json!(2));
}

pub async fn unsubscribe_for_unknown_or_ended_id_is_ignored<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.unsubscribe(99).await;
    client.expect_alive(0).await;
    client
        .subscribe(100, "fixture.counter", counter(1, "finish"))
        .await;
    expect_counter(&mut client, 100, 1).await;
    client.expect_result(100).await;
    client.unsubscribe(100).await;
    client.expect_alive(0).await;
}

pub async fn unsubscribe_on_call_zero_is_fatal<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.unsubscribe(0).await;
    client.expect_fatal(Code::InvalidArgument).await;
}

pub async fn cancel_ends_subscription_and_reaches_handler<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(1, "wait"))
        .await;
    assert_eq!(client.expect_event(1).await, json!(0));
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    client.cancel(1).await;
    // The handler returned Ok after seeing its token; the client still gets Cancelled, once.
    client.expect_code(1, Code::Cancelled).await;
    probe.expect(Event::Cancelled("counter")).await;
    client.expect_alive(0).await;
}

pub async fn stubborn_subscription_is_dropped_after_grace<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(0, "hang"))
        .await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    client.cancel(1).await;
    client.expect_code(1, Code::Cancelled).await;
    probe.expect(Event::Dropped("counter")).await;
    client.expect_alive(0).await;
}

pub async fn deadline_ends_subscription<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe_with_timeout(1, "fixture.counter", counter(0, "wait"), 200)
        .await;
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    advance(h, 200);
    client.expect_code(1, Code::DeadlineExceeded).await;
    probe.expect(Event::Cancelled("counter")).await;
    // Already expired: the handler never runs.
    let runs = h.fixture().probe.runs();
    client
        .subscribe_with_timeout(2, "fixture.counter", counter(3, "finish"), 0)
        .await;
    client.expect_code(2, Code::DeadlineExceeded).await;
    assert_eq!(h.fixture().probe.runs(), runs);
    client.expect_alive(0).await;
}

// ---- subscription deadlines (§7, Open question 24f) -----------------------------------------

/// One `Event` for each of `ids`, in whatever order they arrive.
async fn one_event_each(client: &mut Client, ids: &[u32]) -> BTreeMap<u32, Value> {
    let mut events = BTreeMap::new();
    while events.len() < ids.len() {
        let frame = client.recv().await.expect("event, got close");
        assert!(
            frame.kind == Kind::Event && ids.contains(&frame.call_id),
            "{frame:?}"
        );
        let event = serde_json::from_slice(&frame.payload).expect("JSON event");
        assert!(events.insert(frame.call_id, event).is_none(), "two events");
    }
    events
}

/// Without `timeout_ms` and without a declared maximum a subscription has no deadline: it still
/// runs past the call default (30 s) and an hour later, far past the call cap (5 min), until the
/// client ends it.
pub async fn subscription_without_timeout_has_no_deadline<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // `fixture.ticks` sends the time since it started each time the clock moves; the engine
    // checks the deadline when it queues each event, so a deadline at or before that time would
    // end the subscription instead.
    client.subscribe(1, "fixture.ticks", json!(null)).await;
    h.fixture().probe.expect(Event::Started("ticks")).await;
    let default = millis(DEFAULT_TIMEOUT);
    advance(h, default);
    assert_eq!(client.expect_event(1).await, json!(default));
    advance(h, HOUR_MS - default);
    assert_eq!(client.expect_event(1).await, json!(HOUR_MS));
    client.cancel(1).await;
    client.expect_code(1, Code::Cancelled).await;
    client.expect_alive(0).await;
}

/// A client `timeout_ms` still ends a subscription with `DeadlineExceeded` at exactly that time,
/// here twice the call cap, which no longer applies.
pub async fn subscription_ends_at_its_client_timeout<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let timeout = 2 * millis(DEFAULT_TIMEOUT_MAX);
    client
        .subscribe_with_timeout(1, "fixture.ticks", json!(null), timeout)
        .await;
    h.fixture().probe.expect(Event::Started("ticks")).await;
    advance(h, timeout - 1);
    assert_eq!(client.expect_event(1).await, json!(timeout - 1));
    advance(h, 1);
    client.expect_code(1, Code::DeadlineExceeded).await;
    client.expect_alive(0).await;
}

/// A procedure-declared maximum caps a larger `timeout_ms`, and bounds a subscription that sent
/// none.
pub async fn declared_maximum_caps_a_subscription<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let max = millis(TICKS_CAPPED_TIMEOUT_MAX);
    client
        .subscribe_with_timeout(1, "fixture.ticks_capped", json!(null), HOUR_MS)
        .await;
    client
        .subscribe(2, "fixture.ticks_capped", json!(null))
        .await;
    let started = Event::Started("ticks_capped");
    h.fixture()
        .probe
        .expect_all(&[started.clone(), started])
        .await;
    advance(h, max - 1);
    let ticks = one_event_each(&mut client, &[1, 2]).await;
    assert_eq!(
        ticks,
        BTreeMap::from([(1, json!(max - 1)), (2, json!(max - 1))])
    );
    advance(h, 1);
    for (id, frame) in terminal_frames(&mut client, &[1, 2]).await {
        assert_eq!(
            error_code(&frame),
            Code::DeadlineExceeded,
            "subscription {id}"
        );
    }
    client.expect_alive(0).await;
}

pub async fn disconnect_cancels_subscriptions<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(1, "wait"))
        .await;
    assert_eq!(client.expect_event(1).await, json!(0));
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("counter")).await;
    client.disconnect().await;
    probe.expect(Event::Cancelled("counter")).await;
}

pub async fn session_revocation_ends_subscriptions_with_goaway<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(1, "wait"))
        .await;
    assert_eq!(client.expect_event(1).await, json!(0));
    client.call(2, "fixture.wait", json!(null)).await;
    let probe = &h.fixture().probe;
    // The counter started before it sent event 0, so before the call was sent.
    probe.expect(Event::Started("counter")).await;
    probe.expect(Event::Started("wait")).await;
    if let Err(reason) = h.revoke_sessions() {
        eprintln!("{}: session revocation not applicable: {reason}", H::NAME);
        client.send(&[cancel_frame(1), cancel_frame(2)]).await;
        for frame in terminal_frames(&mut client, &[1, 2]).await.values() {
            assert_eq!(error_code(frame), Code::Cancelled);
        }
        return;
    }
    // Goaway is the only frame: no Error for the subscription or the call (Open question 21d).
    let goaway = client.expect_goaway().await;
    assert_eq!(goaway.code, Code::Unauthenticated);
    assert_eq!(goaway.message, "session revoked");
    client.expect_closed().await;
    probe
        .expect_all(&[Event::Cancelled("counter"), Event::Cancelled("wait")])
        .await;
}

pub async fn unauthorized_subscribe_is_denied_and_audited<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.subscribe(1, "fixture.secret", json!(null)).await;
    let err = client.expect_code(1, Code::PermissionDenied).await;
    assert_eq!(err.message, "permission denied");
    assert_eq!(err.details, None);
    assert_eq!(h.fixture().probe.runs(), 0, "the handler never ran");
    // The same audit path as calls (spec §8): who, what, why, and the id the client got.
    let entries = h.fixture().audit.entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    let entry = &entries[0];
    assert_eq!(entry.action.name, "fixture.secret");
    assert_eq!(entry.action.perm.as_str(), "fixture.admin");
    assert_eq!(entry.principal_chain[0].id, h.principal_id());
    assert_eq!(
        entry.decision,
        AuditDecision::Deny {
            reason: Reason::UnknownPermission {
                perm: "fixture.admin".into()
            }
        }
    );
    assert_eq!(
        entry.outcome,
        Outcome::Error {
            code: "PermissionDenied".into()
        }
    );
    assert_eq!(entry.approval_id, None);
    assert_eq!(entry.correlation_id, err.correlation_id);
    assert_eq!(entry.input_digest, input_digest(&Value::Null));
    client.expect_alive(0).await;
}

pub async fn call_kind_must_match_frame_kind<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // Refused before authorization: kinds are public in the manifest, like names.
    client.subscribe(1, "fixture.echo", json!(1)).await;
    client.expect_code(1, Code::InvalidArgument).await;
    client.subscribe(2, "fixture.rows", json!(null)).await;
    client.expect_code(2, Code::InvalidArgument).await;
    client
        .call(3, "fixture.counter", counter(1, "finish"))
        .await;
    client.expect_code(3, Code::InvalidArgument).await;
    // A subscription that is not registered is NotFound, as for calls.
    client.subscribe(4, "fixture.missing", json!(null)).await;
    client.expect_code(4, Code::NotFound).await;
    assert_eq!(h.fixture().probe.runs(), 0);
    assert!(h.fixture().audit.entries().is_empty());
    client.expect_alive(0).await;
}

pub async fn subscriptions_count_toward_concurrency_limit<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let limit = MAX_CONCURRENT_CALLS;
    // limit - 1 subscriptions and one call fill the connection's slots.
    let mut frames: Vec<_> = (1..limit)
        .map(|id| subscribe_frame(id, "fixture.counter", counter(0, "wait"), None))
        .collect();
    frames.push(call_frame(limit, "fixture.wait", json!(null), None));
    client.send(&frames).await;
    // One more of either kind is refused, retryably.
    client
        .subscribe(limit + 1, "fixture.counter", counter(0, "wait"))
        .await;
    assert!(
        client
            .expect_code(limit + 1, Code::ResourceExhausted)
            .await
            .retryable
    );
    client.call(limit + 2, "fixture.echo", json!(null)).await;
    assert!(
        client
            .expect_code(limit + 2, Code::ResourceExhausted)
            .await
            .retryable
    );
    let cancels: Vec<_> = (1..=limit).map(cancel_frame).collect();
    client.send(&cancels).await;
    let ids: Vec<_> = (1..=limit).collect();
    for frame in terminal_frames(&mut client, &ids).await.values() {
        assert_eq!(error_code(frame), Code::Cancelled);
    }
    // Ended subscriptions free their slots.
    client
        .subscribe(limit + 3, "fixture.counter", counter(1, "finish"))
        .await;
    expect_counter(&mut client, limit + 3, 1).await;
    client.expect_result(limit + 3).await;
}

pub async fn full_event_buffer_ends_subscription<H: Harness>(h: &H) {
    if let Err(reason) = h.engine_on_case_runtime() {
        eprintln!("{}: exact buffer bound not asserted: {reason}", H::NAME);
        return;
    }
    let mut client = ready(h).await;
    // The handler sends without yielding, so nothing is forwarded meanwhile: the buffer takes
    // exactly SUBSCRIPTION_BUFFER_EVENTS, the next event ends the subscription.
    client.subscribe(1, "fixture.flood", json!(null)).await;
    expect_counter(&mut client, 1, SUBSCRIPTION_BUFFER_EVENTS as u64).await;
    let err = client.expect_code(1, Code::ResourceExhausted).await;
    assert_eq!(err.message, "subscription event buffer is full");
    let probe = &h.fixture().probe;
    probe.expect(Event::Started("flood")).await;
    probe.expect(Event::Cancelled("flood")).await;
    client.expect_alive(0).await;
}

// ---- call kinds without engine support yet (§5) --------------------------------------------

pub async fn streams_are_unimplemented_and_keep_connection<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.rows", json!(null)).await;
    client.expect_code(1, Code::Unimplemented).await;
    // Credits have nothing to credit until streams land (M2).
    client
        .send(&[json_frame(Kind::Credit, 1, &json!({ "chunks": 4 }))])
        .await;
    client.expect_alive(0).await;
}
