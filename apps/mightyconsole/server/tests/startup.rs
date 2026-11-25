//! The server fails closed at start (DOC-25 §3.6.2, §6 "Start"), with the built binary: every
//! combination of the configuration that the spec says refuses the start does, with one message
//! per failed condition naming what is missing, all at once, before anything is created; the
//! combinations that start do, with the warning the spec asks for. `config check` says the same
//! as `serve` and creates nothing.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

const BIN: &str = env!("CARGO_BIN_EXE_mightyconsole-server");

fn command(args: &[&str], data: &Path) -> Command {
    let mut command = Command::new(BIN);
    command
        .args(args)
        .arg("--data")
        .arg(data)
        .env_remove("MIGHTYCONSOLE_CONFIG")
        .env_remove("MIGHTYCONSOLE_SECRET_PASSPHRASE")
        .env_remove("MIGHTYCONSOLE_OIDC_CLIENT_SECRET")
        .stdin(Stdio::null());
    command
}

fn private(path: &Path, text: &str, mode: u32) {
    std::fs::write(path, text).unwrap();
    chmod(path, mode);
}

fn chmod(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
}

/// A data directory with `config.toml` holding `config`.
fn data_with(config: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    private(&dir.path().join("config.toml"), config, 0o600);
    dir
}

/// What the directory holds besides the configuration file: a refused start creates nothing.
fn created(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "config.toml")
        .collect();
    names.sort();
    names
}

/// A start that must be refused: its stderr, which never says it listens.
async fn refused(args: &[&str], data: &Path) -> String {
    let out = command(args, data).output().await.unwrap();
    let err = String::from_utf8_lossy(&out.stderr).into_owned();
    assert!(!out.status.success(), "the start was not refused:\n{err}");
    assert!(!err.contains("listening on"), "{err}");
    err
}

const SERVE: &[&str] = &["serve", "--listen", "127.0.0.1:0"];

/// A start that must succeed, stopped once it listens: its stderr so far.
async fn started(args: &[&str], data: &Path) -> String {
    let mut child = command(args, data)
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let log = read_until_listening(&mut child).await;
    child.kill().await.unwrap();
    log
}

async fn read_until_listening(child: &mut Child) -> String {
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let mut log = String::new();
    let listening = tokio::time::timeout(Duration::from_secs(120), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            log.push_str(&line);
            log.push('\n');
            // The warnings come after the line that says where it listens.
            if line.contains("open https://") {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false);
    assert!(listening, "the server did not start:\n{log}");
    log
}

const ACCOUNTS_OFF: &str = "auth.accounts = false needs [auth.oidc]";
const DEFAULT_ADMIN_OFF: &str = "auth.default_admin = false needs a pinned";

#[tokio::test]
async fn accounts_off_without_oidc_refuses_the_start() {
    let dir = data_with("[auth]\naccounts = false\n");
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains(ACCOUNTS_OFF), "{err}");
    assert!(!err.contains(DEFAULT_ADMIN_OFF), "{err}");
    assert_eq!(created(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn default_admin_off_without_a_pinned_admin_refuses_the_start() {
    let dir = data_with("[auth]\ndefault_admin = false\n");
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains(DEFAULT_ADMIN_OFF), "{err}");
    assert!(!err.contains(ACCOUNTS_OFF), "{err}");
    assert_eq!(created(dir.path()), Vec::<String>::new());
}

#[tokio::test]
async fn a_pinned_admin_with_a_scope_is_not_an_administrator_everywhere() {
    let dir = data_with(
        "[auth]\ndefault_admin = false\n\n[[auth.group_roles]]\ngroup = \"local:ops\"\nrole = \"admin\"\n\
         scope = [\"profile:one\"]\n",
    );
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains(DEFAULT_ADMIN_OFF), "{err}");
    // Without a scope the same mapping makes someone an administrator everywhere: it starts.
    let dir = data_with(
        "[auth]\ndefault_admin = false\n\n[[auth.group_roles]]\ngroup = \"local:ops\"\nrole = \"admin\"\n",
    );
    let log = started(SERVE, dir.path()).await;
    assert!(!log.contains("admin-password"), "{log}");
    assert!(!dir.path().join("admin-password").exists());
}

#[tokio::test]
async fn every_failed_condition_is_reported_at_once_before_anything_is_created() {
    // No way to sign in, no administrator, a key file anyone can read, a data directory anyone
    // can write to: four conditions, four messages, in one run.
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let key = dir.path().join("kek.key");
    private(&key, "not read: the mode is checked first\n", 0o644);
    private(
        &data.join("config.toml"),
        &format!(
            "[auth]\naccounts = false\ndefault_admin = false\n\n[[secrets.keys]]\nfile = {:?}\n",
            key.display().to_string()
        ),
        0o600,
    );
    chmod(&data, 0o777);
    let err = refused(SERVE, &data).await;
    assert!(err.contains(ACCOUNTS_OFF), "{err}");
    assert!(err.contains(DEFAULT_ADMIN_OFF), "{err}");
    assert!(err.contains("mode 0644"), "{err}");
    assert!(err.contains("group- or world-writable"), "{err}");
    assert!(err.contains(&data.display().to_string()), "{err}");
    assert_eq!(created(&data), Vec::<String>::new());
    // `config check` says the same, and exits without listening.
    let err = refused(&["config", "check"], &data).await;
    assert!(
        err.contains(ACCOUNTS_OFF) && err.contains("mode 0644"),
        "{err}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_data_directory_or_keys_directory_others_can_write_to_refuses_the_start() {
    let dir = data_with("");
    chmod(dir.path(), 0o770);
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains("data directory"), "{err}");
    assert!(err.contains("mode 0770"), "{err}");
    assert!(err.contains("chmod 700"), "{err}");
    assert_eq!(created(dir.path()), Vec::<String>::new());

    let dir = data_with("");
    let keys = dir.path().join("keys");
    std::fs::create_dir(&keys).unwrap();
    chmod(&keys, 0o775);
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains(&keys.display().to_string()), "{err}");
    assert!(err.contains("group- or world-writable"), "{err}");
}

