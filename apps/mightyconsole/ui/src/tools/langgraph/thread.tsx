// A thread (spec §11.2, §11.2.1), laid out as the TSK-91 mockup (TSK-95, TSK-96): a header with
// the thread, its status, profile, assistant, checkpoint and the counts of checkpoints and runs,
// and Stop, "…" (Roll back, Delete thread) and Run; then Run (assistant and input, the other
// options in one Advanced fold; the interrupt callout first, then the GraphView with the running
// node lit, chat messages and events; joining the run again after a reconnect), State
// (thread-state.tsx), History (thread-history.tsx) and Runs (thread-runs.tsx). The assistant, its
// graph and schemas are loaded here for all of them and for the Edit state sheet.
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { GraphView } from "@/components/ui/graph-view";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipShortcut, TooltipTrigger } from "@/components/ui/tooltip";
import { liveTimeout } from "@/app/client";
import { CopyButton, Page, PageHeader } from "@/app/page";
import { ariaBindingOf, bindingOf } from "@/app/shortcuts";
import { EmptyLine, ErrorState, LiveBadge } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import * as api from "@/gen/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ArrowUndo, ChevronDown, ChevronRight, Delete, MoreHorizontal, Play, Stop } from "@/lib/icons";
import type { DescribedError, LiveState, TabProps } from "../types";
import { EMPTY_RUN, type RunEvent, type RunView, eventName, interruptsOf, parseChunk, reduceRun } from "./run-events";
import { useActiveGate } from "@/app/while-active";
import { JsonField, StatusBadge, configSchema, parseJson, preview, schemaObject, shortId, toGraphView, useLoad } from "./shared";
import { HISTORY_PAGE, HistoryPanel } from "./thread-history";
import { RUNS_PAGE, RunsPanel } from "./thread-runs";
import { EditStateSheet, StatePanel } from "./thread-state";
import { ResumeSheet } from "./resume-sheet";
import { EventsView, THIS_RUN } from "./run-events-view";

const text = (v: unknown) => (typeof v === "string" ? v : "");
const pretty = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));

/** The stream modes the Run form offers; `messages` is the server's `messages-tuple`. */
const MODES = [
  { id: "values", label: "values", server: "values" },
  { id: "updates", label: "updates", server: "updates" },
  { id: "messages", label: "messages", server: "messages-tuple" },
  { id: "custom", label: "custom", server: "custom" },
  { id: "debug", label: "debug", server: "debug" },
] as const;
type ModeId = (typeof MODES)[number]["id"];

/** Keys the LangGraph server writes into a run's `configurable` itself; not part of what was asked. */
const SERVER_CONFIG_KEYS = new Set(["thread_id", "run_id", "assistant_id", "graph_id", "user_id", "checkpoint_id", "checkpoint_ns", "langgraph_auth_user", "langgraph_auth_user_id", "langgraph_auth_permissions", "langgraph_request_id", "x-request-id"]);

/** "a, b" → ["a", "b"]; empty → null. */
const nodeList = (s: string) => {
  const list = s.split(",").map((x) => x.trim()).filter(Boolean);
  return list.length > 0 ? list : null;
};

/** A first input from the graph's input schema: a human message when it takes messages. */
export function defaultInput(schema: unknown): string {
  const props = (schema as { properties?: Record<string, unknown> } | null)?.properties;
  if (props && "messages" in props) return pretty({ messages: [{ type: "human", content: "" }] });
  return "{}";
}

/** The thread's sections, the view words of its URL (DOC-21 §3.7). */
export const THREAD_VIEWS = ["run", "state", "history", "runs"] as const;

/** The run options folded under Advanced. */
export interface AdvancedOptions {
  modes: readonly string[];
  subgraphs: boolean;
  before: string;
  after: string;
  config: string;
  context: string;
}

/**
 * The Advanced row's one line (TSK-95, the mockup's "values, updates, messages · subgraphs off · no
 * interrupts"), and what in the fold stops a run, so a folded problem still shows.
 */
export function advancedSummary(o: AdvancedOptions): { text: string; problem: string | null } {
  const before = nodeList(o.before);
  const after = nodeList(o.after);
  const interrupts = [before ? `interrupt before ${before.join(", ")}` : null, after ? `after ${after.join(", ")}` : null].filter(Boolean).join(", ");
  const json = [o.config.trim() !== "" ? "config" : null, o.context.trim() !== "" ? "context" : null].filter(Boolean);
  const parts = [o.modes.length > 0 ? MODES.filter((m) => o.modes.includes(m.id)).map((m) => m.label).join(", ") : "no stream modes", `subgraphs ${o.subgraphs ? "on" : "off"}`, interrupts || "no interrupts", ...(json.length > 0 ? [`${json.join(" and ")} set`] : [])];
  const bad = [!parseJson(o.config).ok ? "Config" : null, !parseJson(o.context).ok ? "Context" : null].filter(Boolean);
  return { text: parts.join(" · "), problem: bad.length > 0 ? `${bad.join(" and ")} ${bad.length > 1 ? "are" : "is"} not valid JSON` : null };
}

