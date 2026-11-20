//! `docker.containers.*` (Mightyconsole spec §10.4 to §10.6, TSK-81 batch 2b): the list, inspect
//! with the Overview's facts, start, stop, restart, remove, and logs as a `jsonl` stream.
//!
//! Logs: Docker multiplexes stdout and stderr of a container without a TTY into frames with an
//! 8-byte header (stream, three zero bytes, big-endian length); a TTY container's log is one raw
//! stream. [`LogDemux`] undoes the frames, splits lines per stream and reads the timestamp Docker
//! puts first on each line (`timestamps=1`).

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx, rpc};
use futures_util::future::join_all;
use hyper::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::stream::{LineSplitter, Lines, pump};
use super::{DockerClient, TOOL};
use crate::core::{Hub, ToolError, ToolResult};

/// The Compose labels a container carries (`docker compose` sets them).
pub const PROJECT_LABEL: &str = "com.docker.compose.project";
pub const SERVICE_LABEL: &str = "com.docker.compose.service";
pub const WORKING_DIR_LABEL: &str = "com.docker.compose.project.working_dir";
pub const CONFIG_FILES_LABEL: &str = "com.docker.compose.project.config_files";

/// The longest log line kept whole; longer ones arrive in pieces of this size.
pub const MAX_LOG_LINE: usize = 64 * 1024;

/// The longest stop or restart grace period a call may ask for.
pub const MAX_STOP_TIMEOUT_SEC: u32 = 600;

/// Containers one action may name.
pub const MAX_IDS: usize = 200;

// ---- Wire types -------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersListInput {
    pub conn_id: String,
    /// Stopped containers too; `true` when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub all: Option<bool>,
}

/// A published or exposed port of a container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPort {
    pub private_port: u16,
    /// `tcp`, `udp` or `sctp`.
    pub protocol: String,
    /// The host address of a published port (`0.0.0.0`, `::`, `127.0.0.1`).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub public_port: Option<u16>,
}

/// One row of the Containers table (`GET /containers/json`).
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRow {
    /// The full 64-character id.
    pub id: String,
    /// The first name, without Docker's leading `/`.
    pub name: String,
    pub image: String,
    pub image_id: String,
    pub command: String,
    /// Unix time in seconds.
    pub created: i64,
    /// `created`, `running`, `paused`, `restarting`, `removing`, `exited` or `dead`.
    pub state: String,
    /// Docker's sentence: `Up 3 hours (healthy)`, `Exited (137) 2 days ago`.
    pub status: String,
    /// `healthy`, `unhealthy` or `starting`, from the status.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub health: Option<String>,
    /// The exit code of an exited container, from the status.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i32>,
    pub ports: Vec<ContainerPort>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub service: Option<String>,
    pub labels: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerIdInput {
    pub conn_id: String,
    /// The container's id, short id or name.
    pub id: String,
}

/// An environment variable of the container's configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EnvVar {
    pub name: String,
    pub value: String,
}

/// A mount: a volume, a bind or a tmpfs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMount {
    /// `volume`, `bind`, `tmpfs`, ...
    pub kind: String,
    /// The volume's name.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub source: String,
    pub destination: String,
    pub read_write: bool,
}

/// A network the container is attached to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerNetwork {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ip_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ipv6_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gateway: Option<String>,
    pub aliases: Vec<String>,
}

/// A port of the container and where it is published.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    /// `8000/tcp`.
    pub port: String,
    /// `127.0.0.1:8080`, `[::]:8080`; empty when the port is only exposed.
    pub published: Vec<String>,
}

/// One run of the health check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HealthResult {
    pub start: String,
    pub end: String,
    pub exit_code: i64,
    pub output: String,
}

/// The container's health check and its last results.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerHealth {
    /// `healthy`, `unhealthy`, `starting` or `none`.
    pub status: String,
    pub failing_streak: u32,
    /// The check's command (`Config.Healthcheck.Test`), e.g. `["CMD-SHELL", "curl -f ..."]`.
    pub test: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub interval_sec: Option<f64>,
    /// Oldest first, as Docker keeps them (the last five).
    pub log: Vec<HealthResult>,
}

