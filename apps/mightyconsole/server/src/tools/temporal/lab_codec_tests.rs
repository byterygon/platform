//! The codec endpoint against the lab (TSK-103): Temporal's codec-server protocol over HTTP, as the
//! Web UI and the CLI call it, with the lab's External Storage (SeaweedFS).
//!
//! ```sh
//! pnpm --filter @byterygon/mightyconsole lab up temporal
//! cargo test -p mightyconsole-server --features lab-tests temporal::lab_codec_tests
//! ```

use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request};
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

use super::client::{self, TemporalClient};
use super::codec;
use super::detail::raw_event;
use super::types::ConnectTemporalProfile;

const WEB_UI: &str = "http://localhost:8233";

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn s3() -> Value {
    let text = std::fs::read_to_string(generated().join("credentials.json"))
        .expect("lab/.generated/credentials.json: run `lab up temporal` first");
    serde_json::from_str::<Value>(&text).unwrap()["temporal"]["externalStorage"].clone()
}

async fn lab_client() -> Arc<TemporalClient> {
    let s3 = s3();
    let profile: ConnectTemporalProfile = serde_json::from_value(json!({
        "name": "lab", "address": "127.0.0.1:7233", "namespace": "lab",
        "externalStorage": { "enabled": true, "bucket": s3["bucket"], "endpoint": s3["endpoint"], "region": s3["region"], "pathStyle": true },
        "s3AccessKeyId": s3["accessKeyId"], "s3SecretAccessKey": s3["secretAccessKey"],
        "codecServer": { "enabled": true, "allowedOrigins": [WEB_UI] },
    }))
    .unwrap();
    Arc::new(
        client::connect(&profile)
            .await
            .expect("the lab's Temporal is up: `lab up temporal`"),
    )
}

/// The codec routes on an ephemeral loopback port.
async fn serve() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let _ = axum::serve(listener, codec::routes()).await;
    });
    format!("http://{addr}")
}

struct Reply {
    status: u16,
    headers: hyper::HeaderMap,
    body: Value,
}

async fn call(method: Method, url: &str, headers: &[(&str, &str)], body: Option<&Value>) -> Reply {
    let http = Client::builder(TokioExecutor::new()).build_http::<Full<Bytes>>();
    let mut request = Request::builder().method(method).uri(url);
    for (k, v) in headers {
        request = request.header(*k, *v);
    }
    let body = body.map(|b| Bytes::from(b.to_string())).unwrap_or_default();
    let response = http
        .request(request.body(Full::new(body)).unwrap())
        .await
        .unwrap();
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    Reply {
        status,
        headers,
        body: serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    }
}

/// big-payload-1's input as stored: a reference.
async fn stored_input(client: &TemporalClient) -> Value {
    let raw = raw_event(client, serde_json::from_value(json!({ "connId": "", "namespace": "lab", "workflowId": "big-payload-1", "eventId": 1 })).unwrap())
        .await
        .unwrap();
    serde_json::to_value(&raw).unwrap()["attributes"]["input"]["payloads"][0].clone()
}

fn text(v: &Value) -> String {
    String::from_utf8(BASE64.decode(v.as_str().unwrap()).unwrap()).unwrap()
}

#[tokio::test]
async fn decode_swaps_a_reference_for_the_stored_payload() {
    let client = lab_client().await;
    codec::register("lab-codec-decode", &client);
    let base = serve().await;
    let reference = stored_input(&client).await;
    let reply = call(Method::POST, &format!("{base}/codec/lab-codec-decode/decode"), &[("content-type", "application/json"), ("x-namespace", "lab")], Some(&json!({ "payloads": [reference, { "metadata": { "encoding": BASE64.encode("json/plain") }, "data": BASE64.encode("\"small\"") }] }))).await;
    assert_eq!(reply.status, 200, "{}", reply.body);
    let out = reply.body["payloads"].as_array().unwrap();
    assert_eq!(text(&out[0]["metadata"]["encoding"]), "json/plain");
    let input: Value = serde_json::from_str(&text(&out[0]["data"])).unwrap();
    assert_eq!(input["kind"], "big");
    assert_eq!(input["text"].as_str().unwrap().len(), 300 * 1024);
    // Anything else passes unchanged.
    assert_eq!(text(&out[1]["data"]), "\"small\"");
}

