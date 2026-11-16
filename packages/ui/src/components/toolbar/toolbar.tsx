import { Toolbar as ToolbarPrimitive } from "@base-ui/react/toolbar";
import { cn } from "@/lib/cn";
import { fieldAppearances, focusRing } from "@/lib/control";

// A row of controls with one tab stop, on Base UI's Toolbar (role="toolbar"; arrow keys move
// between items): DBee's query tab bar (Run, Cancel, connection, row limit).
// Toolbar > ToolbarGroup, ToolbarButton, ToolbarSeparator, ToolbarLink, ToolbarInput. A
// ToolbarButton is a ghost button of size.control.sm; render a SplitButton, a Select or a
// ToggleButton through `render` to keep them in the toolbar's focus order. A row wider than its
// container scrolls sideways instead of wrapping, so the bar keeps its height.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toolbarVariants = {
  variant: {
    bar: "border-b border-border-subtle bg-layer px-inset-xs",
    plain: "",
  },
} as const;

const base = [
  "flex min-h-control-md min-w-0 items-center gap-inline-xs overflow-x-auto font-sans text-body-1 text-fg",
  "data-[orientation=vertical]:min-h-0 data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch data-[orientation=vertical]:overflow-x-visible",
];

const classes = {
  group: "flex shrink-0 items-center gap-inline-xs in-data-[orientation=vertical]:flex-col in-data-[orientation=vertical]:items-stretch",
  button: [
    "inline-flex h-control-sm shrink-0 cursor-default select-none items-center justify-center gap-inline-xs whitespace-nowrap rounded-md px-inset-xs text-body-1 text-fg",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
    "hover:bg-hover active:bg-pressed data-pressed:bg-selected",
    focusRing,
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
    "[&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  link: [
    "inline-flex h-control-sm shrink-0 items-center rounded-md px-inset-xs text-body-1 text-fg-link underline-offset-4 hover:underline",
    focusRing,
  ],
  input: [
    "h-control-sm min-w-0 rounded-md border px-inset-xs text-caption-1 text-fg outline-none placeholder:text-fg-subtle",
    fieldAppearances.outline,
    "focus-visible:shadow-focus-underline data-disabled:border-border-disabled data-disabled:text-fg-disabled",
  ],
  separator: [
    "shrink-0 self-stretch bg-border-subtle",
    "data-[orientation=vertical]:my-inset-xs data-[orientation=vertical]:w-[var(--by-border-width-1)]",
    "data-[orientation=horizontal]:mx-inset-xs data-[orientation=horizontal]:h-[var(--by-border-width-1)]",
  ],
} as const;

export interface ToolbarProps extends Omit<ToolbarPrimitive.Root.Props, "className"> {
  /** `bar` is a surface with a bottom border (a tab's tool row); `plain` has no frame. */
  variant?: keyof typeof toolbarVariants.variant;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The toolbar, role="toolbar"; give it an aria-label. The ref reaches the root `<div>`. */
export function Toolbar({ variant = "bar", className, ...props }: ToolbarProps) {
  return <ToolbarPrimitive.Root data-slot="toolbar" data-variant={variant} className={cn(base, toolbarVariants.variant[variant], className)} {...props} />;
}

export interface ToolbarGroupProps extends Omit<ToolbarPrimitive.Group.Props, "className"> {
  className?: string;
}

/** Items that belong together (Run and Cancel); `disabled` disables all of them. */
export function ToolbarGroup({ className, ...props }: ToolbarGroupProps) {
  return <ToolbarPrimitive.Group data-slot="toolbar-group" className={cn(classes.group, className)} {...props} />;
}

export interface ToolbarButtonProps extends Omit<ToolbarPrimitive.Button.Props, "className"> {
  className?: string;
}

/**
 * A quiet button in the toolbar's focus order. An icon-only one needs an aria-label. `render`
 * puts another control in its place (`render={<ToggleButton />}`); a disabled one stays
 * focusable (focusableWhenDisabled) so arrow keys do not skip it.
 */
export function ToolbarButton({ className, ...props }: ToolbarButtonProps) {
  return <ToolbarPrimitive.Button data-slot="toolbar-button" className={cn(classes.button, className)} {...props} />;
}

export interface ToolbarLinkProps extends Omit<ToolbarPrimitive.Link.Props, "className"> {
  className?: string;
}

/** A link in the toolbar's focus order (Docs, the audit log). */
export function ToolbarLink({ className, ...props }: ToolbarLinkProps) {
  return <ToolbarPrimitive.Link data-slot="toolbar-link" className={cn(classes.link, className)} {...props} />;
}

export interface ToolbarInputProps extends Omit<ToolbarPrimitive.Input.Props, "className"> {
  className?: string;
}

/** A compact text field in the toolbar (a filter); arrow keys at its ends leave it. Give it an aria-label. */
export function ToolbarInput({ className, ...props }: ToolbarInputProps) {
  return <ToolbarPrimitive.Input data-slot="toolbar-input" className={cn(classes.input, className)} {...props} />;
}

export interface ToolbarSeparatorProps extends Omit<ToolbarPrimitive.Separator.Props, "className"> {
  className?: string;
}

/** A rule between groups, perpendicular to the toolbar. */
export function ToolbarSeparator({ className, ...props }: ToolbarSeparatorProps) {
  return <ToolbarPrimitive.Separator data-slot="toolbar-separator" className={cn(classes.separator, className)} {...props} />;
}
