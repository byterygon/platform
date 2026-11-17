// The ESLint rules on the good and bad fixtures (spec section 9a.4).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ESLint } from "eslint";
import byterygon from "@byterygon/lint/eslint";

const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));
const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: byterygon.configs.recommended, cwd: fileURLToPath(new URL("..", import.meta.url)) });

async function lint(name) {
  const [result] = await eslint.lintFiles([fixture(name)]);
  return result.messages.map((m) => ({ line: m.line, rule: m.ruleId, message: m.message, suggestions: (m.suggestions ?? []).map((s) => s.desc) }));
}

test("good.tsx: roles, keywords, fractions and token variables pass", async () => {
  assert.deepEqual(await lint("good.tsx"), []);
});

test("bad.tsx: every raw colour, arbitrary value and raw space step is reported, naming the role", async () => {
  const messages = await lint("bad.tsx");
  const found = messages.map((m) => `${m.line} ${m.rule} ${m.message.match(/^"[^"]+"|^style \w+/)?.[0]}`);
  assert.deepEqual(found.sort(), [
    '9 byterygon/no-raw-color "bg-red-600"',
    '9 byterygon/no-raw-color "border-gray-200"',
    '9 byterygon/no-raw-color "text-white"',
    '14 byterygon/no-off-scale-spacing "gap-3"',
    '14 byterygon/no-raw-color "bg-[#0e7490]"',
    '15 byterygon/no-arbitrary-value "p-[13px]"',
    '16 byterygon/no-off-scale-spacing "h-8"',
    '16 byterygon/no-off-scale-spacing "mt-2"',
    '16 byterygon/no-off-scale-spacing "w-36"',
    '17 byterygon/no-arbitrary-value "max-h-[50dvh]"',
    '17 byterygon/no-arbitrary-value "w-[var(--sidebar)]"',
    '17 byterygon/no-raw-color "bg-[var(--by-color-blue-9)]"',
    '18 byterygon/no-raw-color style backgroundColor',
    '19 byterygon/require-disable-reason undefined',
    '6 byterygon/no-off-scale-spacing "p-4"',
    '6 byterygon/no-raw-color "bg-white"',
    '8 byterygon/no-arbitrary-value "text-[13px]"',
  ].sort());
  const message = (cls) => messages.find((m) => m.message.startsWith(`"${cls}"`))?.message ?? "";
  assert.match(message("p-[13px]"), /Use a space role: p-inset-sm \(space\.inset\.sm, 12px comfortable \/ 8px compact\)/);
  assert.match(message("gap-3"), /gap-gap-md \(space\.gap\.md/);
  assert.match(message("p-4"), /p-inset-md \(space\.inset\.md, 16px/);
  assert.match(message("h-8"), /Use h-control-md \(size\.control\.md, 32px comfortable \/ 28px compact\)/);
  assert.match(message("w-36"), /off the space scale \(144px\)/);
  assert.match(message("text-[13px]"), /Use a text role: text-caption-1/);
  assert.match(message("bg-red-600"), /Use a background role: bg-danger /);
  assert.match(message("border-gray-200"), /Use a border and ring role: border-border-/);
  assert.match(message("bg-[var(--by-color-blue-9)]"), /colour primitive color\.blue\.9/);
  // A plain string literal gets editor suggestions that swap the class.
  assert.deepEqual(messages.find((m) => m.message.startsWith('"p-[13px]"'))?.suggestions, ["Replace with p-inset-sm"]);
});

test("a directive that turns off a byterygon rule needs a reason; a blanket one is reported", async () => {
  const [result] = await eslint.lintText("// eslint-disable-next-line\nconst a = 1;\n// eslint-disable-next-line byterygon/no-raw-color\nconst b = 2;\n// eslint-disable-next-line byterygon/no-raw-color -- a reason\nconst c = 3;\n", { filePath: fixture("inline.ts") });
  // (The unused-directive warnings of ESLint itself have no rule id.)
  assert.deepEqual(result.messages.filter((m) => m.ruleId).map((m) => [m.line, m.ruleId, m.messageId]), [
    [1, "byterygon/require-disable-reason", "blanket"],
    [3, "byterygon/require-disable-reason", "reason"],
  ]);
});
