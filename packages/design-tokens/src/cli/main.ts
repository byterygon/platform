/**
 * `by-tokens`: the headless interface to the token engine. Non-interactive; every command takes
 * `--json` and prints exactly one JSON document to stdout; exit codes are stable (see `EXIT`).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { type BuildResult, OUTPUT_ALIASES, OUTPUT_FILES, buildTheme } from "../build.js";
import { generateTokens } from "../generate.js";
import { type Diagnostic, type ModeContext, type Token, type TokenSet, SCHEMA_VERSION, TIERS, hasErrors } from "../model.js";
import { dependentAxes, ownValues, referencedBy, resolve } from "../resolve.js";
import { closest, isPlainObject, stableJson } from "../util.js";
import { type ContrastMeasurement, contextsFor, validate } from "../validate.js";
import { TOKEN_TYPES, cssValue, cssVarName } from "../values.js";
import { COMMANDS, EXIT, EXIT_CODES, type ParsedArgs, UsageError, parseArgs } from "./args.js";

export { EXIT } from "./args.js";

export interface Io {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly cwd: string;
}

interface Outcome {
  readonly exitCode: number;
  /** Merged into the JSON envelope. */
  readonly data: Record<string, unknown>;
  /** The text shown without `--json`. */
  readonly text: string;
  /** Printed to stdout as it is, without `--json` (the `export` command). */
  readonly raw?: string;
}

/** The package directory: the nearest ancestor of this file that holds the package's package.json. */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && existsSync(join(dir, "themes"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("cannot find the @byterygon/design-tokens package directory");
    dir = parent;
  }
}

// ---------------------------------------------------------------------------------------------
// Themes

interface LoadedTheme {
  readonly theme: unknown;
  /** Absolute path of the file. */
  readonly file: string;
  /** How generated headers name the file (no absolute paths, so outputs are reproducible). */
  readonly source: string;
  readonly builtIn: boolean;
}

const presetDir = () => join(packageRoot(), "themes");
const PRESET_SUFFIX = ".theme.json";

function presetNames(): string[] {
  return readdirSync(presetDir())
    .filter((file) => file.endsWith(PRESET_SUFFIX))
    .map((file) => file.slice(0, -PRESET_SUFFIX.length))
    .sort();
}

function loadTheme(spec: string, io: Io): LoadedTheme {
  const isFile = spec.endsWith(".json") || spec.includes("/") || spec.includes("\\");
  const file = isFile ? resolvePath(io.cwd, spec) : join(presetDir(), `${spec}${PRESET_SUFFIX}`);
  if (!existsSync(file)) {
    if (isFile) throw new UsageError("theme-not-found", `no theme file at ${file}`, "Pass a path to a theme file, or a preset name from `by-tokens preset list`.");
    const names = presetNames();
    const near = closest(spec, names);
    throw new UsageError("theme-not-found", `no preset named "${spec}"`, `${near.length > 0 ? `Did you mean ${near.join(" or ")}? ` : ""}Presets: ${names.join(", ")}. A theme file must be given as a path ending in .json.`);
  }
  let theme: unknown;
  try {
    theme = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new UsageError("theme-invalid-json", `${file} is not valid JSON: ${(cause as Error).message}`, "Fix the syntax; a theme is a plain JSON object.");
  }
  return { theme, file, source: isFile ? basename(file) : `themes/${spec}${PRESET_SUFFIX}`, builtIn: !isFile };
}

/** A path as shown to the user: relative to the working directory when it is inside it. */
function display(io: Io, path: string): string {
  const shown = relative(io.cwd, path);
  return shown === "" ? "." : shown.startsWith("..") ? path : shown;
}

const themeFlag = (args: ParsedArgs) => args.flags.get("--theme")?.[0] ?? "default";
const flag = (args: ParsedArgs, name: string) => args.flags.get(name)?.[0];

// ---------------------------------------------------------------------------------------------
// Text rendering

