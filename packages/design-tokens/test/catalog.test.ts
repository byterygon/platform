import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildTheme } from "../src/build.js";
import { generateTokens } from "../src/generate.js";
import type { ThemeFile } from "../src/model.js";
import { resolve } from "../src/resolve.js";
import { validate } from "../src/validate.js";
import { ROOT, defaultTheme, themeWith } from "./helpers.js";

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/** Every token the spec names in section 3, "Token catalogue" (the Notion spec, DOC-17). */
function specTokens(): string[] {
  const paths: string[] = [];
  const add = (prefix: string, names: readonly (string | number)[]) => names.forEach((name) => paths.push(`${prefix}.${name}`));
  // Primitive tier.
  for (const ramp of ["neutral", "brand", "red", "amber", "green", "blue"]) {
    add(`color.${ramp}`, range(1, 12));
    add(`color.${ramp}`, range(1, 12).map((step) => `a${step}`));
    add(`color.${ramp}-dark`, range(1, 12));
  }
  add("color.black", range(1, 12).map((step) => `a${step}`));
  add("color.white", range(1, 12).map((step) => `a${step}`));
  paths.push("color.base.black", "color.base.white");
  add("space", [0, "0-5", 1, "1-5", 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24]);
  add("font.size", ["2xs", "xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl"]);
  add("font.weight", ["regular", "medium", "semibold", "bold"]);
  add("font.leading", ["tight", "snug", "normal", "relaxed"]);
  add("font.tracking", ["tight", "normal", "wide"]);
  paths.push("font.sans", "font.mono"); // spec: font.family.{sans,mono}; see the open questions
  add("radius", ["none", "xs", "sm", "md", "lg", "xl", "full"]);
  add("border.width", [0, 1, 2]);
  add("shadow", range(0, 5));
  add("motion.duration", ["instant", "fast", "base", "slow"]);
  add("motion.easing", ["standard", "enter", "exit", "emphasized"]);
  add("z", ["base", "sticky", "dropdown", "overlay", "modal", "popover", "toast", "tooltip"]);
  add("breakpoint", ["sm", "md", "lg", "xl", "2xl"]);
  add("opacity", ["disabled", "hover", "overlay"]);
  add("size.icon", ["xs", "sm", "md", "lg"]);
  // Semantic tier.
  add("color.bg", ["canvas", "surface", "raised", "overlay", "inset", "scrim"]);
  add("color.fg", ["default", "muted", "subtle", "disabled", "link", "on-accent"]); // on-status: see the open questions
  add("color.border", ["default", "muted", "strong", "focus"]);
  add("ring", ["width", "offset", "color"]);
  for (const group of ["accent", "neutral"]) add(`color.${group}`, ["bg", "bg-hover", "bg-active", "fg", "subtle-bg", "subtle-fg"]);
  for (const status of ["danger", "warning", "success", "info"]) add(`color.status.${status}`, ["bg", "border", "fg", "solid", "solid-fg"]);
  add("color.interactive", ["hover", "active", "selected", "selected-hover", "drag"]);
  add("size.control", ["xs", "sm", "md", "lg"]);
  for (const family of ["inline", "stack", "inset", "gap"]) add(`space.${family}`, ["xs", "sm", "md", "lg", "xl"]);
  for (const role of ["display", "heading-1", "heading-2", "heading-3", "heading-4", "body", "body-strong", "label", "caption", "code", "code-sm"]) {
    add(`text.${role}`, ["family", "size", "weight", "leading", "tracking"]);
  }
  for (const level of ["flat", "raised", "overlay", "modal"]) add(`elevation.${level}`, ["shadow", "border", "bg"]);
  // Domain tiers.
  add("syntax", ["keyword", "string", "number", "comment", "function", "operator", "type", "identifier", "constant", "error"]);
  add("editor", ["bg", "fg", "selection", "line-highlight", "cursor", "gutter", "match"]);
  add("data.type", ["integer", "decimal", "text", "boolean", "datetime", "json", "binary", "uuid"]);
  paths.push("data.null");
  add("grid", ["header-bg", "row-bg", "row-bg-alt", "row-hover", "cell-border", "selection-bg", "selection-border", "null-fg", "row-height", "cell-padding-x"]);
  add("chart.cat", range(1, 8));
  add("chart.seq", range(1, 9));
  add("chart.div", range(1, 9));
  for (const kind of ["add", "remove", "change"]) add(`diff.${kind}`, ["bg", "fg"]);
  return paths;
}

test("every token in spec section 3 exists with a description", () => {
  const { set } = generateTokens(defaultTheme());
  const missing = specTokens().filter((path) => !set.tokens.has(path));
  assert.deepEqual(missing, []);
  for (const path of specTokens()) assert.ok(set.tokens.get(path)!.description.length >= 30, path);
});

