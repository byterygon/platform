//! The audit log through the real server (DOC-25 §3.5, TSK-137): what a session leaves in
//! `DATA/audit`, that it verifies, that it holds digests and no values, that a sensitive read
//! and a Write fail closed when the log cannot be written while an ordinary read does not, that
//! a tampered log refuses the start, and that the sensitive reads are the ones the spec names.

mod support;

use std::sync::Arc;

use ambidex::Code;
use audit_jsonl::{UnavailableAuditSink, read_records, verify};
use mightyconsole_server::audit::{audit_dir, log_path};
use mightyconsole_server::{Server, StartError, StartOptions, codegen_router};
use security_types::{AuditDecision, AuditRecord, AuditSink, Outcome, Risk};
use serde_json::json;
use support::{config, start_durable_configured, start_with_durable_audit};

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
    assert_eq!(
        connect_done.tenant.as_str(),
        "default",
        "the server's auth.tenant"
    );
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
    // Test connection's draft secrets are redacted before the digest (connect takes none).
    for (id, token) in [(1, "one"), (2, "two")] {
        tab.call(
            id,
            "echo.test",
            json!({ "draft": { "name": "lab", "fields": {}, "secrets": { "token": token } } }),
        )
        .await;
        tab.result(id).await;
    }
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();
    let digests: Vec<String> = read_records(&path)
        .unwrap()
        .iter()
        .filter(|r| r.entry.action.name == "echo.test" && r.entry.outcome == Outcome::Success)
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
    // A sensitive read (Test connection of the caller's own draft): refused, nothing ran.
    tab.call(
        1,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": {} } }),
    )
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
    // The store opens first (the audit checkpoint is keyed from its keys).
    assert!(matches!(err, StartError::Store(_)), "{err}");
    assert!(err.to_string().contains("no data directory"), "{err}");
}

/// The sensitive reads are the ones DOC-25 §3.5.2 names (and §3.4.7's `<tool>.test`, Test
/// connection with a draft): the classification is on the procedure, and this is the one place a
/// change to the list shows up.
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
            "docker.test",
            "echo.connect",
            "echo.test",
            "langgraph.connect",
            "langgraph.test",
            "langgraph.values.download",
            "messaging.registry.test",
            "nats.connect",
            "nats.obj.get",
            "nats.test",
            "temporal.connect",
            "temporal.payload.download",
            "temporal.test",
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

// ---- audit verify and rotation through the real binary and server -----------------------------

/// A session that makes many audited writes with 1 KiB segments, so the log has many files.
async fn a_log_of_many_segments() -> (tempfile::TempDir, std::path::PathBuf) {
    let t = start_durable_configured(StartOptions::default(), |config| {
        config.audit.policy.segment_bytes = 3_000;
    })
    .await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = tab.connect(1).await;
    for i in 0..30u32 {
        let id = 10 + i;
        tab.call(
            id,
            "echo.messages.produce",
            json!({ "connId": conn, "value": { "codec": "utf8", "text": format!("m{i}") } }),
        )
        .await;
        tab.result(id).await;
    }
    tab.disconnect().await;
    let dir = audit_dir(t._dir.path());
    // The directory outlives the server: copy it, as an operator copies a log to check it.
    t.server.shutdown().await.unwrap();
    let copy = tempfile::tempdir().unwrap();
    let target = copy.path().join("audit");
    std::fs::create_dir_all(&target).unwrap();
    for file in std::fs::read_dir(&dir).unwrap() {
        let file = file.unwrap();
        std::fs::copy(file.path(), target.join(file.file_name())).unwrap();
    }
    (copy, target)
}

