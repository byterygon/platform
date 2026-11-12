//! Arrow IPC over streams (Ambidex spec §6). Feature `arrow`.
//!
//! [`ArrowSink`] wraps a stream handler's [`BinarySink`] and writes an Arrow IPC *stream*: the
//! schema message, then record batches, then the end-of-stream marker. Every chunk holds whole
//! IPC messages, so the client can feed each chunk to an incremental reader as it arrives:
//!
//! - the first chunk is the schema message;
//! - then one chunk per record batch (with the dictionary messages it needs in front);
//! - then one chunk with the end-of-stream marker, sent by [`ArrowSink::finish`]. The handler
//!   then returns its typed summary, which the engine sends as `StreamEnd`.
//!
//! ```text
//! #[rpc::stream(perm = "query.execute", risk = Risk::Read)]
//! async fn execute(&self, ctx: Ctx, input: Query, sink: BinarySink) -> Result<Summary, RpcError> {
//!     let mut sink = ArrowSink::new(sink);
//!     let mut rows = 0;
//!     while let Some(batch) = self.next_batch(&input).await? {
//!         rows += batch.num_rows() as u64;
//!         sink.send(&batch).await?;      // waits for a credit
//!     }
//!     sink.finish().await?;
//!     Ok(Summary { rows })
//! }
//! ```
//!
//! # Chunk size
//!
//! A chunk cannot exceed the connection's frame limit ([`BinarySink::max_chunk_bytes`]). A batch
//! whose encoding is larger is sent as several smaller batches, split by rows; the sink remembers
//! how many rows fitted and slices later batches before encoding them. Only a single row larger
//! than the limit ends the stream (`ResourceExhausted`). [`ArrowSink::with_max_chunk_bytes`]
//! lowers the target, e.g. to the 1–4 MiB the spec recommends on a connection with a larger
//! frame limit.
//!
//! # Pre-encoded chunks
//!
//! A source that already produces Arrow IPC stream chunks (a driver behind the Plugin Host
//! `db-driver` contract) is forwarded without decoding by [`ArrowSink::send_ipc`]. The source
//! must respect the same rule: whole IPC messages per chunk, schema first, its own end-of-stream
//! marker last. To pull the source only when the client has room, wait for
//! [`ArrowSink::ready`] before each pull:
//!
//! ```text
//! loop {
//!     sink.ready().await?;                       // a credit is available
//!     let Some(chunk) = driver_stream.next().await? else { break };
//!     sink.send_ipc(chunk).await?;               // does not wait again
//! }
//! ```
//!
//! One sink either encodes batches or forwards chunks; mixing the two would interleave two IPC
//! streams, so it is refused ([`ArrowSinkError::Mixed`]).

use std::fmt;

use arrow_array::RecordBatch;
use arrow_ipc::writer::StreamWriter;
use arrow_schema::{ArrowError, SchemaRef};

use crate::error::{IntoErrorPayload, NoDetails, RpcError};
use crate::message::{Code, ErrorPayload};
use crate::stream::{BinarySink, StreamEnded};

/// What the sink has written so far.
enum Mode {
    /// Nothing yet.
    Idle,
    /// Encoding batches with this writer; the schema chunk is out.
    Encoding {
        writer: Box<StreamWriter<Vec<u8>>>,
        schema: SchemaRef,
    },
    /// Forwarding pre-encoded chunks.
    Forwarding,
    /// The end-of-stream marker is out.
    Finished,
}

/// Writes an Arrow IPC stream to a stream call's chunks. See the [module docs](self).
pub struct ArrowSink {
    sink: BinarySink,
    mode: Mode,
    max_chunk_bytes: usize,
    /// Rows per chunk that fitted the limit, once a batch had to be split.
    rows_hint: Option<usize>,
}

impl ArrowSink {
    pub fn new(sink: BinarySink) -> ArrowSink {
        ArrowSink {
            max_chunk_bytes: sink.max_chunk_bytes(),
            sink,
            mode: Mode::Idle,
            rows_hint: None,
        }
    }

    /// Splits batches so chunks stay at or under `bytes` (never above the connection's limit).
    #[must_use]
    pub fn with_max_chunk_bytes(mut self, bytes: usize) -> ArrowSink {
        self.max_chunk_bytes = bytes.clamp(1, self.sink.max_chunk_bytes());
        self
    }

