#!/usr/bin/env node
// License policy check (ADR "Repository layout and licensing", Notion DOC-10):
// 1. Every workspace crate and package declares one of the allowed licenses.
// 2. No permissive crate or package depends, directly or transitively, on an AGPL one.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const PERMISSIVE = "MIT OR Apache-2.0";
const ALLOWED = new Set([PERMISSIVE, "AGPL-3.0-only"]);
const isAgpl = (license) => /AGPL/.test(license ?? "");
const errors = [];

// Rust: full resolved graph from cargo metadata.
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
);
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const deps = new Map(meta.resolve.nodes.map((n) => [n.id, n.dependencies]));

for (const id of meta.workspace_members) {
  const pkg = pkgs.get(id);
  if (!ALLOWED.has(pkg.license)) {
    errors.push(`crate ${pkg.name}: license must be one of ${[...ALLOWED].join(", ")} (got ${pkg.license ?? "none"})`);
  }
}

for (const id of meta.workspace_members) {
  const root = pkgs.get(id);
  if (isAgpl(root.license)) continue;
  const seen = new Set([id]);
  const stack = [[id, [root.name]]];
  while (stack.length > 0) {
    const [cur, path] = stack.pop();
    for (const dep of deps.get(cur) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const depPkg = pkgs.get(dep);
      const depPath = [...path, depPkg.name];
      if (isAgpl(depPkg.license)) {
        errors.push(`crate ${root.name} is permissive but depends on AGPL code: ${depPath.join(" -> ")}`);
      }
      stack.push([dep, depPath]);
    }
  }
}

// TypeScript: root package.json plus every workspace package.
const manifests = ["package.json"];
for (const dir of ["packages", "apps"]) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name, "package.json");
    if (entry.isDirectory() && existsSync(path)) manifests.push(path);
  }
}
const npm = new Map();
for (const path of manifests) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  npm.set(json.name, { path, json });
  if (!ALLOWED.has(json.license)) {
    errors.push(`${path}: license must be one of ${[...ALLOWED].join(", ")} (got ${json.license ?? "none"})`);
  }
}
const npmDeps = (json) =>
  Object.keys({ ...json.dependencies, ...json.peerDependencies, ...json.optionalDependencies });
for (const [name, { path, json }] of npm) {
  if (isAgpl(json.license)) continue;
  const seen = new Set([name]);
  const stack = [[name, [name]]];
  while (stack.length > 0) {
    const [cur, chain] = stack.pop();
    for (const dep of npmDeps(npm.get(cur)?.json ?? {})) {
      if (seen.has(dep) || !npm.has(dep)) continue;
      seen.add(dep);
      const depChain = [...chain, dep];
      if (isAgpl(npm.get(dep).json.license)) {
        errors.push(`${path} is permissive but depends on AGPL code: ${depChain.join(" -> ")}`);
      }
      stack.push([dep, depChain]);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`License policy OK (${meta.workspace_members.length} crates, ${manifests.length} package.json files).`);
