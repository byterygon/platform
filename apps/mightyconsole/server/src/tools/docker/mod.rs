//! `docker`: Docker over SSH (Mightyconsole spec §10, TSK-81). A Portainer-like view of a host
//! that the server reaches through SSH, with no agent installed on it:
//!
//! - [`ssh`]: one russh session per live handle; the host key is checked in the handshake
//!   against the profile's trusted one (trust on first use, spec §10.2).
//! - [`engine`]: the Docker Engine API, HTTP/1.1 over one `direct-streamlocal` channel to the
//!   socket per request, the API version negotiated from `/_ping` (at least 1.41).
//! - `docker.connect`, `docker.disconnect`, `docker.host.info` (batch 1).
//! - [`containers`]: `docker.containers.*`, the list, inspect, start, stop, restart, remove and
//!   the logs stream (batch 2b); [`stats`] and [`exec`] (batch 2c).
//! - [`resources`]: `docker.images.*`, `docker.volumes.*`, `docker.networks.*`: the lists with
//!   what uses each item, inspect and remove (batch 3).
//! - [`system`]: `docker.host.df` (disk usage), `docker.host.counts` (the tree's counts) and the
//!   processes of `docker.containers.top` (batch 4).
//! - [`files`]: `docker.containers.files.*`, a container's files read only through its archive
//!   (batch 4c).
//! - [`events`]: `docker.events`, the host's events that keep the lists live, and
//!   `docker.compose.projects` from the containers' labels.
//! - [`stream`]: the `jsonl` forwarding the logs and the events share.
//!
//! When the SSH session ends by itself (the host closed it, keepalives went unanswered), the
//! handle's state turns `failed` on `app.events` with the reason, and the UI offers to connect
//! again. Releasing the handle closes the session.

pub mod containers;
pub mod engine;
pub mod events;
pub mod exec;
pub mod files;
pub mod resources;
pub mod ssh;
pub mod stats;
pub mod stream;
pub mod system;
pub mod types;

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx, rpc};
use serde_json::Value;

use crate::core::{ConnectionState, Empty, Hub, ToolError, ToolResult};
use engine::{Engine, Ping};
use ssh::{Credentials, SshSession, SshTarget};
pub use types::*;

/// The tool's id and namespace.
pub const TOOL: &str = "docker";

/// The socket when the profile names none.
pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";

/// The keepalive when the profile sets none (spec §10.1).
pub const DEFAULT_KEEPALIVE_SEC: u32 = 30;

/// A connected Docker host.
pub struct DockerClient {
    pub engine: Engine,
    pub facts: SshFacts,
    pub ping: Ping,
}

