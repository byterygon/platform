//! Profiles on the server and their write-only secrets, over the wire (DOC-25 §3.4.2, §3.4.7,
//! §3.4.8, §3.4.9, §6 "Secrets"): personal profiles are their owner's alone; shared ones are
//! edited with `profiles.manage` and used with `<tool>.read`; no answer ever holds a secret value;
//! a changed target removes the secrets of its group; names, etags, imports and transfers.

mod support;

use ambidex::Code;
use mightyconsole_server::StartOptions;
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

#[tokio::test]
async fn connect_names_a_stored_profile_and_the_server_opens_its_secret() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = user_with_role(&t, &mut a, 1, "human:oidc:mia", "member").await;
    let mut noor = user_with_role(&t, &mut a, 2, "human:oidc:noor", "member").await;
    let mut viewer = user_with_role(&t, &mut a, 3, "human:oidc:vic", "viewer").await;

    // echo refuses the token "wrong": the stored token is the one the connection uses.
    mia.call(
        1,
        "profiles.create",
        json!({ "tool": "echo", "name": "Mine", "owner": { "kind": "personal" }, "fields": {}, "secrets": { "token": "wrong" } }),
    )
    .await;
    let id = mia.result(1).await["id"].as_str().unwrap().to_owned();
    mia.call(2, "echo.connect", json!({ "profileId": id }))
        .await;
    let refused = mia.error(2, Code::Unauthenticated).await;
    assert!(refused.message.contains("token"), "{}", refused.message);
    mia.call(
        3,
        "secrets.set",
        json!({ "owner": { "kind": "profile", "id": id }, "field": "token", "value": SECRET }),
    )
    .await;
    mia.result(3).await;
    mia.call(4, "echo.connect", json!({ "profileId": id }))
        .await;
    let out = mia.result(4).await;
    no_secret(&out);
    assert_eq!(out["greeting"], "hello from Mine");
    let conn = out["connId"].as_str().unwrap().to_owned();

    // A personal profile is its owner's: nobody else connects with it.
    noor.call(1, "echo.connect", json!({ "profileId": id }))
        .await;
    noor.error(1, Code::PermissionDenied).await;
    viewer
        .call(1, "echo.connect", json!({ "profileId": id }))
        .await;
    viewer.error(1, Code::PermissionDenied).await;
    // A profile is named or sent, not both; and it is a profile of the tool connecting.
    mia.call(
        5,
        "echo.connect",
        json!({ "profileId": id, "profile": { "name": "x" } }),
    )
    .await;
    mia.error(5, Code::InvalidArgument).await;

    // A shared profile: whoever holds echo.read connects with a token they never see; a
    // member (no echo.read) does not.
    a.call(
        4,
        "profiles.create",
        json!({ "tool": "echo", "name": "Team", "owner": { "kind": "shared" }, "fields": { "greeting": "hi team" }, "secrets": { "token": SECRET } }),
    )
    .await;
    let team = a.result(4).await["id"].as_str().unwrap().to_owned();
    viewer
        .call(2, "echo.connect", json!({ "profileId": team }))
        .await;
    let out = viewer.result(2).await;
    no_secret(&out);
    assert_eq!(out["greeting"], "hi team");
    noor.call(2, "echo.connect", json!({ "profileId": team }))
        .await;
    noor.error(2, Code::PermissionDenied).await;
    viewer
        .call(3, "nats.connect", json!({ "profileId": team }))
        .await;
    let wrong_tool = viewer.error(3, Code::InvalidArgument).await;
    assert!(
        wrong_tool.message.contains("echo profile"),
        "{}",
        wrong_tool.message
    );

    // Deleting the profile ends its live connections.
    mia.confirmed(6, "profiles.delete", json!({ "id": id, "name": "Mine" }))
        .await;
    mia.result(6).await;
    mia.call(7, "echo.ping", json!({ "connId": conn, "text": "x" }))
        .await;
    mia.error(7, Code::NotFound).await;
    // Gone: no owner is left, so roles decide, and a member has no echo.read.
    mia.call(8, "echo.connect", json!({ "profileId": id }))
        .await;
    mia.error(8, Code::PermissionDenied).await;

    // The audit log names the profile, never the token.
    let dir = mightyconsole_server::audit::audit_dir(t._dir.path());
    let log: String = std::fs::read_dir(&dir)
        .unwrap()
        .map(|f| std::fs::read_to_string(f.unwrap().path()).unwrap_or_default())
        .collect();
    assert!(log.contains("echo.connect"), "the connects are audited");
    assert!(!log.contains(SECRET), "a secret in the audit log");
}

