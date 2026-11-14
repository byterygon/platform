// Runs the component conventions on every folder in src/components, and the package-wide checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { roleNames } from "@/lib/cn";
import { listComponents } from "../scripts/lib/manifest.ts";
import { gallery } from "../gallery/entries.ts";
import { checkClasses, tailwindThemeCss } from "./conventions.ts";
import { describeComponent } from "./suite.tsx";

const root = join(import.meta.dirname, "..");
const components = import.meta.glob<Record<string, unknown>>("../src/components/*/*.tsx");
const names = listComponents(root);

for (const name of names) {
  describeComponent({
    name,
    dir: join(root, "src", "components", name),
    load: async () => ({
      component: await components[`../src/components/${name}/${name}.tsx`]!(),
      example: await components[`../src/components/${name}/${name}.example.tsx`]!(),
    }),
  });
}

describe("package", () => {
  test("has components", () => {
    expect(names.length).toBeGreaterThan(0);
  });

  test("every component has a gallery entry, and every entry a component", () => {
    expect(gallery.map((entry) => entry.name).sort()).toEqual(names);
  });

  test("cn knows every Tailwind role name the tokens define", () => {
    const names = (prefix: string) => [...tailwindThemeCss.matchAll(new RegExp(`^\\s*--${prefix}-([a-z0-9-]+?)(?:--[a-z-]+)?:`, "gm"))].map((m) => m[1]!);
    const unique = (list: string[]) => [...new Set(list)].sort();
    expect(unique(names("text")), "add the new text roles to roleNames.text in src/lib/cn.ts").toEqual(unique([...roleNames.text]));
    expect(unique(names("spacing")), "add the new space and size roles to roleNames.spacing in src/lib/cn.ts").toEqual(unique([...roleNames.spacing]));
    expect(unique(names("shadow")), "add the new shadows to roleNames.shadow in src/lib/cn.ts").toEqual(unique([...roleNames.shadow]));
    expect(unique(names("ease")), "add the new easings to roleNames.ease in src/lib/cn.ts").toEqual(unique([...roleNames.ease]));
  });

  test("the token-only check rejects raw values, primitives and shadcn's accent", async () => {
    const reject = async (name: string, reason: RegExp) => {
      const { errors } = await checkClasses([name]);
      expect(errors.join("\n"), name).toMatch(reason);
    };
    await reject("bg-blue-500", /not a utility under the token theme/);
    await reject("font-medium", /not a utility under the token theme/);
    await reject("p-[13px]", /arbitrary value must be a token variable/);
    await reject("bg-[#ff0000]", /arbitrary value must be a token variable/);
    await reject("bg-[var(--by-color-brand-9)]", /primitive color\.brand\.9/);
    await reject("p-2", /primitive space\.1/);
    await reject("hover:bg-accent", /accent-solid/);
    expect((await checkClasses(["bg-surface", "hover:bg-accent-solid", "p-inset-md", "z-[var(--by-z-modal)]"])).errors).toEqual([]);
  });

  test("a manifest that depends on Radix is invalid (Base UI only)", async () => {
    const { readManifest, validateManifest } = await import("../scripts/lib/manifest.ts");
    const manifest = readManifest(root, "button");
    for (const dep of ["radix-ui", "@radix-ui/react-slot"]) {
      expect(validateManifest({ ...manifest, dependencies: [...manifest.dependencies, dep] }, "button").join("\n")).toMatch(/Base UI only/);
    }
  });

  test("a manifest needs a usage note, and parts are named after the component", async () => {
    const { readManifest, validateManifest } = await import("../scripts/lib/manifest.ts");
    const { usage: _usage, ...noUsage } = readManifest(root, "button");
    expect(validateManifest(noUsage, "button").join("\n")).toMatch(/usage/);
    const field = readManifest(root, "field");
    expect(validateManifest(field, "field")).toEqual([]);
    const bad = [{ name: "Label", slot: "field-label", description: "x" }, { name: "FieldLabel", slot: "label", description: "x" }, { name: "Field", slot: "field", description: "x" }];
    expect(validateManifest({ ...field, parts: bad }, "field")).toEqual([
      'parts[0].name must be "Field" plus a PascalCase suffix',
      'parts[1].slot must be "field-" plus a kebab-case suffix',
      'parts[2].name must be "Field" plus a PascalCase suffix',
      'parts[2].slot must be "field-" plus a kebab-case suffix',
    ]);
  });

  test("the manifest schema requires what the validator requires", async () => {
    const { REQUIRED_KEYS } = await import("../scripts/lib/manifest.ts");
    const schema = JSON.parse(readFileSync(join(root, "component.manifest.schema.json"), "utf8")) as { required: string[] };
    expect([...schema.required].sort()).toEqual([...REQUIRED_KEYS].sort());
  });
});
