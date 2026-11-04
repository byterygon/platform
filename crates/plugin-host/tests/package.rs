use std::collections::BTreeMap;
use std::io::{Cursor, Write};

use plugin_host::install::{InstallError, Installer};
use plugin_host::package::{
    PackageError, PackageLimits, PackagePolicy, PinnedKey, TrustStore, canonical_bytes,
    verify_bytes,
};
use plugin_host::{AuditError, AuditSink, MemoryAuditLog, SystemClock};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use security_types::{
    AuditEntry, Authorizer, AuthzRequest, Decision, Principal, PrincipalKind, SessionId, TenantId,
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
    fn append(&self, _: AuditEntry) -> Result<(), AuditError> {
        Err(AuditError("failed".into()))
    }
}

struct FailActivate(MemoryAuditLog);
impl AuditSink for FailActivate {
    fn append(&self, entry: AuditEntry) -> Result<(), AuditError> {
        if entry.action.name == "plugin-host.packages.activate" {
            Err(AuditError("failed".into()))
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
    let first = installer.stage(&good(&f), &human(), "c1").unwrap();
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
    let update = installer.stage(&good(&second), &human(), "c2").unwrap();
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
    let stage = installer.stage(&good(&f), &human(), "c").unwrap();
    assert!(matches!(
        stage.approve_and_activate(&Allow, &agent, [0; 32]).await,
        Err(InstallError::Denied)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").unwrap();
    assert!(matches!(
        stage.approve_and_activate(&Allow, &human(), [0; 32]).await,
        Err(InstallError::DigestMismatch)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").unwrap();
    let digest = stage.approval_view().package_digest;
    let mut delegated = human();
    delegated.on_behalf_of = Some(Box::new(human()));
    assert!(matches!(
        stage.approve_and_activate(&Allow, &delegated, digest).await,
        Err(InstallError::Denied)
    ));
    let stage = installer.stage(&good(&f), &human(), "c").unwrap();
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
    let stage = installer.stage(&good(&f), &human(), "c1").unwrap();
    let first = stage.approval_view().package_digest;
    stage
        .approve_and_activate(&Allow, &human(), first)
        .await
        .unwrap();
    f.files
        .insert("payload/demo.wasm".into(), b"changed".to_vec());
    let stage = installer.stage(&good(&f), &human(), "c2").unwrap();
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

#[test]
fn audit_failure_stops_before_stage() {
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
        installer.stage(&good(&f), &human(), "c"),
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
    let stage = installer.stage(&good(&f), &human(), "c").unwrap();
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
