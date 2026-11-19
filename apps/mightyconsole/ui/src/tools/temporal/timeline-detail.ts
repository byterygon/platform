// The Timeline's details pane (Mightyconsole spec §9.3, TSK-100; the mockup frame
// `temporal-timeline`): what a selected bar, diamond or pin stands for, read from its own events.
// Its times with the waits between them, the worker, the retry policy, the failure with its cause
// chain, and the events themselves. Pure, over the decoded `HistoryEvent`s; the pane draws it.
import type { HistoryEvent } from "@/gen/api";
import { clockText, durationMs, eventMs, failureChain, spanText, type ItemInfo } from "./history";

type Attributes = Record<string, unknown>;

const obj = (value: unknown): Attributes => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Attributes) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);
const at = (attributes: Attributes, ...path: string[]): string => {
  let value: unknown = attributes;
  for (const key of path) value = obj(value)[key];
  return text(value);
};

/** A value to copy and what it is, for the toast ("activity ID"). */
export interface Copyable {
  value: string;
  what: string;
}

/** One row of the pane's facts: "Started", "10:43:30.088 · waited 16 ms". */
export interface DetailFact {
  label: string;
  value: string;
  /** Drawn in the code font (identities, ids). */
  mono?: boolean;
  copy?: Copyable;
}

export interface ItemDetail {
  /** "SendReceipt · activity 18". */
  title: string;
  /** The item's own id beside the title: the activity ID, the child's workflow ID, the timer ID. */
  copy?: Copyable;
  /** The muted line under the title: task queue, attempt, non-retryable. */
  context: string[];
  facts: DetailFact[];
  /** The failure, its first line and the whole chain with stack traces (what Copy copies). */
  failure?: { summary: string; text: string };
  /** The item's events, in history order (those loaded). */
  events: HistoryEvent[];
  /** A child workflow, to open in its own tab. */
  workflow?: { workflowId: string; runId?: string };
}

/** What the first event of an item is called, by its type. */
const FIRST_WORD: Record<string, string> = {
  WorkflowExecutionStarted: "Started",
  WorkflowTaskScheduled: "Scheduled",
  ActivityTaskScheduled: "Scheduled",
  TimerStarted: "Started",
  StartChildWorkflowExecutionInitiated: "Initiated",
  WorkflowExecutionSignaled: "Received",
  WorkflowExecutionUpdateAccepted: "Accepted",
  WorkflowExecutionUpdateCompleted: "Completed",
  WorkflowExecutionUpdateRejected: "Rejected",
  MarkerRecorded: "Recorded",
};
/** The events that mark the start of the work, after a wait in a queue. */
const STARTED: ReadonlySet<string> = new Set(["WorkflowTaskStarted", "ActivityTaskStarted", "ChildWorkflowExecutionStarted"]);

/** A pending activity's time field (RFC 3339, or protobuf JSON `{ seconds }`), in ms, or null. */
function timeMs(value: unknown): number | null {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  const seconds = num(obj(value)["seconds"]) ?? (typeof obj(value)["seconds"] === "string" ? Number(obj(value)["seconds"]) : null);
  return seconds === null || Number.isNaN(seconds) ? null : seconds * 1000;
}

/**
 * A retry policy in words, as the mockup writes it: "3 attempts · backoff 2 × from 1 s", with the
 * longest interval and the types not retried when the policy has them; "" without a policy.
 */
export function retryWords(policy: unknown): string {
  const p = obj(policy);
  if (Object.keys(p).length === 0) return "";
  const max = num(p["maximumAttempts"]);
  const parts = [max ? `${max} attempt${max === 1 ? "" : "s"}` : "unlimited attempts"];
  const coefficient = num(p["backoffCoefficient"]);
  const initial = durationMs(p["initialInterval"]);
  if (coefficient !== null || initial !== null) parts.push(["backoff", coefficient === null ? "" : `${coefficient} ×`, initial === null ? "" : `from ${spanText(initial)}`].filter(Boolean).join(" "));
  const longest = durationMs(p["maximumInterval"]);
  if (longest !== null) parts.push(`at most ${spanText(longest)} apart`);
  const types = Array.isArray(p["nonRetryableErrorTypes"]) ? (p["nonRetryableErrorTypes"] as unknown[]).map(text).filter(Boolean) : [];
  if (types.length > 0) parts.push(`not retried: ${types.join(", ")}`);
  return parts.join(" · ");
}

/** A failure and its causes as text: "Type: message (non-retryable)", its stack, then "Caused by: …". */
export function failureText(failure: Attributes): string {
  const nonRetryable = obj(failure["applicationFailureInfo"])["nonRetryable"] === true;
  return failureChain(failure)
    .map((f, i) => {
      const head = `${i > 0 ? "Caused by: " : ""}${f.type ? `${f.type}: ` : ""}${f.message}${i === 0 && nonRetryable ? " (non-retryable)" : ""}`;
      const stack = f.stackTrace
        ? `\n${f.stackTrace
            .trimEnd()
            .split("\n")
            .map((line) => `  ${line.trim()}`)
            .join("\n")}`
        : "";
      return head + stack;
    })
    .join("\n");
}

/**
 * The pane's content for an item: its title and own id, the context line, the facts (when it was
 * scheduled, started and closed, with the waits; the worker; the retry policy; a timer's firing; a
 * child's run), its failure (from its closing event, else the pending activity's last failure) and
 * its events. `pending` is `WorkflowDetail.pendingActivities`; `now` closes what is still open.
 */
