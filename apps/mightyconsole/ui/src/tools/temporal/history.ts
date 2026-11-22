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
  /** Its lane's kind. */
  kind: LaneKind;
  /** The events it covers (first and last ids), for "Events 18–20 in History". */
  firstEventId: number;
  lastEventId: number;
  /** Every event of it, in history order: scheduled, started, closed; the Timeline's pane lists them. */
  eventIds: number[];
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
  /** The item each event belongs to (event id → item id), so an event picked in History selects its item. */
  itemOfEvent: Map<number, string>;
}

/** An item's facts as a case of buildTimeline starts them; `add` fills in the rest. */
type NewInfo = Omit<ItemInfo, "kind" | "eventIds">;

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

/** The facts an open activity has before the pending activities speak (TSK-109: they are applied when the view is read). */
interface OpenActivity {
  item: Item;
  meta: ItemInfo;
  activityId: string;
  /** Its state from the history alone: "Scheduled" or "Running". */
  state: string;
  maximumAttempts?: number;
}

/**
 * The Timeline of a history, as the mockup draws it: one lane per thing in the order of its first
 * event (the workflow, its workflow tasks as ticks, each activity, timer and child workflow, each
 * signal, update and marker name), each item shaped by kind and captioned with its state and
 * duration. Open activities read their attempt and last failure from the pending activities:
 * one past its first attempt is drawn hatched, "Retrying · attempt 3 of 5". Items still open have `end: null`.
 *
 * Built one event at a time in history order (TSK-109): `add` costs the same however long the
 * history is, and `view` touches the open items only (their captions grow with the clock, and the
 * pending activities change their state). The arrays are kept and changed in place.
 */
export class TimelineBuilder {
  readonly lanes: Lane[] = [];
  readonly items: Item[] = [];
  readonly info = new Map<string, ItemInfo>();
  readonly counts: Record<LaneKind, number> = { ...NO_COUNTS };
  readonly itemOfEvent = new Map<number, string>();
  private readonly laneByKey = new Map<string, Lane>();
  private readonly byEvent = new Map<number, Item>();
  private readonly startedAttempt = new Map<number, number>();
  private readonly groupCount = new Map<string, number>();
  /** Items without an end, whose captions follow the clock. */
  private readonly open = new Set<Item>();
  private readonly activities = new Map<Item, OpenActivity>();
  private workflow: Item | undefined;
  private last = 0;

  constructor(private readonly workflowId = "") {}

  /** The time of the last event added. */
  get lastTime(): number {
    return this.last;
  }

  private lane(key: string, kind: LaneKind, label: string, detail: string): Lane {
    let l = this.laneByKey.get(key);
    if (!l) {
      l = { id: key, label, detail, kind };
      this.laneByKey.set(key, l);
      this.lanes.push(l);
    }
    return l;
  }

  private put(item: Item, meta: NewInfo, eventId: number, kind: LaneKind): ItemInfo {
    this.items.push(item);
    const info: ItemInfo = { ...meta, kind, eventIds: [eventId] };
    this.info.set(item.id, info);
    this.byEvent.set(eventId, item);
    this.itemOfEvent.set(eventId, item.id);
    if (item.end === null) this.open.add(item);
    return info;
  }

  /** Another event of an item. */
  private also(item: Item, meta: ItemInfo, eventId: number) {
    meta.lastEventId = eventId;
    meta.eventIds.push(eventId);
    this.itemOfEvent.set(eventId, item.id);
  }

  // Signals, updates and markers share a lane by name: "signal 13" for one, "3 signals" for more.
  private grouped(kind: LaneKind, word: string, name: string, eventId: number): Lane {
    const key = `${kind}:${name}`;
    const n = (this.groupCount.get(key) ?? 0) + 1;
    this.groupCount.set(key, n);
    const l = this.lane(key, kind, name, `${word} ${eventId}`);
    if (n > 1) l.detail = `${n} ${word}s`;
    this.counts[kind] += 1;
    return l;
  }

  private close(eventId: number, t: number, status: ItemStatus, state: string, lastEventId: number, failure?: ItemInfo["failure"]) {
    const item = this.byEvent.get(eventId);
    const meta = item ? this.info.get(item.id) : undefined;
    if (!item || !meta) return null;
    item.end = t;
    item.status = status;
    meta.end = t;
    meta.status = status;
    meta.state = state;
    this.also(item, meta, lastEventId);
    if (failure) meta.failure = failure;
    this.open.delete(item);
    this.activities.delete(item);
    return { item, meta };
  }

