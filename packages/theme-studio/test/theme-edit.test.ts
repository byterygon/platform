import { describe, expect, test } from "vitest";
import { getIn, groupOf, overriddenTokens, overrideOf, overrideText, parseOverrideText, resetGroup, resetSeeds, setIn, setOverride, setSeed } from "../src/state/theme-edit.ts";

const base = { schemaVersion: 1, name: "t" };

describe("setIn", () => {
  test("sets and deletes without touching the input, pruning empty parents", () => {
    const a = setIn(base, ["seeds", "colors", "brand", "hue"], 150);
    expect(a).toEqual({ ...base, seeds: { colors: { brand: { hue: 150 } } } });
    expect(base).toEqual({ schemaVersion: 1, name: "t" });
    expect(setIn(a, ["seeds", "colors", "brand", "hue"], undefined)).toEqual(base);
    expect(getIn(a, ["seeds", "colors", "brand", "hue"])).toBe(150);
    expect(getIn(a, ["seeds", "radius"])).toBeUndefined();
  });

  test("override keys keep their dots", () => {
    const a = setOverride(base, "color.fg.link", "{color.brand.12}");
    expect(a["overrides"]).toEqual({ "color.fg.link": "{color.brand.12}" });
    expect(overrideOf(a, "color.fg.link")).toBe("{color.brand.12}");
  });
});

describe("seeds", () => {
  test("setSeed and resetSeeds", () => {
    const a = setSeed(setSeed(base, ["radius"], 10), ["colors", "neutral", "tint"], 0.01);
    expect(a["seeds"]).toEqual({ radius: 10, colors: { neutral: { tint: 0.01 } } });
    expect(resetSeeds(a, [["radius"], ["colors", "neutral"]])).toEqual(base);
  });
});

describe("overrides", () => {
  test("a per-mode change spreads a value written for every mode over the token's modes", () => {
    const a = setOverride(base, "color.fg.link", "{color.brand.11}");
    const b = setOverride(a, "color.fg.link", "{color.brand-dark.12}", "dark", ["light", "dark"]);
    expect(overrideOf(b, "color.fg.link")).toEqual({ light: "{color.brand.11}", dark: "{color.brand-dark.12}" });
    const c = setOverride(b, "color.fg.link", undefined, "dark", ["light", "dark"]);
    expect(overrideOf(c, "color.fg.link")).toEqual({ light: "{color.brand.11}" });
    expect(setOverride(c, "color.fg.link", undefined, "light", ["light", "dark"])).toEqual(base);
  });

  test("reset group removes the group and everything under it, nothing else", () => {
    let a = setOverride(base, "color.bg.surface", "{color.neutral.2}");
    a = setOverride(a, "color.bg.canvas", "{color.neutral.1}");
    a = setOverride(a, "color.bg-x", "{color.neutral.3}");
    a = setOverride(a, "radius.lg", "12px");
    expect(overriddenTokens(resetGroup(a, "color.bg"))).toEqual(["color.bg-x", "radius.lg"]);
    expect(groupOf("color.bg.surface")).toBe("color.bg");
  });

  test("text in and out", () => {
    expect(parseOverrideText("fontFamily", "Inter, 'Segoe UI', sans-serif")).toEqual(["Inter", "Segoe UI", "sans-serif"]);
    expect(parseOverrideText("fontFamily", "{font.mono}")).toBe("{font.mono}");
    expect(parseOverrideText("fontWeight", "600")).toBe(600);
    expect(parseOverrideText("dimension", " 12px ")).toBe("12px");
    expect(parseOverrideText("shadow", '[{"color":"{color.black.a3}"}]')).toEqual([{ color: "{color.black.a3}" }]);
    expect(overrideText(["Inter", "sans-serif"])).toBe("Inter, sans-serif");
    expect(overrideText(undefined)).toBe("");
  });
});
