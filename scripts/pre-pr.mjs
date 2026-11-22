#!/usr/bin/env node
// Runs on this machine, before a push or a pull request, what CI will run for the change (TSK-128):
// scripts/affected.mjs's answer for the working tree against origin/main picks the steps, with the
// same `cargo -p` and `pnpm --filter` arguments as CI. About half of the CI failures on pull
// requests in the week to 2026-11-22 were tests, docs, lint and clippy a laptop catches.
//
//   node scripts/pre-pr.mjs [--base origin/main] [--dry-run] [--keep-going]
//
// --dry-run prints the steps without running them; --keep-going runs every step even after one
// fails. Exit 0 when every step passed, 1 otherwise. What only CI can run (the network namespace,
// the browser checks, the lab, the Windows and macOS jobs) is listed at the end, with why.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const words = (args) => (args ?? "").split(/\s+/).filter(Boolean);

/**
 * The steps for an affected answer (scripts/affected.mjs's JSON) on a machine with `local`
 * (`cargoDeny`: cargo-deny is installed; `postgres`: initdb is on PATH; `nodeModules`: pnpm has
 * installed; `loopback2`: 127.0.0.2 can be bound). Pure, so it is tested without running anything.
 * `notes` are known reasons a step fails on this machine, printed before the steps run.
 * @returns {{ steps: { name: string, argv: string[], env?: Record<string, string> }[], skipped: { name: string, why: string }[], notes: string[] }}
 */
export function plan(affected, local) {
  const steps = [];
  const skipped = [];
  const notes = [];
  const jobs = affected.jobs ?? {};
  // The License policy job runs on every pull request.
  steps.push({ name: "licence fields and the AGPL direction", argv: ["node", "scripts/check-licenses.mjs"] });
  if (local.cargoDeny) steps.push({ name: "cargo deny", argv: ["cargo", "deny", "check", "licenses", "bans", "sources"] });
  else skipped.push({ name: "cargo deny", why: "cargo-deny is not installed here (cargo install cargo-deny); CI's License policy job runs it" });

  if (jobs.rust) {
    const cargo = words(affected.args?.cargo);
    steps.push({ name: "cargo fmt", argv: ["cargo", "fmt", "--all", "--check"] });
    steps.push({ name: "cargo clippy", argv: ["cargo", "clippy", ...cargo, "--all-targets", "--locked", "--", "-D", "warnings"] });
    steps.push({ name: "cargo doc", argv: ["cargo", "doc", ...cargo, "--no-deps", "--locked"], env: { RUSTDOCFLAGS: "-D warnings" } });
    // --no-fail-fast: every failing test binary, not only the first (CI stops at the first).
    steps.push({ name: "cargo test", argv: ["cargo", "test", ...cargo, "--locked", "--no-fail-fast"] });
    skipped.push({ name: "the tests with no network", why: "CI runs them in a network namespace with only loopback (Linux); here they run with the network up" });
    if (!local.postgres) skipped.push({ name: "PostgreSQL tests", why: "no initdb on PATH, so they skip here; CI requires them (BYTERYGON_REQUIRE_POSTGRES=1)" });
    if (local.loopback2 === false && (cargo.includes("--workspace") || cargo.includes("plugin-host")))
      notes.push("this machine cannot bind 127.0.0.2, so plugin-host's broker tests that use it (DNS rebinding, permitted addresses) fail here with AddrNotAvailable; on macOS `sudo ifconfig lo0 alias 127.0.0.2 up` adds it until the next restart. CI (Linux) has it.");
  }
  if (jobs.typescript) {
    if (!local.nodeModules) steps.push({ name: "pnpm install", argv: ["pnpm", "install", "--frozen-lockfile"] });
    const pnpm = words(affected.args?.pnpm);
    steps.push({ name: "typecheck", argv: ["pnpm", ...pnpm, "run", "--if-present", "typecheck"] });
    steps.push({ name: "build", argv: ["pnpm", ...words(affected.args?.pnpm_build), "run", "--if-present", "build"] });
    steps.push({ name: "lint", argv: ["pnpm", ...pnpm, "run", "--if-present", "lint"] });
    steps.push({ name: "test", argv: ["pnpm", ...pnpm, "run", "--if-present", "test"] });
    skipped.push({ name: "the browser checks (editors, Theme Studio, data grid, registry install)", why: "CI runs them in Chrome in a network namespace; run a package's check:browser here if you changed what it shows" });
  }
  if (jobs.mightyconsole) skipped.push({ name: "Mightyconsole in Chrome", why: "CI runs it in a network namespace; `pnpm --filter @byterygon/mightyconsole check:browser` runs it here" });
  if (affected.lab_tools && affected.lab_tools !== "none") skipped.push({ name: `the Mightyconsole lab (${Array.isArray(affected.lab_tools) ? affected.lab_tools.join(" ") : affected.lab_tools})`, why: "docker compose services; `pnpm --filter @byterygon/mightyconsole lab up <tool>` and `acceptance <checklist>` run them here" });
  if (jobs.dbee_desktop) skipped.push({ name: "DBee desktop on Windows and macOS", why: "CI's runners; clippy and tests for this OS ran above" });
  if (jobs.dbee_budget) skipped.push({ name: "DBee desktop budget", why: "WebKitGTK under Xvfb on Linux, release build" });
  return { steps, skipped, notes };
}

