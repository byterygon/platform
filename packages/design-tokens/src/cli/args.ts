/** Argument parsing and the command table (also what `by-tokens help --json` prints). */
import { closest } from "../util.js";

/** Stable exit codes. Scripts and agents may branch on them. */
export const EXIT = {
  /** Success. */
  ok: 0,
  /** The theme or the tokens broke a rule (see `diagnostics`). */
  invalid: 1,
  /** The command line was wrong, or a file could not be read. */
  usage: 2,
  /** `build --check` found stale outputs, or `diff --exit-code` found differences. */
  drift: 3,
  /** A bug in by-tokens. */
  internal: 70,
} as const;

export const EXIT_CODES = [
  { code: EXIT.ok, name: "ok", meaning: "success" },
  { code: EXIT.invalid, name: "invalid", meaning: "the theme or the tokens broke a rule; see diagnostics" },
  { code: EXIT.usage, name: "usage", meaning: "bad command line, unknown token or preset, unreadable or malformed file" },
  { code: EXIT.drift, name: "drift", meaning: "build --check found stale outputs, or diff --exit-code found differences" },
  { code: EXIT.internal, name: "internal", meaning: "a bug in by-tokens" },
] as const;

interface OptionSpec {
  readonly name: string;
  readonly value?: string;
  readonly repeat?: boolean;
  readonly summary: string;
}

const THEME: OptionSpec = { name: "--theme", value: "<name|file>", summary: "a built-in preset name or a theme file (default: default)" };
const JSON_FLAG: OptionSpec = { name: "--json", summary: "print one JSON document to stdout instead of text" };

export interface CommandSpec {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  readonly options: readonly OptionSpec[];
}

export const COMMANDS: readonly CommandSpec[] = [
  {
    name: "build",
    usage: "by-tokens build [--theme <name|file>] [--out <dir>] [--check]",
    summary: "Generate, validate and write tokens.css, tailwind-theme.css, shadcn-alias.css, tokens.ts, tokens.dtcg.json and figma-variables.json. Writes nothing when a rule fails.",
    options: [
      THEME,
      { name: "--out", value: "<dir>", summary: "output directory (default: generated/<theme> in the package for presets, ./tokens/<theme> for theme files)" },
      { name: "--check", summary: "write nothing; exit 3 when the files on disk differ from what would be generated" },
      JSON_FLAG,
    ],
  },
  {
    name: "validate",
    usage: "by-tokens validate [--theme <name|file>] [--contrast]",
    summary: "Run every rule (aliases, tiers, raw colours, contrast in every mode) without writing anything.",
    options: [THEME, { name: "--contrast", summary: "list every measured role pair, not only the lowest" }, JSON_FLAG],
  },
  {
    name: "explain",
    usage: "by-tokens explain <token> [--theme <name|file>]",
    summary: "Everything about one token: when to use it, its value in each mode, the alias chain, what references it, and its contrast pairs. Accepts a dot path, a --by- variable or a Tailwind variable.",
    options: [THEME, JSON_FLAG],
  },
  {
    name: "search",
    usage: "by-tokens search <words...> [--tier <tier>] [--type <type>] [--limit <n>]",
    summary: "Find tokens by words in their path, description, CSS variable or Tailwind name.",
    options: [
      THEME,
      { name: "--tier", value: "<primitive|semantic|component>", summary: "only this tier" },
      { name: "--type", value: "<type>", summary: "only this token type (color, dimension, shadow, ...)" },
      { name: "--limit", value: "<n>", summary: "at most n results (default 20)" },
      JSON_FLAG,
    ],
  },
  {
    name: "diff",
    usage: "by-tokens diff <theme-a> <theme-b> [--exit-code]",
    summary: "Compare the resolved tokens of two themes, mode by mode.",
    options: [{ name: "--exit-code", summary: "exit 3 when the themes differ" }, JSON_FLAG],
  },
  {
    name: "preset",
    usage: "by-tokens preset list | show <name> | create <name> [--from <preset>] [--set <path>=<value>]... [--out <file>]",
    summary: "List the built-in themes, print one, or start a new theme file from one.",
    options: [
      { name: "--from", value: "<preset>", summary: "the preset to start from (default: default)" },
      { name: "--set", value: "<path>=<value>", repeat: true, summary: "change a seed or an override, for example seeds.colors.brand.hue=150 or overrides.color.fg.link={color.brand.12}" },
      { name: "--out", value: "<file>", summary: "where to write the new theme (default: ./<name>.theme.json)" },
      JSON_FLAG,
    ],
  },
  {
    name: "export",
    usage: "by-tokens export <css|tailwind|shadcn|ts|dtcg|figma|theme> [--theme <name|file>] [--out <file>]",
    summary: "Print one output to stdout (or to a file). `theme` prints the theme with every seed spelled out.",
    options: [THEME, { name: "--out", value: "<file>", summary: "write to this file instead of stdout" }, JSON_FLAG],
  },
  {
    name: "help",
    usage: "by-tokens help [command]",
    summary: "Show the commands, their options and the exit codes.",
    options: [JSON_FLAG],
  },
];

/** A command-line mistake: exit 2, with a hint about what to type instead. */
export class UsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix?: string,
  ) {
    super(message);
  }
}

export interface ParsedArgs {
  readonly command: string;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly json: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const json = argv.includes("--json");
  const [first, ...rest] = argv.filter((arg) => arg !== "--json");
  if (first === undefined || first === "--help" || first === "-h") return { command: "help", positionals: [], flags: new Map(), json };
  if (first === "--version" || first === "-v") return { command: "version", positionals: [], flags: new Map(), json };

  const spec = COMMANDS.find((command) => command.name === first);
  if (!spec) {
    const near = closest(first, COMMANDS.map((command) => command.name));
    throw new UsageError("unknown-command", `unknown command "${first}"`, near.length > 0 ? `Did you mean \`by-tokens ${near[0]}\`? Run \`by-tokens help\` for the list.` : "Run `by-tokens help` for the list.");
  }

  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--help" || arg === "-h") return { command: "help", positionals: [spec.name], flags: new Map(), json };
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const option = spec.options.find((candidate) => candidate.name === name);
    if (!option && spec.name === "explain") {
      // `explain` takes CSS and Tailwind variable names, which start with two dashes.
      positionals.push(arg);
      continue;
    }
    if (!option) {
      const near = closest(name, spec.options.map((candidate) => candidate.name));
      throw new UsageError("unknown-option", `${spec.name} has no option ${name}`, near.length > 0 ? `Did you mean ${near[0]}? Usage: ${spec.usage}` : `Usage: ${spec.usage}`);
    }
    let value = "true";
    if (option.value) {
      const next = equals === -1 ? rest[++i] : arg.slice(equals + 1);
      if (next === undefined) throw new UsageError("missing-value", `${name} needs a value: ${name} ${option.value}`, `Usage: ${spec.usage}`);
      value = next;
    } else if (equals !== -1) {
      throw new UsageError("unexpected-value", `${name} takes no value`, `Usage: ${spec.usage}`);
    }
    const values = flags.get(name) ?? [];
    if (values.length > 0 && !option.repeat) throw new UsageError("repeated-option", `${name} was given more than once`, `Usage: ${spec.usage}`);
    flags.set(name, [...values, value]);
  }
  return { command: spec.name, positionals, flags, json };
}
