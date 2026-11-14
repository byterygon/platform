/**
 * Contrast measurement: WCAG 2.x contrast ratio (the build's pass/fail rule) and APCA lightness
 * contrast (reported, and enforced only when a theme asks for it), plus the alpha compositing
 * both need for translucent colours.
 */
import { type Rgb, srgbToLinear } from "./convert.js";

/** WCAG 2.x relative luminance of an opaque sRGB colour. */
export function relativeLuminance(color: Rgb): number {
  return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);
}

/** WCAG 2.x contrast ratio, 1..21. Order does not matter. Both colours must be opaque. */
export function wcagContrast(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * APCA lightness contrast Lc (APCA-W3 0.0.98G-4g constants), signed: positive for dark text on a
 * light background, negative for light text on a dark one. Order matters. Both must be opaque.
 */
export function apcaContrast(text: Rgb, background: Rgb): number {
  const luminance = (c: Rgb) => {
    const lin = (v: number) => Math.max(0, v) ** 2.4;
    const y = 0.2126729 * lin(c.r) + 0.7151522 * lin(c.g) + 0.072175 * lin(c.b);
    return y > 0.022 ? y : y + (0.022 - y) ** 1.414;
  };
  const yText = luminance(text);
  const yBackground = luminance(background);
  if (Math.abs(yBackground - yText) < 0.0005) return 0;
  if (yBackground > yText) {
    const sapc = (yBackground ** 0.56 - yText ** 0.57) * 1.14;
    return sapc < 0.1 ? 0 : (sapc - 0.027) * 100;
  }
  const sapc = (yBackground ** 0.65 - yText ** 0.62) * 1.14;
  return sapc > -0.1 ? 0 : (sapc + 0.027) * 100;
}

/**
 * Source-over compositing in gamma-encoded sRGB, which is how browsers paint a translucent
 * background over an opaque one. The result is opaque.
 */
export function compositeOver(top: Rgb, bottom: Rgb): Rgb {
  const alpha = top.alpha ?? 1;
  if (alpha >= 1) return { r: top.r, g: top.g, b: top.b };
  const mix = (t: number, b: number) => t * alpha + b * (1 - alpha);
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b) };
}

/**
 * The most transparent colour that, painted over `backdrop`, shows as `target` (the Radix
 * "alpha variant" of a ramp step). The overlay either lightens or darkens, decided by luminance;
 * a channel that would have to move the other way is clamped, so a tinted target over a neutral
 * backdrop is reproduced closely rather than exactly, in exchange for a low, monotonic alpha.
 * Alpha is rounded up to three decimals; the returned channels are clamped to 0..1.
 */
export function alphaOver(target: Rgb, backdrop: Rgb): Rgb {
  const lighten = relativeLuminance(target) >= relativeLuminance(backdrop);
  const needed = (t: number, b: number) => {
    if (lighten) return t > b && b < 1 ? (t - b) / (1 - b) : 0;
    return t < b && b > 0 ? (b - t) / b : 0;
  };
  const raw = Math.max(needed(target.r, backdrop.r), needed(target.g, backdrop.g), needed(target.b, backdrop.b));
  const alpha = Math.min(1, Math.ceil(raw * 1000 - 1e-9) / 1000);
  if (alpha <= 0) return { r: target.r, g: target.g, b: target.b, alpha: 0 };
  const channel = (t: number, b: number) => Math.min(1, Math.max(0, b + (t - b) / alpha));
  return {
    r: channel(target.r, backdrop.r),
    g: channel(target.g, backdrop.g),
    b: channel(target.b, backdrop.b),
    alpha,
  };
}
