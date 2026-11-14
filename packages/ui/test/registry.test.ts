import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registryItemSchema, registrySchema } from "shadcn/schema";
import { describe, expect, test } from "vitest";
import { listComponents } from "../scripts/lib/manifest.ts";
import { buildRegistry, presets, RegistryError, shipSource, syncRegistry, PACKAGE_ROOT } from "../scripts/registry.ts";

const files = buildRegistry();
const item = (name: string) => JSON.parse(files.get(`${name}.json`)!) as Record<string, any>;

describe("registry", () => {
  test("the committed registry/ is what the build writes (drift)", () => {
    const { stale } = syncRegistry({ check: true });
    expect(stale, "run `pnpm --filter @byterygon/ui registry` and commit registry/").toEqual([]);
  });

  test("every item is a valid shadcn registry item, and the index a valid registry", () => {
    for (const [file, content] of files) {
      if (!file.endsWith(".json") || file === "registry.json") continue;
      const parsed = registryItemSchema.safeParse(JSON.parse(content));
      expect(parsed.success, `${file}: ${parsed.success ? "" : parsed.error.message}`).toBe(true);
    }
    const index = registrySchema.safeParse(JSON.parse(files.get("registry.json")!));
    expect(index.success, index.success ? "" : index.error.message).toBe(true);
  });

  test("has one item per component, the cn helper and one theme per token preset", () => {
    const names = [...files.keys()].filter((f) => f.endsWith(".json") && f !== "registry.json").map((f) => f.slice(0, -5)).sort();
    expect(names).toEqual([...listComponents(PACKAGE_ROOT), "cn", ...presets().map((p) => `theme-${p}`)].sort());
  });

  test("a component item ships its source, its pinned dependencies and its manifest", () => {
    const button = item("button");
    const source = readFileSync(join(PACKAGE_ROOT, "src/components/button/button.tsx"), "utf8");
    expect(button.files).toEqual([{ path: "ui/button.tsx", type: "registry:ui", content: source }]);
    // Bare names: the shadcn CLI reinstalls a dependency that has a version specifier.
    expect(button.dependencies).toEqual(["@base-ui/react"]);
    expect(button.meta.dependencyVersions).toEqual({ "@base-ui/react": "1.9.0" });
    expect(button.registryDependencies).toEqual(["@byterygon/cn"]);
    expect(button.meta.manifest.tokens).toContain("color.accent.bg");
    expect(button.meta.example).toContain("export function ButtonMinimal");
  });

  test("imports between components become shadcn paths and registry dependencies", () => {
    const shipped = shipSource(`import { Button } from "@/components/button/button";\nimport { cn } from "@/lib/cn";\n`, "toolbar");
    expect(shipped.content).toBe(`import { Button } from "@/components/ui/button";\nimport { cn } from "@/lib/cn";\n`);
    expect(shipped.registryDependencies).toEqual(["@byterygon/button", "@byterygon/cn"]);
    expect(() => shipSource(`import x from "@/hooks/x";\n`, "toolbar")).toThrow(RegistryError);
  });

  test("a theme item carries every token variable, the shadcn aliases and both Tailwind vocabularies", () => {
    const theme = item("theme-default");
    const tokensCss = readFileSync(join(PACKAGE_ROOT, "../design-tokens/generated/default/tokens.css"), "utf8");
    const declared = new Set([...tokensCss.matchAll(/^\s*(--by-[a-z0-9-]+):/gm)].map((m) => m[1]!));
    const shipped = new Set(Object.values(theme.css as Record<string, Record<string, string>>).flatMap((block) => Object.keys(block)));
    for (const name of declared) expect(shipped.has(name), name).toBe(true);
    expect(theme.css['[data-density="compact"]']["--by-size-control-md"]).toBe("28px");
    expect(theme.css[':root, [data-theme="light"], .light, [data-theme="dark"], .dark']["--primary"]).toBe("var(--by-color-accent-bg)");
    expect(Object.keys(theme.css)[0]).toMatch(/^@custom-variant dark /);
    // Byterygon's names, and shadcn's colour names; shadcn's accent wins where they collide.
    expect(theme.cssVars.theme["color-surface"]).toBe("var(--by-color-bg-surface)");
    expect(theme.cssVars.theme["color-accent-solid"]).toBe("var(--by-color-accent-bg)");
    expect(theme.cssVars.theme["color-primary"]).toBe("var(--primary)");
    expect(theme.cssVars.theme["color-accent"]).toBe("var(--accent)");
    expect(theme.cssVars.theme["radius-md"]).toBe("var(--by-radius-md)");
  });

  test("an import the registry cannot ship stops the build with the problem named", () => {
    expect(() => shipSource(`import x from "@/components/a/b";\n`, "bad")).toThrow(/imports @\/components\/a\/b/);
  });

  test("llms.txt lists every component with its variants and tokens", () => {
    const llms = files.get("llms.txt")!;
    for (const name of listComponents(PACKAGE_ROOT)) expect(llms).toContain(`[${name}.json](${name}.json)`);
    expect(llms).toContain("- variant: primary, secondary, ghost, danger");
  });
});
