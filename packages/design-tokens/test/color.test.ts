import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_RECIPE,
  WCAG_AA,
  WCAG_AAA,
  alphaOver,
  apcaContrast,
  compositeOver,
  formatOklch,
  gamutMapSrgb,
  generateRamp,
  hexToRgb,
  inSrgbGamut,
  maxChroma,
  nearestPassingLightness,
  oklchToDisplayRgb,
  oklchToHex,
  parseColor,
  rgbToHex,
  solveLightness,
  srgbToOklch,
  wcagContrast,
} from "../src/color/index.js";

const near = (actual: number, expected: number, tolerance: number, label: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);

test("sRGB to OKLCH matches the reference values", () => {
  const cases: [string, number, number, number][] = [
    ["#ff0000", 0.628, 0.2577, 29.23],
    ["#00ff00", 0.8664, 0.2948, 142.5],
    ["#0000ff", 0.452, 0.3132, 264.05],
  ];
  for (const [hex, l, c, h] of cases) {
    const color = srgbToOklch(hexToRgb(hex)!);
    near(color.l, l, 0.0005, `${hex} lightness`);
    near(color.c, c, 0.0005, `${hex} chroma`);
    near(color.h, h, 0.05, `${hex} hue`);
  }
  const white = srgbToOklch(hexToRgb("#fff")!);
  near(white.l, 1, 1e-6, "white lightness");
  assert.equal(white.c, 0);
});

test("hex survives a round trip through OKLCH", () => {
  for (const hex of ["#000000", "#ffffff", "#0a7ea4", "#cc2827", "#7f7f7f", "#123456", "#fedcba"]) {
    assert.equal(oklchToHex(srgbToOklch(hexToRgb(hex)!)), hex);
  }
  assert.deepEqual(hexToRgb("#0f08"), { r: 0, g: 1, b: 0, alpha: 0x88 / 255 });
  assert.equal(hexToRgb("red"), undefined);
  assert.equal(rgbToHex({ r: 1.2, g: -0.1, b: 0.5 }), "#ff0080");
});

test("gamut mapping keeps lightness and hue and only reduces chroma", () => {
  const wild = { l: 0.6, c: 0.4, h: 230 };
  assert.equal(inSrgbGamut(wild), false);
  const mapped = gamutMapSrgb(wild);
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.color.l, wild.l);
  assert.equal(mapped.color.h, wild.h);
  assert.ok(mapped.color.c < wild.c);
  assert.ok(inSrgbGamut(mapped.color));
  near(mapped.color.c, maxChroma(0.6, 230), 1e-6, "mapped chroma is the gamut boundary");

  const inside = { l: 0.6, c: 0.05, h: 230 };
  assert.deepEqual(gamutMapSrgb(inside), { color: inside, mapped: false, requestedChroma: 0.05 });
  assert.equal(gamutMapSrgb({ l: 1, c: 0.1, h: 10 }).color.c, 0);
  assert.equal(maxChroma(0, 100), 0);
});

test("WCAG contrast ratio", () => {
  const black = hexToRgb("#000")!;
  const white = hexToRgb("#fff")!;
  assert.equal(wcagContrast(black, white), 21);
  assert.equal(wcagContrast(white, black), 21);
  assert.equal(wcagContrast(white, white), 1);
  near(wcagContrast(hexToRgb("#767676")!, white), 4.54, 0.01, "#767676 on white");
  near(wcagContrast(hexToRgb("#777777")!, white), 4.48, 0.01, "#777777 on white");
});

test("APCA lightness contrast matches the published reference values", () => {
  const rgb = (hex: string) => hexToRgb(hex)!;
  near(apcaContrast(rgb("#000"), rgb("#fff")), 106.04, 0.05, "black on white");
  near(apcaContrast(rgb("#fff"), rgb("#000")), -107.88, 0.05, "white on black");
  near(apcaContrast(rgb("#888"), rgb("#fff")), 63.06, 0.05, "#888 on white");
  near(apcaContrast(rgb("#fff"), rgb("#888")), -68.54, 0.05, "white on #888");
  near(apcaContrast(rgb("#000"), rgb("#aaa")), 58.15, 0.05, "black on #aaa");
  near(apcaContrast(rgb("#aaa"), rgb("#000")), -56.24, 0.05, "#aaa on black");
  assert.equal(apcaContrast(rgb("#fff"), rgb("#fff")), 0);
});

test("alpha variants composite back to the opaque colour", () => {
  const white = { r: 1, g: 1, b: 1 };
  const target = hexToRgb("#d9dfe2")!;
  const translucent = alphaOver(target, white);
  assert.ok(translucent.alpha! > 0 && translucent.alpha! < 0.3);
  const shown = compositeOver(translucent, white);
  for (const channel of ["r", "g", "b"] as const) near(shown[channel], target[channel], 2 / 255, `channel ${channel}`);
  assert.deepEqual(compositeOver({ r: 0, g: 0, b: 0, alpha: 0.5 }, white), { r: 0.5, g: 0.5, b: 0.5 });
  assert.equal(alphaOver(white, white).alpha, 0);
});

