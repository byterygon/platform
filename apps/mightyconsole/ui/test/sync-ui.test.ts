// @vitest-environment node
// The registry install script (spec §2.1, as DBee): the plan covers every item the shell uses.
import { describe, expect, test } from "vitest";
import { ITEMS, closure, plan } from "../scripts/sync-ui";

describe("registry install", () => {
  test("every item the shell uses is in the plan, with its dependencies, as a src/components/ui or src/lib file", () => {
    const names = closure(ITEMS);
    for (const needed of ["sidebar", "tree", "tabs", "command-palette", "status-bar", "toolbar", "cn", "theme-scope", "motion", "button", "dialog", "icon-button", "tooltip"]) expect(names).toContain(needed);
    const files = plan();
    expect(files.every((f) => f.path.startsWith("src/components/ui/") || f.path.startsWith("src/lib/"))).toBe(true);
    expect(files.find((f) => f.path === "src/components/ui/button.tsx")?.content).toContain("export function Button");
  });
});
