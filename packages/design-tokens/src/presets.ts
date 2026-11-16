/**
 * The built-in presets as the Theme Studio and `by-tokens preset` present them: their labels and
 * order, and how a copy of a theme is made. The theme files themselves are `themes/<name>.theme.json`
 * (the CLI reads that folder; the Studio bundles it), so this module holds no theme data. Pure: no
 * Node APIs, runs in the browser.
 */
import { isPlainObject } from "./util.js";

/**
 * Labels of the built-in presets, in the order the Studio's gallery shows them (`default` first).
 * A test keeps this list equal to the files in `themes/`.
 */
export const PRESET_LABELS: Readonly<Record<string, string>> = {
  default: "Aurora",
  classic: "Classic",
  slate: "Slate",
  paper: "Paper",
  midnight: "Midnight",
  terminal: "Terminal",
  "high-contrast": "High contrast",
};

/** A preset's label: its entry in `PRESET_LABELS`, else its name with dashes as spaces, capitalised. */
export function presetLabel(name: string): string {
  const known = PRESET_LABELS[name];
  if (known !== undefined) return known;
  const words = name.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Preset names in gallery order: the labelled ones in `PRESET_LABELS` order, then the rest sorted. */
export function presetOrder(names: Iterable<string>): string[] {
  const order = Object.keys(PRESET_LABELS);
  const rank = (name: string) => {
    const index = order.indexOf(name);
    return index === -1 ? order.length : index;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Theme names are lower-case letters, digits and dashes (`theme.schema.json`). */
export const THEME_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * A free name for a copy of `base`: `<base>-copy`, then `<base>-copy-2`, `-copy-3`... A base that
 * already ends in `-copy` or `-copy-<n>` counts on from it instead of growing the suffix.
 */
export function copyName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const stem = base.replace(/-copy(-\d+)?$/, "") || "theme";
  if (!used.has(`${stem}-copy`)) return `${stem}-copy`;
  for (let n = 2; ; n += 1) if (!used.has(`${stem}-copy-${n}`)) return `${stem}-copy-${n}`;
}

/**
 * A new theme file copied from `base` under `name`, as `by-tokens preset create <name> --from
 * <base>` writes it: the seeds and overrides kept, no `$schema`, `name` set, and the description
 * "Based on the <base> preset." Without a base, an empty theme on the engine defaults.
 */
export function duplicateTheme(base: unknown, name: string, baseName?: string): Record<string, unknown> {
  const theme: Record<string, unknown> = isPlainObject(base) ? structuredClone(base) : { schemaVersion: 1 };
  delete theme["$schema"];
  theme["name"] = name;
  const from = baseName ?? (isPlainObject(base) && typeof base["name"] === "string" ? base["name"] : undefined);
  theme["description"] = isPlainObject(base) ? `Based on the ${from ?? "unnamed"} preset.` : "A new theme on the engine defaults.";
  return theme;
}
