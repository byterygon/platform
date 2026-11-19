// `temporal.workflow { namespace, workflowId, runId? }` (Mightyconsole spec §9.3): one run, in
// tabs: Timeline, History, Input and result, Pending, Stack trace. The history loads page by page
// and, while the run is open, follows live. Signal, cancel, terminate and reset are in the toolbar,
// each behind its confirmation (ActionDialogs); Queries is the sixth view.
import { useContext, useEffect, useMemo, useState } from "react";
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
import { Add, ArrowClockwise, ArrowCounterclockwise, ArrowImport, Checkmark, Clock, Code, Copy, Dismiss, Flash, Link, List, MoreHorizontal, Pin, Play, SplitVertical, Stop, type IconDefinition } from "@/lib/icons";
import { ToggleButton } from "@/components/ui/toggle-button";
import { NoticeContext } from "@/app/page";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import type { DescribedError, TabProps } from "../types";
import { formatDuration, formatTime } from "./format";
import { formatDurationText } from "./schedule-preview";
import { CATEGORIES, buildTimeline, clockText, eventMs, eventSummary, failureChain, inputAndResult, isClosed, itemEventId, spanText, type ItemInfo, type ItemStatus, type LaneKind } from "./history";
import { CancelDialog, ResetDialog, SignalDialog, TerminateDialog, useAction } from "./ActionDialogs";
import { QueriesPanel } from "./QueriesPanel";
import { StartWorkflowSheet, type StartPrefill } from "./StartWorkflowSheet";
import { HistoryPanel } from "./HistoryPanel";
import { PendingPanel } from "./PendingPanel";
import { statusLabel } from "./WorkflowsTab";
import { useWorkflow } from "./useWorkflow";

const STATUS_VARIANT = { Running: "info", Completed: "success", Failed: "danger", Canceled: "neutral", Terminated: "danger", ContinuedAsNew: "info", TimedOut: "warning", Paused: "neutral", Unspecified: "neutral" } as const;

type Section = "timeline" | "history" | "io" | "pending" | "stack" | "queries";
type Dialog = "signal" | "cancel" | "terminate" | "reset" | "startAnother" | null;

const text = (value: unknown): string => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/**
 * "Start another like this": the run's type, task queue, input, memo, timeouts and retry policy,
 * from its start event. Input that is not JSON (`$opaque`) is left for the user to replace.
 */
