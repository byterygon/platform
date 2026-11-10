//! Audit record shared by Ambidex and Plugin Host (Ambidex spec §8 "Audit").
//!
//! Records form a hash chain: each [`AuditRecord`] carries the hash of the previous record
//! (`prev_hash`, all zeros for the first) and its own `hash`, a SHA-256 over a domain-separated,
//! length-prefixed binary encoding of `seq`, `prev_hash` and the [`AuditEntry`]. The encoding is
//! independent of JSON, so the stored form (JSON Lines, a table) can change without breaking
//! verification.
//!
//! The chain detects edits, insertions, deletions and reordering inside a sequence of records.
//! It does not on its own detect truncation of the newest records or a full rewrite by someone who
//! can write the log; that needs an external anchor (audit store, M3).
//!
//! # Calls that run: two entries
//!
//! An operation that runs is recorded twice under one `correlation_id` (Ambidex spec §8, Open
//! question 26): an admission entry with [`Outcome::Started`], written before it runs, and a
//! completion entry with the result ([`Outcome::Success`] or [`Outcome::Error`]), the
//! [`Delivery`] and the duration. A `Started` entry without a matching completion means the
//! outcome is unknown: the process crashed, or an admission write that failed ambiguously was
//! followed by a retry. Refusals and Plugin Host operations are one entry each.
//!
//! # Format version
//!
//! The hash domain is `byterygon.audit.record.v1`. v1 is frozen once the first durable log ships;
//! any later format change requires v2. Until then v1 may only grow in ways that leave every
//! existing record's encoding, and so its hash, unchanged: a new enum variant takes a tag never
//! used before ([`Outcome::Started`] is tag 2), and a new field is optional, encoded only when
//! present, after every older field, as its extension number then its value ([`Delivery`] is
//! extension 1, [`AuditEntry::parent_correlation_id`] extension 2, in that order). Both keep the encoding unambiguous: old records parse exactly as before, and
//! bytes after the last v1 field can only be an extension.

use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

use crate::{
    Action, Decision, Digest, Principal, PrincipalKind, Reason, Risk, SessionId, TargetRef,
    TenantId,
};

/// Domain separator for record hashes. Frozen once the first durable log ships; see the module
/// docs for the only changes v1 still allows.
const DOMAIN: &[u8] = b"byterygon.audit.record.v1\0";

/// Extension number of [`AuditEntry::delivery`] in the encoding.
const EXT_DELIVERY: u8 = 1;
/// Extension number of [`AuditEntry::parent_correlation_id`] in the encoding.
const EXT_PARENT_CORRELATION_ID: u8 = 2;

/// One principal in the acting chain, without its roles.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditPrincipal {
    pub kind: PrincipalKind,
    pub id: String,
    pub tenant: TenantId,
    pub session: SessionId,
}

impl AuditPrincipal {
    /// The principal and everyone it acts for, nearest first.
    pub fn chain_of(principal: &Principal) -> Vec<AuditPrincipal> {
        principal
            .chain()
            .map(|p| AuditPrincipal {
                kind: p.kind,
                id: p.id.clone(),
                tenant: p.tenant.clone(),
                session: p.session.clone(),
            })
            .collect()
    }
}

/// The authorization decision as recorded. The approval itself is referenced by
/// [`AuditEntry::approval_id`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum AuditDecision {
    Allow,
    Deny { reason: Reason },
    NeedsApproval,
}

