/**
 * Text forms of a colour: the precision tokens are stored at, `oklch()` strings, and parsing of
 * the two notations a theme file may use for an override (`oklch(...)` and hex).
 */
import { type Oklch, type Rgb, hexToRgb, quantizeRgb, rgbToHex, srgbToOklch } from "./convert.js";
import { toDisplayRgb } from "./gamut.js";

const round = (value: number, digits: number) => {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * The precision tokens are stored at: lightness and chroma to four decimals, hue to two, alpha to
 * three. Colours with no visible chroma get chroma 0 and hue 0 so equal greys print identically.
 */
export function roundOklch(color: Oklch): Oklch {
  const c = round(color.c, 4);
  const achromatic = c < 0.0002;
  const out: Oklch = {
    l: round(color.l, 4),
    c: achromatic ? 0 : c,
    h: achromatic ? 0 : round(((color.h % 360) + 360) % 360, 2) % 360,
  };
  return color.alpha === undefined || color.alpha >= 1 ? out : { ...out, alpha: round(color.alpha, 3) };
}

/** `oklch(0.55 0.15 230)` or `oklch(0.55 0.15 230 / 0.5)`, at stored precision. */
export function formatOklch(color: Oklch): string {
  const c = roundOklch(color);
  const alpha = c.alpha === undefined ? "" : ` / ${c.alpha}`;
  return `oklch(${c.l} ${c.c} ${c.h}${alpha})`;
}

/** The 8-bit sRGB colour a display shows for this OKLCH value (alpha carried over). */
export function oklchToDisplayRgb(color: Oklch): Rgb {
  const rgb = quantizeRgb(toDisplayRgb(color));
  return color.alpha === undefined ? rgb : { ...rgb, alpha: color.alpha };
}

/** `#rrggbb` for an OKLCH colour (gamut-mapped; alpha is not part of the hex). */
export function oklchToHex(color: Oklch): string {
  return rgbToHex(toDisplayRgb(color));
}

/**
 * Parses `oklch(L C H)`, `oklch(L C H / A)` (L and A as numbers or percentages, H in degrees or
 * `none`) and hex colours. Returns undefined for anything else.
 */
export function parseColor(text: string): Oklch | undefined {
  const input = text.trim().toLowerCase();
  const rgb = hexToRgb(input);
  if (rgb) return srgbToOklch(rgb);

  const match = /^oklch\(\s*([^\s/]+)\s+([^\s/]+)\s+([^\s/]+)\s*(?:\/\s*([^\s/]+)\s*)?\)$/.exec(input);
  if (!match) return undefined;
  const number = (raw: string, percentOf: number): number | undefined => {
    if (raw === "none") return 0;
    const percent = raw.endsWith("%");
    const body = percent ? raw.slice(0, -1) : raw;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(body)) return undefined;
    const value = Number(body);
    return percent ? (value / 100) * percentOf : value;
  };
  const l = number(match[1]!, 1);
  const c = number(match[2]!, 0.4);
  const hueRaw = match[3]!.endsWith("deg") ? match[3]!.slice(0, -3) : match[3]!;
  const h = hueRaw.endsWith("%") ? undefined : number(hueRaw, 1);
  const alpha = match[4] === undefined ? undefined : number(match[4], 1);
  if (l === undefined || c === undefined || h === undefined) return undefined;
  if (match[4] !== undefined && alpha === undefined) return undefined;
  if (l < 0 || l > 1 || c < 0 || (alpha !== undefined && (alpha < 0 || alpha > 1))) return undefined;
  const out: Oklch = { l, c, h: ((h % 360) + 360) % 360 };
  return alpha === undefined || alpha >= 1 ? out : { ...out, alpha };
}