test("the contract the first components were written against is only added to", () => {
  // Every role name TSK-42 pins (outputs.test.ts) plus the Tailwind names and shadcn aliases.
  const { set } = generateTokens(defaultTheme());
  const pinned: Record<string, string> = {
    "color.bg.canvas": "--color-canvas",
    "color.bg.surface": "--color-surface",
    "color.fg.muted": "--color-fg-muted",
    "color.interactive.active": "--color-pressed",
    "color.status.danger.bg": "--color-danger-subtle",
    "color.status.danger.solid": "--color-danger",
    "radius.md": "--radius-md",
    "size.control.md": "--spacing-control-md",
    "shadow.raised": "--shadow-raised",
    "space.control.x": "--spacing-control-x",
    "font.sans": "--font-sans",
    "font.mono": "--font-mono",
  };
  for (const [path, tailwind] of Object.entries(pinned)) assert.equal(set.tokens.get(path)?.tailwind, tailwind, path);
});

test("text roles are five tokens each, and they point at the scales", () => {
  const { set } = generateTokens(defaultTheme());
  const body = ["family", "size", "weight", "leading", "tracking"].map((field) => set.tokens.get(`text.body.${field}`)!);
  assert.deepEqual(body.map((token) => token.type), ["fontFamily", "dimension", "fontWeight", "number", "dimension"]);
  assert.deepEqual(body.map((token) => token.value), ["{font.sans}", "{font.size.base}", "{font.weight.regular}", "{font.leading.normal}", "{font.tracking.normal}"]);
  assert.equal(set.tokens.get("text.code.family")!.value, "{font.mono}");
  const context = { theme: "light", density: "comfortable" };
  const size = resolve(set, "text.body.size", context);
  assert.deepEqual(size.ok && size.value, { value: 14, unit: "px" });
  // The type scale is derived from the fontSize seed.
  const dense = generateTokens(themeWith({}, { fontSize: 13 })).set;
  const base = resolve(dense, "font.size.base", context);
  const big = resolve(dense, "font.size.4xl", context);
  assert.deepEqual([base.ok && base.value, big.ok && big.value], [{ value: 13, unit: "px" }, { value: 29, unit: "px" }]);
});

test("size and space follow the density axis; shadows and colours follow the theme axis; nothing follows both", () => {
  const { set } = generateTokens(defaultTheme());
  const axisOf = (path: string) => set.tokens.get(path)!.axis;
  assert.equal(axisOf("space.inset.md"), "density");
  assert.equal(axisOf("space.stack.xl"), "density");
  assert.equal(axisOf("size.control.sm"), "density");
  assert.equal(axisOf("shadow.3"), "theme");
  assert.equal(axisOf("color.bg.surface"), "theme");
  assert.equal(axisOf("elevation.overlay.shadow"), undefined, "an alias to a themed shadow is themed through the alias, not by its own modes");
  const { diagnostics } = validate(set);
  assert.deepEqual(diagnostics.filter((d) => d.rule === "mode-cross-axis"), []);

  const compact = { theme: "light", density: "compact" };
  const comfortable = { theme: "light", density: "comfortable" };
  const row = (context: Record<string, string>) => {
    const value = resolve(set, "grid.row-height", context);
    return value.ok ? value.value : undefined;
  };
  assert.deepEqual(row(comfortable), { value: 36, unit: "px" });
  assert.deepEqual(row(compact), { value: 22, unit: "px" });
  // Compact is never looser than comfortable.
  for (const family of ["inline", "stack", "inset", "gap"]) {
    for (const step of ["xs", "sm", "md", "lg", "xl"]) {
      const a = resolve(set, `space.${family}.${step}`, comfortable);
      const b = resolve(set, `space.${family}.${step}`, compact);
      assert.ok(a.ok && b.ok && (b.value as { value: number }).value < (a.value as { value: number }).value, `space.${family}.${step}`);
    }
  }
});

test("every shadow is a list of layers, and dark themes lift with a ring rather than a heavier shadow", () => {
  const { set } = generateTokens(defaultTheme());
  for (const index of range(0, 5)) {
    for (const theme of ["light", "dark"]) {
      const shadow = resolve(set, `shadow.${index}`, { theme, density: "comfortable" });
      assert.ok(shadow.ok && Array.isArray(shadow.value) && shadow.value.length > 0, `shadow.${index} ${theme}`);
    }
  }
  const dark = resolve(set, "shadow.1", { theme: "dark", density: "comfortable" });
  assert.ok(dark.ok && (dark.value as unknown as { spread: { value: number } }[])[0]!.spread.value === 1, "a 1 px ring");
});

// ---------------------------------------------------------------------------------------------
// Presets

