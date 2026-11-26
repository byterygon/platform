//! The HTTP client of one connected LangGraph profile: JSON calls and SSE streams of the
//! LangGraph Server API, made by the server so the browser never talks to the LangGraph server
//! (spec §11.4, Decision 21).
//!
//! hyper with rustls (`ring`) and the system's trust store or a pinned CA (`core::tls`); no
//! proxy (an air-gapped machine reaches its own servers directly). Errors become [`ToolError`]s
//! by what went wrong: unreachable (`Connect`), TLS (`Tls`), 401 (`Auth`), 403 (`Forbidden`), 404
//! (`NotFound` with the resource), 409 (`Conflict`), 400 and 422 (`Invalid`), anything else
//! (`Remote` with the HTTP status). Messages name the server's address, never a header value.

use std::pin::Pin;
use std::time::Duration;

use bytes::Bytes;
use eventsource_stream::{Event, EventStreamError, Eventsource as _};
use futures_util::{Stream, StreamExt as _};
use http_body_util::{BodyExt as _, BodyStream, Full};
use hyper::body::Incoming;
use hyper::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue, USER_AGENT};
use hyper::{Method, Request, Response, StatusCode};
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::TokioExecutor;
use serde_json::Value;
use url::Url;

use super::{ConnectLanggraphProfile, TOOL};
use crate::core::tls::{client_config, plain_config};
use crate::core::{RemoteError, ToolError, ToolErrorKind};
use crate::tools::temporal::large::LargePayloads;

