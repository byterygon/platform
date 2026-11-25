//! The log in segments (DOC-25 §3.5.4 and §3.5.6): `audit-<n>.jsonl` files in one directory, the
//! chain continuing across them, a retention and size policy, and a new chain after a broken log.
//!
//! - **Segments.** A new file starts at [`SegmentPolicy::segment_bytes`] or at midnight UTC,
//!   whichever comes first. The first record of a file carries the last hash of the previous file
//!   as `prev_hash` and `seq` continues, so the chain verifies across files
//!   ([`check_files`]). A rotation fsyncs the old file and the directory before
//!   the first write to the new one. The newest file is the active one and is never deleted.
//! - **Retention.** Once a day (the owner calls [`SegmentedSink::enforce_retention`]), after every
//!   rotation, and when the log is over [`SegmentPolicy::max_bytes`], the oldest closed segments
//!   older than `retention_days` are deleted; when the log is over its size, those older than
//!   `min_retention_days` too. Before deleting, an `audit.retention` entry names the first and
//!   last `seq` and the last hash of the deleted range, so what remains still verifies from that
//!   anchor. Deleting old segments is the only change ever made to written records.
//! - **Full.** When the log is still over `max_bytes` and nothing more may be deleted, appends
//!   fail with "audit log full" (the caller refuses audited calls: no record is dropped to make
//!   room). A warning goes to the owner's callback at 80 %.
//! - **A broken log** is refused when opened. [`SegmentedSink::open_new_chain`] moves it aside to
//!   `broken-<utc>/` and starts a new chain whose first entry (`audit.new_chain`) names it.
//!
//! Files are mode 0600 and the directory 0700 on Unix.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use security_types::{
    Action, AuditChain, AuditDecision, AuditDetail, AuditEntry, AuditError, AuditPrincipal,
    AuditSink, BoxFuture, Clock, Digest, Outcome, PrincipalKind, Risk, SessionId, TenantId,
    new_correlation_id,
};

use crate::AuditLogError;
use crate::check::{
    CheckError, NEW_CHAIN_ACTION, RETENTION_ACTION, SegmentInfo, check_checkpoint, check_files,
    segment_files, segment_name,
};
use crate::checkpoint::{self, CheckpointKeys, Verdict};

/// The checkpoint is written at most this often while entries are written (DOC-25 §3.5.4).
pub const CHECKPOINT_EVERY_MS: u64 = 10_000;

const DAY_MS: u64 = 86_400_000;

/// Room kept free for the next entry before the size limit counts as reached.
const MARGIN: u64 = 16 * 1024;

/// Segment size, retention and size limit (DOC-25 §3.5.4, §3.5.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentPolicy {
    /// A new segment at this size (default 64 MiB).
    pub segment_bytes: u64,
    /// Closed segments whose newest record is older are deleted (default 400 days).
    pub retention_days: u32,
    /// The least that is kept when the log is over its size (default 30 days).
    pub min_retention_days: u32,
    /// The size of all segments together (default 10 GiB).
    pub max_bytes: u64,
}

impl Default for SegmentPolicy {
    fn default() -> Self {
        SegmentPolicy {
            segment_bytes: 64 * 1024 * 1024,
            retention_days: 400,
            min_retention_days: 30,
            max_bytes: 10 * 1024 * 1024 * 1024,
        }
    }
}

/// Where the sink says things an operator should see: the log at 80 %, a deletion that failed.
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;

/// What [`SegmentedSink::open`] needs besides the directory.
#[derive(Clone)]
pub struct SegmentOptions {
    pub policy: SegmentPolicy,
    /// The tenant of the system entries the sink writes (`audit.retention`, `audit.new_chain`).
    pub tenant: TenantId,
    pub clock: Arc<dyn Clock>,
    pub warn: Option<Warn>,
    /// The keys of the checkpoint ([`crate::checkpoint`]); empty writes none and checks none.
    pub checkpoint: Arc<CheckpointKeys>,
}

