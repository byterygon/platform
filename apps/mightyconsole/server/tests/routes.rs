//! Proxies, links and routes over the wire (DOC-23 §8.1, §9, (aa) to (ac), (v), (s); TSK-117):
//! a proxy's password is write-only; a route goes through its owner's own proxies and hosts, and
//! a personal profile names its owner's own routes; a command hop needs `profiles.hostAccess`
//! and a confirmation before anything may use it; a deleted route leaves "Route missing", never
//! Direct; `routes.test` reports each hop and the target, and names the hop that failed.

use crate::support::*;
use ambidex::Code;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// A value no answer may contain.
const PASSWORD: &str = "proxy-password-do-not-leak-7c2";

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
        !value.to_string().contains("do-not-leak"),
        "a secret value in an answer: {value}"
    );
}

async fn member(t: &TestServer, admin: &mut Tab, id: u32, user: &str) -> Tab {
    t.server
        .store()
        .record_oidc_user(user, user, user, None, &[], 1)
        .unwrap();
    admin
        .call(
            id,
            "admin.users.setRoles",
            json!({ "userId": user, "assignments": [{ "role": "member" }] }),
        )
        .await;
    admin.result(id).await;
    let browser = t.browser_as(user, &[]).await;
    t.tab(&browser).await
}

fn http_proxy(host: &str, port: u16) -> Value {
    json!({ "kind": "httpConnect", "host": host, "port": port, "tls": false })
}

/// A tiny HTTP CONNECT proxy: answers `status` to every CONNECT, and with 200 joins the client
/// to the address it asked for.
async fn connect_proxy(status: u16) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut client, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    if client.read(&mut byte).await.unwrap_or(0) == 0 {
                        return;
                    }
                    head.push(byte[0]);
                }
                let text = String::from_utf8_lossy(&head).to_string();
                let target = text
                    .split_whitespace()
                    .nth(1)
                    .unwrap_or_default()
                    .to_owned();
                if status != 200 {
                    let _ = client
                        .write_all(format!("HTTP/1.1 {status} No\r\n\r\n").as_bytes())
                        .await;
                    return;
                }
                let Ok(mut upstream) = tokio::net::TcpStream::connect(&target).await else {
                    let _ = client.write_all(b"HTTP/1.1 502 Bad\r\n\r\n").await;
                    return;
                };
                let _ = client.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
                let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
            });
        }
    });
    port
}

