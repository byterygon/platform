//! The secret store's keys with the built binary (DOC-25 §3.4.4, §3.6.2 point 5, §6 "Start"): a
//! first start generates `DATA/keys/kek-<id>.key` (0600) and says so; a key file with mode 0644,
//! a wrong passphrase, a failing key command and a stored secret whose key is missing each
//! refuse the start with their own message; `keys generate` and `secrets status`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use mightyconsole_server::secrets::crypto::Kek;
use mightyconsole_server::secrets::keys::{Keyring, key_file_text};
use mightyconsole_server::secrets::{Owner, Secret, Vault};
use mightyconsole_server::store::Store;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_mightyconsole-server");

fn command(args: &[&str], data: &Path) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .arg("--data")
        .arg(data)
        .env_remove("MIGHTYCONSOLE_CONFIG")
        .env_remove("MIGHTYCONSOLE_SECRET_PASSPHRASE")
        .stdin(Stdio::null());
    command
}

/// Starts the server and stops it once it listens; returns its stderr so far.
async fn start_and_stop(data: &Path) -> String {
    let mut child = command(&["serve", "--listen", "127.0.0.1:0"], data)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut log = String::new();
    let listening = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            log.push_str(&line);
            log.push('\n');
            if line.contains("listening on") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(listening, "the server did not start:\n{log}");
    child.kill().await.unwrap();
    log
}

/// Runs a start that must fail; returns its stderr.
async fn refused_start(data: &Path) -> String {
    let out = command(&["serve", "--listen", "127.0.0.1:0"], data)
        .output()
        .await
        .unwrap();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(!out.status.success(), "the start was not refused:\n{err}");
    assert!(!err.contains("listening on"), "{err}");
    err
}

fn write_private(path: &Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = mode;
}

fn write_config(data: &Path, text: &str) {
    write_private(&data.join("config.toml"), text, 0o600);
}

fn generated_keys(data: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(data.join("keys"))
        .map(|d| d.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default()
}

#[tokio::test]
async fn a_first_start_generates_a_key_and_says_where() {
    let dir = tempfile::tempdir().unwrap();
    let log = start_and_stop(dir.path()).await;
    let keys = generated_keys(dir.path());
    assert_eq!(keys.len(), 1, "{keys:?}");
    let name = keys[0].file_name().unwrap().to_str().unwrap().to_owned();
    assert!(name.starts_with("kek-") && name.ends_with(".key"), "{name}");
    assert!(log.contains("generated the secret key"), "{log}");
    assert!(log.contains(&keys[0].display().to_string()), "{log}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&keys[0]).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // The key itself is never printed.
    let key = std::fs::read_to_string(&keys[0]).unwrap();
    assert!(!log.contains(key.trim()), "the key is in the log");
    // The next start reuses it and warns no more.
    let log = start_and_stop(dir.path()).await;
    assert!(!log.contains("generated the secret key"), "{log}");
    assert_eq!(generated_keys(dir.path()), keys);
}

#[cfg(unix)]
#[tokio::test]
async fn a_key_file_with_mode_0644_refuses_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let key = dir.path().join("kek.key");
    write_private(&key, &key_file_text(&Kek::generate().unwrap()), 0o644);
    write_config(
        dir.path(),
        &format!("[[secrets.keys]]\nfile = {:?}\n", key.display().to_string()),
    );
    let err = refused_start(dir.path()).await;
    assert!(err.contains("mode 0644"), "{err}");
    assert!(err.contains(&key.display().to_string()), "{err}");
}

#[tokio::test]
async fn a_wrong_passphrase_refuses_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let pass = dir.path().join("passphrase");
    write_private(&pass, "the right passphrase, long enough\n", 0o600);
    write_config(
        dir.path(),
        "[[secrets.keys]]\nsource = \"passphrase\"\npassphrase_file = \"passphrase\"\n",
    );
    let log = start_and_stop(dir.path()).await;
    assert!(log.contains("made the passphrase key"), "{log}");
    write_private(&pass, "a wrong passphrase, also long\n", 0o600);
    let err = refused_start(dir.path()).await;
    assert!(err.contains("the passphrase does not open key"), "{err}");
    assert!(!err.contains("a wrong passphrase"), "{err}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_key_command_refuses_the_start() {
    let dir = tempfile::tempdir().unwrap();
    write_config(
        dir.path(),
        "[[secrets.keys]]\nsource = \"command\"\ncommand = [\"/bin/sh\", \"-c\", \"echo 'kms: access denied' >&2; exit 4\"]\n",
    );
    let err = refused_start(dir.path()).await;
    assert!(err.contains("key command \"/bin/sh\" failed"), "{err}");
    assert!(err.contains("kms: access denied"), "{err}");
}

#[tokio::test]
async fn a_secret_whose_key_is_missing_refuses_the_start() {
    let dir = tempfile::tempdir().unwrap();
    // A start generates the key; a secret is then stored under another key.
    start_and_stop(dir.path()).await;
    let other = Kek::generate().unwrap();
    let other_id = other.id().to_owned();
    {
        let store = Store::open(dir.path()).unwrap();
        let vault = Vault::new(Keyring::new(vec![other]).unwrap(), "default");
        vault
            .set(
                &store,
                &Owner::profile("p1"),
                "password",
                &Secret::new("v"),
                "test",
                1,
            )
            .unwrap();
    }
    let err = refused_start(dir.path()).await;
    assert!(
        err.contains(&format!("1 secret entry under key {other_id}")),
        "{err}"
    );
    let out = command(&["secrets", "status"], dir.path())
        .output()
        .await
        .unwrap();
    assert!(out.status.success());
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("1 secret entry in"), "{text}");
    assert!(
        text.contains(&format!("key {other_id}: 1 entry, 1 data key wrapped")),
        "{text}"
    );
}

