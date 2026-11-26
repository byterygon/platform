//! The segmented log: rotation, retention, the size limit, a new chain, and `check_files` on
//! logs that were edited, cut or lost a segment (DOC-25 §3.5.4 to §3.5.6, TSK-137).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use audit_jsonl::{
    BreakKind, CheckError, SegmentOptions, SegmentPolicy, SegmentedSink, check_files, segment_files,
};
use security_types::{
    Action, AuditDecision, AuditEntry, AuditPrincipal, AuditRecord, AuditSink, BoxFuture, Clock,
    Digest, Outcome, Principal, PrincipalKind, Risk, SessionId, TenantId,
};

const DAY: u64 = 86_400_000;
/// 2026-11-25 00:00:00 UTC.
const T0: u64 = 1_795_564_800_000;

struct TestClock(AtomicU64);

impl TestClock {
    fn at(ms: u64) -> Arc<TestClock> {
        Arc::new(TestClock(AtomicU64::new(ms)))
    }

    fn set(&self, ms: u64) {
        self.0.store(ms, Ordering::SeqCst);
    }
}

impl Clock for TestClock {
    fn now_unix_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }

    fn sleep_until(&self, _deadline_unix_ms: u64) -> BoxFuture<'_, ()> {
        Box::pin(std::future::ready(()))
    }
}

fn entry(n: u64, at_ms: u64) -> AuditEntry {
    let human = Principal {
        kind: PrincipalKind::Human,
        id: "human:oidc:alice".into(),
        tenant: TenantId::new("t"),
        on_behalf_of: None,
        roles: vec![],
        session: SessionId::new("s"),
    };
    AuditEntry {
        timestamp_unix_ms: at_ms,
        principal_chain: AuditPrincipal::chain_of(&human),
        tenant: TenantId::new("t"),
        action: Action::new("nats.kv.put", "nats.write"),
        target: None,
        risk: Risk::Write,
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

fn options(clock: &Arc<TestClock>, policy: SegmentPolicy) -> SegmentOptions {
    SegmentOptions {
        policy,
        tenant: TenantId::new("t"),
        clock: Arc::clone(clock) as Arc<dyn Clock>,
        warn: None,
        checkpoint: Default::default(),
    }
}

fn small(segment_bytes: u64) -> SegmentPolicy {
    SegmentPolicy {
        segment_bytes,
        ..SegmentPolicy::default()
    }
}

fn files(dir: &Path) -> Vec<PathBuf> {
    segment_files(dir).unwrap()
}

fn names(dir: &Path) -> Vec<String> {
    files(dir)
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect()
}

fn records(dir: &Path) -> Vec<AuditRecord> {
    files(dir)
        .iter()
        .flat_map(|p| {
            fs::read_to_string(p)
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str::<AuditRecord>(l).unwrap())
                .collect::<Vec<_>>()
        })
        .collect()
}

fn broken(dir: &Path) -> audit_jsonl::Break {
    match check_files(&files(dir)) {
        Err(CheckError::Broken(b)) => *b,
        other => panic!("expected a break, got {other:?}"),
    }
}

/// Writes `n` entries a minute apart from `T0`, and returns the directory.
async fn log_of(n: u64, policy: SegmentPolicy) -> (tempfile::TempDir, Arc<TestClock>) {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, policy)).unwrap();
    for i in 0..n {
        sink.append(entry(i, T0 + i * 60_000)).await.unwrap();
    }
    (dir, clock)
}

#[tokio::test]
async fn a_new_segment_starts_at_the_size_and_the_chain_continues_across_files() {
    let (dir, _) = log_of(20, small(2_000)).await;
    let names = names(dir.path());
    assert!(names.len() >= 4, "{names:?}");
    assert_eq!(names[0], "audit-000000000001.jsonl");
    // Each file is named by its first record's number.
    let all = records(dir.path());
    assert_eq!(all.len(), 20);
    for (path, first) in files(dir.path()).iter().zip(segments_first_seq(dir.path())) {
        let name = path.file_name().unwrap().to_string_lossy();
        assert_eq!(name, format!("audit-{:012}.jsonl", first + 1));
    }
    // The first record of a file carries the last hash of the previous file; seq continues.
    for pair in all.windows(2) {
        assert_eq!(pair[1].seq, pair[0].seq + 1);
        assert_eq!(pair[1].prev_hash, pair[0].hash);
    }
    let checked = check_files(&files(dir.path())).unwrap();
    assert_eq!(checked.records, 20);
    assert_eq!(checked.head.unwrap().0, 19);
    assert!(checked.segments.len() >= 4);
    assert!(checked.unfinished.is_empty());
}

