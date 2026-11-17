#!/usr/bin/env node
// Third-party notices for a product: the DBee desktop app (TSK-62, the default) or the
// Mightyconsole server with its built-in UI (TSK-87, `--app mightyconsole`).
//
// Lists what ships in the installer and the licence text of each part:
//   - Rust: the normal (runtime) dependency closure of the product's binary crate from `cargo metadata`
//     (all platforms, a superset of any one installer), taken from Cargo.lock.
//   - npm: the runtime `dependencies` closure of the product's UI package (what the UI bundle may
//     contain), resolved through the installed pnpm store.
//   - Vendored fonts and icons: packages/*/fonts and packages/*/icons manifests.
// Licence texts are read from the crates' and packages' own files; nothing is fetched, so it runs
// offline once `cargo fetch` and `pnpm install` have run. It fails when a component has no
// licence text, so the notices are complete or the build says why not.
//
// Usage: node scripts/third-party-notices.mjs [--app dbee|mightyconsole] [--out <file>]
//        (defaults: dbee, THIRD-PARTY-NOTICES.txt)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const outIndex = process.argv.indexOf("--out");
const out = outIndex > 0 ? process.argv[outIndex + 1] : "THIRD-PARTY-NOTICES.txt";
const PRODUCTS = {
  dbee: { name: "DBee", crate: "dbee-desktop", ui: "apps/dbee/ui" },
  mightyconsole: { name: "Mightyconsole", crate: "mightyconsole-server", ui: "apps/mightyconsole/ui" },
};
const appIndex = process.argv.indexOf("--app");
const product = PRODUCTS[appIndex > 0 ? process.argv[appIndex + 1] : "dbee"];
if (!product) throw new Error(`--app: one of ${Object.keys(PRODUCTS).join(", ")}`);
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-_.].*)?$/i;
const problems = [];
const components = []; // { ecosystem, name, version, license, source, texts: [{file, text}] }

const licenseTexts = (dir) => {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ file: e.name, text: readFileSync(join(dir, e.name), "utf8").replace(/\r\n/g, "\n").trim() }))
    .filter((t) => t.text.length > 0);
};

// Rust ---------------------------------------------------------------------------------------
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }),
);
const pkgs = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const root = meta.packages.find((p) => p.name === product.crate && p.source == null);
if (!root) throw new Error(`${product.crate} is not in the workspace`);
const seen = new Set([root.id]);
const stack = [root.id];
while (stack.length > 0) {
  for (const dep of nodes.get(stack.pop())?.deps ?? []) {
    // `dep_kinds` kind null is a normal dependency; build and dev dependencies are not shipped.
    if (!dep.dep_kinds.some((k) => k.kind === null) || seen.has(dep.pkg)) continue;
    seen.add(dep.pkg);
    stack.push(dep.pkg);
  }
}
let firstParty = 0;
for (const id of seen) {
  const p = pkgs.get(id);
  if (p.source == null) {
    firstParty += 1; // workspace crates: AGPL-3.0-only (the app's LICENSE) or MIT OR Apache-2.0
    continue;
  }
  const dir = dirname(p.manifest_path);
  let texts = licenseTexts(dir);
  // A crate that lives in a workspace of its own repository may keep the text at the root.
  if (texts.length === 0 && p.license_file) texts = licenseTexts(dirname(join(dir, p.license_file)));
  components.push({ ecosystem: "Rust", name: p.name, version: p.version, license: p.license ?? "(see licence file)", source: p.repository ?? "", authors: p.authors ?? [], texts });
}

// npm ----------------------------------------------------------------------------------------
const uiDir = product.ui;
const npmSeen = new Map();
const walk = (dir) => {
  const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  for (const name of Object.keys({ ...json.dependencies, ...json.optionalDependencies })) {
    let path;
    for (let at = dir; ; at = dirname(at)) {
      const candidate = join(at, "node_modules", name);
      if (existsSync(join(candidate, "package.json"))) {
        path = realpathSync(candidate);
        break;
      }
      if (at === dirname(at)) break;
    }
    if (!path) {
      // Optional platform packages that were not installed here are not part of this build.
      if (!json.optionalDependencies?.[name]) problems.push(`npm ${name} (needed by ${json.name}) is not installed; run pnpm install`);
      continue;
    }
    if (npmSeen.has(path)) continue;
    npmSeen.set(path, name);
    // design-tokens' own dependency (Style Dictionary) is build tooling for the token CLI; the UI
    // bundle imports only its generated CSS and the Monaco theme.
    if (name !== "@byterygon/design-tokens") walk(path);
  }
};
walk(uiDir);
let workspaceNpm = 0;
for (const path of npmSeen.keys()) {
  const json = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  if (json.name?.startsWith("@byterygon/")) {
    workspaceNpm += 1; // first-party, licence declared in its package.json
    continue;
  }
  const license = typeof json.license === "string" ? json.license : (json.license?.type ?? json.licenses?.map((l) => l.type).join(" OR ") ?? "(see licence file)");
  components.push({
    ecosystem: "npm",
    name: json.name,
    version: json.version,
    license,
    source: typeof json.repository === "string" ? json.repository : (json.repository?.url ?? ""),
    texts: licenseTexts(path),
  });
}

