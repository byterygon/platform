//! The `docker` tool against a stand-in SSH server on loopback (Mightyconsole spec §10, TSK-81):
//! a russh server with a generated host key, password and public-key logins, and
//! `direct-streamlocal` channels to a fake Docker Engine (HTTP/1.1 on the channel). It checks
//! trust on first use (nothing is sent to an untrusted host), a changed key, the logins, the
//! explained error of a host that refuses to forward the socket, the API version floor, the
//! Host page and a session the host ends. The real sshd and Docker are `tests/docker_lab.rs`
//! (feature `lab-tests`). Runs in CI's network namespace: loopback only.

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use crate::support::*;
use ambidex::{Code, ErrorPayload};
use bytes::Bytes;
use http_body_util::Full;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use russh::keys::ssh_key::LineEnding;
use russh::keys::ssh_key::private::Ed25519Keypair;
use russh::keys::{HashAlg, PrivateKey, PublicKey};
use russh::server::{self, Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelOpenFailure, Disconnect};
use serde_json::{Value, json};

const USER: &str = "lab";
const PASSWORD: &str = "correct horse";

fn key() -> PrivateKey {
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).unwrap();
    PrivateKey::from(Ed25519Keypair::from_seed(&seed))
}

fn fingerprint(key: &PublicKey) -> Value {
    json!({
        "algorithm": key.algorithm().as_str(),
        "fingerprintSha256": key.fingerprint(HashAlg::Sha256).to_string(),
    })
}

/// What the stand-in host saw.
#[derive(Clone, Default)]
struct Seen {
    /// Every authentication callback; a refused host key must leave it at zero.
    auth_attempts: Arc<AtomicUsize>,
    /// Paths the fake engine served.
    paths: Arc<Mutex<Vec<String>>>,
    /// Commands the tool ran on the host.
    commands: Arc<Mutex<Vec<String>>>,
    /// The session handles, to end a session from the host's side.
    sessions: Arc<Mutex<Vec<server::Handle>>>,
}

#[derive(Clone)]
struct Host {
    client_key: PublicKey,
    seen: Seen,
}

impl server::Server for Host {
    type Handler = Host;
    fn new_client(&mut self, _: Option<SocketAddr>) -> Host {
        self.clone()
    }
}

