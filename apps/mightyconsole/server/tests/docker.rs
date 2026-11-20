//! The `docker` tool against a stand-in SSH server on loopback (Mightyconsole spec §10, TSK-81):
//! a russh server with a generated host key, password and public-key logins, and
//! `direct-streamlocal` channels to a fake Docker Engine (HTTP/1.1 on the channel). It checks
//! trust on first use (nothing is sent to an untrusted host), a changed key, the logins, the
//! explained error of a host that refuses to forward the socket, the API version floor, the
//! Host page and a session the host ends. The real sshd and Docker are `tests/docker_lab.rs`
//! (feature `lab-tests`). Runs in CI's network namespace: loopback only.

mod support;

use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

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
use support::*;

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
                    paths.lock().unwrap().push(full);
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
            },
            {
                "Id": "bbb2", "Names": ["/stopped"], "Image": "busybox:1.37", "ImageID": "sha256:b",
                "Command": "sh -c 'exit 3'", "Created": 1795161000, "State": "exited",
                "Status": "Exited (3) 2 hours ago", "Ports": [], "Labels": {},
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
                tab.client.credit(id, 1).await;
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
    tab.call(
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
        tab.client.credit(id, 1).await;
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
                tab.client.credit(3, 1).await;
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
