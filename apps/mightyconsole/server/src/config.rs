//! The configuration file (DOC-25 §3.6.1): TOML, from `--config FILE`, else
//! `$MIGHTYCONSOLE_CONFIG`, else `DATA/config.toml` when it exists. Flags win over the
//! environment, which wins over the file, which wins over the defaults.
//!
//! The file holds no secret material, only paths: the OIDC client secret comes from
//! `client_secret_file` or the environment variable [`OIDC_CLIENT_SECRET_ENV`] (which wins). A
//! file that is group- or world-writable is refused (Unix). Unknown keys are refused, so a typo
//! is not silently ignored; the keys of later tasks (accounts, roles, secrets, audit) are added
//! with those tasks. Relative paths are relative to the file's directory.
//!
//! ```toml
//! [server]
//! listen = "0.0.0.0:7443"
//! public_origin = "https://mc.example.com"
//! hosts = ["mc.example.com"]
//!
//! [auth]
//! tenant = "default"
//! accounts = true       # built-in accounts; false: the IdP is the only source of users
//! signup = "open"       # or "off": only an administrator makes accounts
//! require_totp = "none" # or "admins", "all"
//! default_admin = true
//! default_role = "member" # every user's role besides any other ("" for none)
//! session_idle = "60m"
//! session_absolute = "12h"
//!
//! # Pinned group mappings (DOC-25 §3.3.5): always present, not editable in the UI.
//! [[auth.group_roles]]
//! group = "idp:platform-admins"   # or "local:<name>"
//! role = "admin"
//! scope = ["profile:01J…/ns:team-a-*"] # optional; left out = everywhere
//!
//! [audit]
//! reads = "sensitive"   # or "all"
//! stderr = false        # also write one line per recorded call to stderr
//! segment_bytes = "64MiB"
//! retention_days = 400
//! min_retention_days = 30
//! max_bytes = "10GiB"
//!
//! [auth.oidc]
//! issuer = "https://idp.example.com/dex"
//! client_id = "mightyconsole"
//! client_secret_file = "/etc/mightyconsole/oidc-secret"
//! ca_file = "/etc/mightyconsole/idp-ca.pem"
//! scopes = ["openid", "profile", "email", "groups"]
//! ```

use std::path::{Path, PathBuf};
use std::time::Duration;

use ambidex_axum::SessionLimits;
use ambidex_axum::accounts::{RequireTotp, Signup};
use ambidex_axum::oidc::{ClaimsSource, OidcConfig, SignatureAlgorithm, TokenAuth};
use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject as _;
use serde::Deserialize;
use zeroize::Zeroizing;

use audit_jsonl::SegmentPolicy;

use security_types::{Scope, ScopeEntry};

use crate::audit::{AuditSettings, Reads};
use crate::authz::catalogue;
use crate::authz::policy::{GroupMapping, is_group, is_role_id};

/// The environment variable naming the configuration file.
pub const CONFIG_ENV: &str = "MIGHTYCONSOLE_CONFIG";
/// The environment variable holding the OIDC client secret (wins over `client_secret_file`).
pub const OIDC_CLIENT_SECRET_ENV: &str = "MIGHTYCONSOLE_OIDC_CLIENT_SECRET";
/// The file looked for in the data directory.
pub const DEFAULT_FILE: &str = "config.toml";

/// The file, as written.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileConfig {
    #[serde(default)]
    pub server: ServerSection,
    #[serde(default)]
    pub auth: AuthSection,
    #[serde(default)]
    pub audit: AuditSection,
}

/// `[audit]` (DOC-25 §3.5, §3.6.1). Segments, retention and size come with the rotation.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuditSection {
    /// `"sensitive"` (default) or `"all"`.
    pub reads: Option<String>,
    /// Also write one line per recorded call to stderr.
    pub stderr: Option<bool>,
    /// A new segment at this size: bytes, or a size such as `"64MiB"`.
    pub segment_bytes: Option<SizeValue>,
    pub retention_days: Option<u32>,
    pub min_retention_days: Option<u32>,
    /// The size of all segments together: bytes, or a size such as `"10GiB"`.
    pub max_bytes: Option<SizeValue>,
}

