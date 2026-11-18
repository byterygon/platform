/**
 * The shadcn `registry:theme` item of a theme, built from its three CSS outputs. One source for
 * `renderOutputs` (`registry-theme.json`, `by-tokens export registry`, the Theme Studio export) and
 * for `@byterygon/ui`'s registry (`registry/theme-<preset>.json`), so the item a project installs
 * from the registry and the one the Studio exports are the same bytes.
 *
 * `css` carries the variables (tokens.css and the shadcn alias layer, every block with its
 * selectors) and the dark variant; `cssVars.theme` the Tailwind `@theme inline` names: Byterygon's
 * roles plus shadcn's own colour names, so stock shadcn components and Byterygon components both
 * work in the project that installs it. shadcn's meaning wins where the two collide
 * (`--color-accent` is shadcn's hover colour), which is why Byterygon components use the
 * accent-solid names. Variables go in `css`, not `cssVars.light/dark`, which would add a stray
 * `--color-by-*` Tailwind entry per variable and cannot express density.
 *
 * Self-contained (no imports, a test enforces it) so `@byterygon/ui`'s scripts can import it as
 * TypeScript source without a build.
 */

export const REGISTRY_ITEM_SCHEMA = "https://ui.shadcn.com/schema/registry-item.json";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface CssRule {
  /** The selector or at-rule prelude, whitespace collapsed (`:root, [data-theme="light"], .light`). */
  readonly prelude: string;
  readonly declarations: readonly (readonly [string, string])[];
  readonly children: readonly CssRule[];
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Parses the CSS by-tokens and Tailwind emit into nested rules (at-rules hold their nested rules
 * in `children`). Not a general CSS parser: no strings containing braces or semicolons.
 */
export function parseCss(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let at = 0;
  const push = (declarations: [string, string][], children: CssRule[], raw: string) => {
    const part = raw.trim();
    if (!part) return;
    if (part.startsWith("@")) {
      // A statement at-rule (`@custom-variant dark (...)`): keep it as a rule.
      children.push({ prelude: squash(part), declarations: [], children: [] });
      return;
    }
    const colon = part.indexOf(":");
    if (colon <= 0) return;
    declarations.push([part.slice(0, colon).trim(), squash(part.slice(colon + 1))]);
  };
  const block = (): { declarations: [string, string][]; children: CssRule[] } => {
    const declarations: [string, string][] = [];
    const children: CssRule[] = [];
    let start = at;
    while (at < text.length) {
      const ch = text[at];
      if (ch === "{") {
        const prelude = squash(text.slice(start, at));
        at += 1;
        children.push({ prelude, ...block() });
        start = at;
      } else if (ch === "}") {
        push(declarations, children, text.slice(start, at));
        at += 1;
        return { declarations, children };
      } else if (ch === ";") {
        push(declarations, children, text.slice(start, at));
        at += 1;
        start = at;
      } else {
        at += 1;
      }
    }
    push(declarations, children, text.slice(start, at));
    return { declarations, children };
  };
  return block().children;
}

/** The selectors of a rule's prelude (split on top-level commas). */
export function cssSelectors(prelude: string): string[] {
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

export interface RegistryThemeInput {
  /** The theme name; the item is called `theme-<name>`. */
  readonly name: string;
  /** The theme file's description, if it has one. */
  readonly description?: string;
  readonly tokensCss: string;
  readonly tailwindCss: string;
  readonly shadcnCss: string;
}

/** The item as a JSON value. */
export function registryThemeItem(input: RegistryThemeInput): { [key: string]: Json } {
  const css: Record<string, Json> = {};
  const tailwind = parseCss(input.tailwindCss);
  for (const rule of tailwind) if (rule.prelude.startsWith("@custom-variant")) css[rule.prelude] = {};
  // The base layer (themed scrollbars) as nested rules, which the shadcn CLI writes as they are.
  const nested = (rule: CssRule): { [key: string]: Json } => {
    const out: { [key: string]: Json } = {};
    for (const [property, value] of rule.declarations) out[property] = value;
    for (const child of rule.children) out[child.prelude] = nested(child);
    return out;
  };
  for (const file of [input.tokensCss, input.shadcnCss]) {
    for (const rule of parseCss(file)) {
      const key = cssSelectors(rule.prelude).join(", ");
      const block = (css[key] ??= {}) as Record<string, Json>;
      for (const [property, value] of rule.declarations) block[property] = value;
    }
  }
  const theme: Record<string, string> = {};
  for (const rule of tailwind) {
    if (rule.prelude !== "@theme inline") continue;
    for (const [property, value] of rule.declarations) theme[property.slice(2)] = value;
  }
  for (const rule of tailwind) if (rule.prelude.startsWith("@layer")) css[rule.prelude] = nested(rule);
  for (const rule of parseCss(input.shadcnCss)) {
    for (const [property] of rule.declarations) {
      if (property === "--radius") continue;
      theme[`color-${property.slice(2)}`] = `var(${property})`;
    }
  }
  return {
    $schema: REGISTRY_ITEM_SCHEMA,
    name: `theme-${input.name}`,
    type: "registry:theme",
    title: `Byterygon theme: ${input.name}`,
    description: `${input.description ?? `The ${input.name} preset.`} Installs the --by-* token variables (Light/Dark via data-theme or .dark, Comfortable/Compact via data-density), the shadcn/ui variable aliases, the Tailwind names of the roles and thin themed scrollbars. Fonts are not included: copy @byterygon/design-tokens/fonts and import fonts.css for Inter and JetBrains Mono, or the system fallbacks are used.`,
    cssVars: { theme },
    css,
  };
}

/** The item file as the registry stores it: two-space JSON and a trailing newline. */
export function formatRegistryThemeItem(input: RegistryThemeInput): string {
  return `${JSON.stringify(registryThemeItem(input), null, 2)}\n`;
}
