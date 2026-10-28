//! Ambidex conformance suite (Ambidex spec §12): one set of protocol cases, run unchanged on
//! every transport.
//!
//! - [`fixture`]: the fixture API (echo, typed failures, slow and stubborn handlers, protected and
//!   approval-gated procedures, declared subscription and stream), served through the production
//!   router, authorizer hook and error model.
//! - [`client`]: a raw frame client over a transport's client end ([`client::Wire`]).
//! - [`harness`]: the [`Harness`] trait and [`conformance_suite!`], which turns every case into
//!   one `#[test]` per harness.
//! - [`cases`]: the cases, each written once.
//! - Harnesses: [`in_process`] (memory pipe), [`ws`] (real axum server over real TLS on an
//!   ephemeral loopback port, feature `ws`), [`tauri`] (the real plugin through Tauri's IPC and
//!   ACL layer on the mock runtime, feature `tauri`).
//!
//! Everything runs offline: certificates are generated in memory, the only socket is a loopback
//! listener, and the Tauri harness opens no window and no port.
//!
//! # Coverage by transport
//!
//! Every case in [`cases`] runs on all three harnesses, with one exception:
//!
//! | Case | In-process | WebSocket | Tauri |
//! | --- | --- | --- | --- |
//! | `session_revocation_sends_goaway_and_cancels_calls` | yes | **not applicable** | yes (app lock: `Hub::end_all_sessions`) |
//!
//! WebSocket session revocation is M3: `PlaceholderSessions` has no expiry or revocation, and
//! removing a session only refuses new upgrades (asserted in `tests/ws.rs`). The case reports the
//! reason and still checks the call can be cancelled. When M3 lands, implement
//! [`Harness::revoke_sessions`] for [`ws::Ws`] and the case runs as on the other transports.
//!
//! Transport-specific checks are not shared cases, because they have no counterpart elsewhere:
//! Host, Origin and session-cookie rejection before the engine (WebSocket, `tests/ws.rs`), and
//! "not reachable" for Tauri: remote content and other webviews get no connection
//! (`tests/tauri.rs`). The in-process harness has no transport to attack.
//!
//! # Not covered yet (no implementation to test)
//!
//! - **Subscriptions** (counter subscription, teardown on unsubscribe and revoke) and **streams**
//!   (1M-row Arrow stream, credits bounding server memory, cancel mid-stream reaching the fixture
//!   driver within 100 ms): the engine answers `Subscribe` and stream calls with `Unimplemented`
//!   and ignores `Credit`/`Unsubscribe`. The suite pins exactly that, so the cases fail and must be
//!   replaced when the call kinds land (subscriptions: M1; streams and credits: M2).
//! - The slow-consumer disconnect (`Closed::SlowConsumer`) depends on how much a transport buffers
//!   (kernel socket buffers for WebSocket; a Tauri `Channel` never blocks), so it stays in the
//!   engine's own tests.
//! - Version skew between a desktop core and a team server (M5).
//!
//! # Tauri harness: mock runtime, not a headless app
//!
//! Spike result (TSK-12). The mock runtime (`tauri::test`) is used:
//!
//! - It runs the real plugin, its commands, Tauri's invoke handling and the **ACL** (capabilities
//!   are enforced, so the remote-URL denial is real), and the real `Channel` delivery up to the
//!   point where bytes would be handed to the webview; a channel interceptor takes them there.
//! - It needs no display, no webview process and no WebDriver, so it runs on any CI runner,
//!   offline, in milliseconds per case. It still links GTK/WebKitGTK on Linux, like any Tauri
//!   crate.
//! - What it does not cover: the webview's JavaScript side (`invoke` with a raw body, receiving
//!   `ArrayBuffer`s, Tauri's fetch path for large channel messages) and a real OS window
//!   lifecycle. A headless app cannot cover these either without a JS client, which is TSK-8; the
//!   spec's TS scenarios against a real Tauri build via WebDriver (nightly, three OSes) are
//!   where that belongs.
//! - Limitation: the mock runtime does not expose a channel's end-of-stream (an `eval`), so the
//!   harness detects a closed connection by asking the hub (see `tauri::TauriWire`).

pub mod cases;
pub mod client;
pub mod fixture;
pub mod harness;
pub mod in_process;
#[cfg(feature = "tauri")]
pub mod tauri;
#[cfg(feature = "ws")]
pub mod ws;

pub use client::Client;
pub use fixture::Fixture;
pub use harness::{Harness, Unsupported};
