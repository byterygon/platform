//! Local package installation: verify, stage, approve, then switch the active version.
//! The active version is a small digest pointer replaced by same-directory rename. Version
//! directories are immutable, so an interrupted activation leaves the previous pointer valid.
//!
//! # Upgrades (Plugin Host spec, question 39)
//!
//! Installing a package creates no runtime grant. When a new version of an installed plugin is
//! activated, its requested permissions are compared with the active version's
//! ([`PermissionDiff`]), under the per-plugin lock:
//!
//! - equal or narrower: activation proceeds with the usual approval;
//! - wider (an added capability, a widened field, or a changed package kind): activation is
//!   refused with [`InstallError::PermissionsWidened`] unless the approval
//!   ([`Approval::widened_permissions`]) names exactly the widening computed at activation, so a
//!   direct human approval covers the new permission set.
//!
//! With a [`GrantStore`] in [`HostHooks`], activation carries the old version's connection grants
//! over to the new version (dropping what it no longer requests) and rollback restores the
//! previous version's grant set; see [`GrantStore`] for the rules. The grant switch happens after
//! the state file is committed, under the same per-plugin lock.
//!
//! The two steps are not one atomic change, and the gap between them fails closed: the broker
//! lets a caller use a grant only when the grant's plugin digest equals the caller's digest. After
//! the commit and before the switch, a caller of the new version finds only grants bound to the
//! old digest and is denied; a caller of the old version that is still running keeps the grants
//! it had until the switch supersedes them (it never gains one). Switching the grants first would
//! be worse: a commit that then failed would leave grants moved to a version that never became
//! active. If the process stops between the two, the state file is ahead and the in-memory grant
//! set is gone anyway (see [`GrantStore`]), so the new version starts without grants.
//!
//! A directory sync that fails after the state file was renamed does not undo the switch: the
//! new version is active, so the grants follow it and the result carries
//! [`SwitchWarning::DirectorySyncFailed`] instead of an error, and an
//! [`InstallAlert::SwitchSyncFailed`] is raised on [`HostHooks::alerts`], so the failure is
//! visible even to a caller that ignores the warnings.
//!
//! # Audit of grant carry-over and restore (Plugin Host spec, question 42)
//!
//! Every grant carried over by an upgrade is recorded with the action [`CARRY_GRANT_ACTION`], and
//! every grant restored by a rollback with [`RESTORE_GRANT_ACTION`], one entry per grant. The
//! entry shows the action, the connection target, the plugin with its new digest
//! (`plugin:<id>#sha256:<digest>`, as in broker entries) acting for the person who switched
//! versions, and in `approval_id` the grant relied on (`<old id>><new id>` for a carry-over, the
//! grant id for a restore). The source and destination version, both grant ids, the connection,
//! the original approver and the expiry are committed in `input_digest`
//! ([`grant_switch_digest`]), as for grant creation.
//!
//! The entry and the grant take effect together: the grant becomes active only after its entry
//! was written, under the lock of its target (see [`GrantStore`]). A carry-over follows the rule
//! of activation: if its entry cannot be written, the grant is not carried
//! ([`GrantSwitch::audit_failed`]; it stays parked, so a rollback restores it), while the
//! version switch itself, already audited, stands. A restore follows the rule of rollback below.
//!
//! # Audit failures (Plugin Host spec, question 41)
//!
//! Install, approve, reject and activate fail closed: if an audit entry cannot be written, the
//! step is not performed. Rollback is the exception, so an administrator can always return to the
//! known-good version: when the primary audit sink fails, the same entry is appended to the local
//! fallback file [`FALLBACK_AUDIT_FILE`] under the install root, an [`InstallAlert`] is raised on
//! [`HostHooks::alerts`], and the rollback returns an [`AuditWarning`]. If the fallback write
//! fails too, the rollback still proceeds and the warning says both sinks failed. The same holds
//! for the entry of each restored grant ([`Rollback::restore_audit_warnings`]): a rollback
//! restores the grants of the known-good version even when the audit sink is down. A rollback
//! that is refused is not performed, so its entry is fail-closed.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use ring::rand::{SecureRandom, SystemRandom};
use security_types::{
    Action, AuditDecision, AuditEntry, AuditPrincipal, Authorizer, AuthzRequest, Decision, Digest,
    Outcome, Principal, PrincipalKind, Reason, Risk, TargetRef, append_within,
};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;

