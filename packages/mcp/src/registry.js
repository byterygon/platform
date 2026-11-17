// @ts-check
/**
 * The local Byterygon UI registry (a folder of shadcn registry items, `packages/ui/registry` by
 * default): listing, reading, and installing items into a project. Installing writes files only
 * inside the project folder it is given; a target outside it (through `..`, an absolute path, an
 * alias or a symbolic link) refuses the whole install before anything is written.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @typedef {Record<string, any>} Item */

const NAMESPACE = "@byterygon/";
const ITEM_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** The registry folder of @byterygon/ui (its `registry/`). */
export function defaultRegistryDir() {
  return dirname(fileURLToPath(import.meta.resolve("@byterygon/ui/registry/registry.json")));
}

export class RegistryError extends Error {
  /** @param {string} code @param {string} message @param {Record<string, unknown>} [details] */
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** `@byterygon/button`, `button` -> `button`; anything that is not a plain item name is refused. */
export function itemName(/** @type {string} */ name) {
  const bare = name.startsWith(NAMESPACE) ? name.slice(NAMESPACE.length) : name;
  if (!ITEM_NAME.test(bare)) throw new RegistryError("bad-name", `"${name}" is not a registry item name`, { fix: "Use a name from list_registry_items, for example button or @byterygon/button." });
  return bare;
}

export class Registry {
  /** @param {string} dir */
  constructor(dir) {
    this.dir = resolve(dir);
    if (!existsSync(join(this.dir, "registry.json"))) throw new RegistryError("no-registry", `${this.dir} has no registry.json`, { fix: "Pass --registry <folder of a Byterygon UI registry>." });
    /** @type {Map<string, Item>} */
    this.cache = new Map();
  }

  /** The index (registry.json). */
  index() {
    return JSON.parse(readFileSync(join(this.dir, "registry.json"), "utf8"));
  }

  /** One item, by name. */
  item(/** @type {string} */ name) {
    const bare = itemName(name);
    const hit = this.cache.get(bare);
    if (hit) return hit;
    const file = join(this.dir, `${bare}.json`);
    if (!existsSync(file)) {
      const names = this.index().items.map((/** @type {Item} */ i) => i.name);
      const near = names.filter((/** @type {string} */ n) => n.includes(bare) || bare.includes(n)).slice(0, 5);
      throw new RegistryError("unknown-item", `the registry has no item "${bare}"`, { fix: near.length > 0 ? `Did you mean ${near.join(", ")}?` : "Call list_registry_items." });
    }
    const item = JSON.parse(readFileSync(file, "utf8"));
    this.cache.set(bare, item);
    return item;
  }

  /** Items of the index, optionally of one type, without their file contents. */
  list(/** @type {string | undefined} */ type) {
    return this.index()
      .items.filter((/** @type {Item} */ i) => !type || i.type === type)
      .map((/** @type {Item} */ i) => ({
        name: i.name,
        type: i.type,
        title: i.title,
        description: i.description,
        ...(i.dependencies?.length ? { dependencies: i.dependencies } : {}),
        ...(i.registryDependencies?.length ? { registryDependencies: i.registryDependencies } : {}),
      }));
  }

  /** The components (`registry:ui` items) with their usage notes. */
  components() {
    return this.list("registry:ui").map((/** @type {Item} */ entry) => {
      const manifest = this.item(entry.name).meta?.manifest ?? {};
      return { name: entry.name, title: entry.title, description: entry.description, usage: manifest.usage, status: manifest.status, ...(manifest.parts?.length ? { parts: manifest.parts.map((/** @type {Item} */ p) => p.name) } : {}) };
    });
  }

  /**
   * A component: its manifest, its example file as a project writes it (imports at their
   * installed paths) and, on request, its source as the registry installs it.
   */
  component(/** @type {string} */ name, includeSource = false) {
    const item = this.item(name);
    if (item.type !== "registry:ui") throw new RegistryError("not-a-component", `${item.name} is a ${item.type} item, not a component`, { fix: "Call list_components for the components." });
    return {
      name: item.name,
      title: item.title,
      manifest: item.meta?.manifest,
      example: installedPaths(String(item.meta?.example ?? "")),
      dependencies: item.dependencies ?? [],
      dependencyVersions: item.meta?.dependencyVersions ?? {},
      registryDependencies: item.registryDependencies ?? [],
      install: { tool: "install_registry_item", arguments: { items: [item.name] } },
      ...(includeSource ? { source: item.files?.[0]?.content } : {}),
    };
  }

