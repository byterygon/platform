//! Verifying a log of several segment files (DOC-25 §3.5.5), and saying where it breaks.
//!
//! [`check_files`] reads the files in the order given, line by line, and checks: every line
//! parses; every record's hash recomputes; `seq` has no gap, repeat or step back; each `prev_hash`
//! is the previous record's hash, across files; and that a log which does not start at `seq` 0
//! (its oldest segments were deleted by retention) starts where an `audit.retention` entry says
//! the deleted range ended, with the same hash; and that every `audit.retention` entry agrees with
//! the records that remain. The first break is reported with its file, line, `seq` and kind.
//!
//! What it cannot see: the loss of the newest records (a truncated tail), which only an anchor
//! outside the log can show (the checkpoint of DOC-25 §3.5.4, which needs the server's key).
//! [`Checked`] says so by carrying no claim about the tail.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, BufRead as _};
use std::path::{Path, PathBuf};

use security_types::{AuditEntry, AuditRecord, Digest, Outcome};

/// The action name of the entry written before old segments are deleted.
pub const RETENTION_ACTION: &str = "audit.retention";
/// The action name of the first entry of a new chain started after a broken log.
pub const NEW_CHAIN_ACTION: &str = "audit.new_chain";

/// What kind of break the first broken record is (DOC-25 §3.5.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BreakKind {
    /// The line is not an audit record.
    Unparsable,
    /// The record's hash does not recompute, or its link to the previous record is wrong: the
    /// record (or the one before it) was changed.
    Edited,
    /// `seq` jumps forward inside a file: a record was deleted.
    Deleted,
    /// `seq` repeats or steps back: records were reordered or copied.
    Reordered,
    /// `seq` jumps forward at the start of a file: a whole segment is missing.
    Gap,
    /// The log starts after `seq` 0 and no `audit.retention` entry accounts for what came before:
    /// the head was cut.
    HeadCut,
}

impl BreakKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BreakKind::Unparsable => "unparsable",
            BreakKind::Edited => "edited",
            BreakKind::Deleted => "deleted",
            BreakKind::Reordered => "reordered",
            BreakKind::Gap => "gap",
            BreakKind::HeadCut => "head cut",
        }
    }
}

/// The first place a chain breaks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Break {
    pub file: PathBuf,
    /// 1-based.
    pub line: usize,
    pub seq: Option<u64>,
    pub kind: BreakKind,
    pub message: String,
}

impl std::fmt::Display for Break {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: line {}", self.file.display(), self.line)?;
        if let Some(seq) = self.seq {
            write!(f, ", seq {seq}")?;
        }
        write!(f, ": {}: {}", self.kind.as_str(), self.message)
    }
}

/// Why a check could not finish.
#[derive(Debug)]
pub enum CheckError {
    Io { path: PathBuf, error: io::Error },
    Broken(Box<Break>),
}

impl std::fmt::Display for CheckError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CheckError::Io { path, error } => write!(f, "{}: {error}", path.display()),
            CheckError::Broken(b) => b.fmt(f),
        }
    }
}

impl std::error::Error for CheckError {}

/// One segment file as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentInfo {
    pub path: PathBuf,
    pub records: u64,
    /// `None` for a file with no record.
    pub first_seq: Option<u64>,
    pub last_seq: Option<u64>,
    pub last_hash: Option<Digest>,
    /// The timestamps of the first and last record, Unix ms.
    pub first_time_ms: u64,
    pub last_time_ms: u64,
    pub bytes: u64,
}

/// An intact chain.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub segments: Vec<SegmentInfo>,
    pub records: u64,
    pub first_seq: Option<u64>,
    /// The head of the chain: the last record's `seq` and hash.
    pub head: Option<(u64, Digest)>,
    /// The last record itself, to resume the chain after it.
    pub head_record: Option<AuditRecord>,
    /// Correlation ids of admissions (`Started`) without a completion: outcome unknown.
    pub unfinished: Vec<String>,
    /// `audit.retention` entries seen, and `audit.new_chain` entries.
    pub retentions: usize,
    pub new_chains: usize,
}

/// A record's detail value, if the entry has it.
fn detail(entry: &AuditEntry, key: &str) -> Option<String> {
    let value = serde_json::to_value(&entry.detail).ok()?;
    value.get(key)?.as_str().map(str::to_owned)
}

/// What an `audit.retention` entry says: the range deleted and its last hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Retention {
    first_seq: u64,
    last_seq: u64,
    last_hash: Digest,
}

