//! `docker.containers.stats` (Mightyconsole spec §10.4 "Stats", §10.6): a running container's
//! samples, one a second, as `jsonl` [`StatsSample`] lines. Docker pushes them whether or not the
//! client reads, so the stream is push-only (spec §2.5): the latest sample replaces one not sent
//! yet, and the replaced ones are counted as dropped.
//!
//! Each sample is read as `docker stats` reads it: CPU as the share of the host's CPUs used since
//! the previous sample (100 % is one CPU), memory without the page cache (`inactive_file`, or
//! `total_inactive_file` on cgroup v1), network and block I/O as totals since the start (the UI
//! makes rates of them).

use std::sync::Arc;

use ambidex::{BinarySink, Ctx};
use http_body_util::BodyExt;
use hyper::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::containers::container_ref;
use super::stream::{LineSplitter, ended, read_error};
use super::{DockerClient, TOOL};
use crate::core::{Hub, ToolError, ToolErrorKind, ToolResult};

/// The longest stats line read; Docker's are a few kilobytes.
const MAX_STATS_LINE: usize = 1024 * 1024;

/// A PID limit at or above this is "no limit" (cgroup v2's `max`).
const NO_PIDS_LIMIT: u64 = 1 << 62;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersStatsInput {
    pub conn_id: String,
    pub id: String,
    pub stream_id: String,
}

/// One line of `docker.containers.stats` (`jsonl`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StatsSample {
    /// When Docker read it, Unix milliseconds.
    pub time_ms: u64,
    /// The share of the host's CPUs since the previous sample: 100 is one whole CPU. Absent on
    /// the first sample (no previous one).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpu_percent: Option<f64>,
    pub online_cpus: u32,
    /// Memory in use without the page cache, bytes.
    pub memory_used: u64,
    /// The container's limit, or the host's memory without one.
    pub memory_limit: u64,
    /// Totals since the container started, over every network.
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// Totals since the container started.
    pub block_read: u64,
    pub block_write: u64,
    pub pids: u64,
    /// Absent when there is no limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub pids_limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersStatsSummary {
    pub samples: u64,
    /// Samples replaced by a newer one before the client asked for them.
    pub dropped: u64,
}

fn u64_at(value: &Value, pointer: &str) -> Option<u64> {
    value.pointer(pointer).and_then(Value::as_u64)
}

/// A sample from one object of `GET /containers/{id}/stats?stream=1`; `None` for a sample with
/// no read time (a stopped container's empty one).
pub fn sample(value: &Value) -> Option<StatsSample> {
    let read = value.get("read").and_then(Value::as_str)?;
    let at = time::OffsetDateTime::parse(read, &time::format_description::well_known::Rfc3339)
        .ok()
        .filter(|t| t.year() > 1)?;
    let time_ms = u64::try_from(at.unix_timestamp_nanos() / 1_000_000).unwrap_or(0);

    let online_cpus = u64_at(value, "/cpu_stats/online_cpus")
        .or_else(|| {
            value
                .pointer("/cpu_stats/cpu_usage/percpu_usage")
                .and_then(Value::as_array)
                .map(|a| a.len() as u64)
        })
        .filter(|n| *n > 0)
        .unwrap_or(1);
    let cpu_total = u64_at(value, "/cpu_stats/cpu_usage/total_usage");
    let cpu_before = u64_at(value, "/precpu_stats/cpu_usage/total_usage");
    let system = u64_at(value, "/cpu_stats/system_cpu_usage");
    let system_before = u64_at(value, "/precpu_stats/system_cpu_usage");
    let cpu_percent = match (cpu_total, cpu_before, system, system_before) {
        (Some(total), Some(before), Some(sys), Some(sys_before))
            if sys > sys_before && before > 0 =>
        {
            let cpu_delta = total.saturating_sub(before) as f64;
            let system_delta = (sys - sys_before) as f64;
            Some(cpu_delta / system_delta * online_cpus as f64 * 100.0)
        }
        _ => None,
    };

    let usage = u64_at(value, "/memory_stats/usage").unwrap_or(0);
    let cache = u64_at(value, "/memory_stats/stats/inactive_file")
        .or_else(|| u64_at(value, "/memory_stats/stats/total_inactive_file"))
        .unwrap_or(0);
    let (rx_bytes, tx_bytes) = value
        .get("networks")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .fold((0u64, 0u64), |(rx, tx), (_, n)| {
            (
                rx + n.get("rx_bytes").and_then(Value::as_u64).unwrap_or(0),
                tx + n.get("tx_bytes").and_then(Value::as_u64).unwrap_or(0),
            )
        });
    let (block_read, block_write) = value
        .pointer("/blkio_stats/io_service_bytes_recursive")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .fold((0u64, 0u64), |(r, w), entry| {
            let n = entry.get("value").and_then(Value::as_u64).unwrap_or(0);
            match entry
                .get("op")
                .and_then(Value::as_str)
                .map(str::to_ascii_lowercase)
                .as_deref()
            {
                Some("read") => (r + n, w),
                Some("write") => (r, w + n),
                _ => (r, w),
            }
        });
    Some(StatsSample {
        time_ms,
        cpu_percent,
        online_cpus: u32::try_from(online_cpus).unwrap_or(u32::MAX),
        memory_used: usage.saturating_sub(cache),
        memory_limit: u64_at(value, "/memory_stats/limit").unwrap_or(0),
        rx_bytes,
        tx_bytes,
        block_read,
        block_write,
        pids: u64_at(value, "/pids_stats/current").unwrap_or(0),
        pids_limit: u64_at(value, "/pids_stats/limit").filter(|n| *n > 0 && *n < NO_PIDS_LIMIT),
    })
}

