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
                tab.credit(id, 1).await;
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
    tab.cancel(9).await;
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
        tab.credit(10, 1).await;
    }
    assert!(actions.contains(&"start".to_owned()), "{actions:?}");
    tab.cancel(10).await;
    tab.error(10, Code::Cancelled).await;
}

/// The terminal's output until it shows `needle`.
async fn output_until(tab: &mut Tab, id: u32, needle: &str) -> String {
    let mut text = String::new();
    while !text.contains(needle) {
        let chunk = tab.chunk(id).await;
        text.push_str(&String::from_utf8_lossy(&chunk[1..]));
        tab.credit(id, 1).await;
    }
    text
}

fn b64(text: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(text)
}

#[tokio::test]
async fn lab_an_exec_shell_and_live_stats() {
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();

    // The default command: busybox has no bash, so sh.
    tab.call(
        4,
        "docker.containers.exec",
        json!({ "connId": conn_id, "id": "shop-worker-1", "cols": 100, "rows": 30, "terminalId": "lab-term" }),
    )
    .await;
    tab.call(
        5,
        "term.write",
        json!({ "terminalId": "lab-term", "data": b64("echo hi-$((1+2))\r") }),
    )
    .await;
    tab.result(5).await;
    output_until(&mut tab, 4, "hi-3").await;
    tab.call(
        6,
        "term.resize",
        json!({ "terminalId": "lab-term", "cols": 120, "rows": 40 }),
    )
    .await;
    tab.result(6).await;
    tab.call(
        7,
        "term.write",
        json!({ "terminalId": "lab-term", "data": b64("stty size\r") }),
    )
    .await;
    tab.result(7).await;
    output_until(&mut tab, 4, "40 120").await;
    tab.call(
        8,
        "term.write",
        json!({ "terminalId": "lab-term", "data": b64("exit 3\r") }),
    )
    .await;
    tab.result(8).await;
    let (_, summary) = drain_bytes(&mut tab, 4).await;
    assert_eq!(summary, json!({ "exitCode": 3 }));

    // Live stats of a running container; the stopped one has none.
    tab.call(
        9,
        "docker.containers.stats",
        json!({ "connId": conn_id, "id": "shop-web-1", "streamId": "lab-stats" }),
    )
    .await;
    let mut samples = Vec::new();
    while samples.len() < 2 {
        samples.extend(lines(&tab.chunk(9).await));
        tab.credit(9, 1).await;
    }
    assert!(
        samples[1]["memoryUsed"].as_u64().unwrap() > 0,
        "{samples:?}"
    );
    assert!(samples[1]["timeMs"].as_u64() > samples[0]["timeMs"].as_u64());
    assert!(samples[1].get("cpuPercent").is_some(), "{samples:?}");
    tab.cancel(9).await;
    tab.error(9, Code::Cancelled).await;
    tab.call(
        10,
        "docker.containers.stats",
        json!({ "connId": conn_id, "id": "stopped", "streamId": "lab-stats-2" }),
    )
    .await;
    tab.error(10, Code::FailedPrecondition).await;
}

