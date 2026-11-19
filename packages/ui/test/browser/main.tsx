// The page scripts/browser-check.ts drives in a real browser: a SqlEditor between two buttons, in
// a region whose data-theme and data-density the check flips, a second one beside it in the other
// mode, and CodeInputs (a one-line filter in a Field, a pretty JSON viewer) in a third region, all
// under a preset stylesheet the check swaps. `window.__check` is the check's handle; the measurements use performance.now(), which
// starts at navigation.
import { useState } from "react";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { CodeEditor, type CodeCompletion, type CodeDiagnostic } from "@/components/code-editor/code-editor";
import { CodeInput } from "@/components/code-input/code-input";
import { Field, FieldLabel } from "@/components/field/field";
import { SqlEditor, type SqlRun } from "@/components/sql-editor/sql-editor";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/table/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/tabs/tabs";
import { cssColorToHex, tokenReader, type Monaco, type MonacoEditor } from "@/lib/monaco";
import presetDefault from "@byterygon/design-tokens/presets/default/tokens.css?raw";
import presetHighContrast from "@byterygon/design-tokens/presets/high-contrast/tokens.css?raw";
import presetMidnight from "@byterygon/design-tokens/presets/midnight/tokens.css?raw";
import presetPaper from "@byterygon/design-tokens/presets/paper/tokens.css?raw";
import presetSlate from "@byterygon/design-tokens/presets/slate/tokens.css?raw";
import presetTerminal from "@byterygon/design-tokens/presets/terminal/tokens.css?raw";
import "./page.css";

const PRESETS: Record<string, string> = { default: presetDefault, "high-contrast": presetHighContrast, midnight: presetMidnight, paper: presetPaper, slate: presetSlate, terminal: presetTerminal };

const tokens = document.createElement("style");
tokens.id = "tokens";
tokens.textContent = presetDefault;
document.head.append(tokens);

const INITIAL = "select id, email from users where id = 1;\nselect count(*) from orders;\n";

interface Check {
  /** performance.now() when the fallback textarea was in the document. */
  fallbackAt: number;
  /** performance.now() when Monaco had mounted. */
  readyAt: number;
  ready: Promise<void>;
  /** Both editors have mounted. */
  bothReady: Promise<void>;
  changes: { at: number; length: number }[];
  runs: { at: number; run: SqlRun }[];
  editor?: MonacoEditor;
  monaco?: Monaco;
  setValue: (value: string) => void;
  setTheme: (theme: "light" | "dark") => void;
  setDensity: (density: "comfortable" | "compact") => void;
  setPreset: (preset: string) => void;
  presets: string[];
  /** CodeInput: Enter in the filter, and the viewer's value. */
  submits: string[];
  setViewer: (value: string) => void;
  /** The CodeMirror view of the n-th CodeInput on the page. */
  codeView: (index: number) => EditorView;
  /** CodeEditor (TSK-80): the JSON editor's text, and what its language service reported last. */
  setJson: (value: string) => void;
  jsonDiagnostics: CodeDiagnostic[] | null;
  jsonReady: boolean;
  /** TSK-94: the query field above a table (its suggest widget must paint over the sticky header) and a JSON field. */
  queryEditor?: MonacoEditor;
  fieldEditor?: MonacoEditor;
}

