//! In-process harness: the engine on an in-memory transport pair ([`ambidex::transport::memory`]).
//!
//! No transport code at all, so it is the reference the other harnesses are compared with.

use std::sync::{Arc, Mutex};

use ambidex::engine::BoxFuture;
use ambidex::security_types::{Principal, PrincipalKind, SessionId, TenantId};
use ambidex::transport::{MemoryRx, MemoryTx, TransportRx, TransportTx, memory};
use ambidex::{Authenticate, CancellationToken, Connection, Hello, Router, Server, Session};

use crate::client::{Client, LocalBoxFuture, Wire};
use crate::fixture::{Fixture, server_config};
use crate::harness::{Harness, Unsupported};

/// Principal of every in-process session.
pub const PRINCIPAL_ID: &str = "human:test:alice";

/// Chunks in flight per direction of the in-memory pipe.
const PIPE_CHUNKS: usize = 16;

pub struct InProcess {
    fixture: Fixture,
    server: Server<TestAuth, Router>,
    revoke: Arc<Mutex<CancellationToken>>,
    connections: Mutex<Vec<Connection>>,
}

/// Accepts every Hello (ignoring `auth`) with a server-built principal; every session is revoked
/// when the harness's token fires.
pub struct TestAuth {
    revoke: Arc<Mutex<CancellationToken>>,
}

impl Authenticate for TestAuth {
    fn authenticate<'a>(&'a self, _hello: &'a Hello) -> BoxFuture<'a, Option<Session>> {
        Box::pin(async {
            Some(Session {
                id: "in-process-session".into(),
                principal: Principal {
                    kind: PrincipalKind::Human,
                    id: PRINCIPAL_ID.into(),
                    tenant: TenantId::new("t-1"),
                    on_behalf_of: None,
                    roles: vec![],
                    session: SessionId::new("in-process-session"),
                },
            })
        })
    }

    fn revocation(&self, _session: &Session) -> Option<CancellationToken> {
        Some(lock(&self.revoke).clone())
    }
}

impl Harness for InProcess {
    const NAME: &'static str = "in-process";

    async fn start(fixture: Fixture) -> InProcess {
        let revoke = Arc::new(Mutex::new(CancellationToken::new()));
        let auth = TestAuth {
            revoke: Arc::clone(&revoke),
        };
        let server = Server::new(server_config(), auth, fixture.router());
        InProcess {
            fixture,
            server,
            revoke,
            connections: Mutex::new(Vec::new()),
        }
    }

    fn fixture(&self) -> &Fixture {
        &self.fixture
    }

    async fn connect(&self) -> Client {
        let ((server_rx, server_tx), (client_rx, client_tx)) = memory(PIPE_CHUNKS);
        let connection = self.server.serve(server_rx, server_tx);
        lock(&self.connections).push(connection);
        Client::new(
            Box::new(MemoryWire {
                rx: client_rx,
                tx: client_tx,
            }),
            None,
        )
    }

    fn principal_id(&self) -> String {
        PRINCIPAL_ID.into()
    }

    fn revoke_sessions(&self) -> Result<(), Unsupported> {
        // Later sessions get a fresh token.
        let mut revoke = lock(&self.revoke);
        std::mem::take(&mut *revoke).cancel();
        Ok(())
    }

    async fn shutdown(self) {
        let connections = std::mem::take(&mut *lock(&self.connections));
        for connection in connections {
            connection
                .goaway(ambidex::Code::Unavailable, "shutdown")
                .await;
            connection.closed().await;
        }
    }
}

struct MemoryWire {
    rx: MemoryRx,
    tx: MemoryTx,
}

impl Wire for MemoryWire {
    fn send(&mut self, bytes: Vec<u8>) -> LocalBoxFuture<'_, std::io::Result<()>> {
        Box::pin(self.tx.send(bytes))
    }

    fn recv(&mut self) -> LocalBoxFuture<'_, Option<Vec<u8>>> {
        Box::pin(async { self.rx.recv().await.ok().flatten() })
    }

    fn close(&mut self) -> LocalBoxFuture<'_, ()> {
        Box::pin(async {
            let _ = self.tx.close().await;
        })
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}
