/**
 * Exports: one function for `by-tokens export` and the Theme Studio's Export panel, so the two give
 * the same bytes for the same theme file (spec section 9a.1; a test in the Studio compares them for
 * every preset and format). Also the install note of each format, which the CLI prints with
 * `--json` and the Studio shows next to the file.
 *
 * Runs in Node and in the browser (Style Dictionary, no Node APIs).
 */
import { buildTheme } from "./build.js";
import { type Diagnostic, SCHEMA_VERSION } from "./model.js";
import { OUTPUT_ALIASES, type OutputFile } from "./outputs.js";
import type { ResolvedSeeds } from "./seeds.js";
import { isPlainObject, stableJson } from "./util.js";

export type ExportFormat = "css" | "tailwind" | "shadcn" | "dtcg" | "figma" | "ts" | "monaco" | "registry" | "theme";

export interface ExportFormatInfo {
  readonly format: ExportFormat;
  /** What the Studio calls it. */
  readonly label: string;
  /** The output file, as `by-tokens build` names it (the theme file: `<name>.theme.json`). */
  readonly file: (theme: string) => string;
  /** The name to save it under in a project. */
  readonly download: (theme: string) => string;
  /** Media type for a download. */
  readonly mediaType: string;
  /** One paragraph: where the file goes and what to do with it. */
  readonly install: string;
}

const output = (file: OutputFile) => () => file;

/** Every export, in the order the Studio lists them. */
export const EXPORT_FORMATS: readonly ExportFormatInfo[] = [
  {
    format: "css",
    label: "CSS variables",
    file: output("tokens.css"),
    download: () => "tokens.css",
    mediaType: "text/css",
    install:
      "Every token as a --by-* custom property: primitives on :root, roles per mode. Copy it into the project (next to globals.css) and import it before Tailwind: @import \"./tokens.css\"; @import \"tailwindcss\";. Switch modes with data-theme=\"light|dark\" (or .light/.dark) and data-density=\"comfortable|compact\" on any element. Import @byterygon/design-tokens/fonts/fonts.css first for Inter and JetBrains Mono.",
  },
  {
    format: "tailwind",
    label: "Tailwind v4 @theme",
    file: output("tailwind-theme.css"),
    download: () => "tailwind-theme.css",
    mediaType: "text/css",
    install:
      "The Tailwind v4 utility names of the roles (bg-surface, text-fg-muted, h-control-md, p-inset-sm) as @theme inline, pointing at the --by-* variables, plus the dark variant. Import it right after @import \"tailwindcss\" and after tokens.css. It changes only when a theme adds a ramp; the values live in tokens.css.",
  },
  {
    format: "shadcn",
    label: "shadcn alias block",
    file: output("shadcn-alias.css"),
    download: () => "shadcn-alias.css",
    mediaType: "text/css",
    install:
      "Maps the Byterygon roles to the variable names stock shadcn/ui components read (--background, --primary, --ring, --sidebar-*, --chart-1..5). Import it after tokens.css in a project that also uses stock shadcn/ui components or third-party registry items; Byterygon components do not need it.",
  },
  {
    format: "dtcg",
    label: "DTCG JSON",
    file: output("tokens.dtcg.json"),
    download: () => "tokens.dtcg.json",
    mediaType: "application/json",
    install:
      "The token set as a Design Tokens Community Group (2025.10) document: every token with $type, $value per mode (in $extensions.com.byterygon), $description and its tier. Feed it to Style Dictionary, Tokens Studio or any DTCG tool; aliases are kept as {path} references.",
  },
  {
    format: "figma",
    label: "Figma variables JSON",
    file: output("figma-variables.json"),
    download: () => "figma-variables.json",
    mediaType: "application/json",
    install:
      "Variable collections (Primitives, Semantic, Theme with Light and Dark, Density) in the shape of the Figma Variables API, with aliases by name and sRGB colours. Figma cannot import it from its menus: apply it with a plugin or a script that calls the Variables API. Shadows are listed under skipped (Figma has no shadow variable).",
  },
  {
    format: "ts",
    label: "TypeScript constants",
    file: output("tokens.ts"),
    download: () => "tokens.ts",
    mediaType: "text/plain",
    install:
      "Typed constants for code that cannot use CSS variables (canvas, charts, editors, tests): tokens[path] gives the CSS variable, the description and the resolved value per mode, and cssVar(path) gives var(--by-...). Copy it into the project's source as TypeScript (it is not compiled).",
  },
  {
    format: "monaco",
    label: "Monaco theme",
    file: output("monaco-theme.ts"),
    download: () => "monaco-theme.ts",
    mediaType: "text/plain",
    install:
      "Light and Dark Monaco themes from the editor, syntax and overlay roles. Copy it into the project and call monaco.editor.defineTheme(\"my-theme-dark\", monacoThemes.dark) before creating an editor. Byterygon UI's SqlEditor does not need it: it builds the same theme from the CSS variables in scope at the editor.",
  },
  {
    format: "registry",
    label: "shadcn registry theme item",
    file: output("registry-theme.json"),
    download: (theme) => `theme-${theme}.json`,
    mediaType: "application/json",
    install:
      "A registry:theme item for the shadcn CLI. Put it in your self-hosted registry folder as theme-<name>.json, set \"tailwind\": { \"baseColor\": \"\" } in components.json, and run shadcn add /path/to/registry/theme-<name>.json (a file path works offline). It writes the --by-* variables, the shadcn aliases, the dark variant and both Tailwind vocabularies into the project CSS. Fonts are not included.",
  },
  {
    format: "theme",
    label: "Theme file",
    file: (theme) => `${theme}.theme.json`,
    download: (theme) => `${theme}.theme.json`,
    mediaType: "application/json",
    install:
      "The theme itself (seeds plus overrides) with every seed spelled out. Every other export is generated from it: by-tokens build --theme ./<name>.theme.json writes them all, by-tokens export <format> --theme ./<name>.theme.json prints one, byte for byte what the Studio exports. Commit it; open it in the Studio again with by-tokens hash encode --theme ./<name>.theme.json.",
  },
];

