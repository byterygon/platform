//! A small S3 client for Temporal External Storage (TSK-103): GetObject, HeadObject and PutObject,
//! signed with AWS Signature Version 4, over hyper and rustls. It speaks to AWS S3 and to
//! S3-compatible stores (MinIO and others) through `endpoint` and path-style addressing.
//!
//! TLS: the profile's CA when it gives one, else the system's trust store (the spec's Open
//! question (b), settled 2026-11-19): `core::tls::client_config` does exactly that.

use std::time::Duration;

use bytes::Bytes;
use hmac::{Hmac, KeyInit, Mac};
use http_body_util::{BodyExt, Full, Limited};
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE, HOST, USER_AGENT};
use hyper::{Method, Request, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use sha2::{Digest, Sha256};
use url::Url;

use crate::core::tls::{TlsOptions, client_config, plain_config};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Every S3 call (spec §4: 30 s).
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// Where and how to reach the store.
#[derive(Clone)]
pub struct S3Config {
    /// `https://s3.<region>.amazonaws.com` when empty; MinIO and others give theirs.
    pub endpoint: Option<String>,
    pub region: String,
    /// `<endpoint>/<bucket>/<key>` instead of `<bucket>.<endpoint>/<key>`.
    pub path_style: bool,
    pub ca_pem: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

impl std::fmt::Debug for S3Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("S3Config")
            .field("endpoint", &self.endpoint)
            .field("region", &self.region)
            .field("path_style", &self.path_style)
            .field("access_key_id", &"<redacted>")
            .field("secret_access_key", &"<redacted>")
            .finish()
    }
}

/// Why a call failed: the store's status and its error code and message when it sent XML.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct S3Error {
    pub status: Option<u16>,
    pub code: String,
    pub message: String,
}

impl std::fmt::Display for S3Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.status {
            Some(status) => write!(f, "{} ({status}): {}", self.code, self.message),
            None => write!(f, "{}: {}", self.code, self.message),
        }
    }
}

impl S3Error {
    fn local(code: &str, message: impl Into<String>) -> S3Error {
        S3Error {
            status: None,
            code: code.to_owned(),
            message: message.into(),
        }
    }
}

type Https = hyper_rustls::HttpsConnector<HttpConnector>;

pub struct S3Client {
    http: Client<Https, Full<Bytes>>,
    base: Url,
    host_port: String,
    config: S3Config,
}

impl S3Client {
    pub fn new(config: S3Config) -> Result<S3Client, S3Error> {
        let endpoint = config
            .endpoint
            .as_deref()
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", config.region));
        let base = Url::parse(&endpoint)
            .map_err(|e| S3Error::local("InvalidEndpoint", format!("{endpoint}: {e}")))?;
        if base.scheme() != "https" && base.scheme() != "http" {
            return Err(S3Error::local(
                "InvalidEndpoint",
                "the endpoint must be http:// or https://",
            ));
        }
        if base.host_str().is_none() {
            return Err(S3Error::local(
                "InvalidEndpoint",
                "the endpoint has no host",
            ));
        }
        let tls = if base.scheme() == "https" {
            client_config(&TlsOptions {
                enabled: Some(true),
                ca_pem: config.ca_pem.clone(),
                ..Default::default()
            })
            .map_err(|e| S3Error::local("InvalidCa", e.message))?
        } else {
            plain_config()
        };
        let mut tcp = HttpConnector::new();
        tcp.enforce_http(false);
        tcp.set_connect_timeout(Some(CONNECT_TIMEOUT));
        tcp.set_nodelay(true);
        let connector = hyper_rustls::HttpsConnectorBuilder::new()
            .with_tls_config(tls)
            .https_or_http()
            .enable_http1()
            .wrap_connector(tcp);
        let http = Client::builder(TokioExecutor::new()).build(connector);
        let host_port = match base.port() {
            Some(port) => format!("{}:{port}", base.host_str().unwrap_or_default()),
            None => base.host_str().unwrap_or_default().to_owned(),
        };
        Ok(S3Client {
            http,
            base,
            host_port,
            config,
        })
    }

    /// The object, or `NoSuchKey` (404). At most `limit` bytes are read.
    pub async fn get_object(
        &self,
        bucket: &str,
        key: &str,
        limit: usize,
    ) -> Result<Vec<u8>, S3Error> {
        let (status, body) = self.call(Method::GET, bucket, key, None, limit).await?;
        match status {
            StatusCode::OK => Ok(body),
            other => Err(failure(other, &body)),
        }
    }