    /// Sends the schema message, if it is not out yet. [`ArrowSink::send`] does this by itself;
    /// call it for a result that may have no batch at all, so the client still gets the schema.
    pub async fn start(&mut self, schema: &SchemaRef) -> Result<(), ArrowSinkError> {
        match &self.mode {
            Mode::Idle => {}
            Mode::Encoding { schema: sent, .. } if sent == schema => return Ok(()),
            Mode::Encoding { .. } => return Err(self.encode_failed("schema changed mid-stream")),
            Mode::Forwarding | Mode::Finished => return Err(ArrowSinkError::Mixed),
        }
        let mut writer = match StreamWriter::try_new(Vec::new(), schema) {
            Ok(writer) => writer,
            Err(err) => return Err(self.arrow_failed(&err)),
        };
        let chunk = std::mem::take(writer.get_mut());
        self.mode = Mode::Encoding {
            writer: Box::new(writer),
            schema: schema.clone(),
        };
        self.sink.send(chunk).await?;
        Ok(())
    }

    /// Sends one record batch: the schema first if this is the first batch, then the batch as
    /// one chunk, or as several when it does not fit one (see the module docs). Each chunk waits
    /// for a credit.
    pub async fn send(&mut self, batch: &RecordBatch) -> Result<(), ArrowSinkError> {
        self.start(&batch.schema()).await?;
        let total = batch.num_rows();
        let mut offset = 0;
        // An empty batch is still one (empty) batch message.
        loop {
            let want = self.rows_hint.unwrap_or(total).max(1);
            let take = want.min(total - offset);
            let sent = self.send_rows(batch, offset, take).await?;
            offset += sent;
            if offset >= total {
                return Ok(());
            }
        }
    }

    /// Sends the first rows of `batch[offset..offset + rows]` that fit one chunk; returns how
    /// many went out.
    async fn send_rows(
        &mut self,
        batch: &RecordBatch,
        offset: usize,
        rows: usize,
    ) -> Result<usize, ArrowSinkError> {
        let mut rows = rows;
        loop {
            let slice = batch.slice(offset, rows);
            let chunk = self.encode(&slice)?;
            if chunk.len() <= self.max_chunk_bytes || rows <= 1 {
                // A single row over the limit is refused by the sink, which ends the stream.
                self.sink.send(chunk).await?;
                return Ok(rows);
            }
            // Too large: aim a little under the limit by the size just measured, at least
            // halving, and remember it for the batches that follow.
            let fitting = rows * self.max_chunk_bytes / chunk.len() * 9 / 10;
            rows = fitting.clamp(1, rows / 2);
            self.rows_hint = Some(rows);
        }
    }

    fn encode(&mut self, batch: &RecordBatch) -> Result<Vec<u8>, ArrowSinkError> {
        let Mode::Encoding { writer, .. } = &mut self.mode else {
            return Err(ArrowSinkError::Mixed);
        };
        match writer.write(batch) {
            Ok(()) => Ok(std::mem::take(writer.get_mut())),
            Err(err) => Err(self.arrow_failed(&err)),
        }
    }

    /// Waits until the client has room for a chunk, without sending one (see
    /// [`BinarySink::ready`]).
    pub async fn ready(&self) -> Result<(), ArrowSinkError> {
        Ok(self.sink.ready().await?)
    }

    /// Forwards one pre-encoded Arrow IPC stream chunk unchanged: whole IPC messages, the schema
    /// message in the first chunk, the source's own end-of-stream marker in the last.
    pub async fn send_ipc(&mut self, chunk: impl Into<Vec<u8>>) -> Result<(), ArrowSinkError> {
        match self.mode {
            Mode::Idle => self.mode = Mode::Forwarding,
            Mode::Forwarding => {}
            Mode::Encoding { .. } | Mode::Finished => return Err(ArrowSinkError::Mixed),
        }
        Ok(self.sink.send(chunk).await?)
    }

    /// Ends the IPC stream: sends the end-of-stream marker when this sink encoded the batches.
    /// Nothing is sent for forwarded chunks (the source wrote its own marker) or when nothing
    /// was sent at all.
    pub async fn finish(mut self) -> Result<(), ArrowSinkError> {
        let Mode::Encoding { mut writer, .. } = std::mem::replace(&mut self.mode, Mode::Finished)
        else {
            return Ok(());
        };
        if let Err(err) = writer.finish() {
            return Err(self.arrow_failed(&err));
        }
        let chunk = std::mem::take(writer.get_mut());
        Ok(self.sink.send(chunk).await?)
    }

    /// Whether the stream is over; later chunks are refused.
    pub fn is_closed(&self) -> bool {
        self.sink.is_closed()
    }

    /// The encoder failed: a handler bug (the client learns `Internal`), and the stream is over.
    fn arrow_failed(&self, err: &ArrowError) -> ArrowSinkError {
        // The text of an Arrow error can quote data, so it stays on the server.
        let _ = err;
        self.encode_failed("arrow encoding failed")
    }

