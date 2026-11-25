//! The tools built into the server (Mightyconsole spec §2.2, "The tool contract").
//!
//! A tool is one module, `tools/<tool>/`, exposing one `#[rpc::router(namespace = "<tool>")]`
//! API (dotted sub-namespaces such as `nats.kv` are allowed) and nothing else. It uses
//! [`crate::core`] (live handles, terminals, stream progress, [`ToolError`]) and its own
//! libraries, never another tool. Its procedures:
//!
//! - `<tool>.connect { profileId }` (mutation, Read, audited) opens the tool's client from a
//!   stored profile, its secrets opened on the server ([`crate::core::stored`],
//!   [`crate::profiles::connect`]), and returns a `connId` ([`Hub::insert_for`]);
//!   `<tool>.disconnect { connId }` (mutation, Read) releases it, idempotently ([`Hub::remove`]).
//! - `<tool>.test { draft, basedOn? }` (mutation, Read, audited): Test connection of the profile
//!   form; `draft.secrets` is redacted and used for that call only.
//! - A tool's secret fields and the target fields guarding them are in
//!   [`crate::profiles::spec`]; it never takes a secret from the browser otherwise.
//! - Every other procedure names the `connId` and gets the handle with [`Hub::get`], or
//!   [`Hub::busy`] for a stream, so that the idle sweep leaves it alone while the stream runs.
//! - Streams select on the handle's token, so releasing the handle ends them.
//! - Names are `<tool>.<area>.<verb>`; live streams declare `timeout_max = "12h"`; every
//!   procedure is hidden from agents (the default); inputs holding secrets are in `redact`.
//!
//! [`ToolError`]: crate::core::ToolError
//! [`Hub::insert_for`]: crate::core::Hub::insert_for
//! [`Hub::remove`]: crate::core::Hub::remove
//! [`Hub::get`]: crate::core::Hub::get
//! [`Hub::busy`]: crate::core::Hub::busy

pub mod docker;
pub mod echo;
pub mod langgraph;
pub mod nats;
pub mod temporal;

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
            id: nats::TOOL.into(),
            version: nats::LIBRARY.into(),
        },
        ToolInfo {
            id: docker::TOOL.into(),
            // Docker over SSH (spec §10.7).
            version: "russh 0.65".into(),
        },
        ToolInfo {
            id: langgraph::TOOL.into(),
            // The LangGraph Server API through hyper (spec §11.5).
            version: "hyper 1.12".into(),
        },
        ToolInfo {
            id: temporal::TOOL.into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
    ]
}

/// Mounts every tool's API on `router`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(echo::EchoApi(Arc::clone(hub)))?;
    router.mount(echo::EchoMessagesApi(Arc::clone(hub)))?;
    nats::mount(router, hub)?;
    docker::mount(router, hub)?;
    langgraph::mount(router, hub)?;
    router.mount(temporal::TemporalApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalNamespacesApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalWorkflowsApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalSchedulesApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalTaskQueuesApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalWorkersApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalActivitiesApi(Arc::clone(hub)))?;
    router.mount(temporal::TemporalPayloadApi(Arc::clone(hub)))?;
    Ok(())
}
