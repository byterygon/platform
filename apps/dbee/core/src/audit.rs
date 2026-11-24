//! The durable audit sink (Ambidex spec §8, DBee spec §4 and Decision 21).
//!
//! The sink itself, [`JsonlAuditSink`] with its hash chain, `fsync` per entry, verification on
//! open and [`verify`], lives in the `audit-jsonl` crate (MIT OR Apache-2.0, shared with
//! Mightyconsole, TSK-137) and is re-exported here unchanged: DBee's log format and behaviour are
//! as before. Opening a broken or unreadable log is refused, and the core then runs with an
//! [`UnavailableAuditSink`], so Write and Destructive calls (and every grant change and broker
//! open) end with `Unavailable` and nothing happens unrecorded.
//!
//! SQL text never enters an entry: `statement_digest` stays `None` until the audit passphrase
//! and encryption scheme land (Ambidex M3); `input_digest` is the only trace of a call's input.
//!
//! [`ContextSink`] wraps the sink for the Plugin Host: its grant and broker entries are written
//! from inside DBee handlers, so the wrapper sets `parent_correlation_id` to the current call's
//! correlation id (Ambidex [`CallScope::current`]) when the entry has none of its own, and adds
//! the [`AuditDetail`] a task set with [`with_detail`] (workspace restores say so). It stays here
//! because the `plugin-host.` entries are DBee's.

use ambidex::CallScope;
use security_types::{AuditDetail, AuditEntry, AuditError, AuditSink, BoxFuture};

pub use audit_jsonl::{
    AuditLogError, JsonlAuditSink, UnavailableAuditSink, VerifyReport, read_records, verify,
};

tokio::task_local! {
    /// Detail added to Plugin Host entries written while the task runs.
    static DETAIL: Option<AuditDetail>;
}

/// Runs `fut` with `detail` attached to every Plugin Host entry written from it.
pub async fn with_detail<T>(detail: AuditDetail, fut: impl Future<Output = T>) -> T {
    DETAIL.scope(Some(detail), fut).await
}

/// Entries whose action starts with this are the Plugin Host's.
const PLUGIN_HOST_PREFIX: &str = "plugin-host.";

/// Adds the calling DBee call's correlation id as `parent_correlation_id`, and the task's detail,
/// to Plugin Host entries (see the module docs).
pub struct ContextSink<S> {
    inner: S,
}

impl<S: AuditSink> ContextSink<S> {
    pub fn new(inner: S) -> Self {
        Self { inner }
    }

    pub fn inner(&self) -> &S {
        &self.inner
    }
}

impl<S: AuditSink> AuditSink for ContextSink<S> {
    fn append(&self, mut entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        if entry.action.name.starts_with(PLUGIN_HOST_PREFIX) {
            if entry.parent_correlation_id.is_none()
                && let Some(scope) = CallScope::current()
                && scope.correlation_id() != entry.correlation_id
            {
                entry.parent_correlation_id = Some(scope.correlation_id().to_owned());
            }
            if entry.detail.is_none()
                && let Ok(Some(detail)) = DETAIL.try_with(Clone::clone)
            {
                entry.detail = Some(detail);
            }
        }
        self.inner.append(entry)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use security_types::{
        Action, AuditDecision, AuditPrincipal, Digest, Outcome, Principal, PrincipalKind, Risk,
        SessionId, TenantId,
    };

    fn entry(n: u64) -> AuditEntry {
        let human = Principal {
            kind: PrincipalKind::Human,
            id: "human:local:me".into(),
            tenant: TenantId::new("local"),
            on_behalf_of: None,
            roles: vec![],
            session: SessionId::new("s"),
        };
        AuditEntry {
            timestamp_unix_ms: n,
            principal_chain: AuditPrincipal::chain_of(&human),
            tenant: TenantId::new("local"),
            action: Action::new("connections.list", "connections.read"),
            target: None,
            risk: Risk::Read,
            decision: AuditDecision::Allow,
            approval_id: None,
            outcome: Outcome::Success,
            duration_ms: Some(1),
            correlation_id: format!("c-{n}"),
            input_digest: Digest::ZERO,
            statement_digest: None,
            delivery: None,
            parent_correlation_id: None,
            detail: None,
        }
    }

    #[tokio::test]
    async fn context_sink_adds_parent_and_detail_to_plugin_host_entries_only() {
        let log = Arc::new(security_types::MemoryAuditLog::new());
        let sink = ContextSink::new(Arc::clone(&log));
        // Outside a call there is no scope: no parent is added, the detail still is.
        let detail = AuditDetail::new([("origin", "workspace_restore")]).unwrap();
        with_detail(detail.clone(), async {
            let mut grant = entry(1);
            grant.action = Action::new("plugin-host.grants.create", "admin.grants.create");
            grant.correlation_id = "child".into();
            sink.append(grant).await.unwrap();
            sink.append(entry(2)).await.unwrap();
        })
        .await;
        let entries = log.entries();
        assert_eq!(entries[0].parent_correlation_id, None);
        assert_eq!(entries[0].detail, Some(detail));
        assert_eq!(entries[1].parent_correlation_id, None);
        assert_eq!(entries[1].detail, None);
        // The parent is tested through the router in tests/core.rs, where a call scope exists.
    }
}
