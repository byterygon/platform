// The parts the Write sheets share (Start workflow, Create or edit schedule; Mightyconsole spec
// §9.3, §9.4, TSK-92): folded sections that show their value, duration fields read as the server
// reads them, JSON object fields, the retry policy, a run ID toast, and the requests that open a
// sheet from the palette.
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { MightyClient } from "@/app/client";
import { CodeEditor } from "@/components/ui/code-editor";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import type { RetryPolicyForm } from "@/gen/api";
import { Checkmark, ChevronRight, Circle, Copy } from "@/lib/icons";
import { parseDuration } from "./schedule-preview";

/** The mark of a required field, after its label (the control itself carries `required`). */
export function Required() {
  return (
    <span aria-hidden="true" className="ps-inline-xs text-danger-fg">
      *
    </span>
  );
}

/** How many workers poll a task queue for workflow tasks, while it is typed (null: not known yet). */
export function useQueueWorkers(client: MightyClient, connId: string | null, namespace: string, queue: string, open: boolean): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    setCount(null);
    const name = queue.trim();
    if (!open || connId === null || name === "") return undefined;
    let live = true;
    const timer = setTimeout(() => {
      client.temporal.taskQueues.describe({ connId, namespace, taskQueue: name }).then(
        (d) => live && setCount(new Set(d.workflowPollers.map((p) => p.identity)).size),
        () => live && setCount(null),
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, connId, namespace, queue, open]);
  return count;
}

/** "2 workers polling" with a green dot, or the warning that nothing polls the queue. */
export function QueueWorkers({ count }: { count: number | null }) {
  if (count === null) return null;
  return (
    <span className="flex items-center gap-inline-xs">
      <Icon icon={Circle} filled size="xs" tone={count === 0 ? "warning" : "success"} />
      {count === 0 ? "No worker is polling this task queue." : `${count} ${count === 1 ? "worker" : "workers"} polling`}
    </span>
  );
}

/** The Write notice of a sheet (spec §9.4): where it writes and what follows. */
export function WritesTo({ profile, children }: { profile: string; children: ReactNode }) {
  return (
    <Alert intent="info">
      <AlertDescription>
        This writes to <strong>{profile}</strong>. {children}
      </AlertDescription>
    </Alert>
  );
}

/** A section folded by default; its summary line shows what it holds ("Not set" when nothing). */
export function Fold({ title, value, children, open }: { title: string; value: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="group border-t border-border-subtle" open={open}>
      <summary className="flex cursor-pointer list-none items-center gap-inline-sm py-stack-sm text-body-1 text-fg">
        <Icon icon={ChevronRight} className="transition-transform group-open:rotate-90" />
        <span className="text-body-1-strong">{title}</span>
        <span className="min-w-0 flex-1 truncate text-fg-muted">{value}</span>
      </summary>
      <div className="flex flex-col gap-stack-md pb-stack-md">{children}</div>
    </details>
  );
}

/** Why a duration text cannot be sent, or null. */
export function durationError(text: string): string | null {
  return parseDuration(text) === "invalid" ? "A duration such as 30s, 5m, 1h30m or 2d." : null;
}

/** A duration as text ("30s", "1h30m"); empty is the server's default. */
export function DurationField({ label, value, onChange, description, placeholder = "Server default" }: { label: string; value: string; onChange(value: string): void; description?: string; placeholder?: string }) {
  const error = durationError(value);
  return (
    <Field invalid={error !== null}>
      <FieldLabel>{label}</FieldLabel>
      <Input value={value} onValueChange={onChange} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError match>{error}</FieldError> : null}
    </Field>
  );
}

/** A JSON object's text: the object, nothing when empty, or the error. */
export function parseObject(text: string): { value: Record<string, unknown> } | { error: string } {
  const t = text.trim();
  if (t === "") return { value: {} };
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return { error: 'A JSON object, such as {"customer": "c-1"}.' };
    return { value: v as Record<string, unknown> };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Not valid JSON." };
  }
}

/** A JSON object (memo, search attributes) in a small Monaco editor. */
export function ObjectField({ label, value, onChange, description, onSubmit }: { label: string; value: string; onChange(value: string): void; description: string; onSubmit?: () => void }) {
  const parsed = parseObject(value);
  const bad = "error" in parsed ? parsed.error : null;
  const labelId = useId();
  return (
    <Field invalid={bad !== null}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <CodeEditor value={value} onValueChange={onChange} language="json" aria-labelledby={labelId} placeholder="{}" invalid={bad !== null} lineNumbers={false} onSubmit={onSubmit ? () => onSubmit() : undefined} className="h-panel-xs" />
      <FieldDescription>{description}</FieldDescription>
      {bad ? <FieldError match>{bad}</FieldError> : null}
    </Field>
  );
}

/** The retry policy's fields as text, as the sheet edits them. */
export interface RetryText {
  initialInterval: string;
  backoffCoefficient: string;
  maximumInterval: string;
  maximumAttempts: string;
  nonRetryableErrorTypes: string;
}

export const EMPTY_RETRY: RetryText = { initialInterval: "", backoffCoefficient: "", maximumInterval: "", maximumAttempts: "", nonRetryableErrorTypes: "" };

