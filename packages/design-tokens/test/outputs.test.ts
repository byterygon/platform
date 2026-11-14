import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

import { OUTPUT_FILES, buildTheme, committedOutputs } from "../src/build.js";
import { EXTENSION } from "../src/model.js";
import { ROOT, defaultTheme, themeWith } from "./helpers.js";

const generated = (name: string) => join(ROOT, "generated", "default", name);

const PRESETS = readdirSync(join(ROOT, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => file.slice(0, -".theme.json".length))
  .sort();

test("the six presets are the ones the spec names", () => {
  assert.deepEqual(PRESETS, ["default", "high-contrast", "midnight", "paper", "slate", "terminal"]);
});

for (const preset of PRESETS) {
  test(`the committed outputs of the ${preset} theme are current (drift check)`, async () => {
    const theme = JSON.parse(readFileSync(join(ROOT, "themes", `${preset}.theme.json`), "utf8"));
    const result = await buildTheme(theme, { source: `themes/${preset}.theme.json` });
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics.filter((d) => d.severity === "error")));
    assert.deepEqual([...result.files!.keys()], [...OUTPUT_FILES], "every output renders for every preset");
    const committed = committedOutputs(preset);
    const command = `pnpm --filter @byterygon/design-tokens tokens build --theme ${preset}`;
    for (const name of committed) {
      const path = join(ROOT, "generated", preset, name);
      assert.ok(existsSync(path), `generated/${preset}/${name} is missing; run \`${command}\``);
      assert.ok(readFileSync(path, "utf8") === result.files!.get(name), `generated/${preset}/${name} is stale; run \`${command}\` and commit the result`);
    }
    assert.deepEqual(readdirSync(join(ROOT, "generated", preset)).sort(), [...committed].sort(), "nothing else is committed");
  });
}

test("the default theme commits all six outputs, the other presets the three CSS files", () => {
  assert.deepEqual([...committedOutputs("default")], [...OUTPUT_FILES]);
  for (const preset of PRESETS.filter((name) => name !== "default")) {
    assert.deepEqual([...committedOutputs(preset)], ["tokens.css", "tailwind-theme.css", "shadcn-alias.css"]);
  }
  assert.deepEqual(readdirSync(join(ROOT, "generated")).sort(), PRESETS, "every preset has an output directory and every directory a preset");
});

test("the build is reproducible and renders nothing when a rule fails", async () => {
  const a = await buildTheme(defaultTheme());
  const b = await buildTheme(defaultTheme());
  assert.deepEqual([...a.files!], [...b.files!]);
  const broken = await buildTheme(themeWith({ "color.fg.link": "{color.brand.13}" }));
  assert.equal(broken.ok, false);
  assert.equal(broken.files, undefined);
});

/** Declarations of every rule whose selector list contains `selector`. */
function declarations(css: string, selector: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(",").map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const line of match[2]!.split(";")) {
      const colon = line.indexOf(":");
      if (colon > 0) out.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  return out;
}

