#!/usr/bin/env node
// The data grid in a real browser (TSK-39, DBee spec §6 and Decision 17). It builds the demo page
// (demo/) with Vite, serves it from loopback and drives Chromium over the DevTools protocol (Node's
// own WebSocket; no Playwright or Puppeteer). It measures:
//
//   - streaming: 1,000,000 x 10 rows streamed from a Worker (one batch every --pace ms), while the
//     page scrolls 200 px per frame for --seconds; the stream must still be running at the end;
//   - static: the same rows already loaded, same scroll;
//
// and for each the frame interval (rAF to rAF, what the user sees: p50, p95, p99, max, frames longer
// than 1.5 refresh intervals) and the grid's own work per frame, the display's refresh interval
// (idle rAF), and after loading the JS heap against the buffer bytes held: per-row objects would
// put 1M objects (> 64 MB) on the JS heap, while the buffers live outside it.
//
// The Decision 17 gate is reported two ways, because a frame interval cannot go below the refresh
// interval (16.7 ms at 60 Hz) and the literal "< 16 ms" can never pass (DOC-18 Open question 14):
//   literal:  p95 < 16 ms;
//   proposed: p95 <= 1.1 x the refresh interval (no dropped frames).
// The check fails on functional problems (no frames, page errors, a request outside the loopback
// server, a stream that ended before the measurement, per-row objects on the heap); with --enforce
// it also fails when the proposed gate fails. Headless Chrome without a GPU paces frames its own
// way, so a CI runner's numbers are a smoke test, not the benchmark (TSK-17).
//
//   node scripts/frame-check.ts [--json] [--enforce] [--seconds 3] [--pace 25] [--rows 1000000] [--headful]
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge from the usual places, else
// Playwright's cached Chromium. Without one the check is skipped (exit 0), unless
// BYTERYGON_REQUIRE_BROWSER=1 (CI). Exit codes: 0 ok or skipped, 1 a check failed, 2 bad command line.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const isMac = process.platform === "darwin";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};

/** A Chromium-family browser on this machine, or null (the same search as packages/ui). */
function findBrowser(): string | null {
  const fromEnv = process.env.BYTERYGON_BROWSER ?? process.env.CHROME_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const onPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((name) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)));
  const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  const playwright = [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")].flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()
      .flatMap((d) => [
        join(dir, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(dir, d, "chrome-linux64", "chrome"),
        join(dir, d, "chrome-linux", "chrome"),
      ]);
  });
  return [...onPath, ...(isMac ? mac : []), ...playwright].find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".map": "application/json" };

async function buildDemo(outDir: string): Promise<void> {
  const vite = await import("vite");
  await vite.build({
    configFile: join(PACKAGE_ROOT, "vite.config.ts"),
    root: join(PACKAGE_ROOT, "demo"),
    base: "./",
    logLevel: "error",
    build: { outDir, emptyOutDir: true, reportCompressedSize: false },
    worker: { format: "es" },
  });
}

function serve(dir: string): Promise<Server> {
  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    const file = join(dir, path === "/" ? "index.html" : path);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------------------------------------------------------------------------------------------
// A minimal DevTools protocol client.

type Params = Record<string, unknown>;
interface Message {
  id?: number;
  method?: string;
  params?: Params;
  sessionId?: string;
  result?: Params;
  error?: { message: string };
}

class Cdp {
  #nextId = 0;
  readonly #pending = new Map<number, { resolve: (v: Params) => void; reject: (e: Error) => void }>();
  readonly #listeners = new Set<(m: Message) => void>();
  readonly #socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiter = this.#pending.get(message.id);
        this.#pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else for (const l of this.#listeners) l(message);
    });
  }
  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(new Cdp(socket)), { once: true });
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), { once: true });
    });
  }
  send(method: string, params: Params = {}, sessionId?: string): Promise<Params> {
    const id = ++this.#nextId;
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }
  on(listener: (m: Message) => void): void {
    this.#listeners.add(listener);
  }
  close(): void {
    this.#socket.close();
  }
}

async function launch(binary: string, profile: string, headful: boolean): Promise<{ child: ChildProcess; url: string }> {
  const args = [
    ...(headful ? [] : ["--headless=new"]),
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,900",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`the browser did not start:\n${stderr}`)), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the browser exited (${code}):\n${stderr}`));
    });
  });
  return { child, url };
}

interface Page {
  evaluate: <T>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<void>;
  send: (method: string, params?: Params) => Promise<Params>;
  requests: string[];
  errors: string[];
}

