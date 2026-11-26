// The route as a path (DOC-23 §10, "The route as a path"; mockup frames routes-editor,
// routes-editor-long, routes-test-fail, routes-error-hop, routes-connect-test): one figure drawn the
// same way above the route editor's hops, in a connection's error state and, small, under Connect
// through. Left to right: this server, each hop in order, the target. An arrow's label says how
// the node before opened the stream (TCP from the server, spawn for a leading local command, a
// SOCKS5 or CONNECT request, an SSH channel or command, the stdio of a command); a dashed outline
// marks what runs on the server's own machine; under the last hop, "resolves the target name";
// a bracket under the path shows the tool's TLS running end to end. Past five nodes the path wraps.
// A Test's or an error's result colours the nodes: the failing one and the arrow into it in the
// danger colour, those after it dashed and muted. Token colours only.
import type { KeyboardEvent } from "react";
import { ARROW_LABELS, HOP_KIND_LABELS } from "@/profiles/routes";

export interface PathNode {
  /** `httpConnect`, `socks5`, `ssh`, `sshCommand`, `command`. */
  kind: string;
  /** `host:port`, or a local command's program name. */
  label: string;
  /** The proxy's or SSH host's name. */
  name?: string | undefined;
}

/** A node's last result: hops first, then the target. */
export type NodeResult = "ok" | "failed" | "notTried";

export interface PathFigureProps {
  hops: readonly PathNode[];
  /** The target, `host:port`; `null` when there is none yet (a route in Settings). */
  target: string | null;
  /** By node: index 0 is the first hop, `hops.length` the target. */
  results?: readonly (NodeResult | undefined)[];
  /** Small: under Connect through and in Docker's SSH sheet. */
  size?: "full" | "small";
  /** Shows the bracket of the tool's TLS. */
  tls?: boolean;
  /** Opens a hop's form (the route editor). */
  onNodeClick?: (index: number) => void;
  className?: string;
}

const PER_ROW = 5;

const DIMS = {
  full: { w: 132, h: 44, gap: 64, row: 104, pad: 8, chars: 18 },
  small: { w: 96, h: 30, gap: 40, row: 72, pad: 4, chars: 13 },
} as const;

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text;
}

/** The label of the arrow into node `i` (0 = the first hop; `hops.length` = the target). */
function arrowLabel(hops: readonly PathNode[], i: number): string {
  if (i === 0) return hops[0]?.kind === "command" ? "spawn" : "TCP";
  const before = hops[i - 1];
  return before ? (ARROW_LABELS[before.kind] ?? before.kind) : "";
}

/** The figure's text for a screen reader: the hops in order and where a result stopped. */
export function describePath(hops: readonly PathNode[], target: string | null, results?: readonly (NodeResult | undefined)[]): string {
  const parts = ["This server"];
  hops.forEach((h, i) => parts.push(`hop ${i + 1}, ${HOP_KIND_LABELS[h.kind] ?? h.kind} ${h.name ? `${h.name} (${h.label})` : h.label}`));
  parts.push(target ? `target ${target}` : "the profile's target");
  let text = `Path: ${parts.join(", then ")}.`;
  const failed = results?.findIndex((r) => r === "failed") ?? -1;
  if (failed >= 0) text += failed >= hops.length ? " The test stopped at the target." : ` The test stopped at hop ${failed + 1}.`;
  else if (results && results.length > hops.length && results.every((r) => r === "ok")) text += " Every hop passed.";
  return text;
}

