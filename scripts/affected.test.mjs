// Tests of scripts/affected.mjs (TSK-89): node --test scripts/
// They run against this repository's real workspace (package.json files, Cargo.toml members,
// Cargo.lock, pnpm-lock.yaml) with made-up lists of changed files, so a new package or crate is
// covered without editing them. The cross-checks against pnpm and cargo skip when those are absent.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  cargoLockAffected,
  cargoWorkspaceEdges,
  computeAffected,
  globToRegExp,
  labTools,
  parseCargoLock,
  pnpmLockAffected,
  readCargoWorkspace,
  readLabTools,
  readPnpmWorkspace,
} from "./affected.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = readPnpmWorkspace(ROOT);
const crates = readCargoWorkspace(ROOT);
const cargoLockText = readFileSync(join(ROOT, "Cargo.lock"), "utf8");
const pnpmLockText = readFileSync(join(ROOT, "pnpm-lock.yaml"), "utf8");
const crateDeps = cargoWorkspaceEdges(cargoLockText, [...crates.keys()]);

const affected = (files, extra = {}) => computeAffected({ files, packages, crates, crateDeps, ...extra });
const has = (cmd) => {
  try {
    execFileSync(cmd, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("globs: * stays in a segment, ** crosses segments", () => {
  assert.ok(globToRegExp("**/*.md").test("README.md"));
  assert.ok(globToRegExp("**/*.md").test("packages/ui/AGENTS.md"));
  assert.ok(globToRegExp(".github/**").test(".github/workflows/ci.yml"));
  assert.ok(!globToRegExp("apps/*/LICENSE").test("apps/dbee/ui/LICENSE"));
  assert.ok(globToRegExp("apps/dbee/ui/src/gen/**").test("apps/dbee/ui/src/gen/api.ts"));
});

test("the workspace is read: every pnpm package and Cargo crate", () => {
  for (const name of ["@byterygon/ui", "@byterygon/dbee", "@byterygon/mightyconsole", "@byterygon/design-tokens"]) assert.ok(packages.has(name), name);
  for (const name of ["ambidex", "dbee-desktop", "mightyconsole-server", "db-driver-postgres"]) assert.ok(crates.has(name), name);
  assert.deepEqual(packages.get("@byterygon/ui").dir, "packages/ui");
  assert.deepEqual(crates.get("dbee-desktop").dir, "apps/dbee/desktop");
});

test("packages/ui affects both products, JS and Rust", () => {
  const r = affected(["packages/ui/src/components/button/button.tsx"]);
  assert.equal(r.all, false);
  for (const p of ["@byterygon/ui", "@byterygon/dbee", "@byterygon/mightyconsole", "@byterygon/theme-studio", "@byterygon/ui-mcp"]) assert.ok(r.packages.includes(p), p);
  assert.ok(!r.packages.includes("@byterygon/design-tokens"), "a dependency is not a dependent");
  assert.ok(r.crates.includes("dbee-desktop"), "the desktop app embeds the DBee UI");
  assert.ok(r.crates.includes("mightyconsole-server"), "the server embeds the Mightyconsole UI");
  assert.ok(!r.crates.includes("ambidex"));
  assert.deepEqual(r.jobs, { rust: true, typescript: true, dbee_desktop: true, dbee_budget: true, mightyconsole: true });
});

test("apps/mightyconsole only affects Mightyconsole", () => {
  for (const file of ["apps/mightyconsole/ui/src/app/shell.tsx", "apps/mightyconsole/server/src/lib.rs", "apps/mightyconsole/lab/compose.yaml"]) {
    const r = affected([file]);
    assert.equal(r.all, false, file);
    assert.ok(r.packages.every((p) => p === "@byterygon/mightyconsole"), `${file}: ${r.packages}`);
    assert.ok(r.crates.every((c) => c.startsWith("mightyconsole-")), `${file}: ${r.crates}`);
    assert.equal(r.jobs.mightyconsole, true, file);
    assert.equal(r.jobs.dbee_desktop, false, file);
    assert.equal(r.jobs.dbee_budget, false, file);
  }
});

test("a generated file inside a UI package affects the Rust crate that drift-checks it", () => {
  assert.ok(affected(["apps/dbee/ui/src/gen/api.ts"]).crates.includes("dbee-core"));
  assert.ok(affected(["packages/ambidex/test/conformance/api.ts"]).crates.includes("ambidex-conformance"));
  assert.ok(affected(["crates/ambidex-conformance/src/cases.rs"]).packages.includes("@byterygon/ambidex"), "the TS runtime tests run against the Rust server");
});

test("a Rust crate affects its dependents only", () => {
  const r = affected(["crates/db-driver-postgres/src/lib.rs"]);
  assert.ok(r.crates.includes("db-driver-postgres"));
  assert.ok(!r.crates.includes("db-driver"), "a dependency is not a dependent");
  assert.ok(!r.crates.includes("mightyconsole-server"));
  assert.deepEqual(r.packages, []);
  assert.equal(r.args.cargo, r.crates.map((c) => `-p ${c}`).join(" "));
});

test("a workflow change, the toolchain or an unknown file runs everything", () => {
  for (const file of [".github/workflows/ci.yml", ".github/ci-image/Dockerfile", "rust-toolchain.toml", "pnpm-workspace.yaml", "scripts/affected.mjs", "some-new-file.txt"]) {
    const r = affected([file]);
    assert.equal(r.all, true, file);
    assert.equal(r.args.cargo, "--workspace");
    assert.equal(r.args.pnpm, "--recursive");
    assert.ok(Object.values(r.jobs).every(Boolean), file);
  }
});

test("pushes and manual runs run everything", () => {
  for (const event of ["push", "workflow_dispatch", "schedule"]) assert.equal(affected([], { event }).all, true, event);
  assert.equal(affected([], { event: "pull_request" }).all, false);
});

// TSK-150: the merge queue is the last check before main, so it runs what a push to main runs,
// even for a change that alone affects nothing.
test("the merge queue runs everything", () => {
  assert.equal(affected(["docs/agents/ci.md"], { event: "merge_group" }).all, true);
  assert.equal(affected(["docs/agents/ci.md"], { event: "pull_request" }).all, false);
});

test("documentation only runs none of the conditional jobs", () => {
  const r = affected(["README.md", "packages/ui/AGENTS.md", "apps/dbee/INSTALL.md", "LICENSE-MIT", "deny.toml"]);
  assert.equal(r.all, false);
  assert.deepEqual(r.crates, []);
  assert.deepEqual(r.packages, []);
  assert.ok(Object.values(r.jobs).every((v) => v === false));
});

test("the root Cargo.toml affects every crate but no package", () => {
  const r = affected(["Cargo.toml"]);
  assert.equal(r.all, false);
  assert.equal(r.crates.length, crates.size);
  assert.equal(r.args.cargo, "--workspace");
  assert.ok(!r.packages.includes("@byterygon/ui"));
});

// pnpm-lock.yaml: a one-line change in one importer affects that package and its dependents.
function editImporterVersion(text, importerDir) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === `  ${importerDir}:`);
  assert.ok(start > 0, `importer ${importerDir} in pnpm-lock.yaml`);
  for (let i = start + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i++) {
    const m = lines[i].match(/^( {8}version: )(\d.*)$/);
    if (m) {
      lines[i] = `${m[1]}0.0.0-test`;
      return lines.join("\n");
    }
  }
  throw new Error(`no registry dependency in ${importerDir}`);
}

test("pnpm-lock.yaml: one line of one importer affects that package and its dependents only", () => {
  const edited = editImporterVersion(pnpmLockText, "packages/theme-studio");
  const diff = pnpmLockAffected(pnpmLockText, edited);
  assert.equal(diff.all, false);
  assert.deepEqual([...diff.importers], ["packages/theme-studio"]);
  const r = affected(["pnpm-lock.yaml"], { pnpmLock: { old: pnpmLockText, new: edited } });
  assert.deepEqual(r.packages, ["@byterygon/theme-studio"]);
  assert.deepEqual(r.crates, []);

  const ui = affected(["pnpm-lock.yaml"], { pnpmLock: { old: pnpmLockText, new: editImporterVersion(pnpmLockText, "packages/ui") } });
  for (const p of ["@byterygon/ui", "@byterygon/dbee", "@byterygon/mightyconsole", "@byterygon/theme-studio"]) assert.ok(ui.packages.includes(p), p);
});

test("pnpm-lock.yaml: a transitive snapshot change affects every importer that reaches it", () => {
  // A snapshot entry with dependencies, edited in its own block: only importers reaching it change.
  const lines = pnpmLockText.split("\n");
  const snapStart = lines.lastIndexOf("snapshots:");
  const i = lines.findIndex((l, n) => n > snapStart && /^ {6}\S.*: \d/.test(l));
  const edited = [...lines.slice(0, i), lines[i].replace(/: (\d\S*)$/, ": $1-test"), ...lines.slice(i + 1)].join("\n");
  const diff = pnpmLockAffected(pnpmLockText, edited);
  assert.equal(diff.all, false);
  assert.ok(diff.importers.size >= 1);
  assert.ok(diff.importers.size < packages.size + 1, "not every importer");
});

test("pnpm-lock.yaml: lockfile-wide settings or pnpm itself run everything", () => {
  assert.equal(pnpmLockAffected(pnpmLockText, pnpmLockText.replace("autoInstallPeers: true", "autoInstallPeers: false")).all, true);
  const [envDoc] = pnpmLockText.split(/^---\s*$/m).filter((d) => d.trim());
  if (pnpmLockText.split(/^---\s*$/m).filter((d) => d.trim()).length > 1) {
    assert.equal(pnpmLockAffected(pnpmLockText, pnpmLockText.replace(envDoc, envDoc.replace(/version: (\d+)\./, "version: 99."))).all, true);
  }
  assert.equal(pnpmLockAffected(pnpmLockText, pnpmLockText).importers.size, 0);
});

test("Cargo.lock: a changed external crate affects the workspace crates that reach it", () => {
  const graph = parseCargoLock(cargoLockText);
  const members = [...crates.keys()];
  // Pick the external package reached by the fewest workspace crates (but at least one).
  const reach = new Map();
  for (const m of members) {
    const id = [...graph.values()].find((e) => e.name === m && !e.source).id;
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      stack.push(...graph.get(x).deps);
    }
    for (const x of seen) if (graph.get(x).source) reach.set(x, [...(reach.get(x) ?? []), m]);
  }
  const [target, reachedBy] = [...reach].sort((a, b) => a[1].length - b[1].length)[0];
  const e = graph.get(target);
  const edited = cargoLockText.replace(`checksum = "${e.checksum}"`, `checksum = "${"0".repeat(64)}"`);
  assert.notEqual(edited, cargoLockText);
  assert.deepEqual([...cargoLockAffected(cargoLockText, edited, members)].sort(), [...reachedBy].sort());
  const r = affected(["Cargo.lock"], { cargoLock: { old: cargoLockText, new: edited } });
  for (const c of reachedBy) assert.ok(r.crates.includes(c), c);
  assert.equal(r.all, false);
  assert.equal(cargoLockAffected(cargoLockText, cargoLockText, members).size, 0);
});

