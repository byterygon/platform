// `temporal.workflow { namespace, workflowId, runId? }` (Mightyconsole spec §9.3): one run, in
// tabs: Timeline, History, Input and result, Pending, Stack trace. The history loads page by page
// and, while the run is open, follows live. Signal, cancel, terminate and reset are in the toolbar,
// each behind its confirmation (ActionDialogs); Queries is the sixth view.
import { linkTo } from "@/app/tab-view";
import { useActiveClock } from "@/app/while-active";
import { useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableVirtualBody } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Timeline } from "@/components/ui/timeline";
import { CopyButton, NoticeContext, Page, PageHeader, chipClass, gutterTable } from "@/app/page";
import { useStoreIfAny } from "@/app/store";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import { cn } from "@/lib/cn";
import { formatCount } from "@/app/messages";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Add, ArrowClockwise, ArrowCounterclockwise, Checkmark, Code, Dismiss, Flash, MoreHorizontal, Stop } from "@/lib/icons";
import { ToggleButton } from "@/components/ui/toggle-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { IconButton } from "@/components/ui/icon-button";
import type { DescribedError, LinkEvent, TabProps } from "../types";
import { STATUS_TONE, formatDuration, formatTime } from "./format";
import { RelationsPanel } from "./RelationsPanel";
import { formatDurationText } from "./schedule-preview";
import { eventMs, failureChain, inputAndResult, inputAndResultOf, itemEventId, spanText, type LaneKind } from "./history";
import type { HistoryStore } from "./history-store";
import { saveBlob } from "../nats/objects-io";
import * as api from "@/gen/api";
import { CancelDialog, ResetDialog, SignalDialog, TerminateDialog, useAction } from "./ActionDialogs";
import { QueriesPanel } from "./QueriesPanel";
import { StartWorkflowSheet, type StartPrefill } from "./StartWorkflowSheet";
import { HistoryPanel } from "./HistoryPanel";
import { KIND_ICON, TimelinePane } from "./TimelinePane";
import { PendingPanel } from "./PendingPanel";
import { statusLabel } from "./WorkflowsTab";
import { useWorkflow, type HistoryOrder } from "./useWorkflow";
import { LIMITS, PayloadView, largeOf, largeStubs, type PayloadContext } from "./LargePayload";
import { formatBytes } from "./NamespacesTab";
import type { MightyClient } from "@/app/client";

const STATUS_VARIANT = STATUS_TONE;
const NO_EVENTS: readonly HistoryEvent[] = [];

/** The sections, and the view words ending a workflow's URL (DOC-21 §3.7). */
export const WORKFLOW_VIEWS = ["timeline", "history", "relations", "input", "pending", "queries", "stack"] as const;
type Section = (typeof WORKFLOW_VIEWS)[number];
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
  // A large input stays on the server: the sheet cannot send it back, so it starts empty.
  if (Array.isArray(io.input) && !io.input.some((a) => largeOf(a) !== null)) out.args = io.input;
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

