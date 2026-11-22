// A thread's History (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-thread-history, TSK-96): the
// checkpoints newest first with a Source filter and the count of branches, Fork from here and Run
// from here; the selected checkpoint against its parent ("What changed since step N"), its full
// state, or the graph lit at that step.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GraphView } from "@/components/ui/graph-view";
import { Icon } from "@/components/ui/icon";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, PageBar, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { diffLines, stableJson } from "@/lib/diff";
import { formatShortTime, formatTime } from "@/lib/time";
import { Edit, History } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { sizeText } from "./cut-value";
import { DiffView } from "./diff-view";
import { branchCount, sourceOf, stepNodes, stepOf, wroteLabel } from "./state-diff";
import { StateDetails } from "./thread-state";
import { type toGraphView, useLoad } from "./shared";

/** Checkpoints per page of History; the header's count says "50+" past one page. */
export const HISTORY_PAGE = 50;

const SOURCES = { any: "Source: Any", input: "Source: input", loop: "Source: loop", update: "Source: update", fork: "Source: fork" } as const;
type SourceFilter = keyof typeof SOURCES;

type Pane = "diff" | "state" | "graph";

/** input, update and fork as badges; loop, the common case, plain (the mockup's). */
function SourceCell({ source }: { source: string }) {
  if (source === "loop" || source === "") return <>{source}</>;
  const variant = source === "update" ? "warning" : source === "fork" ? "info" : "neutral";
  return (
    <Badge appearance="tint" variant={variant}>
      {source}
    </Badge>
  );
}

export interface HistoryPanelProps extends TabProps {
  threadId: string;
  history: ReturnType<typeof useLoad<api.ThreadHistoryPage>>;
  graph: ReturnType<typeof toGraphView> | null;
  onFork: (checkpointId: string) => void;
  onRunFrom: (checkpointId: string) => void;
}

