//! `docker.images.*`, `docker.volumes.*` and `docker.networks.*` (Mightyconsole spec §10.4 to
//! §10.6, TSK-81 batch 3): the lists with what uses each item, `docker inspect` of one, and
//! remove. Pull, prune, and Compose up and down are later (DOC-20).
//!
//! "Used by" comes from the containers, stopped ones too (`GET /containers/json?all=1`): their
//! image id, their volume mounts and their networks. A volume's size comes from `/system/df`;
//! when Docker cannot say (an old engine, a slow disk), the list still answers without sizes.
//!
//! Removing is left to Docker's own checks: it refuses an image a running container uses, a
//! volume any container uses and the predefined networks, and its reason goes back per item.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use ambidex::{Ctx, rpc};
use hyper::Method;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::containers::{
    ContainerActionResult, PROJECT_LABEL, each, labels, non_empty, strings, text,
};
use super::{DockerClient, TOOL};
use crate::core::{Hub, ToolError, ToolResult};

/// Networks every engine has; Docker refuses to remove them.
pub const BUILT_IN_NETWORKS: &[&str] = &["bridge", "host", "none"];

/// Items one remove may name.
pub const MAX_ITEMS: usize = 200;

// ---- Wire types -------------------------------------------------------------------------------

/// A container that uses an image, a volume or a network.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ContainerUse {
    pub name: String,
    /// `running`, `exited`, ...
    pub state: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImagesListInput {
    pub conn_id: String,
}

