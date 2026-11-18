import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeState, generateTokens } from "@byterygon/design-tokens";
import { renderTokensCss } from "@byterygon/design-tokens/build";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { App, THEME_STYLE_ATTRIBUTE } from "../src/app.tsx";
import { readLibrary } from "../src/state/library.ts";
import { type Loaded, loadState, startingTheme } from "../src/state/persist.ts";
import { PRESETS } from "../src/state/presets.ts";
import type { ThemeDoc } from "../src/state/theme-edit.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.head.querySelector(`style[${THEME_STYLE_ATTRIBUTE}]`)?.remove();
  localStorage.clear();
});

const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
const $$ = <T extends Element = HTMLElement>(selector: string) => [...document.body.querySelectorAll<T>(selector)];
const byText = (selector: string, text: string) => $$(selector).find((element) => element.textContent?.trim() === text);
const styleText = () => document.head.querySelector(`style[${THEME_STYLE_ATTRIBUTE}]`)?.textContent ?? "";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => void, timeout = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await act(() => sleep(20));
    }
  }
}

function key(element: Element, name: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: Element) {
  act(() => {
    (element as HTMLElement).click();
  });
}

/** Renders the Studio and returns the hashes it saves, newest last. */
function mount(theme: ThemeDoc = startingTheme(), view: Loaded["view"] = { mode: "light", density: "comfortable" }) {
  const saved: string[] = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<App initial={{ theme, view, source: "default", diagnostics: [] }} save={(hash) => saved.push(hash)} />));
  return saved;
}

/**
 * The newest saved state once `check` holds for it. The app saves after a 150 ms debounce and an
 * async hash, so a fixed sleep races on a loaded runner; this polls the newest hash instead.
 */
async function lastSavedTheme(saved: string[], check: (state: NonNullable<Awaited<ReturnType<typeof decodeState>>["state"]>) => void = () => {}) {
  const start = Date.now();
  for (;;) {
    try {
      if (saved.length === 0) throw new Error("nothing saved yet");
      const state = (await decodeState(saved.at(-1)!)).state!;
      check(state);
      return state;
    } catch (error) {
      if (Date.now() - start > 5000) throw error;
      await act(() => sleep(20));
    }
  }
}

