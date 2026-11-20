// Run activity (Mightyconsole spec §9.3 "Activities", §9.4, TSK-92; mockup frame
// `temporal-standalone-activity`): a standalone activity, run without a workflow. Type and task
// queue (suggested from the loaded rows; the queue says how many workers poll it for activities),
// a generated activity ID, the input as a Monaco JSON array, the two close timeouts (at least one),
// and folded retry policy, heartbeat and ID policy. Ctrl+Enter runs; the toast carries the run ID
// and Open activity. "Copy as CLI command" gives the same request as `temporal activity start`.
import { useSheetGuard } from "@/app/leave-guard";
import { useContext, useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { InputGroup, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { NoticeContext } from "@/app/page";
import { ErrorState } from "@/app/states";
import type { MightyClient } from "@/app/client";
import type { ActivityIdConflictPolicy, ActivityStartInput, IdReusePolicy } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ArrowCounterclockwise, Code, Flash } from "@/lib/icons";
import type { DescribedError, LinkEvent } from "../types";
import { ArgsField, parseArgs } from "./ActionDialogs";
import { activityStartCommand } from "./cli";
import { addressOf, tlsOf } from "./profile";
import { DurationField, Fold, QueueWorkers, Required, RetryFields, RunIdLine, SuggestInput, WritesTo, durationError, randomSuffix, retryErrors, retryPolicyOf, retrySummary, retryText, useQueueWorkers, type RetryText } from "./sheet-parts";

export interface RunActivitySheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: MightyClient;
  connId: string | null;
  profile: ProfileRecord;
  namespace: string;
  /** Activity types and task queues seen in the loaded rows. */
  suggestions?: { types: readonly string[]; queues: readonly string[] } | undefined;
  note(e: unknown): DescribedError;
  onOpenActivity(activityId: string, runId: string, event?: LinkEvent): void;
  /** Called after a run, e.g. to refresh the list. */
  onStarted?: (() => void) | undefined;
}

const REUSE: Record<IdReusePolicy | "default", string> = {
  default: "Server default (allow duplicate)",
  allowDuplicate: "Allow duplicate",
  allowDuplicateFailedOnly: "Allow duplicate if the last run failed",
  rejectDuplicate: "Reject duplicate",
};
const CONFLICT: Record<ActivityIdConflictPolicy | "default", string> = {
  default: "Server default (fail)",
  fail: "Fail",
  useExisting: "Use the running activity",
};
const REUSE_SHORT: Record<IdReusePolicy, string> = { allowDuplicate: "allow duplicate", allowDuplicateFailedOnly: "allow if failed", rejectDuplicate: "reject duplicate" };

export interface ActivityDraft {
  activityType: string;
  taskQueue: string;
  activityId: string;
  input: string;
  startToClose: string;
  scheduleToClose: string;
  scheduleToStart: string;
  heartbeat: string;
  retry: RetryText;
  idReusePolicy: IdReusePolicy | "default";
  idConflictPolicy: ActivityIdConflictPolicy | "default";
}

const generatedId = (type: string) => `${(type.trim() || "activity").replace(/[^A-Za-z0-9_.-]+/g, "-")}-${randomSuffix()}`;

export function activityDraft(): ActivityDraft {
  return {
    activityType: "",
    taskQueue: "",
    activityId: generatedId(""),
    input: "",
    startToClose: "30s",
    scheduleToClose: "",
    scheduleToStart: "",
    heartbeat: "",
    retry: retryText(null),
    idReusePolicy: "default",
    idConflictPolicy: "default",
  };
}

