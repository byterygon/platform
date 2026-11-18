// `temporal.workflow { namespace, workflowId, runId? }` (Mightyconsole spec §9.3): one run, in
// tabs: Timeline, History, Input and result, Pending, Stack trace. The history loads page by page
// and, while the run is open, follows live. (The Queries tab and the actions come in batch 3.)
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
import { Toolbar, ToolbarGroup } from "@/components/ui/toolbar";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import { ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatDuration, formatTime } from "./format";
import { CATEGORIES, buildTimeline, eventMs, eventSummary, failureChain, inputAndResult, isClosed, itemEventId } from "./history";
import { statusLabel } from "./WorkflowsTab";
import { useWorkflow } from "./useWorkflow";

const STATUS_VARIANT = { Running: "accent", Completed: "success", Failed: "danger", Canceled: "neutral", Terminated: "warning", ContinuedAsNew: "info", TimedOut: "warning", Paused: "neutral", Unspecified: "neutral" } as const;

type Section = "timeline" | "history" | "io" | "pending" | "stack";

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

  // The clock for open items: once a second while the run is followed.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!state.following) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.following]);

  const { detail, events } = state;
  const closed = isClosed(events);
  const lastEventAt = events.length > 0 ? eventMs(events[events.length - 1]!) : now;
  // A closed run ends at its last event; an open one grows to the clock.
  const clock = closed ? lastEventAt : now;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="Workflow actions">
        <ToolbarGroup>
          <Button size="small" onClick={state.refresh} aria-label="Refresh">
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        </ToolbarGroup>
        {state.following ? (
          <Badge variant="success" role="status">
            Live
          </Badge>
        ) : null}
        <Badge variant="neutral">{formatCount(events.length)} events</Badge>
      </Toolbar>
      <Header detail={detail} workflowId={workflowId} namespace={namespace} profileName={profile.name} />
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      {state.loading && detail === null ? (
        <LoadingRows label="Loading the workflow" />
      ) : detail === null ? null : (
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Workflow views">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="io">Input and result</TabsTrigger>
            <TabsTrigger value="pending">Pending</TabsTrigger>
            <TabsTrigger value="stack">Stack trace</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col p-inset-sm">
            <TimelinePanel events={events} now={clock} workflowId={workflowId} selected={selected} onSelect={(id) => setSelected(id)} onOpenHistory={() => setSection("history")} />
          </TabsContent>
          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <HistoryPanel events={events} selected={selected} onSelect={setSelected} hasMore={state.hasMore} onLoadMore={state.loadMore} />
          </TabsContent>
          <TabsContent value="io" className="min-h-0 flex-1 overflow-auto p-inset-md">
            <InputResultPanel events={events} detail={detail} />
          </TabsContent>
          <TabsContent value="pending" className="min-h-0 flex-1 overflow-auto p-inset-md">
            <PendingPanel detail={detail} onOpenWorkflow={(workflowId2, runId2) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 })} />
          </TabsContent>
          <TabsContent value="stack" className="min-h-0 flex-1 overflow-auto p-inset-md">
            <StackPanel active={section === "stack"} running={detail.workflow.status === "Running"} client={client} connId={connId} namespace={namespace} workflowId={workflowId} runId={detail.workflow.runId} note={note} />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}

function Header({ detail, workflowId, namespace, profileName }: { detail: WorkflowDetail | null; workflowId: string; namespace: string; profileName: string }) {
  const w = detail?.workflow;
  return (
    <header className="flex flex-wrap items-center gap-x-inline-md gap-y-stack-xs border-b border-border-subtle px-inset-md py-inset-sm">
      <h2 className="text-subtitle-2 text-fg">{workflowId}</h2>
      {w ? <Badge variant={STATUS_VARIANT[w.status]}>{statusLabel(w.status)}</Badge> : null}
      {w ? <span className="text-body-1 text-fg-muted">{w.workflowType}</span> : null}
      {w ? <span className="font-mono text-code text-fg-muted" title="Run id">{w.runId}</span> : null}
      {w ? <span className="text-body-1 text-fg-muted">Task queue {w.taskQueue}</span> : null}
      {w?.startTime ? <span className="text-body-1 text-fg-muted">Started {formatTime(w.startTime)}</span> : null}
      {w?.closeTime ? <span className="text-body-1 text-fg-muted">Closed {formatTime(w.closeTime)}</span> : null}
      {w?.durationMs !== undefined ? <span className="text-body-1 text-fg-muted">{formatDuration(w.durationMs)}</span> : null}
      <span className="text-caption-1 text-fg-subtle">
        {namespace} · {profileName}
      </span>
    </header>
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
      <Toolbar aria-label="History filter">
        <ToolbarGroup>
          <Select aria-label="Category" value={category} onValueChange={(v) => setCategory(v as EventCategory | "All")} size="small" className="w-panel-xs">
            {(["All", ...CATEGORIES] as const).map((c) => (
              <SelectItem key={c} value={c}>
                {c === "All" ? "All events" : c.replace(/([a-z])([A-Z])/g, "$1 $2")}
              </SelectItem>
            ))}
          </Select>
        </ToolbarGroup>
        <Badge variant="neutral">
          {formatCount(shown.length)} of {formatCount(events.length)}
        </Badge>
        {hasMore ? (
          <Button size="small" onClick={onLoadMore}>
            Load more events
          </Button>
        ) : null}
      </Toolbar>
      <div className="flex min-h-0 flex-1 gap-inline-sm p-inset-sm">
        <Table aria-label="History events" className="min-h-0 min-w-0 flex-1">
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
        <aside aria-label="Event attributes" className="flex min-h-0 w-1/3 min-w-0 flex-col rounded-lg border border-border-subtle">
          {picked ? (
            <>
              <h3 className="border-b border-border-subtle px-inset-sm py-inset-xs text-body-1-strong text-fg">
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