fn segments_first_seq(dir: &Path) -> Vec<u64> {
    check_files(&files(dir))
        .unwrap()
        .segments
        .iter()
        .filter_map(|s| s.first_seq)
        .collect()
}

#[tokio::test]
async fn a_new_segment_starts_at_midnight_utc() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, SegmentPolicy::default())).unwrap();
    sink.append(entry(0, T0 + 1_000)).await.unwrap();
    sink.append(entry(1, T0 + DAY - 1_000)).await.unwrap();
    assert_eq!(names(dir.path()).len(), 1, "still the same day");
    sink.append(entry(2, T0 + DAY + 1_000)).await.unwrap();
    assert_eq!(names(dir.path()).len(), 2, "the next UTC day");
    sink.append(entry(3, T0 + DAY + 2_000)).await.unwrap();
    assert_eq!(
        names(dir.path()),
        ["audit-000000000001.jsonl", "audit-000000000003.jsonl"]
    );
    assert_eq!(check_files(&files(dir.path())).unwrap().records, 4);
}

#[tokio::test]
async fn reopening_resumes_the_chain_in_the_newest_segment() {
    let (dir, clock) = log_of(10, small(2_000)).await;
    let before = names(dir.path()).len();
    let sink = SegmentedSink::open(dir.path(), options(&clock, small(2_000))).unwrap();
    assert_eq!(sink.len(), 10);
    sink.append(entry(10, T0 + 10 * 60_000)).await.unwrap();
    assert!(names(dir.path()).len() >= before);
    let all = records(dir.path());
    assert_eq!(all.last().unwrap().seq, 10);
    assert_eq!(check_files(&files(dir.path())).unwrap().records, 11);
}

#[tokio::test]
async fn an_edited_line_is_found_with_its_file_line_and_seq() {
    let (dir, _) = log_of(12, small(2_000)).await;
    let second = files(dir.path())[1].clone();
    let text = fs::read_to_string(&second).unwrap();
    fs::write(
        &second,
        text.replacen("\"risk\":\"Write\"", "\"risk\":\"Read\"", 1),
    )
    .unwrap();
    let b = broken(dir.path());
    assert_eq!(b.kind, BreakKind::Edited);
    assert_eq!(b.file, second);
    assert_eq!(b.line, 1);
    let first_of_second = segments_first_seq_unchecked(&second);
    assert_eq!(b.seq, Some(first_of_second));
    // The server would refuse to open it.
    let clock = TestClock::at(T0);
    let Err(err) = SegmentedSink::open(dir.path(), options(&clock, small(2_000))) else {
        panic!("a tampered log must not open");
    };
    assert!(err.to_string().contains("edited"), "{err}");
    assert!(
        err.to_string()
            .contains(second.file_name().unwrap().to_str().unwrap()),
        "{err}"
    );
}

fn segments_first_seq_unchecked(path: &Path) -> u64 {
    let text = fs::read_to_string(path).unwrap();
    let first: AuditRecord = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    first.seq
}

#[tokio::test]
async fn a_deleted_line_is_a_gap_in_seq_inside_a_file() {
    let (dir, _) = log_of(12, small(2_000)).await;
    let file = files(dir.path())[1].clone();
    let text = fs::read_to_string(&file).unwrap();
    assert!(text.lines().count() >= 3, "the test needs a middle line");
    let kept: Vec<&str> = text
        .lines()
        .enumerate()
        .filter(|(i, _)| *i != 1)
        .map(|(_, l)| l)
        .collect();
    fs::write(&file, kept.join("\n") + "\n").unwrap();
    let b = broken(dir.path());
    assert_eq!(b.kind, BreakKind::Deleted);
    assert_eq!(b.file, file);
    assert_eq!(b.line, 2);
    assert!(b.message.contains("1 record(s) deleted"), "{b}");
}