/// One image of `GET /images/json`; the table shows a row per tag.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageRow {
    /// `sha256:…`.
    pub id: String,
    /// `busybox:1.37`; empty for a dangling image.
    pub repo_tags: Vec<String>,
    /// `busybox@sha256:…`.
    pub repo_digests: Vec<String>,
    /// Unix time in seconds.
    pub created: i64,
    /// Bytes, its shared layers included.
    pub size: u64,
    /// Neither a tag nor a digest names it (Docker's `dangling=true`); an image pulled by
    /// digest only is not dangling.
    pub dangling: bool,
    pub labels: BTreeMap<String, String>,
    /// Containers made from it, stopped ones too.
    pub used_by: Vec<ContainerUse>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageRefInput {
    pub conn_id: String,
    /// An id (`sha256:…` or short) or a reference (`busybox:1.37`, `registry.lan:5000/a/b:1`).
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImagesRemoveInput {
    pub conn_id: String,
    /// Ids or references; a reference removes that tag, and the image with its last tag.
    pub ids: Vec<String>,
    /// Remove an image other tags point at, or one stopped containers use; never one a running
    /// container uses (Docker refuses).
    pub force: bool,
}

/// What removing one image or tag did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ImageRemoveResult {
    pub id: String,
    /// Tags taken off.
    pub untagged: Vec<String>,
    /// Image and layer ids deleted.
    pub deleted: Vec<String>,
    /// Docker's reason when it refused; absent on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// `docker inspect` of an image, a volume or a network.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectOutput {
    #[ts(type = "Record<string, unknown>")]
    #[schemars(with = "Map<String, Value>")]
    pub inspect: Value,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumesListInput {
    pub conn_id: String,
}

/// One volume of `GET /volumes`.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumeRow {
    pub name: String,
    pub driver: String,
    /// `local` or `global`.
    pub scope: String,
    pub mountpoint: String,
    /// RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created_at: Option<String>,
    pub labels: BTreeMap<String, String>,
    /// The Compose project that made it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    /// Bytes on disk, from `/system/df`; absent when Docker did not say.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size: Option<u64>,
    /// Containers that mount it, stopped ones too.
    pub used_by: Vec<ContainerUse>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumesListOutput {
    pub volumes: Vec<VolumeRow>,
    /// Why there are no sizes, when `/system/df` failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub size_error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumeNameInput {
    pub conn_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct VolumesRemoveInput {
    pub conn_id: String,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworksListInput {
    pub conn_id: String,
}

/// A subnet of a network's IPAM configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSubnet {
    /// `172.18.0.0/16`, `fd00::/64`.
    pub subnet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gateway: Option<String>,
}

/// One network of `GET /networks`.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworkRow {
    pub id: String,
    pub name: String,
    /// `bridge`, `host`, `null`, `overlay`, `macvlan`, ...
    pub driver: String,
    /// `local`, `swarm` or `global`.
    pub scope: String,
    pub internal: bool,
    pub attachable: bool,
    pub ipv6: bool,
    pub subnets: Vec<NetworkSubnet>,
    /// RFC 3339.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub created: Option<String>,
    pub labels: BTreeMap<String, String>,
    /// The Compose project that made it.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub project: Option<String>,
    /// `bridge`, `host` or `none`: every engine has it and it cannot be removed.
    pub built_in: bool,
    /// Containers attached to it, stopped ones too.
    pub used_by: Vec<ContainerUse>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworkIdInput {
    pub conn_id: String,
    /// The network's id or name.
    pub id: String,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct NetworksRemoveInput {
    pub conn_id: String,
    pub ids: Vec<String>,
}

// ---- Reading Docker's answers -----------------------------------------------------------------

/// What the containers use, keyed by image id, volume name and network id.
#[derive(Debug, Default)]
pub struct Uses {
    pub images: HashMap<String, Vec<ContainerUse>>,
    pub volumes: HashMap<String, Vec<ContainerUse>>,
    pub networks: HashMap<String, Vec<ContainerUse>>,
}

impl Uses {
    /// From the items of `GET /containers/json?all=1`.
    pub fn of(containers: &[Value]) -> Uses {
        let mut uses = Uses::default();
        for c in containers {
            let name = strings(c.get("Names"))
                .first()
                .map(|n| n.trim_start_matches('/').to_owned())
                .unwrap_or_else(|| text(c, "Id"));
            let state = text(c, "State");
            let usage = || ContainerUse {
                name: name.clone(),
                state: state.clone(),
            };
            if let Some(image) = non_empty(c, "ImageID") {
                uses.images.entry(image).or_default().push(usage());
            }
            for m in c
                .get("Mounts")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if text(m, "Type") == "volume"
                    && let Some(volume) = non_empty(m, "Name")
                {
                    uses.volumes.entry(volume).or_default().push(usage());
                }
            }
            let networks = c
                .pointer("/NetworkSettings/Networks")
                .and_then(Value::as_object);
            for (network, n) in networks.into_iter().flatten() {
                // Older engines leave the id empty for a stopped container: the name is the key.
                let key = non_empty(n, "NetworkID").unwrap_or_else(|| network.clone());
                uses.networks.entry(key).or_default().push(usage());
            }
        }
        for list in uses
            .images
            .values_mut()
            .chain(uses.volumes.values_mut())
            .chain(uses.networks.values_mut())
        {
            // Running ones first, then by name.
            list.sort_by(|a, b| {
                (a.state != "running", &a.name).cmp(&(b.state != "running", &b.name))
            });
            list.dedup();
        }
        uses
    }

    fn take(map: &HashMap<String, Vec<ContainerUse>>, key: &str) -> Vec<ContainerUse> {
        map.get(key).cloned().unwrap_or_default()
    }
}

/// A row from one item of `GET /images/json`.
pub fn image_row(item: &Value, uses: &Uses) -> ImageRow {
    // Docker writes `<none>:<none>` and `<none>@<none>` for what an image does not have.
    let repo_tags: Vec<String> = strings(item.get("RepoTags"))
        .into_iter()
        .filter(|t| !t.starts_with("<none>"))
        .collect();
    let repo_digests: Vec<String> = strings(item.get("RepoDigests"))
        .into_iter()
        .filter(|t| !t.starts_with("<none>"))
        .collect();
    let id = text(item, "Id");
    ImageRow {
        dangling: repo_tags.is_empty() && repo_digests.is_empty(),
        used_by: Uses::take(&uses.images, &id),
        id,
        repo_tags,
        repo_digests,
        created: item.get("Created").and_then(Value::as_i64).unwrap_or(0),
        size: item.get("Size").and_then(Value::as_u64).unwrap_or(0),
        labels: labels(item.get("Labels")),
    }
}

/// A row from one item of `GET /volumes`, its size from `/system/df` when known.
pub fn volume_row(item: &Value, uses: &Uses, sizes: &HashMap<String, u64>) -> VolumeRow {
    let name = text(item, "Name");
    let labels = labels(item.get("Labels"));
    VolumeRow {
        driver: text(item, "Driver"),
        scope: text(item, "Scope"),
        mountpoint: text(item, "Mountpoint"),
        created_at: non_empty(item, "CreatedAt"),
        project: labels.get(PROJECT_LABEL).cloned(),
        labels,
        size: sizes.get(&name).copied(),
        used_by: Uses::take(&uses.volumes, &name),
        name,
    }
}

/// Volume sizes from a `/system/df` answer; Docker writes -1 for "not computed".
pub fn volume_sizes(df: &Value) -> HashMap<String, u64> {
    df.get("Volumes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|v| {
            let size = v.pointer("/UsageData/Size").and_then(Value::as_i64)?;
            Some((text(v, "Name"), u64::try_from(size).ok()?))
        })
        .collect()
}

/// A row from one item of `GET /networks`.
pub fn network_row(item: &Value, uses: &Uses) -> NetworkRow {
    let id = text(item, "Id");
    let name = text(item, "Name");
    let labels = labels(item.get("Labels"));
    let subnets = item
        .pointer("/IPAM/Config")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|c| {
            Some(NetworkSubnet {
                subnet: non_empty(c, "Subnet")?,
                gateway: non_empty(c, "Gateway"),
            })
        })
        .collect();
    let mut used_by = Uses::take(&uses.networks, &id);
    if used_by.is_empty() {
        used_by = Uses::take(&uses.networks, &name);
    }
    let flag = |key: &str| item.get(key).and_then(Value::as_bool) == Some(true);
    NetworkRow {
        driver: text(item, "Driver"),
        scope: text(item, "Scope"),
        internal: flag("Internal"),
        attachable: flag("Attachable"),
        ipv6: flag("EnableIPv6"),
        subnets,
        created: non_empty(item, "Created").filter(|t| !t.starts_with("0001-")),
        project: labels.get(PROJECT_LABEL).cloned(),
        labels,
        built_in: BUILT_IN_NETWORKS.contains(&name.as_str()),
        used_by,
        id,
        name,
    }
}

