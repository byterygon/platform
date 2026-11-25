//! Where the key-encryption keys come from (DOC-25 §3.4.4): `[[secrets.keys]]` lists one or
//! more keys, the first being the active one. Each has a source:
//!
//! - `file` (the default): 32 bytes in base64 (44 characters, then an optional newline), owned
//!   by the server's user, mode 0400 or 0600 (Unix). With no key configured, the server uses the
//!   key it generated in `DATA/keys/kek-<id>.key`, and generates one when there is none and the
//!   store holds no secret.
//! - `passphrase`: from `passphrase_file`, `$MIGHTYCONSOLE_SECRET_PASSPHRASE`, or a prompt when
//!   stdin is a terminal; at least 16 characters. KEK = Argon2id (m = 64 MiB, t = 3, p = 1) over a
//!   16-byte random salt kept in `DATA/keys/<id>.salt`, with a check value in
//!   `DATA/keys/<id>.check` that tells a wrong passphrase from a damaged store.
//! - `command`: an argument list (no shell) run once with a clean environment (`PATH`, `HOME`,
//!   `LANG`) and a 30 s timeout, whose stdout is the key in base64.
//!
//! **Passphrase keys and their salt.** The configuration does not name a passphrase key's id
//! (the id comes from the key). The server tries the passphrase against every salt in
//! `DATA/keys` that no other configured key has claimed; the one whose check value opens is the
//! key. When none opens and an unclaimed salt is left, the passphrase is wrong ("the passphrase
//! does not open key …"); when no salt is left, the passphrase starts a new key (a first start,
//! or a rotation to a new passphrase), and its salt and check are written. To give up a key
//! whose passphrase is lost, delete its salt and check files (its secrets are lost with it).
//!
//! A key's id is [`super::crypto::kek_id`]. Two configured keys with the same id are refused.

use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use zeroize::Zeroizing;

use super::crypto::{self, KEY_LEN, Kek};

/// The environment variable holding a passphrase key's passphrase.
pub const PASSPHRASE_ENV: &str = "MIGHTYCONSOLE_SECRET_PASSPHRASE";
/// The directory of generated keys, salts and check values, in the data directory.
pub const KEYS_DIR: &str = "keys";
/// The shortest passphrase accepted, in characters.
pub const MIN_PASSPHRASE_CHARS: usize = 16;
/// How long a key command may run.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
/// How much of a failed key command's stderr is shown.
pub const STDERR_SHOWN: usize = 2048;
/// Argon2id's memory cost in KiB (64 MiB), time cost and lanes (§3.4.4).
pub const ARGON2_M_KIB: u32 = 64 * 1024;
pub const ARGON2_T: u32 = 3;
pub const ARGON2_P: u32 = 1;
/// Bytes of a passphrase key's salt.
pub const SALT_LEN: usize = 16;

/// One configured key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeySource {
    /// A key file.
    File(PathBuf),
    /// A passphrase: from this file, else the environment, else a prompt.
    Passphrase { file: Option<PathBuf> },
    /// A command whose stdout is the key: the program, then its arguments.
    Command(Vec<String>),
}

impl KeySource {
    /// `file`, `passphrase` or `command`.
    pub fn kind(&self) -> &'static str {
        match self {
            KeySource::File(_) => "file",
            KeySource::Passphrase { .. } => "passphrase",
            KeySource::Command(_) => "command",
        }
    }

    fn describe(&self) -> String {
        match self {
            KeySource::File(path) => format!("key file {}", path.display()),
            KeySource::Passphrase { file: Some(path) } => {
                format!("passphrase key (from {})", path.display())
            }
            KeySource::Passphrase { file: None } => "passphrase key".into(),
            KeySource::Command(argv) => format!(
                "key command {:?}",
                argv.first().map(String::as_str).unwrap_or("")
            ),
        }
    }
}

/// `[secrets]`: the keys, active first. Empty means the generated key in `DATA/keys`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SecretsSettings {
    pub keys: Vec<KeySource>,
}

/// Why the keys did not load. The message names files, ids and modes, never key material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyError(pub String);

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for KeyError {}

fn key_err(message: impl Into<String>) -> KeyError {
    KeyError(message.into())
}

/// The loaded keys: the first is the active one.
pub struct Keyring {
    keys: Vec<Kek>,
    /// Each key's source: `file`, `generated`, `passphrase` or `command`.
    sources: Vec<&'static str>,
}

