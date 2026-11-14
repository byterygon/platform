import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { buttonBase, buttonVariants } from "@/components/button/button";
import { cn } from "@/lib/cn";

// A square Button holding only an icon. The colours are Button's (`buttonVariants.variant`), so
// the two always match; the size is a square of the control height. The accessible name has to
// come from `aria-label`, which the type requires: an icon alone says nothing to a screen reader.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const iconButtonVariants = {
  variant: buttonVariants.variant,
  size: {
    sm: "size-control-sm [&_svg]:size-icon-sm",
    md: "size-control-md [&_svg]:size-icon-sm",
    lg: "size-control-lg [&_svg]:size-icon-md",
  },
} as const;

export interface IconButtonProps extends Omit<ButtonPrimitive.Props, "className" | "aria-label"> {
  /** The accessible name, required: what the button does ("Copy connection string"), not the icon's name. */
  "aria-label": string;
  /** Visual weight, as Button's. Ghost by default: icon buttons mostly sit in toolbars and inputs. */
  variant?: keyof typeof iconButtonVariants.variant;
  /** A square of the density-aware `size.control.*` height. */
  size?: keyof typeof iconButtonVariants.size;
  /** Shows that the action is running: stays focusable, ignores clicks, sets `aria-busy` and `data-loading`. */
  loading?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * An icon-only action button on Base UI's Button. Pass the icon (an `<svg aria-hidden>`) as the
 * child and say what the button does in `aria-label`. The ref reaches the `<button>`.
 */
export function IconButton({ variant = "ghost", size = "md", loading = false, disabled, className, type = "button", ...props }: IconButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="icon-button"
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "" : undefined}
      aria-busy={loading || undefined}
      type={type}
      disabled={disabled || loading}
      focusableWhenDisabled={loading}
      className={cn(buttonBase, iconButtonVariants.variant[variant], iconButtonVariants.size[size], className)}
      {...props}
    />
  );
}