#[tokio::test]
async fn a_missing_segment_is_a_gap_across_a_file_boundary() {
    let (dir, _) = log_of(20, small(2_000)).await;
    let all = files(dir.path());
    assert!(all.len() >= 4);
    fs::remove_file(&all[1]).unwrap();
    let b = broken(dir.path());
    assert_eq!(b.kind, BreakKind::Gap);
    assert_eq!(b.file, all[2]);
    assert_eq!(b.line, 1);
}

#[tokio::test]
async fn reordered_lines_and_unparsable_lines_are_named() {
    let (dir, _) = log_of(6, SegmentPolicy::default()).await;
    let file = files(dir.path())[0].clone();
    let text = fs::read_to_string(&file).unwrap();
    let lines: Vec<&str> = text.lines().collect();
    let mut swapped = lines.clone();
    swapped.swap(2, 3);
    fs::write(&file, swapped.join("\n") + "\n").unwrap();
    let b = broken(dir.path());
    assert_eq!((b.kind, b.line), (BreakKind::Deleted, 3), "{b}");
    // Seq going back (a copied line) is a reorder.
    let mut repeated = lines.clone();
    repeated[3] = lines[1];
    fs::write(&file, repeated.join("\n") + "\n").unwrap();
    assert_eq!(broken(dir.path()).kind, BreakKind::Reordered);
    // Not a record.
    let mut junk = lines.clone();
    junk[4] = "{\"seq\":";
    fs::write(&file, junk.join("\n") + "\n").unwrap();
    let b = broken(dir.path());
    assert_eq!((b.kind, b.line, b.seq), (BreakKind::Unparsable, 5, None));
}

#[tokio::test]
async fn a_cut_tail_is_not_seen_without_the_checkpoint_and_a_cut_head_is() {
    let (dir, _) = log_of(20, small(2_000)).await;
    let all = files(dir.path());
    // The newest records removed: the rest is a valid chain. Only an anchor outside the log (the
    // checkpoint, DOC-25 §3.5.4) can show it; check_files does not claim to.
    let last = all.last().unwrap();
    let text = fs::read_to_string(last).unwrap();
    let kept: Vec<&str> = text.lines().take(text.lines().count() - 1).collect();
    fs::write(last, kept.join("\n") + "\n").unwrap();
    let checked = check_files(&all).unwrap();
    assert!(checked.head.unwrap().0 < 19);
    // The oldest segment removed with nothing to account for it: the head was cut.
    fs::remove_file(&all[0]).unwrap();
    let b = broken(dir.path());
    assert_eq!(b.kind, BreakKind::HeadCut);
    assert_eq!(b.file, all[1]);
}

#[tokio::test]
async fn retention_deletes_old_segments_after_recording_them_and_the_rest_still_verifies() {
    let policy = SegmentPolicy {
        segment_bytes: 2_000,
        retention_days: 30,
        min_retention_days: 7,
        max_bytes: 10 * 1024 * 1024,
    };
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, policy)).unwrap();
    for i in 0..12 {
        sink.append(entry(i, T0 + i * 60_000)).await.unwrap();
    }
    let before = records(dir.path());
    let segments_before = names(dir.path()).len();
    assert!(segments_before >= 3);
    // Forty days later: every closed segment is older than the retention.
    clock.set(T0 + 40 * DAY);
    sink.enforce_retention().unwrap();
    let after = records(dir.path());
    assert!(names(dir.path()).len() < segments_before);
    let retention = after
        .iter()
        .find(|r| r.entry.action.name == "audit.retention")
        .expect("an audit.retention entry");
    let detail = serde_json::to_value(&retention.entry.detail).unwrap();
    let first_kept = after[0].seq;
    assert_eq!(detail["first_seq"], "0");
    assert_eq!(detail["last_seq"], (first_kept - 1).to_string());
    assert_eq!(
        detail["last_hash"],
        before[(first_kept - 1) as usize].hash.to_string()
    );
    // The active segment is never deleted, and the remaining log verifies from the anchor.
    let checked = check_files(&files(dir.path())).unwrap();
    assert_eq!(checked.retentions, 1);
    assert_eq!(checked.first_seq, Some(first_kept));
    // It survives a restart and keeps writing.
    drop(sink);
    let sink = SegmentedSink::open(dir.path(), options(&clock, policy)).unwrap();
    sink.append(entry(99, T0 + 40 * DAY)).await.unwrap();
    assert!(check_files(&files(dir.path())).is_ok());
}

