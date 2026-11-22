// The History view's reading of a history (Mightyconsole spec §9.3, the TSK-91 mockup frame
// `temporal-history`): rows with workflow tasks folded, the pair of each event (Scheduled ->
// Completed and back), summaries as the mockup writes them, the category counts and the search.
// Pure, over the `HistoryEvent`s the server sends (payloads decoded).
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { clockText, durationMs, eventMs, eventSummary, spanText } from "./history";

type Attributes = Record<string, unknown>;
const obj = (value: unknown): Attributes => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Attributes) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const at = (attributes: Attributes, ...path: string[]): string => {
  let value: unknown = attributes;
  for (const key of path) value = obj(value)[key];
  return text(value);
};

/** The chips of the History filter, in the mockup's order; "All" first. Workflow tasks are folded, not filtered. */
export const HISTORY_CHIPS: readonly { category: EventCategory | "All"; label: string }[] = [
  { category: "All", label: "All" },
  { category: "Workflow", label: "Workflow" },
  { category: "Activity", label: "Activities" },
  { category: "Timer", label: "Timers" },
  { category: "Signal", label: "Signals" },
  { category: "Marker", label: "Markers" },
  { category: "ChildWorkflow", label: "Child workflows" },
  { category: "Update", label: "Updates" },
];

/** How many events of each category, and "All". */
export function categoryCounts(events: readonly HistoryEvent[]): Record<EventCategory | "All", number> {
  const facts = new HistoryFacts();
  for (const e of events) facts.add(e);
  return facts.counts;
}

const noCounts = (): Record<EventCategory | "All", number> => ({ All: 0, Workflow: 0, WorkflowTask: 0, Activity: 0, Timer: 0, ChildWorkflow: 0, Signal: 0, Update: 0, Marker: 0, Other: 0 });

/** A failure, a timeout, a termination: the row is drawn red. */
export function isFailure(event: HistoryEvent): boolean {
  return /(Failed|TimedOut|Terminated)$/.test(event.eventType);
}

/** "+0 ms", "+77 ms", "+1.76 s", "+1m 22s": the time since the first event. */
export function sinceStart(t: number, start: number): string {
  return `+${spanText(Math.max(t - start, 0)) || "0 ms"}`;
}

/** Each event's partner: Scheduled -> its close, Started -> its close, a close <- its Scheduled (timers, children alike). */
export function pairsOf(events: readonly HistoryEvent[]): Map<number, { to: number; direction: "next" | "previous" }> {
  const facts = new HistoryFacts();
  for (const e of events) facts.add(e);
  return facts.pairs;
}

/** What the summaries need beyond one event: activity names by their Scheduled event, and the pending attempts. */
export interface SummaryContext {
  activities: Map<number, { name: string; at: number; activityId: string }>;
  /** By activity id. */
  pending: Map<string, { attempt: number; maximumAttempts: number }>;
  closed: Set<number>;
}

export function summaryContext(events: readonly HistoryEvent[], pending: readonly Record<string, unknown>[] = []): SummaryContext {
  const facts = new HistoryFacts();
  for (const e of events) facts.add(e);
  return facts.context(pending);
}

/** The pending activities by activity id: their attempt and maximum. */
function pendingOf(pending: readonly Record<string, unknown>[]): Map<string, { attempt: number; maximumAttempts: number }> {
  const p = new Map<string, { attempt: number; maximumAttempts: number }>();
  for (const x of pending) p.set(text(x["activityId"]), { attempt: num(x["attempt"]) ?? 1, maximumAttempts: num(x["maximumAttempts"]) ?? 0 });
  return p;
}

/** A run of the History table before its folds open: one event, or a run of workflow task events. */
export type FoldUnit = { kind: "event"; event: HistoryEvent } | { kind: "run"; events: HistoryEvent[] };

/** Folded: a workflow task event that is not a failure (a failed one is what someone looks for). */
const foldable = (event: HistoryEvent) => event.category === "WorkflowTask" && !isFailure(event);

const CLOSING_EVENT = /^WorkflowExecution(Completed|ContinuedAsNew|Failed|TimedOut|Canceled|Terminated)$/;

/**
 * What History reads from a history beyond one event (TSK-109): the category counts, the
 * activities and closes the summaries name, each event's pair, the fold units, the child
 * workflows and the closing event. Kept up to date one event at a time, in history order, at a
 * cost that does not grow with the history; an older page makes a new one.
 */
