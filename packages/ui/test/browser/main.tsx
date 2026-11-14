// The page scripts/browser-check.ts drives in a real browser: a SqlEditor between two buttons, in
// a region whose data-theme and data-density the check flips, a second one beside it in the other
// mode, and CodeInputs (a one-line filter in a Field, a pretty JSON viewer) in a third region, all
// under a preset stylesheet the check swaps. `window.__check` is the check's handle; the measurements use performance.now(), which
// starts at navigation.
import { useState } from "react";
import { EditorView } from "@codemirror/view";
import { createRoot } from "react-dom/client";
import { CodeInput } from "@/components/code-input/code-input";
import { Field, FieldLabel } from "@/components/field/field";
import { SqlEditor, type SqlRun } from "@/components/sql-editor/sql-editor";
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
}

let resolveReady: () => void = () => {};
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
  },
  setDensity: (density) => {
    for (const id of ["region", "region-3"]) document.getElementById(id)!.setAttribute("data-density", density);
  },
  setPreset: (preset) => {
    tokens.textContent = PRESETS[preset]!;
  },
  presets: Object.keys(PRESETS),
  submits: [],
  setViewer: () => {},
  codeView: (index) => EditorView.findFromDOM(document.querySelectorAll<HTMLElement>("[data-slot=code-input] .cm-editor")[index]!)!,
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
    expectedBackground: reader.color("--by-color-bg-surface"),
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

function Codes() {
  const [viewer, setViewer] = useState('{"id":42,"tags":["new","vip"],"active":true}');
  check.setViewer = setViewer;
  return (
    <div id="region-3" data-theme="light" data-density="comfortable" className="flex flex-col gap-stack-md bg-surface p-inset-md">
      <button id="before-code" type="button">Before code</button>
      <Field>
        <FieldLabel>Filter rows</FieldLabel>
        <CodeInput language="sql" defaultValue="id > 10 and status = 'active'" onSubmit={(v) => check.submits.push(v)} />
      </Field>
      <button id="after-code" type="button">After code</button>
      <CodeInput aria-label="Cell value" language="json" pretty value={viewer} className="max-h-panel-md" />
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
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
requestAnimationFrame(() => {
  if (document.querySelector("[data-slot=sql-editor-fallback]")) check.fallbackAt = performance.now();
});
