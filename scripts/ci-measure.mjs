#!/usr/bin/env node
// Measures recent GitHub Actions runs of a workflow (TSK-89): how long a pull request waits,
// runner minutes, each job's and step's duration, retries, and which job and step failed.
// The "before" and "after" tables of TSK-89 come from it, so both use one method.
//
//   node scripts/ci-measure.mjs [--workflow ci.yml] [--limit 30] [--branch B] [--event pull_request]
//                               [--created '>=2026-11-18'] [--step 'apt|Install system'] [--json out.json]
//
// Uses the GitHub CLI (`gh`, authenticated, read access): `gh run list --json` for the runs, then
// `gh api repos/{owner}/{repo}/actions/runs/<id>/attempts/<n>/jobs` for the jobs and steps of the
// first and the latest attempt. Only completed runs count. Definitions:
//   wait          first attempt: run_started_at to the last job's completed_at
//   runner time   sum of the first attempt's job durations (started_at to completed_at)
//   green         the first attempt concluded success (a retry that went green does not count)
// Prints Markdown; --json also writes every run's jobs and steps for further analysis.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    workflow: { type: "string", default: "ci.yml" },
    limit: { type: "string", default: "30" },
    branch: { type: "string" },
    event: { type: "string" },
    created: { type: "string" },
    step: { type: "string" },
    json: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});
if (opt.help) {
  console.log("usage: node scripts/ci-measure.mjs [--workflow ci.yml] [--limit 30] [--branch B] [--event E] [--created Q] [--step REGEX] [--json FILE]");
  process.exit(0);
}

function gh(args) {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 << 20 }));
}

const listArgs = ["run", "list", "--workflow", opt.workflow, "--limit", opt.limit, "--status", "completed",
  "--json", "databaseId,attempt,conclusion,event,headBranch,headSha,createdAt,startedAt,updatedAt,displayTitle,url"];
if (opt.branch) listArgs.push("--branch", opt.branch);
if (opt.event) listArgs.push("--event", opt.event);
if (opt.created) listArgs.push("--created", opt.created);
const runs = gh(listArgs).filter((r) => r.conclusion !== "cancelled" && r.conclusion !== "skipped");

const ms = (a, b) => (a && b ? new Date(b) - new Date(a) : NaN);
const jobsOf = (id, attempt) =>
  gh(["api", "--paginate", "--slurp", `repos/{owner}/{repo}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`])
    .flatMap((page) => page.jobs)
    .map((j) => ({
      name: j.name,
      conclusion: j.conclusion,
      seconds: ms(j.started_at, j.completed_at) / 1000,
      startedAt: j.started_at,
      completedAt: j.completed_at,
      steps: (j.steps ?? []).map((s) => ({ name: s.name, conclusion: s.conclusion, seconds: ms(s.started_at, s.completed_at) / 1000 })),
    }));

const measured = [];
for (const run of runs) {
  const first = jobsOf(run.databaseId, 1);
  const startedAt = run.attempt > 1 ? gh(["api", `repos/{owner}/{repo}/actions/runs/${run.databaseId}/attempts/1`]).run_started_at : run.startedAt;
  const latest = run.attempt > 1 ? jobsOf(run.databaseId, run.attempt) : first;
  const ran = first.filter((j) => j.conclusion !== "skipped" && Number.isFinite(j.seconds));
  const lastDone = ran.map((j) => j.completedAt).sort().at(-1);
  const firstConclusion = ran.some((j) => j.conclusion === "failure")
    ? "failure"
    : ran.some((j) => j.conclusion === "cancelled")
      ? "cancelled"
      : "success";
  measured.push({
    id: run.databaseId,
    url: run.url,
    event: run.event,
    branch: run.headBranch,
    title: run.displayTitle,
    attempts: run.attempt,
    conclusion: run.conclusion,
    firstConclusion,
    waitMinutes: ms(startedAt, lastDone) / 60000,
    runnerMinutes: ran.reduce((sum, j) => sum + j.seconds, 0) / 60,
    jobs: first,
    latestJobs: latest,
  });
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const min = (xs) => Math.min(...xs.filter(Number.isFinite));
const max = (xs) => Math.max(...xs.filter(Number.isFinite));
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : "–");
const row = (cells) => `| ${cells.join(" | ")} |`;

