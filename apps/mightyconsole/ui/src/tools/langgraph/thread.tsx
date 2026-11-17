// A thread (spec §11.2): Run (input, stream modes, live events beside the GraphView with the
// running node lit, chat messages, the interrupt and its Resume form, Stop and Rollback, joining
// the run again after a reconnect), State (current values, next nodes, tasks; Edit state) and
// History (checkpoints; Fork from here, Run from here).
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { GraphView } from "@/components/ui/graph-view";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { JsonViewer } from "@/components/ui/json-viewer";
import { RelativeTime } from "@/components/ui/relative-time";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { liveTimeout } from "@/app/client";
import { EmptyLine, ErrorState, LiveBadge, LoadingRows } from "@/app/states";
import * as api from "@/gen/api";
import { ArrowClockwise, ArrowUndo, Edit, History, Play, Stop } from "@/lib/icons";
import type { DescribedError, LiveState, TabProps } from "../types";
import { EMPTY_RUN, type RunEvent, type RunInterrupt, type RunView, eventName, interruptsOf, parseChunk, reduceRun } from "./run-events";
import { JsonField, StatusBadge, parseJson, preview, shortId, toGraphView, useLoad } from "./shared";

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

export function ThreadTab(props: TabProps) {
  const { tab, connId, client, note, useTabActions } = props;
  const threadId = text(tab.params["threadId"]);
  const [view, setView] = useState<"run" | "state" | "history">("run");
  const [fromCheckpoint, setFromCheckpoint] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const thread = useLoad(connId ? () => client.langgraph.threads.get({ connId, threadId }) : null, [connId, threadId, version], note);
  const changed = () => setVersion((v) => v + 1);
  // The Run screen registers the tab's actions; State and History reload with `version`.
  const runActions = useRef<Parameters<TabProps["useTabActions"]>[0]>({});
  useTabActions({
    primary: () => runActions.current.primary?.(),
    stop: () => runActions.current.stop?.(),
    pause: () => runActions.current.pause?.(),
    clear: () => runActions.current.clear?.(),
    refresh: changed,
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-inline-sm px-inset-sm pt-inset-xs text-caption-1 text-fg-muted">
        <span className="font-mono">{threadId}</span>
        {thread.data ? <StatusBadge status={thread.data.status} /> : null}
      </div>
      {thread.error ? <ErrorState error={thread.error} onRetry={changed} onRefresh={changed} /> : null}
      <Tabs value={view} onValueChange={(v) => setView(v as typeof view)} className="flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Thread views">
          <TabsTrigger value="run">Run</TabsTrigger>
          <TabsTrigger value="state">State</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="run" keepMounted className="flex min-h-0 flex-1 flex-col p-0">
          <RunPanel {...props} threadId={threadId} thread={thread.data} actions={runActions} fromCheckpoint={fromCheckpoint} clearCheckpoint={() => setFromCheckpoint(null)} onRunEnded={changed} />
        </TabsContent>
        <TabsContent value="state" className="flex min-h-0 flex-1 flex-col overflow-auto p-0">
          <StatePanel {...props} threadId={threadId} version={version} onChanged={changed} />
        </TabsContent>
        <TabsContent value="history" className="flex min-h-0 flex-1 flex-col p-0">
          <HistoryPanel
            {...props}
            threadId={threadId}
            version={version}
            onChanged={changed}
            onRunFrom={(checkpointId) => {
              setFromCheckpoint(checkpointId);
              setView("run");
            }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

interface PanelProps extends TabProps {
  threadId: string;
}

// ---- Run --------------------------------------------------------------------------------------

interface RunPanelProps extends PanelProps {
  thread: api.Thread | null;
  actions: { current: Parameters<TabProps["useTabActions"]>[0] };
  fromCheckpoint: string | null;
  clearCheckpoint: () => void;
  onRunEnded: () => void;
}

type ResumeMode = "resume" | "update" | "goto";

interface Running {
  cancel(): void;
  pause(on: boolean): void;
  paused(): boolean;
}

function RunPanel({ threadId, thread, connId, client, note, onLive, actions, fromCheckpoint, clearCheckpoint, onRunEnded }: RunPanelProps) {
  const toast = useToast();
  const assistants = useLoad(connId ? () => client.langgraph.assistants.search({ connId, graphId: null, metadata: null, limit: 1000, offset: null }) : null, [connId], note);
  const [assistantId, setAssistantId] = useState<string | null>(null);
  // Default: the thread's assistant, else one of its graph, else the first.
  useEffect(() => {
    if (assistantId || !assistants.data || assistants.data.length === 0) return;
    const meta = (thread?.metadata ?? {}) as Record<string, unknown>;
    const pick = assistants.data.find((a) => a.assistantId === meta["assistant_id"]) ?? assistants.data.find((a) => a.graphId === meta["graph_id"]) ?? assistants.data[0]!;
    setAssistantId(pick.assistantId);
  }, [assistants.data, thread, assistantId]);
  const graph = useLoad(connId && assistantId ? () => client.langgraph.assistants.graph({ connId, assistantId, xray: true }) : null, [connId, assistantId], note);
  const schemas = useLoad(connId && assistantId ? () => client.langgraph.assistants.schemas({ connId, assistantId }) : null, [connId, assistantId], note);
  const graphView = useMemo(() => (graph.data ? toGraphView(graph.data) : null), [graph.data]);

  const [input, setInput] = useState<string | null>(null);
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
  const [resumeMode, setResumeMode] = useState<ResumeMode>("resume");
  const [resumeText, setResumeText] = useState('"approved"');
  const [gotoNode, setGotoNode] = useState<string | null>(null);
  const [eventsView, setEventsView] = useState<"messages" | "events">("messages");
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
          const next = await iterator.next();
          if (next.done) break;
          const events = parseChunk(next.value, decoder);
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

  /** After a run: the interrupts from the state when the stream did not carry them, and the thread. */
  const afterRun = async () => {
    onRunEnded();
    if (!connId || viewRef.current.interrupts.length > 0) return;
    try {
      const state = await client.langgraph.threads.state({ connId, threadId, checkpointId: null, subgraphs: null });
      const interrupts = interruptsOf(state);
      if (interrupts.length > 0) {
        viewRef.current = { ...viewRef.current, interrupts };
        setRun(viewRef.current);
      }
    } catch {
      // The state is a convenience here; the State tab shows its error.
    }
  };

  const start = (command: api.RunCommand | null) => {
    if (!connId || !assistantId || running.current) return;
    const parsed = parseJson(input ?? "");
    if (!command && !canRun) return;
    setError(null);
    viewRef.current = EMPTY_RUN;
    setRun(EMPTY_RUN);
    lost.current = null;
    const streamMode = [...new Set([...MODES.filter((m) => modes.includes(m.id)).map((m) => m.server), "tasks"])];
    const call = client.langgraph.runs.stream(
      {
        connId,
        threadId,
        assistantId,
        input: command ? null : ((parsed.ok ? (parsed.value ?? null) : null) as api.JsonValue | null),
        command,
        config: null,
        context: null,
        checkpointId: command ? null : fromCheckpoint,
        streamMode,
        streamSubgraphs: subgraphs,
        interruptBefore: nodeList(before),
        interruptAfter: nodeList(after),
        multitaskStrategy: null,
        streamId: crypto.randomUUID(),
      },
      liveTimeout(api.procedures.langgraph.runs.stream),
    );
    if (!command && fromCheckpoint) clearCheckpoint();
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

  const resumeCommand = (): api.RunCommand | null => {
    if (resumeMode === "goto") return gotoNode ? { resume: null, update: null, goto: gotoNode } : null;
    const parsed = parseJson(resumeText);
    if (!parsed.ok || parsed.value === undefined) return null;
    return resumeMode === "resume" ? { resume: parsed.value as api.JsonValue, update: null, goto: null } : { resume: null, update: parsed.value as api.JsonValue, goto: null };
  };

  actions.current = {
    primary: () => start(null),
    stop: () => void stop(),
    pause: () => running.current?.pause(!running.current.paused()),
    clear: () => {
      viewRef.current = EMPTY_RUN;
      setRun(EMPTY_RUN);
    },
  };

  const isRunning = live?.status === "live" || live?.status === "paused";
  const inputParsed = parseJson(input ?? "");
  // A new run needs an input; continuing from a checkpoint may go without one.
  const inputMissing = inputParsed.ok && inputParsed.value === undefined && !fromCheckpoint;
  const canRun = input !== null && inputParsed.ok && !inputMissing;
  const shownEvents = run.events.filter((e) => eventName(e.event).mode !== "tasks" || modes.includes("debug"));
  const items = Object.fromEntries((assistants.data ?? []).map((a) => [a.assistantId, `${a.name} (${a.graphId})`]));

  return (
    <Resizable orientation="horizontal" className="min-h-0 flex-1">
      <ResizablePanel defaultSize={38} minSize={24}>
        <div className="flex h-full min-h-0 flex-col overflow-auto">
          <Toolbar aria-label="Run actions">
            <ToolbarGroup>
              <ToolbarButton render={<Button appearance="primary" disabled={isRunning || !assistantId || !canRun} />} onClick={() => start(null)}>
                <Icon icon={Play} /> Run
              </ToolbarButton>
              <ToolbarButton render={<Button disabled={!isRunning} />} onClick={() => void stop()}>
                <Icon icon={Stop} /> Stop
              </ToolbarButton>
              <ToolbarSeparator />
              <ToolbarButton render={<Button appearance="subtle" disabled={!run.runId} />} onClick={() => setRollingBack(true)}>
                <Icon icon={ArrowUndo} /> Rollback
              </ToolbarButton>
            </ToolbarGroup>
            {live ? <LiveBadge live={live} unit="events/s" /> : null}
          </Toolbar>
          <div className="flex flex-col gap-stack-md p-inset-sm">
            {assistants.error ? <ErrorState error={assistants.error} onRetry={() => void assistants.reload()} /> : null}
            <Field>
              <FieldLabel>Assistant</FieldLabel>
              <Select value={assistantId} onValueChange={(v) => setAssistantId(v as string)} items={items} placeholder="Choose an assistant">
                {(assistants.data ?? []).map((a) => (
                  <SelectItem key={a.assistantId} value={a.assistantId}>
                    {a.name} ({a.graphId})
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
            <JsonField label="Input" value={input ?? ""} onChange={setInput} rows={8} description={fromCheckpoint ? "Leave it empty to continue from the checkpoint as it is." : inputMissing ? "A new run needs an input." : "The graph's input as JSON. Ctrl+Enter runs."} />
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
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={30}>
        <div className="flex h-full min-h-0 flex-col gap-stack-sm p-inset-sm">
          {error ? <ErrorState error={error} onRetry={() => (lost.current ? join(lost.current.runId, lost.current.lastEventId) : start(null))} /> : null}
          {run.error ? (
            <Alert intent="danger">
              <AlertTitle>The run failed</AlertTitle>
              <AlertDescription>{run.error}</AlertDescription>
            </Alert>
          ) : null}
          {run.interrupts.length > 0 && !isRunning ? (
            <Alert intent="warning">
              <AlertTitle>The run is waiting at an interrupt</AlertTitle>
              <AlertDescription>
                {run.interrupts.map((i: RunInterrupt, n) => (
                  <pre key={i.id ?? n} className="max-h-panel-xs overflow-auto font-mono text-code whitespace-pre-wrap">
                    {pretty(i.value)}
                  </pre>
                ))}
              </AlertDescription>
              <div className="flex flex-col gap-stack-sm pt-stack-sm">
                <ToggleGroup aria-label="How to continue" value={[resumeMode]} onValueChange={(v) => v[0] && setResumeMode(v[0] as ResumeMode)}>
                  <ToggleGroupItem value="resume">Resume with a value</ToggleGroupItem>
                  <ToggleGroupItem value="update">Update state and continue</ToggleGroupItem>
                  <ToggleGroupItem value="goto">Go to node</ToggleGroupItem>
                </ToggleGroup>
                {resumeMode === "goto" ? (
                  <Select aria-label="Node" value={gotoNode} onValueChange={(v) => setGotoNode(v as string)} placeholder="Choose a node">
                    {(graphView?.nodes ?? [])
                      .filter((n) => !n.kind || n.kind === "node")
                      .map((n) => (
                        <SelectItem key={n.id} value={n.id}>
                          {n.id}
                        </SelectItem>
                      ))}
                  </Select>
                ) : (
                  <JsonField label={resumeMode === "resume" ? "Value for interrupt()" : "State update"} value={resumeText} onChange={setResumeText} rows={3} />
                )}
                <div>
                  <Button appearance="primary" disabled={resumeCommand() === null} onClick={() => start(resumeCommand())}>
                    Resume
                  </Button>
                </div>
              </div>
            </Alert>
          ) : null}
          {graph.error ? <ErrorState error={graph.error} onRetry={() => void graph.reload()} /> : null}
          {graphView && graphView.nodes.length > 0 ? <GraphView aria-label="Run graph" nodes={graphView.nodes} edges={graphView.edges} groups={graphView.groups} activeIds={run.active} visitedIds={run.visited} className="h-panel-sm shrink-0" /> : null}
          <Tabs value={eventsView} onValueChange={(v) => setEventsView(v as typeof eventsView)} size="small" className="flex min-h-0 flex-1 flex-col">
            <TabsList aria-label="Run output">
              <TabsTrigger value="messages">Messages ({run.messages.length})</TabsTrigger>
              <TabsTrigger value="events">Events ({run.count})</TabsTrigger>
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
                        {m.node ? <Badge variant="neutral">{m.node}</Badge> : null}
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
            <TabsContent value="events" className="min-h-0 flex-1 overflow-auto">
              {shownEvents.length === 0 ? (
                <EmptyLine>No events yet.</EmptyLine>
              ) : (
                <ol aria-label="Events" className="flex flex-col p-inset-xs">
                  {shownEvents.slice(-500).map((e, i) => (
                    <li key={`${e.id ?? ""}-${i}`} className="border-b border-border-subtle py-stack-xs">
                      <details>
                        <summary className="flex cursor-pointer items-center gap-inline-sm text-body-1 text-fg">
                          <Badge variant={eventName(e.event).mode === "error" ? "danger" : "info"}>{e.event}</Badge>
                          <span className="min-w-0 flex-1 truncate font-mono text-code text-fg-muted">{preview(e.data)}</span>
                        </summary>
                        <pre className="max-h-panel-sm overflow-auto font-mono text-code whitespace-pre-wrap text-fg">{pretty(e.data)}</pre>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </ResizablePanel>
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
    </Resizable>
  );
}

// ---- State ------------------------------------------------------------------------------------

function StateDetails({ state }: { state: api.ThreadState }) {
  const meta = (state.metadata ?? {}) as Record<string, unknown>;
  return (
    <div className="flex flex-col gap-stack-md">
      <DescriptionList>
        <DescriptionListItem>
          <DescriptionListTerm>Checkpoint</DescriptionListTerm>
          <DescriptionListDetails className="font-mono text-code">{state.checkpointId ?? "—"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Parent</DescriptionListTerm>
          <DescriptionListDetails className="font-mono text-code">{state.parentCheckpointId ?? "—"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Next</DescriptionListTerm>
          <DescriptionListDetails>{state.next.length > 0 ? state.next.join(", ") : "nothing (the graph ended)"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Step, source</DescriptionListTerm>
          <DescriptionListDetails>
            {String(meta["step"] ?? "—")}, {String(meta["source"] ?? "—")}
          </DescriptionListDetails>
        </DescriptionListItem>
        {state.createdAt ? (
          <DescriptionListItem>
            <DescriptionListTerm>Created</DescriptionListTerm>
            <DescriptionListDetails>
              <RelativeTime date={state.createdAt} />
            </DescriptionListDetails>
          </DescriptionListItem>
        ) : null}
      </DescriptionList>
      {state.tasks.length > 0 ? (
        <section className="flex flex-col gap-stack-xs">
          <h3 className="text-subtitle-2 text-fg">Tasks</h3>
          <ul className="flex flex-col gap-stack-xs">
            {state.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-inline-sm text-body-1 text-fg">
                <Badge variant="neutral">{t.name}</Badge>
                {t.error ? <span className="text-danger-fg">{t.error}</span> : null}
                {t.interrupts.map((i, n) => (
                  <span key={i.id ?? n} className="font-mono text-code text-warning-fg">
                    interrupt {preview(i.value)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <h3 className="text-subtitle-2 text-fg">Values</h3>
      <JsonViewer value={state.values} aria-label="Values" defaultExpandDepth={2} className="h-panel-sm" />
      <h3 className="text-subtitle-2 text-fg">Metadata</h3>
      <JsonViewer value={state.metadata} aria-label="Metadata" className="h-panel-xs" />
    </div>
  );
}

/** Values and the node to write them as: Edit state, and Fork from a checkpoint. */
function UpdateStateDialog({ open, title, description, initial, nodes, onCancel, onSubmit }: { open: boolean; title: string; description: string; initial: string; nodes: readonly string[]; onCancel: () => void; onSubmit: (values: api.JsonValue, asNode: string | null) => Promise<void> }) {
  const [values, setValues] = useState(initial);
  const [asNode, setAsNode] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValues(initial);
      setAsNode("");
    }
  }, [open, initial]);
  const parsed = parseJson(values);
  const submit = async () => {
    if (!parsed.ok || parsed.value === undefined) return;
    setBusy(true);
    try {
      await onSubmit(parsed.value as api.JsonValue, asNode.trim() || null);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <JsonField label="Values" value={values} onChange={setValues} rows={10} description="Written as the node's update: reducers apply (messages are appended)." />
          <Field>
            <FieldLabel>As node</FieldLabel>
            <Input value={asNode} onValueChange={setAsNode} placeholder="The node the update comes from (optional)" />
            <FieldDescription>{nodes.length > 0 ? `The graph continues from its edges. Nodes: ${nodes.join(", ")}` : "The graph continues from its edges."}</FieldDescription>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onCancel}>Cancel</Button>
          <Button appearance="primary" loading={busy} disabled={!parsed.ok || parsed.value === undefined} onClick={() => void submit()}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatePanel({ threadId, connId, client, note, version, onChanged }: PanelProps & { version: number; onChanged: () => void }) {
  const toast = useToast();
  const state = useLoad(connId ? () => client.langgraph.threads.state({ connId, threadId, checkpointId: null, subgraphs: true }) : null, [connId, threadId, version], note);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const save = async (values: api.JsonValue, asNode: string | null) => {
    if (!connId) return;
    try {
      const out = await client.langgraph.threads.updateState({ connId, threadId, values, asNode, checkpointId: null });
      setEditing(false);
      toast.add({ title: "State updated", description: out.checkpointId ? `New checkpoint ${shortId(out.checkpointId)}` : undefined, type: "success" });
      onChanged();
    } catch (e) {
      setError(note(e));
    }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="State actions">
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" loading={state.loading} />} onClick={() => void state.reload()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </ToolbarButton>
          <ToolbarButton render={<Button appearance="subtle" disabled={!state.data} />} onClick={() => setEditing(true)}>
            <Icon icon={Edit} /> Edit state
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {state.error ? <ErrorState error={state.error} onRetry={() => void state.reload()} onRefresh={() => void state.reload()} /> : null}
      {state.loading && !state.data ? <LoadingRows label="Loading the state" /> : null}
      {state.data ? (
        <div className="p-inset-sm">
          <StateDetails state={state.data} />
        </div>
      ) : null}
      <UpdateStateDialog open={editing} title="Edit state" description="Writes a new checkpoint on top of the current one." initial="{}" nodes={state.data?.next ?? []} onCancel={() => setEditing(false)} onSubmit={save} />
    </div>
  );
}

// ---- History ----------------------------------------------------------------------------------

function HistoryPanel({ threadId, connId, client, note, version, onChanged, onRunFrom }: PanelProps & { version: number; onChanged: () => void; onRunFrom: (checkpointId: string) => void }) {
  const toast = useToast();
  const [older, setOlder] = useState<api.ThreadState[]>([]);
  const history = useLoad(connId ? () => client.langgraph.threads.history({ connId, threadId, limit: 50, before: null }) : null, [connId, threadId, version], note);
  useEffect(() => setOlder([]), [history.data]);
  const all = useMemo(() => [...(history.data ?? []), ...older], [history.data, older]);
  const [selected, setSelected] = useState<string | null>(null);
  const [forking, setForking] = useState<api.ThreadState | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const current = all.find((s) => s.checkpointId === selected) ?? all[0] ?? null;
  const loadOlder = async () => {
    const last = all[all.length - 1]?.checkpointId;
    if (!connId || !last) return;
    try {
      const more = await client.langgraph.threads.history({ connId, threadId, limit: 50, before: last });
      setOlder((o) => [...o, ...more]);
    } catch (e) {
      setError(note(e));
    }
  };
  const fork = async (values: api.JsonValue, asNode: string | null) => {
    if (!connId || !forking?.checkpointId) return;
    try {
      const out = await client.langgraph.threads.updateState({ connId, threadId, values, asNode, checkpointId: forking.checkpointId });
      setForking(null);
      toast.add({ title: "Forked", description: out.checkpointId ? `New checkpoint ${shortId(out.checkpointId)}: Run from here to continue the branch.` : undefined, type: "success" });
      onChanged();
      if (out.checkpointId) setSelected(out.checkpointId);
    } catch (e) {
      setError(note(e));
    }
  };
  const meta = (s: api.ThreadState) => (s.metadata ?? {}) as Record<string, unknown>;
  const writes = (s: api.ThreadState) => {
    const w = meta(s)["writes"];
    return w && typeof w === "object" ? Object.keys(w).join(", ") : "";
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="History actions">
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" loading={history.loading} />} onClick={() => void history.reload()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton render={<Button appearance="subtle" disabled={!current?.checkpointId} />} onClick={() => current && setForking(current)}>
            <Icon icon={Edit} /> Fork from here
          </ToolbarButton>
          <ToolbarButton render={<Button appearance="subtle" disabled={!current?.checkpointId} />} onClick={() => current?.checkpointId && onRunFrom(current.checkpointId)}>
            <Icon icon={History} /> Run from here
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {history.error ? <ErrorState error={history.error} onRetry={() => void history.reload()} onRefresh={() => void history.reload()} /> : null}
      {history.loading && !history.data ? <LoadingRows label="Loading the history" /> : null}
      {history.data && all.length === 0 ? <EmptyLine>No checkpoints yet: run the thread.</EmptyLine> : null}
      {all.length > 0 ? (
        <Resizable orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={50} minSize={25}>
            <div className="flex h-full min-h-0 flex-col">
              <Table aria-label="Checkpoints" className="min-h-0 flex-1">
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Writes</TableHead>
                    <TableHead>Next</TableHead>
                    <TableHead>Checkpoint</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {all.map((s, i) => (
                    <TableRow key={s.checkpointId ?? i} data-selected={s === current ? "" : undefined} aria-selected={s === current} onClick={() => s.checkpointId && setSelected(s.checkpointId)}>
                      <TableCell>{String(meta(s)["step"] ?? "")}</TableCell>
                      <TableCell>{String(meta(s)["source"] ?? "")}</TableCell>
                      <TableCell>{writes(s)}</TableCell>
                      <TableCell>{s.next.join(", ")}</TableCell>
                      <TableCell>
                        <Button appearance="transparent" size="small" className="font-mono" onClick={() => s.checkpointId && setSelected(s.checkpointId)} title={s.checkpointId}>
                          {s.checkpointId ? shortId(s.checkpointId) : "—"}
                        </Button>
                      </TableCell>
                      <TableCell>{s.createdAt ? <RelativeTime date={s.createdAt} /> : null}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="p-inset-xs">
                <Button size="small" onClick={() => void loadOlder()}>
                  Load older checkpoints
                </Button>
              </div>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={25}>
            <div className="h-full overflow-auto p-inset-sm">{current ? <StateDetails state={current} /> : null}</div>
          </ResizablePanel>
        </Resizable>
      ) : null}
      <UpdateStateDialog
        open={forking !== null}
        title={`Fork from checkpoint ${forking?.checkpointId ? shortId(forking.checkpointId) : ""}`}
        description="Writes these values on top of that checkpoint: a new branch of the history. Run from here then continues it."
        initial="{}"
        nodes={forking?.next ?? []}
        onCancel={() => setForking(null)}
        onSubmit={fork}
      />
    </div>
  );
}
