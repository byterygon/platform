//! What a profile may make the server reach (TSK-141; DOC-25 §3.7, Open question 27), per tool
//! over the wire: by default the cloud metadata address is refused by every tool's connection
//! (NATS, its Schema Registry, Temporal's frontend, codec endpoint and external storage, Docker
//! over SSH, LangGraph), and with `[outbound] allow` narrowed an address outside it is refused
//! too. The refusal comes from the policy, before anything is sent.
//!
//! One test in this file: the policy is the process's.

mod support;

use mightyconsole_server::StartOptions;
use mightyconsole_server::core::outbound::{Policy, Rule};
use serde_json::{Value, json};
use support::*;

/// A draft of each tool's profile reaching `host` (an address, a name).
fn drafts(host: &str) -> Vec<(&'static str, &'static str, Value, Value)> {
    vec![
        (
            "nats.test",
            "nats",
            json!({ "servers": [format!("nats://{host}:4222")] }),
            json!({}),
        ),
        (
            "messaging.registry.test",
            "nats",
            json!({ "servers": [format!("nats://{host}:4222")],
                    "schemaRegistry": { "url": format!("http://{host}:8081") } }),
            json!({}),
        ),
        (
            "temporal.test",
            "temporal",
            json!({ "address": format!("{host}:7233"), "namespace": "default" }),
            json!({}),
        ),
        (
            "temporal.testCodec",
            "temporal",
            json!({ "address": format!("{host}:7233"), "namespace": "default",
                    "codec": { "enabled": true, "endpoint": format!("http://{host}:8888") } }),
            json!({}),
        ),
        (
            "docker.test",
            "docker",
            json!({ "transport": "ssh", "host": host, "port": 22, "username": "u", "auth": "password" }),
            json!({ "password": "p" }),
        ),
        (
            "langgraph.test",
            "langgraph",
            json!({ "url": format!("http://{host}:2024") }),
            json!({}),
        ),
    ]
}

/// Every tool's Test connection to `host`: the answers, by procedure.
async fn tests_to(t: &TestServer, host: &str) -> Vec<(String, Value)> {
    let browser = t.browser_as("human:account:reach", &[]).await;
    let mut tab = t.tab(&browser).await;
    let mut out = Vec::new();
    for (n, (procedure, tool, fields, secrets)) in drafts(host).into_iter().enumerate() {
        let id = n as u32 + 1;
        let input = if procedure == "messaging.registry.test" {
            json!({ "tool": tool, "draft": { "name": "r", "fields": fields, "secrets": secrets } })
        } else {
            json!({ "draft": { "name": "r", "fields": fields, "secrets": secrets } })
        };
        tab.call(id, procedure, input).await;
        let frame = tab.frame(id).await;
        out.push((
            procedure.to_owned(),
            serde_json::from_slice(&frame.payload).unwrap_or(Value::Null),
        ));
    }
    tab.disconnect().await;
    out
}

#[tokio::test]
async fn every_tool_connects_through_the_outbound_policy() {
    // By default: the metadata address is refused by every tool, from the policy.
    let t = start_with(None, StartOptions::default()).await;
    for (procedure, answer) in tests_to(&t, "169.254.169.254").await {
        let message = answer["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("cloud metadata"),
            "{procedure} reached 169.254.169.254: {answer}"
        );
    }
    t.server.shutdown().await.unwrap();

    // Narrowed to 10.0.0.0/8: loopback, reached by default, is refused now.
    let t = start_configured(None, StartOptions::default(), |config| {
        config.outbound = Policy::new(vec![Rule::parse("10.0.0.0/8").unwrap()], vec![]);
    })
    .await;
    for (procedure, answer) in tests_to(&t, "127.0.0.1").await {
        let message = answer["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("[outbound] allow"),
            "{procedure} reached 127.0.0.1 outside the allow rules: {answer}"
        );
    }
    t.server.shutdown().await.unwrap();

    // And denied by name.
    let t = start_configured(None, StartOptions::default(), |config| {
        config.outbound = Policy::new(vec![], vec![Rule::parse("localhost").unwrap()]);
    })
    .await;
    for (procedure, answer) in tests_to(&t, "localhost").await {
        let message = answer["message"].as_str().unwrap_or_default();
        assert!(
            message.contains("[outbound] deny"),
            "{procedure} reached a denied host: {answer}"
        );
    }
    t.server.shutdown().await.unwrap();
}
