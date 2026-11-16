// The package's rules (DBee spec §6 and the TSK-39 checklist): only React and the Ambidex Arrow
// types at runtime, no apache-arrow, no grid library, no network, and a stylesheet made of
// design-token roles only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokens } from "@byterygon/design-tokens/default/tokens";
import { describe, expect, test } from "vitest";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");
const sources = readdirSync(src)
  .filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ file: f, text: readFileSync(join(src, f), "utf8") }));
const css = readFileSync(join(src, "data-grid.css"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  license: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

describe("runtime dependencies", () => {
  test("src imports only React, @byterygon/ambidex/arrow and its own modules", () => {
    const allowed = /^(react|react\/jsx-runtime|react-dom|@byterygon\/ambidex\/arrow|\.\/[\w-]+\.tsx?)$/;
    for (const { file, text } of sources) {
      for (const [, spec] of text.matchAll(/\bfrom\s+"([^"]+)"/g)) expect(`${file}: ${spec}`).toMatch(new RegExp(`: ${allowed.source.slice(1)}`));
      expect(text, file).not.toMatch(/\bimport\s*\(/);
    }
  });

  test("no network: no fetch, XHR, WebSocket, EventSource, beacon or remote URL", () => {
    for (const { file, text } of sources) {
      expect(text, file).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|https?:\/\//);
    }
    expect(css).not.toMatch(/url\(|@import/);
  });

  test("package.json: permissive, React as a peer, Ambidex the only dependency", () => {
    expect(pkg.license).toBe("MIT OR Apache-2.0");
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@byterygon/ambidex"]);
    expect(Object.keys(pkg.peerDependencies ?? {}).sort()).toEqual(["react", "react-dom"]);
  });
});

describe("stylesheet", () => {
  const known = new Set(Object.values(tokens).map((t) => (t as { cssVar: string }).cssVar));
  const body = css.replace(/\/\*[\s\S]*?\*\//g, "");

  test("every var() names a design token", () => {
    const used = [...body.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((v) => !known.has(v))).toEqual([]);
  });

  test("no colour, length or font outside the tokens", () => {
    expect(body).not.toMatch(/#[0-9a-f]{3,8}\b|\b(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color-mix)\(/i);
    expect(body).not.toMatch(/\d(px|rem|em|ch|vh|vw|pt)\b/);
    expect(body).not.toMatch(/font-family:(?!\s*var\()/);
    expect(body).not.toMatch(/:[^;{}]*\b(red|blue|green|black|white|gray|grey|transparent|currentcolor)\b/i);
  });
});
