// Arrow IPC streams decoded off the UI thread (Ambidex spec §4, §6).
//
// A stream procedure that sends Arrow IPC (the Rust `ArrowSink`) delivers chunks of whole IPC
// messages: the schema, then record batches, then the end-of-stream marker. `decodeArrow` hands
// every chunk to a decoder running in a Worker and yields the decoded batches as plain columnar
// buffers, so this thread never parses Arrow:
//
//   import { decodeArrow } from "@byterygon/ambidex/arrow";
//
//   const worker = new Worker(new URL("@byterygon/ambidex/arrow-worker", import.meta.url), {
//     type: "module",
//   });
//   const rows = decodeArrow(client.query.execute({ sql }), worker);
//   const fields = await rows.schema;
//   for await (const batch of rows.batches()) grid.append(batch);
//   const summary = await rows.result;
//
// - This module does not import apache-arrow; only the Worker script does (`arrow-decoder.ts`),
//   so apache-arrow is an optional peer dependency. The Worker script ships in this package and
//   is bundled by the application: no CDN, no runtime fetch.
// - Chunks are transferred to the Worker and batches are transferred back (no copy between
//   threads). On Tauri the frames arrive on the main thread and are transferred from there. On the
//   web the whole client may instead live in the application's own Worker; `inThreadArrowDecoder`
//   (`arrow-decoder.ts`) then decodes in that Worker without a second one.
// - Credits (spec §6): the next chunk is taken from the stream, which is what grants the server
//   a credit, only after the Worker decoded the previous chunk and the consumer came back for
//   more batches. A slow consumer of `batches()` therefore slows the server down.

import type { StreamCall } from "./contract.js";
import { RpcError, localError } from "./errors.js";

/** A typed array as Arrow uses them for values, offsets and type ids. */
export type ArrowBuffer =
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array
  | BigInt64Array
  | BigUint64Array;

