import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, focusRing, type ControlSizeProp } from "@/lib/control";

// Fluent 2's Button on Base UI's Button: appearance primary, secondary, outline, subtle or
// transparent (plus Byterygon's danger), sizes small, medium and large. The look is the layered
// one: secondary is a translucent layer with a hairline and a slightly darker bottom edge, focus is
// the double ring of @/lib/control, disabled takes Fluent's disabled fill and text. IconButton,
// ToggleButton and SplitButton reuse these classes.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const buttonVariants = {
  appearance: {
    /** The one main action of a view: the accent solid. */
    primary: "border-transparent bg-accent-solid text-accent-solid-fg hover:bg-accent-solid-hover active:bg-accent-solid-active data-disabled:border-transparent data-disabled:bg-disabled",
    /** Every other action: a translucent layer with a hairline and a darker bottom edge. */
    secondary: "border-border-subtle border-b-border-control-bottom-subtle bg-layer text-fg hover:bg-hover active:bg-pressed active:text-fg-muted data-disabled:border-border-disabled data-disabled:bg-disabled",
    /** An action that needs an edge but no fill: on busy backgrounds, beside a primary in a card. */
    outline: "border-border bg-transparent text-fg hover:border-border-strong active:border-border-strong active:bg-pressed data-disabled:border-border-disabled data-disabled:bg-transparent",
    /** A quiet action in toolbars, tables and dense rows: a wash on hover, the icon in the accent. */
    subtle: "border-transparent bg-transparent text-fg-muted hover:bg-hover hover:text-fg hover:[&_svg]:text-accent-subtle-fg active:bg-pressed active:text-fg data-disabled:bg-transparent",
    /** The quietest action, link-like: no fill ever, the text turns accent on hover. */
    transparent: "border-transparent bg-transparent text-fg-muted hover:text-accent-subtle-fg active:text-accent-subtle-fg data-disabled:bg-transparent",
    /** Byterygon's: an action that destroys data or cannot be undone (Fluent has no danger appearance). */
    danger: "border-transparent bg-danger text-danger-solid-fg hover:bg-danger-hover active:bg-danger-hover data-disabled:border-transparent data-disabled:bg-disabled",
  },
  size: {
    /** Fluent small: 24 px comfortable, caption-1, a 16 px icon. */
    small: "h-control-sm px-inset-xs text-caption-1 [&_svg]:size-icon-md",
    /** Fluent medium: 32 px comfortable, body-1-strong, a 20 px icon. */
    medium: "h-control-md px-control-x text-body-1-strong [&_svg]:size-icon-lg",
    /** Fluent large: 40 px comfortable, subtitle-2, a 24 px icon. */
    large: "h-control-lg px-inset-md text-subtitle-2 [&_svg]:size-icon-xl",
  },
} as const;

/** The classes every size and appearance shares; IconButton, ToggleButton and SplitButton reuse them. */
export const buttonBase = [
  "inline-flex shrink-0 select-none items-center justify-center gap-inline-sm whitespace-nowrap",
  "rounded-md border font-sans",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  focusRing,
  "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  "data-loading:pointer-events-none",
  "[&_svg]:shrink-0",
];

export type ButtonAppearance = keyof typeof buttonVariants.appearance;
export type ButtonSize = keyof typeof buttonVariants.size;

/**
 * The `variant` names from before TSK-53 and the appearance each one shows.
 * @deprecated Use `appearance`. Kept for one release.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** The deprecated `variant` values and the appearances they map to (`ghost` is Fluent's `subtle`). */
export const BUTTON_VARIANT_ALIASES: Readonly<Record<ButtonVariant, ButtonAppearance>> = {
  primary: "primary",
  secondary: "secondary",
  ghost: "subtle",
  danger: "danger",
};

export interface ButtonProps extends Omit<ButtonPrimitive.Props, "className"> {
  /** Fluent's appearance: primary for the main action, secondary for the others, subtle in toolbars. */
  appearance?: ButtonAppearance | undefined;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: ButtonVariant | undefined;
  /** Fluent's size: small, medium or large; `sm`, `md` and `lg` are deprecated aliases. */
  size?: ControlSizeProp | undefined;
  /**
   * Shows that the action is running: the button stays focusable, ignores clicks and sets
   * `aria-busy` and `data-loading`.
   */
  loading?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * An action button on Base UI's Button (a native `<button>` unless `render` changes it). The ref
 * reaches the rendered element.
 */
export function Button({ appearance, variant, size, loading = false, disabled, className, type = "button", ...props }: ButtonProps) {
  const look = controlAppearance(appearance, variant, BUTTON_VARIANT_ALIASES, "primary");
  const height = controlSize(size);
  return (
    <ButtonPrimitive
      data-slot="button"
      data-appearance={look}
      data-size={height}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cn(buttonBase, buttonVariants.appearance[look], buttonVariants.size[height], className)}
      {...props}
    />
  );
}
