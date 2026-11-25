//! SSH hosts over the wire (DOC-23 §4.3, §6.4, §8.1, (x), (z); TSK-144): a saved login that Docker
//! profiles name; its secrets are write-only and bound to its address, user and trusted key; a
//! personal profile names its owner's own hosts and a shared profile shared ones; a host in use is
//! not deleted; Docker profiles of version 1 become an SSH host and a profile of version 2, when
//! imported and at start, without losing anything.

mod support;

use ambidex::Code;
use mightyconsole_server::secrets::{Owner, Secret};
use serde_json::{Value, json};
use support::*;

/// A value no answer may contain.
const KEY: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nkey-do-not-leak-5e1a\n";

fn admin_id(t: &TestServer) -> String {
    t.server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id()
}

fn no_secret(value: &Value) {
    assert!(
        !value.to_string().contains("key-do-not-leak"),
        "a secret value in an answer: {value}"
    );
}

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

fn login(host: &str, user: &str) -> Value {
    json!({ "host": host, "port": 22, "username": user, "auth": "privateKey" })
}

#[tokio::test]
async fn a_host_s_key_is_write_only_and_a_personal_profile_names_only_its_owner_s_hosts() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = user_with_role(&t, &mut a, 1, "human:oidc:mia", "member").await;
    let mut noor = user_with_role(&t, &mut a, 2, "human:oidc:noor", "member").await;

    mia.call(
        1,
        "sshHosts.create",
        json!({ "name": "build", "owner": { "kind": "personal" }, "fields": login("build.lan", "deploy"),
                "secrets": { "privateKey": KEY } }),
    )
    .await;
    let host = mia.result(1).await;
    no_secret(&host);
    assert_eq!(host["access"], "owner");
    assert_eq!(host["fields"]["host"], "build.lan");
    assert_eq!(host["secrets"][0]["field"], "privateKey");
    let host_id = host["id"].as_str().unwrap().to_owned();

    // Another member neither sees it nor names it.
    noor.call(1, "sshHosts.list", json!({})).await;
    assert_eq!(noor.result(1).await["hosts"], json!([]));
    noor.call(
        2,
        "profiles.create",
        json!({ "tool": "docker", "name": "Theirs", "owner": { "kind": "personal" }, "fields": { "sshHostId": host_id } }),
    )
    .await;
    let err = noor.error(2, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "fields.sshHostId");

    // A shared profile names shared hosts only, even for an administrator.
    a.call(
        3,
        "profiles.create",
        json!({ "tool": "docker", "name": "Shared", "owner": { "kind": "shared" }, "fields": { "sshHostId": host_id } }),
    )
    .await;
    a.error(3, Code::InvalidArgument).await;

    // Its owner names it; the host lists the profile that uses it.
    mia.call(
        2,
        "profiles.create",
        json!({ "tool": "docker", "name": "Build", "owner": { "kind": "personal" }, "fields": { "sshHostId": host_id, "socketPath": "/var/run/docker.sock" } }),
    )
    .await;
    let profile = mia.result(2).await;
    assert_eq!(profile["version"], 2);
    let profile_id = profile["id"].as_str().unwrap().to_owned();
    mia.call(3, "sshHosts.list", json!({})).await;
    let listed = mia.result(3).await;
    no_secret(&listed);
    assert_eq!(
        listed["hosts"][0]["usedBy"],
        json!([{ "id": profile_id, "tool": "docker", "name": "Build" }])
    );

    // A login typed into a Docker profile is refused: it belongs to the host.
    mia.call(
        4,
        "profiles.update",
        json!({ "id": profile_id, "etag": profile["etag"], "secrets": { "privateKey": KEY } }),
    )
    .await;
    mia.error(4, Code::InvalidArgument).await;

    // In use: not deleted, and the refusal names the profile.
    mia.confirmed(
        6,
        "sshHosts.delete",
        json!({ "id": host_id, "name": "build" }),
    )
    .await;
    let err = mia.error(6, Code::FailedPrecondition).await;
    assert!(err.message.contains("Build (docker)"), "{}", err.message);

    // Once no profile names it, it goes with its key.
    mia.confirmed(
        7,
        "profiles.delete",
        json!({ "id": profile_id, "name": "Build" }),
    )
    .await;
    mia.result(7).await;
    mia.confirmed(
        8,
        "sshHosts.delete",
        json!({ "id": host_id, "name": "build" }),
    )
    .await;
    mia.result(8).await;
    assert!(
        t.server
            .store()
            .secret_entries(Some(&Owner::ssh_host(&host_id)))
            .unwrap()
            .is_empty(),
        "the host's secrets went with it"
    );
}

