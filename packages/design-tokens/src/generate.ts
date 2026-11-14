/**
 * The generator: a theme (seeds plus overrides) and a catalogue become a token set.
 *
 *   seeds -> ramps (primitive tier) -> catalogue roles (semantic and component tiers) -> overrides
 *
 * Deterministic and pure: the same theme always gives the same tokens, and nothing here touches
 * the file system or the network, so it also runs in the browser.
 */
import { DEFAULT_CATALOG } from "./catalog/default.js";
import { type Catalog, type RoleValue, isModed } from "./catalog/authoring.js";
import { type Ramp, type Scheme, WCAG_AA, WCAG_AAA, generateRamp } from "./color/index.js";
import {
  type Axis,
  type ContrastTargets,
  type Diagnostic,
  type RampInfo,
  type ThemeFile,
  type Token,
  type TokenSet,
  type TokenValue,
  SCHEMA_VERSION,
} from "./model.js";
import { type ResolvedSeeds, resolveSeeds } from "./seeds.js";
import { closest, isPlainObject } from "./util.js";
import { colorValue, isValidPath, parseLiteral } from "./values.js";

export interface GenerateResult {
  readonly set: TokenSet;
  readonly seeds: ResolvedSeeds;
  /** Problems with the theme file itself: unknown seeds, bad overrides, unreachable ramp steps. */
  readonly diagnostics: readonly Diagnostic[];
}

const THEME_KEYS = ["$schema", "schemaVersion", "name", "description", "seeds", "overrides"];
const THEME_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Radix's alpha scale for the pure black and white overlays. */
const OVERLAY_ALPHAS = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];

const PRIMITIVE_RULE = "Primitive: reference it through a semantic role, never from a component.";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function axesFor(seeds: Pick<ResolvedSeeds, "colorScheme" | "density">): Axis[] {
  return [
    {
      name: "theme",
      attribute: "data-theme",
      modes: ["light", "dark"],
      default: seeds.colorScheme,
      selectors: { light: [".light"], dark: [".dark"] },
      colorScheme: { light: "light", dark: "dark" },
    },
    { name: "density", attribute: "data-density", modes: ["comfortable", "compact"], default: seeds.density },
  ];
}

