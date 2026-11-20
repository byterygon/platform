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
            let service = hyper::service::service_fn(move |request: Request<_>| {
                let paths = Arc::clone(&paths);
                async move {
                    let path = request.uri().path().to_owned();
                    paths.lock().unwrap().push(path.clone());
                    Ok::<_, Infallible>(engine(api, &path))
                }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(channel.into_stream()), service)
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

/// The fake Docker Engine.
fn engine(api: &str, path: &str) -> Response<Full<Bytes>> {
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
