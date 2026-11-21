// A value the server left out of a reply because it was over its share (TSK-108, spec §9 "Replies
// and the frame limit"): a row that says what it is and how big, with a Load button. The whole
// value comes from the procedure that carries it up to 12 MiB, and from a stream over that.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { JsonViewer } from "@/components/ui/json-viewer";
import type { MightyClient } from "@/app/client";
import type * as api from "@/gen/api";
import type { DescribedError } from "../types";
import { ErrorState } from "@/app/states";

/** Where a cut value belongs: one checkpoint of a thread (the current one when absent) or one run. */
export interface CutSource {
  connId: string;
  threadId: string;
  checkpointId?: string | null;
  runId?: string | null;
}

/** The size as a person reads it: `3.0 MiB`. */
export function sizeText(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

const KIND_TEXT: Record<string, string> = { object: "an object", array: "an array", string: "a string", number: "a number", boolean: "a boolean", null: "null" };

/** The cut of a field, if the reply left it out. */
export function cutOf(cuts: readonly api.ValueCut[], field: string): api.ValueCut | undefined {
  return cuts.find((c) => c.field === field);
}

/**
 * The whole value of a cut. A checkpoint's `values` or `metadata`, and a run's `metadata`, come
 * from `threads.state` or `runs.get` with room for 12 MiB; anything else, and anything bigger,
 * is read as a stream of JSON text (one value, never more than a chunk at a time in the frame).
 */
export async function loadCut(client: MightyClient, source: CutSource, cut: api.ValueCut): Promise<api.JsonValue> {
  const { connId, threadId } = source;
  if (!source.runId && (cut.field === "values" || cut.field === "metadata")) {
    const state = await client.langgraph.threads.state({ connId, threadId, checkpointId: source.checkpointId ?? null, subgraphs: null, full: true });
    if (!cutOf(state.cuts, cut.field)) return cut.field === "values" ? state.values : state.metadata;
  } else if (source.runId && cut.field === "metadata") {
    const run = await client.langgraph.runs.get({ connId, threadId, runId: source.runId });
    if (run.cuts.length === 0) return run.metadata;
  }
  const stream = client.langgraph.threads.readValue({ connId, threadId, runId: source.runId ?? null, checkpointId: source.checkpointId ?? null, field: cut.field }, { timeoutMs: 600_000 });
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.chunks()) {
    parts.push(chunk);
    total += chunk.byteLength;
  }
  await stream.result;
  const all = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all)) as api.JsonValue;
}

interface CutValueProps {
  /** What the value is called on the screen: `Values`, `Metadata`. */
  label: string;
  cut: api.ValueCut;
  load: () => Promise<api.JsonValue>;
  note: (e: unknown) => DescribedError;
  className?: string | undefined;
}

/** The note in the value's place, and the value itself once it is loaded. */
export function CutValue({ label, cut, load, note, className }: CutValueProps) {
  const [value, setValue] = useState<{ v: api.JsonValue } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  if (value) return <JsonViewer value={value.v} aria-label={label} defaultExpandDepth={2} {...(className ? { className } : {})} />;
  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setValue({ v: await load() });
    } catch (e) {
      setError(note(e));
    } finally {
      setLoading(false);
    }
  };
  const size = sizeText(cut.bytes);
  return (
    <div role="group" aria-label={`${label}, left out`} className="flex flex-col gap-stack-xs rounded-md bg-layer-alt p-inset-sm">
      <p className="text-body-1 text-fg">
        {label} is {KIND_TEXT[cut.kind] ?? cut.kind} of {size}: too big to send with the rest.
      </p>
      <code className="line-clamp-3 font-mono text-code break-all text-fg-muted" title={cut.preview}>
        {cut.preview}
        {cut.bytes > cut.preview.length ? "…" : ""}
      </code>
      <div>
        <Button size="small" loading={loading} onClick={() => void run()}>
          Load {size}
        </Button>
      </div>
      {error ? <ErrorState error={error} onRetry={() => void run()} /> : null}
    </div>
  );
}
