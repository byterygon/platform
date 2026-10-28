//! `execute` and the result stream.
//!
//! Round trip 1: `Parse` + `Describe` (after `BEGIN TRANSACTION READ ONLY` in read-only mode)
//! gives the result columns, which pick binary or text per column. Round trip 2: `Bind` +
//! `Execute` + `Sync`, whose rows are read only when the caller polls: nothing is buffered
//! beyond one batch, and TCP flow control holds the server back meanwhile.
//!
//! `max_rows` becomes the `Execute` row limit plus one, so the server stops early and the extra
//! row tells a truncated result from one that is exactly `max_rows` long.

use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::{BufMut, BytesMut};
use db_driver::{
    CancelOutcome, DbError, DbFuture, ExecuteOptions, NextItem, OperationId, QuerySummary,
    ResultStream,
};
use fallible_iterator::FallibleIterator;
use postgres_protocol::IsNull;
use postgres_protocol::message::backend::Message;
use postgres_protocol::message::frontend;
use tokio::sync::OwnedMutexGuard;

use crate::AccessMode;
use crate::batch::{BatchBuilder, Columns, DEFAULT_BATCH_ROWS, IpcStream, MAX_BATCH_BYTES};
use crate::conn::{OpGuard, Session, Shared};
use crate::error::{Diagnostic, invalid_query};

/// Notices kept per statement; later ones are dropped.
const MAX_NOTICES: usize = 64;

pub(crate) async fn execute(
    shared: Arc<Shared>,
    id: &OperationId,
    sql: &str,
    opts: ExecuteOptions,
) -> Result<Box<dyn ResultStream>, DbError> {
    if opts.batch_size_hint == Some(0) {
        return Err(DbError::Unsupported(
            "batch_size_hint must be positive".into(),
        ));
    }
    let admitted = Instant::now();
    let deadline = opts
        .deadline_ms
        .and_then(|ms| admitted.checked_add(Duration::from_millis(ms)));
    let op = shared.begin(id, deadline)?;
    if opts.deadline_ms == Some(0) {
        return Err(DbError::Timeout);
    }
    let acquire = shared.acquire(Some(op.id()));
    let session = match deadline {
        Some(d) => tokio::time::timeout_at(d.into(), acquire)
            .await
            .map_err(|_| DbError::Timeout)??,
        None => acquire.await?,
    };
    let mut stream = PgStream {
        op,
        session: Some(session),
        state: State::Schema,
        admitted,
        deadline,
        max_rows: opts.max_rows,
        batch_rows: opts
            .batch_size_hint
            .map_or(DEFAULT_BATCH_ROWS, |n| n as usize),
        columns: Columns::none(),
        batch: None,
        ipc: None,
        rows_returned: 0,
        truncated: false,
        tag: None,
        error: None,
        notices: Vec::new(),
    };
    match stream.start(sql).await {
        Ok(()) => Ok(Box::new(stream)),
        Err(halt) => Err(stream.halt(halt).await),
    }
}

/// Why reading stopped.
enum Halt {
    Db(DbError),
    Deadline,
}

impl From<DbError> for Halt {
    fn from(e: DbError) -> Self {
        Halt::Db(e)
    }
}

enum State {
    /// The schema message is next.
    Schema,
    Rows,
    Finished(QuerySummary),
    Done,
}

struct PgStream {
    op: OpGuard,
    /// Held until the statement ends; released before the terminal outcome is returned.
    session: Option<OwnedMutexGuard<Session>>,
    state: State,
    admitted: Instant,
    deadline: Option<Instant>,
    max_rows: Option<u64>,
    batch_rows: usize,
    columns: Columns,
    batch: Option<BatchBuilder>,
    ipc: Option<IpcStream>,
    rows_returned: u64,
    truncated: bool,
    tag: Option<String>,
    /// The statement failed; the rest of its messages are read and discarded.
    error: Option<DbError>,
    notices: Vec<String>,
}

impl PgStream {
    fn session(&mut self) -> Result<&mut Session, DbError> {
        self.session.as_deref_mut().ok_or(DbError::Internal)
    }

    fn check_cancelled(&self) -> Result<(), Halt> {
        if self.deadline.is_some_and(|d| Instant::now() >= d) {
            return Err(Halt::Deadline);
        }
        Ok(self.op.check_cancelled()?)
    }

    /// The next message, unless the deadline passes first.
    async fn read(&mut self) -> Result<Message, Halt> {
        let deadline = self.deadline;
        let session = self.session()?;
        let message = match deadline {
            Some(d) if Instant::now() >= d => return Err(Halt::Deadline),
            Some(d) => tokio::time::timeout_at(d.into(), session.read())
                .await
                .map_err(|_| Halt::Deadline)?,
            None => session.read().await,
        };
        Ok(message?)
    }

