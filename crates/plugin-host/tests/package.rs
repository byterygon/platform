use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use plugin_host::install::{AlertSink, Approval, HostHooks, InstallAlert, InstallError, Installer};
use plugin_host::package::{
    PackageError, PackageLimits, PackagePolicy, PinnedKey, TrustStore, canonical_bytes,
    verify_bytes,
};
use plugin_host::{AuditError, AuditSink, MemoryAuditLog, SystemClock};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use security_types::BoxFuture;
use security_types::{
    AuditEntry, Authorizer, AuthzRequest, Decision, Outcome, Principal, PrincipalKind, SessionId,
    TenantId,
};
use semver::Version;
use sha2::{Digest as _, Sha256};
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

struct Fixture {
    key: Ed25519KeyPair,
    files: BTreeMap<String, Vec<u8>>,
}

impl Fixture {
    fn new() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let manifest = br#"manifest_version = 1
id = "org.example.demo"
version = "1.0.0"
kind = "wasm"
entry = "payload/demo.wasm"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "example"
"#;
        let files = BTreeMap::from([
            ("plugin.toml".into(), manifest.to_vec()),
            ("payload/demo.wasm".into(), b"demo".to_vec()),
            ("sbom.spdx.json".into(), b"{}".to_vec()),
        ]);
        Self { key, files }
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

    fn policy() -> PackagePolicy {
        PackagePolicy {
            host_api: Version::parse("0.1.0").unwrap(),
            interface: "byterygon:db-driver@0.1.0".into(),
            platform: "linux-x86_64".into(),
            allow_third_party_sidecars: false,
        }
    }

    fn signed_files(&self) -> BTreeMap<String, Vec<u8>> {
        let mut files = self.files.clone();
        let checks: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| {
                (
                    p.clone(),
                    serde_json::json!({"size":b.len(), "sha256":hex(&sha(b))}),
                )
            })
            .collect();
        files.insert(
            "checksums.json".into(),
            serde_json::to_vec(&serde_json::json!({"version":1,"files":checks})).unwrap(),
        );
        let metadata: BTreeMap<_, _> = files
            .iter()
            .map(|(p, b)| (p.clone(), (b.len() as u64, sha(b))))
            .collect();
        let signature = self.key.sign(&canonical_bytes(&metadata));
        files.insert("signature.json".into(), serde_json::to_vec(&serde_json::json!({"version":1,"publisher":"example","signature_hex":hex(signature.as_ref())})).unwrap());
        files
    }
}

fn zip_files(
    files: impl IntoIterator<Item = (String, Vec<u8>)>,
    method: CompressionMethod,
) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(method);
    for (name, bytes) in files {
        zip.start_file(name, opts).unwrap();
        zip.write_all(&bytes).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn good(f: &Fixture) -> Vec<u8> {
    zip_files(f.signed_files(), CompressionMethod::Stored)
}

fn active_digest(root: &std::path::Path) -> String {
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("org.example.demo/state.json")).unwrap())
            .unwrap();
    state["active"].as_str().unwrap().to_owned()
}

fn resign(f: &Fixture, files: &mut BTreeMap<String, Vec<u8>>) {
    let metadata: BTreeMap<_, _> = files
        .iter()
        .filter(|(p, _)| p.as_str() != "signature.json")
        .map(|(p, b)| (p.clone(), (b.len() as u64, sha(b))))
        .collect();
    let signature = f.key.sign(&canonical_bytes(&metadata));
    files.insert(
        "signature.json".into(),
        serde_json::to_vec(&serde_json::json!({"version":1,"publisher":"example","signature_hex":hex(signature.as_ref())})).unwrap(),
    );
}

#[test]
fn canonical_golden_vector() {
    let vector = include_str!("vectors/package-v1.txt");
    let entries = BTreeMap::from([("payload/x".to_string(), (3, sha(b"abc")))]);
    let encoded = canonical_bytes(&entries);
    assert!(vector.contains(&format!("canonical-hex: {}", hex(&encoded))));
    assert!(vector.contains(&format!("sha256: {}", hex(&sha(&encoded)))));
}
fn verify(
    f: &Fixture,
    bytes: &[u8],
) -> Result<plugin_host::package::VerifiedPackage, PackageError> {
    verify_bytes(
        bytes,
        PackageLimits::default(),
        &f.trust(),
        &Fixture::policy(),
    )
}

#[test]
fn valid_offline_package() {
    let f = Fixture::new();
    let p = verify(&f, &good(&f)).unwrap();
    assert_eq!(p.manifest.id, "org.example.demo");
    assert!(p.files().contains_key("payload/demo.wasm"));
    assert!(!p.files().contains_key("signature.json"));
}

#[test]
fn traversal_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("payload/../escape".into(), vec![]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Path
    );
}

