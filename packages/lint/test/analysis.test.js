// The suggestions come from the engine's catalogue: change the theme and they follow.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { analyzeClass, loadCatalog, parseCssColor, tailwindPalette } from "@byterygon/lint";

const context = (theme) => ({ catalog: loadCatalog(theme), palette: tailwindPalette() });

test("suggestions are read from the theme, not from a list", () => {
  const dir = mkdtempSync(join(tmpdir(), "by-lint-"));
  const file = join(dir, "custom.theme.json");
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, name: "custom", overrides: { "space.gap.xl": "13px", "color.bg.raised": "#e1062c" } }));
  const custom = context(file);
  const [spacing] = analyzeClass("gap-[13px]", custom);
  assert.deepEqual(spacing?.suggestions, ["gap-gap-xl"]);
  const [color] = analyzeClass("bg-[#e1062c]", custom);
  assert.equal(color?.suggestions[0], "bg-raised");
  // The default theme suggests differently for the same classes.
  assert.deepEqual(analyzeClass("gap-[13px]", context())[0]?.suggestions, ["gap-gap-md"]);
});

test("roles, variants, modifiers and layout utilities pass", () => {
  for (const cls of ["bg-surface", "hover:bg-hover", "bg-surface/50", "text-body-1", "text-fg-muted", "border-border-subtle", "p-inset-sm", "gap-gap-md", "h-control-md", "size-icon-md", "w-full", "w-1/3", "inset-0", "-mt-px", "w-24", "data-[state=open]:bg-selected", "bg-(--by-color-bg-raised)", "shadow-layer", "rounded-md", "ring-2", "border", "grid-cols-2"]) {
    assert.deepEqual(analyzeClass(cls, context()), [], cls);
  }
});

test("variants and the sign are kept in suggestions", () => {
  assert.deepEqual(analyzeClass("md:hover:-mt-2", context())[0]?.suggestions, ["md:hover:-mt-stack-sm"]);
});

test("unknown token variables get the closest names", () => {
  const [finding] = analyzeClass("bg-[var(--by-color-bg-surfac)]", context());
  assert.equal(finding?.rule, "no-arbitrary-value");
  assert.match(finding?.message ?? "", /Did you mean --by-color-bg-surface/);
});

test("CSS colours parse to OKLCH", () => {
  for (const [text, l] of [["#fff", 1], ["#000000", 0], ["rgb(255 255 255)", 1], ["rgba(0, 0, 0, 0.5)", 0], ["hsl(0 0% 100%)", 1], ["white", 1], ["oklch(0.5 0.1 200)", 0.5]]) {
    assert.ok(Math.abs((parseCssColor(text)?.l ?? -1) - l) < 0.01, text);
  }
  assert.equal(parseCssColor("rgba(0, 0, 0, 0.5)")?.alpha, 0.5);
  assert.equal(parseCssColor("lab(50 0 0)"), undefined);
});
