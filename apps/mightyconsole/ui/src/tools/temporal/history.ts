// A workflow's history read for the screens (Mightyconsole spec §9.3): the events as Timeline
// lanes and items, one line of summary per event, and the input and result. Pure, over the
// `HistoryEvent`s the server sends (payloads already decoded); nothing here knows the network.
import type { EventCategory, HistoryEvent } from "@/gen/api";

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

/** What a lane holds; the Timeline's filter chips go by it. */
export type LaneKind = "workflow" | "workflowTask" | "activity" | "timer" | "child" | "signal" | "update" | "marker";

/** A Timeline lane, as `packages/ui`'s Timeline takes it (the app adds the icon by `kind`). */
export interface Lane {
  id: string;
  label: string;
  /** The muted words after the label: "activity 5", "4 tasks", "signal 13". */
  detail: string;
  kind: LaneKind;
}
export type ItemStatus = "running" | "success" | "danger" | "warning" | "info" | "neutral";
export type ItemShape = "bar" | "hatched" | "dashed" | "tick" | "diamond" | "pin";
/** A Timeline item, as `packages/ui`'s Timeline takes it. */
export interface Item {
  id: string;
  laneId: string;
  start: number;
  end: number | null;
  status: ItemStatus;
  label: string;
  shape?: ItemShape;
  caption?: string;
}

/** What the strip under the Timeline says about a selected item. */
export interface ItemInfo {
  /** The thing's name: the activity type, the timer id, the signal name. */
  name: string;
  /** Its kind and first event: "activity 18". */
  what: string;
  /** "Completed", "Failed", "Retrying", "Running", "Fired"... */
  state: string;
  status: ItemStatus;
  start: number;
  end: number | null;
  /** The events it covers (first and last ids), for "Events 18–20 in History". */
  firstEventId: number;
  lastEventId: number;
  attempt?: number;
  maximumAttempts?: number;
  taskQueue?: string;
  failure?: { type?: string; message: string; nonRetryable: boolean };
}

export interface TimelineData {
  lanes: Lane[];
  items: Item[];
  /** By item id. */
  info: Map<string, ItemInfo>;
  /** How many of each kind: lanes for activities, timers and children; events for the rest. */
  counts: Record<LaneKind, number>;
}

export interface TimelineOptions {
  /** The workflow lane's name; "Workflow" when absent. */
  workflowId?: string | undefined;
  /** `WorkflowDetail.pendingActivities`: the attempt and last failure of open activities (history only has them once they close). */
  pending?: readonly Record<string, unknown>[] | undefined;
  /** The clock for open items' "so far". */
  now?: number | undefined;
}

