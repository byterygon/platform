#!/usr/bin/env node
// The vendored Fluent UI System Icons (icons/, MIT) and the module the Icon component reads
// (src/lib/icons.ts, generated and committed). Nothing here touches the network: icons are added
// from a copy of the upstream package on disk (the npm tarball `@fluentui/svg-icons-<v>.tgz`, its
// extracted folder, or a checkout of github.com/microsoft/fluentui-system-icons), fetched once on a
// connected machine or taken from an internal mirror.
//
//   node scripts/icons.ts build                 write src/lib/icons.ts from icons/
//   node scripts/icons.ts build --check         exit 3 if src/lib/icons.ts is stale (CI, tests)
//   node scripts/icons.ts add <name...> --from <tgz|dir>   vendor icons (Fluent names: chevron-down or chevron_down)
//   node scripts/icons.ts refresh --from <tgz|dir>         re-vendor every listed icon from a newer release
//   node scripts/icons.ts list                  the vendored icons and their sizes
//   add --json for one JSON document on stdout
//
// Exit codes: 0 ok, 1 a rule is broken (a missing or changed file, an icon that is not
// monochrome paths), 2 bad command line, 3 stale.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ICONS_DIR = join(PACKAGE_ROOT, "icons");
export const MODULE_PATH = join(PACKAGE_ROOT, "src/lib/icons.ts");

export const SIZES = [16, 20, 24] as const;
export const STYLES = ["regular", "filled"] as const;
type Size = (typeof SIZES)[number];
type Style = (typeof STYLES)[number];

export interface IconSource {
  name: string;
  repository: string;
  commit: string;
  package: string;
  version: string;
  tarball: string;
  sha256?: string;
  integrity?: string;
  license: string;
  licenseFile: string;
  licenseSource: string;
}
export interface IconFile {
  path: string;
  size: Size;
  style: Style;
  sha256: string;
  upstreamSha256: string;
}
export interface IconEntry {
  name: string;
  files: IconFile[];
}
export interface IconManifest {
  $comment: string;
  source: IconSource;
  icons: IconEntry[];
}

export class IconError extends Error {
  readonly problems: string[];
  readonly exitCode: number;
  constructor(problems: string[], exitCode = 1) {
    super(problems.join("\n"));
    this.problems = problems;
    this.exitCode = exitCode;
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kebab = (name: string) => name.trim().toLowerCase().replaceAll("_", "-");
const snake = (name: string) => name.replaceAll("-", "_");
/** `chevron-down` -> `ChevronDown`, `text-align-left` -> `TextAlignLeft`; a leading digit gets `Icon`. */
export const exportName = (name: string) => {
  const pascal = name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return /^[0-9]/.test(pascal) ? `Icon${pascal}` : pascal;
};

export function readManifest(root = ICONS_DIR): IconManifest {
  return JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as IconManifest;
}

function writeManifest(manifest: IconManifest, root = ICONS_DIR) {
  manifest.icons.sort((a, b) => a.name.localeCompare(b.name));
  for (const icon of manifest.icons) icon.files.sort((a, b) => a.size - b.size || STYLES.indexOf(a.style) - STYLES.indexOf(b.style));
  const lines = ["{", `  "$comment": ${JSON.stringify(manifest.$comment)},`, `  "source": ${JSON.stringify(manifest.source, null, 2).replaceAll("\n", "\n  ")},`, '  "icons": ['];
  manifest.icons.forEach((icon, index) => {
    lines.push(`    { "name": ${JSON.stringify(icon.name)}, "files": [`);
    icon.files.forEach((file, fileIndex) => {
      const comma = fileIndex === icon.files.length - 1 ? "" : ",";
      lines.push(`      { "path": ${JSON.stringify(file.path)}, "size": ${file.size}, "style": ${JSON.stringify(file.style)}, "sha256": ${JSON.stringify(file.sha256)}, "upstreamSha256": ${JSON.stringify(file.upstreamSha256)} }${comma}`);
    });
    lines.push(`    ] }${index === manifest.icons.length - 1 ? "" : ","}`);
  });
  lines.push("  ]", "}", "");
  writeFileSync(join(root, "manifest.json"), lines.join("\n"));
}

/**
 * An upstream SVG reduced to what the Icon component draws: the path data of one monochrome
 * icon. Fluent's SVGs are `<svg width height viewBox><path d/>...</svg>`; anything else (colour
 * icons with gradients, transforms, other shapes) is refused rather than half-converted.
 */
export function parseUpstream(svg: string, size: Size, label: string): string[] {
  const problems: string[] = [];
  const root = /^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/.exec(svg);
  if (!root) throw new IconError([`${label}: not an <svg> document`]);
  const viewBox = /\bviewBox="([^"]+)"/.exec(root[1]!)?.[1];
  if (viewBox !== `0 0 ${size} ${size}`) problems.push(`${label}: viewBox is ${viewBox ?? "missing"}, expected 0 0 ${size} ${size}`);
  const paths: string[] = [];
  const body = root[2]!.replace(/<path\b([^>]*?)\/>/g, (_all, attributes: string) => {
    const attrs = [...attributes.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)];
    for (const [, name] of attrs) if (name !== "d") problems.push(`${label}: <path> has ${name}; only monochrome path data (d) is vendored`);
    const d = attrs.find(([, name]) => name === "d")?.[2];
    if (!d) problems.push(`${label}: <path> without d`);
    else paths.push(d);
    return "";
  });
  if (body.trim() !== "") problems.push(`${label}: holds elements other than <path> (${body.trim().slice(0, 60)}...); colour icons are not vendored`);
  if (paths.length === 0) problems.push(`${label}: no path`);
  if (problems.length > 0) throw new IconError(problems);
  return paths;
}

