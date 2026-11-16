import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { tokenPx } from "@/lib/theme-scope";

// A virtualized, keyboard-navigable tree (DBee's schema browser) following the ARIA treeview
// pattern; Base UI has no tree, so it is built here. Data-driven: `nodes` with `children`, or
// `hasChildren` for children the app loads when the node expands (`onExpandedChange`), shown with
// a per-node loading row or an error row with Retry. Only the visible rows are rendered: the
// tree is a scroll container of fixed-height rows (size.control.sm, so density applies), and
// focus stays on the tree with aria-activedescendant naming the active row.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const treeVariants = {} as const;

export interface TreeNode {
  /** Unique in the tree. */
  id: string;
  /** The node's name, shown and matched by type-ahead and `filter`. */
  label: string;
  /** A leading icon (aria-hidden). */
  icon?: ReactNode;
  /** Trailing content: a type, a badge, a status. */
  meta?: ReactNode;
  /** Loaded children; leave undefined with hasChildren for children loaded on expand. */
  children?: readonly TreeNode[];
  /** The node can expand although its children are not loaded yet. */
  hasChildren?: boolean;
  /** Its children are loading (shows a loading row while expanded). */
  loading?: boolean;
  /** Loading its children failed: the message, shown in an error row with Retry. */
  error?: ReactNode;
  /** Shown but cannot be selected or activated. */
  disabled?: boolean;
}

/** A visible row: a node, or the loading or error row under an expanded node. */
interface Row {
  key: string;
  kind: "node" | "loading" | "error";
  node: TreeNode;
  level: number;
  setSize: number;
  posInSet: number;
  parentId: string | null;
}

const classes = {
  root: [
    "relative overflow-auto overscroll-contain font-sans text-body text-fg outline-none",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
  ],
  row: [
    "absolute inset-x-0 flex h-control-sm cursor-default select-none items-center gap-inline-xs pe-inset-sm whitespace-nowrap",
    "hover:bg-hover data-selected:bg-selected data-selected:hover:bg-selected-hover",
    "data-active:outline-none in-focus-visible:data-active:outline-solid in-focus-visible:data-active:outline-[length:var(--by-ring-width)] in-focus-visible:data-active:-outline-offset-[var(--by-ring-width)] in-focus-visible:data-active:outline-ring",
    "data-disabled:text-fg-disabled",
    "[&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  chevron: "flex size-icon-md shrink-0 items-center justify-center text-fg-muted transition-transform duration-[var(--by-motion-duration-fast)] ease-standard motion-reduce:transition-none data-expanded:rotate-90",
  icon: "flex shrink-0 text-fg-muted",
  label: "min-w-0 flex-1 truncate",
  meta: "ms-auto shrink-0 ps-inline-sm text-caption text-fg-muted",
  status: "text-fg-muted",
  error: "min-w-0 truncate text-danger-fg",
  retry: "shrink-0 rounded-xs px-inline-xs text-label text-fg-link underline underline-offset-4 hover:text-fg",
} as const;

const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

const expandable = (node: TreeNode) => (node.children !== undefined && node.children.length > 0) || node.hasChildren === true || node.loading === true || node.error !== undefined;

/** The nodes that match `query`, with their ancestors (and the ids of those ancestors). */
function filterNodes(nodes: readonly TreeNode[], query: string): { nodes: TreeNode[]; open: Set<string> } {
  const open = new Set<string>();
  const needle = query.trim().toLowerCase();
  const walk = (list: readonly TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const node of list) {
      const children = node.children ? walk(node.children) : [];
      if (node.label.toLowerCase().includes(needle)) out.push(node);
      else if (children.length > 0) {
        open.add(node.id);
        out.push({ ...node, children });
      }
    }
    return out;
  };
  return { nodes: needle ? walk(nodes) : [...nodes], open };
}

