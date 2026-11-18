//! The typed error every tool returns (Mightyconsole spec §2.6).
//!
//! Only Ambidex codes travel on the wire; [`ToolError`] is the `details` the UI reads to choose
//! its message and action (Retry, Edit profile, Trust dialog, Refresh). Tools build it with the
//! constructors below and never put a secret into `message` or `remote.detail`.

use ambidex::{Code, DomainError, RpcError, StreamEnded};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What went wrong, as the UI needs to know it (spec §2.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
pub enum ToolErrorKind {
    /// The target refused, timed out or is unreachable.
    Connect,
    /// The target rejected the credentials.
    Auth,
    /// The TLS handshake or verification failed.
    Tls,
    /// The SSH host key is unknown or changed.
    HostKey,
    /// The target denied the operation (ACL, RBAC, permissions).
    Forbidden,
    /// The named resource does not exist, or the `connId` is gone (`resource = "connection"`).
    NotFound,
    /// Exists already, wrong revision, not empty, not running.
    Conflict,
    /// Input the target or a codec rejected.
    Invalid,
    /// Any other target error, with its native code in `remote`.
    Remote,
}

/// The target's own error code, for Details.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RemoteError {
    /// Kafka error name, gRPC status, HTTP status, Kubernetes `Status.reason`, NATS error code.
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub detail: Option<String>,
}

/// Where in an input text an error is, 1-based (a codec's JSON, a schema, a jq program).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPosition {
    pub line: u32,
    pub column: u32,
}

/// `details` of every tool procedure's errors (spec §2.6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ToolError {
    pub kind: ToolErrorKind,
    /// The tool id (`nats`, `kafka`, `k8s`, ...), or `app` for shared procedures.
    pub system: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub remote: Option<RemoteError>,
    pub retryable: bool,
    /// For `NotFound`: what is missing (`connection`, `terminal`, `topic`, ...).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resource: Option<String>,
    /// For `Invalid`: the input field at fault, as the UI names it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub field: Option<String>,
    /// For `Invalid`: where in the field's text, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub position: Option<ErrorPosition>,
}

impl ToolError {
    pub fn new(kind: ToolErrorKind, system: &str, message: impl Into<String>) -> ToolError {
        ToolError {
            kind,
            system: system.into(),
            message: message.into(),
            remote: None,
            retryable: matches!(kind, ToolErrorKind::Connect),
            resource: None,
            field: None,
            position: None,
        }
    }

    /// The `connId` names no live handle of this session and tool.
    pub fn connection_gone(system: &str) -> ToolError {
        ToolError {
            resource: Some("connection".into()),
            ..ToolError::new(
                ToolErrorKind::NotFound,
                system,
                "this connection is closed; connect again",
            )
        }
    }

    pub fn not_found(system: &str, resource: &str, message: impl Into<String>) -> ToolError {
        ToolError {
            resource: Some(resource.into()),
            ..ToolError::new(ToolErrorKind::NotFound, system, message)
        }
    }

    pub fn invalid(system: &str, field: &str, message: impl Into<String>) -> ToolError {
        ToolError {
            field: Some(field.into()),
            ..ToolError::new(ToolErrorKind::Invalid, system, message)
        }
    }

    pub fn with_remote(mut self, remote: RemoteError) -> ToolError {
        self.remote = Some(remote);
        self
    }

    pub fn retryable(mut self, retryable: bool) -> ToolError {
        self.retryable = retryable;
        self
    }
}

impl DomainError for ToolError {
    fn code(&self) -> Code {
        match self.kind {
            ToolErrorKind::Connect | ToolErrorKind::Tls | ToolErrorKind::Remote => {
                Code::Unavailable
            }
            ToolErrorKind::Auth => Code::Unauthenticated,
            ToolErrorKind::HostKey | ToolErrorKind::Conflict => Code::FailedPrecondition,
            ToolErrorKind::Forbidden => Code::PermissionDenied,
            ToolErrorKind::NotFound => Code::NotFound,
            ToolErrorKind::Invalid => Code::InvalidArgument,
        }
    }

    fn message(&self) -> String {
        self.message.clone()
    }

    fn retryable(&self) -> bool {
        self.retryable
    }
}

/// What every tool procedure returns on failure.
pub type ToolResult<T> = Result<T, RpcError<ToolError>>;

/// A stream that ended (Cancel, deadline, disconnect) as the handler's error; the client already
/// knows the reason, so the value is never sent.
pub fn ended(e: StreamEnded) -> RpcError<ToolError> {
    RpcError::new(e.code(), "stream ended")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_map_to_the_codes_of_the_spec_table() {
        let code = |kind| ToolError::new(kind, "t", "m").code();
        assert_eq!(code(ToolErrorKind::Connect), Code::Unavailable);
        assert_eq!(code(ToolErrorKind::Auth), Code::Unauthenticated);
        assert_eq!(code(ToolErrorKind::Tls), Code::Unavailable);
        assert_eq!(code(ToolErrorKind::HostKey), Code::FailedPrecondition);
        assert_eq!(code(ToolErrorKind::Forbidden), Code::PermissionDenied);
        assert_eq!(code(ToolErrorKind::NotFound), Code::NotFound);
        assert_eq!(code(ToolErrorKind::Conflict), Code::FailedPrecondition);
        assert_eq!(code(ToolErrorKind::Invalid), Code::InvalidArgument);
        assert_eq!(code(ToolErrorKind::Remote), Code::Unavailable);
        assert!(ToolError::new(ToolErrorKind::Connect, "t", "m").retryable);
        assert!(!ToolError::new(ToolErrorKind::Auth, "t", "m").retryable);
    }

    #[test]
    fn the_payload_carries_the_details() {
        let payload = RpcError::from(ToolError::connection_gone("echo")).into_payload();
        assert_eq!(payload.code, Code::NotFound);
        let details = payload.details.unwrap();
        assert_eq!(details["kind"], "NotFound");
        assert_eq!(details["resource"], "connection");
        assert_eq!(details["system"], "echo");
        assert!(details.get("remote").is_none());
    }
}