const presets = readdirSync(join(ROOT, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => JSON.parse(readFileSync(join(ROOT, "themes", file), "utf8")) as ThemeFile);

for (const preset of presets) {
  test(`preset ${preset.name}: no findings, and every contrast pair passes in both modes and both densities`, async () => {
    const result = await buildTheme(preset, { render: false });
    assert.deepEqual(result.diagnostics, []);
    const aaa = preset.name === "high-contrast";
    assert.deepEqual([result.set.contrast.level, result.set.contrast.text, result.set.contrast.ui], aaa ? ["AAA", 7, 4.5] : ["AA", 4.5, 3]);
    assert.ok(result.contrast.length > 300);
    assert.ok(result.contrast.every((m) => m.pass));
    assert.deepEqual([...new Set(result.contrast.map((m) => m.mode["theme"]))].sort(), ["dark", "light"]);
    // Colour roles do not depend on density, so a pair holds in both densities by construction.
    const { set } = result;
    for (const pair of set.pairs) {
      for (const path of [pair.fg, pair.bg]) {
        const token = set.tokens.get(path)!;
        assert.notEqual(token.axis, "density", `${path} must not vary by density: a contrast pair would then need a density context`);
      }
    }
  });
}

test("the presets differ in the ways their names promise", async () => {
  const byName = new Map(presets.map((preset) => [preset.name, generateTokens(preset)]));
  const value = (name: string, path: string, context: Record<string, string> = { theme: "light", density: "comfortable" }) => {
    const resolved = resolve(byName.get(name)!.set, path, context);
    assert.ok(resolved.ok, path);
    return resolved.value;
  };
  const chroma = (name: string, path: string, theme: string) => (value(name, path, { theme, density: "comfortable" }) as unknown as { components: number[] }).components[1]!;
  // Paper is warm: its backgrounds carry a visible tint. Default and Slate are almost grey.
  assert.ok(chroma("paper", "color.bg.canvas", "light") > 0.005);
  assert.ok(chroma("default", "color.bg.canvas", "light") < 0.002);
  assert.ok(chroma("slate", "color.bg.canvas", "light") < 0.002);
  // Midnight: dark first, with a deep blue background.
  assert.equal(byName.get("midnight")!.seeds.colorScheme, "dark");
  assert.ok(chroma("midnight", "color.bg.canvas", "dark") > 0.02);
  // Terminal: dense, monospace everywhere, 13 px.
  assert.equal(byName.get("terminal")!.seeds.density, "compact");
  assert.equal((value("terminal", "text.body.family") as string[])[0], "JetBrains Mono");
  assert.deepEqual(value("terminal", "text.body.size"), { value: 13, unit: "px" });
  // High contrast: a thicker focus ring.
  assert.deepEqual(value("high-contrast", "ring.width"), { value: 3, unit: "px" });
  assert.deepEqual(value("default", "ring.width"), { value: 2, unit: "px" });
  // Paper reads more slowly: relaxed line height for body text.
  assert.equal(value("paper", "text.body.leading"), 1.65);
});

test("a background tint changes steps 1 to 5 of a ramp and nothing else", () => {
  const plain = generateTokens(themeWith({}, { colors: { neutral: { chroma: 0.025 } } })).set;
  const tinted = generateTokens(themeWith({}, { colors: { neutral: { chroma: 0.025, tint: 0.012 } } })).set;
  const components = (set: typeof plain, path: string) => (set.tokens.get(path)!.value as unknown as { components: number[] }).components;
  for (const step of [1, 2, 3, 4, 5]) assert.ok(components(tinted, `color.neutral.${step}`)[1]! > components(plain, `color.neutral.${step}`)[1]!, `step ${step}`);
  for (const step of [6, 8, 9, 11, 12]) assert.deepEqual(components(tinted, `color.neutral.${step}`), components(plain, `color.neutral.${step}`), `step ${step}`);
  const bad = generateTokens(themeWith({}, { colors: { neutral: { chroma: 0.02, tint: 0.5 } } }));
  assert.ok(bad.diagnostics.some((d) => d.token === "seeds.colors.neutral.tint"));
});

test("a theme whose solid is light needs overrides for the pressed colour, and validate says so", () => {
  // A yellow brand takes dark text on its solid. The accent's pressed colour is ramp step 11,
  // a dark text step, so dark text on it fails; so do the ring and the filled control against the page.
  const yellow = { colors: { brand: { hue: 100, chroma: 0.15, solid: { light: 0.85 } } } };
  const { diagnostics } = validate(generateTokens(themeWith({}, yellow)).set);
  const failing = diagnostics.filter((d) => d.rule === "contrast" && d.related === "color.accent.bg-active");
  assert.deepEqual(failing.map((d) => d.token).sort(), ["color.accent.fg", "color.fg.on-accent"]);
  // The documented fix: press to step 10, which moves the same way as the text colour needs.
  const fixed = validate(generateTokens(themeWith({ "color.accent.bg-active": { light: "{color.brand.10}" } }, yellow)).set);
  assert.deepEqual(fixed.diagnostics.filter((d) => d.related === "color.accent.bg-active"), []);
});