#[test]
fn absolute_path_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("/escape".into(), vec![]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Path
    );
}

#[test]
fn symlink_rejected() {
    let f = Fixture::new();
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    z.add_symlink("payload/link", "../escape", SimpleFileOptions::default())
        .unwrap();
    for (name, bytes) in f.signed_files() {
        z.start_file(name, SimpleFileOptions::default()).unwrap();
        z.write_all(&bytes).unwrap();
    }
    assert_eq!(
        verify(&f, &z.finish().unwrap().into_inner()).unwrap_err(),
        PackageError::EntryType
    );
}

#[test]
fn duplicate_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("payload/xyz".into(), vec![]);
    let mut bytes = zip_files(files, CompressionMethod::Stored);
    for window in bytes
        .windows(11)
        .enumerate()
        .filter_map(|(i, w)| (w == b"payload/xyz").then_some(i))
        .collect::<Vec<_>>()
    {
        bytes[window..window + 11].copy_from_slice(b"plugin.toml");
    }
    assert_eq!(verify(&f, &bytes).unwrap_err(), PackageError::Duplicate);
}

#[test]
fn case_collision_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("Payload/demo.wasm".into(), vec![]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Duplicate
    );
}

#[test]
fn unicode_normalization_collision_is_rejected_conservatively() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("payload/café".into(), vec![]);
    files.insert("payload/cafe\u{301}".into(), vec![]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Path
    );
}

#[test]
fn oversized_entry_rejected() {
    let f = Fixture::new();
    let bytes = good(&f);
    let limits = PackageLimits {
        max_entry_bytes: 3,
        ..PackageLimits::default()
    };
    assert_eq!(
        verify_bytes(&bytes, limits, &f.trust(), &Fixture::policy()).unwrap_err(),
        PackageError::Limits
    );
}

#[test]
fn too_many_entries_rejected() {
    let f = Fixture::new();
    let bytes = good(&f);
    let limits = PackageLimits {
        max_entries: 4,
        ..PackageLimits::default()
    };
    assert_eq!(
        verify_bytes(&bytes, limits, &f.trust(), &Fixture::policy()).unwrap_err(),
        PackageError::Limits
    );
}

#[test]
fn total_size_limit_rejected() {
    let f = Fixture::new();
    let bytes = good(&f);
    let limits = PackageLimits {
        max_total_bytes: 10,
        ..PackageLimits::default()
    };
    assert_eq!(
        verify_bytes(&bytes, limits, &f.trust(), &Fixture::policy()).unwrap_err(),
        PackageError::Limits
    );
}

#[test]
fn zip_bomb_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("payload/bomb".into(), vec![0; 100_000]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Deflated)).unwrap_err(),
        PackageError::Compression
    );
}

#[test]
fn truncated_archive_rejected() {
    let f = Fixture::new();
    let mut bytes = good(&f);
    bytes.truncate(bytes.len() - 10);
    assert!(verify(&f, &bytes).is_err());
}

#[test]
fn extra_file_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("extra".into(), vec![]);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Layout
    );
}

#[test]
fn missing_file_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.remove("sbom.spdx.json");
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Missing("sbom.spdx.json")
    );
}

#[test]
fn unsigned_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("signature.json".into(), b"{}".to_vec());
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Unsigned
    );
}

#[test]
fn tampered_payload_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("payload/demo.wasm".into(), b"evil".to_vec());
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Signature
    );
}

#[test]
fn tampered_checksums_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("checksums.json".into(), b"{}".to_vec());
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Signature
    );
}

#[test]
fn signed_wrong_checksum_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    let mut checks: serde_json::Value = serde_json::from_slice(&files["checksums.json"]).unwrap();
    checks["files"]["payload/demo.wasm"]["sha256"] = serde_json::Value::String("00".repeat(32));
    files.insert(
        "checksums.json".into(),
        serde_json::to_vec(&checks).unwrap(),
    );
    resign(&f, &mut files);
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Checksum
    );
}

#[test]
fn incompatible_host_api_rejected() {
    let mut f = Fixture::new();
    let manifest = String::from_utf8(f.files["plugin.toml"].clone()).unwrap();
    f.files.insert(
        "plugin.toml".into(),
        manifest.replace(">=0.1.0, <0.2.0", "^9.0").into_bytes(),
    );
    assert_eq!(verify(&f, &good(&f)).unwrap_err(), PackageError::HostApi);
}

