//! JSON control payloads (Ambidex spec §3, §10).
//!
//! Field names follow the spec's handshake sketch (`schema_hash`, `client_version`). Unknown fields
//! are accepted so that additive changes within a protocol major stay compatible.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// First frame on every connection, client to server, `call_id` 0.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct Hello {
    pub protocol: u8,
    pub api: String,
    pub schema_hash: String,
    pub client_version: String,
    /// Authentication material (anti-CSRF token, bearer token, ...). Shape is defined by the
    /// [`Authenticate`](crate::engine::Authenticate) implementation (M3). Never logged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<Value>,
}

impl fmt::Debug for Hello {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Hello")
            .field("protocol", &self.protocol)
            .field("api", &self.api)
            .field("schema_hash", &self.schema_hash)
            .field("client_version", &self.client_version)
            .field("auth", &self.auth.as_ref().map(|_| "<redacted>"))
            .finish()
    }
}

/// Server reply to an accepted [`Hello`], `call_id` 0.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloAck {
    pub session: String,
    pub limits: Limits,
    pub server_version: String,
}

/// Limits the server enforces on this connection, advertised in [`HelloAck`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limits {
    /// Largest payload the server accepts in one frame.
    pub max_frame_bytes: u32,
    /// Calls the server runs concurrently on this connection.
    pub max_concurrent_calls: u32,
}

/// Payload of a `Call` frame.
///
/// The spec does not define this shape; `{procedure, input}` is provisional (Open question).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub procedure: String,
    #[serde(default)]
    pub input: Value,
}

/// Error codes, spec §10. Serialized as the variant name so TypeScript can narrow on
/// `e.code === "ApprovalRequired"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Code {
    Cancelled,
    DeadlineExceeded,
    Unauthenticated,
    PermissionDenied,
    ApprovalRequired,
    InvalidArgument,
    NotFound,
    FailedPrecondition,
    ResourceExhausted,
    Unavailable,
    Unimplemented,
    VersionMismatch,
    Internal,
}

/// Payload of an `Error` frame: the wire form of `RpcError` (spec §10).
///
/// `details` carries the procedure's typed domain error as JSON; typing it is the router's job.
/// `message` must be safe for display: no secrets, SQL values or backend details.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorPayload {
    pub code: Code,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default)]
    pub retryable: bool,
    #[serde(default)]
    pub correlation_id: String,
}

impl ErrorPayload {
    pub fn new(code: Code, message: impl Into<String>) -> ErrorPayload {
        ErrorPayload {
            code,
            message: message.into(),
            details: None,
            retryable: false,
            correlation_id: String::new(),
        }
    }
}

/// Payload of a `Goaway` frame, `call_id` 0: the sender is closing the connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Goaway {
    pub code: Code,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn hello_debug_redacts_auth() {
        let hello = Hello {
            protocol: 1,
            api: "dbee".into(),
            schema_hash: "abc".into(),
            client_version: "0.1.0".into(),
            auth: Some(json!({"csrf": "s3cret"})),
        };
        assert!(!format!("{hello:?}").contains("s3cret"));
    }

    #[test]
    fn error_code_serializes_as_name() {
        let err = ErrorPayload::new(Code::ApprovalRequired, "approval required");
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value["code"], "ApprovalRequired");
        assert!(value.get("details").is_none());
    }

    #[test]
    fn hello_accepts_unknown_fields() {
        let hello: Hello = serde_json::from_value(json!({
            "protocol": 1, "api": "dbee", "schema_hash": "h", "client_version": "1",
            "api_version": "1.2"
        }))
        .unwrap();
        assert_eq!(hello.auth, None);
    }
}
