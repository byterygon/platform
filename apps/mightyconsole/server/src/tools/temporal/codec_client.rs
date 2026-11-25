//! The profile's payload codec (TSK-92, Mightyconsole spec §9.5, Open question 45 (k)): a codec
//! server of the user's own (encryption, compression) that mightyconsole-server, never the browser,
//! calls in Temporal's codec-server JSON: `POST <endpoint>/decode` for every payload it is about to
//! show, `POST <endpoint>/encode` for the inputs it sends when "Encode inputs" is ticked.
//!
//! - Up to 100 payloads per call, the profile's `Authorization` header (a secret), `X-Namespace`
//!   when ticked; a namespace's own endpoint overrides the default.
//! - https is verified against the profile's CA only (no system roots, Open question 31); plain
//!   http only for loopback hosts.
//! - A decode failure leaves the payloads as stored with the reason (`$codecError`); nothing else on
//!   the screen fails. An encode failure fails the action: nothing is sent unencoded.
//! - Order, as the SDKs: encode, then External Storage; External Storage, then decode.

use std::collections::HashMap;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use hyper::{Method, Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};
use url::Url;

use super::proto::temporal::api::common::v1::{Payload, Payloads};
use super::types::PayloadCodecOptions;
use crate::core::tls::{TlsOptions, client_config, plain_config};
use crate::core::{ToolError, ToolErrorKind};

const MAX_PER_CALL: usize = 100;
const MAX_RESPONSE: usize = 64 * 1024 * 1024;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

type Https = hyper_rustls::HttpsConnector<crate::core::outbound::Connector>;

pub struct PayloadCodec {
    http: Client<Https, Full<Bytes>>,
    endpoint: Url,
    namespaces: HashMap<String, Url>,
    authorization: Option<String>,
    send_namespace: bool,
    pub encode_inputs: bool,
    timeout: Duration,
}

fn bad(field: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(super::TOOL, field, message)
}

/// An endpoint URL the codec may be reached at: https, or http on a loopback host.
fn endpoint_url(field: &str, text: &str) -> Result<Url, ToolError> {
    let url = Url::parse(text.trim()).map_err(|e| bad(field, format!("not a URL: {e}")))?;
    let loopback = match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => return Err(bad(field, "the URL has no host")),
    };
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        "http" => Err(bad(
            field,
            "plain http is for localhost only; use https with the codec's CA",
        )),
        _ => Err(bad(field, "use https:// (or http:// on localhost)")),
    }
}

impl PayloadCodec {
    /// The codec a profile describes, or `None` when it has none.
    pub fn from_profile(
        options: Option<&PayloadCodecOptions>,
        authorization: Option<&str>,
    ) -> Result<Option<PayloadCodec>, ToolError> {
        let Some(o) = options.filter(|o| o.enabled.unwrap_or(false)) else {
            return Ok(None);
        };
        let endpoint_text = o
            .endpoint
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .ok_or_else(|| bad("codec.endpoint", "give the codec server's URL"))?;
        let endpoint = endpoint_url("codec.endpoint", endpoint_text)?;
        let mut namespaces = HashMap::new();
        for entry in o.namespaces.iter().flatten() {
            let ns = entry.namespace.trim();
            if ns.is_empty() || entry.endpoint.trim().is_empty() {
                continue;
            }
            namespaces.insert(
                ns.to_owned(),
                endpoint_url("codec.namespaces", &entry.endpoint)?,
            );
        }
        let ca = o.ca_pem.as_deref().map(str::trim).filter(|c| !c.is_empty());
        let needs_tls =
            endpoint.scheme() == "https" || namespaces.values().any(|u| u.scheme() == "https");
        // Open question 31: the profile's CA only, never the system's roots.
        let tls = match (needs_tls, ca) {
            (true, Some(pem)) => client_config(&TlsOptions {
                enabled: Some(true),
                ca_pem: Some(pem.to_owned()),
                ..Default::default()
            })
            .map_err(|e| bad("codec.caPem", e.message))?,
            (true, None) => {
                return Err(bad(
                    "codec.caPem",
                    "an https codec needs its CA certificate (the system's roots are not used)",
                ));
            }
            (false, _) => plain_config(),
        };
        // Through the server's outbound policy (TSK-141): the address connected to is checked.
        let tcp = crate::core::outbound::Connector::new(super::TOOL, Some(Duration::from_secs(10)));
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_or_http()
            .enable_http1()
            .wrap_connector(tcp);
        Ok(Some(PayloadCodec {
            http: Client::builder(TokioExecutor::new()).build(connector),
            endpoint,
            namespaces,
            authorization: authorization
                .map(str::trim)
                .filter(|a| !a.is_empty())
                .map(str::to_owned),
            send_namespace: o.send_namespace.unwrap_or(true),
            encode_inputs: o.encode_inputs.unwrap_or(true),
            timeout: Duration::from_millis(
                o.timeout_ms
                    .unwrap_or(DEFAULT_TIMEOUT_MS)
                    .clamp(100, 120_000),
            ),
        }))
    }

