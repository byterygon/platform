#!/usr/bin/env node
// The Theme Studio in a real browser (TSK-48). Builds dist/ with the package's Vite config, then
// drives Chromium over the DevTools protocol (Node's own WebSocket; no Playwright or Puppeteer):
//
//   - from a folder (file://) and from a loopback static server, the Studio renders with no
//     script error, and every request it makes is to its own files (file:, or the loopback server)
//     or a data:/blob: URL: nothing else, ever;
//   - for every built-in preset, opened from its URL hash, the page's token variables are the
//     preset's, and every export, clicked through the Export dialog and saved by the browser's own
//     download, is byte for byte what `by-tokens export <format> --theme <name>.theme.json` prints;
//   - a seed edit by keyboard changes the page at once, lands in the URL hash, and survives a reload
//     from browser storage; the Light/Dark switch changes the page;
//   - Monaco (the SqlEditor in the preview) starts, with its worker, from file://.
//
// It reports the bundle size and the time until the Studio is interactive.
//
//   node scripts/browser-check.ts [--json] [--presets <a,b>] [--screenshot <dir>]
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge (the same search as
// @byterygon/ui's browser check). Without one the check is skipped (exit 0) unless
// BYTERYGON_REQUIRE_BROWSER=1 (CI). Exit codes: 0 ok or skipped, 1 a check failed, 2 bad command
// line. CI runs it in a network namespace with only loopback.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { EXPORT_FORMATS } from "@byterygon/design-tokens/build";
import { encodeState } from "@byterygon/design-tokens";
import { findBrowser } from "../../ui/scripts/browser-check.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist");
const TOKENS = join(ROOT, "..", "design-tokens");

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};

