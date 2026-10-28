//! Shared fixtures: a dispatcher that reports who is calling, and frame helpers.

#![allow(dead_code)]

use std::sync::Arc;

use ambidex::engine::BoxFuture;
use ambidex::frame::{Frame, FrameDecoder, Kind};
use ambidex::{Call, Dispatch, ErrorPayload, ServerConfig, Session};
use ambidex_tauri::LocalIdentity;
use security_types::{RoleId, TenantId};
use serde_json::{Value, json};

pub const SCHEMA: &str = "schema-1";

/// Answers `whoami` with the session and principal the engine attached to the call.
pub struct WhoAmI;

impl Dispatch for WhoAmI {
    fn call(
        &self,
        session: Arc<Session>,
        call: Call,
    ) -> BoxFuture<'static, Result<Value, ErrorPayload>> {
        Box::pin(async move {
            Ok(json!({
                "procedure": call.procedure,
                "session": session.id,
                "principal": session.principal.id,
                "principal_session": session.principal.session.as_str(),
                "roles": session.principal.roles,
            }))
        })
    }
}

pub fn identity() -> LocalIdentity {
    LocalIdentity::new("alice", TenantId::new("local"), vec![RoleId::new("owner")]).unwrap()
}

pub fn server_config() -> ServerConfig {
    ServerConfig::new("dbee", SCHEMA, "1.0.0")
}

/// A Hello whose `auth` tries to claim another principal; the desktop must ignore it.
pub fn hello() -> Vec<u8> {
    json_frame(
        Kind::Hello,
        0,
        json!({
            "protocol": 1,
            "api": "dbee",
            "schema_hash": SCHEMA,
            "client_version": "1.0.0",
            "auth": { "principal": "human:local:root", "roles": ["admin"] },
        }),
    )
}

pub fn call(call_id: u32, procedure: &str) -> Vec<u8> {
    json_frame(
        Kind::Call,
        call_id,
        json!({ "procedure": procedure, "input": null }),
    )
}

pub fn json_frame(kind: Kind, call_id: u32, value: Value) -> Vec<u8> {
    Frame::new(kind, call_id, serde_json::to_vec(&value).unwrap())
        .encode(u32::MAX)
        .unwrap()
}

/// Decodes server chunks into frames.
pub struct Frames(FrameDecoder);

impl Frames {
    pub fn new() -> Frames {
        Frames(FrameDecoder::new(u32::MAX))
    }

    /// Feeds a chunk and returns the frames it completed.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<Frame> {
        self.0.push(chunk);
        let mut frames = Vec::new();
        while let Some(frame) = self.0.next_frame().unwrap() {
            frames.push(frame);
        }
        frames
    }
}

pub fn payload(frame: &Frame) -> Value {
    serde_json::from_slice(&frame.payload).unwrap()
}
