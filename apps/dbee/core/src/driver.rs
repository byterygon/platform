//! The built-in PostgreSQL driver as the Plugin Host sees it, the host services it needs, and
//! the seams the shells and tests plug into (DBee spec §2, §4).
//!
//! - [`postgres_driver`]: the driver's identity (plugin id, version, digest) and capability
//!   templates, which every grant binds to. The digest is derived from the id and version: the
//!   driver is compiled into the core, so the core's own version identifies it.
//! - [`Resolve`]: host-side name resolution. [`SystemResolve`] uses the OS resolver; tests pin
//!   answers. [`ArcResolver`] adapts it to the Plugin Host's `Resolver`, so the broker resolves
//!   through the same source.
//! - [`DriverFactory`]: how a session gets a `db_driver::Connection`. [`PostgresFactory`] is the
//!   real one; tests supply a fake that needs no database.
//! - [`DbeeSettings`]: the `SettingsSource` of the PostgreSQL driver (Plugin Host spec Open
//!   question 32): it releases the password only for the connection whose secret reference the
//!   driver presents, and only while that connection's grant is active.

use std::io;
use std::net::IpAddr;
use std::sync::Arc;

use db_driver::{Connection, ConnectionBroker, DbError, DbFuture};
use plugin_host::{DriverKind, InstalledPlugin, Manifest};
use security_types::{BoxFuture, Digest};
use sha2::{Digest as _, Sha256};

use crate::secrets::Secrets;
use crate::types::{DriverInfo, GrantState};
use crate::workspace::Workspace;

/// Plugin id of the built-in PostgreSQL driver.
pub const POSTGRES_PLUGIN_ID: &str = "com.byterygon.dbee.postgres";
/// The network template every DBee grant binds (DBee spec §4).
pub const TRANSPORT_TEMPLATE: &str = "db-transport";
/// The credential template of the secret binding.
pub const CREDENTIAL_TEMPLATE: &str = "db-credentials";
/// Domain of [`driver_digest`].
const DRIVER_DIGEST_DOMAIN: &str = "byterygon.dbee.builtin-driver.v1";

/// The capability templates of the built-in driver, in the manifest format third-party plugins
/// use. `tls = "optional"` is what allows a plaintext grant (Plugin Host spec Open question 26).
const POSTGRES_MANIFEST: &str = r#"
manifest_version = 1
id = "com.byterygon.dbee.postgres"
version = "0.0.0"
kind = "wasm"
entry = "builtin"
interface = "byterygon:db-driver@0.1.0"
host_api = ">=0.1.0, <0.2.0"
publisher = "byterygon"
description = "First-party native PostgreSQL driver, compiled into DBee."

[[capabilities.network]]
id = "db-transport"
protocol = "tcp"
default_port = 5432
tls = "optional"
allow_in_protocol_tls_upgrade = true
allow_cancel_connection = true

[[capabilities.secrets]]
id = "db-credentials"
purpose = "database-auth"
scope = "connection"
needs_credential = true
"#;

/// A driver compiled into the core.
#[derive(Debug, Clone)]
pub struct BuiltinDriver {
    pub info: DriverInfo,
    pub plugin: InstalledPlugin,
}

/// SHA-256 over the domain, a zero byte, the id, a zero byte and the version.
pub fn driver_digest(id: &str, version: &str) -> Digest {
    let mut h = Sha256::new();
    h.update(DRIVER_DIGEST_DOMAIN.as_bytes());
    h.update([0]);
    h.update(id.as_bytes());
    h.update([0]);
    h.update(version.as_bytes());
    Digest(h.finalize().into())
}

/// The built-in PostgreSQL driver at this core's version.
pub fn postgres_driver() -> BuiltinDriver {
    let version = env!("CARGO_PKG_VERSION");
    let digest = driver_digest(POSTGRES_PLUGIN_ID, version);
    let manifest = Manifest::from_toml(POSTGRES_MANIFEST).expect("the built-in manifest parses");
    BuiltinDriver {
        info: DriverInfo {
            id: POSTGRES_PLUGIN_ID.into(),
            name: "PostgreSQL".into(),
            version: version.into(),
            digest: format!("sha256:{digest}"),
            first_party: true,
        },
        plugin: InstalledPlugin {
            id: POSTGRES_PLUGIN_ID.into(),
            digest,
            driver_kind: DriverKind::Native,
            capabilities: manifest.capabilities,
        },
    }
}

/// Resolves host names (object-safe; see the module docs).
pub trait Resolve: Send + Sync + 'static {
    fn resolve(&self, host: &str, port: u16) -> BoxFuture<'_, io::Result<Vec<IpAddr>>>;
}

/// The operating system resolver.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemResolve;

impl Resolve for SystemResolve {
    fn resolve(&self, host: &str, port: u16) -> BoxFuture<'_, io::Result<Vec<IpAddr>>> {
        let host = host.to_owned();
        Box::pin(async move {
            Ok(tokio::net::lookup_host((host.as_str(), port))
                .await?
                .map(|sa| sa.ip())
                .collect())
        })
    }
}

