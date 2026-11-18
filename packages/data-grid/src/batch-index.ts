// The grid's model of a result: the record batches exactly as received (no per-row objects) and
// the prefix sums of their row counts, so a global row maps to (batch, row in batch) by binary
// search (DBee spec §6, "Model").
import type { ArrowBatch, ArrowData } from "@byterygon/ambidex/arrow";

/** Bytes held by one array: every validity, offsets, values, type ids, view, child and dictionary buffer. */
export function dataByteLength(data: ArrowData): number {
  let n = (data.validity?.byteLength ?? 0) + (data.offsets?.byteLength ?? 0) + (data.values?.byteLength ?? 0) + (data.typeIds?.byteLength ?? 0);
  for (const view of data.variadic ?? []) n += view.byteLength;
  for (const child of data.children) n += dataByteLength(child);
  for (const chunk of data.dictionary ?? []) n += dataByteLength(chunk);
  return n;
}

/** Bytes held by a batch's buffers (what the memory budget counts). */
export function batchByteLength(batch: ArrowBatch): number {
  let n = 0;
  for (const column of batch.columns) n += dataByteLength(column);
  return n;
}

export class BatchIndex {
  readonly #batches: ArrowBatch[] = [];
  /** `#starts[b]` is the global index of batch `b`'s first row. */
  readonly #starts: number[] = [];
  #rows = 0;
  #bytes = 0;
  /** The batch of the last lookup: rows in view are contiguous, so most lookups hit it. */
  #last = 0;

  /** Rows held. */
  get rowCount(): number {
    return this.#rows;
  }

  /** Buffer bytes held (see `batchByteLength`). */
  get byteLength(): number {
    return this.#bytes;
  }

  get batchCount(): number {
    return this.#batches.length;
  }

  /** Adds a batch at the end. Empty batches are not kept. */
  append(batch: ArrowBatch): void {
    if (batch.numRows === 0) return;
    this.#batches.push(batch);
    this.#starts.push(this.#rows);
    this.#rows += batch.numRows;
    this.#bytes += batchByteLength(batch);
  }

  /**
   * Removes the first `count` batches (a live view keeping only its newest rows); the rows that
   * stay are renumbered from 0. Returns how many rows went.
   */
  dropFirst(count: number): number {
    const n = Math.max(0, Math.min(count, this.#batches.length));
    if (n === 0) return 0;
    const removed = n === this.#batches.length ? this.#rows : this.#starts[n]!;
    for (const batch of this.#batches.splice(0, n)) this.#bytes -= batchByteLength(batch);
    this.#starts.splice(0, n);
    for (let b = 0; b < this.#starts.length; b += 1) this.#starts[b]! -= removed;
    this.#rows -= removed;
    this.#last = 0;
    return removed;
  }

  /** The batch holding global row `row` (0 <= row < rowCount). */
  locate(row: number): number {
    const starts = this.#starts;
    const last = this.#last;
    if (last < starts.length && starts[last]! <= row && (last + 1 === starts.length || row < starts[last + 1]!)) return last;
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= row) lo = mid;
      else hi = mid - 1;
    }
    this.#last = lo;
    return lo;
  }

  batch(b: number): ArrowBatch {
    return this.#batches[b]!;
  }

  /** Global index of batch `b`'s first row. */
  start(b: number): number {
    return this.#starts[b]!;
  }

  /** The column `column` of the batch holding `row`, and the row's index in it. */
  cell(row: number, column: number): { data: ArrowData; row: number } | undefined {
    if (row < 0 || row >= this.#rows) return undefined;
    const b = this.locate(row);
    const data = this.#batches[b]!.columns[column];
    return data === undefined ? undefined : { data, row: row - this.#starts[b]! };
  }
}