    async fn start(&mut self, sql: &str) -> Result<(), Halt> {
        let read_only = self.op.shared().access == AccessMode::ReadOnly;
        let shared = self.op.shared().clone();
        self.session()?.settle(&shared).await?;
        self.check_cancelled()?;

        let mut buf = BytesMut::new();
        if read_only {
            frontend::query("BEGIN TRANSACTION READ ONLY", &mut buf)
                .map_err(|_| DbError::Internal)?;
        }
        frontend::parse("", sql, None::<u32>, &mut buf)
            .map_err(|_| invalid_query("query contains a NUL character", "22021"))?;
        frontend::describe(b'S', "", &mut buf).map_err(|_| DbError::Internal)?;
        frontend::sync(&mut buf);
        self.session()?
            .send(&buf, 1 + usize::from(read_only))
            .await?;

        let mut params = 0;
        let mut columns = None;
        while self.session()?.pending > 0 {
            match self.read().await? {
                Message::ParameterDescription(body) => {
                    params = body
                        .parameters()
                        .count()
                        .map_err(|_| DbError::ConnectionLost)?;
                }
                Message::RowDescription(body) => columns = Some(Columns::describe(&body)?),
                Message::NoData => columns = Some(Columns::none()),
                other => self.absorb(other).await?,
            }
        }
        if let Some(error) = self.error.take() {
            return Err(error.into());
        }
        if params > 0 {
            return Err(invalid_query("statement parameters are not supported", "42P02").into());
        }
        self.columns = columns.ok_or(DbError::ConnectionLost)?;
        self.batch = Some(BatchBuilder::new(&self.columns));

        // Ask for one row more than allowed: its arrival means the result was truncated.
        let limit = self
            .max_rows
            .and_then(|m| m.checked_add(1))
            .and_then(|m| i32::try_from(m).ok())
            .unwrap_or(0);
        buf.clear();
        frontend::bind(
            "",
            "",
            std::iter::empty::<i16>(),
            std::iter::empty::<()>(),
            |(), _| Ok(IsNull::No),
            self.columns.formats(),
            &mut buf,
        )
        .map_err(|_| DbError::Internal)?;
        frontend::execute("", limit, &mut buf).map_err(|_| DbError::Internal)?;
        frontend::sync(&mut buf);
        self.check_cancelled()?;
        self.session()?.send(&buf, 1).await?;
        Ok(())
    }

    /// Messages that can arrive in any phase.
    async fn absorb(&mut self, message: Message) -> Result<(), DbError> {
        match message {
            Message::ReadyForQuery(body) => {
                let session = self.session()?;
                session.pending = session.pending.saturating_sub(1);
                session.status = body.status();
            }
            Message::ErrorResponse(body) => {
                let error = Diagnostic::parse(body.fields()).into_db_error();
                self.error.get_or_insert(error);
            }
            Message::NoticeResponse(body) => {
                if self.notices.len() < MAX_NOTICES {
                    self.notices.push(Diagnostic::parse(body.fields()).notice());
                }
            }
            Message::CommandComplete(body) => {
                self.tag = body.tag().ok().map(str::to_owned);
            }
            Message::CopyInResponse(_) => {
                self.session()?.copy_fail().await?;
                self.error
                    .get_or_insert(DbError::Unsupported("COPY is not supported".into()));
            }
            Message::CopyOutResponse(_) => {
                self.error
                    .get_or_insert(DbError::Unsupported("COPY is not supported".into()));
            }
            Message::ParseComplete
            | Message::BindComplete
            | Message::PortalSuspended
            | Message::EmptyQueryResponse
            | Message::CopyData(_)
            | Message::CopyDone
            | Message::ParameterStatus(_)
            | Message::NotificationResponse(_) => {}
            _ => {
                self.session()?.mark_broken();
                return Err(DbError::ConnectionLost);
            }
        }
        Ok(())
    }

    async fn next_item(&mut self) -> Result<Option<NextItem>, Halt> {
        match std::mem::replace(&mut self.state, State::Done) {
            State::Done => return Ok(None),
            State::Finished(summary) => return Ok(Some(NextItem::Finished(summary))),
            State::Schema => {
                if self.deadline.is_some_and(|d| Instant::now() >= d) {
                    return Err(Halt::Deadline);
                }
                let mut ipc = IpcStream::new(self.columns.schema())?;
                let schema = ipc.take();
                self.ipc = Some(ipc);
                self.state = State::Rows;
                return Ok(Some(NextItem::Chunk(schema)));
            }
            State::Rows => self.state = State::Rows,
        }
        loop {
            match self.read().await? {
                Message::DataRow(row) => {
                    if self.error.is_some() {
                        continue;
                    }
                    if self.max_rows.is_some_and(|m| self.rows_returned >= m) {
                        self.truncated = true;
                        continue;
                    }
                    let batch = self.batch.as_mut().ok_or(DbError::Internal)?;
                    if let Err(e) = batch.append(&row) {
                        self.session()?.mark_broken();
                        return Err(e.into());
                    }
                    self.rows_returned += 1;
                    if batch.rows() >= self.batch_rows || batch.bytes() >= MAX_BATCH_BYTES {
                        return Ok(Some(NextItem::Chunk(self.flush(false)?)));
                    }
                }
                other => {
                    self.absorb(other).await?;
                    if self.session()?.pending == 0 {
                        return self.complete().await.map(Some);
                    }
                }
            }
        }
    }

