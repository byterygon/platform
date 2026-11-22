#!/usr/bin/env node
// What a change affects, from the real dependency graphs, Nx-style but without Nx (TSK-89).
//
//   node scripts/affected.mjs [--base <ref>] [--head <ref>] [--event <name>] [--files a,b,...]
//                             [--github-output] [--pretty]
//
// The files changed between the merge base of --base (default origin/main) and --head (default
// the working tree, so uncommitted changes count) are mapped to:
//   - pnpm packages: a file's package, then every package that depends on it (pnpm's
//     `--filter "...[<base>]"` selection); pnpm-lock.yaml is diffed per importer, so a lockfile
//     change affects only the packages whose resolved dependencies changed;
//   - Cargo crates: a file's crate, then every workspace crate that depends on it (the resolved
//     graph in Cargo.lock, dev and build dependencies included); Cargo.lock is diffed per crate
//     (the crate's whole resolved dependency closure), the root Cargo.toml affects every crate;
//   - the JS-Rust edges and the run-everything rules of scripts/affected-rules.mjs, followed to a
//     fixed point (a UI package affects the crate that embeds it, and so on).
// A file that no rule, package or crate claims runs everything. Pushes, tags, manual and
// scheduled runs run everything (--event).
//
// Prints one JSON document: whether everything runs and why, the affected crates and packages,
// the jobs to switch on, and ready-made arguments (`cargo_args`, `pnpm_select`, ...). With
// --github-output it also appends those as step outputs to $GITHUB_OUTPUT. Plain ESM, no
// dependencies: it runs before `pnpm install` and without the Rust toolchain.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ALL_RUST, EDGES, LAB_NEUTRAL_FILES, LAB_TOOL_EXTRA, LAB_TOOL_FILES, NO_TARGETS, RUN_ALL } from "./affected-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Events that always run everything. */
export const RUN_ALL_EVENTS = new Set(["push", "workflow_dispatch", "schedule", "merge_group", "release", "repository_dispatch"]);

// ---------------------------------------------------------------------------------------------
// Globs

const globCache = new Map();
/** A repository-relative glob as a RegExp: `*` within a segment, `**` across segments. */
export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      src += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") src += "[^/]*";
    else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}
export const matches = (file, globs) => globs.some((g) => globToRegExp(g).test(file));

// ---------------------------------------------------------------------------------------------
// The workspace: pnpm packages and Cargo crates

/** The pnpm workspace's packages: name, dir (repo-relative, posix) and workspace dependencies. */
export function readPnpmWorkspace(root = ROOT) {
  const yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const globs = [];
  let inPackages = false;
  for (const line of yaml.split("\n")) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line);
    else if (inPackages) {
      const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*$/);
      if (m) globs.push(m[1]);
    }
  }
  const dirs = new Set();
  for (const g of globs) {
    if (g.startsWith("!")) continue;
    const parts = g.split("/");
    let found = [""];
    for (const part of parts) {
      const next = [];
      for (const base of found) {
        if (part.includes("*")) {
          const re = globToRegExp(part);
          const abs = join(root, base);
          if (!existsSync(abs)) continue;
          for (const e of readdirSync(abs, { withFileTypes: true })) if (e.isDirectory() && re.test(e.name)) next.push(posix.join(base, e.name));
        } else next.push(posix.join(base, part));
      }
      found = next;
    }
    for (const d of found) if (existsSync(join(root, d, "package.json"))) dirs.add(d);
  }
  const packages = new Map();
  for (const dir of [...dirs].sort()) {
    const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8"));
    if (!pkg.name) continue;
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies };
    packages.set(pkg.name, { name: pkg.name, dir, deps: Object.keys(deps) });
  }
  // Only workspace packages count as edges (pnpm links them whatever the specifier says).
  for (const p of packages.values()) p.deps = p.deps.filter((d) => packages.has(d) && d !== p.name);
  return packages;
}

