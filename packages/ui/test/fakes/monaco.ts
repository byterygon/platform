// A small stand-in for the parts of Monaco that SqlEditor uses, for jsdom (vite.config.ts aliases
// every `monaco-editor/*` import here in tests). It renders a <textarea> where Monaco would, so
// the component's wiring (value, selection hand-over, Ctrl+Enter, markers, themes, options) is
// tested without a browser. The real editor runs in scripts/browser-check.ts.

interface Position {
  lineNumber: number;
  column: number;
}
interface Range {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}
type Listener = () => void;

export const KeyMod = { CtrlCmd: 2048, Shift: 1024, Alt: 512, WinCtrl: 256 };
export const KeyCode = { Enter: 3 };

class FakeModel {
  value: string;
  language: string;
  uri: { toString: () => string };
  disposed = false;
  readonly listeners = new Set<Listener>();
  constructor(value: string, language: string, uri?: { toString: () => string }) {
    this.value = value;
    this.language = language;
    this.uri = uri ?? { toString: () => `inmemory://model/${Math.random()}` };
  }
  getValue() {
    return this.value;
  }
  setValue(value: string) {
    this.value = value;
    for (const l of this.listeners) l();
  }
  getPositionAt(offset: number): Position {
    const before = this.value.slice(0, Math.max(0, Math.min(offset, this.value.length)));
    const lines = before.split("\n");
    return { lineNumber: lines.length, column: lines.at(-1)!.length + 1 };
  }
  getOffsetAt({ lineNumber, column }: Position): number {
    const lines = this.value.split("\n");
    let offset = 0;
    for (let i = 0; i < lineNumber - 1; i += 1) offset += lines[i]!.length + 1;
    return offset + column - 1;
  }
  getWordUntilPosition(position: Position) {
    const line = this.value.split("\n")[position.lineNumber - 1] ?? "";
    const before = line.slice(0, position.column - 1);
    const word = /[A-Za-z0-9_$]*$/.exec(before)![0];
    return { word, startColumn: position.column - word.length, endColumn: position.column };
  }
  isDisposed() {
    return this.disposed;
  }
  getFullModelRange(): Range {
    const end = this.getPositionAt(this.value.length);
    return { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column };
  }
  onDidChangeContent(listener: Listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  dispose() {
    this.disposed = true;
  }
}

interface Action {
  id: string;
  keybindings?: number[];
  run: () => void;
}
interface Command {
  keybinding: number;
  run: () => void;
  context: string | undefined;
}

class FakeEditor {
  readonly textarea: HTMLTextAreaElement;
  readonly model: FakeModel;
  options: Record<string, unknown>;
  readonly actions: Action[] = [];
  readonly commands: Command[] = [];
  /** Whether the suggest widget is open, for commands bound with `!suggestWidgetVisible`. */
  suggestVisible = false;
  readonly focusListeners = new Set<Listener>();
  readonly blurListeners = new Set<Listener>();
  disposed = false;
  constructor(container: HTMLElement, options: Record<string, unknown> & { model: FakeModel }) {
    this.model = options.model;
    this.options = { ...options };
    this.textarea = container.ownerDocument.createElement("textarea");
    this.textarea.setAttribute("aria-label", String(options.ariaLabel ?? ""));
    this.textarea.value = this.model.getValue();
    container.append(this.textarea);
    this.textarea.addEventListener("input", () => this.model.setValue(this.textarea.value));
    this.model.onDidChangeContent(() => {
      if (this.textarea.value !== this.model.value) this.textarea.value = this.model.value;
    });
    this.textarea.addEventListener("focus", () => this.focusListeners.forEach((l) => l()));
    this.textarea.addEventListener("blur", () => this.blurListeners.forEach((l) => l()));
    this.textarea.addEventListener("keydown", (event) => {
      const code = (event.ctrlKey || event.metaKey ? KeyMod.CtrlCmd : 0) | (event.key === "Enter" ? KeyCode.Enter : 0);
      for (const action of this.actions) if (action.keybindings?.includes(code)) action.run();
      for (const command of this.commands) {
        if (command.keybinding !== code) continue;
        if (command.context === "!suggestWidgetVisible" && this.suggestVisible) continue;
        event.preventDefault();
        command.run();
      }
    });
  }
  getModel() {
    return this.model;
  }
  getDomNode() {
    return this.textarea.parentElement;
  }
  focus() {
    this.textarea.focus();
  }
  setSelection(range: Range) {
    this.textarea.setSelectionRange(this.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }), this.model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }));
  }
  getSelection() {
    const start = this.model.getPositionAt(this.textarea.selectionStart);
    const end = this.model.getPositionAt(this.textarea.selectionEnd);
    return { getStartPosition: () => start, getEndPosition: () => end };
  }
  addCommand(keybinding: number, run: () => void, context?: string) {
    this.commands.push({ keybinding, run, context });
    return String(this.commands.length);
  }
  addAction(action: Action) {
    this.actions.push(action);
    return { dispose: () => this.actions.splice(this.actions.indexOf(action), 1) };
  }
  updateOptions(options: Record<string, unknown>) {
    this.options = { ...this.options, ...options };
    if (typeof options.ariaLabel === "string") this.textarea.setAttribute("aria-label", options.ariaLabel);
    this.textarea.readOnly = Boolean(this.options.readOnly);
  }
  executeEdits(_source: string, edits: { text: string }[]) {
    this.model.setValue(edits[0]!.text);
    return true;
  }
  /** Places the cursor (a 0-based offset) for completion tests. */
  cursorAt(offset: number) {
    this.textarea.setSelectionRange(offset, offset);
  }
  getPosition() {
    return this.model.getPositionAt(this.textarea.selectionStart);
  }
  onDidFocusEditorWidget(listener: Listener) {
    this.focusListeners.add(listener);
    return { dispose: () => this.focusListeners.delete(listener) };
  }
  onDidBlurEditorWidget(listener: Listener) {
    this.blurListeners.add(listener);
    return { dispose: () => this.blurListeners.delete(listener) };
  }
  dispose() {
    this.disposed = true;
    this.textarea.remove();
  }
}

