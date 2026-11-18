// The confirmations of Temporal's actions (Mightyconsole spec §9.4). Each one names the workflow
// it acts on; the destructive ones (terminate, reset, delete a schedule) need their reason or the
// typed id before the button works; every one shows the server's error in place and stays open.
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { ErrorState } from "@/app/states";
import type { HistoryEvent, ResetReapply, ScheduleOverlap } from "@/gen/api";
import type { DescribedError } from "../types";
import { formatTime } from "./format";

/** Runs an action, tracking its busy state and error; `ok` is called when it succeeds. */
export function useAction(note: (e: unknown) => DescribedError) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const run = async (action: () => Promise<void>, ok: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      ok();
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError(null) };
}

interface ShellProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirm: string;
  /** The confirm button is the red one. */
  danger?: boolean;
  disabled?: boolean;
  busy: boolean;
  error: DescribedError | null;
  onConfirm(): void;
  children?: ReactNode;
}

/** A dialog with a form body, Cancel and a confirm button; Enter in a field confirms. */
function Shell({ open, onOpenChange, title, description, confirm, danger, disabled, busy, error, onConfirm, children }: ShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled && !busy) onConfirm();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-stack-md">
            {children}
            {error ? <ErrorState error={error} /> : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" appearance={danger ? "danger" : "primary"} disabled={disabled} loading={busy}>
              {confirm}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Resets a dialog's fields each time it opens. */
function useFreshOnOpen(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** `["a", 2]` → two arguments; any other JSON value → one; empty → none. Returns the error text on bad JSON. */
export function parseArgs(text: string): { args: unknown[] } | { error: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { args: [] };
  try {
    const value: unknown = JSON.parse(trimmed);
    return { args: Array.isArray(value) ? value : [value] };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not valid JSON." };
  }
}

export interface ArgsFieldProps {
  value: string;
  onChange(value: string): void;
  label?: string;
  /** Mod+Enter in the editor: Send, Run query. */
  onSubmit?: () => void;
}

/** The arguments of a signal or query: a JSON array (one argument each) or a single JSON value. */
export function ArgsField({ value, onChange, label = "Arguments", onSubmit }: ArgsFieldProps) {
  const parsed = parseArgs(value);
  const bad = "error" in parsed ? parsed.error : null;
  const labelId = useId();
  return (
    <Field invalid={bad !== null}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <CodeEditor value={value} onValueChange={onChange} language="json" aria-labelledby={labelId} placeholder='["approver", 42]' invalid={bad !== null} lineNumbers={false} onSubmit={onSubmit ? () => onSubmit() : undefined} className="h-panel-xs" />
      <FieldDescription>A JSON array sends one argument per item; any other JSON value is one argument. Each goes as json/plain.</FieldDescription>
      {bad ? <FieldError match>{bad}</FieldError> : null}
    </Field>
  );
}

export function SignalDialog({ open, onOpenChange, workflowId, busy, error, onSend }: { open: boolean; onOpenChange(open: boolean): void; workflowId: string; busy: boolean; error: DescribedError | null; onSend(name: string, args: unknown[]): void }) {
  const [name, setName] = useState("");
  const [args, setArgs] = useState("");
  useFreshOnOpen(open, () => {
    setName("");
    setArgs("");
  });
  const parsed = parseArgs(args);
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Signal ${workflowId}`}
      description="Sends a signal to the running workflow. The workflow decides what it does with it."
      confirm="Send signal"
      busy={busy}
      error={error}
      disabled={name.trim() === "" || "error" in parsed}
      onConfirm={() => "args" in parsed && onSend(name.trim(), parsed.args)}
    >
      <Field>
        <FieldLabel>Signal name</FieldLabel>
        <Input value={name} onValueChange={setName} placeholder="approve" autoComplete="off" spellCheck={false} />
      </Field>
      <ArgsField value={args} onChange={setArgs} onSubmit={() => !busy && name.trim() !== "" && "args" in parsed && onSend(name.trim(), parsed.args)} />
    </Shell>
  );
}

export function CancelDialog({ open, onOpenChange, workflowId, busy, error, onCancelWorkflow }: { open: boolean; onOpenChange(open: boolean): void; workflowId: string; busy: boolean; error: DescribedError | null; onCancelWorkflow(reason: string): void }) {
  const [reason, setReason] = useState("");
  useFreshOnOpen(open, () => setReason(""));
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Request cancellation of ${workflowId}?`}
      description="The workflow is asked to cancel itself and may clean up first, finish anyway or refuse. To end it at once, terminate it."
      confirm="Request cancellation"
      busy={busy}
      error={error}
      onConfirm={() => onCancelWorkflow(reason.trim())}
    >
      <Field>
        <FieldLabel>Reason (optional)</FieldLabel>
        <Input value={reason} onValueChange={setReason} autoComplete="off" />
      </Field>
    </Shell>
  );
}

