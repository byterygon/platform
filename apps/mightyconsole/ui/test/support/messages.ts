// Message batches of Mightyconsole spec §5.1 built with apache-arrow, as mightyconsole-server's
// `core::messaging::arrow` writes them, and a stream call that counts what the view pulled.
import * as A from "apache-arrow";
import { ipcChunks } from "../../../../../packages/data-grid/test/support.ts";

export interface TestMessage {
  partition?: number;
  offset?: bigint;
  subject?: string;
  sequence?: bigint;
  timestampUs?: bigint;
  key?: string;
  value: string;
  codec?: string;
  schemaRef?: string;
  decodeError?: string;
  headers?: [string, string, "text" | "base64"][];
  size?: number;
  truncated?: boolean;
}

const enc = new TextEncoder();

/** A §5.1 table with one batch per `batchRows` messages. */
export function messageTable(messages: readonly TestMessage[], batchRows = messages.length || 1): A.Table {
  const batches: A.RecordBatch[] = [];
  for (let start = 0; start < messages.length; start += batchRows) {
    const ms = messages.slice(start, start + batchRows);
    const col = <T extends A.DataType>(type: T, values: unknown[]) => A.vectorFromArray(values as never, type);
    const data = {
      rowId: col(new A.Uint64(), ms.map((_, i) => BigInt(start + i))),
      source: col(new A.Utf8(), ms.map(() => "echo")),
      subject: col(new A.Utf8(), ms.map((m) => m.subject ?? null)),
      partition: col(new A.Int32(), ms.map((m) => m.partition ?? null)),
      offset: col(new A.Int64(), ms.map((m) => m.offset ?? null)),
      sequence: col(new A.Uint64(), ms.map((m) => m.sequence ?? null)),
      timestamp: A.makeVector(
        A.makeData({
          type: new A.TimestampMicrosecond("UTC"),
          length: ms.length,
          nullCount: 0,
          data: BigInt64Array.from(ms, (m, i) => m.timestampUs ?? 1_794_960_000_000_000n + BigInt(start + i)),
        }),
      ),
      timestampKind: col(new A.Utf8(), ms.map(() => "create")),
      operation: col(new A.Utf8(), ms.map(() => null)),
      replyTo: col(new A.Utf8(), ms.map(() => null)),
      headers: col(new A.Utf8(), ms.map((m) => JSON.stringify(m.headers ?? []))),
      keyRaw: col(new A.Binary(), ms.map((m) => (m.key === undefined ? null : enc.encode(m.key)))),
      keyText: col(new A.Utf8(), ms.map((m) => m.key ?? null)),
      keyCodec: col(new A.Utf8(), ms.map((m) => (m.key === undefined ? null : "utf8"))),
      payloadRaw: col(new A.Binary(), ms.map((m) => enc.encode(m.value))),
      payloadSize: col(new A.Int64(), ms.map((m) => BigInt(m.size ?? enc.encode(m.value).length))),
      payloadTruncated: col(new A.Bool(), ms.map((m) => m.truncated ?? false)),
      payloadText: col(new A.Utf8(), ms.map((m) => m.value)),
      payloadCodec: col(new A.Utf8(), ms.map((m) => m.codec ?? "json")),
      schemaRef: col(new A.Utf8(), ms.map((m) => m.schemaRef ?? null)),
      decodeError: col(new A.Utf8(), ms.map((m) => m.decodeError ?? null)),
    };
    const table = new A.Table(data);
    batches.push(...table.batches);
  }
  const schema = new A.Schema(batches[0]!.schema.fields, new Map([["mightyconsole.schema", "message/1"]]));
  return new A.Table(schema, batches.map((b) => new A.RecordBatch(schema, b.data)));
}

/** A stream call yielding the table's IPC chunks one per pull, counting the pulls; then `result`. */
export function messageCall<T>(t: A.Table, result: T, options: { endless?: boolean; delayMs?: number } = {}) {
  const chunks = ipcChunks(t);
  const state = { pulled: 0, cancelled: false };
  let wake: () => void = () => {};
  const cancelled = new Promise<void>((r) => (wake = r));
  let finish: (v: T) => void = () => {};
  const done = new Promise<T>((resolve) => (finish = resolve));
  const call = {
    chunks: async function* () {
      for (const chunk of chunks) {
        if (state.cancelled) return;
        if (options.delayMs) await new Promise<void>((r) => setTimeout(r, options.delayMs));
        state.pulled += 1;
        yield chunk.slice();
      }
      if (options.endless) await cancelled;
      finish(result);
    },
    // As a real stream call: cancelling rejects the result with Cancelled.
    result: Promise.race([done, cancelled.then(() => Promise.reject(Object.assign(new Error("cancelled"), { code: "Cancelled" })))]),
    cancel: () => {
      state.cancelled = true;
      wake();
    },
  };
  return { call, state, chunks: chunks.length };
}
