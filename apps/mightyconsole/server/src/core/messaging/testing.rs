//! The test backend of the messaging core (Mightyconsole spec §5.8): an in-memory topic with
//! partitions that exercises tail, browse, the filter, the codecs and the Composer before NATS
//! and Kafka exist. The `echo` tool serves one per connection (`echo.messages.*`), so the UI's
//! MessageViewer and Composer run against it too.
//!
//! - [`TopicReader`] is a [`PullSource`]: it reads from per-partition offsets and, when
//!   following, waits for new messages; it counts its reads so tests see that a paused stream
//!   stops reading.
//! - [`TestTopic::subscribe`] gives a [`PushBuffer`] that receives every new message, as core
//!   NATS would: push-only, newest kept, oldest dropped.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use message_codecs::{Header, Message, TimestampKind};
use security_types::Clock;
use tokio::sync::Notify;

use super::tail::{PullSource, PushBuffer};
use crate::core::ToolError;

/// Messages a reader returns per read, at most.
pub const READ_BATCH: usize = 500;

/// An in-memory topic.
pub struct TestTopic {
    pub name: String,
    clock: Arc<dyn Clock>,
    partitions: Mutex<Vec<Vec<Message>>>,
    appended: Notify,
    subscribers: Mutex<Vec<Weak<PushBuffer>>>,
    round_robin: AtomicU64,
}

