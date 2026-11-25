//! Profiles on the server and their write-only secrets, over the wire (DOC-25 §3.4.2, §3.4.7,
//! §3.4.8, §3.4.9, §6 "Secrets"): personal profiles are their owner's alone; shared ones are
//! edited with `profiles.manage` and used with `<tool>.read`; no answer ever holds a secret value;
//! a changed target removes the secrets of its group; names, etags, imports and transfers.

mod support;

use ambidex::Code;
use serde_json::{Value, json};
use support::*;

/// A value no answer may contain.
const SECRET: &str = "pw-do-not-leak-91c3";

fn admin_id(t: &TestServer) -> String {
    t.server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id()
}

fn no_secret(value: &Value) {
    let text = value.to_string();
    assert!(
        !text.contains(SECRET),
        "a secret value in an answer: {text}"
    );
}

fn fields(profile: &Value) -> Vec<String> {
    profile["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["field"].as_str().unwrap().to_owned())
        .collect()
}

/// A browser signed in as an OIDC user with `role`.
async fn user_with_role(t: &TestServer, admin: &mut Tab, id: u32, user: &str, role: &str) -> Tab {
    t.server
        .store()
        .record_oidc_user(user, user, user, None, &[], 1)
        .unwrap();
    admin
        .call(
            id,
            "admin.users.setRoles",
            json!({ "userId": user, "assignments": [{ "role": role }] }),
        )
        .await;
    admin.result(id).await;
    let browser = t.browser_as(user, &[]).await;
    t.tab(&browser).await
}

#[tokio::test]
async fn a_personal_profile_is_its_owners_alone_and_its_secret_is_never_answered() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = user_with_role(&t, &mut a, 1, "human:oidc:mia", "member").await;
    let mut noor = user_with_role(&t, &mut a, 2, "human:oidc:noor", "member").await;

    mia.call(
        1,
        "profiles.create",
        json!({
            "tool": "nats", "name": "Mine", "owner": { "kind": "personal" },
            "fields": { "servers": ["nats://a:4222"], "auth": "userPassword", "user": "mia" },
            "secrets": { "password": SECRET }
        }),
    )
    .await;
    let made = mia.result(1).await;
    no_secret(&made);
    assert_eq!(made["access"], "owner");
    assert_eq!(
        made["owner"],
        json!({ "kind": "personal", "user": "human:oidc:mia" })
    );
    assert_eq!(fields(&made), ["password"]);
    let id = made["id"].as_str().unwrap().to_owned();

    // Another user sees nothing of it, and the router refuses them on its target.
    noor.call(1, "profiles.list", json!({})).await;
    assert_eq!(noor.result(1).await["profiles"], json!([]));
    noor.call(2, "profiles.get", json!({ "id": id })).await;
    noor.error(2, Code::PermissionDenied).await;
    noor.call(
        3,
        "secrets.set",
        json!({ "owner": { "kind": "profile", "id": id }, "field": "password", "value": "x" }),
    )
    .await;
    noor.error(3, Code::PermissionDenied).await;

    // An administrator sees its metadata: target fields, no secrets, no extras.
    a.call(3, "profiles.list", json!({ "tool": "nats" })).await;
    let listed = a.result(3).await;
    no_secret(&listed);
    let row = &listed["profiles"][0];
    assert_eq!(row["access"], "metadata");
    assert_eq!(row["fields"], json!({ "servers": ["nats://a:4222"] }));
    assert_eq!(row["secrets"], json!([]));
    // ...and cannot read its secrets' status or set them.
    a.call(
        4,
        "secrets.status",
        json!({ "owner": { "kind": "profile", "id": id } }),
    )
    .await;
    a.error(4, Code::PermissionDenied).await;

    // The owner reads the status, sets and removes; still never a value.
    mia.call(
        2,
        "secrets.status",
        json!({ "owner": { "kind": "profile", "id": id } }),
    )
    .await;
    let status = mia.result(2).await;
    no_secret(&status);
    assert_eq!(status["secrets"][0]["version"], 1);
    assert_eq!(status["secrets"][0]["setBy"], "human:oidc:mia");
    mia.call(
        3,
        "secrets.set",
        json!({ "owner": { "kind": "profile", "id": id }, "field": "password", "value": SECRET }),
    )
    .await;
    let set = mia.result(3).await;
    no_secret(&set);
    assert_eq!(set["version"], 2);
    mia.call(
        4,
        "secrets.remove",
        json!({ "owner": { "kind": "profile", "id": id }, "field": "password" }),
    )
    .await;
    assert_eq!(mia.result(4).await["removed"], true);
    // A secret in `fields`, or an unknown secret, is refused.
    mia.call(
        5,
        "profiles.create",
        json!({ "tool": "nats", "name": "Bad", "owner": { "kind": "personal" },
                "fields": { "password": SECRET } }),
    )
    .await;
    let err = mia.error(5, Code::InvalidArgument).await;
    assert!(!err.message.contains(SECRET), "{}", err.message);
    mia.call(
        6,
        "secrets.set",
        json!({ "owner": { "kind": "profile", "id": id }, "field": "servers", "value": "x" }),
    )
    .await;
    mia.error(6, Code::InvalidArgument).await;
    // The value is in the store, encrypted, and nowhere in clear.
    let path = t.server.store().path().to_path_buf();
    drop(t);
    let bytes = std::fs::read(path).unwrap_or_default();
    assert!(!bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes()));
}