  /** The item and every item it depends on, dependencies first. */
  closure(/** @type {readonly string[]} */ names) {
    /** @type {Item[]} */
    const ordered = [];
    const seen = new Set();
    const visit = (/** @type {string} */ name, /** @type {string[]} */ path) => {
      const bare = itemName(name);
      if (seen.has(bare)) return;
      if (path.includes(bare)) throw new RegistryError("cycle", `registry dependency cycle: ${[...path, bare].join(" -> ")}`);
      const item = this.item(bare);
      for (const dep of item.registryDependencies ?? []) {
        if (!String(dep).startsWith(NAMESPACE)) throw new RegistryError("foreign-dependency", `${bare} depends on ${dep}, which is not in this registry`, { fix: "Only @byterygon/ items install offline from the local registry." });
        visit(dep, [...path, bare]);
      }
      seen.add(bare);
      ordered.push(item);
    };
    for (const name of names) visit(name, []);
    return ordered;
  }
}

/** `@/components/<x>/<x>` (the repository's layout) -> `@/components/ui/<x>` (the installed one). */
export function installedPaths(/** @type {string} */ source) {
  return source.replace(/(from\s+["'])@\/components\/([a-z0-9-]+)\/\2(["'])/g, "$1@/components/ui/$2$3");
}

/** JSON with comments and trailing commas (tsconfig.json). */
function readJsonc(/** @type {string} */ file) {
  const text = readFileSync(file, "utf8");
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === "\\") i += 1;
      out += text.slice(start, i + 1);
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
    } else if (ch === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      if (i === 0) break;
    } else out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * Where a project wants things: the shadcn aliases of its components.json, resolved through the
 * `@/*` path of its tsconfig, and the folder of its main CSS file.
 * @param {string} project absolute, real path
 */
export function projectLayout(project) {
  const componentsJson = join(project, "components.json");
  const config = existsSync(componentsJson) ? JSON.parse(readFileSync(componentsJson, "utf8")) : {};
  const aliases = { ui: "@/components/ui", lib: "@/lib", ...(config.aliases ?? {}) };
  let at = existsSync(join(project, "src")) ? "src" : ".";
  for (const name of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    const file = join(project, name);
    if (!existsSync(file)) continue;
    const target = readJsonc(file)?.compilerOptions?.paths?.["@/*"]?.[0];
    if (typeof target === "string") {
      at = posix.normalize(target.replace(/\/\*$/, "")) || ".";
      break;
    }
  }
  const toPath = (/** @type {string} */ alias) => (alias.startsWith("@/") ? posix.join(at, alias.slice(2)) : alias);
  const cssFile = typeof config.tailwind?.css === "string" ? config.tailwind.css : undefined;
  return { aliases, ui: toPath(aliases.ui), lib: toPath(aliases.lib), cssDir: cssFile ? posix.dirname(cssFile) : at, cssFile, hasComponentsJson: existsSync(componentsJson) };
}

/** The CSS of a `registry:theme` item: its `css` blocks and `cssVars.theme` as `@theme inline`. */
export function themeCss(/** @type {Item} */ item) {
  const lines = [`/* ${item.title ?? item.name}, from the Byterygon UI registry (${item.name}.json). Import it after Tailwind. */`];
  const block = (/** @type {string} */ selector, /** @type {Record<string, any>} */ body, indent = "") => {
    const entries = Object.entries(body);
    if (entries.length === 0 && selector.startsWith("@")) return lines.push(`${indent}${selector};`);
    lines.push(`${indent}${selector} {`);
    for (const [key, value] of entries) {
      if (value && typeof value === "object") block(key, value, `${indent}  `);
      else lines.push(`${indent}  ${key}: ${value};`);
    }
    lines.push(`${indent}}`);
    return undefined;
  };
  for (const [selector, body] of Object.entries(item.css ?? {})) block(selector, body);
  const theme = item.cssVars?.theme ?? {};
  if (Object.keys(theme).length > 0) block("@theme inline", Object.fromEntries(Object.entries(theme).map(([k, v]) => [`--${k}`, v])));
  return `${lines.join("\n")}\n`;
}

/**
 * Plans (and, unless `dryRun`, performs) the install of registry items into a project folder.
 * @param {Registry} registry
 * @param {{ project: string; items: readonly string[]; dryRun?: boolean; overwrite?: boolean }} options
 */
export function install(registry, { project, items, dryRun = false, overwrite = false }) {
  const root = resolve(project);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new RegistryError("no-project", `${root} is not a folder`, { fix: "Pass the project folder (the one with package.json) as project." });
  const realRoot = realpathSync(root);
  if (items.length === 0) throw new RegistryError("no-items", "items is empty", { fix: "Name at least one item, for example button or theme-default." });
  const layout = projectLayout(realRoot);
  const ordered = registry.closure(items);

  /** @type {{ path: string; item: string; action: "create" | "overwrite" | "unchanged" | "skip"; content: string }[]} */
  const files = [];
  /** @type {{ path: string; item: string; reason: string }[]} */
  const refused = [];
  /** @type {Record<string, string>} */
  const npm = {};
  for (const item of ordered) {
    for (const dep of item.dependencies ?? []) npm[dep] = item.meta?.dependencyVersions?.[dep] ?? "*";
    /** @type {{ target: string; content: string }[]} */
    const outputs = [];
    if (item.type === "registry:theme") {
      outputs.push({ target: posix.join(layout.cssDir, `byterygon-${item.name}.css`), content: themeCss(item) });
    } else {
      for (const file of item.files ?? []) {
        const path = String(file.path ?? "");
        const target = typeof file.target === "string" && file.target ? file.target : file.type === "registry:lib" ? posix.join(layout.lib, path.replace(/^lib\//, "")) : file.type === "registry:ui" ? posix.join(layout.ui, path.replace(/^ui\//, "")) : path;
        outputs.push({ target, content: rewriteAliases(String(file.content ?? ""), layout.aliases) });
      }
    }
    for (const { target, content } of outputs) {
      const reason = outside(realRoot, target);
      if (reason) {
        refused.push({ path: target, item: item.name, reason });
        continue;
      }
      const absolute = resolve(realRoot, target);
      const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
      const action = current === undefined ? "create" : current === content ? "unchanged" : overwrite ? "overwrite" : "skip";
      files.push({ path: relative(realRoot, absolute).split("\\").join("/"), item: item.name, action, content });
    }
  }
  if (refused.length > 0) {
    throw new RegistryError("outside-project", `refused: ${refused.length} file(s) would be written outside ${realRoot}; nothing was written`, { refused });
  }

  const pkgFile = join(realRoot, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
  const have = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  const missing = Object.fromEntries(Object.entries(npm).filter(([name]) => !(name in have)));

  if (!dryRun) {
    for (const file of files) {
      if (file.action !== "create" && file.action !== "overwrite") continue;
      const absolute = join(realRoot, file.path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, file.content);
    }
  }

  const themes = files.filter((f) => f.path.endsWith(".css") && f.item.startsWith("theme-"));
  const next = [
    ...themes.map((f) => `Import ${basename(f.path)} after Tailwind in your main CSS${layout.cssFile ? ` (${layout.cssFile})` : ""}: @import "tailwindcss"; then @import "./${posix.relative(layout.cssDir, f.path)}";`),
    ...(Object.keys(missing).length > 0 ? [`Add the npm packages from your mirror (no network here): ${Object.entries(missing).map(([n, v]) => `${n}@${v}`).join(" ")}`] : []),
    ...(files.some((f) => f.action === "skip") ? ["Some files exist with other contents and were left alone; pass overwrite: true to replace them."] : []),
    ...(!layout.hasComponentsJson ? ["The project has no components.json; the shadcn default aliases (@/components/ui, @/lib) were used."] : []),
  ];
  return {
    project: realRoot,
    dryRun,
    items: ordered.map((i) => i.name),
    files: files.map(({ content: _content, ...rest }) => rest),
    missingDependencies: missing,
    next,
  };
}

/** Why `target` may not be written in `root` (a real path), or undefined when it may. */
function outside(/** @type {string} */ root, /** @type {string} */ target) {
  if (isAbsolute(target)) return "an absolute path";
  const absolute = resolve(root, target);
  const rel = relative(root, absolute);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return "outside the project folder";
  // The nearest existing folder must really be inside the project (no symbolic link out of it).
  let dir = dirname(absolute);
  while (!existsSync(dir)) dir = dirname(dir);
  const real = relative(root, realpathSync(dir));
  if (real.startsWith("..") || isAbsolute(real)) return "a symbolic link leads outside the project folder";
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) return "the file is a symbolic link";
  return undefined;
}

/** The registry's `@/components/ui/` and `@/lib/` imports, at the project's aliases. */
function rewriteAliases(/** @type {string} */ source, /** @type {{ ui: string; lib: string }} */ aliases) {
  let out = source;
  if (aliases.ui !== "@/components/ui") out = out.replace(/(["'])@\/components\/ui\//g, `$1${aliases.ui}/`);
  if (aliases.lib !== "@/lib") out = out.replace(/(["'])@\/lib\//g, `$1${aliases.lib}/`);
  return out;
}
