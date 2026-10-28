//! Out-of-band `CancelRequest` (Plugin Host spec §2 "Connection and cancellation", Open
//! question 27): a new broker transport for purpose `"cancel"` under the same grant, upgraded to
//! TLS exactly like the data connection before the request is sent.

use std::fmt;
use std::time::Duration;

use bytes::BytesMut;
use db_driver::{ConnectionBroker, DbError};
use postgres_protocol::message::frontend;

use crate::PgTls;
use crate::wire::Wire;

/// Bound on one cancel delivery: open, TLS, request and the server closing the connection.
const CANCEL_TIMEOUT: Duration = Duration::from_secs(10);

/// `BackendKeyData`: identifies the backend to cancel. Whoever holds it can cancel the session's
/// queries, so it is never printed.
#[derive(Clone, Copy)]
pub(crate) struct BackendKey {
    pub(crate) process_id: i32,
    pub(crate) secret_key: i32,
}

impl fmt::Debug for BackendKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("BackendKey")
            .field("process_id", &self.process_id)
            .finish_non_exhaustive()
    }
}

/// `SSLRequest` and, if the server agrees, `start_tls` on the same transport. A refusal is a TLS
/// failure, never a fallback to plaintext.
pub(crate) async fn negotiate_tls(wire: &mut Wire, tls: &PgTls) -> Result<(), DbError> {
    let PgTls::InProtocolUpgrade { server_name } = tls else {
        return Ok(());
    };
    let mut buf = BytesMut::new();
    frontend::ssl_request(&mut buf);
    wire.write(&buf).await?;
    match wire.read_byte().await? {
        b'S' => wire.transport().start_tls(server_name).await,
        _ => Err(DbError::TlsFailed),
    }
}

/// Delivers a cancel request and waits until the server closed the cancel connection, which it
/// does after signalling the backend. Returns once the request has been handed over; whether the
/// statement stops is observed on the data connection.
pub(crate) async fn send(
    broker: &dyn ConnectionBroker,
    target_id: &str,
    tls: &PgTls,
    key: BackendKey,
) -> Result<(), DbError> {
    let deliver = async {
        let mut wire = Wire::new(broker.open(target_id, "cancel").await?);
        negotiate_tls(&mut wire, tls).await?;
        let mut buf = BytesMut::new();
        frontend::cancel_request(key.process_id, key.secret_key, &mut buf);
        wire.write(&buf).await?;
        // The server answers nothing and closes the connection; any end of it will do.
        let _ = wire.read().await;
        Ok(())
    };
    tokio::time::timeout(CANCEL_TIMEOUT, deliver)
        .await
        .unwrap_or(Err(DbError::Timeout))
}
