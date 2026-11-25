//! The audit log of Mightyconsole (DOC-25 §3.5, TSK-137).
//!
//! The log is the shared durable one: hash-chained JSON Lines on the `security-types` v1 record,
//! one `fsync` per entry (`audit-jsonl`), in `DATA/audit/`. This module decides what goes into it
//! and in which words:
//!
//! - [`McAuditSink`] sits between the Ambidex router and the log. The router offers every call
//!   that runs (admission and completion) and every refusal; the sink keeps the Write and
//!   Destructive calls, the **sensitive reads** and every refusal, and drops the rest. A sensitive
//!   read is a procedure marked `audit = "always"` (DOC-25 §3.5.2): the classification lives in
//!   the procedure, the sink reads it from the router's table ([`SensitiveTable::fill`]) and has
//!   no list of names. `audit.reads = "all"` keeps every call. The quiet calls (`term.write`,
//!   `term.resize`, `nats.obj.uploadPart`: one per keystroke batch or 4 MiB part) stay out
//!   whatever the setting, because terminal input carries typed passwords and the upload that
//!   started them is recorded; a refusal of one is still recorded.
//! - [`EventLog`] writes the events that are not calls: sign-in, sign-out, a session ending, the
//!   server starting and stopping ([`Event`]). They come from the sign-in hooks and are written
//!   in order by one task, outside every lock. A failure to write one is reported on stderr and
//!   never blocks the sign-in: the calls that follow still fail closed.
//! - A log that cannot be opened (broken chain, unreadable) stops the start; the
//!   [`UnavailableAuditSink`](audit_jsonl::UnavailableAuditSink) stands in only where the server
//!   is built without a log, and refuses every entry, so Write, Destructive and sensitive Read
//!   calls end with `Unavailable` and nothing happens unrecorded.
//!
//! Entries never hold an input, a secret, a token or data read from a target: the router's entry
//! carries only the digest of the input with its `redact` paths replaced, and the detail added
//! here is limited to the keys of §3.5.1 with identifiers, counts and addresses as values.
//! `audit.stderr = true` keeps v0.1's one-line-per-call log on stderr for operators who want it.

use std::collections::HashSet;
use std::io::Write as _;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ambidex::{AuditMode, Router};
use audit_jsonl::{AuditLogError, SegmentOptions, SegmentPolicy, SegmentedSink, segments::Warn};
use security_types::{
    Action, AuditDecision, AuditDetail, AuditEntry, AuditError, AuditPrincipal, AuditSink,
    BoxFuture, Digest, Outcome, Principal, PrincipalKind, Reason, Risk, SessionId, TenantId,
    new_correlation_id, unix_now_ms,
};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

/// Where the lines go: stderr, or a buffer in tests.
pub trait LineWriter: Send + Sync + 'static {
    fn line(&self, line: &str);
}

/// Writes to the process's stderr.
pub struct Stderr;

impl LineWriter for Stderr {
    fn line(&self, line: &str) {
        let _ = writeln!(std::io::stderr().lock(), "{line}");
    }
}

/// The audit directory under the data directory (DOC-25 §3.6.3).
pub const AUDIT_DIR: &str = "audit";

/// `audit.reads` (DOC-25 §3.5.1, Open question 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Reads {
    /// Sensitive reads only (`audit = "always"`); the default.
    #[default]
    Sensitive,
    /// Every call that runs, as Ambidex §8 describes.
    All,
}

impl Reads {
    pub fn as_str(self) -> &'static str {
        match self {
            Reads::Sensitive => "sensitive",
            Reads::All => "all",
        }
    }
}

/// `[audit]`, resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AuditSettings {
    pub reads: Reads,
    /// Also write v0.1's one line per recorded call to stderr.
    pub stderr: bool,
    /// Segment size, retention and the size limit (DOC-25 §3.5.4, §3.5.6).
    pub policy: SegmentPolicy,
    /// `--audit-new-chain`: move a broken log aside and start a new chain (DOC-25 §3.6.2).
    pub new_chain: bool,
}

/// The calls the router's table marks `audit = "always"`.
///
/// Filled once from the router after every namespace is mounted (the sink is attached first).
/// Until then nothing is sensitive: no call can run before the server serves.
#[derive(Clone, Default)]
pub struct SensitiveTable(Arc<OnceLock<HashSet<String>>>);