/// A size in the file: a number of bytes, or text with a unit (`KiB`, `MiB`, `GiB`, `TiB`).
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum SizeValue {
    Bytes(u64),
    Text(String),
}

impl SizeValue {
    fn bytes(&self, what: &str) -> Result<u64, String> {
        match self {
            SizeValue::Bytes(n) => Ok(*n),
            SizeValue::Text(text) => parse_size(text).map_err(|e| format!("{what}: {e}")),
        }
    }
}

/// `64MiB`, `10 GiB`, `4096`: bytes, with an optional binary unit.
pub fn parse_size(text: &str) -> Result<u64, String> {
    let text = text.trim();
    let split = text
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let number: u64 = number
        .parse()
        .map_err(|_| format!("{text:?} is not a size (for example 64MiB)"))?;
    let factor: u64 = match unit.trim() {
        "" | "B" => 1,
        "KiB" => 1 << 10,
        "MiB" => 1 << 20,
        "GiB" => 1 << 30,
        "TiB" => 1 << 40,
        other => return Err(format!("unit {other:?}: B, KiB, MiB, GiB or TiB")),
    };
    number
        .checked_mul(factor)
        .ok_or_else(|| format!("{text:?} is too large"))
}

/// The smallest segment the file may ask for.
const MIN_SEGMENT_BYTES: u64 = 1 << 20;

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServerSection {
    pub listen: Option<String>,
    pub hosts: Option<Vec<String>>,
    pub public_origin: Option<String>,
    pub base_path: Option<String>,
    pub router: Option<String>,
    pub ui: Option<PathBuf>,
    pub tls_cert: Option<PathBuf>,
    pub tls_key: Option<PathBuf>,
    pub data: Option<PathBuf>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthSection {
    pub tenant: Option<String>,
    pub session_idle: Option<String>,
    pub session_absolute: Option<String>,
    pub max_sessions_per_user: Option<usize>,
    pub max_sessions: Option<usize>,
    /// The default administrator (DOC-25 §3.2.7); default true.
    pub default_admin: Option<bool>,
    /// Built-in accounts (DOC-25 §3.2.6); default true.
    pub accounts: Option<bool>,
    /// `"open"` (default) or `"off"`.
    pub signup: Option<String>,
    /// `"none"` (default), `"admins"` or `"all"`.
    pub require_totp: Option<String>,
    /// Every user's role (DOC-25 §3.2.3); default `member`, `""` for none.
    pub default_role: Option<String>,
    /// Pinned group mappings (DOC-25 §3.3.5).
    pub group_roles: Option<Vec<GroupRoleSection>>,
    pub oidc: Option<OidcSection>,
}

/// One `[[auth.group_roles]]` entry.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupRoleSection {
    pub group: String,
    pub role: String,
    pub scope: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OidcSection {
    pub issuer: String,
    pub client_id: String,
    pub client_secret_file: Option<PathBuf>,
    pub token_auth: Option<String>,
    pub ca_file: PathBuf,
    pub scopes: Option<Vec<String>>,
    pub groups_claim: Option<String>,
    pub claims_source: Option<String>,
    pub display_name: Option<String>,
    pub clock_skew: Option<String>,
    pub idp_logout: Option<bool>,
    pub algorithms: Option<Vec<String>>,
}

/// Sign-in settings, resolved (DOC-25 §3.2, §3.6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthSettings {
    /// `auth.tenant`: the one tenant of this server.
    pub tenant: String,
    pub limits: SessionLimits,
    /// `auth.default_admin`: the account `admin` with a generated password (DOC-25 §3.2.7).
    pub default_admin: bool,
    /// `auth.accounts`: built-in accounts. Off, only the default administrator signs in with a
    /// password and nobody signs up (the IdP is the source of users).
    pub accounts: bool,
    /// `auth.signup`.
    pub signup: Signup,
    /// `auth.require_totp`.
    pub require_totp: RequireTotp,
    /// `auth.default_role`: every user's role besides any other; `None` for `""`.
    pub default_role: Option<String>,
    /// `[[auth.group_roles]]`: pinned group mappings.
    pub group_roles: Vec<GroupMapping>,
    /// `[auth.oidc]`, when configured.
    pub oidc: Option<OidcSettings>,
}