export function TerminateDialog({ open, onOpenChange, workflowId, busy, error, onTerminate }: { open: boolean; onOpenChange(open: boolean): void; workflowId: string; busy: boolean; error: DescribedError | null; onTerminate(reason: string): void }) {
  const [reason, setReason] = useState("");
  useFreshOnOpen(open, () => setReason(""));
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Terminate ${workflowId}?`}
      description="The run ends at once, without cleanup: its activities are not told and nothing in the workflow code runs. This cannot be undone."
      confirm="Terminate"
      danger
      busy={busy}
      error={error}
      disabled={reason.trim() === ""}
      onConfirm={() => onTerminate(reason.trim())}
    >
      <Field>
        <FieldLabel>Reason (required)</FieldLabel>
        <Input value={reason} onValueChange={setReason} autoComplete="off" />
        <FieldDescription>It is written in the history.</FieldDescription>
      </Field>
    </Shell>
  );
}

/** The events a reset may start from: a workflow task that completed, started or failed (spec §9.4). */
export function resetPoints(events: readonly HistoryEvent[]): HistoryEvent[] {
  const ok = new Set(["WorkflowTaskCompleted", "WorkflowTaskStarted", "WorkflowTaskFailed", "WorkflowTaskTimedOut"]);
  return events.filter((e) => ok.has(e.eventType));
}

const REAPPLY: Record<ResetReapply, string> = {
  all: "All eligible events (signals and updates)",
  signals: "Signals only",
  none: "Nothing",
};

export function ResetDialog({ open, onOpenChange, workflowId, events, busy, error, onReset }: { open: boolean; onOpenChange(open: boolean): void; workflowId: string; events: readonly HistoryEvent[]; busy: boolean; error: DescribedError | null; onReset(eventId: number, reapply: ResetReapply, reason: string): void }) {
  const points = resetPoints(events);
  const [eventId, setEventId] = useState<number | null>(null);
  const [reapply, setReapply] = useState<ResetReapply>("all");
  const [reason, setReason] = useState("");
  useFreshOnOpen(open, () => {
    // The latest workflow task that completed is the usual point: everything before it is kept.
    const completed = [...points].reverse().find((e) => e.eventType === "WorkflowTaskCompleted");
    setEventId((completed ?? points[points.length - 1])?.eventId ?? null);
    setReapply("all");
    setReason("");
  });
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Reset ${workflowId}?`}
      description="A new run starts from the chosen event and replays the history up to it; this run is terminated if it is still open."
      confirm="Reset"
      danger
      busy={busy}
      error={error}
      disabled={eventId === null || reason.trim() === ""}
      onConfirm={() => eventId !== null && onReset(eventId, reapply, reason.trim())}
    >
      {points.length === 0 ? (
        <p className="text-body-1 text-fg-muted">This run has no workflow task to reset to yet.</p>
      ) : (
        <Field>
          <FieldLabel>Reset to</FieldLabel>
          <Select aria-label="Reset to event" items={Object.fromEntries(points.map((e) => [String(e.eventId), `#${e.eventId} ${e.eventType} ${formatTime(e.eventTime)}`.trim()]))} value={eventId === null ? "" : String(eventId)} onValueChange={(v) => setEventId(Number(v))}>
            {points.map((e) => (
              <SelectItem key={e.eventId} value={String(e.eventId)}>
                #{e.eventId} {e.eventType} {formatTime(e.eventTime)}
              </SelectItem>
            ))}
          </Select>
          <FieldDescription>Workflow tasks that completed, started or failed.</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel>Re-apply after the reset point</FieldLabel>
        <Select aria-label="Re-apply" items={REAPPLY} value={reapply} onValueChange={(v) => setReapply(v as ResetReapply)}>
          {(Object.keys(REAPPLY) as ResetReapply[]).map((r) => (
            <SelectItem key={r} value={r}>
              {REAPPLY[r]}
            </SelectItem>
          ))}
        </Select>
      </Field>
      <Field>
        <FieldLabel>Reason (required)</FieldLabel>
        <Input value={reason} onValueChange={setReason} autoComplete="off" />
      </Field>
    </Shell>
  );
}

