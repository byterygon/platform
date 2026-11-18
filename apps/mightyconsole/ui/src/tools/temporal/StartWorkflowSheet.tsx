// Start workflow (Mightyconsole spec §9.3 "Start workflow (sheet)", §9.4, TSK-92): opened from the
// Workflows header, the palette and a workflow's "Start another like this". Type and task queue
// (suggested from the loaded rows; the queue says how many workers poll it), a generated workflow
// ID, the input as a Monaco JSON array, and folded sections that show their values. Ctrl+Enter
// starts; the toast carries the run ID and Open workflow. "Copy as CLI command" gives the same
// request as `temporal workflow start`.
import { useContext, useEffect, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { NoticeContext } from "@/app/page";
import { ErrorState } from "@/app/states";
import type { MightyClient } from "@/app/client";
import type { IdConflictPolicy, IdReusePolicy, WorkflowStartInput } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ArrowCounterclockwise, Code, Play } from "@/lib/icons";
import type { DescribedError } from "../types";
import { ArgsField, parseArgs } from "./ActionDialogs";
import { workflowStartCommand } from "./cli";
import { addressOf, tlsOf } from "./profile";
import { DurationField, EMPTY_RETRY, Fold, ObjectField, RetryFields, RunIdLine, durationError, parseObject, randomSuffix, retryErrors, retryPolicyOf, retrySummary, retryText, type RetryText } from "./sheet-parts";

/** What "Start another like this" fills in. */
export interface StartPrefill {
  workflowType?: string;
  taskQueue?: string;
  args?: readonly unknown[];
  memo?: Record<string, unknown>;
  executionTimeout?: string;
  runTimeout?: string;
  taskTimeout?: string;
  retryPolicy?: WorkflowStartInput["retryPolicy"];
}

export interface StartWorkflowSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: MightyClient;
  connId: string | null;
  profile: ProfileRecord;
  namespace: string;
  prefill?: StartPrefill | undefined;
  /** Workflow types and task queues seen in the loaded rows. */
  suggestions?: { types: readonly string[]; queues: readonly string[] } | undefined;
  note(e: unknown): DescribedError;
  onOpenWorkflow(workflowId: string, runId: string): void;
  /** Called after a start, e.g. to refresh the list. */
  onStarted?: (() => void) | undefined;
}

const REUSE: Record<IdReusePolicy | "default", string> = {
  default: "Server default (allow duplicate)",
  allowDuplicate: "Allow duplicate",
  allowDuplicateFailedOnly: "Allow duplicate if the last run failed",
  rejectDuplicate: "Reject duplicate",
};
const CONFLICT: Record<IdConflictPolicy | "default", string> = {
  default: "Server default (fail)",
  fail: "Fail",
  useExisting: "Use the running workflow",
  terminateExisting: "Terminate the running workflow",
};

interface Draft {
  workflowType: string;
  taskQueue: string;
  workflowId: string;
  input: string;
  executionTimeout: string;
  runTimeout: string;
  taskTimeout: string;
  retry: RetryText;
  idReusePolicy: IdReusePolicy | "default";
  idConflictPolicy: IdConflictPolicy | "default";
  memo: string;
  searchAttributes: string;
  startDelay: string;
}

const generatedId = (type: string) => `${(type.trim() || "workflow").replace(/[^A-Za-z0-9_.-]+/g, "-")}-${randomSuffix()}`;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);

function draftOf(prefill: StartPrefill | undefined): Draft {
  const type = prefill?.workflowType ?? "";
  return {
    workflowType: type,
    taskQueue: prefill?.taskQueue ?? "",
    workflowId: generatedId(type),
    input: prefill?.args && prefill.args.length > 0 ? pretty(prefill.args) : "",
    executionTimeout: prefill?.executionTimeout ?? "",
    runTimeout: prefill?.runTimeout ?? "",
    taskTimeout: prefill?.taskTimeout ?? "",
    retry: retryText(prefill?.retryPolicy),
    idReusePolicy: "default",
    idConflictPolicy: "default",
    memo: prefill?.memo && Object.keys(prefill.memo).length > 0 ? pretty(prefill.memo) : "",
    searchAttributes: "",
    startDelay: "",
  };
}

