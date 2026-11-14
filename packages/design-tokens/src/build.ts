/**
 * The whole pipeline for one theme: generate, validate, and (only when there are no errors)
 * render the outputs. In memory; the CLI decides what to write.
 */
import type { Catalog } from "./catalog/authoring.js";
import { DEFAULT_CATALOG } from "./catalog/default.js";
import { generateTokens } from "./generate.js";
import { type Diagnostic, type TokenSet, hasErrors } from "./model.js";
import { type OutputFile, renderOutputs } from "./outputs.js";
import type { ResolvedSeeds } from "./seeds.js";
import { type ContrastMeasurement, validate } from "./validate.js";

export { OUTPUT_ALIASES, OUTPUT_FILES, type OutputFile, renderOutputs } from "./outputs.js";

export interface BuildResult {
  /** False when any diagnostic is an error; `files` is then absent. */
  readonly ok: boolean;
  readonly set: TokenSet;
  readonly seeds: ResolvedSeeds;
  /** Theme-file problems first, then rule violations. */
  readonly diagnostics: readonly Diagnostic[];
  readonly contrast: readonly ContrastMeasurement[];
  /** File name -> contents. */
  readonly files?: ReadonlyMap<OutputFile, string>;
}

export interface BuildOptions {
  readonly catalog?: Catalog;
  /** How the generated headers name the theme file. */
  readonly source?: string;
  /** Skip rendering (validation only). */
  readonly render?: boolean;
}

export async function buildTheme(theme: unknown, options: BuildOptions = {}): Promise<BuildResult> {
  const generated = generateTokens(theme, options.catalog ?? DEFAULT_CATALOG);
  const checked = validate(generated.set);
  const diagnostics = [...generated.diagnostics, ...checked.diagnostics];
  const ok = !hasErrors(diagnostics);
  const base = { ok, set: generated.set, seeds: generated.seeds, diagnostics, contrast: checked.contrast };
  if (!ok || options.render === false) return base;
  const source = options.source ?? `themes/${generated.set.name}.theme.json`;
  return { ...base, files: await renderOutputs(generated.set, source) };
}