#[tokio::test]
async fn keys_generate_writes_a_private_key_file_once() {
    let dir = tempfile::tempdir().unwrap();
    let out_file = dir.path().join("new.key");
    let run = || {
        let mut c = Command::new(BIN);
        c.args(["keys", "generate", "--out"]).arg(&out_file);
        c
    };
    let out = run().output().await.unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let stdout = String::from_utf8_lossy(&out.stdout);
    let key = std::fs::read_to_string(&out_file).unwrap();
    assert_eq!(key.len(), 45);
    assert!(stdout.starts_with("wrote key "), "{stdout}");
    assert!(!stdout.contains(key.trim()), "the key is printed");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&out_file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // An existing file is not overwritten.
    let again = run().output().await.unwrap();
    assert!(!again.status.success());
    assert_eq!(std::fs::read_to_string(&out_file).unwrap(), key);
    // The generated file is a usable key.
    write_config(
        dir.path(),
        &format!(
            "[[secrets.keys]]\nfile = {:?}\n",
            out_file.display().to_string()
        ),
    );
    let log = start_and_stop(dir.path()).await;
    assert!(!log.contains("generated the secret key"), "{log}");
    assert!(generated_keys(dir.path()).is_empty());
}

/// Starts the server, then stops it with SIGTERM (a clean stop) and waits for it.
#[cfg(unix)]
async fn start_and_stop_cleanly(data: &Path) {
    let mut child = command(&["serve", "--listen", "127.0.0.1:0"], data)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let listening = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if line.contains("listening on") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(listening);
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    let pid = child.id().unwrap().to_string();
    let killed = Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .await
        .unwrap();
    assert!(killed.success());
    let status = tokio::time::timeout(Duration::from_secs(30), child.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status}");
}

async fn audit_verify(data: &Path) -> (Option<i32>, String) {
    let out = command(&["audit", "verify"], data).output().await.unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    (out.status.code(), text)
}

#[cfg(unix)]
#[tokio::test]
async fn a_log_cut_at_its_end_is_found_by_the_checkpoint() {
    let dir = tempfile::tempdir().unwrap();
    start_and_stop_cleanly(dir.path()).await;
    let (code, text) = audit_verify(dir.path()).await;
    assert_eq!(code, Some(0), "{text}");
    assert!(text.contains("checkpoint: intact"), "{text}");
    let cp: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(dir.path().join("audit/checkpoint.json")).unwrap(),
    )
    .unwrap();
    // server.start and server.stop: the clean stop checkpointed the last one.
    assert_eq!(cp["seq"], 1, "{cp}");

    // Cut the last record (server.stop): the chain alone still verifies.
    let log = mightyconsole_server::audit::log_path(dir.path());
    let text = std::fs::read_to_string(&log).unwrap();
    let mut lines: Vec<&str> = text.lines().collect();
    lines.pop();
    std::fs::write(&log, format!("{}\n", lines.join("\n"))).unwrap();
    let (code, text) = audit_verify(dir.path()).await;
    assert_eq!(code, Some(1), "{text}");
    assert!(text.contains("truncated tail"), "{text}");
    let err = refused_start(dir.path()).await;
    assert!(err.contains("truncated tail"), "{err}");

    // `audit verify` of files (no data directory) cannot check it.
    let out = Command::new(BIN)
        .args(["audit", "verify"])
        .arg(&log)
        .output()
        .await
        .unwrap();
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(
        text.contains("checkpoint: not checked (files given"),
        "{text}"
    );
}

/// A running server whose stderr lines arrive on a channel.
#[cfg(unix)]
struct Running {
    child: tokio::process::Child,
    lines: tokio::sync::mpsc::UnboundedReceiver<String>,
}

