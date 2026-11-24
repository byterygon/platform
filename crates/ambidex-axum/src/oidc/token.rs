//! The identity provider's keys and ID token validation (DOC-25 §3.2.2 step 3).
//!
//! `jsonwebtoken` checks the JWS signature only. Everything else is checked here, against the
//! server's clock: the header (`alg` in the allowlist and agreeing with the key, a `kid` the
//! JWKS has, no `crit`, no JWE), then `iss`, `aud`, `azp`, `exp`, `iat`, `nbf`, `nonce` and
//! `sub`. Keys embedded in the header (`jwk`, `jku`, `x5u`, `x5c`) are never used.

use std::collections::HashMap;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, DecodingKey, Validation};
use serde_json::{Map, Value};

use crate::session::constant_time_eq;

/// An ID token signature algorithm the configuration may allow. `none` and the HMAC family
/// are not in it, so they can never be configured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SignatureAlgorithm {
    Rs256,
    Rs384,
    Rs512,
    Ps256,
    Ps384,
    Ps512,
    Es256,
    Es384,
    EdDsa,
}

impl SignatureAlgorithm {
    /// The default and maximum allowlist (DOC-25 §3.2.1).
    pub const ALL: [SignatureAlgorithm; 9] = [
        SignatureAlgorithm::Rs256,
        SignatureAlgorithm::Rs384,
        SignatureAlgorithm::Rs512,
        SignatureAlgorithm::Ps256,
        SignatureAlgorithm::Ps384,
        SignatureAlgorithm::Ps512,
        SignatureAlgorithm::Es256,
        SignatureAlgorithm::Es384,
        SignatureAlgorithm::EdDsa,
    ];

    /// The JOSE name (`RS256`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            SignatureAlgorithm::Rs256 => "RS256",
            SignatureAlgorithm::Rs384 => "RS384",
            SignatureAlgorithm::Rs512 => "RS512",
            SignatureAlgorithm::Ps256 => "PS256",
            SignatureAlgorithm::Ps384 => "PS384",
            SignatureAlgorithm::Ps512 => "PS512",
            SignatureAlgorithm::Es256 => "ES256",
            SignatureAlgorithm::Es384 => "ES384",
            SignatureAlgorithm::EdDsa => "EdDSA",
        }
    }

    /// Parses a JOSE name. `none`, `HS256`, `HS384`, `HS512` and anything unknown are `None`.
    pub fn parse(name: &str) -> Option<SignatureAlgorithm> {
        SignatureAlgorithm::ALL
            .into_iter()
            .find(|alg| alg.as_str() == name)
    }

    fn jws(self) -> Algorithm {
        match self {
            SignatureAlgorithm::Rs256 => Algorithm::RS256,
            SignatureAlgorithm::Rs384 => Algorithm::RS384,
            SignatureAlgorithm::Rs512 => Algorithm::RS512,
            SignatureAlgorithm::Ps256 => Algorithm::PS256,
            SignatureAlgorithm::Ps384 => Algorithm::PS384,
            SignatureAlgorithm::Ps512 => Algorithm::PS512,
            SignatureAlgorithm::Es256 => Algorithm::ES256,
            SignatureAlgorithm::Es384 => Algorithm::ES384,
            SignatureAlgorithm::EdDsa => Algorithm::EdDSA,
        }
    }

    fn fits(self, kind: KeyKind) -> bool {
        use SignatureAlgorithm::*;
        matches!(
            (self, kind),
            (Rs256 | Rs384 | Rs512 | Ps256 | Ps384 | Ps512, KeyKind::Rsa)
                | (Es256, KeyKind::P256)
                | (Es384, KeyKind::P384)
                | (EdDsa, KeyKind::Ed25519)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum KeyKind {
    Rsa,
    P256,
    P384,
    Ed25519,
}

struct VerifyKey {
    key: DecodingKey,
    alg: Option<SignatureAlgorithm>,
    kind: KeyKind,
}

/// The signing keys of a JWKS, by `kid`.
#[derive(Default)]
pub(crate) struct Keys {
    by_kid: HashMap<String, VerifyKey>,
    /// Keys left out (encryption keys, symmetric keys, unknown types, no `kid`).
    pub skipped: usize,
}

impl Keys {
    /// The usable signature keys of a JWKS document. Keys without a `kid`, for encryption, of
    /// type `oct` (symmetric), with an `alg` outside [`SignatureAlgorithm`], or that do not
    /// parse are skipped; a duplicate `kid` keeps the first.
    pub fn from_jwks(jwks: &Value) -> Result<Keys, String> {
        let list = jwks
            .get("keys")
            .and_then(Value::as_array)
            .ok_or("the JWKS has no \"keys\" array")?;
        let mut keys = Keys::default();
        for jwk in list {
            match parse_key(jwk) {
                Some((kid, key)) if !keys.by_kid.contains_key(&kid) => {
                    keys.by_kid.insert(kid, key);
                }
                _ => keys.skipped += 1,
            }
        }
        Ok(keys)
    }

    pub fn len(&self) -> usize {
        self.by_kid.len()
    }

    #[cfg(test)]
    pub fn has(&self, kid: &str) -> bool {
        self.by_kid.contains_key(kid)
    }
}

fn parse_key(jwk: &Value) -> Option<(String, VerifyKey)> {
    let text = |name: &str| jwk.get(name).and_then(Value::as_str);
    let kid = text("kid").filter(|k| !k.is_empty())?.to_owned();
    if text("use").is_some_and(|u| u != "sig") {
        return None;
    }
    let alg = match text("alg") {
        None => None,
        Some(name) => Some(SignatureAlgorithm::parse(name)?),
    };
    let (key, kind) = match (text("kty")?, text("crv")) {
        ("RSA", _) => (
            DecodingKey::from_rsa_components(text("n")?, text("e")?).ok()?,
            KeyKind::Rsa,
        ),
        ("EC", Some(crv @ ("P-256" | "P-384"))) => (
            DecodingKey::from_ec_components(text("x")?, text("y")?).ok()?,
            if crv == "P-256" {
                KeyKind::P256
            } else {
                KeyKind::P384
            },
        ),
        ("OKP", Some("Ed25519")) => (
            DecodingKey::from_ed_components(text("x")?).ok()?,
            KeyKind::Ed25519,
        ),
        _ => return None,
    };
    if alg.is_some_and(|alg| !alg.fits(kind)) {
        return None;
    }
    Some((kid, VerifyKey { key, alg, kind }))
}

/// What an ID token must match.
pub(crate) struct Expect<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: &'a str,
    pub algorithms: &'a [SignatureAlgorithm],
    pub skew_s: u64,
    pub now_s: u64,
}

/// Why an ID token was refused. The audit reason; never shown to the browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TokenError {
    Malformed,
    Jwe,
    Crit,
    Algorithm,
    UnknownKey,
    KeyMismatch,
    Signature,
    Issuer,
    Audience,
    Azp,
    Expired,
    IssuedInFuture,
    NotYetValid,
    Nonce,
    Subject,
}