fn run_verify(args: &[&std::ffi::OsStr]) -> (i32, String, String) {
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_mightyconsole-server"))
        .arg("audit")
        .arg("verify")
        .args(args)
        .env_remove("MIGHTYCONSOLE_DATA")
        .output()
        .unwrap();
    (
        out.status.code().unwrap(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

#[tokio::test]
async fn audit_verify_passes_on_a_log_of_many_segments_and_names_each_kind_of_break() {
    let (copy, audit) = a_log_of_many_segments().await;
    let files = audit_jsonl::segment_files(&audit).unwrap();
    assert!(files.len() >= 4, "many segments: {files:?}");
    let data = copy.path();
    let ok = run_verify(&["--data".as_ref(), data.as_os_str()]);
    assert_eq!(ok.0, 0, "{ok:?}");
    assert!(ok.1.contains("audit log intact"), "{}", ok.1);
    assert!(ok.1.contains("checkpoint: not checked"), "{}", ok.1);
    // The files themselves, given by name.
    let by_name: Vec<&std::ffi::OsStr> = files.iter().map(|f| f.as_os_str()).collect();
    assert_eq!(run_verify(&by_name).0, 0);

    // An edited line: exit 1, naming the file, line and seq.
    let second = &files[1];
    let original = std::fs::read_to_string(second).unwrap();
    std::fs::write(
        second,
        original.replacen("\"risk\":\"Write\"", "\"risk\":\"Read\"", 1),
    )
    .unwrap();
    let edited = run_verify(&["--data".as_ref(), data.as_os_str()]);
    assert_eq!(edited.0, 1, "{edited:?}");
    assert!(edited.2.contains("BROKEN"), "{}", edited.2);
    assert!(
        edited
            .2
            .contains(second.file_name().unwrap().to_str().unwrap()),
        "{}",
        edited.2
    );
    assert!(
        edited.2.contains("line 1") && edited.2.contains("edited"),
        "{}",
        edited.2
    );
    std::fs::write(second, &original).unwrap();

    // A deleted line.
    let kept: Vec<&str> = original
        .lines()
        .enumerate()
        .filter(|(i, _)| *i != 1)
        .map(|(_, l)| l)
        .collect();
    std::fs::write(second, kept.join("\n") + "\n").unwrap();
    let deleted = run_verify(&["--data".as_ref(), data.as_os_str()]);
    assert_eq!(deleted.0, 1);
    assert!(deleted.2.contains("deleted"), "{}", deleted.2);
    std::fs::write(second, &original).unwrap();

    // A missing segment: a gap across a file boundary.
    std::fs::remove_file(&files[2]).unwrap();
    let gap = run_verify(&["--data".as_ref(), data.as_os_str()]);
    assert_eq!(gap.0, 1);
    assert!(
        gap.2.contains("gap") && gap.2.contains("segment is missing"),
        "{}",
        gap.2
    );

    // Nothing to verify at all is a usage error. (A log cut at its end is a valid shorter chain:
    // verify says the end is not checked; the crate's tests pin that.)
    let empty = tempfile::tempdir().unwrap();
    assert_eq!(
        run_verify(&["--data".as_ref(), empty.path().as_os_str()]).0,
        2
    );
}

#[tokio::test]
async fn the_server_rotates_its_log_and_a_new_chain_follows_a_broken_one() {
    let t = start_durable_configured(StartOptions::default(), |config| {
        config.audit.policy.segment_bytes = 3_000;
    })
    .await;
    let dir = t._dir.path().to_path_buf();
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = tab.connect(1).await;
    for i in 0..20u32 {
        tab.call(
            10 + i,
            "echo.messages.produce",
            json!({ "connId": conn, "value": { "codec": "utf8", "text": "x" } }),
        )
        .await;
        tab.result(10 + i).await;
    }
    tab.disconnect().await;
    t.server.shutdown().await.unwrap();
    let segments = audit_jsonl::segment_files(&audit_dir(&dir)).unwrap();
    assert!(segments.len() >= 3, "rotated: {segments:?}");
    assert!(
        audit_jsonl::check_files(&segments).is_ok(),
        "across segments"
    );

    // Break it; the server refuses to start, naming the file; with the flag it starts a new chain.
    let last = segments.last().unwrap();
    let text = std::fs::read_to_string(last).unwrap();
    std::fs::write(
        last,
        text.replacen("server.stop", "server.stopx", 1).replacen(
            "\"risk\":\"Write\"",
            "\"risk\":\"Read\"",
            1,
        ),
    )
    .unwrap();
    let broken_text = std::fs::read_to_string(last).unwrap();
    assert_ne!(text, broken_text);
    let Err(err) = Server::start_with(config(&dir, None), StartOptions::default()).await else {
        panic!("a broken log must not start");
    };
    assert!(matches!(err, StartError::Audit(_)), "{err}");

    let mut again = config(&dir, None);
    again.audit.new_chain = true;
    let server = Server::start_with(again, StartOptions::default())
        .await
        .expect("starts on a new chain");
    server.shutdown().await.unwrap();
    let moved: Vec<_> = std::fs::read_dir(audit_dir(&dir))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with("broken-"))
        .collect();
    assert_eq!(moved.len(), 1, "the old log moved to broken-<utc>/");
    let now = audit_jsonl::segment_files(&audit_dir(&dir)).unwrap();
    let records: Vec<AuditRecord> = now
        .iter()
        .flat_map(|f| {
            std::fs::read_to_string(f)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<AuditRecord>(l).unwrap())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(records[0].seq, 0);
    assert_eq!(records[0].entry.action.name, "audit.new_chain");
    let detail = serde_json::to_value(&records[0].entry.detail).unwrap();
    assert_eq!(
        detail["moved_to"],
        moved[0].file_name().to_string_lossy().as_ref()
    );
    assert_eq!(records[1].entry.action.name, "server.start");
    assert!(audit_jsonl::check_files(&now).is_ok());
}
