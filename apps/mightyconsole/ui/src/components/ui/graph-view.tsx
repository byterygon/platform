import dagre from "@dagrejs/dagre";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref, type WheelEvent } from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { Add, Subtract } from "@/lib/icons";

// A read-only directed graph: a LangGraph assistant's nodes and edges, a workflow, a pipeline.
// dagre (MIT) computes a layered layout; the component draws the edges in SVG and the nodes as
// focusable HTML boxes on top, so they take the token roles and the focus ring like any control.
// Base UI has no graph primitive and the project builds what it lacks (Chart is drawn the same
// way), so there is no React Flow and no foreign CSS. Pan by dragging the background or with the
// wheel, zoom with Ctrl or Cmd and the wheel, the buttons or + and -, fit with 0. Nodes are one
// tab stop in layout order; the arrow keys follow the edges, Enter selects.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const graphViewVariants = {} as const;

export type GraphViewNodeKind = "start" | "end" | "node" | "subgraph";

export interface GraphViewNode {
  id: string;
  label: string;
  /** `start` and `end` are drawn as small pills; `subgraph` as a node with a double edge. */
  kind?: GraphViewNodeKind;
  /** The id of the group (cluster) the node is drawn in. */
  group?: string;
  /** A second, muted line under the label (a status and a type, say); the node grows to two lines. */
  detail?: string;
  /** A status dot before the detail. */
  tone?: GraphViewTone;
  /** The node the graph is about: accent edge, without the "done" of visited. */
  emphasis?: boolean;
}

export type GraphViewTone = "neutral" | "info" | "success" | "warning" | "danger";

export interface GraphViewEdge {
  source: string;
  target: string;
  /** A branch of a conditional edge: drawn dashed. */
  conditional?: boolean;
  /** Drawn dashed for another reason (a message between nodes rather than a step, say). */
  dashed?: boolean;
  label?: string;
}

export interface GraphViewGroup {
  id: string;
  label: string;
}

