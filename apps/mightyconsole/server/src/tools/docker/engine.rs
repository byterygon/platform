//! The Docker Engine API over SSH (Mightyconsole spec §10.3): every request opens its own
//! `direct-streamlocal` channel to the socket and runs HTTP/1.1 on it with hyper, so requests
//! never wait for each other and a long stream (logs, stats, events, exec) keeps its own channel.
//! The API version is negotiated once from `GET /_ping`: the host's version, at most
//! [`MAX_API`], at least [`MIN_API`] (Docker 20.10).

use std::time::{Duration, Instant};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{CONNECTION, CONTENT_TYPE, HOST, UPGRADE, USER_AGENT};
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::TOOL;
use super::ssh::SshSession;
use crate::core::{RemoteError, ToolError, ToolErrorKind};

/// The oldest API the tool speaks: Docker 20.10 (spec §10.3).
pub const MIN_API: ApiVersion = ApiVersion(1, 41);

/// The newest API the tool asks for (Docker 28); a newer host answers in this version.
pub const MAX_API: ApiVersion = ApiVersion(1, 51);

/// How long one ordinary request may take, headers and body.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// The largest JSON answer read into memory (a host with thousands of containers or images).
pub const MAX_BODY: usize = 32 * 1024 * 1024;

/// A Docker API version, `1.47`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ApiVersion(pub u32, pub u32);

impl ApiVersion {
    pub fn parse(text: &str) -> Option<ApiVersion> {
        let (major, minor) = text.trim().split_once('.')?;
        Some(ApiVersion(major.parse().ok()?, minor.parse().ok()?))
    }

    /// The version to speak with a host whose newest is `server`; `None` when it is too old.
    pub fn negotiate(server: ApiVersion) -> Option<ApiVersion> {
        (server >= MIN_API).then(|| server.min(MAX_API))
    }
}

impl std::fmt::Display for ApiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.0, self.1)
    }
}

/// What `GET /_ping` told about the host.
#[derive(Debug, Clone)]
pub struct Ping {
    pub server_api: ApiVersion,
    pub round_trip: Duration,
}

/// The Docker Engine of one host, reached through one SSH session.
pub struct Engine {
    pub ssh: SshSession,
    pub socket_path: String,
    pub api: ApiVersion,
}

impl Engine {
    /// Pings the engine and negotiates the API version. The first request is also the check
    /// that the host forwards the socket, so its error is the explained one of spec §10.3. On
    /// failure the SSH session is closed.
    pub async fn open(ssh: SshSession, socket_path: String) -> Result<(Engine, Ping), ToolError> {
        match ping(&ssh, &socket_path).await {
            Ok((api, ping)) => Ok((
                Engine {
                    ssh,
                    socket_path,
                    api,
                },
                ping,
            )),
            Err(e) => {
                ssh.close().await;
                Err(e)
            }
        }
    }

    /// `/v1.47/<path>`.
    pub fn path(&self, path: &str) -> String {
        format!("/v{}{path}", self.api)
    }

    /// A request on a fresh channel; the response's body is still to be read.
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Response<Incoming>, ToolError> {
        send(
            &self.ssh,
            &self.socket_path,
            method,
            &self.path(path),
            body,
            false,
        )
        .await
    }

    /// `POST` with the connection upgraded (`Upgrade: tcp`, as `docker exec -it` does): the
    /// answer is `101 Switching Protocols` and the channel then carries the process's TTY both
    /// ways. Any other answer is read as the error.
    pub async fn upgrade(
        &self,
        path: &str,
        body: &Value,
        resource: &str,
    ) -> Result<hyper::upgrade::Upgraded, ToolError> {
        let call = async {
            let response = send(
                &self.ssh,
                &self.socket_path,
                Method::POST,
                &self.path(path),
                Some(body),
                true,
            )
            .await?;
            let status = response.status();
            if status != StatusCode::SWITCHING_PROTOCOLS {
                let bytes = read_body(response, 64 * 1024).await?;
                return Err(if status.is_success() {
                    ToolError::new(
                        ToolErrorKind::Remote,
                        TOOL,
                        format!(
                            "Docker answered {path} with {status} instead of switching to the TTY"
                        ),
                    )
                } else {
                    http_error(status, &bytes, resource)
                });
            }
            hyper::upgrade::on(response).await.map_err(|e| {
                ToolError::new(
                    ToolErrorKind::Remote,
                    TOOL,
                    format!("switching {path} to the TTY failed: {e}"),
                )
            })
        };
        tokio::time::timeout(CALL_TIMEOUT, call)
            .await
            .unwrap_or_else(|_| Err(no_answer(path, CALL_TIMEOUT)))
    }

