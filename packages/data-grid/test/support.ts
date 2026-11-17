// Test fixtures: record batches with the schema the PostgreSQL driver emits
// (crates/db-driver-postgres/src/batch.rs: field types, `byterygon.pg.type_oid` metadata, the uuid
// extension name), built with apache-arrow, written as Arrow IPC and read back through the real
// `decodeArrow` and decoder. The grid therefore sees exactly the buffers DBee's Worker hands it.
// apache-arrow is a dev dependency of the tests only; nothing in src/ imports it.
import * as A from "apache-arrow";
import { type ArrowBatch, type ArrowField, decodeArrow } from "@byterygon/ambidex/arrow";
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";

/** A null in a fixture column. */
export const NULL = null;

type Col =
  | { kind: "bool"; values: (boolean | null)[] }
  | { kind: "int16" | "int32" | "uint32" | "float32" | "float64" | "date32"; values: (number | null)[] }
  | { kind: "int64" | "time64" | "timestamp" | "timestamptz"; values: (bigint | null)[] }
  | { kind: "utf8"; values: (string | null)[] }
  | { kind: "binary" | "uuid"; values: (Uint8Array | null)[] };

/** The PostgreSQL OIDs the driver puts on each field (batch.rs `Kind::of`). */
const OIDS: Record<Col["kind"], string> = {
  bool: "16",
  int16: "21",
  int32: "23",
  int64: "20",
  uint32: "26",
  float32: "700",
  float64: "701",
  utf8: "25",
  binary: "17",
  uuid: "2950",
  date32: "1082",
  time64: "1083",
  timestamp: "1114",
  timestamptz: "1184",
};

function bitmap(values: readonly unknown[]): { bits: Uint8Array; nulls: number } {
  const bits = new Uint8Array(Math.ceil(values.length / 8) + 8);
  let nulls = 0;
  values.forEach((v, i) => {
    if (v === null) nulls += 1;
    else bits[i >> 3]! |= 1 << (i & 7);
  });
  return { bits, nulls };
}

function typeOf(col: Col): A.DataType {
  switch (col.kind) {
    case "bool":
      return new A.Bool();
    case "int16":
      return new A.Int16();
    case "int32":
      return new A.Int32();
    case "int64":
      return new A.Int64();
    case "uint32":
      return new A.Uint32();
    case "float32":
      return new A.Float32();
    case "float64":
      return new A.Float64();
    case "utf8":
      return new A.Utf8();
    case "binary":
      return new A.Binary();
    case "uuid":
      return new A.FixedSizeBinary(16);
    case "date32":
      return new A.DateDay();
    case "time64":
      return new A.TimeMicrosecond();
    case "timestamp":
      return new A.TimestampMicrosecond();
    case "timestamptz":
      return new A.TimestampMicrosecond("UTC");
  }
}

function dataOf(col: Col): A.Data {
  const type = typeOf(col);
  const length = col.values.length;
  const { bits, nulls } = bitmap(col.values);
  const base = { type, length, nullCount: nulls, nullBitmap: bits } as const;
  switch (col.kind) {
    case "bool": {
      const data = new Uint8Array(Math.ceil(length / 8) + 8);
      col.values.forEach((v, i) => {
        if (v) data[i >> 3]! |= 1 << (i & 7);
      });
      return A.makeData({ ...base, type: type as A.Bool, data });
    }
    case "int16":
      return A.makeData({ ...base, type: type as A.Int16, data: Int16Array.from(col.values, (v) => v ?? 0) });
    case "int32":
      return A.makeData({ ...base, type: type as A.Int32, data: Int32Array.from(col.values, (v) => v ?? 0) });
    case "date32":
      return A.makeData({ ...base, type: type as A.DateDay, data: Int32Array.from(col.values, (v) => v ?? 0) });
    case "uint32":
      return A.makeData({ ...base, type: type as A.Uint32, data: Uint32Array.from(col.values, (v) => v ?? 0) });
    case "float32":
      return A.makeData({ ...base, type: type as A.Float32, data: Float32Array.from(col.values, (v) => v ?? 0) });
    case "float64":
      return A.makeData({ ...base, type: type as A.Float64, data: Float64Array.from(col.values, (v) => v ?? 0) });
    case "int64":
      return A.makeData({ ...base, type: type as A.Int64, data: BigInt64Array.from(col.values, (v) => v ?? 0n) });
    case "time64":
      return A.makeData({ ...base, type: type as A.TimeMicrosecond, data: BigInt64Array.from(col.values, (v) => v ?? 0n) });
    case "timestamp":
    case "timestamptz":
      return A.makeData({ ...base, type: type as A.TimestampMicrosecond, data: BigInt64Array.from(col.values, (v) => v ?? 0n) });
    case "uuid": {
      const data = new Uint8Array(16 * length);
      col.values.forEach((v, i) => {
        if (v) data.set(v, 16 * i);
      });
      return A.makeData({ ...base, type: type as A.FixedSizeBinary, data });
    }
    case "utf8":
    case "binary": {
      const encoder = new TextEncoder();
      const parts = col.values.map((v) => (v === null ? new Uint8Array() : typeof v === "string" ? encoder.encode(v) : v));
      const offsets = new Int32Array(length + 1);
      parts.forEach((p, i) => (offsets[i + 1] = offsets[i]! + p.length));
      const data = new Uint8Array(offsets[length]!);
      parts.forEach((p, i) => data.set(p, offsets[i]!));
      return A.makeData({ ...base, type: type as A.Utf8, valueOffsets: offsets, data });
    }
  }
}