impl From<&Decision> for AuditDecision {
    fn from(d: &Decision) -> Self {
        match d {
            Decision::Allow => AuditDecision::Allow,
            Decision::Deny { reason } => AuditDecision::Deny {
                reason: reason.clone(),
            },
            Decision::NeedsApproval { .. } => AuditDecision::NeedsApproval,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Outcome {
    Success,
    /// `code` is the transport's error code, e.g. Ambidex's `"PermissionDenied"`.
    Error {
        code: String,
    },
    /// An admission entry: the decision was `Allow` and the operation is about to run. Its
    /// result is in the completion entry with the same `correlation_id`.
    Started,
}

/// What the client actually received when a call ended, recorded in completion entries next to
/// the handler's own result ([`AuditEntry::outcome`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Delivery {
    /// The handler's answer (its value or its error) went out.
    Delivered,
    /// The client got `Cancelled` instead (`Cancel`, `Unsubscribe`, disconnect, revocation), or
    /// nothing, after `Unsubscribe` or once the connection closed.
    Cancelled,
    /// The client got `DeadlineExceeded` instead.
    DeadlineExceeded,
    /// The answer did not fit a frame and the client got `ResourceExhausted` instead (also used
    /// when a subscription ended because an event did not fit its buffer).
    FrameTooLarge,
}

/// What happened. Argument values are never part of the entry; only `input_digest` is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditEntry {
    pub timestamp_unix_ms: u64,
    pub principal_chain: Vec<AuditPrincipal>,
    pub tenant: TenantId,
    pub action: Action,
    pub target: Option<TargetRef>,
    pub risk: Risk,
    pub decision: AuditDecision,
    pub approval_id: Option<String>,
    pub outcome: Outcome,
    pub duration_ms: Option<u64>,
    pub correlation_id: String,
    pub input_digest: Digest,
    /// Keyed digest (HMAC with a server-held key) of the SQL statement, when there is one. The
    /// encrypted statement text is added with the M3 encryption scheme.
    pub statement_digest: Option<Digest>,
    /// What the client received; set on completion entries only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<Delivery>,
    /// The correlation id of the call whose handler made this call, for a call made from inside
    /// another call's handler (Ambidex nested calls); `None` for a top-level call and for Plugin
    /// Host entries. Set on both entries of such a call and on its re-checks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_correlation_id: Option<String>,
}

impl AuditEntry {
    /// Whether this is a completion entry (it records what the client received).
    pub fn is_completion(&self) -> bool {
        self.delivery.is_some()
    }
}

/// The admission entries (`Started`) of `entries` with no completion under the same correlation
/// id: calls whose outcome is unknown (the process crashed, or an admission write failed
/// ambiguously and was retried). Entries are matched within the slice given, so pass a span of the
/// log that contains the completions too.
pub fn unfinished(entries: &[AuditEntry]) -> Vec<&AuditEntry> {
    let completed: std::collections::HashSet<&str> = entries
        .iter()
        .filter(|e| e.is_completion())
        .map(|e| e.correlation_id.as_str())
        .collect();
    entries
        .iter()
        .filter(|e| e.outcome == Outcome::Started && !completed.contains(e.correlation_id.as_str()))
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditRecord {
    pub seq: u64,
    pub prev_hash: Digest,
    pub entry: AuditEntry,
    pub hash: Digest,
}

impl AuditRecord {
    /// The hash this record should carry, computed from `seq`, `prev_hash` and `entry`.
    pub fn compute_hash(&self) -> Digest {
        hash_record(self.seq, &self.prev_hash, &self.entry)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError {
    UnexpectedSeq { expected: u64, found: u64 },
    PrevHashMismatch { seq: u64 },
    HashMismatch { seq: u64 },
}

impl fmt::Display for ChainError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ChainError::UnexpectedSeq { expected, found } => {
                write!(
                    f,
                    "audit chain broken: expected seq {expected}, found {found}"
                )
            }
            ChainError::PrevHashMismatch { seq } => {
                write!(
                    f,
                    "audit chain broken: record {seq} does not link to the previous record"
                )
            }
            ChainError::HashMismatch { seq } => write!(f, "audit record {seq} was modified"),
        }
    }
}

impl std::error::Error for ChainError {}

/// The head of an audit chain: appends new records and verifies existing ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditChain {
    next_seq: u64,
    last_hash: Digest,
}

impl Default for AuditChain {
    fn default() -> Self {
        Self::new()
    }
}

impl AuditChain {
    /// An empty chain. The first record gets `seq` 0 and an all-zero `prev_hash`.
    pub fn new() -> Self {
        Self {
            next_seq: 0,
            last_hash: Digest::ZERO,
        }
    }

    /// Continue a chain after its last stored record. Checks that record's own hash only; call
    /// [`AuditChain::verify_all`] to check the whole log.
    pub fn resume_after(last: &AuditRecord) -> Result<Self, ChainError> {
        if last.compute_hash() != last.hash {
            return Err(ChainError::HashMismatch { seq: last.seq });
        }
        Ok(Self {
            next_seq: last.seq + 1,
            last_hash: last.hash,
        })
    }

    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn append(&mut self, entry: AuditEntry) -> AuditRecord {
        let seq = self.next_seq;
        let prev_hash = self.last_hash;
        let hash = hash_record(seq, &prev_hash, &entry);
        self.next_seq += 1;
        self.last_hash = hash;
        AuditRecord {
            seq,
            prev_hash,
            entry,
            hash,
        }
    }