    fn encode_failed(&self, what: &'static str) -> ArrowSinkError {
        self.sink.chunks().end(Code::Internal, "internal error");
        ArrowSinkError::Encode(what)
    }
}

impl fmt::Debug for ArrowSink {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ArrowSink")
            .field("sink", &self.sink)
            .field("max_chunk_bytes", &self.max_chunk_bytes)
            .field("rows_hint", &self.rows_hint)
            .finish_non_exhaustive()
    }
}

/// Why [`ArrowSink`] did not send.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArrowSinkError {
    /// The stream is over (Cancel, deadline, disconnect, a row larger than the frame limit).
    Ended(StreamEnded),
    /// The batch could not be encoded, or its schema differs from the stream's. The stream is
    /// ended with `Internal`.
    Encode(&'static str),
    /// Batches and pre-encoded chunks were mixed on one sink, or it was used after `finish`.
    Mixed,
}

impl ArrowSinkError {
    /// The wire code: the reason the stream ended, otherwise `Internal`.
    pub fn code(&self) -> Code {
        match self {
            ArrowSinkError::Ended(ended) => ended.code(),
            ArrowSinkError::Encode(_) | ArrowSinkError::Mixed => Code::Internal,
        }
    }
}

impl From<StreamEnded> for ArrowSinkError {
    fn from(ended: StreamEnded) -> Self {
        ArrowSinkError::Ended(ended)
    }
}

impl fmt::Display for ArrowSinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ArrowSinkError::Ended(ended) => ended.fmt(f),
            ArrowSinkError::Encode(what) => write!(f, "arrow sink: {what}"),
            ArrowSinkError::Mixed => f.write_str("arrow sink: batches and IPC chunks mixed"),
        }
    }
}

impl std::error::Error for ArrowSinkError {}

/// As for [`StreamEnded`]: once the stream is over the client gets the reason its token fired;
/// an encoding failure leaves as `Internal`, without detail.
impl IntoErrorPayload for ArrowSinkError {
    type Details = NoDetails;

    fn into_error_payload(self) -> ErrorPayload {
        ErrorPayload::new(self.code(), "stream ended")
    }
}

