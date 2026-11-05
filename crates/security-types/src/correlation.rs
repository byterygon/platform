//! The shared correlation-id generator (Ambidex spec Open questions 24g and 26g).
//!
//! The Ambidex engine assigns ids at frame receipt (`<connection prefix>-<call id>`). Everything
//! else that needs one uses [`new_correlation_id`]: Ambidex calls made outside the engine (the
//! MCP adapter calling the router directly), transport-level refusals, and system-initiated
//! entries. No audit entry may have an empty correlation id.
//!
//! Each id is 128 bits from the OS random number generator, hex encoded: unique, not guessable,
//! and revealing nothing about how many ids the process issued (a counter would tell an agent how
//! many calls other principals made). Engine ids contain a `-`, these never do.

use std::fmt;

/// The OS could not supply randomness for a correlation id. Callers refuse the operation rather
/// than run it with an empty id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CorrelationIdError;

impl fmt::Display for CorrelationIdError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("no OS randomness for a correlation id")
    }
}

impl std::error::Error for CorrelationIdError {}

/// A fresh correlation id: 32 lowercase hex characters.
pub fn new_correlation_id() -> Result<String, CorrelationIdError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| CorrelationIdError)?;
    let mut id = String::with_capacity(32);
    for b in bytes {
        id.push_str(&format!("{b:02x}"));
    }
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_hex_and_distinct() {
        let a = new_correlation_id().unwrap();
        let b = new_correlation_id().unwrap();
        assert_eq!(a.len(), 32);
        assert!(
            a.bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_ne!(a, b);
        assert!(!a.contains('-'), "never confused with an engine id");
    }
}