/** What the tests inspect. */
export const fake = {
  themes: new Map<string, unknown>(),
  theme: undefined as string | undefined,
  markers: [] as unknown[],
  editors: [] as FakeEditor[],
  diffEditors: [] as FakeDiffEditor[],
  jsonOptions: undefined as Record<string, unknown> | undefined,
  /** Languages registered, with their Monarch grammar and configuration. */
  languages: new Map<string, { tokens?: unknown; configuration?: unknown }>(),
  /** Completion providers by language. */
  providers: [] as { language: string; provider: FakeCompletionProvider; disposed: boolean }[],
  /** What the fake language service reports (getModelMarkers), and who listens. */
  diagnostics: [] as unknown[],
  markerListeners: new Set<(uris: unknown[]) => void>(),
  /** Clears per-test state; themes stay, as Monaco's do for the page's lifetime. */
  reset() {
    this.providers = [];
    this.markers = [];
    this.editors = [];
    this.diffEditors = [];
    this.diagnostics = [];
  },
  /** Reports diagnostics as the JSON worker would. */
  report(diagnostics: unknown[]) {
    this.diagnostics = diagnostics;
    for (const l of this.markerListeners) l([]);
  },
};

export const editor = {
  defineTheme(name: string, data: unknown) {
    fake.themes.set(name, data);
  },
  setTheme(name: string) {
    fake.theme = name;
  },
  createModel(value: string, language: string, uri?: { toString: () => string }) {
    return new FakeModel(value, language, uri);
  },
  createDiffEditor(container: HTMLElement, options: Record<string, unknown>) {
    const diff = new FakeDiffEditor(container, options);
    fake.diffEditors.push(diff);
    return diff;
  },
  onDidChangeMarkers(listener: (uris: unknown[]) => void) {
    fake.markerListeners.add(listener);
    return { dispose: () => fake.markerListeners.delete(listener) };
  },
  getModelMarkers() {
    return fake.diagnostics;
  },
  create(container: HTMLElement, options: Record<string, unknown> & { model: FakeModel }) {
    const instance = new FakeEditor(container, options);
    fake.editors.push(instance);
    return instance;
  },
  setModelLanguage(model: FakeModel, language: string) {
    model.language = language;
  },
  setModelMarkers(_model: FakeModel, _owner: string, markers: unknown[]) {
    fake.markers = markers;
  },
};

class FakeDiffEditor {
  readonly container: HTMLElement;
  options: Record<string, unknown>;
  models: { original: FakeModel; modified: FakeModel } | null = null;
  modifiedEditor: FakeEditor | null = null;
  disposed = false;
  constructor(container: HTMLElement, options: Record<string, unknown>) {
    this.container = container;
    this.options = { ...options };
  }
  setModel(models: { original: FakeModel; modified: FakeModel }) {
    this.models = models;
    this.modifiedEditor = new FakeEditor(this.container, { ...this.options, model: models.modified });
    fake.editors.push(this.modifiedEditor);
  }
  getModifiedEditor() {
    return this.modifiedEditor!;
  }
  getOriginalEditor() {
    return this.modifiedEditor!;
  }
  updateOptions(options: Record<string, unknown>) {
    this.options = { ...this.options, ...options };
    this.modifiedEditor?.updateOptions(options);
  }
  dispose() {
    this.disposed = true;
    this.modifiedEditor?.dispose();
  }
}

interface FakeCompletionProvider {
  triggerCharacters?: string[];
  provideCompletionItems(model: FakeModel, position: Position, context: { triggerKind: number }): Promise<{ suggestions: unknown[] }> | { suggestions: unknown[] };
}

/** Asks the providers of an editor's language for suggestions at its cursor, as Ctrl+Space does. */
export async function suggest(target: FakeEditor, triggerKind = 0): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (const p of fake.providers) {
    if (p.disposed || p.language !== target.model.language) continue;
    const result = await p.provider.provideCompletionItems(target.model, target.getPosition(), { triggerKind });
    out.push(...(result.suggestions as Record<string, unknown>[]));
  }
  return out;
}

export const languages = {
  register({ id }: { id: string }) {
    if (!fake.languages.has(id)) fake.languages.set(id, {});
  },
  setMonarchTokensProvider(id: string, tokens: unknown) {
    fake.languages.set(id, { ...fake.languages.get(id), tokens });
  },
  setLanguageConfiguration(id: string, configuration: unknown) {
    fake.languages.set(id, { ...fake.languages.get(id), configuration });
  },
  registerCompletionItemProvider(language: string, provider: FakeCompletionProvider) {
    const entry = { language, provider, disposed: false };
    fake.providers.push(entry);
    return { dispose: () => (entry.disposed = true) };
  },
  CompletionItemKind: { Function: 1, Field: 3, Variable: 4, Operator: 11, Value: 13, Constant: 14, Keyword: 17, Reference: 21, TypeParameter: 24, Snippet: 27 },
  CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1 },
};

/** JSON's language service defaults (`monaco-editor/languages/features/json/register`). */
export const jsonDefaults = {
  setDiagnosticsOptions(options: Record<string, unknown>) {
    fake.jsonOptions = options;
  },
};

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
};

/** The `?worker` import's default export. */
export default class FakeWorker {}
