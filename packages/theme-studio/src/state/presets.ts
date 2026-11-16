// The built-in presets: the theme files in packages/design-tokens/themes/, the folder by-tokens
// reads, bundled at build time (Vite's import.meta.glob, so nothing is fetched at run time). Labels
// and order come from the engine (`presetLabel`, `presetOrder`); the Studio names no preset itself.
import { presetLabel, presetOrder } from "@byterygon/design-tokens";
import type { ThemeDoc } from "./theme-edit.ts";

const FILES = import.meta.glob<ThemeDoc>("../../../design-tokens/themes/*.theme.json", { eager: true, import: "default" });

export interface Preset {
  /** The theme name, as `by-tokens --theme <name>` takes it. */
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** The theme file, exactly as `themes/<name>.theme.json` holds it. */
  readonly theme: ThemeDoc;
}

const byName = new Map(
  Object.entries(FILES).map(([path, theme]) => {
    const name = path.slice(path.lastIndexOf("/") + 1, -".theme.json".length);
    return [name, theme] as const;
  }),
);

/** Every built-in preset, in the gallery's order (`default` first). */
export const PRESETS: readonly Preset[] = presetOrder(byName.keys()).map((name) => {
  const theme = byName.get(name)!;
  return { name, label: presetLabel(name), description: typeof theme["description"] === "string" ? theme["description"] : "", theme };
});

/** The theme file a preset opens as: the file without its editor-only `$schema` pointer. */
export function presetTheme(preset: Preset): ThemeDoc {
  const { $schema: _schema, ...theme } = structuredClone(preset.theme) as ThemeDoc & { $schema?: unknown };
  return theme;
}