impl server::Handler for Host {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        self.seen.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        self.seen.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(if user == USER && password == PASSWORD {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        _offer: server::PublicKeyOffer<'_>,
    ) -> Result<Auth, Self::Error> {
        self.seen.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        key: server::VerifiedPublicKey<'_>,
    ) -> Result<Auth, Self::Error> {
        self.seen.auth_attempts.fetch_add(1, Ordering::SeqCst);
        Ok(
            if user == USER && key.public_key.key_data() == self.client_key.key_data() {
                Auth::Accept
            } else {
                Auth::reject()
            },
        )
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    /// The tool's read-only check of a refused socket: answers as a host would.
    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let command = String::from_utf8_lossy(data).into_owned();
        self.seen.commands.lock().unwrap().push(command.clone());
        let answer = if command.contains("'/refused.sock'") {
            "usable\n"
        } else if command.contains("'/noaccess.sock'") {
            "noaccess\n"
        } else {
            "missing\n"
        };
        session.channel_success(channel)?;
        session.data(channel, answer.as_bytes().to_vec())?;
        session.exit_status_request(channel, 0)?;
        session.eof(channel)?;
        session.close(channel)?;
        Ok(())
    }

    async fn channel_open_direct_streamlocal(
        &mut self,
        channel: Channel<Msg>,
        socket_path: &str,
        reply: server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.seen.sessions.lock().unwrap().push(session.handle());
        let api = match socket_path {
            "/var/run/docker.sock" => "1.47",
            "/old/docker.sock" => "1.40",
            "/forbidden.sock" => {
                reply
                    .reject(ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
                return Ok(());
            }
            _ => {
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
                return Ok(());
            }
        };
        reply.accept().await;
        let paths = Arc::clone(&self.seen.paths);
        tokio::spawn(async move {
            let service = hyper::service::service_fn(move |mut request: Request<_>| {
                let paths = Arc::clone(&paths);
                async move {
                    let path = request.uri().path().to_owned();
                    let full = request
                        .uri()
                        .path_and_query()
                        .map_or(path.clone(), |p| p.to_string());
                    paths.lock().unwrap().push(full.clone());
                    if path == "/v1.47/exec/e1/start" {
                        let upgrade = hyper::upgrade::on(&mut request);
                        tokio::spawn(fake_process(upgrade));
                        return Ok::<_, Infallible>(
                            Response::builder()
                                .status(101)
                                .header("connection", "Upgrade")
                                .header("upgrade", "tcp")
                                .body(Full::default())
                                .unwrap(),
                        );
                    }
                    if path.ends_with("/archive") {
                        return Ok::<_, Infallible>(archive(&full));
                    }
                    Ok::<_, Infallible>(engine(api, request.method(), &path))
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(channel.into_stream()), service)
                .with_upgrades()
                .await;
        });
        Ok(())
    }
}

fn json_response(body: Value) -> Response<Full<Bytes>> {
    Response::builder()
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap()
}

/// The exec's process on the upgraded connection: a prompt, each line typed echoed back in
/// capitals, `exit` ends it (exit code 3, from `/exec/e1/json`).
async fn fake_process(upgrade: hyper::upgrade::OnUpgrade) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let Ok(io) = upgrade.await else { return };
    let mut io = TokioIo::new(io);
    let _ = io.write_all(b"$ ").await;
    let mut line = Vec::new();
    let mut buf = [0u8; 256];
    while let Ok(n) = io.read(&mut buf).await {
        if n == 0 {
            return;
        }
        for &b in &buf[..n] {
            if b == b'\r' {
                if line == b"exit" {
                    let _ = io.write_all(b"\r\nbye\r\n").await;
                    let _ = io.shutdown().await;
                    return;
                }
                let reply = format!(
                    "\r\n{}\r\n$ ",
                    String::from_utf8_lossy(&line).to_uppercase()
                );
                let _ = io.write_all(reply.as_bytes()).await;
                line.clear();
            } else if b == 0x03 {
                let _ = io.write_all(b"^C\r\n$ ").await;
                line.clear();
            } else {
                line.push(b);
            }
        }
    }
}

/// A log frame: stream byte, three zero bytes, big-endian length, payload.
fn log_frame(stream: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = vec![stream, 0, 0, 0];
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn bytes_response(body: Vec<u8>) -> Response<Full<Bytes>> {
    Response::builder()
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

fn no_content(status: u16) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::default())
        .unwrap()
}

fn conflict(message: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(409)
        .body(Full::new(Bytes::from(
            json!({ "message": message }).to_string(),
        )))
        .unwrap()
}

/// A ustar entry of the fake archives.
fn tar_entry(path: &str, kind: u8, data: &[u8]) -> Vec<u8> {
    let mut h = vec![0u8; 512];
    h[..path.len()].copy_from_slice(path.as_bytes());
    h[100..107]
        .copy_from_slice(format!("{:07o}", if kind == b'5' { 0o755 } else { 0o644 }).as_bytes());
    h[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
    h[136..147].copy_from_slice(format!("{:011o}", 1_795_161_600u64).as_bytes());
    h[156] = kind;
    h[257..263].copy_from_slice(b"ustar\0");
    h.extend_from_slice(data);
    h.resize(h.len().div_ceil(512) * 512, 0);
    h
}

/// `GET /containers/web/archive?path=…`: `/app` (a folder with a sub-folder), its files, or
/// Docker's 404; the stat header as Docker sends it.
fn archive(full: &str) -> Response<Full<Bytes>> {
    use base64::Engine as _;
    let path: String =
        url::form_urlencoded::parse(full.split_once('?').map_or("", |(_, q)| q).as_bytes())
            .find(|(k, _)| k == "path")
            .map(|(_, v)| v.into_owned())
            .unwrap_or_default();
    let (stat, mut tar) = match path.as_str() {
        "/app" => (
            json!({ "name": "app", "size": 4096, "mode": 2_147_484_141u64, "linkTarget": "" }),
            [
                tar_entry("app/", b'5', b""),
                tar_entry("app/robots.txt", b'0', b"User-agent: *\n"),
                tar_entry("app/data.bin", b'0', &[0, 1, 2, 3]),
                tar_entry("app/sub/", b'5', b""),
                tar_entry("app/sub/deep.txt", b'0', b"deep"),
            ]
            .concat(),
        ),
        "/app/robots.txt" => (
            json!({ "name": "robots.txt", "size": 14, "mode": 420, "linkTarget": "" }),
            tar_entry("robots.txt", b'0', b"User-agent: *\n"),
        ),
        "/app/data.bin" => (
            json!({ "name": "data.bin", "size": 4, "mode": 420, "linkTarget": "" }),
            tar_entry("data.bin", b'0', &[0, 1, 2, 3]),
        ),
        _ => {
            return Response::builder()
                .status(404)
                .body(Full::new(Bytes::from(
                    json!({ "message": format!("Could not find the file {path} in container web") }).to_string(),
                )))
                .unwrap();
        }
    };
    tar.extend_from_slice(&[0u8; 1024]);
    let header = base64::engine::general_purpose::STANDARD.encode(stat.to_string());
    Response::builder()
        .header("content-type", "application/x-tar")
        .header("x-docker-container-path-stat", header)
        .body(Full::new(Bytes::from(tar)))
        .unwrap()
}

/// The fake Docker Engine.
fn engine(api: &str, method: &hyper::Method, path: &str) -> Response<Full<Bytes>> {
    use hyper::Method;
    match (method, path) {
        (&Method::GET, "/v1.47/containers/json") => json_response(json!([
            {
                "Id": "aaa1", "Names": ["/shop-web-1"], "Image": "busybox:1.37", "ImageID": "sha256:b",
                "Command": "httpd -f", "Created": 1795161601, "State": "running",
                "Status": "Up 3 hours (healthy)",
                "Ports": [{ "IP": "127.0.0.1", "PrivatePort": 8080, "PublicPort": 18080, "Type": "tcp" }],
                "Labels": { "com.docker.compose.project": "shop", "com.docker.compose.service": "web",
                            "com.docker.compose.project.working_dir": "/srv/shop" },
                "Mounts": [{ "Type": "volume", "Name": "shop_data" }],
                "NetworkSettings": { "Networks": { "shop_default": { "NetworkID": "n1" } } },
            },
            {
                "Id": "bbb2", "Names": ["/stopped"], "Image": "busybox:1.37", "ImageID": "sha256:b",
                "Command": "sh -c 'exit 3'", "Created": 1795161000, "State": "exited",
                "Status": "Exited (3) 2 hours ago", "Ports": [], "Labels": {},
                "Mounts": [{ "Type": "volume", "Name": "cache" }],
                "NetworkSettings": { "Networks": { "bridge": { "NetworkID": "n0" } } },
            },
        ])),
        (&Method::GET, "/v1.47/containers/web/json") => json_response(json!({
            "Id": "aaa1", "Name": "/shop-web-1", "Created": "2026-11-20T07:00:00Z", "Image": "sha256:b",
            "State": { "Status": "running", "Running": true, "StartedAt": "2026-11-20T07:00:01Z",
                       "FinishedAt": "0001-01-01T00:00:00Z", "ExitCode": 0 },
            "Config": { "Image": "busybox:1.37", "Tty": false, "Env": ["SECRET=hunter2"], "Cmd": ["httpd"] },
            "HostConfig": { "RestartPolicy": { "Name": "unless-stopped" } },
        })),
        (&Method::GET, "/v1.47/containers/tty/json") => {
            json_response(json!({ "Id": "ccc3", "Name": "/tty", "Config": { "Tty": true } }))
        }
        (&Method::GET, "/v1.47/containers/web/logs") => {
            let mut body = log_frame(1, b"2026-11-20T07:00:01.000000001Z listening on :8080\n");
            body.extend(log_frame(2, b"2026-11-20T07:00:02.5Z warning 1\n2026-11-20T07:00:03Z warn"));
            body.extend(log_frame(2, b"ing 2\n"));
            bytes_response(body)
        }
        (&Method::GET, "/v1.47/containers/tty/logs") => bytes_response(
            b"2026-11-20T07:00:01Z \x1b[32mgreen\x1b[0m tty line\r\n".to_vec(),
        ),
        (&Method::POST, "/v1.47/containers/web/start") => no_content(204),
        (&Method::POST, "/v1.47/containers/stopped/start") => no_content(304),
        (&Method::DELETE, "/v1.47/containers/stopped") => no_content(204),
        (&Method::DELETE, "/v1.47/containers/web") => Response::builder()
            .status(409)
            .body(Full::new(Bytes::from(
                json!({ "message": "cannot remove container \"/shop-web-1\": container is running: stop the container before removing or force remove" }).to_string(),
            )))
            .unwrap(),
        (&Method::POST, "/v1.47/containers/web/exec") => json_response(json!({ "Id": "e1" })),
        (&Method::POST, "/v1.47/exec/e1/resize") => no_content(201),
        (&Method::GET, "/v1.47/exec/e1/json") => {
            json_response(json!({ "Running": false, "ExitCode": 3 }))
        }
        (&Method::GET, "/v1.47/containers/web/stats") => bytes_response(
            [
                json!({ "read": "2026-11-20T07:00:01Z",
                        "cpu_stats": { "cpu_usage": { "total_usage": 100 }, "system_cpu_usage": 1000, "online_cpus": 2 },
                        "precpu_stats": { "cpu_usage": { "total_usage": 0 } },
                        "memory_stats": { "usage": 2048, "limit": 4096, "stats": { "inactive_file": 1024 } },
                        "pids_stats": { "current": 3 } }),
                json!({ "read": "2026-11-20T07:00:02Z",
                        "cpu_stats": { "cpu_usage": { "total_usage": 600 }, "system_cpu_usage": 2000, "online_cpus": 2 },
                        "precpu_stats": { "cpu_usage": { "total_usage": 100 }, "system_cpu_usage": 1000 },
                        "memory_stats": { "usage": 3072, "limit": 4096, "stats": { "inactive_file": 1024 } },
                        "networks": { "eth0": { "rx_bytes": 10, "tx_bytes": 5 } },
                        "pids_stats": { "current": 4 } }),
            ]
            .iter()
            .map(|e| format!("{e}\n"))
            .collect::<String>()
            .into_bytes(),
        ),
        (&Method::GET, "/v1.47/events") => bytes_response(
            [
                json!({ "Type": "container", "Action": "start", "Actor": { "ID": "aaa1", "Attributes": { "name": "shop-web-1" } }, "timeNano": 1_795_161_601_000_000_000u64 }),
                json!({ "Type": "network", "Action": "connect", "Actor": { "ID": "n1", "Attributes": { "container": "aaa1" } }, "time": 1795161602 }),
            ]
            .iter()
            .map(|e| format!("{e}\n"))
            .collect::<String>()
            .into_bytes(),
        ),
        // Images, volumes and networks (batch 3).
        (&Method::GET, "/v1.47/images/json") => json_response(json!([
            { "Id": "sha256:b", "RepoTags": ["busybox:1.37"], "RepoDigests": ["busybox@sha256:bd"],
              "Created": 1795161000, "Size": 4_400_000, "Labels": null },
            { "Id": "sha256:d", "RepoTags": ["<none>:<none>"], "RepoDigests": [], "Created": 1795160000, "Size": 1000 },
        ])),
        (&Method::GET, "/v1.47/images/busybox:1.37/json") => {
            json_response(json!({ "Id": "sha256:b", "RepoTags": ["busybox:1.37"] }))
        }
        (&Method::DELETE, "/v1.47/images/busybox:1.37") => conflict(
            "conflict: unable to delete busybox:1.37 (cannot be forced) - image is being used by running container aaa1",
        ),
        (&Method::DELETE, "/v1.47/images/sha256:d") => {
            json_response(json!([{ "Deleted": "sha256:d" }]))
        }
        (&Method::GET, "/v1.47/volumes") => json_response(json!({ "Volumes": [
            { "Name": "shop_data", "Driver": "local", "Scope": "local", "Mountpoint": "/var/lib/docker/volumes/shop_data/_data",
              "Labels": { "com.docker.compose.project": "shop" } },
            { "Name": "cache", "Driver": "local", "Scope": "local", "Mountpoint": "/var/lib/docker/volumes/cache/_data" },
            { "Name": "spare", "Driver": "local", "Scope": "local", "Mountpoint": "/var/lib/docker/volumes/spare/_data" },
        ], "Warnings": null })),
        (&Method::GET, "/v1.47/system/df") => json_response(json!({
            "LayersSize": 4_401_000,
            "Images": [
                { "Id": "sha256:b", "Size": 4_400_000, "SharedSize": 0, "Containers": 2 },
                { "Id": "sha256:d", "Size": 1000, "SharedSize": 0, "Containers": 0 },
            ],
            "Containers": [
                { "Id": "aaa1", "State": "running", "SizeRw": 512 },
                { "Id": "bbb2", "State": "exited", "SizeRw": 64 },
            ],
            "Volumes": [
                { "Name": "shop_data", "UsageData": { "Size": 2048, "RefCount": 1 } },
                { "Name": "spare", "UsageData": { "Size": -1, "RefCount": 0 } },
            ],
            "BuildCache": [{ "ID": "k1", "Size": 300, "InUse": false, "Shared": false }],
        })),
        // Processes (batch 4): a BusyBox host's `ps` prints four columns.
        (&Method::GET, "/v1.47/containers/web/top") => json_response(json!({
            "Titles": ["PID", "USER", "TIME", "COMMAND"],
            "Processes": [["4121", "root", "0:00", "httpd -f"], ["4188", "root", "0:00", "sh"]],
        })),
        (&Method::GET, "/v1.47/containers/stopped/top") => {
            conflict("Container bbb2 is not running")
        }
        (&Method::GET, "/v1.47/volumes/spare") => {
            json_response(json!({ "Name": "spare", "Driver": "local" }))
        }
        (&Method::DELETE, "/v1.47/volumes/spare") => no_content(204),
        (&Method::DELETE, "/v1.47/volumes/shop_data") => {
            conflict("remove shop_data: volume is in use - [aaa1]")
        }
        (&Method::GET, "/v1.47/networks") => json_response(json!([
            { "Id": "n0", "Name": "bridge", "Driver": "bridge", "Scope": "local",
              "IPAM": { "Config": [{ "Subnet": "172.17.0.0/16", "Gateway": "172.17.0.1" }] } },
            { "Id": "n1", "Name": "shop_default", "Driver": "bridge", "Scope": "local", "Attachable": false,
              "IPAM": { "Config": [{ "Subnet": "172.18.0.0/16", "Gateway": "172.18.0.1" }] },
              "Labels": { "com.docker.compose.project": "shop" } },
        ])),
        (&Method::GET, "/v1.47/networks/n1") => {
            json_response(json!({ "Id": "n1", "Name": "shop_default" }))
        }
        (&Method::DELETE, "/v1.47/networks/bridge") => Response::builder()
            .status(403)
            .body(Full::new(Bytes::from(
                json!({ "message": "bridge is a pre-defined network and cannot be removed" })
                    .to_string(),
            )))
            .unwrap(),
        (&Method::DELETE, "/v1.47/networks/n1") => no_content(204),
        (_, path) => engine_basics(api, path),
    }
}

fn engine_basics(api: &str, path: &str) -> Response<Full<Bytes>> {
    match path {
        "/_ping" => Response::builder()
            .header("api-version", api)
            .body(Full::new(Bytes::from_static(b"OK")))
            .unwrap(),
        "/v1.47/info" => json_response(json!({
            "Name": "build-host", "OperatingSystem": "Debian GNU/Linux 12 (bookworm)",
            "OSType": "linux", "KernelVersion": "6.1.0-28-amd64", "Architecture": "x86_64",
            "NCPU": 8, "MemTotal": 33_600_000_000u64, "ServerVersion": "27.4.1",
            "Driver": "overlay2", "DriverStatus": [["Backing Filesystem", "extfs"]],
            "LoggingDriver": "json-file", "CgroupVersion": "2", "CgroupDriver": "systemd",
            "SecurityOptions": ["name=apparmor", "name=seccomp,profile=builtin"],
            "DockerRootDir": "/var/lib/docker", "Containers": 11, "ContainersRunning": 7,
            "ContainersPaused": 1, "ContainersStopped": 3, "Images": 14,
            "Warnings": ["WARNING: bridge-nf-call-iptables is disabled"],
        })),
        "/v1.47/version" => json_response(json!({
            "Version": "27.4.1", "ApiVersion": "1.47", "MinAPIVersion": "1.24",
            "Components": [{ "Name": "Engine", "Version": "27.4.1" },
                           { "Name": "containerd", "Version": "1.7.24" }],
        })),
        _ => Response::builder()
            .status(404)
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(
                json!({ "message": format!("page not found: {path}") }).to_string(),
            )))
            .unwrap(),
    }
}

struct Lab {
    addr: SocketAddr,
    host_key: PublicKey,
    client_key_text: String,
    seen: Seen,
}

async fn lab() -> Lab {
    let host_key = key();
    let client_key = key();
    let seen = Seen::default();
    let config = server::Config {
        keys: vec![host_key.clone()],
        auth_rejection_time: std::time::Duration::ZERO,
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        ..server::Config::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut host = Host {
        client_key: client_key.public_key().clone(),
        seen: seen.clone(),
    };
    tokio::spawn(async move {
        let _ = host.run_on_socket(Arc::new(config), &listener).await;
    });
    Lab {
        addr,
        host_key: host_key.public_key().clone(),
        client_key_text: client_key.to_openssh(LineEnding::LF).unwrap().to_string(),
        seen,
    }
}

impl Lab {
    fn profile(&self, extra: Value) -> Value {
        let mut profile = json!({
            "name": "build-host",
            "host": "127.0.0.1",
            "port": self.addr.port(),
            "username": USER,
            "auth": "privateKey",
            "privateKey": self.client_key_text,
            "hostKey": fingerprint(&self.host_key),
        });
        for (k, v) in extra.as_object().unwrap() {
            profile[k] = v.clone();
        }
        profile
    }
}

fn details(err: &ErrorPayload) -> &Value {
    err.details.as_ref().expect("ToolError details")
}

async fn setup() -> (TestServer, Lab, Tab) {
    let t = start().await;
    let lab = lab().await;
    let browser = t.browser().await;
    let mut tab = t.tab(&browser).await;
    tab.subscribe_events(1).await;
    (t, lab, tab)
}

#[tokio::test]
async fn an_unknown_host_key_stops_the_connection_before_any_login() {
    let (_t, lab, mut tab) = setup().await;
    let profile = lab.profile(json!({ "hostKey": null }));
    tab.call(2, "docker.connect", json!({ "profile": profile }))
        .await;
    let err = tab.error(2, Code::FailedPrecondition).await;
    let d = details(&err);
    assert_eq!(d["kind"], "HostKey");
    assert_eq!(d["hostKey"]["state"], "unknown");
    assert_eq!(d["hostKey"]["algorithm"], "ssh-ed25519");
    assert_eq!(
        d["hostKey"]["fingerprintSha256"],
        fingerprint(&lab.host_key)["fingerprintSha256"]
    );
    assert!(d["hostKey"].get("expected").is_none());
    assert_eq!(
        lab.seen.auth_attempts.load(Ordering::SeqCst),
        0,
        "nothing may be sent to a host whose key is not trusted"
    );

    // A key that differs from the trusted one: `changed`, with both.
    let trusted = fingerprint(&key().public_key().clone());
    let profile = lab.profile(json!({ "hostKey": trusted }));
    tab.call(3, "docker.connect", json!({ "profile": profile }))
        .await;
    let err = tab.error(3, Code::FailedPrecondition).await;
    let d = details(&err);
    assert_eq!(d["hostKey"]["state"], "changed");
    assert_eq!(d["hostKey"]["expected"], trusted);
    assert!(err.message.contains("Nothing was sent"));
    assert_eq!(lab.seen.auth_attempts.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_trusted_host_connects_with_a_key_and_shows_its_facts() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let out = tab.result(2).await;
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    let host = &out["host"];
    assert_eq!(host["name"], "build-host");
    assert_eq!(host["apiVersion"], "1.47");
    assert_eq!(host["serverApiVersion"], "1.47");
    assert_eq!(host["minApiVersion"], "1.24");
    assert_eq!(host["containerdVersion"], "1.7.24");
    assert_eq!(host["storageBackingFilesystem"], "extfs");
    assert_eq!(host["securityOptions"], json!(["apparmor", "seccomp"]));
    assert_eq!(host["rootless"], false);
    assert_eq!(host["containersRunning"], 7);
    assert_eq!(
        host["ssh"]["target"],
        format!("lab@127.0.0.1:{}", lab.addr.port())
    );
    assert_eq!(host["ssh"]["hostKey"], fingerprint(&lab.host_key));
    assert_eq!(host["ssh"]["socketPath"], "/var/run/docker.sock");
    assert_eq!(host["ssh"]["auth"], "privateKey");
    tab.event(1, |e| e["status"] == "connected").await;

    // Every request but the ping is on the negotiated version.
    let paths = lab.seen.paths.lock().unwrap().clone();
    assert!(
        paths
            .iter()
            .all(|p| p == "/_ping" || p.starts_with("/v1.47/")),
        "{paths:?}"
    );

    tab.call(3, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    assert_eq!(tab.result(3).await["kernelVersion"], "6.1.0-28-amd64");

    tab.call(4, "docker.disconnect", json!({ "connId": conn_id }))
        .await;
    tab.result(4).await;
    tab.call(5, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    not_found_connection(&tab.error(5, Code::NotFound).await);
}

#[tokio::test]
async fn passwords_and_keys_are_checked_and_never_echoed() {
    let (_t, lab, mut tab) = setup().await;
    let wrong = lab.profile(json!({ "auth": "password", "password": "hunter2" }));
    tab.call(2, "docker.connect", json!({ "profile": wrong }))
        .await;
    let err = tab.error(2, Code::Unauthenticated).await;
    assert_eq!(details(&err)["kind"], "Auth");
    assert!(
        err.message.contains("rejected the password"),
        "{}",
        err.message
    );
    assert!(!err.message.contains("hunter2"));

    let right = lab.profile(json!({ "auth": "password", "password": PASSWORD }));
    tab.call(3, "docker.connect", json!({ "profile": right }))
        .await;
    assert_eq!(tab.result(3).await["host"]["ssh"]["auth"], "password");

    // Another key than the authorized one.
    let other = key().to_openssh(LineEnding::LF).unwrap().to_string();
    tab.call(
        4,
        "docker.connect",
        json!({ "profile": lab.profile(json!({ "privateKey": other })) }),
    )
    .await;
    let err = tab.error(4, Code::Unauthenticated).await;
    assert!(err.message.contains("rejected the private key"));

    // A key that does not parse is the field's problem, found before connecting.
    tab.call(
        5,
        "docker.connect",
        json!({ "profile": lab.profile(json!({ "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n" })) }),
    )
    .await;
    let err = tab.error(5, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "privateKey");
}

#[tokio::test]
async fn a_host_that_does_not_forward_the_socket_is_explained() {
    let (_t, lab, mut tab) = setup().await;
    let connect_error =
        |socket: &'static str| json!({ "profile": lab.profile(json!({ "socketPath": socket })) });
    // OpenSSH's answer when its configuration refuses: "connect failed"; the check finds a
    // usable socket, so the error is about sshd's settings.
    tab.call(2, "docker.connect", connect_error("/refused.sock"))
        .await;
    let err = tab.error(2, Code::PermissionDenied).await;
    assert_eq!(details(&err)["kind"], "Forbidden");
    assert!(err.message.contains("SSH works, Docker's socket does not"));
    assert!(err.message.contains("AllowStreamLocalForwarding"));
    assert!(err.message.contains("AllowTcpForwarding"));
    assert_eq!(details(&err)["remote"]["code"], "2");
    let commands = lab.seen.commands.lock().unwrap().clone();
    assert_eq!(commands.len(), 1);
    assert!(
        commands[0].starts_with("if test -S '/refused.sock'"),
        "{commands:?}"
    );

    tab.call(3, "docker.connect", connect_error("/noaccess.sock"))
        .await;
    let err = tab.error(3, Code::PermissionDenied).await;
    assert!(
        err.message.contains("usermod -aG docker lab"),
        "{}",
        err.message
    );

    tab.call(
        4,
        "docker.connect",
        connect_error("/run/user/1000/docker.sock"),
    )
    .await;
    let err = tab.error(4, Code::Unavailable).await;
    assert!(
        err.message
            .contains("no socket at /run/user/1000/docker.sock"),
        "{}",
        err.message
    );

    // A server that says "administratively prohibited" (not OpenSSH) and lets commands run.
    tab.call(5, "docker.connect", connect_error("/forbidden.sock"))
        .await;
    let err = tab.error(5, Code::Unavailable).await;
    assert!(
        err.message.contains("no socket at /forbidden.sock"),
        "{}",
        err.message
    );

    // An engine older than API 1.41.
    tab.call(6, "docker.connect", connect_error("/old/docker.sock"))
        .await;
    let err = tab.error(6, Code::FailedPrecondition).await;
    assert_eq!(details(&err)["kind"], "Conflict");
    assert!(err.message.contains("1.41"));
}

#[tokio::test]
async fn a_session_the_host_ends_turns_the_connection_failed() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    let handle = lab.seen.sessions.lock().unwrap()[0].clone();
    handle
        .disconnect(Disconnect::ByApplication, "maintenance".into(), "en".into())
        .await
        .unwrap();
    let event = tab
        .event(1, |e| e["status"] == "failed" && e["connId"] == conn_id)
        .await;
    assert!(
        event["message"]
            .as_str()
            .unwrap()
            .contains("the host closed the SSH connection"),
        "{event}"
    );
    tab.call(3, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    let err = tab.error(3, Code::Unavailable).await;
    assert!(err.message.contains("connect again"), "{}", err.message);
}

/// Splits a `jsonl` chunk into its lines.
fn lines(chunk: &[u8]) -> Vec<Value> {
    assert_eq!(chunk.last(), Some(&b'\n'), "whole lines only");
    chunk
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_slice(l).unwrap())
        .collect()
}

/// Reads a stream's chunks until it ends; returns the lines and the summary.
async fn drain(tab: &mut Tab, id: u32) -> (Vec<Value>, Value) {
    let mut all = Vec::new();
    loop {
        let frame = tab.frame(id).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                all.extend(lines(&frame.payload));
                tab.credit(id, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                return (all, serde_json::from_slice(&frame.payload).unwrap());
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    }
}

#[tokio::test]
async fn containers_are_listed_acted_on_and_their_logs_split_by_stream() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();

    tab.call(3, "docker.containers.list", json!({ "connId": conn_id }))
        .await;
    let rows = tab.result(3).await;
    assert_eq!(rows[0]["name"], "shop-web-1");
    assert_eq!(rows[0]["health"], "healthy");
    assert_eq!(rows[0]["project"], "shop");
    assert_eq!(rows[0]["ports"][0]["publicPort"], 18080);
    assert_eq!(rows[1]["exitCode"], 3);

    tab.call(4, "docker.compose.projects", json!({ "connId": conn_id }))
        .await;
    let projects = tab.result(4).await;
    assert_eq!(projects[0]["project"], "shop");
    assert_eq!(projects[0]["workingDir"], "/srv/shop");
    assert_eq!(projects[0]["services"][0]["containers"][0], "shop-web-1");

    // One result per id: a started one, one already running (304), one refused.
    tab.call(
        5,
        "docker.containers.start",
        json!({ "connId": conn_id, "ids": ["web", "stopped", "missing"] }),
    )
    .await;
    let results = tab.result(5).await;
    assert_eq!(results[0], json!({ "id": "web" }));
    assert_eq!(results[1], json!({ "id": "stopped" }));
    assert!(
        results[2]["error"]
            .as_str()
            .unwrap()
            .contains("page not found")
    );
    tab.confirmed(
        6,
        "docker.containers.remove",
        json!({ "connId": conn_id, "ids": ["stopped", "web"], "force": false, "volumes": true }),
    )
    .await;
    let results = tab.result(6).await;
    assert_eq!(results[0], json!({ "id": "stopped" }));
    assert!(
        results[1]["error"]
            .as_str()
            .unwrap()
            .contains("container is running")
    );

    // A name that would leave the path is refused before anything is sent.
    tab.call(
        7,
        "docker.containers.stop",
        json!({ "connId": conn_id, "ids": ["../images"] }),
    )
    .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "ids");

    tab.call(
        8,
        "docker.containers.logs",
        json!({ "connId": conn_id, "id": "web", "follow": false, "tail": 100,
                "since": "2026-11-20T07:00:00Z", "streamId": "logs-1" }),
    )
    .await;
    let (log, summary) = drain(&mut tab, 8).await;
    assert_eq!(
        log,
        vec![
            json!({ "ts": "2026-11-20T07:00:01.000000001Z", "stream": "stdout", "text": "listening on :8080" }),
            json!({ "ts": "2026-11-20T07:00:02.5Z", "stream": "stderr", "text": "warning 1" }),
            json!({ "ts": "2026-11-20T07:00:03Z", "stream": "stderr", "text": "warning 2" }),
        ]
    );
    assert_eq!(
        summary,
        json!({ "lines": 3, "tty": false, "endReason": "end" })
    );

    tab.call(
        9,
        "docker.containers.logs",
        json!({ "connId": conn_id, "id": "tty", "follow": true, "streamId": "logs-2" }),
    )
    .await;
    let (log, summary) = drain(&mut tab, 9).await;
    assert_eq!(
        log,
        vec![
            json!({ "ts": "2026-11-20T07:00:01Z", "stream": "stdout", "text": "\u{1b}[32mgreen\u{1b}[0m tty line" })
        ]
    );
    assert_eq!(summary["tty"], true);

    tab.call(
        10,
        "docker.events",
        json!({ "connId": conn_id, "streamId": "events-1", "container": "web" }),
    )
    .await;
    let (events, _) = drain(&mut tab, 10).await;
    assert_eq!(events[0]["kind"], "container");
    assert_eq!(events[0]["name"], "shop-web-1");
    assert_eq!(events[0]["timeMs"], 1_795_161_601_000u64);
    assert_eq!(events[1]["timeMs"], 1_795_161_602_000u64);

    tab.call(
        11,
        "docker.containers.inspect",
        json!({ "connId": conn_id, "id": "web" }),
    )
    .await;
    let inspect = tab.result(11).await;
    assert_eq!(inspect["overview"]["name"], "shop-web-1");
    assert_eq!(inspect["overview"]["restartPolicy"], "unless-stopped");
    assert_eq!(inspect["overview"]["env"][0]["value"], "hunter2");
    assert!(inspect["overview"].get("finishedAt").is_none());
    assert_eq!(inspect["inspect"]["Id"], "aaa1");
    tab.call(
        12,
        "docker.containers.inspect",
        json!({ "connId": conn_id, "id": "missing" }),
    )
    .await;
    let err = tab.error(12, Code::NotFound).await;
    assert_eq!(details(&err)["resource"], "container");

    let paths = lab.seen.paths.lock().unwrap().clone();
    assert!(paths.contains(
        &"/v1.47/containers/web/logs?stdout=1&stderr=1&timestamps=1&follow=0&tail=100&since=1795158000.000000000".to_owned()
    ), "{paths:?}");
    assert!(paths.contains(&"/v1.47/containers/stopped?force=0&v=1".to_owned()));
    assert!(!paths.iter().any(|p| p.contains("images")));
}

/// The terminal's output until it shows `needle` (channel byte 1 first in every chunk).
async fn output_until(tab: &mut Tab, id: u32, needle: &str) -> String {
    let mut text = String::new();
    while !text.contains(needle) {
        let chunk = tab.chunk(id).await;
        assert_eq!(chunk[0], 1, "the stdout channel");
        text.push_str(&String::from_utf8_lossy(&chunk[1..]));
        tab.credit(id, 1).await;
    }
    text
}

fn b64(text: &str) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(text)
}

#[tokio::test]
async fn an_exec_terminal_takes_input_resizes_and_ends_with_the_exit_code() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();

    tab.call(
        3,
        "docker.containers.exec",
        json!({ "connId": conn_id, "id": "web", "cols": 100, "rows": 30, "terminalId": "term-1" }),
    )
    .await;
    output_until(&mut tab, 3, "$ ").await;
    tab.call(
        4,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64("hello\r") }),
    )
    .await;
    tab.result(4).await;
    output_until(&mut tab, 3, "HELLO").await;
    tab.call(
        5,
        "term.signal",
        json!({ "terminalId": "term-1", "signal": "interrupt" }),
    )
    .await;
    tab.result(5).await;
    output_until(&mut tab, 3, "^C").await;
    tab.call(
        6,
        "term.resize",
        json!({ "terminalId": "term-1", "cols": 120, "rows": 40 }),
    )
    .await;
    tab.result(6).await;
    tab.call(
        7,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64("exit\r") }),
    )
    .await;
    tab.result(7).await;
    let mut text = String::new();
    let summary = loop {
        let frame = tab.frame(3).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                text.push_str(&String::from_utf8_lossy(&frame.payload[1..]));
                tab.credit(3, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                break serde_json::from_slice::<Value>(&frame.payload).unwrap();
            }
            other => panic!("{other:?}: {}", String::from_utf8_lossy(&frame.payload)),
        }
    };
    assert!(text.contains("bye"), "{text}");
    assert_eq!(summary, json!({ "exitCode": 3 }));
    let exit = tab
        .event(1, |e| {
            e["kind"] == "TerminalExit" && e["terminalId"] == "term-1"
        })
        .await;
    assert_eq!(exit["exitCode"], 3);
    assert_eq!(exit["reason"], "exited with code 3");
    // The terminal is gone: more input is NotFound.
    tab.call(
        8,
        "term.write",
        json!({ "terminalId": "term-1", "data": b64("x") }),
    )
    .await;
    tab.error(8, Code::NotFound).await;

    let paths = lab.seen.paths.lock().unwrap().clone();
    assert!(
        paths.contains(&"/v1.47/exec/e1/resize?h=30&w=100".to_owned()),
        "{paths:?}"
    );
    assert!(
        paths.contains(&"/v1.47/exec/e1/resize?h=40&w=120".to_owned()),
        "{paths:?}"
    );

    // A bad size is refused before anything is created.
    tab.call(
        9,
        "docker.containers.exec",
        json!({ "connId": conn_id, "id": "web", "cols": 0, "rows": 30, "terminalId": "term-2" }),
    )
    .await;
    assert_eq!(
        details(&tab.error(9, Code::InvalidArgument).await)["field"],
        "cols"
    );
}

