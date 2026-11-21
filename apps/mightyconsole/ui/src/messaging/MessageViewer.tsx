// MessageViewer (Mightyconsole spec §5.6): the system's columns in the data grid, read straight from
// the stream's Arrow batches, and a detail pane for the selected message (Value, Key, Headers,
// Raw, Schema, Metadata) read from the same batch, so a selection costs no round trip. The live
// tail's window (10,000 messages or 128 MiB) drops the oldest batches whole; Pause holds the grid's
// pull; Clear empties the view and keeps the stream. Shared by every message screen: the tool
// gives its system (columns and words), the stream and its row actions.
import { DataGrid, type DataGridHandle, type ResultProgress, type SelectionInfo } from "@byterygon/data-grid";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { EmptyLine, ErrorState, LiveBadge } from "@/app/states";
import { ArrowDownload, Copy, Pause, Play, Stop, Subtract } from "@/lib/icons";
import type { LastPosition } from "@/gen/api";
import type { ArrowBatch } from "@byterygon/ambidex/arrow";
import { bigAt, columnIndex, dropFront, intAt, locate, type MessageRow, projectStream, readMessage, textAt } from "./arrow";
import { COLUMNS, LABELS, type MessageLabels, type MessageSystem } from "./columns";
import { MessageDetail, type SchemaLoader } from "./MessageDetail";
import type { DecodeAs } from "./schemas/DecodeAs";
import { exportObject, toJsonLines } from "./export";
import type { LiveTail } from "./useLiveTail";

/** Messages a live view keeps, by default (spec §5.5, Settings). */
export const DEFAULT_MAX_MESSAGES = 10_000;
/** Buffer bytes a live view keeps. */
export const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;

/** An action on the selected message, the tool's own ("Reset group to here"). */
export interface RowAction {
  label: string;
  run(message: MessageRow): void;
}

export interface MessageViewerProps {
  system: MessageSystem;
  labels?: Partial<MessageLabels>;
  tail: LiveTail;
  maxMessages?: number;
  maxBytes?: number;
  /** Above the grid: the codec selects and the filter bar of the tool's screen. */
  controls?: ReactNode;
  /** Open in Composer (resend), Copy as Composer template. */
  onCompose?: (message: MessageRow) => void;
  /** Load full payload: the tool's get procedure; `null` when the system cannot refetch (core NATS). */
  onLoadFull?: ((message: MessageRow) => Promise<Uint8Array>) | null;
  loadSchema?: SchemaLoader;
  rowActions?: readonly RowAction[];
  /** Where each partition or stream last was, after every batch (for Restart after Stop). */
  onPositions?: (positions: LastPosition[]) => void;
  /** "Decode as…" on messages that did not decode. */
  decodeAs?: DecodeAs;
}