/** One field of the stream's schema. */
export interface ArrowField {
  readonly name: string;
  /** The Arrow type as apache-arrow prints it, e.g. `Int64`, `Utf8`, `Timestamp<MICROSECOND>`. */
  readonly type: string;
  /** apache-arrow's `Type` enum value of the type. */
  readonly typeId: number;
  readonly nullable: boolean;
  /** Child fields of a nested type (struct, list, map, union). */
  readonly children: readonly ArrowField[];
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * One Arrow array as its buffers, laid out as the Arrow columnar format says (the fields of
 * apache-arrow's `Data`). Which buffers exist depends on the type: fixed-width types have
 * `values`; Utf8 and Binary have `offsets` (element `i` is `values[offsets[i]..offsets[i + 1]]`);
 * nested types have `children`. A buffer may be longer than its `length` elements need: it keeps
 * the padding of the IPC message.
 */
export interface ArrowData {
  readonly type: string;
  readonly typeId: number;
  /** Number of elements. */
  readonly length: number;
  readonly nullCount: number;
  /** Index of the first element in the buffers; 0 for decoded IPC. */
  readonly offset: number;
  /** Validity bitmap, least-significant bit first: bit `i` set means element `i` is not null. */
  readonly validity?: Uint8Array;
  readonly offsets?: Int32Array | BigInt64Array;
  readonly values?: ArrowBuffer;
  /** Union type ids. */
  readonly typeIds?: Int8Array;
  /** Data buffers of view types (Utf8View, BinaryView). */
  readonly variadic?: readonly Uint8Array[];
  readonly children: readonly ArrowData[];
  /** Dictionary-encoded arrays: the dictionary's chunks, in index order. */
  readonly dictionary?: readonly ArrowData[];
}

/** One record batch: `columns[i]` belongs to field `i` of the schema. */
export interface ArrowBatch {
  readonly numRows: number;
  readonly columns: readonly ArrowData[];
}

/** Whether element `row` of `data` is not null. */
export function arrowIsValid(data: ArrowData, row: number): boolean {
  const bitmap = data.validity;
  if (bitmap === undefined || data.nullCount === 0) return true;
  const bit = data.offset + row;
  return ((bitmap[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
}

/**
 * Where the decoder runs: a Web `Worker` started from `@byterygon/ambidex/arrow-worker`, a
 * `MessagePort` to one, or `inThreadArrowDecoder()`. One decoder serves any number of streams.
 */
export interface ArrowDecoderPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
  removeEventListener(type: string, listener: (event: { readonly data?: unknown }) => void): void;
}

/** Marks the messages of this protocol on a port shared with other traffic. */
export const ARROW_CHANNEL = "ambidex.arrow.v1";

/** Messages to the decoder. `stream` is chosen by the sender, unique per port. */
export type ArrowDecoderRequest =
  | { readonly channel: typeof ARROW_CHANNEL; readonly op: "open"; readonly stream: number }
  | {
      readonly channel: typeof ARROW_CHANNEL;
      readonly op: "chunk";
      readonly stream: number;
      readonly bytes: Uint8Array;
    }
  /** No more chunks: finish what was received. */
  | { readonly channel: typeof ARROW_CHANNEL; readonly op: "end"; readonly stream: number }
  /** Forget the stream; nothing more is posted for it. */
  | { readonly channel: typeof ARROW_CHANNEL; readonly op: "abort"; readonly stream: number };

/** Messages from the decoder, in order per stream. */
export type ArrowDecoderReply =
  | {
      readonly channel: typeof ARROW_CHANNEL;
      readonly op: "schema";
      readonly stream: number;
      readonly fields: readonly ArrowField[];
    }
  | {
      readonly channel: typeof ARROW_CHANNEL;
      readonly op: "batch";
      readonly stream: number;
      readonly batch: ArrowBatch;
    }
  /** Everything in the first `consumed` chunks was decoded and posted; the decoder wants more. */
  | {
      readonly channel: typeof ARROW_CHANNEL;
      readonly op: "idle";
      readonly stream: number;
      readonly consumed: number;
    }
  /** The IPC stream ended (its end-of-stream marker, or `end`); later chunks are ignored. */
  | { readonly channel: typeof ARROW_CHANNEL; readonly op: "done"; readonly stream: number }
  /** The bytes are not an Arrow IPC stream. No message text: it could quote the data. */
  | { readonly channel: typeof ARROW_CHANNEL; readonly op: "error"; readonly stream: number };

/** A stream call whose chunks are decoded as Arrow record batches. */
export interface ArrowStream<T> {
  /**
   * The schema: resolves as soon as the first chunk was decoded, before any batch is read, and
   * also for a result without rows. Rejects with the stream's error if it fails first.
   */
  readonly schema: Promise<readonly ArrowField[]>;
  /** The record batches, in order; iterate once. Leaving the loop early cancels the stream. */
  batches(): AsyncIterable<ArrowBatch>;
  /** The stream's final result. */
  readonly result: Promise<T>;
  /** Cancels the stream. */
  cancel(): void;
}

let nextStream = 1;

function isReply(data: unknown, stream: number): data is ArrowDecoderReply {
  if (typeof data !== "object" || data === null) return false;
  const m = data as { channel?: unknown; stream?: unknown };
  return m.channel === ARROW_CHANNEL && m.stream === stream;
}

/**
 * Decodes the Arrow IPC chunks of `stream` on `port` (see the top of this file). Starts at once:
 * the schema is read without waiting for a consumer, record batches only as `batches()` is read.
 *
 * Fails with a local `Internal` error, and cancels the stream, when the chunks are not an Arrow
 * IPC stream or the decoder stops answering (its Worker failed to load, e.g. without
 * apache-arrow installed).
 */
export function decodeArrow<T>(
  stream: StreamCall<T, Uint8Array>,
  port: ArrowDecoderPort,
): ArrowStream<T> {
  const id = nextStream++;
  const post = (message: ArrowDecoderRequest, transfer: Transferable[] = []): void =>
    port.postMessage(message, transfer);

  // Decoded batches the consumer has not taken yet (the batches of at most one chunk).
  const ready: ArrowBatch[] = [];
  let finished = false;
  let failure: unknown;
  let reader:
    | { resolve: (r: IteratorResult<ArrowBatch>) => void; reject: (e: unknown) => void }
    | undefined;
  // Wakes the pump: a decoder message arrived, the consumer asked for a batch, or it left.
  let wake: (() => void) | undefined;
  const signal = (): void => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  const until = async (condition: () => boolean): Promise<void> => {
    while (!condition()) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  };

  let fields: readonly ArrowField[] | undefined;
  let resolveSchema!: (fields: readonly ArrowField[]) => void;
  let rejectSchema!: (error: unknown) => void;
  const schema = new Promise<readonly ArrowField[]>((resolve, reject) => {
    resolveSchema = resolve;
    rejectSchema = reject;
  });
  // A caller that only reads `batches()` sees the error there.
  schema.catch(() => {});

  let consumed = 0;
  let decoderDone = false;
  let decoderFailed = false;
  let left = false;

  const deliver = (): void => {
    if (reader === undefined) return;
    const batch = ready.shift();
    if (batch !== undefined) {
      const r = reader;
      reader = undefined;
      r.resolve({ value: batch, done: false });
    } else if (finished) {
      const r = reader;
      reader = undefined;
      if (failure !== undefined) {
        const error = failure;
        failure = undefined;
        r.reject(error);
      } else r.resolve({ value: undefined, done: true });
    }
  };

  const onMessage = (event: { readonly data?: unknown }): void => {
    const message = event.data;
    if (!isReply(message, id)) return;
    switch (message.op) {
      case "schema":
        fields = message.fields;
        resolveSchema(message.fields);
        break;
      case "batch":
        ready.push(message.batch);
        deliver();
        break;
      case "idle":
        consumed = Math.max(consumed, message.consumed);
        break;
      case "done":
        decoderDone = true;
        break;
      case "error":
        decoderFailed = true;
        break;
    }
    signal();
  };
  const onDecoderError = (): void => {
    decoderFailed = true;
    signal();
  };
  port.addEventListener("message", onMessage);
  port.addEventListener("error", onDecoderError);
  port.addEventListener("messageerror", onDecoderError);

  const decodeFailed = (): RpcError => localError("Internal", "Arrow decoding failed");

  const pump = async (): Promise<void> => {
    post({ channel: ARROW_CHANNEL, op: "open", stream: id });
    let sent = 0;
    for await (const chunk of stream.chunks()) {
      // After the end-of-stream marker nothing more is Arrow; read on to the stream's end.
      if (decoderDone) continue;
      // The chunk owns its buffer (see `StreamHandle`): transferred, not copied.
      post({ channel: ARROW_CHANNEL, op: "chunk", stream: id, bytes: chunk }, [chunk.buffer]);
      sent += 1;
      await until(() => consumed >= sent || decoderDone || decoderFailed || left);
      if (decoderFailed) throw decodeFailed();
      // Take the next chunk (and so grant its credit) only when the consumer is waiting for a
      // batch; until the schema arrived, read on without one.
      await until(
        () => left || fields === undefined || (reader !== undefined && ready.length === 0),
      );
      if (left) return;
    }
    if (!decoderDone) {
      post({ channel: ARROW_CHANNEL, op: "end", stream: id });
      await until(() => decoderDone || decoderFailed || left);
      if (decoderFailed) throw decodeFailed();
    }
    if (fields === undefined && !left) throw decodeFailed();
  };

  const settle = (error?: unknown): void => {
    port.removeEventListener("message", onMessage);
    port.removeEventListener("error", onDecoderError);
    port.removeEventListener("messageerror", onDecoderError);
    if (!decoderDone) post({ channel: ARROW_CHANNEL, op: "abort", stream: id });
    finished = true;
    failure = error;
    // Without effect once the schema arrived.
    rejectSchema(error ?? localError("Cancelled", "call cancelled"));
    deliver();
  };
  pump().then(
    () => settle(),
    (error: unknown) => settle(error),
  );

  /** The consumer is gone: stop the pump and the stream. */
  const leave = (): void => {
    left = true;
    ready.length = 0;
    stream.cancel();
    signal();
  };

  let iterating = false;
  const iterator: AsyncIterableIterator<ArrowBatch> = {
    next: () =>
      new Promise<IteratorResult<ArrowBatch>>((resolve, reject) => {
        if (reader !== undefined) {
          reject(new TypeError("next() called before the previous one settled"));
          return;
        }
        if (left) {
          resolve({ value: undefined, done: true });
          return;
        }
        reader = { resolve, reject };
        deliver();
        signal();
      }),
    return: (value?: unknown) => {
      leave();
      return Promise.resolve({ value: value as ArrowBatch, done: true });
    },
    throw: (error?: unknown) => {
      leave();
      return Promise.reject(error);
    },
    [Symbol.asyncIterator]: () => iterator,
  };

  return {
    schema,
    result: stream.result,
    batches: () => {
      if (iterating) throw new TypeError("already being iterated");
      iterating = true;
      return { [Symbol.asyncIterator]: () => iterator };
    },
    cancel: () => stream.cancel(),
  };
}

/** The `ArrayBuffer`s of a batch, to transfer it on to another thread without a copy. */
export function arrowTransferables(batch: ArrowBatch): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const visit = (data: ArrowData): void => {
    for (const view of [data.validity, data.offsets, data.values, data.typeIds]) {
      if (view !== undefined && view.buffer instanceof ArrayBuffer) seen.add(view.buffer);
    }
    for (const view of data.variadic ?? []) {
      if (view.buffer instanceof ArrayBuffer) seen.add(view.buffer);
    }
    for (const child of data.children) visit(child);
    for (const chunk of data.dictionary ?? []) visit(chunk);
  };
  for (const column of batch.columns) visit(column);
  return [...seen];
}
