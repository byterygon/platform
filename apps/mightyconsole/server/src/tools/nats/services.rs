//! Services (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 3b): the NATS service API's discovery
//! over plain requests, as `nats micro` does.
//!
//! - `nats.services.discover`: `$SRV.INFO[.name[.id]]`, every reply gathered until the timeout
//!   (2 s by default): name, id, version, description, metadata, endpoints with their subjects and
//!   queue groups.
//! - `nats.services.stats`: `$SRV.STATS…`: requests, errors, processing time and the last error
//!   per endpoint.
//! - `nats.services.ping`: `$SRV.PING…`, each reply with its round trip.
//!
//! Replies are read leniently (Go, Rust, Python and JavaScript services differ in small ways, such
//! as the last error being text or an object); one that is not a service's JSON is left out.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use ambidex::{Ctx, RegistryError, Router, rpc};
use futures_util::StreamExt as _;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::time::Instant;
use ts_rs::TS;

use super::client::{NatsClient, remote};
use super::{TOOL, handle};
use crate::core::{Hub, ToolError, ToolResult};

/// How long discovery waits for replies by default (spec §6.3: "within 2 s").
pub const DEFAULT_TIMEOUT_MS: u32 = 2_000;
/// The longest wait a call may ask for.
pub const MAX_TIMEOUT_MS: u32 = 30_000;
/// Replies read at most per call.
pub const MAX_REPLIES: usize = 1_000;

// ---- Wire types ------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServicesInput {
    pub conn_id: String,
    /// Only this service.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub name: Option<String>,
    /// Only this instance of `name`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub id: Option<String>,
    /// How long replies are gathered; 2,000 by default.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub timeout_ms: Option<u32>,
}

/// One endpoint of a service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServiceEndpoint {
    pub name: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue_group: Option<String>,
    pub metadata: BTreeMap<String, String>,
}

/// A service instance as `$SRV.INFO` describes it.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServiceInfo {
    pub name: String,
    pub id: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub description: Option<String>,
    pub metadata: BTreeMap<String, String>,
    pub endpoints: Vec<NatsServiceEndpoint>,
    /// From the request to this reply.
    pub rtt_ms: f64,
}

/// One endpoint's counters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsEndpointStats {
    pub name: String,
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub queue_group: Option<String>,
    pub requests: u64,
    pub errors: u64,
    /// Total time spent in the handler, in nanoseconds.
    pub processing_time_ns: u64,
    pub average_processing_time_ns: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub last_error: Option<String>,
    /// The service's own `data`, as JSON text.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data: Option<String>,
}

/// A service instance as `$SRV.STATS` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServiceStats {
    pub name: String,
    pub id: String,
    pub version: String,
    /// When the instance started (RFC 3339, as the service wrote it).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started: Option<String>,
    pub endpoints: Vec<NatsEndpointStats>,
}

/// A `$SRV.PING` reply.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NatsServicePing {
    pub name: String,
    pub id: String,
    pub version: String,
    pub rtt_ms: f64,
}

// ---- Replies ---------------------------------------------------------------------------------

fn text(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn opt_text(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn number(v: &Value, key: &str) -> u64 {
    match v.get(key) {
        Some(Value::Number(n)) => n
            .as_u64()
            .or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))
            .unwrap_or(0),
        _ => 0,
    }
}

