//! `docker.events` and `docker.compose.projects` (Mightyconsole spec §10.6): the host's events
//! as a `jsonl` stream, which keeps the lists live without polling, and the Compose projects
//! read from the containers' `com.docker.compose.*` labels.

use std::collections::BTreeMap;
use std::sync::Arc;

use ambidex::{BinarySink, Ctx, rpc};
use hyper::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

use super::containers::{
    CONFIG_FILES_LABEL, ContainerRow, WORKING_DIR_LABEL, container_ref, docker_since, list,
};
use super::stream::{LineSplitter, Lines, pump};
use super::{DockerClient, DockerConnIdInput, TOOL};
use crate::core::{Empty, Hub, ToolError, ToolResult};

/// The kinds of objects whose events the lists use.
pub const EVENT_TYPES: &[&str] = &["container", "image", "volume", "network"];

/// The longest event line read; Docker's are a few hundred bytes.
const MAX_EVENT_LINE: usize = 256 * 1024;

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerEventsInput {
    pub conn_id: String,
    pub stream_id: String,
    /// Some of `container`, `image`, `volume`, `network`; all four when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub types: Option<Vec<String>>,
    /// Only this container's events (its id or name).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub container: Option<String>,
    /// Events from this time on (RFC 3339 or Unix seconds), to resume after a reconnect; only
    /// new ones when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub since: Option<String>,
}

/// One line of `docker.events` (`jsonl`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerEvent {
    /// `container`, `image`, `volume`, `network`.
    pub kind: String,
    /// `start`, `die`, `destroy`, `health_status: unhealthy`, `exec_start: sh`, ...
    pub action: String,
    /// The object's id (an image's reference, a volume's name).
    pub id: String,
    /// The object's name when Docker gives one.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    pub attributes: BTreeMap<String, String>,
    /// Unix time in milliseconds.
    pub time_ms: u64,
}

/// An event from one JSON object of `GET /events`.
pub fn event(value: &Value) -> Option<DockerEvent> {
    let kind = value.get("Type").and_then(Value::as_str)?.to_owned();
    let action = value.get("Action").and_then(Value::as_str)?.to_owned();
    let actor = value.get("Actor");
    let attributes: BTreeMap<String, String> = actor
        .and_then(|a| a.get("Attributes"))
        .and_then(Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_owned())))
        .collect();
    let time_ms = value
        .get("timeNano")
        .and_then(Value::as_u64)
        .map(|ns| ns / 1_000_000)
        .or_else(|| value.get("time").and_then(Value::as_u64).map(|s| s * 1000))
        .unwrap_or(0);
    Some(DockerEvent {
        kind,
        action,
        id: actor
            .and_then(|a| a.get("ID"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        name: attributes.get("name").cloned(),
        attributes,
        time_ms,
    })
}

/// The `filters` query of `GET /events`, URL-encoded.
pub fn events_query(types: &[&str], container: Option<&str>, since: Option<&str>) -> String {
    let mut filters = json!({ "type": types });
    if let Some(container) = container {
        filters["container"] = json!([container]);
    }
    let encoded: String =
        url::form_urlencoded::byte_serialize(filters.to_string().as_bytes()).collect();
    match since {
        Some(since) => format!("?since={since}&filters={encoded}"),
        None => format!("?filters={encoded}"),
    }
}

/// [`Lines`] for the events stream: one JSON object per line in, one [`DockerEvent`] out.
#[derive(Default)]
struct EventLines(LineSplitter);

impl EventLines {
    fn write(chunk: &mut Vec<u8>, raw: &[u8], n: &mut u64) {
        let Some(event) = serde_json::from_slice::<Value>(raw)
            .ok()
            .as_ref()
            .and_then(event)
        else {
            return;
        };
        serde_json::to_writer(&mut *chunk, &event).expect("an event serializes");
        chunk.push(b'\n');
        *n += 1;
    }
}

impl Lines for EventLines {
    fn feed(&mut self, data: &[u8], chunk: &mut Vec<u8>) -> u64 {
        let mut n = 0;
        self.0
            .push(data, MAX_EVENT_LINE, |raw| Self::write(chunk, raw, &mut n));
        n
    }

    fn finish(&mut self, chunk: &mut Vec<u8>) -> u64 {
        let mut n = 0;
        self.0.finish(|raw| Self::write(chunk, raw, &mut n));
        n
    }
}

/// A Compose service and its containers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposeService {
    pub service: String,
    /// The containers' names.
    pub containers: Vec<String>,
}

/// A Compose project as its containers' labels describe it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    pub project: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub working_dir: Option<String>,
    /// The compose files, comma-separated as Compose writes them.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub config_files: Option<String>,
    pub services: Vec<ComposeService>,
}

/// The projects of `rows`, by name, their services by name.
/// A project's working dir, config files and containers by service, while grouping.
#[derive(Default)]
struct ProjectAcc {
    working_dir: Option<String>,
    config_files: Option<String>,
    services: BTreeMap<String, Vec<String>>,
}

