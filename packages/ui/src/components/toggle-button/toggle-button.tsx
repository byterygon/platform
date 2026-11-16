import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { buttonBase, buttonVariants } from "@/components/button/button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, type ControlSizeProp } from "@/lib/control";

// Fluent 2's ToggleButton on Base UI's Toggle: a Button (same appearances, sizes, focus ring and
// disabled look) that stays checked. aria-pressed and data-pressed follow `pressed`; checked
// takes color.interactive.selected or the accent, never colour alone: the fill changes too and
// aria-pressed is announced. ToggleGroup's items reuse the subtle look.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toggleButtonVariants = {
  appearance: {
    /** Checked: the accent's pressed solid. */
    primary: `${buttonVariants.appearance.primary} data-pressed:bg-accent-solid-active`,
    /** Checked: the selected wash with the default text. */
    secondary: `${buttonVariants.appearance.secondary} data-pressed:bg-selected data-pressed:text-fg data-pressed:hover:bg-selected-hover`,
    /** Checked: the selected wash and the strong edge. */
    outline: `${buttonVariants.appearance.outline} data-pressed:border-border-strong data-pressed:bg-selected data-pressed:hover:bg-selected-hover`,
    /** Checked: the selected wash, the default text and an accent icon. Toolbars. */
    subtle: `${buttonVariants.appearance.subtle} data-pressed:bg-selected data-pressed:text-fg data-pressed:hover:bg-selected-hover data-pressed:[&_svg]:text-accent-subtle-fg`,
    /** Checked: accent text, no fill. */
    transparent: `${buttonVariants.appearance.transparent} data-pressed:text-accent-subtle-fg`,
  },
  size: buttonVariants.size,
} as const;

/** The classes every appearance and size shares; ToggleGroupItem reuses them. */
export const toggleButtonBase = buttonBase;

/**
 * The `variant` names from before TSK-53.
 * @deprecated Use `appearance`. Kept for one release.
 */
export type ToggleButtonVariant = "ghost" | "outline";

/** The deprecated `variant` values and the appearances they map to. */
export const TOGGLE_BUTTON_VARIANT_ALIASES: Readonly<Record<ToggleButtonVariant, keyof typeof toggleButtonVariants.appearance>> = {
  ghost: "subtle",
  outline: "outline",
};

export interface ToggleButtonProps extends Omit<TogglePrimitive.Props, "className" | "value"> {
  /** Button's appearances; subtle by default, for toolbars. */
  appearance?: keyof typeof toggleButtonVariants.appearance | undefined;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: ToggleButtonVariant | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A button that stays on or off (bold, word wrap, "show nulls"), on Base UI's Toggle: a native
 * `<button>` with aria-pressed. Use `pressed` and `onPressedChange`, or `defaultPressed`; pass the
 * icon `filled` while pressed, as Fluent does. For one of several options use ToggleGroup. The ref
 * reaches the `<button>`.
 */
export function ToggleButton({ appearance, variant, size, className, ...props }: ToggleButtonProps) {
  const look = controlAppearance(appearance, variant, TOGGLE_BUTTON_VARIANT_ALIASES, "subtle");
  const height = controlSize(size);
  return (
    <TogglePrimitive
      data-slot="toggle-button"
      data-appearance={look}
      data-size={height}
      className={cn(toggleButtonBase, toggleButtonVariants.appearance[look], toggleButtonVariants.size[height], className)}
      {...props}
    />
  );
}
