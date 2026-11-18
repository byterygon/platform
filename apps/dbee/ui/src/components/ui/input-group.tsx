import { Input as InputPrimitive } from "@base-ui/react/input";
import { useRender } from "@base-ui/react/use-render";
import { createContext, use, type MouseEvent } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldSizes, type ControlSize, type ControlSizeProp, type FieldAppearance } from "@/lib/control";

// An input with things attached (Fluent 2's Input with contentBefore/contentAfter): InputGroup
// draws the frame (Input's appearances), the focus underline and the invalid and disabled looks
// around InputGroupInput (Base UI's Input, so it works inside a Field) and any InputGroupAddon (an
// icon or text: a scheme, a unit) and InputGroupButton (a subtle Button) placed before or after
// it, in DOM order. The underline shows when the text control has focus, not when the button has
// (the button shows its own double ring).

const CONTROL = "[data-slot=input-group-input]";

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const inputGroupVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} [&_[data-slot=input-group-addon]_svg]:size-icon-md`,
    medium: `${fieldSizes.medium} [&_[data-slot=input-group-addon]_svg]:size-icon-lg`,
    large: `${fieldSizes.large} [&_[data-slot=input-group-addon]_svg]:size-icon-xl`,
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const base = [
  "flex w-full min-w-0 items-center gap-inline-md",
  fieldFrame,
  "has-[[data-slot=input-group-input]:focus-visible]:shadow-focus-underline",
  "has-[[data-slot=input-group-input][aria-invalid=true]]:border-danger-border has-[[data-slot=input-group-input][aria-invalid=true]]:border-b-danger-stroke",
  "has-[[data-slot=input-group-input][data-invalid]]:border-danger-border has-[[data-slot=input-group-input][data-invalid]]:border-b-danger-stroke",
  "has-[[data-slot=input-group-input][data-disabled]]:cursor-not-allowed has-[[data-slot=input-group-input][data-disabled]]:border-border-disabled",
  "has-[[data-slot=input-group-input][data-disabled]]:bg-transparent has-[[data-slot=input-group-input][data-disabled]]:text-fg-disabled",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent text-fg outline-none",
  "first:ps-control-x last:pe-control-x",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed data-disabled:text-fg-disabled data-disabled:placeholder:text-fg-disabled",
];

const addonClasses = [
  "flex h-full shrink-0 cursor-text select-none items-center gap-inline-sm text-fg-muted",
  "first:ps-control-x last:pe-control-x",
  "[&_svg]:shrink-0",
];

// A button one control size smaller than the group, so it fits inside the border with a small inset.
const buttonClasses: Record<ControlSize, string> = {
  small: "h-control-xs px-inset-xs",
  medium: "",
  large: "",
};
const buttonSizes: Record<ControlSize, ControlSize> = { small: "small", medium: "small", large: "medium" };
const buttonInset = "first:ms-inline-xs last:me-inline-xs";

const SizeContext = createContext<ControlSize>("medium");

export interface InputGroupProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** Fluent's field appearance: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases); InputGroupButton follows it. */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The frame around an InputGroupInput and its addons and buttons. Built on Base UI's useRender:
 * `render` swaps the `<div>`, the ref reaches it.
 */
export function InputGroup({ appearance, size, className, render, ...props }: InputGroupProps) {
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  const element = useRender({
    defaultTagName: "div",
    render,
    props: {
      "data-slot": "input-group",
      "data-appearance": look,
      "data-size": height,
      ...props,
      className: cn(base, inputGroupVariants.appearance[look], inputGroupVariants.size[height], className),
    },
  });
  return <SizeContext value={height}>{element}</SizeContext>;
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
 * A Button inside the group (Copy, Test, Show), subtle by default and one size smaller than the
 * group. For an icon alone, give it an aria-label.
 */
export function InputGroupButton({ appearance, variant, className, ...props }: InputGroupButtonProps) {
  const size = use(SizeContext);
  return (
    <Button
      data-slot="input-group-button"
      appearance={appearance ?? (variant === undefined ? "subtle" : undefined)}
      variant={variant}
      size={buttonSizes[size]}
      className={cn(buttonInset, buttonClasses[size], className)}
      {...props}
    />
  );
}
