// Rendering helpers for the grid tests: jsdom has no layout, so the scroller reports a 640 x 320
// viewport (everything else 0); a React root per test; axe; waiting for animation frames.
import axe from "axe-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll } from "vitest";
import { DataGrid, type DataGridProps } from "../src/index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const VIEW = { width: 640, height: 320 };

beforeAll(() => {
  for (const [prop, size] of [
    ["clientWidth", VIEW.width],
    ["clientHeight", VIEW.height],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("bdg-scroller") ? size : 0;
      },
    });
  }
});

let root: Root | undefined;
let container: HTMLElement | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
});

export function render(props: DataGridProps): HTMLElement {
  container = document.createElement("main");
  container.setAttribute("data-density", "compact");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(<DataGrid {...props} />));
  return container;
}

export function rerender(props: DataGridProps): void {
  act(() => root!.render(<DataGrid {...props} />));
}

export async function axeViolations(el: HTMLElement): Promise<string[]> {
  const result = await axe.run(el, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

/** Waits for the next animation frame (and React's updates in it). */
export async function nextFrame(): Promise<void> {
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

export const rowsIn = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".bdg-body > [role=row]:not([hidden])")];
export const textOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("[role=gridcell]:not([hidden])")].map((c) => c.textContent);
export const cell = (el: HTMLElement, row: number, column: number) =>
  el.querySelector<HTMLElement>(`.bdg-body [aria-rowindex='${row + 2}'] [role=gridcell][aria-colindex='${column + 2}']:not([hidden])`);
