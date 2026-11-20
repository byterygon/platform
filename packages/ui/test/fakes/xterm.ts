// A small fake of the xterm.js API the Terminal component uses (jsdom has no canvas and no layout).
// Every `@xterm/*` import (the stylesheet too) resolves here in tests (vite.config.ts). It records
// what the component asked for, so tests can type, resize and read the output. The real terminal
// is checked in Chromium by scripts/browser-check.ts.

type Listener<T> = (value: T) => void;

class Emitter<T> {
  private listeners = new Set<Listener<T>>();
  event = (listener: Listener<T>) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value: T) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

/** Every Terminal the fake has created, newest last. */
export const terminals: Terminal[] = [];

export class Terminal {
  options: Record<string, unknown>;
  cols = 80;
  rows = 24;
  element: HTMLElement | undefined;
  textarea: HTMLTextAreaElement | undefined;
  /** Everything written, in order. */
  written: (string | Uint8Array)[] = [];
  selection = "";
  pasted: string[] = [];
  disposed = false;
  cleared = 0;
  resets = 0;
  focused = 0;
  addons: unknown[] = [];
  keyHandler: ((event: KeyboardEvent) => boolean) | undefined;
  private data = new Emitter<string>();
  private binary = new Emitter<string>();
  private resize = new Emitter<{ cols: number; rows: number }>();
  onData = this.data.event;
  onBinary = this.binary.event;
  onResize = this.resize.event;

  constructor(options: Record<string, unknown> = {}) {
    this.options = { ...options };
    terminals.push(this);
  }
  open(parent: HTMLElement) {
    this.element = parent.ownerDocument.createElement("div");
    this.element.className = "xterm";
    this.textarea = parent.ownerDocument.createElement("textarea");
    this.element.append(this.textarea);
    parent.append(this.element);
  }
  loadAddon(addon: { activate?: (t: Terminal) => void }) {
    this.addons.push(addon);
    addon.activate?.(this);
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  write(data: string | Uint8Array) {
    this.written.push(data);
  }
  paste(text: string) {
    this.pasted.push(text);
    this.data.fire(text);
  }
  getSelection() {
    return this.selection;
  }
  focus() {
    this.focused += 1;
  }
  clear() {
    this.cleared += 1;
  }
  reset() {
    this.resets += 1;
  }
  dispose() {
    this.disposed = true;
    this.element?.remove();
  }
  /** Test helpers: what the user types, and a new size from the fit addon. */
  type(text: string) {
    if (this.keyHandler && text.length === 0) return;
    this.data.fire(text);
  }
  sendBinary(text: string) {
    this.binary.fire(text);
  }
  resizeTo(cols: number, rows: number) {
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resize.fire({ cols, rows });
  }
  /** The written output as text. */
  output() {
    const decoder = new TextDecoder();
    return this.written.map((d) => (typeof d === "string" ? d : decoder.decode(d))).join("");
  }
}

export class FitAddon {
  terminal: Terminal | undefined;
  fits = 0;
  /** The size the next fit gives. */
  static next: { cols: number; rows: number } = { cols: 100, rows: 30 };
  activate(terminal: Terminal) {
    this.terminal = terminal;
  }
  fit() {
    this.fits += 1;
    this.terminal?.resizeTo(FitAddon.next.cols, FitAddon.next.rows);
  }
  dispose() {}
}

export class SearchAddon {
  terminal: Terminal | undefined;
  queries: string[] = [];
  activate(terminal: Terminal) {
    this.terminal = terminal;
  }
  findNext(query: string) {
    this.queries.push(`next:${query}`);
    return this.terminal?.output().includes(query) ?? false;
  }
  findPrevious(query: string) {
    this.queries.push(`previous:${query}`);
    return this.terminal?.output().includes(query) ?? false;
  }
  dispose() {}
}

export default {};
