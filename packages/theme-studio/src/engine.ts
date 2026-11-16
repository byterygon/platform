// Everything the Studio shows about a theme comes from @byterygon/design-tokens: the token set, the
// diagnostics (theme-file problems and every rule, contrast included), the measured contrast pairs,
// and the preview CSS. Nothing here re-implements a rule or a contrast check (spec section 9a: one
// engine; the Studio and by-tokens give the same answers).
import {
  type ContrastMeasurement,
  type Diagnostic,
  type ModeContext,
  type ResolvedSeeds,
  type Token,
  type TokenSet,
  cssValue,
  dependentAxes,
  generateTokens,
  overStack,
  resolve,
  validate,
} from "@byterygon/design-tokens";
import { renderTokensCss } from "@byterygon/design-tokens/build";
import type { ThemeDoc } from "./state/theme-edit.ts";

export interface Derived {
  readonly set: TokenSet;
  readonly seeds: ResolvedSeeds;
  /** Theme-file problems first, then rule violations, as `by-tokens validate` reports them. */
  readonly diagnostics: readonly Diagnostic[];
  readonly contrast: readonly ContrastMeasurement[];
  readonly errors: number;
  readonly warnings: number;
  /** `tokens.css` of the theme, byte for byte what the export writes. */
  readonly css: string;
}

/** Generates, validates and renders the preview CSS (a few milliseconds; runs on every edit). */
export function derive(theme: ThemeDoc): Derived {
  const generated = generateTokens(theme);
  const checked = validate(generated.set);
  const diagnostics = [...generated.diagnostics, ...checked.diagnostics];
  return {
    set: generated.set,
    seeds: generated.seeds,
    diagnostics,
    contrast: checked.contrast,
    errors: diagnostics.filter((d) => d.severity === "error").length,
    warnings: diagnostics.filter((d) => d.severity === "warning").length,
    css: renderTokensCss(generated.set, "Theme Studio"),
  };
}

/** The mode combinations a token's resolved value differs by (one entry, `{}`, when it does not vary). */
export function contextsOf(set: TokenSet, path: string): { label: string; context: ModeContext }[] {
  const axes = set.axes.filter((axis) => dependentAxes(set, path).has(axis.name));
  const base = Object.fromEntries(set.axes.map((axis) => [axis.name, axis.default]));
  if (axes.length === 0) return [{ label: "all modes", context: base }];
  let combos: { label: string[]; context: Record<string, string> }[] = [{ label: [], context: base }];
  for (const axis of axes) {
    combos = combos.flatMap((combo) => axis.modes.map((mode) => ({ label: [...combo.label, mode], context: { ...combo.context, [axis.name]: mode } })));
  }
  return combos.map((combo) => ({ label: combo.label.join(", "), context: combo.context }));
}

export interface ResolvedView {
  /** CSS text of the resolved value. */
  readonly css: string;
  /** Aliases followed, from the token to the literal. */
  readonly chain: readonly string[];
  /** For colours: OKLCH lightness, chroma, hue and alpha, and the sRGB hex. */
  readonly oklch?: { l: number; c: number; h: number; alpha: number; hex: string };
  readonly error?: string;
}

/** A token's resolved value in one context, as the engine resolves it. */
export function resolvedView(set: TokenSet, token: Token, context: ModeContext): ResolvedView {
  const resolution = resolve(set, token.path, context);
  if (!resolution.ok) return { css: "", chain: resolution.chain, error: `${resolution.reason} at ${resolution.at}` };
  const value = resolution.value;
  const view: ResolvedView = { css: cssValue(token.type, value as never), chain: resolution.chain };
  if (token.type === "color" && typeof value === "object" && value !== null && "components" in value) {
    const [l, c, h] = value.components as readonly [number, number, number];
    return { ...view, oklch: { l, c, h, alpha: (value as { alpha?: number }).alpha ?? 1, hex: (value as { hex: string }).hex } };
  }
  return view;
}

/** The measured contrast pairs a token takes part in (as text, background or a layer under it). */
export function contrastOf(contrast: readonly ContrastMeasurement[], path: string): ContrastMeasurement[] {
  return contrast.filter((m) => m.fg === path || m.bg === path || (m.over !== undefined && overStack(m).includes(path)));
}

/** Diagnostics about one token. */
export function diagnosticsOf(diagnostics: readonly Diagnostic[], path: string): Diagnostic[] {
  return diagnostics.filter((d) => d.token === path || d.token === `overrides.${path}` || d.related === path);
}

/** A short label for a mode context (`light`, `dark, compact`). */
export const modeLabel = (mode: ModeContext) => Object.values(mode).join(", ");
