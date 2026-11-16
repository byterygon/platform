import type { ComponentProps, MouseEventHandler, ReactNode, Ref } from "react";
import { Button, type ButtonVariant } from "@/components/button/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, type DropdownMenuProps } from "@/components/dropdown-menu/dropdown-menu";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, type ControlSizeProp } from "@/lib/control";
import { ChevronDown } from "@/lib/icons";

// Fluent 2's SplitButton: a primary action with a menu of its variants, joined into one control: a
// Button and a chevron IconButton that opens a DropdownMenu (Base UI's Menu). DBee's Run is one:
// Run, with "Run selection" and "Run statement" in the menu. The menu's content is DropdownMenu's
// parts. Both halves take Button's appearance and size; a focused half is lifted above the other
// so its double ring is never covered.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const splitButtonVariants = {
  /** The Button appearance of both halves; the classes are the divider and the open menu button. */
  appearance: {
    primary: "border-s-accent-solid-active data-popup-open:bg-accent-solid-active",
    secondary: "border-s-border-subtle data-popup-open:bg-pressed",
    outline: "border-s-border data-popup-open:bg-pressed",
    subtle: "border-s-border-subtle data-popup-open:bg-pressed",
    transparent: "border-s-transparent data-popup-open:text-accent-subtle-fg",
  },
  /** The height of both halves, from `size.control.*`; the menu button is square. */
  size: {
    small: "border-s",
    medium: "border-s",
    large: "border-s",
  },
} as const;

/** The deprecated `variant` values SplitButton took, and the appearances they map to. */
const VARIANT_ALIASES: Readonly<Record<Exclude<ButtonVariant, "danger">, keyof typeof splitButtonVariants.appearance>> = {
  primary: "primary",
  secondary: "secondary",
  ghost: "subtle",
};

export interface SplitButtonProps extends Omit<ComponentProps<"div">, "className" | "onClick" | "children" | "ref"> {
  /** The main action's label. */
  children?: ReactNode;
  /** Runs the main action. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** The menu's items: DropdownMenuItem, DropdownMenuGroup, DropdownMenuSeparator. */
  menu?: ReactNode;
  /** The accessible name of the menu button. */
  menuLabel?: string;
  /** Button appearance of both halves. */
  appearance?: keyof typeof splitButtonVariants.appearance | undefined;
  /**
   * The old name of `appearance` (`ghost` is `subtle`).
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: Exclude<ButtonVariant, "danger"> | undefined;
  /** Height of both halves: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Disables both halves. */
  disabled?: boolean;
  /** The main action is running: its Button shows loading; the menu stays usable. */
  loading?: boolean;
  /** How the menu lines up with the control. */
  align?: "start" | "center" | "end";
  /** Controlled open state of the menu; `defaultOpen` and `onOpenChange` as DropdownMenu's. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: DropdownMenuProps["onOpenChange"];
  /** Extra classes for the group, merged after the component's own so they win. */
  className?: string;
  /** Reaches the main action's `<button>`. */
  ref?: Ref<HTMLButtonElement>;
}

/** A Button joined to a menu button that opens a DropdownMenu of related actions. */
export function SplitButton({
  children,
  onClick,
  menu,
  menuLabel = "More options",
  appearance,
  variant,
  size,
  disabled = false,
  loading = false,
  align = "end",
  open,
  defaultOpen,
  onOpenChange,
  className,
  ref,
  ...props
}: SplitButtonProps) {
  const look = controlAppearance(appearance, variant, VARIANT_ALIASES, "primary");
  const height = controlSize(size);
  const menuState = { ...(open === undefined ? {} : { open }), ...(defaultOpen === undefined ? {} : { defaultOpen }), ...(onOpenChange ? { onOpenChange } : {}) };
  return (
    <div data-slot="split-button" data-appearance={look} data-size={height} role="group" className={cn("inline-flex items-stretch", className)} {...props}>
      <Button ref={ref} appearance={look} size={height} disabled={disabled} loading={loading} className="rounded-e-none focus-visible:relative" {...(onClick ? { onClick } : {})}>
        {children}
      </Button>
      <DropdownMenu {...menuState}>
        <DropdownMenuTrigger
          disabled={disabled}
          render={<IconButton aria-label={menuLabel} appearance={look} size={height} />}
          className={cn("rounded-s-none focus-visible:relative", splitButtonVariants.appearance[look], splitButtonVariants.size[height])}
        >
          <Icon icon={ChevronDown} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>{menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
