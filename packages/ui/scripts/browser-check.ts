#!/usr/bin/env node
// The editors in a real browser (TSK-46). jsdom cannot run Monaco, so this script builds a page
// with the editors (test/browser) with Vite, serves it from loopback, and drives Chromium over the
// DevTools protocol (Node's own WebSocket; no Playwright or Puppeteer). It checks:
//
//   - bundling: Monaco is in chunks the page loads only on demand, its worker is a bundled file,
//     nothing names a CDN, and every request the page makes goes to the loopback server;
//   - theme: in every preset, Light and Dark, the editor's background, keyword colour and gutter
//     equal the editor.* and syntax.* tokens of its region after a switch at run time, and its font
//     size follows text.code.size in Comfortable and Compact;
//   - keyboard: Tab reaches the editor, typing works, Ctrl+Enter (Cmd+Enter on macOS) runs the
//     statement, Tab indents, and Ctrl+M (Ctrl+Shift+M on macOS) lets Tab and Shift+Tab leave;
//   - a 1 MB document: load, a keystroke at the end and a run stay within bounds;
//   - TSK-90: a narrow tab strip never scrolls, hides the tabs that do not fit behind "More tabs" and
//     moves ArrowRight among the visible ones; a native scroll container takes the thin themed scrollbar;
//   - CodeInput: its colours, font and height follow the tokens in every preset, mode and density
//     (beside one in the other mode); Tab in and out, Enter submits, a FieldLabel click focuses
//     it; the pretty viewer shows a 1 MB JSON value and jumps to its end, rendering only what shows;
//
// and reports bundle sizes and the time to first keystroke (median of three cold loads).
//
//   node scripts/browser-check.ts [--json] [--verbose] [--report <file>] [--screenshot <file>]
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge from the usual places, else
// Playwright's cached Chromium. Without one the check is skipped (exit 0), unless
// BYTERYGON_REQUIRE_BROWSER=1 (CI), which makes that a failure. Exit codes: 0 ok or skipped,
// 1 a check failed, 2 bad command line. CI runs it in a network namespace with only loopback.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { PACKAGE_ROOT } from "./registry.ts";

const PAGE = join(PACKAGE_ROOT, "test", "browser");
const isMac = process.platform === "darwin";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};

/** A Chromium-family browser on this machine, or null. */
export function findBrowser(): string | null {
  const fromEnv = process.env.BYTERYGON_BROWSER ?? process.env.CHROME_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const onPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((name) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)));
  const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
  const edge = isMac ? ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"] : [];
  const playwright = [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")].flatMap((dir) => {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse()
      .flatMap((d) => [
        join(dir, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(dir, d, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        join(dir, d, "chrome-linux64", "chrome"),
        join(dir, d, "chrome-linux", "chrome"),
      ]);
  });
  return [...onPath, ...(isMac ? mac : []), ...playwright, ...edge].find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

// ---------------------------------------------------------------------------------------------
// Build and serve the page.

interface OutputFile {
  type: "chunk" | "asset";
  fileName: string;
  isEntry?: boolean;
  imports?: string[];
  code?: string;
  source?: string | Uint8Array;
  viteMetadata?: { importedCss?: Set<string>; importedAssets?: Set<string> };
  modules?: Record<string, { renderedLength?: number }>;
}

interface Size {
  files: number;
  bytes: number;
  gzip: number;
}

async function buildPage(outDir: string): Promise<{ files: OutputFile[]; html: string }> {
  const vite = await import("vite");
  const { default: tailwindcss } = await import("@tailwindcss/vite");
  const result = await vite.build({
    root: PAGE,
    configFile: false,
    base: "./",
    logLevel: "error",
    plugins: [tailwindcss()],
    resolve: { alias: { "@": join(PACKAGE_ROOT, "src") } },
    build: {
      outDir,
      emptyOutDir: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 4096,
      rolldownOptions: {
        onwarn(warning, warn) {
          if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
        },
      },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as unknown as { output: OutputFile[] }[];
  return { files: outputs.flatMap((o) => o.output), html: readFileSync(join(outDir, "index.html"), "utf8") };
}

const bytesOf = (file: OutputFile) => {
  const content = file.type === "chunk" ? file.code! : file.source!;
  const buffer = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
  return { bytes: buffer.length, gzip: gzipSync(buffer, { level: 9 }).length };
};

const sum = (files: OutputFile[]): Size => files.reduce((acc, f) => ({ files: acc.files + 1, bytes: acc.bytes + bytesOf(f).bytes, gzip: acc.gzip + bytesOf(f).gzip }), { files: 0, bytes: 0, gzip: 0 });

/** Splits the build into what the page loads at once and what only the editor pulls in. */
function bundleReport(files: OutputFile[], outDir: string) {
  const byName = new Map(files.map((f) => [f.fileName, f]));
  const initial = new Set<string>();
  const visit = (name: string) => {
    if (initial.has(name)) return;
    initial.add(name);
    const file = byName.get(name);
    for (const dep of file?.imports ?? []) visit(dep);
    for (const css of file?.viteMetadata?.importedCss ?? []) initial.add(css);
    for (const asset of file?.viteMetadata?.importedAssets ?? []) initial.add(asset);
  };
  for (const f of files) if (f.isEntry) visit(f.fileName);
  // The worker bundle (and the small module that starts it): listed as assets, or written beside them.
  const isWorker = (name: string) => /worker/i.test(name);
  const onDisk = readdirSync(join(outDir, "assets")).filter((n) => isWorker(n) && !byName.has(`assets/${n}`));
  const workers: OutputFile[] = [...files.filter((f) => isWorker(f.fileName)), ...onDisk.map((n): OutputFile => ({ type: "asset", fileName: `assets/${n}`, source: readFileSync(join(outDir, "assets", n)) }))];
  const lazy = files.filter((f) => !initial.has(f.fileName) && f.fileName !== "index.html" && !isWorker(f.fileName));
  const kind = (f: OutputFile) => (f.fileName.endsWith(".js") ? "js" : f.fileName.endsWith(".css") ? "css" : "other");
  const all = [...files, ...workers];
  const text = all.filter((f) => /\.(js|css|html)$/.test(f.fileName)).map((f) => (f.type === "chunk" ? f.code! : Buffer.from(f.source as Uint8Array | string).toString("utf8"))).join("\n");
  const cdn = [...text.matchAll(/\b(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|esm\.run)\b/g)].map((m) => m[0]);
  return {
    initial: sum(files.filter((f) => initial.has(f.fileName))),
    lazy: { js: sum(lazy.filter((f) => kind(f) === "js")), css: sum(lazy.filter((f) => kind(f) === "css")), other: sum(lazy.filter((f) => kind(f) === "other")) },
    worker: sum(workers),
    workerFiles: workers.map((w) => w.fileName),
    // CodeMirror's share of the chunks, from the bundler's per-module sizes before minification (null when not reported).
    codemirror: (() => {
      const modules = files.flatMap((f) => Object.entries(f.modules ?? {}));
      if (modules.length === 0) return null;
      return modules.filter(([id]) => /[\\/](?:@codemirror|@lezer|@marijn|style-mod|w3c-keyname|crelt)[\\/+@]/.test(id)).reduce((n, [, m]) => n + (m.renderedLength ?? 0), 0);
    })(),
    // A class only Monaco's own scrollbar code uses: present in a chunk means Monaco is in it.
    monacoInInitial: files.some((f) => initial.has(f.fileName) && f.type === "chunk" && f.code!.includes("monaco-scrollable-element")),
    cdn,
  };
}

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".ttf": "font/ttf", ".woff2": "font/woff2", ".json": "application/json", ".svg": "image/svg+xml" };

/**
 * A static server on loopback. `prefix` serves the build under a sub-path (an intranet reverse
 * proxy, `https://intranet/dbee/`); `csp` sends that Content-Security-Policy with every response.
 */
function serve(dir: string, { prefix = "", csp }: { prefix?: string; csp?: string } = {}): Promise<Server> {
  const server = createServer((req, res) => {
    let path = decodeURIComponent((req.url ?? "/").split("?")[0]!);
    if (prefix) {
      if (!path.startsWith(`${prefix}/`)) {
        res.writeHead(404).end();
        return;
      }
      path = path.slice(prefix.length);
    }
    const file = join(dir, path === "/" ? "index.html" : path);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", ...(csp ? { "content-security-policy": csp } : {}) })
      .end(readFileSync(file));
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
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (v: Params) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: Message) => void>();
  private readonly socket: WebSocket;
  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result ?? {});
      } else for (const l of this.listeners) l(message);
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
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(listener: (m: Message) => void): void {
    this.listeners.add(listener);
  }
  close(): void {
    this.socket.close();
  }
}

async function launch(binary: string, profile: string): Promise<{ child: ChildProcess; url: string }> {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--window-size=1280,900",
    // Linux CI runners restrict the user namespaces Chrome's sandbox needs; the page is our own.
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
  key: (key: string, options?: { modifiers?: number; text?: string }) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  screenshot: (path: string, clip?: { x: number; y: number; width: number; height: number }) => Promise<void>;
  click: (x: number, y: number) => Promise<void>;
  close: () => Promise<void>;
  requests: string[];
  failed: string[];
  errors: string[];
}

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const RUN = isMac ? MOD.meta : MOD.ctrl;
const TAB_FOCUS = isMac ? MOD.ctrl | MOD.shift : MOD.ctrl;

const KEYS: Record<string, { code: string; keyCode: number }> = {
  Tab: { code: "Tab", keyCode: 9 },
  Enter: { code: "Enter", keyCode: 13 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
};

async function openPage(cdp: Cdp): Promise<Page> {
  const { targetId } = (await cdp.send("Target.createTarget", { url: "about:blank" })) as { targetId: string };
  const { sessionId } = (await cdp.send("Target.attachToTarget", { targetId, flatten: true })) as { sessionId: string };
  const send = (method: string, params: Params = {}) => cdp.send(method, params, sessionId);
  const requests: string[] = [];
  const failed: string[] = [];
  const errors: string[] = [];
  let loaded: (() => void) | undefined;
  cdp.on((m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === "Network.requestWillBeSent") requests.push(String((m.params!.request as { url: string }).url));
    if (m.method === "Network.webSocketCreated") requests.push(String(m.params!.url));
    if (m.method === "Network.loadingFailed") failed.push(`${String(m.params!.errorText)} (${String(m.params!.type)})`);
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify((m.params!.exceptionDetails as { exception?: { description?: string }; text?: string }).exception?.description ?? m.params!.exceptionDetails));
    if (m.method === "Page.loadEventFired") loaded?.();
  });
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await send(method);
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  return {
    evaluate,
    async navigate(url) {
      const done = new Promise<void>((resolve) => (loaded = resolve));
      await send("Page.navigate", { url });
      await done;
    },
    async key(key, { modifiers = 0, text } = {}) {
      const known = KEYS[key];
      const letter = /^[a-z]$/i.test(key);
      const code = known?.code ?? (letter ? `Key${key.toUpperCase()}` : key);
      const keyCode = known?.keyCode ?? (letter ? key.toUpperCase().charCodeAt(0) : 0);
      const printable = text ?? (letter && !(modifiers & (MOD.ctrl | MOD.meta | MOD.alt)) ? key : undefined);
      await send("Input.dispatchKeyEvent", { type: printable ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers, ...(printable ? { text: printable, unmodifiedText: printable } : {}) });
      await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
    },
    async insertText(text) {
      await send("Input.insertText", { text });
    },
    async click(x, y) {
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    async screenshot(path, clip) {
      const { data } = (await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })) as { data: string };
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId });
    },
    requests,
    failed,
    errors,
  };
}

