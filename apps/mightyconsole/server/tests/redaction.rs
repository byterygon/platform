//! Redaction is a test, not a promise (TSK-141; DOC-25 §6 "Secrets"): known secrets, passwords,
//! session cookies and anti-CSRF tokens are fed through every path that carries one, on the
//! success and on the error paths, and the test fails when any of them appears in an answer, a
//! log line, the audit log, the store's plaintext, a panic message or a `Debug` format.
//!
//! The secrets are malformed on purpose (an NKEY seed, a creds file, PEM keys, an SSH key that do
//! not parse) and the targets do not listen, so each tool's parse and connect errors run with the
//! secret in hand. The UI's diagnostics view shows the server's error messages and nothing else
//! (`ui/src/app/messages.test.ts`), so the answers checked here cover it.
//!
//! One test in this file: the panic hook it installs is the process's.

mod support;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use mightyconsole_server::StartOptions;
use mightyconsole_server::audit::LineWriter;
use serde_json::{Value, json};
use support::*;

/// Every line the server logs.
#[derive(Default)]
struct Lines(Mutex<Vec<String>>);

impl LineWriter for Lines {
    fn line(&self, line: &str) {
        self.0.lock().unwrap().push(line.to_owned());
    }
}

/// The seeded values, each unique and findable.
struct Seeds {
    next: usize,
    all: Vec<String>,
}

impl Seeds {
    fn new() -> Seeds {
        Seeds {
            next: 0,
            all: Vec::new(),
        }
    }

    /// A seeded value shaped like `field`'s secret (and malformed, so parsers fail on it).
    fn for_field(&mut self, field: &str) -> String {
        self.next += 1;
        let mark = format!("SEEDx{:02}q7wJ", self.next);
        self.all.push(mark.clone());
        if field.ends_with("Pem") || field == "privateKey" {
            format!("-----BEGIN PRIVATE KEY-----\n{mark}\n-----END PRIVATE KEY-----\n")
        } else if field == "nkeySeed" {
            format!("SUA{mark}")
        } else if field == "creds" {
            format!(
                "-----BEGIN NATS USER JWT-----\n{mark}\n------END NATS USER JWT------\n\n\
                 -----BEGIN USER NKEY SEED-----\nSUA{mark}\n------END USER NKEY SEED------\n"
            )
        } else if field == "headerValues" {
            format!("X-Seed: {mark}")
        } else {
            mark
        }
    }

    fn plain(&mut self, what: &str) -> String {
        let value = self.for_field(what);
        assert!(!value.contains('\n'));
        value
    }

    fn record(&mut self, value: &str) {
        self.all.push(value.to_owned());
    }
}

/// The settings under which each tool's secrets are used, pointing at a port nothing listens on.
fn drafts(tool: &str) -> Vec<Value> {
    let closed = "127.0.0.1:1";
    match tool {
        "echo" => vec![json!({})],
        "nats" => vec![
            json!({ "servers": [format!("nats://{closed}")], "auth": "userPassword", "user": "u",
                    "tls": { "enabled": true },
                    "schemaRegistry": { "url": format!("https://{closed}"), "auth": "basic", "username": "u" } }),
            json!({ "servers": [format!("nats://{closed}")], "auth": "token",
                    "schemaRegistry": { "url": format!("https://{closed}"), "auth": "bearer" } }),
            json!({ "servers": [format!("nats://{closed}")], "auth": "nkey" }),
            // Without TLS or a registry, so the connect itself runs with the secret.
            json!({ "servers": [format!("nats://{closed}")], "auth": "token" }),
            json!({ "servers": [format!("nats://{closed}")], "auth": "userPassword", "user": "u" }),
            json!({ "servers": [format!("nats://{closed}")], "auth": "creds" }),
        ],
        "temporal" => vec![
            json!({
                "address": closed, "namespace": "default",
                "tls": { "enabled": true },
                "codec": { "enabled": true, "endpoint": format!("https://{closed}") },
                "externalStorage": { "enabled": true, "endpoint": format!("https://{closed}"), "bucket": "b" },
            }),
            json!({ "address": closed, "namespace": "default",
                    "codec": { "enabled": true, "endpoint": format!("http://{closed}") } }),
        ],
        "docker" => vec![
            json!({ "transport": "ssh", "host": "127.0.0.1", "port": 1, "username": "u", "auth": "privateKey" }),
            json!({ "transport": "ssh", "host": "127.0.0.1", "port": 1, "username": "u", "auth": "password" }),
        ],
        "langgraph" => vec![json!({ "url": format!("http://{closed}"), "headers": ["X-Seed"] })],
        _ => unreachable!(),
    }
}

