//! The management procedures over the wire (DOC-25 §3.3.7, TSK-138): users and their roles, custom
//! roles, group mappings and local groups, sessions; the last-administrator rule; sessions end when
//! their user loses a permission; `app.me` shows the roles and permissions in force.

use crate::support::*;
use ambidex::Code;
use serde_json::{Value, json};

/// The default administrator's principal id.
fn admin_id(t: &TestServer) -> String {
    t.server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id()
}

fn reason(err: &ambidex::ErrorPayload) -> Value {
    err.details.clone().unwrap_or(Value::Null)["reason"].clone()
}

#[tokio::test]
async fn an_administrator_assigns_roles_and_a_lost_permission_ends_the_session() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let member = t.browser_as("human:oidc:mia", &[]).await;
    let mut m = t.tab(&member).await;
    t.server
        .store()
        .record_oidc_user("human:oidc:mia", "mia", "Mia", Some("mia@lab"), &[], 1)
        .unwrap();

    // A member may not read users.
    m.call(1, "admin.users.list", json!({})).await;
    let err = m.error(1, Code::PermissionDenied).await;
    assert_eq!(reason(&err), "missing");

    a.call(1, "admin.users.list", json!({ "text": "mia" }))
        .await;
    let list = a.result(1).await;
    assert_eq!(list["total"], 1);
    let mia = &list["users"][0];
    assert_eq!(
        (mia["kind"].as_str(), mia["email"].as_str()),
        (Some("oidc"), Some("mia@lab"))
    );
    assert_eq!(
        mia["roles"],
        json!([{ "role": "member", "scope": null, "via": "default" }])
    );

    // A gain applies to the next call, without ending the session.
    a.call(
        2,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:mia", "assignments": [{ "role": "viewer" }, { "role": "operator", "scope": ["profile:P1/ns:team-a-*"] }] }),
    )
    .await;
    a.result(2).await;
    m.call(2, "app.me", json!({})).await;
    let me = m.result(2).await;
    let roles: Vec<&str> = me["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["role"].as_str().unwrap())
        .collect();
    assert_eq!(roles, ["member", "viewer", "operator"]);
    let write = me["permissions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["perm"] == "temporal.write")
        .unwrap();
    assert_eq!(write["everywhere"], false);
    assert_eq!(write["scope"], json!(["profile:P1/ns:team-a-*"]));

    // A loss ends the session at once.
    a.call(
        3,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:mia", "assignments": [{ "role": "viewer" }] }),
    )
    .await;
    a.result(3).await;
    let goaway = m.client.expect_goaway().await;
    assert_eq!(goaway.code, Code::Unauthenticated);

    // Invalid roles and scopes are refused.
    a.call(
        4,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:mia", "assignments": [{ "role": "root" }] }),
    )
    .await;
    a.error(4, Code::InvalidArgument).await;
    a.call(5, "admin.users.setRoles", json!({ "userId": "human:oidc:mia", "assignments": [{ "role": "viewer", "scope": ["namespace:x"] }] }))
        .await;
    a.error(5, Code::InvalidArgument).await;
    a.call(
        6,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:nobody", "assignments": [] }),
    )
    .await;
    a.error(6, Code::NotFound).await;
}

#[tokio::test]
async fn the_last_administrator_cannot_be_removed() {
    let t = start().await;
    let admin = admin_id(&t);
    let browser = t.browser_as(&admin, &[]).await;
    let mut a = t.tab(&browser).await;
    // The default administrator is the only one: it cannot be disabled.
    a.call(1, "admin.users.disable", json!({ "userId": admin }))
        .await;
    let err = a.error(1, Code::FailedPrecondition).await;
    assert!(
        err.message.contains("last administrator"),
        "{}",
        err.message
    );
    // Its own admin is pinned: replacing its direct roles keeps it an administrator.
    a.call(
        2,
        "admin.users.setRoles",
        json!({ "userId": admin, "assignments": [] }),
    )
    .await;
    a.result(2).await;
    a.call(3, "admin.users.get", json!({ "userId": admin }))
        .await;
    let me = a.result(3).await;
    assert_eq!(me["defaultAdmin"], true);
    assert!(
        me["roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["role"] == "admin" && r["via"] == "pinned")
    );

    // With a second administrator, the default one can be disabled; the second then cannot.
    t.server
        .store()
        .record_oidc_user("human:oidc:ada", "ada", "Ada", None, &[], 1)
        .unwrap();
    a.call(
        4,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:ada", "assignments": [{ "role": "admin" }] }),
    )
    .await;
    a.result(4).await;
    let ada = t.browser_as("human:oidc:ada", &[]).await;
    let mut b = t.tab(&ada).await;
    b.call(1, "admin.users.disable", json!({ "userId": admin }))
        .await;
    b.result(1).await;
    // The disabled administrator's sessions ended.
    a.client.expect_goaway().await;
    b.call(
        2,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:ada", "assignments": [] }),
    )
    .await;
    b.error(2, Code::FailedPrecondition).await;
    b.call(3, "admin.users.enable", json!({ "userId": admin }))
        .await;
    b.result(3).await;
    b.call(
        4,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:ada", "assignments": [] }),
    )
    .await;
    // Ada took her own admin away: her session ends with the change.
    b.client.expect_goaway().await;
    let ada = t.server.policy().current().in_force("human:oidc:ada", &[]);
    assert!(!mightyconsole_server::authz::is_administrator(&ada));
}

#[tokio::test]
async fn accounts_are_made_reset_and_deleted_by_an_administrator() {
    let t = start().await;
    let browser = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&browser).await;
    a.call(1, "admin.groups.create", json!({ "name": "team-a" }))
        .await;
    a.result(1).await;
    a.call(
        2,
        "admin.users.create",
        json!({ "username": "dora", "displayName": "Dora", "roles": [{ "role": "operator" }], "groups": ["team-a"] }),
    )
    .await;
    let made = a.result(2).await;
    assert!(made["url"].as_str().unwrap().contains("/auth/setup?token="));
    let dora = made["userId"].as_str().unwrap().to_owned();
    a.call(3, "admin.users.get", json!({ "userId": dora }))
        .await;
    let user = a.result(3).await;
    assert_eq!(user["username"], "dora");
    assert_eq!(user["localGroups"], json!(["team-a"]));
    assert!(
        user["roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["role"] == "operator" && r["via"] == "direct")
    );
    a.call(4, "admin.users.create", json!({ "username": "dora" }))
        .await;
    a.error(4, Code::InvalidArgument).await;

    a.call(
        5,
        "admin.users.resetPassword",
        json!({ "userId": dora, "removeTotp": true }),
    )
    .await;
    assert!(
        a.result(5).await["url"]
            .as_str()
            .unwrap()
            .contains("token=")
    );
    a.call(6, "admin.users.unlock", json!({ "userId": dora }))
        .await;
    a.result(6).await;

    // A wrong user name is refused after the confirmation; the right one deletes the account,
    // its assignments and its group memberships.
    a.confirmed(
        7,
        "admin.users.delete",
        json!({ "userId": dora, "username": "dore" }),
    )
    .await;
    a.error(7, Code::InvalidArgument).await;
    a.confirmed(
        12,
        "admin.users.delete",
        json!({ "userId": dora, "username": "dora" }),
    )
    .await;
    a.result(12).await;
    a.call(17, "admin.users.get", json!({ "userId": dora }))
        .await;
    a.error(17, Code::NotFound).await;
    a.call(18, "admin.groups.list", json!({})).await;
    assert_eq!(
        a.result(18).await["localGroups"],
        json!([{ "name": "team-a", "members": [] }])
    );
    // The default administrator cannot be deleted, and an OIDC user is disabled instead.
    let admin = admin_id(&t);
    a.confirmed(
        19,
        "admin.users.delete",
        json!({ "userId": admin, "username": "admin" }),
    )
    .await;
    a.error(19, Code::FailedPrecondition).await;
}

#[tokio::test]
async fn custom_roles_and_group_mappings() {
    let t = start().await;
    let browser = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&browser).await;
    a.call(1, "admin.roles.list", json!({})).await;
    let roles = a.result(1).await;
    let ids: Vec<&str> = roles["roles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["member", "viewer", "operator", "admin"]);
    assert!(
        roles["catalogue"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["perm"] == "k8s.exec" && p["targetKind"] == "profile")
    );

    // A custom role: exec brings term.write; unknown permissions and built-in ids are refused.
    a.call(
        2,
        "admin.roles.create",
        json!({ "id": "shell", "name": "Shell", "permissions": ["docker.read", "docker.exec"] }),
    )
    .await;
    let shell = a.result(2).await;
    assert_eq!(
        shell["permissions"],
        json!(["docker.exec", "docker.read", "term.write"])
    );
    for bad in [
        json!({ "id": "viewer", "name": "x", "permissions": [] }),
        json!({ "id": "x1", "name": "x", "permissions": ["docker.everything"] }),
        json!({ "id": "x2", "name": "x", "permissions": ["app.self"] }),
        json!({ "id": "Bad", "name": "x", "permissions": [] }),
    ] {
        a.call(3, "admin.roles.create", bad).await;
        a.error(3, Code::InvalidArgument).await;
        a.call(4, "app.me", json!({})).await;
        a.result(4).await;
    }

    // Mapped to a local group with members.
    t.server
        .store()
        .record_oidc_user("human:oidc:sam", "sam", "Sam", None, &[], 1)
        .unwrap();
    a.call(
        5,
        "admin.groups.create",
        json!({ "name": "shells", "members": ["human:oidc:sam"] }),
    )
    .await;
    a.result(5).await;
    a.call(6, "admin.groups.list", json!({})).await;
    let etag = a.result(6).await["etag"].as_u64().unwrap();
    a.call(
        7,
        "admin.groups.set",
        json!({ "etag": etag, "mappings": [{ "group": "local:shells", "role": "shell" }] }),
    )
    .await;
    let groups = a.result(7).await;
    assert_eq!(
        groups["mappings"],
        json!([{ "group": "local:shells", "role": "shell", "scope": null }])
    );
    a.call(
        8,
        "admin.groups.set",
        json!({ "etag": etag, "mappings": [] }),
    )
    .await;
    let stale = a.error(8, Code::FailedPrecondition).await;
    assert!(stale.message.contains("changed"), "{}", stale.message);
    a.call(9, "admin.users.get", json!({ "userId": "human:oidc:sam" }))
        .await;
    let sam = a.result(9).await;
    assert!(
        sam["roles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["role"] == "shell" && r["via"] == "group:local:shells")
    );

    // Neither the role nor the group goes while the mapping names them.
    a.confirmed(10, "admin.roles.delete", json!({ "roleId": "shell" }))
        .await;
    a.error(10, Code::FailedPrecondition).await;
    a.confirmed(15, "admin.groups.delete", json!({ "name": "shells" }))
        .await;
    a.error(15, Code::FailedPrecondition).await;
    a.call(
        20,
        "admin.groups.set",
        json!({ "etag": etag + 1, "mappings": [] }),
    )
    .await;
    a.result(20).await;
    a.call(
        21,
        "admin.groups.removeMembers",
        json!({ "name": "shells", "members": ["human:oidc:sam"] }),
    )
    .await;
    a.result(21).await;
    a.confirmed(22, "admin.groups.delete", json!({ "name": "shells" }))
        .await;
    a.result(22).await;
    a.confirmed(27, "admin.roles.delete", json!({ "roleId": "shell" }))
        .await;
    a.result(27).await;
    a.call(32, "admin.roles.get", json!({ "roleId": "shell" }))
        .await;
    a.error(32, Code::NotFound).await;
    // Members must be known users.
    a.call(
        33,
        "admin.groups.create",
        json!({ "name": "ghosts", "members": ["human:oidc:nobody"] }),
    )
    .await;
    a.error(33, Code::InvalidArgument).await;
}

#[tokio::test]
async fn sessions_are_listed_and_revoked_own_and_by_an_administrator() {
    let t = start().await;
    let admin = admin_id(&t);
    let browser = t.browser_as(&admin, &[]).await;
    let mut a = t.tab(&browser).await;
    let other = t.browser_as("human:oidc:olga", &[]).await;
    let mut o = t.tab(&other).await;
    let second = t.browser_as("human:oidc:olga", &[]).await;
    let mut o2 = t.tab(&second).await;

    // Olga sees and ends one of her own sessions; not someone else's.
    o.call(1, "app.sessions.list", json!({})).await;
    let mine = o.result(1).await["sessions"].as_array().unwrap().clone();
    assert_eq!(mine.len(), 2);
    let other_one = mine.iter().find(|s| s["current"] == false).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    o.call(2, "app.sessions.revoke", json!({ "sessionId": other_one }))
        .await;
    assert_eq!(o.result(2).await["revoked"], 1);
    o2.client.expect_goaway().await;
    a.call(1, "app.sessions.list", json!({})).await;
    let admins = a.result(1).await["sessions"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    o.call(3, "app.sessions.revoke", json!({ "sessionId": admins }))
        .await;
    o.error(3, Code::NotFound).await;
    // Olga may not list or end others' sessions.
    o.call(4, "admin.sessions.list", json!({})).await;
    o.error(4, Code::PermissionDenied).await;

    a.call(2, "admin.sessions.list", json!({})).await;
    assert_eq!(a.result(2).await["sessions"].as_array().unwrap().len(), 2);
    a.call(3, "admin.sessions.revoke", json!({ "all": true }))
        .await;
    assert_eq!(a.result(3).await["revoked"], 1);
    o.client.expect_goaway().await;
    a.call(4, "admin.sessions.revoke", json!({})).await;
    a.error(4, Code::InvalidArgument).await;
    a.call(5, "admin.sessions.list", json!({})).await;
    assert_eq!(
        a.result(5).await["sessions"].as_array().unwrap().len(),
        1,
        "the caller's own kept"
    );
}

#[tokio::test]
async fn a_refusal_by_role_and_a_role_change_are_in_the_audit_log() {
    use audit_jsonl::read_records;
    use mightyconsole_server::StartOptions;
    use mightyconsole_server::audit::log_path;
    use security_types::{AuditDecision, Outcome, Reason};

    let t = start_with_durable_audit(StartOptions::default()).await;
    let path = log_path(t._dir.path());
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let member = t.browser_as("human:oidc:mia", &[]).await;
    let mut m = t.tab(&member).await;
    t.server
        .store()
        .record_oidc_user("human:oidc:mia", "mia", "Mia", None, &[], 1)
        .unwrap();
    m.call(1, "admin.users.list", json!({})).await;
    m.error(1, Code::PermissionDenied).await;
    a.call(
        1,
        "admin.users.setRoles",
        json!({ "userId": "human:oidc:mia", "assignments": [{ "role": "viewer" }] }),
    )
    .await;
    a.result(1).await;
    a.disconnect().await;
    m.disconnect().await;
    t.server.shutdown().await.unwrap();

    let records = read_records(&path).unwrap();
    let refused = records
        .iter()
        .map(|r| &r.entry)
        .find(|e| e.action.name == "admin.users.list")
        .expect("the refusal");
    assert_eq!(
        refused.decision,
        AuditDecision::Deny {
            reason: Reason::MissingPermission {
                perm: "admin.users.read".into()
            }
        }
    );
    assert_eq!(refused.principal_chain[0].id, "human:oidc:mia");
    let change = records
        .iter()
        .map(|r| &r.entry)
        .find(|e| e.action.name == "admin.users.setRoles" && e.outcome == Outcome::Success)
        .expect("the role change");
    assert_eq!(change.risk, security_types::Risk::Write);
}
