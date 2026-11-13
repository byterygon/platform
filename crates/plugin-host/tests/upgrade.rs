//! TSK-27: configurable package limits (spec question 37), grant carry-over on upgrade (39) and
//! the rollback audit fallback (41). Packages are built in memory and signed with test-only keys.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use plugin_host::grant::address_policy;
use plugin_host::grant::{
    GRANT_CARRY_DIGEST_DOMAIN, GRANT_RESTORE_DIGEST_DOMAIN, GrantSwitchRecord, RestoreOutcome,
    grant_switch_detail, grant_switch_digest,
};
use plugin_host::install::{
    AlertSink, Approval, AuditWarning, CARRY_GRANT_ACTION, FALLBACK_AUDIT_FILE, HostHooks,
    InstallAlert, InstallError, Installer, RESTORE_GRANT_ACTION, SwitchStep, SwitchWarning,
};
use plugin_host::package::{LimitField, LimitsError, verify_bytes};
use plugin_host::package::{PackageError, PackagePolicy, PinnedKey, TrustStore, canonical_bytes};
use plugin_host::{
    AuditError, AuditSink, CapabilityKind, ConnectionGrant, Eligibility, GrantId, GrantRequest,
    GrantStore, InstalledPlugin, MemoryAuditLog, PackageLimits, PackageLimitsConfig,
    PermissionDelta, SecretBinding, SystemClock, TlsPolicy,
};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use security_types::{
    AuditEntry, Authorizer, AuthzRequest, BoxFuture, Decision, Delivery, Outcome, Principal,
    PrincipalKind, Reason, SessionId, TargetRef, TenantId,
};
use semver::Version;
use sha2::{Digest as _, Sha256};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const PLUGIN: &str = "org.example.demo";
const ROLLBACK: &str = "plugin-host.packages.rollback";
const ACTIVATE: &str = "plugin-host.packages.activate";
const APPROVE: &str = "plugin-host.packages.approve";
const INSTALL: &str = "plugin-host.packages.install";

const HEADER: &str = r#"manifest_version = 1
id = "org.example.demo"
kind = "wasm"
entry = "payload/demo.wasm"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "example"
"#;

/// Two network templates and a secret; the plaintext grant below uses all of `db-transport`.
const FULL: &str = r#"
[[capabilities.network]]
id = "db-transport"
protocol = "tcp"
tls = "optional"
allow_cancel_connection = true

[[capabilities.network]]
id = "replica"
protocol = "tcp"
tls = "optional"

[[capabilities.secrets]]
id = "db-credentials"
purpose = "database-auth"
scope = "connection"
"#;

/// `FULL` without the cancel connection, the `replica` template and the secret.
const NARROW: &str = r#"
[[capabilities.network]]
id = "db-transport"
protocol = "tcp"
tls = "optional"
"#;

/// `FULL` plus a file capability.
const WIDE_EXTRA: &str = r#"
[[capabilities.files]]
id = "export"
mode = "write"
scope = "user-selected"
"#;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

struct Publisher {
    key: Ed25519KeyPair,
}

impl Publisher {
    fn new() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        Self {
            key: Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap(),
        }
    }

    fn trust(&self) -> TrustStore {
        TrustStore {
            publishers: BTreeMap::from([(
                "example".into(),
                vec![PinnedKey {
                    public_key_hex: hex(self.key.public_key().as_ref()),
                    plugin_ids: Default::default(),
                    first_party: false,
                }],
            )]),
        }
    }

    /// A signed package of `version` requesting `capabilities`, with `extra` payload files.
    fn package(&self, version: &str, capabilities: &str, extra: usize) -> Vec<u8> {
        self.package_with(version, capabilities, extra, version.as_bytes().to_vec())
    }

    fn package_with(
        &self,
        version: &str,
        capabilities: &str,
        extra: usize,
        payload: Vec<u8>,
    ) -> Vec<u8> {
        let manifest = format!("{HEADER}version = \"{version}\"\n{capabilities}");
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
            ("plugin.toml".into(), manifest.into_bytes()),
            ("payload/demo.wasm".into(), payload),
            ("sbom.spdx.json".into(), b"{}".to_vec()),
        ]);
        for i in 0..extra {
            files.insert(format!("payload/extra-{i}"), vec![b'x']);
        }
        let checks: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| {
                (
                    p.clone(),
                    serde_json::json!({"size": b.len(), "sha256": hex(&sha(b))}),
                )
            })
            .collect();
        files.insert(
            "checksums.json".into(),
            serde_json::to_vec(&serde_json::json!({"version": 1, "files": checks})).unwrap(),
        );
        let metadata: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| (p.clone(), (b.len() as u64, sha(b))))
            .collect();
        let signature = self.key.sign(&canonical_bytes(&metadata));
        files.insert(
            "signature.json".into(),
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "publisher": "example",
                "signature_hex": hex(signature.as_ref()),
            }))
            .unwrap(),
        );
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        for (name, bytes) in files {
            zip.start_file(name, opts).unwrap();
            zip.write_all(&bytes).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
}

fn policy() -> PackagePolicy {
    PackagePolicy {
        host_api: Version::parse("0.1.0").unwrap(),
        interface: "byterygon:db-driver@0.1.0".into(),
        platform: "linux-x86_64".into(),
        allow_third_party_sidecars: false,
    }
}

fn human() -> Principal {
    Principal {
        kind: PrincipalKind::Human,
        id: "human:local:test".into(),
        tenant: TenantId::new("t"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("s"),
    }
}

struct Allow;
impl Authorizer for Allow {
    async fn check(&self, _: &AuthzRequest<'_>) -> Decision {
        Decision::Allow
    }
}

/// Lets two operations pass authorization together, so they then race for the plugin lock.
struct MeetAtAuthorization(tokio::sync::Barrier);
impl Authorizer for MeetAtAuthorization {
    async fn check(&self, _: &AuthzRequest<'_>) -> Decision {
        self.0.wait().await;
        Decision::Allow
    }
}

/// Fails every entry of one action; records the rest.
struct FailAction(&'static str, MemoryAuditLog);
impl AuditSink for FailAction {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if entry.action.name == self.0 {
            Box::pin(async { Err(AuditError("primary sink down".into())) })
        } else {
            self.1.append(entry)
        }
    }
}

struct Deny;
impl Authorizer for Deny {
    async fn check(&self, _: &AuthzRequest<'_>) -> Decision {
        Decision::Deny {
            reason: Reason::Policy {
                message: "no".into(),
            },
        }
    }
}

/// Holds a grant-create audit entry until released, while armed, so another operation can run
/// between the target check of that create and its insert.
struct GateCreate {
    /// The action whose entry is held.
    action: &'static str,
    log: MemoryAuditLog,
    armed: AtomicBool,
    entered: tokio::sync::Notify,
    release: tokio::sync::Notify,
}
impl AuditSink for GateCreate {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        Box::pin(async move {
            if entry.action.name == self.action && self.armed.load(Ordering::SeqCst) {
                self.entered.notify_one();
                self.release.notified().await;
            }
            self.log.append(entry).await
        })
    }
}

fn failing_sync(_: &Path) -> std::io::Result<()> {
    Err(std::io::Error::other("injected directory sync failure"))
}

#[derive(Default)]
struct Alerts(Mutex<Vec<InstallAlert>>);
impl AlertSink for Alerts {
    fn alert(&self, alert: &InstallAlert) {
        self.0.lock().unwrap().push(alert.clone());
    }
}