/** The Cargo workspace's members: name and dir, from the root Cargo.toml and each member's. */
export function readCargoWorkspace(root = ROOT) {
  const toml = readFileSync(join(root, "Cargo.toml"), "utf8");
  const block = toml.match(/^\s*members\s*=\s*\[([^\]]*)\]/m);
  if (!block) throw new Error("Cargo.toml: no [workspace] members list");
  const crates = new Map();
  for (const m of block[1].matchAll(/"([^"]+)"/g)) {
    const dir = m[1];
    if (dir.includes("*")) throw new Error(`Cargo.toml: member globs are not supported by affected.mjs (${dir})`);
    const manifest = readFileSync(join(root, dir, "Cargo.toml"), "utf8");
    const pkg = manifest.split(/^\[/m).find((s) => s.startsWith("package]"));
    const name = pkg?.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (!name) throw new Error(`${dir}/Cargo.toml: no [package] name`);
    crates.set(name, { name, dir });
  }
  return crates;
}

// ---------------------------------------------------------------------------------------------
// Cargo.lock

/** Cargo.lock's packages: id (`name version source`) -> { name, version, source, checksum, deps }. */
export function parseCargoLock(text) {
  const entries = [];
  for (const chunk of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const get = (k) => chunk.match(new RegExp(`^${k} = "([^"]*)"`, "m"))?.[1] ?? "";
    const depsBlock = chunk.match(/^dependencies = \[([\s\S]*?)\]/m)?.[1] ?? "";
    entries.push({
      name: get("name"),
      version: get("version"),
      source: get("source"),
      checksum: get("checksum"),
      deps: [...depsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    });
  }
  const byName = new Map();
  for (const e of entries) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  // A dependency is written `name`, `name version` or `name version (source)` when ambiguous.
  const resolveDep = (dep) => {
    const [name, version, ...rest] = dep.split(" ");
    const source = rest.join(" ").replace(/^\(|\)$/g, "");
    const candidates = (byName.get(name) ?? []).filter((e) => (!version || e.version === version) && (!source || e.source === source));
    if (candidates.length !== 1) throw new Error(`Cargo.lock: cannot resolve dependency "${dep}"`);
    return candidates[0];
  };
  const id = (e) => `${e.name} ${e.version} ${e.source}`;
  const graph = new Map();
  for (const e of entries) graph.set(id(e), { ...e, id: id(e), deps: e.deps.map((d) => id(resolveDep(d))) });
  return graph;
}

/** Every id reachable from `start` (itself included). */
function closure(graph, start) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id) || !graph.has(id)) continue;
    seen.add(id);
    stack.push(...graph.get(id).deps);
  }
  return seen;
}

/**
 * The workspace crates whose resolved dependency closure differs between two Cargo.lock texts:
 * an external package added, removed, or changed in version, source, checksum or dependencies.
 * Edges between workspace crates are compared too; their sources are followed separately.
 */
export function cargoLockAffected(oldText, newText, crateNames) {
  if (oldText === newText) return new Set();
  const before = parseCargoLock(oldText);
  const after = parseCargoLock(newText);
  const sig = (graph, id) => {
    const e = graph.get(id);
    return `${e.id}|${e.checksum}|${e.deps.join(",")}`;
  };
  const member = (graph, name) => [...graph.values()].find((e) => e.name === name && !e.source)?.id;
  const out = new Set();
  for (const name of crateNames) {
    const a = member(before, name);
    const b = member(after, name);
    if (!a || !b) {
      out.add(name);
      continue;
    }
    const left = [...closure(before, a)].map((id) => sig(before, id)).sort().join("\n");
    const right = [...closure(after, b)].map((id) => sig(after, id)).sort().join("\n");
    if (left !== right) out.add(name);
  }
  return out;
}

/** Workspace-internal edges from Cargo.lock: crate -> the workspace crates it depends on. */
export function cargoWorkspaceEdges(lockText, crateNames) {
  const graph = parseCargoLock(lockText);
  const names = new Set(crateNames);
  const edges = new Map();
  for (const e of graph.values()) {
    if (e.source || !names.has(e.name)) continue;
    edges.set(e.name, e.deps.map((id) => graph.get(id)).filter((d) => !d.source && names.has(d.name)).map((d) => d.name));
  }
  return edges;
}

// ---------------------------------------------------------------------------------------------
// pnpm-lock.yaml (lockfile v9; pnpm 11+ writes an environment document first)

const unquote = (s) => s.trim().replace(/^'(.*)'$/, "$1").replace(/^"(.*)"$/, "$1");

