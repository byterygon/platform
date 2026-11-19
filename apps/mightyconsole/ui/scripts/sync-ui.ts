#!/usr/bin/env node
// Installs the Byterygon UI items Mightyconsole uses from packages/ui/registry (Mightyconsole spec
// §2.1, as DBee does): the registry is the source, the copies under src/components/ui and src/lib
// are the install, byte for byte, as the shadcn CLI would write them (packages/ui's verify-install
// proves that path with the real CLI, offline). Nothing is fetched. `--check` exits 3 when a copy
// differs from its item, so CI fails when the registry moved on without this app.
//
//   node scripts/sync-ui.ts            # write the copies
//   node scripts/sync-ui.ts --check    # report drift, change nothing
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REGISTRY = join(APP, "..", "..", "..", "packages", "ui", "registry");

/** The components the shell of spec §3 and the tools compose, plus what they depend on. */
export const ITEMS = [
  "button", "icon-button", "input", "textarea", "number-input", "password-input", "search-input",
  "file-input", "checkbox", "radio-group", "switch", "select", "toggle-group", "field", "kbd",
  "dialog", "alert-dialog", "sheet", "popover", "tooltip", "dropdown-menu", "context-menu", "tabs",
  "toast", "command-palette", "sidebar", "tree", "resizable", "toolbar", "status-bar", "separator",
  "scroll-area", "badge", "alert", "empty-state", "spinner", "skeleton", "progress",
  "description-list", "code", "code-block", "json-viewer", "table", "relative-time", "timeline",
  // TSK-84 (LangGraph): the assistant graph. (Its run input editor was CodeInput until TSK-93
  // moved every query, JSON and jq input to CodeEditor.)
  "graph-view",
  // TSK-80 (messaging core): the Composer's payload editor and headers, the raw bytes view.
  "code-editor", "hex-view", "key-value-editor",
  // TSK-92 (Temporal): workflow types and task queues suggested, any name typed.
  "combobox",
  // TSK-105 (navigation row): the breadcrumb with its overflow.
  "breadcrumb",
];

interface Item {
  name: string;
  registryDependencies?: string[];
  files: { path: string; type: string; content: string }[];
}

const readItem = (name: string): Item => JSON.parse(readFileSync(join(REGISTRY, `${name}.json`), "utf8")) as Item;

/** Where an item file lands, as the shadcn CLI resolves the aliases of components.json. */
function target(file: Item["files"][number]): string {
  if (file.type === "registry:lib") return join("src", "lib", file.path.replace(/^lib\//, ""));
  return join("src", "components", "ui", file.path.replace(/^ui\//, ""));
}

/** Every item named plus its registry dependencies, in a stable order. */
export function closure(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dep of readItem(name).registryDependencies ?? []) visit(dep.replace(/^@byterygon\//, ""));
  };
  for (const name of names) visit(name);
  return [...seen].sort();
}

export function plan(): { path: string; content: string; item: string }[] {
  const out: { path: string; content: string; item: string }[] = [];
  for (const name of closure(ITEMS)) {
    for (const file of readItem(name).files) out.push({ path: target(file), content: file.content, item: name });
  }
  return out;
}

function main(args: string[]): number {
  const check = args.includes("--check");
  if (!existsSync(REGISTRY)) {
    console.error(`sync-ui: registry not found at ${REGISTRY}`);
    return 2;
  }
  const files = plan();
  const wanted = new Set(files.map((f) => f.path));
  const stale: string[] = [];
  for (const { path, content, item } of files) {
    const full = join(APP, path);
    const current = existsSync(full) ? readFileSync(full, "utf8") : undefined;
    if (current === content) continue;
    if (check) {
      stale.push(`${path} (${current === undefined ? "missing" : "differs"}; item ${item})`);
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    console.log(`sync-ui: wrote ${path}`);
  }
  // A copy of an item that is no longer used is reported too, so src/components/ui holds exactly
  // the install.
  const uiDir = join(APP, "src", "components", "ui");
  if (existsSync(uiDir)) {
    for (const name of readdirSync(uiDir)) {
      const path = join("src", "components", "ui", name);
      if (!wanted.has(path)) stale.push(`${path} (not an installed item)`);
    }
  }
  if (stale.length > 0) {
    console.error(`sync-ui: ${stale.length} file(s) out of date with packages/ui/registry:\n  ${stale.join("\n  ")}\nRun: pnpm --filter @byterygon/dbee sync:ui`);
    return 3;
  }
  console.log(`sync-ui: ${files.length} files from ${closure(ITEMS).length} items are current`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