    /// Check that `record` is the next record of this chain, and advance past it.
    pub fn verify_next(&mut self, record: &AuditRecord) -> Result<(), ChainError> {
        if record.seq != self.next_seq {
            return Err(ChainError::UnexpectedSeq {
                expected: self.next_seq,
                found: record.seq,
            });
        }
        if record.prev_hash != self.last_hash {
            return Err(ChainError::PrevHashMismatch { seq: record.seq });
        }
        if record.compute_hash() != record.hash {
            return Err(ChainError::HashMismatch { seq: record.seq });
        }
        self.next_seq += 1;
        self.last_hash = record.hash;
        Ok(())
    }

    /// Verify a complete log from its first record. Returns the chain head, ready to append.
    pub fn verify_all<'a>(
        records: impl IntoIterator<Item = &'a AuditRecord>,
    ) -> Result<Self, ChainError> {
        let mut chain = Self::new();
        for record in records {
            chain.verify_next(record)?;
        }
        Ok(chain)
    }
}

fn hash_record(seq: u64, prev_hash: &Digest, entry: &AuditEntry) -> Digest {
    let mut enc = Encoder(Sha256::new());
    enc.raw(DOMAIN);
    enc.u64(seq);
    enc.digest(prev_hash);
    enc.entry(entry);
    Digest(enc.0.finalize().into())
}

/// Length-prefixed, fixed-order encoding fed straight into the hasher. Enum tags are explicit
/// constants so reordering variants cannot silently change hashes.
struct Encoder(Sha256);

impl Encoder {
    fn raw(&mut self, bytes: &[u8]) {
        self.0.update(bytes);
    }

    fn u8(&mut self, v: u8) {
        self.raw(&[v]);
    }

    fn u64(&mut self, v: u64) {
        self.raw(&v.to_le_bytes());
    }

    fn str(&mut self, s: &str) {
        self.u64(s.len() as u64);
        self.raw(s.as_bytes());
    }

    fn digest(&mut self, d: &Digest) {
        self.raw(d.as_bytes());
    }

    fn opt<T>(&mut self, v: Option<T>, f: impl FnOnce(&mut Self, T)) {
        match v {
            None => self.u8(0),
            Some(v) => {
                self.u8(1);
                f(self, v);
            }
        }
    }

    fn entry(&mut self, e: &AuditEntry) {
        // Destructure so that adding a field fails to compile until it is encoded here.
        let AuditEntry {
            timestamp_unix_ms,
            principal_chain,
            tenant,
            action,
            target,
            risk,
            decision,
            approval_id,
            outcome,
            duration_ms,
            correlation_id,
            input_digest,
            statement_digest,
            delivery,
            parent_correlation_id,
        } = e;
        self.u64(*timestamp_unix_ms);
        self.u64(principal_chain.len() as u64);
        for p in principal_chain {
            self.principal(p);
        }
        self.str(tenant.as_str());
        self.str(&action.name);
        self.str(action.perm.as_str());
        self.opt(target.as_ref(), |s, t| {
            s.str(&t.kind);
            s.str(&t.id);
        });
        self.u8(match risk {
            Risk::Read => 0,
            Risk::Write => 1,
            Risk::Destructive => 2,
        });
        self.decision(decision);
        self.opt(approval_id.as_deref(), Self::str);
        match outcome {
            Outcome::Success => self.u8(0),
            Outcome::Error { code } => {
                self.u8(1);
                self.str(code);
            }
            Outcome::Started => self.u8(2),
        }
        self.opt(*duration_ms, Self::u64);
        self.str(correlation_id);
        self.digest(input_digest);
        self.opt(statement_digest.as_ref(), Self::digest);
        // Extensions (see the module docs): encoded only when present, so records without them
        // hash as before.
        if let Some(delivery) = delivery {
            self.u8(EXT_DELIVERY);
            self.u8(match delivery {
                Delivery::Delivered => 0,
                Delivery::Cancelled => 1,
                Delivery::DeadlineExceeded => 2,
                Delivery::FrameTooLarge => 3,
            });
        }
        if let Some(parent) = parent_correlation_id {
            self.u8(EXT_PARENT_CORRELATION_ID);
            self.str(parent);
        }
    }

