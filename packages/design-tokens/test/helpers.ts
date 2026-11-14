import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../src/cli/main.js";
import type { ThemeFile } from "../src/model.js";

export const ROOT = packageRoot();

export function defaultTheme(): ThemeFile {
  return JSON.parse(readFileSync(join(ROOT, "themes", "default.theme.json"), "utf8")) as ThemeFile;
}

/** The default theme with extra overrides and seeds. */
export function themeWith(overrides: Record<string, unknown> = {}, seeds: Record<string, unknown> = {}): ThemeFile {
  const base = defaultTheme();
  return { ...base, name: "test", seeds: { ...base.seeds, ...seeds }, overrides: { ...base.overrides, ...overrides } };
}