  /** The next event of the history, in order. */
  add(event: HistoryEvent): void {
    const t = eventMs(event);
    this.last = t;
    const a = event.attributes;
    const id = event.eventId;
    const counts = this.counts;
    switch (event.eventType) {
      case "WorkflowExecutionStarted": {
        const name = this.workflowId || at(a, "workflowType", "name") || "Workflow";
        const l = this.lane("workflow", "workflow", name, "workflow");
        counts.workflow = 1;
        const item: Item = { id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name };
        this.put(item, { name, what: "workflow", state: "Running", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id, "workflow");
        this.workflow = item;
        break;
      }
      case "WorkflowTaskScheduled": {
        const l = this.lane("workflowTask", "workflowTask", "Workflow tasks", "");
        counts.workflowTask += 1;
        l.detail = `${counts.workflowTask} task${counts.workflowTask === 1 ? "" : "s"}`;
        this.put({ id: `e${id}`, laneId: l.id, start: t, end: t, status: "neutral", label: `Workflow task ${id}`, shape: "tick" }, { name: "Workflow task", what: `task ${id}`, state: "Scheduled", status: "neutral", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id, "workflowTask");
        break;
      }
      case "WorkflowTaskStarted":
      case "WorkflowTaskCompleted":
      case "WorkflowTaskFailed":
      case "WorkflowTaskTimedOut": {
        const scheduled = num(a["scheduledEventId"]);
        const item = scheduled === null ? undefined : this.byEvent.get(scheduled);
        const meta = item ? this.info.get(item.id) : undefined;
        if (!item || !meta) break;
        this.also(item, meta, id);
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
        const l = this.lane(`activity:${id}`, "activity", name, `activity ${id}`);
        counts.activity += 1;
        const max = num(obj(a["retryPolicy"])["maximumAttempts"]);
        const meta: NewInfo = { name, what: `activity ${id}`, state: "Scheduled", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") };
        if (max) meta.maximumAttempts = max;
        const item: Item = { id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name };
        const info = this.put(item, meta, id, "activity");
        this.activities.set(item, { item, meta: info, activityId: at(a, "activityId"), state: "Scheduled", ...(max ? { maximumAttempts: max } : {}) });
        break;
      }
      case "ActivityTaskStarted": {
        const scheduled = num(a["scheduledEventId"]);
        const attempt = num(a["attempt"]);
        if (scheduled !== null && attempt !== null) this.startedAttempt.set(scheduled, attempt);
        const item = scheduled === null ? undefined : this.byEvent.get(scheduled);
        const meta = item ? this.info.get(item.id) : undefined;
        if (item && meta) {
          if (meta.state === "Scheduled") meta.state = "Running";
          const open = this.activities.get(item);
          if (open) open.state = "Running";
          this.also(item, meta, id);
        }
        break;
      }
      case "ActivityTaskCompleted":
      case "ActivityTaskFailed":
      case "ActivityTaskTimedOut":
      case "ActivityTaskCanceled": {
        const scheduled = num(a["scheduledEventId"]);
        const [status, state] = ACTIVITY_END[event.eventType]!;
        const done = scheduled === null ? null : this.close(scheduled, t, status, state, id, failureOf(a["failure"]));
        if (done && scheduled !== null) {
          done.item.shape = "bar";
          const attempt = this.startedAttempt.get(scheduled);
          if (attempt) done.meta.attempt = attempt;
          this.caption(done.item, done.meta, t);
        }
        break;
      }
      case "TimerStarted": {
        const timerId = at(a, "timerId") || String(id);
        const l = this.lane(`timer:${id}`, "timer", timerId, `timer ${id}`);
        counts.timer += 1;
        const fire = durationMs(a["startToFireTimeout"]);
        const item: Item = { id: `e${id}`, laneId: l.id, start: t, end: null, status: "info", label: `Timer ${timerId}`, shape: "dashed", caption: fire === null ? "Waiting" : `${spanText(fire)} · fires ${clockText(t + fire)}` };
        this.put(item, { name: timerId, what: `timer ${id}`, state: "Waiting", status: "info", start: t, end: null, firstEventId: id, lastEventId: id }, id, "timer");
        // A timer's caption does not follow the clock.
        this.open.delete(item);
        break;
      }
      case "TimerFired":
      case "TimerCanceled": {
        const started = num(a["startedEventId"]);
        const fired = event.eventType === "TimerFired";
        const done = started === null ? null : this.close(started, t, fired ? "success" : "neutral", fired ? "Fired" : "Canceled", id);
        if (done) done.item.caption = fired ? `${spanText(t - done.item.start)} · fired` : `Canceled after ${spanText(t - done.item.start)}`;
        break;
      }
      case "StartChildWorkflowExecutionInitiated": {
        const name = at(a, "workflowId") || at(a, "workflowType", "name") || "Child workflow";
        const l = this.lane(`child:${id}`, "child", name, `child ${id}`);
        counts.child += 1;
        this.put({ id: `e${id}`, laneId: l.id, start: t, end: null, status: "running", label: name }, { name, what: `child ${id}`, state: "Starting", status: "running", start: t, end: null, firstEventId: id, lastEventId: id, taskQueue: at(a, "taskQueue", "name") }, id, "child");
        break;
      }
      case "ChildWorkflowExecutionStarted": {
        const initiated = num(a["initiatedEventId"]);
        const item = initiated === null ? undefined : this.byEvent.get(initiated);
        const meta = item ? this.info.get(item.id) : undefined;
        if (item && meta) {
          meta.state = "Running";
          this.also(item, meta, id);
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
        const done = initiated === null ? null : this.close(initiated, t, status, state, id, failureOf(a["failure"]));
        if (done) this.caption(done.item, done.meta, t);
        break;
      }
      case "WorkflowExecutionSignaled": {
        const name = at(a, "signalName") || "signal";
        const l = this.grouped("signal", "signal", name, id);
        const input = a["input"];
        const n = Array.isArray(input) ? input.length : input === undefined || input === null ? 0 : 1;
        this.put({ id: `e${id}`, laneId: l.id, start: t, end: t, status: "info", label: `Signal ${name}`, shape: "diamond", caption: `${clockText(t, true)} · ${n} payload${n === 1 ? "" : "s"}` }, { name, what: `signal ${id}`, state: "Received", status: "info", start: t, end: t, firstEventId: id, lastEventId: id }, id, "signal");
        break;
      }
      case "WorkflowExecutionUpdateAccepted":
      case "WorkflowExecutionUpdateCompleted":
      case "WorkflowExecutionUpdateRejected": {
        const name = at(a, "acceptedRequest", "input", "name") || at(a, "rejectedRequest", "input", "name") || at(a, "meta", "updateId") || "update";
        const rejected = event.eventType === "WorkflowExecutionUpdateRejected";
        const state = rejected ? "Rejected" : event.eventType === "WorkflowExecutionUpdateCompleted" ? "Completed" : "Accepted";
        const l = this.grouped("update", "update", name, id);
        const status: ItemStatus = rejected ? "danger" : "info";
        this.put({ id: `e${id}`, laneId: l.id, start: t, end: t, status, label: `Update ${name}`, shape: "diamond", caption: `${clockText(t, true)} · ${state.toLowerCase()}` }, { name, what: `update ${id}`, state, status, start: t, end: t, firstEventId: id, lastEventId: id }, id, "update");
        break;
      }
      case "MarkerRecorded": {
        const name = at(a, "markerName") || "marker";
        const l = this.grouped("marker", "marker", name, id);
        const failure = failureOf(a["failure"]);
        const status: ItemStatus = failure ? "danger" : "neutral";
        this.put({ id: `e${id}`, laneId: l.id, start: t, end: t, status, label: `Marker ${name}`, shape: "pin", caption: clockText(t, true) }, { name, what: `marker ${id}`, state: failure ? "Failed" : "Recorded", status, start: t, end: t, firstEventId: id, lastEventId: id, ...(failure ? { failure } : {}) }, id, "marker");
        break;
      }
      default: {
        const closing = CLOSING[event.eventType];
        const run = this.workflow;
        if (closing && run) {
          const meta = this.info.get(run.id)!;
          run.end = t;
          run.status = closing;
          meta.end = t;
          meta.status = closing;
          meta.state = CLOSE_WORD[event.eventType] ?? "Closed";
          this.also(run, meta, id);
          const failure = failureOf(a["failure"]);
          if (failure) meta.failure = failure;
          this.open.delete(run);
          this.caption(run, meta, t);
        }
      }
    }
  }

  /** An item's caption, which depends on its end or the clock: workflow, activity, child workflow. */
  private caption(item: Item, meta: ItemInfo, now: number) {
    const so = spanText((item.end ?? now) - item.start);
    switch (meta.kind) {
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

  /**
   * The Timeline at `now` (the last event's time when absent), the open activities read from
   * `pending`. Costs the open items only.
   */
  view(now?: number, pending: readonly Record<string, unknown>[] = []): TimelineData {
    const clock = now ?? this.last;
    const pendingById = new Map<string, Record<string, unknown>>();
    for (const p of pending) pendingById.set(text(p["activityId"]), p);
    for (const open of this.activities.values()) {
      const { item, meta } = open;
      // From the history alone, then what the pending activity says.
      delete item.shape;
      item.status = "running";
      meta.status = "running";
      meta.state = open.state;
      delete meta.attempt;
      delete meta.failure;
      if (open.maximumAttempts) meta.maximumAttempts = open.maximumAttempts;
      else delete meta.maximumAttempts;
      const p = pendingById.get(open.activityId);
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
    }
    for (const item of this.open) this.caption(item, this.info.get(item.id)!, clock);
    return { lanes: this.lanes, items: this.items, info: this.info, counts: this.counts, itemOfEvent: this.itemOfEvent };
  }
}

/** The Timeline of a whole history at once (see {@link TimelineBuilder}). */
export function buildTimeline(events: readonly HistoryEvent[], options: TimelineOptions = {}): TimelineData {
  const builder = new TimelineBuilder(options.workflowId);
  for (const event of events) builder.add(event);
  return builder.view(options.now, options.pending);
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
  return inputAndResultOf(
    events.find((e) => e.eventType === "WorkflowExecutionStarted"),
    [...events].reverse().find((e) => e.eventType in CLOSING),
  );
}

/** As {@link inputAndResult}, from the start event and the closing event alone (TSK-109: a long history is not walked). */
export function inputAndResultOf(started: HistoryEvent | undefined, closing: HistoryEvent | undefined): InputAndResult {
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