use crate::audit::{AuditError, AuditSink, Clock};
use crate::grant::{
    ActivateOutcome, Candidate, DEFAULT_AUDIT_TIMEOUT, GRANT_CARRY_DIGEST_DOMAIN,
    GRANT_RESTORE_DIGEST_DOMAIN, GrantStore, GrantSwitch, GrantSwitchRecord, InstalledPlugin,
    grant_switch_digest,
};
use crate::manifest::{Capabilities, Manifest, PermissionDelta, PermissionDiff};
use crate::package::{
    PackageError, PackageLimits, PackagePolicy, TrustStore, VerifiedPackage, verify_bytes,
};

/// The local, append-only fallback audit file under the install root, used only when the
/// primary sink fails during a rollback. One JSON-encoded [`AuditEntry`] per line, not hash
/// chained; an administrator imports it into the audit store once the primary sink is back.
pub const FALLBACK_AUDIT_FILE: &str = ".audit-fallback.jsonl";

/// Receives alerts the installer raises. Implementations must not block and must not perform
/// network I/O on the caller's thread.
pub trait AlertSink: Send + Sync {
    fn alert(&self, alert: &InstallAlert);
}

/// An event the host should surface to an administrator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallAlert {
    /// A rollback audit entry could not be written to the primary audit sink.
    RollbackAuditFallback {
        plugin_id: String,
        correlation_id: String,
        warning: AuditWarning,
    },
    /// The state file was renamed but syncing the install directory failed (see
    /// [`SwitchWarning::DirectorySyncFailed`]).
    SwitchSyncFailed {
        plugin_id: String,
        correlation_id: String,
    },
}

/// Why a rollback's audit entry did not reach the primary audit sink.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditWarning {
    /// The primary sink failed; the entry was appended to the fallback file at `fallback`.
    PrimaryFailed {
        primary: AuditError,
        fallback: PathBuf,
    },
    /// The primary sink and the fallback file both failed; the entry was not recorded.
    BothFailed {
        primary: AuditError,
        fallback: String,
    },
}

/// Host services used when the active version changes. Both are optional: without a grant store
/// no grant is carried over or restored, and without an alert sink the rollback warning is only
/// returned to the caller.
#[derive(Clone, Copy, Default)]
pub struct HostHooks<'h> {
    pub grants: Option<&'h GrantStore>,
    pub alerts: Option<&'h dyn AlertSink>,
    /// Replaces the directory `fsync` after the state file is renamed. For tests that inject a
    /// failure; leave it `None`.
    #[doc(hidden)]
    pub directory_sync: Option<fn(&Path) -> std::io::Result<()>>,
}

/// Something an administrator should know about a version switch that succeeded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SwitchWarning {
    /// The manifest of the version that was active could not be read, so its permissions could
    /// not be compared with the new version's and no grant was carried over: the old grants stay
    /// parked, and every connection needs a new approval.
    PreviousManifestUnreadable,
    /// The state file was renamed (the new version is active) but syncing the directory failed,
    /// so the switch may not survive a power loss.
    DirectorySyncFailed,
    /// Some grants were not carried over because their audit entry could not be written (see
    /// [`GrantSwitch::audit_failed`]).
    GrantsNotCarriedAuditFailed,
}

/// What the approver approves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    /// The [`ApprovalView::package_digest`] that was shown.
    pub package_digest: [u8; 32],
    /// The widening the approver was shown ([`UpgradeView::permissions`]`.widened`). Required,
    /// and must match exactly, when the package requests more than the active version; ignored
    /// otherwise.
    pub widened_permissions: Vec<PermissionDelta>,
}

impl Approval {
    /// Approval of a package that does not widen the active version's permissions.
    pub fn package(package_digest: [u8; 32]) -> Self {
        Self {
            package_digest,
            widened_permissions: Vec::new(),
        }
    }
}

/// The result of an activation.
#[derive(Debug, Clone)]
pub struct Activation {
    /// The now-active version, as the grant store and broker identify it.
    pub plugin: InstalledPlugin,
    /// The version it replaced and how the permissions changed, for an upgrade.
    pub upgrade: Option<UpgradeView>,
    /// What happened to connection grants, when a grant store was given.
    pub grants: Option<GrantSwitch>,
    pub warnings: Vec<SwitchWarning>,
}

/// The result of a rollback.
#[derive(Debug, Clone)]
pub struct Rollback {
    /// Package digest of the version that is active again.
    pub active_digest: [u8; 32],
    /// What happened to connection grants, when a grant store was given.
    pub grants: Option<GrantSwitch>,
    /// Set when an audit entry of this rollback missed the primary audit sink.
    pub audit_warning: Option<AuditWarning>,
    /// One per restored grant whose audit entry missed the primary sink (question 41 applies to
    /// them too: the grant was restored regardless).
    pub restore_audit_warnings: Vec<AuditWarning>,
    pub warnings: Vec<SwitchWarning>,
}