// ---------------------------------------------------------------------------------------------
// DevTools protocol

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
      } else for (const listener of this.listeners) listener(message);
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
  on(listener: (m: Message) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
    "--window-size=1440,1000",
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
  key: (key: string, code: string, keyCode: number) => Promise<void>;
  /** A real mouse click (pointer events included) at page coordinates. */
  click: (x: number, y: number) => Promise<void>;
  screenshot: (path: string) => Promise<void>;
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
    if (m.method === "Network.requestWillBeSent") requests.push(String((m.params!["request"] as { url: string }).url));
    if (m.method === "Network.webSocketCreated") requests.push(String(m.params!["url"]));
    if (m.method === "Runtime.exceptionThrown") errors.push(JSON.stringify((m.params!["exceptionDetails"] as { exception?: { description?: string } }).exception?.description ?? m.params!["exceptionDetails"]));
    if (m.method === "Runtime.consoleAPICalled" && m.params!["type"] === "error") errors.push(`console.error: ${JSON.stringify((m.params!["args"] as { value?: unknown; description?: string }[]).map((a) => a.value ?? a.description))}`);
    if (m.method === "Log.entryAdded") {
      const entry = m.params!["entry"] as { level: string; text: string; url?: string };
      if (entry.level === "error") errors.push(`log: ${entry.text} ${entry.url ?? ""}`);
    }
    if (m.method === "Page.loadEventFired") loaded?.();
  });
  for (const method of ["Page.enable", "Runtime.enable", "Network.enable", "Log.enable"]) await send(method);
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
    if (result.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  };
  return {
    evaluate,
    async navigate(url) {
      // Through about:blank, so a URL that differs only in its hash is a fresh load too (a
      // same-document navigation fires no load event) and the Studio reads its state from scratch.
      for (const target of ["about:blank", url]) {
        const done = new Promise<void>((resolve) => (loaded = resolve));
        await send("Page.navigate", { url: target });
        await Promise.race([done, sleep(30_000).then(() => Promise.reject(new Error(`loading ${target.slice(0, 80)} timed out`)))]);
      }
    },
    async key(key, code, keyCode) {
      for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    },
    async click(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    },
    async screenshot(path) {
      const { data } = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
      writeFileSync(path, Buffer.from(data, "base64"));
    },
    requests,
    errors,
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(page: Page, expression: string, what: string, timeout = 20_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await page.evaluate<T>(expression);
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// In-page helpers: find a button by its text and click it (React and Base UI handle the event).
const CLICK = (selector: string, text: string) =>
  `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.trim() === ${JSON.stringify(text)}); if (!el) return false; el.click(); return true; })()`;
const READY = `document.querySelector('[role="status"]') !== null && document.documentElement.dataset.theme !== undefined`;
const VAR = (name: string) => `getComputedStyle(document.documentElement).getPropertyValue(${JSON.stringify(name)}).trim()`;
const EXPORT_DIALOG = `[...document.querySelectorAll('[role="dialog"]')].find((d) => d.textContent.includes("Copy or download the theme"))`;

// ---------------------------------------------------------------------------------------------
// The CLI side of the comparison: by-tokens itself, in this process.

type Run = (argv: string[], io: { stdout: (t: string) => void; stderr: (t: string) => void; cwd: string }) => Promise<number>;
async function cliExport(run: Run, cwd: string, file: string, format: string): Promise<string> {
  let out = "";
  let err = "";
  const code = await run(["export", format, "--theme", file], { stdout: (t) => (out += t), stderr: (t) => (err += t), cwd });
  if (code !== 0) throw new Error(`by-tokens export ${format} failed: ${err}`);
  return out;
}

// ---------------------------------------------------------------------------------------------

const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

function serve(dir: string): Promise<Server> {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname);
    const file = join(dir, path === "/" ? "index.html" : path);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function build(): Promise<void> {
  const vite = await import("vite");
  await vite.build({ root: ROOT, configFile: join(ROOT, "vite.config.ts"), logLevel: "error" });
}

function bundle() {
  return readdirSync(DIST).map((name) => {
    const data = readFileSync(join(DIST, name));
    return { name, bytes: data.length, gzip: gzipSync(data, { level: 9 }).length };
  });
}

async function main(argv: string[]): Promise<number> {
  const json = argv.includes("--json");
  const print = (doc: Record<string, unknown>, text: string) => process.stdout.write(json ? `${JSON.stringify({ schemaVersion: 1, command: "browser-check", ...doc })}\n` : `${text}\n`);
  const presetsFlag = argv.indexOf("--presets");
  const screenshotFlag = argv.indexOf("--screenshot");
  const unknown = argv.filter((arg, i) => !["--json", "--presets", "--screenshot"].includes(arg) && i !== presetsFlag + 1 && i !== screenshotFlag + 1);
  if (unknown.length > 0) {
    print({ ok: false, exitCode: 2, error: { code: "usage", message: `unknown argument ${unknown[0]}` } }, `error: unknown argument ${unknown[0]}\nusage: node scripts/browser-check.ts [--json] [--presets a,b] [--screenshot <dir>]`);
    return 2;
  }
  const binary = findBrowser();
  if (!binary) {
    const message = "no Chromium-family browser found (set BYTERYGON_BROWSER to its executable)";
    if (process.env["BYTERYGON_REQUIRE_BROWSER"] === "1") {
      print({ ok: false, exitCode: 1, failures: [message] }, `error: ${message}`);
      return 1;
    }
    print({ ok: true, exitCode: 0, skipped: message }, `skipped: ${message}`);
    return 0;
  }

  const allPresets = readdirSync(join(TOKENS, "themes")).filter((f) => f.endsWith(".theme.json")).map((f) => f.slice(0, -".theme.json".length)).sort();
  const presets = presetsFlag === -1 ? allPresets : argv[presetsFlag + 1]!.split(",");
  const shots = screenshotFlag === -1 ? undefined : argv[screenshotFlag + 1]!;
  if (shots) mkdirSync(shots, { recursive: true });

  const work = mkdtempSync(join(tmpdir(), "theme-studio-browser-"));
  const downloads = join(work, "downloads");
  const themes = join(work, "themes");
  mkdirSync(downloads);
  mkdirSync(themes);
  const report: Record<string, unknown> = { presets, formats: EXPORT_FORMATS.map((f) => f.format) };
  let browser: { child: ChildProcess; url: string } | undefined;
  let server: Server | undefined;
  let cdp: Cdp | undefined;
  try {
    await build();
    report["bundle"] = bundle();
    const { run } = (await import(pathToFileURL(join(TOKENS, "dist", "cli", "main.js")).href)) as { run: Run };

    browser = await launch(binary, join(work, "profile"));
    cdp = await Cdp.connect(browser.url);
    report["browserVersion"] = ((await cdp.send("Browser.getVersion")) as { product: string }).product;
    const finished = new Map<string, string>();
    cdp.on((m) => {
      if (m.method === "Browser.downloadWillBegin") finished.set(String(m.params!["guid"]), "");
      if (m.method === "Browser.downloadProgress" && m.params!["state"] === "completed") finished.set(String(m.params!["guid"]), "done");
    });
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
    const page = await openPage(cdp);
    const studio = pathToFileURL(join(DIST, "index.html")).href;

    // 1. A fresh profile from file://: the default theme, interactive.
    const start = Date.now();
    await page.navigate(studio);
    await until(page, READY, "the Studio to render");
    report["interactiveMs"] = Date.now() - start;
    // A new theme takes the engine defaults: the default preset's seeds (Aurora, radius 4).
    check((await page.evaluate<string>(VAR("--by-radius-md"))) === "4px", "file://: the engine default radius.md is 4px");
    await until(page, `document.querySelector('[data-slot="sql-editor"] .monaco-editor') !== null`, "Monaco to start from file://", 30_000);
    if (shots) await page.screenshot(join(shots, "default-file.png"));

    // 2. A seed edit with the mouse (the radius field's Increase button), the hash, and a reload
    //    from storage.
    const [x, y] = await page.evaluate<[number, number]>(
      `(() => { const input = document.querySelector('input[aria-label="Radius (px)"]'); const button = input.closest('[data-slot="number-input"]').querySelector('[data-slot="number-input-increment"]'); button.scrollIntoView({ block: "center" }); const r = button.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
    );
    const before = await page.evaluate<string>(`location.hash`);
    for (let i = 0; i < 4; i += 1) await page.click(x, y);
    await until(page, `${VAR("--by-radius-md")} === "8px"`, "the radius edit to apply");
    // The Studio saves 150 ms after the last change: wait for the edited state in both places.
    await until(page, `location.hash.startsWith("#by=1&theme=") && location.hash !== ${JSON.stringify(before)} && localStorage.getItem("byterygon.theme-studio.state") === location.hash`, "the edited state to reach the URL hash and storage");
    await page.navigate(studio);
    await until(page, READY, "the Studio to render again");
    check((await page.evaluate<string>(VAR("--by-radius-md"))) === "8px", "a reload without the hash restores the edited theme from browser storage");
    check(await page.evaluate<boolean>(CLICK("button", "Dark")), "the Dark switch exists");
    await until(page, `document.documentElement.dataset.theme === "dark"`, "the Dark switch");
    check((await page.evaluate<string>(`getComputedStyle(document.querySelector("main")).colorScheme`)) === "dark", "Dark mode sets color-scheme: dark");

    // 2b. The presets gallery: a card per preset drawn by its own scoped tokens.css, Duplicate
    //     (opens and saves a copy), then the share link, opened in a fresh load.
    const presetRadius = (name: string) => (JSON.parse(readFileSync(join(TOKENS, "themes", `${name}.theme.json`), "utf8")) as { seeds?: { radius?: number } }).seeds?.radius ?? 4;
    check(await page.evaluate<boolean>(CLICK("button", "Themes")), "the Themes button exists");
    await until(page, `document.querySelectorAll('section[aria-label="Presets"] li').length === ${allPresets.length}`, "a card for every preset");
    for (const name of allPresets) {
      const own = await page.evaluate<string>(`getComputedStyle(document.querySelector('[data-studio-preview="preset-${name}"]')).getPropertyValue("--by-radius-md").trim()`);
      check(own === `${presetRadius(name)}px`, `gallery: the ${name} card shows its own radius.md (${own})`);
    }
    if (shots) {
      // After the dialog's entry transition; then the same in Light, for the PR.
      await sleep(600);
      await page.screenshot(join(shots, "gallery-dark.png"));
      await page.key("Escape", "Escape", 27);
      await sleep(400);
      await page.evaluate(CLICK("button", "Light"));
      await page.evaluate(CLICK("button", "Themes"));
      await sleep(800);
      await page.screenshot(join(shots, "gallery-light.png"));
    }
    check(await page.evaluate<boolean>(`(() => { const b = document.querySelector('button[aria-label="Duplicate Terminal"]'); if (!b) return false; b.click(); return true; })()`), "gallery: Duplicate Terminal");
    await until(page, `${VAR("--by-radius-md")} === "${presetRadius("terminal")}px" && document.querySelector('input[aria-label="Theme name"]').value === "terminal-copy"`, "the terminal copy to open");
    check(await page.evaluate<boolean>(`JSON.parse(localStorage.getItem("byterygon.theme-studio.library")).themes[0].theme.name === "terminal-copy"`), "gallery: the copy is saved in the browser");
    check(await page.evaluate<boolean>(CLICK("button", "Share")), "the Share button exists");
    const link = await until<string>(page, `document.querySelector('input[aria-label="Share link"]')?.value`, "the share link");
    check(link.startsWith(`${studio}#by=1&theme=`), `share link: the Studio's address with the state hash (${link.slice(0, 80)})`);
    await page.key("Escape", "Escape", 27);
    await page.navigate(link);
    await until(page, READY, "the Studio from the share link");
    check(
      (await page.evaluate<string>(`document.querySelector('input[aria-label="Theme name"]').value`)) === "terminal-copy" && (await page.evaluate<string>(VAR("--by-radius-md"))) === `${presetRadius("terminal")}px`,
      "share link: opens the shared theme",
    );
    check((await page.evaluate<string>(`document.documentElement.dataset.theme`)) === "dark", "share link: opens the shared view (Terminal is dark first)");

    // 2c. The contrast report: a theme whose muted text fails in light mode, the one-click fix.
    const faded = { schemaVersion: 1, name: "faded", overrides: { "color.neutral.11": "oklch(0.7 0.012 275)" } };
    for (const mode of ["light", "dark"] as const) {
      await page.navigate(`${studio}${await encodeState({ theme: faded, mode })}`);
      await until(page, READY, "the faded theme to render");
      // 32: the 28 of the layered look, the three text-on-backdrop pairs of TSK-64 and
      // terminal.ansi.bright-black on terminal.bg (TSK-81).
      check(await page.evaluate<boolean>(CLICK('[role="tab"]', "Contrast (32)")), `contrast (${mode}): the tab counts 32 failing measurements`);
      await until(page, `document.querySelector('ul[aria-label^="Contrast pairs"]') !== null || document.body.textContent.includes("No pair fails")`, "the contrast report");
      if (shots) {
        await sleep(300);
        await page.screenshot(join(shots, `contrast-${mode}.png`));
      }
    }
    // The view is dark now; the failures are in light mode.
    check(await page.evaluate<boolean>(CLICK('[aria-label="Mode combination"] button', "light · comfortable32")), "contrast: the light combination lists its failures");
    await until(page, `document.querySelector('ul[aria-label="Contrast pairs, light · comfortable"] > li[aria-label="color.fg.muted"]') !== null`, "the light failures of color.fg.muted");
    const unfixed = await page.evaluate<string>(`location.hash`);
    check(await page.evaluate<boolean>(CLICK("button", "Apply fix")), "contrast: the Apply fix button");
    await until(page, `[...document.querySelectorAll('[role="tab"]')].some((t) => t.textContent === "Contrast (0)")`, "the fix to clear every failure");
    await until(page, `location.hash !== ${JSON.stringify(unfixed)} && localStorage.getItem("byterygon.theme-studio.state") === location.hash`, "the fixed theme to be saved");
    const fixedHash = await page.evaluate<string>(`location.hash`);
    const { decodeState } = await import("@byterygon/design-tokens");
    const fixedTheme = (await decodeState(fixedHash)).state?.theme as { overrides?: Record<string, unknown> } | undefined;
    check(fixedTheme?.overrides?.["color.neutral.11"] === "oklch(0.49 0.012 275)", `contrast: the fix lands in the theme file (${JSON.stringify(fixedTheme?.overrides)})`);

    // 2d. Import: a pasted stock shadcn globals.css, read, opened on the contrast report.
    const shadcn = readFileSync(join(TOKENS, "test", "fixtures", "shadcn-v4.css"), "utf8");
    for (const mode of ["dark", "light"] as const) {
      await page.evaluate(CLICK("button", mode === "dark" ? "Dark" : "Light"));
      check(await page.evaluate<boolean>(CLICK("button", "Import")), "import: the Import button");
      await until(page, `document.querySelector('[role="dialog"] textarea') !== null`, "the Import dialog");
      await page.evaluate(
        `(() => { const area = document.querySelector('[role="dialog"] textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(area, ${JSON.stringify(shadcn)}); area.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`,
      );
      await until(page, `(() => { const b = [...document.querySelectorAll('[role="dialog"] button')].find((e) => e.textContent.trim() === "Read"); return b && !b.disabled; })()`, "the Read button to enable");
      await page.evaluate(CLICK('[role="dialog"] button', "Read"));
      await until(page, `document.querySelector('section[aria-label="Imported theme"]') !== null`, "the imported theme file");
      if (shots) {
        await sleep(400);
        await page.screenshot(join(shots, `import-${mode}.png`));
      }
      if (mode === "light") break;
      await page.key("Escape", "Escape", 27);
      await sleep(300);
    }
    await page.evaluate(CLICK('[role="dialog"] button', "Open this theme"));
    await until(page, `${VAR("--by-radius-md")} === "10px"`, "the imported theme (radius 0.625rem) to apply");
    await until(page, `document.querySelector('main [role="tab"][aria-selected="true"]')?.textContent.startsWith("Contrast (")`, "the contrast report to open after an import that breaks a rule");

    // 3. Every preset from its hash, every export through the dialog, against by-tokens.
    const exportsChecked: string[] = [];
    for (const preset of presets) {
      const theme = JSON.parse(readFileSync(join(TOKENS, "themes", `${preset}.theme.json`), "utf8")) as Record<string, unknown>;
      const file = join(themes, `${preset}.theme.json`);
      writeFileSync(file, JSON.stringify(theme, null, 2));
      const hash = await encodeState({ theme });
      await page.navigate(`${studio}${hash}`);
      await until(page, READY, `${preset} to render`);
      const radius = (theme["seeds"] as { radius?: number }).radius ?? 4;
      check((await page.evaluate<string>(VAR("--by-radius-md"))) === `${radius}px`, `${preset}: radius.md is ${radius}px in the page`);
      check(await page.evaluate<boolean>(CLICK("button", "Export")), `${preset}: the Export button exists`);
      await until(page, `${EXPORT_DIALOG} !== undefined`, `${preset}: the Export dialog`);
      for (const info of EXPORT_FORMATS) {
        const download = info.download(preset);
        check(await page.evaluate<boolean>(`(() => { const d = ${EXPORT_DIALOG}; const b = [...d.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(info.label)}); if (!b) return false; b.click(); return true; })()`), `${preset}: format ${info.label} in the dialog`);
        await until(page, `(() => { const d = ${EXPORT_DIALOG}; return [...d.querySelectorAll("button")].some((e) => e.textContent.trim() === ${JSON.stringify(`Download ${download}`)}); })()`, `${preset} ${info.format}: the Download button`, 30_000);
        const known = new Set(finished.keys());
        await page.evaluate(`(() => { const d = ${EXPORT_DIALOG}; [...d.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(`Download ${download}`)}).click(); return true; })()`);
        const deadline = Date.now() + 20_000;
        let guid: string | undefined;
        while (!(guid = [...finished].find(([id, state]) => !known.has(id) && state === "done")?.[0])) {
          if (Date.now() > deadline) throw new Error(`${preset} ${info.format}: the download did not finish`);
          await sleep(25);
        }
        const saved = readFileSync(join(downloads, guid), "utf8");
        const printed = await cliExport(run, themes, file, info.format);
        if (check(saved === printed, `${preset} ${info.format}: the Studio download (${saved.length} chars) differs from by-tokens export (${printed.length} chars)`)) exportsChecked.push(`${preset}/${info.format}`);
      }
      await page.key("Escape", "Escape", 27);
      if (shots) await page.screenshot(join(shots, `${preset}.png`));
    }
    report["exportsChecked"] = exportsChecked.length;

    // 4. Every request so far was the Studio's own file or a data:/blob: URL.
    const foreign = page.requests.filter((url) => !/^(file:|data:|blob:)/.test(url));
    check(foreign.length === 0, `file://: requests outside the Studio's files: ${foreign.slice(0, 5).join(", ")}`);
    report["requests"] = { file: page.requests.length };

    // 5. The same build from a loopback static server.
    server = await serve(DIST);
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const served = await openPage(cdp);
    const paper = JSON.parse(readFileSync(join(TOKENS, "themes", "paper.theme.json"), "utf8")) as Record<string, unknown>;
    await served.navigate(`${origin}/${await encodeState({ theme: paper, mode: "dark" })}`);
    await until(served, READY, "the Studio from the static server");
    check((await served.evaluate<string>(`document.documentElement.dataset.theme`)) === "dark", "static server: the hash's mode applies");
    check((await served.evaluate<string>(VAR("--by-radius-md"))) === "8px", "static server: Paper's radius applies");
    await until(served, `document.querySelector('[data-slot="sql-editor"] .monaco-editor') !== null`, "Monaco from the static server", 30_000);
    const offOrigin = served.requests.filter((url) => !url.startsWith(`${origin}/`) && !/^(data:|blob:)/.test(url));
    check(offOrigin.length === 0, `static server: requests to other origins: ${offOrigin.slice(0, 5).join(", ")}`);
    report["requests"] = { file: page.requests.length, server: served.requests.length };

    check(page.errors.length === 0, `file://: errors in the page: ${page.errors.slice(0, 5).join(" | ")}`);
    check(served.errors.length === 0, `static server: errors in the page: ${served.errors.slice(0, 5).join(" | ")}`);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    cdp?.close();
    if (browser) {
      const exited = new Promise((resolve) => browser!.child.once("exit", resolve));
      browser.child.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    server?.close();
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  report["failures"] = failures;
  const ok = failures.length === 0;
  const sizes = (report["bundle"] as { name: string; bytes: number; gzip: number }[] | undefined) ?? [];
  const lines = [
    `browser: ${String(report["browserVersion"] ?? binary)}`,
    `bundle: ${sizes.map((s) => `${s.name} ${(s.bytes / 1024).toFixed(0)} kB (${(s.gzip / 1024).toFixed(0)} kB gzip)`).join(", ")}`,
    report["interactiveMs"] !== undefined ? `interactive from file:// in ${String(report["interactiveMs"])} ms (cold profile)` : "",
    report["exportsChecked"] !== undefined ? `exports: ${String(report["exportsChecked"])} downloads (${presets.length} presets x ${EXPORT_FORMATS.length} formats) equal to by-tokens export` : "",
    ok ? "browser check passed." : failures.map((f) => `error: ${f}`).join("\n"),
  ].filter(Boolean);
  print({ ok, exitCode: ok ? 0 : 1, ...report }, lines.join("\n"));
  return ok ? 0 : 1;
}

// Exit explicitly: Vite's build leaves handles open that would keep the process alive.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(await main(process.argv.slice(2)));