test("tokens.css: primitives once, roles per mode, references by var()", async () => {
  const css = (await buildTheme(defaultTheme())).files!.get("tokens.css")!;
  const root = declarations(css, ":root");
  const dark = declarations(css, '[data-theme="dark"]');
  const compact = declarations(css, '[data-density="compact"]');

  assert.match(root.get("--by-color-neutral-1")!, /^oklch\(/);
  assert.equal(root.get("--by-color-bg-canvas"), "var(--by-color-neutral-1)");
  assert.equal(dark.get("--by-color-bg-canvas"), "var(--by-color-neutral-dark-2)");
  assert.equal(root.get("color-scheme"), "light");
  assert.equal(dark.get("color-scheme"), "dark");
  assert.deepEqual(declarations(css, ".dark"), dark);
  assert.equal(dark.has("--by-color-neutral-1"), false, "primitives are not repeated per mode");
  assert.equal(dark.has("--by-size-control-md"), false, "density roles are not in the theme block");
  assert.equal(root.get("--by-size-control-md"), "36px");
  assert.equal(compact.get("--by-size-control-md"), "28px");
  assert.equal(root.get("--by-radius-md"), "6px");
  assert.equal(root.get("--by-font-mono"), '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace');
  assert.equal(root.get("--by-shadow-raised"), "0 1px 2px 0 var(--by-color-black-a2), 0 1px 1px 0 var(--by-color-black-a1)");
  // No raw colour outside the primitive tier: every colour role is a var().
  for (const block of [root, dark]) {
    for (const [name, value] of block) {
      if (/^--by-color-(bg|fg|border|ring|accent|interactive|status)/.test(name)) assert.match(value, /^var\(--by-color-/, name);
    }
  }
  // Every var() points at a declared variable.
  for (const [, target] of css.matchAll(/var\((--by-[a-z0-9-]+)\)/g)) assert.ok(root.has(target!), `${target} is declared`);
});

test("a dark-first, compact theme moves :root to those modes", async () => {
  const css = (await buildTheme(themeWith({}, { colorScheme: "dark", density: "compact" }))).files!.get("tokens.css")!;
  const root = declarations(css, ":root");
  assert.equal(root.get("color-scheme"), "dark");
  assert.equal(root.get("--by-color-bg-canvas"), "var(--by-color-neutral-dark-2)");
  assert.equal(root.get("--by-size-control-md"), "28px");
  assert.equal(declarations(css, '[data-theme="light"]').get("--by-color-bg-canvas"), "var(--by-color-neutral-1)");
  assert.ok(css.indexOf('[data-theme="dark"]') < css.indexOf('[data-theme="light"]'), "the default mode comes first");
});

test("the variable names the first components were written against exist (TSK-42 contract)", async () => {
  const files = (await buildTheme(defaultTheme())).files!;
  const root = declarations(files.get("tokens.css")!, ":root");
  const roles = [
    ...["canvas", "surface", "raised", "overlay", "inset"].map((n) => `--by-color-bg-${n}`),
    ...["default", "muted", "subtle", "disabled", "link", "on-accent"].map((n) => `--by-color-fg-${n}`),
    ...["border-default", "border-strong", "ring"].map((n) => `--by-color-${n}`),
    ...["bg", "bg-hover", "bg-active", "subtle-bg", "subtle-fg"].map((n) => `--by-color-accent-${n}`),
    ...["hover", "active", "selected"].map((n) => `--by-color-interactive-${n}`),
    ...["danger-solid", "danger-solid-hover", "danger-fg", "danger-bg", "warning-fg", "warning-bg", "success-fg", "success-bg", "info-fg", "info-bg"].map((n) => `--by-color-status-${n}`),
    ...["sm", "md", "lg"].map((n) => `--by-radius-${n}`),
    ...["xs", "sm", "md", "lg"].map((n) => `--by-size-control-${n}`),
    "--by-space-control-x",
    "--by-font-sans",
    "--by-font-mono",
    "--by-shadow-raised",
  ];
  for (const name of roles) assert.ok(root.has(name), name);

  const tailwind = files.get("tailwind-theme.css")!;
  assert.match(tailwind, /@custom-variant dark \(&:where\(\[data-theme="dark"\], \[data-theme="dark"\] \*, \.dark, \.dark \*\)\);/);
  assert.match(tailwind, /@theme inline \{/);
  // TSK-42: Byterygon components use accent-solid*, because shadcn's bg-accent is a hover colour.
  for (const line of ["--color-accent-solid: var(--by-color-accent-bg);", "--color-accent-solid-hover: var(--by-color-accent-bg-hover);", "--color-accent-solid-active: var(--by-color-accent-bg-active);", "--color-accent-solid-fg: var(--by-color-accent-fg);", "--color-surface: var(--by-color-bg-surface);", "--color-fg-muted: var(--by-color-fg-muted);", "--color-pressed: var(--by-color-interactive-active);", "--color-danger-subtle: var(--by-color-status-danger-bg);", "--radius-md: var(--by-radius-md);", "--spacing-control-md: var(--by-size-control-md);", "--shadow-raised: var(--by-shadow-raised);"]) {
    assert.ok(tailwind.includes(line), line);
  }

  const shadcn = declarations(files.get("shadcn-alias.css")!, ":root");
  assert.equal(shadcn.get("--background"), "var(--by-color-bg-canvas)");
  assert.equal(shadcn.get("--primary-foreground"), "var(--by-color-fg-on-accent)");
  assert.equal(shadcn.get("--radius"), "var(--by-radius-md)");
  // The 19 names the first components use keep their targets; the catalogue only adds to them.
  const pinned: Record<string, string> = {
    "--background": "bg-canvas",
    "--foreground": "fg-default",
    "--card": "bg-surface",
    "--card-foreground": "fg-default",
    "--popover": "bg-overlay",
    "--popover-foreground": "fg-default",
    "--primary": "accent-bg",
    "--primary-foreground": "fg-on-accent",
    "--secondary": "bg-inset",
    "--secondary-foreground": "fg-default",
    "--muted": "bg-inset",
    "--muted-foreground": "fg-muted",
    "--accent": "interactive-hover",
    "--accent-foreground": "fg-default",
    "--destructive": "status-danger-solid",
    "--border": "border-default",
    "--input": "border-strong",
    "--ring": "ring",
    "--radius": "radius-md",
  };
  assert.equal(Object.keys(pinned).length, 19);
  for (const [name, role] of Object.entries(pinned)) {
    assert.equal(shadcn.get(name), name === "--radius" ? "var(--by-radius-md)" : `var(--by-color-${role})`, name);
  }
  for (const name of ["--destructive-foreground", "--chart-1", "--chart-5", "--sidebar", "--sidebar-primary-foreground", "--sidebar-ring"]) {
    assert.ok(shadcn.has(name), `${name} is mapped too`);
  }
  // Redeclared in every theme scope, or a nested scope would inherit the outer theme's value.
  assert.deepEqual(declarations(files.get("shadcn-alias.css")!, '[data-theme="dark"]'), shadcn);
});

test("tokens.dtcg.json is a DTCG document with every mode", async () => {
  const dtcg = JSON.parse((await buildTheme(defaultTheme())).files!.get("tokens.dtcg.json")!);
  const primitive = dtcg.color.neutral["1"];
  assert.equal(primitive.$type, "color");
  assert.equal(primitive.$value.colorSpace, "oklch");
  assert.equal(primitive.$value.components.length, 3);
  assert.match(primitive.$value.hex, /^#[0-9a-f]{6}$/);
  assert.equal(primitive.$extensions[EXTENSION].tier, "primitive");
  const role = dtcg.color.bg.canvas;
  assert.equal(role.$value, "{color.neutral.1}");
  assert.deepEqual(role.$extensions[EXTENSION].modes, { light: "{color.neutral.1}", dark: "{color.neutral-dark.2}" });
  assert.equal(role.$extensions[EXTENSION].axis, "theme");
  assert.ok(role.$description.length > 20);
  assert.deepEqual(dtcg.size.control.md.$value, { value: 36, unit: "px" });
  assert.equal(dtcg.shadow.raised.$value[0].color, "{color.black.a2}");
  assert.deepEqual(dtcg.$extensions[EXTENSION].axes.map((a: { name: string }) => a.name), ["theme", "density"]);
});

test("figma-variables.json groups variables into collections with modes", async () => {
  const figma = JSON.parse((await buildTheme(defaultTheme())).files!.get("figma-variables.json")!);
  const collection = (name: string) => figma.collections.find((c: { name: string }) => c.name === name);
  assert.deepEqual(figma.collections.map((c: { name: string }) => c.name), ["Primitives", "Semantic", "Theme", "Density"]);
  assert.deepEqual(collection("Theme").modes, ["Light", "Dark"]);
  assert.deepEqual(collection("Density").modes, ["Comfortable", "Compact"]);
  const variable = (name: string, path: string) => collection(name).variables.find((v: { name: string }) => v.name === path);
  const white = variable("Primitives", "color/base/white");
  assert.deepEqual(white.valuesByMode, { Value: { r: 1, g: 1, b: 1, a: 1 } });
  assert.deepEqual([white.type, white.scopes, white.hiddenFromPublishing], ["COLOR", [], true]);
  const canvas = variable("Theme", "color/bg/canvas");
  assert.deepEqual(canvas.valuesByMode.Dark, { type: "VARIABLE_ALIAS", collection: "Primitives", name: "color/neutral-dark/2" });
  assert.equal(canvas.codeSyntax.WEB, "var(--by-color-bg-canvas)");
  assert.deepEqual(variable("Density", "size/control/md").valuesByMode, { Comfortable: 36, Compact: 28 });
  assert.deepEqual(variable("Semantic", "radius/md").valuesByMode, { Value: 6 });
  assert.equal(variable("Semantic", "font/sans").valuesByMode.Value, "Inter");
  // Figma has no variable for a shadow or an easing curve; everything else is a variable.
  const skipped = figma.skipped.map((s: { token: string }) => s.token);
  assert.ok(skipped.includes("shadow.raised") && skipped.includes("shadow.3") && skipped.includes("elevation.modal.shadow") && skipped.includes("motion.easing.standard"));
  assert.ok(skipped.every((token: string) => /^(shadow\.|elevation\..*\.shadow$|motion\.easing\.)/.test(token)), skipped.join(", "));
  assert.deepEqual(variable("Density", "space/inline/md").valuesByMode, {
    Comfortable: { type: "VARIABLE_ALIAS", collection: "Primitives", name: "space/2" },
    Compact: { type: "VARIABLE_ALIAS", collection: "Primitives", name: "space/1-5" },
  });
  assert.deepEqual(variable("Primitives", "motion/duration/base").valuesByMode, { Value: 160 });
  assert.deepEqual(variable("Primitives", "z/modal").valuesByMode, { Value: 400 });
  // Every alias points at a variable that exists.
  for (const c of figma.collections) {
    for (const v of c.variables) {
      for (const value of Object.values(v.valuesByMode) as { type?: string; collection: string; name: string }[]) {
        if (value?.type === "VARIABLE_ALIAS") assert.ok(variable(value.collection, value.name), `${v.name} -> ${value.name}`);
      }
    }
  }
});

test("tokens.ts exports typed constants with the resolved value per mode", async () => {
  const module = (await import("../generated/default/tokens.js")) as typeof import("../generated/default/tokens.js");
  assert.equal(module.theme.name, "default");
  assert.equal(module.tokens["color.bg.surface"].cssVar, "--by-color-bg-surface");
  assert.equal(module.tokens["color.bg.surface"].values.light, "oklch(1 0 0)");
  assert.match(module.tokens["color.bg.surface"].values.dark, /^oklch\(0\.21 /);
  assert.equal(module.tokens["radius.md"].values.base, "6px");
  assert.equal(module.tokens["size.control.md"].values.compact, "28px");
  assert.equal(module.cssVar("color.fg.muted"), "var(--by-color-fg-muted)");
  assert.ok(module.tokens["color.fg.muted"].description.length > 20);
});

test("the engine and the colour module are browser-safe: no Node, no dependencies", () => {
  const build = resolvePath(dirname(new URL(import.meta.url).pathname), "..", "src");
  const visit = (entry: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const text = readFileSync(entry, "utf8");
    assert.doesNotMatch(text, /\bprocess\.|\bBuffer\b|\brequire\(/, `${entry} uses a Node global`);
    for (const [, specifier] of text.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      assert.ok(specifier!.startsWith("."), `${entry} imports "${specifier}"; the engine must have no Node or package imports`);
      visit(resolvePath(dirname(entry), specifier!), seen);
    }
    return seen;
  };
  const color = visit(join(build, "color", "index.js"));
  assert.ok([...color].every((file) => file.includes(`${join("src", "color")}`)), "the colour module imports nothing outside its folder");
  const engine = visit(join(build, "index.js"));
  assert.ok(engine.size > color.size);
  assert.ok(![...engine].some((file) => /outputs\.js$|build\.js$|cli/.test(file)), "the engine does not pull in Style Dictionary or the CLI");
});