test("colour text: formatting and parsing", () => {
  assert.equal(formatOklch({ l: 0.55, c: 0.15, h: 230 }), "oklch(0.55 0.15 230)");
  assert.equal(formatOklch({ l: 0.5, c: 0.00001, h: 123, alpha: 0.5 }), "oklch(0.5 0 0 / 0.5)");
  assert.deepEqual(parseColor("oklch(0.5 0.1 230)"), { l: 0.5, c: 0.1, h: 230 });
  assert.deepEqual(parseColor("OKLCH(50% 0.1 230deg / 50%)"), { l: 0.5, c: 0.1, h: 230, alpha: 0.5 });
  assert.equal(formatOklch(parseColor("#ffffff")!), "oklch(1 0 0)");
  for (const bad of ["oklch(0.5 0.1)", "rgb(0 0 0)", "oklch(2 0.1 10)", "oklch(a b c)", ""]) {
    assert.equal(parseColor(bad), undefined, bad);
  }
});

test("the solver moves lightness only, and only as far as needed", () => {
  const white = { r: 1, g: 1, b: 1 };
  const start = { l: 0.8, c: 0.1, h: 230 };
  const solved = solveLightness({ color: start, against: [white], ratio: 4.5, direction: -1 });
  assert.equal(solved.reached, true);
  assert.equal(solved.moved, true);
  assert.equal(solved.color.h, 230);
  assert.ok(solved.color.l < start.l);
  assert.ok(solved.ratio >= 4.5 && solved.ratio < 4.7, `stops just past the target, got ${solved.ratio}`);

  const already = solveLightness({ color: { l: 0.2, c: 0, h: 0 }, against: [white], ratio: 4.5, direction: -1 });
  assert.deepEqual([already.moved, already.reached], [false, true]);

  const impossible = solveLightness({ color: start, against: [white], ratio: 4.5, direction: 1 });
  assert.equal(impossible.reached, false);

  const grey = hexToRgb("#808080")!;
  const nearest = nearestPassingLightness({ l: 0.6, c: 0, h: 0 }, [grey], 3);
  assert.ok(nearest && wcagContrast(oklchToDisplayRgb(nearest.color), grey) >= 3);
});

test("a ramp has twelve steps whose jobs hold", () => {
  for (const scheme of ["light", "dark"] as const) {
    const neutral = generateRamp({ hue: 230, chroma: 0.025 }, scheme);
    for (const seed of [
      { hue: 230, chroma: 0.11 },
      { hue: 27, chroma: 0.2 },
      { hue: 75, chroma: 0.15, solid: { light: 0.8, dark: 0.8 } },
      { hue: 150, chroma: 0.14 },
      { hue: 300, chroma: 0.25 },
    ]) {
      const ramp = generateRamp(seed, scheme, { reference: neutral });
      const label = `hue ${seed.hue} ${scheme}`;
      assert.equal(ramp.steps.length, 12);
      assert.deepEqual(ramp.warnings.filter((w) => w.kind === "unreachable"), [], label);
      const rgb = ramp.steps.map((step) => oklchToDisplayRgb(step.color));
      const contrastWith = (a: number, b: number) => wcagContrast(rgb[a - 1]!, rgb[b - 1]!);
      for (const step of ramp.steps) {
        assert.ok(inSrgbGamut(step.color, 1e-3), `${label} step ${step.step} is in gamut`);
        assert.equal(step.color.h === seed.hue || step.color.c === 0, true, `${label} step ${step.step} keeps the hue`);
      }
      // Backgrounds and borders get monotonically stronger; text is the far end.
      const direction = scheme === "light" ? -1 : 1;
      for (let i = scheme === "light" ? 1 : 2; i < 8; i += 1) {
        assert.ok((ramp.steps[i]!.color.l - ramp.steps[i - 1]!.color.l) * direction > 0, `${label}: step ${i + 1} is past step ${i}`);
      }
      // Step 8 identifies a control (3:1), step 11 is readable text (4.5:1), on steps 1-3.
      for (const background of [1, 2, 3]) {
        assert.ok(contrastWith(8, background) >= WCAG_AA.ui, `${label}: 8 on ${background} is ${contrastWith(8, background)}`);
        assert.ok(contrastWith(11, background) >= WCAG_AA.text, `${label}: 11 on ${background}`);
        assert.ok(contrastWith(12, background) >= 7, `${label}: 12 on ${background}`);
      }
      // The solids carry text in the ramp's contrast colour.
      const text = oklchToDisplayRgb(ramp.contrast);
      for (const solid of [9, 10]) {
        assert.ok(wcagContrast(text, rgb[solid - 1]!) >= WCAG_AA.text, `${label}: text on solid ${solid}`);
      }
    }
  }
});

test("ramp options: AAA thresholds, solid lightness, determinism, gamut warning", () => {
  const seed = { hue: 230, chroma: 0.11 };
  const aa = generateRamp(seed, "light");
  const aaa = generateRamp(seed, "light", { thresholds: WCAG_AAA });
  const white = { r: 1, g: 1, b: 1 };
  assert.ok(wcagContrast(white, oklchToDisplayRgb(aaa.steps[8]!.color)) >= 7);
  assert.ok(aaa.steps[8]!.color.l < aa.steps[8]!.color.l);

  const amber = generateRamp({ hue: 75, chroma: 0.15, solid: { light: 0.8 } }, "light");
  assert.equal(amber.contrastIs, "ink");
  assert.ok(amber.steps[8]!.color.l >= 0.8);

  assert.deepEqual(generateRamp(seed, "dark"), generateRamp(seed, "dark"));
  assert.equal(DEFAULT_RECIPE.light.steps.length, 12);

  const loud = generateRamp({ hue: 180, chroma: 0.3 }, "light");
  const warning = loud.warnings.find((w) => w.kind === "gamut");
  assert.ok(warning && warning.step === 9 && warning.required === 0.3 && (warning.measured ?? 1) < 0.3);
});
