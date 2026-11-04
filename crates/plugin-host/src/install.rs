//! Local package installation: verify, stage, approve, then switch the active version.
//! The active version is a small digest pointer replaced by same-directory rename. Version
//! directories are immutable, so an interrupted activation leaves the previous pointer valid.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use ring::rand::{SecureRandom, SystemRandom};
use security_types::{
    Action, AuditDecision, AuditEntry, AuditPrincipal, Authorizer, AuthzRequest, Decision, Digest,
    Outcome, Principal, PrincipalKind, Reason, Risk, TargetRef,
};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

use crate::audit::{AuditError, AuditSink, Clock};
use crate::package::{
    PackageError, PackageLimits, PackagePolicy, TrustStore, VerifiedPackage, verify_bytes,
};

// NOTE: Provisional names until the Plugin Host permission catalogue is fixed (spec question 25).
const INSTALL: &str = "plugin-host.packages.install";
const VERIFY_FAILED: &str = "plugin-host.packages.verify-failed";
const APPROVE: &str = "plugin-host.packages.approve";
const REJECT: &str = "plugin-host.packages.reject";
const ACTIVATE: &str = "plugin-host.packages.activate";
const ROLLBACK: &str = "plugin-host.packages.rollback";
const PERMISSION: &str = "admin.plugins.install";

#[derive(Debug)]
pub enum InstallError {
    Package(PackageError),
    Audit(AuditError),
    Io,
    Denied,
    DigestMismatch,
    NoPrevious,
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "plugin install failed: {self:?}")
    }
}
impl std::error::Error for InstallError {}

/// The data shown to the human before approval. `package_digest` binds approval to exact
/// verified signed bytes. No capability template is an effective runtime grant.
#[derive(Debug, Clone)]
pub struct ApprovalView {
    pub publisher: String,
    pub signer_key_hex: String,
    pub plugin_id: String,
    pub version: String,
    pub kind: crate::manifest::PackageKind,
    pub capabilities: crate::manifest::Capabilities,
    /// SHA-256 of the canonical v1 file encoding restricted to `payload/` entries.
    pub payload_digest: [u8; 32],
    pub package_digest: [u8; 32],
}

/// A local installer. The caller must provide an administrator-controlled install root and
/// trust store; this type never performs network I/O.
pub struct Installer<'a> {
    pub root: &'a Path,
    pub trust: &'a TrustStore,
    pub policy: &'a PackagePolicy,
    pub limits: PackageLimits,
    pub audit: &'a dyn AuditSink,
    pub clock: &'a dyn Clock,
}

/// A verified package staged under the install root. Dropping it removes the stage.
pub struct StagedInstall<'a> {
    installer: &'a Installer<'a>,
    stage: PathBuf,
    package: VerifiedPackage,
    principal: Principal,
    correlation_id: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn parse_digest(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return None;
    }
    let mut out = [0; 32];
    for (i, pair) in s.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        out[i] = (pair[0] as char).to_digit(16)? as u8 * 16 + (pair[1] as char).to_digit(16)? as u8;
    }
    Some(out)
}

#[allow(clippy::too_many_arguments)] // Keep all package audit entries behind this one helper.
fn audit(
    installer: &Installer<'_>,
    principal: &Principal,
    correlation: &str,
    action: &str,
    target: &str,
    digest: [u8; 32],
    decision: AuditDecision,
    outcome: Outcome,
) -> Result<(), InstallError> {
    installer
        .audit
        .append(AuditEntry {
            timestamp_unix_ms: installer.clock.now_unix_ms(),
            principal_chain: AuditPrincipal::chain_of(principal),
            tenant: principal.tenant.clone(),
            action: Action::new(action, PERMISSION),
            target: Some(TargetRef::plugin(target)),
            risk: Risk::Write,
            decision,
            approval_id: None,
            outcome,
            duration_ms: None,
            correlation_id: correlation.to_owned(),
            input_digest: Digest(digest),
            statement_digest: None,
        })
        .map_err(InstallError::Audit)
}

fn private_dir(root: &Path) -> Result<PathBuf, InstallError> {
    fs::create_dir_all(root).map_err(|_| InstallError::Io)?;
    for _ in 0..8 {
        let mut random = [0; 16];
        SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| InstallError::Io)?;
        let stage = root.join(format!(".stage-{}", hex(&random)));
        match fs::create_dir(&stage) {
            Ok(()) => return Ok(stage),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(InstallError::Io),
        }
    }
    Err(InstallError::Io)
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), InstallError> {
    let mut f = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| InstallError::Io)?;
    f.write_all(bytes)
        .and_then(|_| f.sync_all())
        .map_err(|_| InstallError::Io)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallState {
    active: Option<String>,
    previous: Option<String>,
}

