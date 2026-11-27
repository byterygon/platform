//! The wire types of `docker.connect` and `docker.host.*` (Mightyconsole spec §10.1, §10.6).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub use super::transport::DockerTransportKind;
use crate::core::HostKeyFingerprint;
use crate::core::tls::TlsOptions;

/// How the server logs in to the host (spec §10.1, `fields.auth`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum DockerAuth {
    /// `privateKey` (OpenSSH or PEM text), with `passphrase` when it is encrypted.
    #[default]
    PrivateKey,
    /// `password`.
    Password,
    /// The ssh-agent of the user running mightyconsole-server (`SSH_AUTH_SOCK`).
    Agent,
}

/// The Docker tool's profile as the server builds it from the stored record (spec §4.4, §10.1,
/// DOC-23 §6): over SSH, the SSH host's login and the socket on it; a local socket; or TCP.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDockerProfile {
    pub name: String,
    /// `ssh` when absent (profiles saved before TSK-116).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub transport: Option<DockerTransportKind>,
    /// SSH: host name or IP address of the SSH server. TCP: of the Engine.
    #[serde(default)]
    pub host: String,
    /// SSH: 22 when absent. TCP: 2376 with TLS, 2375 without.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub port: Option<u16>,
    /// SSH only.
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub auth: Option<DockerAuth>,
    /// For `privateKey`: the key's text (a profile secret, never logged).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub private_key: Option<String>,
    /// For an encrypted private key.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub passphrase: Option<String>,
    /// For `password`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub password: Option<String>,
    /// The trusted host key; `null` until the person trusts it on first use (spec §10.2).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub host_key: Option<HostKeyFingerprint>,
    /// SSH: the socket on the host, `/var/run/docker.sock` when absent (rootless Docker:
    /// `/run/user/<uid>/docker.sock`). Local socket: the path on the server's machine (`~` is
    /// the home of the user running the server) or a Windows named pipe, required.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub socket_path: Option<String>,
    /// TCP: `enabled` (TLS on), the pinned CA, the client certificate and its key (a secret), the
    /// name the certificate carries. There is no "skip verification".
    #[serde(default)]
    #[ts(optional = nullable)]
    pub tls: Option<TlsOptions>,
    /// TCP without TLS: the person accepted that anyone on the network who reaches the port is
    /// root on that host (DOC-23 §6.3, (u)). Plain TCP is refused without it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub unencrypted_accepted: Option<bool>,
    /// SSH keepalive interval, 30 s when absent; 0 turns it off.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub keepalive_sec: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectInput {
    /// The stored profile to connect with (DOC-25 §3.4.7): the server opens its secrets; the
    /// browser never sends one.
    pub profile_id: String,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectOutput {
    pub conn_id: String,
    pub host: HostInfo,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnIdInput {
    pub conn_id: String,
}

/// The connection's SSH side, for the Host page's subtitle (SSH transport only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SshFacts {
    /// `user@host:port`.
    pub target: String,
    pub host_key: HostKeyFingerprint,
    pub socket_path: String,
    pub auth: DockerAuth,
}

/// `docker.host.info` (spec §10.4, Host): `/info` and `/version` of the Docker Engine, and the
/// connection's facts.
#[derive(Debug, Clone, PartialEq, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    /// How the server reaches the Engine.
    pub transport: DockerTransportKind,
    /// What it reaches: `/var/run/docker.sock on deploy@h:22`, `/var/run/docker.sock`,
    /// `docker.prod:2376`.
    pub endpoint: String,
    /// TCP with TLS (the Host page says so).
    pub tls: bool,
    /// Plain TCP: the Unencrypted badge and the banner that cannot be dismissed (DOC-23 (u)).
    pub unencrypted: bool,
    /// The SSH side, for the SSH transport.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub ssh: Option<SshFacts>,
    /// The route the connection goes through, by name; absent for Direct (DOC-23 §10).
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub route: Option<String>,
    /// The API version the connection speaks (the host's, at least 1.41).
    pub api_version: String,
    /// The host's own maximum and minimum API versions.
    pub server_api_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_api_version: Option<String>,
    /// Round trip of `GET /_ping` over the transport, in milliseconds.
    pub ping_ms: u32,
    pub name: String,
    pub operating_system: String,
    pub os_type: String,
    pub kernel_version: String,
    pub architecture: String,
    pub cpus: u32,
    pub memory_bytes: u64,
    pub server_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub containerd_version: Option<String>,
    pub storage_driver: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub storage_backing_filesystem: Option<String>,
    pub logging_driver: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cgroup_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cgroup_driver: Option<String>,
    /// `apparmor`, `seccomp`, `rootless`, ... (the names of `SecurityOptions`).
    pub security_options: Vec<String>,
    pub rootless: bool,
    pub docker_root_dir: String,
    pub containers: u32,
    pub containers_running: u32,
    pub containers_paused: u32,
    pub containers_stopped: u32,
    pub images: u32,
    /// Problems the engine reports about itself (`Warnings` of `/info`).
    pub warnings: Vec<String>,
}
