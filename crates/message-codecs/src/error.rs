//! Errors of the codecs and the schema sources. The kinds line up with a tool's error kinds
//! (Mightyconsole spec §2.6) so a server maps them one to one; this crate knows nothing of
//! Ambidex.

use std::fmt;

/// What went wrong, in the words of the spec's `ToolError.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorKind {
    /// Input the codec or the registry rejected (`Invalid`).
    Invalid,
    /// A schema, subject or version that does not exist (`NotFound`).
    NotFound,
    /// The registry is unreachable or timed out (`Connect`).
    Connect,
    /// The registry rejected the credentials (`Auth`).
    Auth,
    /// TLS handshake or verification failed (`Tls`).
    Tls,
    /// The registry denied the operation (`Forbidden`).
    Forbidden,
    /// The registry refused a change, e.g. an incompatible schema (`Conflict`).
    Conflict,
    /// Any other registry error (`Remote`), with its code in [`CodecError::remote`].
    Remote,
}

/// A position in an input text, 1-based.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Position {
    pub line: u32,
    pub column: u32,
}

impl Position {
    /// The position of a byte offset in `text`.
    pub fn of_offset(text: &str, offset: usize) -> Self {
        let offset = offset.min(text.len());
        let before = &text[..floor_char_boundary(text, offset)];
        let line = before.matches('\n').count() as u32 + 1;
        let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) as u32 + 1;
        Position { line, column }
    }
}

fn floor_char_boundary(text: &str, mut i: usize) -> usize {
    while i > 0 && !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// A remote error: the registry's error code and HTTP status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCode {
    /// `HTTP 409`, or the registry's `error_code` (`40901`).
    pub code: String,
    pub detail: Option<String>,
}

/// An error of this crate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CodecError {
    pub kind: ErrorKind,
    pub message: String,
    /// The input field the error is about (`key`, `value`, `headers`).
    pub field: Option<String>,
    pub position: Option<Position>,
    pub remote: Option<RemoteCode>,
}

impl CodecError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            field: None,
            position: None,
            remote: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::NotFound, message)
    }

    pub fn at(mut self, position: Position) -> Self {
        self.position = Some(position);
        self
    }

    pub fn field(mut self, field: impl Into<String>) -> Self {
        self.field = Some(field.into());
        self
    }

    /// A JSON parse error of `text`, with its position.
    pub fn json(err: &serde_json::Error) -> Self {
        let mut e = Self::invalid(format!("not valid JSON: {err}"));
        if err.line() > 0 {
            e.position = Some(Position {
                line: err.line() as u32,
                column: err.column() as u32,
            });
        }
        e
    }
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)?;
        if let Some(p) = self.position {
            write!(f, " (line {}, column {})", p.line, p.column)?;
        }
        Ok(())
    }
}

impl std::error::Error for CodecError {}

pub type Result<T, E = CodecError> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn positions() {
        assert_eq!(
            Position::of_offset("ab\ncd", 0),
            Position { line: 1, column: 1 }
        );
        assert_eq!(
            Position::of_offset("ab\ncd", 4),
            Position { line: 2, column: 2 }
        );
        assert_eq!(
            Position::of_offset("é\nx", 1),
            Position { line: 1, column: 1 }
        );
        assert_eq!(
            Position::of_offset("ab", 99),
            Position { line: 1, column: 3 }
        );
    }
}
