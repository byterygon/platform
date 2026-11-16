#!/usr/bin/env node
// License policy check (ADR "Repository layout and licensing", Notion DOC-10):
// 1. Every workspace crate and package declares one of the allowed licenses.
// 2. No permissive crate or package depends, directly or transitively, on an AGPL one.
// 3. Vendored fonts (packages/*/fonts/manifest.json) have an allowed licence, ship its text, and
//    match the checksums recorded for them; no font file is unlisted.
// 4. Vendored icons (packages/*/icons/manifest.json, Fluent UI System Icons) are MIT, ship the
//    licence text, and match their checksums; no icon file is unlisted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

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

// Layout (ADR "Repository layout and licensing"): libraries in crates/ and packages/ never depend
// on a product in apps/, whatever its licence and whatever the kind of dependency (dev included).
const root = process.cwd();
const inApps = (path) => relative(root, path).split(sep)[0] === "apps";
for (const id of meta.workspace_members) {
  const start = pkgs.get(id);
  if (inApps(start.manifest_path)) continue;
  const seen = new Set([id]);
  const stack = [[id, [start.name]]];
  while (stack.length > 0) {
    const [cur, path] = stack.pop();
    for (const dep of deps.get(cur) ?? []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const depPkg = pkgs.get(dep);
      if (depPkg.source == null && inApps(depPkg.manifest_path)) {
        errors.push(`crate ${start.name} is a library but depends on a product in apps/: ${[...path, depPkg.name].join(" -> ")}`);
      }
      stack.push([dep, [...path, depPkg.name]]);
    }
  }
}
const appPackages = new Set();
const findApps = (dir, depth) => {
  if (depth > 3 || !existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const manifest = join(dir, entry.name, "package.json");
    if (existsSync(manifest)) appPackages.add(JSON.parse(readFileSync(manifest, "utf8")).name);
    findApps(join(dir, entry.name), depth + 1);
  }
};
findApps("apps", 0);
for (const [name, { path, json }] of npm) {
  if (!path.startsWith(`packages${sep}`)) continue;
  const all = { ...json.dependencies, ...json.devDependencies, ...json.peerDependencies, ...json.optionalDependencies };
  for (const dep of Object.keys(all)) {
    if (appPackages.has(dep)) errors.push(`${path} (${name}) is a library but depends on the app package ${dep}; packages/ never depend on apps/`);
  }
}

// Fonts: the manifest is the list of what may be vendored. OFL-1.1 is the licence of Selawik, Inter
// and JetBrains Mono; it permits bundling with software, but the licence text must travel with the files.
const FONT_LICENSES = { "OFL-1.1": /SIL OPEN FONT LICENSE/i };
const FONT_FILE = /\.(woff2?|ttf|otf|ttc)$/i;
const listFiles = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
let fontFamilies = 0;
for (const dir of ["packages", "apps"]) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fontsDir = join(dir, entry.name, "fonts");
    const manifestPath = join(fontsDir, "manifest.json");
    if (!entry.isDirectory() || !existsSync(fontsDir)) continue;
    if (!existsSync(manifestPath)) {
      if (listFiles(fontsDir).some((file) => FONT_FILE.test(file))) errors.push(`${fontsDir} holds font files but no manifest.json`);
      continue;
    }
    const listed = new Set();
    for (const font of JSON.parse(readFileSync(manifestPath, "utf8")).fonts ?? []) {
      fontFamilies += 1;
      const pattern = FONT_LICENSES[font.license];
      if (!pattern) errors.push(`${manifestPath}: font ${font.family}: licence must be one of ${Object.keys(FONT_LICENSES).join(", ")} (got ${font.license ?? "none"})`);
      if (!font.licenseFiles?.length) errors.push(`${manifestPath}: font ${font.family}: licenseFiles is empty; the licence text must ship with the font`);
      for (const licenseFile of font.licenseFiles ?? []) {
        const path = join(fontsDir, licenseFile);
        if (!existsSync(path)) errors.push(`${path}: licence file of ${font.family} is missing`);
        else if (pattern && licenseFile.match(/LICENSE|OFL/i) && !pattern.test(readFileSync(path, "utf8"))) {
          errors.push(`${path}: does not contain the ${font.license} text`);
        }
      }
      if (!font.files?.length) errors.push(`${manifestPath}: font ${font.family} lists no files`);
      for (const file of font.files ?? []) {
        const path = join(fontsDir, file.path);
        listed.add(path);
        if (!existsSync(path)) errors.push(`${path}: listed in the manifest but missing`);
        else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) {
          errors.push(`${path}: sha256 differs from the manifest; the file was changed or the manifest is stale`);
        }
      }
    }
    for (const file of listFiles(fontsDir)) {
      if (FONT_FILE.test(file) && !listed.has(file)) errors.push(`${relative(".", file)}: font file is not listed in ${manifestPath}`);
    }
  }
}

// Icons: the manifest lists every vendored SVG with its sha256; MIT requires the copyright and
// permission notice to travel with copies, so the licence text must be next to the files (the
// generated module that ships them repeats it; packages/ui/test/icons.test.ts checks that).
const ICON_LICENSES = { MIT: /^MIT License[\s\S]*Permission is hereby granted, free of charge/ };
let iconSets = 0;
let iconFiles = 0;
for (const parent of ["packages", "apps"]) {
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const dir = join(parent, entry.name);
    const iconsDir = join(dir, "icons");
    const manifestPath = join(iconsDir, "manifest.json");
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    iconSets += 1;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const pattern = ICON_LICENSES[manifest.source?.license];
    if (!pattern) errors.push(`${manifestPath}: icon licence must be one of ${Object.keys(ICON_LICENSES).join(", ")} (got ${manifest.source?.license ?? "none"})`);
    const licensePath = join(iconsDir, manifest.source?.licenseFile ?? "LICENSE");
    if (!existsSync(licensePath)) errors.push(`${licensePath}: the icons' licence text is missing`);
    else if (pattern && !pattern.test(readFileSync(licensePath, "utf8"))) errors.push(`${licensePath}: does not contain the ${manifest.source.license} text`);
    const listed = new Set();
    for (const icon of manifest.icons ?? []) {
      for (const file of icon.files ?? []) {
        const path = join(iconsDir, file.path);
        listed.add(path);
        iconFiles += 1;
        if (!existsSync(path)) errors.push(`${path}: listed in the manifest but missing`);
        else if (createHash("sha256").update(readFileSync(path)).digest("hex") !== file.sha256) {
          errors.push(`${path}: sha256 differs from the manifest; re-vendor it (scripts/icons.ts add), never edit it`);
        }
      }
    }
    for (const file of listFiles(iconsDir)) {
      if (file.endsWith(".svg") && !listed.has(file)) errors.push(`${relative(".", file)}: icon file is not listed in ${manifestPath}`);
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(
  `License policy OK (${meta.workspace_members.length} crates, ${manifests.length} package.json files, ${fontFamilies} font famil${fontFamilies === 1 ? "y" : "ies"}, ${iconFiles} icon files in ${iconSets} set${iconSets === 1 ? "" : "s"}).`,
);