#[tokio::test]
async fn a_segment_cut_after_a_retention_is_not_accounted_for_by_it() {
    let policy = SegmentPolicy {
        segment_bytes: 2_000,
        retention_days: 30,
        min_retention_days: 7,
        max_bytes: 10 * 1024 * 1024,
    };
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, policy)).unwrap();
    for i in 0..12 {
        sink.append(entry(i, T0 + i * 60_000)).await.unwrap();
    }
    clock.set(T0 + 40 * DAY);
    sink.enforce_retention().unwrap();
    for i in 12..24 {
        sink.append(entry(i, T0 + 40 * DAY + i * 60_000))
            .await
            .unwrap();
    }
    drop(sink);
    assert!(check_files(&files(dir.path())).is_ok());
    // Someone cuts one more segment off the head: the retention entry names an older range
    // than the one now missing, so the head is no longer accounted for.
    let all = files(dir.path());
    assert!(all.len() >= 2, "{all:?}");
    fs::remove_file(&all[0]).unwrap();
    assert_eq!(broken(dir.path()).kind, BreakKind::HeadCut);
}

#[tokio::test]
async fn over_the_size_limit_the_oldest_past_the_minimum_go_and_when_none_may_the_log_is_full() {
    let policy = SegmentPolicy {
        segment_bytes: 2_000,
        retention_days: 400,
        min_retention_days: 30,
        max_bytes: 200_000,
    };
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let warned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let mut opts = options(&clock, policy);
    let sink_warned = Arc::clone(&warned);
    opts.warn = Some(Arc::new(move |m: &str| {
        sink_warned.lock().unwrap().push(m.to_owned())
    }));
    let sink = SegmentedSink::open(dir.path(), opts).unwrap();
    // All within the minimum: nothing may go, so the log fills and then refuses.
    let mut refused_at = None;
    for i in 0..2_000 {
        if let Err(e) = sink.append(entry(i, T0 + i * 1_000)).await {
            assert_eq!(e.0, "audit log full");
            refused_at = Some(i);
            break;
        }
    }
    let refused_at = refused_at.expect("the log fills");
    assert!(refused_at > 20, "{refused_at}");
    let status = sink.status();
    assert!(status.bytes + 16 * 1024 > status.max_bytes);
    assert_eq!(status.refusing.as_deref(), Some("the audit log is full"));
    {
        let warned = warned.lock().unwrap();
        assert!(
            warned
                .iter()
                .any(|m| m.contains("80 %") || m.contains("% of audit.max_bytes")),
            "{warned:?}"
        );
        assert!(warned.iter().any(|m| m.contains("is full")), "{warned:?}");
    }
    // No record was dropped: the log is intact and holds everything that was accepted.
    assert_eq!(check_files(&files(dir.path())).unwrap().records, refused_at);
    // Forty days on, the oldest segments are past the minimum: they go, and writing resumes.
    clock.set(T0 + 40 * DAY);
    sink.append(entry(refused_at, T0 + 40 * DAY)).await.unwrap();
    let checked = check_files(&files(dir.path())).unwrap();
    assert_eq!(checked.retentions, 1);
    assert!(checked.first_seq.unwrap() > 0);
    assert!(sink.status().refusing.is_none());
}

#[tokio::test]
async fn a_broken_log_is_moved_aside_and_a_new_chain_names_it() {
    let (dir, clock) = log_of(12, small(2_000)).await;
    let all = files(dir.path());
    let second = all[1].clone();
    let text = fs::read_to_string(&second).unwrap();
    fs::write(
        &second,
        text.replacen("\"risk\":\"Write\"", "\"risk\":\"Read\"", 1),
    )
    .unwrap();
    let good_before = segments_last_good(dir.path());
    clock.set(T0 + 5 * DAY + 3_723_000);
    let (sink, moved_to) =
        SegmentedSink::open_new_chain(dir.path(), options(&clock, small(2_000))).unwrap();
    assert_eq!(moved_to, "broken-20261130T010203Z");
    let moved = dir.path().join(&moved_to);
    assert_eq!(
        fs::read_dir(&moved).unwrap().count(),
        all.len(),
        "every segment moved"
    );
    sink.append(entry(100, T0 + 5 * DAY + 3_724_000))
        .await
        .unwrap();
    // The new chain starts at seq 0 and verifies; its first entry names the old one.
    let checked = check_files(&files(dir.path())).unwrap();
    assert_eq!(checked.new_chains, 1);
    let first = &records(dir.path())[0];
    assert_eq!(first.seq, 0);
    assert_eq!(first.entry.action.name, "audit.new_chain");
    let detail = serde_json::to_value(&first.entry.detail).unwrap();
    assert_eq!(detail["moved_to"], moved_to);
    assert_eq!(detail["old_last_seq"], good_before.0.to_string());
    assert_eq!(detail["old_last_hash"], good_before.1.to_string());
    // The old log is still there to be examined, and still broken where it was.
    let old = segment_files(&moved).unwrap();
    assert!(matches!(check_files(&old), Err(CheckError::Broken(_))));
}

