//! Decoding on NATS (TSK-85 batch 4, DOC-21 Open question 45 (p)): `nats.schemas.test`, the
//! mapping test of the Schemas tab. The messaging core decodes (`core::messaging::test_mapping`);
//! this module only finds the last messages a mapping covers:
//!
//! - a subject pattern: the streams that store subjects matching it (`STREAM.LIST` with the
//!   pattern; the KV and Object Store streams left out), read with the pattern as the filter, the
//!   newest messages of all of them;
//! - a stream: its last messages, whatever the subject;
//! - a KV bucket: the last puts of `KV_<bucket>` (deletes and purges left out), by key.
//!
//! Core NATS keeps no messages, so a pattern no stream stores has nothing to test on; the answer
//! says so. Each stream is read backwards in widening windows (20 sequences, then 200, 2,000 …)
//! through ordered consumers with a filter, at most [`MAX_SCAN`] sequences and [`TEST_TIMEOUT`],
//! keeping only the last messages in memory.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use ambidex::{Ctx, RegistryError, Router, rpc};
use async_nats::jetstream::consumer::{self, DeliverPolicy};
use futures_util::StreamExt as _;
use message_codecs::{MappingTarget, Part};

use super::client::{NatsClient, remote, subscribe_subject};
use super::jetstream::{get_info, list_streams, us};
use super::{TOOL, handle, kv, objects};
use crate::core::messaging::{MappingSample, MappingTestInput, MappingTestOutput, test_mapping};
use crate::core::{Hub, ToolError, ToolErrorKind, ToolResult};

/// Sequences read per stream at most, whatever the window.
pub const MAX_SCAN: u64 = 100_000;
/// The whole test, every stream included.
pub const TEST_TIMEOUT: Duration = Duration::from_secs(15);
/// The wait for the next message of a window.
const NEXT_TIMEOUT: Duration = Duration::from_secs(5);

/// A message read for the test.
struct Sample {
    subject: String,
    sequence: u64,
    stored_us: i64,
    payload: Vec<u8>,
}

/// The last `want` messages of a stream (matching `filter`), oldest first.
async fn last_messages(
    c: &NatsClient,
    stream: &str,
    filter: Option<&str>,
    want: usize,
    kv: bool,
) -> Result<Vec<Sample>, ToolError> {
    let info = get_info(c, stream).await?;
    let (first, last) = (info.state.first_sequence.max(1), info.state.last_sequence);
    if info.state.messages == 0 || last < first {
        return Ok(Vec::new());
    }
    let js_stream = c
        .jetstream
        .get_stream_no_info(stream)
        .await
        .map_err(|e| remote("mapping test", e))?;
    let mut have: VecDeque<Sample> = VecDeque::new();
    let mut upper = last;
    let mut width = want as u64;
    let mut scanned = 0u64;
    loop {
        let width_now = width.min(MAX_SCAN - scanned).max(1);
        let lower = upper.saturating_sub(width_now - 1).max(first);
        let need = want - have.len();
        let mut chunk = read_window(&js_stream, filter, lower, upper, need, kv).await?;
        while let Some(s) = chunk.pop_back() {
            have.push_front(s);
        }
        scanned += upper - lower + 1;
        if have.len() >= want || lower <= first || scanned >= MAX_SCAN {
            break;
        }
        upper = lower - 1;
        width = width.saturating_mul(10);
    }
    Ok(have.into())
}

/// The last `keep` messages from `lower` to `upper` (both included) through an ordered consumer.
async fn read_window(
    js_stream: &async_nats::jetstream::stream::Stream<()>,
    filter: Option<&str>,
    lower: u64,
    upper: u64,
    keep: usize,
    kv: bool,
) -> Result<VecDeque<Sample>, ToolError> {
    let mut out = VecDeque::new();
    let mut consumer = js_stream
        .create_consumer(consumer::pull::OrderedConfig {
            filter_subject: filter.unwrap_or_default().to_owned(),
            deliver_policy: DeliverPolicy::ByStartSequence {
                start_sequence: lower,
            },
            ..consumer::pull::OrderedConfig::default()
        })
        .await
        .map_err(|e| remote("mapping test", e))?;
    let name = consumer.cached_info().name.clone();
    let pending = consumer.info().await.map(|i| i.num_pending).unwrap_or(1);
    if pending > 0 {
        let mut messages = consumer
            .messages()
            .await
            .map_err(|e| remote("mapping test", e))?;
        loop {
            let m = match tokio::time::timeout(NEXT_TIMEOUT, messages.next()).await {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => return Err(remote("mapping test", e)),
                Ok(None) | Err(_) => break,
            };
            let info = m.info().map_err(|e| remote("mapping test", e))?;
            let sequence = info.stream_sequence;
            let stored_us = us(info.published);
            let pending = info.pending;
            if sequence > upper {
                break;
            }
            let live = !kv || kv::kv_operation(m.message.headers.as_ref()) == "put";
            if live {
                out.push_back(Sample {
                    subject: m.message.subject.to_string(),
                    sequence,
                    stored_us,
                    payload: m.message.payload.to_vec(),
                });
                if out.len() > keep {
                    out.pop_front();
                }
            }
            if sequence >= upper || pending == 0 {
                break;
            }
        }
    }
    let _ = js_stream.delete_consumer(&name).await;
    Ok(out)
}