/// A `bytes` stream's output until it ends, and its summary.
async fn drain_bytes(tab: &mut Tab, id: u32) -> (String, Value) {
    let mut text = String::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                text.push_str(&String::from_utf8_lossy(&frame.payload[1..]));
                tab.credit(id, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                return (text, serde_json::from_slice(&frame.payload).unwrap());
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test]
async fn lab_images_volumes_and_networks_with_docker_s_refusals() {
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();
    let find = |list: &Value, key: &str, value: &str| {
        list.as_array()
            .unwrap()
            .iter()
            .find(|r| r[key] == value)
            .unwrap_or_else(|| panic!("no {value} in {list}"))
            .clone()
    };
    let users = |row: &Value| {
        row["usedBy"]
            .as_array()
            .unwrap()
            .iter()
            .map(|u| u["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };

    // The lab's busybox is pulled by digest: no tag, not dangling, used by running containers.
    tab.call(4, "docker.images.list", json!({ "connId": conn_id }))
        .await;
    let images = tab.result(4).await;
    let busybox = images
        .as_array()
        .unwrap()
        .iter()
        .find(|i| {
            i["repoDigests"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d.as_str().unwrap().starts_with("busybox@"))
        })
        .unwrap_or_else(|| panic!("no busybox in {images}"))
        .clone();
    assert_eq!(busybox["dangling"], false);
    assert!(users(&busybox).contains(&"tty".to_owned()), "{busybox}");
    assert_eq!(busybox["usedBy"][0]["state"], "running");
    let image_id = busybox["id"].as_str().unwrap().to_owned();
    tab.call(
        5,
        "docker.images.inspect",
        json!({ "connId": conn_id, "id": image_id }),
    )
    .await;
    assert_eq!(tab.result(5).await["inspect"]["Id"], image_id);
    tab.confirmed(
        6,
        "docker.images.remove",
        json!({ "connId": conn_id, "ids": [image_id], "force": false }),
    )
    .await;
    let refused = tab.result(6).await;
    assert!(
        refused[0]["error"].as_str().unwrap().contains("conflict"),
        "{refused}"
    );

    tab.call(7, "docker.volumes.list", json!({ "connId": conn_id }))
        .await;
    let out = tab.result(7).await;
    assert!(out.get("sizeError").is_none(), "{out}");
    let volumes = &out["volumes"];
    let cache = find(volumes, "name", "lab-cache");
    assert_eq!(users(&cache), ["stopped"]);
    assert!(cache["size"].is_u64(), "{cache}");
    let shop_data = find(volumes, "name", "shop_shop-data");
    assert_eq!(shop_data["project"], "shop");
    assert_eq!(users(&shop_data), ["shop-web-1"]);
    tab.call(
        8,
        "docker.volumes.inspect",
        json!({ "connId": conn_id, "name": "lab-cache" }),
    )
    .await;
    assert_eq!(tab.result(8).await["inspect"]["Name"], "lab-cache");
    // A stopped container's volume is in use too.
    tab.confirmed(
        9,
        "docker.volumes.remove",
        json!({ "connId": conn_id, "names": ["lab-cache"] }),
    )
    .await;
    let refused = tab.result(9).await;
    assert!(
        refused[0]["error"].as_str().unwrap().contains("in use"),
        "{refused}"
    );

    tab.call(10, "docker.networks.list", json!({ "connId": conn_id }))
        .await;
    let networks = tab.result(10).await;
    let bridge = find(&networks, "name", "bridge");
    assert_eq!(bridge["builtIn"], true);
    let lab_net = find(&networks, "name", "lab-net");
    assert_eq!(lab_net["builtIn"], false);
    assert!(
        !lab_net["subnets"].as_array().unwrap().is_empty(),
        "{lab_net}"
    );
    let mut on_lab_net = users(&lab_net);
    on_lab_net.sort();
    assert_eq!(on_lab_net, ["stopped", "tty"]);
    assert_eq!(find(&networks, "name", "shop_shop-net")["project"], "shop");
    tab.call(
        11,
        "docker.networks.inspect",
        json!({ "connId": conn_id, "id": "lab-net" }),
    )
    .await;
    assert_eq!(tab.result(11).await["inspect"]["Name"], "lab-net");
    tab.confirmed(
        12,
        "docker.networks.remove",
        json!({ "connId": conn_id, "ids": ["bridge"] }),
    )
    .await;
    let refused = tab.result(12).await;
    assert!(
        refused[0]["error"]
            .as_str()
            .unwrap()
            .contains("pre-defined"),
        "{refused}"
    );
}

#[tokio::test]
async fn lab_disk_usage_counts_and_a_containers_processes() {
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();

    tab.call(4, "docker.host.df", json!({ "connId": conn_id }))
        .await;
    let df = tab.result(4).await;
    for kind in ["images", "containers", "volumes", "buildCache"] {
        let k = &df[kind];
        assert!(
            k["reclaimable"].as_u64().unwrap() <= k["size"].as_u64().unwrap(),
            "{kind}: {df}"
        );
        assert!(
            k["active"].as_u64().unwrap() <= k["count"].as_u64().unwrap(),
            "{kind}: {df}"
        );
    }
    // busybox is used by running containers; the seed's `lab-cache` has data.
    assert!(df["images"]["active"].as_u64().unwrap() >= 1, "{df}");
    assert!(df["containers"]["active"].as_u64().unwrap() >= 1, "{df}");
    assert!(df["volumes"]["count"].as_u64().unwrap() >= 2, "{df}");

    tab.call(5, "docker.host.counts", json!({ "connId": conn_id }))
        .await;
    let counts = tab.result(5).await;
    tab.call(6, "docker.volumes.list", json!({ "connId": conn_id }))
        .await;
    let volumes = tab.result(6).await;
    tab.call(7, "docker.networks.list", json!({ "connId": conn_id }))
        .await;
    let networks = tab.result(7).await;
    assert_eq!(
        counts["volumes"].as_u64().unwrap() as usize,
        volumes["volumes"].as_array().unwrap().len()
    );
    assert_eq!(
        counts["networks"].as_u64().unwrap() as usize,
        networks.as_array().unwrap().len()
    );
    assert!(counts["images"].as_u64().unwrap() >= 1, "{counts}");

    // `tty` runs a shell; the host's `ps` gives at least a PID and a command column.
    tab.call(
        8,
        "docker.containers.top",
        json!({ "connId": conn_id, "id": "tty" }),
    )
    .await;
    let top = tab.result(8).await;
    let titles: Vec<&str> = top["titles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().unwrap())
        .collect();
    assert!(titles.contains(&"PID"), "{top}");
    assert!(!top["processes"].as_array().unwrap().is_empty(), "{top}");
    tab.call(
        9,
        "docker.containers.top",
        json!({ "connId": conn_id, "id": "stopped" }),
    )
    .await;
    let err = tab.error(9, Code::FailedPrecondition).await;
    assert_eq!(err.details.unwrap()["kind"], "Conflict");
}

#[tokio::test]
async fn lab_a_projects_containers_log_apart() {
    // What a Compose project's merged logs read (batch 4b): each container's log on its own, with
    // Docker's timestamps, and its start and die events carrying the project's labels.
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();
    for (id, name, text) in [
        (4, "shop-web-1", "web listening on :8080"),
        (5, "shop-worker-1", "worker tick"),
    ] {
        tab.call(
            id,
            "docker.containers.logs",
            json!({ "connId": conn_id, "id": name, "follow": false, "tail": 20, "streamId": format!("p-{id}") }),
        )
        .await;
        let (log, _) = drain(&mut tab, id).await;
        assert!(
            log.iter()
                .any(|l| l["text"].as_str().unwrap().starts_with(text)),
            "{name}: {log:?}"
        );
        assert!(
            log.iter().all(|l| l["ts"].as_str().unwrap().ends_with('Z')),
            "{log:?}"
        );
    }

    tab.call(
        6,
        "docker.events",
        json!({ "connId": conn_id, "streamId": "p-e", "types": ["container"], "container": "shop-web-1" }),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    tab.call(
        7,
        "docker.containers.restart",
        json!({ "connId": conn_id, "ids": ["shop-web-1"], "timeoutSec": 1 }),
    )
    .await;
    assert_eq!(tab.result(7).await[0], json!({ "id": "shop-web-1" }));
    let mut seen = Vec::new();
    while !seen.iter().any(|a: &String| a == "start") {
        for event in lines(&tab.chunk(6).await) {
            assert_eq!(event["attributes"]["com.docker.compose.project"], "shop");
            assert_eq!(event["attributes"]["com.docker.compose.service"], "web");
            seen.push(event["action"].as_str().unwrap().to_owned());
        }
        tab.credit(6, 1).await;
    }
    assert!(seen.contains(&"die".to_owned()), "{seen:?}");
    tab.cancel(6).await;
    tab.error(6, Code::Cancelled).await;
}

#[tokio::test]
async fn lab_a_containers_files_read_through_its_archive() {
    let (_t, mut tab) = setup().await;
    let trusted = presented_key(&mut tab, 2).await;
    tab.call(
        3,
        "docker.connect",
        json!({ "profile": profile(json!({ "hostKey": trusted })) }),
    )
    .await;
    let conn_id = tab.result(3).await["connId"].as_str().unwrap().to_owned();
    let names = |list: &Value| {
        list["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>()
    };

    // The root: its entries have no prefix in Docker's tar.
    tab.call(
        4,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/" }),
    )
    .await;
    let root = tab.result(4).await;
    assert_eq!(root["kind"], "dir");
    for name in ["bin", "etc", "www"] {
        assert!(names(&root).contains(&name.to_owned()), "{root}");
    }
    // Folders first.
    assert_eq!(root["entries"][0]["kind"], "dir", "{root}");

    // A folder: its direct entries only.
    tab.call(
        5,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/www" }),
    )
    .await;
    let www = tab.result(5).await;
    assert_eq!(names(&www), ["index.html"], "{www}");
    assert_eq!(www["entries"][0]["size"], 5);

    // A file: its kind, no entries; its text.
    tab.call(
        6,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/www/index.html" }),
    )
    .await;
    assert_eq!(tab.result(6).await["kind"], "file");
    tab.call(
        7,
        "docker.containers.files.read",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/www/index.html" }),
    )
    .await;
    let read = tab.result(7).await;
    assert_eq!(read["text"], "shop\n", "{read}");
    assert_eq!(read["binary"], false);
    // BusyBox's binary is over 1 MiB, or not text.
    tab.call(
        8,
        "docker.containers.files.read",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/bin/busybox" }),
    )
    .await;
    let busybox = tab.result(8).await;
    assert!(
        busybox["tooLarge"] == true || busybox["binary"] == true,
        "{busybox}"
    );
    assert!(busybox.get("text").is_none());

    // A stopped container's files.
    tab.call(
        9,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "stopped", "path": "/etc" }),
    )
    .await;
    assert!(names(&tab.result(9).await).contains(&"passwd".to_owned()));

    // A missing path is Docker's 404.
    tab.call(
        10,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/no/such/dir" }),
    )
    .await;
    assert_eq!(
        tab.error(10, Code::NotFound).await.details.unwrap()["kind"],
        "NotFound"
    );

    // Download: the folder's tar as bytes.
    tab.call(
        11,
        "docker.containers.files.download",
        json!({ "connId": conn_id, "id": "shop-web-1", "path": "/www", "streamId": "dl-1" }),
    )
    .await;
    let mut tar = Vec::new();
    let summary = loop {
        let frame = tab.frame(11).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                tar.extend_from_slice(&frame.payload);
                tab.credit(11, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                break serde_json::from_slice::<Value>(&frame.payload).unwrap();
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert_eq!(summary["bytes"].as_u64().unwrap() as usize, tar.len());
    assert!(tar.len() >= 1536 && tar.len() % 512 == 0, "{}", tar.len());
    assert_eq!(&tar[..4], b"www/");
}

/// TSK-139 (DOC-25 §3.4.7): a stored profile logs in with the key, passphrase or password the
/// server keeps; Test connection fills an empty draft secret from the stored profile only while
/// the draft keeps its target.
#[tokio::test]
async fn a_stored_profile_logs_in_with_its_secrets_and_a_draft_keeps_its_target() {
    let (_t, mut tab) = setup().await;
    let lab = lab();
    let trusted = presented_key(&mut tab, 2).await;
    let fields = |extra: Value| {
        let mut f = json!({ "host": lab["host"], "port": lab["port"], "username": lab["user"], "hostKey": trusted });
        for (k, v) in extra.as_object().unwrap() {
            f[k] = v.clone();
        }
        f
    };
    // The login is an SSH host's (DOC-23 §4.3); the profile names it (TSK-144).
    let key_host = tab
        .store_ssh_host(
            "lab key",
            fields(json!({ "auth": "privateKey" })),
            json!({ "privateKey": read(lab["passphraseKeyFile"].as_str().unwrap()), "passphrase": lab["passphrase"] }),
        )
        .await;
    let key = tab
        .store_profile(
            "docker",
            "lab key",
            json!({ "sshHostId": key_host }),
            json!({}),
        )
        .await;
    tab.call(3, "docker.connect", json!({ "profileId": key }))
        .await;
    let conn = tab.result(3).await["connId"].as_str().unwrap().to_owned();
    tab.call(4, "docker.host.info", json!({ "connId": conn }))
        .await;
    tab.result(4).await;

    let password_fields = fields(json!({ "auth": "password", "username": lab["passwordUser"] }));
    let password_host = tab
        .store_ssh_host(
            "lab password",
            password_fields.clone(),
            json!({ "password": lab["password"] }),
        )
        .await;
    let password = tab
        .store_profile(
            "docker",
            "lab password",
            json!({ "sshHostId": password_host }),
            json!({}),
        )
        .await;
    tab.call(5, "docker.connect", json!({ "profileId": password }))
        .await;
    assert_eq!(tab.result(5).await["host"]["ssh"]["auth"], "password");
    // The profile form's draft: its host's stored password logs in.
    tab.call(
        6,
        "docker.test",
        json!({ "draft": { "fields": { "sshHostId": password_host }, "secrets": {} }, "basedOn": password }),
    )
    .await;
    tab.result(6).await;
    // The host form's draft, nothing typed: the stored password logs in.
    tab.call(
        8,
        "sshHosts.test",
        json!({ "fields": password_fields, "secrets": {}, "hostId": password_host }),
    )
    .await;
    tab.result(8).await;
    // Another user name is another target: the stored password is not sent.
    let mut other = password_fields.clone();
    other["username"] = json!(lab["user"]);
    tab.call(
        7,
        "sshHosts.test",
        json!({ "fields": other, "secrets": {}, "hostId": password_host }),
    )
    .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(err.details.unwrap()["field"], "password");
}

// Transports (DOC-23 §6.5, TSK-116): the same lab Engine over TCP with TLS (2376, client
// certificates), plain TCP (2375) and its socket, copied into lab/.generated/docker-socket.

/// The lab's TCP API settings.
fn tcp() -> Value {
    lab()["tcp"].clone()
}

/// A TCP profile for `address` (`host:port`); `tls` is the profile's `tls` object.
fn tcp_profile(address: &str, extra: Value) -> Value {
    let (host, port) = address.rsplit_once(':').unwrap();
    let mut profile = json!({
        "name": format!("lab tcp {port}"),
        "transport": "tcp",
        "host": host,
        "port": port.parse::<u16>().unwrap(),
    });
    for (k, v) in extra.as_object().unwrap() {
        profile[k] = v.clone();
    }
    profile
}

/// The containers' names the connection sees.
async fn container_names(tab: &mut Tab, id: u32, conn_id: &str) -> Vec<String> {
    tab.call(id, "docker.containers.list", json!({ "connId": conn_id }))
        .await;
    tab.result(id)
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap_or_default().to_owned())
        .collect()
}

#[tokio::test]
async fn lab_tcp_with_tls_and_client_certificates() {
    let (_t, mut tab) = setup().await;
    let tcp = tcp();
    let tls = json!({
        "enabled": true,
        "caPem": read(tcp["caFile"].as_str().unwrap()),
        "clientCertPem": read(tcp["clientCertFile"].as_str().unwrap()),
        "clientKeyPem": read(tcp["clientKeyFile"].as_str().unwrap()),
    });
    let address = tcp["tls"].as_str().unwrap();
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": tcp_profile(address, json!({ "tls": tls })) }),
    )
    .await;
    let out = tab.result(2).await;
    assert_eq!(out["host"]["transport"], "tcp");
    assert_eq!(out["host"]["tls"], true);
    assert_eq!(out["host"]["unencrypted"], false);
    assert_eq!(out["host"]["endpoint"], address);
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    let names = container_names(&mut tab, 3, &conn_id).await;
    assert!(names.iter().any(|n| n == "shop-web-1"), "{names:?}");

    // A client certificate from another CA: dockerd refuses it.
    let mut stranger = tls.clone();
    stranger["clientCertPem"] = json!(read(tcp["strangerCertFile"].as_str().unwrap()));
    stranger["clientKeyPem"] = json!(read(tcp["strangerKeyFile"].as_str().unwrap()));
    tab.call(
        4,
        "docker.connect",
        json!({ "profile": tcp_profile(address, json!({ "name": "stranger", "tls": stranger })) }),
    )
    .await;
    let err = tab.error(4, Code::Unauthenticated).await;
    assert!(
        err.message.contains("client certificate"),
        "{}",
        err.message
    );

    // Another CA pinned: the Engine's certificate is not trusted.
    let mut other = tls.clone();
    other["caPem"] = json!(read("routes/ca.pem"));
    tab.call(
        5,
        "docker.connect",
        json!({ "profile": tcp_profile(address, json!({ "name": "other ca", "tls": other })) }),
    )
    .await;
    let err = tab.error(5, Code::Unavailable).await;
    assert!(
        err.message.contains("not signed by the CA"),
        "{}",
        err.message
    );
}

#[tokio::test]
async fn lab_plain_tcp_only_with_the_acceptance() {
    let (_t, mut tab) = setup().await;
    let address = tcp()["plain"].as_str().unwrap().to_owned();
    let profile = tcp_profile(&address, json!({ "unencrypted": { "accepted": true } }));
    tab.call(2, "docker.connect", json!({ "profile": profile }))
        .await;
    let out = tab.result(2).await;
    assert_eq!(out["host"]["unencrypted"], true);
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    let names = container_names(&mut tab, 3, &conn_id).await;
    assert!(names.iter().any(|n| n == "tty"), "{names:?}");
    // The TLS port does not speak plain HTTP, and the error says to turn TLS on.
    let tls_port = tcp()["tls"].as_str().unwrap().to_owned();
    let profile = tcp_profile(
        &tls_port,
        json!({ "name": "plain on tls", "unencrypted": { "accepted": true } }),
    );
    tab.call(4, "docker.connect", json!({ "profile": profile }))
        .await;
    let err = tab.error(4, Code::InvalidArgument).await;
    assert!(err.message.contains("turn TLS on"), "{}", err.message);
}

#[cfg(unix)]
#[tokio::test]
async fn lab_the_local_socket() {
    let t = start().await;
    let admin = t
        .server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id();
    let browser = t.browser_as(&admin, &[]).await;
    let mut tab = t.tab(&browser).await;
    let path = generated().join(lab()["socketFile"].as_str().unwrap());
    let profile = json!({ "name": "lab socket", "transport": "socket", "socketPath": path });
    tab.call(2, "docker.connect", json!({ "profile": profile }))
        .await;
    let out = tab.result(2).await;
    assert_eq!(out["host"]["transport"], "socket");
    assert_eq!(out["host"]["endpoint"], path.display().to_string());
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    let names = container_names(&mut tab, 3, &conn_id).await;
    assert!(names.iter().any(|n| n == "stopped"), "{names:?}");
}
