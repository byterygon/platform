//! The [`Harness`] trait and the suite macro.

use std::fmt;
use std::future::Future;

use crate::client::Client;
use crate::fixture::Fixture;

/// One way of serving the fixture API to a client: a transport plus whatever it needs (TLS
/// certificates, a web session, a Tauri app).
///
/// Implementations only set up and tear down; every protocol expectation is in [`crate::cases`].
pub trait Harness: Sized {
    /// Shown in failure messages.
    const NAME: &'static str;

    /// Starts a server for `fixture` with [`crate::fixture::server_config`].
    fn start(fixture: Fixture) -> impl Future<Output = Self>;

    fn fixture(&self) -> &Fixture;

    /// Opens a new connection. Nothing has been sent on it yet.
    fn connect(&self) -> impl Future<Output = Client>;

    /// The principal id the transport's authentication attaches to calls. It never comes from
    /// client input.
    fn principal_id(&self) -> String;

    /// Ends the sessions of every open connection through the transport's own session API
    /// (logout, app lock), or says why the transport cannot do that yet.
    fn revoke_sessions(&self) -> Result<(), Unsupported>;

    /// Stops the server and releases its sockets, tasks and app.
    fn shutdown(self) -> impl Future<Output = ()>;
}

/// A case that cannot run on a transport, with the reason. Cases that receive one record it and
/// assert nothing else; the crate docs list every such gap.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unsupported(pub &'static str);

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// Runs one case on a fresh server of harness `H`, on a current-thread runtime with real time,
/// then shuts the server down.
///
/// A fresh server per case keeps cases independent. Real time (not Tokio's paused clock) because
/// the WebSocket and Tauri harnesses do real I/O; cases only depend on what arrives, never on how
/// fast.
pub fn run<H, F>(case: F)
where
    H: Harness,
    F: AsyncFnOnce(&H),
{
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime")
        .block_on(async {
            let harness = H::start(Fixture::new()).await;
            case(&harness).await;
            harness.shutdown().await;
        });
}

/// Instantiates every case in [`crate::cases`] as a `#[test]` for one harness.
///
/// In a test target (`tests/in_process.rs`):
///
/// ```text
/// ambidex_conformance::conformance_suite!(ambidex_conformance::in_process::InProcess);
/// ```
#[macro_export]
macro_rules! conformance_suite {
    ($harness:ty) => {
        $crate::conformance_suite!(@cases $harness;
            handshake_returns_ack_with_limits,
            version_mismatch_is_rejected,
            first_frame_must_be_hello,
            duplicate_hello_is_rejected,
            bad_header_version_is_fatal,
            unknown_kind_is_fatal,
            reserved_flags_are_fatal,
            oversize_payload_is_fatal,
            server_only_kind_from_client_is_fatal,
            frames_split_and_coalesced_across_chunks,
            ping_is_answered_with_pong,
            unary_call_round_trip,
            concurrent_calls_answer_by_call_id,
            principal_comes_from_the_transport,
            typed_domain_error_travels_as_details,
            internal_errors_are_scrubbed,
            unknown_procedure_is_not_found,
            invalid_input_is_invalid_argument,
            malformed_call_payload_keeps_connection,
            binary_call_payload_keeps_connection,
            oversize_result_is_resource_exhausted,
            permission_denied_never_runs_handler,
            approval_required_carries_approval_id,
            in_handler_escalation_requires_approval,
            call_ids_may_skip_but_must_increase,
            reused_call_id_is_fatal,
            call_id_zero_is_fatal,
            subscribe_must_also_increase_call_id,
            concurrency_limit_is_retryable,
            zero_timeout_never_runs_handler,
            deadline_cancels_running_handler,
            procedure_timeout_max_caps_client_timeout,
            cancel_reaches_running_handler,
            cancel_in_same_chunk_as_call_wins,
            cancel_after_result_is_ignored,
            cancel_for_unknown_call_is_ignored,
            cancel_on_call_zero_is_fatal,
            stubborn_handler_is_dropped_after_grace,
            disconnect_cancels_calls,
            client_goaway_closes_and_cancels_calls,
            session_revocation_sends_goaway_and_cancels_calls,
            connections_are_independent,
            subscriptions_are_unimplemented_and_keep_connection,
            streams_are_unimplemented_and_keep_connection,
        );
    };
    (@cases $harness:ty; $($case:ident),* $(,)?) => {
        $(
            #[test]
            fn $case() {
                $crate::harness::run::<$harness, _>($crate::cases::$case::<$harness>);
            }
        )*
    };
}
