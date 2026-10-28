//! Regression tests for cancellation between protocol phases and deadlines under backpressure.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use arrow_array::cast::AsArray;
use arrow_array::types::Int32Type;
use db_driver::conformance;
use db_driver::{
    CancelOutcome, Connection, ConnectionBroker, DbError, DbFuture, Driver, ExecuteOptions,
    NextItem, Transport,
};
use db_driver_postgres::PostgresDriver;
use tokio::sync::Notify;

use support::*;

/// Pauses one frontend message before forwarding its bytes. For Parse this lets the test
/// cancel before Describe completes; for Bind it reproduces the check/send race, with the
/// backend idle until after the cancel acknowledgement.
struct PausingBroker {
    inner: Arc<dyn ConnectionBroker>,
    phase: u8,
    entered: Arc<Notify>,
    resume: Arc<Notify>,
}

impl ConnectionBroker for PausingBroker {
    fn open<'a>(&'a self, target: &'a str, purpose: &'a str) -> DbFuture<'a, Box<dyn Transport>> {
        Box::pin(async move {
            let inner = self.inner.open(target, purpose).await?;
            if purpose != "data" {
                return Ok(inner);
            }
            Ok(Box::new(PausingTransport {
                inner,
                phase: self.phase,
                paused: AtomicBool::new(false),
                entered: self.entered.clone(),
                resume: self.resume.clone(),
            }) as Box<dyn Transport>)
        })
    }
}

struct PausingTransport {
    inner: Box<dyn Transport>,
    phase: u8,
    paused: AtomicBool,
    entered: Arc<Notify>,
    resume: Arc<Notify>,
}

impl Transport for PausingTransport {
    fn send<'a>(&'a self, bytes: &'a [u8]) -> DbFuture<'a, u32> {
        Box::pin(async move {
            if bytes.first() == Some(&self.phase) && !self.paused.swap(true, Ordering::SeqCst) {
                self.entered.notify_one();
                self.resume.notified().await;
            }
            self.inner.send(bytes).await
        })
    }

    fn recv(&self, max_bytes: u32) -> DbFuture<'_, Vec<u8>> {
        self.inner.recv(max_bytes)
    }

    fn start_tls<'a>(&'a self, server_name: &'a str) -> DbFuture<'a, ()> {
        self.inner.start_tls(server_name)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acknowledged_cancel_survives_describe_and_execute_gaps() {
    let cluster = require_cluster!();
    for phase in *b"PB" {
        let env = Env::new(cluster, Grant::plain()).await;
        let entered = Arc::new(Notify::new());
        let resume = Arc::new(Notify::new());
        let broker: Arc<dyn ConnectionBroker> = Arc::new(PausingBroker {
            inner: env.broker_for(alice()),
            phase,
            entered: entered.clone(),
            resume: resume.clone(),
        });
        let driver = PostgresDriver::new(
            broker.clone(),
            Arc::new(Settings::one("cred-1", login(APP))),
        );
        let conn: Arc<dyn Connection> = Arc::from(
            driver
                .connect(&*broker, TARGET, Some("cred-1"))
                .await
                .unwrap(),
        );
        let task = tokio::spawn({
            let conn = conn.clone();
            async move {
                run(
                    &*conn,
                    "gap",
                    "SELECT pg_sleep(30)",
                    ExecuteOptions::default(),
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(5), entered.notified())
            .await
            .unwrap();
        assert_eq!(conn.cancel(&op("gap")).await, Ok(CancelOutcome::Requested));
        resume.notify_one();
        let drained = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            drained.terminal,
            Err(DbError::Cancelled),
            "phase {}",
            phase as char
        );
        assert_eq!(conn.cancel(&op("gap")).await, Ok(CancelOutcome::NotRunning));

        // The retry worker must not deliver another cancel to the next statement.
        let (_, batches, _) = query(
            &*conn,
            "next",
            "SELECT pg_sleep(1.1), 42",
            ExecuteOptions::default(),
        )
        .await;
        assert_eq!(
            batches[0].column(1).as_primitive::<Int32Type>().value(0),
            42
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn deadline_cancels_the_backend_without_stream_polls() {
    let cluster = require_cluster!();
    let env = Env::new(cluster, Grant::plain()).await;
    let observer = env.connect(alice(), superuser()).await.unwrap();
    for consume_schema in [false, true] {
        let conn = env.connect(alice(), login(APP)).await.unwrap();
        let (_, batches, _) = query(
            &*conn,
            "pid",
            "SELECT pg_backend_pid()",
            ExecuteOptions::default(),
        )
        .await;
        let pid = batches[0].column(0).as_primitive::<Int32Type>().value(0);
        let mut stream = conn
            .execute(
                &op("sleep"),
                "SELECT pg_sleep(30)",
                ExecuteOptions {
                    deadline_ms: Some(300),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        if consume_schema {
            assert!(matches!(stream.next().await, Ok(Some(NextItem::Chunk(_)))));
        }

        // Observe the actual backend, without polling or dropping the driver's stream.
        tokio::time::timeout(Duration::from_secs(5), async {
            for attempt in 0.. {
                let (_, batches, _) = query(
                    &*observer, &format!("observe-{consume_schema}-{attempt}"),
                    &format!("SELECT count(*)::int4 FROM pg_stat_activity WHERE pid = {pid} AND query = 'SELECT pg_sleep(30)' AND state <> 'active'"),
                    ExecuteOptions::default(),
                ).await;
                let stopped = batches[0].column(0).as_primitive::<Int32Type>().value(0);
                if stopped == 1 { break; }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.expect("deadline must stop the backend without consumer credit");
        assert_eq!(
            conformance::drain(&mut *stream).await.terminal,
            Err(DbError::Timeout)
        );
        query(
            &*conn,
            "after",
            "SELECT pg_sleep(1.1), 7",
            ExecuteOptions::default(),
        )
        .await;
    }
}
