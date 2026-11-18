//! The Confluent wire format (Mightyconsole spec §5.3): magic byte 0, the schema id as a
//! big-endian `u32`, then for Protobuf the message-index array, then the payload.
//!
//! The message-index array is a zig-zag varint count followed by that many zig-zag varint
//! indexes, each the position of a message among its parent's nested messages (the first
//! index among the file's top-level messages). A count of 0 stands for `[0]`, the first
//! top-level message, which is what most producers write.

use crate::{CodecError, Result};

/// The magic byte of the Confluent wire format.
pub const MAGIC: u8 = 0;

/// The 5-byte header: magic byte and schema id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WireHeader {
    pub schema_id: u32,
}

/// Splits a payload in the wire format into its header and the rest, or `None` when it is too
/// short or does not start with the magic byte.
pub fn split(bytes: &[u8]) -> Option<(WireHeader, &[u8])> {
    if bytes.len() < 5 || bytes[0] != MAGIC {
        return None;
    }
    let schema_id = u32::from_be_bytes([bytes[1], bytes[2], bytes[3], bytes[4]]);
    Some((WireHeader { schema_id }, &bytes[5..]))
}

/// Reads the Protobuf message indexes at the start of `rest`; returns them and the payload.
pub fn split_message_indexes(rest: &[u8]) -> Result<(Vec<i32>, &[u8])> {
    let mut pos = 0;
    let count = read_zigzag(rest, &mut pos)?;
    if count == 0 {
        return Ok((vec![0], &rest[pos..]));
    }
    if !(0..=1024).contains(&count) {
        return Err(CodecError::invalid(format!(
            "wire format: message index count {count} is out of range"
        )));
    }
    let mut indexes = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let i = read_zigzag(rest, &mut pos)?;
        if i < 0 || i > i64::from(i32::MAX) {
            return Err(CodecError::invalid(format!(
                "wire format: message index {i} is out of range"
            )));
        }
        indexes.push(i as i32);
    }
    Ok((indexes, &rest[pos..]))
}

/// Writes a payload in the wire format. `indexes` is `Some` for Protobuf.
pub fn write(schema_id: u32, indexes: Option<&[i32]>, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(MAGIC);
    out.extend_from_slice(&schema_id.to_be_bytes());
    if let Some(indexes) = indexes {
        if indexes == [0] {
            write_zigzag(&mut out, 0);
        } else {
            write_zigzag(&mut out, indexes.len() as i64);
            for &i in indexes {
                write_zigzag(&mut out, i64::from(i));
            }
        }
    }
    out.extend_from_slice(payload);
    out
}

fn read_zigzag(bytes: &[u8], pos: &mut usize) -> Result<i64> {
    let mut value: u64 = 0;
    let mut shift = 0;
    loop {
        let Some(&b) = bytes.get(*pos) else {
            return Err(CodecError::invalid(
                "wire format: message indexes end early",
            ));
        };
        *pos += 1;
        if shift >= 64 {
            return Err(CodecError::invalid(
                "wire format: message index varint is too long",
            ));
        }
        value |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            break;
        }
        shift += 7;
    }
    Ok(((value >> 1) as i64) ^ -((value & 1) as i64))
}

fn write_zigzag(out: &mut Vec<u8>, v: i64) {
    let mut n = ((v << 1) ^ (v >> 63)) as u64;
    loop {
        let b = (n & 0x7f) as u8;
        n >>= 7;
        if n == 0 {
            out.push(b);
            break;
        }
        out.push(b | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header() {
        let bytes = write(258, None, b"abc");
        assert_eq!(bytes, [0, 0, 0, 1, 2, b'a', b'b', b'c']);
        let (h, rest) = split(&bytes).unwrap();
        assert_eq!(h.schema_id, 258);
        assert_eq!(rest, b"abc");
        assert!(split(&[0, 0, 0]).is_none());
        assert!(split(&[1, 0, 0, 0, 1]).is_none());
    }

    #[test]
    fn message_indexes() {
        // A single 0 means the first message.
        let bytes = write(1, Some(&[0]), b"p");
        assert_eq!(&bytes[5..], [0, b'p']);
        let (_, rest) = split(&bytes).unwrap();
        assert_eq!(split_message_indexes(rest).unwrap(), (vec![0], &b"p"[..]));

        // [1, 2]: count 2, then 1 and 2, zig-zag encoded (4, 2, 4).
        let bytes = write(1, Some(&[1, 2]), b"p");
        assert_eq!(&bytes[5..], [4, 2, 4, b'p']);
        let (_, rest) = split(&bytes).unwrap();
        assert_eq!(
            split_message_indexes(rest).unwrap(),
            (vec![1, 2], &b"p"[..])
        );

        // Large indexes take several varint bytes.
        let bytes = write(1, Some(&[300]), b"");
        let (_, rest) = split(&bytes).unwrap();
        assert_eq!(split_message_indexes(rest).unwrap().0, vec![300]);

        assert!(split_message_indexes(&[4, 2]).is_err());
        assert!(split_message_indexes(&[3]).is_err());
    }
}