export function HistoryPanel({ threadId, connId, client, note, history, graph, onFork, onRunFrom }: HistoryPanelProps) {
  const [older, setOlder] = useState<api.ThreadState[]>([]);
  // Where the next page starts: the first page's, then each older page's (TSK-108: pages are cut by bytes).
  const [olderNext, setOlderNext] = useState<{ token: string | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => {
    setOlder([]);
    setOlderNext(null);
  }, [history.data]);
  const all = useMemo(() => [...(history.data?.items ?? []), ...older], [history.data, older]);
  const byId = useMemo(() => new Map(all.flatMap((s) => (s.checkpointId ? [[s.checkpointId, s] as const] : []))), [all]);
  const next = olderNext ? olderNext.token : (history.data?.next ?? null);
  const [source, setSource] = useState<SourceFilter>("any");
  const [selected, setSelected] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("diff");
  const [error, setError] = useState<DescribedError | null>(null);
  const shown = source === "any" ? all : all.filter((s) => sourceOf(s) === source);
  const current = all.find((s) => s.checkpointId === selected) ?? shown[0] ?? null;
  const loadOlder = async () => {
    if (!connId || !next) return;
    setLoadingOlder(true);
    try {
      const more = await client.langgraph.threads.history({ connId, threadId, limit: HISTORY_PAGE, before: next });
      setOlder((o) => [...o, ...more.items]);
      setOlderNext({ token: more.next ?? null });
    } catch (e) {
      setError(note(e));
    } finally {
      setLoadingOlder(false);
    }
  };
  const count = `${all.length}${next ? "+" : ""}`;
  const branches = branchCount(all);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="History filters" className="pb-stack-sm">
        <Select aria-label="Source" value={source} onValueChange={(v) => setSource(v as SourceFilter)} items={SOURCES}>
          {Object.entries(SOURCES).map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <span className="text-body-1 text-fg-muted">
          {count} checkpoint{count === "1" ? "" : "s"} · {branches} branch{branches === 1 ? "" : "es"}
        </span>
        <span className="flex-1" />
        <Button disabled={!current?.checkpointId} onClick={() => current?.checkpointId && onFork(current.checkpointId)}>
          <Icon icon={Edit} /> Fork from here
        </Button>
        <Button appearance="primary" disabled={!current?.checkpointId} onClick={() => current?.checkpointId && onRunFrom(current.checkpointId)}>
          <Icon icon={History} /> Run from here
        </Button>
      </PageBar>
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {history.error ? <ErrorState error={history.error} onRetry={() => void history.reload()} onRefresh={() => void history.reload()} /> : null}
      {history.loading && !history.data ? <LoadingRows label="Loading the history" /> : null}
      {history.data && all.length === 0 ? <EmptyLine>No checkpoints yet: run the thread.</EmptyLine> : null}
      {all.length > 0 ? (
        <Resizable orientation="horizontal" className="min-h-0 flex-1 border-t border-border-subtle">
          <ResizablePanel defaultSize={64} minSize={35}>
            <div className="flex h-full min-h-0 flex-col overflow-auto">
              <Table aria-label="Checkpoints" className={gutterTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-end">Step</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Wrote</TableHead>
                    <TableHead>Next</TableHead>
                    <TableHead>Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((s, i) => {
                    const parent = s.parentCheckpointId ? byId.get(s.parentCheckpointId) : undefined;
                    return (
                      <TableRow key={s.checkpointId ?? i} data-selected={s === current ? "" : undefined} aria-selected={s === current} onClick={() => s.checkpointId && setSelected(s.checkpointId)}>
                        <TableCell className="text-end tabular-nums">{stepOf(s) ?? ""}</TableCell>
                        <TableCell>
                          <SourceCell source={sourceOf(s)} />
                        </TableCell>
                        <TableCell className="font-mono text-code">
                          <button type="button" className="text-start" onClick={() => s.checkpointId && setSelected(s.checkpointId)} title={s.checkpointId}>
                            {wroteLabel(s, parent, byId)}
                          </button>
                        </TableCell>
                        <TableCell className="font-mono text-code text-fg-muted">{s.next.length > 0 ? s.next.join(", ") : s.interrupts.length > 0 ? "interrupt" : "—"}</TableCell>
                        <TableCell title={formatTime(s.createdAt ?? undefined)}>{formatShortTime(s.createdAt ?? undefined)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {shown.length === 0 ? <EmptyLine>No {source} checkpoints among those loaded.</EmptyLine> : null}
              {next ? (
                <div className="px-inset-lg py-stack-sm">
                  <Button size="small" loading={loadingOlder} onClick={() => void loadOlder()}>
                    Load older checkpoints
                  </Button>
                </div>
              ) : null}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={25}>
            <div className="h-full overflow-auto px-inset-lg py-inset-md">
              {current ? <CheckpointPane state={current} parent={current.parentCheckpointId ? byId.get(current.parentCheckpointId) : undefined} pane={pane} onPane={setPane} graph={graph} connId={connId} threadId={threadId} client={client} note={note} /> : null}
            </div>
          </ResizablePanel>
        </Resizable>
      ) : null}
    </div>
  );
}

/** "Step 13 · draft_reply": what the selected checkpoint changed, its state, or its step on the graph. */
function CheckpointPane({ state, parent, pane, onPane, graph, connId, threadId, client, note }: { state: api.ThreadState; parent: api.ThreadState | undefined; pane: Pane; onPane: (p: Pane) => void; graph: ReturnType<typeof toGraphView> | null; threadId: string } & Pick<TabProps, "connId" | "client" | "note">) {
  // The parent may be older than the pages loaded: read it.
  const parentId = state.parentCheckpointId ?? null;
  const fetched = useLoad(connId && parentId && !parent && pane === "diff" ? () => client.langgraph.threads.state({ connId, threadId, checkpointId: parentId, subgraphs: null }) : null, [connId, threadId, parentId, Boolean(parent), pane], note);
  const before = parent ?? fetched.data ?? null;
  const step = stepOf(state);
  const nodes = stepNodes(state, before ?? undefined);
  const title = `Step ${step ?? "?"}${nodes.length > 0 ? ` · ${nodes.join(", ")}` : ""}`;
  const beforeStep = before ? stepOf(before) : null;
  return (
    <section aria-label={title} className="flex flex-col gap-stack-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="flex items-center gap-inline-sm text-subtitle-2 text-fg">
          {title}
          {state.checkpointId ? <CopyButton value={state.checkpointId} what="checkpoint ID" /> : null}
        </h3>
        <p className="text-body-1 text-fg-muted">{parentId ? `What changed since step ${beforeStep ?? "?"}` : "The thread's first checkpoint"}</p>
      </div>
      <ToggleGroup aria-label="Show" size="small" value={[pane]} onValueChange={(v) => v[0] && onPane(v[0] as Pane)}>
        <ToggleGroupItem value="diff">Diff</ToggleGroupItem>
        <ToggleGroupItem value="state">Full state</ToggleGroupItem>
        <ToggleGroupItem value="graph">Graph</ToggleGroupItem>
      </ToggleGroup>
      {pane === "diff" ? <CheckpointDiff state={state} parent={before} loading={fetched.loading} error={fetched.error} /> : null}
      {pane === "state" ? <StateDetails state={state} connId={connId} threadId={threadId} client={client} note={note} /> : null}
      {pane === "graph" ? graph && graph.nodes.length > 0 ? <GraphView aria-label={`The graph at step ${step ?? "?"}`} nodes={graph.nodes} edges={graph.edges} groups={graph.groups} activeIds={nodes} visitedIds={[]} className="h-panel-sm" /> : <EmptyLine>The assistant's graph is not loaded.</EmptyLine> : null}
      <p className="flex flex-wrap items-center gap-inline-xs text-caption-1 text-fg-muted">
        Next:{" "}
        {state.next.length > 0
          ? state.next.map((n) => (
              <Badge key={n} appearance="tint" variant={state.interrupts.length > 0 ? "warning" : "neutral"}>
                {n}
              </Badge>
            ))
          : "nothing (the graph ended here)"}
        {beforeStep !== null ? <span>· parent step {beforeStep}</span> : null}
      </p>
    </section>
  );
}

/** The values against the parent's; a value left out for its size is compared by size only. */
function CheckpointDiff({ state, parent, loading, error }: { state: api.ThreadState; parent: api.ThreadState | null; loading: boolean; error: DescribedError | null }) {
  const lines = useMemo(() => (parent && state.values !== null && parent.values !== null ? diffLines(stableJson(parent.values ?? {}), stableJson(state.values ?? {})) : null), [state, parent]);
  if (!state.parentCheckpointId) return <DiffView label="Values" lines={diffLines("{}", stableJson(state.values ?? {}))} />;
  if (error) return <p className="text-body-1 text-danger-fg">The parent checkpoint could not be read: {error.title}</p>;
  if (!parent) return loading ? <LoadingRows label="Loading the parent checkpoint" /> : null;
  if (lines === null) {
    const size = (s: api.ThreadState) => {
      const cut = s.cuts.find((c) => c.field === "values");
      return cut ? sizeText(cut.bytes) : "small";
    };
    return <p className="text-body-1 text-fg-muted">The values were left out for their size ({size(parent)} → {size(state)}): open Full state to load them.</p>;
  }
  if (lines.every((l) => l.kind === "same")) return <p className="text-body-1 text-fg-muted">The values did not change in this step.</p>;
  return <DiffView label="What changed" lines={lines} />;
}
