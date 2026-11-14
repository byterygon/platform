#!/usr/bin/env node
// Builds the self-hostable shadcn registry (spec section 6) into packages/ui/registry/: one JSON
// item per component, the `cn` helper, one theme item per token preset, the registry.json index
// and llms.txt. Static files only, no server and no network: serve the folder from any static web
// server, or point the shadcn CLI at the files on disk.
//
//   node scripts/registry.ts            write registry/
//   node scripts/registry.ts --check    exit 3 if registry/ is stale (CI)
//   add --json for one JSON document on stdout
//
// Exit codes: 0 ok, 1 a manifest or a component breaks a rule, 2 bad command line, 3 stale.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCss, selectors } from "./lib/css.ts";
import { fileName, listComponents, readManifest, validateManifest, type Manifest } from "./lib/manifest.ts";

export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const NAMESPACE = "@byterygon";
const SCHEMA_ITEM = "https://ui.shadcn.com/schema/registry-item.json";
const SCHEMA_REGISTRY = "https://ui.shadcn.com/schema/registry.json";

export class RegistryError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Item = { [key: string]: Json };

/**
 * The npm packages an item needs, as bare names, and the versions this repo tests them with.
 * Bare, because the shadcn CLI installs a dependency with a version specifier even when the
 * project already has it, which offline means a failed install; a bare name is skipped when the
 * project's package.json lists it (an air-gapped project provisions it from its mirror).
 */
function dependenciesOf(root: string, names: readonly string[]): { dependencies: string[]; versions: Record<string, string> } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
  const versions: Record<string, string> = {};
  for (const name of names) {
    const version = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
    if (!version) throw new RegistryError([`${name} is used by a registry item but is not a dependency of @byterygon/ui`]);
    versions[name] = version;
  }
  return { dependencies: [...names], versions };
}

/**
 * The helpers in src/lib that components may import, each shipped as a `registry:lib` item at
 * `lib/<name>.ts`, with the npm packages it needs.
 */
export const LIBS: Record<string, { dependencies: string[]; description: string; llms: string }> = {
  cn: {
    dependencies: ["cn"],
    description: "Class-name merging that knows the Tailwind names of the Byterygon token roles. Every Byterygon component imports it from @/lib/cn.",
    llms: "class-name merging that knows the role names; every component depends on it.",
  },
  "theme-scope": {
    dependencies: [],
    description: "Gives a popup in a portal the data-theme and data-density of the control that opened it, and reads length tokens in px. Select, Combobox and MultiSelect import it from @/lib/theme-scope.",
    llms: "gives popups in a portal the theme and density of their trigger; the popup components depend on it.",
  },
};

/**
 * The shipped source of a component: the repo's own `@/components/<n>/<n>` imports become the
 * shadcn layout's `@/components/ui/<n>`, and every `@/` import becomes a registry dependency.
 */
export function shipSource(source: string, name: string): { content: string; registryDependencies: string[] } {
  const deps = new Set<string>();
  const problems: string[] = [];
  const content = source.replace(/(from\s+["'])(@\/[^"']+)(["'])/g, (_all, open: string, specifier: string, close: string) => {
    const component = /^@\/components\/([a-z0-9-]+)\/\1$/.exec(specifier);
    if (component) {
      deps.add(`${NAMESPACE}/${component[1]}`);
      return `${open}@/components/ui/${component[1]}${close}`;
    }
    const lib = /^@\/lib\/([a-z0-9-]+)$/.exec(specifier);
    if (lib && Object.hasOwn(LIBS, lib[1]!)) {
      deps.add(`${NAMESPACE}/${lib[1]}`);
      return `${open}${specifier}${close}`;
    }
    const allowed = Object.keys(LIBS).map((l) => `@/lib/${l}`).join(", ");
    problems.push(`${name}: imports ${specifier}; a component may import ${allowed} and @/components/<name>/<name> only`);
    return `${open}${specifier}${close}`;
  });
  if (problems.length > 0) throw new RegistryError(problems);
  return { content, registryDependencies: [...deps].sort() };
}

function componentItem(root: string, name: string): Item {
  const dir = join(root, "src", "components", name);
  const manifest: Manifest = readManifest(root, name);
  const problems = validateManifest(manifest, name).map((p) => `${name}: ${p}`);
  if (problems.length > 0) throw new RegistryError(problems);
  const { content, registryDependencies } = shipSource(readFileSync(join(dir, fileName(name, "component.tsx")), "utf8"), name);
  const { $schema: _schema, ...meta } = manifest;
  const { dependencies, versions } = dependenciesOf(root, manifest.dependencies);
  return {
    $schema: SCHEMA_ITEM,
    name,
    type: "registry:ui",
    title: manifest.title,
    description: manifest.description,
    dependencies,
    registryDependencies,
    files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content }],
    meta: {
      manifest: meta as unknown as Json,
      example: readFileSync(join(dir, fileName(name, "component.example.tsx")), "utf8"),
      dependencyVersions: versions,
    },
  };
}

