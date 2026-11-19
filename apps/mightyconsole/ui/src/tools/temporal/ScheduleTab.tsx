// `temporal.schedule { namespace, scheduleId }` (DOC-21 §9.3 "Schedule", TSK-104): one schedule.
// The header: Trigger now, Pause… or Unpause… with a note, Edit (the schedule sheet), and in the
// menu Backfill…, Copy as JSON, Copy as CLI command and Delete…. The facts: the spec in words, the
// next run, the policies and the counts. Tabs: Runs (the workflows it started and the times it did
// not run, paged by token), Upcoming (the next 20 times from the server), Spec and action, JSON. The
// side: the next five times, the action and the note.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton, LinkButton, NoticeContext, Page, PageFooter, PageHeader, Pager, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { cn } from "@/lib/cn";
import type { ScheduleDetail, ScheduleOverlap, ScheduleRun, ScheduleRunsOutput } from "@/gen/api";
import { ArrowClockwise, Clock, Code, Copy, Delete, Edit, History, MoreHorizontal, Pause, Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { BackfillDialog, DeleteScheduleDialog, PauseDialog, TriggerDialog, useAction } from "./ActionDialogs";
import { scheduleCommand } from "./cli";
import { STATUS_TONE, formatDuration, formatShortTime, formatTime } from "./format";
import { spanText } from "./history";
import { addressOf, tlsOf } from "./profile";
import { formatRun } from "./schedule-preview";
import { ScheduleSheet } from "./ScheduleSheet";
import { statusLabel } from "./WorkflowsTab";

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const num = (value: unknown): number => Number(text(value) || 0) || 0;

/** Runs per page of the Runs tab. */
export const RUNS_PAGE = 20;
const UPCOMING = 20;

const OVERLAP_WORDS: Record<ScheduleOverlap, string> = { skip: "Skip", bufferOne: "Buffer one", bufferAll: "Buffer all", cancelOther: "Cancel the running one", terminateOther: "Terminate the running one", allowAll: "Allow all" };

type View = "runs" | "upcoming" | "spec" | "json";
type Dialog = "pause" | "unpause" | "trigger" | "delete" | "edit" | "backfill" | null;

/** "48 · 1 skipped · 0 missed", from the schedule's info. */
export function actionsWords(info: Record<string, unknown>): string {
  const dropped = num(info["bufferDropped"]);
  return [formatCount(num(info["actionCount"])), `${formatCount(num(info["overlapSkipped"]))} skipped`, `${formatCount(num(info["missedCatchupWindow"]))} missed`, dropped > 0 ? `${formatCount(dropped)} dropped` : ""].filter(Boolean).join(" · ");
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-stack-xs">
      <dt className="text-caption-1 text-fg-muted">{label}</dt>
      <dd className="m-0 flex items-center gap-inline-xs text-body-1 text-fg">{children}</dd>
    </div>
  );
}

