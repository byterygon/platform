// Create or edit schedule (Mightyconsole spec §9.3 "Create or edit schedule (sheet)", §9.4, TSK-92):
// "Create schedule" on Schedules and "Edit" on a schedule (prefilled from `describe.form`, the ID
// fixed). When: Calendar, Interval or Cron with a time zone, and the next 5 runs computed in the
// browser as you type; the workflow it starts; folded policies, jitter and bounds, workflow
// options and state. Edit lists what changed before it sends the whole schedule with the conflict
// token; a concurrent change comes back as Conflict with Reload. "Show as JSON" and "Copy as CLI
// command" give the same request.
import { useContext, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { NoticeContext } from "@/app/page";
import { ErrorState } from "@/app/states";
import type { MightyClient } from "@/app/client";
import type { ScheduleForm, ScheduleOverlap } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { Braces, Code, Save } from "@/lib/icons";
import type { DescribedError } from "../types";
import { ArgsField } from "./ActionDialogs";
import { scheduleCommand } from "./cli";
import { addressOf, tlsOf } from "./profile";
import { CALENDAR_FIELDS, changesOf, draftErrors, draftOfForm, formOf, newDraft, restSummary, specOf, type Change, type ScheduleDraft, type ShownCalendarField, type WhenKind } from "./schedule-draft";
import { formatRun, nextRuns } from "./schedule-preview";
import { DurationField, Fold, ObjectField, RetryFields, retrySummary } from "./sheet-parts";

export type ScheduleSheetMode = { kind: "create" } | { kind: "edit"; scheduleId: string; form: ScheduleForm; conflictToken: string };

export interface ScheduleSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: MightyClient;
  connId: string | null;
  profile: ProfileRecord;
  namespace: string;
  mode: ScheduleSheetMode;
  note(e: unknown): DescribedError;
  /** After a create or an update. */
  onSaved(scheduleId: string): void;
  /** Edit's Reload after a conflict: the stored schedule again. */
  onReload?: (() => Promise<{ form: ScheduleForm; conflictToken: string } | null>) | undefined;
}

const CALENDAR_LABELS: Record<ShownCalendarField, { label: string; hint: string }> = {
  second: { label: "Second", hint: "0" },
  minute: { label: "Minute", hint: "0" },
  hour: { label: "Hour", hint: "0" },
  dayOfMonth: { label: "Day of month", hint: "*" },
  month: { label: "Month", hint: "*" },
  dayOfWeek: { label: "Day of week", hint: "* (0 is Sunday)" },
};

const OVERLAP: Record<ScheduleOverlap | "default", string> = {
  default: "Skip (the default)",
  skip: "Skip if one is running",
  bufferOne: "Buffer one",
  bufferAll: "Buffer all",
  cancelOther: "Cancel the running one",
  terminateOther: "Terminate the running one",
  allowAll: "Allow all",
};

