//! Passwords (DOC-25 §3.2.6): the policy, and Argon2id hashing with at most four hashes at once.
//!
//! No primitive is ours: Argon2id is RustCrypto's `argon2`, the salt comes from the OS random
//! generator through it, and the comparison is the crate's own constant-time one.

use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use argon2::password_hash::{PasswordHasher as _, PasswordVerifier as _};
use argon2::{Algorithm, Argon2, Params, Version};
use tokio::sync::Semaphore;
use zeroize::Zeroizing;

/// Shortest password, in characters.
pub const MIN_PASSWORD_CHARS: usize = 12;
/// Longest password, in characters.
pub const MAX_PASSWORD_CHARS: usize = 256;
/// Hashes computed at once; the rest wait.
pub const MAX_PARALLEL_HASHES: usize = 4;

/// Argon2id memory in KiB (19 MiB), passes and lanes: the OWASP minimum, DOC-25 §3.2.6.
pub const ARGON2_MEMORY_KIB: u32 = 19 * 1024;
pub const ARGON2_PASSES: u32 = 2;
pub const ARGON2_LANES: u32 = 1;

/// Why a new password is refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordRejection {
    /// Fewer than [`MIN_PASSWORD_CHARS`] characters.
    TooShort,
    /// More than [`MAX_PASSWORD_CHARS`] characters.
    TooLong,
    /// Contains the user name.
    ContainsUsername,
    /// One of the 10,000 most common passwords.
    Common,
}

impl PasswordRejection {
    /// The code the sign-in routes answer with.
    pub fn as_str(self) -> &'static str {
        match self {
            PasswordRejection::TooShort => "too_short",
            PasswordRejection::TooLong => "too_long",
            PasswordRejection::ContainsUsername => "contains_username",
            PasswordRejection::Common => "common",
        }
    }
}

impl fmt::Display for PasswordRejection {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            PasswordRejection::TooShort => "the password must have at least 12 characters",
            PasswordRejection::TooLong => "the password must have at most 256 characters",
            PasswordRejection::ContainsUsername => "the password must not contain the user name",
            PasswordRejection::Common => "the password is one of the most common passwords",
        })
    }
}

/// The bundled list of the 10,000 most common passwords (NIST SP 800-63B), lower case. Compiled
/// in: there is no network.
const COMMON: &str = include_str!("common-passwords.txt");

fn common_passwords() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| {
        COMMON
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect()
    })
}

#[cfg(test)]
pub(crate) fn common_count() -> usize {
    common_passwords().len()
}

/// Checks a new password against the policy: 12 to 256 characters, not containing the user name
/// (compared without regard to case), not in the bundled common list (same).
pub fn check_policy(username: &str, password: &str) -> Result<(), PasswordRejection> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_CHARS {
        return Err(PasswordRejection::TooShort);
    }
    if chars > MAX_PASSWORD_CHARS {
        return Err(PasswordRejection::TooLong);
    }
    let lower = Zeroizing::new(password.to_lowercase());
    if !username.is_empty() && lower.contains(&username.to_lowercase()) {
        return Err(PasswordRejection::ContainsUsername);
    }
    if common_passwords().contains(lower.as_str()) {
        return Err(PasswordRejection::Common);
    }
    Ok(())
}

/// Hashing could not run (the OS random generator failed, or the parameters are invalid).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HashError;

impl fmt::Display for HashError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the password could not be hashed")
    }
}

impl std::error::Error for HashError {}

struct Inner {
    argon: Argon2<'static>,
    permits: Arc<Semaphore>,
    /// A real hash of a random password: an unknown user costs what a known one does.
    dummy: String,
    running: AtomicUsize,
    peak: AtomicUsize,
    computed: AtomicUsize,
}

/// Argon2id hashing off the async threads, at most [`MAX_PARALLEL_HASHES`] at once.
#[derive(Clone)]
pub struct PasswordHasher {
    inner: Arc<Inner>,
}

impl fmt::Debug for PasswordHasher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PasswordHasher").finish_non_exhaustive()
    }
}

impl Default for PasswordHasher {
    fn default() -> Self {
        PasswordHasher::new()
    }
}

impl PasswordHasher {
    /// The spec's parameters: Argon2id, m = 19 MiB, t = 2, p = 1, a random 16-byte salt.
    pub fn new() -> PasswordHasher {
        PasswordHasher::with_params(
            ARGON2_MEMORY_KIB,
            ARGON2_PASSES,
            ARGON2_LANES,
            MAX_PARALLEL_HASHES,
        )
        .expect("the spec's Argon2id parameters are valid")
    }

    /// Other parameters, for tests that must not spend 19 MiB per hash.
    pub fn with_params(
        memory_kib: u32,
        passes: u32,
        lanes: u32,
        parallel: usize,
    ) -> Result<PasswordHasher, HashError> {
        let params = Params::new(memory_kib, passes, lanes, None).map_err(|_| HashError)?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut random = Zeroizing::new([0u8; 32]);
        getrandom::fill(&mut *random).map_err(|_| HashError)?;
        let dummy = argon
            .hash_password(&*random)
            .map_err(|_| HashError)?
            .to_string();
        Ok(PasswordHasher {
            inner: Arc::new(Inner {
                argon,
                permits: Arc::new(Semaphore::new(parallel.max(1))),
                dummy,
                running: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                computed: AtomicUsize::new(0),
            }),
        })
    }

    /// The PHC string of `password` with a new random salt.
    pub async fn hash(&self, password: Zeroizing<String>) -> Result<String, HashError> {
        self.run(move |inner| {
            inner
                .argon
                .hash_password(password.as_bytes())
                .map(|h| h.to_string())
                .map_err(|_| HashError)
        })
        .await?
    }

    /// Whether `password` matches the PHC string `hash`. `None`, or a string that is not a hash,
    /// is checked against a dummy hash instead, so the answer costs the same and is `false`.
    pub async fn verify(&self, password: Zeroizing<String>, hash: Option<String>) -> bool {
        let result = self
            .run(move |inner| {
                let (known, hash) = match hash.as_deref() {
                    Some(hash) if hash.starts_with("$argon2id$") => (true, hash),
                    _ => (false, inner.dummy.as_str()),
                };
                let matches = inner
                    .argon
                    .verify_password(password.as_bytes(), hash)
                    .is_ok();
                known && matches
            })
            .await;
        result.unwrap_or(false)
    }

    async fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce(&Inner) -> T + Send + 'static,
    ) -> Result<T, HashError> {
        let permit = Arc::clone(&self.inner.permits)
            .acquire_owned()
            .await
            .map_err(|_| HashError)?;
        let inner = Arc::clone(&self.inner);
        tokio::task::spawn_blocking(move || {
            let now = inner.running.fetch_add(1, Ordering::SeqCst) + 1;
            inner.peak.fetch_max(now, Ordering::SeqCst);
            let out = work(&inner);
            inner.computed.fetch_add(1, Ordering::SeqCst);
            inner.running.fetch_sub(1, Ordering::SeqCst);
            drop(permit);
            out
        })
        .await
        .map_err(|_| HashError)
    }

    /// The most hashes that ran at once so far.
    #[cfg(test)]
    pub(crate) fn peak(&self) -> usize {
        self.inner.peak.load(Ordering::SeqCst)
    }

    /// Hashes computed so far (hashing and verifying, dummy ones included): tests use it to
    /// check that every way of failing costs one hash.
    pub fn computed(&self) -> usize {
        self.inner.computed.load(Ordering::SeqCst)
    }
}
