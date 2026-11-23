// The Value tab's JSON view with a Query bar (Mightyconsole spec §5.6, TSK-113). The JSON view's
// toolbar has a Query button (its slot for a tool's actions) that opens a bar above the value: a
// one-line jq editor with the value's own fields and jq's builtins as suggestions, Run (Enter or
// Mod+Enter) and Cancel, Snippets for the common questions, the profile's recent programs, and
// Profile for an array of objects. The program runs on the server (`messaging.query`, §5.4.1);
// the results replace the value in the same view until Show value.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { JsonView } from "@/app/json-view";
import { Button } from "@/components/ui/button";
import { CodeEditor, type CodeMarker } from "@/components/ui/code-editor";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToolbarButton } from "@/components/ui/toolbar";
import type { QueryOutput } from "@/gen/api";
import { ChevronDown, Code, Dismiss, History, Play, Stop, Table as TableIcon } from "@/lib/icons";
import type { MonacoEditor } from "@/lib/monaco";
import { type ProfileResult, type ValueQuery, canProfile, placeholderRanges, profileProgram, recordsOf, snippetsFor, valueCompletion } from "./query";

export interface ValueExplorerProps {
  /** The value's JSON text, as shown. */
  text: string;
  /** The view's accessible name ("Value"). */
  label: string;
  query: ValueQuery;
  /** The JSON view's settings key. */
  modeKey: string;
  className?: string;
}

type Shown = { kind: "value" } | { kind: "results"; out: QueryOutput; jq: string } | { kind: "profile"; result: ProfileResult; out: QueryOutput; path: string };

interface QueryError {
  message: string;
  line?: number;
  column?: number;
}

/** What went wrong, from an Ambidex error's ToolError details. */
function queryError(e: unknown): QueryError {
  const err = e as { message?: string; details?: { message?: string; position?: { line?: number; column?: number } } } | null;
  const message = err?.details?.message ?? err?.message ?? String(e);
  const p = err?.details?.position;
  return { message, ...(p?.line ? { line: p.line } : {}), ...(p?.column ? { column: p.column } : {}) };
}

/** Bytes as text (MessageViewer's formatBytes, which this file cannot import without a cycle). */
const formatBytes = (n: number) => (n < 1024 ? `${Math.round(n)} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 / 1024).toFixed(1)} MiB`);

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "3 results · 1.2 KiB · 14 ms", with why a run returned early. */
export function resultLine(out: QueryOutput): string {
  const base = `${plural(out.count, "result")} · ${formatBytes(out.bytes)} · ${out.ms} ms on the server`;
  if (out.stopped === "output") return `${base}. Showing the first 1 MiB of results; the rest were left out.`;
  if (out.stopped === "deadline") return `${base}. Stopped at the time limit; it is in Settings.`;
  return base;
}

