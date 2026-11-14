/**
 * Platform outputs. Style Dictionary does the DTCG-to-platform work (reference resolution, the
 * name and value transforms, and the formats that write each file); this module registers those
 * transforms and formats and runs it, in memory, once per mode combination.
 *
 *   tokens.css            every token as a `--by-` custom property, with one block per mode
 *   tailwind-theme.css    Tailwind v4 `@theme inline` names for the roles
 *   shadcn-alias.css      the variable names stock shadcn/ui components read
 *   tokens.ts             typed constants: path, CSS variable, description, resolved values
 *   tokens.dtcg.json      the token set itself, as a DTCG document
 *   figma-variables.json  Figma variable collections and modes
 *
 * Nothing is written to disk here and nothing is read: the caller gets file contents.
 */
import StyleDictionary from "style-dictionary";
import type { TransformedToken } from "style-dictionary/types";

import { hexToRgb } from "./color/index.js";
import { toDtcg, tokenTree } from "./dtcg.js";
import {
  type Alias,
  type Axis,
  type ColorValue,
  type DimensionValue,
  type DurationValue,
  type ModeContext,
  type ShadowLayer,
  type Token,
  type TokenSet,
  type TokenType,
  type TokenValue,
  aliasTarget,
  isAlias,
} from "./model.js";
import { allContexts, defaultContext, dependentAxes, valueIn } from "./resolve.js";
import { round, stableJson } from "./util.js";
import { aliasesIn, cssValue, cssVarName } from "./values.js";

export const OUTPUT_FILES = [
  "tokens.css",
  "tailwind-theme.css",
  "shadcn-alias.css",
  "tokens.ts",
  "tokens.dtcg.json",
  "figma-variables.json",
] as const;
export type OutputFile = (typeof OUTPUT_FILES)[number];

/** Short names the CLI's `export` command accepts. */
export const OUTPUT_ALIASES: Readonly<Record<string, OutputFile>> = {
  css: "tokens.css",
  tailwind: "tailwind-theme.css",
  shadcn: "shadcn-alias.css",
  ts: "tokens.ts",
  dtcg: "tokens.dtcg.json",
  figma: "figma-variables.json",
};

const contextKey = (context: ModeContext, axes: readonly Axis[]) => axes.map((axis) => context[axis.name]).join("/");
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const pathOf = (token: TransformedToken) => token.path.join(".");

// ---------------------------------------------------------------------------------------------
// Transforms

/** CSS text of a literal. Tokens that alias another token take the target's transformed value. */
function cssTransform(token: TransformedToken): unknown {
  const value = token.$value as TokenValue;
  // Already CSS text: an alias that resolved to a transformed token.
  if (typeof value === "string" && token.$type !== "fontFamily" && token.$type !== "fontWeight") return value;
  return cssValue(token.$type as TokenType, value);
}

/** Shadows are composites whose fields may be aliases, so this one runs after references resolve. */
function cssShadowTransform(token: TransformedToken): unknown {
  const value = token.$value as unknown;
  if (typeof value === "string") return value;
  return (value as readonly ShadowLayer[])
    .map((layer) => {
      const part = (field: unknown) => (typeof field === "string" ? field : cssValue("dimension", field as DimensionValue));
      const color = typeof layer.color === "string" ? layer.color : cssValue("color", layer.color);
      return `${layer.inset ? "inset " : ""}${part(layer.offsetX)} ${part(layer.offsetY)} ${part(layer.blur)} ${part(layer.spread)} ${color}`;
    })
    .join(", ");
}

type FigmaValue = number | string | { r: number; g: number; b: number; a: number };
const FIGMA_TYPE: Partial<Record<TokenType, "COLOR" | "FLOAT" | "STRING">> = {
  color: "COLOR",
  dimension: "FLOAT",
  number: "FLOAT",
  duration: "FLOAT",
  fontFamily: "STRING",
  fontWeight: "FLOAT",
};

