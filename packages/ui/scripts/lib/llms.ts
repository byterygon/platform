// llms.txt and llms-full.txt of the registry (spec section 9a.5): written by scripts/registry.ts
// from the component manifests, the example files and the token outputs of the default theme
// (generated/default/tokens.ts and tailwind-theme.css, both written by the token engine). One set,
// in registry/, for the components and the tokens together: a project that installed the
// registry has the components and the default theme's variables, and nothing else.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tokens } from "@byterygon/design-tokens/default/tokens";
import type { Manifest } from "./manifest.ts";

const require = createRequire(import.meta.url);

/** What llms needs of a registry item. */
export interface LlmsComponent {
  readonly name: string;
  readonly manifest: Manifest;
  /** The example file as a project would write it (imports at their installed paths). */
  readonly example: string;
}
export interface LlmsTheme {
  readonly name: string;
  readonly description: string;
}
export interface LlmsLib {
  readonly name: string;
  readonly llms: string;
}
export interface LlmsInput {
  readonly themes: readonly LlmsTheme[];
  readonly components: readonly LlmsComponent[];
  readonly libs: readonly LlmsLib[];
}

const INSTALL = [
  "Install (components.json: \"registries\": { \"@byterygon\": \"<this folder or URL>/{name}.json\" }, \"tailwind\": { \"baseColor\": \"\" }):",
  "",
  "    shadcn add <this folder>/theme-default.json @byterygon/button",
];

const RULES = [
  "Rules for code on these components (the ESLint and Stylelint rules of @byterygon/lint enforce them; their messages name the role to use):",
  "",
  "- Style with the token roles only: Tailwind names such as bg-surface, text-fg-muted, border-border-subtle, p-inset-sm, gap-gap-md, h-control-md, rounded-md, text-body-1, shadow-layer. No raw colours (#hex, rgb(), oklch(), bg-blue-500), no arbitrary values (p-[13px]) other than token variables (var(--by-...)), no raw space steps (p-2, gap-3).",
  "- Props follow Fluent 2: appearance (primary, secondary, outline, subtle, transparent; danger on Button and IconButton; outline, underline, filled-darker, filled-lighter on fields) and size (small, medium, large). The old variant and sm/md/lg still work for one release and are marked deprecated below.",
  "- Icons: the Icon component with an icon from @/lib/icons (Fluent UI System Icons, vendored), never an icon font or a CDN.",
  "- Themes are files (seeds plus overrides): edit one, then run `by-tokens validate` (@byterygon/design-tokens); `by-tokens search <words>` and `by-tokens explain <token>` find and describe tokens.",
];

/** One component's section, shared by both files. */
function componentSection(component: LlmsComponent): string[] {
  const { manifest, name } = component;
  const lines = [`### ${manifest.title}`, "", `[${name}.json](${name}.json): ${manifest.description}`, "", `Usage: ${manifest.usage}`, ""];
  lines.push(`- Wraps: ${manifest.base ?? "no Base UI part"}`);
  if (manifest.parts?.length) lines.push(`- Parts: ${manifest.parts.map((p) => `${p.name} (data-slot ${p.slot}): ${p.description}`).join("; ")}`);
  for (const [prop, values] of Object.entries(manifest.variants)) lines.push(`- ${prop}: ${values.join(", ")}`);
  lines.push(`- Props: ${manifest.props.map((p) => `${p.name} (${p.type}${p.default !== undefined ? `, default ${JSON.stringify(p.default)}` : ""}${p.deprecated ? `, deprecated: ${p.deprecated}` : ""})`).join("; ")}`);
  lines.push(`- States: ${manifest.states.map((s) => `${s.name} (${s.variant})`).join(", ")}`);
  lines.push(`- Tokens: ${manifest.tokens.join(", ")}`);
  lines.push(`- Accessibility: ${manifest.accessibility.join(" ")}`, "");
  return lines;
}

/** The short index: what each item is, with its manifest in a few lines. */
export function llmsTxt(input: LlmsInput): string {
  const lines = [
    "# Byterygon UI registry",
    "",
    "> Base UI components styled with Byterygon design-token roles, as a static shadcn registry. No network: install from this folder or from a static server you host.",
    "",
    "[llms-full.txt](llms-full.txt) has the same and, in full, every component's examples and the token catalogue (each role's purpose, CSS variable, Tailwind name and values per mode).",
    "",
    ...INSTALL,
    "",
    ...RULES,
    "",
    "## Themes",
    "",
    ...input.themes.map((theme) => `- [${theme.name}](${theme.name}.json): ${theme.description}`),
    "",
    "## Components",
    "",
  ];
  for (const component of input.components) lines.push(...componentSection(component));
  lines.push("## Helpers", "", ...input.libs.map((lib) => `- [${lib.name}.json](${lib.name}.json): ${lib.llms}`), "");
  return lines.join("\n");
}

