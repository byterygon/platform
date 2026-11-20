//! The codec endpoint (TSK-103, spec "a codec server for External Storage on S3", §4 and §5):
//! Temporal's codec-server protocol at `POST /codec/<profileId>/decode` and `/encode`, for the
//! Temporal Web UI, the `temporal` CLI and anything else that speaks it.
//!
//! - A profile is served while Mightyconsole has it connected with "Serve as a codec endpoint" on;
//!   otherwise 503. Profiles and their secrets live in the browser; the server keeps nothing.
//! - Every request names its namespace (`X-Namespace`). Temporal decides who may use it:
//!   `DescribeNamespace` goes to the profile's frontend over the profile's connection with the
//!   caller's `Authorization` header (none when the caller sent none) in place of the profile's
//!   API key; a refusal is 403. The outcome is cached for 60 s per (token hash, namespace).
//! - Browsers must come from the profile's allowed origins; callers without an Origin (the CLI)
//!   are accepted. CORS answers only those origins.
//! - Decode swaps External Storage references for the stored payloads; encode stores payloads at
//!   or over the threshold. Anything else passes unchanged. Limits: a 4 MiB request, 100 payloads.
//! - One line per call on stderr: profile, operation, namespace, origin, count, outcome, time.
//!   Never payload data, keys or tokens.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tonic::metadata::MetadataValue;

use super::client::TemporalClient;
use super::extstore::{ExtError, reference_of_payload};
use super::proto::temporal::api::common::v1::Payload;
use super::proto::temporal::api::common::v1::payload::ExternalPayloadDetails;
use super::proto::temporal::api::workflowservice::v1 as ws;
use super::proto::temporal::api::workflowservice::v1::workflow_service_client::WorkflowServiceClient;

const MAX_BODY: usize = 4 * 1024 * 1024;
const MAX_PAYLOADS: usize = 100;
const AUTH_TTL: Duration = Duration::from_secs(60);

/// What a connected profile serves.
pub struct CodecProfile {
    pub name: String,
    pub allowed_origins: Vec<String>,
    /// `(token hash, namespace)` → when Temporal last allowed it.
    allowed: Mutex<HashMap<(String, String), Instant>>,
}

impl CodecProfile {
    pub fn new(name: String, allowed_origins: Vec<String>) -> CodecProfile {
        CodecProfile {
            name,
            allowed_origins: allowed_origins
                .into_iter()
                .map(|o| o.trim().trim_end_matches('/').to_ascii_lowercase())
                .filter(|o| !o.is_empty())
                .collect(),
            allowed: Mutex::new(HashMap::new()),
        }
    }
}

/// The served profiles: profile id → its live client (dropped with the connection).
fn registry() -> &'static Mutex<HashMap<String, Weak<TemporalClient>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Weak<TemporalClient>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Serves `client` at `/codec/<profile_id>/…` until its connection goes.
pub fn register(profile_id: &str, client: &Arc<TemporalClient>) {
    let mut map = registry().lock().expect("the codec registry lock");
    map.retain(|_, weak| weak.strong_count() > 0);
    map.insert(profile_id.to_owned(), Arc::downgrade(client));
}

fn lookup(profile_id: &str) -> Option<Arc<TemporalClient>> {
    registry()
        .lock()
        .expect("the codec registry lock")
        .get(profile_id)
        .and_then(Weak::upgrade)
}

/// The codec routes, for the TLS listener and the optional plain loopback one.
pub fn routes() -> Router {
    Router::new()
        .route("/codec/{profile}/{operation}", any(handle))
        .layer(DefaultBodyLimit::max(MAX_BODY))
}

struct Outcome {
    status: StatusCode,
    body: Value,
}

fn fail(status: u16, message: impl Into<String>) -> Outcome {
    Outcome {
        status: StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY),
        body: json!({ "message": message.into() }),
    }
}