export const exportFormat = (format: string): ExportFormatInfo | undefined => EXPORT_FORMATS.find((info) => info.format === format);

/** The theme file with every seed spelled out (`by-tokens export theme`). */
export function formatThemeFile(theme: unknown, name: string, description: string | undefined, seeds: ResolvedSeeds): string {
  return stableJson({
    schemaVersion: SCHEMA_VERSION,
    name,
    ...(description ? { description } : {}),
    seeds,
    overrides: isPlainObject(theme) && isPlainObject(theme["overrides"]) ? theme["overrides"] : {},
  });
}

export interface ExportResult {
  /** False when the theme breaks a rule; `content` is then absent. */
  readonly ok: boolean;
  readonly theme: string;
  readonly format: ExportFormat;
  /** The output file name (see `ExportFormatInfo.file`). */
  readonly file: string;
  readonly content?: string;
  readonly diagnostics: readonly Diagnostic[];
}

export interface ExportOptions {
  /**
   * How the generated headers name the theme file. `by-tokens export --theme <file>` uses the
   * file's base name, so the Studio uses `<name>.theme.json`, the name its theme-file export saves.
   */
  readonly source?: string;
}

/** One export of a theme file. Nothing is written anywhere: the caller gets the text. */
export async function exportTheme(theme: unknown, format: ExportFormat, options: ExportOptions = {}): Promise<ExportResult> {
  const info = exportFormat(format);
  if (!info) throw new Error(`unknown export format "${format}"`);
  const name = isPlainObject(theme) && typeof theme["name"] === "string" ? theme["name"] : "unnamed";
  const source = options.source ?? `${name}.theme.json`;
  const result = await buildTheme(theme, { source, render: format !== "theme" });
  const base = { theme: result.set.name, format, file: info.file(result.set.name), diagnostics: result.diagnostics };
  if (!result.ok) return { ok: false, ...base };
  const content = format === "theme" ? formatThemeFile(theme, result.set.name, result.set.description, result.seeds) : result.files!.get(OUTPUT_ALIASES[format]!)!;
  return { ok: true, ...base, content };
}
