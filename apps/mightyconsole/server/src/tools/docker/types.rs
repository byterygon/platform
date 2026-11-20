//! The wire types of `docker.connect` and `docker.host.*` (Mightyconsole spec §10.1, §10.6).

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::core::HostKeyFingerprint;

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

/// The Docker tool's profile as `toConnect` builds it (spec §4.4, §10.1).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ConnectDockerProfile {
    pub name: String,
    /// Host name or IP address of the SSH server.
    pub host: String,
    /// 22 when absent.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub port: Option<u16>,
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
    /// `/var/run/docker.sock` when absent; rootless Docker: `/run/user/<uid>/docker.sock`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub socket_path: Option<String>,
    /// SSH keepalive interval, 30 s when absent; 0 turns it off.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub keepalive_sec: Option<u32>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectInput {
    pub profile: ConnectDockerProfile,
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

/// The connection's SSH side, for the Host page's subtitle.
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
    pub ssh: SshFacts,
    /// The API version the connection speaks (the host's, at least 1.41).
    pub api_version: String,
    /// The host's own maximum and minimum API versions.
    pub server_api_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub min_api_version: Option<String>,
    /// Round trip of `GET /_ping` over SSH and the socket, in milliseconds.
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