export function PathFigure({ hops, target, results, size = "full", tls = false, onNodeClick, className }: PathFigureProps) {
  const d = DIMS[size];
  // Nodes: the server, the hops, the target.
  const nodes: { title: string; sub: string; local: boolean; result: NodeResult | undefined; hop: number | null }[] = [
    { title: "This server", sub: size === "full" ? "Mightyconsole" : "", local: true, result: undefined, hop: null },
    ...hops.map((h, i) => ({
      title: HOP_KIND_LABELS[h.kind] ?? h.kind,
      sub: h.name && h.kind !== "command" ? h.name : h.label,
      local: h.kind === "command",
      result: results?.[i],
      hop: i,
    })),
    { title: "Target", sub: target ?? "the profile's address", local: false, result: results?.[hops.length], hop: null },
  ];
  const rows = Math.ceil(nodes.length / PER_ROW);
  const cols = Math.min(nodes.length, PER_ROW);
  const width = d.pad * 2 + cols * d.w + (cols - 1) * d.gap;
  const extra = size === "full" ? 36 : 0;
  const height = d.pad * 2 + (rows - 1) * d.row + d.h + extra;
  const at = (i: number) => {
    const row = Math.floor(i / PER_ROW);
    const col = i % PER_ROW;
    return { x: d.pad + col * (d.w + d.gap), y: d.pad + row * d.row };
  };
  const markerId = `path-arrow-${size}`;
  const failedAt = nodes.findIndex((n) => n.result === "failed");
  const key = (index: number) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onNodeClick?.(index);
    }
  };
  return (
    <svg
      role={onNodeClick ? "group" : "img"}
      aria-label={describePath(hops, target, results)}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={`max-w-full ${className ?? ""}`}
      data-path-figure={size}
    >
      <defs>
        <marker id={markerId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-border-strong" />
        </marker>
        <marker id={`${markerId}-bad`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="fill-danger-fg" />
        </marker>
      </defs>
      {nodes.slice(1).map((_, k) => {
        const i = k + 1;
        const from = at(i - 1);
        const to = at(i);
        const bad = failedAt === i;
        const later = failedAt >= 0 && i > failedAt;
        const midY = from.y + d.h / 2;
        const path =
          from.y === to.y
            ? `M${from.x + d.w},${midY} L${to.x - 2},${midY}`
            : `M${from.x + d.w / 2},${from.y + d.h} V${from.y + d.h + (d.row - d.h) / 2} H${to.x + d.w / 2} V${to.y - 2}`;
        const labelX = from.y === to.y ? from.x + d.w + d.gap / 2 : (from.x + to.x + d.w) / 2;
        const labelY = from.y === to.y ? midY - 6 : from.y + d.h + (d.row - d.h) / 2 - 4;
        return (
          <g key={`a${i}`} data-arrow={i} data-state={bad ? "failed" : later ? "notTried" : undefined}>
            <path
              d={path}
              fill="none"
              strokeWidth={bad ? 2 : 1.5}
              strokeDasharray={later ? "4 3" : undefined}
              className={bad ? "stroke-danger-fg" : later ? "stroke-border" : "stroke-border-strong"}
              markerEnd={`url(#${markerId}${bad ? "-bad" : ""})`}
            />
            <text x={labelX} y={labelY} textAnchor="middle" className={`${bad ? "fill-danger-fg" : "fill-fg-muted"} ${size === "full" ? "text-caption-1" : "text-caption-2"}`}>
              {arrowLabel(hops, i - 1)}
            </text>
          </g>
        );
      })}
      {nodes.map((n, i) => {
        const p = at(i);
        const state = n.result;
        const stroke = state === "failed" ? "stroke-danger-fg" : state === "ok" ? "stroke-success-fg" : state === "notTried" ? "stroke-border" : n.hop === null && i > 0 ? "stroke-border-strong" : "stroke-border-strong";
        const clickable = onNodeClick && n.hop !== null;
        const index = n.hop;
        return (
          <g
            key={`n${i}`}
            data-node={i}
            data-state={state}
            {...(clickable && index !== null
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": `Open hop ${index + 1}: ${n.title} ${n.sub}`,
                  onClick: () => onNodeClick(index),
                  onKeyDown: key(index),
                  className: "cursor-pointer focus-visible:outline-none [&:focus-visible>rect]:stroke-accent-compound",
                }
              : {})}
          >
            <title>{`${n.title}: ${n.sub}`}</title>
            <rect
              x={p.x}
              y={p.y}
              width={d.w}
              height={d.h}
              rx={6}
              strokeWidth={state === "failed" ? 2 : 1.5}
              strokeDasharray={n.local || state === "notTried" ? "4 3" : undefined}
              className={`${state === "notTried" ? "fill-layer-alt" : "fill-layer"} ${stroke}`}
            />
            <text x={p.x + d.w / 2} y={p.y + (n.sub ? d.h / 2 - (size === "full" ? 4 : 2) : d.h / 2 + 4)} textAnchor="middle" className={`${state === "failed" ? "fill-danger-fg" : "fill-fg"} ${size === "full" ? "text-caption-1-strong" : "text-caption-2"}`}>
              {cut(n.title, d.chars)}
            </text>
            {n.sub ? (
              <text x={p.x + d.w / 2} y={p.y + d.h / 2 + (size === "full" ? 12 : 9)} textAnchor="middle" className={`fill-fg-muted font-mono ${size === "full" ? "text-caption-1" : "text-caption-2"}`}>
                {cut(n.sub, d.chars)}
              </text>
            ) : null}
          </g>
        );
      })}
      {size === "full" && hops.length > 0
        ? (() => {
            const last = at(hops.length);
            const end = at(nodes.length - 1);
            const start = at(0);
            const bottom = d.pad + (rows - 1) * d.row + d.h;
            return (
              <g>
                <text x={last.x + d.w / 2} y={last.y + d.h + 14} textAnchor="middle" className="fill-fg-muted text-caption-2">
                  resolves the target name
                </text>
                {tls ? (
                  <g data-tls="">
                    <path d={`M${start.x + d.w / 2},${bottom + 20} v6 H${end.x + d.w / 2} v-6`} fill="none" strokeWidth={1} className="stroke-accent-compound" />
                    <text x={(start.x + end.x + d.w) / 2} y={bottom + 36} textAnchor="middle" className="fill-fg-muted text-caption-2">
                      the tool's TLS, end to end
                    </text>
                  </g>
                ) : null}
              </g>
            );
          })()
        : null}
    </svg>
  );
}

/** The figure's node results from a Test's lines (up to the first failure; the rest Not tried). */
export function resultsOf(lines: readonly { hop: { index: number }; ok: boolean }[], hopCount: number): NodeResult[] {
  const out: NodeResult[] = Array.from({ length: hopCount + 1 }, () => "notTried");
  for (const l of lines) out[l.hop.index] = l.ok ? "ok" : "failed";
  return out;
}

/** The figure's node results from a connection's error that names a hop. */
export function resultsOfError(errorIndex: number, hopCount: number): NodeResult[] {
  return Array.from({ length: hopCount + 1 }, (_, i) => (i < errorIndex ? "ok" : i === errorIndex ? "failed" : "notTried"));
}
