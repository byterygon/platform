//! Reading the audit log (DOC-25 §3.5.7, TSK-140 batch 3b): `audit.list`, `audit.get`,
//! `audit.verify` and `audit.status`, all under `audit.read` (tenant: only an unscoped assignment
//! grants it). Listing and getting are sensitive reads, so the router records them: reading the
//! log is itself in the log. `audit.verify` is not recorded.
//!
//! A page is read from the end of the log with a cursor (`audit_jsonl::reader`), never a whole
//! file, and never loads a whole file into the browser. Entries carry digests, ids and counts,
//! never a value (3.5.3); this module adds nothing to them. `audit.export` is not a procedure:
//! the screen exports the filtered view by paging `audit.list`, so every page of an export is
//! recorded too.

use std::path::PathBuf;
use std::sync::Arc;

use ambidex::{Ctx, rpc};
use audit_jsonl::SegmentedSink;
use audit_jsonl::reader::{self, Cursor, Filter, OutcomeFilter};
use schemars::JsonSchema;
use security_types::{AuditDecision, AuditRecord, Outcome, Risk};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::audit::SensitiveTable;
use crate::core::{ToolError, ToolErrorKind, ToolResult};

const SYSTEM: &str = "audit";

/// Records per page at most (DOC-25 §3.5.7).
pub const MAX_LIMIT: u32 = 500;
const DEFAULT_LIMIT: u32 = 100;

/// What the procedures read: the log's directory, the sink (for verify and status) and which
/// procedures' reads are sensitive.
pub struct AuditView {
    pub dir: PathBuf,
    pub sink: Arc<SegmentedSink>,
    pub sensitive: SensitiveTable,
}

fn invalid(field: &str, message: impl Into<String>) -> ToolError {
    ToolError::invalid(SYSTEM, field, message)
}

fn remote(message: impl Into<String>) -> ToolError {
    ToolError::new(ToolErrorKind::Remote, SYSTEM, message)
}

/// What the screen's filters mean (every field is optional).
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditFilter {
    /// Earliest time, Unix ms.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub from_ms: Option<u64>,
    /// Latest time, Unix ms.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub to_ms: Option<u64>,
    /// Part of a principal id (who), case-insensitive.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub principal: Option<String>,
    /// The start of the action name: a tool (`nats.`) or a procedure.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub action: Option<String>,
    /// `Read`, `Write` or `Destructive`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub risk: Option<String>,
    /// `allowed`, `refused` or `failed`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub outcome: Option<String>,
    /// Only the sensitive reads.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub sensitive_only: Option<bool>,
    /// Also the admission entries (`Started`) that have a completion; off by default, so a call
    /// is one row.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub include_started: Option<bool>,
}

fn filter_of(f: &AuditFilter) -> Result<Filter, ToolError> {
    let risk = match f.risk.as_deref() {
        None | Some("") => None,
        Some("Read") => Some(Risk::Read),
        Some("Write") => Some(Risk::Write),
        Some("Destructive") => Some(Risk::Destructive),
        Some(other) => {
            return Err(invalid(
                "filter.risk",
                format!("{other:?} is not Read, Write or Destructive"),
            ));
        }
    };
    let outcome = match f.outcome.as_deref() {
        None | Some("") => None,
        Some("allowed") => Some(OutcomeFilter::Allowed),
        Some("refused") => Some(OutcomeFilter::Refused),
        Some("failed") => Some(OutcomeFilter::Failed),
        Some(other) => {
            return Err(invalid(
                "filter.outcome",
                format!("{other:?} is not allowed, refused or failed"),
            ));
        }
    };
    let text = |s: &Option<String>| {
        s.as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    Ok(Filter {
        from_ms: f.from_ms,
        to_ms: f.to_ms,
        principal: text(&f.principal),
        action_prefix: text(&f.action),
        risk,
        outcome,
        sensitive_only: f.sensitive_only.unwrap_or(false),
        finished_only: !f.include_started.unwrap_or(false),
    })
}

/// Input of `audit.list`.
#[derive(Debug, Clone, Default, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditListInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub filter: Option<AuditFilter>,
    /// The `next` of the previous page; absent for the newest.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub cursor: Option<String>,
    /// At most 500; 100 when left out.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

/// One entry of the log as a row of the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditRow {
    pub seq: u64,
    pub time_ms: u64,
    /// The acting principal's id, nearest in the chain.
    pub user: String,
    pub session: String,
    /// `human`, `agent`, `plugin` or `system`.
    pub user_kind: String,
    /// The procedure or event name, e.g. `nats.js.streams.delete`, `auth.login`.
    pub action: String,
    pub perm: String,
    /// `kind/id` of the target, when the call had one.
    pub target: Option<String>,
    /// `Read`, `Write` or `Destructive`.
    pub risk: String,
    /// A read the log keeps because it is sensitive.
    pub sensitive: bool,
    /// `allowed`, `refused` or `failed`.
    pub outcome: String,
    /// The error code of a failed call.
    pub error_code: Option<String>,
    /// `started` for an admission entry, else `done`.
    pub phase: String,
    pub duration_ms: Option<u64>,
    pub correlation_id: String,
}

