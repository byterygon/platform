//! `docker`: Docker (Mightyconsole spec §10, TSK-81; DOC-23 §6, TSK-116). A Portainer-like view
//! of a host, with no agent installed on it, reached over one of three transports:
//!
//! - [`transport`]: SSH (the socket on a saved SSH host), a local socket or named pipe on the
//!   server's machine, or TCP with or without TLS. One stream per request.
//! - [`ssh`]: one russh session per live handle; the host key is checked in the handshake
//!   against the SSH host's trusted one (trust on first use, spec §10.2).
//! - [`engine`]: the Docker Engine API, HTTP/1.1 over one stream per request, the API version
//!   negotiated from `/_ping` (at least 1.41).
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
//! When an SSH session ends by itself (the host closed it, keepalives went unanswered), the
//! handle's state turns `failed` on `app.events` with the reason, and the UI offers to connect
//! again. Releasing the handle closes the session. A local socket and TCP hold nothing open
//! between requests: a request that cannot reach the Engine fails on its own.

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
pub mod transport;
pub mod types;

use std::sync::Arc;
use std::time::Duration;

use ambidex::{BinarySink, Ctx, rpc};
use serde_json::Value;

use crate::core::stored::ToolTestInput;
use crate::core::{ConnectionState, Empty, Hub, ToolError, ToolResult};
use engine::{Engine, Ping};
use ssh::{Credentials, SshSession, SshTarget};
use transport::{
    DockerTransport, SocketTransport, SshTransport, TcpTls, TcpTransport, expand_socket_path,
};
pub use types::*;

/// The tool's id and namespace.
pub const TOOL: &str = "docker";

/// The socket when the profile names none.
pub const DEFAULT_SOCKET: &str = "/var/run/docker.sock";

/// The keepalive when the profile sets none (spec §10.1).
pub const DEFAULT_KEEPALIVE_SEC: u32 = 30;

/// Plain TCP's port when the profile names none (DOC-23 §6.3).
pub const DEFAULT_TCP_PORT: u16 = 2375;

/// TCP with TLS's port when the profile names none.
pub const DEFAULT_TLS_PORT: u16 = 2376;

/// How a connection reaches its Engine, for the Host page.
#[derive(Debug, Clone)]
pub struct ConnectionFacts {
    pub transport: DockerTransportKind,
    pub endpoint: String,
    pub tls: bool,
    pub unencrypted: bool,
    pub ssh: Option<SshFacts>,
}