/** A message list with a detail pane, on a live or finite message stream. */
export function MessageViewer({ system, labels: labelsProp, tail, maxMessages = DEFAULT_MAX_MESSAGES, maxBytes = DEFAULT_MAX_BYTES, controls, onCompose, onLoadFull, loadSchema, rowActions, onPositions, decodeAs }: MessageViewerProps) {
  const labels = { ...LABELS[system], ...labelsProp };
  const grid = useRef<DataGridHandle | null>(null);
  const [fields, setFields] = useState<Record<string, number> | null>(null);
  const [selected, setSelected] = useState<{ row: number; message: MessageRow } | null>(null);
  const [rows, setRows] = useState(0);
  const [dropped, setDropped] = useState(0);
  const lastDropped = useRef(0);
  const positions = useRef(onPositions);
  positions.current = (p: LastPosition[]) => {
    tail.remember(p);
    onPositions?.(p);
  };

  const fieldsRef = useRef<Record<string, number> | null>(null);
  const projected = useMemo(() => {
    if (tail.stream === null) return null;
    const seen = new Map<string, LastPosition>();
    return projectStream(tail.stream, COLUMNS[system], (batch) => {
      if (!fieldsRef.current || !positions.current) return;
      updatePositions(seen, batch, fieldsRef.current);
      positions.current([...seen.values()]);
    });
  }, [tail.stream, system]);
  useEffect(() => {
    setSelected(null);
    setRows(0);
    setDropped(0);
    lastDropped.current = 0;
    if (!projected) return;
    let live = true;
    projected.fields.then(
      (f) => {
        if (!live) return;
        fieldsRef.current = columnIndex(f);
        setFields(fieldsRef.current);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [projected]);

  const onProgress = (p: ResultProgress) => {
    if (projected && p.dropped > lastDropped.current) {
      dropFront(projected.full, p.dropped - lastDropped.current);
      lastDropped.current = p.dropped;
      setDropped(p.dropped);
    }
    setRows(p.rows);
  };
  const onSelectionChange = (info: SelectionInfo) => {
    if (!projected || !fields) return;
    const at = locate(projected.full, info.active.row);
    setSelected(at ? { row: info.active.row, message: readMessage(at.batch, fields, at.row) } : null);
  };

  const loaded = (): MessageRow[] => {
    if (!projected || !fields) return [];
    const out: MessageRow[] = [];
    for (const batch of projected.full) for (let r = 0; r < batch.numRows; r += 1) out.push(readMessage(batch, fields, r));
    return out;
  };
  const exportAll = () => {
    const blob = new Blob([toJsonLines(loaded())], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${labels.items}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const copyMessage = () => {
    if (selected) void navigator.clipboard?.writeText(JSON.stringify(exportObject(selected.message), null, 2)).catch(() => {});
  };
  const clear = () => {
    grid.current?.clear();
    setSelected(null);
  };

  const running = tail.status === "live" || tail.status === "paused";
  const live = tail.status === "idle" ? null : tail.status === "ended" ? { status: "ended" as const } : { status: tail.status, ...(tail.progress ? { ratePerSec: tail.progress.ratePerSec, dropped: tail.progress.dropped } : {}) };
  const p = tail.progress;
  const s = tail.summary;
  return (
    <div data-slot="message-viewer" className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label={`${labels.items} actions`}>
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="primary" disabled={running} />} onClick={() => tail.start(tail.status === "ended")}>
            <Icon icon={Play} /> {tail.status === "ended" ? "Restart" : "Start"}
          </ToolbarButton>
          <ToolbarButton render={<Button disabled={!running} />} onClick={tail.pause}>
            <Icon icon={tail.status === "paused" ? Play : Pause} /> {tail.status === "paused" ? "Resume" : "Pause"}
          </ToolbarButton>
          <ToolbarButton render={<Button disabled={!running} />} onClick={tail.stop}>
            <Icon icon={Stop} /> Stop
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton render={<Button appearance="subtle" disabled={rows === 0} />} onClick={clear}>
            <Icon icon={Subtract} /> Clear
          </ToolbarButton>
          <ToolbarButton render={<Button appearance="subtle" disabled={rows === 0} />} onClick={exportAll}>
            <Icon icon={ArrowDownload} /> Export
          </ToolbarButton>
          <ToolbarButton render={<Button appearance="subtle" disabled={selected === null} />} onClick={copyMessage}>
            <Icon icon={Copy} /> Copy {labels.item}
          </ToolbarButton>
        </ToolbarGroup>
        {live ? <LiveBadge live={live} unit={`${labels.items}/s`} /> : null}
      </Toolbar>
      {controls}
      {tail.error ? <ErrorState error={tail.error} onRetry={() => tail.start(true)} /> : null}
      <p data-slot="message-viewer-status" className="flex flex-wrap items-center gap-inline-sm px-inset-sm py-inset-xs text-caption-1 text-fg-muted" aria-live="polite">
        {tail.status === "idle" ? `No ${labels.items} yet. Press Start (Ctrl+Enter).` : `${rows.toLocaleString()} ${labels.items} shown`}
        {dropped > 0 ? <Badge appearance="tint" variant="warning">Showing the latest {rows.toLocaleString()}</Badge> : null}
        {p ? (
          <span>
            scanned {p.scanned.toLocaleString()} · matched {p.matched.toLocaleString()} · dropped {p.dropped.toLocaleString()} · decode errors {p.decodeErrors.toLocaleString()} · {formatBytes(p.bytesPerSec)}/s
          </span>
        ) : null}
        {s ? <span>Ended ({endText(s.endReason)}): scanned {s.scanned.toLocaleString()}, matched {s.matched.toLocaleString()}</span> : null}
      </p>
      {projected ? (
        <Resizable aria-label={`${labels.items} and detail`} orientation="vertical" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={60} minSize={20}>
            <DataGrid
              ref={grid}
              stream={projected.grid}
              aria-label={labels.items}
              follow
              hold={tail.hold || tail.background}
              maxRows={maxMessages}
              maxBytes={maxBytes}
              onProgress={onProgress}
              onSelectionChange={onSelectionChange}
              className="size-full"
            />
          </ResizablePanel>
          <ResizableHandle aria-label="Resize the detail pane" />
          <ResizablePanel minSize={15}>
            {selected ? (
              <MessageDetail
                message={selected.message}
                labels={labels}
                onCompose={onCompose}
                onLoadFull={onLoadFull}
                loadSchema={loadSchema}
                rowActions={rowActions}
                decodeAs={decodeAs}
              />
            ) : (
              <EmptyLine>Select a {labels.item} to see it.</EmptyLine>
            )}
          </ResizablePanel>
        </Resizable>
      ) : null}
    </div>
  );
}

function endText(reason: string): string {
  return reason === "maxScan" ? "scan limit reached" : reason === "limit" ? "limit reached" : reason === "cancelled" ? "stopped" : "end of data";
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(1)} MiB`;
}

/** Updates the last message read per source and partition with a new batch (position columns only). */
function updatePositions(seen: Map<string, LastPosition>, batch: ArrowBatch, fields: Record<string, number>): void {
  const col = (name: string) => batch.columns[fields[name]!]!;
  for (let r = 0; r < batch.numRows; r += 1) {
    const source = textAt(col("source"), r) ?? "";
    const partition = intAt(col("partition"), r);
    const offset = bigAt(col("offset"), r);
    const sequence = bigAt(col("sequence"), r);
    seen.set(`${source}\u0000${partition ?? ""}`, {
      source,
      ...(partition !== null ? { partition } : {}),
      ...(offset !== null ? { offset } : {}),
      ...(sequence !== null ? { sequence } : {}),
      timestampUs: Number(bigAt(col("timestamp"), r) ?? 0),
    });
  }
}