/// `docker.containers.stats`: see the module docs.
pub async fn run(
    hub: &Arc<Hub>,
    ctx: &Ctx,
    input: ContainersStatsInput,
    sink: &BinarySink,
) -> ToolResult<ContainersStatsSummary> {
    let session = ctx.session().id.clone();
    let id = container_ref("id", &input.id)?.to_owned();
    let claim = hub.claim_stream(&session, TOOL, &input.stream_id)?;
    let (handle, _busy) = hub.busy::<DockerClient>(&session, TOOL, &input.conn_id)?;
    let engine = &handle.value.engine;
    let inspect: Value = engine
        .get(&format!("/containers/{id}/json"), "container")
        .await?;
    if inspect.pointer("/State/Running").and_then(Value::as_bool) != Some(true) {
        return Err(ToolError::new(
            ToolErrorKind::Conflict,
            TOOL,
            format!("{id} is not running: it has no stats"),
        )
        .into());
    }
    let mut body = engine
        .stream(
            Method::GET,
            &format!("/containers/{id}/stats?stream=1"),
            "container",
        )
        .await?;
    let progress = hub.progress(&session, claim.stream_id());
    let mut splitter = LineSplitter::default();
    let mut pending: Option<Vec<u8>> = None;
    let (mut samples, mut dropped) = (0u64, 0u64);
    loop {
        tokio::select! {
            biased;
            () = handle.token.cancelled() => return Err(ended()),
            () = ctx.cancelled() => return Err(ended()),
            ready = sink.ready(), if pending.is_some() => {
                ready?;
                let chunk = pending.take().expect("checked by the guard");
                progress.matched(1, chunk.len() as u64);
                sink.send(chunk).await?;
                samples += 1;
            }
            frame = body.frame() => match frame {
                None => break,
                Some(Err(e)) => return Err(read_error(e).into()),
                Some(Ok(frame)) => {
                    let Ok(data) = frame.into_data() else { continue };
                    splitter.push(&data, MAX_STATS_LINE, |raw| {
                        let Some(line) = serde_json::from_slice::<Value>(raw).ok().as_ref().and_then(sample) else {
                            return;
                        };
                        progress.scanned(1);
                        if pending.is_some() {
                            dropped += 1;
                            progress.dropped(1);
                        }
                        let mut chunk = serde_json::to_vec(&line).expect("a sample serializes");
                        chunk.push(b'\n');
                        pending = Some(chunk);
                    });
                }
            },
        }
    }
    // The container stopped: its last sample still goes out.
    if let Some(chunk) = pending {
        sink.send(chunk).await?;
        samples += 1;
    }
    Ok(ContainersStatsSummary { samples, dropped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_sample_reads_as_docker_stats_does() {
        let s = sample(&json!({
            "read": "2026-11-20T08:00:01.5Z",
            "cpu_stats": { "cpu_usage": { "total_usage": 3_000_000_000u64 }, "system_cpu_usage": 20_000_000_000u64, "online_cpus": 4 },
            "precpu_stats": { "cpu_usage": { "total_usage": 2_000_000_000u64 }, "system_cpu_usage": 10_000_000_000u64 },
            "memory_stats": { "usage": 500_000_000u64, "limit": 1_073_741_824u64, "stats": { "inactive_file": 100_000_000u64 } },
            "networks": { "eth0": { "rx_bytes": 1000, "tx_bytes": 300 }, "eth1": { "rx_bytes": 24, "tx_bytes": 0 } },
            "blkio_stats": { "io_service_bytes_recursive": [
                { "op": "read", "value": 4096 }, { "op": "write", "value": 8192 }, { "op": "Read", "value": 1 }, { "op": "Total", "value": 9 }
            ] },
            "pids_stats": { "current": 23, "limit": 18_446_744_073_709_551_615u64 },
        }))
        .unwrap();
        assert_eq!(s.time_ms, 1_795_161_601_500);
        // 1 s of CPU over 10 s of the host's 4 CPUs: 40 % (100 % is one CPU).
        assert_eq!(s.cpu_percent, Some(40.0));
        assert_eq!(s.memory_used, 400_000_000);
        assert_eq!((s.rx_bytes, s.tx_bytes), (1024, 300));
        assert_eq!((s.block_read, s.block_write), (4097, 8192));
        assert_eq!((s.pids, s.pids_limit), (23, None));
        // cgroup v1's name for the cache; the first sample has no CPU share.
        let s = sample(&json!({
            "read": "2026-11-20T08:00:01Z",
            "cpu_stats": { "cpu_usage": { "total_usage": 5, "percpu_usage": [1, 2] }, "system_cpu_usage": 10 },
            "precpu_stats": { "cpu_usage": { "total_usage": 0 } },
            "memory_stats": { "usage": 10, "stats": { "total_inactive_file": 4 } },
            "pids_stats": { "current": 1, "limit": 100 },
        }))
        .unwrap();
        assert_eq!(s.cpu_percent, None);
        assert_eq!(s.online_cpus, 2);
        assert_eq!(s.memory_used, 6);
        assert_eq!(s.pids_limit, Some(100));
        // A stopped container's empty sample.
        assert!(sample(&json!({ "read": "0001-01-01T00:00:00Z" })).is_none());
    }
}