export function WorkflowTab({ tab, profile, connId, client, note, onLive, useTabActions, openTab, navigate, go: goProp, active }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const notify = useContext(NoticeContext);
  const namespace = text(tab.params["namespace"]) || "default";
  const workflowId = text(tab.params["workflowId"]);
  const runId = text(tab.params["runId"]) || undefined;
  // Newest first by default (Uy Son, 2026-11-20); the choice is a setting, kept in the workspace (TSK-109).
  const app = useStoreIfAny();
  const [localOrder, setLocalOrder] = useState<HistoryOrder>("newest");
  const order: HistoryOrder = app?.state.settings.historyOrder ?? localOrder;
  const setOrder = (next: HistoryOrder) => (app ? app.dispatch({ type: "settings", settings: { historyOrder: next } }) : setLocalOrder(next));
  const state = useWorkflow({ client, connId, namespace, workflowId, runId, note, onLive, active, order });
  const [section, setSection] = useTabView({ tab, navigate }, WORKFLOW_VIEWS, "timeline");
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
  const now = useActiveClock(active, state.following);

  const { detail, store } = state;
  const running = detail?.workflow.status === "Running";
  // Closed by the history, or by describe when the closing event is not loaded yet (TSK-109).
  const closed = store.facts.closing !== undefined || (detail !== null && !running);
  const latest = store.latest;
  const lastEventAt = latest ? eventMs(latest) : now;
  const closeAt = detail?.workflow.closeTime ? Date.parse(detail.workflow.closeTime) : Number.NaN;
  // A closed run ends at its close (or last event); an open one grows to the clock.
  const clock = closed ? (Number.isNaN(closeAt) ? lastEventAt : Math.max(closeAt, lastEventAt)) : now;

  const w = detail?.workflow;
  const pending = detail ? detail.pendingActivities.length + detail.pendingChildren.length : 0;
  // Parent and children, known from the history before the Relations view loads.
  const related = (w?.parentWorkflowId ? 1 : 0) + store.facts.children.size;
  /** Saves the whole history from the server (TSK-109): decoded, or as stored for a replayer. */
  const downloadHistory = async (form: "decoded" | "stored") => {
    if (connId === null || !detail) return;
    try {
      const call = client.temporal.workflows.downloadHistory({ connId, namespace, workflowId, runId: detail.workflow.runId, form }, { timeoutMs: 3_600_000 });
      const parts: Uint8Array[] = [];
      for await (const chunk of call.chunks()) parts.push(chunk);
      await call.result;
      saveBlob(new Blob(parts as BlobPart[], { type: "application/json" }), `${workflowId}_${detail.workflow.runId}_history${form === "stored" ? "_stored" : ""}.json`);
    } catch (e) {
      const d = note(e);
      notify({ title: "Could not download the history", description: d.title, type: "warning" });
    }
  };
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
                <DropdownMenuItem disabled={detail === null || store.size === 0} onClick={() => setDialog("reset")}>
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
            <Fact label="History">{formatCount(Math.max(store.size, w.historyLength))} events</Fact>
            {detail.historySizeBytes > 0 ? (
              <Fact label="History size">
                <span className="flex items-center gap-inline-xs">
                  {formatBytes(detail.historySizeBytes)} of 50 MiB
                  {detail.historySizeBytes >= LIMITS.historyWarn ? (
                    <Badge appearance="tint" variant="warning">
                      Over 10 MiB
                    </Badge>
                  ) : null}
                </span>
              </Fact>
            ) : null}
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
            <Button size="small" onClick={() => go({ kind: "temporal.workflow", params: { namespace, workflowId, runId: newRun }, title: workflowId })}>
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
        <Tabs value={section} onValueChange={(v) => setSection(v as Section)} className="mt-stack-md flex min-h-0 flex-1 flex-col gap-0">
          <TabsList aria-label="Workflow views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="history">
              History <span className="text-body-1 text-fg-muted">{formatCount(Math.max(store.size, detail.workflow.historyLength))}</span>
            </TabsTrigger>
            <TabsTrigger value="relations">
              Relations {related > 0 ? <span className="text-body-1 text-fg-muted">{related}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="input">Input and result</TabsTrigger>
            <TabsTrigger value="pending">
              Pending {pending > 0 ? <span className="text-body-1 text-fg-muted">{pending}</span> : null}
            </TabsTrigger>
            <TabsTrigger value="queries">Queries</TabsTrigger>
            <TabsTrigger value="stack">Stack trace</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline" className="flex min-h-0 flex-1 flex-col">
            <TimelinePanel
              store={store}
              total={detail.workflow.historyLength}
              order={order}
              onOrderChange={setOrder}
              hasMore={state.hasMore}
              loadingMore={state.loadingMore}
              onLoadMore={state.loadMore}
              pending={detail.pendingActivities}
              now={clock}
              live={state.following}
              workflowId={workflowId}
              selected={selected}
              onSelect={(id) => setSelected(id)}
              onOpenWorkflow={(workflowId2, runId2, event) => go({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 ?? null }, title: workflowId2 }, event)}
            />
          </TabsContent>
          <TabsContent value="history" className="flex min-h-0 flex-1 flex-col">
            <HistoryPanel
              workflowId={workflowId}
              runId={detail.workflow.runId}
              store={store}
              total={detail.workflow.historyLength}
              startMs={detail.workflow.startTime ? Date.parse(detail.workflow.startTime) : undefined}
              order={order}
              onOrderChange={setOrder}
              loadingMore={state.loadingMore}
              loadUntil={state.loadUntil}
              onDownload={connId === null ? undefined : downloadHistory}
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
              onOpenPayload={(stub, label) => openTab({ kind: "temporal.payload", params: { namespace, payloadId: stub.id, label, workflowId, runId: detail.workflow.runId }, title: label })}
            />
          </TabsContent>
          <TabsContent value="relations" className="flex min-h-0 flex-1 flex-col">
            <RelationsPanel
              client={client}
              connId={connId}
              namespace={namespace}
              workflowId={workflowId}
              runId={detail.workflow.runId}
              active={section === "relations"}
              version={store.size}
              now={now}
              note={note}
              onOpenWorkflow={(workflowId2, runId2, event) => go({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, ...(runId2 ? { runId: runId2 } : {}) }, title: workflowId2 }, event)}
              onListWorkflows={(query) => go({ kind: "temporal.workflows", params: { namespace, query }, title: `Workflows · ${namespace}` })}
            />
          </TabsContent>
          <TabsContent value="input" className="min-h-0 flex-1 overflow-auto px-inset-lg py-inset-md">
            <InputResultPanel
              store={store}
              shown={section === "input"}
              detail={detail}
              client={client}
              connId={connId}
              note={note}
              workflowId={workflowId}
              onReload={state.refresh}
              onGoToEvent={(id) => {
                setSelected(id);
                setSection("history");
              }}
            />
          </TabsContent>
          <TabsContent value="pending" className="flex min-h-0 flex-1 flex-col">
            <PendingPanel detail={detail} now={now} onRefresh={state.refresh} onOpenWorkflow={(workflowId2, runId2, event) => go({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 }, event)} />
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
          prefill={prefillOf(w, store.first ? [store.first] : [])}
          note={note}
          onOpenWorkflow={(workflowId2, runId2, event) => go({ kind: "temporal.workflow", params: { namespace, workflowId: workflowId2, runId: runId2 }, title: workflowId2 }, event)}
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
        events={dialog === "reset" ? store.toArray() : NO_EVENTS}
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