#[tokio::test]
async fn stats_come_as_samples_and_a_stopped_container_has_none() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    tab.call(
        3,
        "docker.containers.stats",
        json!({ "connId": conn_id, "id": "web", "streamId": "stats-1" }),
    )
    .await;
    let (samples, summary) = drain(&mut tab, 3).await;
    let last = samples.last().unwrap();
    assert_eq!(last["cpuPercent"], 100.0);
    assert_eq!(last["memoryUsed"], 2048);
    assert_eq!(last["rxBytes"], 10);
    assert_eq!(last["pids"], 4);
    assert_eq!(
        summary["samples"].as_u64().unwrap() + summary["dropped"].as_u64().unwrap(),
        2,
        "{summary}"
    );
    tab.call(
        4,
        "docker.containers.stats",
        json!({ "connId": conn_id, "id": "tty", "streamId": "stats-2" }),
    )
    .await;
    let err = tab.error(4, Code::FailedPrecondition).await;
    assert_eq!(details(&err)["kind"], "Conflict");
}

#[tokio::test]
async fn the_host_has_its_disk_usage_and_counts_and_a_container_its_processes() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    tab.call(3, "docker.host.df", json!({ "connId": conn_id }))
        .await;
    let df = tab.result(3).await;
    assert_eq!(
        df["images"],
        json!({ "count": 2, "active": 1, "size": 4_401_000, "reclaimable": 1000 })
    );
    assert_eq!(
        df["containers"],
        json!({ "count": 2, "active": 1, "size": 576, "reclaimable": 64 })
    );
    // `spare`'s size is unknown (-1): it counts as 0.
    assert_eq!(
        df["volumes"],
        json!({ "count": 2, "active": 1, "size": 2048, "reclaimable": 0 })
    );
    assert_eq!(
        df["buildCache"],
        json!({ "count": 1, "active": 0, "size": 300, "reclaimable": 300 })
    );

    tab.call(4, "docker.host.counts", json!({ "connId": conn_id }))
        .await;
    assert_eq!(
        tab.result(4).await,
        json!({ "images": 2, "volumes": 3, "networks": 2 })
    );

    tab.call(
        5,
        "docker.containers.top",
        json!({ "connId": conn_id, "id": "web" }),
    )
    .await;
    let top = tab.result(5).await;
    assert_eq!(top["titles"], json!(["PID", "USER", "TIME", "COMMAND"]));
    assert_eq!(
        top["processes"][0],
        json!(["4121", "root", "0:00", "httpd -f"])
    );
    tab.call(
        6,
        "docker.containers.top",
        json!({ "connId": conn_id, "id": "stopped" }),
    )
    .await;
    let err = tab.error(6, Code::FailedPrecondition).await;
    assert_eq!(details(&err)["kind"], "Conflict");
    tab.call(
        7,
        "docker.containers.top",
        json!({ "connId": conn_id, "id": "../info" }),
    )
    .await;
    let err = tab.error(7, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "id");
}