async fn handle(
    Path((profile_id, operation)): Path<(String, String)>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let started = Instant::now();
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|o| o.trim_end_matches('/').to_ascii_lowercase());
    let namespace = headers
        .get("x-namespace")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let client = lookup(&profile_id);
    let codec = client.as_ref().and_then(|c| c.codec.as_ref());
    // CORS only for the profile's origins.
    let cors_origin = match (&origin, codec) {
        (Some(o), Some(c)) if c.allowed_origins.iter().any(|a| a == o) => Some(o.clone()),
        _ => None,
    };
    let outcome = if method == Method::OPTIONS {
        if cors_origin.is_some() {
            Outcome {
                status: StatusCode::NO_CONTENT,
                body: Value::Null,
            }
        } else {
            fail(403, "this origin is not allowed for the profile")
        }
    } else if method != Method::POST {
        fail(405, "use POST")
    } else if operation != "decode" && operation != "encode" {
        fail(404, "the codec endpoint has /decode and /encode")
    } else {
        match (&client, codec) {
            (Some(client), Some(_)) if origin.is_some() && cors_origin.is_none() => {
                let _ = client;
                fail(
                    403,
                    "this origin is not allowed for the profile; add it to the profile's allowed origins",
                )
            }
            (Some(client), Some(codec)) => {
                serve(client, codec, &operation, &namespace, &headers, &body).await
            }
            _ => fail(
                503,
                "this profile is not connected in Mightyconsole with the codec endpoint on; open Mightyconsole and connect it",
            ),
        }
    };
    let count = outcome
        .body
        .get("payloads")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    eprintln!(
        "mightyconsole-server: codec {} {operation} namespace={} origin={} payloads={count} -> {} in {} ms",
        codec.map_or("(not connected)", |c| c.name.as_str()),
        if namespace.is_empty() {
            "-"
        } else {
            &namespace
        },
        origin.as_deref().unwrap_or("-"),
        outcome.status.as_u16(),
        started.elapsed().as_millis()
    );
    let mut response = if outcome.status == StatusCode::NO_CONTENT {
        outcome.status.into_response()
    } else {
        (
            outcome.status,
            [(header::CONTENT_TYPE, "application/json")],
            outcome.body.to_string(),
        )
            .into_response()
    };
    if let Some(o) = cors_origin.and_then(|o| HeaderValue::from_str(&o).ok()) {
        let h = response.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        h.insert(
            header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
            HeaderValue::from_static("true"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("POST, OPTIONS"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("content-type, x-namespace, authorization, caller-type"),
        );
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        h.insert(header::VARY, HeaderValue::from_static("origin"));
    }
    response
}

async fn serve(
    client: &TemporalClient,
    codec: &CodecProfile,
    operation: &str,
    namespace: &str,
    headers: &HeaderMap,
    body: &[u8],
) -> Outcome {
    if namespace.is_empty() {
        return fail(400, "name the namespace in the X-Namespace header");
    }
    let Some(store) = client.external.as_deref() else {
        return fail(424, "the profile has no External Storage set up");
    };
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    if let Err(e) = authorize(client, codec, namespace, authorization).await {
        return e;
    }
    let payloads = match parse(body) {
        Ok(p) => p,
        Err(e) => return e,
    };
    let mut out = Vec::with_capacity(payloads.len());
    for (i, payload) in payloads.into_iter().enumerate() {
        let result = if operation == "decode" {
            match reference_of_payload(&payload) {
                Some(reference) => store
                    .retrieve(namespace, &reference)
                    .await
                    .map(|p| (*p).clone()),
                None => Ok(payload),
            }
        } else {
            store.store(payload).await
        };
        match result {
            Ok(p) => out.push(payload_json(&p)),
            Err(ExtError { status, message }) => {
                return fail(status, format!("payload {i}: {message}"));
            }
        }
    }
    Outcome {
        status: StatusCode::OK,
        body: json!({ "payloads": out }),
    }
}

/// Temporal decides: `DescribeNamespace` with the caller's token over the profile's connection.
async fn authorize(
    client: &TemporalClient,
    codec: &CodecProfile,
    namespace: &str,
    authorization: Option<&str>,
) -> Result<(), Outcome> {
    let token_hash = super::s3::hex(&Sha256::digest(authorization.unwrap_or("").as_bytes()));
    let key = (token_hash, namespace.to_owned());
    if let Some(at) = codec.allowed.lock().expect("the auth cache lock").get(&key)
        && at.elapsed() < AUTH_TTL
    {
        return Ok(());
    }
    let mut request = tonic::Request::new(ws::DescribeNamespaceRequest {
        namespace: namespace.to_owned(),
        ..Default::default()
    });
    request.set_timeout(super::client::CALL_TIMEOUT);
    let metadata = request.metadata_mut();
    if let Ok(v) = MetadataValue::try_from(namespace) {
        metadata.insert("temporal-namespace", v);
    }
    if let Some(auth) = authorization {
        match MetadataValue::try_from(auth) {
            Ok(v) => {
                metadata.insert("authorization", v);
            }
            Err(_) => {
                return Err(fail(
                    400,
                    "the Authorization header has characters gRPC cannot carry",
                ));
            }
        }
    }
    metadata.insert("client-name", MetadataValue::from_static("mightyconsole"));
    match WorkflowServiceClient::new(client.channel.clone())
        .describe_namespace(request)
        .await
    {
        Ok(_) => {
            codec
                .allowed
                .lock()
                .expect("the auth cache lock")
                .insert(key, Instant::now());
            Ok(())
        }
        Err(status) => Err(match status.code() {
            tonic::Code::PermissionDenied | tonic::Code::Unauthenticated => fail(
                403,
                format!(
                    "Temporal refused namespace {namespace}: {}",
                    status.message()
                ),
            ),
            tonic::Code::NotFound => fail(404, format!("namespace {namespace} does not exist")),
            _ => fail(
                502,
                format!("Temporal did not answer: {}", status.message()),
            ),
        }),
    }
}

/// The payloads of a codec answer, or why they cannot be read (the codec client's side).
pub(super) fn parse_payloads(body: &[u8]) -> Result<Vec<Payload>, String> {
    parse(body).map_err(|o| {
        o.body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("not codec JSON")
            .to_owned()
    })
}

/// `{ "payloads": [{ "metadata": { k: base64 }, "data": base64, "externalPayloads"?: [...] }] }`.
fn parse(body: &[u8]) -> Result<Vec<Payload>, Outcome> {
    let value: Value =
        serde_json::from_slice(body).map_err(|e| fail(400, format!("not JSON: {e}")))?;
    let items = value
        .get("payloads")
        .and_then(Value::as_array)
        .ok_or_else(|| fail(400, "expected { \"payloads\": [...] }"))?;
    if items.len() > MAX_PAYLOADS {
        return Err(fail(
            413,
            format!("at most {MAX_PAYLOADS} payloads per call"),
        ));
    }
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let bad = |what: &str| fail(400, format!("payload {i}: {what}"));
            let mut metadata = HashMap::new();
            if let Some(m) = item.get("metadata") {
                for (k, v) in m
                    .as_object()
                    .ok_or_else(|| bad("metadata is not an object"))?
                {
                    let bytes = BASE64
                        .decode(
                            v.as_str()
                                .ok_or_else(|| bad("a metadata value is not base64 text"))?,
                        )
                        .map_err(|_| bad("a metadata value is not base64"))?;
                    metadata.insert(k.clone(), bytes);
                }
            }
            let data = match item.get("data") {
                Some(Value::String(s)) => {
                    BASE64.decode(s).map_err(|_| bad("data is not base64"))?
                }
                Some(Value::Null) | None => Vec::new(),
                Some(_) => return Err(bad("data is not base64 text")),
            };
            let external_payloads = item
                .get("externalPayloads")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|d| ExternalPayloadDetails {
                            size_bytes: d
                                .get("sizeBytes")
                                .and_then(|s| s.as_i64().or_else(|| s.as_str()?.parse().ok()))
                                .unwrap_or(0),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(Payload {
                metadata,
                data,
                external_payloads,
            })
        })
        .collect()
}

