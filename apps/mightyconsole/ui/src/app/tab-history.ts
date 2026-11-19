// A tab's own back and forward history (DOC-21 §3.7): the places it has been, at most 50, as a
// browser tab keeps its own. The tab's kind, params and title are always its current entry's.
import type { TabHistory, TabPlace, TabRecord } from "@/tools/types";

export const TAB_HISTORY_LIMIT = 50;

/** Params compared by value, keys in any order. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function placeOf(tab: TabRecord): TabPlace {
  return { kind: tab.kind, params: tab.params, title: tab.title };
}

/** Whether `place` shows what `wanted` asks for: the same kind, and every param it gives equal. */
export function placeHas(place: Pick<TabPlace, "kind" | "params">, wanted: Pick<TabPlace, "kind" | "params">): boolean {
  return place.kind === wanted.kind && Object.entries(wanted.params).every(([k, v]) => sameValue(place.params[k], v));
}

function at(tab: TabRecord, history: TabHistory): TabRecord {
  const entry = history.entries[history.index]!;
  return { ...tab, kind: entry.kind, params: entry.params, title: entry.title, history };
}

/** A tab's first history: its one place. */
export function initialHistory(place: TabPlace): TabHistory {
  return { entries: [place], index: 0 };
}

/** A new step: the steps ahead are dropped, the oldest beyond 50 too. */
export function pushPlace(tab: TabRecord, place: TabPlace): TabRecord {
  if (placeHas(placeOf(tab), place) && Object.keys(place.params).length === Object.keys(tab.params).length) return replacePlace(tab, place);
  const entries = [...tab.history.entries.slice(0, tab.history.index + 1), place].slice(-TAB_HISTORY_LIMIT);
  return at(tab, { entries, index: entries.length - 1 });
}

/** The current step changed in place (a section shown, a title). */
export function replacePlace(tab: TabRecord, place: TabPlace): TabRecord {
  const entries = tab.history.entries.slice();
  entries[tab.history.index] = place;
  return at(tab, { entries, index: tab.history.index });
}

export function canGo(tab: TabRecord, delta: number): boolean {
  const next = tab.history.index + delta;
  return delta !== 0 && next >= 0 && next < tab.history.entries.length;
}

/** The tab `delta` steps away, or the same tab when it has no step there. */
export function goTab(tab: TabRecord, delta: number): TabRecord {
  return canGo(tab, delta) ? at(tab, { entries: tab.history.entries, index: tab.history.index + delta }) : tab;
}

/** The tab at step `index` (clamped). */
export function stepTab(tab: TabRecord, index: number): TabRecord {
  const clamped = Math.max(0, Math.min(index, tab.history.entries.length - 1));
  return clamped === tab.history.index ? tab : at(tab, { entries: tab.history.entries, index: clamped });
}

const isPlace = (v: unknown): v is TabPlace => {
  const p = v as Partial<TabPlace> | null;
  return typeof p?.kind === "string" && typeof p.title === "string" && typeof p.params === "object" && p.params !== null && !Array.isArray(p.params);
};

/**
 * A stored tab as this version keeps it: version 2 tabs bring their history, version 1 tabs (no
 * history) get one step; a history that does not hold together is dropped for the tab's place.
 */
export function migrateTab(record: Omit<TabRecord, "history"> & { history?: unknown }): TabRecord {
  const { history, ...tab } = record;
  const place: TabPlace = { kind: tab.kind, params: tab.params, title: tab.title };
  const h = history as Partial<TabHistory> | undefined;
  if (h && Array.isArray(h.entries) && h.entries.length > 0 && h.entries.every(isPlace) && Number.isInteger(h.index) && h.index! >= 0 && h.index! < h.entries.length) {
    const entries = h.entries.slice(-TAB_HISTORY_LIMIT);
    const index = Math.max(0, h.index! - (h.entries.length - entries.length));
    return at({ ...tab, history: { entries, index } }, { entries, index });
  }
  return { ...tab, history: initialHistory(place) };
}