impl Keyring {
    /// A keyring of these keys (from key files), active first. Refuses none, and two keys with
    /// one id.
    pub fn new(keys: Vec<Kek>) -> Result<Keyring, KeyError> {
        let sources = vec!["file"; keys.len()];
        Keyring::with_sources(keys, sources)
    }

    /// As [`Keyring::new`], with each key's source.
    pub fn with_sources(keys: Vec<Kek>, sources: Vec<&'static str>) -> Result<Keyring, KeyError> {
        assert_eq!(keys.len(), sources.len(), "one source per key");
        if keys.is_empty() {
            return Err(key_err("no key"));
        }
        for (i, key) in keys.iter().enumerate() {
            if keys[..i].iter().any(|k| k.id() == key.id()) {
                return Err(key_err(format!(
                    "[secrets]: key {} is configured twice",
                    key.id()
                )));
            }
        }
        Ok(Keyring { keys, sources })
    }

    /// Each key's source, active first.
    pub fn sources(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.sources.iter().copied()
    }

    pub fn active(&self) -> &Kek {
        &self.keys[0]
    }

    pub fn get(&self, id: &str) -> Option<&Kek> {
        self.keys.iter().find(|k| k.id() == id)
    }

    /// The keys, active first.
    pub fn keks(&self) -> impl Iterator<Item = &Kek> {
        self.keys.iter()
    }

    /// The ids, active first.
    pub fn ids(&self) -> Vec<String> {
        self.keys.iter().map(|k| k.id().to_owned()).collect()
    }
}

/// What loading the keys gives besides the keyring: lines for the operator.
pub struct Loaded {
    pub keyring: Keyring,
    /// Warnings to print (a key generated beside the data, a passphrase key made).
    pub warnings: Vec<String>,
    /// The file of a key generated by this start.
    pub generated: Option<PathBuf>,
}

/// The keys directory of a data directory.
pub fn keys_dir(data: &Path) -> PathBuf {
    data.join(KEYS_DIR)
}

/// A generated key's file name.
pub fn generated_file_name(id: &str) -> String {
    format!("kek-{id}.key")
}

/// Loads every configured key (§3.4.4) and checks that every key the store's entries use is
/// among them (§3.6.2 point 5). `entries_by_key` counts the store's entries per key id.
/// `prompt` allows asking for a passphrase on the terminal.
pub async fn load(
    data: &Path,
    settings: &SecretsSettings,
    entries_by_key: &BTreeMap<String, u64>,
    prompt: bool,
) -> Result<Loaded, KeyError> {
    check_keys_dir(data)?;
    let mut warnings = Vec::new();
    let mut generated = None;
    let keys = if settings.keys.is_empty() {
        let (key, made) = generated_key(data, entries_by_key)?;
        if let Some(path) = made {
            warnings.push(format!(
                "generated the secret key {} in {}: a key beside the data protects copies of \
                 store.redb (backups) but not a compromise of this machine; move it to a \
                 separate mount (a container or Kubernetes secret, a tmpfs, removable media) \
                 and name it in [[secrets.keys]]",
                key.id(),
                path.display()
            ));
            generated = Some(path);
        }
        (vec![key], vec!["generated"])
    } else {
        let keys = load_configured(data, &settings.keys, prompt, true, &mut warnings).await?;
        (keys, settings.keys.iter().map(KeySource::kind).collect())
    };
    let keyring = Keyring::with_sources(keys.0, keys.1)?;
    let missing: Vec<String> = entries_by_key
        .iter()
        .filter(|(id, _)| keyring.get(id).is_none())
        .map(|(id, n)| format!("{n} secret entr{} under key {id}", plural_y(*n)))
        .collect();
    if !missing.is_empty() {
        return Err(key_err(format!(
            "the store has {}, which no configured key opens; add that key to [[secrets.keys]] \
             (keys loaded: {})",
            missing.join(" and "),
            keyring.ids().join(", ")
        )));
    }
    Ok(Loaded {
        keyring,
        warnings,
        generated,
    })
}

fn plural_y(n: u64) -> &'static str {
    if n == 1 { "y" } else { "ies" }
}

