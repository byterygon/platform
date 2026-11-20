//! The `docker` tool against the test lab's Docker host (OpenSSH in front of Docker in Docker,
//! Mightyconsole spec §14 and §18, TSK-81). Needs
//! `pnpm --filter @byterygon/mightyconsole lab up docker`; run with
//! `cargo test -p mightyconsole-server --features lab-tests --test docker_lab`. The lab's
//! credentials come from `lab/.generated/credentials.json` (or `MIGHTYCONSOLE_LAB_GENERATED`).
//!
//! The ssh-agent case needs an agent holding the lab key in this process's `SSH_AUTH_SOCK` and
//! `MIGHTYCONSOLE_LAB_DOCKER_AGENT=1` (the acceptance checklist starts one); without them it
//! says so and passes.
#![cfg(feature = "lab-tests")]

mod support;

use std::path::PathBuf;

use ambidex::Code;
use serde_json::{Value, json};
use support::*;

fn generated() -> PathBuf {
    std::env::var_os("MIGHTYCONSOLE_LAB_GENERATED")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../lab/.generated"))
}

/// The lab's `docker` credentials.
fn lab() -> Value {
    let path = generated().join("credentials.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{}: {e} (run `lab up docker`)", path.display()));
    serde_json::from_str::<Value>(&text).unwrap()["docker"].clone()
}

fn read(relative: &str) -> String {
    std::fs::read_to_string(generated().join(relative)).unwrap()
}

/// A profile for the lab host with the private key; `extra` overrides fields.
fn profile(extra: Value) -> Value {
    let lab = lab();
    let mut profile = json!({
        "name": "lab",
        "host": lab["host"],
        "port": lab["port"],
        "username": lab["user"],
        "auth": "privateKey",
        "privateKey": read(lab["keyFile"].as_str().unwrap()),
    });
    for (k, v) in extra.as_object().unwrap() {
        profile[k] = v.clone();
    }
    profile
}

async fn setup() -> (TestServer, Tab) {
    let t = start().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    (t, tab)
}

/// Connects once without a trusted key and returns the key the lab host presents.
async fn presented_key(tab: &mut Tab, id: u32) -> Value {
    tab.call(
        id,
        "docker.connect",
        json!({ "profile": profile(json!({})) }),
    )
    .await;
    let err = tab.error(id, Code::FailedPrecondition).await;
    let host_key = err.details.as_ref().unwrap()["hostKey"].clone();
    assert_eq!(host_key["state"], "unknown");
    json!({
        "algorithm": host_key["algorithm"],
        "fingerprintSha256": host_key["fingerprintSha256"],
    })
}

#[tokio::test]
async fn lab_trust_on_first_use_then_every_login_method() {
    let (_t, mut tab) = setup().await;
    let lab = lab();
    let trusted = presented_key(&mut tab, 2).await;
    assert!(
        trusted["fingerprintSha256"]
            .as_str()
            .unwrap()
            .starts_with("SHA256:")
    );

    // A changed key is refused, with both keys.
    let wrong = json!({ "algorithm": trusted["algorithm"],
                        "fingerprintSha256": "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": wrong })) }),
    )
    .await;
    let err = tab.error(3, Code::FailedPrecondition).await;
    let details = err.details.unwrap();
    assert_eq!(details["hostKey"]["state"], "changed");
    assert_eq!(details["hostKey"]["expected"], wrong);
    assert_eq!(
        details["hostKey"]["fingerprintSha256"],
        trusted["fingerprintSha256"]
    );

    // The private key.
    tab.call(
        4,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let out = tab.result(4).await;
    let host = &out["host"];
    assert!(
        host["serverVersion"].as_str().unwrap().starts_with("28."),
        "{host}"
    );
    assert!(host["containers"].as_u64().unwrap() >= 4, "{host}");
    assert_eq!(host["osType"], "linux");
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    tab.call(5, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    assert_eq!(tab.result(5).await["name"], host["name"]);

    // The key with a passphrase: none, a wrong one, the right one.
    let encrypted = read(lab["passphraseKeyFile"].as_str().unwrap());
    tab.call(
        6,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "privateKey": encrypted })) }),
    )
    .await;
    let err = tab.error(6, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "passphrase");
    tab.call(
        7,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "privateKey": encrypted, "passphrase": "not it" })) }),
    )
    .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "passphrase");
    tab.call(
        8,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "privateKey": encrypted, "passphrase": lab["passphrase"] })) }),
    )
    .await;
    tab.result(8).await;

    // The password user.
    tab.call(
        9,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "auth": "password",
            "username": lab["passwordUser"], "password": lab["password"] })) }),
    )
    .await;
    assert_eq!(tab.result(9).await["host"]["ssh"]["auth"], "password");
    tab.call(
        10,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "auth": "password",
            "username": lab["passwordUser"], "password": "wrong" })) }),
    )
    .await;
    assert_eq!(
        tab.error(10, Code::Unauthenticated).await.details.unwrap()["kind"],
        "Auth"
    );

    // The ssh-agent of the user running the server.
    if std::env::var("MIGHTYCONSOLE_LAB_DOCKER_AGENT").as_deref() == Ok("1") {
        tab.call(
            11,
            "docker.connect",
            json!({ "profile": profile(json!({ "hostKey": trusted, "auth": "agent" })) }),
        )
        .await;
        assert_eq!(tab.result(11).await["host"]["ssh"]["auth"], "agent");
    } else {
        eprintln!(
            "docker_lab: the ssh-agent case was not run (set MIGHTYCONSOLE_LAB_DOCKER_AGENT=1 with an agent holding the lab key)"
        );
    }
}

