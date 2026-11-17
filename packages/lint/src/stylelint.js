// @ts-check
/**
 * Stylelint plugin: the token rules for CSS (spec section 9a.4).
 *
 *   byterygon/no-raw-color          hex, rgb(), hsl(), oklch() ... and named colours in colour properties
 *   byterygon/no-off-scale-spacing  px/rem/em lengths in padding, margin, gap and inset properties
 *   byterygon/no-arbitrary-value    arbitrary values in `@apply` classes
 *
 * All three also check the classes of `@apply` as the ESLint rules do. Each takes the secondary
 * option `{ theme: "<preset name or theme file>" }`.
 *
 *   export default { extends: ["@byterygon/lint/stylelint-config"] };
 */
import stylelint from "stylelint";
import { loadCatalog, tailwindPalette } from "./catalog.js";
import { analyzeClass, classesIn, describeLength, groupOfProperty, nearestLengths } from "./classes.js";
import { findRawColors, nearestColors, parseCssColor } from "./colors.js";

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

/** @typedef {import("./classes.js").RuleName} RuleName */

const COLOR_PROPERTY = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color|stop-color|flood-color|lighting-color)$/;

/** Space-role families for each spacing property, best first. */
function spacingFamilies(/** @type {string} */ property) {
  if (/^(padding|scroll-padding)/.test(property)) return ["space.inset"];
  if (/^margin-(inline|left|right)|^scroll-margin-(inline|left|right)/.test(property)) return ["space.inline"];
  if (/^margin-(block|top|bottom)|^scroll-margin-(block|top|bottom)/.test(property)) return ["space.stack"];
  if (/^(margin|scroll-margin)$/.test(property)) return ["space.stack", "space.inline"];
  if (property === "gap") return ["space.gap"];
  if (property === "column-gap") return ["space.gap", "space.inline"];
  if (property === "row-gap") return ["space.gap", "space.stack"];
  if (/^(inset|top|right|bottom|left)(-|$)/.test(property)) return ["space.inset", "space.inline", "space.stack"];
  return undefined;
}

/** Removes `url(...)` and quoted strings, which hold no colours or lengths to check. */
const stripOpaque = (/** @type {string} */ value) => value.replace(/url\([^)]*\)/gi, (m) => " ".repeat(m.length)).replace(/(["'])(?:\\.|(?!\1).)*\1/g, (m) => " ".repeat(m.length));

/**
 * @param {RuleName} name
 * @param {(decl: { prop: string; value: string }, emit: (message: string, word: string) => void, shared: Shared) => void} checkDeclaration
 */
function makePlugin(name, checkDeclaration) {
  const ruleName = `byterygon/${name}`;
  const messages = ruleMessages(ruleName, { rejected: (/** @type {string} */ message) => message });
  /** @type {import("stylelint").Rule} */
  const rule = (primary, secondary) => (root, result) => {
    const valid = validateOptions(result, ruleName, { actual: primary, possible: [true] }, { actual: secondary, possible: { theme: [(/** @type {unknown} */ v) => typeof v === "string"] }, optional: true });
    if (!valid) return;
    const context = shared(/** @type {{ theme?: string } | undefined} */ (secondary)?.theme);
    root.walkDecls((decl) => {
      checkDeclaration(decl, (message, word) => report({ ruleName, result, node: decl, message: messages.rejected(message), word }), context);
    });
    root.walkAtRules("apply", (atRule) => {
      for (const cls of classesIn(atRule.params.replace(/!important/g, ""))) {
        for (const finding of analyzeClass(cls, context)) {
          if (finding.rule === name) report({ ruleName, result, node: atRule, message: messages.rejected(`@apply ${finding.message}`), word: cls });
        }
      }
    });
  };
  rule.ruleName = ruleName;
  rule.messages = messages;
  rule.meta = { url: "https://github.com/byterygon/platform/tree/main/packages/lint#rules" };
  return createPlugin(ruleName, rule);
}

/** @typedef {{ catalog: import("./catalog.js").Catalog; palette: Map<string, import("@byterygon/design-tokens").Oklch> }} Shared */

/** @returns {Shared} */
function shared(/** @type {string | undefined} */ theme) {
  return { catalog: loadCatalog(theme), palette: tailwindPalette() };
}

const noRawColor = makePlugin("no-raw-color", (decl, emit, { catalog }) => {
  const property = decl.prop.toLowerCase();
  const named = COLOR_PROPERTY.test(property);
  for (const { text } of findRawColors(stripOpaque(decl.value), named)) {
    const color = parseCssColor(text);
    const picks = color ? nearestColors(color, catalog.colorRoles[groupOfProperty(property)], 2) : [];
    emit(`${decl.prop}: "${text}" is a raw colour. Use a colour role${picks.length > 0 ? `: ${picks.map((t) => `var(${t.cssVar}) (${t.path}, ${t.css["light"] ?? t.css["base"]} in light)`).join(", or ")}` : ""}; \`by-tokens search\` lists the others.`, text);
  }
});

const noOffScaleSpacing = makePlugin("no-off-scale-spacing", (decl, emit, { catalog }) => {
  const property = decl.prop.toLowerCase();
  const families = spacingFamilies(property);
  if (!families) return;
  // Lengths outside var() fallbacks; 0 and hairlines (1px) are not spacing.
  const value = stripOpaque(decl.value).replace(/var\([^()]*\)/g, (m) => " ".repeat(m.length));
  for (const m of value.matchAll(/(?<![\w.#-])-?(\d*\.?\d+)(px|rem|em)\b/g)) {
    const n = Number(m[1]);
    const px = m[2] === "px" ? n : n * 16;
    if (px <= 1) continue;
    const picks = nearestLengths(px, families, catalog);
    emit(`${decl.prop}: ${m[0]} is off the space scale. Use a space role: ${picks.map((t) => `var(${t.cssVar}) (${describeLength(t)})`).join(", or ")}.`, m[0]);
  }
});

const noArbitraryValue = makePlugin("no-arbitrary-value", () => {});

export default [noRawColor, noOffScaleSpacing, noArbitraryValue];
