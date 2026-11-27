//! The tools through routes against the lab (DOC-23 §7, §12; TSK-117): the Docker host on
//! `routes-internal` (reached only through a route) over TCP through squid, over TCP with TLS
//! through Dante, and over SSH through a jump host; Temporal and LangGraph through squid; and
//! `routes.test` through two jump hosts. Needs `lab up routes docker temporal langgraph`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test routes_lab`. The lab's files
//! come from `lab/.generated` (or `MIGHTYCONSOLE_LAB_GENERATED`).
#![cfg(feature = "lab-tests")]

use std::path::PathBuf;

use crate::support::*;
use ambidex::Code;
use serde_json::{Value, json};

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

fn credentials() -> Value {
    let path = generated().join("credentials.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run `lab up routes docker`)", path.display()));
    serde_json::from_str(&text).unwrap()
}

fn read(relative: &str) -> String {
    std::fs::read_to_string(generated().join(relative)).unwrap()
}

fn s(v: &Value) -> String {
    v.as_str()
        .unwrap_or_else(|| panic!("not a string: {v}"))
        .to_owned()
}

fn split(address: &str) -> (String, u16) {
    let (host, port) = address.rsplit_once(':').unwrap();
    (host.to_owned(), port.parse().unwrap())
}

async fn setup() -> (TestServer, Tab) {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    (t, tab)
}

/// A personal proxy of `kind` at `address` with the lab's login, and a route through it alone.
async fn proxy_route(
    tab: &mut Tab,
    id: u32,
    name: &str,
    kind: &str,
    login: &Value,
    address: &str,
) -> String {
    let (host, port) = split(address);
    tab.call(
        id,
        "proxies.create",
        json!({ "name": name, "owner": { "kind": "personal" },
                "fields": { "kind": kind, "host": host, "port": port, "tls": false, "username": login["user"] },
                "password": login["password"] }),
    )
    .await;
    let proxy = tab.result(id).await["id"].clone();
    tab.call(
        id + 1,
        "routes.create",
        json!({ "name": name, "owner": { "kind": "personal" }, "hops": [{ "kind": "proxy", "proxyId": proxy }] }),
    )
    .await;
    tab.result(id + 1).await["id"].as_str().unwrap().to_owned()
}

/// A personal SSH host with the lab key at `address`; its id. Its host key is trusted on first
/// use, as a person would: from the `HostKey` error of [`trust`].
async fn ssh_host(
    tab: &mut Tab,
    id: u32,
    name: &str,
    address: &str,
    user: &str,
    key_file: &str,
) -> Value {
    let (host, port) = split(address);
    tab.call(
        id,
        "sshHosts.create",
        json!({ "name": name, "owner": { "kind": "personal" },
                "fields": { "host": host, "port": port, "username": user, "auth": "privateKey" },
                "secrets": { "privateKey": read(key_file) } }),
    )
    .await;
    tab.result(id).await
}

/// Saves `host_key` (the details of a `HostKey` error) into the SSH host it names.
async fn trust(tab: &mut Tab, id: u32, host_key: &Value) {
    let host_id = s(&host_key["sshHostId"]);
    tab.call(id, "sshHosts.get", json!({ "id": host_id })).await;
    let host = tab.result(id).await;
    let mut fields = host["fields"].clone();
    fields["hostKey"] = json!({ "algorithm": host_key["algorithm"], "fingerprintSha256": host_key["fingerprintSha256"] });
    tab.call(
        id + 1,
        "sshHosts.update",
        json!({ "id": host_id, "etag": host["etag"], "fields": fields }),
    )
    .await;
    tab.result(id + 1).await;
}