impl SensitiveTable {
    /// Reads the table from `router`. The first fill wins.
    pub fn fill(&self, router: &Router) {
        let names = router
            .procedures()
            .iter()
            .filter(|meta| meta.audit == AuditMode::Always)
            .map(|meta| meta.name.clone())
            .collect();
        let _ = self.0.set(names);
    }

    pub fn contains(&self, procedure: &str) -> bool {
        self.0.get().is_some_and(|names| names.contains(procedure))
    }

    /// The marked procedures, sorted.
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .0
            .get()
            .map(|names| names.iter().cloned().collect())
            .unwrap_or_default();
        names.sort();
        names
    }
}

/// The calls that are never recorded unless refused (see the module docs).
const QUIET: [&str; 3] = ["term.write", "term.resize", "nats.obj.uploadPart"];

/// What the router writes into: the filter in front of the log.
pub struct McAuditSink {
    inner: Arc<dyn AuditSink>,
    sensitive: SensitiveTable,
    settings: AuditSettings,
    lines: Arc<dyn LineWriter>,
}

impl McAuditSink {
    pub fn new(
        inner: Arc<dyn AuditSink>,
        sensitive: SensitiveTable,
        settings: AuditSettings,
        lines: Arc<dyn LineWriter>,
    ) -> McAuditSink {
        McAuditSink {
            inner,
            sensitive,
            settings,
            lines,
        }
    }

    /// Whether the entry of a call or a refusal goes into the log.
    pub fn recorded(&self, entry: &AuditEntry) -> bool {
        let name = entry.action.name.as_str();
        if !matches!(entry.decision, AuditDecision::Allow) {
            return true;
        }
        if QUIET.contains(&name) {
            return false;
        }
        entry.risk >= Risk::Write
            || self.settings.reads == Reads::All
            || self.sensitive.contains(name)
    }

    /// v0.1's line for an entry (`audit.stderr`).
    pub fn line(entry: &AuditEntry) -> String {
        let refused = !matches!(entry.decision, AuditDecision::Allow);
        let what = match (&entry.decision, &entry.outcome) {
            (AuditDecision::Allow, Outcome::Started) => "started".to_owned(),
            (AuditDecision::Allow, Outcome::Success) => "ok".to_owned(),
            (AuditDecision::Allow, Outcome::Error { code }) => format!("error {code}"),
            _ => "refused".to_owned(),
        };
        let risk = match entry.risk {
            Risk::Read => "read",
            Risk::Write => "write",
            Risk::Destructive => "destructive",
        };
        let duration = entry
            .duration_ms
            .filter(|_| !refused)
            .map(|ms| format!(" {ms} ms"))
            .unwrap_or_default();
        format!(
            "mightyconsole-server: call {} {risk} {what}{duration} ({})",
            entry.action.name, entry.correlation_id
        )
    }
}

/// The detail of a call's entry: its tool, and for a refusal the kind of reason (§3.5.1).
fn call_detail(entry: &AuditEntry) -> Option<AuditDetail> {
    let mut fields: Vec<(&str, String)> = Vec::new();
    if let Some((tool, _)) = entry.action.name.split_once('.') {
        fields.push(("tool", tool.to_owned()));
    }
    if let AuditDecision::Deny { reason } = &entry.decision {
        fields.push(("reason", reason_kind(reason).to_owned()));
    }
    AuditDetail::new(fields).ok()
}

fn reason_kind(reason: &Reason) -> &'static str {
    match reason {
        Reason::UnknownPermission { .. } => "unknown_permission",
        Reason::MissingPermission { .. } => "missing_permission",
        Reason::OutOfScope { .. } => "out_of_scope",
        Reason::TenantMismatch => "tenant_mismatch",
        Reason::Policy { .. } => "policy",
    }
}

impl AuditSink for McAuditSink {
    fn append(&self, mut entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if !self.recorded(&entry) {
            return Box::pin(std::future::ready(Ok(())));
        }
        if self.settings.stderr {
            self.lines.line(&McAuditSink::line(&entry));
        }
        if entry.detail.is_none() {
            entry.detail = call_detail(&entry);
        }
        self.inner.append(entry)
    }
}

