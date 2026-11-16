// The demo page: `pnpm --filter @byterygon/data-grid demo`. ?rows=N sets the row count
// (default 1,000,000), ?density=comfortable and ?theme=dark switch the token modes.
import "@byterygon/design-tokens/default/tokens.css";
import "../src/data-grid.css";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { DataGrid, type FrameSample } from "../src/index.ts";
import { SYNTHETIC_FIELDS, syntheticBatch } from "./synthetic.ts";

const params = new URLSearchParams(location.search);
const total = Number(params.get("rows") ?? 1_000_000);
document.documentElement.dataset["density"] = params.get("density") ?? "compact";
document.documentElement.dataset["theme"] = params.get("theme") ?? "light";

const samples: FrameSample[] = [];
(globalThis as { gridSamples?: FrameSample[] }).gridSamples = samples;

function Demo() {
  const batches = useMemo(() => {
    const out = [];
    for (let start = 0; start < total; start += 4096) out.push(syntheticBatch(start, Math.min(4096, total - start)));
    return out;
  }, []);
  const [last, setLast] = useState<FrameSample | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <p style={{ margin: 0, padding: 8 }} aria-live="polite">
        {total.toLocaleString()} rows · last frame {last ? `${last.duration.toFixed(1)} ms (work ${last.work.toFixed(1)} ms)` : "–"}
      </p>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DataGrid
          fields={SYNTHETIC_FIELDS}
          batches={batches}
          aria-label="Synthetic result"
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