function libItem(root: string, name: string): Item {
  const lib = LIBS[name]!;
  const { dependencies, versions } = dependenciesOf(root, lib.dependencies);
  return {
    $schema: SCHEMA_ITEM,
    name,
    type: "registry:lib",
    title: name,
    description: lib.description,
    dependencies,
    files: [{ path: `lib/${name}.ts`, type: "registry:lib", content: readFileSync(join(root, "src", "lib", `${name}.ts`), "utf8") }],
    meta: { dependencyVersions: versions },
  };
}

const require = createRequire(import.meta.url);

/** The presets of @byterygon/design-tokens that have committed CSS outputs. */
export function presets(): string[] {
  const themes = dirname(require.resolve("@byterygon/design-tokens/themes/default.theme.json"));
  return readdirSync(themes)
    .filter((file) => file.endsWith(".theme.json"))
    .map((file) => file.slice(0, -".theme.json".length))
    .sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
}

const presetFile = (preset: string, file: string) => readFileSync(require.resolve(`@byterygon/design-tokens/presets/${preset}/${file}`), "utf8");

/**
 * A `registry:theme` item for a token preset. `css` carries the variables (tokens.css and the
 * shadcn alias layer, every block with its selectors) and the dark variant; `cssVars.theme` the
 * Tailwind `@theme inline` names: Byterygon's roles plus shadcn's own colour names, so stock
 * shadcn components and Byterygon components both work in the project that installs it. shadcn's
 * meaning wins where the two collide (`--color-accent` is shadcn's hover colour), which is why
 * Byterygon components use the accent-solid names.
 */
export function themeItem(preset: string): Item {
  const themeFile = JSON.parse(readFileSync(require.resolve(`@byterygon/design-tokens/themes/${preset}.theme.json`), "utf8")) as { description?: string };
  const css: Record<string, Json> = {};
  const tailwind = parseCss(presetFile(preset, "tailwind-theme.css"));
  for (const rule of tailwind) if (rule.prelude.startsWith("@custom-variant")) css[rule.prelude] = {};
  for (const file of ["tokens.css", "shadcn-alias.css"]) {
    for (const rule of parseCss(presetFile(preset, file))) {
      const key = selectors(rule.prelude).join(", ");
      const block = (css[key] ??= {}) as Record<string, Json>;
      for (const [property, value] of rule.declarations) block[property] = value;
    }
  }
  const theme: Record<string, string> = {};
  for (const rule of tailwind) {
    if (rule.prelude !== "@theme inline") continue;
    for (const [property, value] of rule.declarations) theme[property.slice(2)] = value;
  }
  for (const rule of parseCss(presetFile(preset, "shadcn-alias.css"))) {
    for (const [property] of rule.declarations) {
      if (property === "--radius") continue;
      theme[`color-${property.slice(2)}`] = `var(${property})`;
    }
  }
  return {
    $schema: SCHEMA_ITEM,
    name: `theme-${preset}`,
    type: "registry:theme",
    title: `Byterygon theme: ${preset}`,
    description: `${themeFile.description ?? `The ${preset} preset.`} Installs the --by-* token variables (Light/Dark via data-theme or .dark, Comfortable/Compact via data-density), the shadcn/ui variable aliases and the Tailwind names of the roles. Fonts are not included: copy @byterygon/design-tokens/fonts and import fonts.css for Inter and JetBrains Mono, or the system fallbacks are used.`,
    cssVars: { theme },
    css,
  };
}

function llmsTxt(items: Item[]): string {
  const lines = [
    "# Byterygon UI registry",
    "",
    "> Base UI components styled with Byterygon design-token roles, as a static shadcn registry. No network: install from this folder or from a static server you host.",
    "",
    "Install (components.json: \"registries\": { \"@byterygon\": \"<this folder or URL>/{name}.json\" }, \"tailwind\": { \"baseColor\": \"\" }):",
    "",
    "    shadcn add <this folder>/theme-default.json @byterygon/button",
    "",
    "## Themes",
    "",
  ];
  for (const item of items.filter((i) => i.type === "registry:theme")) lines.push(`- [${item.name}](${item.name}.json): ${String(item.description).split(". Installs")[0]}.`);
  lines.push("", "## Components", "");
  for (const item of items.filter((i) => i.type === "registry:ui")) {
    const manifest = (item.meta as unknown as { manifest: Manifest }).manifest;
    lines.push(`### ${manifest.title}`, "", `[${item.name}.json](${item.name}.json): ${manifest.description}`, "");
    lines.push(`Usage: ${manifest.usage}`, "");
    lines.push(`- Wraps: ${manifest.base ?? "no Base UI part"}`);
    if (manifest.parts?.length) lines.push(`- Parts: ${manifest.parts.map((p) => `${p.name} (data-slot ${p.slot}): ${p.description}`).join("; ")}`);
    for (const [prop, values] of Object.entries(manifest.variants)) lines.push(`- ${prop}: ${values.join(", ")}`);
    lines.push(`- Props: ${manifest.props.map((p) => `${p.name} (${p.type}${p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : ""})`).join("; ")}`);
    lines.push(`- States: ${manifest.states.map((s) => `${s.name} (${s.variant})`).join(", ")}`);
    lines.push(`- Tokens: ${manifest.tokens.join(", ")}`);
    lines.push(`- Accessibility: ${manifest.accessibility.join(" ")}`, "");
  }
  lines.push("## Helpers", "", ...Object.entries(LIBS).map(([name, lib]) => `- [${name}.json](${name}.json): ${lib.llms}`), "");
  return lines.join("\n");
}