fn retention_of(entry: &AuditEntry) -> Option<Retention> {
    if entry.action.name != RETENTION_ACTION {
        return None;
    }
    Some(Retention {
        first_seq: detail(entry, "first_seq")?.parse().ok()?,
        last_seq: detail(entry, "last_seq")?.parse().ok()?,
        last_hash: detail(entry, "last_hash")?.parse().ok()?,
    })
}

/// Reads `files` in the order given and verifies the chain across them.
pub fn check_files(files: &[PathBuf]) -> Result<Checked, CheckError> {
    let broken = |file: &Path, line: usize, seq: Option<u64>, kind, message: String| {
        CheckError::Broken(Box::new(Break {
            file: file.to_path_buf(),
            line,
            seq,
            kind,
            message,
        }))
    };
    let mut segments = Vec::new();
    let mut records = 0u64;
    let mut first: Option<(u64, Digest, PathBuf, usize)> = None;
    let mut head: Option<(u64, Digest)> = None;
    let mut head_record: Option<AuditRecord> = None;
    let mut retentions: Vec<Retention> = Vec::new();
    let mut new_chains = 0usize;
    // Admissions awaiting their completion, in order of appearance.
    let mut started: HashMap<String, usize> = HashMap::new();
    let mut order = 0usize;

    for path in files {
        let file = File::open(path).map_err(|error| CheckError::Io {
            path: path.clone(),
            error,
        })?;
        let bytes = file
            .metadata()
            .map_err(|error| CheckError::Io {
                path: path.clone(),
                error,
            })?
            .len();
        let mut info = SegmentInfo {
            path: path.clone(),
            records: 0,
            first_seq: None,
            last_seq: None,
            last_hash: None,
            first_time_ms: 0,
            last_time_ms: 0,
            bytes,
        };
        for (i, line) in io::BufReader::new(file).lines().enumerate() {
            let line_no = i + 1;
            let line = line.map_err(|error| CheckError::Io {
                path: path.clone(),
                error,
            })?;
            if line.trim().is_empty() {
                continue;
            }
            let record: AuditRecord = serde_json::from_str(&line).map_err(|_| {
                broken(
                    path,
                    line_no,
                    None,
                    BreakKind::Unparsable,
                    "the line is not an audit record".into(),
                )
            })?;
            if record.compute_hash() != record.hash {
                return Err(broken(
                    path,
                    line_no,
                    Some(record.seq),
                    BreakKind::Edited,
                    "the record's hash does not match its content".into(),
                ));
            }
            match head {
                None => {
                    if record.seq == 0 {
                        if record.prev_hash != Digest::ZERO {
                            return Err(broken(
                                path,
                                line_no,
                                Some(0),
                                BreakKind::Edited,
                                "the first record does not start from the zero hash".into(),
                            ));
                        }
                    } else {
                        // The head was deleted: retention entries later in the log must account
                        // for it (checked at the end).
                        first = Some((record.seq, record.prev_hash, path.clone(), line_no));
                    }
                }
                Some((last_seq, last_hash)) => {
                    let expected = last_seq + 1;
                    if record.seq != expected {
                        let (kind, message) = if record.seq > expected {
                            if info.records == 0 {
                                (
                                    BreakKind::Gap,
                                    format!(
                                        "seq jumps from {last_seq} to {} at the start of a file: a segment is missing",
                                        record.seq
                                    ),
                                )
                            } else {
                                (
                                    BreakKind::Deleted,
                                    format!(
                                        "seq jumps from {last_seq} to {}: {} record(s) deleted",
                                        record.seq,
                                        record.seq - expected
                                    ),
                                )
                            }
                        } else {
                            (
                                BreakKind::Reordered,
                                format!("seq {} follows {last_seq}", record.seq),
                            )
                        };
                        return Err(broken(path, line_no, Some(record.seq), kind, message));
                    }
                    if record.prev_hash != last_hash {
                        return Err(broken(
                            path,
                            line_no,
                            Some(record.seq),
                            BreakKind::Edited,
                            "the record does not link to the previous record's hash".into(),
                        ));
                    }
                }
            }
            if info.first_seq.is_none() {
                info.first_seq = Some(record.seq);
                info.first_time_ms = record.entry.timestamp_unix_ms;
            }
            info.records += 1;
            info.last_seq = Some(record.seq);
            info.last_hash = Some(record.hash);
            info.last_time_ms = record.entry.timestamp_unix_ms;
            head = Some((record.seq, record.hash));
            records += 1;
            if let Some(retention) = retention_of(&record.entry) {
                retentions.push(retention);
            }
            if record.entry.action.name == NEW_CHAIN_ACTION {
                new_chains += 1;
            }
            let id = &record.entry.correlation_id;
            if record.entry.is_completion() {
                started.remove(id);
            } else if record.entry.outcome == Outcome::Started {
                started.entry(id.clone()).or_insert_with(|| {
                    order += 1;
                    order
                });
            }
            head_record = Some(record);
        }
        segments.push(info);
    }

    let first_seq = segments.iter().find_map(|s| s.first_seq);
    if let Some((seq, prev_hash, file, line)) = first {
        let accounted = retentions
            .iter()
            .any(|r| r.last_seq + 1 == seq && r.last_hash == prev_hash);
        if !accounted {
            return Err(broken(
                &file,
                line,
                Some(seq),
                BreakKind::HeadCut,
                format!(
                    "the log starts at seq {seq} and no audit.retention entry names the hash of what came before"
                ),
            ));
        }
    }
    // A retention entry about records that still exist must name their real hash.
    if let Some(first_seq) = first_seq {
        let still_here: Vec<&Retention> = retentions
            .iter()
            .filter(|r| r.last_seq >= first_seq)
            .collect();
        if !still_here.is_empty() {
            let wanted: HashMap<u64, &Retention> =
                still_here.iter().map(|r| (r.last_seq, *r)).collect();
            if let Some(found) = find_hashes(files, &wanted)? {
                return Err(found);
            }
        }
    }
    let mut unfinished: Vec<(usize, String)> =
        started.into_iter().map(|(id, at)| (at, id)).collect();
    unfinished.sort();
    Ok(Checked {
        segments,
        records,
        first_seq,
        head,
        head_record,
        unfinished: unfinished.into_iter().map(|(_, id)| id).collect(),
        retentions: retentions.len(),
        new_chains,
    })
}

