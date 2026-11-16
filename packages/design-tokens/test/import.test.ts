import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { oklchToHex } from "../src/color/index.js";
import { EXIT, run } from "../src/cli/main.js";
import { exportTheme } from "../src/export.js";
import { fixAll } from "../src/fix.js";
import { generateTokens } from "../src/generate.js";
import { detectImportFormat, importTheme, parseShadcnColor } from "../src/import.js";
import { renderTokensCss } from "../src/outputs.js";
import { stableJson } from "../src/util.js";
import { ROOT } from "./helpers.js";

const PRESETS = readdirSync(join(ROOT, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => file.slice(0, -".theme.json".length));
const preset = (name: string) => JSON.parse(readFileSync(join(ROOT, "themes", `${name}.theme.json`), "utf8")) as Record<string, unknown>;
const css = (theme: unknown) => renderTokensCss(generateTokens(theme).set, "x");
const fixture = (name: string) => readFileSync(join(ROOT, "test", "fixtures", name), "utf8");
const overrideCount = (theme: unknown) => Object.keys(((theme as Record<string, unknown>)["overrides"] as object | undefined) ?? {}).length;

test("importing a preset's tokens.css or tokens.dtcg.json gives a theme that renders the same tokens.css", async () => {
  for (const name of PRESETS) {
    const original = preset(name);
    const expected = css(original);
    for (const [format, text] of [
      ["css", readFileSync(join(ROOT, "generated", name, "tokens.css"), "utf8")],
      ["dtcg", (await exportTheme(original, "dtcg")).content!],
    ] as const) {
      const result = importTheme(text);
      assert.equal(result.ok, true, `${name} ${format}`);
      assert.equal(result.format, format);
      assert.equal(result.theme!["name"], name, "the source's name is kept");
      assert.deepEqual(result.diagnostics, [], `${name} ${format}: ${result.diagnostics.map((d) => d.message).join("; ")}`);
      assert.ok(css(result.theme) === expected, `${name} ${format}: the imported theme renders a different tokens.css`);
      // The seeds are inferred well enough that no more overrides are needed than the preset has.
      assert.ok(overrideCount(result.theme) <= overrideCount(original), `${name} ${format}: ${overrideCount(result.theme)} overrides, the preset has ${overrideCount(original)}`);
      assert.equal(result.text, stableJson(result.theme));
    }
  }
});

test("an edited tokens.css: changed values become overrides, unknown names are reported", () => {
  const source = readFileSync(join(ROOT, "generated", "classic", "tokens.css"), "utf8").replace(/--by-radius-lg: [^;]+;/, "--by-radius-lg: 14px;");
  const dark = source.indexOf('[data-theme="dark"],\n.dark {');
  const text =
    source.slice(0, dark) +
    source
      .slice(dark)
      .replace(/--by-color-fg-link: [^;]+;/, "--by-color-fg-link: var(--by-color-brand-dark-12);")
      .replace("color-scheme: dark;", "color-scheme: dark;\n  --by-not-a-token: 1px;");
  const result = importTheme(text, { name: "Edited Classic" });
  assert.equal(result.theme!["name"], "edited-classic");
  const overrides = result.theme!["overrides"] as Record<string, unknown>;
  assert.equal(overrides["radius.lg"], "14px");
  assert.deepEqual(overrides["color.fg.link"], { dark: "{color.brand-dark.12}" });
  assert.deepEqual(result.diagnostics.map((d) => d.rule), ["import-unmapped"]);
  assert.match(result.diagnostics[0]!.message, /--by-not-a-token/);
});

test("a theme file passes through readThemeFile; formats are detected; unreadable text is an error", () => {
  const paper = preset("paper");
  const result = importTheme(JSON.stringify(paper), { name: "mine" });
  assert.deepEqual([result.format, result.theme!["name"], result.theme!["$schema"]], ["theme", "mine", undefined]);
  assert.deepEqual(result.theme!["seeds"], paper["seeds"]);
  assert.equal(detectImportFormat(":root { --by-radius-md: 4px; }"), "css");
  assert.equal(detectImportFormat(":root { --background: oklch(1 0 0); }"), "shadcn");
  assert.equal(detectImportFormat('{ "color": { "x": { "$value": "#fff" } } }'), "dtcg");
  assert.equal(detectImportFormat("hello"), undefined);
  const bad = importTheme("hello");
  assert.deepEqual([bad.ok, bad.diagnostics[0]!.rule], [false, "import-unreadable"]);
  assert.equal(importTheme("{ not json", { format: "dtcg" }).ok, false);
  assert.equal(importTheme(":root { --by-x: 1px }", { name: "!!!" }).ok, false);
});

test("shadcn colours: oklch, hex, hsl() and the bare HSL triplets of v3", () => {
  assert.equal(oklchToHex(parseShadcnColor("221.2 83.2% 53.3%")!), "#2563eb");
  assert.equal(oklchToHex(parseShadcnColor("hsl(221.2 83.2% 53.3%)")!), "#2563eb");
  assert.equal(oklchToHex(parseShadcnColor("hsl(0, 0%, 100%)")!), "#ffffff");
  assert.equal(parseShadcnColor("oklch(1 0 0 / 10%)")!.alpha, 0.1);
  assert.equal(parseShadcnColor("0 0% 100% / 0.5")!.alpha, 0.5);
  assert.equal(parseShadcnColor("not a colour"), undefined);
});

test("a stock shadcn globals.css (v4, oklch): seeds from its colours, each colour on the ramp step its role uses", () => {
  const result = importTheme(fixture("shadcn-v4.css"), { name: "neutral" });
  assert.equal(result.format, "shadcn");
  const theme = result.theme!;
  const seeds = theme["seeds"] as { colors: Record<string, { hue: number; chroma: number }>; radius: number };
  assert.equal(seeds.radius, 10, "--radius 0.625rem is radius.md, 10px");
  assert.deepEqual(seeds.colors["brand"], { hue: 0, chroma: 0 }, "a greyscale --primary");
  assert.deepEqual(seeds.colors["red"], { hue: 27.3, chroma: 0.245 });
  const overrides = theme["overrides"] as Record<string, string>;
  assert.equal(overrides["color.brand.9"], "oklch(0.205 0 0)", "--primary (light) on the accent solid's step");
  assert.equal(overrides["color.brand-dark.9"], "oklch(0.922 0 0)", "--primary (dark)");
  assert.equal(overrides["color.neutral.11"], "oklch(0.556 0 0)", "--muted-foreground");
  // Translucent colours are not put on opaque steps; shared steps keep the first colour; both are said.
  assert.ok(result.diagnostics.some((d) => d.rule === "import-approximated" && /--border \(dark\) is translucent/.test(d.message)));
  assert.ok(result.diagnostics.some((d) => d.rule === "import-approximated" && /--ring \(light\) and --primary \(light\) both land on color\.brand\.9/.test(d.message)));
  // It validates like any theme; the engine's fixes take it to zero errors.
  assert.equal(fixAll(theme).diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("a shadcn v3 globals.css (HSL triplets): a blue brand; unknown variables are reported", () => {
  const result = importTheme(fixture("shadcn-v3.css"));
  const seeds = result.theme!["seeds"] as { colors: Record<string, { hue: number }>; radius: number };
  assert.equal(result.theme!["name"], "imported");
  assert.equal(seeds.radius, 8);
  assert.ok(Math.abs(seeds.colors["brand"]!.hue - 262.9) < 0.1);
  assert.equal(oklchToHex(parseShadcnColor((result.theme!["overrides"] as Record<string, string>)["color.brand.9"]!)!), "#2563eb");
  assert.ok(result.diagnostics.some((d) => d.rule === "import-unmapped" && d.message.includes("--font-heading")));
});

const scratch = mkdtempSync(join(tmpdir(), "by-tokens-import-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

async function cli(...argv: string[]) {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd: scratch });
  return { code, stdout, stderr, json: argv.includes("--json") ? JSON.parse(stdout) : undefined };
}

test("by-tokens import prints exactly importTheme's text; --out writes it; exit 1 when the theme breaks a rule", async () => {
  const file = join(ROOT, "test", "fixtures", "shadcn-v4.css");
  const printed = await cli("import", file, "--name", "neutral");
  assert.equal(printed.stdout, importTheme(fixture("shadcn-v4.css"), { name: "neutral" }).text, "byte for byte");
  assert.equal(printed.code, EXIT.invalid, "stock shadcn colours fail some contrast pairs");
  assert.match(printed.stderr, /by-tokens fix/);

  const written = await cli("import", join(ROOT, "generated", "slate", "tokens.css"), "--out", "slate-copy.theme.json", "--json");
  assert.deepEqual([written.code, written.json.format, written.json.written], [EXIT.ok, "css", "slate-copy.theme.json"]);
  assert.equal(readFileSync(join(scratch, "slate-copy.theme.json"), "utf8"), importTheme(readFileSync(join(ROOT, "generated", "slate", "tokens.css"), "utf8")).text);

  assert.equal((await cli("import", "missing.css", "--json")).json.error.code, "file-not-found");
  assert.equal((await cli("import", file, "--format", "scss", "--json")).code, EXIT.usage);
});