const modeText = (mode: ModeContext | undefined) => {
  const parts = Object.entries(mode ?? {}).map(([axis, value]) => `${axis}=${value}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
};

function diagnosticText(diagnostic: Diagnostic): string {
  const lines = [`${diagnostic.severity} ${diagnostic.rule}: ${diagnostic.message}`];
  if (diagnostic.token) lines.push(`  token: ${diagnostic.token}${diagnostic.related ? `  related: ${diagnostic.related}` : ""}${modeText(diagnostic.mode)}`);
  if (diagnostic.measured !== undefined || diagnostic.required !== undefined) {
    lines.push(`  measured: ${diagnostic.measured ?? "-"}  required: ${diagnostic.required ?? "-"}`);
  }
  if (diagnostic.fix) {
    lines.push(`  fix: ${diagnostic.fix.summary}`);
    if (diagnostic.fix.overrides) lines.push(`    overrides: ${JSON.stringify(diagnostic.fix.overrides)}`);
    if (diagnostic.fix.seeds) lines.push(`    seeds: ${JSON.stringify(diagnostic.fix.seeds)}`);
    for (const alternative of diagnostic.fix.alternatives ?? []) {
      lines.push(`  or: ${alternative.summary}`);
      if (alternative.overrides) lines.push(`    overrides: ${JSON.stringify(alternative.overrides)}`);
    }
  }
  return lines.join("\n");
}

function diagnosticsText(diagnostics: readonly Diagnostic[]): string[] {
  if (diagnostics.length === 0) return [];
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return [...diagnostics.map(diagnosticText), `${errors} error${errors === 1 ? "" : "s"}, ${diagnostics.length - errors} warning${diagnostics.length - errors === 1 ? "" : "s"}`];
}

function contrastSummary(result: { contrast: readonly ContrastMeasurement[]; set: TokenSet }, all: boolean) {
  const sorted = [...result.contrast].sort((a, b) => a.ratio / a.required - b.ratio / b.required);
  return {
    level: result.set.contrast.level,
    targets: { text: result.set.contrast.text, ui: result.set.contrast.ui, ...(result.set.contrast.apca ? { apca: result.set.contrast.apca } : {}) },
    checked: sorted.length,
    failing: sorted.filter((m) => !m.pass).length,
    lowest: sorted.slice(0, all ? sorted.length : 5),
  };
}

function tokenCounts(set: TokenSet) {
  const byTier = Object.fromEntries(TIERS.map((tier) => [tier, 0]));
  for (const token of set.tokens.values()) byTier[token.tier] = (byTier[token.tier] ?? 0) + 1;
  return { total: set.tokens.size, byTier };
}

const measurementText = (m: ContrastMeasurement) =>
  `  ${m.pass ? "pass" : "FAIL"} ${m.ratio}:1 (needs ${m.required}:1, APCA Lc ${m.apca})  ${m.fg} on ${m.bg}${m.over ? ` over ${m.over}` : ""}${modeText(m.mode)}`;

// ---------------------------------------------------------------------------------------------
// Commands

async function build(args: ParsedArgs, io: Io): Promise<Outcome> {
  const loaded = loadTheme(themeFlag(args), io);
  const result = await buildTheme(loaded.theme, { source: loaded.source });
  const check = args.flags.has("--check");
  const outFlag = flag(args, "--out");
  const outDir = outFlag ? resolvePath(io.cwd, outFlag) : loaded.builtIn ? join(packageRoot(), "generated", result.set.name) : resolvePath(io.cwd, "tokens", result.set.name);
  const shown = display(io, outDir);
  const common = { theme: result.set.name, outDir: shown, tokens: tokenCounts(result.set), contrast: contrastSummary(result, false), diagnostics: result.diagnostics };

  if (!result.files) {
    return {
      exitCode: EXIT.invalid,
      data: { ...common, files: [] },
      text: [...diagnosticsText(result.diagnostics), `build failed: nothing was written to ${shown}`].join("\n"),
    };
  }

  const files: { name: string; bytes: number; status: "written" | "unchanged" | "stale" | "missing" }[] = [];
  for (const name of OUTPUT_FILES) {
    const content = result.files.get(name)!;
    const target = join(outDir, name);
    const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const same = current === content;
    if (check) {
      files.push({ name, bytes: Buffer.byteLength(content), status: same ? "unchanged" : current === undefined ? "missing" : "stale" });
    } else {
      if (!same) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(target, content);
      }
      files.push({ name, bytes: Buffer.byteLength(content), status: same ? "unchanged" : "written" });
    }
  }
  const drifted = files.filter((file) => file.status === "stale" || file.status === "missing");
  const exitCode = drifted.length > 0 ? EXIT.drift : EXIT.ok;
  const text = [
    ...diagnosticsText(result.diagnostics),
    ...files.map((file) => `  ${file.status.padEnd(9)} ${join(shown, file.name)} (${file.bytes} bytes)`),
    drifted.length > 0
      ? `drift: ${drifted.length} file${drifted.length === 1 ? " is" : "s are"} out of date. Run \`by-tokens build${args.flags.has("--theme") ? ` --theme ${themeFlag(args)}` : ""}${outFlag ? ` --out ${outFlag}` : ""}\` and commit the result.`
      : `${check ? "up to date" : "built"}: theme "${result.set.name}", ${result.set.tokens.size} tokens, ${result.contrast.length} contrast checks passed (WCAG 2.2 ${result.set.contrast.level})`,
  ].join("\n");
  return {
    exitCode,
    data: {
      ...common,
      files,
      ...(drifted.length > 0 ? { fix: { summary: "Run `by-tokens build` with the same theme and output directory, then commit the changed files." } } : {}),
    },
    text,
  };
}

