// Licences of what the registry ships (TSK-46): every npm package a registry item depends on, and
// everything those packages depend on in turn, must carry a licence that cargo-deny would accept
// for a crate: the `allow` list of the repository's deny.toml (SPDX expressions, an OR passes when
// one side is allowed). scripts/check-licenses.mjs covers the workspace's own packages.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildRegistry, PACKAGE_ROOT } from "../scripts/registry.ts";

const denyToml = readFileSync(join(PACKAGE_ROOT, "..", "..", "deny.toml"), "utf8");
const licensesSection = denyToml.slice(denyToml.indexOf("[licenses]"), denyToml.indexOf("[bans]"));
const ALLOW = new Set([...licensesSection.slice(licensesSection.indexOf("allow = [")).split("]")[0]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));

/** Whether an SPDX expression is satisfied by the allowed licences. */
export function allowed(expression: string): boolean {
  const text = expression.trim().replace(/^\((.*)\)$/, "$1");
  const alternatives = text.split(/\s+OR\s+/i);
  return alternatives.some((alternative) => alternative.replace(/[()]/g, "").split(/\s+AND\s+/i).every((id) => ALLOW.has(id.trim())));
}

interface PackageJson {
  name: string;
  version: string;
  license?: string | { type: string };
  licenses?: { type: string }[];
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

/** Every installed package reachable from `roots` through dependencies, with its licence. */
function closure(roots: string[]): Map<string, { version: string; license: string }> {
  const seen = new Map<string, { version: string; license: string }>();
  const visit = (name: string, from: string) => {
    // Node's lookup, by directory: `require.resolve("x/package.json")` fails for packages whose
    // `exports` do not list it (marked, dompurify).
    let manifestPath: string | undefined;
    for (let dir = from; ; dir = dirname(dir)) {
      const candidate = join(dir, "node_modules", name, "package.json");
      if (existsSync(candidate)) {
        manifestPath = realpathSync(candidate);
        break;
      }
      if (dirname(dir) === dir) break;
    }
    if (!manifestPath) return; // an optional dependency that is not installed on this platform
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as PackageJson;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN");
    seen.set(key, { version: pkg.version, license });
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) visit(dep, dirname(manifestPath));
  };
  for (const root of roots) visit(root, PACKAGE_ROOT);
  return seen;
}

describe("licences of the registry's npm dependencies", () => {
  test("deny.toml's allow list is read", () => {
    expect(ALLOW.has("MIT")).toBe(true);
    expect(ALLOW.has("Apache-2.0")).toBe(true);
    expect(allowed("MPL-2.0 OR Apache-2.0")).toBe(true);
    expect(allowed("(MIT OR CC0-1.0)")).toBe(true);
    expect(allowed("MPL-2.0")).toBe(false);
    expect(allowed("MIT AND CC-BY-4.0")).toBe(false);
  });

  test("every package an item installs, and their dependencies, has an allowed licence", () => {
    const roots = new Set<string>(["react", "react-dom"]);
    for (const [file, content] of buildRegistry()) {
      if (!file.endsWith(".json") || file === "registry.json") continue;
      for (const dep of (JSON.parse(content) as { dependencies?: string[] }).dependencies ?? []) roots.add(dep);
    }
    expect(roots.has("monaco-editor")).toBe(true);
    const packages = closure([...roots]);
    // Transitive dependencies are walked: Monaco's own (marked, dompurify) are in the set.
    expect([...packages.keys()].filter((k) => /^(?:marked|dompurify)@/.test(k))).toHaveLength(2);
    const denied = [...packages].filter(([, p]) => !allowed(p.license)).map(([key, p]) => `${key}: ${p.license}`);
    expect(denied, "add the licence to deny.toml only with Uy Son's approval, or drop the package").toEqual([]);
  });
});
