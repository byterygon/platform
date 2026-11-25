#!/usr/bin/env node
// Mightyconsole in a real browser against the real server (TSK-79, spec §18): builds dist/, starts
// `mightyconsole-server --ui dist` on a loopback port with a fresh data directory (so it makes its
// self-signed certificate), and drives Chromium over the DevTools protocol (Node's own WebSocket):
//
//   - the page loads with the server's session: the cookie, the CSRF <meta>, the exact Origin and
//     the CSP all hold, because app.info answers over /rpc/ws and the status bar shows the origin;
//   - a profile added through the UI connects (echo.connect), its Ticks tab streams with credits,
//     and after a reload the tab comes back and connects again;
//   - routing (DOC-21 §3.7): the URL follows the active tab, a deep link loads at its path and
//     focuses its tab, Back and Forward and a reload keep each URL's place; and again on a
//     second server with --router hash --base-path /tools/mc (the page, assets and WebSocket
//     under the prefix, the place in the hash, reload, an edited hash, Back);
//   - the navigation row (TSK-105): crumbs, a link up as a step, Back's list, Back and Forward,
//     a segment's siblings menu, Copy link, the path folded into … when narrow; a link to a
//     missing profile shows its page and opens with another profile; a profile sheet with a
//     typed name holds the browser's Back (Discard changes?, useBlocker);
//   - the page opened through 127.0.0.1 is redirected to the public origin;
//   - every request goes to the server's origin (or data:/blob:), and no script or CSP error is
//     logged;
//   - jq on a message's value (TSK-113): a snippet's group by on a 2,000-order message, a program
//     that never ends stopped at the time limit, and the Profile;
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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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
let failureShots = 0;
const until = async (page: Page, expression: string, what: string, timeoutMs = 20_000) => {
  if (await waitUntil(page, expression, timeoutMs)) return true;
  // What the page showed, so a failure in CI says more than its name (TSK-121: the URL, the visible
  // tabs with the selected one starred, the page's last errors, and a screenshot when
  // MIGHTYCONSOLE_FAILURE_SHOTS names a folder, as the acceptance harness does).
  const shown = await page
    .evaluate<string>(
      `JSON.stringify({ url: location.pathname + location.search + location.hash, tabs: [...document.querySelectorAll("[role=tab]")].filter((t) => t.checkVisibility()).slice(0, 12).map((t) => (t.getAttribute("aria-selected") === "true" ? "*" : "") + t.textContent.trim()), text: document.body.innerText.replace(/\\s+/g, " ").slice(0, 600) })`,
    )
    .catch(() => "");
  let shot = "";
  const dir = process.env.MIGHTYCONSOLE_FAILURE_SHOTS;
  if (dir) {
    failureShots += 1;
    const file = join(dir, `browser-check-failure-${failureShots}.png`);
    mkdirSync(dir, { recursive: true });
    await page.screenshot(file).then(() => (shot = `; screenshot ${file}`), () => {});
  }
  return check(false, `timed out waiting for ${what}; the page: ${shown}; errors: ${page.errors.slice(-3).join(" | ") || "none"}${shot}`);
};

/** A click on `el` as a pointer does it: pointer and mouse down, up, then click. */
const press = (el: string) =>
  `(() => { const t = ${el}; if (!t) throw new Error("nothing to press"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`;

/**
 * Presses `el` until `expression` holds, at most three times, and says on stderr when one press was
 * not enough (TSK-121). In CI a press on a tab or the tool rail right after a load or a history move
 * sometimes left the page as it was (13 of about 30 lab failures in the week to 2026-11-22); only
 * presses that change nothing when repeated (picking a tab, picking a tool) go through here, and the
 * evidence keeps the count, so a lost press is seen rather than hidden.
 */
const pressUntil = async (page: Page, el: string, expression: string, what: string) => {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await run(page, press(el));
    if (await waitUntil(page, expression, attempt === 3 ? 20_000 : 5_000)) {
      if (attempt > 1) console.error(`browser-check: ${what} needed ${attempt} presses`);
      return true;
    }
  }
  return until(page, expression, what, 1);
};
/** The text area of the drawn Monaco editor named `label` (as acceptance/editors.mts finds it). */
const editorArea = (label: string) =>
  `[...document.querySelectorAll("[data-slot=code-editor]")].filter((e) => e.getClientRects().length > 0).map((e) => e.querySelector(".monaco-editor [role=textbox], .monaco-editor textarea")).find((t) => t && (t.getAttribute("aria-label") === ${JSON.stringify(label)} || document.getElementById(t.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === ${JSON.stringify(label)}))`;