fn metadata(v: &Value) -> BTreeMap<String, String> {
    v.get("metadata")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .map(|(k, v)| {
                    let v = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
                    (k.clone(), v)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn endpoints(v: &Value) -> impl Iterator<Item = &Value> {
    v.get("endpoints")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// The last error: text (Go, Python) or an object with a description (async-nats).
fn last_error(v: &Value) -> Option<String> {
    match v.get("last_error")? {
        Value::String(s) if !s.trim().is_empty() => Some(s.clone()),
        Value::Object(o) => {
            let description = o.get("description").and_then(Value::as_str).unwrap_or("");
            let code = o.get("code").and_then(Value::as_u64);
            match (code, description.is_empty()) {
                (Some(c), false) => Some(format!("{c} {description}")),
                (None, false) => Some(description.to_owned()),
                (Some(c), true) => Some(c.to_string()),
                (None, true) => None,
            }
        }
        _ => None,
    }
}

/// A reply when it is a service's: an object with a name and an id.
fn service_json(payload: &[u8]) -> Option<Value> {
    let v: Value = serde_json::from_slice(payload).ok()?;
    let ok = v.is_object()
        && v.get("name").and_then(Value::as_str).is_some()
        && v.get("id").and_then(Value::as_str).is_some();
    ok.then_some(v)
}

pub fn info_of(v: &Value, rtt: Duration) -> NatsServiceInfo {
    NatsServiceInfo {
        name: text(v, "name"),
        id: text(v, "id"),
        version: text(v, "version"),
        description: opt_text(v, "description"),
        metadata: metadata(v),
        endpoints: endpoints(v)
            .map(|e| NatsServiceEndpoint {
                name: text(e, "name"),
                subject: text(e, "subject"),
                queue_group: opt_text(e, "queue_group"),
                metadata: metadata(e),
            })
            .collect(),
        rtt_ms: rtt.as_secs_f64() * 1000.0,
    }
}

pub fn stats_of(v: &Value) -> NatsServiceStats {
    NatsServiceStats {
        name: text(v, "name"),
        id: text(v, "id"),
        version: text(v, "version"),
        started: opt_text(v, "started"),
        endpoints: endpoints(v)
            .map(|e| NatsEndpointStats {
                name: text(e, "name"),
                subject: text(e, "subject"),
                queue_group: opt_text(e, "queue_group"),
                requests: number(e, "num_requests"),
                errors: number(e, "num_errors"),
                processing_time_ns: number(e, "processing_time"),
                average_processing_time_ns: number(e, "average_processing_time"),
                last_error: last_error(e),
                data: e.get("data").filter(|d| !d.is_null()).map(Value::to_string),
            })
            .collect(),
    }
}

/// A name or id in a `$SRV` subject: one token, no wildcards.
fn token_of(field: &str, value: Option<&str>) -> Result<Option<String>, ToolError> {
    let Some(v) = value.map(str::trim).filter(|v| !v.is_empty()) else {
        return Ok(None);
    };
    if v.contains(|c: char| c == '.' || c == '*' || c == '>' || c.is_whitespace()) {
        return Err(ToolError::invalid(
            TOOL,
            field,
            "one word: no dots, spaces or wildcards",
        ));
    }
    Ok(Some(v.to_owned()))
}

/// `$SRV.<verb>[.name[.id]]`.
pub fn subject_of(verb: &str, input: &NatsServicesInput) -> Result<String, ToolError> {
    let name = token_of("name", input.name.as_deref())?;
    let id = token_of("id", input.id.as_deref())?;
    Ok(match (name, id) {
        (None, None) => format!("$SRV.{verb}"),
        (Some(n), None) => format!("$SRV.{verb}.{n}"),
        (Some(n), Some(i)) => format!("$SRV.{verb}.{n}.{i}"),
        (None, Some(_)) => {
            return Err(ToolError::invalid(
                TOOL,
                "id",
                "an id needs the service's name",
            ));
        }
    })
}

fn timeout_of(ms: Option<u32>) -> Result<Duration, ToolError> {
    match ms.unwrap_or(DEFAULT_TIMEOUT_MS) {
        0 => Err(ToolError::invalid(TOOL, "timeoutMs", "at least 1 ms")),
        ms if ms > MAX_TIMEOUT_MS => Err(ToolError::invalid(
            TOOL,
            "timeoutMs",
            format!("at most {MAX_TIMEOUT_MS} ms"),
        )),
        ms => Ok(Duration::from_millis(u64::from(ms))),
    }
}

/// Sends one request and gathers the services' replies until the timeout (or the server's "no
/// responders", which ends it at once), each with its round trip.
async fn gather(
    c: &NatsClient,
    subject: String,
    timeout: Duration,
) -> Result<Vec<(Value, Duration)>, ToolError> {
    let inbox = c.client.new_inbox();
    let mut sub = c
        .client
        .subscribe(inbox.clone())
        .await
        .map_err(|e| remote("subscribe", e))?;
    let started = Instant::now();
    c.client
        .publish_with_reply(subject, inbox, bytes::Bytes::new())
        .await
        .map_err(|e| remote("discover services", e))?;
    c.client
        .flush()
        .await
        .map_err(|e| remote("discover services", e))?;
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut out = Vec::new();
    loop {
        tokio::select! {
            () = &mut deadline => break,
            m = sub.next() => {
                let Some(m) = m else { break };
                // A status reply (503: no responders) carries no service.
                if m.status.is_some() && m.payload.is_empty() {
                    if out.is_empty() {
                        break;
                    }
                    continue;
                }
                if let Some(v) = service_json(&m.payload) {
                    out.push((v, started.elapsed()));
                }
                if out.len() >= MAX_REPLIES {
                    break;
                }
            }
        }
    }
    let _ = sub.unsubscribe().await;
    Ok(out)
}

fn by_name_and_id<T>(key: impl Fn(&T) -> (&str, &str)) -> impl FnMut(&T, &T) -> std::cmp::Ordering {
    move |a, b| key(a).cmp(&key(b))
}

// ---- Procedures ------------------------------------------------------------------------------

/// `nats.services.*`.
pub struct NatsServicesApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.services")]
impl NatsServicesApi {
    /// The services that answer `$SRV.INFO` within the timeout, by name and id.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn discover(
        &self,
        ctx: Ctx,
        input: NatsServicesInput,
    ) -> ToolResult<Vec<NatsServiceInfo>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = subject_of("INFO", &input)?;
        let timeout = timeout_of(input.timeout_ms)?;
        let mut out: Vec<NatsServiceInfo> = gather(&h.value, subject, timeout)
            .await?
            .iter()
            .map(|(v, rtt)| info_of(v, *rtt))
            .collect();
        out.sort_by(by_name_and_id(|s: &NatsServiceInfo| (&s.name, &s.id)));
        Ok(out)
    }

    /// Every endpoint's counters of the services that answer `$SRV.STATS`.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn stats(&self, ctx: Ctx, input: NatsServicesInput) -> ToolResult<Vec<NatsServiceStats>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = subject_of("STATS", &input)?;
        let timeout = timeout_of(input.timeout_ms)?;
        let mut out: Vec<NatsServiceStats> = gather(&h.value, subject, timeout)
            .await?
            .iter()
            .map(|(v, _)| stats_of(v))
            .collect();
        out.sort_by(by_name_and_id(|s: &NatsServiceStats| (&s.name, &s.id)));
        Ok(out)
    }

    /// The services that answer `$SRV.PING`, each with its round trip.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn ping(&self, ctx: Ctx, input: NatsServicesInput) -> ToolResult<Vec<NatsServicePing>> {
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let subject = subject_of("PING", &input)?;
        let timeout = timeout_of(input.timeout_ms)?;
        let mut out: Vec<NatsServicePing> = gather(&h.value, subject, timeout)
            .await?
            .iter()
            .map(|(v, rtt)| NatsServicePing {
                name: text(v, "name"),
                id: text(v, "id"),
                version: text(v, "version"),
                rtt_ms: rtt.as_secs_f64() * 1000.0,
            })
            .collect();
        out.sort_by(by_name_and_id(|s: &NatsServicePing| (&s.name, &s.id)));
        Ok(out)
    }
}

