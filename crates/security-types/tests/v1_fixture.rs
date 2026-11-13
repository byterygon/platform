//! Records written before `Outcome::Started` and the extensions (`delivery`,
//! `parent_correlation_id`, `detail`) existed still verify, and the same
//! entries built with today's types still hash the same (Ambidex spec Open question 26e: the
//! encodings and hashes of existing variants must not change).
//!
//! `fixtures/audit-v1.jsonl` was produced by the code on `main` before TSK-25 and cross-checked
//! with an independent implementation of the encoding. It covers every variant that existed then:
//! each principal kind, risk, decision and deny reason, both outcomes, and present and absent
//! target, approval id, duration and statement digest.

use security_types::{
    Action, AuditChain, AuditDecision, AuditDetail, AuditEntry, AuditPrincipal, AuditRecord,
    Digest, Outcome, Principal, PrincipalKind, Reason, Risk, RoleId, SessionId, TargetRef,
    TenantId,
};

const FIXTURE: &str = include_str!("fixtures/audit-v1.jsonl");

/// Hash of the fixture's last record, i.e. of the whole chain.
const HEAD: &str = "5fa35364c60e63130b5ceeb61394b70263fd1c53fe7a59f066fdbc94908d05b4";

fn records() -> Vec<AuditRecord> {
    FIXTURE
        .lines()
        .map(|line| serde_json::from_str(line).expect("fixture record parses"))
        .collect()
}

fn principal(kind: PrincipalKind, id: &str, session: &str, obo: Option<Principal>) -> Principal {
    Principal {
        kind,
        id: id.into(),
        tenant: TenantId::new("t1"),
        on_behalf_of: obo.map(Box::new),
        roles: vec![RoleId::new("r")],
        session: SessionId::new(session),
    }
}

/// The entries the fixture was generated from.
fn entries() -> Vec<AuditEntry> {
    let human = principal(PrincipalKind::Human, "human:oidc:alice", "s-h", None);
    let agent = principal(
        PrincipalKind::Agent,
        "agent:token:a",
        "s-a",
        Some(human.clone()),
    );
    let plugin = principal(
        PrincipalKind::Plugin,
        "plugin:org.example.pg#sha256:ab",
        "s-p",
        Some(human.clone()),
    );
    let system = principal(PrincipalKind::System, "system:expiry", "s-s", None);
    let base = |chain: &Principal, n: u8| AuditEntry {
        timestamp_unix_ms: 1_760_000_000_000 + u64::from(n),
        principal_chain: AuditPrincipal::chain_of(chain),
        tenant: TenantId::new("t1"),
        action: Action::new("query.execute", "db.query.execute"),
        target: None,
        risk: Risk::Read,
        decision: AuditDecision::Allow,
        approval_id: None,
        outcome: Outcome::Success,
        duration_ms: None,
        correlation_id: format!("corr-{n}"),
        input_digest: Digest([n; 32]),
        statement_digest: None,
        delivery: None,
        parent_correlation_id: None,
        detail: None,
    };
    let denied = |code: &str| Outcome::Error { code: code.into() };

    let mut allowed = base(&agent, 0);
    allowed.target = Some(TargetRef::connection("local:pg1"));
    allowed.duration_ms = Some(12);
    allowed.statement_digest = Some(Digest([9; 32]));

    let mut unknown_perm = base(&human, 1);
    unknown_perm.risk = Risk::Write;
    unknown_perm.decision = AuditDecision::Deny {
        reason: Reason::UnknownPermission {
            perm: "fixture.admin".into(),
        },
    };
    unknown_perm.outcome = denied("PermissionDenied");

    let mut missing_perm = base(&plugin, 2);
    missing_perm.risk = Risk::Destructive;
    missing_perm.decision = AuditDecision::Deny {
        reason: Reason::MissingPermission {
            perm: "db.ddl".into(),
        },
    };
    missing_perm.outcome = denied("PermissionDenied");

    let mut tenant = base(&system, 3);
    tenant.decision = AuditDecision::Deny {
        reason: Reason::TenantMismatch,
    };
    tenant.outcome = denied("PermissionDenied");

    let mut policy = base(&agent, 4);
    policy.action = Action::new("plugin-host.broker.open", "plugin.net.connect");
    policy.decision = AuditDecision::Deny {
        reason: Reason::Policy {
            message: "grant revoked".into(),
        },
    };
    policy.outcome = denied("PermissionDenied");
    policy.duration_ms = Some(3);

    let mut approval = base(&agent, 5);
    approval.risk = Risk::Destructive;
    approval.decision = AuditDecision::NeedsApproval;
    approval.approval_id = Some("apr-7".into());
    approval.outcome = denied("ApprovalRequired");

    vec![
        allowed,
        unknown_perm,
        missing_perm,
        tenant,
        policy,
        approval,
    ]
}

#[test]
fn pre_existing_records_still_verify() {
    let records = records();
    assert_eq!(records.len(), 6);
    let head = AuditChain::verify_all(&records).expect("the v1 fixture verifies");
    assert_eq!(head.next_seq(), 6);
    assert_eq!(records.last().unwrap().hash.to_string(), HEAD);
    assert!(records.iter().all(|r| {
        let e = &r.entry;
        e.delivery.is_none() && e.parent_correlation_id.is_none() && e.detail.is_none()
    }));
}

#[test]
fn rebuilt_entries_hash_as_they_did_before() {
    let mut chain = AuditChain::new();
    for (rebuilt, stored) in entries().into_iter().zip(records()) {
        assert_eq!(rebuilt, stored.entry);
        assert_eq!(
            chain.append(rebuilt),
            stored,
            "record {} changed",
            stored.seq
        );
    }
}

#[test]
fn reserialized_records_are_byte_identical() {
    // Extensions are omitted when absent, so old records keep their stored JSON exactly.
    for (line, record) in FIXTURE.lines().zip(records()) {
        assert_eq!(serde_json::to_string(&record).unwrap(), line);
    }
}

#[test]
fn a_record_with_detail_continues_the_old_chain() {
    // Extension 3 (TSK-35): old records keep their hashes, and a new record with `detail` links
    // to them. The detail is covered by the hash: changing or dropping it is detected.
    let mut records = records();
    let mut chain = AuditChain::verify_all(&records).unwrap();
    let mut entry = entries().remove(0);
    entry.detail = Some(AuditDetail::new([("to_version", "1.1.0")]).unwrap());
    records.push(chain.append(entry));
    assert_eq!(records[5].hash.to_string(), HEAD);
    assert_eq!(AuditChain::verify_all(&records).unwrap().next_seq(), 7);

    let line = serde_json::to_string(&records[6]).unwrap();
    assert!(line.contains(r#""detail":{"to_version":"1.1.0"}"#));
    for tampered in [
        line.replace("1.1.0", "1.1.1"),
        line.replace(r#","detail":{"to_version":"1.1.0"}"#, ""),
    ] {
        assert_ne!(tampered, line);
        let record: AuditRecord = serde_json::from_str(&tampered).unwrap();
        assert_ne!(record.compute_hash(), record.hash);
    }
}
