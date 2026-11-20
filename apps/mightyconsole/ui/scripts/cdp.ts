// The DevTools protocol over Node's own WebSocket, for the Mightyconsole checks that drive a real
// browser: scripts/browser-check.ts (TSK-79) and the acceptance harness's screenshots (TSK-87).
// No dependency: Chrome, Chromium or Edge started headless with --remote-debugging-port=0.
import { type ChildProcess, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Params = Record<string, unknown>;
interface Message {
  id?: number;
  method?: string;
  params?: Params;
  sessionId?: string;
  result?: Params;
  error?: { message: string };
}

export class Cdp {
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

export function waitForLine(child: ChildProcess, pattern: RegExp, what: string): Promise<RegExpExecArray> {
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

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

export interface Page {
  evaluate: <T>(expression: string) => Promise<T>;
  navigate: (url: string) => Promise<void>;
  /** A DevTools command on this page's session (`Emulation.setEmulatedMedia`, …). */
  send: (method: string, params?: Params) => Promise<Params>;
  /** Saves a PNG of the viewport. */
  screenshot: (file: string) => Promise<void>;
  requests: string[];
  errors: string[];
}

export async function openPage(cdp: Cdp): Promise<Page> {
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
    send,
    async screenshot(file) {
      const { data } = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
      writeFileSync(file, Buffer.from(data, "base64"));
    },
    requests,
    errors,
  };
}

/** DOM helpers injected into the page: find by text, type into a React input, click, double-click. */
export const HELPERS = `(() => {
  const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim();
  window.__mc = {
    has: (needle) => document.body.innerText.includes(needle),
    button: (label) => [...document.querySelectorAll("button")].find((b) => text(b) === label || b.getAttribute("aria-label") === label),
    item: (label) => [...document.querySelectorAll("[role=treeitem]")].find((el) => text(el).startsWith(label)),
    click: (el) => { if (!el) throw new Error("nothing to click"); el.click(); return true; },
    dblclick: (el) => { if (!el) throw new Error("nothing to double-click"); el.click(); el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); return true; },
    field: (label) => { const l = [...document.querySelectorAll("label")].find((x) => text(x) === label); return l && (l.control || document.getElementById(l.htmlFor)); },
    type: (el, value) => { el.focus(); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set; set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; },
  };
  return true;
})()`;

/** Waits until `expression` (with the helpers) is truthy in the page; false after `timeoutMs`. */
export async function waitUntil(page: Page, expression: string, timeoutMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (await page.evaluate<boolean>(`(() => { ${HELPERS}; return Boolean(${expression}); })()`)) return true;
    } catch {
      // the page is loading
    }
    await sleep(100);
  }
  return false;
}

export const run = (page: Page, expression: string) => page.evaluate(`(() => { ${HELPERS}; return ${expression}; })()`);


/** Starts the browser headless with its own profile in `dir` and attaches to it. The server's
 * certificate is its own self-signed one, so certificate errors are ignored for this run only. */
export async function launchBrowser(browser: string, dir: string): Promise<{ chrome: ChildProcess; cdp: Cdp }> {
  const chrome = spawn(
    browser,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${join(dir, "browser")}`,
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
  try {
    const [, devtools] = await waitForLine(chrome, /DevTools listening on (ws:\/\/\S+)/, "the browser");
    return { chrome, cdp: await Cdp.connect(devtools!) };
  } catch (error) {
    chrome.kill();
    throw error;
  }
}
