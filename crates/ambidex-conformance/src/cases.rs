//! The conformance cases, each written once and run on every [`Harness`].
//!
//! Expectations come from the Ambidex spec (§3 wire protocol, §5 call kinds, §7 cancellation and
//! deadlines, §8 authorization and audit, §10 errors) and the decisions recorded in its Open
//! questions 14–16, 21 and 23 (subscriptions). Cases assert outcomes, not timing: where a race is allowed by the spec (a deadline may
//! fire before or after the handler first runs), every allowed outcome is accepted and checked.

use std::collections::BTreeMap;

use ambidex::frame::{Flags, Frame, HEADER_LEN, Kind};
use ambidex::security_types::{
    AuditDecision, AuditEntry, AuditEntryKind, AuditFailureEffect, Delivery, Outcome, Reason, Risk,
};
use ambidex::{Code, Goaway, input_digest};
use serde_json::{Value, json};

use crate::client::{
    Client, call_frame, cancel_frame, encode, json_frame, subscribe_frame, unsubscribe_frame,
};
use crate::fixture::{
    APPROVAL_ID, AUDIT_WRITE_TIMEOUT, CANCEL_GRACE, Event, MAX_CONCURRENT_CALLS, MAX_FRAME_BYTES,
    SCHEMA_HASH, SERVER_VERSION, SUBSCRIPTION_BUFFER_EVENTS, completed_with,
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
    let entries = h.fixture().audit.refusals();
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
    client.expect_code(1, Code::DeadlineExceeded).await;
    assert_never_started_or_saw_cancel(h, "counter").await;
    // Already expired: the handler never runs.
    let runs = h.fixture().probe.runs();
    client
        .subscribe_with_timeout(2, "fixture.counter", counter(3, "finish"), 0)
        .await;
    client.expect_code(2, Code::DeadlineExceeded).await;
    assert_eq!(h.fixture().probe.runs(), runs);
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

// ---- audit of calls that run (§8, Open question 26) -----------------------------------------

/// The entries of `action`, in order.
fn audited(h: &impl Harness, action: &str) -> Vec<AuditEntry> {
    h.fixture()
        .audit
        .entries()
        .into_iter()
        .filter(|e| e.action.name == action)
        .collect()
}

/// Checks that `entries` are one call's admission then completion, and returns the completion.
fn admission_then_completion<'e>(
    h: &impl Harness,
    entries: &'e [AuditEntry],
    risk: Risk,
) -> &'e AuditEntry {
    let [admission, completion] = entries else {
        panic!("expected an admission and a completion, got {entries:?}");
    };
    assert_eq!(admission.outcome, Outcome::Started);
    assert_eq!(admission.decision, AuditDecision::Allow);
    assert_eq!((admission.delivery, admission.duration_ms), (None, None));
    assert!(!admission.correlation_id.is_empty());
    assert_eq!(completion.correlation_id, admission.correlation_id);
    assert_eq!(completion.decision, AuditDecision::Allow);
    for entry in [admission, completion] {
        assert_eq!(entry.risk, risk);
        assert_eq!(entry.principal_chain[0].id, h.principal_id());
    }
    completion
}

