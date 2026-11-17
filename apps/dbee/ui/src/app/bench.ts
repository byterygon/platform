// The benchmark hook (TSK-39 for TSK-36): opt-in, inert unless the harness asks. The harness sets
// `globalThis.__DBEE_BENCH__ = {}` before the app loads (DevTools `Page.addScriptToEvaluateOnNewDocument`
// in a browser, a Tauri initialization script on desktop). The results grid then registers its
// handle there (scroll it through `grid.scroller`, read `grid.progress`) and appends every frame
// sample while scrolling, the same numbers `performance.measure("dbee.grid.frame")` marks.
import type { DataGridHandle, FrameSample } from "@byterygon/data-grid";

export interface BenchHook {
  /** The grid of the active results panel, or null. */
  grid: DataGridHandle | null;
  samples: FrameSample[];
}

/** The hook when a harness installed one. */
export function benchHook(): BenchHook | undefined {
  const holder = globalThis as { __DBEE_BENCH__?: unknown };
  const hook = holder.__DBEE_BENCH__;
  if (typeof hook !== "object" || hook === null) return undefined;
  const h = hook as Partial<BenchHook>;
  h.grid ??= null;
  h.samples ??= [];
  return h as BenchHook;
}
