//! `admin.secrets.*` (DOC-25 §3.3.7, §3.4.5): the keys loaded, the entries per key and the
//! re-wrap job's progress. Never a value or a key. Needs `admin.secrets.manage` (tenant).

use std::sync::Arc;

use ambidex::{Ctx, rpc};
use schemars::JsonSchema;
use serde::Serialize;
use ts_rs::TS;

use super::service::{KeyRow, RewrapProgress, SecretService};
use crate::core::{Empty, ToolError, ToolErrorKind, ToolResult};

const SYSTEM: &str = "secrets";

/// What `admin.secrets.status` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SecretsStatusOutput {
    /// The keys, active first, then any key stored entries name but the server has not loaded.
    pub keys: Vec<KeyRow>,
    /// Stored secret entries.
    pub entries: u64,
    pub rewrap: RewrapProgress,
}

/// `admin.secrets.*`. `None` only in the codegen router.
pub struct AdminSecretsApi(pub Option<Arc<SecretService>>);

#[rpc::router(namespace = "admin.secrets")]
impl AdminSecretsApi {
    /// The keys loaded (id, source, active), the entries under each, the re-wrap job's progress.
    #[rpc::query(perm = "admin.secrets.manage", risk = Risk::Read)]
    async fn status(&self, _ctx: Ctx, _input: Empty) -> ToolResult<SecretsStatusOutput> {
        let service = self
            .0
            .clone()
            .ok_or_else(|| ToolError::new(ToolErrorKind::Remote, SYSTEM, "no secret store"))?;
        let rewrap = service.progress();
        let (keys, entries) = tokio::task::spawn_blocking(move || service.key_status())
            .await
            .map_err(|e| ToolError::new(ToolErrorKind::Remote, SYSTEM, e.to_string()))?
            .map_err(|e| ToolError::new(ToolErrorKind::Remote, SYSTEM, e.to_string()))?;
        Ok(SecretsStatusOutput {
            keys,
            entries,
            rewrap,
        })
    }
}

/// What `admin.backup.snapshot` answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotOutput {
    /// The file, relative to the data directory (`backups/backup-<utc>.tar`).
    pub file: String,
    pub bytes: u64,
    /// The last audit record in it.
    pub audit_seq: Option<u64>,
}

/// `admin.backup.*` (DOC-25 §3.4.6). `None` only in the codegen router.
pub struct AdminBackupApi(pub Option<Arc<SecretService>>);

#[rpc::router(namespace = "admin.backup")]
impl AdminBackupApi {
    /// Writes an online backup to `DATA/backups/backup-<utc>.tar` (0600): a consistent copy of the
    /// store and the closed audit segments with the checkpoint, never the keys. Move it off the
    /// machine.
    #[rpc::mutation(perm = "admin.secrets.manage", risk = Risk::Write)]
    async fn snapshot(&self, _ctx: Ctx, _input: Empty) -> ToolResult<SnapshotOutput> {
        let service = self
            .0
            .clone()
            .ok_or_else(|| ToolError::new(ToolErrorKind::Remote, SYSTEM, "no secret store"))?;
        let remote = |e: String| ToolError::new(ToolErrorKind::Remote, "backup", e);
        let made = tokio::task::spawn_blocking(move || {
            let log = service
                .audit_log()
                .ok_or_else(|| "the audit log is not a durable one".to_owned())?;
            crate::backup::snapshot(
                &service.store,
                service.data(),
                log,
                security_types::unix_now_ms(),
            )
            .map(|made| (made, service.data().to_path_buf()))
            .map_err(|e| e.0)
        })
        .await
        .map_err(|e| remote(e.to_string()))?
        .map_err(remote)?;
        let (made, data) = made;
        Ok(SnapshotOutput {
            file: made
                .path
                .strip_prefix(&data)
                .unwrap_or(&made.path)
                .display()
                .to_string(),
            bytes: made.bytes,
            audit_seq: made.audit_seq,
        })
    }
}
