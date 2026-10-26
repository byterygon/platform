//! Typed error model (Ambidex spec §10).
//!
//! [`RpcError<E>`] is what handlers and clients see: a [`Code`], a display-safe message and the
//! procedure's typed domain error in `details`. On the wire it travels as an
//! [`ErrorPayload`](crate::ErrorPayload) with `details` as JSON.

use std::fmt;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::message::{Code, ErrorPayload};

/// An RPC error with typed details.
///
/// `message` must be safe for display: no secrets, SQL values or backend details. `Internal`
/// errors never carry either: [`RpcError::into_payload`] replaces their message and drops their
/// details, so a handler cannot leak a backend error by accident.
#[derive(Clone, PartialEq, Serialize, Deserialize)]
pub struct RpcError<E = NoDetails> {
    pub code: Code,
    pub message: String,
    #[serde(default = "none", skip_serializing_if = "Option::is_none")]
    pub details: Option<E>,
    #[serde(default)]
    pub retryable: bool,
    /// Filled in by the engine when empty.
    #[serde(default)]
    pub correlation_id: String,
}

fn none<E>() -> Option<E> {
    None
}

/// Details type for errors that carry none. Uninhabited, so `details` is always `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NoDetails {}

impl<E> RpcError<E> {
    pub fn new(code: Code, message: impl Into<String>) -> RpcError<E> {
        RpcError {
            code,
            message: message.into(),
            details: None,
            retryable: false,
            correlation_id: String::new(),
        }
    }

    #[must_use]
    pub fn with_details(mut self, details: E) -> RpcError<E> {
        self.details = Some(details);
        self
    }

    #[must_use]
    pub fn with_retryable(mut self, retryable: bool) -> RpcError<E> {
        self.retryable = retryable;
        self
    }
}

impl RpcError<NoDetails> {
    /// Re-types a details-free error so a handler can return it from a procedure whose error type
    /// is `RpcError<E>`.
    pub fn cast<E>(self) -> RpcError<E> {
        RpcError {
            code: self.code,
            message: self.message,
            details: None,
            retryable: self.retryable,
            correlation_id: self.correlation_id,
        }
    }
}

impl<E: Serialize> RpcError<E> {
    /// Wire form. Details that fail to serialize turn the error into `Internal`.
    pub fn into_payload(self) -> ErrorPayload {
        if self.code == Code::Internal {
            return internal(self.correlation_id);
        }
        let details = match self.details.map(|d| serde_json::to_value(&d)) {
            None => None,
            Some(Ok(value)) => Some(value),
            Some(Err(_)) => return internal(self.correlation_id),
        };
        ErrorPayload {
            code: self.code,
            message: self.message,
            details,
            retryable: self.retryable,
            correlation_id: self.correlation_id,
        }
    }
}

fn internal(correlation_id: String) -> ErrorPayload {
    let mut payload = ErrorPayload::new(Code::Internal, "internal error");
    payload.correlation_id = correlation_id;
    payload
}

impl<E: DeserializeOwned> RpcError<E> {
    /// Client side: types an error received on the wire. Details that do not match `E` (for
    /// example from a newer server) are dropped; code, message and correlation id are kept.
    pub fn from_payload(payload: ErrorPayload) -> RpcError<E> {
        RpcError {
            code: payload.code,
            message: payload.message,
            details: payload.details.and_then(|d| serde_json::from_value(d).ok()),
            retryable: payload.retryable,
            correlation_id: payload.correlation_id,
        }
    }
}

impl From<ErrorPayload> for RpcError<serde_json::Value> {
    fn from(payload: ErrorPayload) -> Self {
        RpcError {
            code: payload.code,
            message: payload.message,
            details: payload.details,
            retryable: payload.retryable,
            correlation_id: payload.correlation_id,
        }
    }
}