/// `DATA/keys`, when it exists, is not group- or world-writable (§3.6.2 point 4).
fn check_keys_dir(data: &Path) -> Result<(), KeyError> {
    let dir = keys_dir(data);
    #[cfg(unix)]
    if let Ok(meta) = fs::metadata(&dir) {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = meta.permissions().mode() & 0o777;
        if mode & 0o022 != 0 {
            return Err(key_err(format!(
                "{} has mode {mode:04o}: it must not be group- or world-writable (chmod 700 it)",
                dir.display()
            )));
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// The generated key: the one `kek-<id>.key` in `DATA/keys`, or a new one when there is none
/// and the store holds no secret.
fn generated_key(
    data: &Path,
    entries_by_key: &BTreeMap<String, u64>,
) -> Result<(Kek, Option<PathBuf>), KeyError> {
    let dir = keys_dir(data);
    let mut files: Vec<PathBuf> = match fs::read_dir(&dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("kek-") && n.ends_with(".key"))
            })
            .collect(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(key_err(format!("{}: {e}", dir.display()))),
    };
    files.sort();
    match files.as_slice() {
        [] => {
            let entries: u64 = entries_by_key.values().sum();
            if entries > 0 {
                return Err(key_err(format!(
                    "no key is configured in [[secrets.keys]] and {} holds no generated key, but \
                     the store has {entries} secret entr{} (under {}): configure the key they \
                     were made with",
                    dir.display(),
                    plural_y(entries),
                    entries_by_key
                        .keys()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                )));
            }
            let kek = Kek::generate().map_err(|e| key_err(e.to_string()))?;
            let path = dir.join(generated_file_name(kek.id()));
            write_key_file(&path, &kek)?;
            Ok((kek, Some(path)))
        }
        [one] => Ok((read_key_file(one)?, None)),
        several => Err(key_err(format!(
            "{} holds {} generated keys ({}): list them in [[secrets.keys]], the active one first",
            dir.display(),
            several.len(),
            several
                .iter()
                .filter_map(|p| p.file_name().and_then(|n| n.to_str()))
                .collect::<Vec<_>>()
                .join(", ")
        ))),
    }
}

/// Makes `dir` (mode 0700) when it is missing.
fn make_private_dir(dir: &Path) -> Result<(), KeyError> {
    if dir.is_dir() {
        return Ok(());
    }
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt as _;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| key_err(format!("{}: {e}", dir.display())))
}

