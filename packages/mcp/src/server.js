// @ts-check
/**
 * @byterygon/ui-mcp: the Byterygon UI MCP server (spec section 9a.5). Tools for coding agents,
 * each a thin call into the token engine (by-tokens), the local registry or @byterygon/lint:
 *
 *   search_tokens, explain_token      by-tokens search / explain --json
 *   validate_theme                    by-tokens validate --json (a preset, a file, or a file's content)
 *   list_components, get_component    the registry items' manifests and example files
 *   list_registry_items               registry.json
 *   install_registry_item             writes the items (and their dependencies) into a project folder
 *   install_theme                     writes a theme file's (or a preset's) CSS into a project folder
 *   check_classes                     the @byterygon/lint analysis of class names
 *
 * and the registry's llms.txt and llms-full.txt as resources. Transport: stdio only (bin/by-ui-mcp.js).
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { analyzeClass, classesIn, loadCatalog, tailwindPalette } from "@byterygon/lint";
import * as z from "zod";
import { Registry, RegistryError, defaultRegistryDir, install } from "./registry.js";
import { byTokens, validateTheme } from "./tokens.js";

export const NAME = "byterygon-ui";
export const VERSION = "0.0.0";

const INSTRUCTIONS = `Byterygon UI: Base UI components styled only with design-token roles, installed from a local shadcn registry, plus the token engine.
- Find a token: search_tokens (words in its path, description or Tailwind name), then explain_token for its values per mode, alias chain and contrast pairs.
- Use a component: list_components, then get_component for its props, variants, parts, states, tokens and example code; install_registry_item writes it (and what it needs) into the project folder you give. Try dryRun first.
- Install a theme item (theme-default or another preset) once per project, and import its CSS after Tailwind. A custom theme file goes in with install_theme.
- Style with role utilities only (bg-surface, text-fg-muted, p-inset-sm, gap-gap-md, h-control-md); check_classes says what to use instead of a raw colour, an arbitrary value or a raw space step.
- Change a theme by editing its file (seeds plus overrides), then validate_theme; failures name the token, mode, rule, measured and required value and a fix.
Everything is local: nothing here uses the network.`;

/** A tool result: the JSON document as text. */
const result = (/** @type {unknown} */ document, isError = false) => ({ content: [{ type: /** @type {const} */ ("text"), text: JSON.stringify(document, null, 2) }], ...(isError ? { isError: true } : {}) });

/** Runs a handler and turns a RegistryError (or any error) into an error result. */
async function guarded(/** @type {() => Promise<unknown> | unknown} */ handler) {
  try {
    return result(await handler());
  } catch (error) {
    if (error instanceof RegistryError) return result({ ok: false, error: { code: error.code, message: error.message, ...error.details } }, true);
    return result({ ok: false, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } }, true);
  }
}

/** A by-tokens document as a result; usage and internal errors (exit 2, 70) are tool errors. */
const tokensResult = (/** @type {{ exitCode: number; document: unknown }} */ outcome) => result(outcome.document, outcome.exitCode === 2 || outcome.exitCode === 70);

/**
 * @param {{ registryDir?: string; cwd?: string }} [options]
 *   registryDir: the registry folder (default: @byterygon/ui's registry/);
 *   cwd: where relative theme and project paths are read from (default: the process's).
 */