/** The visible rows, in order, for the expanded set. */
export function flattenTree(nodes: readonly TreeNode[], expanded: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  const walk = (list: readonly TreeNode[], level: number, parentId: string | null) => {
    list.forEach((node, index) => {
      rows.push({ key: node.id, kind: "node", node, level, setSize: list.length, posInSet: index + 1, parentId });
      if (!expanded.has(node.id) || !expandable(node)) return;
      if (node.loading) rows.push({ key: `${node.id}:loading`, kind: "loading", node, level: level + 1, setSize: 1, posInSet: 1, parentId: node.id });
      else if (node.error !== undefined) rows.push({ key: `${node.id}:error`, kind: "error", node, level: level + 1, setSize: 1, posInSet: 1, parentId: node.id });
      else if (node.children) walk(node.children, level + 1, node.id);
    });
  };
  walk(nodes, 1, null);
  return rows;
}

export interface TreeItemProps {
  /** The element id aria-activedescendant names. */
  id: string;
  node: TreeNode;
  /** aria-level, aria-setsize and aria-posinset (the tree is flat in the DOM). */
  level: number;
  setSize: number;
  posInSet: number;
  /** The row's offset in the scroll content, in px. */
  top: number;
  /** Open or closed for a parent; undefined for a leaf. */
  expanded: boolean | undefined;
  selected: boolean;
  /** The row the keyboard is on. */
  active: boolean;
  onClick?: (event: MouseEvent<HTMLDivElement>) => void;
  onDoubleClick?: () => void;
}

/** One node's row (role="treeitem"): chevron, icon, label and meta, indented by level. Tree renders one per visible node. */
export function TreeItem({ id, node, level, setSize, posInSet, top, expanded, selected, active, onClick, onDoubleClick }: TreeItemProps) {
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={level}
      aria-setsize={setSize}
      aria-posinset={posInSet}
      aria-expanded={expanded}
      aria-selected={selected}
      aria-disabled={node.disabled || undefined}
      aria-busy={node.loading || undefined}
      data-slot="tree-item"
      data-active={active ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-disabled={node.disabled ? "" : undefined}
      style={{ top, paddingInlineStart: `calc(${level - 1} * var(--by-size-icon-md) + var(--by-space-inset-xs))` }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(classes.row)}
    >
      {expanded !== undefined ? (
        <span data-slot="tree-chevron" data-expanded={expanded ? "" : undefined} className={cn(classes.chevron)}>
          <ChevronIcon />
        </span>
      ) : (
        <span className="size-icon-md shrink-0" />
      )}
      {node.icon ? (
        <span aria-hidden="true" className={classes.icon}>
          {node.icon}
        </span>
      ) : null}
      <span className={classes.label}>{node.label}</span>
      {node.meta ? <span className={classes.meta}>{node.meta}</span> : null}
    </div>
  );
}

/** The row indices to render: the visible window, plus the active row so aria-activedescendant always names an element. */
function renderedIndices(first: number, last: number, active: number, count: number): number[] {
  const indices = Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i);
  if (active < count && (active < first || active >= last)) indices.push(active);
  return indices;
}

export interface TreeProps {
  /** The top-level nodes. */
  nodes: readonly TreeNode[];
  /** Expanded node ids (controlled); `defaultExpanded` when uncontrolled. */
  expanded?: readonly string[];
  defaultExpanded?: readonly string[];
  /** Called with the new expanded ids, and the node that changed (load its children if needed). */
  onExpandedChange?: (expanded: string[], node: TreeNode, isExpanded: boolean) => void;
  /** The selected node id (controlled); `defaultSelected` when uncontrolled. */
  selected?: string | null;
  defaultSelected?: string | null;
  onSelectedChange?: (id: string, node: TreeNode) => void;
  /** Enter or a double-click on a node (open a table). */
  onAction?: (node: TreeNode) => void;
  /** Retry loading a node's children after an error (Enter on the error row, or its Retry button). */
  onRetry?: (node: TreeNode) => void;
  /** Shows only nodes whose label contains this text, with their ancestors expanded. */
  filter?: string;
  /** The tree's accessible name. */
  "aria-label"?: string;
  /** Rows rendered above and below the visible ones. */
  overscan?: number;
  /** Text of the loading row. */
  loadingText?: string;
  /** Text of the Retry button. */
  retryText?: string;
  /** Shown when there are no nodes. */
  emptyText?: ReactNode;
  /** Extra classes (give the tree a height: h-full in a sized panel), merged after the component's own. */
  className?: string;
  /** Reaches the tree element. */
  ref?: Ref<HTMLDivElement>;
}