#[tokio::test]
async fn a_containers_files_are_listed_read_and_downloaded_from_its_archive() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();
    tab.call(
        3,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "web", "path": "/app" }),
    )
    .await;
    let list = tab.result(3).await;
    assert_eq!(list["kind"], "dir");
    let names: Vec<&str> = list["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["sub", "data.bin", "robots.txt"]);
    assert_eq!(
        list["entries"][2],
        json!({ "name": "robots.txt", "kind": "file", "size": 14, "mode": 420, "mtimeMs": 1_795_161_600_000u64 })
    );
    assert!(list.get("truncated").is_none());

    tab.call(
        4,
        "docker.containers.files.read",
        json!({ "connId": conn_id, "id": "web", "path": "/app/robots.txt" }),
    )
    .await;
    assert_eq!(
        tab.result(4).await,
        json!({ "path": "/app/robots.txt", "size": 14, "text": "User-agent: *\n", "binary": false, "tooLarge": false })
    );
    tab.call(
        5,
        "docker.containers.files.read",
        json!({ "connId": conn_id, "id": "web", "path": "/app/data.bin" }),
    )
    .await;
    assert_eq!(tab.result(5).await["binary"], true);
    tab.call(
        6,
        "docker.containers.files.read",
        json!({ "connId": conn_id, "id": "web", "path": "/app" }),
    )
    .await;
    assert_eq!(
        details(&tab.error(6, Code::InvalidArgument).await)["field"],
        "path"
    );
    tab.call(
        7,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "web", "path": "/gone" }),
    )
    .await;
    assert_eq!(
        details(&tab.error(7, Code::NotFound).await)["kind"],
        "NotFound"
    );
    tab.call(
        8,
        "docker.containers.files.list",
        json!({ "connId": conn_id, "id": "web", "path": "app" }),
    )
    .await;
    assert_eq!(
        details(&tab.error(8, Code::InvalidArgument).await)["field"],
        "path"
    );
    assert!(
        lab.seen
            .paths
            .lock()
            .unwrap()
            .iter()
            .all(|p| !p.ends_with("path=app"))
    );

    tab.call(
        9,
        "docker.containers.files.download",
        json!({ "connId": conn_id, "id": "web", "path": "/app", "streamId": "dl" }),
    )
    .await;
    let mut tar = Vec::new();
    let summary = loop {
        let frame = tab.frame(9).await;
        match frame.kind {
            ambidex::Kind::Chunk => {
                tar.extend_from_slice(&frame.payload);
                tab.credit(9, 1).await;
            }
            ambidex::Kind::StreamEnd => {
                break serde_json::from_slice::<Value>(&frame.payload).unwrap();
            }
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(summary["bytes"].as_u64().unwrap() as usize, tar.len());
    assert_eq!(tar.len(), 5 * 512 + 3 * 512 + 1024);
    assert_eq!(&tar[..4], b"app/");
}

#[tokio::test]
async fn images_volumes_and_networks_show_what_uses_them_and_refusals_come_back_per_item() {
    let (_t, lab, mut tab) = setup().await;
    tab.call(
        2,
        "docker.connect",
        json!({ "profile": lab.profile(json!({})) }),
    )
    .await;
    let conn_id = tab.result(2).await["connId"].as_str().unwrap().to_owned();

    tab.call(3, "docker.images.list", json!({ "connId": conn_id }))
        .await;
    let images = tab.result(3).await;
    assert_eq!(images[0]["repoTags"], json!(["busybox:1.37"]));
    assert_eq!(
        images[0]["usedBy"],
        json!([{ "name": "shop-web-1", "state": "running" }, { "name": "stopped", "state": "exited" }])
    );
    assert_eq!(images[1]["dangling"], true);
    assert_eq!(images[1]["repoTags"], json!([]));

    tab.call(
        4,
        "docker.images.inspect",
        json!({ "connId": conn_id, "id": "busybox:1.37" }),
    )
    .await;
    assert_eq!(tab.result(4).await["inspect"]["Id"], "sha256:b");

    // In order: the image a running container uses is refused, the dangling one goes.
    tab.confirmed(
        5,
        "docker.images.remove",
        json!({ "connId": conn_id, "ids": ["busybox:1.37", "sha256:d"], "force": true }),
    )
    .await;
    let results = tab.result(5).await;
    assert!(
        results[0]["error"]
            .as_str()
            .unwrap()
            .contains("being used by running container")
    );
    assert_eq!(
        results[1],
        json!({ "id": "sha256:d", "untagged": [], "deleted": ["sha256:d"] })
    );

    tab.call(6, "docker.volumes.list", json!({ "connId": conn_id }))
        .await;
    let volumes = tab.result(6).await;
    assert!(volumes.get("sizeError").is_none());
    let volumes = volumes["volumes"].as_array().unwrap();
    assert_eq!(volumes[0]["size"], 2048);
    assert_eq!(volumes[0]["project"], "shop");
    assert_eq!(volumes[0]["usedBy"][0]["name"], "shop-web-1");
    assert_eq!(volumes[1]["usedBy"][0]["state"], "exited");
    assert!(volumes[2].get("size").is_none());
    assert_eq!(volumes[2]["usedBy"], json!([]));

    tab.call(
        7,
        "docker.volumes.inspect",
        json!({ "connId": conn_id, "name": "spare" }),
    )
    .await;
    assert_eq!(tab.result(7).await["inspect"]["Name"], "spare");
    tab.confirmed(
        8,
        "docker.volumes.remove",
        json!({ "connId": conn_id, "names": ["spare", "shop_data"] }),
    )
    .await;
    let results = tab.result(8).await;
    assert_eq!(results[0], json!({ "id": "spare" }));
    assert!(results[1]["error"].as_str().unwrap().contains("in use"));

    tab.call(9, "docker.networks.list", json!({ "connId": conn_id }))
        .await;
    let networks = tab.result(9).await;
    assert_eq!(networks[0]["builtIn"], true);
    assert_eq!(networks[0]["usedBy"][0]["name"], "stopped");
    assert_eq!(networks[1]["builtIn"], false);
    assert_eq!(
        networks[1]["subnets"],
        json!([{ "subnet": "172.18.0.0/16", "gateway": "172.18.0.1" }])
    );
    assert_eq!(networks[1]["usedBy"][0]["name"], "shop-web-1");
    tab.call(
        10,
        "docker.networks.inspect",
        json!({ "connId": conn_id, "id": "n1" }),
    )
    .await;
    assert_eq!(tab.result(10).await["inspect"]["Name"], "shop_default");
    tab.confirmed(
        11,
        "docker.networks.remove",
        json!({ "connId": conn_id, "ids": ["n1", "bridge"] }),
    )
    .await;
    let results = tab.result(11).await;
    assert_eq!(results[0], json!({ "id": "n1" }));
    assert!(
        results[1]["error"]
            .as_str()
            .unwrap()
            .contains("pre-defined")
    );

    // Names that would leave the path are refused before anything is sent.
    tab.confirmed(
        12,
        "docker.images.remove",
        json!({ "connId": conn_id, "ids": ["../containers/web"], "force": false }),
    )
    .await;
    assert_eq!(
        details(&tab.error(12, Code::InvalidArgument).await)["field"],
        "ids"
    );
    // A destroy that names nothing has nothing to confirm: refused without a challenge.
    tab.call(
        13,
        "docker.volumes.remove",
        json!({ "connId": conn_id, "names": [] }),
    )
    .await;
    assert_eq!(tab.error(13, Code::ApprovalRequired).await.details, None);
    let paths = lab.seen.paths.lock().unwrap().clone();
    assert!(paths.iter().all(|p| !p.contains("..")), "{paths:?}");
    assert!(
        paths
            .iter()
            .any(|p| p == "/v1.47/images/busybox:1.37?force=1")
    );
}

// Transports (DOC-23 §6, TSK-116): the same Engine on a local socket and over TCP, with and
// without TLS. Every Docker procedure runs over whichever transport the handle has, so these
// check the transport itself: connect, the Host page's facts, a request after connect, and the
// refusals of each transport.

/// Serves the stand-in Engine (API 1.47) on every stream `accept` yields.
fn serve_engine<S>(stream: S)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    tokio::spawn(async move {
        let service =
            hyper::service::service_fn(|request: Request<hyper::body::Incoming>| async move {
                let path = request.uri().path().to_owned();
                Ok::<_, Infallible>(engine("1.47", request.method(), &path))
            });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .await;
    });
}

