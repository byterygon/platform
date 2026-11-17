// @ts-check
/**
 * by-tokens, in process: the token tools return exactly the JSON document that
 * `by-tokens <command> --json` prints (the engine computes everything; nothing is recomputed here).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@byterygon/design-tokens/cli";

/**
 * Runs one by-tokens command with `--json` and returns its document and exit code.
 * @param {readonly string[]} argv  without `--json`
 * @param {string} cwd              where relative theme paths are read from
 * @returns {Promise<{ exitCode: number; document: Record<string, unknown> }>}
 */
export async function byTokens(argv, cwd) {
  let out = "";
  const exitCode = await run([...argv, "--json"], { stdout: (text) => (out += text), stderr: () => {}, cwd });
  return { exitCode, document: JSON.parse(out) };
}

/**
 * `by-tokens validate --json` on a theme given by name or path, or on a theme file's content
 * (written to a private temporary folder for the call and removed after).
 * @param {{ theme?: string; content?: string; contrast?: boolean; cwd: string }} options
 */
export async function validateTheme({ theme, content, contrast = false, cwd }) {
  const flags = contrast ? ["--contrast"] : [];
  if (content === undefined) return byTokens(["validate", ...(theme ? ["--theme", theme] : []), ...flags], cwd);
  const dir = mkdtempSync(join(tmpdir(), "by-ui-mcp-"));
  try {
    const file = join(dir, "theme.theme.json");
    writeFileSync(file, content);
    return await byTokens(["validate", "--theme", file, ...flags], cwd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