function Item({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails className="min-w-0">{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** The Runs tab's pages: tokens kept as they come, Previous goes back through them. */
function useRuns(client: TabProps["client"], connId: string | null, namespace: string, scheduleId: string, note: TabProps["note"]) {
  const [tokens, setTokens] = useState<(string | null)[]>([null]);
  const [page, setPage] = useState(0);
  const [out, setOut] = useState<ScheduleRunsOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const generation = useRef(0);
  const load = useCallback(
    async (at: number, token: string | null) => {
      if (connId === null) return;
      const mine = ++generation.current;
      setLoading(true);
      setError(null);
      try {
        const o = await client.temporal.schedules.runs({ connId, namespace, scheduleId, pageSize: RUNS_PAGE, nextPageToken: token });
        if (mine !== generation.current) return;
        setOut(o);
        setPage(at);
        setTokens((t) => {
          const next = t.slice(0, at + 1);
          next[at] = token;
          if (o.nextPageToken) next[at + 1] = o.nextPageToken;
          return next;
        });
      } catch (e) {
        if (mine === generation.current) setError(note(e));
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [client, connId, namespace, scheduleId, note],
  );
  useEffect(() => {
    void load(0, null);
  }, [load]);
  return {
    out,
    page,
    loading,
    error,
    hasPrev: page > 0,
    hasNext: Boolean(out?.nextPageToken),
    prev: () => void load(page - 1, tokens[page - 1] ?? null),
    next: () => out?.nextPageToken && void load(page + 1, out.nextPageToken),
    first: () => void load(0, null),
    reload: () => void load(page, tokens[page] ?? null),
  };
}

export function ScheduleTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const scheduleId = text(tab.params["scheduleId"]);
  const notify = useContext(NoticeContext);
  const [detail, setDetail] = useState<ScheduleDetail | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [deleted, setDeleted] = useState(false);
  const [view, setView] = useState<View>("runs");
  const [upcoming, setUpcoming] = useState<string[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const action = useAction(note);
  const generation = useRef(0);
  const runs = useRuns(client, connId, namespace, scheduleId, note);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const d = await client.temporal.schedules.describe({ connId, namespace, scheduleId });
      if (mine !== generation.current) return;
      setDetail(d);
      setNow(Date.now());
      // The next times from the server; the describe's own list is the fallback.
      client.temporal.schedules.matchingTimes({ connId, namespace, scheduleId, startTime: new Date().toISOString(), endTime: null, limit: UPCOMING }).then(
        (t) => {
          if (mine === generation.current) setUpcoming(t.times);
        },
        () => {
          if (mine === generation.current) setUpcoming(null);
        },
      );
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, scheduleId, note]);

  useEffect(() => {
    void load();
  }, [load]);
  const refresh = () => {
    void load();
    runs.reload();
  };
  useTabActions({ refresh });

  const close = () => {
    setDialog(null);
    action.clear();
  };
  const done = () => {
    close();
    refresh();
  };
  const ref = { connId: connId ?? "", namespace, scheduleId };
  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: `Copied ${what}`, description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: `Could not copy ${what}`, description: "The browser refused the clipboard.", type: "warning" });
    }
  };
  const openWorkflow = (workflowId: string, runId?: string) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId, ...(runId ? { runId } : {}) }, title: workflowId });

  if (deleted) return <EmptyLine>{scheduleId} was deleted. Close this tab.</EmptyLine>;
  const s = detail?.summary;
  const form = detail?.form;
  const tz = form?.spec.timezone || "UTC";
  const next = upcoming ?? s?.nextRuns ?? [];
  const nextAt = next[0] ? Date.parse(next[0]) : null;
  const created = detail ? text(detail.info["createTime"]) : "";
  const updated = detail ? text(detail.info["updateTime"]) : "";
  const definition = detail ? { spec: detail.spec, action: detail.action, policies: detail.policies, state: detail.state } : {};
  const target = { address: addressOf(profile), namespace, tls: tlsOf(profile.fields).enabled };
  const args = form?.action.args ?? [];

  return (
    <Page>
      <PageHeader
        title={scheduleId}
        adornment={
          <>
            <CopyButton value={scheduleId} what="schedule ID" />
            {s ? <Badge appearance="tint" variant={s.paused ? "warning" : "success"}>{s.paused ? "Paused" : "Active"}</Badge> : null}
          </>
        }
        subtitle={
          s && form ? (
            <>
              Schedule · namespace <span className="text-body-1-strong text-fg">{namespace}</span> · starts <span className="text-body-1-strong text-fg">{s.workflowType || "—"}</span> on task queue <span className="text-body-1-strong text-fg">{form.action.taskQueue || "—"}</span>
              {created ? ` · created ${formatShortTime(created)}` : ""}
              {updated ? `, updated ${formatShortTime(updated)}` : ""}
            </>
          ) : (
            `${namespace} · ${profile.name}`
          )
        }
        actions={
          <>
            <Button appearance="secondary" disabled={s === undefined} onClick={() => setDialog("trigger")}>
              <Icon icon={Play} /> Trigger now
            </Button>
            {s?.paused ? (
              <Button appearance="secondary" onClick={() => setDialog("unpause")}>
                <Icon icon={Play} /> Unpause…
              </Button>
            ) : (
              <Button appearance="secondary" disabled={s === undefined} onClick={() => setDialog("pause")}>
                <Icon icon={Pause} /> Pause…
              </Button>
            )}
            <Button appearance="secondary" disabled={detail === null} onClick={() => setDialog("edit")}>
              <Icon icon={Edit} /> Edit
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More actions" disabled={detail === null} />}>
                <Icon icon={MoreHorizontal} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={refresh}>
                  <Icon icon={ArrowClockwise} /> Refresh
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("backfill")}>
                  <Icon icon={History} /> Backfill…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => void copy(JSON.stringify(definition, null, 2), "the schedule as JSON")}>
                  <Icon icon={Copy} /> Copy as JSON
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!form} onClick={() => form && void copy(scheduleCommand("create", scheduleId, form, target), "the CLI command")}>
                  <Icon icon={Code} /> Copy as CLI command
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setDialog("delete")}>
                  <Icon icon={Delete} /> Delete…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {s && form && detail ? (
          <dl className="m-0 flex flex-wrap gap-x-inset-xl gap-y-stack-sm">
            <Fact label="Runs">
              {s.spec} · {tz}
            </Fact>
            <Fact label="Next run">{nextAt !== null ? `${formatShortTime(next[0])} · in ${spanText(Math.max(0, nextAt - now))}` : s.paused ? "None while paused" : "None"}</Fact>
            <Fact label="Overlap">{OVERLAP_WORDS[form.policies.overlap ?? "skip"]}</Fact>
            <Fact label="Catch-up window">{form.policies.catchupWindow || "1 year (default)"}</Fact>
            <Fact label="Pause on failure">{form.policies.pauseOnFailure ? "Yes" : "No"}</Fact>
            <Fact label="Actions taken">{actionsWords(detail.info)}</Fact>
          </dl>
        ) : null}
      </PageHeader>
      {error ? <ErrorState error={error} onRetry={() => void load()} onRefresh={() => void load()} /> : null}
      {loading && detail === null ? <LoadingRows label="Loading the schedule" /> : null}
      {detail && s && form ? (
        <Tabs value={view} onValueChange={(v) => setView(v as View)} className="mt-stack-md flex min-h-0 flex-1 flex-col gap-0">
          <TabsList aria-label="Schedule views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="runs">
              Runs <span className="text-body-1 text-fg-muted">{formatCount(num(detail.info["actionCount"]))}</span>
            </TabsTrigger>
            <TabsTrigger value="upcoming">Upcoming</TabsTrigger>
            <TabsTrigger value="spec">Spec and action</TabsTrigger>
            <TabsTrigger value="json">JSON</TabsTrigger>
          </TabsList>
          <div className="flex min-h-0 flex-1 border-t border-border-subtle">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col">
                <RunsTable runs={runs} nextAt={runs.page === 0 && !s.paused ? nextAt : null} now={now} onOpenWorkflow={openWorkflow} />
              </TabsContent>
              <TabsContent value="upcoming" className="min-h-0 flex-1 overflow-auto">
                {next.length === 0 ? (
                  <EmptyLine>{s.paused ? "Paused: no run is planned." : "No run is planned."}</EmptyLine>
                ) : (
                  <Table aria-label="Upcoming times" className={gutterTable}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Time ({tz})</TableHead>
                        <TableHead>Your time</TableHead>
                        <TableHead className="text-end">In</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {next.map((t) => (
                        <TableRow key={t}>
                          <TableCell className="font-mono text-code">{formatRun(new Date(t), tz)}</TableCell>
                          <TableCell>{formatTime(t)}</TableCell>
                          <TableCell className="text-end">{spanText(Math.max(0, Date.parse(t) - now))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="spec" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
                <JsonViewer value={definition} defaultExpandDepth={2} aria-label="Schedule definition" />
              </TabsContent>
              <TabsContent value="json" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
                <JsonViewer value={{ scheduleId, ...definition, info: detail.info }} defaultExpandDepth={1} aria-label="Schedule as JSON" />
              </TabsContent>
            </div>
            <aside aria-label="Spec and action" className="flex w-panel-pane max-w-1/2 min-w-0 shrink-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
              <section className="flex flex-col gap-stack-sm">
                <div className="flex flex-col gap-stack-xs">
                  <h3 className="text-body-1-strong text-fg">Upcoming</h3>
                  <p className="text-caption-1 text-fg-muted">Computed by the server (ListScheduleMatchingTimes)</p>
                </div>
                {next.length === 0 ? (
                  <p className="text-body-1 text-fg-muted">{s.paused ? "Paused: no run is planned." : "No run is planned."}</p>
                ) : (
                  <ul aria-label="Upcoming runs" className="flex flex-col gap-stack-xs text-body-1 text-fg">
                    {next.slice(0, 5).map((t) => (
                      <li key={t} data-at={t} className="font-mono text-code">
                        {formatRun(new Date(t), tz)}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className="flex flex-col gap-stack-sm">
                <h3 className="text-body-1-strong text-fg">Action</h3>
                <DescriptionList layout="aligned">
                  <Item term="Workflow">{form.action.workflowType || "—"}</Item>
                  <Item term="Task queue">{form.action.taskQueue || "—"}</Item>
                  <Item term="Workflow ID">
                    <span className="font-mono text-code">{form.action.workflowId}-&lt;time&gt;</span>
                  </Item>
                  {form.action.executionTimeout ? <Item term="Execution timeout">{form.action.executionTimeout}</Item> : null}
                  {form.action.runTimeout ? <Item term="Run timeout">{form.action.runTimeout}</Item> : null}
                </DescriptionList>
                {args.length > 0 ? <CodeBlock code={JSON.stringify(args.length === 1 ? args[0] : args, null, 2)} language="json" aria-label="Input" /> : <p className="text-body-1 text-fg-muted">No input</p>}
              </section>
              <section className="flex flex-col gap-stack-xs">
                <h3 className="text-body-1-strong text-fg">Note</h3>
                <p className={cn("text-body-1", s.notes ? "text-fg" : "text-fg-muted")}>{s.notes || "None"}</p>
              </section>
            </aside>
          </div>
        </Tabs>
      ) : null}
      {detail ? (
        <ScheduleSheet
          open={dialog === "edit"}
          onOpenChange={(o) => !o && close()}
          client={client}
          connId={connId}
          profile={profile}
          namespace={namespace}
          mode={{ kind: "edit", scheduleId, form: detail.form, conflictToken: detail.conflictToken }}
          note={note}
          onSaved={() => void load()}
          onReload={async () => {
            if (connId === null) return null;
            const fresh = await client.temporal.schedules.describe({ connId, namespace, scheduleId });
            setDetail(fresh);
            return { form: fresh.form, conflictToken: fresh.conflictToken };
          }}
        />
      ) : null}
      <PauseDialog
        open={dialog === "pause" || dialog === "unpause"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        pausing={dialog !== "unpause"}
        busy={action.busy}
        error={action.error}
        onConfirm={(n) => void action.run(() => (dialog === "unpause" ? client.temporal.schedules.unpause({ ...ref, note: n || null, overlap: null }) : client.temporal.schedules.pause({ ...ref, note: n || null, overlap: null })).then(() => undefined), done)}
      />
      <TriggerDialog
        open={dialog === "trigger"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        busy={action.busy}
        error={action.error}
        onConfirm={(overlap) => void action.run(() => client.temporal.schedules.trigger({ ...ref, note: null, overlap }).then(() => undefined), done)}
      />
      <BackfillDialog
        open={dialog === "backfill"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        busy={action.busy}
        error={action.error}
        countRuns={async (startTime, endTime) => {
          const t = await client.temporal.schedules.matchingTimes({ ...ref, startTime, endTime, limit: 1000 });
          return { count: t.times.length, truncated: t.truncated };
        }}
        onBackfill={(startTime, endTime, overlap) =>
          void action.run(
            () => client.temporal.schedules.backfill({ ...ref, startTime, endTime, overlap }).then(() => undefined),
            () => {
              done();
              notify({ title: `Backfill of ${scheduleId} sent`, description: "Its runs appear in Runs as they start.", type: "success" });
            },
          )
        }
      />
      <DeleteScheduleDialog
        open={dialog === "delete"}
        onOpenChange={(o) => !o && close()}
        scheduleId={scheduleId}
        busy={action.busy}
        error={action.error}
        onDelete={() =>
          void action.run(
            () => client.temporal.schedules.delete({ connId: connId ?? "", namespace, scheduleId }).then(() => undefined),
            () => {
              close();
              setDeleted(true);
            },
          )
        }
      />
    </Page>
  );
}

function RunsTable({ runs, nextAt, now, onOpenWorkflow }: { runs: ReturnType<typeof useRuns>; nextAt: number | null; now: number; onOpenWorkflow(workflowId: string, runId?: string): void }) {
  const out = runs.out;
  if (runs.error && !out) return <ErrorState error={runs.error} onRetry={runs.reload} />;
  if (!out) return <LoadingRows label="Loading the runs" />;
  const rows: ScheduleRun[] = out.runs;
  return (
    <>
      <div className="min-h-0 flex-1 overflow-auto">
        {rows.length === 0 && nextAt === null ? (
          <EmptyLine>It has not run yet.</EmptyLine>
        ) : (
          <Table aria-label="Runs of the schedule" className={gutterTable}>
            <TableHeader>
              <TableRow>
                <TableHead>Scheduled for</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Workflow ID</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-end">Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {nextAt !== null ? (
                <TableRow>
                  <TableCell>{formatShortTime(new Date(nextAt).toISOString())}</TableCell>
                  <TableCell colSpan={4} className="text-fg-muted">
                    <span className="flex items-center gap-inline-xs">
                      <Icon icon={Clock} /> Next run, in {spanText(Math.max(0, nextAt - now))}
                    </span>
                  </TableCell>
                </TableRow>
              ) : null}
              {rows.map((r, i) => (
                <TableRow key={r.runId ?? `skip-${r.scheduledTime ?? i}`}>
                  <TableCell title={formatTime(r.scheduledTime)}>{formatShortTime(r.scheduledTime) || "—"}</TableCell>
                  <TableCell className="font-mono text-code text-fg-muted" title={formatTime(r.startTime)}>
                    {r.startTime ? clock(r.startTime) : "—"}
                  </TableCell>
                  <TableCell className="max-w-panel-xs">
                    {r.workflowId ? (
                      <LinkButton className="font-mono text-code" onClick={() => onOpenWorkflow(r.workflowId!, r.runId)}>
                        {r.workflowId}
                      </LinkButton>
                    ) : (
                      <span className="text-fg-muted">{r.skipped}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {r.status ? (
                      <Badge appearance="tint" variant={STATUS_TONE[r.status]}>
                        {statusLabel(r.status)}
                      </Badge>
                    ) : (
                      <Badge appearance="tint" variant="neutral">
                        {r.skipped?.startsWith("Skipped") ? "Skipped" : "No run"}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-end">{r.durationMs !== undefined ? formatDuration(r.durationMs) : r.status === "Running" && r.startTime ? spanText(now - Date.parse(r.startTime)) : "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <PageFooter>
        <span className="min-w-0 truncate">
          From the schedule&apos;s recent actions and a Workflows query on <span className="font-mono text-code">{out.query}</span>
        </span>
        <Pager range={`${formatCount(rows.length)} on this page`} page={runs.page + 1} hasPrev={runs.hasPrev} hasNext={runs.hasNext} onPrev={runs.prev} onNext={runs.next} busy={runs.loading} />
      </PageFooter>
    </>
  );
}

/** "02:00:00.412": the time of day with milliseconds. */
function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