/// A volume or network named in a path: `[A-Za-z0-9][A-Za-z0-9_.-]*`, as Docker allows.
pub fn name_ref<'a>(field: &str, value: &'a str, what: &str) -> Result<&'a str, ToolError> {
    let value = value.trim();
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
            format!("a {what} id or name (letters, digits, '_', '.', '-')"),
        ))
    }
}

/// An image named in a path: an id or a reference (`registry.lan:5000/shop/api:1.4`,
/// `busybox@sha256:…`). No `..`, no empty path segment.
pub fn image_ref<'a>(field: &str, value: &'a str) -> Result<&'a str, ToolError> {
    let value = value.trim();
    let ok = value.len() <= 512
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-' | b'/' | b':' | b'@')
        })
        && !value.contains("..")
        && !value.contains("//")
        && !value.ends_with('/');
    if ok {
        Ok(value)
    } else {
        Err(ToolError::invalid(
            TOOL,
            field,
            "an image id or reference (registry/repository:tag or @digest)",
        ))
    }
}

fn many<'a>(
    field: &str,
    values: &'a [String],
    what: &str,
    one: impl Fn(&'a str) -> Result<&'a str, ToolError>,
) -> Result<Vec<&'a str>, ToolError> {
    if values.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("name at least one {what}"),
        ));
    }
    if values.len() > MAX_ITEMS {
        return Err(ToolError::invalid(
            TOOL,
            field,
            format!("at most {MAX_ITEMS} at once"),
        ));
    }
    values.iter().map(|v| one(v)).collect()
}

