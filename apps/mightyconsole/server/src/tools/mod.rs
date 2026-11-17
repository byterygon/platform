//! The tools built into the server (Mightyconsole spec §2.2, "The tool contract").
//!
//! A tool is one module, `tools/<tool>/`, exposing one `#[rpc::router(namespace = "<tool>")]`
//! API (dotted sub-namespaces such as `nats.kv` are allowed) and nothing else. It uses
//! [`crate::core`] (live handles, terminals, stream progress, [`ToolError`]) and its own
//! libraries, never another tool. Its procedures:
//!
//! - `<tool>.connect { profile }` (mutation, Read) opens the tool's client from the profile the
//!   browser sends (the server keeps no configuration) and returns a `connId`
//!   ([`Hub::insert`]); `<tool>.disconnect { connId }` (mutation, Read) releases it,
//!   idempotently ([`Hub::remove`]).
//! - Every other procedure names the `connId` and gets the handle with [`Hub::get`], or
//!   [`Hub::busy`] for a stream, so that the idle sweep leaves it alone while the stream runs.
//! - Streams select on the handle's token, so releasing the handle ends them.
//! - Names are `<tool>.<area>.<verb>`; live streams declare `timeout_max = "12h"`; every
//!   procedure is hidden from agents (the default); inputs holding secrets are in `redact`.
//!
//! [`ToolError`]: crate::core::ToolError
//! [`Hub::insert`]: crate::core::Hub::insert
//! [`Hub::remove`]: crate::core::Hub::remove
//! [`Hub::get`]: crate::core::Hub::get
//! [`Hub::busy`]: crate::core::Hub::busy

pub mod echo;
pub mod langgraph;

use std::sync::Arc;

use ambidex::{RegistryError, Router};

use crate::api::ToolInfo;
use crate::core::Hub;

/// Every built-in tool, in the order of the UI's tool rail.
pub fn infos() -> Vec<ToolInfo> {
    vec![
        ToolInfo {
            id: echo::TOOL.into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        ToolInfo {
            id: langgraph::TOOL.into(),
            // The LangGraph Server API through hyper (spec §11.5).
            version: "hyper 1.12".into(),
        },
    ]
}

/// Mounts every tool's API on `router`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(echo::EchoApi(Arc::clone(hub)))?;
    langgraph::mount(router, hub)?;
    Ok(())
}
