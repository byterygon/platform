#!/usr/bin/env node
// Mightyconsole acceptance harness (TSK-87): runs a build task's acceptance checklist (spec
// section 18, one file per task in checklists/) against the test lab with one command, prints a
// verdict per item and saves the evidence: every check's output, screenshots of the UI from a
// headless browser, the lab's check, the environment, and summary.md to paste into the PR.
//
//   pnpm --filter @byterygon/mightyconsole acceptance <checklist…|all> [options]
//   node apps/mightyconsole/acceptance/acceptance.mts docker --lab-up
//
//   --list            the checklists and their items, nothing run
//   --only ID[,ID]    only these items (their ids, as --list prints them)
//   --lab-up          start the lab profiles the checklist needs when they are not up
//   --server PATH     the mightyconsole-server to run (default: target/debug, built when missing);
//                     a release binary serves its built-in UI, a debug one is given ui/dist
//   --strict          skipped items fail the run too (CI and closing a task)
//   --out DIR         where the evidence goes (default: apps/mightyconsole/acceptance/evidence)
//
// Verdicts: PASS; FAIL; MANUAL (the automatic checks passed, a person checks the rest and links it);
// NOT WIRED (the item has no check yet; fails the run once the task's code is in); SKIPPED (its
// task's code is not in yet, or the lab, the browser or a required program is missing, with the
// reason). The exit code is 1 when anything failed or is not wired (or, with --strict, skipped).
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { BrowserContext, Check, Checklist, Item } from "./checklist.mts";

export const ACCEPTANCE = dirname(fileURLToPath(import.meta.url));
export const APP = resolve(ACCEPTANCE, "..");
export const REPO = resolve(APP, "..", "..");
const UI = join(APP, "ui");
const LAB = join(APP, "lab");

export type Verdict = "pass" | "fail" | "manual" | "not-wired" | "skipped";

export interface CheckResult {
  label: string;
  verdict: Verdict;
  detail: string;
  /** Evidence files, relative to the run's folder. */
  evidence: string[];
  ms: number;
}

export interface ItemResult {
  checklist: string;
  id: string;
  text: string;
  verdict: Verdict;
  reason: string;
  checks: CheckResult[];
}

// ---------------------------------------------------------------------------------------------
// Checklists

