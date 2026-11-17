// Synthetic record batches shaped like the PostgreSQL driver's (the same Arrow types and buffers
// decodeArrow yields), built directly in JavaScript: the demo and the browser measurement need
// a million rows without a database or apache-arrow.
import type { ArrowBatch, ArrowData, ArrowField, ArrowStream } from "@byterygon/ambidex/arrow";

const field = (name: string, type: string, typeId: number, metadata: Record<string, string> = {}): ArrowField => ({ name, type, typeId, nullable: true, children: [], metadata });

/** Ten columns: int8, int4, float8, text, bool, timestamptz, date, uuid, text with NULLs, bytea. */
export const SYNTHETIC_FIELDS: readonly ArrowField[] = [
  field("id", "Int64", 2),
  field("qty", "Int32", 2),
  field("price", "Float64", 3),
  field("name", "Utf8", 5),
  field("active", "Bool", 6),
  field("created_at", "Timestamp<MICROSECOND, UTC>", 10),
  field("day", "Date32<DAY>", 8),
  field("uid", "FixedSizeBinary[16]", 15, { "ARROW:extension:name": "arrow.uuid" }),
  field("note", "Utf8", 5),
  field("blob", "Binary", 4),
];

const enc = new TextEncoder();
const fixed = (type: string, typeId: number, length: number, values: NonNullable<ArrowData["values"]>, validity?: Uint8Array, nullCount = 0): ArrowData => ({
  type,
  typeId,
  length,
  nullCount,
  offset: 0,
  values,
  ...(validity ? { validity } : {}),
  children: [],
});

function strings(type: string, typeId: number, texts: (string | Uint8Array | null)[]): ArrowData {
  const parts = texts.map((t) => (t === null ? new Uint8Array() : typeof t === "string" ? enc.encode(t) : t));
  const offsets = new Int32Array(parts.length + 1);
  parts.forEach((p, i) => (offsets[i + 1] = offsets[i]! + p.length));
  const values = new Uint8Array(offsets[parts.length]!);
  parts.forEach((p, i) => values.set(p, offsets[i]!));
  const validity = new Uint8Array(Math.ceil(texts.length / 8));
  let nulls = 0;
  texts.forEach((t, i) => (t === null ? nulls++ : (validity[i >> 3]! |= 1 << (i & 7))));
  return { type, typeId, length: texts.length, nullCount: nulls, offset: 0, offsets, values, ...(nulls ? { validity } : {}), children: [] };
}

/** Rows `[start, start + rows)` as one batch. */
export function syntheticBatch(start: number, rows: number): ArrowBatch {
  const ids = new BigInt64Array(rows);
  const qty = new Int32Array(rows);
  const price = new Float64Array(rows);
  const active = new Uint8Array(Math.ceil(rows / 8));
  const created = new BigInt64Array(rows);
  const day = new Int32Array(rows);
  const uid = new Uint8Array(16 * rows);
  const names: string[] = [];
  const notes: (string | null)[] = [];
  const blobs: Uint8Array[] = [];
  for (let r = 0; r < rows; r++) {
    const id = start + r;
    ids[r] = BigInt(id) + 9_007_199_254_740_000n;
    qty[r] = (id * 7919) % 1000;
    price[r] = Math.round(id * 13.37) / 100;
    if (id % 3 !== 0) active[r >> 3]! |= 1 << (r & 7);
    created[r] = 1_700_000_000_000_000n + BigInt(id) * 1_234_567n;
    day[r] = 19_000 + (id % 400);
    for (let k = 0; k < 16; k++) uid[16 * r + k] = (id * (k + 31)) & 0xff;
    names.push(`customer ${id} ${"abcdefghij".slice(0, id % 10)}`);
    notes.push(id % 5 === 0 ? null : id % 7 === 0 ? "" : `line one\nline two of ${id}`);
    blobs.push(Uint8Array.of(id & 0xff, (id >> 8) & 0xff, (id >> 16) & 0xff));
  }
  return {
    numRows: rows,
    columns: [
      fixed("Int64", 2, rows, ids),
      fixed("Int32", 2, rows, qty),
      fixed("Float64", 3, rows, price),
      strings("Utf8", 5, names),
      fixed("Bool", 6, rows, active),
      fixed("Timestamp<MICROSECOND, UTC>", 10, rows, created),
      fixed("Date32<DAY>", 8, rows, day),
      fixed("FixedSizeBinary[16]", 15, rows, uid),
      strings("Utf8", 5, notes),
      strings("Binary", 4, blobs),
    ],
  };
}

/**
 * A synthetic `ArrowStream` of `total` rows in batches of `batchRows`, each batch after `delayMs`
 * (a stand-in for the server and the Worker). Like decodeArrow, it builds the next batch only
 * when the consumer asks for it, so the consumer's pull rate is the backpressure.
 */
export function syntheticStream(total: number, batchRows = 4096, delayMs = 2): ArrowStream<{ rows: number }> & { readonly built: number } {
  let cancelled = false;
  let built = 0;
  let iterating = false;
  return {
    schema: Promise.resolve(SYNTHETIC_FIELDS),
    result: Promise.resolve({ rows: total }),
    get built() {
      return built;
    },
    cancel: () => {
      cancelled = true;
    },
    batches: () => {
      if (iterating) throw new TypeError("already being iterated");
      iterating = true;
      return {
        async *[Symbol.asyncIterator]() {
          for (let start = 0; start < total; start += batchRows) {
            await new Promise((r) => setTimeout(r, delayMs));
            if (cancelled) throw Object.assign(new Error("call cancelled"), { code: "Cancelled" });
            built += 1;
            yield syntheticBatch(start, Math.min(batchRows, total - start));
          }
        },
      };
    },
  };
}

/** As `syntheticStream`, with the batches built in a Worker and transferred (the realistic path). */
export function workerStream(total: number, batchRows = 4096): ArrowStream<{ rows: number }> {
  const worker = new Worker(new URL("./synthetic-worker.ts", import.meta.url), { type: "module" });
  let cancelled = false;
  let iterating = false;
  const request = (start: number, rows: number) =>
    new Promise<ArrowBatch>((resolve) => {
      worker.onmessage = (e: MessageEvent<ArrowBatch>) => resolve(e.data);
      worker.postMessage({ start, rows });
    });
  return {
    schema: Promise.resolve(SYNTHETIC_FIELDS),
    result: Promise.resolve({ rows: total }),
    cancel: () => {
      cancelled = true;
    },
    batches: () => {
      if (iterating) throw new TypeError("already being iterated");
      iterating = true;
      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (let start = 0; start < total; start += batchRows) {
              if (cancelled) throw Object.assign(new Error("call cancelled"), { code: "Cancelled" });
              yield await request(start, Math.min(batchRows, total - start));
            }
          } finally {
            worker.terminate();
          }
        },
      };
    },
  };
}