#[test]
fn sidecar_requires_admin_opt_in_and_exact_platform() {
    let mut f = Fixture::new();
    let manifest = String::from_utf8(f.files["plugin.toml"].clone()).unwrap();
    let manifest = manifest.replace(
        "kind = \"wasm\"",
        "kind = \"sidecar\"\nplatform = \"linux-x86_64\"",
    );
    f.files.insert("plugin.toml".into(), manifest.into_bytes());
    let bytes = good(&f);
    assert_eq!(
        verify(&f, &bytes).unwrap_err(),
        PackageError::KindOrPlatform
    );
    let mut policy = Fixture::policy();
    policy.allow_third_party_sidecars = true;
    assert!(verify_bytes(&bytes, PackageLimits::default(), &f.trust(), &policy).is_ok());
    policy.platform = "windows-x86_64".into();
    assert_eq!(
        verify_bytes(&bytes, PackageLimits::default(), &f.trust(), &policy).unwrap_err(),
        PackageError::KindOrPlatform
    );
}

#[test]
fn wrong_key_rejected() {
    let f = Fixture::new();
    let other = Fixture::new();
    assert_eq!(
        verify_bytes(
            &good(&f),
            PackageLimits::default(),
            &other.trust(),
            &Fixture::policy()
        )
        .unwrap_err(),
        PackageError::Signature
    );
}

#[test]
fn another_publisher_key_rejected() {
    let f = Fixture::new();
    let mut trust = f.trust();
    let key = trust.publishers.remove("example").unwrap();
    trust.publishers.insert("elsewhere".into(), key);
    assert_eq!(
        verify_bytes(
            &good(&f),
            PackageLimits::default(),
            &trust,
            &Fixture::policy()
        )
        .unwrap_err(),
        PackageError::UntrustedPublisher
    );
}

#[test]
fn key_plugin_restriction_rejected() {
    let f = Fixture::new();
    let mut trust = f.trust();
    trust.publishers.get_mut("example").unwrap()[0]
        .plugin_ids
        .insert("org.example.other".into());
    assert_eq!(
        verify_bytes(
            &good(&f),
            PackageLimits::default(),
            &trust,
            &Fixture::policy()
        )
        .unwrap_err(),
        PackageError::KeyNotAllowed
    );
}

#[test]
fn repeated_matching_key_checks_all_plugin_scopes() {
    let f = Fixture::new();
    let mut trust = f.trust();
    let first = &mut trust.publishers.get_mut("example").unwrap()[0];
    first.plugin_ids.insert("org.example.other".into());
    let mut second = first.clone();
    second.plugin_ids.clear();
    second.plugin_ids.insert("org.example.demo".into());
    trust.publishers.get_mut("example").unwrap().push(second);
    assert!(
        verify_bytes(
            &good(&f),
            PackageLimits::default(),
            &trust,
            &Fixture::policy()
        )
        .is_ok()
    );
}

#[test]
fn different_canonical_bytes_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    files.insert("sbom.spdx.json".into(), b"{ }".to_vec());
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Signature
    );
}

#[test]
fn v1_domain_mismatch_rejected() {
    let f = Fixture::new();
    let mut files = f.signed_files();
    let metadata: BTreeMap<_, _> = files
        .iter()
        .filter(|(p, _)| p.as_str() != "signature.json")
        .map(|(p, b)| (p.clone(), (b.len() as u64, sha(b))))
        .collect();
    let mut signed = canonical_bytes(&metadata);
    signed[31] = b'2';
    let sig = f.key.sign(&signed);
    files.insert("signature.json".into(), serde_json::to_vec(&serde_json::json!({"version":1,"publisher":"example","signature_hex":hex(sig.as_ref())})).unwrap());
    assert_eq!(
        verify(&f, &zip_files(files, CompressionMethod::Stored)).unwrap_err(),
        PackageError::Signature
    );
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
struct MeetAtAuthorization(tokio::sync::Barrier);
impl Authorizer for MeetAtAuthorization {
    async fn check(&self, _: &AuthzRequest<'_>) -> Decision {
        self.0.wait().await;
        Decision::Allow
    }
}
struct NeedsApproval;
impl Authorizer for NeedsApproval {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        Decision::NeedsApproval {
            approval: security_types::ApprovalSpec {
                action: req.action.clone(),
                target: req.target.cloned(),
                risk: req.risk,
                input_digest: req.input_digest,
                expires_at_unix_ms: u64::MAX,
            },
        }
    }
}
struct FailingAudit;
impl AuditSink for FailingAudit {
    fn append(&self, _: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        Box::pin(async { Err(AuditError("failed".into())) })
    }
}

struct FailActivate(MemoryAuditLog);
impl AuditSink for FailActivate {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if entry.action.name == "plugin-host.packages.activate" {
            Box::pin(async { Err(AuditError("failed".into())) })
        } else {
            self.0.append(entry)
        }
    }
}

