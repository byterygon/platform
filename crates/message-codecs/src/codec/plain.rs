//! The codecs that need no schema: UTF-8, JSON, hex, base64 (Mightyconsole spec §5.2).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::{CodecError, Result};

/// Share of printable characters UTF-8 text needs for auto-detect (spec §5.2: 95%).
const PRINTABLE_SHARE: f64 = 0.95;

/// Whether `bytes` read as text: valid UTF-8 with at least 95% printable characters (tabs,
/// newlines and carriage returns count as printable). Empty payloads count as text.
pub fn looks_like_text(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    let mut total = 0usize;
    let mut printable = 0usize;
    for c in text.chars() {
        total += 1;
        if !c.is_control() || matches!(c, '\t' | '\n' | '\r') {
            printable += 1;
        }
    }
    total == 0 || printable as f64 / total as f64 >= PRINTABLE_SHARE
}

pub fn decode_utf8(bytes: &[u8]) -> Result<String> {
    std::str::from_utf8(bytes)
        .map(str::to_owned)
        .map_err(|e| CodecError::invalid(format!("not valid UTF-8 at byte {}", e.valid_up_to())))
}

/// Whether `bytes` are UTF-8 JSON whose top level is an object or an array (a bare number or
/// string stays `utf8`, spec §5.2).
pub fn looks_like_json(bytes: &[u8]) -> bool {
    let first = bytes.iter().find(|b| !b.is_ascii_whitespace());
    matches!(first, Some(b'{' | b'['))
        && serde_json::from_slice::<serde::de::IgnoredAny>(bytes).is_ok()
}

/// Decodes JSON: the text as sent (so key order and number spelling are kept) and the value.
pub fn decode_json(bytes: &[u8]) -> Result<(String, serde_json::Value)> {
    let text = decode_utf8(bytes)?;
    let value = serde_json::from_str(&text).map_err(|e| CodecError::json(&e))?;
    Ok((text, value))
}

/// Encodes JSON text: validated, sent as typed.
pub fn encode_json(text: &str) -> Result<Vec<u8>> {
    serde_json::from_str::<serde::de::IgnoredAny>(text).map_err(|e| CodecError::json(&e))?;
    Ok(text.as_bytes().to_vec())
}

pub fn decode_hex(bytes: &[u8]) -> String {
    hex::encode(bytes)
}

/// Encodes hex text; whitespace, `:` and a `0x` prefix are ignored.
pub fn encode_hex(text: &str) -> Result<Vec<u8>> {
    let t = text.trim();
    let t = t
        .strip_prefix("0x")
        .or_else(|| t.strip_prefix("0X"))
        .unwrap_or(t);
    let clean: String = t
        .chars()
        .filter(|c| !c.is_whitespace() && *c != ':')
        .collect();
    hex::decode(&clean).map_err(|e| CodecError::invalid(format!("not valid hex: {e}")))
}

pub fn decode_base64(bytes: &[u8]) -> String {
    BASE64.encode(bytes)
}

/// Encodes base64 text (standard alphabet, padding optional, whitespace ignored).
pub fn encode_base64(text: &str) -> Result<Vec<u8>> {
    let clean: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let padded = match clean.len() % 4 {
        2 => format!("{clean}=="),
        3 => format!("{clean}="),
        _ => clean,
    };
    BASE64
        .decode(padded)
        .map_err(|e| CodecError::invalid(format!("not valid base64: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_detection() {
        assert!(looks_like_text(b"hello\n\tworld"));
        assert!(looks_like_text(b""));
        assert!(looks_like_text("Xin chào".as_bytes()));
        assert!(!looks_like_text(&[0xff, 0xfe]));
        assert!(!looks_like_text(b"ab\x00\x01\x02\x03"));
        // 1 control character in 20 is exactly 95% printable.
        let mut s = vec![b'a'; 19];
        s.push(0x01);
        assert!(looks_like_text(&s));
    }

    #[test]
    fn json_detection() {
        assert!(looks_like_json(br#" {"a": 1}"#));
        assert!(looks_like_json(b"[1,2]"));
        assert!(!looks_like_json(b"42"));
        assert!(!looks_like_json(br#""text""#));
        assert!(!looks_like_json(b"{not json"));
    }

    #[test]
    fn round_trips() {
        let (text, value) = decode_json(br#"{"b":1,"a":12345678901234567890}"#).unwrap();
        assert_eq!(text, r#"{"b":1,"a":12345678901234567890}"#);
        assert!(value.is_object());
        assert_eq!(encode_json(&text).unwrap(), text.as_bytes());
        let err = encode_json("{\n  \"a\": }").unwrap_err();
        assert_eq!(err.position.unwrap().line, 2);

        let bytes = [0u8, 1, 0xab, 0xff];
        assert_eq!(decode_hex(&bytes), "0001abff");
        assert_eq!(encode_hex("00 01 ab:FF").unwrap(), bytes);
        assert_eq!(encode_hex("0x0001abff").unwrap(), bytes);
        assert!(encode_hex("0g").is_err());

        assert_eq!(decode_base64(&bytes), "AAGr/w==");
        assert_eq!(encode_base64("AAGr/w==").unwrap(), bytes);
        assert_eq!(encode_base64("AAGr/w").unwrap(), bytes);
        assert!(encode_base64("***").is_err());

        assert_eq!(decode_utf8("é".as_bytes()).unwrap(), "é");
        assert!(decode_utf8(&[b'a', 0xff]).is_err());
    }
}