impl<E: fmt::Debug> fmt::Debug for RpcError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RpcError")
            .field("code", &self.code)
            .field("message", &self.message)
            .field("details", &self.details)
            .field("retryable", &self.retryable)
            .field("correlation_id", &self.correlation_id)
            .finish()
    }
}

impl<E> fmt::Display for RpcError<E> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl<E: fmt::Debug> std::error::Error for RpcError<E> {}

/// A procedure's typed domain error (e.g. `QueryError`), sent as `details`.
///
/// The error decides its own [`Code`]; the message defaults to a generic one so that a variant's
/// fields never reach `message` unless the implementation chooses to put them there.
pub trait DomainError: Serialize {
    fn code(&self) -> Code;

    fn message(&self) -> String {
        format!("{:?}", self.code())
    }

    fn retryable(&self) -> bool {
        false
    }
}

impl<E: DomainError> From<E> for RpcError<E> {
    fn from(err: E) -> Self {
        RpcError {
            code: err.code(),
            message: err.message(),
            retryable: err.retryable(),
            details: Some(err),
            correlation_id: String::new(),
        }
    }
}

/// Error types a procedure handler may return: [`RpcError<E>`], any [`DomainError`],
/// [`Rejected`](crate::Rejected) from [`Ctx::authorize`](crate::Ctx::authorize), or a raw
/// [`ErrorPayload`].
pub trait IntoErrorPayload {
    fn into_error_payload(self) -> ErrorPayload;
}

impl<E: Serialize> IntoErrorPayload for RpcError<E> {
    fn into_error_payload(self) -> ErrorPayload {
        self.into_payload()
    }
}

impl<E: DomainError> IntoErrorPayload for E {
    fn into_error_payload(self) -> ErrorPayload {
        RpcError::from(self).into_payload()
    }
}

impl IntoErrorPayload for ErrorPayload {
    fn into_error_payload(self) -> ErrorPayload {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(tag = "kind")]
    enum QueryError {
        Syntax { position: u32 },
        Timeout,
    }

    impl DomainError for QueryError {
        fn code(&self) -> Code {
            match self {
                QueryError::Syntax { .. } => Code::InvalidArgument,
                QueryError::Timeout => Code::Unavailable,
            }
        }

        fn retryable(&self) -> bool {
            matches!(self, QueryError::Timeout)
        }
    }

    #[test]
    fn domain_error_round_trips_through_payload() {
        let err = RpcError::from(QueryError::Syntax { position: 7 });
        assert_eq!(err.code, Code::InvalidArgument);
        assert_eq!(err.message, "InvalidArgument");
        let payload = err.into_payload();
        assert_eq!(
            payload.details,
            Some(json!({"kind": "Syntax", "position": 7}))
        );
        let back = RpcError::<QueryError>::from_payload(payload);
        assert_eq!(back.details, Some(QueryError::Syntax { position: 7 }));
        assert!(QueryError::Timeout.into_error_payload().retryable);
    }

    #[test]
    fn internal_never_carries_details_or_message() {
        let err = RpcError::new(Code::Internal, "connection to 10.0.0.5 refused")
            .with_details(json!({"dsn": "postgres://admin:pw@db"}));
        let payload = err.into_payload();
        assert_eq!(payload.message, "internal error");
        assert_eq!(payload.details, None);
    }

    #[test]
    fn mismatched_details_are_dropped_on_the_client() {
        let mut payload = ErrorPayload::new(Code::NotFound, "gone");
        payload.details = Some(json!({"kind": "SomethingNew"}));
        let err = RpcError::<QueryError>::from_payload(payload);
        assert_eq!(err.code, Code::NotFound);
        assert_eq!(err.details, None);
    }

    #[test]
    fn details_free_error_serializes_without_details() {
        let value = serde_json::to_value(RpcError::<NoDetails>::new(Code::NotFound, "x")).unwrap();
        assert!(value.get("details").is_none());
        assert_eq!(value["code"], "NotFound");
    }
}
