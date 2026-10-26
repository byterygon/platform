//! Ambidex: one binary frame protocol, served unchanged over Tauri IPC and WebSocket.
//!
//! - [`frame`]: the 12-byte header codec and incremental decoder.
//! - [`message`]: JSON control payloads (Hello, HelloAck, Call, Error, Goaway).
//! - [`transport`]: the byte-pipe traits transports implement, plus an in-memory pair.
//! - [`engine`]: the per-connection protocol engine.
//! - [`procedure`]: procedure metadata (permission, risk, agent exposure, timeouts, redaction).
//! - [`router`]: the procedure registry; authorizes every call before dispatch.
//! - [`error`]: the typed error model, `RpcError<E>`.
//! - [`rpc`]: the `#[rpc::router]` and procedure attribute macros.
//!
//! Spec: Notion "Ambidex spec" (DOC-5), §2, §3, §8, §10.
//!
//! ```
//! use ambidex::{Agent, Ctx, Risk, RpcError, rpc};
//! use serde::{Deserialize, Serialize};
//!
//! #[derive(Deserialize)]
//! pub struct GetInput { pub id: u32 }
//!
//! #[derive(Serialize)]
//! pub struct Item { pub id: u32 }
//!
//! pub struct ItemsApi;
//!
//! #[rpc::router(namespace = "items")]
//! impl ItemsApi {
//!     #[rpc::query(perm = "items.read", risk = Risk::Read, agent = Agent::Exposed)]
//!     async fn get(&self, _ctx: Ctx, input: GetInput) -> Result<Item, RpcError> {
//!         Ok(Item { id: input.id })
//!     }
//! }
//! ```
//!
//! A procedure without `perm` does not compile:
//!
//! ```compile_fail
//! use ambidex::{Ctx, Risk, RpcError, rpc};
//!
//! pub struct ItemsApi;
//!
//! #[rpc::router(namespace = "items")]
//! impl ItemsApi {
//!     #[rpc::query(risk = Risk::Read)]
//!     async fn get(&self, _ctx: Ctx, input: u32) -> Result<u32, RpcError> {
//!         Ok(input)
//!     }
//! }
//! ```
//!
//! Nor does a risk spelled with another type's path:
//!
//! ```compile_fail
//! use ambidex::{Agent, Ctx, RpcError, rpc};
//!
//! pub struct ItemsApi;
//!
//! #[rpc::router(namespace = "items")]
//! impl ItemsApi {
//!     #[rpc::query(perm = "items.read", risk = Agent::Read)]
//!     async fn get(&self, _ctx: Ctx, input: u32) -> Result<u32, RpcError> {
//!         Ok(input)
//!     }
//! }
//! ```

pub mod engine;
pub mod error;
pub mod frame;
pub mod message;
pub mod procedure;
pub mod router;
pub mod transport;

/// Procedure declaration macros (spec §2).
///
/// `#[rpc::router(namespace = "...")]` on an `impl` block registers every method marked
/// `#[rpc::query]`, `#[rpc::mutation]`, `#[rpc::subscription]` or `#[rpc::stream]`, and implements
/// [`Api`] for the type. Procedure attribute arguments:
///
/// | Argument | Required | Meaning |
/// | --- | --- | --- |
/// | `perm = "a.b"` | yes | Permission the procedure requires |
/// | `risk = Risk::Read` | yes | Baseline risk (`Read`, `Write`, `Destructive`) |
/// | `agent = Agent::Exposed` | no | Visible to MCP; default `Agent::Hidden` |
/// | `timeout_default = "30s"` | no | Deadline when the client sets none (`ms`, `s`, `m`, `h`) |
/// | `timeout_max = "5m"` | no | Upper bound for a client deadline |
/// | `log_input` | no | Input values may be written to the audit log |
/// | `redact = ["password"]` | no | Input field paths never logged |
/// | `name = "other"` | no | Method part of the procedure name; default the Rust name |
/// | `deprecated` | no | Marks the procedure deprecated (spec §10) |
///
/// Queries and mutations are `async fn name(&self, ctx: Ctx, input: I) -> Result<O, E>` with
/// `I: Deserialize`, `O: Serialize` and `E:` [`IntoErrorPayload`]. Subscriptions and streams are
/// registered and authorized, then answered with `Unimplemented` until their engine support lands.
pub mod rpc {
    pub use ambidex_macros::{mutation, query, router, stream, subscription};
}

pub use engine::{Authenticate, Closed, Connection, Dispatch, Server, ServerConfig, Session};
pub use error::{DomainError, IntoErrorPayload, NoDetails, RpcError};
pub use frame::{Flags, Frame, FrameDecoder, FrameError, Kind};
pub use message::{Call, Code, ErrorPayload, Goaway, Hello, HelloAck, Limits};
pub use procedure::{Agent, ProcedureKind, ProcedureMeta};
pub use router::{
    Api, ApprovalRequired, Approvals, Ctx, Handler, Procedure, RegistryError, Rejected, Router,
    input_digest,
};
pub use security_types;
pub use security_types::{Risk, TargetRef};