export function prefillOf(w: WorkflowDetail["workflow"], events: readonly HistoryEvent[]): StartPrefill {
  const out: StartPrefill = { workflowType: w.workflowType, taskQueue: w.taskQueue };
  const io = inputAndResult(events);
  if (Array.isArray(io.input)) out.args = io.input;
  const memo = obj(io.memo);
  if (Object.keys(memo).length > 0) out.memo = memo;
  const started = events.find((e) => e.eventType === "WorkflowExecutionStarted")?.attributes ?? {};
  const duration = (key: string) => {
    const s = /^(\d+(?:\.\d+)?)s$/.exec(text(started[key]));
    return s && Number(s[1]) > 0 ? formatDurationText(Math.round(Number(s[1]) * 1000)) : undefined;
  };
  const execution = duration("workflowExecutionTimeout");
  const run = duration("workflowRunTimeout");
  const task = duration("workflowTaskTimeout");
  if (execution) out.executionTimeout = execution;
  if (run) out.runTimeout = run;
  if (task && task !== "10s") out.taskTimeout = task;
  const retry = obj(started["retryPolicy"]);
  if (Object.keys(retry).length > 0) {
    const policy: NonNullable<StartPrefill["retryPolicy"]> = {};
    const iv = /^(\d+(?:\.\d+)?)s$/.exec(text(retry["initialInterval"]));
    if (iv) policy.initialInterval = formatDurationText(Math.round(Number(iv[1]) * 1000));
    const mx = /^(\d+(?:\.\d+)?)s$/.exec(text(retry["maximumInterval"]));
    if (mx) policy.maximumInterval = formatDurationText(Math.round(Number(mx[1]) * 1000));
    if (typeof retry["backoffCoefficient"] === "number") policy.backoffCoefficient = retry["backoffCoefficient"];
    if (typeof retry["maximumAttempts"] === "number" && retry["maximumAttempts"] > 0) policy.maximumAttempts = retry["maximumAttempts"];
    if (Array.isArray(retry["nonRetryableErrorTypes"]) && retry["nonRetryableErrorTypes"].length > 0) policy.nonRetryableErrorTypes = retry["nonRetryableErrorTypes"].map(String);
    out.retryPolicy = policy;
  }
  return out;
}

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
            {w ? <Badge appearance="tint" variant={STATUS_VARIANT[w.status]}>{statusLabel(w.status)}</Badge> : null}
          </>
        }
        subtitle={
          w ? (
            <>
              {w.workflowType} · task queue <span className="text-body-1-strong text-fg">{w.taskQueue}</span>
              {w.startTime ? ` · started ${formatTime(w.startTime)}` : ""}
              {running && w.startTime ? ` · running for ${spanText(now - Date.parse(w.startTime))}` : w.durationMs !== undefined ? ` · took ${formatDuration(w.durationMs)}` : ""}
            </>
          ) : (
            `${namespace} · ${profile.name}`
          )
        }
        actions={
          <>
            <Button appearance="secondary" disabled={!running} onClick={() => setDialog("signal")}>
              <Icon icon={Flash} /> Signal
            </Button>
            <Button appearance="secondary" disabled={detail === null} onClick={() => setSection("queries")}>
              <Icon icon={Code} /> Query
            </Button>
            <Button appearance="secondary" disabled={!running} onClick={() => setDialog("cancel")}>
              <Icon icon={Dismiss} /> Request cancellation
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More actions" disabled={w === undefined} />}>
                <Icon icon={MoreHorizontal} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={state.refresh}>
                  <Icon icon={ArrowClockwise} /> Refresh
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialog("startAnother")}>
                  <Icon icon={Add} /> Start another like this
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={detail === null || events.length === 0} onClick={() => setDialog("reset")}>
                  <Icon icon={ArrowCounterclockwise} /> Reset…
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!running} onClick={() => setDialog("terminate")}>
                  <Icon icon={Stop} /> Terminate…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {w ? (
          <dl className="m-0 flex flex-wrap gap-x-inset-xl gap-y-stack-sm">
            <Fact label="Run ID">
              <span className="font-mono text-code">{w.runId}</span>
              <CopyButton value={w.runId} what="run ID" />
            </Fact>
            <Fact label="Namespace">{namespace}</Fact>
            <Fact label="History">{formatCount(events.length)} events</Fact>
            <Fact label="Pending">{pendingWords(detail)}</Fact>
            <Fact label="Parent">{w.parentWorkflowId ?? "None"}</Fact>
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
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} onRefresh={state.refresh} /> : null}
      {state.loading && detail === null ? (
        <LoadingRows label="Loading the workflow" />
      ) : detail === null ? null : (
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
          <TabsList aria-label="Workflow views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="history">
              History <span className="text-body-1 text-fg-muted">{formatCount(events.length)}</span>
            </TabsTrigger>
            <TabsTrigger value="io">Input and result</TabsTrigger>
            <TabsTrigger value="pending">
              Pending {pending > 0 ? <span className="text-body-1 text-fg-muted">{pending}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="queries">Queries</TabsTrigger>
            <TabsTrigger value="stack">Stack trace</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col pt-stack-sm">
            <TimelinePanel
              events={events}
              pending={detail.pendingActivities}
              now={clock}
              live={state.following}
              workflowId={workflowId}
              selected={selected}
              onSelect={(id) => setSelected(id)}
              onOpenHistory={(id) => {
                setSelected(id);
                setSection("history");
              }}
            />
          </TabsContent>
          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <HistoryPanel
              workflowId={workflowId}
              runId={detail.workflow.runId}
              events={events}
              total={detail.workflow.historyLength}
              live={state.following}
              pending={detail.pendingActivities}
              selected={selected}
              onSelect={setSelected}
              hasMore={state.hasMore}
              onLoadMore={state.loadMore}
              onOpenPending={() => setSection("pending")}
              loadRaw={
                connId === null
                  ? undefined
                  : async (eventId) => (await client.temporal.workflows.rawEvent({ connId, namespace, workflowId, runId: detail.workflow.runId, eventId })).attributes
              }
            />
          </TabsContent>
          <TabsContent value="io" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <InputResultPanel events={events} detail={detail} />
          </TabsContent>
          <TabsContent value="pending" className="flex min-h-0 flex-1 flex-col">
            <PendingPanel detail={detail} now={now} onRefresh={state.refresh} onOpenWorkflow={(workflowId2, runId2) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 })} />
          </TabsContent>
          <TabsContent value="queries" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <QueriesPanel client={client} connId={connId} namespace={namespace} workflowId={workflowId} runId={detail.workflow.runId} active={section === "queries"} note={note} />
          </TabsContent>
          <TabsContent value="stack" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <StackPanel active={section === "stack"} running={detail.workflow.status === "Running"} client={client} connId={connId} namespace={namespace} workflowId={workflowId} runId={detail.workflow.runId} note={note} />
          </TabsContent>
        </Tabs>
      )}
      {w ? (
        <StartWorkflowSheet
          open={dialog === "startAnother"}
          onOpenChange={(o) => !o && close()}
          client={client}
          connId={connId}
          profile={profile}
          namespace={namespace}
          prefill={prefillOf(w, events)}
          note={note}
          onOpenWorkflow={(workflowId2, runId2) => openTab({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 })}
        />
      ) : null}
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

