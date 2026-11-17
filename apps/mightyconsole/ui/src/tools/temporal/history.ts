// A workflow's history read for the screens (Mightyconsole spec §9.3): the events as Timeline
// lanes and items, one line of summary per event, and the input and result. Pure, over the
// `HistoryEvent`s the server sends (payloads already decoded); nothing here knows the network.
import type { EventCategory, HistoryEvent } from "@/gen/api";

/** A Timeline lane and item, as `packages/ui`'s Timeline takes them (the app passes the same shapes). */
export interface Lane {
  id: string;
  label: string;
}
export type ItemStatus = "running" | "success" | "danger" | "warning" | "info" | "neutral";
export interface Item {
  id: string;
  laneId: string;
  start: number;
  end: number | null;
  status: ItemStatus;
  label: string;
}

export const LANES = {
  workflow: { id: "workflow", label: "Workflow" },
  activities: { id: "activities", label: "Activities" },
  timers: { id: "timers", label: "Timers" },
  children: { id: "children", label: "Child workflows" },
  signals: { id: "signals", label: "Signals" },
  updates: { id: "updates", label: "Updates" },
} as const satisfies Record<string, Lane>;

type Attributes = Record<string, unknown>;

const obj = (value: unknown): Attributes => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Attributes) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

/** `attributes.a.b` as text, or "". */
const at = (attributes: Attributes, ...path: string[]): string => {
  let value: unknown = attributes;
  for (const key of path) value = obj(value)[key];
  return text(value);
};

