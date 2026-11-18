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
//
// MIGHTYCONSOLE_EMBEDDED_UI=1 checks a release binary (TSK-87) instead: no Vite build and no
// --ui, so the page and every asset come from the UI compiled into the binary.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