impl TokenError {
    pub fn as_str(self) -> &'static str {
        match self {
            TokenError::Malformed => "id_token malformed",
            TokenError::Jwe => "id_token encrypted (JWE)",
            TokenError::Crit => "id_token header has crit",
            TokenError::Algorithm => "id_token alg not allowed",
            TokenError::UnknownKey => "id_token kid not in the JWKS",
            TokenError::KeyMismatch => "id_token alg does not fit the key",
            TokenError::Signature => "id_token signature invalid",
            TokenError::Issuer => "id_token iss wrong",
            TokenError::Audience => "id_token aud wrong",
            TokenError::Azp => "id_token azp wrong",
            TokenError::Expired => "id_token expired",
            TokenError::IssuedInFuture => "id_token iat in the future",
            TokenError::NotYetValid => "id_token nbf in the future",
            TokenError::Nonce => "id_token nonce wrong",
            TokenError::Subject => "id_token sub invalid",
        }
    }
}

/// The header fields that matter, read before any key is chosen.
pub(crate) struct TokenHeader {
    pub alg: SignatureAlgorithm,
    pub kid: String,
}

/// Reads and checks the header: three segments (a JWE has five), no `crit`, no `enc`, an
/// allowed `alg`, a `kid`.
pub(crate) fn header(
    token: &str,
    algorithms: &[SignatureAlgorithm],
) -> Result<TokenHeader, TokenError> {
    let segments: Vec<&str> = token.split('.').collect();
    if segments.len() == 5 {
        return Err(TokenError::Jwe);
    }
    if segments.len() != 3 || segments.iter().any(|s| s.is_empty()) {
        return Err(TokenError::Malformed);
    }
    let raw = URL_SAFE_NO_PAD
        .decode(segments[0])
        .map_err(|_| TokenError::Malformed)?;
    let header: Map<String, Value> =
        serde_json::from_slice(&raw).map_err(|_| TokenError::Malformed)?;
    if header.contains_key("enc") {
        return Err(TokenError::Jwe);
    }
    if header.contains_key("crit") {
        return Err(TokenError::Crit);
    }
    let alg = header
        .get("alg")
        .and_then(Value::as_str)
        .and_then(SignatureAlgorithm::parse)
        .filter(|alg| algorithms.contains(alg))
        .ok_or(TokenError::Algorithm)?;
    let kid = header
        .get("kid")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .ok_or(TokenError::UnknownKey)?
        .to_owned();
    Ok(TokenHeader { alg, kid })
}

