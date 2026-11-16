import assert from "node:assert/strict";
import { test } from "node:test";

import { applyFix, fixAll, isApplicable } from "../src/fix.js";
import { generateTokens } from "../src/generate.js";
import { validate } from "../src/validate.js";
import { themeWith } from "./helpers.js";

test("applyFix merges overrides per mode and seeds field by field", () => {
  const theme = themeWith({ "color.fg.link": "{color.brand.11}", "color.fg.muted": { dark: "{color.neutral-dark.11}" } }, { colors: { brand: { hue: 200, chroma: 0.1 } } });
  const { set } = generateTokens(theme);
  const fixed = applyFix(
    theme,
    {
      overrides: { "color.fg.link": { dark: "{color.brand-dark.12}" }, "color.fg.muted": { light: "{color.neutral.11}" }, "color.neutral.7": "oklch(0.8 0.01 230)" },
      seeds: { colors: { brand: { chroma: 0.12 } }, radius: 7 },
    },
    set,
  );
  const overrides = fixed["overrides"] as Record<string, unknown>;
  // The theme's value for every mode is kept for the modes the fix leaves alone.
  assert.deepEqual(overrides["color.fg.link"], { light: "{color.brand.11}", dark: "{color.brand-dark.12}" });
  assert.deepEqual(overrides["color.fg.muted"], { dark: "{color.neutral-dark.11}", light: "{color.neutral.11}" });
  assert.equal(overrides["color.neutral.7"], "oklch(0.8 0.01 230)");
  const seeds = fixed["seeds"] as { colors: Record<string, unknown>; radius: number };
  assert.deepEqual(seeds.colors["brand"], { hue: 200, chroma: 0.12 });
  assert.equal(seeds.radius, 7);
  assert.notEqual(fixed, theme);
  assert.equal((theme.seeds as { radius?: number }).radius, 6, "the input is not changed");
  // Without the token set, a per-mode fix replaces the override.
  assert.deepEqual((applyFix(theme, { overrides: { "color.fg.link": { dark: "{color.brand-dark.12}" } } })["overrides"] as Record<string, unknown>)["color.fg.link"], { dark: "{color.brand-dark.12}" });
  assert.equal(isApplicable({ summary: "explain only" }), false);
});

test("a failing pair's measurement carries its diagnostic's fix, and applying it clears the failure", () => {
  const theme = themeWith({ "color.neutral.11": "oklch(0.7 0.02 230)" });
  const { set } = generateTokens(theme);
  const checked = validate(set);
  const failing = checked.contrast.filter((m) => !m.pass);
  assert.ok(failing.length > 0);
  assert.ok(checked.contrast.filter((m) => m.pass).every((m) => m.fix === undefined));
  const first = failing[0]!;
  const diagnostic = checked.diagnostics.find((d) => d.rule === "contrast" && d.token === first.fg && d.related === first.bg && JSON.stringify(d.mode) === JSON.stringify(first.mode))!;
  assert.deepEqual(first.fix, diagnostic.fix);
  assert.deepEqual(first.fix!.overrides, { "color.neutral.11": "oklch(0.49 0.02 230)" });

  const fixed = applyFix(theme, first.fix!, set);
  const after = validate(generateTokens(fixed).set);
  assert.equal(after.diagnostics.filter((d) => d.severity === "error").length, 0, "one lightness change clears every pair of the role");
  // An alternative is applied the same way.
  const alternative = first.fix!.alternatives![0]!;
  const viaAlias = validate(generateTokens(applyFix(theme, alternative, set)).set);
  assert.ok(viaAlias.contrast.filter((m) => m.fg === first.fg && m.bg === first.bg).every((m) => m.pass), alternative.summary);
});

test("fixAll applies fixes one at a time until no error has one", () => {
  const theme = themeWith({ "color.neutral.11": "oklch(0.7 0.02 230)", "color.fg.link": { light: "{color.brand.7}" } });
  const result = fixAll(theme);
  assert.ok(result.applied.length >= 2, `applied ${result.applied.length}`);
  assert.equal(result.diagnostics.filter((d) => d.severity === "error").length, 0);
  assert.deepEqual(fixAll(result.theme).applied, [], "a fixed theme needs nothing more");
  // An error with no applicable fix is left and reported.
  const broken = fixAll(themeWith({ "color.fg.nonexistent": "{color.brand.11}" }));
  assert.ok(broken.diagnostics.some((d) => d.severity === "error"));
});
