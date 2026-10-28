//! Connection state, startup/authentication and the operation registry.
//!
//! A PostgreSQL session runs one statement at a time, so a connection runs one operation at a
//! time; a second `execute` while a stream is live fails instead of queueing behind it.
//!
//! `CancelRequest` names the backend, not the statement, so a late request could stop the *next*
//! statement. Two rules prevent that: a cancel is sent only while its operation is on the wire,
//! under a read lock of `gate`; and an operation takes `gate` for writing before it sends
//! anything, so it starts only after every earlier cancel was delivered (the server has then
//! signalled the backend, and a signal that reaches an idle backend is discarded).

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::BytesMut;
use db_driver::{
    CancelOutcome, ColumnInfo, Connection, ConnectionBroker, DbError, DbFuture, ExecuteOptions,
    OperationId, ResultStream, TableInfo,
};
use fallible_iterator::FallibleIterator;
use postgres_protocol::authentication::md5_hash;
use postgres_protocol::authentication::sasl::{ChannelBinding, SCRAM_SHA_256, ScramSha256};
use postgres_protocol::message::backend::Message;
use postgres_protocol::message::frontend;
use tokio::sync::{OwnedMutexGuard, RwLock};
use zeroize::Zeroize;

use crate::cancel::{self, BackendKey};
use crate::error::Diagnostic;
use crate::wire::Wire;
use crate::{AccessMode, PgSettings, PgTls, introspect, stream};

/// How long an abandoned statement may take to wind down before the session is given up.
const SETTLE_LIMIT: Duration = Duration::from_secs(30);
/// Interval between repeated cancel requests while draining an abandoned statement; a request
/// that reached the backend between two messages is ignored by the server.
const RECANCEL_INTERVAL: Duration = Duration::from_secs(1);

pub(crate) struct Session {
    pub(crate) wire: Wire,
    /// `ReadyForQuery` messages the server still owes for work already sent.
    pub(crate) pending: usize,
    /// Transaction status of the last `ReadyForQuery`: `I`, `T` or `E`.
    pub(crate) status: u8,
    /// Work was sent and not seen to completion. Set by the operation that sends it and cleared
    /// when it completes; if that operation goes away, the next [`Session::settle`] cancels it.
    pub(crate) in_flight: bool,
    broken: bool,
}

impl Session {
    /// The next message. A transport or framing error leaves the session unusable.
    pub(crate) async fn read(&mut self) -> Result<Message, DbError> {
        let message = self.wire.read().await;
        if message.is_err() {
            self.broken = true;
        }
        message
    }

    pub(crate) async fn send(&mut self, buf: &[u8], syncs: usize) -> Result<(), DbError> {
        self.in_flight = true;
        self.pending += syncs;
        let sent = self.wire.write(buf).await;
        if sent.is_err() {
            self.broken = true;
        }
        sent
    }

    /// Bring the session back to idle: cancel and drain abandoned work, then, in read-only
    /// mode, roll back any open transaction. A session that cannot be settled is unusable.
    pub(crate) async fn settle(&mut self, shared: &Shared) -> Result<(), DbError> {
        if self.broken {
            return Err(DbError::ConnectionLost);
        }
        let settled = self.settle_inner(shared).await;
        if settled.is_err() {
            self.broken = true;
        }
        settled
    }

    async fn settle_inner(&mut self, shared: &Shared) -> Result<(), DbError> {
        let started = Instant::now();
        let mut cancelled_at: Option<Instant> = None;
        while self.pending > 0 {
            if self.in_flight && cancelled_at.is_none_or(|t| t.elapsed() >= RECANCEL_INTERVAL) {
                // Best effort: if the request cannot be delivered (for example the grant was
                // revoked) the drain below still ends the statement or gives up.
                let _ = shared.send_cancel().await;
                cancelled_at = Some(Instant::now());
            }
            let left = SETTLE_LIMIT
                .checked_sub(started.elapsed())
                .ok_or(DbError::ConnectionLost)?;
            if let Ok(message) =
                tokio::time::timeout(left.min(RECANCEL_INTERVAL), self.read()).await
            {
                self.absorb(message?).await?;
            }
        }
        self.in_flight = false;
        if shared.access == AccessMode::ReadOnly && self.status != b'I' {
            let mut buf = BytesMut::new();
            frontend::query("ROLLBACK", &mut buf).map_err(|_| DbError::Internal)?;
            self.send(&buf, 1).await?;
            while self.pending > 0 {
                let message = self.read().await?;
                self.absorb(message).await?;
            }
            self.in_flight = false;
        }
        Ok(())
    }

