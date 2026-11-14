/**
 * The contrast solver: move a colour's lightness, and nothing else, until it reaches a WCAG ratio
 * against a set of colours. The ramp generator uses it for the steps whose job is defined by
 * contrast, and the validator uses it to suggest a fix for a failing role pair.
 */
import type { Oklch, Rgb } from "./convert.js";
import { wcagContrast } from "./contrast.js";
import { oklchToDisplayRgb, roundOklch } from "./css.js";
import { gamutMapSrgb } from "./gamut.js";

/** The colour as stored and shown: gamut-mapped, rounded to token precision. */
export function settle(color: Oklch): Oklch {
  return roundOklch(gamutMapSrgb(color).color);
}

/** Lowest WCAG ratio between `color` and each of `against` (all opaque), measured on 8-bit sRGB. */
export function minContrast(color: Oklch, against: readonly Rgb[]): number {
  const rgb = oklchToDisplayRgb(color);
  let lowest = Infinity;
  for (const other of against) lowest = Math.min(lowest, wcagContrast(rgb, other));
  return lowest;
}

export interface SolveOptions {
  /** Where to start. Chroma and hue are kept (chroma is re-mapped into gamut at each lightness). */
  readonly color: Oklch;
  /** Opaque colours the result must contrast with. */
  readonly against: readonly Rgb[];
  /** Required WCAG contrast ratio. */
  readonly ratio: number;
  /** -1 darkens, 1 lightens. */
  readonly direction: -1 | 1;
  /** Lightness change per attempt. */
  readonly stepSize?: number;
}

export interface SolveResult {
  /** The settled colour: the start colour when it already passes, else the first lightness that does. */
  readonly color: Oklch;
  /** Lowest ratio measured for `color`. */
  readonly ratio: number;
  /** True when lightness had to change. */
  readonly moved: boolean;
  /** False when no lightness in that direction reaches the ratio; `color` is then the best found. */
  readonly reached: boolean;
}

export function solveLightness(options: SolveOptions): SolveResult {
  const stepSize = options.stepSize ?? 0.0025;
  const start = settle(options.color);
  let best = start;
  let bestRatio = minContrast(start, options.against);
  if (bestRatio >= options.ratio) return { color: start, ratio: bestRatio, moved: false, reached: true };

  for (let i = 1; ; i += 1) {
    const l = options.color.l + options.direction * stepSize * i;
    if (l < 0 || l > 1) break;
    const candidate = settle({ ...options.color, l });
    const ratio = minContrast(candidate, options.against);
    if (ratio > bestRatio) {
      best = candidate;
      bestRatio = ratio;
    }
    if (ratio >= options.ratio) return { color: candidate, ratio, moved: true, reached: true };
  }
  return { color: best, ratio: bestRatio, moved: best !== start, reached: false };
}

/**
 * Tries both directions and returns the passing colour closest in lightness to the start, or
 * undefined when neither direction can reach the ratio.
 */
export function nearestPassingLightness(
  color: Oklch,
  against: readonly Rgb[],
  ratio: number,
): SolveResult | undefined {
  const results = ([-1, 1] as const)
    .map((direction) => solveLightness({ color, against, ratio, direction }))
    .filter((result) => result.reached);
  if (results.length === 0) return undefined;
  results.sort((a, b) => Math.abs(a.color.l - color.l) - Math.abs(b.color.l - color.l));
  return results[0];
}