    /// The endpoint a namespace's payloads go to, for labels: `codec.internal:8888`.
    pub fn label(&self, namespace: &str) -> String {
        let url = self.namespaces.get(namespace).unwrap_or(&self.endpoint);
        match url.port() {
            Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
            None => url.host_str().unwrap_or_default().to_owned(),
        }
    }

    /// One call: `/decode` or `/encode` on up to 100 payloads.
    async fn call(
        &self,
        namespace: &str,
        operation: &str,
        payloads: &[Payload],
    ) -> Result<Vec<Payload>, String> {
        let base = self.namespaces.get(namespace).unwrap_or(&self.endpoint);
        let url = format!("{}/{operation}", base.as_str().trim_end_matches('/'));
        let body = json!({ "payloads": payloads.iter().map(super::codec::payload_json).collect::<Vec<_>>() }).to_string();
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(&url)
            .header(CONTENT_TYPE, "application/json")
            .header(
                USER_AGENT,
                concat!("mightyconsole/", env!("CARGO_PKG_VERSION")),
            );
        if let Some(auth) = &self.authorization {
            request = request.header(AUTHORIZATION, auth);
        }
        if self.send_namespace {
            request = request.header("x-namespace", namespace);
        }
        let request = request
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| e.to_string())?;
        let host = self.label(namespace);
        let response = tokio::time::timeout(self.timeout, self.http.request(request))
            .await
            .map_err(|_| {
                format!(
                    "{host} did not answer within {} ms",
                    self.timeout.as_millis()
                )
            })?
            .map_err(|e| format!("{host}: {e}"))?;
        let status = response.status();
        let bytes = tokio::time::timeout(
            self.timeout,
            Limited::new(response.into_body(), MAX_RESPONSE).collect(),
        )
        .await
        .map_err(|_| {
            format!(
                "{host} did not finish its answer within {} ms",
                self.timeout.as_millis()
            )
        })?
        .map_err(|e| format!("{host}: {e}"))?
        .to_bytes();
        if status != StatusCode::OK {
            let text = String::from_utf8_lossy(&bytes);
            let message = serde_json::from_slice::<Value>(&bytes)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(format!("{host} answered {}: {message}", status.as_u16()));
        }
        let out = super::codec::parse_payloads(&bytes)
            .map_err(|m| format!("{host} answered something that is not codec JSON: {m}"))?;
        if out.len() != payloads.len() {
            return Err(format!(
                "{host} answered {} payloads for {}",
                out.len(),
                payloads.len()
            ));
        }
        Ok(out)
    }

    async fn batched(
        &self,
        namespace: &str,
        operation: &str,
        payloads: Vec<Payload>,
    ) -> Result<Vec<Payload>, String> {
        let mut out = Vec::with_capacity(payloads.len());
        for chunk in payloads.chunks(MAX_PER_CALL) {
            out.extend(self.call(namespace, operation, chunk).await?);
        }
        Ok(out)
    }

    pub async fn decode(
        &self,
        namespace: &str,
        payloads: Vec<Payload>,
    ) -> Result<Vec<Payload>, String> {
        self.batched(namespace, "decode", payloads).await
    }

    pub async fn encode(
        &self,
        namespace: &str,
        payloads: Vec<Payload>,
    ) -> Result<Vec<Payload>, String> {
        self.batched(namespace, "encode", payloads).await
    }
}

/// The encodings Mightyconsole reads without a codec.
fn plain(encoding: &str) -> bool {
    matches!(
        encoding,
        "json/plain" | "json/protobuf" | "binary/null" | "binary/plain" | "binary/protobuf"
    )
}

/// A raw-JSON payload object (as protobuf JSON: metadata and data in base64), as a Payload.
fn payload_of(object: &Map<String, Value>) -> Option<Payload> {
    let metadata = object.get("metadata")?.as_object()?;
    if !object.keys().all(|k| {
        matches!(
            k.as_str(),
            "metadata" | "data" | "externalPayloads" | "$external"
        )
    }) {
        return None;
    }
    if object
        .get("$external")
        .is_some_and(|e| e.get("error").is_some())
    {
        return None;
    }
    let metadata = metadata
        .iter()
        .map(|(k, v)| Some((k.clone(), BASE64.decode(v.as_str()?).ok()?)))
        .collect::<Option<HashMap<_, _>>>()?;
    let data = match object.get("data") {
        Some(Value::String(s)) => BASE64.decode(s).ok()?,
        None => Vec::new(),
        Some(_) => return None,
    };
    Some(Payload {
        metadata,
        data,
        external_payloads: Vec::new(),
    })
}