/** A result built from named columns; `batches` gives the row count of each batch (default: one). */
export function table(columns: Record<string, Col>, batchRows?: readonly number[]): A.Table {
  const names = Object.keys(columns);
  const fields = names.map((name) => {
    const col = columns[name]!;
    const metadata = new Map([["byterygon.pg.type_oid", OIDS[col.kind]]]);
    if (col.kind === "uuid") {
      metadata.set("ARROW:extension:name", "arrow.uuid");
      metadata.set("ARROW:extension:metadata", "");
    }
    return new A.Field(name, typeOf(col), true, metadata);
  });
  const schema = new A.Schema(fields);
  const total = columns[names[0]!]!.values.length;
  const sizes = batchRows ?? [total];
  const batches: A.RecordBatch[] = [];
  let start = 0;
  for (const size of sizes) {
    const children = names.map((name) => {
      const col = columns[name]!;
      return dataOf({ ...col, values: col.values.slice(start, start + size) } as Col);
    });
    const struct = A.makeData({ type: new A.Struct(fields), length: size, nullCount: 0, children });
    batches.push(new A.RecordBatch(schema, struct));
    start += size;
  }
  return new A.Table(schema, batches);
}

/** A stream call that yields `chunks` (each owning its buffer) and then `result`. */
export function streamCall<T>(chunks: readonly Uint8Array[], result: T) {
  let cancelled = false;
  return {
    get cancelled() {
      return cancelled;
    },
    chunks: async function* () {
      for (const chunk of chunks) {
        if (cancelled) return;
        yield chunk.slice();
      }
    },
    result: Promise.resolve(result),
    cancel: () => {
      cancelled = true;
    },
  };
}

/** The IPC messages of a table, one chunk per message (as the Rust `ArrowSink` sends them). */
export function ipcChunks(t: A.Table): Uint8Array[] {
  const bytes = A.tableToIPC(t, "stream");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  // Each encapsulated message: 0xFFFFFFFF, Int32 metadata length, metadata, body.
  let at = 0;
  while (at < bytes.byteLength) {
    const metadata = view.getInt32(at + 4, true);
    let end = at + 8 + metadata;
    if (metadata > 0) end += bodyLength(bytes.subarray(at + 8, at + 8 + metadata));
    out.push(bytes.slice(at, end));
    at = end;
  }
  return out;
}

/** `Message.bodyLength` (field 3) of a flatbuffer-encoded IPC message (as packages/ambidex's test). */
function bodyLength(metadata: Uint8Array): number {
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
  const tableAt = view.getUint32(0, true);
  const vtable = tableAt - view.getInt32(tableAt, true);
  const slot = 4 + 3 * 2;
  if (slot >= view.getUint16(vtable, true)) return 0;
  const field = view.getUint16(vtable + slot, true);
  return field === 0 ? 0 : Number(view.getBigInt64(tableAt + field, true));
}

