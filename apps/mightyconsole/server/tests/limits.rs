//! Abuse limits over the wire (TSK-141; DOC-25 Open question 26): Test connection with typed
//! credentials has a budget per person, calls without a secret are never counted, and a person's
//! personal profiles have a quota in number and in bytes, so open sign-up cannot fill the disk.

mod support;

use ambidex::Code;
use mightyconsole_server::authz::limits::TEST_PER_MINUTE;
use mightyconsole_server::profiles::{MAX_PERSONAL_BYTES, MAX_PERSONAL_PROFILES, MAX_RECORD_BYTES};
use serde_json::json;
use support::*;

const SECRET: &str = "pw-limits-do-not-leak-5e1a";

#[tokio::test]
async fn test_connection_with_typed_credentials_has_a_budget_per_person() {
    let t = start().await;
    let browser = t.browser_as("human:account:tester", &[]).await;
    let mut tab = t.tab(&browser).await;
    let draft = json!({ "draft": { "name": "lab", "fields": {}, "secrets": { "token": SECRET } } });
    for id in 1..=TEST_PER_MINUTE as u32 {
        tab.call(id, "echo.test", draft.clone()).await;
        tab.result(id).await;
    }
    let over = TEST_PER_MINUTE as u32 + 1;
    tab.call(over, "echo.test", draft.clone()).await;
    let err = tab.error(over, Code::ResourceExhausted).await;
    assert!(err.retryable, "{err:?}");
    assert!(
        err.message.contains("a minute for one person"),
        "{}",
        err.message
    );
    assert!(!err.message.contains(SECRET));
    // A draft with no secret is not a guess at one: it is not counted.
    tab.call(
        over + 1,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": {} } }),
    )
    .await;
    tab.result(over + 1).await;
    // Another tab of the same person shares the budget.
    let mut other = t.tab(&browser).await;
    other.call(1, "echo.test", draft.clone()).await;
    other.error(1, Code::ResourceExhausted).await;
    // Another person has their own.
    let someone = t.browser_as("human:account:someone", &[]).await;
    let mut theirs = t.tab(&someone).await;
    theirs.call(1, "echo.test", draft).await;
    theirs.result(1).await;
}

fn personal(name: &str, extras: serde_json::Value) -> serde_json::Value {
    json!({
        "tool": "nats", "name": name, "owner": { "kind": "personal" },
        "fields": { "servers": ["nats://a:4222"] },
        "extras": extras,
    })
}

#[tokio::test]
async fn personal_profiles_have_a_quota_in_number() {
    let t = start().await;
    let browser = t.browser_as("human:account:collector", &[]).await;
    let mut tab = t.tab(&browser).await;
    for i in 0..MAX_PERSONAL_PROFILES as u32 {
        tab.call(
            i + 1,
            "profiles.create",
            personal(&format!("p{i}"), json!({})),
        )
        .await;
        tab.result(i + 1).await;
    }
    let over = MAX_PERSONAL_PROFILES as u32 + 1;
    tab.call(over, "profiles.create", personal("one too many", json!({})))
        .await;
    let err = tab.error(over, Code::FailedPrecondition).await;
    assert!(err.message.contains("delete one first"), "{}", err.message);
    // Another person is not affected by it.
    let other = t.browser_as("human:account:other", &[]).await;
    let mut theirs = t.tab(&other).await;
    theirs
        .call(1, "profiles.create", personal("mine", json!({})))
        .await;
    theirs.result(1).await;
}

#[tokio::test]
async fn personal_profiles_have_a_quota_in_bytes() {
    let t = start().await;
    let browser = t.browser_as("human:account:hoarder", &[]).await;
    let mut tab = t.tab(&browser).await;
    // Records just under the size of one: the quota holds this many of them.
    let blob = "x".repeat(MAX_RECORD_BYTES - 1024);
    let fit = MAX_PERSONAL_BYTES / (MAX_RECORD_BYTES - 1024 + 200);
    for i in 0..fit as u32 {
        tab.call(
            i + 1,
            "profiles.create",
            personal(&format!("big{i}"), json!({ "blob": blob })),
        )
        .await;
        tab.result(i + 1).await;
    }
    let over = fit as u32 + 1;
    tab.call(
        over,
        "profiles.create",
        personal("too big", json!({ "blob": blob })),
    )
    .await;
    let err = tab.error(over, Code::FailedPrecondition).await;
    assert!(
        err.message.contains("more than this server keeps"),
        "{}",
        err.message
    );
    // A small one still fits.
    tab.call(over + 1, "profiles.create", personal("small", json!({})))
        .await;
    tab.result(over + 1).await;
}
