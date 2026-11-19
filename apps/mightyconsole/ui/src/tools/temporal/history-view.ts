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
  const counts: Record<EventCategory | "All", number> = { All: events.length, Workflow: 0, WorkflowTask: 0, Activity: 0, Timer: 0, ChildWorkflow: 0, Signal: 0, Update: 0, Marker: 0, Other: 0 };
  for (const e of events) counts[e.category] += 1;
  return counts;
}

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
  const pairs = new Map<number, { to: number; direction: "next" | "previous" }>();
  const link = (from: number, to: number) => {
    pairs.set(from, { to, direction: "next" });
    pairs.set(to, { to: from, direction: "previous" });
  };
  const started = new Map<number, number>();
  for (const e of events) {
    const a = e.attributes;
    switch (e.eventType) {
      case "ActivityTaskStarted": {
        const s = num(a["scheduledEventId"]);
        if (s !== null) started.set(s, e.eventId);
        break;
      }
      case "ActivityTaskCompleted":
      case "ActivityTaskFailed":
      case "ActivityTaskTimedOut":
      case "ActivityTaskCanceled": {
        const s = num(a["scheduledEventId"]);
        if (s === null) break;
        link(s, e.eventId);
        const st = started.get(s);
        if (st !== undefined) pairs.set(st, { to: e.eventId, direction: "next" });
        break;
      }
      case "TimerFired":
      case "TimerCanceled": {
        const s = num(a["startedEventId"]);
        if (s !== null) link(s, e.eventId);
        break;
      }
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
    }
  }
  return pairs;
}

/** What the summaries need beyond one event: activity names by their Scheduled event, and the pending attempts. */
export interface SummaryContext {
  activities: Map<number, { name: string; at: number; activityId: string }>;
  /** By activity id. */
  pending: Map<string, { attempt: number; maximumAttempts: number }>;
  closed: Set<number>;
}

export function summaryContext(events: readonly HistoryEvent[], pending: readonly Record<string, unknown>[] = []): SummaryContext {
  const activities = new Map<number, { name: string; at: number; activityId: string }>();
  const closed = new Set<number>();
  for (const e of events) {
    if (e.eventType === "ActivityTaskScheduled") activities.set(e.eventId, { name: at(e.attributes, "activityType", "name"), at: eventMs(e), activityId: at(e.attributes, "activityId") });
    if (/^ActivityTask(Completed|Failed|TimedOut|Canceled)$/.test(e.eventType)) {
      const s = num(e.attributes["scheduledEventId"]);
      if (s !== null) closed.add(s);
    }
  }
  const p = new Map<string, { attempt: number; maximumAttempts: number }>();
  for (const x of pending) p.set(text(x["activityId"]), { attempt: num(x["attempt"]) ?? 1, maximumAttempts: num(x["maximumAttempts"]) ?? 0 });
  return { activities, pending: p, closed };
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