/// A fresh install root for one test, removed when dropped.
struct Root(PathBuf);
impl Root {
    fn new(name: &str) -> Self {
        let path =
            std::env::temp_dir().join(format!("byterygon-tsk27-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        Self(path)
    }
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn active_digest(root: &Path) -> String {
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join(PLUGIN).join("state.json")).unwrap())
            .unwrap();
    state["active"].as_str().unwrap().to_owned()
}

fn grant_store() -> GrantStore {
    GrantStore::new(Arc::new(SystemClock), Arc::new(MemoryAuditLog::new()))
}

fn request(target: &str, template: &str) -> GrantRequest {
    GrantRequest {
        tenant: TenantId::new("t"),
        owner: "tenant:t".into(),
        eligible: Eligibility {
            principals: BTreeSet::from(["human:local:test".to_owned()]),
            roles: BTreeSet::new(),
        },
        connection_id: format!("conn:{target}"),
        target_id: target.into(),
        template_id: template.into(),
        host: "127.0.0.1".into(),
        port: 5432,
        tls: TlsPolicy::Disabled,
        addresses: address_policy(&["127.0.0.1/32"]).unwrap(),
        secret: (template == "db-transport").then(|| SecretBinding {
            template_id: "db-credentials".into(),
            secret_ref: "secret-ref-1".into(),
        }),
        allow_cancel_connection: template == "db-transport",
        expires_at_unix_ms: None,
    }
}

async fn grant(
    store: &GrantStore,
    plugin: &InstalledPlugin,
    target: &str,
    template: &str,
) -> Arc<ConnectionGrant> {
    store
        .create(&Allow, &human(), plugin, request(target, template), "grant")
        .await
        .unwrap()
}

/// Stage `archive` and activate it with a plain package approval.
async fn install(
    installer: &Installer<'_>,
    archive: &[u8],
    hooks: HostHooks<'_>,
) -> Result<plugin_host::install::Activation, InstallError> {
    let stage = installer.stage(archive, &human(), "install").await?;
    let digest = stage.approval_view().package_digest;
    stage
        .activate(&Allow, &human(), Approval::package(digest), hooks)
        .await
}

// ---- Question 37: limits ----

#[test]
fn default_limits_equal_the_previous_constants() {
    let expected = PackageLimits {
        max_archive_bytes: 72 * 1024 * 1024,
        max_entries: 256,
        max_entry_bytes: 32 * 1024 * 1024,
        max_total_bytes: 64 * 1024 * 1024,
        max_metadata_bytes: 1024 * 1024,
        max_manifest_bytes: 64 * 1024,
        max_compression_ratio: 100,
    };
    assert_eq!(PackageLimits::default(), expected);
    assert_eq!(PackageLimitsConfig::default().load(), Ok(expected));
    // An empty configuration section is the defaults; unknown keys are rejected.
    let empty: PackageLimitsConfig = serde_json::from_str("{}").unwrap();
    assert_eq!(empty.load(), Ok(expected));
    assert!(serde_json::from_str::<PackageLimitsConfig>(r#"{"max_entry_byte": 1}"#).is_err());
    assert_eq!(PackageLimits::HARD_CEILING.validate(), Ok(()));
    assert_eq!(PackageLimits::MINIMUM.validate(), Ok(()));
}

#[test]
fn raising_a_limit_admits_a_previously_rejected_package() {
    let publisher = Publisher::new();
    // 4 metadata files + 257 payload entries: over the default of 256 entries.
    let archive = publisher.package("1.0.0", "", 256);
    assert_eq!(
        verify_bytes(
            &archive,
            PackageLimits::default(),
            &publisher.trust(),
            &policy()
        )
        .unwrap_err(),
        PackageError::Limits
    );
    let raised = PackageLimitsConfig {
        max_entries: Some(512),
        ..PackageLimitsConfig::default()
    }
    .load()
    .unwrap();
    let package = verify_bytes(&archive, raised, &publisher.trust(), &policy()).unwrap();
    assert_eq!(package.files().len(), 260);
}

#[test]
fn limits_outside_the_bounds_are_rejected_at_config_load() {
    let ceiling = PackageLimits::HARD_CEILING;
    let config = PackageLimitsConfig {
        max_entry_bytes: Some(ceiling.max_entry_bytes + 1),
        ..PackageLimitsConfig::default()
    };
    assert_eq!(
        config.load(),
        Err(LimitsError::AboveCeiling {
            field: LimitField::EntryBytes,
            value: ceiling.max_entry_bytes + 1,
            ceiling: ceiling.max_entry_bytes,
        })
    );
    for (field, config) in [
        (
            LimitField::ArchiveBytes,
            PackageLimitsConfig {
                max_archive_bytes: Some(u64::MAX),
                ..Default::default()
            },
        ),
        (
            LimitField::Entries,
            PackageLimitsConfig {
                max_entries: Some(ceiling.max_entries + 1),
                ..Default::default()
            },
        ),
        (
            LimitField::TotalBytes,
            PackageLimitsConfig {
                max_total_bytes: Some(ceiling.max_total_bytes + 1),
                ..Default::default()
            },
        ),
        (
            LimitField::MetadataBytes,
            PackageLimitsConfig {
                max_metadata_bytes: Some(ceiling.max_metadata_bytes + 1),
                ..Default::default()
            },
        ),
        (
            LimitField::ManifestBytes,
            PackageLimitsConfig {
                max_manifest_bytes: Some(ceiling.max_manifest_bytes + 1),
                ..Default::default()
            },
        ),
        (
            LimitField::CompressionRatio,
            PackageLimitsConfig {
                max_compression_ratio: Some(ceiling.max_compression_ratio + 1),
                ..Default::default()
            },
        ),
    ] {
        assert!(
            matches!(config.load(), Err(LimitsError::AboveCeiling { field: f, .. }) if f == field),
            "{field:?}"
        );
    }
    // Below the minimum.
    assert_eq!(
        PackageLimitsConfig {
            max_entries: Some(0),
            ..Default::default()
        }
        .load(),
        Err(LimitsError::BelowMinimum {
            field: LimitField::Entries,
            value: 0,
            minimum: PackageLimits::MINIMUM.max_entries as u64,
        })
    );
    // One payload entry may not be larger than the whole package.
    assert_eq!(
        PackageLimitsConfig {
            max_entry_bytes: Some(128 * 1024 * 1024),
            ..Default::default()
        }
        .load(),
        Err(LimitsError::Inconsistent {
            field: LimitField::EntryBytes,
            within: LimitField::TotalBytes,
        })
    );
    // The ceilings themselves are a valid configuration.
    let at_ceiling = PackageLimitsConfig {
        max_archive_bytes: Some(ceiling.max_archive_bytes),
        max_entries: Some(ceiling.max_entries),
        max_entry_bytes: Some(ceiling.max_entry_bytes),
        max_total_bytes: Some(ceiling.max_total_bytes),
        max_metadata_bytes: Some(ceiling.max_metadata_bytes),
        max_manifest_bytes: Some(ceiling.max_manifest_bytes),
        max_compression_ratio: Some(ceiling.max_compression_ratio),
    };
    assert_eq!(at_ceiling.load(), Ok(ceiling));
}

#[test]
fn limits_built_in_code_cannot_exceed_the_ceiling() {
    let publisher = Publisher::new();
    let entries = PackageLimits::HARD_CEILING.max_entries + 1;
    let archive = publisher.package("1.0.0", "", entries - 5);
    let unlimited = PackageLimits {
        max_entries: usize::MAX,
        ..PackageLimits::default()
    };
    assert_eq!(
        verify_bytes(&archive, unlimited, &publisher.trust(), &policy()).unwrap_err(),
        PackageError::Limits
    );
}

// ---- Question 39: grants on upgrade and rollback ----

#[tokio::test]
async fn narrower_upgrade_carries_grants_and_rollback_restores_them() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("narrow");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: None,
        ..HostHooks::default()
    };

    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    // Installation alone creates no runtime grant.
    assert!(v1.upgrade.is_none());
    assert_eq!(v1.grants, Some(Default::default()));
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let replica = grant(&store, &v1.plugin, "pg2", "replica").await;
    assert!(main.allow_cancel_connection && main.secret.is_some());

    let v2 = install(&installer, &publisher.package("2.0.0", NARROW, 0), hooks)
        .await
        .unwrap();
    let upgrade = v2.upgrade.as_ref().unwrap();
    assert_eq!(upgrade.from_digest, v1.plugin.digest.0);
    assert!(!upgrade.permissions.is_widened());
    assert!(
        upgrade
            .permissions
            .narrowed
            .contains(&PermissionDelta::Removed {
                kind: CapabilityKind::Network,
                id: "replica".into(),
            })
    );
    let switch = v2.grants.unwrap();
    // The grant of the removed template is not carried; the other one is, without the cancel
    // connection and the secret the new version no longer requests.
    assert_eq!(switch.dropped, vec![replica.id.clone()]);
    let [(old_id, new_id)] = switch.carried.as_slice() else {
        panic!("expected one carried grant: {switch:?}");
    };
    assert_eq!(old_id, &main.id);
    assert_eq!(switch.narrowed, vec![new_id.clone()]);
    let carried = store.get(new_id).unwrap();
    assert_eq!(carried.plugin.digest, v2.plugin.digest);
    assert!(!carried.allow_cancel_connection);
    assert_eq!(carried.secret, None);
    assert_eq!(
        (
            &carried.host,
            carried.port,
            &carried.tls,
            &carried.addresses
        ),
        (&main.host, main.port, &main.tls, &main.addresses)
    );
    assert_eq!(carried.eligible, main.eligible);
    assert!(store.is_active(new_id));
    assert!(!store.is_active(&main.id) && !store.is_active(&replica.id));
    assert!(!store.is_revoked(&main.id));

    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rollback", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.active_digest, v1.plugin.digest.0);
    assert_eq!(rolled.audit_warning, None);
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
    let switch = rolled.grants.unwrap();
    let restored: BTreeSet<GrantId> = switch.restored.iter().cloned().collect();
    assert_eq!(
        restored,
        BTreeSet::from([main.id.clone(), replica.id.clone()])
    );
    assert_eq!(switch.parked, vec![new_id.clone()]);
    // The previous version's full grant set is back, unchanged; the carried grant is not usable.
    assert!(store.is_active(&main.id) && store.is_active(&replica.id));
    assert!(!store.is_active(new_id));
    assert_eq!(store.get(&main.id).unwrap(), main);
}

#[tokio::test]
async fn revoked_grants_are_not_restored_by_rollback() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("revoked");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: None,
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let carried = v2.grants.unwrap().carried[0].1.clone();
    // Revoking the carried grant revokes the destination, also for the parked version.
    store
        .revoke(&Allow, &human(), &carried, "revoke")
        .await
        .unwrap();
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rollback", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.grants.unwrap().restored, vec![]);
    assert!(!store.is_active(&main.id) && !store.is_active(&carried));
}

