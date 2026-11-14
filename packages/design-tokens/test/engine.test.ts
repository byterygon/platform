import assert from "node:assert/strict";
import { test } from "node:test";

import { type Catalog, byDensity, byTheme, px, ramp, ref } from "../src/catalog/authoring.js";
import { DEFAULT_CATALOG } from "../src/catalog/default.js";
import { generateTokens } from "../src/generate.js";
import { type ColorValue, type Diagnostic, type TokenSet, hasErrors } from "../src/model.js";
import { defaultContext, dependentAxes, referencedBy, resolve } from "../src/resolve.js";
import { DEFAULT_SEEDS } from "../src/seeds.js";
import { validate } from "../src/validate.js";
import { defaultTheme, themeWith } from "./helpers.js";

function check(theme: unknown, catalog?: Catalog): { set: TokenSet; diagnostics: Diagnostic[]; errors: Diagnostic[] } {
  const generated = generateTokens(theme, catalog);
  const validated = validate(generated.set);
  const diagnostics = [...generated.diagnostics, ...validated.diagnostics];
  return { set: generated.set, diagnostics, errors: diagnostics.filter((d) => d.severity === "error") };
}

const rules = (diagnostics: readonly Diagnostic[]) => [...new Set(diagnostics.map((d) => d.rule))].sort();

test("the default theme generates a valid token set with no findings", () => {
  const { set, diagnostics } = check(defaultTheme());
  assert.deepEqual(diagnostics, []);
  assert.equal(set.name, "default");
  const tiers = [...set.tokens.values()].map((t) => t.tier);
  assert.ok(tiers.includes("primitive") && tiers.includes("semantic"));
  // Ten ramps, two schemes, 12 steps + 12 alpha + contrast each; black and white with overlays; and
  // the scales that are not colours (space, type scale, icons, borders, z, motion, ...).
  const ramps = Object.keys(DEFAULT_SEEDS.colors).length;
  assert.equal(ramps, 10);
  const primitives = [...set.tokens.values()].filter((t) => t.tier === "primitive");
  assert.equal(primitives.filter((t) => t.ramp || t.path.startsWith("color.")).length, ramps * 2 * 25 + 2 + 24);
  assert.ok(primitives.length > ramps * 2 * 25 + 26, "the non-colour scales are primitives too");
  assert.equal(set.tokens.get("color.bg.canvas")!.axis, "theme");
  assert.equal(set.tokens.get("size.control.md")!.axis, "density");
  assert.equal(set.tokens.get("radius.md")!.axis, undefined);
});

test("the default theme file spells out the default seeds", () => {
  assert.deepEqual(defaultTheme().seeds, DEFAULT_SEEDS);
  assert.deepEqual(generateTokens({ schemaVersion: 1, name: "empty" }).seeds, generateTokens(defaultTheme()).seeds);
});

test("every token has a description that says when to use it and when not to", () => {
  const { set } = check(defaultTheme());
  for (const token of set.tokens.values()) {
    assert.ok(token.description.length >= 30, `${token.path}: "${token.description}"`);
    if (token.tier !== "primitive") assert.match(token.description, /\bNot\b|\bNever\b/, `${token.path} says when not to use it`);
    else assert.match(token.description, /never from a component|\bNot\b/, token.path);
  }
  for (const role of DEFAULT_CATALOG.roles) {
    assert.ok(role.use.endsWith(".") && role.avoid.endsWith("."), `${role.path}: use and avoid are sentences`);
  }
});

test("generation is deterministic", () => {
  const a = generateTokens(defaultTheme());
  const b = generateTokens(defaultTheme());
  assert.deepEqual([...a.set.tokens], [...b.set.tokens]);
});

test("aliases resolve per mode, and dependencies follow the chain", () => {
  const { set } = check(defaultTheme());
  const light = resolve(set, "color.fg.muted", { theme: "light", density: "comfortable" });
  const dark = resolve(set, "color.fg.muted", { theme: "dark", density: "comfortable" });
  assert.ok(light.ok && dark.ok);
  assert.deepEqual(light.chain, ["color.fg.muted", "color.neutral.11"]);
  assert.deepEqual(dark.chain, ["color.fg.muted", "color.neutral-dark.11"]);
  assert.notDeepEqual(light.value, dark.value);
  assert.deepEqual([...dependentAxes(set, "shadow.raised")], ["theme"]);
  assert.deepEqual([...dependentAxes(set, "color.neutral.1")], []);
  assert.ok(referencedBy(set, "color.neutral.8").includes("color.border.strong"));
  assert.deepEqual(defaultContext(set), { theme: "light", density: "comfortable" });
});

