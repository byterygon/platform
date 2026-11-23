import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { Button } from "@/components/button/button";
import { CodeBlock } from "@/components/code-block/code-block";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuShortcut, ContextMenuTrigger } from "@/components/context-menu/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/dropdown-menu/dropdown-menu";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { SearchInput } from "@/components/search-input/search-input";
import { ToggleGroup, ToggleGroupItem } from "@/components/toggle-group/toggle-group";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/toolbar/toolbar";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ChevronDown, ChevronRight, ChevronUp, Copy, Dismiss, Search, TextWrap } from "@/lib/icons";
import { tokenPx } from "@/lib/theme-scope";

// Explore a JSON value (DBee's cell value viewer for json and jsonb, a plugin manifest, every
// payload, inspect and schema of Mightyconsole) as a tree or as text, with one toolbar for both
// (TSK-112): Copy (the whole value, formatted or minified), Expand all, Collapse all, Expand to
// depth N, Find, a Tree | Text switch, and an `actions` slot for the tool's own buttons.
//
// Tree: objects and arrays expand and collapse, values show in the syntax.* colours the editors
// use. It follows the ARIA treeview pattern with one tab stop and aria-activedescendant (as Tree
// does) and is virtualized: rows of size.control.xs, only those in view are rendered, so an array
// of 100,000 items expanded stays fast. A row has a context menu (Copy value, Copy path in jq
// style such as .items[0].id, Copy key) and the keys Mod+C, Mod+Shift+C and Mod+Alt+C. Expand all
// opens at most `maxExpandRows` rows and says so when it stopped.
//
// Text: the value pretty-printed once and shown by CodeBlock (editor colours, line numbers, wrap
// up to 1,000 lines, virtualized beyond), selectable as plain text.
//
// Find (Mod+F in the viewer, the same in both modes): keys and values in the tree, the text in
// Text, with the count (3 of 17), next and previous, and case sensitivity. The tree searches the
// value, not the DOM: only the ancestors of the current match are expanded, matching rows in view
// are marked. Pass `value` (parsed) or `text` (parsed here; an error row explains invalid JSON).
// Strings are cut at `maxStringLength` characters in a row; the full value stays in its title.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const jsonViewerVariants = {} as const;

type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

interface Row {
  path: string;
  key: string | number | null;
  value: unknown;
  kind: Kind;
  depth: number;
  size: number;
  setSize: number;
  posInSet: number;
  parent: string | null;
}

/** Which view the viewer shows. */
export type JsonViewerMode = "tree" | "text";

/** What a copy put on the clipboard. */
export type JsonViewerCopyKind = "value" | "path" | "key" | "formatted" | "minified";

const classes = {
  root: "relative flex w-full min-w-0 flex-col overflow-hidden rounded-lg border border-border-subtle bg-editor font-mono text-code-sm text-editor-fg data-invalid:border-danger-border",
  toolbar: "shrink-0 flex-wrap gap-y-0",
  find: "flex shrink-0 flex-wrap items-center gap-inline-sm border-b border-border-subtle bg-layer px-inset-sm py-inset-xs font-sans",
  findInput: "min-w-0 flex-1 basis-panel-xs",
  findCount: "min-w-0 shrink-0 text-caption-1 text-fg-muted tabular-nums",
  body: "relative flex min-h-0 flex-1 flex-col",
  tree: ["relative min-h-0 flex-1 overflow-auto overscroll-contain", focusRing],
  text: "min-h-0 flex-1 rounded-none border-0",
  row: [
    "absolute inset-x-0 flex h-control-xs cursor-default items-center gap-inline-xs pe-inset-sm whitespace-nowrap",
    "hover:bg-hover data-match:bg-editor-match data-active:bg-editor-line data-current-match:bg-editor-selection",
    "in-focus-visible:data-active:outline-solid in-focus-visible:data-active:outline-[length:var(--by-ring-width)] in-focus-visible:data-active:-outline-offset-[var(--by-ring-width)] in-focus-visible:data-active:outline-ring",
  ],
  chevron: "flex size-icon-sm shrink-0 items-center justify-center text-editor-gutter transition-transform duration-[var(--by-motion-duration-faster)] ease-easy-ease motion-reduce:transition-none data-expanded:rotate-90 [&_svg]:size-icon-xs",
  spacer: "size-icon-sm shrink-0",
  key: "shrink-0 text-syntax-identifier",
  index: "shrink-0 text-editor-gutter",
  colon: "shrink-0 text-syntax-operator",
  summary: "shrink-0 text-editor-gutter",
  value: {
    string: "min-w-0 truncate text-syntax-string",
    number: "min-w-0 truncate text-syntax-number",
    boolean: "min-w-0 truncate text-syntax-constant",
    null: "min-w-0 truncate text-syntax-constant",
  },
  error: "flex items-start gap-inline-xs p-inset-sm font-sans text-body-1 text-danger-fg",
  notice: "shrink-0 border-t border-border-subtle bg-layer px-inset-sm py-inset-xs font-sans text-caption-1 text-fg-muted",
  status: "sr-only",
  toggle: "data-pressed:bg-selected",
} as const;