// NOTE: Provisional names until the Plugin Host permission catalogue is fixed (spec question 25).
const INSTALL: &str = "plugin-host.packages.install";
const VERIFY_FAILED: &str = "plugin-host.packages.verify-failed";
const APPROVE: &str = "plugin-host.packages.approve";
const REJECT: &str = "plugin-host.packages.reject";
const ACTIVATE: &str = "plugin-host.packages.activate";
const ROLLBACK: &str = "plugin-host.packages.rollback";
/// Action of the entry written for each grant an upgrade carries over (spec question 42).
pub const CARRY_GRANT_ACTION: &str = "plugin-host.packages.carry-grant";
/// Action of the entry written for each grant a rollback restores (spec question 42).
pub const RESTORE_GRANT_ACTION: &str = "plugin-host.packages.restore-grant";
const PERMISSION: &str = "admin.plugins.install";

#[derive(Debug)]
pub enum InstallError {
    Package(PackageError),
    Audit(AuditError),
    Io,
    Denied,
    DigestMismatch,
    NoPrevious,
    /// The package requests permissions beyond the active version's, and the approval does not
    /// cover exactly this widening.
    PermissionsWidened(PermissionDiff),
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
    /// Set when another version of the plugin was active at staging time. Activation compares
    /// again under the plugin lock, against whatever is active then.
    pub upgrade: Option<UpgradeView>,
}

/// An upgrade of an installed plugin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpgradeView {
    /// Package digest of the version being replaced.
    pub from_digest: [u8; 32],
    pub permissions: PermissionDiff,
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
    upgrade: Option<UpgradeView>,
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

/// What [`audit`] does when the primary sink fails.
#[derive(Clone, Copy)]
enum OnAuditFailure<'h> {
    /// Return [`InstallError::Audit`]; the caller does not perform the step.
    FailClosed,
    /// Rollback only (question 41): append to the fallback file, raise an alert, and return a
    /// warning instead of an error.
    Fallback(Option<&'h dyn AlertSink>),
}

/// Records one package entry; the caller stops (fails closed) if it is not written within
/// [`DEFAULT_AUDIT_TIMEOUT`], so a sink that hangs fails the step instead of holding it (and,
/// for an approval, the plugin's install lock) forever. For a rollback the failure is handled
/// by the fallback instead (see [`OnAuditFailure`]).
#[allow(clippy::too_many_arguments)] // Keep all package audit entries behind this one helper.
async fn audit(
    installer: &Installer<'_>,
    principal: &Principal,
    correlation: &str,
    action: &str,
    target: &str,
    digest: [u8; 32],
    decision: AuditDecision,
    outcome: Outcome,
    on_failure: OnAuditFailure<'_>,
) -> Result<Option<AuditWarning>, InstallError> {
    let entry = AuditEntry {
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
        delivery: None,
        parent_correlation_id: None,
    };
    emit(installer, entry, target, on_failure).await
}

/// Writes one entry: the only place the installer talks to the audit sink or the fallback file.
async fn emit(
    installer: &Installer<'_>,
    entry: AuditEntry,
    plugin_id: &str,
    on_failure: OnAuditFailure<'_>,
) -> Result<Option<AuditWarning>, InstallError> {
    let deadline = tokio::time::Instant::now() + DEFAULT_AUDIT_TIMEOUT;
    let alerts = match on_failure {
        OnAuditFailure::FailClosed => {
            return append_within(installer.audit, entry, deadline)
                .await
                .map(|()| None)
                .map_err(InstallError::Audit);
        }
        OnAuditFailure::Fallback(alerts) => alerts,
    };
    let Err(primary) = append_within(installer.audit, entry.clone(), deadline).await else {
        return Ok(None);
    };
    let warning = match append_fallback(installer.root, &entry) {
        Ok(fallback) => AuditWarning::PrimaryFailed { primary, fallback },
        Err(fallback) => AuditWarning::BothFailed { primary, fallback },
    };
    if let Some(alerts) = alerts {
        alerts.alert(&InstallAlert::RollbackAuditFallback {
            plugin_id: plugin_id.to_owned(),
            correlation_id: entry.correlation_id.clone(),
            warning: warning.clone(),
        });
    }
    Ok(Some(warning))
}

