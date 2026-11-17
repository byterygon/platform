// install_registry_item writes only inside the project folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Registry, RegistryError, install } from "../src/registry.js";

/** A registry folder with the given items. */
function fakeRegistry(items) {
  const dir = mkdtempSync(join(tmpdir(), "by-ui-mcp-registry-"));
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ name: "fake", items: items.map(({ files: _f, ...rest }) => rest) }));
  for (const item of items) writeFileSync(join(dir, `${item.name}.json`), JSON.stringify(item));
  return new Registry(dir);
}
const ui = (name, extra = {}) => ({ name, type: "registry:ui", files: [{ path: `ui/${name}.tsx`, type: "registry:ui", content: `export const ${name.replace(/-/g, "")} = 1;\n` }], ...extra });
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), "by-ui-mcp-target-"));
  mkdirSync(join(dir, "src"));
  return dir;
};
const refused = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof RegistryError);
    return error;
  }
  assert.fail("expected a refusal");
};

test("a file target outside the project refuses the whole install, writing nothing", () => {
  const registry = fakeRegistry([ui("good"), { name: "evil", type: "registry:ui", registryDependencies: ["@byterygon/good"], files: [{ path: "ui/evil.tsx", type: "registry:ui", target: "../../evil.tsx", content: "x" }] }]);
  const dir = project();
  const error = refused(() => install(registry, { project: dir, items: ["evil"] }));
  assert.equal(error.code, "outside-project");
  assert.deepEqual(error.details.refused.map((r) => r.reason), ["outside the project folder"]);
  assert.deepEqual(readdirSync(join(dir, "src")), []);
});

test("absolute targets and aliases that leave the project are refused", () => {
  const dir = project();
  assert.equal(refused(() => install(fakeRegistry([{ name: "abs", type: "registry:lib", files: [{ path: "lib/abs.ts", type: "registry:lib", target: "/tmp/abs.ts", content: "x" }] }]), { project: dir, items: ["abs"] })).code, "outside-project");
  writeFileSync(join(dir, "components.json"), JSON.stringify({ aliases: { ui: "@/../../outside" } }));
  assert.equal(refused(() => install(fakeRegistry([ui("button")]), { project: dir, items: ["button"] })).code, "outside-project");
});

test("a symbolic link out of the project is refused", () => {
  const dir = project();
  const elsewhere = mkdtempSync(join(tmpdir(), "by-ui-mcp-elsewhere-"));
  mkdirSync(join(dir, "src", "components"));
  symlinkSync(elsewhere, join(dir, "src", "components", "ui"));
  const error = refused(() => install(fakeRegistry([ui("button")]), { project: dir, items: ["button"] }));
  assert.match(error.details.refused[0].reason, /symbolic link/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test("item names cannot walk the registry folder; unknown items get suggestions", () => {
  const registry = fakeRegistry([ui("button"), ui("icon-button")]);
  assert.equal(refused(() => registry.item("../registry")).code, "bad-name");
  const unknown = refused(() => registry.item("butto"));
  assert.equal(unknown.code, "unknown-item");
  assert.match(String(unknown.details.fix), /button/);
});

test("aliases from components.json and the tsconfig path decide where files go", () => {
  const dir = project();
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./app/*"] } } }));
  writeFileSync(join(dir, "components.json"), JSON.stringify({ aliases: { ui: "@/widgets", lib: "@/shared" } }));
  const registry = fakeRegistry([{ name: "cn", type: "registry:lib", files: [{ path: "lib/cn.ts", type: "registry:lib", content: "export const cn = 1;\n" }] }, ui("button", { registryDependencies: ["@byterygon/cn"], files: [{ path: "ui/button.tsx", type: "registry:ui", content: 'import { cn } from "@/lib/cn";\nimport { Icon } from "@/components/ui/icon";\n' }] })]);
  const result = install(registry, { project: dir, items: ["button"] });
  assert.deepEqual(result.files.map((f) => f.path), ["app/shared/cn.ts", "app/widgets/button.tsx"]);
  assert.equal(readFileSync(join(dir, "app/widgets/button.tsx"), "utf8"), 'import { cn } from "@/shared/cn";\nimport { Icon } from "@/widgets/icon";\n');
});

test("the server source opens no listener and touches no network", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  for (const dir of ["src", "bin"]) {
    for (const file of readdirSync(join(root, dir))) {
      const source = readFileSync(join(root, dir, file), "utf8");
      assert.doesNotMatch(source, /node:(?:http|https|net|dgram|tls)|from "(?:http|https|net|express|hono)|\bfetch\(|\.listen\(|server\/(?:sse|streamableHttp|express)/, `${dir}/${file}`);
    }
  }
  assert.ok(existsSync(join(root, "bin", "by-ui-mcp.js")));
});
