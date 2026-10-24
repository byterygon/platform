//! Property tests for the frame codec.

use ambidex::frame::{
    Flags, Frame, FrameDecoder, FrameError, HEADER_LEN, Header, Kind, PROTOCOL_VERSION,
};
use proptest::prelude::*;

const MAX: u32 = 4096;

fn kind() -> impl Strategy<Value = Kind> {
    prop::sample::select(Kind::ALL.to_vec())
}

fn frame() -> impl Strategy<Value = Frame> {
    (
        kind(),
        any::<bool>(),
        any::<u32>(),
        prop::collection::vec(any::<u8>(), 0..512),
    )
        .prop_map(|(kind, binary, call_id, payload)| Frame {
            kind,
            flags: if binary {
                Flags::BINARY
            } else {
                Flags::empty()
            },
            call_id,
            payload,
        })
}

fn decode_all(decoder: &mut FrameDecoder) -> Result<Vec<Frame>, FrameError> {
    let mut out = Vec::new();
    while let Some(frame) = decoder.next_frame()? {
        out.push(frame);
    }
    Ok(out)
}

proptest! {
    #[test]
    fn roundtrip(frame in frame()) {
        let bytes = frame.encode(MAX).unwrap();
        prop_assert_eq!(bytes.len(), HEADER_LEN + frame.payload.len());
        let mut decoder = FrameDecoder::new(MAX);
        decoder.push(&bytes);
        prop_assert_eq!(decode_all(&mut decoder).unwrap(), vec![frame]);
        prop_assert_eq!(decoder.buffered(), 0);
    }

    /// Transports may split and coalesce frames anywhere; decoding must not care.
    #[test]
    fn any_chunking_yields_same_frames(
        frames in prop::collection::vec(frame(), 0..8),
        cuts in prop::collection::vec(any::<prop::sample::Index>(), 0..16),
    ) {
        let mut stream = Vec::new();
        for frame in &frames {
            frame.encode_into(&mut stream, MAX).unwrap();
        }
        let mut cuts: Vec<usize> = cuts.iter().map(|i| i.index(stream.len() + 1)).collect();
        cuts.push(0);
        cuts.push(stream.len());
        cuts.sort_unstable();

        let mut decoder = FrameDecoder::new(MAX);
        let mut decoded = Vec::new();
        for pair in cuts.windows(2) {
            decoder.push(&stream[pair[0]..pair[1]]);
            decoded.extend(decode_all(&mut decoder).unwrap());
        }
        prop_assert_eq!(decoded, frames);
        prop_assert_eq!(decoder.buffered(), 0);
    }

    /// Arbitrary input never panics, never yields an oversize frame, and never makes the decoder
    /// hold more than one header plus one maximum payload beyond the pushed chunk.
    #[test]
    fn arbitrary_bytes_are_safe(chunks in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..64), 0..16)) {
        let max = 32;
        let mut decoder = FrameDecoder::new(max);
        let mut failed = None;
        for chunk in &chunks {
            decoder.push(chunk);
            loop {
                match decoder.next_frame() {
                    Ok(Some(frame)) => prop_assert!(frame.payload.len() <= max as usize),
                    Ok(None) => break,
                    Err(err) => {
                        // Once poisoned, the same error repeats.
                        if let Some(prev) = &failed {
                            prop_assert_eq!(prev, &err);
                        }
                        failed = Some(err);
                        break;
                    }
                }
            }
            prop_assert!(decoder.buffered() <= HEADER_LEN + max as usize + 64);
        }
    }

    #[test]
    fn header_roundtrip(kind in kind(), binary in any::<bool>(), call_id in any::<u32>(), len in 0..=MAX) {
        let header = Header {
            kind,
            flags: if binary { Flags::BINARY } else { Flags::empty() },
            call_id,
            payload_len: len,
        };
        prop_assert_eq!(Header::parse(&header.to_bytes(), MAX), Ok(header));
    }

    #[test]
    fn oversize_length_is_rejected(kind in kind(), len in (MAX + 1)..=u32::MAX) {
        let header = Header { kind, flags: Flags::empty(), call_id: 1, payload_len: len };
        prop_assert_eq!(
            Header::parse(&header.to_bytes(), MAX),
            Err(FrameError::PayloadTooLarge { len: u64::from(len), max: MAX })
        );
    }

    #[test]
    fn other_versions_are_rejected(version in any::<u8>().prop_filter("not v1", |v| *v != PROTOCOL_VERSION)) {
        let mut bytes = Header { kind: Kind::Ping, flags: Flags::empty(), call_id: 0, payload_len: 0 }.to_bytes();
        bytes[0] = version;
        prop_assert_eq!(Header::parse(&bytes, MAX), Err(FrameError::UnsupportedVersion(version)));
    }

    #[test]
    fn unknown_kinds_are_rejected(raw in any::<u8>().prop_filter("unknown", |k| Kind::from_u8(*k).is_none())) {
        let mut bytes = Header { kind: Kind::Ping, flags: Flags::empty(), call_id: 0, payload_len: 0 }.to_bytes();
        bytes[1] = raw;
        prop_assert_eq!(Header::parse(&bytes, MAX), Err(FrameError::UnknownKind(raw)));
    }

    #[test]
    fn unsupported_flags_are_rejected(bits in any::<u16>().prop_filter("has unsupported bit", |b| b & !1 != 0)) {
        let mut bytes = Header { kind: Kind::Ping, flags: Flags::empty(), call_id: 0, payload_len: 0 }.to_bytes();
        bytes[2..4].copy_from_slice(&bits.to_le_bytes());
        prop_assert_eq!(Header::parse(&bytes, MAX), Err(FrameError::UnsupportedFlags(bits)));
    }
}
