//! First-party native PostgreSQL driver behind the db-driver contract (TSK-15; Plugin Host spec
//! §2, ADR "Plugin trust and driver execution model").
//!
//! The driver speaks the PostgreSQL frontend/backend protocol 3.0 itself, with the sans-IO
//! `postgres-protocol` crate for message encoding and SCRAM. It has no socket, TLS or DNS code:
//! every byte goes through the host broker ([`db_driver::ConnectionBroker`]), so grants, address
//! checks, certificate verification, audit and revocation apply as for any other driver. See the
//! crate README for the client choice (spike) and the mapping to Arrow.
//!
//! - Connect: `open(target, "data")`; with [`PgTls::InProtocolUpgrade`], `SSLRequest` then the
//!   broker's `start_tls` on the same transport (no plaintext fallback); then startup and
//!   authentication (cleartext, MD5 or SCRAM-SHA-256 with server signature verification).
//! - Execute: one statement per call over the extended protocol, results in binary where the
//!   Arrow mapping is exact and in text otherwise, streamed as Arrow IPC chunks pulled on demand.
//! - Cancel: an out-of-band `CancelRequest` on `open(target, "cancel")`, upgraded to TLS first
//!   exactly like the data connection (Plugin Host spec, Open question 27).
//! - [`AccessMode::ReadOnly`]: every statement runs inside `BEGIN TRANSACTION READ ONLY` and is
//!   rolled back, for agent Read calls.

mod batch;
mod cancel;
mod conn;
mod error;
mod introspect;
mod stream;
mod wire;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use db_driver::{Connection, ConnectionBroker, DbError, DbFuture, Driver};
use zeroize::Zeroizing;

/// Field metadata key holding the PostgreSQL type OID of each result column.
pub const TYPE_OID_METADATA: &str = "byterygon.pg.type_oid";

/// How statements run on a connection, chosen by the host for the caller and operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessMode {
    /// Each statement (and each introspection query) runs in its own
    /// `BEGIN TRANSACTION READ ONLY` transaction, which is then rolled back. The session also
    /// starts with `default_transaction_read_only = on`. For agent Read calls.
    ReadOnly,
    /// Statements run as sent, in the session's own transaction state.
    ReadWrite,
}

/// Transport security the driver negotiates. It must match the connection grant: the broker
/// refuses `start_tls` on a plaintext grant and closes an upgrade-mode transport that keeps
/// talking plaintext, so a mismatch fails closed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PgTls {
    /// Plaintext grant (Plugin Host `TlsPolicy::Disabled`).
    Disabled,
    /// `SSLRequest`, then `start_tls(server_name)`; `server_name` is the grant's TLS server name.
    InProtocolUpgrade { server_name: String },
}

/// A database password. Zeroed on drop and never printed.
#[derive(Clone)]
pub struct Password(Zeroizing<String>);

impl Password {
    pub fn new(password: impl Into<String>) -> Self {
        Self(Zeroizing::new(password.into()))
    }

    fn as_bytes(&self) -> &[u8] {
        self.0.as_bytes()
    }
}

impl fmt::Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Password(<redacted>)")
    }
}

/// What the driver needs for one connection besides the broker: login, database, TLS mode and
/// access mode. Resolved by the host from the target and credential reference.
#[derive(Debug, Clone)]
pub struct PgSettings {
    pub user: String,
    pub database: String,
    pub password: Option<Password>,
    pub tls: PgTls,
    pub access: AccessMode,
    pub application_name: String,
    /// Bound on open, TLS negotiation, startup and authentication together.
    pub connect_timeout: Duration,
}

/// Host service that resolves a target and credential reference to [`PgSettings`]. The host
/// releases the credential only for the authorized connection (Plugin Host spec §2 "Credential
/// visibility"); the driver never logs or stores it beyond authentication.
pub trait SettingsSource: Send + Sync {
    fn settings<'a>(
        &'a self,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, PgSettings>;
}

/// The native PostgreSQL driver.
///
/// The contract's `connect` only borrows the broker, but a connection must open `"cancel"`
/// transports for as long as it lives. The host therefore also hands the driver an owned handle
/// to the same broker, and `connect` refuses any other broker (Plugin Host spec Open questions).
pub struct PostgresDriver {
    broker: Arc<dyn ConnectionBroker>,
    settings: Arc<dyn SettingsSource>,
}

impl PostgresDriver {
    pub fn new(broker: Arc<dyn ConnectionBroker>, settings: Arc<dyn SettingsSource>) -> Self {
        Self { broker, settings }
    }
}

impl Driver for PostgresDriver {
    fn connect<'a>(
        &'a self,
        broker: &'a dyn ConnectionBroker,
        target_id: &'a str,
        credential_ref: Option<&'a str>,
    ) -> DbFuture<'a, Box<dyn Connection>> {
        Box::pin(async move {
            // Same broker object, hence the same plugin instance, principal and grants.
            if !std::ptr::addr_eq(broker, Arc::as_ptr(&self.broker)) {
                return Err(DbError::PermissionDenied);
            }
            let settings = self.settings.settings(target_id, credential_ref).await?;
            let conn =
                conn::PgConnection::connect(self.broker.clone(), target_id, settings).await?;
            Ok(Box::new(conn) as Box<dyn Connection>)
        })
    }
}