/** Everything: llms.txt plus each component's example file and the token catalogue. */
export function llmsFullTxt(input: LlmsInput): string {
  const lines = [
    "# Byterygon UI registry, full reference",
    "",
    "> Base UI components styled with Byterygon design-token roles, as a static shadcn registry, and the design tokens they use. Generated by packages/ui/scripts/registry.ts from the component manifests, the example files and the token outputs of the default theme; regenerate, never edit.",
    "",
    ...INSTALL,
    "",
    ...RULES,
    "",
    "## Themes",
    "",
    ...input.themes.map((theme) => `- [${theme.name}](${theme.name}.json): ${theme.description}`),
    "",
    "## Components",
    "",
    "Each component: its manifest, then its example file (a minimal and a realistic example, which the test suite renders), with imports at the paths the registry installs them to.",
    "",
  ];
  for (const component of input.components) {
    lines.push(...componentSection(component));
    lines.push(`Examples (${component.manifest.examples.minimal}, ${component.manifest.examples.realistic}):`, "", "```tsx", component.example.trimEnd(), "```", "");
  }
  lines.push("## Helpers", "", ...input.libs.map((lib) => `- [${lib.name}.json](${lib.name}.json): ${lib.llms}`), "");
  lines.push(...tokenCatalogue());
  return lines.join("\n");
}

type TokenEntry = (typeof tokens)[keyof typeof tokens] & { readonly values: Readonly<Record<string, string>> };

/** Tailwind theme variables per token CSS variable, read from the default theme's tailwind-theme.css. */
function tailwindNames(): Map<string, string[]> {
  const css = readFileSync(require.resolve("@byterygon/design-tokens/default/tailwind-theme.css"), "utf8");
  const names = new Map<string, string[]>();
  for (const m of css.matchAll(/^\s*(--[a-z]+-[a-z0-9-]+):\s*var\((--by-[a-z0-9-]+)\);/gm)) {
    if (m[1]!.includes("--", 2)) continue; // --text-x--line-height and the like belong to the text role
    names.set(m[2]!, [...(names.get(m[2]!) ?? []), m[1]!]);
  }
  return names;
}

/** `*-surface (--color-surface)`: the utility suffix and the theme variable. */
function utilityText(variables: readonly string[] | undefined): string {
  if (!variables?.length) return "";
  return ` Tailwind ${variables.map((v) => `\`*-${v.replace(/^--[a-z]+-/, "")}\` (${v})`).join(", ")}.`;
}

function valuesText(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values);
  if (entries.length === 1 && entries[0]![0] === "base") return entries[0]![1];
  return entries.map(([mode, value]) => `${mode} ${value}`).join(", ");
}

/** The token catalogue of the default theme: every role in full, the primitives in groups. */
function tokenCatalogue(): string[] {
  const all = Object.entries(tokens) as [string, TokenEntry][];
  const tailwind = tailwindNames();
  const lines = [
    "## Tokens",
    "",
    "The catalogue of the default theme (theme-default.json, Aurora). Components and app code use the roles (semantic and component tokens); primitives are what roles point to and are never used directly. Each role: its path, its CSS variable, its Tailwind name, its values per mode (theme: light, dark; density: comfortable, compact) and when to use it and when not to.",
    "",
    "Tailwind names: `--color-X` gives bg-X, text-X, border-X, ring-X; `--spacing-X` gives p-X, m-X, gap-X, space-y-X, w-X, h-X, size-X; `--radius-X` rounded-X; `--text-X` text-X (size, weight, line height and tracking together); `--shadow-X` shadow-X; `--ease-X` ease-X; `--font-X` font-X; `--blur-X` backdrop-blur-X. A token without a Tailwind name is used as var(--by-...), for example `duration-[var(--by-motion-duration-fast)]`.",
    "",
  ];
  const roles = all.filter(([, token]) => token.tier !== "primitive");
  const groups = new Map<string, [string, TokenEntry][]>();
  for (const entry of roles) {
    const group = entry[0].split(".")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  for (const [group, entries] of groups) {
    lines.push(`### ${group} (roles)`, "");
    for (const [path, token] of entries) {
      lines.push(`- \`${path}\` (${token.tier} ${token.type}): \`${token.cssVar}\`.${utilityText(tailwind.get(token.cssVar))} Values: ${valuesText(token.values)}. ${token.description}`);
    }
    lines.push("");
  }
  lines.push("### Primitives", "", "Grouped by family; the values are the default theme's. Reference them through a role.", "");
  const families = new Map<string, [string, TokenEntry][]>();
  for (const entry of all.filter(([, token]) => token.tier === "primitive")) {
    const segments = entry[0].split(".");
    const family = segments.length > 1 ? segments.slice(0, -1).join(".") : segments[0]!;
    families.set(family, [...(families.get(family) ?? []), entry]);
  }
  for (const [family, entries] of families) {
    const first = entries[0]![1].description.split(/(?<=\.) /)[0];
    const values = entries.map(([path, token]) => `${path.slice(family.length + 1) || path}=${valuesText(token.values)}`).join("; ");
    lines.push(`- \`${family}.*\` (${entries.length} ${entries[0]![1].type}): ${first} ${values}.${utilityText(entries.flatMap(([, t]) => tailwind.get(t.cssVar) ?? []))}`);
  }
  lines.push("");
  return lines;
}