#[tokio::test]
async fn a_viewer_uses_a_shared_profile_whose_password_they_never_see() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut viewer = user_with_role(&t, &mut a, 1, "human:oidc:vic", "viewer").await;
    let mut member = user_with_role(&t, &mut a, 2, "human:oidc:mo", "member").await;

    // Only profiles.manage makes shared profiles.
    viewer
        .call(
            1,
            "profiles.create",
            json!({ "tool": "nats", "name": "Team", "owner": { "kind": "shared" }, "fields": {} }),
        )
        .await;
    viewer.error(1, Code::PermissionDenied).await;
    a.call(
        3,
        "profiles.create",
        json!({
            "tool": "nats", "name": "Team", "owner": { "kind": "shared" },
            "fields": { "servers": ["nats://team:4222"], "schemaRegistry": { "url": "https://reg" } },
            "secrets": { "password": SECRET, "schemaRegistry.token": SECRET }
        }),
    )
    .await;
    let shared = a.result(3).await;
    no_secret(&shared);
    assert_eq!(shared["access"], "edit");
    let id = shared["id"].as_str().unwrap().to_owned();
    let etag = shared["etag"].as_str().unwrap().to_owned();

    // The viewer sees and may use it, never edit it; a member without nats.read sees nothing.
    viewer.call(2, "profiles.list", json!({})).await;
    let listed = viewer.result(2).await;
    no_secret(&listed);
    assert_eq!(listed["profiles"][0]["access"], "use");
    assert_eq!(
        fields(&listed["profiles"][0]),
        ["password", "schemaRegistry.token"]
    );
    viewer
        .call(
            3,
            "profiles.update",
            json!({ "id": id, "etag": etag, "name": "Mine now" }),
        )
        .await;
    viewer.error(3, Code::PermissionDenied).await;
    member.call(1, "profiles.list", json!({})).await;
    assert_eq!(member.result(1).await["profiles"], json!([]));

    // Changing the host without the password removes it; the registry's secret stays.
    a.call(
        4,
        "profiles.update",
        json!({ "id": id, "etag": etag,
                "fields": { "servers": ["nats://evil:4222"], "schemaRegistry": { "url": "https://reg" } } }),
    )
    .await;
    let updated = a.result(4).await;
    no_secret(&updated);
    assert_eq!(updated["removedSecrets"], json!(["password"]));
    assert_eq!(fields(&updated["profile"]), ["schemaRegistry.token"]);
    let etag = updated["profile"]["etag"].as_str().unwrap().to_owned();
    // ...unless the same call sets it again.
    a.call(
        5,
        "profiles.update",
        json!({ "id": id, "etag": etag,
                "fields": { "servers": ["nats://new:4222"], "schemaRegistry": { "url": "https://reg" } },
                "secrets": { "password": SECRET } }),
    )
    .await;
    let kept = a.result(5).await;
    assert_eq!(kept["removedSecrets"], json!([]));
    assert_eq!(
        fields(&kept["profile"]),
        ["password", "schemaRegistry.token"]
    );
    // A stale etag is a conflict.
    a.call(
        6,
        "profiles.update",
        json!({ "id": id, "etag": etag, "name": "Late" }),
    )
    .await;
    a.error(6, Code::FailedPrecondition).await;
    // Names are unique per tool among what one sees.
    a.call(
        7,
        "profiles.create",
        json!({ "tool": "nats", "name": "team", "owner": { "kind": "personal" }, "fields": {} }),
    )
    .await;
    a.error(7, Code::FailedPrecondition).await;

    // Deleting asks for the name, typed.
    a.confirmed(8, "profiles.delete", json!({ "id": id, "name": "Team" }))
        .await;
    a.result(8).await;
    viewer.call(4, "profiles.list", json!({})).await;
    assert_eq!(viewer.result(4).await["profiles"], json!([]));
    assert!(
        t.server
            .store()
            .secret_entries(Some(&mightyconsole_server::secrets::Owner::profile(&id)))
            .unwrap()
            .is_empty(),
        "the profile's secrets went with it"
    );
}

