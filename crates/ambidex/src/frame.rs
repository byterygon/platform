//! Frame codec (Ambidex spec §3).
//!
//! Every frame is a 12-byte little-endian header followed by `payload_len` bytes:
//!
//! | Field         | Size | Meaning                                              |
//! | ------------- | ---- | ---------------------------------------------------- |
//! | `version`     | u8   | Protocol major ([`PROTOCOL_VERSION`])                |
//! | `kind`        | u8   | [`Kind`]                                             |
//! | `flags`       | u16  | [`Flags`]                                            |
//! | `call_id`     | u32  | Chosen by the client; 0 = connection-level           |
//! | `payload_len` | u32  | Bytes that follow; bounded by the receiver's maximum |
//!
//! Transports are dumb byte pipes and may split or coalesce frames freely, so decoding is
//! incremental: feed bytes to a [`FrameDecoder`] and pull whole frames out. The decoder validates
//! the header before buffering any payload, so an oversize `payload_len` is rejected without
//! allocating for it.

use std::fmt;

/// Protocol major carried in every frame header.
pub const PROTOCOL_VERSION: u8 = 1;

/// Size of the fixed frame header in bytes.
pub const HEADER_LEN: usize = 12;

/// Default maximum payload size (16 MiB), spec §3. Final defaults are Open question 9.
pub const DEFAULT_MAX_FRAME_BYTES: u32 = 16 * 1024 * 1024;

/// Frame kind.
///
/// The spec lists the kinds but not their numeric values; these follow the spec's order starting
/// at 1, with 0 left invalid so a zeroed header never decodes. Provisional until confirmed in the
/// spec's Open questions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    HelloAck = 2,
    Call = 3,
    Result = 4,
    Error = 5,
    Cancel = 6,
    Chunk = 7,
    StreamEnd = 8,
    Credit = 9,
    Subscribe = 10,
    Event = 11,
    Unsubscribe = 12,
    Ping = 13,
    Pong = 14,
    Goaway = 15,
}

impl Kind {
    pub const ALL: [Kind; 15] = [
        Kind::Hello,
        Kind::HelloAck,
        Kind::Call,
        Kind::Result,
        Kind::Error,
        Kind::Cancel,
        Kind::Chunk,
        Kind::StreamEnd,
        Kind::Credit,
        Kind::Subscribe,
        Kind::Event,
        Kind::Unsubscribe,
        Kind::Ping,
        Kind::Pong,
        Kind::Goaway,
    ];

    pub fn from_u8(value: u8) -> Option<Kind> {
        Kind::ALL.get(usize::from(value).checked_sub(1)?).copied()
    }
}

/// Frame flags.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Flags(u16);

impl Flags {
    /// Payload is raw bytes; otherwise it is JSON.
    pub const BINARY: Flags = Flags(1 << 0);
    /// Payload is compressed. Reserved: not supported in v1, so frames carrying it are rejected.
    pub const COMPRESSED: Flags = Flags(1 << 1);

    /// Bits a v1 receiver accepts. Unknown and reserved bits are rejected (fail closed) rather
    /// than ignored, so a peer can never rely on a flag we silently drop.
    const SUPPORTED: u16 = Flags::BINARY.0;

    pub const fn empty() -> Flags {
        Flags(0)
    }

    pub const fn bits(self) -> u16 {
        self.0
    }

    pub const fn from_bits(bits: u16) -> Option<Flags> {
        if bits & !Flags::SUPPORTED == 0 {
            Some(Flags(bits))
        } else {
            None
        }
    }

    pub const fn contains(self, other: Flags) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn is_binary(self) -> bool {
        self.contains(Flags::BINARY)
    }
}

/// Decoded frame header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub kind: Kind,
    pub flags: Flags,
    pub call_id: u32,
    pub payload_len: u32,
}

impl Header {
    pub fn to_bytes(&self) -> [u8; HEADER_LEN] {
        let mut out = [0u8; HEADER_LEN];
        out[0] = PROTOCOL_VERSION;
        out[1] = self.kind as u8;
        out[2..4].copy_from_slice(&self.flags.bits().to_le_bytes());
        out[4..8].copy_from_slice(&self.call_id.to_le_bytes());
        out[8..12].copy_from_slice(&self.payload_len.to_le_bytes());
        out
    }

