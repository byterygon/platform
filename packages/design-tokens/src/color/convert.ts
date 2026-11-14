/**
 * Colour space conversions: sRGB <-> linear sRGB <-> OKLab <-> OKLCH (Björn Ottosson's OKLab).
 *
 * Pure arithmetic, no DOM and no Node APIs, so it runs in the browser (Theme Studio) and in the
 * build alike. Every channel is a plain number; nothing here rounds, the callers decide precision.
 */

/** A colour in OKLCH: lightness 0..1, chroma 0..~0.4, hue in degrees 0..360, alpha 0..1. */
export interface Oklch {
  readonly l: number;
  readonly c: number;
  readonly h: number;
  readonly alpha?: number;
}

/** Gamma-encoded sRGB, channels 0..1 (values outside that range are out of gamut). */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha?: number;
}

export function srgbToLinear(channel: number): number {
  const sign = channel < 0 ? -1 : 1;
  const abs = Math.abs(channel);
  return abs <= 0.04045 ? channel / 12.92 : sign * ((abs + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(channel: number): number {
  const sign = channel < 0 ? -1 : 1;
  const abs = Math.abs(channel);
  return abs <= 0.0031308 ? channel * 12.92 : sign * (1.055 * abs ** (1 / 2.4) - 0.055);
}

/** OKLCH to gamma-encoded sRGB. The result may lie outside 0..1 when the colour is out of gamut. */
export function oklchToSrgb(color: Oklch): Rgb {
  const hue = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hue);
  const b = color.c * Math.sin(hue);

  const l_ = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = color.l - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rgb: Rgb = {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
  return color.alpha === undefined ? rgb : { ...rgb, alpha: color.alpha };
}

/** Gamma-encoded sRGB to OKLCH. Achromatic colours get hue 0. */
export function srgbToOklch(color: Rgb): Oklch {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const lightness = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bb = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  const chroma = Math.sqrt(a * a + bb * bb);
  let hue = chroma < 1e-5 ? 0 : (Math.atan2(bb, a) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  const out: Oklch = { l: lightness, c: chroma < 1e-5 ? 0 : chroma, h: hue };
  return color.alpha === undefined ? out : { ...out, alpha: color.alpha };
}

/** Clamps every channel to 0..1 (used after gamut mapping, to remove float noise). */
export function clampRgb(color: Rgb): Rgb {
  const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const out: Rgb = { r: clamp(color.r), g: clamp(color.g), b: clamp(color.b) };
  return color.alpha === undefined ? out : { ...out, alpha: color.alpha };
}

/** Rounds to the 8-bit value a display actually shows; contrast is measured on these. */
export function quantizeRgb(color: Rgb): Rgb {
  const q = (v: number) => Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255) / 255;
  const out: Rgb = { r: q(color.r), g: q(color.g), b: q(color.b) };
  return color.alpha === undefined ? out : { ...out, alpha: color.alpha };
}

/** `#rrggbb` (alpha is not included; DTCG keeps alpha in its own field). */
export function rgbToHex(color: Rgb): string {
  const hex = (v: number) =>
    Math.round((v < 0 ? 0 : v > 1 ? 1 : v) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. Returns undefined when it is not a hex colour. */
export function hexToRgb(hex: string): Rgb | undefined {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!match) return undefined;
  let digits = match[1]!;
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
  const channel = (i: number) => parseInt(digits.slice(i, i + 2), 16) / 255;
  const rgb: Rgb = { r: channel(0), g: channel(2), b: channel(4) };
  return digits.length === 8 ? { ...rgb, alpha: channel(6) } : rgb;
}