    fn principal(&mut self, p: &AuditPrincipal) {
        let AuditPrincipal {
            kind,
            id,
            tenant,
            session,
        } = p;
        self.u8(match kind {
            PrincipalKind::Human => 0,
            PrincipalKind::Agent => 1,
            PrincipalKind::Plugin => 2,
            PrincipalKind::System => 3,
        });
        self.str(id);
        self.str(tenant.as_str());
        self.str(session.as_str());
    }

    fn decision(&mut self, d: &AuditDecision) {
        match d {
            AuditDecision::Allow => self.u8(0),
            AuditDecision::Deny { reason } => {
                self.u8(1);
                match reason {
                    Reason::UnknownPermission { perm } => {
                        self.u8(0);
                        self.str(perm.as_str());
                    }
                    Reason::MissingPermission { perm } => {
                        self.u8(1);
                        self.str(perm.as_str());
                    }
                    Reason::TenantMismatch => self.u8(2),
                    Reason::Policy { message } => {
                        self.u8(3);
                        self.str(message);
                    }
                }
            }
            AuditDecision::NeedsApproval => self.u8(2),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{RoleId, SessionId};

    fn entry(n: u64) -> AuditEntry {
        let human = Principal {
            kind: PrincipalKind::Human,
            id: "human:oidc:alice".into(),
            tenant: TenantId::new("t1"),
            on_behalf_of: None,
            roles: vec![RoleId::new("analyst")],
            session: SessionId::new("s-human"),
        };
        let agent = Principal {
            kind: PrincipalKind::Agent,
            id: "agent:token:a".into(),
            tenant: TenantId::new("t1"),
            on_behalf_of: Some(Box::new(human)),
            roles: vec![RoleId::new("agent-read")],
            session: SessionId::new("s-agent"),
        };
        AuditEntry {
            timestamp_unix_ms: 1_760_000_000_000 + n,
            principal_chain: AuditPrincipal::chain_of(&agent),
            tenant: TenantId::new("t1"),
            action: Action::new("query.execute", "db.query.execute"),
            target: Some(TargetRef::connection("local:pg1")),
            risk: Risk::Read,
            decision: AuditDecision::Allow,
            approval_id: None,
            outcome: Outcome::Success,
            duration_ms: Some(12),
            correlation_id: format!("corr-{n}"),
            input_digest: Digest([7; 32]),
            statement_digest: Some(Digest([9; 32])),
            delivery: None,
            parent_correlation_id: None,
        }
    }

    fn log(n: u64) -> Vec<AuditRecord> {
        let mut chain = AuditChain::new();
        (0..n).map(|i| chain.append(entry(i))).collect()
    }

    #[test]
    fn appended_chain_verifies() {
        let records = log(5);
        assert_eq!(records[0].prev_hash, Digest::ZERO);
        for w in records.windows(2) {
            assert_eq!(w[1].prev_hash, w[0].hash);
        }
        assert_eq!(AuditChain::verify_all(&records).unwrap().next_seq(), 5);
    }

    #[test]
    fn hash_is_stable() {
        // Golden value, cross-checked with an independent implementation of the encoding.
        // Changing the encoding must bump DOMAIN and update this vector.
        assert_eq!(
            log(1)[0].hash.to_string(),
            "d3df538708e2625a8002ce2b328095fa21c0032a6588f6bd71a04311de9563a4"
        );
    }

    /// An admission and its completion, as the Ambidex router writes them.
    fn admission_and_completion() -> (AuditEntry, AuditEntry) {
        let mut admission = entry(0);
        admission.outcome = Outcome::Started;
        admission.duration_ms = None;
        let mut completion = entry(1);
        completion.correlation_id = admission.correlation_id.clone();
        completion.delivery = Some(Delivery::DeadlineExceeded);
        (admission, completion)
    }

    #[test]
    fn started_and_delivery_hashes_are_stable() {
        // Golden values, cross-checked with an independent implementation of the encoding
        // (`Started` is outcome tag 2; `delivery` is extension 1, then its tag).
        let (admission, completion) = admission_and_completion();
        let mut chain = AuditChain::new();
        assert_eq!(
            chain.append(admission).hash.to_string(),
            "05917c354f43144fe34f506de9a05899ae3ff97de1301583a095340f3a6f363f"
        );
        assert_eq!(
            chain.append(completion).hash.to_string(),
            "47dc434cddaa06fb6089ae6b0ab379d67d32bab781538fff92cb10a8b75678aa"
        );
    }

    /// [`admission_and_completion`] of a call made from inside the handler of `corr-parent`.
    fn nested_admission_and_completion() -> (AuditEntry, AuditEntry) {
        let (mut admission, mut completion) = admission_and_completion();
        admission.parent_correlation_id = Some("corr-parent".into());
        completion.parent_correlation_id = Some("corr-parent".into());
        (admission, completion)
    }

    #[test]
    fn parent_correlation_id_hashes_are_stable() {
        // Golden values, cross-checked with an independent implementation of the encoding
        // (`parent_correlation_id` is extension 2, then the length-prefixed id, after `delivery`).
        let (admission, completion) = nested_admission_and_completion();
        let mut chain = AuditChain::new();
        assert_eq!(
            chain.append(admission).hash.to_string(),
            "981258a3a837f12aaf2fca722d2eeaf256f2df7fbc3d4ebc5907e74f23728c9f"
        );
        assert_eq!(
            chain.append(completion).hash.to_string(),
            "35eb5f89d7d7c55e31412229e489748343f8859f8583d92e0f45779d39e85c1b"
        );
    }

    #[test]
    fn parent_correlation_id_is_omitted_from_json_when_absent() {
        let (admission, _) = admission_and_completion();
        let json = serde_json::to_value(&admission).unwrap();
        assert!(json.get("parentCorrelationId").is_none());
        let (nested, _) = nested_admission_and_completion();
        let json = serde_json::to_value(&nested).unwrap();
        assert_eq!(json["parentCorrelationId"], "corr-parent");
        assert_eq!(serde_json::from_value::<AuditEntry>(json).unwrap(), nested);
    }

    #[test]
    fn records_without_extensions_hash_as_before() {
        // `delivery: None` adds nothing to the encoding, so a record from before the field
        // existed keeps its hash; any `Some` changes it, and each variant differently.
        let base = log(1).remove(0);
        let mut hashes = vec![base.hash];
        for delivery in [
            Delivery::Delivered,
            Delivery::Cancelled,
            Delivery::DeadlineExceeded,
            Delivery::FrameTooLarge,
        ] {
            let mut r = base.clone();
            r.entry.delivery = Some(delivery);
            hashes.push(r.compute_hash());
        }
        let unique: std::collections::HashSet<_> = hashes.iter().collect();
        assert_eq!(unique.len(), hashes.len());
    }

    #[test]
    fn started_differs_from_every_other_outcome() {
        let base = log(1).remove(0);
        let outcomes = [
            Outcome::Success,
            Outcome::Error {
                code: String::new(),
            },
            Outcome::Started,
        ];
        let hashes: std::collections::HashSet<_> = outcomes
            .into_iter()
            .map(|outcome| {
                let mut r = base.clone();
                r.entry.outcome = outcome;
                r.compute_hash()
            })
            .collect();
        assert_eq!(hashes.len(), 3);
    }

    #[test]
    fn a_started_entry_without_completion_is_unfinished() {
        let (admission, completion) = admission_and_completion();
        let mut crashed = admission.clone();
        crashed.correlation_id = "corr-crashed".into();
        let refusal = entry(2);
        let entries = vec![admission, crashed.clone(), refusal, completion];
        assert_eq!(unfinished(&entries), [&crashed]);
        assert!(entries[3].is_completion() && !entries[0].is_completion());
    }

    #[test]
    fn delivery_is_omitted_from_json_when_absent() {
        let (admission, completion) = admission_and_completion();
        let admission = serde_json::to_value(&admission).unwrap();
        assert!(admission.get("delivery").is_none());
        assert_eq!(
            admission["outcome"],
            serde_json::json!({ "kind": "Started" })
        );
        let completion = serde_json::to_value(&completion).unwrap();
        assert_eq!(completion["delivery"], "DeadlineExceeded");
        assert_eq!(
            serde_json::from_value::<AuditEntry>(completion.clone()).unwrap(),
            admission_and_completion().1
        );
    }

    #[test]
    fn modified_entry_is_detected() {
        let mut records = log(3);
        records[1].entry.decision = AuditDecision::Deny {
            reason: Reason::TenantMismatch,
        };
        assert_eq!(
            AuditChain::verify_all(&records),
            Err(ChainError::HashMismatch { seq: 1 })
        );
    }

    #[test]
    fn rehashed_modification_breaks_the_link() {
        let mut records = log(3);
        records[1].entry.risk = Risk::Destructive;
        records[1].hash = records[1].compute_hash();
        assert_eq!(
            AuditChain::verify_all(&records),
            Err(ChainError::PrevHashMismatch { seq: 2 })
        );
    }

    #[test]
    fn deleted_record_is_detected() {
        let mut records = log(3);
        records.remove(1);
        assert_eq!(
            AuditChain::verify_all(&records),
            Err(ChainError::UnexpectedSeq {
                expected: 1,
                found: 2
            })
        );
    }

    #[test]
    fn reordered_records_are_detected() {
        let mut records = log(3);
        records.swap(1, 2);
        assert!(AuditChain::verify_all(&records).is_err());
    }

    #[test]
    fn every_field_affects_the_hash() {
        let base = log(1).remove(0);
        let mutations: Vec<fn(&mut AuditEntry)> = vec![
            |e| e.timestamp_unix_ms += 1,
            |e| {
                e.principal_chain.pop();
            },
            |e| e.principal_chain[1].kind = PrincipalKind::System,
            |e| e.principal_chain[0].session = SessionId::new("other"),
            |e| e.tenant = TenantId::new("t2"),
            |e| e.action.name = "query.other".into(),
            |e| e.action.perm = "db.other".into(),
            |e| e.target = None,
            |e| e.risk = Risk::Write,
            |e| e.decision = AuditDecision::NeedsApproval,
            |e| e.approval_id = Some("ap-1".into()),
            |e| {
                e.outcome = Outcome::Error {
                    code: "Cancelled".into(),
                }
            },
            |e| e.duration_ms = None,
            |e| e.correlation_id.push('x'),
            |e| e.input_digest = Digest([8; 32]),
            |e| e.statement_digest = None,
            |e| e.outcome = Outcome::Started,
            |e| e.delivery = Some(Delivery::Delivered),
            |e| e.parent_correlation_id = Some("corr-parent".into()),
        ];
        for (i, mutate) in mutations.into_iter().enumerate() {
            let mut r = base.clone();
            mutate(&mut r.entry);
            assert_ne!(
                r.compute_hash(),
                base.hash,
                "mutation {i} did not change the hash"
            );
        }
    }

    #[test]
    fn length_prefix_prevents_field_shifting() {
        let mut a = log(1).remove(0);
        let mut b = a.clone();
        a.entry.action = Action::new("ab", "c");
        b.entry.action = Action::new("a", "bc");
        assert_ne!(a.compute_hash(), b.compute_hash());
    }

    #[test]
    fn resume_continues_the_chain() {
        let mut records = log(2);
        let mut chain = AuditChain::resume_after(records.last().unwrap()).unwrap();
        records.push(chain.append(entry(2)));
        assert!(AuditChain::verify_all(&records).is_ok());

        let mut tampered = records[2].clone();
        tampered.entry.correlation_id = "x".into();
        assert_eq!(
            AuditChain::resume_after(&tampered),
            Err(ChainError::HashMismatch { seq: 2 })
        );
    }

    #[test]
    fn json_lines_round_trip_and_verify() {
        let records = log(3);
        let lines: Vec<String> = records
            .iter()
            .map(|r| serde_json::to_string(r).unwrap())
            .collect();
        let parsed: Vec<AuditRecord> = lines
            .iter()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(parsed, records);
        assert!(AuditChain::verify_all(&parsed).is_ok());
        assert!(lines[0].contains("\"prevHash\":\"0000"));
    }

    #[test]
    fn json_rejects_unknown_fields() {
        let mut v = serde_json::to_value(&log(1)[0]).unwrap();
        v["entry"]["sqlText"] = "select 1".into();
        assert!(serde_json::from_value::<AuditRecord>(v).is_err());
    }
}