/** "1 activity", "2 activities and 1 child workflow", "None". */
function pendingWords(detail: WorkflowDetail | null): string {
  if (!detail) return "None";
  const parts: string[] = [];
  const a = detail.pendingActivities.length;
  const c = detail.pendingChildren.length;
  if (a > 0) parts.push(`${a} ${a === 1 ? "activity" : "activities"}`);
  if (c > 0) parts.push(`${c} child workflow${c === 1 ? "" : "s"}`);
  return parts.length === 0 ? "None" : parts.join(" and ");
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

/** The Timeline's lane icons, by kind. */
const KIND_ICON: Record<LaneKind, IconDefinition> = { workflow: Link, workflowTask: List, activity: Flash, timer: Clock, child: SplitVertical, signal: Play, update: ArrowImport, marker: Pin };
/** The filter chips, in the mockup's order. */
const KIND_CHIPS: readonly { kind: LaneKind; label: string }[] = [
  { kind: "activity", label: "Activities" },
  { kind: "timer", label: "Timers" },
  { kind: "signal", label: "Signals" },
  { kind: "marker", label: "Markers" },
  { kind: "child", label: "Child workflows" },
  { kind: "update", label: "Updates" },
  { kind: "workflowTask", label: "Workflow tasks" },
];
const ITEM_BADGE: Record<ItemStatus, "accent" | "success" | "danger" | "warning" | "info" | "neutral"> = { running: "info", success: "success", danger: "danger", warning: "warning", info: "info", neutral: "neutral" };

interface TimelinePanelProps {
  events: HistoryEvent[];
  pending: readonly Record<string, unknown>[];
  now: number;
  /** The run is followed live (open, its history streaming in). */
  live: boolean;
  workflowId: string;
  selected: number | null;
  onSelect(id: number): void;
  /** Opens History at an event. */
  onOpenHistory(eventId: number): void;
}

function TimelinePanel({ events, pending, now, live, workflowId, selected, onSelect, onOpenHistory }: TimelinePanelProps) {
  const data = useMemo(() => buildTimeline(events, { workflowId, pending, now }), [events, workflowId, pending, now]);
  const [hidden, setHidden] = useState<ReadonlySet<LaneKind>>(() => new Set());
  const [follow, setFollow] = useState(true);
  const lanes = useMemo(() => data.lanes.filter((l) => !hidden.has(l.kind)).map((l) => ({ id: l.id, label: l.label, detail: l.detail, icon: <Icon icon={KIND_ICON[l.kind]} /> })), [data.lanes, hidden]);
  const items = useMemo(() => {
    const shown = new Set(lanes.map((l) => l.id));
    return data.items.filter((i) => shown.has(i.laneId));
  }, [data.items, lanes]);
  if (events.length === 0) return <EmptyLine>No history yet.</EmptyLine>;
  const selectedId = selected === null ? null : `e${selected}`;
  const picked = selectedId ? data.info.get(selectedId) : undefined;
  const toggle = (kind: LaneKind, on: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      if (on) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const toolbar = (
    <>
      <span aria-hidden="true" className="h-control-sm border-s border-border-subtle" />
      <div role="group" aria-label="Lanes shown" className="flex flex-wrap items-center gap-inline-sm">
        {KIND_CHIPS.map(({ kind, label }) => {
          const count = data.counts[kind];
          const on = count > 0 && !hidden.has(kind);
          return (
            <ToggleButton key={kind} size="small" appearance="outline" pressed={on} disabled={count === 0} onPressedChange={(p) => toggle(kind, p)} className="rounded-full data-pressed:text-accent-subtle-fg">
              {on ? <Icon icon={Checkmark} /> : null}
              {label} {count}
            </ToggleButton>
          );
        })}
      </div>
      {live ? (
        <div className="ms-auto flex items-center gap-inline-sm">
          <ToggleButton size="small" appearance="outline" pressed={follow} onPressedChange={setFollow} className="rounded-full">
            <span aria-hidden="true" className={cn("size-icon-xs rounded-full", follow ? "bg-success" : "bg-fg-muted")} /> Following
          </ToggleButton>
          <Button size="small" appearance="subtle" disabled={follow} onClick={() => setFollow(true)}>
            Jump to now
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Timeline
        aria-label={`History timeline of ${workflowId}`}
        lanes={lanes}
        items={items}
        now={now}
        selectedId={selectedId}
        onSelect={(id) => {
          const n = itemEventId(id);
          if (n !== null) onSelect(n);
        }}
        defaultAxis="clock"
        overviewLabel="Whole run"
        follow={live && follow}
        onFollowChange={setFollow}
        toolbar={toolbar}
        className="min-h-0 flex-1"
      />
      <SelectedStrip info={picked} onOpenHistory={onOpenHistory} />
    </div>
  );
}

/** The strip under the Timeline: the selected item's times, attempt and failure, and its events in History. */
function SelectedStrip({ info, onOpenHistory }: { info: ItemInfo | undefined; onOpenHistory(eventId: number): void }) {
  const notify = useContext(NoticeContext);
  if (!info) {
    return <p className="shrink-0 border-t border-border-subtle px-inset-lg py-stack-md text-caption-1 text-fg-muted">Click a bar, or focus it and press Enter, to see its times, attempt and failure here. Plus and minus zoom, the arrow keys pan, Home fits.</p>;
  }
  const end = info.end;
  const facts = [
    `${clockText(info.start, true)} → ${end === null ? "now" : clockText(end, true)}`,
    end === null ? "" : spanText(end - info.start),
    info.attempt ? `attempt ${info.attempt}${info.maximumAttempts ? ` of ${info.maximumAttempts}` : ""}` : "",
    info.taskQueue ? `task queue ${info.taskQueue}` : "",
  ].filter(Boolean);
  const failure = info.failure;
  const copyFailure = async () => {
    if (!failure) return;
    const value = `${failure.type ? `${failure.type}: ` : ""}${failure.message}`;
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: "Copied the failure", description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: "Could not copy the failure", description: "The browser refused the clipboard. Select the text instead.", type: "warning" });
    }
  };
  const range = info.firstEventId === info.lastEventId ? `Event ${info.firstEventId}` : `Events ${info.firstEventId}–${info.lastEventId}`;
  return (
    <section aria-label="Selected item" className="flex shrink-0 items-center gap-inline-lg border-t border-border-subtle px-inset-lg py-stack-md">
      <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
        <p className="flex items-center gap-inline-sm text-body-1-strong text-fg">
          {info.name} · {info.what}
          <CopyButton value={info.name} what="name" />
          <Badge appearance="tint" variant={ITEM_BADGE[info.status]}>{info.state}</Badge>
        </p>
        <p className="truncate text-body-1 text-fg-muted">
          {facts.join(" · ")}
          {failure ? (
            <>
              {" · "}
              {failure.type ? <span className="text-body-1-strong text-fg">{failure.type}: </span> : null}
              {failure.message}
              {failure.nonRetryable ? " (non-retryable)" : ""}
            </>
          ) : null}
        </p>
      </div>
      <Button appearance="secondary" onClick={() => onOpenHistory(info.firstEventId)}>
        <Icon icon={List} /> {range} in History
      </Button>
      {failure ? (
        <Button appearance="secondary" onClick={() => void copyFailure()}>
          <Icon icon={Copy} /> Copy failure
        </Button>
      ) : null}
    </section>
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
                  {f.type ? <Badge appearance="tint" variant="danger">{f.type}</Badge> : null} {f.message}
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
