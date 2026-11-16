import { PRESET_LABELS } from "@byterygon/design-tokens";
import { describe, expect, test } from "vitest";
import { tidy } from "../src/panels/color-picker.tsx";
import { SHARE_LINK_MAX, SHARE_LINK_WARN, shareLink } from "../src/panels/share-panel.tsx";
import { LIBRARY_KEY, readLibrary, withSaved, withoutSaved, writeLibrary } from "../src/state/library.ts";
import { PRESETS, presetTheme } from "../src/state/presets.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
}

const ocean = { schemaVersion: 1, name: "ocean", seeds: { radius: 9 } };
const forest = { schemaVersion: 1, name: "forest", seeds: { colors: { brand: { hue: 150 } } } };

describe("saved themes", () => {
  test("save, replace by name, remove; round-trip through storage as versioned JSON", () => {
    const storage = memoryStorage();
    expect(readLibrary(storage)).toEqual({ themes: [], diagnostics: [], available: true });
    let themes = withSaved([], ocean, new Date("2026-11-16T10:00:00Z"));
    themes = withSaved(themes, forest, new Date("2026-11-16T11:00:00Z"));
    themes = withSaved(themes, { ...ocean, seeds: { radius: 10 } }, new Date("2026-11-16T12:00:00Z"));
    expect(themes.map((t) => [t.theme["name"], t.savedAt])).toEqual([
      ["ocean", "2026-11-16T12:00:00.000Z"],
      ["forest", "2026-11-16T11:00:00.000Z"],
    ]);
    expect(writeLibrary(themes, storage)).toBe(true);
    expect(JSON.parse(storage.data.get(LIBRARY_KEY)!).version).toBe(1);
    const read = readLibrary(storage);
    expect(read.themes).toEqual(themes);
    expect(withoutSaved(read.themes, "ocean").map((t) => t.theme["name"])).toEqual(["forest"]);
  });

  test("no storage, a throwing storage, broken JSON and a newer version are handled", () => {
    expect(readLibrary(undefined).available).toBe(false);
    expect(writeLibrary([], undefined)).toBe(false);
    const throwing = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readLibrary(throwing).available).toBe(false);
    expect(writeLibrary([], throwing)).toBe(false);

    const broken = readLibrary(memoryStorage({ [LIBRARY_KEY]: "{not json" }));
    expect([broken.themes, broken.diagnostics[0]!.rule]).toEqual([[], "library-unreadable"]);

    const newer = readLibrary(
      memoryStorage({ [LIBRARY_KEY]: JSON.stringify({ version: 2, themes: [{ savedAt: "x", theme: { ...ocean, schemaVersion: 2, future: true } }, { theme: "junk" }] }) }),
    );
    expect(newer.themes.map((t) => t.theme)).toEqual([ocean]);
    expect(newer.diagnostics.map((d) => d.rule)).toEqual(["library-newer-version", "theme-newer-version", "theme-key-dropped"]);
  });
});

describe("presets, share link, hue label", () => {
  test("the bundled presets are the engine's, in its order, opened without $schema", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(Object.keys(PRESET_LABELS));
    const paper = PRESETS.find((p) => p.name === "paper")!;
    expect(paper.theme["$schema"]).toBe("../theme.schema.json");
    expect(presetTheme(paper)["$schema"]).toBeUndefined();
    expect(presetTheme(paper)["seeds"]).toEqual(paper.theme["seeds"]);
  });

  test("a share link keeps the page address and replaces the hash", () => {
    expect(shareLink("file:///opt/studio/index.html#by=1&theme=old", "#by=1&theme=new")).toBe("file:///opt/studio/index.html#by=1&theme=new");
    expect(shareLink("https://tools.internal/studio/", "#by=1&theme=x")).toBe("https://tools.internal/studio/#by=1&theme=x");
    expect(SHARE_LINK_WARN).toBeLessThan(SHARE_LINK_MAX);
  });

  test("a hue with a fractional part keeps one decimal", () => {
    expect(tidy(282.5, 0.165)).toEqual({ hue: 282.5, chroma: 0.165 });
    expect(tidy(282.54, 0.1654)).toEqual({ hue: 282.5, chroma: 0.165 });
    expect(tidy(-10, 0.1)).toEqual({ hue: 350, chroma: 0.1 });
    expect(tidy(150, 0.12).hue).toBe(150);
  });
});