/** The vendored form of an icon file: what Fluent drew, at its own viewBox, in currentColor. */
export function optimizedSvg(size: Size, paths: readonly string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" fill="currentColor">${paths.map((d) => `<path d="${d}"/>`).join("")}</svg>\n`;
}

function parseVendored(svg: string, size: Size, label: string): string[] {
  const match = /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d+) \1" fill="currentColor">((?:<path d="[^"]+"\/>)+)<\/svg>\n$/.exec(svg);
  if (!match || Number(match[1]) !== size) throw new IconError([`${label}: not in the vendored form (run add or refresh again)`]);
  return [...match[2]!.matchAll(/<path d="([^"]+)"\/>/g)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------------------------
// Reading an upstream copy: a .tgz (npm), its extracted folder, or a repository checkout.

interface Upstream {
  files: Map<string, Buffer>; // `<snake>_<size>_<style>.svg` -> bytes
  version?: string;
  commit?: string;
  sha256?: string;
}

/** The regular files of a POSIX/GNU tar archive (what npm writes), keyed by path. */
function untar(data: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  const text = (start: number, length: number) => data.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156]!);
    const prefix = text(offset + 345, 155);
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${text(offset, 100)}` : text(offset, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    longName = undefined;
    if (type === "L") longName = body.toString("utf8").replace(/\0.*$/s, "");
    else if (type === "x") paxPath = /\d+ path=([^\n]+)\n/.exec(body.toString("utf8"))?.[1];
    else {
      paxPath = undefined;
      if (type === "0" || type === "\0") files.set(name, Buffer.from(body));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const UPSTREAM_FILE = /(?:^|\/)(?:ic_fluent_)?([a-z0-9_]+?)_(16|20|24)_(regular|filled)\.svg$/;
/** Directional variants (`LTR/`, `RTL/` in the npm package) are skipped: the root files are the default direction. */
const DIRECTIONAL = /(?:^|\/)(?:LTR|RTL)\//;

export function readUpstream(from: string): Upstream {
  if (!existsSync(from)) throw new IconError([`--from ${from} does not exist`], 2);
  const files = new Map<string, Buffer>();
  let packageJson: { version?: string; gitHead?: string } | undefined;
  let tarballSha: string | undefined;
  const take = (path: string, data: Buffer) => {
    if (DIRECTIONAL.test(path)) return;
    const match = UPSTREAM_FILE.exec(path);
    if (match) files.set(`${match[1]}_${match[2]}_${match[3]}.svg`, data);
  };
  if (statSync(from).isFile()) {
    const archive = readFileSync(from);
    tarballSha = sha256(archive);
    for (const [path, data] of untar(gunzipSync(archive))) {
      if (/^[^/]+\/package\.json$/.test(path)) packageJson = JSON.parse(data.toString("utf8"));
      take(path, data);
    }
  } else {
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".svg")) take(relative(from, path), readFileSync(path));
      }
    };
    walk(from);
    const pkg = join(from, "package.json");
    if (existsSync(pkg)) packageJson = JSON.parse(readFileSync(pkg, "utf8"));
  }
  if (files.size === 0) throw new IconError([`--from ${from}: no Fluent SVG found (expected icons/<name>_<size>_<style>.svg or ic_fluent_<name>_<size>_<style>.svg)`], 2);
  return { files, ...(packageJson?.version ? { version: packageJson.version } : {}), ...(packageJson?.gitHead ? { commit: packageJson.gitHead } : {}), ...(tarballSha ? { sha256: tarballSha } : {}) };
}

function vendor(manifest: IconManifest, upstream: Upstream, names: readonly string[], root: string): { added: string[]; missing: string[] } {
  const problems: string[] = [];
  const added: string[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const name = kebab(raw);
    if (!NAME.test(name)) {
      problems.push(`"${raw}" is not an icon name (Fluent names: chevron-down, text-align-left)`);
      continue;
    }
    const files: IconFile[] = [];
    for (const size of SIZES) {
      for (const style of STYLES) {
        const key = `${snake(name)}_${size}_${style}.svg`;
        const data = upstream.files.get(key);
        if (!data) {
          missing.push(`${name} ${size} ${style}`);
          continue;
        }
        try {
          const paths = parseUpstream(data.toString("utf8"), size, key);
          const svg = optimizedSvg(size, paths);
          const path = `fluent/${name}-${size}-${style}.svg`;
          mkdirSync(join(root, "fluent"), { recursive: true });
          writeFileSync(join(root, path), svg);
          files.push({ path, size, style, sha256: sha256(svg), upstreamSha256: sha256(data) });
        } catch (error) {
          if (error instanceof IconError) problems.push(...error.problems);
          else throw error;
        }
      }
    }
    if (files.length === 0) {
      const near = [...new Set([...upstream.files.keys()].map((key) => key.replace(/_(16|20|24)_(regular|filled)\.svg$/, "")))]
        .filter((candidate) => candidate.includes(snake(name).split("_")[0]!))
        .slice(0, 8)
        .map(kebab);
      problems.push(`${name}: not in the upstream copy at 16, 20 or 24 px${near.length > 0 ? `; similar: ${near.join(", ")}` : ""}`);
      continue;
    }
    for (const style of STYLES) if (!files.some((file) => file.style === style)) problems.push(`${name}: upstream has no ${style} drawing`);
    const old = manifest.icons.find((icon) => icon.name === name);
    for (const file of old?.files ?? []) if (!files.some((f) => f.path === file.path)) rmSync(join(root, file.path), { force: true });
    manifest.icons = [...manifest.icons.filter((icon) => icon.name !== name), { name, files }];
    added.push(name);
  }
  if (problems.length > 0) throw new IconError(problems);
  return { added, missing };
}

function checkSource(manifest: IconManifest, upstream: Upstream, refresh: boolean) {
  if (refresh) {
    if (!upstream.version) throw new IconError(["refresh needs the upstream package.json (a .tgz or an extracted @fluentui/svg-icons folder) to record the version"], 2);
    manifest.source.version = upstream.version;
    if (upstream.commit) {
      manifest.source.commit = upstream.commit;
      manifest.source.licenseSource = `${manifest.source.repository}/blob/${upstream.commit}/LICENSE`;
    }
    manifest.source.tarball = `https://registry.npmjs.org/${manifest.source.package}/-/${manifest.source.package.split("/")[1]}-${upstream.version}.tgz`;
    if (upstream.sha256) manifest.source.sha256 = upstream.sha256;
    else delete manifest.source.sha256;
    delete manifest.source.integrity;
    return;
  }
  if (upstream.version && upstream.version !== manifest.source.version) {
    throw new IconError([
      `--from is ${manifest.source.package} ${upstream.version} but icons/ holds ${manifest.source.version}; every icon comes from one release. Run "refresh --from" to move all of them, then add.`,
    ]);
  }
}