let resolveReady: () => void = () => {};
// Every Content-Security-Policy violation, so the check can serve the page under DBee's CSPs and
// prove nothing Monaco needs (its styles, worker, fonts, images) is blocked on an internal network.
const violations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) => violations.push(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"}${event.sourceFile ? ` (${event.sourceFile}:${event.lineNumber})` : ""}`));
(window as unknown as { __violations: string[] }).__violations = violations;

let resolveSecond: () => void = () => {};
const second = new Promise<void>((resolve) => (resolveSecond = resolve));
const check: Check = {
  fallbackAt: 0,
  readyAt: 0,
  ready: new Promise<void>((resolve) => (resolveReady = resolve)),
  bothReady: Promise.resolve(),
  changes: [],
  runs: [],
  setValue: () => {},
  // The second editor's region always takes the other mode, so both are checked side by side.
  setTheme: (theme) => {
    document.getElementById("region")!.setAttribute("data-theme", theme);
    document.getElementById("region-2")!.setAttribute("data-theme", theme === "light" ? "dark" : "light");
    document.getElementById("region-3")!.setAttribute("data-theme", theme);
    document.getElementById("region-5")!.setAttribute("data-theme", theme);
  },
  setDensity: (density) => {
    for (const id of ["region", "region-3", "region-5"]) document.getElementById(id)!.setAttribute("data-density", density);
  },
  setPreset: (preset) => {
    tokens.textContent = PRESETS[preset]!;
  },
  presets: Object.keys(PRESETS),
  submits: [],
  setViewer: () => {},
  codeView: (index) => EditorView.findFromDOM(document.querySelectorAll<HTMLElement>("[data-slot=code-input] .cm-editor")[index]!)!,
  setJson: () => {},
  jsonDiagnostics: null,
  jsonReady: false,
};
check.bothReady = Promise.all([check.ready, second]).then(() => {});
(window as unknown as { __check: Check }).__check = check;

/** What the editor shows, next to what the tokens of its region say it should show. */
function sample(index = 0) {
  const root = document.querySelectorAll<HTMLElement>("[data-slot=sql-editor]")[index]!;
  const reader = tokenReader(root);
  const rgb = (value: string) => cssColorToHex(value) ?? value;
  const keyword = [...root.querySelectorAll<HTMLElement>(".view-line span span")].find((s) => s.textContent === "select");
  const inactiveLine = root.querySelector(".line-numbers:not(.active-line-number)");
  const input = root.querySelector(".monaco-editor")?.querySelector<HTMLElement>(".native-edit-context, textarea") ?? null;
  const options = check.monaco!.editor.EditorOption;
  const result = {
    background: rgb(getComputedStyle(root.querySelector(".monaco-editor-background")!).backgroundColor),
    expectedBackground: reader.color("--by-editor-bg"),
    keyword: keyword ? rgb(getComputedStyle(keyword).color) : null,
    expectedKeyword: reader.color("--by-syntax-keyword"),
    lineNumber: inactiveLine ? rgb(getComputedStyle(inactiveLine).color) : null,
    expectedLineNumber: reader.color("--by-editor-gutter"),
    fontSize: check.editor!.getOption(options.fontSize),
    expectedFontSize: Number.parseFloat(reader.value("--by-text-code-size")),
    lineHeight: check.editor!.getOption(options.lineHeight),
    paddingTop: check.editor!.getOption(options.padding).top,
    expectedPadding: Math.round(Number.parseFloat(reader.value("--by-space-inset-sm"))),
    inputLabel: input?.getAttribute("aria-label") ?? null,
    inputRole: input?.getAttribute("role") ?? input?.tagName.toLowerCase() ?? null,
  };
  reader.dispose();
  return result;
}
(window as unknown as { __sample: typeof sample }).__sample = sample;

/** What the n-th CodeInput shows, next to what the tokens of its region say. */
function sampleCode(index: number) {
  const root = document.querySelectorAll<HTMLElement>("[data-slot=code-input]")[index]!;
  const reader = tokenReader(root);
  const rgb = (value: string) => cssColorToHex(value) ?? value;
  const spans = [...root.querySelectorAll<HTMLElement>(".cm-line span")];
  const keyword = spans.find((s) => s.textContent === "and");
  const string = spans.find((s) => s.textContent?.startsWith("'"));
  const content = root.querySelector<HTMLElement>(".cm-content")!;
  const result = {
    background: rgb(getComputedStyle(root).backgroundColor),
    expectedBackground: reader.color("--by-color-bg-layer-alt"),
    keyword: keyword ? rgb(getComputedStyle(keyword).color) : null,
    expectedKeyword: reader.color("--by-syntax-keyword"),
    string: string ? rgb(getComputedStyle(string).color) : null,
    expectedString: reader.color("--by-syntax-string"),
    fontSize: Number.parseFloat(getComputedStyle(content).fontSize),
    expectedFontSize: Number.parseFloat(reader.value("--by-text-code-size")),
    height: root.getBoundingClientRect().height,
    // How far the first line's middle is from the frame's middle (one line should be centred).
    offCentre: Math.abs((() => { const r = root.getBoundingClientRect(); const l = root.querySelector(".cm-line")!.getBoundingClientRect(); return l.top + l.height / 2 - (r.top + r.height / 2); })()),
    expectedHeight: Number.parseFloat(reader.value("--by-size-control-md")),
    label: content.getAttribute("aria-label") ?? (content.getAttribute("aria-labelledby") ? document.getElementById(content.getAttribute("aria-labelledby")!)?.textContent : null) ?? null,
  };
  reader.dispose();
  return result;
}
(window as unknown as { __sampleCode: typeof sampleCode }).__sampleCode = sampleCode;

/** TSK-94: the open suggest widget of region 5, whether it is on top of the table's sticky header, and its colours. */
function sampleWidgets() {
  const region = document.getElementById("region-5")!;
  const widget = document.querySelector<HTMLElement>("[data-slot=code-editor-overflow] .suggest-widget.visible")!;
  const rows = [...widget.querySelectorAll<HTMLElement>(".monaco-list-row")];
  const header = region.querySelector("thead th")!.getBoundingClientRect();
  const box = widget.getBoundingClientRect();
  let onTop = 0;
  for (const row of rows) {
    const r = row.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2);
    if (hit && widget.contains(hit)) onTop += 1;
  }
  const reader = tokenReader(region);
  const rgb = (value: string) => cssColorToHex(value) ?? value;
  const selected = widget.querySelector<HTMLElement>(".monaco-list-row.focused") ?? rows[0]!;
  const highlight = widget.querySelector<HTMLElement>(".monaco-list-row .highlight");
  const list = widget.querySelector<HTMLElement>(".monaco-list") ?? widget;
  const result = {
    rows: rows.length,
    onTop,
    overHeader: box.top < header.bottom && box.bottom > header.top,
    zIndex: getComputedStyle(widget).zIndex,
    background: rgb(getComputedStyle(widget).backgroundColor),
    selected: rgb(getComputedStyle(selected).backgroundColor),
    highlight: highlight ? rgb(getComputedStyle(highlight).color) : "",
    radius: getComputedStyle(list).borderTopLeftRadius,
    // The notes ("Int", "Keyword · custom", "recent") end at one right edge, as the mockup's do.
    noteEdges: [...new Set(rows.map((r) => r.querySelector(".details-label")).filter((d): d is HTMLElement => d !== null && d.getClientRects().length > 0).map((d) => Math.round(d.getBoundingClientRect().right / 4)))].length,
    expected: { background: reader.color("--by-elevation-flyout-bg"), selected: reader.color("--by-editor-selection"), highlight: reader.color("--by-color-fg-link") },
  };
  reader.dispose();
  return result;
}
(window as unknown as { __sampleWidgets: typeof sampleWidgets }).__sampleWidgets = sampleWidgets;

