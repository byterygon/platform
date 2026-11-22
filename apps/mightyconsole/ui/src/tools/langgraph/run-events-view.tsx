// A run's events (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-run-events, TSK-96): the run
// picker (the live run is followed while it streams), chips with a count per stream mode, the
// events with their time since the start, mode, node and summary, message tokens folded per
// message, the interrupt marked; the selected row's detail. A finished run's events are not kept
// by the server (Open question 62): picking one lists its checkpoints instead.
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, PageBar, PageFooter, chipClass, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { cn } from "@/lib/cn";
import { formatShortTime } from "@/lib/time";
import type { TabProps } from "../types";
import { CHIP_MODES, type ChipMode, type EventRow, eventRows, modeCounts, rowInMode, sinceStart } from "./event-rows";
import type { RunEvent } from "./run-events";
import { formatDuration, runDuration, sourceOf, stepOf, wroteLabel } from "./state-diff";
import { shortId, useLoad } from "./shared";

/** The picker's value for the run this tab streams or streamed. */
export const THIS_RUN = "this-run";

export interface EventsViewProps extends Pick<TabProps, "connId" | "client" | "note"> {
  threadId: string;
  events: readonly RunEvent[];
  /** The run this tab streams or streamed, if any. */
  runId: string | null;
  running: boolean;
  /** The thread's runs (the Runs tab's first page). */
  runs: readonly api.Run[];
  picked: string;
  onPick: (run: string) => void;
  onMessages: () => void;
}

const modeVariant = (row: EventRow) => (row.interrupt || row.error ? "danger" : row.mode === "messages" ? "info" : row.mode === "custom" ? "warning" : "neutral");