/**
 * Replaces a Monaco editor's text as a person would: a click into it, select all, then a paste of
 * the text (one edit; typing a long text through insertText runs Monaco's auto-indent and
 * auto-close on every line and never returned for 13 KB in a local run).
 */
async function pasteInEditor(page: Page, label: string, text: string): Promise<boolean> {
  if (!(await until(page, `Boolean(${editorArea(label)})`, `the ${label} editor`, 30_000))) return false;
  const box = await page.evaluate<{ x: number; y: number }>(`(() => { const root = ${editorArea(label)}.closest("[data-slot=code-editor]"); root.scrollIntoView({ block: "center" }); const r = root.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 120), y: r.top + Math.min(r.height / 2, 16) }; })()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
  if (!(await until(page, `${editorArea(label)}.closest(".monaco-editor").classList.contains("focused")`, `the ${label} editor focused`))) return false;
  // Ctrl+A (Cmd+A on macOS, where the key alone does not reach the editing command).
  const modifiers = process.platform === "darwin" ? 4 : 2;
  for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers, ...(type === "rawKeyDown" ? { commands: ["selectAll"] } : {}) });
  await page.evaluate(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); ${editorArea(label)}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  // The view follows the cursor to the end of the pasted text.
  return until(page, `${editorArea(label)}.closest("[data-slot=code-editor]").querySelector(".view-lines").textContent.replace(/\\s+/g, "").includes(${JSON.stringify(text.slice(-60).replace(/\s+/g, ""))})`, `the text pasted into the ${label} editor`);
}

/** The visible element of `selector` whose text is `label` (or contains it, with `contains`). */
const visible = (selector: string, label: string, contains = false) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.checkVisibility() && (${contains ? `e.textContent.includes(${JSON.stringify(label)})` : `e.textContent.trim() === ${JSON.stringify(label)} || e.getAttribute("aria-label") === ${JSON.stringify(label)}`}))`;

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

/** Waits until the workspace's saved tabs (IndexedDB "mightyconsole", store "workspace", key "tabs") include `title`. */
async function savedTab(page: Page, title: string, timeoutMs: number): Promise<boolean> {
  const read = `new Promise((resolve) => {
    const open = indexedDB.open("mightyconsole");
    open.onerror = () => resolve(false);
    open.onsuccess = () => {
      const db = open.result;
      try {
        const get = db.transaction("workspace").objectStore("workspace").get("tabs");
        get.onsuccess = () => { db.close(); resolve(JSON.stringify(get.result ?? null).includes(${JSON.stringify(title)})); };
        get.onerror = () => { db.close(); resolve(false); };
      } catch { db.close(); resolve(false); }
    };
  })`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await page.evaluate<boolean>(read).catch(() => false)) return true;
    await sleep(200);
  }
  return false;
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
  let hashServer: ChildProcess | undefined;
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

    // 2c. The detail pane and the JSON view (TSK-112) at a 1080p window: the value has room (at least
    // 25 rows or lines of it, measured), the detail sits to the right of a wide list, maximizes and
    // restores, goes below and back, and the view switches to Text and finds in it.
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    const pane = `document.querySelector("[data-slot=message-viewer] [data-slot=resizable]")`;
    const valueView = `document.querySelector("[data-slot=message-detail] [role=tree], [data-slot=message-detail] [data-slot=code-block-scroller]")`;
    const visibleLines = `(() => { const v = ${valueView}; if (!v) return 0; const row = v.querySelector("[role=treeitem]") ?? v.querySelector("[data-slot=code-block-line]"); return row ? Math.floor(v.clientHeight / row.getBoundingClientRect().height) : 0; })()`;
    await until(page, `${valueView}`, "the value in the detail pane");
    // The side follows the view's width, so give the new window size a moment to reach the layout.
    const beside = await waitUntil(page, `${pane}.getAttribute("data-orientation") === "horizontal"`, 5_000);
    check(beside, `at 1920 px the detail sits to the right of the list, it is ${await run(page, `${pane}.getAttribute("data-orientation")`)}`);
    await sleep(300);
    const lines = await page.evaluate<number>(visibleLines);
    check(lines >= 25, `at 1920x1080 the detail shows ${lines} rows of the value, the DoD wants at least 25`);
    const labelled = (name: string) => `document.querySelector('[data-slot=message-viewer] [aria-label="${name}"]')`;
    await run(page, `${labelled("Maximize the detail")}.click()`);
    await until(page, `${labelled("Restore the detail")}`, "the Restore button");
    const maxWidths = await page.evaluate<number[]>(`[...${pane}.querySelectorAll("[data-slot=resizable-panel]")].map((p) => Math.round(p.getBoundingClientRect().width))`);
    check(maxWidths[0] === 0 && maxWidths[1]! > 1000, `a maximized detail fills the view: panel widths ${maxWidths.join(", ")}`);
    await run(page, `${labelled("Restore the detail")}.click()`);
    await until(page, `${labelled("Maximize the detail")}`, "the Maximize button again");
    await run(page, `${labelled("Show the detail below the list")}.click()`);
    await until(page, `${pane}.getAttribute("data-orientation") === "vertical"`, "the detail below the list");
    const below = await page.evaluate<number>(visibleLines);
    await run(page, `${labelled("Show the detail to the right of the list")}.click()`);
    await until(page, `${pane}.getAttribute("data-orientation") === "horizontal"`, "the detail beside the list again");
    await run(page, `[...document.querySelectorAll("[data-slot=message-detail] [data-slot=json-viewer-toolbar] button")].find((b) => b.textContent.trim() === "Text").click()`);
    await until(page, `document.querySelector("[data-slot=message-detail] [data-slot=code-block]")`, "the value as text");
    await run(page, `[...document.querySelectorAll("[data-slot=message-detail] [data-slot=json-viewer-toolbar] button")].find((b) => b.getAttribute("aria-label") === "Find").click()`);
    await until(page, `document.querySelector("[data-slot=json-viewer-find] input")`, "the find bar");
    await run(page, `__mc.type(document.querySelector("[data-slot=json-viewer-find] input"), "{")`);
    await until(page, `/^1 of \\d+/.test(document.querySelector("[data-slot=json-viewer-count]")?.textContent ?? "")`, "the find count in the text");
    await run(page, `[...document.querySelectorAll("[data-slot=message-detail] [data-slot=json-viewer-toolbar] button")].find((b) => b.textContent.trim() === "Tree").click()`);
    await until(page, `document.querySelector("[data-slot=message-detail] [role=tree]")`, "the value as a tree again");
    console.log(`detail pane at 1920x1080: ${lines} rows of the value to the right of the list, ${below} below it`);

    // 2d. jq on a message's value, on the server (TSK-113, DOC-21 §5.4.1): a 2,000-order message,
    // grouped by status through a snippet (its field selected in each place, so typing replaces
    // them all), then a program that never ends, stopped at the 2 s time limit while the page and
    // the server stay responsive, then the Profile of the orders.
    const orders = JSON.stringify({ orders: Array.from({ length: 2000 }, (_, i) => ({ id: `ord-${String(i).padStart(5, "0")}`, status: ["paid", "open", "refunded"][i % 3], total: 10 + (i % 90) })) }, null, 1);
    await run(page, `__mc.dblclick(__mc.item("Composer"))`);
    if (await pasteInEditor(page, "Payload", orders)) {
      await run(page, `__mc.click([...document.querySelectorAll("[data-slot=composer] button")].find((b) => b.textContent.trim() === "Send"))`);
      await until(page, `/Written to partition \\d+ at offset \\d+, \\d{2,3},\\d{3} bytes/.test(document.body.innerText)`, "the orders message produced", 30_000);
    }
    await run(page, `__mc.dblclick(__mc.item("Messages"))`);
    // The newest row (the payload's column is off to the side, so find it by its place).
    const ordersRow = `[...document.querySelectorAll("[data-slot=message-viewer] .bdg-body [role=row]")].at(-1)?.querySelector("[role=gridcell]")`;
    if (await until(page, `__mc.has("2 records shown") && ${ordersRow}`, "the orders message in the live tail", 30_000)) {
      await run(page, press(ordersRow));
      await until(page, `[...document.querySelectorAll("[data-slot=message-detail] [role=treeitem]")].some((r) => r.textContent.includes("orders"))`, "the orders message in the detail");
      const queryButton = `[...document.querySelectorAll("[data-slot=message-detail] [data-slot=json-viewer-toolbar] button")].find((b) => b.textContent.trim() === "Query")`;
      await until(page, queryButton, "the Query button in the value's toolbar");
      await run(page, `${queryButton}.click()`);
      await until(page, `Boolean(${editorArea("jq program")}) && ${editorArea("jq program")}.closest("[data-slot=code-editor]").querySelector(".view-lines")`, "the Query bar's editor", 30_000);
      await run(page, `__mc.click(__mc.button("Snippets"))`);
      const groupBy = `[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Group by a field"))`;
      if (await until(page, groupBy, "the Snippets menu")) {
        await run(page, `${groupBy}.click()`);
        await until(page, `${editorArea("jq program")}.closest(".monaco-editor").classList.contains("focused")`, "the snippet in the editor");
        await page.send("Input.insertText", { text: "status" });
        await run(page, `__mc.click(__mc.button("Run"))`);
        const status = `[...document.querySelectorAll("[data-slot=value-explorer] [role=status]")].map((s) => s.textContent).join(" ")`;
        if (await until(page, `/^1 result/.test(${status})`, "the group by's one result", 30_000)) {
          const counts = await page.evaluate<string>(`[...document.querySelectorAll("[data-slot=message-detail] [role=treeitem]")].map((r) => r.textContent).join(" | ").slice(0, 400)`);
          check(/paid/.test(counts) && /open/.test(counts) && /refunded/.test(counts), `group by status shows the three statuses: ${counts}`);
        }
      }
      if (await pasteInEditor(page, "jq program", "def f: f; f")) {
        const started = Date.now();
        await run(page, `__mc.click(__mc.button("Run"))`);
        await until(page, `__mc.has("was stopped before its first result")`, "the never-ending program stopped", 15_000);
        const took = Date.now() - started;
        check(took < 6_000, `a program that never ends was stopped after ${took} ms (the time limit is 2 s)`);
        console.log(`jq: a program that never ends stopped after ${took} ms`);
      }
      await run(page, `__mc.click(__mc.button("Profile"))`);
      await until(page, `document.querySelectorAll('table[aria-label="Profile of the fields"] tbody tr').length === 3`, "the Profile of the orders' three fields", 30_000);
    }
    await page.send("Emulation.clearDeviceMetricsOverride", {});

    // 3. A reload: the tab is restored and connects again. The tabs are saved 200 ms after they
    // settle (the live tail keeps changing them for a while), so reload only once the Messages tab
    // is in IndexedDB; reloading earlier restores the tabs without it.
    const saved = await savedTab(page, "Messages", 15_000);
    check(saved, "the Messages tab was not saved to the workspace within 15 s");
    await page.navigate(`${origin}/`);
    await until(page, `[...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.includes("Ticks · smoke"))`, "the restored tab");
    await until(page, `__mc.button("Start") && !__mc.has("Connect to smoke")`, "the restored tab to connect");

    // 3a. Routing (DOC-21 §3.7, browser mode): the URL follows the active tab; a deep link loads
    // the page and its assets at a deep path and focuses its tab; Back and Forward across loads
    // focus each URL's tab; a reload keeps the place.
    const selected = (title: string) => `[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes(${JSON.stringify(title)}))`;
    await until(page, `location.pathname === "/echo/smoke/messages"`, "the URL of the restored active tab");
    await page.navigate(`${origin}/echo/smoke/ticks`);
    await until(page, `${selected("Ticks · smoke")} && __mc.button("Start")`, "the deep link's tab");
    await page.navigate(`${origin}/echo/smoke/compose`);
    await until(page, selected("Composer"), "the second deep link's tab");
    await run(page, `history.back()`);
    await until(page, `location.pathname === "/echo/smoke/ticks" && ${selected("Ticks · smoke")}`, "Back to the Ticks tab");
    await run(page, `history.forward()`);
    await until(page, `location.pathname === "/echo/smoke/compose" && ${selected("Composer")}`, "Forward to the Composer tab");
    await pressUntil(page, visible("[role=tab]", "Ticks · smoke", true), `location.pathname === "/echo/smoke/ticks"`, "the URL following a clicked tab");
    await page.navigate(`${origin}/echo/smoke/ticks`);
    // Settled: the restored tab is connected again (its Start button), as after the reload of step 3.
    await until(page, `${selected("Ticks · smoke")} && location.pathname === "/echo/smoke/ticks" && __mc.button("Start")`, "the place after a reload");
    // 3b. The navigation row (TSK-105) on a Temporal profile that never connects (no Temporal here):
    // the row sits above the tab's states, so its crumbs, Back list, siblings and link all work.
    const row = `document.querySelector("[role=tabpanel]:not([hidden]) [role=toolbar][aria-label=Location]")`;
    const crumbs = `[...${row}.querySelectorAll("[data-slot=breadcrumb-item]")].map((el) => el.textContent.trim()).join(" / ")`;
    const rowButton = (label: string) => `[...${row}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
    const menuItem = (label: string) => `[...document.querySelectorAll("[role=menuitem]")].find((el) => el.textContent.trim() === ${JSON.stringify(label)})`;
    await pressUntil(page, visible("button", "Temporal"), `__mc.has("No Temporal connections yet")`, "the Temporal connection list");
    await run(page, `__mc.click(__mc.button("Add connection"))`);
    await until(page, `__mc.field("Name")`, "the Temporal profile sheet");
    await run(page, `__mc.type(__mc.field("Name"), "lab")`);
    // A port nothing listens on, so the profile never connects, with or without a lab running.
    await until(page, `__mc.field("Address")`, "the Temporal form's Address");
    await run(page, `__mc.field("Address") && __mc.type(__mc.field("Address"), "127.0.0.1:9")`);
    await run(page, `__mc.click(__mc.button("Save"))`);
    await until(page, `__mc.item("lab")`, "the saved Temporal profile");
    await page.navigate(`${origin}/temporal/lab/orders/workflows/order-48213/history`);
    await until(page, `${row} && ${crumbs} === "lab / orders / Workflows / order-48213 / History"`, "the navigation row's crumbs");
    await until(page, `[...${row}.querySelectorAll("span")].some((s) => s.textContent === "/temporal/lab/orders/workflows/order-48213/history")`, "the link text");
    check(await run(page, `${row}.querySelector("[aria-current=page]")?.textContent.trim() === "History"`) === true, "nav row: the current segment is not History");
    // A link up is a step; Back's list names both; picking one moves the tab.
    await run(page, press(rowButton("Workflows")));
    await until(page, `location.pathname === "/temporal/lab/orders/workflows" && ${crumbs} === "lab / orders / Workflows"`, "the Workflows crumb as a step");
    await run(page, `${rowButton("Back")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))`);
    await until(page, `${menuItem("Workflows · orders")} && ${menuItem("History · order-48213")} && __mc.has("This tab")`, "Back's list of this tab");
    await run(page, press(menuItem("History · order-48213")));
    await until(page, `location.pathname === "/temporal/lab/orders/workflows/order-48213/history"`, "the step picked from Back's list");
    await run(page, press(rowButton("Forward")));
    await until(page, `location.pathname === "/temporal/lab/orders/workflows"`, "Forward in the row");
    await run(page, press(rowButton("Back")));
    await until(page, `location.pathname === "/temporal/lab/orders/workflows/order-48213/history"`, "Back in the row");
    // A level's siblings: the namespaces, which need the connection.
    await run(page, press(rowButton("orders")));
    await until(page, `__mc.has("Connect the profile to list them.")`, "the namespace segment's menu");
    await run(page, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })), document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    // Copy link copies the address bar's URL.
    await page.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
    await run(page, press(rowButton("Copy link")));
    await until(page, `__mc.has("Copied link")`, "Copy link's toast");
    const copied = await page.evaluate<string>(`navigator.clipboard.readText()`).catch(() => "");
    check(copied === `${origin}/temporal/lab/orders/workflows/order-48213/history`, `Copy link copied ${JSON.stringify(copied)}`);
    // Narrow: the link text goes first, then the first segments fold into "…".
    await page.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 800, deviceScaleFactor: 1, mobile: false });
    await until(page, `${rowButton("Show the hidden path")} && ![...${row}.querySelectorAll("span")].some((s) => s.textContent.startsWith("/temporal/"))`, "the folded path");
    check(await run(page, `${crumbs}.endsWith("order-48213 / History")`) === true, "nav row: the last two segments fold");
    await run(page, press(rowButton("Show the hidden path")));
    await until(page, `${menuItem("lab")} && ${menuItem("Workflows")}`, "the hidden path's menu");
    await run(page, press(menuItem("Workflows")));
    await until(page, `location.pathname === "/temporal/lab/orders/workflows"`, "a hidden segment picked");
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    // Unsaved changes (useBlocker): a profile sheet with a typed name holds the browser's Back
    // (inside the document: the steps above pushed entries).
    await run(page, `__mc.click(__mc.button("Add connection"))`);
    await until(page, `__mc.field("Name")`, "the profile sheet (unsaved changes)");
    await sleep(300);
    await run(page, `__mc.type(__mc.field("Name"), "half-typed")`);
    await sleep(300);
    await run(page, `history.back()`);
    await until(page, `__mc.has("Discard changes?") && __mc.button("Keep editing")`, "Discard changes? on the browser's Back");
    await run(page, `__mc.click(__mc.button("Keep editing"))`);
    await until(page, `!__mc.has("Discard changes?")`, "Keep editing");
    await sleep(500);
    check(await run(page, `location.pathname === "/temporal/lab/orders/workflows" && __mc.field("Name")?.value === "half-typed"`) === true, "blocker: Keep editing left the page or the sheet");
    await run(page, `history.back()`);
    await until(page, `__mc.button("Discard changes")`, "Discard changes? again");
    await run(page, `__mc.click(__mc.button("Discard changes"))`);
    await until(page, `location.pathname !== "/temporal/lab/orders/workflows"`, "Back after discarding");
    await run(page, `__mc.click(__mc.button("Cancel"))`);

    // 3c. A link to a missing profile: its page, its URL kept, nothing connected.
    await page.navigate(`${origin}/echo/nobody/ticks`);
    await until(page, `__mc.has("This link needs an Echo profile named nobody") && __mc.button("Create profile nobody") && __mc.button("Import profiles…")`, "the missing-profile page");
    check(await run(page, `location.pathname === "/echo/nobody/ticks"`) === true, "missing profile: the URL changed");
    await run(page, press(`__mc.button("Open with another profile…")`));
    await until(page, menuItem("smoke"), "another Echo profile to open the link with");
    await run(page, press(menuItem("smoke")));
    await until(page, `location.pathname === "/echo/smoke/ticks" && ${selected("Ticks · smoke")}`, "the link opened with smoke");

    // 3d. Tab groups (DOC-21 §3.2.1, TSK-111): ten tabs of four tools, at 1440 px, in groups with
    // no "More tabs"; a folded group's chip opens it on its last focused tab; a reload keeps the
    // groups, their order and the focused tab. NATS and LangGraph profiles that never connect (port 9).
    for (const [tool, name, field, value] of [
      ["NATS", "edge", "Servers", "nats://127.0.0.1:9"],
      ["LangGraph", "agents", "URL", "http://127.0.0.1:9"],
    ] as const) {
      await pressUntil(page, visible("button", tool), `__mc.has("No ${tool} connections yet")`, `the ${tool} connection list`);
      await run(page, `__mc.click(__mc.button("Add connection"))`);
      await until(page, `__mc.field("Name")`, `the ${tool} profile sheet`);
      await run(page, `__mc.type(__mc.field("Name"), ${JSON.stringify(name)})`);
      await run(page, `__mc.field(${JSON.stringify(field)}) && __mc.type(__mc.field(${JSON.stringify(field)}), ${JSON.stringify(value)})`);
      await run(page, `__mc.click(__mc.button("Save"))`);
      await until(page, `__mc.item(${JSON.stringify(name)})`, `the saved ${tool} profile`);
    }
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const groupTabs = [
      ["/echo/smoke/ping", "Ping"],
      ["/temporal/lab/orders/schedules", "Schedules"],
      ["/nats/edge/server", "Server"],
      ["/temporal/lab/orders/workflows/order-1/history", "order-1"],
      ["/langgraph/agents/threads", "Threads"],
      ["/nats/edge/streams", "Streams"],
      ["/echo/smoke/messages", "Messages"],
    ] as const;
    for (const [path, title] of groupTabs) {
      await page.navigate(`${origin}${path}`);
      await until(page, `location.pathname === ${JSON.stringify(path)} && ${selected(title)}`, `the tab of ${path}`);
      await savedTab(page, title, 15_000);
    }
    const stripItems = `[...document.querySelectorAll("[role=tablist][aria-label=Tabs] [data-slot=tabs-item]")]`;
    const tabCount = await run(page, `${stripItems}.length`);
    const savedTabs = await page.evaluate<number>(`new Promise((resolve) => { const o = indexedDB.open("mightyconsole"); o.onsuccess = () => { const g = o.result.transaction("workspace").objectStore("workspace").get("tabs"); g.onsuccess = () => { resolve(g.result?.tabs?.length ?? 0); o.result.close(); }; }; })`);
    check(savedTabs >= 10, `tab groups: ${savedTabs} tabs saved, the walk needs ten`);
    const groupValues = `${stripItems}.map((i) => i.dataset.value).filter((v) => v.startsWith("group:"))`;
    await until(page, `${groupValues}.join() === "group:echo,group:temporal,group:nats,group:langgraph"`, "four groups in the order of each tool's first tab");
    const moreHidden = `(() => { const more = document.querySelector("[data-slot=tabs-strip] [data-slot=dropdown-menu-trigger]"); return !more || more.hidden || !more.checkVisibility(); })()`;
    check((await run(page, moreHidden)) === true, `tab groups: ten tabs of four tools need "More tabs" at 1440 px (${String(tabCount)} items)`);
    if (process.env["MIGHTYCONSOLE_SHOTS"]) await page.screenshot(join(process.env["MIGHTYCONSOLE_SHOTS"], "tab-groups-echo.png"));
    // The Temporal chip opens Temporal on order-1, focused there last.
    const chip = (label: string) => `[...document.querySelectorAll("[role=tablist][aria-label=Tabs] [role=tab]")].find((t) => t.closest("[data-keep]") && t.querySelector(".sr-only")?.textContent === ${JSON.stringify(label)})`;
    await pressUntil(page, chip("Temporal"), `${selected("order-1")} && location.pathname === "/temporal/lab/orders/workflows/order-1/history"`, "the Temporal group open on its last focused tab");
    if (process.env["MIGHTYCONSOLE_SHOTS"]) await page.screenshot(join(process.env["MIGHTYCONSOLE_SHOTS"], "tab-groups-temporal.png"));
    await sleep(600);
    await page.navigate(`${origin}/`);
    await until(page, `${selected("order-1")} && ${groupValues}.join() === "group:echo,group:temporal,group:nats,group:langgraph"`, "the groups and the focused tab after a reload");
    // The tree follows the focused tab (TSK-111 batch 3): Temporal's navigation and tree after the
    // reload; the Echo chip brings Echo's tree back with its last focused tab's node selected, once
    // smoke has connected again (its resources show after the connect).
    const navOn = (tool: string) => `document.querySelector("[data-nav-item][aria-current=page]")?.dataset.tool === ${JSON.stringify(tool)}`;
    const rowSelected = (label: string) => `[...document.querySelectorAll("[role=treeitem][aria-selected=true]")].some((r) => r.textContent.includes(${JSON.stringify(label)}))`;
    await until(page, navOn("temporal"), "the navigation on Temporal after the reload");
    await pressUntil(page, chip("Echo"), `${navOn("echo")} && ${rowSelected("Messages")}`, "Echo's tree with Messages selected");
    if (process.env["MIGHTYCONSOLE_SHOTS"]) await page.screenshot(join(process.env["MIGHTYCONSOLE_SHOTS"], "tree-follows-echo.png"));
    await page.send("Emulation.clearDeviceMetricsOverride", {});
    // The Messages tab focused again, as the cold loads below expect.
    await page.navigate(`${origin}/echo/smoke/messages`);
    await until(page, selected("Messages · smoke"), "the Messages tab again");
    await sleep(600);


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

    // 6. Hash mode under a base path (DOC-21 §2.3, §3.7): a second server with --router hash
    // --base-path /tools/mc. `/` leads to the base path; the page, its assets and the WebSocket
    // are under it; the place is in the hash; a reload, an edited hash and Back keep it.
    const hashPort = await freePort();
    const hashOrigin = `https://localhost:${hashPort}`;
    // Its own data directory: a store is open in one server at a time.
    hashServer = spawn(serverBinary, ["--listen", `127.0.0.1:${hashPort}`, ...uiArgs, "--data", join(data, "hash-server"), "--router", "hash", "--base-path", "/tools/mc"], { stdio: ["ignore", "ignore", "pipe"] });
    await waitForLine(hashServer, /[\s\S]*open https:\/\/localhost:\d+\/tools\/mc\//, "mightyconsole-server --router hash");
    const errorsBefore = page.errors.length;
    await page.navigate(`${hashOrigin}/`);
    await until(page, `location.pathname === "/tools/mc/" && __mc.button("Echo")`, "the page under the base path");
    await run(page, `__mc.click(__mc.button("Echo"))`);
    await until(page, `__mc.has(${JSON.stringify(hashOrigin)})`, "app.info over /tools/mc/rpc/ws");
    await run(page, `__mc.click(__mc.button("Add connection"))`);
    await until(page, `__mc.field("Name")`, "the profile sheet (hash mode)");
    await run(page, `__mc.type(__mc.field("Name"), "smoke")`);
    await run(page, `__mc.click(__mc.button("Save"))`);
    await until(page, `__mc.item("smoke")`, "the saved profile (hash mode)");
    await run(page, `__mc.dblclick(__mc.item("smoke"))`);
    await until(page, `__mc.item("Ticks")`, "echo.connect (hash mode)");
    await run(page, `__mc.dblclick(__mc.item("Ticks"))`);
    await until(page, `location.hash === "#/echo/smoke/ticks" && location.pathname === "/tools/mc/"`, "the place in the hash");
    await run(page, `__mc.dblclick(__mc.item("Composer"))`);
    await until(page, `location.hash === "#/echo/smoke/compose" && ${selected("Composer")}`, "the Composer's place in the hash");
    await savedTab(page, "Composer", 15_000);
    // A reload keeps the hash: the restored page opens its place (the marker tells the pages apart).
    await run(page, `(window.__old = true)`);
    await page.send("Page.reload", {});
    await until(page, `!window.__old && ${selected("Composer")} && location.hash === "#/echo/smoke/compose"`, "the place after a reload (hash mode)");
    // An edited hash opens or focuses its tab; Back shows the entry before it.
    await run(page, `(location.hash = "#/echo/smoke/ticks", true)`);
    await until(page, `${selected("Ticks · smoke")}`, "the edited hash's tab");
    await run(page, `history.back()`);
    await until(page, `location.hash === "#/echo/smoke/compose" && ${selected("Composer")}`, "Back to the Composer (hash mode)");
    const hashRequests = page.requests.filter((url) => url.startsWith(`${hashOrigin}/`) || url.startsWith(`wss://localhost:${hashPort}/`));
    check(hashRequests.some((url) => url === `wss://localhost:${hashPort}/tools/mc/rpc/ws`), "hash mode: no WebSocket to /tools/mc/rpc/ws");
    const outside = hashRequests.filter((url) => url.startsWith(`${hashOrigin}/`) && url !== `${hashOrigin}/` && !url.startsWith(`${hashOrigin}/tools/mc/`));
    check(outside.length === 0, `hash mode: requests outside the base path: ${outside.join(", ")}`);
    check(page.errors.length === errorsBefore, `hash mode: errors in the page:\n  ${page.errors.slice(errorsBefore).join("\n  ")}`);
  } finally {
    hashServer?.kill();
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
    if (failures.length > 0) console.error(`browser-check: before the error:\n- ${failures.join("\n- ")}`);
    console.error(`browser-check: ${error instanceof Error ? error.stack : String(error)}`);
    process.exit(1);
  },
);