/** Waits for `n` animation frames. */
const frames = (n = 3) => `new Promise((r) => { let i = 0; const f = () => (++i >= ${n} ? r(true) : requestAnimationFrame(f)); requestAnimationFrame(f); })`;

/**
 * Whether the page produces animation frames. Monaco renders its lines in frames; headless Chrome
 * on macOS stops producing them at times (it paces frames by the display, which may be asleep).
 */
async function producesFrames(page: Page): Promise<boolean> {
  return page.evaluate<boolean>("new Promise((r) => { requestAnimationFrame(() => r(true)); setTimeout(() => r(false), 2000); })");
}

/**
 * The Content-Security-Policies Byterygon apps serve, with connections narrowed to the page itself
 * (the check has no Ambidex endpoint). Kept in step with apps/dbee/server/src/static_ui.rs and
 * crates/ambidex-tauri/src/lib.rs (`CSP`); the Tauri one is the strictest: no inline styles, no
 * data: images.
 */
export const INTERNAL_CSPS: Readonly<Record<string, { csp: string; knownIssue?: string }>> = {
  "dbee-server": {
    csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  },
  // ambidex_tauri::CSP with `connect-src` narrowed to the page (test/internal-csp.test.ts keeps
  // the two in step). Its `style-src 'unsafe-inline'` exists because Monaco and lib/monaco create
  // <style> elements at run time (TSK-56); scripts stay 'self' only.
  "tauri-desktop": {
    csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  },
};

/**
 * Monaco on an internal network: the same build served from a sub-path under each CSP above, in a
 * fresh page. Monaco must mount with its own stylesheet applied, start its worker, keep every
 * request under the sub-path, and cause no CSP violation.
 */
