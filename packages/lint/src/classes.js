// @ts-check
/**
 * The analysis behind every rule: is one Tailwind class a token role, and if not, which role
 * should it be? Suggestions come from the catalogue (nearest value of the right family).
 */
import { closest } from "./catalog.js";
import { NAMED_COLORS, RAW_COLOR_PATTERN, nearestColors, parseCssColor } from "./colors.js";

/** @typedef {import("./catalog.js").Catalog} Catalog */
/** @typedef {import("./catalog.js").CatalogToken} CatalogToken */
/** @typedef {import("@byterygon/design-tokens").Oklch} Oklch */

/** @typedef {"no-raw-color" | "no-arbitrary-value" | "no-off-scale-spacing"} RuleName */
/**
 * @typedef {object} Finding
 * @property {RuleName} rule
 * @property {string} message  names the class, what is wrong, and the role or token to use
 * @property {string[]} suggestions  replacement classes (or values), best first; may be empty
 */
/**
 * @typedef {object} Context
 * @property {Catalog} catalog
 * @property {Map<string, Oklch>} palette  Tailwind's palette (`blue-500` -> colour); may be empty
 */

// Tailwind's colour palette names (the shades come from the installed tailwindcss when present).
const PALETTE_NAMES = "red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone mauve olive mist taupe".split(" ");

/** Utility prefixes that take a colour, and which group of roles they paint with. */
const COLOR_UTILITIES = /** @type {const} */ ([
  ["bg", "bg"], ["from", "bg"], ["via", "bg"], ["to", "bg"], ["accent", "bg"],
  ["text", "fg"], ["placeholder", "fg"], ["decoration", "fg"], ["caret", "fg"], ["fill", "fg"], ["stroke", "fg"],
  ["border", "border"], ["border-x", "border"], ["border-y", "border"], ["border-t", "border"], ["border-r", "border"],
  ["border-b", "border"], ["border-l", "border"], ["border-s", "border"], ["border-e", "border"], ["divide", "border"],
  ["outline", "border"], ["ring", "border"], ["ring-offset", "border"], ["inset-ring", "border"], ["shadow", "border"],
]);
/** @type {Map<string, "bg" | "fg" | "border">} */
const COLOR_PREFIX = new Map(COLOR_UTILITIES);
const COLOR_PREFIX_PATTERN = new RegExp(`^(${[...COLOR_PREFIX.keys()].sort((a, b) => b.length - a.length).join("|")})-(.+)$`);
const GROUP_LABEL = { bg: "background", fg: "text and icon", border: "border and ring" };

/** Families of space and size roles to suggest for each spacing or sizing utility, best first. */
const INSET = ["space.inset"];
const INLINE = ["space.inline"];
const STACK = ["space.stack"];
const POSITION = ["space.inset", "space.inline", "space.stack"];
const SIZE = ["size.control", "size.icon", "size.panel", "size.track"];
/** @type {Record<string, readonly string[]>} */
export const LENGTH_UTILITIES = {
  p: INSET, px: ["space.inset", "space.control"], py: INSET, pt: INSET, pr: INSET, pb: INSET, pl: INSET, ps: INSET, pe: INSET,
  m: ["space.stack", "space.inline"], mx: INLINE, ml: INLINE, mr: INLINE, ms: INLINE, me: INLINE, my: STACK, mt: STACK, mb: STACK,
  gap: ["space.gap"], "gap-x": ["space.gap", "space.inline"], "gap-y": ["space.gap", "space.stack"],
  "space-x": INLINE, "space-y": STACK,
  inset: POSITION, "inset-x": POSITION, "inset-y": POSITION, top: POSITION, right: POSITION, bottom: POSITION, left: POSITION, start: POSITION, end: POSITION,
  "scroll-m": POSITION, "scroll-p": INSET,
  w: SIZE, h: SIZE, size: SIZE, "min-w": SIZE, "min-h": SIZE, "max-w": SIZE, "max-h": SIZE, basis: SIZE,
};
const LENGTH_PREFIX_PATTERN = new RegExp(`^(${Object.keys(LENGTH_UTILITIES).sort((a, b) => b.length - a.length).join("|")})-(.+)$`);

