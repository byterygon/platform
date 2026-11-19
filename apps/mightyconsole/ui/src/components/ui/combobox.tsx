import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ReactNode, Ref } from "react";
import { Icon } from "@/components/ui/icon";
import { CheckIcon, popupClasses, popupOffset, popupStyle } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldSizes, focusRing, type ControlSizeProp, type FieldAppearance } from "@/lib/control";
import { ChevronDown, Dismiss } from "@/lib/icons";
import { useThemeScope } from "@/lib/theme-scope";

// A text input that filters a list (Fluent 2's Combobox), on Base UI's Combobox: the frame holds the input, a clear
// button (shown while there is a value) and a chevron that opens the list; the popup holds the
// filtered items, a "no results" line and an optional status line (loading, an error) read out by
// screen readers. Typing filters by the item labels; the first match is highlighted so Enter
// takes it. The popup shares Select's surface, items and theme scope. The frame takes Input's
// appearances, sizes, focus underline and states.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const comboboxVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} *:first:ps-inset-xs`,
    medium: fieldSizes.medium,
    large: `${fieldSizes.large} *:first:ps-inset-md`,
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
export const frameClasses = [
  "flex w-full min-w-0 items-center gap-inline-xs pe-inline-xs",
  fieldFrame,
  "has-[input:focus-visible]:shadow-focus-underline data-popup-open:shadow-focus-underline",
  "data-invalid:border-danger-border data-invalid:border-b-danger-stroke has-[[aria-invalid=true]]:border-danger-border has-[[aria-invalid=true]]:border-b-danger-stroke",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:text-fg-disabled",
];

const inputClasses = [
  "h-full min-w-0 flex-1 bg-transparent ps-control-x text-fg outline-none",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed data-disabled:text-fg-disabled data-disabled:placeholder:text-fg-disabled",
];

/** The clear and chevron buttons inside the frame, and a chip's remove button. */
export const frameButtonClasses = [
  "flex size-control-xs shrink-0 cursor-default items-center justify-center rounded-sm text-fg-muted",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  "hover:bg-hover hover:text-fg active:bg-pressed",
  focusRing,
  "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  "[&_svg]:size-icon-md",
];

/** The "no results" and status lines; empty (and so hidden) while they have nothing to say. */
export const messageClasses = "flex min-h-control-md items-center px-inline-md text-body-1 text-fg-muted empty:hidden";

/** Fluent's ChevronDown and Dismiss, shared with MultiSelect. */
export const ChevronIcon = () => <Icon icon={ChevronDown} />;
export const ClearIcon = () => <Icon icon={Dismiss} />;

export interface ComboboxProps<Value, Item = Value> extends Omit<ComboboxPrimitive.Root.Props<Value, false, Item>, "multiple" | "children"> {
  /** Fluent's field appearance of the frame: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
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
  appearance,
  size,
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
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <ComboboxPrimitive.Root<Value, false, Item>
      autoHighlight={autoHighlight}
      onOpenChange={(open, details) => {
        if (open) refresh();
        onOpenChange?.(open, details);
      }}
      {...props}
    >
      <ComboboxPrimitive.InputGroup
        ref={anchorRef}
        data-slot="combobox"
        data-appearance={look}
        data-size={height}
        className={cn(frameClasses, comboboxVariants.appearance[look], comboboxVariants.size[height], className)}
      >
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
