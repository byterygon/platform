//! Backend `ErrorResponse`/`NoticeResponse` to contract errors and notices.

use db_driver::{DbError, QueryError};
use fallible_iterator::FallibleIterator;
use postgres_protocol::message::backend::ErrorFields;

/// SQLSTATE `query_canceled`: a cancel request or `statement_timeout` stopped the statement.
pub(crate) const QUERY_CANCELED: &str = "57014";

/// The fields of a backend error or notice that the driver reports.
#[derive(Debug, Default)]
pub(crate) struct Diagnostic {
    pub(crate) severity: String,
    pub(crate) sqlstate: String,
    pub(crate) message: String,
    /// One-based character position in the submitted SQL. PostgreSQL counts characters of the
    /// UTF-8 query string, which are the contract's Unicode scalar values.
    pub(crate) position: Option<u64>,
}

impl Diagnostic {
    pub(crate) fn parse(mut fields: ErrorFields<'_>) -> Self {
        let mut d = Diagnostic::default();
        let mut localized_severity = String::new();
        while let Ok(Some(field)) = fields.next() {
            let value = String::from_utf8_lossy(field.value_bytes());
            match field.type_() {
                b'V' => d.severity = value.into_owned(),
                b'S' => localized_severity = value.into_owned(),
                b'C' => d.sqlstate = value.into_owned(),
                b'M' => d.message = value.into_owned(),
                // `p` (internal position) refers to an internal query, not the caller's SQL.
                b'P' => d.position = value.parse().ok().filter(|p| *p > 0),
                // Detail, hint, context and constraint fields can quote row data; not reported.
                _ => {}
            }
        }
        if d.severity.is_empty() {
            d.severity = localized_severity;
        }
        d
    }

    /// The contract error for a failed statement. Only the primary message, SQLSTATE and position
    /// are kept.
    pub(crate) fn into_db_error(self) -> DbError {
        let class = self.sqlstate.get(..2).unwrap_or_default();
        match self.sqlstate.as_str() {
            QUERY_CANCELED => return DbError::Cancelled,
            // admin_shutdown, crash_shutdown, cannot_connect_now: the session is gone.
            "57P01" | "57P02" | "57P03" => return DbError::ConnectionLost,
            _ => {}
        }
        if class == "08" {
            return DbError::ConnectionLost;
        }
        if class == "28" {
            return DbError::AuthenticationFailed;
        }
        let invalid = class == "42" && self.sqlstate != "42501";
        let error = QueryError {
            message: self.message,
            position: self.position,
            sqlstate: (!self.sqlstate.is_empty()).then_some(self.sqlstate),
            vendor_code: None,
        };
        if invalid {
            DbError::InvalidQuery(error)
        } else {
            DbError::DatabaseError(error)
        }
    }

    pub(crate) fn notice(&self) -> String {
        format!("{}: {}", self.severity, self.message)
    }
}

/// An error the driver reports in the server's terms, with a SQLSTATE.
pub(crate) fn invalid_query(message: &str, sqlstate: &str) -> DbError {
    DbError::InvalidQuery(QueryError {
        message: message.to_owned(),
        position: None,
        sqlstate: Some(sqlstate.to_owned()),
        vendor_code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn diag(sqlstate: &str) -> Diagnostic {
        Diagnostic {
            severity: "ERROR".into(),
            sqlstate: sqlstate.into(),
            message: "m".into(),
            position: Some(3),
        }
    }

    #[test]
    fn sqlstate_classes_map_to_contract_errors() {
        assert_eq!(diag("57014").into_db_error(), DbError::Cancelled);
        assert_eq!(diag("57P01").into_db_error(), DbError::ConnectionLost);
        assert_eq!(diag("08006").into_db_error(), DbError::ConnectionLost);
        assert_eq!(diag("28P01").into_db_error(), DbError::AuthenticationFailed);
        let syntax = QueryError {
            message: "m".into(),
            position: Some(3),
            sqlstate: Some("42601".into()),
            vendor_code: None,
        };
        assert_eq!(
            diag("42601").into_db_error(),
            DbError::InvalidQuery(syntax.clone())
        );
        assert_eq!(
            diag("42501").into_db_error(),
            DbError::DatabaseError(QueryError {
                sqlstate: Some("42501".into()),
                ..syntax.clone()
            })
        );
        assert_eq!(
            diag("25006").into_db_error(),
            DbError::DatabaseError(QueryError {
                sqlstate: Some("25006".into()),
                ..syntax
            })
        );
    }
}