export class HistoryFacts {
  readonly counts = noCounts();
  readonly activities = new Map<number, { name: string; at: number; activityId: string }>();
  readonly closed = new Set<number>();
  readonly pairs = new Map<number, { to: number; direction: "next" | "previous" }>();
  readonly units: FoldUnit[] = [];
  /** The workflow ids of the child workflows started. */
  readonly children = new Set<string>();
  /** The event that closed the run, once it is in. */
  closing: HistoryEvent | undefined;
  private readonly started = new Map<number, number>();
  private readonly texts = new WeakMap<HistoryEvent, string>();

  add(e: HistoryEvent): void {
    this.counts.All += 1;
    this.counts[e.category] += 1;
    const a = e.attributes;
    const link = (from: number, to: number) => {
      this.pairs.set(from, { to, direction: "next" });
      this.pairs.set(to, { to: from, direction: "previous" });
    };
    switch (e.eventType) {
      case "ActivityTaskScheduled":
        this.activities.set(e.eventId, { name: at(a, "activityType", "name"), at: eventMs(e), activityId: at(a, "activityId") });
        break;
      case "ActivityTaskStarted": {
        const s = num(a["scheduledEventId"]);
        if (s !== null) this.started.set(s, e.eventId);
        break;
      }
      case "ActivityTaskCompleted":
      case "ActivityTaskFailed":
      case "ActivityTaskTimedOut":
      case "ActivityTaskCanceled": {
        const s = num(a["scheduledEventId"]);
        if (s === null) break;
        this.closed.add(s);
        link(s, e.eventId);
        const st = this.started.get(s);
        if (st !== undefined) this.pairs.set(st, { to: e.eventId, direction: "next" });
        break;
      }
      case "TimerFired":
      case "TimerCanceled": {
        const s = num(a["startedEventId"]);
        if (s !== null) link(s, e.eventId);
        break;
      }
      case "StartChildWorkflowExecutionInitiated":
        this.children.add(text(a["workflowId"]));
        break;
      case "ChildWorkflowExecutionCompleted":
      case "ChildWorkflowExecutionFailed":
      case "ChildWorkflowExecutionTimedOut":
      case "ChildWorkflowExecutionCanceled":
      case "ChildWorkflowExecutionTerminated":
      case "StartChildWorkflowExecutionFailed": {
        const s = num(a["initiatedEventId"]);
        if (s !== null) link(s, e.eventId);
        break;
      }
      default:
        if (CLOSING_EVENT.test(e.eventType)) this.closing = e;
    }
    const last = this.units[this.units.length - 1];
    if (!foldable(e)) this.units.push({ kind: "event", event: e });
    else if (last?.kind === "run") last.events.push(e);
    else this.units.push({ kind: "run", events: [e] });
  }

  /** The summaries' context, with the pending activities of the run. */
  context(pending: readonly Record<string, unknown>[] = []): SummaryContext {
    return { activities: this.activities, pending: pendingOf(pending), closed: this.closed };
  }

  /** The text Find searches in an event: its type, summary and decoded attributes, lower case; made once. */
  searchText(e: HistoryEvent, ctx: SummaryContext): string {
    let t = this.texts.get(e);
    if (t === undefined) {
      t = `${e.eventType}\n${historySummary(e, ctx)}\n${JSON.stringify(e.attributes)}`.toLowerCase();
      this.texts.set(e, t);
    }
    return t;
  }
}

const payloads = (value: unknown): string => {
  const n = Array.isArray(value) ? value.length : value === undefined || value === null ? 0 : 1;
  return `${n} payload${n === 1 ? "" : "s"}`;
};

