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
//     logged;
//   - Monaco (TSK-93: every query, JSON and jq input) is in chunks of its own that the page loads
//     on demand, and the report gives their size and the time to the first keystroke in the
//     Messages tab's jq editor (median of three cold loads), as packages/ui's check does for
//     SqlEditor.
//
//   node scripts/browser-check.ts
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge (packages/ui's search); the
// server is $MIGHTYCONSOLE_SERVER, else target/debug/mightyconsole-server. Without either the
// check is skipped (exit 0) unless BYTERYGON_REQUIRE_BROWSER=1 (CI). Exit codes: 0 ok or skipped,
// 1 a check failed. CI runs it in a network namespace with only loopback.
//
// MIGHTYCONSOLE_EMBEDDED_UI=1 checks a release binary (TSK-87) instead: no Vite build and no
// --ui, so the page and every asset come from the UI compiled into the binary.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { findBrowser } from "../../../../packages/ui/scripts/browser-check.ts";
import { type Cdp, type Page, freePort, launchBrowser, openPage, run, sleep, waitForLine, waitUntil } from "./cdp.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(APP, "..", "..", "..");
const required = process.env.BYTERYGON_REQUIRE_BROWSER === "1";

const failures: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
  return ok;
};
const until = async (page: Page, expression: string, what: string, timeoutMs = 20_000) => (await waitUntil(page, expression, timeoutMs)) || check(false, `timed out waiting for ${what}`);