/// Waits (bounded) until `found` returns at least `count` items, and returns them. A completion
/// is written in the background once its answer frame went out (Open question 26 item 11), so it
/// may land after the client read the answer.
async fn wait_for<T>(count: usize, mut found: impl FnMut() -> Vec<T>) -> Vec<T> {
    let deadline = tokio::time::Instant::now() + crate::client::RECV_TIMEOUT;
    loop {
        let items = found();
        if items.len() >= count || tokio::time::Instant::now() > deadline {
            return items;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// Waits until the log holds `count` entries for `action`.
async fn wait_for_entries(h: &impl Harness, action: &str, count: usize) -> Vec<AuditEntry> {
    wait_for(count, || audited(h, action)).await
}

/// Waits for both entries of the call with `correlation_id`, and returns its completion.
async fn wait_for_completion(h: &impl Harness, correlation_id: &str) -> AuditEntry {
    let entries = wait_for(2, || h.fixture().audit.call(correlation_id)).await;
    assert_eq!(entries.len(), 2, "{entries:?}");
    entries[1].clone()
}

pub async fn calls_that_run_are_audited_twice<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client.call(1, "fixture.echo", json!(1)).await;
    client.expect_result(1).await;
    client.call(2, "fixture.write", json!(2)).await;
    client.expect_result(2).await;
    client
        .call(3, "fixture.fail", json!({ "code": "NotFound" }))
        .await;
    let err = client.expect_code(3, Code::NotFound).await;

    // The admission is written before the handler runs; the completion once the answer went
    // out, in the background.
    let entries = wait_for_entries(h, "fixture.echo", 2).await;
    let read = admission_then_completion(h, &entries, Risk::Read).clone();
    assert!(completed_with(&read, None));
    assert_eq!(read.delivery, Some(Delivery::Delivered));
    let entries = wait_for_entries(h, "fixture.write", 2).await;
    let write = admission_then_completion(h, &entries, Risk::Write).clone();
    assert!(completed_with(&write, None));
    assert_ne!(write.correlation_id, read.correlation_id);
    // The handler's error is its outcome; the client got it as it was.
    let entries = wait_for_entries(h, "fixture.fail", 2).await;
    let failed = admission_then_completion(h, &entries, Risk::Read).clone();
    assert!(completed_with(&failed, Some("NotFound")));
    assert_eq!(failed.delivery, Some(Delivery::Delivered));
    assert_eq!(failed.correlation_id, err.correlation_id);
    assert_eq!(
        failed.input_digest,
        input_digest(&json!({ "code": "NotFound" }))
    );
    assert!(h.fixture().reports.all().is_empty());
}

pub async fn admission_that_cannot_be_recorded_fails_closed<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    fixture.audit.fail(true);

    // A Write does not run without its admission entry.
    client.call(1, "fixture.write", json!(1)).await;
    let blocked = client.expect_code(1, Code::Unavailable).await;
    assert!(blocked.retryable, "nothing ran, so the client may retry");
    assert_eq!(fixture.probe.runs(), 0, "the handler was never entered");
    // A human Read runs, and the failure is reported.
    client.call(2, "fixture.echo", json!("read")).await;
    assert_eq!(client.expect_result(2).await, json!("read"));
    // A refusal is still a refusal.
    client
        .call(3, "fixture.protected", json!({ "code": "NotFound" }))
        .await;
    client.expect_code(3, Code::PermissionDenied).await;

    assert!(fixture.audit.entries().is_empty());
    let mut reports: Vec<_> = wait_for(4, || fixture.reports.all())
        .await
        .into_iter()
        .map(|r| (r.entry, r.effect, r.action))
        .collect();
    // Admissions are reported in call order, before the answers. The read's completion is
    // written in the background after its answer went out, so it may come after the refusal.
    let later = reports.split_off(2);
    assert_eq!(
        reports,
        [
            (
                AuditEntryKind::Admission,
                AuditFailureEffect::Blocked,
                "fixture.write".to_owned()
            ),
            (
                AuditEntryKind::Admission,
                AuditFailureEffect::RanUnrecorded,
                "fixture.echo".to_owned()
            ),
        ]
    );
    let completion_lost = (
        AuditEntryKind::Completion,
        AuditFailureEffect::EntryLost,
        "fixture.echo".to_owned(),
    );
    let refusal_lost = (
        AuditEntryKind::Refusal,
        AuditFailureEffect::EntryLost,
        "fixture.protected".to_owned(),
    );
    assert_eq!(later.len(), 2, "{later:?}");
    assert!(
        later.contains(&completion_lost) && later.contains(&refusal_lost),
        "{later:?}"
    );
    assert_eq!(
        fixture.reports.all()[0].correlation_id,
        blocked.correlation_id
    );

    // Once the sink works again, the same Write runs and is recorded.
    fixture.audit.fail(false);
    client.call(4, "fixture.write", json!(4)).await;
    assert_eq!(client.expect_result(4).await, json!(4));
    fixture.probe.expect(Event::Started("write")).await;
    let entries = wait_for_entries(h, "fixture.write", 2).await;
    admission_then_completion(h, &entries, Risk::Write);
    client.expect_alive(0).await;
}

pub async fn completion_records_handler_outcome_and_delivery<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let probe = &h.fixture().probe;

    // Cancelled while running: the handler still returned a value, which was discarded.
    client.call(1, "fixture.wait", json!(null)).await;
    probe.expect(Event::Started("wait")).await;
    client.cancel(1).await;
    let err = client.expect_code(1, Code::Cancelled).await;
    probe.expect(Event::Cancelled("wait")).await;
    let entry = wait_for_completion(h, &err.correlation_id).await;
    assert!(completed_with(&entry, None), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::Cancelled));

    // Out of time while running: likewise, with the deadline.
    client
        .call_with_timeout(2, "fixture.wait", json!(null), 300)
        .await;
    probe.expect(Event::Started("wait")).await;
    let err = client.expect_code(2, Code::DeadlineExceeded).await;
    probe.expect(Event::Cancelled("wait")).await;
    let entry = wait_for_completion(h, &err.correlation_id).await;
    assert!(completed_with(&entry, None), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::DeadlineExceeded));

    // Dropped after the grace period: it never returned, so its outcome is how it was stopped.
    client.call(3, "fixture.stubborn", json!(null)).await;
    probe.expect(Event::Started("stubborn")).await;
    client.cancel(3).await;
    let err = client.expect_code(3, Code::Cancelled).await;
    probe.expect(Event::Dropped("stubborn")).await;
    let entry = wait_for_completion(h, &err.correlation_id).await;
    assert!(completed_with(&entry, Some("Cancelled")), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::Cancelled));

    // An answer too large for a frame: the handler succeeded, the client got ResourceExhausted.
    client
        .call(4, "fixture.big", json!(MAX_FRAME_BYTES as usize * 2))
        .await;
    let err = client.expect_code(4, Code::ResourceExhausted).await;
    let entry = wait_for_completion(h, &err.correlation_id).await;
    assert!(completed_with(&entry, None), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::FrameTooLarge));
    client.expect_alive(0).await;
}