    /// Account for a message read while draining.
    async fn absorb(&mut self, message: Message) -> Result<(), DbError> {
        match message {
            Message::ReadyForQuery(body) => {
                self.pending = self.pending.saturating_sub(1);
                self.status = body.status();
            }
            Message::CopyInResponse(_) => self.copy_fail().await?,
            _ => {}
        }
        Ok(())
    }

    /// Refuse a `COPY ... FROM STDIN`: the contract has no input stream. The server ignored the
    /// `Sync` already sent while it was in copy-in mode, so a new one takes its place.
    pub(crate) async fn copy_fail(&mut self) -> Result<(), DbError> {
        let mut buf = BytesMut::new();
        frontend::copy_fail("COPY FROM STDIN is not supported", &mut buf)
            .map_err(|_| DbError::Internal)?;
        frontend::sync(&mut buf);
        self.wire.write(&buf).await
    }

    pub(crate) fn mark_broken(&mut self) {
        self.broken = true;
    }
}

#[derive(Default)]
struct Ops {
    /// Every operation ID ever used on this connection; IDs are never reused.
    used: HashSet<String>,
    current: Option<Current>,
}

struct Current {
    id: String,
    /// Statement bytes were sent; a cancel must reach the backend.
    on_wire: bool,
    /// Cancelled before it reached the wire; it stops before sending anything.
    cancelled: bool,
}

pub(crate) struct Shared {
    broker: Arc<dyn ConnectionBroker>,
    target_id: String,
    tls: PgTls,
    key: BackendKey,
    pub(crate) access: AccessMode,
    ops: Mutex<Ops>,
    gate: RwLock<()>,
    session: Arc<tokio::sync::Mutex<Session>>,
}

impl Shared {
    fn ops(&self) -> std::sync::MutexGuard<'_, Ops> {
        self.ops.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) async fn send_cancel(&self) -> Result<(), DbError> {
        cancel::send(&*self.broker, &self.target_id, &self.tls, self.key).await
    }

    /// Register a new operation. Fails if the ID was used before or another operation is live.
    pub(crate) fn begin(self: &Arc<Self>, id: &OperationId) -> Result<OpGuard, DbError> {
        let mut ops = self.ops();
        if ops.current.is_some() {
            return Err(busy());
        }
        if !ops.used.insert(id.0.clone()) {
            return Err(DbError::Unsupported(
                "operation ID was already used on this connection".into(),
            ));
        }
        ops.current = Some(Current {
            id: id.0.clone(),
            on_wire: false,
            cancelled: false,
        });
        Ok(OpGuard {
            shared: self.clone(),
            id: id.0.clone(),
            done: false,
        })
    }

    /// The session, once every earlier cancel request was delivered. With `id`, the operation is
    /// moved on the wire, unless it was cancelled while queued.
    pub(crate) async fn acquire(
        &self,
        id: Option<&str>,
    ) -> Result<OwnedMutexGuard<Session>, DbError> {
        let session = self.session.clone().lock_owned().await;
        drop(self.gate.write().await);
        if let Some(id) = id {
            let mut ops = self.ops();
            match ops.current.as_mut() {
                Some(c) if c.id == id && !c.cancelled => c.on_wire = true,
                _ => return Err(DbError::Cancelled),
            }
        }
        Ok(session)
    }

    pub(crate) fn is_busy(&self) -> bool {
        self.ops().current.is_some()
    }

    async fn cancel(&self, id: &str) -> Result<CancelOutcome, DbError> {
        let _gate = self.gate.read().await;
        let on_wire = {
            let mut ops = self.ops();
            match ops.current.as_mut() {
                Some(c) if c.id == id => {
                    c.cancelled = true;
                    c.on_wire
                }
                _ => return Ok(CancelOutcome::NotRunning),
            }
        };
        if on_wire {
            self.send_cancel().await?;
        }
        Ok(CancelOutcome::Requested)
    }

    fn finish(&self, id: &str) {
        let mut ops = self.ops();
        if ops.current.as_ref().is_some_and(|c| c.id == id) {
            ops.current = None;
        }
    }
}