    /// The statement and its `Sync` are done: settle the session, then emit the last rows and
    /// the end-of-stream marker; the summary follows on the next poll.
    async fn complete(&mut self) -> Result<NextItem, Halt> {
        if let Some(error) = self.error.take() {
            return Err(error.into());
        }
        let shared = self.op.shared().clone();
        self.session()?.settle(&shared).await?;
        self.session = None;
        self.op.finish();
        let chunk = self.flush(true)?;
        let has_rows = self.columns.has_rows();
        self.state = State::Finished(QuerySummary {
            rows_affected: self.tag.as_deref().and_then(|t| rows_affected(t, has_rows)),
            rows_returned: has_rows.then_some(self.rows_returned),
            elapsed_ms: u64::try_from(self.admitted.elapsed().as_millis()).unwrap_or(u64::MAX),
            notices: std::mem::take(&mut self.notices),
            truncated: self.truncated,
        });
        Ok(NextItem::Chunk(chunk))
    }

    /// The buffered rows as IPC messages; with `last`, followed by the end-of-stream marker.
    fn flush(&mut self, last: bool) -> Result<Vec<u8>, DbError> {
        let (Some(batch), Some(ipc)) = (self.batch.as_mut(), self.ipc.as_mut()) else {
            return Err(DbError::Internal);
        };
        if batch.rows() > 0 {
            ipc.write(&batch.finish()?)?;
        }
        if last {
            ipc.finish()?;
        }
        Ok(ipc.take())
    }

    /// Ends the operation with an error: cancel and drain what is still running, roll back in
    /// read-only mode, release the session.
    async fn halt(&mut self, halt: Halt) -> DbError {
        let error = match halt {
            Halt::Db(e) => e,
            Halt::Deadline => DbError::Timeout,
        };
        if let Some(mut session) = self.session.take() {
            let _ = session.settle(self.op.shared()).await;
        }
        self.op.finish();
        self.state = State::Done;
        error
    }
}

impl ResultStream for PgStream {
    fn next(&mut self) -> DbFuture<'_, Option<NextItem>> {
        Box::pin(async move {
            match self.next_item().await {
                Ok(item) => Ok(item),
                Err(halt) => Err(self.halt(halt).await),
            }
        })
    }

    fn cancel(&self) -> DbFuture<'_, CancelOutcome> {
        Box::pin(self.op.cancel())
    }
}

impl Drop for PgStream {
    /// An unfinished statement is cancelled and drained in the background, or, without a Tokio
    /// runtime, by the next operation on the connection.
    fn drop(&mut self) {
        self.op.finish();
        if let Some(mut session) = self.session.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let shared = self.op.shared().clone();
            runtime.spawn(async move {
                let _ = session.settle(&shared).await;
            });
        }
    }
}

/// Rows written by the statement, from its command tag (`INSERT 0 5`, `UPDATE 3`, ...).
/// `SELECT n` counts written rows only when there is no result set (`CREATE TABLE AS`).
fn rows_affected(tag: &str, has_rows: bool) -> Option<u64> {
    let mut words = tag.split_ascii_whitespace();
    let command = words.next()?;
    let count = words.next_back()?.parse().ok()?;
    match command {
        "INSERT" | "UPDATE" | "DELETE" | "MERGE" | "COPY" => Some(count),
        "SELECT" if !has_rows => Some(count),
        _ => None,
    }
}

/// Text-format parameters for the driver's own catalog queries.
pub(crate) fn bind_text(params: &[&str], buf: &mut BytesMut) -> Result<(), DbError> {
    frontend::bind(
        "",
        "",
        [0i16],
        params.iter().copied(),
        |v: &str, buf: &mut BytesMut| {
            buf.put_slice(v.as_bytes());
            Ok(IsNull::No)
        },
        [0i16],
        buf,
    )
    .map_err(|_| DbError::Internal)
}

#[cfg(test)]
mod tests {
    use super::rows_affected;

    #[test]
    fn command_tags() {
        assert_eq!(rows_affected("INSERT 0 5", false), Some(5));
        assert_eq!(rows_affected("UPDATE 3", true), Some(3));
        assert_eq!(rows_affected("DELETE 0", false), Some(0));
        assert_eq!(rows_affected("MERGE 2", false), Some(2));
        assert_eq!(rows_affected("SELECT 7", true), None);
        assert_eq!(rows_affected("SELECT 7", false), Some(7));
        assert_eq!(rows_affected("CREATE TABLE", false), None);
        assert_eq!(rows_affected("BEGIN", false), None);
    }
}
