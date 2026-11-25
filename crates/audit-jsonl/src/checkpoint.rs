//! The checkpoint (DOC-25 §3.5.4, Ambidex Open question 13): `checkpoint.json` beside the
//! segments names the chain's head (`seq`, `hash`) at a time, with an HMAC-SHA-256 under a key
//! the owner holds and the log's writer does not. A log whose head is older than its checkpoint
//! has lost its tail; someone who can write the log but does not hold the key cannot forge a
//! newer checkpoint. (A rollback of log and checkpoint together is not detected: an outside copy
//! covers that.)
//!
//! The file is `{ "seq", "hash", "time", "kekId", "mac" }`. `kekId` names the key the MAC was made
//! with, so the owner can keep several (a key rotation). The MAC is over the length-prefixed
//! (u32, big-endian) bytes of `"mightyconsole.audit.checkpoint.v1"`, then `seq` and `time` (u64,
//! big-endian), the 32 bytes of `hash`, and `kekId`. It is written to a temporary file, fsynced,
//! renamed over the old one and the directory fsynced.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write as _};
use std::path::Path;

use hmac::Mac as _;
use security_types::Digest;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

/// The file's name in the log's directory.
pub const CHECKPOINT_FILE: &str = "checkpoint.json";

const LABEL: &[u8] = b"mightyconsole.audit.checkpoint.v1";

type HmacSha256 = hmac::Hmac<sha2::Sha256>;

/// One key the checkpoint can be made or checked with: 32 bytes and the id written beside the
/// MAC.
pub struct CheckpointKey {
    id: String,
    key: Zeroizing<[u8; 32]>,
}

impl CheckpointKey {
    pub fn new(id: impl Into<String>, key: Zeroizing<[u8; 32]>) -> CheckpointKey {
        CheckpointKey { id: id.into(), key }
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

/// The keys of a log: the first writes the checkpoint, any of them checks it.
#[derive(Default)]
pub struct CheckpointKeys {
    keys: Vec<CheckpointKey>,
}

impl CheckpointKeys {
    pub fn new(keys: Vec<CheckpointKey>) -> CheckpointKeys {
        CheckpointKeys { keys }
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    fn writer(&self) -> Option<&CheckpointKey> {
        self.keys.first()
    }

    fn get(&self, id: &str) -> Option<&CheckpointKey> {
        self.keys.iter().find(|k| k.id == id)
    }
}

impl std::fmt::Debug for CheckpointKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_list()
            .entries(self.keys.iter().map(|k| &k.id))
            .finish()
    }
}

/// The file's content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub seq: u64,
    pub hash: Digest,
    /// Unix ms.
    pub time: u64,
    pub kek_id: String,
    /// Hex.
    pub mac: String,
}

fn push(out: &mut Vec<u8>, part: &[u8]) {
    let len = u32::try_from(part.len()).expect("small parts");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(part);
}

fn mac_input(seq: u64, hash: &Digest, time: u64, kek_id: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    push(&mut out, LABEL);
    out.extend_from_slice(&seq.to_be_bytes());
    out.extend_from_slice(&time.to_be_bytes());
    out.extend_from_slice(hash.as_bytes());
    push(&mut out, kek_id.as_bytes());
    out
}

fn hmac(key: &CheckpointKey) -> HmacSha256 {
    <HmacSha256 as hmac::KeyInit>::new_from_slice(&*key.key).expect("HMAC takes any key length")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

impl Checkpoint {
    /// A checkpoint of the head `(seq, hash)` at `time`, under `key`.
    pub fn make(key: &CheckpointKey, seq: u64, hash: Digest, time: u64) -> Checkpoint {
        let mut mac = hmac(key);
        mac.update(&mac_input(seq, &hash, time, &key.id));
        Checkpoint {
            seq,
            hash,
            time,
            kek_id: key.id.clone(),
            mac: hex(&mac.finalize().into_bytes()),
        }
    }

    /// Whether the MAC is right under `key` (compared in constant time).
    fn verifies(&self, key: &CheckpointKey) -> bool {
        let Some(tag) = unhex(&self.mac) else {
            return false;
        };
        let mut mac = hmac(key);
        mac.update(&mac_input(self.seq, &self.hash, self.time, &self.kek_id));
        mac.verify_slice(&tag).is_ok()
    }
}

/// What checking a log against its checkpoint found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// There is no checkpoint (a log that never had a key).
    Absent,
    /// The checkpoint's key is not among those given: not checked.
    NotChecked { kek_id: String },
    /// The log reaches the checkpoint: its head is at or after it, with the same hash there.
    Intact { seq: u64 },
    /// The MAC does not verify: the file was changed or forged.
    Forged,
    /// The log ends before the checkpoint: its tail was cut.
    TruncatedTail {
        checkpoint_seq: u64,
        head_seq: Option<u64>,
    },
    /// The record at the checkpoint's `seq` has another hash.
    Rewritten { seq: u64 },
}

/// Reads `dir`'s checkpoint, `None` when there is none.
pub fn read(dir: &Path) -> io::Result<Option<Checkpoint>> {
    let path = dir.join(CHECKPOINT_FILE);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    serde_json::from_str(&text).map(Some).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{}: {e}", path.display()),
        )
    })
}

