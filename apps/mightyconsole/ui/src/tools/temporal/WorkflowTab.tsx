// `temporal.workflow { namespace, workflowId, runId? }` (Mightyconsole spec §9.3): one run, in
// tabs: Timeline, History, Input and result, Pending, Stack trace. The history loads page by page
// and, while the run is open, follows live. Signal, cancel, terminate and reset are in the toolbar,
// each behind its confirmation (ActionDialogs); Queries is the sixth view.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableVirtualBody } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Timeline } from "@/components/ui/timeline";
import { CopyButton, Page, PageHeader, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { cn } from "@/lib/cn";
import { formatCount } from "@/app/messages";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ArrowClockwise, ArrowCounterclockwise, Dismiss, Flash, Stop } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatDuration, formatTime } from "./format";
import { CATEGORIES, buildTimeline, eventMs, eventSummary, failureChain, inputAndResult, isClosed, itemEventId } from "./history";
import { CancelDialog, ResetDialog, SignalDialog, TerminateDialog, useAction } from "./ActionDialogs";
import { QueriesPanel } from "./QueriesPanel";
import { statusLabel } from "./WorkflowsTab";
import { useWorkflow } from "./useWorkflow";

const STATUS_VARIANT = { Running: "accent", Completed: "success", Failed: "danger", Canceled: "neutral", Terminated: "warning", ContinuedAsNew: "info", TimedOut: "warning", Paused: "neutral", Unspecified: "neutral" } as const;