/** Every checklist in checklists/, in the order of the spec's section 18. */
export async function loadChecklists(dir = join(ACCEPTANCE, "checklists")): Promise<Checklist[]> {
  const order = ["foundation", "messaging", "nats", "kafka", "k8s", "temporal", "temporal-more", "temporal-detail", "docker", "langgraph", "packaging"];
  const files = readdirSync(dir).filter((f) => f.endsWith(".mts"));
  const lists: Checklist[] = [];
  for (const file of files) lists.push(((await import(pathToFileURL(join(dir, file)).href)) as { default: Checklist }).default);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return lists.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** Problems in the checklists' shape: ids, texts, checks. */
export function validate(lists: readonly Checklist[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const list of lists) {
    if (ids.has(list.id)) problems.push(`${list.id}: two checklists with this id`);
    ids.add(list.id);
    if (!/^TSK-\d+$/.test(list.task)) problems.push(`${list.id}: task "${list.task}" is not TSK-<n>`);
    if (list.items.length === 0) problems.push(`${list.id}: no items`);
    const items = new Set<string>();
    for (const item of list.items) {
      if (!/^[a-z0-9-]+$/.test(item.id)) problems.push(`${list.id}/${item.id}: ids are lowercase words with dashes`);
      if (items.has(item.id)) problems.push(`${list.id}/${item.id}: duplicate item id`);
      items.add(item.id);
      if (item.text.trim().length === 0) problems.push(`${list.id}/${item.id}: no text`);
      if (item.lab && list.lab.length === 0) problems.push(`${list.id}/${item.id}: a lab item in a checklist without lab profiles`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Running checks

interface Run {
  dir: string;
  logs: string;
  shots: string;
  strict: boolean;
  serverPath: string | null;
  /** Starts the server and the browser once per run, on the first browser check. */
  browser: () => Promise<BrowserSession | { skipped: string }>;
  lab: Record<string, unknown> | null;
}

interface BrowserSession {
  context: (item: string, record: (file: string) => void) => Promise<BrowserContext>;
  close: () => Promise<void>;
}

const onPath = (program: string) =>
  (process.env["PATH"] ?? "").split(delimiter).some((dir) => existsSync(join(dir, program)) || existsSync(join(dir, `${program}.exe`)) || existsSync(join(dir, `${program}.cmd`)));

/** Runs a program, its output to `log`; the exit code and the output. */
function execute(argv: string[], options: { cwd?: string; env?: Record<string, string>; log: string }): { code: number; output: string } {
  const [program, ...args] = argv;
  const result = spawnSync(program!, args, {
    cwd: options.cwd ?? REPO,
    // Plain output in the logs, also where CI forces colours.
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CARGO_TERM_COLOR: "never", ...options.env },
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const output = `$ ${argv.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}` : ""}`;
  writeFileSync(options.log, output);
  return { code: result.status ?? 1, output };
}

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** The number of tests that passed in cargo's or Vitest's output, and whether any failed. */
export function countTests(raw: string): { passed: number; failed: number } {
  // CI forces colours on (GitHub Actions); the counts are read without the escape codes.
  // eslint-disable-next-line no-control-regex -- ANSI escape sequences
  const output = raw.replace(/\u001b\[[0-9;]*m/g, "");
  let passed = 0;
  let failed = 0;
  for (const m of output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)) {
    passed += Number(m[1]);
    failed += Number(m[2]);
  }
  const vitest = /^\s*Tests\s+(.*)$/m.exec(output);
  if (vitest) {
    passed += Number(/(\d+) passed/.exec(vitest[1]!)?.[1] ?? 0);
    failed += Number(/(\d+) failed/.exec(vitest[1]!)?.[1] ?? 0);
  }
  return { passed, failed };
}

/**
 * Command checks already run in this evidence run (TSK-121): the same command (argv, folder and
 * environment) runs once, and a later check naming it again takes its verdict and points to its log.
 * browser-check is one command named by three items (foundation/shell, foundation/csp-offline,
 * messaging/arrow): it ran three times a lab run, about 50 s each, and each run could fail alone.
 */
const commandsRun = new Map<string, { verdict: Verdict; detail: string; log: string; item: string }>();

async function runCheck(check: Check, item: string, n: number, run: Run): Promise<CheckResult> {
  const started = Date.now();
  const log = join(run.logs, `${item}-${n}.log`);
  const evidence = [relative(run.dir, log)];
  const done = (verdict: Verdict, detail: string, files = evidence): CheckResult => ({
    label: labelOf(check),
    verdict,
    detail,
    evidence: files,
    ms: Date.now() - started,
  });
  const substitute = (arg: string) =>
    arg.replaceAll("{evidence}", run.dir).replaceAll("{repo}", REPO).replaceAll("{server}", run.serverPath ?? "target/debug/mightyconsole-server").replaceAll("{ui}", UI);

  switch (check.kind) {
    case "manual":
      return done("manual", "a person checks this and links it in the PR", []);
    case "cargo":
    case "vitest": {
      // `--tests`: the library's unit tests and every integration test, no doc-tests. Without it
      // cargo also runs rustdoc for the doc-tests (none in this crate), about 3 s of every check
      // (TSK-120: 185 single-test checks cost 1,047 s in one lab run). A check that names a
      // doc-test would need `--doc` instead, and fails with "no test matched" until it has it.
      const argv =
        check.kind === "cargo"
          ? ["cargo", "test", "-p", "mightyconsole-server", "--locked", "--tests", ...(check.features?.length ? ["--features", check.features.join(",")] : []), "--", check.filter]
          : ["pnpm", "exec", "vitest", "run", check.file, ...(check.name ? ["-t", check.name] : [])];
      const { code, output } = execute(argv, { cwd: check.kind === "vitest" ? UI : REPO, log });
      const { passed, failed } = countTests(output);
      if (code !== 0 || failed > 0) return done("fail", `${failed} failed${code !== 0 ? `, exit ${code}` : ""}`);
      if (passed === 0) return done("fail", "no test matched");
      return done("pass", `${passed} passed`);
    }
    case "command": {
      const missing = (check.requires ?? []).filter((p) => !onPath(p));
      if (missing.length > 0) return done("skipped", `needs ${missing.join(", ")} on PATH`, []);
      const argv = check.argv.map(substitute);
      const cwd = check.cwd ? resolve(REPO, check.cwd) : REPO;
      const env = Object.fromEntries(Object.entries(check.env ?? {}).map(([k, v]) => [k, substitute(v)]));
      const key = JSON.stringify([run.dir, argv, cwd, env]);
      const earlier = commandsRun.get(key);
      if (earlier) {
        writeFileSync(log, `$ ${argv.join(" ")}\nThe same command already ran for ${earlier.item} in this run: ${earlier.log}\n`);
        return done(earlier.verdict, `${earlier.detail}, the same run as ${earlier.item}`, [earlier.log, relative(run.dir, log)]);
      }
      const { code } = execute(argv, { cwd, env, log });
      const verdict: Verdict = code === 0 ? "pass" : "fail";
      commandsRun.set(key, { verdict, detail: `exit ${code}`, log: relative(run.dir, log), item });
      return done(verdict, `exit ${code}`);
    }
    case "server": {
      if (!run.serverPath) return done("skipped", "no server binary", []);
      const data = mkdtempSync(join(tmpdir(), "mightyconsole-acceptance-"));
      try {
        const { output, exited } = await startServer(run.serverPath, [...check.args, "--data", data]);
        writeFileSync(log, `$ ${run.serverPath} ${check.args.join(" ")} --data <temporary>\n${output}`);
        const missingLines = check.expect.filter((re) => !re.test(output));
        if (exited !== null) return done("fail", `the server exited (${exited})`);
        return done(missingLines.length === 0 ? "pass" : "fail", missingLines.length === 0 ? "startup lines as expected" : `missing: ${missingLines.map(String).join(", ")}`);
      } finally {
        rmSync(data, { recursive: true, force: true });
      }
    }
    case "browser": {
      const session = await run.browser();
      if ("skipped" in session) return done("skipped", session.skipped, []);
      const files: string[] = [];
      try {
        const ctx = await session.context(item, (file) => files.push(relative(run.dir, file)));
        await check.run(ctx);
        const errors = ctx.page.errors;
        if (errors.length > 0) {
          writeFileSync(log, errors.join("\n"));
          return done("fail", `errors in the page: ${errors[0]}`, [...files, relative(run.dir, log)]);
        }
        writeFileSync(log, `requests:\n${ctx.page.requests.join("\n")}\n`);
        return done("pass", `${files.length} screenshot${files.length === 1 ? "" : "s"}`, [...files, relative(run.dir, log)]);
      } catch (error) {
        writeFileSync(log, error instanceof Error ? (error.stack ?? error.message) : String(error));
        return done("fail", error instanceof Error ? error.message.split("\n")[0]! : String(error), [...files, relative(run.dir, log)]);
      }
    }
  }
}

const labelOf = (check: Check): string => {
  switch (check.kind) {
    case "cargo":
      return check.label ?? `cargo test ${check.features?.length ? `--features ${check.features.join(",")} ` : ""}-- ${check.filter}`;
    case "vitest":
      return check.label ?? `vitest ${check.file}${check.name ? ` -t "${check.name}"` : ""}`;
    default:
      return check.label;
  }
};

/** Starts the server, collects stderr until it says where to open it (or exits), then stops it. */
async function startServer(binary: string, args: string[]): Promise<{ output: string; exited: number | null; child?: ChildProcess }> {
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"] });
  let output = "";
  const exited = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => done(null), 30_000);
    child.stderr!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (/open https:\/\/\S+\//.test(output)) {
        clearTimeout(timer);
        done(null);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code ?? 1);
    });
  });
  child.kill();
  return { output, exited };
}

/** One item: its checks in order; the verdict is the worst of them. */
async function runItem(list: Checklist, item: Item, run: Run, labUp: boolean, labReason: string): Promise<ItemResult> {
  const base = { checklist: list.id, id: item.id, text: item.text };
  if (item.checks.length === 0) return { ...base, verdict: "not-wired", reason: `no check yet: ${list.task} wires it in checklists/${list.id}.mts`, checks: [] };
  // MIGHTYCONSOLE_LAB_REQUIRED=1 (the lab workflow, which brought the lab up and checked it): a lab
  // that no longer answers fails its items instead of skipping them (TSK-121).
  if (item.lab && !labUp) return { ...base, verdict: process.env.MIGHTYCONSOLE_LAB_REQUIRED === "1" ? "fail" : "skipped", reason: labReason, checks: [] };
  const checks: CheckResult[] = [];
  for (const [n, check] of item.checks.entries()) {
    const result = await runCheck(check, `${list.id}-${item.id}`, n + 1, run);
    checks.push(result);
    console.log(`        ${tag(result.verdict)} ${result.label} (${result.detail}, ${(result.ms / 1000).toFixed(1)} s)`);
  }
  const verdict = checks.some((c) => c.verdict === "fail")
    ? "fail"
    : checks.some((c) => c.verdict === "skipped")
      ? "skipped"
      : checks.some((c) => c.verdict === "manual")
        ? "manual"
        : "pass";
  const reason = checks
    .filter((c) => c.verdict === verdict && verdict !== "pass")
    .map((c) => `${c.label}: ${c.detail}`)
    .join("; ");
  return { ...base, verdict, reason, checks };
}

const TAGS: Record<Verdict, string> = { pass: "PASS     ", fail: "FAIL     ", manual: "MANUAL   ", "not-wired": "NOT WIRED", skipped: "SKIPPED  " };
const tag = (v: Verdict) => TAGS[v];

// ---------------------------------------------------------------------------------------------
// The lab, the server and the browser

/**
 * `lab check` for the profiles, once more when it fails (TSK-121: the tools container once crashed
 * with exit 139 after printing that its checks passed, and all 8 temporal-more items were skipped).
 */
function labCheck(profiles: string[], log: string): boolean {
  const argv = ["node", join(LAB, "lab.mts"), "check", ...profiles];
  return execute(argv, { log }).code === 0 || execute(argv, { log: log.replace(/\.log$/, "-again.log") }).code === 0;
}

function labCredentials(): Record<string, unknown> | null {
  const file = join(LAB, ".generated", "credentials.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : null;
}

async function openBrowser(run: Run): Promise<BrowserSession | { skipped: string }> {
  const { findBrowser } = await import("../../../packages/ui/scripts/browser-check.ts");
  const cdpModule = await import("../ui/scripts/cdp.ts");
  const chromePath = findBrowser();
  if (!chromePath) return { skipped: "no browser (set BYTERYGON_BROWSER)" };
  if (!run.serverPath) return { skipped: "no server binary" };
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-acceptance-"));
  const port = await cdpModule.freePort();
  const origin = `https://localhost:${port}`;
  // The Temporal codec endpoint on plain loopback HTTP, for the temporal CLI (TSK-103).
  const codecPort = await cdpModule.freePort();
  const codecOrigin = `http://127.0.0.1:${codecPort}`;
  // A release binary serves its built-in UI; otherwise build ui/dist and give it.
  let child = spawn(run.serverPath, ["--listen", `127.0.0.1:${port}`, "--codec-listen", `127.0.0.1:${codecPort}`, "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let [startup] = await cdpModule.waitForLine(child, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
  if (!/UI built in/.test(startup ?? "")) {
    child.kill();
    const build = execute(["pnpm", "--filter", "@byterygon/mightyconsole", "build"], { log: join(run.logs, "ui-build.log") });
    if (build.code !== 0) return { skipped: "the UI does not build (logs/ui-build.log)" };
    child = spawn(run.serverPath, ["--listen", `127.0.0.1:${port}`, "--codec-listen", `127.0.0.1:${codecPort}`, "--ui", join(UI, "dist"), "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
    [startup] = await cdpModule.waitForLine(child, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
  }
  writeFileSync(join(run.logs, "browser-server.log"), startup ?? "");
  const { chrome, cdp } = await cdpModule.launchBrowser(chromePath, data);
  return {
    async context(item, record) {
      const page = await cdpModule.openPage(cdp);
      let shots = 0;
      return {
        page,
        origin,
        codecOrigin,
        lab: run.lab,
        run: <T,>(expression: string) => cdpModule.run(page, expression) as Promise<T>,
        async until(expression, what, timeoutMs) {
          if (await cdpModule.waitUntil(page, expression, timeoutMs)) return;
          // What the page showed and a screenshot, so a timeout in CI says more than its name (TSK-121).
          const shown = await page.evaluate<string>(`location.pathname + location.search + " | " + document.body.innerText.replace(/\\s+/g, " ").slice(0, 400)`).catch(() => "");
          shots += 1;
          const file = join(run.shots, `${item}-${String(shots).padStart(2, "0")}-timeout-${slug(what)}.png`);
          await page.screenshot(file).then(() => record(file), () => {});
          throw new Error(`timed out waiting for ${what}; the page: ${shown}`);
        },
        async shot(name) {
          // Let finite transitions (a theme switch, a sheet opening) settle; never wait on a spinner.
          await cdpModule.waitUntil(page, `document.getAnimations().every((a) => a.playState !== "running" || a.effect?.getTiming().iterations === Infinity)`, 2_000);
          shots += 1;
          const file = join(run.shots, `${item}-${String(shots).padStart(2, "0")}-${slug(name)}.png`);
          await page.screenshot(file);
          record(file);
        },
      };
    },
    async close() {
      cdp.close();
      chrome.kill();
      child.kill();
      await cdpModule.sleep(200);
      rmSync(data, { recursive: true, force: true });
    },
  };
}

function serverBinary(explicit: string | undefined, logs: string): string | null {
  if (explicit) return existsSync(explicit) ? resolve(explicit) : null;
  const debug = join(REPO, "target", "debug", process.platform === "win32" ? "mightyconsole-server.exe" : "mightyconsole-server");
  const built = execute(["cargo", "build", "-p", "mightyconsole-server", "--locked"], { log: join(logs, "server-build.log") });
  return built.code === 0 && existsSync(debug) ? debug : null;
}

// ---------------------------------------------------------------------------------------------
// Evidence

function environment(): string {
  const line = (argv: string[]) => {
    const r = spawnSync(argv[0]!, argv.slice(1), { cwd: REPO, encoding: "utf8", shell: process.platform === "win32" });
    return (r.stdout ?? "").trim() || (r.error ? `(${argv[0]} unavailable)` : (r.stderr ?? "").trim());
  };
  return [
    `date: ${new Date().toISOString()}`,
    `commit: ${line(["git", "rev-parse", "HEAD"])} (${line(["git", "status", "--porcelain"]).length > 0 ? "with local changes" : "clean"})`,
    `branch: ${line(["git", "rev-parse", "--abbrev-ref", "HEAD"])}`,
    `os: ${process.platform} ${process.arch}`,
    `node: ${process.version}`,
    `rustc: ${line(["rustc", "--version"])}`,
    `docker: ${line(["docker", "version", "--format", "{{.Server.Version}}"])}`,
  ].join("\n");
}

export function summaryMarkdown(lists: readonly Checklist[], results: readonly ItemResult[], dir: string): string {
  const icon: Record<Verdict, string> = { pass: "✅ pass", fail: "❌ fail", manual: "👤 manual", "not-wired": "⚠️ not wired", skipped: "⏭️ skipped" };
  const lines = ["# Mightyconsole acceptance", "", "```", environment(), "```", ""];
  for (const list of lists) {
    const items = results.filter((r) => r.checklist === list.id);
    if (items.length === 0) continue;
    lines.push(`## ${list.title} (${list.task})`, "", "| Item | Verdict | Checks and evidence |", "| --- | --- | --- |");
    for (const r of items) {
      const checks = r.checks.map((c) => `${c.verdict === "pass" ? "✓" : c.verdict === "manual" ? "👤" : c.verdict === "skipped" ? "–" : "✗"} ${c.label.replaceAll("|", "\\|")}: ${c.detail}${c.evidence.length ? ` (${c.evidence.map((e) => `\`${e}\``).join(", ")})` : ""}`);
      const cell = [...(r.reason && r.verdict !== "pass" && r.checks.length === 0 ? [r.reason] : []), ...checks].join("<br>");
      lines.push(`| **${r.id}**: ${r.text.replaceAll("|", "\\|")} | ${icon[r.verdict]} | ${cell} |`);
    }
    lines.push("");
  }
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;
  lines.push(`Totals: ${count("pass")} pass, ${count("fail")} fail, ${count("manual")} manual, ${count("not-wired")} not wired, ${count("skipped")} skipped. Evidence: \`${relative(REPO, dir)}\`.`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Command line

export interface Options {
  names: string[];
  only: string[];
  labUp: boolean;
  strict: boolean;
  list: boolean;
  server?: string;
  out: string;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { names: [], only: [], labUp: false, strict: false, list: false, out: join(ACCEPTANCE, "evidence") };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const value = () => {
      const v = argv[++i];
      if (!v) throw new Error(`${arg} needs a value`);
      return v;
    };
    if (arg === "--lab-up") options.labUp = true;
    else if (arg === "--strict") options.strict = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--only") options.only.push(...value().split(","));
    else if (arg === "--server") options.server = value();
    else if (arg === "--out") options.out = resolve(value());
    else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}`);
    else options.names.push(arg);
  }
  return options;
}

export async function main(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const all = await loadChecklists();
  const problems = validate(all);
  if (problems.length > 0) throw new Error(`checklists:\n  ${problems.join("\n  ")}`);
  const built = (list: Checklist) => existsSync(join(REPO, list.builtWhen));

  if (options.list || options.names.length === 0) {
    for (const list of all) {
      console.log(`${list.id} (${list.task}, ${list.title})${built(list) ? "" : `: not built yet (${list.builtWhen})`}${list.lab.length ? `, lab: ${list.lab.join(" ")}` : ""}`);
      for (const item of list.items) console.log(`  ${item.id.padEnd(16)} ${item.checks.length === 0 ? "not wired " : `${item.checks.length} check${item.checks.length === 1 ? " " : "s"}  `}${item.lab ? "[lab] " : ""}${item.text.slice(0, 100)}`);
    }
    if (options.names.length === 0 && !options.list) console.log("\nusage: acceptance.mts <checklist…|all> [--only ID,…] [--lab-up] [--server PATH] [--strict] [--out DIR] | --list");
    return 0;
  }
  const unknown = options.names.filter((n) => n !== "all" && !all.some((l) => l.id === n));
  if (unknown.length > 0) throw new Error(`no checklist ${unknown.join(", ")}: one of ${all.map((l) => l.id).join(", ")}, all`);
  const lists = options.names.includes("all") ? all : all.filter((l) => options.names.includes(l.id));

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = join(options.out, `${stamp}-${options.names.join("-")}`);
  const logs = join(dir, "logs");
  const shots = join(dir, "screenshots");
  mkdirSync(logs, { recursive: true });
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(dir, "environment.txt"), `${environment()}\n`);

  const needsServer = lists.some((l) => built(l) && l.items.some((i) => i.checks.some((c) => c.kind === "server" || c.kind === "browser")));
  let session: Promise<BrowserSession | { skipped: string }> | null = null;
  const run: Run = {
    dir,
    logs,
    shots,
    strict: options.strict,
    serverPath: needsServer ? serverBinary(options.server, logs) : (options.server ?? null),
    lab: null,
    browser: () => (session ??= openBrowser(run).catch((error: unknown) => ({ skipped: `the browser did not start: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` }))),
  };

  const results: ItemResult[] = [];
  try {
    for (const list of lists) {
      console.log(`\n${list.title} (${list.task}): checklist ${list.id}`);
      const items = list.items.filter((i) => options.only.length === 0 || options.only.includes(i.id));
      if (!built(list)) {
        for (const item of items) {
          const result: ItemResult = { checklist: list.id, id: item.id, text: item.text, verdict: "skipped", reason: `${list.task} is not built yet (no ${list.builtWhen})`, checks: [] };
          results.push(result);
          console.log(`  ${tag(result.verdict)} ${list.id}/${item.id}: ${result.reason}`);
        }
        continue;
      }
      let labUp = false;
      let labReason = "";
      if (items.some((i) => i.lab)) {
        const log = join(logs, `${list.id}-lab-check.log`);
        labUp = onPath("docker") && labCheck(list.lab, log);
        if (!labUp && options.labUp && onPath("docker")) {
          console.log(`  starting the lab: ${list.lab.join(" ")}`);
          execute(["node", join(LAB, "lab.mts"), "up", ...list.lab], { log: join(logs, `${list.id}-lab-up.log`) });
          labUp = labCheck(list.lab, log);
        }
        labReason = !onPath("docker") ? "no Docker: the lab cannot run here" : `the lab is not up (lab up ${list.lab.join(" ")}, or --lab-up; logs/${list.id}-lab-check.log)`;
        run.lab = labUp ? labCredentials() : null;
        console.log(`  lab ${list.lab.join(" ")}: ${labUp ? "up" : labReason}`);
      }
      for (const item of items) {
        console.log(`  ${list.id}/${item.id}: ${item.text.slice(0, 110)}`);
        const result = await runItem(list, item, run, labUp, labReason);
        results.push(result);
        console.log(`  ${tag(result.verdict)} ${list.id}/${item.id}${result.reason && result.verdict !== "pass" ? `: ${result.reason}` : ""}`);
      }
    }
  } finally {
    // Assigned in run.browser (a closure), so TypeScript cannot see it is no longer null here.
    const opened = await (session as Promise<BrowserSession | { skipped: string }> | null);
    if (opened && !("skipped" in opened)) await opened.close();
  }

  writeFileSync(join(dir, "summary.json"), `${JSON.stringify(results, null, 2)}\n`);
  const summary = summaryMarkdown(lists, results, dir);
  writeFileSync(join(dir, "summary.md"), summary);
  const failing = results.filter((r) => r.verdict === "fail" || r.verdict === "not-wired" || (options.strict && r.verdict === "skipped"));
  console.log(`\n${summary.split("\n").at(-2)}`);
  console.log(`summary: ${relative(process.cwd(), join(dir, "summary.md"))}`);
  if (failing.length > 0) console.error(`acceptance: ${failing.length} item${failing.length === 1 ? "" : "s"} not accepted: ${failing.map((r) => `${r.checklist}/${r.id}`).join(", ")}`);
  return failing.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`acceptance: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    },
  );
}