#[tokio::test]
async fn widened_upgrade_is_blocked_until_the_widening_is_approved() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("widen");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: None,
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let wide = publisher.package("2.0.0", &format!("{FULL}{WIDE_EXTRA}"), 0);
    let widening = vec![PermissionDelta::Added {
        kind: CapabilityKind::File,
        id: "export".into(),
    }];

    // An approval of the package digest alone does not cover the wider permission set.
    let stage = installer.stage(&wide, &human(), "upgrade").await.unwrap();
    let view = stage.approval_view();
    assert_eq!(view.upgrade.as_ref().unwrap().permissions.widened, widening);
    let refused = stage
        .activate(
            &Allow,
            &human(),
            Approval::package(view.package_digest),
            hooks,
        )
        .await;
    assert!(
        matches!(&refused, Err(InstallError::PermissionsWidened(diff)) if diff.widened == widening),
        "{refused:?}"
    );
    // Neither does an approval naming a different widening, nor the legacy entry point.
    let stage = installer.stage(&wide, &human(), "upgrade").await.unwrap();
    let wrong = Approval {
        package_digest: view.package_digest,
        widened_permissions: vec![PermissionDelta::Added {
            kind: CapabilityKind::File,
            id: "other".into(),
        }],
    };
    assert!(matches!(
        stage.activate(&Allow, &human(), wrong, hooks).await,
        Err(InstallError::PermissionsWidened(_))
    ));
    let stage = installer.stage(&wide, &human(), "upgrade").await.unwrap();
    assert!(matches!(
        stage
            .approve_and_activate(&Allow, &human(), view.package_digest)
            .await,
        Err(InstallError::PermissionsWidened(_))
    ));
    // Nothing changed: the old version and its grant are still active.
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
    assert!(store.is_active(&main.id));
    assert!(
        log.records()
            .iter()
            .all(|r| r.entry.action.name != ACTIVATE || r.entry.input_digest == v1.plugin.digest)
    );

    // A delegated principal cannot give the fresh approval.
    let stage = installer.stage(&wide, &human(), "upgrade").await.unwrap();
    let approval = Approval {
        package_digest: view.package_digest,
        widened_permissions: widening.clone(),
    };
    let mut delegated = human();
    delegated.on_behalf_of = Some(Box::new(human()));
    assert!(matches!(
        stage
            .activate(&Allow, &delegated, approval.clone(), hooks)
            .await,
        Err(InstallError::Denied)
    ));
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));

    // A direct human approval of exactly the widening activates the version.
    let stage = installer.stage(&wide, &human(), "upgrade").await.unwrap();
    let v2 = stage
        .activate(&Allow, &human(), approval, hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&v2.plugin.digest.0));
    let switch = v2.grants.unwrap();
    assert_eq!(switch.carried.len(), 1);
    assert!(switch.narrowed.is_empty() && switch.dropped.is_empty());
    assert!(store.is_active(&switch.carried[0].1) && !store.is_active(&main.id));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_upgrade_and_rollback_keep_grants_consistent() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("race");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: None,
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g1 = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g2 = v2.grants.unwrap().carried[0].1.clone();

    let third = installer
        .stage(&publisher.package("3.0.0", FULL, 0), &human(), "third")
        .await
        .unwrap();
    let d3 = third.approval_view().package_digest;
    let together = MeetAtAuthorization(tokio::sync::Barrier::new(2));
    let (rollback_principal, activation_principal) = (human(), human());
    let (rolled, activated) = tokio::join!(
        installer.rollback_with(&together, &rollback_principal, PLUGIN, "rollback", hooks),
        third.activate(
            &together,
            &activation_principal,
            Approval::package(d3),
            hooks
        )
    );
    let (rolled, activated) = (rolled.unwrap(), activated.unwrap());

    // Whichever took the plugin lock first, the target has exactly one active grant, and it is
    // bound to the version the state file names.
    let mut ids = vec![g1.id.clone(), g2];
    ids.extend(
        activated
            .grants
            .unwrap()
            .carried
            .into_iter()
            .map(|(_, n)| n),
    );
    ids.extend(rolled.grants.unwrap().restored);
    let active: BTreeSet<GrantId> = ids.into_iter().filter(|id| store.is_active(id)).collect();
    assert_eq!(active.len(), 1, "{active:?}");
    let active = store.get(active.first().unwrap()).unwrap();
    assert_eq!(hex(&active.plugin.digest.0), active_digest(&root.0));
    assert_eq!(active.target_id, "pg1");
}

// ---- Question 41: audit failures ----

#[tokio::test]
async fn activation_is_still_refused_when_audit_fails() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(ACTIVATE, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("activate-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let hooks = HostHooks {
        grants: None,
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let result = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks).await;
    assert!(matches!(result, Err(InstallError::Audit(_))), "{result:?}");
    assert!(!root.0.join(PLUGIN).join("state.json").exists());
    // The approval was recorded, and ends with an error because nothing was activated.
    assert_eq!(
        steps(&log.1.entries(), "install"),
        [
            (APPROVE.to_owned(), Outcome::Started),
            (APPROVE.to_owned(), unavailable()),
        ]
    );
    // Both entries reached the primary sink, so the fallback was not used.
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
}