/// Validates an ID token and returns its claims.
pub(crate) fn validate(
    token: &str,
    keys: &Keys,
    expect: &Expect<'_>,
) -> Result<Map<String, Value>, TokenError> {
    let head = header(token, expect.algorithms)?;
    let key = keys.by_kid.get(&head.kid).ok_or(TokenError::UnknownKey)?;
    if key.alg.is_some_and(|alg| alg != head.alg) || !head.alg.fits(key.kind) {
        return Err(TokenError::KeyMismatch);
    }
    let mut validation = Validation::new(head.alg.jws());
    validation.validate_exp = false;
    validation.validate_nbf = false;
    validation.validate_aud = false;
    validation.required_spec_claims.clear();
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<Map<String, Value>>(token, &key.key, &validation)
        .map_err(|e| match e.kind() {
            jsonwebtoken::errors::ErrorKind::InvalidSignature => TokenError::Signature,
            jsonwebtoken::errors::ErrorKind::Json(_)
            | jsonwebtoken::errors::ErrorKind::Base64(_)
            | jsonwebtoken::errors::ErrorKind::Utf8(_)
            | jsonwebtoken::errors::ErrorKind::InvalidToken => TokenError::Malformed,
            _ => TokenError::Signature,
        })?
        .claims;
    check_claims(&claims, expect)?;
    Ok(claims)
}

fn check_claims(claims: &Map<String, Value>, expect: &Expect<'_>) -> Result<(), TokenError> {
    if claims.get("iss").and_then(Value::as_str) != Some(expect.issuer) {
        return Err(TokenError::Issuer);
    }
    let audiences: Vec<&str> = match claims.get("aud") {
        Some(Value::String(aud)) => vec![aud.as_str()],
        Some(Value::Array(list)) => list.iter().filter_map(Value::as_str).collect(),
        _ => return Err(TokenError::Audience),
    };
    if !audiences.contains(&expect.client_id) {
        return Err(TokenError::Audience);
    }
    if matches!(claims.get("aud"), Some(Value::Array(list)) if list.len() > 1)
        && claims.get("azp").and_then(Value::as_str) != Some(expect.client_id)
    {
        return Err(TokenError::Azp);
    }
    let exp = number(claims.get("exp")).ok_or(TokenError::Expired)?;
    if exp <= expect.now_s.saturating_sub(expect.skew_s) {
        return Err(TokenError::Expired);
    }
    let iat = number(claims.get("iat")).ok_or(TokenError::IssuedInFuture)?;
    if iat > expect.now_s.saturating_add(expect.skew_s) {
        return Err(TokenError::IssuedInFuture);
    }
    if let Some(nbf) = claims.get("nbf") {
        let nbf = number(Some(nbf)).ok_or(TokenError::NotYetValid)?;
        if nbf > expect.now_s.saturating_add(expect.skew_s) {
            return Err(TokenError::NotYetValid);
        }
    }
    let nonce = claims.get("nonce").and_then(Value::as_str).unwrap_or("");
    if expect.nonce.is_empty() || !constant_time_eq(nonce.as_bytes(), expect.nonce.as_bytes()) {
        return Err(TokenError::Nonce);
    }
    let sub = claims.get("sub").and_then(Value::as_str).unwrap_or("");
    if !valid_subject(sub) {
        return Err(TokenError::Subject);
    }
    Ok(())
}

/// `sub` is present, printable ASCII without spaces, at most 255 bytes.
pub(crate) fn valid_subject(sub: &str) -> bool {
    !sub.is_empty() && sub.len() <= 255 && sub.bytes().all(|b| b.is_ascii_graphic())
}