async function openPage(cdp: Cdp): Promise<Page> {
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const send = (method: string, params: Params = {}) => cdp.send(method, params, sessionId);
  const requests: string[] = [];
  const errors: string[] = [];
  let loaded: (() => void) | undefined;
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") requests.push(String((m.params!.request as { url: string }).url));
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify((m.params!.exceptionDetails as { exception?: { description?: string } }).exception?.description ?? m.params!.exceptionDetails));
    if (m.method === "Page.loadEventFired") loaded?.();
  });
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(method);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
      if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      return result.result.value;
    },
    async navigate(url) {
      const done = new Promise<void>((resolve) => (loaded = resolve));
      await send("Page.navigate", { url });
      await done;
    },
    send,
    requests,
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
// The measurement, run in the page.

interface Stats {
  frames: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Frames longer than 1.5 refresh intervals. */
  long: number;
  workP95: number;
  rowsAtStart: number;
  rowsAtEnd: number;
  stateAtEnd: string;
}

/** Scrolls 200 px per frame for `seconds` and summarizes the grid's frame samples. */
const SCROLL = (seconds: number, refresh: number) => `(async () => {
  const s = document.querySelector('.bdg-scroller');
  const rowsAtStart = grid.progress.rows;
  gridSamples.length = 0;
  const t0 = performance.now();
  await new Promise((done) => { const step = () => { s.scrollTop += 200; if (performance.now() - t0 < ${seconds * 1000}) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
  const progress = grid.progress;
  const d = gridSamples.map((x) => x.duration).sort((a, b) => a - b);
  const w = gridSamples.map((x) => x.work).sort((a, b) => a - b);
  const q = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN;
  return { frames: d.length, p50: q(d, 0.5), p95: q(d, 0.95), p99: q(d, 0.99), max: d.at(-1) ?? NaN, long: d.filter((x) => x > 1.5 * ${refresh}).length, workP95: q(w, 0.95), rowsAtStart, rowsAtEnd: progress.rows, stateAtEnd: progress.state };
})()`;

/** The display's refresh interval: the median rAF interval of 60 idle frames. */
const REFRESH = `new Promise((resolve) => { const t = []; const f = (now) => { t.push(now); if (t.length < 61) requestAnimationFrame(f); else { const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b); resolve(d[30]); } }; requestAnimationFrame(f); setTimeout(() => resolve(NaN), 5000); })`;

const waitFor = async (page: Page, expression: string, timeout = 30_000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate<boolean>(expression).catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

interface Options {
  json: boolean;
  enforce: boolean;
  headful: boolean;
  seconds: number;
  pace: number;
  rows: number;
}

function parse(argv: string[]): Options | string {
  const o: Options = { json: false, enforce: false, headful: false, seconds: 3, pace: 25, rows: 1_000_000 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") o.json = true;
    else if (a === "--enforce") o.enforce = true;
    else if (a === "--headful") o.headful = true;
    else if (a === "--seconds" || a === "--pace" || a === "--rows") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) return `${a} needs a number`;
      o[a.slice(2) as "seconds" | "pace" | "rows"] = n;
    } else return `unknown option ${a}`;
  }
  return o;
}