export function generateTokens(theme: unknown, catalog: Catalog = DEFAULT_CATALOG): GenerateResult {
  const diagnostics: Diagnostic[] = [];
  const themeError = (token: string, message: string, extra: Partial<Diagnostic> = {}) =>
    diagnostics.push({ severity: "error", rule: "theme-schema", token, message, ...extra });

  const file: Partial<ThemeFile> & Record<string, unknown> = isPlainObject(theme) ? theme : {};
  if (!isPlainObject(theme)) themeError("theme", "a theme must be a JSON object with schemaVersion, name, seeds and overrides");
  for (const key of Object.keys(file)) {
    if (!THEME_KEYS.includes(key)) {
      const near = closest(key, THEME_KEYS);
      themeError(key, `unknown key "${key}" in the theme file`, {
        fix: { summary: near.length > 0 ? `Did you mean ${near.join(" or ")}?` : `Known keys: ${THEME_KEYS.join(", ")}.` },
      });
    }
  }
  if (isPlainObject(theme) && file.schemaVersion !== SCHEMA_VERSION) {
    themeError("schemaVersion", `schemaVersion must be ${SCHEMA_VERSION}`, {
      measured: JSON.stringify(file.schemaVersion) ?? "missing",
      required: SCHEMA_VERSION,
      fix: { summary: `Set "schemaVersion": ${SCHEMA_VERSION}.` },
    });
  }
  let name = "unnamed";
  if (typeof file.name === "string" && THEME_NAME.test(file.name)) name = file.name;
  else if (isPlainObject(theme)) {
    themeError("name", "name must be lower-case letters, digits and dashes", {
      measured: JSON.stringify(file.name) ?? "missing",
      fix: { summary: 'Set "name" to something like "my-theme".' },
    });
  }
  if (file.description !== undefined && typeof file.description !== "string") themeError("description", "description must be a string");

  const resolved = resolveSeeds(file.seeds);
  diagnostics.push(...resolved.diagnostics);
  const seeds = resolved.seeds;
  const axes = axesFor(seeds);
  const thresholds = seeds.contrast.level === "AAA" ? WCAG_AAA : WCAG_AA;
  const contrast: ContrastTargets = { level: seeds.contrast.level, ...thresholds, ...(seeds.contrast.apca ? { apca: seeds.contrast.apca } : {}) };

  const tokens = new Map<string, Token>();
  const add = (token: Token) => {
    if (!isValidPath(token.path)) throw new Error(`invalid token path "${token.path}"`);
    if (tokens.has(token.path)) throw new Error(`duplicate token "${token.path}"`);
    tokens.set(token.path, token);
  };

  // --- Primitive tier ------------------------------------------------------------------------
  add({
    path: "color.base.white",
    type: "color",
    tier: "primitive",
    value: colorValue({ l: 1, c: 0, h: 0 }),
    description: `Pure white. ${PRIMITIVE_RULE}`,
  });
  add({
    path: "color.base.black",
    type: "color",
    tier: "primitive",
    value: colorValue({ l: 0, c: 0, h: 0 }),
    description: `Pure black. ${PRIMITIVE_RULE}`,
  });
  for (const [colorName, lightness, on] of [
    ["white", 1, "dark"],
    ["black", 0, "light"],
  ] as const) {
    OVERLAY_ALPHAS.forEach((alpha, index) => {
      add({
        path: `color.${colorName}.a${index + 1}`,
        type: "color",
        tier: "primitive",
        value: colorValue({ l: lightness, c: 0, h: 0, alpha }),
        description: `${capitalize(colorName)} at ${Math.round(alpha * 100)}% alpha, for shadows, scrims and hairlines on ${on} backgrounds. ${PRIMITIVE_RULE}`,
      });
    });
  }

  const rampNames = Object.keys(seeds.colors).sort((a, b) => rampOrder(a) - rampOrder(b));
  const neutralSeed = seeds.colors["neutral"];
  for (const scheme of ["light", "dark"] as const) {
    const reference = neutralSeed ? generateRamp(neutralSeed, scheme, { thresholds }) : undefined;
    for (const rampName of rampNames) {
      const seed = seeds.colors[rampName]!;
      const generated =
        rampName === "neutral" && reference ? reference : generateRamp(seed, scheme, { thresholds, ...(reference ? { reference } : {}) });
      addRamp(rampName, scheme, generated, add);
      for (const warning of generated.warnings) {
        const token = `color.${groupName(rampName, scheme)}.${warning.step}`;
        if (warning.kind === "gamut") {
          diagnostics.push({
            severity: "warning",
            rule: "gamut",
            token,
            mode: { theme: scheme },
            message: `${rampName}: ${warning.message}`,
            ...(warning.measured !== undefined ? { measured: warning.measured } : {}),
            ...(warning.required !== undefined ? { required: warning.required } : {}),
            fix: {
              summary: `Lower seeds.colors.${rampName}.chroma to ${warning.measured}, or accept the reduced chroma.`,
              seeds: { colors: { [rampName]: { chroma: warning.measured } } },
            },
          });
        } else {
          diagnostics.push({
            severity: "error",
            rule: "ramp-contrast-unreachable",
            token,
            mode: { theme: scheme },
            message: `${rampName}: ${warning.message}`,
            ...(warning.measured !== undefined ? { measured: Math.round(warning.measured * 100) / 100 } : {}),
            ...(warning.required !== undefined ? { required: warning.required } : {}),
            fix: { summary: `Change seeds.colors.${rampName} (hue, chroma or solid lightness) so the step can reach the ratio.` },
          });
        }
      }
    }
  }

  // --- Semantic and component tiers ------------------------------------------------------------
  for (const role of catalog.roles) {
    const authored: RoleValue = typeof role.value === "function" ? role.value(seeds) : role.value;
    const base = {
      path: role.path,
      type: role.type,
      tier: role.tier ?? "semantic",
      description: `${role.use} ${role.avoid}`.trim(),
      ...(role.tailwind ? { tailwind: role.tailwind } : {}),
      ...(role.tailwindAliases?.length ? { tailwindAliases: role.tailwindAliases } : {}),
    } as const;
    add(isModed(authored) ? { ...base, axis: authored.axis, modes: { ...authored.values } } : { ...base, value: authored });
  }

  // --- Overrides -------------------------------------------------------------------------------
  const overrides = file.overrides;
  if (overrides !== undefined && !isPlainObject(overrides)) {
    themeError("overrides", "overrides must be an object of token path to value");
  } else if (overrides) {
    for (const [path, input] of Object.entries(overrides)) applyOverride(path, input, tokens, axes, diagnostics);
  }

  const set: TokenSet = {
    name,
    ...(typeof file.description === "string" ? { description: file.description } : {}),
    axes,
    tokens,
    pairs: catalog.pairs,
    contrast,
    shadcn: catalog.shadcn,
  };
  return { set, seeds, diagnostics };
}

