// What every Byterygon control shares (TSK-53, Fluent 2): the double focus ring, the size names
// and the aliases kept for one release while apps move to Fluent's prop names.
//
// The focus ring is Fluent 2's: an outline in ring.color (ring.width) outside a 1 px stroke in
// ring.inner-color, so it reads on any fill, glow or layer. The outline is offset by the inner
// stroke's width and drawn by `outline`, which forced-colours mode keeps; the inner stroke is a
// box-shadow (Tailwind's ring), which it drops, and that is fine. Use it on every focusable control
// rather than writing the classes again.

/** The double focus ring, on keyboard focus only. Add it to a control's base classes. */
export const focusRing = [
  "outline-none",
  "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-inner-width)] focus-visible:outline-ring",
  "focus-visible:ring-[length:var(--by-ring-inner-width)] focus-visible:ring-ring-inner",
].join(" ");

/**
 * The same ring on a control whose focus sits on an element inside it (a field's `<input>`, a
 * slider's thumb): it shows when a descendant has keyboard focus.
 */
export const focusRingWithin = [
  "outline-none",
  "has-focus-visible:outline-solid has-focus-visible:outline-[length:var(--by-ring-width)] has-focus-visible:outline-offset-[var(--by-ring-inner-width)] has-focus-visible:outline-ring",
  "has-focus-visible:ring-[length:var(--by-ring-inner-width)] has-focus-visible:ring-ring-inner",
].join(" ");

/**
 * Fluent 2's control sizes. Comfortable: small 24, medium 32, large 40 px (`size.control.sm`,
 * `md`, `lg`); compact maps the same names onto the dense heights 22, 28 and 34 px.
 */
export const CONTROL_SIZES = ["small", "medium", "large"] as const;
export type ControlSize = (typeof CONTROL_SIZES)[number];

/**
 * The size names from before TSK-53.
 * @deprecated Use `small`, `medium` and `large`. Kept for one release.
 */
export type LegacyControlSize = "sm" | "md" | "lg";

/** The old size names and the Fluent names they stand for. */
export const LEGACY_SIZES: Readonly<Record<LegacyControlSize, ControlSize>> = { sm: "small", md: "medium", lg: "large" };

/** A size prop that takes the Fluent names and, for one release, the old ones. */
export type ControlSizeProp = ControlSize | LegacyControlSize;

/** The Fluent size for a `size` prop that may hold an old name (`sm` -> `small`). */
export function controlSize(size: ControlSizeProp | undefined, fallback: ControlSize = "medium"): ControlSize {
  if (size === undefined) return fallback;
  return (LEGACY_SIZES as Record<string, ControlSize>)[size] ?? (size as ControlSize);
}

/**
 * The appearance a control shows: `appearance` when given, else the deprecated `variant` through
 * `aliases`, else `fallback`. A value neither table knows falls back too.
 */
export function controlAppearance<A extends string, V extends string>(
  appearance: A | undefined,
  variant: V | undefined,
  aliases: Readonly<Record<V, A>>,
  fallback: A,
): A {
  if (appearance !== undefined) return appearance;
  if (variant !== undefined) return aliases[variant] ?? fallback;
  return fallback;
}
