#!/usr/bin/env node
// Builds the self-hostable shadcn registry (spec section 6) into packages/ui/registry/: one JSON
// item per component, the `cn` helper, one theme item per token preset, the registry.json index,
// llms.txt and llms-full.txt (scripts/lib/llms.ts). Static files only, no server and no network:
// serve the folder from any static web server, or point the shadcn CLI at the files on disk.
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
import { formatRegistryThemeItem } from "@byterygon/design-tokens/registry-theme";
import { type LlmsInput, llmsFullTxt, llmsTxt } from "./lib/llms.ts";
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
export const LIBS: Record<string, { dependencies: string[]; description: string; llms: string; registryDependencies?: string[]; source?: string }> = {
  cn: {
    dependencies: ["cn"],
    description: "Class-name merging that knows the Tailwind names of the Byterygon token roles. Every Byterygon component imports it from @/lib/cn.",
    llms: "class-name merging that knows the role names; every component depends on it.",
  },
  control: {
    dependencies: [],
    description: "What every Byterygon control shares (Fluent 2): the double focus ring (focusRing, focusRingWithin), Fluent's size names small/medium/large and the sm/md/lg and variant aliases kept for one release (controlSize, controlAppearance). Button, IconButton, ToggleButton, ToggleGroup and SplitButton import it from @/lib/control.",
    llms: "the double focus ring and the size and appearance names (with the aliases kept for one release); every control depends on it.",
  },
  "theme-scope": {
    dependencies: [],
    description: "Gives a popup in a portal the data-theme and data-density of the control that opened it, and reads length tokens in px. Select, Combobox and MultiSelect import it from @/lib/theme-scope.",
    llms: "gives popups in a portal the theme and density of their trigger; the popup components depend on it.",
  },
  monaco: {
    dependencies: ["monaco-editor"],
    description: "Loads Monaco lazily from the app's own bundle (ESM, its editor worker through Vite's ?worker, no CDN or AMD loader) and builds a Monaco theme from the design tokens in scope at the editor. SqlEditor imports it from @/lib/monaco; with a bundler other than Vite, set MonacoEnvironment.getWorker and replace the ?worker import.",
    llms: "loads Monaco lazily and offline (Vite ?worker) and turns the token roles in scope into a Monaco theme; SqlEditor depends on it.",
    registryDependencies: ["monaco-theme", "token-reader"],
  },
  xterm: {
    dependencies: ["@xterm/xterm", "@xterm/addon-fit", "@xterm/addon-search"],
    description: "Loads xterm.js lazily from the app's own bundle (its stylesheet, the fit and search addons; no CDN) and builds an xterm.js theme and font from the terminal.* roles and text.code in scope at the terminal. The Terminal component imports it from @/lib/xterm.",
    llms: "loads xterm.js lazily and offline and turns the terminal.* roles in scope into its theme; Terminal depends on it.",
    registryDependencies: ["token-reader"],
  },
  "token-reader": {
    dependencies: [],
    description: "Reads design-token variables at an element as the browser resolves them there (its data-theme and data-density region, the preset loaded) and converts colours to hex, for libraries that draw their own colours. @/lib/monaco and @/lib/xterm import it.",
    llms: "resolves token variables at an element and gives colours as hex; the monaco and xterm helpers depend on it.",
  },
  "monaco-theme": {
    dependencies: [],
    description: "The Monaco colour ids and SQL token types with the token role each one reads, and the function that turns resolved colours into a Monaco theme. The same source as the monaco-theme.ts output of @byterygon/design-tokens and the Theme Studio's Monaco export. @/lib/monaco imports it.",
    llms: "which token role colours each Monaco colour id and SQL token type; the monaco helper depends on it.",
    source: "@byterygon/design-tokens/monaco",
  },
  icons: {
    dependencies: [],
    description: "Fluent UI System Icons (MIT; the notice travels in the file): a curated set vendored offline, each icon an export with its regular and filled path data at 16, 20 and 24 px. Generated by scripts/icons.ts from packages/ui/icons. The Icon component imports it from @/lib/icons; import only the icons you use, so the rest are tree-shaken.",
    llms: "Fluent UI System Icons as path data, one export per icon (ChevronDown, Database); the Icon component depends on it.",
  },
  motion: {
    dependencies: [],
    description: "Looping animations without CSS keyframes (the token theme has none): the Web Animations API, periods derived from the motion tokens, never started under prefers-reduced-motion. Spinner, Progress and Skeleton import it from @/lib/motion.",
    llms: "looping animations through the Web Animations API, off under reduced motion; Spinner, Progress and Skeleton depend on it.",
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

/**
 * Imports of the token package that a lib may use, and the lib item each one becomes in a project
 * (the token package is not installed there). Only self-contained modules of the token package.
 */
const TOKEN_MODULES = Object.fromEntries(Object.entries(LIBS).flatMap(([name, lib]) => (lib.source ? [[lib.source, name]] : [])));

/** A lib's shipped source: token-package imports become the `@/lib/<name>` they are installed as. */
export function shipLibSource(source: string, name: string): string {
  return source.replace(/(from\s+["'])(@byterygon\/design-tokens\/[^"']+)(["'])/g, (_all, open: string, specifier: string, close: string) => {
    const lib = TOKEN_MODULES[specifier];
    if (!lib || !(LIBS[name]!.registryDependencies ?? []).includes(lib)) {
      throw new RegistryError([`lib ${name}: imports ${specifier}; list the lib item it ships as in LIBS.${name}.registryDependencies`]);
    }
    return `${open}@/lib/${lib}${close}`;
  });
}

function libItem(root: string, name: string): Item {
  const lib = LIBS[name]!;
  const { dependencies, versions } = dependenciesOf(root, lib.dependencies);
  const file = lib.source ? require.resolve(lib.source) : join(root, "src", "lib", `${name}.ts`);
  return {
    $schema: SCHEMA_ITEM,
    name,
    type: "registry:lib",
    title: name,
    description: lib.description,
    dependencies,
    ...(lib.registryDependencies ? { registryDependencies: lib.registryDependencies.map((dep) => `${NAMESPACE}/${dep}`) } : {}),
    files: [{ path: `lib/${name}.ts`, type: "registry:lib", content: shipLibSource(readFileSync(file, "utf8"), name) }],
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
 * The `registry:theme` item of a token preset, from its committed CSS outputs. Built by
 * @byterygon/design-tokens (`registry-theme.ts`), the same code as its `registry-theme.json` output
 * and the Theme Studio's export, so the three are the same bytes.
 */
export function themeItemFile(preset: string): string {
  const themeFile = JSON.parse(readFileSync(require.resolve(`@byterygon/design-tokens/themes/${preset}.theme.json`), "utf8")) as { description?: string };
  return formatRegistryThemeItem({
    name: preset,
    ...(themeFile.description ? { description: themeFile.description } : {}),
    tokensCss: presetFile(preset, "tokens.css"),
    tailwindCss: presetFile(preset, "tailwind-theme.css"),
    shadcnCss: presetFile(preset, "shadcn-alias.css"),
  });
}

export function themeItem(preset: string): Item {
  return JSON.parse(themeItemFile(preset)) as Item;
}

/** What llms.txt and llms-full.txt are written from. */
function llmsInput(items: Item[]): LlmsInput {
  return {
    themes: items.filter((i) => i.type === "registry:theme").map((i) => ({ name: String(i.name), description: `${String(i.description).split(". Installs")[0]}.` })),
    components: items
      .filter((i) => i.type === "registry:ui")
      .map((i) => {
        const meta = i.meta as unknown as { manifest: Manifest; example: string };
        return { name: String(i.name), manifest: meta.manifest, example: shipSource(meta.example, String(i.name)).content };
      }),
    libs: Object.entries(LIBS).map(([name, lib]) => ({ name, llms: lib.llms })),
  };
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
  const llms = llmsInput(items);
  files.set("llms.txt", llmsTxt(llms));
  files.set("llms-full.txt", llmsFullTxt(llms));
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
