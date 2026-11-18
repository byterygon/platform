/**
 * Import (spec section 5, "Import"; TSK-49): a theme file (seeds plus overrides) from text a user
 * pastes. The Theme Studio and `by-tokens import` both call `importTheme`, so the same text gives
 * the same file, byte for byte (`ImportResult.text`). Pure; runs in the browser.
 *
 * Formats:
 *  - `css`: Byterygon CSS variables (`--by-*`), such as an exported tokens.css, edited or not.
 *  - `dtcg`: Byterygon DTCG JSON (tokens.dtcg.json).
 *  - `shadcn`: a stock shadcn/ui globals.css (`--background`, `--primary`, `--radius`... in
 *    `:root` and `.dark`, as oklch(), hsl(), bare HSL triplets or hex).
 *  - `theme`: a theme file itself (read through `readThemeFile`).
 *
 * The first two are exact: the seeds are inferred from the ramps (hue and chroma of step 9, the
 * solid lightness, the neutral tint), the radius, the body size and the default modes, and every
 * value that still differs from what those seeds generate becomes an override, so the imported
 * theme renders the same tokens.css. shadcn's variables are fewer and coarser: they give the seeds
 * (brand from --primary, neutral from --muted-foreground, red from --destructive, radius from
 * --radius) and each colour overrides the ramp step its Byterygon role resolves to (the alias
 * block's mapping, read backwards). What cannot be placed is reported, never guessed.
 */
import { DEFAULT_CATALOG } from "./catalog/default.js";
import { DEFAULT_RECIPE, type Oklch, formatOklch, parseColor, srgbToOklch } from "./color/index.js";
import { generateTokens } from "./generate.js";
import { DEFAULT_SEEDS } from "./seeds.js";
import { type Diagnostic, type ModeContext, type TokenSet, type TokenType, type TokenValue, EXTENSION, SCHEMA_VERSION, isAlias } from "./model.js";
import { resolve, valueIn } from "./resolve.js";
import { readThemeFile } from "./state.js";
import { isPlainObject, round, stableJson } from "./util.js";
import { cssValue, cssVarName, parseLiteral } from "./values.js";