fn segments_last_good(dir: &Path) -> (u64, Digest) {
    // The last record before the edited line: the end of the first segment.
    let first = &files(dir)[0];
    let text = fs::read_to_string(first).unwrap();
    let last: AuditRecord = serde_json::from_str(text.lines().last().unwrap()).unwrap();
    (last.seq, last.hash)
}

#[tokio::test]
async fn files_are_private_to_the_owner() {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let (dir, _) = log_of(3, SegmentPolicy::default()).await;
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&files(dir.path())[0]), 0o600);
    }
    #[cfg(not(unix))]
    {
        let _ = log_of(1, SegmentPolicy::default()).await;
    }
}

#[tokio::test]
async fn unfinished_admissions_are_listed_across_files() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, small(1_500))).unwrap();
    let mut started = entry(1, T0);
    started.outcome = Outcome::Started;
    started.duration_ms = None;
    sink.append(started).await.unwrap();
    for i in 2..10 {
        sink.append(entry(i, T0 + i * 1_000)).await.unwrap();
    }
    let checked = check_files(&files(dir.path())).unwrap();
    assert_eq!(checked.unfinished, ["c-1"]);
}

fn keys(id: &str, byte: u8) -> Arc<audit_jsonl::checkpoint::CheckpointKeys> {
    use audit_jsonl::checkpoint::{CheckpointKey, CheckpointKeys};
    Arc::new(CheckpointKeys::new(vec![CheckpointKey::new(
        id,
        zeroize::Zeroizing::new([byte; 32]),
    )]))
}

fn keyed(clock: &Arc<TestClock>, id: &str, byte: u8) -> SegmentOptions {
    SegmentOptions {
        checkpoint: keys(id, byte),
        ..options(clock, SegmentPolicy::default())
    }
}

#[tokio::test]
async fn the_checkpoint_follows_the_head_at_most_every_10_s_and_at_a_clean_stop() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1)).unwrap();
    sink.append(entry(0, T0)).await.unwrap();
    let read = || audit_jsonl::checkpoint::read(dir.path()).unwrap().unwrap();
    assert_eq!((read().seq, read().kek_id.as_str()), (0, "k1"));
    // Within 10 s: no new checkpoint.
    clock.set(T0 + 5_000);
    sink.append(entry(1, T0 + 5_000)).await.unwrap();
    assert_eq!(read().seq, 0);
    clock.set(T0 + 10_000);
    sink.append(entry(2, T0 + 10_000)).await.unwrap();
    assert_eq!(read().seq, 2);
    sink.append(entry(3, T0 + 10_001)).await.unwrap();
    sink.checkpoint().unwrap();
    let cp = read();
    assert_eq!(cp.seq, 3);
    assert_eq!(cp.hash, records(dir.path())[3].hash);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(dir.path().join("checkpoint.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    drop(sink);
    // Reopened with the key: intact.
    SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1)).unwrap();
}

#[tokio::test]
async fn a_tail_cut_before_the_checkpoint_refuses_the_log() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1)).unwrap();
    for i in 0..4 {
        sink.append(entry(i, T0)).await.unwrap();
    }
    sink.checkpoint().unwrap();
    drop(sink);
    // Without the key, the cut is not seen (check_files checks the chain only).
    let path = files(dir.path()).pop().unwrap();
    let text = fs::read_to_string(&path).unwrap();
    let kept: Vec<&str> = text.lines().take(2).collect();
    fs::write(&path, format!("{}\n", kept.join("\n"))).unwrap();
    assert!(check_files(&files(dir.path())).is_ok());
    let err = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1))
        .err()
        .unwrap();
    let audit_jsonl::AuditLogError::Broken(b) = err else {
        panic!("{err:?}");
    };
    assert_eq!(b.kind, BreakKind::TruncatedTail);
    assert!(b.message.contains("ends at seq 1"), "{}", b.message);
    assert!(b.to_string().contains("truncated tail"), "{b}");
}