export function EventsView({ threadId, events, runId, running, runs, picked, onPick, onMessages, connId, client, note }: EventsViewProps) {
  const [mode, setMode] = useState<ChipMode | "all">("all");
  const [chunks, setChunks] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => eventRows(events, !chunks), [events, chunks]);
  const counts = useMemo(() => modeCounts(events), [events]);
  const shown = rows.filter((r) => rowInMode(r, mode));
  const current = shown.find((r) => r.index === selected) ?? null;
  const folded = rows.filter((r) => r.message && r.events.length > 1);
  const pickedRun = picked === THIS_RUN ? null : (runs.find((r) => r.runId === picked) ?? null);
  const items: Record<string, string> = {};
  if (runId || running) items[THIS_RUN] = `Run ${runId ? shortId(runId) : "starting"} · ${running ? "live" : "this tab"}`;
  for (const r of runs) if (r.runId !== runId) items[r.runId] = `Run ${shortId(r.runId)} · ${r.status} · ${formatDuration(runDuration(r))}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Run events" className="pb-stack-sm">
        <Select aria-label="Run" value={picked in items ? picked : null} onValueChange={(v) => onPick((v as string) ?? THIS_RUN)} items={items} placeholder="No run yet">
          {Object.entries(items).map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </Select>
        {pickedRun ? null : (
          <div role="group" aria-label="Stream modes" className="flex flex-wrap items-center gap-inline-xs">
            <ToggleButton size="small" appearance="outline" className={chipClass} pressed={mode === "all"} onPressedChange={() => setMode("all")}>
              All {events.length}
            </ToggleButton>
            {CHIP_MODES.map((m) => (
              <ToggleButton key={m} size="small" appearance="outline" className={chipClass} pressed={mode === m} disabled={counts[m] === 0} onPressedChange={(on) => setMode(on ? m : "all")}>
                {m} {counts[m]}
              </ToggleButton>
            ))}
          </div>
        )}
        <span className="flex-1" />
        <ToggleGroup aria-label="Run output" size="small" value={["events"]} onValueChange={(v) => v[0] === "messages" && onMessages()}>
          <ToggleGroupItem value="messages">Messages</ToggleGroupItem>
          <ToggleGroupItem value="events">Events</ToggleGroupItem>
        </ToggleGroup>
      </PageBar>
      {pickedRun ? (
        <PastRun run={pickedRun} threadId={threadId} connId={connId} client={client} note={note} />
      ) : (
        <Resizable orientation="horizontal" className="min-h-0 flex-1 border-t border-border-subtle">
          <ResizablePanel defaultSize={70} minSize={40}>
            <div className="flex h-full min-h-0 flex-col">
              <div className="min-h-0 flex-1 overflow-auto">
                {shown.length === 0 ? <EmptyLine>{running ? "Waiting for events…" : "No events yet. Run the graph (Ctrl+Enter)."}</EmptyLine> : null}
                {shown.length > 0 ? (
                  <Table aria-label="Events" className={gutterTable}>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-end">#</TableHead>
                        <TableHead className="text-end">Time</TableHead>
                        <TableHead>Mode</TableHead>
                        <TableHead>Node</TableHead>
                        <TableHead>Summary</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shown.slice(-1000).map((r) => (
                        <TableRow key={r.index} data-selected={r === current ? "" : undefined} aria-selected={r === current} className={cn((r.interrupt || r.error) && "bg-danger-subtle")} onClick={() => setSelected(r.index)}>
                          <TableCell className="text-end tabular-nums">
                            <button type="button" onClick={() => setSelected(r.index)}>
                              {r.index}
                            </button>
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{sinceStart(r.at)}</TableCell>
                          <TableCell>
                            <Badge appearance="tint" variant={modeVariant(r)}>
                              {r.mode}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-code">{r.node}</TableCell>
                          <TableCell className="max-w-panel-sm truncate" title={r.summary}>
                            {r.summary}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : null}
              </div>
              <PageFooter>
                <span className="flex-1">{folded.length > 0 && !chunks ? `Message tokens are folded into one row per message (${folded.reduce((n, r) => n + r.events.length, 0)} chunks → ${folded.length}).` : "Each event is a row."}</span>
                <label className="flex items-center gap-inline-sm">
                  <Switch checked={chunks} onCheckedChange={setChunks} />
                  Show chunks
                </label>
              </PageFooter>
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={22}>
            <div className="h-full overflow-auto px-inset-lg py-inset-md">{current ? <EventDetail row={current} runId={runId} /> : <p className="text-body-1 text-fg-muted">Select an event to see it whole.</p>}</div>
          </ResizablePanel>
        </Resizable>
      )}
    </div>
  );
}

/** One row whole: a message's text, model and tokens, or the event's data. */
function EventDetail({ row, runId }: { row: EventRow; runId: string | null }) {
  const title = `Event ${row.index} · ${row.mode}${row.node ? ` · ${row.node}` : ""}`;
  const m = row.message;
  return (
    <section aria-label={title} className="flex flex-col gap-stack-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="text-body-1-strong text-fg">{title}</h3>
        {m && row.events.length > 1 ? (
          <p className="text-body-1 text-fg-muted">
            {row.events.length} chunks{row.at !== undefined && m.lastAt !== undefined ? `, ${sinceStart(row.at)} → ${sinceStart(m.lastAt)}` : ""}
          </p>
        ) : null}
      </div>
      {m ? (
        <>
          <p className="rounded-md border border-border-subtle bg-layer p-inset-sm text-body-1 whitespace-pre-wrap text-fg">{m.text || "(no text)"}</p>
          <DescriptionList>
            {m.model ? (
              <DescriptionListItem>
                <DescriptionListTerm>Model</DescriptionListTerm>
                <DescriptionListDetails className="font-mono text-code">{m.model}</DescriptionListDetails>
              </DescriptionListItem>
            ) : null}
            {m.tokensIn !== undefined || m.tokensOut !== undefined ? (
              <DescriptionListItem>
                <DescriptionListTerm>Tokens</DescriptionListTerm>
                <DescriptionListDetails>
                  in {m.tokensIn?.toLocaleString("en") ?? "—"} · out {m.tokensOut?.toLocaleString("en") ?? "—"}
                </DescriptionListDetails>
              </DescriptionListItem>
            ) : null}
            {runId ? (
              <DescriptionListItem>
                <DescriptionListTerm>Run</DescriptionListTerm>
                <DescriptionListDetails className="flex items-center gap-inline-xs font-mono text-code">
                  {shortId(runId)} <CopyButton value={runId} what="run ID" />
                </DescriptionListDetails>
              </DescriptionListItem>
            ) : null}
          </DescriptionList>
        </>
      ) : (
        <JsonViewer value={(row.events.length === 1 ? row.events[0]!.data : row.events.map((e) => e.data)) as api.JsonValue} aria-label="Event data" defaultExpandDepth={2} className="h-panel-sm" />
      )}
    </section>
  );
}

/** A finished run of the thread: the server keeps no events, so its checkpoints. */
function PastRun({ run, threadId, connId, client, note }: { run: api.Run; threadId: string } & Pick<TabProps, "connId" | "client" | "note">) {
  const steps = useLoad(connId ? () => client.langgraph.threads.history({ connId, threadId, limit: 100, metadata: { run_id: run.runId } }) : null, [connId, threadId, run.runId], note);
  const items = steps.data?.items ?? [];
  const byId = new Map(items.flatMap((s) => (s.checkpointId ? [[s.checkpointId, s] as const] : [])));
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto border-t border-border-subtle">
      <p className="px-inset-lg py-stack-sm text-body-1 text-fg-muted">The server keeps a run's events only while it streams; here are the checkpoints run {shortId(run.runId)} wrote.</p>
      {steps.error ? <ErrorState error={steps.error} onRetry={() => void steps.reload()} /> : null}
      {steps.loading && !steps.data ? <LoadingRows label="Loading the run's checkpoints" /> : null}
      {steps.data && items.length === 0 ? <EmptyLine>This run wrote no checkpoints.</EmptyLine> : null}
      {items.length > 0 ? (
        <Table aria-label="The run's checkpoints" className={gutterTable}>
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
            {[...items].reverse().map((s, i) => (
              <TableRow key={s.checkpointId ?? i}>
                <TableCell className="text-end tabular-nums">{stepOf(s) ?? ""}</TableCell>
                <TableCell>{sourceOf(s)}</TableCell>
                <TableCell className="font-mono text-code">{wroteLabel(s, s.parentCheckpointId ? byId.get(s.parentCheckpointId) : undefined, byId)}</TableCell>
                <TableCell className="font-mono text-code text-fg-muted">{s.next.join(", ") || "—"}</TableCell>
                <TableCell>{formatShortTime(s.createdAt ?? undefined)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : null}
    </div>
  );
}
