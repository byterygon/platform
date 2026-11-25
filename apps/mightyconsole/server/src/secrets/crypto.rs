//! The envelope (DOC-25 §3.4.3): every version of every secret has its own 256-bit data key
//! (DEK); the value is encrypted once under it with AES-256-GCM and a random 96-bit nonce, and
//! the DEK is wrapped under the key-encryption key (KEK) with AES-256-GCM and another random
//! nonce. RustCrypto's `aes-gcm` does the cipher and `getrandom` (the OS generator) the keys
//! and nonces: nothing here is a primitive, only how they are put together.
//!
//! **Associated data**, the same for the value and the wrap, binds an entry to where it
//! belongs: the length-prefixed (u32, big-endian) bytes of `"mightyconsole.secret.v1"`, the
//! tenant, the owner kind, the owner id and the field path, then the version as a big-endian
//! u64; the wrap adds the length-prefixed KEK id. An entry copied to another owner, field or
//! version, or a DEK moved to another entry, does not decrypt.
//!
//! A key's id is the first 8 bytes, in hex, of SHA-256(`"mightyconsole.kek.id.v1"` ‖ KEK): the
//! same key always has the same id, and a wrong key is named.

use aes_gcm::aead::{Aead as _, KeyInit as _, Payload};
use aes_gcm::{Aes256Gcm, Key};

type Nonce = aes_gcm::aead::Nonce<Aes256Gcm>;
use sha2::{Digest as _, Sha256};
use zeroize::Zeroizing;

use super::Secret;

/// Bytes in a KEK or a DEK.
pub const KEY_LEN: usize = 32;
/// Bytes in a nonce.
pub const NONCE_LEN: usize = 12;

const AAD_LABEL: &[u8] = b"mightyconsole.secret.v1";
const KEK_ID_LABEL: &[u8] = b"mightyconsole.kek.id.v1";
const CHECK_LABEL: &[u8] = b"mightyconsole.kek.check.v1";

/// What went wrong. Never carries a value or a key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoError {
    /// The OS generator failed.
    Random,
    /// Authentication failed: another key, another binding, or changed bytes.
    Decrypt,
    /// The cipher refused the input (never for the sizes the store allows).
    Encrypt,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            CryptoError::Random => "the operating system's random generator failed",
            CryptoError::Decrypt => {
                "the entry does not decrypt (another key, another owner or field, or changed bytes)"
            }
            CryptoError::Encrypt => "the value could not be encrypted",
        })
    }
}

impl std::error::Error for CryptoError {}

/// A key-encryption key: 256 bits, zeroized on drop, with its id. No `Debug`, `Display` or
/// `Clone`, so it is not printed or copied by accident.
pub struct Kek {
    key: Zeroizing<[u8; KEY_LEN]>,
    id: String,
}

impl Kek {
    pub fn from_bytes(key: Zeroizing<[u8; KEY_LEN]>) -> Kek {
        let id = kek_id(&key);
        Kek { key, id }
    }

    /// A new random key.
    pub fn generate() -> Result<Kek, CryptoError> {
        let mut key = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(&mut *key).map_err(|_| CryptoError::Random)?;
        Ok(Kek::from_bytes(key))
    }

    /// The id (16 hex characters).
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The key itself, for writing a generated key file and deriving the checkpoint key.
    pub fn expose(&self) -> &[u8; KEY_LEN] {
        &self.key
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new(&Key::<Aes256Gcm>::from(*self.key))
    }
}

/// The id of a key: hex of the first 8 bytes of SHA-256(`"mightyconsole.kek.id.v1"` ‖ key).
pub fn kek_id(key: &[u8; KEY_LEN]) -> String {
    let mut hash = Sha256::new();
    hash.update(KEK_ID_LABEL);
    hash.update(key);
    let digest = hash.finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Where an entry belongs: what the associated data binds it to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Binding<'a> {
    pub tenant: &'a str,
    /// `profile`, `route` or `account`.
    pub owner_kind: &'a str,
    pub owner_id: &'a str,
    /// The field path, as `tls.clientKeyPem`.
    pub field: &'a str,
    pub version: u64,
}

