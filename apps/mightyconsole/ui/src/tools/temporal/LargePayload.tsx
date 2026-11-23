// Large payloads (Mightyconsole spec §9.3 "Large payload", TSK-92; mockup frame
// `temporal-large-payload`). A payload whose decoded JSON is over 64 KiB comes as a `$large` stub;
// its value stays on the server (10 minutes unused) and this view asks for it a node at a time.
//
// PayloadView: the label with its size against Temporal's 2 MiB limit and its codec chain; Tree
// (children in pages of 50, Go to index), Text (the first 64 KiB) or Stored bytes (the first 4 KiB
// as hex); jq run on the server, only its results sent; downloads of the decoded JSON or the stored
// bytes; Copy path of the selected node. Beside it: "What makes it big" (the top-level members by
// size, the largest arrays), Temporal's default limits as bars and the run's largest payloads.
// LargeStubCard stands for a stub where there is no room for the view (History, Pending, Queries)
// and opens it in its own tab.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonView } from "@/app/json-view";
import { CodeBlock } from "@/components/ui/code-block";
import { CodeEditor } from "@/components/ui/code-editor";
import { HexView } from "@/components/ui/hex-view";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, LinkButton } from "@/app/page";
import { ErrorState } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { PayloadChild, PayloadNode, PayloadQueryOutput } from "@/gen/api";
import { cn } from "@/lib/cn";
import { ArrowDownload, ArrowRight, ChevronDown, ChevronRight, Play, Window } from "@/lib/icons";
import type { DescribedError } from "../types";
import { formatBytes } from "./NamespacesTab";
import { saveBlob } from "../nats/objects-io";

/** What the server sends in place of a payload over 64 KiB of JSON. */
export interface LargeStub {
  id: string;
  /** The data the encoding read, in bytes. */
  bytes: number;
  decodedBytes: number;
  encoding: string;
  codec?: { codec: string; from: string };
  /** The first 64 KiB of its JSON text (absent in a payload tab: Text reads it from the server). */
  preview?: string;
}

/** Temporal's default limits (a cluster can change them). */
export const LIMITS = { payload: 2 * 1024 * 1024, payloadWarn: 512 * 1024, history: 50 * 1024 * 1024, historyWarn: 10 * 1024 * 1024, events: 51_200 } as const;

/** The stub a decoded value is, or null. */
export function largeOf(value: unknown): LargeStub | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const stub = (value as Record<string, unknown>)["$large"];
  if (stub === null || typeof stub !== "object") return null;
  const s = stub as Partial<LargeStub>;
  return typeof s.id === "string" && typeof s.bytes === "number" ? (s as LargeStub) : null;
}

/** Every stub in a value, with where it is (`input[0]`, `result[0]`). */
export function largeStubs(value: unknown, path = ""): { path: string; stub: LargeStub }[] {
  const stub = largeOf(value);
  if (stub) return [{ path, stub }];
  if (Array.isArray(value)) return value.flatMap((v, i) => largeStubs(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => largeStubs(v, path ? `${path}.${k}` : k));
  return [];
}

/** The value with each stub's preview replaced by a short note, for a JSON listing. */
export function withoutPreviews(value: unknown): unknown {
  const stub = largeOf(value);
  if (stub) return { $large: { ...stub, preview: `(${formatBytes(stub.decodedBytes)} of JSON, kept on the server)` } };
  if (Array.isArray(value)) return value.map(withoutPreviews);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutPreviews(v)]));
  return value;
}

