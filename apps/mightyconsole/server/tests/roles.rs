//! Roles over the wire (DOC-25 §3.3, TSK-138): what the Authorizer decides reaches the browser as
//! `PermissionDenied` with the permission, the target the server built and the reason; the
//! default role, group mappings and disabled users apply to the next call.

mod support;

use std::collections::BTreeSet;

use ambidex::Code;
use mightyconsole_server::StartOptions;
use mightyconsole_server::authz::policy::{CustomRole, GroupMapping};
use security_types::Scope;
use serde_json::{Value, json};
use support::*;

fn details(err: &ambidex::ErrorPayload) -> Value {
    err.details.clone().expect("PermissionDenied details")
}

#[tokio::test]
async fn a_user_without_a_role_can_only_see_who_they_are() {
    let t = start_configured(None, StartOptions::default(), |c| {
        c.auth.default_role = None;
    })
    .await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.call(1, "app.me", json!({})).await;
    assert!(
        tab.result(1).await["user"]
            .as_str()
            .unwrap()
            .starts_with("human:account:")
    );
    tab.call(2, "app.info", json!({})).await;
    let err = tab.error(2, Code::PermissionDenied).await;
    assert_eq!(
        details(&err),
        json!({ "perm": "app.read", "reason": "missing" })
    );
    // No connection: no role lets them read a profile, nor keep one of their own.
    tab.call_raw(3, "echo.connect", json!({ "profileId": "P1" }))
        .await;
    let err = tab.error(3, Code::PermissionDenied).await;
    assert_eq!(
        details(&err),
        json!({
            "perm": "echo.read",
            "target": { "kind": "profile", "id": "P1" },
            "reason": "missing",
        })
    );
}

#[tokio::test]
async fn a_member_has_every_right_on_their_own_connection() {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    let conn = tab.connect(1).await;
    tab.call(
        2,
        "echo.messages.produce",
        json!({ "connId": conn, "value": { "codec": "utf8", "text": "v" } }),
    )
    .await;
    tab.result(2).await;
}

#[tokio::test]
async fn without_profiles_personal_the_roles_bind_on_shared_profiles() {
    let t = start().await;
    t.server.policy().update(|p| {
        p.custom_roles.push(CustomRole {
            id: "reader".into(),
            name: "Reader".into(),
            description: String::new(),
            permissions: BTreeSet::from(["app.read".to_owned(), "echo.read".to_owned()]),
        });
        p.default_role = Some("reader".into());
    });
    let admin_id = t
        .server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id();
    let admin = t.browser_as(&admin_id, &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(
        1,
        "profiles.create",
        json!({ "tool": "echo", "name": "Team", "owner": { "kind": "shared" }, "fields": {} }),
    )
    .await;
    let team = a.result(1).await["id"].as_str().unwrap().to_owned();
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    // Without profiles.personal the reader keeps no profile of their own.
    tab.call(
        1,
        "profiles.create",
        json!({ "tool": "echo", "name": "Mine", "owner": { "kind": "personal" }, "fields": {} }),
    )
    .await;
    tab.error(1, Code::PermissionDenied).await;
    tab.call(4, "echo.connect", json!({ "profileId": team }))
        .await;
    let conn = tab.result(4).await["connId"].as_str().unwrap().to_owned();
    tab.call(2, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    assert_eq!(tab.result(2).await["text"], "hi");
    tab.call(
        3,
        "echo.messages.produce",
        json!({ "connId": conn, "value": { "codec": "utf8", "text": "v" } }),
    )
    .await;
    let err = tab.error(3, Code::PermissionDenied).await;
    assert_eq!(
        details(&err),
        json!({
            "perm": "echo.write",
            "target": { "kind": "profile", "id": team },
            "reason": "missing",
        })
    );
    // Another session's handle is `NotFound` before any role is asked, as the handler says.
    let other = t.browser().await;
    let mut tab2 = t.tab(&other).await;
    tab2.call(1, "echo.ping", json!({ "connId": conn, "text": "hi" }))
        .await;
    not_found_connection(&tab2.error(1, Code::NotFound).await);
}

#[tokio::test]
async fn group_mappings_come_from_the_session_and_changes_apply_to_the_next_call() {
    let t = start_configured(None, StartOptions::default(), |c| {
        c.auth.default_role = None;
        c.auth.group_roles.push(GroupMapping {
            group: "idp:ops".into(),
            role: "viewer".into(),
            scope: Scope::everywhere(),
        });
    })
    .await;
    let ops = t.browser_as("human:oidc:olga", &["ops"]).await;
    let mut tab = t.tab(&ops).await;
    tab.call(1, "app.info", json!({})).await;
    tab.result(1).await;
    let outsider = t.browser_as("human:oidc:otto", &["dev"]).await;
    let mut tab2 = t.tab(&outsider).await;
    tab2.call(1, "app.info", json!({})).await;
    tab2.error(1, Code::PermissionDenied).await;

    // Disabled: the next call is refused, even `app.me`.
    t.server.policy().update(|p| {
        p.disabled.insert("human:oidc:olga".into());
    });
    tab.call(2, "app.me", json!({})).await;
    let err = tab.error(2, Code::PermissionDenied).await;
    assert_eq!(details(&err)["reason"], "policy");
}

#[tokio::test]
async fn the_default_administrator_can_be_off_with_a_pinned_administrator_group() {
    let t = start_configured(None, StartOptions::default(), |c| {
        c.auth.default_admin = false;
        c.auth.group_roles.push(GroupMapping {
            group: "idp:platform-admins".into(),
            role: "admin".into(),
            scope: Scope::everywhere(),
        });
    })
    .await;
    assert!(!t._dir.path().join("admin-password").exists());
    assert!(
        t.server
            .store()
            .account_by_username("admin")
            .unwrap()
            .is_none()
    );
    let admin = t.browser_as("human:oidc:ada", &["platform-admins"]).await;
    let mut tab = t.tab(&admin).await;
    tab.call(1, "app.info", json!({})).await;
    tab.result(1).await;
}

#[tokio::test]
async fn the_default_administrator_holds_admin_pinned() {
    let t = start().await;
    let account = t
        .server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("made on the first start");
    let policy = t.server.policy().current();
    let roles = policy.in_force(&account.principal_id(), &[]);
    assert!(mightyconsole_server::authz::is_administrator(&roles));
    assert!(roles.iter().any(|a| a.via.label() == "pinned"));
}
