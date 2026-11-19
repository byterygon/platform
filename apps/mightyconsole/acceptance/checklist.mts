// The shape of an acceptance checklist (TSK-87): one file per build task in `checklists/`, each item
// of the spec's section 18 list with the checks that prove it. A tool task wires its own file; the
// harness (`acceptance.mts`) runs them and saves the evidence.
import type { Page } from "../ui/scripts/cdp.ts";

/** What a browser check gets: a fresh page on the running server, and a way to save evidence. */
export interface BrowserContext {
  page: Page;
  /** `https://localhost:<port>`, the server's public origin. */
  origin: string;
  /** `http://127.0.0.1:<port>`, the server's plain loopback codec listener (`--codec-listen`, TSK-103). */
  codecOrigin: string;
  /** Waits until `expression` holds in the page (with the `__mc` helpers of cdp.ts); throws after the timeout. */
  until: (expression: string, what: string, timeoutMs?: number) => Promise<void>;
  /** Evaluates `expression` with the helpers. */
  run: <T = unknown>(expression: string) => Promise<T>;
  /** Saves a screenshot of the page as evidence (`screenshots/<item>-<name>.png`). */
  shot: (name: string) => Promise<void>;
  /** Credentials and addresses of the lab (`lab/.generated/credentials.json`), when it is up. */
  lab: Record<string, unknown> | null;
}

export type Check =
  /** `cargo test -p mightyconsole-server -- <filter>`: passes when at least one test ran and none failed. */
  | { kind: "cargo"; filter: string; features?: string[]; label?: string }
  /** One UI test file, or the tests in it whose name contains `name`. */
  | { kind: "vitest"; file: string; name?: string; label?: string }
  /** Any program, from the repository root unless `cwd`; `{evidence}`, `{repo}`, `{server}` and `{ui}`
   * are replaced. Skipped (not failed) when one of `requires` is not on PATH. */
  | { kind: "command"; argv: string[]; label: string; cwd?: string; env?: Record<string, string>; requires?: string[] }
  /** Starts the server with `args` (and a fresh `--data`), waits for its startup lines, matches them. */
  | { kind: "server"; args: string[]; expect: RegExp[]; label: string }
  /** Drives the UI on the running server in a headless browser. */
  | { kind: "browser"; label: string; run: (ctx: BrowserContext) => Promise<void> }
  /** Something a person checks and links in the PR (a CI run, a manual flow). */
  | { kind: "manual"; label: string };

export interface Item {
  /** Short, unique in its checklist: `<checklist>/<id>` names it on the command line. */
  id: string;
  /** The spec's words. */
  text: string;
  /** Needs the test lab (the checklist's `lab` profiles) to be up. */
  lab?: boolean;
  /** Empty: not wired yet (the tool task wires it). */
  checks: Check[];
}

export interface Checklist {
  id: string;
  task: string;
  title: string;
  /** Repository path that exists once the task's code is in; until then the checklist is skipped. */
  builtWhen: string;
  /** Lab compose profiles its lab items need. */
  lab: string[];
  items: Item[];
}

export const cargo = (filter: string, options: { features?: string[]; label?: string } = {}): Check => ({ kind: "cargo", filter, ...options });
export const vitest = (file: string, name?: string): Check => ({ kind: "vitest", file, ...(name ? { name } : {}) });
export const command = (label: string, argv: string[], options: { cwd?: string; env?: Record<string, string>; requires?: string[] } = {}): Check => ({ kind: "command", label, argv, ...options });
export const server = (label: string, args: string[], expect: RegExp[]): Check => ({ kind: "server", label, args, expect });
export const browser = (label: string, run: (ctx: BrowserContext) => Promise<void>): Check => ({ kind: "browser", label, run });
export const manual = (label: string): Check => ({ kind: "manual", label });