/** Neutral and brand first, then the rest in the order the seeds list them. */
function rampOrder(name: string): number {
  return name === "neutral" ? 0 : name === "brand" ? 1 : 2;
}

/** The token group of a ramp: `brand` in the light scheme, `brand-dark` in the dark one. */
export function groupName(ramp: string, scheme: Scheme): string {
  return scheme === "light" ? ramp : `${ramp}-dark`;
}

function addRamp(name: string, scheme: Scheme, generated: Ramp, add: (token: Token) => void): void {
  const group = groupName(name, scheme);
  const label = `${capitalize(name)} ramp, ${scheme} scheme`;
  for (const step of generated.steps) {
    const info: RampInfo = { name, scheme, step: step.step };
    add({
      path: `color.${group}.${step.step}`,
      type: "color",
      tier: "primitive",
      value: colorValue(step.color),
      description: `${label}, step ${step.step}: ${step.job}. ${PRIMITIVE_RULE}`,
      ramp: info,
    });
  }
  for (const step of generated.steps) {
    add({
      path: `color.${group}.a${step.step}`,
      type: "color",
      tier: "primitive",
      value: colorValue(step.alpha),
      description: `${label}, translucent variant of step ${step.step}: shows as that step over the ${scheme === "light" ? "white" : "dark app"} background, for washes laid over other content. ${PRIMITIVE_RULE}`,
      ramp: { name, scheme, step: step.step, alpha: true },
    });
  }
  add({
    path: `color.${group}.contrast`,
    type: "color",
    tier: "primitive",
    value: colorValue(generated.contrast),
    description: `${label}: the text and icon colour for its solids (steps 9 and 10), ${generated.contrastIs === "white" ? "white" : "a near-black ink"} because that contrasts more. ${PRIMITIVE_RULE}`,
    ramp: { name, scheme, step: "contrast" },
  });
}

function applyOverride(
  path: string,
  input: unknown,
  tokens: Map<string, Token>,
  axes: readonly Axis[],
  diagnostics: Diagnostic[],
): void {
  const token = tokens.get(path);
  if (!token) {
    const near = closest(path, tokens.keys());
    diagnostics.push({
      severity: "error",
      rule: "override-unknown-token",
      token: path,
      message: `overrides: no token named "${path}"`,
      fix: {
        summary: near.length > 0 ? `Did you mean ${near.join(" or ")}?` : "Run `by-tokens search <words>` to find the token.",
      },
    });
    return;
  }
  const invalid = (message: string, mode?: string) =>
    diagnostics.push({
      severity: "error",
      rule: "override-invalid-value",
      token: path,
      ...(mode && token.axis ? { mode: { [token.axis]: mode } } : {}),
      message: `overrides: ${path}${mode ? ` (${mode})` : ""}: ${message}`,
      measured: JSON.stringify(input),
      required: `a ${token.type} value or an alias such as {color.brand.11}`,
      fix: { summary: `Write an alias in braces, or a ${token.type} literal. Run \`by-tokens explain ${path}\` to see the current value.` },
    });
  const noted = (note: string | undefined) => {
    if (!note) return;
    diagnostics.push({ severity: "warning", rule: "gamut", token: path, message: `overrides: ${path}: ${note}` });
  };

  const modeNames = new Set(axes.flatMap((axis) => axis.modes));
  const isModeMap = isPlainObject(input) && Object.keys(input).length > 0 && Object.keys(input).every((key) => modeNames.has(key));

  if (!isModeMap) {
    const parsed = parseLiteral(token.type, input);
    if (!parsed.ok) return void invalid(parsed.error);
    noted(parsed.note);
    const { axis: _axis, modes: _modes, value: _value, ...rest } = token;
    tokens.set(path, { ...rest, value: parsed.value, overridden: true });
    return;
  }

  const given = input as Record<string, unknown>;
  const axis = axes.find((candidate) => Object.keys(given).every((key) => candidate.modes.includes(key)));
  if (!axis) return void invalid("the modes named belong to different axes; override one axis at a time");
  if (token.axis && token.axis !== axis.name) {
    return void invalid(`the token varies by ${token.axis}, not by ${axis.name}`);
  }
  const modes: Record<string, TokenValue> = {};
  for (const mode of axis.modes) modes[mode] = token.modes?.[mode] ?? (token.value as TokenValue);
  for (const [mode, raw] of Object.entries(given)) {
    const parsed = parseLiteral(token.type, raw);
    if (!parsed.ok) return void invalid(parsed.error, mode);
    noted(parsed.note);
    modes[mode] = parsed.value;
  }
  const { value: _value, ...rest } = token;
  tokens.set(path, { ...rest, axis: axis.name, modes, overridden: true });
}