/// Append one entry to [`FALLBACK_AUDIT_FILE`] with a single write, then sync it.
fn append_fallback(root: &Path, entry: &AuditEntry) -> Result<PathBuf, String> {
    let path = root.join(FALLBACK_AUDIT_FILE);
    let mut line = serde_json::to_vec(entry).map_err(|e| e.to_string())?;
    line.push(b'\n');
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    let mut file = options.open(&path).map_err(|e| e.to_string())?;
    file.write_all(&line)
        .and_then(|()| file.sync_data())
        .map_err(|e| e.to_string())?;
    Ok(path)
}

/// The manifest of an installed version, read back from its immutable version directory.
fn installed_manifest(base: &Path, digest_hex: &str) -> Result<Manifest, InstallError> {
    let max = PackageLimits::HARD_CEILING.max_manifest_bytes;
    let path = base.join("versions").join(digest_hex).join("plugin.toml");
    let file = File::open(path).map_err(|_| InstallError::Io)?;
    let mut text = String::new();
    std::io::Read::read_to_string(&mut std::io::Read::take(file, max + 1), &mut text)
        .map_err(|_| InstallError::Io)?;
    Manifest::from_toml_limited(&text, max as usize).map_err(|_| InstallError::Io)
}

/// What activation knows about the version that is active, read under the plugin lock.
#[derive(Default)]
struct Basis {
    from_digest: Option<[u8; 32]>,
    /// The manifest `version` of the active version, when it could be read.
    from_version: Option<String>,
    capabilities: Option<Capabilities>,
    view: Option<UpgradeView>,
    /// A version is active but its manifest could not be read.
    unreadable: bool,
}

/// The upgrade from the version active in `state`, if any. An unreadable manifest of the active
/// version does not fail: the new version can still be installed, as if nothing were active
/// (no permission comparison, no grants carried), and the caller is warned.
fn upgrade_from(base: &Path, state: &InstallState, new: &Manifest) -> Result<Basis, InstallError> {
    let Some(active) = state.active.as_deref() else {
        return Ok(Basis::default());
    };
    let from_digest = parse_digest(active).ok_or(InstallError::Io)?;
    Ok(match installed_manifest(base, active) {
        Ok(old) => Basis {
            from_digest: Some(from_digest),
            from_version: Some(old.version.clone()),
            view: Some(UpgradeView {
                from_digest,
                permissions: PermissionDiff::between(&old, new),
            }),
            capabilities: Some(old.capabilities),
            unreadable: false,
        },
        Err(_) => Basis {
            from_digest: Some(from_digest),
            unreadable: true,
            ..Basis::default()
        },
    })
}

/// Writes the audit entry of one grant carried over or restored, and switches the grants.
struct SwitchAudit<'a> {
    installer: &'a Installer<'a>,
    /// Whoever switched the versions.
    actor: &'a Principal,
    correlation: &'a str,
    plugin_id: &'a str,
    from_digest: Digest,
    from_version: &'a str,
    to_digest: Digest,
    to_version: &'a str,
}