export function createServer(options = {}) {
  const registry = new Registry(options.registryDir ?? defaultRegistryDir());
  const cwd = options.cwd ?? process.cwd();
  const server = new McpServer({ name: NAME, version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };
  const theme = z.string().optional().describe("A built-in preset name (default, classic, slate, paper, midnight, terminal, high-contrast) or a theme file path. Default: default.");

  server.registerTool(
    "search_tokens",
    {
      title: "Search tokens",
      description: "Find design tokens by words in their path, description, CSS variable or Tailwind name; roles rank before primitives. The by-tokens search --json document.",
      inputSchema: {
        query: z.string().describe("Words, for example \"hover background\" or \"inset padding\"."),
        tier: z.enum(["primitive", "semantic", "component"]).optional(),
        type: z.string().optional().describe("A token type: color, dimension, shadow, duration, number, fontFamily, fontWeight, cubicBezier, gradient."),
        limit: z.number().int().min(1).max(200).optional(),
        theme,
      },
      annotations: readOnly,
    },
    async ({ query, tier, type, limit, theme: t }) =>
      tokensResult(await byTokens(["search", ...query.split(/\s+/).filter(Boolean), ...(tier ? ["--tier", tier] : []), ...(type ? ["--type", type] : []), ...(limit ? ["--limit", String(limit)] : []), ...(t ? ["--theme", t] : [])], cwd)),
  );

  server.registerTool(
    "explain_token",
    {
      title: "Explain a token",
      description: "Everything about one token: when to use it and when not to, its value in each mode, the alias chain, what references it, its contrast pairs and diagnostics. Accepts a dot path (color.bg.surface), a --by- variable or a Tailwind variable. The by-tokens explain --json document.",
      inputSchema: { token: z.string(), theme },
      annotations: readOnly,
    },
    async ({ token, theme: t }) => tokensResult(await byTokens(["explain", token, ...(t ? ["--theme", t] : [])], cwd)),
  );

  server.registerTool(
    "validate_theme",
    {
      title: "Validate a theme",
      description: "Run every rule of the token engine on a theme (aliases, tiers, raw colours, contrast in every mode and density) and return the by-tokens validate --json document: each diagnostic names the token, mode, rule, measured and required value and a fix ready to merge into the theme file. Give theme (a preset or a file path) or content (the theme file's JSON text), not both.",
      inputSchema: {
        theme,
        content: z.string().optional().describe("The theme file's content (JSON with schemaVersion, name, seeds, overrides)."),
        contrast: z.boolean().optional().describe("List every measured contrast pair, not only the lowest."),
      },
      annotations: readOnly,
    },
    async ({ theme: t, content, contrast }) => {
      if (t !== undefined && content !== undefined) return result({ ok: false, error: { code: "usage", message: "give theme or content, not both" } }, true);
      return tokensResult(await validateTheme({ ...(t !== undefined ? { theme: t } : {}), ...(content !== undefined ? { content } : {}), ...(contrast ? { contrast } : {}), cwd }));
    },
  );

  server.registerTool(
    "list_components",
    { title: "List components", description: "Every component of the registry: name, title, description, usage note (when to use it, how to compose it, what to use instead) and parts.", inputSchema: {}, annotations: readOnly },
    async () => guarded(() => ({ components: registry.components() })),
  );

  server.registerTool(
    "get_component",
    {
      title: "Get a component",
      description: "One component's manifest (props with types and defaults, Fluent appearance and size names, deprecated aliases, variants, parts, slots, states, the tokens it uses, accessibility) and its example file (a minimal and a realistic example) with imports at installed paths. includeSource adds the component's source as the registry installs it.",
      inputSchema: { name: z.string().describe("The component's registry name, for example button or date-picker."), includeSource: z.boolean().optional() },
      annotations: readOnly,
    },
    async ({ name, includeSource }) => guarded(() => registry.component(name, includeSource ?? false)),
  );

  server.registerTool(
    "list_registry_items",
    {
      title: "List registry items",
      description: "The items of the local registry (registry.json): components (registry:ui), helpers (registry:lib) and themes (registry:theme, one per token preset), with their npm and registry dependencies.",
      inputSchema: { type: z.enum(["registry:ui", "registry:lib", "registry:theme"]).optional() },
      annotations: readOnly,
    },
    async ({ type }) => guarded(() => ({ registry: registry.dir, items: registry.list(type) })),
  );

  server.registerTool(
    "install_registry_item",
    {
      title: "Install registry items",
      description: "Write registry items, and the registry items they depend on, into a project folder, at the paths of its components.json aliases (shadcn defaults otherwise); a theme item becomes byterygon-<theme>.css next to the project's main CSS. Writes only inside the project folder and refuses the whole install if any file would land outside it. dryRun lists the files and writes nothing. Existing files with other contents are left alone unless overwrite. npm packages are not installed (no network): the result lists the missing ones with versions.",
      inputSchema: {
        project: z.string().describe("The project folder (absolute, or relative to the server's working folder)."),
        items: z.array(z.string()).min(1).describe("Item names: button, @byterygon/date-picker, theme-default."),
        dryRun: z.boolean().optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, items, dryRun, overwrite }) => guarded(() => install(registry, { project: resolve(cwd, project), items, dryRun: dryRun ?? false, overwrite: overwrite ?? false })),
  );

  server.registerTool(
    "install_theme",
    {
      title: "Install a theme file",
      description: "Install a theme into a project folder: a built-in preset name or a theme file (seeds plus overrides, for example one made with by-tokens preset create and checked with validate_theme). The token engine exports it as a registry theme item (by-tokens export registry) and it is written as byterygon-theme-<name>.css next to the project's main CSS, like install_registry_item does for theme-<preset>; import it after Tailwind instead of the previous theme. Same folder rules, dryRun and overwrite.",
      inputSchema: {
        project: z.string().describe("The project folder (absolute, or relative to the server's working folder)."),
        theme: z.string().describe("A preset name or a theme file path."),
        dryRun: z.boolean().optional(),
        overwrite: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ project, theme: t, dryRun, overwrite }) => {
      const exported = await byTokens(["export", "registry", "--theme", t], cwd);
      if (exported.exitCode !== 0) return result(exported.document, true);
      const item = JSON.parse(String(exported.document["content"]));
      return guarded(() => install(registry, { project: resolve(cwd, project), items: [], extra: [item], dryRun: dryRun ?? false, overwrite: overwrite ?? false }));
    },
  );

  server.registerTool(
    "check_classes",
    {
      title: "Check classes",
      description: "Run the @byterygon/lint analysis on Tailwind class names: raw colours, arbitrary values and raw space steps, each with the role to use instead (from the theme's catalogue). Classes that pass are not listed.",
      inputSchema: { classes: z.string().describe("Class names separated by spaces, as in a className."), theme },
      annotations: readOnly,
    },
    async ({ classes, theme: t }) =>
      guarded(() => {
        const context = { catalog: loadCatalog(t), palette: tailwindPalette(cwd) };
        const findings = classesIn(classes).flatMap((name) => analyzeClass(name, context).map((f) => ({ class: name, ...f })));
        return { ok: findings.length === 0, findings };
      }),
  );

  for (const file of ["llms.txt", "llms-full.txt"]) {
    server.registerResource(
      file,
      `byterygon-ui://registry/${file}`,
      { title: file, description: file === "llms.txt" ? "The registry index for agents: every item with its manifest in brief." : "llms.txt plus every example file and the token catalogue.", mimeType: "text/plain" },
      async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: readFileSync(join(registry.dir, file), "utf8") }] }),
    );
  }
  return server;
}
