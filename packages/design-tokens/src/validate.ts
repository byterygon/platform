/**
 * The build-time rules. Each rule has a stable identifier; each finding names the token, the
 * mode, the measured and the required value, and a fix that can be pasted into the theme file.
 *
 *   description-missing         every token says when to use it and when not to
 *   value-invalid               a value is not a valid value of the token's type
 *   mode-invalid                a moded token must have one value per mode of one known axis
 *   alias-missing               an alias points at a token that does not exist
 *   alias-cycle                 aliases form a loop
 *   alias-type-mismatch         an alias points at a token of another type
 *   tier-direction              primitives hold literals only; a tier never references a higher one
 *   path-collision              a token path is also the group of another token
 *   mode-cross-axis             a token that varies by one axis depends on another axis as well
 *   raw-color-outside-primitive a colour literal outside the primitive tier
 *   contrast                    a role pair is below its WCAG target in some mode
 *   contrast-apca               a role pair is below the theme's APCA target (only when one is set)
 *   contrast-pair-unknown-token a contrast pair names a token that does not exist
 *   output-mapping              a Tailwind or shadcn mapping is duplicated or points nowhere
 */
import { type ContrastKind, type Oklch, type Rgb, apcaContrast, formatOklch, oklchToDisplayRgb, settle, wcagContrast } from "./color/index.js";
import {
  type ColorValue,
  type ContrastPair,
  type Diagnostic,
  type Fix,
  type ModeContext,
  type ShadowLayer,
  type Tier,
  type Token,
  type TokenSet,
  TIERS,
  aliasTarget,
  isAlias,
} from "./model.js";
import { dependentAxes, ownValues, paint, referencedBy, resolve } from "./resolve.js";
import { closest } from "./util.js";
import { aliasesIn, checkValue, colorLiteralsIn, colorToOklch } from "./values.js";

export interface ContrastMeasurement {
  readonly fg: string;
  readonly bg: string;
  readonly over?: string;
  readonly kind: ContrastKind;
  readonly mode: ModeContext;
  /** WCAG 2.x contrast ratio, rounded down to two decimals. */
  readonly ratio: number;
  readonly required: number;
  /** APCA lightness contrast (signed Lc), one decimal. Informative unless the theme sets a target. */
  readonly apca: number;
  readonly pass: boolean;
}

export interface ValidationResult {
  readonly diagnostics: readonly Diagnostic[];
  /** Every role pair in every mode it depends on, passing or not. */
  readonly contrast: readonly ContrastMeasurement[];
}

const DEFAULT_BACKDROP = "color.bg.canvas";
const floor2 = (value: number) => Math.floor(value * 100 + 1e-9) / 100;
const tierRank = (tier: Tier) => TIERS.indexOf(tier);