/**
 * Every colour computed in the editors of the page and their widgets (text, fills, strokes,
 * outlines, SVG fills) that is one of `defaults`, as "colour on selector" (TSK-94).
 */
function monacoDefaults(defaults: string[]) {
  const banned = new Set(defaults.map((d) => d.toLowerCase()));
  const found = new Set<string>();
  const props = ["color", "background-color", "border-top-color", "border-bottom-color", "border-left-color", "border-right-color", "outline-color", "fill", "stroke", "text-decoration-color"] as const;
  for (const root of document.querySelectorAll<HTMLElement>(".monaco-editor")) {
    for (const el of [root, ...root.querySelectorAll<HTMLElement>("*")]) {
      if (el.getClientRects().length === 0) continue;
      const style = getComputedStyle(el);
      for (const prop of props) {
        const hex = cssColorToHex(style.getPropertyValue(prop));
        if (hex && banned.has(hex.slice(0, 7))) found.add(`${hex} ${prop} on ${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join(".")}`);
      }
    }
  }
  return [...found];
}
(window as unknown as { __monacoDefaults: typeof monacoDefaults }).__monacoDefaults = monacoDefaults;

const ORDER_SCHEMA = { type: "object", properties: { id: { type: "string" }, status: { enum: ["PLACED", "PAID"] } }, required: ["id"], additionalProperties: false };

function Codes() {
  const [viewer, setViewer] = useState('{"id":42,"tags":["new","vip"],"active":true}');
  check.setViewer = setViewer;
  const [json, setJson] = useState('{ "id": "o-1", "status": "PAID" }');
  check.setJson = setJson;
  return (
    <div id="region-3" data-theme="light" data-density="comfortable" className="flex flex-col gap-stack-md bg-surface p-inset-md">
      <button id="before-code" type="button">Before code</button>
      <Field>
        <FieldLabel>Filter rows</FieldLabel>
        <CodeInput language="sql" defaultValue="id > 10 and status = 'active'" onSubmit={(v) => check.submits.push(v)} />
      </Field>
      <button id="after-code" type="button">After code</button>
      <CodeInput aria-label="Cell value" language="json" pretty value={viewer} className="max-h-panel-md" />
      <CodeEditor
        aria-label="Payload"
        value={json}
        onValueChange={setJson}
        jsonSchema={ORDER_SCHEMA}
        onDiagnosticsChange={(d) => (check.jsonDiagnostics = d)}
        onEditorReady={() => (check.jsonReady = true)}
      />
    </div>
  );
}

