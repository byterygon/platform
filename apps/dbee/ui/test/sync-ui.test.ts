// @vitest-environment node
// The registry install script (spec §2, §7): the plan covers every item the screens use.
import { describe, expect, test } from "vitest";
import { ITEMS, closure, plan } from "../scripts/sync-ui";

describe("registry install (spec §2, §7)", () => {
  test("every item the screens use is in the plan, with its dependencies, as a src/components/ui or src/lib file", () => {
    const names = closure(ITEMS);
    for (const needed of ["sidebar", "tree", "tabs", "sql-editor", "cn", "theme-scope", "monaco", "motion", "button", "dialog", "icon-button", "tooltip"]) expect(names).toContain(needed);
    const files = plan();
    expect(files.every((f) => f.path.startsWith("src/components/ui/") || f.path.startsWith("src/lib/"))).toBe(true);
    expect(files.find((f) => f.path === "src/lib/monaco.ts")).toBeDefined();
    expect(files.find((f) => f.path === "src/components/ui/button.tsx")?.content).toContain("export function Button");
  });
});
