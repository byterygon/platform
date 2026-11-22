// Rendering helpers: a real React root in jsdom under a theme and density, and axe (WCAG 2.x A and
// AA; colour contrast is off in jsdom, the token build checks every pair).
import axe from "axe-core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// The router scrolls the window to the top after each URL change; jsdom has no layout to scroll.
window.scrollTo = () => {};

export interface RenderOptions {
  theme?: "light" | "dark";
  density?: "comfortable" | "compact";
}

const mounted = new Set<{ root: Root; container: HTMLElement }>();

export function render(ui: ReactNode, { theme = "light", density = "compact" }: RenderOptions = {}): { container: HTMLElement; unmount: () => void } {
  const container = document.createElement("div");
  container.setAttribute("data-theme", theme);
  container.setAttribute("data-density", density);
  container.style.height = "800px";
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  const entry = { root, container };
  mounted.add(entry);
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
      mounted.delete(entry);
    },
  };
}

export function cleanup(): void {
  for (const { root, container } of mounted) {
    act(() => root.unmount());
    container.remove();
  }
  mounted.clear();
}

export async function axeViolations(container: HTMLElement = document.body): Promise<string[]> {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

/** Lets pending promises and effects settle. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

export async function waitFor(check: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    // Updates from the event subscription arrive outside act: give React two turns.
    await settle(2);
  }
}

export async function click(element: Element | null): Promise<void> {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).focus?.();
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await settle(1);
}

export async function key(keyName: string, init: KeyboardEventInit = {}, target: Element | null = document.activeElement): Promise<void> {
  const el = target ?? document.body;
  await act(async () => {
    const codes: Record<string, string> = { "]": "BracketRight", "[": "BracketLeft", ",": "Comma", "/": "Slash", Enter: "Enter", Escape: "Escape", F6: "F6", F5: "F5", Tab: "Tab" };
    const code = codes[keyName] ?? (keyName.length === 1 ? `Key${keyName.toUpperCase()}` : keyName);
    el.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, code, bubbles: true, cancelable: true, ...init }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: keyName, code, bubbles: true, cancelable: true, ...init }));
  });
  await settle(1);
}

export async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle(1);
}

/**
 * The text area of a CodeEditor by its accessible name (aria-label, or the text of the label its
 * aria-labelledby names): Monaco's (the test fake's) once it has loaded, else the fallback.
 */
export function editorArea(name: string): HTMLTextAreaElement | null {
  const labelIds = [...document.querySelectorAll("[id]")].filter((l) => l.textContent === name).map((l) => l.id);
  const areas = [...document.querySelectorAll<HTMLTextAreaElement>('[data-slot="code-editor"] textarea')].filter((t) => !t.hidden);
  return areas.find((t) => t.getAttribute("aria-label") === name || labelIds.includes(t.getAttribute("aria-labelledby") ?? "")) ?? null;
}

export async function blur(input: HTMLElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    input.blur();
  });
  await settle(1);
}

export const byText = (text: string | RegExp, root: ParentNode = document.body): HTMLElement | null => {
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? "")
      .join("")
      .trim();
    if (typeof text === "string" ? own === text : text.test(own)) return el;
  }
  return null;
};

export const byRole = (role: string, name?: string | RegExp, root: ParentNode = document.body): HTMLElement | null => {
  for (const el of root.querySelectorAll<HTMLElement>(`[role="${role}"], ${role === "button" ? "button" : role === "textbox" ? "input:not([type]), input[type=text], textarea" : role === "link" ? "a[href]" : "x-none"}`)) {
    if (name === undefined) return el;
    const labelledBy = el.getAttribute("aria-labelledby");
    const label = el.getAttribute("aria-label") ?? (labelledBy ? (document.getElementById(labelledBy)?.textContent ?? "") : "");
    const text = `${label} ${el.textContent ?? ""}`.replace(/\s+/g, " ").trim();
    if (typeof name === "string" ? text === name || label === name || (el.textContent ?? "").trim() === name : name.test(text)) return el;
  }
  return null;
};

/** A tab by its title: the tab's own label, not its count (TSK-110: the count is a badge after the title). */
export const tabByTitle = (title: string, root: ParentNode = document.body): HTMLElement | null =>
  [...root.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.querySelector('[data-slot="tabs-label"]')?.textContent?.trim() === title) ?? null;

/** The count in a tab's badge as drawn ("1,234", "12.4k", "50+"), or null when the tab has none. */
export const tabCount = (tab: Element | null): string | null => tab?.querySelector('[data-slot="tabs-count"]')?.textContent ?? null;

/** The tab's accessible name: its text less what is aria-hidden ("History, 1,234 events"). */
export const tabName = (node: Node | null): string =>
  node === null ? "" : [...node.childNodes].map((child) => (child instanceof HTMLElement ? (child.getAttribute("aria-hidden") === "true" ? "" : tabName(child)) : (child.textContent ?? ""))).join("");

/** A dialog (or alertdialog) whose text includes `text`; toasts are dialogs too, so look by content. */
export const dialogWith = (text: string): HTMLElement | null =>
  Array.from(document.querySelectorAll<HTMLElement>("[role=dialog], [role=alertdialog]")).find((d) => d.textContent?.includes(text)) ?? null;

export { act };
