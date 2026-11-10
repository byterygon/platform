//! TSK-27: configurable package limits (spec question 37), grant carry-over on upgrade (39) and
//! the rollback audit fallback (41). Packages are built in memory and signed with test-only keys.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use plugin_host::grant::address_policy;
use plugin_host::install::{
    AlertSink, Approval, AuditWarning, FALLBACK_AUDIT_FILE, HostHooks, InstallAlert, InstallError,
    Installer,
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
    AuditEntry, Authorizer, AuthzRequest, BoxFuture, Decision, Principal, PrincipalKind, SessionId,
    TenantId,
};
use semver::Version;
use sha2::{Digest as _, Sha256};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

const PLUGIN: &str = "org.example.demo";
const ROLLBACK: &str = "plugin-host.packages.rollback";
const ACTIVATE: &str = "plugin-host.packages.activate";

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
                }],
            )]),
        }
    }

    /// A signed package of `version` requesting `capabilities`, with `extra` payload files.
    fn package(&self, version: &str, capabilities: &str, extra: usize) -> Vec<u8> {
        let manifest = format!("{HEADER}version = \"{version}\"\n{capabilities}");
        let mut files: BTreeMap<String, Vec<u8>> = BTreeMap::from([
            ("plugin.toml".into(), manifest.into_bytes()),
            ("payload/demo.wasm".into(), version.as_bytes().to_vec()),
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
    };
    let result = install(&installer, &publisher.package("1.0.0", FULL, 0), hooks).await;
    assert!(matches!(result, Err(InstallError::Audit(_))), "{result:?}");
    assert!(!root.0.join(PLUGIN).join("state.json").exists());
    // The fallback is for rollback only.
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
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::RollbackAuditFallback {
            plugin_id: PLUGIN.into(),
            correlation_id: "rb-1".into(),
            warning,
        }]
    );
    // The fallback file holds the entry the primary sink refused, in the shared audit format.
    let text = std::fs::read_to_string(&fallback).unwrap();
    let entries: Vec<AuditEntry> = text
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].action.name, ROLLBACK);
    assert_eq!(entries[0].correlation_id, "rb-1");
    assert_eq!(entries[0].input_digest.0, d1);
    assert_eq!(entries[0].outcome, security_types::Outcome::Success);
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
    assert_eq!(ids, ["rb-1", "rb-2"]);
    assert_eq!(alerts.0.lock().unwrap().len(), 2);
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
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::RollbackAuditFallback {
            plugin_id: PLUGIN.into(),
            correlation_id: "rb".into(),
            warning,
        }]
    );
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
    };
    let rolled = installer
        .rollback_with(&Allow, &human(), PLUGIN, "rb", hooks)
        .await
        .unwrap();
    assert_eq!(rolled.audit_warning, None);
    assert!(!root.0.join(FALLBACK_AUDIT_FILE).exists());
    assert!(alerts.0.lock().unwrap().is_empty());
    assert!(
        log.records()
            .iter()
            .any(|r| r.entry.action.name == ROLLBACK)
    );
}