impl DockerClient {
    /// `/info` and `/version` with the connection's facts (spec §10.4, Host).
    pub async fn host_info(&self) -> Result<HostInfo, ToolError> {
        let (info, version) = tokio::try_join!(
            self.engine.get::<Value>("/info", "engine"),
            self.engine.get::<Value>("/version", "engine"),
        )?;
        Ok(host_info(
            &self.facts,
            &self.engine,
            &self.ping,
            &info,
            &version,
        ))
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn count(value: &Value, key: &str) -> u32 {
    value
        .get(key)
        .and_then(Value::as_u64)
        .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

/// The Host page from the engine's `/info` and `/version` answers.
fn host_info(
    facts: &SshFacts,
    engine: &Engine,
    ping: &Ping,
    info: &Value,
    version: &Value,
) -> HostInfo {
    // `SecurityOptions` are `name=seccomp,profile=builtin`; the page shows the names.
    let security_options: Vec<String> = info
        .get("SecurityOptions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|option| {
            option
                .split(',')
                .find_map(|part| part.strip_prefix("name="))
                .unwrap_or(option)
                .to_owned()
        })
        .collect();
    let containerd_version = version
        .get("Components")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|c| c.get("Name").and_then(Value::as_str) == Some("containerd"))
        .and_then(|c| optional_text(c, "Version"));
    let backing = info
        .get("DriverStatus")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .find(|pair| pair.first().and_then(Value::as_str) == Some("Backing Filesystem"))
        .and_then(|pair| pair.get(1).and_then(Value::as_str))
        .map(str::to_owned);
    HostInfo {
        ssh: facts.clone(),
        api_version: engine.api.to_string(),
        server_api_version: ping.server_api.to_string(),
        min_api_version: optional_text(version, "MinAPIVersion"),
        ping_ms: u32::try_from(ping.round_trip.as_millis()).unwrap_or(u32::MAX),
        name: text(info, "Name"),
        operating_system: text(info, "OperatingSystem"),
        os_type: text(info, "OSType"),
        kernel_version: text(info, "KernelVersion"),
        architecture: text(info, "Architecture"),
        cpus: count(info, "NCPU"),
        memory_bytes: info.get("MemTotal").and_then(Value::as_u64).unwrap_or(0),
        server_version: optional_text(info, "ServerVersion")
            .unwrap_or_else(|| text(version, "Version")),
        containerd_version,
        storage_driver: text(info, "Driver"),
        storage_backing_filesystem: backing,
        logging_driver: text(info, "LoggingDriver"),
        cgroup_version: optional_text(info, "CgroupVersion"),
        cgroup_driver: optional_text(info, "CgroupDriver"),
        rootless: security_options.iter().any(|o| o == "rootless"),
        security_options,
        docker_root_dir: text(info, "DockerRootDir"),
        containers: count(info, "Containers"),
        containers_running: count(info, "ContainersRunning"),
        containers_paused: count(info, "ContainersPaused"),
        containers_stopped: count(info, "ContainersStopped"),
        images: count(info, "Images"),
        warnings: info
            .get("Warnings")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
    }
}

/// The SSH target of a profile; the secret for the chosen method must be there.
fn target(profile: &ConnectDockerProfile) -> Result<SshTarget, ToolError> {
    let host = profile.host.trim();
    if host.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "host",
            "enter the host name or address",
        ));
    }
    let username = profile.username.trim();
    if username.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "username",
            "enter the user to log in as",
        ));
    }
    let port = profile.port.unwrap_or(22);
    if port == 0 {
        return Err(ToolError::invalid(
            TOOL,
            "port",
            "the port must be 1 to 65535",
        ));
    }
    let auth = profile.auth.unwrap_or_default();
    let credentials = match auth {
        DockerAuth::PrivateKey => Credentials::PrivateKey {
            text: profile.private_key.clone().unwrap_or_default(),
            passphrase: profile.passphrase.clone(),
        },
        DockerAuth::Password => match profile.password.as_deref() {
            Some(password) if !password.is_empty() => Credentials::Password(password.to_owned()),
            _ => return Err(ToolError::invalid(TOOL, "password", "enter the password")),
        },
        DockerAuth::Agent => Credentials::Agent,
    };
    let keepalive = profile.keepalive_sec.unwrap_or(DEFAULT_KEEPALIVE_SEC);
    Ok(SshTarget {
        host: host.to_owned(),
        port,
        username: username.to_owned(),
        credentials,
        trusted: profile.host_key.clone(),
        keepalive: (keepalive > 0).then(|| Duration::from_secs(u64::from(keepalive))),
    })
}

fn socket_path(profile: &ConnectDockerProfile) -> Result<String, ToolError> {
    let path = profile
        .socket_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .unwrap_or(DEFAULT_SOCKET);
    if !path.starts_with('/') {
        return Err(ToolError::invalid(
            TOOL,
            "socketPath",
            "the socket path must be absolute, like /var/run/docker.sock",
        ));
    }
    Ok(path.to_owned())
}

pub struct DockerApi(pub Arc<Hub>);

pub struct DockerHostApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker")]
impl DockerApi {
    /// Opens an SSH session from the profile, checks the host key, logs in, and pings the
    /// engine over the socket. `HostKey` (unknown or changed, with the presented key), `Auth`,
    /// `Connect`, `Forbidden` (the host does not forward the socket), `Invalid` (the profile).
    #[rpc::mutation(
        perm = "docker.read",
        risk = Risk::Read,
        timeout_default = "60s",
        redact = ["profile.privateKey", "profile.passphrase", "profile.password"],
        audit = "always",
    )]
    async fn connect(
        &self,
        ctx: Ctx,
        input: DockerConnectInput,
    ) -> ToolResult<DockerConnectOutput> {
        let profile = input.profile;
        let target = target(&profile)?;
        let socket = socket_path(&profile)?;
        let auth = profile.auth.unwrap_or_default();
        let display = target.display();
        let ssh = SshSession::connect(target).await?;
        let host_key = ssh.host_key.clone();
        let (engine, ping) = Engine::open(ssh, socket.clone()).await?;
        let client = Arc::new(DockerClient {
            engine,
            facts: SshFacts {
                target: display,
                host_key,
                socket_path: socket,
                auth,
            },
            ping,
        });
        let host = match client.host_info().await {
            Ok(host) => host,
            Err(e) => {
                client.engine.ssh.close().await;
                return Err(e.into());
            }
        };
        let session = ctx.session().id.clone();
        let handle = self.0.insert(&session, TOOL, Arc::clone(&client));
        watch(
            Arc::clone(&self.0),
            session,
            handle.conn_id.clone(),
            handle.token,
            client,
        );
        Ok(DockerConnectOutput {
            conn_id: handle.conn_id,
            host,
        })
    }

    /// Closes the SSH session and ends the handle's streams; idempotent.
    #[rpc::mutation(perm = "docker.read", risk = Risk::Read)]
    async fn disconnect(&self, ctx: Ctx, input: DockerConnIdInput) -> ToolResult<Empty> {
        self.0.remove(&ctx.session().id, TOOL, &input.conn_id);
        Ok(Empty {})
    }

    /// The host's events (containers, images, volumes, networks) as `jsonl` lines
    /// ([`events::DockerEvent`]) until the stream is stopped; the lists refresh rows from them.
    #[rpc::stream(perm = "docker.read", risk = Risk::Read, timeout_max = "12h")]
    async fn events(
        &self,
        ctx: Ctx,
        input: events::DockerEventsInput,
        sink: BinarySink,
    ) -> ToolResult<Empty> {
        events::run(&self.0, &ctx, input, &sink).await
    }
}

