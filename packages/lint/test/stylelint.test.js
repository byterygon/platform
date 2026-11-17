// The Stylelint rules on the good and bad fixtures (spec section 9a.4).
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import stylelint from "stylelint";
import config from "@byterygon/lint/stylelint-config";

const fixture = (name) => fileURLToPath(new URL(`fixtures/${name}`, import.meta.url));

async function lint(name) {
  const { results } = await stylelint.lint({ files: [fixture(name)], config });
  const [result] = results;
  assert.deepEqual(result?.invalidOptionWarnings, []);
  return (result?.warnings ?? []).map((w) => ({ line: w.line, rule: w.rule, text: w.text }));
}

test("good.css: token variables, keywords, hairlines and system colours pass", async () => {
  assert.deepEqual(await lint("good.css"), []);
});

test("bad.css: raw colours, off-scale lengths and @apply classes are reported, naming the token", async () => {
  const warnings = await lint("bad.css");
  assert.deepEqual(
    warnings.map((w) => `${w.line} ${w.rule}`).sort(),
    ["3 byterygon/no-off-scale-spacing", "4 byterygon/no-off-scale-spacing", "5 byterygon/no-raw-color", "6 byterygon/no-raw-color", "7 byterygon/no-raw-color", "8 byterygon/no-raw-color", "12 byterygon/no-raw-color", "13 byterygon/no-arbitrary-value", "14 byterygon/no-off-scale-spacing"].sort(),
  );
  const text = (line) => warnings.find((w) => w.line === line)?.text ?? "";
  assert.match(text(3), /padding: 13px is off the space scale\. Use a space role: var\(--by-space-inset-sm\) \(space\.inset\.sm, 12px comfortable \/ 8px compact\)/);
  assert.match(text(4), /var\(--by-space-stack-sm\)/);
  assert.match(text(5), /"#0e7490" is a raw colour\. Use a colour role: var\(--by-color-/);
  assert.match(text(7), /border-color: "white".*var\(--by-color-border/);
  assert.match(text(12), /@apply "bg-blue-500" is a raw colour/);
  assert.match(text(13), /p-inset-sm/);
});

test("a stylelint disable needs a reason", async () => {
  const code = ".a {\n  /* stylelint-disable-next-line byterygon/no-raw-color */\n  color: #fff;\n  /* stylelint-disable-next-line byterygon/no-raw-color -- printed pages are white */\n  background: #fff;\n}\n";
  const { results } = await stylelint.lint({ code, config, codeFilename: fixture("inline.css") });
  assert.deepEqual(results[0]?.warnings.map((w) => [w.line, w.rule]), [[2, "--report-descriptionless-disables"]]);
});