#[cfg(unix)]
#[tokio::test]
async fn a_local_socket_reaches_the_engine_and_says_why_it_cannot() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("docker.sock");
    let listener = tokio::net::UnixListener::bind(&path).unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            serve_engine(stream);
        }
    });
    let (t, _lab, mut member) = setup().await;
    let socket = json!({ "name": "local", "transport": "socket", "socketPath": path });
    // Root on this machine for whoever connects (DOC-23 §11.4): saving it needs
    // profiles.hostAccess, which only the administrator role has.
    member
        .call(
            2,
            "profiles.create",
            json!({ "tool": "docker", "name": "local", "owner": { "kind": "personal" },
                    "fields": { "transport": "socket", "socketPath": path } }),
        )
        .await;
    let err = member.error(2, Code::PermissionDenied).await;
    assert!(
        err.message.contains("profiles.hostAccess"),
        "{}",
        err.message
    );
    let admin = t
        .server
        .store()
        .account_by_username("admin")
        .unwrap()
        .expect("the default administrator")
        .principal_id();
    let browser = t.browser_as(&admin, &[]).await;
    let mut tab = t.tab(&browser).await;
    tab.call(2, "docker.connect", json!({ "profile": socket }))
        .await;
    let out = tab.result(2).await;
    let host = &out["host"];
    assert_eq!(host["transport"], "socket");
    assert_eq!(host["endpoint"], path.display().to_string());
    assert_eq!(host["unencrypted"], false);
    assert!(host.get("ssh").is_none());
    assert_eq!(host["name"], "build-host");
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    tab.call(3, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    assert_eq!(tab.result(3).await["kernelVersion"], "6.1.0-28-amd64");

    // No socket there: the explained error.
    let missing = json!({ "name": "gone", "transport": "socket", "socketPath": dir.path().join("none.sock") });
    tab.call(4, "docker.connect", json!({ "profile": missing }))
        .await;
    let err = tab.error(4, Code::Unavailable).await;
    assert!(err.message.contains("no socket at"), "{}", err.message);
    // A relative path never reaches the file system.
    let relative = json!({ "name": "rel", "transport": "socket", "socketPath": "docker.sock" });
    tab.call(5, "docker.connect", json!({ "profile": relative }))
        .await;
    let err = tab.error(5, Code::InvalidArgument).await;
    assert_eq!(details(&err)["field"], "socketPath");
}