/// What the Overview shows, read from `docker inspect` (spec §10.4).
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerOverview {
    pub id: String,
    pub name: String,
    pub image: String,
    pub image_id: String,
    /// RFC 3339.
    pub created: String,
    pub state: String,
    pub running: bool,
    pub paused: bool,
    pub restarting: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub finished_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub exit_code: Option<i64>,
    /// Why the container failed to start, as Docker says it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    pub oom_killed: bool,
    pub restart_count: u32,
    /// `no`, `always`, `unless-stopped`, `on-failure:3`.
    pub restart_policy: String,
    pub command: Vec<String>,
    pub entrypoint: Vec<String>,
    pub working_dir: String,
    pub user: String,
    pub tty: bool,
    pub env: Vec<EnvVar>,
    pub labels: BTreeMap<String, String>,
    pub mounts: Vec<ContainerMount>,
    pub networks: Vec<ContainerNetwork>,
    pub ports: Vec<PortBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub health: Option<ContainerHealth>,
    /// The CPU limit in CPUs (`HostConfig.NanoCpus`), when one is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cpus: Option<f64>,
    /// The memory limit in bytes, when one is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub memory_limit: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub service: Option<String>,
}

/// `docker.containers.inspect`: the Overview's facts and the raw answer for Inspect.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerInspectOutput {
    pub overview: ContainerOverview,
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub inspect: Value,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersActionInput {
    pub conn_id: String,
    pub ids: Vec<String>,
    /// Seconds to wait for a stop before killing; Docker's default (10) when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub timeout_sec: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersRemoveInput {
    pub conn_id: String,
    pub ids: Vec<String>,
    /// Kill a running container first.
    pub force: bool,
    /// Remove its anonymous volumes too (named volumes stay).
    pub volumes: bool,
}

/// What an action did to one container.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerActionResult {
    pub id: String,
    /// Docker's reason when it refused; absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersLogsInput {
    pub conn_id: String,
    pub id: String,
    /// Keep the stream open for new lines.
    pub follow: bool,
    /// The last lines only; the whole log when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tail: Option<u32>,
    /// Lines from this time on: RFC 3339 (a line's `ts`) or Unix seconds (`1732093201.5`).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub since: Option<String>,
    pub stream_id: String,
}

/// Which stream a log line came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum LogStream {
    Stdout,
    Stderr,
}

/// One line of `docker.containers.logs` (`jsonl`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    /// Docker's timestamp, RFC 3339 with nanoseconds; empty for a piece of a cut long line.
    pub ts: String,
    pub stream: LogStream,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainersLogsSummary {
    pub lines: u64,
    /// The container has a TTY: one stream, everything on stdout.
    pub tty: bool,
    /// `end`: the log ended (not following, or the container stopped).
    pub end_reason: String,
}

// ---- Reading Docker's answers -----------------------------------------------------------------

pub(super) fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

pub(super) fn non_empty(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

pub(super) fn strings(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        Some(Value::String(s)) if !s.is_empty() => vec![s.clone()],
        _ => Vec::new(),
    }
}

pub(super) fn labels(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
        .collect()
}

/// `healthy` in `Up 3 hours (healthy)`; `starting` in `(health: starting)`.
pub fn health_of(status: &str) -> Option<String> {
    for word in ["unhealthy", "healthy", "health: starting"] {
        if status.contains(&format!("({word})")) {
            return Some(word.trim_start_matches("health: ").to_owned());
        }
    }
    None
}

/// `137` in `Exited (137) 2 days ago`.
pub fn exit_code_of(status: &str) -> Option<i32> {
    let rest = status.strip_prefix("Exited (")?;
    rest[..rest.find(')')?].parse().ok()
}

/// A row from one item of `GET /containers/json`.
pub fn container_row(item: &Value) -> ContainerRow {
    let names = strings(item.get("Names"));
    let name = names
        .first()
        .map(|n| n.trim_start_matches('/').to_owned())
        .unwrap_or_default();
    let labels = labels(item.get("Labels"));
    let status = text(item, "Status");
    let mut ports: Vec<ContainerPort> = item
        .get("Ports")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|p| ContainerPort {
            private_port: p
                .get("PrivatePort")
                .and_then(Value::as_u64)
                .map_or(0, |n| n as u16),
            protocol: non_empty(p, "Type").unwrap_or_else(|| "tcp".to_owned()),
            ip: non_empty(p, "IP"),
            public_port: p
                .get("PublicPort")
                .and_then(Value::as_u64)
                .map(|n| n as u16),
        })
        .collect();
    ports.sort_by(|a, b| {
        (a.private_port, &a.protocol, &a.ip).cmp(&(b.private_port, &b.protocol, &b.ip))
    });
    ports.dedup();
    ContainerRow {
        id: text(item, "Id"),
        name,
        image: text(item, "Image"),
        image_id: text(item, "ImageID"),
        command: text(item, "Command"),
        created: item.get("Created").and_then(Value::as_i64).unwrap_or(0),
        state: text(item, "State"),
        health: health_of(&status),
        exit_code: exit_code_of(&status),
        status,
        ports,
        project: labels.get(PROJECT_LABEL).cloned(),
        service: labels.get(SERVICE_LABEL).cloned(),
        labels,
    }
}

