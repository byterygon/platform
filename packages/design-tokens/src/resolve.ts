/**
 * Alias resolution: what a token's value is in a given combination of modes, which chain of
 * aliases leads there, and which mode axes the value depends on.
 */
import { type Rgb, compositeOver, oklchToDisplayRgb } from "./color/index.js";
import {
  type Alias,
  type ColorValue,
  type ModeContext,
  type RawValue,
  type Token,
  type TokenSet,
  type TokenValue,
  aliasTarget,
  isAlias,
} from "./model.js";
import { isPlainObject } from "./util.js";
import { aliasesIn, colorToOklch } from "./values.js";

/** The default mode of every axis. */
export function defaultContext(set: TokenSet): ModeContext {
  return Object.fromEntries(set.axes.map((axis) => [axis.name, axis.default]));
}

/** Every combination of modes. */
export function allContexts(set: TokenSet): ModeContext[] {
  let contexts: Record<string, string>[] = [{}];
  for (const axis of set.axes) {
    contexts = contexts.flatMap((context) => axis.modes.map((mode) => ({ ...context, [axis.name]: mode })));
  }
  return contexts;
}

/** The token's own value in a context (an alias is returned as written). */
export function valueIn(token: Token, context: ModeContext): TokenValue | undefined {
  if (token.axis === undefined) return token.value;
  const mode = context[token.axis];
  return mode === undefined ? undefined : token.modes?.[mode];
}

/** Every value a token holds: one when unmoded, one per mode otherwise. */
export function ownValues(token: Token): { mode?: string; value: TokenValue }[] {
  if (token.axis === undefined || !token.modes) return token.value === undefined ? [] : [{ value: token.value }];
  return Object.entries(token.modes).map(([mode, value]) => ({ mode, value }));
}

export type Resolution =
  | { readonly ok: true; readonly value: RawValue; /** Token paths followed, starting with the token itself. */ readonly chain: readonly string[] }
  | { readonly ok: false; readonly reason: "missing" | "cycle" | "no-value"; readonly at: string; readonly chain: readonly string[] };

/** Follows aliases until a literal, in one context. Aliases inside a composite are resolved too. */
export function resolve(set: TokenSet, path: string, context: ModeContext): Resolution {
  const chain: string[] = [];
  let current = path;
  for (;;) {
    if (chain.includes(current)) return { ok: false, reason: "cycle", at: current, chain: [...chain, current] };
    chain.push(current);
    const token = set.tokens.get(current);
    if (!token) return { ok: false, reason: "missing", at: current, chain };
    const value = valueIn(token, context);
    if (value === undefined) return { ok: false, reason: "no-value", at: current, chain };
    if (isAlias(value)) {
      current = aliasTarget(value);
      continue;
    }
    if (!Array.isArray(value)) return { ok: true, value, chain };
    // Composite: resolve the aliases in its fields.
    const layers: unknown[] = [];
    for (const item of value as readonly unknown[]) {
      if (!isPlainObject(item)) {
        layers.push(item);
        continue;
      }
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(item)) {
        if (!isAlias(field)) {
          out[key] = field;
          continue;
        }
        const inner = resolve(set, aliasTarget(field), context);
        if (!inner.ok) return { ...inner, chain: [...chain, ...inner.chain] };
        out[key] = inner.value;
      }
      layers.push(out);
    }
    return { ok: true, value: layers as unknown as RawValue, chain };
  }
}

/** The axes a token's resolved value depends on, through any chain of aliases. */
export function dependentAxes(set: TokenSet, path: string, seen: Set<string> = new Set()): Set<string> {
  const axes = new Set<string>();
  if (seen.has(path)) return axes;
  seen.add(path);
  const token = set.tokens.get(path);
  if (!token) return axes;
  if (token.axis) axes.add(token.axis);
  for (const { value } of ownValues(token)) {
    for (const alias of aliasesIn(value)) {
      for (const axis of dependentAxes(set, aliasTarget(alias), seen)) axes.add(axis);
    }
  }
  return axes;
}

/** Paths of the tokens that reference `path` directly. */
export function referencedBy(set: TokenSet, path: string): string[] {
  const alias: Alias = `{${path}}`;
  const out: string[] = [];
  for (const token of set.tokens.values()) {
    if (ownValues(token).some(({ value }) => aliasesIn(value).includes(alias))) out.push(token.path);
  }
  return out;
}

/** The opaque sRGB colour of a resolved colour value, painted over `backdrop` when translucent. */
export function paint(value: ColorValue, backdrop?: Rgb): Rgb {
  const rgb = oklchToDisplayRgb(colorToOklch(value));
  if ((rgb.alpha ?? 1) >= 1) return { r: rgb.r, g: rgb.g, b: rgb.b };
  return compositeOver(rgb, backdrop ?? { r: 1, g: 1, b: 1 });
}