/** Figma variable value of a literal: sRGB colour, a number (px, ms) or a string. */
function figmaTransform(token: TransformedToken): unknown {
  const value = token.$value as unknown;
  switch (token.$type as TokenType) {
    case "color": {
      if (typeof value !== "object" || value === null || !("hex" in value)) return value;
      const color = value as ColorValue;
      const rgb = hexToRgb(color.hex)!;
      return { r: round(rgb.r, 4), g: round(rgb.g, 4), b: round(rgb.b, 4), a: color.alpha ?? 1 };
    }
    case "dimension": {
      if (typeof value !== "object" || value === null || !("unit" in value)) return value;
      const dimension = value as DimensionValue;
      return dimension.unit === "rem" ? dimension.value * 16 : dimension.value;
    }
    case "duration": {
      if (typeof value !== "object" || value === null || !("unit" in value)) return value;
      const duration = value as DurationValue;
      return duration.unit === "s" ? duration.value * 1000 : duration.value;
    }
    case "fontFamily":
      return Array.isArray(value) ? value[0] : value;
    default:
      return value;
  }
}

// ---------------------------------------------------------------------------------------------
// One Style Dictionary run per mode combination

interface Transformed {
  /** token path -> CSS text of its resolved value. */
  readonly css: ReadonlyMap<string, string>;
  /** token path -> Figma value of its resolved value. */
  readonly figma: ReadonlyMap<string, unknown>;
}

type Formats = Record<string, (args: { dictionary: { allTokens: TransformedToken[] } }) => unknown>;

function dictionaryFor(set: TokenSet, context: ModeContext, formats: Formats, files: Record<"css" | "figma", { destination: string; format: string }[]>) {
  return new StyleDictionary(
    {
      tokens: tokenTree(set, context) as Record<string, never>,
      log: { verbosity: "silent", warnings: "disabled" },
      hooks: {
        transforms: {
          "by/name/css-var": { type: "name", transform: (token) => cssVarName(pathOf(token)) },
          "by/name/figma": { type: "name", transform: (token) => token.path.join("/") },
          "by/value/css": { type: "value", filter: (token) => token.$type !== "shadow", transform: cssTransform },
          "by/value/css-shadow": {
            type: "value",
            transitive: true,
            filter: (token) => token.$type === "shadow",
            transform: cssShadowTransform,
          },
          "by/value/figma": { type: "value", transform: figmaTransform },
        },
        formats: formats as never,
      },
      platforms: {
        css: { transforms: ["by/name/css-var", "by/value/css", "by/value/css-shadow"], files: files.css },
        figma: { transforms: ["by/name/figma", "by/value/figma"], files: files.figma },
      },
    },
    { verbosity: "silent", warnings: "disabled" },
  );
}

async function transformContext(set: TokenSet, context: ModeContext): Promise<Transformed> {
  const collect: Formats = {
    "by/collect": ({ dictionary }) => dictionary.allTokens.map((token) => [pathOf(token), token.$value] as const),
  };
  const sd = dictionaryFor(set, context, collect, {
    css: [{ destination: "css", format: "by/collect" }],
    figma: [{ destination: "figma", format: "by/collect" }],
  });
  await sd.hasInitialized;
  const read = async (platform: "css" | "figma") => {
    const [file] = await sd.formatPlatform(platform);
    return new Map(file!.output as [string, unknown][]);
  };
  return { css: (await read("css")) as Map<string, string>, figma: await read("figma") };
}

// ---------------------------------------------------------------------------------------------
// Formats

interface FormatInput {
  readonly set: TokenSet;
  readonly source: string;
  /** Transformed values per mode combination, keyed by `contextKey`. */
  readonly transformed: ReadonlyMap<string, Transformed>;
}

/** The context in which `axis` is in `mode` and every other axis is at its default. */
function contextWith(set: TokenSet, axis?: string, mode?: string): ModeContext {
  const context = defaultContext(set);
  return axis && mode ? { ...context, [axis]: mode } : context;
}

function selectorsFor(axis: Axis, mode: string): string[] {
  return [
    ...(mode === axis.default ? [":root"] : []),
    `[${axis.attribute}="${mode}"]`,
    ...(axis.selectors?.[mode] ?? []),
  ];
}

/** Default mode first, so the later blocks win when both match the same element. */
function modesInOrder(axis: Axis): string[] {
  return [axis.default, ...axis.modes.filter((mode) => mode !== axis.default)];
}

function header(input: FormatInput, lines: readonly string[]): string {
  return [
    "/*",
    ` * Byterygon design tokens, theme "${input.set.name}".`,
    ` * Generated by by-tokens from ${input.source}. Do not edit: change the theme file or the`,
    " * catalogue and run `by-tokens build`.",
    ...lines.map((line) => (line ? ` * ${line}` : " *")),
    " */",
  ].join("\n");
}