export function validate(set: TokenSet): ValidationResult {
  const diagnostics: Diagnostic[] = [];
  const error = (rule: string, token: string, message: string, extra: Partial<Diagnostic> = {}) =>
    diagnostics.push({ severity: "error", rule, token, message, ...extra });
  const axisByName = new Map(set.axes.map((axis) => [axis.name, axis]));

  for (const token of set.tokens.values()) {
    if (token.description.trim().length < 12) {
      error("description-missing", token.path, `${token.path} has no $description saying when to use it and when not to`, {
        fix: { summary: "Add `use` and `avoid` sentences to the role in the catalogue." },
      });
    }

    // Modes.
    if (token.axis !== undefined) {
      const axis = axisByName.get(token.axis);
      const given = Object.keys(token.modes ?? {});
      if (!axis) {
        error("mode-invalid", token.path, `${token.path} varies by "${token.axis}", which is not a mode axis`, {
          required: [...axisByName.keys()].join(" | "),
        });
      } else {
        const missing = axis.modes.filter((mode) => !given.includes(mode));
        const unknown = given.filter((mode) => !axis.modes.includes(mode));
        if (missing.length > 0 || unknown.length > 0) {
          error("mode-invalid", token.path, `${token.path} must have exactly one value per ${axis.name} mode`, {
            measured: given.join(", "),
            required: axis.modes.join(", "),
            fix: { summary: `Give a value for ${missing.join(", ") || "each mode"}${unknown.length > 0 ? ` and remove ${unknown.join(", ")}` : ""}.` },
          });
        }
      }
    } else if (token.value === undefined) {
      error("value-invalid", token.path, `${token.path} has no value`);
    }

    for (const { mode, value } of ownValues(token)) {
      const where = mode && token.axis ? { mode: { [token.axis]: mode } } : {};
      const problem = checkValue(token.type, value);
      if (problem) {
        error("value-invalid", token.path, `${token.path}: ${problem}`, { ...where, measured: JSON.stringify(value) });
        continue;
      }

      // Aliases: existence, type, tier direction.
      const aliases = aliasesIn(value);
      if (token.tier === "primitive" && aliases.length > 0) {
        error("tier-direction", token.path, `${token.path} is a primitive and must hold a literal, not an alias`, {
          ...where,
          measured: aliases.join(", "),
          fix: { summary: "Give the primitive a literal value, or move the token to the semantic tier." },
        });
      }
      for (const alias of aliases) {
        const targetPath = aliasTarget(alias);
        const target = set.tokens.get(targetPath);
        if (!target) {
          const near = closest(targetPath, set.tokens.keys());
          error("alias-missing", token.path, `${token.path} references ${alias}, which does not exist`, {
            ...where,
            related: targetPath,
            fix: {
              summary: near.length > 0 ? `Did you mean ${near.map((n) => `{${n}}`).join(" or ")}?` : "Run `by-tokens search <words>` to find the token.",
            },
          });
          continue;
        }
        const expected = isAlias(value) ? token.type : fieldType(value as readonly ShadowLayer[], alias);
        if (target.type !== expected) {
          error("alias-type-mismatch", token.path, `${token.path} needs a ${expected} but ${alias} is a ${target.type}`, {
            ...where,
            related: targetPath,
            measured: target.type,
            required: expected,
          });
        }
        if (tierRank(target.tier) > tierRank(token.tier)) {
          error("tier-direction", token.path, `${token.path} (${token.tier}) must not reference ${alias} (${target.tier}): tiers only point downwards`, {
            ...where,
            related: targetPath,
            fix: { summary: `Reference a ${token.tier} or lower-tier token instead.` },
          });
        }
      }

      // Raw colours belong to the primitive tier.
      if (token.tier !== "primitive") {
        for (const literal of colorLiteralsIn(token.type, value)) {
          error("raw-color-outside-primitive", token.path, `${token.path} (${token.tier}) holds a raw colour; only primitives may`, {
            ...where,
            measured: formatOklch(colorToOklch(literal)),
            required: "an alias to a primitive colour",
            fix: rawColorFix(set, token, literal, mode),
          });
        }
      }
    }
  }

  // A token cannot also be a group, and a moded token cannot depend on a second axis: CSS could
  // not say which of its values applies inside a scope that only switches the other axis.
  for (const token of set.tokens.values()) {
    const segments = token.path.split(".");
    for (let length = 2; length < segments.length; length += 1) {
      const parent = segments.slice(0, length).join(".");
      if (set.tokens.has(parent)) {
        error("path-collision", token.path, `${token.path} is nested under ${parent}, which is itself a token`, {
          related: parent,
          fix: { summary: `Rename one of them, for example ${parent}-${segments[length]}.` },
        });
      }
    }
    if (token.axis === undefined) continue;
    const others = [...dependentAxes(set, token.path)].filter((axis) => axis !== token.axis);
    if (others.length > 0) {
      error("mode-cross-axis", token.path, `${token.path} varies by ${token.axis} but its values also depend on ${others.join(", ")}`, {
        measured: [token.axis, ...others].join(" + "),
        required: "one axis",
        fix: { summary: `Split it: keep the ${token.axis} variation here and reference tokens that do not vary by ${others.join(" or ")}.` },
      });
    }
  }

  // Cycles (missing targets were reported above).
  for (const token of set.tokens.values()) {
    for (const context of contextsFor(set, [token.path])) {
      const resolution = resolve(set, token.path, context);
      if (!resolution.ok && resolution.reason === "cycle") {
        error("alias-cycle", token.path, `${token.path} is part of an alias loop: ${resolution.chain.join(" -> ")}`, {
          mode: context,
          fix: { summary: "Point one of these tokens at a primitive." },
        });
        break;
      }
    }
  }

  // Output mappings.
  const tailwind = new Map<string, string>();
  for (const token of set.tokens.values()) {
    if (!token.tailwind) continue;
    const taken = tailwind.get(token.tailwind);
    if (taken) {
      error("output-mapping", token.path, `${token.path} and ${taken} both map to the Tailwind variable ${token.tailwind}`, { related: taken });
    } else if (!/^--[a-z][a-z0-9-]*$/.test(token.tailwind)) {
      error("output-mapping", token.path, `${token.tailwind} is not a valid Tailwind theme variable name`);
    } else {
      tailwind.set(token.tailwind, token.path);
    }
  }
  for (const [variable, path] of Object.entries(set.shadcn)) {
    if (!set.tokens.has(path)) {
      const near = closest(path, set.tokens.keys());
      error("output-mapping", path, `the shadcn alias ${variable} points at ${path}, which does not exist`, {
        ...(near.length > 0 ? { fix: { summary: `Did you mean ${near.join(" or ")}?` } } : {}),
      });
    }
  }

  const contrast = measureContrast(set, diagnostics);
  return { diagnostics, contrast };
}