/// Two installed versions, with a primary audit sink that fails every rollback entry.
async fn two_versions(installer: &Installer<'_>, publisher: &Publisher) -> ([u8; 32], [u8; 32]) {
    let v1 = install(
        installer,
        &publisher.package("1.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    let v2 = install(
        installer,
        &publisher.package("2.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    (v1.plugin.digest.0, v2.plugin.digest.0)
}

#[tokio::test]
async fn rollback_proceeds_with_fallback_audit_when_the_primary_sink_fails() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(ROLLBACK, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("rollback-fallback");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let (d1, d2) = two_versions(&installer, &publisher).await;
    assert_eq!(active_digest(&root.0), hex(&d2));
    let hooks = HostHooks {
        grants: None,
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb-1", hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&d1));

    let fallback = root.0.join(FALLBACK_AUDIT_FILE);
    let warning = rolled.audit_warning.unwrap();
    assert_eq!(
        warning,
        AuditWarning::PrimaryFailed {
            primary: AuditError("primary sink down".into()),
            fallback: fallback.clone(),
        }
    );
    assert_eq!(rolled.outcome_audit_warning, Some(warning.clone()));
    // One alert for the decision entry and one for the outcome entry.
    let alert = InstallAlert::RollbackAuditFallback {
        plugin_id: PLUGIN.into(),
        correlation_id: "rb-1".into(),
        warning,
    };
    assert_eq!(*alerts.0.lock().unwrap(), vec![alert.clone(), alert]);
    // The fallback file holds the entry the primary sink refused, in the shared audit format.
    let text = std::fs::read_to_string(&fallback).unwrap();
    let entries: Vec<AuditEntry> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert_eq!(entry.action.name, ROLLBACK);
        assert_eq!(entry.correlation_id, "rb-1");
        assert_eq!(entry.input_digest.0, d1);
    }
    assert_eq!(entries[0].outcome, Outcome::Started);
    assert_eq!(entries[1].outcome, Outcome::Success);
    assert!(
        log.1
            .records()
            .iter()
            .all(|r| r.entry.action.name != ROLLBACK)
    );

    // The file is append-only: a second rollback adds a line and keeps the first.
    installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb-2", hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&d2));
    let text = std::fs::read_to_string(&fallback).unwrap();
    let ids: Vec<String> = text
        .lines()
        .map(|l| {
            serde_json::from_str::<AuditEntry>(l)
                .unwrap()
                .correlation_id
        })
        .collect();
    assert_eq!(ids, ["rb-1", "rb-1", "rb-2", "rb-2"]);
    assert_eq!(alerts.0.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn rollback_proceeds_when_both_audit_sinks_fail() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(ROLLBACK, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("rollback-both");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let (d1, _) = two_versions(&installer, &publisher).await;
    // A directory where the fallback file should be makes the fallback write fail.
    std::fs::create_dir(root.0.join(FALLBACK_AUDIT_FILE)).unwrap();
    let hooks = HostHooks {
        grants: None,
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&d1));
    let warning = rolled.audit_warning.unwrap();
    assert!(
        matches!(&warning, AuditWarning::BothFailed { primary, .. }
            if *primary == AuditError("primary sink down".into())),
        "{warning:?}"
    );
    assert!(matches!(
        rolled.outcome_audit_warning,
        Some(AuditWarning::BothFailed { .. })
    ));
    let alert = InstallAlert::RollbackAuditFallback {
        plugin_id: PLUGIN.into(),
        correlation_id: "rb".into(),
        warning,
    };
    assert_eq!(*alerts.0.lock().unwrap(), vec![alert.clone(), alert]);
}

#[tokio::test]
async fn rollback_without_audit_failure_has_no_warning_and_no_fallback_file() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("rollback-clean");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    two_versions(&installer, &publisher).await;
    let hooks = HostHooks {
        grants: None,
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.audit_warning, None);
    assert_eq!(rolled.outcome_audit_warning, None);
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
    assert!(
        log.records()
            .iter()
            .any(|r| r.entry.action.name == ROLLBACK)
    );
}

// ---- Review of PR #21 ----

/// Stage `archive` and activate it with the widening it shows approved, as a human would.
async fn upgrade_approved(
    installer: &Installer<'_>,
    archive: &[u8],
    hooks: HostHooks<'_>,
) -> Result<plugin_host::install::Activation, InstallError> {
    let stage = installer.stage(archive, &human(), "upgrade").await?;
    let view = stage.approval_view();
    let widened = view
        .upgrade
        .map(|u| u.permissions.widened)
        .unwrap_or_default();
    let approval = Approval {
        package_digest: view.package_digest,
        widened_permissions: widened,
    };
    stage.activate(&Allow, &human(), approval, hooks).await
}

fn with_needs_credential(capabilities: &str) -> String {
    capabilities.replace(
        "scope = \"connection\"",
        "scope = \"connection\"\nneeds_credential = true",
    )
}

#[tokio::test]
async fn secret_is_not_carried_when_its_purpose_changes() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("secret-purpose");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let replica = grant(&store, &v1.plugin, "pg2", "replica").await;
    let repurposed = FULL.replace("database-auth", "backup-auth");
    let v2 = upgrade_approved(
        &installer,
        &publisher.package("2.0.0", &repurposed, 0),
        hooks,
    )
    .await
    .unwrap();
    assert!(v2.upgrade.as_ref().unwrap().permissions.is_widened());
    let switch = v2.grants.unwrap();
    // The approver chose the secret for the old purpose, so that grant is not carried and needs
    // a new approval; a grant without a secret is carried as before.
    assert_eq!(switch.dropped, vec![main.id.clone()]);
    assert_eq!(switch.carried.len(), 1);
    assert_eq!(switch.carried[0].0, replica.id);
    assert!(!store.is_active(&main.id));
    // The target is free: the approver can create the grant again, with a secret chosen for the
    // new purpose.
    store
        .create(
            &Allow,
            &human(),
            &v2.plugin,
            request("pg1", "db-transport"),
            "new",
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn credential_requirement_changes_decide_whether_the_secret_is_carried() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("secret-needs");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    // The old version needs a credential, the new one no longer does: narrower, so the grant is
    // carried, without the secret binding.
    let needs = with_needs_credential(FULL);
    let v1 = install(&installer, &publisher.package("1.0.0", &needs, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let v2 = upgrade_approved(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    assert!(!v2.upgrade.as_ref().unwrap().permissions.is_widened());
    let switch = v2.grants.unwrap();
    let [(old, new)] = switch.carried.as_slice() else {
        panic!("{switch:?}");
    };
    assert_eq!(old, &main.id);
    assert_eq!(store.get(new).unwrap().secret, None);
    assert_eq!(switch.narrowed, vec![new.clone()]);
}

#[tokio::test]
async fn secret_is_not_carried_when_the_new_version_starts_to_need_a_credential() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("secret-starts-needing");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    assert!(main.secret.is_some());
    // Wider: the secret was chosen when no credential was needed, so the grant needs a new
    // approval with a secret chosen for the new requirement.
    let needs = with_needs_credential(FULL);
    let v2 = upgrade_approved(&installer, &publisher.package("2.0.0", &needs, 0), hooks)
        .await
        .unwrap();
    assert!(v2.upgrade.as_ref().unwrap().permissions.is_widened());
    let switch = v2.grants.unwrap();
    assert_eq!(switch.carried, vec![]);
    assert_eq!(switch.dropped, vec![main.id.clone()]);
    assert!(!store.is_active(&main.id));
}

#[tokio::test]
async fn denied_rollback_is_audited_fail_closed() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(ROLLBACK, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("rollback-denied");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let (_, d2) = two_versions(&installer, &publisher).await;
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    // The refusal cannot be recorded, so it is reported as an audit failure; nothing changes and
    // the fallback is not used for a rollback that is not performed.
    let result = installer
        .rollback_with(&Deny, &human(), PLUGIN, "rb", hooks)
        .await;
    assert!(matches!(result, Err(InstallError::Audit(_))), "{result:?}");
    assert_eq!(active_digest(&root.0), hex(&d2));
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
    // With a working sink the same refusal is a plain denial, and it is audited.
    let healthy = MemoryAuditLog::new();
    let installer = Installer {
        audit: &healthy,
        ..installer
    };
    let result = installer
        .rollback_with(&Deny, &human(), PLUGIN, "rb", hooks)
        .await;
    assert!(matches!(result, Err(InstallError::Denied)), "{result:?}");
    assert!(healthy.records().iter().any(|r| {
        r.entry.action.name == ROLLBACK && matches!(r.entry.outcome, Outcome::Error { .. })
    }));
}

#[tokio::test]
async fn revoking_an_earlier_id_revokes_the_grant_carried_from_it() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("revoke-lineage");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g1 = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let o1 = grant(&store, &v1.plugin, "pg2", "replica").await;
    let carried = |switch: &plugin_host::GrantSwitch, from: &GrantId| {
        switch
            .carried
            .iter()
            .find(|(old, _)| old == from)
            .map(|(_, new)| new.clone())
            .unwrap()
    };
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let switch2 = v2.grants.unwrap();
    let (g2, o2) = (carried(&switch2, &g1.id), carried(&switch2, &o1.id));
    let v3 = install(&installer, &publisher.package("3.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let switch3 = v3.grants.unwrap();
    let (g3, o3) = (carried(&switch3, &g2), carried(&switch3, &o2));
    assert!(store.is_active(&g3) && store.is_active(&o3));
    assert!(!store.is_active(&g1.id));
    // Revoking the id the approver first knew revokes the grant now in use, two upgrades later.
    store
        .revoke(&Allow, &human(), &g1.id, "revoke")
        .await
        .unwrap();
    store.flush_audit().await;
    assert!(!store.is_active(&g3) && store.is_revoked(&g3));
    // A grant of another target is untouched.
    assert!(store.is_active(&o3));
    // And a rollback does not bring the revoked destination back, only the other one.
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.grants.unwrap().restored, vec![o2.clone()]);
    assert!(!store.is_active(&g2) && !store.is_active(&g1.id));
}

#[tokio::test]
async fn unreadable_active_manifest_does_not_block_a_fixed_version() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("broken-manifest");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g1 = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    // Damage the installed copy of the running version's manifest.
    let manifest = root
        .0
        .join(PLUGIN)
        .join("versions")
        .join(hex(&v1.plugin.digest.0))
        .join("plugin.toml");
    std::fs::write(&manifest, b"\0 not a manifest").unwrap();
    // Staging and activating the patched version still work.
    let stage = installer
        .stage(&publisher.package("1.0.1", FULL, 0), &human(), "patch")
        .await
        .unwrap();
    let view = stage.approval_view();
    assert!(view.upgrade.is_none());
    let v2 = stage
        .activate(
            &Allow,
            &human(),
            Approval::package(view.package_digest),
            hooks,
        )
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&v2.plugin.digest.0));
    assert_eq!(v2.warnings, vec![SwitchWarning::PreviousManifestUnreadable]);
    // Nothing is carried without a comparison; the old grant stays parked.
    let switch = v2.grants.unwrap();
    assert_eq!(switch.carried, vec![]);
    assert_eq!(switch.dropped, vec![g1.id.clone()]);
    assert!(!store.is_active(&g1.id));
    // A rollback restores it.
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.grants.unwrap().restored, vec![g1.id.clone()]);
    assert!(store.is_active(&g1.id));
}

#[tokio::test]
async fn directory_sync_failure_after_the_rename_still_returns_the_result() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("sync-failure");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let alerts = Alerts::default();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let failing = HostHooks {
        directory_sync: Some(failing_sync),
        ..hooks
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g1 = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    // The state file is renamed before the failing sync, so the new version is active and the
    // grants follow it; the caller gets the result and a warning, not an error.
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), failing)
        .await
        .unwrap();
    assert_eq!(v2.warnings, vec![SwitchWarning::DirectorySyncFailed]);
    // The warning is also observable by the host, even if the caller ignores the result.
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::SwitchSyncFailed {
            plugin_id: PLUGIN.into(),
            correlation_id: "install".into(),
        }]
    );
    assert_eq!(active_digest(&root.0), hex(&v2.plugin.digest.0));
    let switch = v2.grants.unwrap();
    let [(old, new)] = switch.carried.as_slice() else {
        panic!("{switch:?}");
    };
    assert_eq!(old, &g1.id);
    assert!(store.is_active(new) && !store.is_active(&g1.id));
    // The same for a rollback.
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", failing)
        .await
        .unwrap();
    assert_eq!(rolled.warnings, vec![SwitchWarning::DirectorySyncFailed]);
    assert_eq!(alerts.0.lock().unwrap().len(), 2);
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
    assert_eq!(rolled.grants.unwrap().restored, vec![g1.id.clone()]);
    assert!(store.is_active(&g1.id) && !store.is_active(new));
}

