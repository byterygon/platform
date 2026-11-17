// @ts-check
/**
 * ESLint plugin: the token rules for class names in TSX/JSX and TS (spec section 9a.4).
 *
 * Classes are read from `className`/`class` attributes, from the arguments of `cn`, `cva`, `clsx`,
 * `cx`, `twMerge`, `twJoin` and `tv` (strings, template literals, arrays, conditionals, object
 * keys and values, nested calls) and from variables named `*Class`, `*Classes`, `*ClassName`.
 * Raw colours in `style={{ ... }}` objects are reported too.
 *
 *   import byterygon from "@byterygon/lint/eslint";
 *   export default [...byterygon.configs.recommended];
 *
 * Settings: `settings.byterygon.theme` (a preset name or a theme file; default `default`),
 * `settings.byterygon.callees` and `settings.byterygon.attributes` (replace the lists above).
 */
import tsParser from "@typescript-eslint/parser";
import { loadCatalog, tailwindPalette } from "./catalog.js";
import { analyzeClass, classesIn, groupOfProperty } from "./classes.js";
import { findRawColors, nearestColors, parseCssColor } from "./colors.js";

/** @typedef {import("./classes.js").RuleName} RuleName */
/** @typedef {import("eslint").Rule.RuleModule} RuleModule */
/** @typedef {import("eslint").Rule.RuleContext} RuleContext */
/** @typedef {any} Node */

const CALLEES = ["cn", "cva", "clsx", "cx", "twMerge", "twJoin", "tv"];
const ATTRIBUTES = ["className", "class"];
const CLASS_VARIABLE = /(?:^|[a-z0-9])(?:Class|Classes|ClassName|ClassNames)$|^(?:class|classes|className|classNames)$/;
const DOCS = "https://github.com/byterygon/platform/tree/main/packages/lint#rules";

/** @type {Record<RuleName, string>} */
const DESCRIPTIONS = {
  "no-raw-color": "Forbid raw colours (hex, rgb(), oklch(), Tailwind palette classes such as bg-blue-500) where a colour role belongs.",
  "no-arbitrary-value": "Forbid arbitrary Tailwind values (p-[13px], max-h-[50dvh]) other than token variables, var(--by-...).",
  "no-off-scale-spacing": "Forbid raw steps of the space scale (p-2, gap-3, w-4); use the space and size roles.",
};

/**
 * One string of classes found in the source.
 * @typedef {object} ClassString
 * @property {Node} node     the Literal, TemplateLiteral quasi's parent, or JSX text node to report on
 * @property {string[]} classes
 * @property {boolean} replaceable  a plain string literal: suggestions can edit it
 */

/**
 * Collects the class strings of an expression.
 * @param {any} node
 * @param {ClassString[]} out
 * @param {Set<string>} callees
 * @param {boolean} [descendIntoCalls]  false inside attributes: the CallExpression visitor reads those
 */
function collect(node, out, callees, descendIntoCalls = true) {
  if (!node) return;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push({ node, classes: classesIn(node.value), replaceable: true });
      return;
    case "TemplateLiteral": {
      const quasis = node.quasis;
      quasis.forEach((/** @type {any} */ quasi, /** @type {number} */ i) => {
        const text = quasi.value.cooked ?? quasi.value.raw;
        let classes = classesIn(text);
        // A class touching `${...}` is only part of a name; skip it.
        if (i > 0 && !/^\s/.test(text)) classes = classes.slice(1);
        if (i < quasis.length - 1 && !/\s$/.test(text)) classes = classes.slice(0, -1);
        if (classes.length > 0) out.push({ node: quasi, classes, replaceable: false });
      });
      for (const expression of node.expressions) collect(expression, out, callees, descendIntoCalls);
      return;
    }
    case "JSXExpressionContainer":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "ChainExpression":
      collect(node.expression, out, callees, descendIntoCalls);
      return;
    case "ConditionalExpression":
      collect(node.consequent, out, callees, descendIntoCalls);
      collect(node.alternate, out, callees, descendIntoCalls);
      return;
    case "LogicalExpression":
      collect(node.left, out, callees, descendIntoCalls);
      collect(node.right, out, callees, descendIntoCalls);
      return;
    case "ArrayExpression":
      for (const element of node.elements) collect(element, out, callees, descendIntoCalls);
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.type !== "Property") continue;
        const value = property.value;
        const classy = ["Literal", "TemplateLiteral", "ArrayExpression", "ObjectExpression", "ConditionalExpression"].includes(value.type) && !(value.type === "Literal" && typeof value.value !== "string");
        if (classy) collect(value, out, callees, descendIntoCalls);
        else if (property.key.type === "Literal" && typeof property.key.value === "string") collect(property.key, out, callees, descendIntoCalls); // clsx({ "bg-x": on })
      }
      return;
    case "CallExpression":
      if (descendIntoCalls && callees.has(calleeName(node))) for (const argument of node.arguments) collect(argument, out, callees, true);
      return;
    default:
      return;
  }
}