async function internalNetwork(cdp: Cdp, out: string) {
  const results: Record<string, { violations: string[]; outside: string[]; styled: boolean; worker: boolean; knownIssue?: string }> = {};
  for (const [name, { csp, knownIssue }] of Object.entries(INTERNAL_CSPS)) {
    const prefix = "/intranet/dbee";
    const server = await serve(out, { prefix, csp });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${prefix}`;
      const page = await openPage(cdp);
      await page.navigate(`${base}/`);
      const ready = await waitFor(page, "window.__check && window.__check.readyAt > 0", 30_000);
      check(ready, `internal network (${name}): Monaco did not mount from ${prefix}/ under the CSP`);
      await page.evaluate(frames(4));
      // Monaco's own CSS (injected <style> and its stylesheet) positions the text layer absolutely.
      const styled = await page.evaluate<boolean>(`(() => { const v = document.querySelector("[data-slot=sql-editor] .monaco-editor .view-lines"); return !!v && getComputedStyle(v).position === "absolute"; })()`);
      check(styled, `internal network (${name}): Monaco's styles were not applied`);
      const worker = await page.evaluate<boolean>(`new Promise((resolve) => {
        const w = self.MonacoEnvironment.getWorker("workerMain.js", "editorWorkerService");
        w.addEventListener("error", () => resolve(false));
        setTimeout(() => { w.terminate(); resolve(true); }, 500);
      })`);
      check(worker, `internal network (${name}): the editor worker did not start under worker-src 'self'`);
      const violations = await page.evaluate<string[]>("window.__violations.slice()");
      if (knownIssue && violations.length > 0) {
        process.stderr.write(`warning: internal network (${name}): known issue, ${knownIssue}: ${violations.length} CSP violations, first: ${violations[0]}\n`);
      } else {
        check(violations.length === 0, `internal network (${name}): CSP violations: ${violations.join("; ")}`);
        if (knownIssue) check(false, `internal network (${name}): no CSP violation any more; remove knownIssue from INTERNAL_CSPS so the case is strict again`);
      }
      const outside = page.requests.filter((u) => !u.startsWith(`${base}/`) && !u.startsWith("data:") && !u.startsWith("blob:") && u !== "about:blank");
      check(outside.length === 0, `internal network (${name}): requests outside ${prefix}/: ${outside.join(", ")}`);
      check(page.errors.length === 0, `internal network (${name}): page errors: ${page.errors.join("\n")}`);
      results[name] = { violations, outside, styled, worker, ...(knownIssue ? { knownIssue } : {}) };
      await page.close();
    } finally {
      server.close();
    }
  }
  return results;
}

async function waitFor(page: Page, expression: string, timeout = 10_000): Promise<boolean> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await page.evaluate<boolean>(expression)) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return false;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const round = (n: number) => Math.round(n * 10) / 10;

/** Hex colours equal within one step per channel (rounding in two conversions); alpha ignored. */
const sameColor = (a: string | null, b: string) => {
  if (!a) return false;
  const channels = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [channels(a), channels(b)];
  return x.every((c, i) => Math.abs(c - y[i]!) <= 1);
};

// ---------------------------------------------------------------------------------------------
// The scenarios.

async function firstKeystroke(page: Page, url: string) {
  const runs: { fallback: number; ready: number; firstKeystroke: number; latency: number }[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.navigate(url);
    await page.evaluate("window.__check.bothReady");
    await page.evaluate("window.__check.editor.focus(), window.__check.editor.setPosition({ lineNumber: 1, column: 1 }), true");
    const before = await page.evaluate<number>("performance.now()");
    await page.key("s");
    if (!check(await waitFor(page, "window.__check.changes.length > 0"), "first keystroke: the typed key never reached the editor")) break;
    const t = await page.evaluate<{ fallbackAt: number; readyAt: number; first: number }>("({ fallbackAt: window.__check.fallbackAt, readyAt: window.__check.readyAt, first: window.__check.changes[0].at })");
    runs.push({ fallback: t.fallbackAt, ready: t.readyAt, firstKeystroke: t.first, latency: t.first - before });
  }
  if (runs.length === 0) return null;
  return {
    runs: runs.length,
    fallbackInteractiveMs: round(median(runs.map((r) => r.fallback))),
    monacoReadyMs: round(median(runs.map((r) => r.ready))),
    firstKeystrokeMs: round(median(runs.map((r) => r.firstKeystroke))),
    keystrokeLatencyMs: round(median(runs.map((r) => r.latency))),
  };
}

interface Sample {
  background: string;
  expectedBackground: string;
  keyword: string | null;
  expectedKeyword: string;
  lineNumber: string | null;
  expectedLineNumber: string;
  fontSize: number;
  expectedFontSize: number;
  lineHeight: number;
  paddingTop: number;
  expectedPadding: number;
  inputLabel: string | null;
  inputRole: string | null;
}

async function themes(page: Page) {
  if (!check(await producesFrames(page), "the browser produces no animation frames, so Monaco cannot render (headless Chrome on macOS with the display asleep does this; rerun with the display awake)")) return { checked: [], densities: {}, codeHeights: {} };
  const presets = await page.evaluate<string[]>("window.__check.presets");
  const checked: string[] = [];
  for (const preset of presets) {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(`window.__check.setPreset(${JSON.stringify(preset)}), window.__check.setTheme("${theme}"), ${frames()}`);
      // Editor 0 is in `theme`, editor 1 beside it in the other mode: each must match its own region.
      for (const [index, mode] of [[0, theme], [1, theme === "light" ? "dark" : "light"]] as const) {
        // After a theme change Monaco may briefly show a line as one untokenized span: poll.
        let s = await page.evaluate<Sample>(`window.__sample(${index})`);
        for (let tries = 0; tries < 40 && (s.keyword === null || !sameColor(s.keyword, s.expectedKeyword)); tries += 1) {
          await new Promise((r) => setTimeout(r, 50));
          s = await page.evaluate<Sample>(`window.__sample(${index})`);
        }
        const where = `${preset}/${mode}${index === 1 ? " (second editor, beside the other mode)" : ""}`;
        check(sameColor(s.background, s.expectedBackground), `theme ${where}: editor background ${s.background}, expected editor.bg ${s.expectedBackground}`);
        check(sameColor(s.keyword, s.expectedKeyword), `theme ${where}: keyword colour ${s.keyword}, expected syntax.keyword ${s.expectedKeyword}`);
        if (s.lineNumber) check(sameColor(s.lineNumber, s.expectedLineNumber), `theme ${where}: line numbers ${s.lineNumber}, expected editor.gutter ${s.expectedLineNumber}`);
        check(s.lineNumber !== null || index === 0, `theme ${where}: no line number to compare`);
        checked.push(where);
      }
      // CodeInput: index 1 (the filter) is in `theme`, index 0 beside the second editor in the other.
      for (const [index, mode] of [[1, theme], [0, theme === "light" ? "dark" : "light"]] as const) {
        let c = await page.evaluate<CodeSample>(`window.__sampleCode(${index})`);
        // The frame fades its colours (transition-colors), so wait for the background as well.
        for (let tries = 0; tries < 40 && (c.keyword === null || !sameColor(c.keyword, c.expectedKeyword) || !sameColor(c.background, c.expectedBackground)); tries += 1) {
          await new Promise((r) => setTimeout(r, 50));
          c = await page.evaluate<CodeSample>(`window.__sampleCode(${index})`);
        }
        const where = `${preset}/${mode} CodeInput${index === 0 ? " (beside the other mode)" : ""}`;
        check(sameColor(c.background, c.expectedBackground), `theme ${where}: background ${c.background}, expected color.bg.layer-alt ${c.expectedBackground}`);
        check(sameColor(c.keyword, c.expectedKeyword), `theme ${where}: keyword colour ${c.keyword}, expected syntax.keyword ${c.expectedKeyword}`);
        check(sameColor(c.string, c.expectedString), `theme ${where}: string colour ${c.string}, expected syntax.string ${c.expectedString}`);
        checked.push(where);
      }
    }
  }
  const densities: Record<string, { fontSize: number; lineHeight: number; padding: number }> = {};
  const codeHeights: Record<string, number> = {};
  for (const density of ["comfortable", "compact"] as const) {
    await page.evaluate(`window.__check.setPreset("default"), window.__check.setTheme("light"), window.__check.setDensity("${density}"), ${frames()}`);
    const s = await page.evaluate<Sample>("window.__sample()");
    check(s.fontSize === s.expectedFontSize, `density ${density}: font size ${s.fontSize}, expected text.code.size ${s.expectedFontSize}`);
    check(s.paddingTop === s.expectedPadding, `density ${density}: padding ${s.paddingTop}, expected space.inset.sm ${s.expectedPadding}`);
    densities[density] = { fontSize: s.fontSize, lineHeight: s.lineHeight, padding: s.paddingTop };
    const c = await page.evaluate<CodeSample>("window.__sampleCode(1)");
    check(c.fontSize === c.expectedFontSize, `density ${density}: CodeInput font size ${c.fontSize}, expected text.code.size ${c.expectedFontSize}`);
    check(Math.abs(c.height - c.expectedHeight) < 0.5, `density ${density}: CodeInput height ${c.height}, expected size.control.md ${c.expectedHeight}`);
    check(c.offCentre <= 1, `density ${density}: CodeInput's line is ${c.offCentre.toFixed(1)} px off the frame's centre`);
    codeHeights[density] = c.height;
  }
  check(densities.comfortable!.padding !== densities.compact!.padding, "density: the editor's padding did not change between Comfortable and Compact");
  check(codeHeights.comfortable !== codeHeights.compact, "density: CodeInput's height did not change between Comfortable and Compact");
  await page.evaluate(`window.__check.setDensity("comfortable"), ${frames()}`);
  return { checked, densities, codeHeights };
}

