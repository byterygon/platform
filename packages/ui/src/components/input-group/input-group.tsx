import { Input as InputPrimitive } from "@base-ui/react/input";
import { useRender } from "@base-ui/react/use-render";
import { createContext, use, type MouseEvent } from "react";
import { Button, type ButtonProps } from "@/components/button/button";
import { cn } from "@/lib/cn";

// An input with things attached: InputGroup draws the border, the focus ring and the invalid and
// disabled looks around InputGroupInput (Base UI's Input, so it works inside a Field) and any
// InputGroupAddon (an icon or text: a scheme, a unit) and InputGroupButton (a ghost Button) placed
// before or after it, in DOM order. The ring shows when the text control has focus, not when the
// button has (the button shows its own), so there is never a ring inside a ring.

const CONTROL = "[data-slot=input-group-input]";

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const inputGroupVariants = {
  size: {
    sm: "h-control-sm",
    md: "h-control-md",
    lg: "h-control-lg",
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const base = [
  "flex w-full min-w-0 items-center gap-inline-md rounded-md border border-border-strong bg-surface font-sans text-body text-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "has-[[data-slot=input-group-input]:focus-visible]:outline-solid has-[[data-slot=input-group-input]:focus-visible]:outline-[length:var(--by-ring-width)]",
  "has-[[data-slot=input-group-input]:focus-visible]:outline-offset-[var(--by-ring-offset)] has-[[data-slot=input-group-input]:focus-visible]:outline-ring",
  "has-[[data-slot=input-group-input][aria-invalid=true]]:border-danger-border has-[[data-slot=input-group-input][data-invalid]]:border-danger-border",
  "has-[[data-slot=input-group-input][data-disabled]]:cursor-not-allowed has-[[data-slot=input-group-input][data-disabled]]:opacity-[var(--by-opacity-disabled)]",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent text-body text-fg outline-none",
  "first:ps-control-x last:pe-control-x",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed",
];

const addonClasses = [
  "flex h-full shrink-0 cursor-text select-none items-center gap-inline-sm text-body text-fg-muted",
  "first:ps-control-x last:pe-control-x",
  "[&_svg]:size-icon-sm [&_svg]:shrink-0",
];

// A button one control size smaller than the group, so it fits inside the border with a small inset.
const buttonClasses = {
  sm: "h-control-xs px-inset-xs",
  md: "",
  lg: "",
} as const;
const buttonSizes = { sm: "sm", md: "sm", lg: "md" } as const;
const buttonInset = "first:ms-inline-xs last:me-inline-xs";

const SizeContext = createContext<keyof typeof inputGroupVariants.size>("md");

export interface InputGroupProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** Height, from the density-aware `size.control.*` roles; InputGroupButton follows it. */
  size?: keyof typeof inputGroupVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The frame around an InputGroupInput and its addons and buttons. Built on Base UI's useRender:
 * `render` swaps the `<div>`, the ref reaches it.
 */
export function InputGroup({ size = "md", className, render, ...props }: InputGroupProps) {
  const element = useRender({
    defaultTagName: "div",
    render,
    props: { "data-slot": "input-group", "data-size": size, ...props, className: cn(base, inputGroupVariants.size[size], className) },
  });
  return <SizeContext value={size}>{element}</SizeContext>;
}

export interface InputGroupInputProps extends Omit<InputPrimitive.Props, "className" | "size"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The text control of an InputGroup, Base UI's Input without a frame of its own: inside a Field
 * it takes the label, description and validity. The ref reaches the `<input>`.
 */
export function InputGroupInput({ className, ...props }: InputGroupInputProps) {
  return <InputPrimitive data-slot="input-group-input" className={cn(inputClasses, className)} {...props} />;
}

export interface InputGroupAddonProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * An icon or text before or after the control (a scheme, a unit, a search icon). Clicking it
 * focuses the control, as clicking a label would. Mark a decorative icon aria-hidden.
 */
export function InputGroupAddon({ className, render, onMouseDown, ...props }: InputGroupAddonProps) {
  const focusControl = (event: MouseEvent<HTMLDivElement>) => {
    onMouseDown?.(event);
    if (event.defaultPrevented || (event.target as Element).closest("button, a, input, select, textarea")) return;
    const control = event.currentTarget.parentElement?.querySelector<HTMLElement>(CONTROL);
    if (!control) return;
    event.preventDefault();
    control.focus();
  };
  return useRender({
    defaultTagName: "div",
    render,
    props: { "data-slot": "input-group-addon", ...props, onMouseDown: focusControl, className: cn(addonClasses, className) },
  });
}

export interface InputGroupButtonProps extends Omit<ButtonProps, "size"> {}

/**
 * A Button inside the group (Copy, Test, Show), ghost by default and one size smaller than the
 * group. For an icon alone, give it an aria-label.
 */
export function InputGroupButton({ variant = "ghost", className, ...props }: InputGroupButtonProps) {
  const size = use(SizeContext);
  return <Button data-slot="input-group-button" variant={variant} size={buttonSizes[size]} className={cn(buttonInset, buttonClasses[size], className)} {...props} />;
}