function fieldType(layers: readonly ShadowLayer[], alias: string): "color" | "dimension" {
  return layers.some((layer) => layer.color === alias) ? "color" : "dimension";
}

/** The contexts that matter for a group of tokens: every combination of the axes they depend on. */
export function contextsFor(set: TokenSet, paths: readonly string[]): ModeContext[] {
  const axes = new Set<string>();
  for (const path of paths) for (const axis of dependentAxes(set, path)) axes.add(axis);
  let contexts: Record<string, string>[] = [{}];
  for (const axis of set.axes) {
    if (!axes.has(axis.name)) continue;
    contexts = contexts.flatMap((context) => axis.modes.map((mode) => ({ ...context, [axis.name]: mode })));
  }
  return contexts;
}

function measureContrast(set: TokenSet, diagnostics: Diagnostic[]): ContrastMeasurement[] {
  const measurements: ContrastMeasurement[] = [];
  // Every background a foreground role is paired with, per mode: a fix has to hold on all of them.
  const backgrounds = new Map<string, Background[]>();
  const failures: (() => void)[] = [];
  for (const pair of set.pairs) {
    const over = pair.over ?? DEFAULT_BACKDROP;
    const unknown = [pair.fg, pair.bg, over].filter((path) => !set.tokens.has(path));
    if (unknown.length > 0) {
      for (const path of unknown) {
        const near = closest(path, set.tokens.keys());
        diagnostics.push({
          severity: "error",
          rule: "contrast-pair-unknown-token",
          token: path,
          message: `the contrast pair ${pair.fg} on ${pair.bg} names ${path}, which does not exist`,
          ...(near.length > 0 ? { fix: { summary: `Did you mean ${near.join(" or ")}?` } } : {}),
        });
      }
      continue;
    }
    if ([pair.fg, pair.bg, over].some((path) => set.tokens.get(path)!.type !== "color")) {
      diagnostics.push({
        severity: "error",
        rule: "contrast-pair-unknown-token",
        token: pair.fg,
        related: pair.bg,
        message: `the contrast pair ${pair.fg} on ${pair.bg} must name colour tokens`,
      });
      continue;
    }

    for (const context of contextsFor(set, [pair.fg, pair.bg, over])) {
      const fg = resolve(set, pair.fg, context);
      const bg = resolve(set, pair.bg, context);
      const base = resolve(set, over, context);
      if (!fg.ok || !bg.ok || !base.ok) continue; // already reported as alias-missing or alias-cycle
      const baseRgb = paint(base.value as ColorValue);
      const bgRgb = paint(bg.value as ColorValue, baseRgb);
      const fgRgb = paint(fg.value as ColorValue, bgRgb);
      const exact = wcagContrast(fgRgb, bgRgb);
      const ratio = floor2(exact);
      const required = set.contrast[pair.kind];
      const apca = Math.round(apcaContrast(fgRgb, bgRgb) * 10) / 10;
      const apcaRequired = set.contrast.apca?.[pair.kind];
      const apcaPass = apcaRequired === undefined || Math.abs(apca) >= apcaRequired;
      const measurement: ContrastMeasurement = {
        fg: pair.fg,
        bg: pair.bg,
        ...(pair.over ? { over: pair.over } : {}),
        kind: pair.kind,
        mode: context,
        ratio,
        required,
        apca,
        pass: exact >= required && apcaPass,
      };
      measurements.push(measurement);
      const key = `${pair.fg} ${JSON.stringify(context)}`;
      const background: Background = { rgb: bgRgb, required };
      backgrounds.set(key, [...(backgrounds.get(key) ?? []), background]);

      const where = `${pair.over ? ` over ${pair.over}` : ""}${describeMode(context)}`;
      if (exact < required) {
        failures.push(() =>
          diagnostics.push({
            severity: "error",
            rule: "contrast",
            token: pair.fg,
            related: pair.bg,
            mode: context,
            message: `${pair.fg} on ${pair.bg}${where}: contrast ${ratio}:1 is below the ${required}:1 required for ${pair.kind === "text" ? "text" : "UI components"} (WCAG 2.2 ${set.contrast.level})`,
            measured: ratio,
            required,
            fix: contrastFix(set, pair, context, fg.chain, fg.value as ColorValue, background, backgrounds.get(key)!),
          }),
        );
      } else if (!apcaPass) {
        diagnostics.push({
          severity: "error",
          rule: "contrast-apca",
          token: pair.fg,
          related: pair.bg,
          mode: context,
          message: `${pair.fg} on ${pair.bg}${where}: APCA Lc ${Math.abs(apca)} is below the theme's target of ${apcaRequired}`,
          measured: Math.abs(apca),
          required: apcaRequired!,
          fix: { summary: `Increase the lightness difference between the two roles, or lower seeds.contrast.apca.${pair.kind}.` },
        });
      }
    }
  }
  for (const report of failures) report();
  return measurements;
}

