// What the LangGraph screens share: loading a query with its states, JSON text fields, the
// status badge, the graph in GraphView's shape.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CodeInput } from "@/components/ui/code-input";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import type { GraphViewEdge, GraphViewGroup, GraphViewNode } from "@/components/ui/graph-view";
import type * as api from "@/gen/api";
import type { DescribedError } from "../types";

/** A query run when its inputs change, with its loading and error states and a reload. */
export function useLoad<T>(load: (() => Promise<T>) | null, deps: readonly unknown[], note: (e: unknown) => DescribedError) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const latest = useRef(load);
  latest.current = load;
  const reload = useCallback(async () => {
    const run = latest.current;
    if (!run) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const value = await run();
      if (mine === seq.current) setData(value);
    } catch (e) {
      if (mine === seq.current) setError(note(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [note]);
  useEffect(() => {
    if (load) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller's deps stand for `load`
  }, deps);
  return { data, error, loading, reload, setData };
}

/** JSON text → value, or the parser's message. Empty text is `undefined`. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/** A multi-line JSON editor in a Field, with the parse error under it. */
export function JsonField({ label, value, onChange, description, rows = 6, disabled = false }: { label: string; value: string; onChange: (text: string) => void; description?: string | undefined; rows?: number; disabled?: boolean }) {
  const parsed = parseJson(value);
  return (
    <Field invalid={!parsed.ok}>
      <FieldLabel>{label}</FieldLabel>
      <CodeInput language="json" multiline rows={rows} value={value} onValueChange={onChange} disabled={disabled} />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {!parsed.ok ? <FieldError match>Not valid JSON: {parsed.message}</FieldError> : null}
    </Field>
  );
}

/** A thread's or run's status as a badge. */
export function StatusBadge({ status }: { status: string }) {
  const variant = status === "busy" || status === "running" || status === "pending" ? "info" : status === "interrupted" ? "warning" : status === "error" || status === "timeout" ? "danger" : status === "success" ? "success" : "neutral";
  return <Badge variant={variant}>{status}</Badge>;
}

/** The server's graph in GraphView's shape: xray nodes `<subgraph>:<node>` drawn in their group. */
export function toGraphView(graph: api.AssistantGraph): { nodes: GraphViewNode[]; edges: GraphViewEdge[]; groups: GraphViewGroup[] } {
  const groups = new Map<string, GraphViewGroup>();
  const nodes = graph.nodes.map((n): GraphViewNode => {
    if (n.kind === "start") return { id: n.id, label: "start", kind: "start" };
    if (n.kind === "end") return { id: n.id, label: "end", kind: "end" };
    const cut = n.id.lastIndexOf(":");
    if (cut <= 0) return { id: n.id, label: n.name.includes(":") ? n.name.slice(n.name.lastIndexOf(":") + 1) : n.name };
    const group = n.id.slice(0, cut);
    if (!groups.has(group)) groups.set(group, { id: group, label: group.split(":").join(" › ") });
    return { id: n.id, label: n.id.slice(cut + 1), group };
  });
  const edges = graph.edges.map((e): GraphViewEdge => ({ source: e.source, target: e.target, ...(e.conditional ? { conditional: true } : {}), ...(e.label ? { label: e.label } : {}) }));
  return { nodes, edges, groups: [...groups.values()] };
}

/** "01a1eb49-1efc-…" for tables and titles. */
export function shortId(id: string): string {
  return id.length > 13 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** Compact JSON for a table cell. */
export function preview(value: unknown, max = 120): string {
  const text = value === undefined ? "" : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
