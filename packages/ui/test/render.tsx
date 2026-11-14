// Rendering helpers for the component tests: a real React root in jsdom, a theme and density
// wrapper, and axe.
import axe from "axe-core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface RenderOptions {
  theme?: "light" | "dark";
  density?: "comfortable" | "compact";
}

export interface Rendered {
  container: HTMLElement;
  unmount: () => void;
}

const mounted = new Set<{ root: Root; container: HTMLElement }>();

/** Renders `ui` inside a `<main data-theme data-density>` attached to the document. */
export function render(ui: ReactNode, { theme = "light", density = "comfortable" }: RenderOptions = {}): Rendered {
  const container = document.createElement("main");
  container.setAttribute("data-theme", theme);
  container.setAttribute("data-density", density);
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

/**
 * Runs axe (WCAG 2.x A and AA rules) and returns the violations. Colour contrast is off: jsdom does
 * not compute colours, and the token build checks every text and control pair in every mode.
 */
export async function axeViolations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(" ")).join(", ")})`);
}

/**
 * Every class name used in the rendered tree. Elements inside a `data-foreign-dom` element are
 * skipped: a library renders them with its own classes (CodeMirror's `cm-*`), not token classes.
 */
export function classesIn(container: HTMLElement): Set<string> {
  const classes = new Set<string>();
  for (const element of container.querySelectorAll("[class]")) {
    if (element.parentElement?.closest("[data-foreign-dom]")) continue;
    for (const name of element.getAttribute("class")!.split(/\s+/)) if (name && !isLibraryClass(name)) classes.add(name);
  }
  return classes;
}

/**
 * A class Base UI adds itself for its own injected stylesheet (ScrollArea's viewport gets
 * `base-ui-disable-scrollbar`); it is not a Tailwind utility, so the token check skips it.
 */
export const isLibraryClass = (name: string) => name.startsWith("base-ui-");

export { act };
