//! Isolated TSK-21 experiments; not a production codec.

/// The lossless JSON integer representation is canonical decimal text.
pub fn decode_i64(text: &str) -> Result<i64, &'static str> {
    let value: i64 = text.parse().map_err(|_| "invalid int64")?;
    if value.to_string() != text {
        return Err("noncanonical int64");
    }
    Ok(value)
}

pub fn decode_u64(text: &str) -> Result<u64, &'static str> {
    let value: u64 = text.parse().map_err(|_| "invalid uint64")?;
    if value.to_string() != text {
        return Err("noncanonical uint64");
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_integer_boundaries() {
        for value in [
            i64::MIN,
            -1,
            0,
            9007199254740991,
            9007199254740992,
            9007199254740993,
            i64::MAX,
        ] {
            assert_eq!(decode_i64(&value.to_string()), Ok(value));
        }
        assert_eq!(decode_u64("18446744073709551615"), Ok(u64::MAX));
        for text in ["-0", "+1", "01", "1.0", "1e0", " 1", "9223372036854775808"] {
            assert!(decode_i64(text).is_err(), "{text}");
        }
        assert!(decode_u64("-1").is_err());
        assert!(decode_u64("18446744073709551616").is_err());
    }
}

pub mod cbor;

#[cfg(test)]
mod baseline {
    #[test]
    fn serde_json_preserves_full_u64() {
        let value: serde_json::Value = serde_json::from_str("18446744073709551615").unwrap();
        assert_eq!(value.as_u64(), Some(u64::MAX));
        assert_eq!(
            serde_json::to_string(&value).unwrap(),
            "18446744073709551615"
        );
    }
}
