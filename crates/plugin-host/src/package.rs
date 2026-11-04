//! Offline `.bplugin` verification. No file is written until this module has verified the
//! archive, signature, checksums and manifest.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::Path;

use ring::signature::{self, UnparsedPublicKey};
use semver::{Version, VersionReq};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use zip::{CompressionMethod, ZipArchive};

use crate::manifest::{Manifest, ManifestError, PackageKind};

/// Versioned domain. The terminating NUL separates it from the following field.
pub const PACKAGE_DOMAIN: &[u8] = b"byterygon.plugin-host.package.v1\0";

/// Conservative, provisional archive limits (Plugin Host spec, question 37).
#[derive(Debug, Clone, Copy)]
pub struct PackageLimits {
    /// Maximum bytes in the ZIP archive itself.
    pub max_archive_bytes: u64,
    /// Maximum number of file entries. Directories are forbidden.
    pub max_entries: usize,
    /// Maximum decompressed bytes in one payload entry.
    pub max_entry_bytes: u64,
    /// Maximum decompressed bytes in all entries together.
    pub max_total_bytes: u64,
    /// Maximum decompressed bytes in a metadata file.
    pub max_metadata_bytes: u64,
    /// Maximum uncompressed to compressed ratio (zero-byte entries excepted).
    pub max_compression_ratio: u64,
}

impl Default for PackageLimits {
    fn default() -> Self {
        Self {
            max_archive_bytes: 72 * 1024 * 1024,
            max_entries: 256,
            max_entry_bytes: 32 * 1024 * 1024,
            max_total_bytes: 64 * 1024 * 1024,
            max_metadata_bytes: 1024 * 1024,
            max_compression_ratio: 100,
        }
    }
}

/// A public key pinned locally by an administrator. Package bytes never supply a key.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PinnedKey {
    /// Lowercase hexadecimal encoding of exactly 32 Ed25519 public-key bytes.
    pub public_key_hex: String,
    /// Empty means any plugin ID for this publisher; otherwise only these IDs are allowed.
    #[serde(default)]
    pub plugin_ids: BTreeSet<String>,
}

/// Local trust policy, loaded by the host from an administrator-controlled JSON file.
/// Rotation and revocation import can later replace this policy atomically.
/// Provisional format (spec question 38):
/// `{ "publishers": { "example": [{ "public_key_hex": "<64 lowercase hex>", "plugin_ids": [] }] } }`.
/// Empty `plugin_ids` allows all IDs under that publisher. The host must protect this file from
/// plugin and user writes; the package cannot change it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TrustStore {
    pub publishers: BTreeMap<String, Vec<PinnedKey>>,
}

impl TrustStore {
    pub fn from_local_file(path: &Path) -> Result<Self, PackageError> {
        let bytes = std::fs::read(path).map_err(|_| PackageError::TrustStore)?;
        if bytes.len() > 1024 * 1024 {
            return Err(PackageError::TrustStore);
        }
        let store: Self = serde_json::from_slice(&bytes).map_err(|_| PackageError::TrustStore)?;
        if store.publishers.values().any(|v| {
            v.is_empty()
                || v.iter()
                    .any(|k| decode_hex::<32>(&k.public_key_hex).is_none())
        }) {
            return Err(PackageError::TrustStore);
        }
        Ok(store)
    }
}

/// Admission policy supplied by the host; it grants no runtime capabilities.
#[derive(Debug, Clone)]
pub struct PackagePolicy {
    pub host_api: Version,
    /// Supported WIT interface package and version, e.g. `byterygon:db-driver@0.1.0`.
    pub interface: String,
    /// Exact OS/architecture string accepted for sidecars, e.g. `linux-x86_64`.
    pub platform: String,
    pub allow_third_party_sidecars: bool,
}

/// A verified package retained in memory until installation has been approved.
#[derive(Debug)]
pub struct VerifiedPackage {
    pub manifest: Manifest,
    /// SHA-256 of the exact archive bytes; this is the approval binding.
    pub digest: [u8; 32],
    /// SHA-256 of the canonical signed bytes, useful for comparing equivalent ZIP encodings.
    pub signed_digest: [u8; 32],
    pub signer_key: [u8; 32],
    pub payload_digest: [u8; 32],
    files: BTreeMap<String, Vec<u8>>,
}