#[tokio::test]
async fn plain_tcp_connects_only_with_the_persons_acceptance() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            serve_engine(tcp);
        }
    });
    let (_t, _lab, mut tab) = setup().await;
    // Saving plain TCP without the tick is refused, and names the field.
    tab.call(
        2,
        "profiles.create",
        json!({ "tool": "docker", "name": "plain", "owner": { "kind": "personal" },
                "fields": { "transport": "tcp", "host": "127.0.0.1", "port": addr.port() } }),
    )
    .await;
    let err = tab.error(2, Code::InvalidArgument).await;
    assert!(err.message.contains("root on that host"), "{}", err.message);
    let plain = json!({ "name": "plain", "transport": "tcp", "host": "127.0.0.1",
                        "port": addr.port(), "unencrypted": { "accepted": true } });
    tab.call(3, "docker.connect", json!({ "profile": plain }))
        .await;
    let out = tab.result(3).await;
    assert_eq!(out["host"]["transport"], "tcp");
    assert_eq!(
        out["host"]["endpoint"],
        format!("127.0.0.1:{}", addr.port())
    );
    assert_eq!(out["host"]["unencrypted"], true);
    assert_eq!(out["host"]["tls"], false);
    // The record keeps who accepted and when, never the page's tick.
    tab.call(4, "profiles.list", json!({ "tool": "docker" }))
        .await;
    let listed = tab.result(4).await;
    let record = listed["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["fields"]["transport"] == "tcp")
        .unwrap()
        .clone();
    let stamp = &record["fields"]["unencrypted"];
    assert!(stamp["acceptedBy"].is_string(), "{stamp}");
    assert!(stamp["acceptedAt"].is_string(), "{stamp}");
    assert!(stamp.get("accepted").is_none());
}

