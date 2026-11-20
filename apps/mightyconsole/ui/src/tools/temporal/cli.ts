// "Copy as CLI command" of the Write sheets (Mightyconsole spec §9.4, TSK-92): the same request as
// a `temporal` CLI command, with the profile's address and the namespace, never a secret (an API
// key is read by the CLI from TEMPORAL_API_KEY). Pure, so the tests check the exact text.
import type { ActivityIdConflictPolicy, ActivityStartInput, IdConflictPolicy, IdReusePolicy, ScheduleForm, ScheduleOverlap, WorkflowStartInput } from "@/gen/api";

/** A shell word: bare when it is safe, else in single quotes with `'` written as `'\''`. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Where the command connects: the profile's address and TLS, the namespace. */
export interface CliTarget {
  address: string;
  namespace: string;
  tls: boolean;
}

const REUSE: Record<IdReusePolicy, string> = { allowDuplicate: "AllowDuplicate", allowDuplicateFailedOnly: "AllowDuplicateFailedOnly", rejectDuplicate: "RejectDuplicate" };
const CONFLICT: Record<IdConflictPolicy, string> = { fail: "Fail", useExisting: "UseExisting", terminateExisting: "TerminateExisting" };
const OVERLAP: Record<ScheduleOverlap, string> = { skip: "Skip", bufferOne: "BufferOne", bufferAll: "BufferAll", cancelOther: "CancelOther", terminateOther: "TerminateOther", allowAll: "AllowAll" };

type Flag = [string, string | null | undefined] | [string];

function command(words: readonly string[], target: CliTarget, flags: readonly Flag[]): string {
  const parts = [...words, "--address", shellQuote(target.address), "--namespace", shellQuote(target.namespace)];
  if (target.tls) parts.push("--tls");
  for (const [flag, ...rest] of flags) {
    if (rest.length === 0) parts.push(flag);
    else {
      const value = rest[0];
      if (value === null || value === undefined || value === "") continue;
      parts.push(flag, shellQuote(value));
    }
  }
  return parts.join(" ");
}

const json = (value: unknown): string => JSON.stringify(value);
const pairs = (flag: string, object: Record<string, unknown> | undefined): Flag[] => Object.entries(object ?? {}).map(([k, v]) => [flag, `${k}=${json(v)}`]);
const inputs = (args: readonly unknown[] | undefined): Flag[] => (args ?? []).map((a) => ["--input", json(a)]);

/** `temporal workflow start …` for a start request. The CLI has no retry policy flag: a set one is named in a trailing comment. */
export function workflowStartCommand(input: Omit<WorkflowStartInput, "connId">, target: CliTarget): string {
  const flags: Flag[] = [
    ["--type", input.workflowType],
    ["--task-queue", input.taskQueue],
    ["--workflow-id", input.workflowId],
    ...inputs(input.args),
    ["--execution-timeout", input.executionTimeout],
    ["--run-timeout", input.runTimeout],
    ["--task-timeout", input.taskTimeout],
    ["--id-reuse-policy", input.idReusePolicy ? REUSE[input.idReusePolicy] : null],
    ["--id-conflict-policy", input.idConflictPolicy ? CONFLICT[input.idConflictPolicy] : null],
    ...pairs("--memo", input.memo),
    ...pairs("--search-attribute", input.searchAttributes),
    ["--start-delay", input.startDelay],
  ];
  const line = command(["temporal", "workflow", "start"], target, flags);
  return input.retryPolicy ? `${line} # retry policy ${json(input.retryPolicy)} has no CLI flag` : line;
}

/** A duration as Go reads it (the CLI's flags): days as hours, a bare number as seconds. */
export function goDuration(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (t === "") return null;
  if (/^\d+$/.test(t)) return `${t}s`;
  return t.replace(/(\d+)d/g, (_, n: string) => `${Number(n) * 24}h`);
}

