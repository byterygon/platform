// @ts-check
/**
 * The token catalogue the rules suggest from: every token of a theme as the engine generates it
 * (`generateTokens`), with its Tailwind utility names and its resolved values. Nothing here lists
 * tokens by hand; families are read from the token paths (`space.inset.*`, `color.bg.*`).
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import { colorToOklch, generateTokens, resolve } from "@byterygon/design-tokens";

const require = createRequire(import.meta.url);

/** @typedef {import("@byterygon/design-tokens").Oklch} Oklch */
/** @typedef {import("@byterygon/design-tokens").TokenSet} TokenSet */
/** @typedef {import("@byterygon/design-tokens").Token} Token */

/**
 * @typedef {object} CatalogToken
 * @property {string} path            dot path, `space.inset.sm`
 * @property {string} cssVar          `--by-space-inset-sm`
 * @property {string} type            DTCG type
 * @property {string} tier            primitive | semantic | component
 * @property {string} description     when to use it and when not to
 * @property {string | undefined} namespace  Tailwind theme namespace (`color`, `spacing`, `radius`, `text`, ...)
 * @property {string | undefined} utility    the utility suffix to suggest (`surface`, `inset-sm`, `accent-solid`)
 * @property {Record<string, string>} css    resolved CSS value per mode key (`light`, `dark`, `comfortable`, `compact`, `base`)
 * @property {Oklch | undefined} color       resolved colour in light mode (colour tokens)
 * @property {number | undefined} px         resolved length in px, comfortable (dimension tokens)
 * @property {number | undefined} compactPx  resolved length in px, compact
 * @property {number | undefined} ms         resolved duration in ms
 * @property {number | undefined} number     resolved number (z-index, opacity)
 */

/**
 * @typedef {object} Catalog
 * @property {string} theme
 * @property {Map<string, CatalogToken>} tokens           by path
 * @property {Map<string, CatalogToken>} byCssVar
 * @property {Map<string, CatalogToken>} byUtility        `color:surface`, `spacing:inset-sm`, ... (main names and aliases)
 * @property {Record<"bg" | "fg" | "border", CatalogToken[]>} colorRoles
 * @property {number} spacingUnit                         px of one step of `--spacing` (`p-1`)
 */

/** @type {Map<string, Catalog>} */
const cache = new Map();

/** The theme file of a built-in preset, or a path. */
function readTheme(/** @type {string} */ theme) {
  if (/^[a-z][a-z0-9-]*$/.test(theme)) {
    return JSON.parse(readFileSync(require.resolve(`@byterygon/design-tokens/themes/${theme}.theme.json`), "utf8"));
  }
  return JSON.parse(readFileSync(resolvePath(theme), "utf8"));
}

/** Length in px of a resolved dimension value. */
function toPx(/** @type {unknown} */ value) {
  if (!value || typeof value !== "object" || !("value" in value) || !("unit" in value)) return undefined;
  const { value: n, unit } = /** @type {{ value: number; unit: string }} */ (value);
  return unit === "rem" ? n * 16 : unit === "px" ? n : undefined;
}

/**
 * Loads (once per theme) the catalogue of a preset name or a theme file. The default is the
 * `default` preset, which is what `tokens.css` and `tailwind-theme.css` of a registry install hold.
 * @param {string} [theme]
 * @returns {Catalog}
 */
export function loadCatalog(theme = "default") {
  const cached = cache.get(theme);
  if (cached) return cached;
  const { set } = generateTokens(readTheme(theme));
  const catalog = buildCatalog(set);
  cache.set(theme, catalog);
  return catalog;
}

/** @param {TokenSet} set @returns {Catalog} */
export function buildCatalog(set) {
  const axisDefaults = Object.fromEntries(set.axes.map((axis) => [axis.name, axis.default]));
  const themeAxis = set.axes.find((axis) => axis.name === "theme");
  const densityAxis = set.axes.find((axis) => axis.name === "density");
  const light = { ...axisDefaults, ...(themeAxis ? { theme: themeAxis.modes.includes("light") ? "light" : themeAxis.default } : {}) };
  const comfortable = { ...light, ...(densityAxis ? { density: densityAxis.modes.includes("comfortable") ? "comfortable" : densityAxis.default } : {}) };
  const compact = densityAxis?.modes.includes("compact") ? { ...comfortable, density: "compact" } : comfortable;
  const dark = themeAxis?.modes.includes("dark") ? { ...comfortable, theme: "dark" } : comfortable;

  /** @type {Map<string, CatalogToken>} */
  const tokens = new Map();
  /** @type {Map<string, CatalogToken>} */
  const byCssVar = new Map();
  /** @type {Map<string, CatalogToken>} */
  const byUtility = new Map();
  let spacingUnit = 4;

  for (const token of set.tokens.values()) {
    const value = (/** @type {Record<string, string>} */ context) => {
      const resolution = resolve(set, token.path, context);
      return resolution.ok ? resolution.value : undefined;
    };
    const main = value(comfortable);
    /** @type {Record<string, string>} */
    const css = {};
    const describe = (/** @type {unknown} */ raw) => (raw === undefined ? "" : cssText(token.type, raw));
    if (token.axis === "theme") Object.assign(css, { light: describe(main), dark: describe(value(dark)) });
    else if (token.axis === "density") Object.assign(css, { comfortable: describe(main), compact: describe(value(compact)) });
    else css["base"] = describe(main);

    const names = [token.tailwindAliases?.[0], token.tailwind].filter((name) => typeof name === "string");
    const preferred = names[0];
    const match = preferred ? /^--([a-z]+)(?:-(.+))?$/.exec(preferred) : null;
    /** @type {CatalogToken} */
    const entry = {
      path: token.path,
      cssVar: `--by-${token.path.replace(/\./g, "-")}`,
      type: token.type,
      tier: token.tier,
      description: token.description,
      namespace: match?.[1],
      utility: match?.[2],
      css,
      color: token.type === "color" && main && typeof main === "object" ? colorToOklch(/** @type {any} */ (main)) : undefined,
      px: token.type === "dimension" ? toPx(main) : undefined,
      compactPx: token.type === "dimension" ? toPx(value(compact)) : undefined,
      ms: token.type === "duration" && main && typeof main === "object" ? durationMs(main) : undefined,
      number: token.type === "number" && typeof main === "number" ? main : undefined,
    };
    tokens.set(token.path, entry);
    byCssVar.set(entry.cssVar, entry);
    for (const name of [token.tailwind, ...(token.tailwindAliases ?? [])]) {
      const m = name ? /^--([a-z]+)(?:-(.+))?$/.exec(name) : null;
      if (!m) continue;
      if (m[1] === "spacing" && m[2] === undefined) spacingUnit = entry.px ?? spacingUnit;
      if (m[2] !== undefined) byUtility.set(`${m[1]}:${m[2]}`, entry);
    }
  }

  return { theme: set.name, tokens, byCssVar, byUtility, colorRoles: colorRoles(tokens), spacingUnit };
}