const kindOf = (value: unknown): Kind =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value === "string" ? "string" : typeof value === "number" || typeof value === "bigint" ? "number" : typeof value === "boolean" ? "boolean" : "null";

const pointer = (parent: string, key: string | number) => `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

const entries = (value: unknown): [string | number, unknown][] => (Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>));

const isContainer = (value: unknown) => value !== null && typeof value === "object";

/** The visible rows for the expanded set (paths are JSON Pointers; the root is ""). Exported for tests. */
export function flattenJson(value: unknown, expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const visit = (key: string | number | null, item: unknown, path: string, depth: number, setSize: number, posInSet: number, parent: string | null) => {
    const kind = kindOf(item);
    const children = kind === "object" || kind === "array" ? entries(item) : [];
    rows.push({ path, key, value: item, kind, depth, size: children.length, setSize, posInSet, parent });
    if (children.length && expanded.has(path)) children.forEach(([k, v], i) => visit(k, v, pointer(path, k), depth + 1, children.length, i + 1, path));
  };
  visit(null, value, "", 1, 1, 1, null);
  return rows;
}

/** What opening containers to a depth gave: the open paths and, when the row cap stopped it, the rows shown of all of them. */
interface Expansion {
  open: Set<string>;
  capped: { shown: number; total: number } | null;
}

const countNodes = (value: unknown): number => {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length) {
    const item = stack.pop();
    count += 1;
    if (isContainer(item)) for (const child of Array.isArray(item) ? item : Object.values(item as object)) stack.push(child);
  }
  return count;
};

/**
 * The container paths down to `depth` levels (1 opens the root), in document order, while the rows
 * shown stay within `cap`: a container that would go past it stays closed, and `capped` says how
 * many rows are shown of how many exist. Exported for tests.
 */
export function expandJson(value: unknown, depth: number, cap: number): Expansion {
  const open = new Set<string>();
  let shown = 1;
  let skipped = false;
  const stack: { item: unknown; path: string; level: number }[] = [{ item: value, path: "", level: 1 }];
  while (stack.length) {
    const { item, path, level } = stack.pop()!;
    if (!isContainer(item) || level > depth) continue;
    const children = entries(item);
    if (children.length === 0) continue;
    if (shown + children.length > cap) {
      skipped = true;
      continue;
    }
    open.add(path);
    shown += children.length;
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ item: children[i]![1], path: pointer(path, children[i]![0]), level: level + 1 });
  }
  return { open, capped: skipped ? { shown, total: countNodes(value) } : null };
}

/** The value a JSON Pointer names, or undefined. */
function valueAtPointer(value: unknown, path: string): unknown {
  let current = value;
  if (path === "") return current;
  for (const raw of path.slice(1).split("/")) {
    if (!isContainer(current)) return undefined;
    current = (current as Record<string, unknown>)[raw.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A JSON Pointer as the jq path that reads it: `.items[0].id`, `.["a b"]`, `.` for the root. Exported for tests. */
export function jqPath(value: unknown, path: string): string {
  if (path === "") return ".";
  let out = "";
  let current = value;
  for (const raw of path.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) out += out === "" ? `.[${key}]` : `[${key}]`;
    else if (IDENTIFIER.test(key)) out += `.${key}`;
    else out += out === "" ? `.[${JSON.stringify(key)}]` : `[${JSON.stringify(key)}]`;
    current = isContainer(current) ? (current as Record<string, unknown>)[key] : undefined;
  }
  return out;
}

/** The key of the last step of a JSON Pointer ("" for the root). */
const keyOfPointer = (path: string) => (path === "" ? "" : path.slice(path.lastIndexOf("/") + 1).replace(/~1/g, "/").replace(/~0/g, "~"));

/** Every container above a path (the root included), outermost first. */
function ancestorsOf(path: string): string[] {
  const out = [""];
  for (let i = path.indexOf("/", 1); i !== -1; i = path.indexOf("/", i + 1)) out.push(path.slice(0, i));
  return out.filter((p) => p !== path);
}

/** One match of the tree's find: the row's path. */
interface Hit {
  path: string;
}

/** The most matches a find lists; past it the count reads "N+" and the rest are not listed. */
export const MAX_MATCHES = 100_000;

/**
 * The rows whose key or value contains `needle`, in document order. It walks the value (not the
 * DOM), builds a path only for a match, and stops at `limit`. Array indexes are not keys.
 */
export function findInJson(value: unknown, needle: string, matchCase: boolean, limit = MAX_MATCHES): { hits: Hit[]; capped: boolean } {
  const hits: Hit[] = [];
  if (needle === "") return { hits, capped: false };
  const want = matchCase ? needle : needle.toLowerCase();
  const has = (text: string) => (matchCase ? text : text.toLowerCase()).includes(want);
  interface Node {
    parent: Node | null;
    key: string | number | null;
    item: unknown;
  }
  const pathOf = (node: Node): string => {
    const keys: (string | number)[] = [];
    for (let n: Node | null = node; n && n.key !== null; n = n.parent) keys.push(n.key);
    let out = "";
    for (let i = keys.length - 1; i >= 0; i -= 1) out = pointer(out, keys[i]!);
    return out;
  };
  const stack: Node[] = [{ parent: null, key: null, item: value }];
  while (stack.length) {
    const node = stack.pop()!;
    const { item, key } = node;
    const kind = kindOf(item);
    const matched = (typeof key === "string" && has(key)) || (kind !== "object" && kind !== "array" && has(String(item)));
    if (matched) {
      if (hits.length >= limit) return { hits, capped: true };
      hits.push({ path: pathOf(node) });
    }
    if (kind === "object" || kind === "array") {
      const children = entries(item);
      for (let i = children.length - 1; i >= 0; i -= 1) stack.push({ parent: node, key: children[i]![0], item: children[i]![1] });
    }
  }
  return { hits, capped: false };
}

/** Where `needle` occurs in `text`, not overlapping, at most `limit` times. Exported for tests. */
export function findInText(text: string, needle: string, matchCase: boolean, limit = MAX_MATCHES): { starts: number[]; capped: boolean } {
  const starts: number[] = [];
  if (needle === "") return { starts, capped: false };
  const haystack = matchCase ? text : text.toLowerCase();
  const want = matchCase ? needle : needle.toLowerCase();
  for (let at = haystack.indexOf(want); at !== -1; at = haystack.indexOf(want, at + want.length)) {
    if (starts.length >= limit) return { starts, capped: true };
    starts.push(at);
  }
  return { starts, capped: false };
}

const display = (value: unknown, kind: Kind, max: number): string => {
  if (kind === "string") {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return String(value);
};

const stringify = (value: unknown, space?: number): string => {
  try {
    return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item), space) ?? "undefined";
  } catch {
    return String(value);
  }
};

/** What Copy value puts on the clipboard: a string as its text, anything else as formatted JSON. */
const copyText = (item: unknown) => (typeof item === "string" ? item : stringify(item, 2));

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

/** Lines of text above which CodeBlock virtualizes (its default), so wrapping is off. */
const TEXT_VIRTUALIZE_AFTER = 1000;

const DEPTHS = [1, 2, 3, 4, 5] as const;

export interface JsonViewerProps {
  /** The value to show, already parsed. */
  value?: unknown;
  /** JSON text to parse and show (instead of `value`). */
  text?: string;
  /** Levels open at first (1: the root's children are listed; Infinity: everything), within `maxExpandRows`. */
  defaultExpandDepth?: number;
  /** The tree's accessible name. */
  "aria-label"?: string;
  /** Called when the active row changes, with its JSON Pointer and value. */
  onActiveChange?: (path: string, value: unknown) => void;
  /** Characters of a string shown in its row (the full value is in the row's title). */
  maxStringLength?: number;
  /** Rows rendered above and below the visible ones. */
  overscan?: number;
  /** Shown when `text` is not valid JSON, before the parser's message. */
  invalidText?: ReactNode;
  /** The view: the tree or the pretty-printed text. Controlled; pair it with `onModeChange`. */
  mode?: JsonViewerMode;
  /** The view at first when `mode` is not given (a payload read as text starts in "text"). */
  defaultMode?: JsonViewerMode;
  /** Called when the Tree | Text switch changes the view, so the app can remember the choice. */
  onModeChange?: (mode: JsonViewerMode) => void;
  /** Shows the toolbar (Copy, Expand all, Collapse all, Depth, Find, wrap, Tree | Text). Find stays on Mod+F without it. */
  toolbar?: boolean;
  /** The tool's own buttons, at the end of the toolbar (put ToolbarButtons or ToolbarGroups in). */
  actions?: ReactNode;
  /** The most rows Expand all, Expand to depth and `defaultExpandDepth` open; the viewer says when it stopped there. */
  maxExpandRows?: number;
  /** Called after something was copied, with what and the text. */
  onCopy?: (kind: JsonViewerCopyKind, text: string) => void;
  /** Extra classes (give it a height: h-panel-sm, or h-full in a sized panel), merged after the component's own. */
  className?: string;
  /** Reaches the tree element (null in text mode). */
  ref?: Ref<HTMLDivElement>;
}

/** A JSON value as a keyboard-navigable, virtualized tree (role="tree") or as text, with a toolbar and Find. */
export function JsonViewer({
  value: valueProp,
  text,
  defaultExpandDepth = 1,
  "aria-label": label = "JSON",
  onActiveChange,
  maxStringLength = 1000,
  overscan = 10,
  invalidText = "Not valid JSON:",
  mode: modeProp,
  defaultMode = "tree",
  onModeChange,
  toolbar = true,
  actions,
  maxExpandRows = 200_000,
  onCopy,
  className,
  ref,
}: JsonViewerProps) {
  const parsed = useMemo((): { ok: true; value: unknown } | { ok: false; error: string } => {
    if (text === undefined) return { ok: true, value: valueProp };
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, [text, valueProp]);
  const value = parsed.ok ? parsed.value : undefined;

  const [ownMode, setOwnMode] = useState<JsonViewerMode>(defaultMode);
  const mode = modeProp ?? ownMode;
  const changeMode = (next: JsonViewerMode) => {
    if (next === mode) return;
    setOwnMode(next);
    onModeChange?.(next);
  };

  const [expansion, setExpansion] = useState<Expansion>(() => expandJson(value, defaultExpandDepth, maxExpandRows));
  const expanded = expansion.open;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setExpansion(expandJson(value, defaultExpandDepth, maxExpandRows));
  }, [value, defaultExpandDepth, maxExpandRows]);
  const rows = useMemo(() => (parsed.ok ? flattenJson(value, expanded) : []), [parsed.ok, value, expanded]);

  const [activePath, setActivePath] = useState("");
  const activeIndex = Math.max(0, rows.findIndex((row) => row.path === activePath));
  const active = rows[activeIndex];

  const baseId = useId();
  const idFor = useCallback((index: number) => `${baseId}-row-${index}`, [baseId]);

  const root = useRef<HTMLDivElement | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, viewport: 0, rowHeight: 20 });
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      container.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );
  useEffect(() => {
    const element = container.current;
    if (!element) return undefined;
    const measure = () =>
      setView((previous) => {
        const next = { scrollTop: element.scrollTop, viewport: element.clientHeight, rowHeight: tokenPx(element, "--by-size-control-xs", previous.rowHeight) };
        return next.scrollTop === previous.scrollTop && next.viewport === previous.viewport && next.rowHeight === previous.rowHeight ? previous : next;
      });
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [parsed.ok, mode]);

  const { rowHeight } = view;
  const height = view.viewport || rowHeight * 30;
  const firstRow = Math.max(0, Math.floor(view.scrollTop / rowHeight) - overscan);
  const lastRow = Math.min(rows.length, Math.ceil((view.scrollTop + height) / rowHeight) + overscan);

  const scrollToIndex = (index: number) => {
    const element = container.current;
    if (!element) return;
    const top = index * rowHeight;
    const visible = element.clientHeight || height;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + visible) element.scrollTop = Math.max(0, top + rowHeight - visible);
    setView((previous) => ({ ...previous, scrollTop: element.scrollTop }));
  };

  const activate = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setActivePath(row.path);
    onActiveChange?.(row.path, row.value);
    scrollToIndex(rows.indexOf(row));
  };

  const toggle = (row: Row, open?: boolean) => {
    if (!row.size) return;
    setExpansion((previous) => {
      const next = new Set(previous.open);
      if (open ?? !next.has(row.path)) next.add(row.path);
      else next.delete(row.path);
      return { open: next, capped: null };
    });
  };

  // Copy.
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = useCallback(
    async (kind: JsonViewerCopyKind, textToCopy: string) => {
      try {
        await navigator.clipboard?.writeText(textToCopy);
        setCopied(`Copied ${kind === "formatted" ? "the value, formatted" : kind === "minified" ? "the value, minified" : kind === "value" ? "the value" : kind === "path" ? "the path" : "the key"}`);
        onCopy?.(kind, textToCopy);
      } catch {
        setCopied("");
      }
    },
    [onCopy],
  );
  const copyRow = (kind: "value" | "path" | "key", path: string) => {
    if (kind === "value") void copy("value", copyText(valueAtPointer(value, path)));
    else if (kind === "path") void copy("path", jqPath(value, path));
    else void copy("key", keyOfPointer(path));
  };

  // Expand and collapse.
  const expandTo = (depth: number) => setExpansion(expandJson(value, depth, maxExpandRows));
  const collapseAll = () => {
    setExpansion({ open: new Set(), capped: null });
    setActivePath("");
    if (container.current) container.current.scrollTop = 0;
  };

  // Find.
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [currentIndex, setCurrentIndex] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const findInput = useRef<HTMLInputElement | null>(null);
  const countId = useId();

  const pretty = useMemo(() => (mode === "text" && parsed.ok ? stringify(value, 2) : ""), [mode, parsed.ok, value]);
  const lineCount = useMemo(() => {
    let lines = 1;
    for (let i = pretty.indexOf("\n"); i !== -1; i = pretty.indexOf("\n", i + 1)) lines += 1;
    return lines;
  }, [pretty]);
  const [wrap, setWrap] = useState(false);
  const virtualText = lineCount > TEXT_VIRTUALIZE_AFTER;

  const searching = findOpen && deferredQuery !== "" && parsed.ok;
  const treeFind = useMemo(() => (searching && mode === "tree" ? findInJson(value, deferredQuery, matchCase) : { hits: [] as Hit[], capped: false }), [searching, mode, value, deferredQuery, matchCase]);
  const textFind = useMemo(() => (searching && mode === "text" ? findInText(pretty, deferredQuery, matchCase) : { starts: [] as number[], capped: false }), [searching, mode, pretty, deferredQuery, matchCase]);
  const matchCount = mode === "tree" ? treeFind.hits.length : textFind.starts.length;
  const capped = mode === "tree" ? treeFind.capped : textFind.capped;
  const current = matchCount === 0 ? -1 : Math.min(currentIndex, matchCount - 1);
  const matchPaths = useMemo(() => new Set(treeFind.hits.map((hit) => hit.path)), [treeFind]);
  const currentPath = mode === "tree" && current >= 0 ? treeFind.hits[current]!.path : null;

  useEffect(() => setCurrentIndex(0), [deferredQuery, matchCase, mode]);

  // The current match of the tree: its ancestors open, it is active and scrolled to.
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (currentPath === null) return;
    const need = ancestorsOf(currentPath);
    setExpansion((previous) => (need.every((p) => previous.open.has(p)) ? previous : { open: new Set([...previous.open, ...need]), capped: previous.capped }));
    setActivePath(currentPath);
    setReveal((n) => n + 1);
  }, [currentPath]);
  useEffect(() => {
    if (reveal === 0 || currentPath === null) return;
    const index = rows.findIndex((row) => row.path === currentPath);
    if (index >= 0) scrollToIndex(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the match changes or the rows it sits in appear
  }, [reveal, rows]);

  const step = (by: number) => {
    if (matchCount === 0) return;
    setCurrentIndex((((current < 0 ? 0 : current) + by) % matchCount + matchCount) % matchCount);
  };
  const openFind = () => {
    setFindOpen(true);
    requestAnimationFrame(() => {
      findInput.current?.focus();
      findInput.current?.select();
    });
  };
  const closeFind = () => {
    setFindOpen(false);
    const target = root.current?.querySelector<HTMLElement>('[role="tree"], [data-slot="code-block-scroller"]');
    target?.focus();
  };

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openFind();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const isOpen = expanded.has(active.path);
    const handled = () => event.preventDefault();
    const mod = isMac() ? event.metaKey : event.ctrlKey;
    if (mod && event.key.toLowerCase() === "c") {
      handled();
      copyRow(event.shiftKey ? "path" : event.altKey ? "key" : "value", active.path);
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    switch (event.key) {
      case "ArrowDown":
        handled();
        activate(activeIndex + 1);
        break;
      case "ArrowUp":
        handled();
        activate(activeIndex - 1);
        break;
      case "Home":
        handled();
        activate(0);
        break;
      case "End":
        handled();
        activate(rows.length - 1);
        break;
      case "ArrowRight":
        handled();
        if (active.size && !isOpen) toggle(active, true);
        else if (active.size) activate(activeIndex + 1);
        break;
      case "ArrowLeft":
        handled();
        if (active.size && isOpen) toggle(active, false);
        else if (active.parent !== null) activate(rows.findIndex((row) => row.path === active.parent));
        break;
      case "Enter":
      case " ":
        handled();
        toggle(active);
        break;
      case "F3":
        if (findOpen) {
          handled();
          step(event.shiftKey ? -1 : 1);
        }
        break;
      default:
        break;
    }
  };

  // The row the context menu is for: the one under the pointer, or the active one for the keyboard.
  const [menuPath, setMenuPath] = useState<string | null>(null);
  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const element = (event.target as HTMLElement).closest<HTMLElement>('[data-slot="json-viewer-row"]');
    const index = element ? Number(element.dataset.index) : activeIndex;
    const row = rows[index];
    if (!row) return;
    setMenuPath(row.path);
    activate(index);
  };

  if (!parsed.ok) {
    return (
      <div ref={root} data-slot="json-viewer" data-invalid="" role="alert" className={cn(classes.root, className)}>
        <p className={classes.error}>
          {invalidText} {parsed.error}
        </p>
      </div>
    );
  }

  const rendered: ReactNode[] = [];
  const indices = Array.from({ length: Math.max(0, lastRow - firstRow) }, (_, i) => firstRow + i);
  if (activeIndex < firstRow || activeIndex >= lastRow) indices.push(activeIndex);
  for (const index of indices) {
    const row = rows[index];
    if (!row) continue;
    const isOpen = expanded.has(row.path);
    const isContainerRow = row.kind === "object" || row.kind === "array";
    const summary = row.kind === "array" ? `[${row.size}]` : `{${row.size}}`;
    rendered.push(
      <div
        key={row.path || "(root)"}
        id={idFor(index)}
        role="treeitem"
        aria-level={row.depth}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={isContainerRow && row.size ? isOpen : undefined}
        aria-selected={index === activeIndex}
        data-slot="json-viewer-row"
        data-index={index}
        data-active={index === activeIndex ? "" : undefined}
        data-match={matchPaths.has(row.path) ? "" : undefined}
        data-current-match={row.path === currentPath ? "" : undefined}
        data-kind={row.kind}
        title={row.kind === "string" ? (row.value as string) : undefined}
        style={{ top: index * rowHeight, paddingInlineStart: `calc(${row.depth - 1} * var(--by-size-icon-sm) + var(--by-space-inset-xs))` }}
        onClick={() => {
          activate(index);
          if (isContainerRow) toggle(row);
        }}
        className={cn(classes.row)}
      >
        {isContainerRow && row.size ? (
          <span data-slot="json-viewer-chevron" data-expanded={isOpen ? "" : undefined} className={cn(classes.chevron)}>
            <Icon icon={ChevronRight} />
          </span>
        ) : (
          <span className={classes.spacer} />
        )}
        {row.key !== null ? (
          <span className="shrink-0">
            <span className={typeof row.key === "number" ? classes.index : classes.key}>{typeof row.key === "number" ? row.key : JSON.stringify(row.key)}</span>
            <span className={classes.colon}>:</span>
          </span>
        ) : null}
        {isContainerRow ? (
          <span className={classes.summary}>{summary}</span>
        ) : (
          <span className={classes.value[row.kind as "string" | "number" | "boolean" | "null"]}>{display(row.value, row.kind, maxStringLength)}</span>
        )}
      </div>,
    );
  }

  const modifier = isMac() ? "⌘" : "Ctrl+";
  const menuRow = menuPath === null ? undefined : rows.find((row) => row.path === menuPath);
  const notice = mode === "tree" && expansion.capped ? `Opened ${expansion.capped.shown.toLocaleString()} of ${expansion.capped.total.toLocaleString()} rows; the rest stay collapsed.` : "";
  const countText = deferredQuery === "" ? "" : matchCount === 0 ? "No matches" : `${current + 1} of ${matchCount.toLocaleString()}${capped ? "+" : ""}`;

  return (
    <div ref={root} data-slot="json-viewer" data-mode={mode} onKeyDown={onRootKeyDown} className={cn(classes.root, className)}>
      {toolbar ? (
        <Toolbar data-slot="json-viewer-toolbar" aria-label={`${label} tools`} variant="plain" className={cn(classes.toolbar)}>
          <ToolbarGroup>
            <DropdownMenu>
              <DropdownMenuTrigger render={<ToolbarButton aria-label="Copy the value" title="Copy the value" />}>
                <Icon icon={Copy} />
                <Icon icon={ChevronDown} size="xs" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={() => void copy("formatted", stringify(value, 2))}>Copy formatted</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void copy("minified", stringify(value))}>Copy minified</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </ToolbarGroup>
          {mode === "tree" ? (
            <ToolbarGroup>
              <ToolbarButton onClick={() => expandTo(Infinity)}>Expand all</ToolbarButton>
              <ToolbarButton onClick={collapseAll}>Collapse all</ToolbarButton>
              <DropdownMenu>
                <DropdownMenuTrigger render={<ToolbarButton aria-label="Expand to depth" title="Expand to depth" />}>
                  Depth
                  <Icon icon={ChevronDown} size="xs" />
                </DropdownMenuTrigger>
                <DropdownMenuContent>
                  {DEPTHS.map((depth) => (
                    <DropdownMenuItem key={depth} onClick={() => expandTo(depth)}>
                      {depth === 1 ? "1 level" : `${depth} levels`}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </ToolbarGroup>
          ) : (
            <ToolbarGroup>
              <ToolbarButton
                aria-pressed={wrap && !virtualText}
                disabled={virtualText}
                title={virtualText ? `Lines are not wrapped above ${TEXT_VIRTUALIZE_AFTER.toLocaleString()} lines` : "Wrap long lines"}
                aria-label="Wrap lines"
                data-pressed={wrap && !virtualText ? "" : undefined}
                onClick={() => setWrap((on) => !on)}
                className={classes.toggle}
              >
                <Icon icon={TextWrap} />
              </ToolbarButton>
            </ToolbarGroup>
          )}
          <ToolbarSeparator />
          <ToolbarGroup>
            <ToolbarButton aria-label="Find" aria-pressed={findOpen} data-pressed={findOpen ? "" : undefined} title={`Find (${modifier}F)`} onClick={() => (findOpen ? closeFind() : openFind())} className={classes.toggle}>
              <Icon icon={Search} />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToggleGroup aria-label="View" appearance="outline" size="small" value={[mode]} onValueChange={(next: string[]) => next[0] && changeMode(next[0] as JsonViewerMode)}>
            <ToggleGroupItem value="tree" render={<ToolbarPrimitive.Button />}>
              Tree
            </ToggleGroupItem>
            <ToggleGroupItem value="text" render={<ToolbarPrimitive.Button />}>
              Text
            </ToggleGroupItem>
          </ToggleGroup>
          {actions ? (
            <>
              <ToolbarSeparator />
              {actions}
            </>
          ) : null}
        </Toolbar>
      ) : null}
      {findOpen ? (
        <div data-slot="json-viewer-find" role="search" className={classes.find}>
          <SearchInput
            ref={findInput}
            size="small"
            aria-label={`Find in ${label}`}
            aria-describedby={countId}
            placeholder={mode === "tree" ? "Find a key or a value" : "Find in the text"}
            value={query}
            onValueChange={setQuery}
            className={classes.findInput}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "F3") {
                event.preventDefault();
                step(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape" && query === "") {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span id={countId} aria-live="polite" data-slot="json-viewer-count" className={classes.findCount}>
            {countText}
          </span>
          <IconButton appearance="subtle" size="small" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matchCount === 0} onClick={() => step(-1)}>
            <Icon icon={ChevronUp} />
          </IconButton>
          <IconButton appearance="subtle" size="small" aria-label="Next match" title="Next match (Enter)" disabled={matchCount === 0} onClick={() => step(1)}>
            <Icon icon={ChevronDown} />
          </IconButton>
          <Button appearance="subtle" size="small" aria-label="Match case" aria-pressed={matchCase} data-pressed={matchCase ? "" : undefined} title="Match case" onClick={() => setMatchCase((on) => !on)} className={classes.toggle}>
            Aa
          </Button>
          <IconButton appearance="subtle" size="small" aria-label="Close find" title="Close (Escape)" onClick={closeFind}>
            <Icon icon={Dismiss} />
          </IconButton>
        </div>
      ) : null}
      <div className={classes.body}>
        {mode === "text" ? (
          <CodeBlock
            code={pretty}
            language="json"
            appearance="editor"
            lineNumbers
            copyable={false}
            wrap={wrap}
            virtualizeAfter={TEXT_VIRTUALIZE_AFTER}
            aria-label={`${label}, as text`}
            marks={textFind.starts.length > 0 ? { starts: textFind.starts, length: deferredQuery.length } : undefined}
            currentMark={current >= 0 ? current : undefined}
            className={classes.text}
          />
        ) : (
          <ContextMenu>
            <ContextMenuTrigger
              ref={setRef}
              role="tree"
              tabIndex={0}
              aria-label={label}
              aria-activedescendant={active ? idFor(activeIndex) : undefined}
              data-slot="json-viewer-tree"
              onKeyDown={onKeyDown}
              onContextMenu={onContextMenu}
              className={cn(classes.tree)}
            >
              <div style={{ height: rows.length * rowHeight, position: "relative" }}>{rendered}</div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => menuRow && copyRow("value", menuRow.path)}>
                Copy value
                <ContextMenuShortcut>{modifier}C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onClick={() => menuRow && copyRow("path", menuRow.path)}>
                Copy path
                <ContextMenuShortcut>{modifier}⇧C</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem disabled={!menuRow || menuRow.path === ""} onClick={() => menuRow && copyRow("key", menuRow.path)}>
                Copy key
                <ContextMenuShortcut>{modifier}⌥C</ContextMenuShortcut>
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )}
      </div>
      {notice ? (
        <p data-slot="json-viewer-notice" className={classes.notice}>
          {notice}
        </p>
      ) : null}
      <span role="status" className={classes.status}>
        {copied}
      </span>
    </div>
  );
}