/// An event that is not a call (DOC-25 §3.5.1). Values are identifiers, counts, addresses and
/// reasons: never a token, code, cookie or secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// `auth.login` by the user.
    Login {
        user: String,
        session: String,
        method: String,
        ip: Option<IpAddr>,
        groups: usize,
        roles: Vec<String>,
    },
    /// `auth.login` that failed, by `system:auth`.
    LoginFailed {
        error: String,
        reason: String,
        ip: Option<IpAddr>,
    },
    /// `auth.logout`.
    Logout {
        user: String,
        session: String,
        ip: Option<IpAddr>,
    },
    /// `auth.session.end`: a session ended without sign-out.
    SessionEnd {
        user: String,
        session: String,
        reason: String,
        by: Option<String>,
    },
    /// `server.start`.
    ServerStart {
        version: String,
        mode: String,
        exposed: bool,
    },
    /// `server.stop`.
    ServerStop,
    /// `auth.admin.reset` (DOC-25 §3.2.7): `via` is `stopped` (the command opened the store) or
    /// `request` (the running server performed it).
    AdminReset { via: String },
    /// `auth.signup`: a built-in account made by sign-up, by that account.
    Signup { user: String, ip: Option<IpAddr> },
    /// `auth.lockout`, by `system:auth`: too many failures locked `user` until `until_ms`.
    Lockout {
        user: String,
        ip: Option<IpAddr>,
        until_ms: u64,
    },
    /// `secrets.rewrap` (DOC-25 §3.4.5), by `system:server`, when the re-wrap job starts and
    /// when it ends: the keys it moves entries from, the active key, how many entries.
    SecretsRewrap {
        phase: &'static str,
        from: Vec<String>,
        to: String,
        count: u64,
    },
    /// `server.restore` (DOC-25 §3.4.6), by `system:server`: the first start after a restore,
    /// with the backup's last audit record.
    ServerRestore {
        backup_seq: String,
        backup_hash: String,
    },
}

/// Clips `text` to the detail's value limit on a character boundary and replaces control
/// characters, so that an attacker-chosen string (an IdP's error text) cannot break the entry.
fn clip(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        let c = if c.is_control() { ' ' } else { c };
        if out.len() + c.len_utf8() > AuditDetail::MAX_VALUE_BYTES {
            break;
        }
        out.push(c);
    }
    out
}

fn ip_text(ip: &Option<IpAddr>) -> String {
    ip.map_or_else(|| "-".to_owned(), |ip| ip.to_string())
}