test("the JS graph matches pnpm's own `...<package>` selection", { skip: !has("pnpm") && "pnpm not installed" }, () => {
  for (const name of packages.keys()) {
    const out = execFileSync("pnpm", ["ls", "--filter", `...${name}`, "--depth", "-1", "--json"], { cwd: ROOT, encoding: "utf8" });
    const fromPnpm = JSON.parse(out).map((p) => p.name).filter((n) => packages.has(n)).sort();
    const r = computeAffected({ files: [`${packages.get(name).dir}/package.json`], packages, crates, crateDeps, rules: { RUN_ALL: [], ALL_RUST: [], EDGES: [], NO_TARGETS: [] } });
    assert.deepEqual(r.packages, fromPnpm, name);
  }
});

test("the Rust graph matches cargo metadata's workspace dependencies", { skip: !has("cargo") && "cargo not installed" }, () => {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--no-deps", "--format-version", "1", "--offline"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
  const names = new Set(meta.packages.map((p) => p.name));
  assert.deepEqual([...names].sort(), [...crates.keys()].sort());
  for (const p of meta.packages) {
    const fromCargo = [...new Set(p.dependencies.filter((d) => names.has(d.name) && d.path).map((d) => d.name))].sort();
    assert.deepEqual([...(crateDeps.get(p.name) ?? [])].sort(), fromCargo, p.name);
  }
});