let zones: string[] | null = null;
/** The time zones the browser knows, for the time zone field's suggestions. */
function timeZones(): string[] {
  if (zones) return zones;
  try {
    zones = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  } catch {
    zones = ["UTC"];
  }
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

export function ScheduleSheet({ open, onOpenChange, client, connId, profile, namespace, mode, note, onSaved, onReload }: ScheduleSheetProps) {
  const notify = useContext(NoticeContext);
  const editing = mode.kind === "edit";
  const [stored, setStored] = useState<{ form: ScheduleForm; conflictToken: string } | null>(mode.kind === "edit" ? { form: mode.form, conflictToken: mode.conflictToken } : null);
  const [d, setD] = useState<ScheduleDraft>(() => (mode.kind === "edit" ? draftOfForm(mode.scheduleId, mode.form) : newDraft()));
  const [tried, setTried] = useState(false);
  const [review, setReview] = useState<Change[] | null>(null);
  const [asJson, setAsJson] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);

  useEffect(() => {
    if (!open) return;
    if (mode.kind === "edit") {
      setStored({ form: mode.form, conflictToken: mode.conflictToken });
      setD(draftOfForm(mode.scheduleId, mode.form));
    } else {
      setStored(null);
      setD(newDraft());
    }
    setTried(false);
    setReview(null);
    setAsJson(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (patch: Partial<ScheduleDraft>) => {
    setReview(null);
    setD((old) => ({ ...old, ...patch }));
  };
  const errors = draftErrors(d, editing);
  const valid = Object.keys(errors).length === 0;
  const shown = (key: string) => (tried || key.startsWith("calendar.") || key === "every" || key === "offset" || key === "cron" || key === "timezone" ? errors[key] : undefined);
  const form = valid ? formOf(d) : null;
  const spec = specOf(d);
  const preview = useMemo(() => nextRuns(spec, new Date()), [JSON.stringify(spec)]); // eslint-disable-line react-hooks/exhaustive-deps
  const target = { address: addressOf(profile), namespace, tls: tlsOf(profile.fields).enabled };
  const scheduleId = mode.kind === "edit" ? mode.scheduleId : d.scheduleId.trim();

  const send = async () => {
    if (!form || connId === null) return;
    setBusy(true);
    setError(null);
    try {
      if (editing) await client.temporal.schedules.update({ connId, namespace, scheduleId, schedule: form, conflictToken: stored?.conflictToken ?? null });
      else await client.temporal.schedules.create({ connId, namespace, scheduleId, schedule: form });
      onOpenChange(false);
      notify({ title: editing ? `Updated ${scheduleId}` : `Created ${scheduleId}`, type: "success" });
      onSaved(scheduleId);
    } catch (e) {
      setError(note(e));
      setReview(null);
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    setTried(true);
    if (!form || busy) return;
    if (!editing) return void send();
    if (review) return void send();
    setReview(stored ? changesOf(stored.form, form) : []);
  };

  const reload = async () => {
    if (!onReload) return;
    const fresh = await onReload();
    if (!fresh) return;
    setStored(fresh);
    setD(draftOfForm(scheduleId, fresh.form));
    setError(null);
    setReview(null);
    setTried(false);
  };

  const copyCli = async () => {
    if (!form) return;
    const line = scheduleCommand(editing ? "update" : "create", scheduleId, form, target);
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
      submit();
    }
  };

  const text = (key: keyof ScheduleDraft & string, label: string, opts: { placeholder?: string; description?: string; list?: string } = {}) => (
    <Field invalid={shown(key) !== undefined}>
      <FieldLabel>{label}</FieldLabel>
      <Input value={String(d[key])} onValueChange={(v) => set({ [key]: v } as Partial<ScheduleDraft>)} placeholder={opts.placeholder} list={opts.list} autoComplete="off" spellCheck={false} />
      {opts.description ? <FieldDescription>{opts.description}</FieldDescription> : null}
      {shown(key) ? <FieldError match>{shown(key)}</FieldError> : null}
    </Field>
  );

  const rest = restSummary(d.rest);
  const zoneList = `schedule-zones-${profile.id}`;
  const policies = [OVERLAP[d.overlap], d.catchupWindow.trim() && `catch-up ${d.catchupWindow.trim()}`, d.pauseOnFailure && "pause on failure"].filter(Boolean).join(", ");
  const bounds = [d.jitter.trim() && `jitter ${d.jitter.trim()}`, d.startTime.trim() && `from ${d.startTime.trim()}`, d.endTime.trim() && `until ${d.endTime.trim()}`].filter(Boolean).join(", ") || "None";
  const options = [d.executionTimeout && `execution ${d.executionTimeout}`, d.runTimeout && `run ${d.runTimeout}`, d.taskTimeout && `task ${d.taskTimeout}`, d.memo.trim() && "memo", d.searchAttributes.trim() && "search attributes", retrySummary(d.retry) !== "Server default" && "retry policy"].filter(Boolean).join(", ") || "Server defaults";
  const stateText = [d.paused ? "Paused" : "Active", d.notes.trim() && `“${d.notes.trim()}”`, d.remainingActions.trim() && `${d.remainingActions.trim()} runs left`].filter(Boolean).join(", ");

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent onKeyDown={onKeyDown}>
        <SheetHeader>
          <SheetTitle>{editing ? `Edit ${scheduleId}` : "Create schedule"}</SheetTitle>
          <SheetDescription>
            {editing ? "Updates" : "Creates"} a schedule in namespace {namespace} of {profile.name}. Ctrl+Enter {editing ? "reviews and saves" : "creates it"}.
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="schedule-form"
            aria-label={editing ? "Edit schedule" : "Create schedule"}
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            {editing ? null : text("scheduleId", "Schedule ID", { placeholder: "nightly-report" })}

            <fieldset className="flex flex-col gap-stack-sm">
              <legend className="pb-stack-xs text-body-1-strong text-fg">When</legend>
              <ToggleGroup aria-label="When" value={[d.when]} onValueChange={(v) => v[0] && set({ when: v[0] as WhenKind })}>
                <ToggleGroupItem value="calendar">Calendar</ToggleGroupItem>
                <ToggleGroupItem value="interval">Interval</ToggleGroupItem>
                <ToggleGroupItem value="cron">Cron</ToggleGroupItem>
              </ToggleGroup>
              {d.when === "calendar" ? (
                <>
                  <div className="grid grid-cols-3 gap-inline-md">
                    {CALENDAR_FIELDS.map((f) => (
                      <Field key={f} invalid={errors[`calendar.${f}`] !== undefined}>
                        <FieldLabel>{CALENDAR_LABELS[f].label}</FieldLabel>
                        <Input value={d.calendar[f]} onValueChange={(v) => set({ calendar: { ...d.calendar, [f]: v } })} placeholder={CALENDAR_LABELS[f].hint} autoComplete="off" spellCheck={false} />
                        {errors[`calendar.${f}`] ? <FieldError match>{errors[`calendar.${f}`]}</FieldError> : null}
                      </Field>
                    ))}
                  </div>
                  <p className="text-body-1 text-fg-muted">Temporal's calendar strings: 5, 1-5, */15, 0,30, mon-fri, jan. Empty is the default shown.</p>
                </>
              ) : d.when === "interval" ? (
                <div className="grid grid-cols-2 gap-inline-md">
                  {text("every", "Every", { placeholder: "1h", description: "Aligned on the Unix epoch." })}
                  {text("offset", "Offset", { placeholder: "0s", description: "Shifts the runs, e.g. 15m past each hour." })}
                </div>
              ) : (
                text("cron", "Cron string", { placeholder: "0 9 * * 1-5", description: "5, 6 (with year) or 7 (seconds first) fields, @daily and friends, CRON_TZ=…" })
              )}
              {text("timezone", "Time zone", { placeholder: "UTC", list: zoneList })}
              <datalist id={zoneList}>
                {timeZones().map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
              {rest.length > 0 ? (
                <div className="text-body-1 text-fg-muted">
                  Also kept as stored:
                  <ul className="list-disc ps-inset-lg">
                    {rest.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <section aria-label="Next runs" className="flex flex-col gap-stack-xs rounded-md border border-border-subtle px-inset-md py-stack-sm">
                <h3 className="text-body-1-strong text-fg">Next 5 runs</h3>
                {preview.runs.length === 0 ? (
                  <p className="text-body-1 text-fg-muted">{Object.keys(preview.errors).length > 0 ? "Correct the spec to see its runs." : "No run in the next ten years."}</p>
                ) : (
                  <ol className="font-mono text-code text-fg">
                    {preview.runs.map((r) => (
                      <li key={r.getTime()} data-at={r.toISOString()}>
                        {formatRun(r, d.timezone)}
                      </li>
                    ))}
                  </ol>
                )}
                <p className="text-body-1 text-fg-muted">Computed in the browser; the server's times show after saving.{d.jitter.trim() ? " Jitter is not applied here." : ""}</p>
              </section>
            </fieldset>

            <fieldset className="flex flex-col gap-stack-sm">
              <legend className="pb-stack-xs text-body-1-strong text-fg">Workflow</legend>
              <div className="grid grid-cols-2 gap-inline-md">
                {text("workflowType", "Workflow type")}
                {text("taskQueue", "Task queue")}
              </div>
              {text("workflowId", "Workflow ID", { description: "Temporal appends the scheduled time to it." })}
              <ArgsField label="Input" value={d.input} onChange={(input) => set({ input })} onSubmit={submit} />
            </fieldset>

            <Fold title="Policies" value={policies}>
              <Field>
                <FieldLabel>If the previous run is still going</FieldLabel>
                <Select aria-label="Overlap policy" items={OVERLAP} value={d.overlap} onValueChange={(v) => set({ overlap: v as ScheduleDraft["overlap"] })}>
                  {(Object.keys(OVERLAP) as ScheduleDraft["overlap"][]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {OVERLAP[k]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              <DurationField label="Catch-up window" value={d.catchupWindow} onChange={(catchupWindow) => set({ catchupWindow })} placeholder="1 year" description="How late a missed run may still start." />
              <Field className="flex-row items-center gap-inline-sm">
                <Checkbox checked={d.pauseOnFailure} onCheckedChange={(v) => set({ pauseOnFailure: v === true })} />
                <FieldLabel>Pause when a run fails</FieldLabel>
              </Field>
            </Fold>
            <Fold title="Jitter, start and end" value={bounds}>
              <DurationField label="Jitter" value={d.jitter} onChange={(jitter) => set({ jitter })} placeholder="None" description="Each run starts up to this much later, at random." />
              <div className="grid grid-cols-2 gap-inline-md">
                {text("startTime", "Start time", { placeholder: "2026-12-01T09:00:00Z" })}
                {text("endTime", "End time", { placeholder: "None" })}
              </div>
            </Fold>
            <Fold title="Workflow options" value={options}>
              <div className="grid grid-cols-3 gap-inline-md">
                <DurationField label="Execution timeout" value={d.executionTimeout} onChange={(executionTimeout) => set({ executionTimeout })} placeholder="Unlimited" />
                <DurationField label="Run timeout" value={d.runTimeout} onChange={(runTimeout) => set({ runTimeout })} placeholder="Unlimited" />
                <DurationField label="Task timeout" value={d.taskTimeout} onChange={(taskTimeout) => set({ taskTimeout })} placeholder="10s" />
              </div>
              <RetryFields value={d.retry} onChange={(retry) => set({ retry })} />
              <ObjectField label="Memo" value={d.memo} onChange={(memo) => set({ memo })} description="A JSON object; each field is stored as json/plain." onSubmit={submit} />
              <ObjectField label="Search attributes" value={d.searchAttributes} onChange={(searchAttributes) => set({ searchAttributes })} description="Custom search attributes of the namespace, as a JSON object." onSubmit={submit} />
            </Fold>
            <Fold title="State" value={stateText}>
              <Field className="flex-row items-center gap-inline-sm">
                <Checkbox checked={d.paused} onCheckedChange={(v) => set({ paused: v === true })} />
                <FieldLabel>Paused</FieldLabel>
              </Field>
              {text("notes", "Notes", { placeholder: "Why it is paused" })}
              {text("remainingActions", "Remaining runs", { placeholder: "Unlimited", description: "The schedule stops by itself after this many runs." })}
            </Fold>

            {asJson && form ? <CodeBlock code={JSON.stringify({ scheduleId, schedule: form }, null, 2)} language="json" title="The request" copyable /> : null}
            {tried && !valid ? (
              <p role="alert" className="text-body-1 text-danger-fg">
                Correct the marked fields.
              </p>
            ) : null}
            {review ? <ChangeList changes={review} /> : null}
            {error?.kind === "Conflict" ? (
              <Alert intent="danger">
                <AlertTitle>The schedule changed meanwhile</AlertTitle>
                <AlertDescription>Someone saved it after this sheet opened. Reload it to edit the stored version; your edits here are dropped.</AlertDescription>
                {onReload ? (
                  <AlertActions>
                    <Button size="small" onClick={() => void reload()}>
                      Reload
                    </Button>
                  </AlertActions>
                ) : null}
              </Alert>
            ) : error ? (
              <ErrorState error={error} />
            ) : null}
          </form>
        </SheetBody>
        <SheetFooter>
          <Button appearance="subtle" disabled={!form} aria-pressed={asJson} onClick={() => setAsJson((v) => !v)}>
            <Icon icon={Braces} /> {asJson ? "Hide JSON" : "Show as JSON"}
          </Button>
          <Button appearance="subtle" disabled={!form} onClick={() => void copyCli()}>
            <Icon icon={Code} /> Copy as CLI command
          </Button>
          <span className="flex-1" />
          {review ? (
            <Button onClick={() => setReview(null)}>Back</Button>
          ) : (
            <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          )}
          <Button type="submit" form="schedule-form" appearance="primary" loading={busy} disabled={connId === null || (review !== null && review.length === 0)}>
            <Icon icon={Save} /> {!editing ? "Create schedule" : review ? "Update schedule" : "Review changes"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/** What the update changes, before it is sent. */
function ChangeList({ changes }: { changes: readonly Change[] }) {
  if (changes.length === 0) return <p role="status" className="text-body-1 text-fg-muted">Nothing changed.</p>;
  return (
    <section aria-label="Changes" className="flex flex-col gap-stack-xs rounded-md border border-border-subtle px-inset-md py-stack-sm">
      <h3 className="text-body-1-strong text-fg">
        {changes.length} {changes.length === 1 ? "change" : "changes"} to send
      </h3>
      <ul className="flex flex-col gap-stack-xs text-body-1 text-fg">
        {changes.map((c) => (
          <li key={c.label}>
            <span className="text-body-1-strong">{c.label}</span>: <span className="font-mono text-code text-fg-muted">{c.before ?? "not set"}</span> → <span className="font-mono text-code">{c.after ?? "not set"}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