pub(super) fn payload_json(p: &Payload) -> Value {
    let mut out = Map::new();
    let metadata: Map<String, Value> = p
        .metadata
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(BASE64.encode(v))))
        .collect();
    out.insert("metadata".into(), Value::Object(metadata));
    out.insert("data".into(), Value::String(BASE64.encode(&p.data)));
    if !p.external_payloads.is_empty() {
        out.insert(
            "externalPayloads".into(),
            Value::Array(
                p.external_payloads
                    .iter()
                    .map(|d| json!({ "sizeBytes": d.size_bytes.to_string() }))
                    .collect(),
            ),
        );
    }
    Value::Object(out)
}

#[cfg(test)]
mod tests {
    use super::super::extstore;
    use super::*;

    #[test]
    fn the_wire_form_round_trips() {
        let p = extstore::reference_payload(
            extstore::DEFAULT_DRIVER,
            &[
                ("bucket".to_owned(), "b".to_owned()),
                ("key".to_owned(), "v0/d/sha256/x".to_owned()),
            ]
            .into_iter()
            .collect(),
            42,
        );
        let body = json!({ "payloads": [payload_json(&p)] }).to_string();
        let parsed = match parse(body.as_bytes()) {
            Ok(p) => p,
            Err(e) => panic!("{}", e.body),
        };
        assert_eq!(parsed, vec![p]);
    }

    #[test]
    fn bad_bodies_are_400_and_too_many_413() {
        let status = |body: &str| match parse(body.as_bytes()) {
            Ok(_) => 200,
            Err(e) => e.status.as_u16(),
        };
        assert_eq!(status("nope"), 400);
        assert_eq!(status("{}"), 400);
        assert_eq!(
            status(r#"{"payloads":[{"metadata":{"encoding":"!!"}}]}"#),
            400
        );
        let many = json!({ "payloads": vec![json!({}); MAX_PAYLOADS + 1] }).to_string();
        assert_eq!(status(&many), 413);
        assert_eq!(status(r#"{"payloads":[]}"#), 200);
    }

    #[test]
    fn origins_are_normalised() {
        let c = CodecProfile::new(
            "lab".into(),
            vec!["http://LOCALHOST:8233/".into(), " ".into()],
        );
        assert_eq!(c.allowed_origins, vec!["http://localhost:8233".to_owned()]);
    }
}
