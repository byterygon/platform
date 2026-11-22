#!/usr/bin/env node
// Long Temporal histories, measured in a real browser (TSK-109, DOC-21 §9.3): the lab's
// `history-many-1` (about 48,000 events), `history-heavy-1` (about 46 MiB in 40 KiB payloads) and
// `history-follow-1` (a running run with 20,000 events that grows by an activity every 2 s).
// For each: the time until History shows its first rows, until it stops loading, the JS heap, the
// main thread's long tasks while History and then the Timeline are scrolled, the largest
// WebSocket frame, and the errors the page or the server showed; for the followed run, the main
// thread's time per new event. Run it on two builds of the UI (`--ui <dist>`) with the same server
// binary for a before and after.
//
//   MIGHTYCONSOLE_BENCH_TEMPORAL=127.0.0.1:7233 node scripts/history-bench.ts [--ui dist] [--cpu 1] [--follow-seconds 20] [--only many,heavy,follow] [--label after] [--strict]
//
// Needs the lab's `temporal` profile seeded (`lab up temporal`: the seed builds the histories) and
// the browser and server binary of scripts/browser-check.ts ($BYTERYGON_BROWSER,
// $MIGHTYCONSOLE_SERVER). Without $MIGHTYCONSOLE_BENCH_TEMPORAL it is skipped (exit 0). `--strict`
// fails (exit 1) past the DoD's budgets: first rows in 2 s, a heap of 400 MiB, a long task of
// 100 ms while scrolling, any frame or page error, and a cost per followed event that grows.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
const label = arg("label", "run");
const cpu = Number(arg("cpu", "1"));
const followSeconds = Number(arg("follow-seconds", "20"));
const only = new Set(arg("only", "many,heavy,follow").split(","));
const dist = arg("ui", join(APP, "dist"));
const temporalAddress = process.env.MIGHTYCONSOLE_BENCH_TEMPORAL;

/** The DoD's budgets (TSK-109); the first measurement may correct them, the task page says why. */
const BUDGET = { firstRowsMs: 2000, heapMiB: 400, scrollLongTaskMs: 100 };

const install = `(() => {
  window.__bench = { long: [], on: false };
  new PerformanceObserver((list) => { if (window.__bench.on) for (const e of list.getEntries()) window.__bench.long.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] });
  return true;
})()`;
const benchOn = `(() => { window.__bench.long.length = 0; window.__bench.on = true; return true; })()`;
const benchOff = `(() => { window.__bench.on = false; return window.__bench.long.slice(); })()`;

/** Opens or focuses the tab a URL names, inside the page (the router follows history). */
const go = (page: Page, path: string) => page.evaluate(`(() => { history.pushState({}, "", ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent("popstate", { state: {} })); return true; })()`);

const historyRows = `(document.querySelector('[aria-label="History events"]')?.querySelectorAll("tbody tr:not([data-spacer])").length ?? 0)`;
/** "48,000 of 48,000 events loaded" in the History footer, as numbers. */
const footer = `(() => { const m = /([\\d,]+) of ([\\d,]+) events loaded/.exec(document.body.innerText); return m ? [Number(m[1].replace(/,/g, "")), Number(m[2].replace(/,/g, ""))] : null; })()`;
const alerts = `[...document.querySelectorAll("[role=alert]")].map((e) => e.textContent.replace(/\\s+/g, " ").trim()).filter(Boolean)`;

interface Scenario {
  workflowId: string;
  firstRowsMs: number | null;
  settledMs: number | null;
  loaded: [number, number] | null;
  heapMiB: number;
  historyScroll: { longTasks: number; maxMs: number };
  timeline: { shownMs: number | null; longTasks: number; maxMs: number };
  heapAfterMiB: number;
  alerts: string[];
  follow?: { seconds: number; newEvents: number; mainThreadMs: number; msPerEvent: number | null; longTasks: number; maxMs: number };
}