#[tokio::test]
async fn install_approve_and_rollback_offline() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root =
        std::env::temp_dir().join(format!("byterygon-package-test-{}", hex(&sha(&good(&f)))));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let first = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    let digest = first.approval_view().package_digest;
    first
        .approve_and_activate(&Allow, &human(), digest)
        .await
        .unwrap();
    assert_eq!(active_digest(&root), hex(&digest));
    let mut second = Fixture::new();
    second.key = f.key;
    second
        .files
        .insert("payload/demo.wasm".into(), b"second".to_vec());
    let update = installer
        .stage(&good(&second), &human(), "c2")
        .await
        .unwrap();
    let next = update.approval_view().package_digest;
    update
        .approve_and_activate(&Allow, &human(), next)
        .await
        .unwrap();
    installer
        .rollback(&Allow, &human(), "org.example.demo", "c3")
        .await
        .unwrap();
    assert_eq!(active_digest(&root), hex(&digest));
    assert!(log.records().len() >= 7);
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_approvals_retain_the_first_activated_update() {
    let mut f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = std::env::temp_dir().join(format!(
        "byterygon-concurrent-test-{}",
        hex(&sha(&good(&f)))
    ));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let first = installer.stage(&good(&f), &human(), "first").await.unwrap();
    let first_digest = first.approval_view().package_digest;
    first
        .approve_and_activate(&Allow, &human(), first_digest)
        .await
        .unwrap();
    f.files
        .insert("payload/demo.wasm".into(), b"update two".to_vec());
    let second = installer
        .stage(&good(&f), &human(), "second")
        .await
        .unwrap();
    let second_digest = second.approval_view().package_digest;
    f.files
        .insert("payload/demo.wasm".into(), b"update three".to_vec());
    let third = installer.stage(&good(&f), &human(), "third").await.unwrap();
    let third_digest = third.approval_view().package_digest;
    let together = MeetAtAuthorization(tokio::sync::Barrier::new(2));
    let second_approver = human();
    let third_approver = human();
    let (second_result, third_result) = tokio::join!(
        second.approve_and_activate(&together, &second_approver, second_digest),
        third.approve_and_activate(&together, &third_approver, third_digest)
    );
    second_result.unwrap();
    third_result.unwrap();
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("org.example.demo/state.json")).unwrap())
            .unwrap();
    let active = state["active"].as_str().unwrap();
    let previous = state["previous"].as_str().unwrap();
    let d2 = hex(&second_digest);
    let d3 = hex(&third_digest);
    assert!((active == d2 && previous == d3) || (active == d3 && previous == d2));
    assert!(root.join("org.example.demo/versions").join(active).is_dir());
    assert!(
        root.join("org.example.demo/versions")
            .join(previous)
            .is_dir()
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rollback_and_activation_are_serialized() {
    let mut f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = std::env::temp_dir().join(format!(
        "byterygon-rollback-race-test-{}",
        hex(&sha(&good(&f)))
    ));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let first = installer.stage(&good(&f), &human(), "first").await.unwrap();
    let d1 = first.approval_view().package_digest;
    first
        .approve_and_activate(&Allow, &human(), d1)
        .await
        .unwrap();
    f.files
        .insert("payload/demo.wasm".into(), b"second".to_vec());
    let second = installer
        .stage(&good(&f), &human(), "second")
        .await
        .unwrap();
    let d2 = second.approval_view().package_digest;
    second
        .approve_and_activate(&Allow, &human(), d2)
        .await
        .unwrap();
    f.files
        .insert("payload/demo.wasm".into(), b"third".to_vec());
    let third = installer.stage(&good(&f), &human(), "third").await.unwrap();
    let d3 = third.approval_view().package_digest;
    let together = MeetAtAuthorization(tokio::sync::Barrier::new(2));
    let rollback_principal = human();
    let activation_principal = human();
    let (rolled_back, activated) = tokio::join!(
        installer.rollback(
            &together,
            &rollback_principal,
            "org.example.demo",
            "rollback"
        ),
        third.approve_and_activate(&together, &activation_principal, d3)
    );
    rolled_back.unwrap();
    activated.unwrap();
    let state: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("org.example.demo/state.json")).unwrap())
            .unwrap();
    assert_eq!(state["active"], hex(&d3));
    assert_eq!(state["previous"], hex(&d1));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn nonhuman_and_wrong_digest_denied() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = std::env::temp_dir().join(format!("byterygon-deny-test-{}", hex(&sha(&good(&f)))));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let mut agent = human();
    agent.kind = PrincipalKind::Agent;
    let stage = installer.stage(&good(&f), &human(), "c").await.unwrap();
    assert!(matches!(
        stage.approve_and_activate(&Allow, &agent, [0; 32]).await,
        Err(InstallError::Denied)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").await.unwrap();
    assert!(matches!(
        stage.approve_and_activate(&Allow, &human(), [0; 32]).await,
        Err(InstallError::DigestMismatch)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").await.unwrap();
    let digest = stage.approval_view().package_digest;
    let mut delegated = human();
    delegated.on_behalf_of = Some(Box::new(human()));
    assert!(matches!(
        stage.approve_and_activate(&Allow, &delegated, digest).await,
        Err(InstallError::Denied)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").await.unwrap();
    let digest = stage.approval_view().package_digest;
    assert!(matches!(
        stage
            .approve_and_activate(&NeedsApproval, &human(), digest)
            .await,
        Err(InstallError::Denied)
    ));
    assert!(!root.join("org.example.demo/state.json").exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn dropped_stage_keeps_previous_version() {
    let mut f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = std::env::temp_dir().join(format!("byterygon-drop-test-{}", hex(&sha(&good(&f)))));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let stage = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    let first = stage.approval_view().package_digest;
    stage
        .approve_and_activate(&Allow, &human(), first)
        .await
        .unwrap();
    f.files
        .insert("payload/demo.wasm".into(), b"changed".to_vec());
    let stage = installer.stage(&good(&f), &human(), "c2").await.unwrap();
    let stage_path = std::fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
        .unwrap()
        .path();
    drop(stage);
    assert!(!stage_path.exists());
    assert_eq!(active_digest(&root), hex(&first));
    std::fs::remove_dir_all(root).unwrap();
}

/// Never answers for the actions in `hang`; records everything else.
struct HangOn {
    hang: std::sync::Mutex<Vec<&'static str>>,
    log: MemoryAuditLog,
}

impl HangOn {
    fn new(hang: &[&'static str]) -> Self {
        HangOn {
            hang: std::sync::Mutex::new(hang.to_vec()),
            log: MemoryAuditLog::new(),
        }
    }
}

impl AuditSink for HangOn {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if self
            .hang
            .lock()
            .unwrap()
            .contains(&entry.action.name.as_str())
        {
            Box::pin(std::future::pending())
        } else {
            self.log.append(entry)
        }
    }
}

#[tokio::test(start_paused = true)]
async fn hung_audit_sink_fails_stage_closed_within_the_audit_timeout() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let root = std::env::temp_dir().join("byterygon-audit-hang-stage-test");
    let sink = HangOn::new(&["plugin-host.packages.install"]);
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &sink,
        clock: &SystemClock,
    };
    let started = tokio::time::Instant::now();
    let staged = installer.stage(&good(&f), &human(), "c").await;
    assert!(
        matches!(&staged, Err(InstallError::Audit(e)) if *e == AuditError::timed_out()),
        "{:?}",
        staged.err()
    );
    assert_eq!(started.elapsed(), plugin_host::DEFAULT_AUDIT_TIMEOUT);
    assert!(!root.exists());
}

#[tokio::test(start_paused = true)]
async fn hung_audit_sink_releases_the_plugin_lock_after_the_audit_timeout() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let root = std::env::temp_dir().join(format!(
        "byterygon-audit-hang-approve-test-{}",
        hex(&sha(&good(&f)))
    ));
    let sink = HangOn::new(&[]);
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &sink,
        clock: &SystemClock,
    };
    // The activation entry is written while the plugin's install lock is held.
    let first = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    let digest = first.approval_view().package_digest;
    *sink.hang.lock().unwrap() = vec!["plugin-host.packages.activate"];
    let approved = first.approve_and_activate(&Allow, &human(), digest).await;
    assert!(
        matches!(&approved, Err(InstallError::Audit(e)) if *e == AuditError::timed_out()),
        "{approved:?}"
    );
    // The lock was released: the next install of the plugin is not blocked.
    sink.hang.lock().unwrap().clear();
    let second = installer.stage(&good(&f), &human(), "c2").await.unwrap();
    let digest = second.approval_view().package_digest;
    tokio::time::timeout(
        std::time::Duration::from_secs(60),
        second.approve_and_activate(&Allow, &human(), digest),
    )
    .await
    .expect("the plugin lock is free")
    .unwrap();
    assert_eq!(active_digest(&root), hex(&digest));
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn audit_failure_stops_before_stage() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let root = std::env::temp_dir().join("byterygon-audit-failure-test");
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &FailingAudit,
        clock: &SystemClock,
    };
    assert!(matches!(
        installer.stage(&good(&f), &human(), "c").await,
        Err(InstallError::Audit(_))
    ));
    assert!(!root.exists());
}

#[tokio::test]
async fn audit_failure_stops_activation_and_cleans_stage() {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = FailActivate(MemoryAuditLog::new());
    let root = std::env::temp_dir().join(format!(
        "byterygon-audit-activate-test-{}",
        hex(&sha(&good(&f)))
    ));
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let stage = installer.stage(&good(&f), &human(), "c").await.unwrap();
    let digest = stage.approval_view().package_digest;
    assert!(matches!(
        stage.approve_and_activate(&Allow, &human(), digest).await,
        Err(InstallError::Audit(_))
    ));
    assert!(!root.join("org.example.demo/state.json").exists());
    assert!(
        !std::fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
    );
    std::fs::remove_dir_all(root).unwrap();
}

// ---- TSK-28: private stage, re-check before activation, portable names, first-party keys ----

/// A fresh install root for one test.
fn hardening_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("byterygon-tsk28-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    root
}

fn stage_dirs(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(root)
        .unwrap()
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().starts_with(".stage-"))
        .map(|e| e.path())
        .collect()
}

#[derive(Default)]
struct Alerts(std::sync::Mutex<Vec<InstallAlert>>);
impl AlertSink for Alerts {
    fn alert(&self, alert: &InstallAlert) {
        self.0.lock().unwrap().push(alert.clone());
    }
}

/// A signed package with one more payload file. Its key is not the caller's: entry names are
/// checked before any signature.
fn with_payload(name: &str) -> Vec<u8> {
    let mut f = Fixture::new();
    f.files.insert(name.into(), b"x".to_vec());
    good(&f)
}

#[test]
fn windows_device_names_rejected_on_every_platform() {
    let f = Fixture::new();
    for name in [
        "payload/CON",
        "payload/con",
        "payload/PRN",
        "payload/aux",
        "payload/NUL",
        "payload/nul.txt",
        "payload/Nul.tar.gz",
        "payload/nul .txt",
        "payload/COM1",
        "payload/com9.dll",
        "payload/LPT1",
        "payload/lpt9.bin",
        "payload/COM0",
        "payload/lpt0",
        "payload/conin$",
        "payload/CONOUT$.log",
        "payload/aux/lib.so",
        "payload/lib/Com5/x",
    ] {
        assert_eq!(
            verify(&f, &with_payload(name)).unwrap_err(),
            PackageError::Path,
            "{name}"
        );
    }
}

#[test]
fn trailing_dot_or_space_components_rejected_on_every_platform() {
    let f = Fixture::new();
    for name in [
        "payload/lib.",
        "payload/lib ",
        "payload/dir./x",
        "payload/dir /x",
        "payload/a.txt.",
        "payload/...",
    ] {
        assert_eq!(
            verify(&f, &with_payload(name)).unwrap_err(),
            PackageError::Path,
            "{name}"
        );
    }
}

#[test]
fn names_that_only_resemble_device_names_are_accepted() {
    for name in [
        "payload/console.txt",
        "payload/com10",
        "payload/com",
        "payload/lpt",
        "payload/nul_.txt",
        "payload/xnul",
        "payload/auxiliary/a b.txt",
        "payload/.hidden",
    ] {
        let mut f = Fixture::new();
        f.files.insert(name.into(), b"x".to_vec());
        assert!(verify(&f, &good(&f)).is_ok(), "{name}");
    }
}

#[test]
fn device_name_as_manifest_entry_or_plugin_id_rejected() {
    let mut f = Fixture::new();
    let manifest = String::from_utf8(f.files["plugin.toml"].clone()).unwrap();
    f.files.insert(
        "plugin.toml".into(),
        manifest
            .replace("org.example.demo", "nul.example.demo")
            .into_bytes(),
    );
    assert_eq!(
        verify(&f, &good(&f)).unwrap_err(),
        PackageError::Manifest,
        "a plugin id is a directory name under the install root"
    );
}

fn sidecar(f: &mut Fixture) {
    let manifest = String::from_utf8(f.files["plugin.toml"].clone()).unwrap();
    let manifest = manifest.replace(
        "kind = \"wasm\"",
        "kind = \"sidecar\"\nplatform = \"linux-x86_64\"",
    );
    f.files.insert("plugin.toml".into(), manifest.into_bytes());
}

#[test]
fn sidecar_admitted_by_first_party_flag_on_the_pinned_key() {
    let mut f = Fixture::new();
    sidecar(&mut f);
    let bytes = good(&f);
    let policy = Fixture::policy();
    assert!(!policy.allow_third_party_sidecars);
    let mut trust = f.trust();
    assert_eq!(
        verify_bytes(&bytes, PackageLimits::default(), &trust, &policy).unwrap_err(),
        PackageError::KindOrPlatform
    );
    trust.publishers.get_mut("example").unwrap()[0].first_party = true;
    let package = verify_bytes(&bytes, PackageLimits::default(), &trust, &policy).unwrap();
    assert!(package.signer_first_party);
    // A WASM package reports the flag too; it changes nothing for it.
    let wasm = Fixture::new();
    assert!(!verify(&wasm, &good(&wasm)).unwrap().signer_first_party);
}

#[test]
fn publisher_named_byterygon_is_not_first_party_without_the_flag() {
    let mut f = Fixture::new();
    sidecar(&mut f);
    let manifest = String::from_utf8(f.files["plugin.toml"].clone()).unwrap();
    f.files.insert(
        "plugin.toml".into(),
        manifest
            .replace("publisher = \"example\"", "publisher = \"byterygon\"")
            .into_bytes(),
    );
    let mut files = f.signed_files();
    // The publisher in signature.json is a routing hint outside the signed bytes.
    let mut signature: serde_json::Value =
        serde_json::from_slice(&files["signature.json"]).unwrap();
    signature["publisher"] = "byterygon".into();
    files.insert(
        "signature.json".into(),
        serde_json::to_vec(&signature).unwrap(),
    );
    let bytes = zip_files(files, CompressionMethod::Stored);
    let mut trust = TrustStore {
        publishers: BTreeMap::from([(
            "byterygon".to_owned(),
            f.trust().publishers.remove("example").unwrap(),
        )]),
    };
    let policy = Fixture::policy();
    assert_eq!(
        verify_bytes(&bytes, PackageLimits::default(), &trust, &policy).unwrap_err(),
        PackageError::KindOrPlatform
    );
    trust.publishers.get_mut("byterygon").unwrap()[0].first_party = true;
    assert!(verify_bytes(&bytes, PackageLimits::default(), &trust, &policy).is_ok());
}

#[test]
fn first_party_flag_on_an_out_of_scope_entry_does_not_count() {
    let mut f = Fixture::new();
    sidecar(&mut f);
    let bytes = good(&f);
    let mut trust = f.trust();
    let keys = trust.publishers.get_mut("example").unwrap();
    // The same key pinned twice: first-party for another plugin only, plain for this one.
    let mut other = keys[0].clone();
    other.first_party = true;
    other.plugin_ids.insert("org.example.other".into());
    keys[0].plugin_ids.insert("org.example.demo".into());
    keys.insert(0, other);
    assert_eq!(
        verify_bytes(&bytes, PackageLimits::default(), &trust, &Fixture::policy()).unwrap_err(),
        PackageError::KindOrPlatform
    );
    // In scope, the explicit flag counts whichever entry is listed first.
    trust.publishers.get_mut("example").unwrap()[0]
        .plugin_ids
        .insert("org.example.demo".into());
    assert!(
        verify_bytes(&bytes, PackageLimits::default(), &trust, &Fixture::policy())
            .unwrap()
            .signer_first_party
    );
}

#[test]
fn trust_store_file_first_party_defaults_to_false_and_must_be_a_boolean() {
    let f = Fixture::new();
    let key = hex(f.key.public_key().as_ref());
    let dir = hardening_root("trust");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("trust.json");
    let write = |key_fields: &str| {
        std::fs::write(
            &path,
            format!(r#"{{"publishers":{{"example":[{{"public_key_hex":"{key}"{key_fields}}}]}}}}"#),
        )
        .unwrap();
        TrustStore::from_local_file(&path)
    };
    assert!(!write("").unwrap().publishers["example"][0].first_party);
    assert!(!write(r#","first_party":false"#).unwrap().publishers["example"][0].first_party);
    assert!(write(r#","first_party":true"#).unwrap().publishers["example"][0].first_party);
    for bad in [
        r#","first_party":"true""#,
        r#","first_party":1"#,
        r#","first_party":null"#,
        r#","first-party":true"#,
    ] {
        assert_eq!(write(bad).unwrap_err(), PackageError::TrustStore, "{bad}");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn stage_and_version_directories_are_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;

    let mut f = Fixture::new();
    f.files
        .insert("payload/lib/deep/extra.bin".into(), b"extra".to_vec());
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = hardening_root("mode");
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let stage = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    let dirs = stage_dirs(&root);
    assert_eq!(dirs.len(), 1);
    for dir in [
        dirs[0].clone(),
        dirs[0].join("payload"),
        dirs[0].join("payload/lib"),
        dirs[0].join("payload/lib/deep"),
    ] {
        assert_eq!(mode(&dir), 0o700, "{}", dir.display());
    }
    let digest = stage.approval_view().package_digest;
    stage
        .approve_and_activate(&Allow, &human(), digest)
        .await
        .unwrap();
    let version = root.join("org.example.demo/versions").join(hex(&digest));
    assert_eq!(mode(&version), 0o700);
    assert_eq!(
        std::fs::read(version.join("payload/lib/deep/extra.bin")).unwrap(),
        b"extra"
    );
    std::fs::remove_dir_all(root).unwrap();
}

/// Stage the fixture, let `tamper` change the stage, then try to activate it.
async fn activate_after(name: &str, tamper: impl FnOnce(&std::path::Path)) {
    let f = Fixture::new();
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let alerts = Alerts::default();
    let root = hardening_root(name);
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let stage = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    let digest = stage.approval_view().package_digest;
    let dirs = stage_dirs(&root);
    assert_eq!(dirs.len(), 1);
    tamper(&dirs[0]);
    let hooks = HostHooks {
        alerts: Some(&alerts),
        ..HostHooks::default()
    };
    let result = stage
        .activate(&Allow, &human(), Approval::package(digest), hooks)
        .await;
    assert!(
        matches!(result, Err(InstallError::StageChanged)),
        "{name}: {result:?}",
        result = result.map(|a| a.plugin.id)
    );
    // Nothing was activated and nothing of the stage is left behind.
    let base = root.join("org.example.demo");
    assert!(!base.join("state.json").exists(), "{name}");
    assert!(!base.join("versions").join(hex(&digest)).exists(), "{name}");
    assert!(stage_dirs(&root).is_empty(), "{name}");
    // install Started/Success, approve Started, activate Started, then both outcomes as errors.
    let trail: Vec<(String, Outcome)> = log
        .records()
        .into_iter()
        .map(|r| (r.entry.action.name.clone(), r.entry.outcome.clone()))
        .collect();
    let changed = Outcome::Error {
        code: "StageChanged".into(),
    };
    assert_eq!(
        trail,
        vec![
            ("plugin-host.packages.install".to_owned(), Outcome::Started),
            ("plugin-host.packages.install".to_owned(), Outcome::Success),
            ("plugin-host.packages.approve".to_owned(), Outcome::Started),
            ("plugin-host.packages.activate".to_owned(), Outcome::Started),
            ("plugin-host.packages.activate".to_owned(), changed.clone()),
            ("plugin-host.packages.approve".to_owned(), changed),
        ],
        "{name}"
    );
    assert_eq!(
        *alerts.0.lock().unwrap(),
        vec![InstallAlert::StageChanged {
            plugin_id: "org.example.demo".into(),
            correlation_id: "c1".into(),
        }],
        "{name}"
    );
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn staged_file_changed_with_same_size_is_not_activated() {
    activate_after("same-size", |stage| {
        // `demo` -> `DEMO`: the size still matches, only the SHA-256 tells.
        std::fs::write(stage.join("payload/demo.wasm"), b"DEMO").unwrap();
    })
    .await;
}

#[tokio::test]
async fn staged_file_with_another_size_is_not_activated() {
    activate_after("size", |stage| {
        std::fs::write(stage.join("payload/demo.wasm"), b"demo and more").unwrap();
    })
    .await;
}

#[tokio::test]
async fn staged_manifest_changed_is_not_activated() {
    activate_after("manifest", |stage| {
        let path = stage.join("plugin.toml");
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, text.replace("1.0.0", "9.0.0")).unwrap();
    })
    .await;
}

#[tokio::test]
async fn staged_file_removed_is_not_activated() {
    activate_after("removed", |stage| {
        std::fs::remove_file(stage.join("sbom.spdx.json")).unwrap();
    })
    .await;
}

#[tokio::test]
async fn file_added_to_the_stage_is_not_activated() {
    activate_after("added", |stage| {
        std::fs::write(stage.join("payload/added.so"), b"not verified").unwrap();
    })
    .await;
    activate_after("added-dir", |stage| {
        std::fs::create_dir(stage.join("payload/empty")).unwrap();
    })
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn staged_file_or_directory_replaced_by_a_link_is_not_activated() {
    // The link targets hold the verified bytes, so only the file type gives them away.
    activate_after("file-link", |stage| {
        let outside = stage.parent().unwrap().join("outside.wasm");
        std::fs::write(&outside, b"demo").unwrap();
        let file = stage.join("payload/demo.wasm");
        std::fs::remove_file(&file).unwrap();
        std::os::unix::fs::symlink(&outside, &file).unwrap();
    })
    .await;
    activate_after("dir-link", |stage| {
        let outside = stage.parent().unwrap().join("outside-payload");
        std::fs::rename(stage.join("payload"), &outside).unwrap();
        std::os::unix::fs::symlink(&outside, stage.join("payload")).unwrap();
    })
    .await;
}

#[tokio::test]
async fn untouched_stage_passes_the_check_and_is_activated() {
    let mut f = Fixture::new();
    f.files
        .insert("payload/lib/extra.bin".into(), vec![7; 200_000]);
    f.files.insert("payload/empty".into(), Vec::new());
    let trust = f.trust();
    let policy = Fixture::policy();
    let log = MemoryAuditLog::new();
    let root = hardening_root("untouched");
    let installer = Installer {
        root: &root,
        trust: &trust,
        policy: &policy,
        limits: PackageLimits::default(),
        audit: &log,
        clock: &SystemClock,
    };
    let stage = installer.stage(&good(&f), &human(), "c1").await.unwrap();
    assert!(!stage.approval_view().signer_first_party);
    let digest = stage.approval_view().package_digest;
    stage
        .approve_and_activate(&Allow, &human(), digest)
        .await
        .unwrap();
    assert_eq!(active_digest(&root), hex(&digest));
    std::fs::remove_dir_all(root).unwrap();
}