/**
 * TSK-90: a horizontal tab strip never scrolls (no vertical scrollbar from overflow-x), tabs that do
 * not fit go behind the "More tabs" button, ArrowRight moves among the visible tabs only, and a
 * native scroll container takes the thin themed scrollbar of the theme's base layer.
 */
async function tabStrip(page: Page) {
  const s = await page.evaluate<{
    overflowX: string;
    overflowY: string;
    scrollY: number;
    tabs: number;
    hidden: number;
    moreShown: boolean;
    scrollbarWidth: string;
    scrollbarColor: string;
    expectedThumb: string;
  }>(`(() => {
    const strip = document.querySelector("#tab-strip [data-slot=tabs-strip]");
    const list = strip.querySelector("[data-slot=tabs-list]");
    const more = strip.querySelector("[data-slot=dropdown-menu-trigger]");
    const style = getComputedStyle(list);
    const scroller = getComputedStyle(document.getElementById("scroller"));
    const probe = document.createElement("div");
    probe.style.color = "var(--by-color-scrollbar-thumb)";
    document.getElementById("region-4").append(probe);
    const expectedThumb = getComputedStyle(probe).color;
    probe.remove();
    return {
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      scrollY: list.scrollHeight - list.clientHeight,
      tabs: strip.querySelectorAll("[data-slot=tabs-item]").length,
      hidden: strip.querySelectorAll("[data-slot=tabs-item][data-overflow]").length,
      moreShown: more !== null && getComputedStyle(more).display !== "none",
      scrollbarWidth: scroller.scrollbarWidth,
      scrollbarColor: scroller.scrollbarColor,
      expectedThumb,
    };
  })()`);
  check(s.overflowX === "hidden" && s.overflowY === "hidden", `tab strip: overflow ${s.overflowX} / ${s.overflowY}, expected hidden on both axes`);
  check(s.scrollY <= 0, `tab strip: the tablist can scroll ${s.scrollY} px vertically`);
  check(s.hidden > 0 && s.hidden < s.tabs, `tab strip: ${s.hidden} of ${s.tabs} tabs hidden, expected some in a strip too narrow for them`);
  check(s.moreShown, "tab strip: the More tabs button is not shown while tabs are hidden");
  const visible = s.tabs - s.hidden;
  await page.evaluate(`document.querySelector("#tab-strip [role=tab]").focus(), true`);
  const focusedVisible = async () =>
    page.evaluate<boolean>(`(() => { const a = document.activeElement; return a?.getAttribute("role") === "tab" && !a.closest("[data-slot=tabs-item]").hasAttribute("data-overflow") && a.getBoundingClientRect().width > 0; })()`);
  for (let step = 1; step <= visible; step += 1) {
    await page.key("ArrowRight");
    if (!check(await focusedVisible(), `tab strip: ArrowRight ${step} moved focus to a hidden tab or out of the strip`)) break;
  }
  check(await page.evaluate<boolean>(`document.activeElement === document.querySelector("#tab-strip [role=tab]")`), `tab strip: ${visible} ArrowRight presses did not wrap to the first tab`);
  check(s.scrollbarWidth === "thin", `scrollbars: scrollbar-width ${s.scrollbarWidth}, expected thin from the theme's base layer`);
  check(s.scrollbarColor.startsWith(s.expectedThumb), `scrollbars: scrollbar-color ${s.scrollbarColor}, expected color.scrollbar.thumb (${s.expectedThumb}) then transparent`);
  return { tabs: s.tabs, hidden: s.hidden, scrollbarWidth: s.scrollbarWidth, scrollbarColor: s.scrollbarColor };
}