function describeMode(context: ModeContext): string {
  const parts = Object.entries(context).map(([axis, mode]) => `${axis}=${mode}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** The override that sets one mode of a token (or the whole token when it is unmoded). */
function overrideFor(token: Token, context: ModeContext, value: string): unknown {
  const mode = token.axis ? context[token.axis] : undefined;
  return mode ? { [mode]: value } : value;
}

interface Background {
  readonly rgb: Rgb;
  readonly required: number;
}

/** The lowest ratio of a colour against a group of backgrounds, or undefined when one falls short. */
function passesAll(color: Rgb, group: readonly Background[]): number | undefined {
  let lowest = Infinity;
  for (const background of group) {
    const ratio = wcagContrast(color, background.rgb);
    if (ratio < background.required) return undefined;
    lowest = Math.min(lowest, ratio);
  }
  return lowest;
}

/** The lightness closest to the colour's own at which it passes on every background of the group. */
function nudgeLightness(color: Oklch, group: readonly Background[]): { color: Oklch; ratio: number } | undefined {
  for (let i = 1; i <= 400; i += 1) {
    for (const direction of [-1, 1]) {
      const l = color.l + direction * i * 0.0025;
      if (l < 0 || l > 1) continue;
      const candidate = settle({ ...color, l });
      const ratio = passesAll(oklchToDisplayRgb(candidate), group);
      if (ratio !== undefined) return { color: candidate, ratio };
    }
  }
  return undefined;
}

/**
 * The fix for a failing pair. It is solved against every background the foreground is paired
 * with in that mode, so one change clears all of the role's failures; when no colour can satisfy
 * them all, it is solved for the failing pair alone.
 */
function contrastFix(
  set: TokenSet,
  pair: ContrastPair,
  context: ModeContext,
  chain: readonly string[],
  fgValue: ColorValue,
  failing: Background,
  paired: readonly Background[],
): Fix {
  const role = set.tokens.get(pair.fg)!;
  const primitivePath = chain[chain.length - 1]!;
  const primitive = set.tokens.get(primitivePath);
  const opaque = (fgValue.alpha ?? 1) >= 1;

  for (const group of paired.length > 1 ? [paired, [failing]] : [[failing]]) {
    const scope = group.length > 1 ? ` on all ${group.length} backgrounds it is paired with` : "";
    const alternatives: { summary: string; overrides?: Record<string, unknown> }[] = [];

    // Another step of the same ramp that passes, closest in lightness to the current one.
    if (primitive?.ramp && typeof primitive.ramp.step === "number") {
      let best: { path: string; ratio: number; distance: number } | undefined;
      for (const candidate of set.tokens.values()) {
        const info = candidate.ramp;
        if (!info || info.alpha || typeof info.step !== "number") continue;
        if (info.name !== primitive.ramp.name || info.scheme !== primitive.ramp.scheme || candidate.path === primitivePath) continue;
        const value = candidate.value as ColorValue;
        const ratio = passesAll(paint(value), group);
        const distance = Math.abs(value.components[0] - fgValue.components[0]);
        if (ratio !== undefined && (!best || distance < best.distance)) best = { path: candidate.path, ratio, distance };
      }
      if (best) {
        alternatives.push({
          summary: `Alias ${pair.fg} to {${best.path}} instead (at least ${floor2(best.ratio)}:1${scope}).`,
          overrides: { [pair.fg]: overrideFor(role, context, `{${best.path}}`) },
        });
      }
    }

    // Nudge the lightness of the primitive the foreground resolves to.
    const nudged = opaque && primitive ? nudgeLightness(colorToOklch(fgValue), group) : undefined;
    if (nudged) {
      const users = referencedBy(set, primitivePath).filter((path) => path !== pair.fg);
      const shared = users.length > 0 ? ` It also changes ${users.length} other role${users.length === 1 ? "" : "s"} (${users.slice(0, 3).join(", ")}${users.length > 3 ? ", ..." : ""}).` : "";
      return {
        summary: `Change the lightness of ${primitivePath} from ${fgValue.components[0]} to ${nudged.color.l}: ${formatOklch(nudged.color)} gives at least ${floor2(nudged.ratio)}:1${scope}.${shared}`,
        overrides: { [primitivePath]: formatOklch(nudged.color) },
        ...(alternatives.length > 0 ? { alternatives } : {}),
      };
    }
    const first = alternatives[0];
    if (first) return { summary: first.summary, ...(first.overrides ? { overrides: first.overrides } : {}) };
  }
  return { summary: `No lightness of ${primitivePath} reaches ${failing.required}:1 against ${pair.bg}; change the background role or alias ${pair.fg} to another ramp.` };
}

/** For a raw colour outside the primitive tier: the closest primitive to alias instead. */
function rawColorFix(set: TokenSet, token: Token, literal: ColorValue, mode: string | undefined): Fix {
  const [l, c, h] = literal.components;
  const lab = (lightness: number, chroma: number, hue: number) => {
    const radians = (hue * Math.PI) / 180;
    return [lightness, chroma * Math.cos(radians), chroma * Math.sin(radians)] as const;
  };
  const target = lab(l, c, h);
  let best: { path: string; distance: number } | undefined;
  for (const candidate of set.tokens.values()) {
    if (candidate.tier !== "primitive" || candidate.type !== "color" || isAlias(candidate.value)) continue;
    const value = candidate.value as ColorValue;
    if ((value.alpha ?? 1) !== (literal.alpha ?? 1) && Math.abs((value.alpha ?? 1) - (literal.alpha ?? 1)) > 0.05) continue;
    const other = lab(...value.components);
    const distance = Math.hypot(target[0] - other[0], target[1] - other[1], target[2] - other[2]);
    if (!best || distance < best.distance) best = { path: candidate.path, distance };
  }
  if (!best) return { summary: "Alias a primitive colour instead of writing a literal." };
  const alias = `{${best.path}}`;
  const useMode = token.type === "color" && mode && token.axis;
  return {
    summary: `Alias the closest primitive, ${alias}, or override that primitive if the exact colour matters.`,
    ...(token.type === "color" ? { overrides: { [token.path]: useMode ? { [mode]: alias } : alias } } : {}),
  };
}
