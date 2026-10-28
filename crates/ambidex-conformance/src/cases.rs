//! The conformance cases, each written once and run on every [`Harness`].
//!
//! Expectations come from the Ambidex spec (§3 wire protocol, §5 call kinds, §7 cancellation and
//! deadlines, §8 authorization, §10 errors) and the decisions recorded in its Open questions 14–16
//! and 21. Cases assert outcomes, not timing: where a race is allowed by the spec (a deadline may
//! fire before or after the handler first runs), every allowed outcome is accepted and checked.

use std::collections::BTreeMap;

use ambidex::frame::{Flags, Frame, HEADER_LEN, Kind};
use ambidex::{Code, Goaway};
use serde_json::{Value, json};

use crate::client::{Client, call_frame, cancel_frame, encode, json_frame};
use crate::fixture::{
    APPROVAL_ID, Event, MAX_CONCURRENT_CALLS, MAX_FRAME_BYTES, SCHEMA_HASH, SERVER_VERSION,
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
}

pub async fn version_mismatch_is_rejected<H: Harness>(h: &H) {
    let mut client = h.connect().await;
    let mut hello = client.hello_frame();
    let mut value: Value = serde_json::from_slice(&hello.payload).unwrap();
    value["schema_hash"] = json!(format!("{SCHEMA_HASH}-stale"));
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
    client.call(1, "fixture.protected", json!(null)).await;
    let err = client.expect_code(1, Code::PermissionDenied).await;
    // The deny reason stays on the server.
    assert_eq!(err.message, "permission denied");
    assert_eq!(err.details, None);
    // Authorization runs before input decoding, so invalid input changes nothing.
    client.call(2, "fixture.protected", json!([1, 2, 3])).await;
    client.expect_code(2, Code::PermissionDenied).await;
    assert_eq!(h.fixture().probe.runs(), 0);
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
        .send(&[json_frame(
            Kind::Subscribe,
            3,
            &json!({ "procedure": "fixture.counter", "input": null }),
        )])
        .await;
    client.expect_code(3, Code::Unimplemented).await;
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
    client.expect_code(1, Code::DeadlineExceeded).await;
    assert_never_started_or_saw_cancel(h, "wait").await;
    client.expect_alive(0).await;
}

pub async fn procedure_timeout_max_caps_client_timeout<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    // An hour requested, 50 ms allowed by the procedure: the procedure wins.
    client
        .call_with_timeout(1, "fixture.capped", json!(null), 3_600_000)
        .await;
    client.expect_code(1, Code::DeadlineExceeded).await;
    assert_never_started_or_saw_cancel(h, "capped").await;
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

// ---- call kinds without engine support yet (§5) --------------------------------------------

pub async fn subscriptions_are_unimplemented_and_keep_connection<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let subscribe = json!({ "procedure": "fixture.counter", "input": null });
    client
        .send(&[json_frame(Kind::Subscribe, 1, &subscribe)])
        .await;
    client.expect_code(1, Code::Unimplemented).await;
    client
        .send(&[Frame::new(Kind::Unsubscribe, 1, Vec::new())])
        .await;
    client.expect_alive(0).await;
    // Called as a unary call, a subscription is authorized, then unimplemented.
    client.call(2, "fixture.counter", json!(null)).await;
    client.expect_code(2, Code::Unimplemented).await;
}

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