    /// Parses and validates a header. `max_payload` is the receiver's frame size limit.
    pub fn parse(bytes: &[u8; HEADER_LEN], max_payload: u32) -> Result<Header, FrameError> {
        if bytes[0] != PROTOCOL_VERSION {
            return Err(FrameError::UnsupportedVersion(bytes[0]));
        }
        let kind = Kind::from_u8(bytes[1]).ok_or(FrameError::UnknownKind(bytes[1]))?;
        let raw_flags = u16::from_le_bytes([bytes[2], bytes[3]]);
        let flags = Flags::from_bits(raw_flags).ok_or(FrameError::UnsupportedFlags(raw_flags))?;
        let call_id = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let payload_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
        if payload_len > max_payload {
            return Err(FrameError::PayloadTooLarge {
                len: u64::from(payload_len),
                max: max_payload,
            });
        }
        Ok(Header {
            kind,
            flags,
            call_id,
            payload_len,
        })
    }
}

/// One protocol frame.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: Kind,
    pub flags: Flags,
    pub call_id: u32,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn new(kind: Kind, call_id: u32, payload: Vec<u8>) -> Frame {
        Frame {
            kind,
            flags: Flags::empty(),
            call_id,
            payload,
        }
    }

    pub fn binary(kind: Kind, call_id: u32, payload: Vec<u8>) -> Frame {
        Frame {
            kind,
            flags: Flags::BINARY,
            call_id,
            payload,
        }
    }

    /// Encodes the frame, refusing payloads larger than `max_payload`.
    pub fn encode(&self, max_payload: u32) -> Result<Vec<u8>, FrameError> {
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        self.encode_into(&mut out, max_payload)?;
        Ok(out)
    }

    /// Appends the encoded frame to `out`. On error `out` is left unchanged.
    pub fn encode_into(&self, out: &mut Vec<u8>, max_payload: u32) -> Result<(), FrameError> {
        let payload_len = u32::try_from(self.payload.len())
            .ok()
            .filter(|len| *len <= max_payload)
            .ok_or(FrameError::PayloadTooLarge {
                len: self.payload.len() as u64,
                max: max_payload,
            })?;
        let header = Header {
            kind: self.kind,
            flags: self.flags,
            call_id: self.call_id,
            payload_len,
        };
        out.extend_from_slice(&header.to_bytes());
        out.extend_from_slice(&self.payload);
        Ok(())
    }
}

impl fmt::Debug for Frame {
    // Payloads can carry credentials (Hello.auth) or user data; print only their size.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Frame")
            .field("kind", &self.kind)
            .field("flags", &self.flags)
            .field("call_id", &self.call_id)
            .field("payload_len", &self.payload.len())
            .finish()
    }
}

/// A frame-level protocol violation. Every variant is fatal for the connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    UnsupportedVersion(u8),
    UnknownKind(u8),
    UnsupportedFlags(u16),
    PayloadTooLarge { len: u64, max: u32 },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::UnsupportedVersion(v) => write!(f, "unsupported protocol version {v}"),
            FrameError::UnknownKind(k) => write!(f, "unknown frame kind {k}"),
            FrameError::UnsupportedFlags(bits) => write!(f, "unsupported frame flags {bits:#06x}"),
            FrameError::PayloadTooLarge { len, max } => {
                write!(
                    f,
                    "frame payload of {len} bytes exceeds the {max}-byte limit"
                )
            }
        }
    }
}

impl std::error::Error for FrameError {}

/// Incremental frame decoder.
///
/// After an error the decoder is poisoned and keeps returning that error: the stream has lost
/// framing and the connection must be closed.
#[derive(Debug)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    max_payload: u32,
    header: Option<Header>,
    error: Option<FrameError>,
}