impl VerifiedPackage {
    /// Verified files, excluding `signature.json`. The caller may write these into a private
    /// staging directory after approval checks are established.
    pub fn files(&self) -> &BTreeMap<String, Vec<u8>> {
        &self.files
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackageError {
    Archive,
    Path,
    Duplicate,
    EntryType,
    Layout,
    Limits,
    Compression,
    Missing(&'static str),
    Metadata,
    Unsigned,
    UntrustedPublisher,
    KeyNotAllowed,
    Signature,
    Checksum,
    Manifest,
    HostApi,
    KindOrPlatform,
    TrustStore,
}

impl fmt::Display for PackageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "package verification failed: {self:?}")
    }
}
impl std::error::Error for PackageError {}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SignatureFile {
    version: u32,
    publisher: String,
    signature_hex: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChecksumsFile {
    version: u32,
    files: BTreeMap<String, Checksum>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Checksum {
    size: u64,
    sha256: String,
}

fn decode_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2
        || !s
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    let mut out = [0; N];
    for (i, chunk) in s.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        out[i] =
            (chunk[0] as char).to_digit(16)? as u8 * 16 + (chunk[1] as char).to_digit(16)? as u8;
    }
    Some(out)
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// Canonical v1 signed-byte encoding, independent of ZIP ordering, compression and timestamps.
/// All paths are ASCII, slash separated, and sorted by raw bytes. Rejecting non-ASCII names
/// also rejects any pair that could collide under Unicode normalization.
/// `signature.json` is excluded. `checksums.json` is included in the signed bytes, but its own
/// checksum is omitted from that JSON to avoid a self-referential hash.
///
/// | Field | Encoding |
/// | --- | --- |
/// | Domain | literal `byterygon.plugin-host.package.v1` followed by NUL |
/// | File count | `u64` big-endian |
/// | Each path | `u64` big-endian byte length, then UTF-8 bytes |
/// | Each size | `u64` big-endian uncompressed byte count |
/// | Each digest | exactly 32 SHA-256 bytes |
pub fn canonical_bytes(entries: &BTreeMap<String, (u64, [u8; 32])>) -> Vec<u8> {
    let mut out = PACKAGE_DOMAIN.to_vec();
    out.extend_from_slice(&(entries.len() as u64).to_be_bytes());
    for (path, (size, digest)) in entries {
        out.extend_from_slice(&(path.len() as u64).to_be_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&size.to_be_bytes());
        out.extend_from_slice(digest);
    }
    out
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.is_ascii()
        && path.len() <= 256
        && !path.starts_with('/')
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != "..")
}

