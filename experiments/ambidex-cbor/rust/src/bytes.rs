//! Canonical padded base64 for the explicit logical bytes scalar.
const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn encode(bytes: &[u8]) -> String {
    let mut out = String::new();
    for b in bytes.chunks(3) {
        let n = (b[0] as u32) << 16
            | (*b.get(1).unwrap_or(&0) as u32) << 8
            | *b.get(2).unwrap_or(&0) as u32;
        for shift in [18, 12] {
            out.push(ALPHABET[((n >> shift) & 63) as usize] as char);
        }
        out.push(if b.len() > 1 {
            ALPHABET[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if b.len() > 2 {
            ALPHABET[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
pub fn decode(s: &str) -> Result<Vec<u8>, String> {
    if s.len() > 349528 || !s.len().is_multiple_of(4) || !s.is_ascii() {
        return Err("base64 length".into());
    }
    let mut out = Vec::new();
    for part in s.as_bytes().chunks(4) {
        let mut n = 0u32;
        for c in part {
            n <<= 6;
            if *c != b'=' {
                n |= ALPHABET
                    .iter()
                    .position(|a| a == c)
                    .ok_or("base64 alphabet")? as u32;
            }
        }
        out.push((n >> 16) as u8);
        if part[2] != b'=' {
            out.push((n >> 8) as u8);
        }
        if part[3] != b'=' {
            out.push(n as u8);
        }
    }
    if out.len() > 262144 || encode(&out) != s {
        return Err("noncanonical base64".into());
    }
    Ok(out)
}