/**
 * The Timeline's lanes in the views' order (TSK-109): newest first puts the lane whose first event
 * is the latest at the top, the workflow and its workflow tasks pinned above (they span the run);
 * the time axis still runs left to right.
 */
export function lanesInOrder<T extends { kind: LaneKind }>(lanes: readonly T[], order: HistoryOrder): T[] {
  if (order === "oldest") return [...lanes];
  const pinned = lanes.filter((l) => l.kind === "workflow" || l.kind === "workflowTask");
  const rest = lanes.filter((l) => l.kind !== "workflow" && l.kind !== "workflowTask");
  return [...pinned, ...rest.reverse()];
}

interface TimelinePanelProps {
  /** The loaded events (TSK-109); the Timeline is built from them one event at a time. */
  store: HistoryStore;
  /** The history's length as describe reports it. */
  total: number;
  /** Newest lanes first (the workflow and its workflow tasks stay on top), or oldest first. */
  order: HistoryOrder;
  onOrderChange(order: HistoryOrder): void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore(): void;
  pending: readonly Record<string, unknown>[];
  now: number;
  /** The run is followed live (open, its history streaming in). */
  live: boolean;
  workflowId: string;
  /** The selected event: the item it belongs to is selected (an event picked in History selects its activity). */
  selected: number | null;
  onSelect(id: number): void;
  /** Opens a child workflow in its own tab. */
  onOpenWorkflow(workflowId: string, runId?: string, event?: LinkEvent): void;
}

