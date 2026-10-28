//! Stream lifecycle checks every [`ResultStream`] must pass (README, "Confirmed semantics").
//! Shared by the contract's reference tests and by concrete drivers' tests. Violations panic.
//!
//! Arrow validity and backend cancellation are driver-specific and stay in each driver's tests.

use crate::{CancelOutcome, DbError, NextItem, QuerySummary, ResultStream};

/// Everything a stream produced: its chunks, then its single terminal outcome.
#[derive(Debug)]
pub struct Drained {
    pub chunks: Vec<Vec<u8>>,
    pub terminal: Result<QuerySummary, DbError>,
}

/// Polls `stream` to its terminal outcome, then checks [`after_terminal`]. A stream must not end
/// (`None`) before a `Finished` summary or an error.
pub async fn drain(stream: &mut dyn ResultStream) -> Drained {
    let mut chunks = Vec::new();
    let terminal = loop {
        match stream.next().await {
            Ok(Some(NextItem::Chunk(chunk))) => chunks.push(chunk),
            Ok(Some(NextItem::Finished(summary))) => break Ok(summary),
            Ok(None) => panic!("stream ended without a summary or an error"),
            Err(error) => break Err(error),
        }
    };
    after_terminal(stream).await;
    Drained { chunks, terminal }
}

/// After the terminal outcome: every poll is EOF and cancellation reports `NotRunning`.
pub async fn after_terminal(stream: &mut dyn ResultStream) {
    for _ in 0..2 {
        assert_eq!(
            stream.next().await,
            Ok(None),
            "poll after the terminal outcome"
        );
    }
    assert_eq!(
        stream.cancel().await,
        Ok(CancelOutcome::NotRunning),
        "cancel after the terminal outcome"
    );
    assert_eq!(stream.next().await, Ok(None), "poll after a late cancel");
}

/// Cancelling a running stream is idempotent: repeated requests are all `Requested`.
pub async fn cancel_is_idempotent(stream: &dyn ResultStream) {
    for _ in 0..2 {
        assert_eq!(
            stream.cancel().await,
            Ok(CancelOutcome::Requested),
            "cancel of a running stream"
        );
    }
}
