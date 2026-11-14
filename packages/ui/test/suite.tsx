// The per-component conventions, as a Vitest suite factory. test/conventions.test.tsx runs it on
// every folder in src/components; test/scaffold.test.tsx runs it on a component `ui:new` just made.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentType } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { COMPONENT_FILES, camel, fileName, validateManifest, type Manifest } from "../scripts/lib/manifest.ts";
import { checkClasses, checkImports, stateVariants, variantCombinations } from "./conventions.ts";
import { axeViolations, classesIn, cleanup, render } from "./render.tsx";

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
        const { container, unmount } = render(createElement(Component, { ...props, "aria-label": manifest.title }));
        for (const c of classesIn(container)) classes.add(c);
        unmount();
      }
      const report = await checkClasses(classes);
      expect(report.errors).toEqual([]);
      expect(manifest.tokens, `manifest.tokens must be exactly: ${JSON.stringify(report.tokens)}`).toEqual(report.tokens);
    });

    test("styles every state the manifest lists, and shows its attribute", async () => {
      const { component } = await load();
      const Component = component[manifest.title] as ComponentType<Record<string, unknown>>;
      const all = new Set<string>();
      for (const props of [{}, ...manifest.states.map((s) => s.props ?? {})]) {
        const { container, unmount } = render(createElement(Component, { ...props, "aria-label": manifest.title }));
        for (const c of classesIn(container)) all.add(c);
        unmount();
      }
      const variants = stateVariants(all);
      for (const state of manifest.states) {
        expect(variants.has(state.variant), `state "${state.name}": no class uses the ${state.variant}: variant`).toBe(true);
        const attribute = /^(data|aria)-[a-z-]+$/.test(state.variant) ? state.variant : undefined;
        if (attribute && state.props) {
          const { container } = render(createElement(Component, { ...state.props, "aria-label": manifest.title }));
          expect(container.querySelector(`[${attribute}]:not([${attribute}="false"])`), `state "${state.name}": ${JSON.stringify(state.props)} must set ${attribute}`).not.toBeNull();
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