impl Default for AuthSettings {
    fn default() -> Self {
        AuthSettings {
            tenant: "default".into(),
            limits: SessionLimits::default(),
            default_admin: true,
            accounts: true,
            signup: Signup::Open,
            require_totp: RequireTotp::None,
            default_role: Some(catalogue::MEMBER_ROLE.into()),
            group_roles: Vec::new(),
            oidc: None,
        }
    }
}

/// `[auth.oidc]`, with paths resolved. The CA and the secret are read by [`OidcSettings::load`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcSettings {
    pub issuer: String,
    pub client_id: String,
    pub client_secret_file: Option<PathBuf>,
    pub token_auth: TokenAuth,
    pub ca_file: PathBuf,
    pub scopes: Option<Vec<String>>,
    pub groups_claim: Option<String>,
    pub claims_source: ClaimsSource,
    pub display_name: Option<String>,
    pub clock_skew: Option<Duration>,
    pub idp_logout: bool,
    pub algorithms: Option<Vec<SignatureAlgorithm>>,
}

impl OidcSettings {
    /// Reads the CA file and the client secret and checks everything that needs no network
    /// (DOC-25 §3.6.2 point 2). `env_secret` is [`OIDC_CLIENT_SECRET_ENV`]'s value.
    pub fn load(&self, env_secret: Option<String>) -> Result<OidcConfig, String> {
        let pem = std::fs::read(&self.ca_file)
            .map_err(|e| format!("[auth.oidc] ca_file {}: {e}", self.ca_file.display()))?;
        let ca: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(&pem)
            .collect::<Result<_, _>>()
            .map_err(|e| format!("[auth.oidc] ca_file {}: {e}", self.ca_file.display()))?;
        if ca.is_empty() {
            return Err(format!(
                "[auth.oidc] ca_file {}: no certificate in it",
                self.ca_file.display()
            ));
        }
        let mut config = OidcConfig::new(self.issuer.clone(), self.client_id.clone(), ca);
        config.token_auth = self.token_auth;
        if self.token_auth != TokenAuth::None {
            let secret = match env_secret.filter(|s| !s.is_empty()) {
                Some(secret) => Zeroizing::new(secret),
                None => {
                    let path = self.client_secret_file.as_ref().ok_or_else(|| {
                        format!(
                            "[auth.oidc] needs client_secret_file or ${OIDC_CLIENT_SECRET_ENV} \
                             (or token_auth = \"none\" for a public client)"
                        )
                    })?;
                    let text = Zeroizing::new(std::fs::read_to_string(path).map_err(|e| {
                        format!("[auth.oidc] client_secret_file {}: {e}", path.display())
                    })?);
                    Zeroizing::new(text.trim_end_matches(['\r', '\n']).to_owned())
                }
            };
            config.client_secret = Some(secret);
        }
        if let Some(scopes) = &self.scopes {
            config.scopes = scopes.clone();
        }
        if let Some(claim) = &self.groups_claim {
            config.groups_claim = claim.clone();
        }
        config.claims_source = self.claims_source;
        if let Some(name) = &self.display_name {
            config.display_name = name.clone();
        }
        if let Some(skew) = self.clock_skew {
            config.clock_skew = skew;
        }
        config.idp_logout = self.idp_logout;
        if let Some(algorithms) = &self.algorithms {
            config.algorithms = algorithms.clone();
        }
        config.validate().map_err(|e| format!("[auth.oidc]: {e}"))?;
        Ok(config)
    }
}

/// Reads and parses the file. A group- or world-writable file is refused.
pub fn read(path: &Path) -> Result<FileConfig, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let meta = std::fs::metadata(path)
            .map_err(|e| format!("configuration file {}: {e}", path.display()))?;
        if meta.permissions().mode() & 0o022 != 0 {
            return Err(format!(
                "configuration file {} is group- or world-writable; chmod go-w it",
                path.display()
            ));
        }
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("configuration file {}: {e}", path.display()))?;
    toml::from_str(&text).map_err(|e| format!("configuration file {}: {e}", path.display()))
}