test("the Mightyconsole lab brings up only the tools whose own files changed", () => {
  const tools = readLabTools(ROOT);
  assert.ok(tools.includes("langgraph") && tools.includes("temporal") && tools.includes("docker"));
  const lab = (files, extra = {}) => labTools({ files, packages, crates, crateDeps, ...extra }, tools);
  assert.deepEqual(lab(["apps/mightyconsole/ui/src/tools/langgraph/thread.tsx"]), ["langgraph"]);
  assert.deepEqual(lab(["apps/mightyconsole/server/src/tools/temporal/mod.rs", "apps/mightyconsole/ui/test/temporal-actions.test.tsx", "apps/mightyconsole/acceptance/checklists/temporal.mts"]), ["temporal"]);
  assert.deepEqual(lab(["apps/mightyconsole/lab/docker-host/seed.sh", "apps/mightyconsole/lab/langgraph/agent.py"]), ["docker", "langgraph"]);
  // TSK-124: PR #189's files (a LangGraph batch) bring up LangGraph only: the tool's server tests
  // and the generated API, its drift test and the checklist-name test follow the tool.
  assert.deepEqual(
    lab([
      "apps/mightyconsole/acceptance/checklists/langgraph.mts",
      "apps/mightyconsole/server/src/tools/langgraph/assistants.rs",
      "apps/mightyconsole/server/tests/codegen.rs",
      "apps/mightyconsole/server/tests/langgraph.rs",
      "apps/mightyconsole/server/tests/langgraph_lab.rs",
      "apps/mightyconsole/ui/src/gen/api.manifest.json",
      "apps/mightyconsole/ui/src/gen/api.ts",
      "apps/mightyconsole/ui/src/tools/langgraph/assistants.tsx",
      "apps/mightyconsole/ui/test/acceptance.test.ts",
      "apps/mightyconsole/ui/test/langgraph.test.tsx",
    ]),
    ["langgraph"],
  );
  assert.deepEqual(lab(["apps/mightyconsole/acceptance/checklists/temporal-more.mts", "apps/mightyconsole/server/tests/nats_lab.rs"]), ["nats", "temporal"]);
  // Alone, the neutral files still need every tool; a core test still does too.
  assert.equal(lab(["apps/mightyconsole/ui/src/gen/api.ts"]), "all");
  assert.equal(lab(["apps/mightyconsole/server/tests/e2e.rs", "apps/mightyconsole/server/tests/langgraph.rs"]), "all");
  // The shell, the server core, the sample tool, shared packages: every tool.
  for (const file of ["apps/mightyconsole/server/src/lib.rs", "apps/mightyconsole/ui/src/tools/echo/index.tsx", "apps/mightyconsole/lab/compose.yaml", "packages/ui/src/index.ts"]) assert.equal(lab([file]), "all", file);
  assert.equal(lab(["apps/mightyconsole/ui/src/tools/langgraph/thread.tsx", "apps/mightyconsole/server/src/api.rs"]), "all");
  assert.equal(lab(["crates/db-driver/src/lib.rs"]), "none");
  assert.equal(lab(["README.md"]), "none");
  assert.equal(lab([], { event: "schedule" }), "all");
});