/** A JSON pointer as jq writes the path: `/items/1/sku` → `.items[1].sku`. */
export function jqPath(pointer: string, arrays: ReadonlySet<string> = new Set()): string {
  if (pointer === "") return ".";
  let parent = "";
  let out = "";
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const inArray = arrays.has(parent) && /^\d+$/.test(key);
    out += inArray ? `[${key}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    parent = `${parent}/${raw}`;
  }
  return out.startsWith("[") ? `.${out}` : out;
}

/** "1.62 MiB, near the 2 MiB limit" and the badge's tone for a payload's stored size. */
export function sizeVerdict(bytes: number): { text: string; tone: "warning" | "danger" | "neutral" } {
  const size = formatBytes(bytes);
  if (bytes > LIMITS.payload) return { text: `${size}, over the 2 MiB limit`, tone: "danger" };
  if (bytes >= LIMITS.payload * 0.75) return { text: `${size}, near the 2 MiB limit`, tone: "warning" };
  if (bytes >= LIMITS.payloadWarn) return { text: `${size}, over the 512 KiB warning`, tone: "warning" };
  return { text: size, tone: "neutral" };
}

/** A child's line in the tree: an array entry's start, a member's type and length, or its value. */
function describe(c: Pick<PayloadChild, "kind" | "length" | "preview">, inArray = false): string {
  if (inArray && (c.kind === "object" || c.kind === "array")) return c.preview;
  if (c.kind === "object") return `object · ${formatCount(c.length ?? 0)} ${c.length === 1 ? "key" : "keys"}`;
  if (c.kind === "array") return `array[${formatCount(c.length ?? 0)}]`;
  return c.preview;
}

/** The chain a payload went through: `binary/encrypted → codec → json/plain`. */
export function CodecChain({ stub }: { stub: LargeStub }) {
  return (
    <span className="flex items-center gap-inline-xs text-caption-1 text-fg-muted">
      {stub.codec ? (
        <>
          <span className="font-mono">{stub.codec.from}</span>
          <Icon icon={ArrowRight} size="xs" />
          <span>{stub.codec.codec}</span>
          <Icon icon={ArrowRight} size="xs" />
        </>
      ) : null}
      <span className="font-mono text-fg">{stub.encoding}</span>
    </span>
  );
}

/** A stub where the view does not fit: what it is, and Open. */
export function LargeStubCard({ stub, label, onOpen }: { stub: LargeStub; label: string; onOpen: () => void }) {
  const verdict = sizeVerdict(stub.bytes);
  return (
    <div className="flex flex-wrap items-center gap-inline-md rounded-md border border-border-subtle bg-layer px-inset-md py-stack-sm" data-slot="large-payload">
      <span className="text-body-1-strong text-fg">{label}</span>
      <Badge appearance="tint" variant={verdict.tone}>
        {verdict.text}
      </Badge>
      <CodecChain stub={stub} />
      <span className="flex-1" />
      <Button size="small" appearance="secondary" onClick={onOpen}>
        <Icon icon={Window} /> Open {label}
      </Button>
    </div>
  );
}

/** What the run around a payload knows, for the limits and the largest payloads. */
export interface PayloadContext {
  historyBytes?: number | undefined;
  events?: number | undefined;
  /** The run's largest payloads loaded, biggest first. */
  largest?: readonly { eventId: number; label: string; bytes: number }[] | undefined;
  onGoToEvent?: ((eventId: number) => void) | undefined;
}

export interface PayloadViewProps {
  client: MightyClient;
  connId: string;
  stub: LargeStub;
  /** "Input · argument 1 of 1". */
  label: string;
  /** Used for the downloads' file names. */
  fileName: string;
  context?: PayloadContext | undefined;
  note(e: unknown): DescribedError;
  /** The stub is gone from the server: read the event again. */
  onReload?: (() => void) | undefined;
  /**
   * Where the payload is kept: Temporal's `payload.*` by default; LangGraph's large-state tree
   * passes `langgraph.values` (TSK-96), whose procedures take the same inputs.
   */
  calls?: Pick<MightyClient["temporal"]["payload"], "node" | "query" | "download"> | undefined;
}

type View = "tree" | "text" | "stored";

/** The pages of a node loaded so far, merged. */
interface Loaded {
  node: PayloadNode;
  children: PayloadChild[];
}

export function PayloadView({ client, connId, stub, label, fileName, context, note, onReload, calls }: PayloadViewProps) {
  const api = calls ?? client.temporal.payload;
  const [view, setView] = useState<View>("tree");
  const [nodes, setNodes] = useState<ReadonlyMap<string, Loaded>>(new Map());
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set([""]));
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<DescribedError | null>(null);
  const [jq, setJq] = useState("");
  const [result, setResult] = useState<PayloadQueryOutput | null>(null);
  const [jqError, setJqError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [downloading, setDownloading] = useState<"decoded" | "stored" | null>(null);
  const [stored, setStored] = useState<Uint8Array | null>(null);
  const [text, setText] = useState<string | null>(stub.preview ?? null);
  const [goTo, setGoTo] = useState<Record<string, string>>({});
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const load = useCallback(
    async (path: string, offset = 0) => {
      try {
        const node = await api.node({ connId, payloadId: stub.id, path, offset, limit: null });
        if (!live.current) return;
        setNodes((m) => {
          const next = new Map(m);
          const before = m.get(path);
          // The next page adds to the loaded children; a jump (Go to index) starts a new run.
          if (before && offset > 0 && before.node.offset + before.children.length === offset) next.set(path, { node: before.node, children: [...before.children, ...node.children] });
          else next.set(path, { node, children: node.children });
          return next;
        });
        setError(null);
      } catch (e) {
        if (live.current) setError(note(e));
      }
    },
    [api, connId, stub.id, note],
  );

  useEffect(() => {
    setNodes(new Map());
    setOpen(new Set([""]));
    setSelected("");
    setResult(null);
    setStored(null);
    setText(stub.preview ?? null);
    void load("");
  }, [load]);

  const root = nodes.get("");
  const arrays = useMemo(() => new Set([...nodes.entries()].filter(([, l]) => l.node.kind === "array").map(([p]) => p)), [nodes]);
  const toggle = (path: string) => {
    setSelected(path);
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        if (!nodes.has(path)) void load(path);
      }
      return next;
    });
  };

  const runJq = async () => {
    if (jq.trim() === "") return;
    setRunning(true);
    setJqError(null);
    try {
      setResult(await api.query({ connId, payloadId: stub.id, jq }));
    } catch (e) {
      const d = note(e);
      setResult(null);
      if (d.kind === "Invalid") setJqError(d.title);
      else setError(d);
    } finally {
      setRunning(false);
    }
  };

  const download = async (form: "decoded" | "stored", limit?: number) => {
    const controller = new AbortController();
    const stream = api.download({ connId, payloadId: stub.id, form }, { timeoutMs: 3_600_000, signal: controller.signal });
    const parts: Uint8Array[] = [];
    let received = 0;
    try {
      for await (const chunk of stream.chunks()) {
        parts.push(chunk);
        received += chunk.byteLength;
        if (limit !== undefined && received >= limit) {
          controller.abort();
          break;
        }
      }
      if (limit === undefined) await stream.result;
    } catch (e) {
      if (!controller.signal.aborted) throw e;
    }
    return parts;
  };

  const save = async (form: "decoded" | "stored") => {
    setDownloading(form);
    try {
      const parts = await download(form);
      saveBlob(new Blob(parts as BlobPart[], { type: form === "decoded" ? "application/json" : "application/octet-stream" }), form === "decoded" ? `${fileName}.json` : `${fileName}.bin`);
    } catch (e) {
      setError(note(e));
    } finally {
      setDownloading(null);
    }
  };

  // Text without a preview: the first 64 KiB of the decoded JSON.
  useEffect(() => {
    if (view !== "text" || text !== null) return;
    let ok = true;
    download("decoded", 64 * 1024).then(
      (parts) => {
        if (!ok) return;
        const all = new TextDecoder().decode(concat(parts).slice(0, 64 * 1024));
        setText(all);
      },
      (e: unknown) => ok && setError(note(e)),
    );
    return () => {
      ok = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, text]);

  // Stored bytes: the first 4 KiB, as hex.
  useEffect(() => {
    if (view !== "stored" || stored !== null) return;
    let ok = true;
    download("stored", 4096).then(
      (parts) => {
        if (ok) setStored(concat(parts).slice(0, 4096));
      },
      (e: unknown) => ok && setError(note(e)),
    );
    return () => {
      ok = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, stored]);

  const verdict = sizeVerdict(stub.bytes);
  const path = jqPath(selected, arrays);
  const gone = error?.kind === "NotFound";
  const single = result && result.results.length === 1 && JSON.stringify(result.results[0]).length <= 60 ? JSON.stringify(result.results[0]) : null;

  const rows: ReactNode[] = [];
  const walk = (parent: string, depth: number) => {
    const loaded = nodes.get(parent);
    if (!loaded) {
      rows.push(
        <li key={`${parent}#loading`} className="text-caption-1 text-fg-muted" style={{ paddingInlineStart: `calc(${depth} * var(--by-space-inline-xl))` }}>
          Loading…
        </li>,
      );
      return;
    }
    for (const c of loaded.children) {
      const container = (c.kind === "object" || c.kind === "array") && (c.length ?? 0) > 0;
      const isOpen = open.has(c.path);
      rows.push(
        <li key={c.path} style={{ paddingInlineStart: `calc(${depth} * var(--by-space-inline-xl))` }}>
          <button
            type="button"
            aria-expanded={container ? isOpen : undefined}
            aria-current={selected === c.path ? "true" : undefined}
            onClick={() => (container ? toggle(c.path) : setSelected(c.path))}
            className={cn("flex h-control-sm w-full min-w-0 items-center gap-inline-sm rounded-sm px-inline-xs text-start text-body-1 hover:bg-hover", selected === c.path && "bg-selected")}
          >
            <span className="flex size-icon-md shrink-0 items-center justify-center">{container ? <Icon icon={isOpen ? ChevronDown : ChevronRight} size="sm" /> : null}</span>
            <span className="shrink-0 font-mono text-code text-fg">{loaded.node.kind === "array" ? `[${c.key}]` : c.key}</span>
            <span className={cn("min-w-0 flex-1 truncate font-mono text-code", container && loaded.node.kind !== "array" ? "text-fg-muted" : "text-fg")}>{describe(c, loaded.node.kind === "array")}</span>
            {container && c.kind === "array" && isOpen && nodes.get(c.path) ? (
              <span className="shrink-0 text-caption-1 text-fg-muted">
                showing {formatCount(nodes.get(c.path)!.node.offset + 1)}–{formatCount(nodes.get(c.path)!.node.offset + nodes.get(c.path)!.children.length)}
                {(c.length ?? 0) > 0 ? `, each about ${formatBytes(Math.round(c.bytes / (c.length ?? 1)))}` : ""}
              </span>
            ) : null}
            <span className="shrink-0 text-caption-1 text-fg-muted tabular-nums">{formatBytes(c.bytes)}</span>
          </button>
        </li>,
      );
      if (container && isOpen) {
        walk(c.path, depth + 1);
        const child = nodes.get(c.path);
        if (child && child.node.kind === "array") {
          const shownTo = child.node.offset + child.children.length;
          rows.push(
            <li key={`${c.path}#more`} className="flex items-center gap-inline-md py-stack-xs text-caption-1 text-fg-muted" style={{ paddingInlineStart: `calc(${depth + 1} * var(--by-space-inline-xl) + var(--by-size-icon-md))` }}>
              {shownTo < child.node.total ? (
                <LinkButton className="text-caption-1" onClick={() => void load(c.path, shownTo)}>
                  Load {Math.min(50, child.node.total - shownTo)} more
                </LinkButton>
              ) : (
                <span>All {formatCount(child.node.total)} shown</span>
              )}
              <form
                className="flex items-center gap-inline-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  const n = Number(goTo[c.path]);
                  if (Number.isInteger(n) && n >= 0 && n < child.node.total) void load(c.path, n);
                }}
              >
                <Input size="small" aria-label={`Go to index in ${jqPath(c.path, arrays)}`} placeholder="Go to index" inputMode="numeric" value={goTo[c.path] ?? ""} onValueChange={(v) => setGoTo((g) => ({ ...g, [c.path]: v }))} className="w-panel-xs" />
              </form>
            </li>,
          );
        } else if (child && child.node.offset + child.children.length < child.node.total) {
          rows.push(
            <li key={`${c.path}#more`} className="py-stack-xs" style={{ paddingInlineStart: `calc(${depth + 1} * var(--by-space-inline-xl) + var(--by-size-icon-md))` }}>
              <LinkButton className="text-caption-1" onClick={() => void load(c.path, child.node.offset + child.children.length)}>
                Load {Math.min(50, child.node.total - child.node.offset - child.children.length)} more
              </LinkButton>
            </li>,
          );
        }
      }
    }
  };
  if (root && (root.node.kind === "object" || root.node.kind === "array")) walk("", 0);

  const keys = root ? [...root.children].sort((a, b) => b.bytes - a.bytes) : [];
  const biggest = root?.node.info?.largestArrays[0];

  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-slot="payload-view">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-inline-md gap-y-stack-sm px-inset-lg py-stack-sm">
          <span className="text-body-1-strong text-fg">{label}</span>
          <Badge appearance="tint" variant={verdict.tone}>
            {verdict.text}
          </Badge>
          <CodecChain stub={stub} />
          <span className="flex-1" />
          <ToggleGroup aria-label="View" size="small" value={[view]} onValueChange={(v) => v[0] && setView(v[0] as View)}>
            <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
            <ToggleGroupItem value="text">Text</ToggleGroupItem>
            <ToggleGroupItem value="stored">Stored bytes</ToggleGroupItem>
          </ToggleGroup>
        </div>
        <form
          aria-label="jq on the server"
          className="flex shrink-0 flex-wrap items-center gap-x-inline-md gap-y-stack-xs px-inset-lg pb-stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void runJq();
          }}
        >
          <CodeEditor singleLine size="small" language="jq" aria-label="jq" value={jq} onValueChange={setJq} onSubmit={() => void runJq()} invalid={jqError !== null} placeholder=".items | map(select(.qty == 0)) | length" className="min-w-panel-xs flex-1" />
          <Button type="submit" size="small" appearance="primary" loading={running} disabled={jq.trim() === ""}>
            <Icon icon={Play} /> Run jq
          </Button>
          {single !== null && result ? (
            <span role="status" className="flex items-center gap-inline-sm">
              <span className="font-mono text-code text-fg">
                → <strong>{single}</strong>
              </span>
              <span className="text-caption-1 text-fg-muted">on the server, {result.ms} ms</span>
            </span>
          ) : null}
          <span aria-hidden="true" className="h-control-sm border-s border-border-subtle" />
          <Button size="small" appearance="subtle" loading={downloading === "decoded"} onClick={() => void save("decoded")}>
            <Icon icon={ArrowDownload} /> Decoded JSON
          </Button>
          <Button size="small" appearance="subtle" loading={downloading === "stored"} onClick={() => void save("stored")}>
            <Icon icon={ArrowDownload} /> Stored bytes
          </Button>
        </form>
        {jqError ? (
          <p role="alert" className="px-inset-lg pb-stack-sm text-body-1 text-danger-fg">
            {jqError}
          </p>
        ) : null}
        {result && single === null ? (
          <div className="shrink-0 px-inset-lg pb-stack-sm">
            <p role="status" className="pb-stack-xs text-caption-1 text-fg-muted">
              {formatCount(result.results.length)} {result.results.length === 1 ? "result" : "results"}, {formatBytes(result.bytes)}
              {result.truncated ? ", cut at 1 MiB" : ""} · on the server, {result.ms} ms
            </p>
            {/* json-exception: jq prints a sequence of JSON values, one after another, which is not one JSON value */}
            <CodeBlock code={result.results.map((r) => JSON.stringify(r, null, 2)).join("\n")} language="json" appearance="inset" copyable aria-label="jq results" className="max-h-panel-sm" />
          </div>
        ) : null}
        {error ? (
          <div className="shrink-0 px-inset-lg pb-stack-sm">
            {gone ? (
              <Alert intent="warning">
                <AlertDescription>
                  {error.title}
                  {onReload ? (
                    <>
                      {" "}
                      <LinkButton onClick={onReload}>Reload the event</LinkButton>
                    </>
                  ) : null}
                </AlertDescription>
              </Alert>
            ) : (
              <ErrorState error={error} onRetry={() => void load("")} />
            )}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle px-inset-sm py-stack-sm">
          {view === "tree" ? (
            root ? (
              root.node.kind === "object" || root.node.kind === "array" ? (
                <ul aria-label={`${label} as a tree`} className="flex flex-col">
                  {rows}
                </ul>
              ) : (
                <JsonView modeKey="temporal.payload.value" value={root.node.value} aria-label={label} className="max-h-panel-sm" />
              )
            ) : !error ? (
              <p role="status" className="px-inset-sm text-body-1 text-fg-muted">
                Loading the payload from the server…
              </p>
            ) : null
          ) : view === "text" ? (
            text !== null ? (
              <div className="flex flex-col gap-stack-xs">
                <p className="px-inset-sm text-caption-1 text-fg-muted">The first {formatBytes(Math.min(new TextEncoder().encode(text).byteLength, 64 * 1024))} of {formatBytes(stub.decodedBytes)} of JSON; download the decoded JSON for all of it.</p>
                {/* json-exception: the first 64 KiB of the JSON, cut mid-text, so not a JSON value */}
                <CodeBlock code={text} language="json" appearance="inset" lineNumbers aria-label={`${label} as text`} virtualizeAfter={2000} />
              </div>
            ) : (
              <p role="status" className="px-inset-sm text-body-1 text-fg-muted">
                Reading the text…
              </p>
            )
          ) : stored ? (
            <div className="flex flex-col gap-stack-xs">
              <p className="px-inset-sm text-caption-1 text-fg-muted">
                The first {formatBytes(stored.byteLength)} of {formatBytes(stub.bytes)} as the {stub.encoding} encoding read them{stub.codec ? `, after the codec ${stub.codec.codec}` : ""}.
              </p>
              <HexView bytes={stored} aria-label={`${label}, stored bytes`} className="h-panel-sm" />
            </div>
          ) : (
            <p role="status" className="px-inset-sm text-body-1 text-fg-muted">
              Reading the stored bytes…
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-inline-md border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">
          <span>Selected</span>
          <span className="font-mono text-code text-fg">{path}</span>
          <CopyButton value={path} what="path" />
          <span aria-hidden="true" className="h-control-sm border-s border-border-subtle" />
          <span className="min-w-0 truncate">Nodes load from the server as you open them; the browser holds only what is open.</span>
        </div>
      </div>
      <aside aria-label="Payload size" className="flex w-panel-pane max-w-1/2 shrink-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
        <section className="flex flex-col gap-stack-sm">
          <div>
            <h3 className="text-body-1-strong text-fg">What makes it big</h3>
            <p className="text-caption-1 text-fg-muted">{root?.node.kind === "array" ? "Entries" : "Top-level keys"}, by encoded size</p>
          </div>
          {keys.slice(0, 8).map((k) => (
            <Bar key={k.path} label={root?.node.kind === "array" ? `[${k.key}]` : k.key} mono value={(100 * k.bytes) / Math.max(1, stub.decodedBytes)} text={formatBytes(k.bytes)} variant="accent" />
          ))}
          {biggest ? (
            <p className="text-caption-1 text-fg-muted">
              <span className="font-mono">{jqPath(biggest.path, new Set(root?.node.info?.largestArrays.map((a) => a.path)))}</span>: {formatCount(biggest.length)} entries, about {formatBytes(biggest.entryBytes)} each.
            </p>
          ) : null}
        </section>
        <section className="flex flex-col gap-stack-sm">
          <div>
            <h3 className="text-body-1-strong text-fg">Temporal&apos;s limits</h3>
            <p className="text-caption-1 text-fg-muted">Defaults; a cluster can change them</p>
          </div>
          <LimitBar label="Payload" used={stub.bytes} limit={LIMITS.payload} warn={LIMITS.payloadWarn} text={`${formatBytes(stub.bytes)} / 2 MiB`} />
          {context?.historyBytes !== undefined ? <LimitBar label="History" used={context.historyBytes} limit={LIMITS.history} warn={LIMITS.historyWarn} text={`${formatBytes(context.historyBytes)} / 50 MiB`} /> : null}
          {context?.events !== undefined ? <LimitBar label="Events" used={context.events} limit={LIMITS.events} warn={LIMITS.events * 0.2} text={`${formatCount(context.events)} / ${formatCount(LIMITS.events)}`} /> : null}
          <p className="text-caption-1 text-fg-muted">A payload over 2 MiB fails the workflow task. Over 512 KiB the server logs a warning.</p>
        </section>
        {context?.largest && context.largest.length > 0 ? (
          <section className="flex flex-col gap-stack-sm">
            <h3 className="text-body-1-strong text-fg">Largest payloads in this run</h3>
            <dl className="flex flex-col gap-stack-xs text-body-1">
              {context.largest.slice(0, 5).map((p) => (
                <div key={`${p.eventId}/${p.label}`} className="flex items-baseline gap-inline-md">
                  <dt className="font-mono text-code">
                    {context.onGoToEvent ? <LinkButton onClick={() => context.onGoToEvent?.(p.eventId)}>event {formatCount(p.eventId)}</LinkButton> : `event ${formatCount(p.eventId)}`}
                  </dt>
                  <dd className="text-fg-muted">
                    {p.label} · {formatBytes(p.bytes)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </aside>
    </div>
  );
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.byteLength;
  }
  return all;
}

/** A labelled bar with its value in words. */
function Bar({ label, text, value, variant, mono = false }: { label: string; text: string; value: number; variant: "accent" | "success" | "warning" | "danger"; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-stack-xs">
      <div className="flex items-center justify-between gap-inline-md text-body-1">
        <span className={cn("min-w-0 truncate text-fg", mono && "font-mono text-code")}>{label}</span>
        <span className="shrink-0 text-caption-1 text-fg-muted tabular-nums">{text}</span>
      </div>
      <Progress aria-label={`${label}: ${text}`} value={Math.min(100, Math.max(0.5, value))} variant={variant} />
    </div>
  );
}

function LimitBar({ label, used, limit, warn, text }: { label: string; used: number; limit: number; warn: number; text: string }) {
  return <Bar label={label} text={text} value={(100 * used) / limit} variant={used > limit ? "danger" : used >= warn ? "warning" : "success"} />;
}
