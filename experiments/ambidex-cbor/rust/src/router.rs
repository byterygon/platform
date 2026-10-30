//! Standalone router prototype. No production authorization interface is changed.
use crate::{
    cbor, fixture, hydrate, json,
    model::{Direction, Graph},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Session {
    pub principal: String,
    pub target: String,
    pub context: String,
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Binding {
    pub version: u8,
    pub procedure: String,
    pub principal: String,
    pub target: String,
    pub context: String,
    pub input_digest: String,
    pub contract: String,
    pub policy: String,
}
pub trait Guard {
    fn access(&self, s: &Session) -> bool;
    fn authorize(&self, b: &Binding) -> bool;
}
#[derive(Serialize)]
pub struct Reply {
    pub input_digest: String,
    pub output: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    pub log: Option<Value>,
    pub events: Vec<&'static str>,
    pub binding: Binding,
}
pub fn dispatch(
    bytes: &[u8],
    codec: &str,
    session: &Session,
    guard: &impl Guard,
    log_input: bool,
) -> Result<Reply, String> {
    let mut events = Vec::new();
    let raw = if codec == "json" {
        hydrate::raw_json(json::parse(bytes)?)?
    } else if codec == "cbor" {
        cbor::decode(bytes, true).map_err(str::to_owned)?
    } else {
        return Err("codec".into());
    };
    events.push("bounded-syntax");
    if session.principal.is_empty() {
        return Err("Unauthenticated".into());
    }
    events.push("authenticated-session");
    if !guard.access(session) {
        return Err("PermissionDenied".into());
    }
    events.push("access-gate");
    let schema = Graph::document::<fixture::EditInput>(Direction::Input)?;
    let logical = hydrate::hydrate(&raw, &schema, codec == "json")?;
    let typed: fixture::EditInput =
        serde_json::from_value(hydrate::json_value(&logical, false)?).map_err(|_| "typed input")?;
    events.push("hydrate");
    let encoded = cbor::encode(&logical);
    let mut h = Sha256::new();
    h.update(b"ambidex.input-digest.v2\0");
    h.update(encoded);
    let input_digest = format!("sha256:{:x}", h.finalize());
    events.push("digest-v2");
    let contract = crate::generated_ids::CONTRACT.to_owned();
    let policy = crate::generated_ids::POLICY.to_owned();
    let binding = Binding {
        version: 2,
        procedure: "fixture.edit".into(),
        principal: session.principal.clone(),
        target: session.target.clone(),
        context: session.context.clone(),
        input_digest: input_digest.clone(),
        contract,
        policy,
    };
    if !guard.authorize(&binding) {
        return Err("PermissionDenied".into());
    }
    events.push("bound-authorization");
    let log = if log_input {
        let mut value = hydrate::emit(&logical, &schema)?;
        value["secret"] = Value::String("<redacted>".into());
        Some(value)
    } else {
        None
    };
    events.push("redact-log");
    let output = fixture::try_edit(typed);
    events.push("typed-dispatch");
    let (output, error) = match output {
        Ok(value) => {
            let native = serde_json::to_value(value).map_err(|e| e.to_string())?;
            (crate::workloads::native_lossless(native, &schema)?, None)
        }
        Err(error) => (
            Value::Null,
            Some(serde_json::to_value(error).map_err(|e| e.to_string())?),
        ),
    };
    Ok(Reply {
        input_digest,
        output,
        error,
        log,
        events,
        binding,
    })
}