#[tokio::test]
async fn docker_on_the_internal_network_over_tcp_through_squid_and_with_tls_through_dante() {
    let lab = credentials();
    let routes = &lab["routes"];
    let tcp = &lab["docker"]["tcp"];
    let (_t, mut tab) = setup().await;

    // Plain TCP through squid: the Engine's 2375 on routes-internal, which only a route reaches.
    let squid = proxy_route(
        &mut tab,
        2,
        "squid",
        "httpConnect",
        &routes["httpProxy"],
        &s(&routes["httpProxy"]["http"]),
    )
    .await;
    let (internal, _) = split(&s(&tcp["internal"]));
    let plain = json!({ "name": "internal plain", "transport": "tcp", "host": internal, "port": 2375,
                        "unencrypted": { "accepted": true }, "routeId": squid });
    tab.call(4, "docker.connect", json!({ "profile": plain }))
        .await;
    let out = tab.result(4).await;
    assert_eq!(out["host"]["route"], "squid");
    assert_eq!(out["host"]["unencrypted"], true);

    // TLS through Dante: the TLS runs end to end and is checked for the Engine's own name.
    let dante = proxy_route(
        &mut tab,
        5,
        "dante",
        "socks5",
        &routes["socks5"],
        &s(&routes["socks5"]["address"]),
    )
    .await;
    let (host, port) = split(&s(&tcp["internal"]));
    let tls = json!({
        "name": "internal tls", "transport": "tcp", "host": host, "port": port, "routeId": dante,
        "tls": {
            "enabled": true,
            "caPem": read(&s(&tcp["caFile"])),
            "clientCertPem": read(&s(&tcp["clientCertFile"])),
            "clientKeyPem": read(&s(&tcp["clientKeyFile"])),
        },
    });
    tab.call(7, "docker.connect", json!({ "profile": tls }))
        .await;
    let out = tab.result(7).await;
    assert_eq!(out["host"]["route"], "dante");
    assert_eq!(out["host"]["tls"], true);
    let conn_id = s(&out["connId"]);
    tab.call(8, "docker.containers.list", json!({ "connId": conn_id }))
        .await;
    assert!(
        tab.result(8)
            .await
            .as_array()
            .is_some_and(|c| !c.is_empty())
    );
}