/// Every answer frame's payload, as text.
async fn answer(tab: &mut Tab, id: u32) -> String {
    let frame = tab.frame(id).await;
    String::from_utf8_lossy(&frame.payload).into_owned()
}

#[tokio::test]
async fn no_seeded_secret_leaves_the_server_anywhere() {
    // Panic messages, from any thread of this process.
    let panics = Arc::new(Mutex::new(Vec::<String>::new()));
    {
        let panics = Arc::clone(&panics);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            panics.lock().unwrap().push(info.to_string());
            previous(info);
        }));
    }
    let lines = Arc::new(Lines::default());
    let t = start_with_durable_audit(StartOptions {
        log: Some(Arc::clone(&lines) as Arc<dyn LineWriter>),
        ..StartOptions::default()
    })
    .await;
    let mut seeds = Seeds::new();
    let mut answers: Vec<String> = Vec::new();

    // The default administrator's generated password: the log names its file only.
    seeds.record(&t.admin_password());

    // Sign-up, a wrong and a right password, through the signed-out page's routes.
    let password = format!("{} long enough", seeds.plain("password"));
    let (up, cookie) = t
        .post_auth(
            "/auth/signup",
            &json!({ "username": "carol", "password": password }),
        )
        .await;
    assert_eq!(up.status, 200, "{}", up.body);
    answers.push(up.body.clone());
    let wrong = format!("{} wrong guess", seeds.plain("password"));
    let (bad, _) = t
        .post_auth(
            "/auth/password",
            &json!({ "username": "carol", "password": wrong }),
        )
        .await;
    answers.push(bad.body.clone());
    let (good, again) = t
        .post_auth(
            "/auth/password",
            &json!({ "username": "carol", "password": password }),
        )
        .await;
    assert_eq!(good.status, 200, "{}", good.body);
    answers.push(good.body.clone());
    let cookie = cookie.expect("a session cookie");
    seeds.record(&cookie);
    seeds.record(&again.expect("a session cookie"));

    // The account's own procedures: a wrong current password, then a change.
    let page = t.http("/", HOST, Some(&cookie)).await;
    seeds.record(&page.csrf());
    let carol = Browser {
        cookie: cookie.clone(),
        csrf: page.csrf(),
    };
    let mut tab = t.tab(&carol).await;
    let new_password = format!("{} new and long", seeds.plain("password"));
    tab.call(
        1,
        "app.account.changePassword",
        json!({ "current": wrong, "new": new_password }),
    )
    .await;
    answers.push(answer(&mut tab, 1).await);
    tab.call(
        2,
        "app.account.changePassword",
        json!({ "current": password, "new": new_password }),
    )
    .await;
    answers.push(answer(&mut tab, 2).await);
    tab.call(3, "app.account.totp.remove", json!({ "current": wrong }))
        .await;
    answers.push(answer(&mut tab, 3).await);
    tab.disconnect().await;

    // Every tool: Test connection with typed secrets, a stored profile with them, its connect,
    // a replaced secret and an update. One person per tool keeps each within its budget.
    let mut id = 10;
    for spec in &mightyconsole_server::profiles::spec::SPECS {
        let browser = t
            .browser_as(&format!("human:account:redaction-{}", spec.tool), &[])
            .await;
        seeds.record(&browser.cookie);
        seeds.record(&browser.csrf);
        let mut tab = t.tab(&browser).await;
        for (n, fields) in drafts(spec.tool).into_iter().enumerate() {
            let secrets: BTreeMap<String, String> = spec
                .secrets
                .iter()
                .map(|f| ((*f).to_owned(), seeds.for_field(f)))
                .collect();
            id += 1;
            tab.call(
                id,
                &format!("{}.test", spec.tool),
                json!({ "draft": { "name": "r", "fields": fields, "secrets": secrets } }),
            )
            .await;
            answers.push(answer(&mut tab, id).await);
            if spec.tool == "temporal" {
                id += 1;
                tab.call(
                    id,
                    "temporal.testCodec",
                    json!({ "draft": { "name": "r", "fields": fields, "secrets": secrets } }),
                )
                .await;
                answers.push(answer(&mut tab, id).await);
            }
            if spec.tool == "nats" && n < 2 {
                id += 1;
                tab.call(
                    id,
                    "messaging.registry.test",
                    json!({ "tool": "nats", "draft": { "name": "r", "fields": fields, "secrets": secrets } }),
                )
                .await;
                answers.push(answer(&mut tab, id).await);
            }
            id += 1;
            tab.call(
                id,
                "profiles.create",
                json!({ "tool": spec.tool, "name": format!("r{n}"), "owner": { "kind": "personal" },
                        "fields": fields, "secrets": secrets }),
            )
            .await;
            let made = answer(&mut tab, id).await;
            answers.push(made.clone());
            let made: Value = serde_json::from_str(&made).unwrap_or(Value::Null);
            let Some(profile) = made["id"].as_str().map(str::to_owned) else {
                continue;
            };
            id += 1;
            tab.call_raw(
                id,
                &format!("{}.connect", spec.tool),
                json!({ "profileId": profile }),
            )
            .await;
            answers.push(answer(&mut tab, id).await);
            if let Some(field) = spec.secrets.first() {
                id += 1;
                let value = seeds.for_field(field);
                tab.call(
                    id,
                    "secrets.set",
                    json!({ "owner": { "kind": "profile", "id": profile }, "field": field, "value": value }),
                )
                .await;
                answers.push(answer(&mut tab, id).await);
                id += 1;
                tab.call(
                    id,
                    "secrets.status",
                    json!({ "owner": { "kind": "profile", "id": profile } }),
                )
                .await;
                answers.push(answer(&mut tab, id).await);
                id += 1;
                let value = seeds.for_field(field);
                tab.call(
                    id,
                    "profiles.update",
                    json!({ "id": profile, "etag": made["etag"], "secrets": { *field: value } }),
                )
                .await;
                answers.push(answer(&mut tab, id).await);
            }
            id += 1;
            tab.call(id, "profiles.get", json!({ "id": profile })).await;
            answers.push(answer(&mut tab, id).await);
        }
        id += 1;
        tab.call(id, "profiles.list", json!({ "tool": spec.tool }))
            .await;
        answers.push(answer(&mut tab, id).await);
        // Whatever else the server pushed to this tab.
        answers.extend(
            tab.pending
                .iter()
                .map(|f| String::from_utf8_lossy(&f.payload).into_owned()),
        );
        tab.disconnect().await;
    }

    // SSH hosts (TSK-144): a host's key and password through create, Test, set, update, a
    // Docker profile that names the host and its connect and Test, and a Docker record of
    // version 1 imported (its login moves to a host).
    let browser = t.browser_as("human:account:redaction-ssh", &[]).await;
    let mut tab = t.tab(&browser).await;
    let closed = json!({ "host": "127.0.0.1", "port": 1, "username": "u", "auth": "password" });
    let key = seeds.for_field("privateKey");
    let password = seeds.for_field("password");
    let passphrase = seeds.for_field("passphrase");
    tab.call(
        8000,
        "sshHosts.test",
        json!({ "fields": closed, "secrets": { "password": password } }),
    )
    .await;
    answers.push(answer(&mut tab, 8000).await);
    tab.call(
        8001,
        "sshHosts.create",
        json!({ "name": "h", "owner": { "kind": "personal" }, "fields": closed,
                "secrets": { "password": password, "privateKey": key, "passphrase": passphrase } }),
    )
    .await;
    let made = answer(&mut tab, 8001).await;
    answers.push(made.clone());
    let host: Value = serde_json::from_str(&made).unwrap_or(Value::Null);
    let host_id = host["id"].clone();
    let password = seeds.for_field("password");
    tab.call(
        8002,
        "secrets.set",
        json!({ "owner": { "kind": "sshHost", "id": host_id }, "field": "password", "value": password }),
    )
    .await;
    answers.push(answer(&mut tab, 8002).await);
    tab.call(
        8003,
        "sshHosts.test",
        json!({ "fields": closed, "secrets": {}, "hostId": host_id }),
    )
    .await;
    answers.push(answer(&mut tab, 8003).await);
    tab.call(
        8004,
        "profiles.create",
        json!({ "tool": "docker", "name": "d", "owner": { "kind": "personal" }, "fields": { "sshHostId": host_id } }),
    )
    .await;
    let profile: Value = serde_json::from_str(&answer(&mut tab, 8004).await).unwrap_or(Value::Null);
    tab.call_raw(
        8005,
        "docker.connect",
        json!({ "profileId": profile["id"] }),
    )
    .await;
    answers.push(answer(&mut tab, 8005).await);
    tab.call(
        8006,
        "docker.test",
        json!({ "draft": { "fields": { "sshHostId": host_id }, "secrets": {} }, "basedOn": profile["id"] }),
    )
    .await;
    answers.push(answer(&mut tab, 8006).await);
    let password = seeds.for_field("password");
    tab.call(8007, "sshHosts.get", json!({ "id": host_id }))
        .await;
    let current: Value = serde_json::from_str(&answer(&mut tab, 8007).await).unwrap_or(Value::Null);
    tab.call(
        8008,
        "sshHosts.update",
        json!({ "id": host_id, "etag": current["etag"], "fields": { "host": "127.0.0.2", "port": 1, "username": "u", "auth": "password" },
                "secrets": { "password": password } }),
    )
    .await;
    answers.push(answer(&mut tab, 8008).await);
    let password = seeds.for_field("password");
    tab.call(
        8009,
        "profiles.import",
        json!({ "sourceId": "d1", "owner": { "kind": "personal" },
                "record": { "tool": "docker", "version": 1, "name": "old", "fields": { "host": "127.0.0.3", "port": 1, "username": "u", "auth": "password" } },
                "secrets": { "password": password } }),
    )
    .await;
    answers.push(answer(&mut tab, 8009).await);
    tab.call(8010, "sshHosts.list", json!({})).await;
    answers.push(answer(&mut tab, 8010).await);
    answers.extend(
        tab.pending
            .iter()
            .map(|f| String::from_utf8_lossy(&f.payload).into_owned()),
    );
    tab.disconnect().await;

    // A browser record imported once.
    let browser = t.browser_as("human:account:redaction-import", &[]).await;
    let mut tab = t.tab(&browser).await;
    let token = seeds.plain("token");
    tab.call(
        9000,
        "profiles.import",
        json!({ "sourceId": "b1", "owner": { "kind": "personal" },
                "record": { "tool": "echo", "version": 1, "name": "imported", "fields": {} },
                "secrets": { "token": token } }),
    )
    .await;
    answers.push(answer(&mut tab, 9000).await);
    tab.disconnect().await;

    if let Ok(path) = std::env::var("REDACTION_DUMP") {
        std::fs::write(path, answers.join("\n")).unwrap();
    }
    let data = t._dir.path().to_path_buf();
    t.server.shutdown().await.unwrap();

    // Everywhere a secret could have gone.
    let mut places: Vec<(String, String)> = Vec::new();
    for (n, text) in answers.iter().enumerate() {
        places.push((format!("answer {n}"), text.clone()));
    }
    let log = lines.0.lock().unwrap().join("\n");
    places.push(("the log".into(), log.clone()));
    for entry in walk(&data.join("audit")) {
        places.push((
            entry.display().to_string(),
            String::from_utf8_lossy(&std::fs::read(&entry).unwrap()).into_owned(),
        ));
    }
    places.push((
        "store.redb".into(),
        String::from_utf8_lossy(&std::fs::read(data.join("store.redb")).unwrap()).into_owned(),
    ));
    places.push(("panics".into(), panics.lock().unwrap().join("\n")));
    let mut leaks = Vec::new();
    for seed in &seeds.all {
        for (place, text) in &places {
            if text.contains(seed.as_str()) {
                leaks.push(format!("{seed} in {place}"));
            }
        }
    }
    assert!(
        leaks.is_empty(),
        "seeded secrets leaked:\n{}",
        leaks.join("\n")
    );
    // The checks looked at something: the log names the administrator's password file, the audit
    // log holds the calls, and the answers include the tools' errors.
    assert!(log.contains("admin-password"), "{log}");
    assert!(
        places
            .iter()
            .any(|(p, t)| p.contains("audit-") && t.contains("echo.test"))
    );
    assert!(answers.len() > 40, "{}", answers.len());
}