impl Event {
    /// The action name of the entry.
    pub fn name(&self) -> &'static str {
        match self {
            Event::Login { .. } | Event::LoginFailed { .. } => "auth.login",
            Event::Logout { .. } => "auth.logout",
            Event::SessionEnd { .. } => "auth.session.end",
            Event::ServerStart { .. } => "server.start",
            Event::ServerStop => "server.stop",
            Event::AdminReset { .. } => "auth.admin.reset",
            Event::Signup { .. } => "auth.signup",
            Event::Lockout { .. } => "auth.lockout",
            Event::SecretsRewrap { .. } => "secrets.rewrap",
            Event::ServerRestore { .. } => "server.restore",
        }
    }

    /// The entry for this event, in `tenant`.
    pub fn entry(&self, tenant: &TenantId, correlation_id: String, now_ms: u64) -> AuditEntry {
        let system = |id: &str| AuditPrincipal {
            kind: PrincipalKind::System,
            id: id.to_owned(),
            tenant: tenant.clone(),
            session: SessionId::new("-"),
        };
        let human = |user: &str, session: &str| {
            AuditPrincipal::chain_of(&Principal {
                kind: PrincipalKind::Human,
                id: user.to_owned(),
                tenant: tenant.clone(),
                on_behalf_of: None,
                roles: vec![],
                session: SessionId::new(session),
            })
        };
        let (principal_chain, decision, outcome, fields): (_, _, _, Vec<(&str, String)>) =
            match self {
                Event::Login {
                    user,
                    session,
                    method,
                    ip,
                    groups,
                    roles,
                } => (
                    human(user, session),
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![
                        ("method", clip(method)),
                        ("ip", ip_text(ip)),
                        ("groups", groups.to_string()),
                        ("roles", clip(&roles.join(","))),
                    ],
                ),
                Event::LoginFailed { error, reason, ip } => (
                    vec![system("system:auth")],
                    AuditDecision::Deny {
                        reason: Reason::Policy {
                            message: clip(error),
                        },
                    },
                    Outcome::Error { code: clip(error) },
                    vec![("reason", clip(reason)), ("ip", ip_text(ip))],
                ),
                Event::Logout { user, session, ip } => (
                    human(user, session),
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![("ip", ip_text(ip))],
                ),
                Event::SessionEnd {
                    user,
                    session,
                    reason,
                    by,
                } => {
                    let mut fields = vec![("reason", clip(reason))];
                    if let Some(by) = by {
                        fields.push(("by", clip(by)));
                    }
                    (
                        human(user, session),
                        AuditDecision::Allow,
                        Outcome::Success,
                        fields,
                    )
                }
                Event::ServerStart {
                    version,
                    mode,
                    exposed,
                } => (
                    vec![system("system:server")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![
                        ("version", clip(version)),
                        ("mode", clip(mode)),
                        ("exposed", exposed.to_string()),
                    ],
                ),
                Event::ServerStop => (
                    vec![system("system:server")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    Vec::new(),
                ),
                Event::AdminReset { via } => (
                    vec![system("system:server")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![("via", clip(via))],
                ),
                Event::Signup { user, ip } => (
                    human(user, "-"),
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![("ip", ip_text(ip))],
                ),
                Event::Lockout { user, ip, until_ms } => (
                    vec![system("system:auth")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![
                        ("user", clip(user)),
                        ("ip", ip_text(ip)),
                        ("until", until_ms.to_string()),
                    ],
                ),
                Event::SecretsRewrap {
                    phase,
                    from,
                    to,
                    count,
                } => (
                    vec![system("system:server")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![
                        ("phase", (*phase).to_owned()),
                        ("from", clip(&from.join(","))),
                        ("to", clip(to)),
                        ("count", count.to_string()),
                    ],
                ),
                Event::ServerRestore {
                    backup_seq,
                    backup_hash,
                } => (
                    vec![system("system:server")],
                    AuditDecision::Allow,
                    Outcome::Success,
                    vec![
                        ("backup_seq", clip(backup_seq)),
                        ("backup_hash", clip(backup_hash)),
                    ],
                ),
            };
        let name = self.name();
        AuditEntry {
            timestamp_unix_ms: now_ms,
            principal_chain,
            tenant: tenant.clone(),
            action: Action::new(name, name),
            target: None,
            risk: Risk::Read,
            decision,
            approval_id: None,
            outcome,
            duration_ms: None,
            correlation_id,
            input_digest: Digest::ZERO,
            statement_digest: None,
            delivery: None,
            parent_correlation_id: None,
            detail: AuditDetail::new(fields).ok(),
        }
    }

    /// The `audit.stderr` line for the event.
    pub fn line(&self) -> String {
        let text = match self {
            Event::Login {
                user,
                session,
                method,
                ip,
                groups,
                ..
            } => format!(
                "auth.login ok {user} session {session} method {method} from {} ({groups} groups)",
                ip_text(ip)
            ),
            Event::LoginFailed { error, reason, ip } => format!(
                "auth.login refused ({error}) from {}: {}",
                ip_text(ip),
                clip(reason)
            ),
            Event::Logout { user, session, ip } => {
                format!("auth.logout {user} session {session} from {}", ip_text(ip))
            }
            Event::SessionEnd {
                user,
                session,
                reason,
                by,
            } => {
                let by = by
                    .as_ref()
                    .map(|by| format!(" by {by}"))
                    .unwrap_or_default();
                format!("auth.session.end {user} session {session} ({reason}){by}")
            }
            Event::ServerStart {
                version,
                mode,
                exposed,
            } => format!("server.start {version} ({mode}, exposed {exposed})"),
            Event::ServerStop => "server.stop".to_owned(),
            Event::AdminReset { via } => format!("auth.admin.reset (via {via})"),
            Event::Signup { user, ip } => format!("auth.signup {user} from {}", ip_text(ip)),
            Event::Lockout { user, ip, until_ms } => format!(
                "auth.lockout {user} (failures from {}) until {until_ms}",
                ip_text(ip)
            ),
            Event::SecretsRewrap {
                phase,
                from,
                to,
                count,
            } => format!(
                "secrets.rewrap {phase}: {count} entr{} from {} to {to}",
                if *count == 1 { "y" } else { "ies" },
                from.join(", ")
            ),
            Event::ServerRestore {
                backup_seq,
                backup_hash,
            } => format!("server.restore from a backup ending at seq {backup_seq} ({backup_hash})"),
        };
        format!("mightyconsole-server: {text}")
    }
}

enum Message {
    Entry(Box<AuditEntry>),
    Flush(oneshot::Sender<()>),
}

/// Writes [`Event`]s to the log, in order, from one task.
#[derive(Clone)]
pub struct EventLog {
    tx: Option<mpsc::UnboundedSender<Message>>,
    tenant: TenantId,
    lines: Option<Arc<dyn LineWriter>>,
}

/// How long [`EventLog::flush`] waits for the writes in front of it.
const FLUSH_WAIT: Duration = Duration::from_secs(5);

impl EventLog {
    /// An event log that writes nowhere (`config check`, tests of other parts).
    pub fn discard() -> EventLog {
        EventLog {
            tx: None,
            tenant: TenantId::new("default"),
            lines: None,
        }
    }

    /// Starts the writer task. `lines` is `audit.stderr`'s line writer, and where a failed write
    /// is reported.
    pub fn spawn(
        sink: Arc<dyn AuditSink>,
        tenant: &str,
        stderr_lines: bool,
        out: Arc<dyn LineWriter>,
    ) -> (EventLog, JoinHandle<()>) {
        let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
        let report = Arc::clone(&out);
        let task = tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                match message {
                    Message::Entry(entry) => {
                        let name = entry.action.name.clone();
                        if let Err(e) = sink.append(*entry).await {
                            report.line(&format!(
                                "mightyconsole-server: WARNING: audit entry {name} not written: {}",
                                e.0
                            ));
                        }
                    }
                    Message::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        let log = EventLog {
            tx: Some(tx),
            tenant: TenantId::new(tenant),
            lines: stderr_lines.then_some(out),
        };
        (log, task)
    }

    /// Queues the event. Never blocks; a closed log drops it.
    pub fn record(&self, event: &Event) {
        if let Some(lines) = &self.lines {
            lines.line(&event.line());
        }
        let Some(tx) = &self.tx else { return };
        let Ok(correlation_id) = new_correlation_id() else {
            return;
        };
        let entry = event.entry(&self.tenant, correlation_id, unix_now_ms());
        let _ = tx.send(Message::Entry(Box::new(entry)));
    }

    /// Waits until everything queued so far is written (bounded).
    pub async fn flush(&self) {
        let Some(tx) = &self.tx else { return };
        let (done, wait) = oneshot::channel();
        if tx.send(Message::Flush(done)).is_ok() {
            let _ = tokio::time::timeout(FLUSH_WAIT, wait).await;
        }
    }
}

/// The log directory of a data directory.
pub fn audit_dir(data: &Path) -> PathBuf {
    data.join(AUDIT_DIR)
}

/// The first segment of a data directory's log, which holds a whole small log (tests).
pub fn log_path(data: &Path) -> PathBuf {
    audit_dir(data).join(audit_jsonl::check::segment_name(0))
}

/// Opens the log of the data directory: `DATA/audit/audit-<n>.jsonl`, every segment read and the
/// chain verified across them, a broken or unreadable log refused naming file, line and `seq`
/// (DOC-25 §3.6.2 point 6). With `settings.new_chain` a broken log is moved to `broken-<utc>/`
/// instead and a new chain starts, the name of the directory returned. With `checkpoint` keys
/// the checkpoint is checked (a tail cut before it is refused) and kept up to date (§3.5.4).
pub fn open_log(
    data: &Path,
    settings: &AuditSettings,
    tenant: &str,
    warn: Option<Warn>,
    checkpoint: Arc<audit_jsonl::checkpoint::CheckpointKeys>,
) -> Result<(SegmentedSink, Option<String>), AuditLogError> {
    let options = SegmentOptions {
        policy: settings.policy,
        tenant: TenantId::new(tenant),
        clock: Arc::new(security_types::SystemClock),
        warn,
        checkpoint,
    };
    let dir = audit_dir(data);
    if settings.new_chain {
        let (sink, moved_to) = SegmentedSink::open_new_chain(&dir, options)?;
        return Ok((sink, Some(moved_to)));
    }
    Ok((SegmentedSink::open(&dir, options)?, None))
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::MemoryAuditLog;

    fn entry(name: &str, risk: Risk) -> AuditEntry {
        let mut entry = Event::ServerStop.entry(&TenantId::new("t"), "c-1".into(), 1);
        entry.action = Action::new(name, "x.read");
        entry.risk = risk;
        entry.principal_chain = vec![AuditPrincipal {
            kind: PrincipalKind::Human,
            id: "human:oidc:alice".into(),
            tenant: TenantId::new("t"),
            session: SessionId::new("s"),
        }];
        entry.detail = None;
        entry
    }

    struct Lines(std::sync::Mutex<Vec<String>>);

    impl LineWriter for Lines {
        fn line(&self, line: &str) {
            self.0.lock().unwrap().push(line.to_owned());
        }
    }

    fn sink(
        reads: Reads,
        stderr: bool,
        sensitive: &[&str],
    ) -> (McAuditSink, Arc<MemoryAuditLog>, Arc<Lines>) {
        let log = Arc::new(MemoryAuditLog::new());
        let lines = Arc::new(Lines(Default::default()));
        let table = SensitiveTable::default();
        let _ = table
            .0
            .set(sensitive.iter().map(|s| (*s).to_owned()).collect());
        let sink = McAuditSink::new(
            Arc::clone(&log) as Arc<dyn AuditSink>,
            table,
            AuditSettings {
                reads,
                stderr,
                ..AuditSettings::default()
            },
            Arc::clone(&lines) as Arc<dyn LineWriter>,
        );
        (sink, log, lines)
    }

    #[tokio::test]
    async fn writes_and_destroys_and_sensitive_reads_are_kept_and_other_reads_are_not() {
        let (sink, log, _) = sink(Reads::Sensitive, false, &["k8s.secrets.reveal"]);
        for (name, risk) in [
            ("nats.kv.put", Risk::Write),
            ("docker.containers.remove", Risk::Destructive),
            ("k8s.secrets.reveal", Risk::Read),
            ("nats.kv.get", Risk::Read),
            ("temporal.workflows.list", Risk::Read),
        ] {
            sink.append(entry(name, risk)).await.unwrap();
        }
        let kept: Vec<String> = log
            .entries()
            .iter()
            .map(|e| e.action.name.clone())
            .collect();
        assert_eq!(
            kept,
            [
                "nats.kv.put",
                "docker.containers.remove",
                "k8s.secrets.reveal"
            ]
        );
    }

    #[tokio::test]
    async fn reads_all_keeps_every_call_but_never_the_quiet_ones() {
        let (sink, log, _) = sink(Reads::All, false, &[]);
        for name in [
            "nats.kv.get",
            "term.write",
            "term.resize",
            "nats.obj.uploadPart",
        ] {
            sink.append(entry(name, Risk::Write)).await.unwrap();
        }
        sink.append(entry("temporal.workflows.list", Risk::Read))
            .await
            .unwrap();
        let kept: Vec<String> = log
            .entries()
            .iter()
            .map(|e| e.action.name.clone())
            .collect();
        assert_eq!(kept, ["nats.kv.get", "temporal.workflows.list"]);
    }

    #[tokio::test]
    async fn a_refusal_is_kept_at_every_risk_and_names_why() {
        let (sink, log, _) = sink(Reads::Sensitive, false, &[]);
        for name in ["nats.kv.get", "term.write"] {
            let mut refused = entry(name, Risk::Read);
            refused.decision = AuditDecision::Deny {
                reason: Reason::MissingPermission {
                    perm: "nats.read".into(),
                },
            };
            refused.outcome = Outcome::Error {
                code: "PermissionDenied".into(),
            };
            sink.append(refused).await.unwrap();
        }
        let mut challenge = entry("nats.kv.purge", Risk::Destructive);
        challenge.decision = AuditDecision::NeedsApproval;
        challenge.approval_id = Some("apr-1".into());
        sink.append(challenge).await.unwrap();
        let entries = log.entries();
        assert_eq!(entries.len(), 3);
        let detail = |i: usize| serde_json::to_value(&entries[i].detail).unwrap();
        assert_eq!(
            detail(0),
            serde_json::json!({"reason": "missing_permission", "tool": "nats"})
        );
        assert_eq!(detail(2), serde_json::json!({"tool": "nats"}));
        assert_eq!(entries[2].approval_id.as_deref(), Some("apr-1"));
    }

    #[tokio::test]
    async fn a_call_entry_names_its_tool_and_holds_nothing_else() {
        let (sink, log, _) = sink(Reads::Sensitive, false, &[]);
        let mut write = entry("langgraph.threads.delete", Risk::Destructive);
        write.input_digest = Digest([7; 32]);
        sink.append(write).await.unwrap();
        let entries = log.entries();
        let text = serde_json::to_string(&entries[0]).unwrap();
        assert!(text.contains("\"tool\":\"langgraph\""));
        assert_eq!(entries[0].input_digest, Digest([7; 32]));
    }

    #[tokio::test]
    async fn stderr_option_prints_the_recorded_calls_only() {
        let (sink, _, lines) = sink(Reads::Sensitive, true, &["docker.containers.files.read"]);
        sink.append(entry("nats.kv.put", Risk::Write))
            .await
            .unwrap();
        sink.append(entry("docker.containers.files.read", Risk::Read))
            .await
            .unwrap();
        sink.append(entry("nats.kv.get", Risk::Read)).await.unwrap();
        {
            let lines = lines.0.lock().unwrap();
            assert_eq!(lines.len(), 2, "{lines:?}");
            assert!(lines[0].starts_with("mightyconsole-server: call nats.kv.put write"));
            assert!(lines[1].contains("docker.containers.files.read read"));
        }
        let (off, _, quiet) = sink_off();
        off.append(entry("nats.kv.put", Risk::Write)).await.unwrap();
        assert!(quiet.0.lock().unwrap().is_empty());
    }

    fn sink_off() -> (McAuditSink, Arc<MemoryAuditLog>, Arc<Lines>) {
        sink(Reads::Sensitive, false, &[])
    }

    #[test]
    fn the_table_is_read_from_the_routers_marks() {
        let router = crate::codegen_router();
        let table = SensitiveTable::default();
        assert!(!table.contains("docker.connect"), "empty until filled");
        table.fill(&router);
        let names = table.names();
        assert!(!names.is_empty());
        for meta in router.procedures() {
            assert_eq!(
                table.contains(&meta.name),
                meta.audit == AuditMode::Always,
                "{}",
                meta.name
            );
        }
    }

    fn tenant() -> TenantId {
        TenantId::new("acme")
    }

    fn fields(entry: &AuditEntry) -> serde_json::Value {
        serde_json::to_value(&entry.detail).unwrap()
    }

    #[test]
    fn a_sign_in_names_the_user_session_method_address_and_counts() {
        let event = Event::Login {
            user: "human:oidc:alice".into(),
            session: "s-1".into(),
            method: "oidc".into(),
            ip: Some("192.0.2.7".parse().unwrap()),
            groups: 3,
            roles: vec!["member".into(), "operator".into()],
        };
        let entry = event.entry(&tenant(), "c-1".into(), 5);
        assert_eq!(entry.action.name, "auth.login");
        assert_eq!(entry.principal_chain.len(), 1);
        assert_eq!(entry.principal_chain[0].id, "human:oidc:alice");
        assert_eq!(entry.principal_chain[0].session.as_str(), "s-1");
        assert_eq!(entry.tenant, tenant());
        assert_eq!(entry.outcome, Outcome::Success);
        assert_eq!(entry.input_digest, Digest::ZERO);
        assert_eq!(
            fields(&entry),
            serde_json::json!({
                "method": "oidc", "ip": "192.0.2.7", "groups": "3", "roles": "member,operator"
            })
        );
    }

    #[test]
    fn a_failed_sign_in_is_by_system_auth_and_cannot_break_the_entry() {
        let event = Event::LoginFailed {
            error: "invalid".into(),
            reason: format!("state\nmismatch {}", "x".repeat(1000)),
            ip: None,
        };
        let entry = event.entry(&tenant(), "c-2".into(), 5);
        assert_eq!(entry.principal_chain[0].id, "system:auth");
        assert_eq!(entry.principal_chain[0].kind, PrincipalKind::System);
        assert_eq!(entry.principal_chain[0].session.as_str(), "-");
        assert!(matches!(entry.decision, AuditDecision::Deny { .. }));
        assert_eq!(
            entry.outcome,
            Outcome::Error {
                code: "invalid".into()
            }
        );
        let detail = fields(&entry);
        let reason = detail["reason"].as_str().unwrap();
        assert!(reason.len() <= AuditDetail::MAX_VALUE_BYTES);
        assert!(reason.starts_with("state mismatch xxx"), "{reason}");
        assert_eq!(detail["ip"], "-");
    }

    #[test]
    fn sign_out_session_end_and_server_events_have_the_documented_detail() {
        let out = Event::Logout {
            user: "human:oidc:alice".into(),
            session: "s-1".into(),
            ip: Some("::1".parse().unwrap()),
        }
        .entry(&tenant(), "c".into(), 1);
        assert_eq!(out.action.name, "auth.logout");
        assert_eq!(fields(&out), serde_json::json!({"ip": "::1"}));

        let ended = Event::SessionEnd {
            user: "human:oidc:alice".into(),
            session: "s-1".into(),
            reason: "revoked".into(),
            by: Some("human:oidc:root".into()),
        }
        .entry(&tenant(), "c".into(), 1);
        assert_eq!(ended.action.name, "auth.session.end");
        assert_eq!(
            fields(&ended),
            serde_json::json!({"by": "human:oidc:root", "reason": "revoked"})
        );
        let idle = Event::SessionEnd {
            user: "u".into(),
            session: "s".into(),
            reason: "idle".into(),
            by: None,
        }
        .entry(&tenant(), "c".into(), 1);
        assert_eq!(fields(&idle), serde_json::json!({"reason": "idle"}));

        let start = Event::ServerStart {
            version: "0.1.0".into(),
            mode: "oidc".into(),
            exposed: true,
        }
        .entry(&tenant(), "c".into(), 1);
        assert_eq!(start.principal_chain[0].id, "system:server");
        assert_eq!(
            fields(&start),
            serde_json::json!({"exposed": "true", "mode": "oidc", "version": "0.1.0"})
        );
        let stop = Event::ServerStop.entry(&tenant(), "c".into(), 1);
        assert_eq!(stop.action.name, "server.stop");
        assert_eq!(stop.detail, None);
    }

    #[tokio::test]
    async fn the_event_log_writes_in_order_and_reports_a_failed_write() {
        let log = Arc::new(MemoryAuditLog::new());
        let lines = Arc::new(Lines(Default::default()));
        let (events, _task) = EventLog::spawn(
            Arc::clone(&log) as Arc<dyn AuditSink>,
            "acme",
            true,
            Arc::clone(&lines) as Arc<dyn LineWriter>,
        );
        events.record(&Event::ServerStop);
        events.record(&Event::Logout {
            user: "u".into(),
            session: "s".into(),
            ip: None,
        });
        events.flush().await;
        let names: Vec<String> = log
            .entries()
            .iter()
            .map(|e| e.action.name.clone())
            .collect();
        assert_eq!(names, ["server.stop", "auth.logout"]);
        assert_eq!(log.entries()[0].tenant, TenantId::new("acme"));
        assert_eq!(lines.0.lock().unwrap().len(), 2, "audit.stderr prints them");

        let broken = Arc::new(Lines(Default::default()));
        let (events, _task) = EventLog::spawn(
            Arc::new(audit_jsonl::UnavailableAuditSink("disk full".into())),
            "acme",
            false,
            Arc::clone(&broken) as Arc<dyn LineWriter>,
        );
        events.record(&Event::ServerStop);
        events.flush().await;
        let reported = broken.0.lock().unwrap();
        assert_eq!(reported.len(), 1);
        assert!(reported[0].contains("server.stop not written: disk full"));
    }

    #[tokio::test]
    async fn the_durable_log_resumes_and_a_tampered_one_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let settings = AuditSettings::default();
        let open = |settings: &AuditSettings| {
            open_log(dir.path(), settings, "t", None, Default::default())
        };
        let (sink, moved) = open(&settings).unwrap();
        assert!(moved.is_none());
        let first = audit_dir(dir.path()).join("audit-000000000001.jsonl");
        assert!(first.exists());
        sink.append(Event::ServerStop.entry(&tenant(), "c-1".into(), 1))
            .await
            .unwrap();
        drop(sink);
        let (sink, _) = open(&settings).unwrap();
        sink.append(Event::ServerStop.entry(&tenant(), "c-2".into(), 2))
            .await
            .unwrap();
        assert_eq!(sink.len(), 2);
        drop(sink);
        let text = std::fs::read_to_string(&first).unwrap();
        std::fs::write(&first, text.replacen("server.stop", "server.start", 1)).unwrap();
        let Err(err) = open(&settings) else {
            panic!("a tampered log must not open");
        };
        assert!(
            err.to_string().contains("audit-000000000001.jsonl"),
            "{err}"
        );
        // --audit-new-chain moves it aside and starts again, naming it.
        let fresh = AuditSettings {
            new_chain: true,
            ..settings
        };
        let (sink, moved) = open(&fresh).unwrap();
        let moved = moved.expect("the directory it moved to");
        assert!(moved.starts_with("broken-"));
        assert!(audit_dir(dir.path()).join(&moved).is_dir());
        assert_eq!(sink.len(), 1, "the new chain's first entry");
    }
}
