//! The Host page's disk usage and the tree's counts (Mightyconsole spec §10.4 "Host", DOC-21 Open
//! question 45 q, TSK-81 batch 4):
//!
//! - `docker.host.df`: `GET /system/df` summed per kind as `docker system df` sums it, with what
//!   is reclaimable (the space a prune could free; prune itself stays "Later", DOC-20).
//! - `docker.host.counts`: how many images, volumes and networks the host has, for the tree; three
//!   small lists rather than `/system/df`, which walks every volume to size it.
//! - `top`: a running container's processes from `GET /containers/{id}/top`, the Stats tab's
//!   Processes.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::DockerClient;
use crate::core::ToolError;

/// One kind of `docker system df`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsageKind {
    /// How many there are.
    pub count: u32,
    /// How many are in use: images and volumes some container uses, running containers, build
    /// cache records in use.
    pub active: u32,
    /// Bytes on disk.
    pub size: u64,
    /// Bytes a prune of this kind could free.
    pub reclaimable: u64,
}

/// `docker.host.df`: the host's disk usage per kind.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub images: DiskUsageKind,
    /// The containers' writable layers.
    pub containers: DiskUsageKind,
    /// Local volumes; a size Docker could not read counts as 0.
    pub volumes: DiskUsageKind,
    pub build_cache: DiskUsageKind,
}

/// `docker.host.counts`: what the tree shows beside Images, Volumes and Networks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostCounts {
    pub images: u32,
    pub volumes: u32,
    pub networks: u32,
}

/// `docker.containers.top`: the processes of a running container, as the host's `ps` printed
/// them (`ps -ef` by default; a BusyBox host prints fewer columns).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTop {
    /// The column names: `UID`, `PID`, `PPID`, `C`, `STIME`, `TTY`, `TIME`, `CMD`, ...
    pub titles: Vec<String>,
    /// One row per process, a value per title.
    pub processes: Vec<Vec<String>>,
}

