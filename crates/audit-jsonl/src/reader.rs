//! Reading the log for people (DOC-25 §3.5.7, `audit.list` and `audit.get`): the newest records
//! first, a filter, and a cursor to the next page, without ever loading a whole file.
//!
//! - **Newest first.** A segment is read backwards from its end in 64 KiB blocks, line by line;
//!   the cursor is the segment (named by its first `seq`) and the byte offset the page stopped at,
//!   so the next page goes on from there. A segment deleted by retention in between is skipped.
//! - **Skipping.** A segment whose first and last record fall outside the filter's time range is
//!   not read beyond those two lines.
//! - **A budget.** A page stops after reading [`SCAN_BUDGET`] bytes even when it is not full, and
//!   hands back a cursor, so a filter that matches nothing for a long stretch still answers.
//! - **No verification.** Records are read as written; `verify` is what checks the chain. A line
//!   that does not parse (a write in progress at the end of the newest file) is skipped.

use std::fs::File;
use std::io::{self, Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use security_types::{AuditDecision, AuditRecord, Outcome, Risk};

use crate::check::{segment_files, segment_first_seq};

/// The most bytes one page reads before it stops and hands back a cursor.
pub const SCAN_BUDGET: u64 = 64 * 1024 * 1024;

const BLOCK: u64 = 64 * 1024;

/// What a record's outcome means to a person (the audit screen's filter).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeFilter {
    /// Not refused and not failed.
    Allowed,
    /// The decision was a refusal.
    Refused,
    /// Allowed, and the call ended in an error.
    Failed,
}

/// Which records a page keeps.
#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub from_ms: Option<u64>,
    pub to_ms: Option<u64>,
    /// Part of a principal id, anywhere in the chain (case-insensitive).
    pub principal: Option<String>,
    /// The start of the action name (`nats.`, `admin.users.setRoles`).
    pub action_prefix: Option<String>,
    pub risk: Option<Risk>,
    pub outcome: Option<OutcomeFilter>,
    /// Only the sensitive reads.
    pub sensitive_only: bool,
    /// Leave out admission entries (`Started`): the completion says how the call ended.
    pub finished_only: bool,
}

impl Filter {
    /// Whether `record` passes; `sensitive` says whether a procedure's reads are sensitive.
    pub fn matches(&self, record: &AuditRecord, sensitive: &dyn Fn(&str) -> bool) -> bool {
        let e = &record.entry;
        if self.from_ms.is_some_and(|from| e.timestamp_unix_ms < from)
            || self.to_ms.is_some_and(|to| e.timestamp_unix_ms > to)
        {
            return false;
        }
        if self.finished_only && e.outcome == Outcome::Started {
            return false;
        }
        if self.risk.is_some_and(|risk| e.risk != risk) {
            return false;
        }
        if let Some(prefix) = &self.action_prefix
            && !e.action.name.starts_with(prefix.as_str())
        {
            return false;
        }
        if let Some(text) = &self.principal {
            let text = text.to_lowercase();
            if !e
                .principal_chain
                .iter()
                .any(|p| p.id.to_lowercase().contains(&text))
            {
                return false;
            }
        }
        if let Some(outcome) = self.outcome {
            let refused = matches!(e.decision, AuditDecision::Deny { .. });
            let failed = !refused && matches!(e.outcome, Outcome::Error { .. });
            let ok = match outcome {
                OutcomeFilter::Refused => refused,
                OutcomeFilter::Failed => failed,
                OutcomeFilter::Allowed => !refused && !failed,
            };
            if !ok {
                return false;
            }
        }
        !(self.sensitive_only && !sensitive(&e.action.name))
    }
}

/// Where the next page goes on: before byte `end` of the segment whose first `seq` is `segment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cursor {
    pub segment: u64,
    pub end: u64,
}

impl Cursor {
    /// `segment.end`, the text the wire carries.
    pub fn encode(self) -> String {
        format!("{}.{}", self.segment, self.end)
    }

    pub fn decode(text: &str) -> Option<Cursor> {
        let (segment, end) = text.split_once('.')?;
        Some(Cursor {
            segment: segment.parse().ok()?,
            end: end.parse().ok()?,
        })
    }
}

/// One page, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Page {
    pub records: Vec<AuditRecord>,
    /// `None` when the log's oldest record has been reached.
    pub next: Option<Cursor>,
}

/// Lines of a file, last first. Yields each line with the byte offset it starts at.
struct Backwards {
    file: File,
    /// The file offset of `buf[0]`.
    pos: u64,
    /// The bytes from `pos` to the end of what has not been yielded.
    buf: Vec<u8>,
    scanned: u64,
}

impl Backwards {
    fn open(path: &Path, end: u64) -> io::Result<Backwards> {
        Ok(Backwards {
            file: File::open(path)?,
            pos: end,
            buf: Vec::new(),
            scanned: 0,
        })
    }