#[tokio::test]
async fn a_forged_checkpoint_refuses_the_log_and_another_key_only_warns() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1)).unwrap();
    sink.append(entry(0, T0)).await.unwrap();
    sink.append(entry(1, T0)).await.unwrap();
    sink.checkpoint().unwrap();
    drop(sink);
    let path = dir.path().join("checkpoint.json");
    let honest = fs::read_to_string(&path).unwrap();
    // Someone without the key moves the checkpoint back to hide a cut.
    fs::write(&path, honest.replace("\"seq\":1", "\"seq\":0")).unwrap();
    let err = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1))
        .err()
        .unwrap();
    assert!(err.to_string().contains("MAC does not verify"), "{err}");
    fs::write(&path, &honest).unwrap();
    // Under a key not given: a warning, and the log opens.
    let warned = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let sink_warned = Arc::clone(&warned);
    let options = SegmentOptions {
        warn: Some(Arc::new(move |m: &str| {
            sink_warned.lock().unwrap().push(m.to_owned())
        })),
        ..keyed(&clock, "k2", 2)
    };
    let sink = SegmentedSink::open(dir.path(), options).unwrap();
    assert!(warned.lock().unwrap()[0].contains("key k1, which is not loaded"));
    // The next checkpoint is under the active key.
    sink.append(entry(2, T0)).await.unwrap();
    sink.checkpoint().unwrap();
    assert_eq!(
        audit_jsonl::checkpoint::read(dir.path())
            .unwrap()
            .unwrap()
            .kek_id,
        "k2"
    );
}

#[tokio::test]
async fn a_rotation_writes_the_checkpoint_and_new_keys_take_over() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let options = SegmentOptions {
        policy: small(2_000),
        ..keyed(&clock, "k1", 1)
    };
    let sink = SegmentedSink::open(dir.path(), options).unwrap();
    for i in 0..12 {
        sink.append(entry(i, T0)).await.unwrap();
    }
    assert!(files(dir.path()).len() > 1);
    let cp = audit_jsonl::checkpoint::read(dir.path()).unwrap().unwrap();
    assert!(cp.seq > 0, "a rotation moved the checkpoint");
    sink.set_checkpoint_keys(keys("k2", 2));
    let cp = audit_jsonl::checkpoint::read(dir.path()).unwrap().unwrap();
    assert_eq!((cp.seq, cp.kek_id.as_str()), (11, "k2"));
}

#[tokio::test]
async fn a_backup_closes_the_active_segment_and_names_every_record() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), keyed(&clock, "k1", 1)).unwrap();
    for i in 0..5 {
        sink.append(entry(i, T0)).await.unwrap();
    }
    let set = sink.close_for_backup().unwrap();
    assert_eq!(set.segments.len(), 1);
    assert_eq!(set.head.unwrap().0, 4);
    let cp: audit_jsonl::checkpoint::Checkpoint =
        serde_json::from_slice(&set.checkpoint.unwrap()).unwrap();
    assert_eq!(cp.seq, 4);
    // The copy verifies on its own, and the log goes on in a new segment.
    let copy = tempfile::tempdir().unwrap();
    for path in &set.segments {
        fs::copy(path, copy.path().join(path.file_name().unwrap())).unwrap();
    }
    assert_eq!(check_files(&files(copy.path())).unwrap().records, 5);
    sink.append(entry(5, T0)).await.unwrap();
    assert_eq!(files(dir.path()).len(), 2);
    // Nothing new: nothing to close, the same segments.
    let again = sink.close_for_backup().unwrap();
    assert_eq!(again.segments.len(), 2);
}

// Reading the log for people: `audit.list`, `audit.get` and `audit.verify` (DOC-25 §3.5.5, §3.5.7).

use audit_jsonl::reader::{self, Cursor, Filter, OutcomeFilter};