export function itemDetail(info: ItemInfo, byId: ReadonlyMap<number, HistoryEvent>, pending: readonly Record<string, unknown>[], now: number): ItemDetail {
  const events = info.eventIds.map((id) => byId.get(id)).filter((e): e is HistoryEvent => e !== undefined);
  const first = events[0];
  const a = first?.attributes ?? {};
  const t0 = first ? eventMs(first) : info.start;
  const out: ItemDetail = { title: `${info.name} · ${info.what}`, context: [], facts: [], events };

  // The item's own id.
  if (info.kind === "activity" && at(a, "activityId")) out.copy = { value: at(a, "activityId"), what: "activity ID" };
  else if (info.kind === "child" && at(a, "workflowId")) out.copy = { value: at(a, "workflowId"), what: "workflow ID" };
  else if (info.kind === "timer") out.copy = { value: info.name, what: "timer ID" };
  else if (info.kind === "workflow") out.copy = { value: info.name, what: "workflow ID" };
  else if (info.kind === "signal") out.copy = { value: info.name, what: "signal name" };
  else if (info.kind === "update") out.copy = { value: info.name, what: "update name" };
  else if (info.kind === "marker") out.copy = { value: info.name, what: "marker name" };

  const p = info.kind === "activity" ? pending.find((x) => text(x["activityId"]) === at(a, "activityId")) : undefined;
  const open = info.end === null;

  // Context: task queue, type, attempt, non-retryable.
  if (info.kind === "child" && at(a, "workflowType", "name")) out.context.push(at(a, "workflowType", "name"));
  if (info.taskQueue) out.context.push(`task queue ${info.taskQueue}`);
  if (info.attempt) out.context.push(`attempt ${info.attempt}${info.maximumAttempts ? ` of ${info.maximumAttempts}` : ""}`);
  if (info.failure?.nonRetryable) out.context.push("non-retryable");
  if (info.kind === "timer") {
    const fire = durationMs(a["startToFireTimeout"]);
    if (fire !== null) out.context.push(`${spanText(fire)} timer`);
  }
  if (info.kind === "signal" || info.kind === "update") {
    const input = info.kind === "signal" ? a["input"] : obj(obj(a["acceptedRequest"])["input"])["args"];
    const n = Array.isArray(input) ? input.length : input === undefined || input === null ? 0 : 1;
    out.context.push(`${n} payload${n === 1 ? "" : "s"}`);
  }

  // Times, with the wait before the work started and how long it ran.
  out.facts.push({ label: (first && FIRST_WORD[first.eventType]) ?? "At", value: clockText(t0, true), mono: true });
  const started = events.find((e) => STARTED.has(e.eventType));
  let startedAt: number | null = started ? eventMs(started) : null;
  if (started) {
    out.facts.push({ label: "Started", value: `${clockText(startedAt!, true)} · waited ${spanText(startedAt! - t0)}`, mono: true });
  } else if (p && open) {
    startedAt = timeMs(p["lastStartedTime"]);
    if (startedAt !== null) out.facts.push({ label: "Last started", value: `${clockText(startedAt, true)} · attempt ${num(p["attempt"]) ?? 1}`, mono: true });
  }
  const instant = info.kind === "signal" || info.kind === "update" || info.kind === "marker";
  if (!instant) {
    if (!open && info.end !== null && events.length > 1) {
      out.facts.push({ label: info.state, value: `${clockText(info.end, true)} · ${started || info.kind === "workflow" ? "ran" : "after"} ${spanText(info.end - (started ? startedAt! : t0))}`, mono: true });
    } else if (open) {
      out.facts.push({ label: "So far", value: `${info.state} · ${spanText(now - t0)}` });
      if (info.kind === "timer") {
        const fire = durationMs(a["startToFireTimeout"]);
        if (fire !== null) out.facts.push({ label: "Fires", value: `${clockText(t0 + fire, true)}${t0 + fire > now ? ` · in ${spanText(t0 + fire - now)}` : ""}`, mono: true });
      }
      const next = p ? timeMs(p["nextAttemptScheduleTime"]) : null;
      if (next !== null) out.facts.push({ label: "Next attempt", value: `${clockText(next, true)}${next > now ? ` · in ${spanText(next - now)}` : ""}`, mono: true });
    }
  }

  // Who did the work (or sent the signal).
  const worker = text(started?.attributes["identity"]) || (p ? text(p["lastWorkerIdentity"]) : "");
  if (worker) out.facts.push({ label: "Worker", value: worker, mono: true, copy: { value: worker, what: "worker identity" } });
  if ((info.kind === "signal" || info.kind === "update") && at(a, "identity")) out.facts.push({ label: "Sent by", value: at(a, "identity"), mono: true, copy: { value: at(a, "identity"), what: "sender identity" } });

  // A child's run.
  if (info.kind === "child" && at(a, "workflowId")) {
    const runId = started ? at(started.attributes, "workflowExecution", "runId") : "";
    if (runId) out.facts.push({ label: "Run ID", value: runId, mono: true, copy: { value: runId, what: "run ID" } });
    out.workflow = runId ? { workflowId: at(a, "workflowId"), runId } : { workflowId: at(a, "workflowId") };
  }

  // The retry policy the work runs under.
  const policy = retryWords(a["retryPolicy"]);
  if (policy) out.facts.push({ label: "Retry policy", value: policy });

  // The failure: from the last event that has one (the closing one), else the pending activity's last.
  const failed = [...events].reverse().find((e) => Object.keys(obj(e.attributes["failure"])).length > 0);
  const failure = failed ? obj(failed.attributes["failure"]) : p ? obj(p["lastFailure"]) : {};
  if (Object.keys(failure).length > 0 && text(failure["message"])) {
    const type = text(obj(failure["applicationFailureInfo"])["type"]);
    out.failure = { summary: `${type ? `${type}: ` : ""}${text(failure["message"])}`, text: failureText(failure) };
  }
  return out;
}