fn row_of(record: &AuditRecord, sensitive: &SensitiveTable) -> AuditRow {
    let e = &record.entry;
    let head = e.principal_chain.first();
    let refused = matches!(e.decision, AuditDecision::Deny { .. });
    let (outcome, error_code) = match (&e.outcome, refused) {
        (_, true) => (
            "refused",
            match &e.outcome {
                Outcome::Error { code } => Some(code.clone()),
                _ => None,
            },
        ),
        (Outcome::Error { code }, false) => ("failed", Some(code.clone())),
        _ => ("allowed", None),
    };
    AuditRow {
        seq: record.seq,
        time_ms: e.timestamp_unix_ms,
        user: head.map(|p| p.id.clone()).unwrap_or_default(),
        session: head
            .map(|p| p.session.as_str().to_owned())
            .unwrap_or_default(),
        user_kind: head
            .map(|p| format!("{:?}", p.kind).to_lowercase())
            .unwrap_or_default(),
        action: e.action.name.clone(),
        perm: e.action.perm.as_str().to_owned(),
        target: e.target.as_ref().map(|t| format!("{}/{}", t.kind, t.id)),
        risk: format!("{:?}", e.risk),
        sensitive: sensitive.contains(&e.action.name),
        outcome: outcome.to_owned(),
        error_code,
        phase: if e.outcome == Outcome::Started {
            "started"
        } else {
            "done"
        }
        .to_owned(),
        duration_ms: e.duration_ms,
        correlation_id: e.correlation_id.clone(),
    }
}

/// Output of `audit.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditListOutput {
    /// Newest first.
    pub records: Vec<AuditRow>,
    /// Send it back for the next page; `null` at the oldest record.
    pub next: Option<String>,
}

/// Input of `audit.get`.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditGetInput {
    pub seq: u64,
}

/// A principal of the acting chain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditPrincipalRow {
    pub kind: String,
    pub id: String,
    pub session: String,
}

/// A readable value of an entry's detail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditDetailRow {
    pub key: String,
    pub value: String,
}

/// Output of `audit.get`: the entry, its hashes and everything it holds (digests, never values).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditRecordView {
    pub row: AuditRow,
    pub tenant: String,
    pub principals: Vec<AuditPrincipalRow>,
    /// Why a refusal was refused, as the log records it.
    pub reason: Option<String>,
    pub approval_id: Option<String>,
    /// Over the redacted input.
    pub input_digest: String,
    pub statement_digest: Option<String>,
    /// What the client received (a completion entry).
    pub delivery: Option<String>,
    pub parent_correlation_id: Option<String>,
    pub detail: Vec<AuditDetailRow>,
    pub prev_hash: String,
    pub hash: String,
}

