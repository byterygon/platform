// The checks every component must pass (spec sections 6 and 9a), as functions so that the
// conventions test runs them on src/components and the scaffold test on a freshly generated one.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { compile } from "tailwindcss";
import { tokens } from "@byterygon/design-tokens/default/tokens";
import { parseCss, walk } from "../scripts/lib/css.ts";
import type { Manifest } from "../scripts/lib/manifest.ts";

const require = createRequire(import.meta.url);
export const tailwindThemeCss = readFileSync(require.resolve("@byterygon/design-tokens/default/tailwind-theme.css"), "utf8");

// Utilities are compiled against the token theme only, without Tailwind's default theme: a raw
// palette class (`bg-blue-500`) or a default scale (`font-medium`) produces nothing and fails.
const INPUT = `${tailwindThemeCss}\n@tailwind utilities;\n`;
let baseline: string | undefined;

/** The CSS Tailwind generates for one class, or "" when the class is not a utility here. */
export async function compileClass(name: string): Promise<string> {
  const compiler = await compile(INPUT);
  baseline ??= (await compile(INPUT)).build([]);
  const css = compiler.build([name]);
  return css === baseline ? "" : css.slice(commonPrefix(css, baseline));
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return i;
};

const byCssVar = new Map<string, { path: string; type: string; tier: string }>(
  Object.entries(tokens).map(([path, token]) => [token.cssVar, { path, type: token.type, tier: token.tier }]),
);

/** Tokens a component may not reference: colour primitives and the raw space scale (use roles). */
const forbiddenPrimitive = (path: string, type: string, tier: string) => tier === "primitive" && (type === "color" || /^space\.\d/.test(path));

/** Splits `a:b:[&_x]:c-[d]` into variants and the utility, ignoring colons inside brackets. */
export function splitClass(name: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of name) {
    if (ch === "[" || ch === "(") depth += 1;
    if (ch === "]" || ch === ")") depth -= 1;
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  return { variants: parts, utility: current };
}

const RAW_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\(/i;
const ARBITRARY_TOKEN = /^(?:[a-z-]+:)?var\(--by-[a-z0-9-]+\)$/;
// shadcn/ui's `accent` colour is a hover background; Byterygon's accent solid is `accent-solid`.
const BARE_ACCENT = /^(?:bg|text|border|ring|outline|fill|stroke|decoration|divide|caret|shadow|from|via|to)-accent(?:\/\d+)?$/;

export interface ClassReport {
  errors: string[];
  /** Token paths the classes resolve to, sorted. */
  tokens: string[];
}

/** Checks that every class is a token-only Tailwind utility and collects the tokens it uses. */
export async function checkClasses(classes: Iterable<string>): Promise<ClassReport> {
  const errors: string[] = [];
  const used = new Set<string>();
  for (const name of [...new Set(classes)].sort()) {
    const { utility } = splitClass(name);
    if (BARE_ACCENT.test(utility)) {
      errors.push(`${name}: shadcn/ui's "accent" is a hover colour; use the accent-solid names (bg-accent-solid, text-accent-solid-fg) for the accent solid`);
      continue;
    }
    const bracket = utility.indexOf("[");
    if (bracket >= 0) {
      const inner = utility.slice(bracket + 1, utility.lastIndexOf("]"));
      if (!ARBITRARY_TOKEN.test(inner)) {
        errors.push(`${name}: an arbitrary value must be a token variable, var(--by-...); use a role utility or a token instead of "${inner}"`);
        continue;
      }
    }
    const css = await compileClass(name);
    if (!css) {
      errors.push(`${name}: not a utility under the token theme (raw palette and default-theme classes are not available; see tailwind-theme.css for the role names)`);
      continue;
    }
    for (const { rule, parents } of walk(parseCss(css))) {
      if (parents.some((p) => p.startsWith("@property") || p.startsWith("@layer properties")) || rule.prelude.startsWith("@property")) continue;
      for (const [property, value] of rule.declarations) {
        if (RAW_COLOR.test(value) && !/#0000\b/.test(value)) errors.push(`${name}: ${property} has a raw colour (${value})`);
        for (const match of value.matchAll(/var\((--by-[a-z0-9-]+)/g)) {
          const token = byCssVar.get(match[1]!);
          if (!token) {
            errors.push(`${name}: ${match[1]} is not a token of the default theme`);
            continue;
          }
          if (forbiddenPrimitive(token.path, token.type, token.tier)) {
            errors.push(`${name}: resolves to the primitive ${token.path}; use a role (bg-surface, p-inset-md, gap-inline-sm) instead`);
          }
          used.add(token.path);
        }
      }
    }
  }
  return { errors, tokens: [...used].sort() };
}

/** All combinations of the variant values: [{ variant: "primary", size: "sm" }, ...]. */
export function variantCombinations(variants: Manifest["variants"]): Record<string, string>[] {
  let combos: Record<string, string>[] = [{}];
  for (const [prop, values] of Object.entries(variants)) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [prop]: value })));
  }
  return combos;
}

/** The variants in a class list that style a state (`hover`, `data-disabled`, `aria-invalid`). */
export function stateVariants(classes: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const name of classes) for (const variant of splitClass(name).variants) out.add(variant);
  return out;
}

/** Imports a component file may use: React, Base UI, the manifest's dependencies, and `@/` code. */
export function checkImports(source: string, manifest: Manifest): string[] {
  const errors: string[] = [];
  for (const match of source.matchAll(/^\s*import\s[^"']*["']([^"']+)["']/gm)) {
    const specifier = match[1]!;
    const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
    if (specifier.startsWith("@/")) continue;
    if (pkg === "react" || pkg === "react-dom") continue;
    if (!manifest.dependencies.includes(pkg)) errors.push(`imports ${specifier}, but ${pkg} is not in the manifest's dependencies`);
    if (pkg === "@base-ui/react" && manifest.base && specifier !== manifest.base && !manifest.dependencies.includes(pkg)) {
      errors.push(`imports ${specifier}; manifest.base is ${manifest.base}`);
    }
  }
  if (/\bfetch\(|XMLHttpRequest|WebSocket|https?:\/\//.test(source)) errors.push("touches the network or names a URL; components must work offline");
  return errors;
}
