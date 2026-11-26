//! Wire types shared by every tool (Mightyconsole spec §2.2, §2.5, §2.7).
//!
//! Inputs and outputs derive `TS` and `JsonSchema` for `mightyconsole-rpc-gen`; field names are
//! camelCase. `#[serde(default)]` input fields are `#[ts(optional = nullable)]`, output fields
//! left out when empty are `#[ts(optional)]` (CLAUDE.md, codegen).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The empty object, `{}`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub struct Empty {}

/// The state of a live handle (spec §2.2, "Status").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    Reconnecting,
    Failed,
    Closed,
}

/// Pushed on `app.events` (spec §2.7). One subscription per page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AppEvent {
    /// A live handle changed state.
    ConnectionStatus {
        tool: String,
        conn_id: String,
        status: ConnectionState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        message: Option<String>,
    },
    /// Once a second while a stream with a `streamId` runs, and once when it ends (spec §2.5).
    StreamProgress {
        stream_id: String,
        /// Items read from the source.
        scanned: u64,
        /// Items that passed the filter and were sent.
        matched: u64,
        /// Items a push-only source dropped because the client was not reading.
        dropped: u64,
        decode_errors: u64,
        /// Matched items per second over the last interval.
        rate_per_sec: f64,
        /// Bytes sent per second over the last interval.
        bytes_per_sec: f64,
        /// `true` on the last event of the stream.
        done: bool,
    },
    /// A stored profile was made, changed or deleted (DOC-25 §3.4.2): sent to the sessions that
    /// may see it, which read it again.
    ProfileChanged { id: String, tool: String },
    /// A saved SSH host was made, changed or deleted (DOC-23 §4.3): sent to the sessions that may
    /// see it, which read the hosts again.
    SshHostChanged { id: String },
    /// A terminal ended; `term.*` calls on it answer `NotFound` from now on.
    TerminalExit {
        terminal_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        exit_code: Option<i32>,
        reason: String,
    },
}
