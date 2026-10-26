use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// A 32-byte digest (SHA-256 or HMAC-SHA-256 output). Serialized as 64 lowercase hex characters.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Digest(pub [u8; 32]);

impl Digest {
    pub const ZERO: Digest = Digest([0; 32]);

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl From<[u8; 32]> for Digest {
    fn from(bytes: [u8; 32]) -> Self {
        Digest(bytes)
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for b in self.0 {
            write!(f, "{b:02x}")?;
        }
        Ok(())
    }
}

impl fmt::Debug for Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Digest({self})")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseDigestError;

impl fmt::Display for ParseDigestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("digest must be 64 lowercase hex characters")
    }
}

impl std::error::Error for ParseDigestError {}

impl FromStr for Digest {
    type Err = ParseDigestError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let s = s.as_bytes();
        if s.len() != 64 {
            return Err(ParseDigestError);
        }
        let nibble = |c: u8| match c {
            b'0'..=b'9' => Ok(c - b'0'),
            b'a'..=b'f' => Ok(c - b'a' + 10),
            _ => Err(ParseDigestError),
        };
        let mut out = [0u8; 32];
        for (byte, [hi, lo]) in out.iter_mut().zip(s.as_chunks::<2>().0) {
            *byte = (nibble(*hi)? << 4) | nibble(*lo)?;
        }
        Ok(Digest(out))
    }
}

impl Serialize for Digest {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for Digest {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(deserializer)?;
        s.parse().map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trip() {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(37);
        }
        let d = Digest(bytes);
        assert_eq!(d.to_string().parse::<Digest>(), Ok(d));
    }

    #[test]
    fn rejects_bad_hex() {
        assert!("ab".parse::<Digest>().is_err());
        assert!("G".repeat(64).parse::<Digest>().is_err());
        assert!(
            "A".repeat(64).parse::<Digest>().is_err(),
            "uppercase is not canonical"
        );
    }
}