fn push_part(out: &mut Vec<u8>, part: &[u8]) {
    let len = u32::try_from(part.len()).expect("associated data parts are small");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(part);
}

/// The associated data of a value (`kek_id` `None`) or of its wrapped DEK.
fn aad(binding: &Binding<'_>, kek_id: Option<&str>) -> Vec<u8> {
    let mut out = Vec::with_capacity(96);
    push_part(&mut out, AAD_LABEL);
    push_part(&mut out, binding.tenant.as_bytes());
    push_part(&mut out, binding.owner_kind.as_bytes());
    push_part(&mut out, binding.owner_id.as_bytes());
    push_part(&mut out, binding.field.as_bytes());
    out.extend_from_slice(&binding.version.to_be_bytes());
    if let Some(id) = kek_id {
        push_part(&mut out, id.as_bytes());
    }
    out
}

/// An encrypted value with its wrapped DEK.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sealed {
    pub kek_id: String,
    pub wrap_nonce: [u8; NONCE_LEN],
    /// The DEK under the KEK, with its tag (48 bytes).
    pub wrapped_dek: Vec<u8>,
    pub nonce: [u8; NONCE_LEN],
    /// The value under the DEK, with its tag.
    pub ciphertext: Vec<u8>,
}

fn random_nonce() -> Result<[u8; NONCE_LEN], CryptoError> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|_| CryptoError::Random)?;
    Ok(nonce)
}

fn wrap(
    kek: &Kek,
    binding: &Binding<'_>,
    dek: &[u8; KEY_LEN],
) -> Result<([u8; NONCE_LEN], Vec<u8>), CryptoError> {
    let wrap_nonce = random_nonce()?;
    let aad = aad(binding, Some(kek.id()));
    let wrapped = kek
        .cipher()
        .encrypt(
            &Nonce::from(wrap_nonce),
            Payload {
                msg: dek,
                aad: &aad,
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    Ok((wrap_nonce, wrapped))
}

fn unwrap(
    kek: &Kek,
    binding: &Binding<'_>,
    sealed: &Sealed,
) -> Result<Zeroizing<[u8; KEY_LEN]>, CryptoError> {
    let aad = aad(binding, Some(&sealed.kek_id));
    let plain = Zeroizing::new(
        kek.cipher()
            .decrypt(
                &Nonce::from(sealed.wrap_nonce),
                Payload {
                    msg: &sealed.wrapped_dek,
                    aad: &aad,
                },
            )
            .map_err(|_| CryptoError::Decrypt)?,
    );
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    if plain.len() != KEY_LEN {
        return Err(CryptoError::Decrypt);
    }
    dek.copy_from_slice(&plain);
    Ok(dek)
}

/// Encrypts `value` under a new DEK, wrapped under `kek`.
pub fn seal(kek: &Kek, binding: &Binding<'_>, value: &[u8]) -> Result<Sealed, CryptoError> {
    let mut dek = Zeroizing::new([0u8; KEY_LEN]);
    getrandom::fill(&mut *dek).map_err(|_| CryptoError::Random)?;
    let nonce = random_nonce()?;
    let aad_value = aad(binding, None);
    let ciphertext = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*dek))
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: value,
                aad: &aad_value,
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    let (wrap_nonce, wrapped_dek) = wrap(kek, binding, &dek)?;
    Ok(Sealed {
        kek_id: kek.id().to_owned(),
        wrap_nonce,
        wrapped_dek,
        nonce,
        ciphertext,
    })
}