fn collect(value: &Value, path: String, out: &mut Vec<(String, Payload)>) {
    match value {
        Value::Object(object) => {
            if let Some(payload) = payload_of(object) {
                out.push((path, payload));
                return;
            }
            for (k, v) in object {
                collect(
                    v,
                    format!("{path}/{}", k.replace('~', "~0").replace('/', "~1")),
                    out,
                );
            }
        }
        Value::Array(items) => {
            for (i, v) in items.iter().enumerate() {
                collect(v, format!("{path}/{i}"), out);
            }
        }
        _ => {}
    }
}

/// Sends every payload in `value` (a message as raw protobuf JSON) through the codec's `/decode`.
/// One that comes back changed takes its place, marked `"$codec": { "codec", "from" }`; when the
/// codec fails, the payloads it would have had to read (not plain JSON or text) are marked
/// `"$codecError"` and stay as stored.
pub async fn decode_json(codec: Option<&PayloadCodec>, namespace: &str, value: &mut Value) {
    let Some(codec) = codec else { return };
    let mut found = Vec::new();
    collect(value, String::new(), &mut found);
    if found.is_empty() {
        return;
    }
    let (paths, payloads): (Vec<String>, Vec<Payload>) = found.into_iter().unzip();
    let label = codec.label(namespace);
    match codec.decode(namespace, payloads.clone()).await {
        Ok(decoded) => {
            for ((path, before), after) in paths.iter().zip(payloads).zip(decoded) {
                if before == after {
                    continue;
                }
                let Some(Value::Object(slot)) = value.pointer_mut(path) else {
                    continue;
                };
                let from = String::from_utf8_lossy(
                    before
                        .metadata
                        .get("encoding")
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                )
                .into_owned();
                let external = slot.remove("$external");
                let Value::Object(mut fresh) = super::codec::payload_json(&after) else {
                    continue;
                };
                fresh.remove("externalPayloads");
                if let Some(external) = external {
                    fresh.insert("$external".into(), external);
                }
                fresh.insert("$codec".into(), json!({ "codec": label, "from": from }));
                *slot = fresh;
            }
        }
        Err(message) => {
            for (path, payload) in paths.iter().zip(payloads) {
                let encoding = String::from_utf8_lossy(
                    payload
                        .metadata
                        .get("encoding")
                        .map(Vec::as_slice)
                        .unwrap_or_default(),
                )
                .into_owned();
                if plain(&encoding) {
                    continue;
                }
                if let Some(Value::Object(slot)) = value.pointer_mut(path) {
                    slot.insert(
                        "$codecError".into(),
                        json!({ "codec": label, "error": message }),
                    );
                }
            }
        }
    }
}

/// A Write action's input through the codec's `/encode` (when "Encode inputs" is ticked). A failure
/// fails the action: nothing is sent unencoded.
pub async fn encode_input(
    codec: Option<&PayloadCodec>,
    namespace: &str,
    payloads: Option<Payloads>,
) -> Result<Option<Payloads>, ToolError> {
    let (Some(codec), Some(mut payloads)) = (codec.filter(|c| c.encode_inputs), payloads.clone())
    else {
        return Ok(payloads);
    };
    let encoded = codec
        .encode(namespace, std::mem::take(&mut payloads.payloads))
        .await
        .map_err(|m| {
            ToolError::new(
                ToolErrorKind::Remote,
                super::TOOL,
                format!("Codec: the input could not be encoded, so nothing was sent: {m}"),
            )
        })?;
    payloads.payloads = encoded;
    Ok(Some(payloads))
}

