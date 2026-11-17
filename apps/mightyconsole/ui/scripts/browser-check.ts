#!/usr/bin/env node
// Mightyconsole in a real browser against the real server (TSK-79, spec §18): builds dist/, starts
// `mightyconsole-server --ui dist` on a loopback port with a fresh data directory (so it makes its
// self-signed certificate), and drives Chromium over the DevTools protocol (Node's own WebSocket):
//
//   - the page loads with the server's session: the cookie, the CSRF <meta>, the exact Origin and
//     the CSP all hold, because app.info answers over /rpc/ws and the status bar shows the origin;
//   - a profile added through the UI connects (echo.connect), its Ticks tab streams with credits,
//     and after a reload the tab comes back and connects again;
//   - the page opened through 127.0.0.1 is redirected to the public origin;
//   - every request goes to the server's origin (or data:/blob:), and no script or CSP error is
//     logged.
//
//   node scripts/browser-check.ts
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge (packages/ui's search); the
// server is $MIGHTYCONSOLE_SERVER, else target/debug/mightyconsole-server. Without either the
// check is skipped (exit 0) unless BYTERYGON_REQUIRE_BROWSER=1 (CI). Exit codes: 0 ok or skipped,
// 1 a check failed. CI runs it in a network namespace with only loopback.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { findBrowser } from "../../../../packages/ui/scripts/browser-check.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(APP, "..", "..", "..");
const required = process.env.BYTERYGON_REQUIRE_BROWSER === "1";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// DevTools protocol (as packages/theme-studio's check)

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
  on(listener: (m: Message) => void): void {
    this.listeners.add(listener);
  }
  close(): void {
    this.socket.close();
  }
}