/// A connected Docker host.
pub struct DockerClient {
    pub engine: Engine,
    pub facts: ConnectionFacts,
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
    facts: &ConnectionFacts,
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
        transport: facts.transport,
        endpoint: facts.endpoint.clone(),
        tls: facts.tls,
        unencrypted: facts.unencrypted,
        ssh: facts.ssh.clone(),
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
pub(crate) fn target(profile: &ConnectDockerProfile) -> Result<SshTarget, ToolError> {
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

/// Opens the profile's transport and pings the Engine through it: the engine, the ping and the
/// facts for the Host page. Errors as `docker.connect` lists them.
pub(crate) async fn open(
    profile: &ConnectDockerProfile,
) -> Result<(Engine, Ping, ConnectionFacts), ToolError> {
    let kind = profile.transport.unwrap_or_default();
    let (transport, facts): (Arc<dyn DockerTransport>, ConnectionFacts) = match kind {
        DockerTransportKind::Ssh => {
            let target = target(profile)?;
            let socket = socket_path(profile)?;
            let auth = profile.auth.unwrap_or_default();
            let display = target.display();
            let session = SshSession::connect(target).await?;
            let ssh = SshFacts {
                target: display.clone(),
                host_key: session.host_key.clone(),
                socket_path: socket.clone(),
                auth,
            };
            let transport = SshTransport {
                session,
                socket_path: socket,
                target: display,
            };
            let facts = ConnectionFacts {
                transport: kind,
                endpoint: transport.describe(),
                tls: false,
                unencrypted: false,
                ssh: Some(ssh),
            };
            (Arc::new(transport), facts)
        }
        DockerTransportKind::Socket => {
            let transport = socket_transport(profile)?;
            let facts = ConnectionFacts {
                transport: kind,
                endpoint: transport.describe(),
                tls: false,
                unencrypted: false,
                ssh: None,
            };
            (Arc::new(transport), facts)
        }
        DockerTransportKind::Tcp => {
            let transport = tcp_transport(profile)?;
            let facts = ConnectionFacts {
                transport: kind,
                endpoint: transport.describe(),
                tls: transport.tls.is_some(),
                unencrypted: transport.tls.is_none(),
                ssh: None,
            };
            (Arc::new(transport), facts)
        }
    };
    let (engine, ping) = Engine::open(transport).await?;
    Ok((engine, ping, facts))
}

/// The local socket of a `socket` profile (DOC-23 §6.2).
pub(crate) fn socket_transport(
    profile: &ConnectDockerProfile,
) -> Result<SocketTransport, ToolError> {
    let path = expand_socket_path(
        profile.socket_path.as_deref().unwrap_or_default(),
        dirs::home_dir(),
    )?;
    Ok(SocketTransport { path })
}

/// The TCP API of a `tcp` profile (DOC-23 §6.3): TLS verified against the pinned CA with the
/// client certificate, or plain TCP when the person accepted it.
pub(crate) fn tcp_transport(profile: &ConnectDockerProfile) -> Result<TcpTransport, ToolError> {
    let host = profile.host.trim();
    if host.is_empty() {
        return Err(ToolError::invalid(
            TOOL,
            "host",
            "enter the Engine's host name or address",
        ));
    }
    if !net_route::is_valid_host(host) {
        return Err(ToolError::invalid(
            TOOL,
            "host",
            "a host name or an IP address, without a scheme or a port",
        ));
    }
    let options = profile.tls.clone().unwrap_or_default();
    let with_tls = options.enabled == Some(true);
    let port = profile.port.unwrap_or(if with_tls {
        DEFAULT_TLS_PORT
    } else {
        DEFAULT_TCP_PORT
    });
    if port == 0 {
        return Err(ToolError::invalid(
            TOOL,
            "port",
            "the port must be 1 to 65535",
        ));
    }
    let tls = if with_tls {
        // DOC-23 §6.3: the CA is pinned and the client certificate and key are given; only the
        // server name is optional. (Docker's TLS is `dockerd --tlsverify`: its own CA, and a
        // client certificate it signed.)
        let given = |v: &Option<String>| v.as_deref().is_some_and(|t| !t.trim().is_empty());
        for (value, field, what) in [
            (
                &options.ca_pem,
                "tls.caPem",
                "paste the CA certificate the Engine's certificate is signed by (ca.pem)",
            ),
            (
                &options.client_cert_pem,
                "tls.clientCertPem",
                "paste the client certificate the Engine accepts (cert.pem)",
            ),
            (
                &options.client_key_pem,
                "tls.clientKeyPem",
                "paste the client certificate's private key (key.pem)",
            ),
        ] {
            if !given(value) {
                return Err(ToolError::invalid(TOOL, field, what));
            }
        }
        let config = crate::core::tls::client_config(&options)
            .map_err(|e| ToolError::invalid(TOOL, e.field, e.message))?;
        let server_name = rustls::pki_types::ServerName::try_from(host.to_owned())
            .map_err(|_| ToolError::invalid(TOOL, "host", "not a host name or address"))?;
        Some(TcpTls {
            config: Arc::new(config),
            server_name,
        })
    } else {
        if profile.unencrypted_accepted != Some(true) {
            return Err(ToolError::invalid(
                TOOL,
                "unencrypted",
                "this profile connects without TLS: accept, in the profile, that anyone on the \
                 network who reaches this port is root on that host, or turn TLS on",
            ));
        }
        None
    };
    Ok(TcpTransport {
        host: host.to_owned(),
        port,
        tls,
    })
}

pub struct DockerApi(pub Arc<Hub>);

pub struct DockerHostApi(pub Arc<Hub>);

#[rpc::router(namespace = "docker")]
impl DockerApi {
    /// Opens the profile's transport and pings the engine through it. Over SSH: the session
    /// opens, the host key is checked and the login made. `HostKey` (unknown or changed, with
    /// the presented key), `Auth` (the login, or a client certificate the Engine refused), `Tls`
    /// (the Engine's certificate), `Connect`, `Forbidden` (the host does not forward the socket,
    /// a local socket this server may not use, the outbound policy), `Invalid` (the profile).
    #[rpc::mutation(
        perm = "docker.read",
        risk = Risk::Read,
        timeout_default = "60s",
        audit = "always",
    )]
    async fn connect(
        &self,
        ctx: Ctx,
        input: DockerConnectInput,
    ) -> ToolResult<DockerConnectOutput> {
        let (profile, acts_on) = self.0.connect_profile(&ctx, TOOL, input.profile_id).await?;
        let (engine, ping, facts) = open(&profile).await?;
        let client = Arc::new(DockerClient {
            engine,
            facts,
            ping,
        });
        let host = match client.host_info().await {
            Ok(host) => host,
            Err(e) => {
                client.engine.transport.close().await;
                return Err(e.into());
            }
        };
        let session = ctx.session().id.clone();
        let handle = self
            .0
            .insert_for(&session, TOOL, Arc::clone(&client), acts_on);
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

    /// Test connection of the profile form: the draft's transport opens, the Engine answers a
    /// ping, and the transport closes. An unknown host key fails as `connect` does, with the key
    /// to trust.
    #[rpc::mutation(perm = "docker.read", risk = Risk::Read, redact = ["draft.secrets"], audit = "always")]
    async fn test(&self, ctx: Ctx, input: ToolTestInput) -> ToolResult<Empty> {
        let (profile, _) = self
            .0
            .test_profile::<ConnectDockerProfile>(&ctx, TOOL, input)
            .await?;
        let (engine, _, _) = open(&profile).await?;
        engine.transport.close().await;
        Ok(Empty {})
    }

    /// Closes the transport (an SSH session) and ends the handle's streams; idempotent.
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

/// Closes the transport when the handle is released, and reports one that ended by itself.
fn watch(
    hub: Arc<Hub>,
    session: String,
    conn_id: String,
    released: tokio_util::sync::CancellationToken,
    client: Arc<DockerClient>,
) {
    tokio::spawn(async move {
        let transport = &client.engine.transport;
        let lost = transport.lost().unwrap_or_default();
        tokio::select! {
            () = released.cancelled() => transport.close().await,
            () = lost.cancelled() => {
                let reason = transport.lost_reason();
                hub.status(&session, TOOL, &conn_id, ConnectionState::Failed, Some(reason));
            }
        }
    });
}

#[rpc::router(namespace = "docker.host")]
impl DockerHostApi {
    /// The host's facts: name, OS, kernel, CPUs, memory, Docker and API versions, storage and
    /// logging drivers, counts, and how the connection reaches it (transport, SSH facts, TLS or
    /// unencrypted).
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