/// "Test codec": connects with the draft profile, takes the first input payload of the
/// namespace's 3 latest workflows (read from External Storage when they are stored there), and
/// decodes them through the codec.
pub async fn test(
    profile: &super::types::ConnectTemporalProfile,
    namespace: Option<&str>,
) -> Result<super::types::TemporalTestCodecOutput, ToolError> {
    use super::proto::temporal::api::common::v1::WorkflowExecution;
    use super::proto::temporal::api::history::v1::history_event::Attributes;
    use super::proto::temporal::api::workflowservice::v1 as ws;

    let client = super::client::connect(profile).await?;
    let Some(codec) = client.payload_codec.as_deref() else {
        return Err(bad("codec.enabled", "turn the codec server on to test it"));
    };
    let namespace = client.namespace_or_default(namespace);
    let listed = client
        .service()
        .list_workflow_executions(client.request(
            &namespace,
            ws::ListWorkflowExecutionsRequest {
                namespace: namespace.clone(),
                page_size: 3,
                ..Default::default()
            },
        ))
        .await
        .map_err(|s| super::client::status_error(&client.address, &s))?
        .into_inner();
    let mut ids = Vec::new();
    let mut payloads = Vec::new();
    for info in listed.executions.iter().take(3) {
        let Some(execution) = info.execution.clone() else {
            continue;
        };
        let history = client
            .service()
            .get_workflow_execution_history(client.request(
                &namespace,
                ws::GetWorkflowExecutionHistoryRequest {
                    namespace: namespace.clone(),
                    execution: Some(WorkflowExecution {
                        ..execution.clone()
                    }),
                    maximum_page_size: 1,
                    ..Default::default()
                },
            ))
            .await
            .map_err(|s| super::client::status_error(&client.address, &s))?
            .into_inner();
        let first = history
            .history
            .and_then(|h| h.events.into_iter().next())
            .and_then(|e| e.attributes);
        let Some(Attributes::WorkflowExecutionStartedEventAttributes(started)) = first else {
            continue;
        };
        let Some(mut payload) = started.input.and_then(|p| p.payloads.into_iter().next()) else {
            continue;
        };
        if let (Some(store), Some(reference)) = (
            client.external.as_deref(),
            super::extstore::reference_of_payload(&payload),
        ) && let Ok(stored) = store.retrieve(&namespace, &reference).await
        {
            payload = (*stored).clone();
        }
        ids.push(execution.workflow_id);
        payloads.push(payload);
    }
    let encoding = |p: &Payload| {
        String::from_utf8_lossy(
            p.metadata
                .get("encoding")
                .map(Vec::as_slice)
                .unwrap_or_default(),
        )
        .into_owned()
    };
    let distinct = |list: Vec<String>| {
        let mut list = list;
        list.sort();
        list.dedup();
        list
    };
    let from = distinct(payloads.iter().map(encoding).collect());
    let started = std::time::Instant::now();
    let result = if payloads.is_empty() {
        Ok(Vec::new())
    } else {
        codec.decode(&namespace, payloads.clone()).await
    };
    let ms = started.elapsed().as_millis() as u64;
    let (decoded, to, error) = match result {
        Ok(out) => {
            let changed = payloads.iter().zip(&out).filter(|(a, b)| a != b).count() as u32;
            (changed, distinct(out.iter().map(encoding).collect()), None)
        }
        Err(e) => (0, Vec::new(), Some(e)),
    };
    Ok(super::types::TemporalTestCodecOutput {
        codec: codec.label(&namespace),
        namespace,
        sampled: ids.len() as u32,
        workflow_ids: ids,
        decoded,
        from,
        to,
        ms,
        error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_https_or_loopback_http() {
        assert!(endpoint_url("e", "https://codec.internal:8888").is_ok());
        assert!(endpoint_url("e", "http://127.0.0.1:8234").is_ok());
        assert!(endpoint_url("e", "http://localhost:8234/codec").is_ok());
        assert!(endpoint_url("e", "http://[::1]:8234").is_ok());
        assert!(
            endpoint_url("e", "http://codec.internal:8888")
                .unwrap_err()
                .message
                .contains("localhost only")
        );
        assert!(endpoint_url("e", "ftp://x").is_err());
    }

    #[test]
    fn an_https_codec_needs_its_ca() {
        let options: PayloadCodecOptions = serde_json::from_value(
            json!({ "enabled": true, "endpoint": "https://codec.internal:8888" }),
        )
        .unwrap();
        let e = PayloadCodec::from_profile(Some(&options), None)
            .err()
            .unwrap();
        assert_eq!(e.field.as_deref(), Some("codec.caPem"));
        let off: PayloadCodecOptions =
            serde_json::from_value(json!({ "enabled": false, "endpoint": "nonsense" })).unwrap();
        assert!(
            PayloadCodec::from_profile(Some(&off), None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn plain_payloads_are_collected_but_errors_skip_them() {
        let enc = |e: &str| BASE64.encode(e);
        let value = json!({ "input": { "payloads": [
            { "metadata": { "encoding": enc("binary/encrypted") }, "data": BASE64.encode([1, 2, 3]) },
            { "metadata": { "encoding": enc("json/plain") }, "data": BASE64.encode("1") },
            { "metadata": { "encoding": enc("json/protobuf") }, "data": "", "$external": { "error": "x" } },
        ] } });
        let mut found = Vec::new();
        collect(&value, String::new(), &mut found);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].0, "/input/payloads/0");
        assert!(!plain("binary/encrypted") && plain("json/plain"));
    }
}