/// A TLS Engine that wants a client certificate its own CA signed: the CA's PEM, a client
/// certificate and key it accepts, and the address.
async fn tls_engine() -> (String, String, String, SocketAddr) {
    // Each CA its own name, so a certificate of another one is refused as unknown.
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(
        rcgen::DnType::CommonName,
        format!("test Docker CA {}", NEXT.fetch_add(1, Ordering::SeqCst)),
    );
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let server_key = rcgen::KeyPair::generate().unwrap();
    let server =
        rcgen::CertificateParams::new(vec!["localhost".to_owned(), "127.0.0.1".to_owned()])
            .unwrap()
            .signed_by(&server_key, &issuer)
            .unwrap();
    let client_key = rcgen::KeyPair::generate().unwrap();
    let client = rcgen::CertificateParams::new(vec!["mightyconsole".to_owned()])
        .unwrap()
        .signed_by(&client_key, &issuer)
        .unwrap();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore::empty();
    roots.add(ca.der().clone()).unwrap();
    let verifier = rustls::server::WebPkiClientVerifier::builder_with_provider(
        Arc::new(roots),
        Arc::clone(&provider),
    )
    .build()
    .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_client_cert_verifier(verifier)
        .with_single_cert(
            vec![server.der().clone()],
            rustls::pki_types::PrivateKeyDer::try_from(server_key.serialize_der()).unwrap(),
        )
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let acceptor = acceptor.clone();
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(tcp).await {
                    serve_engine(tls);
                }
            });
        }
    });
    (ca.pem(), client.pem(), client_key.serialize_pem(), addr)
}

