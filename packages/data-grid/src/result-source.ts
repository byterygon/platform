// Where the grid's rows come from (DBee spec §6, "Input" and "Behaviour while streaming").
//
// A `ResultSource` holds the `BatchIndex` and, for a stream, pulls `batches()` exactly once. The
// pull rate is the backpressure: `decodeArrow` takes the next chunk, and so grants the server its
// credit, only when the grid asks for the next batch (Ambidex spec Open question 28a, 28c).
//
// - Below the memory budget the source pulls continuously: it never stops by accident.
// - At the budget it stops on purpose and pulls again only while the viewport is within two
//   screens of the last loaded row, one batch at a time, re-checking after each.
// - `cancel()` cancels the stream and keeps every row already loaded.
//
// A stream can be iterated only once, so sources are shared per stream (`sourceFor`): React's
// StrictMode mounts, unmounts and mounts again, and the second mount must find the same source.
// The stream is cancelled when the last subscriber has been gone for a task.
import type { ArrowBatch, ArrowField, ArrowStream } from "@byterygon/ambidex/arrow";
import { BatchIndex } from "./batch-index.ts";

/** The default memory budget: 256 MiB of buffer bytes (DBee spec §6, Decision 13). */
export const DEFAULT_MEMORY_BUDGET = 256 * 1024 * 1024;

/** How many screens of rows below the viewport make the source pull past the budget. */
export const NEAR_END_SCREENS = 2;

/**
 * - `schema`: waiting for the schema.
 * - `streaming`: pulling.
 * - `paused`: at the memory budget, waiting for the viewport to near the loaded end.
 * - `done`: the stream ended; every row is loaded.
 * - `cancelled`: cancelled (by `cancel()` or the server); loaded rows are kept.
 * - `error`: the stream failed; loaded rows are kept and `error` says why.
 */
export type ResultState = "schema" | "streaming" | "paused" | "done" | "cancelled" | "error";

export interface ResultProgress {
  readonly state: ResultState;
  /** Rows loaded. */
  readonly rows: number;
  /** Buffer bytes held (what the budget counts). */
  readonly bytes: number;
  /** The stream's failure when `state` is `error` (or `cancelled` by the server). */
  readonly error?: unknown;
  /** Rows dropped from the front so far to keep the window (`maxRows`, `maxBytes`) or by `clear()`. */
  readonly dropped: number;
}

/** A live view's limits: the newest rows are kept, the oldest batches dropped whole. */
export interface ResultWindow {
  readonly maxRows?: number | undefined;
  readonly maxBytes?: number | undefined;
}

const isCancelled = (error: unknown): boolean => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "Cancelled";

export class ResultSource {
  readonly index = new BatchIndex();
  #fields: readonly ArrowField[] | undefined;
  #state: ResultState;
  #error: unknown;
  #budget = DEFAULT_MEMORY_BUDGET;
  #listeners = new Set<() => void>();
  #stream: ArrowStream<unknown> | undefined;
  #started = false;
  #stopping = false;
  #wake: (() => void) | undefined;
  /** The last row in view and the rows per screen, reported by the grid after each frame. */
  #viewEnd = 0;
  #screenRows = 0;
  #maxRows = Number.POSITIVE_INFINITY;
  #maxBytes = Number.POSITIVE_INFINITY;
  #hold = false;
  #dropped = 0;

  private constructor(state: ResultState) {
    this.#state = state;
  }

  /** A complete result: the batches are kept as given. */
  static fromBatches(fields: readonly ArrowField[], batches: Iterable<ArrowBatch>): ResultSource {
    const source = new ResultSource("done");
    source.#fields = fields;
    for (const batch of batches) source.index.append(batch);
    return source;
  }

  /** A streamed result; pulling starts at the first `subscribe`. */
  static fromStream(stream: ArrowStream<unknown>): ResultSource {
    const source = new ResultSource("schema");
    source.#stream = stream;
    return source;
  }

  get fields(): readonly ArrowField[] | undefined {
    return this.#fields;
  }

  get state(): ResultState {
    return this.#state;
  }

  /** Whether more rows can still arrive. */
  get live(): boolean {
    return this.#state === "schema" || this.#state === "streaming" || this.#state === "paused";
  }