pub async fn subscription_completion_records_how_it_ended<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    client
        .subscribe(1, "fixture.counter", counter(2, "finish"))
        .await;
    client.expect_event(1).await;
    client.expect_event(1).await;
    client.expect_result(1).await;
    h.fixture().probe.expect(Event::Started("counter")).await;
    let finished = wait_for_entries(h, "fixture.counter", 2).await;
    let entry = admission_then_completion(h, &finished, Risk::Read);
    assert!(completed_with(entry, None));
    assert_eq!(entry.delivery, Some(Delivery::Delivered));

    // After Unsubscribe the client gets nothing more; the completion says so.
    client
        .subscribe(2, "fixture.counter", counter(0, "wait"))
        .await;
    h.fixture().probe.expect(Event::Started("counter")).await;
    client.unsubscribe(2).await;
    h.fixture().probe.expect(Event::Cancelled("counter")).await;
    let entries = wait_for_entries(h, "fixture.counter", 4).await;
    let entry = admission_then_completion(h, &entries[2..], Risk::Read);
    assert!(completed_with(entry, None), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::Cancelled));
    client.expect_alive(0).await;
}

/// Open question 26 item 11c: the answer never waits for the completion write.
pub async fn answer_does_not_wait_for_the_completion_write<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let audit = &h.fixture().audit;
    audit.hold_completions();
    // The sink holds the completion longer than the call takes: the answer comes first.
    client.call(1, "fixture.echo", json!("first")).await;
    assert_eq!(client.expect_result(1).await, json!("first"));
    client
        .subscribe(2, "fixture.counter", counter(1, "finish"))
        .await;
    client.expect_event(2).await;
    client.expect_result(2).await;
    for action in ["fixture.echo", "fixture.counter"] {
        let entries = audited(h, action);
        assert_eq!(entries.len(), 1, "only the admission so far: {entries:?}");
        assert_eq!(entries[0].outcome, Outcome::Started);
    }
    // Once the sink answers, both completions arrive, as delivered.
    audit.release_completions();
    for (action, risk) in [
        ("fixture.echo", Risk::Read),
        ("fixture.counter", Risk::Read),
    ] {
        let entries = wait_for_entries(h, action, 2).await;
        let entry = admission_then_completion(h, &entries, risk);
        assert!(completed_with(entry, None), "{entry:?}");
        assert_eq!(entry.delivery, Some(Delivery::Delivered));
    }
    assert!(h.fixture().reports.all().is_empty());
    client.expect_alive(0).await;
}