function waitForLine(child: ChildProcess, pattern: RegExp, what: string): Promise<RegExpExecArray> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${what} did not start:\n${output}`)), 60_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const match = pattern.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`${what} exited (${code}):\n${output}`));
    });
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

interface Page {
  evaluate: <T>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<void>;
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
  return {
    async evaluate<T>(expression: string): Promise<T> {
      const result = (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true })) as { result: { value: T }; exceptionDetails?: { exception?: { description?: string }; text: string } };
      if (result.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      return result.result.value;
    },
    async navigate(url) {
      const done = new Promise<void>((resolve) => (loaded = resolve));
      await send("Page.navigate", { url });
      await Promise.race([done, sleep(30_000).then(() => Promise.reject(new Error(`loading ${url} timed out`)))]);
    },
    requests,
    errors,
  };
}

/** DOM helpers injected into the page: find by text, type into a React input, click, double-click. */
const HELPERS = `(() => {
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  window.__mc = {
    has: (needle) => document.body.innerText.includes(needle),
    button: (label) => [...document.querySelectorAll("button")].find((b) => text(b) === label || b.getAttribute("aria-label") === label),
    item: (label) => [...document.querySelectorAll("[role=treeitem]")].find((el) => text(el).startsWith(label)),
    click: (el) => { if (!el) throw new Error("nothing to click"); el.click(); return true; },
    dblclick: (el) => { if (!el) throw new Error("nothing to double-click"); el.click(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; },
    field: (label) => { const l = [...document.querySelectorAll("label")].find((x) => text(x) === label); return l && (l.control || document.getElementById(l.htmlFor)); },
    type: (el, value) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); return true; },
  };
  return true;
})()`;

async function until(page: Page, expression: string, what: string, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await page.evaluate<boolean>(`(() => { ${HELPERS}; return Boolean(${expression}); })()`)) return true;
    } catch {
      // the page is loading
    }
    await sleep(100);
  }
  return check(false, `timed out waiting for ${what}`);
}

const run = (page: Page, expression: string) => page.evaluate(`(() => { ${HELPERS}; return ${expression}; })()`);

async function main(): Promise<number> {
  const browser = findBrowser();
  const serverBinary = process.env.MIGHTYCONSOLE_SERVER ?? join(REPO, "target", "debug", process.platform === "win32" ? "mightyconsole-server.exe" : "mightyconsole-server");
  if (!browser || !existsSync(serverBinary)) {
    const missing = !browser ? "no browser (set BYTERYGON_BROWSER)" : `no server binary at ${serverBinary} (cargo build -p mightyconsole-server)`;
    if (required) {
      console.error(`browser-check: ${missing}`);
      return 1;
    }
    console.log(`browser-check: skipped, ${missing}`);
    return 0;
  }

  await build({ root: APP, configFile: join(APP, "vite.config.ts"), logLevel: "warn" });
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-check-"));
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const server = spawn(serverBinary, ["--listen", `127.0.0.1:${port}`, "--ui", join(APP, "dist"), "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    await waitForLine(server, /open https:\/\/localhost:\d+\//, "mightyconsole-server");
    // The certificate is the server's own self-signed one: the check trusts it for this run only.
    chrome = spawn(
      browser,
      [
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${join(data, "browser")}`,
        "--ignore-certificate-errors",
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
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    const [, devtools] = await waitForLine(chrome, /DevTools listening on (ws:\/\/\S+)/, "the browser");
    cdp = await Cdp.connect(devtools!);
    const page = await openPage(cdp);
    const started = Date.now();

    // 1. The page, its session and the WebSocket.
    await page.navigate(`${origin}/`);
    await until(page, `__mc.has("No Echo connections yet")`, "the empty connection list");
    await until(page, `__mc.has(${JSON.stringify(origin)})`, "app.info over /rpc/ws (the status bar shows the origin)");
    console.log(`browser-check: interactive after ${Date.now() - started} ms`);
    check(await page.evaluate<boolean>(`Boolean(document.querySelector('meta[name="mightyconsole-csrf"]')?.content)`), "the page has no CSRF meta");

    // 2. A profile through the UI, connected, a live stream.
    await run(page, `__mc.click(__mc.button("Add connection"))`);
    await until(page, `__mc.field("Name")`, "the profile sheet");
    await run(page, `__mc.type(__mc.field("Name"), "smoke")`);
    await run(page, `__mc.click(__mc.button("Save"))`);
    await until(page, `__mc.item("smoke")`, "the saved profile");
    await run(page, `__mc.dblclick(__mc.item("smoke"))`);
    await until(page, `__mc.item("Ticks")`, "echo.connect and the resource tree");
    await run(page, `__mc.dblclick(__mc.item("Ticks"))`);
    await until(page, `__mc.button("Start")`, "the Ticks tab");
    await run(page, `__mc.click(__mc.button("Start"))`);
    await until(page, `__mc.has("tick 3")`, "ticks streamed with credits");

    // 3. A reload: the tab is restored and connects again.
    await page.navigate(`${origin}/`);
    await until(page, `[...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.includes("Ticks · smoke"))`, "the restored tab");
    await until(page, `__mc.button("Start") && !__mc.has("Connect to smoke")`, "the restored tab to connect");

    // 4. Another accepted host is sent to the public origin.
    await page.navigate(`https://127.0.0.1:${port}/`);
    await until(page, `location.origin === ${JSON.stringify(origin)}`, "the redirect to the public origin");

    // 5. Nothing but the server, and no errors.
    const foreign = page.requests.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith(`wss://localhost:${port}/`) && !url.startsWith(`https://127.0.0.1:${port}/`) && !url.startsWith("data:") && !url.startsWith("blob:") && url !== "about:blank");
    check(foreign.length === 0, `requests outside the server: ${foreign.join(", ")}`);
    check(page.requests.some((url) => url === `wss://localhost:${port}/rpc/ws`), "no WebSocket to /rpc/ws");
    check(page.errors.length === 0, `errors in the page:\n  ${page.errors.join("\n  ")}`);
  } finally {
    cdp?.close();
    chrome?.kill();
    server.kill();
    await sleep(200);
    rmSync(data, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    console.error(`browser-check: ${failures.length} failed:\n- ${failures.join("\n- ")}`);
    return 1;
  }
  console.log("browser-check: ok");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`browser-check: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  },
);
