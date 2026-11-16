// The results panel (DBee spec §3.7, §8): a minimal virtualized Table reading the Arrow buffers
// directly until the data grid (TSK-39); the live status line; notices; the error Alert with
// SQLSTATE, position and correlation id; copy as TSV with or without headers; the cell value
// viewer.
import { useMemo, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { CodeInput } from "@/components/ui/code-input";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { EmptyState, EmptyStateDescription, EmptyStateTitle } from "@/components/ui/empty-state";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableCell, TableHead, TableHeader, TableNull, TableRow, TableVirtualBody } from "@/components/ui/table";
import { Toolbar, ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";
import { TypeBadge } from "@/components/ui/type-badge";
import { type Cell, readCell, typeFamily, typeLabel } from "../arrow-cells";
import { formatCount, formatElapsed } from "../messages";
import type { Run } from "../store";

/** The cell at (row, column) across the batches. */
export function cellAt(run: Run, row: number, column: number): Cell {
  let offset = 0;
  for (const batch of run.batches) {
    if (row < offset + batch.numRows) {
      const data = batch.columns[column];
      const field = run.fields[column];
      return data && field ? readCell(field, data, row - offset) : { kind: "null" };
    }
    offset += batch.numRows;
  }
  return { kind: "null" };
}

const cellText = (c: Cell): string => (c.kind === "null" ? "NULL" : c.kind === "value" ? c.text : `<${c.type}>`);

/** TSV (or CSV) of the rows, optionally with the header, for the clipboard. */
export function serialize(run: Run, format: "tsv" | "csv" | "json", headers: boolean, maxRows = run.rows): string {
  const names = run.fields.map((f) => f.name);
  const rows = Math.min(run.rows, maxRows);
  if (format === "json") {
    const out: Record<string, string | null>[] = [];
    for (let r = 0; r < rows; r++) {
      const o: Record<string, string | null> = {};
      names.forEach((n, c) => {
        const cell = cellAt(run, r, c);
        o[n] = cell.kind === "null" ? null : cellText(cell);
      });
      out.push(o);
    }
    return JSON.stringify(out, null, 2);
  }
  const sep = format === "tsv" ? "\t" : ",";
  const esc = (s: string) => (format === "csv" && /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : format === "tsv" ? s.replace(/[\t\n\r]/g, " ") : s);
  const lines: string[] = [];
  if (headers) lines.push(names.map(esc).join(sep));
  for (let r = 0; r < rows; r++) lines.push(names.map((_, c) => esc(cellText(cellAt(run, r, c)))).join(sep));
  return lines.join("\n");
}

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
  onCancel: () => void;
}