const ACTIVITY_CONFLICT: Record<ActivityIdConflictPolicy, string> = { fail: "Fail", useExisting: "UseExisting" };

/** `temporal activity start …` for a Run activity request. Non-retryable error types have no flag: named in a trailing comment. */
export function activityStartCommand(input: Omit<ActivityStartInput, "connId">, target: CliTarget): string {
  const retry = input.retryPolicy ?? null;
  const flags: Flag[] = [
    ["--type", input.activityType],
    ["--task-queue", input.taskQueue],
    ["--activity-id", input.activityId],
    ...inputs(input.args ?? undefined),
    ["--start-to-close-timeout", goDuration(input.startToCloseTimeout)],
    ["--schedule-to-close-timeout", goDuration(input.scheduleToCloseTimeout)],
    ["--schedule-to-start-timeout", goDuration(input.scheduleToStartTimeout)],
    ["--heartbeat-timeout", goDuration(input.heartbeatTimeout)],
    ["--retry-initial-interval", goDuration(retry?.initialInterval)],
    ["--retry-maximum-interval", goDuration(retry?.maximumInterval)],
    ["--retry-backoff-coefficient", retry?.backoffCoefficient === null || retry?.backoffCoefficient === undefined ? null : String(retry.backoffCoefficient)],
    ["--retry-maximum-attempts", retry?.maximumAttempts === null || retry?.maximumAttempts === undefined ? null : String(retry.maximumAttempts)],
    ["--id-reuse-policy", input.idReusePolicy ? REUSE[input.idReusePolicy] : null],
    ["--id-conflict-policy", input.idConflictPolicy ? ACTIVITY_CONFLICT[input.idConflictPolicy] : null],
  ];
  const line = command(["temporal", "activity", "start"], target, flags);
  const types = retry?.nonRetryableErrorTypes ?? [];
  return types.length > 0 ? `${line} # non-retryable error types ${json(types)} have no CLI flag` : line;
}

/** `temporal schedule create|update …` for a schedule form (update replaces the whole schedule, as the sheet does). */
export function scheduleCommand(verb: "create" | "update", scheduleId: string, form: ScheduleForm, target: CliTarget): string {
  const { spec, action, policies, state } = form;
  const calendar = (c: (typeof spec.calendars)[number]) => json(Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null && v !== undefined && v !== "")));
  const flags: Flag[] = [
    ["--schedule-id", scheduleId],
    ...spec.calendars.map((c): Flag => ["--calendar", calendar(c)]),
    ...spec.intervals.map((i): Flag => ["--interval", i.offset ? `${i.every}/${i.offset}` : i.every]),
    ...spec.cronStrings.filter((c) => c.trim() !== "").map((c): Flag => ["--cron", c]),
    ["--time-zone", spec.timezone],
    ["--start-time", spec.startTime],
    ["--end-time", spec.endTime],
    ["--jitter", spec.jitter],
    ["--workflow-type", action.workflowType],
    ["--task-queue", action.taskQueue],
    ["--workflow-id", action.workflowId],
    ...inputs(action.args),
    ["--execution-timeout", action.executionTimeout],
    ["--run-timeout", action.runTimeout],
    ["--task-timeout", action.taskTimeout],
    ...pairs("--memo", action.memo),
    ...pairs("--search-attribute", action.searchAttributes),
    ["--overlap-policy", policies.overlap ? OVERLAP[policies.overlap] : null],
    ["--catchup-window", policies.catchupWindow],
    ...(policies.pauseOnFailure ? ([["--pause-on-failure"]] as Flag[]) : []),
    ...(state.paused ? ([["--paused"]] as Flag[]) : []),
    ["--notes", state.notes],
    ["--remaining-actions", state.remainingActions === null || state.remainingActions === undefined ? null : String(state.remainingActions)],
  ];
  const line = command(["temporal", "schedule", verb], target, flags);
  return action.retryPolicy ? `${line} # retry policy ${json(action.retryPolicy)} has no CLI flag` : line;
}