/// The Overview from a `GET /containers/{id}/json` answer.
pub fn overview(inspect: &Value) -> ContainerOverview {
    let empty = Value::Null;
    let state = inspect.get("State").unwrap_or(&empty);
    let config = inspect.get("Config").unwrap_or(&empty);
    let host = inspect.get("HostConfig").unwrap_or(&empty);
    let settings = inspect.get("NetworkSettings").unwrap_or(&empty);
    let labels = labels(config.get("Labels"));
    // Docker writes the zero time for "never".
    let time = |v: &Value, key: &str| non_empty(v, key).filter(|t| !t.starts_with("0001-"));
    let env = strings(config.get("Env"))
        .into_iter()
        .map(|pair| match pair.split_once('=') {
            Some((name, value)) => EnvVar {
                name: name.to_owned(),
                value: value.to_owned(),
            },
            None => EnvVar {
                name: pair,
                value: String::new(),
            },
        })
        .collect();
    let mounts = inspect
        .get("Mounts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(|m| ContainerMount {
            kind: text(m, "Type"),
            name: non_empty(m, "Name"),
            source: text(m, "Source"),
            destination: text(m, "Destination"),
            read_write: m.get("RW").and_then(Value::as_bool).unwrap_or(true),
        })
        .collect();
    let networks = settings
        .get("Networks")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(name, n)| ContainerNetwork {
            name: name.clone(),
            ip_address: non_empty(n, "IPAddress"),
            ipv6_address: non_empty(n, "GlobalIPv6Address"),
            gateway: non_empty(n, "Gateway"),
            aliases: strings(n.get("Aliases")),
        })
        .collect();
    let ports = settings
        .get("Ports")
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .map(|(port, bindings)| PortBinding {
            port: port.clone(),
            published: bindings
                .as_array()
                .into_iter()
                .flatten()
                .map(|b| {
                    let ip = text(b, "HostIp");
                    let port = text(b, "HostPort");
                    match ip.as_str() {
                        "" => port,
                        ip if ip.contains(':') => format!("[{ip}]:{port}"),
                        ip => format!("{ip}:{port}"),
                    }
                })
                .collect(),
        })
        .collect();
    let health = state.get("Health").filter(|h| h.is_object()).map(|h| {
        let check = config.get("Healthcheck").unwrap_or(&empty);
        ContainerHealth {
            status: text(h, "Status"),
            failing_streak: h
                .get("FailingStreak")
                .and_then(Value::as_u64)
                .map_or(0, |n| n as u32),
            test: strings(check.get("Test")),
            interval_sec: check
                .get("Interval")
                .and_then(Value::as_f64)
                .filter(|ns| *ns > 0.0)
                .map(|ns| ns / 1e9),
            log: h
                .get("Log")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|r| HealthResult {
                    start: text(r, "Start"),
                    end: text(r, "End"),
                    exit_code: r.get("ExitCode").and_then(Value::as_i64).unwrap_or(0),
                    output: text(r, "Output"),
                })
                .collect(),
        }
    });
    let policy = host.get("RestartPolicy").unwrap_or(&empty);
    let restart_policy = match (
        non_empty(policy, "Name").as_deref(),
        policy.get("MaximumRetryCount").and_then(Value::as_u64),
    ) {
        (None, _) => "no".to_owned(),
        (Some("on-failure"), Some(n)) if n > 0 => format!("on-failure:{n}"),
        (Some(name), _) => name.to_owned(),
    };
    let running = state.get("Running").and_then(Value::as_bool) == Some(true);
    let finished_at = time(state, "FinishedAt");
    ContainerOverview {
        id: text(inspect, "Id"),
        name: text(inspect, "Name").trim_start_matches('/').to_owned(),
        image: text(config, "Image"),
        image_id: text(inspect, "Image"),
        created: text(inspect, "Created"),
        state: text(state, "Status"),
        running,
        paused: state.get("Paused").and_then(Value::as_bool) == Some(true),
        restarting: state.get("Restarting").and_then(Value::as_bool) == Some(true),
        started_at: time(state, "StartedAt"),
        exit_code: (!running && finished_at.is_some())
            .then(|| state.get("ExitCode").and_then(Value::as_i64))
            .flatten(),
        finished_at,
        error: non_empty(state, "Error"),
        oom_killed: state.get("OOMKilled").and_then(Value::as_bool) == Some(true),
        restart_count: inspect
            .get("RestartCount")
            .and_then(Value::as_u64)
            .map_or(0, |n| n as u32),
        restart_policy,
        command: strings(config.get("Cmd")),
        entrypoint: strings(config.get("Entrypoint")),
        working_dir: text(config, "WorkingDir"),
        user: text(config, "User"),
        tty: config.get("Tty").and_then(Value::as_bool) == Some(true),
        env,
        project: labels.get(PROJECT_LABEL).cloned(),
        service: labels.get(SERVICE_LABEL).cloned(),
        labels,
        mounts,
        networks,
        ports,
        health,
        cpus: host
            .get("NanoCpus")
            .and_then(Value::as_f64)
            .filter(|n| *n > 0.0)
            .map(|n| n / 1e9),
        memory_limit: host
            .get("Memory")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0),
    }
}

