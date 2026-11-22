#!/usr/bin/env node
// The Mightyconsole lab on pull requests, decided by labels (TSK-129). On every push the lab ran
// whenever a pull request touched its files (110 runs, about 2,250 min, a quarter of them failing,
// in the week to 2026-11-22). Now the agent labels the pull request once its local checks pass
// (scripts/pre-pr.mjs):
//
//   lab          the scope scripts/affected.mjs gives (its lab_tools)
//   lab:<tool>   that tool's profile and checklists (several labels add up); lab:all every tool
//   lab:none     no lab run (say why in the pull request)
//
// Pushes to main, the weekly run and manual runs still bring up every tool.
//
//   node scripts/lab-labels.mjs scope  --event E --labels '["lab"]' --affected affected.json [--github-output]
//   node scripts/lab-labels.mjs decide --labels '["lab"]' --affected affected.json
//
// `scope` prints the tools to bring up ("all", "none" or names separated by spaces); `decide`
// exits 1 when the change needs the lab (affected's lab_tools is not "none") and the pull request
// has no lab label, so no pull request skips the lab without saying so.
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const isLab = (label) => label === "lab" || label.startsWith("lab:");

/**
 * The tools a lab run brings up. `affected` is scripts/affected.mjs's lab_tools ("all", "none" or
 * names); `tools` the lab's tools (apps/mightyconsole/lab/lab.mts's TOOLS).
 * @returns {{ tools: "all" | "none" | string[], unknown: string[] }}
 */
export function labScope({ event, labels, affected, tools }) {
  if (event !== "pull_request") return { tools: "all", unknown: [] };
  const chosen = new Set();
  const unknown = [];
  for (const label of (labels ?? []).filter(isLab)) {
    if (label === "lab") {
      if (affected === "all") return { tools: "all", unknown };
      if (Array.isArray(affected)) for (const t of affected) chosen.add(t);
      continue;
    }
    const tool = label.slice("lab:".length);
    if (tool === "all") return { tools: "all", unknown };
    if (tool === "none") continue;
    if (tools.includes(tool)) chosen.add(tool);
    else unknown.push(label);
  }
  return { tools: chosen.size ? [...chosen].sort() : "none", unknown };
}

/** Whether a pull request has said what it does about the lab. */
export function labDecision({ labels, affected }) {
  const needs = affected !== "none";
  const mine = (labels ?? []).filter(isLab);
  if (!needs) return { ok: true, message: "the change needs no lab run" };
  if (mine.length) return { ok: true, message: `lab decided: ${mine.join(", ")}` };
  const scope = Array.isArray(affected) ? affected.join(" ") : affected;
  return {
    ok: false,
    message:
      `this change needs the lab (scripts/affected.mjs: ${scope}). Once scripts/pre-pr.mjs passes, label the pull request ` +
      `"lab" (runs ${scope}), "lab:<tool>" (a scope you choose; lab:all for every tool) or "lab:none" (say why in the description).`,
  };
}

const show = (tools) => (Array.isArray(tools) ? tools.join(" ") : tools);
const parseLabels = (text) => {
  const value = JSON.parse(text || "null");
  return Array.isArray(value) ? value.filter((l) => typeof l === "string") : [];
};

function main() {
  const { values: opt, positionals } = parseArgs({
    allowPositionals: true,
    options: { event: { type: "string", default: "pull_request" }, labels: { type: "string", default: "[]" }, affected: { type: "string" }, "github-output": { type: "boolean", default: false } },
  });
  if (!opt.affected) throw new Error("--affected <scripts/affected.mjs JSON file> is required");
  const affected = JSON.parse(readFileSync(opt.affected, "utf8")).lab_tools;
  const labels = parseLabels(opt.labels);
  if (positionals[0] === "decide") {
    const { ok, message } = labDecision({ labels, affected });
    console[ok ? "log" : "error"](`lab decision: ${message}`);
    return ok ? 0 : 1;
  }
  if (positionals[0] === "scope") {
    const lab = readFileSync(fileURLToPath(new URL("../apps/mightyconsole/lab/lab.mts", import.meta.url)), "utf8");
    const tools = [...(lab.match(/export const TOOLS = \[([^\]]*)\]/)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const scope = labScope({ event: opt.event, labels, affected, tools });
    for (const label of scope.unknown) console.error(`lab scope: ${label} names no lab tool (${tools.join(", ")}); ignored`);
    console.log(show(scope.tools));
    if (opt["github-output"]) appendFileSync(process.env.GITHUB_OUTPUT ?? "", `lab_tools=${show(scope.tools)}\n`);
    return 0;
  }
  throw new Error("usage: lab-labels.mjs scope|decide --affected FILE [--labels JSON] [--event NAME]");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main());