/// Open question 26 item 11: a panic's `Internal` answer travels like any other, so the
/// completion of a subscription that was already unsubscribed (its end frame is never sent)
/// records `Internal`, `Cancelled`.
pub async fn panic_after_unsubscribe_is_internal_and_cancelled<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let probe = &h.fixture().probe;
    client
        .subscribe(1, "fixture.panic_on_cancel", json!(null))
        .await;
    probe.expect(Event::Started("panic_on_cancel")).await;
    client.unsubscribe(1).await;
    probe.expect(Event::Cancelled("panic_on_cancel")).await;
    let entries = wait_for_entries(h, "fixture.panic_on_cancel", 2).await;
    let entry = admission_then_completion(h, &entries, Risk::Read);
    assert!(completed_with(entry, Some("Internal")), "{entry:?}");
    assert_eq!(entry.delivery, Some(Delivery::Cancelled));
    // Nothing is sent for it, and the connection stays up.
    client.expect_alive(0).await;
}

/// Waits (bounded) until `done` holds.
async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + crate::client::RECV_TIMEOUT;
    while !done() {
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for {what}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
}

/// How long a case keeps an answer at the writer, so a timestamp taken at send time would show.
const HOLD: std::time::Duration = std::time::Duration::from_millis(200);

/// Open question 26 item 11b: `Delivered` once the transport accepted the frame, and the
/// completion records when the call ended, not when its frame went out.
#[cfg(feature = "writer-gate")]
pub async fn delivered_once_the_transport_accepted_the_frame<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let gate = &h.fixture().writer_gate;
    gate.close();
    client.call(1, "fixture.echo", json!("held")).await;
    wait_until("the answer at the writer", || gate.waiting() == 1).await;
    let ended_by = ambidex::security_types::unix_now_ms();
    // Chosen, not accepted by the transport: nothing is completed yet.
    let entries = audited(h, "fixture.echo");
    assert_eq!(entries.len(), 1, "only the admission: {entries:?}");
    tokio::time::sleep(HOLD).await;
    gate.open();
    assert_eq!(client.expect_result(1).await, json!("held"));
    let entries = wait_for_entries(h, "fixture.echo", 2).await;
    let completion = admission_then_completion(h, &entries, Risk::Read);
    assert!(completed_with(completion, None), "{completion:?}");
    assert_eq!(completion.delivery, Some(Delivery::Delivered));
    assert!(
        (entries[0].timestamp_unix_ms..=ended_by).contains(&completion.timestamp_unix_ms),
        "the completion is stamped when the call ended ({} ..= {ended_by}), got {}",
        entries[0].timestamp_unix_ms,
        completion.timestamp_unix_ms
    );
    client.expect_alive(0).await;
}

/// Pongs queued behind the writer: enough that a subscription's frames wait for room behind
/// them (subscription frames leave only while half the outbound queue is free).
#[cfg(feature = "writer-gate")]
const QUEUED_PONGS: u32 = 40;

/// Open question 26 item 11a: a subscription returned `Ok`, but its end frame was still waiting
/// when `Unsubscribe` dropped it, so the client never got it: `Cancelled`.
#[cfg(feature = "writer-gate")]
pub async fn end_frame_dropped_by_unsubscribe_after_the_handler_returned_is_cancelled<
    H: Harness,