impl TestTopic {
    pub fn new(name: impl Into<String>, partitions: usize, clock: Arc<dyn Clock>) -> Self {
        Self {
            name: name.into(),
            clock,
            partitions: Mutex::new(vec![Vec::new(); partitions.max(1)]),
            appended: Notify::new(),
            subscribers: Mutex::new(Vec::new()),
            round_robin: AtomicU64::new(0),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Vec<Message>>> {
        self.partitions.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn partition_count(&self) -> usize {
        self.lock().len()
    }

    /// Appends a record: to `partition`, else by the key's hash, else round robin. Returns the
    /// partition and the offset.
    pub fn append(
        &self,
        partition: Option<i32>,
        key: Option<Vec<u8>>,
        payload: Vec<u8>,
        headers: Vec<Header>,
    ) -> Result<(i32, i64), ToolError> {
        let count = self.partition_count();
        let p = match partition {
            Some(p) if p >= 0 && (p as usize) < count => p as usize,
            Some(p) => {
                return Err(ToolError::invalid(
                    "echo",
                    "partition",
                    format!("partition {p} does not exist (0 to {})", count - 1),
                ));
            }
            None => match &key {
                Some(k) => (fnv(k) % count as u64) as usize,
                None => (self.round_robin.fetch_add(1, Ordering::Relaxed) % count as u64) as usize,
            },
        };
        let mut m = Message::new(
            self.name.clone(),
            payload,
            self.clock.now_unix_ms() as i64 * 1000,
            TimestampKind::Create,
        );
        m.partition = Some(p as i32);
        m.key = key;
        m.headers = Some(headers);
        let offset = {
            let mut parts = self.lock();
            let offset = parts[p].len() as i64;
            m.offset = Some(offset);
            parts[p].push(m.clone());
            offset
        };
        self.appended.notify_waiters();
        let mut subs = self.subscribers.lock().unwrap_or_else(|e| e.into_inner());
        subs.retain(|w| match w.upgrade() {
            Some(buffer) => {
                buffer.push(m.clone());
                true
            }
            None => false,
        });
        Ok((p as i32, offset))
    }

    /// The next offset of every partition.
    pub fn end_offsets(&self) -> Vec<i64> {
        self.lock().iter().map(|p| p.len() as i64).collect()
    }

    /// One record.
    pub fn get(&self, partition: i32, offset: i64) -> Option<Message> {
        let parts = self.lock();
        parts
            .get(usize::try_from(partition).ok()?)?
            .get(usize::try_from(offset).ok()?)
            .cloned()
    }

    /// A push-only subscription: new messages from now on.
    pub fn subscribe(&self, buffer: &Arc<PushBuffer>) {
        self.subscribers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(Arc::downgrade(buffer));
    }
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// Reads a [`TestTopic`] from per-partition offsets.
pub struct TopicReader {
    topic: Arc<TestTopic>,
    next: Vec<i64>,
    /// Exclusive per-partition end for a browse to the end at start; `None` when following.
    end: Option<Vec<i64>>,
    /// Upstream reads so far (tests: a paused stream stops reading).
    pub reads: Arc<AtomicU64>,
}

impl TopicReader {
    /// From `next` offsets (one per partition, clamped to the partition), following new
    /// messages when `follow`, else ending at the offsets of now.
    pub fn new(topic: Arc<TestTopic>, next: Vec<i64>, follow: bool) -> Self {
        let ends = topic.end_offsets();
        let next = ends
            .iter()
            .enumerate()
            .map(|(i, end)| next.get(i).copied().unwrap_or(0).clamp(0, *end))
            .collect();
        Self {
            end: (!follow).then_some(ends),
            topic,
            next,
            reads: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl PullSource for TopicReader {
    async fn next(&mut self) -> Result<Option<Vec<Message>>, ToolError> {
        loop {
            let notified = self.topic.appended.notified();
            let mut out = Vec::new();
            {
                let parts = self.topic.lock();
                // Round robin over partitions, a few at a time, so they interleave.
                'fill: loop {
                    let mut any = false;
                    for (p, records) in parts.iter().enumerate() {
                        let end = self.end.as_ref().map_or(records.len() as i64, |e| e[p]);
                        let from = self.next[p];
                        if from < end {
                            let take = (end - from).min(16) as usize;
                            out.extend(
                                records[from as usize..from as usize + take].iter().cloned(),
                            );
                            self.next[p] += take as i64;
                            any = true;
                            if out.len() >= READ_BATCH {
                                break 'fill;
                            }
                        }
                    }
                    if !any {
                        break;
                    }
                }
            }
            if !out.is_empty() {
                self.reads.fetch_add(1, Ordering::Relaxed);
                return Ok(Some(out));
            }
            if self.end.is_some() {
                return Ok(None);
            }
            notified.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use security_types::SystemClock;

    #[tokio::test]
    async fn reads_interleave_and_end() {
        let t = Arc::new(TestTopic::new("t", 2, Arc::new(SystemClock)));
        for i in 0..5 {
            t.append(Some(i % 2), None, vec![i as u8], vec![]).unwrap();
        }
        assert_eq!(t.end_offsets(), vec![3, 2]);
        let mut r = TopicReader::new(t.clone(), vec![1, 0], false);
        let batch = r.next().await.unwrap().unwrap();
        let got: Vec<(i32, i64)> = batch
            .iter()
            .map(|m| (m.partition.unwrap(), m.offset.unwrap()))
            .collect();
        assert_eq!(got, vec![(0, 1), (0, 2), (1, 0), (1, 1)]);
        assert!(r.next().await.unwrap().is_none());
        assert!(t.append(Some(5), None, vec![], vec![]).is_err());
        // The same key goes to the same partition.
        let (p1, _) = t.append(None, Some(b"k".to_vec()), vec![], vec![]).unwrap();
        let (p2, _) = t.append(None, Some(b"k".to_vec()), vec![], vec![]).unwrap();
        assert_eq!(p1, p2);
    }

    #[tokio::test]
    async fn subscribers_get_new_messages() {
        let t = TestTopic::new("t", 1, Arc::new(SystemClock));
        t.append(None, None, b"old".to_vec(), vec![]).unwrap();
        let b = Arc::new(PushBuffer::new(2, 1 << 20));
        t.subscribe(&b);
        for i in 0..3u8 {
            t.append(None, None, vec![i], vec![]).unwrap();
        }
        assert_eq!(b.len(), 2, "newest two kept");
    }
}
