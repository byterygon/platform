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
  disposed = false;
  readonly listeners = new Set<Listener>();
  constructor(value: string, language: string) {
    this.value = value;
    this.language = language;
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

class FakeEditor {
  readonly textarea: HTMLTextAreaElement;
  readonly model: FakeModel;
  options: Record<string, unknown>;
  readonly actions: Action[] = [];
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
  /** Clears per-test state; themes stay, as Monaco's do for the page's lifetime. */
  reset() {
    this.markers = [];
    this.editors = [];
  },
};

export const editor = {
  defineTheme(name: string, data: unknown) {
    fake.themes.set(name, data);
  },
  setTheme(name: string) {
    fake.theme = name;
  },
  createModel(value: string, language: string) {
    return new FakeModel(value, language);
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

/** The `?worker` import's default export. */
export default class FakeWorker {}