impl FrameDecoder {
    pub fn new(max_payload: u32) -> FrameDecoder {
        FrameDecoder {
            buf: Vec::new(),
            max_payload,
            header: None,
            error: None,
        }
    }

    pub fn max_payload(&self) -> u32 {
        self.max_payload
    }

    /// Appends received bytes. Call [`FrameDecoder::next_frame`] until it returns `Ok(None)`.
    pub fn push(&mut self, bytes: &[u8]) {
        if self.error.is_none() {
            self.buf.extend_from_slice(bytes);
        }
    }

    /// Bytes received but not yet returned as a frame.
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    pub fn next_frame(&mut self) -> Result<Option<Frame>, FrameError> {
        if let Some(err) = &self.error {
            return Err(err.clone());
        }
        let header = match self.header {
            Some(header) => header,
            None => {
                let Some(raw) = self.buf.first_chunk::<HEADER_LEN>() else {
                    return Ok(None);
                };
                match Header::parse(raw, self.max_payload) {
                    Ok(header) => {
                        self.buf.drain(..HEADER_LEN);
                        self.header = Some(header);
                        header
                    }
                    Err(err) => {
                        self.buf = Vec::new();
                        self.error = Some(err.clone());
                        return Err(err);
                    }
                }
            }
        };
        let len = header.payload_len as usize;
        if self.buf.len() < len {
            // Reserve once for the whole payload; bounded by max_payload.
            self.buf.reserve(len - self.buf.len());
            return Ok(None);
        }
        let rest = self.buf.split_off(len);
        let payload = std::mem::replace(&mut self.buf, rest);
        self.header = None;
        Ok(Some(Frame {
            kind: header.kind,
            flags: header.flags,
            call_id: header.call_id,
            payload,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_layout_is_little_endian() {
        let frame = Frame::new(Kind::Call, 0x0403_0201, b"{}".to_vec());
        let bytes = frame.encode(DEFAULT_MAX_FRAME_BYTES).unwrap();
        assert_eq!(
            bytes,
            [1, 3, 0, 0, 0x01, 0x02, 0x03, 0x04, 2, 0, 0, 0, b'{', b'}']
        );
    }

    #[test]
    fn kind_zero_and_out_of_range_are_invalid() {
        assert_eq!(Kind::from_u8(0), None);
        assert_eq!(Kind::from_u8(16), None);
        for kind in Kind::ALL {
            assert_eq!(Kind::from_u8(kind as u8), Some(kind));
        }
    }

    #[test]
    fn compressed_and_unknown_flags_are_rejected() {
        assert_eq!(Flags::from_bits(Flags::COMPRESSED.bits()), None);
        assert_eq!(Flags::from_bits(1 << 15), None);
        assert_eq!(Flags::from_bits(1), Some(Flags::BINARY));
    }

    #[test]
    fn oversize_header_is_rejected_before_payload_arrives() {
        let mut header = Header {
            kind: Kind::Chunk,
            flags: Flags::BINARY,
            call_id: 1,
            payload_len: 1025,
        }
        .to_bytes();
        let mut decoder = FrameDecoder::new(1024);
        decoder.push(&header);
        assert_eq!(
            decoder.next_frame(),
            Err(FrameError::PayloadTooLarge {
                len: 1025,
                max: 1024
            })
        );
        assert_eq!(decoder.buffered(), 0);
        // Poisoned: further input is ignored and the error repeats.
        header[8] = 0;
        decoder.push(&header);
        assert!(decoder.next_frame().is_err());
    }

    #[test]
    fn encoder_refuses_oversize_payload() {
        let frame = Frame::binary(Kind::Chunk, 1, vec![0; 11]);
        let mut out = vec![7];
        assert_eq!(
            frame.encode_into(&mut out, 10),
            Err(FrameError::PayloadTooLarge { len: 11, max: 10 })
        );
        assert_eq!(out, [7]);
    }

    #[test]
    fn debug_hides_payload() {
        let frame = Frame::new(Kind::Hello, 0, b"{\"auth\":\"secret\"}".to_vec());
        assert!(!format!("{frame:?}").contains("secret"));
    }
}