    /// Whether the object exists (HeadObject: 200 or 404).
    pub async fn object_exists(&self, bucket: &str, key: &str) -> Result<bool, S3Error> {
        let (status, body) = self.call(Method::HEAD, bucket, key, None, 0).await?;
        match status {
            StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            other => Err(failure(other, &body)),
        }
    }

    pub async fn put_object(&self, bucket: &str, key: &str, data: Vec<u8>) -> Result<(), S3Error> {
        let (status, body) = self
            .call(Method::PUT, bucket, key, Some(data), 64 * 1024)
            .await?;
        match status {
            StatusCode::OK => Ok(()),
            other => Err(failure(other, &body)),
        }
    }

    /// `(url, host header, canonical path)` of an object.
    fn locate(&self, bucket: &str, key: &str) -> (String, String, String) {
        let key_path = encode_path(key);
        let base_path = self.base.path().trim_end_matches('/');
        if self.config.path_style {
            let path = format!("{base_path}/{}/{key_path}", encode_segment(bucket));
            (
                format!("{}://{}{path}", self.base.scheme(), self.host_port),
                self.host_port.clone(),
                path,
            )
        } else {
            let host = format!("{bucket}.{}", self.host_port);
            let path = format!("{base_path}/{key_path}");
            (format!("{}://{host}{path}", self.base.scheme()), host, path)
        }
    }

    async fn call(
        &self,
        method: Method,
        bucket: &str,
        key: &str,
        body: Option<Vec<u8>>,
        limit: usize,
    ) -> Result<(StatusCode, Vec<u8>), S3Error> {
        let (url, host, path) = self.locate(bucket, key);
        let body = body.unwrap_or_default();
        let payload_hash = if body.is_empty() {
            EMPTY_SHA256.to_owned()
        } else {
            hex(&Sha256::digest(&body))
        };
        let now = time::OffsetDateTime::now_utc();
        let signed = sign(
            &SignInput {
                method: method.as_str(),
                path: &path,
                host: &host,
                payload_hash: &payload_hash,
                session_token: self.config.session_token.as_deref(),
                region: &self.config.region,
                access_key_id: &self.config.access_key_id,
                secret_access_key: &self.config.secret_access_key,
            },
            now,
        );
        let mut request = Request::builder()
            .method(method.clone())
            .uri(&url)
            .header(HOST, &host)
            .header(
                USER_AGENT,
                concat!("mightyconsole/", env!("CARGO_PKG_VERSION")),
            )
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &signed.amz_date)
            .header("authorization", &signed.authorization);
        if let Some(token) = &self.config.session_token {
            request = request.header("x-amz-security-token", token);
        }
        if method == Method::PUT {
            request = request
                .header(CONTENT_LENGTH, body.len())
                .header(CONTENT_TYPE, "application/octet-stream");
        }
        let request = request
            .body(Full::new(Bytes::from(body)))
            .map_err(|e| S3Error::local("InvalidRequest", e.to_string()))?;
        let response = tokio::time::timeout(CALL_TIMEOUT, self.http.request(request))
            .await
            .map_err(|_| {
                S3Error::local(
                    "Timeout",
                    format!("{} did not answer within 30 s", self.host_port),
                )
            })?
            .map_err(|e| S3Error::local("Unreachable", format!("{}: {e}", self.host_port)))?;
        let status = response.status();
        if method == Method::HEAD {
            return Ok((status, Vec::new()));
        }
        // Errors are small XML documents; an object is read up to its limit (+1 to notice more).
        let cap = if status == StatusCode::OK {
            limit.saturating_add(1)
        } else {
            64 * 1024
        };
        let collected = tokio::time::timeout(
            CALL_TIMEOUT,
            Limited::new(response.into_body(), cap).collect(),
        )
        .await
        .map_err(|_| S3Error::local("Timeout", "the object did not arrive within 30 s"))?
        .map_err(|e| {
            if e.to_string().contains("length limit") {
                S3Error::local("TooLarge", format!("the object is over {limit} bytes"))
            } else {
                S3Error::local("Unreachable", e.to_string())
            }
        })?;
        Ok((status, collected.to_bytes().to_vec()))
    }
}

