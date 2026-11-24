//! The second factor (DOC-25 §3.2.6, Open question 8): TOTP (RFC 6238: SHA-1, 30 s, 6 digits,
//! one step of drift either way) through `totp-rs`, recovery codes, and the enrolment QR image.
//!
//! A used step is never accepted twice: the store keeps the last step that signed in, and only
//! a later one passes ([`super::AccountStore::advance_totp_step`]).

use std::fmt;

use qrcodegen::{QrCode, QrCodeEcc};
use totp_rs::{Algorithm, Builder, Totp};
use zeroize::Zeroizing;

use crate::store::random_bytes;

/// Bytes of a TOTP key (160 bits, RFC 4226's recommendation for HMAC-SHA-1).
pub const TOTP_KEY_BYTES: usize = 20;
/// Seconds per step.
pub const TOTP_STEP_SECS: u64 = 30;
/// Recovery codes made at enrolment, each usable once.
pub const RECOVERY_CODES: usize = 10;

/// Crockford's base32: no I, L, O or U, so a code read aloud or typed is hard to get wrong.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// An account's TOTP key and the last step that signed in.
#[derive(Clone, PartialEq, Eq)]
pub struct TotpRecord {
    pub key: Zeroizing<Vec<u8>>,
    /// The last step accepted; only a later one passes.
    pub last_step: u64,
    pub enrolled_ms: u64,
}

impl fmt::Debug for TotpRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TotpRecord")
            .field("last_step", &self.last_step)
            .field("enrolled_ms", &self.enrolled_ms)
            .finish_non_exhaustive()
    }
}

/// A new random key.
pub(crate) fn new_key() -> Zeroizing<Vec<u8>> {
    let mut key = Zeroizing::new(random_bytes::<TOTP_KEY_BYTES>().to_vec());
    key.truncate(TOTP_KEY_BYTES);
    key
}

fn totp(key: &[u8], issuer: &str, account: &str) -> Option<Totp> {
    Builder::new()
        .with_algorithm(Algorithm::SHA1)
        .with_digits(6)
        .with_skew(1)
        .with_step_duration(TOTP_STEP_SECS)
        .with_secret(key.to_vec())
        .with_issuer(Some(issuer.replace(':', " ")))
        .with_account_name(account.replace(':', " "))
        .build()
        .ok()
}

/// The step a six-digit `code` matches at `now_ms`, one step of drift either way.
pub(crate) fn check(key: &[u8], code: &str, now_ms: u64) -> Option<u64> {
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    totp(key, "x", "x")?.check(code, now_ms / 1000)
}

/// The code for `now_ms` (tests and the enrolment check of a client).
pub fn code_at(key: &[u8], now_ms: u64) -> Option<String> {
    Some(totp(key, "x", "x")?.generate(now_ms / 1000).to_string())
}

/// The `otpauth://totp/...` URI an authenticator app reads.
pub(crate) fn uri(key: &[u8], issuer: &str, account: &str) -> Option<Zeroizing<String>> {
    totp(key, issuer, account)?
        .to_url()
        .ok()
        .map(Zeroizing::new)
}

/// Whether `code` looks like a TOTP code rather than a recovery code.
pub(crate) fn is_totp_code(code: &str) -> bool {
    code.len() == 6 && code.bytes().all(|b| b.is_ascii_digit())
}

/// A new recovery code: 10 symbols (50 random bits), shown as `XXXXX-XXXXX`.
pub(crate) fn new_recovery_code() -> Zeroizing<String> {
    let bytes = random_bytes::<10>();
    let symbols: String = bytes
        .iter()
        .map(|b| char::from(ALPHABET[usize::from(b & 31)]))
        .collect();
    Zeroizing::new(format!("{}-{}", &symbols[..5], &symbols[5..]))
}

/// A typed recovery code in the form it was hashed in: upper case, without separators, with the
/// letters Crockford's base32 reads as digits. `None` when it cannot be one.
pub(crate) fn normalize_recovery_code(code: &str) -> Option<Zeroizing<String>> {
    let mut out = Zeroizing::new(String::with_capacity(10));
    for c in code.chars() {
        let c = match c.to_ascii_uppercase() {
            '-' | ' ' => continue,
            'O' => '0',
            'I' | 'L' => '1',
            c => c,
        };
        if !c.is_ascii() || !ALPHABET.contains(&(c as u8)) {
            return None;
        }
        out.push(c);
    }
    (out.len() == 10).then_some(out)
}

/// The QR code of `text` as an SVG image: black modules on white, four modules of margin.
pub(crate) fn qr_svg(text: &str) -> Option<String> {
    let qr = QrCode::encode_text(text, QrCodeEcc::Medium).ok()?;
    let border = 4;
    let size = qr.size() + 2 * border;
    let mut path = String::new();
    for y in 0..qr.size() {
        for x in 0..qr.size() {
            if qr.get_module(x, y) {
                path.push_str(&format!("M{},{}h1v1h-1z", x + border, y + border));
            }
        }
    }
    Some(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" \
         shape-rendering=\"crispEdges\"><rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/>\
         <path d=\"{path}\" fill=\"#000\"/></svg>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 appendix B, SHA-1: the key "12345678901234567890".
    #[test]
    fn rfc_6238_vectors() {
        let key = b"12345678901234567890";
        for (t, code) in [
            (59u64, "287082"),
            (1_111_111_109, "081804"),
            (1_234_567_890, "005924"),
        ] {
            assert_eq!(code_at(key, t * 1000).as_deref(), Some(code));
            assert_eq!(check(key, code, t * 1000), Some(t / 30));
        }
    }

    #[test]
    fn one_step_of_drift_either_way() {
        let key = new_key();
        let now = 1_800_000_000_000;
        let code = code_at(&key, now).unwrap();
        assert_eq!(check(&key, &code, now), Some(now / 30_000));
        assert!(check(&key, &code, now + 30_000).is_some());
        assert!(check(&key, &code, now - 30_000).is_some());
        assert!(check(&key, &code, now + 60_000).is_none());
        assert!(check(&key, "12345", now).is_none());
        assert!(check(&key, "12345a", now).is_none());
    }

    #[test]
    fn the_uri_and_the_qr_image() {
        let key = new_key();
        assert_eq!(key.len(), TOTP_KEY_BYTES);
        let uri = uri(&key, "Mightyconsole", "alice").unwrap();
        assert!(
            uri.starts_with("otpauth://totp/Mightyconsole:alice?secret="),
            "{}",
            *uri
        );
        assert!(uri.contains("issuer=Mightyconsole"));
        let svg = qr_svg(&uri).unwrap();
        assert!(svg.starts_with("<svg") && svg.ends_with("</svg>") && !svg.contains("script"));
    }

    #[test]
    fn recovery_codes() {
        let code = new_recovery_code();
        assert_eq!(code.len(), 11);
        assert_eq!(&code[5..6], "-");
        let plain = normalize_recovery_code(&code).unwrap();
        assert_eq!(plain.len(), 10);
        assert_eq!(
            normalize_recovery_code(&code.to_lowercase()).map(|c| c.to_string()),
            Some(plain.to_string())
        );
        assert_eq!(
            normalize_recovery_code("o1i2l-3abcd").map(|c| c.to_string()),
            Some("011213ABCD".to_owned())
        );
        assert!(
            normalize_recovery_code("ABCDE-FGHIU").is_none(),
            "U is not a symbol"
        );
        assert!(normalize_recovery_code("ABCD").is_none());
        assert!(!is_totp_code(&code) && is_totp_code("012345"));
        assert_ne!(new_recovery_code(), new_recovery_code());
    }
}