async function validateCommand(args: ParsedArgs, io: Io): Promise<Outcome> {
  const loaded = loadTheme(themeFlag(args), io);
  const result = await buildTheme(loaded.theme, { source: loaded.source, render: false });
  const all = args.flags.has("--contrast");
  const summary = contrastSummary(result, all);
  const text = [
    ...diagnosticsText(result.diagnostics),
    `${all ? "contrast" : "lowest contrast"} (${summary.checked} checks, WCAG 2.2 ${summary.level}: text ${summary.targets.text}:1, UI ${summary.targets.ui}:1):`,
    ...summary.lowest.map(measurementText),
    result.ok ? `valid: theme "${result.set.name}", ${result.set.tokens.size} tokens` : `invalid: theme "${result.set.name}"`,
  ].join("\n");
  return {
    exitCode: result.ok ? EXIT.ok : EXIT.invalid,
    data: { theme: result.set.name, tokens: tokenCounts(result.set), contrast: summary, diagnostics: result.diagnostics },
    text,
  };
}

/** Finds a token by dot path, `--by-` variable or Tailwind variable. */
function findToken(set: TokenSet, name: string): Token {
  const direct = set.tokens.get(name);
  if (direct) return direct;
  const variable = name.replace(/^var\((.*)\)$/, "$1");
  for (const token of set.tokens.values()) {
    if (cssVarName(token.path) === variable || token.tailwind === variable) return token;
  }
  const near = closest(name, set.tokens.keys(), 5);
  throw new UsageError("unknown-token", `no token named "${name}"`, near.length > 0 ? `Did you mean ${near.join(", ")}?` : "Run `by-tokens search <words>` to find it.");
}

/** A token's resolved value as CSS text in one context, or a note when it does not resolve. */
function resolvedCss(set: TokenSet, token: Token, context: ModeContext): { css: string; hex?: string; chain: readonly string[] } {
  const resolution = resolve(set, token.path, context);
  if (!resolution.ok) return { css: `unresolved (${resolution.reason} at ${resolution.at})`, chain: resolution.chain };
  const hex = token.type === "color" ? (resolution.value as { hex: string }).hex : undefined;
  return { css: cssValue(token.type, resolution.value), ...(hex ? { hex } : {}), chain: resolution.chain };
}

