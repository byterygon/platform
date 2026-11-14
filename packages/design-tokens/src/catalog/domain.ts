/**
 * Domain tokens (spec section 3, "Domain tiers"): what a database tool needs and a generic
 * system lacks. Code editors (`syntax.*`, `editor.*`), result grids (`data.*`, `grid.*`), charts
 * (`chart.*`) and diffs (`diff.*`).
 *
 * Every colour is a step of a ramp, so the contrast the ramp generator solves for carries over:
 * step 11 reads on the backgrounds of its own ramp and of the neutral one, step 8 is a 3:1 mark.
 * Their pairs are listed at the bottom and checked in both modes of every preset.
 */
import type { ContrastPair } from "../model.js";
import { type RoleDef, byDensity, pairs, ramp, ref } from "./authoring.js";

const color = (path: string, value: RoleDef["value"], use: string, avoid: string, tailwind?: string): RoleDef => ({
  path,
  type: "color",
  value,
  use,
  avoid,
  ...(tailwind ? { tailwind } : {}),
});

// ---------------------------------------------------------------------------------------------
// Syntax and editor

const SYNTAX: readonly (readonly [string, ReturnType<typeof ramp> | ReturnType<typeof ref>, string])[] = [
  ["keyword", ramp("violet", 11), "keywords: SELECT, FROM, function, return"],
  ["string", ramp("green", 11), "string and character literals"],
  ["number", ramp("orange", 11), "numeric literals"],
  ["comment", ramp("neutral", 10), "comments: they recede, but stay readable"],
  ["function", ramp("blue", 11), "function and method names, and calls"],
  ["operator", ramp("neutral", 11), "operators and punctuation: = + , ;"],
  ["type", ramp("teal", 11), "type names and built-in types: INTEGER, text, string"],
  ["identifier", ramp("neutral", 12), "table, column and variable names"],
  ["constant", ramp("amber", 11), "constants and special values: TRUE, NULL, CURRENT_DATE"],
  ["error", ramp("red", 11), "syntax errors and invalid tokens"],
];

const syntax: RoleDef[] = SYNTAX.map(([name, value, what]) =>
  color(
    `syntax.${name}`,
    value,
    `Editor text colour for ${what}. Monaco gets it as a hex value in the generated theme; CodeMirror reads the variable.`,
    "Not for interface text outside a code editor: use color.fg.* or text status colours.",
    `--color-syntax-${name}`,
  ),
);

const editor: RoleDef[] = [
  color("editor.bg", ref("color.bg.surface"), "Background of a code editor and of a code block.", "Not for the app background: use color.bg.canvas.", "--color-editor"),
  color("editor.fg", ref("color.fg.default"), "Default text colour inside a code editor, for text that has no syntax role.", "Not for syntax-highlighted tokens: use syntax.*.", "--color-editor-fg"),
  color(
    "editor.selection",
    ramp("brand", "a5", "a6"),
    "Background of selected text in a code editor (translucent, so the syntax colours stay readable).",
    "Not for a selected row or item: use color.interactive.selected.",
    "--color-editor-selection",
  ),
  color(
    "editor.line-highlight",
    ramp("neutral", "a2", "a3"),
    "Background of the line the cursor is on (translucent).",
    "Not for hover: use color.interactive.hover.",
    "--color-editor-line",
  ),
  color("editor.cursor", ref("color.fg.default"), "The text cursor (caret) of a code editor.", "Not for the focus ring: use color.ring.", "--color-editor-cursor"),
  color(
    "editor.gutter",
    ref("color.fg.subtle"),
    "Colour of the line numbers in the gutter of a code editor (text, not the gutter background, which is editor.bg).",
    "Not for other secondary text: use color.fg.muted.",
    "--color-editor-gutter",
  ),
  color(
    "editor.match",
    ramp("amber", "a5", "a6"),
    "Background behind search matches and the bracket that pairs with the one under the cursor (translucent).",
    "Not for the selection: use editor.selection.",
    "--color-editor-match",
  ),
];

// ---------------------------------------------------------------------------------------------
// Data types and the result grid

const DATA_TYPES: readonly (readonly [string, ReturnType<typeof ramp> | ReturnType<typeof ref>, string])[] = [
  ["integer", ramp("blue", 11), "integer columns and values"],
  ["decimal", ramp("teal", 11), "decimal, float and numeric columns and values"],
  ["text", ref("color.fg.default"), "text, varchar and char columns and values"],
  ["boolean", ramp("violet", 11), "boolean columns and values"],
  ["datetime", ramp("orange", 11), "date, time, timestamp and interval columns and values"],
  ["json", ramp("pink", 11), "json and jsonb columns and values"],
  ["binary", ramp("amber", 11), "bytea and blob columns and values"],
  ["uuid", ramp("brand", 11), "uuid columns and values"],
];

