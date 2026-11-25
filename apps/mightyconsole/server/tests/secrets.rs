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