/** Monaco's share of the built UI: its chunks, workers and CSS, and whether the page loads any of it up front. */
function monacoBundle(dist: string) {
  const assets = join(dist, "assets");
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const initial = new Set([...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+)"/g)].map((m) => m[1]!));
  const files = readdirSync(assets).map((name) => ({ name, bytes: readFileSync(join(assets, name)) }));
  // A class only Monaco's own scrollbar code uses, and its stylesheet's root class.
  const monaco = files.filter((f) => /worker/.test(f.name) || (f.name.endsWith(".js") && f.bytes.includes("monaco-scrollable-element")) || (f.name.endsWith(".css") && f.bytes.includes(".monaco-editor")));
  const size = (list: typeof files) => ({ bytes: list.reduce((n, f) => n + f.bytes.length, 0), gzip: list.reduce((n, f) => n + gzipSync(f.bytes).length, 0) });
  return {
    files: monaco.length,
    ...size(monaco),
    initial: monaco.filter((f) => initial.has(f.name)).map((f) => f.name),
    largest: [...monaco].sort((a, b) => b.bytes.length - a.bytes.length).slice(0, 3).map((f) => `${f.name} ${(f.bytes.length / 1024).toFixed(0)} kB`),
  };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

/**
 * The jq editor of the restored Messages tab after a cold load: when its fallback textarea is
 * there, when Monaco has mounted (both from navigation start), and how long a key takes to show.
 */
async function firstKeystroke(page: Page, url: string) {
  const editor = `document.querySelector("[data-slot=filter-bar] [data-slot=code-editor]")`;
  const runs: { fallback: number; ready: number; latency: number }[] = [];
  for (let i = 0; i < 3; i += 1) {
    await page.navigate(url);
    // The restored tabs come back in their order; the Messages tab may not be the one shown.
    const tab = `[...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.includes("Messages · smoke"))`;
    if (!(await waitUntil(page, tab, 30_000))) {
      // Say what the page holds instead: the restored tabs, the shell's text and its errors.
      const seen = await run(page, `JSON.stringify({ tabs: [...document.querySelectorAll("[role=tab]")].map((t) => t.textContent.trim()), text: document.body.innerText.slice(0, 400) })`);
      check(false, `timed out waiting for the restored Messages tab (load ${i + 1}); the page: ${seen}; errors: ${page.errors.join(" | ") || "none"}`);
      return null;
    }
    await run(page, `(() => { const t = ${tab}; if (t.getAttribute("aria-selected") !== "true") for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`);
    if (!(await until(page, editor, "the jq editor of the restored Messages tab", 30_000))) return null;
    const fallback = await page.evaluate<number>("performance.now()");
    if (!(await until(page, `${editor} && !${editor}.hasAttribute("data-loading") && ${editor}.querySelector(".monaco-editor .view-lines")`, "Monaco in the jq editor", 30_000))) return null;
    const ready = await page.evaluate<number>("performance.now()");
    await page.evaluate(
      `(() => { const root = ${editor}; (root.querySelector(".monaco-editor [role=textbox]") ?? root.querySelector(".monaco-editor textarea")).focus(); window.__key = null; new MutationObserver((_, o) => { window.__key = performance.now(); o.disconnect(); }).observe(root.querySelector(".view-lines"), { subtree: true, childList: true, characterData: true }); window.__before = performance.now(); return true; })()`,
    );
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "x", code: "KeyX", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88, text: "x", unmodifiedText: "x" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "x", code: "KeyX", windowsVirtualKeyCode: 88, nativeVirtualKeyCode: 88 });
    if (!(await until(page, "window.__key !== null", "the key in the jq editor", 5_000))) return null;
    runs.push({ fallback, ready, latency: await page.evaluate<number>("window.__key - window.__before") });
  }
  const round = (n: number) => Math.round(n);
  return { fallbackMs: round(median(runs.map((r) => r.fallback))), monacoReadyMs: round(median(runs.map((r) => r.ready))), keystrokeMs: round(median(runs.map((r) => r.latency))) };
}

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

  const embedded = process.env.MIGHTYCONSOLE_EMBEDDED_UI === "1";
  if (!embedded) await build({ root: APP, configFile: join(APP, "vite.config.ts"), logLevel: "warn" });
  if (!embedded) {
    const bundle = monacoBundle(join(APP, "dist"));
    console.log(`browser-check: Monaco is ${bundle.files} files, ${(bundle.bytes / 1024).toFixed(0)} kB (${(bundle.gzip / 1024).toFixed(0)} kB gzip), loaded on demand; largest: ${bundle.largest.join(", ")}`);
    check(bundle.files > 0, "bundle: no Monaco chunk found");
    check(bundle.initial.length === 0, `bundle: Monaco is in the page's initial files (${bundle.initial.join(", ")}); it must load on demand`);
  }
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-check-"));
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const uiArgs = embedded ? [] : ["--ui", join(APP, "dist")];
  const server = spawn(serverBinary, ["--listen", `127.0.0.1:${port}`, ...uiArgs, "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  try {
    const [startup] = await waitForLine(server, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
    if (embedded) check(/UI built in \(\d+ files\)/.test(startup ?? ""), "the server does not serve a built-in UI");
    ({ chrome, cdp } = await launchBrowser(browser, data));
    const page = await openPage(cdp);
    const started = Date.now();

    // 1. The page, its session and the WebSocket.
    await page.navigate(`${origin}/`);
    // The navigation opens on its first tool (TSK-91); this check uses Echo.
    await until(page, `__mc.button("Echo")`, "the tool navigation");
    await run(page, `__mc.click(__mc.button("Echo"))`);
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

    // 2b. The messaging core on the test backend (TSK-80): the Composer sends to the topic `echo`
    // (echo.messages.produce through the codecs, the payload in Monaco), then the Messages tab tails
    // it: Arrow batches over /rpc/ws, decoded in the Worker, shown in the data grid, read by the
    // detail pane.
    await run(page, `__mc.dblclick(__mc.item("Composer"))`);
    await until(page, `document.querySelector("[data-slot=composer] [data-slot=code-editor]:not([data-loading])")`, "the Composer and its Monaco editor");
    await run(page, `__mc.click([...document.querySelectorAll("[data-slot=composer] button")].find((b) => b.textContent.trim() === "Send"))`);
    await until(page, `__mc.has("Written to partition")`, "echo.messages.produce");
    await run(page, `__mc.dblclick(__mc.item("Messages"))`);
    const tail = `document.querySelector('[role=toolbar][aria-label="records actions"]')`;
    await until(page, tail, "the Messages tab");
    await run(page, `__mc.click([...${tail}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Start"))`);
    await until(page, `__mc.has("1 records shown")`, "the message decoded in the Arrow Worker");
    await run(
      page,
      `(() => { const c = document.querySelector("[data-slot=message-viewer] .bdg-body [role=gridcell]"); for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) c.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`,
    );
    await until(page, `document.querySelector("[data-slot=message-detail]")`, "the detail pane");

    // 3. A reload: the tab is restored and connects again.
    await page.navigate(`${origin}/`);
    await until(page, `[...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.includes("Ticks · smoke"))`, "the restored tab");
    await until(page, `__mc.button("Start") && !__mc.has("Connect to smoke")`, "the restored tab to connect");

    // 3b. Monaco cold (TSK-93): the restored Messages tab's jq editor, three loads.
    const keystroke = await firstKeystroke(page, `${origin}/`);
    if (keystroke) console.log(`browser-check: jq editor: fallback at ${keystroke.fallbackMs} ms, Monaco ready at ${keystroke.monacoReadyMs} ms, first key shown ${keystroke.keystrokeMs} ms after it was pressed (median of 3 cold loads)`);

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