/// A snapshot for `audit.status` (DOC-25 §3.5.7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentStatus {
    pub segments: usize,
    pub bytes: u64,
    pub max_bytes: u64,
    /// The time of the oldest record, Unix ms.
    pub oldest_time_ms: Option<u64>,
    pub records: u64,
    /// Why the log refuses writes, when it does.
    pub refusing: Option<String>,
}

struct Active {
    file: File,
    info: SegmentInfo,
    /// The UTC day of the file's first record.
    day: u64,
}

struct State {
    active: Active,
    chain: AuditChain,
    /// Closed segments, oldest first.
    closed: Vec<SegmentInfo>,
    /// Set by a failed write: every later write fails until the log is repaired and reopened.
    failed: Option<String>,
    warned: bool,
    full_reported: bool,
    /// When the checkpoint was last written (Unix ms) and the `seq` it names.
    checkpoint_ms: u64,
    checkpoint_seq: Option<u64>,
}

struct Inner {
    dir: PathBuf,
    policy: SegmentPolicy,
    tenant: TenantId,
    clock: Arc<dyn Clock>,
    warn: Option<Warn>,
    checkpoint: Mutex<Arc<CheckpointKeys>>,
    state: Mutex<State>,
}

/// See the [module docs](self).
#[derive(Clone)]
pub struct SegmentedSink {
    inner: Arc<Inner>,
}

fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn io_err(path: &Path, error: io::Error) -> AuditLogError {
    AuditLogError::Io {
        path: path.to_path_buf(),
        error,
    }
}

fn create_dir(dir: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder.create(dir)
}