    fn next_line(&mut self) -> io::Result<Option<(u64, Vec<u8>)>> {
        loop {
            // The newline that ends the line is not part of it.
            while self.buf.last() == Some(&b'\n') {
                self.buf.pop();
            }
            if let Some(i) = self.buf.iter().rposition(|b| *b == b'\n') {
                let line = self.buf.split_off(i + 1);
                let start = self.pos + (i as u64) + 1;
                // Keep the newline of the previous line at the end of `buf`; it is dropped above.
                return Ok(Some((start, line)));
            }
            if self.pos == 0 {
                if self.buf.is_empty() {
                    return Ok(None);
                }
                return Ok(Some((0, std::mem::take(&mut self.buf))));
            }
            let take = BLOCK.min(self.pos);
            let at = self.pos - take;
            self.file.seek(SeekFrom::Start(at))?;
            let mut block = vec![0u8; take as usize];
            self.file.read_exact(&mut block)?;
            self.scanned += take;
            block.extend_from_slice(&self.buf);
            self.buf = block;
            self.pos = at;
        }
    }
}

/// The time of the first and last record of a segment, from its first and last line only.
fn time_span(path: &Path, len: u64) -> io::Result<Option<(u64, u64)>> {
    let mut first = None;
    {
        let mut head = vec![0u8; len.min(BLOCK) as usize];
        File::open(path)?.read_exact(&mut head)?;
        if let Some(line) = head.split(|b| *b == b'\n').next()
            && let Ok(record) = serde_json::from_slice::<AuditRecord>(line)
        {
            first = Some(record.entry.timestamp_unix_ms);
        }
    }
    let mut last = None;
    let mut rev = Backwards::open(path, len)?;
    while let Some((_, line)) = rev.next_line()? {
        if let Ok(record) = serde_json::from_slice::<AuditRecord>(&line) {
            last = Some(record.entry.timestamp_unix_ms);
            break;
        }
    }
    Ok(first.zip(last))
}

fn first_seq_of(path: &Path) -> Option<u64> {
    segment_first_seq(&path.file_name()?.to_string_lossy())
}

/// A page of at most `limit` records matching `filter`, newest first, from `cursor` (or the end
/// of the log). `sensitive` says which procedures' reads are sensitive.
pub fn page(
    dir: &Path,
    filter: &Filter,
    cursor: Option<Cursor>,
    limit: usize,
    sensitive: &dyn Fn(&str) -> bool,
) -> io::Result<Page> {
    let files: Vec<PathBuf> = segment_files(dir)?.into_iter().rev().collect();
    let mut out = Page::default();
    let mut scanned = 0u64;
    for (index, path) in files.iter().enumerate() {
        let Some(first) = first_seq_of(path) else {
            continue;
        };
        let len = match std::fs::metadata(path) {
            Ok(m) => m.len(),
            // Deleted by retention since the listing.
            Err(_) => continue,
        };
        // Newer than the cursor: already shown.
        let end = match cursor {
            Some(c) if first > c.segment => continue,
            Some(c) if first == c.segment => c.end.min(len),
            _ => len,
        };
        if end == 0 {
            continue;
        }
        let bounded = filter.from_ms.is_some() || filter.to_ms.is_some();
        if bounded
            && let Ok(Some((first_time, last_time))) = time_span(path, len)
            && (filter.to_ms.is_some_and(|to| to < first_time)
                || filter.from_ms.is_some_and(|from| from > last_time))
        {
            continue;
        }
        let mut rev = Backwards::open(path, end)?;
        while let Some((start, line)) = rev.next_line()? {
            if let Ok(record) = serde_json::from_slice::<AuditRecord>(&line)
                && filter.matches(&record, sensitive)
            {
                out.records.push(record);
            }
            let reached_end = start == 0 && index + 1 == files.len();
            if out.records.len() >= limit || scanned + rev.scanned > SCAN_BUDGET {
                out.next = (!reached_end).then_some(Cursor {
                    segment: first,
                    end: start,
                });
                // A cursor at the start of a segment goes on in the next older one.
                if start == 0 {
                    out.next = files
                        .get(index + 1)
                        .and_then(|p| first_seq_of(p))
                        .map(|older| Cursor {
                            segment: older,
                            end: u64::MAX,
                        });
                }
                return Ok(out);
            }
        }
        scanned += rev.scanned;
    }
    Ok(out)
}

/// The record `seq`, from the segment that holds it; `None` when no segment does.
pub fn get(dir: &Path, seq: u64) -> io::Result<Option<AuditRecord>> {
    let files = segment_files(dir)?;
    let Some(path) = files
        .iter()
        .rev()
        .find(|p| first_seq_of(p).is_some_and(|first| first <= seq))
    else {
        return Ok(None);
    };
    let len = std::fs::metadata(path)?.len();
    let mut rev = Backwards::open(path, len)?;
    while let Some((_, line)) = rev.next_line()? {
        if let Ok(record) = serde_json::from_slice::<AuditRecord>(&line) {
            if record.seq == seq {
                return Ok(Some(record));
            }
            if record.seq < seq {
                return Ok(None);
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cursor_round_trips() {
        let c = Cursor {
            segment: 12,
            end: 3456,
        };
        assert_eq!(Cursor::decode(&c.encode()), Some(c));
        assert_eq!(Cursor::decode("x.1"), None);
        assert_eq!(Cursor::decode("12"), None);
    }
}