#[tokio::test]
async fn refused_widening_leaves_no_approval_entry_and_no_stage() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("widen-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let wide = format!("{FULL}{WIDE_EXTRA}");
    install(
        &installer,
        &publisher.package("1.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    upgrade_approved(
        &installer,
        &publisher.package("2.0.0", &wide, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    // Staged while the wide version is active, so at staging it does not widen anything.
    let stage = installer
        .stage(&publisher.package("3.0.0", &wide, 0), &human(), "late")
        .await
        .unwrap();
    let view = stage.approval_view();
    assert!(!view.upgrade.as_ref().unwrap().permissions.is_widened());
    // Then the plugin is rolled back to the narrow version, so activating it now widens.
    installer
        .rollback(&Allow, &human(), PLUGIN, "rb")
        .await
        .unwrap();
    let refused = stage
        .activate(
            &Allow,
            &human(),
            Approval::package(view.package_digest),
            HostHooks::default(),
        )
        .await;
    assert!(
        matches!(refused, Err(InstallError::PermissionsWidened(_))),
        "{refused:?}"
    );
    let records = log.records();
    let for_package = |action: &str| {
        records
            .iter()
            .filter(|r| {
                r.entry.action.name == action && r.entry.input_digest.0 == view.package_digest
            })
            .count()
    };
    assert_eq!(for_package("plugin-host.packages.approve"), 0);
    assert_eq!(for_package(ACTIVATE), 0);
    assert!(records.iter().any(|r| {
        r.entry.input_digest.0 == view.package_digest
            && matches!(&r.entry.outcome, Outcome::Error { code } if code == "PermissionsWidened")
    }));
    // The stage directory is removed with the refused install.
    assert!(
        !std::fs::read_dir(&root.0)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
    );
}

#[tokio::test]
async fn rollback_reports_whether_the_parked_grants_were_found() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("restore-outcome");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    assert_eq!(v2.grants.unwrap().restore, RestoreOutcome::NotARollback);
    // After a restart the in-memory grant state is gone: a new store has nothing parked, and the
    // rollback says so instead of returning an empty result that looks like "nothing to restore".
    let restarted = grant_store();
    let after_restart = HostHooks {
        grants: Some(&restarted),
        ..HostHooks::default()
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", after_restart)
        .await
        .unwrap();
    let switch = rolled.grants.unwrap();
    assert_eq!(switch.restore, RestoreOutcome::NoParkedState);
    assert!(switch.restored.is_empty());
    // A version that simply had no grants is found, with an empty set.
    let fresh = grant_store();
    let hooks = HostHooks {
        grants: Some(&fresh),
        ..HostHooks::default()
    };
    install(&installer, &publisher.package("3.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    install(&installer, &publisher.package("4.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb2", hooks)
        .await
        .unwrap();
    let switch = rolled.grants.unwrap();
    assert_eq!(switch.restore, RestoreOutcome::Restored);
    assert!(switch.restored.is_empty());
}

#[tokio::test]
async fn create_racing_a_rollback_does_not_take_a_target_twice() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("create-race");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let gate = Arc::new(GateCreate {
        action: "plugin-host.grants.create",
        log: MemoryAuditLog::new(),
        armed: AtomicBool::new(false),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let store = GrantStore::new(Arc::new(SystemClock), gate.clone());
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let g1 = grant(&store, &v1.plugin, "pgR", "replica").await;
    // The narrow version drops the `replica` template, so g1 is parked and its target is free.
    let v2 = install(&installer, &publisher.package("2.0.0", NARROW, 0), hooks)
        .await
        .unwrap();
    assert!(!store.is_active(&g1.id));
    gate.armed.store(true, Ordering::SeqCst);
    let mut req = request("pgR", "db-transport");
    req.secret = None;
    req.allow_cancel_connection = false;
    let approver = human();
    let create = store.create(&Allow, &approver, &v2.plugin, req, "create");
    // The create has passed its target check and waits for the sink while holding the target.
    // The rollback wants the same target for the restored grant, so it waits for the create's
    // lock; the sink is released shortly after.
    let orchestrate = async {
        gate.entered.notified().await;
        let actor = human();
        let rollback = installer.rollback_with(&Allow, &actor, PLUGIN, "rb", hooks);
        let release = async {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            gate.armed.store(false, Ordering::SeqCst);
            gate.release.notify_one();
        };
        let (rolled, ()) = tokio::join!(rollback, release);
        rolled
    };
    let (created, rolled) = tokio::join!(create, orchestrate);
    // One of them got the target, and only one: the create finished first, so the restored
    // grant finds the target taken and is reported as not restored.
    let created = created.unwrap();
    let switch = rolled.unwrap().grants.unwrap();
    assert_eq!(switch.restored, vec![]);
    assert_eq!(switch.not_restored, vec![g1.id.clone()]);
    assert!(store.is_active(&created.id) && !store.is_active(&g1.id));
}

#[test]
fn entry_buffers_are_reserved_at_their_checked_size() {
    let publisher = Publisher::new();
    // 3,000,000 bytes is not a power of two, so growth by doubling would leave spare capacity.
    let payload: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
    let archive = publisher.package_with("1.0.0", "", 0, payload);
    let package = verify_bytes(
        &archive,
        PackageLimits::default(),
        &publisher.trust(),
        &policy(),
    )
    .unwrap();
    for (name, bytes) in package.files() {
        assert_eq!(bytes.capacity(), bytes.len(), "{name}");
    }
}

// ---- Question 42: audit of grant carry-over and restore ----

fn entries_of(log: &MemoryAuditLog, action: &str) -> Vec<AuditEntry> {
    log.records()
        .into_iter()
        .map(|r| r.entry)
        .filter(|e| e.action.name == action)
        .collect()
}

const FAR_FUTURE_MS: u64 = 4_102_444_800_000; // 2100-01-01

/// A grant on `target` that expires in the year 2100, so the expiry is part of what is recorded.
async fn expiring_grant(
    store: &GrantStore,
    plugin: &InstalledPlugin,
    target: &str,
    template: &str,
) -> Arc<ConnectionGrant> {
    let mut req = request(target, template);
    req.expires_at_unix_ms = Some(FAR_FUTURE_MS);
    store
        .create(&Allow, &human(), plugin, req, "grant")
        .await
        .unwrap()
}

#[tokio::test]
async fn carry_over_writes_one_audit_entry_per_grant() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("carry-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = expiring_grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let replica = grant(&store, &v1.plugin, "pg2", "replica").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let switch = v2.grants.unwrap();
    assert_eq!(switch.carried.len(), 2);
    assert!(switch.audit_failed.is_empty() && v2.warnings.is_empty());

    let entries = entries_of(&log, CARRY_GRANT_ACTION);
    assert_eq!(entries.len(), 2, "one entry per carried grant");
    let mut digests = Vec::new();
    for (old_id, new_id) in &switch.carried {
        let (old, new) = (store.get(old_id).unwrap(), store.get(new_id).unwrap());
        let entry = entries
            .iter()
            .find(|e| e.approval_id.as_deref() == Some(&format!("{old_id}>{new_id}")))
            .unwrap_or_else(|| panic!("no entry for {old_id} -> {new_id}"));
        // What the entry shows: who, on what, under which action.
        assert_eq!(entry.action.perm.as_str(), "admin.plugins.install");
        assert_eq!(entry.target, Some(TargetRef::connection(&new.target_id)));
        assert_eq!(entry.tenant, new.tenant);
        assert_eq!(entry.decision, security_types::AuditDecision::Allow);
        assert_eq!(entry.outcome, Outcome::Success);
        assert_eq!(entry.correlation_id, "install");
        assert_eq!(
            entry.principal_chain[0].id,
            format!("plugin:{PLUGIN}#sha256:{}", v2.plugin.digest)
        );
        assert_eq!(entry.principal_chain[0].kind, PrincipalKind::Plugin);
        assert_eq!(entry.principal_chain[1].id, human().id);
        // What it commits to: versions, both grant ids, the original approver and the expiry.
        let record = GrantSwitchRecord {
            plugin_id: PLUGIN,
            from_digest: v1.plugin.digest,
            from_version: "1.0.0",
            to_digest: v2.plugin.digest,
            to_version: "2.0.0",
            old: &old,
            new: &new,
        };
        let expected = grant_switch_digest(GRANT_CARRY_DIGEST_DOMAIN, &record);
        assert_eq!(entry.input_digest, expected);
        assert_ne!(
            grant_switch_digest(GRANT_RESTORE_DIGEST_DOMAIN, &record),
            expected,
            "the domains differ"
        );
        for changed in [
            GrantSwitchRecord {
                to_version: "2.0.1",
                ..record
            },
            GrantSwitchRecord {
                from_digest: v2.plugin.digest,
                ..record
            },
            GrantSwitchRecord {
                old: &new,
                ..record
            },
        ] {
            assert_ne!(
                grant_switch_digest(GRANT_CARRY_DIGEST_DOMAIN, &changed),
                expected
            );
        }
        // The same values, readable (TSK-35): everything the digest covers that the entry does
        // not show elsewhere, and nothing of the secret but whether a binding was kept.
        let detail = entry
            .detail
            .as_ref()
            .expect("a carry-over entry has detail");
        assert_eq!(entry.detail, grant_switch_detail(&record));
        let mut want = vec![
            ("approver", new.approver.id.clone()),
            ("approver_session", new.approver.session.as_str().to_owned()),
            ("cancel_connection", new.allow_cancel_connection.to_string()),
            ("connection", new.connection_id.clone()),
            ("from_digest", format!("sha256:{}", v1.plugin.digest)),
            ("from_version", "1.0.0".to_owned()),
            ("new_grant", new_id.to_string()),
            ("old_grant", old_id.to_string()),
            ("secret_binding", new.secret.is_some().to_string()),
            ("to_version", "2.0.0".to_owned()),
        ];
        if let Some(t) = new.expires_at_unix_ms {
            want.insert(4, ("expires_at_unix_ms", t.to_string()));
        }
        let got: Vec<_> = detail.iter().map(|(k, v)| (k, v.to_owned())).collect();
        assert_eq!(got, want);
        assert!(!format!("{detail:?}").contains("secret-ref-1"));
        digests.push(entry.input_digest.0);
    }
    assert_ne!(digests[0], digests[1]);
    // A carried grant keeps its approver and its expiry, which the digest commits to.
    let carried_main = store
        .get(
            &switch
                .carried
                .iter()
                .find(|(o, _)| *o == main.id)
                .unwrap()
                .1,
        )
        .unwrap();
    assert_eq!(carried_main.expires_at_unix_ms, Some(FAR_FUTURE_MS));
    assert_eq!(carried_main.approver, main.approver);
    assert_ne!(main.id, replica.id);
}

#[tokio::test]
async fn restore_writes_one_audit_entry_per_grant() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("restore-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = expiring_grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let replica = grant(&store, &v1.plugin, "pg2", "replica").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    assert!(entries_of(&log, RESTORE_GRANT_ACTION).is_empty());
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.audit_warning, None);
    assert!(rolled.restore_audit_warnings.is_empty());
    let switch = rolled.grants.unwrap();
    assert_eq!(switch.restored.len(), 2);

    let entries = entries_of(&log, RESTORE_GRANT_ACTION);
    assert_eq!(entries.len(), 2, "one entry per restored grant");
    for grant in [&main, &replica] {
        let entry = entries
            .iter()
            .find(|e| e.approval_id.as_deref() == Some(grant.id.as_str()))
            .unwrap_or_else(|| panic!("no entry for {}", grant.id));
        assert_eq!(entry.target, Some(TargetRef::connection(&grant.target_id)));
        assert_eq!(entry.correlation_id, "rb");
        assert_eq!(entry.outcome, Outcome::Success);
        // The plugin shown is the version that is active again.
        assert_eq!(
            entry.principal_chain[0].id,
            format!("plugin:{PLUGIN}#sha256:{}", v1.plugin.digest)
        );
        let record = GrantSwitchRecord {
            plugin_id: PLUGIN,
            from_digest: v2.plugin.digest,
            from_version: "2.0.0",
            to_digest: v1.plugin.digest,
            to_version: "1.0.0",
            old: grant,
            new: grant,
        };
        assert_eq!(
            entry.input_digest,
            grant_switch_digest(GRANT_RESTORE_DIGEST_DOMAIN, &record)
        );
        // Readable too (TSK-35); a restore keeps the grant, so both ids are the same.
        let detail = entry.detail.as_ref().expect("a restore entry has detail");
        assert_eq!(entry.detail, grant_switch_detail(&record));
        assert_eq!(detail.get("from_version"), Some("2.0.0"));
        assert_eq!(detail.get("to_version"), Some("1.0.0"));
        assert_eq!(detail.get("old_grant"), Some(grant.id.as_str()));
        assert_eq!(detail.get("new_grant"), Some(grant.id.as_str()));
        assert_eq!(
            detail.get("from_digest"),
            Some(format!("sha256:{}", v2.plugin.digest).as_str())
        );
    }
    // The restored grants are the originals, with their approver and expiry.
    assert_eq!(
        store.get(&main.id).unwrap().expires_at_unix_ms,
        Some(FAR_FUTURE_MS)
    );
    assert!(store.is_active(&main.id) && store.is_active(&replica.id));
}

#[tokio::test]
async fn carry_over_fails_closed_when_its_audit_entry_cannot_be_written() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(CARRY_GRANT_ACTION, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("carry-fail-closed");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    let v2 = install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    // The version switch itself, already audited, stands; the grant does not take effect.
    assert_eq!(active_digest(&root.0), hex(&v2.plugin.digest.0));
    let switch = v2.grants.unwrap();
    assert_eq!(switch.carried, vec![]);
    assert_eq!(
        switch.audit_failed,
        vec![(main.id.clone(), AuditError("primary sink down".into()))]
    );
    assert!(
        v2.warnings
            .contains(&SwitchWarning::GrantsNotCarriedAuditFailed)
    );
    assert!(!store.is_active(&main.id) && !store.is_revoked(&main.id));
    // Fail closed means no fallback entry and no alert for a carry-over (that is for rollback).
    assert!(entries_of(&log.1, CARRY_GRANT_ACTION).is_empty());
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
    // Nothing is lost: the grant stays parked and a rollback restores it.
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.grants.unwrap().restored, vec![main.id.clone()]);
    assert!(store.is_active(&main.id));
}

#[tokio::test]
async fn restore_proceeds_with_fallback_audit_when_the_primary_sink_fails() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(RESTORE_GRANT_ACTION, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("restore-fallback");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    // The rollback and the restore go ahead.
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
    assert_eq!(rolled.grants.unwrap().restored, vec![main.id.clone()]);
    assert!(store.is_active(&main.id));
    // The rollback's own entry reached the primary sink; the restore's went to the fallback.
    assert_eq!(rolled.audit_warning, None);
    let fallback = root.0.join(FALLBACK_AUDIT_FILE);
    let warning = AuditWarning::PrimaryFailed {
        primary: AuditError("primary sink down".into()),
        fallback: fallback.clone(),
    };
    assert_eq!(rolled.restore_audit_warnings, vec![warning.clone()]);
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::RollbackAuditFallback {
            plugin_id: PLUGIN.into(),
            correlation_id: "rb".into(),
            warning,
        }]
    );
    let written: Vec<AuditEntry> = std::fs::read_to_string(&fallback)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(written.len(), 1);
    assert_eq!(written[0].action.name, RESTORE_GRANT_ACTION);
    assert_eq!(written[0].approval_id.as_deref(), Some(main.id.as_str()));
    assert_eq!(written[0].target, Some(TargetRef::connection("pg1")));
    assert!(entries_of(&log.1, RESTORE_GRANT_ACTION).is_empty());
    // The rollback's decision and outcome entries.
    assert_eq!(entries_of(&log.1, ROLLBACK).len(), 2);
}

#[tokio::test]
async fn restore_proceeds_when_both_audit_sinks_fail() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(RESTORE_GRANT_ACTION, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("restore-both");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    install(&installer, &publisher.package("2.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    // A directory where the fallback file should be makes the fallback write fail too.
    std::fs::create_dir(root.0.join(FALLBACK_AUDIT_FILE)).unwrap();
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.grants.unwrap().restored, vec![main.id.clone()]);
    assert!(store.is_active(&main.id));
    let [warning] = rolled.restore_audit_warnings.as_slice() else {
        panic!("{:?}", rolled.restore_audit_warnings);
    };
    assert!(
        matches!(warning, AuditWarning::BothFailed { primary, .. }
            if *primary == AuditError("primary sink down".into())),
        "{warning:?}"
    );
    assert_eq!(alerts.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn revoking_while_the_entry_is_written_keeps_the_grant_inactive() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let gate = Arc::new(GateCreate {
        action: CARRY_GRANT_ACTION,
        log: MemoryAuditLog::new(),
        armed: AtomicBool::new(false),
        entered: tokio::sync::Notify::new(),
        release: tokio::sync::Notify::new(),
    });
    let root = Root::new("revoke-pending");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &*gate,
        clock: &SystemClock,
    };
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        ..HostHooks::default()
    };
    let v1 = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    let main = grant(&store, &v1.plugin, "pg1", "db-transport").await;
    gate.armed.store(true, Ordering::SeqCst);
    let archive = publisher.package("2.0.0", FULL, 0);
    let upgrade = install(&installer, &archive, hooks);
    let revoke = async {
        // The carry-over's entry is being written; the administrator revokes the original grant.
        gate.entered.notified().await;
        store
            .revoke(&Allow, &human(), &main.id, "revoke")
            .await
            .unwrap();
        gate.armed.store(false, Ordering::SeqCst);
        gate.release.notify_one();
    };
    let (activated, ()) = tokio::join!(upgrade, revoke);
    let switch = activated.unwrap().grants.unwrap();
    // The revocation wins: the carried grant never becomes active.
    assert_eq!(switch.carried, vec![]);
    assert_eq!(switch.dropped, vec![main.id.clone()]);
    assert!(store.is_revoked(&main.id));
    let mut req = request("pg1", "db-transport");
    req.secret = None;
    let v2_plugin = InstalledPlugin::from_manifest(
        &plugin_host::Manifest::from_toml(&format!("{HEADER}version = \"2.0.0\"\n{FULL}")).unwrap(),
        v1.plugin.digest,
    );
    // The target is free again.
    store
        .create(&Allow, &human(), &v2_plugin, req, "again")
        .await
        .unwrap();
}

// ---- TSK-29: decision before, outcome after ----

/// Fails the entries the predicate picks; records the rest.
struct FailWhen(fn(&AuditEntry) -> bool, MemoryAuditLog);
impl AuditSink for FailWhen {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if (self.0)(&entry) {
            Box::pin(async { Err(AuditError("primary sink down".into())) })
        } else {
            self.1.append(entry)
        }
    }
}

fn io_error() -> Outcome {
    Outcome::Error { code: "Io".into() }
}

fn unavailable() -> Outcome {
    Outcome::Error {
        code: "Unavailable".into(),
    }
}

/// The approve, activate and rollback entries written under `correlation`, in order.
fn steps(entries: &[AuditEntry], correlation: &str) -> Vec<(String, Outcome)> {
    entries
        .iter()
        .filter(|e| {
            e.correlation_id == correlation
                && [APPROVE, ACTIVATE, ROLLBACK].contains(&e.action.name.as_str())
        })
        .map(|e| (e.action.name.clone(), e.outcome.clone()))
        .collect()
}

fn fail_move(step: SwitchStep) -> std::io::Result<()> {
    match step {
        SwitchStep::MoveVersion => Err(std::io::Error::other("injected move failure")),
        _ => Ok(()),
    }
}

fn fail_commit(step: SwitchStep) -> std::io::Result<()> {
    match step {
        SwitchStep::CommitState => Err(std::io::Error::other("injected commit failure")),
        _ => Ok(()),
    }
}

fn read_fallback(root: &Path) -> Vec<AuditEntry> {
    std::fs::read_to_string(root.join(FALLBACK_AUDIT_FILE))
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn version_dirs(root: &Path) -> usize {
    std::fs::read_dir(root.join(PLUGIN).join("versions"))
        .map(|d| d.count())
        .unwrap_or(0)
}

#[tokio::test]
async fn activation_and_rollback_record_the_decision_before_and_the_outcome_after() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("outcome-order");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let activated = install(
        &installer,
        &publisher.package("1.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    assert!(activated.outcome_audit_warnings.is_empty());
    let entries = log.entries();
    assert_eq!(
        steps(&entries, "install"),
        [
            (APPROVE.to_owned(), Outcome::Started),
            (ACTIVATE.to_owned(), Outcome::Started),
            (ACTIVATE.to_owned(), Outcome::Success),
            (APPROVE.to_owned(), Outcome::Success),
        ]
    );
    // A decision entry is an admission; an outcome entry is a completion with a duration.
    for entry in entries
        .iter()
        .filter(|e| [APPROVE, ACTIVATE].contains(&e.action.name.as_str()))
    {
        let outcome = entry.outcome != Outcome::Started;
        assert_eq!(entry.delivery, outcome.then_some(Delivery::Delivered));
        assert_eq!(entry.duration_ms.is_some(), outcome);
        assert_eq!(entry.input_digest, activated.plugin.digest);
    }
    assert!(security_types::unfinished(&entries).is_empty());

    install(
        &installer,
        &publisher.package("2.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    let rolled = installer
        .rollback(&Allow, &human(), PLUGIN, "rb")
        .await
        .unwrap();
    assert_eq!(rolled.outcome_audit_warning, None);
    let entries = log.entries();
    assert_eq!(
        steps(&entries, "rb"),
        [
            (ROLLBACK.to_owned(), Outcome::Started),
            (ROLLBACK.to_owned(), Outcome::Success),
        ]
    );
    let outcome = entries.last().unwrap();
    assert_eq!(outcome.delivery, Some(Delivery::Delivered));
    assert!(outcome.duration_ms.is_some());
    assert!(security_types::unfinished(&entries).is_empty());
}

#[tokio::test]
async fn failed_activation_leaves_error_entries_at_each_step() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("outcome-activate-fails");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let v1 = install(
        &installer,
        &publisher.package("1.0.0", FULL, 0),
        HostHooks::default(),
    )
    .await
    .unwrap();
    let failed = [
        (APPROVE.to_owned(), Outcome::Started),
        (ACTIVATE.to_owned(), Outcome::Started),
        (ACTIVATE.to_owned(), io_error()),
        (APPROVE.to_owned(), io_error()),
    ];
    let v2 = publisher.package("2.0.0", FULL, 0);

    // The staged files cannot be moved, then the state file cannot be replaced.
    for (correlation, fault) in [
        ("move", fail_move as fn(SwitchStep) -> _),
        ("commit", fail_commit),
    ] {
        let stage = installer.stage(&v2, &human(), correlation).await.unwrap();
        let digest = stage.approval_view().package_digest;
        let hooks = HostHooks {
            fault: Some(fault),
            ..HostHooks::default()
        };
        let result = stage
            .activate(&Allow, &human(), Approval::package(digest), hooks)
            .await;
        assert!(matches!(result, Err(InstallError::Io)), "{result:?}");
        assert_eq!(steps(&log.entries(), correlation), failed, "{correlation}");
        // The previous version is still active and the failed one left nothing behind.
        assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
        assert_eq!(version_dirs(&root.0), 1, "{correlation}");
    }

    // The version directory already exists.
    let stage = installer.stage(&v2, &human(), "exists").await.unwrap();
    let digest = stage.approval_view().package_digest;
    let taken = root.0.join(PLUGIN).join("versions").join(hex(&digest));
    std::fs::create_dir(&taken).unwrap();
    let result = stage
        .activate(
            &Allow,
            &human(),
            Approval::package(digest),
            HostHooks::default(),
        )
        .await;
    assert!(matches!(result, Err(InstallError::Io)), "{result:?}");
    assert_eq!(steps(&log.entries(), "exists"), failed);
    assert_eq!(active_digest(&root.0), hex(&v1.plugin.digest.0));
    std::fs::remove_dir(&taken).unwrap();

    // Nothing above was logged as a success, and the same package still installs afterwards.
    let entries = log.entries();
    for correlation in ["move", "commit", "exists"] {
        assert!(
            !steps(&entries, correlation)
                .iter()
                .any(|(_, outcome)| *outcome == Outcome::Success)
        );
    }
    let v2 = install(&installer, &v2, HostHooks::default())
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&v2.plugin.digest.0));
}

#[tokio::test]
async fn approval_that_cannot_be_recorded_changes_nothing() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(APPROVE, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("outcome-approve-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let result = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks).await;
    assert!(matches!(result, Err(InstallError::Audit(_))), "{result:?}");
    assert!(steps(&log.1.entries(), "install").is_empty());
    assert!(!root.0.join(PLUGIN).join("state.json").exists());
    assert_eq!(version_dirs(&root.0), 0);
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn activation_stands_when_its_outcome_entry_cannot_be_written() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    // The decisions are recorded; every outcome entry fails.
    let log = FailWhen(|e| e.delivery.is_some(), MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("outcome-activate-lost");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let activated = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&activated.plugin.digest.0));
    let warning = AuditWarning::PrimaryFailed {
        primary: AuditError("primary sink down".into()),
        fallback: root.0.join(FALLBACK_AUDIT_FILE),
    };
    assert_eq!(
        activated.outcome_audit_warnings,
        vec![warning.clone(), warning.clone()]
    );
    let alert = |action: &str| InstallAlert::OutcomeAuditFallback {
        plugin_id: PLUGIN.into(),
        correlation_id: "install".into(),
        action: action.into(),
        warning: warning.clone(),
    };
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![alert(ACTIVATE), alert(APPROVE)]
    );
    // The primary log shows two decisions without an outcome; the fallback file has the outcomes.
    let primary = log.1.entries();
    assert_eq!(
        steps(&primary, "install"),
        [
            (APPROVE.to_owned(), Outcome::Started),
            (ACTIVATE.to_owned(), Outcome::Started),
        ]
    );
    // With the install decision, whose outcome entry failed too (it has no alert sink here).
    assert_eq!(security_types::unfinished(&primary).len(), 3);
    assert_eq!(
        steps(&read_fallback(&root.0), "install"),
        [
            (ACTIVATE.to_owned(), Outcome::Success),
            (APPROVE.to_owned(), Outcome::Success),
        ]
    );
}

#[tokio::test]
async fn failed_rollback_leaves_an_error_entry_and_the_active_version() {
    let publisher = Publisher::new();
    let (trust, policy, log) = (publisher.trust(), policy(), MemoryAuditLog::new());
    let root = Root::new("outcome-rollback-fails");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let (_, d2) = two_versions(&installer, &publisher).await;
    let store = grant_store();
    let hooks = HostHooks {
        grants: Some(&store),
        fault: Some(fail_commit),
        ..HostHooks::default()
    };
    let result = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await;
    assert!(matches!(result, Err(InstallError::Io)), "{result:?}");
    assert_eq!(active_digest(&root.0), hex(&d2));
    assert_eq!(
        steps(&log.entries(), "rb"),
        [
            (ROLLBACK.to_owned(), Outcome::Started),
            (ROLLBACK.to_owned(), io_error()),
        ]
    );
    // No grant was restored for a rollback that did not happen.
    assert!(entries_of(&log, RESTORE_GRANT_ACTION).is_empty());

    // With the primary sink down, both entries of the failed rollback go to the fallback file.
    let down = FailAction(ROLLBACK, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let installer = Installer {
        audit: &down,
        ..installer
    };
    let hooks = HostHooks {
        alerts: Some(&alerts),
        fault: Some(fail_commit),
        ..HostHooks::default()
    };
    let result = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb-down", hooks)
        .await;
    assert!(matches!(result, Err(InstallError::Io)), "{result:?}");
    assert_eq!(active_digest(&root.0), hex(&d2));
    assert_eq!(
        steps(&read_fallback(&root.0), "rb-down"),
        [
            (ROLLBACK.to_owned(), Outcome::Started),
            (ROLLBACK.to_owned(), io_error()),
        ]
    );
    assert_eq!(alerts.0.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn rollback_stands_when_only_its_outcome_entry_misses_the_primary_sink() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailWhen(
        |e| e.action.name == ROLLBACK && e.delivery.is_some(),
        MemoryAuditLog::new(),
    );
    let alerts = Alerts::default();
    let root = Root::new("outcome-rollback-lost");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let (d1, _) = two_versions(&installer, &publisher).await;
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(active_digest(&root.0), hex(&d1));
    assert_eq!(rolled.audit_warning, None);
    let warning = AuditWarning::PrimaryFailed {
        primary: AuditError("primary sink down".into()),
        fallback: root.0.join(FALLBACK_AUDIT_FILE),
    };
    assert_eq!(rolled.outcome_audit_warning, Some(warning.clone()));
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::RollbackAuditFallback {
            plugin_id: PLUGIN.into(),
            correlation_id: "rb".into(),
            warning,
        }]
    );
    assert_eq!(
        steps(&log.1.entries(), "rb"),
        [(ROLLBACK.to_owned(), Outcome::Started)]
    );
    assert_eq!(
        steps(&read_fallback(&root.0), "rb"),
        [(ROLLBACK.to_owned(), Outcome::Success)]
    );
}

// ---- TSK-34: the install step is recorded as a decision before and an outcome after ----

fn fail_stage_write(step: SwitchStep) -> std::io::Result<()> {
    match step {
        SwitchStep::WriteStage => Err(std::io::Error::other("injected stage write failure")),
        _ => Ok(()),
    }
}

/// The install entries written under `correlation`, in order: target and outcome.
fn install_steps(entries: &[AuditEntry], correlation: &str) -> Vec<(String, Outcome)> {
    entries
        .iter()
        .filter(|e| e.correlation_id == correlation && e.action.name == INSTALL)
        .map(|e| {
            let target = e.target.as_ref().expect("install entries have a target");
            (target.id.clone(), e.outcome.clone())
        })
        .collect()
}

/// Stage directories left under the install root.
fn stage_dirs(root: &Path) -> usize {
    std::fs::read_dir(root)
        .map(|d| {
            d.filter(|e| {
                let name = e.as_ref().unwrap().file_name();
                name.to_string_lossy().starts_with(".stage-")
            })
            .count()
        })
        .unwrap_or(0)
}

#[tokio::test]
async fn install_is_recorded_as_started_then_success_naming_the_plugin() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = MemoryAuditLog::new();
    let root = Root::new("install-outcome-success");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let archive = publisher.package("1.0.0", FULL, 0);
    let stage = installer.stage(&archive, &human(), "stage").await.unwrap();
    assert_eq!(stage.outcome_audit_warning(), None);
    let entries = log.entries();
    assert_eq!(
        install_steps(&entries, "stage"),
        [
            ("unverified".to_owned(), Outcome::Started),
            (PLUGIN.to_owned(), Outcome::Success),
        ]
    );
    // Both entries commit to the archive that was submitted; the outcome is the finished half.
    let archive_digest: [u8; 32] = Sha256::digest(&archive).into();
    assert!(entries.iter().all(|e| e.input_digest.0 == archive_digest));
    assert_eq!(entries[0].delivery, None);
    assert_eq!(entries[1].delivery, Some(Delivery::Delivered));
    assert!(entries[1].duration_ms.is_some());
    assert!(security_types::unfinished(&entries).is_empty());
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
}

