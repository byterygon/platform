// Spec section 9a.1 and the TSK-48 definition of done: every export the Studio offers is what
// `by-tokens export` prints for the same theme file, byte for byte, for every built-in preset and
// every format. The Studio side is `studioExport`, the function its Export panel calls; the CLI side
// is `by-tokens` itself (its `run`, and for one preset the installed binary in a child process).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXPORT_FORMATS } from "@byterygon/design-tokens/build";
import { afterAll, describe, expect, test } from "vitest";
import { studioExport } from "../src/panels/export-panel.tsx";
import { studioImport } from "../src/panels/import-panel.tsx";
import { setOverride, setSeed } from "../src/state/theme-edit.ts";

const tokens = join(import.meta.dirname, "..", "..", "design-tokens");
const { run } = (await import(join(tokens, "dist", "cli", "main.js"))) as { run: (argv: string[], io: { stdout: (t: string) => void; stderr: (t: string) => void; cwd: string }) => Promise<number> };

const scratch = mkdtempSync(join(tmpdir(), "theme-studio-parity-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PRESETS = readdirSync(join(tokens, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => JSON.parse(readFileSync(join(tokens, "themes", file), "utf8")) as Record<string, unknown>);

/** The theme saved the way the Studio's theme-file export names it, so headers name the same file. */
function save(theme: Record<string, unknown>): string {
  const file = join(scratch, `${String(theme["name"])}.theme.json`);
  writeFileSync(file, JSON.stringify(theme, null, 2));
  return file;
}

async function cli(...argv: string[]): Promise<string> {
  let stdout = "";
  let stderr = "";
  const code = await run(argv, { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), cwd: scratch });
  expect(code, stderr).toBe(0);
  return stdout;
}

const edited = (() => {
  let theme: Record<string, unknown> = { schemaVersion: 1, name: "studio-edit" };
  theme = setSeed(theme, ["colors", "brand", "hue"], 20);
  theme = setSeed(theme, ["colors", "brand", "chroma"], 0.18);
  theme = setSeed(theme, ["radius"], 10);
  theme = setSeed(theme, ["density"], "compact");
  theme = setOverride(theme, "font.sans", ["IBM Plex Sans", "system-ui", "sans-serif"]);
  theme = setOverride(theme, "color.fg.link", "{color.brand-dark.12}", "dark", ["light", "dark"]);
  return theme;
})();

describe("Studio and by-tokens export the same bytes", () => {
  for (const theme of [...PRESETS, { schemaVersion: 1, name: "my-theme" }, edited]) {
    test(`${String(theme["name"])}: every format`, async () => {
      const file = save(theme);
      for (const { format } of EXPORT_FORMATS) {
        const studio = await studioExport(theme, format);
        expect(studio.ok, `${format}: ${JSON.stringify(studio.diagnostics.filter((d) => d.severity === "error"))}`).toBe(true);
        const printed = await cli("export", format, "--theme", file);
        expect(studio.content === printed, `${String(theme["name"])} ${format} differs between the Studio and by-tokens`).toBe(true);
      }
    });
  }

  test("the installed by-tokens binary prints the same bytes (paper, every format)", async () => {
    const paper = PRESETS.find((theme) => theme["name"] === "paper")!;
    const file = save(paper);
    for (const { format } of EXPORT_FORMATS) {
      const printed = execFileSync(process.execPath, [join(tokens, "bin", "by-tokens.js"), "export", format, "--theme", file], { cwd: scratch, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      expect((await studioExport(paper, format)).content === printed, `paper ${format}`).toBe(true);
    }
  });

  test("the theme file the Studio exports builds to the same outputs", async () => {
    const exported = JSON.parse((await studioExport(edited, "theme")).content!) as Record<string, unknown>;
    expect(exported["seeds"]).toMatchObject({ radius: 10, density: "compact", colors: { brand: { hue: 20, chroma: 0.18 } } });
    for (const format of ["css", "registry", "monaco"] as const) {
      expect((await studioExport(exported, format)).content === (await studioExport(edited, format)).content, format).toBe(true);
    }
  });

  test("a theme that breaks a rule exports nothing, in the Studio as in by-tokens", async () => {
    const broken = setOverride({ schemaVersion: 1, name: "broken" }, "color.fg.link", "#ff0000");
    const result = await studioExport(broken, "css");
    expect(result.ok).toBe(false);
    expect(result.content).toBeUndefined();
    let code = -1;
    await run(["export", "css", "--theme", save(broken)], { stdout: () => {}, stderr: () => {}, cwd: scratch }).then((c) => (code = c));
    expect(code).toBe(1);
  });
}, 240_000);

describe("Studio and by-tokens import the same bytes", () => {
  const fixtures = join(tokens, "test", "fixtures");
  const sources: [label: string, file: string, format: "auto" | "css" | "dtcg" | "shadcn" | "theme", name: string][] = [
    ["shadcn v4 (oklch)", join(fixtures, "shadcn-v4.css"), "auto", ""],
    ["shadcn v3 (HSL), named", join(fixtures, "shadcn-v3.css"), "shadcn", "ocean"],
    ["a preset's tokens.css", join(tokens, "generated", "paper", "tokens.css"), "auto", ""],
    ["a theme file", join(tokens, "themes", "terminal.theme.json"), "auto", "my-terminal"],
  ];
  for (const [label, file, format, name] of sources) {
    test(label, async () => {
      const studio = studioImport(readFileSync(file, "utf8"), format, name);
      expect(studio.ok).toBe(true);
      let stdout = "";
      await run(["import", file, ...(format === "auto" ? [] : ["--format", format]), ...(name ? ["--name", name] : [])], { stdout: (t) => (stdout += t), stderr: () => {}, cwd: scratch });
      expect(studio.text === stdout, `${label}: the Studio's theme file differs from by-tokens import`).toBe(true);
    });
  }

  test("a DTCG export (default), through the installed binary", async () => {
    const dtcg = join(scratch, "default.tokens.dtcg.json");
    writeFileSync(dtcg, (await studioExport(PRESETS.find((t) => t["name"] === "default")!, "dtcg")).content!);
    const printed = execFileSync(process.execPath, [join(tokens, "bin", "by-tokens.js"), "import", dtcg], { cwd: scratch, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    expect(studioImport(readFileSync(dtcg, "utf8"), "auto", "").text === printed).toBe(true);
  });
}, 240_000);