function calleeName(/** @type {any} */ node) {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") return callee.property.name;
  return "";
}

/**
 * The shared analysis context of a file: the catalogue and Tailwind's palette.
 * @param {RuleContext} context
 */
function analysisContext(context) {
  const settings = /** @type {{ theme?: string }} */ (context.settings?.["byterygon"] ?? {});
  return { catalog: loadCatalog(settings.theme), palette: tailwindPalette(context.cwd) };
}

/**
 * Builds one rule: it reports the findings of `analyzeClass` that carry its name.
 * @param {RuleName} name
 * @returns {RuleModule}
 */
function makeRule(name) {
  return {
    meta: {
      type: "problem",
      hasSuggestions: true,
      docs: { description: DESCRIPTIONS[name], url: `${DOCS}` },
      schema: [],
      messages: { finding: "{{message}}", replace: "Replace with {{replacement}}" },
    },
    create(context) {
      const settings = /** @type {{ callees?: string[]; attributes?: string[] }} */ (context.settings?.["byterygon"] ?? {});
      const callees = new Set(settings.callees ?? CALLEES);
      const attributes = new Set(settings.attributes ?? ATTRIBUTES);
      /** @type {ReturnType<typeof analysisContext> | undefined} */
      let shared;
      const reported = new Set();

      const check = (/** @type {ClassString[]} */ strings) => {
        shared ??= analysisContext(context);
        for (const { node, classes, replaceable } of strings) {
          for (const cls of classes) {
            for (const finding of analyzeClass(cls, shared)) {
              if (finding.rule !== name) continue;
              const key = `${node.range?.[0]}:${finding.message}`;
              if (reported.has(key)) continue;
              reported.add(key);
              context.report({
                node,
                messageId: "finding",
                data: { message: finding.message },
                suggest: replaceable ? finding.suggestions.filter((s) => !s.startsWith("var(")).map((replacement) => ({
                  messageId: "replace",
                  data: { replacement },
                  fix: (fixer) => {
                    const source = context.sourceCode.getText(node);
                    const pattern = new RegExp(`(^|[\\s"'\`])${cls.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?=[\\s"'\`]|$)`);
                    return fixer.replaceText(node, source.replace(pattern, (_, before) => `${before}${replacement}`));
                  },
                })) : [],
              });
            }
          }
        }
      };

      return {
        JSXAttribute(/** @type {any} */ node) {
          const attribute = node.name.type === "JSXIdentifier" ? node.name.name : "";
          if (attributes.has(attribute)) {
            /** @type {ClassString[]} */
            const strings = [];
            collect(node.value, strings, callees, false);
            check(strings);
          } else if (attribute === "style" && name === "no-raw-color" && node.value?.type === "JSXExpressionContainer" && node.value.expression.type === "ObjectExpression") {
            shared ??= analysisContext(context);
            for (const property of node.value.expression.properties) {
              if (property.type !== "Property" || property.value.type !== "Literal" || typeof property.value.value !== "string") continue;
              const key = property.key.type === "Identifier" ? property.key.name : String(property.key.value ?? "");
              const cssProperty = key.replace(/[A-Z]/g, (/** @type {string} */ ch) => `-${ch.toLowerCase()}`);
              for (const { text } of findRawColors(property.value.value, /color|background|border|outline|fill|stroke|shadow/i.test(key))) {
                const color = parseCssColor(text);
                const picks = color ? nearestColors(color, shared.catalog.colorRoles[groupOfProperty(cssProperty)], 2) : [];
                context.report({
                  node: property.value,
                  messageId: "finding",
                  data: { message: `style ${key}: "${text}" is a raw colour. Use a colour role${picks.length > 0 ? `: var(${picks[0]?.cssVar}) (${picks[0]?.path}) is the nearest` : ""}, or a class such as bg-surface or text-fg-muted.` },
                });
              }
            }
          }
        },
        CallExpression(/** @type {any} */ node) {
          if (!callees.has(calleeName(node))) return;
          // Nested calls (`cn(cva(...))`) are visited on their own.
          /** @type {ClassString[]} */
          const strings = [];
          for (const argument of node.arguments) collect(argument, strings, new Set(), false);
          check(strings);
        },
        VariableDeclarator(/** @type {any} */ node) {
          if (node.id.type !== "Identifier" || !CLASS_VARIABLE.test(node.id.name) || !node.init) return;
          /** @type {ClassString[]} */
          const strings = [];
          collect(node.init, strings, callees, false);
          check(strings);
        },
      };
    },
  };
}