#[tokio::test]
async fn an_import_is_idempotent_a_duplicate_keeps_its_owner_and_a_transfer_moves_ownership() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = user_with_role(&t, &mut a, 1, "human:oidc:mia", "member").await;
    let mut noor = user_with_role(&t, &mut a, 2, "human:oidc:noor", "member").await;

    let import = json!({
        "sourceId": "01JBROWSER0000000000000000",
        "record": { "tool": "temporal", "version": 1, "name": "Local",
                    "fields": { "address": "127.0.0.1:7233" }, "extras": { "savedQueries": [] } },
        "secrets": { "apiKey": SECRET },
        "owner": { "kind": "personal" }
    });
    mia.call(1, "profiles.import", import.clone()).await;
    let first = mia.result(1).await;
    no_secret(&first);
    assert_eq!(first["created"], true);
    assert_eq!(fields(&first["profile"]), ["apiKey"]);
    mia.call(2, "profiles.import", import).await;
    let again = mia.result(2).await;
    assert_eq!(again["created"], false);
    assert_eq!(again["profile"]["id"], first["profile"]["id"]);
    let id = first["profile"]["id"].as_str().unwrap().to_owned();

    // The owner's copy keeps the secrets; nobody else may copy it.
    mia.call(
        3,
        "profiles.duplicate",
        json!({ "id": id, "name": "Local 2" }),
    )
    .await;
    let copy = mia.result(3).await;
    assert_eq!(copy["secretsCopied"], true);
    assert_eq!(fields(&copy["profile"]), ["apiKey"]);
    noor.call(
        1,
        "profiles.duplicate",
        json!({ "id": id, "name": "Stolen" }),
    )
    .await;
    noor.error(1, Code::PermissionDenied).await;

    // Transfer to noor: hers now, secrets kept, mia no longer sees it.
    a.call(
        3,
        "admin.profiles.transfer",
        json!({ "profileIds": [id], "toUserId": "human:oidc:noor" }),
    )
    .await;
    assert_eq!(a.result(3).await["transferred"], 1);
    noor.call(2, "profiles.get", json!({ "id": id })).await;
    let hers = noor.result(2).await;
    assert_eq!(hers["access"], "owner");
    assert_eq!(fields(&hers), ["apiKey"]);
    mia.call(4, "profiles.get", json!({ "id": id })).await;
    mia.error(4, Code::PermissionDenied).await;
    // A member may not transfer.
    mia.call(
        5,
        "admin.profiles.transfer",
        json!({ "profileIds": [id], "toUserId": "human:oidc:mia" }),
    )
    .await;
    mia.error(5, Code::PermissionDenied).await;
}

#[tokio::test]
async fn a_change_is_pushed_to_the_sessions_that_may_see_the_profile() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut viewer = user_with_role(&t, &mut a, 1, "human:oidc:vic", "viewer").await;
    let mut member = user_with_role(&t, &mut a, 2, "human:oidc:mo", "member").await;
    viewer.subscribe_events(10).await;
    member.subscribe_events(10).await;
    a.call(
        3,
        "profiles.create",
        json!({ "tool": "docker", "name": "Build host", "owner": { "kind": "shared" },
                "fields": { "host": "build", "port": 22, "username": "ci" } }),
    )
    .await;
    let id = a.result(3).await["id"].as_str().unwrap().to_owned();
    let event = viewer.event(10, |e| e["kind"] == "ProfileChanged").await;
    assert_eq!(
        event,
        json!({ "kind": "ProfileChanged", "id": id, "tool": "docker" })
    );
    assert!(
        member
            .quiet(10, std::time::Duration::from_millis(300))
            .await,
        "a member without docker.read is not told"
    );
}