/** Splits a YAML mapping at `indent` spaces into [key, block text including nested lines]. */
function blocks(lines, indent) {
  const out = [];
  const head = new RegExp(`^ {${indent}}(?! )(.+?):(?:\\s(.*))?$`);
  for (const line of lines) {
    const m = line.match(head);
    if (m) out.push([unquote(m[1]), [line]]);
    else if (out.length && (line.startsWith(" ".repeat(indent + 1)) || line.trim() === "")) out.at(-1)[1].push(line);
    else if (line.trim() !== "" && out.length) out.push([null, [line]]);
  }
  return out.filter(([k]) => k !== null).map(([k, ls]) => [k, ls.join("\n").trimEnd()]);
}

/** One lockfile document: its top-level sections, importers, packages and snapshots. */
function parsePnpmDocument(text) {
  const sections = new Map();
  let current = null;
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z][\w-]*):(.*)$/);
    if (m) {
      current = m[1];
      sections.set(current, [line]);
    } else if (current) sections.get(current).push(line);
  }
  const section = (name) => (sections.get(name) ?? []).slice(1);
  const importers = new Map(blocks(section("importers"), 2));
  const packages = new Map(blocks(section("packages"), 2));
  const snapshots = new Map(blocks(section("snapshots"), 2));
  const other = [...sections].filter(([k]) => !["importers", "packages", "snapshots"].includes(k)).map(([, ls]) => ls.join("\n").trimEnd()).join("\n");
  return { importers, packages, snapshots, other };
}