#[tokio::test]
async fn a_route_goes_through_its_owner_s_proxies_and_hosts_and_they_stay_while_it_uses_them() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = member(&t, &mut a, 1, "human:oidc:mia").await;
    let mut noor = member(&t, &mut a, 2, "human:oidc:noor").await;

    mia.call(
        1,
        "proxies.create",
        json!({ "name": "corp", "owner": { "kind": "personal" },
                "fields": { "kind": "httpConnect", "host": "proxy.corp", "port": 3128, "tls": false, "username": "mia" },
                "password": PASSWORD }),
    )
    .await;
    let proxy = mia.result(1).await;
    no_secret(&proxy);
    assert_eq!(proxy["url"], "http://proxy.corp:3128");
    assert_eq!(proxy["secrets"][0]["field"], "password");
    let proxy_id = proxy["id"].as_str().unwrap().to_owned();
    mia.call(
        2,
        "sshHosts.create",
        json!({ "name": "bastion", "owner": { "kind": "personal" },
                "fields": { "host": "bastion.prod", "username": "deploy", "auth": "agent" } }),
    )
    .await;
    let host_id = mia.result(2).await["id"].as_str().unwrap().to_owned();

    // Someone else's proxy is not a hop of theirs.
    noor.call(
        1,
        "routes.create",
        json!({ "name": "x", "owner": { "kind": "personal" }, "hops": [{ "kind": "proxy", "proxyId": proxy_id }] }),
    )
    .await;
    let err = noor.error(1, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "hops.0.proxyId");

    mia.call(
        3,
        "routes.create",
        json!({ "name": "prod", "owner": { "kind": "personal" },
                "hops": [{ "kind": "proxy", "proxyId": proxy_id }, { "kind": "ssh", "sshHostId": host_id }] }),
    )
    .await;
    let route = mia.result(3).await;
    no_secret(&route);
    assert_eq!(route["confirmed"], true);
    let hops = route["hops"].as_array().unwrap();
    assert_eq!(
        hops.iter()
            .map(|h| (h["kind"].as_str().unwrap(), h["label"].as_str().unwrap()))
            .collect::<Vec<_>>(),
        [
            ("httpConnect", "proxy.corp:3128"),
            ("ssh", "bastion.prod:22")
        ]
    );
    let route_id = route["id"].as_str().unwrap().to_owned();

    // A personal profile names its owner's own route; another member's is refused.
    mia.call(
        4,
        "profiles.create",
        json!({ "tool": "temporal", "name": "Prod", "owner": { "kind": "personal" },
                "fields": { "address": "temporal.prod.internal:7233", "routeId": route_id } }),
    )
    .await;
    let profile = mia.result(4).await;
    let profile_id = profile["id"].as_str().unwrap().to_owned();
    noor.call(
        2,
        "profiles.create",
        json!({ "tool": "temporal", "name": "Theirs", "owner": { "kind": "personal" },
                "fields": { "address": "t:7233", "routeId": route_id } }),
    )
    .await;
    let err = noor.error(2, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "fields.routeId");
    // NATS waits for its forwarder (TSK-118).
    mia.call(
        5,
        "profiles.create",
        json!({ "tool": "nats", "name": "N", "owner": { "kind": "personal" },
                "fields": { "servers": ["nats://n:4222"], "routeId": route_id } }),
    )
    .await;
    mia.error(5, Code::InvalidArgument).await;

    mia.call(6, "routes.list", json!({})).await;
    let listed = mia.result(6).await;
    assert_eq!(
        listed["routes"][0]["usedBy"],
        json!([{ "id": profile_id, "tool": "temporal", "name": "Prod" }])
    );
    mia.call(7, "proxies.list", json!({})).await;
    let proxies = mia.result(7).await;
    no_secret(&proxies);
    assert_eq!(proxies["proxies"][0]["usedBy"][0]["tool"], "route");

    // The proxy and the host stay while the route goes through them.
    mia.confirmed(
        8,
        "proxies.delete",
        json!({ "id": proxy_id, "name": "corp" }),
    )
    .await;
    let err = mia.error(8, Code::FailedPrecondition).await;
    assert!(err.message.contains("prod (route)"), "{}", err.message);
    mia.confirmed(
        9,
        "sshHosts.delete",
        json!({ "id": host_id, "name": "bastion" }),
    )
    .await;
    mia.error(9, Code::FailedPrecondition).await;

    // Deleting the route leaves the profile with "Route missing": it never connects Direct.
    mia.confirmed(
        10,
        "routes.delete",
        json!({ "id": route_id, "name": "prod" }),
    )
    .await;
    mia.result(10).await;
    mia.call(11, "temporal.connect", json!({ "profileId": profile_id }))
        .await;
    let err = mia.error(11, Code::InvalidArgument).await;
    assert!(err.message.contains("Route missing"), "{}", err.message);
    // Its links went with it; the proxy is free again.
    mia.confirmed(
        12,
        "proxies.delete",
        json!({ "id": proxy_id, "name": "corp" }),
    )
    .await;
    mia.result(12).await;
}

#[tokio::test]
async fn a_command_hop_needs_host_access_and_a_confirmation_and_a_change_asks_again() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = member(&t, &mut a, 1, "human:oidc:mia").await;
    let command = |args: Value| {
        json!([{ "kind": "command", "program": "/usr/bin/ssh", "args": args,
                 "env": [{ "name": "TOKEN", "secret": true, "value": "tok-do-not-leak" }] }])
    };

    mia.call(
        1,
        "routes.create",
        json!({ "name": "c", "owner": { "kind": "personal" }, "hops": command(json!(["-W", "{host}:{port}", "jump"])) }),
    )
    .await;
    mia.error(1, Code::PermissionDenied).await;

    a.call(
        2,
        "routes.create",
        json!({ "name": "c", "owner": { "kind": "personal" }, "hops": command(json!(["-W", "{host}:{port}", "jump"])) }),
    )
    .await;
    let route = a.result(2).await;
    no_secret(&route);
    assert_eq!(route["confirmed"], false);
    let hop = &route["hops"][0];
    assert_eq!(hop["needsConfirmation"], true);
    assert_eq!(
        hop["env"][0],
        json!({ "name": "TOKEN", "secret": true, "set": true })
    );
    let id = route["id"].as_str().unwrap().to_owned();

    // Not confirmed: not chosen, not tested.
    a.call(
        3,
        "profiles.create",
        json!({ "tool": "temporal", "name": "T", "owner": { "kind": "personal" },
                "fields": { "address": "t:7233", "routeId": id } }),
    )
    .await;
    a.error(3, Code::InvalidArgument).await;
    a.call(
        4,
        "routes.test",
        json!({ "routeId": id, "target": { "host": "t", "port": 7233 } }),
    )
    .await;
    a.error(4, Code::InvalidArgument).await;

    a.call(
        5,
        "routes.confirm",
        json!({ "id": id, "links": [hop["linkId"]] }),
    )
    .await;
    let confirmed = a.result(5).await;
    assert_eq!(confirmed["confirmed"], true);
    assert_eq!(confirmed["hops"][0]["confirmed"]["by"], admin_id(&t));

    // A new argument is another command: not confirmed, its secret carried over.
    a.call(
        6,
        "routes.update",
        json!({ "id": id, "etag": confirmed["etag"],
                "hops": [{ "kind": "command", "program": "/usr/bin/ssh", "args": ["-v", "-W", "{host}:{port}", "jump"],
                           "env": [{ "name": "TOKEN", "secret": true }] }] }),
    )
    .await;
    let changed = a.result(6).await;
    assert_eq!(changed["confirmed"], false);
    assert_eq!(changed["hops"][0]["env"][0]["set"], true);
    assert_ne!(changed["hops"][0]["linkId"], hop["linkId"]);

    // A duplicate names the same links, with their state.
    a.call(7, "routes.duplicate", json!({ "id": id, "name": "c copy" }))
        .await;
    let copy = a.result(7).await;
    assert_eq!(copy["hops"][0]["linkId"], changed["hops"][0]["linkId"]);
}

