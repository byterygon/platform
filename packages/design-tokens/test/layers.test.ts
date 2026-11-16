// The layered (Fluent) look: the gradient value type, contrast over a gradient and over a stack of
// translucent layers, the new roles in every output, and warning on the orange ramp.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { buildTheme } from "../src/build.js";
import { generateTokens } from "../src/generate.js";
import type { ColorValue, ThemeFile } from "../src/model.js";
import { renderTokensCss } from "../src/outputs.js";
import { resolve } from "../src/resolve.js";
import { validate } from "../src/validate.js";
import { ROOT, defaultTheme, themeWith } from "./helpers.js";

const LIGHT = { theme: "light", density: "comfortable" };
const DARK = { theme: "dark", density: "comfortable" };

/** The aurora backdrop, written as a theme file writes it. */
const GLOWS = {
  light: [
    { kind: "radial", color: "{color.brand.4}", radiusX: "1100px", radiusY: "700px", x: 0.08, y: 0, fade: 0.6 },
    { kind: "radial", color: "{color.teal.3}", radiusX: "1000px", radiusY: "800px", x: 1, y: 0.35, fade: 0.6 },
    { kind: "solid", color: "{color.bg.canvas}" },
  ],
  dark: [
    { kind: "radial", color: "{color.brand-dark.5}", radiusX: "1100px", radiusY: "700px", x: 0.08, y: 0, fade: 0.6 },
    { kind: "solid", color: "{color.bg.canvas}" },
  ],
};