function formatTokensCss(input: FormatInput): string {
  const { set } = input;
  const transformedIn = (context: ModeContext) => input.transformed.get(contextKey(context, set.axes))!;
  const asVar = (alias: Alias) => `var(${cssVarName(aliasTarget(alias))})`;
  /** The declaration of a token in a context: SD's transformed literal, or `var()` for aliases. */
  const declaration = (token: Token, context: ModeContext): string => {
    const own = valueIn(token, context)!;
    const value = aliasesIn(own).length > 0 ? cssValue(token.type, own, asVar) : transformedIn(context).css.get(token.path)!;
    return `  ${cssVarName(token.path)}: ${value};`;
  };
  const tokens = [...set.tokens.values()];
  const axesOf = new Map(tokens.map((token) => [token.path, dependentAxes(set, token.path)]));

  const blocks: string[] = [
    header(input, [
      "",
      "Primitives are declared once on :root. Roles are declared per mode and point at primitives,",
      "so a mode switch needs no rebuild: set the attribute on any element.",
      ...set.axes.map((axis) => `  ${axis.attribute}: ${axis.modes.join(" | ")} (default ${axis.default})`),
      "Components use the semantic and component tiers only, never a primitive.",
    ]),
  ];

  const section = (title: string, selectors: readonly string[], lines: readonly string[]) => {
    if (lines.length === 0) return;
    blocks.push(`/* ${title} */\n${selectors.join(",\n")} {\n${lines.join("\n")}\n}`);
  };

  const base = defaultContext(set);
  section(
    "Primitive tier: raw scales.",
    [":root"],
    tokens.filter((token) => token.tier === "primitive").map((token) => declaration(token, base)),
  );
  section(
    "Roles that are the same in every mode.",
    [":root"],
    tokens.filter((token) => token.tier !== "primitive" && axesOf.get(token.path)!.size === 0).map((token) => declaration(token, base)),
  );
  for (const axis of set.axes) {
    const dependents = tokens.filter((token) => token.tier !== "primitive" && axesOf.get(token.path)!.has(axis.name));
    for (const mode of modesInOrder(axis)) {
      const scheme = axis.colorScheme?.[mode];
      section(`Roles, ${axis.name}: ${mode}${mode === axis.default ? " (default)" : ""}.`, selectorsFor(axis, mode), [
        ...(scheme ? [`  color-scheme: ${scheme};`] : []),
        ...dependents.map((token) => declaration(token, contextWith(set, axis.name, mode))),
      ]);
    }
  }
  return `${blocks.join("\n\n")}\n`;
}

function formatTailwindTheme(input: FormatInput): string {
  const { set } = input;
  const lines: string[] = [];
  let group = "";
  for (const token of set.tokens.values()) {
    if (!token.tailwind) continue;
    const next = token.tailwind.slice(2).split("-")[0]!;
    if (group && next !== group) lines.push("");
    group = next;
    lines.push(`  ${token.tailwind}: var(${cssVarName(token.path)});`);
    for (const alias of token.tailwindAliases ?? []) lines.push(`  ${alias}: var(${cssVarName(token.path)});`);
  }
  const variants = set.axes.flatMap((axis) =>
    axis.modes
      .filter((mode) => axis.colorScheme?.[mode] === "dark")
      .map((mode) => {
        const selectors = [`[${axis.attribute}="${mode}"]`, ...(axis.selectors?.[mode] ?? [])];
        return `@custom-variant ${mode} (&:where(${selectors.flatMap((s) => [s, `${s} *`]).join(", ")}));`;
      }),
  );
  return [
    header(input, [
      "",
      "Tailwind v4 theme: utility names for the token roles (bg-surface, text-fg-muted,",
      "border-border, h-control-md, rounded-md). `inline` keeps the utilities pointing at the CSS",
      "variables, so a mode or density switch needs no rebuild. Import after tokens.css.",
    ]),
    "",
    ...variants,
    "",
    "@theme inline {",
    ...lines,
    "}",
    "",
  ].join("\n");
}

