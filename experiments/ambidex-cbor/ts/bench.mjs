import { performance, PerformanceObserver } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { jobs, operation, encodedBytes } from "./bench-core.mjs";
const results = [];
const gc = [];
const observer = new PerformanceObserver((list) =>
  gc.push(
    ...list.getEntries().map((e) => ({
      start: e.startTime,
      duration: e.duration,
      kind: e.detail.kind,
    })),
  ),
);
observer.observe({ entryTypes: ["gc"] });
for (const { w, codec, stage, trial } of jobs()) {
  for (let i = 0; i < (w.supplemental ? 2 : 20); i++)
    operation(w, codec, stage);
  global.gc?.();
  await new Promise(setImmediate);
  const baseline = process.memoryUsage(),
    started = performance.now(),
    cpu = process.cpuUsage();
  const samplesMs = [];
  let peakHeap = baseline.heapUsed,
    peakRss = baseline.rss;
  for (let i = 0; i < (w.supplemental ? 10 : 100); i++) {
    const start = performance.now();
    operation(w, codec, stage);
    samplesMs.push(performance.now() - start);
    const m = process.memoryUsage();
    peakHeap = Math.max(peakHeap, m.heapUsed);
    peakRss = Math.max(peakRss, m.rss);
  }
  const ended = performance.now(),
    usage = process.cpuUsage(cpu);
  await new Promise(setImmediate);
  results.push({
    name: w.name,
    codec,
    stage,
    trial,
    bytes: encodedBytes(w, codec),
    samplesMs,
    cpuUserMicros: usage.user,
    cpuSystemMicros: usage.system,
    sampledPeakHeapBytes: peakHeap,
    sampledPeakRssBytes: peakRss,
    baselineHeapBytes: baseline.heapUsed,
    gc: gc.filter((e) => e.start >= started && e.start <= ended),
    legacyContextOnly: codec === "json-v1",
  });
}
observer.disconnect();
writeFileSync(
  new URL("../results/node-bench.json", import.meta.url),
  JSON.stringify(
    {
      environment: {
        os: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        cpu: os.cpus()[0].model,
        node: process.version,
        gcExposed: !!global.gc,
      },
      measurement:
        "codec and in-process mock RPC; identical validation/hydration for json-v2 and cbor; v1 is contextual without extra validation",
      memory:
        "heap/RSS sampled between operations; GC from perf_hooks. Transient intra-operation peaks may be missed.",
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log("Node trials:", results.length);