/// `path` relative to the configuration file's directory, unless absolute.
pub fn relative_to(file: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        file.parent().unwrap_or(Path::new(".")).join(path)
    }
}

/// Resolves the `[audit]` section.
pub fn audit_settings(section: AuditSection) -> Result<AuditSettings, String> {
    let reads = match section.reads.as_deref() {
        None | Some("sensitive") => Reads::Sensitive,
        Some("all") => Reads::All,
        Some(other) => {
            return Err(format!("audit.reads {other:?}: sensitive or all"));
        }
    };
    let mut policy = SegmentPolicy::default();
    if let Some(size) = &section.segment_bytes {
        policy.segment_bytes = size.bytes("audit.segment_bytes")?;
        if policy.segment_bytes < MIN_SEGMENT_BYTES {
            return Err("audit.segment_bytes must be at least 1MiB".into());
        }
    }
    if let Some(size) = &section.max_bytes {
        policy.max_bytes = size.bytes("audit.max_bytes")?;
    }
    if let Some(days) = section.retention_days {
        policy.retention_days = days;
    }
    if let Some(days) = section.min_retention_days {
        policy.min_retention_days = days;
    }
    if policy.min_retention_days > policy.retention_days {
        return Err("audit.min_retention_days must not exceed audit.retention_days".into());
    }
    if policy.max_bytes < policy.segment_bytes.saturating_mul(2) {
        return Err("audit.max_bytes must hold at least two segments (audit.segment_bytes)".into());
    }
    Ok(AuditSettings {
        reads,
        stderr: section.stderr.unwrap_or(false),
        policy,
        new_chain: false,
    })
}

