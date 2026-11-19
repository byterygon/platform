// What the LangGraph screens share: loading a query with its states, JSON text fields (Monaco,
// with the assistant's JSON Schema where there is one: completion, hovers, validation; TSK-93),
// the status badge, the graph in GraphView's shape.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { CodeEditor } from "@/components/ui/code-editor";
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

/** A JSON Schema object from the server's schemas, or undefined (none, `null`, `true`, not an object). */
export function schemaObject(schema: unknown): object | undefined {
  return typeof schema === "object" && schema !== null && !Array.isArray(schema) && Object.keys(schema).length > 0 ? schema : undefined;
}

/** The schema of a partial update (State update, Command.update): the same properties, none required. */
export function partialSchema(schema: unknown): object | undefined {
  const s = schemaObject(schema) as Record<string, unknown> | undefined;
  if (!s) return undefined;
  const { required: _required, ...rest } = s;
  return rest;
}

/**
 * The schema of a run's `config`: the server's config schema is either the whole config (with a
 * `configurable` property) or only `configurable`'s; the second is wrapped, its `$defs` kept at
 * the root so its references still resolve.
 */
export function configSchema(schema: unknown): object | undefined {
  const s = schemaObject(schema) as Record<string, unknown> | undefined;
  if (!s) return undefined;
  const props = s["properties"] as Record<string, unknown> | undefined;
  if (props && "configurable" in props) return s;
  const { $defs, definitions, ...configurable } = s;
  return {
    type: "object",
    properties: { configurable },
    ...($defs !== undefined ? { $defs } : {}),
    ...(definitions !== undefined ? { definitions } : {}),
  };
}

/**
 * A schema of the keys seen in some objects (thread metadata, store values), each with up to ten
 * of its scalar values as `examples`, so a JSON filter editor suggests keys and values (TSK-93).
 */
export function seenKeysSchema(objects: readonly unknown[]): object {
  const seen = new Map<string, unknown[]>();
  for (const o of objects) {
    if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
    for (const [key, value] of Object.entries(o)) {
      const list = seen.get(key) ?? [];
      const scalar = value === null || ["string", "number", "boolean"].includes(typeof value);
      if (scalar && list.length < 10 && !list.includes(value)) list.push(value);
      seen.set(key, list);
    }
  }
  return {
    type: "object",
    properties: Object.fromEntries([...seen].sort(([a], [b]) => a.localeCompare(b)).map(([key, examples]) => [key, examples.length > 0 ? { examples } : {}])),
  };
}

/** A multi-line JSON editor (Monaco) in a Field, with the parse error under it; Mod+Enter submits. */
export function JsonField({
  label,
  value,
  onChange,
  description,
  rows = 6,
  disabled = false,
  schema,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (text: string) => void;
  description?: string | undefined;
  rows?: number;
  disabled?: boolean;
  /** The JSON Schema the text follows: completion, hovers and validation. */
  schema?: object | undefined;
  onSubmit?: (() => void) | undefined;
}) {
  const parsed = parseJson(value);
  const labelId = useId();
  return (
    <Field invalid={!parsed.ok}>
      <FieldLabel id={labelId}>{label}</FieldLabel>
      <CodeEditor
        language="json"
        aria-labelledby={labelId}
        value={value}
        onValueChange={onChange}
        readOnly={disabled}
        jsonSchema={schema}
        onSubmit={onSubmit ? () => onSubmit() : undefined}
        invalid={!parsed.ok}
        lineNumbers={rows > 3}
        className={rows > 8 ? "h-panel-sm" : "h-panel-xs"}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {!parsed.ok ? <FieldError match>Not valid JSON: {parsed.message}</FieldError> : null}
    </Field>
  );
}

/** A thread's or run's status as a badge. */
export function StatusBadge({ status }: { status: string }) {
  const variant = status === "busy" || status === "running" || status === "pending" ? "info" : status === "interrupted" ? "warning" : status === "error" || status === "timeout" ? "danger" : status === "success" ? "success" : "neutral";
  return <Badge appearance="tint" variant={variant}>{status}</Badge>;
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
