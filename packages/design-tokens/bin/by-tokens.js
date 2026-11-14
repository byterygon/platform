#!/usr/bin/env node
// by-tokens: the command-line entry of @byterygon/design-tokens. The code lives in src/cli and
// is compiled to dist/cli by `pnpm --filter @byterygon/design-tokens build`.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = new URL("../dist/cli/main.js", import.meta.url);

if (!existsSync(fileURLToPath(entry))) {
  const error = {
    code: "not-built",
    message: "by-tokens has not been compiled yet (dist/cli/main.js is missing)",
    fix: "Run `pnpm --filter @byterygon/design-tokens build`, then run the command again.",
  };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, command: "by-tokens", ok: false, exitCode: 2, error }, null, 2)}\n`);
  } else {
    process.stderr.write(`error: ${error.message}\n  fix: ${error.fix}\n`);
  }
  process.exitCode = 2;
} else {
  const { run } = await import(entry.href);
  process.exitCode = await run(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
  });
}