#[tokio::test]
async fn a_changed_address_or_trusted_key_removes_the_login_s_secrets_and_the_first_key_does_not() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(
        1,
        "sshHosts.create",
        json!({ "name": "h", "owner": { "kind": "personal" }, "fields": login("h.lan", "u"), "secrets": { "privateKey": KEY } }),
    )
    .await;
    let host = a.result(1).await;
    let id = host["id"].clone();
    let key_a = json!({ "algorithm": "ssh-ed25519", "fingerprintSha256": "SHA256:A" });
    let mut trusted = login("h.lan", "u");
    trusted["hostKey"] = key_a;
    a.call(
        2,
        "sshHosts.update",
        json!({ "id": id, "etag": host["etag"], "fields": trusted }),
    )
    .await;
    let out = a.result(2).await;
    assert_eq!(out["removedSecrets"], json!([]), "trusting the first key");
    assert_eq!(out["host"]["secrets"][0]["field"], "privateKey");

    let mut replaced = trusted.clone();
    replaced["hostKey"]["fingerprintSha256"] = json!("SHA256:B");
    a.call(
        3,
        "sshHosts.update",
        json!({ "id": id, "etag": out["host"]["etag"], "fields": replaced }),
    )
    .await;
    let out = a.result(3).await;
    assert_eq!(out["removedSecrets"], json!(["privateKey"]));

    let moved = login("evil.example", "u");
    a.call(
        4,
        "sshHosts.update",
        json!({ "id": id, "etag": out["host"]["etag"], "fields": moved, "secrets": { "privateKey": KEY } }),
    )
    .await;
    let out = a.result(4).await;
    no_secret(&out);
    assert_eq!(
        out["removedSecrets"],
        json!([]),
        "a key set in the same call stays"
    );
}