/// Writes `bytes` to a new file (mode 0600), synced, then syncs its directory. Refuses an
/// existing file.
pub fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), KeyError> {
    let fail = |e: io::Error| key_err(format!("{}: {e}", path.display()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(fail)?;
    file.write_all(bytes).map_err(fail)?;
    file.sync_all().map_err(fail)?;
    #[cfg(unix)]
    if let Some(dir) = path.parent()
        && let Ok(dir) = fs::File::open(dir)
    {
        dir.sync_all().map_err(fail)?;
    }
    Ok(())
}

/// The text of a key file: the key in base64 and a newline.
pub fn key_file_text(kek: &Kek) -> Zeroizing<String> {
    let mut text = Zeroizing::new(BASE64.encode(kek.expose()));
    text.push('\n');
    text
}

fn write_key_file(path: &Path, kek: &Kek) -> Result<(), KeyError> {
    if let Some(dir) = path.parent() {
        make_private_dir(dir)?;
    }
    write_private_file(path, key_file_text(kek).as_bytes())
}

/// Owned by the server's user and mode 0400 or 0600 (Unix); for a passphrase file, not group-
/// or world-readable.
fn check_secret_file(path: &Path, what: &str) -> Result<(), KeyError> {
    let meta =
        fs::metadata(path).map_err(|e| key_err(format!("{what} {}: {e}", path.display())))?;
    if !meta.is_file() {
        return Err(key_err(format!("{what} {}: not a file", path.display())));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let mode = meta.permissions().mode() & 0o777;
        if mode != 0o400 && mode != 0o600 {
            return Err(key_err(format!(
                "{what} {} has mode {mode:04o}: it must be 0400 or 0600 (chmod 600 it)",
                path.display()
            )));
        }
        let me = rustix::process::geteuid().as_raw();
        if meta.uid() != me {
            return Err(key_err(format!(
                "{what} {} is owned by uid {}, not by the server's user (uid {me})",
                path.display(),
                meta.uid()
            )));
        }
    }
    Ok(())
}

/// Reads a file of at most `limit` bytes into a zeroizing buffer.
fn read_small(path: &Path, what: &str, limit: u64) -> Result<Zeroizing<Vec<u8>>, KeyError> {
    use std::io::Read as _;
    let fail = |e: io::Error| key_err(format!("{what} {}: {e}", path.display()));
    let file = fs::File::open(path).map_err(fail)?;
    let mut bytes = Zeroizing::new(Vec::new());
    file.take(limit + 1).read_to_end(&mut bytes).map_err(fail)?;
    if bytes.len() as u64 > limit {
        return Err(key_err(format!(
            "{what} {}: longer than {limit} bytes",
            path.display()
        )));
    }
    Ok(bytes)
}

/// The key in base64 (with an optional final newline) as a key.
fn decode_key(text: &[u8]) -> Option<Kek> {
    let text = text
        .strip_suffix(b"\r\n")
        .or_else(|| text.strip_suffix(b"\n"))
        .unwrap_or(text);
    if text.len() != 44 {
        return None;
    }
    let decoded = Zeroizing::new(BASE64.decode(text).ok()?);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    if decoded.len() != KEY_LEN {
        return None;
    }
    key.copy_from_slice(&decoded);
    Some(Kek::from_bytes(key))
}

/// Reads and checks a key file.
pub fn read_key_file(path: &Path) -> Result<Kek, KeyError> {
    check_secret_file(path, "key file")?;
    let text = read_small(path, "key file", 64)?;
    decode_key(&text).ok_or_else(|| {
        key_err(format!(
            "key file {}: not a key (32 bytes in base64, 44 characters, then an optional newline)",
            path.display()
        ))
    })
}

/// The keys that exist, for commands that read the data directory (`audit verify`): the
/// configured keys, or the generated key when none is configured. Generates nothing, makes no
/// passphrase key and asks on no terminal; `None` when no key is configured and none was
/// generated.
pub async fn load_existing(
    data: &Path,
    settings: &SecretsSettings,
) -> Result<Option<Keyring>, KeyError> {
    check_keys_dir(data)?;
    if settings.keys.is_empty() {
        let dir = keys_dir(data);
        let found: Vec<PathBuf> = fs::read_dir(&dir)
            .map(|d| {
                d.filter_map(Result::ok)
                    .map(|e| e.path())
                    .filter(|p| {
                        p.file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.starts_with("kek-") && n.ends_with(".key"))
                    })
                    .collect()
            })
            .unwrap_or_default();
        if found.is_empty() {
            return Ok(None);
        }
        let keys = found
            .iter()
            .map(|p| read_key_file(p))
            .collect::<Result<Vec<_>, _>>()?;
        return Keyring::new(keys).map(Some);
    }
    let mut warnings = Vec::new();
    let keys = load_configured(data, &settings.keys, false, false, &mut warnings).await?;
    Keyring::new(keys).map(Some)
}

/// `keys generate --out FILE`: a new random key in a new file (mode 0600); its id.
pub fn generate_file(out: &Path) -> Result<String, KeyError> {
    let kek = Kek::generate().map_err(|e| key_err(e.to_string()))?;
    write_private_file(out, key_file_text(&kek).as_bytes())?;
    Ok(kek.id().to_owned())
}

async fn load_configured(
    data: &Path,
    sources: &[KeySource],
    prompt: bool,
    create: bool,
    warnings: &mut Vec<String>,
) -> Result<Vec<Kek>, KeyError> {
    // Passphrase keys are matched to their salts after every other key is known, so the salts
    // they claim are known too.
    let mut keys: Vec<Option<Kek>> = Vec::with_capacity(sources.len());
    let mut passphrases = Vec::new();
    for (i, source) in sources.iter().enumerate() {
        match source {
            KeySource::File(path) => keys.push(Some(read_key_file(path)?)),
            KeySource::Command(argv) => keys.push(Some(run_key_command(argv).await?)),
            KeySource::Passphrase { file } => {
                let passphrase = read_passphrase(file.as_deref(), prompt)?;
                passphrases.push((i, passphrase));
                keys.push(None);
            }
        }
    }
    if !passphrases.is_empty() {
        let dir = keys_dir(data);
        let mut salts = salt_ids(&dir)?;
        salts.retain(|id| !keys.iter().flatten().any(|k| k.id() == id));
        let mut unmatched = Vec::new();
        for (i, passphrase) in passphrases {
            match open_existing(&dir, &salts, &passphrase)? {
                Some(kek) => {
                    salts.retain(|id| id != kek.id());
                    keys[i] = Some(kek);
                }
                None => unmatched.push((i, passphrase)),
            }
        }
        if !unmatched.is_empty() && !create {
            return Err(key_err(format!(
                "the passphrase opens no key in {}",
                dir.display()
            )));
        }
        if !unmatched.is_empty() && !salts.is_empty() {
            return Err(key_err(format!(
                "the passphrase does not open key {} ({}): check the passphrase; to give that key \
                 up, delete its .salt and .check files",
                salts.join(", "),
                dir.display()
            )));
        }
        for (i, passphrase) in unmatched {
            let kek = new_passphrase_key(&dir, &passphrase)?;
            warnings.push(format!(
                "made the passphrase key {} (its salt and check value are in {})",
                kek.id(),
                dir.display()
            ));
            keys[i] = Some(kek);
        }
    }
    Ok(keys
        .into_iter()
        .map(|k| k.expect("every key is loaded"))
        .collect())
}

/// The ids of the passphrase salts in `dir`.
fn salt_ids(dir: &Path) -> Result<Vec<String>, KeyError> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(key_err(format!("{}: {e}", dir.display()))),
    };
    let mut ids: Vec<String> = entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            e.file_name()
                .to_str()
                .and_then(|n| n.strip_suffix(".salt"))
                .map(str::to_owned)
        })
        .collect();
    ids.sort();
    Ok(ids)
}

