import { readFileSync } from "node:fs";
import { join } from "node:path";

import { packageRoot } from "../src/cli/main.js";
import type { ThemeFile } from "../src/model.js";

export const ROOT = packageRoot();

export function defaultTheme(): ThemeFile {
  return JSON.parse(readFileSync(join(ROOT, "themes", "default.theme.json"), "utf8")) as ThemeFile;
}

/**
 * The classic preset: the default before TSK-57 (no overrides but its fonts), so tests of the
 * engine's mechanics are not tied to the default's tuned overrides (Aurora's literal brand steps
 * would not follow a test's brand seed).
 */
export function classicTheme(): ThemeFile {
  return JSON.parse(readFileSync(join(ROOT, "themes", "classic.theme.json"), "utf8")) as ThemeFile;
}

/** The classic theme with extra overrides and seeds: the fixture of the engine's tests. */
export function themeWith(overrides: Record<string, unknown> = {}, seeds: Record<string, unknown> = {}): ThemeFile {
  const base = classicTheme();
  return { ...base, name: "test", seeds: { ...base.seeds, ...seeds }, overrides: { ...base.overrides, ...overrides } };
}