/// The answer of `DELETE /images/{name}`: `[{ "Untagged": … }, { "Deleted": … }]`.
pub fn image_removal(id: &str, answer: &Value) -> ImageRemoveResult {
    let items = answer.as_array().map(Vec::as_slice).unwrap_or_default();
    let pick = |key: &str| {
        items
            .iter()
            .filter_map(|i| non_empty(i, key))
            .collect::<Vec<_>>()
    };
    ImageRemoveResult {
        id: id.to_owned(),
        untagged: pick("Untagged"),
        deleted: pick("Deleted"),
        error: None,
    }
}

async fn containers(client: &DockerClient) -> Result<Vec<Value>, ToolError> {
    client.engine.get("/containers/json?all=1", "engine").await
}

// ---- Procedures -------------------------------------------------------------------------------

fn client(hub: &Hub, ctx: &Ctx, conn_id: &str) -> Result<Arc<DockerClient>, ToolError> {
    Ok(hub
        .get::<DockerClient>(&ctx.session().id, TOOL, conn_id)?
        .value)
}

pub struct DockerImagesApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker.images")]
impl DockerImagesApi {
    /// The host's images (dangling ones too) with the containers made from each.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: ImagesListInput) -> ToolResult<Vec<ImageRow>> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let (images, containers) = tokio::try_join!(
            client.engine.get::<Vec<Value>>("/images/json", "engine"),
            containers(&client),
        )?;
        let uses = Uses::of(&containers);
        Ok(images.iter().map(|i| image_row(i, &uses)).collect())
    }

    /// `docker image inspect` of one image.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn inspect(&self, ctx: Ctx, input: ImageRefInput) -> ToolResult<InspectOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let id = image_ref("id", &input.id)?;
        let inspect = client
            .engine
            .get(&format!("/images/{id}/json"), "image")
            .await?;
        Ok(InspectOutput { inspect })
    }

    /// Removes the images or tags one after the other (two tags of one image would race);
    /// one result per id with what went.
    #[rpc::mutation(
        perm = "docker.destroy",
        risk = Risk::Destructive,
        timeout_default = "2m"
    )]
    async fn remove(
        &self,
        ctx: Ctx,
        input: ImagesRemoveInput,
    ) -> ToolResult<Vec<ImageRemoveResult>> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let ids = many("ids", &input.ids, "image", |v| image_ref("ids", v))?;
        let mut results = Vec::with_capacity(ids.len());
        for id in ids {
            let path = format!("/images/{id}?force={}", u8::from(input.force));
            let result = match client
                .engine
                .call::<Value>(Method::DELETE, &path, None, "image")
                .await
            {
                Ok(answer) => image_removal(id, &answer),
                Err(e) => ImageRemoveResult {
                    id: id.to_owned(),
                    untagged: Vec::new(),
                    deleted: Vec::new(),
                    error: Some(e.message),
                },
            };
            results.push(result);
        }
        Ok(results)
    }
}