impl SwitchAudit<'_> {
    /// The entry for `candidate`: see the module docs for what it shows and what it commits to.
    async fn record(
        &self,
        action: &'static str,
        domain: &'static str,
        candidate: &Candidate,
        on_failure: OnAuditFailure<'_>,
    ) -> Result<Option<AuditWarning>, InstallError> {
        let (old, new) = (&candidate.source, &candidate.grant);
        let mut chain = vec![AuditPrincipal {
            kind: PrincipalKind::Plugin,
            id: format!("plugin:{}#sha256:{}", self.plugin_id, self.to_digest),
            tenant: self.actor.tenant.clone(),
            session: self.actor.session.clone(),
        }];
        chain.extend(AuditPrincipal::chain_of(self.actor));
        let input_digest = grant_switch_digest(
            domain,
            &GrantSwitchRecord {
                plugin_id: self.plugin_id,
                from_digest: self.from_digest,
                from_version: self.from_version,
                to_digest: self.to_digest,
                to_version: self.to_version,
                old,
                new,
            },
        );
        let entry = AuditEntry {
            timestamp_unix_ms: self.installer.clock.now_unix_ms(),
            principal_chain: chain,
            tenant: new.tenant.clone(),
            action: Action::new(action, PERMISSION),
            target: Some(TargetRef::connection(&new.target_id)),
            risk: Risk::Write,
            decision: AuditDecision::Allow,
            approval_id: Some(if old.id == new.id {
                new.id.to_string()
            } else {
                format!("{}>{}", old.id, new.id)
            }),
            outcome: Outcome::Success,
            duration_ms: None,
            correlation_id: self.correlation.to_owned(),
            input_digest,
            statement_digest: None,
            delivery: None,
            parent_correlation_id: None,
        };
        emit(self.installer, entry, self.plugin_id, on_failure).await
    }

    /// Activate each carried grant after its entry. An entry that cannot be written means that
    /// grant is not carried (fail closed).
    async fn carry_all(
        &self,
        store: &GrantStore,
        candidates: Vec<Candidate>,
        mut out: GrantSwitch,
    ) -> GrantSwitch {
        for c in &candidates {
            let outcome = store
                .activate_audited(c, || {
                    self.record(
                        CARRY_GRANT_ACTION,
                        GRANT_CARRY_DIGEST_DOMAIN,
                        c,
                        OnAuditFailure::FailClosed,
                    )
                })
                .await;
            match outcome {
                ActivateOutcome::Activated(_) => {
                    if c.narrowed {
                        out.narrowed.push(c.grant.id.clone());
                    }
                    out.carried.push((c.source.id.clone(), c.grant.id.clone()));
                }
                ActivateOutcome::Skipped => out.dropped.push(c.source.id.clone()),
                ActivateOutcome::Refused(e) => {
                    out.audit_failed.push((c.source.id.clone(), audit_error(e)))
                }
            }
        }
        out
    }

    /// Reactivate each parked grant after its entry. The entry falls back to the local file and
    /// an alert instead of failing (question 41), so a failing sink does not stop the restore;
    /// the warnings say where the entries went.
    async fn restore_all(
        &self,
        store: &GrantStore,
        alerts: Option<&dyn AlertSink>,
        candidates: Vec<Candidate>,
        mut out: GrantSwitch,
    ) -> (GrantSwitch, Vec<AuditWarning>) {
        let mut warnings = Vec::new();
        for c in &candidates {
            let outcome = store
                .activate_audited(c, || {
                    self.record(
                        RESTORE_GRANT_ACTION,
                        GRANT_RESTORE_DIGEST_DOMAIN,
                        c,
                        OnAuditFailure::Fallback(alerts),
                    )
                })
                .await;
            match outcome {
                ActivateOutcome::Activated(warning) => {
                    out.restored.push(c.grant.id.clone());
                    warnings.extend(warning);
                }
                ActivateOutcome::Skipped => out.not_restored.push(c.grant.id.clone()),
                // The fallback never refuses; kept so the match is exhaustive and fails closed.
                ActivateOutcome::Refused(e) => {
                    out.audit_failed.push((c.grant.id.clone(), audit_error(e)))
                }
            }
        }
        (out, warnings)
    }
}

fn audit_error(e: InstallError) -> AuditError {
    match e {
        InstallError::Audit(e) => e,
        other => AuditError(other.to_string()),
    }
}