/** Splits `a:b:[&_x]:c-[d]` into variants and the utility, ignoring colons inside brackets. */
export function splitClass(/** @type {string} */ name) {
  /** @type {string[]} */
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of name) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  return { variants: parts, utility: current };
}

/** `bg-blue-500/50` -> base `bg-blue-500`, modifier `50` (a slash outside brackets). */
function splitModifier(/** @type {string} */ utility) {
  let depth = 0;
  for (let i = utility.length - 1; i >= 0; i -= 1) {
    const ch = utility[i];
    if (ch === "]" || ch === ")") depth += 1;
    if (ch === "[" || ch === "(") depth -= 1;
    if (ch === "/" && depth === 0) return { base: utility.slice(0, i), modifier: utility.slice(i + 1) };
  }
  return { base: utility, modifier: undefined };
}

/** Splits a class string (`"px-3 hover:bg-hover"`) into classes. */
export function classesIn(/** @type {string} */ text) {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * Checks one class. Returns nothing for token roles, layout utilities and anything that is not a
 * colour, an arbitrary value or a raw space step.
 * @param {string} name
 * @param {Context} context
 * @returns {Finding[]}
 */
export function analyzeClass(name, context) {
  const { variants, utility: raw } = splitClass(name);
  const lead = variants.map((v) => `${v}:`).join("");
  let utility = raw.replace(/^!/, "").replace(/!$/, "");
  const negative = utility.startsWith("-") ? "-" : "";
  if (negative) utility = utility.slice(1);
  const { base, modifier } = splitModifier(utility);
  /** @type {Finding[]} */
  const findings = [];
  const out = (/** @type {RuleName} */ rule, /** @type {string} */ message, /** @type {string[]} */ suggestions = []) => findings.push({ rule, message: `"${name}" ${message}`, suggestions });
  const render = (/** @type {string} */ prefix, /** @type {string} */ suffix) => `${lead}${negative}${prefix}-${suffix}${modifier !== undefined && !/^[[(]/.test(modifier) ? `/${modifier}` : ""}`;

  if (modifier !== undefined && /^[[(]/.test(modifier)) {
    const inner = unwrap(modifier);
    if (!tokenExpression(inner, context, out)) out("no-arbitrary-value", `has an arbitrary opacity (${inner}). Use a step (/50) or a token: ${tokenVarsOfGroup(context, "opacity")}.`);
  }

  // [property:value]
  if (base.startsWith("[") && base.endsWith("]")) {
    const inner = base.slice(1, -1).replace(/_/g, " ");
    const colon = inner.indexOf(":");
    const property = colon > 0 ? inner.slice(0, colon) : "";
    const value = colon > 0 ? inner.slice(colon + 1) : inner;
    if (tokenExpression(value, context, out, groupOfProperty(property))) return findings;
    const color = rawColorIn(value, isColorProperty(property));
    if (color) colorFinding(out, color, groupOfProperty(property), context, (token) => `[${property}:var(${token.cssVar})]`);
    else out("no-arbitrary-value", `is an arbitrary property. ${lengthAdvice(property, value, context) ?? "Use a role utility, or move the declaration to a CSS rule that reads a token, var(--by-...)."}`);
    return findings;
  }

  // prefix-[value] or prefix-(--var)
  const arbitrary = /^([a-z][a-z0-9-]*?)-(\[.+\]|\(.+\))$/.exec(base);
  if (arbitrary) {
    const prefix = arbitrary[1] ?? "";
    const value = unwrap(arbitrary[2] ?? "");
    const colorGroup = COLOR_PREFIX.get(prefix);
    if (tokenExpression(value, context, out, colorGroup)) return findings;
    const color = rawColorIn(value, colorGroup !== undefined);
    if (color && colorGroup) {
      colorFinding(out, color, colorGroup, context, (token) => (token.utility ? render(prefix, token.utility) : `${prefix}-[var(${token.cssVar})]`));
      return findings;
    }
    if (color) {
      out("no-raw-color", `has a raw colour (${color}). Use a colour role through a token, var(--by-color-...); \`by-tokens search\` finds one.`);
      return findings;
    }
    const px = lengthPx(value);
    const families = LENGTH_UTILITIES[prefix];
    if (families && px !== undefined) {
      const picks = nearestLengths(px, families, context.catalog);
      out("no-arbitrary-value", `is an arbitrary value (${value}). Use a ${families[0]?.startsWith("size") ? "size" : "space"} role: ${picks.map((t) => `${render(prefix, t.utility ?? "")} (${describeLength(t)})`).join(", or ")}.`, picks.map((t) => render(prefix, t.utility ?? "")));
      return findings;
    }
    out("no-arbitrary-value", `is an arbitrary value (${value}). ${arbitraryAdvice(prefix, value, context, render)}`);
    return findings;
  }

  // Colour utilities: a role name, or a raw palette colour.
  const colorMatch = COLOR_PREFIX_PATTERN.exec(base);
  if (colorMatch) {
    const prefix = colorMatch[1] ?? "";
    const suffix = colorMatch[2] ?? "";
    const group = COLOR_PREFIX.get(prefix) ?? "bg";
    if (!context.catalog.byUtility.has(`color:${suffix}`)) {
      const palette = /^([a-z]+)-(\d{2,3})$/.exec(suffix);
      const isPalette = (palette && PALETTE_NAMES.includes(palette[1] ?? "")) || suffix === "black" || suffix === "white" || context.palette.has(suffix);
      if (isPalette) {
        const value = context.palette.get(suffix) ?? (suffix === "white" ? { l: 1, c: 0, h: 0 } : suffix === "black" ? { l: 0, c: 0, h: 0 } : undefined);
        colorFinding(out, `Tailwind's ${suffix}`, group, context, (token) => render(prefix, token.utility ?? ""), value);
        return findings;
      }
    }
  }

  // Numeric steps: p-2, gap-3, -mt-1.5 (spacing: always a role); w-4, h-36 (sizing: a role when
  // one has that value, else a step on the space scale). The whole utility is matched: `w-1/3` is
  // a fraction, not a step with an opacity modifier.
  const lengthMatch = LENGTH_PREFIX_PATTERN.exec(utility);
  if (lengthMatch) {
    const prefix = lengthMatch[1] ?? "";
    const step = lengthMatch[2] ?? "";
    if (/^\d+(\.\d+)?$/.test(step) && Number(step) !== 0) {
      const { catalog } = context;
      const px = Number(step) * catalog.spacingUnit;
      const families = LENGTH_UTILITIES[prefix] ?? INSET;
      const sizing = families[0]?.startsWith("size") ?? false;
      const picks = nearestLengths(px, families, catalog);
      const exact = picks.find((t) => t.px === px && families.some((f) => t.path.startsWith(`${f}.`) || t.path === f));
      const roles = picks.map((t) => `${render(prefix, t.utility ?? "")} (${describeLength(t)})`).join(", or ");
      if (!sizing) {
        out("no-off-scale-spacing", `is a raw step of the space scale (${formatPx(px)}). Use a space role: ${roles}.`, picks.map((t) => render(prefix, t.utility ?? "")));
      } else if (exact) {
        out("no-off-scale-spacing", `is ${formatPx(px)}, which the size role ${exact.path} names (it follows the density). Use ${render(prefix, exact.utility ?? "")} (${describeLength(exact)}).`, [render(prefix, exact.utility ?? "")]);
      } else {
        const scale = [...catalog.tokens.values()].filter((t) => /^space\.\d/.test(t.path) && t.px !== undefined && t.px > 0);
        if (!scale.some((t) => t.px === px)) {
          const near = [...scale].sort((a, b) => Math.abs((a.px ?? 0) - px) - Math.abs((b.px ?? 0) - px))[0];
          const onScale = near ? `${render(prefix, String((near.px ?? 0) / catalog.spacingUnit))} (${near.path}, ${formatPx(near.px ?? 0)})` : "";
          out("no-off-scale-spacing", `is off the space scale (${formatPx(px)}). Use a size role: ${roles}${onScale ? `, or a step on the scale: ${onScale}` : ""}.`, [...picks.map((t) => render(prefix, t.utility ?? "")), ...(near ? [render(prefix, String((near.px ?? 0) / catalog.spacingUnit))] : [])]);
        }
      }
    }
  }
  return findings;
}

/** `[x]` -> `x` with underscores as spaces; `(--x)` -> `var(--x)`; drops a type hint (`length:`). */
function unwrap(/** @type {string} */ wrapped) {
  const inner = wrapped.slice(1, -1).replace(/_/g, " ");
  const hinted = /^([a-z-]+):(.+)$/.exec(inner);
  const value = hinted && !/^[a-z-]+\(/.test(inner) ? (hinted[2] ?? "") : inner;
  return wrapped.startsWith("(") && value.startsWith("--") ? `var(${value})` : value;
}

/**
 * True when `value` is made only of token variables (`var(--by-...)`) with unitless numbers and
 * percentages around them (`calc(var(--by-size-control-md) * 2)`). Reports token variables that
 * do not exist or that name a colour primitive or a raw space step.
 * @param {string} value
 * @param {Context} context
 * @param {(rule: RuleName, message: string, suggestions?: string[]) => void} out
 * @param {"bg" | "fg" | "border"} [group]  what a colour primitive here paints
 */
function tokenExpression(value, context, out, group = "bg") {
  const vars = [...value.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*(?:,[^()]*)?\)/g)].map((m) => m[1] ?? "");
  if (vars.length === 0) return false;
  const rest = value.replace(/var\(\s*--[a-zA-Z0-9-]+\s*(?:,[^()]*)?\)/g, "0").replace(/\b(?:calc|min|max|clamp)\(/g, "(");
  if (!/^[\s()0-9.*+\-/%,]*$/.test(rest)) return false;
  for (const name of vars) {
    if (!name.startsWith("--by-")) {
      out("no-arbitrary-value", `reads ${name}, which is not a design token. Use a role utility or a token variable, var(--by-...).`);
      continue;
    }
    const token = context.catalog.byCssVar.get(name);
    if (!token) {
      const near = closest(name, context.catalog.byCssVar.keys());
      out("no-arbitrary-value", `reads ${name}, which is not a token of the ${context.catalog.theme} theme.${near.length > 0 ? ` Did you mean ${near.join(", ")}?` : ""}`, near.map((n) => `var(${n})`));
    } else if (token.tier === "primitive" && token.type === "color") {
      const picks = token.color ? nearestColors(token.color, context.catalog.colorRoles[group], 2) : [];
      out("no-raw-color", `reads the colour primitive ${token.path}. Components use roles${picks.length > 0 ? `: ${picks.map((t) => `var(${t.cssVar}) (${t.path})`).join(" or ")}` : ""}.`, picks.map((t) => `var(${t.cssVar})`));
    } else if (/^space\.\d/.test(token.path) && token.px !== undefined) {
      const picks = nearestLengths(token.px, POSITION, context.catalog);
      out("no-off-scale-spacing", `reads the raw space step ${token.path}. Use a space role: ${picks.map((t) => `var(${t.cssVar}) (${describeLength(t)})`).join(" or ")}.`, picks.map((t) => `var(${t.cssVar})`));
    }
  }
  return true;
}

/** The raw colour in a value, if any (hex, colour function, or a named colour when `named`). */
function rawColorIn(/** @type {string} */ value, named = false) {
  const literal = value.match(new RegExp(RAW_COLOR_PATTERN.source, "i"))?.[0];
  if (literal) return literal;
  const word = value.trim().toLowerCase();
  return named && NAMED_COLORS.has(word) ? word : undefined;
}

function isColorProperty(/** @type {string} */ property) {
  return /color|background|border|outline|fill|stroke|shadow|caret|decoration/.test(property);
}

/** @returns {"bg" | "fg" | "border"} */
export function groupOfProperty(/** @type {string} */ property) {
  if (/^(color|fill|stroke|caret-color|text-decoration|-webkit-text-fill-color)/.test(property)) return "fg";
  if (/border|outline|shadow|column-rule/.test(property)) return "border";
  return "bg";
}

/**
 * Reports a raw colour with the nearest roles of the group.
 * @param {(rule: RuleName, message: string, suggestions?: string[]) => void} out
 * @param {string} what            `#ff0000`, `Tailwind's blue-500`
 * @param {"bg" | "fg" | "border"} group
 * @param {Context} context
 * @param {(token: CatalogToken) => string} suggest
 * @param {Oklch} [value]          the colour, when `what` is not CSS
 */
function colorFinding(out, what, group, context, suggest, value = parseCssColor(what)) {
  const picks = value ? nearestColors(value, context.catalog.colorRoles[group], 2) : [];
  const roles = picks.length > 0 ? `: ${picks.map((t) => `${suggest(t)} (${t.path}, ${t.css["light"] ?? t.css["base"]} in light)`).join(", or ")} ${picks.length > 1 ? "are" : "is"} the nearest` : "";
  out("no-raw-color", `is a raw colour (${what}). Use a ${GROUP_LABEL[group]} role${roles}; \`by-tokens search ${group === "fg" ? "text" : group === "bg" ? "background" : "border"}\` lists the others.`, picks.map(suggest));
}

/** Length in px of `12px`, `0.75rem`, `1em` (16px); undefined otherwise. */
export function lengthPx(/** @type {string} */ value) {
  const m = /^\s*(-?\d*\.?\d+)(px|rem|em)\s*$/.exec(value);
  if (!m) return undefined;
  const n = Math.abs(Number(m[1]));
  return m[2] === "px" ? n : n * 16;
}

/**
 * The space or size roles nearest to `px`: the best of the first family that has one, and an
 * exact match from another family when the first is not exact.
 * @param {number} px
 * @param {readonly string[]} families
 * @param {Catalog} catalog
 * @returns {CatalogToken[]}
 */
export function nearestLengths(px, families, catalog) {
  const all = [...catalog.tokens.values()].filter((t) => t.namespace === "spacing" && t.utility && t.px !== undefined && /^(space|size)\./.test(t.path) && !/^space\.\d/.test(t.path));
  const inFamily = (/** @type {string} */ family) => all.filter((t) => t.path.startsWith(`${family}.`) || t.path === family);
  const rank = (/** @type {CatalogToken[]} */ list) => [...list].sort((a, b) => Math.abs((a.px ?? 0) - px) - Math.abs((b.px ?? 0) - px));
  const preferred = rank(families.flatMap(inFamily));
  const best = preferred[0];
  if (!best) return [];
  if (best.px === px) return [best];
  const exact = rank(all).find((t) => t.px === px);
  return exact ? [best, exact] : [best];
}

function formatPx(/** @type {number} */ px) {
  return `${Math.round(px * 100) / 100}px`;
}

/** `space.inset.sm, 12px comfortable / 8px compact`. */
export function describeLength(/** @type {CatalogToken} */ token) {
  const value = token.compactPx !== undefined && token.compactPx !== token.px ? `${formatPx(token.px ?? 0)} comfortable / ${formatPx(token.compactPx)} compact` : formatPx(token.px ?? 0);
  return `${token.path}, ${value}`;
}

/** Advice for an arbitrary property's length (`[padding:13px]`). */
function lengthAdvice(/** @type {string} */ property, /** @type {string} */ value, /** @type {Context} */ context) {
  const px = lengthPx(value);
  if (px === undefined) return undefined;
  const families = /padding/.test(property) ? INSET : /margin|gap|inset|top|left|right|bottom/.test(property) ? POSITION : /width|height|size/.test(property) ? SIZE : undefined;
  if (!families) return undefined;
  const picks = nearestLengths(px, families, context.catalog);
  return `Use a role: ${picks.map((t) => `var(${t.cssVar}) (${describeLength(t)})`).join(", or ")}.`;
}

/** `var(--by-opacity-disabled), var(--by-opacity-hover)`: the tokens of a top-level group. */
function tokenVarsOfGroup(/** @type {Context} */ context, /** @type {string} */ group) {
  return [...context.catalog.tokens.values()].filter((t) => t.path.startsWith(`${group}.`)).map((t) => `var(${t.cssVar})`).join(", ");
}

/**
 * What to use instead of an arbitrary value that is not a colour or a spacing length.
 * @param {string} prefix
 * @param {string} value
 * @param {Context} context
 * @param {(prefix: string, suffix: string) => string} render
 */
function arbitraryAdvice(prefix, value, context, render) {
  const tokens = [...context.catalog.tokens.values()];
  const nearestBy = (/** @type {CatalogToken[]} */ list, /** @type {(t: CatalogToken) => number | undefined} */ get, /** @type {number} */ target) =>
    [...list].filter((t) => get(t) !== undefined).sort((a, b) => Math.abs((get(a) ?? 0) - target) - Math.abs((get(b) ?? 0) - target))[0];
  const px = lengthPx(value);
  if (prefix.startsWith("rounded") && px !== undefined) {
    const best = nearestBy(tokens.filter((t) => t.namespace === "radius" && t.utility), (t) => t.px, px);
    if (best) return `Use a radius role: ${render(prefix, best.utility ?? "")} (${best.path}, ${formatPx(best.px ?? 0)}).`;
  }
  if (prefix === "text" && px !== undefined) {
    const best = nearestBy(tokens.filter((t) => t.namespace === "text" && t.utility), (t) => t.px, px);
    if (best) return `Use a text role: ${render(prefix, best.utility ?? "")} (${best.path.replace(/\.size$/, "")}, ${formatPx(best.px ?? 0)}), which also sets the weight, line height and tracking.`;
  }
  if (prefix === "duration" || prefix === "delay") {
    const ms = /^(\d*\.?\d+)(ms|s)$/.exec(value.trim());
    const target = ms ? Number(ms[1]) * (ms[2] === "s" ? 1000 : 1) : undefined;
    const best = target === undefined ? undefined : nearestBy(tokens.filter((t) => t.ms !== undefined && t.tier !== "primitive"), (t) => t.ms, target) ?? nearestBy(tokens.filter((t) => t.ms !== undefined), (t) => t.ms, target);
    if (best) return `Use a motion token: ${render(prefix, `[var(${best.cssVar})]`)} (${best.path}, ${best.ms}ms).`;
  }
  if (prefix === "z" && /^-?\d+$/.test(value.trim())) {
    const best = nearestBy(tokens.filter((t) => t.path.startsWith("z.")), (t) => t.number, Number(value));
    if (best) return `Use a z-index token: ${render(prefix, `[var(${best.cssVar})]`)} (${best.path}, ${best.number}).`;
  }
  if (prefix === "opacity") return `Use a step (opacity-50) or an opacity token: ${tokenVarsOfGroup(context, "opacity")}.`;
  if (prefix === "shadow") return `Use an elevation role: ${tokens.filter((t) => t.namespace === "shadow" && t.utility).map((t) => render(prefix, t.utility ?? "")).join(", ")}.`;
  if (LENGTH_UTILITIES[prefix]) return `Use a ${LENGTH_UTILITIES[prefix]?.[0]?.startsWith("size") ? "size" : "space"} role (\`by-tokens search ${LENGTH_UTILITIES[prefix]?.[0]?.split(".")[0]}\`), a fraction or keyword utility (w-full, h-1/2, max-h-screen), or a token variable, var(--by-...).`;
  return "Use a role utility or a token variable, var(--by-...); `by-tokens search <words>` finds one.";
}