/**
 * `require-disable-reason`: a directive that turns off a byterygon rule names the rule and says
 * why after `--` (`// eslint-disable-next-line byterygon/no-arbitrary-value -- viewport cap, no token`),
 * and no directive turns off every rule at once.
 * @type {RuleModule}
 */
const requireDisableReason = {
  meta: {
    type: "suggestion",
    docs: { description: "Directives that disable a byterygon rule must name it and give a reason after --.", url: DOCS },
    schema: [],
    messages: {
      reason: "Say why {{rules}} {{verb}} off here: add \"-- <reason>\" to the directive (for example: -- a viewport cap, no token).",
      blanket: "This directive turns off every rule, the design-token rules included. Name the rules it is for, and give a reason after --.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const m = /^\s*eslint-disable(?:-next-line|-line)?(?:\s+([^]*))?$/.exec(comment.value);
          if (!m) continue;
          const [names = "", reason] = (m[1] ?? "").split(/\s--\s?/);
          const list = names.split(",").map((n) => n.trim()).filter(Boolean);
          if (list.length === 0) context.report({ loc: comment.loc ?? { line: 1, column: 0 }, messageId: "blanket" });
          else if (list.some((n) => n.startsWith("byterygon/")) && !reason?.trim()) {
            const ours = list.filter((n) => n.startsWith("byterygon/"));
            context.report({ loc: comment.loc ?? { line: 1, column: 0 }, messageId: "reason", data: { rules: ours.join(", "), verb: ours.length > 1 ? "are" : "is" } });
          }
        }
      },
    };
  },
};

const rules = {
  "require-disable-reason": requireDisableReason,
  "no-raw-color": makeRule("no-raw-color"),
  "no-arbitrary-value": makeRule("no-arbitrary-value"),
  "no-off-scale-spacing": makeRule("no-off-scale-spacing"),
};

/** @type {any} */
const plugin = { meta: { name: "@byterygon/lint", version: "0.0.0" }, rules, configs: {} };

/**
 * `recommended`: the four rules as errors on TS, TSX, JS and JSX files, parsed by
 * @typescript-eslint/parser.
 */
plugin.configs.recommended = [
  {
    name: "byterygon/recommended",
    files: ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true }, sourceType: "module" } },
    plugins: { byterygon: plugin },
    rules: { "byterygon/require-disable-reason": "error", "byterygon/no-raw-color": "error", "byterygon/no-arbitrary-value": "error", "byterygon/no-off-scale-spacing": "error" },
  },
];

export { rules };
export default plugin;