const has = (program, args) => spawnSync(program, args, { stdio: "ignore", shell: process.platform === "win32" }).status === 0;
/** Whether a socket can listen on 127.0.0.2 (Linux has the whole of 127/8; macOS only 127.0.0.1). */
const canBind = (address) =>
  spawnSync(process.execPath, ["-e", `require("net").createServer().once("error", () => process.exit(1)).listen(0, ${JSON.stringify(address)}, function () { this.close(); })`], { stdio: "ignore", timeout: 5000 }).status === 0;

function main() {
  const { values: opt } = parseArgs({
    options: {
      base: { type: "string", default: "origin/main" },
      "dry-run": { type: "boolean", default: false },
      "keep-going": { type: "boolean", default: false },
    },
  });
  const affected = JSON.parse(execFileSync("node", [join(ROOT, "scripts/affected.mjs"), "--base", opt.base], { cwd: ROOT, encoding: "utf8" }));
  const local = {
    cargoDeny: has("cargo", ["deny", "--version"]),
    postgres: has("initdb", ["--version"]),
    nodeModules: existsSync(join(ROOT, "node_modules", ".modules.yaml")),
    loopback2: canBind("127.0.0.2"),
  };
  const { steps, skipped, notes } = plan(affected, local);
  const scope = affected.all ? `everything (${affected.reasons?.join("; ")})` : `${affected.crates.length} crates, ${affected.packages.length} packages`;
  console.log(`pre-pr: ${affected.files} changed files against ${opt.base}: ${scope}`);
  for (const note of notes) console.log(`pre-pr: note: ${note}`);
  const results = [];
  for (const step of steps) {
    const line = `${step.env ? `${Object.entries(step.env).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")} ` : ""}${step.argv.join(" ")}`;
    if (opt["dry-run"]) {
      console.log(`  ${step.name}: ${line}`);
      continue;
    }
    console.log(`\n▶ ${step.name}: ${line}`);
    const started = Date.now();
    const status = spawnSync(step.argv[0], step.argv.slice(1), { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...step.env }, shell: process.platform === "win32" }).status;
    results.push({ name: step.name, ok: status === 0, s: (Date.now() - started) / 1000 });
    if (status !== 0 && !opt["keep-going"]) break;
  }
  if (!opt["dry-run"]) {
    console.log("\npre-pr:");
    for (const r of results) console.log(`  ${r.ok ? "pass" : "FAIL"}  ${r.name} (${r.s.toFixed(1)} s)`);
    for (const s of steps.slice(results.length)) console.log(`  not run  ${s.name} (an earlier step failed; --keep-going runs it)`);
  }
  if (skipped.length) {
    console.log("\nOnly CI checks:");
    for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
  }
  if (opt["dry-run"]) return 0;
  return results.length === steps.length && results.every((r) => r.ok) ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
