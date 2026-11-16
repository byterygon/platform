import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { generateTokens } from "../src/generate.js";
import { ROOT, defaultTheme } from "./helpers.js";

interface Manifest {
  fonts: { family: string; license: string; licenseFiles: string[]; files: { path: string; sha256: string }[] }[];
}

const fonts = join(ROOT, "fonts");
const manifest = JSON.parse(readFileSync(join(fonts, "manifest.json"), "utf8")) as Manifest;

test("Inter and JetBrains Mono are vendored under the OFL with their licence texts and checksums", () => {
  assert.deepEqual(manifest.fonts.map((font) => font.family), ["Inter", "JetBrains Mono"]);
  for (const font of manifest.fonts) {
    assert.equal(font.license, "OFL-1.1");
    for (const file of font.licenseFiles) assert.ok(existsSync(join(fonts, file)), file);
    assert.match(readFileSync(join(fonts, font.licenseFiles[0]!), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
    for (const file of font.files) {
      assert.equal(createHash("sha256").update(readFileSync(join(fonts, file.path))).digest("hex"), file.sha256, file.path);
    }
  }
});

test("fonts.css declares exactly the vendored files, and the font roles name those families first", () => {
  const css = readFileSync(join(fonts, "fonts.css"), "utf8");
  const sources = [...css.matchAll(/url\("\.\/([^"]+)"\)/g)].map((match) => match[1]!).sort();
  assert.deepEqual(sources, manifest.fonts.flatMap((font) => font.files.map((file) => file.path)).sort());
  assert.doesNotMatch(css, /https?:\/\/(?!github)/, "no remote font source");
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /https?:/, "no URL outside a comment");

  const { set } = generateTokens(defaultTheme());
  const families = new Set([...css.matchAll(/font-family: "([^"]+)"/g)].map((match) => match[1]!));
  assert.deepEqual([...families].sort(), ["Inter", "JetBrains Mono"]);
  // The system's Segoe UI Variable first (never shipped), then the vendored Inter, which has
  // Vietnamese (Selawik, the first choice, lacked most of it: TSK-58).
  assert.deepEqual(set.tokens.get("font.sans")!.value, ["Segoe UI Variable Text", "Segoe UI Variable", "Segoe UI", "Inter", "system-ui", "sans-serif"]);
  // The system's Cascadia Mono first (not vendored), then the vendored JetBrains Mono.
  assert.deepEqual((set.tokens.get("font.mono")!.value as string[]).slice(0, 2), ["Cascadia Mono", "JetBrains Mono"]);
  // No Segoe or Cascadia file is ever shipped: Microsoft's licence does not allow Segoe's.
  for (const font of manifest.fonts) for (const file of font.files) assert.doesNotMatch(file.path, /segoe|cascadia/i);
  // Inter is variable: every weight Fluent's ramp asks for (400, 600, 700) is in its range.
  assert.match(css, /font-family: "Inter";\s+font-style: normal;\s+font-weight: 100 900;/);
  // The weights the type scale asks of the mono font are all there.
  const weights = [...css.matchAll(/font-family: "JetBrains Mono";\s+font-style: normal;\s+font-weight: (\d+)/g)].map((match) => Number(match[1]));
  assert.deepEqual(weights, [400, 500, 600, 700]);
});