async function keyboard(page: Page) {
  const active = () => page.evaluate<string>("(() => { const a = document.activeElement; return a?.closest('[data-slot=sql-editor]') ? 'editor' : (a?.id || a?.tagName.toLowerCase() || 'none'); })()");
  await page.evaluate(`window.__check.setValue(""), ${frames()}, document.getElementById("before").focus(), true`);
  await page.key("Tab");
  check((await active()) === "editor", `keyboard: Tab from the button before did not reach the editor (focus on ${await active()})`);
  const sample = await page.evaluate<Sample>("window.__sample()");
  check(sample.inputLabel === "Query", `keyboard: the editor's input has aria-label ${JSON.stringify(sample.inputLabel)}, expected "Query"`);
  await page.insertText("select 1;");
  check(await waitFor(page, `window.__check.editor.getValue() === "select 1;"`), "keyboard: typed text did not reach the editor");
  const runsBefore = await page.evaluate<number>("window.__check.runs.length");
  await page.key("Enter", { modifiers: RUN });
  check(await waitFor(page, `window.__check.runs.length > ${runsBefore}`), `keyboard: ${isMac ? "Cmd" : "Ctrl"}+Enter did not call onRun`);
  const run = await page.evaluate<{ text: string; source: string } | null>("window.__check.runs.at(-1)?.run ?? null");
  check(run?.text === "select 1" && run.source === "statement", `keyboard: onRun got ${JSON.stringify(run)}, expected the statement "select 1"`);
  await page.key("Tab");
  check((await active()) === "editor", "keyboard: Tab inside the editor left it (it should indent until Tab focus mode is on)");
  check(await page.evaluate<boolean>(`/^\\s+select 1;$|select 1;\\s+$/.test(window.__check.editor.getValue())`), "keyboard: Tab inside the editor did not indent");
  await page.key("m", { modifiers: TAB_FOCUS });
  await page.key("Tab");
  check((await active()) === "after", `keyboard: with Tab focus mode on (${isMac ? "Ctrl+Shift+M" : "Ctrl+M"}), Tab did not move to the next control (focus on ${await active()})`);
  await page.key("Tab", { modifiers: MOD.shift });
  check((await active()) === "editor", "keyboard: Shift+Tab did not return to the editor");
  await page.key("Tab", { modifiers: MOD.shift });
  check((await active()) === "before", `keyboard: Shift+Tab did not leave the editor backwards (focus on ${await active()})`);
  await page.evaluate("window.__check.editor.focus(), true");
  await page.key("m", { modifiers: TAB_FOCUS });
  return { input: sample.inputRole, label: sample.inputLabel };
}

async function largeDocument(page: Page) {
  const size = await page.evaluate<number>(`(() => {
    const line = "select id, name, created_at from accounts where id = 12345 and status = 'active';\\n";
    window.__big = line.repeat(Math.ceil(1048576 / line.length));
    return window.__big.length;
  })()`);
  const t0 = await page.evaluate<number>("performance.now()");
  await page.evaluate("window.__check.setValue(window.__big), true");
  const loaded = await waitFor(page, "window.__check.editor.getModel().getValueLength() === window.__big.length", 30_000);
  check(loaded, "1 MB: the document did not load into the editor");
  await page.evaluate(frames(2));
  const loadMs = (await page.evaluate<number>("performance.now()")) - t0;
  await page.evaluate("(() => { const e = window.__check.editor; const m = e.getModel(); const end = m.getPositionAt(m.getValueLength()); e.focus(); e.setPosition(end); e.revealPosition(end); return true; })()");
  await page.evaluate(frames(2));
  const changes = await page.evaluate<number>("window.__check.changes.length");
  const before = await page.evaluate<number>("performance.now()");
  await page.key("x");
  check(await waitFor(page, `window.__check.changes.length > ${changes}`), "1 MB: a keystroke at the end did not reach the editor");
  const keystrokeMs = (await page.evaluate<number>("window.__check.changes.at(-1).at")) - before;
  await page.key("Backspace");
  check(await waitFor(page, "window.__check.editor.getModel().getValueLength() === window.__big.length"), "1 MB: Backspace did not remove the typed key");
  // The cursor on the last statement's line, explicitly, so the run does not depend on key timing.
  await page.evaluate("(() => { const e = window.__check.editor; const m = e.getModel(); const line = m.getLineCount() - 1; e.setPosition({ lineNumber: line, column: m.getLineMaxColumn(line) }); return true; })()");
  const runs = await page.evaluate<number>("window.__check.runs.length");
  const beforeRun = await page.evaluate<number>("performance.now()");
  await page.key("Enter", { modifiers: RUN });
  check(await waitFor(page, `window.__check.runs.length > ${runs}`), "1 MB: Ctrl+Enter did not run the last statement");
  const run = await page.evaluate<{ at: number; text: string; source: string; start: number; end: number; length: number; cursor: number; tail: string }>(`(() => {
    const r = window.__check.runs.at(-1); const e = window.__check.editor; const m = e.getModel();
    return { at: r.at, text: r.run.text, source: r.run.source, start: r.run.start, end: r.run.end, length: m.getValueLength(), cursor: m.getOffsetAt(e.getPosition()), tail: m.getValue().slice(-40) };
  })()`);
  const runMs = run.at - beforeRun;
  check(run.text.startsWith("select id, name") && run.text.length < 120, `1 MB: onRun got ${JSON.stringify({ ...run, at: undefined })}, expected the last statement`);
  const limits = { loadMs: 5000, keystrokeMs: 200, runMs: 500 };
  check(loadMs < limits.loadMs, `1 MB: loading took ${Math.round(loadMs)} ms (limit ${limits.loadMs})`);
  check(keystrokeMs < limits.keystrokeMs, `1 MB: a keystroke took ${Math.round(keystrokeMs)} ms (limit ${limits.keystrokeMs})`);
  check(runMs < limits.runMs, `1 MB: finding the statement to run took ${Math.round(runMs)} ms (limit ${limits.runMs})`);
  await page.evaluate(`window.__check.setValue("select 1;"), ${frames(1)}`);
  return { bytes: size, loadMs: round(loadMs), keystrokeMs: round(keystrokeMs), runMs: round(runMs), limits };
}

interface CodeSample {
  background: string;
  expectedBackground: string;
  keyword: string | null;
  expectedKeyword: string;
  string: string | null;
  expectedString: string;
  fontSize: number;
  expectedFontSize: number;
  height: number;
  expectedHeight: number;
  offCentre: number;
  label: string | null;
}

async function codeKeyboard(page: Page) {
  const where = () => page.evaluate<string>("(() => { const a = document.activeElement; if (a?.closest('[data-slot=code-input]')) return a.classList.contains('cm-content') ? 'filter' : 'code-input:' + a.tagName.toLowerCase(); return a?.id || a?.tagName.toLowerCase() || 'none'; })()");
  await page.evaluate(`document.getElementById("before-code").scrollIntoView(), document.getElementById("before-code").focus(), ${frames(1)}`);
  await page.key("Tab");
  check((await where()) === "filter", `CodeInput keyboard: Tab did not reach the filter's text area (focus on ${await where()})`);
  const sample = await page.evaluate<CodeSample>("window.__sampleCode(1)");
  check(sample.label === "Filter rows", `CodeInput: the text area is named ${JSON.stringify(sample.label)}, expected the FieldLabel "Filter rows"`);
  await page.evaluate("(() => { const v = window.__check.codeView(1); v.dispatch({ selection: { anchor: v.state.doc.length } }); return true; })()");
  await page.insertText(" or id = 1");
  const text = await page.evaluate<string>("window.__check.codeView(1).state.doc.toString()");
  check(text.endsWith(" or id = 1"), `CodeInput keyboard: typed text did not arrive (${JSON.stringify(text)})`);
  await page.key("Enter");
  check(await waitFor(page, "window.__check.submits.length > 0"), "CodeInput keyboard: Enter did not call onSubmit");
  check((await page.evaluate<string>("window.__check.submits.at(-1)")) === text, "CodeInput keyboard: onSubmit did not get the text");
  check((await page.evaluate<number>("window.__check.codeView(1).state.doc.lines")) === 1, "CodeInput keyboard: Enter inserted a line break in a one-line field");
  await page.key("Tab");
  check((await where()) === "after-code", `CodeInput keyboard: Tab did not leave the filter (focus on ${await where()})`);
  await page.key("Tab", { modifiers: MOD.shift });
  check((await where()) === "filter", `CodeInput keyboard: Shift+Tab did not return to the filter (focus on ${await where()})`);
  await page.evaluate("document.getElementById('after-code').focus(), true");
  const label = await page.evaluate<{ x: number; y: number }>("(() => { const r = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Filter rows').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()");
  await page.click(label.x, label.y);
  check(await waitFor(page, "document.activeElement?.classList.contains('cm-content') && !!document.activeElement.closest('[data-slot=code-input]')", 2000), `CodeInput: a FieldLabel click did not focus the text area (focus on ${await where()})`);
  return { label: sample.label };
}