#[tokio::test]
async fn imported_docker_profiles_of_version_1_become_hosts_identical_logins_merge_and_names_get_a_number()
 {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let v1 = |name: &str, user: &str| {
        json!({ "tool": "docker", "version": 1, "name": name,
                "fields": { "host": "docker1.lan", "port": 22, "username": user, "auth": "privateKey",
                            "hostKey": null, "socketPath": "/run/docker.sock", "keepaliveSec": 30 } })
    };
    let import = |source: &str, record: Value| json!({ "sourceId": source, "record": record, "secrets": { "privateKey": KEY }, "owner": { "kind": "personal" } });
    a.call(1, "profiles.import", import("B1", v1("one", "deploy")))
        .await;
    let one = a.result(1).await;
    no_secret(&one);
    assert_eq!(one["profile"]["version"], 2);
    assert_eq!(
        one["profile"]["fields"]["socketPath"], "/run/docker.sock",
        "the socket path stays"
    );
    assert!(one["profile"]["fields"].get("host").is_none());
    assert_eq!(one["profile"]["secrets"], json!([]));
    a.call(2, "profiles.import", import("B2", v1("two", "deploy")))
        .await;
    let two = a.result(2).await;
    assert_eq!(
        two["profile"]["fields"]["sshHostId"], one["profile"]["fields"]["sshHostId"],
        "an identical login is one host"
    );
    a.call(3, "profiles.import", import("B3", v1("three", "ops")))
        .await;
    let three = a.result(3).await;
    assert_ne!(
        three["profile"]["fields"]["sshHostId"],
        one["profile"]["fields"]["sshHostId"]
    );
    // A repeated import answers the same profile and makes no host.
    a.call(4, "profiles.import", import("B1", v1("one", "deploy")))
        .await;
    assert_eq!(a.result(4).await["created"], false);

    a.call(5, "sshHosts.list", json!({})).await;
    let hosts = a.result(5).await;
    let mut names: Vec<&str> = hosts["hosts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|h| h["name"].as_str().unwrap())
        .collect();
    names.sort_unstable();
    assert_eq!(names, ["docker1.lan", "docker1.lan-2"]);
    for host in hosts["hosts"].as_array().unwrap() {
        assert_eq!(host["secrets"][0]["field"], "privateKey");
        assert_eq!(host["fields"]["keepaliveSec"], 30);
    }
}

#[tokio::test]
async fn a_stored_docker_profile_of_version_1_moves_its_login_to_a_host_and_keeps_a_backup() {
    use mightyconsole_server::profiles::table::{Ownership, StoredProfile};
    let t = start().await;
    let owner = admin_id(&t);
    let store = t.server.store();
    let row = StoredProfile {
        id: "01OLDDOCKERPROFILE00000000".into(),
        tool: "docker".into(),
        version: 1,
        name: "old".into(),
        color: None,
        fields: json!({ "host": "old.lan", "port": 2222, "username": "deploy", "auth": "password",
                        "hostKey": { "algorithm": "ssh-ed25519", "fingerprintSha256": "SHA256:K" },
                        "socketPath": "/var/run/docker.sock", "keepaliveSec": 10 }),
        extras: json!({}),
        owner: Ownership::Personal {
            user: owner.clone(),
        },
        etag: 0,
        created_at: String::new(),
        updated_at: String::new(),
        created_by: owner.clone(),
        updated_by: owner.clone(),
    };
    let stored = store.put_profile(row, None, |_, _| Ok(())).unwrap();
    let profile_owner = Owner::profile(&stored.id);
    t.server
        .vault()
        .set(
            store,
            &profile_owner,
            "password",
            &Secret::new(b"pw-moved".to_vec()),
            &owner,
            1,
        )
        .unwrap();

    let (moved, made) = t.server.profiles().migrate_docker_profiles(2).unwrap();
    assert_eq!((moved, made), (1, 1));
    // Once only.
    assert_eq!(
        t.server.profiles().migrate_docker_profiles(3).unwrap(),
        (0, 0)
    );

    let now = store.profile(&stored.id).unwrap().unwrap();
    assert_eq!(now.version, 2);
    let host_id = now.fields["sshHostId"].as_str().unwrap().to_owned();
    assert_eq!(
        now.fields,
        json!({ "socketPath": "/var/run/docker.sock", "sshHostId": host_id })
    );
    let host = store.ssh_host(&host_id).unwrap().unwrap();
    assert_eq!(host.name, "old.lan");
    assert_eq!(host.fields["port"], 2222);
    assert_eq!(host.fields["hostKey"]["fingerprintSha256"], "SHA256:K");
    assert_eq!(host.owner, now.owner);
    assert!(
        store
            .secret_entries(Some(&profile_owner))
            .unwrap()
            .is_empty()
    );
    let moved_secret = t
        .server
        .vault()
        .get(store, &Owner::ssh_host(&host_id), "password")
        .unwrap()
        .unwrap();
    assert_eq!(moved_secret.as_str(), Some("pw-moved"));
    let backup = store.profile_backup(&stored.id).unwrap().unwrap();
    assert_eq!(backup.version, 1);
    assert_eq!(backup.fields["host"], "old.lan");
}
