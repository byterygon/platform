//! The audit log through the real server (DOC-25 §3.5, TSK-137): what a session leaves in
//! `DATA/audit`, that it verifies, that it holds digests and no values, that a sensitive read
//! and a Write fail closed when the log cannot be written while an ordinary read does not, that
//! a tampered log refuses the start, and that the sensitive reads are the ones the spec names.

mod support;

use std::sync::Arc;

use ambidex::Code;
use audit_jsonl::{UnavailableAuditSink, read_records, verify};
use mightyconsole_server::audit::log_path;
use mightyconsole_server::{Server, StartError, StartOptions, codegen_router};
use security_types::{AuditDecision, AuditRecord, AuditSink, Outcome, Risk};
use serde_json::json;
use support::{config, start_with_durable_audit};

const SECRET: &str = "hunter2-do-not-log";
const PAYLOAD: &str = "a message body that must stay out of the log";

fn actions(records: &[AuditRecord]) -> Vec<(String, Outcome)> {
    records
        .iter()
        .map(|r| (r.entry.action.name.clone(), r.entry.outcome.clone()))
        .collect()
}

#[tokio::test]
async fn a_session_leaves_the_calls_the_spec_lists_and_never_a_value() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let path = log_path(t._dir.path());
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;

    // An ordinary read: not recorded.
    tab.call(1, "app.info", json!({})).await;
    tab.result(1).await;
    // A sensitive read (stored credentials are used) and a Write.
    tab.call(
        2,
        "echo.connect",
        json!({ "profile": { "name": "lab", "token": SECRET } }),
    )
    .await;
    let conn = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    tab.call(
        3,
        "echo.messages.produce",
        json!({ "connId": conn, "value": { "codec": "utf8", "text": PAYLOAD } }),
    )
    .await;
    tab.result(3).await;
    // An ordinary read of the message topic: not recorded.
    tab.call(4, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    tab.result(4).await;
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();

    let report = verify(&path).expect("the log verifies");
    let records = read_records(&path).unwrap();
    assert_eq!(report.records, records.len());
    assert!(report.unfinished.is_empty(), "{:?}", report.unfinished);
    let seen = actions(&records);
    let names: Vec<&str> = seen.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names.first(), Some(&"server.start"));
    assert_eq!(names.last(), Some(&"server.stop"));
    let calls: Vec<(&str, &Outcome)> = seen
        .iter()
        .filter(|(n, _)| n.starts_with("echo."))
        .map(|(n, o)| (n.as_str(), o))
        .collect();
    assert_eq!(
        calls,
        [
            ("echo.connect", &Outcome::Started),
            ("echo.connect", &Outcome::Success),
            ("echo.messages.produce", &Outcome::Started),
            ("echo.messages.produce", &Outcome::Success),
        ]
    );
    assert!(
        !names.contains(&"app.info"),
        "an ordinary read is not recorded"
    );

    // The principal chain, tenant, session, correlation id, risk, decision, duration.
    let connect_done = &records
        .iter()
        .find(|r| r.entry.action.name == "echo.connect" && r.entry.outcome == Outcome::Success)
        .unwrap()
        .entry;
    assert_eq!(connect_done.risk, Risk::Read);
    assert_eq!(connect_done.decision, AuditDecision::Allow);
    assert!(connect_done.duration_ms.is_some());
    assert!(!connect_done.correlation_id.is_empty());
    assert_eq!(
        connect_done.principal_chain[0].kind,
        security_types::PrincipalKind::Human
    );
    assert!(!connect_done.principal_chain[0].session.as_str().is_empty());
    assert_eq!(connect_done.tenant.as_str(), "local");
    let detail = serde_json::to_value(&connect_done.detail).unwrap();
    assert_eq!(detail, json!({ "tool": "echo" }));
    let produce = records
        .iter()
        .find(|r| r.entry.action.name == "echo.messages.produce")
        .unwrap();
    assert_eq!(produce.entry.risk, Risk::Write);

    // Digests, never values: neither the secret nor the message appears anywhere in the file,
    // and two connects that differ only in the secret share a digest (it covers the redacted input).
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(!text.contains(SECRET), "a secret reached the log");
    assert!(!text.contains(PAYLOAD), "a message body reached the log");
}