/** The request the draft makes, or the first reason it cannot be sent. */
export function startInputOf(d: Draft): { input: Omit<WorkflowStartInput, "connId" | "namespace"> } | { error: string } {
  if (d.workflowType.trim() === "") return { error: "Name the workflow type." };
  if (d.taskQueue.trim() === "") return { error: "Name the task queue." };
  if (d.workflowId.trim() === "") return { error: "Give a workflow ID." };
  const args = parseArgs(d.input);
  if ("error" in args) return { error: `Input: ${args.error}` };
  for (const [label, v] of [["Execution timeout", d.executionTimeout], ["Run timeout", d.runTimeout], ["Task timeout", d.taskTimeout], ["Start delay", d.startDelay]] as const) {
    if (durationError(v)) return { error: `${label}: a duration such as 30s, 5m, 1h30m or 2d.` };
  }
  if (Object.keys(retryErrors(d.retry)).length > 0) return { error: "Retry policy: correct the marked fields." };
  const memo = parseObject(d.memo);
  if ("error" in memo) return { error: `Memo: ${memo.error}` };
  const sa = parseObject(d.searchAttributes);
  if ("error" in sa) return { error: `Search attributes: ${sa.error}` };
  const input: Omit<WorkflowStartInput, "connId" | "namespace"> = {
    workflowType: d.workflowType.trim(),
    taskQueue: d.taskQueue.trim(),
    workflowId: d.workflowId.trim(),
    args: args.args,
  };
  if (d.executionTimeout.trim()) input.executionTimeout = d.executionTimeout.trim();
  if (d.runTimeout.trim()) input.runTimeout = d.runTimeout.trim();
  if (d.taskTimeout.trim()) input.taskTimeout = d.taskTimeout.trim();
  const retry = retryPolicyOf(d.retry);
  if (retry) input.retryPolicy = retry;
  if (d.idReusePolicy !== "default") input.idReusePolicy = d.idReusePolicy;
  if (d.idConflictPolicy !== "default") input.idConflictPolicy = d.idConflictPolicy;
  if (Object.keys(memo.value).length > 0) input.memo = memo.value;
  if (Object.keys(sa.value).length > 0) input.searchAttributes = sa.value;
  if (d.startDelay.trim()) input.startDelay = d.startDelay.trim();
  return { input };
}