#[cfg(unix)]
#[tokio::test]
async fn a_configuration_file_others_can_write_to_refuses_the_start() {
    let dir = data_with("");
    chmod(&dir.path().join("config.toml"), 0o664);
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains("config.toml"), "{err}");
    assert!(err.contains("group- or world-writable"), "{err}");
}

#[tokio::test]
async fn an_oidc_configuration_that_does_not_load_refuses_the_start_and_says_which_part() {
    // The CA file named is not there: that is a start failure, an unreachable IdP is not.
    let dir = data_with(
        "[auth.oidc]\nissuer = \"https://idp.invalid\"\nclient_id = \"mc\"\ntoken_auth = \"none\"\n\
         ca_file = \"/no/such/ca.pem\"\n",
    );
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains("ca_file /no/such/ca.pem"), "{err}");
    assert_eq!(created(dir.path()), Vec::<String>::new());

    // The client secret is needed unless the client is public.
    let ca = dir.path().join("ca.pem");
    let tls_dir = tempfile::tempdir().unwrap();
    started(SERVE, tls_dir.path()).await;
    std::fs::copy(tls_dir.path().join("tls/cert.pem"), &ca).unwrap();
    private(
        &dir.path().join("config.toml"),
        &format!(
            "[auth.oidc]\nissuer = \"https://idp.invalid\"\nclient_id = \"mc\"\nca_file = {:?}\n",
            ca.display().to_string()
        ),
        0o600,
    );
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains("client_secret_file"), "{err}");
}

#[tokio::test]
async fn a_server_already_running_on_the_data_directory_refuses_the_start() {
    let dir = tempfile::tempdir().unwrap();
    let mut first = command(SERVE, dir.path())
        .stderr(Stdio::piped())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let log = read_until_listening(&mut first).await;
    assert!(log.contains("listening on"), "{log}");
    let err = refused(SERVE, dir.path()).await;
    assert!(err.contains("another process has it open"), "{err}");
    first.kill().await.unwrap();
}

#[tokio::test]
async fn a_loopback_start_with_the_generated_certificate_has_no_warning() {
    // The data directory does not exist yet: the start makes it, private (DOC-25 §3.6.3).
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("fresh").join("data");
    let log = started(SERVE, &data).await;
    assert!(
        !log.contains("WARNING: the certificate is self-signed"),
        "{log}"
    );
    assert!(!log.contains("roles are not built"), "{log}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&data).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "the data directory made by the start");
    }
}

#[tokio::test]
async fn a_non_loopback_start_with_the_generated_certificate_starts_with_the_warning() {
    // DOC-25 §3.6.2 point 3 (Open question 2): login is always on, so this is allowed.
    let dir = tempfile::tempdir().unwrap();
    let log = started(&["serve", "--listen", "0.0.0.0:0"], dir.path()).await;
    assert!(
        log.contains("WARNING: the certificate is self-signed: give --tls-cert and --tls-key"),
        "{log}"
    );
}

#[tokio::test]
async fn a_non_loopback_start_with_an_operator_certificate_has_no_warning() {
    // Any certificate and key do: take the pair a first start generated.
    let made = tempfile::tempdir().unwrap();
    started(SERVE, made.path()).await;
    let (cert, key) = (
        made.path().join("tls/cert.pem"),
        made.path().join("tls/key.pem"),
    );
    let dir = tempfile::tempdir().unwrap();
    let log = started(
        &[
            "serve",
            "--listen",
            "0.0.0.0:0",
            "--tls-cert",
            cert.to_str().unwrap(),
            "--tls-key",
            key.to_str().unwrap(),
        ],
        dir.path(),
    )
    .await;
    assert!(!log.contains("self-signed"), "{log}");
}

#[tokio::test]
async fn config_check_creates_nothing_and_lists_what_it_checked() {
    let dir = data_with("");
    let out = command(&["config", "check"], dir.path())
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(text.contains("configuration ok"), "{text}");
    assert!(text.contains("audit log"), "{text}");
    assert_eq!(created(dir.path()), Vec::<String>::new());
}
