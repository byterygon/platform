//! The native PostgreSQL driver against a real server, through the real Plugin Host broker and
//! connection grants (TSK-15; Plugin Host spec §8 acceptance tests).

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use arrow_array::cast::AsArray;
use arrow_array::types::{
    Date32Type, Float32Type, Float64Type, Int16Type, Int32Type, Int64Type, Time64MicrosecondType,
    TimestampMicrosecondType, UInt32Type,
};
use arrow_array::{Array, RecordBatch};
use arrow_schema::{DataType, TimeUnit};
use db_driver::conformance;
use db_driver::{
    CancelOutcome, ColumnInfo, Connection, DbError, Driver, ExecuteOptions, NextItem, QueryError,
    TableInfo,
};
use db_driver_postgres::{PostgresDriver, TYPE_OID_METADATA};
use plugin_host::{BrokerConfig, BrokerLimits};
use security_types::Outcome;
use support::*;

fn opts() -> ExecuteOptions {
    ExecuteOptions::default()
}

fn rows(batches: &[RecordBatch]) -> usize {
    batches.iter().map(RecordBatch::num_rows).sum()
}

fn sqlstate(error: &DbError) -> Option<&str> {
    match error {
        DbError::InvalidQuery(e) | DbError::DatabaseError(e) => e.sqlstate.as_deref(),
        _ => None,
    }
}

async fn app(cluster: &Cluster) -> (Env, Box<dyn Connection>) {
    let env = Env::new(cluster, Grant::plain()).await;
    let conn = env.connect(alice(), login(APP)).await.unwrap();
    (env, conn)
}

/// One `int4` value from a single-row query.
async fn scalar(conn: &dyn Connection, id: &str, sql: &str) -> i32 {
    let (_, batches, _) = query(conn, id, sql, opts()).await;
    batches[0].column(0).as_primitive::<Int32Type>().value(0)
}

async fn text(conn: &dyn Connection, id: &str, sql: &str) -> String {
    let (_, batches, _) = query(conn, id, sql, opts()).await;
    batches[0].column(0).as_string::<i32>().value(0).to_owned()
}