test("seeds drive the tokens", () => {
  const { set, errors } = check(themeWith({}, { radius: 9, colorScheme: "dark", density: "compact", colors: { brand: { hue: 150, chroma: 0.12 } } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(set.tokens.get("radius.md")!.value, { value: 9, unit: "px" });
  assert.deepEqual(set.tokens.get("radius.sm")!.value, { value: 6, unit: "px" });
  assert.deepEqual(set.tokens.get("radius.lg")!.value, { value: 15, unit: "px" });
  assert.deepEqual(defaultContext(set), { theme: "dark", density: "compact" });
  assert.equal((set.tokens.get("color.brand.9")!.value as ColorValue).components[2], 150);
  // The neutral follows the brand hue unless it has its own.
  assert.equal((set.tokens.get("color.neutral.9")!.value as ColorValue).components[2], 150);
  // A ramp the theme does not mention keeps its default.
  assert.equal((set.tokens.get("color.red.9")!.value as ColorValue).components[2], 27);
});

test("a theme can add a ramp; AAA raises every target", () => {
  const extra = check(themeWith({}, { colors: { olive: { hue: 110, chroma: 0.12 } } }));
  assert.deepEqual(extra.errors, []);
  assert.ok(extra.set.tokens.has("color.olive.9") && extra.set.tokens.has("color.olive-dark.a3"));

  const aaa = check(themeWith({}, { contrast: { level: "AAA" } }));
  assert.equal(aaa.set.contrast.text, 7);
  // The ramps re-solve for 7:1, so the only roles left failing are the ones whose step has no
  // contrast promise; each failure carries a fix.
  for (const error of aaa.errors) {
    assert.equal(error.rule, "contrast");
    assert.equal(error.required, error.message.includes("UI components") ? 4.5 : 7);
    assert.ok(error.fix);
  }
});

test("bad seeds and bad theme files are reported with the path and a hint", () => {
  const bad = check({
    schemaVersion: 2,
    name: "Not A Slug",
    extra: true,
    seeds: { colours: {}, radius: 99, density: "cosy", colors: { brand: { hue: 400 }, base: { hue: 1, chroma: 0.1 }, olive: { chroma: 0.1 } } },
  });
  const found = (token: string) => bad.errors.find((d) => d.token === token);
  assert.equal(found("schemaVersion")?.required, 1);
  assert.ok(found("name"));
  assert.ok(found("extra"));
  assert.match(found("seeds.colours")!.fix!.summary, /colors/);
  assert.equal(found("seeds.radius")?.required, "0..32");
  assert.match(found("seeds.density")!.message, /comfortable, compact/);
  assert.ok(found("seeds.colors.brand.hue"));
  assert.ok(found("seeds.colors.base"));
  assert.ok(found("seeds.colors.olive.hue"));
  assert.deepEqual(rules(check("nope").errors).includes("theme-schema"), true);
});

test("overrides: aliases, literals and single modes", () => {
  const { set, errors } = check(
    themeWith({
      "color.border.default": "{color.neutral.7}",
      "color.accent.subtle-bg": { dark: "{color.brand-dark.4}" },
      "radius.lg": "12px",
      "font.sans": ["IBM Plex Sans", "sans-serif"],
      "color.brand.9": "oklch(0.5 0.08 230)",
      "size.control.md": { compact: "30px" },
    }),
  );
  assert.deepEqual(errors, []);
  const border = set.tokens.get("color.border.default")!;
  assert.deepEqual([border.value, border.axis, border.overridden], ["{color.neutral.7}", undefined, true]);
  assert.deepEqual(set.tokens.get("color.accent.subtle-bg")!.modes, { light: "{color.brand.3}", dark: "{color.brand-dark.4}" });
  assert.deepEqual(set.tokens.get("radius.lg")!.value, { value: 12, unit: "px" });
  assert.deepEqual(set.tokens.get("font.sans")!.value, ["IBM Plex Sans", "sans-serif"]);
  assert.deepEqual((set.tokens.get("color.brand.9")!.value as ColorValue).components, [0.5, 0.08, 230]);
  assert.deepEqual(set.tokens.get("size.control.md")!.modes, { comfortable: { value: 36, unit: "px" }, compact: { value: 30, unit: "px" } });
  assert.equal(set.tokens.get("color.bg.canvas")!.overridden, undefined);
});

test("bad overrides are reported", () => {
  const { errors } = check(
    themeWith({
      "color.fg.mutd": "{color.neutral.11}",
      "radius.md": "big",
      "color.fg.default": { dark: "nope" },
      "size.control.sm": { dark: "10px" },
      "color.fg.subtle": { dark: "{color.neutral-dark.10}", compact: "{color.neutral.10}" },
    }),
  );
  const unknown = errors.find((d) => d.rule === "override-unknown-token")!;
  assert.equal(unknown.token, "color.fg.mutd");
  assert.match(unknown.fix!.summary, /color\.fg\.muted/);
  const invalid = errors.filter((d) => d.rule === "override-invalid-value");
  assert.deepEqual(invalid.map((d) => d.token).sort(), ["color.fg.default", "color.fg.subtle", "radius.md", "size.control.sm"]);
  assert.deepEqual(invalid.find((d) => d.token === "color.fg.default")!.mode, { theme: "dark" });
  assert.match(invalid.find((d) => d.token === "size.control.sm")!.message, /varies by density/);
});

test("rule: a missing alias fails the build and suggests the nearest token", () => {
  const { errors } = check(themeWith({ "color.fg.link": "{color.brand.13}" }));
  const missing = errors.filter((d) => d.rule === "alias-missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0]!.token, "color.fg.link");
  assert.equal(missing[0]!.related, "color.brand.13");
  assert.match(missing[0]!.fix!.summary, /\{color\.brand\.1\d?\}/);
});

test("rule: a raw colour outside the primitive tier fails and names the closest primitive", () => {
  const { errors } = check(themeWith({ "color.bg.surface": { light: "#ffffff" }, "color.fg.default": "oklch(0.2 0.02 230)" }));
  const raw = errors.filter((d) => d.rule === "raw-color-outside-primitive");
  assert.deepEqual(raw.map((d) => d.token).sort(), ["color.bg.surface", "color.fg.default"]);
  const surface = raw.find((d) => d.token === "color.bg.surface")!;
  assert.deepEqual(surface.mode, { theme: "light" });
  assert.deepEqual(surface.fix!.overrides, { "color.bg.surface": { light: "{color.base.white}" } });
  // A raw colour in a primitive is what primitives are for.
  assert.deepEqual(check(themeWith({ "color.neutral.1": "#fcfcfd" })).errors.filter((d) => d.rule === "raw-color-outside-primitive"), []);
});

test("rule: a role pair below its target fails in the mode it fails in, with a fix that works", () => {
  const broken = { "color.fg.subtle": { light: "{color.neutral.7}" } };
  const { errors } = check(themeWith(broken));
  assert.ok(errors.length > 0 && errors.every((d) => d.rule === "contrast"));
  const failure = errors.find((d) => d.related === "color.bg.surface")!;
  assert.equal(failure.token, "color.fg.subtle");
  assert.deepEqual(failure.mode, { theme: "light" });
  assert.equal(failure.required, 4.5);
  assert.ok(typeof failure.measured === "number" && failure.measured < 4.5);
  assert.match(failure.message, /color\.fg\.subtle on color\.bg\.surface \(theme=light\): contrast [\d.]+:1 is below the 4\.5:1 required for text/);
  assert.ok(errors.every((d) => d.mode?.["theme"] === "light"), "the dark mode still passes and is not reported");

  const stillFails = (overrides: Record<string, unknown>) =>
    check(themeWith({ ...broken, ...overrides })).errors.some((d) => d.token === failure.token && d.related === failure.related);
  // The primary fix nudges the primitive's lightness; the alternative re-aliases the role.
  assert.match(failure.fix!.summary, /Change the lightness of color\.neutral\.7 from .* on all \d+ backgrounds it is paired with/);
  assert.equal(stillFails(failure.fix!.overrides!), false);
  // Every failure of the role in that mode carries the same fix, so applying it once clears them all.
  assert.equal(new Set(errors.filter((d) => d.token === failure.token).map((d) => JSON.stringify(d.fix))).size, 1);
  assert.deepEqual(check(themeWith({ ...broken, ...failure.fix!.overrides })).errors.filter((d) => d.token === failure.token), []);
  const alternative = failure.fix!.alternatives![0]!;
  assert.match(alternative.summary, /Alias color\.fg\.subtle to \{color\.neutral\.\d+\}/);
  assert.equal(stillFails(alternative.overrides!), false);
  assert.equal(check(themeWith({ ...broken, ...alternative.overrides })).errors.length, 0);
});

test("contrast is measured in every mode, composited over the surface, with APCA alongside", () => {
  const { set } = check(defaultTheme());
  const { contrast } = validate(set);
  assert.ok(contrast.every((m) => m.pass));
  const modes = new Set(contrast.map((m) => m.mode["theme"]));
  assert.deepEqual([...modes].sort(), ["dark", "light"]);
  const wash = contrast.find((m) => m.bg === "color.interactive.hover" && m.over === "color.bg.overlay" && m.mode["theme"] === "dark")!;
  const plain = contrast.find((m) => m.fg === wash.fg && m.bg === "color.bg.overlay" && m.mode["theme"] === "dark")!;
  assert.ok(wash.ratio < plain.ratio, "a hover wash lowers the contrast of the text on it");
  const body = contrast.find((m) => m.fg === "color.fg.default" && m.bg === "color.bg.canvas" && m.mode["theme"] === "light")!;
  assert.ok(body.apca > 90 && body.ratio > 15);

  const strict = check(themeWith({}, { contrast: { level: "AA", apca: { text: 108 } } }));
  assert.deepEqual(rules(strict.errors), ["contrast-apca"]);
});

test("rules on the catalogue: tiers, types, cycles, modes, paths, mappings, pairs", () => {
  const role = (path: string, value: unknown, extra: object = {}) =>
    ({ path, type: "color", value, use: "Used in a test of the rules.", avoid: "Not for anything else.", ...extra }) as Catalog["roles"][number];
  const catalog: Catalog = {
    roles: [
      role("color.a", ref("color.b")),
      role("color.b", ref("color.a")),
      role("color.size", ref("radius.x")),
      role("radius.x", px(4), { type: "dimension" }),
      role("color.low", ref("button.bg")),
      role("button.bg", ramp("brand", 9), { tier: "component" }),
      role("color.half", { axis: "theme", values: { light: ref("color.brand.1") } }),
      role("color.where", { axis: "weather", values: { sunny: ref("color.brand.1") } }),
      role("color.deep", ramp("brand", 3)),
      role("color.deep.er", ramp("brand", 4)),
      role("size.mixed", byDensity(ref("size.themed"), px(2)), { type: "dimension" }),
      role("size.themed", byTheme(px(1), px(2)), { type: "dimension" }),
      role("color.one", ramp("brand", 1), { tailwind: "--color-x" }),
      role("color.two", ramp("brand", 2), { tailwind: "--color-x" }),
      role("color.silent", ramp("brand", 2), { use: "", avoid: "" }),
    ],
    pairs: [{ fg: "color.nope", bg: "color.one", over: "color.one", kind: "text" }],
    shadcn: { "--background": "color.gone" },
  };
  const { errors } = check(defaultTheme(), catalog);
  const by = (rule: string) => errors.filter((d) => d.rule === rule).map((d) => d.token);
  assert.deepEqual(by("alias-cycle").sort(), ["color.a", "color.b"]);
  assert.deepEqual(by("alias-type-mismatch"), ["color.size"]);
  assert.deepEqual(by("tier-direction"), ["color.low"]);
  assert.deepEqual(by("mode-invalid").sort(), ["color.half", "color.where"]);
  assert.deepEqual(by("path-collision"), ["color.deep.er"]);
  assert.deepEqual(by("mode-cross-axis"), ["size.mixed"]);
  assert.deepEqual(by("output-mapping").sort(), ["color.gone", "color.two"]);
  assert.deepEqual(by("contrast-pair-unknown-token"), ["color.nope"]);
  assert.deepEqual(by("description-missing"), ["color.silent"]);
  assert.ok(hasErrors(errors));
});

test("a primitive that aliases breaks the tier rule", () => {
  const { errors } = check(themeWith({ "color.brand.9": "{color.red.9}" }));
  assert.deepEqual(errors.filter((d) => d.rule === "tier-direction").map((d) => d.token), ["color.brand.9"]);
});
