// The results panel (DBee spec §3.7, §8): the data grid (@byterygon/data-grid, spec §6) reading the
// run's Arrow stream directly, the live status line, notices, the error Alert with SQLSTATE,
// position and correlation id, copy as TSV or with headers as TSV, CSV or JSON, and the cell value
// viewer (Enter, F2 or double click).
import { type CellPos, columnFormat, DataGrid, type DataGridHandle, type SelectionInfo } from "@byterygon/data-grid";
import { useMemo, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { CodeInput } from "@/components/ui/code-input";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { ArrowDownload, ChevronDown, Copy } from "@/lib/icons";
import { benchHook } from "../bench";
import { formatCount, formatElapsed } from "../messages";
import type { Run } from "../store";

export function statusLine(run: Run | null): string {
  if (run === null) return "";
  const elapsed = formatElapsed(run.elapsedMs);
  switch (run.status) {
    case "running":
      return run.rows > 0 ? `${formatCount(run.rows)} rows… ${elapsed}` : `Running… ${elapsed}`;
    case "done": {
      const s = run.summary;
      if (s && s.rowsReturned === null) return `${s.statementKind} ${s.rowsAffected === null ? "" : `${formatCount(s.rowsAffected)} rows `}in ${formatElapsed(s.elapsedMs)}`;
      const base = `${formatCount(run.rows)} rows in ${formatElapsed(s?.elapsedMs ?? run.elapsedMs)}`;
      return s?.truncated ? `first ${formatCount(run.rows)} rows (limit)` : base;
    }
    case "cancelled":
      return run.note ?? "Cancelled";
    case "error":
      return run.error?.title ?? "Error";
    default:
      return "";
  }
}

export interface ResultsPanelProps {
  run: Run | null;
  onExport: () => void;
  onRemedy?: (remedy: string) => void;
  /** The tab's column widths by column name (persisted in the workspace). */
  columnWidths?: Record<string, number> | undefined;
  onColumnWidths?: (widths: Record<string, number>) => void;
}

export function ResultsPanel({ run, onExport, onRemedy, columnWidths, onColumnWidths }: ResultsPanelProps) {
  const grid = useRef<DataGridHandle | null>(null);
  const [viewer, setViewer] = useState<CellPos | null>(null);
  const [copyMenu, setCopyMenu] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const columns = run?.fields ?? [];
  const formats = useMemo(() => columns.map(columnFormat), [columns]);
  const widths = useMemo(() => columns.map((f) => columnWidths?.[f.name]), [columns, columnWidths]);
  const bench = benchHook();
  const rows = run?.rows ?? 0;
  const copy = (format: "tsv" | "csv" | "json", headers: boolean) => void grid.current?.copy(format, headers);
  const viewed = viewer && run ? grid.current?.cellValue(viewer.row, viewer.column) : undefined;
  const viewedField = viewer ? columns[viewer.column] : undefined;
  const viewedFormat = viewer ? formats[viewer.column] : undefined;

  if (run === null) {
    return (
      <EmptyState variant="inline" className="m-inset-sm">
        <EmptyStateTitle render={<p />}>No result yet</EmptyStateTitle>
        <EmptyStateDescription>Run a statement with Ctrl+Enter (Cmd+Enter on macOS).</EmptyStateDescription>
      </EmptyState>
    );
  }
  // The empty string reads "empty string" in the status line (spec §6), so it is not mistaken for NULL.
  const cellNote = selection && selection.cells === 1 && selection.value === "" ? " · empty string" : "";
  return (
    <div className="flex h-full min-h-0 flex-col" data-pane="results">
      {/* One row (TSK-64): the live status first, the result's commands at the end. Cancel is in the tab's command bar only (spec Open question 17). */}
      <Toolbar aria-label="Results" variant="plain" className="shrink-0 border-b border-border-subtle py-inset-xs ps-inset-sm pe-inset-xs">
        <span role="status" aria-live="polite" className="flex min-w-0 flex-1 items-center gap-inline-sm truncate text-body-1">
          {run.status === "running" ? <Spinner size="sm" label={null} /> : null}
          <span className="truncate">
            {statusLine(run)}
            {run.note && run.status === "done" ? ` · ${run.note}` : ""}
            {cellNote}
          </span>
        </span>
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" />} disabled={rows === 0} onClick={() => copy("tsv", false)}>
            <Icon icon={Copy} /> Copy
          </ToolbarButton>
          <DropdownMenu open={copyMenu} onOpenChange={setCopyMenu}>
            <DropdownMenuTrigger render={<ToolbarButton render={<Button appearance="subtle" />} disabled={rows === 0} />}>
              <Icon icon={Copy} /> Copy with headers <Icon icon={ChevronDown} size="xs" />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => copy("tsv", true)}>TSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy("csv", true)}>CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy("json", true)}>JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" />} disabled={run.status === "running"} onClick={onExport}>
            <Icon icon={ArrowDownload} /> Export
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      {run.status === "error" && run.error ? (
        <Alert variant="danger" className="m-inset-sm">
          <AlertTitle>{run.error.title}</AlertTitle>
          <AlertDescription>
            {run.error.description ? <span>{run.error.description} </span> : null}
            {run.error.sqlstate ? (
              <span>
                SQLSTATE <Code>{run.error.sqlstate}</Code>{" "}
              </span>
            ) : null}
            {run.error.position !== undefined ? <span>at position {run.error.position} </span> : null}
            {run.error.correlationId ? (
              <details className="inline">
                <summary className="inline cursor-pointer text-fg-link">Details</summary> Correlation id <Code>{run.error.correlationId}</Code>
              </details>
            ) : null}
          </AlertDescription>
          {run.error.remedy && onRemedy ? (
            <AlertActions>
              <Button size="small" appearance="secondary" onClick={() => onRemedy(run.error!.remedy!)}>
                {run.error.remedyLabel}
              </Button>
            </AlertActions>
          ) : null}
        </Alert>
      ) : null}
      {run.summary && run.summary.notices.length > 0 ? (
        <Collapsible className="px-inset-sm">
          <CollapsibleTrigger>
            {run.summary.notices.length} {run.summary.notices.length === 1 ? "notice" : "notices"}
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <ul className="text-caption text-fg-muted">
              {run.summary.notices.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
      {columns.length > 0 && run.stream ? (
        <div className="min-h-0 min-w-0 flex-1">
          <DataGrid
            ref={(handle) => {
              grid.current = handle;
              if (bench) bench.grid = handle;
            }}
            stream={run.stream}
            aria-label="Result rows"
            columnWidths={widths}
            onColumnWidthsChange={(next) => onColumnWidths?.({ ...columnWidths, ...Object.fromEntries(columns.map((f, c) => [f.name, next[c]!])) })}
            onSelectionChange={setSelection}
            onOpenCell={setViewer}
            onCopyWithHeaders={() => setCopyMenu(true)}
            {...(bench ? { onFrameSample: (sample) => bench.samples.push(sample) } : {})}
          />
        </div>
      ) : run.status === "done" && run.summary?.rowsReturned === null ? (
        <p className="p-inset-md text-body text-fg-muted">{statusLine(run)}</p>
      ) : run.status === "done" ? (
        <p className="p-inset-md text-body text-fg-muted">0 rows</p>
      ) : null}
      <Sheet open={viewer !== null && viewed !== undefined} onOpenChange={(open) => !open && setViewer(null)} side="right" size="md">
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{viewedField?.name ?? "Value"}</SheetTitle>
            <SheetDescription>
              {viewedFormat?.label ?? ""} · row {viewer ? viewer.row + 1 : ""} · {viewed === null ? "NULL" : viewed === "" ? "empty string" : "not null"}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-stack-sm">
            {typeof viewed === "string" ? (
              <>
                <CodeInput aria-label="Cell value" multiline rows={12} readOnly pretty language={viewedFormat?.family === "json" ? "json" : "text"} value={viewed} />
                <Button appearance="secondary" size="small" onClick={() => void navigator.clipboard?.writeText(viewed)}>
                  Copy value
                </Button>
              </>
            ) : (
              <p className="text-body text-fg-muted">NULL</p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