    /// A JSON call; `resource` names what a 404 means (`container`, `image`, ...).
    pub async fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        resource: &str,
    ) -> Result<T, ToolError> {
        let call = async {
            let response = self.send(method, path, body).await?;
            let status = response.status();
            let bytes = read_body(response, MAX_BODY).await?;
            if !status.is_success() {
                return Err(http_error(status, &bytes, resource));
            }
            let bytes = if bytes.is_empty() {
                Bytes::from_static(b"null")
            } else {
                bytes
            };
            serde_json::from_slice(&bytes).map_err(|e| {
                ToolError::new(
                    ToolErrorKind::Remote,
                    TOOL,
                    format!("Docker answered {path} with JSON the tool cannot read: {e}"),
                )
            })
        };
        tokio::time::timeout(CALL_TIMEOUT, call)
            .await
            .unwrap_or_else(|_| Err(no_answer(path, CALL_TIMEOUT)))
    }

    /// `GET` returning JSON.
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        resource: &str,
    ) -> Result<T, ToolError> {
        self.call(Method::GET, path, None, resource).await
    }

    /// A request whose body streams for as long as it lasts (logs, events, stats): the headers
    /// within [`CALL_TIMEOUT`], an error status read as the error, the body left to the caller.
    pub async fn stream(
        &self,
        method: Method,
        path: &str,
        resource: &str,
    ) -> Result<Incoming, ToolError> {
        let response = tokio::time::timeout(CALL_TIMEOUT, self.send(method, path, None))
            .await
            .unwrap_or_else(|_| Err(no_answer(path, CALL_TIMEOUT)))?;
        let status = response.status();
        if !status.is_success() {
            let bytes = read_body(response, 64 * 1024).await?;
            return Err(http_error(status, &bytes, resource));
        }
        Ok(response.into_body())
    }

    /// A call whose answer carries nothing to read (start, stop, remove), within `limit`. `304
    /// Not Modified` (start a running container, stop a stopped one) is success: the container
    /// is where it was asked to be.
    pub async fn act(
        &self,
        method: Method,
        path: &str,
        resource: &str,
        limit: Duration,
    ) -> Result<(), ToolError> {
        let call = async {
            let response = self.send(method, path, None).await?;
            let status = response.status();
            let bytes = read_body(response, 64 * 1024).await?;
            if status.is_success() || status == StatusCode::NOT_MODIFIED {
                Ok(())
            } else {
                Err(http_error(status, &bytes, resource))
            }
        };
        tokio::time::timeout(limit, call)
            .await
            .unwrap_or_else(|_| Err(no_answer(path, limit)))
    }
}

/// Docker did not answer `path` in time.
fn no_answer(path: &str, limit: Duration) -> ToolError {
    ToolError::new(
        ToolErrorKind::Connect,
        TOOL,
        format!("Docker did not answer {path} within {} s", limit.as_secs()),
    )
}

/// `GET /_ping`: the host's API version and the round trip.
async fn ping(ssh: &SshSession, socket_path: &str) -> Result<(ApiVersion, Ping), ToolError> {
    let started = Instant::now();
    let response = tokio::time::timeout(
        CALL_TIMEOUT,
        send(ssh, socket_path, Method::GET, "/_ping", None, false),
    )
    .await
    .unwrap_or_else(|_| Err(no_answer("/_ping", CALL_TIMEOUT)))?;
    let round_trip = started.elapsed();
    let status = response.status();
    let header = response
        .headers()
        .get("api-version")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let body = read_body(response, 64 * 1024).await?;
    if !status.is_success() {
        return Err(http_error(status, &body, "engine"));
    }
    let server_api = header
        .as_deref()
        .and_then(ApiVersion::parse)
        .ok_or_else(|| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!(
                    "{socket_path} answered /_ping without an API-Version header: is it Docker's \
                 socket?"
                ),
            )
        })?;
    let api = ApiVersion::negotiate(server_api).ok_or_else(|| {
        ToolError::new(
            ToolErrorKind::Conflict,
            TOOL,
            format!(
                "the host's Docker speaks API {server_api}; Mightyconsole needs {MIN_API} or \
                 newer (Docker 20.10)"
            ),
        )
    })?;
    Ok((
        api,
        Ping {
            server_api,
            round_trip,
        },
    ))
}