/// Time to open a TCP connection to the server.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Deadline of one JSON call, and of a stream's response headers (spec §2.4: 30 s).
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Largest JSON answer read (a thread's state with a long conversation stays well below).
const MAX_BODY: usize = 64 * 1024 * 1024;

/// Longest detail of a server error kept for Details.
const MAX_DETAIL: usize = 2000;

/// One SSE event of a run stream, or why the stream broke.
pub type SseItem = Result<Event, ToolError>;

/// The events of a run stream.
pub type SseStream = Pin<Box<dyn Stream<Item = SseItem> + Send>>;

type Http = Client<HttpsConnector<crate::core::outbound::Connector>, Full<Bytes>>;

pub struct LangGraphClient {
    http: Http,
    /// The server's base URL without a trailing `/` (a path prefix such as `/api` is kept).
    base: String,
    /// `host:port` for messages.
    address: String,
    /// `x-api-key` and the profile's extra headers, marked sensitive.
    headers: HeaderMap,
    /// Values read whole for the large-state tree (TSK-96), kept as Temporal's large payloads are.
    pub values: LargePayloads,
}

fn header_value(field: &str, text: &str, what: &str) -> Result<HeaderValue, ToolError> {
    let mut value = HeaderValue::from_str(text).map_err(|_| {
        ToolError::invalid(
            TOOL,
            field,
            format!("{what} has characters a header cannot carry"),
        )
    })?;
    value.set_sensitive(true);
    Ok(value)
}

impl LangGraphClient {
    pub fn new(profile: &ConnectLanggraphProfile) -> Result<LangGraphClient, ToolError> {
        LangGraphClient::new_via(profile, crate::core::route::Via::Direct)
    }

    /// [`LangGraphClient::new`] through the profile's route (DOC-23 §7).
    pub fn new_via(
        profile: &ConnectLanggraphProfile,
        via: crate::core::route::Via,
    ) -> Result<LangGraphClient, ToolError> {
        let url = Url::parse(profile.url.trim()).map_err(|_| {
            ToolError::invalid(TOOL, "url", "not a URL, e.g. http://127.0.0.1:2024")
        })?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ToolError::invalid(
                TOOL,
                "url",
                "the URL must start with http:// or https://",
            ));
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err(ToolError::invalid(
                TOOL,
                "url",
                "put credentials in the API key or the headers, not in the URL",
            ));
        }
        let host = url.host_str().unwrap_or_default().to_owned();
        let address = match url.port_or_known_default() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        let mut headers = HeaderMap::new();
        if let Some(key) = profile.api_key.as_deref().filter(|k| !k.is_empty()) {
            headers.insert(
                HeaderName::from_static("x-api-key"),
                header_value("apiKey", key, "the API key")?,
            );
        }
        for header in profile.headers.iter().flatten() {
            let name = HeaderName::from_bytes(header.name.trim().as_bytes()).map_err(|_| {
                ToolError::invalid(
                    TOOL,
                    "headers",
                    format!("\"{}\" is not a header name", header.name),
                )
            })?;
            let value = header_value("headers", &header.value, &format!("the value of {name}"))?;
            headers.insert(name, value);
        }
        // The profile's TLS options only matter for https://.
        let tls = if url.scheme() == "https" {
            client_config(&profile.tls.clone().unwrap_or_default())
                .map_err(|e| ToolError::invalid(TOOL, e.field, e.message))?
        } else {
            plain_config()
        };
        // Through the server's outbound policy (TSK-141): the address connected to is checked.
        let tcp =
            crate::core::outbound::Connector::new(super::TOOL, Some(CONNECT_TIMEOUT)).via(via);
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_or_http()
            .enable_http1()
            .wrap_connector(tcp);
        let http = Client::builder(TokioExecutor::new()).build(connector);
        Ok(LangGraphClient {
            http,
            base: url.as_str().trim_end_matches('/').to_owned(),
            address,
            headers,
            values: LargePayloads::default(),
        })
    }

    fn url(&self, path: &str, query: &[(&str, String)]) -> String {
        let mut url = Url::parse(&format!("{}{path}", self.base)).expect("the base URL parsed");
        if !query.is_empty() {
            url.query_pairs_mut()
                .extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        url.into()
    }

    /// Sends a request and waits for the response headers.
    async fn send(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        accept: &'static str,
        last_event_id: Option<&str>,
    ) -> Result<Response<Incoming>, ToolError> {
        let mut request = Request::builder()
            .method(method)
            .uri(self.url(path, query))
            .header(
                USER_AGENT,
                concat!("mightyconsole/", env!("CARGO_PKG_VERSION")),
            )
            .header(ACCEPT, accept);
        if let Some(headers) = request.headers_mut() {
            headers.extend(self.headers.clone());
        }
        if let Some(id) = last_event_id {
            request = request.header(
                "last-event-id",
                header_value("lastEventId", id, "the event id")?,
            );
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
            .map_err(|e| ToolError::invalid(TOOL, "url", e.to_string()))?;
        match tokio::time::timeout(CALL_TIMEOUT, self.http.request(request)).await {
            Err(_) => Err(timed_out(&self.address)),
            Ok(Err(e)) => Err(transport_error(&self.address, &e, e.is_connect())),
            Ok(Ok(response)) => Ok(response),
        }
    }

    /// A JSON call; `resource` names what a 404 means (`assistant`, `thread`, ...).
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, String)],
        body: Option<&Value>,
        resource: &str,
    ) -> Result<Value, ToolError> {
        let call = async {
            let response = self
                .send(method, path, query, body, "application/json", None)
                .await?;
            let status = response.status();
            let bytes = http_body_util::Limited::new(response.into_body(), MAX_BODY)
                .collect()
                .await
                .map_err(|e| {
                    ToolError::new(
                        ToolErrorKind::Remote,
                        TOOL,
                        format!("reading the answer of {} failed: {e}", self.address),
                    )
                })?
                .to_bytes();
            Ok::<_, ToolError>((status, bytes))
        };
        let (status, bytes) = tokio::time::timeout(CALL_TIMEOUT, call)
            .await
            .map_err(|_| timed_out(&self.address))??;
        if !status.is_success() {
            return Err(http_error(status, &bytes, resource));
        }
        if bytes.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_slice(&bytes).map_err(|e| {
            ToolError::new(
                ToolErrorKind::Remote,
                TOOL,
                format!(
                    "{} answered {path} with something that is not JSON: {e}",
                    self.address
                ),
            )
        })
    }

    pub async fn get(
        &self,
        path: &str,
        query: &[(&str, String)],
        resource: &str,
    ) -> Result<Value, ToolError> {
        self.call(Method::GET, path, query, None, resource).await
    }

    pub async fn post(&self, path: &str, body: &Value, resource: &str) -> Result<Value, ToolError> {
        self.call(Method::POST, path, &[], Some(body), resource)
            .await
    }

    /// An SSE stream (`POST` with a body, or `GET` with `Last-Event-ID`). The response headers
    /// are awaited here, so a refused run fails the call before any chunk.
    pub async fn sse(
        &self,
        method: Method,
        path: &str,
        body: Option<&Value>,
        last_event_id: Option<&str>,
        resource: &str,
    ) -> Result<SseStream, ToolError> {
        let response = self
            .send(method, path, &[], body, "text/event-stream", last_event_id)
            .await?;
        let status = response.status();
        if !status.is_success() {
            let bytes = http_body_util::Limited::new(response.into_body(), 1024 * 1024)
                .collect()
                .await
                .map(|c| c.to_bytes())
                .unwrap_or_default();
            return Err(http_error(status, &bytes, resource));
        }
        let address = self.address.clone();
        let data = BodyStream::new(response.into_body()).filter_map(|frame| async move {
            match frame {
                Ok(frame) => frame.into_data().ok().map(Ok),
                Err(e) => Some(Err(e)),
            }
        });
        Ok(Box::pin(data.eventsource().map(move |item| {
            item.map_err(|e| match e {
                EventStreamError::Transport(e) => transport_error(&address, &e, false),
                EventStreamError::Utf8(e) => ToolError::new(
                    ToolErrorKind::Remote,
                    TOOL,
                    format!("{address} sent an event that is not UTF-8: {e}"),
                ),
                EventStreamError::Parser(e) => ToolError::new(
                    ToolErrorKind::Remote,
                    TOOL,
                    format!("{address} sent a malformed event: {e}"),
                ),
            })
        })))
    }
}

