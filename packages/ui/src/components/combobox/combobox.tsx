import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ReactNode, Ref } from "react";
import { CheckIcon, popupClasses, popupOffset, popupStyle } from "@/components/select/select";
import { cn } from "@/lib/cn";
import { useThemeScope } from "@/lib/theme-scope";

// A text input that filters a list, on Base UI's Combobox: the frame holds the input, a clear
// button (shown while there is a value) and a chevron that opens the list; the popup holds the
// filtered items, a "no results" line and an optional status line (loading, an error) read out by
// screen readers. Typing filters by the item labels; the first match is highlighted so Enter
// takes it. The popup shares Select's surface, items and theme scope.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const comboboxVariants = {
  size: {
    sm: "h-control-sm *:first:ps-inset-sm",
    md: "h-control-md",
    lg: "h-control-lg *:first:ps-inset-lg",
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
export const frameClasses = [
  "flex w-full min-w-0 items-center gap-inline-xs rounded-md border border-border-strong bg-surface pe-inline-xs font-sans text-body text-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-[length:var(--by-ring-width)]",
  "has-[input:focus-visible]:outline-offset-[var(--by-ring-offset)] has-[input:focus-visible]:outline-ring",
  "data-popup-open:border-border-focus",
  "data-invalid:border-danger-border has-[[aria-invalid=true]]:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent ps-control-x text-body text-fg outline-none",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed",
];

/** The clear and chevron buttons inside the frame, and a chip's remove button. */
export const frameButtonClasses = [
  "flex size-control-xs shrink-0 cursor-default items-center justify-center rounded-sm text-fg-muted outline-none",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover hover:text-fg active:bg-pressed",
  "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-ring",
  "data-disabled:pointer-events-none",
  "[&_svg]:size-icon-sm",
];

/** The "no results" and status lines; empty (and so hidden) while they have nothing to say. */
export const messageClasses = "flex min-h-control-sm items-center px-inset-sm text-body text-fg-muted empty:hidden";

export const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export const ClearIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </svg>
);

export interface ComboboxProps<Value, Item = Value> extends Omit<ComboboxPrimitive.Root.Props<Value, false, Item>, "multiple" | "children"> {
  /** Frame height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof comboboxVariants.size;
  /** Placeholder of the text input. */
  placeholder?: string;
  /** Accessible name when there is no FieldLabel; set on the input. */
  "aria-label"?: string;
  /** Shown when no item matches the text. */
  emptyMessage?: ReactNode;
  /** A line above the items (loading, an error), announced politely; nothing when empty. */
  status?: ReactNode;
  /** The clear button's accessible name. */
  clearLabel?: string;
  /** The list: a function from each (filtered) item to a ComboboxItem, or ComboboxItem children. */
  children?: ReactNode | ((item: Item, index: number) => ReactNode);
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
  /** Reaches the `<input>`. */
  ref?: Ref<HTMLInputElement>;
}

/**
 * A combobox on Base UI's Combobox. Pass `items` (strings, `{ value, label }` objects, groups, or
 * a `Combobox.createItems` collection) and a function child that renders each one as a
 * ComboboxItem; Base UI filters them by label as the user types. Inside a Field it takes the
 * label, description and validity; the ref reaches the input.
 */
export function Combobox<Value, Item = Value>({
  size = "md",
  placeholder,
  "aria-label": ariaLabel,
  emptyMessage = "No results.",
  status,
  clearLabel = "Clear",
  children,
  className,
  ref,
  autoHighlight = true,
  onOpenChange,
  ...props
}: ComboboxProps<Value, Item>) {
  const { ref: anchorRef, anchor, scope, refresh } = useThemeScope<HTMLDivElement>();
  return (
    <ComboboxPrimitive.Root<Value, false, Item>
      autoHighlight={autoHighlight}
      onOpenChange={(open, details) => {
        if (open) refresh();
        onOpenChange?.(open, details);
      }}
      {...props}
    >
      <ComboboxPrimitive.InputGroup ref={anchorRef} data-slot="combobox" data-size={size} className={cn(frameClasses, comboboxVariants.size[size], className)}>
        <ComboboxPrimitive.Input ref={ref} data-slot="combobox-input" placeholder={placeholder} aria-label={ariaLabel} className={cn(inputClasses)} />
        <ComboboxPrimitive.Clear data-slot="combobox-clear" keepMounted aria-label={clearLabel} className={cn(frameButtonClasses, "not-data-visible:hidden data-disabled:hidden")}>
          <ClearIcon />
        </ComboboxPrimitive.Clear>
        <ComboboxPrimitive.Trigger data-slot="combobox-trigger" className={cn(frameButtonClasses, "data-popup-open:text-fg")}>
          <ChevronIcon />
        </ComboboxPrimitive.Trigger>
      </ComboboxPrimitive.InputGroup>
      <ComboboxPopup scope={scope} anchor={anchor} emptyMessage={emptyMessage} status={status}>
        {children}
      </ComboboxPopup>
    </ComboboxPrimitive.Root>
  );
}

