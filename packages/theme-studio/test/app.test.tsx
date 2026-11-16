import { decodeState, generateTokens } from "@byterygon/design-tokens";
import { renderTokensCss } from "@byterygon/design-tokens/build";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { App, THEME_STYLE_ATTRIBUTE } from "../src/app.tsx";
import { type Loaded, startingTheme } from "../src/state/persist.ts";
import type { ThemeDoc } from "../src/state/theme-edit.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.head.querySelector(`style[${THEME_STYLE_ATTRIBUTE}]`)?.remove();
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

async function lastSavedTheme(saved: string[]) {
  await waitFor(() => expect(saved.length).toBeGreaterThan(0));
  await act(() => sleep(250));
  return (await decodeState(saved.at(-1)!)).state!;
}

describe("Theme Studio", () => {
  test("writes the theme's tokens.css, as the export renders it, and the view on the root", async () => {
    mount();
    expect(styleText()).toBe(renderTokensCss(generateTokens(startingTheme()).set, "Theme Studio"));
    expect(document.documentElement.dataset["theme"]).toBe("light");
    expect(document.documentElement.dataset["density"]).toBe("comfortable");
    expect($('[role="status"]')!.textContent).toMatch(/400 contrast checks pass/);
  });

  test("the colour mode and density switches change the root and are saved", async () => {
    const saved = mount();
    click(byText("button", "Dark")!);
    click(byText("button", "Compact")!);
    expect(document.documentElement.dataset["theme"]).toBe("dark");
    expect(document.documentElement.dataset["density"]).toBe("compact");
    const state = await lastSavedTheme(saved);
    expect([state.mode, state.density]).toEqual(["dark", "compact"]);
  });

  test("a seed edit regenerates the CSS at once and lands in the saved theme file; Reset removes it", async () => {
    const saved = mount();
    const radius = $<HTMLInputElement>('input[aria-label="Radius (px)"]')!;
    act(() => radius.focus());
    key(radius, "ArrowUp");
    key(radius, "ArrowUp");
    await waitFor(() => expect(styleText()).toContain("--by-radius-md: 8px;"));
    expect((await lastSavedTheme(saved)).theme).toEqual({ ...startingTheme(), seeds: { radius: 8 } });

    click($('button[aria-label="Reset shape and type"]')!);
    await waitFor(() => expect(styleText()).toContain("--by-radius-md: 6px;"));
    expect((await lastSavedTheme(saved)).theme).toEqual(startingTheme());
  });

  test("the brand hue drives the brand ramp", async () => {
    mount();
    const before = styleText().match(/--by-color-brand-9: ([^;]+);/)![1];
    const hue = $$<HTMLInputElement>('input[aria-label="Hue"]')[0]!;
    act(() => hue.focus());
    key(hue, "ArrowUp");
    await waitFor(() => expect(styleText().match(/--by-color-brand-9: ([^;]+);/)![1]).not.toBe(before));
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
    expect((await lastSavedTheme(saved)).theme["overrides"]).toEqual({ "color.fg.link": { dark: "{color.brand-dark.12}" } });

    click(byText("button", "Reset token")!);
    await waitFor(() => expect(styleText()).not.toContain("--by-color-fg-link: var(--by-color-brand-dark-12);"));
    expect((await lastSavedTheme(saved)).theme["overrides"]).toBeUndefined();
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
});