#[cfg(unix)]
impl Running {
    async fn start(data: &Path) -> Running {
        let mut child = command(&["serve", "--listen", "127.0.0.1:0"], data)
            .stderr(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send(line);
            }
        });
        let mut running = Running { child, lines: rx };
        running.wait_for("listening on").await;
        running
    }

    async fn wait_for(&mut self, needle: &str) -> String {
        let mut seen = String::new();
        let found = tokio::time::timeout(Duration::from_secs(60), async {
            while let Some(line) = self.lines.recv().await {
                seen.push_str(&line);
                seen.push('\n');
                if line.contains(needle) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false);
        assert!(found, "no line with {needle:?}:\n{seen}");
        seen
    }

    async fn signal(&self, name: &str) {
        let pid = self.child.id().unwrap().to_string();
        let status = Command::new("kill")
            .args([name, &pid])
            .status()
            .await
            .unwrap();
        assert!(status.success());
    }

    async fn stop(mut self) {
        self.signal("-TERM").await;
        let status = tokio::time::timeout(Duration::from_secs(30), self.child.wait())
            .await
            .unwrap()
            .unwrap();
        let mut rest = String::new();
        while let Ok(line) = self.lines.try_recv() {
            rest.push_str(&line);
            rest.push('\n');
        }
        assert!(status.success(), "{status}; its last lines:\n{rest}");
    }
}

/// `[[secrets.keys]]` of these files, with `audit.stderr` on (a reload changes the keys only).
#[cfg(unix)]
fn key_config(paths: &[&Path]) -> String {
    let keys: String = paths
        .iter()
        .map(|p| format!("[[secrets.keys]]\nfile = {:?}\n", p.display().to_string()))
        .collect();
    format!("[audit]\nstderr = true\n\n{keys}")
}

#[cfg(unix)]
#[tokio::test]
async fn sighup_rotates_to_a_new_key_and_the_old_one_can_then_go() {
    let dir = tempfile::tempdir().unwrap();
    let (old, new) = (Kek::generate().unwrap(), Kek::generate().unwrap());
    let (old_id, new_id) = (old.id().to_owned(), new.id().to_owned());
    let (old_path, new_path) = (dir.path().join("old.key"), dir.path().join("new.key"));
    write_private(&old_path, &key_file_text(&old), 0o600);
    write_private(&new_path, &key_file_text(&new), 0o600);
    {
        let store = Store::open(dir.path()).unwrap();
        let vault = Vault::new(Keyring::new(vec![old]).unwrap(), "default");
        for i in 0..3 {
            vault
                .set(
                    &store,
                    &Owner::profile(format!("p{i}")),
                    "password",
                    &Secret::new(format!("v{i}")),
                    "test",
                    1,
                )
                .unwrap();
        }
    }
    write_config(dir.path(), &key_config(&[&old_path]));
    let mut server = Running::start(dir.path()).await;

    // A reload whose keys do not open the stored entries keeps the keys in force.
    write_config(dir.path(), &key_config(&[&new_path]));
    server.signal("-HUP").await;
    let seen = server.wait_for("were not reloaded").await;
    assert!(
        seen.contains(&format!("3 secret entries under key {old_id}")),
        "{seen}"
    );

    // The new key first, the old one after it.
    write_config(dir.path(), &key_config(&[&new_path, &old_path]));
    server.signal("-HUP").await;
    let seen = server.wait_for("reloaded the secret keys").await;
    assert!(seen.contains(&format!("active {new_id}")), "{seen}");
    // audit.stderr shows when the re-wrap job ends (it may end before the reload's own line).
    if !seen.contains("secrets.rewrap end") {
        server.wait_for("secrets.rewrap end").await;
    }
    server.stop().await;

    let audit = std::fs::read_to_string(mightyconsole_server::audit::log_path(dir.path())).unwrap();
    let rewraps: Vec<&str> = audit
        .lines()
        .filter(|l| l.contains("secrets.rewrap"))
        .collect();
    assert_eq!(rewraps.len(), 2, "{audit}");
    assert!(rewraps[0].contains("\"phase\":\"start\"") && rewraps[0].contains(&old_id));
    assert!(rewraps[1].contains("\"phase\":\"end\"") && rewraps[1].contains("\"count\":\"3\""));
    {
        let store = Store::open(dir.path()).unwrap();
        let by_key = mightyconsole_server::secrets::entries_by_key(&store).unwrap();
        assert_eq!(
            by_key.into_iter().collect::<Vec<_>>(),
            [(new_id.clone(), 3)]
        );
    }
    // Every entry is under the new key: the old key can be removed.
    write_config(dir.path(), &key_config(&[&new_path]));
    let server = Running::start(dir.path()).await;
    server.stop().await;
    let (code, text) = audit_verify(dir.path()).await;
    assert_eq!(code, Some(0), "{text}");
    assert!(text.contains("checkpoint: intact"), "{text}");
}