/// Mounts `nats.services.*`.
pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsServicesApi(Arc::clone(hub)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input(name: Option<&str>, id: Option<&str>) -> NatsServicesInput {
        NatsServicesInput {
            conn_id: "c".into(),
            name: name.map(Into::into),
            id: id.map(Into::into),
            timeout_ms: None,
        }
    }

    #[test]
    fn subjects_name_the_service_and_instance() {
        assert_eq!(subject_of("PING", &input(None, None)).unwrap(), "$SRV.PING");
        assert_eq!(
            subject_of("INFO", &input(Some("echo"), None)).unwrap(),
            "$SRV.INFO.echo"
        );
        assert_eq!(
            subject_of("STATS", &input(Some("echo"), Some("abc"))).unwrap(),
            "$SRV.STATS.echo.abc"
        );
        assert_eq!(
            subject_of("PING", &input(None, Some("abc")))
                .unwrap_err()
                .field
                .as_deref(),
            Some("id")
        );
        assert!(subject_of("PING", &input(Some("a.b"), None)).is_err());
        assert!(subject_of("PING", &input(Some("*"), None)).is_err());
        assert_eq!(timeout_of(None).unwrap(), Duration::from_secs(2));
        assert!(timeout_of(Some(0)).is_err());
        assert!(timeout_of(Some(MAX_TIMEOUT_MS + 1)).is_err());
    }

    #[test]
    fn info_replies_are_read() {
        let v = json!({
            "type": "io.nats.micro.v1.info_response",
            "name": "echo", "id": "x1", "version": "1.0.0",
            "description": "Echoes", "metadata": { "team": "lab", "n": 2 },
            "endpoints": [
                { "name": "echo", "subject": "lab.echo", "queue_group": "q", "metadata": null },
                { "name": "upper", "subject": "lab.echo.upper" }
            ]
        });
        let i = info_of(&v, Duration::from_millis(3));
        assert_eq!(i.name, "echo");
        assert_eq!(i.metadata["n"], "2");
        assert_eq!(i.endpoints.len(), 2);
        assert_eq!(i.endpoints[0].queue_group.as_deref(), Some("q"));
        assert_eq!(i.endpoints[1].queue_group, None);
        assert!((i.rtt_ms - 3.0).abs() < 0.01);
    }

    #[test]
    fn stats_replies_are_read_from_every_client() {
        let go = json!({
            "name": "echo", "id": "x1", "version": "1.0.0", "started": "2026-11-19T10:00:00Z",
            "endpoints": [{ "name": "echo", "subject": "lab.echo", "queue_group": "q",
                "num_requests": 4, "num_errors": 1, "processing_time": 2000,
                "average_processing_time": 500, "last_error": "500 boom", "data": { "k": 1 } }]
        });
        let s = stats_of(&go);
        let e = &s.endpoints[0];
        assert_eq!((e.requests, e.errors), (4, 1));
        assert_eq!(e.processing_time_ns, 2000);
        assert_eq!(e.last_error.as_deref(), Some("500 boom"));
        assert_eq!(e.data.as_deref(), Some("{\"k\":1}"));
        assert_eq!(s.started.as_deref(), Some("2026-11-19T10:00:00Z"));
        let rust = json!({ "name": "a", "id": "b", "version": "1",
            "endpoints": [{ "name": "e", "subject": "s", "last_error": { "code": 503, "description": "busy" } }] });
        assert_eq!(
            stats_of(&rust).endpoints[0].last_error.as_deref(),
            Some("503 busy")
        );
        let none = json!({ "name": "a", "id": "b", "endpoints": [{ "last_error": "" }] });
        assert_eq!(stats_of(&none).endpoints[0].last_error, None);
    }

    #[test]
    fn only_service_replies_count() {
        assert!(service_json(br#"{"name":"echo","id":"1"}"#).is_some());
        assert!(service_json(b"hello").is_none());
        assert!(service_json(br#"{"name":"echo"}"#).is_none());
        assert!(service_json(b"[]").is_none());
    }
}