/// Closes the session when the handle is released, and reports a session that ended by itself.
fn watch(
    hub: Arc<Hub>,
    session: String,
    conn_id: String,
    released: tokio_util::sync::CancellationToken,
    client: Arc<DockerClient>,
) {
    tokio::spawn(async move {
        let lost = client.engine.ssh.lost();
        tokio::select! {
            () = released.cancelled() => client.engine.ssh.close().await,
            () = lost.cancelled() => {
                let reason = client.engine.ssh.lost_reason();
                hub.status(&session, TOOL, &conn_id, ConnectionState::Failed, Some(reason));
            }
        }
    });
}

#[rpc::router(namespace = "docker.host")]
impl DockerHostApi {
    /// The host's facts: name, OS, kernel, CPUs, memory, Docker and API versions, storage and
    /// logging drivers, counts, and the connection's SSH facts.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn info(&self, ctx: Ctx, input: DockerConnIdInput) -> ToolResult<HostInfo> {
        let handle = self
            .0
            .get::<DockerClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        Ok(handle.value.host_info().await?)
    }

    /// Disk usage per kind (images, containers' writable layers, volumes, build cache) with what
    /// a prune could free, from `/system/df`. Docker sizes every volume for it, so it can take a
    /// while on a big host.
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn df(&self, ctx: Ctx, input: DockerConnIdInput) -> ToolResult<system::DiskUsage> {
        let handle = self
            .0
            .get::<DockerClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        Ok(system::df(&handle.value).await?)
    }

    /// How many images, volumes and networks the host has (the tree's counts).
    #[rpc::query(perm = "docker.read", risk = Risk::Read)]
    async fn counts(&self, ctx: Ctx, input: DockerConnIdInput) -> ToolResult<system::HostCounts> {
        let handle = self
            .0
            .get::<DockerClient>(&ctx.session().id, TOOL, &input.conn_id)?;
        Ok(system::counts(&handle.value).await?)
    }
}

/// Mounts the tool's namespaces.
pub fn mount(router: &ambidex::Router, hub: &Arc<Hub>) -> Result<(), ambidex::RegistryError> {
    router.mount(DockerApi(Arc::clone(hub)))?;
    router.mount(DockerHostApi(Arc::clone(hub)))?;
    router.mount(containers::DockerContainersApi(Arc::clone(hub)))?;
    router.mount(events::DockerComposeApi(Arc::clone(hub)))?;
    router.mount(files::DockerFilesApi(Arc::clone(hub)))?;
    router.mount(resources::DockerImagesApi(Arc::clone(hub)))?;
    router.mount(resources::DockerVolumesApi(Arc::clone(hub)))?;
    router.mount(resources::DockerNetworksApi(Arc::clone(hub)))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(json: Value) -> ConnectDockerProfile {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn a_profile_names_what_is_missing() {
        let field = |p: Value| target(&profile(p)).err().and_then(|e| e.field);
        assert_eq!(
            field(serde_json::json!({ "name": "a", "host": " ", "username": "u" })).as_deref(),
            Some("host")
        );
        assert_eq!(
            field(serde_json::json!({ "name": "a", "host": "h", "username": "" })).as_deref(),
            Some("username")
        );
        assert_eq!(
            field(
                serde_json::json!({ "name": "a", "host": "h", "username": "u", "auth": "password" })
            )
            .as_deref(),
            Some("password")
        );
        let ok = target(&profile(serde_json::json!({
            "name": "a", "host": "h", "username": "u", "keepaliveSec": 0
        })))
        .unwrap();
        assert_eq!(ok.port, 22);
        assert_eq!(ok.keepalive, None);
        assert_eq!(ok.display(), "u@h:22");
        let v6 = target(&profile(
            serde_json::json!({ "name": "a", "host": "::1", "username": "u", "port": 2222 }),
        ))
        .unwrap();
        assert_eq!(v6.address(), "[::1]:2222");
        let p = profile(
            serde_json::json!({ "name": "a", "host": "h", "username": "u", "socketPath": "docker.sock" }),
        );
        assert_eq!(
            socket_path(&p).unwrap_err().field.as_deref(),
            Some("socketPath")
        );
        let p = profile(serde_json::json!({ "name": "a", "host": "h", "username": "u" }));
        assert_eq!(socket_path(&p).unwrap(), DEFAULT_SOCKET);
    }
}
