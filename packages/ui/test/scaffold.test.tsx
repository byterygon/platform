// `pnpm ui:new` output must pass every convention as generated. The scaffold runs into a throwaway
// copy of the package (inside packages/ui, so node_modules resolves), and the generated component
// goes through the same suite as the real ones.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registryItemSchema } from "shadcn/schema";
import { afterAll, describe, expect, test } from "vitest";
import { addGalleryEntry, scaffold, ScaffoldError } from "../scripts/new-component.ts";
import { PACKAGE_ROOT } from "../scripts/registry.ts";
import { describeComponent } from "./suite.tsx";

const temp = mkdtempSync(join(PACKAGE_ROOT, ".scaffold-test-"));
for (const path of ["package.json", "src/lib/cn.ts", "src/lib/theme-scope.ts", "gallery/entries.ts"]) {
  mkdirSync(join(temp, path, ".."), { recursive: true });
  cpSync(join(PACKAGE_ROOT, path), join(temp, path));
}
symlinkSync(join(PACKAGE_ROOT, "node_modules"), join(temp, "node_modules"), "dir");
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const generated = [
  { name: "sample-widget", part: undefined },
  { name: "sample-toggle", part: "toggle" },
];
const results = generated.map(({ name, part }) => ({ name, part, ...scaffold({ name, part, root: temp }) }));

for (const { name } of generated) {
  const dir = join(temp, "src", "components", name);
  const component = join(dir, `${name}.tsx`);
  // The example imports "@/components/<name>/<name>", which the alias points into the real src/.
  // Load a copy (outside the component folder) that imports the generated file directly.
  const example = readFileSync(join(dir, `${name}.example.tsx`), "utf8");
  const copy = join(temp, "examples", `${name}.example.tsx`);
  mkdirSync(join(temp, "examples"), { recursive: true });
  writeFileSync(copy, example.replace(`"@/components/${name}/${name}"`, JSON.stringify(component)));
  describeComponent({
    name,
    dir,
    load: async () => ({
      component: await import(/* @vite-ignore */ component),
      example: await import(/* @vite-ignore */ copy),
    }),
  });
}

describe("ui:new", () => {
  test("writes the four files, a gallery entry and a registry item", () => {
    for (const { name, files } of results) {
      expect(files).toEqual(expect.arrayContaining([`src/components/${name}/${name}.tsx`, `src/components/${name}/${name}.manifest.json`, `src/components/${name}/${name}.example.tsx`, `src/components/${name}/${name}.test.tsx`, "gallery/entries.ts", `registry/${name}.json`]));
      const item = JSON.parse(readFileSync(join(temp, "registry", `${name}.json`), "utf8"));
      expect(registryItemSchema.safeParse(item).success).toBe(true);
      expect(item.registryDependencies).toEqual(["@byterygon/cn"]);
    }
    const entries = readFileSync(join(temp, "gallery", "entries.ts"), "utf8");
    expect(entries.indexOf('"sample-toggle"')).toBeLessThan(entries.indexOf('"sample-widget"'));
  });

  test("wraps the Base UI part it is given, or builds on useRender", () => {
    expect(readFileSync(join(temp, "src/components/sample-toggle/sample-toggle.tsx"), "utf8")).toContain('from "@base-ui/react/toggle"');
    expect(readFileSync(join(temp, "src/components/sample-widget/sample-widget.tsx"), "utf8")).toContain('from "@base-ui/react/use-render"');
    expect(readFileSync(join(temp, "src/components/sample-widget/sample-widget.example.tsx"), "utf8")).toContain('from "@/components/sample-widget/sample-widget"');
  });

  test("refuses a taken name, a bad name and an unknown part, and says how to fix it", () => {
    const failure = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error as ScaffoldError;
      }
      throw new Error("expected a ScaffoldError");
    };
    expect(failure(() => scaffold({ name: "sample-widget", root: temp, registry: false })).code).toBe("exists");
    expect(failure(() => scaffold({ name: "Sample", root: temp, registry: false })).code).toBe("usage");
    const unknown = failure(() => scaffold({ name: "other", part: "no-such-part", root: temp, registry: false }));
    expect(unknown.code).toBe("unknown-part");
    expect(unknown.fix).toMatch(/node_modules\/@base-ui\/react/);
    expect(existsSync(join(temp, "src/components/other"))).toBe(false);
  });

  test("keeps gallery entries in name order between the markers", () => {
    const source = `x\n  // ui:new entries start\n  { name: "b", load: () => import("@/components/b/b.example") },\n  // ui:new entries end\n`;
    expect(addGalleryEntry(source, "a")).toBe(`x\n  // ui:new entries start\n  { name: "a", load: () => import("@/components/a/a.example") },\n  { name: "b", load: () => import("@/components/b/b.example") },\n  // ui:new entries end\n`);
  });
});
