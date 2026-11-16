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

/*
 * Fields (Fluent 2's Input, Textarea, Select, Combobox, SpinButton, DatePicker): a frame with a
 * hairline (color.border.subtle) and a bottom edge in color.border.control-bottom, the stroke
 * that makes a field 3:1. Focus is Fluent's accent underline (shadow.focus-underline), not the
 * double ring; invalid turns the hairline and the bottom edge danger (FieldError says why);
 * disabled drops the fill and greys the strokes and text.
 */

/** Fluent 2's field appearances, on the element that draws the frame (an input, a group, a trigger). */
export const fieldAppearances = {
  /** A light fill (color.bg.layer-alt) with a hairline and the darker bottom edge: the default. */
  outline: "border-border-subtle border-b-border-control-bottom bg-layer-alt",
  /** Only the bottom edge, no fill or corners: dense forms and inline editing. */
  underline: "rounded-none border-transparent border-b-border-control-bottom bg-transparent",
  /** A darker fill (color.bg.inset) for a field on a white or light surface. */
  "filled-darker": "border-transparent border-b-border-control-bottom bg-inset",
  /** A lighter fill (color.bg.surface) for a field on a grey or inset surface. */
  "filled-lighter": "border-transparent border-b-border-control-bottom bg-surface",
} as const;

export type FieldAppearance = keyof typeof fieldAppearances;
export const FIELD_APPEARANCES = Object.keys(fieldAppearances) as FieldAppearance[];

/** The field appearance for an `appearance` prop, `outline` when none is given. */
export function fieldAppearance(appearance: FieldAppearance | undefined): FieldAppearance {
  return appearance !== undefined && Object.hasOwn(fieldAppearances, appearance) ? appearance : "outline";
}

/** Fluent's field heights and text: small 24 px caption-1, medium 32 px body-1, large 40 px body-2 (comfortable). */
export const fieldSizes = {
  small: "h-control-sm text-caption-1",
  medium: "h-control-md text-body-1",
  large: "h-control-lg text-body-2",
} as const;

/** Fluent's horizontal padding inside a field: 8, 12 and 16 px when comfortable. */
export const fieldPadding = {
  small: "px-inset-xs",
  medium: "px-control-x",
  large: "px-inset-md",
} as const;

/** The frame every field shares: border box, radius, font, and the underline fading in. */
export const fieldFrame =
  "rounded-md border font-sans text-fg outline-none transition duration-[var(--by-motion-duration-faster)] ease-easy-ease motion-reduce:transition-none";

/**
 * Focus, invalid and disabled on a field that is itself the focusable element (Input, Textarea,
 * a Select trigger). A frame around a control (InputGroup, NumberInput) writes the same looks
 * with `has-[…]` on its control's slot.
 */
export const fieldStates = [
  "focus-visible:shadow-focus-underline",
  "aria-invalid:border-danger-border aria-invalid:border-b-danger data-invalid:border-danger-border data-invalid:border-b-danger",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-fg-disabled",
].join(" ");