#[tokio::test]
async fn docker_over_ssh_through_a_jump_host_trusts_each_key_in_its_own_ssh_host() {
    let lab = credentials();
    let jumps = &lab["routes"]["jumps"];
    let docker = &lab["docker"];
    let (_t, mut tab) = setup().await;
    let jump1 = ssh_host(
        &mut tab,
        2,
        "jump1",
        &s(&jumps["jump1"]),
        &s(&jumps["user"]),
        &s(&jumps["keyFile"]),
    )
    .await;
    tab.call(
        3,
        "routes.create",
        json!({ "name": "jump", "owner": { "kind": "personal" }, "hops": [{ "kind": "ssh", "sshHostId": jump1["id"] }] }),
    )
    .await;
    let route = s(&tab.result(3).await["id"]);

    // The Docker host as the jump host reaches it: its sshd on routes-internal.
    let (internal, _) = split(&s(&docker["tcp"]["internal"]));
    let profile = json!({ "name": "internal ssh", "host": internal, "port": 22, "username": docker["user"],
                          "auth": "privateKey", "privateKey": read(&s(&docker["keyFile"])), "routeId": route });
    // First the jump host's key, then the Docker host's own: each names where Trust saves it.
    tab.call(4, "docker.connect", json!({ "profile": profile }))
        .await;
    let err = tab.error(4, Code::FailedPrecondition).await;
    let details = err.details.unwrap();
    assert_eq!(details["hop"]["index"], 0, "{details}");
    assert_eq!(details["hostKey"]["sshHostId"], jump1["id"]);
    trust(&mut tab, 5, &details["hostKey"]).await;

    tab.call(7, "docker.connect", json!({ "profile": profile }))
        .await;
    let err = tab.error(7, Code::FailedPrecondition).await;
    let details = err.details.unwrap();
    assert_eq!(
        details["hop"]["index"], 1,
        "the Docker host after the hop: {details}"
    );
    assert_eq!(details["hostKey"]["state"], "unknown");
    // The Docker host's key goes into the SSH host the profile names.
    tab.call(8, "profiles.list", json!({ "tool": "docker" }))
        .await;
    let listed = tab.result(8).await;
    let host_id = listed["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["fields"]["routeId"] == json!(route))
        .map(|p| p["fields"]["sshHostId"].clone())
        .unwrap();
    let mut key = details["hostKey"].clone();
    key["sshHostId"] = host_id;
    trust(&mut tab, 9, &key).await;

    tab.call(11, "profiles.list", json!({ "tool": "docker" }))
        .await;
    let listed = tab.result(11).await;
    let id = listed["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["fields"]["routeId"] == json!(route))
        .map(|p| p["id"].clone())
        .unwrap();
    tab.call(12, "docker.connect", json!({ "profileId": id }))
        .await;
    let out = tab.result(12).await;
    assert_eq!(out["host"]["route"], "jump");
    assert_eq!(out["host"]["transport"], "ssh");
}

#[tokio::test]
async fn a_test_through_two_jump_hosts_reaches_an_internal_target() {
    let lab = credentials();
    let routes = &lab["routes"];
    let jumps = &routes["jumps"];
    let (_t, mut tab) = setup().await;
    let jump1 = ssh_host(
        &mut tab,
        2,
        "jump1",
        &s(&jumps["jump1"]),
        &s(&jumps["user"]),
        &s(&jumps["keyFile"]),
    )
    .await;
    let jump2 = ssh_host(
        &mut tab,
        3,
        "jump2",
        &s(&jumps["internal"]["jump2"]),
        &s(&jumps["user"]),
        &s(&jumps["keyFile"]),
    )
    .await;
    let hops = json!([{ "kind": "ssh", "sshHostId": jump1["id"] }, { "kind": "ssh", "sshHostId": jump2["id"] }]);
    let (host, port) = split(&s(&routes["targets"]["echo"]));
    let target = json!({ "host": host, "port": port });
    // Trust each key as the test meets it, then the whole path passes.
    for (id, index) in [(4u32, 0), (8, 1)] {
        tab.call(id, "routes.test", json!({ "hops": hops, "target": target }))
            .await;
        let out = tab.result(id).await;
        let last = out["lines"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["failure"], "HostKey", "{out}");
        assert_eq!(last["hop"]["index"], index, "{out}");
        trust(&mut tab, id + 1, &last["error"]["hostKey"]).await;
    }
    tab.call(12, "routes.test", json!({ "hops": hops, "target": target }))
        .await;
    let out = tab.result(12).await;
    let lines = out["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 3, "{out}");
    assert!(lines.iter().all(|l| l["ok"] == true), "{out}");
    assert_eq!(lines[2]["hop"]["kind"], "target");
    assert!(lines[0]["hostKey"]["fingerprintSha256"].is_string());
}

#[tokio::test]
async fn temporal_and_langgraph_through_squid() {
    let lab = credentials();
    let routes = &lab["routes"];
    let (_t, mut tab) = setup().await;
    let squid = proxy_route(
        &mut tab,
        2,
        "squid",
        "httpConnect",
        &routes["httpProxy"],
        &s(&routes["httpProxy"]["http"]),
    )
    .await;
    // As squid reaches them on the lab network: their service names, not 127.0.0.1.
    tab.call(
        4,
        "temporal.connect",
        json!({ "profile": { "name": "via squid", "address": "temporal:7233", "namespace": "lab", "routeId": squid } }),
    )
    .await;
    let out = tab.result(4).await;
    assert!(out["serverVersion"].is_string(), "{out}");
    tab.call(
        5,
        "langgraph.connect",
        json!({ "profile": { "name": "via squid", "url": "http://langgraph:2024", "routeId": squid } }),
    )
    .await;
    let out = tab.result(5).await;
    assert!(out["connId"].is_string(), "{out}");
}
