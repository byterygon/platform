// The schedule sheet's draft (TSK-92): a ScheduleForm as text fields, back to a form, and the list
// of what an edit changes. Pure, so the tests read it without the sheet.
//
// The sheet edits one "When" entry (a calendar, an interval or a cron string). A stored schedule
// with more entries keeps the others as they are (`rest`); the sheet lists them.
import type { CalendarForm, IntervalForm, ScheduleForm, ScheduleOverlap, ScheduleSpecForm } from "@/gen/api";
import { parseArgs } from "./ActionDialogs";
import { durationError, parseObject, retryErrors, retryPolicyOf, retryText, type RetryText } from "./sheet-parts";
import { isTimeZone, parseCalendarField, parseCron, type CalendarField } from "./schedule-preview";

export type WhenKind = "calendar" | "interval" | "cron";

/** The calendar fields the sheet shows, in its order. */
export const CALENDAR_FIELDS = ["second", "minute", "hour", "dayOfMonth", "month", "dayOfWeek"] as const;
export type ShownCalendarField = (typeof CALENDAR_FIELDS)[number];

export interface ScheduleDraft {
  scheduleId: string;
  when: WhenKind;
  calendar: Record<ShownCalendarField, string>;
  /** The edited calendar's year and comment, kept as they were. */
  calendarKept: Pick<CalendarForm, "year" | "comment">;
  every: string;
  offset: string;
  cron: string;
  /** The stored entries the sheet does not edit. */
  rest: Pick<ScheduleSpecForm, "calendars" | "intervals" | "cronStrings">;
  timezone: string;
  startTime: string;
  endTime: string;
  jitter: string;
  workflowType: string;
  taskQueue: string;
  workflowId: string;
  input: string;
  executionTimeout: string;
  runTimeout: string;
  taskTimeout: string;
  retry: RetryText;
  memo: string;
  searchAttributes: string;
  overlap: ScheduleOverlap | "default";
  catchupWindow: string;
  pauseOnFailure: boolean;
  paused: boolean;
  notes: string;
  remainingActions: string;
}

const EMPTY_CALENDAR: Record<ShownCalendarField, string> = { second: "", minute: "", hour: "", dayOfMonth: "", month: "", dayOfWeek: "" };
const pretty = (v: unknown) => JSON.stringify(v, null, 2);

/** A new schedule: every day at 09:00 in the browser's time zone. */
export function newDraft(): ScheduleDraft {
  let timezone = "UTC";
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    // UTC
  }
  return {
    scheduleId: "",
    when: "calendar",
    calendar: { ...EMPTY_CALENDAR, hour: "9" },
    calendarKept: {},
    every: "1h",
    offset: "",
    cron: "0 9 * * 1-5",
    rest: { calendars: [], intervals: [], cronStrings: [] },
    timezone,
    startTime: "",
    endTime: "",
    jitter: "",
    workflowType: "",
    taskQueue: "",
    workflowId: "",
    input: "",
    executionTimeout: "",
    runTimeout: "",
    taskTimeout: "",
    retry: retryText(null),
    memo: "",
    searchAttributes: "",
    overlap: "default",
    catchupWindow: "",
    pauseOnFailure: false,
    paused: false,
    notes: "",
    remainingActions: "",
  };
}

/** A stored schedule as the sheet edits it. */
export function draftOfForm(scheduleId: string, form: ScheduleForm): ScheduleDraft {
  const base = newDraft();
  const { spec, action, policies, state } = form;
  const d: ScheduleDraft = {
    ...base,
    scheduleId,
    timezone: spec.timezone ?? "",
    startTime: spec.startTime ?? "",
    endTime: spec.endTime ?? "",
    jitter: spec.jitter ?? "",
    workflowType: action.workflowType,
    taskQueue: action.taskQueue,
    workflowId: action.workflowId,
    input: action.args.length > 0 ? pretty(action.args) : "",
    executionTimeout: action.executionTimeout ?? "",
    runTimeout: action.runTimeout ?? "",
    taskTimeout: action.taskTimeout ?? "",
    retry: retryText(action.retryPolicy),
    memo: action.memo && Object.keys(action.memo).length > 0 ? pretty(action.memo) : "",
    searchAttributes: action.searchAttributes && Object.keys(action.searchAttributes).length > 0 ? pretty(action.searchAttributes) : "",
    overlap: policies.overlap ?? "default",
    catchupWindow: policies.catchupWindow ?? "",
    pauseOnFailure: policies.pauseOnFailure,
    paused: state.paused,
    notes: state.notes,
    remainingActions: state.remainingActions === null || state.remainingActions === undefined ? "" : String(state.remainingActions),
  };
  const [calendar, ...calendars] = spec.calendars;
  const [interval, ...intervals] = spec.intervals;
  const [cron, ...cronStrings] = spec.cronStrings;
  if (calendar) {
    d.when = "calendar";
    d.calendar = Object.fromEntries(CALENDAR_FIELDS.map((f) => [f, calendar[f] ?? ""])) as Record<ShownCalendarField, string>;
    d.calendarKept = { ...(calendar.year ? { year: calendar.year } : {}), ...(calendar.comment ? { comment: calendar.comment } : {}) };
    d.rest = { calendars, intervals: spec.intervals, cronStrings: spec.cronStrings };
  } else if (interval) {
    d.when = "interval";
    d.every = interval.every;
    d.offset = interval.offset ?? "";
    d.rest = { calendars: [], intervals, cronStrings: spec.cronStrings };
  } else if (cron !== undefined) {
    d.when = "cron";
    d.cron = cron;
    d.rest = { calendars: [], intervals: [], cronStrings };
  }
  return d;
}

