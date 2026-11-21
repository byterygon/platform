#!/usr/bin/env node
// Tabs in the background, measured in a real browser (TSK-107, DOC-21 §3.2): three NATS Subscribe
// tabs live at 500 messages per second each, then the user moves to another tab and opens more.
// The page records the main thread's long tasks (over 50 ms), the frame intervals and the JS heap
// while the Subscribe tabs are in the background; the report is the same before and after a change
// when run with the same script on two builds of the UI (`--ui <dist>`).
//
//   MIGHTYCONSOLE_BENCH_NATS=nats://127.0.0.1:14222 [MIGHTYCONSOLE_BENCH_TEMPORAL=127.0.0.1:7233] node scripts/background-bench.ts [--ui dist] [--seconds 12] [--cpu 4] [--label after] [--strict]
//
// Needs a NATS server without authentication (the lab's `nats` profile uses credentials: start
// `nats-server -p 14222` or a container of the lab's image) and the same browser and server
// binary as scripts/browser-check.ts ($BYTERYGON_BROWSER, $MIGHTYCONSOLE_SERVER). Without
// $MIGHTYCONSOLE_BENCH_NATS the script is skipped (exit 0). `--strict` fails (exit 1) when a tab
// in the background does not stay quiet: long tasks above the DoD's budget or a frame p95 over
// 16 ms; the comparison "at least 90 percent fewer long tasks than before" is made by the person
// reading the two reports.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser } from "../../../../packages/ui/scripts/browser-check.ts";
import { type Cdp, type Page, freePort, launchBrowser, openPage, run, sleep, waitForLine, waitUntil } from "./cdp.ts";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REPO = join(APP, "..", "..", "..");
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const strict = process.argv.includes("--strict");
const seconds = Number(arg("seconds", "12"));
const label = arg("label", "run");
/** CPU slowdown of the page (1 = none): a laptop is several times slower than the machine that runs the check. */
const cpu = Number(arg("cpu", "4"));
const dist = arg("ui", join(APP, "dist"));
const natsUrl = process.env.MIGHTYCONSOLE_BENCH_NATS;
const temporalAddress = process.env.MIGHTYCONSOLE_BENCH_TEMPORAL;
const RATE_PER_SUBJECT = 500;
const SUBJECTS = ["bench.a", "bench.b", "bench.c"];

/** Publishes RATE_PER_SUBJECT messages a second on each subject over a plain NATS connection. */
function publisher(url: string) {
  const { hostname, port } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port) || 4222 });
  socket.on("error", () => {});
  socket.write('CONNECT {"verbose":false,"pedantic":false}\r\n');
  let sent = 0;
  const body = JSON.stringify({ order: 1, item: "bench", note: "x".repeat(60) });
  // 100 ticks a second, 5 messages per subject per tick.
  const timer = setInterval(() => {
    const perTick = RATE_PER_SUBJECT / 100;
    let out = "";
    for (const subject of SUBJECTS) for (let i = 0; i < perTick; i += 1) out += `PUB ${subject} ${body.length}\r\n${body}\r\n`;
    sent += SUBJECTS.length * perTick;
    socket.write(out);
  }, 10);
  return { stop: () => (clearInterval(timer), socket.destroy()), sent: () => sent };
}

const install = `(() => {
  window.__bench = { long: [], at: [], marks: [], frames: [], last: 0, on: false };
  new PerformanceObserver((list) => { if (window.__bench.on) for (const e of list.getEntries()) { window.__bench.long.push(e.duration); window.__bench.at.push(Math.round(e.startTime)); } }).observe({ entryTypes: ["longtask"] });
  const frame = (t) => { const b = window.__bench; if (b.on && b.last) b.frames.push(t - b.last); b.last = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
  return true;
})()`;

const percentile = (values: number[], p: number) => (values.length === 0 ? 0 : [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((values.length * p) / 100))]!);

async function press(page: Page, element: string) {
  await run(page, `(() => { const t = ${element}; if (!t) throw new Error("nothing to press"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`);
}

/** Opens or focuses the tab a URL names, inside the page (the router follows history). */
const go = (page: Page, path: string) => page.evaluate(`(() => { history.pushState({}, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate", { state: {} })); return true; })()`);