async function explain(args: ParsedArgs, io: Io): Promise<Outcome> {
  const name = args.positionals[0];
  if (!name || args.positionals.length > 1) throw new UsageError("usage", "explain takes exactly one token", "Usage: by-tokens explain <token>, for example `by-tokens explain color.bg.surface`.");
  const loaded = loadTheme(themeFlag(args), io);
  const generated = generateTokens(loaded.theme);
  const { set } = generated;
  const token = findToken(set, name);
  const checked = validate(set);

  const values = contextsFor(set, [token.path]).map((mode) => {
    const own = ownValues(token).find((entry) => entry.mode === undefined || entry.mode === mode[token.axis ?? ""])?.value;
    const resolved = resolvedCss(set, token, mode);
    return {
      mode,
      value: typeof own === "string" ? own : own === undefined ? null : cssValue(token.type, own),
      resolved: resolved.css,
      ...(resolved.hex ? { hex: resolved.hex } : {}),
      chain: resolved.chain,
    };
  });
  const users = referencedBy(set, token.path);
  const contrast = checked.contrast.filter((m) => m.fg === token.path || m.bg === token.path || m.over === token.path);
  const shadcn = Object.entries(set.shadcn).filter(([, path]) => path === token.path).map(([variable]) => variable);
  const diagnostics = [...generated.diagnostics, ...checked.diagnostics].filter((d) => d.token === token.path || d.related === token.path);

  const text = [
    `${token.path}  (${token.tier} ${token.type}${token.overridden ? ", overridden by the theme" : ""})`,
    `  ${token.description}`,
    `  css: var(${cssVarName(token.path)})${token.tailwind ? `   tailwind: ${token.tailwind}` : ""}${shadcn.length > 0 ? `   shadcn: ${shadcn.join(", ")}` : ""}`,
    "values:",
    ...values.map((v) => `  ${modeText(v.mode).trim() || "(all modes)"}: ${v.chain.length > 1 ? `${v.chain.join(" -> ")} = ` : ""}${v.resolved}${v.hex ? ` ${v.hex}` : ""}`),
    ...(users.length > 0 ? [`referenced by (${users.length}): ${users.join(", ")}`] : token.tier === "primitive" ? ["referenced by: nothing"] : []),
    ...(contrast.length > 0 ? ["contrast:", ...contrast.map(measurementText)] : []),
    ...diagnosticsText(diagnostics),
  ].join("\n");
  return {
    exitCode: EXIT.ok,
    data: {
      theme: set.name,
      token: {
        path: token.path,
        cssVar: cssVarName(token.path),
        ...(token.tailwind ? { tailwind: token.tailwind } : {}),
        shadcn,
        type: token.type,
        tier: token.tier,
        description: token.description,
        overridden: token.overridden === true,
        ...(token.ramp ? { ramp: token.ramp } : {}),
      },
      values,
      referencedBy: users,
      contrast,
      diagnostics,
    },
    text,
  };
}