fn read_archive<R: Read + Seek>(
    mut reader: R,
    limits: PackageLimits,
) -> Result<BTreeMap<String, Vec<u8>>, PackageError> {
    // Bound the entry count before the ZIP crate allocates its name index.
    reader
        .seek(SeekFrom::End(-22))
        .map_err(|_| PackageError::Archive)?;
    let mut tail = [0u8; 22];
    reader
        .read_exact(&mut tail)
        .map_err(|_| PackageError::Archive)?;
    if &tail[..4] != b"PK\x05\x06" || tail[20..22] != [0, 0] {
        return Err(PackageError::Archive);
    }
    if u16::from_le_bytes([tail[10], tail[11]]) as usize > limits.max_entries {
        return Err(PackageError::Limits);
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| PackageError::Archive)?;
    let zip = ZipArchive::new(reader).map_err(|_| PackageError::Archive)?;
    // zip's name index collapses exact duplicates. Compare it with the original EOCD count,
    // and require a plain, comment-free ZIP with no prepended or trailing bytes.
    if !zip.comment().is_empty() || zip.offset() != 0 {
        return Err(PackageError::Archive);
    }
    let count = zip.len();
    let directory_start = zip.central_directory_start();
    let mut source = zip.into_inner();
    let archive_len = source
        .seek(SeekFrom::End(0))
        .map_err(|_| PackageError::Archive)?;
    if archive_len < 22 {
        return Err(PackageError::Archive);
    }
    source
        .seek(SeekFrom::End(-22))
        .map_err(|_| PackageError::Archive)?;
    let mut eocd = [0; 22];
    source
        .read_exact(&mut eocd)
        .map_err(|_| PackageError::Archive)?;
    if &eocd[..4] != b"PK\x05\x06" || eocd[20..22] != [0, 0] {
        return Err(PackageError::Archive);
    }
    let listed = u16::from_le_bytes([eocd[10], eocd[11]]) as usize;
    if u16::from_le_bytes([eocd[8], eocd[9]]) as usize != listed {
        return Err(PackageError::Archive);
    }
    if listed != count {
        return Err(if listed > count {
            PackageError::Duplicate
        } else {
            PackageError::Archive
        });
    }
    let directory_size =
        u32::from_le_bytes(eocd[12..16].try_into().map_err(|_| PackageError::Archive)?) as u64;
    let directory_offset =
        u32::from_le_bytes(eocd[16..20].try_into().map_err(|_| PackageError::Archive)?) as u64;
    if directory_offset != directory_start
        || directory_offset.checked_add(directory_size) != Some(archive_len - 22)
    {
        return Err(PackageError::Archive);
    }
    // The zip crate indexes by name, so exact duplicates can disappear from `len()`.
    // Scan only the central-directory envelope to catch aliases; the crate still owns parsing
    // ZIP entries, compression and CRC verification.
    source
        .seek(SeekFrom::Start(directory_start))
        .map_err(|_| PackageError::Archive)?;
    let mut central_seen = BTreeSet::new();
    for _ in 0..count {
        let mut header = [0u8; 46];
        source
            .read_exact(&mut header)
            .map_err(|_| PackageError::Archive)?;
        if &header[..4] != b"PK\x01\x02" {
            return Err(PackageError::Archive);
        }
        let name_len = u16::from_le_bytes([header[28], header[29]]) as usize;
        let extra_len = u16::from_le_bytes([header[30], header[31]]) as i64;
        let comment_len = u16::from_le_bytes([header[32], header[33]]) as i64;
        if name_len > 256 {
            return Err(PackageError::Path);
        }
        let mut name = vec![0; name_len];
        source
            .read_exact(&mut name)
            .map_err(|_| PackageError::Archive)?;
        let name = std::str::from_utf8(&name).map_err(|_| PackageError::Path)?;
        if !valid_path(name) {
            return Err(PackageError::Path);
        }
        if !central_seen.insert(name.to_ascii_lowercase()) {
            return Err(PackageError::Duplicate);
        }
        source
            .seek(SeekFrom::Current(extra_len + comment_len))
            .map_err(|_| PackageError::Archive)?;
        if source
            .stream_position()
            .map_err(|_| PackageError::Archive)?
            > archive_len - 22
        {
            return Err(PackageError::Archive);
        }
    }
    if source
        .stream_position()
        .map_err(|_| PackageError::Archive)?
        != archive_len - 22
    {
        return Err(PackageError::Archive);
    }
    let mut zip = ZipArchive::new(source).map_err(|_| PackageError::Archive)?;
    if zip
        .has_overlapping_files()
        .map_err(|_| PackageError::Archive)?
    {
        return Err(PackageError::Archive);
    }
    if zip.len() > limits.max_entries {
        return Err(PackageError::Limits);
    }
    let mut files = BTreeMap::new();
    let mut folded = BTreeSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|_| PackageError::Archive)?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| PackageError::Path)?
            .to_owned();
        if !valid_path(&name) {
            return Err(PackageError::Path);
        }
        let key = name.to_ascii_lowercase();
        if !folded.insert(key) {
            return Err(PackageError::Duplicate);
        }
        let mode = entry.unix_mode().unwrap_or(0o100644);
        if !entry.is_file() || (mode & 0o170000 != 0 && mode & 0o170000 != 0o100000) {
            return Err(PackageError::EntryType);
        }
        if !matches!(
            entry.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) || entry.encrypted()
        {
            return Err(PackageError::Compression);
        }
        let max = if name.starts_with("payload/") {
            limits.max_entry_bytes
        } else {
            limits.max_metadata_bytes.min(if name == "plugin.toml" {
                crate::manifest::MAX_MANIFEST_BYTES as u64
            } else {
                u64::MAX
            })
        };
        if entry.size() > max || total.saturating_add(entry.size()) > limits.max_total_bytes {
            return Err(PackageError::Limits);
        }
        if entry.size() > 0
            && (entry.compressed_size() == 0
                || entry.size() / entry.compressed_size() > limits.max_compression_ratio)
        {
            return Err(PackageError::Compression);
        }
        let compressed_size = entry.compressed_size();
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let n = entry.read(&mut chunk).map_err(|_| PackageError::Archive)?;
            if n == 0 {
                break;
            }
            total = total.checked_add(n as u64).ok_or(PackageError::Limits)?;
            if bytes.len().saturating_add(n) as u64 > max || total > limits.max_total_bytes {
                return Err(PackageError::Limits);
            }
            bytes.extend_from_slice(&chunk[..n]);
            if compressed_size == 0
                || (bytes.len() as u64) / compressed_size > limits.max_compression_ratio
            {
                return Err(PackageError::Compression);
            }
        }
        if bytes.len() as u64 != entry.size() {
            return Err(PackageError::Archive);
        }
        if files.insert(name, bytes).is_some() {
            return Err(PackageError::Duplicate);
        }
    }
    if !files.keys().all(|name| {
        name == "plugin.toml"
            || name == "sbom.spdx.json"
            || name == "checksums.json"
            || name == "signature.json"
            || name.starts_with("payload/")
    }) {
        return Err(PackageError::Layout);
    }
    for required in [
        "plugin.toml",
        "sbom.spdx.json",
        "checksums.json",
        "signature.json",
    ] {
        if !files.contains_key(required) {
            return Err(PackageError::Missing(required));
        }
    }
    if !files.keys().any(|p| p.starts_with("payload/")) {
        return Err(PackageError::Missing("payload/"));
    }
    Ok(files)
}