export function retryText(policy: RetryPolicyForm | null | undefined): RetryText {
  if (!policy) return EMPTY_RETRY;
  return {
    initialInterval: policy.initialInterval ?? "",
    backoffCoefficient: policy.backoffCoefficient === null || policy.backoffCoefficient === undefined ? "" : String(policy.backoffCoefficient),
    maximumInterval: policy.maximumInterval ?? "",
    maximumAttempts: policy.maximumAttempts ? String(policy.maximumAttempts) : "",
    nonRetryableErrorTypes: (policy.nonRetryableErrorTypes ?? []).join(", "),
  };
}

/** The errors of the retry fields, by field. */
export function retryErrors(r: RetryText): Partial<Record<keyof RetryText, string>> {
  const out: Partial<Record<keyof RetryText, string>> = {};
  for (const k of ["initialInterval", "maximumInterval"] as const) {
    const e = durationError(r[k]);
    if (e) out[k] = e;
  }
  if (r.backoffCoefficient.trim() !== "" && !(Number(r.backoffCoefficient) >= 1)) out.backoffCoefficient = "A number of at least 1, such as 2.";
  if (r.maximumAttempts.trim() !== "" && !/^\d+$/.test(r.maximumAttempts.trim())) out.maximumAttempts = "A whole number; 0 is unlimited.";
  return out;
}

/** The policy to send, or null when every field is empty (the server's defaults). */
export function retryPolicyOf(r: RetryText): RetryPolicyForm | null {
  const types = r.nonRetryableErrorTypes.split(",").map((s) => s.trim()).filter(Boolean);
  const out: RetryPolicyForm = {};
  if (r.initialInterval.trim()) out.initialInterval = r.initialInterval.trim();
  if (r.backoffCoefficient.trim()) out.backoffCoefficient = Number(r.backoffCoefficient);
  if (r.maximumInterval.trim()) out.maximumInterval = r.maximumInterval.trim();
  if (r.maximumAttempts.trim()) out.maximumAttempts = Number(r.maximumAttempts);
  if (types.length > 0) out.nonRetryableErrorTypes = types;
  return Object.keys(out).length === 0 ? null : out;
}

/** "initial 1s, ×2, max 10 attempts" or "Server default". */
export function retrySummary(r: RetryText): string {
  const parts = [
    r.initialInterval.trim() && `initial ${r.initialInterval.trim()}`,
    r.backoffCoefficient.trim() && `×${r.backoffCoefficient.trim()}`,
    r.maximumInterval.trim() && `up to ${r.maximumInterval.trim()}`,
    r.maximumAttempts.trim() && (r.maximumAttempts.trim() === "0" ? "unlimited attempts" : `${r.maximumAttempts.trim()} attempts`),
    r.nonRetryableErrorTypes.trim() && `not retried: ${r.nonRetryableErrorTypes.trim()}`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Server default";
}

export function RetryFields({ value, onChange }: { value: RetryText; onChange(value: RetryText): void }) {
  const errors = retryErrors(value);
  const set = (patch: Partial<RetryText>) => onChange({ ...value, ...patch });
  const text = (key: keyof RetryText, label: string, placeholder: string, description?: string) => (
    <Field invalid={errors[key] !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input value={value[key]} onValueChange={(v) => set({ [key]: v })} placeholder={placeholder} autoComplete="off" spellCheck={false} />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {errors[key] ? <FieldError match>{errors[key]}</FieldError> : null}
    </Field>
  );
  return (
    <>
      <div className="grid grid-cols-2 gap-inline-md">
        {text("initialInterval", "Initial interval", "1s")}
        {text("backoffCoefficient", "Backoff coefficient", "2")}
        {text("maximumInterval", "Maximum interval", "100 × initial")}
        {text("maximumAttempts", "Maximum attempts", "0 (unlimited)")}
      </div>
      {text("nonRetryableErrorTypes", "Error types not retried", "ValidationError, NotFound", "Comma-separated application error types.")}
    </>
  );
}

/** The run ID in a toast, with its own copy button (the toast sits outside the tab). */
export function RunIdLine({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-inline-xs">
      <span>
        Run ID <span className="font-mono text-code">{runId}</span>
      </span>
      <IconButton
        size="small"
        appearance="subtle"
        aria-label="Copy run ID"
        onClick={() =>
          void navigator.clipboard.writeText(runId).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        <Icon icon={copied ? Checkmark : Copy} />
      </IconButton>
    </span>
  );
}

/** A random suffix for generated IDs. */
export function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

// --- Requests from the palette ----------------------------------------------------------------

/** A sheet the palette asked a tab to open. */
export type SheetRequest = "startWorkflow" | "createSchedule";

const pending = new Map<string, number>();
const listeners = new Set<() => void>();
let version = 0;

/** Asks the profile's Workflows or Schedules tab to open its sheet once it is shown. */
export function requestSheet(profileId: string, kind: SheetRequest): void {
  pending.set(`${profileId}/${kind}`, ++version);
  for (const l of listeners) l();
}

/** Whether a request for this profile and sheet is waiting; `take` clears it. */
export function useSheetRequest(profileId: string, kind: SheetRequest): { waiting: boolean; take(): void } {
  const key = `${profileId}/${kind}`;
  const waiting = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pending.has(key),
  );
  return {
    waiting,
    take: () => {
      if (pending.delete(key)) for (const l of listeners) l();
    },
  };
}