#[tokio::test]
async fn refused_package_ends_the_install_with_the_verification_error() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = MemoryAuditLog::new();
    let root = Root::new("install-outcome-refused");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    // Signed by a key the trust store does not pin.
    let foreign = Publisher::new().package("1.0.0", FULL, 0);
    let result = installer.stage(&foreign, &human(), "refused").await;
    let Err(InstallError::Package(error)) = result else {
        panic!("expected a verification error");
    };
    let entries = log.entries();
    assert_eq!(
        install_steps(&entries, "refused"),
        [
            ("unverified".to_owned(), Outcome::Started),
            (
                "unverified".to_owned(),
                Outcome::Error {
                    code: format!("{error:?}")
                }
            ),
        ]
    );
    // The refusal is the install's outcome: no entry under another action, nothing logged as a
    // success, nothing unfinished, and nothing written under the install root.
    assert_eq!(entries.len(), 2);
    assert!(security_types::unfinished(&entries).is_empty());
    assert!(!root.0.exists());
}

#[tokio::test]
async fn failed_stage_write_is_not_logged_as_a_successful_install() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = MemoryAuditLog::new();
    let root = Root::new("install-outcome-io");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let archive = publisher.package("1.0.0", FULL, 0);
    let hooks = HostHooks {
        fault: Some(fail_stage_write),
        ..HostHooks::default()
    };
    let result = installer.stage_with(&archive, &human(), "io", hooks).await;
    assert!(
        matches!(result, Err(InstallError::Io)),
        "{:?}",
        result.err()
    );
    let entries = log.entries();
    // The package was verified, so the outcome names the plugin; the write failed.
    assert_eq!(
        install_steps(&entries, "io"),
        [
            ("unverified".to_owned(), Outcome::Started),
            (PLUGIN.to_owned(), io_error()),
        ]
    );
    assert_eq!(stage_dirs(&root.0), 0);

    // A failure before the stage is written (the plugin's state cannot be read) ends the same way.
    std::fs::create_dir_all(&root.0).unwrap();
    std::fs::write(root.0.join(PLUGIN), b"not a directory").unwrap();
    let result = installer.stage(&archive, &human(), "blocked").await;
    assert!(
        matches!(result, Err(InstallError::Io)),
        "{:?}",
        result.err()
    );
    assert_eq!(
        install_steps(&log.entries(), "blocked"),
        [
            ("unverified".to_owned(), Outcome::Started),
            (PLUGIN.to_owned(), io_error()),
        ]
    );
    assert_eq!(stage_dirs(&root.0), 0);
    std::fs::remove_file(root.0.join(PLUGIN)).unwrap();

    // The same archive still stages afterwards.
    let stage = installer.stage(&archive, &human(), "retry").await.unwrap();
    assert_eq!(stage.approval_view().plugin_id, PLUGIN);
    assert_eq!(
        install_steps(&log.entries(), "retry").last(),
        Some(&(PLUGIN.to_owned(), Outcome::Success))
    );
}

