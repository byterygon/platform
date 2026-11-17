// The demo page: `pnpm --filter @byterygon/data-grid demo`.
//   ?rows=N          row count (default 1,000,000)
//   ?mode=static     all batches up front instead of a stream
//   ?mode=main       a stream built on the UI thread (default: built in a Worker, as in DBee)
//   ?budget=MiB      memory budget (default 256)
//   ?delay=ms        delay before each streamed batch of ?mode=main (default 2)
//   ?pace=ms         delay before each batch of the Worker stream (default 0)
//   ?density=comfortable, ?theme=dark
// `window.gridSamples` collects the frame samples; `window.grid` is the DataGridHandle.
import "@byterygon/design-tokens/default/tokens.css";
import "../src/data-grid.css";
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataGrid, type DataGridHandle, type FrameSample, type ResultProgress, type SelectionInfo } from "../src/index.ts";
import { SYNTHETIC_FIELDS, syntheticBatch, syntheticStream, workerStream } from "./synthetic.ts";

const params = new URLSearchParams(location.search);
const total = Number(params.get("rows") ?? 1_000_000);
const mode = params.get("mode") ?? "worker";
const budget = Number(params.get("budget") ?? 256) * 1024 * 1024;
const delay = Number(params.get("delay") ?? 2);
const pace = Number(params.get("pace") ?? 0);
document.documentElement.dataset["density"] = params.get("density") ?? "compact";
document.documentElement.dataset["theme"] = params.get("theme") ?? "light";

const samples: FrameSample[] = [];
const globals = globalThis as { gridSamples?: FrameSample[]; grid?: DataGridHandle | null };
globals.gridSamples = samples;

function Demo() {
  const started = useMemo(() => performance.now(), []);
  const stream = useMemo(() => (mode === "worker" ? workerStream(total, 4096, pace) : mode === "main" ? syntheticStream(total, 4096, delay) : undefined), []);
  const batches = useMemo(() => {
    if (mode !== "static") return undefined;
    const out = [];
    for (let start = 0; start < total; start += 4096) out.push(syntheticBatch(start, Math.min(4096, total - start)));
    return out;
  }, []);
  const ref = useRef<DataGridHandle>(null);
  const [progress, setProgress] = useState<ResultProgress | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [last, setLast] = useState<FrameSample | null>(null);
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  const statusText =
    progress === null
      ? ""
      : progress.state === "paused"
        ? `Loaded ${progress.rows.toLocaleString()} rows, scroll for more`
        : progress.state === "done"
          ? `${progress.rows.toLocaleString()} rows`
          : `${progress.rows.toLocaleString()} rows… ${progress.state} ${elapsed} s`;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", padding: 8, fontFamily: "var(--by-font-sans)" }}>
        <span role="status">{statusText}</span>
        <span>{progress ? `${(progress.bytes / 1048576).toFixed(0)} MiB` : ""}</span>
        <span>{selection ? `${selection.cells} cells · ${selection.value === null ? "NULL" : selection.value === "" ? "empty string" : "value"}` : ""}</span>
        <span>{last ? `frame ${last.duration.toFixed(1)} ms (work ${last.work.toFixed(1)} ms)` : ""}</span>
        <button type="button" onClick={() => ref.current?.cancel()}>
          Cancel
        </button>
        <button type="button" onClick={() => void ref.current?.copy("csv", true)}>
          Copy CSV
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DataGrid
          ref={(h) => {
            ref.current = h;
            globals.grid = h;
          }}
          {...(stream ? { stream } : { fields: SYNTHETIC_FIELDS, batches: batches! })}
          memoryBudget={budget}
          aria-label="Synthetic result"
          onProgress={setProgress}
          onSelectionChange={setSelection}
          onFrameSample={(s) => {
            samples.push(s);
            setLast(s);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Demo />);