/// A shared [`Resolve`] as the Plugin Host's `Resolver`.
#[derive(Clone)]
pub struct ArcResolver(pub Arc<dyn Resolve>);

impl plugin_host::Resolver for ArcResolver {
    async fn resolve(&self, host: &str, port: u16) -> io::Result<Vec<IpAddr>> {
        self.0.resolve(host, port).await
    }
}

/// Opens a database connection through a broker scope.
pub trait DriverFactory: Send + Sync + 'static {
    fn connect<'a>(
        &'a self,
        broker: Arc<dyn ConnectionBroker>,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, Box<dyn Connection>>;
}

/// The PostgreSQL driver's view of connections and credentials.
pub struct DbeeSettings {
    pub workspace: Arc<Workspace>,
    pub secrets: Arc<Secrets>,
}

impl DbeeSettings {
    /// The password for `target_id` as the driver asks for it: only for the active connection
    /// bound to the target, and only when `credential_ref` names that connection's secret
    /// reference (keychain) or is absent and a session password was given for it.
    pub async fn password(
        &self,
        target_id: &str,
        credential_ref: Option<&str>,
    ) -> Result<
        (
            crate::workspace::ConnectionRecord,
            Option<crate::secrets::Secret>,
        ),
        DbError,
    > {
        let record = self
            .workspace
            .connections()
            .into_iter()
            .find(|r| r.grant.target_id == target_id && r.grant.state == GrantState::Active)
            .ok_or(DbError::PermissionDenied)?;
        let secret = match (credential_ref, &record.secret) {
            (Some(given), Some(bound)) if given == bound.secret_ref => {
                let store = self
                    .secrets
                    .durable
                    .as_ref()
                    .ok_or(DbError::PermissionDenied)?;
                store
                    .get(&bound.secret_ref)
                    .await
                    .map_err(|_| DbError::PermissionDenied)?
            }
            (Some(_), _) => return Err(DbError::PermissionDenied),
            (None, _) => self.secrets.session.get(&record.id),
        };
        Ok((record, secret))
    }
}

#[cfg(feature = "driver-postgres")]
mod postgres {
    use std::time::Duration;

    use db_driver::Driver as _;
    use db_driver_postgres::{
        AccessMode, Password, PgSettings, PgTls, PostgresDriver, SettingsSource,
    };

    use super::*;
    use crate::types::TlsKind;

    /// Bound on open, TLS negotiation, startup and authentication together.
    const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

    impl SettingsSource for DbeeSettings {
        fn settings<'a>(
            &'a self,
            target_id: &'a str,
            credential_ref: Option<&'a str>,
        ) -> DbFuture<'a, PgSettings> {
            Box::pin(async move {
                let (record, secret) = self.password(target_id, credential_ref).await?;
                let tls = match record.grant.tls.kind {
                    TlsKind::Plaintext => PgTls::Disabled,
                    _ => PgTls::InProtocolUpgrade {
                        server_name: record
                            .grant
                            .tls
                            .server_name
                            .clone()
                            .unwrap_or_else(|| record.grant.host.clone()),
                    },
                };
                Ok(PgSettings {
                    user: record.user,
                    database: record.database,
                    password: secret.map(|s| Password::new(s.as_str())),
                    tls,
                    access: AccessMode::ReadWrite,
                    application_name: "dbee".into(),
                    connect_timeout: CONNECT_TIMEOUT,
                })
            })
        }
    }

    /// Connects with the first-party PostgreSQL driver.
    pub struct PostgresFactory {
        pub settings: Arc<DbeeSettings>,
    }

    impl DriverFactory for PostgresFactory {
        fn connect<'a>(
            &'a self,
            broker: Arc<dyn ConnectionBroker>,
            target_id: &'a str,
            credential_ref: Option<&'a str>,
        ) -> DbFuture<'a, Box<dyn Connection>> {
            Box::pin(async move {
                let settings: Arc<dyn SettingsSource> = self.settings.clone();
                let driver = PostgresDriver::new(Arc::clone(&broker), settings);
                driver.connect(&*broker, target_id, credential_ref).await
            })
        }
    }
}

#[cfg(feature = "driver-postgres")]
pub use postgres::PostgresFactory;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_driver_has_the_dbee_templates() {
        let driver = postgres_driver();
        assert_eq!(driver.info.id, POSTGRES_PLUGIN_ID);
        assert!(driver.info.first_party);
        assert!(driver.info.digest.starts_with("sha256:"));
        assert_eq!(
            driver.plugin.digest,
            driver_digest(POSTGRES_PLUGIN_ID, env!("CARGO_PKG_VERSION"))
        );
        let network = &driver.plugin.capabilities.network;
        assert_eq!(network[0].id, TRANSPORT_TEMPLATE);
        assert_eq!(
            driver.plugin.capabilities.secrets[0].id,
            CREDENTIAL_TEMPLATE
        );
        assert_ne!(driver_digest("a", "1"), driver_digest("a", "2"));
    }
}