const dataTypes: RoleDef[] = [
  ...DATA_TYPES.map(([name, value, what]) =>
    color(
      `data.type.${name}`,
      value,
      `Colour of ${what}: cell text, type badges and column icons.`,
      "Not the only cue for a type: pair it with the type name or an icon, colour alone does not carry meaning.",
      `--color-type-${name}`,
    ),
  ),
  color(
    "data.null",
    ref("color.fg.subtle"),
    "Colour of NULL and of an empty value in a cell: it recedes without disappearing.",
    "Not for the text of an empty string, which is a value: use color.fg.default.",
    "--color-null",
  ),
];

const grid: RoleDef[] = [
  color("grid.header-bg", ref("color.bg.inset"), "Background of the header row of a result grid.", "Not for body rows: use grid.row-bg.", "--color-grid-header"),
  color("grid.row-bg", ref("color.bg.surface"), "Background of a body row of a result grid.", "Not for alternate rows: use grid.row-bg-alt.", "--color-grid-row"),
  color("grid.row-bg-alt", ramp("neutral", 2, 4), "Background of every other row when the grid is striped.", "Not for hover: use grid.row-hover.", "--color-grid-row-alt"),
  color("grid.row-hover", ref("color.interactive.hover"), "Wash over the row under the pointer (translucent).", "Not for a selected row: use grid.selection-bg.", "--color-grid-row-hover"),
  color("grid.cell-border", ref("color.border.default"), "The hairlines between cells and rows.", "Not the outline of the selected cell: use grid.selection-border.", "--color-grid-border"),
  color("grid.selection-bg", ref("color.interactive.selected"), "Wash over selected cells and rows (translucent).", "Not for hover: use grid.row-hover.", "--color-grid-selection"),
  color("grid.selection-border", ref("color.ring"), "The outline of the active cell and of a selected range.", "Not a cell separator: use grid.cell-border.", "--color-grid-selection-border"),
  color("grid.null-fg", ref("data.null"), "Text colour of NULL in a grid cell.", "Not for other muted text: use color.fg.muted.", "--color-grid-null"),
  {
    path: "grid.row-height",
    type: "dimension",
    tier: "component",
    value: byDensity(ref("size.control.md"), ref("size.control.sm")),
    tailwind: "--spacing-grid-row",
    use: "Height of a body row of a result grid: 36 px comfortable, 22 px compact, the same grid at two densities.",
    avoid: "Not the height of a form control: use size.control.*.",
  },
  {
    path: "grid.cell-padding-x",
    type: "dimension",
    tier: "component",
    value: ref("space.control.x"),
    tailwind: "--spacing-grid-cell-x",
    use: "Horizontal padding inside a grid cell: it follows the density mode.",
    avoid: "Not for padding of cards or panels: use space.inset.*.",
  },
];

// ---------------------------------------------------------------------------------------------
// Charts

/** Categorical series: hues spread around the wheel in the order of the Okabe-Ito set, at the 3:1 step. */
const CATEGORICAL = ["brand", "orange", "teal", "violet", "amber", "pink", "green", "neutral"];
const chartCat: RoleDef[] = CATEGORICAL.map((name, index) =>
  color(
    `chart.cat.${index + 1}`,
    ramp(name, 8),
    `Series ${index + 1} of a categorical chart: lines, bars and areas of unordered groups. It is the 3:1 step of the ${name} ramp, so it reads on every surface in both modes.`,
    "Not for ordered or diverging data (use chart.seq.* or chart.div.*), not for status meaning, and not as the only cue: add a label, shape or dash pattern.",
    `--color-chart-${index + 1}`,
  ),
);

/** Sequential: the brand ramp from its lightest tint to its darkest text step. */
const chartSeq: RoleDef[] = Array.from({ length: 9 }, (_, index) =>
  color(
    `chart.seq.${index + 1}`,
    ramp("brand", index + 3),
    `Step ${index + 1} of 9 of a sequential scale: heat maps and choropleths where the value goes from low to high. Light to strong in the light scheme; it brightens in the dark one.`,
    "Not for unordered groups (use chart.cat.*) or values that pass through a neutral midpoint (use chart.div.*).",
    `--color-chart-seq-${index + 1}`,
  ),
);