/// Resolves the `[auth]` section.
pub fn auth_settings(section: AuthSection, file: &Path) -> Result<AuthSettings, String> {
    let mut auth = AuthSettings::default();
    if let Some(tenant) = section.tenant {
        if tenant.is_empty() || !tenant.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("auth.tenant must be printable ASCII without spaces".into());
        }
        auth.tenant = tenant;
    }
    if let Some(idle) = section.session_idle {
        auth.limits.idle = duration(&idle).map_err(|e| format!("auth.session_idle: {e}"))?;
    }
    if let Some(absolute) = section.session_absolute {
        auth.limits.absolute =
            duration(&absolute).map_err(|e| format!("auth.session_absolute: {e}"))?;
    }
    if let Some(n) = section.max_sessions_per_user {
        if n == 0 {
            return Err("auth.max_sessions_per_user must be at least 1".into());
        }
        auth.limits.max_per_user = n;
    }
    if let Some(n) = section.max_sessions {
        if n == 0 {
            return Err("auth.max_sessions must be at least 1".into());
        }
        auth.limits.max_total = n;
    }
    if auth.limits.idle.is_zero() || auth.limits.absolute.is_zero() {
        return Err("auth.session_idle and auth.session_absolute must be longer than 0".into());
    }
    if let Some(default_admin) = section.default_admin {
        auth.default_admin = default_admin;
    }
    if let Some(accounts) = section.accounts {
        auth.accounts = accounts;
    }
    auth.signup = match section.signup.as_deref() {
        None | Some("open") => Signup::Open,
        Some("off") => Signup::Off,
        Some(other) => return Err(format!("auth.signup {other:?}: open or off")),
    };
    auth.require_totp = match section.require_totp.as_deref() {
        None | Some("none") => RequireTotp::None,
        Some("admins") => RequireTotp::Admins,
        Some("all") => RequireTotp::All,
        Some(other) => return Err(format!("auth.require_totp {other:?}: none, admins or all")),
    };
    if let Some(role) = section.default_role {
        auth.default_role = match role.as_str() {
            "" => None,
            id if is_role_id(id) => Some(id.to_owned()),
            other => {
                return Err(format!(
                    "auth.default_role {other:?}: a role id ([a-z][a-z0-9-]{{1,31}}) or \"\""
                ));
            }
        };
    }
    for (i, entry) in section.group_roles.into_iter().flatten().enumerate() {
        let at = format!("[[auth.group_roles]] entry {}", i + 1);
        if !is_group(&entry.group) {
            return Err(format!(
                "{at}: group {:?} must be idp:<name> or local:<name>",
                entry.group
            ));
        }
        if !is_role_id(&entry.role) {
            return Err(format!("{at}: role {:?} is not a role id", entry.role));
        }
        let scope = match entry.scope {
            None => Scope::everywhere(),
            Some(entries) => Scope::only(
                entries
                    .iter()
                    .map(|e| e.parse::<ScopeEntry>().map_err(|e| format!("{at}: {e}")))
                    .collect::<Result<_, _>>()?,
            ),
        };
        auth.group_roles.push(GroupMapping {
            group: entry.group,
            role: entry.role,
            scope,
        });
    }
    if let Some(oidc) = section.oidc {
        let token_auth = match oidc.token_auth.as_deref() {
            None | Some("basic") => TokenAuth::Basic,
            Some("post") => TokenAuth::Post,
            Some("none") => TokenAuth::None,
            Some(other) => {
                return Err(format!(
                    "[auth.oidc] token_auth {other:?}: basic, post or none"
                ));
            }
        };
        let claims_source = match oidc.claims_source.as_deref() {
            None | Some("id_token") => ClaimsSource::IdToken,
            Some("userinfo") => ClaimsSource::Userinfo,
            Some(other) => {
                return Err(format!(
                    "[auth.oidc] claims_source {other:?}: id_token or userinfo"
                ));
            }
        };
        let algorithms = match oidc.algorithms {
            None => None,
            Some(names) => Some(
                names
                    .iter()
                    .map(|name| {
                        SignatureAlgorithm::parse(name).ok_or_else(|| {
                            format!(
                                "[auth.oidc] algorithms: {name:?} is not allowed (none and HS* \
                                 never are); allowed: {}",
                                SignatureAlgorithm::ALL.map(|a| a.as_str()).join(" ")
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        };
        let clock_skew = match oidc.clock_skew {
            None => None,
            Some(text) => {
                Some(duration(&text).map_err(|e| format!("[auth.oidc] clock_skew: {e}"))?)
            }
        };
        auth.oidc = Some(OidcSettings {
            issuer: oidc.issuer,
            client_id: oidc.client_id,
            client_secret_file: oidc.client_secret_file.map(|p| relative_to(file, &p)),
            token_auth,
            ca_file: relative_to(file, &oidc.ca_file),
            scopes: oidc.scopes,
            groups_claim: oidc.groups_claim,
            claims_source,
            display_name: oidc.display_name,
            clock_skew,
            idp_logout: oidc.idp_logout.unwrap_or(true),
            algorithms,
        });
    }
    Ok(auth)
}

/// A duration: one or more `<number><unit>` with units `s`, `m`, `h`, `d` (`90s`, `1h30m`).
pub fn duration(text: &str) -> Result<Duration, String> {
    let mut total = Duration::ZERO;
    let mut number = String::new();
    let mut any = false;
    for c in text.trim().chars() {
        if c.is_ascii_digit() {
            number.push(c);
            continue;
        }
        let unit = match c {
            's' => 1,
            'm' => 60,
            'h' => 3600,
            'd' => 86_400,
            _ => return Err(format!("{text:?}: use s, m, h or d, e.g. 60m")),
        };
        let n: u64 = number
            .parse()
            .map_err(|_| format!("{text:?}: a number goes before each unit"))?;
        total += Duration::from_secs(n.saturating_mul(unit));
        number.clear();
        any = true;
    }
    if !number.is_empty() || !any {
        return Err(format!("{text:?}: give a unit, e.g. 60m"));
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(duration("60m"), Ok(Duration::from_secs(3600)));
        assert_eq!(duration("1h30m"), Ok(Duration::from_secs(5400)));
        assert_eq!(duration("2d"), Ok(Duration::from_secs(172_800)));
        for bad in ["", "60", "m", "5x", "1.5h"] {
            assert!(duration(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_auth_section_resolves_and_refuses_bad_values() {
        let file: FileConfig = toml::from_str(
            r#"
            [auth]
            tenant = "acme"
            session_idle = "30m"
            [auth.oidc]
            issuer = "https://idp.test/dex"
            client_id = "mc"
            client_secret_file = "secret"
            ca_file = "/etc/ca.pem"
            token_auth = "post"
            algorithms = ["RS256", "ES256"]
            clock_skew = "30s"
            "#,
        )
        .unwrap();
        let auth = auth_settings(file.auth, Path::new("/etc/mc/config.toml")).unwrap();
        assert_eq!(auth.tenant, "acme");
        assert_eq!(auth.limits.idle, Duration::from_secs(1800));
        assert_eq!(auth.limits.absolute, Duration::from_secs(12 * 3600));
        let oidc = auth.oidc.unwrap();
        assert_eq!(
            oidc.client_secret_file,
            Some(PathBuf::from("/etc/mc/secret"))
        );
        assert_eq!(oidc.ca_file, PathBuf::from("/etc/ca.pem"));
        assert_eq!(oidc.token_auth, TokenAuth::Post);
        assert_eq!(oidc.clock_skew, Some(Duration::from_secs(30)));
        for bad in [
            "[auth.oidc]\nissuer='https://i'\nclient_id='c'\nca_file='a'\nalgorithms=['HS256']",
            "[auth.oidc]\nissuer='https://i'\nclient_id='c'\nca_file='a'\nalgorithms=['none']",
            "[auth.oidc]\nissuer='https://i'\nclient_id='c'\nca_file='a'\ntoken_auth='jwt'",
            "[auth]\nsession_idle='forever'",
            "[auth]\nmax_sessions=0",
        ] {
            let file: FileConfig = toml::from_str(bad).unwrap();
            assert!(
                auth_settings(file.auth, Path::new("/c.toml")).is_err(),
                "{bad}"
            );
        }
        assert!(toml::from_str::<FileConfig>("[auth]\ntypo = 1").is_err());
        assert!(
            toml::from_str::<FileConfig>(
                "[auth.oidc]\nissuer='x'\nclient_id='c'\nca_file='a'\nclient_secret='inline'"
            )
            .is_err()
        );
    }

    #[test]
    fn the_default_role_and_pinned_group_roles_resolve() {
        let none: FileConfig = toml::from_str("").unwrap();
        let auth = auth_settings(none.auth, Path::new("/c.toml")).unwrap();
        assert_eq!(auth.default_role.as_deref(), Some("member"));
        assert!(auth.group_roles.is_empty());
        let file: FileConfig = toml::from_str(
            r#"
            [auth]
            default_role = ""
            [[auth.group_roles]]
            group = "idp:platform-admins"
            role = "admin"
            [[auth.group_roles]]
            group = "local:team-a"
            role = "operator"
            scope = ["profile:P1/ns:team-a-*", "personal"]
            "#,
        )
        .unwrap();
        let auth = auth_settings(file.auth, Path::new("/c.toml")).unwrap();
        assert_eq!(auth.default_role, None);
        assert_eq!(auth.group_roles.len(), 2);
        assert!(auth.group_roles[0].scope.is_everywhere());
        assert_eq!(
            serde_json::to_value(&auth.group_roles[1].scope).unwrap(),
            serde_json::json!(["profile:P1/ns:team-a-*", "personal"])
        );
        for bad in [
            "[auth]
default_role = 'Admin'",
            "[[auth.group_roles]]
group = 'admins'
role = 'admin'",
            "[[auth.group_roles]]
group = 'idp:x'
role = 'a b'",
            "[[auth.group_roles]]
group = 'idp:x'
role = 'admin'
scope = ['namespace:x']",
        ] {
            let file: FileConfig = toml::from_str(bad).unwrap();
            assert!(
                auth_settings(file.auth, Path::new("/c.toml")).is_err(),
                "{bad}"
            );
        }
        assert!(
            toml::from_str::<FileConfig>(
                "[[auth.group_roles]]
group='idp:x'
role='admin'
scopes=[]"
            )
            .is_err()
        );
    }

    #[test]
    fn the_audit_section_resolves_and_refuses_bad_values() {
        let none: FileConfig = toml::from_str("").unwrap();
        assert_eq!(
            audit_settings(none.audit).unwrap(),
            AuditSettings::default()
        );
        let file: FileConfig = toml::from_str("[audit]\nreads = \"all\"\nstderr = true").unwrap();
        assert_eq!(
            audit_settings(file.audit).unwrap(),
            AuditSettings {
                reads: Reads::All,
                stderr: true,
                ..AuditSettings::default()
            }
        );
        let sized: FileConfig = toml::from_str(
            "[audit]\nsegment_bytes = \"8MiB\"\nmax_bytes = \"1GiB\"\nretention_days = 90\nmin_retention_days = 7",
        )
        .unwrap();
        let policy = audit_settings(sized.audit).unwrap().policy;
        assert_eq!(policy.segment_bytes, 8 << 20);
        assert_eq!(policy.max_bytes, 1 << 30);
        assert_eq!((policy.retention_days, policy.min_retention_days), (90, 7));
        for bad in [
            "segment_bytes = 1024",
            "segment_bytes = \"lots\"",
            "segment_bytes = \"5 furlongs\"",
            "retention_days = 10\nmin_retention_days = 20",
            "segment_bytes = \"64MiB\"\nmax_bytes = \"100MiB\"",
        ] {
            let file: FileConfig = toml::from_str(&format!("[audit]\n{bad}")).unwrap();
            assert!(audit_settings(file.audit).is_err(), "{bad}");
        }
        assert_eq!(parse_size("4096"), Ok(4096));
        assert_eq!(parse_size("2 GiB"), Ok(2 << 30));
        let bad: FileConfig = toml::from_str("[audit]\nreads = \"some\"").unwrap();
        assert!(
            audit_settings(bad.audit)
                .unwrap_err()
                .contains("audit.reads")
        );
        assert!(toml::from_str::<FileConfig>("[audit]\ntypo = 1").is_err());
    }

    #[test]
    fn loading_reads_the_ca_and_the_secret() {
        let dir = tempfile::tempdir().unwrap();
        let cert = rcgen::generate_simple_self_signed(vec!["idp.test".into()]).unwrap();
        std::fs::write(dir.path().join("ca.pem"), cert.cert.pem()).unwrap();
        std::fs::write(dir.path().join("secret"), "s3cret\n").unwrap();
        std::fs::write(dir.path().join("empty.pem"), "").unwrap();
        let settings = OidcSettings {
            issuer: "https://idp.test/dex".into(),
            client_id: "mc".into(),
            client_secret_file: Some(dir.path().join("secret")),
            token_auth: TokenAuth::Basic,
            ca_file: dir.path().join("ca.pem"),
            scopes: None,
            groups_claim: None,
            claims_source: ClaimsSource::IdToken,
            display_name: Some("Acme SSO".into()),
            clock_skew: None,
            idp_logout: true,
            algorithms: None,
        };
        let config = settings.load(None).unwrap();
        assert_eq!(
            config.client_secret.as_deref().map(String::as_str),
            Some("s3cret")
        );
        assert_eq!(config.display_name, "Acme SSO");
        assert_eq!(config.ca_certs.len(), 1);
        let from_env = settings.load(Some("from-env".into())).unwrap();
        assert_eq!(
            from_env.client_secret.as_deref().map(String::as_str),
            Some("from-env")
        );
        let no_secret = OidcSettings {
            client_secret_file: None,
            ..settings.clone()
        };
        assert!(
            no_secret
                .load(None)
                .unwrap_err()
                .contains("client_secret_file")
        );
        let public = OidcSettings {
            token_auth: TokenAuth::None,
            ..no_secret
        };
        assert!(public.load(None).unwrap().client_secret.is_none());
        let empty = OidcSettings {
            ca_file: dir.path().join("empty.pem"),
            ..settings.clone()
        };
        assert!(empty.load(None).unwrap_err().contains("no certificate"));
        let http = OidcSettings {
            issuer: "http://idp.test".into(),
            ..settings
        };
        assert!(http.load(None).unwrap_err().contains("https://"));
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_file_is_refused() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "[auth]\ntenant = \"t\"\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(read(&path).is_ok());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666)).unwrap();
        assert!(read(&path).unwrap_err().contains("writable"));
    }
}
