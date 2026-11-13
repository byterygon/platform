// The Arrow IPC decoder behind `decodeArrow` (`arrow.ts`): runs apache-arrow's
// `RecordBatchReader` over the chunks of each stream and posts the record batches back as plain
// buffers. This is the only module of the package that imports apache-arrow (an optional peer
// dependency); it is meant to run in a Worker, started by `arrow-worker.ts`.
//
// Each record batch is copied once, here, into one `ArrayBuffer` that is then transferred: the
// reader's own buffers stay with the reader, and the receiving thread gets every column of the
// batch as views of a single buffer, without a copy on its side.

import { type Data, type Field, RecordBatchReader, type Vector } from "apache-arrow";

import {
  ARROW_CHANNEL,
  type ArrowBatch,
  type ArrowBuffer,
  type ArrowData,
  type ArrowDecoderPort,
  type ArrowDecoderReply,
  type ArrowDecoderRequest,
  type ArrowField,
} from "./arrow.js";

/** The side of a port the decoder serves: a Worker's global scope, or a `MessagePort`. */
export interface ArrowDecoderScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { readonly data?: unknown }) => void): void;
}

type ArrowView = ArrowBuffer;

function describeField(field: Field): ArrowField {
  const children = (field.type as { children?: Field[] | null }).children ?? [];
  return {
    name: field.name,
    type: String(field.type),
    typeId: field.typeId,
    nullable: field.nullable,
    children: children.map(describeField),
    metadata: Object.fromEntries(field.metadata),
  };
}

/** Where a buffer goes in the description, and the reader's view of it (not yet copied). */
type Views = Array<{ owner: Record<string, unknown>; key: string | number; view: ArrowView }>;

function describeData(data: Data, out: Views): ArrowData {
  const described: Record<string, unknown> = {
    type: String(data.type),
    typeId: data.typeId,
    length: data.length,
    nullCount: data.nullCount,
    offset: data.offset,
    children: data.children.map((child) => describeData(child, out)),
  };
  const buffers: Array<[string, ArrowView | null | undefined]> = [
    // Without nulls the bitmap carries nothing (and the reader may not have one).
    ["validity", data.nullCount > 0 ? (data.nullBitmap as Uint8Array | null | undefined) : undefined],
    ["offsets", data.valueOffsets as ArrowView | null | undefined],
    ["values", data.values as ArrowView | null | undefined],
    ["typeIds", data.typeIds as ArrowView | null | undefined],
  ];
  for (const [key, view] of buffers) {
    if (view === null || view === undefined || !ArrayBuffer.isView(view)) continue;
    out.push({ owner: described, key, view });
  }
  const variadic = data.variadicBuffers ?? [];
  if (variadic.length > 0) {
    const copies: Uint8Array[] = [];
    described["variadic"] = copies;
    variadic.forEach((view, index) => {
      out.push({ owner: copies as unknown as Record<string, unknown>, key: index, view });
    });
  }
  const dictionary = data.dictionary as Vector | undefined;
  if (dictionary !== undefined && dictionary !== null) {
    described["dictionary"] = dictionary.data.map((chunk) => describeData(chunk, out));
  }
  return described as unknown as ArrowData;
}

/** Copies the batch's buffers into one `ArrayBuffer`; returns the batch and that buffer. */
function packBatch(numRows: number, columns: readonly Data[]): [ArrowBatch, ArrayBuffer] {
  const views: Views = [];
  const described = columns.map((column) => describeData(column, views));
  // 8-byte alignment fits every typed array element size.
  const align = (n: number): number => (n + 7) & ~7;
  let size = 0;
  for (const { view } of views) size = align(size) + view.byteLength;
  const packed = new ArrayBuffer(size);
  const bytes = new Uint8Array(packed);
  let at = 0;
  for (const { owner, key, view } of views) {
    at = align(at);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), at);
    const ViewType = view.constructor as new (
      buffer: ArrayBuffer,
      byteOffset: number,
      length: number,
    ) => ArrowView;
    owner[key] = new ViewType(packed, at, view.length);
    at += view.byteLength;
  }
  return [{ numRows, columns: described }, packed];
}

const EMPTY = new Uint8Array(0);

/** The chunks of one stream as the reader pulls them. */
class ChunkSource implements AsyncIterableIterator<Uint8Array> {
  #queue: Uint8Array[] = [];
  #ended = false;
  #pulled = 0;
  #waiter: ((r: IteratorResult<Uint8Array>) => void) | undefined;

  /** `onIdle(n)`: the reader took `n` chunks and waits for another. */
  constructor(private readonly onIdle: (consumed: number) => void) {}