/** How many workers poll the queue for workflow tasks, while it is typed. */
function useQueueHint(client: MightyClient, connId: string | null, namespace: string, queue: string, open: boolean): string | null {
  const [hint, setHint] = useState<string | null>(null);
  useEffect(() => {
    setHint(null);
    const name = queue.trim();
    if (!open || connId === null || name === "") return undefined;
    let live = true;
    const timer = setTimeout(() => {
      client.temporal.taskQueues.describe({ connId, namespace, taskQueue: name }).then(
        (d) => {
          if (!live) return;
          const n = new Set(d.workflowPollers.map((p) => p.identity)).size;
          setHint(n === 0 ? "No worker is polling this task queue." : `${n} ${n === 1 ? "worker" : "workers"} polling.`);
        },
        () => live && setHint(null),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, connId, namespace, queue, open]);
  return hint;
}

export function StartWorkflowSheet({ open, onOpenChange, client, connId, profile, namespace, prefill, suggestions, note, onOpenWorkflow, onStarted }: StartWorkflowSheetProps) {
  const notify = useContext(NoticeContext);
  const [d, setD] = useState<Draft>(() => draftOf(prefill));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!open) return;
    setD(draftOf(prefill));
    setError(null);
    setTried(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (patch: Partial<Draft>) => setD((old) => ({ ...old, ...patch }));
  const hint = useQueueHint(client, connId, namespace, d.taskQueue, open);
  const built = startInputOf(d);
  const target = { address: addressOf(profile), namespace, tls: tlsOf(profile.fields).enabled };

  const start = async () => {
    setTried(true);
    if ("error" in built || connId === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.temporal.workflows.start({ connId, namespace, ...built.input });
      const workflowId = built.input.workflowId;
      onOpenChange(false);
      onStarted?.();
      notify({
        title: out.started ? `Started ${workflowId}` : `${workflowId} was already running`,
        description: <RunIdLine runId={out.runId} />,
        type: out.started ? "success" : "warning",
        action: { label: "Open workflow", onClick: () => onOpenWorkflow(workflowId, out.runId) },
      });
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };

  const copyCli = async () => {
    if ("error" in built) return;
    const line = workflowStartCommand(built.input, target);
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
      void start();
    }
  };

  const timeouts = [d.executionTimeout && `execution ${d.executionTimeout}`, d.runTimeout && `run ${d.runTimeout}`, d.taskTimeout && `task ${d.taskTimeout}`].filter(Boolean).join(", ") || "Server default";
  const policies = d.idReusePolicy === "default" && d.idConflictPolicy === "default" ? "Server default" : [d.idReusePolicy !== "default" ? REUSE[d.idReusePolicy] : "", d.idConflictPolicy !== "default" ? `running: ${CONFLICT[d.idConflictPolicy]}` : ""].filter(Boolean).join("; ");
  const memoCount = (text: string) => {
    const p = parseObject(text);
    return "value" in p ? Object.keys(p.value).length : 0;
  };
  const extras = [memoCount(d.memo) && `${memoCount(d.memo)} memo`, memoCount(d.searchAttributes) && `${memoCount(d.searchAttributes)} search attributes`].filter(Boolean).join(", ") || "None";
  const typeList = `start-types-${profile.id}`;
  const queueList = `start-queues-${profile.id}`;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent onKeyDown={onKeyDown}>
        <SheetHeader>
          <SheetTitle>Start workflow</SheetTitle>
          <SheetDescription>
            Starts a run in namespace {namespace} of {profile.name}. Ctrl+Enter starts it.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="start-workflow"
            aria-label="Start workflow"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void start();
            }}
          >
            <div className="grid grid-cols-2 gap-inline-md">
              <Field invalid={tried && d.workflowType.trim() === ""}>
                <FieldLabel>Workflow type</FieldLabel>
                <Input value={d.workflowType} onValueChange={(workflowType) => set({ workflowType })} list={typeList} autoComplete="off" spellCheck={false} required />
                {tried && d.workflowType.trim() === "" ? <FieldError match>Name the workflow type.</FieldError> : null}
              </Field>
              <Field invalid={tried && d.taskQueue.trim() === ""}>
                <FieldLabel>Task queue</FieldLabel>
                <Input value={d.taskQueue} onValueChange={(taskQueue) => set({ taskQueue })} list={queueList} autoComplete="off" spellCheck={false} required />
                {hint ? <FieldDescription>{hint}</FieldDescription> : null}
                {tried && d.taskQueue.trim() === "" ? <FieldError match>Name the task queue.</FieldError> : null}
              </Field>
            </div>
            <datalist id={typeList}>
              {(suggestions?.types ?? []).map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <datalist id={queueList}>
              {(suggestions?.queues ?? []).map((q) => (
                <option key={q} value={q} />
              ))}
            </datalist>
            <Field invalid={tried && d.workflowId.trim() === ""}>
              <FieldLabel>Workflow ID</FieldLabel>
              <div className="flex items-center gap-inline-xs">
                <Input value={d.workflowId} onValueChange={(workflowId) => set({ workflowId })} autoComplete="off" spellCheck={false} className="min-w-0 flex-1" />
                <IconButton appearance="subtle" aria-label="New workflow ID" onClick={() => set({ workflowId: generatedId(d.workflowType) })}>
                  <Icon icon={ArrowCounterclockwise} />
                </IconButton>
              </div>
              {tried && d.workflowId.trim() === "" ? <FieldError match>Give a workflow ID.</FieldError> : null}
            </Field>
            <ArgsField label="Input" value={d.input} onChange={(input) => set({ input })} onSubmit={() => void start()} />
            <Fold title="Timeouts" value={timeouts}>
              <div className="grid grid-cols-3 gap-inline-md">
                <DurationField label="Execution" value={d.executionTimeout} onChange={(executionTimeout) => set({ executionTimeout })} placeholder="Unlimited" />
                <DurationField label="Run" value={d.runTimeout} onChange={(runTimeout) => set({ runTimeout })} placeholder="Unlimited" />
                <DurationField label="Task" value={d.taskTimeout} onChange={(taskTimeout) => set({ taskTimeout })} placeholder="10s" />
              </div>
            </Fold>
            <Fold title="Retry policy" value={retrySummary(d.retry)}>
              <p className="text-body-1 text-fg-muted">A workflow is not retried unless it has a retry policy.</p>
              <RetryFields value={d.retry} onChange={(retry) => set({ retry })} />
              {d.retry !== EMPTY_RETRY ? (
                <Button size="small" appearance="subtle" className="self-start" onClick={() => set({ retry: EMPTY_RETRY })}>
                  Clear the retry policy
                </Button>
              ) : null}
            </Fold>
            <Fold title="ID policies" value={policies}>
              <Field>
                <FieldLabel>If a closed workflow has this ID</FieldLabel>
                <Select aria-label="ID reuse policy" items={REUSE} value={d.idReusePolicy} onValueChange={(v) => set({ idReusePolicy: v as Draft["idReusePolicy"] })}>
                  {(Object.keys(REUSE) as Draft["idReusePolicy"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {REUSE[k]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <Field>
                <FieldLabel>If a running workflow has this ID</FieldLabel>
                <Select aria-label="ID conflict policy" items={CONFLICT} value={d.idConflictPolicy} onValueChange={(v) => set({ idConflictPolicy: v as Draft["idConflictPolicy"] })}>
                  {(Object.keys(CONFLICT) as Draft["idConflictPolicy"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {CONFLICT[k]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            </Fold>
            <Fold title="Memo and search attributes" value={extras}>
              <ObjectField label="Memo" value={d.memo} onChange={(memo) => set({ memo })} description="A JSON object; each field is stored as json/plain." onSubmit={() => void start()} />
              <ObjectField label="Search attributes" value={d.searchAttributes} onChange={(searchAttributes) => set({ searchAttributes })} description="A JSON object of custom search attributes registered on the namespace." onSubmit={() => void start()} />
            </Fold>
            <Fold title="Start delay" value={d.startDelay.trim() || "None"}>
              <DurationField label="Start delay" value={d.startDelay} onChange={(startDelay) => set({ startDelay })} placeholder="None" description="The first workflow task is scheduled after this delay." />
            </Fold>
            {tried && "error" in built ? <p role="alert" className="text-body-1 text-danger-fg">{built.error}</p> : null}
            {error ? <ErrorState error={error} /> : null}
          </form>
        </SheetBody>
        <SheetFooter>
          <Button appearance="subtle" disabled={"error" in built} onClick={() => void copyCli()}>
            <Icon icon={Code} /> Copy as CLI command
          </Button>
          <span className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="submit" form="start-workflow" appearance="primary" loading={busy} disabled={connId === null}>
            <Icon icon={Play} /> Start
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
