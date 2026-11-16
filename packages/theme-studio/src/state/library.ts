// Themes saved in this browser (the presets gallery's "Saved in this browser"). One storage entry
// holds them all, as versioned JSON:
//
//   localStorage["byterygon.theme-studio.library"] =
//     {"version":1,"themes":[{"savedAt":"2026-11-16T10:00:00.000Z","theme":{...theme file...}}]}
//
// Each `theme` is a theme file, read through the engine's `readThemeFile` (a newer schemaVersion
// keeps what this version knows), so a saved theme is always one `by-tokens` can read. A theme's
// name is its key: saving a theme under a name that is already saved replaces that entry. Storage
// may be missing or throw (private windows, some file:// setups); reading then gives an empty list
// and writing reports failure, and the Studio says so instead of pretending to have saved.
import { type Diagnostic, readThemeFile } from "@byterygon/design-tokens";
import type { StorageLike } from "./persist.ts";
import type { ThemeDoc } from "./theme-edit.ts";

export const LIBRARY_KEY = "byterygon.theme-studio.library";
/** Version of the stored JSON; a newer one is read leniently, with a warning. */
export const LIBRARY_VERSION = 1;

export interface SavedTheme {
  readonly theme: ThemeDoc;
  /** ISO 8601. */
  readonly savedAt: string;
}

export interface Library {
  /** Newest first. */
  readonly themes: readonly SavedTheme[];
  readonly diagnostics: readonly Diagnostic[];
  /** False when there is no usable storage: nothing can be saved. */
  readonly available: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const themeName = (theme: ThemeDoc): string => (typeof theme["name"] === "string" ? theme["name"] : "");

function problem(message: string): Diagnostic {
  return { severity: "warning", rule: "library-unreadable", message, fix: { summary: "Saving a theme writes a new list; export the themes you need first." } };
}

export function readLibrary(storage: StorageLike | undefined): Library {
  if (!storage) return { themes: [], diagnostics: [], available: false };
  let text: string | null;
  try {
    text = storage.getItem(LIBRARY_KEY);
  } catch {
    return { themes: [], diagnostics: [], available: false };
  }
  if (text === null) return { themes: [], diagnostics: [], available: true };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { themes: [], diagnostics: [problem("the saved themes are not valid JSON and were not read")], available: true };
  }
  if (!isObject(parsed) || typeof parsed["version"] !== "number" || !Array.isArray(parsed["themes"])) {
    return { themes: [], diagnostics: [problem("the saved themes are not in a known format and were not read")], available: true };
  }
  const diagnostics: Diagnostic[] = [];
  if (parsed["version"] > LIBRARY_VERSION) {
    diagnostics.push({ severity: "warning", rule: "library-newer-version", measured: parsed["version"], required: LIBRARY_VERSION, message: `the saved themes were written by a newer Studio (version ${parsed["version"]}); what this version knows is shown` });
  }
  const themes: SavedTheme[] = [];
  for (const entry of parsed["themes"]) {
    if (!isObject(entry) || !isObject(entry["theme"])) continue;
    const read = readThemeFile(entry["theme"]);
    const theme = read.theme as ThemeDoc;
    if (!isObject(theme) || themeName(theme) === "" || themes.some((t) => themeName(t.theme) === themeName(theme))) continue;
    diagnostics.push(...read.diagnostics.map((d) => ({ ...d, message: `saved theme ${themeName(theme)}: ${d.message}` })));
    themes.push({ theme, savedAt: typeof entry["savedAt"] === "string" ? entry["savedAt"] : "" });
  }
  return { themes, diagnostics, available: true };
}

/** Writes the list; false when storage is missing, full or refuses. */
export function writeLibrary(themes: readonly SavedTheme[], storage: StorageLike | undefined): boolean {
  if (!storage) return false;
  try {
    storage.setItem(LIBRARY_KEY, JSON.stringify({ version: LIBRARY_VERSION, themes }));
    return true;
  } catch {
    return false;
  }
}

/** The list with `theme` saved first, replacing a saved theme of the same name. */
export function withSaved(themes: readonly SavedTheme[], theme: ThemeDoc, now: Date = new Date()): SavedTheme[] {
  const name = themeName(theme);
  return [{ theme: structuredClone(theme), savedAt: now.toISOString() }, ...themes.filter((t) => themeName(t.theme) !== name)];
}

/** The list without the theme named `name`. */
export function withoutSaved(themes: readonly SavedTheme[], name: string): SavedTheme[] {
  return themes.filter((t) => themeName(t.theme) !== name);
}
