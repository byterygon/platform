//! Where Plugin Host audit entries go, and the clock that stamps them.
//!
//! The sink, its error, the clock and the failure reporter are the ones shared with Ambidex in
//! `security-types` (Ambidex spec Open questions 24g and 26), re-exported here, so one sink serves
//! both libraries and Plugin Host and Ambidex records share one hash-chained log. Entries never
//! contain credentials, secret references or payload bytes.
//!
//! Entries that must exist before an operation takes effect (a broker open handed to the plugin,
//! a grant becoming usable) are awaited with a timeout, and the operation fails closed if the
//! write fails or times out. A revocation is the opposite: it takes effect at once and never
//! waits on the sink, so its entry goes through a retry queue that writes it in the background
//! and retries.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::Poll;
use std::time::Duration;

use security_types::{AuditEntry, BoxFuture, append_within, write_within};
pub use security_types::{
    AuditEntryKind, AuditError, AuditFailure, AuditFailureEffect, AuditReporter, AuditSink,
    CLOCK_RECHECK, Clock, MemoryAuditLog, StderrReporter, SystemClock,
};
use tokio::sync::{Notify, mpsc};

/// How the revocation retry queue retries an entry. Values are provisional (Ambidex spec Open
/// question 26).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Writes attempted in all, the first one included.
    pub attempts: u32,
    /// Wait before the first retry; doubled after each, up to `max_backoff`.
    pub first_backoff: Duration,
    pub max_backoff: Duration,
    /// How long one attempt may take before it is given up (a hung sink counts as failing).
    pub attempt_timeout: Duration,
    /// Entries waiting for the writer. One more is reported as lost instead of queued.
    pub capacity: usize,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 5,
            first_backoff: Duration::from_millis(100),
            max_backoff: Duration::from_secs(2),
            attempt_timeout: Duration::from_secs(5),
            capacity: 1024,
        }
    }
}

/// Writes entries that must not hold up the operation they record, without forgetting them.
///
/// [`AuditQueue::submit`] polls the write once and returns at once: a sink that answers on the
/// first poll (such as [`MemoryAuditLog`]) has the entry in place before `submit` returns, in the
/// order of the calls. A write still pending, or one that failed, goes to a background writer task
/// (started on the current Tokio runtime at first use) that finishes it and retries with backoff.
/// When every attempt failed, the failure goes to the reporter. Entries still queued when the
/// owner is dropped are still written; [`AuditQueue::flushed`] waits until none are left. If the
/// writer task itself goes (its runtime shut down), every entry it had not written yet is
/// reported as lost, and the next entry starts a new writer.
pub(crate) struct AuditQueue {
    sink: Arc<dyn AuditSink>,
    reporter: Arc<dyn AuditReporter>,
    retry: RetryPolicy,
    writer: Mutex<Option<mpsc::Sender<Job>>>,
    pending: Arc<Pending>,
}

/// One entry on its way to the sink. It counts as pending until [`Job::written`] or
/// [`Job::lost`]; a job dropped before either (its writer task was dropped with the runtime,
/// queued or mid-write) reports itself as lost, so no entry disappears unreported and
/// [`AuditQueue::flushed`] still returns.
struct Job {
    entry: AuditEntry,
    /// The first write, if it was still pending when `submit` returned.
    in_flight: Option<BoxFuture<'static, Result<(), AuditError>>>,
    /// Attempts already made and failed.
    failed: u32,
    last_error: Option<AuditError>,
    reporter: Arc<dyn AuditReporter>,
    pending: Arc<Pending>,
    settled: bool,
}

impl Job {
    /// The entry is recorded.
    fn written(mut self) {
        self.settle();
    }

    /// The entry will not be recorded: reported, with `error`.
    fn lost(mut self, error: AuditError) {
        report_lost(&*self.reporter, &self.entry, error, self.failed);
        self.settle();
    }

    fn settle(&mut self) {
        self.settled = true;
        self.pending.done();
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        if !self.settled {
            report_lost(
                &*self.reporter,
                &self.entry,
                AuditError("the audit writer stopped before writing the entry".into()),
                self.failed,
            );
            self.pending.done();
        }
    }
}

/// Entries submitted and not yet written or given up.
#[derive(Default)]
struct Pending {
    count: AtomicUsize,
    idle: Notify,
}

impl Pending {
    fn add(&self) {
        self.count.fetch_add(1, Ordering::SeqCst);
    }