pub struct DockerVolumesApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker.volumes")]
impl DockerVolumesApi {
    /// The host's volumes with their size (from `/system/df`) and the containers that mount
    /// each; without sizes when Docker cannot say.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: VolumesListInput) -> ToolResult<VolumesListOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let (volumes, containers, df) = tokio::join!(
            client.engine.get::<Value>("/volumes", "engine"),
            containers(&client),
            client
                .engine
                .get::<Value>("/system/df?type=volume", "engine"),
        );
        let (volumes, containers) = (volumes?, containers?);
        let uses = Uses::of(&containers);
        let (sizes, size_error) = match df {
            Ok(df) => (volume_sizes(&df), None),
            Err(e) => (HashMap::new(), Some(e.message)),
        };
        let volumes = volumes
            .get("Volumes")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|v| volume_row(v, &uses, &sizes))
            .collect();
        Ok(VolumesListOutput {
            volumes,
            size_error,
        })
    }

    /// `docker volume inspect` of one volume.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn inspect(&self, ctx: Ctx, input: VolumeNameInput) -> ToolResult<InspectOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let name = name_ref("name", &input.name, "volume")?;
        let inspect = client
            .engine
            .get(&format!("/volumes/{name}"), "volume")
            .await?;
        Ok(InspectOutput { inspect })
    }

    /// Removes the volumes and their data; Docker refuses one a container uses. One result per
    /// name.
    #[rpc::mutation(
        perm = "docker.destroy",
        risk = Risk::Destructive,
        timeout_default = "2m"
    )]
    async fn remove(
        &self,
        ctx: Ctx,
        input: VolumesRemoveInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let names = many("names", &input.names, "volume", |v| {
            name_ref("names", v, "volume")
        })?;
        Ok(each(
            &client,
            &names,
            Method::DELETE,
            |name| format!("/volumes/{name}"),
            "volume",
            Duration::from_secs(90),
        )
        .await)
    }
}