pub(crate) fn busy() -> DbError {
    DbError::Unsupported("connection is busy with another operation".into())
}

/// The live operation. Finishing (or dropping) it makes its ID terminal: cancel reports
/// `NotRunning` from then on.
pub(crate) struct OpGuard {
    shared: Arc<Shared>,
    id: String,
    done: bool,
}

impl OpGuard {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    pub(crate) fn shared(&self) -> &Arc<Shared> {
        &self.shared
    }

    pub(crate) fn finish(&mut self) {
        if !self.done {
            self.done = true;
            self.shared.finish(&self.id);
        }
    }

    pub(crate) async fn cancel(&self) -> Result<CancelOutcome, DbError> {
        if self.done {
            return Ok(CancelOutcome::NotRunning);
        }
        self.shared.cancel(&self.id).await
    }
}

impl Drop for OpGuard {
    fn drop(&mut self) {
        self.finish();
    }
}

pub(crate) struct PgConnection {
    shared: Arc<Shared>,
}

impl PgConnection {
    pub(crate) async fn connect(
        broker: Arc<dyn ConnectionBroker>,
        target_id: &str,
        settings: PgSettings,
    ) -> Result<Self, DbError> {
        let open = async {
            let mut wire = Wire::new(broker.open(target_id, "data").await?);
            cancel::negotiate_tls(&mut wire, &settings.tls).await?;
            let key = startup(&mut wire, &settings).await?;
            Ok::<_, DbError>((wire, key))
        };
        let (wire, key) = tokio::time::timeout(settings.connect_timeout, open)
            .await
            .map_err(|_| DbError::Timeout)??;
        let session = Session {
            wire,
            pending: 0,
            status: b'I',
            in_flight: false,
            broken: false,
        };
        Ok(Self {
            shared: Arc::new(Shared {
                broker,
                target_id: target_id.to_owned(),
                tls: settings.tls,
                key,
                access: settings.access,
                ops: Mutex::default(),
                gate: RwLock::new(()),
                session: Arc::new(tokio::sync::Mutex::new(session)),
            }),
        })
    }
}

impl Connection for PgConnection {
    fn execute<'a>(
        &'a self,
        operation_id: &'a OperationId,
        sql: &'a str,
        opts: ExecuteOptions,
    ) -> DbFuture<'a, Box<dyn ResultStream>> {
        Box::pin(stream::execute(
            self.shared.clone(),
            operation_id,
            sql,
            opts,
        ))
    }

    fn cancel<'a>(&'a self, operation_id: &'a OperationId) -> DbFuture<'a, CancelOutcome> {
        Box::pin(self.shared.cancel(&operation_id.0))
    }

    fn schemas(&self) -> DbFuture<'_, Vec<String>> {
        Box::pin(introspect::schemas(&self.shared))
    }

    fn tables<'a>(&'a self, schema: Option<&'a str>) -> DbFuture<'a, Vec<TableInfo>> {
        Box::pin(introspect::tables(&self.shared, schema))
    }

    fn columns<'a>(
        &'a self,
        schema: Option<&'a str>,
        table: &'a str,
    ) -> DbFuture<'a, Vec<ColumnInfo>> {
        Box::pin(introspect::columns(&self.shared, schema, table))
    }
}

/// Startup and authentication. Returns the backend's cancellation key once the server is ready.
async fn startup(wire: &mut Wire, settings: &PgSettings) -> Result<BackendKey, DbError> {
    let mut params = vec![
        ("user", settings.user.as_str()),
        ("database", settings.database.as_str()),
        ("application_name", settings.application_name.as_str()),
        ("client_encoding", "UTF8"),
    ];
    if settings.access == AccessMode::ReadOnly {
        params.push(("default_transaction_read_only", "on"));
    }
    let mut buf = BytesMut::new();
    frontend::startup_message(params, &mut buf)
        .map_err(|_| DbError::Unsupported("invalid connection settings".into()))?;
    wire.write(&buf).await?;

    authenticate(wire, settings).await?;

    let mut key = None;
    loop {
        match wire.read().await? {
            Message::BackendKeyData(body) => {
                key = Some(BackendKey {
                    process_id: body.process_id(),
                    secret_key: body.secret_key(),
                });
            }
            Message::ParameterStatus(body) => {
                let name = body.name().map_err(|_| DbError::ConnectionLost)?;
                let value = body.value().map_err(|_| DbError::ConnectionLost)?;
                if name == "client_encoding" && !value.eq_ignore_ascii_case("UTF8") {
                    return Err(DbError::Unsupported("client encoding is not UTF8".into()));
                }
            }
            Message::NoticeResponse(_) => {}
            Message::ErrorResponse(body) => return Err(startup_error(&body)),
            Message::ReadyForQuery(_) => break,
            _ => return Err(DbError::ConnectionLost),
        }
    }
    // Without the key, queries could not be cancelled on the server.
    key.ok_or_else(|| DbError::Unsupported("server sent no cancellation key".into()))
}