// TSK-94: a one-line query field with the app's suggestions right above a table whose sticky header
// (z.sticky) lies under the suggest widget, and a JSON field sized by rows with a schema.
const QUERY_COMPLETION: CodeCompletion = {
  provide: () => [
    { label: "ExecutionStatus", kind: "keyword-value", detail: "Keyword", documentation: { markdown: "**ExecutionStatus** · Keyword · built-in\n\nExample: `ExecutionStatus = \"Running\"`" } },
    { label: "ExecutionTime", kind: "date", detail: "Datetime" },
    { label: "ExecutionDuration", kind: "number", detail: "Int" },
    { label: "ExternalOrderId", kind: "keyword-value", detail: "Keyword · custom" },
    { label: 'ExecutionStatus = "Failed"', kind: "history", detail: "recent" },
    { label: "Slow orders", kind: "saved", detail: "saved", insertText: "ExecutionDuration > 60000" },
  ],
};
const FIELD_SCHEMA = { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, channel: { enum: ["email", "chat"] }, priority: { type: "integer", minimum: 1, maximum: 5 }, open: { type: "boolean" } } };

function Widgets() {
  return (
    <div id="region-5" data-theme="light" data-density="comfortable" className="flex flex-col gap-stack-md bg-surface p-inset-md">
      <CodeEditor singleLine language="plaintext" aria-label="Widget query" defaultValue="Ex" completion={QUERY_COMPLETION} onEditorReady={(editor) => (check.queryEditor = editor)} />
      <Table aria-label="Under the suggestions" className="h-panel-xs">
        <TableHeader>
          <TableRow>
            <TableHead>Start</TableHead>
            <TableHead>Close</TableHead>
            <TableHead>Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 12 }, (_, i) => (
            <TableRow key={i}>
              <TableCell>10:{String(i).padStart(2, "0")}</TableCell>
              <TableCell>10:{String(i + 1).padStart(2, "0")}</TableCell>
              <TableCell>{i + 1}m</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <CodeEditor aria-label="Widget input" rows={7} jsonSchema={FIELD_SCHEMA} defaultValue={'{\n  "customer_id": "c-1",\n  "messages": [{ "role": "human", "n": 1, "ok": true, "x": null }]\n}'} onEditorReady={(editor) => (check.fieldEditor = editor)} />
    </div>
  );
}

/** A tab strip too narrow for its tabs (TSK-90) and a native scroll container, for tabStrip(). */
function Strip() {
  const [active, setActive] = useState("1");
  const names = Array.from({ length: 10 }, (_, index) => String(index + 1));
  return (
    <div id="region-4" data-theme="light" data-density="comfortable" className="flex flex-col gap-stack-md bg-surface p-inset-md">
      <div id="tab-strip" className="w-panel-sm">
        <Tabs value={active} onValueChange={(value) => setActive(value as string)}>
          <TabsList aria-label="Query tabs">
            {names.map((name) => (
              <TabsTrigger key={name} value={name} onClose={() => {}}>
                Query {name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div id="scroller" tabIndex={0} className="h-panel-xs overflow-auto">
        <div className="h-panel-lg">A native scroll container: its scrollbar takes the theme.</div>
      </div>
    </div>
  );
}

function App() {
  const [value, setValue] = useState(INITIAL);
  check.setValue = setValue;
  return (
    <main className="flex flex-col gap-stack-md p-inset-lg">
      <button id="before" type="button">Before</button>
      <div id="region" data-theme="light" data-density="comfortable" className="bg-surface p-inset-md">
        <SqlEditor
          aria-label="Query"
          value={value}
          onValueChange={(next) => {
            check.changes.push({ at: performance.now(), length: next.length });
            setValue(next);
          }}
          onRun={(run) => check.runs.push({ at: performance.now(), run })}
          onEditorReady={(editor, monaco) => {
            check.editor = editor;
            check.monaco = monaco;
            check.readyAt = performance.now();
            resolveReady();
          }}
          className="h-panel-md"
        />
      </div>
      <button id="after" type="button">After</button>
      <div id="region-2" data-theme="dark" data-density="comfortable" className="bg-surface p-inset-md">
        <SqlEditor aria-label="Second query" readOnly defaultValue={"select 2;\nselect 3;\n"} onEditorReady={() => resolveSecond()} />
        <CodeInput aria-label="Second filter" language="sql" defaultValue="id > 10 and status = 'active'" className="mt-stack-md" />
      </div>
      <Codes />
      <Widgets />
      <Strip />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
requestAnimationFrame(() => {
  if (document.querySelector("[data-slot=sql-editor-fallback]")) check.fallbackAt = performance.now();
});