fn none(_: &str) -> bool {
    false
}

/// Every record of a log of `n`, a page of `limit` at a time, newest first.
fn all_pages(dir: &Path, filter: &Filter, limit: usize) -> Vec<u64> {
    let mut seqs = Vec::new();
    let mut cursor: Option<Cursor> = None;
    for _ in 0..1000 {
        let page = reader::page(dir, filter, cursor, limit, &none).unwrap();
        assert!(page.records.len() <= limit);
        seqs.extend(page.records.iter().map(|r| r.seq));
        match page.next {
            Some(next) => cursor = Some(next),
            None => return seqs,
        }
    }
    panic!("the pages never ended");
}

#[tokio::test]
async fn pages_run_newest_first_across_segments_and_cover_every_record_once() {
    let (dir, _) = log_of(40, small(2_000)).await;
    assert!(files(dir.path()).len() >= 5);
    for limit in [1, 3, 7, 40, 500] {
        let seqs = all_pages(dir.path(), &Filter::default(), limit);
        assert_eq!(seqs, (0..40).rev().collect::<Vec<u64>>(), "limit {limit}");
    }
}

#[tokio::test]
async fn a_filter_keeps_what_matches_and_a_time_range_skips_segments() {
    let (dir, _) = log_of(40, small(2_000)).await;
    // Entry i is at T0 + i minutes.
    let range = Filter {
        from_ms: Some(T0 + 10 * 60_000),
        to_ms: Some(T0 + 14 * 60_000),
        ..Filter::default()
    };
    assert_eq!(all_pages(dir.path(), &range, 2), vec![14, 13, 12, 11, 10]);
    let by_user = Filter {
        principal: Some("ALICE".into()),
        action_prefix: Some("nats.kv".into()),
        risk: Some(Risk::Write),
        ..Filter::default()
    };
    assert_eq!(all_pages(dir.path(), &by_user, 100).len(), 40);
    let nobody = Filter {
        principal: Some("bob".into()),
        ..Filter::default()
    };
    assert!(all_pages(dir.path(), &nobody, 100).is_empty());
    let refused = Filter {
        outcome: Some(OutcomeFilter::Refused),
        ..Filter::default()
    };
    assert!(all_pages(dir.path(), &refused, 100).is_empty());
    let sensitive = reader::page(
        dir.path(),
        &Filter {
            sensitive_only: true,
            ..Filter::default()
        },
        None,
        10,
        &|a| a == "nats.kv.put",
    )
    .unwrap();
    assert_eq!(sensitive.records.len(), 10);
}

#[tokio::test]
async fn a_record_is_found_by_its_number_and_a_missing_one_is_none() {
    let (dir, _) = log_of(25, small(2_000)).await;
    for seq in [0, 7, 24] {
        assert_eq!(reader::get(dir.path(), seq).unwrap().unwrap().seq, seq);
    }
    assert!(reader::get(dir.path(), 25).unwrap().is_none());
    assert!(
        reader::get(&dir.path().join("nothing"), 0)
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn the_sink_verifies_its_own_log_while_it_is_open_and_names_the_break_in_a_copy() {
    let dir = tempfile::tempdir().unwrap();
    let clock = TestClock::at(T0);
    let sink = SegmentedSink::open(dir.path(), options(&clock, small(2_000))).unwrap();
    for i in 0..30 {
        sink.append(entry(i, T0 + i * 60_000)).await.unwrap();
    }
    let out = sink.verify_log().unwrap();
    assert!(out.broken.is_none(), "{:?}", out.broken);
    assert_eq!(out.records, 30);
    assert!(out.segments >= 4);
    assert_eq!(out.head.map(|(seq, _)| seq), Some(29));
    assert!(out.checkpoint.is_none(), "no key, no checkpoint to check");
    // A line changed in the middle of an older segment is the first break, with its place.
    let all = files(dir.path());
    let victim = &all[1];
    let text = fs::read_to_string(victim)
        .unwrap()
        .replacen("nats.kv.put", "nats.kv.get", 1);
    fs::write(victim, text).unwrap();
    let out = sink.verify_log().unwrap();
    let broken = out.broken.expect("a break");
    assert_eq!(broken.kind, BreakKind::Edited);
    assert_eq!(broken.file, *victim);
}