/** `name` + a lockfile version value -> the snapshot key it points at, or null for links. */
function snapshotKey(name, version) {
  const v = unquote(version);
  if (v.startsWith("link:") || v.startsWith("file:")) return null;
  // An alias (`string-width-cjs: string-width@4.2.3`) carries its own name.
  if (/^(@[^/]+\/)?[^@/(][^@(]*@/.test(v)) return v;
  return `${name}@${v}`;
}

/** Dependency keys listed in a block (`name:` then `version: x` for importers, `name: x` for snapshots). */
function depKeys(block, importer) {
  const keys = [];
  const lines = block.split("\n");
  if (importer) {
    for (let i = 0; i < lines.length; i++) {
      const name = lines[i].match(/^ {6}(?! )(.+?):\s*$/);
      const version = name && lines[i + 1]?.match(/^ {8}specifier:/) ? lines[i + 2]?.match(/^ {8}version:\s*(.+)$/) : name && lines[i + 1]?.match(/^ {8}version:\s*(.+)$/);
      if (name && version) {
        const key = snapshotKey(unquote(name[1]), version[1]);
        if (key) keys.push(key);
      }
    }
  } else {
    for (const line of lines) {
      const m = line.match(/^ {6}(?! )(.+?):\s+(.+)$/);
      if (m) {
        const key = snapshotKey(unquote(m[1]), m[2]);
        if (key) keys.push(key);
      }
    }
  }
  return keys;
}

const stripPeers = (key) => key.replace(/\(.*$/, "");

/** The importer's resolved closure as text: its own block, then every snapshot and package entry. */
function importerSignature(doc, importer) {
  const own = doc.importers.get(importer);
  if (own === undefined) return null;
  const seen = new Set();
  const stack = depKeys(own, true);
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = doc.snapshots.get(key);
    if (snap) stack.push(...depKeys(snap, false));
  }
  const parts = [...seen].sort().map((k) => `${doc.snapshots.get(k) ?? `${k}: (missing)`}\n${doc.packages.get(stripPeers(k)) ?? ""}`);
  return [own, ...parts].join("\n");
}

/**
 * The importers (package dirs, "." for the root) whose resolved dependencies differ between two
 * pnpm-lock.yaml texts, or `all: true` when lockfile-wide settings changed (lockfile version,
 * settings, overrides, catalogs, the environment document with pnpm itself).
 */
export function pnpmLockAffected(oldText, newText) {
  if (oldText === newText) return { all: false, importers: new Set() };
  const docs = (t) => t.split(/^---\s*$/m).filter((d) => d.trim() !== "");
  const before = docs(oldText);
  const after = docs(newText);
  if (before.length !== after.length) return { all: true, reason: "pnpm-lock.yaml: its documents changed", importers: new Set() };
  // Every document but the last is the environment lockfile (pnpm itself): any change runs all.
  for (let i = 0; i < before.length - 1; i++) {
    if (before[i] !== after[i]) return { all: true, reason: "pnpm-lock.yaml: the package manager's own lockfile changed", importers: new Set() };
  }
  const a = parsePnpmDocument(before.at(-1));
  const b = parsePnpmDocument(after.at(-1));
  if (a.other !== b.other) return { all: true, reason: "pnpm-lock.yaml: lockfile-wide settings changed", importers: new Set() };
  const importers = new Set();
  for (const imp of new Set([...a.importers.keys(), ...b.importers.keys()])) {
    if (importerSignature(a, imp) !== importerSignature(b, imp)) importers.add(imp);
  }
  return { all: false, importers };
}

// ---------------------------------------------------------------------------------------------
// The computation

/** The dependents closure of `start` over `deps` (name -> names it depends on). */
function withDependents(start, deps) {
  const reverse = new Map();
  for (const [name, ds] of deps) for (const d of ds) reverse.set(d, [...(reverse.get(d) ?? []), name]);
  const seen = new Set();
  const stack = [...start];
  while (stack.length) {
    const n = stack.pop();
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...(reverse.get(n) ?? []));
  }
  return seen;
}

/** The project (package or crate) a file belongs to: the longest dir that contains it. */
function owner(file, projects) {
  let best = null;
  for (const p of projects) {
    if (p.dir !== "." && (file === p.dir || file.startsWith(`${p.dir}/`)) && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

/**
 * The pure part: everything here comes in as data, so the tests need neither git nor tools.
 *
 * @param {object} input
 * @param {string[]} input.files repository-relative paths changed against the base
 * @param {string} [input.event] the GitHub event (pushes and the like run everything)
 * @param {Map} input.packages from readPnpmWorkspace
 * @param {Map} input.crates from readCargoWorkspace
 * @param {Map} input.crateDeps crate -> workspace crates it depends on (cargoWorkspaceEdges)
 * @param {{old: string, new: string}} [input.cargoLock] Cargo.lock at the base and now
 * @param {{old: string, new: string}} [input.pnpmLock] pnpm-lock.yaml at the base and now
 * @param {object} [input.rules] { RUN_ALL, ALL_RUST, EDGES, NO_TARGETS }
 */
export function computeAffected({ files, event = "pull_request", packages, crates, crateDeps, cargoLock, pnpmLock, rules = { RUN_ALL, ALL_RUST, EDGES, NO_TARGETS } }) {
  const reasons = [];
  let all = false;
  const runAll = (why) => {
    all = true;
    reasons.push(why);
  };
  if (RUN_ALL_EVENTS.has(event)) runAll(`event ${event} runs everything`);

  const pkgs = new Set();
  const crs = new Set();
  const targets = new Set();
  const allRust = { on: false };
  const projects = [
    ...[...packages.values()].map((p) => ({ kind: "package", name: p.name, dir: p.dir })),
    ...[...crates.values()].map((c) => ({ kind: "crate", name: c.name, dir: c.dir })),
  ];

  for (const file of files) {
    if (matches(file, rules.RUN_ALL)) {
      runAll(`${file} runs everything`);
      continue;
    }
    if (file === "Cargo.lock") {
      if (cargoLock) for (const c of cargoLockAffected(cargoLock.old, cargoLock.new, [...crates.keys()])) crs.add(c);
      else runAll("Cargo.lock changed and no base version to diff");
      continue;
    }
    if (file === "pnpm-lock.yaml") {
      if (!pnpmLock) {
        runAll("pnpm-lock.yaml changed and no base version to diff");
        continue;
      }
      const diff = pnpmLockAffected(pnpmLock.old, pnpmLock.new);
      if (diff.all) runAll(diff.reason);
      for (const dir of diff.importers) {
        if (dir === ".") continue; // the root's own tools: RUN_ALL covers package.json
        const p = [...packages.values()].find((x) => x.dir === dir);
        if (p) pkgs.add(p.name);
        else runAll(`pnpm-lock.yaml: importer ${dir} is not a workspace package`);
      }
      continue;
    }
    if (matches(file, rules.ALL_RUST)) {
      allRust.on = true;
      reasons.push(`${file} affects every crate`);
      continue;
    }
    let claimed = false;
    for (const edge of rules.EDGES) {
      if (edge.files && matches(file, edge.files)) {
        claimed = true;
        for (const c of edge.affects.crates ?? []) crs.add(c);
        for (const p of edge.affects.packages ?? []) pkgs.add(p);
        for (const t of edge.affects.targets ?? []) targets.add(t);
      }
    }
    if (matches(file, rules.NO_TARGETS)) continue;
    const o = owner(file, projects);
    if (o?.kind === "package") pkgs.add(o.name);
    else if (o?.kind === "crate") crs.add(o.name);
    else if (!claimed) runAll(`${file} belongs to no package, crate or rule`);
  }

  if (allRust.on) for (const c of crates.keys()) crs.add(c);

  // Dependents in each graph, then the JS-Rust edges, until nothing more is added.
  const pkgDeps = new Map([...packages.values()].map((p) => [p.name, p.deps]));
  for (;;) {
    const sizes = pkgs.size + crs.size + targets.size;
    for (const p of withDependents(pkgs, pkgDeps)) pkgs.add(p);
    for (const c of withDependents(crs, crateDeps)) crs.add(c);
    for (const edge of rules.EDGES) {
      const from = (edge.package && pkgs.has(edge.package)) || (edge.crate && crs.has(edge.crate));
      if (!from) continue;
      for (const c of edge.affects.crates ?? []) crs.add(c);
      for (const p of edge.affects.packages ?? []) pkgs.add(p);
      for (const t of edge.affects.targets ?? []) targets.add(t);
    }
    if (pkgs.size + crs.size + targets.size === sizes) break;
  }

  for (const name of crs) if (!crates.has(name)) throw new Error(`affected-rules: unknown crate ${name}`);
  for (const name of pkgs) if (!packages.has(name)) throw new Error(`affected-rules: unknown package ${name}`);
  // The names end up as shell words in ci.yml (`cargo test -p a`, `pnpm --filter a`).
  for (const name of [...crates.keys(), ...packages.keys()]) {
    if (!/^@?[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)?$/.test(name)) throw new Error(`unexpected characters in the name ${JSON.stringify(name)}`);
  }

  const allCrates = all || [...crates.keys()].every((c) => crs.has(c));
  const allPackages = all || [...packages.keys()].every((p) => pkgs.has(p));
  const crateList = all ? [...crates.keys()].sort() : [...crs].sort();
  const packageList = all ? [...packages.keys()].sort() : [...pkgs].sort();
  const has = (list, name) => list.includes(name);
  if (!all && !crateList.length && !packageList.length && !targets.size) reasons.push("nothing to build or test (documentation or licence files only)");

  return {
    all,
    reasons,
    files: files.length,
    crates: crateList,
    packages: packageList,
    jobs: {
      rust: crateList.length > 0,
      typescript: packageList.length > 0,
      dbee_desktop: has(crateList, "dbee-desktop"),
      dbee_budget: has(crateList, "dbee-desktop") || targets.has("dbee-budget") || all,
      mightyconsole: has(crateList, "mightyconsole-server") || has(packageList, "@byterygon/mightyconsole"),
    },
    args: {
      cargo: allCrates ? "--workspace" : crateList.map((c) => `-p ${c}`).join(" "),
      pnpm: allPackages ? "--recursive" : packageList.map((p) => `--filter ${p}`).join(" "),
      // Building needs the affected packages' own dependencies too (pnpm's `<pkg>...`).
      pnpm_build: allPackages ? "--recursive" : packageList.map((p) => `--filter ${p}...`).join(" "),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Mightyconsole lab: which tools' profiles a change needs (TSK-89, batch 3)

/** The lab's tools, from apps/mightyconsole/lab/lab.mts (`export const TOOLS = [...]`). */
export function readLabTools(root = ROOT) {
  const src = readFileSync(join(root, "apps/mightyconsole/lab/lab.mts"), "utf8");
  const m = src.match(/export const TOOLS = \[([^\]]*)\]/);
  if (!m) throw new Error("apps/mightyconsole/lab/lab.mts: no TOOLS list");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

/**
 * The lab profiles a change needs: "all", "none", or the tools whose own files alone changed
 * (LAB_TOOL_FILES, LAB_TOOL_EXTRA). LAB_NEUTRAL_FILES follow the tools they come with (alone,
 * they need every tool). Any other file that affects Mightyconsole needs every tool.
 * Takes computeAffected's input.
 */
export function labTools(input, tools, rules = { LAB_TOOL_FILES, LAB_TOOL_EXTRA, LAB_NEUTRAL_FILES }) {
  const whole = computeAffected(input);
  if (whole.all) return "all";
  if (!whole.jobs.mightyconsole) return "none";
  const out = new Set();
  let neutral = false;
  for (const file of input.files) {
    const tool =
      tools.find((t) => matches(file, rules.LAB_TOOL_FILES.map((g) => g.replaceAll("<tool>", t)))) ??
      rules.LAB_TOOL_EXTRA.find((e) => matches(file, e.files))?.tool;
    if (tool) {
      out.add(tool);
      continue;
    }
    if (matches(file, rules.LAB_NEUTRAL_FILES ?? [])) {
      neutral = true;
      continue;
    }
    const one = computeAffected({ ...input, files: [file] });
    if (one.all || one.jobs.mightyconsole) return "all";
  }
  if (out.size) return [...out].sort();
  return neutral ? "all" : "none";
}

// ---------------------------------------------------------------------------------------------
// Command line

const git = (args, root = ROOT) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 << 20 });
const gitShow = (rev, path, root) => {
  try {
    return git(["show", `${rev}:${path}`], root);
  } catch {
    return "";
  }
};

/** Files changed from the merge base of `base` to `head` (or the working tree, untracked included). */
export function changedFiles(base, head, root = ROOT) {
  const mergeBase = git(["merge-base", base, head ?? "HEAD"], root).trim();
  const diff = head ? git(["diff", "--name-only", "--no-renames", mergeBase, head], root) : git(["diff", "--name-only", "--no-renames", mergeBase], root);
  const untracked = head ? "" : git(["ls-files", "--others", "--exclude-standard"], root);
  return { mergeBase, files: [...new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean))].sort() };
}

export function run(argv = process.argv.slice(2), root = ROOT) {
  const { values: opt } = parseArgs({
    args: argv,
    options: {
      base: { type: "string", default: "origin/main" },
      head: { type: "string" },
      event: { type: "string", default: process.env.GITHUB_EVENT_NAME ?? "pull_request" },
      files: { type: "string" },
      "github-output": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (opt.help) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 26).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return null;
  }
  const packages = readPnpmWorkspace(root);
  const crates = readCargoWorkspace(root);
  const now = (path) => (opt.head ? gitShow(opt.head, path, root) : readFileSync(join(root, path), "utf8"));
  let files;
  let mergeBase = null;
  if (opt.files !== undefined) files = opt.files.split(",").map((f) => f.trim()).filter(Boolean);
  else if (RUN_ALL_EVENTS.has(opt.event)) files = [];
  else ({ mergeBase, files } = changedFiles(opt.base, opt.head, root));
  const base = mergeBase ?? (opt.files !== undefined ? git(["merge-base", opt.base, opt.head ?? "HEAD"], root).trim() : null);
  const lock = (path) => (base ? { old: gitShow(base, path, root), new: now(path) } : undefined);
  const input = {
    files,
    event: opt.event,
    packages,
    crates,
    crateDeps: cargoWorkspaceEdges(now("Cargo.lock"), [...crates.keys()]),
    cargoLock: files.includes("Cargo.lock") ? lock("Cargo.lock") : undefined,
    pnpmLock: files.includes("pnpm-lock.yaml") ? lock("pnpm-lock.yaml") : undefined,
  };
  const result = computeAffected(input);
  const lab = labTools(input, readLabTools(root));
  result.lab_tools = lab;
  result.base = base;
  console.log(JSON.stringify(result, null, opt.pretty ? 2 : 0));
  if (opt["github-output"]) {
    // ci.yml tests each output with `!= 'false'`, so a missing output (the job failed) runs the
    // job anyway: every output below is written, and written as false only when not needed.
    const out = process.env.GITHUB_OUTPUT;
    if (!out) throw new Error("--github-output: GITHUB_OUTPUT is not set");
    const lines = [
      `all=${result.all}`,
      ...Object.entries(result.jobs).map(([k, v]) => `${k}=${v}`),
      `cargo_args=${result.args.cargo}`,
      `pnpm_select=${result.args.pnpm}`,
      `pnpm_build_select=${result.args.pnpm_build}`,
      // Space-separated, for `contains(format(' {0} ', list), ' name ')` and shell `case`.
      `crate_list=${result.crates.join(" ")}`,
      `package_list=${result.packages.join(" ")}`,
      // The Mightyconsole lab's profiles: "all", "none" or the tools, space-separated.
      `lab_tools=${Array.isArray(lab) ? lab.join(" ") : lab}`,
    ];
    appendFileSync(out, `${lines.join("\n")}\n`);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (e) {
    console.error(`affected: ${e.message}`);
    process.exit(1);
  }
}