/// A NumericDate: a non-negative integer, or a finite non-negative number (rounded down).
fn number(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    value.as_u64().or_else(|| {
        value
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0 && *f < u64::MAX as f64)
            .map(|f| f as u64)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{EncodingKey, Header, encode};
    use serde_json::json;

    struct Signer {
        der: Vec<u8>,
        jwk: Value,
    }

    fn es256(kid: &str) -> Signer {
        let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
        let point = pair.public_key_raw().to_vec();
        Signer {
            der: pair.serialize_der(),
            jwk: json!({
                "kty": "EC", "crv": "P-256", "kid": kid, "use": "sig", "alg": "ES256",
                "x": URL_SAFE_NO_PAD.encode(&point[1..33]),
                "y": URL_SAFE_NO_PAD.encode(&point[33..65]),
            }),
        }
    }

    fn ed25519(kid: &str) -> Signer {
        let pair = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519).unwrap();
        Signer {
            der: pair.serialize_der(),
            jwk: json!({
                "kty": "OKP", "crv": "Ed25519", "kid": kid,
                "x": URL_SAFE_NO_PAD.encode(pair.public_key_raw()),
            }),
        }
    }

    const NOW: u64 = 1_800_000_000;

    fn claims() -> Value {
        json!({
            "iss": "https://idp.test", "aud": "mc", "sub": "user-1", "nonce": "n-1",
            "iat": NOW, "exp": NOW + 300,
        })
    }

    fn sign(signer: &Signer, alg: Algorithm, kid: &str, claims: &Value) -> String {
        let mut header = Header::new(alg);
        header.kid = Some(kid.into());
        let key = match alg {
            Algorithm::EdDSA => EncodingKey::from_ed_der(&signer.der),
            _ => EncodingKey::from_ec_der(&signer.der),
        };
        encode(&header, claims, &key).unwrap()
    }

    fn expect<'a>() -> Expect<'a> {
        Expect {
            issuer: "https://idp.test",
            client_id: "mc",
            nonce: "n-1",
            algorithms: &SignatureAlgorithm::ALL,
            skew_s: 60,
            now_s: NOW,
        }
    }

    fn keys(signers: &[&Signer]) -> Keys {
        Keys::from_jwks(
            &json!({ "keys": signers.iter().map(|s| s.jwk.clone()).collect::<Vec<_>>() }),
        )
        .unwrap()
    }

    fn with(mut base: Value, key: &str, value: Value) -> Value {
        base[key] = value;
        base
    }

    #[test]
    fn a_valid_token_passes_on_ecdsa_and_eddsa() {
        let ec = es256("k1");
        let ed = ed25519("k2");
        let keys = keys(&[&ec, &ed]);
        assert_eq!(keys.len(), 2);
        let token = sign(&ec, Algorithm::ES256, "k1", &claims());
        assert_eq!(validate(&token, &keys, &expect()).unwrap()["sub"], "user-1");
        let token = sign(&ed, Algorithm::EdDSA, "k2", &claims());
        assert!(validate(&token, &keys, &expect()).is_ok());
    }

    #[test]
    fn each_claim_is_checked() {
        let ec = es256("k1");
        let keys = keys(&[&ec]);
        let cases = [
            (
                with(claims(), "iss", json!("https://other.test")),
                TokenError::Issuer,
            ),
            (with(claims(), "aud", json!("other")), TokenError::Audience),
            (
                with(claims(), "aud", json!(["mc", "other"])),
                TokenError::Azp,
            ),
            (with(claims(), "exp", json!(NOW - 60)), TokenError::Expired),
            (
                with(claims(), "iat", json!(NOW + 61)),
                TokenError::IssuedInFuture,
            ),
            (
                with(claims(), "nbf", json!(NOW + 61)),
                TokenError::NotYetValid,
            ),
            (with(claims(), "nonce", json!("n-2")), TokenError::Nonce),
            (with(claims(), "sub", json!("a b")), TokenError::Subject),
            (
                with(claims(), "sub", json!("x".repeat(256))),
                TokenError::Subject,
            ),
        ];
        for (claims, want) in cases {
            let token = sign(&ec, Algorithm::ES256, "k1", &claims);
            assert_eq!(
                validate(&token, &keys, &expect()).err(),
                Some(want),
                "{claims}"
            );
        }
        // At the edge of the skew: accepted.
        let edge = with(
            with(claims(), "exp", json!(NOW - 59)),
            "nbf",
            json!(NOW + 60),
        );
        let edge = with(edge, "iat", json!(NOW + 60));
        let token = sign(&ec, Algorithm::ES256, "k1", &edge);
        assert!(validate(&token, &keys, &expect()).is_ok());
        let azp = with(
            with(claims(), "aud", json!(["mc", "other"])),
            "azp",
            json!("mc"),
        );
        let token = sign(&ec, Algorithm::ES256, "k1", &azp);
        assert!(validate(&token, &keys, &expect()).is_ok());
    }

    #[test]
    fn headers_none_hmac_unknown_keys_and_signatures_are_refused() {
        let ec = es256("k1");
        let other = es256("k1");
        let keys = keys(&[&ec]);
        let body = URL_SAFE_NO_PAD.encode(claims().to_string());
        let none = format!(
            "{}.{body}.",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"none","kid":"k1"}"#)
        );
        assert_eq!(
            validate(&none, &keys, &expect()).err(),
            Some(TokenError::Malformed)
        );
        let none = format!(
            "{}.{body}.c2ln",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"none","kid":"k1"}"#)
        );
        assert_eq!(
            validate(&none, &keys, &expect()).err(),
            Some(TokenError::Algorithm)
        );
        let mut hs = Header::new(Algorithm::HS256);
        hs.kid = Some("k1".into());
        let hs = encode(
            &hs,
            &claims(),
            &EncodingKey::from_secret(b"secret").unwrap(),
        )
        .unwrap();
        assert_eq!(
            validate(&hs, &keys, &expect()).err(),
            Some(TokenError::Algorithm)
        );
        let unknown = sign(&ec, Algorithm::ES256, "k9", &claims());
        assert_eq!(
            validate(&unknown, &keys, &expect()).err(),
            Some(TokenError::UnknownKey)
        );
        let forged = sign(&other, Algorithm::ES256, "k1", &claims());
        assert_eq!(
            validate(&forged, &keys, &expect()).err(),
            Some(TokenError::Signature)
        );
        // A token signed with an allowed algorithm the key does not fit.
        let ed = ed25519("k1");
        let wrong = sign(&ed, Algorithm::EdDSA, "k1", &claims());
        assert_eq!(
            validate(&wrong, &keys, &expect()).err(),
            Some(TokenError::KeyMismatch)
        );
        // Allowlist narrower than the token's algorithm.
        let token = sign(&ec, Algorithm::ES256, "k1", &claims());
        let only_rsa = [SignatureAlgorithm::Rs256];
        let narrow = Expect {
            algorithms: &only_rsa,
            ..expect()
        };
        assert_eq!(
            validate(&token, &keys, &narrow).err(),
            Some(TokenError::Algorithm)
        );
        let crit = format!(
            "{}.{body}.c2ln",
            URL_SAFE_NO_PAD.encode(r#"{"alg":"ES256","kid":"k1","crit":["x"]}"#)
        );
        assert_eq!(
            validate(&crit, &keys, &expect()).err(),
            Some(TokenError::Crit)
        );
        assert_eq!(
            validate("a.b.c.d.e", &keys, &expect()).err(),
            Some(TokenError::Jwe)
        );
    }

    #[test]
    fn jwks_skips_symmetric_encryption_and_mismatched_keys() {
        let ec = es256("k1");
        let jwks = json!({ "keys": [
            ec.jwk,
            { "kty": "oct", "kid": "h", "k": "c2VjcmV0" },
            { "kty": "RSA", "kid": "enc", "use": "enc", "n": "AQAB", "e": "AQAB" },
            { "kty": "EC", "crv": "P-256", "kid": "bad-alg", "alg": "ES384", "x": "AA", "y": "AA" },
            { "kty": "EC", "crv": "P-521", "kid": "p521", "x": "AA", "y": "AA" },
            { "kty": "RSA", "n": "AQAB", "e": "AQAB" },
        ]});
        let keys = Keys::from_jwks(&jwks).unwrap();
        assert_eq!(keys.len(), 1);
        assert!(keys.has("k1"));
        assert_eq!(keys.skipped, 5);
        assert!(Keys::from_jwks(&json!({})).is_err());
        for name in ["none", "HS256", "HS384", "HS512", "ES512", "rs256"] {
            assert_eq!(SignatureAlgorithm::parse(name), None, "{name}");
        }
    }
}