#[tokio::test]
async fn install_decision_that_cannot_be_recorded_verifies_and_writes_nothing() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    let log = FailAction(INSTALL, MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("install-decision-audit");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let archive = publisher.package("1.0.0", FULL, 0);
    let result = installer
        .stage_with(&archive, &human(), "closed", hooks)
        .await;
    assert!(
        matches!(result, Err(InstallError::Audit(_))),
        "{:?}",
        result.err()
    );
    // Fail closed: no fallback, no alert, no file.
    assert!(log.1.entries().is_empty());
    assert!(alerts.0.lock().unwrap().is_empty());
    assert!(!root.0.exists());
}

#[tokio::test]
async fn stage_stands_when_its_outcome_entry_cannot_be_written() {
    let publisher = Publisher::new();
    let (trust, policy) = (publisher.trust(), policy());
    // The decision is recorded; the outcome entry fails.
    let log = FailWhen(|e| e.delivery.is_some(), MemoryAuditLog::new());
    let alerts = Alerts::default();
    let root = Root::new("install-outcome-lost");
    let installer = Installer {
        root: &root.0,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let archive = publisher.package("1.0.0", FULL, 0);
    let stage = installer
        .stage_with(&archive, &human(), "lost", hooks)
        .await
        .unwrap();
    let warning = AuditWarning::PrimaryFailed {
        primary: AuditError("primary sink down".into()),
        fallback: root.0.join(FALLBACK_AUDIT_FILE),
    };
    assert_eq!(stage.outcome_audit_warning(), Some(&warning));
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::OutcomeAuditFallback {
            plugin_id: PLUGIN.into(),
            correlation_id: "lost".into(),
            action: INSTALL.into(),
            warning: warning.clone(),
        }]
    );
    let primary = log.1.entries();
    assert_eq!(
        install_steps(&primary, "lost"),
        [("unverified".to_owned(), Outcome::Started)]
    );
    assert_eq!(security_types::unfinished(&primary).len(), 1);
    assert_eq!(
        install_steps(&read_fallback(&root.0), "lost"),
        [(PLUGIN.to_owned(), Outcome::Success)]
    );
    assert_eq!(stage_dirs(&root.0), 1);

    // A refused package whose outcome misses the primary sink is in the fallback file too.
    let foreign = Publisher::new().package("1.0.0", FULL, 0);
    let result = installer
        .stage_with(&foreign, &human(), "refused", hooks)
        .await;
    let Err(InstallError::Package(error)) = result else {
        panic!("expected a verification error");
    };
    assert_eq!(
        install_steps(&read_fallback(&root.0), "refused"),
        [(
            "unverified".to_owned(),
            Outcome::Error {
                code: format!("{error:?}")
            }
        )]
    );
}
