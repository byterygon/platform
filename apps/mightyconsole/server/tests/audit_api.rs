//! Reading the audit log over the wire (DOC-25 §3.5.7, TSK-140 batch 3b): `audit.list` with its
//! filter and cursor, `audit.get`, `audit.verify` and `audit.status`, all under `audit.read`
//! (administrators only), and reading the log is itself recorded.

use crate::support::*;
use ambidex::Code;
use mightyconsole_server::StartOptions;
use serde_json::{Value, json};

fn admin_id(t: &TestServer) -> String {
    t.server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id()
}

#[tokio::test]
async fn an_administrator_pages_the_log_newest_first_and_reading_it_is_recorded() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    // Some writes to read back: three custom roles.
    for (i, id) in ["alpha", "bravo", "charlie"].iter().enumerate() {
        a.call(
            i as u32 + 1,
            "admin.roles.create",
            json!({ "id": id, "name": id, "permissions": ["app.read"] }),
        )
        .await;
        a.result(i as u32 + 1).await;
    }
    a.call(10, "audit.list", json!({ "limit": 2 })).await;
    let page = a.result(10).await;
    let rows = page["records"].as_array().unwrap();
    assert_eq!(rows.len(), 2, "{page}");
    assert!(
        rows[0]["seq"].as_u64() > rows[1]["seq"].as_u64(),
        "newest first"
    );
    assert_eq!(rows[0]["action"], "admin.roles.create");
    assert_eq!(rows[0]["risk"], "Write");
    assert_eq!(rows[0]["outcome"], "allowed");
    assert_eq!(
        rows[0]["phase"], "done",
        "admissions are left out by default"
    );
    let next = page["next"].as_str().expect("more to read").to_owned();
    a.call(11, "audit.list", json!({ "limit": 500, "cursor": next }))
        .await;
    let rest = a.result(11).await;
    let seqs: Vec<u64> = rest["records"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["seq"].as_u64().unwrap())
        .collect();
    assert!(seqs.windows(2).all(|w| w[0] > w[1]));
    assert!(
        seqs.iter().all(|s| *s < rows[1]["seq"].as_u64().unwrap()),
        "the next page goes on from the first"
    );
    assert!(rest["next"].is_null(), "the oldest record was reached");

    // Filters: by action prefix and risk; the sensitive reads, which include this very list.
    a.call(
        12,
        "audit.list",
        json!({ "filter": { "action": "admin.roles.", "risk": "Write" } }),
    )
    .await;
    let roles = a.result(12).await;
    assert_eq!(roles["records"].as_array().unwrap().len(), 3);
    a.call(
        13,
        "audit.list",
        json!({ "filter": { "sensitiveOnly": true } }),
    )
    .await;
    let sensitive = a.result(13).await;
    let listed = sensitive["records"].as_array().unwrap();
    assert!(
        listed
            .iter()
            .any(|r| r["action"] == "audit.list" && r["sensitive"] == true),
        "reading the log is recorded: {sensitive}"
    );
    a.call(14, "audit.list", json!({ "filter": { "risk": "Mild" } }))
        .await;
    a.error(14, Code::InvalidArgument).await;
    a.call(15, "audit.list", json!({ "cursor": "not a cursor" }))
        .await;
    a.error(15, Code::InvalidArgument).await;

    // One entry, with its hashes and digests, no value.
    let seq = rows[0]["seq"].as_u64().unwrap();
    a.call(16, "audit.get", json!({ "seq": seq })).await;
    let got = a.result(16).await;
    assert_eq!(got["row"]["seq"], seq);
    assert!(got["hash"].as_str().unwrap().len() > 16);
    assert!(got["inputDigest"].as_str().is_some());
    assert_eq!(got["principals"][0]["id"], admin_id(&t));
    a.call(17, "audit.get", json!({ "seq": 99_999_999 })).await;
    a.error(17, Code::NotFound).await;
}

#[tokio::test]
async fn verify_checks_the_chain_and_status_says_how_big_it_is() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(
        1,
        "admin.roles.create",
        json!({ "id": "alpha", "name": "alpha", "permissions": ["app.read"] }),
    )
    .await;
    a.result(1).await;
    a.call(2, "audit.verify", json!({})).await;
    let v = a.result(2).await;
    assert_eq!(v["ok"], true, "{v}");
    assert!(v["records"].as_u64().unwrap() >= 3);
    assert!(v["headSeq"].as_u64().is_some());
    assert!(v["broken"].is_null());
    a.call(3, "audit.status", json!({})).await;
    let s = a.result(3).await;
    assert!(s["segments"].as_u64().unwrap() >= 1);
    assert!(s["bytes"].as_u64().unwrap() > 0);
    assert!(s["refusing"].is_null());
    assert!(s["maxBytes"].as_u64().unwrap() > s["bytes"].as_u64().unwrap());
}

#[tokio::test]
async fn nobody_but_an_administrator_reads_the_log_and_the_refusal_says_which_permission() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let operator = t.browser_as("human:oidc:omar", &[]).await;
    t.server
        .store()
        .record_oidc_user("human:oidc:omar", "omar", "Omar", None, &[], 1)
        .unwrap();
    let mut o = t.tab(&operator).await;
    for (i, (proc, input)) in [
        ("audit.list", json!({})),
        ("audit.get", json!({ "seq": 0 })),
        ("audit.verify", json!({})),
        ("audit.status", json!({})),
    ]
    .into_iter()
    .enumerate()
    {
        o.call(i as u32 + 1, proc, input).await;
        let err = o.error(i as u32 + 1, Code::PermissionDenied).await;
        let details: Value = err.details.clone().unwrap_or(Value::Null);
        assert_eq!(details["perm"], "audit.read", "{proc}: {details}");
    }
}

#[tokio::test]
async fn a_server_with_a_test_sink_has_no_log_to_read() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(1, "audit.status", json!({})).await;
    let err = a.error(1, Code::Unavailable).await;
    assert!(
        err.message.contains("not kept on disk") || err.details.is_some(),
        "{err:?}"
    );
}