// ---------------------------------------------------------------------------------------------
// Arrow results
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rows_stream_as_arrow_with_types_nulls_and_binary() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let (schema, batches, summary) = query(
        &*conn,
        "q1",
        "SELECT * FROM public.items ORDER BY id",
        opts(),
    )
    .await;
    assert_eq!(summary.rows_returned, Some(3));
    assert_eq!(summary.rows_affected, None);
    assert!(!summary.truncated);

    let expected = [
        ("id", DataType::Int32, "23"),
        ("flag", DataType::Boolean, "16"),
        ("small", DataType::Int16, "21"),
        ("big", DataType::Int64, "20"),
        ("f4", DataType::Float32, "700"),
        ("ratio", DataType::Float64, "701"),
        ("name", DataType::Utf8, "25"),
        ("note", DataType::Utf8, "1043"),
        ("price", DataType::Utf8, "1700"),
        ("data", DataType::Binary, "17"),
        ("uid", DataType::FixedSizeBinary(16), "2950"),
        ("day", DataType::Date32, "1082"),
        ("at", DataType::Time64(TimeUnit::Microsecond), "1083"),
        (
            "local",
            DataType::Timestamp(TimeUnit::Microsecond, None),
            "1114",
        ),
        (
            "created",
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
            "1184",
        ),
        ("js", DataType::Utf8, "3802"),
        ("tags", DataType::Utf8, "1009"),
        ("o", DataType::UInt32, "26"),
    ];
    assert_eq!(schema.fields().len(), expected.len());
    for (field, (name, ty, oid)) in schema.fields().iter().zip(expected) {
        assert_eq!(field.name(), name);
        assert_eq!(field.data_type(), &ty, "{name}");
        assert!(field.is_nullable());
        assert_eq!(field.metadata()[TYPE_OID_METADATA], oid, "{name}");
    }
    assert_eq!(
        schema.field_with_name("uid").unwrap().metadata()["ARROW:extension:name"],
        "arrow.uuid"
    );

    assert_eq!(batches.len(), 1);
    let b = &batches[0];
    let col = |n: &str| b.column(schema.index_of(n).unwrap()).clone();
    assert_eq!(col("id").as_primitive::<Int32Type>().values(), &[1, 2, 3]);
    let flag = col("flag");
    let flag = flag.as_boolean();
    assert!(flag.value(0) && flag.is_null(1) && !flag.value(2));
    assert_eq!(col("small").as_primitive::<Int16Type>().value(2), -1);
    assert_eq!(
        col("big").as_primitive::<Int64Type>().value(0),
        9_000_000_000
    );
    assert_eq!(col("f4").as_primitive::<Float32Type>().value(0), 1.5);
    assert!(col("f4").as_primitive::<Float32Type>().value(2).is_nan());
    assert_eq!(
        col("ratio").as_primitive::<Float64Type>().value(2),
        f64::NEG_INFINITY
    );
    let name = col("name");
    let name = name.as_string::<i32>();
    assert_eq!(name.value(0), "zażółć");
    assert_eq!(name.value(2), "");
    assert_eq!(col("note").as_string::<i32>().value(0), "n");
    // numeric is text, so no digit is lost.
    assert_eq!(col("price").as_string::<i32>().value(0), "12.50");
    assert_eq!(col("price").as_string::<i32>().value(2), "-0.01");
    let data = col("data");
    let data = data.as_binary::<i32>();
    assert_eq!(data.value(0), [0x00, 0xff, 0x10]);
    assert!(data.is_null(1));
    assert_eq!(data.value(2), b"");
    let uid = col("uid");
    let uid = uid.as_fixed_size_binary();
    assert_eq!(
        uid.value(0),
        [
            0xa0, 0xee, 0xbc, 0x99, 0x9c, 0x0b, 0x4e, 0xf8, 0xbb, 0x6d, 0x6b, 0xb9, 0xbd, 0x38,
            0x0a, 0x11
        ]
    );
    assert!(uid.is_null(2));
    let day = col("day");
    let day = day.as_primitive::<Date32Type>();
    assert_eq!(day.value(0), 19_782); // 2024-02-29
    assert_eq!(day.value(2), i32::MAX); // 'infinity'
    assert_eq!(
        col("at").as_primitive::<Time64MicrosecondType>().value(0),
        (13 * 3600 + 14 * 60 + 15) * 1_000_000 + 500_000
    );
    let local = col("local");
    let local = local.as_primitive::<TimestampMicrosecondType>();
    assert_eq!(local.value(0), 1_709_212_455_123_456);
    assert_eq!(local.value(2), i64::MIN); // '-infinity'
    // 13:14:15.123456+02 is 11:14:15.123456 UTC.
    assert_eq!(
        col("created")
            .as_primitive::<TimestampMicrosecondType>()
            .value(0),
        1_709_205_255_123_456
    );
    assert_eq!(col("js").as_string::<i32>().value(0), r#"{"k": [1, 2]}"#);
    assert_eq!(col("tags").as_string::<i32>().value(0), "{a,b}");
    assert_eq!(col("o").as_primitive::<UInt32Type>().value(0), 42);
    for c in b.columns().iter().skip(1) {
        if c.data_type() != &DataType::Utf8 {
            assert!(c.is_null(1), "row 2 is null in every nullable column");
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn schema_comes_first_even_without_rows() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let drained = run(
        &*conn,
        "q1",
        "SELECT 1 AS a, 'x'::text AS b WHERE false",
        opts(),
    )
    .await;
    assert_eq!(drained.chunks.len(), 2, "schema, then end-of-stream");
    let (schema, batches) = decode(&drained.chunks);
    assert_eq!(schema.fields().len(), 2);
    assert_eq!(rows(&batches), 0);
    assert_eq!(drained.terminal.unwrap().rows_returned, Some(0));

    // Statements without a result set produce an empty-schema stream and a write count.
    run(&*conn, "q2", "CREATE TEMP TABLE t (v int4)", opts())
        .await
        .terminal
        .unwrap();
    let (schema, batches, summary) = query(
        &*conn,
        "q3",
        "INSERT INTO t SELECT generate_series(1, 3)",
        opts(),
    )
    .await;
    assert!(schema.fields().is_empty());
    assert!(batches.is_empty());
    assert_eq!(summary.rows_affected, Some(3));
    assert_eq!(summary.rows_returned, None);
    let (_, batches, summary) =
        query(&*conn, "q4", "UPDATE t SET v = v + 1 RETURNING v", opts()).await;
    assert_eq!(rows(&batches), 3);
    assert_eq!(summary.rows_affected, Some(3));
    assert_eq!(summary.rows_returned, Some(3));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn batch_hint_bounds_batches_of_a_large_result() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let opts = ExecuteOptions {
        batch_size_hint: Some(1000),
        ..opts()
    };
    let drained = run(
        &*conn,
        "q1",
        "SELECT g AS n, repeat('x', g % 50) AS s FROM generate_series(1, 100000) g",
        opts,
    )
    .await;
    // Schema chunk, 100 full batches, then the end-of-stream marker.
    assert_eq!(drained.chunks.len(), 102);
    assert_eq!(drained.chunks[101], [0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]);
    let (_, batches) = decode(&drained.chunks);
    assert_eq!(batches.len(), 100);
    assert!(batches.iter().all(|b| b.num_rows() == 1000));
    let n = batches
        .iter()
        .flat_map(|b| b.column(0).as_primitive::<Int32Type>().values().to_vec());
    assert!(n.eq(1..=100_000));
    assert_eq!(drained.terminal.unwrap().rows_returned, Some(100_000));

    let zero = ExecuteOptions {
        batch_size_hint: Some(0),
        ..ExecuteOptions::default()
    };
    assert!(matches!(
        run(&*conn, "q2", "SELECT 1", zero).await.terminal,
        Err(DbError::Unsupported(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn max_rows_truncates_without_reading_the_rest() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let series = "SELECT generate_series(1, 10) AS n";
    for (max, expect_rows, truncated) in
        [(3, 3, true), (10, 10, false), (11, 10, false), (0, 0, true)]
    {
        let (_, batches, summary) = query(
            &*conn,
            &format!("max-{max}"),
            series,
            ExecuteOptions {
                max_rows: Some(max),
                ..opts()
            },
        )
        .await;
        assert_eq!(rows(&batches), expect_rows, "max_rows {max}");
        assert_eq!(summary.rows_returned, Some(expect_rows as u64));
        assert_eq!(summary.truncated, truncated, "max_rows {max}");
    }
    // The server stops at the limit: six rows of 0.1 s each, not a thousand.
    let started = Instant::now();
    let (_, batches, summary) = query(
        &*conn,
        "slow",
        "SELECT g, pg_sleep(0.1) FROM generate_series(1, 1000) g",
        ExecuteOptions {
            max_rows: Some(5),
            ..opts()
        },
    )
    .await;
    assert_eq!(rows(&batches), 5);
    assert!(summary.truncated);
    assert!(started.elapsed() < Duration::from_secs(5));
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn errors_carry_sqlstate_and_character_position() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let error = run(&*conn, "q1", "SELECT 'żółw', * FROM missing_table", opts())
        .await
        .terminal
        .unwrap_err();
    let DbError::InvalidQuery(QueryError {
        sqlstate: code,
        position,
        message,
        ..
    }) = error
    else {
        panic!("{error:?}")
    };
    assert_eq!(code.as_deref(), Some("42P01"));
    // Counted in characters: "SELECT 'żółw', * FROM " is 22 characters, 25 bytes.
    assert_eq!(position, Some(23));
    assert!(message.contains("missing_table"));

    let error = run(&*conn, "q2", "SELECT 1 / 0", opts())
        .await
        .terminal
        .unwrap_err();
    assert!(matches!(&error, DbError::DatabaseError(_)), "{error:?}");
    assert_eq!(sqlstate(&error), Some("22012"));

    // An error in the middle of a result ends the stream with that error, once.
    let mid = run(
        &*conn,
        "q3",
        "SELECT 10 / (5000 - g) FROM generate_series(1, 10000) g",
        ExecuteOptions {
            batch_size_hint: Some(100),
            ..opts()
        },
    )
    .await;
    assert!(!mid.chunks.is_empty());
    assert_eq!(sqlstate(&mid.terminal.unwrap_err()), Some("22012"));

    // The connection is still usable, and the failed statement left no transaction open.
    assert_eq!(scalar(&*conn, "q4", "SELECT 7").await, 7);
    assert_eq!(
        text(
            &*conn,
            "q5",
            "SELECT (pg_current_xact_id_if_assigned() IS NULL)::text"
        )
        .await,
        "true"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unsupported_statements_are_refused_cleanly() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let params = run(&*conn, "q1", "SELECT $1::int4", opts())
        .await
        .terminal
        .unwrap_err();
    assert_eq!(sqlstate(&params), Some("42P02"));
    let many = run(&*conn, "q2", "SELECT 1; SELECT 2", opts())
        .await
        .terminal
        .unwrap_err();
    assert_eq!(sqlstate(&many), Some("42601"));
    let nul = run(&*conn, "q3", "SELECT '\0'", opts())
        .await
        .terminal
        .unwrap_err();
    assert_eq!(sqlstate(&nul), Some("22021"));
    let copy_out = run(&*conn, "q4", "COPY (SELECT 1) TO STDOUT", opts()).await;
    assert!(matches!(copy_out.terminal, Err(DbError::Unsupported(_))));
    run(&*conn, "q5", "CREATE TEMP TABLE c (v int4)", opts())
        .await
        .terminal
        .unwrap();
    let copy_in = run(&*conn, "q6", "COPY c FROM STDIN", opts()).await;
    assert!(matches!(copy_in.terminal, Err(DbError::Unsupported(_))));
    assert_eq!(scalar(&*conn, "q7", "SELECT 8").await, 8);

    let (_, _, summary) = query(
        &*conn,
        "q8",
        "DO $$ BEGIN RAISE NOTICE 'hello %', 1; RAISE WARNING 'careful'; END $$",
        opts(),
    )
    .await;
    assert_eq!(summary.notices, ["NOTICE: hello 1", "WARNING: careful"]);
    let empty = run(&*conn, "q9", "", opts()).await.terminal.unwrap();
    assert_eq!(empty.rows_returned, None);
}

// ---------------------------------------------------------------------------------------------
// Cancellation and lifecycle
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_reaches_the_server_through_a_brokered_cancel_connection() {
    let cluster = require_cluster!();
    let (env, conn) = app(cluster).await;
    let id = op("sleep");
    let mut stream = conn
        .execute(&id, "SELECT pg_sleep(30)", opts())
        .await
        .unwrap();
    let started = Instant::now();
    let (outcome, drained) = tokio::join!(
        async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            conn.cancel(&id).await
        },
        conformance::drain(&mut *stream)
    );
    assert_eq!(outcome, Ok(CancelOutcome::Requested));
    assert_eq!(drained.terminal, Err(DbError::Cancelled));
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the server stopped the statement"
    );

    // The ID is terminal now; unknown IDs are not running either.
    assert_eq!(conn.cancel(&id).await, Ok(CancelOutcome::NotRunning));
    assert_eq!(
        conn.cancel(&op("never")).await,
        Ok(CancelOutcome::NotRunning)
    );
    assert_eq!(scalar(&*conn, "after", "SELECT 1").await, 1);

    let actions = env.broker_actions();
    assert!(actions.contains(&(
        "plugin-host.broker.open-cancel".to_owned(),
        Outcome::Success
    )));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_cancel_is_idempotent_and_observed_once() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let mut stream = conn
        .execute(&op("sleep"), "SELECT pg_sleep(30)", opts())
        .await
        .unwrap();
    // The schema chunk is ready before the statement produces rows.
    assert!(matches!(stream.next().await, Ok(Some(NextItem::Chunk(_)))));
    tokio::time::sleep(Duration::from_millis(200)).await;
    conformance::cancel_is_idempotent(&*stream).await;
    let drained = conformance::drain(&mut *stream).await;
    assert_eq!(drained.terminal, Err(DbError::Cancelled));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_cancel_never_hits_the_next_statement() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let conn: Arc<dyn Connection> = Arc::from(conn);
    for i in 0..40 {
        let id = op(&format!("race-{i}"));
        let mut stream = conn.execute(&id, "SELECT 1", opts()).await.unwrap();
        // The cancel runs on its own and may still be in flight when the next statement starts.
        let cancel = tokio::spawn({
            let conn = conn.clone();
            async move { conn.cancel(&id).await }
        });
        // Either the statement finished first or the cancellation was observed.
        match conformance::drain(&mut *stream).await.terminal {
            Ok(summary) => assert_eq!(summary.rows_returned, Some(1)),
            Err(e) => assert_eq!(e, DbError::Cancelled),
        }
        drop(stream);
        // A statement that sleeps a little gives a stray cancel time to land.
        let (_, batches, _) = query(
            &*conn,
            &format!("next-{i}"),
            "SELECT pg_sleep(0.02), 42",
            opts(),
        )
        .await;
        assert_eq!(rows(&batches), 1, "iteration {i}");
        assert!(cancel.await.unwrap().is_ok());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_operation_runs_at_a_time() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    // While "slow" runs, "queued" cannot start: the connection reports busy.
    let mut slow = conn
        .execute(&op("slow"), "SELECT pg_sleep(0.3)", opts())
        .await
        .unwrap();
    assert!(matches!(
        conn.execute(&op("queued"), "SELECT 1", opts()).await,
        Err(DbError::Unsupported(_))
    ));
    conformance::drain(&mut *slow).await.terminal.unwrap();
    // The busy attempt did not consume its ID.
    run(&*conn, "queued", "SELECT 1", opts())
        .await
        .terminal
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn operation_ids_are_never_reused() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    run(&*conn, "once", "SELECT 1", opts())
        .await
        .terminal
        .unwrap();
    assert!(matches!(
        run(&*conn, "once", "SELECT 1", opts()).await.terminal,
        Err(DbError::Unsupported(_))
    ));
    // A failed statement also uses up its ID.
    run(&*conn, "bad", "SELEC", opts())
        .await
        .terminal
        .unwrap_err();
    assert!(matches!(
        run(&*conn, "bad", "SELECT 1", opts()).await.terminal,
        Err(DbError::Unsupported(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_stops_the_statement_on_the_server() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let started = Instant::now();
    let drained = run(
        &*conn,
        "q1",
        "SELECT pg_sleep(30)",
        ExecuteOptions {
            deadline_ms: Some(300),
            ..opts()
        },
    )
    .await;
    assert_eq!(drained.terminal, Err(DbError::Timeout));
    assert!(started.elapsed() < Duration::from_secs(10));
    // The deadline applies while rows are flowing too. Rows are larger than the server's 8 KiB
    // output buffer, so each one is sent as soon as it is produced.
    let drained = run(
        &*conn,
        "q2",
        "SELECT g, repeat('x', 10000), pg_sleep(0.01) FROM generate_series(1, 100000) g",
        ExecuteOptions {
            deadline_ms: Some(300),
            batch_size_hint: Some(1),
            ..opts()
        },
    )
    .await;
    assert!(drained.chunks.len() > 1);
    assert_eq!(drained.terminal, Err(DbError::Timeout));
    let zero = ExecuteOptions {
        deadline_ms: Some(0),
        ..opts()
    };
    assert_eq!(
        run(&*conn, "q3", "SELECT 1", zero).await.terminal,
        Err(DbError::Timeout)
    );
    assert_eq!(scalar(&*conn, "q4", "SELECT 3").await, 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dropping_a_stream_cancels_it_and_frees_the_connection() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let id = op("sleep");
    let mut stream = conn
        .execute(&id, "SELECT pg_sleep(30)", opts())
        .await
        .unwrap();
    assert!(matches!(stream.next().await, Ok(Some(NextItem::Chunk(_)))));
    drop(stream);
    assert_eq!(conn.cancel(&id).await, Ok(CancelOutcome::NotRunning));
    let started = Instant::now();
    assert_eq!(scalar(&*conn, "after", "SELECT 2").await, 2);
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the dropped statement was cancelled"
    );

    // Dropping a stream in the middle of a large result drains it too.
    let mut stream = conn
        .execute(
            &op("big"),
            "SELECT generate_series(1, 5000000) AS g",
            ExecuteOptions {
                batch_size_hint: Some(10),
                ..opts()
            },
        )
        .await
        .unwrap();
    for _ in 0..3 {
        stream.next().await.unwrap();
    }
    drop(stream);
    assert_eq!(scalar(&*conn, "after-big", "SELECT 4").await, 4);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connections_and_streams_release_broker_transports() {
    let cluster = require_cluster!();
    let config = BrokerConfig {
        limits: BrokerLimits {
            max_transports_per_scope: 2,
            ..BrokerLimits::default()
        },
        ..BrokerConfig::default()
    };
    let env = Env::with_config(cluster, Grant::plain(), config).await;
    let broker = env.broker_for(alice());
    let driver = PostgresDriver::new(
        broker.clone(),
        Arc::new(Settings::one("cred-1", login(APP))),
    );
    for i in 0..6 {
        let conn = driver
            .connect(&*broker, TARGET, Some("cred-1"))
            .await
            .unwrap();
        // A cancel needs a second transport of the scope's two.
        let id = op("sleep");
        let mut stream = conn
            .execute(&id, "SELECT pg_sleep(30)", opts())
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            conn.cancel(&id).await,
            Ok(CancelOutcome::Requested),
            "round {i}"
        );
        assert_eq!(
            conformance::drain(&mut *stream).await.terminal,
            Err(DbError::Cancelled)
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Grants, TLS and authentication
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancel_requires_the_grants_cancel_permission() {
    let cluster = require_cluster!();
    let env = Env::new(
        cluster,
        Grant {
            allow_cancel: false,
            ..Grant::plain()
        },
    )
    .await;
    let conn = env.connect(alice(), login(APP)).await.unwrap();
    let id = op("sleep");
    let mut stream = conn
        .execute(&id, "SELECT pg_sleep(0.5)", opts())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    // An error, never a successful acknowledgement.
    assert_eq!(conn.cancel(&id).await, Err(DbError::PermissionDenied));
    assert!(conformance::drain(&mut *stream).await.terminal.is_ok());
    assert!(
        env.broker_actions()
            .iter()
            .any(|(a, o)| a == "plugin-host.broker.open-cancel" && *o != Outcome::Success)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn revoking_the_grant_ends_the_stream_and_the_connection() {
    let cluster = require_cluster!();
    let (env, conn) = app(cluster).await;
    let id = op("sleep");
    let mut stream = conn
        .execute(&id, "SELECT pg_sleep(30)", opts())
        .await
        .unwrap();
    let started = Instant::now();
    let (_, drained) = tokio::join!(
        async {
            tokio::time::sleep(Duration::from_millis(200)).await;
            env.revoke().await;
        },
        conformance::drain(&mut *stream)
    );
    assert_eq!(drained.terminal, Err(DbError::PermissionDenied));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(conn.cancel(&id).await, Ok(CancelOutcome::NotRunning));
    assert!(
        run(&*conn, "after", "SELECT 1", opts())
            .await
            .terminal
            .is_err()
    );
    assert!(env.connect(alice(), login(APP)).await.is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ineligible_principals_and_foreign_brokers_cannot_connect() {
    let cluster = require_cluster!();
    let env = Env::new(cluster, Grant::plain()).await;
    assert_eq!(
        env.connect(mallory(), login(APP)).await.err(),
        Some(DbError::PermissionDenied)
    );
    // connect must be given the broker the driver was built with.
    let ours = env.broker_for(alice());
    let other = env.broker_for(alice());
    let driver = PostgresDriver::new(ours.clone(), Arc::new(Settings::one("cred-1", login(APP))));
    assert_eq!(
        driver.connect(&*other, TARGET, Some("cred-1")).await.err(),
        Some(DbError::PermissionDenied)
    );
    driver
        .connect(&*ours, TARGET, Some("cred-1"))
        .await
        .unwrap();
    // Unknown credential references are refused by the host's settings source.
    assert_eq!(
        driver.connect(&*ours, TARGET, Some("cred-2")).await.err(),
        Some(DbError::PermissionDenied)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn tls_upgrade_is_verified_by_the_broker_for_data_and_cancel() {
    let cluster = require_cluster!();
    let env = Env::new(cluster, Grant::tls(&cluster.ca)).await;
    let conn = env
        .connect(alice(), with_tls(login(TLS_ONLY)))
        .await
        .unwrap();
    assert_eq!(
        text(
            &*conn,
            "q1",
            "SELECT ssl::text FROM pg_stat_ssl WHERE pid = pg_backend_pid()"
        )
        .await,
        "true"
    );
    let id = op("sleep");
    let mut stream = conn
        .execute(&id, "SELECT pg_sleep(30)", opts())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(conn.cancel(&id).await, Ok(CancelOutcome::Requested));
    assert_eq!(
        conformance::drain(&mut *stream).await.terminal,
        Err(DbError::Cancelled)
    );
    // Both the data and the cancel connection upgraded before sending anything else.
    let actions = env.broker_actions();
    let upgrades = actions
        .iter()
        .filter(|(a, o)| a == "plugin-host.broker.start-tls" && *o == Outcome::Success)
        .count();
    assert_eq!(upgrades, 2, "{actions:?}");

    // A certificate from another CA is refused.
    let other_ca = rcgen::CertificateParams::new(Vec::<String>::new())
        .unwrap()
        .self_signed(&rcgen::KeyPair::generate().unwrap())
        .unwrap();
    let wrong = Env::new(cluster, Grant::tls(other_ca.der())).await;
    assert_eq!(
        wrong
            .connect(alice(), with_tls(login(TLS_ONLY)))
            .await
            .err(),
        Some(DbError::TlsFailed)
    );
    // This login is TLS-only on the server; a plaintext grant cannot use it.
    let plain = Env::new(cluster, Grant::plain()).await;
    assert_eq!(
        plain.connect(alice(), login(TLS_ONLY)).await.err(),
        Some(DbError::AuthenticationFailed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn settings_that_disagree_with_the_grant_fail_closed() {
    let cluster = require_cluster!();
    // TLS grant, driver told to stay plaintext: the broker closes the transport.
    let env = Env::new(cluster, Grant::tls(&cluster.ca)).await;
    assert!(env.connect(alice(), login(APP)).await.is_err());
    // Plaintext grant, driver asks for TLS: the broker refuses start_tls.
    let env = Env::new(cluster, Grant::plain()).await;
    assert_eq!(
        env.connect(alice(), with_tls(login(APP))).await.err(),
        Some(DbError::PermissionDenied)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn authentication_methods_and_failures() {
    let cluster = require_cluster!();
    let env = Env::new(cluster, Grant::plain()).await;
    for user in [APP, MD5, CLEARTEXT] {
        let conn = env.connect(alice(), login(user)).await.unwrap();
        assert_eq!(
            text(&*conn, "who", "SELECT current_user::text").await,
            user.0
        );
    }
    for user in [APP, MD5, CLEARTEXT] {
        let error = env.connect(alice(), login((user.0, "wrong"))).await.err();
        assert_eq!(error, Some(DbError::AuthenticationFailed), "{}", user.0);
    }
    let no_password = db_driver_postgres::PgSettings {
        password: None,
        ..login(APP)
    };
    assert_eq!(
        env.connect(alice(), no_password).await.err(),
        Some(DbError::AuthenticationFailed)
    );
    // A missing database is a database error, with its SQLSTATE.
    let mut missing = login(APP);
    missing.database = "nope".into();
    let error = env.connect(alice(), missing).await.err().unwrap();
    assert_eq!(sqlstate(&error), Some("3D000"));
}

#[test]
fn passwords_are_never_printed() {
    let settings = login(APP);
    let printed = format!("{settings:?}");
    assert!(!printed.contains(APP.1), "{printed}");
    assert!(printed.contains("<redacted>"));
}

// ---------------------------------------------------------------------------------------------
// Read-only mode
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_mode_refuses_writes_for_agent_reads() {
    let cluster = require_cluster!();
    let env = Env::new(cluster, Grant::plain()).await;
    let conn = env.connect(agent(), read_only(login(APP))).await.unwrap();
    assert_eq!(
        scalar(&*conn, "r1", "SELECT count(*)::int4 FROM public.items").await,
        3
    );
    assert_eq!(
        text(
            &*conn,
            "r2",
            "SELECT current_setting('transaction_read_only')"
        )
        .await,
        "on"
    );
    for (i, sql) in [
        "INSERT INTO public.items (id, name) VALUES (99, 'x')",
        "UPDATE public.items SET name = 'x'",
        "DELETE FROM public.items",
        "CREATE TEMP TABLE t (v int4)",
        "SELECT nextval('sales.orders_id_seq')",
    ]
    .iter()
    .enumerate()
    {
        let error = run(&*conn, &format!("w{i}"), sql, opts())
            .await
            .terminal
            .unwrap_err();
        assert_eq!(sqlstate(&error), Some("25006"), "{sql}");
    }
    // Statements that end or reconfigure the transaction cannot open a way to write later.
    for (i, sql) in [
        "COMMIT",
        "SET TRANSACTION READ WRITE",
        "SET default_transaction_read_only = off",
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
    ]
    .iter()
    .enumerate()
    {
        let _ = run(&*conn, &format!("e{i}"), sql, opts()).await;
        let error = run(
            &*conn,
            &format!("e{i}-write"),
            "INSERT INTO public.items (id, name) VALUES (98, 'x')",
            opts(),
        )
        .await
        .terminal
        .unwrap_err();
        assert_eq!(sqlstate(&error), Some("25006"), "after {sql}");
    }
    // Each statement's transaction was rolled back: nothing is left open between calls.
    assert_eq!(
        text(
            &*conn,
            "r3",
            "SELECT current_setting('default_transaction_read_only')"
        )
        .await,
        "on"
    );
    // Introspection works in read-only mode as well.
    assert!(conn.schemas().await.unwrap().contains(&"sales".to_owned()));

    // The same login in read-write mode can write (to a temporary table).
    let rw = env.connect(alice(), login(APP)).await.unwrap();
    run(&*rw, "w", "CREATE TEMP TABLE t (v int4)", opts())
        .await
        .terminal
        .unwrap();
}

// ---------------------------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn introspection_lists_schemas_tables_and_columns() {
    let cluster = require_cluster!();
    let (_env, conn) = app(cluster).await;
    let schemas = conn.schemas().await.unwrap();
    for s in ["information_schema", "pg_catalog", "public", "sales"] {
        assert!(schemas.contains(&s.to_owned()), "{schemas:?}");
    }
    assert!(!schemas.iter().any(|s| s.starts_with("pg_toast")));

    let table = |schema: &str, name: &str, kind: &str| TableInfo {
        schema: Some(schema.into()),
        name: name.into(),
        kind: kind.into(),
    };
    assert_eq!(
        conn.tables(Some("sales")).await.unwrap(),
        [
            table("sales", "big_orders", "view"),
            table("sales", "empty", "table"),
            table("sales", "orders", "table"),
        ]
    );
    // Unqualified: what the search path resolves, without the system schemas.
    let visible = conn.tables(None).await.unwrap();
    assert!(visible.contains(&table("public", "items", "table")));
    assert!(!visible.iter().any(|t| t.schema.as_deref() == Some("sales")));
    assert!(!visible.iter().any(|t| t.name == "pg_class"));

    let column = |name: &str, type_name: &str, nullable: bool| ColumnInfo {
        name: name.into(),
        type_name: type_name.into(),
        nullable,
    };
    assert_eq!(
        conn.columns(Some("sales"), "orders").await.unwrap(),
        [
            column("id", "bigint", false),
            column("item_id", "integer", false),
            column("qty", "integer", true),
            column("note", "text", true),
        ]
    );
    let items = conn.columns(None, "items").await.unwrap();
    assert_eq!(items.len(), 18);
    assert_eq!(items[7], column("note", "character varying(20)", true));
    assert_eq!(items[8], column("price", "numeric(10,2)", true));
    assert_eq!(conn.columns(Some("sales"), "empty").await.unwrap(), []);
    // Not on the search path, or not there at all.
    for (schema, name) in [
        (None, "orders"),
        (Some("sales"), "nope"),
        (Some("nope"), "orders"),
    ] {
        let error = conn.columns(schema, name).await.unwrap_err();
        assert_eq!(sqlstate(&error), Some("42P01"), "{schema:?}.{name}");
    }
    // Names are parameters, not SQL.
    assert_eq!(conn.tables(Some("sales' OR '1'='1")).await.unwrap(), []);
}