/// Checks a checkpoint against the log's head and the hash of the record at the checkpoint's
/// `seq` (`hash_at_seq`, when the log has it).
pub fn verify(
    checkpoint: &Checkpoint,
    keys: &CheckpointKeys,
    head_seq: Option<u64>,
    hash_at_seq: Option<Digest>,
) -> Verdict {
    let Some(key) = keys.get(&checkpoint.kek_id) else {
        return Verdict::NotChecked {
            kek_id: checkpoint.kek_id.clone(),
        };
    };
    if !checkpoint.verifies(key) {
        return Verdict::Forged;
    }
    if head_seq.is_none_or(|head| head < checkpoint.seq) {
        return Verdict::TruncatedTail {
            checkpoint_seq: checkpoint.seq,
            head_seq,
        };
    }
    match hash_at_seq {
        Some(hash) if hash == checkpoint.hash => Verdict::Intact {
            seq: checkpoint.seq,
        },
        // The record is gone (retention deleted it after the checkpoint was written) or differs.
        None => Verdict::Intact {
            seq: checkpoint.seq,
        },
        Some(_) => Verdict::Rewritten {
            seq: checkpoint.seq,
        },
    }
}

/// Writes the checkpoint of `(seq, hash)` with the writing key, durably. Nothing without a key.
pub fn write(
    dir: &Path,
    keys: &CheckpointKeys,
    seq: u64,
    hash: Digest,
    time: u64,
) -> io::Result<()> {
    let Some(key) = keys.writer() else {
        return Ok(());
    };
    let checkpoint = Checkpoint::make(key, seq, hash, time);
    let text = serde_json::to_vec(&checkpoint).map_err(io::Error::other)?;
    let tmp = dir.join(format!("{CHECKPOINT_FILE}.tmp"));
    let _ = fs::remove_file(&tmp);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    file.write_all(&text)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, dir.join(CHECKPOINT_FILE))?;
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(id: &str, byte: u8) -> CheckpointKey {
        CheckpointKey::new(id, Zeroizing::new([byte; 32]))
    }

    fn digest(byte: u8) -> Digest {
        Digest([byte; 32])
    }

    #[test]
    fn a_checkpoint_verifies_only_under_its_key_and_unchanged() {
        let keys = CheckpointKeys::new(vec![key("a", 1), key("b", 2)]);
        let cp = Checkpoint::make(&key("b", 2), 5, digest(9), 100);
        assert_eq!(
            verify(&cp, &keys, Some(5), Some(digest(9))),
            Verdict::Intact { seq: 5 }
        );
        assert_eq!(
            verify(&cp, &keys, Some(8), Some(digest(9))),
            Verdict::Intact { seq: 5 }
        );
        for changed in [
            Checkpoint {
                seq: 6,
                ..cp.clone()
            },
            Checkpoint {
                time: 101,
                ..cp.clone()
            },
            Checkpoint {
                hash: digest(8),
                ..cp.clone()
            },
            Checkpoint {
                kek_id: "a".into(),
                ..cp.clone()
            },
            Checkpoint {
                mac: "00".into(),
                ..cp.clone()
            },
        ] {
            assert_eq!(
                verify(&changed, &keys, Some(9), Some(digest(9))),
                Verdict::Forged,
                "{changed:?}"
            );
        }
        let other = CheckpointKeys::new(vec![key("c", 3)]);
        assert_eq!(
            verify(&cp, &other, Some(5), None),
            Verdict::NotChecked { kek_id: "b".into() }
        );
    }

    #[test]
    fn a_log_cut_before_its_checkpoint_or_rewritten_there_is_found() {
        let keys = CheckpointKeys::new(vec![key("a", 1)]);
        let cp = Checkpoint::make(&key("a", 1), 5, digest(9), 100);
        assert_eq!(
            verify(&cp, &keys, Some(4), None),
            Verdict::TruncatedTail {
                checkpoint_seq: 5,
                head_seq: Some(4)
            }
        );
        assert_eq!(
            verify(&cp, &keys, None, None),
            Verdict::TruncatedTail {
                checkpoint_seq: 5,
                head_seq: None
            }
        );
        assert_eq!(
            verify(&cp, &keys, Some(6), Some(digest(1))),
            Verdict::Rewritten { seq: 5 }
        );
    }

    #[test]
    fn write_then_read_round_trips_and_needs_a_key() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), &CheckpointKeys::default(), 1, digest(1), 1).unwrap();
        assert_eq!(read(dir.path()).unwrap(), None);
        let keys = CheckpointKeys::new(vec![key("a", 1)]);
        write(dir.path(), &keys, 7, digest(3), 42).unwrap();
        let cp = read(dir.path()).unwrap().unwrap();
        assert_eq!(
            (cp.seq, cp.hash, cp.time, cp.kek_id.as_str()),
            (7, digest(3), 42, "a")
        );
        assert_eq!(
            verify(&cp, &keys, Some(7), Some(digest(3))),
            Verdict::Intact { seq: 7 }
        );
        write(dir.path(), &keys, 8, digest(4), 43).unwrap();
        assert_eq!(read(dir.path()).unwrap().unwrap().seq, 8);
        assert!(!dir.path().join("checkpoint.json.tmp").exists());
    }
}
