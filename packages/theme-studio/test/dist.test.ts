// The built Studio (dist/, written by `pnpm build`, which CI runs before the tests) must run from a
// folder: a classic script, no module preload, no `crossorigin`, every asset inlined, and nothing
// that points at another origin. The real browser run, from file:// and from a server with every
// request recorded, is the browser check (batch 3 of TSK-48).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const dist = join(import.meta.dirname, "..", "dist");
const built = existsSync(join(dist, "index.html"));

describe.skipIf(!built && !process.env["CI"])("dist/ runs from a folder, offline", () => {
  test("three files: the page, one classic script, one stylesheet", () => {
    expect(readdirSync(dist).sort()).toEqual(["index.html", "studio.css", "studio.js"]);
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toContain('<script defer src="./studio.js"></script>');
    expect(html).toContain('<link rel="stylesheet" href="./studio.css">');
    expect(html).not.toMatch(/type="module"|crossorigin|modulepreload/);
  });

  test("the page forbids every connection, and names no other origin", () => {
    const html = readFileSync(join(dist, "index.html"), "utf8");
    expect(html).toMatch(/Content-Security-Policy[^>]*connect-src 'none'/);
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
  });

  test("the stylesheet inlines its fonts and loads nothing", () => {
    const css = readFileSync(join(dist, "studio.css"), "utf8");
    const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(4);
    expect(urls.filter((url) => !url.startsWith("data:"))).toEqual([]);
    expect(css).not.toMatch(/@import/);
  });

  test("the script has no module syntax and no worker file to fetch", () => {
    const js = readFileSync(join(dist, "studio.js"), "utf8");
    expect(js).not.toMatch(/\bimport\s*\(\s*["'`]\.|new Worker\(new URL\(/);
  });
});
