import type { ComponentProps, MouseEventHandler, ReactNode, Ref } from "react";
import { Button } from "@/components/button/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, type DropdownMenuProps } from "@/components/dropdown-menu/dropdown-menu";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";

// A primary action with a menu of its variants, joined into one control: a Button and an
// IconButton that opens a DropdownMenu (Base UI's Menu). DBee's Run is one: Run, with "Run
// selection" and "Run statement" in the menu. The menu's content is DropdownMenu's parts.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const splitButtonVariants = {
  /** The Button variant of both halves; the classes are the divider and the open menu button. */
  variant: {
    primary: "border-s-accent-solid-active data-popup-open:bg-accent-solid-active",
    secondary: "border-s-neutral-solid-active data-popup-open:bg-neutral-solid-active",
    ghost: "border-s-border data-popup-open:bg-pressed",
  },
  /** The height of both halves, from `size.control.*`; the menu button is square. */
  size: {
    sm: "border-s",
    md: "border-s",
    lg: "border-s",
  },
} as const;

const ChevronDownIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export interface SplitButtonProps extends Omit<ComponentProps<"div">, "className" | "onClick" | "children" | "ref"> {
  /** The main action's label. */
  children?: ReactNode;
  /** Runs the main action. */
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** The menu's items: DropdownMenuItem, DropdownMenuGroup, DropdownMenuSeparator. */
  menu?: ReactNode;
  /** The accessible name of the menu button. */
  menuLabel?: string;
  /** Button variant of both halves. */
  variant?: keyof typeof splitButtonVariants.variant;
  /** Height of both halves. */
  size?: keyof typeof splitButtonVariants.size;
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
  variant = "primary",
  size = "md",
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
  const menuState = { ...(open === undefined ? {} : { open }), ...(defaultOpen === undefined ? {} : { defaultOpen }), ...(onOpenChange ? { onOpenChange } : {}) };
  return (
    <div data-slot="split-button" data-variant={variant} data-size={size} role="group" className={cn("inline-flex items-stretch", className)} {...props}>
      <Button ref={ref} variant={variant} size={size} disabled={disabled} loading={loading} className="rounded-e-none" {...(onClick ? { onClick } : {})}>
        {children}
      </Button>
      <DropdownMenu {...menuState}>
        <DropdownMenuTrigger
          disabled={disabled}
          render={<IconButton aria-label={menuLabel} variant={variant} size={size} />}
          className={cn("rounded-s-none", splitButtonVariants.variant[variant], splitButtonVariants.size[size])}
        >
          <ChevronDownIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align}>{menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