async fn authenticate(wire: &mut Wire, settings: &PgSettings) -> Result<(), DbError> {
    let password = || {
        settings
            .password
            .as_ref()
            .ok_or(DbError::AuthenticationFailed)
    };
    let mut scram: Option<ScramSha256> = None;
    let mut scram_verified = false;
    loop {
        let mut buf = BytesMut::new();
        match wire.read().await? {
            Message::AuthenticationOk => {
                // A server that skips the final SCRAM message has not proven it knows the
                // password; do not accept it.
                if scram.is_some() && !scram_verified {
                    return Err(DbError::AuthenticationFailed);
                }
                return Ok(());
            }
            Message::AuthenticationCleartextPassword => {
                frontend::password_message(password()?.as_bytes(), &mut buf)
                    .map_err(|_| DbError::AuthenticationFailed)?;
            }
            Message::AuthenticationMd5Password(body) => {
                let mut hash = md5_hash(
                    settings.user.as_bytes(),
                    password()?.as_bytes(),
                    body.salt(),
                );
                let encoded = frontend::password_message(hash.as_bytes(), &mut buf);
                hash.zeroize();
                encoded.map_err(|_| DbError::AuthenticationFailed)?;
            }
            Message::AuthenticationSasl(body) => {
                let mut offered = false;
                let mut mechanisms = body.mechanisms();
                while let Some(m) = mechanisms.next().map_err(|_| DbError::ConnectionLost)? {
                    offered |= m == SCRAM_SHA_256;
                }
                if !offered || scram.is_some() {
                    return Err(DbError::Unsupported("SASL mechanism".into()));
                }
                // The broker terminates TLS, so channel binding to the server certificate is
                // not available to the driver.
                let s = ScramSha256::new(password()?.as_bytes(), ChannelBinding::unsupported());
                frontend::sasl_initial_response(SCRAM_SHA_256, s.message(), &mut buf)
                    .map_err(|_| DbError::AuthenticationFailed)?;
                scram = Some(s);
            }
            Message::AuthenticationSaslContinue(body) => {
                let s = scram.as_mut().ok_or(DbError::AuthenticationFailed)?;
                s.update(body.data())
                    .map_err(|_| DbError::AuthenticationFailed)?;
                frontend::sasl_response(s.message(), &mut buf)
                    .map_err(|_| DbError::AuthenticationFailed)?;
            }
            Message::AuthenticationSaslFinal(body) => {
                let s = scram.as_mut().ok_or(DbError::AuthenticationFailed)?;
                // Verifies the server signature: the server must know the password too.
                s.finish(body.data())
                    .map_err(|_| DbError::AuthenticationFailed)?;
                scram_verified = true;
                continue;
            }
            Message::ErrorResponse(body) => return Err(startup_error(&body)),
            Message::NoticeResponse(_) => continue,
            Message::AuthenticationGss
            | Message::AuthenticationGssContinue(_)
            | Message::AuthenticationKerberosV5
            | Message::AuthenticationScmCredential
            | Message::AuthenticationSspi => {
                return Err(DbError::Unsupported("authentication method".into()));
            }
            _ => return Err(DbError::ConnectionLost),
        }
        let sent = wire.write(&buf).await;
        buf.as_mut().zeroize();
        sent?;
    }
}

/// Errors before the session is ready. Authentication failures carry no server message.
fn startup_error(body: &postgres_protocol::message::backend::ErrorResponseBody) -> DbError {
    let diagnostic = Diagnostic::parse(body.fields());
    if diagnostic.sqlstate.starts_with("28") {
        return DbError::AuthenticationFailed;
    }
    diagnostic.into_db_error()
}