export const IMPORT_FORMATS = ["css", "dtcg", "shadcn", "theme"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_FORMAT_LABELS: Readonly<Record<ImportFormat, string>> = {
  css: "Byterygon CSS variables (--by-*)",
  dtcg: "Byterygon DTCG JSON",
  shadcn: "shadcn/ui globals.css",
  theme: "Byterygon theme file",
};

export interface ImportOptions {
  /** The theme name (lower-case letters, digits, dashes). Default: the source's, else "imported". */
  readonly name?: string;
  /** Default: detected from the text. */
  readonly format?: ImportFormat;
}

export interface ImportResult {
  /** False when the text could not be read as any format; `theme` is then absent. */
  readonly ok: boolean;
  readonly format?: ImportFormat;
  readonly theme?: Record<string, unknown>;
  /** The theme file as written (`by-tokens import` prints exactly this). */
  readonly text?: string;
  /** How many variables or tokens of the source were read into the theme. */
  readonly mapped: number;
  /** What could not be read or placed (warnings), or why nothing could (an error). */
  readonly diagnostics: readonly Diagnostic[];
}

type Json = Record<string, unknown>;

/** One value of the source: for every mode (`mode` absent) or for one mode of one axis. */
interface Entry {
  readonly mode?: readonly [axis: string, mode: string];
  /** CSS text (css, shadcn) or a DTCG value or alias (dtcg). */
  readonly raw: unknown;
}

const failed = (message: string, fix: string): ImportResult => ({ ok: false, mapped: 0, diagnostics: [{ severity: "error", rule: "import-unreadable", message, fix: { summary: fix } }] });
const note = (rule: string, message: string, token?: string): Diagnostic => ({ severity: "warning", rule, message, ...(token ? { token } : {}) });

// ---------------------------------------------------------------------------------------------
// Reading CSS

interface CssBlock {
  readonly selectors: readonly string[];
  readonly declarations: readonly (readonly [name: string, value: string])[];
}

/** The innermost rule blocks of a stylesheet (at-rule blocks such as `@theme` are skipped). */
function cssBlocks(text: string): CssBlock[] {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: CssBlock[] = [];
  for (const match of clean.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = match[1]!.trim();
    if (selector === "" || selector.startsWith("@")) continue;
    const declarations = match[2]!
      .split(";")
      .map((part) => {
        const colon = part.indexOf(":");
        return colon === -1 ? undefined : ([part.slice(0, colon).trim(), part.slice(colon + 1).trim()] as const);
      })
      .filter((d): d is readonly [string, string] => d !== undefined && d[0].startsWith("--") && d[1] !== "");
    blocks.push({ selectors: selector.split(",").map((s) => s.trim()), declarations });
  }
  return blocks;
}

/** Splits at top-level commas or spaces (not inside parentheses or quotes). */
function splitTop(text: string, separator: "," | " "): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && (separator === "," ? char === "," : /\s/.test(char))) {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** A `--by-*` CSS value as a theme-file value of `type`, or undefined when it cannot be read. */
function cssToValue(type: TokenType, text: string, pathOf: (variable: string) => string | undefined): unknown {
  const reference = (t: string) => {
    const match = /^var\((--by-[a-z0-9-]+)\)$/.exec(t.trim());
    if (!match) return undefined;
    const path = pathOf(match[1]!);
    return path === undefined ? null : `{${path}}`;
  };
  const alias = reference(text);
  if (alias !== undefined) return alias ?? undefined;
  const t = text.trim();
  switch (type) {
    case "color":
      return t;
    case "dimension":
      return t === "0" ? "0px" : t;
    case "duration":
      return t === "0" ? "0ms" : t;
    case "number":
    case "fontWeight":
      return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : t;
    case "fontFamily":
      return splitTop(t, ",").map((family) => family.replace(/^["']|["']$/g, ""));
    case "cubicBezier": {
      const match = /^cubic-bezier\((.*)\)$/.exec(t);
      return match ? match[1]!.split(",").map((n) => Number(n.trim())) : undefined;
    }
    case "shadow": {
      if (t === "none") return undefined;
      const layers = [];
      for (const layer of splitTop(t, ",")) {
        const parts = splitTop(layer, " ");
        const inset = parts[0] === "inset";
        const rest = inset ? parts.slice(1) : parts;
        if (rest.length < 3 || rest.length > 5) return undefined;
        const colourText = rest[rest.length - 1]!;
        const lengths = rest.slice(0, -1).map((length) => reference(length) ?? (length === "0" ? "0px" : length));
        const colour = reference(colourText) ?? colourText;
        if (lengths.some((l) => l === null) || colour === null) return undefined;
        const [offsetX, offsetY, blur = "0px", spread = "0px"] = lengths as string[];
        layers.push({ color: colour, offsetX, offsetY, blur, spread, ...(inset ? { inset: true } : {}) });
      }
      return layers;
    }
    case "gradient":
      return undefined;
  }
}

/** Override text for a parsed value: oklch() and 12px rather than the DTCG objects. */
function readable(type: TokenType, value: TokenValue): unknown {
  if (isAlias(value)) return value;
  if (type === "color" && isPlainObject(value) && Array.isArray(value["components"])) {
    const [l, c, h] = value["components"] as [number, number, number];
    const alpha = value["alpha"] as number | undefined;
    return formatOklch({ l, c, h, ...(alpha !== undefined && alpha < 1 ? { alpha } : {}) });
  }
  if ((type === "dimension" || type === "duration") && isPlainObject(value)) return `${String(value["value"])}${String(value["unit"])}`;
  return value;
}

// ---------------------------------------------------------------------------------------------
// Exact import (css, dtcg): seeds inferred from the values, every remaining difference overridden

const comparable = (type: TokenType, value: unknown) => {
  const parsed = parseLiteral(type, value);
  return parsed.ok ? cssValue(type, parsed.value) : undefined;
};

function contextFor(set: TokenSet, mode: Entry["mode"]): ModeContext {
  const base = Object.fromEntries(set.axes.map((axis) => [axis.name, axis.default]));
  return mode ? { ...base, [mode[0]]: mode[1] } : base;
}

/** The source's value of a token in a mode: its entry for that mode, else its entry for every mode. */
function entryIn(entries: readonly Entry[], axis: string | undefined, mode: string | undefined): Entry | undefined {
  return entries.find((e) => e.mode && e.mode[0] === axis && e.mode[1] === mode) ?? entries.find((e) => !e.mode);
}

interface Source {
  readonly values: ReadonlyMap<string, readonly Entry[]>;
  /** The default mode of each axis, when the source says. */
  readonly defaults: Readonly<Record<string, string>>;
  readonly contrastLevel?: "AA" | "AAA";
  /** Reads a raw value as a theme-file value of a type. */
  readonly read: (type: TokenType, raw: unknown) => unknown;
  /** True when the raw value is written exactly as the generated one (no need to read it). */
  readonly same?: (type: TokenType, own: TokenValue, raw: unknown) => boolean;
}

/** The overrides that make `theme`'s tokens equal the source's, and the count of differences. */
function differences(theme: Json, source: Source, notes?: Diagnostic[]): { overrides: Json; count: number } {
  const { set } = generateTokens(theme);
  const overrides: Json = {};
  let count = 0;
  for (const [path, entries] of source.values) {
    const token = set.tokens.get(path);
    if (!token) continue;
    // The axes this token's source values vary by; a value for every mode otherwise.
    const axisName = entries.find((e) => e.mode)?.mode?.[0];
    const axis = set.axes.find((a) => a.name === axisName);
    const modes: (string | undefined)[] = axis ? [...axis.modes] : [undefined];
    const changed: Json = {};
    for (const mode of modes) {
      const entry = entryIn(entries, axisName, mode);
      if (!entry) continue;
      const own = valueIn(token, contextFor(set, mode && axis ? [axis.name, mode] : undefined));
      if (own !== undefined && source.same?.(token.type, own, entry.raw)) continue;
      const value = source.read(token.type, entry.raw);
      const wanted = value === undefined ? undefined : comparable(token.type, value);
      if (wanted === undefined) {
        notes?.push(note("import-value-unreadable", `${path}${mode ? ` (${mode})` : ""}: ${JSON.stringify(entry.raw)} is not a ${token.type} this version can read; the generated value is kept`, path));
        continue;
      }
      if (own !== undefined && cssValue(token.type, own) === wanted) continue;
      const parsed = parseLiteral(token.type, value);
      changed[mode ?? ""] = readable(token.type, (parsed as { value: TokenValue }).value);
    }
    const keys = Object.keys(changed);
    if (keys.length === 0) continue;
    count += keys.length;
    const values = Object.values(changed).map((v) => JSON.stringify(v));
    overrides[path] = keys.length === modes.length && new Set(values).size === 1 ? Object.values(changed)[0] : keys.includes("") ? changed[""] : changed;
  }
  return { overrides, count };
}

const round3 = (n: number) => round(n, 3);

function colourOf(source: Source, path: string): Oklch | undefined {
  const entry = entryIn(source.values.get(path) ?? [], undefined, undefined);
  if (!entry) return undefined;
  const value = source.read("color", entry.raw);
  const parsed = value === undefined || isAlias(value) ? undefined : parseLiteral("color", value);
  if (!parsed?.ok || isAlias(parsed.value)) return undefined;
  const [l, c, h] = (parsed.value as unknown as { components: [number, number, number] }).components;
  return { l, c, h };
}

/** Seeds that generate the source's ramps as closely as possible, ramp by ramp. */
function inferSeeds(source: Source, name: string): Json {
  const probe = generateTokens({ schemaVersion: SCHEMA_VERSION, name }).set;
  const ramps = new Set<string>();
  for (const token of probe.tokens.values()) if (token.ramp && token.ramp.scheme === "light") ramps.add(token.ramp.name);
  for (const path of source.values.keys()) {
    const match = /^color\.([a-z][a-z0-9]*)\.9$/.exec(path);
    if (match && !["base", "white", "black"].includes(match[1]!)) ramps.add(match[1]!);
  }
  const seeds: Json = { colors: {} };
  const dimension = (path: string) => {
    const entry = entryIn(source.values.get(path) ?? [], undefined, undefined);
    const value = entry && source.read("dimension", entry.raw);
    const parsed = value === undefined ? undefined : parseLiteral("dimension", value);
    return parsed?.ok && !isAlias(parsed.value) && (parsed.value as { unit: string }).unit === "px" ? (parsed.value as { value: number }).value : undefined;
  };
  const radius = dimension("radius.md");
  if (radius !== undefined && radius >= 0 && radius <= 32) seeds["radius"] = radius;
  const fontSize = dimension("font.size.300");
  if (fontSize !== undefined && fontSize >= 11 && fontSize <= 18) seeds["fontSize"] = fontSize;
  if (source.defaults["theme"] === "light" || source.defaults["theme"] === "dark") seeds["colorScheme"] = source.defaults["theme"];
  if (source.defaults["density"] === "comfortable" || source.defaults["density"] === "compact") seeds["density"] = source.defaults["density"];
  if (source.contrastLevel) seeds["contrast"] = { level: source.contrastLevel };

  const colors = seeds["colors"] as Json;
  const round4 = (n: number) => round(n, 4);
  /** `undefined` first (the engine default for that ramp, so a theme stays short), then explicit seeds. */
  const candidatesFor = (ramp: string): (Json | undefined)[] => {
    const light = colourOf(source, `color.${ramp}.9`);
    const dark = colourOf(source, `color.${ramp}-dark.9`);
    if (!light && !dark) return [];
    const fallback = (DEFAULT_SEEDS.colors as Readonly<Record<string, { hue?: number; chroma: number }>>)[ramp];
    const hue = (light?.c ?? 0) >= 0.005 ? round(light!.h, 1) : (dark?.c ?? 0) >= 0.005 ? round(dark!.h, 1) : (fallback?.hue ?? 0);
    // Step 9's chroma, unless sRGB could not show the seed's (a solid darkened for white text, an
    // AAA solid): then the seed read back from steps 8, 10 and 11 through the recipe's chroma
    // fractions, or the default's.
    const fromSteps = (["light", "dark"] as const).flatMap((scheme) =>
      [8, 10, 11].map((step) => {
        const c = colourOf(source, `color.${scheme === "light" ? ramp : `${ramp}-dark`}.${step}`)?.c;
        const fraction = DEFAULT_RECIPE[scheme].steps[step - 1]!.c;
        return c === undefined ? undefined : c / fraction;
      }),
    );
    const chromas = [
      ...new Set([
        ...[light?.c, dark?.c, ...fromSteps].filter((c): c is number => c !== undefined).map(round4),
        ...(fallback ? [fallback.chroma] : []),
      ]),
    ];
    const solid = light && dark ? { light: round4(light.l), dark: round4(dark.l) } : undefined;
    // The tint is the chroma of steps 1-5; step 2 shows it unless gamut or the scheme reduced it.
    const tints = ramp === "neutral" ? [...new Set([undefined, colourOf(source, "color.neutral.2")?.c, colourOf(source, "color.neutral-dark.2")?.c, ...chromas].map((c) => (c === undefined ? undefined : round4(c))))] : [undefined];
    const out: (Json | undefined)[] = fallback ? [undefined] : [];
    for (const solidChoice of [undefined, solid]) {
      for (const tint of tints) {
        for (const chroma of chromas) out.push({ hue, chroma, ...(solidChoice ? { solid: solidChoice } : {}), ...(tint !== undefined ? { tint } : {}) });
      }
    }
    return out;
  };
  const place = (ramp: string, seed: Json | undefined) => {
    if (seed === undefined) delete colors[ramp];
    else colors[ramp] = seed;
  };
  const score = () => differences({ schemaVersion: SCHEMA_VERSION, name, seeds }, source).count;
  // First guess for every ramp, then the best candidate for each ramp with the others fixed.
  const all = [...ramps].map((ramp) => [ramp, candidatesFor(ramp)] as const).filter(([, list]) => list.length > 0);
  for (const [ramp, list] of all) place(ramp, list[0]);
  // CSS does not say the contrast level, and AAA solves the ramps differently: try it.
  if (!source.contrastLevel) {
    const aa = score();
    seeds["contrast"] = { level: "AAA" };
    if (score() >= aa) delete seeds["contrast"];
  }
  for (const [ramp, list] of all) {
    place(ramp, list[0]);
    let best = { seed: list[0], score: score() };
    for (const candidate of list.slice(1)) {
      if (best.score === 0) break;
      place(ramp, candidate);
      const s = score();
      if (s < best.score) best = { seed: candidate, score: s };
    }
    place(ramp, best.seed);
  }
  if (Object.keys(colors).length === 0) delete seeds["colors"];
  return seeds;
}

function exactImport(source: Source, name: string, format: ImportFormat, description: string, unmapped: readonly string[]): ImportResult {
  const notes: Diagnostic[] = [];
  const seeds = inferSeeds(source, name);
  const base: Json = { schemaVersion: SCHEMA_VERSION, name, description, seeds };
  const { overrides } = differences(base, source, notes);
  const theme: Json = Object.keys(overrides).length > 0 ? { ...base, overrides } : base;
  if (unmapped.length > 0) {
    notes.push(note("import-unmapped", `${unmapped.length} ${unmapped.length === 1 ? "name is" : "names are"} not a Byterygon token and ${unmapped.length === 1 ? "was" : "were"} left out: ${unmapped.slice(0, 12).join(", ")}${unmapped.length > 12 ? ", ..." : ""}`));
  }
  return { ok: true, format, theme, text: stableJson(theme), mapped: source.values.size, diagnostics: notes };
}

function readByCss(text: string, name: string | undefined): ImportResult {
  const probe = generateTokens({ schemaVersion: SCHEMA_VERSION, name: "probe" }).set;
  const pathByVar = new Map([...probe.tokens.keys()].map((path) => [cssVarName(path), path]));
  const attributeAxis = new Map(probe.axes.map((axis) => [axis.attribute, axis.name]));
  const values = new Map<string, Entry[]>();
  const defaults: Record<string, string> = {};
  const unmapped = new Set<string>();
  // A theme may add ramps: their variables follow the ramp naming, and are read as ramp steps.
  const pathOf = (variable: string) => pathByVar.get(variable) ?? (/^--by-color-[a-z][a-z0-9]*(-dark)?-(a?\d{1,2}|contrast)$/.test(variable) ? variable.slice(5).replace(/-(dark)-/, "-$1.").replace(/-(a?\d{1,2}|contrast)$/, ".$1").replace(/^color-/, "color.") : undefined);
  for (const block of cssBlocks(text)) {
    let mode: Entry["mode"];
    const root = block.selectors.includes(":root");
    for (const selector of block.selectors) {
      const attribute = /^\[(data-[a-z-]+)="?([a-z-]+)"?\]$/.exec(selector);
      const axis = attribute ? attributeAxis.get(attribute[1]!) : selector === ".dark" || selector === ".light" ? "theme" : undefined;
      if (axis) mode = [axis, attribute ? attribute[2]! : selector.slice(1)];
    }
    if (mode && root) defaults[mode[0]] = mode[1];
    for (const [variable, value] of block.declarations) {
      if (!variable.startsWith("--by-")) continue;
      const path = pathOf(variable);
      if (!path) {
        unmapped.add(variable);
        continue;
      }
      values.set(path, [...(values.get(path) ?? []).filter((e) => JSON.stringify(e.mode) !== JSON.stringify(mode)), { ...(mode ? { mode } : {}), raw: value }]);
    }
  }
  if (values.size === 0) return failed("no --by-* variable could be read", "Paste the tokens.css of a Byterygon theme, or choose another format.");
  const named = name ?? /theme "([a-z0-9-]+)"/.exec(text)?.[1] ?? "imported";
  const asVar = (alias: string) => `var(${cssVarName(alias.slice(1, -1))})`;
  const source: Source = {
    values,
    defaults,
    read: (type, raw) => cssToValue(type, String(raw), (variable) => pathOf(variable)),
    same: (type, own, raw) => cssValue(type, own, asVar as never) === String(raw).trim(),
  };
  return exactImport(source, named, "css", "Imported from Byterygon CSS variables.", [...unmapped]);
}

function readDtcg(json: Json, name: string | undefined): ImportResult {
  const values = new Map<string, Entry[]>();
  const walk = (node: unknown, path: string[]) => {
    if (!isPlainObject(node)) return;
    if ("$value" in node) {
      const ext = isPlainObject(node["$extensions"]) && isPlainObject(node["$extensions"][EXTENSION]) ? (node["$extensions"][EXTENSION] as Json) : {};
      const tokenPath = path.join(".");
      if (typeof ext["axis"] === "string" && isPlainObject(ext["modes"])) {
        values.set(tokenPath, Object.entries(ext["modes"]).map(([mode, raw]) => ({ mode: [ext["axis"] as string, mode] as const, raw })));
      } else {
        values.set(tokenPath, [{ raw: ext["type"] === "gradient" && Array.isArray(ext["gradient"]) ? ext["gradient"] : node["$value"] }]);
      }
      return;
    }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith("$")) walk(child, [...path, key]);
  };
  walk(json, []);
  if (values.size === 0) return failed("the JSON has no design tokens ($value)", "Paste tokens.dtcg.json of a Byterygon theme, or a theme file.");
  const ext = isPlainObject(json["$extensions"]) && isPlainObject(json["$extensions"][EXTENSION]) ? (json["$extensions"][EXTENSION] as Json) : {};
  const defaults: Record<string, string> = {};
  if (Array.isArray(ext["axes"])) for (const axis of ext["axes"]) if (isPlainObject(axis) && typeof axis["name"] === "string" && typeof axis["default"] === "string") defaults[axis["name"]] = axis["default"];
  const level = isPlainObject(ext["contrast"]) ? ext["contrast"]["level"] : undefined;
  const probe = generateTokens({ schemaVersion: SCHEMA_VERSION, name: "probe" }).set;
  const unmapped = [...values.keys()].filter((path) => !probe.tokens.has(path) && !/^color\.[a-z][a-z0-9]*(-dark)?\.(a?\d{1,2}|contrast)$/.test(path));
  for (const path of unmapped) values.delete(path);
  const source: Source = { values, defaults, ...(level === "AA" || level === "AAA" ? { contrastLevel: level } : {}), read: (_type, raw) => raw };
  const named = name ?? (typeof ext["theme"] === "string" ? ext["theme"] : "imported");
  return exactImport(source, named, "dtcg", "Imported from Byterygon DTCG JSON.", unmapped);
}

// ---------------------------------------------------------------------------------------------
// shadcn/ui globals.css

function hslToOklch(h: number, s: number, l: number, alpha?: number): Oklch {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const colour = srgbToOklch({ r: f(0), g: f(8), b: f(4) });
  return alpha === undefined || alpha >= 1 ? colour : { ...colour, alpha };
}

/** A shadcn colour: oklch(), #hex, hsl(), or the bare `H S% L%` triplet of shadcn v3. */
export function parseShadcnColor(text: string): Oklch | undefined {
  const t = text.trim().toLowerCase();
  const direct = parseColor(t);
  if (direct) return direct;
  const match = /^(?:hsla?\()?\s*([+-]?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[/,]\s*([\d.]+%?))?\s*\)?$/.exec(t);
  if (!match) return undefined;
  const alphaText = match[4];
  const alpha = alphaText === undefined ? undefined : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  return hslToOklch(((Number(match[1]) % 360) + 360) % 360, Number(match[2]) / 100, Number(match[3]) / 100, alpha);
}

function readShadcn(text: string, name: string | undefined): ImportResult {
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  for (const block of cssBlocks(text)) {
    const isDark = block.selectors.some((s) => s === ".dark" || /^\[data-theme="?dark"?\]$/.test(s));
    const isLight = block.selectors.some((s) => s === ":root" || s === ".light" || /^\[data-theme="?light"?\]$/.test(s));
    if (!isDark && !isLight) continue;
    for (const [variable, value] of block.declarations) (isDark ? dark : light).set(variable, value);
  }
  const mapping = DEFAULT_CATALOG.shadcn;
  if (![...light.keys(), ...dark.keys()].some((variable) => variable in mapping)) {
    return failed("no shadcn/ui variable (--background, --primary, ...) was found in :root or .dark", "Paste the globals.css of a shadcn/ui project, or choose another format.");
  }
  const notes: Diagnostic[] = [];
  const colour = (map: Map<string, string>, variable: string) => {
    const raw = map.get(variable);
    return raw === undefined ? undefined : parseShadcnColor(raw);
  };
  const seedOf = (variable: string) => {
    const c = colour(light, variable) ?? colour(dark, variable);
    return c ? { hue: round(c.h, 1), chroma: round3(Math.min(c.c, 0.37)) } : undefined;
  };
  const colors: Json = {};
  for (const [ramp, variable] of [["brand", "--primary"], ["neutral", "--muted-foreground"], ["red", "--destructive"]] as const) {
    const seed: Json | undefined = seedOf(variable);
    if (!seed) continue;
    // A solid's lightness is pinned to shadcn's, so the engine gives it the text colour shadcn
    // does (dark text on stock shadcn's light dark-mode --primary) and a hover that keeps it.
    if (ramp !== "neutral") {
      const solid: Json = {};
      for (const [scheme, map] of [["light", light], ["dark", dark]] as const) {
        const c = colour(map, variable);
        if (c && (c.alpha === undefined || c.alpha >= 1)) solid[scheme] = round(c.l, 4);
      }
      if (Object.keys(solid).length > 0) seed["solid"] = solid;
    }
    colors[ramp] = seed;
  }
  const seeds: Json = { colors, colorScheme: "light", density: "comfortable" };
  const radiusText = light.get("--radius") ?? dark.get("--radius");
  const radius = radiusText === undefined ? undefined : /^([\d.]+)(rem|px)$/.exec(radiusText.trim());
  if (radius) seeds["radius"] = Math.min(32, round(Number(radius[1]) * (radius[2] === "rem" ? 16 : 1), 2));
  else if (radiusText !== undefined) notes.push(note("import-value-unreadable", `--radius: ${radiusText} is not a length in rem or px; the default radius is kept`));

  const named = name ?? "imported";
  const theme: Json = { schemaVersion: SCHEMA_VERSION, name: named, description: "Imported from a shadcn/ui globals.css.", seeds };
  const { set } = generateTokens(theme);
  const overrides: Json = {};
  const placedBy = new Map<string, string>();
  let mapped = radius ? 1 : 0;
  const unmapped: string[] = [];
  for (const [scheme, map] of [["light", light], ["dark", dark]] as const) {
    for (const [variable, raw] of map) {
      if (variable === "--radius") continue;
      const role = mapping[variable];
      if (!role) {
        if (!unmapped.includes(variable)) unmapped.push(variable);
        continue;
      }
      const value = parseShadcnColor(raw);
      if (!value) {
        notes.push(note("import-value-unreadable", `${variable} (${scheme}): ${raw} is not a colour this version can read`, role));
        continue;
      }
      const resolution = resolve(set, role, { ...contextFor(set, undefined), theme: scheme });
      const primitive = resolution.chain[resolution.chain.length - 1];
      const target = primitive === undefined ? undefined : set.tokens.get(primitive);
      if (!target?.ramp || target.ramp.alpha) {
        notes.push(note("import-approximated", `${variable} (${scheme}) maps to ${role}, which resolves to ${primitive ?? "nothing"}, not a ramp step; the theme's own colour is kept`, role));
        continue;
      }
      if (value.alpha !== undefined && value.alpha < 1) {
        notes.push(note("import-approximated", `${variable} (${scheme}) is translucent and ${primitive} is an opaque ramp step; the theme's own colour is kept`, role));
        continue;
      }
      const literal = formatOklch(value);
      const earlier = placedBy.get(primitive!);
      if (earlier !== undefined && overrides[primitive!] !== literal) {
        notes.push(note("import-approximated", `${variable} (${scheme}) and ${earlier} both land on ${primitive}; ${earlier}'s colour is kept`, role));
        continue;
      }
      overrides[primitive!] = literal;
      placedBy.set(primitive!, `${variable} (${scheme})`);
      mapped += 1;
    }
  }
  if (unmapped.length > 0) {
    notes.push(note("import-unmapped", `${unmapped.length} ${unmapped.length === 1 ? "variable has" : "variables have"} no Byterygon role and ${unmapped.length === 1 ? "was" : "were"} left out: ${unmapped.slice(0, 12).join(", ")}${unmapped.length > 12 ? ", ..." : ""}`));
  }
  const out: Json = Object.keys(overrides).length > 0 ? { ...theme, overrides } : theme;
  return { ok: true, format: "shadcn", theme: out, text: stableJson(out), mapped, diagnostics: notes };
}

// ---------------------------------------------------------------------------------------------

/** The format of a text: JSON is a theme file or DTCG, CSS with --by-* is css, else shadcn. */
export function detectImportFormat(text: string): ImportFormat | undefined {
  const t = text.trim();
  if (t.startsWith("{")) {
    try {
      const json = JSON.parse(t) as unknown;
      return isPlainObject(json) && "schemaVersion" in json && ("seeds" in json || "overrides" in json || "name" in json) && !("$value" in json) ? "theme" : "dtcg";
    } catch {
      return undefined;
    }
  }
  if (/--by-[a-z0-9-]+\s*:/.test(t)) return "css";
  if (/--(background|primary|foreground|radius)\s*:/.test(t)) return "shadcn";
  return undefined;
}

export function importTheme(text: string, options: ImportOptions = {}): ImportResult {
  const name = options.name?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || undefined;
  if (options.name !== undefined && !name) return failed(`"${options.name}" is not a theme name`, "Use lower-case letters, digits and dashes.");
  const format = options.format ?? detectImportFormat(text);
  if (!format) return failed("the text is not a theme file, Byterygon CSS variables, DTCG JSON or a shadcn/ui globals.css", "Paste one of those, or choose the format.");
  switch (format) {
    case "css":
      return readByCss(text, name);
    case "shadcn":
      return readShadcn(text, name);
    case "dtcg":
    case "theme": {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (error) {
        return failed(`not valid JSON: ${(error as Error).message}`, "Paste the whole file.");
      }
      if (!isPlainObject(json)) return failed("the JSON is not an object", "Paste the whole file.");
      if (format === "dtcg") return readDtcg(json, name);
      const read = readThemeFile(json);
      const theme = { ...(read.theme as Json) };
      delete theme["$schema"];
      if (name) theme["name"] = name;
      return { ok: true, format, theme, text: stableJson(theme), mapped: 1, diagnostics: read.diagnostics };
    }
  }
}