/// Opens a channel, runs the HTTP/1.1 handshake on it and sends one request.
async fn send(
    ssh: &SshSession,
    socket_path: &str,
    method: Method,
    path: &str,
    body: Option<&Value>,
    upgrade: bool,
) -> Result<Response<Incoming>, ToolError> {
    let stream = ssh.open_socket(socket_path).await?;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("HTTP over {socket_path} failed: {e}"),
            )
        })?;
    // The connection lives as long as the response's body (logs and events stream on it) and
    // ends with it; exec upgrades it.
    tokio::spawn(async move {
        let _ = connection.with_upgrades().await;
    });
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        // The Engine ignores the host; HTTP/1.1 needs one.
        .header(HOST, "docker")
        .header(
            USER_AGENT,
            concat!("mightyconsole/", env!("CARGO_PKG_VERSION")),
        );
    if upgrade {
        request = request.header(CONNECTION, "Upgrade").header(UPGRADE, "tcp");
    }
    let body = match body {
        Some(value) => {
            request = request.header(CONTENT_TYPE, "application/json");
            Full::new(Bytes::from(
                serde_json::to_vec(value).expect("JSON serializes"),
            ))
        }
        None => Full::default(),
    };
    let request = request
        .body(body)
        .map_err(|e| ToolError::invalid(TOOL, "path", e.to_string()))?;
    sender.send_request(request).await.map_err(|e| {
        ToolError::new(
            ToolErrorKind::Connect,
            TOOL,
            format!("Docker did not answer {path}: {e}"),
        )
    })
}

/// Reads a whole body, at most `limit` bytes.
pub async fn read_body(response: Response<Incoming>, limit: usize) -> Result<Bytes, ToolError> {
    http_body_util::Limited::new(response.into_body(), limit)
        .collect()
        .await
        .map(|c| c.to_bytes())
        .map_err(|e| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!("reading Docker's answer failed: {e}"),
            )
        })
}

/// A Docker error answer (`{ "message": "..." }`) as a ToolError.
pub fn http_error(status: StatusCode, body: &[u8], resource: &str) -> ToolError {
    let message = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| {
            let text = String::from_utf8_lossy(body);
            let text = text.trim();
            if text.is_empty() {
                status.canonical_reason().unwrap_or("error").to_owned()
            } else {
                text.chars().take(500).collect()
            }
        });
    let kind = match status {
        StatusCode::NOT_FOUND => ToolErrorKind::NotFound,
        StatusCode::CONFLICT | StatusCode::NOT_MODIFIED => ToolErrorKind::Conflict,
        StatusCode::BAD_REQUEST => ToolErrorKind::Invalid,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ToolErrorKind::Forbidden,
        _ => ToolErrorKind::Remote,
    };
    let mut error = ToolError::new(kind, TOOL, message).with_remote(RemoteError {
        code: status.as_u16().to_string(),
        name: status.canonical_reason().map(str::to_owned),
        detail: None,
    });
    if kind == ToolErrorKind::NotFound {
        error.resource = Some(resource.to_owned());
    }
    if status.is_server_error() {
        error.retryable = true;
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_version_is_the_hosts_within_the_supported_range() {
        let v = |s| ApiVersion::parse(s).unwrap();
        assert_eq!(ApiVersion::negotiate(v("1.47")), Some(v("1.47")));
        assert_eq!(ApiVersion::negotiate(v("1.41")), Some(v("1.41")));
        assert_eq!(ApiVersion::negotiate(v("1.52")), Some(MAX_API));
        assert_eq!(ApiVersion::negotiate(v("1.40")), None);
        assert_eq!(ApiVersion::parse("abc"), None);
        assert!(v("1.9") < v("1.41"));
        assert_eq!(MAX_API.to_string(), "1.51");
    }

    #[test]
    fn docker_errors_keep_their_message_and_status() {
        let err = http_error(
            StatusCode::NOT_FOUND,
            br#"{"message":"No such container: web"}"#,
            "container",
        );
        assert_eq!(err.kind, ToolErrorKind::NotFound);
        assert_eq!(err.message, "No such container: web");
        assert_eq!(err.resource.as_deref(), Some("container"));
        assert_eq!(err.remote.unwrap().code, "404");
        let err = http_error(StatusCode::CONFLICT, b"{\"message\":\"in use\"}", "image");
        assert_eq!(err.kind, ToolErrorKind::Conflict);
        let err = http_error(StatusCode::INTERNAL_SERVER_ERROR, b"", "x");
        assert_eq!(err.kind, ToolErrorKind::Remote);
        assert!(err.retryable);
        assert_eq!(err.message, "Internal Server Error");
    }
}
