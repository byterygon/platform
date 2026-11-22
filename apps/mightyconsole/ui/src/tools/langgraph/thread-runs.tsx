// A thread's Runs (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-runs, Open question 45 (n),
// TSK-96): the runs newest first, by bytes (TSK-108) with Load more; status, assistant, start,
// duration, multitask strategy and a note (a failed run's error, where an interrupted one waits);
// Resume an interrupted run, Cancel a running one; a run's detail with its error, its input, and
// Run again with the same input.
import { useEffect, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { CopyButton, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { formatShortTime, formatTime } from "@/lib/time";
import { Play } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { CutValue, cutOf, loadCut } from "./cut-value";
import { formatDuration, metaOf, runDuration, runNote, stepOf, taskError, waitsAtInterrupt } from "./state-diff";
import { StatusBadge, shortId, useLoad } from "./shared";

/** Runs asked for per page; a page is cut sooner by its bytes. */
export const RUNS_PAGE = 20;

/** The newest checkpoint of each run among those loaded (History's first page). */
export function lastCheckpoints(states: readonly api.ThreadState[]): Map<string, api.ThreadState> {
  const out = new Map<string, api.ThreadState>();
  for (const s of states) {
    const run = metaOf(s)["run_id"];
    // Newest first: the first seen is the run's last.
    if (typeof run === "string" && !out.has(run)) out.set(run, s);
  }
  return out;
}

export interface RunsPanelProps extends TabProps {
  threadId: string;
  /** The first page of runs, loaded by the tab for the header's count. */
  first: ReturnType<typeof useLoad<api.RunsPage>>;
  /** History's first page, for the notes of the runs it covers. */
  checkpoints: readonly api.ThreadState[];
  assistantNames: ReadonlyMap<string, string>;
  onResume: () => void;
  onRunAgain: (run: api.Run, request: api.RunRequest) => void;
  onChanged: () => void;
}

export function RunsPanel({ threadId, connId, client, note, first, checkpoints, assistantNames, onResume, onRunAgain, onChanged }: RunsPanelProps) {
  const toast = useToast();
  const [more, setMore] = useState<api.Run[]>([]);
  const [moreNext, setMoreNext] = useState<{ offset: number | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<api.Run | null>(null);
  useEffect(() => {
    setMore([]);
    setMoreNext(null);
  }, [first.data]);
  const runs = useMemo(() => [...(first.data?.items ?? []), ...more], [first.data, more]);
  const next = moreNext ? moreNext.offset : (first.data?.next ?? null);
  const lasts = useMemo(() => lastCheckpoints(checkpoints), [checkpoints]);
  const loadMore = async () => {
    if (!connId || next === null) return;
    setLoadingMore(true);
    try {
      const page = await client.langgraph.runs.list({ connId, threadId, limit: RUNS_PAGE, offset: next });
      setMore((m) => [...m, ...page.items]);
      setMoreNext({ offset: page.next ?? null });
    } catch (e) {
      setError(note(e));
    } finally {
      setLoadingMore(false);
    }
  };
  const cancel = async (run: api.Run) => {
    setCancelling(null);
    if (!connId) return;
    try {
      await client.langgraph.runs.cancel({ connId, threadId, runId: run.runId });
      toast.add({ title: `Run ${shortId(run.runId)} cancelled`, type: "success" });
      onChanged();
    } catch (e) {
      setError(note(e));
    }
  };
  const current = runs.find((r) => r.runId === selected) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {first.error ? <ErrorState error={first.error} onRetry={() => void first.reload()} onRefresh={() => void first.reload()} /> : null}
      {first.loading && !first.data ? <LoadingRows label="Loading the runs" /> : null}
      {first.data && runs.length === 0 ? <EmptyLine>No runs yet: run the thread.</EmptyLine> : null}
      {runs.length > 0 ? (
        <Table aria-label="Runs" className={gutterTable}>
          <TableHeader>
            <TableRow>
              <TableHead>Run ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Assistant</TableHead>
              <TableHead>Started</TableHead>
              <TableHead className="text-end">Duration</TableHead>
              <TableHead>Multitask</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.runId} data-selected={r === current ? "" : undefined} aria-selected={r === current} onClick={() => setSelected(r.runId)}>
                <TableCell className="font-mono text-code">
                  <span className="flex items-center gap-inline-xs">
                    <button type="button" className="text-accent-fg" onClick={() => setSelected(r.runId)} title={r.runId}>
                      {shortId(r.runId)}
                    </button>
                    <CopyButton value={r.runId} what="run ID" />
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell>{assistantNames.get(r.assistantId) ?? shortId(r.assistantId)}</TableCell>
                <TableCell title={formatTime(r.createdAt)}>{formatShortTime(r.createdAt)}</TableCell>
                <TableCell className="text-end tabular-nums">{formatDuration(runDuration(r))}</TableCell>
                <TableCell className="font-mono text-code">{r.multitaskStrategy ?? "—"}</TableCell>
                <TableCell className="max-w-panel-xs truncate" title={runNote(r, lasts.get(r.runId))}>
                  {runNote(r, lasts.get(r.runId))}
                </TableCell>
                <TableCell className="text-end">
                  {r === runs[0] && waitsAtInterrupt(r, lasts.get(r.runId)) ? (
                    <Button size="small" onClick={onResume}>
                      Resume…
                    </Button>
                  ) : r.status === "running" || r.status === "pending" ? (
                    <Button size="small" onClick={() => setCancelling(r)}>
                      Cancel…
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
      {next !== null ? (
        <div className="px-inset-lg py-stack-sm">
          <Button size="small" loading={loadingMore} onClick={() => void loadMore()}>
            Load more runs
          </Button>
        </div>
      ) : null}
      {current ? <RunDetail key={current.runId} run={current} last={lasts.get(current.runId) ?? null} threadId={threadId} connId={connId} client={client} note={note} onRunAgain={onRunAgain} /> : null}
      <AlertDialog open={cancelling !== null} onOpenChange={(o) => !o && setCancelling(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel run {cancelling ? shortId(cancelling.runId) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>The run stops where it is; the thread keeps the checkpoints it wrote.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it running</AlertDialogCancel>
            <AlertDialogAction onClick={() => cancelling && void cancel(cancelling)}>Cancel the run</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** A run under the table: its error with node, step and checkpoint, its input, Run again. */
function RunDetail({ run, last, threadId, connId, client, note, onRunAgain }: { run: api.Run; last: api.ThreadState | null; threadId: string; onRunAgain: RunsPanelProps["onRunAgain"] } & Pick<TabProps, "connId" | "client" | "note">) {
  const full = useLoad(connId ? () => client.langgraph.runs.get({ connId, threadId, runId: run.runId }) : null, [connId, threadId, run.runId], note);
  // The run's last checkpoint, when History's first page does not have it.
  const found = useLoad(connId && !last && run.status !== "running" && run.status !== "pending" ? () => client.langgraph.threads.history({ connId, threadId, limit: 1, metadata: { run_id: run.runId } }) : null, [connId, threadId, run.runId, Boolean(last)], note);
  const end = last ?? found.data?.items[0] ?? null;
  const failure = end ? taskError(end) : null;
  const request = full.data?.request;
  const inputCut = full.data ? cutOf(full.data.cuts, "request.input") : undefined;
  return (
    <section aria-label={`Run ${shortId(run.runId)}`} className="flex flex-col border-t border-border-subtle">
      <div className="flex items-center gap-inline-md border-b border-border-subtle px-inset-lg py-stack-sm">
        <h3 className="flex-1 text-body-1-strong text-fg">
          Run {shortId(run.runId)} · {run.status}
        </h3>
        <Button appearance="subtle" disabled={!request || Boolean(inputCut)} onClick={() => request && onRunAgain(run, request)} title={inputCut ? "The input is too big to put in the form" : undefined}>
          <Icon icon={Play} /> Run again with the same input
        </Button>
      </div>
      <div className="flex flex-col gap-stack-md px-inset-lg py-stack-md">
        {full.error ? <ErrorState error={full.error} onRetry={() => void full.reload()} /> : null}
        {run.status === "error" ? (
          failure ? (
            <pre aria-label="The run's error" className="overflow-auto rounded-md bg-layer-alt p-inset-sm font-mono text-code whitespace-pre-wrap text-fg">
              {failure.error}
              {"\n"}
              {`  during node ${failure.node}${end && stepOf(end) !== null ? `, step ${stepOf(end)}` : ""}${end?.checkpointId ? `, checkpoint ${shortId(end.checkpointId)}` : ""}`}
            </pre>
          ) : found.loading ? (
            <LoadingRows label="Looking for the run's error" />
          ) : (
            <p className="text-body-1 text-fg-muted">The server keeps no error for this run in its checkpoints.</p>
          )
        ) : null}
        {waitsAtInterrupt(run, end) && end ? <p className="text-body-1 text-fg">Waiting at {end.next.join(", ")}.</p> : null}
        <h4 className="text-body-1-strong text-fg">Input</h4>
        {full.loading && !full.data ? <LoadingRows label="Loading the run" /> : null}
        {inputCut ? (
          <CutValue label="Input" cut={inputCut} note={note} load={() => loadCut(client, { connId: connId ?? "", threadId, runId: run.runId }, inputCut)} className="h-panel-xs" />
        ) : request ? (
          request.input === null ? (
            <p className="text-body-1 text-fg-muted">No input: the run {request.command ? "resumed the graph with a command" : "continued from a checkpoint"}.</p>
          ) : (
            <JsonViewer value={request.input} aria-label="Input" defaultExpandDepth={2} className="h-panel-xs" />
          )
        ) : null}
      </div>
    </section>
  );
}