async function codeLargeDocument(page: Page) {
  const size = await page.evaluate<number>(`(() => {
    const rows = [];
    for (let i = 0; JSON.stringify(rows).length < 1048576; i += 1) rows.push({ id: i, email: "user" + i + "@example.com", tags: ["a", "b"], active: i % 2 === 0, score: i * 1.5 });
    window.__json = JSON.stringify(rows);
    window.__pretty = JSON.stringify(rows, null, 2);
    return window.__json.length;
  })()`);
  const t0 = await page.evaluate<number>("performance.now()");
  await page.evaluate("window.__check.setViewer(window.__json), true");
  const loaded = await waitFor(page, "window.__check.codeView(2).state.doc.length === window.__pretty.length", 30_000);
  check(loaded, "CodeInput 1 MB: the pretty viewer did not show the value");
  await page.evaluate(frames(2));
  const loadMs = (await page.evaluate<number>("performance.now()")) - t0;
  const t1 = await page.evaluate<number>("performance.now()");
  await page.evaluate("(() => { const v = window.__check.codeView(2); v.focus(); v.dispatch({ selection: { anchor: v.state.doc.length }, scrollIntoView: true }); return true; })()");
  const atEnd = await waitFor(page, "[...document.querySelectorAll('[data-slot=code-input]')[2].querySelectorAll('.cm-line')].some((l) => l.textContent === ']')", 5000);
  const jumpMs = (await page.evaluate<number>("performance.now()")) - t1;
  check(atEnd, "CodeInput 1 MB: the end of the document was not rendered after jumping there");
  const rendered = await page.evaluate<number>("document.querySelectorAll('[data-slot=code-input]')[2].querySelectorAll('.cm-line').length");
  const lines = await page.evaluate<number>("window.__check.codeView(2).state.doc.lines");
  check(rendered < 2000, `CodeInput 1 MB: ${rendered} of ${lines} lines are in the DOM; only the visible ones should be`);
  const limits = { loadMs: 5000, jumpMs: 1000 };
  check(loadMs < limits.loadMs, `CodeInput 1 MB: showing the value took ${Math.round(loadMs)} ms (limit ${limits.loadMs})`);
  check(jumpMs < limits.jumpMs, `CodeInput 1 MB: jumping to the end took ${Math.round(jumpMs)} ms (limit ${limits.jumpMs})`);
  await page.evaluate("window.__check.setViewer('{}'), true");
  return { bytes: size, lines, renderedLines: rendered, loadMs: round(loadMs), jumpMs: round(jumpMs), limits };
}

/** The bundled editor worker starts from the app's own files. */
async function worker(page: Page, base: string) {
  const ok = await page.evaluate<boolean>(`new Promise((resolve) => {
    const w = self.MonacoEnvironment.getWorker("workerMain.js", "editorWorkerService");
    w.addEventListener("error", () => resolve(false));
    setTimeout(() => { w.terminate(); resolve(true); }, 500);
  })`);
  check(ok, "worker: the editor worker failed to start");
  check(page.requests.some((u) => u.startsWith(`${base}/assets/`) && /worker/i.test(u)), "worker: no request for the bundled worker file was seen");
  return ok;
}

/** CodeEditor (TSK-80): the JSON language service runs in its own bundled worker and validates against the schema. */
async function jsonSchema(page: Page, base: string) {
  if (!check(await waitFor(page, "window.__check.jsonReady"), "CodeEditor: the JSON editor did not mount")) return {};
  await page.evaluate(`window.__check.setJson('{ "id": 7, "status": "LOST", "extra": true }')`);
  const flagged = await waitFor(page, "(window.__check.jsonDiagnostics ?? []).length >= 3", 20_000);
  const found = await page.evaluate<{ message: string; severity: string }[] | null>("window.__check.jsonDiagnostics");
  check(flagged, `CodeEditor: the schema violations were not reported (got ${JSON.stringify(found)})`);
  await page.evaluate(`window.__check.setJson('{ "id": "o-2" }')`);
  const cleared = await waitFor(page, "(window.__check.jsonDiagnostics ?? [1]).length === 0", 20_000);
  check(cleared, "CodeEditor: valid JSON still had problems");
  check(page.requests.some((u) => u.startsWith(`${base}/assets/`) && /json/i.test(u) && /worker/i.test(u)), "CodeEditor: no request for the bundled JSON worker was seen");
  return { violations: found?.length ?? 0, cleared };
}

/** Monaco's own default colours (vs and vs-dark) that the tokens replace (TSK-94): JSON keys and values, brackets, the suggest list's selection. */
export const MONACO_DEFAULT_COLORS = ["#a31515", "#0451a5", "#0060c0", "#04395e", "#0431fa", "#319331", "#7b3814", "#9cdcfe", "#ce9178", "#ffd700", "#da70d6", "#179fff", "#007acc", "#0090f1"];

/**
 * TSK-94: in Light and Dark, the suggest widget of a one-line field paints over the sticky header
 * of the table under it (elementFromPoint on each row returns the widget), it looks like the
 * mockup's flyout (fill, selected row, matched characters, radius from the tokens), JSON
 * completion names a property's type and "required", a field with `rows` is sized by its lines
 * with no scrollbar, and no colour computed anywhere in an editor or its widgets is one of
 * Monaco's defaults.
 */
