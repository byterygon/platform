// Small CSS readers for files this repo generates or builds. Not a general CSS parser: no
// strings containing braces, which neither by-tokens nor Tailwind emits.

export interface Rule {
  /** The selector or at-rule prelude, whitespace collapsed (`:root, [data-theme="light"], .light`). */
  readonly prelude: string;
  readonly declarations: readonly (readonly [string, string])[];
  readonly children: readonly Rule[];
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** Parses CSS into nested rules (at-rules hold their nested rules in `children`). */
export function parseCss(css: string): Rule[] {
  const text = stripComments(css);
  let at = 0;
  const block = (): { declarations: [string, string][]; children: Rule[] } => {
    const declarations: [string, string][] = [];
    const children: Rule[] = [];
    let start = at;
    while (at < text.length) {
      const ch = text[at];
      if (ch === "{") {
        const prelude = squash(text.slice(start, at));
        at += 1;
        const inner = block();
        children.push({ prelude, ...inner });
        start = at;
      } else if (ch === "}") {
        pushDeclaration(declarations, children, text.slice(start, at));
        at += 1;
        return { declarations, children };
      } else if (ch === ";") {
        pushDeclaration(declarations, children, text.slice(start, at));
        at += 1;
        start = at;
      } else {
        at += 1;
      }
    }
    pushDeclaration(declarations, children, text.slice(start, at));
    return { declarations, children };
  };
  return block().children;
}

function pushDeclaration(declarations: [string, string][], children: Rule[], raw: string): void {
  const text = raw.trim();
  if (!text) return;
  if (text.startsWith("@")) {
    // A statement at-rule (`@custom-variant dark (...)`, `@import "x"`): keep it as a rule.
    children.push({ prelude: squash(text), declarations: [], children: [] });
    return;
  }
  const colon = text.indexOf(":");
  if (colon <= 0) return;
  declarations.push([text.slice(0, colon).trim(), squash(text.slice(colon + 1))]);
}

/** Every rule, depth first, with the preludes of the at-rules around it. */
export function* walk(rules: readonly Rule[], parents: readonly string[] = []): Generator<{ rule: Rule; parents: readonly string[] }> {
  for (const rule of rules) {
    yield { rule, parents };
    yield* walk(rule.children, [...parents, rule.prelude]);
  }
}

/** The selectors of a rule's prelude (split on top-level commas). */
export function selectors(prelude: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of prelude) {
    if (ch === "(" || ch === "[") depth += 1;
    if (ch === ")" || ch === "]") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/**
 * Resolves `var()` references in `value` against `vars`, recursively. Returns the final value and
 * the chain of custom properties it went through.
 */
export function resolveVars(value: string, vars: ReadonlyMap<string, string>): { value: string; chain: string[] } {
  const chain: string[] = [];
  let current = value;
  for (let i = 0; i < 32; i += 1) {
    const match = /var\((--[a-zA-Z0-9-]+)(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/.exec(current);
    if (!match) break;
    const name = match[1]!;
    chain.push(name);
    const replacement = vars.get(name) ?? match[2] ?? "";
    current = current.slice(0, match.index) + replacement + current.slice(match.index + match[0].length);
  }
  return { value: squash(current), chain };
}