/** Decodes a table through `decodeArrow` and the in-thread decoder: schema and batches as the grid gets them. */
export async function decoded(t: A.Table): Promise<{ fields: readonly ArrowField[]; batches: ArrowBatch[] }> {
  const stream = decodeArrow(streamCall(ipcChunks(t), null), inThreadArrowDecoder());
  const fields = await stream.schema;
  const batches: ArrowBatch[] = [];
  for await (const batch of stream.batches()) batches.push(batch);
  return { fields, batches };
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));

export const UUID = hexBytes("123e4567e89b12d3a456426614174000");
export const LONG_BYTES = Uint8Array.from({ length: 40 }, (_, i) => i);

/** Microseconds since 1970 of a UTC date and time. */
export const micros = (iso: string, fraction = 0n): bigint => BigInt(Date.parse(`${iso}Z`)) * 1000n + fraction;

/** One column of every type the driver emits, with the values and edge cases of spec §6. */
export function driverTable(): A.Table {
  const long = `${"x".repeat(1200)}`;
  return table({
    b: { kind: "bool", values: [true, false, NULL, true] },
    i2: { kind: "int16", values: [-32768, 0, NULL, 32767] },
    i4: { kind: "int32", values: [-2147483648, 42, NULL, 2147483647] },
    i8: { kind: "int64", values: [9223372036854775807n, -9223372036854775808n, NULL, 9007199254740993n] },
    oid: { kind: "uint32", values: [4294967295, 26, NULL, 0] },
    f4: { kind: "float32", values: [0.1, -0, NULL, Number.NaN] },
    f8: { kind: "float64", values: [0.1, -0, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY] },
    t: { kind: "utf8", values: ["hello\nworld", "", NULL, long] },
    by: { kind: "binary", values: [new Uint8Array([0xde, 0xad]), LONG_BYTES, NULL, new Uint8Array()] },
    u: { kind: "uuid", values: [UUID, NULL, UUID, NULL] },
    d: { kind: "date32", values: [0, 19_000, -2147483648, 2147483647] },
    tm: { kind: "time64", values: [0n, 45_296_123_456n, NULL, 86_400_000_000n] },
    ts: { kind: "timestamp", values: [micros("2024-02-29T13:45:01", 500_000n), 0n, -(1n << 63n), (1n << 63n) - 1n] },
    tz: { kind: "timestamptz", values: [micros("1999-12-31T23:59:59", 123_456n), NULL, -1n, micros("2000-01-01T00:00:00")] },
  });
}

/**
 * A stream of `t`'s IPC messages that counts the chunks taken (each one a credit granted to the
 * server, Ambidex spec §6) and records `cancel()`; `garbage` replaces the batches with bytes that
 * are not Arrow after the schema.
 */
export function countingStream(t: A.Table, options: { garbage?: boolean } = {}) {
  const chunks = ipcChunks(t);
  if (options.garbage) chunks.splice(1, chunks.length - 1, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  let taken = 0;
  let cancelled = false;
  let release: (() => void) | undefined;
  const call = {
    chunks: async function* () {
      for (const chunk of chunks) {
        if (cancelled) return;
        taken += 1;
        yield chunk.slice();
      }
    },
    result: new Promise<null>((resolve) => {
      release = () => resolve(null);
    }),
    cancel: () => {
      cancelled = true;
      release?.();
    },
  };
  void call.result;
  const stream = decodeArrow(call, inThreadArrowDecoder());
  return {
    stream,
    /** Chunks taken from the transport so far (schema, batches, end-of-stream). */
    get taken() {
      return taken;
    },
    get cancelled() {
      return cancelled;
    },
    /** IPC messages in the stream. */
    total: chunks.length,
  };
}

/** Resolves after pending microtasks and a macrotask: lets a stream pump settle. */
export const settle = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** An `ids` table of `rows` Int64 ids and a text column, in batches of `batchRows`. */
export function idTable(rows: number, batchRows: number): A.Table {
  const ids = Array.from({ length: rows }, (_, i) => i);
  return table(
    {
      id: { kind: "int64", values: ids.map(BigInt) },
      name: { kind: "utf8", values: ids.map((i) => (i % 10 === 3 ? null : `name ${i}`)) },
    },
    Array.from({ length: Math.ceil(rows / batchRows) }, (_, k) => Math.min(batchRows, rows - k * batchRows)),
  );
}