fn view_of(record: &AuditRecord, sensitive: &SensitiveTable) -> AuditRecordView {
    let e = &record.entry;
    AuditRecordView {
        row: row_of(record, sensitive),
        tenant: e.tenant.as_str().to_owned(),
        principals: e
            .principal_chain
            .iter()
            .map(|p| AuditPrincipalRow {
                kind: format!("{:?}", p.kind).to_lowercase(),
                id: p.id.clone(),
                session: p.session.as_str().to_owned(),
            })
            .collect(),
        reason: match &e.decision {
            AuditDecision::Deny { reason } => serde_json::to_string(reason).ok(),
            AuditDecision::NeedsApproval => Some("needs approval".to_owned()),
            AuditDecision::Allow => None,
        },
        approval_id: e.approval_id.clone(),
        input_digest: e.input_digest.to_string(),
        statement_digest: e.statement_digest.map(|d| d.to_string()),
        delivery: e.delivery.map(|d| format!("{d:?}")),
        parent_correlation_id: e.parent_correlation_id.clone(),
        detail: e
            .detail
            .as_ref()
            .map(|d| {
                d.iter()
                    .map(|(key, value)| AuditDetailRow {
                        key: key.to_owned(),
                        value: value.to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        prev_hash: record.prev_hash.to_string(),
        hash: record.hash.to_string(),
    }
}

/// The first place the chain breaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditBreak {
    /// The segment file's name.
    pub file: String,
    /// 1-based.
    pub line: u32,
    pub seq: Option<u64>,
    /// `edited`, `deleted`, `reordered`, `gap`, `head cut`, `truncated tail` or `unparsable`.
    pub kind: String,
    pub message: String,
}

/// Output of `audit.verify`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditVerifyOutput {
    /// The chain is intact and, when there is a key, so is its checkpoint.
    pub ok: bool,
    pub records: u64,
    pub segments: u32,
    /// The last record's `seq`.
    pub head_seq: Option<u64>,
    /// Admissions with no completion: calls whose outcome is unknown.
    pub unfinished: Vec<String>,
    /// `intact`, `not checked` (its key is not loaded), `absent` (no checkpoint yet), or `none`
    /// (this server has no key for one).
    pub checkpoint: String,
    pub broken: Option<AuditBreak>,
    /// When the check ended, Unix ms.
    pub checked_ms: u64,
}

/// Output of `audit.status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AuditStatusOutput {
    pub segments: u32,
    pub bytes: u64,
    pub max_bytes: u64,
    pub oldest_time_ms: Option<u64>,
    pub records: u64,
    /// Why the log refuses writes, when it does.
    pub refusing: Option<String>,
    /// When the checkpoint was written, Unix ms, and the record it names.
    pub checkpoint_ms: Option<u64>,
    pub checkpoint_seq: Option<u64>,
}

/// `audit.*`.
pub struct AuditApi(pub Option<Arc<AuditView>>);

fn the(view: &Option<Arc<AuditView>>) -> Result<&Arc<AuditView>, ToolError> {
    view.as_ref()
        .ok_or_else(|| remote("the audit log is not kept on disk on this server"))
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[rpc::router(namespace = "audit")]
impl AuditApi {
    /// A page of the log, newest first, from the end or from a cursor. The filter keeps what
    /// matches; a page may hold fewer than `limit` and still have a `next` (the server stops
    /// after reading a stretch of the log). Reading the log is recorded.
    #[rpc::query(perm = "audit.read", risk = Risk::Read, audit = "always")]
    async fn list(&self, _ctx: Ctx, input: AuditListInput) -> ToolResult<AuditListOutput> {
        let view = Arc::clone(the(&self.0)?);
        let filter = filter_of(&input.filter.unwrap_or_default())?;
        let limit = input.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT) as usize;
        let cursor = match input.cursor.as_deref() {
            None | Some("") => None,
            Some(text) => Some(
                Cursor::decode(text)
                    .ok_or_else(|| invalid("cursor", "not a cursor of this log"))?,
            ),
        };
        let page = tokio::task::spawn_blocking(move || {
            reader::page(&view.dir, &filter, cursor, limit, &|name| {
                view.sensitive.contains(name)
            })
            .map(|page| (page, view))
        })
        .await
        .map_err(|e| remote(format!("reading the log failed: {e}")))?
        .map_err(|e| remote(format!("reading the log failed: {e}")))?;
        let (page, view) = page;
        Ok(AuditListOutput {
            records: page
                .records
                .iter()
                .map(|r| row_of(r, &view.sensitive))
                .collect(),
            next: page.next.map(Cursor::encode),
        })
    }

    /// One entry with its hashes and everything it holds. Reading the log is recorded.
    #[rpc::query(perm = "audit.read", risk = Risk::Read, audit = "always")]
    async fn get(&self, _ctx: Ctx, input: AuditGetInput) -> ToolResult<AuditRecordView> {
        let view = Arc::clone(the(&self.0)?);
        let seq = input.seq;
        let found = tokio::task::spawn_blocking(move || {
            reader::get(&view.dir, seq).map(|r| r.map(|r| view_of(&r, &view.sensitive)))
        })
        .await
        .map_err(|e| remote(format!("reading the log failed: {e}")))?
        .map_err(|e| remote(format!("reading the log failed: {e}")))?;
        found.ok_or_else(|| {
            ToolError::not_found(
                SYSTEM,
                "entry",
                format!("no entry {seq}: it never existed, or retention deleted it"),
            )
            .into()
        })
    }

    /// Checks the chain across every segment, then the checkpoint (DOC-25 §3.5.5), and answers
    /// the first break with its file, line, `seq` and kind. It reads the whole log and so takes
    /// a while on a large one; the log goes on being written meanwhile.
    #[rpc::query(perm = "audit.read", risk = Risk::Read, timeout_default = "300s", timeout_max = "600s")]
    async fn verify(&self, _ctx: Ctx, _input: crate::core::Empty) -> ToolResult<AuditVerifyOutput> {
        let view = Arc::clone(the(&self.0)?);
        let out = tokio::task::spawn_blocking(move || view.sink.verify_log())
            .await
            .map_err(|e| remote(format!("verifying the log failed: {e}")))?
            .map_err(|e| remote(format!("verifying the log failed: {e}")))?;
        use audit_jsonl::checkpoint::Verdict;
        let checkpoint = match &out.checkpoint {
            None => "none",
            Some(Verdict::Absent) => "absent",
            Some(Verdict::NotChecked { .. }) => "not checked",
            Some(_) => "intact",
        };
        let broken = out.broken.as_ref().map(|b| AuditBreak {
            file: b
                .file
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
            line: b.line as u32,
            seq: b.seq,
            kind: b.kind.as_str().to_owned(),
            message: b.message.clone(),
        });
        Ok(AuditVerifyOutput {
            ok: broken.is_none(),
            records: out.records,
            segments: out.segments as u32,
            head_seq: out.head.map(|(seq, _)| seq),
            unfinished: out.unfinished,
            checkpoint: checkpoint.to_owned(),
            broken,
            checked_ms: now_ms(),
        })
    }

    /// The log's size, segments, oldest time and the checkpoint's age.
    #[rpc::query(perm = "audit.read", risk = Risk::Read)]
    async fn status(&self, _ctx: Ctx, _input: crate::core::Empty) -> ToolResult<AuditStatusOutput> {
        let view = Arc::clone(the(&self.0)?);
        tokio::task::spawn_blocking(move || {
            let s = view.sink.status();
            let cp = audit_jsonl::checkpoint::read(&view.dir).ok().flatten();
            AuditStatusOutput {
                segments: s.segments as u32,
                bytes: s.bytes,
                max_bytes: s.max_bytes,
                oldest_time_ms: s.oldest_time_ms,
                records: s.records,
                refusing: s.refusing,
                checkpoint_ms: cp.as_ref().map(|c| c.time),
                checkpoint_seq: cp.as_ref().map(|c| c.seq),
            }
        })
        .await
        .map_err(|e| remote(format!("reading the status failed: {e}")).into())
    }
}