fn default_directory_sync(parent: &Path) -> std::io::Result<()> {
    File::open(parent).and_then(|f| f.sync_all())
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

/// Lock a plugin's state across installer instances and processes. The lock file is deliberately
/// retained so a second process always locks the same inode. The install root is admin-owned.
fn lock_plugin(base: &Path) -> Result<File, InstallError> {
    fs::create_dir_all(base).map_err(|_| InstallError::Io)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(base.join(".mutation.lock"))
        .map_err(|_| InstallError::Io)?;
    file.lock().map_err(|_| InstallError::Io)?;
    Ok(file)
}

async fn lock_plugin_async(base: PathBuf) -> Result<File, InstallError> {
    tokio::task::spawn_blocking(move || lock_plugin(&base))
        .await
        .map_err(|_| InstallError::Io)?
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

#[derive(Debug)]
struct StateCommitError {
    /// The rename made the new state visible, even if the following directory sync failed.
    published: bool,
}

fn atomic_state_with_sync(
    base: &Path,
    state: &InstallState,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<(), StateCommitError> {
    let path = base.join("state.json");
    let parent = path.parent().ok_or(StateCommitError { published: false })?;
    let tmp = private_dir(parent).map_err(|_| StateCommitError { published: false })?;
    let temp_file = tmp.join("state.json");
    let result = (|| {
        let bytes = serde_json::to_vec(state).map_err(|_| StateCommitError { published: false })?;
        write_file(&temp_file, &bytes).map_err(|_| StateCommitError { published: false })?;
        fs::rename(&temp_file, &path).map_err(|_| StateCommitError { published: false })?;
        sync_parent(parent).map_err(|_| StateCommitError { published: true })
    })();
    let _ = fs::remove_dir_all(tmp);
    result
}

#[cfg(test)]
fn atomic_state(base: &Path, state: &InstallState) -> Result<(), StateCommitError> {
    atomic_state_with_sync(base, state, |parent| {
        File::open(parent).and_then(|f| f.sync_all())
    })
}

fn commit_activation(
    base: &Path,
    version_path: &Path,
    state: &InstallState,
    sync_parent: impl FnOnce(&Path) -> std::io::Result<()>,
) -> Result<CommitOutcome, InstallError> {
    match atomic_state_with_sync(base, state, sync_parent) {
        Ok(()) => Ok(CommitOutcome::Synced),
        // After the rename state.json points here, so the version stays on disk and the switch
        // stands; only the durability of the directory entry is in doubt.
        Err(StateCommitError { published: true }) => Ok(CommitOutcome::SyncFailed),
        Err(StateCommitError { published: false }) => {
            // The old state is still active, so this version is an unreferenced stage.
            let _ = fs::remove_dir_all(version_path);
            Err(InstallError::Io)
        }
    }
}

/// A state commit that took effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CommitOutcome {
    Synced,
    /// The rename happened but syncing the directory failed.
    SyncFailed,
}

impl<'a> Installer<'a> {
    /// Audit the request, verify the package, then write only verified files to a private stage.
    pub async fn stage(
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
            OnAuditFailure::FailClosed,
        )
        .await?;
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
                    OnAuditFailure::FailClosed,
                )
                .await?;
                return Err(InstallError::Package(e));
            }
        };
        // Informational for the approval view; activation compares again under the lock.
        let base = self.root.join(&package.manifest.id);
        let upgrade = upgrade_from(&base, &read_state(&base)?, &package.manifest)?.view;
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
            upgrade,
        })
    }

    /// Restore the previous known-good version by atomically changing the state file, without
    /// grant or alert hooks. See [`rollback_with`](Self::rollback_with).
    pub async fn rollback<A: Authorizer>(
        &self,
        authorizer: &A,
        principal: &Principal,
        plugin_id: &str,
        correlation_id: &str,
    ) -> Result<Rollback, InstallError> {
        self.rollback_with(
            authorizer,
            principal,
            plugin_id,
            correlation_id,
            HostHooks::default(),
        )
        .await
    }

    /// Restore the previous known-good version by atomically changing the state file, then (with
    /// a grant store) restore that version's grant set.
    ///
    /// Audit failures do not stop a rollback (question 41): see the [module docs](self). The
    /// authorization check and the direct-human requirement still apply.
    pub async fn rollback_with<A: Authorizer>(
        &self,
        authorizer: &A,
        principal: &Principal,
        plugin_id: &str,
        correlation_id: &str,
        hooks: HostHooks<'_>,
    ) -> Result<Rollback, InstallError> {
        let on_failure = OnAuditFailure::Fallback(hooks.alerts);
        if principal.kind != PrincipalKind::Human
            || principal.on_behalf_of.is_some()
            || !crate::manifest::is_plugin_id(plugin_id)
        {
            return Err(InstallError::Denied);
        }
        let base = self.root.join(plugin_id);
        let _lock = lock_plugin_async(base.clone()).await?;
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
                // The exception of question 41 is for a rollback that is performed.
                OnAuditFailure::FailClosed,
            )
            .await?;
            return Err(InstallError::Denied);
        }
        let audit_warning = audit(
            self,
            principal,
            correlation_id,
            ROLLBACK,
            plugin_id,
            bytes,
            AuditDecision::Allow,
            Outcome::Success,
            on_failure,
        )
        .await?;
        let from = state
            .previous
            .as_deref()
            .and_then(parse_digest)
            .ok_or(InstallError::Io)?;
        let sync = hooks.directory_sync.unwrap_or(default_directory_sync);
        let mut warnings = Vec::new();
        // If the rename happened, the previous version is active even when the directory sync
        // failed, so the grants follow it and the caller is warned.
        match atomic_state_with_sync(&base, &state, sync) {
            Ok(()) => {}
            Err(StateCommitError { published: true }) => {
                warnings.push(SwitchWarning::DirectorySyncFailed);
            }
            Err(StateCommitError { published: false }) => return Err(InstallError::Io),
        }
        if warnings.contains(&SwitchWarning::DirectorySyncFailed)
            && let Some(alerts) = hooks.alerts
        {
            alerts.alert(&InstallAlert::SwitchSyncFailed {
                plugin_id: plugin_id.to_owned(),
                correlation_id: correlation_id.to_owned(),
            });
        }
        let mut restore_audit_warnings = Vec::new();
        let grants = match hooks.grants {
            Some(store) => {
                let (candidates, switch) =
                    store.begin_roll_back(plugin_id, Digest(from), Digest(bytes));
                let from_version = installed_manifest(&base, &hex(&from))
                    .map(|m| m.version)
                    .unwrap_or_default();
                let to_version = installed_manifest(&base, &hex(&bytes))
                    .map(|m| m.version)
                    .unwrap_or_default();
                let switch_audit = SwitchAudit {
                    installer: self,
                    actor: principal,
                    correlation: correlation_id,
                    plugin_id,
                    from_digest: Digest(from),
                    from_version: &from_version,
                    to_digest: Digest(bytes),
                    to_version: &to_version,
                };
                let (switch, restore_warnings) = switch_audit
                    .restore_all(store, hooks.alerts, candidates, switch)
                    .await;
                restore_audit_warnings = restore_warnings;
                Some(switch)
            }
            None => None,
        };
        Ok(Rollback {
            active_digest: bytes,
            grants,
            audit_warning,
            restore_audit_warnings,
            warnings,
        })
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
            upgrade: self.upgrade.clone(),
        }
    }

    /// The caller presents `approval_view` and returns the exact digest it approved. Only a
    /// directly acting human can approve; `NeedsApproval` is a denial. Equivalent to
    /// [`activate`](Self::activate) with [`Approval::package`] and no hooks, so an upgrade that
    /// widens permissions is refused.
    pub async fn approve_and_activate<A: Authorizer>(
        self,
        authorizer: &A,
        approver: &Principal,
        approved_digest: [u8; 32],
    ) -> Result<Activation, InstallError> {
        self.activate(
            authorizer,
            approver,
            Approval::package(approved_digest),
            HostHooks::default(),
        )
        .await
    }

    /// Approve and activate. On an upgrade that widens permissions, `approval` must name exactly
    /// the widening (see the [module docs](self)). With a grant store in `hooks`, the old
    /// version's grants are carried over after the state file is committed.
    pub async fn activate<A: Authorizer>(
        self,
        authorizer: &A,
        approver: &Principal,
        approval: Approval,
        hooks: HostHooks<'_>,
    ) -> Result<Activation, InstallError> {
        let approved_digest = approval.package_digest;
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
                OnAuditFailure::FailClosed,
            )
            .await?;
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
                OnAuditFailure::FailClosed,
            )
            .await?;
            return Err(InstallError::DigestMismatch);
        }
        // Refuse early when the widening seen at staging is not approved; checked again below.
        self.check_widening(approver, self.upgrade.as_ref(), &approval)
            .await?;
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
                OnAuditFailure::FailClosed,
            )
            .await?;
            return Err(InstallError::Denied);
        }
        let base = self.installer.root.join(id);
        let _lock = lock_plugin_async(base.clone()).await?;
        let mut state = read_state(&base)?;
        // The version active now, under the lock, is the one the permissions are compared with.
        // This is checked before the approval is recorded, so a refusal never leaves an
        // `approve` entry that says the package was approved.
        let basis = upgrade_from(&base, &state, &self.package.manifest)?;
        self.check_widening(approver, basis.view.as_ref(), &approval)
            .await?;
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            APPROVE,
            id,
            self.package.digest,
            AuditDecision::Allow,
            Outcome::Success,
            OnAuditFailure::FailClosed,
        )
        .await?;
        let versions = base.join("versions");
        fs::create_dir_all(&versions).map_err(|_| InstallError::Io)?;
        let digest = hex(&self.package.digest);
        let version_path = versions.join(&digest);
        if version_path.exists() {
            return Err(InstallError::Io);
        }
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            ACTIVATE,
            id,
            self.package.digest,
            AuditDecision::Allow,
            Outcome::Success,
            OnAuditFailure::FailClosed,
        )
        .await?;
        fs::rename(&self.stage, &version_path).map_err(|_| InstallError::Io)?;
        state.previous = state.active.replace(digest);
        let sync = hooks.directory_sync.unwrap_or(default_directory_sync);
        // If the rename happened, the new version is active even when the directory sync failed,
        // so the grants follow it and the caller is warned instead of getting an error.
        let committed = commit_activation(&base, &version_path, &state, sync)?;
        let plugin =
            InstalledPlugin::from_manifest(&self.package.manifest, Digest(self.package.digest));
        let grants = match (hooks.grants, basis.from_digest) {
            (Some(store), Some(from)) => {
                let (candidates, switch) =
                    store.begin_upgrade(Digest(from), basis.capabilities.as_ref(), &plugin);
                let switch_audit = SwitchAudit {
                    installer: self.installer,
                    actor: approver,
                    correlation: &self.correlation_id,
                    plugin_id: &plugin.id,
                    from_digest: Digest(from),
                    from_version: basis.from_version.as_deref().unwrap_or_default(),
                    to_digest: plugin.digest,
                    to_version: &self.package.manifest.version,
                };
                Some(switch_audit.carry_all(store, candidates, switch).await)
            }
            (Some(_), None) => Some(GrantSwitch::default()),
            _ => None,
        };
        let mut warnings = Vec::new();
        if basis.unreadable {
            warnings.push(SwitchWarning::PreviousManifestUnreadable);
        }
        if grants.as_ref().is_some_and(|g| !g.audit_failed.is_empty()) {
            warnings.push(SwitchWarning::GrantsNotCarriedAuditFailed);
        }
        if committed == CommitOutcome::SyncFailed {
            warnings.push(SwitchWarning::DirectorySyncFailed);
            if let Some(alerts) = hooks.alerts {
                alerts.alert(&InstallAlert::SwitchSyncFailed {
                    plugin_id: plugin.id.clone(),
                    correlation_id: self.correlation_id.clone(),
                });
            }
        }
        Ok(Activation {
            plugin,
            upgrade: basis.view,
            grants,
            warnings,
        })
    }

    /// Refuse activation when `upgrade` widens the permissions and `approval` does not name
    /// exactly that widening.
    async fn check_widening(
        &self,
        approver: &Principal,
        upgrade: Option<&UpgradeView>,
        approval: &Approval,
    ) -> Result<(), InstallError> {
        let Some(upgrade) = upgrade else {
            return Ok(());
        };
        let diff = &upgrade.permissions;
        if !diff.is_widened() || diff.widened == approval.widened_permissions {
            return Ok(());
        }
        audit(
            self.installer,
            approver,
            &self.correlation_id,
            REJECT,
            &self.package.manifest.id,
            self.package.digest,
            AuditDecision::Deny {
                reason: Reason::Policy {
                    message: "requested permissions widen; approval does not cover them".into(),
                },
            },
            Outcome::Error {
                code: "PermissionsWidened".into(),
            },
            OnAuditFailure::FailClosed,
        )
        .await?;
        Err(InstallError::PermissionsWidened(diff.clone()))
    }

    pub async fn reject(self, approver: &Principal) -> Result<(), InstallError> {
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
            OnAuditFailure::FailClosed,
        )
        .await
        .map(|_| ())
    }
}