export function ResultsPanel({ run, onExport, onRemedy, onCancel }: ResultsPanelProps) {
  const [cell, setCell] = useState<{ row: number; column: number } | null>(null);
  const [viewer, setViewer] = useState(false);
  const columns = run?.fields ?? [];
  const families = useMemo(() => columns.map(typeFamily), [columns]);
  const copy = (format: "tsv" | "csv" | "json", headers: boolean) => {
    if (!run) return;
    void navigator.clipboard?.writeText(serialize(run, format, headers));
  };
  const current = run && cell ? cellAt(run, cell.row, cell.column) : null;
  const onKey = (e: React.KeyboardEvent) => {
    if (!run || run.rows === 0) return;
    if (e.key === "Enter" || e.key === "F2") {
      if (cell) {
        setViewer(true);
        e.preventDefault();
      }
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
      copy("tsv", e.shiftKey);
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
    } else if (e.key === "ArrowDown" && cell) setCell({ ...cell, row: Math.min(run.rows - 1, cell.row + 1) });
    else if (e.key === "ArrowUp" && cell) setCell({ ...cell, row: Math.max(0, cell.row - 1) });
    else if (e.key === "ArrowRight" && cell) setCell({ ...cell, column: Math.min(columns.length - 1, cell.column + 1) });
    else if (e.key === "ArrowLeft" && cell) setCell({ ...cell, column: Math.max(0, cell.column - 1) });
    else if (!cell && e.key.startsWith("Arrow")) setCell({ row: 0, column: 0 });
    else return;
    e.preventDefault();
  };

  if (run === null) {
    return (
      <EmptyState variant="inline" className="m-inset-sm">
        <EmptyStateTitle render={<p />}>No result yet</EmptyStateTitle>
        <EmptyStateDescription>Run a statement with Ctrl+Enter (Cmd+Enter on macOS).</EmptyStateDescription>
      </EmptyState>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-pane="results">
      <Toolbar aria-label="Results" variant="plain" className="shrink-0">
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" size="small" />} disabled={run.rows === 0} onClick={() => copy("tsv", false)}>
            Copy
          </ToolbarButton>
          <DropdownMenu>
            <DropdownMenuTrigger render={<ToolbarButton render={<Button appearance="subtle" size="small" />} disabled={run.rows === 0} />}>Copy with headers</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => copy("tsv", true)}>TSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy("csv", true)}>CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => copy("json", true)}>JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <ToolbarButton render={<Button appearance="subtle" size="small" />} disabled={run.status === "running"} onClick={onExport}>
            Export
          </ToolbarButton>
          {run.status === "running" ? (
            <ToolbarButton render={<Button appearance="secondary" size="small" />} onClick={onCancel}>
              Cancel
            </ToolbarButton>
          ) : null}
        </ToolbarGroup>
        <span role="status" aria-live="polite" className="ms-auto truncate px-inset-sm text-caption text-fg-muted">
          {statusLine(run)}
          {run.note && run.status === "done" ? ` · ${run.note}` : ""}
        </span>
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
      {columns.length > 0 ? (
        <div className="min-h-0 min-w-0 flex-1" onKeyDown={onKey}>
          <Table aria-label="Result rows" className="h-full" aria-rowcount={run.status === "running" ? -1 : run.rows + 1}>
            <TableHeader>
              <TableRow>
                <TableHead align="end" className="w-[6ch] text-fg-subtle">
                  #
                </TableHead>
                {columns.map((f, i) => (
                  <TableHead key={f.name + i} align={families[i] === "integer" || families[i] === "decimal" ? "end" : "start"}>
                    <span className="flex items-center gap-inline-xs">
                      <TypeBadge type={families[i] ?? "text"} label={typeLabel(f)} iconOnly />
                      <span className="truncate" title={`${f.name}: ${typeLabel(f)}`}>
                        {f.name}
                      </span>
                    </span>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableVirtualBody
              count={run.rows}
              renderRow={(r) => (
                <TableRow key={r} selected={cell?.row === r}>
                  <TableCell align="end" className="text-fg-subtle">
                    {r + 1}
                  </TableCell>
                  {columns.map((f, c) => {
                    const v = cellAt(run, r, c);
                    const isCell = cell?.row === r && cell.column === c;
                    return (
                      <TableCell
                        key={f.name + c}
                        align={v.kind === "value" ? v.align : "start"}
                        {...(isCell ? { className: "outline outline-ring" } : {})}
                        tabIndex={isCell ? 0 : -1}
                        onClick={() => setCell({ row: r, column: c })}
                        onDoubleClick={() => {
                          setCell({ row: r, column: c });
                          setViewer(true);
                        }}
                        {...(v.kind === "value" ? { title: v.text } : {})}
                      >
                        {v.kind === "null" ? <TableNull /> : v.kind === "value" ? v.text : <span className="text-fg-subtle">{`<${v.type}>`}</span>}
                      </TableCell>
                    );
                  })}
                </TableRow>
              )}
            />
          </Table>
        </div>
      ) : run.status === "done" && run.summary?.rowsReturned === null ? (
        <p className="p-inset-md text-body text-fg-muted">{statusLine(run)}</p>
      ) : run.status === "done" ? (
        <p className="p-inset-md text-body text-fg-muted">0 rows</p>
      ) : null}
      <Sheet open={viewer && current !== null} onOpenChange={setViewer} side="right" size="md">
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{cell && columns[cell.column] ? columns[cell.column]!.name : "Value"}</SheetTitle>
            <SheetDescription>
              {cell && columns[cell.column] ? typeLabel(columns[cell.column]!) : ""} · row {cell ? cell.row + 1 : ""} · {current?.kind === "null" ? "NULL" : "not null"}
            </SheetDescription>
          </SheetHeader>
          <SheetBody className="flex flex-col gap-stack-sm">
            {current && current.kind === "value" ? (
              <>
                <CodeInput aria-label="Cell value" multiline rows={12} readOnly pretty language={cell && families[cell.column] === "json" ? "json" : "text"} value={current.text} />
                <Button appearance="secondary" size="small" onClick={() => void navigator.clipboard?.writeText(current.text)}>
                  Copy value
                </Button>
              </>
            ) : (
              <p className="text-body text-fg-muted">{current ? cellText(current) : ""}</p>
            )}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