export interface GraphViewProps {
  nodes?: readonly GraphViewNode[];
  edges?: readonly GraphViewEdge[];
  /** Clusters drawn around their nodes (a subgraph's nodes, for instance). */
  groups?: readonly GraphViewGroup[];
  /** Top to bottom or left to right. */
  direction?: "TB" | "LR";
  /** Nodes running now: accent fill. */
  activeIds?: readonly string[];
  /** Nodes that already ran: accent edge. */
  visitedIds?: readonly string[];
  /** The selected node (data-selected, aria-pressed). */
  selectedId?: string | null;
  /** Click or Enter on a node. */
  onNodeSelect?: (id: string) => void;
  /** Double-click on a node (open it elsewhere, say). */
  onNodeOpen?: (id: string) => void;
  /** The graph's accessible name. */
  "aria-label"?: string;
  /** Extra classes on the root; give it a height. */
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Layout units (px at zoom 1). Exported for tests. */
export const GEOMETRY = { nodeHeight: 36, detailHeight: 52, pillHeight: 28, minWidth: 72, maxWidth: 240, charWidth: 7.5, padding: 32, nodeSep: 32, rankSep: 52, margin: 24, minZoom: 0.25, maxZoom: 2 } as const;

const classes = {
  root: "relative isolate min-h-panel-xs w-full overflow-hidden rounded-lg border border-border-subtle bg-layer font-sans text-body-1 text-fg select-none",
  viewport: "absolute inset-0 cursor-grab touch-none data-panning:cursor-grabbing",
  canvas: "absolute top-0 left-0 origin-top-left",
  svg: "absolute top-0 left-0 overflow-visible",
  edge: "fill-none stroke-border-strong data-visited:stroke-accent-compound data-active:stroke-accent-compound",
  arrow: "fill-border-strong",
  arrowOn: "fill-accent-compound",
  edgeLabelBox: "fill-layer",
  edgeLabel: "fill-fg-muted text-caption-1",
  group: "absolute rounded-lg border border-dashed border-border bg-layer-alt",
  groupLabel: "absolute top-0 left-0 -translate-y-full truncate pb-stack-xs text-caption-1 text-fg-muted",
  node: [
    "absolute flex items-center justify-center truncate rounded-md border border-border bg-surface px-inset-xs text-body-1 text-fg shadow-layer",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
    "hover:bg-hover",
    "data-[kind=start]:rounded-full data-[kind=start]:bg-inset data-[kind=start]:text-caption-1 data-[kind=start]:text-fg-muted data-[kind=start]:shadow-none",
    "data-[kind=end]:rounded-full data-[kind=end]:bg-inset data-[kind=end]:text-caption-1 data-[kind=end]:text-fg-muted data-[kind=end]:shadow-none",
    "data-[kind=subgraph]:border-double data-[kind=subgraph]:border-border-strong",
    "data-visited:border-accent-compound data-visited:text-accent-subtle-fg",
    "data-active:border-accent-solid data-active:bg-accent-solid data-active:text-accent-solid-fg data-active:hover:bg-accent-solid-hover",
    "data-selected:bg-selected data-selected:hover:bg-selected-hover",
    "data-detail:flex-col data-detail:items-start data-detail:justify-center data-detail:gap-stack-xs data-detail:px-inset-sm",
    "data-emphasis:border-accent-compound data-emphasis:bg-accent-subtle data-emphasis:text-accent-subtle-fg data-emphasis:data-selected:bg-selected",
    focusRing,
  ],
  nodeLabel: "max-w-full truncate",
  nodeDetail: "flex max-w-full items-center gap-inline-xs truncate text-caption-1 text-fg-muted",
  dot: "size-inline-sm shrink-0 rounded-full",
  tone: { neutral: "bg-fg-muted", info: "bg-info", success: "bg-success", warning: "bg-warning", danger: "bg-danger" } satisfies Record<GraphViewTone, string>,
  controls: "absolute right-0 bottom-0 flex items-center gap-inline-xs p-inset-xs",
  empty: "flex h-full min-h-panel-xs items-center justify-center p-inset-md text-body-1 text-fg-muted",
  hidden: "sr-only",
} as const;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PlacedNode extends Box {
  node: GraphViewNode;
}

interface PlacedEdge {
  edge: GraphViewEdge;
  index: number;
  points: { x: number; y: number }[];
  label?: { x: number; y: number; width: number; height: number };
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
  groups: (Box & { group: GraphViewGroup })[];
  edges: PlacedEdge[];
  /** Node ids in reading order: by rank, then across. */
  order: string[];
}

const isPill = (n: GraphViewNode) => n.kind === "start" || n.kind === "end";

/** The size a node's label needs (no DOM measuring: the same in jsdom and the browser). */
export function nodeSize(n: GraphViewNode): { width: number; height: number } {
  // The detail is a caption (smaller) after a dot.
  const chars = Math.max(n.label.length, n.detail ? n.detail.length * 0.85 + (n.tone ? 2 : 0) : 0);
  const width = Math.round(Math.min(GEOMETRY.maxWidth, Math.max(GEOMETRY.minWidth, chars * GEOMETRY.charWidth + GEOMETRY.padding)));
  return { width, height: isPill(n) ? GEOMETRY.pillHeight : n.detail ? GEOMETRY.detailHeight : GEOMETRY.nodeHeight };
}

/** The layered layout of the graph (top-left corners, px at zoom 1). Exported for tests. */
export function layoutGraph(nodes: readonly GraphViewNode[], edges: readonly GraphViewEdge[], groups: readonly GraphViewGroup[] = [], direction: "TB" | "LR" = "TB"): GraphLayout {
  const known = new Set(nodes.map((n) => n.id));
  const groupIds = new Set(groups.filter((g) => !known.has(g.id)).map((g) => g.id));
  const g = new dagre.graphlib.Graph({ compound: groupIds.size > 0, multigraph: true });
  g.setGraph({ rankdir: direction, nodesep: GEOMETRY.nodeSep, ranksep: GEOMETRY.rankSep, edgesep: 16, marginx: GEOMETRY.margin, marginy: GEOMETRY.margin + (groupIds.size > 0 ? 16 : 0) });
  g.setDefaultEdgeLabel(() => ({}));
  for (const group of groups) if (groupIds.has(group.id)) g.setNode(group.id, { label: group.label });
  for (const n of nodes) {
    g.setNode(n.id, { ...nodeSize(n) });
    if (n.group && groupIds.has(n.group)) g.setParent(n.id, n.group);
  }
  const placed: { edge: GraphViewEdge; index: number }[] = [];
  edges.forEach((edge, index) => {
    if (!known.has(edge.source) || !known.has(edge.target)) return;
    const label = edge.label ? { width: edge.label.length * 6.5 + 8, height: 16, labelpos: "c" as const } : {};
    g.setEdge(edge.source, edge.target, label, String(index));
    placed.push({ edge, index });
  });
  if (nodes.length > 0) dagre.layout(g);
  const graph = g.graph();
  const box = (id: string): Box => {
    const v = g.node(id) as { x: number; y: number; width: number; height: number };
    return { x: v.x - v.width / 2, y: v.y - v.height / 2, width: v.width, height: v.height };
  };
  const placedNodes = nodes.map((node) => ({ node, ...box(node.id) }));
  const along = direction === "TB" ? ("y" as const) : ("x" as const);
  const across = direction === "TB" ? ("x" as const) : ("y" as const);
  const order = [...placedNodes].sort((a, b) => a[along] + (a[along === "y" ? "height" : "width"] / 2) - (b[along] + (b[along === "y" ? "height" : "width"] / 2)) || a[across] - b[across]).map((p) => p.node.id);
  return {
    width: Math.ceil(graph.width ?? 0),
    height: Math.ceil(graph.height ?? 0),
    nodes: placedNodes,
    groups: groups.filter((gr) => groupIds.has(gr.id)).map((group) => ({ group, ...box(group.id) })),
    edges: placed.map(({ edge, index }) => {
      const v = g.edge(edge.source, edge.target, String(index)) as { points?: { x: number; y: number }[]; x?: number; y?: number; width?: number; height?: number };
      const out: PlacedEdge = { edge, index, points: v.points ?? [] };
      if (edge.label && v.x !== undefined && v.y !== undefined) out.label = { x: v.x, y: v.y, width: v.width ?? 0, height: v.height ?? 0 };
      return out;
    }),
    order,
  };
}

/** A smooth path through the layout's points. Exported for tests. */
export function edgePath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return "";
  const [first, ...rest] = points;
  if (rest.length === 0) return `M${first!.x},${first!.y}`;
  let d = `M${first!.x},${first!.y}`;
  for (let i = 0; i < rest.length - 1; i++) {
    const p = rest[i]!;
    const q = rest[i + 1]!;
    d += ` Q${p.x},${p.y} ${(p.x + q.x) / 2},${(p.y + q.y) / 2}`;
  }
  const last = rest[rest.length - 1]!;
  return `${d} L${last.x},${last.y}`;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const clampZoom = (k: number) => Math.min(GEOMETRY.maxZoom, Math.max(GEOMETRY.minZoom, k));

const NONE: readonly never[] = [];

/** A read-only directed graph laid out in layers, with pan, zoom and keyboard navigation along its edges. */
export function GraphView({ nodes = NONE, edges = NONE, groups = NONE, direction = "TB", activeIds = NONE, visitedIds = NONE, selectedId = null, onNodeSelect, onNodeOpen, "aria-label": ariaLabel = "Graph", className, ref }: GraphViewProps) {
  // Laid out again only when the graph itself changes, not when a caller passes equal arrays anew
  // (the layout effect below fits the view, which would otherwise render forever).
  const key = JSON.stringify([nodes, edges, groups, direction]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for nodes, edges, groups and direction
  const layout = useMemo(() => layoutGraph(nodes, edges, groups, direction), [key]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [focused, setFocused] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>());
  const markerId = useId().replace(/:/g, "");
  const active = useMemo(() => new Set(activeIds), [activeIds]);
  const visited = useMemo(() => new Set(visitedIds), [visitedIds]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.node.id, n])), [layout]);

  const size = () => {
    const el = viewportRef.current;
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 };
  };

  const fit = useCallback(() => {
    const { width, height } = size();
    if (width === 0 || height === 0 || layout.width === 0) {
      setView({ x: 0, y: 0, k: 1 });
      return;
    }
    const k = clampZoom(Math.min(1, width / layout.width, height / layout.height));
    setView({ x: (width - layout.width * k) / 2, y: (height - layout.height * k) / 2, k });
  }, [layout]);

  // Fit when the graph changes and when the viewport gets its size.
  useLayoutEffect(() => fit(), [fit]);
  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => fit());
    observer.observe(el);
    return () => observer.disconnect();
  }, [fit]);

  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    setView((v) => {
      const k = clampZoom(v.k * factor);
      const { width, height } = size();
      const cx = at?.x ?? width / 2;
      const cy = at?.y ?? height / 2;
      return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey) {
      const rect = event.currentTarget.getBoundingClientRect();
      zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    } else {
      setView((v) => ({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY }));
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    pan.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, id: event.pointerId };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setPanning(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== event.pointerId) return;
    setView((v) => ({ ...v, x: p.vx + event.clientX - p.x, y: p.vy + event.clientY - p.y }));
  };
  const endPan = () => {
    pan.current = null;
    setPanning(false);
  };

  // The roving tab stop: the focused node, else the selected one, else the first in order.
  const tabStop = focused && byId.has(focused) ? focused : selectedId && byId.has(selectedId) ? selectedId : (layout.order[0] ?? null);

  /** Moves focus to `id` and pans so the node is in view. */
  const focusNode = (id: string) => {
    setFocused(id);
    nodeRefs.current.get(id)?.focus({ preventScroll: true });
    const n = byId.get(id);
    const { width, height } = size();
    if (!n || width === 0) return;
    setView((v) => {
      const left = v.x + n.x * v.k;
      const top = v.y + n.y * v.k;
      const right = left + n.width * v.k;
      const bottom = top + n.height * v.k;
      if (left >= 0 && top >= 0 && right <= width && bottom <= height) return v;
      return { ...v, x: width / 2 - (n.x + n.width / 2) * v.k, y: height / 2 - (n.y + n.height / 2) * v.k };
    });
  };

  const neighbours = (id: string, forward: boolean): string[] => {
    const ids = layout.edges.filter((e) => (forward ? e.edge.source === id : e.edge.target === id)).map((e) => (forward ? e.edge.target : e.edge.source));
    return layout.order.filter((o) => ids.includes(o) && o !== id);
  };

  const sameRank = (id: string, step: 1 | -1): string | undefined => {
    const n = byId.get(id);
    if (!n) return undefined;
    const vertical = direction === "TB";
    const centre = (p: PlacedNode) => (vertical ? p.y + p.height / 2 : p.x + p.width / 2);
    const cross = (p: PlacedNode) => (vertical ? p.x : p.y);
    const rank = layout.nodes.filter((p) => Math.abs(centre(p) - centre(n)) < 1).sort((a, b) => cross(a) - cross(b));
    return rank[rank.findIndex((p) => p.node.id === id) + step]?.node.id;
  };

  const onNodeKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const forwardKey = direction === "TB" ? "ArrowDown" : "ArrowRight";
    const backKey = direction === "TB" ? "ArrowUp" : "ArrowLeft";
    const nextKey = direction === "TB" ? "ArrowRight" : "ArrowDown";
    const prevKey = direction === "TB" ? "ArrowLeft" : "ArrowUp";
    let target: string | undefined;
    if (event.key === forwardKey) target = neighbours(id, true)[0];
    else if (event.key === backKey) target = neighbours(id, false)[0];
    else if (event.key === nextKey) target = sameRank(id, 1);
    else if (event.key === prevKey) target = sameRank(id, -1);
    else if (event.key === "Home") target = layout.order[0];
    else if (event.key === "End") target = layout.order[layout.order.length - 1];
    else return;
    event.preventDefault();
    if (target) focusNode(target);
  };

  const onViewportKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && !(event.target as HTMLElement).dataset.graphNode) return;
    if (event.key === "+" || event.key === "=") zoomBy(1.2);
    else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.2);
    else if (event.key === "0") fit();
    else return;
    event.preventDefault();
  };

  const edgeState = (e: GraphViewEdge) => (active.has(e.target) && (visited.has(e.source) || active.has(e.source)) ? "active" : visited.has(e.source) && (visited.has(e.target) || active.has(e.target)) ? "visited" : null);

  if (nodes.length === 0) {
    return (
      <div ref={ref} data-slot="graph-view" data-empty="" className={cn(classes.root, className)} role="group" aria-label={ariaLabel}>
        <p className={classes.empty}>No nodes to draw.</p>
      </div>
    );
  }

  const state = (id: string) => (active.has(id) ? ", running" : visited.has(id) ? ", done" : "");

  return (
    <div ref={ref} data-slot="graph-view" className={cn(classes.root, className)} role="group" aria-roledescription="graph" aria-label={ariaLabel}>
      <div
        ref={viewportRef}
        data-slot="graph-view-viewport"
        data-panning={panning ? "" : undefined}
        className={cn(classes.viewport)}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onKeyDown={onViewportKeyDown}
      >
        <div data-slot="graph-view-canvas" className={classes.canvas} style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {layout.groups.map((g) => (
            <div key={g.group.id} data-slot="graph-view-group" className={classes.group} style={{ left: g.x, top: g.y, width: g.width, height: g.height }}>
              <span className={classes.groupLabel} style={{ maxWidth: g.width }}>
                {g.group.label}
              </span>
            </div>
          ))}
          <svg className={classes.svg} width={layout.width} height={layout.height} aria-hidden="true" focusable="false">
            <defs>
              <marker id={`${markerId}-arrow`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={classes.arrow} />
              </marker>
              <marker id={`${markerId}-arrow-on`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" className={classes.arrowOn} />
              </marker>
            </defs>
            {layout.edges.map((e) => {
              const s = edgeState(e.edge);
              return (
                <g key={e.index} data-slot="graph-view-edge" data-conditional={e.edge.conditional ? "" : undefined} data-dashed={e.edge.dashed ? "" : undefined}>
                  <path
                    d={edgePath(e.points)}
                    className={classes.edge}
                    data-active={s === "active" ? "" : undefined}
                    data-visited={s === "visited" ? "" : undefined}
                    strokeWidth={s ? 2 : 1.5}
                    strokeDasharray={e.edge.conditional || e.edge.dashed ? "6 4" : undefined}
                    markerEnd={`url(#${markerId}-${s ? "arrow-on" : "arrow"})`}
                  />
                  {e.label && e.edge.label ? (
                    <g>
                      <rect x={e.label.x - e.label.width / 2} y={e.label.y - e.label.height / 2} width={e.label.width} height={e.label.height} rx={4} className={classes.edgeLabelBox} />
                      <text x={e.label.x} y={e.label.y} textAnchor="middle" dominantBaseline="central" className={classes.edgeLabel}>
                        {e.edge.label}
                      </text>
                    </g>
                  ) : null}
                </g>
              );
            })}
          </svg>
          {layout.nodes.map((n) => {
            const id = n.node.id;
            return (
              <button
                key={id}
                type="button"
                ref={(el) => {
                  if (el) nodeRefs.current.set(id, el);
                  else nodeRefs.current.delete(id);
                }}
                data-slot="graph-view-node"
                data-graph-node={id}
                data-kind={n.node.kind ?? "node"}
                data-active={active.has(id) ? "" : undefined}
                data-visited={visited.has(id) && !active.has(id) ? "" : undefined}
                data-selected={selectedId === id ? "" : undefined}
                data-detail={n.node.detail ? "" : undefined}
                data-emphasis={n.node.emphasis ? "" : undefined}
                aria-pressed={onNodeSelect ? selectedId === id : undefined}
                aria-label={`${n.node.label}${n.node.detail ? `, ${n.node.detail}` : ""}${state(id)}`}
                title={n.node.detail ? `${n.node.label}\n${n.node.detail}` : n.node.label}
                tabIndex={id === tabStop ? 0 : -1}
                className={cn(classes.node)}
                style={{ left: n.x, top: n.y, width: n.width, height: n.height }}
                onFocus={() => setFocused(id)}
                onClick={() => onNodeSelect?.(id)}
                onDoubleClick={onNodeOpen ? () => onNodeOpen(id) : undefined}
                onKeyDown={(event) => onNodeKeyDown(event, id)}
              >
                {n.node.detail ? (
                  <>
                    <span className={classes.nodeLabel}>{n.node.label}</span>
                    <span className={classes.nodeDetail}>
                      {n.node.tone ? <span data-slot="graph-view-dot" data-tone={n.node.tone} aria-hidden="true" className={cn(classes.dot, classes.tone[n.node.tone])} /> : null}
                      <span className="truncate">{n.node.detail}</span>
                    </span>
                  </>
                ) : (
                  n.node.label
                )}
              </button>
            );
          })}
        </div>
      </div>
      <ul className={classes.hidden} aria-label={`${ariaLabel}: edges`}>
        {layout.edges.map((e) => (
          <li key={e.index}>
            {byId.get(e.edge.source)?.node.label ?? e.edge.source} to {byId.get(e.edge.target)?.node.label ?? e.edge.target}
            {e.edge.conditional ? " (conditional)" : ""}
            {e.edge.label ? `: ${e.edge.label}` : ""}
          </li>
        ))}
      </ul>
      <div data-slot="graph-view-controls" className={classes.controls}>
        <IconButton aria-label="Zoom in" size="small" appearance="secondary" onClick={() => zoomBy(1.2)}>
          <Icon icon={Add} />
        </IconButton>
        <IconButton aria-label="Zoom out" size="small" appearance="secondary" onClick={() => zoomBy(1 / 1.2)}>
          <Icon icon={Subtract} />
        </IconButton>
        <Button size="small" appearance="secondary" onClick={fit}>
          Fit
        </Button>
      </div>
    </div>
  );
}