#[tokio::test]
async fn test_connection_uses_draft_secrets_once_and_stored_ones_only_on_the_same_target() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = user_with_role(&t, &mut a, 1, "human:oidc:mia", "member").await;
    let mut viewer = user_with_role(&t, &mut a, 2, "human:oidc:vic", "viewer").await;

    // A draft's own secret: used for the call, stored nowhere.
    mia.call(
        1,
        "echo.test",
        json!({ "draft": { "name": "New", "fields": {}, "secrets": { "token": "wrong" } } }),
    )
    .await;
    mia.error(1, Code::Unauthenticated).await;
    mia.call(
        2,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": { "token": SECRET } } }),
    )
    .await;
    no_secret(&mia.result(2).await);
    // A secret in the draft's fields is refused, as a save refuses it.
    mia.call(
        3,
        "echo.test",
        json!({ "draft": { "fields": { "token": "x" }, "secrets": {} } }),
    )
    .await;
    mia.error(3, Code::InvalidArgument).await;

    // basedOn: the stored secret fills the draft's empty one for whoever may edit the profile,
    // while the draft keeps the target (§3.4.8; every profile's `routeId` is one).
    mia.call(
        4,
        "profiles.create",
        json!({ "tool": "echo", "name": "Mine", "owner": { "kind": "personal" }, "fields": {}, "secrets": { "token": "wrong" } }),
    )
    .await;
    let id = mia.result(4).await["id"].as_str().unwrap().to_owned();
    mia.call(
        5,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": {} }, "basedOn": id }),
    )
    .await;
    mia.error(5, Code::Unauthenticated).await;
    mia.call(
        6,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": { "token": SECRET } }, "basedOn": id }),
    )
    .await;
    mia.result(6).await;
    // Another route: the stored "wrong" is not sent, so the draft connects without a token.
    mia.call(
        7,
        "echo.test",
        json!({ "draft": { "fields": { "routeId": "R9" }, "secrets": {} }, "basedOn": id }),
    )
    .await;
    mia.result(7).await;

    // A viewer may use a shared profile but not edit it: its secrets never fill a draft; and
    // testing needs profiles.personal or profiles.manage, which every built-in role holds.
    a.call(
        3,
        "profiles.create",
        json!({ "tool": "echo", "name": "Team", "owner": { "kind": "shared" }, "fields": {}, "secrets": { "token": "wrong" } }),
    )
    .await;
    let team = a.result(3).await["id"].as_str().unwrap().to_owned();
    viewer
        .call(
            1,
            "echo.test",
            json!({ "draft": { "fields": {}, "secrets": {} }, "basedOn": team }),
        )
        .await;
    viewer.result(1).await;
    a.call(
        4,
        "echo.test",
        json!({ "draft": { "fields": {}, "secrets": {} }, "basedOn": team }),
    )
    .await;
    a.error(4, Code::Unauthenticated).await;

    // The draft's secrets are in no audit entry.
    let dir = mightyconsole_server::audit::audit_dir(t._dir.path());
    let log: String = std::fs::read_dir(&dir)
        .unwrap()
        .map(|f| std::fs::read_to_string(f.unwrap().path()).unwrap_or_default())
        .collect();
    assert!(log.contains("echo.test"), "the tests are audited");
    assert!(!log.contains(SECRET), "a draft secret in the audit log");
}