async function widgets(page: Page) {
  if (!check(await waitFor(page, "Boolean(window.__check.queryEditor && window.__check.fieldEditor)", 30_000), "widgets: the TSK-94 editors did not mount")) return {};
  const result: Record<string, unknown> = {};
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(`window.__check.setPreset("default"), window.__check.setTheme("${theme}"), ${frames()}`);
    // The region at the top of the viewport, so the list opens below the field, over the table.
    await page.evaluate(`(document.getElementById("region-5").scrollIntoView({ block: "start" }), true)`);
    await page.evaluate(`(() => { const e = window.__check.queryEditor; e.focus(); e.setPosition({ lineNumber: 1, column: 3 }); e.trigger("check", "editor.action.triggerSuggest", {}); return true; })()`);
    const open = await waitFor(page, `document.querySelectorAll("[data-slot=code-editor-overflow] .suggest-widget.visible .monaco-list-row").length >= 4`, 10_000);
    if (!check(open, `widgets ${theme}: the suggest widget did not open`)) continue;
    await page.evaluate(frames());
    const sampled = await page.evaluate<{ rows: number; onTop: number; overHeader: boolean; zIndex: string; background: string; selected: string; highlight: string; radius: string; noteEdges: number; expected: { background: string; selected: string; highlight: string } }>("window.__sampleWidgets()");
    check(sampled.noteEdges === 1, `widgets ${theme}: the items' notes end at ${sampled.noteEdges} different right edges; they should be right-aligned`);
    check(sampled.overHeader, `widgets ${theme}: the suggest widget does not overlap the table's sticky header, so the check proves nothing (move the table)`);
    check(sampled.rows > 0 && sampled.onTop === sampled.rows, `widgets ${theme}: ${sampled.rows - sampled.onTop} of ${sampled.rows} suggest rows are covered (elementFromPoint is not the widget); z-index ${sampled.zIndex}`);
    check(sameColor(sampled.background, sampled.expected.background), `widgets ${theme}: suggest background ${sampled.background}, expected elevation.flyout.bg ${sampled.expected.background}`);
    check(sameColor(sampled.selected, sampled.expected.selected), `widgets ${theme}: selected row ${sampled.selected}, expected editor.selection ${sampled.expected.selected}`);
    check(sameColor(sampled.highlight, sampled.expected.highlight), `widgets ${theme}: matched characters ${sampled.highlight}, expected color.fg.link ${sampled.expected.highlight}`);
    const defaults = await page.evaluate<string[]>(`window.__monacoDefaults(${JSON.stringify(MONACO_DEFAULT_COLORS)})`);
    check(defaults.length === 0, `widgets ${theme}: Monaco default colours computed: ${defaults.slice(0, 8).join("; ")}`);
    await page.evaluate(`(window.__check.queryEditor.trigger("check", "hideSuggestWidget", {}), true)`);

    // JSON completion: the property's type and "required" from the schema.
    // (The field starts valid: under the desktop's CSP, without img-src data:, squiggles are blocked.)
    await page.evaluate(`(() => { const e = window.__check.fieldEditor; e.setValue('{\\n  "messages": [],\\n  ""\\n}'); e.focus(); e.setPosition({ lineNumber: 3, column: 4 }); e.trigger("check", "editor.action.triggerSuggest", {}); return true; })()`);
    const json = await waitFor(page, `[...document.querySelectorAll("[data-slot=code-editor-overflow] .suggest-widget.visible .monaco-list-row")].some((r) => r.textContent.includes("customer_id") && r.textContent.includes("string · required"))`, 15_000);
    const rowsText = await page.evaluate<string[]>(`[...document.querySelectorAll("[data-slot=code-editor-overflow] .suggest-widget.visible .monaco-list-row")].map((r) => r.textContent)`);
    check(json, `widgets ${theme}: JSON completion does not show "string · required" for customer_id (rows: ${JSON.stringify(rowsText)})`);
    const jsonDefaults = await page.evaluate<string[]>(`window.__monacoDefaults(${JSON.stringify(MONACO_DEFAULT_COLORS)})`);
    check(jsonDefaults.length === 0, `widgets ${theme}: Monaco default colours computed with the JSON suggestions open: ${jsonDefaults.slice(0, 8).join("; ")}`);
    await page.evaluate(`(window.__check.fieldEditor.trigger("check", "hideSuggestWidget", {}), window.__check.fieldEditor.setValue('{\\n  "customer_id": "c-1",\\n  "messages": [{ "role": "human", "n": 1, "ok": true, "x": null }]\\n}'), true)`);
    result[theme] = { rows: sampled.rows, onTop: sampled.onTop, zIndex: sampled.zIndex, jsonRows: rowsText.length };
  }
  // A field with rows=7 and four lines: seven lines tall, no vertical scrollbar, a narrow gutter.
  const field = await page.evaluate<{ height: number; lineHeight: number; lines: number; scrollbar: boolean; gutter: number }>(`(() => {
    const e = window.__check.fieldEditor; const o = window.__check.monaco.editor.EditorOption;
    const root = e.getContainerDomNode().closest("[data-slot=code-editor]");
    const bar = root.querySelector(".scrollbar.vertical");
    return { height: e.getLayoutInfo().height, lineHeight: e.getOption(o.lineHeight), lines: 7, scrollbar: Boolean(bar && bar.offsetWidth > 0 && getComputedStyle(bar).visibility !== "hidden" && bar.querySelector(".slider")), gutter: e.getLayoutInfo().contentLeft };
  })()`);
  const pad = 2 * (await page.evaluate<number>(`Math.round(parseFloat(getComputedStyle(document.querySelector("#region-5")).getPropertyValue("--by-space-inset-sm")))`));
  check(Math.abs(field.height - (field.lines * field.lineHeight + pad)) <= 2, `widgets: a rows=7 field is ${field.height} px tall, expected 7 lines of ${field.lineHeight} px plus ${pad} px padding`);
  check(!field.scrollbar, "widgets: a field whose text fits shows a vertical scrollbar");
  result.field = field;
  return result;
}

const verbose = process.argv.includes("--verbose");
const step = (name: string) => {
  if (verbose) process.stderr.write(`browser-check: ${name}\n`);
};

