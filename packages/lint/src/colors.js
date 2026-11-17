// @ts-check
/** Raw colours in CSS text, and the colour role nearest to one (OKLab distance, light mode). */
import { hexToRgb, parseColor, srgbToOklch } from "@byterygon/design-tokens";

/** @typedef {import("@byterygon/design-tokens").Oklch} Oklch */
/** @typedef {import("./catalog.js").CatalogToken} CatalogToken */

// CSS Color 4 named colours (a CSS fact, not a token list).
const NAMED_TEXT =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4 black 000000 " +
  "blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 " +
  "chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b " +
  "darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b " +
  "darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f " +
  "darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 deeppink ff1493 " +
  "deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 " +
  "fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f " +
  "grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa " +
  "lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff " +
  "lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a " +
  "lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 " +
  "lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd " +
  "mediumorchid ba55d3 mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
  "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 " +
  "navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 " +
  "palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 " +
  "peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f " +
  "royalblue 4169e1 saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d " +
  "silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f " +
  "steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 " +
  "white ffffff whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";

/** @type {Map<string, string>} name -> #rrggbb */
export const NAMED_COLORS = new Map();
{
  const parts = NAMED_TEXT.split(" ");
  for (let i = 0; i < parts.length; i += 2) NAMED_COLORS.set(parts[i] ?? "", `#${parts[i + 1]}`);
}

/** Matches a colour literal: hex, or a colour function (rgb, hsl, hwb, lab, lch, oklab, oklch, color). */
export const RAW_COLOR_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([^()]*\)/gi;

/** The raw colour literals in a CSS value (hex and colour functions; named colours with `named`). */
export function findRawColors(/** @type {string} */ value, named = false) {
  /** @type {{ text: string; index: number }[]} */
  const found = [];
  for (const m of value.matchAll(RAW_COLOR_PATTERN)) found.push({ text: m[0], index: m.index ?? 0 });
  if (named) {
    for (const m of value.matchAll(/(?<![\w$#.(-])[a-z]+(?![\w(-])/gi)) {
      if (NAMED_COLORS.has(m[0].toLowerCase())) found.push({ text: m[0], index: m.index ?? 0 });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/**
 * Parses a CSS colour into OKLCH: hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`, `oklab()`
 * and named colours. Undefined for anything else (`lab()`, `color()`, `var()`).
 * @returns {Oklch | undefined}
 */
export function parseCssColor(/** @type {string} */ text) {
  const input = text.trim().toLowerCase();
  const named = NAMED_COLORS.get(input);
  if (named) return parseColor(named);
  if (input.startsWith("#")) {
    const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(input)?.[1];
    if (!hex) return undefined;
    const full = hex.length <= 4 ? [...hex].map((ch) => ch + ch).join("") : hex;
    const rgb = hexToRgb(`#${full.slice(0, 6)}`);
    if (!rgb) return undefined;
    const color = srgbToOklch(rgb);
    const alpha = full.length === 8 ? parseInt(full.slice(6), 16) / 255 : undefined;
    return alpha === undefined || alpha >= 1 ? color : { ...color, alpha };
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(input);
  if (!fn) return undefined;
  const args = (fn[2] ?? "").replace(/,/g, " ").replace(/\//g, " / ").trim().split(/\s+/);
  const slash = args.indexOf("/");
  const channels = slash >= 0 ? args.slice(0, slash) : args.slice(0, 3);
  const alphaText = slash >= 0 ? args[slash + 1] : args[3];
  const alpha = alphaText === undefined ? undefined : number(alphaText, 1);
  const withAlpha = (/** @type {Oklch | undefined} */ color) => (color && alpha !== undefined && alpha < 1 ? { ...color, alpha } : color);
  switch (fn[1]) {
    case "rgb":
    case "rgba": {
      const [r, g, b] = channels.map((c) => number(c, 255));
      if (r === undefined || g === undefined || b === undefined) return undefined;
      return withAlpha(srgbToOklch({ r: r / 255, g: g / 255, b: b / 255 }));
    }
    case "hsl":
    case "hsla": {
      const h = number((channels[0] ?? "").replace(/deg$/, ""), 1);
      const s = number(channels[1] ?? "", 1);
      const l = number(channels[2] ?? "", 1);
      if (h === undefined || s === undefined || l === undefined) return undefined;
      return withAlpha(srgbToOklch(hslToRgb(h, s > 1 ? s / 100 : s, l > 1 ? l / 100 : l)));
    }
    case "oklch":
      return parseColor(input.replace(/,/g, " "));
    case "oklab": {
      const [l, a, b] = channels.map((c, i) => number(c, i === 0 ? 1 : 0.4));
      if (l === undefined || a === undefined || b === undefined) return undefined;
      return withAlpha({ l, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 });
    }
    default:
      return undefined;
  }
}

/** A channel: number, or percentage of `percentOf`. */
function number(/** @type {string} */ raw, /** @type {number} */ percentOf) {
  if (raw === "none") return 0;
  const percent = raw.endsWith("%");
  const body = percent ? raw.slice(0, -1) : raw;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(body)) return undefined;
  const value = Number(body);
  return percent ? (value / 100) * percentOf : value;
}

function hslToRgb(/** @type {number} */ h, /** @type {number} */ s, /** @type {number} */ l) {
  const k = (/** @type {number} */ n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (/** @type {number} */ n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

/** Distance in OKLab, plus a penalty for a different alpha. */
export function colorDistance(/** @type {Oklch} */ a, /** @type {Oklch} */ b) {
  const lab = (/** @type {Oklch} */ c) => [c.l, c.c * Math.cos((c.h * Math.PI) / 180), c.c * Math.sin((c.h * Math.PI) / 180)];
  const [l1 = 0, a1 = 0, b1 = 0] = lab(a);
  const [l2 = 0, a2 = 0, b2 = 0] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) + Math.abs((a.alpha ?? 1) - (b.alpha ?? 1)) * 0.5;
}

/** The roles of `candidates` nearest to `color` (light mode values), closest first. */
export function nearestColors(/** @type {Oklch} */ color, /** @type {readonly CatalogToken[]} */ candidates, limit = 2) {
  return candidates
    .filter((token) => token.color)
    .map((token) => ({ token, distance: colorDistance(color, /** @type {Oklch} */ (token.color)) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.token);
}