fn read_state(base: &Path) -> Result<InstallState, InstallError> {
    let bytes = match fs::read(base.join("state.json")) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(InstallState::default()),
        Err(_) => return Err(InstallError::Io),
    };
    if bytes.len() > 256 {
        return Err(InstallError::Io);
    }
    let state: InstallState = serde_json::from_slice(&bytes).map_err(|_| InstallError::Io)?;
    if state
        .active
        .as_deref()
        .is_some_and(|s| parse_digest(s).is_none())
        || state
            .previous
            .as_deref()
            .is_some_and(|s| parse_digest(s).is_none())
    {
        return Err(InstallError::Io);
    }
    Ok(state)
}

fn atomic_state(base: &Path, state: &InstallState) -> Result<(), InstallError> {
    let path = base.join("state.json");
    let parent = path.parent().ok_or(InstallError::Io)?;
    let tmp = private_dir(parent)?;
    let temp_file = tmp.join("state.json");
    let result = (|| {
        let bytes = serde_json::to_vec(state).map_err(|_| InstallError::Io)?;
        write_file(&temp_file, &bytes)?;
        fs::rename(&temp_file, &path).map_err(|_| InstallError::Io)?;
        File::open(parent)
            .and_then(|f| f.sync_all())
            .map_err(|_| InstallError::Io)
    })();
    let _ = fs::remove_dir_all(tmp);
    result
}

impl<'a> Installer<'a> {
    /// Audit the request, verify the package, then write only verified files to a private stage.
    pub fn stage(
        &'a self,
        archive: &[u8],
        principal: &Principal,
        correlation_id: &str,
    ) -> Result<StagedInstall<'a>, InstallError> {
        let archive_digest: [u8; 32] = sha2::Sha256::digest(archive).into();
        audit(
            self,
            principal,
            correlation_id,
            INSTALL,
            "unverified",
            archive_digest,
            AuditDecision::Allow,
            Outcome::Success,
        )?;
        let package = match verify_bytes(archive, self.limits, self.trust, self.policy) {
            Ok(p) => p,
            Err(e) => {
                audit(
                    self,
                    principal,
                    correlation_id,
                    VERIFY_FAILED,
                    "unverified",
                    archive_digest,
                    AuditDecision::Deny {
                        reason: Reason::Policy {
                            message: format!("{e:?}"),
                        },
                    },
                    Outcome::Error {
                        code: format!("{e:?}"),
                    },
                )?;
                return Err(InstallError::Package(e));
            }
        };
        let stage = private_dir(self.root)?;
        let write_result = (|| {
            for (path, bytes) in package.files() {
                let destination = stage.join(path);
                if let Some(parent) = destination.parent() {
                    fs::create_dir_all(parent).map_err(|_| InstallError::Io)?;
                }
                write_file(&destination, bytes)?;
            }
            Ok::<(), InstallError>(())
        })();
        if let Err(e) = write_result {
            let _ = fs::remove_dir_all(&stage);
            return Err(e);
        }
        Ok(StagedInstall {
            installer: self,
            stage,
            package,
            principal: principal.clone(),
            correlation_id: correlation_id.to_owned(),
        })
    }

    /// Restore the previous known-good version by atomically changing the state file.
    pub async fn rollback<A: Authorizer>(
        &self,
        authorizer: &A,
        principal: &Principal,
        plugin_id: &str,
        correlation_id: &str,
    ) -> Result<(), InstallError> {
        if principal.kind != PrincipalKind::Human
            || principal.on_behalf_of.is_some()
            || !crate::manifest::is_plugin_id(plugin_id)
        {
            return Err(InstallError::Denied);
        }
        let base = self.root.join(plugin_id);
        let mut state = read_state(&base)?;
        let previous = state.previous.take().ok_or(InstallError::NoPrevious)?;
        let current = state
            .active
            .replace(previous.clone())
            .ok_or(InstallError::NoPrevious)?;
        state.previous = Some(current);
        let bytes = parse_digest(&previous).ok_or(InstallError::Io)?;
        let action = Action::new(ROLLBACK, PERMISSION);
        let target = TargetRef::plugin(plugin_id);
        let decision = authorizer
            .check(&AuthzRequest {
                principal,
                action: &action,
                target: Some(&target),
                risk: Risk::Write,
                input_digest: Digest(bytes),
            })
            .await;
        if !matches!(decision, Decision::Allow) {
            audit(
                self,
                principal,
                correlation_id,
                ROLLBACK,
                plugin_id,
                bytes,
                AuditDecision::from(&decision),
                Outcome::Error {
                    code: "PermissionDenied".into(),
                },
            )?;
            return Err(InstallError::Denied);
        }
        audit(
            self,
            principal,
            correlation_id,
            ROLLBACK,
            plugin_id,
            bytes,
            AuditDecision::Allow,
            Outcome::Success,
        )?;
        atomic_state(&base, &state)
    }
}