export function PauseDialog({ open, onOpenChange, scheduleId, pausing, busy, error, onConfirm }: { open: boolean; onOpenChange(open: boolean): void; scheduleId: string; pausing: boolean; busy: boolean; error: DescribedError | null; onConfirm(note: string): void }) {
  const [note, setNote] = useState("");
  useFreshOnOpen(open, () => setNote(""));
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`${pausing ? "Pause" : "Resume"} ${scheduleId}?`}
      description={pausing ? "No new runs start until it is resumed." : "It starts runs again from now."}
      confirm={pausing ? "Pause" : "Resume"}
      busy={busy}
      error={error}
      onConfirm={() => onConfirm(note.trim())}
    >
      <Field>
        <FieldLabel>Note (optional)</FieldLabel>
        <Input value={note} onValueChange={setNote} autoComplete="off" />
        <FieldDescription>Shown with the schedule.</FieldDescription>
      </Field>
    </Shell>
  );
}

const OVERLAP: Record<ScheduleOverlap | "default", string> = {
  default: "The schedule's own policy",
  skip: "Skip if one is running",
  bufferOne: "Buffer one",
  bufferAll: "Buffer all",
  cancelOther: "Cancel the running one",
  terminateOther: "Terminate the running one",
  allowAll: "Allow all",
};

export function TriggerDialog({ open, onOpenChange, scheduleId, busy, error, onConfirm }: { open: boolean; onOpenChange(open: boolean): void; scheduleId: string; busy: boolean; error: DescribedError | null; onConfirm(overlap: ScheduleOverlap | null): void }) {
  const [overlap, setOverlap] = useState<ScheduleOverlap | "default">("default");
  useFreshOnOpen(open, () => setOverlap("default"));
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Run ${scheduleId} now?`}
      description="Starts its workflow once, outside its schedule."
      confirm="Run now"
      busy={busy}
      error={error}
      onConfirm={() => onConfirm(overlap === "default" ? null : overlap)}
    >
      <Field>
        <FieldLabel>If a run is still going</FieldLabel>
        <Select aria-label="Overlap policy" items={OVERLAP} value={overlap} onValueChange={(v) => setOverlap(v as ScheduleOverlap | "default")}>
          {(Object.keys(OVERLAP) as (ScheduleOverlap | "default")[]).map((o) => (
            <SelectItem key={o} value={o}>
              {OVERLAP[o]}
            </SelectItem>
          ))}
        </Select>
      </Field>
    </Shell>
  );
}

export function DeleteScheduleDialog({ open, onOpenChange, scheduleId, busy, error, onDelete }: { open: boolean; onOpenChange(open: boolean): void; scheduleId: string; busy: boolean; error: DescribedError | null; onDelete(): void }) {
  const [typed, setTyped] = useState("");
  useFreshOnOpen(open, () => setTyped(""));
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${scheduleId}?`}
      description="The schedule is removed and starts nothing more. Runs it already started go on. This cannot be undone."
      confirm="Delete schedule"
      danger
      busy={busy}
      error={error}
      disabled={typed !== scheduleId}
      onConfirm={onDelete}
    >
      <Field>
        <FieldLabel>Type {scheduleId} to confirm</FieldLabel>
        <Input value={typed} onValueChange={setTyped} autoComplete="off" spellCheck={false} />
      </Field>
    </Shell>
  );
}