/** The spec the draft makes (unchecked: the preview reads it as it is typed). */
export function specOf(d: ScheduleDraft): ScheduleSpecForm {
  const calendars = [...d.rest.calendars];
  const intervals = [...d.rest.intervals];
  const cronStrings = [...d.rest.cronStrings];
  if (d.when === "calendar") {
    const c: CalendarForm = { ...d.calendarKept };
    for (const f of CALENDAR_FIELDS) if (d.calendar[f].trim() !== "") c[f] = d.calendar[f].trim();
    calendars.unshift(c);
  } else if (d.when === "interval") intervals.unshift(d.offset.trim() ? { every: d.every.trim(), offset: d.offset.trim() } : ({ every: d.every.trim() } as IntervalForm));
  else cronStrings.unshift(d.cron.trim());
  const spec: ScheduleSpecForm = { calendars, intervals, cronStrings };
  if (d.timezone.trim()) spec.timezone = d.timezone.trim();
  if (d.startTime.trim()) spec.startTime = d.startTime.trim();
  if (d.endTime.trim()) spec.endTime = d.endTime.trim();
  if (d.jitter.trim()) spec.jitter = d.jitter.trim();
  return spec;
}

/** Field errors of the draft, by field name (`calendar.hour`, `every`, `workflowType`, …). */
export function draftErrors(d: ScheduleDraft, editing: boolean): Record<string, string> {
  const e: Record<string, string> = {};
  if (!editing && d.scheduleId.trim() === "") e["scheduleId"] = "Give the schedule an ID.";
  if (d.when === "calendar") {
    for (const f of CALENDAR_FIELDS) {
      const r = parseCalendarField(f as CalendarField, d.calendar[f]);
      if (r !== null && !Array.isArray(r)) e[`calendar.${f}`] = r.error;
    }
  } else if (d.when === "interval") {
    const every = d.every.trim();
    if (every === "" || durationError(every) !== null) e["every"] = "A duration such as 30s, 5m, 1h30m or 2d.";
    const offset = durationError(d.offset);
    if (offset) e["offset"] = offset;
  } else {
    const cron = parseCron(d.cron);
    if ("error" in cron) e["cron"] = cron.error;
    else if (cron.timezone && d.timezone.trim()) e["cron"] = "Name the time zone in one place: CRON_TZ= or the Time zone field.";
  }
  if (d.timezone.trim() && !isTimeZone(d.timezone.trim())) e["timezone"] = "Not a time zone this browser knows, such as Europe/Berlin.";
  for (const k of ["startTime", "endTime"] as const) if (d[k].trim() && Number.isNaN(Date.parse(d[k].trim()))) e[k] = "A date and time such as 2026-12-01T09:00:00Z.";
  for (const k of ["jitter", "catchupWindow", "executionTimeout", "runTimeout", "taskTimeout"] as const) {
    const m = durationError(d[k]);
    if (m) e[k] = m;
  }
  if (d.workflowType.trim() === "") e["workflowType"] = "Name the workflow type.";
  if (d.taskQueue.trim() === "") e["taskQueue"] = "Name the task queue.";
  if (d.workflowId.trim() === "") e["workflowId"] = "Give a workflow ID; Temporal appends the scheduled time.";
  const args = parseArgs(d.input);
  if ("error" in args) e["input"] = args.error;
  for (const k of ["memo", "searchAttributes"] as const) {
    const p = parseObject(d[k]);
    if ("error" in p) e[k] = p.error;
  }
  for (const [k, m] of Object.entries(retryErrors(d.retry))) e[`retry.${k}`] = m;
  if (d.remainingActions.trim() && !/^\d+$/.test(d.remainingActions.trim())) e["remainingActions"] = "A whole number, or empty for unlimited.";
  return e;
}