export function ValueExplorer({ text, label, query, modeKey, className }: ValueExplorerProps) {
  const value = useMemo(() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  }, [text]);
  const [open, setOpen] = useState(false);
  const [jq, setJq] = useState("");
  const [running, setRunning] = useState<AbortController | null>(null);
  const [error, setError] = useState<QueryError | null>(null);
  const [shown, setShown] = useState<Shown>({ kind: "value" });
  const editor = useRef<MonacoEditor | null>(null);
  const pendingSelect = useRef<[number, number][] | null>(null);
  const labelId = useId();
  const completion = useMemo(() => valueCompletion(value), [value]);
  const snippets = useMemo(() => snippetsFor(value), [value]);
  const records = useMemo(() => recordsOf(value), [value]);

  // A new message: back to its value, and stop what still runs for the old one.
  useEffect(() => {
    setShown({ kind: "value" });
    setError(null);
  }, [text]);
  useEffect(() => () => running?.abort(), [running]);

  // A snippet selects its placeholder once the editor shows its text.
  useEffect(() => {
    const ranges = pendingSelect.current;
    const ed = editor.current;
    if (!ranges || !ed) return;
    pendingSelect.current = null;
    const model = ed.getModel();
    if (!model) return;
    const toRange = ([a, b]: [number, number]) => {
      const s = model.getPositionAt(a);
      const e = model.getPositionAt(b);
      return { startLineNumber: s.lineNumber, startColumn: s.column, endLineNumber: e.lineNumber, endColumn: e.column };
    };
    const selections = ranges.map((r) => {
      const range = toRange(r);
      return { selectionStartLineNumber: range.startLineNumber, selectionStartColumn: range.startColumn, positionLineNumber: range.endLineNumber, positionColumn: range.endColumn };
    });
    const multi = (ed as { setSelections?: (s: typeof selections) => void }).setSelections;
    if (multi && selections.length > 1) multi.call(ed, selections);
    else if (ranges[0]) ed.setSelection(toRange(ranges[0]));
    ed.focus();
  }, [jq]);

  const runProgram = async (program: string, then: (out: QueryOutput) => void) => {
    running?.abort();
    const controller = new AbortController();
    setRunning(controller);
    setError(null);
    try {
      const out = await query.run(text, program, controller.signal);
      if (!controller.signal.aborted) then(out);
    } catch (e) {
      if (!controller.signal.aborted) setError(queryError(e));
    } finally {
      setRunning((r) => (r === controller ? null : r));
    }
  };

  const run = () => {
    const program = jq.trim();
    if (program === "") return;
    void runProgram(program, (out) => {
      setShown({ kind: "results", out, jq: program });
      query.remember(program);
    });
  };

  const profile = () => {
    if (!records) return;
    void runProgram(profileProgram(records.path), (out) => {
      const result = out.results[0] as ProfileResult | undefined;
      if (result && Array.isArray(result.fields)) setShown({ kind: "profile", result, out, path: records.path });
      else setError({ message: "The Profile gave no table." });
    });
  };

  const cancel = () => {
    running?.abort();
    setRunning(null);
  };

  const insert = (code: string, select: string) => {
    pendingSelect.current = placeholderRanges(code, select);
    setJq(code);
    setError(null);
  };

  const markers: CodeMarker[] = error?.line && error.column ? [{ line: error.line, column: error.column, message: error.message, severity: "error" }] : [];
  const results = shown.kind === "results" ? (shown.out.results.length === 1 ? shown.out.results[0] : shown.out.results) : undefined;

  const queryButton = (
    <ToolbarButton aria-pressed={open} aria-expanded={open} onClick={() => setOpen((o) => !o)} title="Query the value with jq (on the server)">
      <Icon icon={Code} /> Query
    </ToolbarButton>
  );

  return (
    <div data-slot="value-explorer" className={`flex min-h-0 flex-col ${className ?? ""}`}>
      {open ? (
        <form
          data-slot="query-bar"
          aria-label="Query"
          className="flex flex-wrap items-start gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs"
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <Field invalid={error !== null} className="min-w-panel-sm flex-1">
            <FieldLabel id={labelId} className="sr-only">
              jq program
            </FieldLabel>
            <CodeEditor
              singleLine
              size="small"
              language="jq"
              aria-labelledby={labelId}
              value={jq}
              onValueChange={(v) => {
                setJq(v);
                if (error) setError(null);
              }}
              onSubmit={run}
              completion={completion}
              markers={markers}
              invalid={error !== null}
              placeholder={records ? `${records.path === "." ? "" : records.path}[] | select(.${records.fields[0] ?? "id"} == 1)` : ".. | numbers"}
              onEditorReady={(ed) => {
                editor.current = ed;
              }}
            />
            {error ? (
              <FieldError match>
                {error.message}
                {error.line ? ` (line ${error.line}, column ${error.column})` : ""}
              </FieldError>
            ) : null}
          </Field>
          <div className="flex items-center gap-inline-sm">
            {running ? (
              <Button type="button" size="small" appearance="secondary" onClick={cancel}>
                <Icon icon={Stop} /> Cancel
              </Button>
            ) : (
              <Button type="submit" size="small" appearance="primary" disabled={jq.trim() === ""} title="Run (Enter)">
                <Icon icon={Play} /> Run
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" size="small" appearance="subtle" />}>
                Snippets <Icon icon={ChevronDown} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {snippets.map((s) => (
                  <DropdownMenuItem key={s.id} onClick={() => insert(s.code, s.select)} title={s.description}>
                    {s.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" size="small" appearance="subtle" disabled={query.recent.length === 0} />}>
                <Icon icon={History} /> Recent
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {query.recent.map((q) => (
                  <DropdownMenuItem key={q} onClick={() => insert(q, "")}>
                    <code className="max-w-panel-md truncate font-mono text-code">{q}</code>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {canProfile(value) ? (
              <Button type="button" size="small" appearance="subtle" onClick={profile} disabled={running !== null} title="Each field's types, nulls, distinct values and number ranges">
                <Icon icon={TableIcon} /> Profile
              </Button>
            ) : null}
          </div>
        </form>
      ) : null}
      {shown.kind !== "value" ? (
        <div className="flex items-center gap-inline-sm px-inset-sm py-inset-xs text-caption-1 text-fg-muted">
          <p role="status" className="min-w-0 flex-1">
            {shown.kind === "profile" ? `Profile of ${shown.path === "." ? "the array" : shown.path}: ${plural(shown.result.objects, "object")}${shown.result.others ? `, ${plural(shown.result.others, "other item")}` : ""}, ${plural(shown.result.fields.length, "field")}${shown.result.more ? ` (and ${shown.result.more.toLocaleString()} more not listed)` : ""} · ${shown.out.ms} ms on the server` : resultLine(shown.out)}
          </p>
          <Button size="small" appearance="subtle" onClick={() => setShown({ kind: "value" })}>
            <Icon icon={Dismiss} /> Show value
          </Button>
        </div>
      ) : null}
      {shown.kind === "profile" ? (
        <ProfileTable result={shown.result} />
      ) : shown.kind === "results" ? (
        <JsonView key={`results:${shown.jq}`} modeKey={modeKey} aria-label={`${label}: jq results`} value={results} defaultExpandDepth={2} className="min-h-0 flex-1" actions={queryButton} />
      ) : (
        <JsonView modeKey={modeKey} aria-label={label} text={text} defaultExpandDepth={2} className="min-h-0 flex-1" actions={queryButton} />
      )}
    </div>
  );
}

const fmt = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 4 }));

/** One row per field: types (with counts when mixed), present, nulls, distinct, and number ranges. */
function ProfileTable({ result }: { result: ProfileResult }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Table size="small" aria-label="Profile of the fields">
        <TableHeader>
          <TableRow>
            <TableHead>Field</TableHead>
            <TableHead>Types</TableHead>
            <TableHead align="end">Present</TableHead>
            <TableHead align="end">Nulls</TableHead>
            <TableHead align="end">Distinct</TableHead>
            <TableHead align="end">Min</TableHead>
            <TableHead align="end">Max</TableHead>
            <TableHead align="end">Average</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {result.fields.map((f) => (
            <TableRow key={f.field}>
              <TableCell className="font-mono text-code">{f.field}</TableCell>
              <TableCell>{f.types.length === 1 ? f.types[0]!.type : f.types.map((t) => `${t.type} ${t.count.toLocaleString()}`).join(", ")}</TableCell>
              <TableCell align="end">
                {f.present.toLocaleString()}
                {f.present < result.objects ? ` of ${result.objects.toLocaleString()}` : ""}
              </TableCell>
              <TableCell align="end">{f.nulls.toLocaleString()}</TableCell>
              <TableCell align="end">{f.distinct.toLocaleString()}</TableCell>
              <TableCell align="end">{f.numbers ? fmt(f.numbers.min) : ""}</TableCell>
              <TableCell align="end">{f.numbers ? fmt(f.numbers.max) : ""}</TableCell>
              <TableCell align="end">{f.numbers ? fmt(f.numbers.average) : ""}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