/// Verify a package completely before any extraction. `reader` can be a local file or memory;
/// this function never uses a network service.
pub fn verify<R: Read + Seek>(
    mut reader: R,
    limits: PackageLimits,
    trust: &TrustStore,
    policy: &PackagePolicy,
) -> Result<VerifiedPackage, PackageError> {
    let len = reader
        .seek(SeekFrom::End(0))
        .map_err(|_| PackageError::Archive)?;
    if len > limits.max_archive_bytes {
        return Err(PackageError::Limits);
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| PackageError::Archive)?;
    let mut archive_hash = Sha256::new();
    let mut chunk = [0; 8192];
    loop {
        let n = reader.read(&mut chunk).map_err(|_| PackageError::Archive)?;
        if n == 0 {
            break;
        }
        archive_hash.update(&chunk[..n]);
    }
    let archive_digest = archive_hash.finalize().into();
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| PackageError::Archive)?;
    let mut files = read_archive(reader, limits)?;
    let signature: SignatureFile =
        serde_json::from_slice(&files["signature.json"]).map_err(|_| PackageError::Unsigned)?;
    if signature.version != 1 {
        return Err(PackageError::Unsigned);
    }
    let sig = decode_hex::<64>(&signature.signature_hex).ok_or(PackageError::Unsigned)?;
    // Publisher is read only as a routing hint for pinned keys until its signed manifest is validated.
    let publisher = signature.publisher.as_str();
    let keys = trust
        .publishers
        .get(publisher)
        .ok_or(PackageError::UntrustedPublisher)?;
    let metadata: BTreeMap<_, _> = files
        .iter()
        .filter(|(p, _)| p.as_str() != "signature.json")
        .map(|(p, b)| (p.clone(), (b.len() as u64, sha(b))))
        .collect();
    let signed = canonical_bytes(&metadata);
    let signed_digest = sha(&signed);
    let mut allowed_key = None;
    for key in keys {
        let raw = decode_hex::<32>(&key.public_key_hex).ok_or(PackageError::TrustStore)?;
        if UnparsedPublicKey::new(&signature::ED25519, raw)
            .verify(&signed, &sig)
            .is_ok()
        {
            allowed_key = Some((raw, key));
            break;
        }
    }
    let (signer_key, key) = allowed_key.ok_or(PackageError::Signature)?;
    let checksums: ChecksumsFile =
        serde_json::from_slice(&files["checksums.json"]).map_err(|_| PackageError::Metadata)?;
    if checksums.version != 1 || checksums.files.len() + 1 != metadata.len() {
        return Err(PackageError::Checksum);
    }
    for (path, (size, hash)) in &metadata {
        if path == "checksums.json" {
            continue;
        }
        let check = checksums.files.get(path).ok_or(PackageError::Checksum)?;
        if check.size != *size || decode_hex::<32>(&check.sha256) != Some(*hash) {
            return Err(PackageError::Checksum);
        }
    }
    if !checksums
        .files
        .keys()
        .all(|p| metadata.contains_key(p) && p != "checksums.json")
    {
        return Err(PackageError::Checksum);
    }
    let sbom: serde_json::Value =
        serde_json::from_slice(&files["sbom.spdx.json"]).map_err(|_| PackageError::Metadata)?;
    if !sbom.is_object() {
        return Err(PackageError::Metadata);
    }
    let manifest_text =
        std::str::from_utf8(&files["plugin.toml"]).map_err(|_| PackageError::Manifest)?;
    let manifest =
        Manifest::from_toml(manifest_text).map_err(|_e: ManifestError| PackageError::Manifest)?;
    if manifest.publisher != publisher {
        return Err(PackageError::Signature);
    }
    if !key.plugin_ids.is_empty() && !key.plugin_ids.contains(&manifest.id) {
        return Err(PackageError::KeyNotAllowed);
    }
    let req = VersionReq::parse(&manifest.host_api).map_err(|_| PackageError::HostApi)?;
    if !req.matches(&policy.host_api) || Version::parse(&manifest.version).is_err() {
        return Err(PackageError::HostApi);
    }
    let (package_name, package_version) = manifest
        .interface
        .rsplit_once('@')
        .ok_or(PackageError::HostApi)?;
    let (supported_name, supported_version) = policy
        .interface
        .rsplit_once('@')
        .ok_or(PackageError::HostApi)?;
    let package_version = Version::parse(package_version).map_err(|_| PackageError::HostApi)?;
    let supported_version = Version::parse(supported_version).map_err(|_| PackageError::HostApi)?;
    if package_name != supported_name
        || package_version.major != supported_version.major
        || package_version.minor > supported_version.minor
    {
        return Err(PackageError::HostApi);
    }
    if !manifest.entry.starts_with("payload/") || !files.contains_key(&manifest.entry) {
        return Err(PackageError::Layout);
    }
    if manifest.kind == PackageKind::Sidecar
        && (manifest.publisher != "byterygon" && !policy.allow_third_party_sidecars)
    {
        return Err(PackageError::KindOrPlatform);
    }
    if manifest.kind == PackageKind::Sidecar {
        if manifest.platform.as_deref() != Some(policy.platform.as_str())
            || policy.platform.is_empty()
        {
            return Err(PackageError::KindOrPlatform);
        }
    } else if manifest.platform.is_some() {
        return Err(PackageError::KindOrPlatform);
    }
    let payload_metadata: BTreeMap<_, _> = metadata
        .iter()
        .filter(|(path, _)| path.starts_with("payload/"))
        .map(|(path, entry)| (path.clone(), *entry))
        .collect();
    files.remove("signature.json");
    Ok(VerifiedPackage {
        manifest,
        digest: archive_digest,
        signed_digest,
        signer_key,
        payload_digest: sha(&canonical_bytes(&payload_metadata)),
        files,
    })
}

/// Verify bytes held in memory, useful for offline callers and tests.
pub fn verify_bytes(
    bytes: &[u8],
    limits: PackageLimits,
    trust: &TrustStore,
    policy: &PackagePolicy,
) -> Result<VerifiedPackage, PackageError> {
    verify(Cursor::new(bytes), limits, trust, policy)
}
