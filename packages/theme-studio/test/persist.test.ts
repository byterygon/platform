import { decodeState, encodeState } from "@byterygon/design-tokens";
import { describe, expect, test } from "vitest";
import { STORAGE_KEY, loadState, saveState, startingTheme } from "../src/state/persist.ts";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), data };
}

const tuned = { schemaVersion: 1, name: "tuned", seeds: { radius: 10, colors: { brand: { hue: 150, chroma: 0.12 } } } };

describe("loadState", () => {
  test("the URL hash wins over storage, storage over the default", async () => {
    const hash = await encodeState({ theme: tuned, mode: "dark", density: "compact" });
    const stored = await encodeState({ theme: { ...tuned, name: "stored" } });
    const fromHash = await loadState(hash, memoryStorage({ [STORAGE_KEY]: stored }));
    expect([fromHash.source, fromHash.theme, fromHash.view]).toEqual(["hash", tuned, { mode: "dark", density: "compact" }]);
    const fromStorage = await loadState("", memoryStorage({ [STORAGE_KEY]: stored }));
    expect([fromStorage.source, fromStorage.theme["name"]]).toEqual(["storage", "stored"]);
    const fresh = await loadState("", memoryStorage());
    expect([fresh.source, fresh.theme, fresh.view]).toEqual(["default", startingTheme(), { mode: "light", density: "comfortable" }]);
  });

  test("without a view in the state, the theme's own default scheme and density apply", async () => {
    const hash = await encodeState({ theme: { schemaVersion: 1, name: "night", seeds: { colorScheme: "dark", density: "compact" } } });
    expect((await loadState(hash, undefined)).view).toEqual({ mode: "dark", density: "compact" });
  });

  test("a broken hash is reported and the stored state opens instead", async () => {
    const stored = await encodeState({ theme: tuned });
    const loaded = await loadState("#by=1&theme=garbage", memoryStorage({ [STORAGE_KEY]: stored }));
    expect(loaded.source).toBe("storage");
    expect(loaded.diagnostics.map((d) => d.rule)).toEqual(["state-invalid"]);
  });

  test("a newer version opens with its warnings", async () => {
    const hash = (await encodeState({ theme: { ...tuned, schemaVersion: 2, palette: "x" } })).replace("by=1", "by=3");
    const loaded = await loadState(hash, undefined);
    expect(loaded.source).toBe("hash");
    expect(loaded.theme).toEqual(tuned);
    expect(loaded.diagnostics.map((d) => d.rule)).toEqual(["state-newer-version", "theme-newer-version", "theme-key-dropped"]);
  });

  test("storage that throws is the same as no storage", async () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect((await loadState("", broken)).source).toBe("default");
    expect(() => saveState("#by=1&theme=x", broken, { replaceState: () => { throw new Error("no"); } })).not.toThrow();
  });
});

test("saveState writes the hash to the address bar and to storage", async () => {
  const storage = memoryStorage();
  const calls: unknown[][] = [];
  const hash = await encodeState({ theme: tuned });
  saveState(hash, storage, { replaceState: (...args: unknown[]) => void calls.push(args) });
  expect(calls).toEqual([[null, "", hash]]);
  expect(storage.data.get(STORAGE_KEY)).toBe(hash);
  expect((await decodeState(storage.data.get(STORAGE_KEY)!)).state!.theme).toEqual(tuned);
});