#[tokio::test]
async fn tls_checks_the_engines_certificate_and_sends_the_client_certificate() {
    let (ca, cert, key, addr) = tls_engine().await;
    let (_t, _lab, mut tab) = setup().await;
    let profile = |tls: Value| json!({ "name": "tls", "transport": "tcp", "host": "127.0.0.1", "port": addr.port(), "tls": tls });
    let good = profile(
        json!({ "enabled": true, "caPem": ca, "clientCertPem": cert, "clientKeyPem": key }),
    );
    tab.call(2, "docker.connect", json!({ "profile": good }))
        .await;
    let out = tab.result(2).await;
    assert_eq!(out["host"]["tls"], true);
    assert_eq!(out["host"]["unencrypted"], false);
    let conn_id = out["connId"].as_str().unwrap().to_owned();
    tab.call(3, "docker.host.info", json!({ "connId": conn_id }))
        .await;
    assert_eq!(tab.result(3).await["name"], "build-host");

    // Another CA: the Engine's certificate is not trusted, and nothing is sent.
    let (other_ca, _, _, _) = tls_engine().await;
    let untrusted = profile(
        json!({ "enabled": true, "caPem": other_ca, "clientCertPem": cert, "clientKeyPem": key }),
    );
    tab.call(4, "docker.connect", json!({ "profile": untrusted }))
        .await;
    let err = tab.error(4, Code::Unavailable).await;
    assert_eq!(details(&err)["kind"], "Tls");
    assert!(
        err.message.contains("not signed by the CA"),
        "{}",
        err.message
    );

    // The certificate is for 127.0.0.1 and localhost; a server name it does not carry fails.
    let wrong_name = profile(
        json!({ "enabled": true, "caPem": ca, "clientCertPem": cert, "clientKeyPem": key, "serverName": "docker.prod" }),
    );
    tab.call(5, "docker.connect", json!({ "profile": wrong_name }))
        .await;
    let err = tab.error(5, Code::Unavailable).await;
    assert!(
        err.message.contains("not for this address"),
        "{}",
        err.message
    );

    // A client certificate another CA signed: the Engine refuses it (with TLS 1.3, on the first
    // request), and the message says what it wants.
    let (_, stranger_cert, stranger_key, _) = tls_engine().await;
    let stranger = profile(
        json!({ "enabled": true, "caPem": ca, "clientCertPem": stranger_cert, "clientKeyPem": stranger_key }),
    );
    tab.call(6, "docker.connect", json!({ "profile": stranger }))
        .await;
    let err = tab.error(6, Code::Unauthenticated).await;
    assert_eq!(details(&err)["kind"], "Auth");
    assert!(
        err.message.contains("client certificate"),
        "{}",
        err.message
    );
    assert!(!err.message.contains("PRIVATE KEY"));

    // DOC-23 §6.3: with TLS, the CA, the client certificate and its key are all given.
    for (id, (tls, field)) in (7..).zip([
        (
            json!({ "enabled": true, "clientCertPem": cert, "clientKeyPem": key }),
            "tls.caPem",
        ),
        (
            json!({ "enabled": true, "caPem": ca, "clientKeyPem": key }),
            "tls.clientCertPem",
        ),
        (
            json!({ "enabled": true, "caPem": ca, "clientCertPem": cert }),
            "tls.clientKeyPem",
        ),
    ]) {
        tab.call(id, "docker.connect", json!({ "profile": profile(tls) }))
            .await;
        let err = tab.error(id, Code::InvalidArgument).await;
        assert_eq!(details(&err)["field"], field);
    }
}
