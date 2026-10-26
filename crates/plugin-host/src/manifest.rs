//! Plugin manifest capability templates (Plugin Host spec §3).
//!
//! A manifest *requests* capability templates; it never grants anything. A network template says
//! which kind of endpoint a driver can talk to (protocol, default port, TLS rules), but not which
//! one: the concrete host, port and TLS identity are bound later by a [`crate::ConnectionGrant`].
//!
//! Parsing fails closed: unknown fields, unknown enum values and invalid paths are rejected.

use std::collections::BTreeSet;
use std::fmt;

use serde::Deserialize;

/// Manifests larger than this are rejected before parsing.
pub const MAX_MANIFEST_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub manifest_version: u32,
    pub id: String,
    pub version: String,
    pub kind: PackageKind,
    pub entry: String,
    pub interface: String,
    pub host_api: String,
    pub publisher: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub capabilities: Capabilities,
}

/// How a packaged plugin runs. First-party native drivers are compiled into the core and never
/// loaded from a package, so `native` is not a valid package kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PackageKind {
    Wasm,
    Sidecar,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Capabilities {
    #[serde(default)]
    pub network: Vec<NetworkTemplate>,
    #[serde(default)]
    pub secrets: Vec<SecretTemplate>,
    #[serde(default)]
    pub files: Vec<FileTemplate>,
}

/// A request to open brokered connections of one kind. Not a destination.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NetworkTemplate {
    pub id: String,
    pub protocol: Protocol,
    /// Suggested port for the connection form. The grant binds the actual port.
    #[serde(default)]
    pub default_port: Option<u16>,
    pub tls: TlsRequirement,
    /// The driver may negotiate TLS inside its protocol (PostgreSQL, MySQL) and then call
    /// `start-tls` on the same handle.
    #[serde(default)]
    pub allow_in_protocol_tls_upgrade: bool,
    /// The driver may open a second connection to the same target to cancel a query.
    #[serde(default)]
    pub allow_cancel_connection: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Protocol {
    Tcp,
}