/** The tree: a scroll container (role="tree") of virtualized rows (role="treeitem"). */
export function Tree({
  nodes = [],
  expanded: expandedProp,
  defaultExpanded = [],
  onExpandedChange,
  selected: selectedProp,
  defaultSelected = null,
  onSelectedChange,
  onAction,
  onRetry,
  filter = "",
  "aria-label": label = "Tree",
  overscan = 8,
  loadingText = "Loading…",
  retryText = "Retry",
  emptyText = "Nothing to show",
  className,
  ref,
}: TreeProps) {
  const [expandedState, setExpandedState] = useState<readonly string[]>(defaultExpanded);
  const [selectedState, setSelectedState] = useState<string | null>(defaultSelected);
  const expandedList = expandedProp ?? expandedState;
  const selected = selectedProp === undefined ? selectedState : selectedProp;

  const { nodes: shown, open: filterOpen } = useMemo(() => filterNodes(nodes, filter), [nodes, filter]);
  const expandedSet = useMemo(() => new Set([...expandedList, ...filterOpen]), [expandedList, filterOpen]);
  const rows = useMemo(() => flattenTree(shown, expandedSet), [shown, expandedSet]);

  const [activeKey, setActiveKey] = useState<string | null>(null);
  const activeIndex = Math.max(0, rows.findIndex((row) => row.key === activeKey));
  const active = rows[activeIndex];

  const container = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(28);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      container.current = element;
      if (element) {
        setRowHeight(tokenPx(element, "--by-size-control-sm", 28));
        setViewport(element.clientHeight);
      }
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [ref],
  );
  useEffect(() => {
    const element = container.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      setViewport(element.clientHeight);
      setRowHeight(tokenPx(element, "--by-size-control-sm", 28));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // jsdom and a not-yet-laid-out panel report 0: render a screenful anyway.
  const height = viewport || rowHeight * 30;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + overscan);

  const idFor = useCallback((key: string) => `tree-${label.replace(/\W+/g, "-")}-${key.replace(/\W+/g, "-")}`, [label]);

  const scrollIntoView = (index: number) => {
    const element = container.current;
    if (!element) return;
    const top = index * rowHeight;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + rowHeight > element.scrollTop + (element.clientHeight || height)) element.scrollTop = top + rowHeight - (element.clientHeight || height);
    setScrollTop(element.scrollTop);
  };

  const moveTo = (index: number) => {
    const row = rows[Math.min(rows.length - 1, Math.max(0, index))];
    if (!row) return;
    setActiveKey(row.key);
    scrollIntoView(rows.indexOf(row));
  };

  const setExpanded = (node: TreeNode, isExpanded: boolean) => {
    const next = isExpanded ? [...new Set([...expandedList, node.id])] : expandedList.filter((id) => id !== node.id);
    if (expandedProp === undefined) setExpandedState(next);
    onExpandedChange?.(next, node, isExpanded);
  };

  const select = (node: TreeNode) => {
    if (node.disabled) return;
    if (selectedProp === undefined) setSelectedState(node.id);
    onSelectedChange?.(node.id, node);
  };

  const typeahead = useRef({ text: "", at: 0 });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    const node = active.node;
    const isOpen = expandedSet.has(node.id);
    const handled = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    switch (event.key) {
      case "ArrowDown":
        handled();
        moveTo(activeIndex + 1);
        return;
      case "ArrowUp":
        handled();
        moveTo(activeIndex - 1);
        return;
      case "Home":
        handled();
        moveTo(0);
        return;
      case "End":
        handled();
        moveTo(rows.length - 1);
        return;
      case "ArrowRight":
        handled();
        if (active.kind !== "node") return;
        if (expandable(node) && !isOpen) setExpanded(node, true);
        else if (isOpen) moveTo(activeIndex + 1);
        return;
      case "ArrowLeft":
        handled();
        if (active.kind === "node" && isOpen && expandable(node)) setExpanded(node, false);
        else if (active.parentId) moveTo(rows.findIndex((row) => row.key === active.parentId));
        return;
      case "Enter":
        handled();
        if (active.kind === "error") onRetry?.(node);
        else if (active.kind === "node" && !node.disabled) {
          select(node);
          onAction?.(node);
        }
        return;
      case " ":
        handled();
        if (active.kind === "node") select(node);
        return;
      default:
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const now = Date.now();
          const state = typeahead.current;
          state.text = now - state.at > 700 ? event.key.toLowerCase() : state.text + event.key.toLowerCase();
          state.at = now;
          const order = [...rows.slice(activeIndex + 1), ...rows.slice(0, activeIndex + 1)];
          const match = order.find((row) => row.kind === "node" && row.node.label.toLowerCase().startsWith(state.text));
          if (match) {
            handled();
            moveTo(rows.indexOf(match));
          }
        }
    }
  };

  const onRowClick = (row: Row, event: MouseEvent) => {
    setActiveKey(row.key);
    if (row.kind !== "node") return;
    const target = event.target as Element;
    if (target.closest('[data-slot="tree-chevron"]') && expandable(row.node)) {
      setExpanded(row.node, !expandedSet.has(row.node.id));
      return;
    }
    select(row.node);
  };

  if (rows.length === 0) {
    return (
      <div data-slot="tree" role="tree" aria-label={label} className={cn(classes.root, className)} ref={setRef}>
        <p data-slot="tree-empty" role="none" className="p-inset-sm text-body text-fg-muted">
          {emptyText}
        </p>
      </div>
    );
  }

  return (
    <div
      data-slot="tree"
      role="tree"
      aria-label={label}
      aria-activedescendant={active ? idFor(active.key) : undefined}
      tabIndex={0}
      ref={setRef}
      onKeyDown={onKeyDown}
      onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      className={cn(classes.root, className)}
    >
      <div style={{ height: rows.length * rowHeight, position: "relative" }}>
        {renderedIndices(first, last, activeIndex, rows.length).map((index) => {
          const row = rows[index]!;
          const { node } = row;
          const isOpen = expandedSet.has(node.id);
          const common = {
            id: idFor(row.key),
            role: "treeitem",
            "aria-level": row.level,
            "aria-setsize": row.setSize,
            "aria-posinset": row.posInSet,
            "data-active": row.key === active?.key ? "" : undefined,
            style: { top: index * rowHeight, paddingInlineStart: `calc(${row.level - 1} * var(--by-size-icon-md) + var(--by-space-inset-xs))` },
          } as const;
          if (row.kind === "loading") {
            return (
              <div key={row.key} {...common} data-slot="tree-loading" aria-disabled="true" aria-busy="true" onClick={() => setActiveKey(row.key)} className={cn(classes.row, classes.status)}>
                <span className="size-icon-md shrink-0" />
                {loadingText}
              </div>
            );
          }
          if (row.kind === "error") {
            return (
              <div key={row.key} {...common} data-slot="tree-error" onClick={() => setActiveKey(row.key)} className={cn(classes.row)}>
                <span className="size-icon-md shrink-0" />
                <span className={classes.error}>{node.error}</span>
                {onRetry ? (
                  <button type="button" tabIndex={-1} data-slot="tree-retry" onClick={() => onRetry(node)} className={cn(classes.retry)}>
                    {retryText}
                  </button>
                ) : null}
              </div>
            );
          }
          return (
            <TreeItem
              key={row.key}
              id={common.id}
              node={node}
              level={row.level}
              setSize={row.setSize}
              posInSet={row.posInSet}
              top={index * rowHeight}
              expanded={expandable(node) ? isOpen : undefined}
              selected={node.id === selected}
              active={row.key === active?.key}
              onClick={(event) => onRowClick(row, event)}
              onDoubleClick={() => !node.disabled && onAction?.(node)}
            />
          );
        })}
      </div>
    </div>
  );
}
