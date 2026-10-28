//! The broker behind the db-driver contract (`db_driver::ConnectionBroker`).
//!
//! Native drivers receive a [`ContractBroker`] instead of a [`BrokerScope`]. It adds no policy of
//! its own: every `open`, `send`, `recv` and `start_tls` goes through the scope, so grants, address
//! checks, TLS verification, audit, limits and revocation apply exactly as for direct broker use.

use std::sync::Arc;

use db_driver::{DbError, DbFuture};
use tokio::sync::Mutex;

use crate::broker::{BrokerError, BrokerScope, Transport};
use crate::net::{Resolver, SystemResolver};

/// A [`BrokerScope`] seen through the db-driver contract.
pub struct ContractBroker<R: Resolver = SystemResolver> {
    scope: Arc<BrokerScope<R>>,
}

impl<R: Resolver> ContractBroker<R> {
    pub fn new(scope: BrokerScope<R>) -> Self {
        Self {
            scope: Arc::new(scope),
        }
    }

    pub fn scope(&self) -> &BrokerScope<R> {
        &self.scope
    }
}

impl<R: Resolver> db_driver::ConnectionBroker for ContractBroker<R> {
    fn open<'a>(
        &'a self,
        target_id: &'a str,
        purpose: &'a str,
    ) -> DbFuture<'a, Box<dyn db_driver::Transport>> {
        Box::pin(async move {
            let io = self
                .scope
                .open(target_id, purpose)
                .await
                .map_err(db_error)?;
            Ok(Box::new(ContractTransport {
                scope: self.scope.clone(),
                io: Mutex::new(io),
            }) as Box<dyn db_driver::Transport>)
        })
    }
}

/// A brokered transport. Calls are serialized; the scope checks ownership on each one.
struct ContractTransport<R: Resolver> {
    scope: Arc<BrokerScope<R>>,
    io: Mutex<Transport>,
}

impl<R: Resolver> db_driver::Transport for ContractTransport<R> {
    fn send<'a>(&'a self, bytes: &'a [u8]) -> DbFuture<'a, u32> {
        Box::pin(async move {
            // The contract counts in u32; send at most that much and report it as a partial send.
            let bytes = &bytes[..bytes.len().min(u32::MAX as usize)];
            let mut io = self.io.lock().await;
            let sent = self.scope.send(&mut io, bytes).await.map_err(db_error)?;
            Ok(u32::try_from(sent).unwrap_or(u32::MAX))
        })
    }

    fn recv(&self, max_bytes: u32) -> DbFuture<'_, Vec<u8>> {
        Box::pin(async move {
            let mut io = self.io.lock().await;
            self.scope
                .recv(&mut io, max_bytes as usize)
                .await
                .map_err(db_error)
        })
    }

    fn start_tls<'a>(&'a self, server_name: &'a str) -> DbFuture<'a, ()> {
        Box::pin(async move {
            let mut io = self.io.lock().await;
            self.scope
                .start_tls(&mut io, server_name)
                .await
                .map_err(db_error)
        })
    }
}

/// The contract error for a broker error. The contract has no resource-limit variant, so a
/// reached transport limit is reported as `Unsupported` with a fixed message.
pub fn db_error(e: BrokerError) -> DbError {
    match e {
        BrokerError::PermissionDenied => DbError::PermissionDenied,
        BrokerError::TlsFailed => DbError::TlsFailed,
        BrokerError::ConnectionLost => DbError::ConnectionLost,
        BrokerError::Timeout => DbError::Timeout,
        BrokerError::Unsupported(what) => DbError::Unsupported(what.to_owned()),
        BrokerError::LimitExceeded => DbError::Unsupported("broker transport limit reached".into()),
        BrokerError::Internal => DbError::Internal,
    }
}