/** What the Run screen tells the header. */
interface RunStatus {
  running: boolean;
  canRun: boolean;
  /** A run of this tab to roll back. */
  runId: string | null;
  assistantName: string | null;
  live: LiveState | null;
}
const NO_RUN: RunStatus = { running: false, canRun: false, runId: null, assistantName: null, live: null };

/** What the Run screen does for the tab, the Runs tab and the Edit state sheet. */
type RunActions = Parameters<TabProps["useTabActions"]>[0] & {
  rollback?: () => void;
  /** Opens Resume for the interrupt the thread waits at. */
  resume?: () => void;
  /** Runs on from a checkpoint with no input (Update and continue the run). */
  continueFrom?: (checkpointId: string | null) => void;
  /** Fills the form with a run's assistant, input, config and context (Run again with the same input). */
  prefill?: (run: api.Run, request: api.RunRequest) => void;
};

export function ThreadTab(props: TabProps) {
  const { tab, connId, client, note, useTabActions, profile } = props;
  const toast = useToast();
  const threadId = text(tab.params["threadId"]);
  const [view, setView] = useTabView(props, THREAD_VIEWS, "run");
  const [fromCheckpoint, setFromCheckpoint] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const thread = useLoad(connId ? () => client.langgraph.threads.get({ connId, threadId }) : null, [connId, threadId, version], note);
  // The latest checkpoints, for the header's checkpoint and count and for History.
  const history = useLoad(connId ? () => client.langgraph.threads.history({ connId, threadId, limit: HISTORY_PAGE, before: null }) : null, [connId, threadId, version], note);
  // The latest runs, for the header's count and the Runs tab (TSK-96).
  const runs = useLoad(connId ? () => client.langgraph.runs.list({ connId, threadId, limit: RUNS_PAGE, offset: null }) : null, [connId, threadId, version], note);
  // The assistant the Run form uses, its graph and schemas: shared by Run, State, History and Edit state.
  const assistants = useLoad(connId ? () => client.langgraph.assistants.search({ connId, graphId: null, metadata: null, limit: 1000, offset: null }) : null, [connId], note);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  // Default: the thread's assistant, else one of its graph, else the first.
  useEffect(() => {
    if (assistantId || !assistants.data || assistants.data.length === 0) return;
    const meta = (thread.data?.metadata ?? {}) as Record<string, unknown>;
    const pick = assistants.data.find((a) => a.assistantId === meta["assistant_id"]) ?? assistants.data.find((a) => a.graphId === meta["graph_id"]) ?? assistants.data[0]!;
    setAssistantId(pick.assistantId);
  }, [assistants.data, thread.data, assistantId]);
  const graph = useLoad(connId && assistantId ? () => client.langgraph.assistants.graph({ connId, assistantId, xray: true }) : null, [connId, assistantId], note);
  const schemas = useLoad(connId && assistantId ? () => client.langgraph.assistants.schemas({ connId, assistantId }) : null, [connId, assistantId], note);
  const graphView = useMemo(() => (graph.data ? toGraphView(graph.data) : null), [graph.data]);
  const nodes = useMemo(() => (graphView?.nodes ?? []).filter((n) => !n.kind || n.kind === "node").map((n) => n.id), [graphView]);
  const assistantNames = useMemo(() => new Map((assistants.data ?? []).map((a) => [a.assistantId, a.name])), [assistants.data]);
  const changed = () => setVersion((v) => v + 1);
  const [status, setStatus] = useState<RunStatus>(NO_RUN);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<DescribedError | null>(null);
  const [editAt, setEditAt] = useState<{ checkpointId: string | null } | null>(null);
  // The Run screen registers the tab's actions; State and History reload with `version`.
  const runActions = useRef<RunActions>({});
  useTabActions({
    primary: () => runActions.current.primary?.(),
    stop: () => runActions.current.stop?.(),
    pause: () => runActions.current.pause?.(),
    clear: () => runActions.current.clear?.(),
    refresh: changed,
  });
  const remove = async () => {
    if (!connId) return;
    try {
      await client.langgraph.threads.delete({ connId, threadId });
      setDeleting(false);
      toast.add({ title: `Thread ${shortId(threadId)} deleted`, type: "success" });
      // The thread is gone: this tab goes back to the list of threads.
      const place = { kind: "langgraph.threads", params: {}, title: `Threads · ${profile.name}` };
      if (props.navigate) props.navigate(place, { replace: true });
      else props.openTab(place);
    } catch (e) {
      setDeleting(false);
      setDeleteError(note(e));
    }
  };
  const checkpoint = history.data?.items[0]?.checkpointId ?? null;
  const count = history.data ? `${history.data.items.length}${history.data.next ? "+" : ""}` : null;
  const runCount = runs.data ? `${runs.data.items.length}${runs.data.next !== undefined && runs.data.next !== null ? "+" : ""}` : null;
  const assistantName = status.assistantName ?? (assistantId ? (assistantNames.get(assistantId) ?? null) : null);
  return (
    <Page>
      <PageHeader
        title={<span className="font-mono">{shortId(threadId)}</span>}
        adornment={
          <>
            <CopyButton value={threadId} what="thread ID" />
            {thread.data ? <StatusBadge status={thread.data.status} /> : null}
            {/* While a run streams (an ended run's reason is in the status bar). */}
            {status.live && status.live.status !== "ended" ? <LiveBadge live={status.live} unit="events/s" /> : null}
          </>
        }
        subtitle={
          <>
            {profile.name}
            {assistantName ? (
              <>
                {" "}
                · assistant <span className="text-body-1-strong text-fg">{assistantName}</span>
              </>
            ) : null}
            {checkpoint ? (
              <>
                {" "}
                · checkpoint <span className="font-mono">{shortId(checkpoint)}</span> <CopyButton value={checkpoint} what="checkpoint ID" />
              </>
            ) : null}
            {count !== null ? ` · ${count} checkpoint${count === "1" ? "" : "s"}` : null}
            {runCount !== null ? ` · ${runCount} run${runCount === "1" ? "" : "s"}` : null}
            {thread.data?.updatedAt ? (
              <>
                {" "}
                · updated <RelativeTime date={thread.data.updatedAt} />
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <Button disabled={!status.running} onClick={() => runActions.current.stop?.()}>
              <Icon icon={Stop} /> Stop
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton appearance="subtle" aria-label="More actions" />}>
                <Icon icon={MoreHorizontal} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem disabled={status.runId === null} onClick={() => runActions.current.rollback?.()}>
                  <Icon icon={ArrowUndo} /> Roll back the run…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger disabled={!connId} onClick={() => setDeleting(true)}>
                  <Icon icon={Delete} /> Delete thread…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            {/* No key hint drawn by the button (DOC-21 §3.4): the binding is in its tooltip and the palette. */}
            <Tooltip>
              <TooltipTrigger render={<Button appearance="primary" disabled={status.running || !status.canRun} aria-keyshortcuts={ariaBindingOf("primary")} onClick={() => runActions.current.primary?.()} />}>
                <Icon icon={Play} /> Run
              </TooltipTrigger>
              <TooltipContent>
                Run the graph <TooltipShortcut>{bindingOf("primary")}</TooltipShortcut>
              </TooltipContent>
            </Tooltip>
          </>
        }
      />
      {thread.error ? <ErrorState error={thread.error} onRetry={changed} onRefresh={changed} /> : null}
      {deleteError ? <ErrorState error={deleteError} onRetry={() => setDeleteError(null)} /> : null}
      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Thread views" className="px-inset-lg">
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="state">State</TabsTrigger>
          <TabsTrigger value="history">History {count !== null ? <span className="text-body-1 text-fg-muted">{count}</span> : null}</TabsTrigger>
          <TabsTrigger value="runs">Runs {runCount !== null ? <span className="text-body-1 text-fg-muted">{runCount}</span> : null}</TabsTrigger>
        </TabsList>
        <TabsContent value="run" keepMounted className="flex min-h-0 flex-1 flex-col p-0">
          <RunPanel
            {...props}
            active={props.active && view === "run"}
            threadId={threadId}
            thread={thread.data}
            actions={runActions}
            onStatus={setStatus}
            fromCheckpoint={fromCheckpoint}
            clearCheckpoint={() => setFromCheckpoint(null)}
            onRunEnded={changed}
            assistants={assistants}
            assistantId={assistantId}
            onAssistant={setAssistantId}
            graph={graph}
            graphView={graphView}
            schemas={schemas}
            runs={runs.data?.items ?? []}
          />
        </TabsContent>
        <TabsContent value="state" className="flex min-h-0 flex-1 flex-col overflow-auto p-0">
          <StatePanel {...props} threadId={threadId} version={version} onEdit={() => setEditAt({ checkpointId: null })} />
        </TabsContent>
        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col p-0">
          <HistoryPanel
            {...props}
            threadId={threadId}
            history={history}
            graph={graphView}
            onFork={(checkpointId) => setEditAt({ checkpointId })}
            onRunFrom={(checkpointId) => {
              setFromCheckpoint(checkpointId);
              setView("run");
            }}
          />
        </TabsContent>
        <TabsContent value="runs" className="flex min-h-0 flex-1 flex-col p-0">
          <RunsPanel
            {...props}
            threadId={threadId}
            first={runs}
            checkpoints={history.data?.items ?? []}
            assistantNames={assistantNames}
            onChanged={changed}
            onResume={() => {
              setView("run");
              runActions.current.resume?.();
            }}
            onRunAgain={(run, request) => {
              setView("run");
              runActions.current.prefill?.(run, request);
            }}
          />
        </TabsContent>
      </Tabs>
      <EditStateSheet
        at={editAt}
        onClose={() => setEditAt(null)}
        threadId={threadId}
        connId={connId}
        client={client}
        note={note}
        checkpoints={history.data?.items ?? []}
        nodes={nodes}
        stateSchema={schemas.data?.stateSchema}
        onSaved={(checkpointId, continueRun) => {
          changed();
          if (continueRun) {
            setView("run");
            runActions.current.continueFrom?.(checkpointId);
          }
        }}
      />
      <AlertDialog open={deleting} onOpenChange={(o) => !o && setDeleting(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete thread {shortId(threadId)} on {profile.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>The thread, its checkpoints and its runs are deleted on the server.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance="danger" onClick={() => void remove()}>
              Delete thread
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

/** The Advanced row of the Run form: one line that says what is set, the options under it. */
function AdvancedFold({ summary, problem, open, onOpenChange, children }: { summary: string; problem: string | null; open: boolean; onOpenChange(open: boolean): void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-stack-md">
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => onOpenChange(!open)} className={cn("flex items-start gap-inline-sm rounded-sm text-start text-body-1 text-fg-muted", focusRing)}>
        <Icon icon={open ? ChevronDown : ChevronRight} className="mt-stack-xs shrink-0" />
        <span>
          <span className="text-body-1-strong text-fg">Advanced</span> · {summary}
          {problem ? <span className="block text-danger-fg">{problem}</span> : null}
        </span>
      </button>
      {open ? (
        <div id={id} role="group" aria-label="Advanced run options" className="flex flex-col gap-stack-md">
          {children}
        </div>
      ) : null}
    </div>
  );
}

/** "Refund 129.90 EUR…?" from an interrupt's value: a string, or the question an object carries. */
export function interruptQuestion(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    for (const key of ["question", "message", "prompt", "description"]) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === "string" && v !== "") return v;
    }
  }
  return preview(value);
}

interface PanelProps extends TabProps {
  threadId: string;
}

// ---- Run --------------------------------------------------------------------------------------

interface RunPanelProps extends PanelProps {
  /** The tab is shown and this is its view: a hidden run keeps its stream but reads no more of it (TSK-107). */
  active: boolean;
  thread: api.Thread | null;
  actions: { current: RunActions };
  onStatus: (status: RunStatus) => void;
  fromCheckpoint: string | null;
  clearCheckpoint: () => void;
  onRunEnded: () => void;
  assistants: ReturnType<typeof useLoad<api.Assistant[]>>;
  assistantId: string | null;
  onAssistant: (assistantId: string) => void;
  graph: ReturnType<typeof useLoad<api.AssistantGraph>>;
  graphView: ReturnType<typeof toGraphView> | null;
  schemas: ReturnType<typeof useLoad<api.AssistantSchemas>>;
  /** The thread's runs (the Runs tab's first page), for the events view's run picker. */
  runs: readonly api.Run[];
}


interface Running {
  cancel(): void;
  pause(on: boolean): void;
  paused(): boolean;
}

function RunPanel({ tab, threadId, connId, client, note, onLive, actions, onStatus, fromCheckpoint, clearCheckpoint, onRunEnded, active, assistants, assistantId, onAssistant: setAssistantId, graph, graphView, schemas, runs }: RunPanelProps) {
  const gate = useActiveGate(active);
  const toast = useToast();

  // An input handed over by the tab ("Start a thread with it", TSK-96), else the schema's default.
  const [input, setInput] = useState<string | null>(typeof tab.params["input"] === "string" ? tab.params["input"] : null);
  useEffect(() => {
    if (input !== null) return;
    if (schemas.data) setInput(defaultInput(schemas.data.inputSchema));
    else if (schemas.error) setInput("{}");
  }, [schemas.data, schemas.error, input]);
  const [modes, setModes] = useState<ModeId[]>(["values", "updates", "messages"]);
  const [subgraphs, setSubgraphs] = useState(true);
  const [before, setBefore] = useState("");
  const [after, setAfter] = useState("");
  const [run, setRun] = useState<RunView>(EMPTY_RUN);
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  // The run's config and context (TSK-93): optional JSON, checked against the assistant's schemas.
  const [configText, setConfigText] = useState("");
  const [contextText, setContextText] = useState("");
  const [eventsView, setEventsView] = useState<"messages" | "events">("messages");
  // The run the events view shows: this tab's run, or one of the thread's (its checkpoints).
  const [picked, setPicked] = useState<string>(THIS_RUN);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [resuming, setResuming] = useState(false);
  // The nodes the thread waits at (the state's `next`), for the interrupt callout.
  const [waitingAt, setWaitingAt] = useState<readonly string[]>([]);
  const running = useRef<Running | null>(null);
  const viewRef = useRef<RunView>(EMPTY_RUN);
  /** A run the stream lost (the connection dropped): joined again once connected. */
  const lost = useRef<{ runId: string; lastEventId?: string } | null>(null);

  const report = (next: LiveState | null) => {
    setLive(next);
    onLive(next);
  };
  const apply = (events: RunEvent[]) => {
    let v = viewRef.current;
    for (const e of events) v = reduceRun(v, e);
    viewRef.current = v;
    setRun(v);
  };

  /** Pulls a run stream (start or join) until it ends; Stop, pause and errors as in a live view. */
  const consume = (call: { chunks(): AsyncIterable<Uint8Array>; result: Promise<api.RunStreamSummary>; cancel(): void }) => {
    const iterator = call.chunks()[Symbol.asyncIterator]();
    let paused = false;
    let resume: (() => void) | null = null;
    let received = 0;
    let since = Date.now();
    const decoder = new TextDecoder();
    running.current = {
      cancel: () => {
        call.cancel();
        resume?.();
      },
      pause: (on) => {
        paused = on;
        if (!on) resume?.();
        report(on ? { status: "paused", buffered: viewRef.current.count } : { status: "live" });
      },
      paused: () => paused,
    };
    report({ status: "live" });
    void (async () => {
      try {
        for (;;) {
          if (paused) await new Promise<void>((r) => (resume = r));
          resume = null;
          // Hidden: the run goes on at the server, its events wait in the stream's credits.
          await gate.idle();
          const next = await iterator.next();
          if (next.done) break;
          const events = parseChunk(next.value, decoder);
          // When each event arrived, for the events view's times since the start (TSK-96).
          const now = Date.now();
          for (const e of events) e.at = now;
          received += events.length;
          apply(events);
          const elapsed = (Date.now() - since) / 1000;
          if (elapsed >= 1 && !paused) {
            report({ status: "live", ratePerSec: received / elapsed });
            received = 0;
            since = Date.now();
          }
        }
        const summary = await call.result;
        lost.current = null;
        report({ status: "ended", reason: summary.status });
        await afterRun();
      } catch (e) {
        const d = note(e);
        if (d.code === "Cancelled") report({ status: "ended", reason: "stopped" });
        else {
          const v = viewRef.current;
          // The server or the connection went away mid-run: join it again when connected.
          if (v.runId && (d.code === "Unavailable" || d.code === "Internal" || d.kind === "NotFound")) lost.current = { runId: v.runId, ...(v.lastEventId ? { lastEventId: v.lastEventId } : {}) };
          setError(d);
          report({ status: "ended", reason: d.title });
        }
      } finally {
        running.current = null;
      }
    })();
  };

  /** The state's interrupts (when the stream did not carry them) and the nodes it waits at. */
  const loadWaiting = async () => {
    if (!connId) return;
    try {
      const state = await client.langgraph.threads.state({ connId, threadId, checkpointId: null, subgraphs: null });
      const interrupts = interruptsOf(state);
      setWaitingAt(interrupts.length > 0 ? state.next : []);
      if (interrupts.length > 0 && viewRef.current.interrupts.length === 0) {
        viewRef.current = { ...viewRef.current, interrupts };
        setRun(viewRef.current);
      }
    } catch {
      // The state is a convenience here; the State tab shows its error.
    }
  };
  /** After a run: the interrupts and where it waits, and the thread. */
  const afterRun = async () => {
    onRunEnded();
    await loadWaiting();
  };
  // A thread opened while it waits at an interrupt shows the callout at once (the mockup's frame).
  useEffect(() => {
    void loadWaiting();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per thread and connection
  }, [connId, threadId]);

  /** Starts a run: a new one from the form, a command (resume), or `from` a checkpoint with no input. */
  const start = (command: api.RunCommand | null, from?: { checkpointId: string | null }) => {
    if (!connId || !assistantId || running.current) return;
    const parsed = parseJson(input ?? "");
    if (!command && !from && !canRun) return;
    setError(null);
    viewRef.current = EMPTY_RUN;
    setRun(EMPTY_RUN);
    setWaitingAt([]);
    setPicked(THIS_RUN);
    lost.current = null;
    const streamMode = [...new Set([...MODES.filter((m) => modes.includes(m.id)).map((m) => m.server), "tasks"])];
    const call = client.langgraph.runs.stream(
      {
        connId,
        threadId,
        assistantId,
        input: command || from ? null : ((parsed.ok ? (parsed.value ?? null) : null) as api.JsonValue | null),
        command,
        config: (configParsed.ok ? (configParsed.value ?? null) : null) as api.JsonValue | null,
        context: (contextParsed.ok ? (contextParsed.value ?? null) : null) as api.JsonValue | null,
        checkpointId: from ? from.checkpointId : command ? null : fromCheckpoint,
        streamMode,
        streamSubgraphs: subgraphs,
        interruptBefore: nodeList(before),
        interruptAfter: nodeList(after),
        multitaskStrategy: null,
        streamId: crypto.randomUUID(),
      },
      liveTimeout(api.procedures.langgraph.runs.stream),
    );
    if (!command && !from && fromCheckpoint) clearCheckpoint();
    consume(call);
  };

  const join = (runId: string, lastEventId?: string) => {
    if (!connId || running.current) return;
    setError(null);
    consume(client.langgraph.runs.join({ connId, threadId, runId, lastEventId: lastEventId ?? null, streamId: crypto.randomUUID() }, liveTimeout(api.procedures.langgraph.runs.join)));
  };

  // Connected again after a lost run: join it from the last event seen (spec §2.2, "Recovery").
  useEffect(() => {
    const pending = lost.current;
    if (connId && pending && !running.current) join(pending.runId, pending.lastEventId);
    if (connId === null) running.current?.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the handle changes only
  }, [connId]);
  useEffect(() => () => running.current?.cancel(), []);

  /** Stop: the run itself is interrupted on the server, then its stream ends. */
  const stop = async () => {
    const runId = viewRef.current.runId;
    if (connId && runId && running.current) {
      try {
        await client.langgraph.runs.cancel({ connId, threadId, runId });
      } catch (e) {
        setError(note(e));
      }
    }
    running.current?.cancel();
  };
  const rollback = async () => {
    setRollingBack(false);
    const runId = viewRef.current.runId;
    if (!connId || !runId) return;
    try {
      await client.langgraph.runs.rollback({ connId, threadId, runId });
      running.current?.cancel();
      toast.add({ title: "Run rolled back", description: "The run and its checkpoints were deleted.", type: "success" });
      onRunEnded();
    } catch (e) {
      setError(note(e));
    }
  };

  actions.current = {
    primary: () => start(null),
    stop: () => void stop(),
    pause: () => running.current?.pause(!running.current.paused()),
    clear: () => {
      viewRef.current = EMPTY_RUN;
      setRun(EMPTY_RUN);
    },
    rollback: () => setRollingBack(true),
    resume: () => setResuming(true),
    continueFrom: (checkpointId) => start(null, { checkpointId }),
    prefill: (r, request) => {
      setAssistantId(r.assistantId);
      setInput(request.input === null || request.input === undefined ? "" : pretty(request.input));
      const config = request.config && typeof request.config === "object" ? (request.config as Record<string, unknown>) : null;
      // The server adds its own keys to a run's config; the form keeps what was asked for.
      const configurable = config?.["configurable"] && typeof config["configurable"] === "object" ? Object.fromEntries(Object.entries(config["configurable"] as Record<string, unknown>).filter(([k]) => !k.startsWith("__") && !SERVER_CONFIG_KEYS.has(k))) : null;
      setConfigText(configurable && Object.keys(configurable).length > 0 ? pretty({ configurable }) : "");
      setContextText(request.context ? pretty(request.context) : "");
      if (request.streamMode.length > 0) setModes(MODES.filter((m) => request.streamMode.includes(m.server)).map((m) => m.id));
      toast.add({ title: `The form has run ${shortId(r.runId)}'s input`, description: "Check it, then Run.", type: "info" });
    },
  };

  const isRunning = live?.status === "live" || live?.status === "paused";
  const inputParsed = parseJson(input ?? "");
  // A new run needs an input; continuing from a checkpoint may go without one.
  const inputMissing = inputParsed.ok && inputParsed.value === undefined && !fromCheckpoint;
  const configParsed = parseJson(configText);
  const contextParsed = parseJson(contextText);
  const canRun = input !== null && inputParsed.ok && !inputMissing && configParsed.ok && contextParsed.ok;
  const contextSchema = schemaObject(schemas.data?.contextSchema);
  const assistantName = assistants.data?.find((a) => a.assistantId === assistantId)?.name;
  const shownEvents = run.events.filter((e) => eventName(e.event).mode !== "tasks" || modes.includes("debug"));
  const items = Object.fromEntries((assistants.data ?? []).map((a) => [a.assistantId, `${a.name} · graph ${a.graphId}`]));
  const advanced = advancedSummary({ modes, subgraphs, before, after, config: configText, context: contextText });
  const runnable = Boolean(assistantId) && canRun;
  const runId = run.runId ?? null;
  // The header shows Stop, Run and Roll back from what this screen knows.
  useEffect(() => {
    onStatus({ running: isRunning, canRun: runnable, runId, assistantName: assistantName ?? null, live });
  }, [onStatus, isRunning, runnable, runId, assistantName, live]);
  const waiting = run.interrupts.length > 0 && !isRunning;

  const nodes = (graphView?.nodes ?? []).filter((n) => !n.kind || n.kind === "node").map((n) => n.id);
  const multitask = runs.find((r) => r.runId === runId)?.multitaskStrategy ?? runs[0]?.multitaskStrategy;
  const resumeOptions = [assistantName ? `assistant ${assistantName}` : "the form's assistant", modes.length > 0 ? `stream ${MODES.filter((m) => modes.includes(m.id)).map((m) => m.label).join(", ")}` : "no stream modes", ...(multitask ? [`multitask ${multitask}`] : [])].join(" · ");
  const sheets = (
    <>
      <ResumeSheet open={resuming && waiting} onClose={() => setResuming(false)} threadId={threadId} interrupts={run.interrupts} waitingAt={waitingAt} nodes={nodes} stateSchema={schemas.data?.stateSchema} options={resumeOptions} onResume={(command) => start(command)} />
      <AlertDialog open={rollingBack} onOpenChange={(o) => !o && setRollingBack(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Roll back run {run.runId ? shortId(run.runId) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>The run is stopped and deleted with the checkpoints it wrote. Stop keeps them.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance="danger" onClick={() => void rollback()}>
              Roll back
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
  if (eventsView === "events") {
    return (
      <>
        <EventsView threadId={threadId} events={shownEvents} runId={runId} running={isRunning} runs={runs} picked={picked} onPick={setPicked} onMessages={() => setEventsView("messages")} connId={connId} client={client} note={note} />
        {sheets}
      </>
    );
  }
  return (
    <>
    <Resizable orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={38} minSize={24}>
        <div className="flex h-full min-h-0 flex-col overflow-auto">
          <div className="flex flex-col gap-stack-md px-inset-lg py-inset-md">
            {assistants.error ? <ErrorState error={assistants.error} onRetry={() => void assistants.reload()} /> : null}
            <Field>
              <FieldLabel>Assistant</FieldLabel>
              <Select value={assistantId} onValueChange={(v) => setAssistantId(v as string)} items={items} placeholder="Choose an assistant">
                {(assistants.data ?? []).map((a) => (
                  <SelectItem key={a.assistantId} value={a.assistantId}>
                    {a.name} · graph {a.graphId}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            {fromCheckpoint ? (
              <Alert intent="info">
                <AlertTitle>Run from checkpoint {shortId(fromCheckpoint)}</AlertTitle>
                <AlertDescription>The next run starts from this checkpoint (time travel) and writes a new branch of the history.</AlertDescription>
                <AlertActions>
                  <Button size="small" onClick={clearCheckpoint}>
                    Run from the latest instead
                  </Button>
                </AlertActions>
              </Alert>
            ) : null}
            <JsonField
              label="Input"
              value={input ?? ""}
              onChange={setInput}
              rows={7}
              schema={schemaObject(schemas.data?.inputSchema)}
              schemaLabel={assistantName ? `${assistantName}'s input schema` : "the input schema"}
              onSubmit={() => start(null)}
              description={fromCheckpoint ? "Leave it empty to continue from the checkpoint as it is." : inputMissing ? "A new run needs an input." : "The graph's input as JSON, checked against its input schema (Ctrl+Space suggests). Ctrl+Enter runs."}
            />
            {/* Config and Context sit in the fold (DOC-21 Open question 45: the mockup has no place for them). */}
            <AdvancedFold summary={advanced.text} problem={advanced.problem} open={advancedOpen} onOpenChange={setAdvancedOpen}>
              <JsonField label="Config" value={configText} onChange={setConfigText} rows={3} schema={configSchema(schemas.data?.configSchema)} schemaLabel={assistantName ? `${assistantName}'s config schema` : "the config schema"} onSubmit={() => start(null)} description={`Optional, e.g. {"configurable": {"model": "small"}}; checked against the assistant’s config schema.`} />
              {contextSchema ? <JsonField label="Context" value={contextText} onChange={setContextText} rows={3} schema={contextSchema} schemaLabel={assistantName ? `${assistantName}'s context schema` : "the context schema"} onSubmit={() => start(null)} description="Optional: the graph's runtime context, checked against its context schema." /> : null}
              <fieldset className="flex flex-col gap-stack-xs">
                <legend className="text-body-1-strong text-fg">Stream modes</legend>
                <div className="flex flex-wrap gap-inline-md">
                  {MODES.map((m) => (
                    <label key={m.id} className="flex items-center gap-inline-xs text-body-1 text-fg">
                      <Checkbox checked={modes.includes(m.id)} onCheckedChange={(on) => setModes((list) => (on ? [...list, m.id] : list.filter((x) => x !== m.id)))} />
                      {m.label}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="flex items-center gap-inline-sm text-body-1 text-fg">
                <Switch checked={subgraphs} onCheckedChange={setSubgraphs} />
                Stream subgraphs
              </label>
              <Field>
                <FieldLabel>Interrupt before</FieldLabel>
                <Input value={before} onValueChange={setBefore} placeholder="Node names, comma-separated, or *" />
              </Field>
              <Field>
                <FieldLabel>Interrupt after</FieldLabel>
                <Input value={after} onValueChange={setAfter} placeholder="Node names, comma-separated, or *" />
                <FieldDescription>{graphView ? `Nodes: ${graphView.nodes.filter((n) => !n.kind || n.kind === "node").map((n) => n.id).join(", ")}` : null}</FieldDescription>
              </Field>
            </AdvancedFold>
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={30}>
        <div className="flex h-full min-h-0 flex-col gap-stack-md px-inset-lg py-inset-md">
          {waiting ? (
            <Alert intent="warning">
              <AlertTitle>
                {waitingAt.length > 0 ? `Waiting at ${waitingAt.join(", ")}.` : "Waiting at an interrupt."} <span className="text-body-1 text-fg">The graph asks: {interruptQuestion(run.interrupts[0]!.value)}</span>
                {run.interrupts.length > 1 ? <span className="text-body-1 text-fg"> (and {run.interrupts.length - 1} more)</span> : null}
              </AlertTitle>
              <AlertDescription>Resume with a value, update the state and continue, or go to another node.</AlertDescription>
              <AlertActions>
                <Button appearance="secondary" onClick={() => setResuming(true)}>
                  Resume…
                </Button>
              </AlertActions>
            </Alert>
          ) : null}
          {error ? <ErrorState error={error} onRetry={() => (lost.current ? join(lost.current.runId, lost.current.lastEventId) : start(null))} /> : null}
          {run.error ? (
            <Alert intent="danger">
              <AlertTitle>The run failed</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          ) : null}
          {graph.error ? <ErrorState error={graph.error} onRetry={() => void graph.reload()} /> : null}
          {graphView && graphView.nodes.length > 0 ? <GraphView aria-label="Run graph" nodes={graphView.nodes} edges={graphView.edges} groups={graphView.groups} activeIds={run.active} visitedIds={run.visited} className="h-panel-sm shrink-0" /> : null}
          {/* Events opens the full-width events view (TSK-96, the mockup's langgraph-run-events). */}
          <Tabs value="messages" onValueChange={(v) => v === "events" && setEventsView("events")} size="small" className="flex min-h-0 flex-1 flex-col">
            <TabsList aria-label="Run output">
              <TabsTrigger value="messages">
                Messages <span className="text-fg-muted">{run.messages.length}</span>
              </TabsTrigger>
              <TabsTrigger value="events">
                Events <span className="text-fg-muted">{run.count}</span>
              </TabsTrigger>
            </TabsList>
            <TabsContent value="messages" className="min-h-0 flex-1 overflow-auto">
              {run.messages.length === 0 ? (
                <EmptyLine>{isRunning ? "Waiting for messages…" : "No messages yet. Run the graph (Ctrl+Enter)."}</EmptyLine>
              ) : (
                <ol aria-label="Messages" className="flex flex-col gap-stack-sm p-inset-xs">
                  {run.messages.map((m) => (
                    <li key={m.id} className={m.role === "human" ? "self-end rounded-lg bg-accent-subtle p-inset-xs text-body-1 text-fg" : "rounded-lg bg-layer-alt p-inset-xs text-body-1 text-fg"}>
                      <div className="flex items-center gap-inline-xs text-caption-1 text-fg-muted">
                        <span>{m.role}</span>
                        {m.node ? <Badge appearance="tint" variant="neutral">{m.node}</Badge> : null}
                      </div>
                      {m.text ? <p className="whitespace-pre-wrap">{m.text}</p> : null}
                      {m.toolCalls.map((c, i) => (
                        <p key={i} className="font-mono text-code text-fg-muted">
                          {c.name}({preview(c.args)})
                        </p>
                      ))}
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </ResizablePanel>
    </Resizable>
    {sheets}
    </>
  );
}