impl StagedInstall<'_> {
    pub fn approval_view(&self) -> ApprovalView {
        let p = &self.package;
        ApprovalView {
            publisher: p.manifest.publisher.clone(),
            signer_key_hex: hex(&p.signer_key),
            plugin_id: p.manifest.id.clone(),
            version: p.manifest.version.clone(),
            kind: p.manifest.kind,
            capabilities: p.manifest.capabilities.clone(),
            payload_digest: p.payload_digest,
            package_digest: p.digest,
        }
    }

    /// The caller presents `approval_view` and returns the exact digest it approved. Only a
    /// directly acting human can approve; `NeedsApproval` is a denial.
    pub async fn approve_and_activate<A: Authorizer>(
        self,
        authorizer: &A,
        approver: &Principal,
        approved_digest: [u8; 32],
    ) -> Result<(), InstallError> {
        let id = &self.package.manifest.id;
        if approver.kind != PrincipalKind::Human
            || approver.on_behalf_of.is_some()
            || approver.tenant != self.principal.tenant
        {
            audit(
                self.installer,
                approver,
                &self.correlation_id,
                REJECT,
                id,
                self.package.digest,
                AuditDecision::Deny {
                    reason: Reason::Policy {
                        message: "direct human approval required".into(),
                    },
                },
                Outcome::Error {
                    code: "PermissionDenied".into(),
                },
            )?;
            return Err(InstallError::Denied);
        }
        if approved_digest != self.package.digest {
            audit(
                self.installer,
                approver,
                &self.correlation_id,
                REJECT,
                id,
                self.package.digest,
                AuditDecision::Deny {
                    reason: Reason::Policy {
                        message: "package digest mismatch".into(),
                    },
                },
                Outcome::Error {
                    code: "DigestMismatch".into(),
                },
            )?;
            return Err(InstallError::DigestMismatch);
        }
        let action = Action::new(APPROVE, PERMISSION);
        let target = TargetRef::plugin(id);
        let decision = authorizer
            .check(&AuthzRequest {
                principal: approver,
                action: &action,
                target: Some(&target),
                risk: Risk::Write,
                input_digest: Digest(self.package.digest),
            })
            .await;
        if !matches!(decision, Decision::Allow) {
            audit(
                self.installer,
                approver,
                &self.correlation_id,
                REJECT,
                id,
                self.package.digest,
                AuditDecision::from(&decision),
                Outcome::Error {
                    code: "PermissionDenied".into(),
                },
            )?;
            return Err(InstallError::Denied);
        }
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            APPROVE,
            id,
            self.package.digest,
            AuditDecision::Allow,
            Outcome::Success,
        )?;
        let base = self.installer.root.join(id);
        let versions = base.join("versions");
        fs::create_dir_all(&versions).map_err(|_| InstallError::Io)?;
        let digest = hex(&self.package.digest);
        let version_path = versions.join(&digest);
        if version_path.exists() {
            return Err(InstallError::Io);
        }
        let mut state = read_state(&base)?;
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            ACTIVATE,
            id,
            self.package.digest,
            AuditDecision::Allow,
            Outcome::Success,
        )?;
        fs::rename(&self.stage, &version_path).map_err(|_| InstallError::Io)?;
        state.previous = state.active.replace(digest);
        if let Err(e) = atomic_state(&base, &state) {
            let _ = fs::remove_dir_all(&version_path);
            return Err(e);
        }
        Ok(())
    }

    pub fn reject(self, approver: &Principal) -> Result<(), InstallError> {
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            REJECT,
            &self.package.manifest.id,
            self.package.digest,
            AuditDecision::Deny {
                reason: Reason::Policy {
                    message: "human rejected package".into(),
                },
            },
            Outcome::Error {
                code: "Rejected".into(),
            },
        )
    }
}

impl Drop for StagedInstall<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.stage);
    }
}
