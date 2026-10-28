//! Schema, table and column introspection from `pg_catalog`.
//!
//! Names are always bound as parameters, never spliced into SQL. With `schema = None`, tables
//! and columns resolve like an unqualified name: through the session's `search_path`
//! (`pg_table_is_visible`). The table listing then leaves out `pg_catalog` and
//! `information_schema`, which are always on the path.

use std::sync::Arc;
use std::time::Duration;

use bytes::BytesMut;
use db_driver::{ColumnInfo, DbError, TableInfo};
use fallible_iterator::FallibleIterator;
use postgres_protocol::message::backend::Message;
use postgres_protocol::message::frontend;

use crate::AccessMode;
use crate::conn::{Shared, busy};
use crate::error::{Diagnostic, invalid_query};
use crate::stream::bind_text;

/// Bound on one introspection call; the contract gives these calls no deadline of their own.
const INTROSPECTION_TIMEOUT: Duration = Duration::from_secs(30);

/// Relation kinds listed as tables, and their names in [`TableInfo::kind`].
const RELKINDS: &str = "('r', 'p', 'v', 'm', 'f')";

fn kind_name(relkind: &str) -> &'static str {
    match relkind {
        "r" => "table",
        "p" => "partitioned table",
        "v" => "view",
        "m" => "materialized view",
        "f" => "foreign table",
        _ => "other",
    }
}

pub(crate) async fn schemas(shared: &Arc<Shared>) -> Result<Vec<String>, DbError> {
    let rows = query(
        shared,
        "SELECT nspname FROM pg_catalog.pg_namespace \
         WHERE nspname !~ '^pg_(toast|temp_|toast_temp_)' ORDER BY nspname",
        &[],
    )
    .await?;
    rows.into_iter().map(|mut r| text(&mut r, 0)).collect()
}

pub(crate) async fn tables(
    shared: &Arc<Shared>,
    schema: Option<&str>,
) -> Result<Vec<TableInfo>, DbError> {
    let base = format!(
        "SELECT n.nspname, c.relname, c.relkind::text \
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relkind IN {RELKINDS} AND "
    );
    let rows = match schema {
        Some(schema) => {
            let sql = base + "n.nspname = $1 ORDER BY c.relname";
            query(shared, &sql, &[schema]).await?
        }
        None => {
            let sql = base
                + "pg_catalog.pg_table_is_visible(c.oid) \
                   AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
                   ORDER BY n.nspname, c.relname";
            query(shared, &sql, &[]).await?
        }
    };
    rows.into_iter()
        .map(|mut r| {
            Ok(TableInfo {
                schema: Some(text(&mut r, 0)?),
                name: text(&mut r, 1)?,
                kind: kind_name(&text(&mut r, 2)?).to_owned(),
            })
        })
        .collect()
}

/// Columns in table order. A missing table is an error (`42P01`), not an empty list, because a
/// table can have no columns.
pub(crate) async fn columns(
    shared: &Arc<Shared>,
    schema: Option<&str>,
    table: &str,
) -> Result<Vec<ColumnInfo>, DbError> {
    let base = format!(
        "SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), \
                (NOT a.attnotnull)::text \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         LEFT JOIN pg_catalog.pg_attribute a \
                ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         WHERE c.relkind IN {RELKINDS} AND c.relname = $1 AND "
    );
    let rows = match schema {
        Some(schema) => {
            let sql = base + "n.nspname = $2 ORDER BY a.attnum";
            query(shared, &sql, &[table, schema]).await?
        }
        None => {
            let sql = base + "pg_catalog.pg_table_is_visible(c.oid) ORDER BY a.attnum";
            query(shared, &sql, &[table]).await?
        }
    };
    if rows.is_empty() {
        return Err(invalid_query("relation does not exist", "42P01"));
    }
    rows.into_iter()
        // The LEFT JOIN yields one all-null row for a table without columns.
        .filter(|r| r.first().is_some_and(Option::is_some))
        .map(|mut r| {
            Ok(ColumnInfo {
                name: text(&mut r, 0)?,
                type_name: text(&mut r, 1)?,
                nullable: text(&mut r, 2)? == "true",
            })
        })
        .collect()
}

fn text(row: &mut [Option<String>], i: usize) -> Result<String, DbError> {
    row.get_mut(i)
        .and_then(Option::take)
        .ok_or(DbError::ConnectionLost)
}

/// Runs one catalog query (text parameters and results) when no operation is live, inside a
/// rolled-back read-only transaction in read-only mode.
async fn query(
    shared: &Arc<Shared>,
    sql: &str,
    params: &[&str],
) -> Result<Vec<Vec<Option<String>>>, DbError> {
    if shared.is_busy() {
        return Err(busy());
    }
    let read_only = shared.access == AccessMode::ReadOnly;
    let mut session = tokio::time::timeout(INTROSPECTION_TIMEOUT, shared.acquire(None))
        .await
        .map_err(|_| DbError::Timeout)??;
    let work = async {
        session.settle(shared).await?;
        let mut buf = BytesMut::new();
        if read_only {
            frontend::query("BEGIN TRANSACTION READ ONLY", &mut buf)
                .map_err(|_| DbError::Internal)?;
        }
        frontend::parse("", sql, params.iter().map(|_| 25), &mut buf)
            .map_err(|_| DbError::Internal)?;
        bind_text(params, &mut buf)?;
        frontend::execute("", 0, &mut buf).map_err(|_| DbError::Internal)?;
        frontend::sync(&mut buf);
        session.send(&buf, 1 + usize::from(read_only)).await?;

        let mut rows = Vec::new();
        let mut error = None;
        while session.pending > 0 {
            match session.read().await? {
                Message::DataRow(row) => {
                    let mut values = Vec::new();
                    let mut ranges = row.ranges();
                    while let Some(range) = ranges.next().map_err(|_| DbError::ConnectionLost)? {
                        values.push(match range {
                            None => None,
                            Some(r) => Some(
                                String::from_utf8(row.buffer()[r].to_vec())
                                    .map_err(|_| DbError::ConnectionLost)?,
                            ),
                        });
                    }
                    rows.push(values);
                }
                Message::ErrorResponse(body) => {
                    error.get_or_insert(Diagnostic::parse(body.fields()).into_db_error());
                }
                Message::ReadyForQuery(body) => {
                    session.pending -= 1;
                    session.status = body.status();
                }
                _ => {}
            }
        }
        session.settle(shared).await?;
        error.map_or(Ok(rows), Err)
    };
    match tokio::time::timeout(INTROSPECTION_TIMEOUT, work).await {
        Ok(result) => result,
        Err(_) => {
            // The query is still marked in flight: cancel and drain it now.
            let _ = session.settle(shared).await;
            Err(DbError::Timeout)
        }
    }
}