/** One line about an event, as the mockup writes it: "ReserveInventory · 1.67 s · result 1 payload". */
export function historySummary(event: HistoryEvent, ctx: SummaryContext): string {
  const a = event.attributes;
  const parts: string[] = [];
  const activity = ctx.activities.get(num(a["scheduledEventId"]) ?? -1);
  switch (event.eventType) {
    case "WorkflowExecutionStarted":
      parts.push(at(a, "workflowType", "name"), `task queue ${at(a, "taskQueue", "name")}`, `input ${payloads(a["input"])}`);
      break;
    case "ActivityTaskScheduled": {
      parts.push(at(a, "activityType", "name"));
      const p = ctx.pending.get(at(a, "activityId"));
      if (p && !ctx.closed.has(event.eventId)) parts.push(`pending, attempt ${p.attempt}${p.maximumAttempts > 0 ? ` of ${p.maximumAttempts}` : ""}`);
      break;
    }
    case "ActivityTaskStarted":
      parts.push(activity?.name ?? "", `attempt ${at(a, "attempt") || "1"}`);
      break;
    case "ActivityTaskCompleted":
      parts.push(activity?.name ?? "", activity ? spanText(eventMs(event) - activity.at) : "", `result ${payloads(a["result"])}`);
      break;
    case "ActivityTaskFailed": {
      const failure = obj(a["failure"]);
      const info = obj(failure["applicationFailureInfo"]);
      parts.push(activity?.name ?? "", text(info["type"]) || text(failure["message"]), info["nonRetryable"] === true ? "non-retryable" : "");
      break;
    }
    case "ActivityTaskTimedOut":
      parts.push(activity?.name ?? "", "timed out");
      break;
    case "ActivityTaskCanceled":
      parts.push(activity?.name ?? "", "canceled");
      break;
    case "TimerStarted": {
      const fire = durationMs(a["startToFireTimeout"]);
      parts.push(at(a, "timerId"), fire === null ? "" : spanText(fire), fire === null ? "" : `fires ${clockText(eventMs(event) + fire)}`);
      break;
    }
    case "TimerFired":
      parts.push(at(a, "timerId"), "fired");
      break;
    case "TimerCanceled":
      parts.push(at(a, "timerId"), "canceled");
      break;
    case "WorkflowExecutionSignaled":
      parts.push(at(a, "signalName"), payloads(a["input"]));
      break;
    case "WorkflowExecutionCompleted":
      parts.push(`result ${payloads(a["result"])}`);
      break;
    default:
      return eventSummary(event);
  }
  return parts.filter(Boolean).join(" · ");
}

/** A row of the History table: one event, or a run of workflow task events folded into one. */
/** `inFold`: the event is one of an open fold's, drawn indented under it with a guide line. */
export type HistoryRow = { kind: "event"; event: HistoryEvent; inFold?: true } | { kind: "group"; events: HistoryEvent[]; first: number; last: number; open: boolean };

export interface RowOptions {
  category: EventCategory | "All";
  /** Folds each run of workflow task events (Scheduled, Started, Completed) into a row. */
  fold: boolean;
  /** Groups shown open, by their first event id. */
  expanded: ReadonlySet<number>;
  /** Searches types, summaries and decoded attributes, case-insensitively; empty for none. */
  query: string;
  ctx: SummaryContext;
}

/** The rows to draw. A search or a category shows matching events flat; otherwise workflow tasks fold. */
export function historyRows(events: readonly HistoryEvent[], options: RowOptions): HistoryRow[] {
  const q = options.query.trim().toLowerCase();
  let shown: readonly HistoryEvent[] = events;
  if (options.category !== "All") shown = shown.filter((e) => e.category === options.category);
  if (q) shown = shown.filter((e) => e.eventType.toLowerCase().includes(q) || historySummary(e, options.ctx).toLowerCase().includes(q) || JSON.stringify(e.attributes).toLowerCase().includes(q));
  if (!options.fold || q || options.category !== "All") return shown.map((event) => ({ kind: "event", event }));
  const rows: HistoryRow[] = [];
  let run: HistoryEvent[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const first = run[0]!.eventId;
      const open = options.expanded.has(first);
      rows.push({ kind: "group", events: run, first, last: run[run.length - 1]!.eventId, open });
      if (open) for (const event of run) rows.push({ kind: "event", event, inFold: true });
    } else {
      for (const event of run) rows.push({ kind: "event", event });
    }
    run = [];
  };
  for (const event of shown) {
    // A failed or timed out workflow task stays its own row: it is what someone looks for.
    if (event.category === "WorkflowTask" && !isFailure(event)) {
      run.push(event);
    } else {
      flush();
      rows.push({ kind: "event", event });
    }
  }
  flush();
  return rows;
}

/**
 * The rows History draws, by index, without building them all (TSK-109): `count` rows, `row(i)`
 * the i-th from the top, `find(id)` the row of an event (or of the closed fold that holds it).
 */
export interface RowModel {
  readonly count: number;
  row(i: number): HistoryRow;
  find(id: number): { index: number; fold?: number } | null;
}