/** Rejects after `ms`, naming the step, so a stuck browser fails the check instead of hanging CI. */
const within = <T>(ms: number, name: string, work: Promise<T>): Promise<T> =>
  Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${name}: timed out after ${ms / 1000} s`)), ms).unref())]);

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const valueOf = (flag: string) => (argv.indexOf(flag) >= 0 ? (argv[argv.indexOf(flag) + 1] ?? "") : undefined);
  const reportPath = valueOf("--report");
  const screenshotPath = valueOf("--screenshot");
  const values = new Set([reportPath, screenshotPath].filter((v) => v !== undefined));
  const unknown = argv.filter((a) => !["--json", "--report", "--screenshot", "--verbose"].includes(a) && !values.has(a));
  const print = (doc: Record<string, unknown>, text: string) => process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: "browser-check", ...doc })}\n` : `${text}\n`);
  if (unknown.length > 0 || reportPath === "" || screenshotPath === "") {
    print({ ok: false, exitCode: 2, error: { code: "usage", message: unknown[0] ? `unknown argument ${unknown[0]}` : "--report and --screenshot take a file" } }, "usage: node scripts/browser-check.ts [--json] [--verbose] [--report <file>] [--screenshot <file>]");
    return 2;
  }
  const binary = findBrowser();
  const required = process.env.BYTERYGON_REQUIRE_BROWSER === "1";
  if (!binary) {
    const message = "no Chromium-family browser found (set BYTERYGON_BROWSER to its executable)";
    print({ ok: !required, exitCode: required ? 1 : 0, skipped: true, reason: message }, `${required ? "error" : "skipped"}: ${message}`);
    return required ? 1 : 0;
  }
  const work = mkdtempSync(join(tmpdir(), "byterygon-ui-browser-"));
  let server: Server | undefined;
  let browser: { child: ChildProcess; url: string } | undefined;
  let cdp: Cdp | undefined;
  const report: Record<string, unknown> = { browser: binary, platform: `${process.platform}-${process.arch}` };
  try {
    const out = join(work, "dist");
    step("build");
    const { files } = await within(180_000, "build", buildPage(out));
    const bundle = bundleReport(files, out);
    report.bundle = bundle;
    check(!bundle.monacoInInitial, "bundle: Monaco is in the page's initial chunks; it must load on demand");
    check(bundle.worker.files > 0, "bundle: no editor worker file was emitted");
    check(bundle.cdn.length === 0, `bundle: names a CDN: ${bundle.cdn.join(", ")}`);

    server = await serve(out);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    step(`launch ${binary}`);
    browser = await launch(binary, join(work, "profile"));
    cdp = await within(30_000, "connect", Cdp.connect(browser.url));
    const version = (await within(30_000, "version", cdp.send("Browser.getVersion"))) as { product: string };
    report.browserVersion = version.product;
    const page = await within(30_000, "open page", openPage(cdp));

    step("first keystroke");
    report.firstKeystroke = await within(90_000, "first keystroke", firstKeystroke(page, `${base}/`));
    step("worker");
    report.worker = await within(30_000, "worker", worker(page, base));
    step("themes");
    report.themes = await within(90_000, "themes", themes(page));
    step("keyboard");
    report.keyboard = await within(60_000, "keyboard", keyboard(page));
    step("1 MB document");
    report.largeDocument = await within(90_000, "1 MB document", largeDocument(page));
    step("CodeInput keyboard");
    report.codeKeyboard = await within(60_000, "CodeInput keyboard", codeKeyboard(page));
    step("CodeInput 1 MB");
    report.codeLargeDocument = await within(90_000, "CodeInput 1 MB", codeLargeDocument(page));
    step("CodeEditor JSON Schema");
    report.jsonSchema = await within(60_000, "CodeEditor JSON Schema", jsonSchema(page, base));
    step("Monaco widgets on the tokens (TSK-94)");
    report.widgets = await within(90_000, "Monaco widgets", widgets(page));
    step("tab strip and scrollbars");
    report.tabStrip = await within(30_000, "tab strip", tabStrip(page));
    step("internal network: sub-path and DBee CSPs");
    report.internalNetwork = await within(120_000, "internal network", internalNetwork(cdp, out));
    if (screenshotPath) {
      await page.evaluate(`window.__check.setPreset("default"), window.__check.setTheme("light"), window.__check.setValue("select id, email from users where id = 1;\\nselect count(*) from orders;\\n"), ${frames()}`);
      await page.screenshot(screenshotPath);
      // TSK-94: the query field's suggestions over the table and the JSON field's, Light and Dark.
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate(`window.__check.setTheme("${theme}"), document.getElementById("region-5").scrollIntoView({ block: "start" }), ${frames()}`);
        for (const [name, editor, line, column, text] of [
          ["query", "queryEditor", 1, 3, null],
          ["json", "fieldEditor", 3, 4, '{\\n  "messages": [],\\n  ""\\n}'],
        ] as const) {
          await page.evaluate(`(() => { const e = window.__check.${editor}; ${text ? `e.setValue('${text}');` : ""} e.focus(); e.setPosition({ lineNumber: ${line}, column: ${column} }); e.trigger("check", "editor.action.triggerSuggest", {}); return true; })()`);
          await waitFor(page, `document.querySelectorAll("[data-slot=code-editor-overflow] .suggest-widget.visible .monaco-list-row").length >= 3`, 10_000);
          await page.evaluate(frames());
          await new Promise((r) => setTimeout(r, 300));
          const box = await page.evaluate<{ x: number; y: number; width: number; height: number }>(`(() => { const r = document.getElementById("region-5").getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`);
          await page.screenshot(screenshotPath.replace(/(\.png)?$/, `-${name}-${theme}.png`), box);
          await page.evaluate(`(window.__check.${editor}.trigger("check", "hideSuggestWidget", {}), true)`);
        }
      }
    }

    const outside = page.requests.filter((u) => !u.startsWith(`${base}/`) && !u.startsWith("data:") && !u.startsWith("blob:") && u !== "about:blank");
    check(outside.length === 0, `network: requests outside the loopback server: ${outside.join(", ")}`);
    check(page.failed.length === 0, `network: failed requests: ${page.failed.join(", ")}`);
    check(page.errors.length === 0, `page errors: ${page.errors.join("\n")}`);
    report.network = { requests: page.requests.length, outside };
  } catch (error) {
    failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
  } finally {
    cdp?.close();
    if (browser && browser.child.exitCode === null) {
      const exited = new Promise((resolve) => browser!.child.once("exit", resolve));
      browser.child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    server?.close();
    // The browser may still be flushing its profile for a moment after it exits.
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  report.failures = failures;
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const ok = failures.length === 0;
  const kb = (s: Size | undefined) => (s ? `${(s.bytes / 1024).toFixed(0)} kB (${(s.gzip / 1024).toFixed(0)} kB gzip)` : "?");
  const b = report.bundle as ReturnType<typeof bundleReport> | undefined;
  const t = report.firstKeystroke as Awaited<ReturnType<typeof firstKeystroke>> | undefined;
  const big = report.largeDocument as Awaited<ReturnType<typeof largeDocument>> | undefined;
  const codeBig = report.codeLargeDocument as Awaited<ReturnType<typeof codeLargeDocument>> | undefined;
  const lines = [
    `browser: ${String(report.browserVersion ?? binary)}`,
    b ? `bundle: page ${kb(b.initial)}; on demand: JS ${kb(b.lazy.js)}, CSS ${kb(b.lazy.css)}, fonts ${kb(b.lazy.other)}; worker ${kb(b.worker)}` : "",
    t ? `first keystroke: fallback textarea ready at ${t.fallbackInteractiveMs} ms, Monaco ready at ${t.monacoReadyMs} ms, first key in Monaco at ${t.firstKeystrokeMs} ms (latency ${t.keystrokeLatencyMs} ms), median of ${t.runs} cold loads` : "",
    big ? `1 MB document: load ${big.loadMs} ms, keystroke ${big.keystrokeMs} ms, run ${big.runMs} ms` : "",
    codeBig ? `CodeInput 1 MB JSON (pretty viewer): ${codeBig.lines} lines shown in ${codeBig.loadMs} ms, end reached in ${codeBig.jumpMs} ms, ${codeBig.renderedLines} lines in the DOM` : "",
    b?.codemirror ? `CodeInput: CodeMirror and its languages are ${(b.codemirror / 1024).toFixed(0)} kB of module code before minification, in the page's own chunks (not lazy)` : "",
    ok ? "browser check passed." : failures.map((f) => `error: ${f}`).join("\n"),
  ].filter(Boolean);
  print({ ok, exitCode: ok ? 0 : 1, ...report }, lines.join("\n"));
  return ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await main(process.argv.slice(2));