#[tokio::test]
async fn encode_stores_a_large_payload_and_decode_reads_it_back() {
    let client = lab_client().await;
    codec::register("lab-codec-encode", &client);
    let base = serve().await;
    let big = format!("\"{}\"", "e".repeat(300 * 1024));
    let payload = json!({ "metadata": { "encoding": BASE64.encode("json/plain") }, "data": BASE64.encode(&big) });
    let encoded = call(
        Method::POST,
        &format!("{base}/codec/lab-codec-encode/encode"),
        &[("x-namespace", "lab")],
        Some(&json!({ "payloads": [payload] })),
    )
    .await;
    assert_eq!(encoded.status, 200, "{}", encoded.body);
    let reference = &encoded.body["payloads"][0];
    assert_eq!(
        text(&reference["metadata"]["messageType"]),
        "temporal.api.sdk.v1.ExternalStorageReference"
    );
    let claim: Value = serde_json::from_str(&text(&reference["data"])).unwrap();
    assert!(
        claim["claimData"]["key"]
            .as_str()
            .unwrap()
            .starts_with("v0/d/sha256/")
    );
    let decoded = call(
        Method::POST,
        &format!("{base}/codec/lab-codec-encode/decode"),
        &[("x-namespace", "lab")],
        Some(&json!({ "payloads": [reference] })),
    )
    .await;
    assert_eq!(decoded.status, 200, "{}", decoded.body);
    assert_eq!(text(&decoded.body["payloads"][0]["data"]), big);
}

#[tokio::test]
async fn browsers_need_an_allowed_origin_and_every_call_a_namespace() {
    let client = lab_client().await;
    codec::register("lab-codec-cors", &client);
    let base = serve().await;
    let url = format!("{base}/codec/lab-codec-cors/decode");
    let empty = json!({ "payloads": [] });
    // The Web UI's preflight and call.
    let preflight = call(
        Method::OPTIONS,
        &url,
        &[
            ("origin", WEB_UI),
            ("access-control-request-method", "POST"),
        ],
        None,
    )
    .await;
    assert_eq!(preflight.status, 204);
    assert_eq!(preflight.headers["access-control-allow-origin"], WEB_UI);
    let ok = call(
        Method::POST,
        &url,
        &[("origin", WEB_UI), ("x-namespace", "lab")],
        Some(&empty),
    )
    .await;
    assert_eq!(ok.status, 200);
    assert_eq!(ok.headers["access-control-allow-credentials"], "true");
    // Another page is refused before Temporal is asked, and gets no CORS headers.
    let other = call(
        Method::POST,
        &url,
        &[("origin", "https://evil.example"), ("x-namespace", "lab")],
        Some(&empty),
    )
    .await;
    assert_eq!(other.status, 403);
    assert!(other.headers.get("access-control-allow-origin").is_none());
    assert_eq!(
        call(
            Method::OPTIONS,
            &url,
            &[("origin", "https://evil.example")],
            None
        )
        .await
        .status,
        403
    );
    // No namespace, an unknown one, an unknown profile, a wrong method.
    assert_eq!(
        call(Method::POST, &url, &[], Some(&empty)).await.status,
        400
    );
    assert_eq!(
        call(
            Method::POST,
            &url,
            &[("x-namespace", "no-such-namespace")],
            Some(&empty)
        )
        .await
        .status,
        404
    );
    let gone = call(
        Method::POST,
        &format!("{base}/codec/not-connected/decode"),
        &[("x-namespace", "lab")],
        Some(&empty),
    )
    .await;
    assert_eq!(gone.status, 503);
    assert!(gone.body["message"].as_str().unwrap().contains("connect"));
    assert_eq!(call(Method::GET, &url, &[], None).await.status, 405);
}

#[tokio::test]
async fn the_profile_is_served_only_while_connected() {
    let base = serve().await;
    {
        let client = lab_client().await;
        codec::register("lab-codec-drop", &client);
        let ok = call(
            Method::POST,
            &format!("{base}/codec/lab-codec-drop/decode"),
            &[("x-namespace", "lab")],
            Some(&json!({ "payloads": [] })),
        )
        .await;
        assert_eq!(ok.status, 200);
    }
    // The connection is gone with its last reference.
    let gone = call(
        Method::POST,
        &format!("{base}/codec/lab-codec-drop/decode"),
        &[("x-namespace", "lab")],
        Some(&json!({ "payloads": [] })),
    )
    .await;
    assert_eq!(gone.status, 503);
}