    fn done(&self) {
        if self.count.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.idle.notify_waiters();
        }
    }
}

impl AuditQueue {
    pub(crate) fn new(
        sink: Arc<dyn AuditSink>,
        reporter: Arc<dyn AuditReporter>,
        retry: RetryPolicy,
    ) -> Self {
        Self {
            sink,
            reporter,
            retry,
            writer: Mutex::new(None),
            pending: Arc::default(),
        }
    }

    /// Records `entry` without waiting on the sink (see the type docs).
    pub(crate) async fn submit(&self, entry: AuditEntry) {
        let sink = Arc::clone(&self.sink);
        let first_entry = entry.clone();
        let mut first: BoxFuture<'static, Result<(), AuditError>> =
            Box::pin(async move { sink.append(first_entry).await });
        let polled = std::future::poll_fn(|cx| Poll::Ready(first.as_mut().poll(cx))).await;
        let (in_flight, failed, last_error) = match polled {
            Poll::Ready(Ok(())) => return,
            Poll::Ready(Err(error)) => (None, 1, Some(error)),
            Poll::Pending => (Some(first), 0, None),
        };
        self.pending.add();
        self.enqueue(Job {
            entry,
            in_flight,
            failed,
            last_error,
            reporter: Arc::clone(&self.reporter),
            pending: Arc::clone(&self.pending),
            settled: false,
        });
    }

    /// Completes once every entry submitted so far is written or given up (and reported).
    pub(crate) async fn flushed(&self) {
        loop {
            let idle = self.pending.idle.notified();
            let mut idle = std::pin::pin!(idle);
            idle.as_mut().enable();
            if self.pending.count.load(Ordering::SeqCst) == 0 {
                return;
            }
            idle.await;
        }
    }

    fn enqueue(&self, job: Job) {
        let refused = match self.writer() {
            Some(writer) => writer.try_send(job).err().map(|err| {
                let reason = match err {
                    mpsc::error::TrySendError::Full(_) => "audit retry queue is full",
                    mpsc::error::TrySendError::Closed(_) => "audit retry queue is closed",
                };
                (err.into_inner(), reason)
            }),
            None => Some((job, "no Tokio runtime for the audit retry queue")),
        };
        if let Some((job, reason)) = refused {
            job.lost(AuditError(reason.into()));
        }
    }

    /// The writer task's queue, started on first use.
    fn writer(&self) -> Option<mpsc::Sender<Job>> {
        let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = writer.as_ref().filter(|tx| !tx.is_closed()) {
            return Some(tx.clone());
        }
        let runtime = tokio::runtime::Handle::try_current().ok()?;
        let (tx, rx) = mpsc::channel(self.retry.capacity.max(1));
        runtime.spawn(write_loop(rx, Arc::clone(&self.sink), self.retry));
        *writer = Some(tx.clone());
        Some(tx)
    }
}

/// One entry at a time, in submission order; exits once every sender is gone and the queue is
/// drained.
async fn write_loop(mut rx: mpsc::Receiver<Job>, sink: Arc<dyn AuditSink>, retry: RetryPolicy) {
    while let Some(job) = rx.recv().await {
        write_with_retry(job, &*sink, retry).await;
    }
}

async fn write_with_retry(mut job: Job, sink: &dyn AuditSink, retry: RetryPolicy) {
    let attempt_deadline = || tokio::time::Instant::now() + retry.attempt_timeout;
    if let Some(first) = job.in_flight.take() {
        match write_within(first, attempt_deadline()).await {
            Ok(()) => return job.written(),
            Err(error) => {
                job.failed += 1;
                job.last_error = Some(error);
            }
        }
    }
    let mut backoff = retry.first_backoff;
    while job.failed < retry.attempts {
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(retry.max_backoff);
        match append_within(sink, job.entry.clone(), attempt_deadline()).await {
            Ok(()) => return job.written(),
            Err(error) => {
                job.failed += 1;
                job.last_error = Some(error);
            }
        }
    }
    let error = job
        .last_error
        .take()
        .unwrap_or_else(|| AuditError("not written".into()));
    job.lost(error);
}

fn report_lost(reporter: &dyn AuditReporter, entry: &AuditEntry, error: AuditError, attempts: u32) {
    reporter.report(&AuditFailure {
        entry: AuditEntryKind::Operation,
        effect: AuditFailureEffect::EntryLost,
        action: entry.action.name.clone(),
        correlation_id: entry.correlation_id.clone(),
        error,
        attempts,
    });
}