/// The test of one mapping on the last messages it covers.
async fn sample(
    c: &NatsClient,
    target: &MappingTarget,
    want: usize,
) -> Result<(String, Vec<MappingSample>, Option<String>), ToolError> {
    let (source, mut samples, note) = match target {
        MappingTarget::Subject { pattern } => {
            let pattern = subscribe_subject(pattern).map_err(|mut e| {
                e.field = Some("mapping.target.pattern".into());
                e
            })?;
            let streams: Vec<String> = list_streams(c, Some(&pattern))
                .await?
                .into_iter()
                .filter(|i| kv::is_bucket(i).is_none() && objects::is_bucket(i).is_none())
                .map(|i| i.config.name)
                .collect();
            let mut all = Vec::new();
            for s in &streams {
                all.extend(last_messages(c, s, Some(&pattern), want, false).await?);
            }
            let source = match streams.as_slice() {
                [] => String::new(),
                [one] => format!("stream {one}"),
                many => format!("streams {}", many.join(", ")),
            };
            let note = streams.is_empty().then(|| {
                format!(
                    "No stream stores {pattern}. Core NATS keeps no messages, so there is nothing \
                     to test on: subscribe to {pattern} to see them live."
                )
            });
            (source, all, note)
        }
        MappingTarget::Stream { name } => {
            let all = last_messages(c, name, None, want, false).await?;
            (format!("stream {name}"), all, None)
        }
        MappingTarget::KvBucket { bucket } => {
            let filter = format!("$KV.{bucket}.>");
            let mut all = last_messages(c, &format!("KV_{bucket}"), Some(&filter), want, true)
                .await
                .map_err(|e| match e.kind {
                    ToolErrorKind::NotFound => ToolError::not_found(
                        TOOL,
                        "bucket",
                        format!("no key-value bucket {bucket}"),
                    ),
                    _ => e,
                })?;
            let prefix = format!("$KV.{bucket}.");
            for s in &mut all {
                if let Some(key) = s.subject.strip_prefix(&prefix) {
                    s.subject = key.to_owned();
                }
            }
            (format!("bucket {bucket}"), all, None)
        }
        MappingTarget::Topic { .. } => {
            return Err(ToolError::invalid(
                TOOL,
                "mapping.target",
                "a Kafka topic: NATS maps subjects, streams and key-value buckets",
            ));
        }
    };
    // The newest of every stream, oldest first.
    samples.sort_by_key(|s| (s.stored_us, s.sequence));
    let from = samples.len().saturating_sub(want);
    let samples = samples
        .drain(from..)
        .map(|s| MappingSample {
            subject: s.subject,
            sequence: Some(s.sequence),
            payload: s.payload,
        })
        .collect();
    let note = note.or_else(|| Some(format!("{source} has no messages yet.")));
    Ok((source, samples, note))
}

/// `nats.schemas.test`.
pub struct NatsSchemasApi(pub Arc<Hub>);

#[rpc::router(namespace = "nats.schemas")]
impl NatsSchemasApi {
    /// A mapping, maybe not saved, tried on the last messages it covers (20 by default): what
    /// each decodes to, or why it fails.
    #[rpc::query(perm = "nats.read", risk = Risk::Read)]
    async fn test(&self, ctx: Ctx, input: MappingTestInput) -> ToolResult<MappingTestOutput> {
        if input.mapping.part == Part::Key {
            return Err(ToolError::invalid(
                TOOL,
                "mapping.part",
                "NATS messages have no key: map the value",
            )
            .into());
        }
        let h = handle(&self.0, &ctx, &input.conn_id)?;
        let codecs = self.0.codecs(&ctx.session().id, &input.conn_id)?;
        let want = input.limit();
        let (source, samples, note) =
            tokio::time::timeout(TEST_TIMEOUT, sample(&h.value, &input.mapping.target, want))
                .await
                .map_err(|_| {
                    ToolError::new(
                        ToolErrorKind::Remote,
                        TOOL,
                        format!(
                            "the test read messages for {} s without finishing",
                            TEST_TIMEOUT.as_secs()
                        ),
                    )
                    .retryable(true)
                })??;
        Ok(test_mapping(&codecs, &input, source, samples, note).await)
    }
}

pub fn mount(router: &Router, hub: &Arc<Hub>) -> Result<(), RegistryError> {
    router.mount(NatsSchemasApi(Arc::clone(hub)))?;
    Ok(())
}
