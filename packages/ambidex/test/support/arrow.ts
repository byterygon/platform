// Helpers for the Arrow tests: the decoder in a worker thread, and readers for the plain
// columnar batches `decodeArrow` yields.

import { Worker } from "node:worker_threads";

import { type ArrowBatch, type ArrowData, type ArrowDecoderPort, arrowIsValid } from "../../src/arrow.js";

type Listener = (event: { readonly data?: unknown }) => void;

/** Starts the decoder worker thread and adapts it to the Web `Worker` shape `decodeArrow` takes. */
export function startArrowWorker(): { port: ArrowDecoderPort; stop(): Promise<number> } {
  const worker = new Worker(new URL("./arrow-worker.js", import.meta.url));
  const wrapped = new Map<Listener, (data: unknown) => void>();
  return {
    port: {
      postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
      addEventListener: (type, listener) => {
        const on = (data: unknown): void => listener({ data });
        wrapped.set(listener, on);
        worker.on(type, on);
      },
      removeEventListener: (type, listener) => {
        const on = wrapped.get(listener);
        if (on !== undefined) worker.off(type, on);
      },
    },
    stop: () => worker.terminate(),
  };
}

const utf8 = new TextDecoder();

/** Element `row` of a column of the conformance fixture's schema, `null` when it is null. */
export function cell(data: ArrowData, row: number): bigint | number | string | number[] | null {
  if (!arrowIsValid(data, row)) return null;
  const values = data.values;
  if (values === undefined) throw new Error(`no values for ${data.type}`);
  if (data.offsets === undefined) return values[row] as bigint | number;
  const bytes = (values as Uint8Array).subarray(
    Number(data.offsets[row]),
    Number(data.offsets[row + 1]),
  );
  return data.type === "Utf8" ? utf8.decode(bytes) : [...bytes];
}

/** The rows of a batch, each as its cells in column order. */
export function rowsOf(batch: ArrowBatch): Array<ReturnType<typeof cell>[]> {
  return Array.from({ length: batch.numRows }, (_, row) =>
    batch.columns.map((column) => cell(column, row)),
  );
}

/**
 * Row `id` of the fixture's synthetic result (`arrow_batch` in
 * crates/ambidex-conformance/src/fixture.rs): every value follows from the id.
 */
export function fixtureRow(id: number): ReturnType<typeof cell>[] {
  return [
    BigInt(id),
    id % 7 === 0 ? null : (id % 1000) - 500,
    id * 0.5,
    `row-${id % 1000}`,
    id % 5 === 0 ? null : [id & 0xff, (id >> 8) & 0xff],
  ];
}
