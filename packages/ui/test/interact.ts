// Interaction helpers for the overlay and navigation tests (wave 2): pointer presses, keys and a
// wait for Base UI's asynchronous focus moves, all inside React's act().
import { act } from "react";

/** A click, as `element.click()` sends it. */
export async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
}

/** A full mouse press: pointerdown, mousedown, pointerup, mouseup, click. */
export async function press(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, detail: 1 }));
  });
}

/** A keydown (and keyup) on `element`, or on the focused element. */
export async function key(keyName: string, element: Element | null = document.activeElement, init: KeyboardEventInit = {}): Promise<void> {
  const target = element ?? document.body;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, cancelable: true, ...init }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: keyName, bubbles: true, cancelable: true, ...init }));
  });
}

/** Pointer enter and move over `element` (hover), as a mouse sends them. */
export async function hover(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false }));
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
  });
}

/** Pointer leave from `element`. */
export async function unhover(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, pointerType: "mouse" }));
    element.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false }));
    element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
  });
}

/** Focuses `element` inside act(). */
export async function focus(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.focus();
  });
}

/** Waits (real timers) until `check` passes, flushing React each time; throws its last error. */
export async function waitFor(check: () => void, timeout = 1000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 16));
    });
  }
}

/** The element for `selector` in the whole document (popups render in a portal). */
export const $ = <T extends Element = HTMLElement>(selector: string) => document.body.querySelector<T>(selector);
export const $$ = <T extends Element = HTMLElement>(selector: string) => [...document.body.querySelectorAll<T>(selector)];

/** The classes of an element, split. */
export const classList = (element: Element | null) => (element?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

/**
 * The elements that move (a `transition`, `transition-all` or `transition-transform` class, or an
 * animation) without turning it off under prefers-reduced-motion. Colour and opacity transitions
 * are not motion and may stay.
 */
export function honoursReducedMotion(elements: Element[]): string[] {
  const problems: string[] = [];
  for (const element of elements) {
    const classes = classList(element);
    const animated = classes.some((c) => /^(?:[a-z-]+:)*(?:transition|transition-all|transition-transform|animate-[a-z-]+)$/.test(c) && !c.startsWith("motion-reduce:"));
    if (animated && !classes.some((c) => c === "motion-reduce:transition-none" || c === "motion-reduce:animate-none")) {
      problems.push(`${element.getAttribute("data-slot") ?? element.tagName}: ${classes.filter((c) => /transition|animate/.test(c)).join(" ")}`);
    }
  }
  return problems;
}

const LAYERS: Record<string, number> = { base: 0, sticky: 100, dropdown: 200, overlay: 300, modal: 400, popover: 500, toast: 600, tooltip: 700 };

/** The z layer an element's `z-[var(--by-z-<name>)]` class puts it on (the z.* token values). */
export function zLayer(element: Element | null): number {
  const name = /z-\[var\(--by-z-([a-z]+)\)\]/.exec(element?.getAttribute("class") ?? "")?.[1];
  return name === undefined ? Number.NaN : LAYERS[name]!;
}