function TimelinePanel({ store, total, order, onOrderChange, hasMore, loadingMore, onLoadMore, pending, now, live, workflowId, selected, onSelect, onOpenWorkflow }: TimelinePanelProps) {
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The open items' captions and states at this clock (the closed ones were set as they closed).
  const data = store.timeline.view(now, pending);
  const [hidden, setHidden] = useState<ReadonlySet<LaneKind>>(() => new Set());
  const [follow, setFollow] = useState(true);
  // New arrays when the history or the filter changes, so the chart sees new lanes and items; the clock alone keeps them.
  const lanes = useMemo(
    () => lanesInOrder(data.lanes, order)
      .filter((l) => !hidden.has(l.kind))
      .map((l) => ({ id: l.id, label: l.label, detail: l.detail, icon: <Icon icon={KIND_ICON[l.kind]} /> })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.lanes, hidden, order, version],
  );
  const items = useMemo(
    () => {
      const shown = new Set(lanes.map((l) => l.id));
      return data.items.filter((i) => shown.has(i.laneId));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.items, lanes, version],
  );
  if (store.size === 0) return <EmptyLine>No history yet.</EmptyLine>;
  const selectedId = selected === null ? null : (data.itemOfEvent.get(selected) ?? null);
  const picked = selectedId ? data.info.get(selectedId) : undefined;
  const whole = Math.max(total, store.size);
  const toggle = (kind: LaneKind, on: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      if (on) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const toolbar = (
    <>
      <div role="group" aria-label="Lanes shown" className="flex flex-wrap items-center gap-inline-xs">
        {KIND_CHIPS.map(({ kind, label }) => {
          const count = data.counts[kind];
          const on = count > 0 && !hidden.has(kind);
          return (
            <ToggleButton key={kind} size="small" appearance="outline" pressed={on} disabled={count === 0} onPressedChange={(p) => toggle(kind, p)} className={chipClass}>
              {on ? <Icon icon={Checkmark} /> : null}
              {label} <span className={on || count === 0 ? undefined : "text-fg-muted"}>{count}</span>
            </ToggleButton>
          );
        })}
      </div>
      <div className="ms-auto flex items-center gap-inline-sm text-caption-1 text-fg-muted">
        <ToggleButton size="small" appearance="outline" pressed={order === "oldest"} onPressedChange={(p) => onOrderChange(p ? "oldest" : "newest")} className={chipClass}>
          {order === "oldest" ? <Icon icon={Checkmark} /> : null}
          Oldest first
        </ToggleButton>
        <span>
          {formatCount(store.size)} of {formatCount(whole)} events
        </span>
        {hasMore ? (
          <Button size="small" appearance="subtle" loading={loadingMore} onClick={onLoadMore}>
            Load more
          </Button>
        ) : null}
      </div>
      {live ? (
        <div className="flex items-center gap-inline-sm">
          <ToggleButton size="small" appearance="outline" pressed={follow} onPressedChange={setFollow} className={chipClass}>
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
        aside={<TimelinePane info={picked} events={store} pending={pending} now={now} onOpenWorkflow={onOpenWorkflow} />}
        asideLabel={picked ? `${picked.name}, ${picked.what}` : "Selected item"}
        className="min-h-0 flex-1"
      />
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

/** The run's largest payloads loaded: every `$large` stub of its events, biggest first. */
export function largestPayloads(events: readonly HistoryEvent[]): { eventId: number; label: string; bytes: number }[] {
  const what = (t: string) => t.replace(/^WorkflowExecution|^ActivityTask|EventAttributes$/g, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return events
    .flatMap((e) => largeStubs(e.attributes).map(({ path, stub }) => ({ eventId: e.eventId, label: `${what(e.eventType)} ${path}`.trim(), bytes: stub.bytes })))
    .sort((a, b) => b.bytes - a.bytes);
}

/** One argument or result: the payload view for a large one, else the JSON. */
function Values({ values, what, client, connId, note, workflowId, context, onReload }: { values: unknown; what: "Input" | "Result"; client: MightyClient; connId: string | null; note(e: unknown): DescribedError; workflowId: string; context: PayloadContext; onReload(): void }) {
  const list = Array.isArray(values) ? values : [values];
  if (connId === null || !list.some((v) => largeOf(v) !== null)) {
    return <JsonViewer value={values} defaultExpandDepth={3} aria-label={`Workflow ${what.toLowerCase()}`} className="max-h-panel-sm" />;
  }
  return (
    <div className="flex flex-col gap-stack-md">
      {list.map((v, i) => {
        const stub = largeOf(v);
        const label = `${what} · argument ${i + 1} of ${list.length}`;
        return stub ? (
          <div key={i} className="flex h-panel-xl min-h-0 rounded-md border border-border-subtle bg-layer">
            <PayloadView client={client} connId={connId} stub={stub} label={label} fileName={`${workflowId}-${what.toLowerCase()}-${i + 1}`} context={context} note={note} onReload={onReload} />
          </div>
        ) : (
          <JsonViewer key={i} value={v} defaultExpandDepth={3} aria-label={label} className="max-h-panel-sm" />
        );
      })}
    </div>
  );
}

function InputResultPanel({ store, shown, detail, client, connId, note, workflowId, onReload, onGoToEvent }: { store: HistoryStore; shown: boolean; detail: WorkflowDetail; client: MightyClient; connId: string | null; note(e: unknown): DescribedError; workflowId: string; onReload(): void; onGoToEvent(id: number): void }) {
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const io = inputAndResultOf(store.first, store.facts.closing);
  // The largest payloads walk every loaded event: only while this view is shown.
  const context: PayloadContext = useMemo(
    () => ({ historyBytes: detail.historySizeBytes > 0 ? detail.historySizeBytes : undefined, events: Math.max(store.size, detail.workflow.historyLength), largest: shown ? largestPayloads(store.toArray()) : [], onGoToEvent }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, shown, version, detail, onGoToEvent],
  );
  const shared = { client, connId, note, workflowId, context, onReload };
  const chain = failureChain(io.failure);
  const hasMemo = Object.keys(detail.memo).length > 0;
  const hasSearch = Object.keys(detail.searchAttributes).length > 0;
  return (
    <div className="flex flex-col">
      <Section title="Input">
        <Values values={io.input} what="Input" {...shared} />
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
          <Values values={io.result} what="Result" {...shared} />
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
