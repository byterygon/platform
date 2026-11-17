// A query tab (DBee spec §3.6): toolbar (connection picker, Run, Cancel, row limit, Export), the
// SqlEditor above the results panel in a vertical Resizable. Ctrl+Enter runs the selection or the
// statement under the cursor (one statement per run, Decision 11); query.classify first, and a
// Destructive classification is confirmed (Decision 12).
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { NumberInput } from "@/components/ui/number-input";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { SqlEditor, type SqlMarker, type SqlRun, splitSqlStatements } from "@/components/ui/sql-editor";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ConnectionSummary } from "@/gen/api";
import { PlayIcon, StopIcon } from "../icons";
import { type Shell, ACTIONS, bindingsOf, displayBinding } from "../shortcuts";
import type { Tab } from "../store";
import { ResultsPanel } from "./ResultsPanel";

export interface QueryTabProps {
  tab: Tab;
  connections: readonly ConnectionSummary[];
  shell: Shell;
  splitSizes: number[];
  onSplitSizes: (sizes: number[]) => void;
  onChange: (patch: { sql?: string; connectionId?: string | null; maxRows?: number | null; statementsInRun?: number; columnWidths?: Record<string, number> }) => void;
  /** Runs the text; the caller classifies and confirms. */
  onRun: (sql: string) => void;
  onCancel: () => void;
  onExport: () => void;
  onRemedy: (remedy: string) => void;
  settings: { editorFontSize: number; tabSize: number; wordWrap: boolean; screenReaderOptimized: boolean };
  /** Focus requests from F6 / the palette. */
  focusEditorSignal: number;
}

export function QueryTab({ tab, connections, shell, splitSizes, onSplitSizes, onChange, onRun, onCancel, onExport, onRemedy, settings, focusEditorSignal }: QueryTabProps) {
  const running = tab.run?.status === "running";
  const editorRef = useRef<HTMLDivElement>(null);
  const markers: SqlMarker[] = tab.run?.status === "error" && tab.run.error?.position !== undefined ? [{ start: Math.max(0, tab.run.error.position - 1), message: tab.run.error.title, severity: "error" }] : [];
  const binding = (id: (typeof ACTIONS)[number]["id"]) => displayBinding(bindingsOf(ACTIONS.find((a) => a.id === id)!, shell)[0] ?? "");

  useEffect(() => {
    if (focusEditorSignal > 0) editorRef.current?.querySelector<HTMLElement>("textarea, [role=textbox]")?.focus();
  }, [focusEditorSignal]);

  const run = (r?: SqlRun) => {
    const text = r ? r.text : tab.sql;
    const statements = r ? r.statements : splitSqlStatements(tab.sql);
    const first = statements[0];
    if (!first) return;
    onChange({ statementsInRun: statements.length });
    // One statement per run: the first of a multi-statement selection (spec §3.6).
    onRun(statements.length > 1 ? first.text : text);
  };
  const statementCount = tab.statementsInRun;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar aria-label="Query" className="shrink-0 rounded-none border-x-0 border-t-0">
        <ToolbarGroup>
          <Select
            aria-label="Connection"
            size="small"
            placeholder="Choose a connection"
            items={connections.map((c) => ({ value: c.id, label: c.name }))}
            value={tab.connectionId}
            onValueChange={(v) => onChange({ connectionId: v })}
            className="w-panel-xs"
          >
            {connections.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </Select>
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <ToolbarButton render={<Button appearance="primary" size="small" />} disabled={running || tab.connectionId === null || tab.sql.trim() === ""} onClick={() => run()}>
                  <PlayIcon className="size-icon-sm" /> {statementCount > 1 ? "Run first statement" : "Run"}
                </ToolbarButton>
              }
            />
            <TooltipContent>Run selection or statement under cursor ({binding("run")})</TooltipContent>
          </Tooltip>
          {running ? (
            <ToolbarButton render={<Button appearance="secondary" size="small" />} onClick={onCancel}>
              <StopIcon className="size-icon-sm" /> Cancel <Kbd>Shift+Esc</Kbd>
            </ToolbarButton>
          ) : null}
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup className="items-center gap-inline-xs">
          <span className="text-caption text-fg-muted">Row limit</span>
          {/* eslint-disable-next-line byterygon/no-arbitrary-value -- the row limit and its steppers: a width in characters, which no token measures */}
          <NumberInput aria-label="Row limit (blank is unlimited)" size="small" value={tab.maxRows} onValueChange={(v) => onChange({ maxRows: v })} min={1} placeholder="unlimited" className="w-[12ch]" />
        </ToolbarGroup>
        <ToolbarSeparator />
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="subtle" size="small" />} disabled={tab.connectionId === null || tab.sql.trim() === ""} onClick={onExport}>
            Export
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      <Resizable orientation="vertical" sizes={splitSizes} onSizesChange={onSplitSizes} className="min-h-0 flex-1" aria-label="Editor and results">
        <ResizablePanel minSize={15}>
          <div ref={editorRef} className="dbee-editor-pane h-full" data-pane="editor" style={{ fontSize: settings.editorFontSize }}>
            <SqlEditor
              variant="ghost"
              className="h-full"
              aria-label="SQL editor"
              value={tab.sql}
              onValueChange={(sql) => onChange({ sql, statementsInRun: splitSqlStatements(sql).length > 1 ? tab.statementsInRun : 1 })}
              onRun={run}
              markers={markers}
              screenReaderOptimized={settings.screenReaderOptimized}
              placeholder="select …"
            />
          </div>
        </ResizablePanel>
        <ResizableHandle aria-label="Resize editor and results" withGrip />
        <ResizablePanel minSize={15}>
          <ResultsPanel run={tab.run} onExport={onExport} onCancel={onCancel} onRemedy={onRemedy} columnWidths={tab.columnWidths} onColumnWidths={(columnWidths) => onChange({ columnWidths })} />
        </ResizablePanel>
      </Resizable>
    </div>
  );
}
