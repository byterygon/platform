// Tests for scripts/pre-pr.mjs's plan (TSK-128): `node --test scripts/pre-pr.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plan } from "./pre-pr.mjs";

const none = { jobs: { rust: false, typescript: false, dbee_desktop: false, dbee_budget: false, mightyconsole: false }, args: { cargo: "", pnpm: "", pnpm_build: "" }, lab_tools: "none" };
const local = { cargoDeny: true, postgres: true, nodeModules: true };
const names = (p) => p.steps.map((s) => s.name);
const argv = (p, name) => p.steps.find((s) => s.name === name)?.argv.join(" ");

test("a change that affects nothing still checks the licences", () => {
  const p = plan(none, local);
  assert.deepEqual(names(p), ["licence fields and the AGPL direction", "cargo deny"]);
  assert.deepEqual(p.skipped, []);
});

test("Rust steps take CI's -p arguments, docs deny warnings", () => {
  const p = plan({ ...none, jobs: { ...none.jobs, rust: true }, args: { ...none.args, cargo: "-p mightyconsole-server -p mightyconsole-rpc-gen" } }, local);
  assert.deepEqual(names(p).slice(2), ["cargo fmt", "cargo clippy", "cargo doc", "cargo test"]);
  assert.equal(argv(p, "cargo clippy"), "cargo clippy -p mightyconsole-server -p mightyconsole-rpc-gen --all-targets --locked -- -D warnings");
  assert.equal(argv(p, "cargo test"), "cargo test -p mightyconsole-server -p mightyconsole-rpc-gen --locked --no-fail-fast");
  assert.deepEqual(p.steps.find((s) => s.name === "cargo doc")?.env, { RUSTDOCFLAGS: "-D warnings" });
  assert.ok(p.skipped.some((s) => s.name === "the tests with no network"));
  assert.ok(!p.skipped.some((s) => s.name === "PostgreSQL tests"));
});

test("TypeScript steps take CI's filters; the build its build filter", () => {
  const p = plan({ ...none, jobs: { ...none.jobs, typescript: true }, args: { ...none.args, pnpm: "--filter @byterygon/ui", pnpm_build: "--filter @byterygon/ui..." } }, local);
  assert.deepEqual(names(p).slice(2), ["typecheck", "build", "lint", "test"]);
  assert.equal(argv(p, "typecheck"), "pnpm --filter @byterygon/ui run --if-present typecheck");
  assert.equal(argv(p, "build"), "pnpm --filter @byterygon/ui... run --if-present build");
});

test("a machine without 127.0.0.2 is told why plugin-host's broker tests fail", () => {
  const rust = (cargo) => ({ ...none, jobs: { ...none.jobs, rust: true }, args: { ...none.args, cargo } });
  assert.equal(plan(rust("--workspace"), { ...local, loopback2: false }).notes.length, 1);
  assert.equal(plan(rust("-p plugin-host"), { ...local, loopback2: false }).notes.length, 1);
  assert.equal(plan(rust("-p dbee-core"), { ...local, loopback2: false }).notes.length, 0);
  assert.equal(plan(rust("--workspace"), { ...local, loopback2: true }).notes.length, 0);
  assert.match(argv(plan(rust("--workspace"), local), "cargo test"), /--no-fail-fast$/);
});

test("what the machine lacks is listed, not run", () => {
  const p = plan({ ...none, jobs: { ...none.jobs, rust: true, typescript: true } }, { cargoDeny: false, postgres: false, nodeModules: false });
  assert.ok(!names(p).includes("cargo deny"));
  assert.equal(names(p)[1], "cargo fmt");
  assert.ok(names(p).includes("pnpm install"), "installs first when node_modules is missing");
  for (const n of ["cargo deny", "PostgreSQL tests"]) assert.ok(p.skipped.some((s) => s.name === n), n);
});

test("everything: the CI-only parts are named", () => {
  const p = plan({ ...none, all: true, jobs: { rust: true, typescript: true, dbee_desktop: true, dbee_budget: true, mightyconsole: true }, args: { cargo: "--workspace", pnpm: "--recursive", pnpm_build: "--recursive" }, lab_tools: "all" }, local);
  assert.equal(argv(p, "cargo test"), "cargo test --workspace --locked --no-fail-fast");
  assert.equal(argv(p, "test"), "pnpm --recursive run --if-present test");
  const skipped = p.skipped.map((s) => s.name);
  for (const n of ["Mightyconsole in Chrome", "the Mightyconsole lab (all)", "DBee desktop on Windows and macOS", "DBee desktop budget"]) assert.ok(skipped.includes(n), n);
});
