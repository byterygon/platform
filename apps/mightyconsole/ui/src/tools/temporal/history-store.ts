// The events of one run for its tab (TSK-109, DOC-21 §9.6.1), kept outside React state with a
// version counter that components read through useSyncExternalStore, published at most once per
// animation frame. The loaded events are always one run of ids without a gap, in time order: a
// newer event (followed, or the next page oldest first) is added to History's facts and to the
// Timeline at a cost that does not grow with the history; an older page (scrolling newest first)
// makes them anew, once for the page.
import type { HistoryEvent } from "@/gen/api";
import { TimelineBuilder } from "./history";
import { HistoryFacts } from "./history-view";

/** Events read in the background, page after page, before the views ask for more. */
export const AUTO_EVENTS = 10_000;
/** The JSON view shows at most this many events; Download has them all. */
export const JSON_VIEW_EVENTS = 2_000;

const nextFrame: (run: () => void) => unknown = typeof requestAnimationFrame === "function" ? (run) => requestAnimationFrame(run) : (run) => setTimeout(run, 16);

export class HistoryStore {
  /** Events before `base`, newest first: `older[0]` is event `base - 1`. */
  private older: HistoryEvent[] = [];
  /** Events from `base` on, oldest first. */
  private newer: HistoryEvent[] = [];
  private base = 0;
  /** The run's first event (its start: input, task queue, timeouts), kept when the loaded events do not reach it. */
  first: HistoryEvent | undefined;
  facts = new HistoryFacts();
  timeline: TimelineBuilder;
  /** Bumped whenever the facts are made anew (an older page, a reset): what was derived from them is stale. */
  generation = 0;
  private version = 0;
  private published = 0;
  private pending = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly workflowId = "") {
    this.timeline = new TimelineBuilder(workflowId);
  }

  /** How many events are loaded. */
  get size(): number {
    return this.older.length + this.newer.length;
  }

  /** The oldest loaded event's id, or 0 when none is loaded. */
  get lo(): number {
    return this.size === 0 ? 0 : this.base - this.older.length;
  }

  /** The newest loaded event's id, or 0 when none is loaded. */
  get hi(): number {
    return this.size === 0 ? 0 : this.base + this.newer.length - 1;
  }

  /** The newest loaded event. */
  get latest(): HistoryEvent | undefined {
    return this.newer.length > 0 ? this.newer[this.newer.length - 1] : this.older[0];
  }

  /** An event by its id, when it is loaded (or it is the first event). */
  get(id: number): HistoryEvent | undefined {
    if (this.size > 0) {
      const e = id >= this.base ? this.newer[id - this.base] : this.older[this.base - 1 - id];
      if (e) return e;
    }
    return id === 1 ? this.first : undefined;
  }

  /** The `i`-th loaded event in time order. */
  at(i: number): HistoryEvent | undefined {
    const o = this.older.length;
    return i < o ? this.older[o - 1 - i] : this.newer[i - o];
  }

  /** Every loaded event in time order: a copy, for what needs them all at once (a dialog, a test). */
  toArray(): HistoryEvent[] {
    return [...this.older].reverse().concat(this.newer);
  }

  /**
   * Newer events, in any order: each must follow the newest loaded one (a repeat is skipped, an
   * event past a gap is left out, so the run stays without one). Returns how many were added.
   */
  append(events: readonly HistoryEvent[]): number {
    let added = 0;
    for (const e of [...events].sort((x, y) => x.eventId - y.eventId)) {
      if (this.size === 0) this.base = e.eventId;
      else if (e.eventId !== this.hi + 1) continue;
      this.newer.push(e);
      if (e.eventId === 1) this.first = e;
      this.facts.add(e);
      this.timeline.add(e);
      added += 1;
    }
    if (added > 0) this.changed();
    return added;
  }

  /** Older events, in any order: each must come just before the oldest loaded one. The facts are made anew. */
  prepend(events: readonly HistoryEvent[]): number {
    let added = 0;
    for (const e of [...events].sort((x, y) => y.eventId - x.eventId)) {
      if (this.size === 0) {
        this.base = e.eventId;
        this.newer.push(e);
      } else if (e.eventId === this.lo - 1) {
        this.older.push(e);
      } else continue;
      if (e.eventId === 1) this.first = e;
      added += 1;
    }
    if (added === 0) return 0;
    this.rebuild();
    this.changed();
    return added;
  }

  /** The run's first event, read on its own when the loaded events do not reach it. */
  setFirst(event: HistoryEvent): void {
    if (event.eventId !== 1 || this.first) return;
    this.first = event;
    this.changed();
  }

  /** Forgets every event (a refresh, another run). */
  reset(): void {
    this.older = [];
    this.newer = [];
    this.base = 0;
    this.first = undefined;
    this.rebuild();
    this.changed();
  }

  private rebuild() {
    this.facts = new HistoryFacts();
    this.timeline = new TimelineBuilder(this.workflowId);
    for (let i = 0; i < this.size; i += 1) {
      const e = this.at(i)!;
      this.facts.add(e);
      this.timeline.add(e);
    }
    this.generation += 1;
  }

  /** For useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** For useSyncExternalStore: the version published, which moves at most once a frame. */
  getSnapshot = (): number => this.published;

  private changed() {
    this.version += 1;
    if (this.pending) return;
    this.pending = true;
    nextFrame(() => {
      this.pending = false;
      this.published = this.version;
      for (const listener of [...this.listeners]) listener();
    });
  }
}