/** An event's time in ms; events without a valid time sit at 0. */
export function eventMs(event: HistoryEvent): number {
  const ms = event.eventTime ? Date.parse(event.eventTime) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/** The failure message of an attributes object, or "". */
export function failureMessage(attributes: Attributes): string {
  return at(attributes, "failure", "message");
}

/** `CamelCase` split into words: "ActivityTaskScheduled" -> "Activity task scheduled". */
export function eventTitle(eventType: string): string {
  const words = eventType.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** One line about an event: what it concerns, for the History table. */
export function eventSummary(event: HistoryEvent): string {
  const a = event.attributes;
  const parts: string[] = [];
  const add = (label: string, value: string) => {
    if (value) parts.push(label ? `${label} ${value}` : value);
  };
  switch (event.eventType) {
    case "WorkflowExecutionStarted":
      add("", at(a, "workflowType", "name"));
      add("on", at(a, "taskQueue", "name"));
      break;
    case "WorkflowExecutionCompleted":
      break;
    case "WorkflowExecutionFailed":
    case "ActivityTaskFailed":
    case "ChildWorkflowExecutionFailed":
    case "WorkflowTaskFailed":
      add("", failureMessage(a));
      break;
    case "WorkflowExecutionSignaled":
      add("", at(a, "signalName"));
      break;
    case "WorkflowExecutionCancelRequested":
    case "WorkflowExecutionTerminated":
      add("", at(a, "cause") || at(a, "reason"));
      break;
    case "ActivityTaskScheduled":
      add("", at(a, "activityType", "name"));
      add("id", at(a, "activityId"));
      break;
    case "ActivityTaskStarted":
      add("attempt", at(a, "attempt"));
      add("by", at(a, "identity"));
      break;
    case "ActivityTaskCompleted":
    case "ActivityTaskCanceled":
    case "ActivityTaskTimedOut":
      add("scheduled at", at(a, "scheduledEventId"));
      break;
    case "TimerStarted":
      add("", at(a, "timerId"));
      add("fires in", at(a, "startToFireTimeout"));
      break;
    case "TimerFired":
    case "TimerCanceled":
      add("", at(a, "timerId"));
      break;
    case "StartChildWorkflowExecutionInitiated":
      add("", at(a, "workflowType", "name"));
      add("id", at(a, "workflowId"));
      break;
    case "ChildWorkflowExecutionStarted":
    case "ChildWorkflowExecutionCompleted":
      add("", at(a, "workflowType", "name"));
      add("id", at(a, "workflowExecution", "workflowId"));
      break;
    case "WorkflowTaskScheduled":
      add("on", at(a, "taskQueue", "name"));
      break;
    case "WorkflowTaskStarted":
      add("by", at(a, "identity"));
      break;
    case "MarkerRecorded":
      add("", at(a, "markerName"));
      break;
    case "UpsertWorkflowSearchAttributes":
      add("", Object.keys(obj(a["searchAttributes"])).join(", "));
      break;
    default:
      if (event.eventType.startsWith("WorkflowExecutionUpdate")) add("", at(a, "acceptedRequest", "input", "name") || at(a, "updateId"));
  }
  return parts.join(" ");
}

/** The categories the History filter offers, in the order of the spec. */
export const CATEGORIES: readonly EventCategory[] = ["Workflow", "WorkflowTask", "Activity", "Timer", "ChildWorkflow", "Signal", "Update", "Marker", "Other"];

const CLOSING: Record<string, ItemStatus> = {
  WorkflowExecutionCompleted: "success",
  WorkflowExecutionContinuedAsNew: "info",
  WorkflowExecutionFailed: "danger",
  WorkflowExecutionTimedOut: "warning",
  WorkflowExecutionCanceled: "neutral",
  WorkflowExecutionTerminated: "warning",
};

/** Whether the history shows the run closed. */
export function isClosed(events: readonly HistoryEvent[]): boolean {
  return events.some((e) => e.eventType in CLOSING);
}

const ACTIVITY_END: Record<string, ItemStatus> = {
  ActivityTaskCompleted: "success",
  ActivityTaskFailed: "danger",
  ActivityTaskTimedOut: "warning",
  ActivityTaskCanceled: "neutral",
};
const CHILD_END: Record<string, ItemStatus> = {
  ChildWorkflowExecutionCompleted: "success",
  ChildWorkflowExecutionFailed: "danger",
  ChildWorkflowExecutionTimedOut: "warning",
  ChildWorkflowExecutionCanceled: "neutral",
  ChildWorkflowExecutionTerminated: "warning",
};

export interface TimelineData {
  lanes: Lane[];
  items: Item[];
}

/**
 * The Timeline of a history: the run as one bar, each activity from its scheduling to its end (the
 * attempt count in its label), timers, child workflows, and signals and updates as instants.
 * Lanes appear only when they have something. Items still open have `end: null`.
 */
export function buildTimeline(events: readonly HistoryEvent[]): TimelineData {
  const items: Item[] = [];
  const open = new Map<string, Item>();
  const attempts = new Map<number, number>();
  let run: Item | null = null;
  for (const event of events) {
    const t = eventMs(event);
    const a = event.attributes;
    switch (event.eventType) {
      case "WorkflowExecutionStarted": {
        run = { id: `e${event.eventId}`, laneId: LANES.workflow.id, start: t, end: null, status: "running", label: at(a, "workflowType", "name") || "Workflow" };
        items.push(run);
        break;
      }
      case "ActivityTaskScheduled": {
        const item: Item = { id: `e${event.eventId}`, laneId: LANES.activities.id, start: t, end: null, status: "running", label: at(a, "activityType", "name") || "Activity" };
        open.set(`activity:${event.eventId}`, item);
        items.push(item);
        break;
      }
      case "ActivityTaskStarted": {
        const scheduled = num(a["scheduledEventId"]);
        const attempt = num(a["attempt"]);
        if (scheduled !== null && attempt !== null) attempts.set(scheduled, attempt);
        break;
      }
      case "ActivityTaskCompleted":
      case "ActivityTaskFailed":
      case "ActivityTaskTimedOut":
      case "ActivityTaskCanceled": {
        const scheduled = num(a["scheduledEventId"]);
        const item = scheduled === null ? undefined : open.get(`activity:${scheduled}`);
        if (item && scheduled !== null) {
          item.end = t;
          item.status = ACTIVITY_END[event.eventType] ?? "neutral";
          const attempt = attempts.get(scheduled);
          if (attempt && attempt > 1) item.label = `${item.label} (attempt ${attempt})`;
        }
        break;
      }
      case "TimerStarted": {
        const item: Item = { id: `e${event.eventId}`, laneId: LANES.timers.id, start: t, end: null, status: "info", label: `Timer ${at(a, "timerId")}`.trim() };
        open.set(`timer:${event.eventId}`, item);
        items.push(item);
        break;
      }
      case "TimerFired":
      case "TimerCanceled": {
        const started = num(a["startedEventId"]);
        const item = started === null ? undefined : open.get(`timer:${started}`);
        if (item) {
          item.end = t;
          item.status = event.eventType === "TimerFired" ? "success" : "neutral";
        }
        break;
      }
      case "StartChildWorkflowExecutionInitiated": {
        const item: Item = { id: `e${event.eventId}`, laneId: LANES.children.id, start: t, end: null, status: "running", label: at(a, "workflowType", "name") || at(a, "workflowId") || "Child workflow" };
        open.set(`child:${event.eventId}`, item);
        items.push(item);
        break;
      }
      case "StartChildWorkflowExecutionFailed": {
        const initiated = num(a["initiatedEventId"]);
        const item = initiated === null ? undefined : open.get(`child:${initiated}`);
        if (item) {
          item.end = t;
          item.status = "danger";
        }
        break;
      }
      case "ChildWorkflowExecutionCompleted":
      case "ChildWorkflowExecutionFailed":
      case "ChildWorkflowExecutionTimedOut":
      case "ChildWorkflowExecutionCanceled":
      case "ChildWorkflowExecutionTerminated": {
        const initiated = num(a["initiatedEventId"]);
        const item = initiated === null ? undefined : open.get(`child:${initiated}`);
        if (item) {
          item.end = t;
          item.status = CHILD_END[event.eventType] ?? "neutral";
        }
        break;
      }
      case "WorkflowExecutionSignaled":
        items.push({ id: `e${event.eventId}`, laneId: LANES.signals.id, start: t, end: t, status: "neutral", label: `Signal ${at(a, "signalName")}`.trim() });
        break;
      case "WorkflowExecutionUpdateAccepted":
      case "WorkflowExecutionUpdateCompleted":
      case "WorkflowExecutionUpdateRejected":
        items.push({ id: `e${event.eventId}`, laneId: LANES.updates.id, start: t, end: t, status: event.eventType === "WorkflowExecutionUpdateRejected" ? "danger" : "neutral", label: eventTitle(event.eventType) });
        break;
      default: {
        const closing = CLOSING[event.eventType];
        if (closing && run) {
          run.end = t;
          run.status = closing;
        }
      }
    }
  }
  const used = new Set(items.map((i) => i.laneId));
  const lanes = Object.values(LANES).filter((l) => used.has(l.id));
  return { lanes, items };
}

/** The event id an item stands for (`e12` is event 12). */
export function itemEventId(itemId: string): number | null {
  const n = Number(itemId.replace(/^e/, ""));
  return Number.isInteger(n) ? n : null;
}

/** The workflow's input, its result or failure, from the start and close events. */
export interface InputAndResult {
  input: unknown;
  /** `result` of a completed run, else absent. */
  result?: unknown;
  /** The failure of a failed run (message, stack, cause chain), else absent. */
  failure?: Attributes;
  /** How the run closed: the close event's type, absent while it runs. */
  closedBy?: string;
  memo?: unknown;
  searchAttributes?: unknown;
}

export function inputAndResult(events: readonly HistoryEvent[]): InputAndResult {
  const started = events.find((e) => e.eventType === "WorkflowExecutionStarted");
  const closing = [...events].reverse().find((e) => e.eventType in CLOSING);
  const out: InputAndResult = { input: started?.attributes["input"] ?? [] };
  const sa = started?.attributes["searchAttributes"];
  if (sa !== undefined) out.searchAttributes = obj(sa)["indexedFields"] ?? sa;
  const memo = started?.attributes["memo"];
  if (memo !== undefined) out.memo = obj(memo)["fields"] ?? memo;
  if (closing) {
    out.closedBy = closing.eventType;
    if ("result" in closing.attributes) out.result = closing.attributes["result"];
    const failure = closing.attributes["failure"];
    if (failure !== undefined) out.failure = obj(failure);
  }
  return out;
}

/** The failure chain of a failure object, outermost first: `{ message, type?, stackTrace? }[]`. */
export function failureChain(failure: Attributes | undefined): { message: string; type?: string; stackTrace?: string }[] {
  const chain: { message: string; type?: string; stackTrace?: string }[] = [];
  let current: Attributes | undefined = failure;
  while (current && chain.length < 20) {
    const info = obj(current["applicationFailureInfo"]);
    const entry: { message: string; type?: string; stackTrace?: string } = { message: text(current["message"]) };
    const type = text(info["type"]);
    if (type) entry.type = type;
    const stack = text(current["stackTrace"]);
    if (stack) entry.stackTrace = stack;
    chain.push(entry);
    const cause = current["cause"];
    current = cause === undefined ? undefined : obj(cause);
  }
  return chain;
}