>(
    h: &H,
) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    let gate = &fixture.writer_gate;
    gate.close();
    let pings: Vec<_> = (1..=QUEUED_PONGS)
        .map(|id| Frame::new(Kind::Ping, id, Vec::new()))
        .collect();
    client.send(&pings).await;
    wait_until("a pong at the writer", || gate.waiting() == 1).await;
    client.subscribe(1, "fixture.burst", json!(null)).await;
    fixture.probe.expect(Event::Started("burst")).await;
    fixture.probe.expect(Event::Returned("burst")).await;
    client.unsubscribe(1).await;
    let entries = wait_for_entries(h, "fixture.burst", 2).await;
    let completion = admission_then_completion(h, &entries, Risk::Read);
    assert!(
        completed_with(completion, None),
        "the handler returned Ok: {completion:?}"
    );
    assert_eq!(completion.delivery, Some(Delivery::Cancelled));
    // The pongs go out; nothing of the subscription does.
    gate.open();
    for id in 1..=QUEUED_PONGS {
        let frame = client.recv().await.expect("Pong, got close");
        assert_eq!((frame.kind, frame.call_id), (Kind::Pong, id), "{frame:?}");
    }
    client.expect_alive(0).await;
}

/// Open question 26 item 11a: answers chosen but still queued when the connection closes never
/// reach the client: `Cancelled`.
#[cfg(feature = "writer-gate")]
pub async fn answers_still_queued_at_close_are_cancelled<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    let gate = &fixture.writer_gate;
    gate.close();
    client.call(1, "fixture.write", json!(1)).await;
    client.call(2, "fixture.write", json!(2)).await;
    fixture
        .probe
        .expect_all(&[Event::Started("write"), Event::Started("write")])
        .await;
    wait_until("an answer at the writer", || gate.waiting() == 1).await;
    // The client goes away; the writer never hands either answer to the transport, and the
    // server drops them when it gives up delivering (its close timeout).
    client.disconnect().await;
    let entries = wait_for_entries(h, "fixture.write", 4).await;
    assert_eq!(entries.len(), 4, "{entries:?}");
    for correlation_id in entries.iter().map(|e| e.correlation_id.clone()) {
        let completion = wait_for_completion(h, &correlation_id).await;
        assert!(completed_with(&completion, None), "{completion:?}");
        assert_eq!(completion.delivery, Some(Delivery::Cancelled));
    }
    gate.open();
}

/// Open question 26 item 11 (review): a completion the sink never takes is reported lost, within
/// about the write timeout of the connection closing.
pub async fn completions_a_hung_sink_never_takes_are_reported_lost<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    fixture.audit.hold_completions();
    client.call(1, "fixture.echo", json!(1)).await;
    client.expect_result(1).await;
    client.call(2, "fixture.echo", json!(2)).await;
    client.expect_result(2).await;
    wait_until("both completion writes", || fixture.audit.held_now() == 2).await;
    let closed_at = tokio::time::Instant::now();
    client.disconnect().await;
    let lost = wait_for(2, || {
        fixture
            .reports
            .all()
            .into_iter()
            .filter(|r| {
                r.entry == AuditEntryKind::Completion && r.effect == AuditFailureEffect::EntryLost
            })
            .collect()
    })
    .await;
    assert!(
        closed_at.elapsed() < AUDIT_WRITE_TIMEOUT + std::time::Duration::from_secs(2),
        "{:?}",
        closed_at.elapsed()
    );
    let mut lost: Vec<_> = lost
        .into_iter()
        .map(|r| (r.action, r.correlation_id))
        .collect();
    lost.sort();
    let mut started: Vec<_> = audited(h, "fixture.echo")
        .into_iter()
        .map(|e| (e.action.name, e.correlation_id))
        .collect();
    started.sort();
    assert_eq!(
        lost, started,
        "one report per completion, with its action and id"
    );
    fixture.audit.release_completions();
}

