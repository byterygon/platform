import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { BUTTON_VARIANT_ALIASES, buttonBase, buttonVariants, type ButtonVariant } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, type ControlSizeProp } from "@/lib/control";

// A square Button holding only an icon, as Fluent 2's icon-only Button. The appearances are
// Button's (`buttonVariants.appearance`), so the two always match; the size is a square of the
// control height with Fluent's icon for it (16, 20, 24 px). The accessible name has to come from
// `aria-label`, which the type requires: an icon alone says nothing to a screen reader.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const iconButtonVariants = {
  appearance: buttonVariants.appearance,
  size: {
    small: "size-control-sm [&_svg]:size-icon-md",
    medium: "size-control-md [&_svg]:size-icon-lg",
    large: "size-control-lg [&_svg]:size-icon-xl",
  },
} as const;

export interface IconButtonProps extends Omit<ButtonPrimitive.Props, "className" | "aria-label"> {
  /** The accessible name, required: what the button does ("Copy connection string"), not the icon's name. */
  "aria-label": string;
  /** Button's appearance. Subtle by default: icon buttons mostly sit in toolbars and inputs. */
  appearance?: keyof typeof iconButtonVariants.appearance | undefined;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: ButtonVariant | undefined;
  /** A square of the density-aware `size.control.*` height: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Shows that the action is running: stays focusable, ignores clicks, sets `aria-busy` and `data-loading`. */
  loading?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * An icon-only action button on Base UI's Button. Pass the icon (`<Icon icon={Copy} />`) as the
 * child and say what the button does in `aria-label`. The ref reaches the `<button>`.
 */
export function IconButton({ appearance, variant, size, loading = false, disabled, className, type = "button", ...props }: IconButtonProps) {
  const look = controlAppearance(appearance, variant, BUTTON_VARIANT_ALIASES, "subtle");
  const edge = controlSize(size);
  return (
    <ButtonPrimitive
      data-slot="icon-button"
      data-appearance={look}
      data-size={edge}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cn(buttonBase, iconButtonVariants.appearance[look], iconButtonVariants.size[edge], className)}
      {...props}
    />
  );
}