/** "850 ms", "1.67 s", "11.8 s", "12m 4s", "30m", "2h 5m", "3d 4h": a duration for a caption. */
export function spanText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(2))} s`;
  if (ms < 60_000) return `${Number((ms / 1000).toFixed(1))} s`;
  const s = Math.round(ms / 1000);
  const two = (big: number, bigUnit: string, small: number, smallUnit: string) => `${big}${bigUnit}${small > 0 ? ` ${small}${smallUnit}` : ""}`;
  if (s < 3600) return two(Math.floor(s / 60), "m", s % 60, "s");
  const m = Math.round(s / 60);
  if (m < 1440) return two(Math.floor(m / 60), "h", m % 60, "m");
  const h = Math.round(m / 60);
  return two(Math.floor(h / 24), "d", h % 24, "h");
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** A local clock time: "10:43:30", or "10:43:30.004" with `ms`. */
export function clockText(t: number, ms = false): string {
  const d = new Date(t);
  const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return ms ? `${hms}.${pad(d.getMilliseconds(), 3)}` : hms;
}

/** A protobuf JSON Duration ("1800s", "0.5s") in ms, or null. */
export function durationMs(value: unknown): number | null {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(text(value));
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** The failure of an attributes object as the strip shows it, or undefined. */
function failureOf(value: unknown): ItemInfo["failure"] {
  const f = obj(value);
  const message = text(f["message"]);
  if (!message) return undefined;
  const info = obj(f["applicationFailureInfo"]);
  const type = text(info["type"]);
  return { message, nonRetryable: info["nonRetryable"] === true, ...(type ? { type } : {}) };
}

const ACTIVITY_END: Record<string, [ItemStatus, string]> = {
  ActivityTaskCompleted: ["success", "Completed"],
  ActivityTaskFailed: ["danger", "Failed"],
  ActivityTaskTimedOut: ["warning", "Timed out"],
  ActivityTaskCanceled: ["neutral", "Canceled"],
};
const CHILD_END: Record<string, [ItemStatus, string]> = {
  ChildWorkflowExecutionCompleted: ["success", "Completed"],
  ChildWorkflowExecutionFailed: ["danger", "Failed"],
  ChildWorkflowExecutionTimedOut: ["warning", "Timed out"],
  ChildWorkflowExecutionCanceled: ["neutral", "Canceled"],
  ChildWorkflowExecutionTerminated: ["warning", "Terminated"],
  StartChildWorkflowExecutionFailed: ["danger", "Failed to start"],
};
const CLOSE_WORD: Record<string, string> = {
  WorkflowExecutionCompleted: "Completed",
  WorkflowExecutionContinuedAsNew: "Continued as new",
  WorkflowExecutionFailed: "Failed",
  WorkflowExecutionTimedOut: "Timed out",
  WorkflowExecutionCanceled: "Canceled",
  WorkflowExecutionTerminated: "Terminated",
};
const NO_COUNTS: Record<LaneKind, number> = { workflow: 0, workflowTask: 0, activity: 0, timer: 0, child: 0, signal: 0, update: 0, marker: 0 };

/**
 * The Timeline of a history, as the mockup draws it: one lane per thing in the order of its first
 * event (the workflow, its workflow tasks as ticks, each activity, timer and child workflow, each
 * signal, update and marker name), each item shaped by kind and captioned with its state and
 * duration. Open activities read their attempt and last failure from the pending activities:
 * one past its first attempt is drawn hatched, "Retrying · attempt 3 of 5". Items still open have `end: null`.
 */
export function buildTimeline(events: readonly HistoryEvent[], options: TimelineOptions = {}): TimelineData {
  const now = options.now ?? (events.length > 0 ? eventMs(events[events.length - 1]!) : 0);
  const lanes: Lane[] = [];
  const laneByKey = new Map<string, Lane>();
  const items: Item[] = [];
  const info = new Map<string, ItemInfo>();
  const counts = { ...NO_COUNTS };
  const byEvent = new Map<number, Item>();
  const startedAttempt = new Map<number, number>();
  const pendingById = new Map<string, Record<string, unknown>>();
  for (const p of options.pending ?? []) pendingById.set(text(p["activityId"]), p);
  const groupCount = new Map<string, number>();

  const lane = (key: string, kind: LaneKind, label: string, detail: string): Lane => {
    let l = laneByKey.get(key);
    if (!l) {
      l = { id: key, label, detail, kind };
      laneByKey.set(key, l);
      lanes.push(l);
    }
    return l;
  };
  const add = (item: Item, meta: ItemInfo, eventId: number) => {
    items.push(item);
    info.set(item.id, meta);
    byEvent.set(eventId, item);
  };
  // Signals, updates and markers share a lane by name: "signal 13" for one, "3 signals" for more.
  const grouped = (kind: LaneKind, word: string, name: string, eventId: number): Lane => {
    const key = `${kind}:${name}`;
    const n = (groupCount.get(key) ?? 0) + 1;
    groupCount.set(key, n);
    const l = lane(key, kind, name, `${word} ${eventId}`);
    if (n > 1) l.detail = `${n} ${word}s`;
    counts[kind] += 1;
    return l;
  };
  const close = (eventId: number, t: number, status: ItemStatus, state: string, lastEventId: number, failure?: ItemInfo["failure"]) => {
    const item = byEvent.get(eventId);
    const meta = item ? info.get(item.id) : undefined;
    if (!item || !meta) return null;
    item.end = t;
    item.status = status;
    meta.end = t;
    meta.status = status;
    meta.state = state;
    meta.lastEventId = lastEventId;
    if (failure) meta.failure = failure;
    return { item, meta };
  };

  for (const event of events) {
    const t = eventMs(event);
    const a = event.attributes;
    const id = event.eventId;
    switch (event.eventType) {
      case "WorkflowExecutionStarted": {
        const name = options.workflowId || at(a, "workflowType", "name") || "Workflow";
        const l = lane("workflow", "workflow", name, "workflow");
        counts.workflow = 1;
        add({ id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name }, { name, what: "workflow", state: "Running", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id);
        break;
      }
      case "WorkflowTaskScheduled": {
        const l = lane("workflowTask", "workflowTask", "Workflow tasks", "");
        counts.workflowTask += 1;
        l.detail = `${counts.workflowTask} task${counts.workflowTask === 1 ? "" : "s"}`;
        add({ id: `e${id}`, laneId: l.id, start: t, end: t, status: "neutral", label: `Workflow task ${id}`, shape: "tick" }, { name: "Workflow task", what: `task ${id}`, state: "Scheduled", status: "neutral", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id);
        break;
      }
      case "WorkflowTaskStarted":
      case "WorkflowTaskCompleted":
      case "WorkflowTaskFailed":
      case "WorkflowTaskTimedOut": {
        const scheduled = num(a["scheduledEventId"]);
        const item = scheduled === null ? undefined : byEvent.get(scheduled);
        const meta = item ? info.get(item.id) : undefined;
        if (!item || !meta) break;
        meta.lastEventId = id;
        if (event.eventType === "WorkflowTaskStarted") {
          meta.state = "Started";
        } else {
          const status: ItemStatus = event.eventType === "WorkflowTaskFailed" ? "danger" : event.eventType === "WorkflowTaskTimedOut" ? "warning" : "neutral";
          item.status = status;
          meta.status = status;
          meta.end = t;
          meta.state = event.eventType === "WorkflowTaskFailed" ? "Failed" : event.eventType === "WorkflowTaskTimedOut" ? "Timed out" : "Completed";
          const failure = failureOf(a["failure"]);
          if (failure) meta.failure = failure;
        }
        break;
      }
      case "ActivityTaskScheduled": {
        const name = at(a, "activityType", "name") || "Activity";
        const l = lane(`activity:${id}`, "activity", name, `activity ${id}`);
        counts.activity += 1;
        const activityId = at(a, "activityId");
        const max = num(obj(a["retryPolicy"])["maximumAttempts"]);
        const meta: ItemInfo = { name, what: `activity ${id}`, state: "Scheduled", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") };
        if (max) meta.maximumAttempts = max;
        const item: Item = { id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name };
        const p = pendingById.get(activityId);
        if (p) {
          const attempt = num(p["attempt"]) ?? 1;
          const pmax = num(p["maximumAttempts"]);
          meta.attempt = attempt;
          if (pmax) meta.maximumAttempts = pmax;
          const failure = failureOf(p["lastFailure"]);
          if (failure) meta.failure = failure;
          if (attempt > 1 || failure) {
            item.shape = "hatched";
            item.status = "warning";
            meta.status = "warning";
            meta.state = "Retrying";
          } else if (/STARTED/.test(text(p["state"]))) {
            meta.state = "Running";
          }
        }
        add(item, meta, id);
        break;
      }
      case "ActivityTaskStarted": {
        const scheduled = num(a["scheduledEventId"]);
        const attempt = num(a["attempt"]);
        if (scheduled !== null && attempt !== null) startedAttempt.set(scheduled, attempt);
        const item = scheduled === null ? undefined : byEvent.get(scheduled);
        const meta = item ? info.get(item.id) : undefined;
        if (meta && meta.state === "Scheduled") meta.state = "Running";
        if (meta) meta.lastEventId = id;
        break;
      }
      case "ActivityTaskCompleted":
      case "ActivityTaskFailed":
      case "ActivityTaskTimedOut":
      case "ActivityTaskCanceled": {
        const scheduled = num(a["scheduledEventId"]);
        const [status, state] = ACTIVITY_END[event.eventType]!;
        const done = scheduled === null ? null : close(scheduled, t, status, state, id, failureOf(a["failure"]));
        if (done && scheduled !== null) {
          done.item.shape = "bar";
          const attempt = startedAttempt.get(scheduled);
          if (attempt) done.meta.attempt = attempt;
        }
        break;
      }
      case "TimerStarted": {
        const timerId = at(a, "timerId") || String(id);
        const l = lane(`timer:${id}`, "timer", timerId, `timer ${id}`);
        counts.timer += 1;
        const fire = durationMs(a["startToFireTimeout"]);
        add({ id: `e${id}`, laneId: l.id, start: t, end: null, status: "info", label: `Timer ${timerId}`, shape: "dashed", caption: fire === null ? "Waiting" : `${spanText(fire)} · fires ${clockText(t + fire)}` }, { name: timerId, what: `timer ${id}`, state: "Waiting", status: "info", start: t, end: null, firstEventId: id, lastEventId: id }, id);
        break;
      }
      case "TimerFired":
      case "TimerCanceled": {
        const started = num(a["startedEventId"]);
        const fired = event.eventType === "TimerFired";
        const done = started === null ? null : close(started, t, fired ? "success" : "neutral", fired ? "Fired" : "Canceled", id);
        if (done) done.item.caption = fired ? `${spanText(t - done.item.start)} · fired` : `Canceled after ${spanText(t - done.item.start)}`;
        break;
      }
      case "StartChildWorkflowExecutionInitiated": {
        const name = at(a, "workflowId") || at(a, "workflowType", "name") || "Child workflow";
        const l = lane(`child:${id}`, "child", name, `child ${id}`);
        counts.child += 1;
        add({ id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name }, { name, what: `child ${id}`, state: "Starting", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id);
        break;
      }
      case "ChildWorkflowExecutionStarted": {
        const initiated = num(a["initiatedEventId"]);
        const item = initiated === null ? undefined : byEvent.get(initiated);
        const meta = item ? info.get(item.id) : undefined;
        if (meta) {
          meta.state = "Running";
          meta.lastEventId = id;
        }
        break;
      }
      case "StartChildWorkflowExecutionFailed":
      case "ChildWorkflowExecutionCompleted":
      case "ChildWorkflowExecutionFailed":
      case "ChildWorkflowExecutionTimedOut":
      case "ChildWorkflowExecutionCanceled":
      case "ChildWorkflowExecutionTerminated": {
        const initiated = num(a["initiatedEventId"]);
        const [status, state] = CHILD_END[event.eventType]!;
        if (initiated !== null) close(initiated, t, status, state, id, failureOf(a["failure"]));
        break;
      }
      case "WorkflowExecutionSignaled": {
        const name = at(a, "signalName") || "signal";
        const l = grouped("signal", "signal", name, id);
        const input = a["input"];
        const n = Array.isArray(input) ? input.length : input === undefined || input === null ? 0 : 1;
        add({ id: `e${id}`, laneId: l.id, start: t, end: t, status: "info", label: `Signal ${name}`, shape: "diamond", caption: `${clockText(t, true)} · ${n} payload${n === 1 ? "" : "s"}` }, { name, what: `signal ${id}`, state: "Received", status: "info", start: t, end: t, firstEventId: id, lastEventId: id }, id);
        break;
      }
      case "WorkflowExecutionUpdateAccepted":
      case "WorkflowExecutionUpdateCompleted":
      case "WorkflowExecutionUpdateRejected": {
        const name = at(a, "acceptedRequest", "input", "name") || at(a, "rejectedRequest", "input", "name") || at(a, "meta", "updateId") || "update";
        const rejected = event.eventType === "WorkflowExecutionUpdateRejected";
        const state = rejected ? "Rejected" : event.eventType === "WorkflowExecutionUpdateCompleted" ? "Completed" : "Accepted";
        const l = grouped("update", "update", name, id);
        const status: ItemStatus = rejected ? "danger" : "info";
        add({ id: `e${id}`, laneId: l.id, start: t, end: t, status, label: `Update ${name}`, shape: "diamond", caption: `${clockText(t, true)} · ${state.toLowerCase()}` }, { name, what: `update ${id}`, state, status, start: t, end: t, firstEventId: id, lastEventId: id }, id);
        break;
      }
      case "MarkerRecorded": {
        const name = at(a, "markerName") || "marker";
        const l = grouped("marker", "marker", name, id);
        const failure = failureOf(a["failure"]);
        const status: ItemStatus = failure ? "danger" : "neutral";
        add({ id: `e${id}`, laneId: l.id, start: t, end: t, status, label: `Marker ${name}`, shape: "pin", caption: clockText(t, true) }, { name, what: `marker ${id}`, state: failure ? "Failed" : "Recorded", status, start: t, end: t, firstEventId: id, lastEventId: id, ...(failure ? { failure } : {}) }, id);
        break;
      }
      default: {
        const closing = CLOSING[event.eventType];
        const run = items.find((i) => i.laneId === "workflow");
        if (closing && run) {
          const meta = info.get(run.id)!;
          run.end = t;
          run.status = closing;
          meta.end = t;
          meta.status = closing;
          meta.state = CLOSE_WORD[event.eventType] ?? "Closed";
          meta.lastEventId = id;
          const failure = failureOf(a["failure"]);
          if (failure) meta.failure = failure;
        }
      }
    }
  }

  // Captions that depend on the end or the clock, once every event is read.
  for (const item of items) {
    const meta = info.get(item.id)!;
    const so = spanText((item.end ?? now) - item.start);
    switch (lanes.find((l) => l.id === item.laneId)?.kind) {
      case "workflow":
        item.caption = item.end === null ? `Running · ${so}` : `${meta.state} · ${so}`;
        break;
      case "activity":
        if (item.end === null) {
          const of = meta.maximumAttempts ? ` of ${meta.maximumAttempts}` : "";
          item.caption = meta.state === "Retrying" ? `Retrying · attempt ${meta.attempt ?? 1}${of} · ${so} so far` : `${meta.state} · ${so} so far`;
        } else {
          item.caption = meta.state === "Completed" ? so : `${meta.state} · ${so}`;
        }
        break;
      case "child":
        item.caption = item.end === null ? `${meta.state} · ${so} so far` : `${meta.state} · ${so}`;
        break;
      default:
    }
  }
  return { lanes, items, info, counts };
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