describe("Theme Studio", () => {
  test("writes the theme's tokens.css, as the export renders it, and the view on the root", async () => {
    mount();
    expect(styleText()).toBe(renderTokensCss(generateTokens(startingTheme()).set, "Theme Studio"));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(document.documentElement.dataset["density"]).toBe("comfortable");
    expect($('[role="status"]')!.textContent).toMatch(/482 contrast checks pass/);
  });

  test("the colour mode and density switches change the root and are saved", async () => {
    const saved = mount();
    click(byText("button", "Dark")!);
    click(byText("button", "Compact")!);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.documentElement.dataset["density"]).toBe("compact");
    await lastSavedTheme(saved, (state) => expect([state.mode, state.density]).toEqual(["dark", "compact"]));
  });

  test("a seed edit regenerates the CSS at once and lands in the saved theme file; Reset removes it", async () => {
    const saved = mount();
    const radius = $<HTMLInputElement>('input[aria-label="Radius (px)"]')!;
    act(() => radius.focus());
    key(radius, "ArrowUp");
    key(radius, "ArrowUp");
    // The engine default (the default preset's seed, Aurora) is 4 px.
    await waitFor(() => expect(styleText()).toContain("--by-radius-md: 6px;"));
    await lastSavedTheme(saved, (state) => expect(state.theme).toEqual({ ...startingTheme(), seeds: { radius: 6 } }));

    click($('button[aria-label="Reset shape and type"]')!);
    await waitFor(() => expect(styleText()).toContain("--by-radius-md: 4px;"));
    await lastSavedTheme(saved, (state) => expect(state.theme).toEqual(startingTheme()));
  });

  test("the colour picker: a palette swatch sets the ramp's hue and chroma; the plane moves by keyboard; a pasted colour works", async () => {
    const saved = mount();
    const brand9 = () => styleText().match(/--by-color-brand-9: ([^;]+);/)![1];
    const before = brand9();
    // The engine default brand is Aurora's (hue 282.5); the label keeps its one decimal.
    click($('button[aria-label^="Brand: hue 282.5, chroma 0.165"]')!);
    await waitFor(() => expect($('[role="group"][aria-label="Ready colours"]')).toBeTruthy());

    click($('button[aria-label="hue 135, chroma 0.12"]')!);
    await waitFor(() => expect(brand9()).not.toBe(before));
    expect(brand9()).toMatch(/ 135\)$/);
    await lastSavedTheme(saved, (state) => expect(state.theme["seeds"]).toEqual({ colors: { brand: { hue: 135, chroma: 0.12 } } }));

    const plane = $('[role="slider"][aria-label="Hue and chroma"]')!;
    act(() => plane.focus());
    key(plane, "ArrowRight");
    key(plane, "ArrowDown");
    await waitFor(() => expect(plane.getAttribute("aria-valuetext")).toBe("hue 136, chroma 0.115"));

    type($<HTMLInputElement>('input[placeholder^="#0e7490"]')!, "oklch(0.6 0.15 30)");
    await waitFor(() => expect(plane.getAttribute("aria-valuetext")).toBe("hue 30, chroma 0.15"));
    type($<HTMLInputElement>('input[placeholder^="#0e7490"]')!, "not a colour");
    await waitFor(() => expect(document.body.textContent).toContain("Not a colour"));
  });

  test("the token editor overrides one token per mode, shows its contrast, and resets it", async () => {
    const saved = mount();
    click(byText('[role="tab"]', "Tokens")!);
    type($<HTMLInputElement>('input[aria-label="Search tokens"]')!, "color.fg.link");
    await waitFor(() => expect(byText("button span", "color.fg.link")).toBeTruthy());
    click(byText("button span", "color.fg.link")!.closest("button")!);
    await waitFor(() => expect($('[aria-label="Token color.fg.link"]')).toBeTruthy());
    expect($('[aria-label="Contrast pairs"]')!.textContent).toMatch(/color\.fg\.link on color\.bg\.surface/);

    const inputs = $$<HTMLInputElement>('[aria-label="Change"] input[placeholder^="{"]').filter((input) => !input.closest('[data-slot^="combobox"]'));
    expect(inputs.length).toBe(2);
    type(inputs[1]!, "{color.brand-dark.12}");
    await waitFor(() => expect(styleText()).toContain("--by-color-fg-link: var(--by-color-brand-dark-12);"));
    await lastSavedTheme(saved, (state) => expect(state.theme["overrides"]).toEqual({ "color.fg.link": { dark: "{color.brand-dark.12}" } }));

    click(byText("button", "Reset token")!);
    await waitFor(() => expect(styleText()).not.toContain("--by-color-fg-link: var(--by-color-brand-dark-12);"));
    await lastSavedTheme(saved, (state) => expect(state.theme["overrides"]).toBeUndefined());
  });

  test("an invalid override is the engine's diagnostic, shown on the token and in Problems", async () => {
    mount({ ...startingTheme(), overrides: { "color.fg.link": "#ff0000" } });
    expect($('[role="status"]')!.textContent).toMatch(/problem/);
    click($$('[role="tab"]').find((tab) => tab.textContent?.startsWith("Problems"))!);
    await waitFor(() => expect(document.body.textContent).toMatch(/raw-color-outside-primitive|override-invalid-value/));
  });

  test("the preview renders the real components of every group the task names", () => {
    mount();
    for (const group of ["Forms", "Buttons", "Table", "Dialog", "Menu", "Toast and alerts", "Chart", "Editors"]) {
      expect($(`section[aria-label="${group}"]`), group).toBeTruthy();
    }
    expect($('[data-slot="button"]')).toBeTruthy();
    expect($('[data-slot="table"]')).toBeTruthy();
    expect($('[data-slot="sql-editor"]')).toBeTruthy();
    expect($('[data-slot="code-input"]')).toBeTruthy();
  });

  test("Export: each format with its install note, Copy and Download of the exact export", async () => {
    const theme = { ...startingTheme(), name: "ocean", seeds: { colors: { brand: { hue: 200 } } } };
    mount(theme);
    const downloads: { name: string; text: Promise<string> }[] = [];
    const created = URL.createObjectURL;
    const blobs = new Map<string, Blob>();
    URL.createObjectURL = (blob: Blob) => {
      const url = `blob:test/${blobs.size}`;
      blobs.set(url, blob);
      return url;
    };
    URL.revokeObjectURL = () => {};
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, text: blobs.get(this.href)!.text() });
    };
    try {
      const dialog = () => $$('[role="dialog"]').find((d) => d.textContent?.includes("Copy or download the theme"));
      click(byText("button", "Export")!);
      await waitFor(() => expect(dialog()).toBeTruthy());
      click(byText('[role="dialog"] button', "shadcn registry theme item")!);
      await waitFor(() => expect(byText('[role="dialog"] button', "Download theme-ocean.json")).toBeTruthy(), 10_000);
      expect(dialog()!.textContent).toContain("shadcn add /path/to/registry/theme-<name>.json");
      click(byText('[role="dialog"] button', "Download theme-ocean.json")!);
      const { exportTheme } = await import("@byterygon/design-tokens/build");
      expect(downloads.map((d) => d.name)).toEqual(["theme-ocean.json"]);
      expect(await downloads[0]!.text).toBe((await exportTheme(theme, "registry")).content);

      click(byText('[role="dialog"] button', "Copy")!);
      await waitFor(() => expect(dialog()!.textContent).toMatch(/Copied to the clipboard|refused the clipboard/));
    } finally {
      URL.createObjectURL = created;
      HTMLAnchorElement.prototype.click = anchorClick;
    }
  });

  test("the swatch board lists every ramp in both schemes and the colour roles", async () => {
    mount();
    click($$('[role="tab"]').find((tab) => tab.textContent === "Swatches")!);
    await waitFor(() => expect($('[aria-label="brand-dark ramp"]')).toBeTruthy());
    for (const ramp of ["neutral", "brand", "red", "amber", "green", "blue", "violet", "orange", "teal", "pink"]) {
      expect($(`[aria-label="${ramp} ramp"]`), ramp).toBeTruthy();
      expect($$(`[aria-label="${ramp}-dark ramp"] [role="listitem"]`)).toHaveLength(12);
    }
    expect(document.body.textContent).toContain("color.bg");
  });

  test("Themes: the gallery shows every preset with a scoped preview; Open loads one with its own view", async () => {
    mount();
    click(byText("button", "Themes")!);
    await waitFor(() => expect($('section[aria-label="Presets"]')).toBeTruthy());
    const cards = $$('section[aria-label="Presets"] li');
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual(PRESETS.map((p) => p.label));
    expect(cards[0]!.getAttribute("aria-label")).toBe("Aurora");
    // Each card declares its own theme's variables, scoped to the card.
    const midnight = $('[data-studio-preview="preset-midnight"]')!;
    expect(midnight.querySelector("style")!.textContent).toContain('[data-studio-preview="preset-midnight"] {');
    expect(midnight.querySelector("style")!.textContent).not.toMatch(/^:root/m);

    click($('button[aria-label="Open Midnight"]')!);
    await waitFor(() => expect(styleText()).toContain('theme "midnight"'));
    // Midnight is dark first: the view follows the theme.
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect($<HTMLInputElement>('input[aria-label="Theme name"]')!.value).toBe("midnight");
  });

  test("Themes: duplicate a preset, save and update the edited theme, delete with undo", async () => {
    mount({ ...startingTheme(), name: "ocean", seeds: { radius: 9 } });
    click(byText("button", "Themes")!);
    await waitFor(() => expect($('section[aria-label="Saved in this browser"]')).toBeTruthy());
    click(byText("button", "Save ocean")!);
    await waitFor(() => expect(readLibrary(localStorage).themes.map((t) => t.theme["name"])).toEqual(["ocean"]));
    expect(byText("button", "Update saved ocean")).toBeTruthy();

    click($('button[aria-label="Duplicate Paper"]')!);
    await waitFor(() => expect(styleText()).toContain('theme "paper-copy"'));
    const library = readLibrary(localStorage).themes;
    expect(library.map((t) => t.theme["name"])).toEqual(["paper-copy", "ocean"]);
    expect(library[0]!.theme["description"]).toBe("Based on the paper preset.");

    click(byText("button", "Themes")!);
    await waitFor(() => expect($('button[aria-label="Delete ocean"]')).toBeTruthy());
    click($('button[aria-label="Delete ocean"]')!);
    await waitFor(() => expect(readLibrary(localStorage).themes.map((t) => t.theme["name"])).toEqual(["paper-copy"]));
    click(byText("button", "Undo")!);
    await waitFor(() => expect(readLibrary(localStorage).themes.map((t) => t.theme["name"])).toEqual(["paper-copy", "ocean"]));
  });

  test("Share: the link is the page address with the current state's hash, and it opens that state", async () => {
    const theme = { ...startingTheme(), name: "ocean", seeds: { colors: { brand: { hue: 200 } } } };
    mount(theme, { mode: "dark", density: "compact" });
    click(byText("button", "Share")!);
    await waitFor(() => expect($<HTMLInputElement>('input[aria-label="Share link"]')?.value).toContain("#by=1&theme="));
    const link = $<HTMLInputElement>('input[aria-label="Share link"]')!.value;
    expect(link.startsWith(location.href.split("#")[0]!)).toBe(true);
    const loaded = await loadState(link.slice(link.indexOf("#")), undefined);
    expect([loaded.theme, loaded.view]).toEqual([theme, { mode: "dark", density: "compact" }]);
    click(byText("button", "Copy link")!);
    await waitFor(() => expect(document.body.textContent).toMatch(/Copied to the clipboard|the link is selected/));
  });

  test("Contrast: failing pairs per mode combination, a one-click fix, an alternative, Undo, Fix all", async () => {
    const faded = { ...startingTheme(), overrides: { "color.neutral.11": "oklch(0.7 0.012 275)" } };
    const saved = mount(faded);
    const tab = () => $$('[role="tab"]').find((t) => t.textContent?.startsWith("Contrast"))!;
    expect(tab().textContent).toBe("Contrast (31)");
    click(tab());
    await waitFor(() => expect($('ul[aria-label="Contrast pairs, light · comfortable"]')).toBeTruthy());
    // Colour never depends on density: both light combinations fail the same 31 (the three
    // text-on-backdrop pairs of TSK-64 included), the dark ones none.
    const combos = $$('[aria-label="Mode combination"] button').map((b) => b.textContent);
    expect(combos).toEqual(["light · comfortable31", "light · compact31", "dark · comfortable", "dark · compact"]);
    // One group per role and mode: the engine solves one fix for all of the role's backgrounds.
    const groups = $$('ul[aria-label="Contrast pairs, light · comfortable"] > li').map((li) => li.getAttribute("aria-label"));
    expect([...groups].sort()).toEqual(["color.fg.muted", "color.neutral.fg", "color.neutral.subtle-fg", "syntax.operator"]);
    expect($('li[aria-label="color.fg.muted"]')!.textContent).toContain("fails on 27 of 27 backgrounds (light)");
    expect($('li[aria-label="color.neutral.fg"]')!.textContent).toContain("fails on 1 of 3 backgrounds (light)");
    expect($$('ul[aria-label="color.fg.muted pairs"] > li')).toHaveLength(4);
    click(byText("button", "Show all 27")!);
    expect($$('ul[aria-label="color.fg.muted pairs"] > li')).toHaveLength(27);

    // The primary fix nudges the primitive's lightness within its step.
    click(byText("button", "Apply fix")!);
    await waitFor(() => expect(tab().textContent).toBe("Contrast (0)"));
    await lastSavedTheme(saved, (state) => expect(state.theme["overrides"]).toEqual({ "color.neutral.11": "oklch(0.49 0.012 275)" }));
    expect(document.body.textContent).toContain("Applied: Change the lightness of color.neutral.11");

    click(byText("button", "Undo")!);
    await waitFor(() => expect(tab().textContent).toBe("Contrast (31)"));

    // An alternative: alias the role to another step of the same ramp.
    click(byText("button", "Apply")!);
    await waitFor(() => expect((tab().textContent ?? "").startsWith("Contrast (31)")).toBe(false));
    await lastSavedTheme(saved, (state) => expect((state.theme["overrides"] as Record<string, unknown>)["color.fg.muted"]).toEqual({ light: "{color.neutral.12}" }));

    click(byText("button", "Undo")!);
    await waitFor(() => expect(tab().textContent).toBe("Contrast (31)"));
    click(byText("button", "Fix all")!);
    await waitFor(() => expect(tab().textContent).toBe("Contrast (0)"));
    expect(document.body.textContent).toContain("Applied 1 fix.");

    click(byText('[aria-label="Mode combination"] button', "dark · compact")!);
    await waitFor(() => expect(document.body.textContent).toContain("No pair fails in dark · compact."));
  });

  test("Import: a pasted shadcn globals.css becomes a theme file; opening it lands on the contrast report", async () => {
    const shadcn = readFileSync(join(import.meta.dirname, "..", "..", "design-tokens", "test", "fixtures", "shadcn-v4.css"), "utf8");
    const saved = mount();
    click(byText("button", "Import")!);
    await waitFor(() => expect($('[role="dialog"] textarea')).toBeTruthy());
    const area = $<HTMLTextAreaElement>('[role="dialog"] textarea')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(area, shadcn);
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    type($<HTMLInputElement>('input[placeholder="from the source"]')!, "neutral");
    click(byText("button", "Read")!);
    await waitFor(() => expect($('section[aria-label="Imported theme"]')).toBeTruthy());
    expect(document.body.textContent).toContain("Read as shadcn/ui globals.css");
    expect(document.body.textContent).toContain("by-tokens import <file> --name neutral");
    expect($('section[aria-label="Imported theme"]')!.textContent).toMatch(/--border \(dark\) is translucent/);

    click(byText("button", "Open this theme")!);
    await waitFor(() => expect(styleText()).toContain('theme "neutral"'));
    expect(styleText()).toContain("--by-radius-md: 10px;");
    // Stock shadcn colours miss some contrast pairs: the report opens with the engine's fixes.
    await waitFor(() => expect($('main [role="tab"][aria-selected="true"]')!.textContent).toMatch(/^Contrast \(\d+\)$/));
    await lastSavedTheme(saved, (state) => expect(state.theme["name"]).toBe("neutral"));
  });
});