/** The form to send; call only when `draftErrors` is empty. */
export function formOf(d: ScheduleDraft): ScheduleForm {
  const args = parseArgs(d.input);
  const memo = parseObject(d.memo);
  const sa = parseObject(d.searchAttributes);
  const form: ScheduleForm = {
    spec: specOf(d),
    action: {
      workflowType: d.workflowType.trim(),
      taskQueue: d.taskQueue.trim(),
      workflowId: d.workflowId.trim(),
      args: "args" in args ? args.args : [],
    },
    policies: { pauseOnFailure: d.pauseOnFailure },
    state: { paused: d.paused, notes: d.notes.trim() },
  };
  if (d.executionTimeout.trim()) form.action.executionTimeout = d.executionTimeout.trim();
  if (d.runTimeout.trim()) form.action.runTimeout = d.runTimeout.trim();
  if (d.taskTimeout.trim()) form.action.taskTimeout = d.taskTimeout.trim();
  const retry = retryPolicyOf(d.retry);
  if (retry) form.action.retryPolicy = retry;
  if ("value" in memo && Object.keys(memo.value).length > 0) form.action.memo = memo.value;
  if ("value" in sa && Object.keys(sa.value).length > 0) form.action.searchAttributes = sa.value;
  if (d.overlap !== "default") form.policies.overlap = d.overlap;
  if (d.catchupWindow.trim()) form.policies.catchupWindow = d.catchupWindow.trim();
  if (d.remainingActions.trim()) form.state.remainingActions = Number(d.remainingActions.trim());
  return form;
}

// --- What an edit changes ---------------------------------------------------------------------

const WORDS: Record<string, string> = {
  spec: "When",
  action: "Workflow",
  policies: "Policies",
  state: "State",
  calendars: "calendar",
  intervals: "interval",
  cronStrings: "cron",
  dayOfMonth: "day of month",
  dayOfWeek: "day of week",
  timezone: "time zone",
  startTime: "start time",
  endTime: "end time",
  workflowType: "type",
  taskQueue: "task queue",
  workflowId: "workflow ID",
  args: "input",
  executionTimeout: "execution timeout",
  runTimeout: "run timeout",
  taskTimeout: "task timeout",
  retryPolicy: "retry policy",
  searchAttributes: "search attributes",
  catchupWindow: "catch-up window",
  pauseOnFailure: "pause on failure",
  remainingActions: "remaining actions",
};

const word = (key: string) => WORDS[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

/** Leaves of a value by path; absent, null, empty strings, arrays and objects count as nothing. */
function leaves(value: unknown, path: string[], out: Map<string, { label: string; value: string }>) {
  if (value === null || value === undefined || value === "") return;
  // Input, memo and search attributes compare whole: a changed argument shows as the new input.
  const whole = path.length === 2 && path[0] === "action" && ["args", "memo", "searchAttributes", "retryPolicy"].includes(path[1]!);
  if (!whole && Array.isArray(value)) {
    value.forEach((v, i) => leaves(v, [...path, String(i)], out));
    return;
  }
  if (!whole && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) leaves(v, [...path, k], out);
    return;
  }
  if (whole && ((Array.isArray(value) && value.length === 0) || (typeof value === "object" && Object.keys(value as object).length === 0))) return;
  if (value === false && path[path.length - 1] !== "paused" && path[path.length - 1] !== "pauseOnFailure") return;
  const label = path
    .map((p, i) => (/^\d+$/.test(p) ? null : /^\d+$/.test(path[i + 1] ?? "") ? `${word(p)} ${Number(path[i + 1]) + 1}` : word(p)))
    .filter((p): p is string => p !== null)
    .join(" · ");
  out.set(path.join("."), { label: label.charAt(0).toUpperCase() + label.slice(1), value: typeof value === "string" ? value : JSON.stringify(value) });
}

export interface Change {
  label: string;
  before: string | null;
  after: string | null;
}

/** What differs between the stored form and the edited one, in the form's order. */
export function changesOf(before: ScheduleForm, after: ScheduleForm): Change[] {
  const a = new Map<string, { label: string; value: string }>();
  const b = new Map<string, { label: string; value: string }>();
  leaves(before, [], a);
  leaves(after, [], b);
  const keys = [...new Set([...a.keys(), ...b.keys()])];
  const out: Change[] = [];
  for (const k of keys) {
    const x = a.get(k);
    const y = b.get(k);
    if (x?.value === y?.value) continue;
    out.push({ label: (y ?? x)!.label, before: x?.value ?? null, after: y?.value ?? null });
  }
  return out;
}

/** The other spec entries in words, for "Also kept". */
export function restSummary(rest: ScheduleDraft["rest"]): string[] {
  return [
    ...rest.calendars.map((c) => `Calendar ${CALENDAR_FIELDS.map((f) => c[f]).map((v, i) => `${word(CALENDAR_FIELDS[i]!)} ${v ?? "default"}`).join(", ")}`),
    ...rest.intervals.map((i) => `Every ${i.every}${i.offset ? ` (offset ${i.offset})` : ""}`),
    ...rest.cronStrings.map((c) => `Cron ${c}`),
  ];
}