// ---------------------------------------------------------------------------------------------
// The module.

/** The vendored icons, read back and checked against the manifest. */
export function readVendored(root = ICONS_DIR): { manifest: IconManifest; icons: { name: string; art: Record<Style, Partial<Record<Size, string[]>>> }[] } {
  const manifest = readManifest(root);
  const problems: string[] = [];
  const license = join(root, manifest.source.licenseFile);
  if (!existsSync(license)) problems.push(`${relative(PACKAGE_ROOT, license)}: the licence text is missing`);
  const icons = manifest.icons.map((icon) => {
    const art: Record<Style, Partial<Record<Size, string[]>>> = { regular: {}, filled: {} };
    for (const file of icon.files) {
      const path = join(root, file.path);
      if (!existsSync(path)) {
        problems.push(`${relative(PACKAGE_ROOT, path)}: listed in icons/manifest.json but missing`);
        continue;
      }
      const svg = readFileSync(path, "utf8");
      if (sha256(svg) !== file.sha256) problems.push(`${relative(PACKAGE_ROOT, path)}: sha256 differs from icons/manifest.json; re-vendor it with add, never edit it`);
      try {
        art[file.style][file.size] = parseVendored(svg, file.size, relative(PACKAGE_ROOT, path));
      } catch (error) {
        if (error instanceof IconError) problems.push(...error.problems);
        else throw error;
      }
    }
    return { name: icon.name, art };
  });
  const listed = new Set(manifest.icons.flatMap((icon) => icon.files.map((file) => file.path)));
  const dir = join(root, "fluent");
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    if (!listed.has(`fluent/${file}`)) problems.push(`icons/fluent/${file}: not listed in icons/manifest.json`);
  }
  if (problems.length > 0) throw new IconError(problems);
  return { manifest, icons };
}