type Section = "timeline" | "history" | "io" | "pending" | "stack" | "queries";
type Dialog = "signal" | "cancel" | "terminate" | "reset" | null;

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** `PENDING_ACTIVITY_STATE_STARTED` as "Started". */
function stateLabel(value: unknown): string {
  const s = text(value).replace(/^[A-Z_]*STATE_/, "").toLowerCase().replace(/_/g, " ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

export function WorkflowTab({ tab, profile, connId, client, note, onLive, useTabActions, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const workflowId = text(tab.params["workflowId"]);
  const runId = text(tab.params["runId"]) || undefined;
  const state = useWorkflow({ client, connId, namespace, workflowId, runId, note, onLive });
  const [section, setSection] = useState<Section>("timeline");
  const [selected, setSelected] = useState<number | null>(null);
  useTabActions({ refresh: state.refresh });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newRun, setNewRun] = useState<string | null>(null);
  const action = useAction(note);
  const ref = { connId: connId ?? "", namespace, workflowId };
  const close = () => {
    setDialog(null);
    action.clear();
  };
  const done = () => {
    close();
    state.refresh();
  };

  // The clock for open items: once a second while the run is followed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.following) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.following]);

  const { detail, events } = state;
  const closed = isClosed(events);
  const running = detail?.workflow.status === "Running";
  const lastEventAt = events.length > 0 ? eventMs(events[events.length - 1]!) : now;
  // A closed run ends at its last event; an open one grows to the clock.
  const clock = closed ? lastEventAt : now;

  const w = detail?.workflow;
  const pending = detail ? detail.pendingActivities.length + detail.pendingChildren.length : 0;
  return (
    <Page>
      <PageHeader
        title={workflowId}
        adornment={
          <>
            <CopyButton value={workflowId} what="workflow ID" />
            {w ? <Badge variant={STATUS_VARIANT[w.status]}>{statusLabel(w.status)}</Badge> : null}
            {state.following ? (
              <Badge variant="success" role="status">
                Live
              </Badge>
            ) : null}
          </>
        }
        subtitle={
          w ? (
            <>
              {w.workflowType} · task queue <span className="text-fg">{w.taskQueue}</span>
              {w.startTime ? ` · started ${formatTime(w.startTime)}` : ""}
              {w.durationMs !== undefined ? ` · ${formatDuration(w.durationMs)}` : ""}
            </>
          ) : (
            `${namespace} · ${profile.name}`
          )
        }
        actions={
          <>
            <Button appearance="subtle" onClick={state.refresh} aria-label="Refresh">
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="secondary" disabled={!running} onClick={() => setDialog("signal")}>
              <Icon icon={Flash} /> Signal
            </Button>
            <Button appearance="secondary" disabled={!running} onClick={() => setDialog("cancel")}>
              <Icon icon={Dismiss} /> Cancel
            </Button>
            <Button appearance="secondary" disabled={detail === null || events.length === 0} onClick={() => setDialog("reset")}>
              <Icon icon={ArrowCounterclockwise} /> Reset
            </Button>
            <Button appearance="secondary" disabled={!running} onClick={() => setDialog("terminate")}>
              <Icon icon={Stop} /> Terminate
            </Button>
          </>
        }
      >
        {w ? (
          <dl className="m-0 flex flex-wrap gap-x-inline-xl gap-y-stack-sm">
            <Fact label="Run ID">
              <span className="font-mono text-code">{w.runId}</span>
              <CopyButton value={w.runId} what="run ID" />
            </Fact>
            <Fact label="Namespace">{namespace}</Fact>
            <Fact label="History">{formatCount(events.length)} events</Fact>
            <Fact label="Pending">{pending === 0 ? "Nothing" : `${pending} pending`}</Fact>
            {w.closeTime ? <Fact label="Closed">{formatTime(w.closeTime)}</Fact> : null}
          </dl>
        ) : null}
      </PageHeader>
      {newRun ? (
        <Alert intent="success" className="mx-inset-lg mt-stack-md">
          <AlertTitle>A new run started</AlertTitle>
          <AlertDescription>
            The reset made run <span className="font-mono text-code">{newRun}</span>.
          </AlertDescription>
          <AlertActions>
            <Button size="small" onClick={() => openTab({ kind: "temporal.workflow", params: { namespace, workflowId, runId: newRun }, title: workflowId })}>
              Open new run
            </Button>
            <Button size="small" appearance="subtle" onClick={() => setNewRun(null)}>
              Dismiss
            </Button>
          </AlertActions>
        </Alert>
      ) : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {state.loading && detail === null ? (
        <LoadingRows label="Loading the workflow" />
      ) : detail === null ? null : (
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Workflow views" className="px-inset-lg">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="io">Input and result</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="stack">Stack trace</TabsTrigger>
            <TabsTrigger value="queries">Queries</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col px-inset-lg py-inset-md">
            <TimelinePanel events={events} now={clock} workflowId={workflowId} selected={selected} onSelect={(id) => setSelected(id)} onOpenHistory={() => setSection("history")} />
          </TabsContent>
          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <HistoryPanel events={events} selected={selected} onSelect={setSelected} hasMore={state.hasMore} onLoadMore={state.loadMore} />
          </TabsContent>
          <TabsContent value="io" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <InputResultPanel events={events} detail={detail} />
          </TabsContent>
          <TabsContent value="pending" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <PendingPanel detail={detail} onOpenWorkflow={(workflowId2, runId2) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 })} />
          </TabsContent>
          <TabsContent value="queries" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <QueriesPanel client={client} connId={connId} namespace={namespace} workflowId={workflowId} runId={detail.workflow.runId} active={section === "queries"} note={note} />
          </TabsContent>
          <TabsContent value="stack" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <StackPanel active={section === "stack"} running={detail.workflow.status === "Running"} client={client} connId={connId} namespace={namespace} workflowId={workflowId} runId={detail.workflow.runId} note={note} />
          </TabsContent>
        </Tabs>
      )}
      <SignalDialog
        open={dialog === "signal"}
        onOpenChange={(o) => !o && close()}
        workflowId={workflowId}
        busy={action.busy}
        error={action.error}
        onSend={(name, args) => void action.run(() => client.temporal.workflows.signal({ ...ref, runId: detail?.workflow.runId ?? null, signalName: name, args }).then(() => undefined), done)}
      />
      <CancelDialog
        open={dialog === "cancel"}
        onOpenChange={(o) => !o && close()}
        workflowId={workflowId}
        busy={action.busy}
        error={action.error}
        onCancelWorkflow={(reason) => void action.run(() => client.temporal.workflows.cancel({ ...ref, runId: detail?.workflow.runId ?? null, reason }).then(() => undefined), done)}
      />
      <TerminateDialog
        open={dialog === "terminate"}
        onOpenChange={(o) => !o && close()}
        workflowId={workflowId}
        busy={action.busy}
        error={action.error}
        onTerminate={(reason) => void action.run(() => client.temporal.workflows.terminate({ ...ref, runId: detail?.workflow.runId ?? null, reason }).then(() => undefined), done)}
      />
      <ResetDialog
        open={dialog === "reset"}
        onOpenChange={(o) => !o && close()}
        workflowId={workflowId}
        events={events}
        busy={action.busy}
        error={action.error}
        onReset={(eventId, reapply, reason) =>
          void action.run(
            async () => {
              const out = await client.temporal.workflows.reset({ ...ref, runId: detail?.workflow.runId ?? "", eventId, reapply, reason });
              setNewRun(out.runId);
            },
            done,
          )
        }
      />
    </Page>
  );
}

/** One fact of the header row: a muted label over its value. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-stack-xs">
      <dt className="text-caption-1 text-fg-muted">{label}</dt>
      <dd className="m-0 flex items-center gap-inline-xs text-body-1 text-fg">{children}</dd>
    </div>
  );
}

function TimelinePanel({ events, now, workflowId, selected, onSelect, onOpenHistory }: { events: HistoryEvent[]; now: number; workflowId: string; selected: number | null; onSelect(id: number): void; onOpenHistory(): void }) {
  const { lanes, items } = useMemo(() => buildTimeline(events), [events]);
  if (events.length === 0) return <EmptyLine>No history yet.</EmptyLine>;
  const picked = selected === null ? undefined : events.find((e) => e.eventId === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-sm">
      <Timeline
        aria-label={`History timeline of ${workflowId}`}
        lanes={lanes}
        items={items}
        now={now}
        selectedId={selected === null ? null : `e${selected}`}
        onSelect={(id) => {
          const n = itemEventId(id);
          if (n !== null) onSelect(n);
        }}
        className="min-h-0 flex-1"
      />
      {picked ? (
        <p className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Badge variant="neutral">#{picked.eventId}</Badge> {picked.eventType} <span className="text-fg-muted">{eventSummary(picked)}</span>
          <Button size="small" appearance="subtle" onClick={onOpenHistory}>
            Show in History
          </Button>
        </p>
      ) : (
        <p className="text-caption-1 text-fg-muted">Select a bar to see its event. Plus and minus zoom, the arrow keys pan, Home fits.</p>
      )}
    </div>
  );
}

function HistoryPanel({ events, selected, onSelect, hasMore, onLoadMore }: { events: HistoryEvent[]; selected: number | null; onSelect(id: number): void; hasMore: boolean; onLoadMore(): void }) {
  const [category, setCategory] = useState<EventCategory | "All">("All");
  const shown = useMemo(() => (category === "All" ? events : events.filter((e) => e.category === category)), [events, category]);
  const picked = selected === null ? undefined : events.find((e) => e.eventId === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="group" aria-label="History filter" className="flex shrink-0 items-center gap-inline-md border-b border-border-subtle px-inset-lg py-stack-sm">
          <Select aria-label="Category" items={Object.fromEntries((["All", ...CATEGORIES] as const).map((c) => [c, c === "All" ? "All events" : c.replace(/([a-z])([A-Z])/g, "$1 $2")]))} value={category} onValueChange={(v) => setCategory(v as EventCategory | "All")} size="small" className="w-panel-xs">
            {(["All", ...CATEGORIES] as const).map((c) => (
              <SelectItem key={c} value={c}>
                {c === "All" ? "All events" : c.replace(/([a-z])([A-Z])/g, "$1 $2")}
              </SelectItem>
            ))}
          </Select>
        <Badge variant="neutral">
          {formatCount(shown.length)} of {formatCount(events.length)}
        </Badge>
        {hasMore ? (
          <Button size="small" onClick={onLoadMore}>
            Load more events
          </Button>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1">
        <Table aria-label="History events" className={cn("min-h-0 min-w-0 flex-1", gutterTable)}>
          <TableHeader>
            <TableRow>
              <TableHead align="end">ID</TableHead>
              <TableHead>Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Summary</TableHead>
            </TableRow>
          </TableHeader>
          <TableVirtualBody
            count={shown.length}
            renderRow={(i) => {
              const e = shown[i]!;
              return (
                <TableRow key={e.eventId} selected={e.eventId === selected} onClick={() => onSelect(e.eventId)} aria-selected={e.eventId === selected}>
                  <TableCell align="end">{e.eventId}</TableCell>
                  <TableCell>{formatTime(e.eventTime)}</TableCell>
                  <TableCell>{e.eventType}</TableCell>
                  <TableCell>{eventSummary(e)}</TableCell>
                </TableRow>
              );
            }}
          />
        </Table>
        <aside aria-label="Event attributes" className="flex min-h-0 w-1/3 min-w-0 flex-col border-s border-border-subtle">
          {picked ? (
            <>
              <h3 className="px-inset-lg pt-inset-md pb-stack-sm text-body-1-strong text-fg">
                #{picked.eventId} {picked.eventType}
              </h3>
              <JsonViewer value={picked.attributes} defaultExpandDepth={2} aria-label={`Attributes of event ${picked.eventId}`} className="min-h-0 flex-1" />
            </>
          ) : (
            <EmptyLine>Select an event.</EmptyLine>
          )}
        </aside>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-stack-xs pb-inset-md">
      <h3 className="text-body-1-strong text-fg">{title}</h3>
      {children}
    </section>
  );
}

function InputResultPanel({ events, detail }: { events: HistoryEvent[]; detail: WorkflowDetail }) {
  const io = useMemo(() => inputAndResult(events), [events]);
  const chain = failureChain(io.failure);
  const hasMemo = Object.keys(detail.memo).length > 0;
  const hasSearch = Object.keys(detail.searchAttributes).length > 0;
  return (
    <div className="flex flex-col">
      <Section title="Input">
        <JsonViewer value={io.input} defaultExpandDepth={3} aria-label="Workflow input" className="max-h-panel-sm" />
      </Section>
      {io.closedBy === undefined ? (
        <Section title="Result">
          <EmptyLine>The workflow is still running.</EmptyLine>
        </Section>
      ) : chain.length > 0 ? (
        <Section title="Failure">
          <ol className="flex flex-col gap-stack-sm">
            {chain.map((f, i) => (
              <li key={i} className="flex flex-col gap-stack-xs">
                <p className="text-body-1 text-fg">
                  {i > 0 ? <span className="text-fg-muted">Caused by: </span> : null}
                  {f.type ? <Badge variant="danger">{f.type}</Badge> : null} {f.message}
                </p>
                {f.stackTrace ? <CodeBlock code={f.stackTrace} language="text" copyable aria-label={`Stack of failure ${i + 1}`} className="max-h-panel-sm" /> : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : "result" in io ? (
        <Section title="Result">
          <JsonViewer value={io.result} defaultExpandDepth={3} aria-label="Workflow result" className="max-h-panel-sm" />
        </Section>
      ) : (
        <Section title="Result">
          <EmptyLine>Closed by {io.closedBy.replace("WorkflowExecution", "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}; no result.</EmptyLine>
        </Section>
      )}
      {hasMemo ? (
        <Section title="Memo">
          <JsonViewer value={detail.memo} defaultExpandDepth={2} aria-label="Memo" className="max-h-panel-sm" />
        </Section>
      ) : null}
      {hasSearch ? (
        <Section title="Search attributes">
          <JsonViewer value={detail.searchAttributes} defaultExpandDepth={2} aria-label="Search attributes" className="max-h-panel-sm" />
        </Section>
      ) : null}
    </div>
  );
}

function PendingPanel({ detail, onOpenWorkflow }: { detail: WorkflowDetail; onOpenWorkflow(workflowId: string, runId: string): void }) {
  const { pendingActivities: activities, pendingChildren: children, pendingWorkflowTask: task } = detail;
  if (activities.length === 0 && children.length === 0 && !task) return <EmptyLine>Nothing is pending.</EmptyLine>;
  return (
    <div className="flex flex-col">
      {activities.length > 0 ? (
        <Section title={`Pending activities (${activities.length})`}>
          <Table aria-label="Pending activities">
            <TableHeader>
              <TableRow>
                <TableHead>Activity</TableHead>
                <TableHead>State</TableHead>
                <TableHead align="end">Attempt</TableHead>
                <TableHead>Last failure</TableHead>
                <TableHead>Heartbeat</TableHead>
                <TableHead>Scheduled</TableHead>
                <TableHead>Last started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activities.map((a, i) => {
                const max = Number(a["maximumAttempts"]);
                const failure = obj(a["lastFailure"]);
                const heartbeat = a["heartbeatDetails"];
                return (
                  <TableRow key={text(a["activityId"]) || i}>
                    <TableCell>{text(obj(a["activityType"])["name"]) || text(a["activityId"])}</TableCell>
                    <TableCell>
                      <Badge variant={failure["message"] ? "danger" : "accent"}>{stateLabel(a["state"])}</Badge>
                    </TableCell>
                    <TableCell align="end">{text(a["attempt"])}{max > 0 ? ` of ${max}` : ""}</TableCell>
                    <TableCell wrap>{text(failure["message"])}</TableCell>
                    <TableCell>{heartbeat === undefined ? "" : JSON.stringify(heartbeat)}</TableCell>
                    <TableCell>{formatTime(text(a["scheduledTime"]))}</TableCell>
                    <TableCell>{formatTime(text(a["lastStartedTime"]))}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Section>
      ) : null}
      {children.length > 0 ? (
        <Section title={`Pending child workflows (${children.length})`}>
          <Table aria-label="Pending child workflows">
            <TableHeader>
              <TableRow>
                <TableHead>Workflow ID</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Run ID</TableHead>
                <TableHead>Parent close policy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {children.map((c, i) => (
                <TableRow key={text(c["workflowId"]) || i}>
                  <TableCell>
                    <Button size="small" appearance="subtle" onClick={() => onOpenWorkflow(text(c["workflowId"]), text(c["runId"]))}>
                      {text(c["workflowId"])}
                    </Button>
                  </TableCell>
                  <TableCell>{text(c["workflowTypeName"])}</TableCell>
                  <TableCell className="font-mono text-code">{text(c["runId"]).slice(0, 8)}</TableCell>
                  <TableCell>{stateLabel(c["parentClosePolicy"])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}
      {task ? (
        <Section title="Pending workflow task">
          <JsonViewer value={task} defaultExpandDepth={2} aria-label="Pending workflow task" className="max-h-panel-sm" />
        </Section>
      ) : null}
    </div>
  );
}

function StackPanel({ active, running, client, connId, namespace, workflowId, runId, note }: Pick<TabProps, "client" | "connId" | "note"> & { active: boolean; running: boolean; namespace: string; workflowId: string; runId: string }) {
  const [stack, setStack] = useState<string | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (connId === null) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.temporal.workflows.query({ connId, namespace, workflowId, runId, queryType: "__stack_trace" });
      setStack(typeof out.result === "string" ? out.result : JSON.stringify(out.result, null, 2));
    } catch (e) {
      setStack(null);
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };
  // Asked when the tab is first shown; a refresh is the button.
  useEffect(() => {
    if (active && running && stack === null && error === null && !busy) void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, running]);
  if (!running) return <EmptyLine>The workflow is not running: a stack trace needs a worker that holds it.</EmptyLine>;
  return (
    <div className="flex flex-col gap-stack-sm">
      <div>
        <Button size="small" onClick={() => void ask()} loading={busy}>
          <Icon icon={ArrowClockwise} /> Fetch stack trace
        </Button>
      </div>
      {error ? (
        error.kind === "Connect" ? (
          <EmptyLine>No worker answered. A running worker on the task queue must hold this workflow to report its stack.</EmptyLine>
        ) : (
          <ErrorState error={error} onRetry={() => void ask()} />
        )
      ) : null}
      {stack !== null ? <CodeBlock code={stack} language="text" copyable aria-label="Stack trace" className="max-h-panel-md" /> : null}
    </div>
  );
}