/// TLS requirement of a network template (Plugin Host spec, Open question 26). The approver picks
/// the actual policy per connection; this only says which policies the driver supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsRequirement {
    /// Connections must use TLS.
    Required,
    /// The driver also supports plaintext; a grant may choose it explicitly (self-hosted
    /// databases without TLS). Never chosen implicitly or as a fallback.
    Optional,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SecretTemplate {
    pub id: String,
    pub purpose: String,
    pub scope: SecretScope,
    #[serde(default)]
    pub needs_credential: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SecretScope {
    Connection,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FileTemplate {
    pub id: String,
    pub mode: FileMode,
    pub scope: FileScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileMode {
    Read,
    Write,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileScope {
    UserSelected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ManifestError {
    TooLarge,
    /// The TOML did not match the schema. The message comes from the parser.
    Syntax(String),
    UnsupportedVersion(u32),
    Invalid(&'static str),
    DuplicateCapability(String),
}

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ManifestError::TooLarge => write!(f, "manifest exceeds {MAX_MANIFEST_BYTES} bytes"),
            ManifestError::Syntax(msg) => write!(f, "invalid manifest: {msg}"),
            ManifestError::UnsupportedVersion(v) => {
                write!(f, "unsupported manifest_version {v}")
            }
            ManifestError::Invalid(what) => write!(f, "invalid manifest: {what}"),
            ManifestError::DuplicateCapability(id) => {
                write!(f, "duplicate capability id {id:?}")
            }
        }
    }
}

impl std::error::Error for ManifestError {}

impl Manifest {
    /// Parse and validate a `plugin.toml`.
    pub fn from_toml(text: &str) -> Result<Self, ManifestError> {
        if text.len() > MAX_MANIFEST_BYTES {
            return Err(ManifestError::TooLarge);
        }
        let manifest: Manifest =
            toml::from_str(text).map_err(|e| ManifestError::Syntax(e.message().to_owned()))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn network_template(&self, id: &str) -> Option<&NetworkTemplate> {
        self.capabilities.network.iter().find(|t| t.id == id)
    }

    pub fn secret_template(&self, id: &str) -> Option<&SecretTemplate> {
        self.capabilities.secrets.iter().find(|t| t.id == id)
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.manifest_version != 1 {
            return Err(ManifestError::UnsupportedVersion(self.manifest_version));
        }
        if !is_plugin_id(&self.id) {
            return Err(ManifestError::Invalid("id"));
        }
        for (value, what) in [
            (&self.version, "version"),
            (&self.interface, "interface"),
            (&self.host_api, "host_api"),
            (&self.publisher, "publisher"),
        ] {
            if value.trim().is_empty() {
                return Err(ManifestError::Invalid(what));
            }
        }
        if !is_package_path(&self.entry) {
            return Err(ManifestError::Invalid("entry"));
        }

        let caps = &self.capabilities;
        let ids = caps
            .network
            .iter()
            .map(|t| &t.id)
            .chain(caps.secrets.iter().map(|t| &t.id))
            .chain(caps.files.iter().map(|t| &t.id));
        let mut seen = BTreeSet::new();
        for id in ids {
            if !is_capability_id(id) {
                return Err(ManifestError::Invalid("capability id"));
            }
            if !seen.insert(id) {
                return Err(ManifestError::DuplicateCapability(id.clone()));
            }
        }
        if caps.network.iter().any(|t| t.default_port == Some(0)) {
            return Err(ManifestError::Invalid("default_port"));
        }
        if caps.secrets.iter().any(|t| t.purpose.trim().is_empty()) {
            return Err(ManifestError::Invalid("secret purpose"));
        }
        Ok(())
    }
}

/// Reverse-DNS style id: dot-separated labels of `[a-z0-9-]`, at least two labels.
fn is_plugin_id(id: &str) -> bool {
    id.len() <= 128
        && id.split('.').count() >= 2
        && id.split('.').all(|label| {
            !label.is_empty()
                && label
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        })
}

fn is_capability_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A relative path inside the package: `/`-separated, no empty, `.` or `..` components, no
/// backslashes, drive letters or control characters.
fn is_package_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 256
        && !path.starts_with('/')
        && !path.contains(['\\', ':'])
        && !path.chars().any(char::is_control)
        && path
            .split('/')
            .all(|c| !c.is_empty() && c != "." && c != "..")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The example from Plugin Host spec §3.
    const SPEC_EXAMPLE: &str = r#"
manifest_version = 1
id = "org.example.dbee.postgres"
version = "0.1.0"
kind = "wasm"
entry = "components/postgres.wasm"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "example"
description = "PostgreSQL driver"

[[capabilities.network]]
id = "db-transport"
protocol = "tcp"
default_port = 5432
tls = "required"
allow_in_protocol_tls_upgrade = true
allow_cancel_connection = true

[[capabilities.secrets]]
id = "db-credentials"
purpose = "database-auth"
scope = "connection"
needs_credential = true

[[capabilities.files]]
id = "export"
mode = "write"
scope = "user-selected"
"#;

    #[test]
    fn spec_example_parses() {
        let m = Manifest::from_toml(SPEC_EXAMPLE).unwrap();
        assert_eq!(m.kind, PackageKind::Wasm);
        let net = m.network_template("db-transport").unwrap();
        assert_eq!(net.protocol, Protocol::Tcp);
        assert_eq!(net.default_port, Some(5432));
        assert_eq!(net.tls, TlsRequirement::Required);
        assert!(net.allow_in_protocol_tls_upgrade);
        assert!(net.allow_cancel_connection);
        assert_eq!(
            m.secret_template("db-credentials").unwrap().scope,
            SecretScope::Connection
        );
        assert_eq!(m.capabilities.files[0].scope, FileScope::UserSelected);
    }

    #[test]
    fn tls_may_be_optional() {
        let text = SPEC_EXAMPLE.replace("tls = \"required\"", "tls = \"optional\"");
        let m = Manifest::from_toml(&text).unwrap();
        assert_eq!(
            m.network_template("db-transport").unwrap().tls,
            TlsRequirement::Optional
        );
    }

    #[test]
    fn template_flags_default_to_false() {
        let text = SPEC_EXAMPLE
            .replace("allow_in_protocol_tls_upgrade = true\n", "")
            .replace("allow_cancel_connection = true\n", "");
        let m = Manifest::from_toml(&text).unwrap();
        let net = m.network_template("db-transport").unwrap();
        assert!(!net.allow_in_protocol_tls_upgrade);
        assert!(!net.allow_cancel_connection);
    }

    #[test]
    fn manifest_cannot_carry_a_destination() {
        // A template is not a grant: a host field is an unknown, rejected field.
        let text = SPEC_EXAMPLE.replace(
            "default_port = 5432",
            "default_port = 5432\nhost = \"db.internal\"",
        );
        assert!(matches!(
            Manifest::from_toml(&text),
            Err(ManifestError::Syntax(_))
        ));
    }

    #[test]
    fn unknown_fields_are_rejected_everywhere() {
        for (from, to) in [
            (
                "publisher = \"example\"",
                "publisher = \"example\"\nauto_grant = true",
            ),
            (
                "scope = \"connection\"",
                "scope = \"connection\"\nexport = true",
            ),
            ("mode = \"write\"", "mode = \"write\"\nroot = \"/\""),
        ] {
            let text = SPEC_EXAMPLE.replace(from, to);
            assert!(Manifest::from_toml(&text).is_err(), "accepted {to:?}");
        }
        let text = format!("{SPEC_EXAMPLE}\n[[capabilities.process]]\nid = \"sh\"\n");
        assert!(Manifest::from_toml(&text).is_err());
    }

    #[test]
    fn unknown_enum_values_are_rejected() {
        for (from, to) in [
            ("tls = \"required\"", "tls = \"disabled\""),
            ("tls = \"required\"", "tls = \"prefer\""),
            ("protocol = \"tcp\"", "protocol = \"udp\""),
            ("kind = \"wasm\"", "kind = \"native\""),
            ("scope = \"connection\"", "scope = \"tenant\""),
            ("scope = \"user-selected\"", "scope = \"any\""),
        ] {
            let text = SPEC_EXAMPLE.replace(from, to);
            assert!(Manifest::from_toml(&text).is_err(), "accepted {to:?}");
        }
    }

    #[test]
    fn invalid_entry_paths_are_rejected() {
        for entry in [
            "/abs/postgres.wasm",
            "../postgres.wasm",
            "components/../../x.wasm",
            "components//x.wasm",
            "./x.wasm",
            "components\\\\x.wasm",
            "C:/x.wasm",
            "",
        ] {
            let text = SPEC_EXAMPLE.replace(
                "entry = \"components/postgres.wasm\"",
                &format!("entry = \"{entry}\""),
            );
            assert!(Manifest::from_toml(&text).is_err(), "accepted {entry:?}");
        }
    }

    #[test]
    fn duplicate_capability_ids_are_rejected() {
        let text = SPEC_EXAMPLE.replace("id = \"export\"", "id = \"db-transport\"");
        assert_eq!(
            Manifest::from_toml(&text),
            Err(ManifestError::DuplicateCapability("db-transport".into()))
        );
    }

    #[test]
    fn other_validation() {
        let cases = [
            ("manifest_version = 1", "manifest_version = 2"),
            ("id = \"org.example.dbee.postgres\"", "id = \"Postgres\""),
            ("default_port = 5432", "default_port = 0"),
            ("default_port = 5432", "default_port = 70000"),
            ("host_api = \">=0.1.0, <0.2.0\"", "host_api = \" \""),
        ];
        for (from, to) in cases {
            let text = SPEC_EXAMPLE.replace(from, to);
            assert!(Manifest::from_toml(&text).is_err(), "accepted {to:?}");
        }
        assert_eq!(
            Manifest::from_toml(&"#".repeat(MAX_MANIFEST_BYTES + 1)),
            Err(ManifestError::TooLarge)
        );
    }
}