/// Decrypts an entry with `kek` (the key named by `sealed.kek_id`).
pub fn open(kek: &Kek, binding: &Binding<'_>, sealed: &Sealed) -> Result<Secret, CryptoError> {
    if kek.id() != sealed.kek_id {
        return Err(CryptoError::Decrypt);
    }
    let dek = unwrap(kek, binding, sealed)?;
    let aad_value = aad(binding, None);
    let plain = Aes256Gcm::new(&Key::<Aes256Gcm>::from(*dek))
        .decrypt(
            &Nonce::from(sealed.nonce),
            Payload {
                msg: &sealed.ciphertext,
                aad: &aad_value,
            },
        )
        .map_err(|_| CryptoError::Decrypt)?;
    Ok(Secret::from_vec(plain))
}

/// The same entry with its DEK wrapped under `new` instead of `old` (rotation, §3.4.5): the
/// value is not re-encrypted.
pub fn rewrap(
    old: &Kek,
    new: &Kek,
    binding: &Binding<'_>,
    sealed: &Sealed,
) -> Result<Sealed, CryptoError> {
    if old.id() != sealed.kek_id {
        return Err(CryptoError::Decrypt);
    }
    let dek = unwrap(old, binding, sealed)?;
    let (wrap_nonce, wrapped_dek) = wrap(new, binding, &dek)?;
    Ok(Sealed {
        kek_id: new.id().to_owned(),
        wrap_nonce,
        wrapped_dek,
        nonce: sealed.nonce,
        ciphertext: sealed.ciphertext.clone(),
    })
}