/// The input types that carry a secret print none of it with `{:?}`: a panic or a log line that
/// formats one cannot leak it.
#[test]
fn debug_formats_hold_no_secret() {
    use mightyconsole_server::api::{
        ChangePasswordInput, TermWriteInput, TotpConfirmInput, TotpRemoveInput,
    };
    use mightyconsole_server::core::stored::ToolTestInput;
    use mightyconsole_server::profiles::api::{
        ProfileCreateInput, ProfileImportInput, ProfileUpdateInput, SecretSetInput,
        SshHostCreateInput, SshHostImportInput, SshHostTestInput, SshHostUpdateInput,
    };
    const S: &str = "SEEDdebug77";
    fn shown<T: serde::de::DeserializeOwned + std::fmt::Debug>(value: Value) -> String {
        let parsed: T = serde_json::from_value(value).expect("the input parses");
        format!("{parsed:?}")
    }
    let formats = [
        shown::<ChangePasswordInput>(json!({ "current": S, "new": S })),
        shown::<TotpConfirmInput>(json!({ "code": S })),
        shown::<TotpRemoveInput>(json!({ "current": S })),
        shown::<TermWriteInput>(json!({ "terminalId": "t", "data": S })),
        shown::<ToolTestInput>(json!({ "draft": { "fields": {}, "secrets": { "token": S } } })),
        shown::<ProfileCreateInput>(
            json!({ "tool": "echo", "name": "n", "owner": { "kind": "personal" },
                                            "fields": {}, "secrets": { "token": S } }),
        ),
        shown::<ProfileUpdateInput>(json!({ "id": "p", "etag": "1", "secrets": { "token": S } })),
        shown::<ProfileImportInput>(json!({ "sourceId": "b", "owner": { "kind": "personal" },
                                            "record": { "tool": "echo", "version": 1, "name": "n", "fields": {} },
                                            "secrets": { "token": S } })),
        shown::<SecretSetInput>(
            json!({ "owner": { "kind": "profile", "id": "p" }, "field": "token", "value": S }),
        ),
        shown::<SshHostCreateInput>(json!({ "name": "h", "owner": { "kind": "personal" },
                                            "fields": { "host": "h", "username": "u" }, "secrets": { "privateKey": S } })),
        shown::<SshHostUpdateInput>(
            json!({ "id": "h", "etag": "1", "secrets": { "password": S } }),
        ),
        shown::<SshHostImportInput>(
            json!({ "sourceId": "s", "name": "h", "owner": { "kind": "personal" },
                                            "fields": { "host": "h", "username": "u" }, "secrets": { "passphrase": S } }),
        ),
        shown::<SshHostTestInput>(
            json!({ "fields": { "host": "h", "username": "u" }, "secrets": { "password": S } }),
        ),
    ];
    for text in &formats {
        assert!(!text.contains(S), "{text}");
    }
    // The secret's field name is still shown, so a log says which secret a call set.
    assert!(formats[5].contains("token"), "{}", formats[5]);
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                out.extend(walk(&path));
            } else {
                out.push(path);
            }
        }
    }
    out
}