/// DOC-25 §6 "Secrets": after a key rotation every profile still connects.
#[cfg(unix)]
#[tokio::test]
async fn a_stored_profile_still_connects_after_a_key_rotation() {
    use mightyconsole_server::secrets::crypto::Kek;
    use mightyconsole_server::secrets::keys::{
        KeySource, SecretsSettings, key_file_text, write_private_file,
    };
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(
        1,
        "profiles.create",
        json!({ "tool": "echo", "name": "Team", "owner": { "kind": "shared" }, "fields": {}, "secrets": { "token": "wrong" } }),
    )
    .await;
    let id = a.result(1).await["id"].as_str().unwrap().to_owned();

    // The key the server generated beside its data, and a new one first.
    let generated = std::fs::read_dir(t._dir.path().join("keys"))
        .unwrap()
        .map(|f| f.unwrap().path())
        .find(|p| p.extension().is_some_and(|e| e == "key"))
        .expect("the generated key");
    let new = Kek::generate().unwrap();
    let new_path = t._dir.path().join("new.key");
    write_private_file(&new_path, key_file_text(&new).as_bytes()).unwrap();
    t.server
        .reload_secrets(&SecretsSettings {
            keys: vec![KeySource::File(new_path), KeySource::File(generated)],
        })
        .await
        .unwrap();
    eventually("every entry under the new key", || {
        mightyconsole_server::secrets::entries_by_key(t.server.store())
            .unwrap()
            .into_iter()
            .all(|(kek, _)| kek == new.id())
    })
    .await;
    // The stored token still opens: echo refuses it, as it did before.
    a.call(2, "echo.connect", json!({ "profileId": id })).await;
    a.error(2, Code::Unauthenticated).await;
}

/// DOC-25 §6 "accounts": a member adds and uses a personal profile, and sees no shared one until
/// a group gives them the tool's read.
#[tokio::test]
async fn a_member_uses_their_own_profile_and_sees_shared_ones_once_a_group_lets_them() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mo = user_with_role(&t, &mut a, 1, "human:oidc:mo", "member").await;
    mo.call(
        1,
        "profiles.create",
        json!({ "tool": "echo", "name": "Mine", "owner": { "kind": "personal" }, "fields": { "greeting": "mine" } }),
    )
    .await;
    let mine = mo.result(1).await["id"].as_str().unwrap().to_owned();
    mo.call(2, "echo.connect", json!({ "profileId": mine }))
        .await;
    assert_eq!(mo.result(2).await["greeting"], "mine");

    a.call(
        2,
        "profiles.create",
        json!({ "tool": "echo", "name": "Team", "owner": { "kind": "shared" }, "fields": {} }),
    )
    .await;
    let team = a.result(2).await["id"].as_str().unwrap().to_owned();
    mo.call(3, "profiles.list", json!({ "tool": "echo" })).await;
    let ids: Vec<Value> = mo.result(3).await["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].clone())
        .collect();
    assert_eq!(ids, [json!(mine)]);
    mo.call(4, "echo.connect", json!({ "profileId": team }))
        .await;
    mo.error(4, Code::PermissionDenied).await;

    // A local group mapped to the viewer role.
    a.call(
        3,
        "admin.groups.create",
        json!({ "name": "team", "members": ["human:oidc:mo"] }),
    )
    .await;
    a.result(3).await;
    a.call(4, "admin.groups.list", json!({})).await;
    let etag = a.result(4).await["etag"].as_u64().unwrap();
    a.call(
        5,
        "admin.groups.set",
        json!({ "etag": etag, "mappings": [{ "group": "local:team", "role": "viewer" }] }),
    )
    .await;
    a.result(5).await;
    mo.call(5, "profiles.list", json!({ "tool": "echo" })).await;
    assert_eq!(mo.result(5).await["profiles"].as_array().unwrap().len(), 2);
    mo.call(6, "echo.connect", json!({ "profileId": team }))
        .await;
    mo.result(6).await;
}
