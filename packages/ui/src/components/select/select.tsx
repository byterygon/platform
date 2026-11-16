import { Select as SelectPrimitive } from "@base-ui/react/select";
import type { ReactNode, Ref } from "react";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldPadding, fieldSizes, fieldStates, type ControlSizeProp, type FieldAppearance } from "@/lib/control";
import { Checkmark, ChevronDown } from "@/lib/icons";
import { tokenPx, useThemeScope } from "@/lib/theme-scope";

// One choice from a list (Fluent 2's Dropdown), on Base UI's Select: a trigger that looks like an
// Input (its appearances, sizes, focus underline and states) and shows the
// chosen item's label, and a listbox popup below it. `Select` renders the trigger and the popup;
// its children are the popup's content (SelectItem, SelectGroup with SelectGroupLabel,
// SelectSeparator). The popup is placed under the trigger (not over it, as a native macOS menu
// would be), so long lists scroll inside it like a Combobox's.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const selectVariants = {
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} ${fieldPadding.small} [&_[data-slot=select-icon]_svg]:size-icon-md`,
    medium: `${fieldSizes.medium} ${fieldPadding.medium} [&_[data-slot=select-icon]_svg]:size-icon-lg`,
    large: `${fieldSizes.large} ${fieldPadding.large} [&_[data-slot=select-icon]_svg]:size-icon-xl`,
  },
} as const;

const triggerClasses = [
  "flex w-full min-w-0 cursor-default select-none items-center gap-inline-sm text-start",
  fieldFrame,
  fieldStates,
  // Open: the underline stays while the list is up, as Fluent's Dropdown keeps it.
  "data-popup-open:shadow-focus-underline",
];

const valueClasses = ["min-w-0 flex-1 truncate data-placeholder:text-fg-subtle"];

const iconClasses = ["flex shrink-0 text-fg-muted in-data-disabled:text-fg-disabled"];

/**
 * The popup's positioner and popup. Shared with Combobox and MultiSelect through the class
 * names only; each wraps its own Base UI parts.
 */
export const popupClasses = {
  positioner: "z-[var(--by-z-popover)] outline-none",
  popup: [
    "flex flex-col overflow-y-auto overscroll-contain rounded-md border border-border bg-overlay p-inset-xs font-sans text-body text-fg shadow-overlay outline-none",
    "transition-opacity duration-[var(--by-motion-duration-fast)] ease-enter",
    "data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:ease-exit",
  ],
  item: [
    "flex min-h-control-sm cursor-default select-none items-center gap-inline-sm rounded-sm px-inset-sm text-body text-fg outline-none",
    "data-highlighted:bg-hover",
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  ],
  indicator: "ms-auto flex shrink-0 [&_svg]:size-icon-sm",
  groupLabel: "flex min-h-control-xs select-none items-center px-inset-sm text-caption text-fg-subtle",
  separator: "-mx-inset-xs my-inset-xs h-px shrink-0 bg-border",
} as const;

/**
 * Base UI sets these variables on the positioner at run time: the trigger's width, the room left
 * in the viewport, and the side the popup grows from. They are not tokens, so they go in `style`.
 */
export const popupStyle = {
  minWidth: "var(--anchor-width)",
  maxHeight: "var(--available-height)",
  transformOrigin: "var(--transform-origin)",
} as const;

/** The gap between the trigger and the popup: space.inline.xs where the trigger is. */
export const popupOffset = (anchor: Element | null) => tokenPx(anchor, "--by-space-inline-xs", 4);

/** The check mark of a chosen option (Fluent's Checkmark); Combobox and MultiSelect reuse it. */
export const CheckIcon = () => <Icon icon={Checkmark} />;

export interface SelectProps<Value> extends Omit<SelectPrimitive.Root.Props<Value, false>, "multiple" | "children"> {
  /** Fluent's field appearance of the trigger: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Shown in the trigger while nothing is chosen. */
  placeholder?: ReactNode;
  /** Accessible name when there is no FieldLabel; set on the trigger. */
  "aria-label"?: string;
  /** The popup's content: SelectItem, SelectGroup, SelectGroupLabel, SelectSeparator. */
  children?: ReactNode;
  /** Extra classes for the trigger, merged after the component's own so they win. */
  className?: string;
  /** Reaches the trigger `<button>`. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * A select on Base UI's Select. Pass `items` (a record of value to label, or `{ value, label }`
 * objects) so the trigger can show the chosen label before the popup has ever opened. Inside a
 * Field it takes the label, description and validity; the ref reaches the trigger.
 */
export function Select<Value>({ appearance, size, placeholder, "aria-label": ariaLabel, children, className, ref, onOpenChange, ...props }: SelectProps<Value>) {
  const { ref: anchorRef, anchor, scope, refresh } = useThemeScope<HTMLButtonElement>(ref);
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <SelectPrimitive.Root<Value>
      onOpenChange={(open, details) => {
        if (open) refresh();
        onOpenChange?.(open, details);
      }}
      {...props}
    >
      <SelectPrimitive.Trigger
        ref={anchorRef}
        data-slot="select"
        data-appearance={look}
        data-size={height}
        aria-label={ariaLabel}
        className={cn(triggerClasses, selectVariants.appearance[look], selectVariants.size[height], className)}
      >
        <SelectPrimitive.Value data-slot="select-value" placeholder={placeholder} className={cn(valueClasses)} />
        <SelectPrimitive.Icon data-slot="select-icon" className={cn(iconClasses)}>
          <Icon icon={ChevronDown} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner {...scope} data-slot="select-positioner" sideOffset={() => popupOffset(anchor.current)} alignItemWithTrigger={false} className={cn(popupClasses.positioner)}>
          <SelectPrimitive.Popup data-slot="select-popup" style={popupStyle} className={cn(popupClasses.popup)}>
            <SelectPrimitive.List data-slot="select-list" className="flex flex-col outline-none">
              {children}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export interface SelectItemProps extends Omit<SelectPrimitive.Item.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One option: its text and, while chosen, a check mark at the end. */
export function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(popupClasses.item, className)} {...props}>
      <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className={cn(popupClasses.indicator)}>
        <CheckIcon />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export interface SelectGroupProps extends Omit<SelectPrimitive.Group.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A group of options, named by the SelectGroupLabel inside it. */
export function SelectGroup({ className, ...props }: SelectGroupProps) {
  return <SelectPrimitive.Group data-slot="select-group" className={cn("flex flex-col", className)} {...props} />;
}

export interface SelectGroupLabelProps extends Omit<SelectPrimitive.GroupLabel.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The heading of a SelectGroup, in the caption role; not an option. */
export function SelectGroupLabel({ className, ...props }: SelectGroupLabelProps) {
  return <SelectPrimitive.GroupLabel data-slot="select-group-label" className={cn(popupClasses.groupLabel, className)} {...props} />;
}

export interface SelectSeparatorProps extends Omit<SelectPrimitive.Separator.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A line between options or groups. */
export function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return <SelectPrimitive.Separator data-slot="select-separator" className={cn(popupClasses.separator, className)} {...props} />;
}
