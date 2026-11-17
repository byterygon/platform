// Appearance (as DBee, spec §3.6): the seven token presets (Aurora, the default, and Classic
// first), the colour scheme (system, light, dark) and the density. The presets' tokens.css files
// are bundled as text and the chosen one is swapped into a <style> element; the role names are the
// same in every preset, so the Tailwind theme loaded by index.css applies to all of them. Nothing
// is fetched.
import classicCss from "@byterygon/design-tokens/presets/classic/tokens.css?inline";
import defaultCss from "@byterygon/design-tokens/default/tokens.css?inline";
import highContrastCss from "@byterygon/design-tokens/presets/high-contrast/tokens.css?inline";
import midnightCss from "@byterygon/design-tokens/presets/midnight/tokens.css?inline";
import paperCss from "@byterygon/design-tokens/presets/paper/tokens.css?inline";
import slateCss from "@byterygon/design-tokens/presets/slate/tokens.css?inline";
import terminalCss from "@byterygon/design-tokens/presets/terminal/tokens.css?inline";

export const PRESETS = ["default", "classic", "high-contrast", "midnight", "paper", "slate", "terminal"] as const;
export type Preset = (typeof PRESETS)[number];
export type ColorScheme = "system" | "light" | "dark";
export type Density = "compact" | "comfortable";

export const PRESET_LABELS: Record<Preset, string> = {
  default: "Aurora (default)",
  classic: "Classic",
  "high-contrast": "High contrast",
  midnight: "Midnight",
  paper: "Paper",
  slate: "Slate",
  terminal: "Terminal",
};

const CSS: Record<Preset, string> = {
  default: defaultCss,
  classic: classicCss,
  "high-contrast": highContrastCss,
  midnight: midnightCss,
  paper: paperCss,
  slate: slateCss,
  terminal: terminalCss,
};

const STYLE_ID = "mightyconsole-tokens";

export interface Appearance {
  preset: Preset;
  colorScheme: ColorScheme;
  density: Density;
}

export const DEFAULT_APPEARANCE: Appearance = { preset: "default", colorScheme: "system", density: "comfortable" };

export function isPreset(value: unknown): value is Preset {
  return typeof value === "string" && (PRESETS as readonly string[]).includes(value);
}

/** The scheme the OS asks for, read once per call. */
export function systemScheme(): "light" | "dark" {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applies the appearance to the document: the preset's tokens, data-theme and data-density. */
export function applyAppearance(appearance: Appearance, doc: Document = document): void {
  const root = doc.documentElement;
  let style = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (appearance.preset === "default") {
    // index.css already carries the default preset.
    style?.remove();
  } else {
    if (style === null) {
      style = doc.createElement("style");
      style.id = STYLE_ID;
      doc.head.append(style);
    }
    const css = CSS[appearance.preset];
    if (style.textContent !== css) style.textContent = css;
  }
  root.dataset["preset"] = appearance.preset;
  root.dataset["theme"] = appearance.colorScheme === "system" ? systemScheme() : appearance.colorScheme;
  root.dataset["density"] = appearance.density;
}

/** Re-applies the appearance when the OS scheme changes and `colorScheme` is "system". */
export function followSystemScheme(get: () => Appearance): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const media = matchMedia("(prefers-color-scheme: dark)");
  const listener = () => {
    if (get().colorScheme === "system") applyAppearance(get());
  };
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