/** The request the draft makes, or the first reason it cannot be sent. */
export function activityInputOf(d: ActivityDraft): { input: Omit<ActivityStartInput, "connId" | "namespace"> } | { error: string } {
  if (d.activityType.trim() === "") return { error: "Name the activity type." };
  if (d.taskQueue.trim() === "") return { error: "Name the task queue." };
  if (d.activityId.trim() === "") return { error: "Give an activity ID." };
  const args = parseArgs(d.input);
  if ("error" in args) return { error: `Input: ${args.error}` };
  for (const [label, v] of [["Start to close", d.startToClose], ["Schedule to close", d.scheduleToClose], ["Schedule to start", d.scheduleToStart], ["Heartbeat timeout", d.heartbeat]] as const) {
    if (durationError(v)) return { error: `${label}: a duration such as 30s, 5m, 1h30m or 2d.` };
  }
  if (d.startToClose.trim() === "" && d.scheduleToClose.trim() === "") return { error: "Timeouts: give start to close, schedule to close or both." };
  if (Object.keys(retryErrors(d.retry)).length > 0) return { error: "Retry policy: correct the marked fields." };
  const input: Omit<ActivityStartInput, "connId" | "namespace"> = {
    activityType: d.activityType.trim(),
    taskQueue: d.taskQueue.trim(),
    activityId: d.activityId.trim(),
    args: args.args,
  };
  if (d.startToClose.trim()) input.startToCloseTimeout = d.startToClose.trim();
  if (d.scheduleToClose.trim()) input.scheduleToCloseTimeout = d.scheduleToClose.trim();
  if (d.scheduleToStart.trim()) input.scheduleToStartTimeout = d.scheduleToStart.trim();
  if (d.heartbeat.trim()) input.heartbeatTimeout = d.heartbeat.trim();
  const retry = retryPolicyOf(d.retry);
  if (retry) input.retryPolicy = retry;
  if (d.idReusePolicy !== "default") input.idReusePolicy = d.idReusePolicy;
  if (d.idConflictPolicy !== "default") input.idConflictPolicy = d.idConflictPolicy;
  return { input };
}