  get progress(): ResultProgress {
    const base = { state: this.#state, rows: this.index.rowCount, bytes: this.index.byteLength, dropped: this.#dropped };
    return this.#error === undefined ? base : { ...base, error: this.#error };
  }

  get budget(): number {
    return this.#budget;
  }

  /** The memory budget in bytes; raising it resumes a paused stream. */
  set budget(bytes: number) {
    this.#budget = Math.max(0, bytes);
    this.#signal();
  }

  /**
   * Keeps at most `maxRows` rows and `maxBytes` buffer bytes, dropping the oldest batches whole
   * (the newest batch always stays). A live tail's "Showing the latest 10,000".
   */
  set window(window: ResultWindow) {
    this.#maxRows = window.maxRows ?? Number.POSITIVE_INFINITY;
    this.#maxBytes = window.maxBytes ?? Number.POSITIVE_INFINITY;
    if (this.#trim() > 0) this.#emit();
  }

  /** Rows dropped from the front so far (the window and `clear()`). */
  get dropped(): number {
    return this.#dropped;
  }

  /** While held, nothing is pulled: the stream's credits run out and the server waits (Pause). */
  get hold(): boolean {
    return this.#hold;
  }

  set hold(hold: boolean) {
    if (hold === this.#hold) return;
    this.#hold = hold;
    if (!hold) this.#signal();
    else if (this.#state === "streaming") this.#set("paused");
  }

  /** Drops every row loaded so far and keeps the stream (Clear). */
  clear(): void {
    const removed = this.index.dropFirst(this.index.batchCount);
    if (removed === 0) return;
    this.#dropped += removed;
    this.#emit();
  }

  #trim(): number {
    let removed = 0;
    const index = this.index;
    while (index.batchCount > 1 && (index.rowCount > this.#maxRows || index.byteLength > this.#maxBytes)) removed += index.dropFirst(1);
    this.#dropped += removed;
    return removed;
  }

  /** Where the viewport is: the last row in view and how many rows a screen holds. */
  setViewport(lastRow: number, screenRows: number): void {
    if (lastRow === this.#viewEnd && screenRows === this.#screenRows) return;
    this.#viewEnd = lastRow;
    this.#screenRows = screenRows;
    if (this.#nearEnd()) this.#signal();
  }

  /** Calls `listener` after every change (state, rows). Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    if (!this.#started && this.#stream !== undefined) {
      this.#started = true;
      void this.#pump(this.#stream);
    }
    return () => this.#listeners.delete(listener);
  }

  get subscribers(): number {
    return this.#listeners.size;
  }

  /** Cancels the stream; the rows loaded so far stay. */
  cancel(): void {
    if (!this.live) return;
    this.#stopping = true;
    this.#stream?.cancel();
    this.#signal();
  }

  #nearEnd(): boolean {
    return this.#viewEnd >= this.index.rowCount - 1 - NEAR_END_SCREENS * Math.max(1, this.#screenRows);
  }

  #mayPull(): boolean {
    return !this.#hold && (this.index.byteLength < this.#budget || this.#nearEnd());
  }

  #signal(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  #set(state: ResultState, error?: unknown): void {
    this.#state = state;
    if (error !== undefined) this.#error = error;
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  async #pump(stream: ArrowStream<unknown>): Promise<void> {
    let iterator: AsyncIterator<ArrowBatch> | undefined;
    try {
      this.#fields = await stream.schema;
      this.#set("streaming");
      iterator = stream.batches()[Symbol.asyncIterator]();
      for (;;) {
        while (!this.#stopping && !this.#mayPull()) {
          if (this.#state !== "paused") this.#set("paused");
          await new Promise<void>((resolve) => {
            this.#wake = resolve;
          });
        }
        if (this.#stopping) {
          // Leaving the iterator cancels the stream (decodeArrow); `cancel()` already did.
          await iterator.return?.();
          this.#set("cancelled");
          return;
        }
        if (this.#state !== "streaming") this.#set("streaming");
        const next = await iterator.next();
        if (next.done) break;
        this.index.append(next.value);
        this.#trim();
        this.#emit();
      }
      this.#set(this.#stopping ? "cancelled" : "done");
    } catch (error) {
      if (this.#stopping || isCancelled(error)) this.#set("cancelled", this.#stopping ? undefined : error);
      else this.#set("error", error);
    }
  }
}

const shared = new WeakMap<ArrowStream<unknown>, ResultSource>();

/** The one source of `stream` (created on first use). */
export function sourceFor(stream: ArrowStream<unknown>): ResultSource {
  let source = shared.get(stream);
  if (source === undefined) {
    source = ResultSource.fromStream(stream);
    shared.set(stream, source);
  }
  return source;
}

/**
 * Subscribes to a source; unsubscribing cancels a live stream once no subscriber came back within
 * a task (so a StrictMode remount keeps the stream).
 */
export function retain(source: ResultSource, listener: () => void): () => void {
  const unsubscribe = source.subscribe(listener);
  return () => {
    unsubscribe();
    setTimeout(() => {
      if (source.subscribers === 0) source.cancel();
    }, 0);
  };
}
