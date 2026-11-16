// The browser check serves the editors under the CSPs Byterygon apps send (INTERNAL_CSPS). This keeps
// its Tauri entry in step with the policy the desktop really ships, `ambidex_tauri::CSP`: every
// directive equal except `connect-src`, which the check narrows to the page (no IPC there).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { INTERNAL_CSPS } from "../scripts/browser-check.ts";

const directives = (csp: string) =>
  new Map(
    csp
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values.join(" ")] as const;
      }),
  );

test("the check's tauri-desktop CSP is ambidex_tauri::CSP with connect-src narrowed", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "..", "crates", "ambidex-tauri", "src", "lib.rs"), "utf8");
  const literal = /pub const CSP: &str = "([\s\S]*?)";/.exec(source)![1]!.replace(/\\\n/g, "");
  const shipped = directives(literal);
  const checked = directives(INTERNAL_CSPS["tauri-desktop"]!.csp);
  shipped.delete("connect-src");
  checked.delete("connect-src");
  expect(Object.fromEntries(checked)).toEqual(Object.fromEntries(shipped));
  expect(INTERNAL_CSPS["tauri-desktop"]!.knownIssue).toBeUndefined();
});

test("no internal CSP allows eval or inline scripts", () => {
  for (const { csp } of Object.values(INTERNAL_CSPS)) {
    expect(directives(csp).get("script-src")).toBe("'self'");
    expect(csp).not.toContain("unsafe-eval");
  }
});