const out = [];
out.push(`## ${opt.workflow}: ${measured.length} completed runs` + (measured.length ? ` (${measured.at(-1).id} … ${measured[0].id})` : ""));
out.push("");
const green = measured.filter((r) => r.firstConclusion === "success");
out.push(row(["", "n", "median", "min", "max"]));
out.push(row(["---", "---:", "---:", "---:", "---:"]));
out.push(row(["wait, first attempt, green (min)", green.length, f1(median(green.map((r) => r.waitMinutes))), f1(min(green.map((r) => r.waitMinutes))), f1(max(green.map((r) => r.waitMinutes)))]));
out.push(row(["wait, first attempt, all (min)", measured.length, f1(median(measured.map((r) => r.waitMinutes))), f1(min(measured.map((r) => r.waitMinutes))), f1(max(measured.map((r) => r.waitMinutes)))]));
out.push(row(["runner time per run (min)", measured.length, f1(median(measured.map((r) => r.runnerMinutes))), f1(min(measured.map((r) => r.runnerMinutes))), f1(max(measured.map((r) => r.runnerMinutes)))]));
out.push("");
out.push(`First attempt green: ${green.length}/${measured.length}; runs retried: ${measured.filter((r) => r.attempts > 1).length}.`);
out.push("");

const jobNames = [...new Set(measured.flatMap((r) => r.jobs.map((j) => j.name)))].sort();
out.push(row(["job (first attempt, min)", "ran", "median", "max", "failed", "skipped"]));
out.push(row(["---", "---:", "---:", "---:", "---:", "---:"]));
for (const name of jobNames) {
  const js = measured.flatMap((r) => r.jobs.filter((j) => j.name === name));
  const ran = js.filter((j) => j.conclusion !== "skipped");
  const mins = ran.map((j) => j.seconds / 60);
  out.push(row([name, ran.length, f1(median(mins)), f1(max(mins)), js.filter((j) => j.conclusion === "failure").length, js.length - ran.length]));
}
out.push("");

const failures = new Map();
for (const r of measured) {
  for (const j of r.jobs.filter((j) => j.conclusion === "failure")) {
    const step = j.steps.find((s) => s.conclusion === "failure")?.name ?? "(no failed step)";
    const key = `${j.name} › ${step}`;
    failures.set(key, [...(failures.get(key) ?? []), r.id]);
  }
}
if (failures.size) {
  out.push(row(["failed job › step (first attempt)", "count", "runs"]));
  out.push(row(["---", "---:", "---"]));
  for (const [key, ids] of [...failures].sort((a, b) => b[1].length - a[1].length)) out.push(row([key, ids.length, ids.join(", ")]));
  out.push("");
}

if (opt.step) {
  const re = new RegExp(opt.step, "i");
  const steps = measured.flatMap((r) => r.jobs.flatMap((j) => j.steps.filter((s) => re.test(s.name) && Number.isFinite(s.seconds)).map((s) => ({ ...s, job: j.name }))));
  const secs = steps.map((s) => s.seconds);
  out.push(`Steps matching /${opt.step}/i: ${steps.length}; median ${f1(median(secs))} s, max ${f1(max(secs))} s; ` +
    `under 2 min: ${secs.filter((s) => s < 120).length}; 5 min or more: ${secs.filter((s) => s >= 300).length}.`);
  out.push("");
}

console.log(out.join("\n"));
if (opt.json) writeFileSync(opt.json, JSON.stringify(measured, null, 2) + "\n");