#[tokio::test]
async fn lab_a_user_without_socket_forwarding_gets_the_explained_error() {
    let (_t, mut tab) = setup().await;
    let lab = lab();
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "username": lab["noForwardUser"] })) }),
    )
    .await;
    let err = tab.error(3, Code::PermissionDenied).await;
    assert!(
        err.message.contains("AllowStreamLocalForwarding"),
        "{}",
        err.message
    );
    assert!(
        err.message.contains("nofwd@127.0.0.1:2222 logged in"),
        "{}",
        err.message
    );

    // A socket that is not there.
    tab.call(
        4,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted, "socketPath": "/run/user/1000/docker.sock" })) }),
    )
    .await;
    let err = tab.error(4, Code::Unavailable).await;
    assert!(
        err.message.contains("/run/user/1000/docker.sock"),
        "{}",
        err.message
    );
}

/// The `jsonl` lines of a chunk.
fn lines(chunk: &[u8]) -> Vec<Value> {
    chunk
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect()
}

/// A stream's lines until it ends, and its summary.
async fn drain(tab: &mut Tab, id: u32) -> (Vec<Value>, Value) {
    let mut all = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                all.extend(lines(&frame.payload));
                tab.client.credit(id, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                return (all, serde_json::from_slice(&frame.payload).unwrap());
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test]
async fn lab_containers_their_logs_and_the_events() {
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();

    // The seed: the project shop, a stopped container (exit 3), a TTY container.
    tab.call(4, "docker.containers.list", json!({ "connId": conn_id }))
        .await;
    let rows = tab.result(4).await;
    let row = |name: &str| {
        rows.as_array()
            .unwrap()
            .iter()
            .find(|r| r["name"] == name)
            .unwrap_or_else(|| panic!("no {name} in {rows}"))
            .clone()
    };
    assert_eq!(row("shop-web-1")["project"], "shop");
    assert_eq!(row("shop-web-1")["service"], "web");
    assert_eq!(row("shop-worker-1")["state"], "running");
    assert_eq!(row("stopped")["state"], "exited");
    assert_eq!(row("stopped")["exitCode"], 3);
    tab.call(5, "docker.compose.projects", json!({ "connId": conn_id }))
        .await;
    let projects = tab.result(5).await;
    let shop = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["project"] == "shop")
        .unwrap();
    assert_eq!(shop["services"].as_array().unwrap().len(), 2, "{shop}");

    tab.call(
        6,
        "docker.containers.inspect",
        json!({ "connId": conn_id, "id": "tty" }),
    )
    .await;
    let inspect = tab.result(6).await;
    assert_eq!(inspect["overview"]["tty"], true);
    assert_eq!(inspect["overview"]["networks"][0]["name"], "lab-net");

    // The worker writes to stdout and stderr: both come, apart, with Docker's timestamps.
    tab.call(
        7,
        "docker.containers.logs",
        json!({ "connId": conn_id, "id": "shop-worker-1", "follow": false, "tail": 6, "streamId": "w-1" }),
    )
    .await;
    let (log, summary) = drain(&mut tab, 7).await;
    assert_eq!(summary["tty"], false);
    assert!(
        log.iter()
            .any(|l| l["stream"] == "stdout"
                && l["text"].as_str().unwrap().starts_with("worker tick"))
    );
    assert!(
        log.iter()
            .any(|l| l["stream"] == "stderr" && l["text"].as_str().unwrap().starts_with("warning"))
    );
    assert!(
        log.iter()
            .all(|l| l["ts"].as_str().unwrap().starts_with("20")),
        "{log:?}"
    );

    // A TTY container: one stream, the ANSI kept.
    tab.call(
        8,
        "docker.containers.logs",
        json!({ "connId": conn_id, "id": "tty", "follow": false, "tail": 2, "streamId": "t-1" }),
    )
    .await;
    let (log, summary) = drain(&mut tab, 8).await;
    assert_eq!(summary["tty"], true);
    assert!(!log.is_empty());
    assert!(
        log.iter()
            .all(|l| l["stream"] == "stdout" && l["text"] == "\u{1b}[32mgreen\u{1b}[0m tty line")
    );

    // Following: new lines arrive (the worker writes every 2 s) until the stream is stopped.
    tab.call(
        9,
        "docker.containers.logs",
        json!({ "connId": conn_id, "id": "shop-worker-1", "follow": true, "tail": 0, "streamId": "w-2" }),
    )
    .await;
    let first = lines(&tab.chunk(9).await);
    assert!(!first.is_empty());
    tab.client.cancel(9).await;
    tab.error(9, Code::Cancelled).await;

    // Events: starting the stopped container gives start and die (it exits at once).
    tab.call(
        10,
        "docker.events",
        json!({ "connId": conn_id, "streamId": "e-1", "types": ["container"], "container": "stopped" }),
    )
    .await;
    // Let the events request reach the host before the start.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    tab.call(
        11,
        "docker.containers.start",
        json!({ "connId": conn_id, "ids": ["stopped", "no-such-container"] }),
    )
    .await;
    let results = tab.result(11).await;
    assert_eq!(results[0], json!({ "id": "stopped" }));
    assert!(
        results[1]["error"]
            .as_str()
            .unwrap()
            .contains("no-such-container")
    );
    let mut actions = Vec::new();
    while !actions.iter().any(|a| a == "die") {
        for event in lines(&tab.chunk(10).await) {
            assert_eq!(event["name"], "stopped");
            actions.push(event["action"].as_str().unwrap().to_owned());
        }
        tab.client.credit(10, 1).await;
    }
    assert!(actions.contains(&"start".to_owned()), "{actions:?}");
    tab.client.cancel(10).await;
    tab.error(10, Code::Cancelled).await;
}