impl Drop for StagedInstall<'_> {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.stage);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn sync_failure_after_publish_keeps_referenced_version() {
        let root = private_dir(&std::env::temp_dir()).unwrap();
        let base = root.join("org.example.demo");
        let versions = base.join("versions");
        fs::create_dir_all(&versions).unwrap();
        let old = "11".repeat(32);
        let new = "22".repeat(32);
        fs::create_dir(versions.join(&old)).unwrap();
        atomic_state(
            &base,
            &InstallState {
                active: Some(old.clone()),
                previous: None,
            },
        )
        .unwrap();
        let new_path = versions.join(&new);
        fs::create_dir(&new_path).unwrap();
        let result = commit_activation(
            &base,
            &new_path,
            &InstallState {
                active: Some(new.clone()),
                previous: Some(old.clone()),
            },
            |_| Err(std::io::Error::other("injected directory sync failure")),
        );
        assert_eq!(result.unwrap(), CommitOutcome::SyncFailed);
        assert_eq!(
            read_state(&base).unwrap().active.as_deref(),
            Some(new.as_str())
        );
        assert!(
            new_path.is_dir(),
            "published state must not point to a deleted version"
        );
        assert!(versions.join(old).is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn plugin_lock_serializes_independent_openers() {
        let root = private_dir(&std::env::temp_dir()).unwrap();
        let base = root.join("org.example.demo");
        let first = lock_plugin(&base).unwrap();
        let (tx, rx) = mpsc::channel();
        let second_base = base.clone();
        let waiter = std::thread::spawn(move || {
            let second = lock_plugin(&second_base).unwrap();
            tx.send(()).unwrap();
            drop(second);
        });
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        drop(first);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        waiter.join().unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
