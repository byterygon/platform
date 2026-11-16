import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ChevronRight } from "@/lib/icons";
import { tokenPx } from "@/lib/theme-scope";

// Explore a JSON value as a tree (DBee's cell value viewer for json and jsonb, a plugin
// manifest): objects and arrays expand and collapse, values show in the syntax.* colours the
// editors use. It follows the ARIA treeview pattern with one tab stop and aria-activedescendant
// (as Tree does) and is virtualized: rows of size.control.xs, only those in view are rendered,
// so an array of 100,000 items expanded stays fast. Pass `value` (parsed) or `text` (parsed
// here; an error row explains invalid JSON). Strings are cut at `maxStringLength` characters in
// the row; the full value stays in the row's title.

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

const classes = {
  root: [
    "relative w-full overflow-auto overscroll-contain rounded-lg border border-border-subtle bg-editor font-mono text-code-sm text-editor-fg data-invalid:border-danger-border",
    focusRing,
  ],
  row: [
    "absolute inset-x-0 flex h-control-xs cursor-default items-center gap-inline-xs pe-inset-sm whitespace-nowrap",
    "hover:bg-hover data-active:bg-editor-line",
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
} as const;

const kindOf = (value: unknown): Kind =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value === "string" ? "string" : typeof value === "number" || typeof value === "bigint" ? "number" : typeof value === "boolean" ? "boolean" : "null";

const pointer = (parent: string, key: string | number) => `${parent}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;

const entries = (value: unknown): [string | number, unknown][] => (Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>));

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

/** The container paths down to `depth` levels (1 opens the root). */
function initiallyExpanded(value: unknown, depth: number): Set<string> {
  const open = new Set<string>();
  const walk = (item: unknown, path: string, level: number) => {
    const kind = kindOf(item);
    if ((kind !== "object" && kind !== "array") || level > depth) return;
    open.add(path);
    if (level < depth) for (const [k, v] of entries(item)) walk(v, pointer(path, k), level + 1);
  };
  walk(value, "", 1);
  return open;
}

const display = (value: unknown, kind: Kind, max: number): string => {
  if (kind === "string") {
    const text = JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  }
  return String(value);
};

export interface JsonViewerProps {
  /** The value to show, already parsed. */
  value?: unknown;
  /** JSON text to parse and show (instead of `value`). */
  text?: string;
  /** Levels open at first (1: the root's children are listed; Infinity: everything). */
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
  /** Extra classes (give it a height: h-panel-sm, or h-full in a sized panel), merged after the component's own. */
  className?: string;
  /** Reaches the tree element. */
  ref?: Ref<HTMLDivElement>;
}

/** A JSON value as a keyboard-navigable, virtualized tree (role="tree"). */
export function JsonViewer({
  value: valueProp,
  text,
  defaultExpandDepth = 1,
  "aria-label": label = "JSON",
  onActiveChange,
  maxStringLength = 1000,
  overscan = 10,
  invalidText = "Not valid JSON:",
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

  const [expanded, setExpanded] = useState<Set<string>>(() => initiallyExpanded(value, defaultExpandDepth));
  useEffect(() => setExpanded(initiallyExpanded(value, defaultExpandDepth)), [value, defaultExpandDepth]);
  const rows = useMemo(() => (parsed.ok ? flattenJson(value, expanded) : []), [parsed.ok, value, expanded]);

  const [activePath, setActivePath] = useState("");
  const activeIndex = Math.max(0, rows.findIndex((row) => row.path === activePath));
  const active = rows[activeIndex];

  const baseId = useId();
  const idFor = useCallback((index: number) => `${baseId}-row-${index}`, [baseId]);

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
  }, [parsed.ok]);

  const { rowHeight } = view;
  const height = view.viewport || rowHeight * 30;
  const first = Math.max(0, Math.floor(view.scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((view.scrollTop + height) / rowHeight) + overscan);

  const activate = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setActivePath(row.path);
    onActiveChange?.(row.path, row.value);
    const element = container.current;
    if (!element) return;
    const top = rows.indexOf(row) * rowHeight;
    const visible = element.clientHeight || height;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + visible) element.scrollTop = top + rowHeight - visible;
    setView((previous) => ({ ...previous, scrollTop: element.scrollTop }));
  };

  const toggle = (row: Row, open?: boolean) => {
    if (!row.size) return;
    setExpanded((previous) => {
      const next = new Set(previous);
      const isOpen = next.has(row.path);
      if (open ?? !isOpen) next.add(row.path);
      else next.delete(row.path);
      return next;
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const isOpen = expanded.has(active.path);
    const handled = () => event.preventDefault();
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
      default:
        break;
    }
  };

  if (!parsed.ok) {
    return (
      <div ref={setRef} data-slot="json-viewer" data-invalid="" role="alert" className={cn(classes.root, className)}>
        <p className={classes.error}>
          {invalidText} {parsed.error}
        </p>
      </div>
    );
  }

  const rendered: ReactNode[] = [];
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
  if (activeIndex < first || activeIndex >= last) indices.push(activeIndex);
  for (const index of indices) {
    const row = rows[index];
    if (!row) continue;
    const isOpen = expanded.has(row.path);
    const container = row.kind === "object" || row.kind === "array";
    const summary = row.kind === "array" ? `[${row.size}]` : `{${row.size}}`;
    rendered.push(
      <div
        key={row.path || "(root)"}
        id={idFor(index)}
        role="treeitem"
        aria-level={row.depth}
        aria-setsize={row.setSize}
        aria-posinset={row.posInSet}
        aria-expanded={container && row.size ? isOpen : undefined}
        aria-selected={index === activeIndex}
        data-slot="json-viewer-row"
        data-active={index === activeIndex ? "" : undefined}
        data-kind={row.kind}
        title={row.kind === "string" ? (row.value as string) : undefined}
        style={{ top: index * rowHeight, paddingInlineStart: `calc(${row.depth - 1} * var(--by-size-icon-sm) + var(--by-space-inset-xs))` }}
        onClick={() => {
          activate(index);
          if (container) toggle(row);
        }}
        className={cn(classes.row)}
      >
        {container && row.size ? (
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
        {container ? (
          <span className={classes.summary}>{summary}</span>
        ) : (
          <span className={classes.value[row.kind as "string" | "number" | "boolean" | "null"]}>{display(row.value, row.kind, maxStringLength)}</span>
        )}
      </div>,
    );
  }

  return (
    <div
      ref={setRef}
      role="tree"
      tabIndex={0}
      aria-label={label}
      aria-activedescendant={active ? idFor(activeIndex) : undefined}
      data-slot="json-viewer"
      onKeyDown={onKeyDown}
      className={cn(classes.root, className)}
    >
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>{rendered}</div>
    </div>
  );
}
