//! Ambidex: one binary frame protocol, served unchanged over Tauri IPC and WebSocket.
//!
//! - [`frame`]: the 12-byte header codec and incremental decoder.
//! - [`message`]: JSON control payloads (Hello, HelloAck, Call, Error, Goaway).
//! - [`transport`]: the byte-pipe traits transports implement, plus an in-memory pair.
//! - [`engine`]: the per-connection protocol engine.
//!
//! Spec: Notion "Ambidex spec" (DOC-5), §3.

pub mod engine;
pub mod frame;
pub mod message;
pub mod transport;

pub use engine::{Authenticate, Closed, Connection, Dispatch, Server, ServerConfig, Session};
pub use frame::{Flags, Frame, FrameDecoder, FrameError, Kind};
pub use message::{Call, Code, ErrorPayload, Goaway, Hello, HelloAck, Limits};