function durationMs(/** @type {any} */ value) {
  return value.unit === "s" ? value.value * 1000 : value.value;
}

function cssText(/** @type {string} */ type, /** @type {any} */ value) {
  if (type === "color") return value.alpha === undefined ? value.hex : `${value.hex} at ${Math.round(value.alpha * 100)}%`;
  if (type === "dimension" || type === "duration") return `${value.value}${value.unit}`;
  if (typeof value === "number" || typeof value === "string") return String(value);
  return "";
}

/**
 * The colour roles a component may use, grouped by what they paint, read from the paths:
 * backgrounds (`color.bg.*`, `*.bg`, `*.subtle-bg`, `*.solid`, `color.interactive.*`), text and
 * icons (`color.fg.*`, `*.fg`, `*.solid-fg`, `*.subtle-fg`) and edges (`color.border.*`,
 * `*.border`, `color.ring*`). Only `color.*` roles with a Tailwind name: the domain roles
 * (syntax, grid, chart, diff, editor, data) are for their own components.
 * @param {Map<string, CatalogToken>} tokens
 */
function colorRoles(tokens) {
  /** @type {Record<"bg" | "fg" | "border", CatalogToken[]>} */
  const out = { bg: [], fg: [], border: [] };
  for (const token of tokens.values()) {
    if (token.type !== "color" || token.tier === "primitive" || !token.utility || !token.color) continue;
    const segments = token.path.split(".");
    if (segments[0] !== "color") continue;
    const last = segments.at(-1) ?? "";
    if (segments[1] === "border" || segments[1]?.startsWith("ring") || last === "border") out.border.push(token);
    else if (segments[1] === "fg" || /(^|-)fg$/.test(last)) out.fg.push(token);
    else if (segments[1] === "bg" || segments[1] === "interactive" || /(^|-)bg(-|$)/.test(last) || /^solid(-hover)?$/.test(last)) out.bg.push(token);
  }
  return out;
}

/**
 * The Tailwind palette of the installed `tailwindcss` (`--color-blue-500` and so on), resolved
 * from the project being linted, else from this package. Empty when Tailwind is not installed.
 * @returns {Map<string, Oklch>}
 */
export function tailwindPalette(/** @type {string} */ cwd = process.cwd()) {
  const key = `palette:${cwd}`;
  const hit = paletteCache.get(key);
  if (hit) return hit;
  /** @type {Map<string, Oklch>} */
  const palette = new Map();
  for (const from of [resolvePath(cwd, "package.json"), import.meta.url]) {
    try {
      const file = createRequire(from).resolve("tailwindcss/theme.css");
      for (const m of readFileSync(file, "utf8").matchAll(/--color-([a-z]+(?:-\d+)?):\s*([^;]+);/g)) {
        const color = parseThemeColor(m[2] ?? "");
        if (color) palette.set(m[1] ?? "", color);
      }
      break;
    } catch {
      // not installed here; try the next place
    }
  }
  paletteCache.set(key, palette);
  return palette;
}
/** @type {Map<string, Map<string, Oklch>>} */
const paletteCache = new Map();

/** `oklch(62.3% 0.214 259.815)` or `#fff`. */
function parseThemeColor(/** @type {string} */ text) {
  const value = text.trim();
  if (value === "#000") return { l: 0, c: 0, h: 0 };
  if (value === "#fff") return { l: 1, c: 0, h: 0 };
  const m = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  return m ? { l: Number(m[1]) / 100, c: Number(m[2]), h: Number(m[3]) } : undefined;
}

/** Up to `limit` names close to `name` by edit distance (or containing it). */
export function closest(/** @type {string} */ name, /** @type {Iterable<string>} */ candidates, limit = 3) {
  /** @type {{ candidate: string; score: number }[]} */
  const scored = [];
  for (const candidate of candidates) {
    const distance = editDistance(name, candidate);
    const shared = candidate.includes(name) || name.includes(candidate);
    if (shared || distance <= Math.max(2, Math.floor(name.length / 3))) scored.push({ candidate, score: shared ? Math.min(distance, 1) : distance });
  }
  scored.sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate));
  return scored.slice(0, limit).map((entry) => entry.candidate);
}

function editDistance(/** @type {string} */ a, /** @type {string} */ b) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