fn items(value: &Value, key: &str) -> Vec<Value> {
    value
        .get(key)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn int(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

/// A non-negative size; Docker writes -1 for one it did not compute.
fn bytes(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

fn count(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The kinds of a `GET /system/df` answer, summed as the Docker CLI's `system df` does:
///
/// - images: the size is `LayersSize` (shared layers once); what is in use is each used image's
///   own size less what it shares, and the rest is reclaimable;
/// - containers: the writable layers (`SizeRw`), reclaimable when the container is not running;
/// - volumes: `UsageData.Size`, reclaimable when no container references the volume;
/// - build cache: records that are not shared, reclaimable when not in use.
pub fn disk_usage(df: &Value) -> DiskUsage {
    let images = items(df, "Images");
    let used_images: Vec<&Value> = images.iter().filter(|i| int(i, "Containers") > 0).collect();
    let layers = bytes(int(df, "LayersSize"));
    let in_use: u64 = used_images
        .iter()
        .filter(|i| int(i, "Size") >= 0 && int(i, "SharedSize") >= 0)
        .map(|i| bytes(int(i, "Size") - int(i, "SharedSize")))
        .sum();

    let containers = items(df, "Containers");
    let running = |c: &&Value| c.get("State").and_then(Value::as_str) == Some("running");

    let volumes = items(df, "Volumes");
    let volume_size = |v: &Value| {
        bytes(
            v.pointer("/UsageData/Size")
                .and_then(Value::as_i64)
                .unwrap_or(-1),
        )
    };
    let volume_used = |v: &&Value| {
        v.pointer("/UsageData/RefCount")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            > 0
    };

    let cache = items(df, "BuildCache");
    let flag = |v: &Value, key: &str| v.get(key).and_then(Value::as_bool).unwrap_or(false);
    let unshared: Vec<&Value> = cache.iter().filter(|c| !flag(c, "Shared")).collect();

    DiskUsage {
        images: DiskUsageKind {
            count: count(images.len()),
            active: count(used_images.len()),
            size: layers,
            reclaimable: layers.saturating_sub(in_use),
        },
        containers: DiskUsageKind {
            count: count(containers.len()),
            active: count(containers.iter().filter(running).count()),
            size: containers.iter().map(|c| bytes(int(c, "SizeRw"))).sum(),
            reclaimable: containers
                .iter()
                .filter(|c| !running(c))
                .map(|c| bytes(int(c, "SizeRw")))
                .sum(),
        },
        volumes: DiskUsageKind {
            count: count(volumes.len()),
            active: count(volumes.iter().filter(volume_used).count()),
            size: volumes.iter().map(volume_size).sum(),
            reclaimable: volumes
                .iter()
                .filter(|v| !volume_used(v))
                .map(volume_size)
                .sum(),
        },
        build_cache: DiskUsageKind {
            count: count(cache.len()),
            active: count(cache.iter().filter(|c| flag(c, "InUse")).count()),
            size: unshared.iter().map(|c| bytes(int(c, "Size"))).sum(),
            reclaimable: unshared
                .iter()
                .filter(|c| !flag(c, "InUse"))
                .map(|c| bytes(int(c, "Size")))
                .sum(),
        },
    }
}

/// The host's disk usage.
pub async fn df(client: &DockerClient) -> Result<DiskUsage, ToolError> {
    let df: Value = client.engine.get("/system/df", "engine").await?;
    Ok(disk_usage(&df))
}

/// The tree's counts: images (as `docker images` and the Images tab count them, without the
/// intermediate layers), volumes and networks.
pub async fn counts(client: &DockerClient) -> Result<HostCounts, ToolError> {
    let (images, volumes, networks) = tokio::try_join!(
        client.engine.get::<Value>("/images/json", "engine"),
        client.engine.get::<Value>("/volumes", "engine"),
        client.engine.get::<Value>("/networks", "engine"),
    )?;
    Ok(HostCounts {
        images: count(images.as_array().map_or(0, Vec::len)),
        volumes: count(items(&volumes, "Volumes").len()),
        networks: count(networks.as_array().map_or(0, Vec::len)),
    })
}

/// A `GET /containers/{id}/top` answer; values that are not strings are written as JSON.
pub fn top(value: &Value) -> ContainerTop {
    let text = |v: &Value| v.as_str().map_or_else(|| v.to_string(), str::to_owned);
    ContainerTop {
        titles: items(value, "Titles").iter().map(text).collect(),
        processes: items(value, "Processes")
            .iter()
            .map(|row| row.as_array().into_iter().flatten().map(text).collect())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn disk_usage_sums_as_docker_system_df() {
        let df = json!({
            "LayersSize": 1000,
            "Images": [
                { "Id": "a", "Size": 600, "SharedSize": 100, "Containers": 2 },
                { "Id": "b", "Size": 300, "SharedSize": 100, "Containers": 0 },
                { "Id": "c", "Size": 200, "SharedSize": -1, "Containers": 1 }
            ],
            "Containers": [
                { "Id": "x", "State": "running", "SizeRw": 10 },
                { "Id": "y", "State": "exited", "SizeRw": 30 },
                { "Id": "z", "State": "created" }
            ],
            "Volumes": [
                { "Name": "v1", "UsageData": { "Size": 500, "RefCount": 1 } },
                { "Name": "v2", "UsageData": { "Size": 70, "RefCount": 0 } },
                { "Name": "v3", "UsageData": { "Size": -1, "RefCount": -1 } }
            ],
            "BuildCache": [
                { "ID": "k1", "Size": 40, "InUse": false, "Shared": false },
                { "ID": "k2", "Size": 50, "InUse": true, "Shared": false },
                { "ID": "k3", "Size": 60, "InUse": false, "Shared": true }
            ]
        });
        let usage = disk_usage(&df);
        assert_eq!(
            usage.images,
            DiskUsageKind {
                count: 3,
                active: 2,
                size: 1000,
                reclaimable: 500
            }
        );
        assert_eq!(
            usage.containers,
            DiskUsageKind {
                count: 3,
                active: 1,
                size: 40,
                reclaimable: 30
            }
        );
        assert_eq!(
            usage.volumes,
            DiskUsageKind {
                count: 3,
                active: 1,
                size: 570,
                reclaimable: 70
            }
        );
        assert_eq!(
            usage.build_cache,
            DiskUsageKind {
                count: 3,
                active: 1,
                size: 90,
                reclaimable: 40
            }
        );
        assert_eq!(disk_usage(&json!({ "Images": null })), DiskUsage::default());
    }

    #[test]
    fn top_keeps_the_hosts_columns() {
        let top = top(&json!({
            "Titles": ["PID", "USER", "TIME", "COMMAND"],
            "Processes": [["1", "root", "0:00", "sleep infinity"], ["7", "root", 3, "sh"]]
        }));
        assert_eq!(top.titles, ["PID", "USER", "TIME", "COMMAND"]);
        assert_eq!(top.processes[1], ["7", "root", "3", "sh"]);
    }
}