const DIVERGING: readonly (readonly [string, number])[] = [
  ["red", 10],
  ["red", 8],
  ["red", 6],
  ["red", 4],
  ["neutral", 4],
  ["blue", 4],
  ["blue", 6],
  ["blue", 8],
  ["blue", 10],
];
const chartDiv: RoleDef[] = DIVERGING.map(([name, step], index) =>
  color(
    `chart.div.${index + 1}`,
    ramp(name, step),
    `Step ${index + 1} of 9 of a diverging scale, strong red through a neutral midpoint (5) to strong blue: profit and loss, change against a baseline. Red and blue stay apart for colour-blind readers.`,
    "Not for data without a meaningful midpoint (use chart.seq.*), and not to mean good or bad: red here is only one end of the scale.",
    `--color-chart-div-${index + 1}`,
  ),
);

// ---------------------------------------------------------------------------------------------
// Diff

const DIFFS: readonly (readonly [string, string, string])[] = [
  ["add", "green", "added lines and characters"],
  ["remove", "red", "removed lines and characters"],
  ["change", "amber", "changed lines and characters"],
];
const diff: RoleDef[] = DIFFS.flatMap(([name, rampName, what]): RoleDef[] => [
  color(
    `diff.${name}.bg`,
    ramp(rampName, "a4", "a5"),
    `Background of ${what} in a diff (translucent, so the syntax colours on top stay readable).`,
    `Not for status messages: use color.status.*.bg. Pair it with diff.${name}.fg, a +/- marker or an icon.`,
    `--color-diff-${name}`,
  ),
  color(
    `diff.${name}.fg`,
    ramp(rampName, 11),
    `Text and marker colour for ${what} in a diff: the +/- sign, line numbers and a summary count.`,
    "Not for the code itself, which keeps its syntax colours.",
    `--color-diff-${name}-fg`,
  ),
]);

export const DOMAIN_ROLES: readonly RoleDef[] = [...syntax, ...editor, ...dataTypes, ...grid, ...chartCat, ...chartSeq, ...chartDiv, ...diff];

// ---------------------------------------------------------------------------------------------
// Contrast pairs

const SYNTAX_PATHS = SYNTAX.map(([name]) => `syntax.${name}`);
const TYPE_PATHS = [...DATA_TYPES.map(([name]) => `data.type.${name}`), "data.null"];
const ROWS = ["grid.row-bg", "grid.row-bg-alt"];
const SURFACES = ["color.bg.canvas", "color.bg.surface", "color.bg.raised", "color.bg.overlay", "color.bg.inset"];

export const DOMAIN_PAIRS: readonly ContrastPair[] = [
  // Code: every syntax colour on the editor and on the line the cursor is on.
  ...pairs("text", SYNTAX_PATHS, ["editor.bg"]),
  ...pairs("text", SYNTAX_PATHS, ["editor.line-highlight"], "editor.bg"),
  ...pairs("text", ["editor.fg", "editor.gutter"], ["editor.bg"]),
  ...pairs("text", ["editor.fg"], ["editor.selection", "editor.line-highlight", "editor.match"], "editor.bg"),
  ...pairs("text", ["editor.gutter"], ["editor.line-highlight"], "editor.bg"),
  ...pairs("ui", ["editor.cursor"], ["editor.bg"]),
  // Grid: text on the header and on both row backgrounds, and on the washes laid over a row.
  ...pairs("text", ["color.fg.default", "color.fg.muted"], ["grid.header-bg", ...ROWS]),
  ...pairs("text", TYPE_PATHS, ROWS),
  ...pairs("text", ["color.fg.default", "color.fg.muted"], ["grid.row-hover", "grid.selection-bg"], "grid.row-bg"),
  ...pairs("text", ["color.fg.default", "color.fg.muted"], ["grid.row-hover", "grid.selection-bg"], "grid.row-bg-alt"),
  ...pairs("ui", ["grid.selection-border"], ROWS),
  // Charts: a categorical mark must be visible on every surface (WCAG 1.4.11).
  ...pairs("ui", Array.from({ length: 8 }, (_, index) => `chart.cat.${index + 1}`), SURFACES),
  // Diff: its text on its own tint, and ordinary code text on the tint.
  ...DIFFS.flatMap(([name]) => [
    ...pairs("text", [`diff.${name}.fg`], [`diff.${name}.bg`], "color.bg.surface"),
    ...pairs("text", [`diff.${name}.fg`], [`diff.${name}.bg`], "color.bg.canvas"),
    ...pairs("text", ["color.fg.default"], [`diff.${name}.bg`], "color.bg.surface"),
  ]),
];