export function renderModule(root = ICONS_DIR): string {
  const { manifest, icons } = readVendored(root);
  const source = manifest.source;
  const licence = readFileSync(join(root, source.licenseFile), "utf8").trim().split("\n").map((line) => (line ? ` * ${line}` : " *"));
  // The first statement carries no comment: the shadcn CLI drops whatever precedes it when it
  // installs the item, and the MIT notice must travel with every copy. `/*!` and `@license` keep
  // the notice through bundlers' comment stripping too.
  const out: string[] = [
    "export type IconSize = 16 | 20 | 24;",
    "",
    "/*!",
    " * @license",
    ` * ${source.name} ${source.version} (${source.repository}, commit ${source.commit}),`,
    ` * the ${source.package} release, vendored by @byterygon/ui. Licensed under the MIT licence:`,
    " *",
    ...licence,
    " */",
    "",
    "// Generated by scripts/icons.ts from icons/ (`pnpm --filter @byterygon/ui icons build`); do not edit.",
    "// IconSize is a Fluent drawing size in px, the viewBox of the artwork. Each icon is Fluent's",
    "// artwork per style (regular, filled) and size (16, 20, 24 px), drawn in currentColor. Render one",
    "// with the Icon component (`<Icon icon={ChevronDown} />`); import only the icons you use, so the",
    "// rest are tree-shaken.",
    "",
    "/** One Fluent icon: its name and its path data per style and size. */",
    "export interface IconDefinition {",
    "  /** The Fluent name in kebab case (`chevron-down`). */",
    "  readonly name: string;",
    "  /** Outline artwork per drawing size; the default. */",
    "  readonly regular: Readonly<Partial<Record<IconSize, readonly string[]>>>;",
    "  /** Solid artwork per drawing size: a selected or active state (Fluent's filled style). */",
    "  readonly filled: Readonly<Partial<Record<IconSize, readonly string[]>>>;",
    "}",
    "",
  ];
  const art = (byStyle: Partial<Record<Size, string[]>>) =>
    `{ ${SIZES.filter((size) => byStyle[size]).map((size) => `${size}: [${byStyle[size]!.map((d) => JSON.stringify(d)).join(", ")}]`).join(", ")} }`;
  for (const icon of icons) {
    const sizes = SIZES.filter((size) => icon.art.regular[size] || icon.art.filled[size]);
    out.push(`/** Fluent \`${icon.name}\` (${sizes.join(", ")} px). */`);
    out.push(`export const ${exportName(icon.name)}: IconDefinition = {`);
    out.push(`  name: ${JSON.stringify(icon.name)},`);
    out.push(`  regular: ${art(icon.art.regular)},`);
    out.push(`  filled: ${art(icon.art.filled)},`);
    out.push("};", "");
  }
  out.push("/** Every vendored icon's name, in order. */");
  out.push(`export const ICON_NAMES = [${icons.map((icon) => JSON.stringify(icon.name)).join(", ")}] as const;`, "");
  return out.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Command line.

interface Result {
  schemaVersion: 1;
  command: string;
  ok: boolean;
  exitCode: number;
  [key: string]: unknown;
}

export function run(argv: readonly string[], root = ICONS_DIR, modulePath = MODULE_PATH): Result {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const command = args[0] ?? "help";
  const fromIndex = args.indexOf("--from");
  const from = fromIndex >= 0 ? args[fromIndex + 1] : undefined;
  const positional = args.slice(1).filter((arg, index, all) => !arg.startsWith("--") && all[index - 1] !== "--from");
  const result = (ok: boolean, exitCode: number, extra: Record<string, unknown> = {}): Result => ({ schemaVersion: 1, command, ok, exitCode, ...extra });
  void json;
  try {
    switch (command) {
      case "build": {
        const content = renderModule(root);
        const current = existsSync(modulePath) ? readFileSync(modulePath, "utf8") : "";
        if (args.includes("--check")) {
          return content === current
            ? result(true, 0, { file: relative(PACKAGE_ROOT, modulePath), status: "unchanged" })
            : result(false, 3, { file: relative(PACKAGE_ROOT, modulePath), status: "stale", fix: { summary: "Run `pnpm --filter @byterygon/ui icons build`, then `registry`, and commit." } });
        }
        if (content !== current) writeFileSync(modulePath, content);
        return result(true, 0, { file: relative(PACKAGE_ROOT, modulePath), status: content === current ? "unchanged" : "written", icons: readManifest(root).icons.length });
      }
      case "add":
      case "refresh": {
        if (!from) return result(false, 2, { error: { code: "from-missing", message: `${command} needs --from <@fluentui/svg-icons .tgz, its folder, or a fluentui-system-icons checkout>`, fix: { summary: "Fetch the tarball once on a connected machine (npm pack @fluentui/svg-icons@<version>) or take it from your mirror." } } });
        const manifest = readManifest(root);
        const names = command === "refresh" ? manifest.icons.map((icon) => icon.name) : positional;
        if (names.length === 0) return result(false, 2, { error: { code: "names-missing", message: "add needs at least one icon name", fix: { summary: "Fluent names, e.g. add chevron-down arrow-sort --from ./svg-icons.tgz" } } });
        const upstream = readUpstream(from);
        checkSource(manifest, upstream, command === "refresh");
        const { added, missing } = vendor(manifest, upstream, names, root);
        writeManifest(manifest, root);
        const content = renderModule(root);
        writeFileSync(modulePath, content);
        return result(true, 0, { added, missingSizes: missing, next: "Run `pnpm --filter @byterygon/ui registry` and commit icons/, src/lib/icons.ts and registry/." });
      }
      case "list": {
        const manifest = readManifest(root);
        return result(true, 0, {
          source: `${manifest.source.package} ${manifest.source.version}`,
          icons: manifest.icons.map((icon) => ({ name: icon.name, export: exportName(icon.name), sizes: [...new Set(icon.files.map((file) => file.size))] })),
        });
      }
      case "help":
        return result(true, 0, { usage: ["build [--check]", "add <name...> --from <tgz|dir>", "refresh --from <tgz|dir>", "list"], exitCodes: { 0: "ok", 1: "a rule is broken", 2: "bad command line", 3: "stale" } });
      default:
        return result(false, 2, { error: { code: "unknown-command", message: `unknown command ${command}`, fix: { summary: "Commands: build, add, refresh, list, help." } } });
    }
  } catch (error) {
    if (error instanceof IconError) return result(false, error.exitCode, { problems: error.problems });
    throw error;
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const outcome = run(argv);
  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  else if (outcome.ok) {
    const { schemaVersion: _v, command: _c, ok: _o, exitCode: _e, ...rest } = outcome;
    process.stdout.write(`icons ${outcome.command}: ${JSON.stringify(rest)}\n`);
  } else process.stderr.write(`icons ${outcome.command}: ${JSON.stringify(outcome.problems ?? outcome.error ?? outcome, null, 2)}\n`);
  process.exitCode = outcome.exitCode;
}