/// A container named in a path: an id or a name (`[A-Za-z0-9][A-Za-z0-9_.-]*`, as Docker
/// allows), so `..` never reaches the path.
pub fn container_ref<'a>(field: &str, value: &'a str) -> Result<&'a str, ToolError> {
    let value = value.trim().trim_start_matches('/');
    let ok = value.len() <= 255
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'));
    if ok {
        Ok(value)
    } else {
        Err(ToolError::invalid(
            TOOL,
            field,
            "a container id or name (letters, digits, '_', '.', '-')",
        ))
    }
}

fn container_refs(ids: &[String]) -> Result<Vec<&str>, ToolError> {
    if ids.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "ids",
            "name at least one container",
        ));
    }
    if ids.len() > MAX_IDS {
        return Err(ToolError::invalid(
            TOOL,
            "ids",
            format!("at most {MAX_IDS} containers at once"),
        ));
    }
    ids.iter().map(|id| container_ref("ids", id)).collect()
}

/// `since` as Docker reads it: Unix seconds with a fraction.
pub fn docker_since(since: &str) -> Result<String, ToolError> {
    let since = since.trim();
    let invalid = || {
        ToolError::invalid(
            TOOL,
            "since",
            "an RFC 3339 time (2026-11-20T08:00:00Z) or Unix seconds",
        )
    };
    if since.contains('T') {
        let at = time::OffsetDateTime::parse(since, &time::format_description::well_known::Rfc3339)
            .map_err(|_| invalid())?;
        return Ok(format!("{}.{:09}", at.unix_timestamp(), at.nanosecond()));
    }
    let (secs, frac) = since.split_once('.').unwrap_or((since, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if secs.is_empty() || !digits(secs) || !digits(frac) || frac.len() > 9 {
        return Err(invalid());
    }
    Ok(since.to_owned())
}

/// Undoes Docker's log framing and splits lines per stream (see the module docs).
#[derive(Debug)]
pub struct LogDemux {
    tty: bool,
    /// Header bytes of the next frame read so far.
    header: Vec<u8>,
    /// The current frame's stream and the payload bytes still to come.
    frame: Option<(LogStream, usize)>,
    stdout: LineSplitter,
    stderr: LineSplitter,
}

impl LogDemux {
    pub fn new(tty: bool) -> LogDemux {
        LogDemux {
            tty,
            header: Vec::with_capacity(8),
            frame: None,
            stdout: LineSplitter::default(),
            stderr: LineSplitter::default(),
        }
    }

    /// Calls `line` with every complete line of `data`.
    pub fn push(&mut self, mut data: &[u8], line: &mut impl FnMut(LogStream, &[u8])) {
        if self.tty {
            self.stdout
                .push(data, MAX_LOG_LINE, |l| line(LogStream::Stdout, l));
            return;
        }
        while !data.is_empty() {
            match self.frame {
                None => {
                    let take = (8 - self.header.len()).min(data.len());
                    self.header.extend_from_slice(&data[..take]);
                    data = &data[take..];
                    if self.header.len() == 8 {
                        let stream = if self.header[0] == 2 {
                            LogStream::Stderr
                        } else {
                            LogStream::Stdout
                        };
                        let size =
                            u32::from_be_bytes(self.header[4..8].try_into().expect("four bytes"))
                                as usize;
                        self.header.clear();
                        self.frame = (size > 0).then_some((stream, size));
                    }
                }
                Some((stream, remaining)) => {
                    let take = remaining.min(data.len());
                    let splitter = match stream {
                        LogStream::Stdout => &mut self.stdout,
                        LogStream::Stderr => &mut self.stderr,
                    };
                    splitter.push(&data[..take], MAX_LOG_LINE, |l| line(stream, l));
                    data = &data[take..];
                    self.frame = (remaining > take).then_some((stream, remaining - take));
                }
            }
        }
    }

    /// The log ended: the unterminated last lines.
    pub fn finish(&mut self, line: &mut impl FnMut(LogStream, &[u8])) {
        self.stdout.finish(|l| line(LogStream::Stdout, l));
        self.stderr.finish(|l| line(LogStream::Stderr, l));
    }
}

/// A raw line with Docker's timestamp first (`2026-11-20T08:00:01.120458000Z text`).
pub fn log_line(stream: LogStream, raw: &[u8]) -> LogLine {
    let text = String::from_utf8_lossy(raw);
    let (ts, text) = match text.split_once(' ') {
        Some((ts, rest)) if looks_like_timestamp(ts) => (ts.to_owned(), rest.to_owned()),
        _ if looks_like_timestamp(&text) => (text.into_owned(), String::new()),
        _ => (String::new(), text.into_owned()),
    };
    LogLine { ts, stream, text }
}

fn looks_like_timestamp(s: &str) -> bool {
    s.len() >= 20
        && s.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[10] == b'T'
        && (s.ends_with('Z') || s[19..].contains(['+', '-']))
}

/// [`Lines`] for a container's log.
struct LogLines(LogDemux);

impl LogLines {
    fn write(chunk: &mut Vec<u8>, stream: LogStream, raw: &[u8]) {
        serde_json::to_writer(&mut *chunk, &log_line(stream, raw)).expect("a line serializes");
        chunk.push(b'\n');
    }
}

impl Lines for LogLines {
    fn feed(&mut self, data: &[u8], chunk: &mut Vec<u8>) -> u64 {
        let mut n = 0;
        self.0.push(data, &mut |stream, raw| {
            Self::write(chunk, stream, raw);
            n += 1;
        });
        n
    }

    fn finish(&mut self, chunk: &mut Vec<u8>) -> u64 {
        let mut n = 0;
        self.0.finish(&mut |stream, raw| {
            Self::write(chunk, stream, raw);
            n += 1;
        });
        n
    }
}

/// Every container of the host, stopped ones too.
pub async fn list(client: &DockerClient, all: bool) -> Result<Vec<ContainerRow>, ToolError> {
    let items: Vec<Value> = client
        .engine
        .get(&format!("/containers/json?all={}", u8::from(all)), "engine")
        .await?;
    Ok(items.iter().map(container_row).collect())
}

/// Runs `action` on every id at once; each id gets its own result. `resource` names what a 404
/// means (`container`, `volume`, `network`).
pub(super) async fn each(
    client: &DockerClient,
    ids: &[&str],
    method: Method,
    path: impl Fn(&str) -> String,
    resource: &str,
    limit: Duration,
) -> Vec<ContainerActionResult> {
    join_all(ids.iter().map(|id| {
        let path = path(id);
        let method = method.clone();
        async move {
            let error = client
                .engine
                .act(method, &path, resource, limit)
                .await
                .err()
                .map(|e| e.message);
            ContainerActionResult {
                id: (*id).to_owned(),
                error,
            }
        }
    }))
    .await
}

// ---- Procedures -------------------------------------------------------------------------------

pub struct DockerContainersApi(pub Arc<Hub>);

impl DockerContainersApi {
    fn client(&self, ctx: &Ctx, conn_id: &str) -> Result<Arc<DockerClient>, ToolError> {
        Ok(self
            .0
            .get::<DockerClient>(&ctx.session().id, TOOL, conn_id)?
            .value)
    }

    async fn stop_like(
        &self,
        ctx: &Ctx,
        input: &ContainersActionInput,
        verb: &str,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        let client = self.client(ctx, &input.conn_id)?;
        let ids = container_refs(&input.ids)?;
        if input.timeout_sec.is_some_and(|t| t > MAX_STOP_TIMEOUT_SEC) {
            return Err(ToolError::invalid(
                TOOL,
                "timeoutSec",
                format!("at most {MAX_STOP_TIMEOUT_SEC} seconds"),
            )
            .into());
        }
        let wait = input.timeout_sec.unwrap_or(10);
        let query = input
            .timeout_sec
            .map(|t| format!("?t={t}"))
            .unwrap_or_default();
        let limit = Duration::from_secs(u64::from(wait) + 30);
        Ok(each(
            &client,
            &ids,
            Method::POST,
            |id| format!("/containers/{id}/{verb}{query}"),
            "container",
            limit,
        )
        .await)
    }
}

#[rpc::router(namespace = "docker.containers")]
impl DockerContainersApi {
    /// The host's containers (stopped ones too unless `all` is false), as Docker lists them.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: ContainersListInput) -> ToolResult<Vec<ContainerRow>> {
        let client = self.client(&ctx, &input.conn_id)?;
        Ok(list(&client, input.all.unwrap_or(true)).await?)
    }

    /// `docker inspect` of one container, with the Overview's facts read from it.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn inspect(
        &self,
        ctx: Ctx,
        input: ContainerIdInput,
    ) -> ToolResult<ContainerInspectOutput> {
        let client = self.client(&ctx, &input.conn_id)?;
        let id = container_ref("id", &input.id)?;
        let inspect: Value = client
            .engine
            .get(&format!("/containers/{id}/json"), "container")
            .await?;
        Ok(ContainerInspectOutput {
            overview: overview(&inspect),
            inspect,
        })
    }

    /// Starts the containers; one result per id (a running one is left as it is).
    #[rpc::mutation(perm = "docker.write", risk = Risk::Write, timeout_default = "2m")]
    async fn start(
        &self,
        ctx: Ctx,
        input: ContainersActionInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        let client = self.client(&ctx, &input.conn_id)?;
        let ids = container_refs(&input.ids)?;
        Ok(each(
            &client,
            &ids,
            Method::POST,
            |id| format!("/containers/{id}/start"),
            "container",
            Duration::from_secs(90),
        )
        .await)
    }

    /// Stops the containers (SIGTERM, then SIGKILL after `timeoutSec`); one result per id.
    #[rpc::mutation(
        perm = "docker.write",
        risk = Risk::Write,
        timeout_default = "2m",
        timeout_max = "12m"
    )]
    async fn stop(
        &self,
        ctx: Ctx,
        input: ContainersActionInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        self.stop_like(&ctx, &input, "stop").await
    }

    /// Restarts the containers; one result per id.
    #[rpc::mutation(
        perm = "docker.write",
        risk = Risk::Write,
        timeout_default = "2m",
        timeout_max = "12m"
    )]
    async fn restart(
        &self,
        ctx: Ctx,
        input: ContainersActionInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        self.stop_like(&ctx, &input, "restart").await
    }

    /// Removes the containers, with their anonymous volumes when asked; one result per id.
    #[rpc::mutation(
        perm = "docker.destroy",
        risk = Risk::Destructive,
        timeout_default = "2m"
    )]
    async fn remove(
        &self,
        ctx: Ctx,
        input: ContainersRemoveInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        let client = self.client(&ctx, &input.conn_id)?;
        let ids = container_refs(&input.ids)?;
        let query = format!(
            "?force={}&v={}",
            u8::from(input.force),
            u8::from(input.volumes)
        );
        Ok(each(
            &client,
            &ids,
            Method::DELETE,
            |id| format!("/containers/{id}{query}"),
            "container",
            Duration::from_secs(90),
        )
        .await)
    }

    /// The container's log as `jsonl` lines ([`LogLine`]), stdout and stderr apart unless the
    /// container has a TTY; with `follow`, until the container stops or the stream is stopped.
    #[rpc::stream(perm = "docker.read", risk = Risk::Read, timeout_max = "12h")]
    async fn logs(
        &self,
        ctx: Ctx,
        input: ContainersLogsInput,
        sink: BinarySink,
    ) -> ToolResult<ContainersLogsSummary> {
        let session = ctx.session().id.clone();
        let id = container_ref("id", &input.id)?.to_owned();
        let since = input.since.as_deref().map(docker_since).transpose()?;
        let claim = self.0.claim_stream(&session, TOOL, &input.stream_id)?;
        let (handle, _busy) = self
            .0
            .busy::<DockerClient>(&session, TOOL, &input.conn_id)?;
        let inspect: Value = handle
            .value
            .engine
            .get(&format!("/containers/{id}/json"), "container")
            .await?;
        let tty = inspect
            .pointer("/Config/Tty")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut path = format!(
            "/containers/{id}/logs?stdout=1&stderr=1&timestamps=1&follow={}",
            u8::from(input.follow)
        );
        path.push_str(&match input.tail {
            Some(n) => format!("&tail={n}"),
            None => "&tail=all".to_owned(),
        });
        if let Some(since) = since {
            path.push_str(&format!("&since={since}"));
        }
        let body = handle
            .value
            .engine
            .stream(Method::GET, &path, "container")
            .await?;
        let progress = self.0.progress(&session, claim.stream_id());
        let mut lines = LogLines(LogDemux::new(tty));
        let lines = pump(&ctx, &handle.token, &sink, body, &mut lines, &progress).await?;
        Ok(ContainersLogsSummary {
            lines,
            tty,
            end_reason: "end".to_owned(),
        })
    }

    /// A running container's samples, one a second, as `jsonl` lines ([`super::stats::StatsSample`]);
    /// push-only: the latest sample replaces one not sent yet. `Conflict` when it is not running.
    #[rpc::stream(perm = "docker.read", risk = Risk::Read, timeout_max = "12h")]
    async fn stats(
        &self,
        ctx: Ctx,
        input: super::stats::ContainersStatsInput,
        sink: BinarySink,
    ) -> ToolResult<super::stats::ContainersStatsSummary> {
        super::stats::run(&self.0, &ctx, input, &sink).await
    }

    /// A process in the container on a TTY (`bytes`: channel 1, then the output); its input
    /// through `term.*` on `terminalId`. Ends with the exit code.
    #[rpc::stream(perm = "docker.write", risk = Risk::Write, timeout_max = "12h")]
    async fn exec(
        &self,
        ctx: Ctx,
        input: super::exec::ContainersExecInput,
        sink: BinarySink,
    ) -> ToolResult<super::exec::ContainersExecSummary> {
        super::exec::run(&self.0, &ctx, input, &sink).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn frame(stream: u8, payload: &[u8]) -> Vec<u8> {
        let mut out = vec![stream, 0, 0, 0];
        out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        out.extend_from_slice(payload);
        out
    }

    fn demux(tty: bool, parts: &[&[u8]]) -> Vec<(LogStream, String)> {
        let mut d = LogDemux::new(tty);
        let mut out = Vec::new();
        let mut push =
            |s: LogStream, l: &[u8]| out.push((s, String::from_utf8_lossy(l).into_owned()));
        for part in parts {
            d.push(part, &mut push);
        }
        d.finish(&mut push);
        out
    }

    #[test]
    fn frames_are_undone_per_stream_whatever_the_reads() {
        let mut bytes = frame(1, b"out one\nout ");
        bytes.extend(frame(2, b"err one\n"));
        bytes.extend(frame(1, b"two\n"));
        bytes.extend(frame(2, b"no newline"));
        let expected = vec![
            (LogStream::Stdout, "out one".to_owned()),
            (LogStream::Stderr, "err one".to_owned()),
            (LogStream::Stdout, "out two".to_owned()),
            (LogStream::Stderr, "no newline".to_owned()),
        ];
        assert_eq!(demux(false, &[&bytes]), expected);
        // One byte at a time: headers and payloads split anywhere.
        let bytes: Vec<&[u8]> = bytes.chunks(1).collect();
        assert_eq!(demux(false, &bytes), expected);
        // A TTY's log is not framed.
        assert_eq!(
            demux(true, &[b"\x1b[32mgreen\x1b[0m\r\nmore"]),
            vec![
                (LogStream::Stdout, "\x1b[32mgreen\x1b[0m".to_owned()),
                (LogStream::Stdout, "more".to_owned()),
            ]
        );
    }

    #[test]
    fn timestamps_come_off_the_line() {
        let line = log_line(
            LogStream::Stderr,
            b"2026-11-20T08:00:01.120458000Z warning 1",
        );
        assert_eq!(line.ts, "2026-11-20T08:00:01.120458000Z");
        assert_eq!(line.text, "warning 1");
        assert_eq!(line.stream, LogStream::Stderr);
        let line = log_line(LogStream::Stdout, b"2026-11-20T08:00:01Z");
        assert_eq!(
            (line.ts.as_str(), line.text.as_str()),
            ("2026-11-20T08:00:01Z", "")
        );
        let line = log_line(LogStream::Stdout, b"no time here");
        assert_eq!((line.ts.as_str(), line.text.as_str()), ("", "no time here"));
        let line = log_line(LogStream::Stdout, b"2026-11-20T08:00:01+07:00 local");
        assert_eq!(line.text, "local");
    }

    #[test]
    fn since_is_unix_seconds_for_docker() {
        assert_eq!(
            docker_since("2026-11-20T08:00:01.120458Z").unwrap(),
            "1795161601.120458000"
        );
        assert_eq!(docker_since("1795161601.5").unwrap(), "1795161601.5");
        assert_eq!(docker_since("1795161601").unwrap(), "1795161601");
        for bad in ["", "yesterday", "1.2.3", "-5", "2026-13-01T00:00:00Z"] {
            assert_eq!(
                docker_since(bad).unwrap_err().field.as_deref(),
                Some("since"),
                "{bad}"
            );
        }
    }

    #[test]
    fn container_names_cannot_leave_the_path() {
        assert_eq!(container_ref("id", "/shop-web-1").unwrap(), "shop-web-1");
        assert_eq!(container_ref("id", "4f9a2c1e7b03").unwrap(), "4f9a2c1e7b03");
        for bad in ["", "a/b", "../x", "a?b", "a b", "a%2f"] {
            assert!(container_ref("id", bad).is_err(), "{bad}");
        }
        assert!(container_refs(&[]).is_err());
    }

    #[test]
    fn a_list_item_becomes_a_row() {
        let row = container_row(&json!({
            "Id": "4f9a", "Names": ["/shop-api-1"], "Image": "ghcr.io/acme/shop-api:2.4.1",
            "ImageID": "sha256:aa", "Command": "gunicorn shop.wsgi", "Created": 1795161601,
            "State": "running", "Status": "Up 3 hours (unhealthy)",
            "Ports": [
                { "PrivatePort": 8000, "Type": "tcp" },
                { "IP": "0.0.0.0", "PrivatePort": 80, "PublicPort": 8080, "Type": "tcp" },
                { "IP": "0.0.0.0", "PrivatePort": 80, "PublicPort": 8080, "Type": "tcp" },
            ],
            "Labels": { "com.docker.compose.project": "shop", "com.docker.compose.service": "api" },
        }));
        assert_eq!(row.name, "shop-api-1");
        assert_eq!(row.health.as_deref(), Some("unhealthy"));
        assert_eq!(row.exit_code, None);
        assert_eq!(row.project.as_deref(), Some("shop"));
        assert_eq!(row.service.as_deref(), Some("api"));
        assert_eq!(row.ports.len(), 2);
        assert_eq!(row.ports[0].public_port, Some(8080));
        assert_eq!(exit_code_of("Exited (137) 2 days ago"), Some(137));
        assert_eq!(
            health_of("Up 2 seconds (health: starting)").as_deref(),
            Some("starting")
        );
        assert_eq!(
            health_of("Up 3 hours (healthy)").as_deref(),
            Some("healthy")
        );
    }

    #[test]
    fn inspect_gives_the_overview() {
        let o = overview(&json!({
            "Id": "4f9a", "Name": "/shop-api-1", "Created": "2026-11-18T07:12:08Z",
            "Image": "sha256:aa", "RestartCount": 2,
            "State": {
                "Status": "exited", "Running": false, "Paused": false, "Restarting": false,
                "ExitCode": 3, "StartedAt": "2026-11-18T07:12:09Z",
                "FinishedAt": "2026-11-18T07:13:00Z", "Error": "", "OOMKilled": false,
                "Health": { "Status": "unhealthy", "FailingStreak": 3, "Log": [
                    { "Start": "a", "End": "b", "ExitCode": 1, "Output": "timeout" }
                ] },
            },
            "Config": {
                "Image": "ghcr.io/acme/shop-api:2.4.1", "Cmd": ["gunicorn", "shop.wsgi"],
                "Entrypoint": null, "WorkingDir": "/app", "User": "app", "Tty": false,
                "Env": ["LOG_LEVEL=info", "EMPTY=", "BARE"],
                "Labels": { "com.docker.compose.project": "shop" },
                "Healthcheck": { "Test": ["CMD-SHELL", "curl -f localhost"], "Interval": 10_000_000_000u64 },
            },
            "HostConfig": { "RestartPolicy": { "Name": "on-failure", "MaximumRetryCount": 3 },
                            "NanoCpus": 2_000_000_000u64, "Memory": 0 },
            "Mounts": [{ "Type": "volume", "Name": "shop_media", "Source": "/var/lib/docker/volumes/shop_media/_data",
                         "Destination": "/app/media", "RW": true }],
            "NetworkSettings": {
                "Networks": { "shop_default": { "IPAddress": "172.20.0.4", "Gateway": "172.20.0.1", "Aliases": ["api"] } },
                "Ports": { "8000/tcp": null, "80/tcp": [{ "HostIp": "0.0.0.0", "HostPort": "8080" }, { "HostIp": "::", "HostPort": "8080" }] },
            },
        }));
        assert_eq!(o.name, "shop-api-1");
        assert_eq!(o.exit_code, Some(3));
        assert_eq!(o.restart_policy, "on-failure:3");
        assert_eq!(o.entrypoint, Vec::<String>::new());
        assert_eq!(o.env.len(), 3);
        assert_eq!(
            o.env[1],
            EnvVar {
                name: "EMPTY".into(),
                value: String::new()
            }
        );
        assert_eq!(o.env[2].name, "BARE");
        assert_eq!(o.cpus, Some(2.0));
        assert_eq!(o.memory_limit, None);
        assert_eq!(o.project.as_deref(), Some("shop"));
        let health = o.health.unwrap();
        assert_eq!(health.interval_sec, Some(10.0));
        assert_eq!(health.log[0].output, "timeout");
        let published: Vec<&str> = o
            .ports
            .iter()
            .flat_map(|p| p.published.iter().map(String::as_str))
            .collect();
        assert_eq!(published, ["0.0.0.0:8080", "[::]:8080"]);
        assert_eq!(o.networks[0].ip_address.as_deref(), Some("172.20.0.4"));
    }
}