pub fn projects(rows: &[ContainerRow]) -> Vec<ComposeProject> {
    let mut by_project: BTreeMap<&str, ProjectAcc> = BTreeMap::new();
    for row in rows {
        let Some(project) = row.project.as_deref() else {
            continue;
        };
        let entry = by_project.entry(project).or_default();
        entry.working_dir = entry
            .working_dir
            .take()
            .or_else(|| row.labels.get(WORKING_DIR_LABEL).cloned());
        entry.config_files = entry
            .config_files
            .take()
            .or_else(|| row.labels.get(CONFIG_FILES_LABEL).cloned());
        entry
            .services
            .entry(row.service.clone().unwrap_or_default())
            .or_default()
            .push(row.name.clone());
    }
    by_project
        .into_iter()
        .map(|(project, acc)| ComposeProject {
            project: project.to_owned(),
            working_dir: acc.working_dir,
            config_files: acc.config_files,
            services: acc
                .services
                .into_iter()
                .map(|(service, mut containers)| {
                    containers.sort();
                    ComposeService {
                        service,
                        containers,
                    }
                })
                .collect(),
        })
        .collect()
}

/// `docker.events`: see [`DockerApi`](super::DockerApi).
pub async fn run(
    hub: &Arc<Hub>,
    ctx: &Ctx,
    input: DockerEventsInput,
    sink: &BinarySink,
) -> ToolResult<Empty> {
    let session = ctx.session().id.clone();
    let types: Vec<&str> = match &input.types {
        None => EVENT_TYPES.to_vec(),
        Some(types) => types
            .iter()
            .map(|t| {
                EVENT_TYPES
                    .iter()
                    .find(|known| **known == t.as_str())
                    .copied()
                    .ok_or_else(|| {
                        ToolError::invalid(TOOL, "types", "container, image, volume or network")
                    })
            })
            .collect::<Result<_, _>>()?,
    };
    let container = input
        .container
        .as_deref()
        .map(|c| container_ref("container", c))
        .transpose()?;
    let since = input.since.as_deref().map(docker_since).transpose()?;
    let claim = hub.claim_stream(&session, TOOL, &input.stream_id)?;
    let (handle, _busy) = hub.busy::<DockerClient>(&session, TOOL, &input.conn_id)?;
    let body = handle
        .value
        .engine
        .stream(
            Method::GET,
            &format!(
                "/events{}",
                events_query(&types, container, since.as_deref())
            ),
            "engine",
        )
        .await?;
    let progress = hub.progress(&session, claim.stream_id());
    pump(
        ctx,
        &handle.token,
        sink,
        body,
        &mut EventLines::default(),
        &progress,
    )
    .await?;
    Ok(Empty {})
}

pub struct DockerComposeApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker.compose")]
impl DockerComposeApi {
    /// The Compose projects of the host's containers, stopped ones too.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn projects(
        &self,
        ctx: Ctx,
        input: DockerConnIdInput,
    ) -> ToolResult<Vec<ComposeProject>> {
        let handle = self
            .0
            .get::<DockerClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        Ok(projects(&list(&handle.value, true).await?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::docker::containers::container_row;

    #[test]
    fn an_event_keeps_what_the_lists_need() {
        let e = event(&json!({
            "Type": "container", "Action": "health_status: unhealthy",
            "Actor": { "ID": "4f9a", "Attributes": { "name": "shop-api-1", "image": "x" } },
            "time": 1795161601, "timeNano": 1_795_161_601_120_458_000u64,
        }))
        .unwrap();
        assert_eq!(e.kind, "container");
        assert_eq!(e.name.as_deref(), Some("shop-api-1"));
        assert_eq!(e.time_ms, 1_795_161_601_120);
        assert!(event(&json!({ "status": "old format" })).is_none());
    }

    #[test]
    fn the_filters_are_encoded() {
        let q = events_query(&["container"], Some("web"), Some("17"));
        assert_eq!(
            q,
            "?since=17&filters=%7B%22container%22%3A%5B%22web%22%5D%2C%22type%22%3A%5B%22container%22%5D%7D"
        );
    }

    #[test]
    fn projects_come_from_labels() {
        let row = |name: &str, project: Option<&str>, service: &str| {
            let mut labels = serde_json::Map::new();
            if let Some(p) = project {
                labels.insert("com.docker.compose.project".into(), p.into());
                labels.insert("com.docker.compose.service".into(), service.into());
                labels.insert(WORKING_DIR_LABEL.into(), "/srv/shop".into());
            }
            container_row(&json!({ "Id": name, "Names": [format!("/{name}")], "Labels": labels }))
        };
        let rows = vec![
            row("shop-web-1", Some("shop"), "web"),
            row("shop-api-2", Some("shop"), "api"),
            row("shop-api-1", Some("shop"), "api"),
            row("lonely", None, ""),
        ];
        let p = projects(&rows);
        assert_eq!(p.len(), 1);
        assert_eq!(p[0].working_dir.as_deref(), Some("/srv/shop"));
        assert_eq!(p[0].services[0].service, "api");
        assert_eq!(p[0].services[0].containers, ["shop-api-1", "shop-api-2"]);
    }
}