function formatShadcnAlias(input: FormatInput): string {
  const { set } = input;
  // An alias must be declared again wherever the role it points at changes, or a nested scope
  // would inherit the value computed for the outer one.
  const axes = new Set<string>();
  for (const path of Object.values(set.shadcn)) for (const axis of dependentAxes(set, path)) axes.add(axis);
  const selectors = [
    ":root",
    ...set.axes
      .filter((axis) => axes.has(axis.name))
      .flatMap((axis) => axis.modes.flatMap((mode) => selectorsFor(axis, mode).filter((selector) => selector !== ":root"))),
  ];
  return [
    header(input, [
      "",
      "Maps Byterygon roles to the variable names stock shadcn/ui components read, so any shadcn",
      "component or third-party registry item works unchanged under a Byterygon theme.",
    ]),
    "",
    `${selectors.join(",\n")} {`,
    ...Object.entries(set.shadcn).map(([variable, path]) => `  ${variable}: var(${cssVarName(path)});`),
    "}",
    "",
  ].join("\n");
}

/** The modes a token's resolved value differs by, as `key -> context`. `base` when it does not vary. */
function variants(set: TokenSet, path: string): { key: string; context: ModeContext }[] {
  const axes = set.axes.filter((axis) => dependentAxes(set, path).has(axis.name));
  if (axes.length === 0) return [{ key: "base", context: defaultContext(set) }];
  let combos: { key: string[]; context: Record<string, string> }[] = [{ key: [], context: { ...defaultContext(set) } }];
  for (const axis of axes) {
    combos = combos.flatMap((combo) =>
      axis.modes.map((mode) => ({ key: [...combo.key, mode], context: { ...combo.context, [axis.name]: mode } })),
    );
  }
  return combos.map((combo) => ({ key: combo.key.join("/"), context: combo.context }));
}

function formatTokensTs(input: FormatInput): string {
  const { set } = input;
  const entries: string[] = [];
  for (const token of set.tokens.values()) {
    const values = variants(set, token.path).map(
      ({ key, context }) => `${JSON.stringify(key)}: ${JSON.stringify(input.transformed.get(contextKey(context, set.axes))!.css.get(token.path))}`,
    );
    entries.push(
      [
        `  ${JSON.stringify(token.path)}: {`,
        `    cssVar: ${JSON.stringify(cssVarName(token.path))},`,
        `    type: ${JSON.stringify(token.type)},`,
        `    tier: ${JSON.stringify(token.tier)},`,
        `    description: ${JSON.stringify(token.description)},`,
        `    values: { ${values.join(", ")} },`,
        "  },",
      ].join("\n"),
    );
  }
  const axes = set.axes.map(
    (axis) => `    ${axis.name}: { attribute: ${JSON.stringify(axis.attribute)}, modes: ${JSON.stringify(axis.modes)}, default: ${JSON.stringify(axis.default)} },`,
  );
  return [
    header(input, [
      "",
      "Typed constants for code that cannot use CSS variables directly (canvas, editors, tests).",
      "`values` holds the resolved CSS value per mode: `base` when the token does not vary, the mode",
      "name when it varies along one axis.",
    ]),
    "",
    "export const theme = {",
    `  name: ${JSON.stringify(set.name)},`,
    "  axes: {",
    ...axes,
    "  },",
    "} as const;",
    "",
    "export const tokens = {",
    ...entries,
    "} as const;",
    "",
    "/** Dot path of a token, for example `color.bg.surface`. */",
    "export type TokenPath = keyof typeof tokens;",
    "",
    "/** `var(--by-...)` for a token, for inline styles. Prefer the Tailwind utilities in components. */",
    "export function cssVar(path: TokenPath): string {",
    "  return `var(${tokens[path].cssVar})`;",
    "}",
    "",
  ].join("\n");
}