export function RunActivitySheet({ open, onOpenChange, client, connId, profile, namespace, suggestions, note, onOpenActivity, onStarted }: RunActivitySheetProps) {
  const notify = useContext(NoticeContext);
  const [d, setD] = useState<ActivityDraft>(activityDraft);
  const releaseGuard = useSheetGuard(open, d);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!open) return;
    setD(activityDraft());
    setError(null);
    setTried(false);
  }, [open]);
  const set = (patch: Partial<ActivityDraft>) => setD((old) => ({ ...old, ...patch }));
  const workers = useQueueWorkers(client, connId, namespace, d.taskQueue, open, "activity");
  const built = activityInputOf(d);
  const target = { address: addressOf(profile), namespace, tls: tlsOf(profile.fields).enabled };

  const run = async () => {
    setTried(true);
    if ("error" in built || connId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.temporal.activities.start({ connId, namespace, ...built.input });
      const activityId = built.input.activityId;
      releaseGuard();
      onOpenChange(false);
      onStarted?.();
      notify({
        title: out.started ? `Started ${activityId}` : `${activityId} was already running`,
        description: <RunIdLine runId={out.runId} />,
        type: out.started ? "success" : "warning",
        action: { label: "Open activity", onClick: () => onOpenActivity(activityId, out.runId) },
      });
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCli = async () => {
    if ("error" in built) return;
    const line = activityStartCommand(built.input, target);
    try {
      await navigator.clipboard.writeText(line);
      notify({ title: "Copied the CLI command", description: line.length > 120 ? `${line.slice(0, 117)}…` : line, type: "success" });
    } catch {
      notify({ title: "Could not copy the CLI command", description: "The browser refused the clipboard.", type: "warning" });
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void run();
    }
  };

  const missing = (v: string) => tried && v.trim() === "";
  const noTimeout = tried && d.startToClose.trim() === "" && d.scheduleToClose.trim() === "";
  const retry = retrySummary(d.retry);
  const policies = [
    d.heartbeat.trim() ? `heartbeat ${d.heartbeat.trim()}` : "no heartbeat timeout",
    d.scheduleToStart.trim() ? `schedule to start ${d.scheduleToStart.trim()}` : null,
    `reuse: ${d.idReusePolicy === "default" ? "allow duplicate" : REUSE_SHORT[d.idReusePolicy]}`,
    d.idConflictPolicy === "useExisting" ? "conflict: use existing" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent onKeyDown={onKeyDown} className="max-w-panel-sheet">
        <SheetHeader>
          <SheetTitle>Run activity</SheetTitle>
          <SheetDescription>
            Standalone activity · namespace {namespace} · {profile.name}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="run-activity"
            aria-label="Run activity"
            className="flex flex-col gap-stack-lg"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
              <Field invalid={missing(d.activityType)}>
                <FieldLabel>
                  Activity type
                  <Required />
                </FieldLabel>
                <SuggestInput value={d.activityType} onValueChange={(activityType) => set({ activityType })} items={suggestions?.types ?? []} />
                <FieldDescription>Suggested from the activity types listed here; any name is accepted.</FieldDescription>
                {missing(d.activityType) ? <FieldError match>Name the activity type.</FieldError> : null}
              </Field>
              <Field invalid={missing(d.taskQueue)}>
                <FieldLabel>
                  Task queue
                  <Required />
                </FieldLabel>
                <SuggestInput value={d.taskQueue} onValueChange={(taskQueue) => set({ taskQueue })} items={suggestions?.queues ?? []} />
                {workers !== null ? (
                  <FieldDescription>
                    <QueueWorkers count={workers} activities />
                  </FieldDescription>
                ) : null}
                {missing(d.taskQueue) ? <FieldError match>Name the task queue.</FieldError> : null}
              </Field>
              <Field invalid={missing(d.activityId)} className="col-span-2">
                <FieldLabel>
                  Activity ID
                  <Required />
                </FieldLabel>
                <InputGroup>
                  <InputGroupInput value={d.activityId} onValueChange={(activityId) => set({ activityId })} autoComplete="off" spellCheck={false} required className="font-mono text-code" />
                  <InputGroupButton aria-label="New random ID" title="New random ID" onClick={() => set({ activityId: generatedId(d.activityType) })}>
                    <Icon icon={ArrowCounterclockwise} />
                  </InputGroupButton>
                </InputGroup>
                {missing(d.activityId) ? <FieldError match>Give an activity ID.</FieldError> : null}
              </Field>
            </div>
            <Fold title="Input" value="JSON, one payload per argument" open>
              <ArgsField label="Input" hideLabel compact description={null} value={d.input} onChange={(input) => set({ input })} onSubmit={() => void run()} />
            </Fold>
            <Fold title="Timeouts" value="at least one of the two" open>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                <DurationField label="Start to close" value={d.startToClose} onChange={(startToClose) => set({ startToClose })} placeholder="None" description="One attempt" />
                <DurationField label="Schedule to close" value={d.scheduleToClose} onChange={(scheduleToClose) => set({ scheduleToClose })} placeholder="None" description="All attempts" />
              </div>
              {noTimeout ? (
                <p role="alert" className="text-body-1 text-danger-fg">
                  Give start to close, schedule to close or both.
                </p>
              ) : null}
            </Fold>
            <Fold title="Retry policy" value={retry === "Server default" ? "server default (retry without limit)" : retry}>
              <RetryFields value={d.retry} onChange={(retry) => set({ retry })} />
            </Fold>
            <Fold title="Heartbeat and ID policy" value={policies}>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                <DurationField label="Heartbeat timeout" value={d.heartbeat} onChange={(heartbeat) => set({ heartbeat })} placeholder="None" description="A cancel reaches the worker at its next heartbeat." />
                <DurationField label="Schedule to start" value={d.scheduleToStart} onChange={(scheduleToStart) => set({ scheduleToStart })} placeholder="None" description="Waiting for a worker" />
              </div>
              <Field>
                <FieldLabel>If a closed activity has this ID</FieldLabel>
                <Select aria-label="ID reuse policy" items={REUSE} value={d.idReusePolicy} onValueChange={(v) => set({ idReusePolicy: v as ActivityDraft["idReusePolicy"] })}>
                  {(Object.keys(REUSE) as ActivityDraft["idReusePolicy"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {REUSE[k]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <Field>
                <FieldLabel>If a running activity has this ID</FieldLabel>
                <Select aria-label="ID conflict policy" items={CONFLICT} value={d.idConflictPolicy} onValueChange={(v) => set({ idConflictPolicy: v as ActivityDraft["idConflictPolicy"] })}>
                  {(Object.keys(CONFLICT) as ActivityDraft["idConflictPolicy"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {CONFLICT[k]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            </Fold>
            <WritesTo profile={profile.name}>After the run starts: a toast with the run ID (copy) and “Open activity”.</WritesTo>
            {tried && "error" in built ? (
              <p role="alert" className="text-body-1 text-danger-fg">
                {built.error}
              </p>
            ) : null}
            {error ? <ErrorState error={error} /> : null}
          </form>
        </SheetBody>
        <SheetFooter className="flex-nowrap">
          <Button appearance="subtle" disabled={"error" in built} onClick={() => void copyCli()}>
            <Icon icon={Code} /> Copy as CLI command
          </Button>
          <span className="flex-1" />
          <Button appearance="secondary" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Tooltip>
            <TooltipTrigger render={<Button type="submit" form="run-activity" appearance="primary" loading={busy} disabled={connId === null} aria-keyshortcuts="Control+Enter" />}>
              <Icon icon={Flash} /> Run activity
            </TooltipTrigger>
            <TooltipContent>
              Run the activity <TooltipShortcut>Ctrl+Enter</TooltipShortcut>
            </TooltipContent>
          </Tooltip>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
