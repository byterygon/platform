// The window material (TSK-54): the UI trusts what the desktop shell reported, never the user
// agent, and shows the material only for the default theme with the setting on.
import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS, fromDocuments, toDocuments, DEFAULT_PERSISTED } from "@/app/persistence";
import { PRESETS } from "@/app/presets";
import { SHELL_EVENT, applyMaterial, materialVisible, shellMaterial, watchShell } from "@/app/shell";

describe("shellMaterial", () => {
  test("only an explicit report from the shell counts", () => {
    expect(shellMaterial({})).toBeNull();
    expect(shellMaterial({ __DBEE_SHELL__: null })).toBeNull();
    expect(shellMaterial({ __DBEE_SHELL__: { material: "acrylic" } })).toBeNull();
    expect(shellMaterial({ __DBEE_SHELL__: { material: "mica" } })).toBe("mica");
  });
});

describe("materialVisible", () => {
  test("needs the shell's report, the setting and the default preset", () => {
    expect(materialVisible("mica", true, "default")).toBe("mica");
    expect(materialVisible(null, true, "default")).toBeNull();
    expect(materialVisible("mica", false, "default")).toBeNull();
    for (const preset of PRESETS.filter((p) => p !== "default")) expect(materialVisible("mica", true, preset)).toBeNull();
  });
});

describe("applyMaterial", () => {
  test("sets and clears data-material on the root", () => {
    applyMaterial("mica");
    expect(document.documentElement.dataset["material"]).toBe("mica");
    applyMaterial(null);
    expect(document.documentElement.dataset["material"]).toBeUndefined();
  });
});

describe("watchShell", () => {
  test("reports the current value, then the one the shell announces", () => {
    const host = globalThis as { __DBEE_SHELL__?: unknown };
    const seen: unknown[] = [];
    const stop = watchShell((m) => seen.push(m));
    host.__DBEE_SHELL__ = { material: "mica" };
    window.dispatchEvent(new Event(SHELL_EVENT));
    stop();
    window.dispatchEvent(new Event(SHELL_EVENT));
    delete host.__DBEE_SHELL__;
    expect(seen).toEqual([null, "mica"]);
  });
});

describe("the windowMaterial setting", () => {
  test("is on by default, survives the workspace round trip, and an older document turns it on", () => {
    expect(DEFAULT_SETTINGS.windowMaterial).toBe(true);
    const off = { ...DEFAULT_PERSISTED, settings: { ...DEFAULT_SETTINGS, windowMaterial: false } };
    const docs = toDocuments(off);
    expect(fromDocuments(docs.settings, docs.tabs)?.settings.windowMaterial).toBe(false);
    const { windowMaterial: _omit, ...older } = DEFAULT_SETTINGS;
    expect(fromDocuments({ version: 1, settings: older }, null)?.settings.windowMaterial).toBe(true);
  });
});