/// Open question 26 item 11 (review): a slow sink limits a connection's outstanding completions
/// to `max_concurrent_calls`; the engine takes no further call frame until one is written.
pub async fn a_slow_sink_limits_outstanding_completions<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    let bound = MAX_CONCURRENT_CALLS as usize;
    fixture.audit.hold_completions();
    for id in 1..=MAX_CONCURRENT_CALLS {
        client.call(id, "fixture.echo", json!(id)).await;
        assert_eq!(client.expect_result(id).await, json!(id));
    }
    wait_until("every completion write", || {
        fixture.audit.held_now() == bound
    })
    .await;
    // No room: these calls wait, unanswered, instead of adding completions.
    let (late, later) = (MAX_CONCURRENT_CALLS + 1, MAX_CONCURRENT_CALLS + 2);
    client.call(late, "fixture.echo", json!(late)).await;
    client.call(later, "fixture.echo", json!(later)).await;
    tokio::time::sleep(HOLD).await;
    assert_eq!(fixture.audit.held_now(), bound);
    assert!(audited(h, "fixture.echo").len() < 2 * (bound + 2));
    fixture.audit.release_completions();
    // Both run once there is room again, concurrently, so their answers come in either order.
    let mut answered = BTreeMap::new();
    for _ in 0..2 {
        let frame = client.recv().await.expect("Result, got close");
        assert_eq!(frame.kind, Kind::Result, "{frame:?}");
        let value: Value = serde_json::from_slice(&frame.payload).expect("Result payload");
        answered.insert(frame.call_id, value);
    }
    assert_eq!(
        answered,
        BTreeMap::from([(late, json!(late)), (later, json!(later))])
    );
    let entries = wait_for_entries(h, "fixture.echo", 2 * (bound + 2)).await;
    assert_eq!(entries.len(), 2 * (bound + 2));
    assert_eq!(
        fixture.audit.most_held(),
        bound,
        "never more than the bound"
    );
    assert!(
        fixture.reports.all().is_empty(),
        "{:?}",
        fixture.reports.all()
    );
    client.expect_alive(0).await;
}

/// Open question 26 item 11 (third review): while a call frame waits for room in the completion
/// queue, the connection still reads and handles the client's other frames.
pub async fn a_call_waiting_for_room_does_not_hold_other_frames<H: Harness>(h: &H) {
    let mut client = ready(h).await;
    let fixture = h.fixture();
    let bound = MAX_CONCURRENT_CALLS as usize;
    fixture.audit.hold_completions();
    // One call keeps running, and the completions of the others are held: no room is left.
    client.call(1, "fixture.wait", json!(null)).await;
    fixture.probe.expect(Event::Started("wait")).await;
    for id in 2..=MAX_CONCURRENT_CALLS {
        client.call(id, "fixture.echo", json!(id)).await;
        assert_eq!(client.expect_result(id).await, json!(id));
    }
    wait_until("every other completion write", || {
        fixture.audit.held_now() == bound - 1
    })
    .await;
    // This call waits for room.
    let stalled = MAX_CONCURRENT_CALLS + 1;
    client.call(stalled, "fixture.echo", json!(stalled)).await;
    // A Cancel for the running call and a Ping are handled meanwhile, while every write is still
    // held.
    client.cancel(1).await;
    client
        .send(&[Frame::new(Kind::Ping, 7, b"while-stalled".to_vec())])
        .await;
    let mut seen = BTreeMap::new();
    for _ in 0..2 {
        let frame = client.recv().await.expect("a frame, got close");
        seen.insert(frame.kind as u8, frame);
    }
    let cancelled = &seen[&(Kind::Error as u8)];
    assert_eq!(cancelled.call_id, 1, "{cancelled:?}");
    let pong = &seen[&(Kind::Pong as u8)];
    assert_eq!(
        (pong.call_id, pong.payload.as_slice()),
        (7, b"while-stalled".as_slice())
    );
    fixture.probe.expect(Event::Cancelled("wait")).await;
    // A Cancel for a call that is itself still waiting answers at once; that call never runs.
    let dropped = stalled + 1;
    client.call(dropped, "fixture.echo", json!(dropped)).await;
    client.cancel(dropped).await;
    client.expect_code(dropped, Code::Cancelled).await;
    assert!(
        fixture.audit.held_now() >= bound - 1,
        "handled before any held write ended"
    );
    assert!(
        fixture.reports.all().is_empty(),
        "{:?}",
        fixture.reports.all()
    );
    // Once the sink answers, the waiting call runs; the cancelled one never did.
    fixture.audit.release_completions();
    assert_eq!(client.expect_result(stalled).await, json!(stalled));
    client.expect_alive(0).await;
    let echoed: Vec<_> = audited(h, "fixture.echo")
        .into_iter()
        .map(|e| e.input_digest)
        .collect();
    assert!(!echoed.contains(&input_digest(&json!(dropped))));
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
