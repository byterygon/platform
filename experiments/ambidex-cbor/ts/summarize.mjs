import { readFileSync, writeFileSync, existsSync } from "node:fs";
const url = (p) => new URL("../results/" + p, import.meta.url);
const load = (p) => JSON.parse(readFileSync(url(p)));
const quantile = (a, p) =>
  a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
let seed = 21021;
function random() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
}
function interval(trials) {
  const values = [];
  for (let i = 0; i < 2000; i++) {
    const selected = Array.from(
      { length: trials.length },
      () => trials[random() % trials.length],
    );
    values.push(quantile(selected, 0.5));
  }
  return [quantile(values, 0.025), quantile(values, 0.975)];
}
const summarize = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    const key = [
      r.transport ?? "in-process",
      r.stage ?? "codec",
      r.name,
      r.codec,
    ].join("/");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return Array.from(groups, ([key, rs]) => {
    const samples = rs.flatMap((r) => r.samplesMs),
      p95 = rs.map((r) => quantile(r.samplesMs, 0.95));
    const memory = rs
      .map((r) => r.sampledPeakHeapBytes)
      .filter((x) => typeof x === "number");
    return {
      key,
      bytes: rs[0].bytes,
      p50Ms: quantile(samples, 0.5),
      p95Ms: quantile(samples, 0.95),
      p95MedianTrialMs: quantile(p95, 0.5),
      p95MedianTrialBootstrap95CI: interval(p95),
      confidenceCaveat:
        "Seeded bootstrap across only five trial p95 values; exploratory, timer batching and host variability still apply",
      trialP95RangeMs: [Math.min(...p95), Math.max(...p95)],
      samples: samples.length,
      ...(memory.length ? { maxSampledHeapBytes: Math.max(...memory) } : {}),
    };
  });
};
const node = load("node-bench.json"),
  browser = load("browser-bench.json"),
  rust = load("rust-bench.json");
const summary = {
  bootstrapSeed: 21021,
  node: summarize(node.results),
  rust: summarize(rust.results),
  browsers: browser.results.map((r) => ({
    engine: r.engine,
    error: r.error,
    memoryLimitation: r.memoryLimitation,
    summary: r.raw ? summarize(r.raw) : [],
  })),
  transport: existsSync(url("transport-bench.json"))
    ? summarize(load("transport-bench.json").results)
    : [],
};
writeFileSync(url("summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(
  "Summary groups:",
  summary.node.length,
  summary.rust.length,
  summary.browsers.map((x) => [x.engine, x.summary.length]),
  summary.transport.length,
);