const presets = readdirSync(join(ROOT, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => JSON.parse(readFileSync(join(ROOT, "themes", file), "utf8")) as ThemeFile);

test("every preset has the roles of the layered look, with their Tailwind names", () => {
  const roles: Record<string, string | undefined> = {
    "gradient.backdrop": undefined,
    "color.backdrop.glow-1": undefined,
    "color.backdrop.glow-2": undefined,
    "color.bg.layer": "--color-layer",
    "color.bg.layer-alt": "--color-layer-alt",
    "color.border.subtle": "--color-border-subtle",
    "color.border.control-bottom": "--color-border-control-bottom",
    "color.border.control-bottom-subtle": "--color-border-control-bottom-subtle",
    "color.border.focus-underline": "--color-border-focus-underline",
    "color.ring-inner": "--color-ring-inner",
    "ring.inner-width": undefined,
    "ring.inner-color": undefined,
    "shadow.focus-underline": "--shadow-focus-underline",
    "elevation.layer.shadow": "--shadow-layer",
    "elevation.flyout.shadow": "--shadow-flyout",
    "elevation.dialog.shadow": "--shadow-dialog",
    "blur.acrylic": "--blur-acrylic",
  };
  for (const depth of [2, 4, 8, 16, 28, 64]) roles[`depth.${depth}`] = undefined;
  for (const name of ["layer", "flyout", "dialog"]) {
    roles[`elevation.${name}.border`] = undefined;
    roles[`elevation.${name}.bg`] = undefined;
  }
  for (const preset of presets) {
    const { set } = generateTokens(preset);
    for (const [path, tailwind] of Object.entries(roles)) {
      const token = set.tokens.get(path);
      assert.ok(token, `${preset.name}: ${path}`);
      assert.equal(token.tailwind, tailwind, `${preset.name}: ${path}`);
      assert.ok(token.description.length > 60, path);
    }
    assert.equal(set.tokens.get("gradient.backdrop")!.type, "gradient");
  }
});

test("the layer values are the reference canvas's: 72 % and 5 % white layers, 8 % hairlines, a 45 % / 55 % field edge", () => {
  const { set } = generateTokens(defaultTheme());
  const alpha = (path: string, context: Record<string, string>) => {
    const resolved = resolve(set, path, context);
    assert.ok(resolved.ok, path);
    return (resolved.value as ColorValue).alpha;
  };
  assert.deepEqual([alpha("color.bg.layer", LIGHT), alpha("color.bg.layer", DARK)], [0.72, 0.05]);
  assert.deepEqual([alpha("color.bg.layer-alt", LIGHT), alpha("color.bg.layer-alt", DARK)], [undefined, 0.06]);
  assert.deepEqual([alpha("color.border.subtle", LIGHT), alpha("color.border.subtle", DARK)], [0.08, 0.08]);
  assert.deepEqual([alpha("color.border.control-bottom", LIGHT), alpha("color.border.control-bottom", DARK)], [0.45, 0.55]);
  const css = renderTokensCss(set, "test");
  assert.match(css, /--by-depth-16: 0 8px 16px 0 var\(--by-color-black-alpha-14\), 0 0 2px 0 var\(--by-color-black-alpha-12\);/);
  assert.match(css, /--by-shadow-focus-underline: inset 0 -2px 0 0 var\(--by-color-border-focus-underline\);/);
  assert.match(css, /--by-color-ring-inner: var\(--by-color-base-white\);[\s\S]*--by-color-ring-inner: var\(--by-color-base-black\);/);
});

test("warning is orange, apart from danger's red and from every preset's brand", () => {
  for (const preset of presets) {
    const { set } = generateTokens(preset);
    const hue = (path: string, context: Record<string, string>) => {
      const resolved = resolve(set, path, context);
      assert.ok(resolved.ok);
      return (resolved.value as ColorValue).components[2];
    };
    for (const context of [LIGHT, DARK]) {
      const chain = resolve(set, "color.status.warning.solid", context);
      assert.ok(chain.ok && chain.chain.at(-1)!.startsWith("color.orange"), chain.ok ? chain.chain.join(" -> ") : "unresolved");
      const warning = hue("color.status.warning.solid", context);
      const apart = (other: number) => Math.min(Math.abs(warning - other), 360 - Math.abs(warning - other));
      assert.ok(apart(hue("color.status.danger.solid", context)) >= 20, `${preset.name}: warning and danger`);
      assert.ok(apart(hue("color.accent.bg", context)) >= 20 || (resolve(set, "color.accent.bg", context).ok && (resolve(set, "color.accent.bg", context) as { value: ColorValue }).value.components[1] < 0.05), `${preset.name}: warning and brand`);
    }
  }
});

test("the backdrop's glows are the canvas colour unless a theme colours them, so the default backdrop is flat", () => {
  const { set } = generateTokens(defaultTheme());
  for (const context of [LIGHT, DARK]) {
    const canvas = resolve(set, "color.bg.canvas", context);
    for (const glow of ["color.backdrop.glow-1", "color.backdrop.glow-2"]) {
      const value = resolve(set, glow, context);
      assert.ok(canvas.ok && value.ok);
      assert.equal((value.value as ColorValue).hex, (canvas.value as ColorValue).hex, glow);
    }
  }
  assert.match(
    renderTokensCss(set, "test"),
    /--by-gradient-backdrop: radial-gradient\(1100px 700px at 8% 0%, var\(--by-color-backdrop-glow-1\) 0%, transparent 60%\), radial-gradient\(1000px 800px at 100% 35%, var\(--by-color-backdrop-glow-2\) 0%, transparent 60%\), linear-gradient\(var\(--by-color-bg-canvas\), var\(--by-color-bg-canvas\)\);/,
  );
  // A flat backdrop measures like the canvas: one point, no worse than before.
  const coloured = validate(generateTokens(themeWith({ "color.backdrop.glow-1": { light: "{color.brand.4}" } })).set);
  assert.deepEqual(coloured.diagnostics, []);
});

test("a gradient: glows over one solid colour, as CSS background-image, overridable per mode", () => {
  const { set, diagnostics } = generateTokens(themeWith({ "gradient.backdrop": GLOWS }));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(validate(set).diagnostics, []);
  const css = renderTokensCss(set, "test");
  assert.match(
    css,
    /--by-gradient-backdrop: radial-gradient\(1100px 700px at 8% 0%, var\(--by-color-brand-4\) 0%, transparent 60%\), radial-gradient\(1000px 800px at 100% 35%, var\(--by-color-teal-3\) 0%, transparent 60%\), linear-gradient\(var\(--by-color-bg-canvas\), var\(--by-color-bg-canvas\)\);/,
  );
  const dark = resolve(set, "gradient.backdrop", DARK);
  assert.ok(dark.ok && Array.isArray(dark.value) && dark.value.length === 2);
});

test("a malformed gradient is reported with the layer and the rule it breaks", () => {
  const solid = { kind: "solid", color: "{color.bg.canvas}" };
  const glow = { kind: "radial", color: "{color.brand.4}", radiusX: "1100px", radiusY: "700px", x: 0.08, y: 0, fade: 0.6 };
  const cases: [unknown, RegExp][] = [
    [[glow], /last layer must be/],
    [[solid, glow], /solid colour must be the last layer/],
    [[{ ...glow, blur: 3 }, solid], /unknown field blur/],
    [[{ ...glow, fade: 1.5 }, solid], /fade must be a number from 0.01 to 1/],
    [[{ ...glow, radiusX: "wide" }, solid], /radiusX must be a dimension/],
    [[{ ...glow, kind: "conic" }, solid], /kind must be "radial" or "solid"/],
    ["linear-gradient(red, blue)", /expected a gradient is a list of layers|expected a gradient/],
  ];
  for (const [value, message] of cases) {
    const { diagnostics } = generateTokens(themeWith({ "gradient.backdrop": value }));
    const invalid = diagnostics.find((d) => d.rule === "override-invalid-value");
    assert.ok(invalid, JSON.stringify(value));
    assert.match(invalid.message, message);
  }
  // A role holds no raw colour, inside a gradient either.
  const raw = generateTokens(themeWith({ "gradient.backdrop": [{ kind: "solid", color: "#ffffff" }] }));
  assert.ok(validate(raw.set).diagnostics.some((d) => d.rule === "raw-color-outside-primitive" && d.token === "gradient.backdrop"));
});

test("contrast on a layer is measured over the backdrop at its least favourable point, and through a stack of layers", () => {
  const flat = validate(generateTokens(defaultTheme()).set).contrast;
  // A strong glow (the brand solid itself) under a translucent layer: grey text loses contrast where it shows.
  const glowing = themeWith({
    "gradient.backdrop": { light: [{ ...GLOWS.light[0], color: "{color.brand.9}" }, GLOWS.light[2]] },
  });
  const checked = validate(generateTokens(glowing).set);
  const find = (list: typeof flat, fg: string, bg: string) => list.find((m) => m.fg === fg && m.bg === bg && m.mode["theme"] === "light")!;
  const before = find(flat, "color.fg.subtle", "color.bg.layer");
  const after = find(checked.contrast, "color.fg.subtle", "color.bg.layer");
  assert.deepEqual(after.over, ["gradient.backdrop"]);
  assert.ok(after.ratio < before.ratio - 1, `${after.ratio} < ${before.ratio}`);
  const failure = checked.diagnostics.find((d) => d.rule === "contrast" && d.token === "color.fg.subtle" && d.related === "color.bg.layer");
  assert.ok(failure, "the glowing backdrop breaks a pair");
  assert.match(failure.message, /over gradient\.backdrop \(at its least favourable point\)/);
  // A field inside a layer: painted over both, read from the field down.
  const field = find(flat, "color.border.control-bottom", "color.bg.layer-alt");
  assert.deepEqual(field.over, ["gradient.backdrop", "color.bg.layer"]);
  assert.ok(field.pass && field.ratio >= 3);
  const darkField = flat.find((m) => m.fg === "color.fg.muted" && m.bg === "color.bg.layer-alt" && m.mode["theme"] === "dark")!;
  assert.ok(darkField.pass);
});

test("a translucent stroke that fails gets the nearest alpha of the same colour that passes", () => {
  const aaa = themeWith({}, { contrast: { level: "AAA" } });
  const failure = validate(generateTokens(aaa).set).diagnostics.find((d) => d.rule === "contrast" && d.token === "color.border.control-bottom");
  assert.ok(failure?.fix?.overrides, "a fix with overrides");
  assert.deepEqual(failure.fix.overrides, { "color.border.control-bottom": { light: "{color.black.alpha-55}" } });
  const fixed = generateTokens(themeWith(failure.fix.overrides as Record<string, unknown>, { contrast: { level: "AAA" } }));
  assert.ok(!validate(fixed.set).diagnostics.some((d) => d.token === "color.border.control-bottom"));
});

test("outputs without gradients use the solid colour: Figma aliases it, DTCG writes a colour with the layers alongside", async () => {
  const files = (await buildTheme(themeWith({ "gradient.backdrop": GLOWS }))).files!;
  const figma = JSON.parse(files.get("figma-variables.json")!);
  const theme = figma.collections.find((c: { name: string }) => c.name === "Theme");
  const backdrop = theme.variables.find((v: { name: string }) => v.name === "gradient/backdrop");
  assert.equal(backdrop.type, "COLOR");
  assert.deepEqual(backdrop.valuesByMode.Light, { type: "VARIABLE_ALIAS", collection: "Theme", name: "color/bg/canvas" });
  const dtcg = JSON.parse(files.get("tokens.dtcg.json")!);
  const node = dtcg.gradient.backdrop;
  assert.equal(node.$type, "color");
  assert.equal(node.$value, "{color.bg.canvas}");
  assert.equal(node.$extensions["com.byterygon"].type, "gradient");
  assert.equal(node.$extensions["com.byterygon"].modes.light.length, 3);
  const ts = files.get("tokens.ts")!;
  assert.match(ts, /"gradient\.backdrop": \{[\s\S]*?values: \{ "light": "radial-gradient\(1100px 700px at 8% 0%, oklch\([^)]*\) 0%, transparent 60%\)/);
  // The Monaco theme reads no gradient; it renders as before.
  assert.ok(files.get("monaco-theme.ts")!.includes("editor.background"));
});
