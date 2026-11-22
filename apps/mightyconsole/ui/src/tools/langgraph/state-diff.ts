// What the thread screens work out from checkpoints and runs (DOC-21 §11.2.1, TSK-96): what an
// Edit state would write ("What changes", with the reducers the state schema lets us know), what a
// History step ran, how many branches the loaded history has, and a run's note and duration.
import { type DiffLine, diffLines, stableJson } from "@/lib/diff";
import type * as api from "@/gen/api";

type Values = Record<string, unknown>;

const isObject = (v: unknown): v is Values => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The keys whose updates are appended, not replaced (Open question 62): `messages`, and any key
 * whose schema names `add_messages` (a reducer the server describes in the property's schema).
 */
export function appendKeys(stateSchema: unknown): Set<string> {
  const keys = new Set<string>(["messages"]);
  const props = isObject(stateSchema) && isObject(stateSchema["properties"]) ? stateSchema["properties"] : {};
  for (const [key, schema] of Object.entries(props)) {
    if (JSON.stringify(schema ?? null).includes("add_messages")) keys.add(key);
  }
  return keys;
}

/** `add_messages`: a message with an id already in the list replaces it, the others are appended. */
function appendMessages(current: unknown, update: unknown): unknown[] {
  const list = Array.isArray(current) ? [...current] : [];
  for (const m of Array.isArray(update) ? update : [update]) {
    const id = isObject(m) ? m["id"] : undefined;
    const at = id === undefined ? -1 : list.findIndex((x) => isObject(x) && x["id"] === id);
    if (at >= 0) list[at] = m;
    else list.push(m);
  }
  return list;
}

/** The values after an update, as the graph would write them with the rules above. */
export function applyUpdate(current: unknown, update: unknown, appended: ReadonlySet<string>): Values {
  const base: Values = isObject(current) ? { ...current } : {};
  if (!isObject(update)) return base;
  for (const [key, value] of Object.entries(update)) {
    base[key] = appended.has(key) ? appendMessages(base[key], value) : value;
  }
  return base;
}

/** "What changes": the keys the update changes, and the line diff of the values before and after. */
export function updatePreview(current: unknown, update: unknown, appended: ReadonlySet<string>): { keys: string[]; lines: DiffLine[] } {
  const before: Values = isObject(current) ? current : {};
  const after = applyUpdate(current, update, appended);
  const keys = Object.keys(isObject(update) ? update : {}).filter((k) => stableJson(before[k]) !== stableJson(after[k]));
  // Only the changed keys are compared, so a large state's other keys do not drown the change.
  const pick = (v: Values) => Object.fromEntries(keys.map((k) => [k, v[k] ?? null]));
  return { keys, lines: keys.length === 0 ? [] : diffLines(stableJson(pick(before)), stableJson(pick(after))) };
}

/** A checkpoint's metadata as a record. */
export const metaOf = (s: api.ThreadState): Values => (isObject(s.metadata) ? s.metadata : {});

/** `input`, `loop`, `update`, `fork`, or what the server said. */
export const sourceOf = (s: api.ThreadState): string => String(metaOf(s)["source"] ?? "");

/** The step's number, or null. */
export function stepOf(s: api.ThreadState): number | null {
  const n = metaOf(s)["step"];
  return typeof n === "number" ? n : null;
}

/**
 * The nodes a step ran: its writes' keys when the server keeps them in the metadata, else the
 * nodes its parent was to run next (Open question 62: newer servers dropped `writes`).
 */
export function stepNodes(s: api.ThreadState, parent: api.ThreadState | undefined): string[] {
  const writes = metaOf(s)["writes"];
  if (isObject(writes)) return Object.keys(writes);
  if (sourceOf(s) === "loop" && parent) return [...parent.next];
  return [];
}

/** What the History's "Wrote" column says for a checkpoint. */
export function wroteLabel(s: api.ThreadState, parent: api.ThreadState | undefined, byId: ReadonlyMap<string, api.ThreadState>): string {
  const source = sourceOf(s);
  const nodes = stepNodes(s, parent);
  if (source === "update") return nodes.length > 0 ? `(by a person) as ${nodes.join(", ")}` : "(by a person)";
  if (source === "fork") {
    const from = s.parentCheckpointId ? byId.get(s.parentCheckpointId) : undefined;
    const step = from ? stepOf(from) : null;
    return step !== null ? `from step ${step}` : "a new branch";
  }
  if (source === "input") return "—";
  return nodes.length > 0 ? nodes.join(", ") : "—";
}

/** "2 branches": one branch, plus one more for each extra child of a branch point. */
export function branchCount(states: readonly api.ThreadState[]): number {
  const children = new Map<string, number>();
  for (const s of states) {
    if (s.parentCheckpointId) children.set(s.parentCheckpointId, (children.get(s.parentCheckpointId) ?? 0) + 1);
  }
  return 1 + [...children.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0);
}

/** A run's duration in milliseconds: updated − created for an ended run, now − created while it runs. */
export function runDuration(run: api.Run, now = Date.now()): number | null {
  const start = Date.parse(run.createdAt);
  if (Number.isNaN(start)) return null;
  const running = run.status === "running" || run.status === "pending";
  const end = running ? now : Date.parse(run.updatedAt);
  return Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** "3.6 s", "14.8 s", "2 min 4 s", "1 h 3 min". */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The first task error of a checkpoint, with its node. */
export function taskError(s: api.ThreadState): { node: string; error: string } | null {
  const t = s.tasks.find((x) => x.error);
  return t?.error ? { node: t.name, error: t.error } : null;
}

/**
 * Whether a run stopped at an interrupt: its status says so (interrupt before or after a node),
 * or its last checkpoint has nodes to run and an interrupt pending (`interrupt()` inside a node,
 * after which the server may call the run a success).
 */
export function waitsAtInterrupt(run: api.Run, last: api.ThreadState | null | undefined): boolean {
  if (!last || last.next.length === 0) return false;
  return run.status === "interrupted" || last.interrupts.length > 0 || last.tasks.some((t) => t.interrupts.length > 0);
}

/** The Runs table's note: the error of a failed run with its node, where an interrupted one waits. */
export function runNote(run: api.Run, last: api.ThreadState | null | undefined): string {
  if (!last) return "";
  if (run.status === "error") {
    const e = taskError(last);
    return e ? e.error.split("\n")[0]! : "";
  }
  if (waitsAtInterrupt(run, last)) return `waiting at ${last.next.join(", ")}`;
  return "";
}
