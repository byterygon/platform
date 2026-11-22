// Tests for scripts/lab-labels.mjs (TSK-129): `node --test scripts/lab-labels.test.mjs`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { labDecision, labScope } from "./lab-labels.mjs";

const tools = ["nats", "kafka", "k8s", "temporal", "docker", "langgraph"];
const scope = (labels, affected, event = "pull_request") => labScope({ event, labels, affected, tools });

test("pushes, the weekly run and manual runs bring up every tool", () => {
  for (const event of ["push", "schedule", "workflow_dispatch"]) assert.deepEqual(scope([], "none", event).tools, "all", event);
});

test("a pull request without a lab label runs no lab", () => {
  assert.equal(scope([], ["langgraph"]).tools, "none");
  assert.equal(scope(["bug", "labrador"], "all").tools, "none");
});

test("lab takes affected's scope; lab:<tool> adds tools; lab:all wins; lab:none alone runs nothing", () => {
  assert.deepEqual(scope(["lab"], ["langgraph"]).tools, ["langgraph"]);
  assert.equal(scope(["lab"], "all").tools, "all");
  assert.equal(scope(["lab"], "none").tools, "none");
  assert.deepEqual(scope(["lab:temporal", "lab:langgraph"], "all").tools, ["langgraph", "temporal"]);
  assert.deepEqual(scope(["lab", "lab:nats"], ["langgraph"]).tools, ["langgraph", "nats"]);
  assert.equal(scope(["lab:nats", "lab:all"], "none").tools, "all");
  assert.equal(scope(["lab:none"], "all").tools, "none");
});

test("an unknown lab:<name> is reported and ignored", () => {
  const s = scope(["lab:postgres", "lab:docker"], "all");
  assert.deepEqual(s.tools, ["docker"]);
  assert.deepEqual(s.unknown, ["lab:postgres"]);
});

test("the decision: a change that needs the lab must carry a lab label", () => {
  assert.equal(labDecision({ labels: [], affected: "none" }).ok, true);
  assert.equal(labDecision({ labels: [], affected: ["langgraph"] }).ok, false);
  assert.match(labDecision({ labels: [], affected: ["langgraph"] }).message, /"lab" \(runs langgraph\)/);
  for (const labels of [["lab"], ["lab:none"], ["lab:temporal"]]) assert.equal(labDecision({ labels, affected: "all" }).ok, true, labels.join());
});

test("the command line reads affected's JSON and the labels as JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "lab-labels-"));
  const file = join(dir, "affected.json");
  writeFileSync(file, JSON.stringify({ lab_tools: ["langgraph"] }));
  const cli = fileURLToPath(new URL("./lab-labels.mjs", import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }).trim();
  assert.equal(run("scope", "--affected", file, "--labels", '["lab","lab:temporal"]'), "langgraph temporal");
  assert.equal(run("scope", "--affected", file, "--labels", "null"), "none");
  assert.equal(run("scope", "--event", "push", "--affected", file), "all");
  assert.throws(() => execFileSync(process.execPath, [cli, "decide", "--affected", file, "--labels", "[]"], { stdio: "pipe" }));
  assert.match(run("decide", "--affected", file, "--labels", '["lab:none"]'), /lab decided: lab:none/);
});