pub struct DockerNetworksApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker.networks")]
impl DockerNetworksApi {
    /// The host's networks with their subnets and the containers attached to each.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn list(&self, ctx: Ctx, input: NetworksListInput) -> ToolResult<Vec<NetworkRow>> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let (networks, containers) = tokio::try_join!(
            client.engine.get::<Vec<Value>>("/networks", "engine"),
            containers(&client),
        )?;
        let uses = Uses::of(&containers);
        Ok(networks.iter().map(|n| network_row(n, &uses)).collect())
    }

    /// `docker network inspect` of one network.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn inspect(&self, ctx: Ctx, input: NetworkIdInput) -> ToolResult<InspectOutput> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let id = name_ref("id", &input.id, "network")?;
        let inspect = client
            .engine
            .get(&format!("/networks/{id}"), "network")
            .await?;
        Ok(InspectOutput { inspect })
    }

    /// Removes the networks; Docker refuses the predefined ones and one a running container is
    /// attached to. One result per id.
    #[rpc::mutation(
        perm = "docker.destroy",
        risk = Risk::Destructive,
        timeout_default = "2m"
    )]
    async fn remove(
        &self,
        ctx: Ctx,
        input: NetworksRemoveInput,
    ) -> ToolResult<Vec<ContainerActionResult>> {
        let client = client(&self.0, &ctx, &input.conn_id)?;
        let ids = many("ids", &input.ids, "network", |v| {
            name_ref("ids", v, "network")
        })?;
        Ok(each(
            &client,
            &ids,
            Method::DELETE,
            |id| format!("/networks/{id}"),
            "network",
            Duration::from_secs(90),
        )
        .await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn containers() -> Vec<Value> {
        vec![
            json!({ "Id": "c1", "Names": ["/web"], "State": "exited", "ImageID": "sha256:a",
                    "Mounts": [{ "Type": "volume", "Name": "data" }, { "Type": "bind", "Source": "/srv" }],
                    "NetworkSettings": { "Networks": { "shop_default": { "NetworkID": "n1" } } } }),
            json!({ "Id": "c2", "Names": ["/api"], "State": "running", "ImageID": "sha256:a",
                    "Mounts": [{ "Type": "volume", "Name": "data" }],
                    "NetworkSettings": { "Networks": { "bridge": { "NetworkID": "" } } } }),
        ]
    }

    #[test]
    fn what_uses_an_item_comes_from_the_containers_running_first() {
        let uses = Uses::of(&containers());
        let names = |list: &[ContainerUse]| list.iter().map(|u| u.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&uses.images["sha256:a"]), ["api", "web"]);
        assert_eq!(names(&uses.volumes["data"]), ["api", "web"]);
        assert_eq!(names(&uses.networks["n1"]), ["web"]);
        // No id: keyed by the network's name.
        assert_eq!(names(&uses.networks["bridge"]), ["api"]);
        assert!(!uses.volumes.contains_key("/srv"));
    }

    #[test]
    fn rows_read_docker_s_answers() {
        let uses = Uses::of(&containers());
        let image = image_row(
            &json!({ "Id": "sha256:a", "RepoTags": ["shop/api:1.4", "shop/api:latest"],
                     "RepoDigests": ["shop/api@sha256:d"], "Created": 1795161601, "Size": 1024 }),
            &uses,
        );
        assert!(!image.dangling);
        assert_eq!(image.used_by.len(), 2);
        assert_eq!(image.used_by[0].state, "running");
        let dangling = image_row(
            &json!({ "Id": "sha256:b", "RepoTags": ["<none>:<none>"], "RepoDigests": null }),
            &uses,
        );
        assert!(dangling.dangling && dangling.repo_tags.is_empty() && dangling.used_by.is_empty());
        let by_digest = image_row(
            &json!({ "Id": "sha256:c", "RepoTags": [], "RepoDigests": ["busybox@sha256:d"] }),
            &uses,
        );
        assert!(!by_digest.dangling);

        let sizes = volume_sizes(&json!({ "Volumes": [
            { "Name": "data", "UsageData": { "Size": 2048, "RefCount": 2 } },
            { "Name": "cold", "UsageData": { "Size": -1, "RefCount": 0 } },
        ] }));
        let volume = volume_row(
            &json!({ "Name": "data", "Driver": "local", "Scope": "local", "Mountpoint": "/var/lib/docker/volumes/data/_data",
                     "Labels": { "com.docker.compose.project": "shop" } }),
            &uses,
            &sizes,
        );
        assert_eq!(volume.size, Some(2048));
        assert_eq!(volume.project.as_deref(), Some("shop"));
        assert_eq!(volume.used_by.len(), 2);
        assert_eq!(
            volume_row(&json!({ "Name": "cold" }), &uses, &sizes).size,
            None
        );

        let network = network_row(
            &json!({ "Id": "n1", "Name": "shop_default", "Driver": "bridge", "Scope": "local",
                     "IPAM": { "Config": [{ "Subnet": "172.18.0.0/16", "Gateway": "172.18.0.1" }, { "Subnet": "fd00::/64" }] },
                     "Created": "2026-11-20T07:00:00Z", "Labels": {} }),
            &uses,
        );
        assert_eq!(network.subnets.len(), 2);
        assert_eq!(network.subnets[1].gateway, None);
        assert!(!network.built_in);
        assert_eq!(network.used_by[0].name, "web");
        let bridge = network_row(
            &json!({ "Id": "n0", "Name": "bridge", "Driver": "bridge" }),
            &uses,
        );
        assert!(bridge.built_in);
        assert_eq!(bridge.used_by[0].name, "api");
    }

    #[test]
    fn names_that_would_leave_the_path_are_refused() {
        for ok in [
            "busybox:1.37",
            "sha256:0123abcd",
            "registry.lan:5000/shop/api:1.4",
            "shop/api@sha256:0123",
        ] {
            assert_eq!(image_ref("id", ok).unwrap(), ok);
        }
        for bad in [
            "../containers/x",
            "a/../b",
            "/abs",
            "a//b",
            "a/",
            "a b",
            "a?force=1",
            "",
        ] {
            assert!(image_ref("id", bad).is_err(), "{bad}");
        }
        assert!(name_ref("name", "shop_pgdata", "volume").is_ok());
        for bad in ["..", ".hidden", "a/b", "a%2Fb", ""] {
            assert!(name_ref("name", bad, "volume").is_err(), "{bad}");
        }
    }

    #[test]
    fn a_removal_lists_what_went() {
        let r = image_removal(
            "shop/api:1.4",
            &json!([{ "Untagged": "shop/api:1.4" }, { "Deleted": "sha256:a" }, { "Deleted": "sha256:l1" }]),
        );
        assert_eq!(r.untagged, ["shop/api:1.4"]);
        assert_eq!(r.deleted, ["sha256:a", "sha256:l1"]);
        assert_eq!(r.error, None);
    }
}
