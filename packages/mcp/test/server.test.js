// The MCP server end to end: spawned over stdio with the SDK's client, as an agent's client does.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const bin = fileURLToPath(new URL("../bin/by-ui-mcp.js", import.meta.url));
const byTokens = fileURLToPath(new URL("../../design-tokens/bin/by-tokens.js", import.meta.url));
const registryDir = fileURLToPath(new URL(".", import.meta.resolve("@byterygon/ui/registry/registry.json")));
/** @type {Client} */
let client;

before(async () => {
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin], stderr: "pipe" }));
});
after(async () => {
  await client.close();
});

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return { isError: res.isError === true, doc: JSON.parse(res.content[0].text) };
}

test("lists the tools and the llms resources", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_classes", "explain_token", "get_component", "install_registry_item", "list_components", "list_registry_items", "search_tokens", "validate_theme"]);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ["byterygon-ui://registry/llms-full.txt", "byterygon-ui://registry/llms.txt"]);
  const read = await client.readResource({ uri: "byterygon-ui://registry/llms.txt" });
  assert.equal(read.contents[0].text, readFileSync(join(registryDir, "llms.txt"), "utf8"));
  const full = await client.readResource({ uri: "byterygon-ui://registry/llms-full.txt" });
  assert.match(full.contents[0].text, /^## Tokens$/m);
});

test("token tools return the by-tokens documents", async () => {
  const cli = (args) => JSON.parse(execFileSync(process.execPath, [byTokens, ...args, "--json"], { encoding: "utf8" }));
  assert.deepEqual((await call("search_tokens", { query: "hover background", limit: 5 })).doc, cli(["search", "hover", "background", "--limit", "5"]));
  assert.deepEqual((await call("explain_token", { token: "color.bg.surface" })).doc, cli(["explain", "color.bg.surface"]));
  assert.deepEqual((await call("validate_theme", { theme: "paper" })).doc, cli(["validate", "--theme", "paper"]));
  const unknown = await call("explain_token", { token: "color.bg.surfac" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.doc.error.fix, /color\.bg\.surface/);
});

test("validate_theme on a file's content names the token, mode, rule, values and fix", async () => {
  const content = JSON.stringify({ schemaVersion: 1, name: "low", overrides: { "color.fg.muted": "{color.neutral.6}" } });
  const { isError, doc } = await call("validate_theme", { content });
  assert.equal(isError, false);
  assert.equal(doc.ok, false);
  assert.equal(doc.exitCode, 1);
  const failure = doc.diagnostics.find((d) => d.token === "color.fg.muted" && d.severity === "error");
  assert.ok(failure, JSON.stringify(doc.diagnostics.slice(0, 3)));
  for (const key of ["rule", "mode", "measured", "required", "fix"]) assert.ok(key in failure, key);
  assert.equal((await call("validate_theme", { theme: "default", content })).isError, true);
});

test("components: list, manifest and example at installed paths", async () => {
  const { doc } = await call("list_components");
  const index = JSON.parse(readFileSync(join(registryDir, "registry.json"), "utf8"));
  assert.equal(doc.components.length, index.items.filter((i) => i.type === "registry:ui").length);
  assert.ok(doc.components.find((c) => c.name === "button").usage);
  const button = (await call("get_component", { name: "button" })).doc;
  assert.deepEqual(button.manifest.variants.appearance, ["primary", "secondary", "outline", "subtle", "transparent", "danger"]);
  assert.match(button.example, /export function ButtonMinimal/);
  assert.doesNotMatch(button.example, /@\/components\/button\/button/);
  assert.match(button.example, /@\/components\/ui\/button/);
  assert.equal(button.source, undefined);
  assert.match((await call("get_component", { name: "button", includeSource: true })).doc.source, /export function Button/);
  assert.equal((await call("get_component", { name: "cn" })).isError, true);
  assert.equal((await call("get_component", { name: "../etc/passwd" })).doc.error.code, "bad-name");
  const themes = (await call("list_registry_items", { type: "registry:theme" })).doc.items.map((i) => i.name);
  assert.ok(themes.includes("theme-default"));
});

test("check_classes names the role to use", async () => {
  const { doc } = await call("check_classes", { classes: "bg-surface p-[13px] bg-blue-500" });
  assert.deepEqual(doc.findings.map((f) => [f.class, f.rule]), [["p-[13px]", "no-arbitrary-value"], ["bg-blue-500", "no-raw-color"]]);
  assert.deepEqual(doc.findings[0].suggestions, ["p-inset-sm"]);
});

test("install_registry_item: dry run, install, again, into a Vite-like project", async () => {
  const project = mkdtempSync(join(tmpdir(), "by-ui-mcp-project-"));
  mkdirSync(join(project, "src"));
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "app", dependencies: { react: "19.3.1" } }));
  writeFileSync(join(project, "tsconfig.json"), '{\n  // Vite\n  "compilerOptions": { "paths": { "@/*": ["./src/*"] }, },\n}\n');
  writeFileSync(join(project, "components.json"), JSON.stringify({ tailwind: { css: "src/index.css" }, aliases: { components: "@/components", ui: "@/components/ui", lib: "@/lib", utils: "@/lib/utils" } }));
  const dry = (await call("install_registry_item", { project, items: ["button", "theme-default"], dryRun: true })).doc;
  assert.deepEqual(dry.items, ["cn", "control", "button", "theme-default"]);
  assert.deepEqual(dry.files.map((f) => [f.path, f.action]), [["src/lib/cn.ts", "create"], ["src/lib/control.ts", "create"], ["src/components/ui/button.tsx", "create"], ["src/byterygon-theme-default.css", "create"]]);
  assert.ok(!existsSync(join(project, "src/components")), "a dry run writes nothing");
  assert.deepEqual(Object.keys(dry.missingDependencies).sort(), ["@base-ui/react", "cn"].sort());
  assert.match(dry.next.join("\n"), /@import "\.\/byterygon-theme-default\.css"/);

  const real = (await call("install_registry_item", { project, items: ["@byterygon/button", "theme-default"] })).doc;
  assert.equal(real.dryRun, false);
  const button = JSON.parse(readFileSync(join(registryDir, "button.json"), "utf8"));
  assert.equal(readFileSync(join(project, "src/components/ui/button.tsx"), "utf8"), button.files[0].content);
  const css = readFileSync(join(project, "src/byterygon-theme-default.css"), "utf8");
  assert.match(css, /^@custom-variant dark /m);
  assert.match(css, /--by-color-bg-surface: /);
  assert.match(css, /@theme inline \{\n  --spacing: var\(--by-space-1\);/);
  const again = (await call("install_registry_item", { project, items: ["button"] })).doc;
  assert.ok(again.files.every((f) => f.action === "unchanged"));
  writeFileSync(join(project, "src/components/ui/button.tsx"), "// edited\n");
  assert.equal((await call("install_registry_item", { project, items: ["button"] })).doc.files.find((f) => f.path.endsWith("button.tsx")).action, "skip");
  assert.equal(readFileSync(join(project, "src/components/ui/button.tsx"), "utf8"), "// edited\n");
});