export interface ComboboxPopupProps {
  scope: ReturnType<typeof useThemeScope>["scope"];
  anchor: { current: Element | null };
  emptyMessage: ReactNode;
  status: ReactNode;
  children: ReactNode | ((item: never, index: number) => ReactNode);
}

/** The portal, positioner and popup of a Combobox or MultiSelect, with its messages and list. */
export function ComboboxPopup({ scope, anchor, emptyMessage, status, children }: ComboboxPopupProps) {
  return (
    <ComboboxPrimitive.Portal>
      <ComboboxPrimitive.Positioner {...scope} data-slot="combobox-positioner" sideOffset={() => popupOffset(anchor.current)} className={cn(popupClasses.positioner)}>
        <ComboboxPrimitive.Popup data-slot="combobox-popup" style={popupStyle} className={cn(popupClasses.popup)}>
          <ComboboxPrimitive.Status data-slot="combobox-status" className={cn(messageClasses)}>
            {status}
          </ComboboxPrimitive.Status>
          <ComboboxPrimitive.Empty data-slot="combobox-empty" className={cn(messageClasses)}>
            {emptyMessage}
          </ComboboxPrimitive.Empty>
          <ComboboxPrimitive.List data-slot="combobox-list" className="flex flex-col outline-none empty:hidden">
            {children as ComboboxPrimitive.List.Props["children"]}
          </ComboboxPrimitive.List>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

export interface ComboboxItemProps extends Omit<ComboboxPrimitive.Item.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One item: its content and, while chosen, a check mark at the end. */
export function ComboboxItem({ className, children, ...props }: ComboboxItemProps) {
  return (
    <ComboboxPrimitive.Item data-slot="combobox-item" className={cn(popupClasses.item, className)} {...props}>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ComboboxPrimitive.ItemIndicator className={cn(popupClasses.indicator)}>
        <CheckIcon />
      </ComboboxPrimitive.ItemIndicator>
    </ComboboxPrimitive.Item>
  );
}

export interface ComboboxGroupProps extends Omit<ComboboxPrimitive.Group.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A group of items named by the ComboboxGroupLabel inside it. With grouped `items`, pass the
 * group's items as `items` and render them in a ComboboxCollection.
 */
export function ComboboxGroup({ className, ...props }: ComboboxGroupProps) {
  return <ComboboxPrimitive.Group data-slot="combobox-group" className={cn("flex flex-col", className)} {...props} />;
}

export interface ComboboxGroupLabelProps extends Omit<ComboboxPrimitive.GroupLabel.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The heading of a ComboboxGroup, in the caption role; not an item. */
export function ComboboxGroupLabel({ className, ...props }: ComboboxGroupLabelProps) {
  return <ComboboxPrimitive.GroupLabel data-slot="combobox-group-label" className={cn(popupClasses.groupLabel, className)} {...props} />;
}

export interface ComboboxSeparatorProps extends Omit<ComboboxPrimitive.Separator.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A line between items or groups. */
export function ComboboxSeparator({ className, ...props }: ComboboxSeparatorProps) {
  return <ComboboxPrimitive.Separator data-slot="combobox-separator" className={cn(popupClasses.separator, className)} {...props} />;
}

/** Renders a ComboboxGroup's filtered items with a function child, as ComboboxPrimitive.List does. */
export const ComboboxCollection = ComboboxPrimitive.Collection;