/// A check value for a passphrase key (§3.4.4): a fixed string encrypted under the KEK, so a
/// wrong passphrase is told from a damaged store. Nonce ‖ ciphertext.
pub fn check_value(kek: &Kek) -> Result<Vec<u8>, CryptoError> {
    let nonce = random_nonce()?;
    let ciphertext = kek
        .cipher()
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: CHECK_LABEL,
                aad: kek.id().as_bytes(),
            },
        )
        .map_err(|_| CryptoError::Encrypt)?;
    let mut out = nonce.to_vec();
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Whether `check` (from [`check_value`]) was made with this key.
pub fn opens_check(kek: &Kek, check: &[u8]) -> bool {
    if check.len() <= NONCE_LEN {
        return false;
    }
    let (nonce, ciphertext) = check.split_at(NONCE_LEN);
    let Ok(nonce) = <[u8; NONCE_LEN]>::try_from(nonce) else {
        return false;
    };
    kek.cipher()
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: ciphertext,
                aad: kek.id().as_bytes(),
            },
        )
        .is_ok_and(|plain| plain == CHECK_LABEL)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(version: u64) -> Binding<'static> {
        Binding {
            tenant: "default",
            owner_kind: "profile",
            owner_id: "p1",
            field: "password",
            version,
        }
    }

    #[test]
    fn a_value_round_trips() {
        let kek = Kek::generate().unwrap();
        let sealed = seal(&kek, &binding(1), b"hunter2-hunter2").unwrap();
        assert_eq!(sealed.kek_id, kek.id());
        assert_ne!(sealed.ciphertext, b"hunter2-hunter2");
        let back = open(&kek, &binding(1), &sealed).unwrap();
        assert_eq!(back.expose(), b"hunter2-hunter2");
    }

    #[test]
    fn each_seal_has_its_own_dek_and_nonces() {
        let kek = Kek::generate().unwrap();
        let a = seal(&kek, &binding(1), b"same").unwrap();
        let b = seal(&kek, &binding(1), b"same").unwrap();
        assert_ne!(a.nonce, b.nonce);
        assert_ne!(a.wrap_nonce, b.wrap_nonce);
        assert_ne!(a.wrapped_dek, b.wrapped_dek);
        assert_ne!(a.ciphertext, b.ciphertext);
    }

    #[test]
    fn changed_bytes_do_not_decrypt() {
        let kek = Kek::generate().unwrap();
        let sealed = seal(&kek, &binding(1), b"value").unwrap();
        for i in 0..sealed.ciphertext.len() {
            let mut bad = sealed.clone();
            bad.ciphertext[i] ^= 1;
            assert_eq!(
                open(&kek, &binding(1), &bad).err(),
                Some(CryptoError::Decrypt)
            );
        }
        let mut bad = sealed.clone();
        bad.wrapped_dek[0] ^= 1;
        assert!(open(&kek, &binding(1), &bad).is_err());
        let mut bad = sealed.clone();
        bad.nonce[0] ^= 1;
        assert!(open(&kek, &binding(1), &bad).is_err());
        let mut bad = sealed;
        bad.wrap_nonce[0] ^= 1;
        assert!(open(&kek, &binding(1), &bad).is_err());
    }

    #[test]
    fn an_entry_moved_elsewhere_does_not_decrypt() {
        let kek = Kek::generate().unwrap();
        let sealed = seal(&kek, &binding(3), b"value").unwrap();
        let elsewhere = [
            Binding {
                tenant: "other",
                ..binding(3)
            },
            Binding {
                owner_kind: "route",
                ..binding(3)
            },
            Binding {
                owner_id: "p2",
                ..binding(3)
            },
            Binding {
                field: "token",
                ..binding(3)
            },
            binding(2),
            binding(4),
        ];
        for other in elsewhere {
            assert!(open(&kek, &other, &sealed).is_err(), "{other:?}");
        }
        // Parts are length-prefixed: moving a character between owner and field changes it.
        let a = Binding {
            owner_id: "ab",
            field: "c",
            ..binding(1)
        };
        let b = Binding {
            owner_id: "a",
            field: "bc",
            ..binding(1)
        };
        let sealed = seal(&kek, &a, b"value").unwrap();
        assert!(open(&kek, &b, &sealed).is_err());
    }

    #[test]
    fn a_dek_moved_to_another_entry_does_not_decrypt() {
        let kek = Kek::generate().unwrap();
        let one = seal(&kek, &binding(1), b"one").unwrap();
        let other = Binding {
            owner_id: "p2",
            ..binding(1)
        };
        let two = seal(&kek, &other, b"two").unwrap();
        let mixed = Sealed {
            wrap_nonce: one.wrap_nonce,
            wrapped_dek: one.wrapped_dek.clone(),
            ..two
        };
        assert!(open(&kek, &other, &mixed).is_err());
    }

    #[test]
    fn a_wrong_key_does_not_decrypt() {
        let kek = Kek::generate().unwrap();
        let other = Kek::generate().unwrap();
        let sealed = seal(&kek, &binding(1), b"value").unwrap();
        assert!(open(&other, &binding(1), &sealed).is_err());
        // Even with the id rewritten to the other key's.
        let relabelled = Sealed {
            kek_id: other.id().to_owned(),
            ..sealed
        };
        assert!(open(&other, &binding(1), &relabelled).is_err());
    }

    #[test]
    fn rewrapping_keeps_the_value_and_moves_the_key() {
        let old = Kek::generate().unwrap();
        let new = Kek::generate().unwrap();
        let sealed = seal(&old, &binding(1), b"value").unwrap();
        let moved = rewrap(&old, &new, &binding(1), &sealed).unwrap();
        assert_eq!(moved.kek_id, new.id());
        assert_eq!(moved.ciphertext, sealed.ciphertext);
        assert_eq!(open(&new, &binding(1), &moved).unwrap().expose(), b"value");
        assert!(open(&old, &binding(1), &moved).is_err());
        assert!(rewrap(&new, &old, &binding(1), &sealed).is_err());
    }

    #[test]
    fn key_ids_are_stable_and_distinct() {
        let key = Zeroizing::new([7u8; KEY_LEN]);
        let id = kek_id(&key);
        assert_eq!(id.len(), 16);
        assert_eq!(id, Kek::from_bytes(Zeroizing::new([7u8; KEY_LEN])).id());
        assert_ne!(id, kek_id(&[8u8; KEY_LEN]));
    }

    #[test]
    fn a_check_value_opens_only_with_its_key() {
        let kek = Kek::generate().unwrap();
        let check = check_value(&kek).unwrap();
        assert!(opens_check(&kek, &check));
        assert!(!opens_check(&Kek::generate().unwrap(), &check));
        assert!(!opens_check(&kek, &check[..5]));
    }
}