function formatFigmaVariables(input: FormatInput): string {
  const { set } = input;
  interface Variable {
    name: string;
    type: string;
    description: string;
    scopes: string[];
    hiddenFromPublishing: boolean;
    codeSyntax: { WEB: string };
    valuesByMode: Record<string, unknown>;
  }
  interface Collection {
    name: string;
    modes: string[];
    defaultMode: string;
    variables: Variable[];
  }
  const collections: Collection[] = [
    { name: "Primitives", modes: ["Value"], defaultMode: "Value", variables: [] },
    { name: "Semantic", modes: ["Value"], defaultMode: "Value", variables: [] },
    ...set.axes.map((axis) => ({
      name: capitalize(axis.name),
      modes: axis.modes.map(capitalize),
      defaultMode: capitalize(axis.default),
      variables: [],
    })),
  ];
  const skipped: { token: string; reason: string }[] = [];
  const placement = new Map<string, { collection: Collection; axis?: Axis }>();

  for (const token of set.tokens.values()) {
    if (!FIGMA_TYPE[token.type]) {
      skipped.push({ token: token.path, reason: `Figma has no variable type for ${token.type}; create a style instead` });
      continue;
    }
    const axes = set.axes.filter((axis) => dependentAxes(set, token.path).has(axis.name));
    if (axes.length > 1) {
      skipped.push({ token: token.path, reason: "depends on more than one mode axis; a Figma collection has one set of modes" });
    } else if (token.tier === "primitive") {
      placement.set(token.path, { collection: collections[0]! });
    } else if (axes.length === 0) {
      placement.set(token.path, { collection: collections[1]! });
    } else {
      placement.set(token.path, { collection: collections.find((c) => c.name === capitalize(axes[0]!.name))!, axis: axes[0]! });
    }
  }

  for (const [path, { collection, axis }] of placement) {
    const token = set.tokens.get(path)!;
    const valuesByMode: Record<string, unknown> = {};
    const modes = axis ? axis.modes.map((mode) => ({ label: capitalize(mode), context: contextWith(set, axis.name, mode) })) : [{ label: "Value", context: defaultContext(set) }];
    for (const { label, context } of modes) {
      const own = valueIn(token, context)!;
      const target = isAlias(own) ? placement.get(aliasTarget(own)) : undefined;
      valuesByMode[label] = target
        ? { type: "VARIABLE_ALIAS", collection: target.collection.name, name: aliasTarget(own as Alias).split(".").join("/") }
        : (input.transformed.get(contextKey(context, set.axes))!.figma.get(path) as FigmaValue);
    }
    collection.variables.push({
      name: path.split(".").join("/"),
      type: FIGMA_TYPE[token.type]!,
      description: token.description,
      scopes: token.tier === "primitive" ? [] : ["ALL_SCOPES"],
      hiddenFromPublishing: token.tier === "primitive",
      codeSyntax: { WEB: `var(${cssVarName(path)})` },
      valuesByMode,
    });
  }

  return stableJson({
    format: "byterygon.figma-variables",
    version: 1,
    theme: set.name,
    generatedFrom: input.source,
    note: "Variable collections, modes and values in the shape of the Figma Variables API. Colours are sRGB 0..1, dimensions are px. Primitives have no scopes so they stay out of the pickers.",
    collections: collections.filter((collection) => collection.variables.length > 0),
    skipped,
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * Renders every output for a token set that has passed validation.
 * `source` names the theme file in the generated headers.
 */
export async function renderOutputs(set: TokenSet, source: string): Promise<Map<OutputFile, string>> {
  const transformed = new Map<string, Transformed>();
  for (const context of allContexts(set)) transformed.set(contextKey(context, set.axes), await transformContext(set, context));
  const input: FormatInput = { set, source, transformed };

  const sd = dictionaryFor(
    set,
    defaultContext(set),
    {
      "by/css/tokens": () => formatTokensCss(input),
      "by/css/tailwind-theme": () => formatTailwindTheme(input),
      "by/css/shadcn-alias": () => formatShadcnAlias(input),
      "by/ts/tokens": () => formatTokensTs(input),
      "by/json/dtcg": () => stableJson(toDtcg(set)),
      "by/json/figma-variables": () => formatFigmaVariables(input),
    },
    {
      css: [
        { destination: "tokens.css", format: "by/css/tokens" },
        { destination: "tailwind-theme.css", format: "by/css/tailwind-theme" },
        { destination: "shadcn-alias.css", format: "by/css/shadcn-alias" },
        { destination: "tokens.ts", format: "by/ts/tokens" },
        { destination: "tokens.dtcg.json", format: "by/json/dtcg" },
      ],
      figma: [{ destination: "figma-variables.json", format: "by/json/figma-variables" }],
    },
  );
  await sd.hasInitialized;
  const rendered = new Map<string, string>();
  for (const platform of ["css", "figma"]) {
    for (const file of await sd.formatPlatform(platform)) rendered.set(file.destination as string, file.output as string);
  }
  return new Map(OUTPUT_FILES.map((name) => [name, rendered.get(name)!]));
}