/// Lets a handler whose error type is `RpcError<E>` use `?` on the sink's methods.
impl<E> From<ArrowSinkError> for RpcError<E> {
    fn from(err: ArrowSinkError) -> Self {
        RpcError::new(err.code(), "stream ended")
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow_array::{Array, Int64Array, StringArray};
    use arrow_buffer::Buffer;
    use arrow_ipc::reader::StreamDecoder;
    use arrow_schema::{DataType, Field, Schema};
    use tokio::sync::mpsc;

    use super::*;
    use crate::cancel::CallScope;
    use crate::frame::FrameDecoder;
    use crate::stream::{Chunks, Credits};
    use crate::subscription::Queued;

    const MAX: u32 = 2048;

    fn sink() -> (ArrowSink, mpsc::UnboundedReceiver<Queued>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let chunks = Chunks::new(1, CallScope::new(None), tx, Credits::new(4096, 4096), MAX);
        (ArrowSink::new(BinarySink::new(chunks)), rx)
    }

    fn batch(from: i64, rows: i64) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
        ]));
        let ids = Int64Array::from_iter_values(from..from + rows);
        let names: StringArray = (from..from + rows)
            .map(|n| (n % 3 != 0).then(|| format!("row-{n}")))
            .collect();
        RecordBatch::try_new(schema, vec![Arc::new(ids), Arc::new(names)]).unwrap()
    }

    /// The payload of every chunk queued so far.
    fn payloads(rx: &mut mpsc::UnboundedReceiver<Queued>) -> Vec<Vec<u8>> {
        let mut out = Vec::new();
        while let Ok(queued) = rx.try_recv() {
            let mut decoder = FrameDecoder::new(MAX);
            decoder.push(&queued.bytes);
            out.push(decoder.next_frame().unwrap().unwrap().payload);
        }
        out
    }

    /// Decodes chunk by chunk, checking that every chunk holds whole IPC messages.
    fn decode(chunks: &[Vec<u8>]) -> (StreamDecoder, Vec<RecordBatch>) {
        let mut decoder = StreamDecoder::new();
        let mut batches = Vec::new();
        for chunk in chunks {
            let mut buffer = Buffer::from(chunk.as_slice());
            while !buffer.is_empty() {
                if let Some(batch) = decoder.decode(&mut buffer).unwrap() {
                    batches.push(batch);
                }
            }
        }
        (decoder, batches)
    }

    #[tokio::test]
    async fn schema_then_one_chunk_per_batch_then_end_of_stream() {
        let (mut sink, mut rx) = sink();
        sink.send(&batch(0, 10)).await.unwrap();
        sink.send(&batch(10, 5)).await.unwrap();
        sink.finish().await.unwrap();
        let chunks = payloads(&mut rx);
        assert_eq!(chunks.len(), 4, "schema, two batches, end of stream");
        // The first chunk is the schema message alone: no batch, and the second chunk alone
        // (a batch without its schema) does not decode.
        assert!(decode(&chunks[..1]).1.is_empty());
        let mut headless = StreamDecoder::new();
        assert!(
            headless
                .decode(&mut Buffer::from(chunks[1].as_slice()))
                .is_err()
        );
        let (mut decoder, batches) = decode(&chunks);
        assert_eq!(decoder.schema().unwrap(), batch(0, 1).schema());
        decoder.finish().unwrap();
        assert_eq!(batches, vec![batch(0, 10), batch(10, 5)]);
    }

    #[tokio::test]
    async fn a_batch_larger_than_a_chunk_is_split_by_rows() {
        let (mut sink, mut rx) = sink();
        sink.send(&batch(0, 5000)).await.unwrap();
        // Later batches are sliced by the remembered size without a trial encode.
        assert!(sink.rows_hint.is_some());
        sink.send(&batch(5000, 300)).await.unwrap();
        sink.finish().await.unwrap();
        let chunks = payloads(&mut rx);
        assert!(chunks.len() > 10);
        assert!(chunks.iter().all(|c| c.len() <= MAX as usize));
        let (_, batches) = decode(&chunks);
        let mut next = 0;
        for b in &batches {
            let ids = b.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
            let names = b.column(1).as_any().downcast_ref::<StringArray>().unwrap();
            for row in 0..b.num_rows() {
                assert_eq!(ids.value(row), next);
                assert_eq!(names.is_null(row), next % 3 == 0);
                next += 1;
            }
        }
        assert_eq!(next, 5300);
    }

    #[tokio::test]
    async fn an_empty_result_still_carries_its_schema() {
        let (mut sink, mut rx) = sink();
        sink.start(&batch(0, 0).schema()).await.unwrap();
        sink.send(&batch(0, 0)).await.unwrap();
        sink.finish().await.unwrap();
        let (decoder, batches) = decode(&payloads(&mut rx));
        assert!(decoder.schema().is_some());
        assert_eq!(batches.iter().map(RecordBatch::num_rows).sum::<usize>(), 0);
    }

    #[tokio::test]
    async fn pre_encoded_chunks_are_forwarded_unchanged_and_not_mixed() {
        let (mut encoder, mut encoded) = sink();
        encoder.send(&batch(0, 10)).await.unwrap();
        encoder.finish().await.unwrap();
        let source = payloads(&mut encoded);

        let (mut sink, mut rx) = sink();
        for chunk in &source {
            sink.ready().await.unwrap();
            sink.send_ipc(chunk.clone()).await.unwrap();
        }
        assert_eq!(
            sink.send(&batch(0, 1)).await.unwrap_err(),
            ArrowSinkError::Mixed
        );
        sink.finish().await.unwrap();
        assert_eq!(payloads(&mut rx), source);
    }

    #[tokio::test]
    async fn a_schema_change_ends_the_stream_as_internal() {
        let (mut sink, _rx) = sink();
        sink.send(&batch(0, 1)).await.unwrap();
        let other = RecordBatch::try_new(
            Arc::new(Schema::new(vec![Field::new("x", DataType::Int64, false)])),
            vec![Arc::new(Int64Array::from(vec![1]))],
        )
        .unwrap();
        let err = sink.send(&other).await.unwrap_err();
        assert_eq!(err.code(), Code::Internal);
        assert!(sink.is_closed());
        assert_eq!(
            sink.send(&batch(1, 1)).await.unwrap_err().code(),
            Code::Internal
        );
    }

    #[tokio::test]
    async fn a_single_row_over_the_limit_ends_the_stream() {
        let (mut sink, _rx) = sink();
        let schema = Arc::new(Schema::new(vec![Field::new("s", DataType::Utf8, false)]));
        let big = StringArray::from(vec!["x".repeat(MAX as usize + 1)]);
        let batch = RecordBatch::try_new(schema, vec![Arc::new(big)]).unwrap();
        let err = sink.send(&batch).await.unwrap_err();
        assert_eq!(err.code(), Code::ResourceExhausted);
    }
}