  push(bytes: Uint8Array): void {
    if (this.#ended) return;
    const waiter = this.#waiter;
    if (waiter !== undefined) {
      this.#waiter = undefined;
      this.#pulled += 1;
      waiter({ value: bytes, done: false });
    } else this.#queue.push(bytes);
  }

  end(): void {
    this.#ended = true;
    this.#queue = [];
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.({ value: undefined, done: true });
  }

  /**
   * `wanted` is how many more bytes apache-arrow's byte stream needs. It asks for 0 more when a
   * read ends exactly where a chunk ends, which is every message here (chunks hold whole IPC
   * messages), and would wait for the next chunk before returning bytes it already has: each
   * batch would come out one chunk late, and the last only at the end of the stream. An empty
   * answer lets that read return at once, so a pull that waits means the reader really has
   * handed out everything it was given.
   */
  next(wanted?: number): Promise<IteratorResult<Uint8Array>> {
    if (wanted === 0) return Promise.resolve({ value: EMPTY, done: false });
    const bytes = this.#queue.shift();
    if (bytes !== undefined) {
      this.#pulled += 1;
      return Promise.resolve({ value: bytes, done: false });
    }
    if (this.#ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.#waiter = resolve;
      this.onIdle(this.#pulled);
    });
  }

  return(): Promise<IteratorResult<Uint8Array>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
}

function isRequest(data: unknown): data is ArrowDecoderRequest {
  if (typeof data !== "object" || data === null) return false;
  const m = data as { channel?: unknown; stream?: unknown; op?: unknown };
  return m.channel === ARROW_CHANNEL && typeof m.stream === "number" && typeof m.op === "string";
}

/**
 * Serves `decodeArrow` requests arriving on `scope`. Call once per port; in a dedicated Worker
 * `arrow-worker.ts` does it for the Worker's global scope.
 */
export function serveArrowDecoder(scope: ArrowDecoderScope): void {
  const streams = new Map<number, ChunkSource>();
  const reply = (message: ArrowDecoderReply, transfer: Transferable[] = []): void =>
    scope.postMessage(message, transfer);

  const run = async (stream: number, source: ChunkSource): Promise<void> => {
    const live = (): boolean => streams.get(stream) === source;
    try {
      const reader = await RecordBatchReader.from(source);
      await reader.open();
      if (!live()) return;
      // No schema: the stream ended before its first message.
      if (reader.schema === undefined || reader.schema === null) throw new Error("no schema");
      reply({
        channel: ARROW_CHANNEL,
        op: "schema",
        stream,
        fields: reader.schema.fields.map(describeField),
      });
      for await (const batch of reader) {
        if (!live()) return;
        const [packed, buffer] = packBatch(batch.numRows, batch.data.children);
        reply({ channel: ARROW_CHANNEL, op: "batch", stream, batch: packed }, [buffer]);
      }
      if (live()) reply({ channel: ARROW_CHANNEL, op: "done", stream });
    } catch {
      if (live()) reply({ channel: ARROW_CHANNEL, op: "error", stream });
    } finally {
      if (live()) streams.delete(stream);
      source.end();
    }
  };

  scope.addEventListener("message", (event) => {
    const message = event.data;
    if (!isRequest(message)) return;
    const { stream } = message;
    switch (message.op) {
      case "open": {
        if (streams.has(stream)) return;
        const source = new ChunkSource((consumed) => {
          if (streams.get(stream) === source) {
            reply({ channel: ARROW_CHANNEL, op: "idle", stream, consumed });
          }
        });
        streams.set(stream, source);
        void run(stream, source);
        return;
      }
      case "chunk":
        streams.get(stream)?.push(message.bytes);
        return;
      case "end":
        streams.get(stream)?.end();
        return;
      case "abort": {
        const source = streams.get(stream);
        streams.delete(stream);
        source?.end();
        return;
      }
    }
  });
}

/**
 * A decoder in the calling thread, for a client that itself lives in a Worker (the WebSocket
 * transport can): the same `decodeArrow`, without a second Worker. Messages are delivered
 * asynchronously, in order; nothing is copied.
 */
export function inThreadArrowDecoder(): ArrowDecoderPort {
  type Listener = (event: { readonly data?: unknown }) => void;
  const side = (): { listeners: Set<Listener>; deliver: (data: unknown) => void } => {
    const listeners = new Set<Listener>();
    return {
      listeners,
      deliver: (data) => queueMicrotask(() => listeners.forEach((l) => l({ data }))),
    };
  };
  const toDecoder = side();
  const toCaller = side();
  serveArrowDecoder({
    postMessage: (message) => toCaller.deliver(message),
    addEventListener: (_type, listener) => void toDecoder.listeners.add(listener),
  });
  return {
    postMessage: (message) => toDecoder.deliver(message),
    addEventListener: (type, listener) => {
      if (type === "message") toCaller.listeners.add(listener);
    },
    removeEventListener: (type, listener) => {
      if (type === "message") toCaller.listeners.delete(listener);
    },
  };
}