async function main(argv: string[]): Promise<number> {
  const options = parse(argv);
  if (typeof options === "string") {
    console.error(`frame-check: ${options}`);
    return 2;
  }
  const binary = findBrowser();
  if (binary === null) {
    if (process.env.BYTERYGON_REQUIRE_BROWSER === "1") {
      console.error("frame-check: no Chromium-family browser found and BYTERYGON_REQUIRE_BROWSER=1");
      return 1;
    }
    console.log("frame-check: skipped (no Chromium-family browser; set BYTERYGON_BROWSER)");
    return 0;
  }
  const work = mkdtempSync(join(tmpdir(), "data-grid-frames-"));
  const out = join(work, "dist");
  await buildDemo(out);
  const server = await serve(out);
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { child, url } = await launch(binary, join(work, "profile"), options.headful);
  const cdp = await Cdp.connect(url);
  const report: Record<string, unknown> = { browser: binary, rows: options.rows, seconds: options.seconds, pace: options.pace };
  try {
    const page = await openPage(cdp);
    const scenarios = [
      { name: "streaming", query: `?rows=${options.rows}&pace=${options.pace}` },
      { name: "static", query: `?rows=${options.rows}&mode=static` },
    ];
    let refresh = Number.NaN;
    for (const scenario of scenarios) {
      await page.navigate(`${origin}/${scenario.query}`);
      if (!check(await waitFor(page, "Boolean(window.grid) && window.grid.progress.rows > 0"), `${scenario.name}: the grid shows no rows`)) continue;
      if (Number.isNaN(refresh)) {
        refresh = await page.evaluate<number>(REFRESH);
        if (!check(Number.isFinite(refresh), "the browser produces no animation frames (headless Chrome on macOS with the display asleep does this; rerun with the display awake or --headful)")) break;
      }
      // The static page builds its rows on the UI thread at load; let that garbage go first.
      if (scenario.name === "static") await page.evaluate("new Promise((r) => setTimeout(r, 1000))");
      const stats = await page.evaluate<Stats>(SCROLL(options.seconds, refresh));
      report[scenario.name] = stats;
      check(stats.frames > options.seconds * 10, `${scenario.name}: only ${stats.frames} frame samples`);
      if (scenario.name === "streaming") check(stats.stateAtEnd === "streaming" && stats.rowsAtEnd > stats.rowsAtStart, `streaming: the stream was not running during the measurement (${stats.rowsAtStart} -> ${stats.rowsAtEnd}, ${stats.stateAtEnd}); raise --pace`);
    }
    // Heap: all rows loaded, garbage collected; per-row objects would be on the JS heap.
    await waitFor(page, "window.grid.progress.state === 'done'", 60_000);
    await page.send("HeapProfiler.enable");
    await page.send("HeapProfiler.collectGarbage");
    const heap = (await page.send("Runtime.getHeapUsage")) as { usedSize: number; totalSize: number; backingStorageSize?: number };
    const bytes = await page.evaluate<number>("window.grid.progress.bytes");
    report["heap"] = { jsUsedMiB: heap.usedSize / 1048576, bufferMiB: bytes / 1048576, ...(heap.backingStorageSize !== undefined ? { backingStorageMiB: heap.backingStorageSize / 1048576 } : {}) };
    check(heap.usedSize < 64 * 1048576, `the JS heap holds ${(heap.usedSize / 1048576).toFixed(0)} MiB after loading: per-row objects?`);
    check(page.errors.length === 0, `page errors: ${page.errors.join("; ")}`);
    const outside = page.requests.filter((r) => !r.startsWith(origin) && !r.startsWith("data:") && !r.startsWith("blob:"));
    check(outside.length === 0, `requests outside the loopback server: ${outside.join(", ")}`);
    report["refreshMs"] = refresh;
    const streaming = report["streaming"] as Stats | undefined;
    if (streaming) {
      report["gate"] = {
        literal: { rule: "p95 < 16 ms", pass: streaming.p95 < 16 },
        proposed: { rule: `p95 <= 1.1 x refresh (${(1.1 * refresh).toFixed(1)} ms)`, pass: streaming.p95 <= 1.1 * refresh },
      };
      if (options.enforce) check(streaming.p95 <= 1.1 * refresh, `streaming: p95 ${streaming.p95.toFixed(1)} ms is over 1.1 x the refresh interval`);
    }
  } finally {
    cdp.close();
    child.kill();
    server.close();
    rmSync(work, { recursive: true, force: true });
  }
  report["failures"] = failures;
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : "-");
    console.log(`frame-check: ${report["browser"] as string}`);
    console.log(`refresh interval ${f(report["refreshMs"] as number)} ms; ${options.rows.toLocaleString("en-US")} rows; scroll 200 px/frame for ${options.seconds} s`);
    for (const name of ["streaming", "static"]) {
      const s = report[name] as Stats | undefined;
      if (s) console.log(`${name.padEnd(9)} frames ${s.frames}  p50 ${f(s.p50)}  p95 ${f(s.p95)}  p99 ${f(s.p99)}  max ${f(s.max)} ms  long ${s.long}  work p95 ${f(s.workP95)} ms  rows ${s.rowsAtStart} -> ${s.rowsAtEnd} (${s.stateAtEnd})`);
    }
    const heap = report["heap"] as { jsUsedMiB: number; bufferMiB: number } | undefined;
    if (heap) console.log(`heap      JS ${f(heap.jsUsedMiB)} MiB with ${f(heap.bufferMiB)} MiB of Arrow buffers held`);
    const gate = report["gate"] as { literal: { pass: boolean }; proposed: { rule: string; pass: boolean } } | undefined;
    if (gate) console.log(`gate      literal (p95 < 16 ms): ${gate.literal.pass ? "pass" : "fail"}; proposed (${gate.proposed.rule}): ${gate.proposed.pass ? "pass" : "fail"}`);
    for (const failure of failures) console.log(`FAIL ${failure}`);
  }
  return failures.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