async function search(args: ParsedArgs, io: Io): Promise<Outcome> {
  const words = args.positionals.flatMap((word) => word.toLowerCase().split(/\s+/)).filter(Boolean);
  const tier = flag(args, "--tier");
  const type = flag(args, "--type");
  if (words.length === 0 && !tier && !type) throw new UsageError("usage", "search needs at least one word, --tier or --type", "Usage: by-tokens search <words...>, for example `by-tokens search hover background`.");
  if (tier && !(TIERS as readonly string[]).includes(tier)) throw new UsageError("usage", `unknown tier "${tier}"`, `Tiers: ${TIERS.join(", ")}.`);
  if (type && !(TOKEN_TYPES as readonly string[]).includes(type)) throw new UsageError("usage", `unknown type "${type}"`, `Types: ${TOKEN_TYPES.join(", ")}.`);
  const limitText = flag(args, "--limit") ?? "20";
  const limit = Number(limitText);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("usage", `--limit must be a positive integer, got "${limitText}"`, "For example --limit 50.");

  const { set } = generateTokens(loadTheme(themeFlag(args), io).theme);
  const scored: { token: Token; score: number }[] = [];
  for (const token of set.tokens.values()) {
    if ((tier && token.tier !== tier) || (type && token.type !== type)) continue;
    const path = token.path.toLowerCase();
    const names = `${cssVarName(token.path)} ${token.tailwind ?? ""}`.toLowerCase();
    const description = token.description.toLowerCase();
    let score = token.tier === "primitive" ? 0 : 0.5; // roles first: they are what components use
    let matched = true;
    for (const word of words) {
      if (path.includes(word)) score += 3;
      else if (names.includes(word)) score += 2;
      else if (description.includes(word)) score += 1;
      else matched = false;
    }
    if (matched) scored.push({ token, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, limit).map(({ token }) => ({
    path: token.path,
    cssVar: cssVarName(token.path),
    ...(token.tailwind ? { tailwind: token.tailwind } : {}),
    type: token.type,
    tier: token.tier,
    description: token.description,
  }));
  const text =
    results.length === 0
      ? `no token matches ${words.join(" ")}`
      : [...results.map((r) => `${r.path}  (${r.tier} ${r.type})\n  ${r.description}`), `${results.length} of ${scored.length} match${scored.length === 1 ? "" : "es"}`].join("\n");
  return { exitCode: EXIT.ok, data: { theme: set.name, query: words.join(" "), total: scored.length, results }, text };
}

/** Every token's resolved CSS value per mode combination it depends on. */
function resolvedTable(set: TokenSet): Map<string, { token: Token; values: { mode: ModeContext; css: string }[] }> {
  const table = new Map<string, { token: Token; values: { mode: ModeContext; css: string }[] }>();
  for (const token of set.tokens.values()) {
    table.set(token.path, { token, values: contextsFor(set, [token.path]).map((mode) => ({ mode, css: resolvedCss(set, token, mode).css })) });
  }
  return table;
}

async function diff(args: ParsedArgs, io: Io): Promise<Outcome> {
  const [fromSpec, toSpec, ...extra] = args.positionals;
  if (!fromSpec || !toSpec || extra.length > 0) throw new UsageError("usage", "diff takes exactly two themes", "Usage: by-tokens diff <theme-a> <theme-b>, each a preset name or a theme file.");
  const sides = [fromSpec, toSpec].map((spec) => generateTokens(loadTheme(spec, io).theme));
  const diagnostics = sides.flatMap((side) => side.diagnostics);
  const [from, to] = sides as [(typeof sides)[number], (typeof sides)[number]];
  if (hasErrors(diagnostics)) {
    return { exitCode: EXIT.invalid, data: { from: from.set.name, to: to.set.name, diagnostics }, text: [...diagnosticsText(diagnostics), "diff failed: fix the theme files first"].join("\n") };
  }
  const before = resolvedTable(from.set);
  const after = resolvedTable(to.set);
  const added = [...after.keys()].filter((path) => !before.has(path));
  const removed = [...before.keys()].filter((path) => !after.has(path));
  const changed: { path: string; type: string; tier: string; modes: { mode: ModeContext; from: string | null; to: string | null }[] }[] = [];
  for (const [path, a] of before) {
    const b = after.get(path);
    if (!b) continue;
    const key = (mode: ModeContext) => JSON.stringify(mode);
    // A token may depend on different axes in the two themes; compare over the finer set of modes.
    const axes = new Set([...dependentAxes(from.set, path), ...dependentAxes(to.set, path)]);
    const contexts = to.set.axes.filter((axis) => axes.has(axis.name)).reduce<Record<string, string>[]>((all, axis) => all.flatMap((c) => axis.modes.map((mode) => ({ ...c, [axis.name]: mode }))), [{}]);
    const lookup = (side: typeof a, set: TokenSet, mode: ModeContext) => side.values.find((v) => key(v.mode) === key(mode))?.css ?? resolvedCss(set, side.token, { ...Object.fromEntries(set.axes.map((axis) => [axis.name, axis.default])), ...mode }).css;
    const modes = contexts
      .map((mode) => ({ mode, from: lookup(a, from.set, mode), to: lookup(b, to.set, mode) }))
      .filter((entry) => entry.from !== entry.to);
    if (modes.length > 0) changed.push({ path, type: b.token.type, tier: b.token.tier, modes });
  }
  const unchanged = [...before.keys()].filter((path) => after.has(path)).length - changed.length;
  const differs = added.length + removed.length + changed.length > 0;
  const text = [
    ...added.map((path) => `+ ${path}`),
    ...removed.map((path) => `- ${path}`),
    ...changed.flatMap((c) => c.modes.map((m) => `~ ${c.path}${modeText(m.mode)}: ${m.from} -> ${m.to}`)),
    `${from.set.name} -> ${to.set.name}: ${changed.length} changed, ${added.length} added, ${removed.length} removed, ${unchanged} unchanged`,
  ].join("\n");
  return {
    exitCode: differs && args.flags.has("--exit-code") ? EXIT.drift : EXIT.ok,
    data: { from: from.set.name, to: to.set.name, differs, added, removed, changed, unchanged, diagnostics },
    text,
  };
}

/** Sets `seeds.a.b` or `overrides.<token path>` in a theme object. */
function applySet(theme: Record<string, unknown>, assignment: string): void {
  const equals = assignment.indexOf("=");
  const hint = "Write --set <path>=<value>, for example --set seeds.colors.brand.hue=150 or --set overrides.color.fg.link={color.brand.12}.";
  if (equals < 1) throw new UsageError("usage", `--set "${assignment}" has no "="`, hint);
  const path = assignment.slice(0, equals);
  const rawValue = assignment.slice(equals + 1);
  let value: unknown = rawValue;
  try {
    value = JSON.parse(rawValue);
  } catch {
    // Not JSON: keep it as a string (aliases, colours and dimensions are written bare).
  }
  if (path === "name" || path === "description") {
    theme[path] = value;
    return;
  }
  if (path.startsWith("overrides.") && path.length > "overrides.".length) {
    const overrides = isPlainObject(theme["overrides"]) ? { ...theme["overrides"] } : {};
    overrides[path.slice("overrides.".length)] = value;
    theme["overrides"] = overrides;
    return;
  }
  if (!path.startsWith("seeds.") || path.length <= "seeds.".length) throw new UsageError("usage", `--set path "${path}" must start with seeds. or overrides.`, hint);
  const segments = path.split(".");
  let node = theme;
  for (const segment of segments.slice(0, -1)) {
    const next = isPlainObject(node[segment]) ? { ...(node[segment] as Record<string, unknown>) } : {};
    node[segment] = next;
    node = next;
  }
  node[segments[segments.length - 1]!] = value;
}

async function preset(args: ParsedArgs, io: Io): Promise<Outcome> {
  const [action, name, ...extra] = args.positionals;
  const usage = "Usage: by-tokens preset list | show <name> | create <name> [--from <preset>] [--set <path>=<value>]... [--out <file>]";
  if (action === "list" && name === undefined) {
    const presets = presetNames().map((presetName) => {
      const theme = loadTheme(presetName, io).theme;
      return { name: presetName, description: isPlainObject(theme) && typeof theme["description"] === "string" ? theme["description"] : "", file: display(io, join(presetDir(), `${presetName}${PRESET_SUFFIX}`)) };
    });
    return { exitCode: EXIT.ok, data: { presets }, text: presets.map((p) => `${p.name}  ${p.description}\n  ${p.file}`).join("\n") };
  }
  if (action === "show" && name !== undefined && extra.length === 0) {
    const loaded = loadTheme(name, io);
    return { exitCode: EXIT.ok, data: { name, file: display(io, loaded.file), preset: loaded.theme }, text: stableJson(loaded.theme).trimEnd() };
  }
  if (action === "create" && name !== undefined && extra.length === 0) {
    const base = loadTheme(flag(args, "--from") ?? "default", io);
    const theme: Record<string, unknown> = isPlainObject(base.theme) ? structuredClone(base.theme) : {};
    delete theme["$schema"];
    theme["name"] = name;
    theme["description"] = `Based on the ${isPlainObject(base.theme) ? String(base.theme["name"]) : "default"} preset.`;
    for (const assignment of args.flags.get("--set") ?? []) applySet(theme, assignment);
    const target = resolvePath(io.cwd, flag(args, "--out") ?? `${name}${PRESET_SUFFIX}`);
    const shown = display(io, target);
    const result = await buildTheme(theme, { render: false });
    if (!result.ok) {
      return {
        exitCode: EXIT.invalid,
        data: { name, file: shown, written: false, preset: theme, diagnostics: result.diagnostics },
        text: [...diagnosticsText(result.diagnostics), `not created: the theme breaks a rule, ${shown} was not written`].join("\n"),
      };
    }
    if (existsSync(target)) throw new UsageError("file-exists", `${shown} already exists`, "Choose another --out, or delete the file first.");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, stableJson(theme));
    return {
      exitCode: EXIT.ok,
      data: { name, file: shown, written: true, preset: theme, diagnostics: result.diagnostics },
      text: [...diagnosticsText(result.diagnostics), `created ${shown}. Build it with \`by-tokens build --theme ${shown}\`.`].join("\n"),
    };
  }
  throw new UsageError("usage", "preset needs an action: list, show <name> or create <name>", usage);
}

async function exportCommand(args: ParsedArgs, io: Io): Promise<Outcome> {
  const format = args.positionals[0];
  const formats = [...Object.keys(OUTPUT_ALIASES), "theme"];
  if (!format || args.positionals.length > 1 || !formats.includes(format)) {
    throw new UsageError("usage", format ? `unknown export format "${format}"` : "export needs a format", `Formats: ${formats.join(", ")}. Usage: by-tokens export <format> [--theme <name|file>] [--out <file>]`);
  }
  const loaded = loadTheme(themeFlag(args), io);
  const result: BuildResult = await buildTheme(loaded.theme, { source: loaded.source, render: format !== "theme" });
  if (!result.ok) {
    return { exitCode: EXIT.invalid, data: { theme: result.set.name, format, diagnostics: result.diagnostics }, text: [...diagnosticsText(result.diagnostics), "export failed: the theme breaks a rule"].join("\n") };
  }
  let file: string;
  let content: string;
  if (format === "theme") {
    file = `${result.set.name}${PRESET_SUFFIX}`;
    content = stableJson({
      schemaVersion: SCHEMA_VERSION,
      name: result.set.name,
      ...(result.set.description ? { description: result.set.description } : {}),
      seeds: result.seeds,
      overrides: isPlainObject(loaded.theme) && isPlainObject(loaded.theme["overrides"]) ? loaded.theme["overrides"] : {},
    });
  } else {
    file = OUTPUT_ALIASES[format]!;
    content = result.files!.get(OUTPUT_ALIASES[format]!)!;
  }
  const outFlag = flag(args, "--out");
  if (outFlag) {
    const target = resolvePath(io.cwd, outFlag);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { exitCode: EXIT.ok, data: { theme: result.set.name, format, file, written: display(io, target), bytes: Buffer.byteLength(content), diagnostics: result.diagnostics }, text: `wrote ${display(io, target)} (${Buffer.byteLength(content)} bytes)` };
  }
  return { exitCode: EXIT.ok, data: { theme: result.set.name, format, file, content, diagnostics: result.diagnostics }, text: "", raw: content };
}

function help(args: ParsedArgs): Outcome {
  const topic = args.positionals[0];
  const commands = topic ? COMMANDS.filter((command) => command.name === topic) : COMMANDS;
  if (commands.length === 0) throw new UsageError("unknown-command", `unknown command "${topic}"`, `Commands: ${COMMANDS.map((command) => command.name).join(", ")}.`);
  const text = [
    "by-tokens: Byterygon design tokens (seeds plus overrides -> DTCG tokens -> CSS, Tailwind, shadcn, TypeScript, Figma).",
    "",
    ...commands.flatMap((command) => [command.usage, `  ${command.summary}`, ...command.options.map((option) => `    ${`${option.name}${option.value ? ` ${option.value}` : ""}`.padEnd(34)} ${option.summary}`), ""]),
    "Every command takes --json and then prints one JSON document to stdout:",
    '  { "schemaVersion": 1, "command", "ok", "exitCode", ...data, "diagnostics": [...] }',
    "A diagnostic names the rule, the token, the mode, the measured and the required value, and a fix.",
    "",
    "Exit codes:",
    ...EXIT_CODES.map((entry) => `  ${String(entry.code).padEnd(3)} ${entry.meaning}`),
  ].join("\n");
  return { exitCode: EXIT.ok, data: { commands, exitCodes: EXIT_CODES }, text };
}

function version(): Outcome {
  const manifest = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as { name: string; version: string };
  return { exitCode: EXIT.ok, data: { name: manifest.name, version: manifest.version }, text: `${manifest.name} ${manifest.version}` };
}

const HANDLERS: Readonly<Record<string, (args: ParsedArgs, io: Io) => Promise<Outcome> | Outcome>> = {
  build,
  validate: validateCommand,
  explain,
  search,
  diff,
  preset,
  export: exportCommand,
  help,
  version,
};

/** Runs one command and returns its exit code. Never throws and never calls `process.exit`. */
export async function run(argv: readonly string[], io: Io): Promise<number> {
  const json = argv.includes("--json");
  let command = argv.find((arg) => !arg.startsWith("-")) ?? "help";
  const finish = (exitCode: number, data: Record<string, unknown>, text: string, raw?: string): number => {
    if (json) {
      io.stdout(stableJson({ schemaVersion: SCHEMA_VERSION, command, ok: exitCode === EXIT.ok, exitCode, ...data }));
    } else if (raw !== undefined) {
      io.stdout(raw);
    } else if (exitCode === EXIT.ok) {
      io.stdout(`${text}\n`);
    } else {
      io.stderr(`${text}\n`);
    }
    return exitCode;
  };
  try {
    const args = parseArgs(argv);
    command = args.command;
    const outcome = await HANDLERS[args.command]!(args, io);
    return finish(outcome.exitCode, outcome.data, outcome.text, outcome.raw);
  } catch (cause) {
    if (cause instanceof UsageError) {
      return finish(EXIT.usage, { error: { code: cause.code, message: cause.message, ...(cause.fix ? { fix: cause.fix } : {}) } }, `error: ${cause.message}${cause.fix ? `\n  fix: ${cause.fix}` : ""}`);
    }
    const message = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    return finish(EXIT.internal, { error: { code: "internal", message, fix: "This is a bug in by-tokens; report it with the command line and the theme file." } }, `internal error: ${message}`);
  }
}
