//! Online backup and restore (DOC-25 §3.4.6, §6 "Secrets"): `admin.backup.snapshot` and
//! `admin.secrets.status` for an administrator only; the backup holds the store, the audit log
//! and its checkpoint, never the keys; `restore` into a new directory checks it, and with the keys
//! the restored server starts (with `server.restore`) and every secret decrypts, without them it
//! refuses to start.

mod support;

use std::path::Path;

use ambidex::Code;
use mightyconsole_server::secrets::{Owner, Secret};
use mightyconsole_server::{Server, StartError, StartOptions};
use serde_json::json;
use support::*;

const BIN: &str = env!("CARGO_BIN_EXE_mightyconsole-server");

fn admin_id(t: &TestServer) -> String {
    t.server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id()
}

async fn restore(args: &[&str]) -> (bool, String) {
    let out = tokio::process::Command::new(BIN)
        .arg("restore")
        .args(args)
        .env_remove("MIGHTYCONSOLE_CONFIG")
        .env_remove("MIGHTYCONSOLE_DATA")
        .output()
        .await
        .unwrap();
    (
        out.status.success(),
        format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    )
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
    }
}

#[tokio::test]
async fn a_backup_restores_with_its_keys_and_refuses_to_start_without_them() {
    let t = start_with_durable_audit(StartOptions::default()).await;
    let data = t._dir.path().to_path_buf();
    let owner = Owner::profile("p1");
    let at = security_types::unix_now_ms();
    t.server
        .vault()
        .set(
            t.server.store(),
            &owner,
            "password",
            &Secret::new("s3cret-value-77"),
            "test",
            at,
        )
        .unwrap();

    // Not for a member.
    let member = t.browser().await;
    let mut m = t.tab(&member).await;
    m.call(1, "admin.backup.snapshot", json!({})).await;
    m.error(1, Code::PermissionDenied).await;
    m.call(2, "admin.secrets.status", json!({})).await;
    m.error(2, Code::PermissionDenied).await;

    let admin = t.browser_as(&admin_id(&t), &[]).await;
    let mut a = t.tab(&admin).await;
    a.call(1, "admin.secrets.status", json!({})).await;
    let status = a.result(1).await;
    assert_eq!(status["entries"], 1, "{status}");
    assert_eq!(status["keys"][0]["source"], "generated", "{status}");
    assert_eq!(status["keys"][0]["active"], true, "{status}");
    assert_eq!(status["keys"][0]["entries"], 1, "{status}");
    assert_eq!(status["rewrap"]["running"], false, "{status}");

    a.call(2, "admin.backup.snapshot", json!({})).await;
    let made = a.result(2).await;
    let file = made["file"].as_str().unwrap().to_owned();
    assert!(
        file.starts_with("backups/backup-") && file.ends_with(".tar"),
        "{made}"
    );
    let archive = data.join(&file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&archive).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let bytes = std::fs::read(&archive).unwrap();
    assert_eq!(made["bytes"], bytes.len() as u64);
    // Never the keys, never a value in clear.
    let key = std::fs::read_dir(data.join("keys"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    let key_text = std::fs::read_to_string(key.path()).unwrap();
    let contains = |needle: &[u8]| bytes.windows(needle.len()).any(|w| w == needle);
    assert!(
        !contains(key_text.trim().as_bytes()),
        "the key is in the backup"
    );
    assert!(!contains(b"keys/"), "a keys/ entry is in the backup");
    assert!(
        !contains(b"s3cret-value-77"),
        "a value is in the backup in clear"
    );
    t.server.shutdown().await.unwrap();

    // Without the keys: the restore checks the store and the chain, the secrets cannot be.
    let base = tempfile::tempdir().unwrap();
    let bare = base.path().join("bare");
    let (ok, text) = restore(&["--data", bare.to_str().unwrap(), archive.to_str().unwrap()]).await;
    assert!(ok, "{text}");
    assert!(text.contains("the audit log is intact"), "{text}");
    let Err(err) = Server::start_with(config(&bare, None), StartOptions::default()).await else {
        panic!("a restore without its keys must not start");
    };
    assert!(matches!(err, StartError::Secrets(_)), "{err}");
    assert!(
        err.to_string().contains("the store has 1 secret entry"),
        "{err}"
    );

    // A non-empty directory is refused.
    let (ok, text) = restore(&["--data", bare.to_str().unwrap(), archive.to_str().unwrap()]).await;
    assert!(!ok);
    assert!(text.contains("is not empty"), "{text}");

    // --check-secrets without keys, then with them.
    let keyed = base.path().join("keyed");
    let (ok, text) = restore(&[
        "--data",
        keyed.to_str().unwrap(),
        "--check-secrets",
        archive.to_str().unwrap(),
    ])
    .await;
    assert!(!ok);
    assert!(text.contains("provide the keys first"), "{text}");
    // The keys, kept apart from the data as the guide says, named by the configuration.
    copy_dir(&data.join("keys"), &base.path().join("keys"));
    let restored = base.path().join("restored");
    let config_file = base.path().join("config.toml");
    let key_file = base.path().join("keys").join(key.file_name());
    std::fs::write(
        &config_file,
        format!(
            "[[secrets.keys]]\nfile = {:?}\n",
            key_file.display().to_string()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&config_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let (ok, text) = restore(&[
        "--data",
        restored.to_str().unwrap(),
        "--config",
        config_file.to_str().unwrap(),
        "--check-secrets",
        archive.to_str().unwrap(),
    ])
    .await;
    assert!(ok, "{text}");
    assert!(text.contains("every stored secret decrypts"), "{text}");

    // With the keys the restored server starts, records server.restore, and the secret is there.
    let mut restored_config = config(&restored, None);
    restored_config.secrets = mightyconsole_server::secrets::keys::SecretsSettings {
        keys: vec![mightyconsole_server::secrets::keys::KeySource::File(
            key_file,
        )],
    };
    let server = Server::start_with(restored_config, StartOptions::default())
        .await
        .expect("the restored server starts with its keys");
    let value = server
        .vault()
        .get(server.store(), &owner, "password")
        .unwrap()
        .unwrap();
    assert_eq!(value.as_str(), Some("s3cret-value-77"));
    server.shutdown().await.unwrap();
    let audit: String =
        audit_jsonl::segment_files(&mightyconsole_server::audit::audit_dir(&restored))
            .unwrap()
            .iter()
            .map(|p| std::fs::read_to_string(p).unwrap())
            .collect();
    assert!(audit.contains("server.restore"), "{audit}");
    assert!(
        audit.contains(&format!("\"backup_seq\":\"{}\"", made["auditSeq"])),
        "{audit}"
    );
    assert!(!restored.join("restore.json").exists());
}
