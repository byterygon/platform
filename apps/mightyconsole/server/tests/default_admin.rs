//! The default administrator and `reset-admin` (DOC-25 §3.2.7, §6 "Start"), with the built
//! binary: a first start makes `admin` and `DATA/admin-password` (0600) and logs the path, not
//! the password; `reset-admin` works with the server running (the request file) and stopped
//! (the store opened by the command), and each reset is in the audit log.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const BIN: &str = env!("CARGO_BIN_EXE_mightyconsole-server");

/// Starts the server on an ephemeral port; returns it once it listens, with its stderr so far.
async fn serve(data: &Path) -> (Child, String) {
    let mut child = Command::new(BIN)
        .args(["serve", "--listen", "127.0.0.1:0", "--data"])
        .arg(data)
        .env_remove("MIGHTYCONSOLE_CONFIG")
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
    // Keep draining stderr so the server never blocks on it.
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
    (child, log)
}

async fn reset_admin(data: &Path) -> (bool, String, String) {
    let out = Command::new(BIN)
        .args(["reset-admin", "--print", "--data"])
        .arg(data)
        .env_remove("MIGHTYCONSOLE_CONFIG")
        .output()
        .await
        .unwrap();
    (
        out.status.success(),
        String::from_utf8_lossy(&out.stdout).into_owned(),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn password(data: &Path) -> String {
    std::fs::read_to_string(data.join("admin-password"))
        .unwrap()
        .trim()
        .to_owned()
}

fn audit_text(data: &Path) -> String {
    let mut text = String::new();
    for entry in std::fs::read_dir(data.join("audit")).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "jsonl") {
            text.push_str(&std::fs::read_to_string(path).unwrap());
        }
    }
    text
}

#[tokio::test(flavor = "multi_thread")]
async fn first_start_then_reset_admin_running_and_stopped() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path();

    let (mut server, log) = serve(data).await;
    let first = password(data);
    assert_eq!(first.len(), 24);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(data.join("admin-password"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
        let store = std::fs::metadata(data.join("store.redb"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(store & 0o777, 0o600);
    }
    assert!(
        log.contains(&format!(
            "its password is in {}",
            data.join("admin-password").display()
        )),
        "{log}"
    );
    assert!(!log.contains(&first), "the log never holds the password");

    // Running: the command asks the server through the request file.
    let (ok, out, err) = reset_admin(data).await;
    assert!(ok, "{out}{err}");
    assert!(err.contains("the server is running"), "{err}");
    let second = password(data);
    assert_ne!(second, first);
    assert_eq!(
        out.lines().last(),
        Some(second.as_str()),
        "--print prints it"
    );
    assert!(!data.join("reset-admin.request").exists());
    // The server queues `auth.admin.reset` (EventLog::record) and then deletes the request, so the
    // command can return before the entry is written: wait for it, or the kill below can lose it
    // on a busy machine (TSK-155).
    let started = std::time::Instant::now();
    while !audit_text(data).contains("\"request\"") {
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no auth.admin.reset via request in the audit log"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    server.kill().await.unwrap();
    server.wait().await.unwrap();

    // Stopped: the command opens the store itself.
    let (ok, out, err) = reset_admin(data).await;
    assert!(ok, "{out}{err}");
    assert!(!err.contains("running"), "{err}");
    let third = password(data);
    assert_ne!(third, second);
    assert_eq!(out.lines().last(), Some(third.as_str()));

    // A restart keeps the account and does not make a new password.
    let (mut server, log) = serve(data).await;
    assert!(!log.contains("made the default administrator"), "{log}");
    assert_eq!(password(data), third);
    server.kill().await.unwrap();
    server.wait().await.unwrap();

    let audit = audit_text(data);
    assert!(audit.contains("\"auth.admin.reset\""), "{audit}");
    assert!(
        audit.contains("\"request\"") && audit.contains("\"stopped\""),
        "{audit}"
    );
    for secret in [&first, &second, &third] {
        assert!(
            !audit.contains(secret.as_str()),
            "no password in the audit log"
        );
    }
}

#[tokio::test]
async fn default_admin_off_refuses_the_start_and_the_reset() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("config.toml");
    std::fs::write(&config, "[auth]\ndefault_admin = false\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let out = Command::new(BIN)
        .args(["serve", "--listen", "127.0.0.1:0", "--data"])
        .arg(dir.path())
        .env_remove("MIGHTYCONSOLE_CONFIG")
        .output()
        .await
        .unwrap();
    assert!(!out.status.success());
    let err = String::from_utf8_lossy(&out.stderr);
    assert!(
        err.contains("auth.default_admin = false needs a pinned"),
        "{err}"
    );
    assert!(!dir.path().join("admin-password").exists());
    let (ok, _, err) = reset_admin(dir.path()).await;
    assert!(!ok);
    assert!(err.contains("turned off"), "{err}");
}