async function main(): Promise<number> {
  const browser = findBrowser();
  const serverBinary = process.env.MIGHTYCONSOLE_SERVER ?? join(REPO, "target", "debug", process.platform === "win32" ? "mightyconsole-server.exe" : "mightyconsole-server");
  if (!natsUrl || !browser || !existsSync(serverBinary) || !existsSync(join(dist, "index.html"))) {
    console.log(`background-bench: skipped, ${!natsUrl ? "MIGHTYCONSOLE_BENCH_NATS is not set" : !browser ? "no browser" : !existsSync(serverBinary) ? `no server binary at ${serverBinary}` : `no built UI at ${dist}`}`);
    return 0;
  }
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-bench-"));
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const server = spawn(serverBinary, ["--listen", `127.0.0.1:${port}`, "--ui", dist, "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  const feed = publisher(natsUrl);
  let log = "";
  server.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  try {
    await waitForLine(server, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
    ({ chrome, cdp } = await launchBrowser(browser, data));
    const page = await openPage(cdp);
    await page.navigate(`${origin}/`);
    if (cpu > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    const until = async (expression: string, what: string, timeoutMs = 30_000) => {
      if (!(await waitUntil(page, expression, timeoutMs))) throw new Error(`timed out waiting for ${what}; the page showed: ${await page.evaluate<string>(`document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)`)}; titles: ${await page.evaluate<string>(`[...document.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).filter(Boolean).join(" | ").slice(0, 600)`)}`);
    };
    await run(page, `(() => { return true; })()`);
    await page.evaluate(install);

    // A NATS profile without authentication, connected.
    await until(`__mc.button("NATS")`, "the tool navigation");
    await run(page, `__mc.click(__mc.button("NATS"))`);
    await until(`__mc.button("Add connection")`, "the NATS connection list");
    await run(page, `__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name") && __mc.field("Servers")`, "the NATS profile sheet");
    await run(page, `__mc.type(__mc.field("Name"), "bench")`);
    await run(page, `__mc.type(__mc.field("Servers"), ${JSON.stringify(natsUrl)})`);
    await run(page, `__mc.click(__mc.button("Save"))`);
    await until(`__mc.item("bench")`, "the saved profile");
    await run(page, `__mc.dblclick(__mc.item("bench"))`);
    await until(`__mc.item("Subjects")`, "the connection and its tree");

    // Three Subscribe tabs, each started: the router opens the tab a URL names.
    const panel = `document.querySelector("[role=tabpanel]:not([hidden])")`;
    const start = `[...${panel}.querySelectorAll("[role=toolbar] button")].find((b) => b.textContent.trim() === "Start")`;
    for (const subject of SUBJECTS) {
      await go(page, `/nats/bench/subscribe?subjects=${subject}`);
      await until(`[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes(${JSON.stringify(`Subscribe ${subject}`)}))`, `the ${subject} tab`);
      await until(`${start}`, `the ${subject} tab's Start`);
      await press(page, start);
      await until(`/[1-9][\\d,]* messages shown/.test(${panel}.textContent)`, `${subject} receiving`, 20_000);
    }
    // Moving on to a Temporal workflow that is followed (the lab's `fulfilment-long-running`, which
    // waits for a signal), when $MIGHTYCONSOLE_BENCH_TEMPORAL names a Temporal server; else the
    // NATS Server tab. Then more tabs open.
    const tabs: [string, string][] = [
      ["/nats/bench/server", "Server"],
      ["/nats/bench/streams", "Streams"],
      ["/nats/bench/kv", "Key-Value"],
      ["/nats/bench/services", "Services"],
    ];
    if (temporalAddress) {
      await run(page, `__mc.click(__mc.button("Temporal"))`);
      await until(`__mc.button("Add connection")`, "the Temporal connection list");
      await run(page, `__mc.click(__mc.button("Add connection"))`);
      await until(`__mc.field("Name") && __mc.field("Address") && __mc.field("Namespace")`, "the Temporal profile sheet");
      await run(page, `__mc.type(__mc.field("Name"), "bench-t")`);
      await run(page, `__mc.type(__mc.field("Address"), ${JSON.stringify(temporalAddress)})`);
      await run(page, `__mc.type(__mc.field("Namespace"), "lab")`);
      await run(page, `__mc.click(__mc.button("Save"))`);
      await until(`__mc.item("bench-t")`, "the saved Temporal profile");
      await run(page, `__mc.dblclick(__mc.item("bench-t"))`);
      await until(`/1 connection · 1 connected/.test(document.body.innerText)`, "the Temporal connection");
      tabs.unshift(["/temporal/bench-t/lab/workflows/fulfilment-long-running/timeline", "fulfilment-long-running"]);
    }
    await go(page, tabs[0]![0]);
    await until(`[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes(${JSON.stringify(tabs[0]![1])}))`, `the ${tabs[0]![1]} tab`);
    if (temporalAddress) await until(`document.body.innerText.includes("Following")`, "the workflow followed");
    await page.evaluate(`(() => { const b = window.__bench; b.long.length = 0; b.at.length = 0; b.marks.length = 0; b.frames.length = 0; b.last = 0; b.on = true; return true; })()`);
    await page.send("Performance.enable");
    const metric = async (name: string) => ((await page.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.find((m) => m.name === name)?.value ?? 0;
    const task0 = await metric("TaskDuration");
    const script0 = await metric("ScriptDuration");
    const heap0 = await page.evaluate<number>("performance.memory ? performance.memory.usedJSHeapSize : 0");
    const started = Date.now();
    // Open more tabs while the three Subscribe tabs are in the background.
    for (const [path, title] of tabs.slice(1)) {
      await sleep((seconds * 1000) / tabs.length);
      await page.evaluate(`window.__bench.marks.push([${JSON.stringify(title)}, Math.round(performance.now())])`);
      await go(page, path);
      await until(`[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes(${JSON.stringify(title)}))`, `the ${title} tab`);
    }
    await sleep(Math.max(0, seconds * 1000 - (Date.now() - started)));
    const measured = await page.evaluate<{ long: number[]; at: number[]; marks: [string, number][]; frames: number[] }>(`(() => { const b = window.__bench; b.on = false; return { long: b.long, at: b.at, marks: b.marks, frames: b.frames }; })()`);
    const taskSeconds = (await metric("TaskDuration")) - task0;
    const scriptSeconds = (await metric("ScriptDuration")) - script0;
    const heap1 = await page.evaluate<number>("performance.memory ? performance.memory.usedJSHeapSize : 0");

    // Back on a Subscribe tab: it has caught up.
    await go(page, `/nats/bench/subscribe?subjects=${SUBJECTS[0]}`);
    await until(`[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes("Subscribe bench.a"))`, "the first Subscribe tab shown again");
    const startCatch = Date.now();
    await sleep(2000);
    const shown = await page.evaluate<string>(`(${panel}.querySelector("[data-slot=message-viewer-status]")?.textContent ?? "").replace(/\\s+/g, " ")`);
    const catchUpMs = Date.now() - startCatch;

    const report = {
      label,
      seconds,
      cpuSlowdown: cpu,
      publishedPerSecond: Math.round(feed.sent() / ((Date.now() - started) / 1000 + 0)) || 0,
      longTasks: measured.long.length,
      longTaskTotalMs: Math.round(measured.long.reduce((a, b) => a + b, 0)),
      // Long tasks that are not the opening of a tab (a tab's first render is a long task at 6x slowdown in either build).
      longTasksOutsideTabOpens: measured.at.filter((t) => !measured.marks.some(([, m]) => t >= m - 50 && t <= m + 400)).length,
      mainThreadBusyPercent: Number(((taskSeconds / seconds) * 100).toFixed(1)),
      scriptPercent: Number(((scriptSeconds / seconds) * 100).toFixed(1)),
      longTaskAt: measured.long.map((d, i) => `${measured.at[i]} (${Math.round(d)} ms)`),
      tabOpenedAt: measured.marks.map(([t, at]) => `${t} ${at}`),
      longTaskMaxMs: Math.round(Math.max(0, ...measured.long)),
      frames: measured.frames.length,
      frameP50Ms: Number(percentile(measured.frames, 50).toFixed(1)),
      frameP95Ms: Number(percentile(measured.frames, 95).toFixed(1)),
      heapMiB: { before: Number((heap0 / 1048576).toFixed(1)), after: Number((heap1 / 1048576).toFixed(1)) },
      firstTabAfterShow: shown,
      shownAgainWithinMs: catchUpMs,
      errors: page.errors.slice(0, 5),
    };
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(join(data, `background-bench-${label}.json`), JSON.stringify(report, null, 2));
    console.log(`background-bench: wrote ${join(data, `background-bench-${label}.json`)}`);
    if (strict) {
      const problems: string[] = [];
      if (report.longTasks > 2) problems.push(`${report.longTasks} long tasks in ${seconds} s with the Subscribe tabs in the background (budget 2)`);
      if (report.frameP95Ms > 16.7) problems.push(`frame p95 ${report.frameP95Ms} ms (budget 16.7)`);
      if (problems.length > 0) {
        console.error(`background-bench: ${problems.join("; ")}`);
        return 1;
      }
    }
    return 0;
  } catch (error) {
    if (log) console.error(`background-bench: the server said:\n${log.slice(-1500)}`);
    throw error;
  } finally {
    feed.stop();
    cdp?.close();
    chrome?.kill();
    server.kill();
  }
}

process.exit(await main().catch((error) => (console.error(`background-bench: ${error instanceof Error ? error.message : String(error)}`), 1)));