async function main(): Promise<number> {
  const browser = findBrowser();
  const serverBinary = process.env.MIGHTYCONSOLE_SERVER ?? join(REPO, "target", "debug", process.platform === "win32" ? "mightyconsole-server.exe" : "mightyconsole-server");
  if (!temporalAddress || !browser || !existsSync(serverBinary) || !existsSync(join(dist, "index.html"))) {
    console.log(`history-bench: skipped, ${!temporalAddress ? "MIGHTYCONSOLE_BENCH_TEMPORAL is not set" : !browser ? "no browser" : !existsSync(serverBinary) ? `no server binary at ${serverBinary}` : `no built UI at ${dist}`}`);
    return 0;
  }
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-history-bench-"));
  const port = await freePort();
  const origin = `https://localhost:${port}`;
  const server = spawn(serverBinary, ["--listen", `127.0.0.1:${port}`, "--ui", dist, "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let chrome: ChildProcess | undefined;
  let cdp: Cdp | undefined;
  let log = "";
  server.stderr!.on("data", (chunk: Buffer) => (log += chunk.toString()));
  // The largest WebSocket frame the page received, and how many were over 4 MiB.
  const frames = { max: 0, over4MiB: 0, count: 0 };
  try {
    await waitForLine(server, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
    ({ chrome, cdp } = await launchBrowser(browser, data));
    cdp.on((m) => {
      if (m.method !== "Network.webSocketFrameReceived") return;
      const response = m.params!["response"] as { opcode: number; payloadData: string };
      // Binary frames come base64 encoded.
      const bytes = response.opcode === 2 ? Math.floor((response.payloadData.length * 3) / 4) : response.payloadData.length;
      frames.count += 1;
      frames.max = Math.max(frames.max, bytes);
      if (bytes > 4 * 1048576) frames.over4MiB += 1;
    });
    const page = await openPage(cdp);
    await page.navigate(`${origin}/`);
    if (cpu > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    await page.send("Performance.enable");
    const metric = async (name: string) => ((await page.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] }).metrics.find((m) => m.name === name)?.value ?? 0;
    const heap = async () => {
      await page.send("HeapProfiler.collectGarbage").catch(() => undefined);
      return Number(((await page.evaluate<number>("performance.memory ? performance.memory.usedJSHeapSize : 0")) / 1048576).toFixed(1));
    };
    const until = async (expression: string, what: string, timeoutMs = 30_000) => {
      if (!(await waitUntil(page, expression, timeoutMs))) throw new Error(`timed out waiting for ${what}; the page showed: ${await page.evaluate<string>(`document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)`)}`);
    };
    await page.evaluate(install);

    await until(`__mc.button("Temporal")`, "the tool navigation");
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

    const scenarios: Record<string, Scenario> = {};
    const plan: [string, string][] = [
      ["many", "history-many-1"],
      ["heavy", "history-heavy-1"],
      ["follow", "history-follow-1"],
    ];
    for (const [name, workflowId] of plan.filter(([n]) => only.has(n))) {
      const t0 = Date.now();
      await go(page, `/temporal/bench-t/lab/workflows/${workflowId}/history`);
      // The first rows, or what the page says instead (an error, a crash).
      const shown = await waitUntil(page, `${historyRows} > 0 || ${alerts}.length > 0`, 120_000);
      const firstRowsMs = shown && (await page.evaluate<number>(historyRows)) > 0 ? Date.now() - t0 : null;
      // Settled: the footer's count has not moved for 2 s (or 120 s passed).
      let last = "";
      let still = Date.now();
      while (Date.now() - t0 < 120_000) {
        const now = JSON.stringify(await page.evaluate(footer).catch(() => null));
        if (now !== last) {
          last = now;
          still = Date.now();
        } else if (Date.now() - still >= 2000) break;
        await sleep(200);
      }
      const settledMs = still - t0;
      const loaded = await page.evaluate<[number, number] | null>(footer).catch(() => null);
      const heapMiB = await heap();

      // Scroll History from top to bottom, a few rows at a time, as a person would with the wheel.
      await page.evaluate(benchOn);
      for (let i = 0; i < 60; i += 1) {
        await page.evaluate(`(() => { const t = document.querySelector('[aria-label="History events"]'); if (t) { t.scrollTop += t.clientHeight * 2; t.dispatchEvent(new Event("scroll")); } return true; })()`);
        await sleep(50);
      }
      await sleep(500);
      const scrollLong = await page.evaluate<number[]>(benchOff);

      // The Timeline of the same run, then a pan through its lanes.
      const t1 = Date.now();
      await page.evaluate(benchOn);
      await go(page, `/temporal/bench-t/lab/workflows/${workflowId}/timeline`);
      const timelineShown = await waitUntil(page, `document.querySelector("[data-slot=timeline-lanes]")`, 60_000);
      const timelineMs = timelineShown ? Date.now() - t1 : null;
      for (let i = 0; i < 30; i += 1) {
        await page.evaluate(`(() => { const t = document.querySelector("[data-slot=timeline-lanes]"); if (t) { t.scrollTop += t.clientHeight * 2; t.dispatchEvent(new Event("scroll")); } return true; })()`);
        await sleep(50);
      }
      await sleep(500);
      const timelineLong = await page.evaluate<number[]>(benchOff);

      const scenario: Scenario = {
        workflowId,
        firstRowsMs,
        settledMs,
        loaded,
        heapMiB,
        historyScroll: { longTasks: scrollLong.length, maxMs: Math.max(0, ...scrollLong) },
        timeline: { shownMs: timelineMs, longTasks: timelineLong.length, maxMs: Math.max(0, ...timelineLong) },
        heapAfterMiB: await heap(),
        alerts: await page.evaluate<string[]>(alerts),
      };

      if (name === "follow") {
        // Back on History while the run grows: the main thread's time per event that came in.
        await go(page, `/temporal/bench-t/lab/workflows/${workflowId}/history`);
        await until(`${historyRows} > 0`, "the followed History");
        await until(`document.body.innerText.includes("Following")`, "the run followed", 60_000);
        const before = await page.evaluate<[number, number] | null>(footer);
        const task0 = await metric("TaskDuration");
        await page.evaluate(benchOn);
        await sleep(followSeconds * 1000);
        const followLong = await page.evaluate<number[]>(benchOff);
        const mainThreadMs = Math.round(((await metric("TaskDuration")) - task0) * 1000);
        const after = await page.evaluate<[number, number] | null>(footer);
        const newEvents = before && after ? after[0] - before[0] : 0;
        scenario.follow = { seconds: followSeconds, newEvents, mainThreadMs, msPerEvent: newEvents > 0 ? Number((mainThreadMs / newEvents).toFixed(1)) : null, longTasks: followLong.length, maxMs: Math.max(0, ...followLong) };
      }
      scenarios[name] = scenario;
      // Close the tab, so the next run starts from the same memory.
      await page.evaluate(`(() => { const t = [...document.querySelectorAll("[role=tab][aria-selected=true]")].find((x) => x.textContent.includes(${JSON.stringify(workflowId)})); t?.querySelector("[aria-label^=Close]")?.click(); return true; })()`);
      await sleep(1000);
    }

    const report = { label, cpuSlowdown: cpu, scenarios, frames: { count: frames.count, maxMiB: Number((frames.max / 1048576).toFixed(2)), over4MiB: frames.over4MiB }, pageErrors: page.errors.slice(0, 8), serverErrors: log.split("\n").filter((l) => /error|exceed|limit/i.test(l)).slice(0, 8) };
    console.log(JSON.stringify(report, null, 2));
    writeFileSync(join(data, `history-bench-${label}.json`), JSON.stringify(report, null, 2));
    console.log(`history-bench: wrote ${join(data, `history-bench-${label}.json`)}`);
    if (strict) {
      const problems: string[] = [];
      for (const [name, s] of Object.entries(scenarios)) {
        if (s.firstRowsMs === null || s.firstRowsMs > BUDGET.firstRowsMs) problems.push(`${name}: first rows ${s.firstRowsMs ?? "never"} ms (budget ${BUDGET.firstRowsMs})`);
        if (Math.max(s.heapMiB, s.heapAfterMiB) > BUDGET.heapMiB) problems.push(`${name}: heap ${Math.max(s.heapMiB, s.heapAfterMiB)} MiB (budget ${BUDGET.heapMiB})`);
        if (s.historyScroll.maxMs > BUDGET.scrollLongTaskMs) problems.push(`${name}: a ${s.historyScroll.maxMs} ms task while History scrolled (budget ${BUDGET.scrollLongTaskMs})`);
        if (s.timeline.maxMs > BUDGET.scrollLongTaskMs) problems.push(`${name}: a ${s.timeline.maxMs} ms task on the Timeline (budget ${BUDGET.scrollLongTaskMs})`);
        if (s.alerts.length > 0) problems.push(`${name}: the page said ${s.alerts.join(" | ")}`);
      }
      if (report.pageErrors.length > 0) problems.push(`page errors: ${report.pageErrors.join(" | ")}`);
      if (problems.length > 0) {
        console.error(`history-bench: ${problems.join("; ")}`);
        return 1;
      }
    }
    return 0;
  } catch (error) {
    if (log) console.error(`history-bench: the server said:\n${log.slice(-1500)}`);
    throw error;
  } finally {
    cdp?.close();
    chrome?.kill();
    server.kill();
  }
}

process.exit(await main().catch((error) => (console.error(`history-bench: ${error instanceof Error ? error.message : String(error)}`), 1)));