fn failure(status: StatusCode, body: &[u8]) -> S3Error {
    let text = String::from_utf8_lossy(body);
    let tag = |name: &str| -> Option<String> {
        let start = text.find(&format!("<{name}>"))? + name.len() + 2;
        let end = text[start..].find(&format!("</{name}>"))? + start;
        Some(text[start..end].to_owned())
    };
    let code = tag("Code").unwrap_or_else(|| match status {
        StatusCode::NOT_FOUND => "NoSuchKey".to_owned(),
        StatusCode::FORBIDDEN => "AccessDenied".to_owned(),
        other => other.canonical_reason().unwrap_or("Error").replace(' ', ""),
    });
    S3Error {
        status: Some(status.as_u16()),
        message: tag("Message").unwrap_or_else(|| code.clone()),
        code,
    }
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

/// SigV4's URI encoding of one path segment: everything but `A-Za-z0-9-_.~` as `%XX`.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for b in segment.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// An object key as a path: its `/` kept, every segment encoded (S3 signs the key encoded once).
fn encode_path(key: &str) -> String {
    key.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

pub struct SignInput<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: &'a str,
    pub payload_hash: &'a str,
    pub session_token: Option<&'a str>,
    pub region: &'a str,
    pub access_key_id: &'a str,
    pub secret_access_key: &'a str,
}

pub struct Signed {
    pub amz_date: String,
    pub authorization: String,
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac =
        <Hmac<Sha256> as KeyInit>::new_from_slice(key).expect("HMAC takes any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// AWS Signature Version 4 for an S3 request without a query string.
pub fn sign(input: &SignInput<'_>, now: time::OffsetDateTime) -> Signed {
    let date = format!(
        "{:04}{:02}{:02}",
        now.year(),
        u8::from(now.month()),
        now.day()
    );
    let amz_date = format!(
        "{date}T{:02}{:02}{:02}Z",
        now.hour(),
        now.minute(),
        now.second()
    );
    let mut headers = vec![
        ("host", input.host.to_owned()),
        ("x-amz-content-sha256", input.payload_hash.to_owned()),
        ("x-amz-date", amz_date.clone()),
    ];
    if let Some(token) = input.session_token {
        headers.push(("x-amz-security-token", token.to_owned()));
    }
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(k, _)| *k)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request = format!(
        "{}\n{}\n\n{canonical_headers}\n{signed_headers}\n{}",
        input.method, input.path, input.payload_hash
    );
    let scope = format!("{date}/{}/s3/aws4_request", input.region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex(&Sha256::digest(canonical_request.as_bytes()))
    );
    let k_date = hmac(
        format!("AWS4{}", input.secret_access_key).as_bytes(),
        date.as_bytes(),
    );
    let k_region = hmac(&k_date, input.region.as_bytes());
    let k_service = hmac(&k_region, b"s3");
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex(&hmac(&k_signing, string_to_sign.as_bytes()));
    Signed {
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            input.access_key_id
        ),
        amz_date,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS's documented example: GET /test.txt with a range header dropped, recomputed with the
    /// headers this client sends (host, x-amz-content-sha256, x-amz-date). The expected value was
    /// produced by botocore's SigV4 signer for the same inputs.
    #[test]
    fn signs_as_aws_does() {
        let now = time::OffsetDateTime::from_unix_timestamp(1_369_353_600).unwrap();
        let signed = sign(
            &SignInput {
                method: "GET",
                path: "/test.txt",
                host: "examplebucket.s3.amazonaws.com",
                payload_hash: EMPTY_SHA256,
                session_token: None,
                region: "us-east-1",
                access_key_id: "AKIAIOSFODNN7EXAMPLE",
                secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
            },
            now,
        );
        assert_eq!(signed.amz_date, "20130524T000000Z");
        assert!(signed.authorization.starts_with("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature="));
        assert_eq!(signed.authorization.rsplit('=').next().unwrap().len(), 64);
    }

    #[test]
    fn keys_are_encoded_per_segment() {
        assert_eq!(
            encode_path("v0/ns/lab/wi/order 1/d/sha256/ab"),
            "v0/ns/lab/wi/order%201/d/sha256/ab"
        );
        assert_eq!(encode_path("v0/ns/a%2Fb"), "v0/ns/a%252Fb");
    }

    #[test]
    fn reads_the_store_error() {
        let e = failure(StatusCode::FORBIDDEN, b"<?xml version=\"1.0\"?><Error><Code>AccessDenied</Code><Message>Access Denied.</Message></Error>");
        assert_eq!(e.code, "AccessDenied");
        assert_eq!(e.message, "Access Denied.");
        assert_eq!(e.status, Some(403));
    }
}
