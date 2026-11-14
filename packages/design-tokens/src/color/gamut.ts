/**
 * sRGB gamut mapping in OKLCH: keep lightness and hue, reduce chroma until the colour fits.
 *
 * This is the chroma-reduction core of the CSS Color 4 gamut mapping algorithm, without its
 * "clip when the difference is not noticeable" shortcut: the result is always inside sRGB, so the
 * hex fallback and the Figma value are the same colour as the `oklch()` value. Hue and lightness
 * never move, which is what keeps a ramp step doing its job after mapping.
 */
import { type Oklch, type Rgb, clampRgb, oklchToSrgb } from "./convert.js";

const EPSILON = 1e-5;

export function inSrgbGamut(color: Oklch, epsilon: number = EPSILON): boolean {
  const { r, g, b } = oklchToSrgb(color);
  const ok = (v: number) => v >= -epsilon && v <= 1 + epsilon;
  return ok(r) && ok(g) && ok(b);
}

/** Largest chroma that is inside sRGB at this lightness and hue (0 at black and white). */
export function maxChroma(l: number, h: number, upper: number = 0.5): number {
  if (l <= 0 || l >= 1) return 0;
  if (inSrgbGamut({ l, c: upper, h })) return upper;
  let low = 0;
  let high = upper;
  for (let i = 0; i < 30; i += 1) {
    const mid = (low + high) / 2;
    if (inSrgbGamut({ l, c: mid, h })) low = mid;
    else high = mid;
  }
  return low;
}

export interface GamutMapped {
  /** The colour inside sRGB (same lightness and hue, chroma reduced when needed). */
  readonly color: Oklch;
  /** True when chroma had to be reduced. */
  readonly mapped: boolean;
  /** The chroma that was asked for. */
  readonly requestedChroma: number;
}

export function gamutMapSrgb(color: Oklch): GamutMapped {
  const l = Math.min(1, Math.max(0, color.l));
  const requestedChroma = Math.max(0, color.c);
  const withAlpha = (c: Oklch): Oklch => (color.alpha === undefined ? c : { ...c, alpha: color.alpha });
  if (l <= 0 || l >= 1) {
    return { color: withAlpha({ l, c: 0, h: 0 }), mapped: requestedChroma > EPSILON, requestedChroma };
  }
  const candidate: Oklch = { l, c: requestedChroma, h: color.h };
  if (inSrgbGamut(candidate)) return { color: withAlpha(candidate), mapped: false, requestedChroma };
  return {
    color: withAlpha({ l, c: maxChroma(l, color.h, requestedChroma), h: color.h }),
    mapped: true,
    requestedChroma,
  };
}

/** OKLCH to displayable sRGB: gamut-mapped, then clamped to remove float noise. */
export function toDisplayRgb(color: Oklch): Rgb {
  return clampRgb(oklchToSrgb(gamutMapSrgb(color).color));
}
