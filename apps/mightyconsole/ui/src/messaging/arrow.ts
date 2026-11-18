// Reading the message batches of Mightyconsole spec §5.1 in the UI: one message out of a batch
// (for the detail pane, export and Copy), and a projection that hands the data grid only the
// columns of a system's view while the full batches stay for the detail pane.
import type { ArrowBatch, ArrowData, ArrowField, ArrowStream } from "@byterygon/ambidex/arrow";
import { arrowIsValid } from "@byterygon/ambidex/arrow";

const utf8 = new TextDecoder();

function slice(data: ArrowData, row: number): Uint8Array | null {
  if (!arrowIsValid(data, row)) return null;
  const offsets = data.offsets!;
  const i = data.offset + row;
  const start = Number(offsets[i]!);
  const end = Number(offsets[i + 1]!);
  return (data.values as Uint8Array).subarray(start, end);
}

export const textAt = (data: ArrowData, row: number): string | null => {
  const bytes = slice(data, row);
  return bytes === null ? null : utf8.decode(bytes);
};
export const bytesAt = (data: ArrowData, row: number): Uint8Array | null => slice(data, row);
/** 64-bit integers as decimal strings (exact); 32-bit and smaller as numbers. */
export const bigAt = (data: ArrowData, row: number): string | null =>
  arrowIsValid(data, row) ? String((data.values as BigInt64Array | BigUint64Array)[data.offset + row]) : null;
export const intAt = (data: ArrowData, row: number): number | null =>
  arrowIsValid(data, row) ? Number((data.values as Int32Array)[data.offset + row]) : null;
export const boolAt = (data: ArrowData, row: number): boolean | null => {
  if (!arrowIsValid(data, row)) return null;
  const i = data.offset + row;
  return (((data.values as Uint8Array)[i >> 3]! >> (i & 7)) & 1) === 1;
};

/** A header as the `headers` column has it: `[name, value, "text" | "base64"]`. */
export type HeaderRow = [name: string, value: string, encoding: "text" | "base64"];

/** One message of the §5.1 schema, as the detail pane and the export read it. */
export interface MessageRow {
  rowId: string;
  source: string;
  subject: string | null;
  partition: number | null;
  offset: string | null;
  sequence: string | null;
  /** Microseconds since the epoch, as a decimal string. */
  timestampUs: string;
  timestampKind: string;
  operation: string | null;
  replyTo: string | null;
  headers: HeaderRow[] | null;
  keyRaw: Uint8Array | null;
  keyText: string | null;
  keyCodec: string | null;
  payloadRaw: Uint8Array;
  payloadSize: number;
  payloadTruncated: boolean;
  payloadText: string | null;
  payloadCodec: string;
  schemaRef: string | null;
  decodeError: string | null;
}

/** Column indexes of the §5.1 schema by name. */
export function columnIndex(fields: readonly ArrowField[]): Record<string, number> {
  return Object.fromEntries(fields.map((f, i) => [f.name, i]));
}

/** Reads row `row` of a message batch. */
export function readMessage(batch: ArrowBatch, fields: Record<string, number>, row: number): MessageRow {
  const col = (name: string) => batch.columns[fields[name]!]!;
  const headers = textAt(col("headers"), row);
  return {
    rowId: bigAt(col("rowId"), row) ?? "0",
    source: textAt(col("source"), row) ?? "",
    subject: textAt(col("subject"), row),
    partition: intAt(col("partition"), row),
    offset: bigAt(col("offset"), row),
    sequence: bigAt(col("sequence"), row),
    timestampUs: bigAt(col("timestamp"), row) ?? "0",
    timestampKind: textAt(col("timestampKind"), row) ?? "",
    operation: textAt(col("operation"), row),
    replyTo: textAt(col("replyTo"), row),
    headers: headers === null ? null : (JSON.parse(headers) as HeaderRow[]),
    keyRaw: bytesAt(col("keyRaw"), row),
    keyText: textAt(col("keyText"), row),
    keyCodec: textAt(col("keyCodec"), row),
    payloadRaw: bytesAt(col("payloadRaw"), row) ?? new Uint8Array(),
    payloadSize: Number(bigAt(col("payloadSize"), row) ?? 0),
    payloadTruncated: boolAt(col("payloadTruncated"), row) ?? false,
    payloadText: textAt(col("payloadText"), row),
    payloadCodec: textAt(col("payloadCodec"), row) ?? "hex",
    schemaRef: textAt(col("schemaRef"), row),
    decodeError: textAt(col("decodeError"), row),
  };
}

/** The RFC 3339 text of a microsecond timestamp (UTC, microseconds kept). */
export function timestampText(us: string): string {
  const n = BigInt(us);
  const ms = Number(n / 1000n);
  const micros = Number(((n % 1_000_000n) + 1_000_000n) % 1_000_000n);
  return `${new Date(ms).toISOString().slice(0, 19)}.${String(micros).padStart(6, "0")}Z`;
}

/** The stream's batches for the grid (only `names`, in that order) and the full ones, in step. */
export interface ProjectedStream<T> {
  /** For DataGrid's `stream`. */
  readonly grid: ArrowStream<T>;
  /** The full batches received so far, oldest first; the viewer trims it as the grid drops rows. */
  readonly full: ArrowBatch[];
  /** The full schema. */
  readonly fields: Promise<readonly ArrowField[]>;
}

/** Projects a message stream onto the columns `names` (the system's view). */
export function projectStream<T>(stream: ArrowStream<T>, names: readonly string[], onBatch?: (batch: ArrowBatch) => void): ProjectedStream<T> {
  const full: ArrowBatch[] = [];
  const picks = stream.schema.then((fields) => names.map((n) => fields.findIndex((f) => f.name === n)).filter((i) => i >= 0));
  const grid: ArrowStream<T> = {
    schema: Promise.all([stream.schema, picks]).then(([fields, idx]) => idx.map((i) => fields[i]!)),
    result: stream.result,
    cancel: () => stream.cancel(),
    batches: () => ({
      async *[Symbol.asyncIterator]() {
        const idx = await picks;
        for await (const batch of stream.batches()) {
          full.push(batch);
          onBatch?.(batch);
          yield { numRows: batch.numRows, columns: idx.map((i) => batch.columns[i]!) };
        }
      },
    }),
  };
  return { grid, full, fields: stream.schema };
}

/** Drops `rows` rows of whole batches from the front of `full`, as the grid did. */
export function dropFront(full: ArrowBatch[], rows: number): void {
  let left = rows;
  while (left > 0 && full.length > 0 && full[0]!.numRows <= left) left -= full.shift()!.numRows;
}

/** The batch and the row in it of the grid's row `row`. */
export function locate(full: readonly ArrowBatch[], row: number): { batch: ArrowBatch; row: number } | null {
  let r = row;
  for (const batch of full) {
    if (r < batch.numRows) return { batch, row: r };
    r -= batch.numRows;
  }
  return null;
}