fn timed_out(address: &str) -> ToolError {
    ToolError::new(
        ToolErrorKind::Connect,
        TOOL,
        format!("{address} did not answer in time"),
    )
}

/// A failure before any HTTP status: unreachable, refused, or TLS.
fn transport_error(
    address: &str,
    e: &(dyn std::error::Error + 'static),
    connect: bool,
) -> ToolError {
    if let Some(route) = crate::core::outbound::route_failure(e) {
        return route;
    }
    if let Some(tls) = tls_cause(e) {
        return ToolError::new(
            ToolErrorKind::Tls,
            TOOL,
            format!("TLS with {address} failed: {tls}"),
        );
    }
    let message = if connect {
        format!("cannot reach {address}: {}", root_cause(e))
    } else {
        format!("the connection to {address} failed: {}", root_cause(e))
    };
    ToolError::new(ToolErrorKind::Connect, TOOL, message)
}

/// The innermost message of an error chain.
fn root_cause(e: &(dyn std::error::Error + 'static)) -> String {
    let mut current = e;
    loop {
        if let Some(io) = current.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
        {
            current = inner;
            continue;
        }
        match current.source() {
            Some(next) => current = next,
            None => return current.to_string(),
        }
    }
}

/// The rustls error in the chain, if the failure was the TLS handshake or verification.
fn tls_cause(e: &(dyn std::error::Error + 'static)) -> Option<String> {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(e);
    while let Some(err) = current {
        if let Some(tls) = err.downcast_ref::<rustls::Error>() {
            return Some(tls.to_string());
        }
        // `io::Error::source` skips the error it wraps, so step into it instead.
        if let Some(io) = err.downcast_ref::<std::io::Error>()
            && let Some(inner) = io.get_ref()
        {
            current = Some(inner);
            continue;
        }
        current = err.source();
    }
    None
}

/// A non-success HTTP status as a [`ToolError`]; the server's `detail` (or body) for Details.
pub fn http_error(status: StatusCode, body: &[u8], resource: &str) -> ToolError {
    let detail = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| {
            match v
                .get("detail")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("error"))
            {
                Some(Value::String(s)) => Some(s.clone()),
                Some(other) => Some(other.to_string()),
                None => None,
            }
        })
        .unwrap_or_else(|| String::from_utf8_lossy(body).trim().to_owned());
    let detail: String = detail.chars().take(MAX_DETAIL).collect();
    let reason = status.canonical_reason().unwrap_or("error");
    let message = if detail.is_empty() {
        format!("the LangGraph server answered {} {reason}", status.as_u16())
    } else {
        detail.clone()
    };
    let error = match status.as_u16() {
        401 => ToolError::new(ToolErrorKind::Auth, TOOL, message),
        403 => ToolError::new(ToolErrorKind::Forbidden, TOOL, message),
        404 => ToolError::not_found(TOOL, resource, message),
        409 => ToolError::new(ToolErrorKind::Conflict, TOOL, message),
        400 | 422 => ToolError::new(ToolErrorKind::Invalid, TOOL, message),
        _ => {
            ToolError::new(ToolErrorKind::Remote, TOOL, message).retryable(status.is_server_error())
        }
    };
    error.with_remote(RemoteError {
        code: status.as_u16().to_string(),
        name: Some(reason.to_owned()),
        detail: (!detail.is_empty()).then_some(detail),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_kinds() {
        let kind = |status: u16| {
            http_error(
                StatusCode::from_u16(status).unwrap(),
                b"{\"detail\":\"nope\"}",
                "thread",
            )
            .kind
        };
        assert_eq!(kind(401), ToolErrorKind::Auth);
        assert_eq!(kind(403), ToolErrorKind::Forbidden);
        assert_eq!(kind(404), ToolErrorKind::NotFound);
        assert_eq!(kind(409), ToolErrorKind::Conflict);
        assert_eq!(kind(422), ToolErrorKind::Invalid);
        assert_eq!(kind(500), ToolErrorKind::Remote);
        let e = http_error(
            StatusCode::NOT_FOUND,
            b"{\"detail\":\"Thread not found\"}",
            "thread",
        );
        assert_eq!(e.message, "Thread not found");
        assert_eq!(e.resource.as_deref(), Some("thread"));
        assert_eq!(e.remote.unwrap().code, "404");
        let e = http_error(StatusCode::BAD_GATEWAY, b"", "run");
        assert_eq!(e.message, "the LangGraph server answered 502 Bad Gateway");
        assert!(e.retryable);
    }

    fn profile(url: &str) -> ConnectLanggraphProfile {
        ConnectLanggraphProfile {
            name: "lab".into(),
            url: url.into(),
            api_key: None,
            headers: None,
            tls: None,
        }
    }

    #[test]
    fn the_url_is_checked() {
        let field = |url: &str| {
            LangGraphClient::new(&profile(url))
                .err()
                .and_then(|e| e.field)
        };
        assert_eq!(field("not a url").as_deref(), Some("url"));
        assert_eq!(field("ftp://host").as_deref(), Some("url"));
        assert_eq!(field("http://user:pw@host").as_deref(), Some("url"));
        let client = LangGraphClient::new(&profile("https://lg.example:8443/api/")).unwrap();
        assert_eq!(
            client.url(
                "/store/items",
                &[("namespace", "a.b".into()), ("key", "k 1".into())]
            ),
            "https://lg.example:8443/api/store/items?namespace=a.b&key=k+1"
        );
        assert_eq!(client.address, "lg.example:8443");
    }

    #[test]
    fn bad_headers_are_refused() {
        let mut p = profile("http://127.0.0.1:2024");
        p.headers = Some(vec![super::super::HeaderPair {
            name: "bad name".into(),
            value: "x".into(),
        }]);
        assert_eq!(
            LangGraphClient::new(&p).err().unwrap().field.as_deref(),
            Some("headers")
        );
        p.headers = None;
        p.api_key = Some("line\nbreak".into());
        assert_eq!(
            LangGraphClient::new(&p).err().unwrap().field.as_deref(),
            Some("apiKey")
        );
    }
}