#[tokio::test]
async fn a_test_reports_each_hop_and_names_the_one_that_failed() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target_port = target.local_addr().unwrap().port();
    tokio::spawn(async move { while target.accept().await.is_ok() {} });

    let good = connect_proxy(200).await;
    let refusing = connect_proxy(407).await;
    let mut ids = Vec::new();
    for (i, port) in [good, refusing].into_iter().enumerate() {
        let n = u32::try_from(i).unwrap();
        a.call(
            1 + n,
            "proxies.create",
            json!({ "name": format!("p{i}"), "owner": { "kind": "personal" }, "fields": http_proxy("127.0.0.1", port) }),
        )
        .await;
        ids.push(a.result(1 + n).await["id"].as_str().unwrap().to_owned());
    }

    // A draft through the good proxy reaches the target.
    a.call(
        3,
        "routes.test",
        json!({ "hops": [{ "kind": "proxy", "proxyId": ids[0] }], "target": { "host": "127.0.0.1", "port": target_port } }),
    )
    .await;
    let out = a.result(3).await;
    assert_eq!(out["hops"], 1);
    let lines = out["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2, "{out}");
    assert_eq!(lines[0]["hop"]["kind"], "httpConnect");
    assert_eq!(lines[0]["ok"], true);
    assert_eq!(lines[1]["hop"]["kind"], "target");
    assert_eq!(lines[1]["ok"], true);

    // A saved route through the refusing one stops at it, as Auth.
    a.call(
        4,
        "routes.create",
        json!({ "name": "r", "owner": { "kind": "personal" }, "hops": [{ "kind": "proxy", "proxyId": ids[1] }] }),
    )
    .await;
    let route_id = a.result(4).await["id"].as_str().unwrap().to_owned();
    a.call(
        5,
        "routes.test",
        json!({ "routeId": route_id, "target": { "host": "127.0.0.1", "port": target_port } }),
    )
    .await;
    let out = a.result(5).await;
    let lines = out["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 1, "{out}");
    assert_eq!(lines[0]["ok"], false);
    assert_eq!(lines[0]["failure"], "Auth");
    assert_eq!(lines[0]["error"]["hop"]["index"], 0);
    assert!(
        lines[0]["error"]["message"]
            .as_str()
            .unwrap()
            .starts_with("through route r: hop 1 (httpConnect 127.0.0.1:"),
        "{out}"
    );
}

#[tokio::test]
async fn temporal_s_error_names_the_hop_through_tonic() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let refusing = connect_proxy(407).await;
    a.call(
        1,
        "proxies.create",
        json!({ "name": "p", "owner": { "kind": "personal" }, "fields": http_proxy("127.0.0.1", refusing) }),
    )
    .await;
    let proxy = a.result(1).await["id"].clone();
    a.call(
        2,
        "routes.create",
        json!({ "name": "r", "owner": { "kind": "personal" }, "hops": [{ "kind": "proxy", "proxyId": proxy }] }),
    )
    .await;
    let route = a.result(2).await["id"].clone();
    a.call(
        3,
        "profiles.create",
        json!({ "tool": "temporal", "name": "T", "owner": { "kind": "personal" },
                "fields": { "address": "temporal.prod.internal:7233", "routeId": route } }),
    )
    .await;
    let profile = a.result(3).await["id"].clone();
    a.call(4, "temporal.connect", json!({ "profileId": profile }))
        .await;
    let err = a.error(4, Code::Unauthenticated).await;
    let details = err.details.unwrap();
    assert_eq!(details["kind"], "Auth");
    assert_eq!(details["hop"]["index"], 0);
    assert!(
        err.message.starts_with("through route r: hop 1"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn the_map_s_links_are_saved_by_themselves_and_keep_to_the_rules_of_the_map() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = member(&t, &mut a, 1, "human:oidc:mia").await;
    let personal = json!({ "kind": "personal" });

    mia.call(
        1,
        "proxies.create",
        json!({ "name": "corp", "owner": personal,
                "fields": { "kind": "socks5", "host": "proxy.corp", "port": 1080, "tls": false } }),
    )
    .await;
    let proxy_id = mia.result(1).await["id"].as_str().unwrap().to_owned();
    mia.call(
        2,
        "sshHosts.create",
        json!({ "name": "bastion", "owner": personal,
                "fields": { "host": "bastion.prod", "username": "deploy", "auth": "agent" } }),
    )
    .await;
    let host_id = mia.result(2).await["id"].as_str().unwrap().to_owned();
    let server = json!({ "kind": "server" });
    let proxy = json!({ "kind": "proxy", "id": proxy_id });
    let host = json!({ "kind": "sshHost", "id": host_id });
    let plain = |method: &str| json!({ "method": method, "args": [], "env": [] });

    // Two links nobody's route uses yet are saved, and listed.
    mia.call(
        3,
        "links.create",
        json!({ "owner": personal, "from": server, "to": proxy, "spec": plain("tcp") }),
    )
    .await;
    let first = mia.result(3).await;
    assert_eq!(first["method"], "tcp");
    assert_eq!(first["usedBy"], json!([]));
    mia.call(
        4,
        "links.create",
        json!({ "owner": personal, "from": proxy, "to": host, "spec": plain("connect") }),
    )
    .await;
    let second = mia.result(4).await;
    mia.call(5, "links.list", json!({})).await;
    assert_eq!(mia.result(5).await["links"].as_array().unwrap().len(), 2);

    // The rules the map shows: one link a pair, no loop, nothing into this server, nothing out
    // of the target, and a method the source allows.
    for (id, from, to, method, code) in [
        (6, &server, &proxy, "tcp", Code::FailedPrecondition),
        (7, &host, &proxy, "ssh", Code::InvalidArgument),
        (8, &host, &server, "ssh", Code::InvalidArgument),
        (9, &proxy, &host, "connect", Code::FailedPrecondition),
        (21, &proxy, &host, "ssh", Code::InvalidArgument),
        (10, &server, &host, "connect", Code::InvalidArgument),
        (
            11,
            &json!({ "kind": "target" }),
            &host,
            "tcp",
            Code::InvalidArgument,
        ),
        (
            12,
            &host,
            &json!({ "kind": "target" }),
            "ssh",
            Code::InvalidArgument,
        ),
    ] {
        mia.call(
            id,
            "links.create",
            json!({ "owner": personal, "from": from, "to": to, "spec": plain(method) }),
        )
        .await;
        mia.error(id, code).await;
    }

    // A route over the saved links reuses them; they cannot be deleted while it does.
    mia.call(
        13,
        "routes.create",
        json!({ "name": "prod", "owner": personal,
                "hops": [{ "kind": "proxy", "proxyId": proxy_id }, { "kind": "ssh", "sshHostId": host_id }] }),
    )
    .await;
    let route = mia.result(13).await;
    assert_eq!(route["hops"][0]["linkId"], second["id"]);
    mia.call(14, "links.list", json!({})).await;
    let links = mia.result(14).await;
    assert_eq!(links["links"].as_array().unwrap().len(), 3);
    let used = links["links"]
        .as_array()
        .unwrap()
        .iter()
        .find(|l| l["id"] == first["id"])
        .unwrap();
    assert_eq!(used["usedBy"][0]["name"], "prod");
    mia.call(15, "links.delete", json!({ "id": first["id"] }))
        .await;
    let err = mia.error(15, Code::FailedPrecondition).await;
    assert!(err.message.contains("prod (route)"), "{}", err.message);

    // Deleting the route takes the link into the target, not the ones between nodes.
    mia.confirmed(
        16,
        "routes.delete",
        json!({ "id": route["id"], "name": "prod" }),
    )
    .await;
    mia.result(16).await;
    mia.call(17, "links.list", json!({})).await;
    assert_eq!(mia.result(17).await["links"].as_array().unwrap().len(), 2);
    mia.call(18, "links.delete", json!({ "id": first["id"] }))
        .await;
    mia.result(18).await;

    // A node's deletion takes the links drawn to and from it.
    mia.confirmed(
        19,
        "sshHosts.delete",
        json!({ "id": host_id, "name": "bastion" }),
    )
    .await;
    mia.result(19).await;
    mia.call(20, "links.list", json!({})).await;
    assert_eq!(mia.result(20).await["links"], json!([]));
}

#[tokio::test]
async fn a_command_link_needs_host_access_and_a_confirmation_and_a_change_asks_again() {
    let t = start().await;
    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    let mut mia = member(&t, &mut a, 1, "human:oidc:mia").await;
    let personal = json!({ "kind": "personal" });
    let server = json!({ "kind": "server" });
    let command = |args: Value| {
        json!({ "method": "command", "program": "/usr/bin/tsh", "args": args,
                "env": [{ "name": "TOKEN", "secret": true, "value": "tok-do-not-leak" }] })
    };
    for (tab, id) in [(&mut mia, 1), (&mut a, 2)] {
        tab.call(
            id,
            "sshHosts.create",
            json!({ "name": "lab", "owner": personal,
                    "fields": { "host": "lab-gw.internal", "username": "ops", "auth": "agent" } }),
        )
        .await;
    }
    let mia_host = mia.result(1).await["id"].as_str().unwrap().to_owned();
    let host_id = a.result(2).await["id"].as_str().unwrap().to_owned();
    let to_mia = json!({ "kind": "sshHost", "id": mia_host });
    let to = json!({ "kind": "sshHost", "id": host_id });

    // Running a program on the server's machine needs profiles.hostAccess.
    mia.call(
        3,
        "links.create",
        json!({ "owner": personal, "from": server, "to": to_mia, "spec": command(json!(["proxy", "ssh"])) }),
    )
    .await;
    mia.error(3, Code::PermissionDenied).await;

    a.call(
        4,
        "links.create",
        json!({ "owner": personal, "from": server, "to": to, "spec": command(json!(["proxy", "ssh", "{host}:{port}"])) }),
    )
    .await;
    let link = a.result(4).await;
    no_secret(&link);
    assert_eq!(link["needsConfirmation"], true);
    assert!(link["confirmed"].is_null());
    assert_eq!(
        link["env"][0],
        json!({ "name": "TOKEN", "secret": true, "set": true })
    );

    a.call(5, "links.confirm", json!({ "id": link["id"] }))
        .await;
    let confirmed = a.result(5).await;
    assert_eq!(confirmed["confirmed"]["by"], admin_id(&t));

    // Another argument is another command: not confirmed, the secret kept.
    a.call(
        6,
        "links.update",
        json!({ "id": link["id"], "etag": confirmed["etag"],
                "spec": { "method": "command", "program": "/usr/bin/tsh", "args": ["-v", "proxy", "ssh"],
                          "env": [{ "name": "TOKEN", "secret": true }] } }),
    )
    .await;
    let changed = a.result(6).await;
    no_secret(&changed);
    assert!(changed["confirmed"].is_null());
    assert_eq!(changed["env"][0]["set"], true);
    assert_eq!(changed["id"], link["id"]);

    // A secret variable that holds no value yet is asked for, and a plain link confirms nothing.
    a.call(
        7,
        "links.update",
        json!({ "id": link["id"], "etag": changed["etag"],
                "spec": { "method": "command", "program": "/usr/bin/tsh", "args": ["x"],
                          "env": [{ "name": "OTHER", "secret": true }] } }),
    )
    .await;
    a.error(7, Code::InvalidArgument).await;
    a.call(
        8,
        "links.update",
        json!({ "id": link["id"], "etag": changed["etag"], "spec": { "method": "tcp", "args": [], "env": [] } }),
    )
    .await;
    let tcp = a.result(8).await;
    assert_eq!(tcp["method"], "tcp");
    assert_eq!(tcp["env"], json!([]));
    a.call(9, "links.confirm", json!({ "id": link["id"] }))
        .await;
    a.error(9, Code::InvalidArgument).await;

    // Not someone else's.
    mia.call(10, "links.get", json!({ "id": link["id"] })).await;
    mia.error(10, Code::NotFound).await;
}