/** The first index in `0..n` whose key is over `id`, for keys in increasing order. */
function upper(n: number, key: (i: number) => number, id: number): number {
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(mid) <= id) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Events shown flat (a category, a search, or every event), from a list in time order, oldest or newest first. */
export function flatRows(events: readonly HistoryEvent[], newestFirst = false): RowModel {
  const n = events.length;
  const at = (i: number) => events[newestFirst ? n - 1 - i : i]!;
  return {
    count: n,
    row: (i) => ({ kind: "event", event: at(i) }),
    find(id) {
      const k = upper(n, (i) => events[i]!.eventId, id) - 1;
      if (k < 0 || events[k]!.eventId !== id) return null;
      return { index: newestFirst ? n - 1 - k : k };
    },
  };
}

/** The folded table from its units: a run of two or more workflow task events is a fold, open when its first event is in `expanded`. */
export function foldedRows(units: readonly FoldUnit[], expanded: ReadonlySet<number>, newestFirst = false): RowModel {
  const n = units.length;
  const unit = (k: number) => units[newestFirst ? n - 1 - k : k]!;
  const firstId = (u: FoldUnit) => (u.kind === "event" ? u.event.eventId : u.events[0]!.eventId);
  // The open folds in display order, with how many rows each adds.
  const opens: { k: number; size: number }[] = [];
  for (const first of expanded) {
    const u = upper(n, (i) => firstId(units[i]!), first) - 1;
    const it = u >= 0 ? units[u]! : undefined;
    if (it?.kind === "run" && it.events.length >= 2 && it.events[0]!.eventId === first) opens.push({ k: newestFirst ? n - 1 - u : u, size: it.events.length });
  }
  opens.sort((x, y) => x.k - y.k);
  const count = n + opens.reduce((t, o) => t + o.size, 0);
  const shown = (u: FoldUnit, open: boolean): HistoryRow => {
    if (u.kind === "event") return { kind: "event", event: u.event };
    if (u.events.length === 1) return { kind: "event", event: u.events[0]! };
    return { kind: "group", events: u.events, first: u.events[0]!.eventId, last: u.events[u.events.length - 1]!.eventId, open };
  };
  return {
    count,
    row(i) {
      let extra = 0;
      for (const o of opens) {
        const start = o.k + extra;
        if (i < start) break;
        if (i <= start + o.size) {
          const u = unit(o.k);
          if (i === start) return shown(u, true);
          const events = (u as { events: HistoryEvent[] }).events;
          const j = i - start - 1;
          return { kind: "event", event: events[newestFirst ? events.length - 1 - j : j]!, inFold: true };
        }
        extra += o.size;
      }
      return shown(unit(i - extra), false);
    },
    find(id) {
      const u = upper(n, (i) => firstId(units[i]!), id) - 1;
      if (u < 0) return null;
      const it = units[u]!;
      const k = newestFirst ? n - 1 - u : u;
      const start = k + opens.filter((o) => o.k < k).reduce((t, o) => t + o.size, 0);
      if (it.kind === "event") return it.event.eventId === id ? { index: start } : null;
      const j = it.events.findIndex((e) => e.eventId === id);
      if (j < 0) return null;
      if (it.events.length === 1) return { index: start };
      if (!opens.some((o) => o.k === k)) return { index: start, fold: it.events[0]!.eventId };
      return { index: start + 1 + (newestFirst ? it.events.length - 1 - j : j) };
    },
  };
}

/** Every row of a model, for a test or a small history. */
export function allRows(model: RowModel): HistoryRow[] {
  return Array.from({ length: model.count }, (_, i) => model.row(i));
}

/** A folded group's summary: "3 events · 76 ms · worker orders-7f9c@host-3". */
export function groupSummary(events: readonly HistoryEvent[]): string {
  const span = events.length > 1 ? eventMs(events[events.length - 1]!) - eventMs(events[0]!) : 0;
  const worker = events.map((e) => at(e.attributes, "identity")).find(Boolean);
  return [`${events.length} events`, spanText(span), worker ? `worker ${worker}` : ""].filter(Boolean).join(" · ");
}

/** The whole history as Temporal's CLI writes it (`temporal workflow show --output json`): `{ "events": [...] }`, payloads decoded. */
export function historyJson(events: readonly HistoryEvent[]): string {
  return JSON.stringify({ events: events.map((e) => ({ eventId: String(e.eventId), eventTime: e.eventTime, eventType: e.eventType, [`${e.eventType.charAt(0).toLowerCase()}${e.eventType.slice(1)}EventAttributes`]: e.attributes })) }, null, 2);
}