/** Every file of registry/, by file name. Pure: reads the sources, writes nothing. */
export function buildRegistry(root = PACKAGE_ROOT): Map<string, string> {
  const problems: string[] = [];
  const items: Item[] = [];
  for (const name of listComponents(root)) {
    try {
      items.push(componentItem(root, name));
    } catch (error) {
      if (error instanceof RegistryError) problems.push(...error.problems);
      else throw error;
    }
  }
  if (problems.length > 0) throw new RegistryError(problems);
  for (const name of Object.keys(LIBS)) items.push(libItem(root, name));
  for (const preset of presets()) items.push(themeItem(preset));
  const files = new Map<string, string>();
  for (const item of items) files.set(`${item.name}.json`, `${JSON.stringify(item, null, 2)}\n`);
  const index = {
    $schema: SCHEMA_REGISTRY,
    name: "byterygon",
    homepage: "",
    items: items.map(({ $schema: _s, content: _c, meta: _m, cssVars: _v, css: _css, ...rest }) => ({
      ...rest,
      files: ((rest.files as Item[] | undefined) ?? []).map(({ content: _content, ...file }) => file),
    })),
  };
  files.set("registry.json", `${JSON.stringify(index, null, 2)}\n`);
  files.set("llms.txt", llmsTxt(items));
  return files;
}

export interface SyncResult {
  written: string[];
  removed: string[];
  stale: string[];
}

/** Writes registry/ (or, with `check`, reports what is stale without writing). */
export function syncRegistry({ root = PACKAGE_ROOT, check = false } = {}): SyncResult {
  const dir = join(root, "registry");
  const files = buildRegistry(root);
  const existing = existsSync(dir) ? readdirSync(dir) : [];
  const result: SyncResult = { written: [], removed: [], stale: [] };
  for (const [file, content] of files) {
    const path = join(dir, file);
    if (existsSync(path) && readFileSync(path, "utf8") === content) continue;
    result.stale.push(file);
    if (!check) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, content);
      result.written.push(file);
    }
  }
  for (const file of existing) {
    if (files.has(file)) continue;
    result.stale.push(file);
    if (!check) {
      rmSync(join(dir, file));
      result.removed.push(file);
    }
  }
  return result;
}

function main(argv: string[]): number {
  const json = argv.includes("--json");
  const unknown = argv.filter((arg) => arg !== "--json" && arg !== "--check");
  const print = (doc: Record<string, unknown>, text: string) => {
    if (json) process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "registry", ...doc })}\n`);
    else process.stdout.write(`${text}\n`);
  };
  if (unknown.length > 0) {
    print({ ok: false, exitCode: 2, error: { code: "usage", message: `unknown argument ${unknown[0]}`, fix: "Use --check and --json only." } }, `error: unknown argument ${unknown[0]}\nusage: node scripts/registry.ts [--check] [--json]`);
    return 2;
  }
  const check = argv.includes("--check");
  try {
    const result = syncRegistry({ check });
    if (check && result.stale.length > 0) {
      print({ ok: false, exitCode: 3, ...result }, `registry/ is stale: ${result.stale.join(", ")}\nRun \`pnpm --filter @byterygon/ui registry\` and commit registry/.`);
      return 3;
    }
    print({ ok: true, exitCode: 0, ...result }, check ? "registry/ is up to date." : result.written.length + result.removed.length === 0 ? "registry/ is up to date." : `registry/: wrote ${result.written.join(", ") || "nothing"}${result.removed.length > 0 ? `; removed ${result.removed.join(", ")}` : ""}`);
    return 0;
  } catch (error) {
    if (!(error instanceof RegistryError)) throw error;
    print({ ok: false, exitCode: 1, problems: error.problems }, error.problems.map((p) => `error: ${p}`).join("\n"));
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