fn derive(passphrase: &str, salt: &[u8]) -> Result<Kek, KeyError> {
    let params = argon2::Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(KEY_LEN))
        .map_err(|e| key_err(format!("Argon2 parameters: {e}")))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut *key)
        .map_err(|e| key_err(format!("Argon2: {e}")))?;
    Ok(Kek::from_bytes(key))
}

/// The key of the first salt whose check value this passphrase opens.
fn open_existing(dir: &Path, salts: &[String], passphrase: &str) -> Result<Option<Kek>, KeyError> {
    for id in salts {
        let salt_path = dir.join(format!("{id}.salt"));
        let check_path = dir.join(format!("{id}.check"));
        let salt = read_small(&salt_path, "salt", 64)?;
        let check = match fs::read(&check_path) {
            Ok(check) => check,
            Err(e) => {
                return Err(key_err(format!(
                    "passphrase key {id}: its check value {}: {e} (the keys directory is damaged)",
                    check_path.display()
                )));
            }
        };
        let kek = derive(passphrase, &salt)?;
        if crypto::opens_check(&kek, &check) {
            if kek.id() != id {
                return Err(key_err(format!(
                    "passphrase key {id}: its salt and check value give key {}, not {id} (the \
                     keys directory is damaged)",
                    kek.id()
                )));
            }
            return Ok(Some(kek));
        }
    }
    Ok(None)
}

fn new_passphrase_key(dir: &Path, passphrase: &str) -> Result<Kek, KeyError> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::fill(&mut salt).map_err(|_| key_err("the random generator failed"))?;
    let kek = derive(passphrase, &salt)?;
    let check = crypto::check_value(&kek).map_err(|e| key_err(e.to_string()))?;
    make_private_dir(dir)?;
    write_private_file(&dir.join(format!("{}.check", kek.id())), &check)?;
    write_private_file(&dir.join(format!("{}.salt", kek.id())), &salt)?;
    Ok(kek)
}

/// The passphrase: from the file, else the environment, else the terminal.
fn read_passphrase(file: Option<&Path>, prompt: bool) -> Result<Zeroizing<String>, KeyError> {
    let passphrase = if let Some(path) = file {
        check_secret_file(path, "passphrase file")?;
        let bytes = read_small(path, "passphrase file", 4096)?;
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| key_err(format!("passphrase file {}: not UTF-8", path.display())))?;
        let text = text
            .strip_suffix("\r\n")
            .or_else(|| text.strip_suffix('\n'))
            .unwrap_or(text);
        Zeroizing::new(text.to_owned())
    } else if let Some(value) = std::env::var_os(PASSPHRASE_ENV) {
        Zeroizing::new(
            value
                .into_string()
                .map_err(|_| key_err(format!("${PASSPHRASE_ENV} is not UTF-8")))?,
        )
    } else if prompt {
        prompt_hidden("Passphrase of the secret store: ")
            .map_err(|e| key_err(format!("reading the passphrase: {e}")))?
    } else {
        return Err(key_err(format!(
            "a passphrase key needs passphrase_file, ${PASSPHRASE_ENV}, or a terminal to ask on"
        )));
    };
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(key_err(format!(
            "the passphrase is shorter than {MIN_PASSPHRASE_CHARS} characters"
        )));
    }
    Ok(passphrase)
}

/// Asks on stderr and reads a line from stdin with the terminal's echo off.
#[cfg(unix)]
fn prompt_hidden(prompt: &str) -> io::Result<Zeroizing<String>> {
    use rustix::termios::{LocalModes, OptionalActions, tcgetattr, tcsetattr};
    let stdin = io::stdin();
    let before = tcgetattr(&stdin)?;
    let mut quiet = before.clone();
    quiet.local_modes.remove(LocalModes::ECHO);
    eprint!("{prompt}");
    tcsetattr(&stdin, OptionalActions::Now, &quiet)?;
    let mut line = Zeroizing::new(String::new());
    let read = stdin.read_line(&mut line);
    let restored = tcsetattr(&stdin, OptionalActions::Now, &before);
    eprintln!();
    read?;
    restored?;
    let trimmed = line.trim_end_matches(['\r', '\n']).len();
    line.truncate(trimmed);
    Ok(line)
}

