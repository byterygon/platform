// Where the Studio keeps its state: the URL hash (so a state is addressable and survives a reload)
// and browser storage (so closing the tab and opening the Studio again, even from file://, comes
// back to the same theme). Both hold the same string: the versioned hash of
// @byterygon/design-tokens (`#by=1&theme=...&mode=...&density=...`, AGENTS.md "Studio state"),
// encoded and decoded only by its `encodeState` and `decodeState`. Nothing is sent anywhere.
import { type Diagnostic, type StudioState, decodeState, encodeState } from "@byterygon/design-tokens";
import type { ThemeDoc } from "./theme-edit.ts";

/** The browser-storage key. The value is a Studio hash, so it carries its own version. */
export const STORAGE_KEY = "byterygon.theme-studio.state";

export interface View {
  readonly mode: "light" | "dark";
  readonly density: "comfortable" | "compact";
}

export interface Loaded {
  readonly theme: ThemeDoc;
  readonly view: View;
  /** Where the state came from. */
  readonly source: "hash" | "storage" | "default";
  /** Warnings from reading a newer version, and why a hash or a stored state was not used. */
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * A new theme: no seeds and no overrides, so every value is the engine's default (the tokens are
 * those of the built-in `default` preset) and every edit shows up as one line in the file.
 */
export function startingTheme(): ThemeDoc {
  return { schemaVersion: 1, name: "my-theme" };
}

const seedScheme = (theme: ThemeDoc): View["mode"] => ((theme["seeds"] as { colorScheme?: string } | undefined)?.colorScheme === "dark" ? "dark" : "light");
const seedDensity = (theme: ThemeDoc): View["density"] => ((theme["seeds"] as { density?: string } | undefined)?.density === "compact" ? "compact" : "comfortable");

function fromState(state: StudioState): { theme: ThemeDoc; view: View } {
  const theme = state.theme;
  return { theme, view: { mode: state.mode ?? seedScheme(theme), density: state.density ?? seedDensity(theme) } };
}

/** Storage that may be missing or throw (privacy modes, quotas, some file:// setups). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function safeStorage(): StorageLike | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * The state to open with: the URL hash when it holds a Studio state, else the last state kept in
 * storage, else the default theme. A hash that does not decode is reported and skipped.
 */
export async function loadState(hash: string, storage: StorageLike | undefined = safeStorage()): Promise<Loaded> {
  const diagnostics: Diagnostic[] = [];
  if (/(^|[#&])by=/.test(hash)) {
    const decoded = await decodeState(hash);
    diagnostics.push(...decoded.diagnostics);
    if (decoded.ok) return { ...fromState(decoded.state!), source: "hash", diagnostics };
  }
  let stored: string | null = null;
  try {
    stored = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  if (stored) {
    const decoded = await decodeState(stored);
    diagnostics.push(...decoded.diagnostics.map((d) => ({ ...d, message: `saved state: ${d.message}` })));
    if (decoded.ok) return { ...fromState(decoded.state!), source: "storage", diagnostics };
  }
  const theme = startingTheme();
  return { theme, view: { mode: seedScheme(theme), density: seedDensity(theme) }, source: "default", diagnostics };
}

/** The hash for a state. */
export const stateHash = (theme: ThemeDoc, view: View) => encodeState({ theme, mode: view.mode, density: view.density });

/** Writes the hash to the address bar (without a history entry) and to storage. */
export function saveState(hash: string, storage: StorageLike | undefined = safeStorage(), history: Pick<History, "replaceState"> | undefined = globalThis.history): void {
  try {
    history?.replaceState(null, "", hash);
  } catch {
    // Some embedders forbid it; storage still keeps the state.
  }
  try {
    storage?.setItem(STORAGE_KEY, hash);
  } catch {
    // Storage full or disabled: the hash still holds the state.
  }
}