// Vendored fonts and icons -------------------------------------------------------------------
for (const parent of ["packages", "apps"]) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const fontsDir = join(parent, entry.name, "fonts");
    const fontManifest = join(fontsDir, "manifest.json");
    if (entry.isDirectory() && existsSync(fontManifest)) {
      for (const font of JSON.parse(readFileSync(fontManifest, "utf8")).fonts ?? []) {
        components.push({
          ecosystem: "Font",
          name: font.family,
          version: font.version ?? "",
          license: font.license,
          source: font.source ?? font.url ?? "",
          texts: (font.licenseFiles ?? []).map((f) => ({ file: f, text: readFileSync(join(fontsDir, f), "utf8").replace(/\r\n/g, "\n").trim() })),
        });
      }
    }
    const iconsDir = join(parent, entry.name, "icons");
    const iconManifest = join(iconsDir, "manifest.json");
    if (entry.isDirectory() && existsSync(iconManifest)) {
      const { source = {} } = JSON.parse(readFileSync(iconManifest, "utf8"));
      components.push({
        ecosystem: "Icons",
        name: source.name ?? source.package ?? "Fluent UI System Icons",
        version: source.version ?? "",
        license: source.license ?? "MIT",
        source: source.url ?? source.repository ?? "",
        texts: [{ file: source.licenseFile ?? "LICENSE", text: readFileSync(join(iconsDir, source.licenseFile ?? "LICENSE"), "utf8").replace(/\r\n/g, "\n").trim() }],
      });
    }
  }
}

// Some crates and packages are published without their licence file. The standard text of the
// licence they declare stands in, with the copyright line taken from the manifest's authors or, when
// there are none, the project's repository; the component's entry in the list says so.
const harvest = (pattern, from = 0) => {
  for (const c of components) for (const t of c.texts) if (pattern.test(t.text)) return t.text.slice(Math.max(0, t.text.search(pattern) - from));
  return undefined;
};
const BSD3 = `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`;
const templates = {
  MIT: harvest(/Permission is hereby granted, free of charge/),
  "Apache-2.0": harvest(/Apache License\s+Version 2\.0, January 2004/),
  "MPL-2.0": harvest(/Mozilla Public License Version 2\.0/),
  "BSD-3-Clause": BSD3,
};
for (const c of components) {
  if (c.texts.length > 0) continue;
  const terms = c.license.split(/\s+OR\s+|\//).map((t) => t.trim());
  const id = ["MIT", "Apache-2.0", "BSD-3-Clause", "MPL-2.0"].find((t) => terms.includes(t) && templates[t]);
  if (!id) continue;
  const holder = c.authors?.length ? c.authors.join(", ") : `the ${c.name} authors${c.source ? ` (${c.source})` : ""}`;
  const copyright = id === "Apache-2.0" || id === "MPL-2.0" ? "" : `Copyright (c) ${holder}\n\n`;
  c.texts = [{ file: "(standard text)", text: `${copyright}${templates[id]}`.trim(), standard: id }];
  c.license += ` (licence file not published with the package; standard ${id} text)`;
}

for (const c of components) {
  if (c.texts.length === 0) problems.push(`${c.ecosystem} ${c.name}@${c.version} (${c.license}): no licence text found`);
}
if (problems.length > 0) {
  console.error(`third-party notices are incomplete:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}

// Output -------------------------------------------------------------------------------------
components.sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
const byText = new Map(); // sha -> { text, users: [label] }
const label = (c) => `${c.name} ${c.version}`.trim();
for (const c of components) {
  for (const t of c.texts) {
    const sha = createHash("sha256").update(t.text).digest("hex");
    if (!byText.has(sha)) byText.set(sha, { text: t.text, users: [] });
    byText.get(sha).users.push(`${c.ecosystem}: ${label(c)}`);
  }
}
const bar = "=".repeat(78);
const lines = [
  `${product.name} third-party notices`,
  "",
  `${product.name} is licensed under AGPL-3.0-only (see LICENSE). It contains the components below, each under`,
  "its own licence. This file is generated by scripts/third-party-notices.mjs from Cargo.lock,",
  "pnpm-lock.yaml and the vendored font and icon manifests.",
  "",
  `First-party parts: ${firstParty} Rust crates of this repository (AGPL-3.0-only or MIT OR Apache-2.0)`,
  `and ${workspaceNpm} @byterygon npm packages (same licences).`,
  "",
  `${components.length} third-party components:`,
  "",
  ...components.map((c) => `- [${c.ecosystem}] ${label(c)} - ${c.license}${c.source ? ` - ${c.source}` : ""}`),
  "",
  bar,
  "LICENCE TEXTS",
  bar,
];
let n = 0;
for (const { text, users } of [...byText.values()].sort((a, b) => b.users.length - a.users.length || a.text.localeCompare(b.text))) {
  n += 1;
  lines.push("", `--- Licence text ${n}, used by ${users.length} component${users.length === 1 ? "" : "s"} ---`, ...users.map((u) => `  ${u}`), "", text);
}
writeFileSync(out, `${lines.join("\n")}\n`);
console.log(`${out}: ${components.length} components, ${byText.size} distinct licence texts`);