#[cfg(not(unix))]
fn prompt_hidden(_prompt: &str) -> io::Result<Zeroizing<String>> {
    Err(io::Error::other(
        "no hidden prompt on this system: give passphrase_file or the environment variable",
    ))
}

/// Clips `bytes` to [`STDERR_SHOWN`] and makes it printable.
fn clip_stderr(bytes: &[u8]) -> String {
    let shown = &bytes[..bytes.len().min(STDERR_SHOWN)];
    let mut text = String::from_utf8_lossy(shown).trim().to_owned();
    if bytes.len() > STDERR_SHOWN {
        text.push_str(" …");
    }
    text
}

/// Runs a key command: no shell, a clean environment, 30 s. Its stdout (the key) is never
/// shown, whatever it holds.
async fn run_key_command(argv: &[String]) -> Result<Kek, KeyError> {
    let Some((program, args)) = argv.split_first() else {
        return Err(key_err(
            "[secrets.keys]: a command key needs `command = [program, args…]`",
        ));
    };
    let mut command = tokio::process::Command::new(program);
    command
        .args(args)
        .env_clear()
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for name in ["PATH", "HOME", "LANG"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let child = command
        .spawn()
        .map_err(|e| key_err(format!("key command {program:?}: {e}")))?;
    let output = match tokio::time::timeout(COMMAND_TIMEOUT, child.wait_with_output()).await {
        Err(_) => {
            return Err(key_err(format!(
                "key command {program:?} did not finish within {} s",
                COMMAND_TIMEOUT.as_secs()
            )));
        }
        Ok(Err(e)) => return Err(key_err(format!("key command {program:?}: {e}"))),
        Ok(Ok(output)) => output,
    };
    let stdout = Zeroizing::new(output.stdout);
    if !output.status.success() {
        return Err(key_err(format!(
            "key command {program:?} failed ({}){}",
            output.status,
            match clip_stderr(&output.stderr) {
                text if text.is_empty() => String::new(),
                text => format!(": {text}"),
            }
        )));
    }
    let trimmed = stdout.trim_ascii();
    decode_key(trimmed).ok_or_else(|| {
        key_err(format!(
            "key command {program:?}: its output is not a key (32 bytes in base64)"
        ))
    })
}

/// What `config check` can say about the keys without running a command or asking for a
/// passphrase: each file key's id, and whether a passphrase is available.
pub fn check(data: Option<&Path>, settings: &SecretsSettings) -> (Vec<String>, Vec<String>) {
    let (mut report, mut problems) = (Vec::new(), Vec::new());
    if let Some(data) = data
        && let Err(e) = check_keys_dir(data)
    {
        problems.push(e.0);
    }
    if settings.keys.is_empty() {
        report.push(match data {
            Some(data) => format!(
                "secret keys: the generated key in {} (made at the first start)",
                keys_dir(data).display()
            ),
            None => "secret keys: the generated key in DATA/keys".into(),
        });
        return (report, problems);
    }
    for (i, source) in settings.keys.iter().enumerate() {
        let role = if i == 0 { "active" } else { "older" };
        match source {
            KeySource::File(path) => match read_key_file(path) {
                Ok(kek) => report.push(format!(
                    "secret key {} ({role}): {}",
                    kek.id(),
                    source.describe()
                )),
                Err(e) => problems.push(e.0),
            },
            KeySource::Passphrase { file: Some(path) } => {
                match read_passphrase(Some(path), false) {
                    Ok(_) => report.push(format!("secret key ({role}): {}", source.describe())),
                    Err(e) => problems.push(e.0),
                }
            }
            KeySource::Passphrase { file: None } => report.push(format!(
                "secret key ({role}): passphrase key from ${PASSPHRASE_ENV} or the terminal \
                 (not checked)"
            )),
            KeySource::Command(_) => report.push(format!(
                "secret key ({role}): {} (not run by config check)",
                source.describe()
            )),
        }
    }
    (report, problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_mode(path: &Path, text: &str, mode: u32) {
        fs::write(path, text).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
        }
        #[cfg(not(unix))]
        let _ = mode;
    }

    fn none() -> BTreeMap<String, u64> {
        BTreeMap::new()
    }

    #[tokio::test]
    async fn a_first_start_generates_a_key_and_the_next_reuses_it() {
        let data = tempfile::tempdir().unwrap();
        let first = load(data.path(), &SecretsSettings::default(), &none(), false)
            .await
            .unwrap();
        let path = first.generated.clone().expect("a generated key");
        assert_eq!(
            path,
            keys_dir(data.path()).join(generated_file_name(first.keyring.active().id()))
        );
        assert_eq!(first.warnings.len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            let dir = fs::metadata(keys_dir(data.path())).unwrap();
            assert_eq!(dir.permissions().mode() & 0o777, 0o700);
        }
        let text = fs::read_to_string(&path).unwrap();
        assert_eq!(text.len(), 45);
        let again = load(data.path(), &SecretsSettings::default(), &none(), false)
            .await
            .unwrap();
        assert!(again.generated.is_none());
        assert_eq!(again.keyring.active().id(), first.keyring.active().id());
    }

    #[tokio::test]
    async fn no_key_with_entries_in_the_store_refuses_the_start() {
        let data = tempfile::tempdir().unwrap();
        let entries = BTreeMap::from([("0123456789abcdef".to_owned(), 2)]);
        let e = load(data.path(), &SecretsSettings::default(), &entries, false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("2 secret entries"), "{e}");
        assert!(e.0.contains("0123456789abcdef"), "{e}");
        assert!(!keys_dir(data.path()).exists());
    }

    #[tokio::test]
    async fn an_entry_under_a_key_not_loaded_refuses_the_start() {
        let data = tempfile::tempdir().unwrap();
        let first = load(data.path(), &SecretsSettings::default(), &none(), false)
            .await
            .unwrap();
        let entries = BTreeMap::from([
            (first.keyring.active().id().to_owned(), 5),
            ("feedfacefeedface".to_owned(), 1),
        ]);
        let e = load(data.path(), &SecretsSettings::default(), &entries, false)
            .await
            .err()
            .unwrap();
        assert!(
            e.0.contains("1 secret entry under key feedfacefeedface"),
            "{e}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_key_file_with_a_loose_mode_refuses_the_start() {
        let data = tempfile::tempdir().unwrap();
        let kek = Kek::generate().unwrap();
        let path = data.path().join("kek.key");
        write_mode(&path, &key_file_text(&kek), 0o644);
        let settings = SecretsSettings {
            keys: vec![KeySource::File(path.clone())],
        };
        let e = load(data.path(), &settings, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("mode 0644"), "{e}");
        assert!(e.0.contains(&path.display().to_string()), "{e}");
        for mode in [0o600, 0o400] {
            write_mode(&path, &key_file_text(&kek), 0o600);
            write_mode(&path, &key_file_text(&kek), mode);
            let loaded = load(data.path(), &settings, &none(), false).await.unwrap();
            assert_eq!(loaded.keyring.active().id(), kek.id());
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt as _;
                fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            }
        }
    }

    #[tokio::test]
    async fn a_missing_or_malformed_key_file_refuses_the_start() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("absent.key");
        let settings = SecretsSettings {
            keys: vec![KeySource::File(path.clone())],
        };
        let e = load(data.path(), &settings, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("absent.key"), "{e}");
        write_mode(&path, "not a key\n", 0o600);
        let e = load(data.path(), &settings, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("not a key"), "{e}");
    }

    #[tokio::test]
    async fn the_first_configured_key_is_active_and_a_key_twice_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let (a, b) = (Kek::generate().unwrap(), Kek::generate().unwrap());
        let (pa, pb) = (data.path().join("a.key"), data.path().join("b.key"));
        write_mode(&pa, &key_file_text(&a), 0o600);
        write_mode(&pb, &key_file_text(&b), 0o600);
        let settings = SecretsSettings {
            keys: vec![KeySource::File(pb.clone()), KeySource::File(pa.clone())],
        };
        let loaded = load(data.path(), &settings, &none(), false).await.unwrap();
        assert_eq!(loaded.keyring.active().id(), b.id());
        assert!(loaded.keyring.get(a.id()).is_some());
        let twice = SecretsSettings {
            keys: vec![KeySource::File(pa.clone()), KeySource::File(pa)],
        };
        let e = load(data.path(), &twice, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("configured twice"), "{e}");
    }

    fn passphrase_file(dir: &Path, name: &str, text: &str) -> PathBuf {
        let path = dir.join(name);
        write_mode(&path, text, 0o600);
        path
    }

    #[tokio::test]
    async fn a_passphrase_key_is_made_once_then_opened_and_a_wrong_one_is_named() {
        let data = tempfile::tempdir().unwrap();
        let file = passphrase_file(data.path(), "pass", "correct horse battery staple\n");
        let settings = SecretsSettings {
            keys: vec![KeySource::Passphrase {
                file: Some(file.clone()),
            }],
        };
        let made = load(data.path(), &settings, &none(), false).await.unwrap();
        let id = made.keyring.active().id().to_owned();
        assert!(keys_dir(data.path()).join(format!("{id}.salt")).is_file());
        assert!(keys_dir(data.path()).join(format!("{id}.check")).is_file());
        assert_eq!(made.warnings.len(), 1);
        let again = load(data.path(), &settings, &none(), false).await.unwrap();
        assert_eq!(again.keyring.active().id(), id);
        assert!(again.warnings.is_empty());

        write_mode(&file, "a different passphrase entirely", 0o600);
        let e = load(data.path(), &settings, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains(&format!("does not open key {id}")), "{e}");
    }

    #[tokio::test]
    async fn rotating_to_a_new_passphrase_keeps_the_old_key() {
        let data = tempfile::tempdir().unwrap();
        let old = passphrase_file(data.path(), "old", "the old passphrase, long enough");
        let new = passphrase_file(data.path(), "new", "the new passphrase, long enough");
        let first = load(
            data.path(),
            &SecretsSettings {
                keys: vec![KeySource::Passphrase {
                    file: Some(old.clone()),
                }],
            },
            &none(),
            false,
        )
        .await
        .unwrap();
        let both = SecretsSettings {
            keys: vec![
                KeySource::Passphrase { file: Some(new) },
                KeySource::Passphrase { file: Some(old) },
            ],
        };
        let rotated = load(data.path(), &both, &none(), false).await.unwrap();
        assert_ne!(rotated.keyring.active().id(), first.keyring.active().id());
        assert!(rotated.keyring.get(first.keyring.active().id()).is_some());
        let again = load(data.path(), &both, &none(), false).await.unwrap();
        assert_eq!(again.keyring.ids(), rotated.keyring.ids());
    }

    #[tokio::test]
    async fn a_short_passphrase_is_refused() {
        let data = tempfile::tempdir().unwrap();
        let file = passphrase_file(data.path(), "pass", "too short");
        let settings = SecretsSettings {
            keys: vec![KeySource::Passphrase { file: Some(file) }],
        };
        let e = load(data.path(), &settings, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("shorter than 16"), "{e}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_key_command_gives_the_key_and_its_failures_refuse_the_start() {
        let data = tempfile::tempdir().unwrap();
        let kek = Kek::generate().unwrap();
        let text = key_file_text(&kek);
        let sh =
            |script: &str| KeySource::Command(vec!["/bin/sh".into(), "-c".into(), script.into()]);
        let ok = SecretsSettings {
            keys: vec![sh(&format!("printf '%s' '{}'", text.trim()))],
        };
        let loaded = load(data.path(), &ok, &none(), false).await.unwrap();
        assert_eq!(loaded.keyring.active().id(), kek.id());

        // A clean environment: only PATH, HOME and LANG. Cargo sets CARGO for the test, so the
        // script exits 3 when it leaks through; otherwise its empty output is "not a key".
        let env = SecretsSettings {
            keys: vec![sh(
                "test -z \"$CARGO$CARGO_PKG_NAME\" && test -n \"$PATH\" || exit 3",
            )],
        };
        let e = load(data.path(), &env, &none(), false).await.err().unwrap();
        assert!(e.0.contains("not a key"), "{e}");

        let failing = SecretsSettings {
            keys: vec![sh("echo 'vault: permission denied' >&2; exit 2")],
        };
        let e = load(data.path(), &failing, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("vault: permission denied"), "{e}");

        let malformed = SecretsSettings {
            keys: vec![sh("echo the-key-is-hunter2")],
        };
        let e = load(data.path(), &malformed, &none(), false)
            .await
            .err()
            .unwrap();
        assert!(e.0.contains("not a key"), "{e}");
        assert!(!e.0.contains("hunter2"), "{e}");
    }

    #[test]
    fn stderr_is_clipped() {
        let long = vec![b'x'; STDERR_SHOWN + 10];
        let clipped = clip_stderr(&long);
        assert!(clipped.ends_with(" …"));
        assert_eq!(clipped.len(), STDERR_SHOWN + " …".len());
    }
}