fn create_segment(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

fn open_append(path: &Path) -> io::Result<File> {
    OpenOptions::new().append(true).open(path)
}

/// Makes a creation, rename or removal in `dir` durable. Not every platform can open a directory.
fn sync_dir(dir: &Path) {
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

impl SegmentedSink {
    /// Opens the log in `dir`: every segment is read and the chain verified across them (a break
    /// is refused, naming file, line and `seq`), and the newest segment becomes the active one.
    /// An empty or absent directory starts a chain.
    pub fn open(dir: &Path, options: SegmentOptions) -> Result<SegmentedSink, AuditLogError> {
        create_dir(dir).map_err(|e| io_err(dir, e))?;
        let files = segment_files(dir).map_err(|e| io_err(dir, e))?;
        let checked = check_files(&files).map_err(|e| match e {
            CheckError::Io { path, error } => AuditLogError::Io { path, error },
            CheckError::Broken(b) => AuditLogError::Broken(b),
        })?;
        // The checkpoint, when there are keys: a tail cut before it refuses the log.
        let verdict = if options.checkpoint.is_empty() {
            Verdict::Absent
        } else {
            check_checkpoint(dir, &files, &checked, &options.checkpoint).map_err(|e| match e {
                CheckError::Io { path, error } => AuditLogError::Io { path, error },
                CheckError::Broken(b) => AuditLogError::Broken(b),
            })?
        };
        if let (Verdict::NotChecked { kek_id }, Some(warn)) = (&verdict, &options.warn) {
            warn(&format!(
                "the audit checkpoint was made with key {kek_id}, which is not loaded: the end of \
                 the log is not checked this time (the next checkpoint uses the active key)"
            ));
        }
        let (chain, active_path, mut closed) = match (&checked.head_record, files.last()) {
            (Some(last), Some(path)) => (
                AuditChain::resume_after(last).map_err(|error| AuditLogError::Chain {
                    path: path.clone(),
                    error,
                })?,
                path.clone(),
                checked.segments.clone(),
            ),
            (None, Some(path)) => (AuditChain::new(), path.clone(), checked.segments.clone()),
            (_, None) => {
                let path = dir.join(segment_name(0));
                let file = create_segment(&path).map_err(|e| io_err(&path, e))?;
                sync_dir(dir);
                drop(file);
                let info = empty_info(&path);
                (AuditChain::new(), path, vec![info])
            }
        };
        let active_info = closed.pop().expect("at least the active segment");
        let file = open_append(&active_path).map_err(|e| io_err(&active_path, e))?;
        let day = if active_info.records > 0 {
            active_info.first_time_ms / DAY_MS
        } else {
            options.clock.now_unix_ms() / DAY_MS
        };
        let state = State {
            active: Active {
                file,
                info: active_info,
                day,
            },
            chain,
            closed,
            failed: None,
            warned: false,
            full_reported: false,
            checkpoint_ms: 0,
            checkpoint_seq: match verdict {
                Verdict::Intact { seq } => Some(seq),
                _ => None,
            },
        };
        Ok(SegmentedSink {
            inner: Arc::new(Inner {
                dir: dir.to_path_buf(),
                policy: options.policy,
                tenant: options.tenant,
                clock: options.clock,
                warn: options.warn,
                checkpoint: Mutex::new(options.checkpoint),
                state: Mutex::new(state),
            }),
        })
    }

    /// Moves the log in `dir` aside to `broken-<utc>/` (whatever its state) and starts a new
    /// chain whose first entry, `audit.new_chain`, names the old chain's last good record and
    /// where it went. Returns the sink and the name of the directory the old log moved to.
    pub fn open_new_chain(
        dir: &Path,
        options: SegmentOptions,
    ) -> Result<(SegmentedSink, String), AuditLogError> {
        create_dir(dir).map_err(|e| io_err(dir, e))?;
        let files = segment_files(dir).map_err(|e| io_err(dir, e))?;
        let last_good = last_good_record(&files);
        let now = options.clock.now_unix_ms();
        let moved_to = format!("broken-{}", utc_stamp(now));
        let target = dir.join(&moved_to);
        if !files.is_empty() {
            create_dir(&target).map_err(|e| io_err(&target, e))?;
            for file in &files {
                let name = file.file_name().expect("a file name");
                fs::rename(file, target.join(name)).map_err(|e| io_err(file, e))?;
            }
            let checkpoint = dir.join("checkpoint.json");
            if checkpoint.exists() {
                fs::rename(&checkpoint, target.join("checkpoint.json"))
                    .map_err(|e| io_err(&checkpoint, e))?;
            }
            sync_dir(dir);
        }
        let tenant = options.tenant.clone();
        let sink = SegmentedSink::open(dir, options)?;
        let (seq, hash) = match last_good {
            Some((seq, hash)) => (seq.to_string(), hash.to_string()),
            None => ("-".to_owned(), "-".to_owned()),
        };
        let entry = system_entry(
            &tenant,
            NEW_CHAIN_ACTION,
            now,
            vec![
                ("old_last_seq", seq),
                ("old_last_hash", hash),
                ("moved_to", moved_to.clone()),
            ],
        );
        sink.append_blocking(entry).map_err(|e| AuditLogError::Io {
            path: dir.to_path_buf(),
            error: io::Error::other(e.0),
        })?;
        Ok((sink, moved_to))
    }

    pub fn dir(&self) -> &Path {
        &self.inner.dir
    }

    /// Records written so far (the next record's `seq`).
    pub fn len(&self) -> u64 {
        lock(&self.inner.state).chain.next_seq()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn status(&self) -> SegmentStatus {
        let state = lock(&self.inner.state);
        let all = state
            .closed
            .iter()
            .chain(std::iter::once(&state.active.info));
        let (mut bytes, mut records, mut oldest) = (0, 0, None);
        for segment in all {
            bytes += segment.bytes;
            records += segment.records;
            if segment.records > 0 && oldest.is_none() {
                oldest = Some(segment.first_time_ms);
            }
        }
        SegmentStatus {
            segments: state.closed.len() + 1,
            bytes,
            max_bytes: self.inner.policy.max_bytes,
            oldest_time_ms: oldest,
            records,
            refusing: state.failed.clone().or_else(|| {
                state
                    .full_reported
                    .then(|| "the audit log is full".to_owned())
            }),
        }
    }

    /// Replaces the checkpoint's keys (a key rotation) and writes a checkpoint with the new
    /// writing key.
    pub fn set_checkpoint_keys(&self, keys: Arc<CheckpointKeys>) {
        *self
            .inner
            .checkpoint
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = keys;
        let mut state = lock(&self.inner.state);
        state.checkpoint_seq = None;
        self.write_checkpoint(&mut state);
    }

    /// Writes the checkpoint now (a clean stop). A failure is reported through the warning
    /// callback and returned.
    pub fn checkpoint(&self) -> Result<(), AuditError> {
        let mut state = lock(&self.inner.state);
        if self.write_checkpoint(&mut state) {
            Ok(())
        } else {
            Err(AuditError(
                "the audit checkpoint could not be written".into(),
            ))
        }
    }

    /// Writes the checkpoint of the head when it moved; `false` when the write failed.
    fn write_checkpoint(&self, state: &mut State) -> bool {
        let keys = Arc::clone(
            &self
                .inner
                .checkpoint
                .lock()
                .unwrap_or_else(|e| e.into_inner()),
        );
        if keys.is_empty() {
            return true;
        }
        let Some((seq, hash)) = head(state) else {
            return true;
        };
        if state.checkpoint_seq == Some(seq) {
            return true;
        }
        let now = self.inner.clock.now_unix_ms();
        match checkpoint::write(&self.inner.dir, &keys, seq, hash, now) {
            Ok(()) => {
                state.checkpoint_ms = now;
                state.checkpoint_seq = Some(seq);
                true
            }
            Err(e) => {
                self.warn(&format!("the audit checkpoint could not be written: {e}"));
                false
            }
        }
    }

    /// Applies the retention and size policy now. The owner calls it once a day.
    pub fn enforce_retention(&self) -> Result<(), AuditError> {
        let mut state = lock(&self.inner.state);
        let over = total_bytes(&state) + MARGIN > self.inner.policy.max_bytes;
        self.retain(&mut state, over)
    }

    fn warn(&self, message: &str) {
        if let Some(warn) = &self.inner.warn {
            warn(message);
        }
    }

    /// Writes one entry: rotates first when the active segment is full or the day changed, makes
    /// room by retention when over the size limit, refuses when there is none.
    fn append_blocking(&self, entry: AuditEntry) -> Result<(), AuditError> {
        let policy = self.inner.policy;
        let mut state = lock(&self.inner.state);
        if let Some(reason) = &state.failed {
            return Err(AuditError(reason.clone()));
        }
        let day = entry.timestamp_unix_ms / DAY_MS;
        let info = &state.active.info;
        if info.records > 0 && (info.bytes >= policy.segment_bytes || day > state.active.day) {
            self.rotate(&mut state)?;
        }
        if total_bytes(&state) + MARGIN > policy.max_bytes {
            self.retain(&mut state, true)?;
            if total_bytes(&state) + MARGIN > policy.max_bytes {
                if !state.full_reported {
                    state.full_reported = true;
                    self.warn(
                        "the audit log is full and nothing more may be deleted: audited calls are refused until space is made (see audit.max_bytes and audit.min_retention_days)",
                    );
                }
                return Err(AuditError("audit log full".into()));
            }
        }
        state.full_reported = false;
        let total = total_bytes(&state);
        if total.saturating_mul(5) >= policy.max_bytes.saturating_mul(4) {
            if !state.warned {
                state.warned = true;
                self.warn(&format!(
                    "the audit log is at {} % of audit.max_bytes",
                    total.saturating_mul(100) / policy.max_bytes.max(1)
                ));
            }
        } else {
            state.warned = false;
        }
        self.write_record(&mut state, entry)?;
        if self
            .inner
            .clock
            .now_unix_ms()
            .saturating_sub(state.checkpoint_ms)
            >= CHECKPOINT_EVERY_MS
        {
            self.write_checkpoint(&mut state);
        }
        Ok(())
    }

    /// Writes the record, fsyncs, updates the active segment. A failure ends all later writes.
    fn write_record(&self, state: &mut State, entry: AuditEntry) -> Result<(), AuditError> {
        let timestamp = entry.timestamp_unix_ms;
        let record = state.chain.append(entry);
        let mut line = serde_json::to_vec(&record)
            .map_err(|_| AuditError("record did not serialize".into()))?;
        line.push(b'\n');
        let written = state
            .active
            .file
            .write_all(&line)
            .and_then(|()| state.active.file.sync_data());
        if let Err(e) = written {
            let reason = format!("write failed: {}", e.kind());
            state.failed = Some(reason.clone());
            return Err(AuditError(reason));
        }
        let info = &mut state.active.info;
        if info.records == 0 {
            info.first_seq = Some(record.seq);
            info.first_time_ms = timestamp;
            state.active.day = timestamp / DAY_MS;
        }
        let info = &mut state.active.info;
        info.records += 1;
        info.bytes += line.len() as u64;
        info.last_seq = Some(record.seq);
        info.last_hash = Some(record.hash);
        info.last_time_ms = timestamp;
        Ok(())
    }

    /// Closes the active segment and starts the next, durably.
    fn rotate(&self, state: &mut State) -> Result<(), AuditError> {
        let path = self.inner.dir.join(segment_name(state.chain.next_seq()));
        let fail = |state: &mut State, what: &str, e: io::Error| {
            let reason = format!("{what}: {}", e.kind());
            state.failed = Some(reason.clone());
            AuditError(reason)
        };
        if let Err(e) = state.active.file.sync_all() {
            return Err(fail(state, "closing a segment failed", e));
        }
        self.write_checkpoint(state);
        let file = match create_segment(&path) {
            Ok(file) => file,
            Err(e) => return Err(fail(state, "starting a segment failed", e)),
        };
        sync_dir(&self.inner.dir);
        let closed = std::mem::replace(
            &mut state.active,
            Active {
                file,
                info: empty_info(&path),
                day: self.inner.clock.now_unix_ms() / DAY_MS,
            },
        );
        state.closed.push(closed.info);
        // A failed deletion is reported, never a reason to refuse the write that rotated.
        if let Err(e) = self.retain(state, false) {
            self.warn(&format!("audit retention: {}", e.0));
        }
        Ok(())
    }

    /// Deletes the oldest closed segments the policy allows, after recording what is deleted.
    fn retain(&self, state: &mut State, over_max: bool) -> Result<(), AuditError> {
        let policy = self.inner.policy;
        let now = self.inner.clock.now_unix_ms();
        let age_cut = now.saturating_sub(u64::from(policy.retention_days) * DAY_MS);
        let min_cut = now.saturating_sub(u64::from(policy.min_retention_days) * DAY_MS);
        let total = total_bytes(state);
        let mut take = 0usize;
        let mut freed = 0u64;
        for segment in &state.closed {
            let old = segment.last_time_ms < age_cut;
            let still_over = over_max
                && total.saturating_sub(freed) + MARGIN > policy.max_bytes
                && segment.last_time_ms < min_cut;
            if segment.records == 0 || old || still_over {
                take += 1;
                freed += segment.bytes;
            } else {
                break;
            }
        }
        if take == 0 {
            return Ok(());
        }
        let doomed: Vec<SegmentInfo> = state.closed[..take].to_vec();
        let with_records: Vec<&SegmentInfo> = doomed.iter().filter(|s| s.records > 0).collect();
        if let (Some(first), Some(last)) = (with_records.first(), with_records.last()) {
            let entry = system_entry(
                &self.inner.tenant,
                RETENTION_ACTION,
                now,
                vec![
                    ("first_seq", first.first_seq.unwrap_or(0).to_string()),
                    ("last_seq", last.last_seq.unwrap_or(0).to_string()),
                    (
                        "last_hash",
                        last.last_hash.unwrap_or(Digest::ZERO).to_string(),
                    ),
                ],
            );
            // Recorded before anything is deleted: a crash in between leaves the files and an
            // entry about them, which verifies.
            self.write_record(state, entry)?;
        }
        let mut deleted = 0usize;
        for segment in &doomed {
            match fs::remove_file(&segment.path) {
                Ok(()) => deleted += 1,
                Err(e) if e.kind() == io::ErrorKind::NotFound => deleted += 1,
                Err(e) => {
                    self.warn(&format!(
                        "audit retention: cannot delete {}: {}",
                        segment.path.display(),
                        e.kind()
                    ));
                    break;
                }
            }
        }
        state.closed.drain(..deleted);
        sync_dir(&self.inner.dir);
        Ok(())
    }
}

fn empty_info(path: &Path) -> SegmentInfo {
    SegmentInfo {
        path: path.to_path_buf(),
        records: 0,
        first_seq: None,
        last_seq: None,
        last_hash: None,
        first_time_ms: 0,
        last_time_ms: 0,
        bytes: 0,
    }
}

/// The chain's last record, `seq` and hash.
fn head(state: &State) -> Option<(u64, Digest)> {
    std::iter::once(&state.active.info)
        .chain(state.closed.iter().rev())
        .find_map(|s| s.last_seq.zip(s.last_hash))
}

fn total_bytes(state: &State) -> u64 {
    state.closed.iter().map(|s| s.bytes).sum::<u64>() + state.active.info.bytes
}

impl AuditSink for SegmentedSink {
    fn append(&self, entry: AuditEntry) -> BoxFuture<'_, Result<(), AuditError>> {
        let sink = self.clone();
        Box::pin(async move {
            // The write and its fsync block; they run off the runtime, serialized by the lock so
            // the chain order is the file order.
            tokio::task::spawn_blocking(move || sink.append_blocking(entry))
                .await
                .unwrap_or_else(|_| Err(AuditError("audit writer panicked".into())))
        })
    }
}

/// An entry by the server itself (`system:server`).
pub fn system_entry(
    tenant: &TenantId,
    name: &str,
    now_ms: u64,
    fields: Vec<(&str, String)>,
) -> AuditEntry {
    AuditEntry {
        timestamp_unix_ms: now_ms,
        principal_chain: vec![AuditPrincipal {
            kind: PrincipalKind::System,
            id: "system:server".into(),
            tenant: tenant.clone(),
            session: SessionId::new("-"),
        }],
        tenant: tenant.clone(),
        action: Action::new(name, name),
        target: None,
        risk: Risk::Read,
        decision: AuditDecision::Allow,
        approval_id: None,
        outcome: Outcome::Success,
        duration_ms: None,
        correlation_id: new_correlation_id().unwrap_or_else(|_| "no-randomness".into()),
        input_digest: Digest::ZERO,
        statement_digest: None,
        delivery: None,
        parent_correlation_id: None,
        detail: AuditDetail::new(fields).ok(),
    }
}

/// The last record of the chain that still verifies, reading as far as the files are sound.
fn last_good_record(files: &[PathBuf]) -> Option<(u64, Digest)> {
    use std::io::BufRead as _;
    let mut last: Option<(u64, Digest)> = None;
    for path in files {
        let Ok(file) = File::open(path) else {
            return last;
        };
        for line in io::BufReader::new(file).lines() {
            let Ok(line) = line else { return last };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<security_types::AuditRecord>(&line) else {
                return last;
            };
            let linked = match last {
                None => true,
                Some((seq, hash)) => record.seq == seq + 1 && record.prev_hash == hash,
            };
            if !linked || record.compute_hash() != record.hash {
                return last;
            }
            last = Some((record.seq, record.hash));
        }
    }
    last
}

/// `20261124T141500Z` for a Unix time in ms.
pub fn utc_stamp(unix_ms: u64) -> String {
    let secs = unix_ms / 1000;
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Howard Hinnant's civil-from-days.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}{month:02}{day:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