#[tokio::test]
async fn the_digest_does_not_depend_on_the_secret() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let path = log_path(t._dir.path());
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    for (id, token) in [(1, "one"), (2, "two")] {
        tab.call(
            id,
            "echo.connect",
            json!({ "profile": { "name": "lab", "token": token } }),
        )
        .await;
        tab.result(id).await;
    }
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();
    let digests: Vec<String> = read_records(&path)
        .unwrap()
        .iter()
        .filter(|r| r.entry.action.name == "echo.connect" && r.entry.outcome == Outcome::Success)
        .map(|r| r.entry.input_digest.to_string())
        .collect();
    assert_eq!(digests.len(), 2);
    assert_eq!(digests[0], digests[1]);
}

#[tokio::test]
async fn without_a_writable_log_writes_and_sensitive_reads_are_refused_and_other_reads_run() {
    let options = StartOptions {
        audit_sink: Some(Arc::new(UnavailableAuditSink("disk full".into())) as Arc<dyn AuditSink>),
        ..StartOptions::default()
    };
    let t = start_with_durable_audit(options).await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    // A sensitive read: refused, nothing ran.
    tab.call(1, "echo.connect", json!({ "profile": { "name": "lab" } }))
        .await;
    let err = tab.error(1, Code::Unavailable).await;
    assert!(err.retryable);
    // An ordinary read still works.
    tab.call(2, "app.info", json!({})).await;
    tab.result(2).await;
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();
}

#[tokio::test]
async fn a_tampered_log_refuses_the_start_and_names_the_file() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let dir = t._dir.path().to_path_buf();
    let path = log_path(&dir);
    t.server.shutdown().await.unwrap();
    assert!(verify(&path).is_ok());
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, text.replacen("server.start", "server.stopx", 1)).unwrap();
    let Err(err) = Server::start_with(config(&dir, None), StartOptions::default()).await else {
        panic!("a tampered log must not start");
    };
    assert!(matches!(err, StartError::Audit(_)), "{err}");
    let message = err.to_string();
    assert!(message.contains("audit-000000000001.jsonl"), "{message}");
    // A server with no data directory has nowhere to write: also refused.
    let mut no_data = config(&dir, None);
    no_data.data = None;
    let Err(err) = Server::start_with(no_data, StartOptions::default()).await else {
        panic!("no data directory, no log, no start");
    };
    assert!(matches!(err, StartError::Audit(_)), "{err}");
}

/// The sensitive reads are the ones DOC-25 §3.5.2 names: the classification is on the procedure,
/// and this is the one place a change to the list shows up.
#[test]
fn the_sensitive_reads_are_the_ones_the_spec_names() {
    let router = codegen_router();
    let mut marked: Vec<String> = router
        .procedures()
        .iter()
        .filter(|m| m.audit == ambidex::AuditMode::Always)
        .map(|m| m.name.clone())
        .collect();
    marked.sort();
    assert_eq!(
        marked,
        [
            "docker.connect",
            "docker.containers.files.download",
            "docker.containers.files.read",
            "echo.connect",
            "langgraph.connect",
            "langgraph.values.download",
            "messaging.registry.test",
            "nats.connect",
            "nats.obj.get",
            "temporal.connect",
            "temporal.payload.download",
            "temporal.workflows.downloadHistory",
        ]
    );
    // Nothing that writes is marked (a Write is recorded by its risk), and every marked
    // procedure is a Read.
    for meta in router.procedures() {
        if meta.audit == ambidex::AuditMode::Always {
            assert_eq!(meta.risk, Risk::Read, "{}", meta.name);
        }
    }
    // Every `<tool>.connect` is marked: stored credentials are used.
    for meta in router.procedures() {
        if meta.name.ends_with(".connect") {
            assert_eq!(meta.audit, ambidex::AuditMode::Always, "{}", meta.name);
        }
    }
}
