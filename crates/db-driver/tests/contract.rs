use db_driver::*;
use futures_executor::block_on;
use std::{
    collections::VecDeque,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

#[test]
fn wit_resolves_and_exports_driver_without_ambient_imports() {
    let mut resolve = wit_parser::Resolve::default();
    let (package, _) = resolve
        .push_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/wit"))
        .unwrap();
    let world = resolve.packages[package].worlds["db-driver"];
    let world = &resolve.worlds[world];
    assert_eq!(world.imports.len(), 2); // broker plus shared db-types dependency
    assert_eq!(world.exports.len(), 1);
    let interface = resolve.packages[package].interfaces["driver"];
    let interface = &resolve.interfaces[interface];
    for name in [
        "connect",
        "execute",
        "cancel",
        "schemas",
        "tables",
        "columns",
        "[method]result-stream.next",
        "[method]result-stream.cancel",
    ] {
        assert!(interface.functions.contains_key(name), "missing {name}");
    }
    assert_eq!(interface.functions["execute"].params.len(), 4);
    let types = &resolve.interfaces[resolve.packages[package].interfaces["db-types"]];
    let wit_parser::TypeDefKind::Enum(outcomes) =
        &resolve.types[types.types["cancel-outcome"]].kind
    else {
        panic!("expected cancellation outcome enum")
    };
    assert_eq!(
        outcomes
            .cases
            .iter()
            .map(|c| c.name.as_str())
            .collect::<Vec<_>>(),
        ["requested", "not-running"]
    );
    for name in ["cancel", "[method]result-stream.cancel"] {
        let Some(wit_parser::Type::Id(result)) = interface.functions[name].result else {
            panic!("expected result")
        };
        let wit_parser::TypeDefKind::Result(result) = &resolve.types[result].kind else {
            panic!("expected result")
        };
        assert_eq!(
            result.ok,
            Some(wit_parser::Type::Id(interface.types["cancel-outcome"]))
        );
        assert_eq!(
            result.err,
            Some(wit_parser::Type::Id(interface.types["db-error"]))
        );
    }
    for (name, fields) in [
        (
            "execute-options",
            vec!["max-rows", "deadline-ms", "batch-size-hint"],
        ),
        (
            "query-summary",
            vec![
                "rows-affected",
                "rows-returned",
                "elapsed-ms",
                "notices",
                "truncated",
            ],
        ),
        (
            "query-error",
            vec!["message", "position", "sqlstate", "vendor-code"],
        ),
    ] {
        let wit_parser::TypeDefKind::Record(record) = &resolve.types[types.types[name]].kind else {
            panic!("expected record")
        };
        assert_eq!(
            record
                .fields
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>(),
            fields
        );
    }
}

// Compile-time proof that every registry/service facade is dyn-compatible.
#[allow(dead_code)]
fn erased_facades(
    _: Box<dyn Driver>,
    _: Box<dyn Connection>,
    _: Box<dyn ResultStream>,
    _: Box<dyn Transport>,
    _: &dyn ConnectionBroker,
) {
}

struct ReferenceStream {
    items: VecDeque<Result<NextItem, DbError>>,
    terminal: bool,
    cancel_requested: Arc<AtomicBool>,
}
impl ResultStream for ReferenceStream {
    fn next(&mut self) -> DbFuture<'_, Option<NextItem>> {
        Box::pin(async move {
            if self.terminal {
                return Ok(None);
            }
            match self.items.pop_front() {
                Some(Ok(NextItem::Finished(summary))) => {
                    self.terminal = true;
                    Ok(Some(NextItem::Finished(summary)))
                }
                Some(Err(error)) => {
                    self.terminal = true;
                    Err(error)
                }
                Some(Ok(item)) => Ok(Some(item)),
                None => panic!("successful stream omitted summary"),
            }
        })
    }
    fn cancel(&self) -> DbFuture<'_, CancelOutcome> {
        Box::pin(async {
            if self.terminal {
                return Ok(CancelOutcome::NotRunning);
            }
            self.cancel_requested.store(true, Ordering::SeqCst);
            Ok(CancelOutcome::Requested)
        })
    }
}
impl Drop for ReferenceStream {
    fn drop(&mut self) {
        if !self.terminal {
            self.cancel_requested.store(true, Ordering::SeqCst);
        }
    }
}
fn stream(items: Vec<Result<NextItem, DbError>>) -> (Box<dyn ResultStream>, Arc<AtomicBool>) {
    let flag = Arc::new(AtomicBool::new(false));
    (
        Box::new(ReferenceStream {
            items: items.into(),
            terminal: false,
            cancel_requested: flag.clone(),
        }),
        flag,
    )
}

#[test]
fn cancellation_is_idempotent_and_completion_can_win() {
    block_on(async {
        let summary = QuerySummary {
            rows_returned: Some(0),
            truncated: false,
            ..Default::default()
        };
        let (mut stream, requested) = stream(vec![Ok(NextItem::Finished(summary.clone()))]);
        conformance::cancel_is_idempotent(&*stream).await;
        assert!(requested.load(Ordering::SeqCst));
        let drained = conformance::drain(&mut *stream).await;
        assert!(drained.chunks.is_empty());
        assert_eq!(drained.terminal, Ok(summary));
    });
}

#[test]
fn observed_cancellation_is_one_terminal_error_and_drop_requests_cancel() {
    block_on(async {
        let (mut stream, _) = stream(vec![Ok(NextItem::Chunk(vec![1])), Err(DbError::Cancelled)]);
        let drained = conformance::drain(&mut *stream).await;
        assert_eq!(drained.chunks, [vec![1]]);
        assert_eq!(drained.terminal, Err(DbError::Cancelled));
    });
    let (stream, requested) = stream(vec![]);
    drop(stream);
    assert!(requested.load(Ordering::SeqCst));
}
