// The per-component conventions, as a Vitest suite factory. test/conventions.test.tsx runs it on
// every folder in src/components; test/scaffold.test.tsx runs it on a component `ui:new` just made.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { COMPONENT_FILES, camel, fileName, validateManifest, type Manifest } from "../scripts/lib/manifest.ts";
import { checkClasses, checkImports, stateVariants, variantCombinations } from "./conventions.ts";
import { act, axeViolations, classesIn, cleanup, render } from "./render.tsx";

type Module = Record<string, unknown>;

export interface ComponentUnderTest {
  name: string;
  /** The component's folder. */
  dir: string;
  load: () => Promise<{ component: Module; example: Module }>;
}

export function describeComponent({ name, dir, load }: ComponentUnderTest): void {
  describe(`${name} follows the component conventions`, () => {
    afterEach(cleanup);
    const manifestText = readFileSync(join(dir, fileName(name, "component.manifest.json")), "utf8");
    const manifest = JSON.parse(manifestText) as Manifest;
    const source = readFileSync(join(dir, fileName(name, "component.tsx")), "utf8");
    const parts = manifest.parts ?? [];
    const ownSlots = new Set([name, ...parts.map((part) => part.slot)]);
    /** A part's slot, or an inner element of the component (`popover-positioner`, a slot the manifest lists under `slots`). */
    const isOwnSlot = (slot: string) => ownSlots.has(slot) || slot.startsWith(`${name}-`);

    /**
     * For a component with parts: the classes the examples render inside this component's own
     * slots (an element counts when its nearest data-slot is the component, one of its parts, or an
     * inner element named `<name>-*`),
     * and the slots seen. A part only renders inside the main component, so the examples are where
     * its classes are found; other components in the examples (an Input in a Field) are skipped.
     * The whole document is read, so popups in a portal count, and each closed popup trigger in the
     * example (`aria-haspopup`) is clicked once so the parts inside its popup render too, then each
     * popup trigger inside that popup (a submenu). The component's own `<name>-trigger` without
     * aria-haspopup gets a click (NavigationMenu) and a right-click (ContextMenu).
     */
    const exampleClasses = async () => {
      const classes = new Set<string>();
      const slots = new Set<string>();
      if (parts.length === 0) return { classes, slots };
      const { example } = await load();
      const collect = () => {
        for (const element of document.body.querySelectorAll("[data-slot]")) {
          const slot = element.getAttribute("data-slot")!;
          if (ownSlots.has(slot)) slots.add(slot);
        }
        for (const element of document.body.querySelectorAll("[class]")) {
          const slot = element.closest("[data-slot]")?.getAttribute("data-slot");
          if (!slot || !isOwnSlot(slot)) continue;
          for (const c of element.getAttribute("class")!.split(/\s+/)) if (c) classes.add(c);
        }
      };
      for (const exportName of [manifest.examples.minimal, manifest.examples.realistic]) {
        const { container, unmount } = render(createElement(example[exportName] as ComponentType));
        collect();
        const open = async (trigger: Element) => {
          await act(async () => {
            trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          });
          collect();
        };
        for (const trigger of container.querySelectorAll('[aria-haspopup]:not([aria-expanded="true"])')) {
          await open(trigger);
          // Popup triggers inside the popup that opened (a submenu): open each once as well.
          for (const inner of document.body.querySelectorAll('[aria-haspopup]:not([aria-expanded="true"])')) {
            if (!container.contains(inner)) await open(inner);
          }
          // Escape until it is closed; a press outside when a submenu keeps it open.
          for (let i = 0; i < 3 && trigger.getAttribute("aria-expanded") === "true"; i += 1) {
            await act(async () => {
              (document.activeElement ?? trigger).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
            });
          }
          if (trigger.getAttribute("aria-expanded") === "true") {
            await act(async () => {
              for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
                document.body.dispatchEvent(new (type.startsWith("pointer") ? PointerEvent : MouseEvent)(type, { bubbles: true, cancelable: true, button: 0 }));
              }
            });
          }
        }
        // The component's own trigger without aria-haspopup: NavigationMenu's opens on click (it has
        // aria-expanded only), ContextMenu's area on right-click. Each is tried once.
        for (const area of container.querySelectorAll(`[data-slot="${name}-trigger"]:not([aria-haspopup])`)) {
          await act(async () => {
            area.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
          });
          collect();
          await act(async () => {
            (document.activeElement ?? area).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          });
          await act(async () => {
            area.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
          });
          collect();
          for (const inner of document.body.querySelectorAll('[aria-haspopup]:not([aria-expanded="true"])')) {
            if (!container.contains(inner)) await open(inner);
          }
          await act(async () => {
            (document.activeElement ?? area).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          });
        }
        unmount();
      }
      return { classes, slots };
    };

    if (parts.length > 0) {
      test("exports every part the manifest lists, and the examples render each one", async () => {
        const { component } = await load();
        const { slots } = await exampleClasses();
        for (const part of parts) {
          expect(typeof component[part.name], `component.tsx must export ${part.name}`).toBe("function");
          expect(slots.has(part.slot), `no example renders ${part.name} (data-slot="${part.slot}")`).toBe(true);
        }
      });
    }

    test("has exactly the four files of the layout", () => {
      expect(readdirSync(dir).sort()).toEqual(COMPONENT_FILES.map((kind) => fileName(name, kind)).sort());
    });

    test("has a valid manifest", () => {
      expect(validateManifest(manifest, name)).toEqual([]);
    });

    test("exports the component and the variants the manifest lists", async () => {
      const { component } = await load();
      expect(typeof component[manifest.title]).toBe("function");
      const variants = component[`${camel(name)}Variants`] as Record<string, Record<string, string>> | undefined;
      const actual = Object.fromEntries(Object.entries(variants ?? {}).map(([prop, values]) => [prop, Object.keys(values)]));
      expect(actual, `the ${camel(name)}Variants export and manifest.variants must list the same props and values`).toEqual(manifest.variants);
    });

    test("imports only React, Base UI, its declared dependencies and @/ code", () => {
      expect(checkImports(source, manifest)).toEqual([]);
      if (manifest.base) expect(source, "manifest.base names the Base UI part the component wraps").toContain(`"${manifest.base}"`);
    });

    test("is styled by token roles only, and the manifest lists every token it uses", async () => {
      const { component } = await load();
      const Component = component[manifest.title] as ComponentType<Record<string, unknown>>;
      const classes = new Set<string>();
      const renders = [...variantCombinations(manifest.variants), ...manifest.states.filter((s) => s.props).map((s) => s.props as Record<string, unknown>)];
      for (const props of renders) {
        const { unmount } = render(createElement(Component, { ...props, "aria-label": manifest.title }));
        await act(async () => {});
        for (const c of classesIn(document.body)) classes.add(c);
        unmount();
      }
      for (const c of (await exampleClasses()).classes) classes.add(c);
      const report = await checkClasses(classes);
      expect(report.errors).toEqual([]);
      expect(manifest.tokens, `manifest.tokens must be exactly: ${JSON.stringify(report.tokens)}`).toEqual(report.tokens);
    });

    test("styles every state the manifest lists, and shows its attribute", async () => {
      const { component } = await load();
      const Component = component[manifest.title] as ComponentType<Record<string, unknown>>;
      const all = new Set<string>();
      for (const props of [{}, ...manifest.states.map((s) => s.props ?? {})]) {
        const { unmount } = render(createElement(Component, { ...props, "aria-label": manifest.title }));
        await act(async () => {});
        for (const c of classesIn(document.body)) all.add(c);
        unmount();
      }
      for (const c of (await exampleClasses()).classes) all.add(c);
      const variants = stateVariants(all);
      for (const state of manifest.states) {
        expect(variants.has(state.variant), `state "${state.name}": no class uses the ${state.variant}: variant`).toBe(true);
        const attribute = /^(data|aria)-[a-z-]+$/.test(state.variant) ? state.variant : undefined;
        if (attribute && state.props) {
          const { unmount } = render(createElement(Component, { ...state.props, "aria-label": manifest.title }));
          await act(async () => {});
          expect(document.body.querySelector(`[${attribute}]:not([${attribute}="false"])`), `state "${state.name}": ${JSON.stringify(state.props)} must set ${attribute}`).not.toBeNull();
          unmount();
        }
      }
    });

    for (const theme of ["light", "dark"] as const) {
      for (const density of ["comfortable", "compact"] as const) {
        test(`renders its examples without axe violations (${theme}, ${density})`, async () => {
          const { example } = await load();
          for (const exportName of [manifest.examples.minimal, manifest.examples.realistic]) {
            const Example = example[exportName] as ComponentType | undefined;
            expect(typeof Example, `component.example.tsx must export ${exportName}`).toBe("function");
            const { container } = render(createElement(Example!), { theme, density });
            expect(container.childElementCount).toBeGreaterThan(0);
            expect(await axeViolations(container)).toEqual([]);
          }
        });
      }
    }
  });
}