/// A second pass for the (rare) retention entries whose range is still on disk, as after a crash
/// between writing the entry and deleting the files: the record at `last_seq` must have the hash
/// the entry names.
fn find_hashes(
    files: &[PathBuf],
    wanted: &HashMap<u64, &Retention>,
) -> Result<Option<CheckError>, CheckError> {
    for path in files {
        let file = File::open(path).map_err(|error| CheckError::Io {
            path: path.clone(),
            error,
        })?;
        for (i, line) in io::BufReader::new(file).lines().enumerate() {
            let line = line.map_err(|error| CheckError::Io {
                path: path.clone(),
                error,
            })?;
            let Ok(record) = serde_json::from_str::<AuditRecord>(&line) else {
                continue;
            };
            if let Some(retention) = wanted.get(&record.seq)
                && retention.last_hash != record.hash
            {
                return Ok(Some(CheckError::Broken(Box::new(Break {
                    file: path.clone(),
                    line: i + 1,
                    seq: Some(record.seq),
                    kind: BreakKind::Edited,
                    message: format!(
                        "an audit.retention entry names a different hash for seq {} (range {}..={})",
                        retention.last_seq, retention.first_seq, retention.last_seq
                    ),
                }))));
            }
        }
    }
    Ok(None)
}

/// The segment files of `dir` (`audit-<seq>.jsonl`), oldest first. A missing directory has none.
pub fn segment_files(dir: &Path) -> io::Result<Vec<PathBuf>> {
    let mut files = Vec::new();
    let read = match std::fs::read_dir(dir) {
        Ok(read) => read,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(files),
        Err(e) => return Err(e),
    };
    for entry in read {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if segment_first_seq(&name).is_some() && entry.file_type()?.is_file() {
            files.push(entry.path());
        }
    }
    // The first seq is zero-padded to 12 digits, so the names sort in chain order.
    files.sort();
    Ok(files)
}

/// The file name of the segment that starts at `first_seq`.
pub fn segment_name(first_seq: u64) -> String {
    format!("audit-{:012}.jsonl", first_seq + 1)
}

/// The first `seq` of a segment from its file name, or `None` for a file that is not one. Names
/// count from 1 (`audit-000000000001.jsonl` holds `seq` 0 onward), as DOC-25 §3.5.4 writes them.
pub fn segment_first_seq(name: &str) -> Option<u64> {
    let digits = name.strip_prefix("audit-")?.strip_suffix(".jsonl")?;
    if digits.len() != 12 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok()?.checked_sub(1)
}
